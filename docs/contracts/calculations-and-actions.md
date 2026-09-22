# Calculations and actions contract

What a stored behaviour definition is, how it is validated, and what a file that
holds one requires of its host.

Implementation contract within [ADR-0008](../decisions/0008-general-scripting-and-capability-isolation.md).
It defines restricted expressions and local actions, not an extension platform.
The execution semantics this contract starts from are recorded in
[adr-0008-semantics.md](../design/adr-0008-semantics.md).

**Delivered: stages S1-S6.** Definitions and their protected storage, the bounded
expression runtime, calculated fields over real records, automatic actions inside
the initiating transaction, this device's consent gating whether those actions may
run at all, and reviewed proposals that promote exactly what was reviewed.

**Delivered: stage S7.** Studio shows a record's calculated fields with their
formula and their four result states, in the record page and as a read-only column
in the table; a custom surface binds a calculated field wherever it binds a stored
one; File status carries the approval panel with its approve and withdraw routes;
an unsaved form survives a file moving underneath it; and evaluation runs away from
the UI thread with a stop that waits for the work to actually stop. The real-host
journey drives all of this through the actual WinUI/WebView2 host
(`tools/Journey-Behaviour.mjs`).

The automated half of the accessibility checks — keyboard reachability, focus, and
the names and headings assistive technology reads — is asserted in that journey and
recorded in its `behaviour-state.json`. The half a person must do is scripted under
[what a person sees](#what-a-person-sees); **the owner ran it on 2026-09-13 and
reported all four checks passing**, which is what satisfies ADR obligation **P7**.
That result is reported, not measured here: it is a person's judgement of whether
this is usable, and nothing in this repository can stand in for it.

**Delivered: stage S8.** The behaviour catalogue is published through
`nendo://application/vocabulary`, generated from the tables the Engine enforces; an
agent authors calculations, functions, actions and triggers with
`behaviour.setDefinition` and `behaviour.removeDefinition` through ordinary
proposals, and reads the results back exactly. Every production write route fires the
same triggers under one shared budget. Compensating a causal revision reverses the
initiating edit and everything its actions wrote, together, without running them
again. And the growth path is exercised: one new bounded pure function and one
read-only consumer of the calculation service, both through the machinery that
already existed.

## What each ADR obligation rests on

| Obligation | Evidence |
| --- | --- |
| **P1** agent authors, host accepts, Studio and surfaces agree | `BehaviourAuthoringProtocolTests`, `BehaviourSurfaceTests`, `BehaviourCalculationTests`, and the real-host journey reading the same numbers on screen |
| **P2** related create, delete, update, reassignment; cycles; no partial totals | `BehaviourCalculationTests`, `BehaviourEventTests` |
| **P3** a failed calculation keeps the input; a failed action rolls back | `BehaviourCalculationTests`, `BehaviourActionTests`, and the journey reading `Cannot calculate` with Studio still reachable |
| **P4** every write route shares staging, order, no-op, budget and permissions | `BehaviourWriteRouteTests` |
| **P5** missing, mismatched, revoked and corrupt consent; copy, restore and recovery | `BehaviourGrantTests`, `DesktopBehaviourGrantTests`, and the journey approving on a real device-state root |
| **P6** causal attribution, same-key retries, lost responses, safe compensation | `BehaviourActionTests`, `BehaviourProposalTests`, `BehaviourCompensationTests` |
| **P7** keyboard, focus, screen reader, Light and Dark, latency and memory at scale | `tools/Journey-Behaviour.mjs` for the automated half, [what it costs](#what-it-costs) for the measurements, and the owner's run of [the lane a person has to run](#the-lane-a-person-has-to-run) on 2026-09-13 for the half only a person can judge |
| **P8** a new pure function and a read-only consumer on the same engine and catalogue | `BehaviourGrowthTests` |

## Execution contract version

Every definition records the contract it was written against. The only version
this host implements is `behaviour-1`.

A file whose stored definitions name any other contract is inspectable and its
data stays readable, but editing is disabled — reported as the open finding
`behaviour-contract-mismatch`. A stored body that does not parse back into a
valid typed definition reports `behaviour-unreadable` and disables editing the
same way. Neither is repaired, migrated or partially interpreted: a half-loaded
formula would compute a number nobody authored.

## The four definition kinds

One protected table holds all four, keyed by stable definition ID.

| Kind | Carries |
| --- | --- |
| Calculation | Owning entity and derived field ID, display name, result scalar and nullability, expression source, ordered bindings, called function aliases |
| Function | Display name, ordered typed parameters, result scalar and nullability, expression body, called function aliases |
| Action | Display name, ordered typed steps |
| Trigger | Entity ID, subscribed events, optional relevant stored-field IDs, optional Boolean condition with its own bindings, and the action it runs |

Stable IDs use letters, digits, hyphen, underscore and dot, at most 128
characters. Display names are 1–200 characters and are never what an expression
binds to — renaming a record type or field changes no stored definition.

### Scalars

Calculation inputs and results are `Integer` (Int64), `Decimal` (.NET decimal),
`Boolean`, `Text` or `Date` (calendar `DateOnly`), each optionally null.

Stored `DateTime`, `Uuid` and `Reference` values remain valid data but are not
expression values. A reference resolves a binding; it is not an object a formula
can reach into. Adding a scalar domain requires its own semantics and tests.

### Bindings

A binding is the only way a name in an expression reaches a value. Every kind
carries explicit stable entity, field and relationship IDs.

Every binding carries `bindingId`, `kind` and `entityId`; the rest of its keys
depend on the shape. The table is `NendoBindingShape.All`, and it is the one the
codec refuses against, the vocabulary publishes and a test holds together — a key
that is published is accepted, and one that is accepted is published.

| Shape | Reaches | Its own keys |
| --- | --- | --- |
| `SameRecordField` | A stored field on the record being calculated | `fieldId`, `resultType`, `nullable` |
| `SameRecordCalculation` | Another calculated field on the same record | `calculationId`, `resultType`, `nullable` |
| `ReferenceTraversal` | One declared hop along a reference field, then a stored field on the target | `referenceFieldId`, `relatedEntityId`, `fieldId`, `resultType`, `nullable` |
| `RelatedAggregate` · `Count` | How many records reference this one | `aggregate`, `relatedEntityId`, `relatedReferenceFieldId` |
| `RelatedAggregate` · `FilteredCount` | How many of them have a Boolean field true | … and `predicateFieldId` |
| `RelatedAggregate` · `Sum` | The exact total of a numeric field over them | … and `valueFieldId`, `resultType` |

The initial aggregate catalogue is closed:

- **Count** — counts members; Int64 zero for an empty collection.
- **FilteredCount** — counts members whose `predicateFieldId` Boolean is true.
- **Sum** — checked typed sum of `valueFieldId`, an Integer or Decimal field;
  typed zero for an empty collection. The field must be **required**: a member
  with no value is an error, not a zero, so installation refuses a sum over an
  optional field rather than promising a total that the first empty value breaks.

A key outside a shape's list is refused by name, with the list, and a required
key that is missing is asked for by name with what it is for — `Binding 'seeds'
(RelatedAggregate Sum) needs valueFieldId — the Integer or Decimal field it
totals.` An unknown key used to be dropped silently, which is how a reviewer sent a
sum three ways and learned nothing each time.

An aggregate is never null. A null member value propagates as a calculation error
rather than being skipped, and a collection larger than the related-row ceiling
returns an error rather than a total of the part that was read: an incomplete
total presented as a complete one is worse than no total.

### Actions and triggers

An action step is `SetField`, `CreateRecord` or `DeleteRecord`, targeting either
the record that raised the event or the record reached by following one declared
reference field from it. A step writes ordinary typed record data only — never a
definition, identity, grant, schema change or anything outside the file.

A trigger subscribes to any of created, updated and deleted. Relevant field IDs
narrow an update subscription and therefore require it.

**An action and its trigger are validated as a pair, at install.** An action does
not know the record type it runs against — only the trigger names one — so a step
that binds the event record while writing a field of the referenced one used to
install cleanly and fail at the next save, by which time the person saving is not
the person who wrote the action. Installing either half now resolves every step of
the pair against the schema the way the planner resolves it at run time, and
refuses with `action-target-mismatch`, naming the action, the step, the record type
the step reaches and the field it has not got. A reference the trigger's record
type does not have, or one that is not bound, is refused the same way rather than
failing inside the planner. Only the pairs the operation touches are checked, so a
definition written before this existed cannot refuse an unrelated install.

A refused behaviour install leaves the open file readable. The behaviour table is
created inside the mutation that installs the first definition, so a refusal later
in that mutation rolls it away; whether the file has one is remembered per open
store and is put back to unknown on a rollback. Without that, the first refused
install left every later read of that session asking for a table that was not
there (F-070).

Subscriptions apply to **net** stored-value changes across the whole request, not
to individual low-level writes. A form that sets four fields is one update, and a
field set back to the value it already held is no change at all — so it raises
nothing, generates nothing, and burns no record version.

A step that follows a relationship resolves it from **both** sides of the event,
which is what makes reassignment correct: moving a task between projects updates
the project it left as well as the one it joined. An empty reference names no
record: the step writes nothing, the save still commits, and the write result's
`alsoChanged` carries nothing for it. That is the rule, not an error — a note in
no folder has no folder to stamp — and a file that needs every event to reach a
target makes the reference field required. The vocabulary states it under
`actionTargets`, beside the step kinds; an outside review created a record with
an empty target reference expecting a refusal, got a committed write reporting no
effect, and nothing it had read had said so.

Every generated write goes through the same operation dispatch an author's own
write uses, so it is checked against the same record versions, reference targets,
required fields and retirement rules. A trigger is not a privileged path into the
data, and may only create, set or delete ordinary records — never a definition,
identity, schema or anything outside the file.

## Validation

A definition is validated against the whole candidate set it would leave behind,
never in isolation, because a cycle and a dangling call are properties of the
graph. Installation refuses when:

- a call or a trigger's action names a definition the file does not hold, or one
  of the wrong kind;
- definitions call each other in a loop, or nest more than 8 deep;
- a binding names a missing field, a field of a different stored type, a
  relationship pointing at another record type, or an unbound reference;
- a binding reads an optional field without declaring itself nullable;
- a calculated field's ID collides with a stored field on the same record type;
- a stable ID, alias, parameter ID or step ID repeats within one definition;
- the definition names a contract version this host does not implement.

Removing a definition that something else still references is refused with
`definition-referenced` unless the same ordered change set also removes or
rewires every dependant. Removing one that is absent is `definition-not-found`.

## Reading a calculated field

A calculated field is computed on demand, from whatever state the reader sees —
committed data for an ordinary read, the transaction's staged data during a save.
Nothing is cached between reads, so there is no invalidation that could show
yesterday's number as today's.

Each record's calculations are evaluated in dependency order, and a calculation
whose input is itself in error reports `calculation-dependency-failed` rather than
a value of its own: a stale number beside a broken input is how a wrong figure
gets trusted. One failing calculation does not affect the record's other fields or
its validity — a zero denominator saves the input and shows an error, and
correcting the input recovers with no repair step.

Every read route computes the same way and agrees: a full snapshot, a bounded
query and a read-only open all report the same result for the same record. Results
travel as `NendoRecordSnapshot.Calculations`, separate from stored `Values`, and
carry the same exact-number transport as stored values, so a decimal never becomes
a floating-point double on the way to Studio, a surface or an agent.

Reading, rendering and opening never write. Computing a calculation raises no
revision, records no record event and starts no action.

Each record gets its own budget while reading, because a list is a series of
independent evaluations. A save is the opposite: one budget spans the whole chain.

## Automatic actions

An edit and every action it triggers are one SQLite transaction and one revision.
Either all of it is durable or the file is untouched — there is no window in which
a task is marked done but its project's total has not caught up, and no repair
pass that could fail separately.

The order is fixed:

1. Capture the state of every record the request names, before anything is staged.
2. Stage **all** initiating operations, so the file shows the complete edit and no
   half-formed intermediate.
3. Derive logical events by comparing before with staged, and queue them in stable
   (record type, record) order.
4. For each event, select triggers by stable ID in ordinal order; evaluate the
   condition against current staged state; run the action's steps in order, each
   observing the previous ones' effects.
5. Generated writes raise their own events, appended to the same queue.
6. Re-check cancellation, write one causal revision and the original request's
   receipt in the same transaction, and commit once.

**A calculation error and an action failure are different things.** A condition
that cannot be evaluated blocks its own action and is reported; the initiating
edit still commits, because the owner's typed values are valid whether or not a
rule about them could be decided. A failure while computing what an action should
*write* — or an exhausted budget, or cancellation — aborts everything, including
earlier steps that had already succeeded and the edit itself. No success receipt
exists for a chain that did not commit. The refusal names the action, the step and
the field it could not write, and says nothing changed; it reaches the Workbench
under the calculation's own code and an agent as `NENDO_CALCULATION_*` with the
same sentence. Until it did, an assignment bound to the event record while writing
to the referenced one — the mistake the published example warns about — installed
cleanly and then surfaced on the first save as an internal error.

**A committed write says what its actions changed.** `NendoApplyResult.GeneratedChanges`
lists each other record the chain wrote, with `created`, `updated` or `deleted` and
the version it now holds, the last write to a record winning; MCP publishes it as
`alsoChanged`. An idempotent replay, and a receipt read back later through
`GetMutationReceiptAsync`, name the same records — rebuilt from the revision's
operations that carry an attribution row — with the version left null: the file
may have moved since, and a number there would be read as current. A caller
recovering from a lost response learns which records to read, and reads one before
writing to it. Until 2026-09-14 both carried nothing, and the attribution table was
written and never read.

### Identity, retries and history

The request's own payload digest keys idempotency; the revision records the digest
of what was actually committed, generated writes included. A retry under the same
key returns the original receipt and runs nothing again, including after the
process that made the request never saw the answer. Changing the payload under an
existing key still refuses.

Generated operation IDs and any record IDs an action creates are derived from the
chain's identity and position, never generated fresh, so the same chain always
names the same operations.

Each generated operation carries its attribution in `__nendo_attribution`: the
root request, the triggering event, and the trigger, action and step that produced
it, plus a digest of the behaviour it ran under. It annotates the ordinary history
rather than forming a log of its own, so "why did this change?" is answered by the
same evidence as "what changed?".

## Approval

A file that carries a trigger cannot be edited until this device has agreed its
actions may run. A file with calculations but no trigger needs no approval:
calculating reads data and writes none.

Consent names exactly one thing, and every field of it is load-bearing:

| Field | Why it is part of the question |
| --- | --- |
| Application ID | Approving one application is not approving another |
| Instance ID | A copy of a file is a different file |
| Behaviour digest | Changing what an action does is a new question |
| Contract version | A host that would evaluate the rules differently inherits nothing |
| Definition revision | Conservative: any definition change asks again |
| Capabilities | Read off the actions a trigger can reach — create, update, delete |

Matching is exact equality across all six, so there is nowhere to be lenient.

**Where it lives.** Consent is device state, kept beside the other per-user
preferences under `%LocalAppData%\Nendo` and never inside a `.nendo` file. A file
therefore cannot carry its own permission: sending someone a file never sends them
the decision to trust it, and a Duplicate, a Fork, a backup or a copy on another
machine all arrive unapproved and ask again.

**Failing closed.** No grant is not an implicit grant. An Engine embedding that
supplies no authority refuses; a grant document that is missing, oversized,
malformed or edited approves nothing and says so. Treating "I could not tell" as
"yes" is how a damaged state file becomes somebody else's actions running.

**When it is checked.** Before any action runs, and again at the commit boundary
while the transaction still holds the write lock. Consent withdrawn at any point
during a save — including while its actions were running — aborts the whole
transaction rather than being noticed afterwards. The revocation generation is
compared as well as the grant, so a withdrawal cannot be outrun by work in flight.

**What refusal looks like.** The file stays fully readable, keeps its bounded
calculations, and can be exported and backed up. Only editing is withheld, with
the precondition code `behaviour-not-approved`. The trigger is never quietly
disabled so the save can proceed: a file that has silently stopped doing what it
says it does is worse than one that asks a question.

Installing a definition is a reviewed change to the file, not an occasion to run
it. Nothing fires on open, on render, on approval, or on rebuilding a cache.

## Reviewed proposals

A proposal is judged against a clone and applied to the live file some time later.
What makes that safe is that the second step **replays** the first step's output,
not that it recomputes the same thing and trusts it to agree.

**Reviewing** applies the change set to the physical clone with the actions
running, so the review shows their effects rather than only the operations an
author asked for. The clone is allowed to run them because it is a throwaway copy
nobody edits — that is the host choosing to simulate, not a file granting itself
permission. Reviewing changes nothing in the active file.

**The reviewed plan** is written into the proposal workspace beside the clone, and
holds the ordered generated operations with their attribution, the behaviour
digest they ran under, the consent promoting them will need, the record versions
every result depended on, and the data revision the collections were counted at.
It survives the session that made it; promotion reads it back from disk rather
than trusting memory, and a workspace somebody edited fails its digest instead of
promoting something nobody approved.

**Promotion** checks, under the coordinator's authority and inside one
transaction: the file's identity, its definition revision, the records the change
set touches, **the records a condition merely read**, and **the data revision**.
The last two are what per-operation version checks cannot see — a total that was
right at review time is wrong if a record it counted has since changed, or if a
matching record has since been created. A stale plan is refused and asks for a new
preview; nothing is ever recomputed to make acceptance succeed.

Promotion then applies exactly the reviewed operations with expansion switched
off. Running the triggers again would stack fresh effects on top of the reviewed
ones. Generated IDs and ordering were frozen at review, so a repeated promotion
under the same identity resolves through the ordinary receipt and applies nothing
twice.

**Consent still applies.** Because promotion replays rather than re-runs, the
chain's own approval gate never fires, so promotion checks the plan's recorded
requirement instead. That requirement describes the behaviour the file will hold
*after* promotion, so approving today's rules does not approve a proposal that
rewrites them. A definition-only proposal emits no data events and performs no
backfill: installing rules is a reviewed change, not an occasion to run them.

## What a person sees

A calculated field is shown, not offered for editing, and it carries its formula
beneath the value. It is deliberately not styled as a disabled input: a disabled
control says "not right now", where a calculated field is not something anyone
edits at all.

The four states stay four states on screen — a value, `Not set`, `Calculating…`
and `Cannot calculate` with the reason beside it. Showing an empty or failed
result as a blank cell beside stored blanks is how a number nobody computed gets
read as one, and then trusted. A calculation that failed because its *input*
failed reads `Unavailable` and names the input, so the reader looks in the right
place.

Calculated numbers travel through the same exact-number transport as stored ones:
a calculated decimal is the value most likely to be a total somebody relies on, so
it is the last one that should lose digits to a JavaScript number.

**On a custom surface** a calculated field binds wherever a stored one does: a
record page, a list column, a board card, a related list of another record type.
What it may not do is drive a bounded query. `orderByFieldId`, `filterClause`,
`groupByFieldId`, a calendar's `dateFieldId`, a `summaryTile`'s field and a command
step all refuse a calculated field by name, with code `NUI214`. The database
decides those over every matching record, and a calculated field has no column to
read — so honouring one would mean either computing the whole collection or
quietly ordering the loaded page and calling it the collection's order. A
`recordForm` made only of calculated fields is refused too (`NUI215`): it would
offer Save with nothing to save.

A grant binds the whole definition revision, deliberately and conservatively, so
**any** accepted definition change asks again — including one that alters no rule at
all, such as adding a screen. That is a real cost of the current binding rather than
an oversight: a more selective digest would have to cover every function, formula and
schema binding that affects what an action does, and would need its own invalidation
tests before it could be trusted to ask less often.

**Approval** appears in File status and on the Agent page — where the proposal
that put the actions in the file was just accepted — in terms of what will happen to
the owner's data — "it can add records, change records" — rather than as a
permission grant, with the behaviour's short digest so two different sets of rules
visibly differ. Accepting such a proposal says so in the same breath, and the
frame's status pill reads *Approval needed* for as long as editing is off for that
reason; a person who accepted on the Agent page was otherwise told "no changes
waiting" and left to find the consent under Health. Approving and withdrawing are
shell routes that write device state; they are not mutations, never enter the
file's history, and have no MCP equivalent. The production gate asserts the local
MCP surface cannot name them. They stay usable when editing is off, because that is
the state they exist to get out of.

**The formula is an authoring detail.** Studio's editor and grid show it beside
the value, because that is where a formula is written and read. A finished screen in
the Use view shows the value and the *Calculated* mark only: the expression names
the author's binding aliases — `SeedsPerGram(gpt)` — which mean something to the
author and nothing to a person using the screen.

**A total the host cannot hold exactly stays unavailable.** A summary tile whose
sum passes int64, or 28 significant digits for a decimal, reads *Unavailable* with
the reason and offers no Retry: the refusal is deterministic, and a retry would
only recompute it. The tile's read keeps the host's code (`aggregate-not-representable`,
`aggregate-not-exact`) so that a transient failure — cancelled, file busy — still
offers one. This is a real ceiling: a stored integer may reach int64 max, and a
total of several such cannot be shown.

**The review says which fields are calculated.** A proposal's semantic diff
resolves calculated fields — the file's and the ones the same change set defines —
so a screen binding one reads *Show the calculated field Seeds per gram*, and a
`visibleWhen` reads *Show this only when Needs retest is yes*. It used to read
*Bind to unknown field "seedsPerGram"* seven times in a proposal that had just
defined all seven, on the one screen whose job is to earn the person's trust.

**An unsaved form outlives a refusal.** A confirmed refusal leaves the file
unchanged, so the draft is still the best copy of the person's intent and the form
is left standing. When the session moves underneath it instead — another file, a
withdrawn approval, a read-only transition, or a session that could not be read at
all — the typing stays on screen and saving is switched off, with the reason said
out loud. Values typed against one file are never applied to another.

**Work happens away from the UI thread.** A bounded calculation is real arithmetic
inside an ordinary read, and awaiting it does not move it. Every host method that
cannot touch a native picker or a XAML element runs on a worker; the rest stay on
the thread that owns the window. Work that runs long offers Stop, and the host
answers a stop only after the work has actually stopped — a cancel that returns
early reports an idle file that is still being written.

### The lane a person has to run

Automated checks cover reachability, focus and the names and headings assistive
technology reads. They do not cover whether any of it is usable. Run this by hand
and record it separately; a passing journey is not this evidence.

**Run by the owner on 2026-09-13 against the published Release payload, with an
isolated file and device-state root. All four checks passed.** Re-run it whenever
what a person sees changes — a new state, a new control, a new refusal — because the
automated lane will keep passing through a change that makes this one fail.

1. Open a file that carries automatic actions. Using only the keyboard, reach File
   status, read the approval panel, approve, and confirm editing becomes available.
2. With a screen reader, read one record page that has a value, an empty result and
   a failed one. Each must be distinguishable without seeing the colour, and the
   failed one must say why.
3. Cause a refusal on a form with unsaved input. Confirm focus lands on the message,
   that the typing is still there, and that a screen reader reads what happened.
4. Repeat 1-3 in Light, Dark, and with the system following the OS setting.

## Reversing a save

A causal revision is the edit a person made and everything its actions wrote, in one
transaction. Compensating it reverses all of it, in the opposite order, using the
versions the revision itself recorded rather than the versions the file holds now —
so a record something else has moved since conflicts loudly, and an exact retry after
a lost response rebuilds the same compensation rather than a different one.

The actions do not run again over the reversal. Re-expanding would compute a stored
field from the state the reversal was still in the middle of producing, and write it
on top of the operation being undone.

An operation that declares itself irreversible refuses the whole revision by name —
including `data.createRecord`, whose retained state is deliberately not treated as a
licence to un-create. Reversing a definition is supported, and it asks the device
about the rules it restores: consent given for the definition that is being undone
does not carry to the one coming back.

## Reaching it from an agent

`nendo://application/vocabulary` carries a `behaviour` section, generated from the
same tables the analyzer and the planner enforce: the closed function set with each
one's argument and result types, the operators as they are written in a formula, the
scalar domain, the four binding kinds, what each aggregate does with an empty
collection and with a value it cannot read, the action step kinds, the action target
kinds — each stating what it selects at the edges, including that an empty reference
selects no record — the capabilities
and the ceilings. There is no second MCP-only catalogue to drift from it, and
`nendo://application/examples` carries a change set an agent can send as it stands.

The `bindings` section publishes every shape with its keys, a `RelatedAggregate`
once per aggregate, and each aggregate names its `fieldKey`; `nendo://application/examples`
includes a `Sum` so `valueFieldId` appears in a change set an agent can send as it
stands. The surface vocabulary's `propertyNotes` says what `visibleWhen` takes — a
calculated Boolean field's `fieldId`, not its definition ID.

A body that does not fit its shape is refused at `add_operations`, naming the
mutation, the operation, the binding and the key, and nothing enters the draft. It
used to be found at validate, where the throw left the draft frozen and the
documented remedy, `amend`, refused: ninety operations for one guessed key.

A record type's calculated fields appear under `derivedFields` on its schema, never
under `fields`, and each record's results travel beside its values with an exact
`numericLexeme` — a calculated decimal is the value most likely to be a total
somebody relies on, so it is the last one that should reach a client as a rounded
JavaScript number. A data write that fired an action returns `alsoChanged`: the
other records the chain wrote, with their new versions; a replay and a receipt name
the same records without versions. A write that names a calculated field is refused
as `NENDO_FIELD_CALCULATED`, naming the calculation, rather than as a field that does
not exist — it did read as one until 2026-09-14, because the write path looked only
at stored columns.

Authoring is not consent. A file whose actions run automatically is not editable
until the person at this device approves it, and an agent's ordinary write is refused
with the same message a person's edit gets. No tool, resource or payload field
reaches that approval.

## Canonical operations and digests

Two closed canonical operations, both on the definition lane:

| Operation | Effect | Reversibility |
| --- | --- | --- |
| `behaviour.setDefinition` | Installs a definition at its stable ID, creating or replacing it | `ReversibleWithRetainedState` |
| `behaviour.removeDefinition` | Removes one by stable ID and stated kind | `ReversibleWithRetainedState` |

Both take an `expectedDefinitionRevision` and conflict exactly like every other
definition operation. Whole-definition convenience requests expand into these
before any diff, digest, history entry or promotion sees them.

The canonical payload embeds the definition's canonical body. That body is
written from the validated typed record with properties in a fixed order and
collections in declared order, never from dictionary iteration, so the digest of
a definition is stable across processes and runs. Declared order is part of the
definition: two calculations differing only in binding order are different
definitions with different digests.

Evidence retains the previous body, contract version and kind, so the inverse of
an install is the definition that was there before — or its removal when there
was none.

## Storage

`__nendo_behaviour`, created the first time a file stores a definition:

| Column | Notes |
| --- | --- |
| `definition_id` | Primary key, the stable ID |
| `definition_kind` | `Calculation`, `Function`, `Action` or `Trigger`, constrained |
| `contract_version` | The execution contract the body was written against |
| `owning_entity_id` | Nullable; cascades with its record type |
| `body_json` | This host's canonical body |

`__nendo_attribution`, created alongside it, annotates `__nendo_operation` by
`(revision_id, ordinal)` with the root request, triggering event and the trigger,
action and step behind each generated write.

Never the parsed expression tree, and never a computed value in an editable
physical column. Calculated fields are described by
`NendoEntitySnapshot.DerivedFields`, separately from stored `Fields`: a derived
field has no column, cannot be edited, and carries a result that may be a value,
empty, still loading or an error.

A file that stores no definition keeps exactly the schema it has. Opening,
inspecting or reading one never creates the table and never writes.

## Compatibility

Storing a definition raises the file's minimum host version to **1.17.0** in the
same transaction as its canonical operation, and brings the protected layout to
`…-retirement-behaviour-v1` — the whole ladder prefix, as a first choice edit
does. An older host refuses writable open; an ordinary open performs no rewrite
or migration.

## Expressions

### What a formula may contain

Declared names, scalar literals, typed arithmetic and comparison, Boolean control,
a choice (`? :`) and calls to the closed catalogue or to a reusable function.

| Operator | Accepts | Produces |
| --- | --- | --- |
| `+` `-` `*` `%` | two numbers | whole number, or decimal if either side is |
| `/` | two numbers | **always decimal**, including whole ÷ whole |
| `=` `<>` | two values of the same kind | true/false |
| `<` `<=` `>` `>=` | two numbers, dates or texts | true/false |
| `and` `or` | true/false | true/false, short-circuiting |
| `not` `-` (unary) | true/false, number | the same kind |

Everything else refuses at validation: power, shifts, bitwise, `in`, `like`,
lists, member access, and any name not declared or catalogued. Text and true/false
values never become numbers, so `'2' + 1` and `true + 1` are refused rather than
producing `"21"` or an exception on some record later.

Division answers in the decimal domain because the evaluator's own integer
division converts to binary floating point first. That would make `1/3` an
approximation and make two different 17-digit whole numbers compare equal. The
conversion happens *before* dividing; converting the result afterwards is too late.

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

Every entry is a total function of its arguments — no clock, no file, no network,
no host service — which is what makes a cached result and a replayed result the
same thing.

The table is published at `nendo://application/vocabulary`, generated from the same
entries the analyzer checks a call against. `TextLength` was added after the rest, to
prove the path: a function, its declared signature and its published description are
one entry, and nothing else had to change. A name that is not in the table is refused
rather than resolved — which is why a formula reaching for a network, a file or a
clock is refused without anybody listing those by name.

`Refuse` is the one entry that produces nothing: it reports `calculation-refused`
carrying the author's own sentence, so a formula can decline a value it was given —
a rating outside its scale — without borrowing a division error to do it. It stands in
for a value of whatever kind the other outcome of its choice produces, which is why it
is typed by the analyzer rather than by the catalogue, and why a refusal on its own,
inside arithmetic, or in both outcomes of a choice is refused at validation: a
calculation that can never answer is a definition error. It is not quietened by an
optional result; it is the author's sentence, not an empty input.

### Values, empties and errors

A result is a typed **value**, a typed **empty**, or an **error**. Empty carries
its type, so a dependant reads an empty whole number rather than an untyped hole.
Empty text and no text are different states.

An empty value is allowed as a whole result but never as an operand: used in
arithmetic, a comparison, Boolean control, a function's argument where the function
declared a value, or a related total, it **stops the formula**, and the declaration
decides what is reported ([ADR-0008, 2026-09-20 amendment](../decisions/0008-general-scripting-and-capability-isolation.md)).
A calculation or function declared to allow an empty result (`resultNullable: true`)
reports a typed **empty**; one declared always to produce a value reports
`calculation-missing-input`, and reports it too when its formula ends empty. Never
zero, never false, never a previous result. A function's empty result reaches its
caller as an empty argument, and the caller's own declaration then decides. Codes are
`calculation-missing-input`, `-divide-by-zero`, `-overflow`, `-invalid-date`,
`-text-too-long`, `-limit-reached`, `-dependency-failed`, `-related-unavailable`
and `-refused`. Messages are owner-facing and carry no stack trace, type name or
expression internals; a refusal's message is the author's own.

The branch not taken is never evaluated: `true ? 7 : 1/0` is seven, and
`false and (1/0 = 0)` is false.

### Evaluator boundary

NCalc 7.1.0 parses the accepted syntax and supplies the checked arithmetic and
comparison semantics; division is intercepted. The package is referenced only by
the Engine, and its compile and build assets are withheld from consumers, so no
adapter or surface can name an NCalc type. Parlot, which NCalc brings with it,
ships props that would otherwise add a global `using` to every project in the
solution; those are withheld for the same reason. `ExtendedNumerics.BigDecimal`
arrives transitively and is not a scalar this contract defines — a value outside
the five scalars is a failure, never something to convert.

## Limits

Host-owned, never read from stored data, and never raised by a file.

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
transaction, so neither a deep call chain nor a chain of triggers buys extra
allowance. Reaching a ceiling mid-chain aborts the whole transaction. Counters are checked, and
every charge happens before the work it pays for. A cached validated expression's
key includes the limit policy, so a stricter run can never reuse a result
validated under a looser one.

These bound parser input, recursion, primitive work and host functions. That is
containment by arithmetic — not a memory sandbox, and not a wall-clock
guarantee. Widening one needs new measurements, not a passing suite.

## What it costs

Measured on 2026-09-13 by `tools/Review-Performance.ps1 -Mode MeasureBehaviour`, on
the generated benchmark fixtures with three calculations per record — a text length,
a bounded related count over 200 linked records, and a Boolean reading that count —
plus one trigger whose action writes back to the record that raised it.

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

The shape matters more than the numbers. **A bounded page and a chained save do not
grow with the file** — both stay near their small-file cost at ten times the records,
because each reads a bounded set. **A whole-file snapshot does**, by design: it
evaluates every record's calculations, so it scales linearly and dominates both time
and memory. A surface that reads a page stays responsive on a large file; one that
asks for the whole file does not, and no ceiling in the table above will save it.

These are Engine numbers from a dedicated child process: no window, no WebView and no
MCP envelope. The warm cache is uncontrolled and a p95 over five or twenty samples is
a shape, not a guarantee. They are measurements of this machine on this day, and they
are here so a later change can be compared against something rather than argued about.

### Measured, on this machine

A warm evaluation of `1/3 + 2.0` takes roughly 7 µs and allocates about 3.9 KB;
1,000 of them took 7.5 ms and 3.9 MB. Cancelling a running worker and joining it
took between 0.03 ms and 0.3 ms regardless of how long it had been running. These
are recorded by the test lane rather than asserted as thresholds, and they are
single-machine figures — the published budgets are set in S9, against larger
fixtures.

## Where the assertions live

`src/Nendo.Workbench/scripts/calculated-fields.test.mjs`,
`src/Nendo.Workbench/scripts/draft-state.test.mjs` and
`tests/Nendo.Desktop.Tests/WorkbenchBehaviourApprovalTests.cs` — stage S7: each
result state reads as itself rather than as a blank, an exact number survives the
bridge, a dependency failure points at the input, an unrecognised state is treated
as not yet known rather than as a value, and a derived field is never offered an
editor; a read record keeps its results when the window replaces the compiled plan;
an unsaved form is retained read-only when the file, the approval or the session
moves underneath it, and a session that could not be read is never treated as
unchanged; the shell says what a file's actions do, approving makes editing
available, withdrawing takes it back, the approval is remembered next launch, and
another device has never been asked.

`tests/Nendo.LocalMcp.Tests/BehaviourAuthoringProtocolTests.cs` — stage S8 over MCP:
the published catalogue is the enforced one, including the ceilings; an agent authors
a reusable function, two dependent calculated fields, an action and its trigger in one
change set and the host accepts it; the schema publishes the calculated fields and
never as stored ones; the results read back as exact digits; an agent's write is
refused until this device approves, and no tool names a route to that approval;
removing a definition something still reads comes back as a reviewable diagnostic
naming both.

`tests/Nendo.Engine.Tests/BehaviourWriteRouteTests.cs` — stage S8, obligation P4: a
field edit, a multi-field form, a create, a declared command, a delete and a bounded
paste each fire the same trigger and each commit one revision; and a paste spends one
budget for the whole batch rather than one per row, refusing all of it when the
ceiling is reached.

`tests/Nendo.Engine.Tests/BehaviourCompensationTests.cs` — stage S8, obligation P6:
compensating reverses the typed edit and everything the actions wrote; it does not run
them again; the same key twice is one compensation; a revision containing something
declared irreversible is refused by name and changes nothing; and reversing a
definition asks the device about the rules it restores.

`tools/Gate-BehaviourAuthoring.mjs`, run by `tools/Test-BehaviourAuthoringGate.ps1`
— the blackbox lane, against the real host with its own file and device-state root:
the catalogue, the binding kinds, the aggregate rules and the ceilings are all
readable from the wire; a published example authors a function, two dependent
calculated fields, an action and its trigger, and the host accepts it; the schema
publishes calculated fields apart from stored ones, with their formulas; an agent's
write is refused with `NENDO_BEHAVIOUR_NOT_APPROVED` until a person approves in the
shell, and no tool or resource names that route; after approval the trigger runs and
the results read back as exact digits, a third of a hundred included; a list ordered
by a calculated field is refused by name with a remedy; a field shown only when a
calculation says so raises the file's minimum host version to 1.18.0; and the
2026-09-13 review's four blind refusals — a sum's key invented and omitted, a choice
value with its quotes inside it, a create missing a required field, a delete blocked
by references — each name the thing, with the sum's draft holding exactly what was
accepted and taking the right key afterwards.

`tests/Nendo.Engine.Tests/BehaviourEventTests.cs` — what a generated write raises:
an action that writes to the record that triggered it settles instead of running until
the budget stops it, and a step that changed nothing raises nothing. A generated event
reports the fields the step actually wrote, so a field subscription still means
something once a chain has started.

`tests/Nendo.Engine.Tests/BehaviourGrowthTests.cs` — ADR-0008 obligation P8: a new
pure function arrives through the ordinary catalogue and is published by it; a formula
naming a network, file or clock function is refused because the set is closed, not
because those were listed; a surface hides a node on a calculated Boolean and is
refused a stored one; visibility cannot conceal Studio or grant write authority; and
every published binding key is an accepted one and every accepted key is published —
each shape read with exactly its keys, refused by name with one more, and asked by
name with one fewer.

`tests/Nendo.Engine.Tests/BehaviourDefinitionTests.cs` and
`tests/Nendo.LocalMcp.Tests/AuthoringRecoveryTests.cs` — the 2026-09-13 review's
draft-freeze finding, replayed: a sum sent with an invented key, with no key and with
the right key is refused twice naming the binding and `valueFieldId` and accepted once,
the draft holding exactly what was accepted throughout; a validate that throws leaves
the draft answering `amend` and `reject`; and the same misshapen body read as a stored
one gets the stored remedy.

`tests/Nendo.LocalMcp.Tests/DataMutationProtocolTests.cs` — a choice value that
arrived with its quote characters inside it is refused naming the field, listing the
declared choices and echoing what arrived; a create missing a required field names
it; and the same field takes the value itself.

`tests/Nendo.Engine.Tests/SemanticDiffSummaryTests.cs` — a calculated field defined
in the same change set, or already in the file, is named as a calculation in the
review rather than as unknown, and `visibleWhen` names the calculation it reads.

`tests/Nendo.Engine.Tests/BehaviourEventTests.cs` and
`tests/Nendo.LocalMcp.Tests/BehaviourAuthoringProtocolTests.cs` — a write that fires
an action reports the record the action changed and its new version, on the engine
result and as `alsoChanged` on the wire; a replay, and the receipt read back through
the unprivileged locator, name the same record without a version; a write no action
followed has nothing to name on either; and an action that cannot run refuses the
save naming itself, its step and its field, and commits nothing.

`tests/Nendo.Engine.Tests/ActionTargetTests.cs` — the 2026-09-14 review's empty
target, pinned: a create with no reference commits one operation, reports no
generated change and leaves the would-be target untouched; the same action with the
reference set reaches it.

`tests/Nendo.Engine.Tests/CalculatedFieldWriteTests.cs` and
`WritingACalculatedFieldIsRefusedAsCalculatedNotMissing` beside the protocol tests
— a single-field edit, a form save and a create naming a calculated field are each
refused as `field-calculated` naming the calculation, nothing commits, and a field
that is neither stored nor calculated is still not found.

`src/Nendo.Workbench/scripts/summary-tiles.test.mjs` — a total past what the host
holds exactly is a settled refusal, offered no Retry; a cancelled or busy read still
is.

`tests/Nendo.Engine.Tests/BehaviourSurfaceTests.cs` — stage S7 on a custom surface:
a form binds a calculated field beside a stored one and carries its result; a
related list resolves the *related* record type's calculated fields; sorting,
filtering, grouping, dating a calendar, totalling and assigning each refuse one by
name; a form of only calculated fields is refused; and a calculation that cannot be
done still serializes, so one failed result cannot make a whole surface unreadable.

`tests/Nendo.Desktop.Tests/WorkbenchCancellationTests.cs` — stage S7 off the UI
thread: every method that can reach a native picker or a XAML element stays on the
window's thread and an unreadable message stays with it; a stop answers only after
the work has actually stopped; a stop reaches the work itself, so a cancelled
create leaves no file; and stopping one request does not stop another.

`tools/Journey-Behaviour.mjs`, run by `tools/Test-JourneyPilot.ps1` — stage S7 in
the real WinUI/WebView2 host, against the live DOM and an isolated device-state
root: a file with automatic actions is not editable until this device approves it;
the panel says what will happen to the data; a calculation that divides by zero
reads `Cannot calculate` with Studio still reachable; values read exactly; the
approval control is reachable and usable from the keyboard; approving makes editing
available; one real form edit fires the action and moves every calculation that
depends on it; the approval survives a restart; and Light and Dark are captured.

`tests/Nendo.Engine.Tests/BehaviourProposalTests.cs` — ADR-0008 lane D4, stage S5:
reviewing expands the actions and leaves the active file untouched; promotion
applies the reviewed effects exactly once, in one revision, without re-running the
triggers; a record a condition only read, or a record created after review, each
makes the plan stale and refuses; the reviewed plan is persisted and a tampered
one is refused; a definition-only promotion writes to no record; a repeated
promotion applies nothing twice; promotion is not a way around approval; and
approving today's behaviour does not approve a proposal that replaces it.

`tests/Nendo.Engine.Tests/BehaviourGrantTests.cs` and
`tests/Nendo.Desktop.Tests/DesktopBehaviourGrantTests.cs` — stage S6: an
unapproved file reads, calculates, exports and refuses to edit; approving,
editing and revoking round-trip; consent withdrawn mid-save aborts the whole
transaction leaving no record, revision or receipt; each of the six bound fields
individually makes a grant not apply; changing what an action writes withdraws
the consent given for the old one; a calculations-only file needs none; reopening
asks the host again rather than remembering; definitions installed without
consent stay installed and inspectable; a Duplicate and a Fork each ask for their
own approval; a backup carries none; and unreadable, oversized or edited grant
documents approve nothing.

`tests/Nendo.Engine.Tests/BehaviourScalarTests.cs` — ADR-0008 lane D1, 26 cases:
integer division staying in the decimal domain over a 48-pair cross product,
precision loss detected behind a Boolean, decimal scale and boundaries, checked
overflow on every arithmetic operator, empty-versus-zero and empty-versus-false,
no text or Boolean coercion, laziness, dates, culture independence, nested
reusable functions binding by stable ID, and the closed-vocabulary refusals. It
also keeps the **failure oracle**: the same expressions evaluated without the
adapter still return Double `0.3333333333333333` and still collapse
`9007199254740993` to `9007199254740992`. If that control stops failing, the
reason the interception exists has changed.

`tests/Nendo.Engine.Tests/BehaviourLimitTests.cs` — ADR-0008 lane D2, 19 cases:
every ceiling below, at and above its boundary; a warm cache unable to answer a
stricter request or to hide a deep definition graph; adversarial inputs under a
60-second watchdog, where a probe that must be abandoned is a failure; and
cancellation that reaches the worker and is joined, not merely stopped waiting
for. D2.01 and D2.02 need a real transaction and arrive with S4.

`tests/Nendo.Engine.Tests/BehaviourActionTests.cs` — ADR-0008 lane D3 plus D2.01
and D2.02, against a real file through the ordinary coordinator: a two-field edit
running both triggers once as four operations in one revision; reassignment moving
both parents; creation and deletion; an injected failure after each action leaving
no record, version, revision, attribution row or success receipt; a no-op raising
nothing; a blocked condition keeping the edit while its own action stands down; a
failing action input rolling back everything including the earlier action's write;
cancellation before commit; a lost response resolving from the durable receipt
without repeating effects; and both ceilings refusing rather than half-applying,
including a self-sustaining trigger chain.

`tests/Nendo.Engine.Tests/BehaviourCalculationTests.cs` — dependent calculations
and a reusable function following an edit, renames and reopening leaving results
unchanged, a zero denominator keeping valid input and recovering when corrected, a
dependant reporting its failed input, related create/delete/reassignment moving
both parents, aggregate rules for empty and overflowing totals, the scan ceiling
refusing a partial total, and every read route agreeing while never writing.

`tests/Nendo.Engine.Tests/BehaviourDefinitionTests.cs` — round-trip and reopen
without rewriting the file, digest determinism and sensitivity, renames leaving
bindings untouched, recursive and invalid definitions refusing before anything is
installed, referenced-definition removal, a file without behaviour never growing
the table, an unknown contract and a damaged body both blocking editing while
data stays readable, and the derived-field descriptor never appearing as a stored
field.
