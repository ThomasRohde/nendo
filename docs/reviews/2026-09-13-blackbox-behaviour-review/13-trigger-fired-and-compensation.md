# Measured: the trigger firing, and compensating an automatic save (Phases 4, 6)

## The trigger fires: one record's save changes another

After consent, `create_record checkout coTrigger1 {grower:"Delgado", lot:lotSL0001,
grams:9.00, ...}` returned a plain receipt: recordVersion 1, changeSequence 25.

Reading lotSL0001 back: `lotStatus:"Released"`, recordVersion 2. The checkout's creation
ran `checkout.markLotReleased` automatically and rewrote the referenced lot's status.
"Editing one record changes another" — confirmed end to end. A second-order effect also
showed up: lotSL0001.maturityDays (a ReferenceTraversal to Brandywine's Days to
maturity) read back 90 after I had set Brandywine's stored field to 90, so the derived
field tracks the referenced record live.

## What did NOT come back

The create_record response that fired the trigger carried no list of the changes the
action generated. recordVersion was the checkout's own (1); nothing named lotSL0001 or
its new version. The vocabulary declares a `generatedChanges: 64` limit, so the engine
bounds the cascade internally, but the MCP write result does not surface it. An agent
that creates a record and needs to know what the automatic action touched must read the
other record back; the receipt will not tell it.

## Compensating an automatic save is blocked by the singleChoice defect

Phase 6 asks to compensate a save that fired an automatic action. The save was creating
coTrigger1; its automatic effect was lotSL0001 -> Released.

- delete_record checkout coTrigger1 (v1) -> SUCCESS (recordVersion null). The triggering
  record is gone.
- Read lotSL0001: still "Released". Deleting the checkout did not reverse the action's
  effect — expected, since actions are not inverses and the trigger is Created-only.
- To hand-restore the lot: set_field lotSL0001.lotStatus = "Stored" (v2)
  -> NENDO_INVALID_REQUEST.

So the automatic action wrote a singleChoice field that set_field then cannot rewrite.
The compensation the prompt asks for is impossible over the wire for this field: the lot
is stranded at "Released", recoverable only through a recordCommand with that exact
transition (none maps Released->Stored) or the person editing it in Nendo. This is
evidence/12 biting on a real workflow, not a synthetic probe.
