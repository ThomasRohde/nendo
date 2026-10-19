# ADR-0017: Compose production from Engine, Desktop and Workbench

- **Status:** Accepted
- **Date:** 2026-09-02
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** `Nendo.slnx`, `Directory.Build.props`, `Directory.Packages.props`, `global.json` and `src/Nendo.Workbench/scripts/verify-dependencies.mjs`; `tools/Test-Production.ps1` refuses a production or test project that references `prototypes`
- **Depends on:** Accepted ADRs 0001–0007, 0009–0012 and 0015
- **Related design:** [`../architecture.md`](../architecture.md)

## Context

The accepted ADRs define the data, authority, UI, lifecycle, MCP and recovery boundaries.
Production needs the smallest project composition that enforces them, without a project
per namespace and without referencing disposable prototypes.

## Decision

### Production layout

```text
Nendo.slnx
global.json
Directory.Build.props
Directory.Packages.props
src/
  Nendo.Engine/
  Nendo.Desktop/
  Nendo.LocalMcp/
  Nendo.Workbench/
tests/
  Nendo.Engine.Tests/
  Nendo.Desktop.Tests/
  Nendo.LocalMcp.Tests/
```

`Nendo.slnx` lists the six .NET projects. A project is added only when a production
milestone uses it, never as empty scaffolding. `prototypes/` stays outside the solution,
and production code and tests never reference a prototype project; proven logic is ported
deliberately with its focused tests.

### Responsibilities

- **Nendo.Engine** is a headless .NET library: typed models, canonical operations,
  revisions, proposals, semantic compilation, application services, the write
  coordinator, the file lifecycle and the internal SQLite implementation. All SQL and
  SQLite types stay under its internal `Storage/` area. There is no second provider
  interface.
- **Nendo.Desktop** is the WinUI 3 executable: application and window lifetime, file
  pickers and recent files, the native recovery surface, WebView2, theme and title-bar
  integration, the closed typed bridge, and starting and stopping local adapters. It
  contains no SQL.
- **Nendo.Workbench** is the locally bundled TypeScript/Vite application for Studio and
  every semantic surface. It talks only through the versioned typed bridge. Its build also
  writes the view API to `Workbench/_nendo/api.js`, the one installation file custom views
  load ([ADR-0013](0013-custom-views-with-code-in-the-file.md)).
- **Nendo.LocalMcp** is an official-SDK adapter over Engine application services. It owns
  no SQLite and no authority of its own. Desktop starts and stops it.

```text
Workbench --typed bridge--> Desktop --typed calls--> Engine --internal--> SQLite
                                  |
                                  +--> LocalMcp --typed calls--> Engine
```

### Workbench toolchain

- Framework-free TypeScript modules and Vite. No React without measured need.
- Production dependencies are `ag-grid-community` and, for the Markdown field's editor
  alone, `@tiptap/core`, `@tiptap/pm`, `@tiptap/starter-kit`, `@tiptap/markdown`,
  `@tiptap/extension-image`, `@tiptap/extension-table` and `marked`. Each is pinned to one
  version, chosen at least two weeks after its release, with its licence in the notices the
  build writes. `scripts/verify-dependencies.mjs` holds the list and refuses a range, a
  React package or an Enterprise package. No CDN.
- The Markdown editor changes nothing durable. The field stores Markdown, `markdown.ts`
  draws it, and no Tiptap document, HTML or configuration reaches the file (ADR-0004's rule
  for toolkit state). The editor writes Markdown back only when the person changes it; raw
  HTML is read as text, and text is written without HTML entities. It loads only on a page
  with a Markdown field. A change of editor is a Workbench decision under this ADR.
- One committed npm lockfile and local, offline production assets.
- A component framework is a reversible Workbench decision, allowed only when measured
  complexity justifies it. It cannot change durable semantic definitions or host authority.

### Shared build infrastructure

- `global.json` pins the qualified .NET SDK with a documented roll-forward policy.
- The root `Directory.Build.props` holds shared defaults: nullable, implicit usings,
  warnings as errors and the `artifacts/` output root. Target frameworks and WinUI settings
  stay in the projects. No target-framework conditions go in `Directory.Build.props`,
  where the TFM can be unavailable.
- `Directory.Packages.props` enables Central Package Management and pins every production
  and test package version. Projects omit version attributes.
- No `Directory.Build.targets` until a real late-bound target exists, and no nested
  `Directory.Build.props` until projects need distinct defaults that import the parent.
- Web scripts stay in the Workbench package, called by explicit repository verification
  scripts.
- A new project is scaffolded after inspecting the installed SDK, templates, workloads and
  current package versions, and tests are added through the vendored .NET skills
  ([ADR-0016](0016-vendor-pinned-dotnet-agent-skills.md)).

## Consequences

**Positive.** The source tree follows runtime authority. SQL is confined without a provider
framework. The web and native surfaces stay independently testable and replaceable.
Package and build settings have one versioned source.

**Negative.** Nendo.Engine holds several related concerns, organised by internal folders.
Framework-free TypeScript may need reconsidering as surfaces grow. Desktop integration
needs real Windows runtime tests beside unit tests.

## Rejected alternatives

- **Mirror every experiment project.** Keeps seams nobody chose.
- **One monolithic desktop project.** Weakens the testable headless authority and adapter
  boundaries.
- **A large layered architecture** (Domain, Application, Ports, Infrastructure and so on)
  before need. The broad abstraction layer repository guidance prohibits.

## Revisit triggers

- Nendo.Engine cannot keep storage confinement or focused test boundaries.
- The MCP adapter needs a separate process for security or lifecycle reasons.
- Workbench complexity shows a measured need for a component framework.
- Cross-platform delivery changes the Desktop boundary.
- A second persistence provider becomes explicit, funded scope.
