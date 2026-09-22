# Implement ADR 0008: bounded calculations and atomic local actions

Status: **carried out**. Stages S0-S9 are implemented and obligations P1-P8 are
satisfied; what each one rests on is recorded in
[calculations-and-actions.md](../contracts/calculations-and-actions.md), including the
two lanes only a person could run. Where this plan and the shipped code disagree, the
contract is current; this document is kept as the transfer it was.
Prepared 2026-09-12 for an implementer who did not participate in the experiments.
Authority: [accepted ADR 0008](../decisions/0008-general-scripting-and-capability-isolation.md).

## 1. Start here

Deliver calculated fields, reusable pure functions, explicit local actions and
automatic create/update/delete triggers, including local approval and recovery.
An initiating edit and every selected automatic action must commit together or
leave the file unchanged. A calculation error alone must not destroy valid input.

Read this plan in order. Then read the [execution semantics](adr-0008-semantics.md)
and [regression specifications](adr-0008-regressions.md). They contain the
information needed from the retired prototype. The [acceptance evidence](adr-0008-evidence.md)
records what was measured, its limits and the dependency resolution. There is no
remaining prototype runner to invoke or copied Engine to reference.

Before coding, read `AGENTS.md`, [vision](../vision.md),
[architecture](../architecture.md), [roadmap](../roadmap.md), and ADR 0008 in full.
Read the affected contract at each stage. Accepted ADRs 0003/0005/0006/0007/0009/
0012 govern storage, coordinator authority, revisions, proposal replay, MCP and
compatibility. This plan chooses implementation defaults within that authority;
if a default conflicts with current code or a later accepted ADR, record the
specific conflict and resolve it before dependent work.

Work through S0–S9 in order. Do not expose an incomplete write path to users.
Internal calculation-only slices are useful checkpoints but do not satisfy P7.
At each checkpoint record changed paths, exact commands/results and the next
unfinished acceptance item. Preserve unrelated working-tree edits. No new
project, evaluator abstraction framework or second persistence provider is needed.

### Non-goals

No JavaScript/C# scripts, compiled user code, plug-ins, third-party controls,
network/file access, timers, background actions, worker-process runtime,
Excel compatibility, per-cell formula overrides, or embedded agent. ADR 0013's
general extensions remain separate. Do not convert a containment failure into
permission to select another evaluator, widen limits or add a process boundary.

### What the experiment did and did not deliver

NCalc 7.1.0 works for a **restricted typed vocabulary** with a small adapter.
Its decimal option alone is wrong for integer division. The adapter intercepted
division before NCalc converted integer operands to Double. Other arithmetic
continued through NCalc. Engine copies proved SQLite atomicity, physical-clone
planning, exact replay, local grant checks and receipts. A real copied WinUI host
proved cancellation/Studio recovery and editor preservation after rollback.

The prototype did **not** implement generic persisted behaviour definitions,
derived-field storage/query integration, a production function catalogue,
durable proposal read-set storage, all write routes, approval UX or compatibility.
Its project/task trigger was hard-coded. These are work in this plan, not features
to assume already exist. It used `AsyncLocal` experiment state and source-text
patches; neither belongs in production.

## 2. Repository map

Paths below exist at planning time; new file suggestions are labelled **new**.
Use `rg` to locate the symbols if files move. Do not copy storage logic to UI/MCP.

