# Calculations and actions contract

This contract states what a stored behaviour definition is, how it is validated,
how it runs, and what a file that holds one requires of its host. It is an
implementation contract within
[ADR-0008](../decisions/0008-general-scripting-and-capability-isolation.md). It
defines restricted expressions and local actions. It does not define an extension
platform.

A file holds calculated fields, reusable functions, automatic actions and the
triggers that run them. An agent authors them with `behaviour.setDefinition` and
`behaviour.removeDefinition` through ordinary proposals. Studio and custom surfaces
show calculated fields with their results; File status and the Agent page carry
this device's approval of the actions.

## Execution contract version

Every definition records the contract that it was written against. The only
version that this host implements is `behaviour-1`.

If the stored definitions of a file name any other contract, the file is
inspectable and its data stays readable, but editing is disabled, reported as the
open finding `behaviour-contract-mismatch`. If a stored body does not parse back
into a valid typed definition, the host reports `behaviour-unreadable` and
disables editing in the same way. Neither case is repaired, migrated or partially
interpreted: a half-loaded formula would compute a number that nobody authored.

## The four definition kinds

One protected table holds all four kinds. The key is the stable definition ID.

| Kind | Carries |
| --- | --- |
| Calculation | Owning entity and derived field ID, display name, result scalar and nullability, expression source, ordered bindings, called function aliases |
| Function | Display name, ordered typed parameters, result scalar and nullability, expression body, called function aliases |
| Action | Display name, ordered typed steps |
| Trigger | Entity ID, display name, subscribed events, optional relevant stored-field IDs, optional Boolean condition with its own bindings, and the action it runs |

Stable IDs use letters, digits, hyphen, underscore and dot, and are at most 128
characters. A name that a formula reads — a binding alias, a function parameter
or a call alias — uses letters, digits and underscore only, and does not start
with a digit, because a formula reads `unit-price` as `unit` minus `price` and
refuses `line.total`. Display names are 1–200 characters. An expression never
binds to a display name, so a rename of a record type or a field changes no stored
definition.

Install rules are checked when a definition is installed or changed, not when a
stored one is read. Putting back a definition that History recorded is not
authoring: it skips the formula-name rule, the traversal's nullability, relevant
fields, the duplicate calculation, and the action pair's binding start, result fit
and required fields. Every other rule still applies.

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
on the shape. `kind`, `aggregate`, `resultType` and the other named values take a
name the contract defines, never a number: `"9"` or `"0"` is refused with the
names that are allowed. The table is `NendoBindingShape.All`. The codec refuses
against this table, the vocabulary publishes it, and a test keeps the two in
agreement: a key that is published is accepted, and a key that is accepted is
published.

| Shape | Reaches | Its own keys |
| --- | --- | --- |
| `SameRecordField` | A stored field on the record being calculated | `fieldId`, `resultType`, `nullable` |
| `SameRecordCalculation` | Another calculated field on the same record | `calculationId`, `resultType`, `nullable` |
| `ReferenceTraversal` | One declared hop along a reference field, then a stored field on the target | `referenceFieldId`, `relatedEntityId`, `fieldId`, `resultType`, `nullable` |
| `RelatedAggregate` · `Count` | How many records reference this one | `aggregate`, `relatedEntityId`, `relatedReferenceFieldId`; optional `acrossSubtree`, `resultType`, `nullable` |
| `RelatedAggregate` · `FilteredCount` | How many of them have a Boolean true | … and `predicateFieldId` or `predicateCalculationId`; optional `acrossSubtree`, `resultType`, `nullable` |
| `RelatedAggregate` · `Sum` | The exact total of a number over them | … and `valueFieldId` or `valueCalculationId`, `resultType`; optional `acrossSubtree`, `nullable` |
| `SubtreeAggregate` · `Count` | How many records sit under this one in its declared hierarchy | `aggregate`; optional `includeSelf`, `resultType`, `nullable` |
| `SubtreeAggregate` · `FilteredCount` | How many of them have a Boolean true | … and `predicateFieldId` or `predicateCalculationId`; optional `includeSelf`, `resultType`, `nullable` |
| `SubtreeAggregate` · `Sum` | The exact total of a number over them | … and `valueFieldId` or `valueCalculationId`, `resultType`; optional `includeSelf`, `nullable` |
| `HierarchyPath` | The record's dotted place in its declared hierarchy, 1.2.3 | optional `prefix`, `resultType` (Text), `nullable` (false) |

If a key is outside the list of a shape, the refusal names the key and gives the
list. If a required key is missing, the refusal names the key and states its
purpose: `Binding 'hours' of 'projects.totalHours' (RelatedAggregate Sum) needs
valueFieldId — the Integer or Decimal field it totals.`

**Subtrees** ([ADR-0019](../decisions/0019-hierarchies-in-the-schema.md)). A
`SubtreeAggregate` folds the record's descendants at every level of its record
type's declared hierarchy, and with `includeSelf: true` the record as well.
`acrossSubtree: true` on a `RelatedAggregate` folds the related records that point
at this record or at anything under it: the applications that support a capability
or any part of it. Both are installed only on a record type that declares a
hierarchy, and while one is in place the hierarchy cannot be removed
(`hierarchy-field-in-use`). They are bounded by the hierarchy's limit of 10,000
descendants (`limits.hierarchy.maximumAggregatedDescendants`) rather than the
related-row budget, which one subtree would exceed. Past it they are an error,
never a partial total: a subtree of more than 10,000 records is an error in
either, however few records point into it, and `acrossSubtree` also refuses past
10,000 related records. The tree read and `descendantOf` do not share this limit.
The keys appear in a stored definition only when true, so a definition without
them keeps its canonical bytes and digest.

