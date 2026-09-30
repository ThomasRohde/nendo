# Broad Nendo review — 2026-09-30

Status: source fixes for all 18 findings are implemented in the current checkout.
Component checks and guard falsification are recorded in the fix pass below.
Full Windows product qualification and a new installer remain to run on Windows.

The original review evidence below describes the pre-fix behavior. Its recorded
runs and original planner proposal are historical evidence, distinct from this
implementation pass. No Critical finding was established.

## Objective and scope

Review the current Nendo checkout across Engine/storage and history, proposals and authority, Desktop/file lifecycle and recovery, MCP, Workbench and custom views, shipped applications, tooling/installer, website, and test coverage. Record actionable defects with a concrete trigger, impact, source location, evidence method, confidence, and correction direction. No product fixes, owner-file failure experiments, owner installation changes, commit, push, or publication are part of this review. Disposable setup tests and a paired payload/installer build follow the repository's build instructions.

## Checkpoint

- Read the live Planner.nendo Work records (127 records, all pages) before source review. Now consists primarily of Archi features in Review; Next includes features waiting on ADRs. Their decision standing is respected. This user-authorized broad review is independent of those implementation tasks.
- Prior W-070 — Fix the 19 findings of the 2026-09-26 code review (`nd.work.r.code-review-20260926`) is Done and Within accepted scope. Its description records delivered fixes and owner acceptance. Old findings will be assessed against current code before being called current defects.
- Whole-application MCP read was transport-truncated; narrow schema/record resources are used instead. The planner remains reachable; no SQLite storage was opened directly.
- Reviewed source revision: `d34ff32997d69e524aef0fbb61b4bf7ecd46bbca`, branch `main`. Concurrent owner commit `68f29b754313263d802c88572f21679b1c44b2a4` changed only `workspace/Archi.nendo`; the source reviewed here was unchanged. Later concurrent work added ADR-0021, HistoryFold Engine files/tests and edits to existing Engine/ADR-index files. That unfinished scope is excluded; all owner changes are preserved.
- Changed paths owned by this review: `REVIEW.md`; disposable probes/logs may be created under `artifacts/broad-review-20260930/`.
- Source/probe review is complete. All 220 existing Findings and 373 Checks were read through paged resources; the current issues were reconciled against them. IDs R30-001 onward are local report IDs, distinct from the prior review's R-001 onward and from Nendo's generated F-codes.
- The six browser fixture lanes are complete. Primary source-location fingerprint check: 24 of 25 fully qualified paths still match `68f29b7`; the one difference is concurrent HistoryFold additions to `SqliteNendoStore.Compensation.cs`, which leave the inverse-operation allow-list used by R30-018 unchanged. The six Engine finding-bearing files were also checked against the original `d34ff32` revision. Do not read this as a byte-identity claim about the entire now-changing Engine tree.
- Paired payload/installer build and isolated setup passed. The 29-operation planner proposal validated with no diagnostics, and the edit lease was released. Next action is owner acceptance/triage of the findings and selection of bounded fix work. Fixes, regression guards and guard falsification are follow-up implementation work; none has been performed or claimed by this review.

## Evidence rules

Automated means a command/assertion ran during this review. Agent-observed means a source trace or inspected runtime behavior. Owner-reported evidence is kept separate. A successful baseline does not prove the absence of uncovered defects. Historical results are context, not fresh passes. Deliberate accepted limitations are listed separately from defects.

## Finding index

| ID | Severity | Finding |
| --- | --- | --- |
| R30-001 | High | a large Archi Commit partially saves, then refuses its remaining references |
| R30-002 | High | another open file can persist a revoked automatic-action grant again |
| R30-003 | Low | documentation search removes the match highlighting it intends to preserve |
| R30-004 | Medium | valid relationship cycles overflow the Archi model tree's call stack |
| R30-005 | Medium | a negative trend value is drawn and announced as “none” |
| R30-006 | Medium | hierarchy ordering arithmetic can put a requested last record first |
| R30-007 | Medium | an exact hierarchy-move retry is refused instead of replaying its receipt |
| R30-008 | Medium | retained read-only draft values can disappear on the next autonomous redraw |
| R30-009 | Medium | stale Agent connection settings can be applied to a different file session |
| R30-010 | Medium | invalid lease settings are refused after the chosen port has already been saved |
| R30-011 | Medium | a generated reference differs between proposal clone and accepted file |
| R30-012 | Medium | a move returns a stale version when an action writes back to the moved record |
| R30-013 | Medium | Systems Lens layers cycle members instead of the condensed component graph |
| R30-014 | High | another file can silently restore the device-wide custom-view switch to On |
| R30-015 | Medium | custom-view reads and creates silently lose a `__proto__` field |
| R30-016 | Medium | colliding record IDs across types confuse a batch's reference-version checks |
| R30-017 | Medium | a cancelled MCP rejection orphans a still-previewable proposal |
| R30-018 | Medium | the public custom-view guide promises undo for changes History cannot compensate |

## Original findings

### R30-001 — High: a large Archi Commit partially saves, then refuses its remaining references

- Trigger: create 101 elements and their diagram boxes before Commit (202 writes). Archi sends one chunk of 200 followed by two writes.
- Impact: the first chunk becomes durable, while the remaining boxes are refused; the UI reports a refusal after already changing the file. The user's one Commit spans a partially successful save. Rebase/retry can recover the remaining draft, but does not restore atomicity.
- Location: `extensions/archi/view.js:86`–95 chunks writes; `tools/archi/canvas/records.ts:164`–184 omits target versions for all records created anywhere in the diff. The generated `extensions/archi/canvas.js` uses this code. Engine's per-call created-record exemption is in `src/Nendo.Engine/NendoApplicationService.Batch.cs`.
- Evidence: Automated pure generated-diff probe, `node artifacts/broad-review-20260930/workbench/archi-batch-probe.mjs`, exit 0: `plannedWrites 202`, `chunks [200,2]`, `missingTargetVersionsInSecondChunk 2`. Automated typed-service Engine probe confirms later-call omission is refused: `SECOND_BATCH_EXCEPTION=NendoPreconditionException; Select the target again so its current version can be checked.` and `AFTER_SECOND_BATCH_RECORDS=1` (first call remains committed). The fixture broker enforces this too; the existing Archi gate lacks the >200 dependent-create scenario.
- Confidence: high for the invalid second request; partial persistence follows the per-call atomic boundary. No owner file was exercised.
- Direction: use versions returned by prior chunks when preparing later requests, and communicate partial outcomes explicitly; alternatively enforce the published single-revision bound before committing. Measure 201+ dependent creates and a refusal after a successful first chunk. Do not label a multi-call edit atomic.

### R30-002 — High: another open file can persist a revoked automatic-action grant again