| Responsibility | Start here | Intended change |
| --- | --- | --- |
| Package versions/build | `Directory.Packages.props`, `Directory.Build.props`, `global.json`, `src/Nendo.Engine/Nendo.Engine.csproj` | NCalc in Engine only; normal central package management; no prototype references |
| Typed service facade | `src/Nendo.Engine/NendoApplicationService.cs` | Typed definition/calculation/action services shared by adapters |
| Definitions/operations/digests | `Operations.cs`, `CanonicalChangeSetRequest.cs`, `SemanticDiff.cs` in Engine | Typed behaviour operations, canonical payloads, readable diffs and causal attribution |
| Coordinator | `src/Nendo.Engine/NendoWriteCoordinator.cs` | `ApplyAsync`, `ApplyChangeSetAsync`, `BeginProposalAsync`, promotion and compensation paths |
| SQLite transaction | `src/Nendo.Engine/Storage/SqliteNendoStore.cs` | `ApplyAsync`/`ApplyChangeSetAsync` staging, expansion, commit-time checks |
| Operation dispatch | `Storage/SqliteNendoStore.Operations.cs` | Existing create/set/delete validation; add protected definition operations |
| Read/storage inspection | `Storage/SqliteNendoStore.Read.cs`, `.ReadQueries.cs`, `.Inspection.cs` | Bounded staged reads and schema/definition compatibility inspection |
| Receipts and compensation | `OperationOutcome.cs`, `Storage/SqliteNendoStore.Outcomes.cs`, `.Compensation.cs` | Causal receipt, replay-safe inverse operations, unresolved outcome handling |
| Proposal persistence | `ProposalModel.cs`, `ProposalWorkspace.cs` | Frozen expanded operations, read preconditions and review digest |
| Compatibility | `NendoFormat.cs`, `SemanticCapability.cs`, coordinator upgrade/restore/identity-copy partials | Required host capability, deliberate upgrades, safe inspection and grant lifecycle |
| Expression implementation | **new** Engine `Behaviour/` internal files | Types, catalogue, adapter, dependency graph, shared budget and planner |
| Desktop | `src/Nendo.Desktop/DesktopSessionController.cs`, `WorkbenchProtocol.cs`, `DesktopOperationOutcomes.cs`, `MainPage.xaml.cs` | Local grant owner, capabilities, typed review/edit calls, cancellation/recovery |
| Numeric transport | `src/Nendo.Desktop/WorkbenchScalarJsonConverter.cs` | Keep integers/decimals out of JavaScript Number |
| Workbench | `src/Nendo.Workbench/src/main.ts`, `surface-model.ts`, `surface-preview.ts`, `styles.css` | Derived values/errors, draft retention, approval review, editor/help/catalogue consumers |
| MCP | `src/Nendo.LocalMcp/NendoAuthoringOperations.cs`, `NendoAgentProposals.cs`, `NendoMcpReadIndex.cs`, `NendoAuthoringExamples.cs` | Closed definition authoring and discovery through normal proposals |
| Existing tests | `tests/Nendo.Engine.Tests`, `tests/Nendo.Desktop.Tests`, `tests/Nendo.LocalMcp.Tests`, Workbench `scripts/*.test.mjs` | Add tests here; do not create another test framework |

## S0. Baseline and implementation checklist

1. Inspect `git status --short`, current `global.json`, central package versions
   and test projects. The experiment used SDK 10.0.204, net10.0, Windows x64.
   Do not silently upgrade the repository SDK to reproduce it.
2. Run the baseline repository gate. Record pre-existing failures separately.
3. Create an implementation checklist using S1–S9 and the regression IDs below.
   Mark every item pending initially. A historical prototype pass is not a new
   production test pass.
4. Confirm the current operation/receipt/proposal flow using the map above,
   especially the difference between request digest and expanded operation digest.

Exit: known baseline, scope and checkpoints; no product behaviour changed.

## S1. Stable contract and protected definitions

Read scalar, reads-and-authority, operation-outcomes, semantic-surfaces and MCP
contracts. Write `docs/contracts/calculations-and-actions.md` before treating
new DTOs or storage as stable. Link it from the contract index. Use the semantics
document as the initial execution contract; do not publish the prototype's
`experiment-1` identifier or its singleton JSON table as production format.

Use the following model as the first implementation, adapting names to repository
conventions without changing the meaning:

| Definition | Required information |
| --- | --- |
| Calculated field | Stable calculation ID, owning entity/field identity, display metadata, result scalar/nullability, expression source, explicit binding map, contract version |
| Reusable function | Stable function ID, source alias mapping for calls, ordered typed parameter IDs/names, result type, expression body, contract version |
| Binding | Stable ID and declared kind: same-record field, declared reference traversal, or bounded related aggregate; all entity/field/relationship IDs explicit |
| Local action | Stable action ID, ordered typed steps; create/set/delete targets and expression inputs; only local data capabilities |
| Trigger | Stable trigger ID, entity ID, create/update/delete subscription, optional relevant stored-field IDs for updates, Boolean condition and referenced action |
| Execution contract | Version, catalogue/capability requirements and validated host-owned resource policy |

