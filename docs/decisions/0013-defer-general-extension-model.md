# ADR-0013: Isolated custom-view extensions

- **Status:** Accepted
- **Acceptance scope:** Bounded custom-view slice, 2026-09-20
- **Date:** 2026-09-02
- **Owners:** Thomas Klok Rohde and Nendo maintainers
- **Confidence:** High
- **Evidence:** [Product brief MVP boundary](../vision.md), EX-0002 strict semantic-contract result, [ADR-0004](0004-versioned-semantic-ui-contract.md) and the implementation-readiness scope decision
- **Depends on:** A post-MVP value case and capability/isolation evidence
- **Related design:** [`../architecture.md`](../architecture.md)

## Context

A general extension system would need package identity, trust, capability
granting, isolation, versioning, dependency resolution, offline distribution,
unknown-extension round trips and recovery behavior. The MVP already expresses
its distinguishing form/list/board proof through a closed declarative semantic
contract and bounded named commands.

## Decision drivers

1. Keep the MVP falsifiable and implementable by one maintainer.
2. Avoid executable code or third-party controls in durable `.nendo` files.
3. Preserve safe failure and permanent Studio access.
4. Do not promise lossless round trips for semantics the host cannot understand.
5. Require a demonstrated user need before adding a trust/capability platform.

## Options considered

### Defer all general extensions

Ship only the accepted versioned semantic vocabulary and first-party adapters.

### Declarative third-party nodes

Allow packages to add node/property types without executable code. This still
requires package identity, compatibility, fallback and round-trip rules.

### Executable plug-ins or scripts

Allow hosted code or third-party controls. This creates the broadest value and
security/isolation surface and is explicitly outside the MVP.

## Decision

The general extension model is deferred beyond the MVP.

- Format version 1 stores only core semantic definitions and bounded declarative
  commands accepted by ADR-0004.
- No plug-in manifest, marketplace, third-party control package, general script,
  binary asset extension or executable capability token is added to the first
  production format.
- Unknown core contract versions, nodes, properties, commands or protected
  extension records are never executed or modified as if understood.
- If the current host can safely expose unaffected relational data, it uses the
  ADR-0012 read-only/safe-mode path. Otherwise it rejects the file with upgrade
  guidance. The MVP does not promise edit-and-preserve round trips for unknown
  extension data.
- A later extension ADR must define identity, dependency/version resolution,
  capability grants, isolation, signatures/trust, offline packaging, resource
  limits, unknown behavior, downgrade and recovery, backed by executable
  evidence.

## Evidence and validation obligations

- EX-0002 expressed the Idea Garden form/board and a bounded command without
  arbitrary renderer properties or executable escape hatches.
- Production compatibility tests must prove unknown core semantics fail closed
  and do not disappear silently from safe inspection.
- No implementation work may create an extension API under this Deferred ADR.

## Consequences

### Positive

- The first format and threat model remain bounded.
- Invalid or future semantics fail through the same compatibility path.
- Implementation capacity stays focused on the core product proof.

### Negative

- Third parties cannot add controls, scripts or packaged semantic types.
- Files from future extension-aware hosts may be read-only or rejected.
- Some useful integrations require first-party typed operations until revisited.

## Rejected alternatives

No extension alternative is rejected forever. Both declarative and executable
models are deferred because neither has a current MVP value case or the required
compatibility/isolation evidence.

## Revisit triggers

- Repeated product needs cannot be expressed through the core semantic contract.
- A concrete third-party integration justifies the lifecycle/security cost.
- The core MVP and recovery journey are implemented and qualified.

## Addendum 2026-09-10 — scheduled for P7

The owner scheduled the general extension model and general scripting (the
reserved ADR-0008 scope) for **P7**. The deferral recorded above therefore ends
with the MVP rather than continuing indefinitely.

This addendum schedules the work; it does not grant implementation authority. The
obligations this ADR states for a later extension ADR are unchanged and still
apply: identity, dependency and version resolution, capability grants, isolation,
signatures and trust, offline packaging, resource limits, unknown behaviour,
downgrade and recovery, each backed by executable evidence. P7 must write and
accept that ADR before an extension or script can execute against a `.nendo`
file.

## Addendum 2026-09-12 — bounded behaviour accepted separately

[ADR-0008](0008-general-scripting-and-capability-isolation.md) now accepts
restricted NCalc expressions and host-owned local actions following disposable
D1–D4 experiments. Production implementation and release qualification remain
pending. That decision does not accept a general extension platform.

