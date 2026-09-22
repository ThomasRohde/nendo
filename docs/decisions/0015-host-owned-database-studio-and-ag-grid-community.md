# ADR-0015: Select the host-owned Studio and database-grid substrate

- **Status:** Accepted
- **Date:** 2026-09-02
- **Owners:** Nendo maintainers
- **Confidence:** Medium
- **Evidence:** EX-0002, EX-0003, DS1 and DS2 are complete; the human native/WebView focus rerun passed; the owner explicitly deferred actual 200% Windows scale to post-selection, pre-release hardening
- **Depends on:** Accepted ADR-0002 containing desktop architecture; semantic-renderer experiment
- **Related design:** [`../contracts/studio.md`](../contracts/studio.md)

## Context

Every Nendo database requires a permanent human interface for data, structure, surfaces, history and health. A new file is intentionally empty, and custom surfaces or agents cannot be prerequisites for reaching user data.

A mature open-source grid can avoid spending the exploration budget rebuilding virtualisation, editing, keyboard interaction, selection, filtering and accessibility foundations. AG Grid Community is a credible candidate. However, selecting it also tends to select WebView2, React/TypeScript and a second UI/runtime supply chain when the provisional desktop host is WinUI.

The earlier version of this ADR marked that hybrid architecture Accepted before any prototype and before the containing desktop architecture had been decided. That status contradicted Nendo's evidence-led ADR process, so the choice returned to Proposed while EX-0002, EX-0003, DS1 and DS2 produced executable evidence. This revision accepts the choice only after that evidence and the explicit owner disposition below.

## Decision drivers

1. Excellent typed inline editing and keyboard interaction.
2. Large-table virtualisation or bounded block loading.
3. Extensible cell renderers/editors for Nendo semantics.
4. Accessibility and deterministic automation evidence.
5. Permissive redistribution licence and offline packaging.
6. No database, SQL, path, network or generic host authority in the grid.
7. A coherent single-product UI architecture rather than an accidental second product.
8. Sustainable cost for one primary maintainer assisted by coding agents.
9. Replaceable adapter boundary so vendor configuration does not become the `.nendo` format.
10. Safe fallback when the primary renderer fails.

## Decision

Nendo Studio is permanent host functionality. Its Data surface should use a renowned permissively licensed open-source grid rather than a bespoke grid built from primitives.

**AG Grid Community is selected behind a Nendo-owned adapter** in the one local web workbench selected by ADR-0002:

- only Community packages and modules may be used;
- no `ag-grid-enterprise`, licence key, Enterprise-only feature or runtime CDN is permitted;
- AG Grid configuration is transient adapter state, not the canonical Nendo schema or saved-view format;
- all writes remain host-authoritative typed service calls;
- Community feature gaps are either implemented as bounded Nendo behaviour or excluded explicitly.

This component choice depends on the Accepted ADR-0002 containing UI architecture and does not weaken its host-authority boundary.

## Containing alternatives to test

### A. WinUI shell with WebView2/React/AG Grid island

Advantages:

- native Windows shell and operating-system integration;
- access to AG Grid Community's mature table mechanics;
- browser process isolation for the table renderer.

Costs:

- two UI stacks, editor implementations, theming systems and automation/accessibility rigs;
- WinUI/WebView2 focus, clipboard, scaling and lifecycle seams;
- NuGet and Node supply chains;
- risk that the web Studio consumes capacity while the semantic renderer remains unproved.

### B. .NET kernel with one web UI in a thin desktop shell

Advantages:

- one UI stack for Studio and semantic surfaces;
- direct reuse of table, form, board, theming and automation infrastructure;
- removes much of the hybrid duplication.

Costs:

- weaker native-control/UIA story;
- requires a deliberate local application shell/security design;
- may reduce the intended native Windows feel.

### C. Single native/cross-platform UI stack with an appropriate grid

Advantages:

- one component model and accessibility path;
- potential later cross-platform reuse;
- no browser island.

Costs:

- grid maturity and Notion-like interaction quality may be lower;
- more table mechanics may need custom implementation;
- current Windows integration must be demonstrated rather than assumed.

## Recorded evidence

EX-0002
completed on 2026-09-01. A strict host-neutral semantic plan rendered the Idea
Garden form and five-group board in a disposable dependency-free browser
harness without arbitrary renderer properties in the definition. This
satisfies acceptance gate 1 and reduces the risk that Studio/grid work begins
before the semantic hypothesis is tested. It does not select a containing
architecture, qualify AG Grid, or satisfy gates 2–8.

EX-0003
completed on 2026-09-01 and selected one local web workbench in a thin WinUI
host. This satisfies acceptance gate 2 and records duplicate capability,
typed-bridge and renderer-recovery evidence. It did not run a production grid,
large-row cases or DS2 accessibility/lifecycle qualification.

