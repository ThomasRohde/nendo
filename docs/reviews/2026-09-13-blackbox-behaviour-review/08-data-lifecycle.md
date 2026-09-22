# Measured: command, idempotency, receipt, compensation, delete-block (Phases 3, 6)

## Manual command (the Withdraw button)

`execute_command commandId=lotWithdraw recordId=lotSL0004 expectedRecordVersion=1`
returned `recordVersion:4, isIdempotentReplay:false`. Three commandSteps, so v1 -> v4,
one version per step, whole-or-nothing. Read back: `lotStatus:"Withdrawn"`,
`lotQuarantined:true`, `lotRegisteredAt:"2026-09-13T13:26:51Z"`. The `now` valueKind
resolved at execution time, not definition time — the stamp is today at run, exactly as
the example promised.

## Idempotency: same key, different body -> conflict

Reused key `seedlib-lots-1` (originally 4 records) with a 1-record body:

    NENDO_IDEMPOTENCY_CONFLICT: The idempotency key was already used for a different request.

The key is bound to the original request's content. A collision is refused, not
silently served the old answer. This is the safe behaviour.

## Idempotency: same key, exact body -> true replay

Resent key `seedlib-lots-1` with the exact original 4-record body:

    {"revisionId":"revision-3a302f09389b43469ca59ecae918017a","changeSequence":16,
     "isIdempotentReplay":true,"recordVersion":null}

Returned the *original* revision and change sequence 16, not a new write — even though
lotSL0004 has since advanced to v4 by other means. The replay reproduces the original
outcome and touches nothing. `recordVersion:null` on a replay is documented.

## Lost-response recovery via receipt

`get_receipt receiptContext=<from lease grant> idempotencyKey=seedlib-withdraw-sl0004-1`:

    {"state":"committed",
     "receipt":{"revisionId":"revision-956b...","dataRevision":6,"changeSequence":20,
                "isIdempotentReplay":true,"recordVersion":null},
     "message":"This exact operation committed. Do not submit it with a new key."}

Recovered the outcome of a prior write without re-sending and without holding edit
authority in the call (receiptContext is unprivileged). The message is exactly the
guidance the server instructions give ("An unresolved receipt is not permission to
resubmit with a new key") surfaced at the point of use.

## Compensation

`set_field lotSL0003.lotGermination 91.00 -> 45.00` (v1->v2), then compensated
`45.00 -> 91.00` (v2->v3). Final read: value 91.00, `needsRetest` false. The calculated
field tracked the change (45 < 70 would read true) and tracked the compensation back to
false. A compensation here is an ordinary inverse write at the expected version; there
is no dedicated compensate verb, though the revision schema carries
`compensation_of_revision_id`, so the host models the relationship even though the MCP
surface does not expose a way to declare it.

## Delete blocked by an incoming reference

`delete_record lotSL0001 v1`, while checkouts coAyala and coBhatt reference it:

    NENDO_RECORD_REFERENCED: The semantic precondition was not met.

Correctly refused. But this is the weakest data-layer message: the error code names the
class, yet the message is the generic "The semantic precondition was not met" — it does
not name the referring records (coAyala, coBhatt), does not say how many, and offers no
remedy. Compare NPROP010 for definitions, which names both ends and the fix.
