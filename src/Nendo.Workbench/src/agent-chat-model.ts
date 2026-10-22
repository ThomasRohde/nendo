import { escapeAttribute, escapeHtml } from './format';
import { icon, type IconName } from './icons';
import { markdownMarkup } from './markdown';
import type { AgentCommand, AgentOption, AgentTranscriptEntry, LaunchedAgentState, LaunchedAgentView } from './host-types';

/**
 * The conversation with an agent launched from the Agent page (ADR-0030), as the tab holds it:
 * the agent, its state, its own options, and every entry so far, merged from reads that each
 * carry only what changed. No DOM and no reads here, so the merge and the markup are measured in
 * the node lane.
 *
 * The tab is a reading column where the agent's steps fold
 * into one line and a permission request stands where the agent stopped. The agent's own
 * options are set on the Agent page (ADR-0033). Every word in an entry is the agent's or a tool's and is drawn as
 * text; the agent's messages go through the Markdown subset, which escapes every character
 * before it adds a tag.
 */
export interface AgentChat {
  /** Changes when another agent is launched, so the page is rebuilt rather than patched. */
  key: string;
  /** The host's name for the launch this chat holds, once a read has said it. */
  conversationId: string | null;
  exists: boolean;
  agentId: string | null;
  name: string;
  commandLine: string | null;
  endpoint: string | null;
  level: string;
  state: LaunchedAgentState;
  working: boolean;
  notice: string | null;
  agentTitle: string | null;
  revision: number;
  entries: Map<string, AgentTranscriptEntry>;
  signInMethods: LaunchedAgentView['signInMethods'];
  /** A sign-in the person started still runs, so its buttons are held. */
  signingIn: boolean;
  options: AgentOption[];
  /** The agent's slash commands, offered when a message starts with /. */
  commands: AgentCommand[];
  /** Views' messages waiting for the turn that runs (ADR-0033). */
  queued: number;
  /** The agent reads pictures, so the message box takes them. */
  takesImages: boolean;
}

export function emptyChat(): AgentChat {
  return {
    key: '', conversationId: null, exists: false, agentId: null, name: 'Agent', commandLine: null, endpoint: null, level: 'Off',
    state: 'none', working: false, notice: null, agentTitle: null, revision: 0, entries: new Map(), signInMethods: [], signingIn: false, options: [], commands: [],
    queued: 0, takesImages: false,
  };
}

/**
 * Take in one read. A read under another launch key (another launch, another file) starts the chat
 * again. A read of another conversation than the one held is a late answer from a replaced
 * launch and changes nothing: entry IDs and revisions start again with every launch, so
 * merging it would show the old conversation and leave the new one's revisions unread. So does a
 * read whose revision is older than what the chat holds. Entries the host no longer keeps go.
 * Returns the IDs of the entries that changed.
 */
export function mergeChat(chat: AgentChat, view: LaunchedAgentView, launchKey: string): string[] {
  if (chat.key !== launchKey) {
    Object.assign(chat, emptyChat(), { key: launchKey, entries: new Map() });
  }
  if (chat.conversationId !== null && view.conversationId !== null && view.conversationId !== chat.conversationId) return [];
  if (view.revision < chat.revision && view.exists === chat.exists) return [];
  if (view.conversationId !== null) chat.conversationId = view.conversationId;
  chat.exists = view.exists;
  chat.agentId = view.agentId;
  chat.name = view.name ?? 'Agent';
  chat.commandLine = view.commandLine;
  chat.endpoint = view.endpoint;
  chat.level = view.level;
  chat.state = view.state;
  chat.working = view.working;
  chat.notice = view.notice;
  chat.agentTitle = view.agentTitle;
  chat.signInMethods = view.signInMethods;
  chat.signingIn = view.signingIn === true;
  chat.options = view.options ?? [];
  chat.commands = view.commands ?? [];
  chat.queued = view.queued ?? 0;
  chat.takesImages = view.takesImages === true;
  chat.revision = Math.max(chat.revision, view.revision);
  const changed: string[] = [];
  for (const entry of view.entries) {
    const held = chat.entries.get(entry.id);
    if (held !== undefined && held.revision > entry.revision) continue;
    chat.entries.set(entry.id, entry);
    changed.push(entry.id);
  }
  // The host keeps a bounded transcript and says where it now starts; a tab open from the start
  // holds what a tab opened now would, and scans no more than that.
  if (view.firstOrder > 0) {
    for (const [id, entry] of chat.entries) if (entry.order < view.firstOrder) chat.entries.delete(id);
  }
  return changed;
}

