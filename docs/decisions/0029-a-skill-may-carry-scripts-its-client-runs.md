# ADR-0029: A skill may carry scripts its client runs

- **Status:** Accepted
- **Date:** 2026-10-08
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** The Agent Skills format, which lets a skill's supporting files include scripts for the client to run; the skill-package review line in `SemanticDiff.cs` and Studio's card in `view-frame-markup.ts`
- **Amends:** ADR-0024 (what a skill package's supporting files may be), and the reading of ADR-0013's rule that code a file carries runs only as a view
- **Depends on:** ADR-0009, ADR-0013, ADR-0024
- **Contract:** [custom views, Skill packages](../contracts/custom-views.md#skill-packages)

## Context

An agent sometimes needs deterministic work done the same way every time, for example a
repository scanner that turns git history and a file tree into units, counts and fingerprints.
Done in each agent's context, it costs tokens on every pass and gives different results per
agent. A small dependency-free script carried by the file's skill and run by the agent removes
both problems. ADR-0024's validation does not look at supporting files' types, so a skill
package can already hold one; the question is what the person is told when they accept it.

## Decision

- A skill package's supporting files may include scripts: any file a client could execute, such
  as `.js`, `.mjs`, `.cjs`, `.ps1`, `.py`, `.sh`, `.cmd` and `.bat`. Validation does not refuse
  them. A skill package still names no entry point.
- **Nendo never runs them.** The host serves them as text under `skill://{packageId}/{name}/` and
  from the package file resource. No view, action, command or tool executes them, and no Nendo
  surface offers to.
- **The review names them.** A proposal line for a skill package that carries scripts names each
  script and says a connected agent may run it on its own machine and Nendo never runs it; Studio's
  card says the same. A skill package with no scripts keeps today's wording.
- **The skill says what each script does.** `SKILL.md` states what each script reads, writes and
  needs. The host checks none of it; content stays untrusted (ADR-0024). The person's protection is
  the review before acceptance and History after it.
- **Running one is the client's act**, under the client's own approval.
- The boundary reads: JavaScript a file carries runs in Nendo only as custom-view code. A skill's
  script runs only in the client that loads it.

**Not built yet:** the review line still ends "Nothing in it runs." and Studio's card "Nothing in
it runs in Nendo." for every skill package, and neither names a script. The build owes an Engine
test of both review lines, a Workbench test of Studio's card in both cases, and the custom-views
contract's *Skill packages* section and Help updated to match.

## Consequences

- An application can carry the tools its agents need, versioned and reviewed with the file.
- An agent that runs a file's script runs code the file chose. The review is the person's gate and
  the client's approval the agent's; neither checks what the script does.
- A file at Unattended can change its own skill, scripts included, without anybody reading the
  change, as it already can its instructions.

## Rejected alternatives

- **Scripts kept outside the file:** splits one application across a file and a path on one machine.
- **Commands only in `SKILL.md`:** spends every agent's context on arithmetic, with results that
  depend on the agent.

## Revisit triggers

- A client runs a skill's script without asking, which leaves the review as the only gate.
- A script would need to write to the `.nendo` file directly, or Nendo would need to run one;
  either needs a new ADR.
