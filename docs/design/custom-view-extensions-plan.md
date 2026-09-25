# W-007: Custom views over existing data

Date: 2026-09-20. Status: architecture accepted; implementation in progress.
Current authority: the owner subsequently accepted the architecture and directed
implementation; see [ADR-0013](../decisions/0013-custom-views-with-code-in-the-file.md).
Earlier checkpoints below are history. Unfinished P1 checks remain release gates,
not reasons to request the same architecture acceptance again.
Work: `nd.work.r.extensions` — W-007, Define and accept the general extension model.

ADR-0013 now authorizes implementation and W-007 is Within accepted scope.
The owner accepted the AppContainer/helper direction with the remaining evidence
kept as release gates. The Engine foundation is described in
[custom views](../contracts/custom-views.md); desktop integration remains open.

## Earlier investigation checkpoints

Implementation checkpoint 2026-09-20: the owner authorized proceeding. P0 has a
[protocol draft](custom-view-protocol-draft.md); P1 now has a runnable
[WebView2 boundary probe and measured outcomes](../../prototypes/custom-views/README.md).
Independent browser environments contained an infinite loop and forced termination
against a synthetic host sentinel. The no-network assertion **failed**: WebRTC sent
a 20-byte STUN packet despite CSP and request interception. P1 stops at that boundary;
P2–P5 remain pending. No production extension API or app rebuild was performed.

Second checkpoint: the owner chose the OS-enforced prototype. The
[AppContainer/Job Object experiment](../../prototypes/custom-views/OS-BOUNDARY.md)
renders in containment and blocks the tested IPv4 loopback/native/WebRTC paths.
Removing AppContainer falsifies the network/file/token guards; restoring it passes.
A 512 MiB budget completed where 256 MiB runs timed out. This establishes a candidate
for the remaining P1 matrix, not completion of P1 or P2 acceptance.

## Outcome and first delivery

Let a person add a specialist view to records they already own. The first view is a
dependency graph: see connected records, select a node, and open that record in the
ordinary host-owned inspector. Removing, refusing or breaking the package must leave
the records, their relationships, Studio and existing screens usable.

This tests a useful extension boundary: presentation can evolve independently of
storage. It does not establish demand for a marketplace. Validate usefulness with
an owner task: identify an upstream dependency, follow it to its record, and edit
that record through Studio. Record owner feedback separately from automated checks.

First delivery includes one manually installed, separately versioned graph package,
one configured graph view per screen, pan/zoom, selection, keyboard access, a text
alternative, theme support, and explicit missing/disabled/failed states. The package
can read only its declared projection and suggest a record selection. It cannot
edit data. Typed write actions, domain types, connectors, background execution,
general scripting, package discovery and automatic updates remain separate work.

Planning estimate: value 5/5, complexity 4/5, provisional. Value depends on the owner
finding the graph useful; complexity is driven by isolation and durable compatibility,
not drawing nodes. Re-estimate after the boundary experiments rather than promise a
delivery date before them.

## Current boundaries and proposed changes

The current host creates one WebView2 for the normal Workbench in
`src/Nendo.Desktop/MainPage.xaml.cs`. It disables host objects, restricts navigation
and requests, checks message sources, and sends approved messages to
`src/Nendo.Desktop/WorkbenchProtocol.cs`. That bridge belongs to trusted host UI;
an extension must never receive it or forward messages into it.

`src/Nendo.Engine/NendoSemanticCompiler.cs`, `SemanticModel.cs` and
`SemanticVocabulary.cs` implement a closed semantic contract. The read contract in
`docs/contracts/reads-and-authority.md` supplies bounded queries with revision-aware
cursors. Existing query pages are not proof that multiple entity reads form one
coherent graph. ADR-0007 requires promotion by replay; ADR-0012 refuses unknown
protected semantics and unsupported hosts rather than guessing compatibility.

The proposed design therefore requires explicit decisions affecting ADR-0002
(one normal WebView2), ADR-0004 (new semantic view binding), ADR-0003/0012 (protected
metadata and compatibility), and ADR-0013 (package execution). Preserve their history;
accept a narrowly scoped extension decision with explicit amendments only after the
experiments below. Bounded calculations under ADR-0008 do not authorize this work.

