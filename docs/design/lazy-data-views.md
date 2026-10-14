# Lazy loading and spreadsheet interaction in data views

Accepted for implementation by the owner on 2026-10-14: "Create the
codex/lazy-data-views branch and proceed with implementing the plan."
W-233 tracks the Studio delivery; other renderers remain explicit follow-ups.

Replace Studio's page-by-page table with continuous scrolling backed by bounded
host reads. Use more of AG Grid Community for keyboard editing and column layout.
Keep Nendo's typed values, validation, history and record identity authoritative.

The recommended foundation is **AG Grid's Infinite Row Model plus a Nendo-owned
row-window query**. Lazy loading changes how records arrive on screen; bounded
pages remain useful inside the service boundary and for existing clients.

The initial delivery is Studio's flat Data table, including the Table option for
a hierarchical record type. Extend lazy loading to Use lists and related records
after that foundation works. Outline, board, calendar, gallery and custom views
need their own loading policies; replacing their renderers with AG Grid is not
part of the first delivery.

**Delivery checkpoint (2026-10-14):** W-233, stable ID
`nd.work.r.lazy-data-views`, ready for owner review within accepted scope; branch
`codex/lazy-data-views` in worktree a360. W-231 remains in its separate main
checkout. The only current overlapping path is `docs/architecture.md`, with edits
in separate sections. At that handoff, no merge or owner installation had been performed.

Implemented: typed revision-bound host windows and stable-ID location; bounded
lazy Studio blocks; Enter/Tab continuation across delayed blocks; column
reorder/hide/pin/reset; formatted single-cell copy and refusal feedback; session
preferences when device storage refuses writes. Changed paths cover Engine/SQLite,
Desktop named read/cancellation, Workbench datasource/grid/layout/preview, tests,
browser lane, query/Studio contracts, ADR-0002, architecture/roadmap/help/site.

| Executed lane | Literal outcome / scope |
| --- | --- |
| Workbench type check and tests in `Publish-NendoPayload.ps1` | Passed; 747 tests, zero failures. |
| .NET suites in `Test-Production.ps1 -SkipRestore` | 2,171 passed, nine skipped tests; build zero warnings/errors. Final focused Engine/Desktop reruns passed 5/1. |
| Opt-in Engine scale lane | Passed 100, 10,000 and 100,000 records on Intel Core Ultra 9 185H; no full-record reads. |
| `Review-WorkbenchShell.ps1` | Passed all 98 checks, browser exceptions 0. Includes both themes, cache eviction/reload, deep editing, delayed Enter/Tab, horizontal scroll, clipboard adapter/refusal, storage refusal, disposed-menu event and 600px toolbar geometry. |
| Other production browser lanes | Graph, Dependencies, Systems Lens, Gantt, BCM Atlas and Archi passed in the initial run; Swarm, Garden and Agent Chat passed sequential reruns. |
| `Test-Repository.ps1` | `Repository verification passed.` |
| `Test-Site.ps1` | Passed. |
| `Publish-NendoPayload.ps1` / `Build-NendoInstaller.ps1` | Passed for final source; manifest source-hash mismatches zero. Deliverable: `artifacts/installer/Nendo-Setup.exe`. |
| `Test-NendoSetupIsolated.ps1` | `Isolated setup smoke passed`; install, upgrade, uninstall and ownership checks used a task-owned root. Staged payload pruned. |
| `Test-NendoInstaller.ps1` | `Refusing to run: Nendo is installed`; preserved the owner installation. NSIS extraction/HKCU uninstall registration still need a clean Windows user. |

The original combined production command stopped at Swarm's artifact guard because
an overlapping task-owned browser probe created
`page-2026-10-14T08-27-21-812Z.yml` in the root snapshot directory. The guard stayed
intact; remaining lanes were completed sequentially. This is completion across
separate commands, not a claim that the original combined command passed.

