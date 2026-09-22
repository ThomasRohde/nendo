# Custom-view execution boundary

Authority: [ADR-0013](../decisions/0013-defer-general-extension-model.md). The
owner accepted it on 2026-09-20. Acceptance of the architecture authorizes
implementation. It does not change pending release checks into passes.

This contract states what the host guarantees and what it refuses. To write a
package against it, read [authoring a custom view](../custom-view-authoring.md).
That document gives the manifest, the message contract and the authoring steps in
one place.

## Implemented Engine foundation

`NendoExtensionViewSession` is a closed host-side protocol state machine. It is
not a transport or a renderer. It has no generic dispatch, filesystem, process,
network, write or navigation operations. A desktop transport must authenticate
its OS peer before it submits frames. Session correlation is a random nonce. It is
not peer authentication or an edit lease.

The host supplies exact device consent for application, instance, view, package
digest, binding digest and protocol version. The host checks revocation
generations before and after the grant query. If the authority is denied, changed
or unreadable, the session closes. Reapproval cannot reopen an old closed session.

Version 1 accepts only `ready`, `selectRecord` and `reportError`. It accepts them
only with exact keys and types, no duplicate keys, a maximum JSON depth of 8 and
strict UTF-8. Frames above 64 KiB are refused before parsing. All attempts count
toward a rolling limit of 60 messages/second. Flooding closes the session.

`ready` must arrive before five seconds. The desktop transport also enforces a
five-second ready timeout and kills a silent renderer. Report errors have two
closed codes and bounded text. Renderer text is never a command or a telemetry
upload.

Selection is limited to a node in the current projection. When a projection is
replaced, its generation increments and the selection clears. Queued messages from
an old generation are refused. Host UI obtains a selection only with the current
grant and the exact source change sequence. It must then recheck that the record
exists, through typed services. A selection message on its own never causes
navigation or a write.

`NendoExtensionFrameCodec` supplies a four-byte little-endian length prefix with
allocation bounds, exact reads, cancellation and refusal of truncated frames. It
does not authenticate peers, set read deadlines or serialize multiple writers.
Those obligations remain with the transport owner. The desktop helper transport
below supplies them.

## Contained desktop transport

`DesktopExtensionProcess` stages a private helper, immutable validated assets and
separate writable browser state for one launch. It creates a zero-capability
AppContainer profile and a Job. The Job has kill-on-close, 512 MiB aggregate
memory, 32 processes and a 20% CPU hard cap. The process reads the Job limits back
and creates the helper suspended. It then assigns the Job, and it checks the exact
AppContainer SID and Job membership before it resumes the helper. If enforcement
is missing, startup is refused. Studio and the application services remain in the
host process, outside that tree.

