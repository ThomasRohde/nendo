# Nendo code review

Review performed 2026-09-26. **Broad review complete: 19 confirmed findings —
4 High, 14 Medium, 1 Low. No Critical finding established.**

This is a code review with targeted reproductions, not a claim that every line,
runtime interleaving or platform behavior was exhaustively proved. Findings were
added throughout the review so intermediate versions remained useful.

## Finding index

| ID | Severity | Finding | Main dependency / repair coordination |
| --- | --- | --- | --- |
| R-004 | High | Built-ins replace validated user-function aliases | Analyzer and evaluator name resolution |
| R-010 | High | Canceled file dialogs discard unsaved input | File outcomes and draft preservation |
| R-014 | High | Queued view write commits after disable | Serialized controller authority |
| R-018 | High | Old package compensation overwrites newer metadata | Package inverse preconditions |
| R-001 | Medium | Setup retry skips failed registration | Shared setup helper and repair path |
| R-002 | Medium | View writes cannot assign references | View API, broker and target versions |
| R-003 | Medium | DateTime `today` filters fail | Typed filter resolution |
| R-005 | Medium | Rounding data breaks whole record reads | Runtime error classification |
| R-006 | Medium | CSV replay changes after target edit | Normalization and durable receipts |
| R-007 | Medium | Derived import keys exceed accepted limit | Internal batch-key derivation |
| R-008 | Medium | Range/ranking caches never refresh | Sequence-aware cache invalidation |
| R-009 | Medium | Progress ring combines different revisions | Coherent multi-read snapshots |
| R-011 | Medium | Nullable function arguments reject null | Typed argument conversion |
| R-012 | Medium | Retirement leaves broken active actions | Final-candidate binding validation |
| R-013 | Medium | Overview cannot open records beyond first page | Focused-record navigation |
| R-015 | Medium | Immediate causal reference undo conflicts with itself | Inverse target-version progression |
| R-016 | Medium | Exact sums refuse representable mixed scales | Decimal coefficient normalization |
| R-017 | Medium | Null grant settings block healthy-file open | Defensive device-state parsing |
| R-019 | Low | Cleared docs search reopens old results | Async request invalidation |

There are **no hard prerequisite edges between these findings**. Shared-file
coordination matters: R-004/R-011, R-006/R-007 and R-008/R-009 should be designed
together but each has an independent defect and regression. Prioritize the
four High findings, then record-read/edit/undo failures before cosmetic results.
No CVE or package-vulnerability finding is asserted.

## Resolution, 2026-09-26

All 19 findings are fixed on `main` in one change, on top of `c286522`. Each
finding has a regression guard in a lane that already runs. Each guard was
falsified: the defect was put back, the guard was watched failing, and then the
fix was restored. The quoted failure is what the guard printed with the defect
back.

| ID | Fix | Guard, and its failure with the defect back |
| --- | --- | --- |
| R-001 | `Register-NendoWithWindows` runs on the identical-payload path too, and is idempotent | `Test-NendoSetup.ps1` registration-retry case: "The rerun did not recreate the file association" |
| R-002 | The view API takes `targetVersions`, and the broker forwards it as `expectedTargetVersions` | `extension-broker`/`extension-api` tests; `DesktopExtensionReferenceWriteTests` (current, stale, absent, empty and null targets): "Select the target again so its current version can be checked." |
| R-003 | `today` is a date for Date, and the zoned start of the person's day for DateTime; Engine command steps use the same local day | `record-window.test.mjs`, `extension-api.test.mjs`, `CommandStepTodayTests`: "A DateTime step's today was not the instant the person's day begins." |
| R-004 | The catalogue is registered first and user aliases over it, as the analyzer resolves them | `BehaviourFunctionCallTests`: "Expected:<99>. Actual:<3>." |
| R-005 | Digits out of range are a `calculation-overflow` field error | `OutOfRangeRoundingDigitsAreAFieldErrorNotAFailedRecordRead`: "NendoValidationException: Rounding takes between 0 and 28 digits." |
| R-006 | Rows in committed batches carry the target versions their revision recorded | `AnExactCsvRetryReplaysAfterAReferencedTargetIsEdited`, `APartialCsvImportResumes…`: `NENDO_IDEMPOTENCY_CONFLICT` |
| R-007 | A batch key that would exceed 200 characters becomes `import.sha256.<hash>#N`; shorter keys keep `key#N` | `AnImportKeyOfAnyAdmittedLength…` (198/199/200): "The idempotency key must contain 1-200 characters." |
| R-008 | Range and ranking loaders use the sequence-aware pending rule | `summary-refresh.test.mjs`: "The file moved and the range and ranking were not read again." |
| R-009 | `sameRevision` accepts a pair only from one sequence, with bounded re-reads | `summary-refresh.test.mjs`: "A count from revision 2 was divided by a total from revision 3." |
| R-010 | Same-file outcomes keep the form; file-replacing actions honour the dirty-form guard | `file-action-draft.test.mjs`: "Cancelling file.backup redrew the page, and the redraw discards the unsaved form." |
| R-011 | A nullable parameter receives a typed empty value | `ANullableParameterTakesAnEmptyArgument…`: "A value this formula needs is empty." |
| R-012 | The final candidate is refused with `retired-binding` while behaviour reads or writes a retired field or type | `RetiringAnActionTargetIsRefused…`: "Expected exception type:<NendoPreconditionException> but no exception was thrown." |
| R-013 | An overview row reads its record by ID before selecting it | `overview-open-record.test.mjs`: "The record type opened and the clicked record did not." |
| R-014 | View authority is checked again inside the Desktop gate. The Engine refuses an `extension:` write whose package is gone, inside the write transaction | `DesktopExtensionWriterTests`, `DesktopExtensionWriterAgentRaceTests`, `ExtensionActorWriteTests`: "A view's write queued behind the device kill switch committed after views were turned off." |
| R-015 | The inverse reference expects the version planned by the parents' own inverses | `ImmediatelyReversingAReferenceMove…`: "The selected target changed. Select it again before saving." |
| R-016 | Redundant trailing zeros are shed when the coefficient overflows, before refusing | `AMixedScaleSumShedsARedundantZero…`: "The exact sum is outside the range this host can represent." |
| R-017 | A null grant or digest is structurally invalid and fails closed with a notice | `StructurallyInvalidStateInTheWrittenCasing…`, `AFileStillOpensWhen…`: `NullReferenceException` |
| R-018 | Package inverses carry the expected metadata, and are refused with `extension-package-changed` | `ReversingOldPackageMetadataRefusesANewerChange`: "Expected exception type:<NendoPreconditionException> but no exception was thrown." |
| R-019 | A request generation is moved on by every input and dismissal | `site/scripts/docs-search.test.mjs`, run by `Test-Site.ps1`: "A search answered after the field was cleared reopened the results." |