Falsified and restored guards: removing eviction measured 1,000 cached records / ten
blocks; dropping predicates and admitting stale generations failed unit guards;
removing the landing read failed with "The landing screen opened without records."
Forcing SQL offset zero failed with "CollectionAssert.AreEqual failed. Different
number of elements." Delayed-row focus failed before its index/identity fix.
Removing session retention failed with "a refused storage write lost the session
column layout." Disabling keyboard scroll capture reproduced "the columns scrolled
from 40 to 0 px." Delivering a menu toggle after disposal without the guard threw
"Cannot read properties of undefined (reading 'filter')". Restored source passed
the final full browser sweep. Browser setup now waits for rendered menu controls,
paces scrolling and selects visible rows. Planner evidence: C-568 through C-577
and F-282 through F-291; failed attempts remain recorded.

Qualification limits: the UI cache/DOM fixture has 1,000 rows; the 100,000-row
measurement exercises the Engine. The new Copy cell path is checked against a
clipboard adapter in the preview; a native Windows clipboard round-trip for that
specific button is not measured. Deep unindexed text sorts at 100,000 rows exceed
the proposed latency target (see roadmap). Other data-view renderers remain the
explicit follow-ups below. These limits are not represented as passed checks.

The owner subsequently authorized merging into main, preserving uncommitted work,
running integration checks and pushing after they pass. The integration record
below supersedes the earlier merge handoff. Outstanding qualification limits stay
explicit; check passes do not relabel those limits as measured.

## Integration with W-231 (2026-10-14)

Merge `d342bdbcad0b23992732c1a6c16d720cc5b6cd74` combines W-231's
`6d8d5b23bc77ab5e1e3bd82830dec42f85a5fbb1` with feature commit
`3e5238b1cb3d2594c8ec327b7a00edebf0b33c02`, without conflicts. Integration ran
in worktree a360 on `codex/lazy-data-views-integration`. Main's uncommitted
`ACP.md` deletion is excluded from these commits and retained for its owner.
During final handoff, the owner committed that deletion as `97f9e1c`; the main-tip
guard stopped before changing the checkout. Integration then included that commit
on `codex/lazy-data-views-main`. Product source hashes still match the tested
payload; the repository gate was rerun for the documentation-only change.

The initial `Test-Production.ps1 -SkipRestore` run passed 747 Workbench tests,
the .NET build with zero warnings/errors, and 2,197 .NET tests (Engine 1,356,
Local MCP 304, Desktop 537; nine skipped). Structural checks, Graph and Work
Dependencies passed. Systems Lens then exposed a test race: restoring a label
waited for summary counts that had not changed. An unchanged rerun passed.

Test-only commit `8ce06cf2c5ee390ae66e20fec0915bf35768facd` waits for the actual
restored label with a deliberately delayed reply. Reinstating the old wait failed
with "The restore wait ended before the original component label arrived."
The corrected Systems Lens lane and every remaining production lane passed in
sequence: Gantt, Capability Atlas, Archi, Swarm, Garden, Agent Chat, all 98 Workbench
shell checks (zero browser exceptions), and `Test-Repository.ps1`.
This is completion across sequential invocations; the original combined command's
failure remains recorded. No product code changed during integration.

`Test-Site.ps1` passed including its search-browser check and all 815 internal
references across 15 pages. `Publish-NendoPayload.ps1`, `Build-NendoInstaller.ps1`
and `Test-NendoSetupIsolated.ps1` passed for the integrated source; payload source
hashes match. `Test-NendoInstaller.ps1` preserved the existing owner installation
by refusing its install/uninstall smoke. The clean-user NSIS obligation remains.
Evidence is recorded in C-578 through C-580 and F-292. Final main/remote commit
identity and preservation checks are recorded in W-233's planner handoff.

## Baseline before this delivery

