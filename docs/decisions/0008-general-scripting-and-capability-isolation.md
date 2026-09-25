# ADR-0008: Add calculations, local actions and automatic triggers

- **Status:** Accepted
- **Date:** 2026-09-12
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** Owner decisions and authorised follow-up on 2026-09-12; repository contracts; matching NCalc 7.1.0 source; [D1–D4 acceptance experiments](../design/adr-0008-evidence.md). The final complete run passed 70 console cases and the isolated WinUI/WebView2 host exercise. The subsequent host run also passed editor preservation after both action steps and before commit. The narrow adapter fixes the original four integer-division failures before intermediate precision is lost. Confidence covers the bounded design, not production delivery.
- **Depends on:** ADR-0003, ADR-0004, ADR-0005, ADR-0006, ADR-0007, ADR-0009 and ADR-0012.
- **Related design:** [Architecture](../architecture.md), [scalar contract](../contracts/scalars.md), [semantic surfaces](../contracts/semantic-surfaces.md), [ADR-0013](0013-custom-views-with-code-in-the-file.md).

### Accepted amendment — 2026-09-20 (an optional result is quietly empty, and a formula can refuse by name)

The owner accepted both parts of this amendment on 2026-09-20, the day that it was
proposed for W-032. The owner based the acceptance on what the planner showed every
day after its setup on 2026-09-15.

**What is wrong.** Nine of the planner's fifty-three work items have no value or
effort rating, because nobody has set one. Their *Value per effort* field shows
*Cannot calculate* with "A value this formula needs is empty" beside it. The
contract works as written: an empty value used as an operand is
`calculation-missing-input`. But the sentence is wrong. Nothing failed, and the
person who left a rating blank did so intentionally. The field was declared to
allow an empty result (`resultNullable: true`), and both its inputs were declared
optional (`nullable: true`). These declarations do not change what the reader sees.

Also, an author cannot write the formula differently. The language has no test for
empty, no empty literal and no way to say "then leave it blank". The same function
guards its 1–5 scale with `0 / 0`. It uses a division error because there is no
way to refuse by name.

**Options considered.**

- *A. The declaration decides — selected.* If a calculation or function is declared
  to allow an empty result, and an empty input stops its formula, it yields
  **empty** and not an error. If it is declared always to produce a value, it keeps
  `calculation-missing-input`. It now also reports that error when its formula ends
  empty. Thus the host honours the declaration in both directions. This option adds
  no new syntax and no new catalogue entry. The two flags that authors already
  write get the meaning that a reader expects from them.
- *B. A test and a literal — deferred.* `IsEmpty(x)` and an `Empty` name typed from
  context, so that a formula can say `IsEmpty(effort) ? Empty : value / effort`.
  This option is more expressive and adds more vocabulary. Every optional formula,
  including this planner's, would need new authoring to get the blank result that
  it already requested. This option stays as the revisit trigger below, for when a
  formula needs to tell an empty from a value inside itself.
- *C. Empties propagate everywhere — rejected.* This is SQL's rule: any empty
  operand makes the result empty. It is the simplest to build, but it hides
  mistakes. A required input that is unexpectedly empty would show a blank and not
  an error. That blank is a number that nobody computed, which section 6 exists to
  prevent.
- *D. Show the error more gently — rejected.* Render `calculation-missing-input` as
  *Not set* in the Workbench only. The MCP read, an export and a future host would
  still carry an error. A reader of any of them would be told that something
  failed.

**Decision, part one: an optional result is quietly empty.** The contract said that
an empty value used as an operand produces `calculation-missing-input`. It now says
that the operand stops the formula, and the declaration decides what the host
reports:

- A calculation with `resultNullable: true` reports an **empty** of its result
  type.
- A calculation with `resultNullable: false` reports `calculation-missing-input`,
  as today.

The same rule applies to a reusable function at its call. If an empty argument
stops a function whose result may be empty, the function returns empty to its
caller. The caller's own declaration then decides what the caller reports. If a
formula ends empty in a definition declared never to be empty, the result is also
`calculation-missing-input`. The result is never zero, never false and never a
previous result: section 4 and section 6 stand. The branch not taken is still never
evaluated. A dependant of an empty result reads a typed empty, as today.
`calculation-dependency-failed` is still reserved for a dependency that *errored*.

**Decision, part two: a formula can refuse by name.** The amendment adds one
catalogue entry, `Refuse(text)`. It produces no value and reports
`calculation-refused`, which carries the author's own sentence. It is total in the
same sense as every entry: the same inputs always give the same outcome. It has no
clock, file or network. It stands in for a value of the kind that the enclosing
formula produces, so it can be in either outcome of a choice. Validation refuses a
formula that is only a refusal, and a refusal outside a choice, because a
calculation that can never answer is a definition error.

