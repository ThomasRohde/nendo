*Brought back from the task-owned scratch directory `artifacts/mcp-review-20260914/`, where the reviewing client wrote it beside 223 request/response evidence files. That directory has since been swept, so the evidence files no longer exist anywhere; their names are named below as the record of what was captured, and are not links. The findings are answered in the contracts, the roadmap and code; this report is a record of what an outside client met on that day and is not edited to match.*

# Running Nendo MCP test — 14 September 2026

Endpoint: http://127.0.0.1:41763/mcp. Server: nendo-local 0.5.0. This is an installed-host MCP exercise, not an independent blackbox review: repository guidance and the MCP contract were read. No product source was modified or rebuilt. All test scripts and evidence are in this task-owned scratch directory.

## Scope and fixture

The user authorized using the current empty file. Its initial definition/data revisions and change sequence were all zero. Two user-accepted proposals built an Observatory fixture: two entities, all eight scalar storage kinds, a required title, choice metadata through declared options, a bound reference, eight root screens spanning all six root kinds, tabs, sections, a related list and summary, filters, and a two-step command. The second proposal added a reusable function, eight calculations covering all four binding kinds and all three behaviour aggregates, conditional visibility, an action and Created trigger. It renamed a populated field, retired notes with retained data, and made amount/done required. Minimum host version is now 1.18.0.

This is deliberate test data and test history in the owner-approved fixture. It was not restored to an empty file. The user reported approving automatic actions; the first successful post-acceptance write therefore does not test the absence of consent.

## Findings ranked

1. **Malformed page limits return an internal error.** resources/read of nendo://application/history?limit=abc, limit=1.5, limit=2147483648 and an empty limit returns JSON-RPC -32603, “An error occurred.” Numeric 0, -1 and 101 instead return -32602 with NENDO_INVALID_LIMIT and the useful 1–100 remedy. Minimal evidence: alphabetic limit (`history-invalid-limit.json`). This is an input-classification and diagnostic defect; no corruption or crash was observed.
2. **A frozen proposal is reported as missing.** A valid amend against the still-existing previewable behaviour proposal returns NENDO_CHANGE_SET_NOT_FOUND: “The application change set could not be completed.” The correct problem is that the proposal is frozen. Reproduction (`frozen-valid-amend.json`).
3. **An attempted calculated-field write says the field does not exist.** review_half is published and successfully calculated, but data.set_field returns NENDO_FIELD_NOT_FOUND instead of explaining that it is calculated and read-only. Reproduction (`calculated-write-refusal.json`). The write is blocked; the defect is the remedy given to the caller.
4. **Receipt lookup omits the generated-change details returned by the original write.** The trigger-success response reports review_scope updated to version 2 in alsoChanged. get_receipt returns committed with the same revision but generatedChanges: []. This identifies the commit, but a client recovering a lost response must re-read to learn the side effect. Write (`trigger-success.json`), receipt (`trigger-receipt.json`). Recorded as a recovery-information limitation; no duplicate execution was observed.
5. **An optional null action target silently means no effect.** Creating an observation without an instrument succeeded and reported no generated changes. The test initially expected a refusal; that expectation was wrong for the observed host. The temporary record was then deleted through MCP. The catalogue explains binding shapes but does not make this target-selection result apparent. Creation (`trigger-missing-target.json`), cleanup (`remove-null-target-test.json`).

