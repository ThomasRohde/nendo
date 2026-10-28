# ADR-0040: Apps live in their own repository

- **Status:** Accepted
- **Date:** 2026-10-28
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** `tools/Test-Production.ps1` and its `-WithApps` switch; `Test-Apps.ps1` in `nendo-apps`
- **Depends on:** ADR-0013, ADR-0017, ADR-0022

## Context

Nendo's view packages, their builders, their lanes and their demo files lived beside the
host. Most of them are apps in their own right, such as Archi, Capability Atlas, Garden,
Deck and Manuscript. They change far more often than the host, and their lanes made up
about a third of the full gate's time.

The host's own tests barely depend on them. The Engine and Desktop suites install
synthetic probe packages. What an app needs from the host is the view contract: the
built view API (`window.nendo`), the fixture broker that frames a package as the
Workbench does, the view kit and the design tokens, the package uploader and the MCP
client its builder uses.

## Decision

### Two repositories

- **`nendo`** holds the host, its contracts and two reference apps that exercise the
  view contract from the host's side: Nendo Station with its Systems Lens view, and
  Swarm. It also keeps the media reference file, Herbarium, and the planner's skill.
- **`nendo-apps`** holds every other app: its package under `extensions/`, its builder
  and tests under `tools/`, its lane, its design notes and its demo files under
  `workspace/`. It keeps the same folder layout as the host, so a path inside an app
  does not change when it moves.

### The apps use the host from a checkout beside them

`nendo-apps` has no copy of the host's tooling. It resolves the host from the
`NENDO_HOST` environment variable, or else from `../nendo`, and uses that checkout's
built view API, fixture broker, view kit, tokens, uploader and MCP client. There is no
versioned view SDK: the contract is whatever the host checkout beside it builds.

### Which gate runs what

- The host's full gate runs the host lanes and the two reference apps' lanes only.
- `Test-Production.ps1 -WithApps` also runs `nendo-apps`'s `tools/Test-Apps.ps1`
  against the host it just built. A change to the view contract (`docs/contracts/custom-views.md`),
  the view kit or the tokens runs it before it is committed. Otherwise it is run now and
  then, the same way the full gate runs across a series of app-only changes.
- An app-only change in `nendo-apps` needs that app's lane, with every new guard
  falsified. It never needs the host's gate or a new installer: the app reaches a file as
  a proposal.

## Consequences

### Positive

- The full gate no longer waits on the apps' lanes.
- An app's history, lanes and demo files sit together, away from the host's.
- The host's tests name no app but its two reference apps, so moving or deleting an app
  cannot break the host gate.

### Negative

- A contract change can break an app nobody has run since. `-WithApps` finds it, but only
  when it runs.
- `nendo-apps` works only beside a host checkout that has built its Workbench.
- A host document that teaches a view by example uses the reference apps, or links to
  `nendo-apps`.

## Rejected alternatives

- A versioned view SDK that the host publishes and the apps pin: it adds a release step
  to every contract change, while one person works both repositories.
- Keeping every app's lane in the host gate: the gate's time goes on apps the host does
  not depend on.

## Revisit triggers

- Somebody outside this project writes an app, or the apps need an older host: publish a
  versioned view SDK.
- A contract break reaches an app and goes unnoticed for longer than a release.
