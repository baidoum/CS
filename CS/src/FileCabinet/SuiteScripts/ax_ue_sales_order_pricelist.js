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
 *          tarif retenu), la checkbox body custbody_ax_lines_to_reprice est
 *          cochee pour declencher un repricing standard fait en afterSubmit
 *          (voir commentaire de la fonction) - impossible a faire
 *          directement ici, le moteur de pricing standard NetSuite ne se
 *          redeclenche qu'en mode dynamique. Le flag ligne n'est retire
 *          qu'une fois le repricing effectivement fait, par afterSubmit.
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
define(['N/record', 'N/search', 'N/format', 'N/log'], (record, search, format, log) => {

    const PRICELIST_RECORD = 'customrecord_ax_cust_pricelist';
    const FLD_DATE_FROM    = 'custrecord_ax_cust_price_datefrom';
    const FLD_PRICE_LEVEL  = 'custrecord_ax_cust_price_level';
    const FLD_UNIT_PRICE   = 'custrecord_ax_cust_price_unit_price';
    const FLD_ITEM         = 'custrecord_ax_item';
    const FLD_ALERT_LIMIT  = 'custrecord_ax_aler_limit';

    const BODY_ERROR_FIELD = 'custbody_ax_error_updating_price';
    const BODY_LINES_TO_REPRICE = 'custbody_ax_lines_to_reprice';
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

            // 4. Une seule recherche groupee pour toute la commande. Pas de
            // court-circuit si vide : une ligne dont le tarif custom aurait
            // ete completement retire/desactive doit malgre tout etre
            // detectee ci-dessous pour repasser en pricing standard.
            const candidates = getPricelistCandidates(Array.from(itemIds));

            // 5. Application ligne par ligne + collecte des anomalies et
            // detection d'un besoin de repricing standard (cf. applyPriceToLine)
            const anomalies = [];
            let anyNeedsReprice = false;
            for (let i = 0; i < lineCount; i++) {
                const outcome = applyPriceToLine(newRecord, i, candidates, shipDate, customerPriceLevelText);
                if (outcome.anomaly) {
                    anomalies.push(outcome.anomaly);
                }
                if (outcome.needsReprice) {
                    anyNeedsReprice = true;
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

            // 7. Marqueur (checkbox) consomme par afterSubmit - signale
            // seulement qu'au moins une ligne a besoin d'un repricing
            // standard, sans preciser laquelle : afterSubmit refait le
            // matching lui-meme sur toutes les lignes encore marquees
            // custcol_ax_pricelist_applied (cf. commentaire de la fonction)
            newRecord.setValue({ fieldId: BODY_LINES_TO_REPRICE, value: anyNeedsReprice });

        } catch (e) {
            log.error({
                title: 'AX Pricelist - beforeSubmit error',
                details: e
            });
        }
    };

    // Repricing standard des lignes dont le tarif custom ne matche plus
    // (typiquement apres un changement de shipdate qui invalide le tarif
    // retenu au precedent enregistrement). Ne peut pas se faire en
    // beforeSubmit : le moteur de pricing standard NetSuite (item + price
    // level + quantite) ne se redeclenche que sur un enregistrement en
    // mode DYNAMIQUE dont on retouche un champ declencheur (quantity) -
    // impossible sur newRecord en beforeSubmit (mode standard, pas encore
    // sauvegarde).
    //
    // BODY_LINES_TO_REPRICE (checkbox) sert uniquement de signal "au moins
    // une ligne concernee" pose par beforeSubmit, pour eviter de refaire ce
    // travail (recherche + record.load dynamique) a chaque sauvegarde. Les
    // lignes elles-memes sont retrouvees ici en relisant
    // COL_PRICELIST_APPLIED sur chaque ligne du record dynamique et en
    // refaisant le meme matching que beforeSubmit (findBestCandidate) :
    // celles ou le flag est encore a true et qu'aucun candidat ne matche
    // sont repricees (quantity re-ecrite sur elle-meme pour forcer le
    // recalcul standard de rate/amount) puis le flag est retire.
    //
    // Anti-boucle : le save() ci-dessous redeclenche beforeSubmit/afterSubmit
    // sur la meme commande, mais COL_PRICELIST_APPLIED est deja a false pour
    // les lignes traitees - le second passage ne les re-signalera pas (un
    // seul aller-retour).
    const afterSubmit = (context) => {
        try {
            if (context.type !== context.UserEventType.CREATE
                && context.type !== context.UserEventType.EDIT) {
                return;
            }

            const needsReprice = context.newRecord.getValue({ fieldId: BODY_LINES_TO_REPRICE });
            if (needsReprice !== true) {
                return;
            }

            const shipDateValue = context.newRecord.getValue({ fieldId: 'shipdate' });
            const shipDate = shipDateValue ? normalizeDate(shipDateValue) : null;
            const customerId = context.newRecord.getValue({ fieldId: 'entity' });
            const customerPriceLevelText = customerId ? getCustomerPriceLevelText(customerId) : '';

            const so = record.load({
                type: record.Type.SALES_ORDER,
                id: context.newRecord.id,
                isDynamic: true
            });
            const lineCount = so.getLineCount({ sublistId: 'item' });

            const itemIds = new Set();
            for (let i = 0; i < lineCount; i++) {
                const itemId = so.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i });
                if (itemId) { itemIds.add(itemId.toString()); }
            }
            const candidates = (shipDate && customerPriceLevelText && itemIds.size)
                ? getPricelistCandidates(Array.from(itemIds))
                : [];

            let processed = 0;
            for (let i = 0; i < lineCount; i++) {
                const wasApplied = so.getSublistValue({ sublistId: 'item', fieldId: COL_PRICELIST_APPLIED, line: i });
                if (wasApplied !== true) {
                    continue;
                }

                const itemId = so.getSublistValue({ sublistId: 'item', fieldId: 'item', line: i });
                const best = (shipDate && customerPriceLevelText && itemId)
                    ? findBestCandidate(itemId.toString(), candidates, shipDate, customerPriceLevelText)
                    : null;
                if (best) {
                    // Un candidat matche de nouveau (etat incoherent avec
                    // beforeSubmit, ne devrait pas arriver) - on laisse la
                    // ligne telle quelle plutot que de la toucher a tort.
                    continue;
                }

                so.selectLine({ sublistId: 'item', line: i });
                const qty = so.getCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity' });
                // Re-ecrire la quantite sur elle-meme force NetSuite a
                // resourcer rate/amount depuis la matrice de prix standard
                // de l'article (price level + quantite) - c'est le seul
                // declencheur disponible en mode dynamique.
                so.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: qty });
                so.setCurrentSublistValue({ sublistId: 'item', fieldId: COL_PRICELIST_APPLIED, value: false });
                so.commitLine({ sublistId: 'item' });
                processed++;
            }

            so.setValue({ fieldId: BODY_LINES_TO_REPRICE, value: false });
            so.save();

            log.audit('AX Pricelist - afterSubmit', 'Repricing standard applique sur '
                + processed + ' ligne(s), SO ' + context.newRecord.id);

        } catch (e) {
            log.error({ title: 'AX Pricelist - afterSubmit error', details: e });
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
     * Meilleur candidat pour un item donne : parmi les candidats du meme
     * item et price level, applicable a cette ship date (Date From <=
     * shipDate), celui dont la Date From est la plus proche (max). Utilisee
     * par applyPriceToLine (application) et par afterSubmit (re-detection
     * lors du repricing standard).
     */
    function findBestCandidate(itemIdStr, candidates, shipDate, customerPriceLevelText) {
        let best = null;
        for (const c of candidates) {
            if (c.itemId !== itemIdStr) continue;
            if (c.priceLevelText !== customerPriceLevelText) continue;
            if (c.dateFrom > shipDate) continue; // pas encore applicable a cette ship date

            if (!best || c.dateFrom > best.dateFrom) {
                best = c;
            }
        }
        return best;
    }

    /**
     * Trouve le meilleur candidat pour une ligne donnee.
     * Retourne toujours { anomaly, needsReprice } :
     * - anomaly non-null si l'ecart depasse le seuil (rate non touche)
     * - needsReprice=true si un tarif custom precedemment applique
     *   (custcol_ax_pricelist_applied) ne matche plus - traite en standard
     *   par afterSubmit, qui retrouvera la ligne en relisant ce meme flag
     */
    function applyPriceToLine(newRecord, lineIndex, candidates, shipDate, customerPriceLevelText) {
        const noop = { anomaly: null, needsReprice: false };

        const itemId = newRecord.getSublistValue({
            sublistId: 'item',
            fieldId: 'item',
            line: lineIndex
        });
        if (!itemId) {
            return noop;
        }

        const itemIdStr = itemId.toString();
        const best = findBestCandidate(itemIdStr, candidates, shipDate, customerPriceLevelText);

        if (!best) {
            // Aucun tarif custom applicable. Si un tarif custom avait ete
            // applique par ce script lors d'une precedente sauvegarde
            // (flag COL_PRICELIST_APPLIED encore a true), le rate present
            // sur la ligne est un residu de ce precedent passage - pas le
            // prix standard NetSuite. On ne le touche pas ici (vider rate
            // en beforeSubmit casse la validation "Amount obligatoire" - le
            // moteur de pricing standard ne se redeclenche pas sur une
            // simple ecriture en mode standard) : on laisse le flag tel
            // quel (afterSubmit s'en servira pour retrouver cette ligne et
            // le retirera lui-meme une fois le repricing fait) et on
            // signale juste qu'un repricing est necessaire. Si le flag
            // n'etait pas pose, le rate courant est deja le standard (ou
            // une saisie manuelle) - on n'y touche pas.
            const wasApplied = newRecord.getSublistValue({
                sublistId: 'item',
                fieldId: COL_PRICELIST_APPLIED,
                line: lineIndex
            });
            return { anomaly: null, needsReprice: wasApplied === true };
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
                anomaly: {
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
                },
                needsReprice: false
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

        return noop;
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

    return { beforeSubmit, afterSubmit };
});