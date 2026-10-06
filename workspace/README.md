# Workspace

The real `.nendo` files this project works in, out of the sweepable `artifacts/`.
The demo files are tracked; the live planner is the owner's data and is ignored.

| File | What it is | In git |
| --- | --- | --- |
| `Planner.nendo` | The live [Nendo Development planner](../docs/dogfooding.md) since 2026-09-29: work items, findings, checks, decisions and initiatives. Real work, not a fixture. [Designed](../docs/design/planner.md) and built by `tools/Build-Planner.mjs`. | **No** — ignored |
| `Nendo Station.nendo` | [Nendo Station](../docs/nendo-station.md), the fourth reference application: a fictional habitat run as an operations room, with the [Systems Lens](../extensions/systems-lens/README.md) schematic. Rebuilt by `tools/Build-NendoStation.mjs` rather than edited. | Yes |
| `BCM.nendo` | Capability Atlas: a business capability model of the fictional Northstar organisation, 635 capabilities with applications and initiatives, and the [Capability Atlas package](../extensions/bcm-atlas/README.md) in the file. | Yes |
| `Archi.nendo` | An ArchiMate 3.2 model with the [Archi workbench](../extensions/archi/README.md) in the file. Built by `tools/Build-Archi.mjs`. | Yes |
| `Swarm.nendo` | The [Swarm](../extensions/swarm/README.md) behaviour playground: creature behaviours edited with bpmn-js, a habitat, and experiments that replay. Built by `tools/Build-Swarm.mjs`. | Yes |

## Rules

- **Never** delete, overwrite, reset or use one of these as a failure fixture.
- `.nendo` storage is never edited directly by an agent. Write through the host:
  the Nendo application, or the `nendo` MCP server against the file it has open.
- Host-owned sidecars (`-wal`, `-shm`, journal, write-owner) belong to Nendo while
  it holds a file open. `.gitignore` keeps them out of git; leave them alone.

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

A file that is open in Nendo cannot be read at all, and the lane says so rather than
calling it corrupt: `workspace/BCM.nendo is open in Nendo (BCM.nendo.write-owner is
beside it). Close it, or open another file in Nendo, and run again.` The gate still
fails, because a file nobody could check is not a pass.
