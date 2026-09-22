# Roadmap

This file describes where Nendo goes next and what is not yet true. It replaces
the running milestone changelog. [architecture.md](architecture.md) describes
delivered work, and this file does not discuss that work again.

## Development planning

**Nendo Development is the primary work planner.** [dogfooding.md](dogfooding.md)
describes its setup status, connection, record types and agent handoff. Use its
Now / Next / Later horizons, work statuses, Findings and Checks for detailed
priorities and execution evidence. This roadmap keeps product direction,
qualification limits and source context. Accepted ADRs and contracts keep
architecture authority. A backlog import is not acceptance of a future design.

The initial inventory covers the unfinished work and intentional limitations
below, the linked surface plan and the remaining review findings. The inventory
does not import delivered slices or resolved historical defects as new
unfinished work.

## State

The MVP loop works end to end on Windows x64. An external agent connects over
local MCP, inspects a real installed application, and authors and reshapes it.
The owner then reviews a semantic diff and accepts. Four reference applications
(Idea Garden, Decision Log, the Axiom Register and Nendo Station) test the
claim from different shapes. The last two were built from an empty file through
the MCP interface alone. [Nendo Station](nendo-station.md) carries every kind of
screen that this host compiles, plus a custom view of its own.

Delivery is a local, unsigned, per-user Windows x64 install.

## Not qualified

Each area below is a gap. Do not read a gap as a feature.

| Area | Status |
| --- | --- |
| Public distribution, code signing, ARM64 | Not started |
| Clean-machine install | Owner-reported pass on a machine that is now used for all other work. No automated assertion exists, and none is planned. Accepted limitation 2026-09-19 (W-027 dropped): a disposable environment costs about an afternoon of work, and it gives evidence only about a path that only the owner uses |
| Installed startup on large datasets | Accepted measured exception. It is not a pass. One open inspects the file twice. The layout signature scan is the largest single cost |
| Human usability and accessibility | Owner-reported. The owner ran the Windows 100%/200% scaling, keyboard/focus and screen-reader checks. No lane instruments them. Accepted limitation 2026-09-20 (W-028 dropped): instrumentation of these checks is not valuable for this prototype |
| Cloud sync and live-root writes | Unsupported. The host warns about known sync paths. There is no sync-safety claim |
| Physical power loss | Not qualified |
| Broad MCP client parity | Not promised. Claude Code and Codex both connect with only the address, and opt-in installed-client lanes check this. That is not a general parity claim |
| Account boundary on a shared machine | Removed with the credential ([ADR-0009](decisions/0009-local-mcp-transport-authority-and-change-sets.md)). This was chosen for iteration speed on a single-user machine. It is not a gap that work is closing |
| Cross-platform | Windows only |
| The notification area and Windows notifications | Owner-reported. `Review-ShellRuntime.ps1` checks three things: close hides the window, the process and its file survive, and the exit pin exits. A script cannot observe the icon, its menu or the notifications, and no lane instruments them. By default, Windows puts a new tray icon in the overflow. No test checks whether a first-time person finds their window again |
| What the Windows shell draws | Owner-reported. The line between measured and not measured is stated precisely here. Measured, item by item: the registry writes that setup makes and removes; the shell identity, read back from the running window and from the notification registration that Windows filed under it; the Jump List file that Windows stored, and the fact that it names the open file; and the `-new` command line, run by hand against both an empty placeholder and an existing file (agent-observed, not a lane). Not measured, and not reachable from a script: Explorer draws the document icon; the taskbar paints the overlay badge or progress; the menu appears on right-click; a file dragged from Explorer arrives; the Jump List is rebuilt when the open file changes. `SetOverlayIcon` and `SetProgressState` report nothing back, and nothing can read them, so the call is unobserved as well as the paint. WebView2 itself refuses a page-made file, and that refusal is measured |

## Next: surfaces and charts

The vision admitted charts and dashboards on 2026-09-14.
[design/surfaces-and-charts-plan.md](design/surfaces-and-charts-plan.md) states
what that means, which surfaces it could add and the order to build them. The
first slice is a foundation: a colour tone on choice options, an exact grouped
aggregate and one renderer chart kit. The ADR-0004 amendment was accepted on
2026-09-14.

