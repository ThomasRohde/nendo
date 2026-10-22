# ADR-0034: Device state is grouped by concern

- **Status:** Accepted
- **Date:** 2026-10-22
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** High
- **Evidence:** `DesktopDeviceStateLayoutTests` has every store write to a test root and compares the tree with the layout below
- **Depends on:** ADR-0002, ADR-0008, ADR-0009, ADR-0013, ADR-0030
- **Contract:** [launched agents](../contracts/launched-agents.md), [custom views](../contracts/custom-views.md), [calculations and actions](../contracts/calculations-and-actions.md)

## Context

What a person chooses on one computer is kept on that computer, never in a `.nendo` file, so a
file sent to someone never carries the sender's consent, ports or window places. Each choice has
a small store in `src/Nendo.Desktop` that replaces one JSON document whole
(`DesktopStateFile`) and, where windows of several files write it, under a named mutex
(`DesktopDeviceStateLock`).

With each store naming its own document in the root, the root becomes a list of loose
files whose names do not say which part of Nendo owns them, and the agent connection and each
agent's settings compete for one name. A test or lane root (`NENDO_DEVICE_STATE_ROOT`) needs
the same shape as the person's, or a path a lane checks is not the one in use.

## Decision

**The device-state root holds one folder per concern and no loose files.** The root is
`%LOCALAPPDATA%\Nendo`, or the folder `NENDO_DEVICE_STATE_ROOT` names, which has the same layout.
`DesktopDeviceStateLayout` names every folder; each store names its own document in it.

| Path | Store | Holds | Bound | Kept |
| --- | --- | --- | --- | --- |
| `agents\connection.json` | `DesktopAgentSettingsStore` | Fixed port on or off, the device's port, lease expiry | 4 KiB | device |
| `agents\ports.json` | `DesktopAgentPortStore` | The port each file keeps (ADR-0009) | 128 KiB, 256 files | per file |
| `agents\access.json` | `DesktopAgentModeStore` | The access level each file keeps (ADR-0009) | 128 KiB, 256 files | per file |
| `agents\launch.json` | `DesktopAgentLaunchStore` | Added command, hidden agents, last agent, view messaging, files that start in their repository (ADR-0030, ADR-0033) | 16 KiB, 32 files | device |
| `agents\settings.json` | `DesktopAgentOptionsStore` | Each launched agent's picked settings and the options it offered | 256 KiB | per agent |
| `agents\sessions\` | `DesktopSessionController` | An empty working folder per launched conversation, swept | swept | per run |
| `views\settings.json` | `DesktopExtensionSettingsStore` | Run custom views, for the device and per file; development links (ADR-0013) | 256 KiB, 4,096 files, 64 links | device and per file |
| `views\origin-carry.json` | `ExtensionOriginCarry` | The instance that kept its views' storage when the origin key gained the instance; written once | 64 KiB, 256 | per application |
| `actions\consent.json` | `DesktopBehaviourGrantStore` | Consent for a file's automatic actions (ADR-0008); fails closed | 256 KiB, 512 grants | per file |
| `window\appearance.json` | `DesktopAppearanceStore` | Theme: System, Light or Dark | 4 KiB | device |
| `window\tray.json` | `DesktopShellStore` | What Close does, whether the tray was explained, Record failures | 4 KiB | device |
| `window\places.json` | `DesktopWindowStore` | Where the last window was, and where each file's was, by a digest of its path | 64 KiB, 64 files | device and per file |
| `files\recent.json` | `DesktopFileHistory` | Recent files, for the start page, the taskbar and Start | 64 KiB, 32 files | device |
| `files\icons\` | `DesktopFileIcon` | Each file look's drawn icon and its index | 64 looks | cache |
| `logs\view-failures.jsonl` | `DesktopViewFailureLog` | Times the app view stopped, while Record failures is on (ADR-0002) | 50 lines | device |
| `logs\agent-failures.jsonl` | `DesktopAgentFailureLog` | Agent requests that failed inside Nendo, under the same switch | 50 lines | device |
| `Mcp\active\` | `NendoDiscoveryStore` | One endpoint entry per open file (ADR-0009) | one per open file | per run |
| `WebView2\` | `DesktopBrowserProfile` | The Workbench's browser profile; `WebView2-debug\` for a Debug build | WebView2's | cache |

- **A store keeps its own document and failure rule.** Folders group documents; they do not
  merge stores. The window store's two places are one document because one store owns both.
- **`Mcp\active` keeps its address.** Scripts, the planner mod and the Agents guide find running
  files there, and ADR-0009 publishes it.
- **Nothing else is written at the root.** A store writes only inside its folder; a document's
  stage is written beside it and moved over it. A new store takes a folder from this table, or
  this ADR gains one.
- **Nendo reads no other place.** Documents an earlier build kept elsewhere are not read, moved or
  deleted.
- **Mutex names follow the documents.** A non-required lock is named after its folder and document
  (`agents.ports`, `window.places`); a required one by a digest of its path.

## Consequences

### Positive

- The root lists eight folders, and a folder says which part of Nendo a document belongs to.
- A lane's root and the person's have the same shape, so a path in a test is the path in use.
- One test lists what the root may hold, so a store that writes beside the others fails it.

### Negative

- Documents kept anywhere else are not read: a computer whose documents sit elsewhere starts
  every choice over unless they are moved by hand, among them consent and each file's port and
  level.
- `Mcp` keeps its capital, unlike the other folders.

## Rejected alternatives

- Fewer documents (a file's port and level in one entry, theme and tray in one preferences
  document): two pairs of stores become one each, with new locking, and an unreadable document
  would reset both halves.
- Folders by scope (`device\` and `files\`): agent and view choices would be spread over two
  folders, and the custom-view settings store would split in two.
- Moving the old documents at start: no user files exist outside the project, so a migration is
  code kept for one machine.

## Revisit triggers

- A store whose document does not fit one of these concerns.
- Device state that should roam between a person's computers.
