# ADR-0008: Add calculations, local actions and automatic triggers

- **Status:** Accepted
- **Date:** 2026-09-12
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** The [calculations and actions contract](../contracts/calculations-and-actions.md) maps obligations P1–P8 to their tests; NCalc 7.1.0 runs behind the typed adapter in `Nendo.Engine/Behaviour/`
- **Depends on:** ADR-0003, ADR-0004, ADR-0005, ADR-0006, ADR-0007, ADR-0009 and ADR-0012.
- **Related design:** [Architecture](../architecture.md), [calculations and actions contract](../contracts/calculations-and-actions.md), [scalar contract](../contracts/scalars.md), [semantic surfaces](../contracts/semantic-surfaces.md), [ADR-0013](0013-custom-views-with-code-in-the-file.md).

## Context

A `.nendo` application needs calculations that update when their inputs change, and
commands and automatic actions that can change related records. People and agents must
be able to add them without a host change for each application, and without bypassing
the host's write authority, history or recovery rules. Excel is a reference for the
experience, not for syntax or file compatibility.

The owner's requirements:

- Calculated fields (one formula per record type) and reusable functions. No per-cell
  formulas.
- Simple architecture, the current stack and existing libraries. No Excel-compatible
  language.
- Calculations within a record and across related records.
- Otherwise valid input is saved when a calculation fails; the error shows in the field.
- Automatic triggers from the start, not buttons only.
- An initiating edit and its local trigger actions commit together. A failed required
  action cancels the whole transaction.
- Local approval before a person edits a file with unfamiliar automatic actions.
  Inspection stays available before approval.
- A further function is not a new architecture project.

This ADR covers bounded application behaviour. It is not a plug-in platform; custom views
with code are [ADR-0013](0013-custom-views-with-code-in-the-file.md).

## Decision

Use an existing .NET expression evaluator for calculations and conditions, and host-owned
actions for writes. NCalc 7.1.0's parser and evaluator run behind a typed allow-list, with
decimal division intercepted before NCalc's integer-to-Double path and one shared resource
account. This is a restricted language, not an arbitrary-code sandbox. NCalc is a
production dependency of `Nendo.Engine` only. The
[calculations and actions contract](../contracts/calculations-and-actions.md) holds the
DTOs, storage, function catalogue, numeric policies, limits and measured budgets; it must
satisfy this ADR and must not silently redefine it.

### 1. Scope

The behaviour model has calculated fields, reusable expression functions, explicit
commands and automatic record triggers, with the approval and failure rules below.
Related-record dependencies are part of the same model.

### 2. One service in the existing Engine

One host-owned behaviour service lives in `Nendo.Engine`, with the library behind a narrow
adapter. There is no service process, general workflow engine or interchangeable-provider
framework.

The evaluator receives typed values and approved pure functions. It never receives
application-service objects, database connections or callbacks with write authority. The
host resolves record bindings and related queries. The action executor turns accepted
steps into canonical typed operations, and the existing write coordinator stays the only
path to active writes.

Studio, custom surfaces and MCP use the same services. The Workbench displays results and
diagnostics; it never runs a second calculation engine.

```text
Typed request
    → host authority and input checks
    → expressions and bounded local action plan
    → canonical operations
    → existing write coordinator and storage
    → result, history and refreshed calculations
```

### 3. Definitions belong to the application

Formula, function, action and trigger definitions are protected application metadata,
changed through canonical definition operations (`behaviour.setDefinition`,
`behaviour.removeDefinition`) and proposal review.

- Definitions, fields and relationships are bound by stable IDs. A rename never breaks a
  binding.
- A definition stores expression text and an explicit map from its parameters to semantic
  IDs. A reusable function has a stable ID, named parameters, a declared result type and an
  expression body.
- A library's parse tree is never the durable format. The host rebuilds parsed expressions
  from the versioned definition.
- Each definition records its execution-contract version (`behaviour-1`). The required
  host is recorded through `minimumHostVersion`; a library version is not a substitute.
- There is no per-record formula override. People edit a calculated field's inputs, not
  its result.

### 4. Calculation results and numeric rules

A calculated field produces a typed value, an empty or a calculation error. Empty and error
are different results.

- Results are derived values, evaluated on demand with bounded host caches. They are not
  stored as user edits and generate no revision. A stale cached result never appears as
  current; a pending calculation has an explicit pending state.
- Studio, custom surfaces and MCP return the same result semantics.
- The [scalar contract](../contracts/scalars.md) holds: signed 64-bit integers, .NET
  decimals, text and dates. Numeric user values never pass through JavaScript numbers.
