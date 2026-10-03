# ADR-0021: Fold old history into a checkpoint so a file keeps accepting writes

- **Status:** Accepted
- **Date:** 2026-09-30
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** The history-storage survey in Context (2026-09-30); the write budget measured in
  [`../design/archi-in-nendo.md`](../design/archi-in-nendo.md) (W-100, W-111); decision D-002 in the
  planner (history compaction, option A, 2026-09-29). Accepted on the owner's standing
  pre-acceptance of ADR changes; the measurements this ADR asks for are its delivery's
- **Amends:** ADR-0006 (a checkpoint revision; exact replay and compensation reach the retained
  window only) and ADR-0012 (a new protected layout rung)
- **Depends on:** ADR-0005 one write coordinator, ADR-0006 revisions and compensation, ADR-0007
  proposal promotion, ADR-0010 backup and identity, ADR-0011 copy discipline, ADR-0012 layouts
- **Related design:** [`../design/archi-in-nendo.md`](../design/archi-in-nendo.md) (the write budget), W-101

## Context

A file refuses writes once `__nendo_operation` holds 99,000 rows, and refuses to open once
`__nendo_revision` or `__nendo_operation` passes 100,000 (`SqliteNendoStore.Inspection.cs`,
ADR-0012 amendments of 2026-09-17). Nothing ever removes a row from either table. A record
created or deleted is one operation row and a field set is one row per field; a save is one
revision. The Archi work measured what that means for a file used every day: an hour of active
diagram editing costs about 1,000 operation rows, so a modelling file stops accepting writes after
about 100 active hours. A planner, a CRM or any file that is simply used reaches the same wall
later, but reaches it.

What the code assumes, surveyed 2026-09-30:

- **History is contiguous from genesis.** `HistoryIsConsistent` requires revision *i* to have
  change sequence *i*, revision 0 to be the Genesis revision, every other revision to carry at
  least one operation, the definition and data counters to chain from 0, and each revision's
  operation digest to match. `ValidateAsync` requires the manifest's counters to equal the
  revisions' maxima. `IdentityHistoryIsConsistent` chains every `identity.transition` back through
  the lineage. Deleting any prefix today puts the file in recovery as `history-inconsistent`.
- **Open reads all of it.** Inspection loads every revision and operation and re-hashes them, so
  open time grows with history.
- **Rows hang off revisions.** Operations, attributions and idempotency rows cascade from their
  revision. Exact retry (`TryResolveReplayAsync`) and receipts join idempotency to revision.
  Compensation reads a revision's operations and inverse evidence and refuses a revision already
  compensated. A proposal's receipt needs its revisions consecutive.
- **Operation IDs are unique only by the column's constraint**, and many are deterministic from
  an idempotency scope and key.
- **What must stay:** record tombstones (`__nendo_deleted_record`) reserve deleted record IDs;
  extension blobs hold package content that current packages use.
- **Every copy is verbatim.** Backup, Duplicate, Fork, Restore and the proposal clone use SQLite's
  backup API. Nothing vacuums or compacts.

## Decision drivers

1. A file that is used every day keeps accepting writes, indefinitely.
2. Revision identity and the two lineages (ADR-0006) stay as they are for everything that is
   kept: a revision's ID, change sequence and counters never change.
3. What is given up is stated, bounded and chosen by the person, never done behind their back.
4. The full history is not destroyed: it survives in a backup the host makes first.
5. A file an older Nendo cannot read correctly is refused by it, not misread.
6. Open time and file size fall with the history folded.

## Options considered

### A. Fold old history into a checkpoint (chosen)

Replace the oldest revisions with one checkpoint revision that carries their end state's
counters and a digest of what they were. Later revisions keep their IDs and sequence numbers. Old
operations, attributions and idempotency rows go with their revisions. Bounded, owner-started,
after a backup.

### B. Raise the bound

Moves the wall and raises the open cost, since open reads every row. Does not change the
conclusion: a used file still stops.

### C. Batch writes only

Already delivered (W-102). A gesture becomes one revision, which delays the revision bound, but a
field set is still a row. The operation bound does not move.

### D. Move old history to a side file

Keeps everything reachable, at the cost of a second file per file, which ADR-0011's copy
discipline and every copy flow would have to carry. More machinery than the need.

### Do nothing

A modelling file stops after about 100 active hours; the person exports and starts again.

## Decision

**A person may fold a file's older history into a checkpoint.** It is a host operation of the
open file, started by the person, never by an agent, a view or an automatic action.

1. **What is folded.** Every revision after Genesis up to change sequence *K*, where *K* keeps
   the most recent revisions unfolded: 1,000 of them, or fewer when those hold more than 25,000
   operation rows, and never fewer than 20 unless those alone hold more than half the bound. A
   file written in large batches reaches the bound in far fewer than 1,000 revisions, which is
   why the rows count as well. *K* is moved down so that no proposal's revisions are split
   between folded and kept. A file whose kept window is all it has since Genesis, or since its
   last checkpoint, has nothing to fold. A fold folds any earlier checkpoint with it.
