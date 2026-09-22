# Blackbox review of calculations and actions — 2026-09-13

An outside reviewer — Claude, running in Claude Code with Nendo's MCP server
registered natively — was handed [`blackbox-prompt.md`](blackbox-prompt.md) and an
empty file. It never read the source. The report below is the reviewer's own text,
verbatim; the evidence it cites as `evidence/NN` is copied unchanged into
[`2026-09-13-blackbox-behaviour-review/`](2026-09-13-blackbox-behaviour-review/),
with the first-impression note it wrote before calling anything. The person at the
keyboard accepted two proposals, approved the automatic actions under Health, and
answered Phase 7 from screenshots; those are labelled *reported* in the text, as the
brief asks.

What each finding became is in [Resolutions](#resolutions), after the report. The
report itself was not edited to match.

---

# Nendo review — findings

An outside client's review, conducted entirely over the MCP wire against one open,
initially-empty file. I never read Nendo's source. Raw responses are under `evidence/`,
numbered; this document cites them as `evidence/NN`.

Two conventions, per the brief. **Measured** means I observed it on the wire myself;
**reported** means the person at the keyboard observed it and I did not verify it
independently (Phase 7 is mostly reported, cross-checked against my own reads where I
could). And I describe rather than grade: where something is good or bad I say what
happened and let it stand.

---

## What I built

A community **seed library** in three record types: `variety` (name, species as a
bounded choice, notes, days-to-maturity, heirloom flag, introduced date, an alert
choice), `lot` (a physical seed lot, carrying all eight storage kinds — text, reference,
integer, decimal, boolean, date, dateTime, uuid — plus a status choice), and `checkout`
(a grower borrowing grams from a lot). Two configured references (lot→variety,
checkout→lot). One reusable function (`SeedsPerGram`) and nine calculated fields across
all four binding kinds: same-record field, same-record calculation (one calculation
reading two others), reference traversal, and related aggregate (Count and
FilteredCount). Seven screens: a tabbed record page with sections and a calculation-gated
field, two lists on the same record type with filters and a count, a board grouped by
status with a surface total and a column total, a calendar, a related list with a sum,
and a three-step Withdraw command. Then an Action and a Trigger, so that creating a
checkout automatically marks its lot "Released". Records included a 19-digit integer and
decimals with load-bearing trailing zeros. One rollup I intended — a Sum of seed counts
per variety — I could not build; see surprise 2.

---

## What surprised me, ranked

### 1. A whole class of failure is invisible, and one member of it destroys your work
`NENDO_INVALID_REQUEST: The request arguments are invalid.` is returned for at least four
unrelated causes: a malformed aggregate binding, an unknown operation type
(`sql.execute`), a data write missing a required field, and — the expensive one — a
`RelatedAggregate`/`Sum` binding whose payload shape I could not guess. For the Sum case
the message is not just unhelpful, it is destructive: the failed `validate` **freezes the
draft**, and the very tool the docs name as the remedy, `nendo.change_set.amend`, then
refuses with `NENDO_CHANGE_SET_FROZEN`. The draft is unrecoverable and 90 operations were
lost the first time it happened (`evidence/01`, `evidence/02`, `evidence/10`). This is the
single worst experience in the product, and it stands in front of the newest feature.

The contrast that makes it a defect rather than a fact of life: a *well-formed* formula
that is merely wrong — calls `Now()`, exceeds 128 parts — is diagnosed cleanly and leaves
the draft open (`evidence/07`). The freeze is specific to payload structure the
deserializer can't bind, and there it says nothing and burns the draft.

### 2. The most natural calculation in my domain was unbuildable from the wire
`RelatedAggregate` lists `requiredFields` of `entityId, relatedEntityId,
relatedReferenceFieldId, aggregate` — with nothing naming the field a Sum should total.
The list is provably incomplete: the server's own published example sends a
`predicateFieldId` on a FilteredCount that appears in no resource. So I guessed the Sum's
field key three ways (`aggregateFieldId`, omitted, `fieldId`); each guess froze a draft
(surprise 1), and I stopped after three because I could not afford a fourth. "Seeds held
per variety" — the obvious rollup — does not exist in my app because building it would
have required reading the source, which is the one thing this review forbids
(`evidence/02`). This is exactly the finding the brief said was the most important I could
produce: I needed the source, and that is the finding.

### 3. `set_field` cannot write a singleChoice field at all
Setting any bounded-choice field to a valid option via `data.set_field` is refused with
the anonymous error — `varietySpecies = "Bean"`, `varietyAlert = "Check stock"`, both
refused — while `create_record` and a command's `commandStep` accept the identical
labels for the identical fields (`evidence/12`). Controls localize it precisely: an
integer field on the same record at the same version writes fine. Changing a status field
on an existing record is one of the most ordinary things anyone does in a database app,
and over MCP it is impossible unless a command happens to encode that exact transition.
It even blocked a compensation the brief asked for: after the trigger set a lot to
"Released", I could not set it back (`evidence/13`).

### 4. A Sum that would overflow refuses on screen rather than showing a wrong number
Only visible because a person looked at the board (`evidence/15`). The "seeds in library"
total and the "Testing" column total both read *"Unavailable — the exact sum is outside
the range this host can represent,"* because those sums include a lot whose seed count is
int64 max. The representable columns show exact totals, including `9007199254740993` in
full. This is the exact-or-nothing philosophy reaching all the way into aggregates, and I
could not have seen it from the wire at all — surfaces read as definitions and I have no
route to a compiled tile's value. Two caveats: it is also a real ceiling (a total can't
exceed int64 even though a stored integer can reach it), and the button offered is
"Retry", which won't help a deterministic overflow.

