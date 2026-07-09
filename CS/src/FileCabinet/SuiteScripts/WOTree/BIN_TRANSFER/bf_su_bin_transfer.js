/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 *
 * Bin Transfer Tool
 * Suitelet : entry point / routeur (5 onglets)
 *
 *   Onglet 1 (Transfert simple)  : 1 bin source -> contenu auto-charge
 *     -> coches + destination globale ou override -> 1 record bintransfer.
 *   Onglet 2 (Recherche article) : code/nom multi-mots -> tous les bins
 *     du stock -> coches + destinations -> 1 record bintransfer agrege.
 *   Onglet 3 (Swap)              : 2 bins meme entrepot -> echange croise
 *     en 1 seule transaction bintransfer.
 *   Onglet 4 (Bin prefere)       : config batch du bin de picking via
 *     record.load + sublist binnumber. Cleanup auto des anciennes asso
 *     sans stock + log identite des bins retires.
 *   Onglet 5 (Historique)        : liste des TOEs des N derniers jours
 *     toutes sources (Suitelet + UI native), filtres + tri colonnes,
 *     lignes depliables vers detail mouvements.
 *
 *   Backend : action `reconcile` conservee dans la lib + route Suitelet
 *   pour rollback eventuel mais plus exposee par l'UI courante.
 *
 * Version : 0.11.0 (2026-06-25) - ANONYMISATION + PORTABILITE
 *   - Retrait de toute reference de marque (3 fichiers). UI restylee
 *     (header ardoise + accent petrole, IBM Plex, en-tetes de tableau
 *     collants, focus-visible, prefers-reduced-motion).
 *   - resolveScript auto-reference via runtime.getCurrentScript()
 *     (scriptId / deploymentId) au lieu d'IDs en dur : ce fichier se
 *     deploie tel quel sur un autre compte, rien a editer.
 *   - Memo des TOE prefixe "Bin Tool" (detection historique compat
 *     "BF Tool" conservee pour ne pas reclasser les anciens transferts).
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
 *   Bandeau bt-help + commentaires d'en-tete refletent les 5 onglets.
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
 *
 * Architecture (3 fichiers) :
 *   - bf_su_bin_transfer.js     -> entry point (ce fichier)
 *   - bf_bin_transfer_lib.js    -> SuiteQL + record.create bintransfer
 *   - bf_bin_transfer_html.js   -> renderer HTML/CSS/JS de l'UI
 *
 * DEPLOIEMENT (a recreer sur chaque compte cible) :
 *   Placer les 3 fichiers dans le MEME dossier du File Cabinet (le nom
 *   du dossier est libre : les require sont relatifs en ./). Si SDF n'a
 *   pas cree l'objet Suitelet, le creer manuellement :
 *     Customization > Scripting > Scripts > New
 *     Type        : Suitelet
 *     Script ID   : customscript_bf_su_bin_transfer
 *     File        : <dossier>/bf_su_bin_transfer.js
 *   Deployment :
 *     ID          : customdeploy_bf_su_bin_transfer
 *     Run As      : Administrator
 *     Status      : Released
 *     Audience    : restreindre aux roles habilites. NB : le code ne fait
 *                   AUCUN controle de role ; l'audience du deploiement est
 *                   la seule barriere d'acces (cf. review).
 *   resolveScript etant auto-reference (runtime.getCurrentScript), aucun
 *   ID de script n'est code en dur dans ce fichier : rien a editer apres
 *   le deploiement.
 *
 * URL d'acces : depuis la fiche Script Deployment, copier le champ
 *   "External URL" (ou "URL") puis l'ouvrir.
 */
