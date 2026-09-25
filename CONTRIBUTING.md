# Contributing

Nendo is a research prototype with one author. Issues, questions and small
focused pull requests are welcome; replies may be slow, and a change that moves
the product's shape will be turned into a decision before it is turned into
code. If you are about to spend a weekend on something, open an issue first.

## Read before changing anything

- [`docs/vision.md`](docs/vision.md) — the product axioms. A change that
  contradicts one needs an accepted ADR, not a good argument.
- [`docs/architecture.md`](docs/architecture.md) — the system as built, and its
  "Where things live" table.
- [`docs/decisions/`](docs/decisions/README.md) — accepted ADRs are the
  architecture authority. Deferred and scheduled ones authorise nothing.
- [`docs/contracts/`](docs/contracts/) — load the one contract your change
  touches, not all of them.

Where a document and the code disagree, the code is current. Fix the document in
the same change rather than working around it.

## What you need

- The .NET SDK version pinned in [`global.json`](global.json). `rollForward` is
  `latestFeature`, so a newer preinstalled SDK can silently win the pin — set
  `DOTNET_INSTALL_DIR` to a local path if that matters to you.
- Node at the floor declared in `src/Nendo.Workbench/package.json` (`engines`).
- **Windows.** `Nendo.Engine` is `net10.0` and builds anywhere, but the Desktop
  host is WinUI 3 (`net10.0-windows10.0.26100.0`) with WebView2, so the solution
  as a whole is Windows x64 only.

Build the Workbench before the host — it is bundled into the Desktop output:

```powershell
cd src/Nendo.Workbench; npm ci; npm run build; cd ../..
dotnet build Nendo.slnx
```

## Run the gate

The product has no CI, deliberately — see
[architecture.md](docs/architecture.md#building-and-verifying). The gate runs in
about a minute locally, and it is the gate:

```powershell
pwsh ./tools/Test-Repository.ps1     # fast invariant check
pwsh ./tools/Test-Production.ps1     # full gate; already includes the above
```

Do not run `Test-Production.ps1` twice, and use `-SkipRestore` only when
dependencies have not changed. Some lanes drive a real Desktop window and are
not in the gate; `architecture.md` lists them.

The public website in `site/` is the one thing with a CI lane
([ADR-0018](docs/decisions/0018-public-website-and-deployment-lane.md)). It is
outside the product boundary and outside the gate; build it locally with
`pwsh ./tools/Test-Site.ps1`.

## House rules

- **Line endings.** Every tracked text file is UTF-8 without a BOM and ends its
  lines with LF. `.gitattributes` says `* text=auto eol=lf`, and the gate
  refuses a CRLF or mixed working copy by file name before any check that would
  misreport it. Count bytes to check:
  `python -c "import pathlib;print(pathlib.Path('FILE').read_bytes().count(b'\r'))"`.
- **British English** in documentation.
- **Say what was measured.** This project distinguishes an automated check from
  something a person observed, and the distinction is load-bearing. Do not
  describe an owner-reported result as a test pass, and record a limitation as a
  limitation — [`docs/roadmap.md`](docs/roadmap.md) has a place for it.
- **A guard you have never seen fail is a guess.** When you fix something
  reported broken, add a check that measures what was wrong in a lane that
  already runs, put the defect back, watch the check fail, and quote the failure
  text in the pull request.
- **Update the contract, ADR or architecture document in the same change as the
  behaviour**, and extend
  [`docs/reviews/blackbox-prompt.md`](docs/reviews/blackbox-prompt.md) when a
  change adds something a client or a person can see.
- Keep `workspace/` and `artifacts/` out of it: the first holds real `.nendo`
  files that are never reset or used as fixtures, the second is scratch.

## Invariants a pull request must not relax

These are enforced by `Test-Production.ps1` and by review:

- An empty-but-valid `.nendo` file stays valid, and the host-owned Studio and
  recovery path stay permanently reachable.
- Native UI, web Workbench and MCP adapters use the same typed application
  services. No raw SQL, SQLite connection, database path or generic privileged
  invocation escapes the Engine's storage boundary.
- Canonical typed operations with stable semantic IDs. Whole-document
  convenience APIs expand to typed operations before diff, history or promotion.
- Data and definition revision lineages stay distinct.
- Promotion replays validated operations against the active file. It never
  replaces the active file with a proposal clone.
- Every operation declares its reversibility class. Nendo does not claim
  universal undo.

Out of scope without an accepted ADR: general JavaScript or expressions, binary
and asset fields, scalar multi-choice, EF Core, a second persistence provider, an
in-process AI framework, or a broad new abstraction layer.

## If you are a coding agent

Read [`AGENTS.md`](AGENTS.md); [`CLAUDE.md`](CLAUDE.md) imports it. It carries
the working style, the planner handoff and several environment traps that have
each cost a session.

## Licence

Contributions are accepted under the [MIT licence](LICENSE). Do not remove
third-party notices, and say where adapted code came from.
