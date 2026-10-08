import type { HelpProvider, HelpTerm } from './help';

export interface SurfaceEntry { name: string; meaning: string }

const noAcceptTool = 'Below Unattended, no tool accepts a proposal: acceptance stays with you, in Nendo.';

/**
 * The closed MCP surface as a person reads it. One list feeds the article, the Node
 * test and Test-Production.ps1, which compares these names with what the host declares:
 * a tool added or a URI changed without a sentence here fails the build.
 */
export const agentSurface: { resources: readonly SurfaceEntry[]; inspectTools: readonly SurfaceEntry[]; editDataTools: readonly SurfaceEntry[]; shapeAppTools: readonly SurfaceEntry[]; unattendedTools: readonly SurfaceEntry[] } = {
  resources: [
    { name: 'nendo://application/describe{?include}', meaning: 'The whole open application in one read: identity, authoring limits, every record type with its fields and references, every compiled screen, health, and every read path this server serves. Read it first.' },
    { name: 'nendo://application/entity/{entityId}', meaning: 'One record type as a bundle: its schema with the record count, the screens that belong to it and the diagnostics that name it. With the manifest, the small first read for one type.' },
    { name: 'nendo://application/manifest', meaning: 'Identity and the revision counters, without reading records or history.' },
    { name: 'nendo://application/vocabulary{?include}', meaning: 'Everything this Nendo build accepts from an author: node kinds with their properties and children, filter operators and value kinds, aggregates, the behaviour catalogue, the authoring limits, every operation with the payload fields it takes, and the authoring rules that are easy to break. About 60 KB whole; include=operations,authoringRules,limits reads just those sections. It describes the host, not the open file.' },
    { name: 'nendo://application/examples', meaning: 'Seventeen complete change sets that can be sent as they stand, each carrying one authoring rule. Every one is replayed by the test suite, so an example that stopped validating fails the build.' },
    { name: 'nendo://application/entities', meaning: 'Stable record type IDs and display names.' },
    { name: 'nendo://application/entity/{entityId}/schema', meaning: 'One record type’s fields — storage kind, required, presentation, choice IDs, a rating’s scale, reference target — and its calculated fields.' },
    { name: 'nendo://application/entity/{entityId}/records{?cursor,limit,recordId,sort,desc,filter,fields}', meaning: 'A page of records in stable ID order, or one record by ID, filtered and sorted the way a screen is, with exact numeric lexemes and reference labels; fields= keeps only the named values.' },
    { name: 'nendo://application/entity/{entityId}/aggregate{?aggregate,fieldId,groupBy,rowBy,columnBy,dateFieldId,bucket,range,filter}', meaning: 'An exact count, sum, min or max over the records a filter leaves, whole, per group, per grid cell or per date bucket, without paging them.' },
    { name: 'nendo://application/search{?q,entity,field,cursor,limit}', meaning: 'Records found by any word in their text, best match first, across record types or narrowed to some, each with its label and a short excerpt of what matched. Words may sit in different fields; "a phrase" in quotes is one, and -word leaves records out. The file needs a search index first, which application.buildSearchIndex builds and every write keeps current.' },
    { name: 'nendo://application/entity/{entityId}/tree{?root,depth,cursor,limit}', meaning: 'A record type kept as a tree, depth-first: the records under a root, or from the top level, down to a depth, each with its parent, depth and child count.' },
    { name: 'nendo://application/entity/{entityId}/export{?cursor,limit}', meaning: 'The same records as faithful Nendo CSV, a page at a time — the profile your own Export writes, so what comes out can be imported again unchanged. The header row carries display names and appears on the first page only; fieldIds gives the stable ID behind each column.' },
    { name: 'nendo://application/surfaces', meaning: 'Every compiled screen as an ordered node tree, or the diagnostics that stop them compiling. A command root carries the command ID that nendo.data.execute_command takes.' },
    { name: 'nendo://application/proposal/{proposalId}', meaning: 'One proposal in full, by ID and without a lease: its diff, diagnostics, package changes, behaviour and what the file would hold, as Pending changes shows them; and whose it is.' },
    { name: 'nendo://application/proposals', meaning: 'Every validated proposal waiting for the person: title, captured revision, state, operation count and the worst reversibility it carries. The way to see what is pending after a reconnect.' },
    { name: 'nendo://application/history{?cursor,limit,newestFirst}', meaning: 'Revision summaries in sequence order, or newest first with newestFirst=true, with operation counts and a link to each revision’s operations.' },
    { name: 'nendo://application/revision/{revisionId}/operations{?cursor,limit}', meaning: 'A page of operation types, reversibility and affected IDs for one revision. Never raw payloads.' },
    { name: 'nendo://application/extensions', meaning: 'Every package the file carries, with its kind and each file’s path, type, SHA-256 and size: a custom view’s code, or an agent skill. A package lives in the file and changes through a proposal you review line by line.' },
    { name: 'nendo://application/extension/{packageId}/file{?path,offset,length}', meaning: 'One package file, a page of bytes at a time, with its path percent-encoded (tiles%2Fworld.bin): text as text, anything else as base64, with the whole file’s SHA-256 so a reader can check what it assembled.' },
    { name: 'nendo://application/view-api', meaning: 'What a custom view’s code can call: every window.nendo method with its parameters and answer, the events, the toolbar’s controls and icons, the theme’s colours, the limits and refusals, and a whole view to start from. An agent reads it only when it writes a view’s code. It describes this Nendo build, not the open file.' },
    { name: 'nendo://application/health', meaning: 'Durability state and the last integrity result, with how many changes have happened since it was measured. Reading it does not rescan.' },
    { name: 'skill://nendo-authoring/SKILL.md', meaning: 'The authoring skill, for a client that speaks the Skills extension: which read answers which question, the lease, the change-set loop, every operation, the bounds, the examples and the refusals. Its supporting files are the vocabulary, the examples and the view API.' },
    { name: 'skill://nendo-authoring/references/{file}', meaning: 'One of the skill’s supporting files by name — vocabulary.json, examples.json or view-api.json — the same content as the matching nendo:// read, so a client that verifies the skill’s manifest reads the bytes it names.' },
    { name: 'skill://{packageId}/{+path}', meaning: 'A file of a skill the open file carries: a package of kind skill, under its package ID and then its name, its SKILL.md and the files beside it. skills/list offers each such skill after the host’s own, with every file’s digest and size. They are instructions about this file that you accepted, and nothing in Nendo runs them.' },
    { name: 'nendo://host/instances', meaning: 'Every Nendo running on this device and which file each has open, with isThisOne marking the one answering. The only read here that is not about the open file. It names files, never paths, and it does not make another one reachable: a client works the address it was registered with, so switching is the person’s move.' },
  ],
  inspectTools: [
    { name: 'nendo.read.resource', meaning: 'Any read above by its address, for an agent whose client calls tools but cannot read resources: the same text the read returns, and the same refusals. Without it such an agent could read nothing, and one opened the file’s storage instead.' },
    { name: 'nendo.read.list', meaning: 'Every address above, the templated ones included, and every skill: Nendo’s own and any this file carries.' },
  ],
  editDataTools: [
    { name: 'nendo.lease.acquire', meaning: 'Take the single editing lease and a private application handle. The handle addresses this open file for the rest of the session and stays private; the lease is the edit authority, held by one agent at a time and revocable by the person. Owned calls take both. The grant also states the write limits and the reads to make first. An agent that released or lost its lease can take it again under its earlier handle, and the proposals it validated are its own again.' },
    { name: 'nendo.lease.status', meaning: 'Who holds the lease. Needs no lease and grants none. Use it after a lost acquire response or a reconnect rather than assuming the lease is free.' },
    { name: 'nendo.lease.renew', meaning: 'Confirm ownership, and extend the lease when the person has turned expiry on.' },
    { name: 'nendo.lease.release', meaning: 'Give the lease back. Closing the client does not.' },
    { name: 'nendo.data.create_record', meaning: 'One record from field values. Returns its ID and version 1, and names any other record an automatic action changed.' },
    { name: 'nendo.data.create_records', meaning: 'One to fifty records of one type as one revision, all or nothing.' },
    { name: 'nendo.data.import_records', meaning: 'Up to five hundred records of one type from CSV text or typed JSON, committed fifty at a time. A later-batch refusal is NENDO_IMPORT_PARTIAL: it names committed and remaining rows, the first row not committed, the committed revision IDs and the cause. Retry the identical call and key to replay earlier batches. Bad CSV mappings and mixed CSV/JSON payloads are refused before writing.' },
    { name: 'nendo.data.set_field', meaning: 'One field on one record at an exact expected version.' },
    { name: 'nendo.data.update_record', meaning: 'Several fields of one record as one revision, the way a form saves, at an exact expected version.' },
    { name: 'nendo.data.undo_revision', meaning: 'Undo one record revision the agent’s own session committed, as the compensation History makes: one linked revision, nothing rewound. Another client’s or your own revisions are refused.' },
    { name: 'nendo.data.apply_writes', meaning: 'Creates, updates and deletes across record types as one revision, all or nothing, with every written record’s new version in the answer. Each create or update may also say whether a new file keeps the record, in the same revision, and a label names the revision in History.' },
    { name: 'nendo.data.delete_record', meaning: 'One record at its exact version. Refused while other records reference it; values are retained for restore through History.' },
    { name: 'nendo.data.set_kept_in_new_files', meaning: 'Say whether a new file of this application keeps a record, or up to two hundred of any types as one revision: kept, left out, or following its record type. A fact about the record, not a value: no version moves and no automatic action runs. Keep what the application ships with, such as a lookup’s entries; leave the work out.' },
    { name: 'nendo.data.move_record', meaning: 'Move a record in a declared hierarchy: under another parent or to the top level, and before a sibling or last. The host refuses a move under the record’s own descendants.' },
    { name: 'nendo.data.execute_command', meaning: 'Run a stored command on one record: one field per step, the version advancing per step.' },
    { name: 'nendo.data.get_receipt', meaning: 'The outcome of an earlier write, after a lost response, including which records its automatic actions changed. Needs no lease and grants none; a missing receipt stays unresolved.' },
    { name: 'nendo.health.verify_integrity', meaning: 'An integrity scan measured now. Needs no lease; a file that has not changed since the last scan is not rescanned.' },
  ],
  shapeAppTools: [
    { name: 'nendo.change_set.begin', meaning: 'Open a draft at the current definition revision, with the title the person will see. Reports how many other change sets are already open.' },
    { name: 'nendo.change_set.add_operations', meaning: 'Append operations to the draft. A payload the host cannot bind is refused here, naming the operation and the key, and nothing enters the draft.' },
    { name: 'nendo.change_set.amend', meaning: 'Drop the tail of the draft from a mutation onwards and append replacements — the repair after a failed validate.' },
    { name: 'nendo.change_set.validate', meaning: 'Replay the draft on a private copy of the file. A valid draft freezes into a proposal in Pending changes; an invalid one stays open with diagnostics: every independent mistake at once, up to five, each naming its operation.' },
    { name: 'nendo.change_set.revalidate', meaning: 'Validate a proposal’s operations again at the file’s current revision, as a new proposal under the same change set, after the file moved under it; nothing is merged.' },
    { name: 'nendo.change_set.preview', meaning: 'Read the frozen proposal’s sanitized preview and diff.' },
    { name: 'nendo.change_set.reject', meaning: 'Discard the draft or proposal without touching the file.' },
  ],
  unattendedTools: [
    { name: 'nendo.change_set.accept', meaning: 'Apply its own validated proposal to your file, and record this device’s consent for any automatic actions it installs. Served only while you have chosen Unattended; at every level below it is not there at all.' },
  ],
};