The slices stand as follows:

- S0 is delivered at minimum host 1.19.0. It adds a tone on every choice option
  and a record-page header.
- S1 is delivered at 1.20.0, built from
  [design/s1-first-charts-plan.md](design/s1-first-charts-plan.md). It adds the
  exact grouped aggregate, a breakdown chart and a progress ring on lists, boards
  and record pages, and drill-through into a narrowed list.
- S3, the timeline, was requested before S2. It is delivered at 1.21.0, built
  from [design/s3-timeline-plan.md](design/s3-timeline-plan.md). It places records
  on a spine by a Date field, draws an optional end date as a span, and has an
  undated view.
- S2 is delivered at 1.22.0, built from
  [design/s2-gallery-and-rating-plan.md](design/s2-gallery-and-rating-plan.md). It
  adds a gallery of cards over a list's window, and a rating drawn as dots on a
  closed scale.
- S4, the overview page, is delivered at 1.23.0, built from
  [design/s4-overview-plan.md](design/s4-overview-plan.md). The overview page is
  one root that belongs to the file and not to a record type. It has a recent
  list and a range tile.
- S5, the trend chart and the activity grid, is delivered at 1.25.0. These are
  the first groupings whose groups are generated from a resolved range and not
  read from a field.
- S6, the matrix and the ranked list, is delivered at 1.26.0. The matrix is a
  grid of two crossed choice fields, and one read answers it. An empty cell is
  therefore a cell, and each cell states an exact number beside the cards it
  holds.
- S7, a board grouped by a reference, is next.

## P7: scripting delivered, extensions still scheduled

On 2026-09-10, the owner scheduled general scripting
([ADR-0008](decisions/README.md)) and the general extension model
([ADR-0013](decisions/0013-defer-general-extension-model.md)) for P7. This moved
them from "deferred indefinitely" to "scheduled". ADR-0008 is now delivered.
**ADR-0013 is what remains of P7**: its bounded custom-view design is accepted,
and implementation is in progress. Opening a file still grants no execution
authority.

W-007 now has an accepted direction and a staged
[custom-view extension plan](design/custom-view-extensions-plan.md). The
direction is a read-only dependency graph over existing records, with package
isolation, explicit consent and permanent Studio access. Disposable boundary
experiments and an accepted extension ADR come before production implementation.
The first disposable WebView2 probe contained hangs, but it exposed a WebRTC
network path outside CSP/request interception. The owner selected OS
enforcement. The next AppContainer/Job probe blocked the tested native/WebRTC
IPv4 loopback paths and contained process termination.

The remaining P1 matrix is incomplete. For the exact limits, see the
[OS experiment](../prototypes/custom-views/OS-BOUNDARY.md). The owner then
accepted the architecture on 2026-09-20. The
[Engine foundation and durable view definitions](contracts/custom-views.md) are
implemented, with canonical MCP authoring and minimum host 1.29.0. The
production helper and private IPC now pass contained-browser round-trip, loop
termination, silent revocation and ready-timeout tests. The device cache and
native consent service now cover exact offline transfer, active package
retention, raw-copy consent isolation and stale-review refusal.

Native package/consent controls are implemented. The manager's geometry/themes
and offline graph interactions now have runtime lanes. The native graph window
and file-owned lifecycle are implemented. The isolated native journey now covers
consent, Use entry, a two-record dependency, both themes at 1024×720, a saved
Studio edit and F6 focus return. Native package import/export,
missing/disabled states, revocation on reopen and Studio editing after helper
termination are also measured. High-DPI toolbar reflow, broader containment
checks and final release qualification remain in progress. Acceptance does not
erase the unrun checks above.

**ADR-0008 is accepted for bounded calculations and local actions, and its
implementation plan is complete.** Stages S1–S9 are delivered:

- calculated fields, reusable functions, explicit actions and automatic
  triggers;
- this device's consent before any of them run;
- reviewed proposals promoted by exact replay;
- the whole user-facing surface;
- MCP authoring and causal compensation;
- measurements on fixtures ten thousand records large.

[calculations-and-actions.md](contracts/calculations-and-actions.md) records
what each ADR obligation rests on.

