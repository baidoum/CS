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
 *   - loadTree           : payload {itemSearchText, planningCategoryIds[],
 *                          startDateFrom, startDateTo, page, sortField,
 *                          sortDir} -> {rows[], totalRootCount,
 *                          totalRootPages, currentPage}
 *   - save               : payload {changes:[{id, startdate (ISO yyyy-mm-dd)}]}
 *                          -> {queued, dropped, taskId, stagingFileId}
 *   - checkStatus        : payload {taskId, stagingFileId} -> {status, ...}
 *   - searchItems        : payload {q} -> {items:[{id,itemid,displayname}]}
 *   - loadQuantityByWeek : payload {itemIds[]} -> {weeks:[{weekStart,
 *                          values:{itemId:qty}}], items:[{id,itemid,
 *                          displayname}]}
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
            planningCategories: getPlanningCategoryOptions(config)
        });

        context.response.setHeader({ name: 'Content-Type', value: 'text/html; charset=utf-8' });
        context.response.write(page);
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
        if (action === 'checkStatus') {
            return writeJson(context, actionCheckStatus(payload));
        }
        if (action === 'searchItems') {
            return writeJson(context, actionSearchItems(payload));
        }
        if (action === 'loadQuantityByWeek') {
            return writeJson(context, actionLoadQuantityByWeek(payload));
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
            itemSearchText: (payload.itemSearchText || '').trim(),
            planningCategoryIds: payload.planningCategoryIds || [],
            startDateFrom: payload.startDateFrom || '',
            startDateTo: payload.startDateTo || ''
        };
        var page = parseInt(payload.page, 10) || 1;
        var result = runHierarchySearch(config, filters, page, payload.sortField, payload.sortDir);

        return {
            rows: result.rows.map(function (entry) { return serializeRow(entry, config); }),
            totalRootCount: result.totalRootCount,
            totalRootPages: result.totalRootPages,
            currentPage: result.currentPage
        };
    }

    // Sorting applies to the ROOT groups only - each root's descendants
    // stay attached directly beneath it in their existing depth-first order,
    // since resorting them independently would break the tree indentation.
    function sortRoots(roots, sortField, sortDir) {
        if (!sortField) {
            return roots;
        }
        var dir = sortDir === 'desc' ? -1 : 1;
        return roots.slice().sort(function (a, b) {
            var av = getSortValue(a, sortField);
            var bv = getSortValue(b, sortField);
            if (av < bv) return -1 * dir;
            if (av > bv) return 1 * dir;
            return 0;
        });
    }

    function getSortValue(row, field) {
        switch (field) {
            case 'assemblyItemText': return (row.assemblyItemText || '').toLowerCase();
            case 'assemblyItemDisplayName': return (row.assemblyItemDisplayName || '').toLowerCase();
            case 'statusText': return (row.statusText || '').toLowerCase();
            case 'quantity': return parseFloat(row.quantity) || 0;
            case 'startDate': return parseDateForSort(row.startDate);
            case 'endDate': return parseDateForSort(row.endDate);
            case 'tranId':
            default: return (row.tranId || '').toLowerCase();
        }
    }

    function parseDateForSort(displayValue) {
        if (!displayValue) {
            return 0;
        }
        try {
            return format.parse({ value: displayValue, type: format.Type.DATE }).getTime();
        } catch (e) {
            return 0;
        }
    }

    function runHierarchySearch(config, filters, requestedPage, sortField, sortDir) {
        var allMatches = hierarchy.fetchRootCandidates(config, filters);
        var candidateRoots = allMatches.filter(hierarchy.isRoot);
        // Matches anywhere in a root's subtree (not just the root's own
        // item) - a typed item could be the root's own assembly item, or a
        // sub-assembly component several levels down, and the user has no
        // way to know which before searching.
        var itemFilteredRoots = hierarchy.filterRootsByItemSearch(config, candidateRoots, filters.itemSearchText);
        var roots = sortRoots(itemFilteredRoots, sortField, sortDir);

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
        return { queued: validated.length, dropped: droppedCount, taskId: taskId, stagingFileId: fileId };
    }

    // ---- action: checkStatus -----------------------------------------------
    // The save is queued to a Map/Reduce job (never applied synchronously),
    // so the UI polls this after saving instead of immediately reloading the
    // tree - reloading right away would show the still-unchanged record and
    // look like the edit reverted.

    function actionCheckStatus(payload) {
        var taskId = payload.taskId;
        if (!taskId) {
            return { status: 'UNKNOWN' };
        }
        var status;
        try {
            status = task.checkStatus({ taskId: taskId });
        } catch (e) {
            return { status: 'UNKNOWN', error: e.message };
        }

        var result = { status: status.status };
        if (status.status === task.TaskStatus.COMPLETE || status.status === task.TaskStatus.FAILED) {
            var resultData = loadResultForStagingFile(payload.stagingFileId);
            if (resultData) {
                result.succeeded = resultData.succeeded;
                result.failed = resultData.failed;
                result.errors = resultData.errors;
            }
        }
        return result;
    }

    function loadResultForStagingFile(stagingFileId) {
        if (!stagingFileId) {
            return null;
        }
        try {
            var stagingFile = file.load({ id: stagingFileId });
            var resultName = stagingFile.name.replace(/\.json$/i, '_result.json');
            var resultFileId = null;
            search.create({
                type: 'file',
                filters: [['name', 'is', resultName]],
                columns: ['internalid']
            }).run().each(function (result) {
                resultFileId = result.getValue({ name: 'internalid' });
                return false;
            });
            if (!resultFileId) {
                return null;
            }
            var resultFile = file.load({ id: resultFileId });
            return JSON.parse(resultFile.getContents() || '{}');
        } catch (e) {
            log.error('WOTree - loadResultForStagingFile failed', e.message);
            return null;
        }
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

    // ---- action: searchItems (autocomplete for the Quantity by Week tab) --
    //
    // Scoped to assembly items that actually appear on a Released Work
    // Order - not the whole item catalog. Two reasons: (1) most items in a
    // catalog are never built via a WO (raw materials, services, ...), so
    // catalog-wide search surfaced mostly irrelevant suggestions; (2) an
    // item that was marked inactive after its Work Orders were created
    // would silently vanish from an isinactive=F catalog search even
    // though it still has real Released Work Orders - this way, the WO's
    // own history defines relevance, not the item's current active flag.

    function actionSearchItems(payload) {
        var config = constants.getConfig();
        var q = (payload.q || '').trim();
        if (q.length < 2) {
            return { items: [] };
        }
        var words = hierarchy.normalizeForSearch(q).split(' ').filter(function (w) { return w; }).slice(0, 6);
        var seen = {};
        var results = [];
        search.create({
            type: 'workorder',
            filters: [
                search.createFilter({ name: 'mainline', operator: search.Operator.IS, values: true }),
                search.createFilter({ name: 'status', operator: search.Operator.ANYOF, values: [config.statusReleased] })
            ],
            columns: [
                search.createColumn({ name: 'item' }),
                search.createColumn({ name: 'displayname', join: config.itemJoinId })
            ]
        }).run().each(function (result) {
            var id = result.getValue({ name: 'item' });
            if (!id || seen[id]) {
                return true;
            }
            var itemid = result.getText({ name: 'item' }) || '';
            var displayname = result.getValue({ name: 'displayname', join: config.itemJoinId }) || '';
            var haystack = hierarchy.normalizeForSearch(itemid + ' ' + displayname);
            var matchesAll = words.every(function (w) { return haystack.indexOf(w) !== -1; });
            if (matchesAll) {
                seen[id] = true;
                results.push({ id: id, itemid: itemid, displayname: displayname });
            }
            return results.length < 50;
        });
        return { items: results };
    }

    // ---- action: loadQuantityByWeek ---------------------------------------

    function actionLoadQuantityByWeek(payload) {
        var config = constants.getConfig();
        var itemIds = (payload.itemIds || []).filter(function (id) { return id; });
        if (!itemIds.length) {
            return { weeks: [], items: [] };
        }

        var itemMeta = getItemMeta(itemIds);
        var rawRows = hierarchy.fetchQuantityRows(config, itemIds);

        var totalsByWeek = {}; // weekStartIso -> itemId -> qty
        var weekDateByIso = {}; // weekStartIso -> Date

        rawRows.forEach(function (row) {
            var d = parseDisplayDate(row.startDate);
            if (!d) {
                return;
            }
            var weekStart = getWeekStart(d);
            var weekIso = formatIsoDate(weekStart);
            if (!totalsByWeek[weekIso]) {
                totalsByWeek[weekIso] = {};
                weekDateByIso[weekIso] = weekStart;
            }
            totalsByWeek[weekIso][row.itemId] = (totalsByWeek[weekIso][row.itemId] || 0) + (parseFloat(row.quantity) || 0);
        });

        var isos = Object.keys(weekDateByIso).sort();
        var weeks = [];
        if (isos.length) {
            var cursor = weekDateByIso[isos[0]];
            var last = weekDateByIso[isos[isos.length - 1]];
            while (cursor.getTime() <= last.getTime()) {
                var weekIso = formatIsoDate(cursor);
                var rowTotals = totalsByWeek[weekIso] || {};
                var values = {};
                itemIds.forEach(function (id) { values[id] = rowTotals[id] || 0; });
                weeks.push({ weekStart: weekIso, values: values });
                cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 7);
            }
        }

        return {
            weeks: weeks,
            items: itemIds.map(function (id) {
                return itemMeta[id] || { id: id, itemid: '?', displayname: '' };
            })
        };
    }

    function getItemMeta(itemIds) {
        var meta = {};
        search.create({
            type: search.Type.ITEM,
            filters: [['internalid', 'anyof', itemIds]],
            columns: ['itemid', 'displayname']
        }).run().each(function (result) {
            meta[result.id] = {
                id: result.id,
                itemid: result.getValue({ name: 'itemid' }) || '',
                displayname: result.getValue({ name: 'displayname' }) || ''
            };
            return true;
        });
        return meta;
    }

    function parseDisplayDate(displayValue) {
        if (!displayValue) {
            return null;
        }
        try {
            return format.parse({ value: displayValue, type: format.Type.DATE });
        } catch (e) {
            return null;
        }
    }

    // Monday of the week containing the given date (French/European
    // convention), at local midnight.
    function getWeekStart(date) {
        var d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
        var day = d.getDay(); // 0=Sun, 1=Mon, ... 6=Sat
        var diff = day === 0 ? -6 : 1 - day;
        d.setDate(d.getDate() + diff);
        return d;
    }

    function formatIsoDate(d) {
        var m = ('0' + (d.getMonth() + 1)).slice(-2);
        var day = ('0' + d.getDate()).slice(-2);
        return d.getFullYear() + '-' + m + '-' + day;
    }

    return { onRequest: onRequest };
});
