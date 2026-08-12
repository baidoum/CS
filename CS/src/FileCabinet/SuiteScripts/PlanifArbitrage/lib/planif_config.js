/**
 * @NApiVersion 2.1
 * @NModuleScope SameAccount
 *
 * Planif Arbitrage - configuration module.
 * Every account-specific or uncertain value is backed by a Script Parameter
 * on the SL_Planif_Arbitrage deployment, with a best-guess default - none of
 * these have been verified against a live account yet. Correct the
 * parameter values (Customization > Scripting > Scripts > this script >
 * Parameters) once confirmed on the sandbox. No code changes needed.
 *
 * Spec : section 5 (codification des niveaux - contrainte de conception :
 * "la correspondance préfixe / niveau ... doit être portée par un paramètre
 * modifiable et non codée en dur").
 */
define(['N/runtime'], function (runtime) {

    function getParam(paramId, defaultValue) {
        var script = runtime.getCurrentScript();
        var value = script.getParameter({ name: paramId });
        if (value === null || value === undefined || value === '') {
            return defaultValue;
        }
        return value;
    }

    // Parses "7:Produits finis:make,5:Semi-finis:make,3:Préparations:make,1:Matières premières:buy"
    // into { "7": {label:"Produits finis", kind:"make"}, ... }. One line per
    // prefix - format is <prefix>:<label>:<make|buy>, entries comma-separated.
    function parseLevelMap(raw) {
        var map = {};
        String(raw || '').split(',').forEach(function (entry) {
            var parts = entry.split(':');
            var prefix = (parts[0] || '').trim();
            if (!prefix) {
                return;
            }
            map[prefix] = {
                label: (parts[1] || prefix).trim(),
                kind: (parts[2] || 'make').trim().toLowerCase() === 'buy' ? 'buy' : 'make'
            };
        });
        return map;
    }

    function parseLevelOrder(raw) {
        return String(raw || '').split(',')
            .map(function (s) { return s.trim(); })
            .filter(function (s) { return s; });
    }

    function getConfig() {
        return {
            // Prefix -> {label, kind}. RG : un préfixe inconnu ne doit jamais
            // être masqué silencieusement, voir levelForCode() ci-dessous.
            levelMap: parseLevelMap(getParam(
                'custscript_planif_level_map',
                '7:Produits finis:make,5:Semi-finis:make,3:Préparations:make,1:Matières premières:buy'
            )),
            // Ordre du cycle d'arbitrage (RG3/RG4) - indépendant du libellé :
            // les niveaux achetés (ex. "1") n'y figurent pas, ils sont en
            // consultation seule (section 5).
            levelOrder: parseLevelOrder(getParam('custscript_planif_level_order', '7,5,3')),
            // Libellé du groupe pour un préfixe non reconnu par levelMap.
            unknownLevelLabel: getParam('custscript_planif_level_unknown_label', 'Niveau non reconnu'),
            // Supply Plan Definition ciblée (729922 en sandbox de référence).
            supplyPlanDefinitionId: getParam('custscript_planif_supply_plan_def_id', '729922'),
            // Horizon de planification en jours, pour le signalement F3 des
            // dates hors horizon.
            horizonDays: parseInt(getParam('custscript_planif_horizon_days', '180'), 10),
            // Nom de table SuiteQL pour plannedorder - non confirmé, isolé
            // ici pour rester un point de correction unique (section 9/10).
            plannedOrderTable: getParam('custscript_planif_plannedorder_table', 'plannedorder'),
            // Active la tentative de lecture des composants via le pegging
            // (F8) avant repli sur le filtrage fenêtre/article/emplacement.
            usePegging: getParam('custscript_planif_use_pegging', 'T') === 'T',
            // URL de repli pour F6 si le lancement par N/action est
            // indisponible (redirection vers l'écran standard SPD).
            supplyPlanUrl: getParam('custscript_planif_supply_plan_url', ''),
            // Nombre d'articles par groupe de niveau affichés dans le
            // sélecteur F1 avant défilement.
            pageSize: parseInt(getParam('custscript_planif_page_size', '200'), 10)
        };
    }

    // Dérive {level, label, kind} depuis le premier caractère du code
    // article. Un préfixe absent de levelMap retourne le niveau '?' avec le
    // libellé unknownLevelLabel - jamais masqué (section 5, contrainte de
    // conception).
    function levelForCode(code, config) {
        var cfg = config || getConfig();
        var prefix = String(code || '').charAt(0);
        var entry = cfg.levelMap[prefix];
        if (!entry) {
            return { level: '?', label: cfg.unknownLevelLabel, kind: 'unknown' };
        }
        return { level: prefix, label: entry.label, kind: entry.kind };
    }

    return {
        getConfig: getConfig,
        levelForCode: levelForCode
    };
});
