/**
 * @NApiVersion 2.1
 * @NScriptType Restlet
 * @NModuleScope SameAccount
 *
 * Décaissage d'une palette (WMS Mobile)
 * ------------------------------------
 * Reçoit un numéro de lot palette scanné, en deux modes :
 *
 *   mode="preview" (récap avant validation, aucune écriture) :
 *     1. Recherche le stock de ce lot (article / location / bin / quantité) via SuiteQL
 *     2. Recherche les ALD actifs (non décaissés) rattachés à ce lot
 *     3. Contrôles de cohérence (quantités, doublons, article, ALD déjà utilisé ailleurs)
 *     4. Renvoie un récapitulatif
 *
 *   mode="confirm" (par défaut si absent - comportement V1 préservé) :
 *     Idem, puis crée UN Inventory Adjustment :
 *       - ligne négative : sortie totale du lot palette
 *       - ligne positive : entrée d'un nouveau lot par ALD
 *     puis marque chaque ALD traité comme décaissé.
 *
 * Paramètre de script attendu :
 *  custscript_ax_decaissage_account -> compte d'ajustement
 *
 * Champs NetSuite requis sur customrecord_additionallotdetails (à créer avant
 * déploiement - voir CONTEXT_decaissage_wms.md section 1) :
 *  custrecord_lots_decaisse            (Check Box)
 *  custrecord_lots_decaisse_date       (Date/Time)
 *  custrecord_lots_decaisse_adjustment (List/Record -> Transaction, lien vers l'ajustement)
 */
