# Roadmap

This file says where Nendo stands, what is not qualified and what is known not to
work yet. [architecture.md](architecture.md) describes what is built. Priorities and
execution live in the [development planner](dogfooding.md): its Now and Next horizons
are the plan, and this file does not repeat them. Accepted ADRs and contracts keep
architecture authority.

## Where Nendo stands

Nendo 1.0.0 is a local, unsigned, per-user Windows x64 install for the owner's own
use. The core loop works end to end: an external agent connects over local MCP,
inspects a real application, authors and reshapes it, and the owner reviews a semantic
diff and accepts. Four reference applications test the claim from different shapes:
Idea Garden, Decision Log, the Axiom Register and [Nendo Station](nendo-station.md).
The last two were built from an empty file through MCP alone.

1.0 promises that a file 1.0 opens normally keeps opening normally in every later 1.x
([ADR-0012](decisions/0012-safe-mode-compatibility-and-migration.md)). It is not a
public release, and every gap below stands.

## Not qualified

Each row is a gap. Do not read a gap as a feature.

| Area | Status |
| --- | --- |
| Public distribution, code signing, ARM64 | Not started |
| Cross-platform | Windows only |
| Cloud sync and live-root writes | Unsupported. The host warns about known sync paths. No sync-safety claim |
| Physical power loss | Not qualified |
| Clean-machine install | Owner-reported pass. No automated assertion, and none planned: a disposable environment costs more than the evidence is worth for a path only the owner uses |
| Installed startup on large datasets | Accepted measured exception, not a pass. On the largest cells of `Review-DesktopPerformance.ps1` (10,000 records, 10,000 revisions) whole startup misses 5 s, mostly outside the Engine |
| Human usability and accessibility | Owner-reported: Windows 100%/200% scaling, keyboard and focus, screen reader. No lane instruments them |
| The notification area and Windows notifications | Owner-reported. `Review-ShellRuntime.ps1` checks that close hides the window, the process and its file survive, opening the same file again brings the window back, and the exit pin exits. No script can observe the tray icon, its menu or the notifications. Windows puts a new tray icon in the overflow, and nothing tests whether a first-time person finds their window again |
| What the Windows shell draws | Owner-reported. Measured: the registry writes setup makes and removes; the shell identity, read back from the running window and the notification registration; the stored Jump List and that it names the open file; WebView2's refusal of a page-made file. Not measured, and not reachable from a script: the Explorer document icon, the taskbar overlay badge and progress (`SetOverlayIcon` and `SetProgressState` report nothing back), the right-click menu, a file dragged from Explorer, the Jump List rebuilt when the open file changes |
| Reference MCP Inspector | Opt-in lane only. `Test-Production.ps1 -Inspector` compares the Inspector's `tools/list` with the host's; the package is not on the development machine, so it reports Inconclusive. The gate ports four of its lint rules instead |
| Broad MCP client parity | Not promised. Claude Code and Codex connect with only the address, and opt-in installed-client lanes check that |
| Account boundary on a shared machine | None. There is no credential ([ADR-0009](decisions/0009-local-mcp-transport-authority-and-change-sets.md)): every process under every account connects at the file's access level. Chosen for iteration speed on a single-user machine. The route back is a peer-process user check, not built |
| Custom views | Phases 0 to 4 and the `extensionView` root are delivered; the `extensionTile` on the front page and dashboards is not built. No product lane measures the clipboard, downloads or pop-ups in a view, or the memory budget with the real packages under `extensions/`. A received file's code runs when its view is shown: an accepted limitation ([ADR-0013](decisions/0013-custom-views-with-code-in-the-file.md)) whose only controls are the kill switches |

## Known limitations

### Agent authoring and MCP

- **A sum totals a required field only.** Installation refuses a `Sum` over an optional
  field. A `Coalesce` or per-member default needs its own semantics.
- **Concurrent proposals are announced, not rebased.** `change_set.begin` reports other
  open change sets and `proposals` lists what is pending; a staleness conflict still
  appears at validate, and `nendo.change_set.revalidate` validates the same operations at
  the current revision. An automatic rebase changes what a conflict means under
  [ADR-0007](decisions/0007-proposal-clone-validation-and-replay-promotion.md) and needs
  its own ADR.
- **An agent that lost its application handle can see a pending proposal but not act on
  it.** One that kept its handle resumes under it with `nendo.lease.acquire`. Binding a
  proposal to something more durable is an authority change.
- **A minimum-host-version raise is shown, not chosen.** The diff carries
  `raiseMinimumHostVersion` as an irreversible line, but a change set cannot be authored
  to stay within an older host, and a file's minimum host never goes down, even when the
  property that raised it is removed or undone.
