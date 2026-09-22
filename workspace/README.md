# Workspace

The real `.nendo` files this project works in, out of the sweepable `artifacts/`.
The demo files are tracked; the live planner is the owner's data and is ignored.

| File | What it is | In git |
| --- | --- | --- |
| `Nendo.nendo` | The live [Nendo Development planner](../docs/dogfooding.md): work items, findings, checks and initiatives. Real work, not a fixture. | **No** — ignored |
| `Work dependencies demo.nendo` | Fourteen test tasks and their dependencies, with the [work-dependency view](../extensions/work-dependencies/README.md) pinned: a chain, an isolated task, a three-task cycle and one task behind it. | Yes |
| `Nendo graph demo (fitted).nendo` | A small record graph with the [dependency-graph package](../extensions/dependency-graph/README.md) pinned. | Yes |
| `Nendo custom-view demo.nendo` | The first custom-view demo, kept as the shape that slice produced. | Yes |
| `Nendo Station.nendo` | [Nendo Station](../docs/nendo-station.md), the fourth reference application: a fictional habitat run as an operations room, with the [Systems Lens](../extensions/systems-lens/README.md) schematic pinned. Rebuilt by `tools/Build-NendoStation.mjs` rather than edited. | Yes |

## Rules

- **Never** delete, overwrite, reset or use one of these as a failure fixture.
- `.nendo` storage is never edited directly by an agent. Write through the host:
  the Nendo application, or the `nendo` MCP server against the file it has open.
- Host-owned sidecars (`-wal`, `-shm`, journal, write-owner) belong to Nendo while
  it holds a file open. `.gitignore` keeps them out of git; leave them alone.
- A demo file pins a package by the SHA-256 of its exact archive. Rebuild the
  package and the pin no longer matches: install the new archive and allow the
  view again, or the file reports the package as changed. The archives are built
  by `tools/Build-NendoWorkDependenciesPackage.ps1` and
  `tools/Build-NendoGraphPackage.ps1` into `artifacts/extensions/`.

## What is in git, and what is not

The planner is **git-ignored**. It changes on every write, and a `.nendo` is a
SQLite database that git would store whole each time — about 5 MB a version. It
is the owner's live data: it lives here so it is beside the files it belongs with
and out of the sweepable `artifacts/`, and it is the owner who keeps copies of it.
`git clean -xdf` would delete it along with every other ignored file, so do not
run one here without looking.

The demo files are tracked. They change only when somebody rebuilds them, they
are small, and they are worth still having after a sweep.

`tools/Test-BinaryAssets.ps1` opens every tracked file in this directory and checks the
SQLite header, that the length is a whole number of pages, and that the file
declares Nendo's own application id. Truncating one by 100 bytes fails it with
`is 139164 bytes, which is not a whole number of 4096-byte pages`, and clearing a
byte of the application id fails it with `declares application id 0x00454E44, not
Nendo's 0x4E454E44`. That is a structural check, not a checksum: SQLite carries
none over the database file, so a flipped byte inside a page is not caught here.