**What it does.** A calculated field is stored as a definition, never as an
editable column. It shows its own state wherever it appears: a value,
`Not set`, `Calculating…` or `Cannot calculate` with the reason. It appears in
Studio's record page, as a read-only column in its table, and on a custom
surface wherever a stored field binds. A surface may not sort, filter, group or
total by a calculated field. Each of these refuses by name; it does not silently
order the loaded page. Expressions run through a bounded NCalc adapter: integer
division stays in the decimal domain, the function set is closed, and finite
ceilings bound parser input, recursion, work and generated changes, with one
budget for a whole causal transaction.

An edit and every automatic action that it triggers commit together, or the
file stays unchanged. If a file carries a trigger, nobody can edit it until this
device approves exactly that behaviour, in exactly that file. The device must
also still approve it at the commit boundary. Approvals live in device state
under `%LocalAppData%\Nendo`, never in a `.nendo` file, and the store fails
closed. A reviewed proposal freezes what its actions did, together with the
record versions and data revision that those results depended on. Promotion
replays exactly that.

An agent authors all of it through ordinary proposals. The agent uses a
catalogue that is published at `nendo://application/vocabulary` and generated
from the tables that the Engine enforces. Acceptance and consent stay host
actions with no MCP equivalent. Every write route fires the same triggers under
one budget: field edit, form, create, command, delete, bounded paste and
proposal. Compensation of a causal revision reverses the edit and everything
its actions wrote. It does not run the actions again.

`tools/Journey-Behaviour.mjs` drives the user-facing half through the real
WinUI/WebView2 host against the live DOM, with isolated file and device-state
roots.

**Stage S9 is measured.** On the 1,000 and 10,000-record benchmark fixtures, a
bounded page and a save that fires a chain both stay near their small-file cost
(about 2 ms and 12 ms), because each reads a bounded set. A whole-file snapshot
does not stay near its small-file cost. It evaluates the calculations of every
record, so it scales linearly: 49 ms to 474 ms cold. Design against that
scaling. [calculations-and-actions.md](contracts/calculations-and-actions.md)
publishes it with its limits. Cancellation is observed and joined in about a
millisecond.

**P7 is delivered.** The owner ran the keyboard, focus and screen-reader lane on
2026-09-13 and reported that all four checks passed. The owner also ran the
clean-user installer lane, and it passed. (`Test-NendoInstaller.ps1` refuses
that lane on a machine where Nendo is already installed.) The run covered the
NSIS bootstrapper, payload extraction and the HKCU uninstall registration. The
Start Menu shortcut moved out of the NSIS script on 2026-09-19, so that part of
the run now belongs to the setup lane, which runs on every build.

Both results are recorded as reported results, not as measurements taken here.
The scripts to repeat them are in
[calculations-and-actions.md](contracts/calculations-and-actions.md) and
`tools/Test-NendoInstaller.ps1`.

This was built from the [ADR-0008 plan](design/adr-0008-implementation-plan.md).
The plan is kept as the transfer it was, beside the execution semantics and
reconstructed regression cases. If the plan and the shipped code disagree, the
contract is current.

Keep declarative capabilities for the cases that they already cover.
`summaryTile` and `commandStep` were both answers to "we need logic here", and
both stayed declarative and exact. The 2026-09-12 widening added three more:

- A per-column total is one stored choice predicate.
- A tab is a titled section.
- A calendar is a stored Date on a month grid.

None of them stores layout, an expression or executable logic. The accepted
bounded expression model adds reusable calculations and atomic local triggers.
It does not change those declarative surface meanings, and it does not create a
general execution escape.

## Agent authoring ergonomics

The vision depends on agents that author successfully on the first or second
attempt. On 2026-09-11, two blackbox reviews each built a complete CRM from an
empty file through MCP alone. Each review recorded what the build cost. The
second review succeeded: four record types, 55 records, ten compiled surfaces
and zero data corruption.

The [MCP interface contract](contracts/mcp-interface.md) and the
[semantic surfaces contract](contracts/semantic-surfaces.md) answer its thirteen
findings and describe what replaced them. Twelve findings are closed as asked.
One has a different answer by intent, and it is listed below. Two findings show
the typical form of this class of problem:

- **The read path existed and was not discoverable.** `resources/list` returns
  only the parameterless resources. The records resource is a URI template, so
  it appeared in none of the seven entries that a client listed. The review
  concluded that the data API was write-only. It then opened the SQLite file
  directly to check that a button did what the button said. The host already
  served everything that the review needed, but nothing told the client so.
  `describe` now names every resource URI, templates included.
- **A refusal named the symptom, not the cause.** A write to a record type whose
  creating proposal still waited for acceptance returned
  `NENDO_ENTITY_NOT_FOUND`. That code reads as a bad identifier. The host knew
  about the outstanding proposal all the time.

A third review, on 2026-09-13, built a seed library from an empty file with
Claude's native MCP tools. It spent most of its effort on the calculation layer.
Numbers, the semantic compiler's refusals and the approval boundary were
"exactly as advertised". Every expensive surprise was in the argument layer,
where four unrelated causes read `NENDO_INVALID_REQUEST: The request arguments are invalid.`
Its record is [`reviews/2026-09-13-blackbox-behaviour-review.md`](reviews/2026-09-13-blackbox-behaviour-review.md),
and it states what each finding became. Two findings are named here, beside the
earlier two:

- **The engine had written the message, and the boundary threw it away.** Each
  of these was in a `NendoValidationException`: the key that a sum needs, the
  field that a create was missing, and the choices that a value was not one of.
  The tool boundary replaced each one with one constant sentence. The reviewer
  guessed the sum's key three times, abandoned the calculation, and filed the
  choice path as broken. The value that they sent had its quote characters
  inside it, and the message would have shown this. Refusals now pass the
  engine's sentence through under one audited rule. If a body does not fit, it
  is refused where it is sent, before it can cost a draft.
- **A validate that threw left the draft frozen.** The documented remedy,
  `amend`, was the one call that was refused. The cost was ninety operations for
  one guessed key.

A fourth round, on 2026-09-14, drove the installed host with a scripted MCP
client instead of a conversation. It made 223 recorded calls over every tool and
resource, and the host made every refusal that it is meant to make. All six
findings were about what the host said, not about what it did. Its record is
[`reviews/2026-09-14-installed-host-mcp-review.md`](reviews/2026-09-14-installed-host-mcp-review.md).
The MCP interface and calculations contracts answer each finding. Two findings
are named here:

- **The binder failed before Nendo could speak.** A page limit that was not an
  integer was rejected inside the SDK. It reached the client as a bare internal
  error with no code, but `0` and `101` were refused by name one line further
  in. Template variables now arrive as text, and every malformed limit gets the
  same refusal as an out-of-range limit.
- **A calculated field was refused as one that did not exist.** The schema read
  listed it under `derivedFields`, and the records read carried its result. The
  write path looked only at stored columns. The refusal now says that the field
  is calculated and names the calculation. It also reaches a form save and a
  create, as well as a single edit.

The other four findings were these:

- A validated change set answered `add_operations` and `amend` as missing, not
  as frozen.
- A receipt and a replay could not name what an action changed, although the
  attribution table held it.
- An action whose target reference was empty selected nothing, and no published
  text said that this was the rule.
- Five tool-argument nodes advertised no type at all.

What remains open:

- **Consent is shown where acceptance happens, but is not in the proposal queue.**
  When a proposal that adds actions is accepted, the approval panel and the
  *Approval needed* pill now appear on the Agent page immediately. The consent
  itself is still a separate act from acceptance, and the proposal list does not
  carry it. To fold approval into the acceptance dialog is a change to what
  acceptance means.
- **An assignment bound to the wrong record installs cleanly.** The published
  example warns about this mistake: a step binds the event record while it
  writes to the referenced record. The step now fails the save, and the failure
  names the action, step and field. A refusal at install needs the action's
  target entity, and only the trigger knows that entity. The check is therefore
  a validation over the pair.
- **A sum totals a required field only.** A member with no value is an error.
  Installation refuses a `Sum` over an optional field, because it does not
  promise a total that the first empty value breaks. A `Coalesce` or a
  per-member default would widen it, and needs its own semantics.
