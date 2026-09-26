# Console: the visual direction

- **Status:** Selected by the owner on 2026-09-26 (W-067). It replaces Molded
  Workbench as the visual reference.
- **Source:** six whole-app directions on a design canvas,
  <https://claude.ai/artifact/X83iVHbXjoFDMQVbcnaT8w>. The owner chose C, Console.
  The canvas is private to the owner. This document describes the direction as
  it is built.

This is a product and visual reference, not an architecture authority. Contracts
and accepted ADRs govern behaviour.

## The look in one paragraph

Console is a dense, keyboard-first work tool. It is dark-first, and its light
theme is designed rather than inverted. Surfaces are graphite layers a few steps
apart, separated by 1px hairlines rather than shadows. One violet accent marks
focus, selection and the primary action. Status reads as a dot plus a word.
Rows are about 32px, UI text is 13-14px and corners are 6px (8px for panels).
Ids, counts, versions and key names are set in a mono face.

## Tokens

The colours live in `src/Nendo.Workbench/src/styles/02-tokens.css`. The names
predate Console and stay, because custom views are handed exactly these tokens
(`themeTokenNames` in `extension-model.ts`, and the custom-views contract).
`--cobalt` is the accent, whatever hue it carries.

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--canvas` | `#f3f4f6` | `#0f1115` | Window ground, the work area behind a surface |
| `--surface` | `#ffffff` | `#14171c` | Rail, top bar, toolbars, list rows, status bar |
| `--surface-raised` | `#ffffff` | `#181b21` | Inputs, menus, cards |
| `--surface-soft` | `#f1f2f5` | `#1c2027` | Hover |
| `--ink` / `--muted` | `#14171c` / `#5b6370` | `#e7e9ed` / `#9aa1ad` | Text |
| `--line` / `--line-strong` | `#e2e5ea` / `#cdd2da` | `#262a33` / `#353b47` | Hairlines, control borders |
| `--cobalt` / `--cobalt-soft` | `#6b3fd6` / `#efe9fd` | `#9d6bff` / `#251c3a` | Accent, selected fill |

Text on an accent fill is white in light and `--canvas` in dark. White on the
dark accent does not reach 4.5:1.

Radii are `--radius-control` (6px) and `--radius-panel` (8px), in
`13-refinements-pages.css`, beside `--mono`. The root font size is 14px, and no
text is set below 0.75rem.

The data grid (`nendoGridTheme` in `view-data.ts`) and the WebView2 background
in `src/Nendo.Desktop/MainPage.xaml.cs` repeat these values, because neither can
read a CSS variable. Change them together.

## The shell

- **Rail:** 196px open, with dense 32px items, the Studio group under a mono
  small-caps label, and Help at the foot. Folded, it is a 56px icon rail. The fold
  is kept for the device.
- **Top bar:** 48px. On the left, where you are, as a breadcrumb (`Use · Crew /
  By role`). The page names itself here and nowhere larger. On the right are Back
  and Forward, File, and System / Light / Dark.
- **Work area:** edge to edge on `--canvas`, with no floating card around it. A
  page toolbar is a 46px strip on `--surface`. A list is a table of hairline rows.
- **Status bar:** 26px, mono, with the file name on the left and the agent pill,
  health and version on the right.

## Fonts

The canvas used Geist and Geist Mono. The app uses the Windows faces, Segoe UI
Variable and Cascadia Mono. A bundled web font would be a `.woff2` binary, and
`tools/Test-BinaryAssets.ps1` accepts no such file. The typographic structure is
the same.

## The keyboard

- **Command palette (Ctrl K)**, in `command-palette.ts`. It is a modal dialog that
  lists what the window can do right now: pages, the record types and views of the Use
  screen on show, Create, the File actions, the themes, folding the rail and the hints.
  Each command presses the control it stands for, so it is refused, confirmed or
  announced exactly as the click would be. What is disabled on screen is left out. The
  ranking (`rankCommands` in `shortcuts.ts`) wants the typed letters in order, and
  prefers word starts and runs.
- **Shortcuts**, in the table in `shortcuts.ts`: Ctrl K, Ctrl 1-7 for Use, Data,
  Structure, Surfaces, History, Health and Agent, F1 for Help, Ctrl B to fold the rail,
  Alt F for File, Ctrl / for the hints, and Alt Left/Right for Back and Forward (answered
  in `main.ts`, as before). Every control with a key carries `aria-keyshortcuts`. The keys
  stand aside while a modal is open.
- **Show keyboard shortcuts** (the owner asked for it on 2026-09-26). It is the keyboard
  button in the top bar, or Ctrl /. It is off by default. When it is on, `:root` carries
  `data-shortcuts="shown"`, each rail item shows its key, and the status bar shows a
  reminder. The choice is kept for the device under `nendo.shortcuts`, like the theme and
  the rail. It is never written to the file, and it never reaches the host.
- **Help** has a *Keyboard shortcuts* topic under Getting started, built from the same
  table, so the two cannot disagree.

## Split pane

The mockup's record pane beside the list is the existing record inspector
(`.use-layout.has-inspector`), restyled with the rest.
