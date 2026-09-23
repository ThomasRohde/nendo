# Nendo repository instructions

## Read first

- [`docs/vision.md`](docs/vision.md) — the product axioms. A change that violates
  one needs an accepted ADR, not a good reason.
- [`docs/architecture.md`](docs/architecture.md) — the system as built, and where
  things live.
- [`docs/roadmap.md`](docs/roadmap.md) — what is next and what is not qualified.
- [`docs/dogfooding.md`](docs/dogfooding.md) — the Nendo Development planner,
  its setup status, and the work/evidence handoff for development tasks.
- Accepted ADRs in [`docs/decisions/`](docs/decisions/README.md) are the
  architecture authority. Deferred and scheduled ADRs grant no implementation
  authority on their own.
- [`docs/contracts/`](docs/contracts/) — load the one contract your task touches,
  not all of them.

Where a document and the code disagree, the code is current. Fix the document in
the same change rather than working around it.

## Architecture invariants

These are enforced by `Test-Production.ps1` and by review. Do not relax one to
make a task easier.

- An empty-but-valid `.nendo` file stays valid, and the host-owned Studio and
  recovery path stay permanently reachable.
- Native UI, web Workbench and MCP adapters use the same typed application
  services. No raw SQL, SQLite connection, database path or generic privileged
  invocation escapes the Engine's storage boundary.
- Use canonical typed operations with stable semantic IDs. Whole-document
  convenience APIs expand to typed operations before diff, history or promotion.
- Keep data and definition revision lineages distinct; use per-record versions
  for touched data.
- Promotion replays validated operations against the active file. It never
  replaces the active file with a proposal clone.
- Every operation declares its reversibility class. Do not claim universal undo.
- Out of scope without an accepted ADR: general JavaScript or expressions,
  binary and asset fields, scalar multi-choice.

## Working style

- Complete authorized work and routine reversible decisions without repeated
  permission pauses. Ask when missing information materially changes scope, or
  when an action needs authority not already given.
- Search paths and symbols before opening files. Load the matching skill and the
  sections you need once; do not preload every skill and ADR. Batch independent
  reads; keep dependent mutations sequential.
- Keep one concise checkpoint for sustained work: objective, decisions, changed
  paths, exact evidence, remaining work. Never drop required acceptance evidence
  to save tokens.
- Report exact commands and literal outcomes. Distinguish restore, build, test,
  packaging and runtime failures. If a step was skipped, say so.

## Plan and record work in Nendo

- These rules apply to both Codex and Claude Code. `CLAUDE.md` imports this file;
  keep the shared workflow here and in `docs/dogfooding.md` so it cannot drift
  into different instructions for the two clients.
- At session start, in this order: read [`docs/dogfooding.md`](docs/dogfooding.md),
  read the Work records, take the Now lane and then Next, and read that item's
  **Decision standing** before anything else. Name the item you are on by its
  Reference and title.
- **Standing is the authority gate.** *Needs decision/ADR* means no `src/` change
  until the owner accepts an entry, however obvious the implementation looks. The
  item's description carries the next action; write the next action back into it
  whenever you leave the item open.
- **You author; the person accepts.** Validate a change set into a proposal,
  release the lease, and hand over by the proposal's exact title so they can find
  it. Never describe a proposal as applied before they have accepted it.
- Nendo Development is the primary work planner. Read
  [`docs/dogfooding.md`](docs/dogfooding.md) for rollout status, semantic IDs, the
  reference ledger and how to read the file without paying for it twice.
  Connect through the registered `nendo` MCP server and inspect the open
  application before writing. Do not open its SQLite storage directly.
- Find or create the relevant Work item; read its acceptance criteria, linked
  Findings and Checks. Horizon (Now / Next / Later) expresses priority; Status
  expresses execution. A planner entry never grants ADR or remote-write authority.
- Name records by their short Reference and title in conversation (for example,
  W-001), then resolve the reference to the semantic ID/current version for MCP
  writes. Follow the allocation and uniqueness checks in `docs/dogfooding.md`;
  the host does not assign these codes automatically.
- Record actual progress, new observations and exact check outcomes. Distinguish
  Automated, Agent-observed and Owner-reported evidence; preserve Not run,
  Blocked and Accepted exception outcomes. Check passes never automatically
  make work Done. Leave incomplete work open at handoff.
- Use short MCP edit leases for planner updates and release them while coding or
  running tests. The single lease serializes file edits, not ownership of a
  development task. Respect work already Doing; use a named handoff before two
  clients change the same scope. Never revoke another client's lease merely to
  make progress. Include the stable work-item ID, changed paths, exact check
  outcomes and remaining work in the handoff.
- When the planner is unavailable or still being set up, say so, continue
  already-authorized independent work from repository instructions, and reconcile
  outcomes when it returns. Do not create a replacement planner or silently
  infer priorities from an old export.

## Files and line endings