- Trigger: two Desktop controllers load the shared device consent file; controller A revokes its file's grant; controller B approves another file and saves its stale in-memory dictionary.
- Impact: B's whole-file save includes A's revoked entry. A later reopen can trust the revoked behavior without renewed owner consent. In the other order, approving B also loses A's newly granted consent. This is durable state across the supported multiple-file/process workflow.
- Location: `src/Nendo.Desktop/DesktopBehaviourGrantStore.cs` caches and overwrites the grant dictionary without the cross-process device-state lock; `src/Nendo.Desktop/DesktopSessionController.cs:163`–170 retains a store per controller.
- Evidence: Automated exact-source console linking the current store and grant types: `dotnet run --no-restore --project artifacts/broad-review-20260930/desktop-mcp/StoreProbe.csproj`, exit 0 after task-local offline restore. Literal outcomes: `Independent approvals: A=False, B=True; both stores report Persisted=True`; `After revoke: A=False; Persisted=True`; `After other file approval: revoked A=True, B=True, C=True`. Every constructor uses a task-owned root; no owner approval store was read or changed.
- Confidence: high, reproduced against the actual store code. Installed multi-window UI was not exercised. Source ranges: constructor-only load 41–59, approve/revoke 83–105, whole-list overwrite 108–124.
- Direction: serialize read-modify-write across processes and reread current persisted grants inside the lock, as the mode/port/window stores do. Test a stale second store after revocation as well as concurrent approvals. A lock around writing an already stale dictionary alone is insufficient.

### R30-003 — Low: documentation search removes the match highlighting it intends to preserve

- Trigger: Pagefind returns a search excerpt containing `<mark>record</mark>`.
- Impact: search answers remain readable, but the matched words lose their highlight, reducing scanning value.
- Location: `site/src/components/DocsSearch.astro:125`. The regex contains a literal byte `0x08` after `mark`, where a regex word boundary was intended. Normal mark tags therefore match the strip-all-tags branch.
- Evidence: Automated exact-source regex execution, `node artifacts/broad-review-20260930/site-highlight-probe.mjs`; printed `retainsHighlight:false`, `backspaceBytes:1`, and the failed expected-markup assertion. The normal site check/build and its six async-search tests pass; those tests do not measure excerpt highlighting.
- Confidence: high; the probe executes the component's actual line.
- Direction: restore the regex word boundary and assert both retention of mark tags and removal of other markup in the site's existing test lane.

### R30-004 — Medium: valid relationship cycles overflow the Archi model tree's call stack

- Trigger: two relationship records refer to each other as their source. The schema permits a relationship endpoint to be a relationship and does not declare these fields as an acyclic hierarchy. Expand Relations or otherwise label either record.
- Impact: recursive endpoint labels throw and prevent the view's tree/property rendering; explicit relationship names do not prevent the recursion. The host-owned Studio remains available.
- Location: `extensions/archi/model.js:104`–106 recursively labels relationship endpoints without a visited set; `model.js:373` calls it for tree leaves. Allowed endpoint schema: `tools/archi-definition.mjs:76`–77 and 171–172.
- Evidence: Automated shipped-model probe, `node artifacts/broad-review-20260930/workbench/archi-cycle-probe.mjs`, exit 0 prints `label: RangeError: Maximum call stack size exceeded` and `treeRows: RangeError: Maximum call stack size exceeded`. This is a measured view defect; exit 0 means the reproduction completed. Native owner-file UI was not exercised.
- Confidence: high for the model/render path.
- Direction: make endpoint labelling cycle-safe with a finite fallback on revisiting a record, and measure named and unnamed relationship cycles through treeRows and property rendering.

### R30-005 — Medium: a negative trend value is drawn and announced as “none”

- Trigger: a trend bucket sums or takes the minimum of signed numeric data and returns `-250`.
- Impact: the default column chart shows a zero-height tick and announces `Sep 2026: none`; the collapsed table contains the real `-250`. A meaningful negative amount is represented as absence, misleading people reading the visual or its accessible labels.
- Location: `src/Nendo.Workbench/src/charts.ts:153`–164 builds the bucket/column label; `src/Nendo.Workbench/src/chart-kit.ts:55`–58 clamps non-positive values to zero. `docs/contracts/semantic-surfaces.md:799`–802 allows the same exact aggregates as summary tiles over signed numeric fields.
- Evidence: Automated exact production-renderer probe, `node artifacts/broad-review-20260930/workbench/trend-negative-probe.mjs`, exit 0: `amount 0`, `callsNegativeNone true`, `showsNegativeInTable true`, `barHeight 0.00%`.
- Confidence: high for rendered markup; native installed view not exercised.
- Direction: render signed trends with an honest baseline/negative treatment, distinguish null from numeric zero/negative values, and measure negative, zero and empty buckets plus accessible labels in the existing renderer lane.

### R30-006 — Medium: hierarchy ordering arithmetic can put a requested last record first

- Trigger: a root sibling has stored order `Int64.MaxValue`; move another sibling to the end using the typed move service.
- Impact: unchecked addition wraps to a negative order. The operation reports success but the resulting tree puts the moved record first, contrary to the requested placement.
- Location: `src/Nendo.Engine/NendoApplicationService.Hierarchy.cs:82`–84 computes end/before/between orders in unchecked Int64 arithmetic.
- Evidence: Automated current-Engine typed-service probe, `dotnet run --project artifacts/broad-review-20260930/engine/EngineBoundaryProbe.csproj --no-restore`, exit 0 after offline task-local restore. Literal output: `OVERFLOW_BEFORE=first,moving`; `OVERFLOW_AFTER=moving,first`; `OVERFLOW_ASSIGNED_ORDER=-9223372036854774785`.
- Confidence: high; task-owned Nendo file, no raw storage manipulation.
- Direction: use checked or wider arithmetic and renumber when a gap cannot be represented; measure extrema, mixed signs and the resulting tree index rather than only success/version.

### R30-007 — Medium: an exact hierarchy-move retry is refused instead of replaying its receipt

- Trigger: move a record before its sibling with idempotency key `move-first` and expected version 1; retry the identical call after it succeeds.
- Impact: the retry throws `NendoPreconditionException: moving is already there.` instead of returning the original committed result. A client recovering a lost response cannot safely rely on the data lane's replay behavior for moves.
- Location: `src/Nendo.Engine/NendoApplicationService.Hierarchy.cs:103`–104 refuses unchanged current geometry before reaching coordinator receipt recognition. Other geometry changes can also change the expanded operation digest.
- Evidence: Automated same typed-service Engine probe: first result version 2, identical retry refused with the quoted exception. No owner file used.
- Confidence: high.
- Direction: recognize the request receipt before state-dependent move expansion; assert identical revision and `IsIdempotentReplay` on the retry, including a subsequent sibling reorder.