export function orderedEntries(chat: AgentChat): AgentTranscriptEntry[] {
  return [...chat.entries.values()].sort((left, right) => left.order - right.order);
}

/** A permission request still waiting for the person. */
export function waitingForYou(chat: AgentChat): boolean {
  return chat.state === 'ready' && [...chat.entries.values()].some((entry) => entry.kind === 'permission' && entry.answer === null);
}

export function stateLabel(chat: AgentChat): string {
  switch (chat.state) {
    case 'starting': return 'Starting';
    case 'signIn': return 'Sign in needed';
    case 'ready': return `${waitingForYou(chat) ? 'Waiting for you' : chat.working ? 'Working' : 'Ready'}${chat.queued > 0 ? ` · ${chat.queued} from views waiting` : ''}`;
    case 'ended': return 'Ended';
    default: return 'Not running';
  }
}

/**
 * What the agent is doing, in one word, for the conversation's tab in the title bar: a
 * person on another tab sees it working, thinking, or waiting for them without opening it.
 * Thinking is a turn whose newest entry is the agent's own reasoning.
 */
export type ChatActivity = 'none' | 'starting' | 'working' | 'thinking' | 'waiting' | 'idle' | 'ended';

export function chatActivity(chat: AgentChat): ChatActivity {
  if (!chat.exists || chat.state === 'none') return 'none';
  if (chat.state === 'ended') return 'ended';
  if (chat.state === 'signIn' || waitingForYou(chat)) return 'waiting';
  if (chat.state === 'starting') return 'starting';
  if (!chat.working) return 'idle';
  let newest: AgentTranscriptEntry | null = null;
  for (const entry of chat.entries.values()) if (newest === null || entry.order > newest.order) newest = entry;
  return newest?.kind === 'thought' ? 'thinking' : 'working';
}

/** The tab's mark and the words a screen reader hears with it; nothing while the agent waits for a message. */
export function chatTabStatus(activity: ChatActivity): { kind: ChatActivity; label: string } | null {
  switch (activity) {
    case 'starting': return { kind: activity, label: 'Starting' };
    case 'working': return { kind: activity, label: 'Working' };
    case 'thinking': return { kind: activity, label: 'Thinking' };
    case 'waiting': return { kind: activity, label: 'Waiting for you' };
    default: return null;
  }
}

/**
 * The ways the agent offers to sign in, under its sentence. While a sign-in the person started
 * runs, every way is held: a second press started a second sign-in and a second session.
 */
export function signInMarkup(chat: AgentChat): string {
  if (chat.state !== 'signIn') return '';
  const held = chat.signingIn ? ' disabled' : '';
  return `<p>${escapeHtml(chat.notice ?? `Sign in to ${chat.name}.`)}</p><div class="chat-sign-in-methods">${chat.signInMethods.map((method) =>
    `<button type="button" class="secondary-button" data-sign-in="${escapeAttribute(method.id)}" title="${escapeAttribute(method.description ?? '')}"${held}>${escapeHtml(method.name)}</button>`).join('')}</div>`;
}

/** The tone of the state pill: settled, busy, or quiet. */
/**
 * What becomes of the agent's changes, under the box: what waits for the person's review when
 * something does, and otherwise what its access level does with a change. It once always said
 * proposals wait on the Agent page, which at Unattended or Edit data sent the person looking for
 * nothing.
 */