Every tracked text file is UTF-8 without a BOM and ends its lines with LF.
`.gitattributes` says `* text=auto eol=lf`, and the repository gate refuses a
CRLF or mixed working copy by file name, before any check that would misreport it.
Do not spend a round on this:

- Write and edit files with tools that preserve bytes: the Edit and Write tools,
  or a script that controls the bytes it writes. Never `perl -pi` from the Bash
  tool: on this machine it writes CRLF and double-encodes existing non-ASCII text.
- Python is fine for a bulk or repeated edit, but only with the newline translation
  off and the result counted:
  `pathlib.Path(f).write_text(text, encoding='utf-8', newline='')`, then the CR
  count below. Python's *default* text mode writes CRLF here, so `newline=''` is
  what makes it safe — not the language.
- Check endings by counting bytes, never with a shell `$'\r'` pattern, which the
  Bash tool does not expand:
  `python -c "import pathlib;print(pathlib.Path('FILE').read_bytes().count(b'\r'))"`.
- Fix a file by replacing `\r\n` with `\n` in bytes and writing the bytes back.
- Run `tools/*.ps1` through the PowerShell tool from the repository root.

**A Bash command longer than ~8,186 bytes is silently truncated** on this machine
(measured 2026-09-15: 8,166 bytes of payload plus a 20-byte wrapper is the last
length that survives; Git Bash cuts `bash -c` at an 8 KiB buffer). The cut usually
lands inside a quoted string, so bash reports:

```text
/usr/bin/bash: -c: line N: unexpected EOF while looking for matching `''
```

That message names a quoting bug in the text you wrote. **It is not one**, and the
line number it gives is not where the problem is. It means the command was too
long. This has cost several sessions a wrong diagnosis, because the obvious reading
is to go hunting for an apostrophe in the content.

It bites heredocs hardest, since they carry a whole file in one command — a
`cat > file <<'EOF'` or a `python - <<'PY'` script. So:

- Author and rewrite files with the **Write tool**, which has no such limit. Auto
  mode asks for Bash where Bash can do the job; above this size it cannot.
- Keep heredocs for content comfortably under ~6 KB, leaving room for the `cd`,
  the redirect and any verification command sharing the line.
- A heredoc that silently produced a short file rather than an error was truncated
  too. Check the byte count, not just the exit code.

## .NET work

- Repo-scoped first-party .NET skills are vendored under `.agents/skills/`. Use
  the matching skill when its description applies.
- Inspect the installed SDK, templates, workloads, MSBuild and test configuration
  instead of guessing current flags or generated files.
- Do not introduce EF Core, ASP.NET data patterns, MAUI, an in-process AI
  framework, a second persistence provider or a broad abstraction layer without
  an accepted ADR or an explicit task.
- Do not edit vendored skill files. Update them through
  `tools/Sync-DotnetSkills.ps1` and review the resulting diff.
- `.codex/config.toml` sets this project's Codex CLI defaults (`gpt-6-astra` at
  low reasoning). Explicit task or CLI settings take precedence; raise effort for
  a concrete unresolved problem rather than by default.

## UI work

- Use [`docs/assets/mockups/molded-workbench/README.md`](docs/assets/mockups/molded-workbench/README.md)
  and the mockups beside it as the selected visual and interaction direction.
- Preserve the shared Molded Workbench shell, the permanent Studio route, the
  Nendo logo treatment and the material workflow coverage shown across the
  mockup series. One screenshot is not an isolated page.
- Support the device theme preference: System follows Windows; Light and Dark are
  explicit overrides. Apply the effective theme to the app frame, Studio, custom
  surfaces, dialogs, title bar and safe mode, and verify UI work in both states.
- Mockups are product and visual reference, not architecture authority. Contracts
  and accepted ADRs govern behaviour. Record any intentional divergence.
- **A screenshot in a gate proves nothing on its own.** Whatever the eye would
  check, measure: the geometry, the number, the screen that opens by default. Two
  S4 defects reached the owner through screenshots the gate had already passed,
  and S2 had learned the same thing before it.

## Validation and handoff

- Run the narrowest applicable build and tests, plus `pwsh ./tools/Test-Repository.ps1`.
- For full validation use `pwsh ./tools/Test-Production.ps1`, which already
  includes the repository gate — do not run it twice. Use `-SkipRestore` only
  with unchanged dependencies.
- The public website in `site/` is outside the product boundary and outside the
  gate ([ADR-0018](docs/decisions/0018-public-website-and-deployment-lane.md)).
  Build it with `pwsh ./tools/Test-Site.ps1`; `.github/workflows/pages.yml`
  deploys it and is the repository's only CI lane. It does not render `docs/`: its
  guides are hand-written for outsiders in `site/src/content/docs/` and describe
  the product as it is now. When a change alters something a guide states, update
  the guide in the same change. Its screenshots come from `pwsh ./tools/Capture-SiteScreenshots.ps1`, which
  drives a real host against a copy of `workspace/Nendo Station.nendo`. Never
  commit a `.webp`, `.jpg` or `.woff2` under `site/` — `Test-BinaryAssets.ps1`
  has a structural reader for `.png`, `.ico`, `.mp4` and `.nendo` only.
- When rebuilding the app, rebuild the installer in the same task:
  `Publish-NendoPayload.ps1` → `Build-NendoInstaller.ps1` → `Test-NendoInstaller.ps1`.
  Deliver `artifacts/installer/Nendo-Setup.exe`, upgrading the per-user
  `Programs/Nendo` installation in place. Do not run the install/uninstall smoke
  over an owner installation — use `Test-NendoSetupIsolated.ps1`.
- Windows x64 only for interim installers; ARM64 waits for final production.
- Keep verbose logs under task-owned `artifacts/` and return summaries plus
  actionable failures. See [Artifacts](#artifacts) — that directory is scratch,
  not a record.
- Update the affected contract, ADR or architecture document in the same change
  as the behaviour. Inspect the final changed-file set and remove only transient
  artefacts your task created.
- When a change adds something a client or a person can see, extend
  [`docs/reviews/blackbox-prompt.md`](docs/reviews/blackbox-prompt.md) in the same
  change so the next outside review reaches it. The repository gate checks that
  every contract is accounted for there; it cannot check that a phase is honest.

## When something is reported broken

The same loop every time. The last two steps are the ones that get skipped.

1. Locate it in the code before changing anything. A screenshot says where it
   looks wrong, not where it is wrong.
2. Fix it.
3. Add a guard that **measures** what was wrong, in a lane that already runs.
4. **Falsify the guard.** Put the defect back, watch the guard fail, and quote the
   failure text. A guard nobody has seen fail is a guess.
5. Restore the fix, re-run, and record a Finding carrying that falsification text.

A guard that would have passed against the old code is guarding the symptom rather
than the defect. Say so, and write the one that would have failed.

## Workspace

`workspace/` holds the real `.nendo` files this project works in.
`workspace/Nendo.nendo` is the live Nendo Development planner; the others are
demo and test files kept because they are worth reopening. Never delete,
overwrite, reset or use one as a failure fixture. Leave active host-owned
sidecars to Nendo — `.gitignore` already keeps every `-wal`, `-shm`, journal and
write-owner file out of git. Use host-owned backup/copy flows for these files;
`.nendo` storage is never edited directly by an agent.

**The planner itself is git-ignored.** It changes on every write and git would
store each 5 MB version whole, so it is owner data that lives here and is backed
up by the owner, not by this repository. The demo files are tracked, because they
change only when somebody rebuilds them and they are worth having after a sweep
of `artifacts/`. `tools/Test-BinaryAssets.ps1` opens every tracked one and checks
the SQLite header, the page multiple and Nendo's own application id, so a
truncated or half-written copy is refused by name rather than committed.

## Artifacts

`artifacts/` is git-ignored scratch: build output, the current payload and
installer, and whatever a run writes while you work. Delete freely, subject to
the checks below, and clean up what your task created. Nothing owner-owned lives
here any more — that is what `workspace/` is for.

The evidence for this project is the test suite. It runs in about a minute and
lives in git, so a stored run output from last week proves nothing it cannot
prove now. Do not build a retention scheme on top of this directory, do not
archive run outputs "for traceability", and do not turn `workspace/` into one — that is how this directory reached 5.7 GB of dead
weight.

Three things are worth a second's thought before deleting:

- `artifacts/installer/` is the built deliverable plus one rollback copy.
  Rebuildable via `Publish-NendoPayload.ps1` → `Build-NendoInstaller.ps1`, but
  that costs a few minutes and needs NSIS.
- Prune a manifest-backed payload under `artifacts/build/publish` through
  `Remove-NendoBuildPayload.ps1`, which hash-checks each file first.
- `artifacts/` is git-ignored, so nothing here is recoverable from a tag or a
  commit. A `.nendo` file that turns up here is either a disposable fixture or
  something that belongs in `workspace/`; open it before deleting.

A lane that stages a large payload should delete it on success — see
`Test-NendoSetupIsolated.ps1` — rather than leaving it for a later sweep.

## Honest reporting

This project distinguishes what was measured from what was reported, and the
distinction is load-bearing. Do not describe an owner-reported result as a test
pass, do not reinterpret an unchecked lane as an automated one, and do not
invent measurements. If something is a limitation, record it as a limitation —
[`docs/roadmap.md`](docs/roadmap.md) has a place for it.

Say what was checked, not whether something is "verified". "Verified" and
"unverified" collapse several different questions into one word and read as a
verdict on quality, which is usually not what is meant. Name the lane and its
scope instead:

- Good: "the setup logic passed against a task-owned root; the NSIS wrapper is
  unchecked because that lane needs a clean Windows user."
- Bad: "the installer is unverified."

The same applies to a tool that declines to run. A guard that protects your
installation or your data is an interlock, not a failure — report it as the
safety behaviour it is, and name the alternative that does run.
