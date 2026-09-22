# Calculations and actions contract

This contract states what a stored behaviour definition is, how it is validated,
and what a file that holds one requires of its host.

It is an implementation contract within [ADR-0008](../decisions/0008-general-scripting-and-capability-isolation.md).
It defines restricted expressions and local actions. It does not define an
extension platform. The execution semantics that this contract starts from are
recorded in [adr-0008-semantics.md](../design/adr-0008-semantics.md).

**Delivered: stages S1-S6.** These stages delivered:

- definitions and their protected storage;
- the bounded expression runtime;
- calculated fields over real records;
- automatic actions inside the initiating transaction;
- the consent of this device, which controls whether those actions may run at
  all;
- reviewed proposals that promote exactly what was reviewed.

**Delivered: stage S7.** This stage delivered:

- Studio shows the calculated fields of a record with their formula and their
  four result states. It shows them in the record page and as a read-only
  column in the table.
- A custom surface binds a calculated field wherever it binds a stored one.
- File status carries the approval panel with its approve and withdraw routes.
- An unsaved form survives when a file moves underneath it.
- Evaluation runs away from the UI thread, with a stop that waits until the
  work has stopped.

The real-host journey (`tools/Journey-Behaviour.mjs`) drives all of this through
the real WinUI/WebView2 host.