### 5. The acceptance diff calls your own calculated fields "unknown"
The 205-operation proposal I asked the person to accept described seven of its own
bindings as `Bind to unknown field "seedsPerGram"` (and `estimatedSeeds`, `shelfLabel`,
`maturityDays`, `lotCount`, `quarantinedLots`, `cleanLots`) — every one a calculated
field defined a few operations earlier in the same proposal, and every one resolved
correctly once accepted (`evidence/04`, confirmed by `evidence/14`: the surfaces compiled
`valid` with those bindings intact, and `evidence/15`: they render in the app). So these
are false alarms, and they appear on the one screen whose entire job is to earn the
person's trust before they change their file.

### 6. Numbers are exactly as advertised, which after the above was a relief
`9007199254740993` (2^53+1) and int64 max round-tripped digit-for-digit; every trailing
decimal zero survived; `1000/7` rounded at the declared point and the dependent
calculation consumed the rounded value; divide-by-zero produced `state:"error"` with a
named code, and the *dependent* calculation reported `calculation-dependency-failed`
naming its upstream cause while sibling calculations still computed (`evidence/05`). This
is genuinely careful work.

### 7. You cannot approve your own work, and the boundary is structural
I searched every tool, every resource, every operation type, and a catalogue query for
any accept/consent/promote route and found none (`evidence/09`). The change-set lifecycle
an agent can drive terminates at exactly "validated proposal" or "rejected"; `reject` is
the only terminal verb and it only destroys. A SQL-injection string in a `fieldId` was
stored as an inert opaque identifier, never interpreted (`evidence/06`). Installing an
action does not let it run: with an unapproved action present the whole file refused
writes with `NENDO_BEHAVIOUR_NOT_APPROVED` (`evidence/11`). The separation is not a policy
string I might argue past — the verb simply isn't in the surface.

---

## What cost me time

- **Rebuilding 90 operations after a blind freeze.** Call: `change_set.validate` on
  `change-set-c722…` (idempotencyKey `seedlib-csA-validate-1`). Expected: either a valid
  proposal or diagnostics I could `amend`. Got: `NENDO_INVALID_REQUEST` with no
  diagnostics, then `amend` refused `FROZEN`. I had to bisect the cause across four throwaway
  drafts and rebuild the entire change set. (`evidence/01`)

- **Three drafts burned guessing one payload key.** Calls: three `behaviour.setDefinition`
  Sum bindings (`aggregateFieldId`, omitted, `fieldId`). Expected: at worst a diagnostic
  naming the right key, like every UI refusal gives. Got: three freezes and no
  information, against a per-session ceiling of 8 drafts. (`evidence/02`)

- **A control write to disambiguate the lock.** During the consent lock I saw
  `set_field` on `variety` fail with the anonymous error while `create_record` failed
  with the informative `NENDO_BEHAVIOUR_NOT_APPROVED`. I had to run a post-consent control
  to learn the anonymous failure was *not* the lock at all but the singleChoice defect
  (surprise 3) — two different bugs wearing the same error text, which cost me a wrong
  hypothesis I had to write down and retract. (`evidence/11`, `evidence/12`)

- **Round trips a field on the interface would have saved.** Every one of the above traces
  to the same missing thing: the anonymous error names neither the operation, the field,
  nor the cause. A single `semanticId`/`propertyPath` on that error — which the NUI/NPROP
  diagnostics already carry — would have turned each multi-draft hunt into one call.

---

