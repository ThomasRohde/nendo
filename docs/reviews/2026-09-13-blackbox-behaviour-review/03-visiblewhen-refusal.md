# A refusal that worked, recorded because it is the counter-example

Sent `visibleWhen: "probeLot.needsRetest"` — the calculation's definitionId — on a
fieldBinding. Response (change-set-dfb9f8bcc240e70438663bde27357d39, validate #1):

    "state": "invalid",
    "diagnostics": [{
      "code": "NUI330",
      "severity": "error",
      "message": "'probeLot.needsRetest' is not a calculated field of this record type.",
      "semanticId": "probeStatusBinding",
      "propertyPath": "visibleWhen",
      "hint": "Name a calculated field that produces a yes-or-no answer. Visibility reads
               a calculation, not a stored value."
    }]

Named the problem, named the node, named the property path, and the hint carried the
remedy. The correct value is the calculation body's `fieldId` (`needsRetest`), not the
`definitionId`. One round trip, and `amend` reopened the draft exactly as documented.

This is what the Sum failure should have looked like. Same server, same call, two
completely different failure qualities — the difference being whether the problem is
caught by the UI validator or by whatever deserializes a behaviour body.
