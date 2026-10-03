# Broad Nendo review — reassessed 2026-10-03

Status: independently assessed and committed on 2026-10-03. All 25 corrections hold. The assessment found five problems in or beside the fixes, corrected below with guards that were seen to fail.

## Independent assessment — 2026-10-03

Four reviewers read the uncommitted tree by area (Engine storage; MCP and tools; Workbench and settings; extensions and site) against each finding's original text. All 25 fixes correct their defect. Corrected in the same commit, each guard falsified by restoring the old line and quoting the failure:

| Problem | Correction | Guard failure with the defect restored |
| --- | --- | --- |
| R02-001 fix: an Archi property draft whose save wrote nothing (Add property, then remove the blank row) was never cleared, hid later changes and wrote stale values back on the next edit. | `saveProperties` treats an empty plan as settled (`extensions/archi/view.js`). | `A draft identical to the file outlived its save.` |
| R02-024 fix: a corrupt or unsupported `agent-settings.json` blocked every later save, where a save used to repair it. | A document that was read but is unusable is replaced with this window's values; one that could not be opened still refuses (`DesktopAgentSettingsStore.cs`). | `A corrupt settings document blocked every later save.` |
| R02-011 fix: a failed Studio outline read stayed on screen after the file moved on, so moves from stale rows were refused until Try reading again. | The error waits for the button only at the change sequence it failed at (`studio-outline.ts`). | `An outline error outlived the revision it failed at.` |
| R02-015 sibling: a hierarchy move whose automatic action deleted the moved record still returned a live version, fresh and on replay. | `NendoMoveRecordResult.RecordVersion` is nullable; a generated deletion or a replayed `data.deleteRecord` yields null. | `A move whose action deleted the record returned a live version.` |
| R02-008 fix: the uploader printed an acceptance retry key that no rerun can replay, since the key dies with its lease. | The message and `mcp-interface.md` name the proposal and say to inspect Pending changes and History. | Message change; `put-package.test.mjs` 8 passed. |

Also: Archi 0.13.1, BCM Atlas 1.3.1 and Systems Lens 1.2.2 carry the corrected package code, so a proposal of the fixed code is distinguishable from the old one; `calculations-and-actions.md` now states that the R02-018 guard is broader than the empty-collection case (any data proposal in a file with a trigger goes stale on any record change); the R02-019/020 and uploader paragraphs moved out from under "What a refusal says". The concurrent-approvals flake the first assessment gate hit (`Concurrent approvals lost application-3`, 5/5 alone) was fixed separately in "A required device-state lock waits five seconds, not one".

Accepted as limitations, not corrected: `RequireInspectableCommitAsync` counts every table on each commit, which adds latency near the bounds; the promotion path of R02-025 has no final-bound test; R005B and R022's activation-protection tests are positive-only because their hooks are new; a New-file stage changed before activation reports `replacement-target-changed` with replacement wording; a stale-authority validation whose cleanup reject also throws reports the cleanup error; a multi-batch import partly committed by an older build with explicit retention marks now conflicts on exact retry; `Test-Site.ps1` now needs Windows and Edge for the search lane. The planner proposal **REVIEW.md fixes and regression evidence — 2026-10-03** belongs to the fixing session's handle and was not applied; out-of-band reviews stay out of the planner.

Gate on the corrected tree (`Test-Production.ps1 -SkipRestore`): Workbench checks, build and tests; .NET build with zero warnings; Engine 1,061 passed and 2 skipped (`TheAssessmentUpgradeAppliesToACopyOfTheRealBcmFile`, and `ANewArchiModelKeepsTheConceptTypesAndTheTopLevelFolders` because Archi.nendo was open), LocalMcp 176 passed and 1 skipped, Desktop 383 passed (the clipboard journey included); tool boundaries; production boundaries; all custom-view presentation lanes; repository gate through tracked-file hygiene. It then stopped at the binary-asset interlock: `workspace/Archi.nendo is open in Nendo`. That says nothing about the file's bytes, which this change does not touch; the line-ending, ADR, blackbox and shell-identity sections after it did not run in that pass. Not run: the NSIS wrapper under a clean Windows user.

## Fix checkpoint — 2026-10-03

- Objective: repair R02-001–025, add regression guards in the existing lanes, observe those guards fail with the defects restored, and deliver the source changes and rebuilt installer without committing.
- Starting revision: `086d1255af963f36d7bfc1e9561a02e6af7401c0`. The only pending edit at entry was this report from the preceding reassessment.
- Planner: confirmed Planner.nendo's identity and read all 131 Work records, Now/Next and Decision standing. No applied R02 work record exists, and the earlier reassessment proposal is no longer listed. Fresh proposal **REVIEW.md fixes and regression evidence — 2026-10-03** is previewable with 39 operations (one Work, 26 Findings, 12 Checks), zero diagnostics. Proposal ID `proposal-e1f65df02d2422079bdfc05efece1e2d`; proposed Work ID `nd.work.r.review-fixes-20261003`, title **Fix the 25 October review findings; await independent assessment**. The lease is released. These records are proposed, not applied; acceptance remains the person's action. References will be assigned by Nendo, not invented here.
- Work split: storage/query/lifecycle corrections; shipped extension controllers; Workbench outline/reference/retry recovery; Engine/MCP result handling, tooling, settings and site. The primary agent integrates documentation, validation and packaging.
- Remaining for acceptance: third-party assessment of this uncommitted working tree; rerun the full production gate where Windows permits clipboard read-back; exercise the NSIS wrapper under a clean Windows user. Source fixes, local guards, downstream gates, packaging and planner handoff are complete. No independent assessment has run. Do not commit.

### Fix progress (resume here)

A checked row means the source correction and its local regression lane passed,
and a guard was observed failing with the defect present. It does not mean owner
acceptance, independent assessment, or installed-runtime qualification. Pending
broader checks are listed after the table. Original finding descriptions below
remain the pre-fix evidence.

