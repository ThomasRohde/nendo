import { escapeAttribute, escapeHtml } from './format';
import { icon, type IconName } from './icons';
import { markdownMarkup } from './markdown';
import type { AgentOption, AgentTranscriptEntry, LaunchedAgentState, LaunchedAgentView } from './host-types';

/**
 * The conversation with an agent launched from the Agent page (ADR-0030), as the tab holds it:
 * the agent, its state, its own options, and every entry so far, merged from reads that each
 * carry only what changed. No DOM and no reads here, so the merge and the markup are measured in
 * the node lane.
 *
 * The tab is the owner's direction A (2026-10-08): a reading column where the agent's steps fold
 * into one line, a permission request stands where the agent stopped, and the agent's own
 * options sit in the composer. Every word in an entry is the agent's or a tool's and is drawn as
 * text; the agent's messages go through the Markdown subset, which escapes every character
 * before it adds a tag.
 */
export interface AgentChat {
  /** Changes when another agent is launched, so the page is rebuilt rather than patched. */
  key: string;
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
  options: AgentOption[];
}

export function emptyChat(): AgentChat {
  return {
    key: '', exists: false, agentId: null, name: 'Agent', commandLine: null, endpoint: null, level: 'Off',
    state: 'none', working: false, notice: null, agentTitle: null, revision: 0, entries: new Map(), signInMethods: [], options: [],
  };
}

/**
 * Take in one read. A read whose revision is older than what the chat holds is a late answer and
 * changes nothing; a read of another conversation (another launch) starts the chat again.
 * Returns the IDs of the entries that changed.
 */
export function mergeChat(chat: AgentChat, view: LaunchedAgentView, launchKey: string): string[] {
  if (chat.key !== launchKey) {
    Object.assign(chat, emptyChat(), { key: launchKey, entries: new Map() });
  }
  if (view.revision < chat.revision && view.exists === chat.exists) return [];
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
  chat.options = view.options ?? [];
  chat.revision = Math.max(chat.revision, view.revision);
  const changed: string[] = [];
  for (const entry of view.entries) {
    const held = chat.entries.get(entry.id);
    if (held !== undefined && held.revision > entry.revision) continue;
    chat.entries.set(entry.id, entry);
    changed.push(entry.id);
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
    case 'ready': return waitingForYou(chat) ? 'Waiting for you' : chat.working ? 'Working' : 'Ready';
    case 'ended': return 'Ended';
    default: return 'Not running';
  }
}

/**
 * What the agent is doing, in one word, for the conversation's tab in the title bar (W-200): a
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

/** The tone of the state pill: settled, busy, or quiet. */
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
      // The host names what the person pointed at with @ in the entry's title (W-200).
      return `<div class="chat-you" data-item="${key}">${escapeHtml(entry.text)}${entry.title === null || entry.title === ''
        ? '' : `<span class="chat-you-context">Pointed at ${escapeHtml(entry.title)}</span>`}</div>`;
    case 'agent':
      return `<div class="chat-agent markdown-body" data-item="${key}">${markdownMarkup(entry.text, { headingShift: 2 })}</div>`;
    case 'permission':
      return permissionMarkup(entry, agentName, expanded.has(item.key), key);
    default:
      return `<p class="chat-notice" data-item="${key}">${escapeHtml(entry.text)}</p>`;
  }
}

function stepMarkup(entry: AgentTranscriptEntry): string {
  if (entry.kind === 'plan') {
    return `<div class="chat-step is-plan"><span class="chat-step-icon" aria-hidden="true">${icon('list')}</span><div class="chat-step-body"><strong>Plan</strong><ol>${(entry.plan ?? []).map((item) =>
      `<li data-status="${escapeAttribute(item.status)}"><span class="chat-plan-mark" aria-hidden="true">${item.status === 'completed' ? icon('check') : ''}</span>${escapeHtml(item.text)}</li>`).join('')}</ol></div></div>`;
  }
  if (entry.kind === 'thought') {
    return `<div class="chat-step is-thought"><span class="chat-step-icon" aria-hidden="true">${icon('lightbulb')}</span><div class="chat-step-body"><details><summary>Thinking</summary><div class="chat-plain">${escapeHtml(entry.text)}</div></details></div></div>`;
  }
  const status = entry.status ?? 'pending';
  return `<div class="chat-step is-tool" data-status="${escapeAttribute(status)}">
    <span class="chat-step-icon" aria-hidden="true">${toolIcon(entry.toolKind)}</span>
    <div class="chat-step-body">
      <div class="chat-step-head"><strong>${escapeHtml(entry.title ?? 'A tool call')}</strong>${originTag(entry.origin)}</div>
      <small>${escapeHtml(toolKinds[entry.toolKind ?? 'other'] ?? 'Tool')} · ${escapeHtml(statuses[status] ?? status)}</small>
      ${entry.input === null ? '' : `<details><summary>What it sent</summary><pre class="chat-plain">${escapeHtml(entry.input)}</pre></details>`}
      ${entry.text === '' ? '' : `<details><summary>What came back</summary><pre class="chat-plain">${escapeHtml(entry.text)}</pre></details>`}
    </div>
  </div>`;
}

const optionOrder: Record<string, number> = { allow_once: 0, reject_once: 1, reject_always: 2, allow_always: 3 };

function permissionMarkup(entry: AgentTranscriptEntry, agentName: string, showInput: boolean, key: string): string {
  if (entry.answer !== null) {
    return `<p class="chat-answered" data-item="${key}">${icon('check')}<span>${escapeHtml(entry.title ?? 'A tool call')} · you chose ${escapeHtml(entry.answer)}</span></p>`;
  }
  const options = [...(entry.options ?? [])].sort((left, right) => (optionOrder[left.kind] ?? 4) - (optionOrder[right.kind] ?? 4));
  const firstAllow = options.find((option) => option.kind === 'allow_once')?.optionId ?? null;
  return `<section class="chat-permission" data-item="${key}" aria-label="${escapeAttribute(agentName)} asks permission">
    <div class="chat-permission-head"><span class="chat-permission-icon" aria-hidden="true">${icon('alert')}</span><strong>${escapeHtml(agentName)} asks: ${escapeHtml(entry.title ?? 'a tool call')}</strong>${originTag(entry.origin)}</div>
    ${showInput && entry.input !== null ? `<pre class="chat-plain">${escapeHtml(entry.input)}</pre>` : ''}
    <div class="chat-permission-actions">${options.map((option) =>
      `<button type="button" class="${option.optionId === firstAllow ? 'primary-button' : option.kind === 'allow_always' ? 'text-button' : 'secondary-button'}" data-answer-entry="${escapeAttribute(entry.id)}" data-option-id="${escapeAttribute(option.optionId)}">${escapeHtml(option.name)}</button>`).join('')}
      ${entry.input === null ? '' : `<button type="button" class="text-button chat-permission-input" data-toggle-input="${key}" aria-expanded="${showInput}">${showInput ? 'Hide what it sends' : 'Show what it sends'}</button>`}
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
