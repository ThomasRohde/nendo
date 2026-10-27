# ADR-0038: Settings in one place, each with one home

- **Status:** Accepted
- **Date:** 2026-10-27
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** Medium
- **Evidence:** Pending; accepted on the owner's standing pre-acceptance of ADR changes
- **Amends:** ADR-0013 (a package declares settings; the view API gains `nendo.settings`), ADR-0034 (a folder for apps' personal settings)
- **Depends on:** ADR-0004, ADR-0007, ADR-0009, ADR-0012, ADR-0013, ADR-0034
- **Contract:** [custom views](../contracts/custom-views.md), [Studio](../contracts/studio.md), [MCP interface](../contracts/mcp-interface.md)

## Context

Nendo has no Settings page. Its settings sit in seven places: the status line, the rail, the tray
menu, Agent → Connect, Agent → Launch, Studio → Screens → Custom views, and Health with About this
file. They are kept in three ways: device state (ADR-0034), the Workbench's page storage, and the
file. The theme is kept twice.

An app cannot declare a setting. Manuscript, Deck, Archi and Garden keep their options in page
storage, Brandkits in view state, BCM Atlas in a view's `configuration`, and no rule says which.

A record type's icon is guessed from the last word of its name, from about 60 icons. A name that
matches nothing gets one or two letters on a tile in a choice tone. Nobody can choose an icon for a
record type or a screen.

What must stay true: a file sent to someone never carries the sender's consent, ports or level
(ADR-0034); an agent reaches the file only through typed services and change sets (ADR-0009); and
the route back to the data, including turning custom views off, is always reachable.

## Decision

**One Settings page, drawn by the host, holds every setting of Nendo and of the apps a file
carries.** It opens as a tab with Ctrl , or File → Settings, and from the command box. Its sections
are General, Agents, Custom views and This file, then one section per app the file carries. A search
field finds a setting in any section. Every row has an address (`settings/<id>`), so help, a notice
or a refusal can open it.

### Three homes

Every setting has exactly one home, and its row names it in these words:

| Home | Holds | Kept | Travels with the file |
| --- | --- | --- | --- |
| **This computer** | Theme, shortcut hints, what Close does, Record failures, run custom views, load pictures from the web, the agent connection, views may message the agent, each agent's options, an app's personal settings | Device state (ADR-0034) | Never |
| **This file, here** | The agent access level and port, approval of automatic actions, run this file's views, development links, start agents in the file's repository | Device state, keyed by the file's application ID | Never |
| **In the file** | The look, icon, purpose and new-file label; record-type and screen icons; an app's shared settings | The definition, as typed operations | Always |

A file can never set a setting of the first two homes. An app's setting is never in the second home.

### Changing a setting

- A setting kept on this computer changes when the person changes its control. It is a choice on
  this device and not history.
- A setting in the file changes through a proposal (ADR-0007). The page gathers the person's changes
  to the file and shows **Review N changes to the file** with Discard. Review opens the host's own
  proposal review, as a change Studio prepared does; accepting it promotes the change by replay. It
  then shows in History and can be undone where its operation says so.
- In a file opened read-only, in safe mode, or in recovery, the page still opens. Rows kept on this
  computer work, so Run custom views is always reachable. Rows in the file are read-only and say why.
- An environment variable that overrides a setting (`NENDO_DESKTOP_CLOSE_ACTION`,
  `NENDO_AGENT_PORTS`) makes its row read-only, and the row says which variable is set.

### One catalogue

A settings catalogue in the shared application services names every setting of Nendo: its ID,
title, home, type, allowed values and the store that keeps it. **The stores of ADR-0034 stay and do
not merge**; the catalogue names and routes, it keeps nothing of its own. The Settings page, the
command box, the tray and the controls that exist today on the Agent page, Studio and Health read
and write through it. A change reaches every window, as a device setting does today. The theme is
kept once, in device state; page storage keeps a copy only so the first paint has the right
colours.

### Apps declare their settings

`nendo-package.json` gains `settings`, a list of at most 64 declarations:

- `id`, `title` and optional `help`;
- `type`: `toggle`, `choice` (with `options`), `number` (with `min`, `max` and an optional `unit`),
  or `text` (at most 1,000 characters);
- `default`;
- `layers`: `personal`, `shared` or `both`.

Nendo draws the setting, so it works while the app's views are off or broken. A value is checked
against its declaration. A value that no longer fits it is not used: the next layer down is used,
or the default.

**A value is found in layers.** It starts as the app's default. A shared value in the file
replaces the default, if the setting allows `shared`. A personal value on this computer replaces
both, if the setting allows `personal`. With `both`, the row shows the file's value beside the
person's and offers **Use the file's**.

- A personal value is kept on this computer by package ID. It holds for every file that carries the
  app.
- A shared value is kept in the file's definition by package ID and setting ID. It is written by one
  operation, `package.setSetting`, which reverses to the value it replaced.

**The view API** gains `nendo.settings.get(id)`, `nendo.settings.all()`,
`nendo.settings.set(id, value)` and the event `settingsChanged`. `set` writes a personal value at
once. A shared value from a view goes through the view's proposal path, as any definition change
does. A view reads only its own package's settings.

**Where an app keeps a choice.** If a person would look for it in Settings, the app declares it. A
place left behind (folds, widths, drafts, the zoom while working) stays in the view's page storage.
How one view on one screen is set up stays its `configuration`.

### Icons for record types and screens

A record type, a semantic screen and a custom view may carry an **icon**: the name of one icon from
Nendo's icon set. The set is a curated selection of about 400 icons from Lucide, at the version the
design system pins, drawn as outline icons in the current text colour. It is listed with each icon's
search words in the MCP vocabulary.

- The icon is part of the definition, set by `schema.setEntityIcon` and by an `icon` property on a
  surface or view definition. Each reverses to the icon it replaced.
- It is used wherever that record type or screen is drawn with an icon: the navigation, the tabs,
  the breadcrumb pickers, the command box and the front page.
- **Settings → This file → Icons** lists every record type and screen with its icon. **Change**
  opens the picker. The picker can also be opened from a navigation item's menu (**Change icon**).
  - It is a popover with a search field over the icons' names and search words, the set's groups,
    and the icons used last.
  - It shows a grid the arrow keys move through. Enter chooses an icon.
  - **Use the guessed icon** clears the choice.
  - A choice joins the page's changes to the file.
- **Without a choice, the icon is guessed from the name**, as today. **A name that suggests none
  gets a neutral icon**: a box for a record type, a layout for a screen. The letter tiles in choice
  tones are removed.
- An icon name this version of Nendo does not know is treated as no choice. An older Nendo opens the
  file with its guessed icons.

### What agents reach

- MCP reads an app's shared settings, the icons and their defaults in `describe`. It changes them
  only in a change set (`package.setSetting`, `schema.setEntityIcon`, the `icon` property), under
  the levels and gate of ADR-0009.
- MCP never reads or writes a setting kept on this computer: not the theme, the access level,
  consent, the view switches or an app's personal values. The production gate keeps refusing an MCP
  source file that names those stores.

## Consequences

### Positive

- One place to find a setting, and one sentence on every row that says whether it travels.
- Apps stop inventing storage for options, and their settings work while their views are off.
- A shared default with a personal override covers a house style that a reader may still adjust.
- Icons become a choice, and a file without choices no longer shows coloured letter tiles.
- The existing stores and their locks are unchanged; the catalogue adds routing, not storage.

### Negative

- Changing a setting in the file takes a review, where a toggle on this computer takes none.
- The Workbench carries about 400 icons instead of about 60.
- Each app that moves its options from page storage to declared settings needs its own change, and
  a person's existing choices in page storage are not carried over.
- A setting now has two ways to be changed (its old control and its row), both of which must stay
  in step through the catalogue.

## Rejected alternatives

- **Settings grouped by home, one tab each:** this makes the travel rule the page's structure, but
  splits Agents, Custom views and every app across tabs.
- **Settings only in the command box:** this is the fastest to reach, but it has no room for help, an
  app's section or the icon picker.
- **One settings document for the device:** an unreadable document would reset every setting, and
  ADR-0034 keeps one document per concern for that reason.
- **Shared app settings in view state (`nendo.state`):** a view's state is data, is not kept in a new
  file of the application, and is outside the definition an agent reviews.
- **Shared settings written at once, without review:** a change to the file would bypass the gate
  every other definition change goes through.
- **Any Lucide icon by name:** the full set is large, and a name Nendo cannot draw would come from
  the file.
- **Keeping the letter tiles as the fallback:** the owner finds them distracting; a neutral outline
  icon reads as part of the same set.

## Revisit triggers

- A setting that does not fit one of the three homes.
- An app that needs a setting kept for one file on this computer.
- Settings that should roam between a person's computers.
- People who choose icons outside the curated set often enough to ask for more.