- Operations are checked with explicit result types. Decimal is never silently converted to
  binary floating point. Missing values, empty text and booleans are never coerced into
  numbers. Rounding is explicit; results are not forced to two places.
- Only functions whose numeric behaviour meets the contract are exposed; NCalc's built-in
  catalogue is not Nendo's.
- Parsing is invariant and date rules are explicit. No function changes meaning with the
  Windows language setting; formatting belongs to presentation.
- Functions are pure. They cannot read the network or files, change records or call a
  general host method. A reusable function may call another; recursion is refused.

**Empties.** An empty input stops a formula, and the definition's declaration decides what
is reported:

- `resultNullable: true` reports a typed empty;
- `resultNullable: false` reports `calculation-missing-input`, as does a formula that ends
  empty in such a definition.

A reusable function follows the same rule at its call, and its caller's declaration then
decides what the caller reports. A result is never zero, false or a previous result in
place of an empty. The branch not taken is never evaluated. A dependant of an empty result
reads a typed empty; `calculation-dependency-failed` is for a dependency that errored.
There is no null literal and no three-valued logic: `empty and false` stops the formula.

`IsEmpty(value)` is the one function an empty argument reaches: true when the value is
empty or an empty input stopped it, and never empty itself. `Refuse(text)` produces no
value and reports `calculation-refused` with the author's sentence. It stands in either
outcome of a choice; a formula that is only a refusal, or a refusal outside a choice, is
refused at validation.

### 5. Dependencies within and across records

Dependencies between calculated fields are tracked; prerequisites evaluate first. Static
cycles are refused at validation and data-dependent cycles are detected during evaluation.

- A binding refers to a field of the same record, a field reached through a declared
  relationship, or a bounded aggregate of related records. Related queries use stable IDs;
  expressions cannot form SQL or resolve field names from strings.
- A related aggregate depends on membership as well as values: creation, deletion and
  reassignment change it, and a line moved between orders changes both totals.
- A `Sum` may total a calculation of the member type (`valueCalculationId`), and a
  `FilteredCount` may count by one (`predicateCalculationId`), instead of a stored field.
  It is worked out per member through the same source and is a declared dependency, so the
  graph refuses a loop and the removal of the calculation it reads.
- A `RelatedAggregate` `Count` evaluated for a read is the store's own count over the
  reference's index. It reads no row and has no related-row ceiling. A filtered count, a
  sum and every aggregate in a save's chain read their rows against the ceiling, because a
  reviewed plan has to see each record it counted.
- Calculation results, action conditions and action inputs share one dependency model. In
  a transaction they see the current staged state, earlier action steps included.
- Invalidation may be conservative (a data revision may invalidate a related-query cache).
  Each requested result reflects its input snapshot, and visible results refresh after
  relevant changes.
- A change to a calculated result is not a record-update event. Triggers subscribe to
  record events, so a display refresh never becomes a write trigger.

**Calculated fields in queries.** A `filterClause` and an `orderByFieldId` may name a
calculated field. The host reads every record the query's stored predicates leave, with its
calculations, and hands the database the ones that pass and their order, so the page, its
continuation, the count and every aggregate read one set; a query never filters or sorts
only the visible page. A value that could not be worked out matches nothing and sorts
last. Past 10,000 records the read is refused as `calculated-query-too-wide`. Totals and
rankings of a calculated number follow [ADR-0004](0004-versioned-semantic-ui-contract.md);
grouping, date roles and command steps refuse a calculated field (`NUI214`).

### 6. Calculation errors do not block valid input

Input that passes ordinary field, record and storage checks is saved. If a calculation
fails, the error shows in its field. Zero, empty text or a previous result is never
substituted. A dependent calculation reports a dependency error. A later input or
definition change evaluates again.

Invalid definitions (an unknown function, a broken binding) are refused before acceptance.
Value errors (division by zero, overflow, a missing required input) remain possible
afterwards.

If a trigger condition depends on an errored calculation, the condition is **blocked**: it
selects no action, the initiating edit can still commit, and the outcome shows the blocked
trigger. Blocked is neither false nor success, and no invisible retry is queued; a later
subscribed event evaluates it again.

If a condition selects an action and an action input then fails, that is an action failure
and cancels the transaction. A trigger condition is never an unstated integrity constraint;
an application that needs one states a validation rule.

### 7. Explicit commands and automatic triggers

An action is an ordered set of bounded steps, each requesting an allowed local data
operation: create, update or delete a record through the existing typed operations.
Conditions and inputs use the same expression service. Related targets come from declared,
bounded relationships or query bindings.

