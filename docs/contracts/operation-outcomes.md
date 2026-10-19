# Operation outcomes contract

This contract states how a client learns whether an operation committed, and what a lost
response permits. The revision, operation, idempotency and proposal audit evidence is the
commit authority; retry scratch and proposal workspaces are derivatives. It implements ADRs
0005–0007 and 0009 and adds no file format and no second transaction log.

An initiating edit and the operations its automatic actions generate share one receipt and
transaction. A calculation error can still permit valid input; an action failure rolls back
the whole chain and keeps the editor input. A write's outcome names the records its actions
also changed.

## Outcome contract

| Observation | Meaning and next action |
| --- | --- |
| A mutation receipt or applied promotion result is returned | It committed. A failed refresh does not reverse it. Keep the receipt and refresh separately. |
| Receipt lookup finds the operation identity | Return the original revision/digest/counters, marked as replay. Current file authority stays independent of them. |
| Receipt lookup finds nothing | Unresolved. It does not prove no delayed request can arrive. Do not invent a new key or announce rollback. |
| Outside file/audit drift, stale file generation or lost write ownership | Fail closed. A receipt locator does not restore authority; reopen/recovery and fresh endpoint authentication are required. |
| Committed proposal workspace cleanup fails | Keep the result, report `CleanupPending`, retry cleanup. Never delete another live unaccepted proposal. |

`NendoApplicationService.GetMutationReceiptAsync` looks up data and compensation receipts;
`GetProposalReceiptAsync` looks up proposals. Lookup validates current authority, audit and
inverse evidence included. A historical receipt is not a current record snapshot. Promotion
replay uses the committed proposal identity and digest and never replaces the active file
with a clone.

## Workbench

The bridge (protocol 7) provides `data.getReceipt`, `history.getCompensationReceipt` and
`proposal.getReceipt`. The native adapter supplies scopes and enforces the opaque
file-session generation.

### Retained requests