export function reviewHint(level: string, waiting: number): { text: string; waiting: boolean } {
  if (waiting > 0) return { text: `${waiting} ${waiting === 1 ? 'proposal waits' : 'proposals wait'} for your review`, waiting: true };
  switch (level) {
    case 'Inspect': return { text: 'It can read this file, not change it', waiting: false };
    case 'Edit data': return { text: 'Records it changes are saved at once', waiting: false };
    case 'Shape app': return { text: 'Records are saved at once; a new shape waits for your review', waiting: false };
    case 'Unattended': return { text: 'It may accept its own changes, with no review', waiting: false };
    default: return { text: '', waiting: false };
  }
}

export function stateTone(chat: AgentChat): 'ok' | 'busy' | 'quiet' {
  if (chat.state === 'ready' && !chat.working && !waitingForYou(chat)) return 'ok';
  return chat.state === 'ended' || chat.state === 'none' ? 'quiet' : 'busy';
}

/** Whether the person can send now, and whether Stop has anything to stop. */
export function composerState(chat: AgentChat): { canSend: boolean; canStop: boolean; placeholder: string } {
  const canSend = chat.state === 'ready' && !chat.working;
  const placeholder = chat.state === 'ended' ? 'This conversation has ended. Launch the agent again from the Agent page.'
    : chat.state === 'starting' ? `Waiting for ${chat.name} to start…`
      : chat.state === 'signIn' ? `Sign in to ${chat.name} first.`
        : chat.working ? `${chat.name} is working. Stop interrupts it.`
          : `Ask ${chat.name} to change this file…`;
  return { canSend, canStop: chat.working, placeholder };
}

/**
 * One thing the thread shows: a message, a notice, a permission request, or a run of steps (the
 * agent's tool calls, thoughts and plan between two messages) folded into one line.
 */
export type ThreadItem =
  | { key: string; type: 'you' | 'agent' | 'notice' | 'permission'; entry: AgentTranscriptEntry }
  | { key: string; type: 'steps'; entries: AgentTranscriptEntry[] };

export function threadItems(chat: AgentChat): ThreadItem[] {
  const items: ThreadItem[] = [];
  let run: AgentTranscriptEntry[] | null = null;
  for (const entry of orderedEntries(chat)) {
    if (entry.kind === 'tool' || entry.kind === 'thought' || entry.kind === 'plan') {
      if (run === null) {
        run = [];
        items.push({ key: `g-${entry.id}`, type: 'steps', entries: run });
      }
      run.push(entry);
      continue;
    }
    run = null;
    items.push({ key: entry.id, type: entry.kind === 'you' || entry.kind === 'agent' || entry.kind === 'permission' ? entry.kind : 'notice', entry });
  }
  return items;
}

const toolIcons: Record<string, IconName> = {
  read: 'eye', edit: 'edit', delete: 'trash', move: 'chevronRight', search: 'search',
  execute: 'command', think: 'lightbulb', fetch: 'external', switch_mode: 'settings',
};

const toolKinds: Record<string, string> = {
  read: 'Read', edit: 'Edit', delete: 'Delete', move: 'Move', search: 'Search', execute: 'Run',
  think: 'Think', fetch: 'Fetch', switch_mode: 'Mode', other: 'Tool',
};

const statuses: Record<string, string> = {
  pending: 'Waiting', in_progress: 'Running', completed: 'Done', failed: 'Failed',
};

function toolIcon(kind: string | null): string {
  return icon((kind === null ? undefined : toolIcons[kind]) ?? 'command');
}

/** Where a tool ran: through this file's MCP server, or as one of the agent's own. */
function originTag(origin: string | null): string {
  if (origin === 'nendo') return '<span class="chat-tag">Nendo</span>';
  if (origin === 'agent') return '<span class="chat-tag is-own" title="Not through Nendo: the agent ran this itself, on this computer">Its own tool</span>';
  return '';
}

function runStatus(entries: AgentTranscriptEntry[], live: boolean): 'running' | 'failed' | 'done' {
  const tools = entries.filter((entry) => entry.kind === 'tool');
  if (tools.some((entry) => entry.status === 'failed')) return 'failed';
  if (live || tools.some((entry) => entry.status === 'pending' || entry.status === 'in_progress')) return 'running';
  return 'done';
}