- **The discovery advertisement names the file, not its path.** `displayName` is
  present; `filePath` is not, and a path put there is cut to its last segment. Agents
  never receive a database path ([vision](vision.md)).
- **At Unattended nobody reads the change before the file takes it.** It is off by
  default, confirmed before it takes effect, remembered only for the file it was chosen
  for (a copy made outside Nendo keeps the level), and every acceptance is a History
  revision. Nothing records that a change went in unreviewed, and nothing warns a person
  who leaves the level on.
- **Closing the window does not close the file.** Close hides to the notification area,
  so access stays on. The tray menu shows the access mode and can end it.
- **An import is not atomic.** `nendo.data.import_records` commits fifty rows per
  revision; an exact retry replays what committed. The caller cannot ask which row was
  refused, except from the message, or skip it.
- **A JSON import is taken in the order sent.** A CSV import of a declared tree is put
  parents first; a JSON record that names a later one is refused as `target-not-found`.
- **An agent's import reads as plain creates in History** ("Create 50 Tasks"), where a
  person's reads "CSV import".
- **An agent cannot write a value larger than one 256 KiB request**, though Studio
  stores longer text.
- **The transport has no session.** A client is named from its `initialize` request, then
  from the `User-Agent` header's first product token, else "Local agent".

### Launching the person's own agent

[ADR-0030](decisions/0030-launch-the-persons-own-agent-over-acp.md) is built. AG-UI is
not adopted.

- No gate journey runs through the real host; the Desktop suite drives a stand-in agent.
- A conversation cannot be resumed (`session/load`). The transcript lives in host memory
  until the file closes or another agent is launched.
- Nendo cannot confine the program, and says so.

### Calculations and actions

- **ToText has no format argument.** It writes digits and `yyyy-MM-dd` everywhere. Its
  rung is found by name, so `ToText(` in a text literal, or a file function named
  `ToText`, also raises a file to 1.49.0.
- **A blocked trigger condition is not stored with the revision.** The write result says
  so, but History, a receipt read back, a replay, a proposal's review and the accept
  result do not. Storing it needs a new protected table on the layout ladder.
- **A decimal into a whole-number field is refused** unless the whole formula is
  `RoundAway(…, 0)` or `RoundEven(…, 0)`.
- **A whole-file snapshot evaluates every record's calculations**, so it scales linearly
  with the file; [calculations-and-actions.md](contracts/calculations-and-actions.md)
  publishes the figures.

### Storage, history and recovery

- **A busy read is not a typed outcome.** A busy save is `file-busy`; a read that meets
  `SQLITE_BUSY` past the 2-second timeout lets the raw error through. So does a busy save
  on a host-owned stage (identity transition, new-file transformation, legacy upgrade).
- **Some unfinished writes stay refused.** A journal that cannot be shown to be this
  file's, for example from a crash before the manifest page was saved, is refused
  untouched and the person opens a backup.
- **A journal from a copy of the same file cannot be told apart.** Playback runs only on
  the person's own open outside a recognised synced folder, and keeps the file as it was.
  Folder detection is incomplete and a hand-made copy beside the file is not detected; a
  per-write marker would close it. A host that never passes `RollBack` never rolls back.
- **Two messages have no headless test:** a write-protected volume refusing the lease, and
  a journal over 256 MiB.
- **An exact retry across an upgrade may be refused** as `idempotency-conflict`. The
  reversibility class and payload are in the idempotency digest, and
  `schema.setFieldPresentation` is `ReversibleWithRetainedState` with an undo that writes
  `presentation: null`, so an older host's request resent by this one (the Workbench's
  save journal can) no longer matches. The first request committed; only the answer
  misleads.
- **Only a definition's latest change can be undone.** History offers Undo on a structure
  change only while it is the file's latest.
- **History offers Undo on a fill of a required field**, then refuses it in words while
  the field is required.
- **A reference index can lose its name to another table** (`nendo_ref_<table>_<column>`).
  It costs only speed. A unique index lost to a collision returns when its field is
  declared unique again.
- **One unreadable cell or one renamed record-type table rejects the whole file**, with
  no data readable. Recovery of the rest needs per-type and per-field omission in the
  reader. Only an edit outside Nendo produces such a file.
- **A file that records less than its screens need stays read-only.** Nendo never raises
  the recorded format silently ([ADR-0012](decisions/0012-safe-mode-compatibility-and-migration.md)).
  Open a backup.
- **A read-only session without a verifiable digest cannot read package files**, and
  Help shows only the built-in pages.