A `CreateRecord` step takes `links`: a reference field of the new record set to the event
record, or to the record one of its references names. Installation checks each pair
against the schema, and `EventRecord` is refused when the trigger also runs on a deletion.
A link carries the linked record's current version, and the plan observes it.

- Events are record creation, update and deletion. An update trigger can select stored
  fields. Each event has typed before and after values; creation and deletion have one side.
- Events are emitted at the logical mutation boundary: the initiating batch is staged
  before its event queue runs, so triggers never see half-edited forms.
- Event order and trigger order are documented and stable, never dictionary, thread or
  registration order.
- Actions can raise further events in the same transaction through a bounded queue. An
  assignment that changes no value raises no event.
- Nothing runs because a file opens, a screen renders or a calculation is read. Enabling or
  changing a trigger replays no past events. There is no background scheduler.

### 8. One atomic local transaction

The initiating edit and its selected trigger chain share one coordinator-owned
transaction. It commits only when every selected action and required check succeeds. An
action failure, authority failure, cancellation or chain-limit violation cancels all of
it, related records included. Unsaved human input survives a refusal, the outcome names the
failed trigger or step, and a cancelled save is never reported as saved. Calculation-only
errors and blocked conditions follow section 6.

- Every generated write passes normal data validation. A data action never obtains schema,
  identity, file-lifecycle or permission authority.
- Existing revision rules and per-record versions hold. Generated operations are attributed
  to the initiating request and the exact trigger and action definitions. There is no
  second commit log.
- The initiating idempotency key covers the whole causal transaction, and its receipt is
  stored with the commit. A retry after commit returns the recorded outcome and runs no
  trigger again.
- Host-supplied action time and generated IDs are frozen in the prepared plan; replay uses
  the recorded values.
- A failed screen refresh after commit is not a failed transaction. The receipt is
  authoritative.

### 9. Resource limits and capability isolation

Expression constructs, functions, event kinds and action steps are allow-listed; unknown
entries fail closed. There is no reflection, assembly, arbitrary object, SQL, database
path, filesystem, network, process or dynamic code. A `.nendo` file never supplies a
delegate, plug-in or binary; a stored function is an expression, not compiled code.

