# Custom-view execution boundary

Authority: [ADR-0013](../decisions/0013-defer-general-extension-model.md), accepted
by the owner on 2026-09-20. Architecture acceptance authorizes implementation;
it does not convert pending release checks into passes.

This contract states what the host guarantees and refuses. To write a package
against it, read [authoring a custom view](../custom-view-authoring.md), which
gives the manifest, the message contract and the authoring steps in one place.

## Implemented Engine foundation

`NendoExtensionViewSession` is a closed host-side protocol state machine, not a
transport or renderer. It has no generic dispatch, filesystem, process, network,
write or navigation operations. A desktop transport must authenticate its OS peer
before submitting frames. Session correlation is a random nonce; it is not peer
authentication or an edit lease.

The host supplies exact device consent for application, instance, view, package
digest, binding digest and protocol version. Revocation generations are checked
before and after the grant query. A denied, changed or unreadable authority closes
the session. Reapproval cannot revive an old closed session.

Version 1 accepts only `ready`, `selectRecord` and `reportError`, with exact keys
and types, no duplicate keys, maximum JSON depth 8 and strict UTF-8. Frames above
64 KiB are refused before parsing; all attempts count toward a rolling limit of
60 messages/second. Flooding closes the session. `ready` must arrive before five
seconds. The desktop transport also enforces a five-second ready timeout and kills a silent renderer.
Report errors have two closed codes and bounded text; renderer text is never a
command or telemetry upload.

Selection is limited to a node in the current projection. Replacing a projection
increments its generation and clears selection; queued old-generation messages
are refused. Host UI obtains a selection only with the current grant and exact
source change sequence, then must recheck record existence using typed services.
Receiving a selection message alone never navigates or writes.

`NendoExtensionFrameCodec` supplies a four-byte little-endian length prefix with
allocation bounds, exact reads, cancellation and truncated-frame refusal. It does
not authenticate peers, set read deadlines or serialize multiple writers; those
remain transport-owner obligations. The desktop helper transport below supplies them.

## Contained desktop transport

`DesktopExtensionProcess` stages a private helper, immutable validated assets and
separate writable browser state for one launch. It creates a zero-capability
AppContainer profile and a Job with kill-on-close, 512 MiB aggregate memory,
32 processes and a 20% CPU hard cap. It reads the Job limits back, creates the
helper suspended, assigns the Job and checks the exact AppContainer SID and Job
membership before resuming. Missing enforcement refuses startup. Studio and the
application services remain in the host process outside that tree.

