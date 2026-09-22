# Measured: writing after an action is installed but before consent (Phases 5, 4)

State: the person accepted the proposal that installs `checkout.onCreated` (Trigger) and
`checkout.markLotReleased` (Action). The file now has automatic actions but the person
has NOT yet approved them running. I still hold the edit lease (lease.status:
hasLease true, isYou true, endsOn explicitRelease).

## The write is refused

`create_record checkout coDuringLock {...}`:

    NENDO_BEHAVIOUR_NOT_APPROVED: The semantic precondition was not met.

So holding the lease is not enough. A file with unapproved automatic actions refuses
data writes entirely. Installing (authoring) and running (consent) are cleanly
separated, and the gap between them is a locked file, not a file that quietly runs the
action. The error CODE names the reason (behaviour not approved); the message text is
the same generic "semantic precondition was not met" seen on the reference-delete block.

## An inconsistency in how the lock reports itself

Immediately after, the same lock hit by a different tool on a different entity:

    set_field variety/varBrandywine/varietyAlert = "Check stock" (v1)
    -> NENDO_INVALID_REQUEST: The request arguments are invalid.

Same underlying condition (file locked pending consent), two different error codes:
create_record gives the informative NENDO_BEHAVIOUR_NOT_APPROVED, set_field gives the
anonymous NENDO_INVALID_REQUEST. `variety` has no trigger, so this also raises the
question of whether the lock is file-wide (expected from the docs: "cannot be edited at
all") or entity-scoped.

CONTROL PENDING: the identical `set_field` succeeded twice before the lock (lotSL0003).
The only new variable is the lock. After consent I will re-run this exact variety write;
if it then succeeds, the anonymous error was purely the lock reported inconsistently,
confirming both that the lock is file-wide and that set_field mis-reports it. Recorded
here as observed-but-not-yet-isolated so the ambiguity is honest.

## Post-acceptance confirmation (control now resolved)

After the person accepted the proposal, the "Pending changes" panel showed 0 / "No
changes waiting" — so acceptance is complete and there is nothing further in that queue.
Yet the file is still write-locked:

    create_record checkout coProbeLock {...}  -> NENDO_BEHAVIOUR_NOT_APPROVED (again)
    set_field variety/varBrandywine/varietyAlert = "Check stock" (v1) -> NENDO_INVALID_REQUEST (again)

Both persist after acceptance. Since the lease is still held and the identical variety
set_field succeeded before the trigger existed, the cause is the lock, and:

1. The lock is file-wide. `variety` has no trigger, yet a well-formed write to it is
   refused. This matches the doc language "cannot be edited at all until the person
   approves it."
2. The two code paths report the same lock differently: create_record ->
   NENDO_BEHAVIOUR_NOT_APPROVED (informative), set_field -> NENDO_INVALID_REQUEST
   (anonymous). A person hand-authoring a set_field during the lock would be told only
   that their arguments are invalid, which they are not.
3. The consent to run automatic actions is NOT surfaced in the proposals / "Pending
   changes" queue. The person accepted the proposal there, saw nothing else, and
   reported "There doesn't seem to be anything to accept." The approval that unlocks the
   file is a separate host affordance elsewhere in Nendo. Reported (person-observed):
   it was not discoverable from where acceptance happens.