## Data and interaction contract

Use ordinary records for graph nodes and ordinary relationship records with two
Reference fields for directed edges. Bind entity and field semantic IDs rather than
names. Support one node entity, one edge entity, a label field, and optional scalar
status in the first slice. Cycles, self-links, isolated nodes and parallel edges are
valid inputs; drawing a dependency must not silently introduce scheduling rules.

The host validates bindings and computes the projection through a typed application
service. No SQL, database paths, generic query language, application handles, edit
leases, proposal handles, receipts or behaviour grants enter the package. Supply
only the selected IDs and fields, a projection generation, theme tokens and locale.
Keep exact numeric values as strings where JavaScript numbers would lose precision.

Read node and edge sets in one Engine-owned coherent read scope, with bounded work
and cancellation. Do not materialize the entire file before applying limits. Proposed
initial ceilings are 500 nodes, 1,000 edges and 1 MiB serialized projection. These
are prototype targets, not measured capacity. Refuse an oversized result and offer
host-owned filtering; never display a truncated graph as complete. Missing or
filtered endpoints need a visible explanation, not invented nodes or dropped edges.

On data change, refresh the complete bounded projection and replace its generation.
Reject messages from older generations, closed files, replaced views and revoked
grants. Recheck selected record existence before host navigation. Package messages
can select only a node in the current projection; a host-owned Open record control
performs navigation. This avoids treating an extension message as proof of a human
gesture. Editing happens in the ordinary inspector, under its existing authority.

## Package and trust lifecycle

Propose a host-validated manifest containing a namespaced package ID, exact version,
content digest, supported view protocol range, entry point, declared asset inventory,
license attribution and capability requests. A view definition pins ID, version and
digest plus its bindings and fallback title. Names are display text, never authority.

Packages are self-contained HTML/CSS/JavaScript with bundled dependencies and license
notices. No native libraries, executable installers, runtime dependency downloads,
remote fonts or transitive package resolution. Set archive limits before extraction:
proposed 10 MiB compressed, 30 MiB expanded, 200 files, with path traversal, links,
duplicate paths, case collisions, unlisted files and digest mismatches rejected.
Dependency updates produce a new package digest and an explicit review.

Keep executable assets in a host-managed device cache, outside `.nendo`. Keep only
the host-understood manifest reference and bounded configuration in protected file
metadata. This is a deliberate portability tradeoff: copying the file preserves its
data and view definition, while executing the view on another device needs the
matching offline package. File open never installs or executes code automatically.
Import/export of a package uses native host pickers; no package-supplied paths.

Installation is distinct from permission to run. Grant narrowly scoped read-projection
and selection capabilities to this file, view and exact digest on this device.
Show the fields disclosed before consent. Store grants in device settings, fail
closed if unreadable, and revoke immediately on disable. A changed digest, expanded
projection, changed capabilities or incompatible protocol needs fresh consent.
Definition acceptance is not execution consent, including in proposal previews.

The initial development package may be unsigned, visibly labelled as such and
explicitly approved by the owner. A digest proves identity of bytes, not publisher
trust. Signed publisher distribution, key rotation and revocation are a separate
decision before public third-party distribution; do not present this slice as a
general trusted marketplace. Treat even a signed package as untrusted renderer code.

## Execution boundary to prove

Preferred experiment: a separate WebView2 environment and user-data directory for
the extension, with a narrow broker owned by the native host and a host-controlled
surface beside the permanent Workbench navigation. Never run package code in the
Workbench document, inject its assets into that document, or expose its bridge.
If native surface composition needs a helper process, prototype that explicitly and
record its deployment/lifecycle cost before deciding the production composition.

Microsoft documents that WebView2 process collections are associated with a user
data folder; profiles in one folder are not evidence of independent failure domains.
Its security guidance requires treating web content as untrusted and validating
message origins and parameters. These support the experiment, not a claim that its
isolation already works. Sources: [WebView2 process model](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model),
[security guidance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security).

