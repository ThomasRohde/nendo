# Defect: calculated fields bound to a screen are described to the person as "unknown field"

Proposal `proposal-56790a450c6022100d58881f98f0b0a0`, validate state `previewable`,
`diagnostics: []`. The change set was accepted as valid. Its `semanticDiff` — the text
the person reads in the approval panel — contains these seven lines:

    {"kind":"setUiProperty","summary":"Bind to unknown field \"shelfLabel\"."}
    {"kind":"setUiProperty","summary":"Bind to unknown field \"estimatedSeeds\"."}
    {"kind":"setUiProperty","summary":"Bind to unknown field \"seedsPerGram\"."}
    {"kind":"setUiProperty","summary":"Bind to unknown field \"maturityDays\"."}
    {"kind":"setUiProperty","summary":"Bind to unknown field \"lotCount\"."}
    {"kind":"setUiProperty","summary":"Bind to unknown field \"quarantinedLots\"."}
    {"kind":"setUiProperty","summary":"Bind to unknown field \"cleanLots\"."}

Every one of those seven names is a calculated field defined *earlier in the same change
set*, by a `behaviour.setDefinition` operation that the same diff renders correctly:

    {"kind":"setBehaviourDefinition",
     "summary":"Calculate Seeds per gram on Seed lot instead of storing it.",
     "semanticIds":["lot","lot.seedsPerGram"]}

Compare a binding to a stored field, which resolves to its display name:

    {"kind":"setUiProperty","summary":"Bind to Germination percent."}

## The internal contradiction

In the same proposal, on the same record type, `visibleWhen: "needsRetest"` — the same
kind of reference to the same kind of object — resolves cleanly:

    {"kind":"setUiProperty","summary":"Set Visible when.","semanticIds":["seedlib","lotQualityStatus"]}

and an earlier probe proved the `visibleWhen` validator *does* resolve derived fields by
name, refusing a wrong one with NUI330 (evidence/03). So the host knows what
`needsRetest` is when it appears in `visibleWhen`, and calls it unknown when it appears
in `fieldId`.

## Why it matters

This is the acceptance surface. The person is asked to approve a 205-operation change to
their file, and seven lines of it say the agent is binding screens to fields that do not
exist. Either:

- binding a calculated field to a surface is genuinely unsupported, in which case this
  should be a diagnostic and a refusal, not a valid proposal; or
- it is supported and the diff renderer does not resolve derived names, in which case
  the person is being shown a false alarm on the one screen where their trust is being
  asked for.

I cannot tell which from the wire. Whether the fields actually render is checked after
acceptance, in the Use view — see findings.md, Their eyes.

## Reproduction

Any change set that defines a Calculation and then adds a `fieldBinding` whose `fieldId`
is that calculation's body `fieldId`. Two operations after the schema exists.
