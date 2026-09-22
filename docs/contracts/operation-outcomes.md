# Operation outcomes contract

How a client learns whether an operation committed, and what a lost response does
and does not permit. Existing revision, operation, idempotency and proposal audit
evidence is the commit authority; retry scratch and proposal workspaces are
derivatives. Implements ADRs 0005-0007 and 0009, and adds no file format or
second transaction log.

ADR-0008 is delivered, and an initiating edit and the operations its actions
generate share this receipt and transaction authority. A calculation error may
still permit valid input; an action failure rolls back the whole chain and
preserves editor input. The [isolated experiment](../design/adr-0008-evidence.md)
that established the distinction, and the form-retention fix it required, are
history. The outcome a write returns names the records its actions also changed,
so a client learns about a generated write from the same receipt as the one it
asked for.

## Outcome contract

| Observation | Meaning and next action |
| --- | --- |
| A mutation receipt or an applied promotion result is returned | The operation committed. A failed refresh does not reverse it. Retain the receipt and refresh separately. |
| Receipt lookup finds the stable operation identity | Return the original revision/digest/counters, marked as replay. Current validated file authority remains independent of these historical counters. |
| Receipt lookup finds nothing | The outcome is unresolved. The read does not prove that no delayed request can arrive. Do not invent a new key or announce rollback. |
| Outside file/audit drift, stale file generation or lost write ownership | Fail closed. A receipt locator does not restore authority. Reopen/recovery and fresh endpoint authentication remain required. |
| Committed proposal workspace cleanup fails | Preserve the successful result, report `CleanupPending`, and retry derivative cleanup. Never delete another live unaccepted proposal. |

Data/compensation lookup is available through
`NendoApplicationService.GetMutationReceiptAsync`; proposal lookup uses
`GetProposalReceiptAsync`. Lookup validates current authority, including audit
and inverse evidence. A present historical receipt is not a current record
snapshot. Promotion replay uses the committed proposal identity and digest and
does not replace the active file with a clone.

## Workbench

Protocol 5 provides `data.getReceipt`, `history.getCompensationReceipt` and
`proposal.getReceipt`. The native adapter supplies scopes and enforces the
opaque file-session generation; older bridge protocols cannot use these methods.

Before dispatching a data create, field edit, command, compensation or proposal acceptance, the
Desktop Workbench retains the exact method, key and payload in device-local
storage, keyed by application and instance identity. There is at most one
pending request per file and a 131,072-character envelope limit. Failure to
retain it prevents dispatch. This scratch can contain the submitted field
values; it is removed on acknowledgement and is not part of the portable file.

Renderer startup checks a retained identity against the canonical receipt. It
does not replay a missing receipt automatically. An unresolved save displays
**Save unconfirmed**, retains its exact input and blocks new mutation keys.
**Check or retry save** first queries the outcome, then, only on that explicit
action, may submit the original input/key to the current file session. A file
switch prevents a late response from querying or mutating the new file.
Cleanup failure cannot hide an already returned receipt or erase a newer
pending request. Native Studio, file controls and recovery remain available.

`data.setFields` is a protocol-5 typed convenience request for 1–64 fields on
one record. The service sorts semantic field IDs and expands it into existing
`data.setField` operations before canonicalization. One form save therefore
uses one transaction, key and revision; record version advances for each typed
field operation. A failure in any field rolls back the entire revision.
Compensation reverses the retained field operations together, using the final
record version from that revision. A later edit conflicts without a partial
inverse. This does not extend compensation to arbitrary multi-operation,
multi-record or irreversible revisions.

Proposal acceptance retains the proposal ID and the reviewed operation digest.
The current Workbench sends both; the coordinator checks that digest under its
gate against either the pending proposal or its committed receipt. A delayed
acceptance cannot apply different content reusing an uncommitted proposal ID.
Compatibility service callers may omit the digest; the current owner-facing
Workbench acceptance paths do not. This does not add an MCP promotion tool.

An interrupted acceptance uses the same read-first reconciliation as a data
save, displays **Acceptance unconfirmed**, and requires an explicit retry when
no receipt exists. A not-applied outcome retains its review/diagnostics and is
never announced as accepted. A proposal unavailable after session retirement
is not silently recreated. Its unavailable error follows a canonical receipt
check under the coordinator gate. A receipt for a different digest cannot
acknowledge the retained request.

## MCP clients

1. Authenticate to the current local endpoint and acquire a lease normally.
   Save its `receiptContext` together with the exact mutation key and input
   **before** sending a write.
2. After a lost response, call `nendo.data.get_receipt` with that context and
   the original key. A result with `state: committed` contains the original
   receipt. A result with `state: unresolved` has no receipt (the absent optional
   member is omitted by MCP serialization). A committed receipt carries
   `generatedChanges`, the records the write's automatic actions touched, each
   with the kind of change and `recordVersion` null, and an idempotent replay
   carries the same under `alsoChanged`: the file may have moved since, so read
   a record before writing to it, but nothing has to be read to learn which.
