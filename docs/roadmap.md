# Roadmap

Where Nendo goes next, and what is honestly not yet true. This file replaces the
running milestone changelog: delivered work is described in
[architecture.md](architecture.md), not re-litigated here.

## Development planning

**Nendo Development is the primary work planner.** Its setup status, connection,
record types and agent handoff are in [dogfooding.md](dogfooding.md). Use its
Now / Next / Later horizons, work statuses, Findings and Checks for detailed
priorities and execution evidence. This roadmap keeps product direction,
qualification limits and source context; accepted ADRs and contracts retain
architecture authority. A backlog import is not acceptance of a future design.

The initial inventory covers the unfinished work and intentional limitations
below, the linked surface plan and remaining review findings. Delivered slices
and resolved historical defects are not imported as new unfinished work.

## State

The MVP loop works end to end on Windows x64. An external agent connects over
local MCP, inspects a real installed application, authors and reshapes it, and
the owner reviews a semantic diff and accepts. Four reference applications —
Idea Garden, Decision Log, the Axiom Register and Nendo Station — falsify the
claim from different shapes; the last two were built from an empty file through
the MCP interface alone, and [Nendo Station](nendo-station.md) carries every kind
of screen this host compiles plus a custom view of its own.

Delivery is a local, unsigned, per-user Windows x64 install.

## Not qualified

Stated plainly so nobody reads a gap as a feature.

| Area | Status |
| --- | --- |
| Public distribution, code signing, ARM64 | Not started |
| Clean-machine install | Owner-reported pass on a machine since used for everything else; no automated assertion, and none planned. Accepted limitation 2026-09-19 (W-027 dropped): a disposable environment is an afternoon's work for evidence about a path only the owner walks |
| Installed startup on large datasets | Accepted measured exception, not a pass. One open inspects the file twice; the layout signature scan is the largest single cost |
| Human usability and accessibility | Owner-reported. Windows 100%/200% scaling, keyboard/focus and screen-reader checks were run by the owner, not instrumented. Accepted limitation 2026-09-20 (W-028 dropped): instrumenting them is not valuable for this prototype |
| Cloud sync and live-root writes | Unsupported. Known sync paths are warned about; there is no sync-safety claim |
| Physical power loss | Not qualified |
| Broad MCP client parity | Not promised. Claude Code and Codex both connect with only the address, checked by opt-in installed-client lanes; that is not a general parity claim |
| Account boundary on a shared machine | Removed with the credential ([ADR-0009](decisions/0009-local-mcp-transport-authority-and-change-sets.md)). Chosen for iteration speed on a single-user machine, not a gap being closed |
| Cross-platform | Windows only |
| The notification area and Windows notifications | Owner-reported. `Review-ShellRuntime.ps1` checks that closing hides the window, that the process and its file survive, and that the exit pin exits. The icon, its menu and the notifications themselves are not observable from a script and were not instrumented. Windows also puts a new tray icon in the overflow by default, so whether a first-time person finds their window again is untested |
| What the Windows shell draws | Owner-reported, and the line is worth stating precisely rather than waving at. Measured, item by item: the registry writes setup makes and removes; the shell identity read back off the running window and off the notification registration Windows filed under it; the Jump List file Windows stored, and that it names the open file; and the `-new` command line, run by hand against both an empty placeholder and an existing file (agent-observed, not a lane). Not measured, and not reachable from a script: Explorer drawing the document icon, the taskbar painting the overlay badge or progress — `SetOverlayIcon` and `SetProgressState` report nothing back and nothing can read them, so the call is unobserved as well as the paint — the menu appearing on right-click, a file dragged from Explorer arriving, and the moment the Jump List is rebuilt when the open file changes. A page-made file is refused by WebView2 itself, which is measured |

## Next: surfaces and charts