Do not overload `NendoStorageKind` with a formula or store a computed value as an
editable physical column. Add a derived-field descriptor to the semantic/read
model. Inputs remain ordinary stored scalars. A read returns typed value/null/
error/pending plus source revision information, never an error string stuffed
into a numeric cell. Initially calculation inputs/results support only Int64,
decimal, Boolean, text and DateOnly. Existing datetime/UUID/reference storage is
still valid; reference IDs can resolve bindings but are not arbitrary expression
objects. Add other calculation scalar domains only with explicit semantics/tests.

Implement closed canonical definition operations: create/update/remove a
calculation, function, action or trigger. Validate stable references, duplicates,
types, cycles, supported contracts and capability use. Include definition payloads
in canonical digests and semantic diffs; declare each operation's reversibility.
Whole-definition convenience requests must expand to these operations first.
Block deletion of referenced definitions unless the submitted ordered change set
also removes/rewires the references and leaves a valid final candidate.

Store source and binding metadata, never NCalc's AST. Start with one protected
definition table keyed by stable definition ID, with closed definition kind,
contract version, optional owning entity ID and canonical typed definition body.
Validate body shape by kind; this is not an arbitrary user JSON field. Keep
calculated-field descriptors in that protected model rather than inventing
physical storage columns. Integrate table inspection and deliberate creation/
upgrade with the existing schema conventions. Publish the exact schema and
canonical JSON/digest rules in the contract. Avoid ordering by dictionary iteration.
Choose the next unused `minimumHostVersion` capability in current code; do not
reuse a hard-coded prototype or surface version. Files without behaviour remain
valid; opening an old file must not automatically mutate/upgrade it. If a physical
metadata upgrade is necessary, use the existing explicit upgrade path. Unsupported
newer semantics must make normal editing unavailable while safe inspection/recovery
remains reachable. Test this before exposing authoring.

Exit tests: definition round-trip/reopen; canonical digest determinism; renamed
labels keep bindings; invalid/recursive definitions refuse before installation;
empty/old files still open without writes; unknown contract cannot edit.

## S2. Typed NCalc adapter and shared budget

Pin NCalc 7.1.0 in central package management; Engine is its only consumer.
Compare the transitive resolution with [the preserved lock](adr-0008-dependencies.lock.json).
The lock is provenance, not a production project to reference. Restore/build
normally and retain the production graph using repository conventions. Changes
to the evaluator or resolved parser/math packages require rerunning all semantic
and containment regressions; never assume a newer version has the same meaning.

Implement an internal adapter with inputs equivalent to:

```text
Validate(definition, immutable catalogue, budget) -> compiled validated expression
Calculate(validated expression, typed semantic bindings, budget) -> value|null|error
EvaluateActionInput(validated expression, typed bindings, budget) -> value or failure
```

Expose neither NCalc types nor `object` service handles on application APIs.
The following is the working NCalc 7.1.0 integration recipe:

1. `ExpressionConfiguration.FromOptions(DecimalAsDefault | LongAsDefault |
   OverflowProtection | NoStringTypeCoercion | OrdinalStringComparer | NoCache)`;
   use `CultureInfo.InvariantCulture` on parse and evaluation.
2. Validate source length, lexical token/punctuation count and nesting before
   calling `Expression.GetLogicalExpression(cancellationToken)`. Then recheck
   cancellation: NCalc can wrap parser cancellation as a parse error. Refuse
   `Expression.Error`, empty syntax and unsupported nodes.
3. Walk the AST with explicit node/depth/work limits and static types. Only the
   operations in the semantics document may pass. Check every branch, even lazy
   branches. Functions must have declared arity/argument/result types. Bind
   identifiers and calls through stable-ID mappings, not display names.
4. Supply `ExpressionContext.Parameters` with typed scalar values only. Supply
   `ExpressionContext.Functions` with the closed pure functions and validated
   application functions. Application calls evaluate with the SAME budget.
