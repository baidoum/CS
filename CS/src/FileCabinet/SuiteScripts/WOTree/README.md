# WOTree - Work Order Hierarchy Start Date Editor

Suitelet for viewing Released Work Orders together with their full
`createdfrom` sub-assembly descendant chain, and editing Start Date inline,
through a custom HTML/CSS/JS page (no native NetSuite forms/sublists).
See files in this folder:

- `wo_tree_suitelet.js` - entry point: GET renders the page, POST is a small
  JSON action router (`loadTree`, `save`) the page's own JS calls via `fetch`
- `wo_tree_html.js` - the actual UI: CSS + vanilla JS embedded in the
  returned HTML string
- `wo_tree_mr.js` - Map/Reduce that applies queued date changes
- `wo_field_discovery_sl.js` - one-time diagnostic tool (see step 2 below)
- `lib/wo_tree_constants.js`, `lib/wo_tree_hierarchy.js` - shared modules
  (search + tree-building logic, reused as-is by the JSON router)

## Parameters confirmed against the live account

| Parameter | Value | Status |
|---|---|---|
| `custscript_wo_status_released` | `WorkOrd:B` | Confirmed correct |
| `custscript_wo_item_join_id` | `item` | Corrected (was `assemblyitem`, fails as a join id) |
| `custscript_wo_planning_cat_field` | `planningitemcategory` | Corrected (standard field, no `custitem_` prefix) |
| `custscript_wo_page_root_size` | `50` | Default, tune if pages feel too big/small |
| `custscript_wo_mr_script_id` | `customscript_wotree_mr` | Must match the actual Map/Reduce script's real id |

If any of these are ever wrong, the page still loads but returns 0/wrong
results, or a filter dropdown comes back empty and logs an error - the save
flow independently re-verifies each Work Order's status server-side before
queuing any change, regardless of what the parameters say.

## Deploy steps (manual, since deployment is handled outside SDF objects)

1. Upload the changed files:
   ```
   suitecloud file:upload --paths \
     "/SuiteScripts/WOTree/wo_tree_suitelet.js" \
     "/SuiteScripts/WOTree/wo_tree_html.js" \
     "/SuiteScripts/WOTree/wo_tree_mr.js"
   ```
2. `wo_tree_client.js` no longer exists - all client-side JS is now embedded
   inside `wo_tree_html.js`. If a Script record for it exists in NetSuite
   (unlikely, since client scripts referenced only via
   `form.clientScriptModulePath` never needed one), delete it. Otherwise
   nothing else references that file - the Suitelet no longer sets
   `clientScriptModulePath` at all.
3. Reload the Suitelet's URL - it now renders the custom page instead of a
   native NetSuite form/sublist.

## Design notes

- **Hierarchy**: a Work Order is a "root" if `createdfrom` is empty or
  doesn't point to another Work Order; children are found by following
  `createdfrom` WO-to-WO links, breadth-first, level by level - this keeps
  the number of searches proportional to tree *depth*, not tree *size*.
- **Display**: one flat, indented HTML table (not one section per root) for
  performance at "hundreds" of Work Orders. Only the Start Date cell is a
  real `<input type="date">`, and only on Released rows; non-Released rows
  show a plain read-only date.
- **Dates**: the UI's native date input works in ISO `yyyy-mm-dd`
  regardless of locale. `wo_tree_suitelet.js` converts NetSuite's
  locale-formatted search results to ISO for display (`toIsoDate`), and
  `wo_tree_mr.js` parses ISO back into a `Date` manually (`parseIsoDate`,
  local year/month/day) rather than `new Date(isoString)`, which V8 treats
  as UTC midnight and can shift the date by a day in negative-UTC-offset
  timezones.
- **Save**: edits are diffed client-side, then queued to a Map/Reduce job
  rather than applied synchronously, so saving many rows never risks a
  governance/timeout error. The Suitelet independently re-checks each row's
  current status before queuing - the client-side "read-only" rendering is
  a UX nicety, not the actual guard.
- **Access**: no custom role restriction - relies on the user's standard
  Work Order edit permission.
- **Staging files**: change batches are written as JSON files to a File
  Cabinet folder named "WOTree Staging" (auto-created on first save); the
  Map/Reduce writes a `..._result.json` alongside each staging file with
  succeeded/failed counts once done.

## Verification checklist

Open the Suitelet's URL and confirm:
- The page renders with the dark header, filter card, and results table
  (not a native NetSuite form).
- A known Work Order hierarchy shows with correct indentation and a "Root"
  badge on top-level rows.
- Editing a Released row's Start Date highlights that cell; non-Released
  rows show plain text, no input.
- Save shows a toast with a queued count and Job ID; Customization >
  Scripting > Script Deployments > Map/Reduce Status shows the job
  completing; the actual Work Order record reflects the new date.
- Pagination (Previous/Next) and the filter fields (Assembly Item, Planning
  Item Category, date range) narrow the result set as expected.