/** What a folded run of steps says about itself in one line. */
export function stepsSummary(entries: AgentTranscriptEntry[]): string {
  const tools = entries.filter((entry) => entry.kind === 'tool');
  const plan = [...entries].reverse().find((entry) => entry.kind === 'plan')?.plan ?? null;
  const step = plan?.find((item) => item.status === 'in_progress') ?? [...(plan ?? [])].reverse().find((item) => item.status === 'completed') ?? null;
  const label = step?.text ?? tools.at(-1)?.title ?? (entries.some((entry) => entry.kind === 'thought') ? 'Thinking' : 'Working');
  return tools.length === 0 ? label : `${label} · ${tools.length} ${tools.length === 1 ? 'step' : 'steps'}`;
}

/**
 * One item of the thread. `expanded` holds the runs of steps the person opened and the permission
 * requests whose input they asked to see; `live` is true for the last run while the agent works.
 */
export function itemMarkup(item: ThreadItem, agentName: string, expanded: ReadonlySet<string>, live = false): string {
  const key = escapeAttribute(item.key);
  if (item.type === 'steps') {
    const status = runStatus(item.entries, live);
    const open = expanded.has(item.key);
    const mark = status === 'running' ? icon('history') : status === 'failed' ? icon('alert') : icon('check');
    return `<section class="chat-steps is-${status}" data-item="${key}">
      <button class="chat-steps-line" type="button" data-toggle-steps="${key}" aria-expanded="${open}">
        <span class="chat-steps-chevron" aria-hidden="true">${icon(open ? 'chevron' : 'chevronRight')}</span>
        <span class="chat-steps-text">${escapeHtml(stepsSummary(item.entries))}</span>
        <span class="chat-steps-mark" role="img" aria-label="${status === 'running' ? 'Running' : status === 'failed' ? 'A step failed' : 'Done'}">${mark}</span>
      </button>
      ${open ? `<div class="chat-steps-list">${item.entries.map(stepMarkup).join('')}</div>` : ''}
    </section>`;
  }
  const entry = item.entry;
  switch (item.type) {
    case 'you':
      // The host names the person's pictures and what they pointed at with @ in the entry's title.
      // A message a custom view sent says which (ADR-0033): the person sees everything sent in their name.
      return `<div class="chat-you${entry.from ? ' is-from-view' : ''}" data-item="${key}">${entry.from
        ? `<span class="chat-you-from">From ${escapeHtml(entry.from)}</span>` : ''}${escapeHtml(entry.text)}${entry.title === null || entry.title === ''
        ? '' : `<span class="chat-you-context">With ${escapeHtml(entry.title)}</span>`}</div>`;
    case 'agent':
      return `<div class="chat-agent markdown-body" data-item="${key}">${markdownMarkup(entry.text, { headingShift: 2 })}</div>`;
    case 'permission':
      return permissionMarkup(entry, agentName, expanded.has(item.key), key);
    default:
      return `<p class="chat-notice" data-item="${key}">${escapeHtml(entry.text)}</p>`;
  }
}

/**
 * What an item's markup depends on: the launch it is of, its entries and their revisions, whether
 * it is open, whether it is the live run, and the agent's name. Two equal signatures draw the
 * same markup. Entry IDs and revisions start again with every launch, so the launch is in it.
 */
export function itemSignature(item: ThreadItem, agentName: string, expanded: ReadonlySet<string>, live: boolean, launch = ''): string {
  const entries = item.type === 'steps' ? item.entries : [item.entry];
  return `${launch}|${item.key}|${item.type}|${expanded.has(item.key) ? 1 : 0}|${live ? 1 : 0}|${agentName}|${entries.map((entry) => `${entry.id}:${entry.revision}`).join(',')}`;
}

/**
 * Markup for the thread's items, built again only for an item that changed. Every read built every
 * item again, an agent's Markdown with it, so one long line made each later read cost close to a
 * second. `built` counts the items actually built, for the node lane.
 */