## What I could not learn from the wire and had to guess

- **The `Sum`/`RelatedAggregate` field key.** Never discovered; I abandoned the rollup.
  (`evidence/02`)
- **`visibleWhen`'s value shape.** Guessed the calculation's `definitionId`; the refusal
  (`NUI330`) told me it wants the derived field's `fieldId`. This one guess was cheap
  precisely because it was diagnosed. (`evidence/03`)
- **That binding a calculated field to a surface is supported.** Nothing states it; the
  diff actively implied the opposite ("unknown field"); the `NUI214`/`NUI215` hints
  eventually confirmed it in passing ("A calculated field can be bound for display").
  (`evidence/04`, `evidence/06`)
- **Whether a custom `detailSurface` is used as the record page in the Use view.** The
  record screen the person opened was the default all-fields editor, so I could not
  confirm the tabs or the `visibleWhen` gate render for a record. Left unverified.
  (`evidence/15`)
- **Where the "approve automatic actions" consent lives.** Not derivable from the wire
  (it is a host action with no MCP equivalent, correctly), and not where acceptance
  happens; the person found it under **Health** after looking. (`evidence/11`)

---

## Every refusal

Measured. "Named the thing" = named the offending field/operation/node. "Remedy" = the
message or hint told me what to do. Codes are verbatim.

| What I tried | Code | Named the problem | Named the thing | Offered a remedy |
|---|---|---|---|---|
| Sort a list by a calculated field | `NUI214` | yes | field + `orderByFieldId` | yes |
| Filter a list by a calculated field | `NUI214` | yes | field + `fieldId` | yes |
| Group a board by a calculated field | `NUI214` | yes | field + `groupByFieldId` | yes |
| Total a calculated field | `NUI214` | yes | field + `fieldId` | yes |
| A form of only calculated fields | `NUI215` | yes | node | yes |
| `visibleWhen` naming a definitionId not a field | `NUI330` | yes | node + `visibleWhen` | yes |
| Formula calling `Now()` (clock) | `NPROP002` | yes | the function name | generic hint |
| Formula calling `HttpGet()` (network) | `NPROP002` | yes | the function name | generic hint |
| Formula over 128 parts | `NPROP002` | yes | the ceiling number | generic hint |
| Remove a function a calculation still calls | `NPROP010` | yes | both ends + "same review" | yes |
| 17 operations in one call | `NENDO_CHANGE_SET_LIMIT` | yes | limit + actual count | implicit |
| Reuse an idempotency key with a different body | `NENDO_IDEMPOTENCY_CONFLICT` | yes | the cause | implicit |
| Delete a lot two checkouts reference | `NENDO_RECORD_REFERENCED` | code only | no (not which records) | no |
| Write a record while an action awaits consent | `NENDO_BEHAVIOUR_NOT_APPROVED` | code only | no | no (implicit: approve) |
| `sql.execute` as an operation type | `NENDO_INVALID_REQUEST` | no | no | no |
| `host.runCommand` as an operation type | `NENDO_INVALID_REQUEST` | no | no | no |
| `create_record` missing a required field | `NENDO_INVALID_REQUEST` | no | no | no |
| Malformed `Sum` binding payload | `NENDO_INVALID_REQUEST` (freezes draft) | no | no | no |
| `set_field` on a singleChoice field | `NENDO_INVALID_REQUEST` | no | no | no |

The top group (`NUI*`, `NPROP*`, the named `NENDO_*` codes) is excellent — stable codes,
the offending node or field, an actionable hint, and the draft left open to amend. The
bottom group (`NENDO_INVALID_REQUEST`) is blind, and the two rows that matter most —
the malformed binding and the singleChoice write — live there.

---

## Defects, smallest reproduction each

1. **Invalid behaviour payload freezes the draft undiagnosably.** Against an empty file:
   create two record types and a configured reference, then `behaviour.setDefinition` a
   `RelatedAggregate`/`Sum` calculation (any field-key spelling), then `validate`. Result:
   `NENDO_INVALID_REQUEST`, no diagnostics, and `amend`/`preview` both refuse thereafter.
   Only `reject` works. (`evidence/01`, `evidence/02`)

2. **`data.set_field` refuses every singleChoice value.** On any singleChoice field,
   `set_field entity/record/choiceField = "<a listed option>"` at the correct version, on
   an unlocked file → `NENDO_INVALID_REQUEST`. The identical call on a non-choice field of
   the same record succeeds; `create_record` and command steps accept the same label.
   (`evidence/12`)