The planner's guard becomes `… ? value / effort : Refuse('Ratings are 1 to 5.')`.
The reader then sees that sentence, and not a report that something was divided by
zero. For agents, the catalogue publishes the entry at
`nendo://application/vocabulary`, as it published `TextLength` (P8). Nothing else
needs to change.

**What this is not.** The amendment adds no null literal, no test for empty and no
three-valued logic. `empty and false` stops the formula; it does not answer false.
The amendment does not change what is stored, staged or replayed. It is not a new
execution contract version. `behaviour-1` keeps its name, because no stored body
changes shape, and a definition means what its own declarations say.

One case reads differently: a definition that was declared never to be empty and
ended empty anyway. It now reports an error where it showed a blank. No definition
in the planner does that, and a file that does it was mis-declared. The amendment
raises no minimum host version. An older host shows an error where a newer host
shows a blank. An older host also refuses `Refuse` at validation as an unknown
function. That is the ordinary behaviour of a host that lacks a catalogue entry.

**Evidence obligations before this entry is marked Accepted.**

*Note, 2026-09-22: the owner accepted this amendment on 2026-09-20. The list below is the record of what the acceptance required. `BehaviourScalarTests` D1_18 to D1_22 carry the automated obligations.*

- `BehaviourScalarTests`:
  - an empty operand under a nullable result is a typed empty;
  - an empty operand under a non-nullable result is `calculation-missing-input`
    (D1_15 and D1_16 stand);
  - if a nullable function returns empty into a non-nullable caller, the error is
    the caller's;
  - `Refuse` reports `calculation-refused` with the author's text, can be in either
    outcome of a choice, and is refused at validation on its own.

  Falsify each guard against the old evaluator, and quote the failure text in the
  Check.
- The planner: *Value per effort* reads *Not set* for the nine unrated items,
  without a change to the file. After the owner accepts a change set that replaces
  `0 / 0` with `Refuse`, an out-of-scale rating reads the author's sentence.
  Owner-reported.
- [`docs/contracts/calculations-and-actions.md`](../contracts/calculations-and-actions.md)
  states the rule under *Values, empties and errors* and lists `Refuse` in the
  catalogue. The Workbench help states which state a blank rating produces. The
  blackbox prompt reaches both.

**Consequences.** A reader sees a blank where somebody left a blank, and a sentence
where an author wrote one. Before, both were errors. If an author wants a missing
input to be an error, the author declares the result non-nullable. That
declaration already has this meaning. The revisit trigger: when a formula needs to tell
an empty from a value inside itself (a default, a fallback, a count of the missing
values), option B is the next step. Option B composes with this rule and does not
replace it.

## Context

Nendo stores an application in a local `.nendo` file. The installed host supplies storage, Studio, validation and recovery. Applications can already contain semantic surfaces and bounded declarative commands. General expressions and scripting remain outside the accepted production scope. [R1–R4]

The next step must let people and agents add calculations without a change to the host for each application. Calculations should update when their inputs change. Excel is a reference for this experience. It is not a requirement for syntax or file compatibility.

The application also needs explicit commands and automatic actions. These can change related records. They must not bypass the host's write authority, history or recovery rules.

The owner selected these requirements during design:

- Start with calculated fields and reusable functions. A calculated field has one formula for its record type. Individual cell formulas can follow later.
- Prefer simple architecture, the current technology stack and existing libraries. Do not build an Excel-compatible language.
- Design for calculations within a record and across related records. Same-record calculations can be the first delivery slice.
- Save otherwise valid input when a calculation fails. Show the error in the calculated field.
- Include automatic triggers in the initial implementation. Do not restrict the first release to buttons.
- Commit an initiating edit and its local trigger actions together. A failed required action cancels the whole transaction.
- Require local approval before a person edits a file with unfamiliar automatic actions. Inspection remains available before approval.
- Permit further use cases as people use Nendo. Do not make each additional function a new architecture project.

This ADR covers bounded application behaviour. It does not create a general plug-in platform. ADR-0013 remains responsible for third-party packages, custom controls and broader extension concerns. [R4]

## Decision drivers

1. Make calculations and automatic behaviour useful in ordinary local applications.
2. Keep one host-owned execution and write path.
3. Preserve numeric fidelity and stable field identities.
4. Keep normal input usable when a calculation fails.
5. Keep automatic changes atomic, attributable and bounded.
6. Preserve Studio when application behaviour fails or lacks approval.
7. Add use cases without a second language or runtime unless evidence requires one.
8. Select the runtime from integration evidence, not from a library feature list.