export function createMarkupCache(): { markup(item: ThreadItem, agentName: string, expanded: ReadonlySet<string>, live: boolean, launch?: string): string; forget(keep: ReadonlySet<string>): void; clear(): void; readonly built: number } {
  const held = new Map<string, { signature: string; html: string }>();
  let built = 0;
  return {
    markup(item, agentName, expanded, live, launch = '') {
      const signature = itemSignature(item, agentName, expanded, live, launch);
      const kept = held.get(item.key);
      if (kept !== undefined && kept.signature === signature) return kept.html;
      built += 1;
      const html = itemMarkup(item, agentName, expanded, live);
      held.set(item.key, { signature, html });
      return html;
    },
    forget(keep) { for (const key of [...held.keys()]) if (!keep.has(key)) held.delete(key); },
    clear() { held.clear(); },
    get built() { return built; },
  };
}

function stepMarkup(entry: AgentTranscriptEntry): string {
  if (entry.kind === 'plan') {
    return `<div class="chat-step is-plan"><span class="chat-step-icon" aria-hidden="true">${icon('list')}</span><div class="chat-step-body"><strong>Plan</strong><ol>${(entry.plan ?? []).map((item) =>
      `<li data-status="${escapeAttribute(item.status)}"><span class="chat-plan-mark" aria-hidden="true">${item.status === 'completed' ? icon('check') : ''}</span>${escapeHtml(item.text)}</li>`).join('')}</ol></div></div>`;
  }
  if (entry.kind === 'thought') {
    return `<div class="chat-step is-thought"><span class="chat-step-icon" aria-hidden="true">${icon('lightbulb')}</span><div class="chat-step-body"><details data-part="${escapeAttribute(`${entry.id}:thought`)}"><summary>Thinking</summary><div class="chat-plain">${escapeHtml(entry.text)}</div></details></div></div>`;
  }
  const status = entry.status ?? 'pending';
  return `<div class="chat-step is-tool" data-status="${escapeAttribute(status)}">
    <span class="chat-step-icon" aria-hidden="true">${toolIcon(entry.toolKind)}</span>
    <div class="chat-step-body">
      <div class="chat-step-head"><strong>${escapeHtml(entry.title ?? 'A tool call')}</strong>${originTag(entry.origin)}</div>
      <small>${escapeHtml(toolKinds[entry.toolKind ?? 'other'] ?? 'Tool')} · ${escapeHtml(statuses[status] ?? status)}</small>
      ${entry.input === null ? '' : `<details data-part="${escapeAttribute(`${entry.id}:sent`)}"><summary>What it sent</summary><pre class="chat-plain">${escapeHtml(entry.input)}</pre></details>`}
      ${entry.text === '' ? '' : `<details data-part="${escapeAttribute(`${entry.id}:back`)}"><summary>What came back</summary><pre class="chat-plain">${escapeHtml(entry.text)}</pre></details>`}
    </div>
  </div>`;
}

const optionOrder: Record<string, number> = { allow_once: 0, reject_once: 1, reject_always: 2, allow_always: 3 };

/** What the host records for a request answered by no option: Stop, End, the program or the file ending it. */
export const cancelledAnswer = 'Cancelled';

/**
 * What kind of thing a permission request would do, as the steps list names it: Delete before
 * Allow once, rather than only the agent's own words for it.
 */
function kindTag(kind: string | null): string {
  const name = kind === null ? undefined : toolKinds[kind];
  return name === undefined || kind === 'other' ? '' : `<span class="chat-tag">${escapeHtml(name)}</span>`;
}

