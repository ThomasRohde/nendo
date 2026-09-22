# ADR-0015: Select the host-owned Studio and database-grid substrate

- **Status:** Accepted
- **Date:** 2026-09-02
- **Owners:** Nendo maintainers
- **Confidence:** Medium
- **Evidence:** EX-0002, EX-0003, DS1 and DS2 are complete; the human native/WebView focus rerun passed; the owner explicitly deferred actual 200% Windows scale to post-selection, pre-release hardening
- **Depends on:** Accepted ADR-0002 containing desktop architecture; semantic-renderer experiment
- **Related design:** [`../contracts/studio.md`](../contracts/studio.md)

## Context

Every Nendo database requires a permanent human interface for data, structure, surfaces, history and health. A new file is intentionally empty. Custom surfaces or agents cannot be prerequisites for access to user data.

A mature open-source grid can save the exploration budget that a rebuild of virtualisation, editing, keyboard interaction, selection, filtering and accessibility foundations would use. AG Grid Community is a credible candidate. However, when the provisional desktop host is WinUI, the selection of AG Grid Community also tends to select WebView2, React/TypeScript and a second UI/runtime supply chain.

The earlier version of this ADR marked that hybrid architecture Accepted before any prototype, and before the containing desktop architecture was decided. That status contradicted the evidence-led ADR process of Nendo. Thus the choice went back to Proposed while EX-0002, EX-0003, DS1 and DS2 produced executable evidence. This revision accepts the choice only after that evidence and the explicit owner disposition below.

## Decision drivers

1. Excellent typed inline editing and keyboard interaction.
2. Large-table virtualisation or bounded block loading.
3. Extensible cell renderers/editors for Nendo semantics.
4. Accessibility and deterministic automation evidence.
5. Permissive redistribution licence and offline packaging.
6. No database, SQL, path, network or generic host authority in the grid.
7. A coherent single-product UI architecture, and not an accidental second product.
8. Sustainable cost for one primary maintainer with help from coding agents.
9. A replaceable adapter boundary, so that vendor configuration does not become the `.nendo` format.
10. Safe fallback when the primary renderer fails.

## Decision

Nendo Studio is permanent host functionality. Its Data surface should use a well-known, permissively licensed open-source grid. It should not use a custom grid built from primitives.

**AG Grid Community is selected behind a Nendo-owned adapter** in the one local web workbench that ADR-0002 selected:

- only Community packages and modules may be used;
- no `ag-grid-enterprise`, licence key, Enterprise-only feature or runtime CDN is permitted;
- AG Grid configuration is transient adapter state; it is not the canonical Nendo schema or saved-view format;
- all writes stay host-authoritative typed service calls;
- each Community feature gap is either implemented as bounded Nendo behaviour or excluded explicitly.

This component choice depends on the Accepted ADR-0002 containing UI architecture. It does not weaken the host-authority boundary of ADR-0002.

## Containing alternatives to test

### A. WinUI shell with WebView2/React/AG Grid island

Advantages:

- native Windows shell and operating-system integration;
- access to the mature table mechanics of AG Grid Community;
- browser process isolation for the table renderer.

Costs:

- two UI stacks, editor implementations, theming systems and automation/accessibility rigs;
- WinUI/WebView2 focus, clipboard, scaling and lifecycle seams;
- NuGet and Node supply chains;
- risk that the web Studio uses capacity while the semantic renderer stays unproved.

### B. .NET kernel with one web UI in a thin desktop shell

Advantages:

- one UI stack for Studio and semantic surfaces;
- direct reuse of table, form, board, theming and automation infrastructure;
- removes much of the hybrid duplication.

Costs:

- weaker native-control/UIA support;
- requires an intentional local application shell/security design;
- can reduce the intended native Windows feel.

### C. Single native/cross-platform UI stack with an appropriate grid

Advantages:

- one component model and accessibility path;
- possible later cross-platform reuse;
- no browser island.

Costs:

- grid maturity and Notion-like interaction quality can be lower;
- more table mechanics can need custom implementation;
- current Windows integration must be demonstrated; it cannot be assumed.

## Recorded evidence

EX-0002
completed on 2026-09-01. A strict host-neutral semantic plan rendered the Idea
Garden form and five-group board in a disposable dependency-free browser
harness. The definition contained no arbitrary renderer properties. This
satisfies acceptance gate 1. It reduces the risk that Studio/grid work starts
before the semantic hypothesis is tested. It does not select a containing
architecture, qualify AG Grid, or satisfy gates 2–8.

EX-0003
completed on 2026-09-01 and selected one local web workbench in a thin WinUI
host. This satisfies acceptance gate 2. It records duplicate capability,
typed-bridge and renderer-recovery evidence. It did not run a production grid,
large-row cases or DS2 accessibility/lifecycle qualification.