Limitations that remain:

- A person accepting a view's proposal is not checked against the package's
  presence, because the acceptance is the person's act.
- `Test-NendoSetupIsolated.ps1` and the NSIS wrapper were not run against the
  R-001 retry path.
- The Pages workflow does not run the site's new script tests.

## Scope and review boundary

Broad review of the Engine, Desktop host, local MCP adapter, Workbench, custom
views, build and installer tooling, dependency declarations, tests and public
site. This report records defects, their severity, dependencies and evidence;
it does not authorize implementation or change accepted architecture decisions.

Initial main revision: `442090841137730f6dce27dffce779a86b903283`.
The initial working tree was clean. Another agent is working on main. Reviewers
only read implementation files, do not change branches or the index, and do not
restart the application or write to owner files. Every confirmed finding will
name its source revision and relevant file fingerprint where useful. Findings
are rechecked against the current tree before final handoff. Concurrent changes
are not attributed to this review.

At final handoff, HEAD still names that revision, but the other agent has nine
uncommitted paths in flight: `docs/contracts/custom-views.md`,
`extensions/work-dependencies/{README.md,nendo-package.json,view.css,view.js}`,
`src/Nendo.Workbench/scripts/extension-broker.test.mjs`,
`src/Nendo.Workbench/src/extension-api/protocol.ts`,
`src/Nendo.Workbench/src/extension-model.ts`, and
`tools/Gate-WorkDependencies.mjs`. Their diff was read to assess overlap and was
left untouched. The visible changes expose command-step descriptions and use
them in the dependency view; they do not correct a reported finding. All **24
primary supporting source fingerprints** checked at handoff still match the
reviewed code. These late changes have not received a separate full review or
test run from this review task; the baseline results below precede them.

`REVIEW.md` is the durable review deliverable. Task-owned disposable probes and
logs, if needed, go under `artifacts/code-review-20260926/`. Existing build
outputs, installer payloads, live application sessions and owner workspaces are
not review fixtures.

## Severity and evidence

| Level | Meaning |
| --- | --- |
| P0 / Critical | Immediate, broad risk of irreversible data loss or authority escape; stop affected use. |
| P1 / High | Reachable major correctness, data integrity, security or recovery defect; prioritize a fix. |
| P2 / Medium | Concrete failure under a bounded scenario, with a workaround or limited scope. |
| P3 / Low | Minor functional or maintainability issue with a demonstrated consequence. |

Each finding includes its trigger, impact, exact location, evidence method,
confidence, dependencies, suggested correction and regression coverage.
Static code tracing is distinguished from an executed reproduction. Accepted
limitations, unchecked lanes and possible defects awaiting proof are separate
from confirmed findings. A passing suite does not demonstrate absence of bugs.

## Coverage checkpoint

| Area | State | Focus |
| --- | --- | --- |
| Engine and storage | Reviewed; seven findings | Transaction/replay authority, proposals/promotion, typed reads/cursors/aggregates, schema/reference/retirement, causal compensation, behavior, package inverses, backup/copy/restore paths |
| MCP and Desktop | Reviewed; four findings | Transport/admission, leases, authoring ownership/replay, imports, resource projection, request binding, lifecycle/replacement, cancellation, grants, view origins/serving/policy |
| Workbench | Reviewed; six findings | Paging, state/refresh, drafts/forms, scalar/reference handling, navigation, overview/charts, view API/broker and related tests |
| Tooling and dependencies | Reviewed; one setup finding | Repository/production gates, publish/prune/setup/installer logic, package manifests/lockfiles and dependency boundary; external advisory scan blocked |
| Extensions and public site | Reviewed; one site finding | All four first-party extension scripts (excluding minified vendor internals); site shell/theme/search/routes, asset sync, link check and Pages workflow |
| Executed checks | Completed within stated bounds | Repository gate, Workbench type check/335 tests, copied Engine baseline/878 passes, isolated current-source Engine/MCP/Desktop/renderer probes |

## Confirmed findings

### R-001 — P2 / Medium — Retrying setup after registration failure skips the failed step

- **Component / location:** `tools/Invoke-NendoSetup.ps1:608-614` (identical
  payload early return), `:645-656` (journal removed before Windows registration).
- **Trigger:** the payload installs successfully, then file-association or Start
  Menu registration throws. The person resolves the temporary error and reruns
  the same installer. Removing a shortcut/association and rerunning the same
  payload reaches the same path.
- **Impact:** the retry reports success without repairing Windows integration.
  Nendo can remain absent from Start or without its document registration even
  though setup appears complete. This is a repair/recovery defect, not a claim
  of payload corruption.
- **Evidence:** executed a disposable copy of the actual setup script with only
  native registration replaced by deterministic spies and an injected first-call
  exception; no registry, Start Menu or owner installation was modified. The
  original install, inventory, journal and early-return control flow executed.
  `pwsh -NoProfile -File artifacts/code-review-20260926/probe-setup-retry.ps1`
  exited 0 and printed:

  ```text
  FIRST: INJECTED registration failure
  This Nendo payload is already installed; retained the previous version.
  RESULT registrationCalls=1 shortcutCalls=0 payloadPresent=True journalPresent=False
  REPRODUCED: retry returned success without retrying Windows registration.
  ```

- **Confidence:** high; isolated control-flow reproduction. The NSIS wrapper and
  actual registry-failure scenario were not executed.
- **Dependencies:** independent of other findings; affects the common setup
  helper used by NSIS. No architecture change needed to make registration
  repairable and idempotent.
- **Correction / regression:** perform idempotent registration on the identical
  payload path, or include it in recoverable setup state. Add a registration
  failure-and-retry case to the isolated setup lane and require the second run
  to recreate the missing association and shortcut while retaining the backup.
