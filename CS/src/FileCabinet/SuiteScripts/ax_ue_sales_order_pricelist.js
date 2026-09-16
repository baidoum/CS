/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 *
 * Objet : Application automatique du tarif item/pricelevel en fonction
 *         de la date d'expedition (shipdate) de la commande de vente, a partir
 *         du custom record customrecord_ax_cust_pricelist alimente en avance
 *         par les ADV.
 *
 *         + Controle des variances : si l'ecart entre l'ancien rate (deja
 *         present sur la ligne avant modification) et le nouveau tarif trouve
 *         depasse le seuil custrecord_ax_aler_limit du record pricelist
 *         correspondant, on NE MET PAS A JOUR le rate de la ligne et on trace
 *         l'anomalie dans le champ body custbody_ax_error_updating_price
 *         (format JSON) pour consultation via le Suitelet AX Price Anomalies.
 *
 * Regle de selection du tarif :
 *   - Le niveau de prix retenu est celui du CLIENT (entity.pricelevel),
 *     recupere une seule fois pour toute la commande - pas le price level
 *     eventuellement affiche ligne par ligne (price_display). Une ligne dont
 *     le price level aurait ete surcharge manuellement est quand meme
 *     traitee avec le niveau par defaut du client.
 *   - Pour chaque ligne (Item) :
 *       -> on cherche dans customrecord_ax_cust_pricelist les enregistrements
 *          ayant le meme Item et le meme Price Level (comparaison sur le
 *          TEXTE : pricelevel du client (getText) vs
 *          custrecord_ax_cust_price_level (getText))
 *       -> parmi ceux dont Date From <= Ship Date, on garde celui dont la
 *          Date From est la plus proche de la Ship Date (max)
 *   - Si aucun shipdate sur la commande -> on ne fait rien du tout
 *   - Si le client n'a pas de price level par defaut -> on ne fait rien du tout
 *   - Si aucun record ne correspond a une ligne :
 *       -> si un tarif custom avait ete applique sur cette ligne lors d'une
 *          precedente sauvegarde (custcol_ax_pricelist_applied = true,
 *          typiquement apres un changement de shipdate qui invalide le
 *          tarif retenu), le rate est vide pour laisser le moteur de
 *          pricing standard NetSuite (item + price level + quantite) le
 *          recalculer a la sauvegarde, et le flag est retire
 *       -> sinon (rate deja standard ou saisie manuelle, jamais touche par
 *          ce script) on ne touche a rien
 *     pas d'anomalie dans les deux cas (rien a comparer)
 *
 * Regle de controle des variances :
 *   - ancien tarif = rate de la ligne AVANT que ce script n'intervienne
 *     (valeur deja calculee par NetSuite / deja presente sur la commande)
 *   - nouveau tarif = unit price du record pricelist trouve
 *   - variance % = (nouveau - ancien) / ancien * 100
 *   - seuil = custrecord_ax_aler_limit du record pricelist trouve
 *   - si |variance %| > seuil -> on NE remplace PAS le rate, on ajoute une
 *     entree d'anomalie pour cette ligne
 *   - sinon -> on applique le nouveau rate normalement
 *   - le champ custbody_ax_error_updating_price est entierement reconstruit
 *     a chaque sauvegarde : une ligne corrigee disparait automatiquement,
 *     une ligne toujours en erreur est regeneree, une nouvelle anomalie
 *     est ajoutee. Si plus aucune anomalie -> champ vide.
 *
 * Deploiement conseille :
 *   Record        : Sales Order
 *   Evenements    : Create, Edit
 *   Execute as    : Administrator
 */
