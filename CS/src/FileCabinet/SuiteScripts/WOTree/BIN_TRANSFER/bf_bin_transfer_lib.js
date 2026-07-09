/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 *
 * Bin Transfer Tool (suitelet) - module helpers
 * Module helpers : SuiteQL (chargement bins / contenus) + creation
 * de records bintransfer (Bin Transfer NetSuite natif, TOE-XXXXX).
 *
 * Patterns critiques verifies :
 *   - record.Type.BIN_TRANSFER (pas BIN_WORKSHEET = putaway, autre chose)
 *   - isDynamic: false obligatoire + setSublistValue par index
 *   - Subsidiary OneWorld a set AVANT location et sublists (subsidiary 6)
 *   - Memo plafonne a 40 chars (clampMemo)
 *   - Pour bin pref : set location AVANT binnumber sur nouvelle ligne sublist
 *   - Pairing inventoryAssignment : transactionline impair = ISSUE (FROM),
 *     pair = RECEIPT (TO)
 *
 * Version : 0.10.10 (2026-06-25) - GARDE-FOU GOUVERNANCE (review pt.3)
 *   Supprime le commit partiel SILENCIEUX du fallback ligne-par-ligne.
 *   - createBinTransfer : si le batch atomique echoue sur une qty ET que
 *     la selection depasse MAX_TOE_LINES (30), on REFUSE le fallback et
 *     on echoue proprement/completement (rien cree) au lieu de commiter
 *     ligne a ligne jusqu'a SSS_USAGE_LIMIT_EXCEEDED. Le batch atomique
 *     lui-meme n'est pas plafonne (deja sur : tout ou rien).
 *   - saveBinTransferLineByLine + setPreferredBinForItems : watchdog
 *     getRemainingUsage() ; sous GOV_SAFETY_FLOOR (60) on stoppe la boucle
 *     et on retourne notProcessed[] + governanceStop au lieu de perdre
 *     les lignes/items restants. setPreferredBinForItems plafonne aussi
 *     a MAX_PREF_UPDATES (40) en amont.
 *   - Champs de retour ADDITIFS (notProcessed, governanceStop) : l'UI
 *     existante continue de fonctionner sans modification.
 *
 * Version : 0.10.9 (2026-05-10) - OPTIMS gouvernance + parseDlc ISO
 *   - OPTIM-1 (lib) : memoize subsidiary lookup dans createBinTransfer
 *     pour reduire les governance units en fallback ligne-par-ligne
 *     (40 → 30 units par TOE, max viable 25 → 33 lignes avant
 *     SSS_USAGE_LIMIT_EXCEEDED). saveBinTransferBatch lit
 *     payload._subsidiaryId en priorite, fallback lookup pour les
 *     appels directs (swap/reconcile pour l'instant). Propage aussi
 *     dans le retry mono-ligne et le fallback line-by-line.
 *   - OPTIM-1 (html) : garde-fou UI mode 1/2 si > 30 lignes cochees,
 *     confirm() explicite expliquant le risque gouvernance.
 *   - OPTIM-2 (html) : parseDlc gere maintenant FR + ISO + fallback
 *     Date.parse (aligne sur parseHistoryDate v0.10.8 B4). Sans ce fix,
 *     un user en preference ISO ne voyait jamais le warning DLC rouge.
 *
 * Version : 0.10.8 (2026-05-10) - PROD BATCH 2 (cleanup post-review)
 *   - Fixes batch issus de la review v0.10.6/v0.10.7 (cf CHANGELOG) :
 *     C3 (import N/error mort), C4 (forceBin mort mode 2), C5 (commentaire
 *     binworksheet -> bintransfer), C6 (escapeHtml +'), C9 (clampMemo
 *     redondant), C10 (indentations strings), B5 (anti-injection </script>),
 *     B1 (escape % et _ dans LIKE SuiteQL), B2 (log extractAvailQty=null),
 *     B3 (warning UI lookup binLocMap echoue), B4 (tri date Historique
 *     formats FR + ISO + Date.parse fallback), C8 (fmtQty inline),
 *     C7 (headers JS condenses).
 *   - Aucun changement de comportement metier observable cote utilisateur.
 *   - Voir CHANGELOG.md v0.10.8 pour le detail item par item.
 *
 * Version : 0.10.7 (2026-05-10) - PREP PROD
 *   Cleanup non-applicatif : descriptions XML alignees 5 onglets,
 *   commentaire handlePost listant les 11 actions exposees, loglevel
 *   scriptdeployment DEBUG -> AUDIT.
 *
 * Version : 0.10.6 (2026-05-08) - DESCRIPTION DU TOOL ACTUALISEE
 *   Bandeau bf-help + commentaires d'en-tete refletent les 5 onglets.
 *
 * Version : 0.10.5 (2026-05-08) - LOG IDENTITE BINS RETIRES
 *   setPreferredBin retourne removedBins[{binId,binLabel}] pour que l'UI
 *   affiche quels bins sans stock ont ete nettoyes (et pas juste combien).
 *
 * Version : 0.10.4 (2026-05-08) - CLEANUP ANCIENNES ASSO BINS
 *   setPreferredBin retire automatiquement les lignes sublist binnumber
 *   sans stock (onhand <= 0) qui ne sont pas le nouveau bin pref.
 *
 *   Voir CHANGELOG.md pour l'historique complet v0.1.0 -> v0.10.3.
 */
define(['N/query', 'N/record', 'N/log', 'N/runtime'], function (query, record, log, runtime) {

    /* ============================================================
     * v0.10.10 (GARDE-FOU GOUVERNANCE) - plafonds + watchdog
     *   Objectif : supprimer le commit partiel SILENCIEUX du fallback
     *   ligne-par-ligne (cf review point 3). Deux mecanismes :
     *     1. Refus du fallback si la selection est trop grosse pour etre
     *        rejouee ligne par ligne -> on echoue proprement et COMPLET
     *        (le batch atomique n'ayant rien cree), au lieu de basculer
     *        sur une boucle qui commit a moitie. Le batch atomique lui
     *        n'est PAS plafonne (il reussit a bas cout ou echoue sans
     *        rien laisser, donc deja sur).
     *     2. Watchdog gouvernance DANS les boucles fallback / preferred
     *        bin : on s'arrete AVANT SSS_USAGE_LIMIT_EXCEEDED et on
     *        retourne explicitement les lignes/items NON traites
     *        (champs notProcessed[] + governanceStop) au lieu de les
     *        perdre. Indispensable meme sous le plafond car un retry
     *        qty-adjust double le cout d'une ligne.
     *   Seuils nommes ici pour etre ajustables sans relire la logique.
     * ============================================================ */
    // Au-dela : on refuse de REJOUER en fallback ligne-par-ligne (rien cree).
    // Base sur le max viable observe (~33 lignes) moins une marge.
    var MAX_TOE_LINES = 30;
    // Idem setPreferredBinForItems (1 load+save par item, ~15-25 units).
    var MAX_PREF_UPDATES = 40;
    // Watchdog : si la gouvernance restante passe sous ce plancher, on
    // arrete proprement la boucle avant de heurter le mur.
    var GOV_SAFETY_FLOOR = 60;

    // Retourne les units de gouvernance restantes, ou null si indispo
    // (dans ce cas on ne bloque pas : comportement inchange).
    function remainingUsage() {
        try { return runtime.getCurrentScript().getRemainingUsage(); }
        catch (e) { return null; }
    }

    /* ============================================================
     * Helper : nom de l'utilisateur courant (pour le memo par defaut).
     *  Trace dans le memo de chaque TOE qui a fait le transfert.
     * ============================================================ */
    function getCurrentUserName() {
        try {
            var u = runtime.getCurrentUser();
            return u && u.name ? u.name : '';
        } catch (e) {
            return '';
        }
    }

    // v0.6.7 - memo NetSuite max 40 chars, on construit court + truncate
    var MEMO_MAX = 40;
    function clampMemo(s) {
        if (!s) return s;
        s = String(s);
        return s.length > MEMO_MAX ? s.substring(0, MEMO_MAX) : s;
    }
    function defaultMemo(suffix) {
        var n = getCurrentUserName();
        var prefix = 'Bin Tool' + (n ? ' · ' + n : '');
        var full = suffix ? prefix + ' · ' + suffix : prefix;
        return clampMemo(full);
    }


    // ============================================================
    // Buffer in-memory pour exfiltrer dump+step dans la reponse JSON.
    // Le Suitelet appelle resetLogBuffer() au debut de chaque request
    // et getLogBuffer() avant de repondre. Permet de voir tout le flow
    // sans avoir a copier-coller le Script Execution Log NetSuite.
    // ============================================================
    var LOG_BUFFER = [];
    function resetLogBuffer() { LOG_BUFFER = []; }
    function getLogBuffer()   { return LOG_BUFFER.slice(0, 500); }
    function logBuf(level, title, details) {
        try {
            LOG_BUFFER.push({
                t: new Date().getTime(),
                lv: level,
                ti: String(title || '').substring(0, 120),
                de: String(details === undefined ? '' : details).substring(0, 500)
            });
        } catch (e) {}
    }

    /* ============================================================
     * v0.10.8 (B1) - Helper SuiteQL : echappe les caracteres special
     * de LIKE (%, _, et le separateur \\) dans une chaine destinee a
     * etre interpolee dans un pattern '%xxx%'. Doit etre utilise en
     * combinaison avec une clause ESCAPE '\\' sur le LIKE.
     *
     * Avant ce helper, taper "100%" dans la recherche article matchait
     * tout (le % devenait wildcard). Inoffensif (lecture seule, pas
     * d'injection) mais resultats trompeurs.
     * ============================================================ */
    function escapeLike(s) {
        return String(s == null ? '' : s)
            .replace(/\\/g, '\\\\')
            .replace(/%/g,  '\\%')
            .replace(/_/g,  '\\_');
    }

    /* ============================================================
     * SuiteQL : liste de toutes les locations actives
     * ============================================================ */
    function loadLocations() {
        var sql =
            "SELECT id, name, subsidiary " +
            "FROM location " +
            "WHERE isinactive = 'F' " +
            "ORDER BY name";
        var rows = runQ(sql);
        return rows.map(function (r) {
            return {
                id: String(r.id),
                name: r.name || ('LOC ' + r.id),
                subsidiaryId: r.subsidiary ? String(r.subsidiary) : ''
            };
        });
    }

    /**
     * Lookup ponctuel : recupere la subsidiary d'une location.
     * Necessaire car le compte est OneWorld et binworksheet
     * exige subsidiary settee avant tout autre champ pour que les
     * filtres de NetSuite (items / lots / statuses) soient corrects.
     */
    function getSubsidiaryForLocation(locationId) {
        if (!locationId) return null;
        var rows = runQ(
            "SELECT subsidiary FROM location WHERE id = " + Number(locationId)
        );
        if (rows && rows[0] && rows[0].subsidiary) {
            return String(rows[0].subsidiary);
        }
        return null;
    }

    /* ============================================================
     * SuiteQL : tous les bins actifs (id, label, location)
     *  - utilise pour les dropdowns source / destination
     *  - on charge tout (jusqu'a 5000) pour permettre une recherche
     *    cote client sans aller-retour reseau
     * ============================================================ */
    function loadBins(locationId) {
        var where = "bin.isinactive = 'F'";
        if (locationId) where += " AND bin.location = " + Number(locationId);
        // v0.6.8 - count nb_items dispo par bin pour afficher
        // "vide" / "N art." dans les selecteurs cote UI.
        var sql =
            "SELECT bin.id AS bin_id, bin.binnumber, bin.location, " +
            "       loc.name AS loc_name, " +
            "       COUNT(DISTINCT ib.item) AS nb_items " +
            "FROM bin " +
            "LEFT JOIN location loc ON loc.id = bin.location " +
            "LEFT JOIN inventorybalance ib ON ib.binnumber = bin.id " +
            "                              AND ib.quantityonhand > 0 " +
            "WHERE " + where + " " +
            "GROUP BY bin.id, bin.binnumber, bin.location, loc.name " +
            "ORDER BY loc.name, bin.binnumber " +
            "FETCH FIRST 5000 ROWS ONLY";
        var rows = runQ(sql);
        return rows.map(function (r) {
            return {
                id:       String(r.bin_id),
                label:    r.binnumber || ('BIN ' + r.bin_id),
                locId:    String(r.location || ''),
                locName:  r.loc_name || '',
                nbItems:  Number(r.nb_items || 0)
            };
        });
    }

    /* ============================================================
     * v0.10.0 - CONFIG BIN PREFERE (mode 4)
     *
     * loadItemBinAssociations(itemIds)
     *   Pour une liste d'items, retourne :
     *   {
     *     "itemId": {
     *       itemCode, itemName,
     *       prefBin: { binId, binLabel, locName } | null,
     *       associatedBins: [{binId, binLabel, locId, locName, qoh, isPref}, ...]
     *     }
     *   }
     *   "associatedBins" = bins ou l'item a une ligne dans itemBinQuantity
     *   (typiquement bins ou il a deja eu du stock).
     * ============================================================ */
    function loadItemBinAssociations(itemIds) {
        if (!itemIds || !itemIds.length) return {};
        var safeIds = {};
        itemIds.forEach(function (x) {
            var n = Number(x);
            if (n > 0) safeIds[n] = true;
        });
        var ids = Object.keys(safeIds).slice(0, 200);
        if (!ids.length) return {};

        var sqlMain =
            "SELECT ibq.item AS item_id, " +
            "       it.itemid AS item_code, " +
            "       it.displayname AS item_name, " +
            "       ibq.bin AS bin_id, " +
            "       b.binnumber AS bin_label, " +
            "       loc.id AS loc_id, " +
            "       loc.name AS loc_name, " +
            "       ibq.onhand AS qoh, " +
            "       ibq.preferredbin AS is_pref " +
            "FROM itemBinQuantity ibq " +
            "LEFT JOIN bin b ON b.id = ibq.bin " +
            "LEFT JOIN location loc ON loc.id = b.location " +
            "JOIN item it ON it.id = ibq.item " +
            "WHERE ibq.item IN (" + ids.join(',') + ") " +
            "ORDER BY ibq.item, ibq.preferredbin DESC, b.binnumber";
        var rows = runQ(sqlMain);

        var result = {};
        rows.forEach(function (r) {
            var key = String(r.item_id);
            if (!result[key]) {
                result[key] = {
                    itemId:         key,
                    itemCode:       r.item_code || '',
                    itemName:       r.item_name || '',
                    prefBin:        null,
                    associatedBins: []
                };
            }
            var binEntry = {
                binId:    String(r.bin_id || ''),
                binLabel: r.bin_label || '',
                locId:    String(r.loc_id || ''),
                locName:  r.loc_name || '',
                qoh:      Number(r.qoh || 0),
                isPref:   r.is_pref === 'T'
            };
            result[key].associatedBins.push(binEntry);
            if (binEntry.isPref && !result[key].prefBin) {
                result[key].prefBin = {
                    binId:    binEntry.binId,
                    binLabel: binEntry.binLabel,
                    locName:  binEntry.locName
                };
            }
        });

        // Pour chaque item demande mais ABSENT de itemBinQuantity (pas
        // encore d'asso), on cree une entree minimale pour que l'UI sache.
        ids.forEach(function (id) {
            if (!result[id]) {
                result[id] = {
                    itemId: String(id), itemCode: '?', itemName: '',
                    prefBin: null, associatedBins: []
                };
            }
        });
        return result;
    }

    /**
     * v0.10.0 - Set preferred bin pour une liste d'items.
     * updates = [{itemId, binId}]  (binId obligatoire, NULL non supporte)
     *
     * Pour chaque item :
     *   1. record.load type='inventoryitem' (mode static, isDynamic:false)
     *   2. Boucler la sublist 'binnumber' :
     *      - Si bin = binId       -> preferredbin = T
     *      - Sinon                -> preferredbin = F
     *   3. Si binId pas trouve dans la sublist :
     *      - setSublistValue line=lineCount avec binnumber + preferredbin=T
     *   4. record.save()
     *
     * Retourne { ok: [{itemId}], errors: [{itemId, message}] }.
     */
    function setPreferredBinForItems(updates) {
        if (!updates || !updates.length) {
            throw new Error('Aucun item a modifier.');
        }
        // v0.10.10 - plafond DUR : record.load + save par item est couteux
        // en gouvernance. On refuse les lots trop gros AVANT toute ecriture
        // (rien n'est traite) plutot que de risquer un arret en cours de lot.
        if (updates.length > MAX_PREF_UPDATES) {
            throw new Error(
                'Trop d\'items (' + updates.length + ') en un seul envoi. Maximum ' +
                MAX_PREF_UPDATES + ' items (limite gouvernance NetSuite). ' +
                'Decoupez la selection en plusieurs envois.'
            );
        }
        // v0.10.3 - precharger les locations des bins demandes.
        // Quand on ajoute une nouvelle ligne dans sublist 'binnumber',
        // NetSuite exige aussi le champ 'location' (sinon INVALID_FLD_VALUE
        // sur binnumber - le message est trompeur, c'est location qui manque).
        var binLocMap = {};
        var binLocLookupError = null;   // v0.10.8 (B3)
        var binIds = {};
        updates.forEach(function (u) {
            if (u.binId) binIds[Number(u.binId)] = true;
        });
        var binIdList = Object.keys(binIds);
        if (binIdList.length) {
            var sqlLoc = "SELECT id, location FROM bin WHERE id IN (" + binIdList.join(',') + ")";
            try {
                var binRows = runQ(sqlLoc);
                binRows.forEach(function (r) {
                    binLocMap[String(r.id)] = String(r.location || '');
                });
            } catch (eL) {
                // v0.10.8 (B3) - en cas de fail, on remonte explicitement.
                // Sans la map, NetSuite refusera l'ajout de nouvelle ligne
                // sublist binnumber avec INVALID_FLD_VALUE (location requis).
                binLocLookupError = String(eL.message || eL).substring(0, 250);
                logBuf('error', 'lookup bin locations FAIL', binLocLookupError);
                log.error({
                    title:   'BF setPreferredBin - lookup bin locations FAIL',
                    details: 'sql=' + sqlLoc + '\nerr=' + binLocLookupError
                });
            }
        }

        var ok = [];
        var errors = [];
        var notProcessed = [];   // v0.10.10 - items sautes par le watchdog
        var govStop = false;     // v0.10.10
        updates.forEach(function (u, idx) {
            var prefix = 'PB[' + idx + '] item=' + u.itemId + ' bin=' + u.binId;
            // v0.10.10 - watchdog gouvernance : arret propre avant le mur.
            // Un load+save item est lourd, on garde une marge confortable.
            var rem = remainingUsage();
            if (govStop || (rem !== null && rem < GOV_SAFETY_FLOOR)) {
                govStop = true;
                notProcessed.push({
                    itemId: String(u.itemId || ''),
                    binId:  String(u.binId || '')
                });
                return;
            }
            try {
                if (!u.itemId || !u.binId) {
                    throw new Error('itemId ou binId manquant');
                }
                logBuf('debug', prefix + ' record.load');
                var rec = step(prefix + ' load', function () {
                    return record.load({
                        type:      record.Type.INVENTORY_ITEM,
                        id:        Number(u.itemId),
                        isDynamic: false
                    });
                });
                var lineCount = rec.getLineCount({ sublistId: 'binnumber' });
                logBuf('debug', prefix + ' sublist binnumber lines=' + lineCount);

                // v0.10.4 - cleanup : marquer les lignes a SUPPRIMER (onhand=0
                // ET pas le bin cible). On ne supprime PAS les lignes avec
                // onhand>0 (par securite) ni la ligne du nouveau pref bin.
                // Si onhand non lisible (null/undefined), on garde par defense.
                // v0.10.5 - capturer aussi binId + binText pour log + retour UI.
                var foundLine = -1;
                var linesToDelete = [];   // array de {idx, binId, binText}
                for (var i = 0; i < lineCount; i++) {
                    var b = rec.getSublistValue({
                        sublistId: 'binnumber',
                        fieldId:   'binnumber',
                        line:      i
                    });
                    var bText = '';
                    try {
                        bText = rec.getSublistText({
                            sublistId: 'binnumber',
                            fieldId:   'binnumber',
                            line:      i
                        }) || '';
                    } catch (eT) {}
                    var onh = rec.getSublistValue({
                        sublistId: 'binnumber',
                        fieldId:   'onhand',
                        line:      i
                    });
                    var isCurrentTarget = String(b) === String(u.binId);
                    if (isCurrentTarget) {
                        foundLine = i;
                    } else if (onh != null && Number(onh) <= 0) {
                        linesToDelete.push({
                            idx:     i,
                            binId:   String(b || ''),
                            binText: bText
                        });
                    }
                }

                // v0.10.5 - tableau des bins effectivement supprimes
                var removedBins = [];

                // Suppression en ORDRE DECROISSANT pour conserver les indices
                if (linesToDelete.length) {
                    var labels = linesToDelete.map(function (l) {
                        return l.binText || ('bin#' + l.binId);
                    }).join(', ');
                    logBuf('debug', prefix + ' cleanup ' + linesToDelete.length + ' bins sans stock : ' + labels);
                    linesToDelete.sort(function (a, b) { return b.idx - a.idx; }).forEach(function (l) {
                        try {
                            rec.removeLine({ sublistId: 'binnumber', line: l.idx });
                            removedBins.push({ binId: l.binId, binLabel: l.binText });
                        } catch (eRm) {
                            logBuf('audit', prefix + ' removeLine ' + l.idx + ' (' +
                                (l.binText || l.binId) + ') skip', eRm.message);
                        }
                    });
                    // Recharger lineCount + retrouver foundLine apres suppressions
                    lineCount = rec.getLineCount({ sublistId: 'binnumber' });
                    foundLine = -1;
                    for (var k = 0; k < lineCount; k++) {
                        var bk = rec.getSublistValue({
                            sublistId: 'binnumber',
                            fieldId:   'binnumber',
                            line:      k
                        });
                        if (String(bk) === String(u.binId)) { foundLine = k; break; }
                    }
                }

                // Set preferredbin sur les lignes restantes
                for (var j = 0; j < lineCount; j++) {
                    var bj = rec.getSublistValue({
                        sublistId: 'binnumber',
                        fieldId:   'binnumber',
                        line:      j
                    });
                    var isT = String(bj) === String(u.binId);
                    rec.setSublistValue({
                        sublistId: 'binnumber',
                        fieldId:   'preferredbin',
                        line:      j,
                        value:     isT
                    });
                }
                if (foundLine < 0) {
                    var binLoc = binLocMap[String(u.binId)] || '';
                    logBuf('debug', prefix + ' bin pas dans sublist, ajout ligne ' + lineCount + ' loc=' + binLoc);
                    // Bin pas dans la sublist -> ajouter une nouvelle ligne
                    // v0.10.3 - set d\'abord la location du bin (champ requis
                    // par NetSuite, sinon INVALID_FLD_VALUE sur binnumber).
                    if (binLoc) {
                        try {
                            rec.setSublistValue({
                                sublistId: 'binnumber',
                                fieldId:   'location',
                                line:      lineCount,
                                value:     Number(binLoc)
                            });
                        } catch (eLoc) {
                            logBuf('audit', prefix + ' set location skip', eLoc.message);
                        }
                    }
                    rec.setSublistValue({
                        sublistId: 'binnumber',
                        fieldId:   'binnumber',
                        line:      lineCount,
                        value:     Number(u.binId)
                    });
                    rec.setSublistValue({
                        sublistId: 'binnumber',
                        fieldId:   'preferredbin',
                        line:      lineCount,
                        value:     true
                    });
                }
                step(prefix + ' save', function () {
                    rec.save();
                });
                logBuf('audit', prefix + ' OK' +
                    (removedBins.length ? ' (cleaned ' + removedBins.length + ' anciens bins)' : ''));
                ok.push({
                    itemId:      String(u.itemId),
                    removedBins: removedBins   // v0.10.5
                });
            } catch (eOne) {
                var msg = String(eOne.message || eOne).substring(0, 250);
                var name = String(eOne.name || '');
                logBuf('error', prefix + ' FAIL', name + ': ' + msg);
                log.error({
                    title:   'BF setPreferredBin FAIL ' + prefix,
                    details: JSON.stringify({
                        name:    name,
                        message: msg,
                        stack:   String(eOne.stack || '').substring(0, 1500)
                    })
                });
                errors.push({
                    itemId:  String(u.itemId || ''),
                    binId:   String(u.binId || ''),
                    name:    name,
                    message: msg
                });
            }
        });
        // v0.10.8 (B3) - si le lookup bin->location a echoue, on remonte
        // un warning visible cote UI (pour eviter qu'on debug a l'aveugle
        // un INVALID_FLD_VALUE binnumber qui vient en realite du fait que
        // location n'a pas pu etre prefetch).
        var result = { ok: ok, errors: errors };
        if (notProcessed.length) {           // v0.10.10
            result.notProcessed   = notProcessed;
            result.governanceStop = govStop;
        }
        if (binLocLookupError) {
            result.warning = 'Lookup locations bins en echec : ' + binLocLookupError +
                             ' (les ajouts de nouvelles lignes sublist peuvent rejeter avec INVALID_FLD_VALUE).';
        }
        return result;
    }

    /* ============================================================
     * v0.9.0 - Bin prefere (= bin de picking) par item
     *
     * Retourne un map { itemId(string) -> { binId, binLabel } }.
     * Source : table itemBinQuantity avec preferredbin = 'T'.
     * Note : sur certains comptes, beaucoup d items ont STOCK comme
     * default (NetSuite auto-affecte le bin de reception) tant que les
     * vrais bins de picking ne sont pas configures.
     * Si 0 result -> map vide, l'UI affichera "—" partout.
     *
     * Optim : on filtre par item IN (...) pour ne pas charger les 903
     * lignes a chaque requete (juste celles utilisees dans la table UI).
     * ============================================================ */
    function loadPreferredBinsByItem(itemIds) {
        if (!itemIds || !itemIds.length) return {};
        // Defense : forcer Number, dedupe, max 500 ids (cap raisonnable)
        var safeIds = {};
        itemIds.forEach(function (x) {
            var n = Number(x);
            if (n > 0) safeIds[n] = true;
        });
        var ids = Object.keys(safeIds).slice(0, 500);
        if (!ids.length) return {};
        var sql =
            "SELECT ibq.item AS item_id, " +
            "       ibq.bin AS bin_id, " +
            "       b.binnumber AS bin_label " +
            "FROM itemBinQuantity ibq " +
            "LEFT JOIN bin b ON b.id = ibq.bin " +
            "WHERE ibq.preferredbin = 'T' " +
            "  AND ibq.item IN (" + ids.join(',') + ")";
        var rows = runQ(sql);
        var map = {};
        rows.forEach(function (r) {
            // Si plusieurs preferredbin pour un meme item, on garde le 1er
            // (cas rare : pref bin distinct par location).
            if (!map[String(r.item_id)]) {
                map[String(r.item_id)] = {
                    binId:    String(r.bin_id || ''),
                    binLabel: r.bin_label || ''
                };
            }
        });
        return map;
    }

    /* ============================================================
     * SuiteQL : contenu detaille d'un bin
     *  Retourne 1 ligne par (item, lot)
     *  v0.9.0 - enrichi avec preferredBin {id, label} par item
     * ============================================================ */
    function loadBinContents(binId) {
        if (!binId) return [];
        var sql =
            "SELECT ib.item AS item_id, " +
            "       it.itemid AS item_code, " +
            "       it.displayname AS item_name, " +
            "       it.itemtype AS item_type, " +
            "       ib.binnumber AS bin_id, " +
            "       b.binnumber AS bin_label, " +
            "       bin_loc.id AS loc_id, " +
            "       bin_loc.name AS loc_name, " +
            "       ib.inventorynumber AS lot_id, " +
            "       inv.inventorynumber AS lot_label, " +
            "       inv.expirationdate AS dlc, " +
            "       ib.quantityonhand AS qoh, " +
            "       ib.quantityavailable AS qav, " +
            "       ib.inventorystatus AS status_id " +
            "FROM inventorybalance ib " +
            "JOIN bin b ON b.id = ib.binnumber " +
            "JOIN location bin_loc ON bin_loc.id = b.location " +
            "JOIN item it ON it.id = ib.item " +
            "LEFT JOIN inventorynumber inv ON inv.id = ib.inventorynumber " +
            "WHERE ib.binnumber = " + Number(binId) + " " +
            "  AND ib.quantityonhand > 0 " +
            "ORDER BY it.itemid, inv.expirationdate NULLS LAST";
        var rows = runQ(sql);
        // v0.9.0 - enrichir avec preferredBin par item
        var itemIds = rows.map(function (r) { return r.item_id; });
        var prefMap = loadPreferredBinsByItem(itemIds);
        return rows.map(function (r) {
            var pref = prefMap[String(r.item_id)] || null;
            return {
                itemId:   String(r.item_id),
                itemCode: r.item_code || '',
                itemName: r.item_name || '',
                itemType: r.item_type || '',
                binId:    String(r.bin_id),
                binLabel: r.bin_label || '',
                locId:    String(r.loc_id || ''),
                locName:  r.loc_name || '',
                lotId:    r.lot_id ? String(r.lot_id) : '',
                lotLabel: r.lot_label || '',
                dlc:      r.dlc || '',
                qoh:      Number(r.qoh || 0),
                qav:      Number(r.qav || 0),
                statusId: r.status_id ? String(r.status_id) : '',
                prefBinId:    pref ? pref.binId    : '',
                prefBinLabel: pref ? pref.binLabel : ''
            };
        });
    }

    /* ============================================================
     * Recherche d'articles par code/nom (autocomplete)
     *  Limite a 50 resultats pour eviter de saturer l'UI.
     * ============================================================ */
    function searchItems(q) {
        if (!q || String(q).length < 2) return [];

        // v0.6.2 - recherche multi-mots :
        // "NEM PORC" -> doit matcher "NEM AU PORC", "PORC AU NEM", etc.
        // On split sur whitespace, chaque mot doit apparaitre quelque part
        // dans itemid OU displayname (peu importe l'ordre).
        var words = String(q).toLowerCase().trim().split(/\s+/)
            .filter(function (w) { return w.length > 0; });
        if (!words.length) return [];

        // Limite a 6 mots pour eviter une clause WHERE qui explose
        if (words.length > 6) words = words.slice(0, 6);

        // v0.10.8 (B1) - escape ' (anti-quote-out) puis % et _ (wildcards
        // LIKE neutralises). ESCAPE '\\' sur la clause LIKE.
        var conditions = words.map(function (w) {
            var safeW = escapeLike(w).replace(/'/g, "''");
            return "(LOWER(itemid) LIKE '%" + safeW + "%' ESCAPE '\\' " +
                   "OR LOWER(displayname) LIKE '%" + safeW + "%' ESCAPE '\\')";
        });
        var whereClause = conditions.join(' AND ');

        var sql =
            "SELECT id, itemid, displayname, itemtype " +
            "FROM item " +
            "WHERE isinactive = 'F' " +
            "  AND " + whereClause + " " +
            "ORDER BY itemid " +
            "FETCH FIRST 50 ROWS ONLY";
        var rows = runQ(sql);
        return rows.map(function (r) {
            return {
                id:   String(r.id),
                code: r.itemid || '',
                name: r.displayname || '',
                type: r.itemtype || ''
            };
        });
    }

    /* ============================================================
     * Charge tous les bins ou un article a du stock
     *  Retourne 1 ligne par (bin × lot)
     * ============================================================ */
    function loadItemContents(itemId) {
        if (!itemId) return [];
        var sql =
            "SELECT ib.binnumber AS bin_id, " +
            "       b.binnumber AS bin_label, " +
            "       loc.id AS loc_id, " +
            "       loc.name AS loc_name, " +
            "       ib.inventorynumber AS lot_id, " +
            "       inv.inventorynumber AS lot_label, " +
            "       inv.expirationdate AS dlc, " +
            "       ib.quantityonhand AS qoh, " +
            "       ib.quantityavailable AS qav, " +
            "       ib.inventorystatus AS status_id, " +
            "       it.itemid AS item_code, " +
            "       it.displayname AS item_name, " +
            "       it.itemtype AS item_type " +
            "FROM inventorybalance ib " +
            "JOIN bin b ON b.id = ib.binnumber " +
            "JOIN location loc ON loc.id = b.location " +
            "JOIN item it ON it.id = ib.item " +
            "LEFT JOIN inventorynumber inv ON inv.id = ib.inventorynumber " +
            "WHERE ib.item = " + Number(itemId) + " " +
            "  AND ib.quantityonhand > 0 " +
            "ORDER BY loc.name, b.binnumber, inv.expirationdate NULLS LAST";
        var rows = runQ(sql);
        // v0.9.0 - bin prefere : un seul item ici, on resout 1 fois pour tous
        var prefMap = loadPreferredBinsByItem([itemId]);
        var pref = prefMap[String(itemId)] || null;
        return rows.map(function (r) {
            return {
                itemId:   String(itemId),
                itemCode: r.item_code || '',
                itemName: r.item_name || '',
                itemType: r.item_type || '',
                binId:    String(r.bin_id),
                binLabel: r.bin_label || '',
                locId:    String(r.loc_id || ''),
                locName:  r.loc_name || '',
                lotId:    r.lot_id ? String(r.lot_id) : '',
                lotLabel: r.lot_label || '',
                dlc:      r.dlc || '',
                qoh:      Number(r.qoh || 0),
                qav:      Number(r.qav || 0),
                statusId: r.status_id ? String(r.status_id) : '',
                prefBinId:    pref ? pref.binId    : '',
                prefBinLabel: pref ? pref.binLabel : ''
            };
        });
    }

    /* ============================================================
     * Detection des items lot-tracked (a partir de itemtype)
     *  - InvtPart : article standard (peut etre lot ou pas)
     *  - on se base sur la presence de inv.id (lot_id) dans le
     *    contenu charge : si lot_id existe = lot-tracked
     * ============================================================ */
    function isLotTracked(line) {
        return Boolean(line && line.lotId);
    }

    /**
     * Wrapper d'appel : execute fn et re-throw avec contexte enrichi
     * en cas d'erreur. Le buffer in-memory est alimente a chaque step
     * (utilise par le panneau diag UI sur erreur) mais on n'inonde
     * plus les Script Execution Logs NetSuite avec un log.debug par
     * step en mode succes (v0.6.0 cleanup).
     */
    function step(name, fn) {
        try {
            logBuf('DEBUG', 'step', name);
            return fn();
        } catch (e) {
            var msg = (e.name ? e.name + ': ' : '') + (e.message || String(e));
            log.error({
                title: 'BT step FAIL ' + name,
                details: msg + (e.stack ? '\n' + String(e.stack).substring(0, 1000) : '')
            });
            logBuf('ERROR', 'step FAIL ' + name, msg);
            var wrapped = new Error('[' + name + '] ' + msg);
            wrapped.name = e.name || 'Error';
            wrapped.stack = e.stack;
            throw wrapped;
        }
    }

    /**
     * Cree N records bintransfer (= "Transfert d'emplacement" / TOE-XXXXX
     * dans NetSuite UI). 1 record par tuple item × lot × fromBin × toBin.
     *
     * IMPORTANT (v0.2.0) : record.Type.BIN_TRANSFER (pas BIN_WORKSHEET !).
     * Le binworksheet etait la "Bin Putaway Worksheet" (rangement post-
     * receipt), un record completement different qui filtrait sur une
     * file d'attente de putaway, d'ou tous les rejets en v0.1.x.
     */
    /**
     * v0.5.0 - createBinTransfer : 1 SEUL record bintransfer avec N
     * inventory lines (au lieu de N records separes en v0.4.x). Atomique
     * (tout reussit ou rien). Plus naturel pour les operations swap et
     * reconciliation et plus lisible dans NetSuite.
     */
    /* ============================================================
     * v0.8.4 - Detection USER_ERROR qty (commits SO ouvertes)
     *
     * NetSuite refuse au save un transfert qui depasse la qty
     * disponible (qoh - committedqtyperseriallotnumberlocation -
     * autres reservations). Le message d'erreur est :
     *   "Vous disposez seulement de X. Veuillez entrer une quantite
     *    differente."
     * (ou en EN : "You only have X available. ...")
     * ============================================================ */
    function isQtyAvailabilityError(err) {
        var m = String(err && err.message || err || '');
        return /vous disposez seulement|you only have|user_error.*quantit/i.test(m);
    }
    /**
     * v0.9.0 - regex stricte qui matche le pattern explicite "seulement de X"
     * (FR) ou "only have X" (EN). Avant on prenait le PREMIER nombre du
     * message, ce qui pouvait matcher un id de ligne ("Line 5: ...") au
     * lieu de la qty dispo. Fallback sur l'ancien pattern lacher si le
     * message NetSuite change de format dans une version future.
     */
    function extractAvailQty(err) {
        var m = String(err && err.message || err || '');
        // Pattern strict : capture le nombre apres "seulement de" / "only have"
        var strictMatch = m.match(/(?:seulement de|only have)\s+(\d+(?:[.,]\d+)?)/i);
        if (strictMatch) {
            return Number(strictMatch[1].replace(',', '.'));
        }
        // Fallback (compat) : 1er nombre apres le mot "quantite"/"quantity"
        var contextMatch = m.match(/quantit[eyé]\w*[^\d]*(\d+(?:[.,]\d+)?)/i);
        if (contextMatch) {
            return Number(contextMatch[1].replace(',', '.'));
        }
        return null;
    }

    function createBinTransfer(payload) {
        if (!payload || !payload.lines || !payload.lines.length) {
            throw new Error('Aucune ligne a transferer.');
        }
        if (!payload.locationId) {
            throw new Error('Location manquante.');
        }

        payload.lines.forEach(function (l, i) {
            if (!l.itemId)   throw new Error('itemId manquant ligne ' + i);
            if (!l.fromBin)  throw new Error('Bin source manquant ligne ' + i);
            if (!l.toBin)    throw new Error('Bin destination manquant ligne ' + i);
            if (l.fromBin === l.toBin) {
                throw new Error('Bin source = destination ligne ' + i);
            }
            if (!l.qty || Number(l.qty) <= 0) {
                throw new Error('Quantite invalide ligne ' + i);
            }
        });

        // v0.10.9 (OPTIM-1) - pre-fetch subsidiary UNE SEULE FOIS pour
        // toute la duree du createBinTransfer. Auparavant
        // saveBinTransferBatch faisait son propre lookup a chaque appel,
        // ce qui coutait 10 governance units × N en fallback ligne-par-ligne.
        // Maintenant : 10 units fixes, puis 30 units par TOE.
        // Gain : max viable fallback de 25 lignes → 33 lignes avant
        // SSS_USAGE_LIMIT_EXCEEDED. Le payload._subsidiaryId est lu en
        // priorite par saveBinTransferBatch (lookup fallback si vide).
        payload._subsidiaryId = step('lookup subsidiary (once per createBinTransfer)', function () {
            return getSubsidiaryForLocation(payload.locationId);
        });

        // v0.8.4 - tentative batch d'abord, fallback ligne-par-ligne
        // si erreur USER_ERROR de qty (impossible d'identifier la
        // ligne en cause avec un batch atomique).
        if (payload.lines.length === 1) {
            return saveBinTransferBatch(payload);
        }
        try {
            return saveBinTransferBatch(payload);
        } catch (eBatch) {
            if (!isQtyAvailabilityError(eBatch)) {
                throw eBatch;
            }
            // v0.10.10 - garde-fou commit partiel : le batch atomique a
            // echoue (qty insuffisante sur une ligne) et N'A RIEN cree.
            // Avant de basculer en fallback ligne-par-ligne (qui commit
            // ligne a ligne et peut s'arreter en plein milieu sur
            // SSS_USAGE_LIMIT_EXCEEDED, laissant N TOE crees + le reste
            // perdu), on refuse si la selection est trop grosse pour etre
            // rejouee en toute securite. On echoue ainsi proprement et
            // COMPLETEMENT (rien cree) plutot qu'a moitie.
            if (payload.lines.length > MAX_TOE_LINES) {
                throw new Error(
                    'Le transfert groupe a echoue sur une quantite insuffisante, et la ' +
                    'selection (' + payload.lines.length + ' lignes) est trop grande pour ' +
                    'etre rejouee ligne par ligne sans risque de gouvernance. Aucun transfert ' +
                    'n\'a ete cree. Corrigez la ligne en cause, ou decoupez en lots de ' +
                    MAX_TOE_LINES + ' lignes max.'
                );
            }
            log.audit({
                title: 'BinTransfer fallback ligne-par-ligne',
                details: 'batch fail: ' + String(eBatch.message).substring(0, 150)
            });
            return saveBinTransferLineByLine(payload, eBatch);
        }
    }

    /**
     * Boucle sur payload.lines, save 1 TOE par ligne. Renvoie :
     *   { id, ids, lineCount, totalLines, errors[], fallback: true,
     *     batchError: <msg original> }
     * `errors` contient les lignes qui ont plante avec la qty suggeree
     * par NetSuite si presente.
     */
    function saveBinTransferLineByLine(payload, batchError) {
        var ids = [];
        var errors = [];
        var adjustments = [];   // v0.8.5 - lignes ou la qty a ete ajustee auto
        var notProcessed = [];  // v0.10.10 - lignes sautees par le watchdog
        var govStop = false;    // v0.10.10
        payload.lines.forEach(function (l, idx) {
            // v0.10.10 - watchdog gouvernance : si on a deja decide de
            // s'arreter, ou si les units restantes ne suffisent plus a
            // garantir une ligne de plus, on NE COMMIT PAS cette ligne et
            // on la liste explicitement comme non traitee (au lieu de
            // planter en plein save et de perdre la trace).
            var rem = remainingUsage();
            if (govStop || (rem !== null && rem < GOV_SAFETY_FLOOR)) {
                govStop = true;
                notProcessed.push({
                    line:     idx,
                    itemCode: l.itemCode || ('item ' + l.itemId),
                    itemId:   l.itemId,
                    fromBin:  l.fromBin,
                    toBin:    l.toBin,
                    qty:      Number(l.qty)
                });
                return;
            }
            try {
                var single = {
                    locationId:     payload.locationId,
                    memo:           payload.memo,
                    suffix:         payload.suffix,    // v0.8.11 - propagation suffix descriptif
                    _subsidiaryId:  payload._subsidiaryId,   // v0.10.9 OPTIM-1 - reutilise le subsidiary deja resolu
                    lines:          [l]
                };
                var r = saveBinTransferBatch(single);
                ids.push(r.id);
                if (r.qtyAdjusted) {
                    adjustments.push({
                        line:        idx,
                        itemCode:    l.itemCode || ('item ' + l.itemId),
                        toeId:       r.id,
                        originalQty: r.originalQty,
                        adjustedQty: r.adjustedQty
                    });
                }
            } catch (eOne) {
                var avail = extractAvailQty(eOne);
                errors.push({
                    line:        idx,
                    itemCode:    l.itemCode || ('item ' + l.itemId),
                    itemId:      l.itemId,
                    fromBin:     l.fromBin,
                    toBin:       l.toBin,
                    qtyDemandee: Number(l.qty),
                    qtyDispo:    avail,
                    message:     String(eOne.message || eOne).substring(0, 250)
                });
            }
        });
        return {
            id:          ids[0] || null,
            ids:         ids,
            lineCount:   ids.length,
            totalLines:  payload.lines.length,
            errors:      errors,
            adjustments: adjustments,
            notProcessed: notProcessed,   // v0.10.10 - lignes non traitees (gouvernance)
            governanceStop: govStop,      // v0.10.10 - true si arret watchdog
            fallback:    true,
            batchError:  String(batchError && batchError.message || batchError || '').substring(0, 250)
        };
    }

    /**
     * Implementation reelle du save batch (1 TOE pour N lignes).
     * Code historique de createBinTransfer extrait pour pouvoir etre
     * appele aussi en mode mono-ligne dans le fallback.
     *
     * v0.8.5 - auto-retry mono-ligne avec qty ajustee :
     *   Si le save plante avec USER_ERROR de qty et qu'on a UNE seule
     *   ligne, on parse la qty suggeree par NetSuite et on retry avec
     *   cette qty. Le retour est marque {qtyAdjusted, originalQty,
     *   adjustedQty} pour que l'UI affiche un warning clair.
     */
    function saveBinTransferBatch(payload, alreadyRetried) {
        log.audit({
            title: 'BinTransfer batch create start',
            details: 'loc=' + payload.locationId + ' lines=' + payload.lines.length +
                     (alreadyRetried ? ' (retry qty)' : '')
        });

        var rec = step('record.create BIN_TRANSFER batch', function () {
            return record.create({
                type: record.Type.BIN_TRANSFER,
                isDynamic: false
            });
        });

        // v0.10.9 (OPTIM-1) - prefere le subsidiary memoize par createBinTransfer.
        // Fallback lookup pour les appels directs (cas swap/reconcile qui
        // n'ont pas (encore) ete migres a la memoization).
        var subsidiaryId = payload._subsidiaryId;
        if (subsidiaryId === undefined) {
            subsidiaryId = step('lookup subsidiary (fallback)', function () {
                return getSubsidiaryForLocation(payload.locationId);
            });
        }
        if (subsidiaryId) {
            step('setValue subsidiary', function () {
                rec.setValue({ fieldId: 'subsidiary', value: subsidiaryId });
            });
        }
        step('setValue location', function () {
            rec.setValue({ fieldId: 'location', value: payload.locationId });
        });

        // v0.6.4 - memo systematiquement applique :
        // si payload.memo vide, on met un default 'Bin Tool · UserName · ...'
        // pour que chaque TOE genere par le tool soit identifiable.
        // v0.6.7 - clamp a 40 chars (limite NetSuite).
        // v0.8.11 - suffix descriptif optionnel (ex: "N-1-1-04 → N-2-2-10"
        // en mode transfert simple, "ACHAT0850" en mode recherche article).
        // v0.10.8 : defaultMemo() inclut deja clampMemo en interne
        // (cf. defaultMemo lignes 379-384). Si l'user fournit un memo
        // explicite, on le clamp ici. Sinon defaultMemo s'en charge.
        var memoFinal = (payload.memo && String(payload.memo).trim())
            ? clampMemo(String(payload.memo).trim())
            : defaultMemo(payload.suffix);
        step('setValue memo', function () {
            rec.setValue({ fieldId: 'memo', value: memoFinal });
        });

        // 1 inventory line par ligne du payload (chaque ligne =
        // 1 mouvement item × lot × fromBin × toBin)
        payload.lines.forEach(function (a, lineIdx) {
            var p = 'L' + lineIdx + ' ';

            step(p + 'set inventory.item line ' + lineIdx, function () {
                rec.setSublistValue({
                    sublistId: 'inventory', fieldId: 'item',
                    line: lineIdx, value: a.itemId
                });
            });
            step(p + 'set inventory.quantity line ' + lineIdx, function () {
                rec.setSublistValue({
                    sublistId: 'inventory', fieldId: 'quantity',
                    line: lineIdx, value: Number(a.qty)
                });
            });

            var invDetail = step(p + 'getSublistSubrecord inventorydetail line ' + lineIdx, function () {
                return rec.getSublistSubrecord({
                    sublistId: 'inventory', fieldId: 'inventorydetail',
                    line: lineIdx
                });
            });
            if (!invDetail) {
                throw new Error(p + 'inventorydetail subrecord indisponible');
            }

            step(p + 'set ia.binnumber (=FROM)', function () {
                invDetail.setSublistValue({
                    sublistId: 'inventoryassignment', fieldId: 'binnumber',
                    line: 0, value: a.fromBin
                });
            });
            step(p + 'set ia.tobinnumber (=TO)', function () {
                invDetail.setSublistValue({
                    sublistId: 'inventoryassignment', fieldId: 'tobinnumber',
                    line: 0, value: a.toBin
                });
            });
            step(p + 'set ia.quantity', function () {
                invDetail.setSublistValue({
                    sublistId: 'inventoryassignment', fieldId: 'quantity',
                    line: 0, value: Number(a.qty)
                });
            });
            if (a.isLot && a.lotId) {
                step(p + 'set ia.issueinventorynumber', function () {
                    invDetail.setSublistValue({
                        sublistId: 'inventoryassignment', fieldId: 'issueinventorynumber',
                        line: 0, value: a.lotId
                    });
                });
            }
            if (a.statusId) {
                try {
                    step(p + 'set ia.inventorystatus', function () {
                        invDetail.setSublistValue({
                            sublistId: 'inventoryassignment', fieldId: 'inventorystatus',
                            line: 0, value: a.statusId
                        });
                    });
                } catch (eS) {
                    log.audit({ title: p + 'inventorystatus skip', details: eS.message });
                }
                try {
                    step(p + 'set ia.toinventorystatus', function () {
                        invDetail.setSublistValue({
                            sublistId: 'inventoryassignment', fieldId: 'toinventorystatus',
                            line: 0, value: a.statusId
                        });
                    });
                } catch (eToS) {
                    log.audit({ title: p + 'toinventorystatus skip', details: eToS.message });
                }
            }
        });

        var id;
        try {
            id = step('record.save batch', function () {
                return rec.save({
                    enableSourcing: true,
                    ignoreMandatoryFields: false
                });
            });
        } catch (eSave) {
            // v0.8.5 - auto-retry mono-ligne avec qty ajustee
            // (NetSuite renvoie la qty suggeree dans le message)
            if (!alreadyRetried &&
                payload.lines.length === 1 &&
                isQtyAvailabilityError(eSave)) {
                var avail = extractAvailQty(eSave);
                var origQty = Number(payload.lines[0].qty);
                // v0.10.8 (B2) - si extractAvailQty echoue (regex ne matche
                // pas le wording NetSuite), on log explicitement pour qu'on
                // puisse corriger la regex apres coup. Le retry auto ne se
                // declenche pas dans ce cas, l'erreur originale remonte.
                if (avail === null) {
                    log.audit({
                        title:   'BinTransfer extractAvailQty=null (regex KO)',
                        details: 'msg=' + String(eSave.message || '').substring(0, 300) +
                                 ' | wording NetSuite a peut-etre change, regex a reviser'
                    });
                    logBuf('audit', 'extractAvailQty null',
                        String(eSave.message || '').substring(0, 200));
                }
                if (avail !== null && avail > 0 && avail < origQty) {
                    log.audit({
                        title: 'BinTransfer qty auto-adjust retry',
                        details: 'orig=' + origQty + ' avail=' + avail +
                                 ' item=' + (payload.lines[0].itemCode || payload.lines[0].itemId)
                    });
                    // Clone propre du payload avec la qty ajustee
                    var lineCopy = {};
                    Object.keys(payload.lines[0]).forEach(function (k) {
                        lineCopy[k] = payload.lines[0][k];
                    });
                    lineCopy.qty = avail;
                    var adjustedPayload = {
                        locationId:    payload.locationId,
                        memo:          payload.memo,
                        suffix:        payload.suffix,    // v0.9.0 - preserver le memo descriptif au retry
                        _subsidiaryId: payload._subsidiaryId,   // v0.10.9 OPTIM-1
                        lines:         [lineCopy]
                    };
                    var res = saveBinTransferBatch(adjustedPayload, true);
                    res.qtyAdjusted = true;
                    res.originalQty = origQty;
                    res.adjustedQty = avail;
                    res.itemCode    = payload.lines[0].itemCode || ('item ' + payload.lines[0].itemId);
                    return res;
                }
            }
            throw eSave;
        }

        log.audit({
            title: 'BinTransfer batch cree',
            details: 'id=' + id + ' lines=' + payload.lines.length
        });

        return {
            id:        String(id),
            ids:       [String(id)],
            lineCount: payload.lines.length,
            errors:    []                    // atomique : pas de partial-success
        };
    }

    /* ============================================================
     * Mode SWAP : echange croise de 2 bins en 1 seule transaction
     *  Les lignes sont deja preparees cote serveur (a partir des
     *  contenus des deux bins) avant appel.
     * ============================================================ */
    function createSwap(binAId, binBId, locationId, memo) {
        if (!binAId || !binBId) throw new Error('Bin A et Bin B requis.');
        if (binAId === binBId)  throw new Error('Bin A et Bin B identiques.');

        var contentA = loadBinContents(binAId);
        var contentB = loadBinContents(binBId);

        if (!contentA.length && !contentB.length) {
            throw new Error('Les deux bins sont vides : rien a echanger.');
        }

        // Verifie qu'on est dans la meme location (pre-requis bin transfer)
        var locA = contentA[0] && contentA[0].locId;
        var locB = contentB[0] && contentB[0].locId;
        if (locA && locB && locA !== locB) {
            throw new Error('Swap impossible : les deux bins sont dans des entrepots differents.');
        }
        var loc = locationId || locA || locB;
        if (!loc) throw new Error('Impossible de determiner la location.');

        // v0.8.3 : on utilise la qty DISPONIBLE (qav) et pas la qty
        // physique (qoh). NetSuite refuse les transferts > qav meme si
        // physiquement les unites sont la (cause typique : reservation
        // sur SO ouverte). Si qav = 0 sur une ligne, on l'ignore.
        var lines = [];
        contentA.forEach(function (l) {
            var q = (typeof l.qav === 'number' && l.qav > 0) ? l.qav : l.qoh;
            if (!q || q <= 0) return;
            lines.push({
                itemId:   l.itemId,
                itemCode: l.itemCode,
                fromBin:  binAId,
                toBin:    binBId,
                qty:      q,
                lotId:    l.lotId,
                lotLabel: l.lotLabel,
                statusId: l.statusId,
                isLot:    isLotTracked(l)
            });
        });
        contentB.forEach(function (l) {
            var q = (typeof l.qav === 'number' && l.qav > 0) ? l.qav : l.qoh;
            if (!q || q <= 0) return;
            lines.push({
                itemId:   l.itemId,
                itemCode: l.itemCode,
                fromBin:  binBId,
                toBin:    binAId,
                qty:      q,
                lotId:    l.lotId,
                lotLabel: l.lotLabel,
                statusId: l.statusId,
                isLot:    isLotTracked(l)
            });
        });

        return createBinTransfer({
            locationId: loc,
            memo: memo || defaultMemo('SWAP bins ' + binAId + ' <-> ' + binBId),
            lines: lines
        });
    }

    /* ============================================================
     * Mode RECONCILIATION : prend une liste de mouvements
     *  Chaque mouvement = (itemId, lotId, fromBin, toBin, qty, isLot)
     *  Tous doivent etre dans la meme location.
     *  Cree 1 SEUL bintransfer (lignes regroupees par item) — backend
     *  legacy conserve pour rollback eventuel ; UI v0.5.x retiree.
     * ============================================================ */
    function createReconciliation(payload) {
        if (!payload || !payload.lines || !payload.lines.length) {
            throw new Error('Aucun mouvement a executer.');
        }
        if (!payload.locationId) {
            throw new Error('Location manquante (mode reconciliation).');
        }
        return createBinTransfer({
            locationId: payload.locationId,
            memo: payload.memo || defaultMemo('Reconciliation'),
            lines: payload.lines
        });
    }

    /* ============================================================
     * v0.8.1 - HISTORIQUE TRANSFERTS (FIX tables standard)
     *
     * loadHistory(filters)
     *   filters : { daysBack: 7|30|90, locationId?: string, q?: string }
     *   Retourne les TOEs (transaction WHERE type='BinTrnfr') de
     *   l'intervalle, toutes sources (Suitelet + UI native).
     *
     *   v0.8.0 utilisait `binTransfer` / `binTransferInventory` (tables
     *   custom dediees) qui marchent via REST/MCP mais pas via N/query
     *   en SuiteScript runtime (SSS_SEARCH_ERROR_OCCURRED). On utilise
     *   la table `transaction` + `transactionline` (universelles).
     *
     *   2 queries :
     *     1. Header : transaction + LEFT JOIN transactionline mainline=T
     *        pour la location (transaction.location est null sur BinTrnfr)
     *     2. Counts : transactionline mainline=F AND quantity>0 (= nombre
     *        de mouvements = nb lignes user-facing). Filtre via subquery
     *        IN sur les ids du header.
     *   Limite : 1000 TOEs.
     * ============================================================ */
    function loadHistory(filters) {
        filters = filters || {};
        var days = Number(filters.daysBack) || 30;
        if (days < 1) days = 1;
        if (days > 365) days = 365;

        // 1) HEADER QUERY
        var where = [
            "t.type = 'BinTrnfr'",
            "t.trandate >= TRUNC(SYSDATE) - " + days
        ];
        if (filters.locationId) {
            // Filtre par location via la mainline (t.location est null sur BinTrnfr)
            where.push("tl.location = " + Number(filters.locationId));
        }
        if (filters.q && String(filters.q).trim()) {
            // v0.10.8 (B1) - meme traitement que searchItems
            var qSafe = escapeLike(String(filters.q).trim().toLowerCase())
                .replace(/'/g, "''");
            where.push(
                "(LOWER(t.tranid) LIKE '%" + qSafe + "%' ESCAPE '\\' " +
                " OR LOWER(t.memo) LIKE '%" + qSafe + "%' ESCAPE '\\' " +
                " OR LOWER(BUILTIN.DF(t.createdby)) LIKE '%" + qSafe + "%' ESCAPE '\\')"
            );
        }

        var sqlHead =
            "SELECT t.id, t.tranid, t.trandate, t.memo, " +
            "       t.createdby, BUILTIN.DF(t.createdby) AS user_name, " +
            "       t.createddate, t.lastmodifieddate, t.voided, " +
            "       tl.location AS loc_id, BUILTIN.DF(tl.location) AS loc_name " +
            "FROM transaction t " +
            "LEFT JOIN transactionline tl " +
            "       ON tl.transaction = t.id AND tl.mainline = 'T' " +
            "WHERE " + where.join(' AND ') + " " +
            "ORDER BY t.trandate DESC, t.id DESC " +
            "FETCH FIRST 1000 ROWS ONLY";

        var headRows = runQ(sqlHead);
        if (!headRows.length) return [];

        // 2) LINE COUNTS - subquery IN sur les ids retenus
        var ids = headRows.map(function (r) { return Number(r.id); });
        // Limite IN a 1000 valeurs (SuiteQL OK jusqu'a 1000)
        var sqlCount =
            "SELECT tl.transaction AS tid, COUNT(*) AS nb " +
            "FROM transactionline tl " +
            "WHERE tl.mainline = 'F' " +
            "  AND tl.quantity > 0 " +
            "  AND tl.transaction IN (" + ids.join(',') + ")" +
            " GROUP BY tl.transaction";
        var countRows = runQ(sqlCount);
        var countMap = {};
        countRows.forEach(function (r) {
            countMap[String(r.tid)] = Number(r.nb || 0);
        });

        return headRows.map(function (r) {
            return {
                id:          String(r.id),
                tranid:      r.tranid || ('TOE-' + r.id),
                trandate:    r.trandate || '',
                memo:        r.memo || '',
                locId:       r.loc_id ? String(r.loc_id) : '',
                locName:     r.loc_name || '',
                userId:      r.createdby ? String(r.createdby) : '',
                userName:    r.user_name || '',
                createdDate: r.createddate || '',
                lastModified: r.lastmodifieddate || '',
                voided:      r.voided === 'T',
                lineCount:   countMap[String(r.id)] || 0,
                fromTool:    /^(Bin Tool|BF Tool)/.test(String(r.memo || ''))
            };
        });
    }

    /**
     * Detail d'un TOE : reconstruction des mouvements depuis
     * inventoryAssignment (paire transactionline N / N+1) +
     * transactionline (mainline='F' AND quantity<0) pour les item codes.
     *
     * Retourne un tableau de "mouvements", chaque mouvement reagrege :
     *   { itemId, itemCode, itemName, lotId, lotLabel, dlc,
     *     fromBins:[{id,label,qty},...], toBins:[{id,label,qty},...] }
     *
     * Cas std : 1 from, 1 to. Cas split : N from / N to (rare).
     */
    function loadHistoryDetail(toeId) {
        if (!toeId) return [];
        var id = Number(toeId);

        // 1) Recuperer les half-moves depuis inventoryAssignment.
        var sqlIa =
            "SELECT ia.transactionline, ia.bin, " +
            "       BUILTIN.DF(ia.bin) AS bin_label, " +
            "       ia.quantity, " +
            "       ia.inventorynumber, " +
            "       BUILTIN.DF(ia.inventorynumber) AS lot_label, " +
            "       inv.expirationdate AS dlc, " +
            "       ia.inventorystatus " +
            "FROM inventoryAssignment ia " +
            "LEFT JOIN inventoryNumber inv ON inv.id = ia.inventorynumber " +
            "WHERE ia.transaction = " + id + " " +
            "ORDER BY ia.transactionline, ia.id";
        var iaRows = runQ(sqlIa);

        // 2) Recuperer les item lines via transactionline (cote ISSUE,
        //    quantity < 0). linesequencenumber impair = pairKey.
        var sqlTl =
            "SELECT tl.linesequencenumber AS line, tl.item, " +
            "       BUILTIN.DF(tl.item) AS item_code, " +
            "       it.displayname AS item_name " +
            "FROM transactionline tl " +
            "LEFT JOIN item it ON it.id = tl.item " +
            "WHERE tl.transaction = " + id + " " +
            "  AND tl.mainline = 'F' " +
            "  AND tl.quantity < 0 " +
            "ORDER BY tl.linesequencenumber";
        var btiRows = runQ(sqlTl);

        // Index : line (impair) -> { itemId, itemCode, itemName }
        var btiByLine = {};
        btiRows.forEach(function (r) {
            btiByLine[String(r.line)] = {
                itemId:   r.item ? String(r.item) : '',
                itemCode: r.item_code || '',
                itemName: r.item_name || ''
            };
        });

        // 3) Pairer les inventoryAssignment par paire (N, N+1).
        //    pairKey = transactionline impair (donc N si impair, N-1 si pair).
        var pairs = {};
        iaRows.forEach(function (r) {
            var tl = Number(r.transactionline) || 0;
            var pairKey = (tl % 2 === 1) ? tl : (tl - 1);
            if (!pairs[pairKey]) {
                pairs[pairKey] = {
                    line:     pairKey,
                    fromBins: [],
                    toBins:   [],
                    lotId:    '',
                    lotLabel: '',
                    dlc:      ''
                };
            }
            var p = pairs[pairKey];
            // Lot/DLC : prendre depuis n'importe quelle ligne (toutes identiques)
            if (!p.lotId && r.inventorynumber) p.lotId = String(r.inventorynumber);
            if (!p.lotLabel && r.lot_label) p.lotLabel = r.lot_label;
            if (!p.dlc && r.dlc) p.dlc = r.dlc;

            var qty = Number(r.quantity || 0);
            var bin = {
                id:    String(r.bin || ''),
                label: r.bin_label || ('BIN ' + r.bin),
                qty:   Math.abs(qty)
            };
            if (qty < 0) p.fromBins.push(bin);
            else if (qty > 0) p.toBins.push(bin);
        });

        // 4) Construire la liste de mouvements ordonnee par line (= ordre saisie).
        var keys = Object.keys(pairs).map(Number).sort(function (a, b) { return a - b; });
        var moves = keys.map(function (k) {
            var p = pairs[k];
            var bti = btiByLine[String(k)] || { itemId: '', itemCode: '?', itemName: '' };
            // Total qty = somme des fromBins (ou toBins, equivalent)
            var totalQty = p.fromBins.reduce(function (s, b) { return s + b.qty; }, 0);
            return {
                line:      k,
                itemId:    bti.itemId,
                itemCode:  bti.itemCode,
                itemName:  bti.itemName,
                lotId:     p.lotId,
                lotLabel:  p.lotLabel,
                dlc:       p.dlc,
                fromBins:  p.fromBins,
                toBins:    p.toBins,
                totalQty:  totalQty
            };
        });
        return moves;
    }

    /* ============================================================
     * Helper SuiteQL run + paginate (jusqu'a 4000 rows)
     * ============================================================ */
    function runQ(sql) {
        var rows = [];
        var page = query.runSuiteQLPaged({ query: sql, pageSize: 1000 });
        for (var i = 0; i < page.pageRanges.length; i++) {
            var data = page.fetch({ index: i }).data.asMappedResults();
            rows = rows.concat(data);
            if (rows.length > 4000) break;
        }
        return rows;
    }

    return {
        loadLocations:        loadLocations,
        loadBins:             loadBins,
        loadBinContents:      loadBinContents,
        searchItems:          searchItems,         // v0.4.0
        loadItemContents:     loadItemContents,    // v0.4.0
        createBinTransfer:    createBinTransfer,
        createSwap:           createSwap,
        createReconciliation: createReconciliation,
        // v0.8.0 - historique
        loadHistory:          loadHistory,
        loadHistoryDetail:    loadHistoryDetail,
        // v0.10.0 - configuration bin prefere
        loadItemBinAssociations: loadItemBinAssociations,
        setPreferredBinForItems: setPreferredBinForItems,
        // Diagnostic exfiltration (v0.2.3)
        resetLogBuffer:       resetLogBuffer,
        getLogBuffer:         getLogBuffer
    };

});