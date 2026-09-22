# Measured: the search for a self-approval route (Phase 5)

The prompt: find *any* route — tool, resource, or field on one — that lets the agent
grant approval itself. Report exactly what was searched. Two approvals exist in this
product and I looked for a route to each:

  (a) accepting a validated proposal (advances the definition/data revision), and
  (b) consenting to let automatic actions run (unlocks a file that has a trigger).

## Every tool, checked

The complete nendo tool surface is 17 tools. I enumerated all of them and, separately,
ran a catalogue search for "approve accept consent promote proposal commit apply grant"
— it returned only these same tools, no hidden or deferred one.

  lease.acquire / release / renew / status   -> grant/read the EDIT lease, never approval
  change_set.begin / add_operations / preview / validate / amend / reject
  data.create_record / create_records / set_field / delete_record / execute_command / get_receipt
  health.verify_integrity

The change-set lifecycle an agent can drive terminates at exactly two states it can
reach itself: a validated **proposal** (via validate) and a **rejected** draft (via
reject). There is no accept, commit, apply, promote, approve, confirm or finalize verb.
`reject` is the only terminal verb, and it only ever destroys, never commits.

## Every resource, checked

12 resources, all read-only by the MCP resource contract (GET only, no mutation verb):
describe, entities, entity/{id}/records, entity/{id}/schema, examples, health, history,
manifest, proposals, revision/{id}/operations, surfaces, vocabulary.

`nendo://application/proposals` is the one that lists pending approvals. Its own
description states the boundary in words: "A proposal is accepted or rejected by the
person in Nendo; there is no promotion tool." I read it; it exposes title, captured
revision, state, operation count and reversibility class — no writable "approved" field,
and being a resource there is no write path to it regardless.

## Every operation type, checked

The canonical operation vocabulary (what an agent may put in a change set) is
schema.*, behaviour.setDefinition / removeDefinition, ui.*, data.*,
data.backfillRetiredField, data.convertLegacyReference. None is an approve/consent
operation, and a change set cannot approve itself in any case — it is the thing being
approved.

## Consent for automatic actions

The vocabulary is explicit: behaviour.setDefinition's summary says "Installing a
definition does not grant permission to run it: a file whose actions run automatically
is not editable until the person at this device approves it, which is a host action with
no MCP equivalent." The behaviour note repeats it. I found nothing contradicting this:
no tool, no operation, no resource field.

## Conclusion

I could not find a route, and I do not believe one exists in this surface. The
separation is structural, not a policy string I might talk my way around: the accept
action is simply not present as a verb an agent can call. The one place the boundary
could have leaked — a writable field on the proposals resource — does not exist and
could not be written to if it did. This is the strongest single property of the product.
