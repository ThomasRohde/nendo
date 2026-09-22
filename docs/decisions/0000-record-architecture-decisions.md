# ADR-0000: Record architecture decisions before implementation

- **Status:** Accepted
- **Date:** 2026-09-01
- **Owners:** Nendo maintainers
- **Confidence:** High
- **Evidence:** An independent design critique, repository state and prior ADR inconsistencies

## Context

Nendo is exploration-led by design. The first baseline proposed an ADR process, but it did not create ADR-0000 or a template before later ADRs were written. One architecture-significant decision was marked Accepted without the experiments that it required of itself. The two existing ADRs used inconsistent front matter.

The repository needs a simple decision process. The process must distinguish hypotheses from decisions and keep missing or reserved numbers legible. It must also prevent design momentum from licensing production architecture.

## Decision

### Status model

Every ADR has exactly one status:

```text
Proposed → Accepted → Superseded
        ↘ Rejected
        ↘ Deferred
```

- **Proposed** — a decision is under consideration. It may authorise disposable experiments. It does not authorise architecture-significant production implementation.
- **Accepted** — the evidence is sufficient for the stated confidence, and implementation obligations may proceed.
- **Rejected** — the option was considered and should not be implemented under the recorded conditions.
- **Deferred** — the decision is outside the current scope by intent, or it lacks a prerequisite.
- **Superseded** — a later ADR replaces the decision. The original file remains unchanged. The only exception is a link to the superseding ADR, when practical.

### Required front matter

Every top-level ADR contains:

```markdown
# ADR-NNNN: Title

- **Status:** Proposed | Accepted | Rejected | Deferred | Superseded
- **Date:** YYYY-MM-DD
- **Owners:** names or accountable maintainer group
- **Confidence:** Low | Medium | High
- **Evidence:** experiment/result/review links or an explicit statement that evidence is pending
```

Optional fields include `Depends on`, `Supersedes`, `Superseded by`, `Review by` and `Related design`.

### Required body

An ADR records:

1. context and decision drivers;
2. options considered, including doing nothing where meaningful;
3. the decision or proposed direction;
4. evidence and validation obligations;
5. positive and negative consequences;
6. rejected alternatives;
7. revisit triggers.

An ADR is not a meeting transcript, a vendor feature list or a generic technology note.

### Evidence rule

An architecture-significant ADR may be Accepted only when its claimed evidence exists and can be reviewed.

Acceptable evidence may include:

- executable experiments with exact versions, commands and observations;
- contract, fault-injection, accessibility or performance tests;
- a completed reference journey evaluated against written criteria;
- a measured comparison of alternatives;
- direct repository evidence for reversible tooling/governance decisions.

Vendor documentation can establish availability, licensing or documented capability. It does not by itself prove integration cost, product quality, accessibility, automation, performance or failure behaviour.

### Exception for reversible repository housekeeping

Reversible changes may be accepted from direct repository evidence when they do not decide the product runtime. Examples are documentation indexes, `.gitignore`, CI checks, skill vendoring and experiment scaffolding. Their ADR must still state consequences and provenance.

### Numbering

- ADR numbers are four digits and never reused.
- A number may be reserved in `docs/decisions/README.md` before its file exists.
- The index lists reserved/unwritten decisions explicitly as `Proposed — not yet written`. They are not treated as lost decisions.
- Existing ADR-0015 and ADR-0016 keep their numbers because they were already published. The index makes 0001–0014 legible, and new decisions continue at 0017.
- A change to a title does not change the number.

### Stage gates

A later exploration stage cannot be declared complete while a required earlier deliverable is missing. While Stage 0 is open, a disposable experiment may begin only when it directly supplies the missing evidence and is clearly isolated under `prototypes/`.

### Design precedence

Accepted ADRs are the architecture authority. When an ADR changes an architecture-significant statement, `../architecture.md` and any affected contract under `../contracts/` must be updated in the same change.

## Consequences

### Positive

- People can explore proposed ideas, and nobody mistakes them for settled architecture.
- Evidence, confidence and implementation authority are visible.
- Reserved decision numbers no longer look like missing history.
- Coding agents receive one consistent source of decision precedence.
- New evidence can change decisions, and history is not rewritten.

### Negative

- Maintainers must keep the decision index and design status current.
- Some attractive implementation work will wait for an experiment result.
- Small ADRs still add documentation overhead. The exception above must not be extended to product decisions.

## Rejected alternatives

### Treat the initial design as a single omnibus ADR

Rejected. Unrelated choices would share one status, and evidence could not accept or reject them independently.

### Mark a decision Accepted with a list of future prototype obligations

Rejected. Obligations for rollout may remain after acceptance. But the evidence that is required to choose the architecture must exist before acceptance.

### Renumber all published ADRs immediately

Rejected. When 0015/0016 keep their numbers, references and history stay intact. The index resolves the apparent gap, and prior commits are not rewritten.

## Validation

- `docs/decisions/template.md` matches the required structure.
- `docs/decisions/README.md` lists every number from 0000 through 0017.
- CI checks the required front matter and duplicate top-level ADR numbers.
- ADR-0015 remained Proposed until EX-0002, EX-0003, DS1 and DS2 evidence and an explicit owner risk disposition were recorded. Its deferred obligation for an actual 200% rollout remains named and unpassed.
- Accepted decisions link to actual evidence, not to planned evidence.

## Revisit triggers

- The project adopts a formal decision-management tool with equivalent Git history and evidence links.
- Multiple maintainers require a different approval model.
- The number of ADRs makes the flat index impractical.