6. **Unconstrained operation payload schemas trigger an Inspector portability warning.** The user-provided MCP Inspector screenshot shows zero errors and one warning for nendo.change_set.amend at `inputSchema.properties.mutations.items.properties.operations.items.properties.payload`. The captured tools/list response (`tools-list.json`) confirms that both amend and add_operations advertise this payload with only a description and no validation keywords. That is legal JSON Schema accepting any JSON value, but the Inspector warns that some MCP clients refuse or mishandle it. No failure in another client was reproduced.

   Cause: [NendoAuthoringContracts.cs](../../src/Nendo.LocalMcp/NendoAuthoringContracts.cs) declares `JsonElement Payload`, producing an unconstrained schema. [NendoAgentAuthoringService.cs](../../src/Nendo.LocalMcp/NendoAgentAuthoringService.cs), in ValidateOperation, actually requires a JSON object and validates the operation-specific permitted keys. The advertised input schema is broader than the runtime contract.

   Recommended fix: advertise `{"type":"object","additionalProperties":true}` for these object-only payloads. Audit other object-only value maps for the same mismatch, while preserving scalar/null alternatives for individual field values that legitimately accept them. Full operation-specific schemas are a separate enhancement. Add a regression check over the advertised input schemas, confirm non-object payloads still fail runtime validation, and rerun the Inspector to check that this specific warning disappears. Do not assume every warning badge in the screenshot has the same cause. No implementation change has been made.

   Coverage correction: the earlier audit checked successful **output** structures, not **input-schema portability**. Its zero mismatches did not cover this warning. The screenshot is user-supplied UI evidence; the matching schema and runtime object constraint were independently inspected.

## What the running host demonstrated

| Area | Literal outcome |
| --- | --- |
| Discovery | 8 fixed resources, 4 templates, 17 advertised tools; every tool exercised; describe consistent with empty baseline and accepted fixture |
| Protocol eras | server/discover accepted 2026-07-28 metadata; initialize accepted 2025-11-25; no credential used |
| Guards | Explicit raw HTTP Host example.invalid -> 400 NENDO_INVALID_HOST; foreign Origin and Origin null -> 403 NENDO_INVALID_ORIGIN; malformed JSON -> 400 NENDO_INVALID_JSON; unsupported protocol -> 400 |
| Lease | Acquire, status isYou, renew, competing acquisition refusal, forged release refusal, explicit release, revoked-handle renew refusal; no lease intentionally left held |
| Drafts | Begin replay returned same ID; invalid payload/operation refused; invalid validation then amend/revalidate recovered; reject removed task drafts; validated proposals left active revision unchanged until native acceptance |
| Proposal limits | 17 operations rejected with 1–16 remedy; 2049-character formula rejected with 2048 remedy |
| Data types | Exact numeric lexemes 9007199254740993 and 123.4500 retained; Unicode, multiline text, Boolean, Date, DateTime, UUID and reference label read back |
| Validation | Missing required value, bad choice, fractional integer, invalid date/UUID/Boolean, unknown field refused; mixed valid/invalid batch did not advance change sequence |
| Batch bounds | 51 records and duplicate record IDs refused |
| Concurrency | Stale record version refused; stale reference-target version refused; intervening write invalidated cursor; 8 concurrent describe reads completed, 27–39 ms |
| Pagination | Record pages had no missing/duplicate IDs; history and operation pages followed advertised cursor order |
| Commands | Two steps changed status and done atomically, record version 2 -> 4; exact retry returned same commit |
| Deletion | Referenced instrument deletion refused naming referring record; standalone observation deleted; exact retry did not repeat mutation |
| Receipts | Exact create/command/delete retries returned original revision; different payload with same key refused; receipt readable after release; absent receipt remained unresolved |
| Calculations | Reusable function and dependent calculation returned 61.7250 and 123.4500; reference traversal returned instrument label, absent reference read empty; Count/FilteredCount/Sum worked; empty aggregates returned zero; divide by zero returned calculation-divide-by-zero; 1 / 2 returned 0.5 |
| Action | Created observation updated referenced instrument to Active, version 2, same revision with two operations; alsoChanged named side effect; replay did not execute again; related sum became 130.0000 |
| Definition refusals | Unknown formula function, unknown binding key, calculated sorting/filtering/grouping/totalling, calculated-only form, removal of used function/calculation, unknown UI SQL property refused |
| Escape routes | No advertised SQL/filesystem/process/promotion/device-approval operation; explicit unknown SQL, promotion, approval and compensation tool names refused |
| Retained state | Renaming title preserved stable ID and value; retired notes remained in record reads and ordinary write to retired field refused |
| Health | Initial unchanged integrity request used cached result; after writes rescanned=true with normal/ok at sequence 10, immediate repeat rescanned=false |
| Output structure | Initial audit checked 91 successful tool responses for advertised required fields, JSON types and enums; no mismatches. This is a scoped output structural check, not a full JSON Schema format validator or an input-schema portability audit; see finding 6 |