## Options considered

### A. Existing .NET expressions with host-owned actions — selected

Use an existing expression evaluator for calculations and conditions. Store application functions as expression bodies. Represent actions as bounded steps that request typed host operations.

The project selects NCalc 7.1.0 behind the typed adapter that D1–D4 demonstrated. Decimal configuration alone is insufficient: division must intercept typed operands before NCalc's integer-to-Double path. Nendo still supplies dependency tracking, application functions, permissions and action execution. [E1–E3]

This option avoids a custom parser and a general programming runtime. Its main risk is whether the selected library can satisfy numeric and resource limits with a small adapter.

### B. General C# or JavaScript scripting from the start

This option would give broader programming freedom. It would also require a wider execution contract before the first calculated field could ship.

Compiled code, exposed objects, arbitrary loops and external effects create additional isolation questions. Nobody has measured their integration cost. Defer this option unless a real use case cannot fit option A.

### C. A Nendo-specific expression language

This option would give Nendo direct control over syntax and execution. It would also make the project responsible for parsing, diagnostics and language maintenance.

Do not take this route while an existing library can meet the requirements at lower cost. Small checks around a library are acceptable. A replacement language is not the default fallback.

### D. Continue with fixed declarative commands only

This option preserves the current boundary. It does not provide reusable application formulas or the automatic behaviour that the owner requested.

Retain existing commands for compatibility. Do not treat them as the permanent limit of application behaviour.

## Decision

### 1. Status and scope

Option A is accepted for the restricted vocabulary and host-owned action model. The experimental adapter uses NCalc 7.1.0's parser and evaluator, a typed allow-list, decimal division interception and shared resource accounting. It is not an arbitrary-code sandbox.

The decision evidence below supports production implementation under this ADR. Only disposable experiments were delivered. After their transfer into the [standalone implementation plan](../design/adr-0008-implementation-plan.md), the owner requested their removal. Acceptance introduces no production scripting dependency, public API, storage contract, MCP authoring capability or installer. The [preserved execution semantics](../design/adr-0008-semantics.md) record tested rules and limits. Stable production contracts and P1–P8 checks remain required. [R5]

*Note, 2026-09-22: the paragraph above records the state at acceptance. Production delivery followed. The [implementation plan](../design/adr-0008-implementation-plan.md) records stages S0–S9 as carried out. NCalc 7.1.0 is now a production dependency of `Nendo.Engine` only, behind the typed adapter in `Nendo.Engine/Behaviour/`. [calculations-and-actions.md](../contracts/calculations-and-actions.md) is the stable contract, and it maps each obligation P1–P8 to its tests. The human half of P7 is owner-reported.*

The initial implementation includes calculated fields, reusable expression functions, explicit commands and automatic record triggers. It includes the local approval and failure rules in this ADR.

Same-record calculations may ship as an internal development slice. Automatic triggers must not be removed from the first complete P7 delivery without an explicit scope decision.

Design and test related-record dependencies in the same model. Prove the model with a bounded related-record total and a trigger that changes a related record. Broader aggregate functions can follow.

### 2. One service in the existing Engine

Add one host-owned behaviour service within `Nendo.Engine`. Keep the library behind a narrow adapter. Do not add a service process, general workflow engine or interchangeable-provider framework by default.

The expression evaluator receives typed values and approved pure functions. It does not receive application-service objects, database connections or callbacks with general write authority.

The host resolves record bindings and related-record queries. The action executor converts accepted steps into canonical typed operations. The existing write coordinator remains the only path to active writes.

Studio, custom surfaces and MCP use these same services. The Workbench displays results and diagnostics. It must not maintain a second calculation engine.

The conceptual execution path is:

```text
Typed request
    → host authority and input checks
    → expressions and bounded local action plan
    → canonical operations
    → existing write coordinator and storage
    → result, history and refreshed calculations
```

This path is a responsibility boundary. It does not require new projects or public interfaces.

### 3. Definitions belong to the application

Store formula, function, action and trigger definitions in protected application metadata. Change them through canonical definition operations and proposal review.

Use stable IDs for definitions, fields and relationships. Display names are labels. A rename must not break a binding.

Store expression text and an explicit map from expression parameters to semantic IDs. Store reusable functions with stable IDs, named parameters, declared result types and expression bodies.

Do not make a library's serialised parse tree the durable file format. The host can rebuild parsed expressions from the versioned definition.

Store a calculation-contract version with the definitions. Record the required host capability through the existing `minimumHostVersion` mechanism. A library package version is not a substitute for this contract.

