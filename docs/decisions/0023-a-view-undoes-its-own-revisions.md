# ADR-0023: A view undoes and redoes its own revisions through compensation

- **Status:** Accepted
- **Date:** 2026-10-04
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** The survey in Context (2026-10-04): the compensation code, the deletion and
  reservation rules, and the Archi workbench's own undo (W-112). Accepted on the owner's standing
  pre-acceptance of ADR changes (2026-09-24); the tests it asks for are its delivery's (W-103)
- **Amends:** ADR-0006 (a create and a restore are compensated by a delete; a compensation of
  record changes can itself be compensated) and ADR-0013 (two methods in the view's table)
- **Depends on:** ADR-0005 one write coordinator, ADR-0006 lanes and compensation, ADR-0013
  custom views

### Accepted amendment — 2026-10-18 (Nendo offers a view's Undo after the view has gone)

Accepted on the owner's standing pre-acceptance of ADR changes, for W-250 (Finding F-307). The
first revisit trigger below is met.

**Context.** Billable's New invoice wrote the invoice, its lines and their source links in one
batch and then opened the invoice, as the person asked. The view's Undo went with the view: the
broker forgets a frame's revisions when it is unmounted, by design. The Workbench's own notice
already offered one step (Show in folder for a download), but a view's `ui.toast` could not reach it.

**Decision.** `records.batch` may carry `offerUndo: true`. The broker then asks the Workbench to
offer Undo in its notice, named by the batch's label, which follows the person to the next screen
or record until it times out, is closed or the next notice replaces it. Undo there is the view's
own `records.undo` of that one revision, in the package's name and under the same idempotency
key, so a lost answer is not a second undo; the Engine's package-origin check and compensation's
conflict refusals are unchanged, and an offer made in one file reaches nothing once another is
open. The batch answers `undoOffered`, false on a host that has no notice to offer it in.

**Not changed.** A view's own undo stack is still the view's, and still reaches only what the frame
wrote in this visit; the host still keeps no stack. Another package's revision is never offered.

**Consequences.** `extension-broker.test.mjs` (W-250) and the Workbench shell lane's "W-250 a view's
Undo offer follows the person" carry the obligations, each falsified.

## Context

A diagram editor needs Ctrl+Z and Ctrl+Y over its own gestures. Nendo has no universal undo, and
ADR-0006 rules one out: compensation is a new revision linked to the one it reverses, offered only
where retained evidence proves it safe.

W-112 gave the Archi workbench undo without the host. Each gesture is one `records.batch`, and the
view writes the gesture's opposite as another batch. It undoes a delete by creating the record
again under its own ID. A real file refuses that: deletion history keeps every deleted record ID
reserved, and a create of a reserved ID fails with `record-id-reserved`. The same refusal meets a
redo of a create, which makes again what the undo deleted. The workbench's lane runs over an
in-memory broker that keeps no deletion history, so it never met the refusal. Only the Engine can
put a deleted record back, through `data.restoreDeletedRecord`, which is built from retained
history and never from values a caller sends.

History's compensation could not reverse the same gestures either:

- `data.createRecord` declares itself irreversible, so a batch that creates is not compensated.
- A revision of several operations is compensated only when every one is a `data.setField`,
  `data.backfillRetiredField` or `data.deleteRecord`, and at most 128.
- A compensation cannot itself be compensated, so nothing can be redone.
- A view cannot call compensation at all: `history.compensate` is not in its method table.

## Decision drivers

1. Undo and redo must work on a real file, deleted records included.
2. A view reverses only what it wrote in this visit, never a person's or another package's edit.
3. A step whose records changed since is refused whole, with the reason, and writes nothing.
4. History records every undo and redo as a revision; nothing is rewound.
5. No change to the canonical form of a stored operation, so no digest and no rung moves.

## Options considered

### Compensation, reachable from the view (chosen)

The Engine reverses a record revision, including creates and restores, and a view asks for it by
the revision its batch returned. Redo is the compensation of the undo.

### A restore write in `records.batch`

Let a batch put back a deleted record from its retained values, and leave undo to each view. It
fixes the Archi defect with less host code. But every view that wants undo then rebuilds the
inverse, the version bookkeeping and the conflict checks that compensation already does, and
History still cannot reverse a batch that creates.

### Do nothing

The Archi workbench keeps refusing the undo of a delete and the redo of a create on every real
file, and says the record ID is reserved.

## Decision

**A create is compensated by a delete.** A record revision whose operations are
`data.createRecord`, `data.setField`, `data.backfillRetiredField`, `data.deleteRecord` or
`data.restoreDeletedRecord` is compensated as a whole, in reverse order:

| Operation | Its compensation |
| --- | --- |
| `data.setField` | The same operation with the retained previous value |
| `data.backfillRetiredField` | The same operation with the retained previous value while the field is still retired; a plain `data.setField` once it is active again, refused in words when the field is required and the value was empty (W-212, R2RM-04) |
| `data.deleteRecord` | `data.restoreDeletedRecord` at the deleted version |
| `data.createRecord` | `data.deleteRecord` at the version the revision left |
| `data.restoreDeletedRecord` | `data.deleteRecord` at the restored version |

Every version comes from the revision's own evidence, as before, so a record changed, deleted or
newly pointed at since refuses the whole compensation. The declared classes are unchanged:
`data.createRecord` and `data.restoreDeletedRecord` stay `IrreversibleDeclared`, because the class
is part of every stored operation's canonical form, and because what they cannot reverse is the
record ID. A compensated create leaves its ID reserved in deletion history, so the file is not as
it was before the create, and no fresh create can take the ID again. Compensation says "delete",
not "undo the create".

**A compensation of record changes can be compensated.** That is redo. A revision is still
compensated at most once, so undo, redo and undo again is a chain of three compensations, each of
the one before. A compensation of anything but record changes still cannot be compensated.

**The bound is the batch's.** A record revision of up to 12,800 operations is compensated
together: the most one `records.batch` makes, 200 writes of up to 64 fields. Other multi-operation
revisions keep the bound of 128.

**A view's undo.** `records.batch` answers the revision it wrote. `records.undo(revision)` and
`records.redo(revision)` compensate it through the host's `data.undoRecordWrites`, which admits a
view's actor:

- The broker accepts only a revision this frame was answered in this visit: a batch's, an undo's
  or a redo's. A revision from before the view was mounted, from another view or from History is
  refused in the Workbench, before the host is asked.
- The host accepts only a revision whose origin is the view's own package, of record changes only.
  A redo must name a compensation.
- The compensation's origin is the view's package. History names it "Undo ‹label›" or "Redo
  ‹label›", from the original's description, or by the label the view gives.
- The answer is the new revision and each record's version, null for a deleted one, as a batch's.

The steps, their order and their labels are the view's to keep. The host keeps no undo stack: it
answers whether one revision may be reversed now. Ctrl+Z and Ctrl+Y already reach a view, which
may declare them in its toolbar (W-090); a field's own undo is kept while the person types.

## Evidence and validation obligations

- Engine tests: a batch that creates, updates and deletes, with a reference between two created
  records, undone, redone and undone again, value for value and version for version; a single
  create compensated in History; a refusal, writing nothing, when a record changed since and when
  a record the undo would delete is newly pointed at; a compensation of a definition change still
  refused.
- Desktop tests: `data.undoRecordWrites` admits a view's actor, refuses another package's revision
  and a revision that is not a compensation as a redo, and stays refused without an actor.
- Broker tests: `records.undo` refuses a revision this frame was not answered.
- The Archi workbench's lane must meet the reservation: its broker refuses a create of a deleted
  record ID as the Engine does, and the lane undoes a delete and redoes a create.

## Consequences

### Positive

- Undo works on a real file for any view that writes in batches, with no inverse logic of its own.
- History can reverse a batch that creates, and a person can compensate a compensation.
- The conflict rules are the Engine's, one set for History and views.

### Negative

- A view's undo reaches only what it wrote in this visit. Leaving the screen and coming back
  forgets the steps, while History keeps them.
- Every undone create leaves a reserved ID behind. A view that makes record IDs must make new
  ones, as it must already after a delete.
- A step stays a revision. An undo of a large gesture writes as many operations as the gesture.

## Rejected alternatives

A restore write in `records.batch` is rejected because it makes every view reimplement
compensation and leaves History unable to reverse a create. A host-kept undo stack is rejected
because a view interleaves the host's steps with its own (an editor's waiting edits) and names
them itself; the host would have to learn both. Changing the declared class of `data.createRecord`
is rejected because the class is in every stored operation's digest, and an exact retry across the
upgrade would become a conflict.

## Revisit triggers

- A view needs to undo across visits, or across views of the same package. *(Met for one step by
  the amendment of 2026-10-18: Nendo offers the batch's Undo after the view has gone.)*
- A gesture needs more than one revision to be one step.
- Reserved IDs from undone creates become a measurable cost in a file.
