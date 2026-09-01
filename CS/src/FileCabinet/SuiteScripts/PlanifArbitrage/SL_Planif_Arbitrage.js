/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 *
 * Planif Arbitrage - Séquencement et fractionnement des ordres planifiés.
 * Suitelet entry point / JSON router (pattern confirmé sur ce compte par
 * WOTree : GET rend une page HTML/CSS/JS autonome, POST est un petit routeur
 * JSON que le JS de la page appelle via fetch - pas de N/ui/serverWidget,
 * écarté explicitement en Annexe B.1 de la spec).
 *
 * Architecture :
 *   - SL_Planif_Arbitrage.js    -> ce fichier : entrée + routeur d'actions
 *   - Planif_Arbitrage_html.js  -> rend la page (CSS + JS client embarqués)
 *   - lib/planif_config.js      -> configuration via paramètres de script
 *   - lib/planif_dao.js         -> tout l'accès aux données plannedorder
 *
 * Actions POST :
 *   - listItems   : {} -> {levels[], levelsTodo[], lastRun}                (F1, F5)
 *   - listOrders  : {itemId, locationId} -> {item, orders[], components[]} (F2, F8)
 *   - applySplit  : {originalOrderId, itemId, locationId, lines[]} ->
 *                   {createdOrderIds[], quantityGap, alreadyApplied}       (F3, F9)
 *   - launch      : {} -> {launched, runTriggerId} | {launched:false, redirectUrl} (F6)
 */