The vision admitted charts and dashboards on 2026-09-14. What that means, the
surfaces it could add and the order to build them are in
[design/surfaces-and-charts-plan.md](design/surfaces-and-charts-plan.md). The
first slice is a foundation — a colour tone on choice options, an exact grouped
aggregate and one renderer chart kit. The ADR-0004 amendment was accepted on
2026-09-14, and S0 — a tone on every choice option and a record-page header —
is delivered at minimum host 1.19.0. S1 — the exact grouped aggregate, a breakdown
chart and a progress ring on lists, boards and record pages, and drill-through into
a narrowed list — is delivered at 1.20.0, built from
[design/s1-first-charts-plan.md](design/s1-first-charts-plan.md). S3 — the
timeline, records on a spine by a Date field with an optional end date drawn as a
span, and its undated view — was asked for before S2 and is delivered at 1.21.0,
built from [design/s3-timeline-plan.md](design/s3-timeline-plan.md). S2 — a gallery
of cards over a list's window, and a rating drawn as dots on a closed scale — is
delivered at 1.22.0, built from
[design/s2-gallery-and-rating-plan.md](design/s2-gallery-and-rating-plan.md). S4,
the overview page — one root that belongs to the file rather than to a record type,
with a recent list and a range tile — is delivered at 1.23.0, built from
[design/s4-overview-plan.md](design/s4-overview-plan.md). S5, the trend chart and the
activity grid — the first groupings whose groups are generated from a resolved range
rather than read from a field — is delivered at 1.25.0. S6, the matrix and the ranked
list, is delivered at 1.26.0: a grid of two crossed choice fields answered by one read,
so an empty cell is a cell and each cell states an exact number beside the cards it
holds. S7, a board grouped by a reference, is next.

## P7: scripting delivered, extensions still scheduled

The owner scheduled general scripting ([ADR-0008](decisions/README.md)) and the
general extension model ([ADR-0013](decisions/0013-defer-general-extension-model.md))
for P7 on 2026-09-10, moving them from "deferred indefinitely" to "scheduled".
ADR-0008 is now delivered. **ADR-0013 is what remains of P7**: its bounded
custom-view design is accepted and implementation is in progress. Opening a file
still grants no execution authority.

W-007 now has an accepted direction and a staged
[custom-view extension plan](design/custom-view-extensions-plan.md): a read-only
dependency graph over existing records, with package isolation, explicit consent
and permanent Studio access. Disposable boundary experiments and an accepted
extension ADR precede production implementation. The first disposable WebView2
probe contained hangs but exposed a WebRTC network path outside CSP/request
interception. The owner selected OS enforcement; its subsequent AppContainer/Job
probe blocked the tested native/WebRTC IPv4 loopback paths and contained process
termination. The remaining P1 matrix is incomplete;
see the [OS experiment](../prototypes/custom-views/OS-BOUNDARY.md) for exact limits.
The owner subsequently accepted the architecture on 2026-09-20. The
[Engine foundation and durable view definitions](contracts/custom-views.md) are
implemented, with canonical MCP authoring and minimum host 1.29.0. The production
helper and private IPC now pass contained-browser round-trip, loop termination,
silent revocation and ready-timeout tests. The device cache and native consent
service now cover exact offline transfer, active package retention, raw-copy consent
isolation and stale-review refusal. Native package/consent controls are implemented;
the manager's geometry/themes and offline graph interactions now have runtime lanes.
The native graph window and file-owned lifecycle are implemented. The isolated
native journey now covers consent, Use entry, a two-record dependency, both themes
at 1024×720, a saved Studio edit and F6 focus return. Native package import/export,
missing/disabled states, revocation on reopen and Studio editing after helper
termination are also measured. High-DPI toolbar reflow, broader containment checks and final release qualification
remain in progress. Acceptance does not erase the unrun checks above.

**ADR-0008 is accepted for bounded calculations and local actions, and its
implementation plan has been carried out.** Stages S1–S9 are in: calculated fields,
reusable functions, explicit actions and automatic triggers; this device's consent
before any of them run; reviewed proposals promoted by exact replay; the whole
user-facing surface; MCP authoring and causal compensation; and measurements on
fixtures ten thousand records large. What each ADR obligation rests on is recorded in
[calculations-and-actions.md](contracts/calculations-and-actions.md).

