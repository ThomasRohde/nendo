import type { HelpProvider, HelpTerm } from './help';

export interface SurfaceEntry { name: string; meaning: string }

const noAcceptTool = 'Below Unattended, no tool accepts a proposal: acceptance stays with you, in Nendo.';

/**
 * The closed MCP surface as a person reads it. One list feeds the article, the Node
 * test and Test-Production.ps1, which compares these names with what the host declares:
 * a tool added or a URI changed without a sentence here fails the build.
 */
export const agentSurface: { resources: readonly SurfaceEntry[]; editDataTools: readonly SurfaceEntry[]; shapeAppTools: readonly SurfaceEntry[]; unattendedTools: readonly SurfaceEntry[] } = {
  resources: [
    { name: 'nendo://application/describe', meaning: 'The whole open application in one read: identity, authoring limits, every record type with its fields and references, every compiled screen, health, and every read path this server serves. Read it first.' },
    { name: 'nendo://application/manifest', meaning: 'Identity and the revision counters, without reading records or history.' },
    { name: 'nendo://application/vocabulary', meaning: 'Everything this Nendo build accepts from an author: node kinds with their properties and children, filter operators and value kinds, aggregates, the behaviour catalogue, the authoring limits, and every operation with the payload fields it takes. It describes the host, not the open file.' },
    { name: 'nendo://application/examples', meaning: 'Sixteen complete change sets that can be sent as they stand, each carrying one authoring rule. Every one is replayed by the test suite, so an example that stopped validating fails the build.' },
    { name: 'nendo://application/entities', meaning: 'Stable record type IDs and display names.' },
    { name: 'nendo://application/entity/{entityId}/schema', meaning: 'One record type’s fields — storage kind, required, presentation, choice IDs, a rating’s scale, reference target — and its calculated fields.' },
    { name: 'nendo://application/entity/{entityId}/records{?cursor,limit}', meaning: 'A page of records in stable ID order, with exact numeric lexemes and reference labels.' },
    { name: 'nendo://application/entity/{entityId}/export{?cursor,limit}', meaning: 'The same records as faithful Nendo CSV, a page at a time — the profile your own Export writes, so what comes out can be imported again unchanged. The header row carries display names and appears on the first page only; fieldIds gives the stable ID behind each column.' },
    { name: 'nendo://application/surfaces', meaning: 'Every compiled screen as an ordered node tree, or the diagnostics that stop them compiling. A command root carries the command ID that nendo.data.execute_command takes.' },
    { name: 'nendo://application/proposals', meaning: 'Every validated proposal waiting for the person: title, captured revision, state, operation count and the worst reversibility it carries. The way to see what is pending after a reconnect.' },
    { name: 'nendo://application/history{?cursor,limit}', meaning: 'Revision summaries in sequence order, with operation counts and a link to each revision’s operations.' },
    { name: 'nendo://application/revision/{revisionId}/operations{?cursor,limit}', meaning: 'A page of operation types, reversibility and affected IDs for one revision. Never raw payloads.' },
    { name: 'nendo://application/health', meaning: 'Durability state and the last integrity result, with how many changes have happened since it was measured. Reading it does not rescan.' },
    { name: 'nendo://host/instances', meaning: 'Every Nendo running on this device and which file each has open, with isThisOne marking the one answering. The only read here that is not about the open file. It names files, never paths, and it does not make another one reachable: a client works the address it was registered with, so switching is the person’s move.' },
  ],
  editDataTools: [
    { name: 'nendo.lease.acquire', meaning: 'Take the single editing lease and a private application handle. The handle addresses this open file for the rest of the session and stays private; the lease is the edit authority, held by one agent at a time and revocable by the person. Owned calls take both.' },
    { name: 'nendo.lease.status', meaning: 'Who holds the lease. Needs no lease and grants none. Use it after a lost acquire response or a reconnect rather than assuming the lease is free.' },
    { name: 'nendo.lease.renew', meaning: 'Confirm ownership, and extend the lease when the person has turned expiry on.' },
    { name: 'nendo.lease.release', meaning: 'Give the lease back. Closing the client does not.' },
    { name: 'nendo.data.create_record', meaning: 'One record from field values. Returns its ID and version 1, and names any other record an automatic action changed.' },
    { name: 'nendo.data.create_records', meaning: 'One to fifty records of one type as one revision, all or nothing.' },
    { name: 'nendo.data.import_records', meaning: 'Up to five hundred records of one type from CSV text or typed JSON, committed fifty at a time. A later-batch refusal is NENDO_IMPORT_PARTIAL: it names committed and remaining rows, the first row not committed, the committed revision IDs and the cause. Retry the identical call and key to replay earlier batches. Bad CSV mappings and mixed CSV/JSON payloads are refused before writing.' },
    { name: 'nendo.data.set_field', meaning: 'One field on one record at an exact expected version.' },
    { name: 'nendo.data.delete_record', meaning: 'One record at its exact version. Refused while other records reference it; values are retained for restore through History.' },
    { name: 'nendo.data.execute_command', meaning: 'Run a stored command on one record: one field per step, the version advancing per step.' },
    { name: 'nendo.data.get_receipt', meaning: 'The outcome of an earlier write, after a lost response, including which records its automatic actions changed. Needs no lease and grants none; a missing receipt stays unresolved.' },
    { name: 'nendo.health.verify_integrity', meaning: 'An integrity scan measured now. Needs no lease; a file that has not changed since the last scan is not rescanned.' },
  ],
  shapeAppTools: [
    { name: 'nendo.change_set.begin', meaning: 'Open a draft at the current definition revision, with the title the person will see. Reports how many other change sets are already open.' },
    { name: 'nendo.change_set.add_operations', meaning: 'Append operations to the draft. A payload the host cannot bind is refused here, naming the operation and the key, and nothing enters the draft.' },
    { name: 'nendo.change_set.amend', meaning: 'Drop the tail of the draft from a mutation onwards and append replacements — the repair after a failed validate.' },
    { name: 'nendo.change_set.validate', meaning: 'Replay the draft on a private copy of the file. A valid draft freezes into a proposal in Pending changes; an invalid one stays open with diagnostics.' },
    { name: 'nendo.change_set.preview', meaning: 'Read the frozen proposal’s sanitized preview and diff.' },
    { name: 'nendo.change_set.reject', meaning: 'Discard the draft or proposal without touching the file.' },
  ],
  unattendedTools: [
    { name: 'nendo.change_set.accept', meaning: 'Apply its own validated proposal to your file, and record this device’s consent for any automatic actions it installs. Served only while you have chosen Unattended; at every level below it is not there at all.' },
  ],
};

