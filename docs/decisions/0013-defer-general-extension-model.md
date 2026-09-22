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

1. Keep the MVP falsifiable, and keep it small enough for one maintainer to
   implement.
2. Do not put executable code or third-party controls in durable `.nendo` files.
3. Keep safe failure and permanent Studio access.
4. Do not promise lossless round trips for semantics that the host cannot
   understand.
5. Require a demonstrated user need before you add a trust/capability platform.

## Options considered

### Defer all general extensions

Ship only the accepted versioned semantic vocabulary and first-party adapters.

### Declarative third-party nodes

Let packages add node/property types without executable code. This still
requires package identity, compatibility, fallback and round-trip rules.

### Executable plug-ins or scripts

Allow hosted code or third-party controls. This gives the broadest value and
the broadest security/isolation surface. It is explicitly outside the MVP.

## Decision

The general extension model is deferred beyond the MVP.

- Format version 1 stores only core semantic definitions and the bounded
  declarative commands that ADR-0004 accepts.
- The first production format adds no plug-in manifest, marketplace,
  third-party control package, general script, binary asset extension or
  executable capability token.
- The host never executes or modifies unknown core contract versions, nodes,
  properties, commands or protected extension records as if it understood them.
- If the current host can safely expose unaffected relational data, it uses the
  ADR-0012 read-only/safe-mode path. Otherwise it rejects the file with upgrade
  guidance. The MVP does not promise edit-and-preserve round trips for unknown
  extension data.
- A later extension ADR must define identity, dependency/version resolution,
  capability grants, isolation, signatures/trust, offline packaging, resource
  limits, unknown behavior, downgrade and recovery. Executable evidence must
  support each of these.

## Evidence and validation obligations

- EX-0002 expressed the Idea Garden form/board and a bounded command. It used no
  arbitrary renderer properties and no executable escape hatches.
- Production compatibility tests must prove that unknown core semantics fail
  closed and do not disappear silently from safe inspection.
- No implementation work may create an extension API under this ADR, except
  within the bounded custom-view slice that the accepted amendment of 2026-09-20
  authorizes.

## Consequences

### Positive

- The first format and the threat model stay bounded.
- Invalid or future semantics fail through the same compatibility path.
- Implementation capacity stays focused on the core product proof.

### Negative

- Third parties cannot add controls, scripts or packaged semantic types.
- Files from future extension-aware hosts can be read-only or rejected.
- Until this decision is revisited, some useful integrations require first-party
  typed operations.

## Rejected alternatives

No extension alternative is rejected permanently. Both the declarative and the
executable models are deferred. Neither has a current MVP value case or the
required compatibility/isolation evidence.

## Revisit triggers

- Repeated product needs cannot be expressed through the core semantic contract.
- A concrete third-party integration justifies the lifecycle/security cost.
- The core MVP and recovery journey are implemented and qualified.

## Addendum 2026-09-10 — scheduled for P7

The owner scheduled the general extension model and general scripting (the
reserved ADR-0008 scope) for **P7**. Thus the deferral above ends with the MVP.
It does not continue indefinitely.

This addendum schedules the work. It does not grant implementation authority.
The obligations that this ADR states for a later extension ADR stay unchanged
and still apply: identity, dependency and version resolution, capability grants,
isolation, signatures and trust, offline packaging, resource limits, unknown
behaviour, downgrade and recovery. Executable evidence must support each of
them. P7 must write and accept that ADR before an extension or script can execute
against a `.nendo` file.

## Addendum 2026-09-12 — bounded behaviour accepted separately

After the disposable D1–D4 experiments,
[ADR-0008](0008-general-scripting-and-capability-isolation.md) now accepts
restricted NCalc expressions and host-owned local actions. Production
implementation and release qualification are still pending. That decision does
not accept a general extension platform.

The remaining ADR-0013 scope is:

- third-party packages and controls;
- extension identity/dependencies/version resolution;
- signatures;
- offline packaging;
- unknown-extension preservation;
- downgrade/recovery.

Arbitrary code, external effects and background execution require additional
accepted authority. Keep the original deferral and the P7 scheduling history
above. The schedules do not grant those broader capabilities, and the bounded
expression decision does not grant them.

## Planning note 2026-09-20 — custom views selected