const asTerms = (entries: readonly SurfaceEntry[]): HelpTerm[] => entries.map(entry => ({ term: entry.name, meaning: entry.meaning, code: true }));

const refusalCodes: HelpTerm[] = [
  { term: 'NENDO_EDIT_DATA_REQUIRED', meaning: 'The access level is Inspect and the tool needs Edit data. The message names the tool and both levels; raise the level if you want the agent to write.' },
  { term: 'NENDO_SHAPE_APP_REQUIRED', meaning: 'The access level is below Shape app, so no change set can be opened. The message names the tool and both levels.' },
  { term: 'NENDO_UNATTENDED_REQUIRED', meaning: 'The access level is below Unattended, so the agent cannot accept its own proposal. Accept it yourself under Pending changes.' },
  { term: 'NENDO_TOOL_UNAVAILABLE', meaning: 'No tool by that name exists at any level. The agent’s tool list names every tool the current level serves.' },
  { term: 'NENDO_CHANGE_SET_NOT_VALIDATED', meaning: 'An accept arrived for a change set that is still a draft. It must validate first, so there is something to accept.' },
  { term: 'NENDO_HOST_CLOSED', meaning: 'The file was closed, switched or entered recovery; the address and every handle from before are gone.' },
  { term: 'NENDO_LEASE_HELD', meaning: 'Another agent holds the editing lease. An agent whose own answer was lost repeats nendo.lease.acquire with the same idempotencyKey and gets the same grant; otherwise it waits, or you revoke the lease on the Agent page.' },
  { term: 'NENDO_LEASE_EXPIRED', meaning: 'The lease lapsed because expiry is on and it was not renewed. Acquire again.' },
  { term: 'NENDO_INVALID_LEASE', meaning: 'The handle or lease does not belong to this run of this file.' },
  { term: 'NENDO_RECORD_VERSION_CONFLICT', meaning: 'The record moved since it was read. Read it again and retry with the current version.' },
  { term: 'NENDO_RECORD_REFERENCED', meaning: 'Other records still point at this one; the message names up to five of them.' },
  { term: 'NENDO_BEHAVIOUR_NOT_APPROVED', meaning: 'The file carries automatic actions this device has not approved, so writes wait for the person.' },
  { term: 'NENDO_ENTITY_NOT_FOUND', meaning: 'No such record type in the file. When a waiting proposal would create it, the message names that proposal.' },
  { term: 'NENDO_LINK_NOT_ALLOWED', meaning: 'The record type declares which links it allows, and the write left one whose kinds no record of the table holds. The whole edit was refused; the message names the link and, for kinds held as references, the three kind records.' },
  { term: 'NENDO_FIELD_CALCULATED', meaning: 'The field is calculated, not stored, and cannot be written; the message names the calculation. Write the stored fields its formula reads.' },
  { term: 'NENDO_UNKNOWN_OPERATION', meaning: 'Not one of the thirty-six operation types. There is no escape hatch: the refusal is the same for SQL as for a typo.' },
  { term: 'NENDO_INVALID_REQUEST', meaning: 'A call or a payload the host cannot bind, refused before anything is written. The message names the argument, or the key inside a record, that is missing, misspelt or of the wrong kind, and what is accepted there; for an operation it names the operation, the key and what the key is for.' },
  { term: 'NENDO_INVALID_HOST', meaning: 'The request was not addressed to http://127.0.0.1 and this port. localhost is refused by design, so a web page cannot reach the server by renaming itself.' },
  { term: 'NENDO_BUSY', meaning: 'Sixteen requests to this file were in progress for thirty seconds, and this one waited for a place that did not come. A request past sixteen waits rather than being refused at once; the agent retries when one has answered.' },
  { term: 'NENDO_REQUEST_TIMEOUT', meaning: 'A request took longer than five minutes and was stopped. A write may still have committed; the agent’s receipt says whether.' },
  { term: 'NENDO_INVALID_JSON', meaning: 'The request was not JSON, or nested deeper than the host reads. The message says which, with the depth and the cap or the place the text stopped being JSON.' },
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
  { term: 'NENDO_INTERNAL_ERROR', meaning: 'Something failed inside Nendo. The message names the exception type and a failure reference, which this device’s failure record keeps with the request and where it happened, while “Record failures” is on.' },
];