**Paths** ([ADR-0020](../decisions/0020-unique-and-generated-fields.md)). A
`HierarchyPath` reads the record's 1-based position among its siblings and each
ancestor's, joined with dots from the top (`1.2.3`), after an optional literal
`prefix` of at most 16 characters (`CAP-1.2.3`). Siblings count in the tree read's
order: the hierarchy's order field, a missing order last, then record ID. It is
Text and never empty, is installed only on a record type that declares a
hierarchy, and holds the hierarchy in place like a subtree aggregate. It is
calculated on every read, so it follows a move at once. That makes it a display
code and not an identity; a code people repeat is a sequence
([relationships](relationships.md#unique-fields)). One level costs one indexed
count.

The aggregate catalogue is closed:

- **Count**: counts members. Int64 zero for an empty collection.
- **FilteredCount**: counts members whose predicate Boolean is true.
- **Sum**: checked typed sum of an Integer or Decimal value. Typed zero for an
  empty collection. A stored value field must be **required**; a member with no
  value is an error, not a zero, so installation refuses a sum over an optional
  field.

**A calculated member.** A `Sum` may total, and a `FilteredCount` test, a
calculated field of each member instead of a stored one: `valueCalculationId` or
`predicateCalculationId` names the calculation by its definition ID, and exactly
one of the field key and the calculation key is given. The calculation belongs to
the member record type, produces the aggregate's kind (Boolean for a filtered
count; Integer or Decimal for a sum), and is not the calculation itself, so a total
of its own value is a loop refused at installation. Each member's value is worked
out when the total is, through the same source, so inside a save it reads the
staged rows and the reviewed plan observes each one. Every member costs one
related row against the ceiling, a subtree's included. An empty member, or one
that cannot be calculated, makes the total an error whose message names the
calculation, never a partial total. A stored `valueFieldId` that names no stored
field is refused with the hint to name its calculation in `valueCalculationId`.

An aggregate is never null. A null member value propagates as a calculation error.
It is not skipped. If a collection is larger than the related-row ceiling, the
aggregate returns an error, not a total of the part that was read.

**A plain count on a read has no related-row ceiling.** A `RelatedAggregate`
`Count` evaluated for a read is the store's own count over the reference's index:
it reads no row, leaves nothing out, and costs one unit of work. A `FilteredCount`
and a `Sum` read every member's value, so they keep the ceiling, and so does every
aggregate evaluated inside a save's chain, where a reviewed plan has to see each
record it counted.

### Actions and triggers

An action step is `SetField`, `CreateRecord` or `DeleteRecord`. It targets either
the record that raised the event, or the record that one declared reference field
from that record reaches. A step writes ordinary typed record data only. It never
writes a definition, identity, grant, schema change or anything outside the file.

**A create step's links.** A formula produces no reference, so a `CreateRecord`
step takes `links`, each a reference field of the new record and a target:
`EventRecord`, the record that raised the event, or `ReferencedRecord` with the
event record's `referenceFieldId`. At installation, with its trigger, the field
must be a reference of the created type bound to the linked record's type, and
`EventRecord` is refused when the trigger also runs on a deletion, when there is no
record to link to. At run time the link takes the record's current version, as a
person's create does, and the plan observes it. A referenced field that is empty
leaves the link empty. Only a create step takes links, a field is written once per
step, and a step without links stores no `links` key.

A trigger subscribes to any of created, updated and deleted. Relevant field IDs
narrow an update subscription, and therefore they require it. Each one names an
active stored field of the record type the trigger listens to. An unknown ID is
refused with `field-not-found`, and a calculated field with `field-calculated`,
whose sentence lists the stored fields its formula reads: a calculated field is
never stored, so it never changes, and the trigger would never run on an update.
`conditionExpression` is text, or null or left out for a trigger with no
condition; `false`, a number or an object is refused rather than read as no
condition. `events` is text, `"Created, Updated"`, as the canonical body stores
it, or a list of the names, as an author sends it. A list a body has nothing in,
such as `bindings`, `callAliases`, `relevantFieldIds` or `conditionBindings`, may
be left out.

**An action and its trigger are validated as a pair, at install.** An action does
not know the record type that it runs against; only the trigger names one. The
installation of either half resolves every step of the pair against the schema,
as the planner resolves it at run time, and refuses with `action-target-mismatch`.
The refusal names the action, the step, the record type that the step reaches and
the field that this record type does not have. A reference missing from the
trigger's record type, or not bound, refuses the same way. Only the pairs that the
operation touches are checked. The pair check also refuses, with the same code:

- an assignment binding that does not start from the record the step evaluates it
  on: the record a set step writes, or the record that raised the event for a
  create step. The planner reads the binding's table by that record's ID;
- a create step that reads the event record itself (a same-record field or
  calculation, a reference traversal or a hierarchy path) when its trigger also
  runs on a deletion. A total of related records still reads;
- an assignment whose result can never be stored in its field: a number or a
  true/false into a text, date, timestamp, UUID or reference field, text or a date
  into a number or a true/false, a date into a timestamp, UUID or reference field,
  a number into a true/false, and a decimal into a whole-number field unless the
  formula is `RoundEven(…, 0)` or `RoundAway(…, 0)`. Text may still fill a date,
  timestamp, UUID or choice field; that is checked per value when the step runs;
- a create step that leaves a required, active field of its new record empty,
  unless a sequence numbers that field.

A refused behaviour install leaves the open file readable. The behaviour table is
created inside the mutation that installs the first definition, and a refusal
later in that mutation rolls the table back with it. Each open store remembers
whether the file has the table, and a rollback resets this to unknown.

Subscriptions apply to **net** stored-value changes across the whole request, not
to individual low-level writes. A form that sets four fields is one update. A field
set back to the value that it already held is no change: it raises nothing,
generates nothing, and uses no record version.

A step that follows a relationship resolves it from **both** sides of the event,
so when a task moves between projects the step updates the project that the task
left and the project that it joined. An empty reference names no record: the step
writes nothing, the save still commits, and `alsoChanged` carries nothing for the
step. This is not an error. A file that needs every event to reach a target makes
the reference field required. The vocabulary states this rule under
`actionTargets`, beside the step kinds.

Every generated write goes through the same operation dispatch as an author's own
write, so it is checked against the same record versions, reference targets,
required fields and retirement rules. A trigger is not a privileged path into the
data.

## Validation

A definition is validated against the whole candidate set that it would leave
behind, never in isolation, because a cycle and a dangling call are properties of
the graph. Installation refuses when:

- a call or the action of a trigger names a definition that the file does not
  hold, or a definition of the wrong kind;
- definitions call each other in a loop, or nest more than 16 deep;
- a reusable function's formula produces another kind than its declared
  `resultType`, naming the function: "Function 'fn.label' declares integer but its
  formula produces text."; or a definition calls such a function. A whole-number
  formula under a decimal declaration is accepted. A calculation declared decimal
  that calls it, directly or through functions declared decimal, computes in
  decimal, so a total past Int64 is answered rather than overflowing; every other
  caller (a calculation declared integer, an action's assignment, a trigger's
  condition) reads the whole number the formula produces. A stored function that
  breaks this rule keeps compiling, its callers typed by its formula;
- a binding names a missing field, a field of a different stored type, a
  relationship that points at another record type, or an unbound reference;
- a binding reads an optional field without declaring itself nullable, or follows
  an optional reference without declaring itself nullable. An unset reference reads
  as empty, so `IsEmpty(x) ? 0 : x` then gives the default;
- a trigger's relevant field is not an active stored field of its record type;
- a name a formula reads is not letters, digits and underscore, or starts with a
  digit;
- the ID of a calculated field collides with a stored field on the same record
  type, or two calculations of one record type share a field ID (the same ID on two
  record types is two fields). `schema.addField` refuses an ID a calculation of the
  same record type already uses;
- a stable ID, alias, parameter ID or step ID repeats within one definition;
- the definition names a contract version that this host does not implement.

**Retirement** is checked from the other side. A change that retires a record type
or field refuses with `retired-binding` while an installed calculation, trigger or
action still reads it, listens to it or writes it. A create step's links count as
uses of the reference they set and of the reference they follow, and a trigger's
relevant field counts as a use. The check runs over the final candidate, so the
same proposal may rewire or remove that behaviour and retire its target
([relationships](relationships.md#labels-choices-and-retirement)).

**A requirement change** is checked from the other side as well.
`schema.setFieldRequired` refuses with `field-requirement-in-use` when a field
becomes optional while a binding reads it without accepting an empty value (the
reference a traversal follows included), or a total or filtered count reads it from
each member, and when a field becomes required while a triggered create step leaves
it empty. The refusal names the definition and the field. Only the fields the
change touches are checked, over the final candidate. Install does not ask a create
step to fill a retired field or one a sequence numbers, so making a required field
active again (`schema.setRetired` false) and removing a field's sequence are checked
against create steps in the same way.

If something else still references a definition, its removal is refused with
`definition-referenced`, unless the same ordered change set also removes or
rewires every dependant. The removal of an absent definition is
`definition-not-found`.

## Reading a calculated field

A calculated field is computed on demand, from the state that the reader sees:
committed data for an ordinary read, the staged data of the transaction during a
save. Nothing is cached between reads.

The calculations of each record are evaluated in dependency order, each once per
evaluation. If the input of a calculation is itself in error, the calculation
reports `calculation-dependency-failed`, whatever it declares, and not a value of
its own. A trigger condition, an action's input and a calculated member of a total
work a calculation out the same way. One failing calculation does not affect the
other fields of the record or its validity. A zero denominator saves the input and
shows an error; when the input is corrected, the calculation recovers with no
repair step.

A failed dependency is named by its display name, and an empty input by the field
it reads, as the person sees them: "This depends on 'Hours spread', which could not
be calculated." and "'Doubled estimate' is empty, and this formula needs a value
for it."

Every read route computes in the same way and agrees: a full snapshot, a bounded
query and a read-only open report the same result for the same record. Results
travel as `NendoRecordSnapshot.Calculations`, separate from stored `Values`, with
the same exact-number transport as stored values, so a decimal never becomes a
floating-point double on the way to Studio, a surface or an agent.

Reading and rendering never write. Computing a calculation raises no revision,
records no record event and starts no action. Opening never writes either, except
that the person's own open of a file a crash left with an unfinished save, outside
a synced folder, has SQLite roll that save back
([ADR-0012](../decisions/0012-safe-mode-compatibility-and-migration.md)).

During a read, each record gets its own budget, because a list is a series of
independent evaluations. A save is different: one budget spans the whole chain.

## Automatic actions

An edit and every action that it triggers are one SQLite transaction and one
revision. Either all of it is durable or the file does not change. There is no
repair pass that could fail separately.

The order is fixed:

1. Capture the state of every record that the request names, before anything is
   staged. A record the request names is read for its events only when a trigger
   listens to its type.
2. Stage **all** initiating operations.
3. Derive logical events by comparing the state before with the staged state.
   Queue them in stable (record type, record) order.
4. For each event, select triggers by stable ID in ordinal order. Evaluate the
   condition against the current staged state. Run the steps of the action in
   order. Each step sees the effects of the previous steps.
5. Generated writes raise their own events, appended to the same queue. A
   generated event reports the fields that the step wrote.
6. Check cancellation again. Write one causal revision and the receipt of the
   original request in the same transaction. Commit once.

**A calculation error and an action failure are different things.** If a condition
cannot be evaluated, it blocks its own action and is reported; the initiating edit
still commits, because the typed values of the owner are valid whether or not a
rule about them could be decided. The write result carries each blocked condition
as `blockedConditions`: the trigger and its name, the record whose change raised
it, and the calculation code and sentence. The Workbench says it beside the save's
outcome, kept until the next action, and after a custom view's write; an agent's
write result carries it beside `alsoChanged`. It is not stored with the revision,
so a replay, a receipt, a proposal and its acceptance carry none, and History does
not show it. A limit the data itself reaches, such as a subtree past the
hierarchy's descendant bound or a record deeper than its hierarchy allows, blocks a
condition's action like a zero divisor.

These failures abort everything, including earlier steps and the edit itself:

- a failure while the host computes what an action should *write*;
- an exhausted budget: the save's work units, function calls, generated changes or
  related-row allowance, a condition's included. A spent budget is not an
  undecidable value;
- cancellation.

No success receipt exists for a chain that did not commit. The refusal names the
action, the trigger that ran it, the step and the field that it could not write,
and states that nothing changed. This holds for every refusal inside a step: a
formula, the budget, and the write itself, such as a create step's required field,
a date that is not a date, or a delete blocked by references. The refusal keeps its
own type and code. The Workbench receives it under the code of the calculation; an
agent receives it as `NENDO_CALCULATION_*` with the same sentence.

A ceiling says which allowance ran out: a save's, one record's read, or one
formula's check. An action that starts itself again until the change limit is told
so. The refusal also says what the budget had spent of every allowance against its
limit, names each related record's calculation it ran out inside ("It ran out
inside project.amount of record p1, inside entry.amount of record p1e30"), on a
save that named more than one record says how many shared the one budget, and on a
save names the step that spent most work ("The step that spent most was step rate
of action 'Entry defaults', with 236 work units."). An agent receives the same as
fields under `limit` in the refusal's `_meta`: `allowance`, each counter and its
limit, `path`, `heaviestStep` and `heaviestStepWorkUnits`. The refused charge is
not counted, so the allowance that ran out reads at or near its limit.

**A committed write says what its actions changed.**
`NendoApplyResult.GeneratedChanges` lists each other record that the chain wrote,
with `created`, `updated` or `deleted` and the version that the record now holds.
If the chain wrote a record more than once, the last write wins. MCP publishes this
list as `alsoChanged`. An idempotent replay names the same records, and so does a
receipt read back later through `GetMutationReceiptAsync`. Both are rebuilt from
the operations of the revision that carry an attribution row, and their version is
null, because the file may have changed since. A caller that recovers from a lost
response reads a record before it writes to it.

### Identity, retries and history

The payload digest of the request keys idempotency. The revision records the
digest of what was committed, generated writes included. A retry under the same key
returns the original receipt and runs nothing again, also when the process that
made the request never saw the answer. A change of the payload under an existing
key still refuses.

Generated operation IDs, and any record IDs that an action creates, are derived
from the identity and position of the chain, never generated fresh, so the same
chain always names the same operations.

Each generated operation carries its attribution in `__nendo_attribution`: the root
request, the triggering event, and the trigger, action and step that produced it,
plus a digest of the behaviour that it ran under. The attribution annotates the
ordinary history; it is not a separate log.

**History shows it.** `QueryRevisionOperationsAsync` returns each stored operation
with `Attribution` (`NendoOperationAttribution`): the trigger, action and step IDs
that were recorded, the record event that selected the trigger, and the trigger's
and action's display names as the file holds them now, read from the definitions'
bodies. A name is null once its definition has left the file; the ID still says
which it was. An operation the revision's author made has none. The whole-history
read that serves a read-only open carries the same. History's **View changes**
writes "made by the automatic action" and the trigger's name beside each generated
operation, or "made by an automatic action no longer in this file" and the trigger
ID. Over MCP the revision-operations resource carries it
([mcp-interface.md](mcp-interface.md)).

## Approval

If a file carries a trigger, it cannot be edited until this device agrees that its
actions may run. A file with calculations but no trigger needs no approval, because
a calculation reads data and writes none.

Consent names exactly one thing, and every field of it is necessary:

| Field | Why it is part of the question |
| --- | --- |
| Application ID | Approval of one application is not approval of another |
| Instance ID | A copy of a file is a different file |
| Behaviour digest | A change to what an action does is a new question |
| Contract version | A host that would evaluate the rules differently inherits nothing |
| Definition revision | Conservative: any definition change asks again |
| Capabilities | Read from the actions that a trigger can reach: create, update, delete |

Matching is exact equality across all six fields. Because a grant binds the whole
definition revision, **any** accepted definition change asks again, including one
that alters no rule, such as adding a screen. A more selective digest would have to
cover every function, formula and schema binding that affects what an action does,
with its own invalidation tests.

**Where it lives.** Consent is device state, kept beside the other per-user
preferences in `actions\consent.json` under `%LocalAppData%\Nendo`
([ADR-0034](../decisions/0034-device-state-layout.md)), never inside a `.nendo` file. A file
therefore cannot carry its own permission. A Duplicate, a Fork, a backup or a copy
on another machine all arrive unapproved and ask again. Shared consent changes are
serialized across processes and merge with the current document inside the lock;
another file's approval cannot restore revoked consent or erase a new approval. A
durable revocation generation invalidates work already in progress after a revoke
and reapproval in another window. If persistence is unavailable, the explicit
choice applies only to this session and a notice states that it was not saved.

**Failing closed.** The absence of a grant is not an implicit grant. An Engine
embedding that supplies no authority refuses. A grant document that is missing,
oversized, malformed or edited approves nothing and reports this.

**When it is checked.** Consent is checked before any action runs and again at the
commit boundary, while the transaction still holds the write lock. If consent is
withdrawn at any point during a save, including while its actions run, the whole
transaction aborts. The revocation generation is compared as well as the grant.

**What refusal looks like.** The file stays fully readable, keeps its bounded
calculations, and can be exported and backed up. Only editing is withheld, with the
precondition code `behaviour-not-approved`. Undo is not withheld: History's Undo
and an agent's `nendo.data.undo_revision` of its own revision still work while the
actions await approval, because an undo puts back what a revision recorded and runs
no action. The trigger is never disabled silently to let the save continue.

Installing a definition is a reviewed change to the file. It is not an occasion to
run the definition. Nothing fires on open, on render, on approval, or on a cache
rebuild.

**Where the person approves.** In File status, and on the Agent page beside the
accepted proposal that installed the actions. The panel says what will happen to
the owner's data ("it can add records, change records") and shows the behaviour's
short digest, so two sets of rules visibly differ. The status pill reads *Approval
needed* while editing is off for that reason. Consent is withdrawn under Agent or
Health. Approving and withdrawing stay usable when editing is off.

They are shell routes that write device state, not mutations, and never enter the
file's history. Below the Unattended access level they have no MCP equivalent;
the production gate asserts that the local MCP surface cannot name the grant store
or the approval service. At Unattended, `nendo.change_set.accept` records this
device's consent for the actions the accepted change installs, through a host
delegate that takes no arguments, and its `behaviourApproved` result says so
([mcp-interface.md](mcp-interface.md)).

## Reviewed proposals

A proposal is judged against a clone and applied to the live file later. The
second step **replays** the output of the first. It does not recompute the result
and trust it to agree.

**Reviewing** applies the change set to the physical clone with the actions
running, so the review shows the effects of the actions and not only the operations
an author asked for. The clone may run the actions because it is a throwaway copy
that nobody edits; this is the host choosing to simulate. Reviewing changes nothing
in the active file.

**The reviewed plan** is written into the proposal workspace beside the clone. It
holds:

- the ordered generated operations with their attribution;
- the behaviour digest that they ran under;
- the consent that their promotion will need;
- the record versions that every result depended on;
- the data revision at which the collections were counted.

Promotion reads the plan back from disk and does not trust memory. A workspace
that somebody edited fails its digest, and nothing is promoted.

**Promotion** checks, under the authority of the coordinator and inside one
transaction:

- the identity of the file;
- its definition revision;
- the records that the change set touches;
- **the records that a condition only read**, a field read across a reference
  included, and the record a create step's formulas read, which is the record that
  raised the event;
- **the data revision**.

Per-operation version checks cannot see the last two. A total that was correct at
review time is wrong if a record that it counted changed, or a matching record was
created, after the review. A stale plan is refused and asks for a new preview.
Nothing is recomputed to make acceptance succeed.

The data-revision dependency remains even when an evaluated condition read an empty
collection and left no external record in its read set, because a new member can
change that condition. A data change set in a file with any trigger captures the
behaviour it ran under, whether or not a trigger matched, so every such proposal
goes stale when any record changes before acceptance. That is conservative by
intent.

Promotion then applies exactly the reviewed operations with expansion switched
off; running the triggers again would add effects on top of the reviewed ones.
Generated IDs and ordering were fixed at review, so a repeated promotion under the
same identity resolves through the ordinary receipt and applies nothing twice.

**Consent still applies.** Promotion replays and does not re-run, so the chain's
approval gate never fires; promotion checks the plan's recorded requirement
instead. That requirement describes the behaviour that the file will hold *after*
promotion, so approval of the current rules does not approve a proposal that
rewrites them. A definition-only proposal emits no data events and does no
backfill.

## What a person sees

A calculated field is shown but not offered for editing. It carries its formula
below the value in the Studio editor and grid. It is not styled as a disabled
input: nobody edits a calculated field at all. A finished screen in the Use view
shows only the value and the *Calculated* mark, because the formula names the
author's binding aliases.

The four states stay four separate states on screen: a value, `Not set`,
`Calculating…`, and `Cannot calculate` with the reason beside it. A calculation
that failed because its *input* failed reads `Unavailable` and names the input.
Calculated numbers use the same exact-number transport as stored numbers.

**On a custom surface** a calculated field binds wherever a stored one does: a
record page, a list column, a board card, a related list of another record type.
It also filters and sorts: a `filterClause` compares it as a stored field of its
result type is compared (`contains` for a Text result only, never `descendantOf`),
and `orderByFieldId` orders by it. The host works out every record the query's
stored filters leave, with its calculations, and hands the database the ones that
pass and their order, so a page, its continuation, the list's count and every tile
over it agree. A value that could not be worked out matches no filter, not even
`isNull`, and sorts last. Past 10,000 records
(`NendoQueryLimits.MaximumCalculatedQueryRecords`) the read is refused as
`calculated-query-too-wide`; a filter on a stored field narrows it. A file that
filters or sorts on a calculated field needs host 1.40.0.

A calculated Integer or Decimal also totals: the `fieldId` of a `summaryTile` and a
`breakdownChart`, and the `rankByFieldId` of a `rankedList`. The total stands on
the same bounded read: every record the query keeps, with its calculations, each
result folded exactly as a stored decimal is. An empty result adds nothing, as an
unset field does; a result that could not be worked out refuses the whole total as
`calculated-total-incomplete`, naming the field and the reason; past 10,000 records
it is `calculated-query-too-wide`. A calculated Text, Boolean or Date is not a
number to total (`NUI294`, `NUI420`). A file that totals a calculated field needs
host 1.54.0. A field shown only when a calculation says so (`visibleWhen`, the
`fieldId` of a calculated Boolean) raises the minimum host version to 1.18.0.

It may not drive anything else. These refuse a calculated field with code `NUI214`,
naming the field:

- the `groupByFieldId` of a board or a `breakdownChart`;
- the `rowByFieldId` and `columnByFieldId` of a `matrixSurface`;
- the `dateFieldId` of a calendar, a `trendChart` or an `activityGrid`;
- the `dateFieldId` and `endDateFieldId` of a timeline;
- the field of a `trendChart` or `rangeTile`;
- a command step.

The database decides these over every matching record, and a calculated field has
no column to read. A `recordForm` made only of calculated fields is refused
(`NUI215`), because it would offer Save with nothing to save.

**A total the host cannot hold exactly stays unavailable.** If the sum of a summary
tile passes int64, or the .NET decimal range for a decimal, the tile reads
*Unavailable* with the reason and offers no Retry, because the refusal is
deterministic. The read keeps the host's code (`aggregate-not-representable`,
`aggregate-not-exact`). A transient failure (cancelled, file busy) still offers
Retry.

**The review says which fields are calculated.** The semantic diff of a proposal
resolves calculated fields, both the file's and those the same change set defines.
A screen that binds one reads *Show the calculated field Seeds per gram*, and a
`visibleWhen` reads *Show this only when Needs retest is yes*.

**An unsaved form outlives a refusal.** A confirmed refusal leaves the file
unchanged, so the draft stays open as the best copy of what the person intended.
When the session moves underneath the form — another file, a withdrawn approval, a
read-only transition, or a session that could not be read — the typed input stays
on screen, saving is switched off, and the reason is stated. The retained display
draft holds automatic redraws even after focus leaves it; backup and cancelled
dialogs keep it, and deliberate departure releases it. Values typed against one
file are never applied to another file.

**Work happens away from the UI thread.** Every host method that cannot touch a
native picker or a XAML element runs on a worker; the others stay on the thread
that owns the window. Work that runs long offers Stop. The host answers a stop only
after the work has stopped.

### The lane a person has to run

Automated checks cover reachability, focus, and the names and headings that
assistive technology reads. They do not cover whether any of it is usable. Run
this lane by hand, against the published Release payload with an isolated file and
device-state root, whenever what a person sees changes: a new state, a new control
or a new refusal. A passing journey is not this evidence.

1. Open a file that carries automatic actions. Use only the keyboard to reach File
   status, read the approval panel and approve. Confirm that editing becomes
   available.
2. With a screen reader, read one record page that has a value, an empty result and
   a failed result. Each must be distinguishable without the colour, and the failed
   result must say why.
3. Cause a refusal on a form with unsaved input. Confirm that focus lands on the
   message, that the typed input is still there, and that a screen reader reads
   what happened.
4. Repeat 1–3 in Light, in Dark, and with the system following the OS setting.

## Reversing a save

A causal revision is the edit that a person made and everything that its actions
wrote, in one transaction. Compensation reverses all of it, in the opposite order,
using the versions that the revision recorded, not the versions the file holds now.
If something else changed a record since, the compensation reports a conflict. An
exact retry after a lost response rebuilds the same compensation. A record is found
by its record type and ID together, since a record ID is unique only within its
type.

The actions do not run again over the reversal; they would compute a stored field
from a state that the reversal had not finished producing.

If an operation declares itself irreversible, the whole revision is refused, and
the refusal names the operation. `data.createRecord` and `data.restoreDeletedRecord`
are the exception ([ADR-0023](../decisions/0023-a-view-undoes-its-own-revisions.md)):
each is compensated by deleting the record at the version the revision left. They
stay declared irreversible because the record ID stays reserved in deletion
history. Reversing a definition is supported, and it asks the device about the
rules that it restores; consent for the definition being undone does not carry
over.

## Reaching it from an agent

`nendo://application/vocabulary` carries a `behaviour` section, generated from the
same tables that the analyzer and the planner enforce. There is no second MCP-only
catalogue. It contains:

- the closed function set, with the argument and result types of each function;
- the operators as they are written in a formula;
- the scalar domain;
- the binding kinds, in a `bindings` section that publishes every shape with its
  keys and a `RelatedAggregate` once per aggregate, each naming its `fieldKey`;
- what each aggregate does with an empty collection and with a value that it
  cannot read;
- every object of a definition body, `bodies`: the Calculation, Function, Action
  and Trigger bodies, a step, an assignment, a link, a target, a parameter and a
  call alias, each with its required and optional keys, and each of the four bodies
  with an `example` the codec accepts as it stands;
- the trigger events;
- the action step kinds;
- the action target kinds, each stating what it selects at the edges, including
  that an empty reference selects no record;
- the capabilities;
- the ceilings.

`nendo://application/examples` carries a change set, including a `Sum`, that an
agent can send unchanged. The `propertyNotes` of the surface vocabulary state that
`visibleWhen` takes the `fieldId` of a calculated Boolean field, not its definition
ID.

A body that does not fit its shape is refused at `add_operations`. The refusal
names the mutation, the operation, the binding and the key, and nothing enters the
draft. A validate that throws leaves the draft able to answer `amend` and `reject`.

The calculated fields of a record type appear under `derivedFields` on its schema,
never under `fields`. Each says what it reads: `readsFieldIds`, the stored fields
its bindings read; `readsCalculationIds`, the calculations; and `readsEntityIds`,
the record types its bindings start from or reach. A retirement of any of those, or
of the type that owns the calculation, is refused as `retired-binding`, so the MCP
schema read and Studio's Structure both say what blocks one before it is tried:
Structure lists the calculations in a read-only Calculated group and withholds
Retire from a field or record type they hold. The results of each record travel
beside its values with an exact `numericLexeme`.

A write that names a calculated field is refused as `NENDO_FIELD_CALCULATED`
(`field-calculated`), naming the calculation; a field that is neither stored nor
calculated is still not found. Authoring is not consent: an agent's write to a file
whose actions await approval gets the same refusal as a person's edit.

## Canonical operations and digests

There are two closed canonical operations, both on the definition lane:

| Operation | Effect | Reversibility |
| --- | --- | --- |
| `behaviour.setDefinition` | Installs a definition at its stable ID, creating or replacing it | `ReversibleWithRetainedState` |
| `behaviour.removeDefinition` | Removes one by stable ID and stated kind | `ReversibleWithRetainedState` |

Both take an `expectedDefinitionRevision` and conflict exactly like every other
definition operation. Whole-definition convenience requests expand into these
operations before any diff, digest, history entry or promotion sees them.

The canonical payload embeds the canonical body of the definition, written from
the validated typed record with properties in a fixed order and collections in
declared order, never from dictionary iteration. The digest of a definition is
therefore stable across processes and runs. Declared order is part of the
definition: two calculations that differ only in binding order have different
digests.

Evidence keeps the previous body, contract version and kind, so the inverse of an
install is the definition that was there before, or its removal if there was none.

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

Storage never holds the parsed expression tree, and never holds a computed value in
an editable physical column. `NendoEntitySnapshot.DerivedFields` describes
calculated fields, separately from stored `Fields`. A derived field has no column
and cannot be edited. Its result may be a value, empty, still loading or an error.

A file that stores no definition keeps exactly the schema that it has. Opening,
inspecting or reading such a file never creates the table.

## Compatibility

Storing a definition raises the minimum host version of the file to **1.17.0** in
the same transaction as its canonical operation. A definition that uses a create
step's `links`, a calculated aggregate member or `IsEmpty` raises it to **1.47.0**
instead, because an older host refuses the body or the call and would read the file
as damaged. `ToText` needs host 1.49.0 and `AddDays` host 1.53.0. Storing a
definition also brings the protected layout to `…-retirement-behaviour-v1`, the
whole ladder prefix, as a first choice edit does. An older host refuses writable
open. An ordinary open does no rewrite or migration.

## Expressions

### What a formula may contain

A formula may contain declared names, scalar literals, typed arithmetic and
comparison, Boolean control, a choice (`? :`), and calls to the closed catalogue or
to a reusable function.

| Operator | Accepts | Produces |
| --- | --- | --- |
| `+` `-` `*` `%` | two numbers | whole number, or decimal if either side is; a choice between a whole number and a decimal is a decimal whichever outcome is taken |
| `/` | two numbers | **always decimal**, including whole ÷ whole |
| `==` `!=` | two values of the same kind | true/false |
| `<` `<=` `>` `>=` | two numbers, dates or texts | true/false |
| `and` `or` | true/false | true/false, short-circuiting |
| `not` `-` (unary) | true/false, number | the same kind |

**Precedence**, tightest first: `not` and unary `-`; `*` `/` `%`; `+` `-`; `<` `<=`
`>` `>=`; `==` `!=`; `and`; `or`; and the choice `? :` last. Operators of one level
group from the left, so `a - b - c` is `(a - b) - c`. Two readings differ from other
languages:

- `not` binds tighter than a comparison: `not a == b` is `(not a) == b`, and is
  refused when `a` is not true/false. Write `not (a == b)`, or `a != b`.
- A choice inside a choice must be in parentheses, in either outcome:
  `x > 90 ? 'A' : (x > 80 ? 'B' : 'C')`. Without them,
  `x > 90 ? 'A' : x > 80 ? 'B' : 'C'` is refused as a formula that could not be
  read, at the second `?`, and the refusal ends "A choice inside another choice goes
  in parentheses: a ? x : (b ? y : z)." whenever the formula holds more than one `?`
  outside quotes. The condition needs none: `a and b ? 1 : 2` is
  `(a and b) ? 1 : 2`.

A refusal at validation names the formula it is about: a calculation or function by
its ID, "The condition of trigger 't'", or "The formula for 'total' in step
'10-set' of action 'set'". A formula the parser cannot read says where, as
"Parenthesis not closed at line 1, character 13".

Everything else refuses at validation: power, shifts, bitwise, `in`, `like`, lists,
member access, and any name that is not declared or catalogued. Text and true/false
values never become numbers, so `'2' + 1` and `true + 1` are refused.

Division answers in the decimal domain. The evaluator's own integer division
converts to binary floating point first, which would make `1/3` an approximation and
make two different 17-digit whole numbers compare equal, so the adapter converts the
operands to decimal *before* the division.

### Function catalogue

| Function | Signature |
| --- | --- |
| `RoundEven(number, digits)` | decimal, 0–28 digits, halves to even |
| `RoundAway(number, digits)` | decimal, 0–28 digits, halves away from zero |
| `Date(text)` | invariant `yyyy-MM-dd`, a real calendar date |
| `DaysBetween(start, end)` | signed whole-number day difference |
| `AddDays(date, days)` | the date that many days later, or earlier for a negative number; past 0001-01-01 to 9999-12-31 is `calculation-invalid-date`; an empty input stops the formula, as for other functions (host 1.53.0) |
| `Concat(a, b, …)` | 2–8 texts; joined size checked before allocating; write a number or a date as text with `ToText` first |
| `ToText(value)` | an integer as its digits, a decimal as its stored digits, a date as `yyyy-MM-dd`; no locale; a Boolean or text is refused; an empty input stops the formula, as for other functions (host 1.49.0) |
| `TextLength(text)` | how many UTF-16 code units a text value holds: most characters count as one, one outside the Basic Multilingual Plane, such as most emoji, as two; empty text is zero |
| `Refuse(text)` | no value; reports `calculation-refused` with the text, in one outcome of a choice |
| `IsEmpty(value)` | any scalar; true when it is empty or an empty input stopped it; never empty itself |

Every entry is a total function of its arguments. It uses no clock, no file, no
network and no host service, so a cached result and a replayed result are the same.

The table is published at `nendo://application/vocabulary`, generated from the same
entries that the analyzer checks a call against. A function, its declared signature
and its published description are one entry. A name that is not in the table is
refused, not resolved, so a formula that tries to use a network, a file or a clock
is refused without anyone listing those names.

A call alias of the author may share a name with an entry in the table. The alias
then wins: validation types the call against the author's function, and evaluation
runs that same function, never the built-in.

The digits of `RoundEven` and `RoundAway` are often read from a record. A value
outside 0–28 is that record's data, not a mistake in the definition, so it reports
`calculation-overflow` on the one calculated field. The record, its stored values
and its other calculations read as usual.

`IsEmpty` is the one entry an empty argument reaches; every operator and every
other function is stopped by an empty input. An empty value, or one an empty input
stopped on its way (`IsEmpty(a * b)` with `a` empty), is true, and any other
failure, such as a refusal or a zero divisor, stays what it is.
`IsEmpty(x) ? fallback : x` gives an empty value a default; a trigger condition
`IsEmpty(x)` runs an action only for an empty field.

`Refuse` is the one entry that produces nothing. It reports `calculation-refused`
with the author's sentence, so a formula can decline a value that it was given, for
example a rating outside its scale. It stands in for a value of the kind that the
other outcome of its choice produces, so the analyzer types it, not the catalogue.
Validation refuses a refusal on its own, inside arithmetic, or in both outcomes of a
choice: a calculation that can never answer is a definition error. An optional
result does not suppress it, because it is the author's sentence, not an empty
input.

### Values, empties and errors

A result is a typed **value**, a typed **empty**, or an **error**. An empty carries
its type, so a dependant reads an empty whole number and not an untyped hole. Empty
text and no text are different states.

An empty value is allowed as a whole result but never as an operand. If it is used
in arithmetic, a comparison, Boolean control, a function argument where the
function declared a value, or a related total, it **stops the formula**, and the
declaration decides what is reported
([ADR-0008](../decisions/0008-general-scripting-and-capability-isolation.md)). A
calculation or function declared to allow an empty result (`resultNullable: true`)
reports a typed **empty**. One declared always to produce a value reports
`calculation-missing-input`, also when its formula ends empty. The result is never
zero, never false and never a previous result.

A function parameter declared nullable receives an empty argument as a typed empty
of the parameter's declared type. A function that does not read it, or reads it
only in a branch that is not taken, still answers; one that uses it as an operand
stops, and the function's own declaration decides. A parameter that is not declared
nullable refuses an empty argument with `calculation-missing-input`, and the
caller's declaration decides. The empty result of a function reaches its caller as
an empty argument, and the caller's declaration decides.

The codes are `calculation-missing-input`, `-divide-by-zero`, `-overflow`,
`-invalid-date`, `-text-too-long`, `-limit-reached`, `-dependency-failed`,
`-related-unavailable`, `-stored-value-invalid` and `-refused`. Messages are
owner-facing and carry no stack trace, type name or expression internals. The
message of a refusal is the author's text.

`calculation-stored-value-invalid` is a stored value a formula cannot read as its
field's type, such as text a tool outside Nendo left in a whole-number column, a
fraction in a yes/no column, or a date that is not a calendar date. Only that
field's value fails; the record and the file stay readable. Inspection reports text
or a fraction in a whole-number or yes/no column as drift, so such a file opens
without editing until it is repaired.

The branch that is not taken is never evaluated: `true ? 7 : 1/0` is seven, and
`false and (1/0 = 0)` is false.

### Evaluator boundary

NCalc 7.1.0 parses the accepted syntax and supplies the checked arithmetic and
comparison semantics. Division is intercepted. Only the Engine references the
package, and its compile and build assets are withheld from consumers, so no
adapter or surface can name an NCalc type. NCalc brings Parlot, whose props would
add a global `using` to every project in the solution; those props are withheld for
the same reason. `ExtendedNumerics.BigDecimal` arrives transitively and is not a
scalar that this contract defines. A value outside the five scalars is a failure.
It is never converted.

## Limits

The limits are host-owned (`NendoBehaviourLimits.Default`). They are never read
from stored data, and a file never raises them.

| Resource | Ceiling | Enforced |
| --- | ---: | --- |
| Source length | 2,048 | Before the parser allocates |
| Lexical items | 128 | Preflight scan, punctuation included |
| Tree nodes / depth | 128 / 24 | During the typed walk |
| Parse nesting | 24 | Preflight, before a recursive parse |
| Definition graph depth | 16 | Over the whole candidate set, cache or not |
| Functions per file, or call aliases per formula | 32 | Before the lookup table is built |
| Definitions per file, of every kind | 256 | Over the whole candidate set, before the graph is walked |
| Bindings or parameters | 16 | Before binding |
| Stable ID or alias length | 128 | Before compilation |
| Work units | 16,384 | Charged per visit, call, scan and change |
| Function calls | 64 | One counter across nested calls, per record on a read. A related record's calculation has its own 64; a save has 64 for each record it names |
| Text length | 4,096 UTF-16 code units | On input, and before `Concat` allocates |
| Cached expressions | 16 | Cleared on reaching the cap. A save evaluates the conditions and assignments compiled with the file's behaviour and does not check them again on its own budget, so what it is charged does not depend on the cache |
| Related rows | 256 | SQL LIMIT plus a charge per row read, per record on a read. A related record's calculation has its own 256; a save has 256 for each record it names, and no one aggregate reads more than 256. Reading the record being evaluated, a record the save names or one its actions created is a work unit, not a related row. A plain count on a read reads no row and is not charged against it |
| Generated changes | 64 per record a save names | Before each generated write |
| Exact total | int64, or the .NET decimal range (96-bit coefficient, scale 0–28) | On the fold; refused as `aggregate-not-representable`, never wrapped or rounded. A calculated `Sum` folds the same way and refuses such a total as `calculation-overflow`. Trailing zeros that only a mixed scale added are shed first, so `decimal.MaxValue + 0.0` is `decimal.MaxValue` |

One budget spans an entire evaluation, every nested call and a whole causal
transaction, so a deep call chain or a chain of triggers gets no extra allowance of
work units. If a chain reaches a ceiling, the whole transaction aborts. A
calculation is worked out once per record and budget, a save forgetting what it
remembered before each change it makes. A related record's calculation spends its
own function calls and related rows, as its own read would, and its owner's work
units. A save's call, related-row and change allowances are those of the records it
names, one by one; the work units are not multiplied, and bound a save whatever its
size. Counters are checked, and every charge happens before the work that it pays
for. The key of a cached validated expression includes the limit policy, so a
stricter run never reuses a result validated under a looser policy.

These limits bound parser input, recursion, primitive work and host functions. This
is containment by arithmetic. It is not a memory sandbox and not a wall-clock
guarantee. Widening a limit needs new measurements, not a passing suite.

## What it costs

`tools/Review-Performance.ps1 -Mode MeasureBehaviour` measures the behaviour cost
on generated benchmark fixtures at 1,000 and 10,000 records, with three
calculations per record (a text length, a bounded related count over 200 linked
records, and a Boolean that reads that count) and one trigger whose action writes
back to the record that raised it. It reports opening the file, a whole-file
snapshot cold and warm, one bounded page of 50, a save that fires a chain, the
allocation per chained save, cancellation observed and joined, and the peak working
set. These are Engine numbers from a dedicated child process: no window, no WebView
and no MCP envelope.

How the costs grow is the contract. **A bounded page and a chained save do not grow
with the file**, because each reads a bounded set. **A whole-file snapshot does
grow**, linearly, because it evaluates the calculations of every record. A surface
that reads a page stays responsive on a large file; a surface that asks for the
whole file does not, and no ceiling above prevents this.

`BehaviourLimitTests` D2_20 to D2_25 record the warm evaluation cost of
`1/3 + 2.0` and the time to cancel one adapter worker and join it, without asserting
them as thresholds.

## Where the assertions live

Engine tests are under `tests/Nendo.Engine.Tests/`, MCP tests under
`tests/Nendo.LocalMcp.Tests/`, desktop tests under `tests/Nendo.Desktop.Tests/`
and Workbench tests under `src/Nendo.Workbench/scripts/`.

| Test or lane | Covers |
| --- | --- |
| `BehaviourScalarTests` | Lane D1 of the [regression catalogue](../design/adr-0008-regressions.md), and the **failure oracle**: without the adapter the same expressions still return Double `0.3333333333333333` and collapse `9007199254740993` to `9007199254740992`. If that control stops failing, the reason for the interception has changed |
| `BehaviourLimitTests` | Lane D2: each ceiling below, at and above it; warm-cache bypasses; adversarial inputs under a 60-second watchdog; cancellation joined |
| `BehaviourActionTests` | Lane D3 and D2.01–02 on a real file: one revision per chain, rollback at every failure point, blocked conditions, lost responses, ceilings; History's attribution |
| `BehaviourProposalTests` | Lane D4: review, replayed promotion, stale and tampered plans, approval of the plan's requirement |
| `BehaviourGrantTests`, `DesktopBehaviourGrantTests` | Consent: the six fields, revocation mid-save, copies, damaged grant documents |
| `BehaviourCalculationTests`, `BehaviourEventTests` | Dependencies, aggregates, read-route agreement, net events, `GeneratedChanges` |
| `BehaviourDefinitionTests`, `BehaviourAuthoringGapsTests` | Round-trip, digests, validation, contract mismatch; links, `IsEmpty`, calculated members, body shapes |
| `BehaviourWriteRouteTests`, `BehaviourCompensationTests` | Every write route shares one chain and budget; compensation |
| `BehaviourGrowthTests` | A new pure function and a read-only consumer; binding keys published equal accepted |
| `BehaviourSurfaceTests`, `SemanticDiffSummaryTests` | Calculated fields on surfaces and in the review |
| `ActionTargetTests`, `CalculatedFieldWriteTests` | Empty targets; writes to a calculated field |
| `BehaviourAuthoringProtocolTests`, `AuthoringRecoveryTests`, `DataMutationProtocolTests`, `ReviewMutationTests` | The same over MCP, draft recovery, named refusals, attribution on the wire |
| `WorkbenchBehaviourApprovalTests`, `WorkbenchCancellationTests`, `calculated-fields.test.mjs`, `draft-state.test.mjs`, `summary-tiles.test.mjs`, `history-markup.test.mjs` | Result states, exact numbers, retained drafts, approval, thread placement and stop, unrepresentable totals, History markup |
| `tools/Gate-BehaviourAuthoring.mjs` (`tools/Test-BehaviourAuthoringGate.ps1`) | Blackbox authoring against the real host |
| `tools/Journey-Behaviour.mjs` (`tools/Test-JourneyPilot.ps1`) | The real WinUI/WebView2 host: approval by keyboard, `Cannot calculate`, a firing edit, History, restart, Light and Dark; the automated accessibility half, recorded in `behaviour-state.json` |