- **Validation reports one error per pass.** Validation should return
  independent diagnostics together. Today, when you fix one diagnostic, the next
  one appears, and each costs a round trip. The fix is harder than it looks.
  Clone validation runs inside one SQLite transaction, and the first refusal
  makes that transaction unusable. To collect a second diagnostic, the change
  set must run again; validation cannot continue. A failed validation now leaves
  the draft open and amendable. This removes the rebuild cost but not the round
  trip.
- **Concurrent proposals are announced, not rebased.** `change_set.begin` now
  reports how many other change sets are open and names the captured revision.
  `nendo://application/proposals` lists what is already pending. A staleness
  conflict still appears at validate. An automatic rebase of a UI-lane proposal
  onto a newer revision would remove the conflict completely. But by an accepted
  architecture invariant
  ([ADR-0007](decisions/0007-proposal-clone-validation-and-replay-promotion.md)),
  promotion replays validated operations against the active file, and a rebase
  changes what a conflict means. It needs its own ADR. Inline node properties
  removed most of the pressure, because they cut what a build spends: a complete
  application's screens now fit one change set and one approval. A large enough
  application still serializes.
- **A reconnecting agent can see a pending proposal but not act on it.**
  `nendo://application/proposals` lists what is waiting. Preview and reject
  still require the session that created the change set. A reconnect creates a
  new application handle. If an agent loses its session, it can read that a
  proposal exists, but it can then only ask the person to accept or reject it.
  To bind a proposal to something more durable than a session is an authority
  change, not a projection change.
- **A proposal's minimum-host-version raise is shown, not chosen.** The diff now
  carries `raiseMinimumHostVersion` as its own irreversible line, so nobody
  approves a compatibility change that they did not see. There is still no way
  to author a change set that intentionally stays within an older host's
  version. There is also no statement of which Nendo versions are in use
  anywhere to check against.
- **The discovery advertisement names the file, not its path.** The review asked
  for `filePath` and `displayName`, so that an agent can prove which file it is
  connected to. `displayName` is present. It is the file's name, as the window
  title shows it, and it answers "which of the two open windows is this".
  `filePath` is not present, and it will not be present without an accepted
  ADR. A product axiom ([vision.md](vision.md)) says that agents never receive a
  database path, and the advertisement is a file that an agent reads. If a
  caller puts a path into that field, the path is reduced to its last segment.
- **A closed window is no longer a closed file.** The close button minimises to
  the notification area. The interval in which the item below applies therefore
  continues past the point where a person would say that they shut Nendo. The
  tray menu shows the live access mode and offers to end it. The first close on
  a device tells the person where the window went. Neither is a credential. A
  person who wants the old behaviour can toggle it from the same menu.
- **At Unattended, nobody reads the change before the file takes it.** The fifth
  access level lets an agent accept its own validated proposals. It also lets
  the host grant this device's consent for the automatic actions that those
  proposals install. A shape change and running code can therefore both reach
  the active file unreviewed
  ([ADR-0009](decisions/0009-local-mcp-transport-authority-and-change-sets.md),
  2026-09-22 amendment). This is chosen for the build of a new file to order,
  where the review that it removes did not yet protect anything. Three things
  bound it, and no more:
  - It is off by default, and it resets to off when the file session ends.
  - It is confirmed before it takes effect.
  - Every acceptance is an ordinary History revision.

  What is **not** there is any record that a change went in unreviewed. History
  says what was done; it does not say that nobody looked. Also, nothing warns a
  person who leaves the level on. Neither is built.
- **An import is not atomic and says so, which is not the same as being resumable well.**
  `nendo.data.import_records` commits fifty rows per revision. If a refusal
  occurs partway, the batches before it stay committed. The answer states the
  count. An exact retry with the same key replays what committed; it does not
  duplicate it. But the caller has no way to ask *which* row was refused, except
  to read the message. The caller also has no way to skip that row and continue.
  The remedy is to correct the payload and send the whole call again.
- **Anything on this computer can reach an open file.** There is no credential
  ([ADR-0009](decisions/0009-local-mcp-transport-authority-and-change-sets.md)).
  While a file is open with access on, every process under every account on the
  machine connects at that access level. This is chosen for iteration speed on
  a single-user machine. It is the wrong posture for a shared machine. The route
  back is a peer-process user check, and it is not built.