**What it does.** A calculated field is stored as a definition, never as an editable
column, and reads as itself wherever it appears — a value, `Not set`, `Calculating…`
or `Cannot calculate` with the reason — in Studio's record page, as a read-only
column in its table, and on a custom surface wherever a stored field binds. What a
surface may not do is sort, filter, group or total by one; each refuses by name
rather than quietly ordering the loaded page. Expressions run through a bounded NCalc
adapter: integer division stays in the decimal domain, the function set is closed,
and finite ceilings bound parser input, recursion, work and generated changes with
one budget for a whole causal transaction.

An edit and every automatic action it triggers commit together or leave the file
unchanged. A file that carries a trigger cannot be edited until this device has
approved exactly that behaviour, in exactly that file, and is still approving it at
the commit boundary; approvals live in device state under `%LocalAppData%\Nendo`,
never in a `.nendo` file, and the store fails closed. A reviewed proposal freezes
what its actions did, together with the record versions and data revision those
results depended on, and promotes by replaying exactly that.

An agent authors all of it through ordinary proposals, against a catalogue published
at `nendo://application/vocabulary` and generated from the tables the Engine
enforces. Acceptance and consent stay host actions with no MCP equivalent. Every
write route — field edit, form, create, command, delete, bounded paste, proposal —
fires the same triggers under one budget, and compensating a causal revision reverses
the edit and everything its actions wrote without running them again.

`tools/Journey-Behaviour.mjs` drives the user-facing half through the real
WinUI/WebView2 host against the live DOM, with isolated file and device-state roots.

**Stage S9 is measured.** On the 1,000 and 10,000-record benchmark fixtures, a
bounded page and a save that fires a chain both stay near their small-file cost —
about 2 ms and 12 ms — because each reads a bounded set. A whole-file snapshot does
not: it evaluates every record's calculations, so it scales linearly, 49 ms to 474 ms
cold. That is the shape to design against, and it is published with its limits in
[calculations-and-actions.md](contracts/calculations-and-actions.md). Cancellation is
observed and joined in about a millisecond.

**P7 is delivered.** The owner ran the keyboard, focus and screen-reader lane on
2026-09-13 and reported all four checks passing, and ran the clean-user installer
lane — the one `Test-NendoInstaller.ps1` refuses on a machine where Nendo is already
installed — which passed, covering the NSIS bootstrapper, payload extraction and the
HKCU uninstall registration. (The Start Menu shortcut moved out of the NSIS script on
2026-09-19, so that part of the run now belongs to the setup lane, which runs every
build.) Both are recorded as reported results rather than measurements taken here;
the scripts for repeating them are in
[calculations-and-actions.md](contracts/calculations-and-actions.md) and
`tools/Test-NendoInstaller.ps1`.

The [ADR-0008 plan](design/adr-0008-implementation-plan.md) that this was built from
is kept as the transfer it was, beside the execution semantics and reconstructed
regression cases. Where it and the shipped code disagree, the contract is current.

Keep declarative capabilities for the cases they already cover. `summaryTile`
and `commandStep` were both answers to "we need logic
here" that stayed declarative and stayed exact, and the 2026-09-12 widening added
three more: a per-column total is one stored choice predicate, a tab is a titled
section, and a calendar is a stored Date on a month grid. None of them stores
layout, an expression or executable logic. The accepted bounded expression model
adds reusable calculations and atomic local triggers without changing those
declarative surface meanings or creating a general execution escape.

## Agent authoring ergonomics

The vision depends on agents authoring successfully on the first or second
attempt. Two 2026-09-11 blackbox reviews each built a complete CRM from an empty
file through MCP alone and recorded what it cost. The second one succeeded — four
record types, 55 records, ten compiled surfaces, zero data corruption — and its
thirteen findings are answered in the same
[MCP interface contract](contracts/mcp-interface.md) and
[semantic surfaces contract](contracts/semantic-surfaces.md) that describe what
replaced them. Twelve are closed as asked; one is answered differently on
purpose, and is below. Two deserve naming, because they are the shape of this
class of problem:

- **The read path existed and was not discoverable.** `resources/list` returns
  only the parameterless resources, so the records resource — a URI template —
  appeared in none of the seven entries a client listed. The review concluded the
  data API was write-only and opened the SQLite file directly to check that a
  button had done what the button said. Everything it needed was already served;
  nothing said so. `describe` now names every resource URI, templates included.
- **A refusal named the symptom, not the cause.** Writing to a record type whose
  creating proposal was still awaiting acceptance returned
  `NENDO_ENTITY_NOT_FOUND`, which reads as a bad identifier. The host knew about
  the outstanding proposal the whole time.

A third review, on 2026-09-13, built a seed library from an empty file with
Claude's native MCP tools and spent most of its effort on the calculation layer.
Numbers, the semantic compiler's refusals and the approval boundary were "exactly
as advertised"; every expensive surprise lived in the argument layer, where four
unrelated causes read `NENDO_INVALID_REQUEST: The request arguments are invalid.`
Its record is [`reviews/2026-09-13-blackbox-behaviour-review.md`](reviews/2026-09-13-blackbox-behaviour-review.md),
with what each finding became. Two deserve naming beside the earlier two:

- **The engine had written the message, and the boundary threw it away.** The key
  a sum needs, the field a create was missing, the choices a value was not one of —
  each was in a `NendoValidationException` the tool boundary replaced with one
  constant sentence. The reviewer guessed the sum's key three times, abandoned the
  calculation, and filed the choice path as broken; the value they sent had its
  quote characters inside it, which the message would have shown. Refusals now pass
  the engine's sentence through under one audited rule, and a body that does not fit
  is refused where it is sent, before it can cost a draft.
- **A validate that threw left the draft frozen.** The documented remedy, `amend`,
  was the one call refused. Ninety operations for one guessed key.

A fourth round, on 2026-09-14, drove the installed host with a scripted MCP client
rather than a conversation: 223 recorded calls over every tool and resource, with
every refusal the host is meant to make, made. Its six findings were all about
what the host said rather than what it did. Its record is
[`reviews/2026-09-14-installed-host-mcp-review.md`](reviews/2026-09-14-installed-host-mcp-review.md);
each finding is answered in the MCP interface and calculations contracts, and two
deserve naming:

- **The binder failed before Nendo could speak.** A page limit that was not an
  integer was rejected inside the SDK and reached the client as a bare internal
  error with no code, while `0` and `101` were refused by name one line further
  in. Template variables now arrive as text and every malformed limit is the same
  refusal as an out-of-range one.
- **A calculated field was refused as one that did not exist.** The schema read
  listed it under `derivedFields` and the records read carried its result; the
  write path looked only at stored columns. The refusal now says calculated, names
  the calculation, and reaches a form save and a create as well as a single edit.

The other four: a validated change set answered `add_operations` and `amend` as
missing rather than frozen; a receipt and a replay could not name what an action
changed, although the attribution table held it; an action whose target reference
was empty selected nothing and no published text said that was the rule; and five
tool-argument nodes advertised no type at all.

What remains open:

- **Consent is shown where acceptance happens, but is not in the proposal queue.**
  The approval panel and the *Approval needed* pill now appear on the Agent page the
  moment a proposal that adds actions is accepted. The consent itself is still a
  separate act from accepting, and the proposal list does not carry it; folding
  approval into the acceptance dialog is a change to what accepting means.
- **An assignment bound to the wrong record installs cleanly.** The step that
  binds the event record while writing to the referenced one is the mistake the
  published example warns about. It now fails the save naming the action, step and
  field; refusing it at install needs the action's target entity, which only the
  trigger knows, so it is a validation over the pair.
- **A sum totals a required field only.** A member with no value is an error, and
  installation refuses a `Sum` over an optional field rather than promise a total
  the first empty value breaks. A `Coalesce` or a per-member default would widen
  it, and needs its own semantics.