const asTerms = (entries: readonly SurfaceEntry[]): HelpTerm[] => entries.map(entry => ({ term: entry.name, meaning: entry.meaning, code: true }));

const refusalCodes: HelpTerm[] = [
  { term: 'NENDO_EDIT_DATA_REQUIRED', meaning: 'The access level is Inspect. Ask the person to raise it.' },
  { term: 'NENDO_SHAPE_APP_REQUIRED', meaning: 'The access level is below Shape app, so no change set can be opened.' },
  { term: 'NENDO_UNATTENDED_REQUIRED', meaning: 'The access level is below Unattended, so the agent cannot accept its own proposal. Accept it yourself under Pending changes.' },
  { term: 'NENDO_CHANGE_SET_NOT_VALIDATED', meaning: 'An accept arrived for a change set that is still a draft. It must validate first, so there is something to accept.' },
  { term: 'NENDO_HOST_CLOSED', meaning: 'The file was closed, switched or entered recovery; the address and every handle from before are gone.' },
  { term: 'NENDO_LEASE_HELD', meaning: 'Another agent holds the editing lease. Wait, or ask the person to revoke it.' },
  { term: 'NENDO_LEASE_EXPIRED', meaning: 'The lease lapsed because expiry is on and it was not renewed. Acquire again.' },
  { term: 'NENDO_INVALID_LEASE', meaning: 'The handle or lease does not belong to this run of this file.' },
  { term: 'NENDO_RECORD_VERSION_CONFLICT', meaning: 'The record moved since it was read. Read it again and retry with the current version.' },
  { term: 'NENDO_RECORD_REFERENCED', meaning: 'Other records still point at this one; the message names up to five of them.' },
  { term: 'NENDO_BEHAVIOUR_NOT_APPROVED', meaning: 'The file carries automatic actions this device has not approved, so writes wait for the person.' },
  { term: 'NENDO_ENTITY_NOT_FOUND', meaning: 'No such record type in the file. When a waiting proposal would create it, the message names that proposal.' },
  { term: 'NENDO_FIELD_CALCULATED', meaning: 'The field is calculated, not stored, and cannot be written; the message names the calculation. Write the stored fields its formula reads.' },
  { term: 'NENDO_UNKNOWN_OPERATION', meaning: 'Not one of the twenty operation types. There is no escape hatch: the refusal is the same for SQL as for a typo.' },
  { term: 'NENDO_INVALID_REQUEST', meaning: 'A payload the host cannot bind. The message names the operation, the key, and what the key is for.' },
  { term: 'NENDO_CHANGE_SET_LIMIT', meaning: 'A per-call or per-change-set ceiling was reached; the message names which, and the current usage.' },
  { term: 'NENDO_CHANGE_SET_STALE', meaning: 'The file’s definition moved since the draft began. Begin again on the new revision.' },
  { term: 'NENDO_DRAFT_LIMIT', meaning: 'Eight drafts are already open in this session. Validate or reject one first.' },
  { term: 'NENDO_CHANGE_SET_FROZEN', meaning: 'The change set validated and is a proposal waiting for the person; it takes no more operations. Reject it and begin again, or ask the person to accept it.' },
  { term: 'NENDO_CHANGE_SET_NOT_FOUND', meaning: 'No such change set in this session: the ID does not exist, or belongs to another agent session.' },
  { term: 'NENDO_IDEMPOTENCY_CONFLICT', meaning: 'The same key was sent with a different request.' },
  { term: 'NENDO_STALE_CURSOR', meaning: 'The file changed under a paged read. Restart from the first page.' },
  { term: 'NENDO_INVALID_CURSOR', meaning: 'A cursor from another query, another file or an earlier access session.' },
  { term: 'NENDO_INVALID_LIMIT', meaning: 'Page limits are whole numbers from 1 to 100. Letters, a fraction or an empty value are refused the same way, never as an internal error.' },
  { term: 'NENDO_IMPORT_PARTIAL', meaning: 'Earlier import batches committed before a later one was refused. Read the counts, first uncommitted row and revision IDs; retry the identical call with the same key.' },
  { term: 'NENDO_RECOVERY_REQUIRED', meaning: 'The file is in recovery and cannot be read or written until the person resolves it.' },
  { term: 'NENDO_INTERNAL_ERROR', meaning: 'Something failed inside Nendo. The message names only the exception type.' },
];

