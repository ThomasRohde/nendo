# ADR-0024: A file carries its own agent skill

- **Status:** Accepted
- **Date:** 2026-10-04
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** The Skills extension (SEP-2640); the skill-package tests named in the custom-views contract; the planner's own skill, served from `workspace/Planner.nendo`
- **Amends:** ADR-0013 (a package kind that carries no code)
- **Amended by:** [ADR-0029](0029-a-skill-may-carry-scripts-its-client-runs.md) (a skill's supporting files may include scripts its client runs)
- **Depends on:** ADR-0007, ADR-0009, ADR-0013
- **Contract:** [custom views, Skill packages](../contracts/custom-views.md#skill-packages), [MCP interface](../contracts/mcp-interface.md)

## Context

The host serves one skill over the Skills extension, `nendo-authoring`, generated from the
build's own tables. It describes every file the same way. A file knows things no host build can
say: its commands, its codes, its workflow. ADR-0013's packages already give a file reviewed,
versioned files served over MCP, and the Skills extension defines a skill as a directory with a
`SKILL.md` and supporting files. What was missing was a package that carries no code, and a
listing that reaches it.

## Decision

A `.nendo` file may carry a package of kind `skill`: a `SKILL.md` whose frontmatter names it, and
supporting files, with no entry point.

- `extension.setPackage` takes `kind`: `view` (the default) or `skill`. A skill package enters the
  file only through a proposal the person accepts, reviewed line by line as package files are, and
  is a definition revision with a package change's reversibility.
- The host lists it in `skills/list` beside `nendo-authoring`, with a manifest computed from the
  bytes it serves, and serves its files as `skill://{packageId}/{name}/SKILL.md` and
  `skill://{packageId}/{name}/{path}`. The name is the package ID's last segment, which is also
  the frontmatter name the extension requires before `SKILL.md`. `skills/get` resolves either
  skill. `skills/list` is `private` with TTL 0, since it follows the open file.
- A skill package has no entry point and is never run by Nendo. A skill package that names an
  entry point, or whose `SKILL.md` lacks the required frontmatter, does not validate (`NPROP012`);
  a view that names a skill package is `NUI454`.
- Studio shows a skill package among the file's packages, as text. Nothing in the host or the
  Workbench loads it into a model; loading is the client's act, under the client's approval.
- Content is untrusted on both sides. The host vouches for nothing the text asks; the person's
  protection is the review before acceptance and History after it.
- The agent surface is otherwise unchanged: no new tool or level, and a file with no skill
  package lists the host's one skill.

## Consequences

- A file teaches the agent connected to it, and its workflow stops living in documents beside it.
- One package model carries views and skills; review, storage and reversibility are shared.
- The package kind is a ladder rung and a minimum-host raise for files that carry one.
- An agent that loads a file's skill takes instructions from the file it edits; that is the
  client's approval to give.

## Rejected alternatives

- **A skill as a definition kind:** duplicates the package's size bounds, review and storage.
- **No file skills:** a file's workflow stays in documents only one repository reads.

## Revisit triggers

- The Skills extension changes its manifest or approval rules.
- A client loads a file skill without the approval the extension requires.