- **Validation reports one error per pass.** Independent diagnostics should be
  returned together; today fixing one surfaces the next, costing a round trip
  each time. This is harder than it looks: clone validation runs inside one
  SQLite transaction, and the first refusal poisons it, so collecting a second
  diagnostic means re-running the change set rather than continuing. A failed
  validation now leaves the draft open and amendable, which removes the rebuild
  cost but not the round trip.
- **Concurrent proposals are announced, not rebased.** `change_set.begin` now
  reports how many other change sets are open and names the captured revision,
  `nendo://application/proposals` lists what is already pending, and a staleness
  conflict still surfaces at validate. Automatically rebasing a UI-lane proposal
  onto a newer revision would remove the conflict entirely, but promotion replays
  validated operations against the active file by an accepted architecture
  invariant ([ADR-0007](decisions/0007-proposal-clone-validation-and-replay-promotion.md)),
  and rebasing changes what a conflict means. It needs its own ADR. Inline node
  properties removed most of the pressure by cutting what a build spends — a
  complete application's screens now fit one change set and one approval — but a
  large enough application still serializes.
- **A reconnecting agent can see a pending proposal but not act on it.**
  `nendo://application/proposals` lists what is waiting. Preview and reject still
  require the session that created the change set, and a reconnect mints a new
  application handle, so an agent that loses its session can read that a proposal
  exists and then only ask the person to accept or reject it. Binding a proposal
  to something more durable than a session is an authority change, not a
  projection change.
- **A proposal's minimum-host-version raise is shown, not chosen.** The diff now
  carries `raiseMinimumHostVersion` as its own irreversible line, so nobody
  approves a compatibility change they were never shown. There is still no way to
  author a change set that deliberately stays within an older host's version, and
  no statement of which Nendo versions are in use anywhere to check against.
- **The discovery advertisement names the file, not its path.** The review asked
  for `filePath` and `displayName` so an agent could prove which file it was
  connected to. `displayName` is there — the file's name, as the window title
  shows it — and answers "which of the two open windows is this". `filePath` is
  not, and will not be without an accepted ADR: agents never receiving a database
  path is a product axiom ([vision.md](vision.md)), and the advertisement is a
  file an agent reads. A caller that hands a path into that field has it reduced
  to its last segment.
- **A closed window is no longer a closed file.** The close button minimises to the
  notification area, so the interval in which the item below applies now extends past
  the point a person would say they had shut Nendo. The tray menu shows the live
  access mode and offers to end it, and the first close on a device says where the
  window went; neither is a credential. Somebody who wants the old behaviour can
  toggle it from the same menu.
- **At Unattended, nobody reads the change before the file takes it.** The fifth access
  level lets an agent accept its own validated proposals and lets the host grant this
  device's consent for the automatic actions they install, so a shape change and running
  code can both reach the active file unreviewed ([ADR-0009](decisions/0009-local-mcp-transport-authority-and-change-sets.md),
  2026-09-22 amendment). This is chosen, for building a new file to order, where the
  review it removes was not protecting anything yet. It is bounded by three things and no
  more: it is off by default and resets to off when the file session ends, it is confirmed
  before it takes effect, and every acceptance is an ordinary History revision. What is
  **not** there is any record that a change went in unreviewed — History says what was
  done, not that nobody looked — and nothing warns a person who leaves the level on.
  Neither is built.
- **An import is not atomic and says so, which is not the same as being resumable well.**
  `nendo.data.import_records` commits fifty rows a revision, so a refusal partway leaves
  the batches before it committed. The answer states the count, and an exact retry with
  the same key replays what committed rather than duplicating it. But the caller has no
  way to ask *which* row was refused other than by reading the message, and no way to skip
  it and continue: the remedy is to correct the payload and send the whole call again.
- **Anything on this computer can reach an open file.** There is no credential
  ([ADR-0009](decisions/0009-local-mcp-transport-authority-and-change-sets.md)):
  while a file is open with access on, every process under every account on the
  machine connects at that access level. This is chosen, for iteration speed on
  a single-user machine, and it is the wrong posture for a shared one. The route
  back is a peer-process user check; it is not built.