### R30-008 — Medium: retained read-only draft values can disappear on the next autonomous redraw

- Trigger: an unsettled write/session-authority change retains the draft as disabled readable fields; the person clicks a blank area; a pending or later external-write nudge causes automatic refresh.
- Impact: `retainDraftReadOnly` clears the draft state while keeping its values only in the DOM. Once focus no longer holds the page, redraw replaces those values, removing text that was promised to remain available for copying.
- Location: `src/Nendo.Workbench/src/actions.ts:355`–366 clears `openDraft`; `draft-guard.ts:33`–35,61–63 holds only tracked edits/focus; `main.ts:659`–665 schedules an autonomous redraw and `main.ts:107`–108 replaces content.
- Evidence: Automated exact production-function probe, `node artifacts/broad-review-20260930/workbench/retained-draft-probe.mjs`, exit 0: `holdingBefore true`, `disabledAfterRetention true`, `heldValue Unsaved review text`, `openDraftAfterRetention null`, `holdingAfterBlankClick false`. The subsequent redraw loss is an Agent-observed source trace; the complete native authority-loss scenario was not exercised.
- Confidence: high for the demonstrated state/hold gap, medium for complete native timing.
- Direction: retain explicit immutable display-draft state until deliberate departure; measure retention across focus loss plus fileChanged/read-chase redraw.

### R30-009 — Medium: stale Agent connection settings can be applied to a different file session

- Trigger: an Agent settings request passes the protocol's early file-session check; a file switch completes before the settings operation acquires the controller gate.
- Impact: settings bound to the closed file can change the newly opened file's port/lease settings and restart its MCP host. The normal controller admission correctly rejects the same stale scope, but this method bypasses it.
- Location: `src/Nendo.Desktop/DesktopAgentAccess.cs:203` uses `_gate.WaitAsync` instead of the scoped admission in `DesktopRequestBinding.cs:37`–44. `WorkbenchProtocol.cs:364` checks earlier, outside this later wait.
- Evidence: Automated production-controller probe using the freshly built Desktop DLL, `dotnet run --no-restore --project artifacts/broad-review-20260930/desktop-mcp/StoreProbe.csproj -- controller`, exit 0. Literal: `Stale normal admission: This action belongs to a file session that has closed. Refresh the view before continuing.` followed by `Stale settings accepted: old=file-session-... current=file-session-...; port=50121`. Reflection binds the request scope at the precise race boundary; no owner host/file was changed.
- Confidence: high for the controller authority bypass; native UI race not exercised.
- Direction: use the same gate-time scoped admission as other file operations and assert the new file's preferences/listener/lease are unchanged after a stale settings request.

### R30-010 — Medium: invalid lease settings are refused after the chosen port has already been saved

- Trigger: choose a valid unused new port and invalid `leaseExpirySeconds=1` in the same Agent connection settings request.
- Impact: the method refuses the request but persists part of it. A future restart reads a different port although the person was told the settings were rejected.
- Location: `src/Nendo.Desktop/DesktopAgentAccess.cs:210`–211 saves the port before `DesktopAgentSettingsStore.cs:66`–77 validates the lease duration.
- Evidence: Automated same production-controller probe: `Invalid connection settings refusal: Choose a lease expiry between 15 and 86400 seconds.` then `Port after refused invalid expiry: 50122; expected unchanged=50121`.
- Confidence: high.
- Direction: validate all terms before writing either store or restarting the host; assert no persisted or live change after a combined-request refusal.

### R30-011 — Medium: a generated reference differs between proposal clone and accepted file

- Trigger: a validated proposal creates a record with an empty automatically numbered Text field (the planner calls such a field Reference; the probe uses field ID `code`). The clone assigns `W-001`; an unrelated active create consumes that code before acceptance.
- Impact: acceptance succeeds with the same operation digest but creates the reviewed record as `W-002`. ADR-0007 requires exact preview/promotion equivalence and one canonical evidence stream; ADR-0020 says assigned codes are recorded so history and replay carry the same code. Neither grants an exception for sequence allocation between clone validation and acceptance.
- Location: `src/Nendo.Engine/Storage/SqliteNendoStore.Operations.cs:360` resolves sequence assignments locally; `ProposalWorkspace.cs:24` retains the original change set; `NendoWriteCoordinator.Proposals.cs:72`–92 applies the clone and captures behavior effects; `NendoWriteCoordinator.Promotion.cs:122` gates data-revision changes only for behavior plans, then lines 196–197 replay.
- Evidence: Automated current-Engine typed-service/clone probe: `SEQUENCE_PREVIEW_CODE=W-001`, `STATE=Previewable`, `SEQUENCE_PROMOTION=Active`, `SEQUENCE_ACTIVE_CODE=W-002`. Read-only clone opened through Nendo's public lifecycle; task-owned files only.
- Confidence: high for the measured difference and dependency omission.
- Direction: capture assigned values or sequence dependencies into validated operations/preconditions so acceptance either preserves them or explicitly reports staleness. This needs no reservation of a code on the active file merely to preview.

### R30-012 — Medium: a move returns a stale version when an action writes back to the moved record

- Trigger: an approved action watches the ordering field and updates the same record after a hierarchy move.
- Impact: the move returns version 2 although the committed record is version 3. An immediate follow-up using the returned version is refused as stale, making normal API chaining fail.
- Location: `src/Nendo.Engine/NendoApplicationService.Hierarchy.cs:109` computes expected version plus authored set-field count and ignores generated changes; the batch service accounts for generated versions.
- Evidence: Automated current-Engine typed-service probe: `MOVE_TRIGGER_RETURNED_VERSION=2`, `ACTUAL=3`, `GENERATED=1`; follow-up refused `Record moving is version 3, not 2.` Fixture authority approved the exact task-owned behavior.
- Confidence: high.
- Direction: derive returned version from committed generated effects as well as authored operations; measure a same-record action and a follow-up write using the answer.

### R30-013 — Medium: Systems Lens layers cycle members instead of the condensed component graph

- Trigger: `A → B`, `B ↔ C`, `C → D`, so the incoming and outgoing edges reach different members of one cycle.
- Impact: cycle member C is placed with upstream A, and downstream D with B. The layout misrepresents dependency direction across the cycle, despite the package's promise of longest-path layering over the condensed graph.
- Location: `extensions/systems-lens/lens.js:108`–124 removes internal edges but computes degrees/layers by individual node ID; `extensions/systems-lens/README.md:9`–10 describes component condensation.
- Evidence: Automated exact production-algorithm probe, `node artifacts/broad-review-20260930/workbench/systems-loop-layout-probe.mjs`, exit 0: `SCC(B)=SCC(C)=1`, positions `A=40,C=40,B=270,D=270`. No browser-layout claim is made.
- Confidence: high for the algorithm and intended contract.
- Direction: build the DAG by strongly connected component ID, assign a component layer, then place its members. Measure incoming/outgoing edges on different cycle members; an isolated cycle does not guard this defect.