export const agentHelp: HelpProvider = () => [
  { id: 'agent-access', title: 'What an agent can see and do', category: 'Agents', summary: 'Access levels in terms of your data, the editing lease, proposals, and what the Agent page shows you.', related: ['mcp', 'agent-surface', 'lanes', 'calculations'], sections: [
    { heading: 'Five access levels', paragraphs: ['Each level includes the ones before it. You choose it on the Agent page while a file is open, and you can change it at any time. This computer remembers the level for that file, so it opens at the same level next time; a new file or a copy of one starts at Off, and choosing Off forgets it.'], terms: [
      { term: 'Off', meaning: 'Nothing listens. No agent can connect, and every lease from before is ended.' },
      { term: 'Inspect', meaning: 'An agent can read everything about the open file — structure, records, screens, history, health and waiting proposals — through twenty-five read-only resources, and through two read-only tools that reach the same reads for a client that has tools only. Nothing at this level can change anything.' },
      { term: 'Edit data', meaning: 'Adds creating, editing and deleting records, running a screen’s command, and asking for an integrity check. One agent at a time, under an editing lease. These writes go straight into your file, with a receipt, and appear in History like your own.' },
      { term: 'Shape app', meaning: 'Adds proposing record types, fields, screens, calculations and automatic actions — only as proposals, which wait in Pending changes until you accept or reject them.' },
      { term: 'Unattended', meaning: 'Adds accepting those proposals itself, and approving the automatic actions they install, so they run. Nobody reads the change before your file takes it. It is for building a new file to order, where the review was not protecting anything yet; it is the wrong level to leave on. You are asked to confirm before it starts. Like every level, this computer remembers it for this file, so the file opens at Unattended again until you choose Off. A Duplicate, a Fork or a backup restored from Health begins at Off; a copy made in Explorer keeps the file’s identity and does not.' },
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
    { heading: 'Launch an agent from Nendo', paragraphs: [
      'Under “Launch an agent”, the Agent page lists the agent programs Nendo knows how to start and whether each is installed on this computer, and keeps one command of your own for this device. Launch is offered from Inspect upward. The agent starts in a tab of its own beside the file, where you type to it, see the tools it calls and its plan, answer what it asks permission for, press Stop to interrupt it, and End to close it.',
      'Nendo hands the agent this file’s address and nothing else: no files and no terminal through Nendo, and an empty folder of its own to start in. It works at the level you chose, and its proposals wait here for your review like any other agent’s. The agent program brings its own sign-in; Nendo never sees a password or a key.',
      'The agent’s steps between two messages fold into one line you can open, and each tool says whether it went through Nendo or was the agent’s own. Its own settings, such as its model, how hard it thinks and its mode, sit beside the message box as the agent offers them; anything else it offers is under More. Changing one changes the agent, not what it may do in this file.',
      'It is the same program you would run in a terminal, with the same tools on this computer, and Nendo does not confine it. An agent may run its own tools without asking. Changing the level keeps it running; Off, closing the file or switching to another file ends it, and everything it started, and removes its folder. The conversation lives only in the window: it is not kept in the file or on this computer.',
    ] },
    { heading: 'What the Agent page shows', paragraphs: [
      '“Most recent agent” is the last request seen, not a live connection. A client that connects with the standard handshake shows as “Local agent”, because its name travels only in that handshake. Recent activity keeps the last 200 events and shows the last 20, one entry for each request: reads, edits with their revision, proposal steps, and changes to access. An import is named after the agent session that ran it, like every other agent write.',
      'When a request fails inside Nendo rather than being refused, the agent is given a failure reference, and this device keeps one line under it: the request, the kind of failure and where in Nendo it happened — never your data, a file path or the agent’s handle. It sits beside the record of view failures, keeps the newest fifty, and “Record failures” in the notification-area menu switches both off.',
      'Pending changes lists every validated proposal with its title, operation count and reversibility; “Review changes” opens “What changes” and “What this builds” with Accept changes and Reject. Approval of automatic actions sits on this page and under Health. When accepting involves those actions, the queue and the review say so first, and Accept waits where accepting would be refused.',
    ] },
    { heading: 'What an agent cannot do', paragraphs: [
      'From Nendo, an agent never receives SQL, a file path, the file system, a process, the network or a generic “run this”; an agent program you launch keeps whatever it can already do on this computer. It learns the file’s name, never its location, and an import or export is text it sends or receives rather than a file it opens. ' + noAcceptTool + ' Below Unattended, no tool, resource or request reaches the approval of automatic actions either; at Unattended, Nendo records that approval for you when it accepts a change that installs them, and you withdraw it in the same place as any other. It cannot restore a deleted record or change the file’s identity; those are Nendo’s own.',
    ] },
    { heading: 'Your computer is the boundary', paragraphs: [
      'There is no credential. While a file is open with access on, anything running on this computer can connect at the level you chose. That is the right trade for one person iterating quickly on their own machine, and the wrong posture for a shared one. Leave access Off when no agent is working.',
    ] },
  ] },

  { id: 'agent-surface', title: 'The MCP surface: every resource and tool', category: 'Agents', summary: 'What the local server offers an agent, resource by resource and tool by tool, with its limits and refusals.', related: ['agent-access', 'mcp', 'lanes', 'limits'], sections: [
    { heading: 'How an agent gets oriented', paragraphs: [
      'The server’s own instructions say how to read in their first sentence after the file’s name, since a client may show only the first 150 characters, and describe the model in a paragraph kept under 2,000 characters, because a client stops reading at 2,048 and says nothing. nendo://application/describe returns the whole application in one read and lists every read path, so no reconnaissance is needed. The plain resource list holds only the parameterless reads; the reads that take a record type or a revision are templates, returned by the template list. The vocabulary and examples describe this Nendo build, not the open file, and proposals lists what is already waiting for the person.',
      'The server answers both the standard initialize handshake and the 2026-07-28 discover path. There is no credential. The server calls itself nendo-local and advertises the open file’s name, never its location.',
      'Every tool and read carries a short title, and every field of every tool result says what it means. A tool that overwrites or removes what is stored says so in its hints, so a client that asks before destructive calls asks before those.',
    ] },
    { heading: 'Resources: reads, available from Inspect', paragraphs: ['None of these needs a lease.'], terms: asTerms(agentSurface.resources) },
    { heading: 'Tools from Inspect', paragraphs: ['Two read-only tools, for a client that calls tools but has no way to read a resource. Neither needs a lease, and a client may run them without asking.'], terms: asTerms(agentSurface.inspectTools) },
    { heading: 'Pages and cursors', paragraphs: [
      'Records, history and revision operations are paged with cursor and limit, 1 to 100 per page, in either order; an empty cursor is the first page, and a parameter the read does not take is refused naming the ones it does. A limit that is not a whole number in that range is refused with NENDO_INVALID_LIMIT. Any change to the file invalidates a cursor with NENDO_STALE_CURSOR; a cursor from another query, another file or an earlier access session is refused with NENDO_INVALID_CURSOR. Restart from the first page in either case.',
    ] },
    { heading: 'Tools from Edit data', paragraphs: ['Every write takes the application handle and lease ID from nendo.lease.acquire, plus an idempotency key. A retry with the same key returns the original outcome.'], terms: asTerms(agentSurface.editDataTools) },
    { heading: 'Tools from Shape app', paragraphs: ['A change set is a draft of typed operations. Nothing in it touches the file until the proposal it becomes is accepted.'], terms: asTerms(agentSurface.shapeAppTools) },
    { heading: 'Tools from Unattended', paragraphs: ['One tool, served only at the level where you have said an agent may decide for itself. It goes through the same service the Accept button calls, pinned to the proposal’s reviewed digest, so a file that moved underneath still refuses.'], terms: asTerms(agentSurface.unattendedTools) },
    { heading: 'Limits', paragraphs: [
      'Per call: one to eight mutations and up to sixteen operations. Per change set: thirty-two mutations, 128 submitted operations, 512 after inline node properties expand. Eight open drafts per session, and up to sixteen inline properties on one node. A request body may be at most 256 KiB and nest at most 32 levels. At most sixteen requests run at once and each may take five minutes; one past that waits up to thirty seconds for a place before it is refused. An exact retry replays within the last 256 calls of its kind. Every limit is echoed in every response. ' + noAcceptTool,
    ] },
    { heading: 'What a change set may contain', paragraphs: [
      'Thirty-six operation types, and nothing else: application.setPurpose to say what the file is for; application.setLook to give the file its own icon colour and letter; application.buildSearchIndex to give the file a search index; schema.setKeptInNewFiles, data.setKeptInNewFiles and application.setNewFileLabel to say what a new file of the application keeps and what the File menu calls it; schema.declareHierarchy and schema.removeHierarchy to keep a record type a tree; schema.declareLinkRule and schema.removeLinkRule to say which links a record type allows; schema.setFieldPresentation to show a text field as one line, long text or Markdown; schema.setFieldUnique so no two records share a value, and schema.setFieldSequence so the host numbers new records; extension.setPackage, extension.putFile, extension.removeFile and extension.removePackage to put a custom view’s code in the file, or with kind skill an agent’s instructions, reviewed line by line; schema.createEntity, schema.addField, schema.renameEntity, schema.renameField, schema.configureReference, schema.setFieldRequired, schema.setRetired, schema.setChoiceMetadata; behaviour.setDefinition and behaviour.removeDefinition for calculations, functions, actions and triggers; ui.addNode, ui.setProperty, ui.moveNode, ui.removeNode for screens; data.createRecord, data.setField, data.deleteRecord, data.backfillRetiredField and data.convertLegacyReference for data carried in the same proposal. Restoring a deleted record and changing a file’s identity are Nendo’s only. An unknown type is refused by name.',
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