Deny filesystem APIs, host objects, clipboard, downloads, popups, navigation outside
the package, permissions, service workers and all network destinations, including
localhost and Nendo's MCP endpoint. Use a restrictive CSP plus independently tested
host/runtime enforcement. Request interception alone must not be assumed to cover
WebSockets, workers, redirects, subframes or every browser feature. A security
experiment must identify the actual enforceable network boundary or stop the design.

Bound messages to 64 KiB, validate closed schemas and generation identity, reject
unknown methods, and rate-limit at the host before dispatch. Proposed targets:
60 messages/second, 5 seconds to become ready, termination within 2 seconds of a
detected hang, and a 256 MiB extension-process budget. The prototype must identify
an enforceable CPU/memory/process-tree policy; sampling memory is not a hard cap.
Never terminate a process shared with Studio to enforce an extension limit.

No claim of protection from a compromised OS, malicious same-user native programs
or browser sandbox escapes. The in-scope adversary is package web code attempting
to misuse available browser and broker capabilities. Ordinary malformed and
nonterminating packages must also leave the host usable. If isolation cannot meet
these requirements, stop and return to the owner with a narrower declarative-view
alternative; do not quietly weaken the boundary or claim it is the selected feature.

## Failure, persistence and recovery

Introduce only a versioned, host-understood extension-reference/configuration
envelope through canonical typed definition operations. Operation names and exact
schema are to be specified in the decision, not invented as currently callable MCP.
Validation, semantic diff, history, proposal preview and replay promotion must all
use those operations. Declare their reversibility; package installation and device
consent are separate local effects, not file history or universally undoable actions.

An extension-aware host preserves supported envelopes exactly across unrelated
edits even when the package is absent, disabled, incompatible or has failed. It
shows a host-owned fallback with reason, Retry/Disable where safe, and Open records.
Unknown configuration versions are opaque, bounded and non-executable; edits to
them are refused. Unknown *core* schema still follows ADR-0012, not this exception.

Raise minimum host/version requirements when introducing protected metadata; prove
an old host refuses writable open. No downgrade-in-place. Migration uses the existing
storage-owned backup/staging lifecycle; rollback restores a pre-change copy and
states which later edits would be lost. Do not erase extensions to manufacture a
downgrade. Empty valid files and files without extensions keep their existing path.

Package removal never deletes records or file definitions. Package cache replacement
is atomic and content-addressed; preserve a referenced prior version for deliberate
rollback. Retention/cleanup must not delete a package currently used by an open view.
Crash reports contain bounded diagnostics, not projected record values by default.

## Stages and acceptance gates

| Stage | Deliverable | Exit evidence |
| --- | --- | --- |
| P0 — settle protocol | Draft manifest, view binding, broker schema, limits, threat model and compatibility matrix; owner reviews the graph task | Every ADR-0013 obligation mapped to a decision or explicit first-slice exclusion |
| P1 — disposable experiments | Isolated test harness outside production `src/`, synthetic graph and hostile packages, reproducible boundary probes | All mandatory rows below pass, with measured results and falsified guards; no owner planner used as a fixture |
| P2 — architecture decision | Proposed ADR superseding the relevant ADR-0013 deferral and amending affected decisions; exact package/protocol/schema and dependency versions pinned | Owner explicitly accepts the evidenced design; update W-007 standing only then |
| P3 — Engine and lifecycle | Typed definition operations, coherent bounded projection, compatibility handling, device package/grant lifecycle | Engine/proposal tests cover exact replay, conflicts, stale bindings, unknown preservation, missing packages and old-host refusal |
| P4 — host and graph | Broker, isolated renderer, host fallback, graph package, Studio navigation and consent UI | Measured graph journeys, failure containment, keyboard/text alternative, both themes and offline copy journey |
| P5 — release qualification | MCP authoring vocabulary/examples, Help and black-box review coverage, installer | Production gate and installer lanes pass; limitations and owner task feedback recorded separately |

P1's experiments were authorized and P2 architecture acceptance is now recorded.
The owner authorized production implementation; remaining P1 obligations stay
release gates during P3–P5. The live planner is never an extension failure fixture.