- **A handshake client has no name in Recent activity.** The host is stateless
  and a client on the `initialize` handshake sends its name only in that
  request, so its later activity is labelled "Local agent". A 2026-07-28 client
  is named on every request. Carrying the handshake name forward would need a
  session, which the transport deliberately does not have.

## Left open by the 2026-09-12 vocabulary widening

The amendment is delivered ([ADR-0004](decisions/0004-versioned-semantic-ui-contract.md));
these are the limitations it deliberately leaves.

- **Eight roots per kind per entity is a product guess.** It is a bounded initial
  choice, not a measured optimum, and nothing has been observed hitting it. The
  selector wraps and scrolls at sixteen list/board choices; whether that reads
  well at eight of each is owner-reported, not instrumented.
- **A calendar is a Date field on a month.** DateTime, time zones, week and day
  scheduling, duration, recurrence and drag-to-date are all outside the
  amendment. A DateTime is refused by name rather than guessed at, because
  placing one on a month grid means choosing a time zone to group by.
- **A calendar month is read a page at a time.** The grid states how much of the
  month is loaded and offers Load more until the cursor is exhausted, which is
  honest but means a month with hundreds of entries takes several reads before a
  day can be called empty. No server-side month aggregate exists to shortcut it.
- **A rating's scale is set once.** `min` and `max` travel with the field, as every
  presentation does, and no operation changes either afterwards; widening a scale means
  a new field. The scale bounds the drawing rather than the column, so a value outside
  it is kept and stated rather than refused — which is what makes declaring a scale over
  existing values safe, and what leaves a file able to hold a number no dot can show.
- **A timeline places a record by its start date.** A span that began in an
  earlier year is on that year's spine, and the year header says so. An overlap
  query — every span that touches the year — needs an OR the closed clause set
  has not got, and a record with no end date would need two windows. The range is
  one civil year, chosen for the month headings it gives the spine, not measured.
- **Per-tile reads are bounded at four concurrent.** A board with a tile in every
  column issues one exact read per column, four at a time. The number was chosen,
  not measured; nothing has profiled a wide board on a large file.
- **Tab and surface selection are renderer state.** Which tab was open and which
  surface was selected are deliberately not stored in the `.nendo` file, so they
  do not survive closing the file. That is the intended boundary — it is not
  application meaning — but it does mean a person returns to the first tab of
  every group on reopen.

## Carried forward from the 2026-09-10 cleanup

Three things carried forward. One is closed; the other two were never blocking.

**Binary assets had no test; they have one now** (W-019, 2026-09-19).
`tools/Test-BinaryAssets.ps1` opens every tracked binary and reads the structure
the format declares about itself. Nothing is decoded and no byte is written back.

The three formats are not equally checkable, and the lane says which is which
rather than implying parity. A PNG carries a CRC over every chunk, so a single
flipped byte anywhere is caught. An ICO is as strong, because every frame of
every icon here is itself a PNG; a bitmap-framed icon is refused rather than
half-checked, since a DIB carries no checksum and the most a reader could confirm
is that plausible header bytes are present. An MP4 has no checksum at all, so a
flipped byte in its media cannot be caught: what is checked there is that the box
tree tiles at every level, that `moov` and `mdat` are both present, and that the
sample-table offsets point inside the file.

The set to check is read from what git actually stores as binary, and the lane
separately requires `.gitattributes` to declare each one. Selecting on the
declaration alone would have been a hole: it names nine extensions, so a `.webp`
or a `.woff2` would be stored as binary, skipped by every text check in the gate,
and skipped by this one too.

What it replaces is worth recording, because the original suggestion here was a
hash check over `src/**/Assets/*` and that would have been the wrong shape: a
hash needs a known-good baseline, and a baseline goes stale every time an asset
legitimately changes, so it decays into a file nobody updates. A structural read
needs no baseline at all.