2. **The checkpoint revision.** One revision replaces the folded ones, at change sequence *K*,
   lane `Checkpoint`, with no operations. Its counters before are the Genesis counters and after
   are revision *K*'s. Its operation digest is the fold's chain digest: SHA-256 over the previous
   checkpoint's chain digest, when there is one, and then each folded revision's ID, change
   sequence and operation digest, in order. Its description names what was folded: how many
   revisions and operations, and the dates of the first and last.
3. **The fold's evidence** is a row in a new protected table, `__nendo_history_fold`: the
   checkpoint's revision ID, when it was folded, the first and last folded change sequence, the
   number of revisions and operations, the chain digest, the identity lineage at the fold (the
   application and instance the last folded `identity.transition` produced, or none), and the
   backup it was preceded by. One row per fold; a later fold adds a row.
4. **What goes with the folded revisions:** their operations, attributions and idempotency rows.
   **What stays:** every record and its version, every tombstone (deleted record IDs stay
   reserved), every extension blob, the manifest's counters and change sequence, and every
   revision after *K*, unchanged.
5. **History is consistent** when revision 0 is Genesis at change sequence 0; the next may be a
   `Checkpoint` at any change sequence *K* ≥ 1 whose counters before are 0 and whose operation
   digest matches the latest fold row; every revision after it follows at *K* + 1, *K* + 2, … with
   counters chained from the checkpoint's after. The identity chain starts from the latest fold
   row's lineage. Nothing else about consistency changes.
6. **Before folding, the host makes a backup** through ADR-0010's Backup flow, so the full
   history is kept in a file the person can restore or open. The fold is then one write
   transaction under the write coordinator; a failure leaves the file as it was. After it the
   host vacuums the file and inspects it again as if opening it.
   Before the transaction, the host checks that the activated backup still has its recorded
   physical identity and content, and holds it against writing and deletion through the fold.
   A missing, replaced, changed or unavailable backup refuses the fold without removing history.
7. **The layout.** The fold table is a new last rung of the protected layout ladder, added by the
   first fold. A Nendo that predates it refuses the file as a newer layout rather than calling its
   history broken. A file never folded keeps its layout.
8. **Where it is offered.** In History, which says how much of the operation-row bound the file
   has used and warns from 80%: *Fold older history…* shows what would be folded and what would
   no longer be possible, and the host then makes the backup beside the file and folds. The
   bound itself is unchanged.

**What the person gives up, stated in the preview and in History's checkpoint entry:**

- A folded revision cannot be undone from History; the checkpoint is not compensable.
- A folded revision's operations cannot be inspected in the file. They can in the backup.
- An exact retry of a folded write is not recognised as one, and a receipt asked for one finds
  none. Such a retry would carry the idempotency key of a revision older than the kept window;
  every client retries within seconds.

## Consequences

- A file used every day keeps accepting writes: each fold brings the operation rows down to what
  the last 1,000 revisions wrote.
- Open time falls with the folded rows, since open reads only what is kept.
- ADR-0006's "history is never rewound" now reads: never rewound by a write, and folded only by
  the person, after a backup, with the fold recorded in the file.
- Duplicate, Fork, Backup and Restore copy a folded file as it is.

## Evidence and validation obligations

| Obligation | Lane |
| --- | --- |
| A task-owned file written past 99,000 operation rows, folding in between, still opens, validates and passes `verify_integrity` | Engine test |
| A folded file keeps every record, version, tombstone and kept revision byte for byte; its counters and change sequence are unchanged | Engine test |
| Consistency refuses a checkpoint whose digest or counters do not match its fold row, and a gap after it | Engine test, each falsified |
| A fold never splits a proposal and keeps the most recent 1,000 revisions | Engine test |
| Compensation of a folded revision, a receipt for one and an exact retry of one answer as stated above | Engine test |
| An older host refuses a folded file as a newer layout | Layout test |
| File size, open time and the History screen, before and after folding a file of about 99,000 rows | Measured; see below |

**Measured at delivery (2026-09-30, `HistoryFoldTests`, on the owner's desktop).** A file of 200
records edited 99 times over, five fields at a time, reached the bound with 99,207 operation rows
in about 100 revisions, and the next edit was refused as `write-ceiling-rows`. After a backup and a
fold it held 25,000 operation rows; the file shrank from 60,352 KiB to 15,152 KiB, and inspecting
it (what open does) took 2.5 s instead of 10.5 s. It then took 60,000 more rows of edits, opened
without a finding, passed `PRAGMA integrity_check` and accepted another write. Each obligation above
is an Engine test in that class; the History screen's part is the fold panel described in 8.

## History

- 2026-10-01 — amended by [ADR-0022](0022-new-file-keeping-the-records-an-application-ships-with.md):
  a new file of the application folds every revision after Genesis, with no kept window, on its
  staged copy. Its fold row names the source file in place of a backup, because the source
  keeps the full history. A file's own fold is unchanged.
- 2026-09-30 — written and accepted on the owner's standing pre-acceptance (W-101, D-002).
- 2026-09-30 — delivered at host 1.39.0. The kept window counts rows as well as revisions, found
  while measuring: a file written in batches reaches the bound in about 100 revisions, which a
  window of 1,000 would have kept whole. Offered in History rather than also in Health.
