/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 *
 * Applies Work Order start-date changes queued by wo_tree_suitelet.js.
 * Queued via N/task (task.create + submit), not via a scheduled deployment -
 * custscript_mr_staging_file_id is set programmatically per invocation and
 * points at a JSON file of [{id, startdate}, ...] in the File Cabinet.
 */
define(['N/record', 'N/file', 'N/runtime', 'N/log'], function (record, file, runtime, log) {

    // Changes arrive as ISO yyyy-mm-dd strings (from the UI's native
    // <input type="date">). Parsed manually via local year/month/day rather
    // than `new Date(isoString)`, which V8 treats as UTC midnight and can
    // shift the date by one day in negative-UTC-offset timezones.
    function parseIsoDate(iso) {
        var parts = String(iso).split('-');
        return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    }

    function getInputData() {
        var script = runtime.getCurrentScript();
        var fileId = script.getParameter({ name: 'custscript_mr_staging_file_id' });
        if (!fileId) {
            log.error('WOTree MR', 'Missing custscript_mr_staging_file_id parameter - nothing to process.');
            return [];
        }
        var stagingFile = file.load({ id: fileId });
        var changes = JSON.parse(stagingFile.getContents() || '[]');
        log.audit('WOTree MR', 'Loaded ' + changes.length + ' change(s) from staging file ' + fileId);
        return changes;
    }

    function map(context) {
        var change = JSON.parse(context.value);
        try {
            var dateValue = parseIsoDate(change.startdate);
            record.submitFields({
                type: 'workorder',
                id: change.id,
                values: { startdate: dateValue },
                options: { enablesourcing: false, ignoreMandatoryFields: true }
            });
            context.write({ key: change.id, value: 'OK' });
        } catch (e) {
            log.error('WOTree MR - failed to update Work Order ' + change.id, e.message);
            context.write({ key: change.id, value: 'ERROR: ' + e.message });
        }
    }

    function summarize(summaryContext) {
        var succeeded = 0;
        var failed = 0;
        var errors = [];

        summaryContext.output.iterator().each(function (key, value) {
            if (value === 'OK') {
                succeeded++;
            } else {
                failed++;
                errors.push({ id: key, message: value });
            }
            return true;
        });

        if (summaryContext.mapSummary && summaryContext.mapSummary.errors) {
            summaryContext.mapSummary.errors.iterator().each(function (key, error) {
                failed++;
                errors.push({ id: key, message: String(error) });
                return true;
            });
        }

        log.audit('WOTree MR Summary', 'Succeeded: ' + succeeded + ', Failed: ' + failed);

        try {
            var script = runtime.getCurrentScript();
            var fileId = script.getParameter({ name: 'custscript_mr_staging_file_id' });
            if (fileId) {
                var stagingFile = file.load({ id: fileId });
                var resultName = stagingFile.name.replace(/\.json$/i, '_result.json');
                var resultFile = file.create({
                    name: resultName,
                    fileType: file.Type.JSON,
                    contents: JSON.stringify({ succeeded: succeeded, failed: failed, errors: errors }),
                    folder: stagingFile.folder
                });
                resultFile.save();
            }
        } catch (e) {
            log.error('WOTree MR - failed to write result file', e.message);
        }
    }

    return {
        getInputData: getInputData,
        map: map,
        summarize: summarize
    };
});