### R30-014 — High: another file can silently restore the device-wide custom-view switch to On

- Trigger: two controllers load extension settings. A switches custom views Off on this device; B later changes its own file's view enablement or development link from its stale settings instance.
- Impact: B rewrites its cached `Run=true` over the successfully persisted global Off. On the next open, custom code can run despite the recovery/kill-switch choice. The already-open B also retains its cached On state; the durable reset is proven without relying on a promise of immediate cross-window sync.
- Location: `src/Nendo.Desktop/Extensions/DesktopExtensionSettingsStore.cs:33`–45 constructor-cached global state, 84–96 setters, 99–118 whole-document save. `docs/contracts/custom-views.md:1009`,1021–1031,1074 defines this device switch for every file.
- Evidence: Automated production-DLL probe, `dotnet run --no-restore --project artifacts/broad-review-20260930/desktop-mcp/StoreProbe.csproj -- controller`, exit 0: `Device views off persisted: Run=False; already-open second store Run=True`; `After second file disables its own views: device Run=True; expected remains false`. DLL SHA-256 `7d9d39ab95404e00c45da5c5049b12ee4e361e27795d4c0375696c0e5182e1ff`. Explicit task-owned roots; owner switches untouched.
- Confidence: high for persisted switch reset; installed cross-window UI not exercised.
- Direction: perform serialized fresh read-modify-write for shared extension state, preserve unrelated disabled files/links, and explicitly propagate device kill-switch changes to live controllers. Measure a global Off followed by an unrelated file toggle/link from an already-loaded second store.

### R30-015 — Medium: custom-view reads and creates silently lose a `__proto__` field

- Trigger: a valid semantic field ID is `__proto__`; query it through the view API or supply it alongside ordinary fields in `records.create`.
- Impact: projection and write normalization build a normal JavaScript object by indexed assignment. That key is handled as the object's legacy prototype setter rather than retained as an own field, so the supplied data is missing from the view and its host create request. The same construction affects JSON state/place keys. No global prototype-pollution claim is made.
- Location: `src/Nendo.Workbench/src/extension-model.ts:25`–32,53–58; `extension-broker.ts:192`–201. Engine semantic-ID validation accepts this field, as the separate typed-service probe confirms below.
- Evidence: Automated production-model/broker probe, `node artifacts/broad-review-20260930/workbench/prototype-field-probe.mjs`, exit 0: `sourceFields [__proto__,title]`, `projectedFields [title]`, `createHostFields [title]`, source value `Retain this text`, projected value type `object`. Typed host stand-in records the exact normalized request; no owner data used.
- Confidence: high. Automated Engine probe additionally confirms `PROTO_ENGINE_FIELD_ACCEPTED=True; READ_VALUE=kept engine value` through AddFieldOperation, typed create and typed query.
- Direction: use dictionaries without inherited setters or construct own properties explicitly; measure reserved JavaScript property names across record reads/creates and JSON state/place round trips.

### R30-016 — Medium: colliding record IDs across types confuse a batch's reference-version checks

- Trigger: ordinary typed creates accept `nodes.shared` and `other.shared`, each version 1. A batch updates `other.shared` then creates a node referring to `nodes.shared`, explicitly expecting its correct version 1.
- Impact: the batch's version dictionary is keyed only by record ID, so it substitutes unrelated `other.shared`'s version 2 for the referenced node. It refuses a valid edit with a target-version error. The measured case rolls back safely, but the check is attached to the wrong target identity.
- Location: `src/Nendo.Engine/NendoApplicationService.Batch.cs:85` creates a RecordId-only dictionary; lines 111,125 update it and line 189 resolves a target through it. The schema knows the reference target type. The published global-record-ID rule (`docs/dogfooding.md:322`) and current per-type create admission also disagree.
- Evidence: Automated current-Engine typed-service probe: `COLLIDING_IDS_ACCEPTED=1,1`; subsequent batch refuses `The selected target changed. Select it again before saving.`; `other.shared` remains version 1 and child is absent.
- Confidence: high.
- Direction: enforce/document the semantic-ID contract at admission, and resolve batch reference versions by the full target identity for existing data. Measure identical IDs across target types rather than only globally distinct fixture IDs.

### R30-017 — Medium: a cancelled MCP rejection orphans a still-previewable proposal

- Trigger: a validated owned proposal waits for the Engine coordinator gate during Reject; cancel the request before it acquires that gate.
- Impact: MCP removes ownership and the host review queue before the Engine rejects the proposal. Its physical clone stays allocated/previewable, while UI/resources no longer list it and an identical rejection retry cannot finish. Recovery requires reopening/cleanup or rebuilding the proposal.
- Location: `src/Nendo.LocalMcp/NendoAgentAuthoringService.cs:388`–399 removes state before awaited `RejectProposalAsync`; `NendoAgentProposals.cs:268`–288 removes the host queue entry; `NendoWriteCoordinator.Promotion.cs:47` honors cancellation before rejection.
- Evidence: Automated real compiled MCP/Engine-service probe, `dotnet run --no-restore --project artifacts/broad-review-20260930/desktop-mcp/StoreProbe.csproj -- controller mcp`, exit 0: `Proposal before canceled reject: Previewable`; `Host queue while reject waits: 0`; `Reject canceled before Engine gate admission.`; `Engine proposal after canceled reject: Previewable`; agent preview and exact rejection retry each say `The change set is not owned by this agent session.` Coordinator-gate control is fixture-only; owner proposal queue untouched.
- Confidence: high.
- Direction: preserve ownership/queue until rejection succeeds, or restore them on cancellation/failure; measure cancellation while queued and an exact-key retry that releases the clone.

### R30-018 — Medium: the public custom-view guide promises undo for changes History cannot compensate

- Trigger: a reader follows `site/src/content/docs/custom-views.md:60`, which says each view change appears in History “where you can undo it”, and then creates a record or commits a batch containing a create.
- Impact: the documented recovery expectation is false. These changes have no History compensation, and batches beyond the compensation operation bound also cannot all be reversed there. The product deliberately has bounded reversibility; this is a guide defect, not a request for universal undo.
- Location: `site/src/content/docs/custom-views.md:60`; the accurate limitations are in `docs/contracts/custom-views.md:586`–589. `src/Nendo.Engine/Storage/SqliteNendoStore.Compensation.cs`'s inverse allow-list excludes `data.createRecord`.
- Evidence: Agent-observed current guide/contract/implementation comparison. This review did not independently execute a create-compensation refusal; the Engine baseline exercises compensation, but no targeted pass is inferred from that.
- Confidence: high for the contradictory claim.
- Direction: describe History attribution and compensation where supported, and name the create/mixed-batch/bound limits in the public guide. Preserve the product's explicit reversibility classes.

