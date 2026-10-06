# Mica with tabs: the visual direction

- **Status:** Selected by the owner on 2026-10-03. It replaces [Console](console-direction.md)
  as the visual reference.
- **Source:** the design canvas <https://claude.ai/artifact/E2vDLAauruVcEeLV6x1aZC> set out six
  directions for making Nendo look like a native, professional Windows app: A Mica, B Ribbon,
  C Three-pane, D Workspace, E Explorer and F Inspector. The owner asked for A with E's tabs,
  drawn as G. G was built as a trial, tested in the running window, and then adopted. The canvas is
  private to the owner. This document describes the direction as it is built.

This is a product and visual reference, not an architecture authority. Contracts
and accepted ADRs govern behaviour.

## The look in one paragraph

Mica with tabs is a Windows 11 app in WinUI's idiom. The window's ground is Mica, the
host's own backdrop, and it shows through the title band, the navigation and the status line.
The work sits on one layer with a rounded top-left corner, as a NavigationView draws its content.
The places a person keeps open are tabs over that layer, and the active tab is joined to it. The
accent is the Windows blue. Navigation items are 36px, controls are 32px with 4px corners, and
panels and cards have 8px corners. Light is the Fluent neutral greys; dark is designed, not
inverted. Ids, counts, versions and key names stay in a mono face.

## Mica

`MainWindow.xaml` has always set a `MicaBackdrop`; the page painted over it. Now `ShellGrid`
in `MainPage.xaml` is transparent and the WebView2's `DefaultBackgroundColor` has an alpha of 0,
so the backdrop shows wherever the page leaves its ground. The page knows it is in the Desktop host
and sets `data-backdrop="mica"` on `:root`, which makes `html`, `body` and the app shell
transparent. In a browser there is no backdrop, and `--mica` stands in for it: the colour Mica takes
over a neutral wallpaper. `--mica` is not one of the tokens a custom view is handed, because a view
draws on the layer and never on the ground.

The recovery panel keeps its own opaque brush.

## Tokens

The colours live in `src/Nendo.Workbench/src/styles/02-tokens.css`. The names predate both
Console and this direction, and stay, because custom views are handed exactly these tokens
(`themeTokenNames` in `extension-model.ts`, and the custom-views contract). `--cobalt` is the
accent, whatever hue it carries.

| Token | Light | Dark | Role |
| --- | --- | --- | --- |
| `--canvas` | `#f9f9fa` | `#272829` | The layer the work sits on |
| `--surface` | `#ffffff` | `#2d2e30` | Cards, list rows, toolbars, inputs |
| `--surface-raised` | `#ffffff` | `#323335` | Menus, raised cards |
| `--surface-soft` | `#f3f3f4` | `#38393b` | Hover |
| `--ink` / `--muted` | `#1b1b1b` / `#5d5d5d` | `#ffffff` / `#c5c5c5` | Text |
| `--line` / `--line-strong` | `#e5e5e5` / `#d1d1d1` | `#3b3c3e` / `#4b4c4f` | Hairlines, control borders |
| `--cobalt` / `--cobalt-soft` | `#005fb8` / `#e5eff9` | `#60cdff` / `#1f3a4a` | Accent, selected fill |
| `--mica` (ground only) | `#eef1f6` | `#1e2024` | The ground in a browser; transparent in the host |

Text on an accent fill is white in light and `--canvas` in dark, because the dark accent is light.
`21-native.css` applies that to the few places that set white on the accent directly.

Radii are `--radius-control` (4px) and `--radius-panel` (8px), restated in
`21-native.css`. The root font size is 14px, and no text is set below 0.75rem.

The data grid (`nendoGridTheme` in `view-data.ts`) repeats these values, because it cannot read
a CSS variable. Change them together.

## The shell

- **Title band (48px).** It is the window's title bar (W-093). Over the navigation it carries the
  Nendo mark, the file's name and the File menu. Over the layer it carries the tab strip. Windows
  draws Minimise, Maximise and Close at its right end, and the strip keeps their width free
  (`--title-bar-right`). Every part of the band that is not a control moves the window.
- **Navigation (280px).** A NavigationView on the ground: 36px items, a fill and a 3×16px accent
  pill for the selected one. **Use** heads the first section and is still the way to Use (Ctrl 1).
  Under it are the file's front page, its own views and its record types (`rail-places.ts`), and
  choosing one opens Use on it from anywhere. **Studio** heads the second section (it opens Data),
  with Data, Structure, Surfaces, History and Health under it. Agent and Help sit at the foot. A
  file with many record types scrolls its own list, so Studio stays in reach. The hamburger above
  Use folds the navigation to 56px of icons (Ctrl B); the fold is kept for the device.