function permissionMarkup(entry: AgentTranscriptEntry, agentName: string, showInput: boolean, key: string): string {
  if (entry.answer !== null) {
    // Stop, End, the program ending or the file closing answer an open request as cancelled; the
    // person chose nothing, and "you chose Cancelled" said they had.
    const outcome = entry.answer === cancelledAnswer ? 'cancelled when the turn stopped' : `you chose ${escapeHtml(entry.answer)}`;
    return `<p class="chat-answered" data-item="${key}">${icon('check')}<span>${escapeHtml(entry.title ?? 'A tool call')} · ${outcome}</span></p>`;
  }
  const options = [...(entry.options ?? [])].sort((left, right) => (optionOrder[left.kind] ?? 4) - (optionOrder[right.kind] ?? 4));
  const firstAllow = options.find((option) => option.kind === 'allow_once')?.optionId ?? null;
  // What the operation would do, as the agent supplied it (a diff, the places it touches), and
  // what it sends. Either may be all the request carries. Both are text, never markup.
  const details = entry.text === '' ? '' : `<pre class="chat-plain">${escapeHtml(entry.text)}</pre>`;
  const input = entry.input === null ? '' : `<pre class="chat-plain">${escapeHtml(entry.input)}</pre>`;
  const inspectable = details !== '' || input !== '';
  return `<section class="chat-permission" data-item="${key}" aria-label="${escapeAttribute(agentName)} asks permission">
    <div class="chat-permission-head"><span class="chat-permission-icon" aria-hidden="true">${icon('alert')}</span><strong>${escapeHtml(agentName)} asks: ${escapeHtml(entry.title ?? 'a tool call')}</strong>${kindTag(entry.toolKind)}${originTag(entry.origin)}</div>
    ${showInput ? `${details}${input}` : ''}
    <div class="chat-permission-actions">${options.map((option) =>
      `<button type="button" class="${option.optionId === firstAllow ? 'primary-button' : option.kind === 'allow_always' ? 'text-button' : 'secondary-button'}" data-answer-entry="${escapeAttribute(entry.id)}" data-option-id="${escapeAttribute(option.optionId)}">${escapeHtml(option.name)}</button>`).join('')}
      ${!inspectable ? '' : `<button type="button" class="text-button chat-permission-input" data-toggle-input="${key}" aria-expanded="${showInput}">${showInput ? 'Hide what it does' : 'Show what it does'}</button>`}
    </div>
  </section>`;
}

/** The kinds of option that sit in the composer; anything else the agent offers goes under More. */
const primaryCategories = ['model', 'thought_level', 'mode', 'model_config'];

export function partitionOptions(options: AgentOption[]): { primary: AgentOption[]; more: AgentOption[] } {
  const primary = options.filter((option) => option.category !== null && primaryCategories.includes(option.category));
  return { primary, more: options.filter((option) => !primary.includes(option)) };
}

function selectMarkup(option: AgentOption): string {
  const groups = new Map<string | null, AgentOption['values']>();
  for (const value of option.values) groups.set(value.group, [...(groups.get(value.group) ?? []), value]);
  const optionTag = (value: AgentOption['values'][number]): string =>
    `<option value="${escapeAttribute(value.value)}"${value.value === option.currentValue ? ' selected' : ''}${value.description === null ? '' : ` title="${escapeAttribute(value.description)}"`}>${escapeHtml(value.name)}</option>`;
  const body = [...groups].map(([group, values]) => group === null
    ? values.map(optionTag).join('')
    : `<optgroup label="${escapeAttribute(group)}">${values.map(optionTag).join('')}</optgroup>`).join('');
  return `<select data-config-id="${escapeAttribute(option.id)}" aria-label="${escapeAttribute(option.name)}">${body}</select>`;
}

/** The agent's own options in the composer: its model, effort and mode, and More for the rest. */
export function optionsMarkup(options: AgentOption[]): string {
  const { primary, more } = partitionOptions(options);
  const pill = (option: AgentOption): string =>
    `<label class="chat-option"${option.description === null ? '' : ` title="${escapeAttribute(option.description)}"`}>${option.category === 'model' ? `<span class="chat-option-icon" aria-hidden="true">${icon('cpu')}</span>` : `<span class="chat-option-name">${escapeHtml(option.name)}</span>`}${selectMarkup(option)}</label>`;
  return primary.map(pill).join('') + (more.length === 0 ? '' : `<details class="chat-more"><summary>More</summary><div class="chat-more-panel">${more.map((option) =>
    `<label class="chat-more-row"><span>${escapeHtml(option.name)}</span>${selectMarkup(option)}</label>`).join('')}<p>${more.length === 1 ? 'This option is' : 'These options are'} the agent's own. Nendo only passes on what you pick.</p></div></details>`);
}
