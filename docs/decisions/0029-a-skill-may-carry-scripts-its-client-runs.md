# ADR-0029: A skill may carry scripts its client runs

- **Status:** Accepted
- **Date:** 2026-10-08
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** The Codemap plan ([design](../design/codemap.md)), which needs a deterministic
  repository scanner that every agent runs the same way. The Agent Skills format, which lets a
  skill's supporting files include scripts for the client to run. The review line in
  `SemanticDiff.cs` and Studio's card in `view-frame-markup.ts`, which today say a skill
  package holds nothing that runs. Accepted on the owner's standing pre-acceptance of ADR
  changes (2026-09-24). The build is slice S1 of the Codemap plan, with its own acceptance
  criteria
- **Amends:** ADR-0024 (what a skill package's supporting files may be), and the reading of
  ADR-0013's rule that code a file carries runs only as a view
- **Depends on:** ADR-0009 the agent surface, ADR-0013 packages in the file, ADR-0024 a file
  carries its own agent skill
- **Related design:** [Codemap](../design/codemap.md), [Custom views contract](../contracts/custom-views.md)

## Context

ADR-0024 lets a `.nendo` file carry a skill package: a `SKILL.md` and supporting files, with
no entry point, that a client loads under its own approval. The host validates the
frontmatter and refuses an entry point. It does not look at the other files' types, so a
skill package may already hold a `.mjs` file today. Three texts say otherwise or say nothing:

- `AGENTS.md`: "JavaScript that a `.nendo` file carries runs only as custom-view code under
  ADR-0013."
- The vision puts "extension code that runs without a view" out of scope.
- The proposal line for a skill package ends "Nothing in it runs.", and Studio's card says
  "Nothing in it runs in Nendo."

Codemap needs a scanner. An agent in any repository has to turn git history and a file tree
into units, counts and fingerprints. If each agent does that arithmetic in its own context,
it costs tokens on every pass, the results differ from agent to agent, and the demo file
built by this repository cannot be compared with what agents write. A small dependency-free
script, carried by the file's skill and run by the agent with Node, removes all three
problems. It reads the repository and prints JSON. It never touches the `.nendo` file, the
network or Nendo.

The question is whether a file may carry such a script, and what the person must be told
when they accept one.

## Decision drivers

1. Nendo never runs code a file carries outside a view's frame. That is the boundary the
   vision and ADR-0013 protect, and it does not move.
2. What runs on the agent's machine is the client's decision, under the client's approval, as
   loading a skill already is.
3. The person who accepts a proposal is told what it carries, accurately. "Nothing in it runs"
   must not be said of a package whose purpose is a script.
4. No new tool, level or storage.

## Options considered

### A. Supporting files may be scripts, named in the review

A skill package's supporting files may include scripts that a client runs on its own
machine. Nendo stores and serves them as text, never runs them, and names each of them when
the person reviews the proposal and in Studio.

Benefits: one scanner, versioned with the skill and the file, reviewed like every other
package file. Costs: a script in a proposal is something the person should read. A small host
change makes the review say so.

### B. Keep scripts out of files

The scanner lives in a repository or a user tools folder, and the user's own agent
instructions point at its path. Benefits: no change of rule. Costs: the skill and the
scanner can drift apart, and the scanner lives at a path on one machine that the file cannot
name. The file stops being the whole application.

### C. Commands only

`SKILL.md` lists git and shell commands, and the agent computes the rest. Benefits: nothing
in the file is runnable. Costs: every pass spends the agent's context on arithmetic, the
counts depend on the agent, and the demo cannot be built by the same rules.

## Decision

Option A.

- A skill package's supporting files may include scripts: any file a client could execute,
  such as `.js`, `.mjs`, `.cjs`, `.ps1`, `.py`, `.sh`, `.cmd` and `.bat`. Validation does not
  refuse them. A skill package still names no entry point.
- **Nendo never runs them.** The host serves them as text under `skill://{packageId}/{name}/`
  and from the package file resource, as it serves every package file. No view, action,
  command or tool executes them, and no Nendo surface offers to.
- **The review names them.** When a proposal adds or changes a skill package that carries
  scripts, its line names each script file and says that a connected agent may run it on its
  own machine and that Nendo never runs it. Studio's card for the package says the same.
  Today's wording stays for a skill package with no scripts.
- **The skill says what each script does.** `SKILL.md` states what each script reads,
  writes and needs. The host checks none of it. Content stays untrusted, as ADR-0024 says.
  The person's protection is the review before acceptance, and History after it.
- **Running one is the client's act**, under the client's own approval. Claude Code asks
  before it runs a command, as it does for any command.
- The boundary in `AGENTS.md` and the vision now reads: JavaScript a file carries runs in
  Nendo only as custom-view code. A skill's script runs only in the client that loads it.

## Evidence and validation obligations

The build is slice S1 of the [Codemap plan](../design/codemap.md#build-slices):

- An Engine test that a skill package carrying `scan.mjs` validates, and that its review line
  names the file and says Nendo never runs it.
- A test that a skill package with no script keeps today's line.
- A Workbench test for Studio's card in both cases.
- The custom-views contract's *Skill packages* section, Help and the blackbox prompt updated
  to say the same.

## Consequences

### Positive

- An application can carry the tools its agents need, versioned and reviewed with the file.
- Codemap's passes are deterministic and cheap, and its demo is built by the scanner agents
  run.

### Negative

- An agent that runs a file's script runs code the file chose. The review is the person's
  gate, and the client's approval is the agent's. Neither checks what the script does.
- A file at Unattended can change its own skill, scripts included, without anybody reading
  the change. That is already true of the skill's instructions (ADR-0024). Codemap is kept at
  Edit data for this reason.

## Rejected alternatives

Option B was rejected because it splits one application across a file and a path on one
machine, and nothing keeps the two in step. Option C was rejected because it spends every
agent's context on counting. The counts would then depend on the agent, so the demo built
here and the maps agents write could not be compared.

## Revisit triggers

- A client runs a skill's script without asking, which would leave the review as the only
  gate.
- A script would need to write to the `.nendo` file directly, or Nendo would need to run one.
  Either needs a new ADR, not an amendment of this one.