The first version has no per-record formula override. People edit the inputs of a calculated field, not its result. A future cell-formula feature needs explicit override and dependency rules.

### 4. Calculation results and numeric rules

A calculated field produces a typed value, null or a calculation error. Null and error are different results.

Treat calculated results as derived values. Start with evaluation on demand and bounded host caches. Do not store them as independent user edits, and do not generate a revision for each recalculation.

Return the same result semantics through Studio, custom surfaces and MCP. An out-of-date cached result must not appear as current. A pending calculation has an explicit pending state.

Preserve the scalar contract for signed 64-bit integers, .NET decimal values, text, dates and other supported types. Numeric user values must not pass through JavaScript numbers. [R2]

Use checked numeric operations and explicit result types. Do not silently convert decimal calculations to binary floating point. Do not coerce missing values, empty text or booleans into numbers.

Arithmetic results are not always mathematically exact within the decimal domain. The experimental calculation contract defines division, scale reduction, rounding and overflow. Production must retain these semantics in its stable contract. Test boundary values, not only ordinary prices.

The proposed default is documented .NET decimal arithmetic with explicit rounding functions. Do not force every result to two decimal places. Do not describe rounded arithmetic as exact storage arithmetic.

Expose only functions whose numeric behaviour meets the contract. The library's complete built-in function catalogue is not automatically Nendo's catalogue.

Use invariant expression parsing and explicit date rules. Local formatting belongs to presentation. A function must not change meaning with the Windows language setting.

The initial functions are pure. They receive inputs and return results. They cannot read the network, read files, modify records or call a general host method.

A reusable function can call another approved expression function. Reject recursive function definitions. Bind dependencies through explicit parameters, not through hidden global record access.

### 5. Dependencies within and across records

Track dependencies between calculated fields. Evaluate prerequisites before their dependants. Reject static cycles when the definition is validated. Detect data-dependent cycles during evaluation.

A binding can refer to a field in the same record, a field reached through a declared relationship, or a bounded aggregate of related records.

Related queries use stable relationship and field IDs. Expressions cannot create SQL or resolve field names through arbitrary strings.

A related aggregate depends on collection membership as well as on the current values. Creation, deletion and reassignment can change the result. If a line moves between orders, both order totals must become invalid.

Use the same dependency model for calculation results, action conditions and action inputs. In a transaction, evaluations see the current staged record state, including earlier action steps.

Start with conservative invalidation where that is simpler. For example, a data revision can invalidate a related-query cache. Do not build fine-grained incremental indexes before measurements justify them.

Automatic recalculation does not require the host to recompute every result on every save. It requires each requested result to reflect its input snapshot. Visible results must refresh after relevant changes.

In the initial contract, a change to a calculated result does not itself create a record-update event. Subscribe triggers to the underlying record events. This prevents a display refresh from becoming a write trigger.

If a query asks for all records, do not silently sort or filter only the visible page. Either implement a bounded complete calculation query, or refuse the unsupported operation clearly.

### 6. Calculation errors do not block valid input

Save input that passes ordinary field, record and storage checks. If a calculation fails, show the error in its calculated field.

Do not substitute zero, empty text or a previous result. A dependent calculation reports a dependency error. A later input or definition change causes a new evaluation.

Reject invalid formula definitions before acceptance. An unknown function or a broken field binding is a definition error. It is not a reason to install a broken formula.

Errors caused by actual record values remain possible after definition validation. Examples include division by zero, overflow and a missing required calculation input.

If a trigger condition depends on an errored calculation, mark the condition **blocked**. It selects no action. The otherwise valid initiating edit can still commit. Show the blocked trigger in the operation outcome.

Blocked is not false and is not success. Do not queue an invisible retry. A later subscribed event can evaluate the condition again.

If a condition selects an action and an action input then fails to evaluate, that failure is an action failure. It cancels the transaction. An explicit validation rule can also require a valid calculation and refuse a save.

This distinction is intentional. A trigger condition must not act as an unstated data-integrity constraint.

### 7. Explicit commands and automatic triggers

An action is an ordered set of bounded steps. Each step requests an allowed local data operation. Conditions and input expressions use the same expression service as calculated fields.

Initially, support record creation, field updates and record deletion through existing typed operations. Related targets must come from declared, bounded relationships or query bindings.

The initial events are record creation, record update and record deletion. Update triggers can select relevant stored fields. Give each event typed before and after values. For creation or deletion, one side is absent.

Emit events at the logical mutation boundary. A multi-field form save must not expose an accidental sequence of half-edited forms to triggers. Stage the initiating batch before you process its event queue.