5. Instantiate `Expression(ast, configuration, context, invariantCulture,
   countingVisitorFactory)`. Implement `IEvaluationVisitorFactory` and a subclass
   of `EvaluationVisitor` to count `ValueExpression`, `Identifier`, `Function`,
   `BinaryExpression`, `UnaryExpression` and `TernaryExpression` visits. Reject
   `LogicalExpressionList`; expose no asynchronous uncounted evaluation entrypoint.
6. Attach `EvaluateBinary`. Preserve short-circuit Boolean behaviour. For other
   binary operations reject null operands. For `BinaryExpressionType.Div`, set
   `args.Result` to `ToDecimal(args.LeftValue()) / ToDecimal(args.RightValue())`.
   `ToDecimal` accepts only long or decimal. **Do not cast a final Double to
   decimal: the wrong branch may already have been selected.** Other approved
   arithmetic remains NCalc's checked implementation.
7. Guard unary null before NCalc can convert it to zero/false. Evaluate the unary
   operand once and pass its scalar value to base unary handling. Guard ternary
   conditions as actual Boolean and visit only the selected branch. Preserve
   short-circuit `and`/`or`; do not eagerly evaluate an error on the right.
8. Validate inputs, intermediates and result types/lengths. Normalise expected
   input/arithmetic/resource errors into structured diagnostics with stable IDs,
   not production stack traces. Cancellation must also abort pending writes.
   Unexpected exceptions must not become fabricated successful values.

Use immutable validated definitions/catalogues. The prototype's mutable arrays
and record-object cache keys are not suitable production identity. A bounded
cache must include contract, definition/dependency digest and limit policy;
values also need input snapshot/revision identity. Cache hits must not bypass
recursive-definition/depth validation or allow a stricter limit to reuse a more
permissive result. Validate graph dependencies before caching; maintain one
recursion stack for the complete graph.

Use the initial finite limits in the semantics document. Validate host settings
as finite nonnegative/positive values as appropriate; files cannot raise them.
Charge checks before allocating/visiting/writing. Track aggregate allocation
where inputs/catalogues can multiply individually bounded strings. Do not leave
a library built-in reachable merely because it appears harmless.

Exit: every D1 and D2 scalar/parser regression passes as normal tests, including
intermediate precision, warm-cache limits and joined cancellation. Run dangerous
probes under an external watchdog; a killed or still-running worker is failure.
Stop this stage on unresolved semantic/containment failures.

## S3. Calculation dependency and read service

Implement one Engine calculation service over the validated adapter. Its record
resolver accepts semantic binding descriptions; only storage resolves SQL and
physical identifiers. It must support a transaction's staged snapshot as well as
ordinary bounded reads. Do not call the public coordinator from inside an existing
write transaction: it can re-enter the gate or read stale committed state.

Build a dependency DAG for same-record calculated fields and reusable functions;
reject static cycles during candidate validation. Maintain an evaluation stack
keyed by calculation/entity/record for runtime related-record cycles. Resolve
declared reference traversals and bounded collection aggregates with the same
budget. The initial related aggregate catalogue should cover count, filtered
count and typed sum. Initial rules: count counts members and returns Int64 zero
for empty; filtered count includes only true predicate results and propagates
null/error predicates as a calculation error; sum returns typed zero for empty,
uses checked arithmetic and propagates null/error member values as an error.
Do not silently drop missing/error members. Document and test these new aggregate
rules (only completed-task counts were proven by the prototype).

Start with on-demand evaluation and conservative invalidation. Keys include
definition/contract, file identity, relevant record versions and data revision
for collection membership. Create/delete/reassignment invalidates both old and
new parent results. Never return a partial aggregate after hitting a scan limit.
Recalculation and cache rebuilding create no revision or record event. A result
that is loading is `pending`, not yesterday's value presented as current.

Extend typed read DTOs and numeric converters so Studio, custom surfaces and MCP
see identical results and diagnostics. Do not sort/filter a visible page as if
it were the whole collection. Initially refuse unsupported global computed
sort/filter operations explicitly; retain complete bounded read semantics.