For W-007, the owner selected custom views over existing data as the first
extension direction. The [custom-view extension plan](../design/custom-view-extensions-plan.md)
uses a dependency graph to test the package, projection, isolation and recovery
boundaries. Selection is not ADR acceptance. At that point this decision stayed
Deferred. Production implementation waited for executable boundary evidence and
an accepted extension decision. The accepted amendment below supplied both on the
same day.

## Accepted amendment 2026-09-20 — isolated custom views

After the selection and the measured AppContainer/Job Object experiments, the
owner explicitly stated: **"I accept the architecture changes. Proceed"**. This
accepts the architecture below and authorizes implementation. It does not mark
pending security, lifecycle or usability checks as passed. The original deferral
above stays as history. Broader extensions outside this slice stay deferred.

### Scope and authority

- Read-only executable custom views over existing records that the host
  projects. The first is a dependency graph. Selection can identify an allowed
  projected record. Only the host-owned Open record control navigates. Package
  code cannot mutate records, invoke commands, accept proposals or acquire edit
  authority.
- Keep Studio and its ordinary Workbench process permanently outside the
  extension process tree. Execute each active extension through a host-owned
  helper in a zero-capability AppContainer and a non-breakaway Job Object.
  Start the helper suspended, and establish containment before resume. Use
  kill-on-close. If any boundary setup fails, refuse execution. There is no
  uncontained fallback.
- Use the measured 512 MiB aggregate job budget as the initial implementation
  limit, and use the 20% CPU hard-cap policy. Keep the 256 MiB failure of C-130.
  Before release, these values stay subject to workload and pressure
  qualification.
- Keep executable packages in a device cache. The file pins the package ID,
  version, digest and bounded bindings/configuration that the host understands.
  A copy of a file keeps data and definitions. It does not keep installation or
  permission to execute. Exact packages can be distributed offline. There is no
  remote resolution and there are no automatic updates.
- Install and grant execution separately. Device consent binds the file
  instance, the view, the exact package digest and the projection/bindings. A
  proposal is not execution consent. Reject stale, revoked, cross-file and
  incompatible sessions. Unsigned local development packages must have a label.
  Publisher trust/marketplaces stay deferred.
- Use canonical typed definitions, coherent bounded projections, semantic diff,
  history and exact replay. Supported absent-package configuration is kept.
  Unknown core metadata still follows safe-mode rules. There is no
  downgrade-in-place.

### Amendments to earlier decisions

ADR-0002 and ADR-0017 permit a separate minimal extension helper and its
WebView2. They do not permit a second normal Studio or storage authority.
ADR-0003 permits protected view references/configuration that the host
understands. It does not permit executable file payloads. ADR-0004 permits typed
custom-view bindings through the semantic vocabulary. ADR-0012 keeps old-host
refusal and recovery. It also permits lossless preservation of a supported
envelope whose device package is absent. A compatibility rung is required before
newly persisted semantics ship. All other invariants stay intact.

### Evidence and release gates

C-129 and [the OS experiment](../../prototypes/custom-views/OS-BOUNDARY.md)
establish the bounded IPv4 loopback, file and process observations, including
falsified guards. They do not prove every browser capability or deployed
composition. Implement the [plan](../design/custom-view-extensions-plan.md) and
[protocol](../design/custom-view-protocol-draft.md) within this boundary.

Before you enable the shipped execution path, qualify these items:

- authenticated bounded IPC;
- handle inheritance;
- broader network denial;
- resource pressure;
- process breakaway;
- WinUI composition/Studio recovery;
- package and consent lifecycle;
- compatibility;
- accessible graph interaction;
- installation.

Keep failed and Not run results. The acceptance of the owner moves these items
from architecture-selection prerequisites to implementation/release gates. It
does not waive them, and it does not authorize a weaker boundary.

### Implementation choice — durable definition, 2026-09-20

The supported envelope is `extensionGraphSurface`. It uses the existing canonical
UI node/property operations. It does not use the separate extensionView
operation names of the draft. This keeps one validation, diff, history and
replay path. Host rung 1.29.0 marks the new semantic shape. Configuration is
bounded JSON text in a scalar property. Thus it introduces no generic
structured-property or scripting capability. Protocol 1 and configuration
version 1 accept only an empty configuration object. A future positive version
is kept with a disabled fallback. See the implemented
[custom-view contract](../contracts/custom-views.md).
