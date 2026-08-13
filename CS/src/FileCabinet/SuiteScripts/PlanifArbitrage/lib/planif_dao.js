/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 *
 * Planif Arbitrage - data access module. Every read against `plannedorder`
 * tries SuiteQL first (one call regardless of volume, per spec Annexe B.4)
 * and falls back to N/search if the table name/columns don't resolve on
 * this account - the table name is UNCONFIRMED, isolated in one constant
 * below so a wrong guess is a one-line fix (spec section 10).
 *
 * Field names on `plannedorder` are taken from a real record dump (id 1912,
 * via NetSuite Field Explorer): item, location, itemlocation,
 * transactiontype, quantity, startdate, enddate, firmed, released,
 * plannedorderstatus, planningordertype, planningitemlocation,
 * planningengineitemlocation, supplyplandefinition, supplyplanningrun,
 * tobeexpedited, customform. Confirmed accessible via standard
 * record/search (spec section 9) - N/ui/serverWidget sublists are not used.
 *
 * Run numbering (confirmed with the user, 2026-08-12): every MRP relaunch
 * re-stamps `supplyplanningrun` on ALL affected planned orders, firmed or
 * not. Filtering by the CURRENT run of the Supply Plan Definition is
 * therefore safe for both firmed and unfirmed rows - never cache a run
 * number, always resolve it per request via resolveCurrentRun().
 */
