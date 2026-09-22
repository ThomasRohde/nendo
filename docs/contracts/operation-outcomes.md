# Operation outcomes contract

This contract states how a client learns whether an operation committed. It also
states what a lost response permits and what it does not permit. The existing
revision, operation, idempotency and proposal audit evidence is the commit
authority. Retry scratch and proposal workspaces are derivatives. This contract
implements ADRs 0005-0007 and 0009. It adds no file format and no second
transaction log.

ADR-0008 is delivered. An initiating edit and the operations that its actions
generate share this receipt and transaction authority. A calculation error can
still permit valid input. An action failure rolls back the whole chain and
keeps the editor input. The [isolated experiment](../design/adr-0008-evidence.md)
that established the distinction, and the form-retention fix that it required,
are history. The outcome that a write returns names the records that its actions
also changed. Thus a client learns about a generated write from the same receipt
as the write that it requested.

## Outcome contract

| Observation | Meaning and next action |
| --- | --- |
| A mutation receipt or an applied promotion result is returned | The operation committed. A failed refresh does not reverse it. Keep the receipt and refresh separately. |
| Receipt lookup finds the stable operation identity | Return the original revision/digest/counters, marked as replay. Current validated file authority stays independent of these historical counters. |
| Receipt lookup finds nothing | The outcome is unresolved. The read does not prove that no delayed request can arrive. Do not invent a new key or announce rollback. |
| Outside file/audit drift, stale file generation or lost write ownership | Fail closed. A receipt locator does not restore authority. Reopen/recovery and fresh endpoint authentication are still required. |
| Committed proposal workspace cleanup fails | Keep the successful result, report `CleanupPending`, and retry derivative cleanup. Never delete another live unaccepted proposal. |

Data/compensation lookup is available through
`NendoApplicationService.GetMutationReceiptAsync`. Proposal lookup uses
`GetProposalReceiptAsync`. Lookup validates current authority, which includes
audit and inverse evidence. A historical receipt that is present is not a
current record snapshot. Promotion replay uses the committed proposal identity
and digest. It does not replace the active file with a clone.

## Workbench

Protocol 5 provides `data.getReceipt`, `history.getCompensationReceipt` and
`proposal.getReceipt`. The native adapter supplies scopes and enforces the
opaque file-session generation. Older bridge protocols cannot use these methods.

Before the Desktop Workbench dispatches a data create, field edit, command,
compensation or proposal acceptance, it keeps the exact method, key and payload
in device-local storage. This storage is keyed by application and instance
identity. There is at most one pending request per file, and the envelope limit
is 131,072 characters. If the Workbench cannot keep the request, it does not
dispatch it. This scratch can contain the submitted field values. The Workbench
removes it on acknowledgement, and it is not part of the portable file.

At renderer startup, the Workbench checks a retained identity against the
canonical receipt. It does not replay a missing receipt automatically. An
unresolved save shows **Save unconfirmed**, keeps its exact input and blocks new
mutation keys. **Check or retry save** first queries the outcome. Only on that
explicit action can it then submit the original input/key to the current file
session. A file switch prevents a late response from querying or mutating the
new file. A cleanup failure cannot hide a receipt that was already returned, and
it cannot erase a newer pending request. Native Studio, file controls and
recovery stay available.

`data.setFields` is a protocol-5 typed convenience request for 1–64 fields on
one record. The service sorts the semantic field IDs and expands the request
into existing `data.setField` operations before canonicalization. Thus one form
save uses one transaction, one key and one revision. The record version advances
for each typed field operation. If any field fails, the entire revision rolls
back. Compensation reverses the retained field operations together, and it uses
the final record version from that revision. A later edit conflicts without a
partial inverse. This does not extend compensation to arbitrary
multi-operation, multi-record or irreversible revisions.

Proposal acceptance keeps the proposal ID and the reviewed operation digest.
The current Workbench sends both. Under its gate, the coordinator checks that
digest against the pending proposal or against its committed receipt. A delayed
acceptance cannot reuse an uncommitted proposal ID to apply different content.
Compatibility service callers may omit the digest. The current owner-facing
Workbench acceptance paths do not omit it. This does not add an MCP promotion
tool.

An interrupted acceptance uses the same read-first reconciliation as a data
save. It shows **Acceptance unconfirmed**, and it requires an explicit retry
when no receipt exists. A not-applied outcome keeps its review/diagnostics, and
the Workbench never announces it as accepted. If a proposal is unavailable after
session retirement, the Workbench does not recreate it silently. The
coordinator checks for a canonical receipt under its gate before it returns the
unavailable error (`proposal-not-found`). If a receipt exists, the coordinator
returns the committed outcome. A receipt for a different digest cannot
acknowledge the retained request.

## MCP clients

1. Authenticate to the current local endpoint and acquire a lease normally.
   Save its `receiptContext` together with the exact mutation key and input
   **before** you send a write.
2. After a lost response, call `nendo.data.get_receipt` with that context and
   the original key. A result with `state: committed` contains the original
   receipt. A result with `state: unresolved` has no receipt (MCP serialization
   omits the absent optional member). A committed receipt carries
   `generatedChanges`. This lists the records that the automatic actions of the
   write touched, each with the kind of change and with `recordVersion` null. An
   idempotent replay carries the same list under `alsoChanged`. The file can
   have changed since then, so read a record before you write to it. You do not
   have to read anything to learn which records changed.
