# ADR-0021: Fold old history into a checkpoint so a file keeps accepting writes

- **Status:** Accepted
- **Date:** 2026-09-30
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** `HistoryFoldTests`, including a file written past 99,000 operation rows, folded, reopened and verified
- **Amends:** ADR-0006 (a checkpoint revision; exact replay and compensation reach the kept window only) and ADR-0012 (a protected layout rung)
- **Depends on:** ADR-0005, ADR-0006, ADR-0007, ADR-0010, ADR-0011, ADR-0012

## Context

A file refuses writes once `__nendo_operation` holds 99,000 rows and refuses to open past
100,000 revisions or operations (ADR-0012). A record created or deleted is one operation row and
a field set one row per field, so a file that is used every day reaches the bound: an hour of
active diagram editing writes about 1,000 rows. History must be kept consistent from Genesis,
open reads all of it, and operations, attributions and idempotency rows hang off their revision.

## Decision

**The person may fold a file's older history into a checkpoint.** It is a host operation of the
open file, started only by the person, never by an agent, a view or an automatic action.

1. **What is folded.** Every revision after Genesis up to change sequence *K*, where *K* keeps
   the most recent 1,000 revisions, or fewer when those hold more than 25,000 operation rows, and
   never fewer than 20 unless those alone hold more than half the bound. *K* moves down so no
   proposal's revisions are split. A file whose kept window is all it has since Genesis, or since
   its last checkpoint, has nothing to fold. A fold folds any earlier checkpoint with it.
2. **The checkpoint revision** replaces the folded ones at change sequence *K*, lane
   `Checkpoint`, with no operations. Its counters before are Genesis's and after are revision
   *K*'s. Its operation digest is the chain digest: SHA-256 over the previous checkpoint's chain
   digest, if any, then each folded revision's ID, change sequence and operation digest, in order.
   Its description names how many revisions and operations were folded and the first and last
   dates.
3. **The fold row.** `__nendo_history_fold` holds one row per fold: the checkpoint's revision ID,
   when it was folded, the first and last folded change sequence, the counts, the chain digest, the
   identity lineage at the fold, and the backup that preceded it.
4. **What goes:** the folded revisions' operations, attributions and idempotency rows. **What
   stays:** every record and version, every tombstone, every extension blob, the manifest's
   counters and change sequence, and every revision after *K*, unchanged.
5. **History is consistent** when revision 0 is Genesis at change sequence 0; the next may be a
   `Checkpoint` at any *K* ≥ 1 whose counters before are 0 and whose digest matches the latest
   fold row; every later revision follows at *K* + 1, *K* + 2, … with counters chained from the
   checkpoint. The identity chain starts from the latest fold row's lineage.
6. **Backup first.** The host makes a backup through ADR-0010's flow, checks before the
   transaction that it still has its recorded physical identity and content, and holds it against
   writing and deletion through the fold. A missing, replaced, changed or unavailable backup
   refuses the fold. The fold is one write transaction under the coordinator; a failure leaves the
   file as it was. The host then vacuums the file and inspects it as if opening it.
7. **Layout.** The fold table is a protected rung added by the first fold; an older host refuses
   the file as a newer layout. A fold also adds three history indexes inside its transaction,
   before it deletes: `__nendo_idempotency(revision_id)` and the partial
   `__nendo_revision(proposal_id, change_sequence)` and
   `__nendo_revision(compensation_of_revision_id)`. They are an overlay, not a rung: the layout
   signature leaves them out only when all three are exactly as the host writes them. A file with
   them states host 1.50.0. A file never folded keeps its layout and has none of them, so its
   receipt and compensation reads still scan the revisions.
8. **Where it is offered.** History shows how much of the operation-row bound the file uses and
   warns from 80%. *Fold older history…* previews what would be folded and what would no longer
   be possible, then makes the backup beside the file and folds.

**What the person gives up**, stated in the preview and in the checkpoint's History entry:

- A folded revision cannot be undone; the checkpoint is not compensable.
- A folded revision's operations cannot be inspected in the file, only in the backup.
- An exact retry of a folded write is not recognised as one, and its receipt is not found.

A new file of the application (ADR-0022) folds every revision after Genesis with no kept window;
its fold row names the source file in place of a backup.

## Consequences

- A file used every day keeps accepting writes, and open time and size fall with what is folded.
- ADR-0006's "history is never rewound" reads: never rewound by a write, and folded only by the
  person, after a backup, with the fold recorded in the file.
- Duplicate, Fork, Backup and Restore copy a folded file as it is.

## Rejected alternatives

- **Raise the bound:** moves the wall and raises the open cost.
- **Batch writes only:** a field set is still a row, so the operation bound does not move.
- **Old history in a side file:** a second file per file that every copy flow would have to carry.
