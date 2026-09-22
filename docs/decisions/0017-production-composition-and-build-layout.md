# ADR-0017: Compose production from Engine, Desktop and Workbench

- **Status:** Accepted
- **Date:** 2026-09-02
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** [ADR-0002](0002-containing-desktop-architecture-and-process-model.md), [ADR-0015](0015-host-owned-database-studio-and-ag-grid-community.md), EX-0001 result, EX-0002 result, EX-0003 result, DS1 result, DS2 result and repository build-layout inspection on 2026-09-02
- **Depends on:** Accepted ADRs 0001–0012 and 0015; ADRs 0008, 0013 and 0014 remain Deferred
- **Related design:** [`../architecture.md`](../architecture.md)

## Context

The experiments intentionally isolated candidate code under `prototypes/` and
did not select a production source tree. The Accepted ADRs now define the data,
authority, UI, lifecycle, MCP and recovery boundaries. Production needs the
smallest project composition that enforces those boundaries without turning
each namespace into a project or referencing disposable prototypes.

The existing prototypes repeat nullable/warning settings and package versions,
and the repository has no root solution, `global.json`, shared MSBuild files or
central package management.

## Decision drivers

1. One headless authority usable by Desktop, tests and the later MCP adapter.
2. SQL/SQLite confinement without a speculative provider abstraction.
3. One normal web UI plus a bounded native recovery surface.
4. Replaceable workbench adapters and no renderer state in the file format.
5. Few projects, explicit dependency direction and no prototype references.
6. Reproducible .NET/NuGet/web builds with centralized versions.
7. Add projects only when a production milestone uses them.

## Options considered

### Three initial production components

Create a headless Engine library, WinUI Desktop executable and local web
Workbench. Add a separate LocalMcp adapter only in its milestone.

### Mirror every experiment project

Promote kernel, renderer, lifecycle, MCP host, evidence tools and candidate UI
projects independently. This preserves experimental seams that were not chosen
as production boundaries.

### One monolithic desktop project

Place engine, SQLite, WinUI, WebView bridge, MCP and tests in one executable.
This minimizes projects but makes the headless authority and adapter boundaries
harder to test and enforce.

### Large layered architecture

Create Domain, Application, Ports, Infrastructure, Storage, Host and multiple
adapter assemblies before their need is demonstrated. This introduces the broad
abstraction layer prohibited by repository guidance.

## Decision

### Production layout

The initial production tree is:

```text
Nendo.slnx
global.json
Directory.Build.props
Directory.Packages.props
src/
  Nendo.Engine/
  Nendo.Desktop/
  Nendo.Workbench/
tests/
  Nendo.Engine.Tests/
  Nendo.Desktop.Tests/
```

Projects and test projects are created only when the active milestone uses them.
`src/Nendo.LocalMcp/` and `tests/Nendo.LocalMcp.Tests/` are added in the MCP
milestone rather than as empty scaffolding.

### Responsibilities

- **Nendo.Engine** is a headless .NET library containing typed models,
  canonical operations, revisions, proposals, semantic compilation, application
  services, the write coordinator, file lifecycle and the internal SQLite
  implementation. All SQL and SQLite types remain under its internal `Storage/`
  area. No second provider interface is introduced.
- **Nendo.Desktop** is the WinUI 3 executable. It owns application/window
  lifetime, file pickers/recent files, the native recovery surface, WebView2,
  theme/title-bar integration, the closed typed bridge and start/stop of optional
  local adapters. It contains no SQL.
- **Nendo.Workbench** is the locally bundled TypeScript/Vite application for all
  normal Studio and semantic surfaces. It uses AG Grid Community behind a
  Nendo-owned adapter and talks only through the versioned typed bridge.
- **Nendo.LocalMcp**, when added, is an official-SDK adapter over Engine
  application services. It owns no SQLite or independent authority and is
  started/stopped by Desktop.

The dependency direction is:

```text
Workbench --typed bridge--> Desktop --typed calls--> Engine --internal--> SQLite
                                  |
                                  +--> LocalMcp --typed calls--> Engine
```

Neither production code nor tests reference a prototype project. Proven logic
may be deliberately ported with its focused tests after source review; project
references, namespaces and generated assets are not promoted wholesale.

### Workbench toolchain

- Start with framework-free TypeScript modules and Vite, matching the DS1/DS2
  evidence. Do not add React merely because an archived design mentioned it.
- Use `ag-grid-community` only; no Enterprise package, licence key or CDN.
- Use one committed npm lockfile and local/offline production assets.
- A later component framework is a reversible workbench decision only if
  measured complexity justifies its package and adapter cost; it cannot change
  durable semantic definitions or host authority.

### Shared build infrastructure

- `global.json` pins the qualified .NET SDK feature band with a documented
  roll-forward policy.
- Root `Directory.Build.props` holds shared defaults such as nullable,
  implicit usings, warnings-as-errors and the repository `artifacts/` output
  root. Project-specific target frameworks and WinUI settings stay in projects.
- Root `Directory.Packages.props` enables NuGet Central Package Management and
  pins all production/test package versions. Individual projects omit version
  attributes.
- Do not create `Directory.Build.targets` until a real late-bound/custom target
  exists. In particular, target-framework conditions do not belong in
  `Directory.Build.props`, where the TFM may not yet be available.
- Do not add nested `Directory.Build.props` files until production projects
  actually need distinct shared defaults and explicitly import the parent.
- The root `.slnx` lists production/test .NET projects; web scripts remain in the
  Workbench package and are called by explicit repository verification scripts.

The first scaffold re-inspects installed templates, SDK/workloads and current
package versions before writing files. Versions observed in prototypes are
evidence inputs, not an instruction to copy stale generated projects.

## Evidence and validation obligations

- EX-0003 and ADR-0002 select the thin WinUI host plus one local WebView2
  workbench and native recovery boundary.
- DS1/DS2 and ADR-0015 select AG Grid Community and prove a framework-free
  TypeScript/Vite shell, typed bridge, packaging and Windows focus/provider path.
- EX-0001/2 prove the headless typed kernel/compiler boundary; EX-0004–8 prove
  host application-service/lifecycle concerns without selecting their project
  graph.
- The scaffold must use repository-compatible templates after inspecting the
  installed SDK/workloads and must add/register tests through the vendored .NET
  skills.
- Restore, build, unit/contract tests, web checks, runtime smoke and repository
  verification are required from the first vertical slice.

## Consequences

### Positive

- The source tree mirrors accepted runtime authority rather than experiment
  chronology.
- SQL is confined without building a provider framework for one provider.
- The web and native surfaces remain independently testable and replaceable.
- Package/build settings have one versioned source of truth.

### Negative

- Nendo.Engine initially contains several closely related concerns and must be
  organized by internal namespaces/folders.
- Framework-free TypeScript may need reconsideration if surface complexity grows.
- Desktop integration tests still need real Windows/runtime evidence beyond unit
  tests.

## Rejected alternatives

Experiment mirroring, one monolith and a large pre-emptive layer graph are
rejected because each encodes unchosen structure or weakens testable authority
boundaries. React is not rejected generally; it is not selected without evidence
that it improves the production workbench enough to justify another dependency.

## Revisit triggers

- Nendo.Engine cannot maintain storage confinement or focused test boundaries.
- The MCP adapter requires a separate process for security or lifecycle reasons.
- Workbench complexity demonstrates a measured need for a component framework.
- Cross-platform delivery changes the Desktop/runtime boundary.
- A second persistence provider becomes explicit, funded scope.