The remaining ADR-0013 scope is third-party packages and controls, extension
identity/dependencies/version resolution, signatures, offline packaging,
unknown-extension preservation and downgrade/recovery. Arbitrary code, external
effects and background execution require additional accepted authority. Preserve
the original deferral and P7 scheduling history above; neither schedules nor the
bounded expression decision grant those broader capabilities.

## Planning note 2026-09-20 — custom views selected

For W-007, the owner selected custom views over existing data as the first extension
direction. The [custom-view extension plan](../design/custom-view-extensions-plan.md)
uses a dependency graph to test the package, projection, isolation and recovery
boundaries. Selection is not ADR acceptance: this decision remains Deferred and
production implementation awaits executable boundary evidence and an accepted
extension decision.

## Accepted amendment 2026-09-20 — isolated custom views

The owner explicitly stated: **"I accept the architecture changes. Proceed"**,
following selection and measured AppContainer/Job Object experiments. This accepts
the architecture below and authorizes implementation. It does not mark pending
security, lifecycle or usability checks as passed. The original deferral above
remains historical; broader extensions outside this slice remain deferred.

### Scope and authority

- Read-only executable custom views over host-projected existing records, beginning
  with a dependency graph. Selection can identify an allowed projected record;
  only the host-owned Open record control navigates. Package code cannot mutate
  records, invoke commands, accept proposals or acquire edit authority.
- Keep Studio and its ordinary Workbench process permanently outside the extension
  process tree. Execute each active extension through a host-owned helper in a
  zero-capability AppContainer and a non-breakaway Job Object. Start suspended,
  establish containment before resume, use kill-on-close, and refuse execution on
  any boundary setup failure. No uncontained fallback.
- Use the measured 512 MiB aggregate job budget as the initial implementation limit
  and 20% CPU hard-cap policy; retain C-130's 256 MiB failure. These values remain
  subject to workload and pressure qualification before release.
- Keep executable packages in a device cache; the file pins package ID, version,
  digest and bounded host-understood bindings/configuration. Copying a file preserves
  data and definitions, not installation or permission to execute. Exact packages
  can be distributed offline. No remote resolution or automatic updates.
- Install and grant execution separately. Device consent binds file instance, view,
  exact package digest and projection/bindings. A proposal is not execution consent.
  Reject stale, revoked, cross-file and incompatible sessions. Unsigned local
  development packages must be labelled; publisher trust/marketplaces remain deferred.
- Use canonical typed definitions, coherent bounded projections, semantic diff,
  history and exact replay. Supported absent-package configuration is preserved;
  unknown core metadata still follows safe-mode rules. No downgrade-in-place.

### Amendments to earlier decisions

ADR-0002 and ADR-0017 permit a separate minimal extension helper and its WebView2,
without adding a second normal Studio or storage authority. ADR-0003 permits
host-understood protected view references/configuration, not executable file payloads.
ADR-0004 permits typed custom-view bindings through the semantic vocabulary.
ADR-0012 retains old-host refusal and recovery while permitting lossless preservation
of a supported envelope whose device package is absent. A compatibility rung is
required before newly persisted semantics ship. All other invariants remain intact.

### Evidence and release gates

C-129 and [the OS experiment](../../prototypes/custom-views/OS-BOUNDARY.md) establish
the bounded IPv4 loopback, file and process observations, including falsified guards.
They do not prove every browser capability or deployed composition. Implement the
[plan](../design/custom-view-extensions-plan.md) and
[protocol](../design/custom-view-protocol-draft.md) within this boundary.

Before enabling the shipped execution path, qualify authenticated bounded IPC,
handle inheritance, broader network denial, resource pressure, process breakaway,
WinUI composition/Studio recovery, package and consent lifecycle, compatibility,
accessible graph interaction and installation. Retain failed and Not run results.
The owner's acceptance moves these from architecture-selection prerequisites to
implementation/release gates; it does not waive them or authorize a weaker boundary.

### Implementation choice — durable definition, 2026-09-20

The supported envelope is `extensionGraphSurface`, using existing canonical UI
node/property operations rather than the draft's separate extensionView operation
names. This keeps one validation, diff, history and replay path. Host rung 1.29.0
marks the new semantic shape. Configuration is bounded JSON text in a scalar property,
so no generic structured-property or scripting capability is introduced. Protocol 1
and configuration version 1 accept only an empty configuration object; a future
positive version is retained with a disabled fallback. See the implemented contract.