Source length is bounded before parsing, and parse depth, work, function calls, related
records, output size, cache size and generated changes are bounded too. The
[contract's limits](../contracts/calculations-and-actions.md#limits) give the numbers.
Every ceiling refuses whole; a partial total is never an answer, and a ceiling met in a
save aborts the save.

- **Work units are the one allowance nothing renews.** They span an evaluation, every
  nested call and a whole causal transaction. A save's 16,384 work units are not
  multiplied by its size, so a loop started by any of its records still ends.
- **A result is worked out once per budget.** A record's calculation, or its failure, is
  remembered for the rest of the evaluation; a save forgets before each change it makes. A
  spent allowance is never remembered.
- **A related record's calculation costs what its own read would.** It runs under that
  record's own function calls and related records, and spends its owner's work units. The
  owner pays one related record per member read, so one aggregate reads at most 256.
- **The record an evaluation is about is read for work.** Reading the record being read,
  the member being worked out, a record a save names or one its actions created costs a
  work unit, not a related record.
- **A save's allowances are its records' own.** A save naming N records has N times one
  record's function calls, related records and generated changes. No aggregate in it reads
  more than 256 related records, so a save never writes a total a read refuses.
- **The definition graph may be 16 deep.**
- **A save's refusal names the step that spent most work**, as text and, for an agent,
  under `limit` (`heaviestStep`, `heaviestStepWorkUnits`).

Cancellation is used, but a timeout token is not proof that work stops: NCalc requires
custom handlers to honour cancellation and promises no forced termination. Evaluation runs
off the UI thread. In-process evaluation gives no protection against another process
running as the same OS user. A wider vocabulary or wider limits need new measurements, not
only a passing suite. If only a substantial replacement interpreter could keep within these
bounds, the decision reopens; neither another evaluator nor a process boundary is an
automatic fallback.

Studio's inspection and recovery stay usable with calculations disabled. Opening an
unfamiliar file never forces uncontrolled logic to run.

### 10. Local trust and first use

Opening a file does not approve its actions, and a received file cannot carry a grant that
trusts itself.

- Before approval, Studio can inspect the file, its data and its behaviour definitions, and
  bounded pure calculations run under the same limits with no authority to change records.
- While required automatic behaviour is not approved, normal edits are unavailable
  (`behaviour-not-approved`). Records are never saved with required triggers silently off.
- The host presents the actions, trigger events, affected record types and requested
  permissions. The person approves the reviewed behaviour once, not per execution.
- Accepting a proposal can approve its exact behaviour definitions, explicitly in the host
  review. Below [ADR-0009](0009-local-mcp-transport-authority-and-change-sets.md)'s
  Unattended level, MCP cannot grant approval or promote its own proposal. At Unattended,
  `nendo.change_set.accept` promotes a proposal the same session validated and records this
  device's approval for the actions it installs.
- Approval (`NendoBehaviourGrant`) is local host state, bound to application identity,
  instance identity, the behaviour digest, the granted capabilities, the execution-contract
  version and the definition revision. Any definition change asks again. An ordinary record
  edit does not.
- The behaviour digest covers actions, triggers, and the functions, formulas and schema
  bindings that affect their meaning.
- A copy does not carry approval to another device or person. Duplicate and Fork need
  their own grant; a matching restore need not prompt again.
- Review acceptance and approval are separate storage operations. If the host stops between
  them, the definition may be installed while editing stays blocked until approval.
- The person can revoke approval at any time. New writes are refused after revocation, and
  approval is checked again before commit, so an in-flight operation never commits under a
  revoked grant.
- **An undo is allowed while actions await approval**, after a revocation included. It puts
  back what a revision recorded and runs no action, so it is the way back from what an
  action did. The Workbench keeps History's Undo available in that state; an agent still
  undoes only its own origin's revisions. A read-only or damaged file offers no undo.
- Emergency suspension makes editing unavailable. Permanently disabling a trigger is a
  reviewed, visible definition change, never a hidden bypass.

### 11. Proposal validation and replay

[ADR-0007](0007-proposal-clone-validation-and-replay-promotion.md) holds: validate on a
physical clone and promote by replaying the reviewed operations.

- For a proposal with record edits, trigger effects are expanded on the clone under the
  candidate definition, and every generated operation is in the reviewed plan, digest and
  diff. Validation and active execution use the same ordering and planner.
- A definition-only proposal raises no record events and backfills nothing.
- Promotion checks the definition, execution contract, approvals and data preconditions,
  then applies the expanded operations. It never discovers or runs further trigger effects.
- Only trusted internal replay suppresses trigger expansion. No skip-trigger flag reaches
  Studio, MCP or application actions.
- Every record read to decide an action is a precondition, not only records written.
  Related queries carry a membership precondition, which may conservatively require an
  unchanged data revision.
- A stale proposal is refused and prepared again; acceptance never recomputes a different
  plan.

Accepting behaviour does not prove every future action will succeed. Runtime validation and
rollback apply on each execution.

### 12. History, compensation and file lifecycle

- History identifies the initiating edit, the executed triggers and their generated
  operations. Successful outcomes also show blocked trigger conditions.
- A rolled-back attempt is not a revision. Its failure is reported through the outcome or
  diagnostics, never by inserting an application record.
- Compensation is a host-owned operation over the causal change: proven inverses are applied
  together, or compensation is refused. It runs no automatic action. A retained backup does
  not make an irreversible operation reversible, and there is no universal undo
  ([ADR-0006](0006-split-revisions-audit-and-compensation.md)).
- Restore, reopen and cache rebuild raise no record events. Derived values are recalculated;
  historical actions never run again.
- An unknown execution contract follows [ADR-0012](0012-safe-mode-compatibility-and-migration.md):
  the file is inspectable, its data readable where safe, and editing disabled
  (`behaviour-contract-mismatch`, `behaviour-unreadable`).

### 13. Growth without a new platform

An ordinary function, bounded action or event is added under this ADR when it keeps the
authority and failure rules above. Its contract and tests ship with it.

- One machine-readable catalogue, published at `nendo://application/vocabulary` and
  generated from the tables the Engine enforces, drives validation, MCP discovery, editor
  help and examples. A capability is discoverable before an author relies on it; no author
  discovers the contract by failing.
- Each entry states its types, empty and error rules, cost, permissions and minimum host.
  A test asserts that every function a catalogue summary names exists.
- The vocabulary publishes every object of a definition body with its required and optional
  keys, and an example body for each of the four kinds.
- Entries added through this path include `IsEmpty` (host 1.47.0), `ToText(value)` (a whole
  number as its digits, a decimal as its stored digits, a date as `yyyy-MM-dd`; no locale;
  Boolean and text refused; host 1.49.0) and `AddDays(date, days)` (no clock; a result
  outside 0001-01-01 to 9999-12-31 is `calculation-invalid-date`; host 1.53.0). Filtering
  and sorting on a calculated field needs host 1.40.0; `links` and calculated aggregate
  members need 1.47.0. Text never coerces, `+` on text is refused, and there is no format
  argument. Clock-relative words such as *this week* are filter words resolved where
  `today` is (ADR-0004), not functions.
- The expression service may serve read-only uses such as field or section visibility,
  validation conditions and command availability. These never inject HTML or replace
  Studio.
- Repeated groups, layout nodes and custom controls need the relevant surface or extension
  decision, not a function registration.
- External services, file access, timers, background execution and arbitrary code are
  outside this authority. External effects cannot share the local rollback guarantee; they
  need a further decision covering durable intent, retries, idempotency, credentials,
  consent and recovery.
- A runtime update passes the semantic test suite. A change in meaning needs an explicit
  contract change and compatibility review; stored formulas are never reinterpreted
  silently.

### Obligations

The contract maps each obligation to its tests.
[adr-0008-regressions.md](../design/adr-0008-regressions.md) holds the numeric oracles
behind them.

| | Obligation |
| --- | --- |
| **P1** | An agent authors inputs, dependent calculations and a function; the host accepts; Studio, a custom surface and MCP agree, across renames and an offline reopen |
| **P2** | Related create, delete, update and reassignment keep both parents current; cycles are refused or shown; no partial aggregate |
| **P3** | A failed calculation keeps the input and recovers; a blocked trigger shows; a failed action input rolls back the whole transaction |
| **P4** | Every write route (native entry, forms, MCP, paste, import) shares staging, order, no-op suppression, limits and permissions |
| **P5** | Approval: inspection without a grant, blocked editing, approve, revoke, Duplicate, Fork, Backup, Restore, malformed or newer definitions |
| **P6** | Causal attribution, same-key retries, lost responses, bounded compensation, no trigger run twice on replay |
| **P7** | Keyboard, readable errors, screen reader, latency and memory at scale; the human half is owner-reported |
| **P8** | A new pure function and a read-only consumer on the same engine; a network-access example is refused |

## Consequences

**Positive.** People and agents add calculations and local automation through one set of
definitions and host services, with no generated project. Calculation errors are visible
and valid work is not lost. Local actions are atomic and attributable. Studio stays
available without trusting application behaviour.

**Negative.** Nendo implements dependency tracking, trigger planning and grants itself.
Trigger chains add save latency, limits can refuse large legitimate work, and conservative
related-query checks make proposals stale more often. In-process library defects remain a
host risk. A blocked condition permits a save without an optional action, so a strict
invariant needs a validation rule. A received file is inspectable but not editable until
approved. A total over calculated members costs a calculation per member.

## Rejected alternatives

- **General C# or JavaScript scripting from the start.** A wider execution contract and
  isolation questions with no use case that needs it.
- **A Nendo-specific expression language.** Parser, diagnostics and language maintenance
  while a library meets the need.
- **Fixed declarative commands only.** No reusable formulas or automatic behaviour.
- **Excel syntax compatibility.** The owner put implementation simplicity first.
- **Postponing triggers, or silently disabling required ones.** Changes application meaning
  without a visible decision.
- **Keeping half of a failed trigger chain.** The transaction is atomic.
- **Formulas with write authority or .NET objects.** Removes the calculation/action
  boundary.
- **Swapping in the proposal clone, or running triggers again on replay.** The reviewed plan
  is what promotes.
- **Empties propagate everywhere (SQL's rule).** Hides an unexpectedly empty required input
  behind a blank.
- **Showing `calculation-missing-input` gently in the Workbench only.** MCP and exports would
  still report a failure.

## Revisit triggers

- A real application needs arbitrary control flow, recursion, per-cell formulas or
  capabilities the bounded model cannot express.
- The evaluator cannot meet the execution budgets, or untrusted-file tests can stop Studio.
- Related-record scans or trigger chains exceed the intended local workload.
- People cannot understand grants, revocation or changed behaviour. Prompt fatigue is never
  solved by trusting a flag inside the file.
- External effects, background work, third-party controls, collaboration or a second
  runtime enter scope: each needs its own decision.

## References

- [NCalc](https://github.com/ncalc/ncalc), pinned at 7.1.0 (source commit
  `da4f6eab38c00287f53a8d6b221727b5b9113a3c`). Its
  [configuration](https://ncalc.gumbarros.com.br/articles/evaluation/configuration.html)
  alone does not establish Nendo's numeric rules, and its
  [cancellation](https://ncalc.gumbarros.com.br/articles/runtime/cancellation.html) is
  cooperative. A runtime update reruns the semantic and containment tests.
