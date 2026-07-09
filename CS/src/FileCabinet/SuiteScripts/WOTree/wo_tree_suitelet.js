/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 *
 * WOTree - Work Order Hierarchy Start Date Editor
 * Suitelet entry point / JSON router (pattern: GET renders a self-contained
 * HTML/CSS/JS page, POST is a small JSON action API the page's own vanilla
 * JS calls via fetch - no N/ui/serverWidget forms/sublists).
 *
 * Architecture (3 files, same folder):
 *   - wo_tree_suitelet.js    -> this file: entry point + JSON action router
 *   - wo_tree_html.js        -> renders the page (CSS + vanilla JS embedded)
 *   - lib/wo_tree_hierarchy.js, lib/wo_tree_constants.js -> search/tree logic
 *   - wo_tree_mr.js          -> Map/Reduce that applies queued date changes
 *
 * POST actions:
 *   - loadTree : payload {assemblyItemIds[], planningCategoryIds[],
 *                startDateFrom, startDateTo, page} -> {rows[], totalRootCount,
 *                totalRootPages, currentPage}
 *   - save     : payload {changes:[{id, startdate (ISO yyyy-mm-dd)}]} ->
 *                {queued, dropped, taskId}
 */
define([
    'N/search',
    'N/file',
    'N/record',
    'N/task',
    'N/format',
    'N/url',
    'N/runtime',
    'N/log',
    './lib/wo_tree_constants',
    './lib/wo_tree_hierarchy',
    './wo_tree_html'
], function (search, file, record, task, format, url, runtime, log, constants, hierarchy, html) {

    var STAGING_FOLDER_NAME = 'WOTree Staging';

    function onRequest(context) {
        try {
            if (context.request.method === 'GET') {
                handleGet(context);
            } else {
                handlePost(context);
            }
        } catch (e) {
            log.error('WOTree Suitelet ERROR', (e.name ? e.name + ': ' : '') + (e.message || String(e)));
            if (context.request.method === 'POST') {
                writeJson(context, { error: (e.name ? e.name + ': ' : '') + (e.message || String(e)) }, 500);
            } else {
                context.response.write('<h2>Error</h2><pre>' + escapeHtml(e.message || String(e)) + '</pre>');
            }
        }
    }

    // ---- GET: render page ---------------------------------------------

    function handleGet(context) {
        var config = constants.getConfig();
        var script = runtime.getCurrentScript();
        var suiteletUrl = url.resolveScript({
            scriptId: script.id,
            deploymentId: script.deploymentId,
            returnExternalUrl: false
        });

        var page = html.renderPage({
            suiteletUrl: suiteletUrl,
            assemblyItems: getAssemblyItemOptions(),
            planningCategories: getPlanningCategoryOptions(config)
        });

        context.response.setHeader({ name: 'Content-Type', value: 'text/html; charset=utf-8' });
        context.response.write(page);
    }

    function getAssemblyItemOptions() {
        var options = [];
        try {
            search.create({
                type: search.Type.ASSEMBLY_ITEM,
                filters: [['isinactive', 'is', 'F']],
                columns: [search.createColumn({ name: 'itemid', sort: search.Sort.ASC })]
            }).run().each(function (result) {
                options.push({ id: result.id, text: result.getValue({ name: 'itemid' }) });
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
                    options.push({ id: value, text: text || value });
                }
                return true;
            });
        } catch (e) {
            log.error('WOTree - getPlanningCategoryOptions failed (check custscript_wo_planning_cat_field parameter)', e.message);
        }
        return options;
    }

    // ---- POST: JSON action router --------------------------------------

    function handlePost(context) {
        var req = {};
        try {
            req = JSON.parse(context.request.body || '{}');
        } catch (e) {
            return writeJson(context, { error: 'Invalid JSON body.' }, 400);
        }
        var action = req.action;
        var payload = req.payload || {};

        if (action === 'loadTree') {
            return writeJson(context, actionLoadTree(payload));
        }
        if (action === 'save') {
            return writeJson(context, actionSave(payload));
        }
        return writeJson(context, { error: 'Unknown action: ' + action }, 400);
    }

    function writeJson(context, obj, status) {
        context.response.setHeader({ name: 'Content-Type', value: 'application/json; charset=utf-8' });
        if (status) {
            try { context.response.setHeader({ name: 'X-Status', value: String(status) }); } catch (e) { /* ignore */ }
        }
        context.response.write(JSON.stringify(obj));
    }

    function escapeHtml(s) {
        return String(s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    // ---- action: loadTree -----------------------------------------------

    function actionLoadTree(payload) {
        var config = constants.getConfig();
        var filters = {
            assemblyItemIds: payload.assemblyItemIds || [],
            planningCategoryIds: payload.planningCategoryIds || [],
            startDateFrom: payload.startDateFrom || '',
            startDateTo: payload.startDateTo || ''
        };
        var page = parseInt(payload.page, 10) || 1;
        var result = runHierarchySearch(config, filters, page);

        return {
            rows: result.rows.map(function (entry) { return serializeRow(entry, config); }),
            totalRootCount: result.totalRootCount,
            totalRootPages: result.totalRootPages,
            currentPage: result.currentPage
        };
    }

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

    function serializeRow(entry, config) {
        var row = entry.row;
        return {
            id: row.id,
            tranId: row.tranId,
            assemblyItemText: row.assemblyItemText || '',
            assemblyItemDisplayName: row.assemblyItemDisplayName || '',
            statusText: row.statusText || '',
            quantity: row.quantity || '',
            startDate: row.startDate || '',
            startDateIso: toIsoDate(row.startDate),
            endDate: row.endDate || '',
            depth: entry.depth,
            isRoot: entry.isRoot,
            editable: row.status === config.statusReleased || isReleasedLabel(row.statusText)
        };
    }

    // NetSuite search results return dates as a string formatted per the
    // user's date preference (e.g. "7/9/2026") - convert to ISO yyyy-mm-dd
    // for <input type="date">, whose value attribute always requires ISO
    // regardless of locale.
    function toIsoDate(displayValue) {
        if (!displayValue) {
            return '';
        }
        try {
            var d = format.parse({ value: displayValue, type: format.Type.DATE });
            var y = d.getFullYear();
            var m = ('0' + (d.getMonth() + 1)).slice(-2);
            var day = ('0' + d.getDate()).slice(-2);
            return y + '-' + m + '-' + day;
        } catch (e) {
            return '';
        }
    }

    // ---- action: save -----------------------------------------------------

    function actionSave(payload) {
        var config = constants.getConfig();
        var changes = (payload.changes || []).filter(function (c) {
            return c && c.id && c.startdate;
        });

        // Never trust the client's notion of "editable" alone - status may
        // have changed since page load, and the client can't be trusted for
        // data integrity anyway.
        var validated = filterChangesByCurrentStatus(changes, config);
        var droppedCount = changes.length - validated.length;

        if (!validated.length) {
            return { queued: 0, dropped: droppedCount, taskId: null };
        }

        var fileId = stageChangesFile(validated);
        var taskId = queueMapReduce(fileId, config);
        return { queued: validated.length, dropped: droppedCount, taskId: taskId };
    }

    function filterChangesByCurrentStatus(changes, config) {
        if (!changes.length) {
            return [];
        }
        var ids = changes.map(function (c) { return c.id; });
        var statusById = {};
        var statusTextById = {};
        search.create({
            type: 'workorder',
            filters: [
                search.createFilter({ name: 'mainline', operator: search.Operator.IS, values: true }),
                search.createFilter({ name: 'internalid', operator: search.Operator.ANYOF, values: ids })
            ],
            columns: ['internalid', 'status']
        }).run().each(function (result) {
            var id = result.getValue({ name: 'internalid' });
            statusById[id] = result.getValue({ name: 'status' });
            statusTextById[id] = result.getText({ name: 'status' });
            return true;
        });
        return changes.filter(function (c) {
            return statusById[c.id] === config.statusReleased || isReleasedLabel(statusTextById[c.id]);
        });
    }

    // The internal status key (e.g. "WorkOrd:B") has already proven fragile
    // to guess/verify correctly; the "Released" display label is what we've
    // actually confirmed renders correctly, so treat either match as
    // authoritative rather than trusting the internal key alone.
    function isReleasedLabel(text) {
        return String(text || '').trim().toLowerCase() === 'released';
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