3. After reconnect or file reopen, rediscover the current endpoint and
   authenticate to it. The old context stays a read-only history locator for the
   same application/instance. It is not a credential, a transferable lease, a
   mutation scope or permission to edit. If you renew the old lease of another
   connection, the renewal fails.
4. A missing receipt does not authorize a new key. An exact retry can use the
   original valid lease/context while that authority exists. After revocation,
   keep the unresolved request and inspect the current file with the owner.
   Do not silently reconstruct old write authority under a new lease.

The locator contains a bounded file identity, the old host-run identity and the
old server-derived transport pseudonym. It contains no physical path, and it
does not have to be signed: reads need no authority beyond access to the current
endpoint. Only the closed lookup tool interprets the locator. Writable contexts
continue to come from the current server transport and lease checks.

Official MCP SDK tests cover real HTTP cancellation after commit, lost
responses, reconnect, host replacement and coordinator close/reopen. They do
not establish a new installed-client journey.

## File lifecycle outcomes and limits

Not all file operations append an active-file revision. File operations do not
share data-mutation idempotency scopes:

| Path | Authoritative evidence and retry boundary | Current executed regression source |
| --- | --- | --- |
| Backup | Verified activation is no-overwrite and keeps the source. The same live plan can replay only against the same physical destination/result. After restart, the old volatile confirmation is unavailable. Nendo refuses to invent a replay or to overwrite its existing destination. Inspect the destination before a new action. | [BackupTests](../../tests/Nendo.Engine.Tests/BackupTests.cs): cancellation on each side of activation, lost response, exact retry, replacement refusal, restart refusal and SQLite capacity failure |
| Duplicate / Fork | Canonical identity-transition evidence in the destination permits reconstruction and exact replay after reopen. Nendo checks the source, result digest, physical destination and typed lineage. If a committed result is lost or replaced, this does not authorize recreation. | [IdentityCopyTests](../../tests/Nendo.Engine.Tests/IdentityCopyTests.cs): activation faults/cancellation, lost response, reopen, changed request/source/result and concurrent destination activation |
| Restore / upgrade | A permanent receipt and a pending recovery marker come before namespace replacement. The original is kept. After retirement, errors are classified as interrupted recovery. On restart, Nendo inspects the receipt and the exact files. It does not rerun replacement or guess an active stage. | [RestoreInterruptionTests](../../tests/Nendo.Engine.Tests/RestoreInterruptionTests.cs), [RestoreTests](../../tests/Nendo.Engine.Tests/RestoreTests.cs), [UpgradeLifecycleTests](../../tests/Nendo.Engine.Tests/UpgradeLifecycleTests.cs), [LegacyUpgradeTests](../../tests/Nendo.Engine.Tests/LegacyUpgradeTests.cs) |
| Desktop replacement reopen | A completed result survives a cancelled/failed refresh or fresh-session admission. Nendo cannot adopt a substituted result. Editing/agent access stays off, with an explicit recovery notice and a retained receipt. Delayed old requests stay rejected. | [DesktopReplacementTests](../../tests/Nendo.Desktop.Tests/DesktopReplacementTests.cs), [WorkbenchLifecycleTests](../../tests/Nendo.Desktop.Tests/WorkbenchLifecycleTests.cs), [DesktopReplacementResolutionTests](../../tests/Nendo.Desktop.Tests/DesktopReplacementResolutionTests.cs) |
| File-action presentation | The native completed notice survives a view refresh that is bounded separately and nullable. Workbench keeps the notice across a derived-refresh failure. It also keeps the notice across the reads that a screen makes for itself afterwards. Workbench offers Refresh view, which performs reads only and removes the notice when it succeeds. Generic I/O errors state that a result can exist, and they tell the user to inspect before a retry. They do not suggest another destination for an unresolved action. | [DesktopFileActionOutcomeTests](../../tests/Nendo.Desktop.Tests/DesktopFileActionOutcomeTests.cs), [WorkbenchErrorPrivacyTests](../../tests/Nendo.Desktop.Tests/WorkbenchErrorPrivacyTests.cs), [real Desktop probe](../../tools/Review-OutcomeRuntime.mjs) |
| Write ceiling | When the file reaches a ceiling, Nendo refuses a mutation before it stages anything. The ceiling is a stated reserve below each open bound. There is a ceiling for bytes and one for audit rows, because different files reach different bounds. The refusal names what Nendo measured. It states that nothing changed and that the file still opens. It reads the same for a mutation and for a promoted change set. Nendo cannot write a file that it will not open. It does not warn on approach. It gives a file that is already over a bound no route back to its data. | [FileInspectionTests](../../tests/Nendo.Engine.Tests/FileInspectionTests.cs): the refusal on both write paths with the file still opening afterwards, and the largest accepted commit measured against the reserve |

Protocol 5 keeps the usual create/open success snapshot. When only the
post-action snapshot is unavailable, it returns the typed file-action envelope
with `session: null`, the known notice and a sanitized refresh notice. The
current Workbench handles both. Native recovery presentation stays available.

The checkpoint-4 full gate runs these tests again. They do not establish
universal file-operation replay after restart, physical power-loss atomicity,
cloud-sync safety or installer qualification. In particular, a missing backup
confirmation stays unresolved. It is not proof of rollback, and it is not
permission to write a second result. This keeps the accepted backup boundary.