## Checks and coverage

Environment: Windows; SDK `10.0.204`, VSTest with MSTest `4.0.2`; Node `v25.9.0`. The sandbox identity differs from the repository owner. Git uses per-process `safe.directory`; no global Git or device preference was changed. Initial dependencies were unchanged with existing restore assets. Later Workbench restore completed: `added 20 packages, and audited 21 packages`; `found 0 vulnerabilities`. That npm result covers this dependency graph at that lookup, not .NET/site dependencies or a general security audit.

### Baselines and environment retries

1. `pwsh -NoProfile -File ./tools/Test-Production.ps1 -SkipRestore`, initial attempt: Workbench type/dependency checks, **430 tests** and build passed; .NET build had **0 warnings, 0 errors**. Tests then hit `UnauthorizedAccessException` under the owner's shared `Temp/nendo-proposals-v1`. This is environment setup evidence, not hundreds of product defects. Log: `artifacts/broad-review-20260930/production.log`.
2. Same command with process `TEMP` and `TMP` set to the absolute task-owned `artifacts/broad-review-20260930/temp`: Engine **1002 passed, 1 skipped**; LocalMcp **168 passed, 1 skipped**; Desktop **359 passed, 1 failed**. The sole Desktop failure was the native view journey: `Timed out: debugging port (last: "error: fetch failed")`. The script exited **1**, before its later static/browser/repository stages. Engine's skipped test is an explicitly opt-in storage/open measurement; the BCM upgrade copy test was inconclusive: `workspace/BCM.nendo already carries the assessment upgrade, so there is nothing to apply to a copy of it.` Neither skip is relabelled a pass. Log: `production-task-temp.log`.
3. Outside the sandbox, task-local temp, exact isolated native retry: `dotnet test tests/Nendo.Desktop.Tests/Nendo.Desktop.Tests.csproj --no-build --no-restore --nologo --filter 'FullyQualifiedName=Nendo.Desktop.Tests.DesktopExtensionViewJourneyTests.ViewsRunInlineIsolatedFromTheWorkbenchAndStopWhenSwitchedOff' --logger trx --results-directory artifacts/broad-review-20260930/native-results`: **1 passed, 0 failed, 0 skipped**, duration **1 m 24 s**. This uses a generated Nendo file and isolated device profile, not the owner's host or installation. Log: `native-journey.log`.

The original full production invocation did not pass. Its components were completed separately; a reconstructed set of passing component runs is not reported as a single successful full invocation.

### Repository, website and setup

- `pwsh -NoProfile -File ./tools/Test-Repository.ps1`: exit **0**, literal `Repository verification passed.` At that run: **1076 tracked text files** had LF endings, **22 ADRs**, **12 contracts across 9 blackbox phases**, binary structure and shell identity checks passed. This ran before the concurrent history-folding work changed tracked source. Log: `repository.log`.
- `pwsh -NoProfile -File ./tools/Test-Site.ps1 -SkipInstall`: initially stopped with `EPERM` at the owner's roaming Astro telemetry config. Retry with process `ASTRO_TELEMETRY_DISABLED=1` exited **0**: **25 files, 0 errors, 0 warnings, 0 hints; 6 tests passed; 15 pages built; Pagefind indexed 8 pages/1519 words; 401 internal references resolved**. No deployment or external-link check. Log: `site-telemetry-disabled.log`.
- `pwsh -NoProfile -File ./tools/Test-NendoBuildPruning.ps1`: exit **0**, literal `Build pruning checks passed`; covers dry run, changed-file hash refusal, owned deletion, unrecognized-file retention, manifest retention, repeat no-op and path-traversal refusal. Log: `build-pruning.log`.
- `pwsh -NoProfile -File ./tools/Test-NendoSetup.ps1`: sandbox initially denied its private HKCU fixture writes. Outside-sandbox retry exited **0**, literal `Nendo setup checks passed`. This is synthetic setup/upgrade/uninstall testing against a task root, private class store and private Start Menu; the owner's installation and registrations were preserved. Log: `setup-fixtures-outside-sandbox.log`.

### Browser fixture measurements

The remaining stages of `Test-Production.ps1` were copied without changing their bodies into task-owned `artifacts/broad-review-20260930/production-boundaries.ps1`; only the already-run Workbench/.NET invocation stages were omitted and the tools root was bound to the real repository. `pwsh -NoProfile -File artifacts/broad-review-20260930/production-boundaries.ps1` outside the sandbox passed the static client-neutrality, storage, expression-evaluator, consent, closed-MCP, Help and dialog checks, then the Graph, Work Dependencies, Systems Lens and Gantt fixture lanes: `pwsh -NoProfile -File ./tools/Review-NendoGraph.ps1`, `Review-WorkDependencies.ps1`, `Review-SystemsLens.ps1`, `Review-Gantt.ps1` (each invoked with the same pwsh flags). Measurements include both themes and each lane's geometry/keyboard/event-burst checks. They use real Edge rendering with typed fixture brokers, not owner files or a full native app session.

The first Capability Atlas attempt passed its **34 Node tests** but stopped on browser resource HTTP **500**; Archi was not reached. During that run, an overlapping payload `npm ci` hit `EPERM` unlinking the loaded Rolldown native dependency. Workbench dependencies were restored after the fixture processes ended. `pwsh -NoProfile -File ./tools/Review-BcmAtlas.ps1` then exited **0**, including the two schemas, Northstar geometry, themes, native chrome and standalone SVG export. The initial 500 is recorded; it is not promoted to a product defect from this environment overlap. Logs: `production-boundaries-outside-sandbox.log`, `workbench-restore-retry.log`, `bcm-retry.log`.

`pwsh -NoProfile -File ./tools/Review-ArchiWorkbench.ps1`: exit **0**. Existing Archi/model/canvas/view-kit Node tests and browser measurements passed, including themes, navigation/toolbar fallback, editing/commit/undo/rebase, large-gallery and pointer/drag cases in that lane. Its successful bounded Commit scenario does not cover R30-001's 202 dependent writes. Log: `archi-fixture.log`. All six package fixture lanes have now passed in separate component calls.

### Payload and installer

The first main-checkout `pwsh -NoProfile -File ./tools/Publish-NendoPayload.ps1` stopped with npm exit **-4048** / `EPERM` unlinking `rolldown-binding.win32-x64-msvc.node` while the review's fixture servers were using it. The old manifest-backed payload had already been hash-pruned; the previous installer was retained. Dependencies were restored after the fixture processes ended.