## Acceptance still in progress

Native compensation of revision-458638d4acd04806a9645fe6f0c68075, a write with device approval revoked, and file reopen checks are pending user interaction. A follow-up section will record their outcomes. Human visual correctness, keyboard/accessibility, Light/Dark, CSV round trip, long-running cancellation, installer, process crash/power loss and large-data performance are not measured by these MCP calls.

## Commands and harness limitations

Executed node artifacts/mcp-review-20260914/discover.mjs, reads.mjs, proposals.mjs, transport.mjs, data.mjs, behaviour.mjs, behaviour-retry.mjs, actions.mjs, actions-resume.mjs, negative2.mjs, final-probes.mjs, host-schema.mjs and audit.mjs. Each completed phase writes its requests and responses beside this report. Scripts are a phased test record, not safe to replay wholesale against an already populated file.

- data.mjs completed its CRUD assertions. behaviour.mjs initially stopped on an honest validation refusal: FilteredCount needed a non-optional predicate. behaviour-retry.mjs first made the populated predicate/amount required, then validated successfully. The first invalid response remains retained.
- actions.mjs stopped because its expected null-reference refusal did not occur. actions-resume.mjs recorded the actual no-effect behavior, removed the temporary record and completed the trigger assertions.
- The first transport harness run failed writing an evidence filename containing URL-encoded slashes; the filename sanitizer was corrected and the read-only transport probes rerun.
- Node fetch did not send the requested Host override. Its 200 response is not a guard bypass. The explicit node:http probe sent the header and received 400.
- Python jsonschema was absent; no package was installed. The structural checker checks only the declared keyword subset noted above.
- pwsh -NoProfile -File tools/Test-Repository.ps1: **Repository verification passed.** Full log: repository-gate.log (`repository-gate.log`). No restore/build/.NET suite/installer lane ran, because this task tests the already-running host and changes no product code.
- git status initially hit the sandbox ownership interlock. A command-scoped safe.directory allowed read-only inspection. Existing tracked changes outside this scratch directory were not edited or cleaned.

Recorded RPC evidence files so far: 223. Distinct invoked tool names including deliberately unavailable ones: 21.

## Refusal evidence