Exit: two dependent calculations and one reusable function update on edit;
rename/reopen/offline preserve bindings; zero denominator saves input and returns
error; fixing it recovers; related create/delete/move invalidates both parents;
read/render/open never writes or starts actions.

## S4. Atomic action planner in the existing write transaction

Implement an explicit internal execution context passed from coordinator to
storage/planner. It carries budget, staged resolver, immutable definitions,
authority/grant snapshot, event queue, read set and causal attribution. Do not
port `AsyncLocal ExperimentScope`, public replay flags or string-patching hooks.

Preserve this ordering for direct data mutations:

```text
acquire existing coordinator gate and validate file authority
resolve receipt for original request identity/digest; return committed retry
begin existing SQLite transaction
validate required local grant and capture before state for initiating records
stage ALL initiating canonical operations with ordinary checks
derive initial logical create/update/delete events from before vs staged state
enqueue in stable (entity ID, record ID) ordinal order
while FIFO queue is not empty:
    charge shared budget; select matching triggers by stable trigger ID
    resolve condition against current staged state, recording read dependencies
    false -> no action; calculation error -> blocked outcome; continue
    for each selected action's declared step in order:
        evaluate input/target against current staged state; errors abort
        expand to ordinary typed create/set/delete operations
        validate permissions, record/reference versions and data constraints
        suppress no-op assignments, charge generated-change budget
        execute operations through existing storage dispatch
        record attribution and enqueue their logical record events
recheck cancellation, file authority and current local grant at commit boundary
write one causal revision + original-request receipt in the SAME transaction
commit once; publish refreshed calculations/outcome after commit
```

The relevant store hook points from the experiment were after reading the
initial manifest, after staging the initiating operation loop and before schema
materialisation/final validation, and immediately before transaction commit.
Integrate structurally, not by literal source replacement. Generated operations
need the same validation/evidence path as initiating operations. Preserve the
current DELETE journal, split revision lineages and normal authority validation.

For multi-field edits, intermediate low-level SetField versions are real but must
not emit half-form events. Document event envelopes with typed before/after;
creation has no before, deletion no after. Apply update-field subscriptions to
net stored-value changes. Each generated action step observes previous steps;
group its multi-field edit at the same logical boundary. Initial ordering is
ordinal; subsequent events are appended FIFO, not globally re-sorted.

Allow only typed local create/set/delete capabilities. A generated write cannot
change definitions, identity, grants, schema or file lifecycle. Generated IDs and
any host time supplied to a plan are frozen once; replay never regenerates them.
Record root request, triggering event, trigger/action/step IDs and behaviour
digest with operations using existing history authority. Do not add an independent
action commit log.

Keep original request digest separate from expanded operation digest. A retry
looks up the original key/payload and returns its causal receipt. The prototype
used an internal digest override to prove this; production must use an explicit
trusted internal prepared-mutation representation, not an author-supplied override.
Changing payload under an existing key still refuses. A refresh failure after
commit does not roll the transaction back or justify a new key.

Exit: D3 matrix passes against real SQLite, including injected failures after
each action and immediately before commit, unchanged records/versions/revisions,
no successful receipt, one successful causal commit, idempotent retry and reopen
after lost response. Add tests for branching, multiple triggers, create/delete,
same-record cycles and shared budgets. Never replace this with an in-memory test.

## S5. Frozen proposal expansion and exact promotion

Extend the host-owned proposal model/workspace with a prepared behaviour plan.
It contains original requests, ordered expanded canonical operations, attribution,
candidate behaviour/contract digests, per-record read versions and collection data
revision preconditions. Include this review-relevant metadata in a deterministic
digest. Persist it with the reviewed proposal; an in-memory map is insufficient.

On the physical clone, apply definition changes and record edits in the documented
change-set order. Use the SAME planner as direct writes against the appropriate
candidate definitions and staged state. Produce one reviewed expanded plan.
Definition-only promotion emits no data events and performs no historical backfill.
Do not expand once in one code path and again in `BeginProposalAsync` validation.

At promotion, load the exact saved plan, check active file identity/definition,
execution contract, approvals, every read-record version and the captured data
revision for membership. These checks occur under the coordinator's authority and
transaction boundary. A new matching record is stale even if no old record changed.
Never refresh captured preconditions from today's snapshot to make acceptance pass.