define(['N/query', 'N/search', 'N/record', 'N/log'], function (query, search, record, log) {

    var MAX_RESULTS_PER_SEARCH = 4000;

    // Whether SuiteQL against PLANNEDORDER_TABLE has been confirmed to work
    // this request - avoids re-attempting (and re-throwing) SuiteQL for
    // every single call once it's known to fail on this account.
    var suiteQlAvailable = null;

    function plannedOrderTable(config) {
        // UNCONFIRMED - test on sandbox; this is the only line to change if
        // SuiteQL rejects the table name (see custscript_planif_plannedorder_table).
        return config.plannedOrderTable || 'plannedorder';
    }

    // ---- sélection du plan d'approvisionnement -------------------------
    //
    // Un compte peut porter plusieurs Supply Plan Definition (spec limitée
    // à 729922, mais l'écran doit rester utilisable si le planificateur en
    // a plusieurs) - l'écran propose donc un sélecteur plutôt qu'un id figé
    // en paramètre. Non confirmé sur sandbox (record type 'supplyplandefinition'
    // recherchable/interrogeable) - repli sur le seul id configuré si ni
    // SuiteQL ni N/search ne fonctionnent, pour que l'écran reste utilisable.

    function listSupplyPlanDefinitions() {
        try {
            return listSupplyPlanDefinitions_SuiteQL();
        } catch (e) {
            log.error('planif_dao - listSupplyPlanDefinitions SuiteQL failed, falling back to N/search', e.message);
            try {
                return listSupplyPlanDefinitions_Search();
            } catch (e2) {
                log.error('planif_dao - listSupplyPlanDefinitions N/search failed too', e2.message);
                return [];
            }
        }
    }

    function listSupplyPlanDefinitions_SuiteQL() {
        var rs = query.runSuiteQL({ query: 'SELECT id, name FROM supplyplandefinition ORDER BY name' }).asMappedResults();
        suiteQlAvailable = true;
        return rs.map(function (row) { return { id: row.id, name: row.name || ('Plan ' + row.id) }; });
    }

    function listSupplyPlanDefinitions_Search() {
        var rows = [];
        search.create({
            type: 'supplyplandefinition',
            columns: ['name']
        }).run().each(function (result) {
            rows.push({ id: result.id, name: result.getValue({ name: 'name' }) || ('Plan ' + result.id) });
            return true;
        });
        return rows;
    }

    // ---- run resolution ----------------------------------------------

    function resolveCurrentRun(config) {
        try {
            return resolveCurrentRun_SuiteQL(config);
        } catch (e) {
            log.error('planif_dao - resolveCurrentRun SuiteQL failed, falling back to N/search', e.message);
            return resolveCurrentRun_Search(config);
        }
    }

    // Pas d'horodatage : `plannedorder` n'expose pas `lastmodifieddate`
    // (constaté sur sandbox le 2026-08-12 - SSS_INVALID_SRCH_COL en
    // recherche, "Unknown identifier" en SuiteQL - probablement parce que
    // ce record est régénéré en bloc par le moteur, pas "modifié" au sens
    // classique). Seul `supplyplanningrun` est fiable ; le "dernier calcul"
    // se représente par ce numéro de run, jamais par une date.

    function resolveCurrentRun_SuiteQL(config) {
        var sql = 'SELECT MAX(TO_NUMBER(supplyplanningrun)) AS runid ' +
            'FROM ' + plannedOrderTable(config) + ' ' +
            'WHERE supplyplandefinition = ?';
        var rs = query.runSuiteQL({ query: sql, params: [config.supplyPlanDefinitionId] }).asMappedResults();
        suiteQlAvailable = true;
        if (!rs.length || rs[0].runid === null || rs[0].runid === undefined) {
            return { runId: null };
        }
        return { runId: String(rs[0].runid) };
    }

    function resolveCurrentRun_Search(config) {
        // Agrégé en JS plutôt que via un tri de recherche sur
        // supplyplanningrun : ce champ n'est pas garanti trié numériquement
        // par un search.Sort (texte "9" > "10") - Math.max côté serveur est
        // fiable indépendamment du type de stockage réel du champ.
        var runIds = [];
        search.create({
            type: 'plannedorder',
            filters: [
                search.createFilter({ name: 'supplyplandefinition', operator: search.Operator.ANYOF, values: [config.supplyPlanDefinitionId] })
            ],
            columns: [
                search.createColumn({ name: 'supplyplanningrun', summary: search.Summary.GROUP })
            ]
        }).run().each(function (result) {
            var v = result.getValue({ name: 'supplyplanningrun', summary: search.Summary.GROUP });
            if (v) {
                runIds.push(v);
            }
            return true;
        });
        if (!runIds.length) {
            return { runId: null };
        }
        var maxRunId = runIds.reduce(function (a, b) { return parseInt(b, 10) > parseInt(a, 10) ? b : a; });
        return { runId: maxRunId };
    }

    // ---- F1 : listItems support -----------------------------------------
    // Distinct item/location pairs present in plannedorder for the current
    // run, with a count of unfirmed ("pending arbitration") rows per pair.

    function listItemLocationSummaries(config, currentRunId) {
        try {
            return listItemLocationSummaries_SuiteQL(config, currentRunId);
        } catch (e) {
            log.error('planif_dao - listItemLocationSummaries SuiteQL failed, falling back to N/search', e.message);
            return listItemLocationSummaries_Search(config, currentRunId);
        }
    }

    function listItemLocationSummaries_SuiteQL(config, currentRunId) {
        // custitem_ax_temps_vac / custitem_ax_temps_term : affichés en
        // information pour le planificateur dans le sélecteur F1 (Temps
        // VAC / Temps TERM), aucun rôle dans le calcul.
        var sql = 'SELECT po.item AS itemid, i.itemid AS itemcode, i.displayname AS itemname, ' +
            'i.custitem_ax_temps_vac AS tempsvac, i.custitem_ax_temps_term AS tempsterm, ' +
            'po.location AS locationid, l.name AS locationname, ' +
            'SUM(CASE WHEN po.firmed = \'F\' THEN 1 ELSE 0 END) AS pendingcount ' +
            'FROM ' + plannedOrderTable(config) + ' po ' +
            'JOIN item i ON i.id = po.item ' +
            'JOIN location l ON l.id = po.location ' +
            'WHERE po.supplyplandefinition = ? AND po.supplyplanningrun = ? ' +
            'GROUP BY po.item, i.itemid, i.displayname, i.custitem_ax_temps_vac, i.custitem_ax_temps_term, po.location, l.name';
        var rs = query.runSuiteQL({ query: sql, params: [config.supplyPlanDefinitionId, currentRunId] }).asMappedResults();
        suiteQlAvailable = true;
        return rs.map(function (row) {
            return {
                itemId: row.itemid,
                itemCode: row.itemcode,
                itemName: row.itemname || '',
                tempsVac: row.tempsvac,
                tempsTerm: row.tempsterm,
                locationId: row.locationid,
                locationName: row.locationname || '',
                pendingCount: parseInt(row.pendingcount, 10) || 0
            };
        });
    }

    function listItemLocationSummaries_Search(config, currentRunId) {
        // Jointure 'item' reprise du join id confirmé sur ce compte pour
        // WOTree (custscript_wo_item_join_id, valeur 'item') - pas
        // re-vérifiée spécifiquement depuis une recherche plannedorder,
        // mais c'est le même schéma de champ article. Si le libellé/temps
        // reviennent vides ici, c'est le premier point à vérifier.
        var byKey = {};
        search.create({
            type: 'plannedorder',
            filters: [
                search.createFilter({ name: 'supplyplandefinition', operator: search.Operator.ANYOF, values: [config.supplyPlanDefinitionId] }),
                search.createFilter({ name: 'supplyplanningrun', operator: search.Operator.ANYOF, values: [currentRunId] })
            ],
            columns: [
                search.createColumn({ name: 'item' }),
                search.createColumn({ name: 'displayname', join: 'item' }),
                search.createColumn({ name: 'custitem_ax_temps_vac', join: 'item' }),
                search.createColumn({ name: 'custitem_ax_temps_term', join: 'item' }),
                search.createColumn({ name: 'location' }),
                search.createColumn({ name: 'firmed' })
            ]
        }).run().each(function (result) {
            var itemId = result.getValue({ name: 'item' });
            var locationId = result.getValue({ name: 'location' });
            var key = itemId + '|' + locationId;
            if (!byKey[key]) {
                byKey[key] = {
                    itemId: itemId,
                    itemCode: result.getText({ name: 'item' }) || '',
                    itemName: result.getValue({ name: 'displayname', join: 'item' }) || '',
                    tempsVac: result.getValue({ name: 'custitem_ax_temps_vac', join: 'item' }),
                    tempsTerm: result.getValue({ name: 'custitem_ax_temps_term', join: 'item' }),
                    locationId: locationId,
                    locationName: result.getText({ name: 'location' }) || '',
                    pendingCount: 0
                };
            }
            if (result.getValue({ name: 'firmed' }) === false) {
                byKey[key].pendingCount++;
            }
            return true;
        });
        return Object.keys(byKey).map(function (k) { return byKey[k]; });
    }

    // ---- F2/F8 : listOrders support --------------------------------------

    function listPlannedOrdersForItem(config, itemId, locationId, currentRunId) {
        try {
            return listPlannedOrdersForItem_SuiteQL(config, itemId, locationId, currentRunId);
        } catch (e) {
            log.error('planif_dao - listPlannedOrdersForItem SuiteQL failed, falling back to N/search', e.message);
            return listPlannedOrdersForItem_Search(config, itemId, locationId, currentRunId);
        }
    }

    function orderColumns() {
        return 'id, item, location, itemlocation, transactiontype, quantity, startdate, enddate, ' +
            'firmed, released, plannedorderstatus, planningordertype, planningitemlocation, ' +
            'planningengineitemlocation, supplyplandefinition, supplyplanningrun';
    }

    function listPlannedOrdersForItem_SuiteQL(config, itemId, locationId, currentRunId) {
        var sql = 'SELECT ' + orderColumns() + ' FROM ' + plannedOrderTable(config) + ' ' +
            'WHERE item = ? AND location = ? AND supplyplandefinition = ? AND supplyplanningrun = ?';
        var rs = query.runSuiteQL({
            query: sql,
            params: [itemId, locationId, config.supplyPlanDefinitionId, currentRunId]
        }).asMappedResults();
        suiteQlAvailable = true;
        return rs.map(mapSuiteQlOrderRow);
    }

    function mapSuiteQlOrderRow(row) {
        return {
            id: row.id,
            item: row.item,
            location: row.location,
            itemlocation: row.itemlocation,
            transactiontype: row.transactiontype,
            quantity: parseFloat(row.quantity) || 0,
            startDateIso: row.startdate,
            endDateIso: row.enddate,
            firmed: row.firmed === 'T' || row.firmed === true,
            released: row.released === 'T' || row.released === true,
            planningordertype: row.planningordertype,
            planningitemlocation: row.planningitemlocation,
            planningengineitemlocation: row.planningengineitemlocation,
            supplyplandefinition: row.supplyplandefinition,
            supplyplanningrun: row.supplyplanningrun
        };
    }

    function listPlannedOrdersForItem_Search(config, itemId, locationId, currentRunId) {
        var rows = [];
        search.create({
            type: 'plannedorder',
            filters: [
                search.createFilter({ name: 'item', operator: search.Operator.ANYOF, values: [itemId] }),
                search.createFilter({ name: 'location', operator: search.Operator.ANYOF, values: [locationId] }),
                search.createFilter({ name: 'supplyplandefinition', operator: search.Operator.ANYOF, values: [config.supplyPlanDefinitionId] }),
                search.createFilter({ name: 'supplyplanningrun', operator: search.Operator.ANYOF, values: [currentRunId] })
            ],
            columns: [
                'internalid', 'item', 'location', 'itemlocation', 'transactiontype', 'quantity',
                'startdate', 'enddate', 'firmed', 'released', 'planningordertype',
                'planningitemlocation', 'planningengineitemlocation', 'supplyplandefinition', 'supplyplanningrun'
            ]
        }).run().each(function (result) {
            rows.push(mapSearchOrderRow(result));
            return rows.length < MAX_RESULTS_PER_SEARCH;
        });
        return rows;
    }

    function mapSearchOrderRow(result) {
        return {
            id: result.getValue({ name: 'internalid' }),
            item: result.getValue({ name: 'item' }),
            location: result.getValue({ name: 'location' }),
            itemlocation: result.getValue({ name: 'itemlocation' }),
            transactiontype: result.getValue({ name: 'transactiontype' }),
            quantity: parseFloat(result.getValue({ name: 'quantity' })) || 0,
            startDateIso: result.getValue({ name: 'startdate' }),
            endDateIso: result.getValue({ name: 'enddate' }),
            firmed: result.getValue({ name: 'firmed' }) === true,
            released: result.getValue({ name: 'released' }) === true,
            planningordertype: result.getValue({ name: 'planningordertype' }),
            planningitemlocation: result.getValue({ name: 'planningitemlocation' }),
            planningengineitemlocation: result.getValue({ name: 'planningengineitemlocation' }),
            supplyplandefinition: result.getValue({ name: 'supplyplandefinition' }),
            supplyplanningrun: result.getValue({ name: 'supplyplanningrun' })
        };
    }

    // F8 - direct components of itemId, pegging preferred, date-window
    // fallback. Both paths are UNVERIFIED against a live account (spec
    // section 10) - dataSource is always returned so the UI never silently
    // presents an approximation as certain.

    // Constaté via NetSuite Field Explorer (2026-08-13) sur un BOM et une
    // BOM Revision réels :
    //   - record `bom` : sous-liste "assembly" reliant l'article (champ
    //     `assembly`, ex. "15572") - et l'emplacement d'après l'utilisateur -
    //     à ce BOM, avec un indicateur `masterdefault`.
    //   - record `bomrevision` : champ corps `billofmaterials` (id du BOM
    //     parent), sous-liste "component" portant les lignes de composants.
    // Tentatives précédentes (bom/bomrevision/bomrevisioncomponent comme
    // types de recherche indépendants, puis sous-liste "member" de
    // l'article lui-même) invalides sur ce compte - remplacées ici par ce
    // schéma confirmé.

    // Le nom exact du champ "emplacement" dans la sous-liste assembly n'est
    // pas confirmé - tenté en premier, puis repli sans lui si la recherche
    // échoue (variante invalide plutôt que 0 résultat silencieux).
    // 'assembly'/'location'/'masterdefault' sont des champs de la sous-liste
    // "assembly" du BOM (constaté : "Malformed search filter expression" en
    // filtre direct) - ils doivent être atteints via une jointure explicite
    // dont le nom n'est pas confirmé. 'assembly' est tenté en premier
    // (nom de la sous-liste elle-même, cas le plus courant en N/search),
    // avant un repli sur 'assemblyitem'.
    function resolveBomId(itemId, locationId) {
        // Pas de filtre sur l'emplacement : le champ n'est pas toujours
        // renseigné sur la ligne "assembly" (BOM disponible pour tous les
        // emplacements) - filtrer dessus exclurait à tort ces BOM. locationId
        // n'est donc plus utilisé ici - conservé dans la signature pour ne
        // pas changer l'appelant, et parce qu'il reste pertinent en aval
        // (lecture des plannedorder du composant, elle bien scopée par
        // emplacement).
        //
        // Confirmé via le générateur de recherche NetSuite (UI) : le champ
        // se filtre en notation "join.champ" dans le filtre plat -
        // "assemblyitem.assembly" - ni "assembly" seul, ni une jointure
        // explicite {name:'internalid', join:'assemblyitem'} ne
        // fonctionnaient ; c'est la chaîne composée qu'il fallait.
        var ids = [];
        try {
            search.create({
                type: 'bom',
                filters: [['isinactive', 'is', 'F'], ['assemblyitem.assembly', 'anyof', itemId]],
                columns: [search.createColumn({ name: 'internalid' })]
            }).run().each(function (result) {
                ids.push(result.getValue({ name: 'internalid' }));
                return true;
            });
        } catch (e) {
            log.error('planif_dao - resolveBomId failed', 'itemId=' + itemId + ' : ' + e.message);
            return null;
        }
        if (!ids.length) {
            return null;
        }
        if (ids.length > 1) {
            log.audit('planif_dao - resolveBomId : plusieurs BOM trouvés, le premier est retenu',
                'itemId=' + itemId + ' ids=' + ids.join(','));
        }
        return ids[0];
    }

    // Révision active la plus récente (par date d'effet) pour ce BOM - la
    // gestion fine de la date d'effet courante (vs. une révision future
    // déjà créée) n'est pas approfondie ici, première version.
    function resolveActiveBomRevisionId(bomId) {
        var revisionId = null;
        try {
            // Confirmé via le générateur de recherche NetSuite (UI) : comme
            // pour resolveBomId, un filtre plat sur le champ lui-même
            // ('billofmaterials') ne suffit pas - il faut la forme
            // "billofmaterials.internalidnumber" avec l'opérateur equalto.
            search.create({
                type: 'bomrevision',
                filters: [['billofmaterials.internalidnumber', 'equalto', bomId], ['isinactive', 'is', 'F']],
                columns: [
                    search.createColumn({ name: 'internalid' }),
                    search.createColumn({ name: 'effectivestartdate', sort: search.Sort.DESC })
                ]
            }).run().each(function (result) {
                revisionId = result.getValue({ name: 'internalid' });
                return false; // le plus récent d'abord (tri desc)
            });
        } catch (e) {
            log.error('planif_dao - resolveActiveBomRevisionId failed', 'bomId=' + bomId + ' : ' + e.message);
        }
        return revisionId;
    }

    function readComponentsFromBomRevision(revisionId) {
        var componentIds = [];
        try {
            var rev = record.load({ type: 'bomrevision', id: revisionId });
            var lineCount = rev.getLineCount({ sublistId: 'component' });
            for (var i = 0; i < lineCount; i++) {
                var componentItemId = rev.getSublistValue({ sublistId: 'component', fieldId: 'item', line: i });
                if (componentItemId) {
                    componentIds.push(componentItemId);
                }
            }
            if (lineCount && !componentIds.length) {
                // Le champ 'item' ne renvoie rien alors qu'il y a des
                // lignes : journalise les ids de champ réellement
                // disponibles pour corriger sans deviner à nouveau.
                try {
                    log.audit('planif_dao - sous-liste "component" : champs disponibles',
                        JSON.stringify(rev.getSublistFields({ sublistId: 'component' })));
                } catch (e2) { /* diagnostic seulement */ }
            }
            log.audit('planif_dao - readComponentsFromBomRevision',
                'revisionId=' + revisionId + ' lignes=' + lineCount + ' composants résolus=' + componentIds.length);
        } catch (e) {
            log.error('planif_dao - readComponentsFromBomRevision failed', 'revisionId=' + revisionId + ' : ' + e.message);
        }
        return componentIds;
    }

    function getDirectComponents(itemId, locationId) {
        var bomId = resolveBomId(itemId, locationId);
        if (!bomId) {
            log.audit('planif_dao - getDirectComponents : aucun BOM trouvé', 'itemId=' + itemId + ' locationId=' + locationId);
            return [];
        }
        var revisionId = resolveActiveBomRevisionId(bomId);
        if (!revisionId) {
            log.audit('planif_dao - getDirectComponents : aucune révision active', 'bomId=' + bomId);
            return [];
        }
        var componentIds = readComponentsFromBomRevision(revisionId);
        if (!componentIds.length) {
            return [];
        }
        var codesById = resolveItemCodes(componentIds);
        return componentIds.map(function (id) {
            return { componentItemId: id, componentCode: codesById[id] || '' };
        });
    }

    function resolveItemCodes(itemIds) {
        var codes = {};
        search.create({
            type: search.Type.ITEM,
            filters: [['internalid', 'anyof', itemIds]],
            columns: ['itemid']
        }).run().each(function (result) {
            codes[result.id] = result.getValue({ name: 'itemid' }) || '';
            return true;
        });
        return codes;
    }

    function getComponentsProposals(config, itemId, locationId, currentRunId) {
        var components = getDirectComponents(itemId, locationId);
        var usePegging = config.usePegging;
        return components.map(function (comp) {
            var result = usePegging
                ? getComponentOrders_Pegging(config, comp.componentItemId, locationId, currentRunId)
                : null;
            if (!result) {
                result = getComponentOrders_Window(config, comp.componentItemId, locationId, currentRunId);
            }
            return {
                componentItemId: comp.componentItemId,
                componentCode: comp.componentCode,
                orders: result.orders,
                sourceRunId: currentRunId,
                dataSource: result.dataSource
            };
        });
    }

    // Pegging linkage fields on plannedorder are UNCONFIRMED - this is a
    // placeholder using the same table, filtered by component item only
    // (no known pegging join yet). Returns null (not an empty array) when
    // it can't produce a pegging-based answer, so the caller falls back
    // to the window method rather than reporting a false empty result.
    function getComponentOrders_Pegging(config, componentItemId, locationId, currentRunId) {
        try {
            var orders = listPlannedOrdersForItem(config, componentItemId, locationId, currentRunId);
            // TODO(sandbox): replace with a real pegging join once the
            // linkage field/table is confirmed (spec section 10).
            return { orders: orders, dataSource: 'pegging' };
        } catch (e) {
            log.error('planif_dao - getComponentOrders_Pegging failed', e.message);
            return null;
        }
    }

    // Documented-inexact fallback (spec section 10): filters the
    // component's own proposals by item/location/current run only, with no
    // date window narrowing yet (a component shared across several parent
    // items will show ALL of its proposals, not just the ones driven by
    // this particular parent).
    function getComponentOrders_Window(config, componentItemId, locationId, currentRunId) {
        var orders = listPlannedOrdersForItem(config, componentItemId, locationId, currentRunId);
        return { orders: orders, dataSource: 'fallback-window' };
    }

    // ---- F3 : applySplit (write) ------------------------------------------
    //
    // Order confirmed with the user (deliberate deviation from the spec's
    // literal "delete then create" wording): CREATE every replacement line
    // first, and only DELETE the original once every creation is confirmed.
    // A failure mid-batch rolls back the creations already made and leaves
    // the original untouched - never a deleted original with no complete
    // replacement (an invisible supply hole). If the final delete itself
    // fails, the created lines are kept (a visible, journalable duplicate
    // is safer than losing the created supply) and the caller is told via
    // originalDeleteFailed so it can be flagged in the journal (F9).

    function applySplit(config, originalOrderId, lines) {
        var original = loadOrderForWrite(config, originalOrderId);
        if (!original) {
            return { createdOrderIds: [], quantityGap: 0, alreadyApplied: true, originalDeleteFailed: false };
        }

        var created = [];
        try {
            lines.forEach(function (line) {
                created.push(createFirmedPlannedOrder(original, line));
            });
        } catch (e) {
            rollbackCreated(created);
            throw e;
        }

        var originalDeleteFailed = false;
        try {
            record.delete({ type: 'plannedorder', id: originalOrderId });
        } catch (e) {
            log.error('planif_dao - failed to delete original plannedorder ' + originalOrderId +
                ' after creating replacements ' + JSON.stringify(created), e.message);
            originalDeleteFailed = true;
        }

        var totalCreated = lines.reduce(function (sum, l) { return sum + (parseFloat(l.quantity) || 0); }, 0);
        var quantityGap = Math.round((totalCreated - original.quantity) * 100000) / 100000;

        return {
            createdOrderIds: created,
            quantityGap: quantityGap,
            alreadyApplied: false,
            originalDeleteFailed: originalDeleteFailed,
            // Run actif au moment de l'écriture (copié depuis l'origine,
            // jamais résolu à part - voir createFirmedPlannedOrder) : sert à
            // dater l'entrée de journal en termes de run plutôt que de
            // timestamp, `plannedorder` n'exposant pas lastmodifieddate.
            runId: original.supplyplanningrun
        };
    }

    // Re-loads the original by id right before writing - if it no longer
    // exists, a prior call already replaced it (idempotency: the client may
    // have retried after a network failure that actually succeeded
    // server-side). Returns null in that case, never throws.
    function loadOrderForWrite(config, originalOrderId) {
        try {
            var rec = record.load({ type: 'plannedorder', id: originalOrderId });
            return {
                id: originalOrderId,
                item: rec.getValue({ fieldId: 'item' }),
                location: rec.getValue({ fieldId: 'location' }),
                itemlocation: rec.getValue({ fieldId: 'itemlocation' }),
                transactiontype: rec.getValue({ fieldId: 'transactiontype' }),
                quantity: parseFloat(rec.getValue({ fieldId: 'quantity' })) || 0,
                planningitemlocation: rec.getValue({ fieldId: 'planningitemlocation' }),
                planningengineitemlocation: rec.getValue({ fieldId: 'planningengineitemlocation' }),
                supplyplandefinition: rec.getValue({ fieldId: 'supplyplandefinition' }),
                supplyplanningrun: rec.getValue({ fieldId: 'supplyplanningrun' })
            };
        } catch (e) {
            return null; // already deleted/replaced - alreadyApplied path
        }
    }

    // The three linkage fields are copied from the original being replaced,
    // never resolved from scratch - spec Annexe B.4: "ne sont pas devinables
    // pour un couple article / emplacement donné".
    // Ordre d'essai des combinaisons de `defaultValues` pour l'initialisation
    // de plannedorder - du sous-ensemble le plus proche du texte littéral de
    // la spec (section 9) au plus complet. Deux erreurs déjà observées sur
    // sandbox : PLANNED_ORDERS_CAN_ONLY_BE_MANUALLY_CREATED_FROM_THE_PLANNING_WORKBENCH
    // sans defaultValues du tout, puis INVALID_RCRD_INITIALIZE avec les 9
    // champs copiés de l'origine (au moins un n'est pas un paramètre
    // d'initialisation valide pour ce type). Auto-diagnostic plutôt qu'une
    // nouvelle supposition à l'aveugle : la première variante qui passe
    // l'initialisation est utilisée, et journalisée (log.audit) pour qu'on
    // puisse ensuite figer le code sur elle une fois confirmée.
    function defaultValuesVariants(original) {
        var base = {
            supplyplandefinition: original.supplyplandefinition,
            supplyplanningrun: original.supplyplanningrun,
            firmed: 'T'
        };
        return [
            { label: 'minimal (spec section 9 littérale)', values: base },
            { label: '+ item/location', values: Object.assign({}, base, {
                item: original.item, location: original.location
            }) },
            { label: '+ itemlocation', values: Object.assign({}, base, {
                item: original.item, location: original.location, itemlocation: original.itemlocation
            }) },
            { label: '+ transactiontype', values: Object.assign({}, base, {
                item: original.item, location: original.location, itemlocation: original.itemlocation,
                transactiontype: original.transactiontype
            }) }
        ];
    }

    function initializePlannedOrder(original) {
        var variants = defaultValuesVariants(original);
        var errors = [];
        for (var i = 0; i < variants.length; i++) {
            try {
                var rec = record.create({ type: 'plannedorder', isDynamic: false, defaultValues: variants[i].values });
                log.audit('planif_dao - createFirmedPlannedOrder : variante defaultValues retenue', variants[i].label);
                return rec;
            } catch (e) {
                errors.push(variants[i].label + ' : ' + (e.name ? e.name + ' - ' : '') + e.message);
            }
        }
        log.error('planif_dao - toutes les variantes defaultValues ont échoué', errors.join(' | '));
        throw new Error('Initialisation de plannedorder impossible (' + variants.length + ' variantes testées) : ' + errors.join(' | '));
    }

    function createFirmedPlannedOrder(original, line) {
        var rec = initializePlannedOrder(original);
        rec.setValue({ fieldId: 'item', value: original.item });
        rec.setValue({ fieldId: 'location', value: original.location });
        rec.setValue({ fieldId: 'itemlocation', value: original.itemlocation });
        rec.setValue({ fieldId: 'transactiontype', value: original.transactiontype });
        rec.setValue({ fieldId: 'planningitemlocation', value: original.planningitemlocation });
        rec.setValue({ fieldId: 'planningengineitemlocation', value: original.planningengineitemlocation });
        rec.setValue({ fieldId: 'quantity', value: line.quantity });
        rec.setValue({ fieldId: 'startdate', value: line.startDate });
        rec.setValue({ fieldId: 'enddate', value: line.startDate });
        return rec.save();
    }

    function rollbackCreated(createdIds) {
        createdIds.forEach(function (id) {
            try {
                record.delete({ type: 'plannedorder', id: id });
            } catch (e) {
                log.error('planif_dao - rollback failed to delete created plannedorder ' + id, e.message);
            }
        });
    }

    // ---- F4 : arbitrages en attente de recalcul ---------------------------
    //
    // Ce qui est "en attente" n'est pas l'enregistrement (chaque arbitrage
    // est firmé immédiatement, section F4) mais la PROPAGATION vers les
    // niveaux inférieurs, qui n'a lieu qu'au recalcul. On le dérive du
    // journal (F9) plutôt que d'un état côté navigateur (qui se perdrait à
    // la fermeture de l'onglet - c'est exactement le risque que F4 doit
    // couvrir) : nombre d'articles distincts arbitrés PENDANT le run
    // actuellement en cours (custrecord_planif_journal_run === currentRunId).
    // Basé sur le run plutôt que sur un horodatage - `plannedorder` n'expose
    // pas lastmodifieddate (constaté sur sandbox). Un recalcul (F6) fait
    // avancer supplyplanningrun sur toutes les commandes, y compris
    // firmées : les entrées de journal d'un run antérieur ne comptent donc
    // plus une fois le recalcul effectué - remise à zéro naturelle.

    function countArbitratedItemsSinceRun(currentRunId) {
        try {
            var filters = [];
            if (currentRunId) {
                filters.push(search.createFilter({ name: 'custrecord_planif_journal_run', operator: search.Operator.IS, values: [currentRunId] }));
            }
            var count = 0;
            search.create({
                type: 'customrecord_planif_journal',
                filters: filters,
                columns: [search.createColumn({ name: 'custrecord_planif_journal_item', summary: search.Summary.GROUP })]
            }).run().each(function () {
                count++;
                return true;
            });
            return count;
        } catch (e) {
            log.error('planif_dao - countArbitratedItemsSinceRun failed', e.message);
            return 0;
        }
    }

    // ---- F9 : journal ------------------------------------------------

    function writeJournalEntry(entry) {
        try {
            var rec = record.create({ type: 'customrecord_planif_journal', isDynamic: false });
            rec.setValue({ fieldId: 'custrecord_planif_journal_user', value: entry.userId });
            rec.setValue({ fieldId: 'custrecord_planif_journal_item', value: entry.itemId });
            rec.setValue({ fieldId: 'custrecord_planif_journal_op', value: entry.operation });
            rec.setValue({ fieldId: 'custrecord_planif_journal_origin', value: entry.originalOrderId || '' });
            rec.setValue({ fieldId: 'custrecord_planif_journal_created', value: JSON.stringify(entry.createdOrderIds || []) });
            rec.setValue({ fieldId: 'custrecord_planif_journal_gap', value: entry.quantityGap || 0 });
            rec.setValue({ fieldId: 'custrecord_planif_journal_run', value: entry.runId || '' });
            return rec.save();
        } catch (e) {
            log.error('planif_dao - writeJournalEntry failed', e.message);
            return null;
        }
    }

    function listJournalEntries(itemId, limit) {
        var rows = [];
        try {
            search.create({
                type: 'customrecord_planif_journal',
                filters: itemId ? [['custrecord_planif_journal_item', 'anyof', itemId]] : [],
                columns: [
                    search.createColumn({ name: 'created', sort: search.Sort.DESC }),
                    'custrecord_planif_journal_user',
                    'custrecord_planif_journal_item',
                    'custrecord_planif_journal_op',
                    'custrecord_planif_journal_origin',
                    'custrecord_planif_journal_created',
                    'custrecord_planif_journal_gap',
                    'custrecord_planif_journal_run'
                ]
            }).run().each(function (result) {
                rows.push({
                    timestamp: result.getValue({ name: 'created' }),
                    userName: result.getText({ name: 'custrecord_planif_journal_user' }) || '',
                    itemCode: result.getText({ name: 'custrecord_planif_journal_item' }) || '',
                    operation: result.getValue({ name: 'custrecord_planif_journal_op' }) || '',
                    originalOrderId: result.getValue({ name: 'custrecord_planif_journal_origin' }) || '',
                    createdOrderIds: result.getValue({ name: 'custrecord_planif_journal_created' }) || '[]',
                    quantityGap: parseFloat(result.getValue({ name: 'custrecord_planif_journal_gap' })) || 0,
                    runId: result.getValue({ name: 'custrecord_planif_journal_run' }) || ''
                });
                return rows.length < (limit || 200);
            });
        } catch (e) {
            log.error('planif_dao - listJournalEntries failed', e.message);
        }
        return rows;
    }

    return {
        listSupplyPlanDefinitions: listSupplyPlanDefinitions,
        resolveCurrentRun: resolveCurrentRun,
        listItemLocationSummaries: listItemLocationSummaries,
        listPlannedOrdersForItem: listPlannedOrdersForItem,
        getComponentsProposals: getComponentsProposals,
        applySplit: applySplit,
        writeJournalEntry: writeJournalEntry,
        listJournalEntries: listJournalEntries,
        countArbitratedItemsSinceRun: countArbitratedItemsSinceRun
    };
});