- **A handshake client has no name in Recent activity.** The host is stateless.
  A client on the `initialize` handshake sends its name only in that request, so
  its later activity is labelled "Local agent". A 2026-07-28 client is named on
  every request. To carry the handshake name forward, the host would need a
  session. The transport does not have a session, by design.

## Left open by the 2026-09-12 vocabulary widening

The amendment is delivered
([ADR-0004](decisions/0004-versioned-semantic-ui-contract.md)). It leaves these
limitations by design.

- **Eight roots per kind per entity is a product guess.** It is a bounded
  initial choice, not a measured optimum. Nothing observed so far reaches it.
  The selector wraps and scrolls at sixteen list/board choices. Whether that
  reads well at eight of each is owner-reported, not instrumented.
- **A calendar is a Date field on a month.** DateTime, time zones, week and day
  scheduling, duration, recurrence and drag-to-date are all outside the
  amendment. A DateTime is refused by name and is not guessed at. To place one
  on a month grid, the host must choose a time zone to group by.
- **A calendar month is read a page at a time.** The grid states how much of the
  month is loaded, and it offers Load more until the cursor is exhausted. This
  is accurate, but a month with hundreds of entries takes several reads before a
  day can be called empty. No server-side month aggregate exists to make this
  shorter.
- **A rating's scale is set once.** `min` and `max` travel with the field, as
  every presentation does. No operation changes either value afterwards, so a
  wider scale needs a new field. The scale bounds the drawing and not the
  column. A value outside the scale is therefore kept and stated; it is not
  refused. This makes it safe to declare a scale over existing values. It also
  leaves a file able to hold a number that no dot can show.
- **A timeline places a record by its start date.** A span that began in an
  earlier year is on that year's spine, and the year header states this. An
  overlap query (every span that touches the year) needs an OR, and the closed
  clause set does not have one. A record with no end date would also need two
  windows. The range is one civil year. It was chosen for the month headings
  that it gives the spine, and it is not measured.
- **Per-tile reads are bounded at four concurrent.** A board with a tile in
  every column issues one exact read per column, four at a time. The number was
  chosen, not measured. Nothing has profiled a wide board on a large file.
- **Tab and surface selection are renderer state.** By design, the `.nendo`
  file does not store which tab was open or which surface was selected, so they
  do not survive when the file closes. That is the intended boundary, because
  this state is not application meaning. As a result, a person returns to the
  first tab of every group on reopen.

## Carried forward from the 2026-09-10 cleanup

Three items carried forward. One is closed. The other two were never blocking.

**Binary assets had no test; they have one now** (W-019, 2026-09-19).
`tools/Test-BinaryAssets.ps1` opens every tracked binary and reads the structure
that the format declares about itself. The lane decodes nothing and writes no
byte back.

The three formats do not allow equal checks, and the lane states which is which
instead of implying parity. A PNG carries a CRC over every chunk, so the lane
catches a single flipped byte anywhere. An ICO check is as strong, because every
frame of every icon here is itself a PNG. The lane refuses a bitmap-framed icon
and does not half-check it: a DIB carries no checksum, and a reader can confirm
at most that plausible header bytes are present. An MP4 has no checksum at all,
so the lane cannot catch a flipped byte in its media.

For an MP4, the lane checks these things:

- The box tree tiles at every level.
- `moov` and `mdat` are both present.
- The sample-table offsets point inside the file.

The lane reads the set to check from what git stores as binary. Separately, the
lane requires `.gitattributes` to declare each one. A selection on the
declaration alone would have left a gap. The declaration names nine extensions,
so git would store a `.webp` or a `.woff2` as binary. Every text check in the
gate would skip that file, and this lane would skip it too.

This lane replaces an earlier suggestion here: a hash check over
`src/**/Assets/*`. That would have been the wrong design. A hash needs a
known-good baseline, and a baseline becomes out of date every time an asset
changes legitimately. The baseline then becomes a file that nobody updates. A
structural read needs no baseline at all.

The lane guards against this history. The 2026-09-10 cleanup corrupted all
eleven image assets under `src/` (CRLF collapsed into binary data during a
`git add -A`). The full gate passed four times and did not detect it, because
nothing in the suite opened an icon. The defect appeared only when NSIS refused
to build an installer.