- **Source:** initial revision `442090841137730f6dce27dffce779a86b903283`;
  the live source was unchanged when reproduced.
  Setup helper SHA-256:
  `4E6912A21410084E1826CA5800A24C00ECB6697B5E8996987CD234164F586E51`.

### R-002 — P2 / Medium — Custom-view writes cannot assign reference fields

- **Component / location:** `src/Nendo.Workbench/src/extension-broker.ts:233-235`;
  `src/Nendo.Workbench/src/extension-api/nendo-api.ts:301-304`;
  `src/Nendo.Engine/Storage/SqliteNendoStore.References.cs:141-142`.
- **Trigger:** a custom view calls `records.create` or `records.update` with a
  non-null reference value, including creation of a type with a required
  reference. Reading the target record/version first cannot avoid the failure.
- **Impact:** otherwise legitimate custom-view data writes are impossible for
  this common schema shape. The host refuses safely; no corrupt record is
  claimed. Studio/native reference controls remain a workaround.
- **Evidence:** static trace confirmed independently in the broker and Engine.
  The broker constructs a new payload containing values and, for update, the
  source version; it omits `expectedTargetVersions`, even if the caller supplied
  it. The public view API also has no parameter for these versions. The shared
  Engine requires a positive target version for every non-null reference and
  throws `target-version-required`: `Select the target again so its current
  version can be checked.` The isolated source probe
  `node artifacts/code-review-20260926/workbench/probe.mjs` also reproduced both
  mappings dropping a supplied `expectedTargetVersions: { owner: 7 }`.
- **Confidence:** high from the complete request-to-validation path; native UI
  execution has not been attempted.
- **Dependencies:** the view API, broker validation and host reference contract
  must agree. Preserve target-version checks; do not weaken Engine validation.
  Independent of R-001 and other review findings.
- **Correction / regression:** expose and forward the field-to-target-version
  map. Exercise create and update against the real typed service with current,
  stale, absent and null reference targets.
- **Source:** `442090841137730f6dce27dffce779a86b903283`; broker SHA-256
  `910643F5A302A35EB087BB6AC6EA880669EAE1D7F199A6B68879597DD291FEF4`;
  API `D82D628AC12D1E0242313CC80AC31635F62EC9F6C1B864741507CF1FE8C433FE`;
  Engine reference validator
  `B366BFC20C10EE522FBC64A4EB33C9D5CCB50BDBC9575D636977B312015883CF`.

### R-003 — P2 / Medium — Accepted `today` filters fail for DateTime fields

- **Component / location:** `src/Nendo.Workbench/src/record-window.ts:64-71`
  (`resolveClauseValue`); `src/Nendo.Engine/NendoSemanticCompiler.ComposableSurfaces.cs:1490-1530`
  (`ValidateFilterClause`); `src/Nendo.Engine/Operations.cs:675-678`.
- **Trigger:** an authored filter compares a DateTime field with
  `valueKind: today`. The semantic compiler accepts the filter.
- **Impact:** the surface, summary or custom-view query fails instead of
  displaying its data. All consumers of `clauseFilters`, including custom-view
  authored filters, share the resolver. Date-only fields do not have this issue.
- **Evidence:** the actual resolver emits `2026-09-26`, without time or zone,
  while the query validator requires an ISO timestamp with an explicit zone for
  DateTime. The resolver's own comment promises the instant at the start of the
  person's civil date. The isolated source probe prints:

  ```text
  DateTime today filter: {"fieldId":"createdAt","operator":"le","value":"2026-09-26"}; FAILS host's explicit-timezone timestamp syntax
  ```

  Reproduction: `node artifacts/code-review-20260926/workbench/probe.mjs`.
  The Engine rejection path was code-traced; no native screen was opened.
- **Confidence:** high.
- **Dependencies:** field type must reach value resolution; define/preserve the
  intended local-day boundary consistently with command-step resolution. This
  does not depend on R-002, though the custom-view API also uses this resolver.
- **Correction / regression:** resolve Date and DateTime separately and add a
  compile-to-query test for DateTime `today`, including a non-UTC offset and
  a day boundary. Do not merely loosen timestamp validation.
- **Source:** `442090841137730f6dce27dffce779a86b903283`; resolver SHA-256
  `D8619B55B614AEC1679E57FB4C88BFA337DE2A4EDB9CA51FD005700416311AAF`;
  compiler `BBBAA4EE24CDE9A93D8E37B28B20960CA943EEB4940AA84814CE18FBF88CEC15`.

### R-004 — P1 / High — Built-in functions silently replace validated user aliases

- **Component / location:** `src/Nendo.Engine/Behaviour/ExpressionAdapter.cs:196-205`;
  `src/Nendo.Engine/Behaviour/BehaviourAnalyzer.cs:138`;
  `src/Nendo.Engine/Behaviour/BehaviourValidation.cs:61`.
- **Trigger:** bind a reusable function to a name that is also a built-in, such
  as `TextLength`, and use that alias in an expression. Validation accepts the
  alias and analyzes the user function. At evaluation, application aliases are
  registered first and then overwritten by the built-in catalogue.
- **Impact:** an accepted expression silently produces a result from a different
  function than the one validated. The adapter is shared by calculations and
  actions, so wrong results may drive stored values or trigger decisions.
- **Evidence:** isolated executable compiled from current Engine sources;
  a custom function returning `99`, aliased to `TextLength`, was called with
  `'abc'`. `pwsh -NoProfile -File
  artifacts/code-review-20260926/engine/compile-and-run.ps1` exited 0 and printed
  `Alias shadow: expected custom 99, observed 3`.
- **Confidence:** high; executed through the real expression implementation.
- **Dependencies:** none. The analyzer and evaluator must implement the same
  name-resolution rule. If reserved names are to be refused, make the refusal
  explicit during definition validation and document compatibility implications.
- **Correction / regression:** align alias precedence, then test same-name
  aliases with both matching and different signatures and confirm action
  execution uses the function that validation selected.
- **Source:** `442090841137730f6dce27dffce779a86b903283`; adapter SHA-256
  `512386B952E191CCA36723112D4140B7E1C924AE55EC0B4A9DE31CE67F9ABF24`;
  analyzer `739152EAB9C282AB0036AB25D7077DBE1F6F9E0FE75DC29D0CDCE05AF7FB1C09`.