3. **The acceptance diff labels defined calculated fields "unknown".** Any change set that
   defines a Calculation and then adds a `fieldBinding` to that calculation's `fieldId`
   renders `Bind to unknown field "…"` in `validate`'s `semanticDiff`, while validating
   `valid` and compiling correctly. (`evidence/04`)

4. **Two distinct failures share `NENDO_INVALID_REQUEST` with no localizer**, so a caller
   cannot tell a missing required field from an unknown operation from a malformed binding.
   (`evidence/10`)

Lesser, described not filed: `NENDO_RECORD_REFERENCED` doesn't name the referring records;
the overflow tile offers a misleading "Retry"; the Use view shows internal binding IDs
(`gpt`, `dtm`) to end users; the consent control lives under Health, away from where
proposals are accepted.

---

## What I did not test, and why

- **The `avg` aggregate** — refused by name in the vocabulary with a reason, so there was
  nothing to exercise.
- **`data.convertLegacyReference` and `data.backfillRetiredField`** — both presuppose a
  legacy/retired-field history that a fresh file created for this review does not have.
- **The per-*change-set* ceilings (128 ops / 512 canonical / 32 mutations)** — I hit and
  documented the per-*call* limit (16) but did not push a single draft to the larger
  totals; the mechanism is the same and I did not want to spend drafts on it.
- **`lease.renew` and expiry** — the person had expiry off (`endsOn: explicitRelease`), so
  there was no timeout behaviour to observe.
- **OR / grouped filters** — the vocabulary states contract v3 has none, so there was
  nothing to attempt.
- **The Sum field-key by exhaustion** — I stopped after three spellings rather than burn
  the session's remaining drafts on a fourth, fifth and sixth blind guess. The cost of a
  wrong guess (a frozen, rebuilt change set) made brute force irresponsible.
- **Whether the custom `detailSurface` renders as the Use-view record page**, including
  the `visibleWhen` gate — the person opened the default editor and I have no wire route
  to a compiled record page, so I could not confirm it either way. (`evidence/15`)
- **Reconnecting after the reopen** — the endpoint dropped as documented; re-establishing
  it would have needed the person to re-register the server, and Phase 6's goal (the app
  works with no agent connected) was already met.

---

## First impression, kept for the record

Before any call, from the tool surface alone (`notes/00-first-impression.md`): the
acceptance boundary was already legible — `change_set` has begin/validate/amend/reject and
conspicuously no accept — and exact numerics were advertised up front. But nothing in the
tool names named the newest feature; "calculation", "formula", "trigger", "action" and
"screen" appear in zero tool names. An agent that read only the tools would not know this
product had the feature the review spent most of its time on. The prose that points you at
`nendo://application/describe` first, and the transport paragraph aimed at a header-writing
client I am not, both live in the server instructions rather than the tool surface. The
prediction I recorded there held: the gap between "the tool list" and "what I needed to
author a formula" was the whole review.

---

## Resolutions

Recorded the same day, against the code as it stands after the fix commit. Where a
finding's own diagnosis was wrong, that is said here rather than corrected above.

### 1. A malformed behaviour payload froze the draft — fixed, both halves

The throw came from the behaviour body codec, reached synchronously inside
`validate` before any clone existed, and `ValidateAsync` set `Frozen` before the call
and only unfroze on the diagnosed-invalid return path. Two changes:

- **The shape is checked where the operation is sent.** `add_operations` and `amend`
  now build every operation into its typed form (`NendoCanonicalOperations.Check`)
  before anything enters the draft. A body the host cannot bind is refused as
  `NENDO_INVALID_REQUEST` naming the mutation ordinal, the operation index, the
  operation and its ID, then the binding, the key and what the key is for. The draft
  is untouched. A wrong guess now costs one call.
- **A validate that ends without a verdict reopens the draft.** Any exception between
  freezing and the verdict — a compile refusal, `CHANGE_SET_STALE`, cancellation —
  restores the draft, so `amend` and `reject` answer.

`AuthoringRecoveryTests.AMisshapenBehaviourBodyIsRefusedWhereItIsSentAndCostsNoDraft`
replays the review's three attempts against a CRM: the invented key and the omitted
key are refused by name, the right one is accepted, and the draft holds exactly what
was accepted throughout. `AValidateThatThrowsLeavesTheDraftOpenRatherThanFrozen`
covers the stale path.

### 2. The Sum key could not be learned from the wire — fixed

