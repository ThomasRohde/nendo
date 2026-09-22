# ADR-0017: Compose production from Engine, Desktop and Workbench

- **Status:** Accepted
- **Date:** 2026-09-02
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** [ADR-0002](0002-containing-desktop-architecture-and-process-model.md), [ADR-0015](0015-host-owned-database-studio-and-ag-grid-community.md), EX-0001 result, EX-0002 result, EX-0003 result, DS1 result, DS2 result and repository build-layout inspection on 2026-09-02
- **Depends on:** Accepted ADRs 0001–0007, 0009–0012 and 0015. ADRs 0008, 0013 and 0014 were Deferred on 2026-09-02. Since then, ADR-0014 was accepted on 2026-09-10, ADR-0008 on 2026-09-12 and ADR-0013 for a bounded custom-view slice on 2026-09-20
- **Related design:** [`../architecture.md`](../architecture.md)

## Context

The experiments intentionally isolated candidate code under `prototypes/`. They
did not select a production source tree. The Accepted ADRs now define the data,
authority, UI, lifecycle, MCP and recovery boundaries. Production needs the
smallest project composition that enforces those boundaries. This composition
must not turn each namespace into a project, and it must not reference
disposable prototypes.

The existing prototypes repeat nullable/warning settings and package versions.
The repository has no root solution, no `global.json`, no shared MSBuild files
and no central package management.

## Decision drivers

1. One headless authority that Desktop, tests and the later MCP adapter can use.
2. SQL/SQLite confinement without a speculative provider abstraction.
3. One normal web UI plus a bounded native recovery surface.
4. Replaceable workbench adapters and no renderer state in the file format.
5. Few projects, an explicit dependency direction and no prototype references.
6. Reproducible .NET/NuGet/web builds with centralized versions.
7. Add projects only when a production milestone uses them.

## Options considered

### Three initial production components

Create a headless Engine library, a WinUI Desktop executable and a local web
Workbench. Add a separate LocalMcp adapter only in its milestone.

### Mirror every experiment project

Promote the kernel, renderer, lifecycle, MCP host, evidence tools and candidate
UI projects independently. This keeps experimental seams that were not chosen as
production boundaries.

### One monolithic desktop project

Put the engine, SQLite, WinUI, WebView bridge, MCP and tests in one executable.
This minimizes projects. It makes the headless authority and adapter boundaries
harder to test and enforce.

### Large layered architecture

Create Domain, Application, Ports, Infrastructure, Storage, Host and multiple
adapter assemblies before their need is demonstrated. This introduces the broad
abstraction layer that repository guidance prohibits.

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

Create projects and test projects only when the active milestone uses them.
Add `src/Nendo.LocalMcp/` and `tests/Nendo.LocalMcp.Tests/` in the MCP milestone.
Do not add them earlier as empty scaffolding.

### Responsibilities

- **Nendo.Engine** is a headless .NET library. It contains the typed models,
  canonical operations, revisions, proposals, semantic compilation, application
  services, the write coordinator, the file lifecycle and the internal SQLite
  implementation. All SQL and SQLite types stay under its internal `Storage/`
  area. No second provider interface is introduced.
- **Nendo.Desktop** is the WinUI 3 executable. It owns application/window
  lifetime, file pickers/recent files, the native recovery surface, WebView2,
  theme/title-bar integration, the closed typed bridge and the start/stop of
  optional local adapters. It contains no SQL.
- **Nendo.Workbench** is the locally bundled TypeScript/Vite application for all
  normal Studio and semantic surfaces. It uses AG Grid Community behind a
  Nendo-owned adapter. It communicates only through the versioned typed bridge.
- **Nendo.LocalMcp**, when it is added, is an official-SDK adapter over Engine
  application services. It owns no SQLite and no independent authority. Desktop
  starts and stops it.

The dependency direction is:

```text
Workbench --typed bridge--> Desktop --typed calls--> Engine --internal--> SQLite
                                  |
                                  +--> LocalMcp --typed calls--> Engine
```

Production code and tests do not reference a prototype project. After a source
review, proven logic can be ported intentionally together with its focused
tests. Project references, namespaces and generated assets are not promoted as a
whole.

### Workbench toolchain

- Start with framework-free TypeScript modules and Vite, as in the DS1/DS2
  evidence. Do not add React only because an archived design mentioned it.
- Use `ag-grid-community` only. Use no Enterprise package, licence key or CDN.
- Use one committed npm lockfile and local/offline production assets.
- A later component framework is a reversible workbench decision. It is
  permitted only if measured complexity justifies its package and adapter cost.
  It cannot change durable semantic definitions or host authority.

### Shared build infrastructure

- `global.json` pins the qualified .NET SDK feature band with a documented
  roll-forward policy.
- The root `Directory.Build.props` holds shared defaults such as nullable,
  implicit usings, warnings-as-errors and the repository `artifacts/` output
  root. Project-specific target frameworks and WinUI settings stay in the
  projects.
- The root `Directory.Packages.props` enables NuGet Central Package Management
  and pins all production/test package versions. Individual projects omit
  version attributes.
- Do not create `Directory.Build.targets` until a real late-bound/custom target
  exists. In particular, do not put target-framework conditions in
  `Directory.Build.props`, because the TFM can be unavailable there.
- Do not add nested `Directory.Build.props` files until production projects
  need distinct shared defaults and explicitly import the parent.
- The root `.slnx` lists the production/test .NET projects. Web scripts stay in
  the Workbench package. Explicit repository verification scripts call them.

Before the first scaffold writes files, it inspects the installed templates,
SDK/workloads and current package versions again. The versions in the
prototypes are evidence inputs. They are not an instruction to copy stale
generated projects.

## Evidence and validation obligations

- EX-0003 and ADR-0002 select the thin WinUI host plus one local WebView2
  workbench and the native recovery boundary.
- DS1/DS2 and ADR-0015 select AG Grid Community. They prove a framework-free
  TypeScript/Vite shell, the typed bridge, packaging and the Windows
  focus/provider path.
- EX-0001/2 prove the headless typed kernel/compiler boundary. EX-0004–8 prove
  host application-service/lifecycle concerns, but they do not select the
  project graph for them.
- The scaffold must use repository-compatible templates after it inspects the
  installed SDK/workloads. It must add/register tests through the vendored .NET
  skills.
- From the first vertical slice, restore, build, unit/contract tests, web
  checks, runtime smoke and repository verification are required.

## Consequences

### Positive

- The source tree follows the accepted runtime authority. It does not follow the
  order of the experiments.
- SQL is confined without a provider framework for one provider.
- The web and native surfaces stay independently testable and replaceable.
- Package/build settings have one versioned source of truth.

### Negative

- At first, Nendo.Engine contains several closely related concerns. Internal
  namespaces/folders must organize them.
- If surface complexity grows, framework-free TypeScript can need
  reconsideration.
- Desktop integration tests still need real Windows/runtime evidence in addition
  to unit tests.

## Rejected alternatives

Experiment mirroring, one monolith and a large pre-emptive layer graph are
rejected. Each of them encodes a structure that nobody chose, or weakens the
testable authority boundaries. React is not rejected in general. It is not
selected without evidence that it improves the production workbench enough to
justify another dependency.

## Revisit triggers

- Nendo.Engine cannot keep storage confinement or focused test boundaries.
- The MCP adapter requires a separate process for security or lifecycle reasons.
- Workbench complexity demonstrates a measured need for a component framework.
- Cross-platform delivery changes the Desktop/runtime boundary.
- A second persistence provider becomes explicit, funded scope.