define(['N/search', 'N/format', 'N/log'], (search, format, log) => {

    const PRICELIST_RECORD = 'customrecord_ax_cust_pricelist';
    const FLD_DATE_FROM    = 'custrecord_ax_cust_price_datefrom';
    const FLD_PRICE_LEVEL  = 'custrecord_ax_cust_price_level';
    const FLD_UNIT_PRICE   = 'custrecord_ax_cust_price_unit_price';
    const FLD_ITEM         = 'custrecord_ax_item';
    const FLD_ALERT_LIMIT  = 'custrecord_ax_aler_limit';

    const BODY_ERROR_FIELD = 'custbody_ax_error_updating_price';
    const COL_PRICELIST_APPLIED = 'custcol_ax_pricelist_applied';

    /**
     * Point d'entree beforeSubmit
     */
    const beforeSubmit = (context) => {
        try {
            if (context.type !== context.UserEventType.CREATE
                && context.type !== context.UserEventType.EDIT) {
                return;
            }

            const newRecord = context.newRecord;

            // 1. Ship date obligatoire, sinon on ne touche a rien
            const shipDateValue = newRecord.getValue({ fieldId: 'shipdate' });
            if (!shipDateValue) {
                return;
            }
            const shipDate = normalizeDate(shipDateValue);
            if (!shipDate) {
                return;
            }

            // 2. Customer obligatoire, et son price level par defaut aussi -
            // c'est ce niveau (pas celui affiche ligne par ligne) qui sert
            // au matching pour toute la commande.
            const customerId = newRecord.getValue({ fieldId: 'entity' });
            if (!customerId) {
                return;
            }
            const customerPriceLevelText = getCustomerPriceLevelText(customerId);
            if (!customerPriceLevelText) {
                return;
            }

            const lineCount = newRecord.getLineCount({ sublistId: 'item' });
            if (lineCount === 0) {
                return;
            }

            // 3. Collecte des items uniques de la commande
            const itemIds = new Set();
            for (let i = 0; i < lineCount; i++) {
                const itemId = newRecord.getSublistValue({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: i
                });
                if (itemId) {
                    itemIds.add(itemId.toString());
                }
            }
            if (itemIds.size === 0) {
                return;
            }

            // 4. Une seule recherche groupee pour toute la commande
            const candidates = getPricelistCandidates(Array.from(itemIds));
            if (!candidates.length) {
                return;
            }

            // 5. Application ligne par ligne + collecte des anomalies
            const anomalies = [];
            for (let i = 0; i < lineCount; i++) {
                const anomaly = applyPriceToLine(newRecord, i, candidates, shipDate, customerPriceLevelText);
                if (anomaly) {
                    anomalies.push(anomaly);
                }
            }

            // 6. Reconstruction complete du champ d'erreur body
            if (anomalies.length) {
                newRecord.setValue({
                    fieldId: BODY_ERROR_FIELD,
                    value: JSON.stringify(anomalies)
                });
            } else {
                // Plus aucune anomalie -> on vide le champ s'il contenait
                // des erreurs issues d'un precedent enregistrement
                const existing = newRecord.getValue({ fieldId: BODY_ERROR_FIELD });
                if (existing) {
                    newRecord.setValue({ fieldId: BODY_ERROR_FIELD, value: '' });
                }
            }

        } catch (e) {
            log.error({
                title: 'AX Pricelist - beforeSubmit error',
                details: e
            });
        }
    };

    /**
     * Recupere le texte du price level par defaut du client (entity.pricelevel).
     * Retourne '' si non renseigne.
     */
    function getCustomerPriceLevelText(customerId) {
        try {
            const res = search.lookupFields({
                type: search.Type.CUSTOMER,
                id: customerId,
                columns: ['pricelevel']
            });
            const pricelevel = res.pricelevel;
            if (Array.isArray(pricelevel) && pricelevel.length) {
                return pricelevel[0].text || '';
            }
            return '';
        } catch (e) {
            log.error({ title: 'AX Pricelist - getCustomerPriceLevelText error', details: e });
            return '';
        }
    }

    /**
     * Recherche groupee de tous les records pricelist candidats pour
     * cette liste d'items.
     */
    function getPricelistCandidates(itemIds) {
        const results = [];

        const s = search.create({
            type: PRICELIST_RECORD,
            filters: [
                [FLD_ITEM, 'anyof', itemIds],
                'AND',
                ['isinactive', 'is', 'F']
            ],
            columns: [
                FLD_ITEM,
                search.createColumn({ name: FLD_PRICE_LEVEL }),
                FLD_DATE_FROM,
                FLD_UNIT_PRICE,
                FLD_ALERT_LIMIT
            ]
        });

        s.run().each((result) => {
            const dateFromStr = result.getValue({ name: FLD_DATE_FROM });
            const priceLevelText = result.getText({ name: FLD_PRICE_LEVEL });
            const unitPriceStr = result.getValue({ name: FLD_UNIT_PRICE });
            const alertLimitStr = result.getValue({ name: FLD_ALERT_LIMIT });

            if (!dateFromStr || !priceLevelText || unitPriceStr === '' || unitPriceStr === null) {
                return true; // ligne incomplete, on l'ignore et on continue
            }

            const dateFrom = normalizeDate(dateFromStr);
            if (!dateFrom) {
                return true;
            }

            results.push({
                itemId: result.getValue({ name: FLD_ITEM }).toString(),
                priceLevelText: priceLevelText,
                dateFrom: dateFrom,
                unitPrice: parseFloat(unitPriceStr),
                // Si le champ seuil n'est pas renseigne sur le record, on
                // considere qu'il n'y a pas de limite (pas de blocage)
                alertLimit: (alertLimitStr === '' || alertLimitStr === null)
                    ? null
                    : parseFloat(alertLimitStr)
            });

            return true; // continuer l'iteration
        });

        return results;
    }

    /**
     * Trouve le meilleur candidat pour une ligne donnee.
     * - Si l'ecart est dans le seuil -> applique le rate, retourne null
     * - Si l'ecart depasse le seuil -> ne touche pas au rate, retourne
     *   un objet anomalie a tracer dans le champ body
     * - Si aucun candidat -> ne fait rien, retourne null
     */
    function applyPriceToLine(newRecord, lineIndex, candidates, shipDate, customerPriceLevelText) {
        const itemId = newRecord.getSublistValue({
            sublistId: 'item',
            fieldId: 'item',
            line: lineIndex
        });
        if (!itemId) {
            return null;
        }

        const itemIdStr = itemId.toString();

        let best = null;
        for (const c of candidates) {
            if (c.itemId !== itemIdStr) continue;
            if (c.priceLevelText !== customerPriceLevelText) continue;
            if (c.dateFrom > shipDate) continue; // pas encore applicable a cette ship date

            if (!best || c.dateFrom > best.dateFrom) {
                best = c;
            }
        }

        if (!best) {
            // Aucun tarif custom applicable. Si un tarif custom avait ete
            // applique par ce script lors d'une precedente sauvegarde
            // (flag COL_PRICELIST_APPLIED), le rate present sur la ligne
            // est un residu de ce precedent passage - pas le prix standard
            // NetSuite. On vide le rate pour que le moteur de pricing
            // standard (item + price level + quantite) le recalcule a la
            // sauvegarde, et on retire le flag. Si le flag n'etait pas
            // pose, le rate courant est deja le standard (ou une saisie
            // manuelle) - on n'y touche pas.
            const wasApplied = newRecord.getSublistValue({
                sublistId: 'item',
                fieldId: COL_PRICELIST_APPLIED,
                line: lineIndex
            });
            if (wasApplied === true) {
                newRecord.setSublistValue({ sublistId: 'item', fieldId: 'rate', line: lineIndex, value: '' });
                newRecord.setSublistValue({ sublistId: 'item', fieldId: COL_PRICELIST_APPLIED, line: lineIndex, value: false });
            }
            return null;
        }

        // Ancien tarif = rate deja present sur la ligne avant notre intervention
        const oldRateRaw = newRecord.getSublistValue({
            sublistId: 'item',
            fieldId: 'rate',
            line: lineIndex
        });
        const oldRate = parseFloat(oldRateRaw) || 0;
        const newRate = best.unitPrice;

        let variance = null;
        let exceeds = false;

        if (best.alertLimit !== null) {
            if (oldRate === 0) {
                // Division par zero impossible -> on considere que c'est
                // une anomalie a controler manuellement
                exceeds = true;
            } else {
                variance = ((newRate - oldRate) / oldRate) * 100;
                if (Math.abs(variance) > best.alertLimit) {
                    exceeds = true;
                }
            }
        }

        if (exceeds) {
            // On bloque uniquement la mise a jour du rate de cette ligne
            return {
                line: lineIndex + 1,
                item: newRecord.getSublistText({
                    sublistId: 'item',
                    fieldId: 'item',
                    line: lineIndex
                }),
                priceLevel: customerPriceLevelText,
                oldRate: oldRate,
                newRate: newRate,
                variance: variance === null ? null : Math.round(variance * 100) / 100,
                threshold: best.alertLimit
            };
        }

        // Pas d'anomalie -> on applique normalement le nouveau tarif, et on
        // pose le flag pour pouvoir rendre la main au moteur standard si ce
        // tarif custom ne matche plus lors d'une future sauvegarde.
        newRecord.setSublistValue({
            sublistId: 'item',
            fieldId: 'rate',
            line: lineIndex,
            value: newRate
        });
        newRecord.setSublistValue({
            sublistId: 'item',
            fieldId: COL_PRICELIST_APPLIED,
            line: lineIndex,
            value: true
        });

        return null;
    }

    /**
     * Normalise une valeur de date (Date object ou string) en objet Date
     * en ne gardant que la partie date (minuit) pour une comparaison fiable.
     */
    function normalizeDate(value) {
        try {
            let d;
            if (value instanceof Date) {
                d = value;
            } else {
                d = format.parse({ value: value, type: format.Type.DATE });
            }
            d.setHours(0, 0, 0, 0);
            return d;
        } catch (e) {
            return null;
        }
    }

    return { beforeSubmit };
});