| Experiment | Required measurement |
| --- | --- |
| Isolation and recovery | Record process identities; loop, crash and exhaust the extension; Studio still opens and edits a synthetic record; host fallback appears; restart does not silently reapprove |
| Network and storage | Capture attempted HTTP(S), DNS-bearing requests, WebSocket, worker/subframe, redirect, loopback MCP, file URL, download and clipboard paths; no protected access or outbound disclosure succeeds |
| Broker authority | Malformed/oversized/flooded messages, forged origins, unknown methods, stale generations, other-file IDs and revoked grants are refused before host action; normal selection still works |
| Coherent graph | Concurrent edits/deletes cannot produce mixed-generation nodes/edges; cycles and filtered endpoints are explained; over-limit input produces refusal, not a partial success |
| Package lifecycle | Corrupt archive/digest, path traversal, crash during installation, missing dependency, changed digest, missing package and offline reinstall produce their specified states |
| Durable compatibility | Supported absent-package config survives unrelated edits unchanged; unknown core semantics fail closed; old host refuses writes; failed migration preserves active data and recovery copy |
| Accessible interaction | Measure focus escape and restoration, node/edge counts and target record IDs, keyboard traversal, text alternative, System/Light/Dark and 200% scaling; no hidden Studio route |

For every new defect guard, deliberately restore the defect or remove the boundary
in a disposable fixture, capture the literal failure, restore the fix and rerun.
Record that text in a Finding. Tests that never fail against the defect are not
acceptance evidence. Keep automated, agent-observed and owner-reported results distinct.

## Implementation map and handoff

After acceptance, extend Engine semantic compilation/model/vocabulary and typed
application services first; use existing query and semantic tests as the regression
lanes. Implement the broker alongside Desktop protocol/lifecycle code, with no
generic forwarding to `WorkbenchProtocol`. Use `DesktopBehaviourGrantStore.cs` as
a reference for device grant handling, without conflating behaviour and extension
consent. Add MCP authoring through the existing canonical change-set pipeline;
agents may author references and bindings but may not grant execution or promote.

Update architecture, the affected ADRs, reads/authority and semantic contracts,
Help, and `docs/reviews/blackbox-prompt.md` in the corresponding implementation
stages. Discover actual test commands with the repository's .NET test skill before
running each new lane. Run the narrow applicable tests and
`pwsh ./tools/Test-Repository.ps1`; final qualification uses
`pwsh ./tools/Test-Production.ps1` (which includes that gate). Any app rebuild also
requires `Publish-NendoPayload.ps1`, `Build-NendoInstaller.ps1` and
`Test-NendoInstaller.ps1`; use `Test-NendoSetupIsolated.ps1` for installation checks,
never the owner's installation as a destructive fixture.

W-007 remains open while implementation and release evidence are incomplete.
Durable definitions now use extensionGraphSurface and canonical UI operations at
rung 1.29.0, with transactionally coherent reads and a published MCP example. Its
production helper now uses authenticated inherited pipes and independently checked
AppContainer/Job containment, with real-browser round-trip, termination, revocation
and timeout tests. Device package/cache and consent services now handle atomic
activation, offline export, active-package retention, physical-file-scoped grants
and stale-review refusal. Native package/consent controls and the offline graph
package are implemented; the manager and graph presentation have runtime gates.
Native helper composition, host navigation and file-owned lifecycle are now wired.
The isolated WinUI journey now measures native consent, Use entry, a two-record
dependency, both themes at 1024×720, durable Studio editing and F6 focus return.
The journey also covers native package import/export with byte equality,
missing/disabled states, persistent revocation, helper termination and another
Studio edit after failure. High-DPI layout and the P1 network/pressure matrix are
measured. `Test-ExtensionInstalledJourney.ps1` runs the same journey against the app
as setup installs it into a task-owned root. What remains is the offline copy,
reopen and newer-host journeys in the native app: today those are covered by
controller and Engine tests only.
Source tests measure HWND placement and containment, file-close cancellation,
revocation and package-lease cleanup; those are narrower than the full UI journey.
Create implementation Work items only after the architecture gate, linked back to
W-007 and the accepted decision. C-021 remains Not run for extension acceptance
until the remaining execution and integration evidence is measured. Architecture
acceptance is complete and is not a pending approval. A passing documentation gate says
nothing about extension safety or runtime usability.