### R-005 — P2 / Medium — Invalid rounding data escapes calculated-field error isolation

- **Component / location:** `src/Nendo.Engine/Behaviour/BehaviourCatalogue.cs:202-203`;
  `src/Nendo.Engine/Behaviour/CalculationService.cs:139`.
- **Trigger:** a valid formula such as `RoundEven(1.5, digits)` receives an
  otherwise valid stored Integer value of `29` or `-1` for `digits`.
- **Impact:** rounding throws `NendoValidationException`; the per-field
  calculation boundary catches only `NendoCalculationException`. The entire
  record read fails instead of returning the stored fields plus a calculation
  error. This violates the isolated-error contract in
  `docs/contracts/calculations-and-actions.md:249-251`. Shared evaluation also
  makes this relevant to action/trigger error reporting. No claim is made that
  the file itself becomes unreadable on disk.
- **Evidence:** the same isolated current-source executable as R-004 printed
  `Out-of-range digits: record read threw NendoValidationException: Rounding
  takes between 0 and 28 digits.` Exit 0 means the probe reproduced the defect,
  not that the product behavior passed an acceptance check.
- **Confidence:** high; executed record-read failure. Native Studio behavior
  was not exercised.
- **Dependencies:** independent of R-004; both touch expression behavior but
  correcting alias resolution does not correct exception classification.
- **Correction / regression:** emit a typed runtime calculation error for a
  value-range failure; keep malformed definitions distinct. Add record-read
  tests for `-1`, `29` and valid boundaries, preserving unrelated field results.
- **Source:** `442090841137730f6dce27dffce779a86b903283`; catalogue SHA-256
  `A78EBA129456FFA2399F3C66D69AABB2AD2BCE7CD59976F3CCE1823A4F7923C2`;
  calculation service
  `023EA1C2C42602DF7EB8AE1B337FFAB1A42BD3DA831B23296D6DBA6383CC3C21`.

### R-006 — P2 / Medium — Exact CSV import retries break after a referenced target changes

- **Component / location:** `src/Nendo.LocalMcp/NendoImportService.cs:115-123`;
  `src/Nendo.Engine/NendoApplicationService.Csv.cs:108-116`.
- **Trigger:** import CSV containing a reference to target record T at version
  1; edit T normally so it becomes version 2; retry the identical CSV, mappings
  and idempotency key. CSV decoding runs again and supplies the *current* target
  version, changing the canonical mutation fingerprint before receipt replay.
- **Impact:** an exact retry is refused as a different request. This breaks the
  documented replay/resume behavior and can obstruct recovery of a partly
  committed import after an ordinary reference-target edit. Retrying with a new
  key risks duplicating already committed rows; that is not a safe workaround.
- **Evidence:** isolated current-source MCP/Engine harness imported one row,
  edited its target, and retried the same request. It produced
  `NendoIdempotencyConflictException: The idempotency key was already used with a
  different mutation payload.` One original imported row remained committed.
  Harness: `artifacts/code-review-20260926/host/Program.cs`; captured output:
  `artifacts/code-review-20260926/host/probe.log`.
- **Confidence:** high; executed against typed services in disposable files.
- **Dependencies:** CSV normalization, reference preconditions and batch-receipt
  recovery must be corrected together. Independent of other findings.
- **Correction / regression:** recover committed batches against the original
  request identity before re-resolving mutable preconditions, or retain the
  original normalized evidence. Test exact replay and partial resume after a
  reference target changes, without weakening validation of uncommitted writes.
- **Source:** initial revision `442090841137730f6dce27dffce779a86b903283`.

  Import-service SHA-256:
  `3C87A5EBDD032E00182F07C5936F847EC81209D5ED688786270E91ACD62F06AA`;
  CSV application service:
  `93001D2AC60A58612F35B37E999CC87CA3E4E81499C32574EB88F3E9F0B3DCAB`.

### R-007 — P2 / Medium — Import accepts keys that its generated batch keys cannot use

- **Component / location:** `src/Nendo.LocalMcp/NendoImportService.cs:198`;
  public import validation in `NendoDataMutationService.ImportAsync`.
- **Trigger:** send an otherwise valid import with a 199- or 200-character
  idempotency key. The public boundary permits 1–200 characters, but import
  appends `#0` before the first write. The Engine enforces the same 200-character
  limit on that longer internal key.
- **Impact:** a request admitted by the published interface cannot import even
  one row; its error misleadingly states the public key-length rule that the
  caller already met. Shorter caller keys are a workaround.
- **Evidence:** isolated MCP harness reproduced the 200-character case:
  `The idempotency key must contain 1-200 characters.` No first batch committed.
  Source and log are the same task-owned harness as R-006.
- **Confidence:** high; executed boundary case plus direct length arithmetic.
- **Dependencies:** independent of R-006, but both fixes should preserve exact
  replay semantics and stable batch identity.
- **Correction / regression:** derive a bounded collision-resistant internal
  batch key from the caller key and ordinal; test caller lengths 198, 199 and
  200, exact replay, changed payload rejection and multiple batches.
- **Source:** initial revision `442090841137730f6dce27dffce779a86b903283`.

### R-008 — P2 / Medium — Range and ranking summaries never refresh after data changes

- **Component / location:** `src/Nendo.Workbench/src/panels.ts:124` and `:213`
  (`loadRankedMaxima`, `loadRanges`);
  `src/Nendo.Workbench/src/view-overview.ts:321-342`.
- **Trigger:** display a range tile or ranked-list maximum, then commit a data
  change. Existing ready entries survive in `summaryCounts`.
- **Impact:** the loaders skip every ready cache entry without comparing its
  sequence with the new file sequence. Range values remain stale and ranking
  bars use the old maximum. The overview correctly notices the stale sequence
  and keeps scheduling its bounded once-per-second refresh, but the loaders
  never fetch replacement values, so it cannot converge.
- **Evidence:** actual `panels.ts` bundled in an isolated harness, with the host
  and DOM boundaries replaced by controlled stubs. Run
  `node artifacts/code-review-20260926/workbench/panels-probe.mjs` (exit 0):
  `rangeTile/rankedList: revision advanced 1 -> 2; zero new aggregate calls;
  cached result remains revision 1`.