- **Record type icons.** A record type's icon is guessed from its name (`type-icons.ts`). The
  head noun, which is the last word in English, is looked up in a short table of everyday nouns:
  Crew gets people, Incidents a warning, Readings a gauge. A name that matches nothing gets its
  letters on a tile tinted in one of the choice tones, the same tone for the same name every time.
  The navigation, the tabs and the address row use the same icon. A file cannot yet choose a type's
  icon; that would need it in the file.
- **Tabs.** Each tab is a place kept open (`workspace-tabs.ts`). A tab is a trail. Each one keeps
  its own places and cursor, so Back and Forward belong to the tab, as in File Explorer.
  Switching tabs swaps the saved trail into `navigationTrail` and puts its current place back the
  way a step back does (`revisitCurrent`). A tab that is not on screen costs a list of places and
  nothing else: no frame, no read. Tabs belong to the window, and they are cleared with the file.
  A place carries its Filter pick and Studio's sort and filter, so two tabs on one screen keep
  their own (ADR-0004, 2026-10-06); changing them amends the place on screen, not a new step.
  - **+**, Ctrl T: a new tab on the place on screen.
  - Ctrl W, a tab's close button, a middle click on a tab: close it. The last tab cannot be closed.
  - Ctrl Tab and Ctrl Shift Tab: the next and previous tab. The arrow keys move between tabs, and
    Delete closes the focused one.
  - A Ctrl-click or a middle click on anything in the navigation opens it in a new tab.
  - A tab is named after the place on screen: the record type and the view (*Incidents · Ops
    board*), or Studio and its page. A view named after its type is named once.
- **Address row.** The first row of the layer: Back and Forward (Alt Left and Alt Right), the
  breadcrumb, and the command box (Ctrl K). On a Use screen the breadcrumb carries the record-type
  and view pickers (W-092). The page names itself here and nowhere larger.
- **Status line (28px).** On the ground, in the UI face: the file's icon and name on the left; the
  agent pill, the health pill, the theme (System, Light, Dark), the key hints toggle and the
  version on the right.
- **A narrow window.** Below 841px the navigation is the bar across the top and the title bar, as
  before. Tabs wait for a wider window.

## Fonts

The app uses the Windows faces, Segoe UI Variable and Cascadia Mono. A bundled web font would be a
`.woff2` binary, and `tools/Test-BinaryAssets.ps1` accepts no such file.

## The keyboard

- **Command palette (Ctrl K)**, in `command-palette.ts`. It lists what the window can do right now.
  Each command presses the control it stands for.
- **Shortcuts**, in the table in `shortcuts.ts`: Ctrl K, Ctrl 1-7 for Use, Data, Structure,
  Surfaces, History, Health and Agent, F1 for Help, Ctrl B to fold the navigation, Alt F for File,
  Ctrl / for the hints, Alt Left and Right for Back and Forward, and Ctrl T, Ctrl W and Ctrl Tab for
  the tabs. Ctrl Shift Tab is answered in `workspace-tabs.ts`. The table is also the list of
  Nendo's own keys a custom view hands back (`hostKeys`), so a tab key pressed inside a view works
  as it does anywhere else.
- **Show keyboard shortcuts** is the keyboard button in the status line, or Ctrl /. It is off by
  default and kept for the device under `nendo.shortcuts`.
- **Help** has a *Keyboard shortcuts* topic built from the same table.

## A custom view's controls

These are unchanged from Console (W-090, W-092; ADR-0013). Nendo draws a view's declared controls
in the Use toolbar's one row, under the address row, before Add. On a record page they sit in the
panel's header. A toolbar menu and a right-click menu are the File menu's panel.

## Studio's record page and the split pane

These are unchanged from Console (W-071). The record page is a sheet and a sidebar, and the record
inspector beside a list is the split pane.

## Where it lives

`index.html` holds the frame. `styles/21-native.css` restates the shell and loads last.
`workspace-tabs.ts` draws and keeps the tabs, `rail-places.ts` the file's places in the
navigation, and `type-icons.ts` the record type icons. `title-bar.ts` measures the tab strip with
the rest of the band, so its controls are passed through and the space between them drags the
window.
