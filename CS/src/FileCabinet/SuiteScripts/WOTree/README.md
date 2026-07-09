# WOTree - Work Order Hierarchy Start Date Editor

Suitelet for viewing Released Work Orders together with their full
`createdfrom` sub-assembly descendant chain, and editing Start Date inline.
See files in this folder:

- `wo_tree_suitelet.js` - main Suitelet (filters, list, save)
- `wo_tree_client.js` - client script for the Suitelet form
- `wo_tree_mr.js` - Map/Reduce that applies queued date changes
- `wo_field_discovery_sl.js` - one-time diagnostic tool (see step 3 below)
- `lib/wo_tree_constants.js`, `lib/wo_tree_hierarchy.js` - shared modules

## I have not verified this against a live NetSuite account

I built and self-reviewed this code, but I don't have credentials to deploy
or run it against your account. A handful of internal IDs are best-guess
defaults, exposed as Script Parameters so they can be corrected **without
any code changes**:

| Parameter | Default | What it is |
|---|---|---|
| `custscript_wo_status_released` | `WorkOrd:B` | Internal value of the Work Order `status` field for "Released" |
| `custscript_wo_item_join_id` | `assemblyitem` | Search join id from Work Order to its assembly item's fields |
| `custscript_wo_planning_cat_field` | `custitem_planningitemcategory` | Field id on Item for "Planning Item Category" |
| `custscript_wo_page_root_size` | `50` | How many top-level Work Orders to show per page |
| `custscript_wo_mr_script_id` | `customscript_wotree_mr` | Script id of the Map/Reduce job |

If any default is wrong, the Suitelet will still load but will show 0 (or
wrong) results, or the Planning Item Category filter options may come back
empty and log an error - it will not silently corrupt data, because the
save flow independently re-verifies each Work Order's status server-side
before queuing any change, regardless of what the parameters say.

## Deploy steps

1. `suitecloud project:deploy` (using your existing `dev-ci` auth id).
2. Open the deployed **WOTree - Field Discovery (Run Once)** Suitelet once
   (find its URL under Customization > Scripting > Script Deployments).
   It writes to the execution log:
   - every field id/value on a sample Work Order (check `createdfrom`, `status`)
   - every distinct Work Order status value paired with its label - confirm
     which one is "Released"
   - every field on a sample Item whose id/label mentions "planning" or
     "category" - confirm the real Planning Item Category field id
   - whether the `assemblyitem` / `item` search join ids resolve
3. If any default in the table above is wrong, go to Customization >
   Scripting > Scripts > **WOTree - Work Order Hierarchy Suitelet** >
   Parameters and update the value. No redeploy needed.
4. Deactivate or delete the Field Discovery script once you're done with it
   - it's read-only but has no reason to stay live.
5. Open the **WOTree - Work Order Hierarchy** Suitelet, confirm a known
   Work Order hierarchy renders with correct indentation, edit one Released
   row's Start Date, click Save, and confirm:
   - the confirmation banner reports a queued Map/Reduce job id
   - Customization > Scripting > Script Deployments > Map/Reduce Status
     shows the job completing
   - the actual Work Order record reflects the new Start Date

## Design notes

- **Hierarchy**: a Work Order is a "root" if `createdfrom` is empty or
  doesn't point to another Work Order; children are found by following
  `createdfrom` WO-to-WO links, breadth-first, level by level - this keeps
  the number of searches proportional to tree *depth*, not tree *size*.
- **Display**: one flat, indented sublist (not one section per root) for
  performance at "hundreds" of Work Orders. Only the Start Date column is
  editable; non-Released rows are shown read-only for context.
- **Save**: edits are diffed client-side, then queued to a Map/Reduce job
  rather than applied synchronously, so saving many rows never risks a
  governance/timeout error. The Suitelet independently re-checks each row's
  current status before queuing - the client-side "read-only" styling is a
  UX nicety, not the actual guard.
- **Access**: no custom role restriction - relies on the user's standard
  Work Order edit permission, per your request.
- **Staging files**: change batches are written as JSON files to a File
  Cabinet folder named "WOTree Staging" (auto-created on first save); the
  Map/Reduce writes a `..._result.json` alongside each staging file with
  succeeded/failed counts once done.