Two anonymous pipes are the entire IPC surface. The native
[process attribute handle list](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
restricts inheritance to those two client handles. Standard handles and the host
environment are not inherited. The helper clears inheritance before it starts
WebView2.

The parent checks the native report against its launched process, the window
owner and the Job/AppContainer membership of the browser processes. It pins
process handles and does not trust reusable PIDs. Page messages are always
wrapped as bounded bytes and cannot impersonate that native report. Output is
serialized, and the helper queue holds at most 16 frames. The closed Engine
session validates page messages.

`Nendo.ExtensionHost` contains only WebView2 and a linked copy of the frame codec.
It has no Engine, MCP or SQLite assembly reference. It refuses an uncontained
launch before it creates a window. Host objects, permissions, downloads, pop-ups,
frames, later navigation, developer tools and external resources are disabled.
Validated local assets receive CSP and content-type headers. CSP is defence in
depth. The AppContainer is the network and OS authority boundary.

The clipboard is the one measured exception to that boundary. A zero-capability
AppContainer page that receives a real pointer click can read the session
clipboard and overwrite it (OS prototype clipboard lane, 2026-09-20). For this
reason, the helper denies the clipboard-read permission. Before any page script
runs in any document, the helper also seals `navigator.clipboard` to undefined. It
also makes `document.execCommand` refuse `copy`, `cut` and `paste`.

This is a browser-layer policy, so the measurement comes from outside the page. A
production test places a sentinel on the system clipboard and delivers a real
click to the helper window. The test requires that the sentinel is unchanged while
the page reports every entry point as refused. The policy does not affect a
person's own Ctrl+C on visible text.

Startup has a bound of 30 seconds. A five-second ready handshake follows. Consent
is checked before resume, after native bootstrap and every 100 ms while the view
runs, also when the page is silent. Stop closes the Job and the session. Disposal
waits for the observed process tree and removes the task-owned profile and scratch
files. It reports cleanup that remains pending. There is no weaker in-process
fallback.

The parent associates a private completion port before it adds any process to the
Job. It verifies a 480 MiB memory-pressure notification below the unchanged
512 MiB hard cap. On pressure, memory-limit or active-process-limit events, it
closes the Job and the session. Loss of the monitor also fails closed. The helper
does not inherit the port. This avoids a silent view that stays alive after an
allocation is refused.

The separate notification limit is necessary because the delivery of ordinary
hard-limit events is not guaranteed. The delivery of notification-limit events is
guaranteed. See Microsoft's [Job completion-port contract](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_associate_completion_port)
and [notification-limit structure](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_notification_limit_information).

The current Desktop tests launch the real helper and browser. They cover
round-trip selection, a kill within two seconds during an infinite JavaScript
loop, silent revocation, the missing-ready timeout and refusal outside
containment. When the security capabilities attribute was removed, the result was
`The suspended helper did not match its
AppContainer and Job identity.` before the helper resumed. The source was restored
and the passing qualification was repeated. These tests do not yet measure the
broader IPv6/DNS/external-network or breakaway matrix.

A bounded browser workload attempts 640 MiB of retained allocations. It first
reports that it began. The pressure test measures the fail-closed session and the
cleanup of the observed process tree. Before the fix, the helper stayed silent
until `System.TimeoutException: The operation has
timed out.` The pressure watcher makes this case pass. CPU-cap throughput and
other pressure workloads remain separate checks.

## Packages

`NendoExtensionViewPackage.Validate` accepts at most 10 MiB of archive bytes,
30 MiB expanded and 200 entries, including the manifest. It checks the caller's
exact archive digest, and the byte length and SHA-256 of every listed asset. It
reads all entries within bounds. It extracts nothing and executes nothing. Asset
getters return copies. Validation does not grant installation or device consent.

The manifest has a closed version-1 shape. It requires exactly the `projection.read`
and `record.select` capabilities. It declares a namespaced package ID, a version,
a protocol version, an HTML entry point, a license and an exact asset inventory. HTML/CSS/JavaScript
assets and text license assets are allowed. The following are refused: unknown
entries/properties, native payloads, invalid UTF-8, duplicate/case-colliding
paths, traversal, absolute paths, alternate streams, reserved Windows names, links
and reparse points.

`DesktopExtensionPackageStore` keeps at most 256 content-addressed `.nendoview`
archives in device settings, outside the file. Inspection is read-only. Explicit
installation freezes and validates bounded bytes before it creates cache state.
It flushes a private staging file and activates the package by a same-volume
rename. Interrupted staging files are not packages. Pins coexist: the installation
of a new version does not replace the previous one.

An explicit reinstall can repair a corrupt copy of the same pin. Every acquire
validates the archive and the exact package ID/version again. The open lease
denies write/delete sharing across host processes. This prevents uninstall or
replacement while a view owns that package. Export returns the exact original
archive bytes and keeps the pin for offline transfer. Unknown files are not
cleanup targets.

File → Custom views now opens native package management. Installation and export
paths come from native pickers. The host forwards no package path or approval flag
that the Workbench supplies to these operations.

## Device consent and native review

`DesktopExtensionGrantStore` stores bounded, versioned JSON outside `.nendo`. It
keys the JSON by the native physical file identity and the exact Engine grant. For
this reason, a raw copy that keeps the application/instance IDs receives no
approval. No permission follows from package installation or definition
acceptance. A changed package, binding or protocol requires a new grant. Approval
of another pin for a view removes the previous grant of that view. Protocol 1 fixes
the two capabilities. They are not an expandable permission list.

Readers refresh device state, so a revocation from another host reaches an
authority that is already running. Writers serialize with a file lock, reread
before they merge and atomically replace flushed state. Missing, malformed,
duplicate-key, oversized or unreadable state grants nothing. If a device write
fails, the store denies this session and throws. It does not claim persistence.

In particular, a failed withdrawal can leave the old saved file in place. The
native notice then requires a retry before Nendo is reopened. This is not reported
as a successful persistent revocation.

The Desktop session resolves human-readable field names through typed Engine
reads. `PrepareExtensionConsentAsync` requires the exact installed package and
creates a bounded one-use review token. `ApproveExtensionAsync` consumes the
token. It rechecks the file session, the physical identity and the current
package/binding grant, and it validates the package again. If the bindings change,
or if the file is closed and reopened, a fresh review is required. Disable can
withdraw a grant even if its view definition was removed or broken.

None of these calls starts a renderer. Before the native dialog allows the view,
it shows the exact package, the unsigned status, the digest and the disclosed
field names. A separate Disable action remains reachable when its package is
missing or corrupt. MCP has no installation or approval operation.

## Graph package and visible controls

A custom view opens as a native pane in the main window, beside Studio and Use. It
does not open in a window of its own. The owner chose this on 2026-09-20 after
using the first slice. The pane opens at half the window and never goes below the
measured compact width of the graph (480 DIPs).

The toolbar of the pane (Open record, Focus graph, Refresh, Studio, Disable view,
Close) belongs to Nendo. The HWND of the contained helper is a child of the main
window. It is placed over the viewport of the pane and moves with it. Close removes
the pane and stops the helper. Opening another view replaces the pane. When the
person selects a node and chooses Open record, the person edits the record next to
the graph.

From 2026-09-21, the person can move the boundary between the two. A host-owned
splitter sits in its own column between the Workbench and the pane. It has its own
column because both halves are child windows drawn over the page, and an element
under either of them would never receive a click.

If the person drags the splitter, or presses Left and Right while it has focus,
the boundary moves within [480 DIPs, window − 428]. The 420 is the width that the
Workbench keeps, and the splitter takes the other 8. When the window shrinks, the host applies the same clamp again,
so the Workbench does not lose that width. A double-click restores the half at
which the view opened. The width is not remembered: every opened view starts at
half again. `Place()` re-positions the contained HWND on `LayoutUpdated`, at most
once every 60 ms, so the HWND follows a keyboard move. A pointer drag does not move
the HWND until release, as described below.

The first splitter could be focused and moved with the keyboard, but it could not
be dragged. It was a lookless `ContentControl` with no content, so WinUI gave it no
size. It appeared in the automation tree and took focus and arrow keys, but it had
no rectangle on screen for a person to press. Every measurement in the lane
passed, because the lane drove only the keyboard. The owner reported the defect on
2026-09-21.

The visible line is now a `Border` held as the `Content` of the control. A captured
pointer moves the boundary. A manipulation no longer moves it. A captured pointer
behaves the same for a mouse, a pen and a finger. The strip is 8 DIPs wide, so a
person can press and drag it at 150%.

`Runtime-ExtensionWindow.ps1` now drives both paths. `Resize pane` sends arrow
keys. `Drag pane` injects an absolute pointer drag. For the duration of the drag,
the thread is per-monitor DPI aware. A thread that is not DPI aware has its cursor
calls scaled, and every press lands half a window away. The drag also uses
`SendInput` with `MOUSEEVENTF_ABSOLUTE`. `SetCursorPos` and a zero-length relative
move deliver the press and then no moves, so the drag never moves.

`Inspect` reports the window DPI. This lets a test compare DIP widths with
accessibility rectangles, which are physical pixels. `Inspect` also reports the
box and name of the boundary, and the window that sits on top of it.

Next, a drag of the boundary stopped the view. The owner reported it the same day.
The boundary moved and the graph stopped under it, and the pane said only that the
view had stopped. When a browser is resized, its compositor receives new surfaces.
At a maximized window, the contained tree already holds about 230 MiB of its
512 MiB Job. Each resize along a drag therefore pushed the tree past the 480 MiB
pressure notification, which fails closed.

A test measured placement throttled to sixteen times a second, and the view still
stopped. For this reason, the contained window is neither moved nor resized while
the pointer is down. The pane hides the window on the press and places it once on
release, so a drag causes no resizes. The cost is a moment where the pane shows its
own background instead of the graph.

When the containment knows why a view stopped, the pane now states the reason:
*asked for more memory than it is allowed*, *started more processes than it is
allowed*, *could not keep watching what this view was using*.
`DesktopExtensionProcess.ResourceStopReason` already carried the reason, but the
pane discarded it, so every stop read the same.

The journey measures the hit area of the boundary, a 30 DIP drag right and a 60
DIP drag left, a four-press keyboard move of 64 DIPs, the 480 floor and the
remaining share of the Workbench. It then sweeps the boundary 400 DIPs four times
at a maximized window. After each sweep, it requires that the view still runs and
that the contained tree is under 400 MiB. It measures the tree through `Inspect`,
because a change that only moved closer to the limit would pass a survival check
until it failed.

When the suspension was removed, the journey failed: `Sweeping the boundary -400 DIPs at a maximized window stopped the
view: ["Disable view","This view asked for more memory than it is allowed, so Nendo
stopped it. Studio and your records are still available."]` The source was
restored and the journey passed. The contained tree stayed flat across the sweeps
at 232 to 243 MiB. The drags are short because, at that window, the pane has about
a hundred DIPs of travel before it meets a clamp. A longer drag would measure the
clamp and not whether the boundary follows the pointer.

Two falsifications were measured. When the content of the control was removed,
the original defect returned:
`The boundary has no hit area: {"ControlType":"Custom","Name":"Resize the custom view",
"Height":-1,"Offscreen":true,"Width":-1,"Under":"no box"}`. When the clamp was
replaced with a lower bound alone, the share assertion failed:
`Driven wide, the pane left the Workbench 37 DIPs of a 1067 DIP window.` Each
source was restored and the journey passed. The floor assertion does not guard
that clamp, because the column's own `MinWidth` also holds the floor. The lane does
not drive the double-click reset. That reset stays owner-observed.

One button leads to the graph. The owner used the first slice and could not find
the way through four dialogs and a choice hidden in a combo box. For this reason,
the screen of the view in Use now shows **one next step at a time**, in the order
that the design requires:

1. *Install package…* (the native picker and review, through `extension.install`)
   while the package is not on the device.
2. *Allow this view* (the native consent for this exact view, no chooser).
3. *Open graph*.

The status sentence beside the control says which of the three steps the person
is at. File → Custom views keeps export, removal and disabling as plain buttons
instead of a combo. The button of its chooser says what it does (Open, Disable or
Review). Neither change moves any authority: installation still grants nothing,
and consent is still the native dialog.

Both sets of controls use the same drawing as the other controls of the app. At
first they did not. The next step on the Use surface is the primary button of the
Workbench, beside the two secondary ones. At first it had no class, and it rendered
in the default chrome of the browser. Each action in File → Custom views is a row
with its label at the leading edge and a chevron at the trailing edge. At first it
was a stretched default button with a centred label.

A Workbench case renders the real markup and fails with
`extension-next carries no Workbench button class: []`. The native dialog lane
measures the label offset of each row and fails with `A package-manager action is not drawn as a row:
[{"id":"extensions.action.0","width":738,"labelOffset":-1}, ...]`. In that
output, -1 means that the label is not an element of its own. The first row
styling was taller and pushed the sixth action out of the enforced 1024x720
window. The existing clipping guard refused it with
`A native dialog action is clipped.` before it could reach the owner.

The chrome of the graph (heading, summary, tools, hint, footer and canvas) is not
text-selectable. A drag therefore pans or selects nodes and does not highlight
prose. The text alternative stays selectable. The browser gate cannot drive a real
selection in WebView2, so it asserts the computed `user-select` rule. When the
rule was removed, the gate failed with
`Graph chrome is text-selectable: {"header":"auto","#canvas":"auto","#summary":"auto","footer":"auto","#text-view":"auto"}`.
When the rule was restored, the gate passed. The rule changes the package digest.
For this reason, a file pinned to the earlier archive reports the package as
changed until the package is reinstalled and allowed again.

The dependency graph and the work-dependency view keep their own palette, separate
from the palette of the app. The Systems Lens package (below) copies the tokens of
the app instead. The host sends a theme word and no colours, so the palette is the choice of
the package. On 2026-09-21 the owner left it unchanged.
[Authoring a custom view](../custom-view-authoring.md) carries the values of the
app for an author who wants to match them.

Two things depend on the difference. First, a change to a stylesheet changes the
package digest. This closes a view that is already pinned, until the package is
reinstalled and allowed again. Second, `Review-ExtensionDialogs.mjs` proves that
the contained renderer is composed and visible: it asserts that its pixel differs
from the pixel of the native pane. If the two palettes were aligned, a different
proof of composition would be necessary.

The separate MIT-licensed package under `extensions/dependency-graph/` implements
protocol 1 without runtime dependencies. `Build-NendoGraphPackage.ps1` produces
`org.nendo.dependency-graph` version `0.1.0` as an offline `.nendoview` archive.
The archive has fixed ZIP timestamps and ordered manifest fields, and the script
reports its exact digest. Nendo's installer does not silently install it. Pointer
pan, zoom, keyboard selection, text relationships, themes and generation
replacement are implemented. Labels are assigned as text, and markup-like values
never become elements. Cycles, self-links, parallel edges and isolated records
remain in the projection.

A second package, `extensions/work-dependencies/`, is the view of the planner
itself: `org.nendo.work-dependencies` version `0.1.0`. The shared packer builds it
through `Build-NendoWorkDependenciesPackage.ps1`. It draws Work items as nodes and
dependency records as links. It lays them out by longest path, so left-to-right is
the order in which the work must happen. It marks strongly connected components as
cycles. A Focus mode dims everything that is not connected to the selection.

`Review-WorkDependencies.ps1` measures the package in the production gate:
layering, exact cycle membership and cycle edges, summary counts, selection,
Focus, keyboard traversal, the text alternative, non-selectable chrome, generation
replacement, the empty state, both themes and a 512x384 compact window. When the
layering was removed, the lane failed with
`a does not sit left of b: {"a":40,"b":40,"c":40,"d":40,"x":40,"y":40,"z":40,"w":40}`.
When everything behind a cycle was marked as cyclic, as a settle-based pass does,
the lane failed with `The summary is wrong: 8 work items · 7 links · 2 unblocked · 4 in a
dependency cycle`. The source was restored and the lane passed.

A third package, `extensions/systems-lens/`, is the schematic view of Nendo
Station: `org.nendo.systems-lens` version `0.1.0`, built through
`Build-NendoSystemsLensPackage.ps1`. `Review-SystemsLens.ps1` measures it in the
production gate.

All three packages now come from one packer, `Build-NendoViewPackage.ps1`. That refactor did not change the digest of the graph
(`e40a32c53352455481d56b5e883a26178a74f4ec51c20b2ec8b19507eacc6a86`).

The graph fits itself into view when it opens, again on the next two animation
frames, and on any window resize. It is therefore centred and visible even when
the host composes and sizes the pane after the page has loaded. A fit against a
canvas that has no size yet (zero width or height) is skipped. Such a fit would
push every node off-screen, and the canvas would look empty. The owner saw exactly
that on a maximized window on 2026-09-21. The first fit ran before the contained
window had its size, and the graph never fitted again, because the window was
never resized afterward.

The browser gate asserts that the centre of every node is inside the visible
canvas after open. When the centring of the fit was removed, the gate failed with
`A node opened outside the visible canvas: [false,false,false]`. That gate runs in
Playwright, which always lays the canvas out at a real size. For this reason, the
gate cannot reproduce the open-time timing of WebView2. The owner report is the
evidence for that failure.

The production gate now runs `Review-NendoGraph.ps1` (pinned Playwright CLI
0.1.21, Microsoft Edge, task-owned local assets and a simulated message transport)
and `Review-ExtensionDialogs.ps1` (real Nendo, fresh file/device state, scoped UI
Automation). The graph lane measures node/edge counts, distinct parallel paths,
pointer/keyboard/text selection, zoom, compact overflow and generation
replacement, with light/dark captures. The native lane measures the
package-manager buttons inside the minimum-size window and both effective themes.
It does not yet drive the native import/export pickers or the consent dialog to
completion. The real helper test builds the real archive and checks its ready
handshake under AppContainer/CSP.

Visual inspection found two graph defects. First, pointer focus moved a node before
its click completed (`Node selection named the wrong record.`). Second, parallel
links overlapped. Focus now recentres only keyboard targets. Removal of curve
separation produces `Parallel edges overlap on the same line.` The source is
restored before the passing lane. These package checks do not establish native
graph-window composition or host navigation. Separate lifecycle and native journey
tests below cover those, including editing in Studio after a renderer crash.

## Coherent graph reads

`NendoApplicationService.ReadGraphProjectionAsync` uses the coordinator gate and
one storage-owned deferred read transaction for authority, manifest, mappings,
nodes and edges. It reads only the stored Text label, the optional stored scalar
status, the node IDs and the edge IDs/endpoints. It discloses no unselected fields
or calculations. Both distinct edge Reference fields must target the node entity.
All physical identifiers remain inside Engine storage.

The first read implementation covers an entire bounded pair of types. It has no
authored filters yet. It reads at most 501 node rows or 1001 edge rows to detect
overflow, and it returns at most 500/1000. It refuses the whole projection above
1 MiB. Each label/status string is bounded to 4096 characters. Integer/Decimal
status values become exact text through the existing storage decoder. They do not
become floating point or internal storage encodings.

Null labels fall back to the record ID. Empty types, cycles, parallel edges and
self-links are valid. Node IDs and edge IDs have separate namespaces, which match
the two record types. Duplicates within either set are refused. A missing endpoint
causes a named refusal. The read does not silently drop edges. Safe/recovery
snapshots receive no extension projection. The existing inspection in Studio
remains available.

## Current integration and evidence

`extensionGraphSurface` is now a host-understood root in contract version 3. It
raises the minimum host of a file that uses it to **1.29.0**. It is authored
through the existing canonical `ui.addNode`, `ui.setProperty` and `ui.removeNode`
operations. There is no second mutation pipeline. Definition and data revisions
remain separate. Semantic review names the package pin and the disclosed fields.
Proposal promotion replays exact operations and refuses stale definition
revisions. Packages need not be present to review, accept, copy or reopen a
definition.

Required properties are `definitionVersion: 3`, `entityId`, `title`, `packageId`,
`packageVersion`, `packageDigest`, `protocolVersion`, `configurationVersion`,
`configuration`, `edgeEntityId`, `labelFieldId`, `sourceFieldId`, and
`targetFieldId`. `statusFieldId` is optional. The surface entity is the node type.
Both edge fields must be distinct, active, configured References to it. The label
is active stored Text, and the status is an active stored non-reference scalar.
The root has no children. Invalid bindings produce NUI450. To retire a bound
type/field, the same proposal must remove or replace the view.

Configuration is **JSON text in a scalar string property**. It is bounded to 8192
UTF-8 bytes and nesting depth 8. Protocol 1/configuration version 1 requires
`"{}"`. Positive future versions preserve their exact configuration text and
produce warning NUI451. Execution reads refuse them with
`extension-version-unsupported`. Unrelated data edits preserve that text.

Unknown core properties/kinds still follow the existing compiler and safe-mode
rules. Configuration, protocol and bindings are part of the consent digest. The
title is presentation only. Exact semantic versions reject numeric prerelease
identifiers with leading zeros.

`ReadExtensionViewAsync(viewId)` resolves the durable definition, identity and
graph inside one Engine-owned transaction. A removed view receives
`extension-view-missing`. If a single operation removes a custom-view root, the
removal can be compensated from the retained properties of the root while the
definition revision is unchanged, with idempotent replay. After a later definition
edit, restoration is refused with `definition-revision-conflict`. General UI
subtree compensation remains unsupported. Removal never removes records.

The published MCP example `pin-an-offline-custom-graph` validates this shape
through the real authoring tools. Its all-zero digest intentionally names a
missing package. It is an authoring example and not an installable package. Tests
exercise the contained desktop transport, the package cache and the native consent
service. The native package/consent controls are now connected. File → Custom
views also opens an explicitly selected, approved graph in a native pane of the
main window.
Opening a file alone never starts a package.

The Desktop controller keeps the exact archive lease for a run. It caps concurrent
starts/runs at four and starts the helper outside the file gate. File-session
rotation cancels pending startup and kills running Jobs before it changes
identity. Concurrent cleanup callers await one completion, including the release
of the archive lease. A 500 ms monitor re-reads the bounded typed view. Changed
bindings stop execution, and changed data replaces the projection and clears the
selection. Pipe writes run outside the file gate with a five-second timeout.

The native pane owns Open record, Focus graph, Refresh, Studio, Disable view and
Close. A real Open record gesture rechecks the current grant, revision and node
membership. Only the resulting file-scoped semantic IDs reach the trusted
Workbench. The Workbench rejects another file session, respects unsaved edits and
reads the current record. The helper is composed below native controls through
the authenticated HWND. Both processes use PerMonitorV2. If the DPI contexts do not
match, composition is refused, in accordance with the
[Windows SetParent contract](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setparent).

Tests measure parent identity, visibility, opacity, exact viewport bounds and
retained AppContainer identity. If a zero toolbar offset is restored, the test
fails with `The renderer covers the native toolbar.`

In Use, a configured `extensionGraphSurface` shows a status line and three
buttons. The status line states whether the exact package is on this device and
whether this view has permission. The first button is the one next step, in this
order: *Install package…*, *Allow this view*, then *Open graph*. The other two
buttons are *Manage packages…* and *Open Studio*, which is always present. The
surface never queries a list as a substitute for a graph. F6
moves between the contained renderer and the native controls. The helper receives
the native key event and emits a separate `focusHost` transport envelope. Page
messages stay byte-wrapped and cannot impersonate it. A host-only `focus` message
focuses the browser control and is not delivered to page JavaScript.

`DesktopExtensionJourneyTests` launches the real app with a disposable file and an
explicit `NENDO_DEVICE_STATE_ROOT` in both build configurations. It imports through
the real file picker and package review, and it asserts that installation grants
no execution permission. It exports through the save picker and compares the bytes
exactly. It accepts the real native disclosure and opens the configured Use graph.
It measures native control bounds and both native/renderer theme pixels at
1024×720. It follows a node into Studio, saves a record and reads the saved value
after reopening.

The test sends F6 only to the focused HWND, after it checks that the HWND descends
from the owned main window. It then terminates only the helper whose parent, path
and window belong to this run. It asserts the native recovery notice and the
disabled Open record control. It then saves a second record edit through the
surviving Studio route. When the native focus envelope was removed, the test
failed: `F6 did not return focus to the host controls: Dependencies`. The correct
helper source was restored. The remaining boundary/pressure matrix is a separate
unfinished lane.

`ExtensionViewSessionTests`, `ExtensionViewPackageTests`,
`ExtensionGraphProjectionTests`, `ExtensionDefinitionTests` and
`ExtensionFrameTests` run in the existing Engine test lane. The following guard
falsifications were measured:

- When membership enforcement was removed, the result was
  `Expected: "record-outside-projection" / But was: "selected"`.
- When safe-path enforcement was removed, the result was
  `Assert.ThrowsExactly failed. Expected exception type:<System.IO.InvalidDataException> but no exception was thrown. ... ../escape.html`.
- When custom-view removal restoration was disabled, the remove/reopen/restore
  test produced `Compensation is not implemented
  for ui.removeNode.` The implementation was restored.
- At first, a valid node and edge that shared one record ID caused `The graph contains a
  duplicate edge or an endpoint outside its projection.` The regression test now
  checks separate ID namespaces and keeps the duplicate-edge refusal.
- The initial projection returned `nendo.decimal:` storage text in error. The
  exact-value test failed (expected length 30, actual 44) until the projection
  used the existing scalar decoder. That regression is now covered.

`DesktopExtensionDeviceTests` and `DesktopExtensionConsentTests` exercise the cache
and the native consent services. This includes a real raw `.nendo` copy with
unchanged application/instance IDs, which receives no approval. Measured device
guard failures:

- When physical identity was ignored, the result was
  `A raw copy inherited execution approval.`
- When the binding recheck was removed, the result was `Expected exception type:<Nendo.Engine.NendoPreconditionException>
  but no exception was thrown`, while a review was accepted after a canonical
  binding change.
- When delete sharing was allowed on the package lease, the result was `Expected exception type:<System.IO.IOException>
  but no exception was thrown` when another store removed the active pin.
- A real retry bug produced
  `Retrying a failed withdrawal erased another view's saved approval.` The writer
  now forces a fresh decode under its lock before it merges a retry. If a write
  fails, clearing the in-memory authority cannot appear to be saved state.

The mutated implementations were restored. The native consent and graph journey
above is separate from these service tests and includes the native package
file-pickers.

The [OS prototype](../../prototypes/custom-views/OS-BOUNDARY.md) separately
measures AppContainer/Job containment. It does not instantiate these production
classes.

`BrowserEgressAttemptsDoNotReachTheLoopbackCanary` separately runs the production
helper against independent IPv4/IPv6 HTTP and UDP receivers. It first proves that
each receiver accepts synthetic traffic. It then requires no requests or datagrams
from the contained page while a valid selection still succeeds. The shared
workload attempts fetch, redirect, localhost hostname, WebSocket upgrade, worker,
frame, download and WebRTC STUN. Matched uncontained prototype runs received all
eight HTTP routes and five STUN datagrams per address family. Contained runs
received none. Both production cases passed. The Desktop suite, excluding the
locked interactive journey, passed 277/277 on 2026-09-20.

The receiver now completes the WebSocket handshake and reads one bounded text
frame. The page sends `synthetic-websocket-canary` on open. Each production case
first proves that a native `ClientWebSocket` control is received. The contained
page must then deliver no message (`A WebSocket message reached the receiver.`).
Both production cases passed again (2/2 in 16 s). Matched prototype controls
received the marker over IPv4 and IPv6, and contained runs received none. This
covers local destinations. It does not cover external DNS/TLS.

The OS prototype also attempts explicit Job breakaway with a suspended native
child. The configured policy refuses creation (Win32 error 5), while ordinary
creation succeeds in the exact Job. A disposable control that enables breakaway
creates an AppContainer child outside that exact Job and falsifies the guard. When
the policy is restored, the probe passes. This separate native probe does not
qualify every production browser process-creation route.

`ParentInheritableEventDoesNotCrossThePrivateHandleList` creates an unrelated
inheritable event in the parent. It checks the corresponding handle slot of the
production helper through kernel-object identity. Normal selection must also
succeed. The configured launch passed. When only the explicit handle list was
removed, the test failed:
`The production helper inherited the unrelated parent event.` The original source
was restored byte-for-byte. This measures accidental inheritance of that synthetic
kernel object. It does not measure every possible handle type or acquisition
route.

The separate native OS prototype also measures a bounded eight-second saturation
workload through Job accounting that the parent observes. On 22 logical
processors, the configured 20% cycle cap measured 21.67% and 20.89% aggregate CPU
time. A control that permitted 100% measured 85.40% and falsified the explicit
<=25% measurement guard. This is native CPU-load evidence with a stated tolerance.
It is not a browser throughput or visible recovery measurement.

The egress test now also proves three more observers and then relies on them:

- a raw TLS listener that records the client hello that an `https:` fetch from a
  page sends;
- an mDNS listener that receives the query that the system resolver multicasts
  for a `.local` name;
- a batch-oplock observer on an ungranted file, which breaks on any open attempt
  that reaches the file system.

Each case first exercises the observers natively (a client hello, a `.local`
lookup, a read of the file). The contained page then attempts an `https:` fetch, a
JSON-RPC `initialize` POST shaped like a loopback MCP call, a public name on a
closed port, a `.local` name, and `file:` fetch, XHR, image, script, worker and
frame loads. Both cases passed with no client hello, no multicast query and no
file-system open. The OS prototype's matched controls received the hello, the
multicast query and the file opens. Its contained native probes had name
resolution refused (`HostNotFound`), and the helper's own `file:` navigation
failed.

Outside those observers, the unicast DNS query for the external name is not
directly observed on this machine. The reason is that only an elevated process can
read the resolver cache of Windows 11 26300. The refusal is measured natively in
the same AppContainer instead.

`PageClipboardAccessIsRefusedAfterARealClick` passed. When only the injected
policy script was removed, the test failed: `The clipboard was written by the page; the
page reported r0c1w1f0.` (read: denied by the permission handler; copy and
write: succeeded; frame realm: none). The source was restored byte-for-byte
and the test passed again.

High-DPI toolbar reflow, visible pressure recovery, installed-host and offline
journeys remain required. The completed isolated consent/graph/Studio journey does
not substitute for those unrun checks.
