# W-007 protocol draft — P0

2026-09-20. Architecture accepted under ADR-0013; implementation in progress.
The implemented Engine and durable-definition contract is [custom views](../contracts/custom-views.md).
The original CSP-only experiment failed; OS enforcement is accepted, with remaining
isolation and integration evidence retained as release gates. The broker lifecycle
below remains the target for desktop integration.

## Manifest and installation identity

The initial protocol is integer version `1`, with exact negotiation; no wildcard
compatibility. Package IDs are lowercase ASCII reverse-domain names, version is
SemVer text, and SHA-256 digests use lowercase hex. The outer archive digest is the
pin in the view definition. The manifest cannot contain its own archive digest.
Manifest assets each contain a relative slash-separated path, byte length and
SHA-256 of that file. Hash exact asset bytes; reject duplicate JSON keys, unknown
manifest keys and duplicate/case-colliding paths before extraction.

Illustrative manifest (digests shown as placeholders, not an installable package):

```json
{
  "manifestVersion": 1,
  "packageId": "org.nendo.dependency-graph",
  "version": "0.1.0",
  "protocolVersion": 1,
  "entryPoint": "index.html",
  "capabilities": ["projection.read", "record.select"],
  "assets": [
    {"path": "index.html", "bytes": 123, "sha256": "<64 lowercase hex characters>"}
  ],
  "license": "MIT"
}
```

No runtime dependencies. A complete package bundles any library and license files.
Only HTML, CSS and JavaScript text assets are allowed initially. Archive contents
must equal manifest inventory plus `manifest.json`; no alternate streams, absolute
paths, dot segments, Windows reserved names, links or undeclared executables.
Limits remain the plan's 10 MiB archive, 30 MiB expanded and 200 files, enforced
while reading, before writing outside staging. Atomic cache activation follows
complete validation. The device cache now implements this flow, exact archive export
and active-package retention. Native picker controls are connected; their complete
runtime journeys remain in the final integration checks.

## Durable view definition

Use host-understood protected metadata with stable view ID, exact package pin,
protocol/configuration versions, bounded configuration, fallback label and bindings:
node entity ID, edge entity ID, node label field ID, optional status field ID and
edge source/target Reference field IDs. Both references must target the node entity.
An extension cannot define storage, interpret unknown core schema, or carry consent.

The implemented definition uses `extensionGraphSurface` with existing canonical
`ui.addNode`, `ui.setProperty` and `ui.removeNode` operations. This replaces the draft
`extensionView.setDefinition`/`removeDefinition` names with the existing review and
replay path. The full property vocabulary is in the contract. `configuration` is
bounded JSON text in a scalar property; version 1 is `"{}"`. Minimum host is 1.29.0.
Removing a view preserves data; a single-root removal retains its properties for
compensation while the definition revision is unchanged. Accepting a definition
neither installs a package nor grants execution; previews cannot bypass consent.

## Broker version 1

The host creates an opaque session nonce bound to the open file instance, view ID,
exact package digest, approved binding digest and projection generation. It is a
message-correlation value, never edit authority. Origin and controller identity
are validated by the native broker independently of claimed JSON properties.

Host-to-view messages are `initialize` (version, session, generation, locale, theme
and projection), `replaceProjection` (new generation and complete projection),
`setTheme` and `dispose`. The projection carries nodes `{id,label,status?}` and
edges `{id,sourceId,targetId}`. Record IDs are semantic IDs, never storage IDs.
Dates stay ISO text; exact numerics stay text; labels are text, never HTML.

View-to-host messages are `ready`, `selectRecord` (record ID), and `reportError`
(closed code plus bounded plain text). Every message has version, session and
generation. No request method accepts a query, path, URL, code, shell command,
mutation, proposal or another protocol's payload. Reject additional keys, duplicate
keys, malformed Unicode, deep JSON, non-finite values and unknown enum values.

Enforce 64 KiB before parsing, maximum JSON depth 8 and 60 received messages per
rolling second per view. Disable a flooding view without queuing unlimited work.
Projection limits: 500 nodes, 1,000 edges, 1 MiB total serialized payload. Refuse
over-limit input as a whole; no implicit paging or unexplained missing edges.

`selectRecord` updates host-owned selection only when the record belongs to the
current projection. It does not navigate. A native/host-owned Open record control
checks the record still exists and opens the existing inspector. Package JS cannot
forge the host-control event. Revocation/file closure invalidates the session before
disposing the renderer; stale queued messages fail even if disposal is delayed.

## Compatibility and authority matrix

| Situation | Required behaviour |
| --- | --- |
| Supported host, installed exact digest, consent present | Execute only after isolation gate is met |
| Package missing, denied, corrupt or incompatible | Host fallback; data remains usable; no download on open |
| Same version label, different digest | Different package; refuse old approval |
| Expanded bindings/capabilities | Invalidate approval; disclose new fields before consent |
| Unknown configuration in a supported envelope | Preserve opaque bounded bytes; refuse edit/execution |
| Unknown core schema or older minimum host | Existing safe-mode/reject classification; never writable |
| Clone or copied application identity | No inherited execution consent |
| Package uninstalled or renderer failed | Keep definition and records; disable/retry through host |

## ADR-0013 coverage and open decisions

Identity, exact versions, bundled dependencies, offline cache, digest pinning,
device grants, unknown preservation and downgrade refusal have proposed semantics
above and in the plan. Resource bounds have targets, not measurements. Unsigned
development packages require explicit approval; publisher signatures and key
revocation remain excluded from this first slice and cannot be advertised as solved.

Isolation is an accepted architecture with outstanding release evidence. ADR-0013's
accepted amendment names the affected earlier decisions. AppContainer/Job containment
must be established before execution; no uncontained fallback is authorized.