Use a documented event order and a stable trigger order. Do not use dictionary iteration, thread scheduling or handler registration order as application semantics.

Actions can cause further record events in the same transaction. Process these events through a bounded queue. A field assignment that changes no value creates no update event.

Do not execute actions only because a file opens, a screen renders or a calculation is read. Enabling or changing a trigger does not replay past events.

A completion rule can subscribe to task updates, inspect the project's tasks and update the project. It must not depend on a background scheduler or a calculated-field display event.

### 8. One atomic local transaction

The initiating edit and its selected local trigger chain share one coordinator-owned transaction. Commit only when all selected actions and required checks succeed.

An action failure, authority failure, user cancellation or trigger-chain limit violation cancels the entire transaction. This includes changes to related records.

Preserve unsaved human input after refusal. State which trigger or step failed. Do not report a successful save when its transaction was cancelled.

Calculation-only errors and blocked conditions follow section 6. They are not selected action failures.

Every generated write must use normal data validation. A trigger must not obtain schema, identity, file-lifecycle or permission-changing authority through its data action.

Keep existing revision rules and per-record versions. Attribute generated operations to the initiating request and the exact trigger/action definitions. Do not add a second commit log.

The initiating idempotency key covers the complete causal transaction. Store its receipt with the commit. A retry after commit returns the recorded outcome and does not execute the triggers again.

Freeze any host-supplied action time and generated IDs for a prepared operation plan. Replay must use the recorded values, not a new clock reading or a new ID.

After a successful commit, a failed screen refresh must not be reported as a failed data transaction. The durable receipt remains authoritative.

### 9. Resource limits and capability isolation

Use an allow-list for expression constructs, functions, event kinds and action steps. Unknown entries fail closed.

Do not expose reflection, assemblies, arbitrary objects, SQL, database paths, filesystem operations, network operations, process creation or dynamic code execution.

Do not accept a delegate, plug-in package or binary supplied by a `.nendo` file. A stored reusable function is an expression definition, not compiled .NET code.

Bound source length before parsing. Also bound parse depth, evaluation work, function calls, related records scanned, output size, cache size and trigger-generated changes.

Apply one shared work budget to an execution chain. A nested function or trigger must not reset it. Limit repeated record changes even when each individual expression is small.

Use cancellation, but do not treat a timeout token as proof that work stops. NCalc's documentation requires custom handlers to honour cancellation and does not promise general forced termination. [E4]

The accepted design uses in-process evaluation of the restricted language. This design is not a sandbox for arbitrary code. It gives no protection against another process that runs as the same OS user.

D2 establishes bounded cost for the tested restricted language and host functions. It does this through parser/visitor source inspection, finite ceilings, boundary workloads, allocations and joined cancellation. Keep evaluation off the UI thread. A wider vocabulary or wider limits require new evidence.

The small adapter must keep this integration within these bounds. If only a substantial replacement interpreter can keep it within them, stop and reopen the decision. Neither another evaluator nor a process boundary is an automatic fallback. Do not silently broaden production authority.

Studio's inspection and recovery routes must remain usable when calculations are disabled. Opening an unfamiliar file must not force the host to run uncontrolled logic.

### 10. Local trust and first use

Opening a file does not approve its actions. A received file cannot contain a grant that makes itself trusted.

Before approval, Studio can inspect the file, its data and its behaviour definitions. Bounded pure calculations can run under the same enforced limits. They have no authority to change records.

If required automatic behaviour is not approved, normal edits remain unavailable. Do not silently save records while the application's required triggers are disabled.

The host presents the actions, trigger events, affected record types and requested local permissions. The person approves the reviewed behaviour once, not once for each execution.

Accepting a proposal can also approve its exact behaviour definitions. This must be explicit in the host review. MCP cannot grant approval or promote its own proposal.

*Note, 2026-09-22: the [ADR-0009 amendment](0009-local-mcp-transport-authority-and-change-sets.md) of this date adds a fifth access level, Unattended. At that level only, `nendo.change_set.accept` promotes a proposal that the same session validated, and the host records this device's approval for the actions that it installs. Below Unattended, the sentence above still applies.*

Store approval in local host state. Bind it to application identity, instance identity, a behaviour digest and the granted capabilities. Include the execution-contract version in that binding.

*Note, 2026-09-22: the production grant (`NendoBehaviourGrant`) also binds the definition revision. Thus any definition change asks the owner again, including a change that alters no rule.*

The behaviour digest covers actions, triggers, and the functions, formulas and schema bindings that affect their meaning. An ordinary record edit does not change the grant. A behaviour change requires review.

