# Mica with tabs: the visual direction

Nendo's visual reference: a native, professional Windows app. This is a product and visual
reference, not an architecture authority. Contracts and accepted ADRs govern behaviour.

## The look in one paragraph

Mica with tabs is a Windows 11 app in WinUI's idiom. The window's ground is Mica, the
host's own backdrop, and it shows through the title band, the navigation and the status line.
The work sits on one layer with a rounded top-left corner, as a NavigationView draws its content.
The places a person keeps open are tabs over that layer, and the active tab is joined to it. The
accent is the Windows blue. Navigation items are 36px, the address row's buttons and the command
box are 32px, and text fields and selects are 30px, all with 4px corners; panels and cards have
8px corners. Light is the Fluent neutral greys; dark is designed, not
inverted. Ids, counts, versions and key names stay in a mono face.

## Mica

`MainWindow.xaml` sets a `MicaBackdrop`. `ShellGrid` in `MainPage.xaml` is transparent and the
WebView2's `DefaultBackgroundColor` has an alpha of 0, so the backdrop shows wherever the page
leaves its ground. In the Desktop host the page sets `data-backdrop="mica"` on `:root`, which makes
`html`, `body` and the app shell transparent. In a browser `--mica` stands in for the backdrop: the
colour Mica takes over a neutral wallpaper. A custom view is not handed `--mica`, because a view
draws on the layer and never on the ground. The recovery panel keeps its own opaque brush.

## Tokens

The colours live in `src/Nendo.Workbench/src/styles/02-tokens.css`, except `--mica`, which
`21-native.css` declares. Custom views are handed exactly these names (`themeTokenNames` in
`extension-model.ts`, and the custom-views contract), so they stay as they are. `--cobalt` is the
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

Text on an accent fill is `--on-accent`: white in light and `--canvas` in dark, because the dark
accent is light. The primary button, the send button, the step marker, the entity icon and an
on switch's knob use it.

