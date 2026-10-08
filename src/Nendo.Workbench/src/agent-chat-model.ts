import { escapeAttribute, escapeHtml } from './format';
import { icon, type IconName } from './icons';
import { markdownMarkup } from './markdown';
import type { AgentTranscriptEntry, LaunchedAgentState, LaunchedAgentView } from './host-types';

/**
 * The conversation with an agent launched from the Agent page (ADR-0030), as the tab holds it:
 * the agent, its state, and every entry so far, merged from reads that each carry only what
 * changed. No DOM and no reads here, so the merge and the markup are measured in the node lane.
 *
 * Every word in an entry is the agent's, or a tool's, and is drawn as text. The agent's own
 * messages go through the Markdown subset, which escapes every character before it adds a tag;
 * nothing else is interpreted at all.
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
}

export function emptyChat(): AgentChat {
  return {
    key: '', exists: false, agentId: null, name: 'Agent', commandLine: null, endpoint: null, level: 'Off',
    state: 'none', working: false, notice: null, agentTitle: null, revision: 0, entries: new Map(), signInMethods: [],
  };
}

/**
 * Take in one read. A read whose revision is older than what the chat holds is a late answer and
 * changes nothing; a read of another conversation (another launch) starts the chat again.
 * Returns the IDs of the entries that changed, for the page to patch.
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

export function stateLabel(chat: AgentChat): string {
  switch (chat.state) {
    case 'starting': return 'Starting';
    case 'signIn': return 'Sign in needed';
    case 'ready': return chat.working ? 'Working' : 'Ready';
    case 'ended': return 'Ended';
    default: return 'Not running';
  }
}

/** Whether the person can send now, and whether Stop has anything to stop. */
export function composerState(chat: AgentChat): { canSend: boolean; canStop: boolean; placeholder: string } {
  const canSend = chat.state === 'ready' && !chat.working;
  const placeholder = chat.state === 'ended' ? 'This conversation has ended. Launch the agent again from the Agent page.'
    : chat.state === 'starting' ? `Waiting for ${chat.name} to start…`
      : chat.state === 'signIn' ? `Sign in to ${chat.name} first.`
        : chat.working ? `${chat.name} is working. Press Stop to interrupt it.`
          : `Ask ${chat.name} to change this file…`;
  return { canSend, canStop: chat.working, placeholder };
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

/** One entry as the page draws it. */
export function entryMarkup(entry: AgentTranscriptEntry, agentName: string): string {
  const id = escapeAttribute(entry.id);
  switch (entry.kind) {
    case 'you':
      return `<article class="chat-entry is-you" data-entry-id="${id}"><span class="chat-who">You</span><div class="chat-bubble">${escapeHtml(entry.text)}</div></article>`;
    case 'agent':
      return `<article class="chat-entry is-agent" data-entry-id="${id}"><span class="chat-who">${escapeHtml(agentName)}</span><div class="chat-markdown markdown-body">${markdownMarkup(entry.text, { headingShift: 2 })}</div></article>`;
    case 'thought':
      return `<details class="chat-entry is-thought" data-entry-id="${id}"><summary>Thinking</summary><div class="chat-plain">${escapeHtml(entry.text)}</div></details>`;
    case 'tool': {
      const status = entry.status ?? 'pending';
      const kind = toolKinds[entry.toolKind ?? 'other'] ?? 'Tool';
      return `<article class="chat-entry is-tool" data-entry-id="${id}" data-status="${escapeAttribute(status)}">
        <span class="chat-tool-mark" aria-hidden="true">${toolIcon(entry.toolKind)}</span>
        <div class="chat-tool-body"><strong>${escapeHtml(entry.title ?? 'A tool call')}</strong><small>${escapeHtml(kind)} · ${escapeHtml(statuses[status] ?? status)}</small>
        ${entry.input === null ? '' : `<details><summary>What it sent</summary><pre class="chat-plain">${escapeHtml(entry.input)}</pre></details>`}
        ${entry.text === '' ? '' : `<details><summary>What came back</summary><pre class="chat-plain">${escapeHtml(entry.text)}</pre></details>`}</div>
      </article>`;
    }
    case 'plan':
      return `<article class="chat-entry is-plan" data-entry-id="${id}"><span class="chat-who">Plan</span><ol>${(entry.plan ?? []).map((item) =>
        `<li data-status="${escapeAttribute(item.status)}"><span class="chat-plan-mark" aria-hidden="true">${item.status === 'completed' ? icon('check') : ''}</span>${escapeHtml(item.text)}</li>`).join('')}</ol></article>`;
    case 'permission': {
      const answered = entry.answer !== null;
      return `<article class="chat-entry is-permission${answered ? ' is-answered' : ''}" data-entry-id="${id}">
        <span class="chat-who">${escapeHtml(agentName)} asks</span>
        <strong>${escapeHtml(entry.title ?? 'A tool call')}</strong>
        ${entry.input === null ? '' : `<pre class="chat-plain">${escapeHtml(entry.input)}</pre>`}
        ${answered
          ? `<p class="chat-answer">You answered: ${escapeHtml(entry.answer!)}</p>`
          : `<div class="chat-options">${(entry.options ?? []).map((option) =>
            `<button type="button" class="${option.kind.startsWith('allow') ? 'primary-button' : 'secondary-button'}" data-answer-entry="${id}" data-option-id="${escapeAttribute(option.optionId)}">${escapeHtml(option.name)}</button>`).join('')}</div>`}
      </article>`;
    }
    default:
      return `<p class="chat-entry is-notice" data-entry-id="${id}">${escapeHtml(entry.text)}</p>`;
  }
}