- **Confidence:** high; executable loader reproduction and overview call trace.
  No claim about subjective native-window responsiveness is made.
- **Dependencies:** independent; use the sequence-aware pending discipline
  already present in other summary loaders.
- **Correction / regression:** invalidate/reload these entries by change
  sequence; assert updated values and that the overview stops retrying after
  catching up. Include ordinary native edits and MCP-driven changes.
- **Source:** initial revision `442090841137730f6dce27dffce779a86b903283`;
  panels SHA-256 `57643E38955186B096D7632F454D1625E452DB78EDEECDC5071CDFA54EF7A8D8`;
  overview `E8E7DED1B4354AA67AC1FB2D4C7AC5A75D0F473E2F66E49B3FF11841280A7A3C`.

### R-009 — P2 / Medium — Progress rings combine counts from different file revisions

- **Component / location:** `src/Nendo.Workbench/src/panels.ts:276-278`
  (`loadProgressTiles`); the range min/max pair also lacks a coherence check.
- **Trigger:** a write commits between the separately issued numerator and
  denominator reads for a progress tile.
- **Impact:** values from two snapshots are combined into one displayed result,
  then labeled with only the denominator's sequence. A count of 10 from revision
  2 divided by a total of 1 from revision 3 produces a bogus 1000% result that
  appears current, so the refresh logic need not correct it.
- **Evidence:** the isolated real-loader probe above supplied numerator
  `10@2` and denominator `1@3`; the cache became ready at sequence 3 containing
  both numbers. This is an executed race interleaving, not a measured production
  frequency. Range aggregation has the same two-read shape by static inspection.
- **Confidence:** high for progress tiles; the range extension is code-traced.
- **Dependencies:** shares `panels.ts` with R-008 but has a different cause.
  Refreshing stale entries alone does not ensure a coherent pair.
- **Correction / regression:** accept combined values only from the same
  sequence, with bounded retries, or expose a single-snapshot typed aggregate.
  Test a controlled intervening write and eventual convergence without false
  percentages or an inverted min/max range.
- **Source:** same revision and panels fingerprint as R-008.

### R-010 — P1 / High — Canceling a file dialog discards unsaved record edits

- **Component / location:** `src/Nendo.Workbench/src/file-actions.ts:121-138`,
  `:189-204`; `src/Nendo.Workbench/src/main.ts:80`;
  `src/Nendo.Desktop/MainPage.FileActions.cs:159-161` and `:63`.
- **Trigger:** type unsaved changes in a record form, choose File → Open file,
  then cancel the native picker. The host returns the unchanged session with no
  notice. `showFileActionOutcome` nevertheless refreshes and redraws the page.
- **Impact:** canceling a dialog loses the person's unsaved input. The renderer
  explicitly clears `openDraft` and replaces the form DOM; these file-action
  paths do not consult the existing dirty-form guard. Other canceled file
  actions using this path are exposed to the same loss.
- **Evidence:** `node
  artifacts/code-review-20260926/workbench/navigation-probe.mjs` exited 0 and
  printed `chooseFile canceled (same session, null notice): redraw boundary
  invoked with dirty form; draft discarded`. It executed the real file-action
  and refresh modules with a controlled canceled host response; the renderer
  stub models `main.render`'s explicit discard. Native cancellation and renderer
  destruction were also traced in source. This was not a native-dialog journey.
- **Confidence:** high from the module probe plus both endpoint traces.
- **Dependencies:** coordinate file-action outcome handling with existing draft
  preservation/guard rules. Independent of the summary/read findings.
- **Correction / regression:** preserve the current form for canceled/no-op
  outcomes; guard actions that actually replace it. Test actual dirty values and
  dirty tracking across canceled Open, New, Backup and export dialogs.
- **Source:** initial revision; file-actions SHA-256
  `2A47107349BA8C8BADF8AE55B47B4B06FBC8C9730509830475A686E947A96082`;
  main `1E55C1C3EAE3312FC7FB799675E4E203BBC7BB96FB972D99B0A085489F4FDD16`.

### R-011 — P2 / Medium — Nullable function parameters reject null before entering the function

- **Component / location:** `src/Nendo.Engine/Behaviour/ExpressionAdapter.cs:261`
  (`InvokeApplicationFunction`).
- **Trigger:** a reusable function declares an Integer parameter nullable and
  returns a constant or takes a branch that does not use that parameter. The
  caller supplies a null optional field.
- **Impact:** argument conversion calls `BehaviourValue.FromEvaluated`, which
  rejects null before the callee's declared nullability can be honored. A valid
  optional argument stops the formula even when the function never uses it.
- **Evidence:** the real Engine probe called nullable `F(x)` with body `7` and
  null input; expected 7, observed `NendoCalculationException: A value this
  formula needs is empty.` The values/empties contract permits empty arguments
  except where the function declares that it needs a value.
- **Confidence:** high; executed expression probe.
- **Dependencies:** same adapter as R-004, independent cause. Preserve the
  parameter's declared scalar type when constructing a typed empty argument.
- **Correction / regression:** pass typed empty values to nullable parameters;
  test unused/short-circuited optional arguments, non-nullable refusal and
  arithmetic use of an empty argument.
- **Source:** initial revision; same adapter fingerprint as R-004.

### R-012 — P2 / Medium — Retiring an action target leaves a trigger that blocks routine writes

- **Component / location:** `src/Nendo.Engine/Storage/SqliteNendoStore.Retirement.cs:103-120`.
- **Trigger:** an active trigger updates field `stamp` when `title` changes.
  Retire `stamp` through the typed schema operation, retaining the action and
  trigger. Retirement checks surface bindings but omits behavior targets.
- **Impact:** retirement commits, but the next ordinary title edit triggers a
  write to the retired field and the entire initiating edit rolls back. A
  definition change can therefore leave an active behavior that prevents normal
  editing until its definition or the retirement is corrected.
- **Evidence:** disposable real SQLite fixture, accessed only through Engine
  typed operations. The next title edit failed with `NendoPreconditionException:
  This field is retired. Reactivate it before editing.` The report does not
  claim data deletion; rollback protects existing data.
- **Confidence:** high; executed retirement and subsequent mutation.
- **Dependencies:** retirement and final-candidate behavior validation. Allow a
  single proposal to remove/rewire affected behavior and retire its target;
  merely checking intermediate operation order would reject legitimate work.