| Area | Current behavior and implication |
| --- | --- |
| Grid | `src/Nendo.Workbench/package.json` pins `ag-grid-community` 36.1.0. `src/main.ts` registers the client-side row model. |
| Table | `src/view-data.ts` gives `mountRecordGrid` one page as `rowData`; `renderData` adds `recordPagerMarkup` and `wireRecordPager`. AG Grid virtualizes that page, not the whole query. |
| Reads | `src/record-window.ts`, `src/reads.ts` and `src/actions.ts` retain page cursors and query snapshots. The default `NendoRecordQuery` limit is 50; the Engine allows 1–200. |
| Query correctness | One sort field, deterministic record-ID tie breaking and up to eight AND predicates. Sorting/filtering runs through the host, including exact numeric, choice and reference semantics. Calculated queries have a 10,000-candidate ceiling. |
| Continuation | `NendoQueryCursor.cs` authenticates query, file instance and revision. Storage record queries continue after a record ID, rather than accepting arbitrary row offsets. Every write invalidates existing cursors. |
| Editing | `commitGridEdit` uses typed `data.setField` with record version and idempotency key. Refresh redraws the grid; focus recovery searches the newly loaded rows. `openRow` also searches the page captured when the grid mounted. Both need to change for lazy rows. |
| Columns | Resize, auto-size and remembered widths exist. Column movement is explicitly suppressed; hiding is not built. The header owns host sorting and proposal-based field renaming. |
| Other views | AG Grid lives in Studio. Use surfaces use separate DOM renderers. The outline already reads bounded levels and has explicit Show more rows. |

Paths abbreviated as `src/...` in this table are under `src/Nendo.Workbench/`.

The Studio contract lists block loading, movable/hideable columns and bounded
TSV copy/paste as experience targets. Its "as built" paragraphs explicitly say
movement/hiding are absent and the bridge has no bulk-paste method. Those targets
are not evidence that the features already exist.

## Decisions and feature scope

[ADR-0015](../decisions/0015-host-owned-database-studio-and-ag-grid-community.md)
already permits Community grids and bounded Nendo behavior. It explicitly excludes
Enterprise packages and features. Infinite scrolling fits that choice. Changing
the typed query contract or its explicit restart rule needs an agreed contract
amendment before implementation. Choosing Enterprise would require a separately
accepted ADR change, including redistribution terms; this plan does not choose it.

| Experience | Proposed treatment |
| --- | --- |
| Continuous scrolling | Community Infinite Row Model, bounded cache and host datasource. First delivery. |
| Spreadsheet keyboard use | Arrow navigation, F2/edit, Enter/Shift+Enter vertical movement, Tab/Shift+Tab between cells while editing, Escape cancellation. Keep a reliable Tab route out of the grid. First delivery. |
| Column layout | Enable movement, pin/unpin, hide/show and reset through a small Nendo control. Persist a validated allowlist of layout preferences on this device, following existing widths. Second delivery. |
| Sort/filter | Keep host semantics. Add convenient header controls without silently enabling multi-sort, OR conditions, floating-point number parsing or loaded-rows-only filtering. Second delivery. |
| Single-cell copy | A small Nendo-owned copy action; distinguish displayed labels from canonical IDs. Standard paste into the active editor remains single-cell editing. Second delivery. |
| Rectangular selection and TSV paste | AG Grid's integrated cell selection/clipboard and fill handle are Enterprise features. Evaluate a bounded Nendo implementation separately, with preview, typed parsing, atomicity and explicit limits. Do not promise these as configuration switches. |
| Fill down, multi-record edits | Follow the TSV/batch design; never loop independent cell saves and call the result atomic. |
| Undo/redo | Continue through Nendo history and declared reversibility. Do not enable a grid-local undo stack that can disagree with committed records. |
| Grouping, pivot, Excel export | Separate feature decisions. The Enterprise server-side row model is not required for lazy loading. Keep existing whole-query CSV flows; exporting a loaded cache must not be called a complete export. |
| Formulas | Keep Nendo's existing calculated fields read-only in the grid. Spreadsheet interaction does not authorize another formula language. |