Replay precisely the saved operations with an internal capability indicating
validated replay. No public DTO, MCP field or user action may request this mode.
Do not execute triggers again. Never replace the active database with its clone.
Freeze IDs, time, ordering and attribution during preparation. Reject stale plans
and ask for a new preview; do not silently recompute inside acceptance.

Mixed definition/data proposals need explicit tests. A new candidate behaviour
does not inherit approval for an old digest. Before promoting a data-bearing plan,
the host must hold explicit consent for the exact candidate effects/capabilities;
commit-time revocation checks still apply. Use a host-created, one-operation
approval ticket bound to the exact plan digest, candidate behaviour, identities,
capabilities, contract and current local revocation generation. Keep this ticket
internal to the host/coordinator; it is not serializable author input. Invalidate
it on revocation, plan change, failure or use. After successful promotion persist
the separately approved durable grant. On restart no old in-memory ticket remains.
Do not let the clone grant itself authority. Definition-only installation may succeed while editing
remains blocked pending a separate local grant.

Exit: D4 clone/digest/read/membership cases pass; close/reopen proposal preserves
preconditions; tampered attribution/read sets/digests refuse; mixed candidate
definitions execute once; replay and lost-response retries produce no new effects.

## S6. Local grants, compatibility and file lifecycle

Desktop owns durable per-user grant storage outside `.nendo`; Engine consumes a
narrow typed grant authority, never a filesystem path exposed to formulas. Bind
grants to application ID, instance ID, behaviour digest, capabilities and contract
version. Initially include full definition revision conservatively, as the
experiment did. Document the resulting extra approvals. A later more selective
digest must include the transitive functions/formulas/schema bindings affecting
action meaning; it needs its own invalidation tests.

Use atomic replacement for the local grant file and fail closed for corrupt or
missing state. The prototype's `File.WriteAllText` grant was only a fixture.
Serialise revocation with the final authority check/commit so there is no unchecked
gap after checking consent. New writes must observe revoked authority immediately;
pending writes must recheck before commit. Do not use a cached Boolean approval.

Compute session capabilities explicitly: unfamiliar required automatic behaviour
allows inspection and bounded pure calculations, but normal editing is blocked.
Do not silently disable the trigger and save input. No action fires on open,
render, grant approval, restore or cache rebuild. Permanently disabling a trigger
is a reviewed definition change, not an emergency edit bypass.

Define lifecycle tests: Duplicate and Fork need fresh grants; Backup contains no
local grant; a matching previously approved restore may match local trust; changed
identity/behaviour requires review; newer unknown contracts use safe-mode rules.
If process interruption occurs after definition promotion and before local grant
persistence, reopen with definitions inspectable and editing blocked. The installed
definition must not be rolled back merely because grant persistence failed.

Exit: missing/mismatched/revoked/corrupt grants refuse editing across every write
route; inspection remains reachable; process-stop test and lifecycle cases pass.

## S7. Studio, surfaces, approval UX and draft recovery

Use the selected Molded Workbench reference in `docs/assets/mockups/molded-workbench/`.
Read the Studio and surface contracts. Preserve permanent Studio/recovery routes
and System/Light/Dark behaviour. No implementation jargon in ordinary user flows.

Add definition inspection/editing through canonical proposals; a field shows its
calculation/formula instead of an editable stored value. Show typed result/null/
pending/error distinctly, with readable field/function labels and diagnostic
context. Show blocked trigger conditions in successful outcomes separately from
selected-action failures. Dependants display dependency errors, never stale values.

Approval review identifies trigger events, affected entity types, action steps,
capabilities and exact changed behaviour. Consent is host-owned and tied to the
reviewed digest. Provide inspect, approve and revoke routes. MCP cannot press the
approval button or forge a session capability. Keep review keyboard accessible.

Fix the actual draft-loss bug in `main.ts`:

```text
runMutation catch currently calls recoverAfterWriteFailure() -> render()
then `if (client.pendingMutation !== undefined) render()` may rebuild again
the form's DOM and input listeners are lost even after confirmed validation refusal
```