That exact mutation was replayed against the new lane before the lane was
trusted. If the carriage returns are removed from `nendo.png`, the lane reports
*"does not begin with the PNG signature"*. If they are removed from
`AppIcon.ico`, the lane reports a failing CRC inside an embedded image.

**CI was removed deliberately**, and it was not lost. It failed 19 consecutive
runs at 0s, with zero jobs created. The most likely cause was an exhausted
Actions allowance on a private repo, where Windows runners bill at 2×. This
cause is unconfirmed, because the billing API needs a scope that the local token
does not have (`gh auth refresh -s user`, then
`gh api users/<user>/settings/billing/actions`). Settle that before you add CI
again. See [architecture.md](architecture.md) for the `DOTNET_INSTALL_DIR` trap
that the old workflows encoded.

**The NSIS wrapper is unchecked, and that is now a position and not a backlog
item.** `Test-NendoInstaller.ps1` is the only lane that covers the bootstrapper,
payload extraction, HKCU uninstall registration, the Start Menu shortcut and
the real `Uninstall.exe`. It is also the only lane that asserts that uninstall
leaves a person's `.nendo` files untouched. It runs only under a clean Windows
user, because its last step uninstalls from the real per-user location.
`Test-NendoSetupIsolated.ps1` covers the setup logic against a task-owned root
and runs on every build. It never invokes the wrapper.

This was accepted as a limitation on 2026-09-19 (W-021 dropped). Everyone who
runs this installer built it. Every in-place upgrade exercises the wrapper, but
it asserts nothing about the wrapper. What matters is a condition, not a
schedule. If Nendo is ever handed to somebody who did not build it, run this
lane under a throwaway user first. This lane is also the only way to fill in the
`nsisWrapper` entry of `installer-status.json`. If that field reads "not run for
this build", that is the expected steady state here, and it says nothing about
the build.

## The public website

`site/` is an Astro project. The one CI lane that this repository has deploys it
to [thomasrohde.github.io/nendo](https://thomasrohde.github.io/nendo/)
([ADR-0018](decisions/0018-public-website-and-deployment-lane.md)). It carries
five authored pages (concept, how it works, using Nendo, status). It renders
`docs/` from the Markdown and does not copy it, so a rendered document cannot
drift from its source. `tools/Capture-SiteScreenshots.ps1` captures the
screenshots from a running host against `workspace/Nendo Station.nendo`. The
screenshots are committed, because the deployment runs on Linux and cannot take
them.

`site/scripts/check-links.mjs` runs at the end of every build. It fails the
build if any internal reference in the built site does not resolve. An internal
reference is a page, a file beside a page, or an anchor. The script was written
after the rewriter sent a link to `docs/design/adr-0008-dependencies.lock.json`
to a copied asset that is never copied. It was falsified against that defect on
2026-09-22:

```text
Checked 2810 internal reference(s) across 47 page(s).
1 broken internal reference(s):
  /docs/decisions/0008-general-scripting-and-capability-isolation/index.html ->
  /nendo/repo-docs/design/adr-0008-dependencies.lock.json -- no such page or file in the build
```

To falsify it, both `site/.astro` and `site/node_modules/.astro` had to be
cleared. The content layer caches a rendered document by its source digest. With
only the first cleared, the build passed, although the defect was back in the
code. A CI checkout has neither cache, so that trap is local only.

These things about the site are not checked:

- Nothing asserts that the five authored pages still match this roadmap or the
  vision after either one changes.
- No check follows an external link.
- No accessibility or first-read evaluation was run on it.

The standing risk below applies to the site even more strongly: the person who
wrote the copy is the person who built the product.

## The standing risk

Everyone who used Nendo built it. Every usability, scaling and accessibility
result on record is owner-reported. That is valid evidence about the product,
but it says nothing about whether the product is legible to a person who
arrives with no prior knowledge.

This is validated by use, not by a study. The
[Idea Garden journey](../fixtures/idea-garden/journey.md) is the end-to-end walk
through the core loop, and it is the correct document to give to a new person.
It cannot tell you whether they get there without help. Treat a confused first
run as a finding, not as a support incident.
