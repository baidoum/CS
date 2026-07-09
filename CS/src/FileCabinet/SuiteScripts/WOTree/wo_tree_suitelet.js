/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 *
 * WOTree - Work Order Hierarchy Start Date Editor
 *
 * Lists Released Work Orders (as roots) together with their full createdfrom
 * sub-assembly descendant chain (WO-to-WO links only), flattened into a single
 * inline-editable sublist with a visual indent per depth level - chosen over
 * one-sublist-per-root for performance at "hundreds" of Work Orders.
 *
 * Only rows whose status matches the configured "Released" value are
 * editable; non-Released descendants are shown read-only for context. Saves
 * are queued to a Map/Reduce script (wo_tree_mr.js) rather than applied
 * synchronously, so this stays safe regardless of how many rows changed.
 *
 * Several internal IDs below (Released status value, item search join id,
 * Planning Item Category field id) are configurable via Script Parameters
 * with best-guess defaults that have not been verified against a live
 * account. Run wo_field_discovery_sl.js once after deploying to confirm or
 * correct them - no code changes needed either way.
 */
define([
    'N/ui/serverWidget',
    'N/ui/message',
    'N/search',
    'N/file',
    'N/record',
    'N/task',
    'N/log',
    './lib/wo_tree_constants',
    './lib/wo_tree_hierarchy'
], function (serverWidget, message, search, file, record, task, log, constants, hierarchy) {

    var SUBLIST_ID = 'custpage_wolist';
    var STAGING_FOLDER_NAME = 'WOTree Staging';

    function onRequest(context) {
        var action = context.request.parameters.custpage_action;
        if (context.request.method === 'POST' && action === 'save') {
            handleSave(context);
            return;
        }
        renderSearchPage(context);
    }

    // ---- Page rendering ----------------------------------------------------

    function renderSearchPage(context, extra) {
        extra = extra || {};
        var config = constants.getConfig();
        var filters = getFiltersFromRequest(context.request);
        var requestedPage = parseInt(context.request.parameters.custpage_page, 10) || 1;

        var searchResult = runHierarchySearch(config, filters, requestedPage);

        var form = serverWidget.createForm({ title: 'Work Order Hierarchy - Start Date Editor' });
        form.clientScriptModulePath = './wo_tree_client.js';

        addHiddenControlFields(form, searchResult.currentPage);
        addFilterFields(form, config, filters);

        if (extra.confirmationMessage) {
            form.addPageInitMessage({
                type: message.Type.CONFIRMATION,
                title: 'Save Result',
                message: extra.confirmationMessage
            });
        }

        addResultsSublist(form, searchResult.rows, config);
        addPaginationInfo(form, searchResult.currentPage, searchResult.totalRootPages, searchResult.totalRootCount);
        addActionButtons(form);

        context.response.writePage(form);
    }

    function getFiltersFromRequest(request) {
        var params = request.parameters;
        return {
            assemblyItemIds: splitMultiselect(params.custpage_assembly_item),
            planningCategoryIds: splitMultiselect(params.custpage_planning_category),
            startDateFrom: params.custpage_date_from || '',
            startDateTo: params.custpage_date_to || ''
        };
    }

    function splitMultiselect(value) {
        if (!value) {
            return [];
        }
        return String(value).split(',').filter(function (v) { return v; });
    }

    function addHiddenControlFields(form, currentPage) {
        form.addField({ id: 'custpage_action', type: serverWidget.FieldType.TEXT, label: 'Action' })
            .updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });

        var pageField = form.addField({ id: 'custpage_page', type: serverWidget.FieldType.INTEGER, label: 'Page' });
        pageField.updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
        pageField.defaultValue = String(currentPage);

        form.addField({ id: 'custpage_changes_json', type: serverWidget.FieldType.LONGTEXT, label: 'Changes JSON' })
            .updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
    }

    function addFilterFields(form, config, filters) {
        form.addFieldGroup({ id: 'custpage_filters', label: 'Filters' });

        var assemblyField = form.addField({
            id: 'custpage_assembly_item',
            type: serverWidget.FieldType.MULTISELECT,
            label: 'Assembly Item',
            container: 'custpage_filters'
        });
        getAssemblyItemOptions().forEach(function (opt) {
            assemblyField.addSelectOption({ value: opt.value, text: opt.text });
        });
        if (filters.assemblyItemIds.length) {
            assemblyField.defaultValue = filters.assemblyItemIds.join(',');
        }

        var categoryField = form.addField({
            id: 'custpage_planning_category',
            type: serverWidget.FieldType.MULTISELECT,
            label: 'Planning Item Category',
            container: 'custpage_filters'
        });
        getPlanningCategoryOptions(config).forEach(function (opt) {
            categoryField.addSelectOption({ value: opt.value, text: opt.text });
        });
        if (filters.planningCategoryIds.length) {
            categoryField.defaultValue = filters.planningCategoryIds.join(',');
        }

        var dateFromField = form.addField({
            id: 'custpage_date_from',
            type: serverWidget.FieldType.DATE,
            label: 'Start Date From',
            container: 'custpage_filters'
        });
        if (filters.startDateFrom) {
            dateFromField.defaultValue = filters.startDateFrom;
        }

        var dateToField = form.addField({
            id: 'custpage_date_to',
            type: serverWidget.FieldType.DATE,
            label: 'Start Date To',
            container: 'custpage_filters'
        });
        if (filters.startDateTo) {
            dateToField.defaultValue = filters.startDateTo;
        }
    }

    // Options are discovered live from actual item data rather than assumed
    // from a guessed "source" list id - avoids one more unverifiable internal ID.
    function getAssemblyItemOptions() {
        var options = [];
        try {
            search.create({
                type: search.Type.ASSEMBLY_ITEM,
                filters: [['isinactive', 'is', 'F']],
                columns: [search.createColumn({ name: 'itemid', sort: search.Sort.ASC })]
            }).run().each(function (result) {
                options.push({ value: result.id, text: result.getValue({ name: 'itemid' }) });
                return true;
            });
        } catch (e) {
            log.error('WOTree - getAssemblyItemOptions failed', e.message);
        }
        return options;
    }

    function getPlanningCategoryOptions(config) {
        var options = [];
        var seen = {};
        try {
            search.create({
                type: search.Type.ITEM,
                filters: [[config.planningCategoryField, 'noneof', '@NONE@']],
                columns: [search.createColumn({ name: config.planningCategoryField, summary: search.Summary.GROUP })]
            }).run().each(function (result) {
                var value = result.getValue({ name: config.planningCategoryField, summary: search.Summary.GROUP });
                var text = result.getText({ name: config.planningCategoryField, summary: search.Summary.GROUP });
                if (value && !seen[value]) {
                    seen[value] = true;
                    options.push({ value: value, text: text || value });
                }
                return true;
            });
        } catch (e) {
            log.error('WOTree - getPlanningCategoryOptions failed (check custscript_wo_planning_cat_field parameter)', e.message);
        }
        return options;
    }

    // ---- Hierarchy search ---------------------------------------------------

    function runHierarchySearch(config, filters, requestedPage) {
        var allMatches = hierarchy.fetchRootCandidates(config, filters);
        var roots = allMatches.filter(hierarchy.isRoot);

        var pageSize = config.pageRootSize > 0 ? config.pageRootSize : 50;
        var totalRootPages = Math.max(1, Math.ceil(roots.length / pageSize));
        var currentPage = Math.min(Math.max(requestedPage, 1), totalRootPages);
        var pageRoots = roots.slice((currentPage - 1) * pageSize, currentPage * pageSize);
        var pageRootIds = pageRoots.map(function (r) { return r.id; });

        var descendants = hierarchy.fetchDescendants(pageRootIds, config);
        var tree = hierarchy.buildTree(pageRoots, descendants);
        var flatRows = hierarchy.flattenDepthFirst(pageRootIds, tree.idToRow, tree.childrenMap);

        return {
            rows: flatRows,
            totalRootCount: roots.length,
            totalRootPages: totalRootPages,
            currentPage: currentPage
        };
    }

    // ---- Results sublist ---------------------------------------------------

    function addResultsSublist(form, rows, config) {
        var sublist = form.addSublist({
            id: SUBLIST_ID,
            type: serverWidget.SublistType.INLINEEDITOR,
            label: 'Work Orders (' + rows.length + ' row(s) on this page)'
        });

        sublist.addField({ id: 'custpage_hierarchy', type: serverWidget.FieldType.TEXT, label: 'Work Order' });
        sublist.addField({ id: 'custpage_assemblyitem', type: serverWidget.FieldType.TEXT, label: 'Assembly Item' });
        sublist.addField({ id: 'custpage_statustext', type: serverWidget.FieldType.TEXT, label: 'Status' });
        sublist.addField({ id: 'custpage_quantity', type: serverWidget.FieldType.TEXT, label: 'Qty' });
        sublist.addField({ id: 'custpage_enddate', type: serverWidget.FieldType.TEXT, label: 'End Date' });
        sublist.addField({ id: 'custpage_startdate', type: serverWidget.FieldType.DATE, label: 'Start Date' });
        sublist.addField({ id: 'custpage_id', type: serverWidget.FieldType.TEXT, label: 'Internal ID' });
        sublist.addField({ id: 'custpage_editable', type: serverWidget.FieldType.TEXT, label: 'Editable' });

        // custpage_startdate is intentionally left ENTRY (editable); every
        // other column is forced to INLINE/HIDDEN so INLINEEDITOR doesn't
        // make them editable too. sublist.addField() returns the sublist
        // itself (for chaining), not a Field object - sublist.getField()
        // is what actually returns the Field to call updateDisplayType() on.
        [
            'custpage_hierarchy', 'custpage_assemblyitem', 'custpage_statustext',
            'custpage_quantity', 'custpage_enddate'
        ].forEach(function (id) {
            sublist.getField({ id: id }).updateDisplayType({ displayType: serverWidget.FieldDisplayType.INLINE });
        });
        ['custpage_id', 'custpage_editable'].forEach(function (id) {
            sublist.getField({ id: id }).updateDisplayType({ displayType: serverWidget.FieldDisplayType.HIDDEN });
        });

        // NetSuite's setSublistValue treats an empty string as a *missing*
        // argument (SSS_MISSING_REQD_ARGUMENT), not a valid blank value -
        // skip the call entirely when there's nothing to display, leaving
        // that cell at its (blank) default instead.
        function setCell(fieldId, line, value) {
            if (value === null || value === undefined || value === '') {
                return;
            }
            sublist.setSublistValue({ id: fieldId, line: line, value: value });
        }

        rows.forEach(function (entry, index) {
            var row = entry.row;
            var isReleased = row.status === config.statusReleased;
            setCell('custpage_hierarchy', index,
                hierarchy.indentLabel(entry.depth) + row.tranId + (entry.isRoot ? ' (Root)' : ''));
            setCell('custpage_assemblyitem', index, row.assemblyItemText);
            setCell('custpage_statustext', index, row.statusText);
            setCell('custpage_quantity', index, row.quantity);
            setCell('custpage_enddate', index, row.endDate);
            setCell('custpage_startdate', index, row.startDate);
            setCell('custpage_id', index, row.id);
            setCell('custpage_editable', index, isReleased ? 'T' : 'F');
        });
    }

    function addPaginationInfo(form, currentPage, totalPages, totalRootCount) {
        var infoField = form.addField({ id: 'custpage_paging_info', type: serverWidget.FieldType.INLINEHTML, label: ' ' });
        infoField.defaultValue = '<p>Page ' + currentPage + ' of ' + totalPages + ' - ' + totalRootCount +
            ' top-level Work Order(s) match the current filters.</p>';

        if (currentPage > 1) {
            form.addButton({
                id: 'custpage_btn_prev',
                label: 'Previous Page',
                functionName: "goToPage('search', " + (currentPage - 1) + ")"
            });
        }
        if (currentPage < totalPages) {
            form.addButton({
                id: 'custpage_btn_next',
                label: 'Next Page',
                functionName: "goToPage('search', " + (currentPage + 1) + ")"
            });
        }
    }

    function addActionButtons(form) {
        form.addButton({ id: 'custpage_btn_search', label: 'Search', functionName: "goToPage('search', 1)" });
        form.addButton({ id: 'custpage_btn_save', label: 'Save Changes', functionName: 'saveChanges' });
    }

    // ---- Save handling ---------------------------------------------------

    function handleSave(context) {
        var config = constants.getConfig();
        var changes = [];
        try {
            changes = JSON.parse(context.request.parameters.custpage_changes_json || '[]');
        } catch (e) {
            changes = [];
        }

        // Never trust the client-side "editable" flag alone - status may have
        // changed since page load, and native sublists can't fully lock a cell.
        var validated = filterChangesByCurrentStatus(changes, config);
        var droppedCount = changes.length - validated.length;
        var confirmationMessage;

        if (!validated.length) {
            confirmationMessage = 'No valid changes were saved.' +
                (droppedCount ? ' ' + droppedCount + ' row(s) were skipped because they are no longer in Released status.' : '');
        } else {
            var fileId = stageChangesFile(validated);
            var taskId = queueMapReduce(fileId, config);
            confirmationMessage = validated.length + ' start date change(s) queued for background processing (Job ID: ' + taskId + ').' +
                (droppedCount ? ' ' + droppedCount + ' row(s) were skipped because they are no longer in Released status.' : '') +
                ' Check Customization > Scripting > Script Deployments > Map/Reduce Status for progress.';
        }

        renderSearchPage(context, { confirmationMessage: confirmationMessage });
    }

    function filterChangesByCurrentStatus(changes, config) {
        if (!changes.length) {
            return [];
        }
        var ids = changes.map(function (c) { return c.id; });
        var statusById = {};
        search.create({
            type: 'workorder',
            filters: [['internalid', 'anyof', ids]],
            columns: ['internalid', 'status']
        }).run().each(function (result) {
            statusById[result.getValue({ name: 'internalid' })] = result.getValue({ name: 'status' });
            return true;
        });
        return changes.filter(function (c) {
            return statusById[c.id] === config.statusReleased;
        });
    }

    function stageChangesFile(validated) {
        var folderId = getOrCreateStagingFolder();
        var newFile = file.create({
            name: 'wotree_changes_' + new Date().getTime() + '.json',
            fileType: file.Type.JSON,
            contents: JSON.stringify(validated),
            folder: folderId
        });
        return newFile.save();
    }

    function getOrCreateStagingFolder() {
        var folderId = null;
        search.create({
            type: 'folder',
            filters: [['name', 'is', STAGING_FOLDER_NAME]],
            columns: ['internalid']
        }).run().each(function (result) {
            folderId = result.getValue({ name: 'internalid' });
            return false;
        });
        if (folderId) {
            return folderId;
        }
        var folderRecord = record.create({ type: record.Type.FOLDER });
        folderRecord.setValue({ fieldId: 'name', value: STAGING_FOLDER_NAME });
        return folderRecord.save();
    }

    function queueMapReduce(fileId, config) {
        var mrTask = task.create({
            taskType: task.TaskType.MAP_REDUCE,
            scriptId: config.mrScriptId,
            params: {
                custscript_mr_staging_file_id: fileId
            }
        });
        return mrTask.submit();
    }

    return { onRequest: onRequest };
});