Use existing outcome classification. On a confirmed rolled-back validation/action
refusal in the same editable file, preserve the form's draft and edited-field set,
update its error/outcome display, and avoid rebuilding the form from saved values.
If refreshing capabilities fails, retain the draft without claiming that editing
is authorised. On file switch, authority loss or read-only transition, disable
submission and offer safe draft retention/export; do not apply old input to a new
file. On unknown outcome, resolve the existing idempotency key; do not resubmit
under a new one. On confirmed success, normal refresh may proceed.

The prototype special-cased `data.setFields` validation in the catch and skipped
both renders. That proves the problem/repair direction, not a complete production
draft state model. Inspect `pendingMutation`'s actual API before using it; comparing
a function itself with undefined is not checking whether a mutation is pending.
Add Workbench DOM tests and `FormSaveOutcomeTests`/Desktop outcome tests for these
transitions, not just a string assertion against the source.

Run evaluation away from the UI thread. `async` alone does not move CPU work.
Cancellation requests must reach the actual bounded worker and the host must await
its completion. Keep native recovery independent of the calculation service.
Test the real same-process WinUI/WebView2 host, not a console or separate app:
UI ticks during work, cancel/join, forced limit error, draft retention at action
steps 1/2/precommit, native recovery, Workbench restart, Light and Dark captures.

Exit: matching results in Studio/custom surfaces, readable errors, approval/edit
capabilities, retained drafts and real host recovery. Record keyboard/focus and
screen-reader checks separately from automated DOM assertions.

## S8. MCP, all write routes, history and growth

Keep one machine-readable Engine catalogue: function IDs/aliases, parameter and
result types, null/error rules, resource costs, permissions, contract version and
compatibility. Publish it through the current vocabulary/discovery mechanisms and
use it for validation, editor help, examples and MCP authoring. No second hand-coded
MCP-only catalogue. Update tool/resource counts and closed-operation guards only
when the actual contract changes; do not weaken authority tests to admit a generic
invocation API.

Extend canonical authoring operations and proposal examples. An external agent
must be able to author two dependent calculated fields, one reusable function,
the project/task trigger and an explicit action using discovery alone. Agent work
produces a proposal; host acceptance and local consent remain host actions. Read
back the same typed calculations/errors over MCP without JavaScript rounding.

Trace every production write route to S4: direct native/Workbench field edit,
multi-field form, MCP data mutation, declared command, bounded paste, import and
proposal data. Search all `ApplyAsync`/`ApplyChangeSetAsync` callers. No adapter
may implement its own trigger engine or accidentally skip required behaviour.
Preserve each existing logical mutation's atomicity; do not silently expand a
batch import into unbounded per-row transactions or silently reset its budget.

Extend compensation over the entire causal revision. Replay proven inverses
together, suppress normal automatic triggers only with trusted internal replay,
and validate current state/preconditions. Refuse unsupported inverse chains;
retained backups do not make irreversible operations reversible. Definition
compensation that changes behaviour must also invalidate/recheck trust.

Finally prove the growth path: add one documented bounded pure function and one
read-only conditional-visibility consumer using this service/catalogue, with
tests. Visibility cannot conceal Studio or grant write authority. A network
function example must refuse. This is ADR 0008 P8, not permission for new custom
controls or arbitrary surface code.

Exit: all write-route tests, compensation/lifecycle/outcome tests, MCP round-trip
journey and growth test pass. Reconcile affected contracts and Help with what
actually shipped, not planned names.

## S9. Full release qualification and handoff

Use existing test projects and repository .NET skills. Current `global.json`
selects VSTest command mode and test projects reference MSTest. Reinspect these
before running; do not switch runners/frameworks. These commands are executable
from repository root (test files described above must have been implemented):

```powershell
dotnet test ./tests/Nendo.Engine.Tests/Nendo.Engine.Tests.csproj
dotnet test ./tests/Nendo.Desktop.Tests/Nendo.Desktop.Tests.csproj
dotnet test ./tests/Nendo.LocalMcp.Tests/Nendo.LocalMcp.Tests.csproj
npm --prefix ./src/Nendo.Workbench run check
npm --prefix ./src/Nendo.Workbench test
pwsh ./tools/Test-Repository.ps1
```