export const agentHelp: HelpProvider = () => [
  { id: 'agent-access', title: 'What an agent can see and do', category: 'Agents', summary: 'Access levels in terms of your data, the editing lease, proposals, and what the Agent page shows you.', related: ['mcp', 'agent-surface', 'lanes', 'calculations'], sections: [
    { heading: 'Five access levels', paragraphs: ['Each level includes the ones before it. You choose it on the Agent page while a file is open, and you can change it at any time. None of them is remembered: every file you open starts at Off.'], terms: [
      { term: 'Off', meaning: 'Nothing listens. No agent can connect, and every lease from before is ended.' },
      { term: 'Inspect', meaning: 'An agent can read everything about the open file — structure, records, screens, history, health and waiting proposals — through fourteen read-only resources. Its tool list is empty, so it cannot change anything.' },
      { term: 'Edit data', meaning: 'Adds creating, editing and deleting records, running a screen’s command, and asking for an integrity check. One agent at a time, under an editing lease. These writes go straight into your file, with a receipt, and appear in History like your own.' },
      { term: 'Shape app', meaning: 'Adds proposing record types, fields, screens, calculations and automatic actions — only as proposals, which wait in Pending changes until you accept or reject them.' },
      { term: 'Unattended', meaning: 'Adds accepting those proposals itself, and approving the automatic actions they install, so they run. Nobody reads the change before your file takes it. It is for building a new file to order, where the review was not protecting anything yet; it is the wrong level to leave on. You are asked to confirm before it starts, it ends when you lower the level or close the file, and it is never remembered.' },
    ] },
    { heading: 'One editor at a time', paragraphs: [
      'Writing needs the editing lease. One agent holds it, together with a private handle that only it knows. “Editing owner” on the Agent page shows who holds it, and “Revoke edit access” ends it at once.',
      'Lease expiry is off unless you turn it on under Agent → Connection; then a lease that is not renewed lapses after the seconds you set. Closing the agent alone does not release editing. Setting access to Off, closing the file or switching to another file ends every lease.',
    ] },
    { heading: 'Working with an agent', steps: [
      'Start at Inspect and ask the agent to describe the file: record types, fields, screens, and what is already waiting for review.',
      'Raise the level for the task in hand — Edit data for records, Shape app for structure and screens, Unattended only while an agent is building a file from nothing — and lower it again afterwards.',
      'Ask for one proposal at a time and wait to review it. Accepting one proposal makes any others still waiting stale.',
      'Read “What changes” before you click “Accept changes”. Rejecting leaves your file exactly as it was.',
      'Keep the window and the file open while the agent works; closing or switching the file ends its lease and rejects its waiting proposals.',
      'Set access back to Off when no agent is working.',
    ] },
    { heading: 'What the Agent page shows', paragraphs: [
      '“Most recent agent” is the last request seen, not a live connection. A client that connects with the standard handshake shows as “Local agent”, because its name travels only in that handshake. Recent activity keeps the last 200 events and shows the last 20: reads, edits with their revision, proposal steps, and changes to access.',
      'Pending changes lists every validated proposal with its title, operation count and reversibility; “Review changes” opens “What changes” and “What this builds” with Accept changes and Reject. Approval of automatic actions sits on this page and under Health.',
    ] },
    { heading: 'What an agent cannot do', paragraphs: [
      'An agent never receives SQL, a file path, the file system, a process, the network or a generic “run this”. It learns the file’s name, never its location, and an import or export is text it sends or receives rather than a file it opens. ' + noAcceptTool + ' Below Unattended, no tool, resource or request reaches the approval of automatic actions either; at Unattended, Nendo records that approval for you when it accepts a change that installs them, and you withdraw it in the same place as any other. It cannot restore a deleted record or change the file’s identity; those are Nendo’s own.',
    ] },
    { heading: 'Your computer is the boundary', paragraphs: [
      'There is no credential. While a file is open with access on, anything running on this computer can connect at the level you chose. That is the right trade for one person iterating quickly on their own machine, and the wrong posture for a shared one. Leave access Off when no agent is working.',
    ] },
  ] },

  { id: 'agent-surface', title: 'The MCP surface: every resource and tool', category: 'Agents', summary: 'What the local server offers an agent, resource by resource and tool by tool, with its limits and refusals.', related: ['agent-access', 'mcp', 'lanes', 'limits'], sections: [
    { heading: 'How an agent gets oriented', paragraphs: [
      'The server’s own instructions describe the model in a paragraph. nendo://application/describe returns the whole application in one read and lists every read path, so no reconnaissance is needed. The plain resource list holds only the parameterless reads; the reads that take a record type or a revision are templates, returned by the template list. The vocabulary and examples describe this Nendo build, not the open file, and proposals lists what is already waiting for the person.',
      'The server answers both the standard initialize handshake and the 2026-07-28 discover path. There is no credential. The server calls itself nendo-local and advertises the open file’s name, never its location.',
    ] },
    { heading: 'Resources: reads, available from Inspect', paragraphs: ['None of these needs a lease.'], terms: asTerms(agentSurface.resources) },
    { heading: 'Pages and cursors', paragraphs: [
      'Records, history and revision operations are paged with cursor and limit, 1 to 100 per page; a limit that is not a whole number in that range is refused with NENDO_INVALID_LIMIT. Any change to the file invalidates a cursor with NENDO_STALE_CURSOR; a cursor from another query, another file or an earlier access session is refused with NENDO_INVALID_CURSOR. Restart from the first page in either case.',
    ] },
    { heading: 'Tools from Edit data', paragraphs: ['Every write takes the application handle and lease ID from nendo.lease.acquire, plus an idempotency key. A retry with the same key returns the original outcome.'], terms: asTerms(agentSurface.editDataTools) },
    { heading: 'Tools from Shape app', paragraphs: ['A change set is a draft of typed operations. Nothing in it touches the file until the proposal it becomes is accepted.'], terms: asTerms(agentSurface.shapeAppTools) },
    { heading: 'Tools from Unattended', paragraphs: ['One tool, served only at the level where you have said an agent may decide for itself. It goes through the same service the Accept button calls, pinned to the proposal’s reviewed digest, so a file that moved underneath still refuses.'], terms: asTerms(agentSurface.unattendedTools) },
    { heading: 'Limits', paragraphs: [
      'Per call: one to eight mutations and up to sixteen operations. Per change set: thirty-two mutations, 128 submitted operations, 512 after inline node properties expand. Eight open drafts per session, and up to sixteen inline properties on one node. A request body may be at most 256 KiB. Every limit is echoed in every response. ' + noAcceptTool,
    ] },
    { heading: 'What a change set may contain', paragraphs: [
      'Twenty operation types, and nothing else: application.setPurpose to say what the file is for; schema.createEntity, schema.addField, schema.renameEntity, schema.renameField, schema.configureReference, schema.setFieldRequired, schema.setRetired, schema.setChoiceMetadata; behaviour.setDefinition and behaviour.removeDefinition for calculations, functions, actions and triggers; ui.addNode, ui.setProperty, ui.moveNode, ui.removeNode for screens; data.createRecord, data.setField, data.deleteRecord, data.backfillRetiredField and data.convertLegacyReference for data carried in the same proposal. Restoring a deleted record and changing a file’s identity are Nendo’s only. An unknown type is refused by name.',
    ] },
    { heading: 'How a refusal reads', paragraphs: ['A refusal is CODE: message. The code is stable; the message names the thing refused and the remedy, and never contains a path or a stored value.'], terms: refusalCodes },
    { heading: 'After a lost answer', paragraphs: [
      'nendo.lease.status says whether an acquire really went through. nendo.data.get_receipt reads the outcome of a write without restoring any authority, and names the records its automatic actions changed. nendo://application/proposals shows a validated proposal after a reconnect. nendo://application/health says how stale the last integrity result is, and nendo.health.verify_integrity measures a fresh one.',
    ] },
    { heading: 'Numbers stay exact', paragraphs: [
      'Records carry every number as an exact lexeme beside its value. A write may wrap a number in a $nendoNumber envelope to keep every digit; a value that would have to be rounded is refused rather than stored.',
    ] },
  ] },
];
