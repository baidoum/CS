# WOTree - Work Order Hierarchy Start Date Editor

Suitelet with two tabs, both served from the same URL via a custom HTML/CSS/JS
page (no native NetSuite forms/sublists):
1. **Hiérarchie des Ordres de Fabrication** - Released Work Orders with their
   full `createdfrom` sub-assembly descendant chain, inline Start Date editing.
2. **Quantités par Semaine** - pick one or more assembly items, see their
   total Released quantity per week (Monday-start, ISO week number shown),
   items as rows / weeks as columns, with row and column totals.

Files:
- `wo_tree_suitelet.js` - entry point: GET renders the page, POST is a JSON
  action router (`loadTree`, `save`, `checkStatus`, `searchItems`,
  `loadQuantityByWeek`) the page's own JS calls via `fetch`
- `wo_tree_html.js` - the actual UI: CSS + vanilla JS embedded in the
  returned HTML string, entirely in French
- `wo_tree_mr.js` - Map/Reduce that applies queued date changes
- `wo_field_discovery_sl.js` - one-time diagnostic tool (see step 2 below)
- `lib/wo_tree_constants.js`, `lib/wo_tree_hierarchy.js` - shared modules
  (search + tree-building logic, reused by both tabs)

## Parameters confirmed against the live account

| Parameter | Value | Status |
|---|---|---|
| `custscript_wo_status_released` | `WorkOrd:B` | Confirmed correct |
| `custscript_wo_status_released_labels` | `Released,Publié` | Added - see "Multi-language status" below |
| `custscript_wo_item_join_id` | `item` | Corrected (was `assemblyitem`, fails as a join id) |
| `custscript_wo_planning_cat_field` | `planningitemcategory` | Corrected (standard field, no `custitem_` prefix) |
| `custscript_wo_page_root_size` | `50` | Default, tune if pages feel too big/small |
| `custscript_wo_mr_script_id` | `customscript_wotree_mr` | Must match the actual Map/Reduce script's real id |

If any of these are ever wrong, the page still loads but returns 0/wrong
results, or a filter dropdown comes back empty and logs an error - the save
flow independently re-verifies each Work Order's status server-side before
queuing any change, regardless of what the parameters say.

## Deploy steps (manual, since deployment is handled outside SDF objects)

Upload whichever files changed, e.g.:
```
suitecloud file:upload --paths \
  "/SuiteScripts/WOTree/wo_tree_suitelet.js" \
  "/SuiteScripts/WOTree/wo_tree_html.js" \
  "/SuiteScripts/WOTree/wo_tree_mr.js" \
  "/SuiteScripts/WOTree/lib/wo_tree_hierarchy.js" \
  "/SuiteScripts/WOTree/lib/wo_tree_constants.js"
```
If `custscript_wo_status_released_labels` doesn't exist yet on the Suitelet
script record, add it manually (Customization > Scripting > Scripts > this
script > Parameters): Free-Form Text, default `Released,Publié`.

## Design notes

- **Hierarchy**: a Work Order is a "root" if `createdfrom` is empty or
  doesn't point to another Work Order; children are found by following
  `createdfrom` WO-to-WO links, breadth-first, level by level - this keeps
  the number of searches proportional to tree *depth*, not tree *size*.
- **`mainline` filter is mandatory**: every Work Order search filters on
  `mainline = true`. Without it, a transaction search returns one row per
  line, not per transaction - a WO with 7 component lines came back as 7
  duplicate rows, each spawning a duplicate copy of its subtree.
- **Item search matches the whole subtree**: typing an item code/name
  matches if the root's own item matches, OR any descendant's item matches
  anywhere in its tree - users have no way to know whether an item happens
  to be a root's own item or a sub-assembly component several levels down.
  Matching text is normalized (HTML entities, whitespace) before comparing,
  since raw search values can differ invisibly from what's rendered.
- **Multi-language status**: NetSuite's internal status key (e.g.
  `WorkOrd:B`) is supposed to be language-independent, but in practice the
  fallback label comparison is what actually matters day to day - confirmed
  in this account that a user with the NetSuite UI set to French sees the
  Released status behave differently than English, reproduced by switching
  UI language. `custscript_wo_status_released_labels` holds a comma-separated
  list of accepted "Released" labels across every language your users pick
  (default `Released,Publié`) - add another label there (no code change) if
  someone selects yet another NetSuite UI language.
- **Dates**: the UI's native date input works in ISO `yyyy-mm-dd` regardless
  of locale. `wo_tree_suitelet.js` converts NetSuite's locale-formatted
  search results to ISO for display (`toIsoDate`), and `wo_tree_mr.js` parses
  ISO back into a `Date` manually (`parseIsoDate`, local year/month/day)
  rather than `new Date(isoString)`, which V8 treats as UTC midnight and can
  shift the date by a day in negative-UTC-offset timezones. Search-side date
  *filters* (Start Date From/To) need the value as a locale-formatted
  *string* via `N/format` - neither the raw ISO string nor a native `Date`
  object worked (`Date` threw a bare `UNEXPECTED_ERROR`).
- **Save**: edits are diffed client-side, then queued to a Map/Reduce job
  rather than applied synchronously, so saving many rows never risks a
  governance/timeout error. The client polls job status and only refreshes
  the table once the job actually completes - reloading immediately after
  Save would show the still-unchanged record and look like a revert. The
  Suitelet independently re-checks each row's current status before queuing.
- **Quantity by Week**: item autocomplete searches assembly items that
  actually appear on a Released Work Order (deduplicated), not the general
  item catalog - most catalog items are never built via a WO, and an item
  marked inactive after its Work Orders were created would otherwise vanish
  from an `isinactive=F` catalog search despite having real history.
- **Access**: no custom role restriction - relies on the user's standard
  Work Order edit permission.
- **Staging files**: change batches are written as JSON files to a File
  Cabinet folder named "WOTree Staging" (auto-created on first save); the
  Map/Reduce writes a `..._result.json` alongside each staging file with
  succeeded/failed counts once done.
- **Caching**: the page response sends `Cache-Control: no-cache, no-store,
  must-revalidate` - without it, two users hitting the same URL after a
  redeploy could end up on different (one stale) versions of the tool.

## Verification checklist

Open the Suitelet's URL and confirm:
- The Hierarchy tab renders with correct indentation and a "Root" badge on
  top-level rows; editing a Released row's Start Date highlights that cell,
  non-Released rows show plain text (no input).
- Save shows a toast with a queued count and Job ID, then (after the
  background job completes) a second toast with the real applied/failed
  count and the table refreshes with the actual new date.
- Filters (item code/name, Planning Item Category, Start Date range) narrow
  the result set as expected; column headers sort root groups when clicked.
- The Quantities by Week tab: searching an item shows suggestions, clicking
  adds a chip, "Afficher" renders a table with items as rows and weeks
  (with ISO week numbers) as columns, plus row/column totals.
- Test with at least one user whose NetSuite UI language differs from the
  admin's (e.g. French) to confirm Start Date is still editable for them.