- **Correction / regression:** validate behavior bindings/targets against the
  final candidate, including fields and entities. Test refusal of the broken
  candidate and success of same-proposal rewiring/removal.
- **Source:** initial revision; retirement SHA-256
  `D3C91F95C02EF54654CE389653D12D2F6CB1A0B5CF69B83776350B0D6C487DF2`.

### R-013 — P2 / Medium — Overview record links fail outside the destination's first page

- **Component / location:** `src/Nendo.Workbench/src/view-overview.ts:230-236`;
  `src/Nendo.Workbench/src/actions.ts:254-265`.
- **Trigger:** click a recent-list or ranked-list overview row whose record is
  absent from the destination surface's initial 50-record window. Different
  sorting or filtering commonly produces this condition.
- **Impact:** navigation opens the record type but clears the requested
  selection, so the inspector never opens the clicked record. The overview
  route omits the focused-record read used by other navigation paths.
- **Evidence:** controlled execution of real `view-overview.openRecord` and
  `refreshDerived`, returning the first 50 destination records. The navigation
  probe printed `overview.openRecord(tasks,record-100): selection cleared; no
  record-ID read; inspector cannot open target beyond first page` (exit 0).
- **Confidence:** high; module-level reproduction, no native window journey.
- **Dependencies:** independent of R-008/R-009 despite sharing overview code.
- **Correction / regression:** load the requested record by ID before applying
  selection, with the existing deleted/stale handling. Test a 100-record
  fixture where overview ordering differs from the destination list.
- **Source:** initial revision; overview fingerprint as R-008; actions SHA-256
  `B021F001B4513E8A8C4495B5288885BD4AAED6F48BA24819382B72B79800EC04`.

### R-014 — P1 / High — A queued custom-view write can commit after its kill switch completes

- **Component / location:** `src/Nendo.Desktop/WorkbenchProtocol.cs:282` and
  `:489`; `src/Nendo.Desktop/DesktopSessionController.cs:430-439`.
- **Trigger:** queue the device's view-disable operation while the controller
  gate is occupied, then dispatch a custom-view write. The protocol checks view
  authority before waiting for the gate. The disable operation acquires the
  gate first; the already-admitted write acquires it next.
- **Impact:** the write commits after views have been disabled. The shared
  mutation method does not recheck extension authority inside the gate, so the
  promise to stop writes already on their way is not upheld. Package removal
  has a similar potential admission window; that variant was not executed.
- **Evidence:** deterministic headless probe linked the actual controller and
  protocol sources, with diagnostics DTO stubs and a disposable file. It held
  the gate, queued disable then create, released the gate and printed:

  ```text
  queued-switch=True; queued-write=True
  kill-switch-run=False
  queued-write-ok=True; error=
  records-after-off=1
  ```

  `kill-switch-run=False` is the effective view-running setting after disable.
  Probe: `artifacts/code-review-20260926/host/desktop/DesktopProbe.csproj`.
  Build and run exited 0; build had 0 warnings and 0 errors. No WinUI window or
  owner application was opened.
- **Confidence:** high; controlled concurrency reproduction in actual source.
- **Dependencies:** extension identity must remain attached to the mutation
  until authority is rechecked under the session gate. Independent of import
  and view-reference findings.
- **Correction / regression:** validate the package/run setting at serialized
  mutation admission; test queued disable/removal ahead of a queued write, plus
  an already-committing write whose outcome must still be reported honestly.
- **Source:** initial revision `442090841137730f6dce27dffce779a86b903283`.

### R-015 — P2 / Medium — Immediate undo fails when a reference move also updates its parents

- **Component / location:** `src/Nendo.Engine/Storage/SqliteNendoStore.Compensation.cs:232-238`
  (`CreateCausalInverses`).
- **Trigger:** move a child's reference from P1 to P2; an approved automatic
  action updates counts on both parents in the same revision. Immediately
  compensate that revision with no intervening edits.
- **Impact:** parent inverses advance their versions, but the inverse reference
  assignment retains P1's historical pre-move target version. The host treats
  its own inverse progression as an external conflict and refuses the entire
  compensation. A causal revision intended to be reversible cannot be undone.
- **Evidence:** the typed-operation Engine fixture printed `Reference
  reassignment: committed with 2 generated parent changes`, then `Reference
  reassignment compensation: NendoPreconditionException: The selected target
  changed. Select it again before saving.` The compensation transaction rolled
  back; no partial undo is claimed.
- **Confidence:** high; real disposable storage and coordinator execution.
- **Dependencies:** causal inverse ordering and target-version evidence. This
  is separate from R-006's CSV retry normalization.
- **Correction / regression:** derive target versions from touched-record
  evidence and the planned inverse version progression. Preserve refusal for
  genuine outside edits. Test immediate reference reassignment compensation,
  exact replay, and an intervening external parent edit.
- **Source:** initial revision; compensation SHA-256
  `93945A33CE75511E01B6AD3C845F20C4B4C3D0164162D0D25D4EA1C6EEE3C8AA`.

### R-016 — P2 / Medium — Exact decimal sums refuse representable mixed-scale results

- **Component / location:** `src/Nendo.Engine/ExactAggregate.cs:143-145`
  (`Compose`); compare scalar normalization in `ExactDecimal.Read:28-29`.
- **Trigger:** sum valid Decimal values `decimal.MaxValue` and `0.0m`.
  Accumulation adopts the larger scale, producing a coefficient ten times the
  maximum with one removable trailing zero.
- **Impact:** the aggregate rejects an exactly representable answer. Summary,
  grouped, date-bucket and cell sums sharing this fold can become unavailable
  solely because input values have different decimal scales.
- **Evidence:** the current-source Engine probe printed `Exact decimal sum
  max+0.0: NendoPreconditionException: The exact sum is outside the range this
  host can represent.` The expected answer is exactly `decimal.MaxValue` with
  no rounding. `Compose` removes zeros only when scale exceeds 28, whereas
  scalar normalization already removes them when coefficient overflow requires
  it as well.
- **Confidence:** high; executed arithmetic boundary reproduction.
- **Dependencies:** shared exact aggregate fold; independent of cache and
  revision-coherence defects R-008/R-009.
