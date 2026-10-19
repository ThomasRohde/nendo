# ADR-0015: Select the host-owned Studio and database-grid substrate

- **Status:** Accepted
- **Date:** 2026-09-02
- **Owners:** Nendo maintainers
- **Confidence:** Medium
- **Evidence:** Grid and host experiments EX-0002, EX-0003, DS1 and DS2 (summarised below); the owner's Windows 200% scaling check is owner-reported, and no lane instruments it
- **Depends on:** Accepted ADR-0002 containing desktop architecture
- **Related design:** [`../contracts/studio.md`](../contracts/studio.md)

## Context

Every Nendo file needs a permanent human interface for data, structure, surfaces, history
and health. A new file is empty, so custom surfaces or agents cannot be a prerequisite for
reaching user data. A mature open-source grid saves rebuilding virtualisation, editing,
keyboard interaction, selection, filtering and accessibility. Inside the WinUI host of
[ADR-0002](0002-containing-desktop-architecture-and-process-model.md), a web grid brings
WebView2, TypeScript and a Node supply chain with it.

## Decision

Studio is permanent host functionality. Its Data surface uses a well-known, permissively
licensed open-source grid, not one built from primitives.

**AG Grid Community is selected behind a Nendo-owned adapter** in the one local web
Workbench that ADR-0002 selected:

- only Community packages and modules are used;
- no `ag-grid-enterprise`, licence key, Enterprise-only feature or runtime CDN;
- AG Grid configuration is transient adapter state, never the Nendo schema or a saved-view
  format;
- every write is a host-authoritative typed service call;
- each Community feature gap is implemented as bounded Nendo behaviour or excluded
  explicitly;
- forms and other semantic surfaces do not move into the grid.

The host-authority boundary of ADR-0002 is unchanged.

### What the experiments established

| Experiment | Result |
| --- | --- |
| EX-0002 | A host-neutral semantic plan rendered a form and a grouped board from stored semantics, with no arbitrary renderer properties |
| EX-0003 | One local web Workbench in a thin WinUI host is the containing architecture; the native fallback survives a real WebView renderer crash |
| DS1 | AG Grid Community 36.1.0 (score 96) and Tabulator 6.5.2 (86) both passed closed-service, six-editor, 100/10,000/100,000-row, mutation, recovery, offline and commercial-boundary checks |
| DS2 | AG Grid in the WinUI/WebView2 host passed keyboard use, the Windows UIA provider, semantic automation, real high contrast, theme and reduced motion, a Community-only package inventory, installed crash/restart/reinstall/uninstall, and the native/WebView focus seam |

The real 200% Windows scale check, which DS2 did not run, was later run by the owner
(owner-reported). A material accessibility, clipping, focus or recovery failure at that
scale reopens this ADR and ADR-0002.

## Consequences

**Positive.** Strong table mechanics without building a grid. Effort goes to semantic
operations, agent authoring, history and recovery. The grid is replaceable behind the
adapter, and Community-only use needs no commercial licence.

**Negative.** Two UI stacks (WinUI and the web Workbench) and a Node supply chain. Some
spreadsheet features are Enterprise-only and are excluded or built independently. A grid
upgrade needs adapter, visual, accessibility and automation regression tests. Renderer
crash and safe-mode fallback stay Nendo's responsibility.

## Rejected alternatives

- **A custom grid built from primitives.** Rebuilds mature table mechanics.
- **A single native or cross-platform UI stack with its own grid.** Lower grid maturity and
  more custom table work.
- **Persisting raw AG Grid configuration** as the application or saved-view model.
- **Enterprise packages**, even for evaluation or as transitive dependencies.
- **Vendor documentation as proof** of cross-boundary accessibility or automation.

## Revisit triggers

- A material scaling or accessibility failure in the Workbench grid.
- A dedicated native grid meets the experience target at substantially lower system cost.
- AG Grid licensing or Community feature boundaries change.
- WebView2, WinUI or the shell changes support or deployment assumptions.