| Done | ID | Current state and regression evidence |
| --- | --- | --- |
| [x] | R02-001 | Archi retains stable draft row IDs until successful save. Old code: `A pending property create discarded its draft.` and `A refused property create discarded its draft.` Extension Node lane: 131 passed. Full Archi browser lane passed. |
| [x] | R02-002 | Archi installs only the newest read; superseded readers wait for its result. Old code: `An older read replaced the newer model.` Extension Node lane passed. |
| [x] | R02-003 | Diagram text alternatives receive named entries. Old code: `Diagram text alternative entries lost their concept names.` Extension Node lane passed. |
| [x] | R02-004 | Pages and all five read-only folds share stored/calculated/hierarchy filters. Old code: `CollectionAssert.AreEqual failed. R004 read-only folds must use the same set as writable folds (flag).` Fixed storage group: 54 passed. |
| [x] | R02-005 | Required backup is identity/content checked and pinned through folding. Missing/replaced/changed originals each failed `Expected exception type:<Nendo.Engine.NendoPreconditionException> but no exception was thrown.` Real Windows guards also reject write/delete attempts while pinned. Fixed storage group passed. |
| [x] | R02-006 | Read-only New empty copy preview uses the inspected snapshot, matches writable counts/label/conflicts and permits creation. Old code: `This file is open for inspection only. Editing and application changes are disabled.` Fixed storage group passed. |
| [x] | R02-007 | Uploader batches respect 16 operations per call across mutations. Three packing fixtures pass, including 16 extra operations. Old code: `MCP calls exceeded sixteen total operations: 17`. |
| [x] | R02-008 | Only the explicit Unattended refusal is a successful handoff; transport/stale/unknown acceptance exits 1 with proposal and retry identity. Protocol and tool refusals retain their codes. Old code: `An uncertain or refused acceptance must exit unsuccessfully. 0 !== 1`. Eight uploader/client tests pass. |
| [x] | R02-009 | File-scoped outline caches and generation checks reject previous-file rows and late replies. Old behavior: `Studio outlines from the previous file survived file reset.` and `A late reply from the previous file replaced the new outline.` |
| [x] | R02-010 | Outline completion uses the draft-aware read chase. Old behavior: `A completed outline redrew through typing.` |
| [x] | R02-011 | Failed outline reads expose retry at the unchanged revision. Old behavior: `A failed outline read suppressed retry at the same revision.` |
| [x] | R02-012 | Null-prototype reference version dictionary preserves reserved field IDs. Old behavior: `The selected __proto__ target version vanished from the native request.` |
| [x] | R02-013 | Moves retain the exact request through timeout/reload, recover by receipt, and permit only exact retry while unresolved. Old behavior: `The hierarchy move was dispatched without retaining its exact retry request.` Actual Desktop adapter, controlled host responses. |
| [x] | R02-014 | Invalid-proposal cleanup completes despite request cancellation, unfreezes the draft and caches only a settled verdict. Held-Engine-gate guard: original code failed with `TaskCanceledException` at `RejectProposalAsync`; restored fix passes no-orphan, replay, amend and revalidate assertions. Authoring/recovery suite: 9 passed. |
| [x] | R02-015 | Batch responses preserve the final generated deletion as a null version (create and update). Old code: `A record deleted by an automatic action must have no returned version.` Engine batch/proposal suites: 25 passed. |
| [x] | R02-016 | A source-less circuit is never described as still fed. Real-browser old code failed: `R02-016 a source-less circuit was described as retaining or losing a source path: {"exposed":[],"reduced":["b"],"removed":["a"]}`. Fixed full Systems Lens browser lane passed. |
| [x] | R02-017 | BCM saves only offered stored maturity. Old code: `An unrelated edit overwrote stored maturity with the latest assessment.` / `An assessed-only maturity emitted a null field ID.` Node and full BCM browser lane passed; stored 5 stays 5 when derived maturity is 1, in both themes. |
| [x] | R02-018 | A captured behavior chain retains its conservative data-revision dependency even with zero effects/remaining record reads. Persisted-plan assertion and stale promotion pass. Old code: `An empty collection that gained a member must make the reviewed no-effect plan stale.` |
| [x] | R02-019 | MCP result projection uses entity and record ID, preserves generated deletion, and delegates command versions to the typed service. Old create returned 3 for notes/shared at version 1. Added real execute_command cases with notes/shared at 3 and projects/shared at 4, plus generated deletion. Restored old command arithmetic failed `Expected:<3>. Actual:<2>` and `Expected:<>. Actual:<2>`; restored fix: 2 passed, including exact retry/no new history. Initial mutation/import suites: 23 passed. |
| [x] | R02-020 | JSON import forwards true/false/null retention marks through multiple batches and exact retry; changed marks conflict under the same key. Old code: `JSON import dropped the explicit retention mark on row-01.` Mutation/import suites: 23 passed. |
| [x] | R02-021 | Search dropdown fits its scrolling rail. Browser guard: 1280/1024/768/390, both themes, 64 scrolled result hit targets pass. Old CSS: `R02-021: search panel is clipped at 1280px light: panel right 480, rail right 296.` Full site gate passed. The pre-existing 415px document width at a 390px viewport is unchanged by search; this is not full mobile-page qualification. |
| [x] | R02-022 | Transformed New empty copy stage is content/identity checked and protected through activation. Original altered-kept-value case failed `Expected exception type:<Nendo.Engine.NendoPreconditionException> but no exception was thrown.` Fixed storage group passed, including write/delete refusal during activation. |
| [x] | R02-023 | BCM retains exact out-of-scale values as selectable options. Old code: `The editor erased the current out-of-scale maturity.` Node and full BCM browser lane passed with values 9 and -2 preserved in both themes. |
| [x] | R02-024 | Settings merge only this window's changed fields under the required cross-process device lock, retaining pending intent until persisted. Old code: `A stale port edit must preserve another window's lease expiry choice.` The first fix also failed `Retrying an unsaved expiry choice must not restore the old disk default.` Both corrected: DesktopAgentSettingsTests 12 passed. |
| [x] | R02-025 | Both commit paths enforce actual pending table/schema/page growth, including generated effects. Old 200-record/64-field batch failed `Expected exception type:<Nendo.Engine.NendoPreconditionException> but no exception was thrown.` Fixed guards measure rollback and reopen, including generated effects reaching 100,001 operation rows. Storage group: 54 passed. No new physical 256 MiB overflow injection; page count/size are checked by production code. |

Exact completed commands (repository root unless stated):

- `node --test tools/put-package.test.mjs`: 8 passed, 0 failed.
- `dotnet test tests/Nendo.Engine.Tests/Nendo.Engine.Tests.csproj --no-restore --nologo --filter 'FullyQualifiedName~RecordWritesBatchTests|FullyQualifiedName~BehaviourProposalTests'`: 25 passed, 0 failed.
- `dotnet test tests/Nendo.LocalMcp.Tests/Nendo.LocalMcp.Tests.csproj --no-restore --nologo --filter 'FullyQualifiedName~ReviewMutationTests|FullyQualifiedName~DataMutationProtocolTests|FullyQualifiedName~ImportExportProtocolTests'`: 23 passed, 0 failed.
- `dotnet test tests/Nendo.Desktop.Tests/Nendo.Desktop.Tests.csproj --no-restore --nologo --filter 'FullyQualifiedName~DesktopAgentSettingsTests'`: final 12 passed, 0 failed.
- `dotnet test tests/Nendo.Engine.Tests/Nendo.Engine.Tests.csproj --no-restore --nologo --filter 'FullyQualifiedName~ReviewStorageRegressionTests|FullyQualifiedName~NewFileTests|FullyQualifiedName~HistoryFoldTests|FullyQualifiedName~TypedRecordQueryTests|FullyQualifiedName~FileInspectionTests' -p:ArtifactsPath=C:/Users/thoma/Projects/nendo/artifacts/fix-review-20261003/storage-build`: 54 passed, 0 failed, 0 skipped, 1m44s. Task-owned isolated build output removed after success.
- `dotnet test tests/Nendo.LocalMcp.Tests/Nendo.LocalMcp.Tests.csproj --no-restore --nologo --filter 'FullyQualifiedName~AuthoringCancellationTests|FullyQualifiedName~AuthoringRecoveryTests'`: 9 passed, 0 failed; the cancellation guard was separately falsified and restored.
- `node --experimental-vm-modules --test 'tools/archi/*.test.mjs' 'tools/bcm-atlas/*.test.mjs' 'tools/view-kit/*.test.mjs'`: 131 passed, 0 failed. `pwsh -NoProfile -File ./tools/Review-SystemsLens.ps1`, `Review-BcmAtlas.ps1` and `Review-ArchiWorkbench.ps1`: each exit 0 with its completion marker. Actual browser and package/API code, fixture brokers; no installed-host or human screen-reader claim.
- In `src/Nendo.Workbench`: `node 'C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js' run check` and `node 'C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js' test`: TypeScript exit 0; 464 tests passed, 0 failed. The six Workbench defect reversions each failed; all fixed source was restored before the full pass.

Resume notes: source and tests are uncommitted in the working tree. Temporary
details/logs are in `artifacts/fix-review-20261003/` and
`artifacts/reassess-20261003/root-*.log`; this ledger is the durable handoff.
Do not rerun the older reassessment probes as acceptance tests: they assert that
defects exist. One initial proposal test incorrectly attempted to retain a
session-only proposal across coordinator reopen; the final guard instead reads
and asserts the persisted behavior plan, then tests promotion in its owning
session. One initial import fixture redundantly set the default false and was
refused as a no-op; the corrected fixture tests both defaults. These fixture
errors are not product failures.

- [x] All 25 local correction/guard rows checked. Internal cross-check found and corrected a failed-save retry flaw, and requested the additional command guards above. This is internal review, not the requested third-party assessment.
- [x] Affected contracts, public guide, architecture/ADR implementation details and blackbox prompt integrated. No architectural invariant or accepted scope relaxed.
- [ ] Final `Test-Production.ps1` (includes repository gate) passed.
- [x] `pwsh -NoProfile -File ./tools/Test-Site.ps1 -SkipInstall`: exit 0, Astro check, 7 tests, build/Pagefind, 403 links and 8 browser cases/64 hit targets. No dependency change; installer unaffected by this website lane.
- [x] Payload and installer rebuilt; isolated setup passed; NSIS owner-installation interlock reported below.
- [x] Planner proposal validated, lease released, exact title/IDs recorded above. No acceptance call made.
- [x] Final changed-file/UTF-8 LF inspection; 63 changed/new paths, eight of them new untracked files. HEAD unchanged and index empty; left uncommitted for third-party assessment.

Integration checkpoint: the first `Test-Production.ps1 -SkipRestore` exited 1
(dependencies unchanged). Workbench checks/build passed; .NET build passed with
zero warnings and errors. Engine: 1,061 passed/1 skipped; LocalMcp: 176 passed/1
skipped; Desktop: 381 passed/1 failed. Failure:
`ViewsRunInlineIsolatedFromTheWorkbenchAndStopWhenSwitchedOff` reported
`A picture drawn from SVG did not reach the Windows clipboard intact: null`.
The browser reported `copied`, but both Windows read-back helper calls returned
null. A focused no-build rerun also failed (0 passed/1 failed). Diagnosis found
the PowerShell child exits 0 with empty stdout while stderr reports
`Requested Clipboard operation did not succeed.` from `GetDataObject` and
`GetImage`. The reader currently swallows these nonterminating errors into null;
this is not a successful clipboard measurement. Four native `OpenClipboard`
attempts returned Windows error 5, Access denied; four further attempts with
normal desktop permissions returned the same error. This access interlock is
not evidence of a Nendo image-copy defect. The reader now propagates child
errors and rejects missing/malformed measurements without weakening its image
assertions. Four controlled reader tests pass; restoring the old behavior fails
`AssertionError [ERR_ASSERTION]: Missing expected rejection.` These tests run in
the production gate. The full gate remains failed, and its downstream sections
passed separately with that scope stated. The payload publish command
exited 0 (`Published pilot: C:\Users\thoma\Projects\nendo\artifacts\build\publish`);
installer compilation also exited 0. Logs: `production.log`,
`clipboard-rerun.log`; fixture evidence:
`artifacts/extension-view-journey-cd0051d37e2f434a8792e78aa0baae0b/journey.json`.
The full integrated site gate was rerun after the public-guide edit and passed
(`site-integrated.log`).
The two .NET skips were `WhatOneRecordCostsOnDiskAndWhatOneOpenCosts` (performance
observation lane) and `TheAssessmentUpgradeAppliesToACopyOfTheRealBcmFile`
(the BCM fixture already carries that upgrade); neither is reported as passed.

`pwsh -NoProfile -File artifacts/fix-review-20261003/run-downstream.ps1` exited 0.
This task-owned harness executes the unchanged production sections after .NET:
12 uploader/clipboard-helper tests, production boundary assertions, all six
custom-view presentation lanes (graph, work dependencies, Systems Lens, Gantt,
BCM and Archi), and `Test-Repository.ps1`. Literal ending:
`Repository verification passed.` / `PARTIAL SCOPE COMPLETE: downstream sections
passed. The full production gate remains failed at the clipboard access interlock.`
Production script SHA-256 at execution:
`655DC719A762985DBA4239D2E388735C8CC7094DB7EEC91222E7A46A0794DCE6`.
The harness makes no full-production pass claim. Repository gate covers 1,128
tracked paths, including 12 contracts across nine outside-review phases; the
additional working-tree byte check below includes all eight new untracked files.
The 63 changed/new text files, including the clipboard diagnostic guard, have
valid UTF-8, no BOM and zero CR bytes; `git diff --check` passes.
All 466 published source hashes still match the working source after final
integration. HEAD remains `086d1255af963f36d7bfc1e9561a02e6af7401c0`; no staged
changes, commit, push or publication. New files that an assessor must include:
`src/Nendo.Workbench/src/studio-outline.ts`,
`src/Nendo.Workbench/scripts/studio-outline.test.mjs`,
`tests/Nendo.Engine.Tests/ReviewStorageRegressionTests.cs`,
`tests/Nendo.LocalMcp.Tests/ReviewMutationTests.cs`,
`tools/Gate-SiteSearch.mjs`, `tools/Test-SiteSearch.ps1`,
`tools/clipboard-probe.test.mjs` and `tools/put-package.test.mjs`.

Installer commands: `pwsh -NoProfile -File ./tools/Publish-NendoPayload.ps1` and
`pwsh -NoProfile -File ./tools/Build-NendoInstaller.ps1` both exited 0. Deliverable:
`artifacts/installer/Nendo-Setup.exe`, Windows x64 version 0.16.0, unsigned,
build ID `f8951d0d00579930`, SHA-256
`93C3632DF553D1D677BC244D83DD58D976D6102906E6E6E571B78C3BD5701B21`.
`pwsh -NoProfile -File ./tools/Test-NendoInstaller.ps1` stopped at its intended
safety interlock: `Refusing to run: Nendo is installed at
C:\Users\thoma\AppData\Local\Programs\Nendo.` The NSIS bootstrapper, extraction
and real HKCU uninstall registration still require a clean Windows user.
`pwsh -NoProfile -File ./tools/Test-NendoSetupIsolated.ps1` initially could not
read the owner inventory in the sandbox. With normal user access it exited 0:
`Isolated setup smoke passed`, with owner files/association/shortcut preserved,
and pruned 317 MB of staged payload. Install, upgrade, unknown-file preservation,
association/shortcut ownership and uninstall were checked against a task-owned
root. No owner installation upgrade was performed before outside assessment.

Shipped extension source folders are corrected. Existing owner `.nendo` files
have not had their embedded packages republished. Outside assessment must use
the corrected source packages and rebuilt payload; it must not assume an older
open demo already contains those package changes.

The following reassessment and original observations are retained as the pre-fix evidence.

## Reassessment checkpoint — 2026-10-03

- Objective: reassess every existing R02 finding against current code and update its evidence and next action. This is a bounded reassessment, not a new broad review of everything added since October 2.
- Current revision: `5ac4656a638e0bf55aa60faf28f580543e48f561` on `main`. `REVIEW.md` was already modified at entry, with the October 2 report and CRLF endings. That report's observations are retained below; this update normalizes the file to UTF-8/LF. Its September 30 archive was absent at entry, despite the old report's claim that it followed. This update does not invent that missing archive.
- Compared against the October 2 baseline `4982789c32977bdda80f8cd4258010e0f81fe3e4`. Eighteen findings' cited implementation files are byte-identical to that baseline. The other seven (R02-001–003, R02-009–011 and R02-013) touch changed files: the affected controllers were inspected and probed again. The outline controller is unchanged apart from nearby grid colours; the renderer still resets drafts at render entry. Archi's new undo/redo machinery still clears the property draft before its queued save, and still installs every completed read.
- Planner: connected to the registered `nendo` server and confirmed Planner.nendo's application identity. Read all 131 Work records and 243 Findings, the Now/Next lanes and Decision standing. No October 2 review Work item or R02 finding exists there. W-070 is the closed September 26 review, so it is not reopened for this distinct set. Proposal **REVIEW.md findings reassessed — 2026-10-03** (proposal-12a05de8b770e04de426615acc1a15de) is validated and previewable: 34 operations (one Work, 25 Findings, eight Checks), zero diagnostics. The lease is released; the proposal is not accepted and these new records are not applied. Stable proposed Work ID: `nd.work.r.review-reassessment-20261003`.
- Current scope: report edits, disposable fixture/controller probes and bounded planner authoring. No `src/`, extension, tooling, website or owner-file implementation change; no app/installer rebuild, installation, commit, push or publication.

### Fresh checks and their limits

All commands ran from `C:\Users\thoma\Projects\nendo`, except the Workbench test command, which ran in `src/Nendo.Workbench`. SDK: `10.0.204`; Node: `25.9.0`. Probe exit 0 means its assertions reproduced defects, not that the product behavior passed.

| Command | Literal result and scope |
| --- | --- |
| `python artifacts/reassess-20261003/source-audit.py` | Exit 0; all 25 finding sections compared to the original baseline. Current control flow checked separately; unchanged source is not a new runtime result. |
| `node artifacts/reassess-20261003/controllers.mjs` | Exit 0; fresh source-linked probes for R02-001–003, 009–013 and 016. Controlled service/DOM boundaries; no Chromium or native typing journey. R02-010 measures the outline's unconditional render callback against a controlled draft-reset boundary and checks that current `main.ts` still resets the drafts. R02-009 checks the unregistered caches and retained sequence; it does not claim a fresh native file switch. R02-013 measures exclusion from the mutation journal, not a real committed/lost-response move. |
| `node artifacts/reassess-20261003/uploader-vm.mjs` | Exit 0; actual uploader logic sends 17 operations in one call and converts an injected HTTP 503 client exception into a successful permission-limit message. Client boundary is controlled. The separate subprocess/loopback harness could not run: its child Node process exited `3221226505`, both inside and outside the sandbox; no fresh HTTP transport reproduction is claimed. |
| `dotnet run --no-restore --project artifacts/reassess-20261003/Probe.csproj -p:ArtifactsPath=C:/Users/thoma/Projects/nendo/artifacts/reassess-20261003/build -p:UseSharedCompilation=false` | Exit 0; R02-004–006, 015, 018–020, 024–025 reproduced on Windows with real Engine ownership and physical identity, without the earlier portable substitutes. R02-019 invokes the actual private MCP result projector by reflection over a real typed-service/action result; R02-020 invokes the actual import service by reflection. No live MCP mutation transport, native dialogs or installed multi-window journey. The fold uses a shortened internal retained window; all writes use disposable fixtures. |
| `dotnet test tests/Nendo.Engine.Tests/Nendo.Engine.Tests.csproj --no-restore --nologo --filter 'FullyQualifiedName~TypedRecordQueryTests|FullyQualifiedName~RecordWritesBatchTests|FullyQualifiedName~BehaviourProposalTests'` | Exit 0; **Passed 24, Failed 0, Skipped 0**. Existing adjacent coverage, not guards for the reproduced defects. |
| Workbench: `node 'C:/Program Files/nodejs/node_modules/npm/bin/npm-cli.js' test` | Exit 0; **456 passed, 0 failed, 0 skipped**. Plain `npm test` initially resolved a missing roaming npm shim and ran zero tests; the installed CLI above ran the suite. |
| `node --experimental-vm-modules --test 'tools/archi/*.test.mjs' 'tools/bcm-atlas/*.test.mjs' 'tools/view-kit/*.test.mjs'` | Exit 0; **120 passed, 0 failed, 0 skipped**. Existing extension coverage, not resolution of the open findings. |
| `pwsh -NoProfile -File ./tools/Test-Repository.ps1` | Initial exit 1: `Tracked text file(s) with CRLF or mixed line endings ... REVIEW.md`. After normalizing this task's report, exit 0: `Repository verification passed.` Binary assets passed on Windows, including all 79 tracked assets. |

The first Windows probe restore was blocked by the sandbox's access to the owner's NuGet scratch lock. Normal cache access resolved it. The harness then needed the repository's Windows target and corrected fixture fields/reference revisions/definition IDs before its final successful execution. These were harness setup errors, not product failures; intermediate partial runs are not counted as complete runs.

**Source-only this time:** R02-014, R02-017, R02-021–023. Their original October 2 reproductions remain historical evidence with their original fixture/platform limits. No fresh cancellation timing, BCM editor DOM, website geometry or stage corruption injection was executed for them. Full `Test-Production.ps1`, Desktop host journeys, site build/browser checks, payload/installer and human usability/accessibility lanes were not run in this reassessment.

**Next action:** accept or reject the planner proposal, then triage the 25 fixes, starting with R02-025 and R02-005. Every fix still needs a guard in an existing lane and a recorded falsification. No fix guard or owner acceptance is claimed by this review.

## Original scope and checkpoint — 2026-10-02

- Objective: a broad source review across Engine/storage and semantic services, Desktop and MCP, Workbench/custom views, shipped extensions, tooling/installer, and the public website. Record actionable defects with a concrete trigger, impact, source lines, evidence, and correction direction.
- Baseline: clean `main` checkout at `4982789c32977bdda80f8cd4258010e0f81fe3e4`. The current working tree, including recent Archi and HistoryFold changes, is in scope.
- Planner: the registered Nendo MCP tools are unavailable in this session. No live Work/Decision standing was read, no planner was changed, and no replacement was created. This user-authorized review continues as independent work under `AGENTS.md` and `docs/dogfooding.md`.
- Review ownership: only `REVIEW.md` is a deliverable. Disposable probes and command logs belong under `artifacts/review-20261002/`. No product fix, owner-file experiment, owner installation change, commit, push, or publication is authorized by this review.
- Six parallel source reviews covered storage/lifecycle/history; semantics/queries/mutations/proposals; Desktop/MCP; Workbench; extensions; and tooling/site. The primary reviewer checked source locations, evidence boundaries and contracts, and consolidated the findings here. All findings remain open; no planner reconciliation was possible.

## Priorities

1. **R02-025:** reject transaction growth that would make a file fail its own open limits.
2. **R02-005:** keep the required full-history backup protected and revalidated through a fold.
3. Address the Medium findings by subsystem; the browser-measured draft/data-loss findings R02-001, R02-009, R02-010, R02-017 and R02-023 deserve early attention. R02-021 is a smaller public-site usability defect.

High means a reproducible loss of recovery history or ordinary access to a valid file (P1). Medium means an actionable correctness/recovery defect in a supported flow (P2). Low means a limited usability defect (P3). Confidence and fixture/native limits are stated per finding.

## Current finding index

| ID | Severity | Finding |
| --- | --- | --- |
| R02-001 | Medium | Archi drops a new property's draft before its asynchronous save finishes |
| R02-002 | Medium | an older overlapping Archi read can replace newer model state |
| R02-003 | Medium | Archi's diagram text alternative loses all concept names |
| R02-004 | Medium | read-only counts and aggregates ignore query filters |
| R02-005 | High | history folding removes history after its required backup has disappeared |
| R02-006 | Medium | New empty copy is offered for read-only files but its preview refuses them |
| R02-007 | Medium | the package uploader exceeds the MCP per-call operation limit |
| R02-008 | Medium | the package uploader reports acceptance transport errors as permission limits |
| R02-009 | Medium | Studio outline caches carry records from a previous file |
| R02-010 | Medium | a pending Studio outline read redraws and discards a newly started draft |
| R02-011 | Medium | a failed Studio outline read suppresses retries at that revision |
| R02-012 | Medium | native reference pickers lose the target version for a `__proto__` field |
| R02-013 | Medium | timed-out hierarchy moves lose their exact retry request |
| R02-014 | Medium | cancellation during invalid proposal cleanup leaves the draft frozen |
| R02-015 | Medium | batch results claim a version for a record deleted by an automatic action |
| R02-016 | Medium | Systems Lens calls an unreachable circuit member still fed |
| R02-017 | Medium | BCM Atlas overwrites hidden stored maturity during an unrelated edit |
| R02-018 | Medium | proposals lose collection dependencies when a condition initially has no effects |
| R02-019 | Medium | MCP result versions confuse equal record IDs in different types |
| R02-020 | Medium | JSON import silently discards records' new-file retention marks |
| R02-021 | Low | the documentation search panel is clipped by the desktop sidebar |
| R02-022 | Medium | New empty copy activates a stage whose kept record values changed |
| R02-023 | Medium | BCM Atlas erases a rating outside the displayed scale during an unrelated edit |
| R02-024 | Medium | a stale window overwrites another window's saved Agent lease preference |
| R02-025 | High | a permitted record batch exceeds the open limit and makes the file unreopenable |

## Current findings

### R02-001 — Medium: Archi drops a new property's draft before its asynchronous save finishes

- **Reassessment 2026-10-03:** Open; fresh controller reproduction. Rapid key/value entry still throws `Cannot set properties of undefined (setting 'value')`; `draftProperties` is null before the queued write finishes. Undo/redo did not repair this boundary.

- **Location:** `extensions/archi/view.js:549-566`.
- **Trigger and impact:** add a property to a concept with no existing properties, finish its key, then finish its value before the create-and-reread completes. Saving the key clears `draftProperties` while the visible row remains. The value handler looks up that row in the still-empty stored list and throws; the entered value is not saved. An asynchronous refusal also discards the only copy of the draft.
- **Evidence:** `node artifacts/review-20261002/extensions/archi-probes.mjs` executes the production property handlers with a delayed write boundary. Literal outcome: `PROPERTY_SECOND_EDIT=Cannot set properties of undefined (setting 'value')`. A second probe (`node artifacts/review-20261002/extensions/archi-dom-probe.mjs`) runs the shipped package/API in Chromium with a fixture broker and delayed batch response: the same TypeError occurs and the stored property value is empty after entering Sales. Neither probe is a native Desktop journey.
- **Correction direction:** retain a pending draft until successful save/reread, serialize edits to it, and preserve it on refusal. Measure rapid key/value entry and failed creates.
- **Confidence:** high; current source and deterministic reproduction.

### R02-002 — Medium: an older overlapping Archi read can replace newer model state

- **Reassessment 2026-10-03:** Open; fresh controller reproduction. Resolving the newer read first installs version 2; resolving the older one afterward installs version 1. No read generation check was added.

- **Location:** `extensions/archi/view.js:42-55`; change notifications schedule reads at `73-76` and completed writes reread at `165`.
- **Trigger and impact:** a notification read overlaps a write's reread (or another notification read), and the older request completes last. `readAll` installs every completed response without a generation check, replacing newer records and versions with older ones. The diagram rolls back visually and subsequent edits can use stale optimistic versions.
- **Evidence:** the same production-function probe resolves version 2 before version 1: `READ_AFTER_NEW=2`, then `READ_AFTER_OLD_COMPLETES=1`. It exercises the actual read controller with controlled query responses.
- **Correction direction:** gate state installation by the newest read generation or serialize/coalesce refreshes; test reversed completion order.
- **Confidence:** high; current source and deterministic reproduction.

### R02-003 — Medium: Archi's diagram text alternative loses all concept names

- **Reassessment 2026-10-03:** Open; fresh production-model/helper reproduction. Nine nonempty Archisurance labels still produce nine nameless entries. No fresh browser/screen-reader session.

- **Location:** `extensions/archi/view.js:382-386`; helper contract in `tools/view-kit/nendo-view-kit.js:127-129` (also shipped under `extensions/archi/kit/`).
- **Trigger and impact:** open a view containing elements and use its text alternative. Archi passes plain label strings to a helper that destructures each item as `{name, detail}`. The resulting list entries have no names, so the intended screen-reader alternative does not describe the diagram's concepts.
- **Evidence:** the probe uses the production model/helper and the Archisurance fixture. Nine nonempty concept labels produce `ACCESSIBLE_DIAGRAM_TEXT=[null,null,null,null,null,null,null,null,null]` in a minimal DOM stand-in. A real Chromium fixture confirms `REAL_DOM_ALTERNATIVE=["","","","","","","","",""]` (nine empty list entries).
- **Correction direction:** pass `{name: label}` items and measure accessible text for a nonempty diagram.
- **Confidence:** high for the contract mismatch; no human screen-reader session was run.

### R02-004 — Medium: read-only counts and aggregates ignore query filters

- **Reassessment 2026-10-03:** Open; fresh Windows typed-service reproduction. Writable filtered page/count/sum: `1/1/10`; read-only: `1/2/100`. The other three snapshot folds remain source-confirmed as unfiltered; they were not individually rerun.

- **Location:** `src/Nendo.Engine/NendoWriteCoordinator.ReadQueries.cs:50`, `78`, `133`, `189`, `262`.
- **Trigger and impact:** open a file read-only and count or aggregate a filtered set. The page applies its predicates, but all five snapshot count/aggregate branches iterate every record of the type. Totals, chart groups, date buckets and matrix cells disagree with the displayed rows. `docs/contracts/queries.md` requires them to share one filtered set.
- **Evidence:** `dotnet run --project artifacts/review-20261002/engine-semantics/Probe.csproj` uses the same disposable two-record file through writable and public read-only services. Filter `include=true`: writable page `yes`, count `1`, sum `10`; read-only page `yes`, count `2`, sum `100`. Group and cell counts also include the excluded row. Actual Engine sources are linked; Windows instance ownership/file identity are replaced by portable fixture boundaries. This does not qualify Windows lifecycle behavior.
- **Correction direction:** apply the typed predicates consistently before every snapshot fold, including calculated and hierarchy predicates; compare writable and read-only answers.
- **Confidence:** high; source and typed-service reproduction.

### R02-005 — High: history folding removes history after its required backup has disappeared

- **Reassessment 2026-10-03:** Open; fresh Windows typed-service reproduction with real file identity. After deleting the task-owned backup, fold succeeds and history falls from 14 to 7 revisions. Backup remains absent. This strengthens the earlier portable evidence; no timing race is needed.

- **Location:** `src/Nendo.Engine/NendoWriteCoordinator.HistoryFold.cs:43-50`; backup replay validation exists in `NendoWriteCoordinator.Backup.cs:157-172` but is not called here.
- **Trigger and impact:** create the required backup, then delete or replace it before folding. Fold trusts only the cached activation identity and unchanged source authority. It irreversibly removes the old revisions even though the backup that should preserve them is gone. ADR-0021 makes that backup the recovery path for folded history.
- **Evidence:** `dotnet run --project artifacts/review-20261002/engine-storage/StorageProbe.csproj -- fold-missing-backup`: `BACKUP_EXISTS_BEFORE_FOLD=False`, `HISTORY_BEFORE=14`, `FOLD_RETURNED_SUCCESS=true`, `FOLDED_REVISIONS=8`, `HISTORY_AFTER=7`, `BACKUP_EXISTS_AFTER=False`, `FOLDED_REVISION_PRESENT=False`. A shorter internal retained-window policy keeps the fixture small. Fold/backup/storage logic is production source; Windows identity/ownership use portable fixture boundaries. No owner file was touched.
- **Correction direction:** revalidate and pin the activated backup's identity and content before destructive folding, holding the necessary protection through commit; reject missing, replaced or changed backups without removing history.
- **Confidence:** high for the service defect; Windows deletion/locking timing was not exercised.

### R02-006 — Medium: New empty copy is offered for read-only files but its preview refuses them

- **Reassessment 2026-10-03:** Open; fresh Windows typed-service reproduction. Backup capability is true, preview refuses with `read-only`, and `CreateNewFileAsync` succeeds for the same source. Native menu journey remains source-only.

- **Location:** `src/Nendo.Engine/NendoWriteCoordinator.NewFile.cs:17`; menu enablement in `src/Nendo.Workbench/src/file-actions.ts:207`, native call in `src/Nendo.Desktop/MainPage.FileActions.cs:266`.
- **Trigger and impact:** open a normal read-only file and choose New empty copy (or its application-specific name). The menu enables this source-preserving action using backup capability, but the preview calls the writable-only `GetStore()` and refuses before a destination can be chosen. The creation service itself supports read-only sources.
- **Evidence:** `dotnet run --project artifacts/review-20261002/engine-storage/StorageProbe.csproj -- readonly-newfile`: `READONLY_BACKUP_CAPABILITY=True`, `HEALTH=ReadOnly`, preview refuses with `read-only`, while `READONLY_NEWFILE_CREATE=success`, `RESULT_RECORDS=0`. Same portable boundaries as R02-005; the native menu-to-service path is source-traced, not run on Windows.
- **Correction direction:** compute the preview through the read-only snapshot/inspection path as well as the writable store.
- **Confidence:** high.

### R02-007 — Medium: the package uploader exceeds the MCP per-call operation limit

- **Reassessment 2026-10-03:** Open; fresh execution of the actual uploader with a controlled MCP client. A declaration plus 16 files sends one call with 17 operations, reproducing the source-confirmed limit refusal. No fresh real HTTP server refusal.

- **Location:** `tools/Put-NendoPackage.mjs:168-171`; enforced limit in `src/Nendo.LocalMcp/NendoAgentAuthoringService.cs:992-997`.
- **Trigger and impact:** upload a new package with 16 small files. Its package declaration plus file writes produce 17 operations. The helper batches by mutation count and character size, without counting total operations, so one call exceeds the 16-operation server limit and aborts before validation. Larger packages and extra `--operations` can hit the same defect.
- **Evidence:** `node artifacts/review-20261002/tooling-site/put-package-probe.mjs` runs the actual uploader against a task-owned local mock implementing the source-confirmed limit. It observes one `add_operations` call with 17 operations; uploader exits `1` with `CHANGE_SET_LIMIT: One call carries 1-16 operations in total; this one carries 17.` No real MCP application was changed.
- **Correction direction:** count operations across each call and split oversized extra mutations before sending, while retaining existing byte bounds.
- **Confidence:** high for request packing; refusal is simulated at the server boundary.

### R02-008 — Medium: the package uploader reports acceptance transport errors as permission limits

- **Reassessment 2026-10-03:** Open; fresh execution of the actual uploader with a controlled client exception. Injected `MCP tools/call HTTP 503` produces exit code 0, empty stderr and the incorrect not-at-Unattended sentence. No fresh HTTP transport execution.

- **Location:** `tools/Put-NendoPackage.mjs:189-194`.
- **Trigger and impact:** use `--accept` and receive an HTTP failure or lost connection during acceptance. A catch-all reports that the file is not at Unattended and exits successfully, hiding the real failure and whether acceptance committed. Scripts receive success for an incomplete or uncertain operation.
- **Evidence:** the uploader probe injects HTTP 503 on accept. The helper exits `0`, leaves stderr empty, and prints `Validated, but this file is not at Unattended, so it is not accepted here.` Packing/handling are production code; the transport failure is a local mock.
- **Correction direction:** special-case the actual permission refusal; propagate other failures with a nonzero exit and distinguish uncertain acceptance outcomes.
- **Confidence:** high.

### R02-009 — Medium: Studio outline caches carry records from a previous file

- **Reassessment 2026-10-03:** Open; current source and controller evidence. Outline/layout/request caches remain ordinary unregistered maps, despite the added file-view reset. A cached file-A record remains at sequence 8 and the same-sequence refresh issues no second tree read. No fresh native cross-file journey.

- **Location:** `src/Nendo.Workbench/src/view-data.ts:88-91`, `320-324`; reset in `actions.ts:139`.
- **Trigger and impact:** inspect a hierarchy in file A, then open file B with the same entity ID and change sequence. The outline maps are ordinary module-level maps, outside the registered file-scoped reset. Rendering B uses A's cached records and suppresses a fresh tree read. Independent files or copies can share these IDs/counters while holding different data.
- **Evidence:** `node artifacts/review-20261002/workbench/repro.mjs` bundles the actual state and outline functions, with host/DOM stand-ins. It applies `clearFileScoped()` on the switch and prints `PROVED: file B kept file A outline records and issued zero tree reads after clearFileScoped; both sequence 8.` The actual Chromium renderer/reset also measures `REAL_BROWSER_FILE_SWITCH={"file":"B.nendo","containsA":true,"treeReads":1}`: only A was read. No cross-file Engine write or native UI journey is claimed.
- **Correction direction:** register every outline/layout cache for file reset and bind outstanding tree replies to the file/session generation.
- **Confidence:** high.

### R02-010 — Medium: a pending Studio outline read redraws and discards a newly started draft

- **Reassessment 2026-10-03:** Open; fresh outline-controller evidence plus current renderer trace. Completion calls rerender after a draft exists; the current renderer still clears `openDraft` and `retainedDraft` before replacing the page. No fresh full-browser draft-loss journey.

- **Location:** `src/Nendo.Workbench/src/view-data.ts:138`; unconditional renderer in `shell.ts:79`, draft reset in `main.ts:110-111`.
- **Trigger and impact:** a tree refresh is pending when the person opens a record/create form and types. Completion calls `rerender()` without checking interaction or draft state. The renderer replaces the DOM where the draft lives and clears `openDraft`/`retainedDraft`, losing entered values. Other background read paths guard this boundary.
- **Evidence:** the Workbench source-linked probe starts an outline read, installs an edited title draft, then resolves the read: `PROVED: a pending Studio outline read called rerender once after an unsaved title draft existed.` A separate Chromium probe uses the actual form/renderer: `REAL_BROWSER_DRAFT={"before":{"form":true,"value":"KEEP THIS DRAFT","edited":1,"treeCalls":1},"after":{"form":false,"draft":null,"containsDraft":false}}`.
- **Correction direction:** defer background outline rendering while a draft/interaction is active, with the same retention policy as other reads; measure a delayed tree response after typing starts.
- **Confidence:** high in the source path; no native typing journey was run.

### R02-011 — Medium: a failed Studio outline read suppresses retries at that revision

- **Reassessment 2026-10-03:** Open; fresh controller reproduction. After a transient tree rejection, refreshing at the same sequence issues zero retry requests and leaves the outline absent.

- **Location:** `src/Nendo.Workbench/src/view-data.ts:134-138`.
- **Trigger and impact:** the first outline request fails transiently. The code records its change sequence before loading and never clears that marker on rejection. Later refreshes at the same sequence are skipped while the outline remains absent, leaving the initial reading state stuck until a write changes the sequence or the renderer restarts.
- **Evidence:** the source-linked probe rejects the first tree read, makes the next reply successful, and refreshes again: `PROVED: first outline read failed; a repeated refresh issued zero requests and kept the outline absent.` Actual Chromium redraw after repairing the host reports `REAL_BROWSER_OUTLINE_FAILURE={"treeReads":1,"reading":true,"outlinePresent":false}`.
- **Correction direction:** track successful/pending reads separately, clear pending markers on failure, and provide a retry that can reread the same sequence.
- **Confidence:** high.

### R02-012 — Medium: native reference pickers lose the target version for a `__proto__` field

- **Reassessment 2026-10-03:** Open; fresh production-helper reproduction. Selected target version 7 under `__proto__` still serializes as `{}` with no own version property. No fresh picker DOM journey.

- **Location:** `src/Nendo.Workbench/src/reference-controls.ts:88-92`.
- **Trigger and impact:** a valid reference field has semantic ID `__proto__`. Selecting its target should include that target's version in the native form request. Assignment into `{}` does not create an own property for that key, so serialization omits the required version and saving is refused. This is a remaining native form path, separate from the corrected custom-view projection in R30-015.
- **Evidence:** the production `referenceVersions` helper, given selected version 7, serializes as `{}`; the Workbench probe prints `PROVED: selecting target version 7 for valid __proto__ reference serialized expectedTargetVersions as {}.` The real Chromium picker/Create form likewise sends an own `__proto__` value with `expectedTargetVersions={}` despite selected version `7`.
- **Correction direction:** use a null-prototype object or define own properties for semantic-ID maps, and exercise reserved IDs through native forms.
- **Confidence:** high.

### R02-013 — Medium: timed-out hierarchy moves lose their exact retry request

- **Reassessment 2026-10-03:** Open; fresh journal-membership measurement. `isJournaledMutation('data.moveRecord')` remains false. Current native move paths still dispatch through that journal boundary. Real timeout/commit/reload timing was not rerun.

- **Location:** `src/Nendo.Workbench/src/pending-mutations.ts:18`; hierarchy gesture calls in `view-data.ts` and `outline-surface.ts`.
- **Trigger and impact:** a native `data.moveRecord` request commits or remains uncertain but its response is lost. That method is missing from the retained-mutation set, so the Workbench does not save its original idempotency key/input, offer Check or retry save, or block a second move while the first outcome is unknown. Engine receipt replay cannot help when the UI has discarded the key.
- **Evidence:** `node artifacts/review-20261002/workbench/move-retry-repro.mjs` uses the production Desktop client with a controlled host-timeout: the pending mutation and local storage remain empty, then another move with a fresh key is dispatched. Host responses are simulated; no claim is made that the first move actually committed.
- **Correction direction:** include moves in durable retention and receipt resolution, and measure lost-response/reload behavior against the operation-outcomes contract.
- **Confidence:** high.

### R02-014 — Medium: cancellation during invalid proposal cleanup leaves the draft frozen

- **Reassessment 2026-10-03:** Open; source-only confirmation this time. Caching the verdict and invalid-preview rejection still occur outside the recovery catch, with `Frozen=false` after the cancellable reject. Cited file is byte-identical to the original baseline. Cancellation timing was not rerun.

- **Location:** `src/Nendo.LocalMcp/NendoAgentAuthoringService.cs:310-324`.
- **Trigger and impact:** cancel validation after Engine returns an invalid proposal, while rejection waits for Engine admission. The replay cache is already populated; cleanup throws before `Frozen=false`, outside the earlier recovery catch. Amending the invalid draft is then refused, and an exact validate retry returns the cached invalid result without cleanup. Even rejecting the adapter draft does not reject the unbound private proposal; it remains until Engine session cleanup.
- **Evidence:** `dotnet run --project artifacts/review-20261002/desktop-mcp/ReviewProbe.csproj -p:UseSharedCompilation=false`: `VALIDATE: cancelled during invalid-preview cleanup`; `AMEND: CHANGE_SET_FROZEN: The change set is already frozen for validation.`; `RETRY VALIDATE: state=Invalid, diagnostics=1; engine proposals=1`. The follow-up `REJECT AFTER CANCEL: adapter rejected draft; engine proposals=1` confirms the orphan. Actual Engine/MCP sources are linked; Windows ownership/identity/discovery ACL use fixture substitutes. No native transport timing is claimed.
- **Correction direction:** make invalid-preview cleanup cancellation-safe and reset/reopen the draft on every unsuccessful validation path; publish replay only when recovery state is consistent.
- **Confidence:** high.

### R02-015 — Medium: batch results claim a version for a record deleted by an automatic action

- **Reassessment 2026-10-03:** Open; fresh Windows service/action reproduction. Batch returns record version 1; generated changes report deletion with a null version; final record count is 0.

- **Location:** `src/Nendo.Engine/NendoApplicationService.Batch.cs:154-161`.
- **Trigger and impact:** a permitted automatic action deletes a record created or updated by a batch. The final projection ignores generated changes with a null version, including deletion, and returns the pre-action computed version. A client receives a live-record handle for a record that no longer exists.
- **Evidence:** the portable Engine probe runs an approved `Created → DeleteRecord(EventRecord)` trigger: `BATCH_RETURNED_VERSION=1`; generated changes correctly say `Change=deleted, RecordVersion=null`; `BATCH_FINAL_RECORD_COUNT=0`. Actual Engine sources, with Windows identity/ownership fixture substitutes as in R02-004.
- **Correction direction:** project the final generated deletion state as well as writeback versions, preserving operation order; test batch create/update followed by action deletion.
- **Confidence:** high.

### R02-016 — Medium: Systems Lens calls an unreachable circuit member still fed

- **Reassessment 2026-10-03:** Open; fresh production-verdict reproduction with a controlled graph boundary. Source-less A↔B with A removed still gives B `reduced`, despite zero remaining source paths. No native view journey.

- **Location:** `extensions/systems-lens/lens.js:188-189`; displayed claims at `213`, `269-273`.
- **Trigger and impact:** a source-less circuit A↔B exists, and the person takes out A. Because B is downstream but was never source-reachable, it is classified `reduced` and announced as still fed/keeping a declared feed path, even though no such path exists. The diagnostic tool gives the opposite answer to its stated reachability question.
- **Evidence:** the production-method probe in `artifacts/review-20261002/extensions/archi-probes.mjs` prints `CIRCUIT_TAKEOUT_VERDICTS=[["A","removed"],["B","reduced"]]` and `CIRCUIT_REMAINING_SOURCE_PATHS=[]`. It executes the current reach/verdict functions with a controlled graph, not a native view journey.
- **Correction direction:** assign still-fed/reduced only to nodes reachable from a remaining declared source; keep already unreachable circuit members explicit.
- **Confidence:** high.

### R02-017 — Medium: BCM Atlas overwrites hidden stored maturity during an unrelated edit

- **Reassessment 2026-10-03:** Open; source-only confirmation this time. The hidden control still initializes from assessment-derived maturity, and save still writes it using `binding.has(part)`. Editor and binding files are byte-identical to the original baseline. Hidden overwrite/assessed-only refusal were not rerun.

- **Location:** `extensions/bcm-atlas/view.js:954`, `986-987`; assessed/stored distinction in `model.js:379` and hidden control in `index.html:17`.
- **Trigger and impact:** assessments supply maturity while the capability also retains an older stored maturity. Edit only the owner or name. The form initializes its hidden maturity selector from the latest assessment and saves it using the broad `has(maturity)` test, silently replacing the stored value. For a supported assessed-only binding without a stored maturity field, the same path attempts to write a null field ID and refuses the edit.
- **Evidence:** `node artifacts/review-20261002/extensions/bcm-dom-probe.mjs` runs the shipped package/API and real form in Chromium with the fixture broker: `REAL_BCM_MATURITY_HIDDEN=true`, stored maturity before `5`, unrelated owner edit `Changed owner`, stored maturity after `1`. The production-method probe also measures the hidden write. No native Desktop or owner file was used.
- **Correction direction:** save maturity only when the stored-maturity binding is actually writable/offered; exclude assessment-derived hidden values from update payloads.
- **Confidence:** high for the measured overwrite; the assessed-only refusal is source-traced.

### R02-018 — Medium: proposals lose collection dependencies when a condition initially has no effects

- **Reassessment 2026-10-03:** Open; fresh Windows proposal/action reproduction. A condition over an empty child collection has no effects; adding a child afterward still allows promotion with the flag false. A fresh equivalent edit sets it true. Real ownership/identity replace the earlier portable substitutes.

- **Location:** `src/Nendo.Engine/Behaviour/PreparedBehaviourPlan.cs:54`, `NendoWriteCoordinator.Proposals.cs:242`, `NendoWriteCoordinator.Promotion.cs:134`.
- **Trigger and impact:** review a record edit whose action condition counts an empty related collection and evaluates false. Creating a related record afterward does not change the reviewed owner version. With no generated operations/external record reads, the plan is considered empty and skips its data-revision check, so promotion accepts obsolete behavior. The equivalent fresh edit would run the action. The behavior contract requires collection membership to remain a promotion precondition.
- **Evidence:** the portable Engine probe: `EMPTY_CONDITION_PREVIEW=Previewable`, after adding a child `EMPTY_CONDITION_PROMOTION=Active`, generated changes `0`, final flag `False`; a fresh equivalent edit sets the flag `True`. Windows identity/ownership are fixture substitutes; proposal/action code is production source.
- **Correction direction:** retain collection membership/data-revision dependencies independently of whether evaluation generates effects or observes existing members; test negative and empty-count conditions.
- **Confidence:** high.

### R02-019 — Medium: MCP result versions confuse equal record IDs in different types

- **Reassessment 2026-10-03:** Open; fresh Windows typed-service/action result projected by the actual MCP helper. `notes/shared` is version 1, `projects/shared` is changed to version 3, and the helper reports version 3 for the note. No live MCP transport call.

- **Location:** `src/Nendo.LocalMcp/NendoDataMutationService.cs:317-330`; callers such as create at `41-50` do not pass entity identity.
- **Trigger and impact:** create `tasks/shared` while an automatic action updates `projects/shared`. Result projection groups generated versions by record ID alone and uses the other type's version for the created task. The next optimistic write using that returned handle is refused despite no intervening task edit. Record identity is entity plus record ID; this remaining response path is distinct from the fixed R30-016 batch normalization.
- **Evidence:** the source-linked Desktop/MCP probe prints `MCP tasks/shared reports=3; actual tasks/shared=1; actual projects/shared=3`; `alsoChanged` correctly identifies the project. Actual Engine/MCP code with Windows fixture boundaries as in R02-014.
- **Correction direction:** preserve entity identity through the result adapter and group/match on the full record identity.
- **Confidence:** high.

### R02-020 — Medium: JSON import silently discards records' new-file retention marks

- **Reassessment 2026-10-03:** Open; fresh Windows import-service reproduction. `keptInNewFiles=true` imports successfully but the stored mark is null, following the type default. The false/opposite-default case remains source-traced rather than rerun.

- **Location:** `src/Nendo.LocalMcp/NendoImportService.cs:221-224`; advertised input in `NendoAuthoringContracts.cs:27-29`.
- **Trigger and impact:** JSON-import a record with `keptInNewFiles=true` (or false). The accepted input uses the same record shape as create_records, but import reconstructs `NendoCreateRecordEntry` without forwarding that mark. The record follows the type default instead, so New empty copy silently drops seeded records or keeps work that the caller explicitly marked left out.
- **Evidence:** the Desktop/MCP probe prints `IMPORT KEEP: requested=True; committed=1; stored=null; typeDefault=False`. The import succeeds; the retention metadata is lost.
- **Correction direction:** carry `record.KeptInNewFiles` into the typed create entry and measure both explicit values against opposite type defaults.
- **Confidence:** high.

### R02-021 — Low: the documentation search panel is clipped by the desktop sidebar

- **Reassessment 2026-10-03:** Open; source-only confirmation this time. The 430px absolute result panel remains inside the narrower sticky rail with vertical overflow. Both cited files are byte-identical to the original baseline. October 2 breakpoint/hit-test measurements were not repeated.

- **Location:** `site/src/layouts/Doc.astro:87`, `site/src/components/DocsSearch.astro:39`.
- **Trigger and impact:** search the public documentation at desktop widths. The 430px results panel sits inside the much narrower sidebar's overflow container; setting vertical overflow to auto also establishes horizontal clipping/scrolling. Much of each result excerpt is hidden outside the rail.
- **Evidence:** `node artifacts/review-20261002/tooling-site/site-search-probe.mjs` exercises the actual built site/Pagefind in Chromium. At viewport 1280, rail client width is 231px versus panel/scroll width 430px; at 1024 it is 209px versus 430px. A point inside the result's right edge hits the underlying paragraph. At 768 the single-column layout does not clip. Search still returns correct links, so this is a lower-priority usability defect.
- **Correction direction:** render the panel outside the scrolling rail or constrain it to available width; measure result hit areas at desktop and mobile breakpoints.
- **Confidence:** high.

### R02-022 — Medium: New empty copy activates a stage whose kept record values changed

- **Reassessment 2026-10-03:** Open; source-only confirmation this time, retaining the fault-injection scope. Final stage inspection still checks classification and identity evidence without the expected transformed content digest; the stage allows shared writes. No fresh stage alteration or external Windows race was executed.

- **Location:** `src/Nendo.Engine/NendoWriteCoordinator.NewFile.cs:77-84`.
- **Trigger and impact:** a staged new file's data changes after transformation and before final validation. Validation checks only open classification and identity-transition evidence, without comparing expected transformed content. It activates altered kept values at their old record versions, violating the new-file promise to preserve kept records' values/versions. This is a fault-injection finding about stage validation, not an observed owner-data or disk failure.
- **Evidence:** `dotnet run --project artifacts/review-20261002/engine-storage/StorageProbe.csproj -- newfile-stage-drift` injects one changed label through the existing `BeforeNewFileValidation` seam on a disposable stage. Output: `STAGE_ROWS_CHANGED=1`, `NEWFILE_RETURNED_SUCCESS=true`, source label `Note 0`, result label `CORRUPTED`, result version `1`, kept `1`, result classification `NormalReadOnly`, integrity `ok`. Windows identity/ownership are portable substitutes; the stage transformation/inspection is production source. The stage pin permits writes (`FileShare.ReadWrite`); no external Windows race was run.
- **Correction direction:** bind final inspection to expected post-transformation/post-vacuum content, with physical stage protection through activation, as other copy flows bind their expected result.
- **Confidence:** high for the injected service behavior; frequency under real storage/process interference is not measured.

### R02-023 — Medium: BCM Atlas erases a rating outside the displayed scale during an unrelated edit

- **Reassessment 2026-10-03:** Open; source-only confirmation this time. Selects still offer only in-scale options; save still sends the unedited rating, converting the blank selection to null. The cited editor file is byte-identical to the original baseline. October 2 browser overwrite measurement was not repeated.

- **Location:** `extensions/bcm-atlas/view.js:933-941`, `986-987`.
- **Trigger and impact:** an existing maturity/target rating lies outside the view's displayed scale, which the scalar contract permits. Opening the editor creates only in-scale select options, so the current value becomes blank. Saving only an owner/name change writes that blank as null, erasing the untouched rating.
- **Evidence:** the BCM Chromium probe with the shipped package/API measures `REAL_BCM_TARGET_BEFORE=9`, `REAL_BCM_EDITOR_TARGET=""`, unrelated owner edit `Changed owner`, and `REAL_BCM_TARGET_AFTER=null`. No numeric edit was made.
- **Correction direction:** retain an exact current out-of-scale option/value and send only fields actually edited; measure unrelated saves with values above/below the display scale.
- **Confidence:** high.

### R02-024 — Medium: a stale window overwrites another window's saved Agent lease preference

- **Reassessment 2026-10-03:** Open; fresh actual-settings-store reproduction in a task-owned Windows directory. A enables expiry; stale B changes fixed-port settings; reopened settings have `LeaseExpiry=false`, `FixedPort=false`. Native multi-window UI and active lease revocation are not claimed.

- **Location:** `src/Nendo.Desktop/DesktopAgentSettingsStore.cs:34-53`, `67-88`.
- **Trigger and impact:** two windows load the shared device settings; A enables lease expiry, then B changes fixed-port settings using its older cached tuple. Saving B replaces the entire document and writes expiry Off again. A's choice silently disappears for future launches. This concerns persisted connection preferences, not a measured revocation of a running lease.
- **Evidence:** the source-linked Desktop/MCP probe uses two actual settings stores over a task-owned directory: `SETTINGS: first enabled expiry; stale second toggled fixed port; reopened expiry=False, fixedPort=False`. The native multi-window UI is source-traced only.
- **Correction direction:** serialize/re-read shared preference updates and merge the fields the person actually changed, or reject an outdated settings revision; propagate refreshed preferences to windows.
- **Confidence:** high for the persistence behavior.

### R02-025 — High: a permitted record batch exceeds the open limit and makes the file unreopenable

- **Reassessment 2026-10-03:** Open; fresh Windows public typed-service reproduction. Supported 200-record/64-field updates leave 102,667 operation rows; subsequent public inspection reports `Rejected` with `inspection-limit`. Real Windows identity/ownership replace the earlier portable substitutes. No raw SQL altered or counted this fixture; the row count comes from the typed history-fold preview.

- **Location:** `src/Nendo.Engine/Storage/SqliteNendoStore.Inspection.cs:115-118`; batch expansion in `NendoApplicationService.Batch.cs:119-122`.
- **Trigger and impact:** a valid file is below the 99,000-operation write ceiling, then a permitted batch updates 200 records with 64 fields each. That expands to 12,800 operation rows, while admission checks only the pre-write count and reserves 1,000 rows below the 100,000-row open limit. The write succeeds and leaves a file inspection subsequently rejects. Reopening loses normal data/recovery/export access; folding cannot repair it through the normal open path.
- **Evidence:** `dotnet run --no-restore --project artifacts/review-20261002/engine-storage/StorageProbe.csproj -- batch-row-ceiling` builds and updates the fixture entirely through public typed services. Before: rows `98199`, normal classification, no findings. Batch succeeds at change sequence `24`. After: rows `110999`, classification `Rejected`, finding `inspection-limit`; `REOPEN=refused`. Only a scalar row-count query measures storage; no SQL altered the fixture. Windows identity/ownership are portable substitutes.
- **Correction direction:** reserve the actual transaction's worst-case operation growth, including generated effects, before commit or enforce the final bounds inside the transaction and roll back overflow. Measure the largest supported batch near each inspection limit; the current 128-operation guard is too small.
- **Confidence:** high; deterministic service/storage reproduction.

## Original checks and review limits — 2026-10-02

Commands below ran from `/workspace/nendo` unless a Workbench working directory is stated. The existing provisioned SDK/PowerShell were selected with `source /workspace/.nendo-setup/activate.sh`; SDK was `10.0.204`. Dependencies were not changed. Probe exit 0 means the reproduction ran to completion, including observing incorrect behavior; it is not a product test pass.

| Command/lane | Outcome and actual scope |
| --- | --- |
| In `src/Nendo.Workbench`: `npm run check`; `npm test`; `npm run verify:dependencies`; `npm run build` | All exit 0. **450 tests passed, 0 failed**. TypeScript and dependency checks passed; Workbench and view API bundles built. Existing Vite import-extension/chunk notices remain. |
| `node --experimental-vm-modules --test tools/archi/*.test.mjs tools/bcm-atlas/*.test.mjs tools/view-kit/*.test.mjs` | Exit 0, **103 passed, 0 failed**. Initial invocation omitted the required VM flag and failed two module-loading tests; corrected invocation above passed. |
| `node --check` for the six extension entry scripts | All exit 0. Syntax checks only. |
| `pwsh -NoProfile -File ./tools/Test-Site.ps1 -SkipInstall` | Exit 0; Astro check 0 errors/warnings/hints, **7 script tests passed**, 15 pages built, Pagefind indexed 8 docs, **403 internal references resolved**. No publication. |
| `pwsh -NoProfile -File ./tools/Test-Repository.ps1` | Exit 1 at `Test-BinaryAssets.ps1:524`: Linux reports the held disposable file as corrupt/unreadable rather than open in Nendo. This repeats the previously recorded Windows file-sharing limitation. The full repository gate did not pass. |
| `pwsh -NoProfile -File ./artifacts/review-20261002/tooling-site/repository-remainder.ps1` | Exit 0 for the unchanged assertions excluding only that separately failed binary-assets invocation: vendored files, JSON, tracked-file/LF hygiene, ADR structure through ADR-0022, 12 contracts/9 outside-review phases and shell identity. This is not a full repository-gate pass. |
| `dotnet restore tests/Nendo.Engine.Tests/Nendo.Engine.Tests.csproj --nologo` | Exit 0. Initial pre-restore `dotnet test --no-restore` found empty package assets and executed zero tests; that output was not counted as success. |
| `dotnet test tests/Nendo.Engine.Tests/Nendo.Engine.Tests.csproj --no-restore --nologo` after restore | Exit 1: **Failed 609, Passed 435, Skipped 1, Total 1045**. 603 failures name Windows instance ownership; 3 require Windows ACLs; 1 requires Windows file identity. The remaining two assert Windows path parsing and exclusive file-sharing behavior on Linux. This native suite did not pass and provides no Windows runtime qualification. |
| `dotnet run --project artifacts/review-20261002/engine-semantics/Probe.csproj --no-restore` | Exit 0; read-only filtered page/count/sum/group/bucket/cell and calculated-filter mismatch, generated deletion result, and empty-condition proposal staleness reproductions. Current Engine source with explicitly substituted Windows ownership/identity boundaries. |
| `dotnet run --no-restore --project artifacts/review-20261002/engine-storage/StorageProbe.csproj -- fold-missing-backup`; `... -- batch-row-ceiling`; `dotnet run --no-build --no-restore --project artifacts/review-20261002/engine-storage/StorageProbe.csproj -- readonly-newfile`; `... -- newfile-stage-drift` | Each exit 0. Current storage/coordinator logic with portable identity/ownership substitutes; the stage drift uses the existing injection hook and the fold uses a shortened internal retained window. The batch ceiling fixture uses real public typed writes. An earlier project-reference build hit a shared output lock and did not execute a probe; isolated component outputs resolved it. |
| `dotnet run --project artifacts/review-20261002/desktop-mcp/ReviewProbe.csproj --no-restore -p:UseSharedCompilation=false` | Exit 0; canceled invalid-validation cleanup, colliding entity/record result versions (including the refused follow-up), JSON-import marks, and shared-settings overwrite measured in production-linked source. Windows identity/ownership/discovery ACL are explicit fixture substitutes. |
| Workbench `repro.mjs`, `move-retry-repro.mjs`, `browser-probe.mjs`; extension `archi-probes.mjs`, `archi-dom-probe.mjs`, `bcm-dom-probe.mjs`; tooling `put-package-probe.mjs`, `site-search-probe.mjs`, all under their task artifact subdirectories and invoked with `node` | All exit 0. Source-linked controllers and actual Chromium DOM/renderer checks are distinguished in the findings. API/host responses are controlled fixtures; uploader uses a loopback mock; the site uses its actual built Pagefind index. No live planner or owner-file writes. |

### Coverage and boundaries

| Area | Reviewed | Limits |
| --- | --- | --- |
| Engine storage/lifecycle | Open/read-only/authority, backup, Duplicate/Fork, restore/replacement receipts, recovery export, HistoryFold, New-file transformations, inspection/write bounds and lifecycle tests | Portable service/SQLite probes do not qualify Windows physical identity, cross-process exclusion, file locks/rename activation, arbitrary corruption, disk-full, physical power loss or interruption timing. |
| Engine semantics | Query families and calculated selection/paging, typed/batch mutations, hierarchy, sequences, action expansion/planning/budgets, proposal preparation/replay/staleness | Reproduction fixtures cover the identified triggers; the native suite is limited as above. |
| Desktop/MCP | Session admission, lifecycle and settings paths, authority/leases, cancellation, closed request/resource/output contracts, authoring and JSON import, host/view serving boundaries | Source-linked adapters/stores; no installed host, live planner, native dialogs, notifications, multi-window paint or full transport fuzzing. |
| Workbench | Bridge/journal, forms/references/drafts/read chase, Studio grid/outline, Use navigation/paging, related records, custom-view API/broker/frames | Chromium fixtures run real renderer/forms but controlled host data. No Windows WebView2 journey or durable Engine write in those browser checks. |
| Shipped extensions | Archi model/mirror/editor/import/export, BCM model/layout/export, Systems Lens, Gantt, dependency graph, Work Dependencies and view kit | Existing Node lane and selected Chromium checks. Full Windows/msedge fixture gates and external Desktop Archi round trips were not run; no exhaustive human interaction/accessibility pass. |
| Tooling/site | Payload/installer/pruning scripts, build/deploy configuration, dependencies, package upload tooling, guides/search/build/links | Windows wrapper/setup reviewed as source; no payload/installer execution, install/uninstall, publish or remote write. |

### Original handoff — 2026-10-02

Original reported audit: `git diff --check` exited 0; `REVIEW.md` is UTF-8 without BOM with 0 CR bytes, and all 25 index IDs match their finding sections. Only `REVIEW.md` changed in the tracked working tree. The September 30 archive was not present in this file at the October 3 reassessment; that earlier preservation claim was incorrect. No product fix, owner-data mutation/failure experiment, planner write, installation change, commit, push or publication occurred. Probe sources/logs are disposable task scratch under `artifacts/review-20261002/`; the descriptions and literal outcomes in this file are the review record. Native Windows production/installer qualification remains outside the evidence collected here. Reconcile these findings into the live planner when its registered MCP becomes available, without treating review evidence as owner acceptance or marking fixes done.

---