- **Correction / regression:** reduce redundant trailing-zero scale as needed
  to fit the coefficient before refusing. Test representable mixed-scale
  boundary sums and genuinely out-of-range sums across aggregate consumers.
- **Source:** initial revision; aggregate SHA-256
  `10AFE1DCA2048E578D5BE0829ECD53222C1A1FA41D87C61947231E880A77AAF8`.

### R-017 — P2 / Medium — Structurally invalid behavior-grant JSON prevents every file from opening

- **Component / location:** `src/Nendo.Desktop/DesktopBehaviourGrantStore.cs:53-57`
  and `:159-162`; `src/Nendo.Desktop/DesktopFileLifecycle.cs:192`.
- **Trigger:** device settings contain valid JSON with an invalid member, such
  as `{"Version":1,"Grants":[null]}`, or a grant missing `BehaviourDigest`.
- **Impact:** validation dereferences the null member instead of treating the
  grants as unavailable. Every file open attaches this store; the resulting
  `NullReferenceException` closes even a healthy file. Recovery requires repair
  of the device settings outside the normal file-open path. This is a settings
  corruption/resilience scenario, not a claim that ordinary saves write nulls.
- **Evidence:** headless actual-source Desktop lifecycle probe with task-owned
  settings/file printed `null-grant-open-error=NullReferenceException: Object
  reference not set to an instance of an object.; has-file=False`.
  Existing malformed-grant tests use lowercase `version`/`grants` against a
  case-sensitive PascalCase deserializer, so they stop at the version check and
  do not exercise nested grant validation.
- **Confidence:** high; executed malformed-settings open failure.
- **Dependencies:** device grant deserialization and safe file-open behavior.
  Independent of R-014's authority race.
- **Correction / regression:** validate every nullable persisted member and
  route structural failures through the existing fail-closed notice path. Test
  actual serializer casing, null array members and missing/null digests while
  confirming the file remains usable without behavior approval.
- **Source:** initial revision `442090841137730f6dce27dffce779a86b903283`.

### R-018 — P1 / High — Compensating old package metadata overwrites newer owner changes

- **Component / location:** `src/Nendo.Engine/Storage/SqliteNendoStore.ExtensionPackages.cs:439-447`
  (`CreateExtensionInverse`).
- **Trigger:** start with package metadata `Original/index.html`; revision A
  changes it to `Second/second.html`; revision B changes it to
  `Later owner edit/third.html`; compensate A after B has committed.
- **Impact:** the inverse metadata operation has no expected-state or revision
  precondition. It silently overwrites B's newer title and entry point with the
  original values. Besides losing newer metadata, this can change which
  custom-view entry point is executed. History retaining B does not make the
  unexpected overwrite safe.
- **Evidence:** real typed-operation fixture printed `Old package revision
  compensation: later title/entry overwritten by Original/index.html`. No
  conflict was raised. The Engine probe exited 0 having reproduced the defect.
- **Confidence:** high; executed multi-revision compensation.
- **Dependencies:** package metadata operation/inverse preconditions and
  compensation replay. Separate from R-015, which rejects a legitimate undo;
  this finding concerns an undo that incorrectly succeeds.
- **Correction / regression:** compare all affected current metadata with the
  original revision's applied state before restoring/removing it. Preserve
  idempotent retry. Test newer metadata edits, non-conflicting compensation and
  multiple package operations in one revision. File-content/MIME preconditions
  also deserve adjacent coverage but are not claimed reproduced here.
- **Source:** initial revision; extension package storage SHA-256
  `82BBB50C4010EC69F45AD60AF05982E18A29668488A83E2D5A57497327821518`.

### R-019 — P3 / Low — Cleared documentation search reopens stale results

- **Component / location:** `site/src/components/DocsSearch.astro:105-119`.
- **Trigger:** type a query, then clear the input or dismiss search while its
  Pagefind/result-data promises are still pending.
- **Impact:** the older continuation writes its results and unhides the panel
  after dismissal. Slower old queries can also replace newer results. The
  public site is affected; the desktop product is not.
- **Evidence:** the actual component script was transformed in memory and run
  with deferred Pagefind and DOM boundaries. `node
  artifacts/code-review-20260926/workbench/site-search-probe.mjs` exited 0:
  `Docs search: clearing input hides results, but an earlier in-flight response
  reopens stale results under empty input`.
- **Confidence:** high; controlled component-script reproduction, no deployed
  browser observation.
- **Dependencies:** independent.
- **Correction / regression:** invalidate a request generation on every input
  change and dismissal; check it before publishing results after either await.
  Test clearing, Escape, outside-click dismissal and replacing a pending query.
- **Source:** initial revision; component SHA-256
  `8FD47FFE74B2FEA4A69E30966A5072B682463F2BB426D57E05BA84D63BFA35AB`.

## Open investigations and limitations

- The registered Nendo MCP endpoint identifies the live Nendo Development file.
  All 69 existing Work records were read; no existing broad-review item matched.
  The review then authored **proposed W-070 — Review the current codebase and
  record actionable findings**, ID `nd.work.r.code-review-20260926`.
  Proposal **W-070 — Code review 2026-09-26: 19 findings and evidence** is
  `previewable`, with 24 canonical operations and no validation diagnostics,
  captured at definition revision 54. It has **not been accepted or applied**.
  It contains proposed Findings F-135–F-153 (R-001–R-019 in order) and Checks
  C-213–C-216. All bounded edit leases were released; final lease status was
  `hasLease:false`. The ledger was refreshed after the other client's planner
  activity advanced its revision; no existing record/proposal was taken over.
- Full production, installed UI and installer smoke lanes have not been run by
  this review. Their outputs and running hosts may be in use by the other agent.
- Security dependency version checks will be distinguished from behavioral code
  defects and will not infer vulnerabilities merely from a package's age.
  `npm audit --package-lock-only --ignore-scripts --json` failed to reach the
  advisory endpoint under the sandbox (exit 1 for Workbench and site). Automatic
  approval review rejected an escalated retry because it would export package
  metadata to npm. Specific approval is pending; no vulnerability verdict is
  claimed, and no alternate route around that rejection is being used.

### Investigations not counted as confirmed findings

- A MIME-only package correction is absent from the live-frame digest/key, so
  an already-mounted view can retain the old load. This is source-traced and
  likely relevant to unattended acceptance, but no browser correction/reload
  journey was executed. Ordinary proposal navigation can already remount it.