The vendor documents [infinite scrolling](https://www.ag-grid.com/javascript-data-grid/infinite-scrolling/),
[keyboard navigation](https://www.ag-grid.com/javascript-data-grid/keyboard-navigation/)
and [column pinning](https://www.ag-grid.com/javascript-data-grid/column-pinning/).
Its [cell selection](https://www.ag-grid.com/javascript-data-grid/cell-selection/),
[clipboard](https://www.ag-grid.com/javascript-data-grid/clipboard/) and
[fill handle](https://www.ag-grid.com/javascript-data-grid/cell-selection-fill-handle/)
pages identify the Enterprise modules. Current live documentation reports 36.2.0;
confirm each chosen API against the pinned 36.1.0 package before coding. A package
upgrade is a separate decision, not a prerequisite assumed by this plan.

## Loading and query design

AG Grid asks for `[startRow, endRow)` blocks. Nendo currently supplies a cursor
for the next page. There are two practical approaches:

| Approach | Tradeoff |
| --- | --- |
| Cursor adapter | Map block boundaries to existing cursors, serialize forward discovery, and reload evicted blocks from retained cursors. Small initial change, but an unseen distant block requires walking intermediate pages. Every edit invalidates all those cursors. Useful as a comparison prototype. |
| Typed row windows, recommended | Read a bounded position within an immutable query/revision identity. Supports direct block reload and scroll restoration after edits. Requires Engine, bridge and contract work; deep sorted reads still need performance measurements. |

Do not forge cursors, expose offsets as SQL, or fetch the whole table to satisfy
the grid. Implement the range operation in the existing typed application-service
path. Keep SQL and storage mappings inside the Engine.

Proposed API shape, with final names settled in the contract amendment:

- Opening a query returns an opaque, authenticated query identity bound to the
  open file session, instance, change sequence and complete normalized query.
  It is not a write capability and does not hold a long-lived database transaction.
- A window request takes that identity, a nonnegative start and a length of
  1–200. Return records, start, revision and an explicit end-of-results signal.
  Check the revision and execute the read in one consistent storage read.
- A locate request takes the same query identity and a record ID and returns its
  position, or that it is no longer in the result. This supports return from the
  inspector and restoring the edited record after sorting moves it.
- Reuse existing typed filter/order semantics and calculated-query limits in
  writable and read-only paths. Preserve exact values and reference labels.
  A range read must not build a full-record snapshot for ordinary stored queries.
- Keep existing cursor APIs intact for MCP, custom views and other consumers.
  No vendor sort/filter objects become durable schema or service contracts.
  Any new MCP/custom-view exposure is separately specified, not automatic.

Count is optional. Start with an extending scrollbar and indicate loaded rows.
An exact filtered total may be requested through the existing count service;
only combine it with a window at the same revision. Do not use an entity's
unfiltered total for a filtered result. At the end, pass the exact result length
to AG Grid so it stops requesting rows, including empty and exact-block cases.

Initial tuning proposal: 100 records per block, five cached blocks and at most
two reads in flight. Measure the viewport's minimum cache needs and total memory,
including records retained outside AG Grid. Cache eviction must remain effective;
do not mirror every visited block into an unbounded application map. Keep fixed
row heights; long text opens in the existing editor/inspector.

## Editing and refresh behavior

Keep a grid instance alive while its file, entity and layout stay the same.
Loading another block must not replace the shell or steal focus. Dispose it and
cancel/ignore reads on a file, entity or query change. Use a generation key in
addition to revision numbers: two open files can share entity IDs and revisions.

Loaded records carry semantic IDs and current record versions. Placeholder rows
have no edit/open actions. Resolve an opened record by identity through the cache
or a bounded host read; never through the original page closure.

Treat an edit as pending until the host answers. Retain the intended next cell
when Tab or Enter crosses a block boundary; load it before moving focus. Disable
or serialize further commits while one is pending, carrying the returned version
into the next edit. A refused edit restores the authoritative value and leaves
the reason beside the cell. A lost write reply follows existing receipt recovery;
it is not permission to resend under a new idempotency key.

After a successful write, invalidate the query generation, since triggers,
calculations and reference-label changes may affect other rows. Open a new query,
locate the focused record and load its visible neighborhood. Preserve horizontal
scroll, column state and cell focus. If the edited record no longer matches the
filter, say so and focus a neighboring row; do not silently reinsert it.

For an external write or stale read, preserve the current viewport as visibly
stale and stop extending it. Offer Refresh; do not erase an active editor or
record-page draft. Refresh creates a new query and restores the anchor where
possible. This retains the query contract's explicit restart behavior. Any later
automatic refresh policy needs a documented amendment and draft-protection tests.

Read failures keep existing rows visible, with a retry for the failed block.
Background loading uses local loading indicators rather than taking the global
mutation lock. File closure and renderer recovery must still release resources
and keep the permanent Studio/recovery route reachable.

## Ordered delivery slices

1. **Settle the read contract and measure the alternatives.** Amend
   `docs/contracts/queries.md` and `docs/contracts/studio.md` with the proposed
   range, locate and refresh behavior for acceptance. Record the bridge addition
   under ADR-0002's current version policy. Use a disposable fixture with 100,
   10,000 and 100,000 stored-field rows to compare cursor walking with direct
   windows. Include non-indexed sorting and edits at distant positions. Record
   the calculated-query ceiling separately. Do not benchmark on owner files.

2. **Implement bounded windows in the host.** Extend
   `src/Nendo.Engine/ReadQueries.cs`, `NendoApplicationService.cs`,
   `NendoWriteCoordinator.ReadQueries.cs`, `NendoQueryCursor.cs` and
   `Storage/SqliteNendoStore.ReadQueries.cs`, sharing query semantics rather than
   duplicating them. Add named reads in `src/Nendo.Desktop/WorkbenchProtocol.cs`
   and the session controller, and cancellation routing in
   `WorkbenchCancellation.cs`. Mirror the contract in Workbench `host-types.ts`
   and `host-preview.ts`. Add Engine and Desktop tests before attaching the UI.

3. **Replace the Studio flat-table pager.** Add
   `src/Nendo.Workbench/src/studio-grid-datasource.ts` for block lifecycle,
   identity, cancellation, retry and revision handling. In `main.ts`, register
   `InfiniteRowModelModule` while retaining the client-side model for the outline.
   In `view-data.ts`, mount an infinite grid even before its first rows arrive;
   show loading, empty, failed and populated states distinctly. Remove only the
   flat-table pager. Adapt `actions.ts`, `app-state.ts` and `plan-selection.ts`
   so session refresh no longer forces this table through one-page state or
   destroys it on every load. Keep existing pagers for other renderers.

4. **Complete spreadsheet interaction.** Update `view-data.ts`,
   `studio-header.ts` and `studio-columns.ts` for keyboard continuation, column
   movement/pinning/visibility, reset and validated device-local preferences.
   Preserve header F2 rename and the record-open column. Add single-cell copy
   using `navigator.clipboard.writeText`, following `view-agent.ts` with explicit
   success/refusal feedback and a real WebView2 clipboard check. Follow
   `docs/design/mica-direction.md`, use `styles/02-tokens.css` tokens and measure
   Light, Dark, keyboard escape and narrow-window behavior.

5. **Extend loading beyond Studio in explicit follow-ups.** In `reads.ts`,
   `record-window.ts`, `surface-markup.ts` and the affected Use/related-list
   renderers, replace eligible list pagers with viewport loading and a keyboard
   Load more fallback. Give each list its own query and bounded retention policy;
   preserve related-form drafts. Update `docs/contracts/semantic-surfaces.md`.
   Keep outline sibling ordering/drag limits under W-073 and ADR-0019; do not
   flatten it into the table datasource. Boards and date-range views need separate
   per-group/range budgets; custom views continue to own their reads.

6. **Qualify and document the delivery.** Update `docs/architecture.md`,
   `docs/roadmap.md`, Workbench help and `site/src/content/docs/files-and-data.md`
   to describe what shipped and remaining limits. Keep this plan's later slices
   explicit rather than marking the whole initiative Done. Record actual Checks
   and Findings in Nendo, then rebuild the Windows x64 payload and installer.

W-231 owns the concurrent process/session review; coordinate shared files before
implementation. W-225 and W-230 are completed Studio reviews: retain their
regression guards. W-071's record inspector and W-073's hierarchy remain separate
experiences. Rectangular paste/bulk editing gets its own decision and work item.

## Acceptance evidence

Add datasource tests under `src/Nendo.Workbench/scripts/` so `npm test` runs
them. Extend `TypedRecordQueryTests`, `BoundedQueryTests` and Desktop protocol
tests for the host; preserve `WorkbenchDeclaredQueryPagingTests` for existing
cursor consumers. Measure real interaction in `tools/Gate-WorkbenchShell.mjs`
through its existing production review lane.

| Check | Measurement and negative control |
| --- | --- |
| Lazy loading | Opening the table reads only the initial viewport blocks. Scrolling across three block boundaries shows the correct IDs without a pager click. Revert the flat grid to page `rowData`; the boundary assertion must fail. |
| Bounded retention | Traverse a 100,000-row fixture and back. Instrument live block/record counts and DOM rows; records do not grow with all rows visited. Remove eviction; the retention assertion must fail. Record temporary viewport/in-flight allowances explicitly. |
| Direct access | Read a distant window without fetching every preceding block; compare returned IDs against the same ordered query. Reject negative start, overflow and a length above 200. |
| Query fidelity | Test ties, nulls, exact decimals, choices, reference labels, calculated results, all filters and an evicted-block reload. Drop a predicate in the adapter; its expected-ID assertion must fail. |
| Stale replies | Delay reads, change query/file/revision, then release old replies. They must not alter rows, counts, focus or errors. Remove generation checks to falsify the test. |
| Editing | Edit far below the first block; assert stored value/version, focused record/field, vertical anchor and horizontal scroll. Repeat with rejection, external conflict, triggers, sort movement and filter removal. Disable anchor restoration to falsify the focus guard. |
| Keyboard and layout | Cross an unloaded boundary with Tab/Enter; cancel with Escape; leave the grid by keyboard; move/hide/pin/reset columns. Measure geometry and focused IDs in both themes, not screenshots alone. |
| Recovery | Empty file, empty result, read-only file, failed block, stale cursor, close/reopen and renderer recovery retain a usable Studio. Pending drafts survive a declined refresh. |
| Dependency boundary | Existing dependency audit still rejects Enterprise imports/modules and runtime CDNs. CSV whole-query behavior remains independent of the cache. |

Initial performance targets to validate on named hardware: first usable viewport
within 500 ms warm, p95 cached navigation within 50 ms, and p95 uncached ordinary
stored-field blocks within 250 ms. These are proposed budgets, not measured
results. Report cold start, deep sort/filter, locate and calculated-query costs
separately; if they miss, change the query strategy or document a scoped limit
before claiming large-table qualification.

Falsify each new regression guard on a disposable fixture, restore the change,
rerun and put the literal observed failure in a Finding. This document describes
future assertions; it does not claim any have passed or invent failure text.

For implementation, run the narrow applicable tests and then
`pwsh ./tools/Test-Production.ps1` (which includes the repository gate). Use
`-SkipRestore` only with unchanged dependencies. Build changed public guidance
with `pwsh ./tools/Test-Site.ps1`. Rebuild via `Publish-NendoPayload.ps1` then
`Build-NendoInstaller.ps1`; exercise setup with `Test-NendoSetupIsolated.ps1`.
The `Test-NendoInstaller.ps1` wrapper lane needs a clean Windows user and must
not uninstall the owner's installation. Report its outcome separately and deliver
`artifacts/installer/Nendo-Setup.exe` when implementation is complete.

Planning-pass checks: `pwsh -NoProfile -File ./tools/Test-Repository.ps1`
exited 0 with `Repository verification passed.` It covered 1,435 tracked paths.
At that planning pass the new plan was untracked and checked separately for LF endings, no UTF-8
BOM and resolving relative Markdown links. No product build, feature tests,
runtime measurements or installer lanes were run for this documentation change.
