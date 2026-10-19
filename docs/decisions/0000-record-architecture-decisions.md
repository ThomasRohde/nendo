# ADR-0000: Record architecture decisions before implementation

- **Status:** Accepted
- **Date:** 2026-09-01
- **Owners:** Nendo maintainers
- **Confidence:** High
- **Evidence:** `tools/Test-Repository.ps1` (ADR structure: heading, header fields, unique numbers, required ADRs)

## Context

Architecture-significant choices need one place that says what is decided, how
confident the project is and what authorises implementation. A hypothesis must not
read as a decision, and design momentum must not license production architecture.

## Decision

### Status

```text
Proposed → Accepted → Superseded
        ↘ Rejected
        ↘ Deferred
```

- **Proposed** — under consideration. It may authorise disposable experiments, not
  architecture-significant production work.
- **Accepted** — the evidence is sufficient for the stated confidence, and
  implementation may proceed.
- **Rejected** — not to be implemented under the recorded conditions.
- **Deferred** — out of scope by intent, or a prerequisite is missing. It grants no
  implementation authority.
- **Superseded** — a later ADR replaces it.

### Header

```markdown
# ADR-NNNN: Title

- **Status:** Proposed | Accepted | Rejected | Deferred | Superseded
- **Date:** YYYY-MM-DD
- **Owners:** names or accountable maintainer group
- **Confidence:** Low | Medium-low | Medium | High
- **Evidence:** the current tests or lanes that hold the decision, in one line, or "pending"
```

`tools/Test-Repository.ps1` checks the heading and these five lines in every ADR
except `README.md` and `template.md`, refuses a duplicate number, and requires
ADR-0000, ADR-0015 and ADR-0016 to exist.

### Body

An ADR states the decision as it stands now:

1. **Context** — the problem and its constraints, briefly.
2. **Decision** — the current rules, grouped by topic.
3. **Consequences** — positive and negative.
4. **Rejected alternatives** — one line each, kept where it stops a re-proposal.
5. **Revisit triggers** — while they are still meaningful.

A change to an accepted decision is folded into its Decision by topic rather than
appended as a dated amendment; git keeps the history. Detailed behaviour belongs in
the contracts under [`../contracts/`](../contracts/); an ADR states the decision and
links the contract. A Superseded, Rejected or Deferred ADR is a short stub: the
header and one paragraph saying what it decided and what holds now, with a link.

An ADR is not a meeting transcript, a vendor feature list or a generic technology
note.

### Evidence

An architecture-significant ADR is Accepted only when its evidence exists and can
be reviewed: tests, lanes, fault-injection or performance measurements, a measured
comparison of alternatives, or direct repository evidence for reversible tooling
and governance decisions. Vendor documentation establishes availability, licensing
or documented capability. It does not by itself prove integration cost, quality,
accessibility, performance or failure behaviour.

Reversible repository housekeeping (documentation indexes, `.gitignore`, CI checks,
skill vendoring, experiment scaffolding) may be accepted from direct repository
evidence. This exception does not extend to product decisions.

### Numbering

ADR numbers are four digits and never reused. A title change does not change the
number. [`README.md`](README.md) lists every ADR from 0000 to the latest.

### Precedence

Accepted ADRs are the architecture authority. A change to an architecture-significant
statement updates [`../architecture.md`](../architecture.md) and any affected
contract in the same change.

## Consequences

- Evidence, confidence and implementation authority are visible, and coding agents
  get one source of decision precedence.
- Maintainers keep the ADR, the index and the contracts current in the same change.
- Some attractive implementation work waits for evidence.

## Rejected alternatives

- One omnibus ADR: unrelated choices would share one status and could not be
  accepted or rejected independently.
- Accepting a decision while the evidence that chooses it is still owed as future
  obligations.

## Revisit triggers

- Several maintainers need a different approval model.
- The number of ADRs makes the flat index impractical.