DS1
completed on 2026-09-02. AG Grid Community 36.1.0 and Tabulator 6.5.2 both
passed the closed-service, six-editor, bounded 100/10,000/100,000-row,
mutation, recovery, offline and commercial-boundary gates. AG Grid scored 96
against Tabulator's 86 and is recommended for DS2. The result satisfies gates
3 and 5–8 but does not supply DS2's Windows focus, Narrator/UIA, high-contrast,
200% scaling or packaged-lifecycle evidence.

DS2
completed on 2026-09-02 with a **revise** recommendation. AG Grid Community in
the thin WinUI/WebView2 host passed browser keyboard use, the real Windows UIA
provider, stable semantic automation, actual high contrast, theme/reduced-motion,
Community-only package inventory and installed crash/restart/reinstall/uninstall
lifecycle. A bounded correction removed unsafe desktop input automation, fixed
grid and host focus routing, and passed the human forward/reverse seam against
both the self-contained payload and isolated NSIS-installed copy. The actual
display/text scale remains 150%/100%, not the required 200%. This is not yet an
architecture acceptance or human usability result.

## Evidence disposition

The decision-discriminating gates have the following disposition:

1. **Passed by EX-0002.** The semantic renderer and definition compiler rendered the Idea Garden form and board from stored semantics.
2. **Passed by EX-0003 and ADR-0002.** One local web workbench in a thin WinUI host is the containing architecture.
3. **Passed by DS1.** The functional table journey and 100/10,000/100,000-row cases passed for the recommended candidate.
4. **Partially passed by DS2; scale explicitly deferred.** Accessibility provider,
   automation, actual high contrast, offline packaging, renderer lifecycle,
   human native/WebView focus and installed keyboard smoke passed. Actual 200%
   Windows scale remains unverified and is retained as the post-selection,
   pre-release obligation below.
5. **Passed by EX-0003 and DS1.** The results quantify duplicate/editor code, theme/automation boundaries and supply-chain cost.
6. **Passed by DS1.** The lockfile, dependency, import and built-asset audit contains no commercial module or licence key.
7. **Passed by DS1.** The host/component typed contract tests validation, optimistic concurrency, idempotency and stale versions.
8. **Passed by EX-0003 and DS1.** The native fallback remained usable after a real WebView renderer crash for both candidates.

Evidence must be recorded under `docs/experiments/results/` with exact versions, commands, measurements and limitations.

## Owner decision and deferred obligation

On 2026-09-02 repository owner Thomas Klok Rohde explicitly directed: “Skip
the 200% scale test. I will do this in post.” This is an owner risk disposition,
not test evidence and not a pass. DS2 remains **revise**.

ADR-0015 is Accepted at Medium confidence because EX-0002, EX-0003, DS1 and
DS2 now provide the evidence needed to discriminate the semantic, containing,
grid, service-boundary, accessibility-provider, focus, packaging, lifecycle and
replacement choices. AG Grid remains replaceable behind the Nendo-owned
adapter. The remaining actual 200% check is reclassified as post-selection
hardening and must be completed before release qualification.

At actual 200% Windows text or display scale, verify the host, grid, editor,
inspector, dialogs, native recovery route, focus visibility and required text in
both relevant themes. Browser/device-scale stress is supporting evidence only.
A material accessibility, clipping, focus or recovery failure reopens this ADR
and ADR-0002; it must not be waived by this acceptance record.

## Consequences

### Positive

- Strong table mechanics arrive without building a grid from scratch.
- Nendo can focus on semantic operations, agent authoring, revision history and recovery.
- The component is replaceable behind a Nendo-owned adapter.
- Community-only use can remain redistributable without a commercial runtime licence.

### Negative

- A hybrid WinUI/WebView2 choice would roughly double several UI concerns and add a Node supply chain.
- Some spreadsheet-like features are Enterprise-only and must be excluded or independently implemented.
- AG Grid upgrades require adapter, visual, accessibility and automation regression testing.
- Renderer crash and safe-mode fallback remain Nendo responsibilities.

## Rejected actions

- Promoting the disposable DS1/DS2 implementation into production without first selecting and authorising the production structure and preserving these boundaries.
- Persisting raw AG Grid configuration as the application or saved-view model.
- Treating vendor documentation as proof of cross-boundary accessibility or automation.
- Importing Enterprise packages for evaluation and allowing them to remain transitively.
- Moving forms or other semantic surfaces into a web island by momentum rather than ADR.

## Revisit triggers

- DS1 or DS2 fails materially;
- actual 200% post-selection qualification finds a material scaling or accessibility failure;
- the semantic renderer points strongly to one containing UI stack;
- a dedicated native grid meets the experience target at substantially lower system cost;
- AG Grid licensing or Community feature boundaries change;
- WebView2, WinUI or the selected shell changes support or deployment assumptions.