Run the narrow relevant command after each stage. For final integration use:

```powershell
pwsh ./tools/Test-Production.ps1
pwsh ./tools/Publish-NendoPayload.ps1
pwsh ./tools/Build-NendoInstaller.ps1
pwsh ./tools/Test-NendoInstaller.ps1
pwsh ./tools/Test-NendoSetupIsolated.ps1
```

The full production gate includes the repository gate; do not run it twice for
the same final validation. `-SkipRestore` is allowed only with unchanged restored
dependencies. Inspect installer script parameters/prerequisites before use.
Deliver Windows x64 `artifacts/installer/Nendo-Setup.exe` when rebuilding the app;
test setup in the task-owned isolated lane, never install/uninstall over an owner
installation. Do not equate package construction with installed-runtime testing.

Add a repeatable real-host behaviour journey to the existing owned-process runtime
tools. No prototype host scripts remain. The old hidden-window launch used a real
apphost, isolated file/device/WebView roots and actual WebView DOM assertions;
process existence or a screenshot alone did not establish the checks.

Measure cold/warm calculations, related reads, save/action chains, allocation and
joined cancellation on modest and larger fixtures. Publish supported limits and
exceptions in the production contract/roadmap. Do not extrapolate the old 3-record
prototype timing to large-file responsiveness. Keep verbose logs in task scratch;
retain tests, concise findings and the updated checklist in Git.

### Release completion checklist

| ADR obligation | Required production evidence | Stage |
| --- | --- | --- |
| P1 | Agent authors calculations/function, host accepts, Studio edits, surface/MCP agree, rename/reopen offline | S1–S3, S7–S8 |
| P2 | Related create/delete/update/reassignment, both parents, static/runtime cycles, no partial totals | S3–S4 |
| P3 | Zero denominator saves input/error, blocked condition shown, correction recovers; selected action error rolls back | S3–S4, S7 |
| P4 | Every entry/import/command/MCP/proposal route shares staging/order/no-op/budget/permissions | S4, S8 |
| P5 | Missing grant inspect/block, approve/edit/revoke, copy/restore/newer/malformed semantics and recovery | S1, S6–S7 |
| P6 | Causal attribution, same-key retries, response loss, safe compensation, old/new host compatibility | S4–S6, S8 |
| P7 | Keyboard/focus/screen-reader review, Light/Dark, latency/memory/cancellation/recovery on larger fixtures | S7, S9 |
| P8 | New pure function + conditional visibility use same engine/catalogue; network negative example | S8 |

Report restore, build, tests, real-host runtime, human usability/accessibility,
packaging and isolated setup outcomes separately. Any skipped required lane stays
pending. Do not mark P7 delivered just because the Engine tests or original
acceptance experiment passed.

## Stop conditions and prohibited shortcuts

- Numeric intermediate becomes binary float, scalar semantics change, or a parser/
  worker survives cancellation: stop affected delivery, retain reproduction and
  reopen the runtime decision. Do not swap evaluator or add a service process.
- Trigger failure leaves any committed initiating/generated effect: stop all
  exposure of the write path until the single-transaction regression passes.
- Proposal plan/read preconditions are rebuilt at acceptance, or triggers run
  during replay: fix before enabling promotion.
- Missing approval permits an edit by disabling required triggers, or a file/MCP
  request can grant approval: fix the authority boundary before release.
- Studio unavailable under errors/untrusted definitions: recovery is a required
  product invariant, not a follow-up improvement.
- Source moved or a patch anchor is absent: trace the current architecture;
  never resurrect copied Engine sources or add a parallel store to avoid it.

## Documentation and prototype cleanup

The owner requested retiring the disposable suite after transferring knowledge.
Only this plan, semantics, regression specifications, concise historical evidence
and the dependency-resolution reference remain. They are not executable tests.
The prototype directory and its generated Engine/host/build/profile/fixture output
are removed. Production source was not changed by this documentation task.
Recreate the specified checks in normal test projects during S1–S9; acceptance
history is not a substitute for those checks.
