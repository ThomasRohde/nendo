# ADR-0023: A view undoes and redoes its own revisions through compensation

- **Status:** Accepted
- **Date:** 2026-10-04
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** Engine compensation tests, `DesktopExtensionWriterTests`, `extension-broker.test.mjs` and the Workbench shell lane's Undo offer check
- **Amends:** ADR-0006 (a create and a restore are compensated by a delete; a compensation of record changes can be compensated) and ADR-0013 (undo and redo in the view's method table)
- **Depends on:** ADR-0005, ADR-0006, ADR-0013
- **Contract:** [custom views](../contracts/custom-views.md#writes)

## Context

A diagram editor needs Ctrl+Z and Ctrl+Y over its own gestures, and Nendo has no universal undo
(ADR-0006). A view cannot undo a delete by creating the record again: deletion history keeps
every deleted record ID reserved, and such a create is refused as `record-id-reserved`. Only the
Engine can put a deleted record back, through `data.restoreDeletedRecord`, built from retained
history and never from values a caller sends.

## Decision

**A create is compensated by a delete.** A record revision whose operations are
`data.createRecord`, `data.setField`, `data.backfillRetiredField`, `data.deleteRecord` or
`data.restoreDeletedRecord` is compensated as a whole, in reverse order:

| Operation | Its compensation |
| --- | --- |
| `data.setField` | The same operation with the retained previous value |
| `data.backfillRetiredField` | The same operation with the retained previous value while the field is retired; a plain `data.setField` once it is active, refused in words when the field is required and the value was empty |
| `data.deleteRecord` | `data.restoreDeletedRecord` at the deleted version |
| `data.createRecord` | `data.deleteRecord` at the version the revision left |
| `data.restoreDeletedRecord` | `data.deleteRecord` at the restored version |

Every version comes from the revision's own evidence, so a record changed, deleted or newly
pointed at since refuses the whole compensation, which writes nothing. `data.createRecord` and
`data.restoreDeletedRecord` stay `IrreversibleDeclared`: the class is part of every stored
operation's canonical form, and the record ID stays reserved after the compensating delete.
Compensation says "delete", not "undo the create".

**A compensation of record changes can be compensated.** That is redo. A revision is still
compensated at most once, so undo, redo and undo again is a chain of three compensations. A
compensation of anything else still cannot be compensated.

**The bound is the batch's.** A record revision of up to 12,800 operations (200 writes of up to
64 fields, the most one `records.batch` makes) is compensated together. Other multi-operation
revisions keep the bound of 128.

**A view's undo.** `records.batch` answers the revision it wrote. `records.undo(revision)` and
`records.redo(revision)` compensate it through the host's `data.undoRecordWrites`, which admits a
view's actor:

- The broker accepts only a revision this frame was answered in this visit (a batch's, an undo's
  or a redo's). Anything else is refused in the Workbench before the host is asked.
- The host accepts only a revision of record changes whose origin is the view's own package. A
  redo must name a compensation.
- The compensation's origin is the view's package. History names it "Undo ‹label›" or "Redo
  ‹label›", from the original's description or the label the view gives.
- The answer is the new revision and each record's version, null for a deleted one.

The steps, their order and their labels are the view's. The host keeps no undo stack; it answers
whether one revision may be reversed now.

**Undo after the view has gone.** `records.batch` may carry `offerUndo: true`. The Workbench then
offers Undo in its notice, named by the batch's label, which follows the person to the next screen
until it times out, is closed or is replaced. Undo there is the view's own `records.undo` of that
revision, in the package's name and under the same idempotency key, so a lost answer is not a
second undo. An offer made in one file reaches nothing once another is open. The batch answers
`undoOffered`, false on a host with no notice to offer it in. Another package's revision is never
offered.

## Consequences

- Undo works on a real file for any view that writes in batches, with no inverse logic of its own,
  and History can reverse a batch that creates.
- The conflict rules are the Engine's, one set for History and views.
- A view's own undo reaches only what it wrote in this visit; History keeps the rest.
- Every undone create leaves a reserved ID, and an undo writes as many operations as the gesture.

## Rejected alternatives

- **A restore write in `records.batch`:** every view would reimplement compensation, and History
  still could not reverse a create.
- **A host-kept undo stack:** a view interleaves host steps with its own and names them itself.
- **Changing `data.createRecord`'s declared class:** the class is in every stored operation's
  digest, so an exact retry across the upgrade would conflict.

## Revisit triggers

- A view needs to undo more than one step across visits, or across views of the same package.
- A gesture needs more than one revision to be one step.
- Reserved IDs from undone creates become a measurable cost in a file.