define([
    'N/record',
    'N/format',
    'N/url',
    'N/runtime',
    'N/log',
    './lib/planif_config',
    './lib/planif_dao',
    './Planif_Arbitrage_html'
], function (record, format, url, runtime, log, config, dao, html) {

    function onRequest(context) {
        try {
            if (context.request.method === 'GET') {
                handleGet(context);
            } else {
                handlePost(context);
            }
        } catch (e) {
            log.error('Planif Arbitrage Suitelet ERROR', (e.name ? e.name + ': ' : '') + (e.message || String(e)));
            if (context.request.method === 'POST') {
                writeJson(context, { error: (e.name ? e.name + ': ' : '') + (e.message || String(e)) }, 500);
            } else {
                context.response.write('<h2>Erreur</h2><pre>' + escapeHtml(e.message || String(e)) + '</pre>');
            }
        }
    }

    // ---- GET : rendu de la page ------------------------------------------

    function handleGet(context) {
        var script = runtime.getCurrentScript();
        var suiteletUrl = url.resolveScript({
            scriptId: script.id,
            deploymentId: script.deploymentId,
            returnExternalUrl: false
        });

        var page = html.renderPage({ suiteletUrl: suiteletUrl });

        // Sans ces en-têtes, le navigateur peut resservir une version en
        // cache après redéploiement - deux planificateurs sur la même URL
        // pourraient se retrouver sur deux versions différentes de l'outil.
        context.response.setHeader({ name: 'Content-Type', value: 'text/html; charset=utf-8' });
        context.response.setHeader({ name: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' });
        context.response.setHeader({ name: 'Pragma', value: 'no-cache' });
        context.response.write(page);
    }

    function escapeHtml(s) {
        return String(s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    // ---- POST : routeur d'actions JSON ------------------------------------

    function handlePost(context) {
        var req = {};
        try {
            req = JSON.parse(context.request.body || '{}');
        } catch (e) {
            return writeJson(context, { error: 'Corps JSON invalide.' }, 400);
        }
        var action = req.action;
        var payload = req.payload || {};

        if (action === 'listSupplyPlans') {
            return writeJson(context, actionListSupplyPlans());
        }
        if (action === 'listItems') {
            return writeJson(context, actionListItems(payload));
        }
        if (action === 'listOrders') {
            return writeJson(context, actionListOrders(payload));
        }
        if (action === 'applySplit') {
            return writeJson(context, actionApplySplit(payload));
        }
        if (action === 'listJournal') {
            return writeJson(context, actionListJournal(payload));
        }
        return writeJson(context, { error: 'Action inconnue : ' + action }, 400);
    }

    // Un compte peut porter plusieurs Supply Plan Definition - l'écran en
    // propose la liste (voir actionListSupplyPlans) et le client renvoie
    // celle choisie dans chaque payload. Si absente (première charge), on
    // retombe sur custscript_planif_supply_plan_def_id.
    function resolveConfigForRequest(payload) {
        var cfg = config.getConfig();
        if (payload && payload.supplyPlanDefinitionId) {
            cfg.supplyPlanDefinitionId = payload.supplyPlanDefinitionId;
        }
        return cfg;
    }

    // ---- action: listSupplyPlans -------------------------------------

    function actionListSupplyPlans() {
        var cfg = config.getConfig();
        var plans = dao.listSupplyPlanDefinitions();
        if (!plans.length) {
            // Repli : au moins le plan configuré par défaut, pour que
            // l'écran reste utilisable si la liste des plans n'a pas pu
            // être lue (section 10 - non confirmé sur ce compte).
            plans = [{ id: cfg.supplyPlanDefinitionId, name: 'Plan ' + cfg.supplyPlanDefinitionId }];
        }
        return { plans: plans, defaultId: cfg.supplyPlanDefinitionId };
    }

    function writeJson(context, obj, status) {
        context.response.setHeader({ name: 'Content-Type', value: 'application/json; charset=utf-8' });
        if (status) {
            try { context.response.setHeader({ name: 'X-Status', value: String(status) }); } catch (e) { /* ignore */ }
        }
        context.response.write(JSON.stringify(obj));
    }

    // ---- action: listItems (F1, F5) ---------------------------------------
    //
    // Spec : F1 - « Chaque article indique le nombre de propositions en
    // attente d'arbitrage, ce qui fait du sélecteur la file de travail du
    // planificateur ». F5 - niveaux comportant encore des propositions non
    // arbitrées.

    function actionListItems(payload) {
        var cfg = resolveConfigForRequest(payload);
        var currentRun = dao.resolveCurrentRun(cfg);
        var summaries = currentRun.runId
            ? dao.listItemLocationSummaries(cfg, currentRun.runId)
            : [];

        var byLevel = {};
        summaries.forEach(function (s) {
            var levelInfo = config.levelForCode(s.itemCode, cfg);
            // Décision explicite : le sélecteur F1 n'affiche que les
            // produits finis (préfixe 7) - niveaux 5/3 non accessibles
            // depuis cet écran pour l'instant.
            if (levelInfo.level !== '7') {
                return;
            }
            if (!byLevel[levelInfo.level]) {
                byLevel[levelInfo.level] = { level: levelInfo.level, label: levelInfo.label, items: [] };
            }
            byLevel[levelInfo.level].items.push({
                itemId: s.itemId,
                code: s.itemCode,
                name: s.itemName,
                // Pour information au planificateur (F1), aucun rôle dans
                // le calcul ni dans les règles de gestion.
                tempsVac: s.tempsVac === null || s.tempsVac === undefined ? '' : s.tempsVac,
                tempsTerm: s.tempsTerm === null || s.tempsTerm === undefined ? '' : s.tempsTerm,
                locationId: s.locationId,
                location: s.locationName,
                kind: levelInfo.kind,
                pendingCount: s.pendingCount,
                // Section 5 : un article acheté (préfixe 1) est en
                // consultation seule, jamais arbitrable dans cet écran. Un
                // préfixe non reconnu ('unknown') est traité pareillement
                // par prudence tant qu'il n'a pas été classé - jamais
                // masqué, mais pas arbitrable non plus par défaut.
                badge: levelInfo.kind !== 'make' ? (levelInfo.kind === 'buy' ? 'buy' : 'other')
                    : (s.pendingCount > 0 ? 'todo' : 'done')
            });
        });

        // Ordre d'affichage : d'abord les niveaux arbitrables dans l'ordre
        // du cycle (RG3/RG4), puis tout niveau non listé dans cet ordre
        // (achat, ou préfixe inconnu) - jamais masqué (section 5).
        var orderedLevels = cfg.levelOrder.slice();
        Object.keys(byLevel).forEach(function (lvl) {
            if (orderedLevels.indexOf(lvl) === -1) {
                orderedLevels.push(lvl);
            }
        });

        var levels = orderedLevels
            .filter(function (lvl) { return byLevel[lvl]; })
            .map(function (lvl) { return byLevel[lvl]; });

        var levelsTodo = cfg.levelOrder.filter(function (lvl) {
            var group = byLevel[lvl];
            return group && group.items.some(function (i) { return i.kind === 'make' && i.pendingCount > 0; });
        });

        return {
            levels: levels,
            levelsTodo: levelsTodo,
            // Pas d'horodatage : `plannedorder` n'expose pas
            // lastmodifieddate (constaté sur sandbox, 2026-08-12 -
            // SSS_INVALID_SRCH_COL en recherche, "Unknown identifier" en
            // SuiteQL). Le "dernier calcul" se représente par le numéro de
            // run, seul identifiant fiable.
            lastRun: { runId: currentRun.runId },
            // F4 : nombre d'articles arbitrés PENDANT le run courant -
            // dérivé du journal (F9), pas d'un état navigateur qui se
            // perdrait à la fermeture de l'onglet. Se remet à zéro
            // naturellement dès qu'un recalcul fait avancer le run.
            arbitratedSinceRun: dao.countArbitratedItemsSinceRun(currentRun.runId)
        };
    }

    // ---- action: listOrders (F2, F8) ---------------------------------------

    function actionListOrders(payload) {
        var cfg = resolveConfigForRequest(payload);
        var itemId = payload.itemId;
        var locationId = payload.locationId;
        if (!itemId || !locationId) {
            return { error: 'itemId et locationId sont requis.' };
        }

        var currentRun = dao.resolveCurrentRun(cfg);
        var orders = currentRun.runId
            ? dao.listPlannedOrdersForItem(cfg, itemId, locationId, currentRun.runId)
            : [];
        var components = currentRun.runId
            ? dao.getComponentsProposals(cfg, itemId, locationId, currentRun.runId)
            : [];
        // Composants des composants (un niveau de plus, ex. niveau 3 depuis
        // un article niveau 7) - purement informatif, même logique que F8.
        var grandchildren = currentRun.runId
            ? dao.getGrandchildComponentsProposals(cfg, itemId, locationId, currentRun.runId)
            : [];
        // OF réels déjà créés dans NetSuite (workorder, distinct de
        // plannedorder) - demande utilisateur, vue seule, jamais rattaché
        // au run du plan (ce sont des transactions indépendantes).
        var realWorkOrders = dao.listRealWorkOrders(cfg, itemId, locationId);

        return {
            currentRunId: currentRun.runId,
            orders: orders.map(serializeOrder),
            realWorkOrders: realWorkOrders.map(function (wo) {
                return {
                    id: wo.id,
                    tranId: wo.tranId,
                    quantity: wo.quantity,
                    startDateIso: toIsoDate(wo.startDateIso),
                    endDateIso: toIsoDate(wo.endDateIso),
                    statusLabel: wo.statusText
                };
            }),
            components: components.map(function (c) { return serializeComponent(c, cfg); }),
            grandchildComponents: grandchildren.map(function (g) {
                var levelInfo = config.levelForCode(g.parentComponentCode, cfg);
                return {
                    parentComponentItemId: g.parentComponentItemId,
                    parentComponentCode: g.parentComponentCode,
                    parentLevel: levelInfo.level,
                    components: g.components.map(function (c) { return serializeComponent(c, cfg); })
                };
            })
        };
    }

    function serializeComponent(c, cfg) {
        var levelInfo = config.levelForCode(c.componentCode, cfg);
        return {
            componentItemId: c.componentItemId,
            componentCode: c.componentCode,
            level: levelInfo.level,
            orders: c.orders.map(serializeOrder),
            sourceRunId: c.sourceRunId,
            dataSource: c.dataSource
        };
    }

    function serializeOrder(o) {
        return {
            id: o.id,
            quantity: o.quantity,
            startDateIso: toIsoDate(o.startDateIso),
            endDateIso: toIsoDate(o.endDateIso),
            firmed: !!o.firmed,
            released: !!o.released,
            // Section A.1 : l'origine encode QUI a décidé, pas la gravité.
            originLabel: o.firmed ? 'human' : 'engine',
            // Statut dérivé de firmed/released (demande utilisateur) :
            // ni l'un ni l'autre -> proposition ; firmed seul -> ferme ;
            // firmed + released -> lancé.
            statusLabel: !o.firmed ? 'Proposition' : (o.released ? 'Lancé' : 'Ferme'),
            itemlocation: o.itemlocation,
            planningitemlocation: o.planningitemlocation,
            planningengineitemlocation: o.planningengineitemlocation,
            transactiontype: o.transactiontype
        };
    }

    // NetSuite renvoie les dates au format d'affichage du compte (ex.
    // JJ/MM/AAAA) - jamais de découpage manuel de chaîne (Annexe B.8),
    // toujours N/format dans les deux sens, transport en ISO en JSON.
    function toIsoDate(displayValue) {
        if (!displayValue) {
            return '';
        }
        try {
            var d = format.parse({ value: displayValue, type: format.Type.DATE });
            var y = d.getFullYear();
            var m = ('0' + (d.getMonth() + 1)).slice(-2);
            var day = ('0' + d.getDate()).slice(-2);
            return y + '-' + m + '-' + day;
        } catch (e) {
            return '';
        }
    }

    function parseIsoDateLocal(iso) {
        var parts = String(iso || '').split('-');
        if (parts.length !== 3) {
            return null;
        }
        return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    }

    // ---- action: applySplit (F3, F9) ---------------------------------------
    //
    // Contrôle du total réparti et des dates - signalement sans blocage.
    // Spec : F3, section 10 (sur-approvisionnement non signalé par le
    // moteur - la trace applicative au journal est le seul moyen de le
    // retrouver a posteriori).

    function actionApplySplit(payload) {
        var cfg = resolveConfigForRequest(payload);
        var originalOrderId = payload.originalOrderId;
        var itemId = payload.itemId;
        var locationId = payload.locationId;
        var lines = (payload.lines || [])
            .map(function (l) {
                // "Lancer" (case à cocher par ligne) pilote released sur la
                // commande planifiée créée - firmed reste toujours vrai
                // (section 9), released est désormais au choix du
                // planificateur ligne par ligne, plus systématique.
                return { quantity: parseFloat(l.quantity) || 0, startDate: parseIsoDateLocal(l.dateIso), release: l.release === true };
            })
            .filter(function (l) { return l.quantity > 0 && l.startDate; });

        if (!originalOrderId || !itemId || !locationId || !lines.length) {
            return { error: 'Paramètres invalides pour le fractionnement.' };
        }

        // Exception explicite au principe "aucun blocage" de F3 (demande
        // utilisateur, pas une règle de la spec d'origine) : une quantité
        // planifiée un dimanche est refusée. Revalidé ici même si le
        // client désactive déjà le bouton - jamais la seule barrière.
        if (lines.some(function (l) { return l.startDate.getDay() === 0; })) {
            return { error: 'Au moins une ligne planifie une quantité un dimanche - validation refusée.' };
        }

        var result = dao.applySplit(cfg, originalOrderId, lines);

        if (!result.alreadyApplied) {
            var user = runtime.getCurrentUser();
            var operation = 'Répartition en ' + lines.length + ' ligne(s) firmée(s)' +
                (result.quantityGap > 0.005 ? ' - sur-approvisionnement de ' + result.quantityGap
                    : (result.quantityGap < -0.005 ? ' - couverture partielle, reste ' + (-result.quantityGap) : ''));
            var journalId = dao.writeJournalEntry({
                userId: user.id,
                itemId: itemId,
                operation: operation,
                originalOrderId: originalOrderId,
                createdOrderIds: result.createdOrderIds,
                quantityGap: result.quantityGap,
                // Run actif au moment de l'écriture (voir dao.applySplit) -
                // permet à F4 de compter les arbitrages du run en cours
                // sans dépendre d'un horodatage.
                runId: result.runId
            });
            result.journalEntryId = journalId;
        }

        return result;
    }

    // F6 (relance du calcul) retiré : le recalcul MRP est déclenché
    // manuellement par le planificateur en dehors de cet écran, pas de
    // bouton ni d'action serveur pour ça.

    // ---- action: listJournal (F9) ------------------------------------

    function actionListJournal(payload) {
        return { entries: dao.listJournalEntries(payload.itemId || null, 100) };
    }

    return { onRequest: onRequest };
});
