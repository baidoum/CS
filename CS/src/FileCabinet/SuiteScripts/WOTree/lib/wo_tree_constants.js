/**
 * @NApiVersion 2.1
 *
 * WOTree shared config module. Every value here is backed by a Script Parameter
 * on the wo_tree_suitelet.js deployment with a best-guess default - none of
 * these internal IDs have been verified against a live account. Run
 * wo_field_discovery_sl.js once after deploying and correct the parameter
 * values (Customization > Scripting > Scripts > this script > Parameters)
 * if the defaults below don't match this account. No code changes needed.
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

    function getConfig() {
        return {
            // Internal value of the Work Order "status" field for Released.
            statusReleased: getParam('custscript_wo_status_released', 'WorkOrd:B'),
            // Search join id used to reach the assembly item's own fields from a
            // Work Order search (e.g. to filter by Planning Item Category).
            itemJoinId: getParam('custscript_wo_item_join_id', 'assemblyitem'),
            // Field id on the Item record for "Planning Item Category".
            planningCategoryField: getParam('custscript_wo_planning_cat_field', 'custitem_planningitemcategory'),
            // How many top-level (root) Work Orders to show per page.
            pageRootSize: parseInt(getParam('custscript_wo_page_root_size', '50'), 10),
            // Script id of the Map/Reduce script that applies queued date changes.
            mrScriptId: getParam('custscript_wo_mr_script_id', 'customscript_wotree_mr')
        };
    }

    return {
        getConfig: getConfig
    };
});