define([
    'N/log', 'N/url', 'N/runtime',
    './bf_bin_transfer_lib',
    './bf_bin_transfer_html'
],
function (log, url, runtime, lib, html) {

    function onRequest(context) {
        // Reset le buffer diagnostique a chaque request POST.
        if (context.request.method === 'POST') {
            try { lib.resetLogBuffer(); } catch (e0) {}
        }
        try {
            if (context.request.method === 'GET') {
                handleGet(context);
            } else {
                handlePost(context);
            }
        } catch (e) {
            var name    = e.name    || '';
            var message = e.message || String(e);
            var stack   = e.stack   || '';
            var pretty  = (name ? name + ': ' : '') + message;
            log.error({
                title:   'Bin Transfer Tool ERROR',
                details: JSON.stringify({
                    name: name, message: message,
                    stack: String(stack).substring(0, 2000)
                })
            });
            if (context.request.method === 'POST') {
                var errResp = {
                    error:   pretty,
                    name:    name,
                    message: message
                };
                try {
                    errResp.diag = lib.getLogBuffer();
                } catch (eDiag) {}
                writeJson(context, errResp, 500);
            } else {
                context.response.write('<h2>Erreur</h2><pre>' +
                    escapeHtml(pretty) + '</pre>');
            }
        }
    }

    /* ============================================================
     * GET : rendu UI
     * ============================================================ */
    function handleGet(context) {
        var bins = lib.loadBins();
        var locs = lib.loadLocations();
        // v0.11.0 - auto-reference : pas d'ID en dur, portable tel quel.
        var script = runtime.getCurrentScript();
        var suiteletUrl = url.resolveScript({
            scriptId:          script.id,
            deploymentId:      script.deploymentId,
            returnExternalUrl: false
        });

        var page = html.renderPage({
            suiteletUrl: suiteletUrl,
            bins:        bins,
            locations:   locs
        });
        context.response.setHeader({ name: 'Content-Type', value: 'text/html; charset=utf-8' });
        context.response.write(page);
    }

    /* ============================================================
     * POST : routes JSON
     *   { action: "<one of below>", payload: {...} }
     *
     *   Lecture / contenu :
     *     - binContents       : 1 bin -> {lines:[...]}
     *     - itemContents      : 1 article -> tous ses bins {lines:[...]}
     *     - searchItems       : autocomplete article -> {items:[...]}
     *     - reloadBins        : refresh badges vide/occupe -> {bins:[...]}
     *     - loadItemBinAssoc  : N items -> {assoc:{itemId:{prefBin,...}}}
     *
     *   Ecriture (creation TOE / modif item) :
     *     - transfer          : payload {locationId, memo, suffix, lines}
     *                           -> {id, ids, lineCount, errors, fallback?}
     *     - swap              : payload {binAId, binBId, memo}
     *                           -> {id, ...}
     *     - reconcile         : LEGACY (UI v0.5.x retiree, route conservee
     *                           pour rollback). payload {locationId, memo, lines}
     *     - setPreferredBin   : payload {updates:[{itemId,binId},...]}
     *                           -> {ok:[{itemId,removedBins[]}], errors:[...], diag}
     *
     *   Historique :
     *     - history           : payload {daysBack, locationId, q} -> {rows:[...]}
     *     - historyDetail     : payload {toeId} -> {moves:[...]}
     * ============================================================ */
    function handlePost(context) {
        var body = context.request.body || '';
        var req = {};
        try { req = JSON.parse(body); } catch (e) {
            return writeJson(context, { error: 'Body JSON invalide.' }, 400);
        }
        var action = req.action;
        var payload = req.payload || {};

        log.debug({
            title: 'Bin Transfer Tool POST',
            details: 'action=' + action + ' lines=' + ((payload.lines || []).length || 0)
        });

        if (action === 'binContents') {
            var lines = lib.loadBinContents(payload.binId);
            return writeJson(context, { lines: lines });
        }

        // v0.8.8 - rafraichir la liste des bins (badges vide/occupe)
        if (action === 'reloadBins') {
            var bins = lib.loadBins();
            return writeJson(context, { bins: bins });
        }

        // v0.4.0 : recherche d'article par code/nom
        if (action === 'searchItems') {
            var items = lib.searchItems(payload.q);
            return writeJson(context, { items: items });
        }

        // v0.4.0 : tous les emplacements d'un article
        if (action === 'itemContents') {
            var iLines = lib.loadItemContents(payload.itemId);
            return writeJson(context, { lines: iLines });
        }

        if (action === 'transfer') {
            var resT = lib.createBinTransfer(payload);
            return writeJson(context, resT);
        }

        if (action === 'swap') {
            var resS = lib.createSwap(payload.binAId, payload.binBId, null, payload.memo);
            return writeJson(context, resS);
        }

        if (action === 'reconcile') {
            var resR = lib.createReconciliation(payload);
            return writeJson(context, resR);
        }

        // v0.8.0 - historique
        if (action === 'history') {
            var hist = lib.loadHistory(payload || {});
            return writeJson(context, { rows: hist });
        }

        if (action === 'historyDetail') {
            var moves = lib.loadHistoryDetail(payload && payload.toeId);
            return writeJson(context, { moves: moves });
        }

        // v0.10.0 - configuration bin prefere (mode 4)
        if (action === 'loadItemBinAssoc') {
            var assoc = lib.loadItemBinAssociations(payload && payload.itemIds);
            return writeJson(context, { assoc: assoc });
        }

        if (action === 'setPreferredBin') {
            var resPB = lib.setPreferredBinForItems(payload && payload.updates);
            // v0.10.1 - inclure le diag buffer pour faciliter le debug cote UI
            try { resPB.diag = lib.getLogBuffer(); } catch (eD) {}
            return writeJson(context, resPB);
        }

        return writeJson(context, { error: 'Action inconnue: ' + action }, 400);
    }

    /* ============================================================
     * helpers
     * ============================================================ */
    function writeJson(context, obj, status) {
        context.response.setHeader({ name: 'Content-Type', value: 'application/json; charset=utf-8' });
        if (status) {
            try { context.response.setHeader({ name: 'X-Status', value: String(status) }); } catch (e) {}
        }
        context.response.write(JSON.stringify(obj));
    }

    function escapeHtml(s) {
        return String(s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    return { onRequest: onRequest };
});