No rule writes a colour itself (`scripts/css-cascade.test.mjs`). The stylesheet's own tokens, which
no view is handed, are declared in `21-native.css`: `--on-accent`, `--switch-knob`, `--shadow-knob`,
`--shadow-tab-hover` (the agent tab's hover), `--scrim` (behind the About and Delete dialogs),
`--scrim-palette` and `--shadow-palette` (the command palette). `13-refinements-pages.css` declares
`--shadow-card` and `--shadow-raised` for each theme; a shadow is dark in both.

Radii are tokens, declared in `21-native.css`:

| Token | Size | Use |
| --- | --- | --- |
| `--radius-control` | 4px | Controls |
| `--radius-panel` | 8px | Panels and cards |
| `--radius-shell` | 8px | The record form's card |
| `--radius-small` | 6px | A chip or icon inside a card |
| `--radius-conversation` | 10px | The agent tabs and the conversation's cards |
| `--radius-composer` | 12px | The message box and the @ menu over it |

Only 2px and 3px marks, circles and pills are written as numbers.

The root font size is 14px. Body text is not set below 0.75rem. These small labels go below it on
purpose, down to 0.68rem (about 9.5px): key caps, the count of waiting changes on the Agent page's
Activity card, a launch command on the Agent page and the note that
it was renamed, and in the agent conversation its tags, the context line under a message, an
option's name, the @ menu and the line under the box. Tool output and a command to copy by hand
are content, not labels, and stay at 0.75rem.

The data grid (`nendoGridTheme` in `view-data.ts`) repeats these values, because it cannot read
a CSS variable. Change them together.

## The shell

- **Title band (48px).** The window's title bar. Over the navigation it carries the Nendo mark, the
  file's name and the File menu; over the layer, the tab strip. Windows draws Minimise, Maximise
  and Close at its right end, and the strip keeps their width free (`--title-bar-right`). Every
  part of the band that is not a control moves the window.
- **Navigation (280px).** A NavigationView on the ground: 36px items, a fill and a 3×16px accent
  pill for the selected one. **Use** heads the first section (Ctrl 1). Under it are the file's
  front page, its own views and its record types (`rail-places.ts`); choosing one opens Use on it
  from anywhere. **Studio** heads the second section (it opens Data), with Data, Structure,
  Surfaces, History and Health under it. Agent and Help sit at the foot. A long list of record
  types scrolls on its own, so Studio stays in reach. The hamburger above Use folds the navigation
  to 56px of icons (Ctrl B); the fold is kept for the device.
- **Record type icons.** A file may choose a record type's or a screen's icon from Nendo's set
  ([ADR-0038](../decisions/0038-settings-in-one-place.md)). Without a choice it is guessed from the
  name (`type-icons.ts`): the head noun, the last word in English, is looked up in a short table of
  everyday nouns, so Crew gets people, Incidents a warning, Readings a gauge. A name that matches
  nothing gets a box, and a screen the layout icon. The navigation, the tabs and the address row
  use the same icon.
- **Tabs.** Each tab is a place kept open (`workspace-tabs.ts`) and a trail with its own places and
  cursor, so Back and Forward belong to the tab, as in File Explorer. Switching tabs swaps the saved
  trail into `navigationTrail` and puts its current place back the way a step back does
  (`revisitCurrent`). A tab not on screen costs a list of places and nothing else: no frame, no
  read. Tabs belong to the window and are cleared with the file. A place carries its Filter pick
  and Studio's sort and filter, so two tabs on one screen keep their own (ADR-0004); changing them
  amends the place on screen, not a new step.
  - **+**, Ctrl T: a new tab on the place on screen.
  - Ctrl W, a tab's close button, a middle click on a tab: close it. The last tab cannot be closed.
  - Ctrl Tab and Ctrl Shift Tab: the next and previous tab. The arrow keys move between tabs, and
    Delete closes the focused one. The tab on screen is the strip's one Tab stop; the close
    buttons are the pointer's, and New tab stands after the tabs.
  - Once the tabs reach their narrowest the strip scrolls sideways, keeping the tab on screen in
    view with New tab beside it.
  - A Ctrl-click or a middle click on anything in the navigation opens it in a new tab.
  - A tab is named after the place on screen: the record type and the view (*Incidents · Ops
    board*), or Studio and its page. A view named after its type is named once.
  - A page can put a status mark on its own tab (`setTabStatus`). The agent conversation shows
    there that the agent is starting or working (a turning ring), thinking (a breathing dot) or
    waiting for the person (a still amber dot).
  - A page that is one of a kind in the window opens in a tab of its own, or moves to the tab
    already on it (`openTabOn`): the agent conversation, and the Agent page when the conversation
    opens it beside itself.
  - Closing a tab tells the page it showed (`onTabClosed`). Closing the conversation's tab ends
    the launched agent and everything it started (ADR-0030).
- **Address row.** The first row of the layer: Back and Forward (Alt Left and Alt Right), the
  breadcrumb, and the command box (Ctrl K). On a Use screen the breadcrumb carries the record-type
  and view pickers, and where the window has room the Use toolbar sits in the row's middle, one
  bar. The page names itself here and nowhere larger.
- **Status line (28px).** On the ground, in the UI face: the file's icon and name on the left; the
  agent pill, the health pill, the theme (System, Light, Dark), the key hints toggle and the
  version on the right.
- **Notices.** What happened is said in a stack over the bottom right of the layer, just above the
  status line (`#notice-stack` in `shell.ts`), never in the page, so nothing on the page moves when
  a notice comes or goes. A notice is a raised card on `surface-raised` with `shadow-raised`: a
  tone icon (`healthy` check, `danger` alert, `warning` alert for something that stays wrong), its
  sentence, its button and a close button. A success goes by itself after five seconds or more,
  longer for a long sentence or one with a button, its time running down a 2px bar along its foot;
  the pointer on it, or the keyboard on one of its buttons, holds it. A success the next action
  replaces stays above the new notice for the rest of its time, three notices at most. A refusal
  goes at the next press; a kept alert and a Refresh view notice stay until dealt with. A notice
  belongs to the screen it was said on. The stack rises above the page's own action shelf whenever
  it would cover one: a form's Save and Cancel, the agent conversation's message box, a list's
  Previous and Next.
- **A narrow window.** Below 841px, at every height, the navigation is the bar across the top and
  the title bar, keeping the width of Windows' buttons free. A bar wider than the window scrolls
  sideways only, with a thin scrollbar, and keeps a hairline under it. Tabs wait for a wider
  window, and the tab keys (Ctrl T, Ctrl W, Ctrl Tab) do nothing until they are on screen again.
  The File menu opens below the bar, on the window. The address row stays one row, and the status
  line keeps its pills; at 480px or less a pill is its dot, and its words stay for a screen reader
  and as its tooltip. With no file open in a wide window there are no tabs, and the address row
  keeps the width of Windows' buttons free instead.
- **Contrast themes.** Under a Windows contrast theme (forced colors) every fill becomes the
  theme's background and shadows go, so a selected or pressed state that is only a fill gets a
  mark focus never draws: a 3px Highlight bar under a record page's tab, a view switcher segment,
  the theme buttons, the Data view's Outline and Table buttons and the key hints toggle, and
  Highlight rules above and below the outline's selected row. The navigation's selection pill, a
  chosen rating and a filled rating dot keep a Highlight fill. Focus stays the outline, so it shows
  on a selected control too; the @ menu's option and today's calendar cell take a Highlight outline.

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

Nendo draws a view's declared controls in the Use toolbar, before Add (ADR-0013). Where the window
has room, that toolbar shares the address row, between the breadcrumb (which then hugs what it
says) and the command box, which narrows to 240px (one bar, `one-bar.ts`); where the middle is
narrower than the toolbar needs, it keeps its own row under the address row. On a record page the
controls sit in the panel's header. A toolbar menu and a right-click menu are the File menu's panel.

## Studio's record page and the split pane

The record page is a sheet and a sidebar, and the record inspector beside a list is the split
pane. A record's long text is one document on that sheet, one field under another, each box as
tall as its text.

## Where it lives

`index.html` holds the frame. `styles/21-native.css` restates the shell and loads last.
`workspace-tabs.ts` draws and keeps the tabs, `rail-places.ts` the file's places in the
navigation, and `type-icons.ts` the record type icons. `title-bar.ts` measures the tab strip with
the rest of the band, so its controls are passed through and the space between them drags the
window.
