# Nendo Molded Workbench mockups

- **Direction:** A — Molded Workbench
- **Status:** Exploratory product mockups; not implementation evidence and not a containing-UI architecture decision
- **Generated:** 2026-09-01
- **Generator:** Codex built-in image generation
- **Brand reference:** [`../../brand/nendo.png`](../../brand/nendo.png)

These images explore all material MVP interface areas described by the current product brief, Studio requirements and Idea Garden journey. They preserve a permanent host-owned Studio route and avoid selecting WinUI, WebView2, React, AG Grid or another production UI stack.

## Visual contract

Molded Workbench is a calm Windows desktop workspace with warm-white light surfaces, deep blue-black dark surfaces, navy text, cobalt focus, restrained violet accents and subtly sculpted rounded panels. The tactile treatment is intentionally quiet: it should make controls approachable without turning records into toys or obscuring dense work.

The supplied Nendo mark is the only logo. It remains small, recognizable and anchored in the upper-left application identity area.

## Theme contract

Nendo offers three device preferences:

- **System** follows the current Windows light/dark setting and is the recommended default.
- **Light** is an explicit warm-white override.
- **Dark** is an explicit deep-navy override.

The selected theme reaches the app frame, Studio, custom surfaces, dialogs, title bar and safe mode. It is saved for the device rather than inside an individual `.nendo` file. Light and dark must preserve hierarchy, focus, validation, conflict and status meaning; neither theme is a separate layout.

## Screen inventory and prompt intent

| File | Theme | Final prompt intent |
| --- | --- | --- |
| `00-idea-garden-board-light.png` | Light | Selected A direction: Idea Garden board grouped by Idea, Exploring, Trying, Paused and Done; permanent Studio route; selected-record inspector and Move to Trying command. |
| `01-idea-garden-board-dark.png` | Dark | Theme-parity rendering of the same board hierarchy and interaction in deep navy, with accessible borders and identical information architecture. |
| `02-empty-studio-light.png` | Light | A valid empty `Untitled.nendo` file with Create entity, Import CSV, Attach agent and Inspect file; no implicit sample schema or data. |
| `03-data-table-dark.png` | Dark | Typed Studio table, choice editing, inline not-blank validation, committed record version, block-loading state and record inspector. |
| `04-structure-light.png` | Light | Idea entity fields, semantic types, stable ID, validation, physical mapping and host-owned Preview change flow without raw SQL. |
| `05-surfaces-light.png` | Light | Generated and custom surface inventory, validation status, stable IDs, disable/restore affordances and an explicit Studio recovery guarantee. |
| `06-idea-form-dark.png` | Dark | Focused semantic Idea form, record navigation, validation, version badge, recent changes and declarative Move to Trying command. |
| `07-import-csv-light.png` | Light | Host-owned CSV field mapping, fixture preview, validation summary and atomic-write guarantee; no chat upload or exposed path. |
| `08-proposal-review-light.png` | Light | Previewable semantic proposal with active file unchanged, typed operations, reversibility, definition revision impact, conflict rules and host-owned apply action. |
| `09-history-dark.png` | Dark | Separate definition/data lineages, attributable revisions, declared reversibility and compensation that creates history rather than erasing it. |
| `10-agent-access-dark.png` | Dark | Disabled, read-only, data mutation and application authoring modes; bounded local lease, revocation and no raw credential display. |
| `11-health-safe-mode-light.png` | Light | Restricted safe mode with intact data, disabled custom board, diagnostics, restore, fallback data access, export, backup and sync-root warning. |
| `12-appearance-system-light.png` | Light | System, Light and Dark device preferences with live previews and an explicit whole-app theme scope. |

## Shared generation constraints

Every prompt used the `ui-mockup` taxonomy and requested a high-fidelity, straight-on 16:10 Windows desktop screenshot. The shared constraints were:

- preserve the supplied Nendo logo and exact `nendo` wordmark;
- keep Use and permanent Studio navigation visible where the workflow permits;
- use the current Idea Garden fixture language and core semantic operations;
- avoid raw SQL, filesystem paths, arbitrary code, opaque document diffs and chat-first interaction;
- avoid browser chrome, macOS controls, watermarks, decorative blobs, heavy gradients and excessive glass effects;
- present credible accessible focus, validation, conflict, loading, recovery and offline states.

Image-generation text is illustrative product copy, not a frozen implementation contract. Repository design documents and Accepted ADRs remain authoritative.