| Probe | Literal refusal |
| --- | --- |
| atomic-batch-refusal (`atomic-batch-refusal.json`) | An error occurred invoking 'nendo.data.create_records': NENDO_INVALID_REQUEST: Required field review_title needs a value. |
| bad-binding-key (`bad-binding-key.json`) | An error occurred invoking 'nendo.change_set.add_operations': NENDO_INVALID_REQUEST: Mutation 0, operation 0 (behaviour.setDefinition 'review.calc.half'): Binding 'amount' of 'review.calc.half' has a key this contract does not define: bogus. A SameRecordField binding takes bindingId, kind, entityId, fieldId, resultType, nullable. |
| bad-payload (`bad-payload.json`) | An error occurred invoking 'nendo.change_set.add_operations': NENDO_INVALID_REQUEST: schema.createEntity does not take unexpected; it takes entityId, displayName. |
| batch-51-records (`batch-51-records.json`) | An error occurred invoking 'nendo.data.create_records': NENDO_INVALID_REQUEST: A batch create carries 1-50 records; this one carries 51. |
| batch-duplicate-ids (`batch-duplicate-ids.json`) | An error occurred invoking 'nendo.data.create_records': NENDO_INVALID_REQUEST: A batch create requires distinct record IDs. |
| boolean-invalid (`boolean-invalid.json`) | An error occurred invoking 'nendo.data.create_record': NENDO_INVALID_REQUEST: Value for field review_done does not match storage kind Boolean. |
| calculated-write-refusal (`calculated-write-refusal.json`) | An error occurred invoking 'nendo.data.set_field': NENDO_FIELD_NOT_FOUND: Field review_half does not exist on entity review_observation. |
| choice-invalid (`choice-invalid.json`) | An error occurred invoking 'nendo.data.create_record': NENDO_INVALID_REQUEST: Value for field review_status is not one of its declared choices (Planned, Done); received "Unknown". |
| date-invalid (`date-invalid.json`) | An error occurred invoking 'nendo.data.create_record': NENDO_INVALID_REQUEST: Value for field review_date must use the yyyy-MM-dd date format. |
| delete-referenced (`delete-referenced.json`) | An error occurred invoking 'nendo.data.delete_record': NENDO_RECORD_REFERENCED: 1 Test observations record still points at this one through instrument_ref (review_obs_01). Clear or reassign those references before deleting it. |
| extra-read-endo%3A%2F%2Fapplication%2Fhistory%3Flimit%3D2147483648 (`extra-read-endo_3A_2F_2Fapplication_2Fhistory_3Flimit_3D2147483648.json`) | An error occurred. |
| extra-read-nendo%3A%2F%2Fapplication%2Fapproval (`extra-read-nendo_3A_2F_2Fapplication_2Fapproval.json`) | Unknown resource URI: 'nendo://application/approval' |
| extra-read-nendo%3A%2F%2Fapplication%2Fhistory%3Flimit%3D (`extra-read-nendo_3A_2F_2Fapplication_2Fhistory_3Flimit_3D.json`) | An error occurred. |
| extra-read-nendo%3A%2F%2Fapplication%2Fhistory%3Flimit%3D1.5 (`extra-read-nendo_3A_2F_2Fapplication_2Fhistory_3Flimit_3D1_5.json`) | An error occurred. |
| extra-read-nendo%3A%2F%2Fapplication%2F..%2F..%2F..%2Fwindows (`extra-read-nendo_3A_2F_2Fapplication_2F___2F___2F___2Fwindows.json`) | Unknown resource URI: 'nendo://application/../../../windows' |
| formula-over-limit-amend (`formula-over-limit-amend.json`) | An error occurred invoking 'nendo.change_set.amend': NENDO_INVALID_REQUEST: Mutation 0, operation 0 (behaviour.setDefinition 'review.bad'): A formula is limited to 2048 characters. |
| frozen-amend (`frozen-amend.json`) | An error occurred invoking 'nendo.change_set.amend': NENDO_CHANGE_SET_LIMIT: One call carries 1-8 mutations; this one carries 0. |
| frozen-valid-amend (`frozen-valid-amend.json`) | An error occurred invoking 'nendo.change_set.amend': NENDO_CHANGE_SET_NOT_FOUND: The application change set could not be completed. |
| history-invalid-cursor (`history-invalid-cursor.json`) | NENDO_INVALID_CURSOR: The page cursor is invalid or belongs to an earlier agent-access session. |
| history-invalid-limit (`history-invalid-limit.json`) | An error occurred. |
| history-negative (`history-negative.json`) | NENDO_INVALID_LIMIT: Page limits must be between 1 and 100. |
| history-over (`history-over.json`) | NENDO_INVALID_LIMIT: Page limits must be between 1 and 100. |
| history-zero (`history-zero.json`) | NENDO_INVALID_LIMIT: Page limits must be between 1 and 100. |
| idempotency-conflict (`idempotency-conflict.json`) | An error occurred invoking 'nendo.data.create_record': NENDO_IDEMPOTENCY_CONFLICT: The idempotency key was already used for a different request. |
| integer-fraction (`integer-fraction.json`) | An error occurred invoking 'nendo.data.create_record': NENDO_INVALID_REQUEST: Value for field review_count does not match storage kind Integer. |
| invalid-receipt (`invalid-receipt.json`) | An error occurred invoking 'nendo.data.get_receipt': NENDO_INVALID_REQUEST: A bounded receipt locator and idempotency key are required. |
| lease-competing (`lease-competing.json`) | An error occurred invoking 'nendo.lease.acquire': NENDO_LEASE_HELD: Another local agent currently has edit access. |
| lease-forged-release (`lease-forged-release.json`) | An error occurred invoking 'nendo.lease.release': NENDO_INVALID_LEASE: A valid application handle and edit lease are required. |
| operation-over-limit (`operation-over-limit.json`) | An error occurred invoking 'nendo.change_set.add_operations': NENDO_CHANGE_SET_LIMIT: One call carries 1-16 operations in total; this one carries 17. |
| pending-write-refusal (`pending-write-refusal.json`) | An error occurred invoking 'nendo.data.create_record': NENDO_ENTITY_NOT_FOUND: The semantic precondition was not met. A validated proposal that changes this ID is waiting for someone to accept it in Nendo: "MCP thorough test — Observatory fixture" (proposal-ecc1973a5b1bbdcb0e936be6b9063295). Definition changes reach the file only on acceptance, so a write that depends on one fails until then. There is no promotion tool; ask the person to accept it, or reject it with nendo.change_set.reject. |
| released-renew (`released-renew.json`) | An error occurred invoking 'nendo.lease.renew': NENDO_INVALID_LEASE: A valid application handle and edit lease are required. |
| required-missing (`required-missing.json`) | An error occurred invoking 'nendo.data.create_record': NENDO_INVALID_REQUEST: Required field review_title needs a value. |
| retired-write-refusal (`retired-write-refusal.json`) | An error occurred invoking 'nendo.data.set_field': NENDO_FIELD_RETIRED: The semantic precondition was not met. |
| stale-record-cursor (`stale-record-cursor.json`) | NENDO_STALE_CURSOR: The semantic precondition was not met. |
| stale-record-version (`stale-record-version.json`) | An error occurred invoking 'nendo.data.set_field': NENDO_RECORD_VERSION_CONFLICT: Record review_obs_01 is version 2, not 1. |
| stale-reference-target (`stale-reference-target.json`) | An error occurred invoking 'nendo.data.set_field': NENDO_TARGET_VERSION_CONFLICT: The selected target changed. Select it again before saving. |
| unavailable-nendo.behaviour.approve (`unavailable-nendo_behaviour_approve.json`) | An error occurred invoking 'nendo.behaviour.approve': NENDO_TOOL_UNAVAILABLE: The requested tool is not available. |
| unavailable-nendo.change_set.promote (`unavailable-nendo_change_set_promote.json`) | An error occurred invoking 'nendo.change_set.promote': NENDO_TOOL_UNAVAILABLE: The requested tool is not available. |
| unavailable-nendo.data.compensate (`unavailable-nendo_data_compensate.json`) | An error occurred invoking 'nendo.data.compensate': NENDO_TOOL_UNAVAILABLE: The requested tool is not available. |
| unknown-field (`unknown-field.json`) | An error occurred invoking 'nendo.data.create_record': NENDO_INVALID_REQUEST: Field unknown is not part of entity review_observation. |
| unknown-operation (`unknown-operation.json`) | An error occurred invoking 'nendo.change_set.add_operations': NENDO_UNKNOWN_OPERATION: Operation type 'sql.execute' is not one this host implements; nendo://application/vocabulary lists the 19 it accepts under operations. |
| unknown-records (`unknown-records.json`) | NENDO_ENTITY_NOT_FOUND: The semantic precondition was not met. |
| unknown-resource (`unknown-resource.json`) | Unknown resource URI: 'nendo://application/unknown' |
| unknown-revision (`unknown-revision.json`) | NENDO_REVISION_NOT_FOUND: The semantic precondition was not met. |
| unknown-schema (`unknown-schema.json`) | NENDO_ENTITY_NOT_FOUND: The requested entity does not exist. |
| unknown-tool (`unknown-tool.json`) | An error occurred invoking 'nendo.sql.execute': NENDO_TOOL_UNAVAILABLE: The requested tool is not available. |
| uuid-invalid (`uuid-invalid.json`) | An error occurred invoking 'nendo.data.create_record': NENDO_INVALID_REQUEST: Value for field review_uuid must be a hyphenated UUID. |
| write-fake-authority (`write-fake-authority.json`) | An error occurred invoking 'nendo.data.create_record': NENDO_INVALID_LEASE: A valid application handle and edit lease are required. |

## Final checkpoint

At the final read, definition revision 7, data revision 12, change sequence 19; 2 instruments and 4 observations. Pending proposals: 0. Lease held: false. Integrity: ok, state normal, measured at change sequence 19. Native compensation/revocation response has not yet arrived; those checks and reopen remain pending.