That journey asserts the automated half of the accessibility checks and records
it in its `behaviour-state.json`. The automated half is keyboard reachability,
focus, and the names and headings that assistive technology reads. The half that
a person must do is scripted under [what a person sees](#what-a-person-sees).
**The owner ran it on 2026-09-13 and reported all four checks passing.** This
result satisfies ADR obligation **P7**. The result is owner-reported, and this
repository did not measure it. It is the judgement of a person about whether
this is usable, and nothing in this repository can replace that judgement.

**Delivered: stage S8.** This stage delivered:

- The behaviour catalogue is published through `nendo://application/vocabulary`.
  It is generated from the tables that the Engine enforces.
- An agent authors calculations, functions, actions and triggers with
  `behaviour.setDefinition` and `behaviour.removeDefinition` through ordinary
  proposals. The agent reads the results back exactly.
- Every production write route fires the same triggers under one shared budget.
- Compensation of a causal revision reverses the initiating edit and everything
  that its actions wrote, together. It does not run the actions again.
- The growth path is exercised: one new bounded pure function and one read-only
  consumer of the calculation service. Both use the machinery that already
  existed.

## What each ADR obligation rests on

| Obligation | Evidence |
| --- | --- |
| **P1** agent authors, host accepts, Studio and surfaces agree | `BehaviourAuthoringProtocolTests`, `BehaviourSurfaceTests`, `BehaviourCalculationTests`, and the real-host journey, which reads the same numbers on screen |
| **P2** related create, delete, update, reassignment; cycles; no partial totals | `BehaviourCalculationTests`, `BehaviourEventTests` |
| **P3** a failed calculation keeps the input; a failed action rolls back | `BehaviourCalculationTests`, `BehaviourActionTests`, and the journey, which reads `Cannot calculate` while Studio is still reachable |
| **P4** every write route shares staging, order, no-op, budget and permissions | `BehaviourWriteRouteTests` |
| **P5** missing, mismatched, revoked and corrupt consent; copy, restore and recovery | `BehaviourGrantTests`, `DesktopBehaviourGrantTests`, and the journey, which approves on a real device-state root |
| **P6** causal attribution, same-key retries, lost responses, safe compensation | `BehaviourActionTests`, `BehaviourProposalTests`, `BehaviourCompensationTests` |
| **P7** keyboard, focus, screen reader, Light and Dark, latency and memory at scale | `tools/Journey-Behaviour.mjs` for the automated half, [what it costs](#what-it-costs) for the measurements, and the owner's run of [the lane a person has to run](#the-lane-a-person-has-to-run) on 2026-09-13 for the half that only a person can judge |
| **P8** a new pure function and a read-only consumer on the same engine and catalogue | `BehaviourGrowthTests` |

## Execution contract version

Every definition records the contract that it was written against. The only
version that this host implements is `behaviour-1`.

If the stored definitions of a file name any other contract, the file is
inspectable and its data stays readable, but editing is disabled. This is
reported as the open finding `behaviour-contract-mismatch`. If a stored body does
not parse back into a valid typed definition, the host reports
`behaviour-unreadable` and disables editing in the same way. Neither case is
repaired, migrated or partially interpreted. A half-loaded formula would compute
a number that nobody authored.

## The four definition kinds

One protected table holds all four kinds. The key is the stable definition ID.

| Kind | Carries |
| --- | --- |
| Calculation | Owning entity and derived field ID, display name, result scalar and nullability, expression source, ordered bindings, called function aliases |
| Function | Display name, ordered typed parameters, result scalar and nullability, expression body, called function aliases |
| Action | Display name, ordered typed steps |
| Trigger | Entity ID, subscribed events, optional relevant stored-field IDs, optional Boolean condition with its own bindings, and the action it runs |

Stable IDs use letters, digits, hyphen, underscore and dot, and are at most 128
characters. Display names are 1–200 characters. An expression never binds to a
display name, so a rename of a record type or a field changes no stored
definition.

### Scalars

Calculation inputs and results are `Integer` (Int64), `Decimal` (.NET decimal),
`Boolean`, `Text` or `Date` (calendar `DateOnly`). Each is optionally null.

Stored `DateTime`, `Uuid` and `Reference` values remain valid data, but they are
not expression values. A reference resolves a binding. It is not an object whose
contents a formula can read. Adding a scalar domain requires its own semantics
and tests.

### Bindings

A binding is the only way for a name in an expression to reach a value. Every
binding kind carries explicit stable entity, field and relationship IDs.

Every binding carries `bindingId`, `kind` and `entityId`. Its other keys depend
on the shape. The table is `NendoBindingShape.All`. The codec refuses against
this table, the vocabulary publishes it, and a test keeps the two in agreement.
A key that is published is accepted, and a key that is accepted is published.

| Shape | Reaches | Its own keys |
| --- | --- | --- |
| `SameRecordField` | A stored field on the record being calculated | `fieldId`, `resultType`, `nullable` |
| `SameRecordCalculation` | Another calculated field on the same record | `calculationId`, `resultType`, `nullable` |
| `ReferenceTraversal` | One declared hop along a reference field, then a stored field on the target | `referenceFieldId`, `relatedEntityId`, `fieldId`, `resultType`, `nullable` |
| `RelatedAggregate` · `Count` | How many records reference this one | `aggregate`, `relatedEntityId`, `relatedReferenceFieldId` |
| `RelatedAggregate` · `FilteredCount` | How many of them have a Boolean field true | … and `predicateFieldId` |
| `RelatedAggregate` · `Sum` | The exact total of a numeric field over them | … and `valueFieldId`, `resultType` |

The initial aggregate catalogue is closed:

- **Count**: counts members. Int64 zero for an empty collection.
- **FilteredCount**: counts members whose `predicateFieldId` Boolean is true.
- **Sum**: checked typed sum of `valueFieldId`, an Integer or Decimal field.
  Typed zero for an empty collection. The field must be **required**. A member
  with no value is an error. It is not a zero. Installation therefore refuses a
  sum over an optional field, because such a sum promises a total that the first
  empty value breaks.

If a key is outside the list of a shape, the refusal names the key and gives
the list. If a required key is missing, the refusal names the key and states its
purpose: `Binding 'seeds'
(RelatedAggregate Sum) needs valueFieldId — the Integer or Decimal field it
totals.` Previously, the codec dropped an unknown key silently. Because of this,
a reviewer sent a sum three ways and got no information each time.

An aggregate is never null. A null member value propagates as a calculation
error. It is not skipped. If a collection is larger than the related-row
ceiling, the aggregate returns an error. It does not return a total of the part
that was read. An incomplete total that looks like a complete total is worse
than no total.

### Actions and triggers

An action step is `SetField`, `CreateRecord` or `DeleteRecord`. It targets
either the record that raised the event, or the record that one declared
reference field from that record reaches. A step writes ordinary typed record
data only. It never writes a definition, identity, grant, schema change or
anything outside the file.

A trigger subscribes to any of created, updated and deleted. Relevant field IDs
narrow an update subscription, and therefore they require it.

**An action and its trigger are validated as a pair, at install.** An action
does not know the record type that it runs against. Only the trigger names one.
Previously, a step could bind the event record while it wrote a field of the
referenced record. Such a step installed without an error and failed at the next
save. At that time, the person who saved was not the person who wrote the
action.

Now, the installation of either half resolves every step of the pair against the
schema, in the same way as the planner resolves it at run time. The install
refuses with `action-target-mismatch`. The refusal names the action, the step,
the record type that the step reaches and the field that this record type does
not have. If the record type of the trigger does not have the reference, or if
the reference is not bound, the install refuses in the same way. It does not
fail inside the planner. Only the pairs that the operation touches are checked,
so a definition written before this check cannot refuse an unrelated install.

A refused behaviour install leaves the open file readable. The behaviour table is
created inside the mutation that installs the first definition. If a refusal
occurs later in that mutation, the rollback removes the table. Each open store
remembers whether the file has the table, and a rollback resets this value to
unknown. Without this, after the first refused install, every later read of that
session asked for a table that did not exist (F-070).

Subscriptions apply to **net** stored-value changes across the whole request.
They do not apply to individual low-level writes. A form that sets four fields is
one update. A field set back to the value that it already held is no change. It
raises nothing, generates nothing, and uses no record version.

A step that follows a relationship resolves it from **both** sides of the event.
This makes reassignment correct: when a task moves between projects, the step
updates the project that the task left and the project that it joined. An empty
reference names no record. The step then writes nothing, the save still commits,
and the `alsoChanged` of the write result carries nothing for the step. This is
the rule. It is not an error: a note in no folder has no folder to stamp. A file
that needs every event to reach a target makes the reference field required.

The vocabulary states this rule under `actionTargets`, beside the step kinds. An
outside review created a record with an empty target reference and expected a
refusal. It got a committed write that reported no effect, and nothing that it
had read stated this rule.

Every generated write goes through the same operation dispatch that the own
write of an author uses. It is therefore checked against the same record
versions, reference targets, required fields and retirement rules. A trigger is
not a privileged path into the data. It may only create, set or delete ordinary
records. It never writes a definition, identity, schema or anything outside the
file.

## Validation

A definition is validated against the whole candidate set that it would leave
behind. It is never validated in isolation, because a cycle and a dangling call
are properties of the graph. Installation refuses when:

- a call or the action of a trigger names a definition that the file does not
  hold, or a definition of the wrong kind;
- definitions call each other in a loop, or nest more than 8 deep;
- a binding names a missing field, a field of a different stored type, a
  relationship that points at another record type, or an unbound reference;
- a binding reads an optional field without declaring itself nullable;
- the ID of a calculated field collides with a stored field on the same record
  type;
- a stable ID, alias, parameter ID or step ID repeats within one definition;
- the definition names a contract version that this host does not implement.

If something else still references a definition, the removal of that definition
is refused with `definition-referenced`. The exception is when the same ordered
change set also removes or rewires every dependant. The removal of an absent
definition is `definition-not-found`.

## Reading a calculated field

A calculated field is computed on demand, from the state that the reader sees.
For an ordinary read, this is committed data. During a save, this is the staged
data of the transaction. Nothing is cached between reads, so no invalidation can
show yesterday's number as today's.

The calculations of each record are evaluated in dependency order. If the input
of a calculation is itself in error, the calculation reports
`calculation-dependency-failed`. It does not report a value of its own, because a
stale number beside a broken input causes people to trust a wrong figure. One
failing calculation does not affect the other fields of the record or its
validity. A zero denominator saves the input and shows an error. When the input
is corrected, the calculation recovers with no repair step.

Every read route computes in the same way and agrees. A full snapshot, a bounded
query and a read-only open all report the same result for the same record.
Results travel as `NendoRecordSnapshot.Calculations`, separate from stored
`Values`. They use the same exact-number transport as stored values, so a
decimal never becomes a floating-point double on the way to Studio, a surface or
an agent.

Reading, rendering and opening never write. Computing a calculation raises no
revision, records no record event and starts no action.

During a read, each record gets its own budget, because a list is a series of
independent evaluations. A save is different: one budget spans the whole chain.

## Automatic actions

An edit and every action that it triggers are one SQLite transaction and one
revision. Either all of it is durable or the file does not change. There is no
period in which a task is marked done but the total of its project is not yet
updated. There is also no repair pass that could fail separately.

The order is fixed:

1. Capture the state of every record that the request names, before anything is
   staged.
2. Stage **all** initiating operations, so the file shows the complete edit and
   no half-formed intermediate state.
3. Derive logical events: compare the state before with the staged state. Queue
   the events in stable (record type, record) order.
4. For each event, select triggers by stable ID in ordinal order. Evaluate the
   condition against the current staged state. Run the steps of the action in
   order. Each step sees the effects of the previous steps.
5. Generated writes raise their own events. These events are appended to the
   same queue.
6. Check cancellation again. Write one causal revision and the receipt of the
   original request in the same transaction. Commit once.

**A calculation error and an action failure are different things.** If a
condition cannot be evaluated, it blocks its own action and is reported. The
initiating edit still commits, because the typed values of the owner are valid
whether or not a rule about them could be decided. These failures abort
everything, including earlier steps that already succeeded and the edit itself:

- a failure while the host computes what an action should *write*;
- an exhausted budget;
- cancellation.

No success receipt exists for a chain that did not commit. The refusal names the
action, the step and the field that it could not write, and states that nothing
changed. The Workbench receives it under the code of the calculation. An agent
receives it as `NENDO_CALCULATION_*` with the same sentence. Before this rule, an
assignment could bind to the event record while it wrote to the referenced
record. The published example warns about this mistake. Such an assignment
installed without an error and then appeared on the first save as an internal
error.

**A committed write says what its actions changed.**
`NendoApplyResult.GeneratedChanges` lists each other record that the chain wrote.
For each record it gives `created`, `updated` or `deleted` and the version that
the record now holds. If the chain wrote a record more than once, the last write
wins. MCP publishes this list as `alsoChanged`. An idempotent replay names the
same records, and so does a receipt read back later through
`GetMutationReceiptAsync`. Both are rebuilt from the operations of the revision
that carry an attribution row, and their version is null. The file may have
changed since, and a number there would be read as current.

A caller that recovers from a lost response learns which records to read. It
reads a record before it writes to that record. Until 2026-09-14, both carried
nothing, and the attribution table was written but never read.

### Identity, retries and history

The payload digest of the request keys idempotency. The revision records the
digest of what was committed, generated writes included. A retry under the same
key returns the original receipt and runs nothing again. This is also true when
the process that made the request never saw the answer. A change of the payload
under an existing key still refuses.

Generated operation IDs, and any record IDs that an action creates, are derived
from the identity and position of the chain. They are never generated fresh, so
the same chain always names the same operations.

Each generated operation carries its attribution in `__nendo_attribution`: the
root request, the triggering event, and the trigger, action and step that
produced it, plus a digest of the behaviour that it ran under. The attribution
annotates the ordinary history. It does not form a separate log. The same
evidence therefore answers "why did this change?" and "what changed?".

## Approval

If a file carries a trigger, it cannot be edited until this device agrees that
its actions may run. A file with calculations but no trigger needs no approval,
because a calculation reads data and writes none.

Consent names exactly one thing, and every field of it is necessary:

| Field | Why it is part of the question |
| --- | --- |
| Application ID | Approval of one application is not approval of another |
| Instance ID | A copy of a file is a different file |
| Behaviour digest | A change to what an action does is a new question |
| Contract version | A host that would evaluate the rules differently inherits nothing |
| Definition revision | Conservative: any definition change asks again |
| Capabilities | Read from the actions that a trigger can reach: create, update, delete |

Matching is exact equality across all six fields, so there is no place for
leniency.

**Where it lives.** Consent is device state. It is kept beside the other
per-user preferences under `%LocalAppData%\Nendo`, and never inside a `.nendo`
file. A file therefore cannot carry its own permission. When a person sends a
file to someone, the decision to trust the file does not go with it. A
Duplicate, a Fork, a backup or a copy on another machine all arrive unapproved
and ask again.

**Failing closed.** The absence of a grant is not an implicit grant. An Engine
embedding that supplies no authority refuses. If a grant document is missing,
oversized, malformed or edited, it approves nothing and reports this. If "I
could not tell" were treated as "yes", a damaged state file could cause the
actions of somebody else to run.

**When it is checked.** Consent is checked before any action runs. It is checked
again at the commit boundary, while the transaction still holds the write lock.
If consent is withdrawn at any point during a save, including while its actions
run, the whole transaction aborts. The withdrawal is not detected afterwards.
The revocation generation is compared as well as the grant, so work in progress
cannot get ahead of a withdrawal.

**What refusal looks like.** The file stays fully readable, keeps its bounded
calculations, and can be exported and backed up. Only editing is withheld, with
the precondition code `behaviour-not-approved`. The trigger is never disabled
silently to let the save continue. A file that silently stops doing what it says
it does is worse than a file that asks a question.

Installing a definition is a reviewed change to the file. It is not an occasion
to run the definition. Nothing fires on open, on render, on approval, or on a
cache rebuild.

## Reviewed proposals

A proposal is judged against a clone and applied to the live file later. This is
safe because the second step **replays** the output of the first step. The second
step does not recompute the same result and trust it to agree.

**Reviewing** applies the change set to the physical clone with the actions
running. The review therefore shows the effects of the actions, and not only the
operations that an author asked for. The clone may run the actions because it is
a throwaway copy that nobody edits. This is the host choosing to simulate. It is
not a file that grants itself permission. Reviewing changes nothing in the
active file.

**The reviewed plan** is written into the proposal workspace beside the clone. It
holds:

- the ordered generated operations with their attribution;
- the behaviour digest that they ran under;
- the consent that their promotion will need;
- the record versions that every result depended on;
- the data revision at which the collections were counted.

The plan survives the session that made it. Promotion reads it back from disk and
does not trust memory. If somebody edited a workspace, the workspace fails its
digest, and nothing that nobody approved is promoted.

**Promotion** checks these items under the authority of the coordinator and
inside one transaction:

- the identity of the file;
- its definition revision;
- the records that the change set touches;
- **the records that a condition only read**;
- **the data revision**.

Per-operation version checks cannot see the last two. A total that was correct
at review time is wrong if a record that it counted changed after the review. It
is also wrong if a matching record was created after the review. A stale plan is
refused and asks for a new preview. Nothing is ever recomputed to make
acceptance succeed.

Promotion then applies exactly the reviewed operations with expansion switched
off. If the triggers ran again, they would add new effects on top of the
reviewed effects. Generated IDs and ordering were fixed at review. A repeated
promotion under the same identity therefore resolves through the ordinary
receipt and applies nothing twice.

**Consent still applies.** Promotion replays and does not re-run, so the approval
gate of the chain never fires. Promotion therefore checks the recorded
requirement of the plan instead. That requirement describes the behaviour that
the file will hold *after* promotion. Approval of the current rules therefore
does not approve a proposal that rewrites them. A definition-only proposal emits
no data events and does no backfill: installing rules is a reviewed change, not
an occasion to run them.

## What a person sees

A calculated field is shown but not offered for editing. It carries its formula
below the value. It is intentionally not styled as a disabled input. A disabled
control means "not right now", but nobody edits a calculated field at all.

The four states stay four separate states on screen: a value, `Not set`,
`Calculating…`, and `Cannot calculate` with the reason beside it. If an empty or
failed result showed as a blank cell beside stored blanks, a reader could take
it for a computed number and trust it. If a calculation failed because its
*input* failed, it reads `Unavailable` and names the input, so the reader looks
in the correct place.

Calculated numbers use the same exact-number transport as stored numbers. A
calculated decimal is the value most likely to be a total that somebody relies
on. It is therefore the last value that should lose digits to a JavaScript
number.

**On a custom surface** a calculated field binds wherever a stored one does: a
record page, a list column, a board card, a related list of another record type.
It may not drive a bounded query. These all refuse a calculated field with code
`NUI214`, and the refusal names the field:

- `orderByFieldId`;
- `filterClause`;
- `groupByFieldId`;
- the `dateFieldId` of a calendar;
- the field of a `summaryTile`;
- a command step.

The database decides these over every matching record, and a calculated field
has no column to read. To honour one, the host would have to compute the whole
collection, or silently order the loaded page and call that the order of the
collection. A `recordForm` made only of calculated fields is also refused
(`NUI215`), because it would offer Save with nothing to save.

A grant binds the whole definition revision, as a conservative choice. Therefore
**any** accepted definition change asks again, including a change that alters no
rule, such as adding a screen. This is a real cost of the current binding. It is
not an oversight. A more selective digest would have to cover every function,
formula and schema binding that affects what an action does. It would also need
its own invalidation tests before it could be trusted to ask less often.

**Approval** appears in File status and on the Agent page, where the person just
accepted the proposal that put the actions in the file. It describes what will
happen to the data of the owner, for example "it can add records, change
records". It does not present itself as a permission grant. It shows the short
digest of the behaviour, so two different sets of rules visibly differ. When a
person accepts such a proposal, the same message states that approval is needed.
The status pill of the frame reads *Approval needed* for as long as editing is
off for that reason.

Without this, a person who accepted on the Agent page saw "no changes waiting"
and had to find the consent under Health. Approving and withdrawing are shell
routes that write device state. They are not mutations, they never enter the
history of the file, and they have no MCP equivalent. The production gate
asserts that the local MCP surface cannot name them. They stay usable when
editing is off, because they exist to get out of that state.

**The formula is an authoring detail.** The Studio editor and grid show it beside
the value, because a formula is written and read there. A finished screen in the
Use view shows only the value and the *Calculated* mark. The expression names the
binding aliases of the author, for example `SeedsPerGram(gpt)`. These aliases
mean something to the author and nothing to a person who uses the screen.

**A total the host cannot hold exactly stays unavailable.** If the sum of a
summary tile passes int64, or 28 significant digits for a decimal, the tile reads
*Unavailable* with the reason and offers no Retry. The refusal is deterministic,
and a retry would only compute it again. The read of the tile keeps the code of
the host (`aggregate-not-representable`, `aggregate-not-exact`). A transient
failure (cancelled, file busy) therefore still offers Retry. This is a real
ceiling: a stored integer may reach int64 max, and a total of several such values
cannot be shown.

**The review says which fields are calculated.** The semantic diff of a proposal
resolves calculated fields: the fields of the file and the fields that the same
change set defines. A screen that binds one therefore reads *Show the calculated
field Seeds per gram*, and a `visibleWhen` reads *Show this only when Needs
retest is yes*. Previously, a proposal that had just defined seven calculated
fields read *Bind to unknown field "seedsPerGram"* seven times. This occurred on
the one screen whose purpose is to get the trust of the person.

**An unsaved form outlives a refusal.** A confirmed refusal leaves the file
unchanged. The draft is therefore still the best copy of what the person
intended, and the form stays open. The session can instead move underneath the
form: another file, a withdrawn approval, a read-only transition, or a session
that could not be read. In that case the typed input stays on screen, saving is
switched off, and the reason is stated on screen. Values typed against one file
are never applied to another file.

**Work happens away from the UI thread.** A bounded calculation is real
arithmetic inside an ordinary read, and an await does not move it off the
thread. Every host method that cannot touch a native picker or a XAML element
runs on a worker. The other methods stay on the thread that owns the window.
Work that runs long offers Stop. The host answers a stop only after the work has
stopped. A cancel that returns early reports an idle file while the file is
still being written.

### The lane a person has to run

Automated checks cover reachability, focus, and the names and headings that
assistive technology reads. They do not cover whether any of it is usable. Run
this lane by hand and record it separately. A passing journey is not this
evidence.

**Run by the owner on 2026-09-13 against the published Release payload, with an
isolated file and device-state root. All four checks passed.** Run the lane again
whenever what a person sees changes, for example a new state, a new control or a
new refusal. The automated lane will continue to pass through a change that
makes this lane fail.

1. Open a file that carries automatic actions. Use only the keyboard to reach
   File status, read the approval panel and approve. Confirm that editing
   becomes available.
2. With a screen reader, read one record page that has a value, an empty result
   and a failed result. Each must be distinguishable without the colour, and the
   failed result must say why.
3. Cause a refusal on a form with unsaved input. Confirm that focus lands on the
   message, that the typed input is still there, and that a screen reader reads
   what happened.
4. Repeat 1-3 in Light, in Dark, and with the system following the OS setting.

## Reversing a save

A causal revision is the edit that a person made and everything that its actions
wrote, in one transaction. Compensation reverses all of it, in the opposite
order. It uses the versions that the revision itself recorded, and not the
versions that the file holds now. If something else changed a record since, the
compensation therefore reports a conflict. An exact retry after a lost response
rebuilds the same compensation, and not a different one.

The actions do not run again over the reversal. If they did, they would compute
a stored field from a state that the reversal had not finished producing. They
would then write that value on top of the operation that is being undone.

If an operation declares itself irreversible, the whole revision is refused, and
the refusal names the operation. This includes `data.createRecord`: its retained
state is intentionally not treated as permission to un-create the record.
Reversing a definition is supported, and it asks the device about the rules
that it restores. Consent given for the definition that is being undone does not
carry over to the definition that comes back.

## Reaching it from an agent

`nendo://application/vocabulary` carries a `behaviour` section. This section is
generated from the same tables that the analyzer and the planner enforce. It
contains:

- the closed function set, with the argument and result types of each function;
- the operators as they are written in a formula;
- the scalar domain;
- the four binding kinds;
- what each aggregate does with an empty collection and with a value that it
  cannot read;
- the action step kinds;
- the action target kinds, each of which states what it selects at the edges,
  including that an empty reference selects no record;
- the capabilities;
- the ceilings.

There is no second MCP-only catalogue that could diverge from it.
`nendo://application/examples` carries a change set that an agent can send
unchanged.

The `bindings` section publishes every shape with its keys. It publishes a
`RelatedAggregate` once per aggregate, and each aggregate names its `fieldKey`.
`nendo://application/examples` includes a `Sum`, so `valueFieldId` appears in a
change set that an agent can send unchanged. The `propertyNotes` of the surface
vocabulary state what `visibleWhen` takes: the `fieldId` of a calculated Boolean
field, not its definition ID.

A body that does not fit its shape is refused at `add_operations`. The refusal
names the mutation, the operation, the binding and the key, and nothing enters
the draft. Previously, the error was found at validate. The exception there left
the draft frozen, and the documented remedy, `amend`, refused. A draft of ninety
operations was frozen by one guessed key.

The calculated fields of a record type appear under `derivedFields` on its
schema, never under `fields`. The results of each record travel beside its
values with an exact `numericLexeme`. A calculated decimal is the value most
likely to be a total that somebody relies on. It is therefore the last value that
should reach a client as a rounded JavaScript number. A data write that fired an
action returns `alsoChanged`: the other records that the chain wrote, with their
new versions. A replay and a receipt name the same records without versions.

A write that names a calculated field is refused as `NENDO_FIELD_CALCULATED`, and
the refusal names the calculation. It is not refused as a field that does not
exist. Until 2026-09-14 it read as a missing field, because the write path looked
only at stored columns.

Authoring is not consent. If the actions of a file run automatically, the file is
not editable until the person at this device approves it. An ordinary write by an
agent is refused with the same message that an edit by a person gets. No tool,
resource or payload field reaches that approval.

## Canonical operations and digests

There are two closed canonical operations, both on the definition lane:

| Operation | Effect | Reversibility |
| --- | --- | --- |
| `behaviour.setDefinition` | Installs a definition at its stable ID, creating or replacing it | `ReversibleWithRetainedState` |
| `behaviour.removeDefinition` | Removes one by stable ID and stated kind | `ReversibleWithRetainedState` |

Both take an `expectedDefinitionRevision` and conflict exactly like every other
definition operation. Whole-definition convenience requests expand into these
operations before any diff, digest, history entry or promotion sees them.

The canonical payload embeds the canonical body of the definition. That body is
written from the validated typed record, with properties in a fixed order and
collections in declared order. It is never written from dictionary iteration.
The digest of a definition is therefore stable across processes and runs.
Declared order is part of the definition: two calculations that differ only in
binding order are different definitions with different digests.

Evidence keeps the previous body, contract version and kind. The inverse of an
install is therefore the definition that was there before, or its removal if
there was none.

## Storage

`__nendo_behaviour` is created the first time that a file stores a definition:

| Column | Notes |
| --- | --- |
| `definition_id` | Primary key, the stable ID |
| `definition_kind` | `Calculation`, `Function`, `Action` or `Trigger`, constrained |
| `contract_version` | The execution contract that the body was written against |
| `owning_entity_id` | Nullable; cascades with its record type |
| `body_json` | The canonical body of this host |

`__nendo_attribution` is created with it. It annotates `__nendo_operation` by
`(revision_id, ordinal)` with the root request, the triggering event, and the
trigger, action and step behind each generated write.

Storage never holds the parsed expression tree, and never holds a computed value
in an editable physical column. `NendoEntitySnapshot.DerivedFields` describes
calculated fields, separately from stored `Fields`. A derived field has no column
and cannot be edited. It carries a result that may be a value, empty, still
loading or an error.

A file that stores no definition keeps exactly the schema that it has. Opening,
inspecting or reading such a file never creates the table and never writes.

## Compatibility

Storing a definition raises the minimum host version of the file to **1.17.0** in
the same transaction as its canonical operation. It also brings the protected
layout to `…-retirement-behaviour-v1`. This is the whole ladder prefix, as a
first choice edit does. An older host refuses writable open. An ordinary open
does no rewrite or migration.

## Expressions

### What a formula may contain

A formula may contain declared names, scalar literals, typed arithmetic and
comparison, Boolean control, a choice (`? :`), and calls to the closed catalogue
or to a reusable function.

| Operator | Accepts | Produces |
| --- | --- | --- |
| `+` `-` `*` `%` | two numbers | whole number, or decimal if either side is |
| `/` | two numbers | **always decimal**, including whole ÷ whole |
| `=` `<>` | two values of the same kind | true/false |
| `<` `<=` `>` `>=` | two numbers, dates or texts | true/false |
| `and` `or` | true/false | true/false, short-circuiting |
| `not` `-` (unary) | true/false, number | the same kind |

Everything else refuses at validation: power, shifts, bitwise, `in`, `like`,
lists, member access, and any name that is not declared or catalogued. Text and
true/false values never become numbers. So `'2' + 1` and `true + 1` are refused.
They do not produce `"21"` or an exception on some record later.

Division answers in the decimal domain, because the integer division of the
evaluator converts to binary floating point first. That conversion would make
`1/3` an approximation, and it would make two different 17-digit whole numbers
compare equal. The conversion happens *before* the division. A conversion of the
result afterwards is too late.

### Function catalogue

| Function | Signature |
| --- | --- |
| `RoundEven(number, digits)` | decimal, 0–28 digits, halves to even |
| `RoundAway(number, digits)` | decimal, 0–28 digits, halves away from zero |
| `Date(text)` | invariant `yyyy-MM-dd`, a real calendar date |
| `DaysBetween(start, end)` | signed whole-number day difference |
| `Concat(a, b, …)` | 2–8 texts; joined size checked before allocating |
| `TextLength(text)` | how many characters a text value holds; empty text is zero |
| `Refuse(text)` | no value; reports `calculation-refused` with the text, in one outcome of a choice |

Every entry is a total function of its arguments. It uses no clock, no file, no
network and no host service. Because of this, a cached result and a replayed
result are the same.

The table is published at `nendo://application/vocabulary`. It is generated from
the same entries that the analyzer checks a call against. `TextLength` was added
after the other entries, to prove the path. A function, its declared signature
and its published description are one entry, and nothing else had to change. A
name that is not in the table is refused. It is not resolved. For this reason, a
formula that tries to use a network, a file or a clock is refused, and nobody had
to list those names.

`Refuse` is the one entry that produces nothing. It reports `calculation-refused`
with the sentence of the author. A formula can therefore decline a value that it
was given, for example a rating outside its scale, without the use of a division
error. It stands in for a value of the kind that the other outcome of its choice
produces. For this reason, the analyzer types it, not the catalogue. For the same
reason, validation refuses a refusal on its own, inside arithmetic, or in both
outcomes of a choice: a calculation that can never answer is a definition error.
An optional result does not suppress it, because it is the sentence of the
author, not an empty input.

### Values, empties and errors

A result is a typed **value**, a typed **empty**, or an **error**. An empty
carries its type, so a dependant reads an empty whole number and not an untyped
hole. Empty text and no text are different states.

An empty value is allowed as a whole result but never as an operand. If it is
used in arithmetic, a comparison, Boolean control, a function argument where the
function declared a value, or a related total, it **stops the formula**. The
declaration then decides what is reported ([ADR-0008, 2026-09-20 amendment](../decisions/0008-general-scripting-and-capability-isolation.md)).
A calculation or function declared to allow an empty result
(`resultNullable: true`) reports a typed **empty**. A calculation or function
declared always to produce a value reports `calculation-missing-input`. It also
reports this code when its formula ends empty. The result is never zero, never
false and never a previous result.

The empty result of a function reaches its caller as an empty argument, and the
declaration of the caller then decides. The codes are
`calculation-missing-input`, `-divide-by-zero`, `-overflow`, `-invalid-date`,
`-text-too-long`, `-limit-reached`, `-dependency-failed`, `-related-unavailable`
and `-refused`. Messages are owner-facing and carry no stack trace, type name or
expression internals. The message of a refusal is the text of the author.

The branch that is not taken is never evaluated: `true ? 7 : 1/0` is seven, and
`false and (1/0 = 0)` is false.

### Evaluator boundary

NCalc 7.1.0 parses the accepted syntax and supplies the checked arithmetic and
comparison semantics. Division is intercepted. Only the Engine references the
package, and its compile and build assets are withheld from consumers, so no
adapter or surface can name an NCalc type. NCalc brings Parlot with it. Parlot
ships props that would otherwise add a global `using` to every project in the
solution. Those props are withheld for the same reason.
`ExtendedNumerics.BigDecimal` arrives transitively and is not a scalar that this
contract defines. A value outside the five scalars is a failure. It is never
converted.

## Limits

The limits are host-owned. They are never read from stored data, and a file never
raises them.

| Resource | Ceiling | Enforced |
| --- | ---: | --- |
| Source length | 2,048 | Before the parser allocates |
| Lexical items | 128 | Preflight scan, punctuation included |
| Tree nodes / depth | 128 / 24 | During the typed walk |
| Parse nesting | 24 | Preflight, before a recursive parse |
| Definition graph depth | 8 | Over the whole candidate set, cache or not |
| Functions per file | 32 | Before the lookup table is built |
| Definitions per file, of every kind | 256 | Over the whole candidate set, before the graph is walked |
| Bindings or parameters | 16 | Before binding |
| Stable ID or alias length | 128 | Before compilation |
| Work units | 16,384 | Charged per visit, call, scan and change |
| Function calls | 64 | One counter across nested calls |
| Text length | 4,096 | On input, and before `Concat` allocates |
| Cached expressions | 16 | Cleared on reaching the cap |
| Related rows per chain | 256 | SQL LIMIT plus a charge per row read |
| Generated changes per chain | 64 | Before each generated write |
| Exact total | int64, or 28 significant decimal digits | On the fold; refused as `aggregate-not-representable`, never wrapped or rounded |

One budget spans an entire evaluation, every nested call and a whole causal
transaction. A deep call chain or a chain of triggers therefore gets no extra
allowance. If a chain reaches a ceiling, the whole transaction aborts. Counters
are checked, and every charge happens before the work that it pays for. The key
of a cached validated expression includes the limit policy, so a stricter run can
never reuse a result validated under a looser policy.

These limits bound parser input, recursion, primitive work and host functions.
This is containment by arithmetic. It is not a memory sandbox and not a
wall-clock guarantee. To widen a limit, new measurements are necessary. A passing
suite is not sufficient.

## What it costs

`tools/Review-Performance.ps1 -Mode MeasureBehaviour` measured these values on
2026-09-13. It used the generated benchmark fixtures with three calculations per
record:

- a text length;
- a bounded related count over 200 linked records;
- a Boolean that reads that count.

The fixtures also had one trigger whose action writes back to the record that
raised it.

| | 1,000 records | 10,000 records |
| --- | ---: | ---: |
| Open the file | 217 ms | 1,163 ms |
| Whole-file snapshot, cold | 49 ms | 474 ms |
| Whole-file snapshot, warm (p50 / p95) | 49 / 57 ms | 290 / 424 ms |
| One bounded page of 50 (p50 / p95) | 2.7 / 15.3 ms | 1.7 / 13.2 ms |
| A save that fires a chain (p50 / p95) | 12.0 / 13.6 ms | 11.6 / 13.4 ms |
| Allocated per chained save (median) | 423 KB | 418 KB |
| Cancellation observed and joined | 1.0 ms | 0.9 ms |
| Peak working set | 165 MB | 483 MB |

How the costs grow is more important than the numbers. **A bounded page and a
chained save do not grow with the file.** At ten times the records, both stay
near their small-file cost, because each reads a bounded set. **A whole-file
snapshot does grow**, by design. It evaluates the calculations of every record,
so it scales linearly and dominates both time and memory. A surface that reads a
page stays responsive on a large file. A surface that asks for the whole file
does not, and no ceiling in the table above prevents this.

These are Engine numbers from a dedicated child process: no window, no WebView
and no MCP envelope. The warm cache is uncontrolled, and a p95 over five or
twenty samples shows a trend, not a guarantee. They are measurements of this
machine on this day. They are recorded here so that a later change can be
compared against them.

### Measured, on this machine

A warm evaluation of `1/3 + 2.0` takes approximately 7 µs and allocates
approximately 3.9 KB. 1,000 evaluations took 7.5 ms and 3.9 MB. Cancelling a
running worker and joining it took between 0.03 ms and 0.3 ms, independent of
how long the worker had run. The test lane records these values but does not
assert them as thresholds. They are single-machine figures. The published
budgets are set in S9, against larger fixtures.

## Where the assertions live

`src/Nendo.Workbench/scripts/calculated-fields.test.mjs`,
`src/Nendo.Workbench/scripts/draft-state.test.mjs` and
`tests/Nendo.Desktop.Tests/WorkbenchBehaviourApprovalTests.cs` cover stage S7:

- Each result state reads as itself and not as a blank.
- An exact number survives the bridge.
- A dependency failure points at the input.
- An unrecognised state is treated as not yet known, and not as a value.
- A derived field is never offered an editor.
- A read record keeps its results when the window replaces the compiled plan.
- An unsaved form is kept read-only when the file, the approval or the session
  moves underneath it. A session that could not be read is never treated as
  unchanged.
- The shell says what the actions of a file do. Approving makes editing
  available, and withdrawing takes it back. The approval is remembered at the
  next launch, and another device has never been asked.

`tests/Nendo.LocalMcp.Tests/BehaviourAuthoringProtocolTests.cs` covers stage S8
over MCP:

- The published catalogue is the enforced catalogue, including the ceilings.
- An agent authors a reusable function, two dependent calculated fields, an
  action and its trigger in one change set, and the host accepts it.
- The schema publishes the calculated fields, and never as stored fields.
- The results read back as exact digits.
- A write by an agent is refused until this device approves, and no tool names a
  route to that approval.
- The removal of a definition that something still reads comes back as a
  reviewable diagnostic that names both.

`tests/Nendo.Engine.Tests/BehaviourWriteRouteTests.cs` covers stage S8,
obligation P4:

- A field edit, a multi-field form, a create, a declared command, a delete and a
  bounded paste each fire the same trigger, and each commits one revision.
- A paste spends one budget for the whole batch, not one per row. When the
  ceiling is reached, the paste refuses all of the batch.

`tests/Nendo.Engine.Tests/BehaviourCompensationTests.cs` covers stage S8,
obligation P6:

- Compensation reverses the typed edit and everything that the actions wrote.
- It does not run the actions again.
- The same key twice is one compensation.
- A revision that contains something declared irreversible is refused, the
  refusal names it, and nothing changes.
- Reversing a definition asks the device about the rules that it restores.

`tools/Gate-BehaviourAuthoring.mjs`, run by
`tools/Test-BehaviourAuthoringGate.ps1`, is the blackbox lane. It runs against
the real host with its own file and device-state root:

- The catalogue, the binding kinds, the aggregate rules and the ceilings are all
  readable from the wire.
- A published example authors a function, two dependent calculated fields, an
  action and its trigger, and the host accepts it.
- The schema publishes calculated fields apart from stored fields, with their
  formulas.
- A write by an agent is refused with `NENDO_BEHAVIOUR_NOT_APPROVED` until a
  person approves in the shell. No tool or resource names that route.
- After approval, the trigger runs and the results read back as exact digits, a
  third of a hundred included.
- A list ordered by a calculated field is refused. The refusal names the field
  and gives a remedy.
- A field shown only when a calculation says so raises the minimum host version
  of the file to 1.18.0.
- The four blind refusals of the 2026-09-13 review each name the item: a key of
  a sum invented and omitted, a choice value with its quotes inside it, a create
  missing a required field, and a delete blocked by references. The draft of the
  sum holds exactly what was accepted, and takes the right key afterwards.

`tests/Nendo.Engine.Tests/BehaviourEventTests.cs` covers what a generated write
raises:

- An action that writes to the record that triggered it settles. It does not run
  until the budget stops it.
- A step that changed nothing raises nothing.
- A generated event reports the fields that the step wrote, so a field
  subscription still has a meaning after a chain starts.

`tests/Nendo.Engine.Tests/BehaviourGrowthTests.cs` covers ADR-0008 obligation P8:

- A new pure function arrives through the ordinary catalogue, and the catalogue
  publishes it.
- A formula that names a network, file or clock function is refused because the
  set is closed. It is not refused because those functions were listed.
- A surface hides a node on a calculated Boolean, and is refused a stored one.
- Visibility cannot conceal Studio or grant write authority.
- Every published binding key is an accepted key, and every accepted key is
  published. Each shape reads with exactly its keys. With one more key, the
  refusal names that key. With one fewer key, the refusal names the missing key.

`tests/Nendo.Engine.Tests/BehaviourDefinitionTests.cs` and
`tests/Nendo.LocalMcp.Tests/AuthoringRecoveryTests.cs` replay the draft-freeze
finding of the 2026-09-13 review:

- A sum sent with an invented key, with no key and with the right key is refused
  twice and accepted once. Each refusal names the binding and `valueFieldId`.
  Throughout, the draft holds exactly what was accepted.
- A validate that throws leaves the draft able to answer `amend` and `reject`.
- The same misshapen body, read as a stored body, gets the stored remedy.

`tests/Nendo.LocalMcp.Tests/DataMutationProtocolTests.cs`:

- A choice value that arrived with its quote characters inside it is refused.
  The refusal names the field, lists the declared choices and repeats what
  arrived.
- The refusal of a create that is missing a required field names the field.
- The same field takes the value itself.

`tests/Nendo.Engine.Tests/SemanticDiffSummaryTests.cs`: a calculated field that
the same change set defines, or that is already in the file, is named as a
calculation in the review. It is not named as unknown. A `visibleWhen` names the
calculation that it reads.

`tests/Nendo.Engine.Tests/BehaviourEventTests.cs` and
`tests/Nendo.LocalMcp.Tests/BehaviourAuthoringProtocolTests.cs`:

- A write that fires an action reports the record that the action changed and
  its new version. It does this on the engine result and as `alsoChanged` on the
  wire.
- A replay, and the receipt read back through the unprivileged locator, name the
  same record without a version.
- A write that no action followed has nothing to name on either.
- An action that cannot run refuses the save. The refusal names the action, its
  step and its field, and nothing commits.

`tests/Nendo.Engine.Tests/ActionTargetTests.cs` pins the empty target of the
2026-09-14 review:

- A create with no reference commits one operation, reports no generated change
  and leaves the would-be target untouched.
- The same action with the reference set reaches the target.

`tests/Nendo.Engine.Tests/CalculatedFieldWriteTests.cs` and
`WritingACalculatedFieldIsRefusedAsCalculatedNotMissing` beside the protocol
tests:

- A single-field edit, a form save and a create that name a calculated field are
  each refused as `field-calculated`. The refusal names the calculation, and
  nothing commits.
- A field that is neither stored nor calculated is still not found.

`src/Nendo.Workbench/scripts/summary-tiles.test.mjs`:

- A total beyond what the host holds exactly is a settled refusal, and no Retry
  is offered.
- A cancelled or busy read is still offered Retry.

`tests/Nendo.Engine.Tests/BehaviourSurfaceTests.cs` covers stage S7 on a custom
surface:

- A form binds a calculated field beside a stored one and carries its result.
- A related list resolves the calculated fields of the *related* record type.
- Sorting, filtering, grouping, dating a calendar, totalling and assigning each
  refuse a calculated field, and the refusal names it.
- A form of only calculated fields is refused.
- A calculation that cannot be done still serializes, so one failed result
  cannot make a whole surface unreadable.

`tests/Nendo.Desktop.Tests/WorkbenchCancellationTests.cs` covers stage S7 off the
UI thread:

- Every method that can reach a native picker or a XAML element stays on the
  thread of the window, and an unreadable message stays with it.
- A stop answers only after the work has stopped.
- A stop reaches the work itself, so a cancelled create leaves no file.
- Stopping one request does not stop another.

`tools/Journey-Behaviour.mjs`, run by `tools/Test-JourneyPilot.ps1`, covers
stage S7 in the real WinUI/WebView2 host. It runs against the live DOM and an
isolated device-state root:

- A file with automatic actions is not editable until this device approves it.
- The panel says what will happen to the data.
- A calculation that divides by zero reads `Cannot calculate`, and Studio is
  still reachable.
- Values read exactly.
- The approval control is reachable and usable from the keyboard.
- Approving makes editing available.
- One real form edit fires the action and moves every calculation that depends
  on it.
- The approval survives a restart.
- Light and Dark are captured.

`tests/Nendo.Engine.Tests/BehaviourProposalTests.cs` covers ADR-0008 lane D4,
stage S5:

- Reviewing expands the actions and leaves the active file untouched.
- Promotion applies the reviewed effects exactly once, in one revision, without
  re-running the triggers.
- A record that a condition only read, or a record created after review, each
  makes the plan stale and refuses.
- The reviewed plan is persisted, and a tampered plan is refused.
- A definition-only promotion writes to no record.
- A repeated promotion applies nothing twice.
- Promotion is not a way around approval.
- Approval of the current behaviour does not approve a proposal that replaces
  it.

`tests/Nendo.Engine.Tests/BehaviourGrantTests.cs` and
`tests/Nendo.Desktop.Tests/DesktopBehaviourGrantTests.cs` cover stage S6:

- An unapproved file reads, calculates, exports and refuses to edit.
- Approving, editing and revoking round-trip.
- Consent withdrawn mid-save aborts the whole transaction, and leaves no record,
  revision or receipt.
- Each of the six bound fields, on its own, makes a grant not apply.
- A change to what an action writes withdraws the consent given for the old
  action.
- A calculations-only file needs no consent.
- Reopening asks the host again, and does not rely on a remembered answer.
- Definitions installed without consent stay installed and inspectable.
- A Duplicate and a Fork each ask for their own approval.
- A backup carries no approval.
- Unreadable, oversized or edited grant documents approve nothing.

`tests/Nendo.Engine.Tests/BehaviourScalarTests.cs` covers ADR-0008 lane D1, with
26 cases:

- integer division that stays in the decimal domain over a 48-pair cross
  product;
- precision loss detected behind a Boolean;
- decimal scale and boundaries;
- checked overflow on every arithmetic operator;
- empty-versus-zero and empty-versus-false;
- no text or Boolean coercion;
- laziness;
- dates;
- culture independence;
- nested reusable functions that bind by stable ID;
- the closed-vocabulary refusals.

It also keeps the **failure oracle**. The same expressions, evaluated without the
adapter, still return Double `0.3333333333333333` and still collapse
`9007199254740993` to `9007199254740992`. If that control stops failing, the
reason for the interception has changed.

`tests/Nendo.Engine.Tests/BehaviourLimitTests.cs` covers ADR-0008 lane D2, with
19 cases:

- every ceiling below, at and above its boundary;
- a warm cache that cannot answer a stricter request or hide a deep definition
  graph;
- adversarial inputs under a 60-second watchdog, where a probe that must be
  abandoned is a failure;
- cancellation that reaches the worker and is joined, and is not only no longer
  waited for.

D2.01 and D2.02 need a real transaction and arrive with S4.

`tests/Nendo.Engine.Tests/BehaviourActionTests.cs` covers ADR-0008 lane D3 plus
D2.01 and D2.02, against a real file through the ordinary coordinator:

- a two-field edit that runs both triggers once as four operations in one
  revision;
- reassignment that moves both parents;
- creation and deletion;
- an injected failure after each action, which leaves no record, version,
  revision, attribution row or success receipt;
- a no-op that raises nothing;
- a blocked condition that keeps the edit while its own action does not run;
- a failing action input that rolls back everything, including the write of the
  earlier action;
- cancellation before commit;
- a lost response that resolves from the durable receipt without repeated
  effects;
- both ceilings, which refuse and do not half-apply, including a self-sustaining
  trigger chain.

`tests/Nendo.Engine.Tests/BehaviourCalculationTests.cs` covers:

- dependent calculations and a reusable function that follow an edit;
- renames and reopening that leave results unchanged;
- a zero denominator that keeps valid input and recovers when corrected;
- a dependant that reports its failed input;
- related create/delete/reassignment that moves both parents;
- aggregate rules for empty and overflowing totals;
- the scan ceiling, which refuses a partial total;
- every read route agreeing, while no read route writes.

`tests/Nendo.Engine.Tests/BehaviourDefinitionTests.cs` covers:

- round-trip and reopen without rewriting the file;
- digest determinism and sensitivity;
- renames that leave bindings untouched;
- recursive and invalid definitions that refuse before anything is installed;
- referenced-definition removal;
- a file without behaviour that never grows the table;
- an unknown contract and a damaged body that both block editing while data
  stays readable;
- the derived-field descriptor, which never appears as a stored field.
