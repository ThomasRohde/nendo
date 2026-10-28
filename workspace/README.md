# Workspace

The real `.nendo` files this project works in, out of the sweepable `artifacts/`.
The demo files are tracked; the live planner is the owner's data and is ignored. The apps'
demo files, such as Archi, Capability Atlas, Garden, Deck and Manuscript, are in `nendo-apps`
beside this repository ([ADR-0040](../docs/decisions/0040-apps-live-in-their-own-repository.md)).

| File | What it is | In git |
| --- | --- | --- |
| `Planner.nendo` | The live [Nendo Development planner](../docs/dogfooding.md): work items, findings, checks, decisions and initiatives. Real work, not a fixture. [Designed](../docs/design/planner.md) and built by `tools/Build-Planner.mjs`. | **No** — ignored |
| `Nendo Station.nendo` | [Nendo Station](../docs/nendo-station.md), the fourth reference application: a fictional habitat run as an operations room, with the [Systems Lens](../extensions/systems-lens/README.md) schematic. Rebuilt by `tools/Build-NendoStation.mjs` rather than edited. | Yes |
| `Swarm.nendo` | The [Swarm](../extensions/swarm/README.md) behaviour playground: creature behaviours edited with bpmn-js, a habitat, and experiments that replay. Built by `tools/Build-Swarm.mjs`. | Yes |
| `Herbarium.nendo` | The pictures reference file ([ADR-0031](../docs/decisions/0031-media-in-user-data.md)): seven plants whose pictures come from all three places, four stored in the file, two linked from the `Herbarium pictures` folder beside it, and one from the web, with a gallery whose cards are covered by them and a Markdown note that shows a picture. Built by `tools/Build-Herbarium.ps1`. | Yes, with its folder |

## Rules

- **Never** delete, overwrite, reset or use one of these as a failure fixture.
- `.nendo` storage is never edited directly by an agent. Write through the host:
  the Nendo application, or the `nendo` MCP server against the file it has open.
- Host-owned sidecars (`-wal`, `-shm`, journal, write-owner) belong to Nendo while
  it holds a file open. `.gitignore` keeps them out of git; leave them alone.

## What is in git, and what is not

The planner is **git-ignored**. It changes on every write, and git would store the whole
SQLite database each time. It is the owner's live data, kept here beside the files it
belongs with and out of `artifacts/`, and the owner keeps copies of it. `git clean -xdf` would delete them with every other ignored file, so do
not run one here without looking.

The demo files are tracked. They change only when somebody rebuilds them, and they are
worth still having after a sweep.

`tools/Test-BinaryAssets.ps1` opens every tracked file here and checks the SQLite
header, that the length is a whole number of pages, and that the file declares Nendo's
application id (`0x4E454E44`). That is a structural check, not a checksum: SQLite
carries none over the database file, so a flipped byte inside a page is not caught.

A file that is open in Nendo cannot be read, and the lane names it as open rather than
corrupt, for example: `workspace/Swarm.nendo is open in Nendo (Swarm.nendo.write-owner is
beside it). Close it, or open another file in Nendo, and run again.` The gate still
fails, because a file nobody could check is not a pass.