define(['N/record', 'N/search', 'N/query', 'N/runtime', 'N/log'],
function (record, search, query, runtime, log) {

    var QTY_EPSILON = 0.001;

    // ─────────────────────────────────────────────
    // Recherche du lot palette et de son stock (SuiteQL)
    // ─────────────────────────────────────────────
    function trouverStockPalette(palletNumber) {

        var sql =
            'SELECT ' +
            '  inv.id              AS invnumid, ' +
            '  bal.item            AS itemid, ' +
            '  bal.location        AS locationid, ' +
            '  bal.binnumber       AS binid, ' +
            '  bin.binnumber       AS bintext, ' +
            '  bal.inventorystatus AS statusid, ' +
            '  bal.quantityonhand  AS qty ' +
            'FROM inventorynumber inv ' +
            'INNER JOIN inventorybalance bal ON bal.inventorynumber = inv.id ' +
            'LEFT JOIN bin ON bin.id = bal.binnumber ' +
            'WHERE inv.inventorynumber = ? ' +
            '  AND bal.quantityonhand > 0';

        var rows = query.runSuiteQL({ query: sql, params: [palletNumber] }).asMappedResults();

        log.debug('trouverStockPalette', 'Palette ' + palletNumber + ' -> ' + rows.length + ' ligne(s) de stock');

        if (!rows.length) {
            throw 'Aucun stock disponible pour la palette ' + palletNumber + '.';
        }
        if (rows.length > 1) {
            throw 'Palette ' + palletNumber + ' presente sur ' + rows.length
                + ' emplacements - decaissage impossible.';
        }

        var r = rows[0];

        if (!r.binid) {
            throw 'Palette ' + palletNumber + ' : stock non range dans un emplacement (bin). '
                + 'Ranger la palette avant de la decaisser.';
        }

        return {
            invNumId:   String(r.invnumid),
            itemId:     String(r.itemid),
            locationId: String(r.locationid),
            binId:      String(r.binid),
            binText:    r.bintext || String(r.binid),
            statusId:   r.statusid ? String(r.statusid) : '',
            qty:        parseFloat(r.qty) || 0
        };
    }

    // Libellé article pour l'affichage du récap (préview).
    function resolveItemLabel(itemId) {
        try {
            var res = search.lookupFields({ type: search.Type.ITEM, id: itemId, columns: ['itemid', 'displayname'] });
            var code = res.itemid || '';
            var name = res.displayname || '';
            return name ? (code + ' - ' + name) : code;
        } catch (e) {
            log.error('resolveItemLabel', 'itemId=' + itemId + ' : ' + e.message);
            return String(itemId);
        }
    }

    // ─────────────────────────────────────────────
    // Recherche des ALD rattachés au lot palette - actifs uniquement
    // (non déjà décaissés). Distingue "aucun ALD" de "tous déjà décaissés"
    // pour donner un message clair dans ce second cas.
    // ─────────────────────────────────────────────
    function trouverALD(invNumId) {
        var tousLesAld = [];

        search.create({
            type: 'customrecord_additionallotdetails',
            filters: [
                ['custrecord_lots_inventorynumber', 'anyof', invNumId], 'AND',
                ['isinactive', 'is', 'F']
            ],
            columns: [
                'internalid',
                'custrecord_lots_lotnumber',
                'custrecord_lots_netquantity',
                'custrecord_lots_expirationdate',
                'custrecord_lots_item',
                'custrecord_lots_decaisse',
                'custrecord_lots_decaisse_adjustment'
            ]
        }).run().each(function (r) {
            tousLesAld.push({
                id:            r.getValue({ name: 'internalid' }),
                lotNum:        r.getValue({ name: 'custrecord_lots_lotnumber' }),
                qty:           parseFloat(r.getValue({ name: 'custrecord_lots_netquantity' })) || 0,
                expDate:       r.getValue({ name: 'custrecord_lots_expirationdate' }),
                itemId:        r.getValue({ name: 'custrecord_lots_item' }) || '',
                decaisse:      r.getValue({ name: 'custrecord_lots_decaisse' }) === true,
                adjustmentRef: r.getValue({ name: 'custrecord_lots_decaisse_adjustment' }) || ''
            });
            return true;
        });

        log.debug('trouverALD', tousLesAld.length + ' ALD trouvé(s) pour le lot ' + invNumId);

        if (!tousLesAld.length) {
            throw 'Aucun détail de lot (ALD) trouvé pour cette palette.';
        }

        var actifs = tousLesAld.filter(function (a) { return !a.decaisse; });

        if (!actifs.length) {
            var refs = tousLesAld
                .map(function (a) { return a.adjustmentRef; })
                .filter(function (v, i, arr) { return v && arr.indexOf(v) === i; });
            throw 'Palette déjà décaissée' + (refs.length ? ' (voir ajustement #' + refs.join(', #') + ')' : '') + '.';
        }

        if (actifs.length !== tousLesAld.length) {
            log.audit('trouverALD', 'Etat partiel inattendu : ' + (tousLesAld.length - actifs.length)
                + ' ALD déjà décaissé(s) sur ' + tousLesAld.length + ' pour le lot ' + invNumId);
        }

        return actifs;
    }

    // ─────────────────────────────────────────────
    // Contrôles de cohérence - avant toute écriture.
    // Lève une exception (bloquant) ou renvoie une liste d'avertissements
    // (informatif, n'empêche pas le traitement).
    // ─────────────────────────────────────────────
    function validerCoherence(stock, alds) {
        var warnings = [];

        // Article ALD incohérent avec l'article de la palette - uniquement
        // quand le champ est renseigné (pas toujours le cas selon la doc),
        // pour ne pas bloquer sur une donnée simplement absente.
        var articlesIncoherents = alds.filter(function (a) { return a.itemId && a.itemId !== stock.itemId; });
        if (articlesIncoherents.length) {
            throw 'Incohérence article : ALD ' + articlesIncoherents.map(function (a) { return a.id; }).join(', ')
                + ' rattaché(s) à un article différent de celui de la palette (' + stock.itemId + ').';
        }

        // Numéros de lot dupliqués au sein de la même palette.
        var parLot = {};
        alds.forEach(function (a) {
            if (!a.lotNum) { return; }
            (parLot[a.lotNum] = parLot[a.lotNum] || []).push(a.id);
        });
        var doublons = Object.keys(parLot).filter(function (lot) { return parLot[lot].length > 1; });
        if (doublons.length) {
            throw 'Numéro(s) de lot en double dans les ALD de cette palette : ' + doublons.join(', ') + '.';
        }

        // Somme des quantités ALD vs quantité totale de la palette.
        var totalIn = 0;
        alds.forEach(function (a) { if (a.lotNum && a.qty > 0) { totalIn += a.qty; } });
        if (Math.abs(totalIn - stock.qty) > QTY_EPSILON) {
            throw 'Écart de quantité : palette de ' + stock.qty + ', sous-lots ALD totalisant ' + totalIn
                + ' - décaissage bloqué, vérifier les ALD.';
        }

        // Lot ALD déjà présent en stock actif ailleurs (même article) -
        // informatif seulement, l'incertitude métier ne justifie pas un
        // blocage, mais ça doit rester visible.
        try {
            var lotTexts = alds.map(function (a) { return a.lotNum; }).filter(function (v) { return v; });
            if (lotTexts.length) {
                var placeholders = lotTexts.map(function () { return '?'; }).join(',');
                var sql =
                    'SELECT inv.inventorynumber AS lotnum ' +
                    'FROM inventorynumber inv ' +
                    'INNER JOIN inventorybalance bal ON bal.inventorynumber = inv.id ' +
                    'WHERE bal.item = ? AND bal.quantityonhand > 0 AND inv.inventorynumber IN (' + placeholders + ')';
                var existants = query.runSuiteQL({ query: sql, params: [stock.itemId].concat(lotTexts) }).asMappedResults();
                existants.forEach(function (row) {
                    warnings.push('Le numéro de lot ' + row.lotnum + ' existe déjà en stock actif pour cet article.');
                });
            }
        } catch (e) {
            log.error('validerCoherence - contrôle lot existant échoué (non bloquant)', e.message);
        }

        return { totalIn: totalIn, warnings: warnings };
    }

    // ─────────────────────────────────────────────
    // Conversion date string -> Date NetSuite
    // ─────────────────────────────────────────────
    function convertirDate(strDate) {
        if (!strDate) { return null; }
        try {
            var p = String(strDate).split('/');   // format attendu DD/MM/YYYY
            if (p.length === 3) {
                return new Date(parseInt(p[2], 10), parseInt(p[1], 10) - 1, parseInt(p[0], 10));
            }
            return new Date(strDate);
        } catch (e) {
            log.error('convertirDate', 'Date invalide : ' + strDate);
            return null;
        }
    }

    // ─────────────────────────────────────────────
    // Création de l'ajustement de stock
    // ─────────────────────────────────────────────
    function creerAjustement(stock, alds, totalIn) {

        var compteAjust = runtime.getCurrentScript()
            .getParameter({ name: 'custscript_ax_decaissage_account' });

        var adj = record.create({ type: record.Type.INVENTORY_ADJUSTMENT, isDynamic: true });

        if (compteAjust) {
            adj.setValue({ fieldId: 'account', value: compteAjust });
        }
        adj.setValue({ fieldId: 'memo', value: 'Décaissage palette (lot ' + stock.invNumId + ')' });

        // ─── Ligne 1 : sortie totale du lot palette ───
        adj.selectNewLine({ sublistId: 'inventory' });
        adj.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'item', value: stock.itemId });
        adj.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'location', value: stock.locationId });
        adj.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'adjustqtyby', value: -stock.qty });

        var detOut = adj.getCurrentSublistSubrecord({ sublistId: 'inventory', fieldId: 'inventorydetail' });
        detOut.selectNewLine({ sublistId: 'inventoryassignment' });
        detOut.setCurrentSublistValue({
            sublistId: 'inventoryassignment',
            fieldId: 'issueinventorynumber',
            value: stock.invNumId
        });
        if (stock.binId) {
            detOut.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'binnumber', value: stock.binId });
        }
        if (stock.statusId) {
            detOut.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'inventorystatus', value: stock.statusId });
        }
        detOut.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', value: -stock.qty });
        detOut.commitLine({ sublistId: 'inventoryassignment' });

        adj.commitLine({ sublistId: 'inventory' });

        // ─── Ligne 2 : entrée des nouveaux lots ───
        adj.selectNewLine({ sublistId: 'inventory' });
        adj.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'item', value: stock.itemId });
        adj.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'location', value: stock.locationId });
        adj.setCurrentSublistValue({ sublistId: 'inventory', fieldId: 'adjustqtyby', value: totalIn });

        var detIn = adj.getCurrentSublistSubrecord({ sublistId: 'inventory', fieldId: 'inventorydetail' });

        var aldsTraites = [];
        for (var j = 0; j < alds.length; j++) {
            var ald = alds[j];
            if (!ald.lotNum || ald.qty <= 0) {
                log.error('creerAjustement', 'ALD ' + ald.id + ' ignoré (lot ou quantité manquant)');
                continue;
            }

            detIn.selectNewLine({ sublistId: 'inventoryassignment' });
            detIn.setCurrentSublistText({
                sublistId: 'inventoryassignment',
                fieldId: 'receiptinventorynumber',
                text: ald.lotNum
            });
            detIn.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', value: ald.qty });
            if (stock.binId) {
                detIn.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'binnumber', value: stock.binId });
            }
            if (stock.statusId) {
                detIn.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'inventorystatus', value: stock.statusId });
            }
            var d = convertirDate(ald.expDate);
            if (d) {
                detIn.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'expirationdate', value: d });
            }
            detIn.commitLine({ sublistId: 'inventoryassignment' });
            aldsTraites.push(ald);
        }

        adj.commitLine({ sublistId: 'inventory' });

        var adjId = adj.save();
        log.audit('creerAjustement', 'Inventory Adjustment créé : ' + adjId
            + ' | sortie ' + stock.qty + ' | entrée ' + totalIn + ' sur ' + alds.length + ' lot(s)');

        return { adjId: adjId, totalIn: totalIn, aldsTraites: aldsTraites };
    }

    // Retrouve l'internal id du NOUVEAU numéro de lot (colis) créé par la
    // ligne d'entrée de l'ajustement (receiptinventorynumber, posé par
    // texte - NetSuite résout/crée l'inventorynumber correspondant, sans
    // exposer son id directement). Même schéma de jointure que
    // trouverStockPalette (déjà confirmé sur ce compte), pour ne pas
    // deviner un nouveau nom de colonne.
    function resolveNewInventoryNumberId(itemId, lotNum) {
        try {
            var sql = 'SELECT inv.id AS id ' +
                'FROM inventorynumber inv ' +
                'INNER JOIN inventorybalance bal ON bal.inventorynumber = inv.id ' +
                'WHERE inv.inventorynumber = ? AND bal.item = ?';
            var rows = query.runSuiteQL({ query: sql, params: [lotNum, itemId] }).asMappedResults();
            if (rows.length) {
                return String(rows[0].id);
            }
        } catch (e) {
            log.error('resolveNewInventoryNumberId', 'itemId=' + itemId + ' lotNum=' + lotNum + ' : ' + e.message);
        }
        return null;
    }

    // Marque les ALD effectivement traités comme décaissés - archivage +
    // traçabilité (voir CONTEXT_decaissage_wms.md section 1). Met aussi à
    // jour custrecord_lots_inventorynumber pour qu'il pointe désormais vers
    // le NOUVEAU lot colis (jusqu'ici il restait rattaché au lot palette
    // d'origine) - l'ALD devient ainsi auto-cohérent : son propre numéro de
    // lot et sa référence d'inventaire désignent la même chose après
    // décaissage. N'échoue pas le décaissage si une mise à jour
    // individuelle échoue : l'ajustement est déjà enregistré à ce stade,
    // c'est irréversible depuis ce point.
    function marquerALDDecaisses(alds, adjId, itemId) {
        var maintenant = new Date();
        alds.forEach(function (ald) {
            try {
                var values = {
                    custrecord_lots_decaisse: true,
                    custrecord_lots_decaisse_date: maintenant,
                    custrecord_lots_decaisse_adjustment: String(adjId)
                };

                var newInvNumId = resolveNewInventoryNumberId(itemId, ald.lotNum);
                if (newInvNumId) {
                    values.custrecord_lots_inventorynumber = newInvNumId;
                } else {
                    log.error('marquerALDDecaisses', 'ALD ' + ald.id + ' : nouveau lot "' + ald.lotNum
                        + '" introuvable après création - custrecord_lots_inventorynumber non mis à jour, à investiguer.');
                }

                record.submitFields({
                    type: 'customrecord_additionallotdetails',
                    id: ald.id,
                    values: values,
                    options: { enablesourcing: false, ignoreMandatoryFields: true }
                });
            } catch (e) {
                log.error('marquerALDDecaisses', 'ALD ' + ald.id + ' non marqué (ajustement ' + adjId + ' déjà créé) : ' + e.message);
            }
        });
    }

    // ─────────────────────────────────────────────
    // POINT D'ENTREE
    // ─────────────────────────────────────────────
    function post(requestBody) {

        log.audit('DECAISSAGE - entrée', JSON.stringify(requestBody));

        // Les Input Parameters mobiles arrivent dans "params"
        var src = (requestBody && requestBody.params) ? requestBody.params
                : ((requestBody && requestBody.data) ? requestBody.data : requestBody);

        // mode absent = "confirm" (comportement V1 préservé si la config WMS
        // Mobile n'envoie pas encore ce paramètre).
        var mode = (src && src.mode) ? String(src.mode).trim().toLowerCase() : 'confirm';
        if (mode !== 'preview' && mode !== 'confirm') { mode = 'confirm'; }

        try {
            var palletNumber = (src && src.palletNumber) ? String(src.palletNumber).trim() : '';

            if (!palletNumber) {
                log.error('DECAISSAGE', 'Aucun numéro de palette reçu — body : ' + JSON.stringify(requestBody));
                return { success: false, mode: mode, message: 'Aucun numéro de palette reçu.' };
            }

            var stock = trouverStockPalette(palletNumber);
            var alds  = trouverALD(stock.invNumId);
            var validation = validerCoherence(stock, alds);

            log.debug('DECAISSAGE', 'Palette ' + palletNumber
                + ' | mode ' + mode
                + ' | article ' + stock.itemId
                + ' | bin ' + stock.binText
                + ' | location ' + stock.locationId
                + ' | qté ' + stock.qty
                + ' | ' + alds.length + ' ALD');

            if (mode === 'preview') {
                return {
                    success: true,
                    mode: 'preview',
                    palletNumber: palletNumber,
                    item: resolveItemLabel(stock.itemId),
                    bin: stock.binText,
                    location: stock.locationId,
                    qtyTotal: stock.qty,
                    nbLots: alds.length,
                    warnings: validation.warnings
                };
            }

            var res = creerAjustement(stock, alds, validation.totalIn);
            marquerALDDecaisses(res.aldsTraites, res.adjId, stock.itemId);

            return {
                success: true,
                mode: 'confirm',
                message: 'Décaissage effectué',
                palletNumber: palletNumber,
                bin: stock.binText,
                qtyOut: stock.qty,
                qtyIn: res.totalIn,
                nbLots: alds.length,
                adjustmentId: res.adjId,
                warnings: validation.warnings
            };

        } catch (e) {
            var msg = (typeof e === 'string') ? e : (e.name + ' — ' + e.message);
            log.error('DECAISSAGE - erreur', msg);
            return { success: false, mode: mode, message: msg };
        }
    }

    return { post: post };
});
