/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 *
 * Commande client - calcul de la quantité depuis le poids nécessaire
 * -------------------------------------------------------------------
 * En sortie du champ ligne custcol_ax_needed_weight, calcule la quantité :
 *   quantity = ceil(custcol_ax_needed_weight / item.custitem_ax_poids_colis)
 * Avertit (sans bloquer) si le poids du colis de l'article n'est pas renseigné -
 * dans ce cas la quantité n'est pas modifiée.
 */
define(['N/search', 'N/log'], function (search, log) {

    var SUBLIST_ID = 'item';
    var WEIGHT_FIELD = 'custcol_ax_needed_weight';
    var QTY_FIELD = 'quantity';
    var PACKAGE_WEIGHT_FIELD = 'custitem_ax_poids_colis';

    function fieldChanged(context) {
        if (context.sublistId !== SUBLIST_ID || context.fieldId !== WEIGHT_FIELD) {
            return;
        }

        var rec = context.currentRecord;
        var neededWeight = parseFloat(rec.getCurrentSublistValue({ sublistId: SUBLIST_ID, fieldId: WEIGHT_FIELD }));
        if (!neededWeight || neededWeight <= 0) {
            return;
        }

        var itemId = rec.getCurrentSublistValue({ sublistId: SUBLIST_ID, fieldId: 'item' });
        if (!itemId) {
            return;
        }

        var packageWeight = getPackageWeight(itemId);
        if (!packageWeight || packageWeight <= 0) {
            alert('Le poids du colis (custitem_ax_poids_colis) n’est pas renseigné pour cet article - '
                + 'la quantité n’a pas été recalculée.');
            return;
        }

        // Arrondi à l'unité la plus haute - un epsilon absorbe le bruit de
        // calcul flottant (ex. 10/2 pouvant donner 5.000000001 et forcer un
        // arrondi à 6 au lieu de 5).
        var ratio = neededWeight / packageWeight;
        var qty = Math.ceil(Math.round(ratio * 100000) / 100000);

        rec.setCurrentSublistValue({ sublistId: SUBLIST_ID, fieldId: QTY_FIELD, value: qty });
    }

    // Le poids du colis est un champ article, pas systématiquement remonté
    // sur la ligne de commande - lu par recherche plutôt que supposé
    // disponible en sourcing sur la sous-liste.
    function getPackageWeight(itemId) {
        try {
            var result = search.lookupFields({
                type: search.Type.ITEM,
                id: itemId,
                columns: [PACKAGE_WEIGHT_FIELD]
            });
            return parseFloat(result[PACKAGE_WEIGHT_FIELD]) || 0;
        } catch (e) {
            log.error('getPackageWeight', 'itemId=' + itemId + ' : ' + e.message);
            return 0;
        }
    }

    return {
        fieldChanged: fieldChanged
    };
});