DS1
completed on 2026-09-02. AG Grid Community 36.1.0 and Tabulator 6.5.2 both
passed the closed-service, six-editor, bounded 100/10,000/100,000-row,
mutation, recovery, offline and commercial-boundary gates. AG Grid scored 96
and Tabulator scored 86. DS1 recommends AG Grid for DS2. The result satisfies
gates 3 and 5–8. It does not supply the DS2 evidence for Windows focus,
Narrator/UIA, high contrast, 200% scaling or packaged lifecycle.

DS2
completed on 2026-09-02 with a **revise** recommendation. AG Grid Community in
the thin WinUI/WebView2 host passed these checks: browser keyboard use, the real
Windows UIA provider, stable semantic automation, real high contrast,
theme/reduced-motion, Community-only package inventory and installed
crash/restart/reinstall/uninstall lifecycle. A bounded correction removed unsafe
desktop input automation and fixed grid and host focus routing. It passed the
human forward/reverse seam against both the self-contained payload and an
isolated NSIS-installed copy. The real display/text scale of the run was
150%/100%. The required scale is 200%. At that point, DS2 was not an
architecture acceptance or a human usability result. The owner disposition below
accepted the architecture.

## Evidence disposition

The gates that discriminate the decision have the following disposition:

1. **Passed by EX-0002.** The semantic renderer and definition compiler rendered the Idea Garden form and board from stored semantics.
2. **Passed by EX-0003 and ADR-0002.** One local web workbench in a thin WinUI host is the containing architecture.
3. **Passed by DS1.** The functional table journey and the 100/10,000/100,000-row cases passed for the recommended candidate.
4. **Partially passed by DS2; scale explicitly deferred.** The accessibility provider,
   automation, real high contrast, offline packaging, renderer lifecycle,
   human native/WebView focus and installed keyboard smoke passed. Real 200%
   Windows scale has no recorded result. It stays as the post-selection,
   pre-release obligation below.
5. **Passed by EX-0003 and DS1.** The results quantify duplicate/editor code, theme/automation boundaries and supply-chain cost.
6. **Passed by DS1.** The lockfile, dependency, import and built-asset audit contains no commercial module or licence key.
7. **Passed by DS1.** The typed host/component contract tests validation, optimistic concurrency, idempotency and stale versions.
8. **Passed by EX-0003 and DS1.** For both candidates, the native fallback stayed usable after a real WebView renderer crash.

Record evidence under `docs/experiments/results/` with exact versions, commands, measurements and limitations.

Note (2026-09-22): `docs/experiments/` is no longer in the repository. This ADR
is now the only record of the EX-0002, EX-0003, DS1 and DS2 results.

## Owner decision and deferred obligation

On 2026-09-02, repository owner Thomas Klok Rohde explicitly directed: “Skip
the 200% scale test. I will do this in post.” This is an owner risk disposition.
It is not test evidence and it is not a pass. DS2 stays **revise**.

ADR-0015 is Accepted at Medium confidence. The reason is that EX-0002, EX-0003,
DS1 and DS2 now provide the evidence necessary to discriminate the semantic,
containing, grid, service-boundary, accessibility-provider, focus, packaging,
lifecycle and replacement choices. AG Grid stays replaceable behind the
Nendo-owned adapter. The remaining real 200% check is now post-selection
hardening. It must be completed before release qualification.

At real 200% Windows text or display scale, check the host, grid, editor,
inspector, dialogs, native recovery route, focus visibility and required text in
both relevant themes. Browser/device-scale stress is supporting evidence only.
A material accessibility, clipping, focus or recovery failure reopens this ADR
and ADR-0002. This acceptance record must not waive such a failure.

## Consequences

### Positive

- Nendo gets strong table mechanics without a grid built from the start.
- Nendo can focus on semantic operations, agent authoring, revision history and recovery.
- The component is replaceable behind a Nendo-owned adapter.
- Community-only use can stay redistributable without a commercial runtime licence.

### Negative

- A hybrid WinUI/WebView2 choice would approximately double several UI concerns and add a Node supply chain.
- Some spreadsheet-like features are Enterprise-only. Nendo must exclude them or implement them independently.
- AG Grid upgrades require adapter, visual, accessibility and automation regression tests.
- Renderer crash and safe-mode fallback stay Nendo responsibilities.

## Rejected actions

- Promoting the disposable DS1/DS2 implementation into production before the production structure is selected and authorised, and before these boundaries are kept.
- Persisting raw AG Grid configuration as the application or saved-view model.
- Treating vendor documentation as proof of cross-boundary accessibility or automation.
- Importing Enterprise packages for evaluation and letting them stay as transitive dependencies.
- Moving forms or other semantic surfaces into a web island without an ADR.

## Revisit triggers

- DS1 or DS2 fails materially;
- real 200% post-selection qualification finds a material scaling or accessibility failure;
- the semantic renderer points strongly to one containing UI stack;
- a dedicated native grid meets the experience target at substantially lower system cost;
- AG Grid licensing or Community feature boundaries change;
- WebView2, WinUI or the selected shell changes support or deployment assumptions.
