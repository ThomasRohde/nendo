# ADR-0024: A file carries its own agent skill

- **Status:** Accepted
- **Date:** 2026-10-04
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** The host-level skill delivered under W-154 (`skill://nendo-authoring/SKILL.md`,
  served from the vocabulary with a verified manifest) and the Skills extension as published
  (SEP-2640, Final, read 2026-10-04). Accepted on the owner's standing pre-acceptance of ADR
  changes (2026-09-24); the build is a separate work item with its own acceptance criteria
- **Amends:** ADR-0013 (a package kind that carries no code)
- **Depends on:** ADR-0007 proposals, ADR-0009 the agent surface, ADR-0013 packages in the
  file, the Skills extension (W-154)
- **Related design:** [MCP interface contract](../contracts/mcp-interface.md)

## Context

Since W-154 the host serves one skill over the Skills extension: an index of the authoring
reads, generated from the build's own tables. It describes every Nendo file the same way,
because it knows the host and not the file.

A file knows things an agent working on it needs that no host build can say. The planner
file has its `pl.cmd.*` commands, its Reference codes, its lane rules and its handoff
etiquette, all written today in `docs/dogfooding.md` and read by every session from the
repository rather than from the file it is about to edit. A CRM file would want to say how
a lead is qualified; an operations room, which records a shift closes. Each is a workflow
over the file's own record types and commands, and today it lives beside the file, or
nowhere.

ADR-0013 already lets a `.nendo` file carry a custom-view package: files under a package ID,
written by `extension.putFile`, reviewed line by line as a proposal before acceptance,
served back over MCP under `nendo://application/extension/{packageId}/file`. The Skills
extension defines a skill as a directory with a `SKILL.md` and supporting files, listed with
a manifest of SHA-256 digests, loaded by a host that verifies the bytes and asks the person
before the content reaches a model. The two shapes are the same shape. What is missing is a
package that carries no code, and a listing that reaches it.

## Decision drivers

1. Instructions aimed at an agent are part of what a file is, as its screens are: they
   change by proposal, the person reads them before accepting, and they travel with the
   file.
2. A skill's content is untrusted by the extension's own rules. The host that loads it
   verifies digests and requires approval; the server that serves it must not be the one
   that vouches for it.
3. No new place for code to run. ADR-0013's rule that file-carried code runs only as a
   view in the view's own frame stays.
4. A file without a skill is served exactly as today.

## Options considered

### A. A package kind `skill` under ADR-0013

`extension.setPackage` takes a `kind`: `view` (the default, today's packages) or `skill`. A
skill package holds a `SKILL.md` at its root and any supporting files, and no entry point.
It is written, reviewed and accepted as every package is, enters History as a definition
revision, and is served under its package ID as `skill://{packageId}/SKILL.md` and
`skill://{packageId}/{path}`, with the host's own skill listed beside it in `skills/list`.
The Workbench shows a skill package in Studio's package list, as text, and never runs it.

Benefits: one package model, one review, one proposal path, one storage ladder, and the
listing is a projection of what the file already holds. Costs: `kind` is a schema change
to the package record (the layout ladder's rung for package metadata), and a
`skill` package with an executable file must be refused at validate.

### B. A new definition kind beside packages

A `skill` definition under `behaviour.setDefinition`, with its text in the definition body.
Benefits: no change to packages. Costs: a second way to carry files in a file, its own
review rendering, its own size bounds, and a body that is a directory pretending to be a
definition.

### C. Do not do it

The repository's instructions stay where they are. A file's workflow is told to an agent by
whoever registers the server, or not at all. Costs: the planner's rules remain in a
document only this repository reads, and every other file has no voice.

## Decision

Option A. A `.nendo` file may carry a package of kind `skill`: a `SKILL.md` whose
frontmatter names it, and supporting files, with no executable entry point.

- It enters the file only through a proposal the person accepts, reviewed as the package's
  files are reviewed today, line by line, and it is a definition revision with the
  reversibility a package change has.
- The host lists it in `skills/list` beside its own skill, with a manifest computed from
  the bytes it serves, and serves its files as resources under `skill://{packageId}/`.
  `skills/get` resolves either. The host's skill keeps the `nendo-authoring` name; a file
  skill's name is its package ID's last segment, so a host preserves both server identity
  and URI as the extension requires.
- A `skill` package has no entry point and is never run. A file whose skill package names
  one, or whose `SKILL.md` lacks the required frontmatter, does not validate; the diagnostic
  names the file.
- Studio shows a skill package among the file's packages, as text, with the same review
  that accepted it; nothing in the host or the Workbench loads it into a model. Loading is
  the client's act, under the client's approval.
- Content stays untrusted on both sides: the host verifies nothing about what the text asks
  an agent to do, and a client that loads it is bound by the extension's verification and
  approval rules. The person's protection is the review before acceptance and History
  after it.
- The agent surface is unchanged: no new tool, no new level, and a file with no skill
  package lists one skill as today.

## Evidence and validation obligations

- The build (a work item under this ADR, Later) delivers: `kind` on `extension.setPackage`
  and the vocabulary; refusal at validate of an entry point or missing frontmatter on a
  `skill` package; `skills/list` with both entries and digests equal to the bytes served;
  Studio's package list showing the kind; the contract, Help and the blackbox prompt.
- A test that a file with no skill package serves exactly the host's one skill.
- The planner's own skill, written from `docs/dogfooding.md`'s commands and reference
  rules, proposed and accepted into `workspace/Planner.nendo`, and `docs/dogfooding.md`
  shortened to point at it.

## Consequences

### Positive

- A file teaches the agent connected to it. The planner's workflow stops living in a
  document only one repository reads.
- One package model carries both views and skills; the review, the storage and the
  reversibility are already built.

### Negative

- A package kind is a schema change, with a rung on the layout ladder and a minimum host
  version raise for files that carry one.
- An agent that loads a file's skill takes instructions from the file it edits. The
  extension makes that the client's approval to give; this ADR adds no second gate.

## Rejected alternatives

Option B was rejected because a skill is files, and the file already has a reviewed way to
carry files; a definition body would duplicate the package's size bounds, review rendering
and storage for one more kind. Option C was rejected because the planner's rules have been
restated in `docs/dogfooding.md` for three weeks and every session re-reads them; the file
that has the commands is the right place to say how they are used.

## Revisit triggers

- The Skills extension changes its manifest or approval rules before the build lands.
- A client loads a file skill without the approval the extension requires, which would make
  the review-before-acceptance the only gate and call for one more.