A copied file does not carry local approval to another device or person. Duplicate and Fork produce identities that require their own grant. A matching previously approved restore need not prompt again.

Review acceptance and local approval are separate storage operations. If the host stops between them, use the safer state: the definition can be installed while editing remains blocked until approval.

The person can revoke approval at any time. Refuse new writes after revocation. Check approval again before commit. An in-flight operation must not commit under a revoked grant.

Emergency suspension makes normal editing unavailable. Permanently disabling a trigger is a reviewed definition change. Its consequences must be visible. It must not become a hidden bypass for required behaviour.

### 11. Proposal validation and replay

Preserve ADR-0007: validate on a physical clone, and promote by replaying the exact reviewed operations. Do not swap in the clone. [R3]

For a proposal that contains record edits, expand applicable trigger effects on the clone under the candidate definition. Include every generated operation in the reviewed plan, digest and diff.

Use the same definition/data ordering and action planner for validation and active execution. A definition-only proposal creates no record events and performs no implicit historical backfill.

Promotion checks the definition, execution contract, approvals and data preconditions. It then applies the already expanded canonical operations. It must not discover or execute additional trigger effects during replay.

Only trusted internal replay can suppress trigger expansion. Do not expose a skip-trigger flag through Studio editing, MCP or application actions.

Capture every record read to determine an action, not only records that will be written. Related queries also need a membership precondition.

A new matching record can change an aggregate without a change to any previously read record version. The first implementation may conservatively require an unchanged data revision for such queries.

Reject a stale proposal and prepare it again. Do not silently recompute a different action plan during acceptance.

Accepting new behaviour does not prove that every possible future action will succeed. Runtime validation and transaction rollback still apply on each execution.

### 12. History, compensation and file lifecycle

History must identify the initiating edit, the executed triggers and their generated operations. Successful operation outcomes must also show blocked trigger conditions, where present.

A rolled-back attempt is not a successful data revision. Report its failure through the existing outcome or diagnostic mechanism. Do not insert an application record only to log a failed transaction.

Treat compensation as a host-owned operation over the causal change. Apply proven inverse operations together, or refuse compensation. Do not repeat normal automatic actions while you replay those inverses.

Validate the resulting state and current preconditions. A retained backup does not make an irreversible operation reversible. Do not promise universal undo. [R6]

Restore, reopen and cache rebuild do not emit ordinary record events. Recalculate derived values as needed, but do not run historical actions again.

Unknown execution contracts follow existing compatibility and safe-mode rules. Expose unaffected data only where the host can do so safely. Do not claim writable preservation of unknown semantics. [R7]

### 13. Growth without a new platform

Add an ordinary function, bounded action or event under this ADR when it preserves the existing authority and failure rules. Publish its contract and tests with the change.

Maintain one machine-readable catalogue for accepted functions and behaviour features. Use it for validation, MCP discovery, editor help and examples. Do not require an agent to discover limits by repeated failure.

New catalogue entries need types, null/error rules, resource costs, permissions and compatibility information. A capability must be discoverable before an author can rely on it.

The expression service can later support field visibility, section visibility, validation conditions and command availability. These are read-only uses. They do not grant permission to inject HTML or replace Studio.

Repeated groups, new layout nodes and custom UI controls still require the relevant semantic-surface or extension decision. Do not hide these changes inside a function registration.

External services, file access, timers, background execution and arbitrary code remain outside the initial authority. External effects cannot share the local transaction's rollback guarantee.

Before you add external effects, define durable intent, retries, idempotency, credentials, consent and recovery. That requires an additional architecture decision. The first local implementation requires no such machinery.

A runtime update must pass the existing semantic test suite. A change in meaning needs an explicit contract change and compatibility review. Never reinterpret stored formulas silently.

## Evidence and validation obligations

The [historical D1–D4 report](../design/adr-0008-evidence.md), the cases executed at that time, the pinned dependency graph and the working-source hashes support acceptance. The initial raw configuration failed integer division, including a comparison result. The owner authorised a follow-up. The 272-line adapter fixed division before conversion, and the remaining experiments passed. Later, at the owner's request, the findings moved into documentation, and the disposable code and runners were removed. The [regression specifications](../design/adr-0008-regressions.md) retain the exact numeric failure oracles and the D1–D4 cases to recreate as production tests. This ADR makes no claim of a current rerunnable prototype.

D1 passed typed scalar, arithmetic, function and rejection cases. D2 passed bounded parsing/evaluation, cache, allocation, related-scan/action and cancellation checks. The real isolated host remained responsive and reached native recovery. D3 used real SQLite/coordinator transactions, causal receipts and a real multi-field editor rollback. D4 used physical clones, exact replay, read-record/membership preconditions and local grants, including process interruption after definition promotion.