3. After reconnect or file reopen, rediscover and authenticate to the current
   endpoint. The old context remains a read-only history locator for the same
   application/instance. It is not a credential, transferable lease, mutation
   scope or permission to edit. Renewing another connection's old lease fails.
4. A missing receipt does not authorize a new key. An exact retry can use the
   original valid lease/context while that authority exists. After revocation,
   retain the unresolved request and inspect the current file with the owner;
   do not silently reconstruct old write authority under a new lease.

The locator contains bounded file identity, old host-run identity and the old
server-derived transport pseudonym. It contains no physical path and need not be
signed: reads need no authority beyond reaching the current endpoint. Only the
closed lookup tool interprets it. Writable contexts
continue to come from the current server transport and lease checks.

Official MCP SDK tests cover actual HTTP cancellation after commit, lost
responses, reconnect, host replacement and coordinator close/reopen. They do
not establish a new installed-client journey.

## File lifecycle outcomes and limits

File operations do not all append an active-file revision, and they do not share
data-mutation idempotency scopes:

| Path | Authoritative evidence and retry boundary | Current executed regression source |
| --- | --- | --- |
| Backup | Verified activation is no-overwrite and preserves the source. The same live plan can replay only against the same physical destination/result. After restart the old volatile confirmation is unavailable; Nendo refuses to invent a replay or overwrite its existing destination. Inspect the destination before a new action. | [BackupTests](../../tests/Nendo.Engine.Tests/BackupTests.cs): cancellation on each side of activation, lost response, exact retry, replacement refusal, restart refusal and SQLite capacity failure |
| Duplicate / Fork | Destination canonical identity-transition evidence permits reconstruction and exact replay after reopen. Source, result digest, physical destination and typed lineage are checked. Loss or replacement of a committed result does not authorize recreation. | [IdentityCopyTests](../../tests/Nendo.Engine.Tests/IdentityCopyTests.cs): activation faults/cancellation, lost response, reopen, changed request/source/result and concurrent destination activation |
| Restore / upgrade | A permanent receipt and pending recovery marker precede namespace replacement. The original is retained. After retirement, errors are classified as interrupted recovery; restart inspects the receipt and exact files instead of rerunning replacement or guessing an active stage. | [RestoreInterruptionTests](../../tests/Nendo.Engine.Tests/RestoreInterruptionTests.cs), [RestoreTests](../../tests/Nendo.Engine.Tests/RestoreTests.cs), [UpgradeLifecycleTests](../../tests/Nendo.Engine.Tests/UpgradeLifecycleTests.cs), [LegacyUpgradeTests](../../tests/Nendo.Engine.Tests/LegacyUpgradeTests.cs) |
| Desktop replacement reopen | A completed result survives cancelled/failed refresh or fresh-session admission. A substituted result cannot be adopted; editing/agent access stays off with an explicit recovery notice and retained receipt. Delayed old requests remain rejected. | [DesktopReplacementTests](../../tests/Nendo.Desktop.Tests/DesktopReplacementTests.cs), [WorkbenchLifecycleTests](../../tests/Nendo.Desktop.Tests/WorkbenchLifecycleTests.cs), [DesktopReplacementResolutionTests](../../tests/Nendo.Desktop.Tests/DesktopReplacementResolutionTests.cs) |
| File-action presentation | The native completed notice survives a separately bounded, nullable view refresh. Workbench retains the notice across derived-refresh failure, and across the reads a screen makes on its own account afterwards, and offers Refresh view, which performs reads only and takes the notice with it when it succeeds. Generic I/O errors state that a result may exist and direct inspection before retry; they do not suggest choosing another destination for an unresolved action. | [DesktopFileActionOutcomeTests](../../tests/Nendo.Desktop.Tests/DesktopFileActionOutcomeTests.cs), [WorkbenchErrorPrivacyTests](../../tests/Nendo.Desktop.Tests/WorkbenchErrorPrivacyTests.cs), [real Desktop probe](../../tools/Review-OutcomeRuntime.mjs) |
| Write ceiling | A mutation is refused before anything is staged once the file has reached a ceiling sitting a stated reserve below either open bound — bytes and audit rows both, because they are reached by different files. The refusal names what was measured, says nothing was changed and says the file still opens, and it reads the same whether the write arrived as a mutation or as a promoted change set. Nendo cannot write a file it will not open. It does not warn on approach, and it gives a file already over a bound no route back to its data. | [FileInspectionTests](../../tests/Nendo.Engine.Tests/FileInspectionTests.cs): the refusal on both write paths with the file still opening afterwards, and the largest accepted commit measured against the reserve |

Protocol 5 preserves the usual create/open success snapshot. When only the
post-action snapshot is unavailable, it returns the typed file-action envelope
with `session: null`, the known notice and a sanitized refresh notice. Current
Workbench handles both. Native recovery presentation stays available.

These tests are rerun in the checkpoint-4 full gate. They do not establish
universal file-operation replay after restart, physical power-loss atomicity,
cloud-sync safety or installer qualification. In particular, a missing backup
confirmation remains unresolved; it is not proof of rollback or permission to
write a second result. This preserves the accepted backup boundary.