The key is `valueFieldId`. The published `requiredFields` list was written by hand
and omitted it, and no example used `Sum`. `NendoBindingShape.All` is now one table
that the codec refuses against, the vocabulary publishes and a test holds together:
`behaviour.bindings` carries a `RelatedAggregate` row per aggregate with its own
keys, `behaviour.aggregates[].fieldKey` names the key, and the automatic-actions
example includes a `Sum`. The codec also refuses a key outside a shape's list **by
name, with the list** — `aggregateFieldId` used to be dropped silently, which is why
three spellings produced nothing.

One limit surfaced in writing the test: a `Sum` totals a **required** field only,
because a member with no value is an error rather than a zero. It is now stated in
the contract and the example, and listed in the roadmap.

### 3. `set_field` could not write a singleChoice field — diagnosis withdrawn; the refusal is fixed

The reviewer's raw calls, read from their own session transcript, sent
`"value": "\"Bean\""` and `"\"Check stock\""` — strings with the quote characters
inside them — while every numeric write used the `$nendoNumber` envelope correctly.
The engine refused a value that literally began with `"` as not one of the declared
choices; the file (read read-only) holds the options as the labels the reviewer
meant. So the choice path is not broken, and `set_field` with `"Bean"` succeeds —
`DataMutationProtocolTests.ARefusedValueNamesTheFieldTheChoicesAndWhatArrived` sends
both forms.

What was broken was the refusal: the engine's sentence naming the field was thrown
away at the boundary. It now reads `Value for field varietySpecies is not one of its
declared choices (Tomato, Bean, Squash, Pepper, Lettuce); received "\"Bean\""`,
which is the whole diagnosis. The tool descriptions for `values` and `value` also
say that a text or choice value is the JSON string itself.

The compensation the review could not complete (evidence/13) was blocked by the same
thing and works with the value itself.

### 4. A Sum that would overflow refuses on screen — kept, with the Retry removed

Exact-or-nothing is the contract; the ceiling is now written down (int64, or 28
significant decimal digits). The tile's read keeps the host's code, and a
deterministic refusal (`aggregate-not-representable`, `aggregate-not-exact`) offers
no Retry — a transient one still does.

### 5. The acceptance diff called calculated fields "unknown" — fixed

Name resolution read stored fields only. It now reads the file's derived fields and
the calculations the same change set defines, so a binding reads *Show the
calculated field Seeds per gram* and a `visibleWhen` — which rendered no value at
all — reads *Show this only when Needs retest is yes*.

### 6 and 7. Numbers and the approval boundary — no change

As advertised. The gate that asserts no route to consent exists still passes.

### The anonymous refusal class — fixed by one rule

Every `NendoValidationException` message now passes through the boundary whole; the
audit is in the contract. Unknown operation types are their own code,
`NENDO_UNKNOWN_OPERATION`, naming the type. Precondition messages pass through for
the audited codes, so `NENDO_RECORD_REFERENCED` now names up to five referring
records and `NENDO_BEHAVIOUR_NOT_APPROVED` says what to do. A calculation failure
inside an action reached an agent as `NENDO_INTERNAL_ERROR`; it is now a refusal
naming the action, the step and the field.

### Lesser items

- **`NENDO_RECORD_REFERENCED` names the records** — see above.
- **The overflow tile's Retry** — removed for settled refusals.
- **Internal binding IDs in the Use view** — the formula is shown in Studio's editor
  and grid, where it is written; the Use view's card shows the value and the
  *Calculated* mark only.
- **Consent under Health, away from acceptance** — the approval panel now also
  renders on the Agent page, accepting a proposal that adds actions says so in the
  same breath, and the frame's status pill reads *Approval needed* while editing is
  off for that reason. It is still a separate act from accepting; the roadmap says
  why.
- **Nothing in the tool names named the newest feature** — the server instructions
  now open with what a file holds and name `behaviour.setDefinition`; the transport
  paragraph, written for someone building an HTTP client, moved to the end under
  that heading. `add_operations` names the operation families.
- **Two secrets threaded through twelve tools** — `lease.acquire` now says what each
  is for.
- **The write receipt says nothing about what the action changed** — `alsoChanged`
  on every data write result lists the records the chain wrote with their new
  versions. A receipt read back later does not carry it; the roadmap says why.
- **Whether the custom record page is used in the Use view** — it is. The screen
  the person opened was Studio's editor, which shows every stored field by design
  and never reads `visibleWhen`. The prompt's Phase 7 now says to open the record
  from a list or board in the Use view.

### Not changed, and named

- A `Sum` over an optional field is refused at install. Roadmap.
- An assignment bound to the event record while writing to the referenced one still
  installs cleanly; it fails the save naming the action. Refusing it at install is a
  validation over the trigger and action together. Roadmap.
