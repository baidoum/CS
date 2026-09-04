/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 *
 * Commande et facturation au poids réel - point 3
 * -------------------------------------------------------------------
 * Après création d'une livraison (Item Fulfillment) dont les lots ont été
 * saisis par le préparateur, pour chaque ligne dont l'article est soumis à
 * la facturation au poids réel (custitem_ax_weight_invoicing) :
 *   1. Retrouve les numéros de lot (colis) assignés sur la ligne.
 *   2. Cumule leur poids réel (custrecord_lots_netweight sur l'ALD).
 *   3. Ajoute ce poids au cumul déjà porté par la ligne de commande
 *      d'origine (custcol_ax_poids_reel_livre) - additif, pas un
 *      remplacement, une commande pouvant être livrée en plusieurs fois.
 *   4. Dérive le prix au kg PROPRE À CETTE COMMANDE (chaque commande peut
 *      avoir un prix/colis différent, donc un prix/kg différent - pas une
 *      constante article) :
 *        prix_kg = rate (prix au colis de CETTE ligne de commande)
 *                  / custitem_ax_poids_colis (poids par défaut du colis, article)
 *      Écrit dans custcol_ax_prix_kg. Conséquence acceptée : après ce
 *      script, `rate` (resté au prix/colis d'origine) et `amount`
 *      (recalculé au poids réel) ne sont plus mécaniquement cohérents
 *      entre eux - à gérer au niveau du layout d'impression, pas ici.
 *   5. Recalcule le montant de la ligne de commande :
 *      amount = poids_reel_livre (cumulé) * prix_kg (dérivé ci-dessus).
 *
 * Point non vérifié (à tester sur sandbox) : le champ de LECTURE des
 * numéros de lot déjà assignés sur une sous-liste inventorydetail d'une
 * ligne d'Item Fulfillment. `issueinventorynumber`/`receiptinventorynumber`
 * sont des champs d'ÉCRITURE uniquement (confirmé sur plannedorder/
 * inventory adjustment, voir ax_wms_rl_decaissage.js) - `inventorynumber`
 * est tenté ici comme champ de lecture, avec repli diagnostique si vide.
 *
 * Champs requis :
 *  Article  : custitem_ax_weight_invoicing (Check Box, existant)
 *  Article  : custitem_ax_poids_colis      (Decimal, existant - poids par défaut du colis)
 *  Commande : custcol_ax_poids_reel_livre  (Decimal Number, sous-liste item) - à créer
 *  Commande : custcol_ax_prix_kg           (Currency ou Decimal, sous-liste item) - à créer
 */
define(['N/record', 'N/search', 'N/log'], function (record, search, log) {

    var ITEM_REAL_WEIGHT_FLAG = 'custitem_ax_weight_invoicing';
    var ITEM_PACKAGE_WEIGHT_FIELD = 'custitem_ax_poids_colis';
    var ALD_LOTNUMBER_FIELD = 'custrecord_lots_lotnumber';
    var ALD_NETWEIGHT_FIELD = 'custrecord_lots_netweight';
    var SO_WEIGHT_DELIVERED_FIELD = 'custcol_ax_poids_reel_livre';
    var SO_PRICE_PER_KG_FIELD = 'custcol_ax_prix_kg';

    function afterSubmit(context) {
        if (context.type !== context.UserEventType.CREATE) {
            return;
        }

        try {
            var fulfillment = record.load({
                type: record.Type.ITEM_FULFILLMENT,
                id: context.newRecord.id,
                isDynamic: false
            });

            var createdFromId = fulfillment.getValue({ fieldId: 'createdfrom' });
            if (!createdFromId) {
                log.audit('ax_ue_if_poids_reel', 'Livraison ' + fulfillment.id + ' sans commande d\'origine (createdfrom) - ignorée.');
                return;
            }

            // Cumule les incréments de poids par ligne de commande avant
            // d'écrire - une seule ouverture/sauvegarde de la commande même
            // si plusieurs lignes de la livraison s'y rattachent. itemId
            // transporté pour retrouver le prix/kg article à l'écriture.
            var weightBySoLine = {}; // soLineNumber (tel que porté par orderline) -> { weight, itemId }

            var lineCount = fulfillment.getLineCount({ sublistId: 'item' });
            for (var i = 0; i < lineCount; i++) {
                var itemId = fulfillment.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i });
                if (!itemId || !isRealWeightBillingItem(itemId)) {
                    continue;
                }

                var soLine = fulfillment.getSublistValue({ sublistId: 'item', fieldId: 'orderline', line: i });
                if (soLine === '' || soLine === null || soLine === undefined) {
                    log.error('ax_ue_if_poids_reel', 'Ligne ' + i + ' de la livraison ' + fulfillment.id
                        + ' : orderline absent, impossible de rattacher à la commande - ligne ignorée.');
                    continue;
                }

                var lotNumbers = getLotNumbersForLine(fulfillment, i);
                if (!lotNumbers.length) {
                    log.error('ax_ue_if_poids_reel', 'Ligne ' + i + ' de la livraison ' + fulfillment.id
                        + ' : aucun numéro de lot trouvé sur cette ligne (article à facturation au poids réel) - ligne ignorée.');
                    continue;
                }

                var weight = sumRealWeight(lotNumbers);
                if (!weightBySoLine[soLine]) {
                    weightBySoLine[soLine] = { weight: 0, itemId: itemId };
                }
                weightBySoLine[soLine].weight += weight;

                log.debug('ax_ue_if_poids_reel', 'Livraison ' + fulfillment.id + ' ligne ' + i
                    + ' -> commande ' + createdFromId + ' ligne ' + soLine
                    + ' : ' + lotNumbers.length + ' colis, poids ' + weight);
            }

            if (Object.keys(weightBySoLine).length) {
                applyToSalesOrder(createdFromId, weightBySoLine);
            }

        } catch (e) {
            log.error('ax_ue_if_poids_reel - erreur', (e.name ? e.name + ' - ' : '') + e.message);
        }
    }

    function isRealWeightBillingItem(itemId) {
        try {
            var res = search.lookupFields({ type: search.Type.ITEM, id: itemId, columns: [ITEM_REAL_WEIGHT_FLAG] });
            return res[ITEM_REAL_WEIGHT_FLAG] === true;
        } catch (e) {
            log.error('isRealWeightBillingItem', 'itemId=' + itemId + ' : ' + e.message);
            return false;
        }
    }

    // Poids par défaut du colis (article) - sert uniquement à dériver le
    // prix/kg de CETTE commande depuis son propre `rate` (prix/colis),
    // jamais un prix/kg constant côté article : chaque commande peut avoir
    // un prix/colis différent, donc un prix/kg différent.
    function getPackageWeight(itemId) {
        try {
            var res = search.lookupFields({ type: search.Type.ITEM, id: itemId, columns: [ITEM_PACKAGE_WEIGHT_FIELD] });
            return parseFloat(res[ITEM_PACKAGE_WEIGHT_FIELD]) || 0;
        } catch (e) {
            log.error('getPackageWeight', 'itemId=' + itemId + ' : ' + e.message);
            return 0;
        }
    }

    // Numéros de lot (colis) assignés sur une ligne de livraison déjà
    // enregistrée. Diagnostic explicite si le champ de lecture supposé
    // ('inventorynumber') ne renvoie rien alors que des lignes existent -
    // pour corriger sans deviner à nouveau.
    function getLotNumbersForLine(fulfillment, lineIndex) {
        var lots = [];
        try {
            var detail = fulfillment.getSublistSubrecord({ sublistId: 'item', fieldId: 'inventorydetail', line: lineIndex });
            var n = detail.getLineCount({ sublistId: 'inventoryassignment' });
            for (var j = 0; j < n; j++) {
                var lotText = detail.getSublistText({ sublistId: 'inventoryassignment', fieldId: 'inventorynumber', line: j });
                if (lotText) {
                    lots.push(lotText);
                }
            }
            if (n && !lots.length) {
                log.audit('getLotNumbersForLine', 'ligne ' + lineIndex + ' : ' + n + ' assignation(s) mais aucun texte lu via '
                    + '"inventorynumber" - champ de lecture probablement différent, à vérifier sur sandbox.');
            }
        } catch (e) {
            log.error('getLotNumbersForLine', 'ligne ' + lineIndex + ' : ' + e.message);
        }
        return lots;
    }

    // Somme du poids réel (ALD) pour une liste de numéros de lot (colis).
    // Jointure par custrecord_lots_lotnumber (texte) et non par
    // custrecord_lots_inventorynumber - ce dernier reste rattaché au lot
    // palette d'origine après décaissage, pas au nouveau lot colis (voir
    // ax_wms_rl_decaissage.js / CONTEXT_decaissage_wms.md).
    function sumRealWeight(lotNumbers) {
        var total = 0;
        lotNumbers.forEach(function (lotText) {
            var found = false;
            try {
                search.create({
                    type: 'customrecord_additionallotdetails',
                    filters: [
                        [ALD_LOTNUMBER_FIELD, 'is', lotText], 'AND',
                        ['isinactive', 'is', 'F']
                    ],
                    columns: [ALD_NETWEIGHT_FIELD]
                }).run().each(function (r) {
                    total += parseFloat(r.getValue({ name: ALD_NETWEIGHT_FIELD })) || 0;
                    found = true;
                    return true;
                });
            } catch (e) {
                log.error('sumRealWeight', 'lot=' + lotText + ' : ' + e.message);
            }
            if (!found) {
                log.error('sumRealWeight', 'Aucun ALD trouvé pour le numéro de lot ' + lotText
                    + ' (recherché via ' + ALD_LOTNUMBER_FIELD + ').');
            }
        });
        return total;
    }

    // Ouvre la commande une seule fois, applique tous les incréments de
    // poids par ligne, recalcule prix/montant, sauvegarde une seule fois.
    //
    // Point non vérifié : le format exact de `orderline` (numéro de ligne
    // 1-based côté commande, ou lineuniquekey) - traité ici comme un index
    // de ligne 1-based, à confirmer sur sandbox.
    function applyToSalesOrder(soId, weightBySoLine) {
        try {
            var so = record.load({ type: record.Type.SALES_ORDER, id: soId, isDynamic: false });
            var n = so.getLineCount({ sublistId: 'item' });

            Object.keys(weightBySoLine).forEach(function (soLineKey) {
                var lineIndex = parseInt(soLineKey, 10) - 1; // orderline supposé 1-based
                if (isNaN(lineIndex) || lineIndex < 0 || lineIndex >= n) {
                    log.error('applyToSalesOrder', 'Commande ' + soId + ' : ligne orderline=' + soLineKey
                        + ' hors limites (nb lignes=' + n + ') - increment ignoré, à vérifier.');
                    return;
                }

                var entry = weightBySoLine[soLineKey];

                var previousWeight = parseFloat(so.getSublistValue({
                    sublistId: 'item', fieldId: SO_WEIGHT_DELIVERED_FIELD, line: lineIndex
                })) || 0;
                var totalWeight = previousWeight + entry.weight;
                so.setSublistValue({ sublistId: 'item', fieldId: SO_WEIGHT_DELIVERED_FIELD, line: lineIndex, value: totalWeight });

                // Prix/kg dérivé du rate de CETTE ligne de commande, pas
                // d'un prix article constant - voir en-tête du fichier.
                var rate = parseFloat(so.getSublistValue({ sublistId: 'item', fieldId: 'rate', line: lineIndex })) || 0;
                var packageWeight = getPackageWeight(entry.itemId);

                if (!packageWeight || packageWeight <= 0) {
                    log.error('applyToSalesOrder', 'Commande ' + soId + ' ligne ' + soLineKey
                        + ' : poids colis (custitem_ax_poids_colis) manquant pour l\'article ' + entry.itemId
                        + ' - prix/kg et montant non recalculés, poids réel cumulé tout de même mis à jour.');
                    return;
                }

                var pricePerKg = rate / packageWeight;
                var amount = Math.round(totalWeight * pricePerKg * 100) / 100;

                so.setSublistValue({ sublistId: 'item', fieldId: SO_PRICE_PER_KG_FIELD, line: lineIndex, value: pricePerKg });
                so.setSublistValue({ sublistId: 'item', fieldId: 'amount', line: lineIndex, value: amount });

                log.audit('applyToSalesOrder', 'Commande ' + soId + ' ligne ' + soLineKey
                    + ' : poids ' + previousWeight + ' + ' + entry.weight + ' = ' + totalWeight
                    + ' | rate ' + rate + ' / poids colis ' + packageWeight + ' = prix/kg ' + pricePerKg
                    + ' | montant ' + amount);
            });

            so.save();
        } catch (e) {
            log.error('applyToSalesOrder - erreur', 'soId=' + soId + ' : ' + (e.name ? e.name + ' - ' : '') + e.message);
        }
    }

    return {
        afterSubmit: afterSubmit
    };
});