The history it guards: the 2026-09-10 cleanup corrupted all eleven image assets
under `src/` — CRLF collapsed into binary data during a `git add -A` — and the
full gate passed four times without noticing, because nothing in the suite opened
an icon. It surfaced only when NSIS refused to build an installer. That exact
mutation was replayed against the new lane before it was trusted: stripping the
carriage returns out of `nendo.png` produces *"does not begin with the PNG
signature"*, and out of `AppIcon.ico` a failing CRC inside an embedded image.

**CI was removed deliberately**, not lost. It had failed 19 consecutive runs at
0s with zero jobs created, most likely an exhausted Actions allowance on a
private repo where Windows runners bill at 2× — unconfirmed, since the billing
API needs a scope the local token lacks (`gh auth refresh -s user`, then
`gh api users/<user>/settings/billing/actions`). Settle that before re-adding,
and see [architecture.md](architecture.md) for the `DOTNET_INSTALL_DIR` trap
that the old workflows encoded.

**The NSIS wrapper is unchecked, and that is now a position rather than a
backlog item.** `Test-NendoInstaller.ps1` is the only lane covering the
bootstrapper, payload extraction, HKCU uninstall registration, the Start Menu
shortcut and the real `Uninstall.exe` -- and the only one asserting that
uninstalling leaves a person's `.nendo` files untouched. It runs only under a
clean Windows user, because it ends by uninstalling from the real per-user
location. `Test-NendoSetupIsolated.ps1` covers the setup logic against a
task-owned root and runs on every build; it never invokes the wrapper.

Accepted as a limitation on 2026-09-19 (W-021 dropped). Everyone who runs this
installer built it, and every in-place upgrade exercises the wrapper without
asserting anything about it. The condition, not the schedule, is what matters:
if Nendo is ever handed to somebody who did not build it, run this lane under a
throwaway user first. It is also the only way `installer-status.json` gets its
`nsisWrapper` entry filled in, so that field reading "not run for this build" is
the honest steady state here and says nothing about the build.

## The public website

`site/` is an Astro project deployed to
[thomasrohde.github.io/nendo](https://thomasrohde.github.io/nendo/) by the one CI
lane this repository has ([ADR-0018](decisions/0018-public-website-and-deployment-lane.md)).
It carries five authored pages -- concept, how it works, using Nendo, status --
and renders `docs/` from the Markdown rather than copying it, so a rendered
document cannot drift from its source. Screenshots are captured from a running
host by `tools/Capture-SiteScreenshots.ps1` against
`workspace/Nendo Station.nendo` and committed, because the deployment runs on
Linux and cannot take them.

`site/scripts/check-links.mjs` runs at the end of every build and fails it if any
internal reference in the built site -- a page, a file beside it, or an anchor --
does not resolve. It was written after the rewriter sent a link to
`docs/design/adr-0008-dependencies.lock.json` at a copied asset that is never
copied, and it was falsified against that defect on 2026-09-22:

```text
Checked 2810 internal reference(s) across 47 page(s).
1 broken internal reference(s):
  /docs/decisions/0008-general-scripting-and-capability-isolation/index.html ->
  /nendo/repo-docs/design/adr-0008-dependencies.lock.json -- no such page or file in the build
```

Falsifying it took clearing both `site/.astro` and `site/node_modules/.astro`:
the content layer caches a rendered document by its source digest, so with only
the first cleared the build passed against the defect that was back in the code.
A CI checkout has neither cache, so that trap is local only.

What is not checked about it: nothing asserts that the five authored pages still
match this roadmap or the vision after either changes, no external link is
followed, and no accessibility or first-read evaluation has been run on it. The
same standing risk below applies to it doubly -- the person who wrote the copy is
the person who built the product.

## The standing risk

Everyone who has used Nendo built it. Every usability, scaling and accessibility
result on record is owner-reported, which is honest evidence about the product
but says nothing about whether it is legible to someone arriving cold.

This is validated by using it, not by a study. The
[Idea Garden journey](../fixtures/idea-garden/journey.md) is the end-to-end walk
through the core loop and is the right thing to hand someone; what it cannot
tell you is whether they get there without being told. Treat a confused first
run as a finding, not a support incident.