To preserve concurrent source work, a task-owned local checkout at `artifacts/broad-review-20260930/packaging-snapshot` was detached at **68f29b754313263d802c88572f21679b1c44b2a4**. From that checkout, `pwsh -NoProfile -File ./tools/Publish-NendoPayload.ps1` exited **0**; npm restore/check/430 tests/build, .NET restore and self-contained Release win-x64 publish completed. No unfinished ADR-0021 code entered this build. Source hashes were checked by the publish script.

From the main repository root:

- `pwsh -NoProfile -File ./tools/Build-NendoInstaller.ps1 -PilotRoot artifacts/broad-review-20260930/packaging-snapshot/artifacts/build/publish`: exit **0**, literal `Built Nendo installer: C:\Users\thoma\Projects\nendo\artifacts\installer\Nendo-Setup.exe`.
- `pwsh -NoProfile -File ./tools/Test-NendoInstaller.ps1 -PilotRoot artifacts/broad-review-20260930/packaging-snapshot/artifacts/build/publish`: owner-root precheck engaged, then exit **1** with `Refusing to run: Nendo is installed at C:\Users\thoma\AppData\Local\Programs\Nendo.` This is its safety interlock, not a build failure. The NSIS wrapper/install/uninstall lane did not execute.
- `pwsh -NoProfile -File ./tools/Test-NendoSetupIsolated.ps1 -PilotRoot artifacts/broad-review-20260930/packaging-snapshot/artifacts/build/publish`: exit **0**, literal `Isolated setup smoke passed`; **316 MB** staged copy pruned. The lane asserts the owner's installation/association/shortcut remain untouched. It checks first install bytes, moved-payload upgrade, obsolete owned-file removal, unowned file retention and uninstall plus private association/identity/shortcut ownership behavior. It does not invoke NSIS.

Deliverable: `artifacts/installer/Nendo-Setup.exe`, product **0.16.0**, build ID **abeebc67aaec1258**, SHA-256 **FB7980B85A2933EE2E63A81EDB67DEA8153621E1718F69F32C9A0877975B23D2**, unsigned x64. `installer-status.json`: setupLogic **passed**, nsisWrapper **not run for this build**. Existing owner installation was not upgraded during the review. Logs: `publish-snapshot.log`, `installer-build.log`, `installer-interlock.log`, `setup-payload-isolated.log` in the review scratch directory. The installer contains the reviewed behavior, including these outstanding defects; no fixes are implied by rebuilding it.

After setup passed, all six copied demo `.nendo` files in the disposable checkout were opened read-only through the published public Engine API and closed (log `clone-inspection.log`). `pwsh -NoProfile -File ./tools/Remove-NendoBuildPayload.ps1 -BuildRoot artifacts/broad-review-20260930/packaging-snapshot/artifacts/build/publish -Apply` exited **0**, hash-pruning **686 payload files**. The clean detached checkout and its build caches were removed after its revision/status checks. The installer, small probe sources/logs and copied `publish-manifest.json`/`built-installer.json` remain in scratch; the recorded commands above describe completed runs, not a still-existing staged checkout.

### Source coverage and limits

| Area | Review coverage | Limits |
| --- | --- | --- |
| Engine | Typed writes/batches, semantic IDs, versions/idempotency, hierarchy, proposal clone/replay, generated fields/sequences, actions/consent, compensation/history, SQLite lifecycle/copy/upgrade/validation, query/aggregate paths | Typed-service boundary probes plus baseline. No arbitrary corruption, disk-full, physical power-loss or exhaustive crash timing injection. Concurrent ADR-0021 implementation excluded. |
| Desktop | Session gate/request binding, file lifecycle/recovery/copy, persisted device stores, extension hosting/kill switches, Workbench protocol and authority, agent host/settings | Five exact-source/compiled-service probes plus baseline/native view journey. No claim about installed multi-window paint, notification menus or human keyboard/screen-reader experience. |
| MCP | Closed tools/resources, application handles/leases, authoring budgets, ownership/receipts, proposal cancellation/lifecycle, transport authority | Live planner instance/schema/records/health reads. Mutations only in isolated probes and the final review-record proposal; no broad mutation driver against the planner. |
| Workbench | Draft retention/redraw/version boundary, queries/surfaces/charts, exact-number rendering, custom-view data/state/proposal broker, typed value projections | Six production-function/package probes and 430 unit tests. Probe stand-ins and stripped TypeScript are identified; they are not claimed as native UI journeys. |
| Shipped packages | Graph, Work Dependencies, Systems Lens, Gantt, Capability Atlas, Archi; schema/model/layout/write batching/import/export/toolbars | Existing fixture lanes, generated/production-model probes, both themes where the lanes measure them. No manual exhaustive editing of all packages or owner data. |
| Delivery/tooling | Gates, dependency boundaries, package scripts, pruning, setup ownership and rollback, payload/NSIS pipeline | Synthetic and real-payload isolated setup passed; paired payload/installer built. Clean-user NSIS install/uninstall is excluded by the owner-installation interlock. |
| Website | Authored guide alignment, search renderer, async-search tests, build/assets/internal links | No publish, external link crawl, visual first-read study or human accessibility audit. |

Targeted reproduction sources and literal output are under `artifacts/broad-review-20260930/{engine,desktop-mcp,workbench}/`. Probes deliberately exit 0 after printing a reproduced defect; this means the reproduction completed, not that the behavior was correct. Seventeen findings have an executed component/service reproduction; R30-008's final native redraw chain remains a source trace, and R30-018 is entirely a source/contract comparison.

## Accepted limitations and open questions

These are current documented decisions/qualification limits in `docs/roadmap.md`, not new defects or fresh test passes:

- The credential/account boundary was deliberately removed for local single-user iteration (ADR-0009). No shared-machine security claim is made.
- A received file's custom-view code runs when shown and may reach network/clipboard; ADR-0013 accepts this. The shared persisted kill-switch reset in R30-014 is a defect in that chosen control, not a request to reverse the ADR.
- Windows x64, local unsigned per-user delivery; ARM64, public distribution and signing are not qualified. Physical power loss and cloud/live-root writes are not qualified/supported.
- Installed large-dataset startup is an accepted measured exception, not a pass. This review did not rerun the scaling/performance matrix or clipboard/download/pop-up/memory-budget lanes.
- Human usability/accessibility, several Windows shell paints and notification behaviors remain owner-reported. Fixture geometry and native journey assertions do not replace first-time-person or assistive-technology evidence.
- The clean-user NSIS wrapper lane is an accepted limitation while every recipient builds the installer. Isolated setup tests cover setup logic, not wrapper extraction or its real `Uninstall.exe`.