- An injected unattended-consent callback exception after promotion loses the
  adapter's accept replay. The normal Desktop grant store swallows ordinary I/O
  failures; a normal production trigger was not established. This is not
  counted as a production defect from an artificial callback alone.
- A reusable function can declare Boolean with an Integer body; the full
  downstream typed-contract consequence was not completed. Retain for targeted
  investigation, not as another confirmed finding.
- Extension asset/session races and aggregate description consistency were
  examined without sufficient proof for an additional finding. Active-store
  behavior-cache poisoning was investigated and dismissed for traced routes.

### Coverage boundaries

The deepest review covered behavior evaluation, compensation, typed numeric
reads, async renderer state and cross-adapter authority. The complete semantic
compiler, inspection/upgrade/recovery-export internals and every existing test
were not exhaustively inspected. No physical power-loss, cloud-sync, installed
WinUI/WebView2 isolation, visual/theme/accessibility, full Desktop/MCP suite,
site build/deployment or NSIS wrapper qualification was performed. Existing
intentional limitations in the roadmap were not reclassified as defects.

## Handoff checkpoint

Objective: deliver a broad, durable review without changing implementation or
interrupting the other agent. `REVIEW.md` is the only intended repository change;
all probes are task-owned scratch. No branch/index/commit/push operation, owner
file mutation, installed-host restart or installer run was performed. Final HEAD
remained `442090841137730f6dce27dffce779a86b903283`; supporting source hashes
remained unchanged. `git status --short` listed `?? REVIEW.md` plus the other
agent's nine modified paths enumerated above; those changes were preserved.
The planner proposal is waiting for owner acceptance; findings are not fixes.

Next action: triage the High findings, create bounded fixes with the regression
checks stated above, and falsify each new guard under the repository's normal
implementation workflow. No finding is marked resolved by this review.

## Executed checks

- `pwsh -NoProfile -File tools/Test-Repository.ps1`: exit 0,
  `Repository verification passed.` This checks repository structure and
  conventions; it is not a product-runtime pass. Log:
  `artifacts/code-review-20260926/repository.log`.
- R-001 setup retry probe: exit 0; reproduced the missing registration retry as
  quoted above. Task-owned fixture only; no app rebuild or installer launch.
- From `src/Nendo.Workbench`, `node --test "scripts/*.test.mjs"`: exit 0,
  335 tests passed, 0 failed, 0 skipped. Tests bundle source in memory and do
  not overwrite the other agent's Workbench build. Log:
  `artifacts/code-review-20260926/workbench-tests.log`.
- Workbench `node node_modules/typescript/bin/tsc --noEmit`: no diagnostics.
  `node scripts/verify-dependencies.mjs`: exit 0, `Workbench dependency boundary
  verified: AG Grid Community only; no React or Enterprise package.`
- Engine review probe: current sources compiled directly with Roslyn into
  task-owned output, then executed; exit 0 and R-004/R-005 reproduced. Two CS1701
  dependency compatibility warnings were emitted. This is an isolated probe,
  not a normal solution-build result. An earlier harness restore attempt was
  blocked by access to the user NuGet configuration; it was not a test failure.
- Engine baseline assembly suite, using a private copy of existing assemblies:
  `dotnet vstest artifacts/code-review-20260926/engine-tests/debug/Nendo.Engine.Tests.dll
  /ResultsDirectory:artifacts/code-review-20260926/engine-results-corrected /Logger:trx`
  exited 0: `Failed: 0, Passed: 878, Skipped: 1, Total: 879` (35 seconds).
  The skipped test is the explicit large-file measurement harness. This is
  baseline-binary evidence, not a rebuild of the reviewed source. The copied test
  DLL SHA-256 was `FB97637FD2E950F4C63DE766B15DC1CDDC4CC52CEAD9DFC164A8A302D1062E8C`;
  copied Engine DLL was `8110687CD9CDDC9AFB73B5CD915D3ED4CF1A6F37016CB982D9F5C2A35615D5C2`.
  The first run from a directory one level too shallow exited 1 with 29 missing-
  fixture failures, 849 passed and 1 skipped. Correcting the task-owned copy's
  directory depth resolved those failures; no product change was made.

### Current-source MCP and Desktop probe commands

Run from the repository root. Outputs are isolated from the normal build tree.
The task-owned NuGet configuration clears package sources and uses already
cached dependencies; the probe does not install a production app. Restore,
build and run each exited 0; both builds reported 0 warnings and 0 errors.

```powershell
dotnet restore artifacts/code-review-20260926/host/Probe.csproj --artifacts-path artifacts/code-review-20260926/host/build --configfile artifacts/code-review-20260926/host/NuGet.Config -p:NuGetAudit=false
dotnet build artifacts/code-review-20260926/host/Probe.csproj --no-restore --artifacts-path artifacts/code-review-20260926/host/build
dotnet artifacts/code-review-20260926/host/build/bin/Probe/debug/Nendo.LocalMcp.Tests.dll

dotnet restore artifacts/code-review-20260926/host/desktop/DesktopProbe.csproj --artifacts-path artifacts/code-review-20260926/host/desktop/build --configfile artifacts/code-review-20260926/host/NuGet.Config -p:NuGetAudit=false
dotnet build artifacts/code-review-20260926/host/desktop/DesktopProbe.csproj --no-restore --artifacts-path artifacts/code-review-20260926/host/desktop/build
dotnet artifacts/code-review-20260926/host/desktop/build/bin/DesktopProbe/debug/DesktopProbe.dll
```

Initial sandbox restores could not read the user's NuGet configuration; the
cached restores succeeded under approved escalation with task-owned outputs.
That access issue is separate from the product failures the probes reproduced.

### Final artifact and source checks

HEAD stayed at the initial revision throughout final fingerprint checks; late
concurrent edits are listed above. Review-owned compiled outputs, copied baseline
assemblies, test-result directories, npm cache and disposable fixtures were
removed from ten explicitly enumerated directories within this task's scratch.
Small probe sources and text logs remain as disposable scratch; the findings,
literal failure outcomes, command scopes and limitations are retained here.
`REVIEW.md` is UTF-8 without BOM and uses LF line endings. No source fix, commit,
push, installer or owner acceptance is claimed.