The host experiment required a disposable Workbench fix to retain the form after a validation refusal. Production must port and test that behaviour. The fixture's protected definition storage, read-set carrier and grant JSON are experimental. Acceptance does not make them stable formats. All production release checks below remain pending.

*Note, 2026-09-22: this paragraph records the state at acceptance. [calculations-and-actions.md](../contracts/calculations-and-actions.md) records the current evidence for P1–P8.*

### Decision evidence required before acceptance

**D1 — Runtime fit and numeric behaviour.** Test one pinned NCalc build against the repository's pinned .NET SDK. Record the package identity, licence, dependency set and adapter size. Test Int64 limits, decimal scale 28, rounding, overflow, division by zero, nulls, dates and lazy branches. Refuse unintended binary floating-point conversion.

**D2 — Resource containment.** Test oversized and deeply nested input, repeated function calls, cycles, large strings and costly related queries. Set measured finite budgets. Prove that limit failures return control without active writes or loss of Studio. A test that only stops awaiting a still-running task does not pass.

**D3 — Trigger transaction.** Create a project with related tasks. Complete one task and run a related-project action. Inject failure at each step. Assert complete rollback, preserved unsaved input and no successful receipt. Then test a successful chain and retry its idempotency key. No effect may occur twice.

**D4 — Proposal equivalence and trust.** Expand a trigger chain on a real clone. Compare the reviewed and committed canonical operations. Insert a new related record before acceptance. The stale aggregate-dependent proposal must refuse. Test trust revocation, digest changes and a stop between promotion and grant persistence.

Use disposable experiments for these decisions. Record exact commands, expected results and observed results. Move the lasting checks into normal test suites when production work begins.

Do not accept the runtime or in-process isolation choice while a decision-critical failure is unresolved. A new candidate must pass the same tests.

### Production implementation and release checks

**P1 — Calculation journey.** Create inputs, two dependent calculated fields and a reusable function through MCP. Accept the proposal in the host. Edit input in Studio. Confirm matching results in a custom surface and through MCP. Rename fields and reopen offline. Bindings and results must remain valid.

**P2 — Related-record journey.** Test create, delete, update and reassignment of related records. Both former and new parents must show current totals. Reject static cycles and show runtime cycles as errors. Never return a partial aggregate as complete.

**P3 — Error semantics.** Save a valid zero denominator and show a calculation error. Verify dependent errors and a visibly blocked trigger condition. Correct the input and recover. Separately, force an action-input error. The complete initiating transaction must roll back.

**P4 — All write routes.** Exercise native entry, multi-field forms, MCP, bounded paste and import. Use the same trigger semantics. Verify before/after values, no-op suppression, deterministic order, recursion limits and permissions on generated writes.

**P5 — Approval and recovery.** Open a file without a local grant. Verify inspection, bounded calculations, blocked editing and no open-trigger effects. Approve once, edit, revoke and retry. Test Duplicate, Fork, Backup, Restore and malformed or newer behaviour definitions.

**P6 — History and compatibility.** Check causal attribution, repeated requests, post-commit response loss and bounded compensation. Confirm that replay does not run triggers twice. Test old files without formulas and old-host refusal for new contracts.

**P7 — Human use and performance.** Test keyboard review, readable errors, field labels and screen-reader announcements. Measure calculation latency, save latency, memory and recovery on modest and larger fixtures. Publish the chosen budgets and any accepted exceptions. Do not turn owner-reported use into an automated pass.

**P8 — Growth test.** Add one new pure function and one conditional-visibility consumer without another evaluator or write path. Add a documented negative example for network access. The host must refuse it rather than expose a generic invocation escape.

The first complete P7 delivery must include automatic triggers and local approval. An internal calculation-only slice does not satisfy that release scope.

### Required companion documentation

Link ADR-0008 as **Accepted** in the decision index. It covers restricted expressions and local actions. It does not cover a completed extension platform.

ADR-0013's History preserves its original deferral and scheduling. ADR-0013 itself states the current extension scope: custom views whose code lives in the file.

In the same architecture change, update the architecture overview and the scalar, read, MCP, operation-outcome and surface contracts where behaviour changes. Define the new calculation/action contract before its code is treated as stable.

Exact DTO names, storage layout, function catalogue, numeric policies and measured budgets belong in those contracts. They must satisfy this ADR. They must not silently redefine it.

## Consequences

### Positive

People can add useful calculations and local automation without a generated project. People and agents use one set of definitions and host services.