Highest-priority correction directions are R30-002/R30-014 (revocation/device Off surviving another controller's save), then R30-001 (partial Archi Commit). Follow-up work should reproduce each defect in an existing running lane, fix it, falsify the guard against the old behavior, restore the fix and retain the literal failure in the corresponding Finding. This review has not performed those implementation steps.

## Original review handoff

The source review is complete. Fix/triage work remains open. `REVIEW.md` is the only workspace source/document change owned by this review; concurrent history-folding changes and the Archi demo commit are preserved. No product fix, commit, push, publication or owner installation update occurred.

In Planner.nendo, the proposal **Broad Nendo review — 2026-09-30** is **previewable**, with **29 operations, 29 semantic-diff entries, 0 diagnostics**: one Work record (`nd.work.r.broad-review-20260930`, Status Review, Standing Within accepted scope, Horizon Now), 18 linked Untriaged Findings and 10 linked Checks. Check outcomes: 7 Passed, 2 Failed (measured defect behavior and the stopped full production invocation), 1 Not run (clean-user NSIS wrapper). Passing component baselines do not mark the Work Done.

Proposal ID: `proposal-12fa229f3be811e1a73b751515b92714`; captured definition revision **39**; operation digest `bc9f934f03914bcc206c02497a674f9425eb3489f26834d2454d19d3b11a62aa`. It creates records and declares `irreversibleDeclared`; no universal undo is promised. The lease was **released** and the proposals resource was read back with the exact title/state. The proposal has **not been applied**. Reference codes are assigned by Nendo; they are not guessed here or treated as stable before acceptance (see R30-011).

Next action: the owner accepts/reviews the proposal, triages R30-001–R30-018 and selects follow-up work, starting with revoked consent/device Off persistence and partial Archi Commit. Before any fix is closed, add and falsify a measuring regression guard in an existing lane and record its literal failure. REVIEW.md carries the durable evidence; the task-owned artifacts directory is disposable scratch, not a retention archive.

Final report audit: **18 unique finding headings**, counts **3 High / 14 Medium / 1 Low**, UTF-8 decoding successful, **0 CR bytes**, **no BOM**. `git diff --check` exited **0**. The final installer SHA-256 still matched the built value above. Concurrent owner paths were left in place; no branch/index or source ownership changes were made in the main checkout.


## Fix pass — 2026-09-30

Codex fetched the newly pushed review and fast-forwarded the clean work branch to
4795e59. The work is the review's stable item nd.work.r.broad-review-20260930; its
short Reference was not available here. The registered owner-machine planner is
not connected in this cloud environment, so no planner proposal or owner data was
edited and no existing review proposal is claimed accepted. The user explicitly
authorized implementing these fixes and subsequently requested a draft PR. The
changes are prepared on codex/fix-review-20260930 against main for that handoff.
No publication or owner installation change was made by this pass.

### Implemented corrections and measuring guards

The code guards below belong to existing test lanes. Each behavior defect was
restored temporarily, the new guard failed, and the fix was restored and passed.
.NET source restorations and builds were serialized. The prose-only guide
correction was checked against the supported compensation contract; no synthetic
runtime test is claimed for a text edit.

| Finding | Correction and guard | Literal falsification evidence |
| --- | --- | --- |
| R30-001 | Archi commits at most 200 record writes in one batch; larger diffs send no requests and retain the draft. Generated 202-write diff measured in Node and the real browser. | An over-limit Commit sent 2 write requests and persisted 200 records; it must save nothing. |
| R30-002 | Shared consent changes lock and reread current device state; durable withdrawal generations prevent stale approvals from restoring revoked consent. | An unrelated approval restored revoked consent from a stale store. |
| R30-003 | Search excerpt sanitization preserves mark tags and strips other markup. Existing site script lane measures both. | AssertionError [ERR_ASSERTION]: The search excerpt stripped Pagefind match highlighting. |
| R30-004 | Archi labels use cycle detection; named/unnamed cyclic tree rows and endpoint property links render in both themes. | RangeError: Maximum call stack size exceeded |
| R30-005 | Signed trend columns share a zero baseline; exact negative, zero and null values have distinct accessible labels. | A negative trend lost its signed amount. |
| R30-006 | Hierarchy placement uses Int128 arithmetic and renumbers unrepresentable first/last placements. Actual tree order and mixed-sign midpoint are measured. | Expected:<-1>. Actual:<2048>. A representable midpoint was lost to ordering overflow. |
| R30-007 | Complete move requests bind canonical operation IDs; receipt replay precedes geometry expansion, survives reorder/reopen and rejects changed-input key reuse. | Nendo.Engine.NendoPreconditionException: moving is already there. |
| R30-008 | Explicit retained display-draft state holds read-chase after blur and survives backup/cancelled-dialog paths; deliberate departure releases it. | read-chase lost the retained draft hold after focus left. |
| R30-009 | Agent settings use scoped controller admission inside the gate. Late requests cannot alter the next file session. | Assert.ThrowsExactlyAsync failed. Expected exception type:<Nendo.Engine.NendoPreconditionException> but no exception was thrown. |
| R30-010 | Port and lease settings validate before persistence or listener restart; rejection leaves both stores and the active lease unchanged. | A refused expiry saved the chosen file port. |
| R30-011 | Promotion guards allocated sequence counters, including later-removed sequences; changing/installing a sequence binds its data-derived seed. An unrelated create without allocation still promotes the reviewed code. | Expected:<Stale>. Actual:<Active>. Acceptance silently replaced the reviewed generated code after its sequence advanced. |
| R30-012 | Fresh move results include automatic-action writeback versions; exact replay reconstructs the historical outcome. | Expected:<3>. Actual:<2>. The move returned the version before its action wrote back. |
| R30-013 | Systems Lens layers the SCC DAG, then places members in their component column. Browser guard uses A feeds B, B/C circuit, C feeds D. | A circuit was split across supply layers instead of ordered as one component: {"a":40,"b":310,"c":40,"d":310} |
| R30-014 | Shared view controls merge current state; synchronous host checks and device-change events stop live frames, including frames held during proposal review, without dropping drafts. Later explicit switches supersede old unsaved choices; oversized saves preserve the readable durable document. | An unrelated stale file setting restored the device switch to On. Device Off left the review frame connected. |
| R30-015 | Projections and normalized writes construct own properties; reserved field IDs and nested JSON state/place keys survive. | Projection lost own field __proto__. Create normalization lost a reserved field ID. JSON projection lost reserved keys. |
| R30-016 | Batch uniqueness, target versions and generated-version results use entityId plus recordId. Broker and live MCP vocabulary state the same scope. | The selected target changed. Select it again before saving. Batch normalization confused equal IDs in different record types. |
| R30-017 | MCP retains proposal ownership/queue entries until Engine rejection completes; queued cancellation is retryable. | Expected:<1>. Actual:<0>. Reject removed the review queue while waiting for Engine admission. |
| R30-018 | Public custom-view guide states create/mixed-create and 128-operation compensation limits. | Source comparison against docs/contracts/custom-views.md and the compensation allow-list; no runtime falsification claimed for this prose correction. |

Contracts, Archi design notes and the outside-review prompt now describe these
behaviors. Shipped package sources are Archi 0.3.4 and Systems Lens 1.2.1. Existing
.nendo files retain their installed packages until the owner accepts a package
update through the normal host flow; they were not modified directly.

### Fix-pass checks and qualification limits

These are fresh Linux/cloud results for the changed source, separate from the
original Windows review runs above. The environment used .NET SDK 10.0.204 and
Chromium. No production platform guard was relaxed.

| Command/lane | Literal outcome and scope |
| --- | --- |
| In src/Nendo.Workbench: npm run check; npm test; npm run verify:dependencies; npm run build | All exited 0. 444 tests passed, 0 failed. TypeScript and both Vite bundles built; dependency boundary passed. Vite's large-chunk and future config-import notices remain. |
| node --test tools/archi/model.test.mjs tools/archi/canvas.test.mjs tools/archi/view.test.mjs tools/view-kit/kit.test.mjs | 29 passed, 0 failed; includes generated over-limit commits and cyclic relationship labels. |
| node artifacts/review-fixes-20260930/archi/browser-gate.mjs | Exit 0; executes existing Gate-ArchiWorkbench.mjs through Playwright/Chromium. Final measurements: commitBound planned 202, requests 0, retained 202; relationshipCycles records 4, propertyRenders 8, themes 2. The Windows Edge wrapper was not run. |
| node /tmp/nendo-systems-lens-run.mjs | Exit 0; literal Systems Lens browser measurements passed (Chromium, existing Gate-SystemsLens.mjs). The SCC fixture and existing lane assertions passed. |
| Signed trend geometry through production columns and shipped CSS in Chromium | Positive and negative 250 bars both measured 33.5 px around the same baseline; zero/null markers measured 2 px with distinct exact/none labels. Both themes passed. This is a component browser measurement, not a native desktop journey. |
| pwsh -NoProfile -File ./tools/Test-Site.ps1 -SkipInstall | Exit 0: 7 script tests passed, 0 failed; Astro check reported 0 errors/warnings/hints; 15 pages built and 402 internal references checked. No publication. |
| pwsh -NoProfile -File ./tools/Test-ApplicationNeutrality.ps1 | Final exit 0: application-neutral shared boundary (358 source files scanned); client-neutral production source boundary. |
| dotnet test artifacts/review-fixes-20260930/portable-engine-tests/PortableEngineTests.csproj --no-restore --nologo | Passed! Failed: 0, Passed: 79, Skipped: 0, Total: 79. Actual Engine sources plus the changed tests and proposal/hierarchy baselines, with only Windows instance ownership replaced by a process-local fixture. This is component evidence, not Windows ownership qualification. |
| dotnet test artifacts/review-fixes-20260930/desktop-controller-tests/PortableDesktopTests.csproj --no-restore --nologo -p:UseSharedCompilation=false -nodeReuse:false --logger 'console;verbosity=normal' | Final unfiltered run exited 0: Passed 47, Failed 0, Total 47. Includes scoped/refused settings, grant and view-control persistence, live host authority/events and MCP rejection cancellation. Fixture boundaries are described below. |
| dotnet build src/Nendo.LocalMcp/Nendo.LocalMcp.csproj --no-restore --nologo -p:EnableWindowsTargeting=true -p:UseSharedCompilation=false | Build succeeded. 0 Warning(s), 0 Error(s). Engine and LocalMcp compiled; this does not run Windows Desktop. |
| Native Engine test invocation | Test assemblies compiled, but execution stopped at PlatformNotSupportedException: Local instance ownership currently supports Windows only. The native runtime lane did not pass. |
| pwsh -NoProfile -File ./tools/Test-Repository.ps1 | Exit 1 at the binary-assets locked-file self-check: a copied demo held without sharing was reported as corrupt/unreadable rather than open in Nendo under Linux. The production gate was left intact. |
| pwsh -NoProfile -File artifacts/review-fixes-20260930/root/repository-remainder.ps1 | Exit 0 for the unchanged remaining assertions: vendored files/manifests, tracked-file hygiene, LF, ADR structure, 12 contracts across 9 outside-review phases, and shell identity. This scratch wrapper omits only the separately attempted binary lane; its Repository verification passed output is not a full repository-gate pass. |
| pwsh -NoProfile -File ./tools/Publish-NendoPayload.ps1 | Exit 1 before a payload was produced: The term 'npm.cmd' is not recognized. Windows payload/installer scripts were not modified for this environment. |

Test-Production.ps1 was not run as a full lane: Windows Desktop/runtime is not
available here. Build-NendoInstaller.ps1, Test-NendoInstaller.ps1 and
Test-NendoSetupIsolated.ps1 were not run because the publish attempt produced no
payload. No new installer is delivered by this fix pass, and the original
review's installer must not be described as containing these fixes.

The portable Desktop/MCP component harness links current Engine, controller,
device-store and authoring-service source. Its fixture substitutions are Windows
instance ownership, local file identity, protected discovery ACLs and the native
workspace interface. It does not qualify WinUI, WebView2, process ownership,
cross-process Windows mutex behavior or installer execution. Source-linked
multiple-store tests and actual controller authority/event checks measure the
device persistence changes; the native notification journey remains for Windows.

Cross-review extended the device guards to cover unsaved approvals, late global
On and same-file On choices, repeated explicit Off, and stale persistence notices.
Removing the successful-read reset failed with: A successful shared approval
reread kept the old persistence failure. Removing the pending file revision
comparison failed with: An unsaved session file On outran another controller's
later file Off. The fixes were restored before the final component run.
Removing the writer's byte admission failed with: An oversized save replaced
readable device Off with settings that reopen as On. Its restored guard measures
unchanged durable bytes, repeated reads and reopen against a valid near-limit
4,096-file fixture.

Final changed-file audit: 74 tracked or new source/document/test paths, UTF-8
without BOM, 0 CR bytes; git diff --check exited 0. No workspace .nendo path
changed. Final command logs and portable runners are disposable task scratch
under artifacts/review-fixes-20260930/ and artifacts/review-fixes/device-state/;
the repository test sources and this report carry the lasting evidence.

### Remaining handoff

Run the full production lane and rebuild/test the paired payload and installer on
Windows before closing product qualification. Reconcile these source changes and
exact Check outcomes into nd.work.r.broad-review-20260930 when the registered
planner is reachable; do not mark its original previewable proposal accepted or
the Work Done from this report. Install updated shipped packages through the
normal host flow when the owner is ready to accept them. The changed source,
regression guards and this report are submitted together for draft-PR review;
the remaining Windows lanes keep product qualification open.
