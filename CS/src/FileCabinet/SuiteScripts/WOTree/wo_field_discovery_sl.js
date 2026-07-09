/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * One-time diagnostic tool - run this once after deploying WOTree, then
 * deactivate or delete it. It writes to the script execution log (does not
 * touch any data) the real field ids/values needed to correct
 * wo_tree_suitelet.js's script parameters if the defaults guessed in this
 * project don't match this account:
 *   - a sample Work Order's field ids/values (createdfrom, status, etc.)
 *   - every distinct Work Order status internal value paired with its label
 *   - Item fields whose label mentions "planning" or "category"
 *   - whether the "assemblyitem" / "item" search join ids resolve cleanly
 */
define(['N/ui/serverWidget', 'N/record', 'N/search', 'N/log'], function (serverWidget, record, search, log) {

    function onRequest(context) {
        if (context.request.method !== 'GET') {
            context.response.write('Use GET.');
            return;
        }

        runDiagnostics();

        var form = serverWidget.createForm({ title: 'WOTree Field Discovery' });
        form.addField({
            id: 'custpage_result',
            type: serverWidget.FieldType.INLINEHTML,
            label: ' '
        }).defaultValue = '<p>Diagnostics complete. Open this script deployment\'s execution log ' +
            '(Customization &gt; Scripting &gt; Script Deployments, or the Execution Log portlet) ' +
            'to view the results, then correct wo_tree_suitelet.js\'s script parameters if needed.</p>';
        context.response.writePage(form);
    }

    function runDiagnostics() {
        logSampleWorkOrderFields();
        logWorkOrderStatusValues();
        logSampleItemPlanningFields();
        logJoinCandidates();
    }

    function logSampleWorkOrderFields() {
        try {
            var woId = findMostRecentId('workorder');
            if (!woId) {
                log.audit('WOTree Discovery - Work Order', 'No Work Order records found in this account.');
                return;
            }
            var wo = record.load({ type: 'workorder', id: woId });
            var details = wo.getFields().map(function (id) {
                var value;
                try {
                    value = wo.getValue({ fieldId: id });
                } catch (e) {
                    value = '(unreadable)';
                }
                return id + ' = ' + value;
            });
            log.audit('WOTree Discovery - Work Order ' + woId + ' fields', details.join(' | '));
            log.audit('WOTree Discovery - createdfrom', 'value=' + wo.getValue({ fieldId: 'createdfrom' }) +
                ', text=' + wo.getText({ fieldId: 'createdfrom' }));
        } catch (e) {
            log.error('WOTree Discovery - Work Order sample failed', e.message);
        }
    }

    function logWorkOrderStatusValues() {
        try {
            var statusPairs = [];
            search.create({
                type: 'workorder',
                filters: [],
                columns: [search.createColumn({ name: 'status', summary: search.Summary.GROUP })]
            }).run().each(function (result) {
                statusPairs.push(
                    result.getValue({ name: 'status', summary: search.Summary.GROUP }) +
                    ' => "' + result.getText({ name: 'status', summary: search.Summary.GROUP }) + '"'
                );
                return true;
            });
            log.audit('WOTree Discovery - distinct Work Order status values', statusPairs.join(' | ') || '(no work orders found)');
        } catch (e) {
            log.error('WOTree Discovery - status discovery failed', e.message);
        }
    }

    function logSampleItemPlanningFields() {
        try {
            // N/record does not accept the generic 'item' type used by N/search -
            // it requires a specific item subtype. Assembly Item is what WOs
            // actually reference, so sample one of those specifically.
            var itemId = findMostRecentId(search.Type.ASSEMBLY_ITEM);
            if (!itemId) {
                log.audit('WOTree Discovery - Item', 'No Assembly Item records found in this account.');
                return;
            }
            var item = record.load({ type: search.Type.ASSEMBLY_ITEM, id: itemId });
            var planningFields = item.getFields().filter(function (id) {
                var lower = id.toLowerCase();
                return lower.indexOf('planning') !== -1 || lower.indexOf('category') !== -1;
            });
            var details = planningFields.map(function (id) {
                var value;
                try {
                    value = item.getValue({ fieldId: id });
                } catch (e) {
                    value = '(unreadable)';
                }
                return id + ' = ' + value;
            });
            log.audit('WOTree Discovery - Item ' + itemId + ' planning/category-like fields',
                details.join(' | ') || '(none found matching "planning" or "category")');
        } catch (e) {
            log.error('WOTree Discovery - Item sample failed', e.message);
        }
    }

    function logJoinCandidates() {
        ['assemblyitem', 'item'].forEach(function (joinId) {
            try {
                var range = search.create({
                    type: 'workorder',
                    filters: [],
                    columns: [search.createColumn({ name: 'itemid', join: joinId })]
                }).run().getRange({ start: 0, end: 1 });
                var sample = range[0] ? range[0].getValue({ name: 'itemid', join: joinId }) : '(no work orders to sample)';
                log.audit('WOTree Discovery - join candidate "' + joinId + '"', 'resolved OK, sample itemid=' + sample);
            } catch (e) {
                log.audit('WOTree Discovery - join candidate "' + joinId + '"', 'FAILED: ' + e.message);
            }
        });
    }

    function findMostRecentId(type) {
        var foundId = null;
        search.create({
            type: type,
            filters: [],
            columns: [search.createColumn({ name: 'internalid', sort: search.Sort.DESC })]
        }).run().each(function (result) {
            foundId = result.getValue({ name: 'internalid' });
            return false;
        });
        return foundId;
    }

    return { onRequest: onRequest };
});