Before dispatching a data create, deletion, hierarchy move, field or keep-in-new-files edit,
command, compensation or proposal acceptance, the Workbench keeps the exact method, key and
payload in device-local storage, keyed by application and instance identity, with the name
of the file and the time. There is at most one pending request per file, of at most 258,048
characters (the host's 262,144-character message limit less the envelope). If the request
cannot be kept or is larger, it is not dispatched: the refusal is `not-sent`, says its cause
and leaves the person's typing on screen. This scratch can hold submitted values; it is
removed on acknowledgement and is not part of the portable file.

At renderer startup the Workbench checks a retained identity against the canonical receipt
and never replays a missing one automatically. An unresolved save shows **Save
unconfirmed** in the status bar and a notice naming the file and time, keeps its input and
blocks new mutation keys. **Check or retry save** queries the outcome first, and only then
may submit the original input and key to the current session, and only when the open file
has the name the request was made in (compared case-insensitively). A copy or Backup carries
the same identity, and a rename changes the name, so a file of another name is never left
locked: its notice offers **Send it into this file** (a rename) and **Discard it here** (a
copy or Backup), each confirmed and each looking the receipt up first. A same-named file in
another folder is not told apart. A file switch keeps a late response from querying or
mutating the new file. A cleanup failure cannot hide a returned receipt or erase a newer
pending request. Native Studio, file controls and recovery stay available.

A save the person stopped is the one exception. When the host answers `cancelled` (it
answers a stop only once the work has stopped) and the lookup finds nothing, the notice also
offers **Discard this unsent change**, which looks the receipt up once more: found, the save
is acknowledged as committed; not found, the request is removed unsent. A save that timed out
or lost its answer is never offered for discard. The offer is held in renderer memory only.

A draft retained after a lost write or authority change is explicit immutable state: losing
focus or an automatic refresh cannot erase it; deliberate departure may release it.

### Batched writes and compensation

`data.setFields` sets 1–64 fields on one record. The service sorts the field IDs and expands
the request into `data.setField` operations: one transaction, key and revision, one version
step per field, all or nothing. Compensation reverses the field operations together from the
revision's final record version; a later edit conflicts without a partial inverse. Any
revision of record changes, creates included, is reversed whole
([ADR-0023](../decisions/0023-a-view-undoes-its-own-revisions.md)); a revision that also
changes the definition or a package is not.

A record's keep mark
([ADR-0022](../decisions/0022-new-file-keeping-the-records-an-application-ships-with.md))
moves no version. A batch may set a mark beside its create or update, and one keep call marks
up to 200 records of any types as one revision. Reversing restores every previous mark with
the record writes, and is refused when any mark changed since
(`SqliteNendoStore.Compensation.cs`).

Hierarchy moves bind the complete request to their receipt before expanding against current
geometry. An exact retry replays the original revision and touched records after sibling
reorders or a reopen; changed terms under the same key are refused. A fresh move's versions
include automatic-action changes to the moved record. A replay carries the
historical outcome, so reread the record before a new edit.

Automatic numbering in a proposal depends on the counters its clone allocated from;
promotion reports staleness if they advance and never changes a reviewed code silently.
Installing or changing a sequence depends on the data revision its seed was computed from.
Preview reserves no code.

### Proposal acceptance

Acceptance carries the proposal ID and the reviewed operation digest. Under its gate the
coordinator checks that digest against the pending proposal or its committed receipt, so a
delayed acceptance cannot apply different content under an uncommitted ID. The Workbench
always sends the digest; compatibility service callers may omit it. Below Unattended there
is no MCP promotion tool; at Unattended `nendo.change_set.accept` promotes with the reviewed
digest ([MCP interface](mcp-interface.md#unattended-acceptance)).

An interrupted acceptance is reconciled read-first like a save: **Acceptance unconfirmed**,
and an explicit retry when no receipt exists. A not-applied outcome keeps its review and is
never announced as accepted. A proposal unavailable after session retirement is not
recreated: the coordinator checks for a canonical receipt under its gate before returning
`proposal-not-found`, and returns the committed outcome if one exists. A receipt for another
digest cannot acknowledge the retained request.

## MCP clients

1. Authenticate to the current endpoint and acquire a lease. Save its `receiptContext` with
   the exact mutation key and input **before** sending a write.
2. After a lost response, call `nendo.data.get_receipt` with that context and key. `state:
   committed` carries the original receipt, with `generatedChanges` (the records the write's
   actions touched, each with its kind of change and `recordVersion` null); an idempotent
   replay carries the same list as `alsoChanged`. `state: unresolved` carries
   `receipt: null`, `revisions: null` and a `message`; nulls are serialized because the
   output schema lists them as required. Read a record before writing to it; no read is
   needed to learn which records changed.
3. After reconnect or reopen, rediscover and authenticate to the current endpoint. The old
   context stays a read-only history locator for the same application and instance, not a
   credential, lease, mutation scope or edit permission. Renewing another connection's old
   lease fails.
4. A missing receipt does not authorize a new key. An exact retry can use the original lease
   and context while that authority exists. After revocation, keep the unresolved request and
   inspect the file with the owner.

The locator holds a bounded file identity, the old host-run identity and the old
server-derived transport pseudonym, and no physical path. It is unsigned, since reads need
only access to the current endpoint; only the lookup tool interprets it. Writable contexts
come from the current transport and lease checks.

## File lifecycle outcomes and limits

File operations do not all append an active-file revision, and they do not share
data-mutation idempotency scopes.

| Path | Evidence and retry boundary | Tests |
| --- | --- | --- |
| Backup | Verified activation is no-overwrite and keeps the source. The same live plan replays only against the same physical destination and result. After restart the volatile confirmation is gone; Nendo neither invents a replay nor overwrites the destination. Inspect the destination first. A missing confirmation is unresolved, not proof of rollback or permission to write a second result. | [BackupTests](../../tests/Nendo.Engine.Tests/BackupTests.cs) |
| Duplicate / Fork | Identity-transition evidence in the destination permits reconstruction and exact replay after reopen, checking source, result digest, physical destination and lineage. A lost or replaced result does not authorize recreation. | [IdentityCopyTests](../../tests/Nendo.Engine.Tests/IdentityCopyTests.cs) |
| New file of the application | `CreateNewFileAsync` stages a copy, transforms it, checks the post-vacuum content and the read-back New transition, then activates with no overwrite under a handle excluding writes and deletion; the source stays byte-identical. Read-only sources get the same preview. The same request in the same session answers with the file it made; a later request to an existing destination is refused. A kept record pointing at a left-out one refuses before any file is made. | [NewFileTests](../../tests/Nendo.Engine.Tests/NewFileTests.cs), [ReviewStorageRegressionTests](../../tests/Nendo.Engine.Tests/ReviewStorageRegressionTests.cs) |
| Restore / upgrade | A permanent receipt and a pending recovery marker precede namespace replacement; the original is kept. Errors after retirement are interrupted recovery. On restart Nendo inspects the receipt and exact files and never reruns replacement or guesses a stage. | [RestoreInterruptionTests](../../tests/Nendo.Engine.Tests/RestoreInterruptionTests.cs), [RestoreTests](../../tests/Nendo.Engine.Tests/RestoreTests.cs), [UpgradeLifecycleTests](../../tests/Nendo.Engine.Tests/UpgradeLifecycleTests.cs), [LegacyUpgradeTests](../../tests/Nendo.Engine.Tests/LegacyUpgradeTests.cs) |
| Desktop replacement reopen | A completed result survives a failed refresh or fresh-session admission; a substituted result is never adopted. Editing and agent access stay off, with a recovery notice and retained receipt. Delayed old requests stay rejected. | [DesktopReplacementTests](../../tests/Nendo.Desktop.Tests/DesktopReplacementTests.cs), [WorkbenchLifecycleTests](../../tests/Nendo.Desktop.Tests/WorkbenchLifecycleTests.cs), [DesktopReplacementResolutionTests](../../tests/Nendo.Desktop.Tests/DesktopReplacementResolutionTests.cs) |
| File-action presentation | The completed notice survives a separately bounded view refresh, a derived-refresh failure and a screen's own later reads. Refresh view reads only and clears the notice on success. Generic I/O errors say a result can exist and to inspect before a retry, and never suggest another destination. | [DesktopFileActionOutcomeTests](../../tests/Nendo.Desktop.Tests/DesktopFileActionOutcomeTests.cs), [WorkbenchErrorPrivacyTests](../../tests/Nendo.Desktop.Tests/WorkbenchErrorPrivacyTests.cs), [Review-OutcomeRuntime.mjs](../../tools/Review-OutcomeRuntime.mjs) |
| Write ceiling | A mutation is refused before staging when the file reaches a ceiling; that reserve is an early check a supported batch can exceed. Direct writes and promoted change sets also measure the expanded transaction, actions included, against the page-byte, schema-object, per-table-row and live-record open bounds before commit. Overflow rolls back everything; the refusal says nothing changed and the file still opens. History warns from 80% of the operation-row bound and offers folding after a backup. A file already past an open bound has no normal data route. | [FileInspectionTests](../../tests/Nendo.Engine.Tests/FileInspectionTests.cs), [ReviewStorageRegressionTests](../../tests/Nendo.Engine.Tests/ReviewStorageRegressionTests.cs), [ExtensionPackageTests](../../tests/Nendo.Engine.Tests/ExtensionPackageTests.cs) |

When only the post-action snapshot is unavailable, the bridge returns the typed file-action
envelope with `session: null`, the known notice and a sanitized refresh notice; otherwise it
returns the usual success snapshot. Native recovery presentation stays available.

These paths do not provide universal file-operation replay after restart, physical
power-loss atomicity, cloud-sync safety or installer qualification.
