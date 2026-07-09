/**
 * @NApiVersion 2.1
 *
 * WOTree hierarchy module. Builds the Work Order createdfrom tree using
 * breadth-first level expansion (one search per tree depth level, covering an
 * entire level at once) rather than one search per node - this keeps the
 * search-call count roughly proportional to tree DEPTH, not tree SIZE, which
 * matters once there are hundreds of Work Orders in scope.
 */
define(['N/search', 'N/log'], function (search, log) {

    var MAX_RESULTS_PER_SEARCH = 4000; // hard cap of search.run().each()
    var MAX_TREE_DEPTH = 25; // safety net against bad/cyclical createdfrom data

    function getStandardColumns(config) {
        return [
            search.createColumn({ name: 'internalid' }),
            search.createColumn({ name: 'tranid' }),
            search.createColumn({ name: 'createdfrom' }),
            search.createColumn({ name: 'status' }),
            search.createColumn({ name: 'startdate' }),
            search.createColumn({ name: 'enddate' }),
            // The record-level body field is "assemblyitem", but on a
            // workorder SEARCH the same data is exposed as "item" - confirmed
            // via wo_field_discovery_sl.js (assemblyitem errors as a search
            // column/join id in this account, item resolves).
            search.createColumn({ name: 'item' }),
            search.createColumn({ name: 'displayname', join: config.itemJoinId }),
            search.createColumn({ name: 'quantity' })
        ];
    }

    function resultToRow(result, config) {
        return {
            id: result.getValue({ name: 'internalid' }),
            tranId: result.getValue({ name: 'tranid' }),
            createdFromId: result.getValue({ name: 'createdfrom' }) || '',
            // NetSuite's display text for a transaction reference field is
            // prefixed with the record type name (e.g. "Work Order #123"),
            // which is a more reliable way to detect "is this a WO" than a
            // search join on a polymorphic transaction field.
            createdFromText: result.getText({ name: 'createdfrom' }) || '',
            status: result.getValue({ name: 'status' }),
            statusText: result.getText({ name: 'status' }),
            startDate: result.getValue({ name: 'startdate' }),
            endDate: result.getValue({ name: 'enddate' }),
            assemblyItemText: result.getText({ name: 'item' }),
            assemblyItemDisplayName: result.getValue({ name: 'displayname', join: config.itemJoinId }) || '',
            quantity: result.getValue({ name: 'quantity' })
        };
    }

    function buildRootFilters(config, filters) {
        var f = [];
        // Without this, a transaction search returns one row PER LINE, not
        // one per transaction - a Work Order with 7 component lines would
        // come back as 7 duplicate "root" rows, each spawning its own
        // repeated copy of the whole subtree beneath it.
        f.push(search.createFilter({ name: 'mainline', operator: search.Operator.IS, values: true }));
        f.push(search.createFilter({ name: 'status', operator: search.Operator.ANYOF, values: [config.statusReleased] }));

        // itemSearchText (code OR display name) is applied as a JS post-filter
        // in fetchRootCandidates, not here - mixing search.Filter objects with
        // a nested ['OR', ...] grouping in the same filters array is rejected
        // by N/search ("WRONG_PARAMETER_TYPE: filters is expected as Array"),
        // and both fields are already fetched per row anyway.

        if (filters.planningCategoryIds && filters.planningCategoryIds.length) {
            f.push(search.createFilter({
                name: config.planningCategoryField,
                join: config.itemJoinId,
                operator: search.Operator.ANYOF,
                values: filters.planningCategoryIds
            }));
        }

        if (filters.startDateFrom) {
            f.push(search.createFilter({ name: 'startdate', operator: search.Operator.ONORAFTER, values: [filters.startDateFrom] }));
        }

        if (filters.startDateTo) {
            f.push(search.createFilter({ name: 'startdate', operator: search.Operator.ONORBEFORE, values: [filters.startDateTo] }));
        }

        return f;
    }

    // Fetches every Released Work Order matching the given filters. This is
    // the candidate pool for ROOTS - callers must still post-filter with
    // isRoot() since "matches the filters" and "is a root" are independent.
    function fetchRootCandidates(config, filters) {
        var rows = [];
        search.create({
            type: 'workorder',
            filters: buildRootFilters(config, filters),
            columns: getStandardColumns(config)
        }).run().each(function (result) {
            rows.push(resultToRow(result, config));
            return rows.length < MAX_RESULTS_PER_SEARCH;
        });

        if (rows.length >= MAX_RESULTS_PER_SEARCH) {
            log.audit('WOTree', 'Root candidate search hit the ' + MAX_RESULTS_PER_SEARCH +
                '-result cap; some matching root Work Orders may be missing. Narrow the filters or reduce the page size.');
        }

        if (filters.itemSearchText) {
            var needle = filters.itemSearchText.toLowerCase();
            rows = rows.filter(function (row) {
                return (row.assemblyItemText || '').toLowerCase().indexOf(needle) !== -1 ||
                    (row.assemblyItemDisplayName || '').toLowerCase().indexOf(needle) !== -1;
            });
        }

        return rows;
    }

    // A row is a "root" if it has no createdfrom, or createdfrom points to
    // something other than a Work Order (e.g. a Sales Order).
    function isRoot(row) {
        if (!row.createdFromId) {
            return true;
        }
        return row.createdFromText.indexOf('Work Order') !== 0;
    }

    // Breadth-first expansion: fetches every descendant WO for the given root
    // ids, level by level (any status - descendants are shown for context
    // even when not Released), until a level comes back empty.
    function fetchDescendants(rootIds, config) {
        var allDescendants = [];
        var currentLevelIds = rootIds.slice();
        var iterations = 0;
        var columns = getStandardColumns(config);

        while (currentLevelIds.length && iterations < MAX_TREE_DEPTH) {
            iterations++;
            var levelRows = [];
            search.create({
                type: 'workorder',
                filters: [
                    search.createFilter({ name: 'mainline', operator: search.Operator.IS, values: true }),
                    search.createFilter({ name: 'createdfrom', operator: search.Operator.ANYOF, values: currentLevelIds })
                ],
                columns: columns
            }).run().each(function (result) {
                levelRows.push(resultToRow(result, config));
                return levelRows.length < MAX_RESULTS_PER_SEARCH;
            });

            if (!levelRows.length) {
                break;
            }

            allDescendants = allDescendants.concat(levelRows);
            currentLevelIds = levelRows.map(function (r) { return r.id; });
        }

        if (iterations >= MAX_TREE_DEPTH) {
            log.audit('WOTree', 'Descendant expansion hit the max depth safety cap (' + MAX_TREE_DEPTH +
                '). This usually means a cyclical or unexpectedly deep createdfrom chain - investigate before trusting this tree.');
        }

        return allDescendants;
    }

    // Builds id->row and parentId->[childIds] maps from root + descendant rows.
    function buildTree(rootRows, descendantRows) {
        var idToRow = {};
        var childrenMap = {};

        function index(row) {
            idToRow[row.id] = row;
            if (row.createdFromId) {
                if (!childrenMap[row.createdFromId]) {
                    childrenMap[row.createdFromId] = [];
                }
                childrenMap[row.createdFromId].push(row.id);
            }
        }

        rootRows.forEach(index);
        descendantRows.forEach(index);

        return { idToRow: idToRow, childrenMap: childrenMap };
    }

    // Iterative (stack-based, not recursive) depth-first walk from each root,
    // so display order is: root, all its descendants, next root, ...
    function flattenDepthFirst(rootIds, idToRow, childrenMap) {
        var output = [];

        rootIds.forEach(function (rootId) {
            var stack = [{ id: rootId, depth: 0 }];
            while (stack.length) {
                var node = stack.pop();
                var row = idToRow[node.id];
                if (!row) {
                    continue;
                }
                output.push({ row: row, depth: node.depth, isRoot: node.depth === 0 });
                var childIds = childrenMap[node.id] || [];
                for (var i = childIds.length - 1; i >= 0; i--) {
                    stack.push({ id: childIds[i], depth: node.depth + 1 });
                }
            }
        });

        return output;
    }

    // Plain-text indentation prefix used to visually convey tree depth in a
    // single flat sublist column (chosen over per-root sections for
    // performance at "hundreds" of Work Orders).
    function indentLabel(depth) {
        if (depth <= 0) {
            return '';
        }
        var prefix = '';
        for (var i = 0; i < depth - 1; i++) {
            prefix += '  ';
        }
        return prefix + '└─ ';
    }

    return {
        fetchRootCandidates: fetchRootCandidates,
        fetchDescendants: fetchDescendants,
        buildTree: buildTree,
        flattenDepthFirst: flattenDepthFirst,
        isRoot: isRoot,
        indentLabel: indentLabel
    };
});