Pure calculation errors remain visible, and otherwise valid work is not lost. Selected local actions remain atomic and attributable.

The design supports related records and automatic triggers from the start. It leaves room for dynamic screens and further functions without a general extension framework.

Local approval protects the boundary between inspection and automatic writes. Studio remains available without trust in application behaviour.

### Negative

Nendo must implement dependency tracking, trigger planning and local grants. An expression library does not supply these application semantics.

Trigger chains can increase save latency. Resource limits can refuse legitimate but large operations. Conservative related-query checks can make proposals stale more often.

In-process library defects remain a host risk. Bounded-language tests do not establish protection against arbitrary malicious native code.

A blocked condition can permit a save without an optional automatic action. If an application needs a strict invariant, it must express a validation rule explicitly.

Users must understand why a received file is inspectable but not editable. Formula errors and action errors need different explanations.

External integration, arbitrary code and third-party UI controls remain unavailable under the initial contract.

## Rejected alternatives

These are scope exclusions. They are not claims of a measured comparison with other runtimes.

Do not build Excel syntax compatibility. The owner gave implementation simplicity priority over formula notation.

Do not postpone all automatic triggers. The owner explicitly included them in the initial implementation.

Do not silently disable required triggers and permit normal editing. That would change application meaning without a visible decision.

Do not keep half of a selected local trigger chain after failure. The owner selected an atomic transaction.

Do not give formulas write authority or general .NET objects. That would remove the calculation/action boundary.

Do not replace the active file with a proposal clone, and do not run scripts again during replay. Preserve the reviewed operation plan.

Do not select a general scripting runtime only because it supports more syntax. Select additional machinery only when an observed use case requires it.

## Revisit triggers

Revisit this ADR when a real application needs arbitrary control flow, recursion, per-cell formulas or capabilities that the bounded model cannot express.

Revisit the isolation decision if the selected evaluator cannot meet the execution budgets, or if untrusted-file tests can stop Studio.

Revisit dependency and transaction policy if related-record scans or trigger chains exceed the intended local workload.

Revisit approval design if people cannot understand grants, revocation or changed behaviour. Do not solve prompt fatigue by trusting a flag inside the file.

Create an additional decision before external effects, background work, third-party controls, collaboration or a second runtime enters scope.

## References and evidence status

Repository baseline: `ThomasRohde/nendo` at commit `4f279d0e7be98e01e687288eb22b46e908adec4b` (11 September 2026). Reviewed on 12 September 2026. The owner choices above are requirements, not executable evidence.

- **R1:** [Vision](../vision.md) and [architecture](../architecture.md). Current product boundary and component responsibilities.
- **R2:** [Scalar fidelity contract](../contracts/scalars.md). Existing numeric storage and transport requirements.
- **R3:** [ADR-0007](0007-proposal-clone-validation-and-replay-promotion.md). Physical clone validation and exact operation replay.
- **R4:** [ADR-0013](0013-custom-views-with-code-in-the-file.md). Scheduled extensions and outstanding authority requirements.
- **R5:** [ADR-0000](0000-record-architecture-decisions.md) and [ADR template](template.md). Proposed status and evidence requirements.
- **R6:** [ADR-0006](0006-split-revisions-audit-and-compensation.md). Revision and compensation boundaries.
- **R7:** [ADR-0012](0012-safe-mode-compatibility-and-migration.md). Safe-mode and compatibility rules.
- **Repository snapshot:** the private working tree at commit `4f279d0e` on
  11 September 2026. That commit is not reachable from the public history,
  which starts at a single root. This ADR states the review's findings above.
- **E1:** [NCalc project](https://github.com/ncalc/ncalc). Expression evaluator and integration surface.
- **E2:** [NCalc configuration](https://ncalc.gumbarros.com.br/articles/evaluation/configuration.html). Decimal and overflow configuration. These options alone do not establish Nendo numeric conformance.
- **E3:** [NCalc functions](https://ncalc.gumbarros.com.br/articles/language/functions.html). Built-in and custom functions. Stored Nendo functions require host integration.
- **E4:** [NCalc cancellation](https://ncalc.gumbarros.com.br/articles/runtime/cancellation.html). Cooperative cancellation obligations. This is not evidence of hard execution isolation.

External documentation and matching source were checked on 12 September 2026. The experiment pinned NCalc 7.1.0 at source commit `da4f6eab38c00287f53a8d6b221727b5b9113a3c`. The [reference resolution](../design/adr-0008-dependencies.lock.json) keeps the package content hashes and transitive dependencies. Future runtime updates must rerun the semantic and containment checks.