Two anonymous pipes are the entire IPC surface. The native
[process attribute handle list](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
restricts inheritance to those two client handles; standard handles and the host
environment are not inherited. The helper clears inheritance before starting
WebView2. The parent checks the native report against its launched process, window
owner and browser processes' Job/AppContainer membership. It pins process handles
rather than trusting reusable PIDs. Page messages are always wrapped as bounded
bytes and cannot impersonate that native report. Output is serialized, the helper
queue holds at most 16 frames, and the closed Engine session validates page messages.

`Nendo.ExtensionHost` contains WebView2 and a linked copy of the frame codec only;
it has no Engine, MCP or SQLite assembly reference. It refuses an uncontained
launch before creating a window. Host objects, permissions, downloads, pop-ups,
frames, later navigation, developer tools and external resources are disabled.
Validated local assets receive CSP and content-type headers. CSP is defence in
depth; the AppContainer is the network and OS authority boundary.

The clipboard is the one measured exception to that boundary. A zero-capability
AppContainer page that receives a real pointer click can read the session
clipboard and overwrite it (OS prototype clipboard lane, 2026-09-20). The helper
therefore denies the clipboard-read permission and, before any page script runs
in any document, seals `navigator.clipboard` to undefined and makes
`document.execCommand` refuse `copy`, `cut` and `paste`. This is a browser-layer
policy, so it is measured from outside the page: a production test places a
sentinel on the system clipboard, delivers a real click to the helper window,
and requires the sentinel unchanged while the page reports every entry point
refused. A person's own Ctrl+C on visible text is not affected.

Startup is bounded to 30 seconds, followed by a five-second ready handshake.
Consent is checked before resume, after native bootstrap and every 100 ms while
running, including when the page is silent. Stop closes the Job and session;
disposal waits for the observed process tree and removes the task-owned profile
and scratch files, reporting cleanup that remains pending. There is no weaker
in-process fallback.

The parent associates a private completion port before adding any process to the
Job. It verifies a 480 MiB memory-pressure notification below the unchanged
512 MiB hard cap. On pressure, memory-limit or active-process-limit events it
closes the Job and session; loss of the monitor also fails closed. The port is
not inherited by the helper. This avoids leaving a silent view alive after an
allocation is refused. The separate notification limit matters because ordinary
hard-limit event delivery is not guaranteed; notification-limit delivery is.
See Microsoft's [Job completion-port contract](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_associate_completion_port)
and [notification-limit structure](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_notification_limit_information).

The current Desktop tests launch the real helper and browser: round-trip selection,
kill during an infinite JavaScript loop within two seconds, silent revocation,
missing-ready timeout and refusal outside containment. Removing the security
capabilities attribute produced `The suspended helper did not match its
AppContainer and Job identity.` before the helper was resumed. The source was
restored and the passing qualification repeated. These tests do not yet measure
the broader IPv6/DNS/external-network or breakaway matrix. A bounded browser
workload attempts 640 MiB of retained allocations, first reporting that it began;
the pressure test measures fail-closed session and observed process-tree cleanup.
The pre-fix helper stayed silent until `System.TimeoutException: The operation has
timed out.` The pressure watcher makes this case pass; CPU-cap throughput and
other pressure workloads remain separate checks.

## Packages

`NendoExtensionViewPackage.Validate` accepts at most 10 MiB of archive bytes,
30 MiB expanded and 200 entries including the manifest. It checks the caller's
exact archive digest and every listed asset's byte length and SHA-256. All entries
are read within bounds; nothing is extracted or executed. Asset getters return
copies. Validation does not grant installation or device consent.

The manifest has a closed version-1 shape. Only `projection.read` and
`record.select` capabilities are allowed. It declares a namespaced package ID,
version, HTML entry point, license and exact asset inventory. HTML/CSS/JavaScript
and text license assets are allowed. Unknown entries/properties, native payloads,
invalid UTF-8, duplicate/case-colliding paths, traversal, absolute paths, alternate
streams, reserved Windows names, links and reparse points are refused.

`DesktopExtensionPackageStore` keeps at most 256 content-addressed `.nendoview`
archives in device settings, outside the file. Inspection is read-only; explicit
installation freezes and validates bounded bytes before creating cache state,
flushes a private staging file and activates by same-volume rename. Interrupted
staging files are not packages. Pins coexist; installing a new version does not
replace the previous one. Explicit reinstall can repair a corrupt copy of the
same pin. Every acquire validates the archive and exact package ID/version again.
The open lease denies write/delete sharing across host processes, preventing
uninstall or replacement while a view owns that package. Export returns the exact
original archive bytes, retaining the pin for offline transfer. Unknown files are
not cleanup targets. File → Custom views now opens native package management;
installation and export paths come from native pickers. No package path or approval
flag supplied by the Workbench is forwarded to these operations.

## Device consent and native review

`DesktopExtensionGrantStore` stores bounded, versioned JSON outside `.nendo`, keyed
by the native physical file identity and the exact Engine grant. A raw copy retaining
application/instance IDs therefore receives no approval. No permission follows
package installation or definition acceptance. A changed package, binding or
protocol requires a new grant; approving another pin for a view removes its previous
grant. The two capabilities are fixed by protocol 1, not an expandable permission list.

Readers refresh device state so revocation from another host reaches an already
running authority. Writers serialize with a file lock, reread before merging and
atomically replace flushed state. Missing, malformed, duplicate-key, oversized or
unreadable state grants nothing. A failed device write denies this session and
throws instead of claiming persistence. In particular, a failed withdrawal can
leave the old saved file in place: the native notice requires retry before reopening
Nendo. It is not reported as successful persistent revocation.

The Desktop session resolves human-readable field names through typed Engine reads.
`PrepareExtensionConsentAsync` requires the exact installed package and creates a
bounded one-use review token. `ApproveExtensionAsync` consumes it, rechecks the file
session, physical identity and current package/binding grant, and validates the
package again. Changed bindings or a closed/reopened file require a fresh review.
Disable can withdraw a grant even if its view definition was removed or broken.
None of these calls starts a renderer. The native dialog shows the exact package,
unsigned status, digest and disclosed field names before allowing the view. A
separate Disable action remains reachable when its package is missing or corrupt.
MCP has no installation or approval operation.

## Graph package and visible controls

A custom view opens as a native pane in the main window, beside Studio and Use,
rather than in a window of its own: the owner chose this on 2026-09-20 after using
the first slice. The pane opens at half the window and never goes below the graph's
measured compact width (480 DIPs). Its toolbar (Open record, Focus graph, Refresh,
Studio, Disable view, Close) belongs to Nendo; the contained helper's HWND is a
child of the main window placed over the pane's viewport and moves with it. Close
removes the pane and stops the helper; opening another view replaces the pane.
Selecting a node and choosing Open record edits the record next to the graph.

The boundary between the two is the person's to move, from 2026-09-21. A host-owned
splitter sits in a column of its own between the Workbench and the pane — its own
column because both halves are child windows drawn over the page, and an element
under either of them would never be clicked. Dragging it, or pressing Left and Right
while it has focus, moves the boundary within [480 DIPs, window − 420]; the 420 is
what the Workbench keeps, and a shrinking window re-applies the same clamp rather
than squeezing it out. Double-clicking restores the half the view opened at. The
width is not remembered: every opened view starts at half again. `Place()` already
re-positions the contained HWND on `LayoutUpdated`, so it follows the drag.

**The first splitter could be focused and moved with the keyboard, and could not be
dragged at all.** It was a lookless `ContentControl` with nothing in it, so WinUI
arranged it to nothing: it appeared in the automation tree, took focus and took arrow
keys, while having no rectangle on screen to press. Every measurement the lane made
passed, because the lane only drove the keyboard. The owner reported it on 2026-09-21.
The visible line is now a `Border` held as the control's `Content`, and the boundary is
moved by a captured pointer rather than by a manipulation, which behaves the same for a
mouse, a pen and a finger. The strip is 8 DIPs so it can be taken hold of at 150%.

`Runtime-ExtensionWindow.ps1` now drives both paths. `Resize pane` sends arrow keys.
`Drag pane` injects an absolute pointer drag: per-monitor DPI aware for the duration,
because a thread that is not has its cursor calls scaled for it and every press lands
half a window away; and `SendInput` with `MOUSEEVENTF_ABSOLUTE`, because `SetCursorPos`
and a zero-length relative move deliver the press and then no moves, which is a drag
that never moves. `Inspect` reports the window DPI, so DIP widths can be compared with
accessibility rectangles, which are physical pixels, and the boundary's own box, name
and what window sits on top of it.

**Dragging the boundary then killed the view.** The owner reported it the same day: the
boundary moved and the graph died under it, with the pane saying only that the view had
stopped. Resizing a browser hands its compositor new surfaces, and at a maximized window
the contained tree already holds about 230 MiB of its 512 MiB Job, so resizing it along
a drag walked it past the 480 MiB pressure notification, which fails closed. Throttling
placement to sixteen times a second was measured and the view still stopped. The
contained window is therefore neither moved nor resized while the pointer is down: the
pane hides it on the press and places it once on release, so a drag costs no resizes at
all. The cost is a moment where the pane shows its own background instead of the graph.

The pane also now says why a view stopped when the containment knows — *asked for more
memory than it is allowed*, *started more processes than it is allowed*, *could not keep
watching what this view was using*. `DesktopExtensionProcess.ResourceStopReason` already
carried it and the pane was discarding it, so every stop read alike.

The journey measures the boundary's hit area, a 30 DIP drag right and a 60 DIP drag
left, a four-press keyboard move of 64 DIPs, the 480 floor and the Workbench's
remaining share. It then sweeps the boundary 400 DIPs four times at a maximized window
and, after each sweep, requires the view to still be running and the contained tree to
be under 400 MiB — measured through `Inspect`, because a change that merely got closer
to the limit would pass a survival check until the day it did not. Removing the
suspension failed it: `Sweeping the boundary -400 DIPs at a maximized window stopped the
view: ["Disable view","This view asked for more memory than it is allowed, so Nendo
stopped it. Studio and your records are still available."]` The source was restored and
the journey passed, with the contained tree flat across the sweeps at 232 to 243 MiB. The drags are deliberately short: at that window the pane has about a
hundred DIPs of travel before it meets a clamp, and a longer drag would measure the
clamp instead of whether the boundary follows the pointer. Two falsifications were
measured. Removing the control's content restored the original defect:
`The boundary has no hit area: {"ControlType":"Custom","Name":"Resize the custom view",
"Height":-1,"Offscreen":true,"Width":-1,"Under":"no box"}`. Replacing the clamp with a
lower bound alone failed the share assertion:
`Driven wide, the pane left the Workbench 37 DIPs of a 1067 DIP window.` Each source was
restored and the journey passed. The floor assertion is not that clamp's guard — the
column's own `MinWidth` also holds it — and the double-click reset is not driven by the
lane at all; it stays owner-observed.

Getting there is one button. The owner, using the first slice, could not find the
way through four dialogs and a choice hidden in a combo box, so the view's screen
in Use now shows **one next step at a time** in the order the design requires:
*Install package…* (the native picker and review, through `extension.install`)
while the package is not on the device, then *Allow this view* (the native consent
for this exact view, no chooser), then *Open graph*. The status sentence beside it
says which of the three the person is at. File → Custom views keeps export,
removal and disabling as plain buttons instead of a combo, and its chooser's
button says what it does (Open, Disable or Review). Neither change moves any
authority: installation still grants nothing, consent is still the native dialog.

Both sets of controls are drawn the way the rest of the app draws its controls, which
they were not at first: the Use surface's next step is the Workbench's primary button
beside the two secondary ones (it carried no class at all and rendered in the browser's
default chrome), and each action in File → Custom views is a row with its label at the
leading edge and a chevron at the trailing one, rather than a stretched default button
with a centred label. A Workbench case renders the real markup and fails with
`extension-next carries no Workbench button class: []`; the native dialog lane measures
each row's label offset and fails with `A package-manager action is not drawn as a row:
[{"id":"extensions.action.0","width":738,"labelOffset":-1}, ...]`, where -1 means the
label is not an element of its own at all. The first row styling was taller and pushed
the sixth action out of the enforced 1024x720 window; the existing clipping guard
refused it with `A native dialog action is clipped.` before it could reach the owner.

The graph's own chrome (heading, summary, tools, hint, footer and canvas) is not
text-selectable, so a drag pans or selects nodes rather than highlighting prose;
the text alternative stays selectable. The browser gate cannot drive a real
selection in WebView2, so it asserts the computed `user-select` rule instead.
Removing the rule failed it with
`Graph chrome is text-selectable: {"header":"auto","#canvas":"auto","#summary":"auto","footer":"auto","#text-view":"auto"}`;
restoring it passed. The rule changes the package digest, so a file pinned to the
earlier archive reports the package as changed until it is reinstalled and allowed
again.

Both first-party packages keep a palette of their own rather than the app's. The host
sends a theme word and no colours, so this is the package's choice, and on 2026-09-21
the owner left it as it is; [authoring a custom view](../custom-view-authoring.md)
carries the app's values for an author who wants to match them instead. Two things
depend on the difference: changing a stylesheet changes the package digest and closes
an already-pinned view until it is reinstalled and allowed again, and
`Review-ExtensionDialogs.mjs` proves the contained renderer is composed and visible by
asserting its pixel differs from the native pane's. Aligning the two would need a
different proof of composition.

The separate MIT-licensed package under `extensions/dependency-graph/` implements
protocol 1 without runtime dependencies. `Build-NendoGraphPackage.ps1` produces
`org.nendo.dependency-graph` version `0.1.0` as an offline `.nendoview` archive with
fixed ZIP timestamps, ordered manifest fields and a reported exact digest. It is
not silently installed by Nendo's installer. Pointer pan, zoom, keyboard selection,
text relationships, themes and generation replacement are implemented. Labels are
assigned as text; markup-like values never become elements. Cycles, self-links,
parallel edges and isolated records remain in the projection.

A second package, `extensions/work-dependencies/`, is the planner's own view:
`org.nendo.work-dependencies` version `0.1.0`, built by the shared packer through
`Build-NendoWorkDependenciesPackage.ps1`. It draws Work items as nodes and dependency
records as links, laid out by longest path so left-to-right is the order the work has
to happen in, with strongly connected components marked as cycles and a Focus mode that
dims everything unconnected to the selection. `Review-WorkDependencies.ps1` measures it
in the production gate: layering, exact cycle membership and cycle edges, summary counts,
selection, Focus, keyboard traversal, the text alternative, non-selectable chrome,
generation replacement, the empty state, both themes and a 512x384 compact window.
Removing the layering failed it with
`a does not sit left of b: {"a":40,"b":40,"c":40,"d":40,"x":40,"y":40,"z":40,"w":40}`;
marking everything behind a cycle as cyclic, which is what a settle-based pass does,
failed it with `The summary is wrong: 8 work items · 7 links · 2 unblocked · 4 in a
dependency cycle`. The source was restored and the lane passed. Both packages now come
from one packer; the graph's digest is unchanged by that refactor
(`e40a32c53352455481d56b5e883a26178a74f4ec51c20b2ec8b19507eacc6a86`).

The graph fits itself into view when it opens, and again on the next two animation
frames and on any window resize, so it is centred and visible even when the pane is
composed and sized by the host after the page has loaded. A fit against a
not-yet-sized canvas (zero width or height) is skipped rather than run, because it
would push every node off-screen and leave the canvas looking empty — the owner met
exactly that on a maximized window on 2026-09-21, where the first fit ran before the
contained window had its size and the graph never re-fitted because the window was
never resized afterward. The browser gate asserts every node's centre is inside the
visible canvas after open; removing the fit's centring failed it with
`A node opened outside the visible canvas: [false,false,false]`. That gate runs in
Playwright, which always lays the canvas out at a real size, so it cannot reproduce
the WebView2 open-time timing itself; the owner report is that failure's evidence.

The production gate now runs `Review-NendoGraph.ps1` (pinned Playwright CLI 0.1.21,
Microsoft Edge, task-owned local assets and a simulated message transport) and
`Review-ExtensionDialogs.ps1` (real Nendo, fresh file/device state, scoped UI
Automation). The graph lane measures node/edge counts, distinct parallel paths,
pointer/keyboard/text selection, zoom, compact overflow and generation replacement,
with light/dark captures. The native lane measures the package-manager buttons
inside the minimum-size window and both effective themes. It does not yet drive the
native import/export pickers or consent dialog to completion. The real helper test
builds the actual archive and checks its ready handshake under AppContainer/CSP.

Visual inspection found two graph defects: pointer focus moved a node before its
click completed (`Node selection named the wrong record.`), and parallel links
overlapped. Focus now recentres keyboard targets only. Removing curve separation
produces `Parallel edges overlap on the same line.` The source is restored before
the passing lane. These package checks do not establish native graph-window
composition or host navigation; those have separate lifecycle and native journey
tests below, including editing in Studio after a renderer crash.

## Coherent graph reads

`NendoApplicationService.ReadGraphProjectionAsync` uses the coordinator gate and
one storage-owned deferred read transaction for authority, manifest, mappings,
nodes and edges. It reads only the stored Text label, optional stored scalar
status, node IDs and edge IDs/endpoints; no unselected fields or calculations are
disclosed. Both distinct edge Reference fields must target the node entity.
All physical identifiers remain inside Engine storage.

The first read implementation covers an entire bounded pair of types, with no
authored filters yet. It reads at most 501 node rows or 1001 edge rows to detect
overflow, returns at most 500/1000, and refuses the whole projection above 1 MiB.
Individual labels/status strings are bounded to 4096 characters. Integer/Decimal
status values become exact text using the existing storage decoder, not floating
point or internal storage encodings. Null labels fall back to record ID. Empty
types, cycles, parallel edges and self-links are valid. Node IDs and edge IDs have
separate namespaces, matching the two record types; duplicates within either set
are refused. Missing endpoints cause a
named refusal rather than silently dropping edges. Safe/recovery snapshots receive
no extension projection; Studio's existing inspection remains available.

## Current integration and evidence

`extensionGraphSurface` is now a host-understood root in contract version 3,
raising a file that uses it to minimum host **1.29.0**. It is authored through the
existing canonical `ui.addNode`, `ui.setProperty` and `ui.removeNode` operations,
not a second mutation pipeline. Definition and data revisions remain separate.
Semantic review names the package pin and disclosed fields; proposal promotion
replays exact operations and refuses stale definition revisions. Packages need not
be present to review, accept, copy or reopen a definition.

Required properties are `definitionVersion: 3`, `entityId`, `title`, `packageId`,
`packageVersion`, `packageDigest`, `protocolVersion`, `configurationVersion`,
`configuration`, `edgeEntityId`, `labelFieldId`, `sourceFieldId`, and `targetFieldId`.
`statusFieldId` is optional. The surface entity is the node type. Both edge fields
must be distinct active configured References to it; the label is active stored
Text and status is an active stored non-reference scalar. The root has no children.
Invalid bindings produce NUI450. Retiring a bound type/field requires removing or
replacing the view in the same proposal.

Configuration is **JSON text in a scalar string property**, bounded to 8192 UTF-8
bytes and nesting depth 8. Protocol 1/configuration version 1 requires `"{}"`.
Positive future versions preserve their exact configuration text and produce warning
NUI451; execution reads refuse `extension-version-unsupported`. Unrelated data edits
preserve that text. Unknown core properties/kinds still follow existing compiler and
safe-mode rules. Configuration, protocol and bindings participate in the consent
digest; title is presentation only. Exact semantic versions reject numeric prerelease
identifiers with leading zeros.

`ReadExtensionViewAsync(viewId)` resolves the durable definition, identity and graph
inside one Engine-owned transaction. A removed view receives `extension-view-missing`.
Single-operation removal of a custom-view root can be compensated from its retained
properties while the definition revision is unchanged, with idempotent replay. A
later definition edit refuses restoration with `definition-revision-conflict`.
General UI subtree compensation remains unsupported. Removal never removes records.

The published MCP example `pin-an-offline-custom-graph` validates this shape through
the real authoring tools. Its all-zero digest deliberately names a missing package;
it is an authoring example, not an installable package. The contained desktop
transport, package cache and native consent service are exercised by tests, and the
native package/consent controls are now connected. File → Custom views also opens
an explicitly selected, approved graph in a native host window. Opening a file
alone never starts a package.

The Desktop controller retains the exact archive lease for a run, caps concurrent
starts/runs at four and starts the helper outside the file gate. File-session
rotation cancels pending startup and kills running Jobs before changing identity.
Concurrent cleanup callers await one completion, including archive-lease release.
A 500 ms monitor re-reads the bounded typed view; changed bindings stop execution,
and changed data replaces the projection and clears selection. Pipe writes run
outside the file gate with a five-second timeout.

The native window owns Open record, Focus graph, Refresh, Studio, Disable and Close. An actual
Open record gesture rechecks the current grant, revision and node membership.
Only the resulting file-scoped semantic IDs reach the trusted Workbench, which
rejects another file session, respects unsaved edits and reads the current record.
The helper is composed below native controls using the authenticated HWND.
Both processes use PerMonitorV2; mismatched DPI contexts refuse composition,
following the [Windows SetParent contract](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setparent).
Tests measure parent identity, visibility, opacity, exact viewport bounds and
retained AppContainer identity. Restoring a zero toolbar offset fails with
`The renderer covers the native toolbar.`

The configured Use surface shows the exact package's device availability and
permission through its single next-step control, package management
and a permanent Studio route. It never queries a list as a substitute for a graph.
F6 moves between the contained renderer and native controls. The helper receives
the native key event and emits a separate `focusHost` transport envelope; page
messages stay byte-wrapped and cannot impersonate it. A host-only `focus` message
focuses the browser control without being delivered to page JavaScript.

`DesktopExtensionJourneyTests` launches the real app with a disposable file and
an explicit `NENDO_DEVICE_STATE_ROOT` in both build configurations. It imports
through the actual file picker and package review, asserts installation grants no
execution permission, and exports through the save picker with an exact byte
comparison. It accepts the actual native disclosure, opens the configured Use graph, measures native control
bounds and both native/renderer theme pixels at 1024×720, follows a node into
Studio, saves a record and reads the saved value after reopening. It sends F6 only
to the focused HWND after checking it descends from the owned main window. It
then terminates only the helper whose parent, path and window belong to this run,
asserts the native recovery notice and disabled Open record control, and saves a
second record edit through the surviving Studio route.
Removing the native focus envelope failed:
`F6 did not return focus to the host controls: Dependencies`.
The correct helper source was restored. The remaining boundary/pressure matrix
is a separate unfinished lane.

`ExtensionViewSessionTests`, `ExtensionViewPackageTests`,
`ExtensionGraphProjectionTests`, `ExtensionDefinitionTests` and `ExtensionFrameTests` run in the existing
Engine test lane. Guard falsifications were measured:

- Removing membership enforcement caused
  `Expected: "record-outside-projection" / But was: "selected"`.
- Removing safe-path enforcement caused
  `Assert.ThrowsExactly failed. Expected exception type:<System.IO.InvalidDataException> but no exception was thrown. ... ../escape.html`.
- Disabling custom-view removal restoration caused `Compensation is not implemented
  for ui.removeNode.` in the remove/reopen/restore test; the implementation was restored.
- A valid node and edge sharing one record ID initially caused `The graph contains a
  duplicate edge or an endpoint outside its projection.` The regression now checks
  separate ID namespaces, retaining duplicate-edge refusal.
- The initial projection incorrectly returned `nendo.decimal:` storage text; the
  exact-value test failed (expected length 30, actual 44) before using the existing
  scalar decoder. That regression is now covered.

`DesktopExtensionDeviceTests` and `DesktopExtensionConsentTests` exercise the cache
and native consent services, including a real raw `.nendo` copy with unchanged
application/instance IDs that receives no approval. Measured device guard failures:

- Ignoring physical identity produced `A raw copy inherited execution approval.`
- Removing the binding recheck produced `Expected exception type:<Nendo.Engine.NendoPreconditionException>
  but no exception was thrown` while accepting a review after a canonical binding change.
- Allowing delete sharing on the package lease produced `Expected exception type:<System.IO.IOException>
  but no exception was thrown` when another store removed the active pin.
- A real retry bug produced `Retrying a failed withdrawal erased another view's saved approval.`
  The writer now forces a fresh decode under its lock before merging a retry;
  clearing in-memory authority after a failed write cannot masquerade as saved state.

The mutated implementations were restored. The native consent and graph journey
above is separate from these service tests and includes the native package file-pickers.

The [OS prototype](../../prototypes/custom-views/OS-BOUNDARY.md) separately measures
AppContainer/Job containment. It does not instantiate these production classes.
`BrowserEgressAttemptsDoNotReachTheLoopbackCanary` separately runs the production
helper against independent IPv4/IPv6 HTTP and UDP receivers. It first proves each
receiver accepts synthetic traffic, then requires no requests or datagrams from
the contained page while a valid selection still succeeds. The shared workload
attempts fetch, redirect, localhost hostname, WebSocket upgrade, worker, frame,
download and WebRTC STUN. Matched uncontained prototype runs received all eight
HTTP routes and five STUN datagrams per address family; contained runs received
none. Both production cases passed; the Desktop suite excluding the locked
interactive journey passed 277/277 on 2026-09-20. The receiver now completes the
WebSocket handshake and reads one bounded text frame: the page sends
`synthetic-websocket-canary` on open, each production case first proves a native
`ClientWebSocket` control is received, and the contained page must deliver no
message (`A WebSocket message reached the receiver.`). Both production cases
passed again (2/2 in 16 s). Matched prototype controls received the marker over
IPv4 and IPv6; contained runs received none. This covers local destinations,
not external DNS/TLS.
The OS prototype also attempts explicit Job breakaway with a suspended native
child. The configured policy refuses creation (Win32 error 5), while ordinary
creation succeeds in the exact Job. A disposable control enabling breakaway
creates an AppContainer child outside that exact Job and falsifies the guard;
restoring the policy passes. This separate native probe does not qualify every
production browser process-creation route.
`ParentInheritableEventDoesNotCrossThePrivateHandleList` creates an unrelated
inheritable event in the parent and checks the production helper's corresponding
handle slot using kernel-object identity. Normal selection must also succeed.
The configured launch passed. Removing only the explicit handle list failed:
`The production helper inherited the unrelated parent event.` The original
source was restored byte-for-byte. This measures accidental inheritance of that
synthetic kernel object, not every possible handle type or acquisition route.
The separate native OS prototype also measures a bounded eight-second saturation
workload using parent-observed Job accounting. On 22 logical processors, the
configured 20% cycle cap measured 21.67% and 20.89% aggregate CPU time; a control
permitting 100% measured 85.40% and falsified the explicit <=25% measurement guard.
This is native CPU-load evidence with a stated tolerance, not a browser throughput
or visible recovery measurement.
The egress test now also proves and then relies on three more observers: a raw
TLS listener that records the client hello a page's `https:` fetch sends, an
mDNS listener that receives the query the system resolver multicasts for a
`.local` name, and a batch-oplock observer on an ungranted file that breaks on
any open attempt reaching the file system. Each case first exercises them
natively (a client hello, a `.local` lookup, a read of the file), then the
contained page attempts an `https:` fetch, a JSON-RPC `initialize` POST shaped
like a loopback MCP call, a public name on a closed port, a `.local` name, and
`file:` fetch, XHR, image, script, worker and frame loads. Both cases passed with
no client hello, no multicast query and no file-system open. The OS prototype's
matched controls received the hello, the multicast query and the file opens, and
its contained native probes had name resolution refused (`HostNotFound`) while
the helper's own `file:` navigation failed. Outside those observers the external
name's unicast DNS query is not directly observed on this machine, because the
Windows 11 26300 resolver cache is readable only elevated; the refusal is
measured natively in the same AppContainer instead.
`PageClipboardAccessIsRefusedAfterARealClick` passed. Removing only the
injected policy script failed it: `The clipboard was written by the page; the
page reported r0c1w1f0.` (read denied by the permission handler, copy and write
succeeded, no frame realm). The source was restored byte-for-byte and the test
passed again.
High-DPI toolbar reflow, visible pressure recovery, installed-host and offline
journeys remain required. The completed isolated consent/graph/Studio journey
does not stand in for those unrun checks.