- **A reader that holds the file through a restore is refused**, not waited for, after
  about a second: `replacement-target-in-use`, nothing changed.
- **A fold that could not compact the file does not say so on screen.** The result
  carries `spaceReclaimed: false`; History does not read it.
- **A file never folded has no history indexes**, so the receipt-by-proposal and
  compensation reads scan every revision. Adding them at any other moment would raise
  the host version on an ordinary write.
- **Preparing and promoting a proposal read every record** of the active file and clone.
- **Every commit counts every table**, `__nendo_operation` twice.
- **Only some filters seek an index:** equality on text, a reference or a date, and the
  null checks. UUID equality, ranges and `contains` scan.
- **A review's first read of a package file opens the clone under the write gate.**
- **Half a skill package cannot be undone from History.** Undoing the revision that put
  `SKILL.md` is refused; change or remove the package by a new proposal.
- **Three writes to one view-state key in one mutation can repeat a version.** Nothing in
  Nendo makes such a mutation.

### Search, dates, locale and CSV

- **Search does not find a word inside Thai, Chinese or Japanese text**, and does not
  fold Turkish `ı`. A script-routed index changes the protected layout and needs its own
  ADR ([ADR-0028](decisions/0028-full-text-search-in-the-file.md)).
- **Two clocks decide today**, the Engine's and the Workbench's. They agree within a
  minute of a time-zone change.
- **No lane drives a real midnight.** Workbench unit tests and a source check of
  `main.ts` hold the day rollover.
- **External CSV refuses `TRUE` and `FALSE`**; the contracts fix `true` and `false`.
- **A Danish Excel opens an export in one column**, because the delimiter is a comma.
  Data > From Text/CSV reads it.
- **`1,234` is refused as a decimal** where the language writes decimals with a dot.
- **Does not equal with a plain date on a date-and-time field is refused**; a filter has
  no OR.
- **A matrix keeps its unset row and column** under a grouping-field `ne`.
- **A view's page language is checked in source only** (`view-language.test.mjs`).
- **The native recovery panel's InfoBar and the native dialogs' theme are checked in
  source only** (`DesktopWindowChromeTests`).

### Screens

- **Eight roots per kind per record type** is a guess, not a measured optimum.
- **A calendar is a Date field on a month.** DateTime, time zones, week and day views,
  duration, recurrence and drag-to-date are out; a DateTime binding is refused by name. A
  month is read a page at a time, with Load more.
- **A rating's scale is set once.** A wider scale needs a new field. A value outside the
  scale is kept and stated, not refused.
- **A timeline places a record by its start date** in one civil year. An overlap query
  needs an OR.
- **Per-tile reads run four at a time**, a chosen number.
- **Tab and screen selection are renderer state**, not stored in the file, so a person
  returns to the first tab on reopen.
- **Only Studio's flat table loads continuously.** Use lists, related records, boards and
  date-range views need their own loading policies; rectangular paste and bulk edits need
  their own decision. Unindexed sorting of very large tables is bounded but not fast.

### Repository and delivery

- **The product has no CI, deliberately.** The one CI lane deploys the website. The old
  product CI failed with zero jobs, most likely an exhausted Actions allowance; settle
  that before adding product CI again.
- **The NSIS wrapper is unchecked.** `Test-NendoInstaller.ps1` alone covers the
  bootstrapper, extraction, HKCU uninstall registration and that the real `Uninstall.exe`
  leaves `.nendo` files alone, and it runs only under a clean Windows user.
  `Test-NendoSetupIsolated.ps1` covers the setup logic on every build. Before Nendo goes
  to anyone who did not build it, run the installer lane under a throwaway user.
  `nsisWrapper` reading "not run for this build" in `installer-status.json` is the
  expected state.
- **`Test-BinaryAssets.ps1` is structural.** PNG and ICO carry CRCs, so a flipped byte is
  caught; an MP4 or a `.nendo` page has no checksum, so only structure and truncation are.
- **The website** (`site/`, [ADR-0018](decisions/0018-public-website-and-deployment-lane.md))
  checks its internal links on every build. Nothing checks that its pages match the code,
  follows an external link, or evaluates accessibility. To reproduce a link failure
  locally, clear both `site/.astro` and `site/node_modules/.astro`.

## The standing risk

Everyone who has used Nendo built it, and every usability, scaling and accessibility
result is owner-reported. That says nothing about whether a newcomer can follow it. The
[Idea Garden journey](../fixtures/idea-garden/journey.md) is the walk to give a new
person. Treat a confused first run as a finding.
