/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 *
 * Client script for wo_tree_suitelet.js. Wires the Search/paging/Save buttons,
 * snapshots original Start Date values to compute a diff on Save, and rolls
 * back edits attempted on non-Released rows.
 *
 * This read-only enforcement is cosmetic only - NetSuite's INLINEEDITOR
 * sublist has no native per-row disable, so the authoritative check happens
 * server-side in wo_tree_suitelet.js before any change is queued.
 */
define(['N/currentRecord'], function (currentRecordModule) {

    var SUBLIST_ID = 'custpage_wolist';
    var snapshot = {};

    function pageInit(context) {
        var rec = context.currentRecord;
        var lineCount = rec.getLineCount({ sublistId: SUBLIST_ID });
        snapshot = {};
        for (var i = 0; i < lineCount; i++) {
            var id = rec.getSublistValue({ sublistId: SUBLIST_ID, fieldId: 'custpage_id', line: i });
            snapshot[id] = rec.getSublistValue({ sublistId: SUBLIST_ID, fieldId: 'custpage_startdate', line: i });
        }
    }

    function fieldChanged(context) {
        if (context.sublistId !== SUBLIST_ID || context.fieldId !== 'custpage_startdate') {
            return;
        }
        var rec = context.currentRecord;
        var line = context.line;
        var editable = rec.getSublistValue({ sublistId: SUBLIST_ID, fieldId: 'custpage_editable', line: line });
        if (editable !== 'T') {
            var id = rec.getSublistValue({ sublistId: SUBLIST_ID, fieldId: 'custpage_id', line: line });
            var original = snapshot[id] || '';
            rec.setSublistValue({ sublistId: SUBLIST_ID, fieldId: 'custpage_startdate', line: line, value: original });
            alert('This Work Order is not in Released status, so its Start Date cannot be edited here.');
        }
    }

    function saveChanges() {
        var rec = currentRecordModule.get();
        var lineCount = rec.getLineCount({ sublistId: SUBLIST_ID });
        var changes = [];

        for (var i = 0; i < lineCount; i++) {
            var id = rec.getSublistValue({ sublistId: SUBLIST_ID, fieldId: 'custpage_id', line: i });
            var editable = rec.getSublistValue({ sublistId: SUBLIST_ID, fieldId: 'custpage_editable', line: i });
            var currentDate = rec.getSublistValue({ sublistId: SUBLIST_ID, fieldId: 'custpage_startdate', line: i });
            if (editable === 'T' && currentDate !== snapshot[id]) {
                changes.push({ id: id, startdate: currentDate });
            }
        }

        if (!changes.length) {
            alert('No start date changes to save.');
            return;
        }

        if (!confirm('Save ' + changes.length + ' start date change(s)? This queues a background job to update the Work Order(s).')) {
            return;
        }

        document.getElementById('custpage_changes_json').value = JSON.stringify(changes);
        document.getElementById('custpage_action').value = 'save';

        var saveButton = document.getElementById('custpage_btn_save');
        if (saveButton) {
            saveButton.disabled = true;
        }

        document.forms[0].submit();
    }

    function goToPage(action, page) {
        document.getElementById('custpage_action').value = action;
        document.getElementById('custpage_page').value = page;
        document.forms[0].submit();
    }

    return {
        pageInit: pageInit,
        fieldChanged: fieldChanged,
        saveChanges: saveChanges,
        goToPage: goToPage
    };
});
