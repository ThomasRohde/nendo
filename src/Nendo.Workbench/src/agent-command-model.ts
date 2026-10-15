import { escapeHtml } from './format';
import type { AgentCommand } from './host-types';

/**
 * The agent's slash commands in the message box (ACP available_commands_update). The agent
 * advertises them; the box offers them when a message starts with /, and running one is the
 * message itself, /name and what follows, sent as any other. No DOM here, so the menu is measured
 * in the node lane.
 */

/** At most this many commands are listed at once; typing narrows the rest. */
export const maximumCommandChoices = 50;

/**
 * The command name being typed at the caret: only in a message that starts with /, and only while
 * the caret is still in its first word. Null anywhere else, so an @ later in the message is the
 * other menu's.
 */
export function commandAt(text: string, caret: number): { query: string } | null {
  if (!text.startsWith('/') || caret < 1) return null;
  const query = text.slice(1, caret);
  if (/\s/.test(query) || query.length > 100) return null;
  // The caret must end the first word, not stand inside it with more of the name after it.
  const rest = text.slice(caret);
  if (rest.length > 0 && !/^\s/.test(rest)) return null;
  return { query };
}

/** Commands whose name starts with what was typed, then those that only contain it, in the agent's order. */
export function commandChoices(commands: readonly AgentCommand[], query: string): AgentCommand[] {
  const wanted = query.toLowerCase();
  const starts = commands.filter((command) => command.name.toLowerCase().startsWith(wanted));
  const contains = wanted === '' ? [] : commands.filter((command) => !command.name.toLowerCase().startsWith(wanted) && command.name.toLowerCase().includes(wanted));
  return [...starts, ...contains].slice(0, maximumCommandChoices);
}

export function commandMenuMarkup(choices: readonly AgentCommand[], active: number, agentName: string): string {
  const body = choices.map((command, index) =>
    `<div class="mention-option command-option" role="option" id="command-option-${index}" data-command="${index}" aria-selected="${index === active}"><span class="mention-label">/${escapeHtml(command.name)}</span><span class="mention-detail">${escapeHtml(command.description)}${command.hint !== null && command.hint !== '' ? ` <em class="command-hint">${escapeHtml(command.hint)}</em>` : ''}</span></div>`).join('');
  const empty = choices.length === 0 ? `<div class="mention-empty">${escapeHtml(agentName)} has no command by that name.</div>` : '';
  return `<div class="mention-group" role="group" aria-label="${escapeHtml(agentName)}'s commands"><div class="mention-head" aria-hidden="true">${escapeHtml(agentName)}'s commands</div>${body}</div>${empty}<div class="mention-keys" aria-hidden="true"><span><kbd>↑</kbd> <kbd>↓</kbd> choose</span><span><kbd>Tab</kbd> write</span><span><kbd>Enter</kbd> write or send</span><span><kbd>Esc</kbd> close</span></div>`;
}

/** The keys under the box; / is named only when the agent has commands to offer. */
export function keysLine(hasCommands: boolean): string {
  return `Enter sends · Shift+Enter for a new line · @ points at something in the file${hasCommands ? " · / runs one of the agent's commands" : ''}`;
}

/**
 * What the command written in the box takes, as the agent hints it, while nothing has been
 * written after it: "/review " shows "what to review". Null once input follows, or for a command
 * that takes none.
 */
export function commandHint(text: string, commands: readonly AgentCommand[]): { name: string; hint: string } | null {
  const match = /^\/(\S+)\s*$/.exec(text);
  if (match === null) return null;
  const command = commands.find((candidate) => candidate.name === match[1]);
  return command === undefined || command.hint === null || command.hint === '' ? null : { name: command.name, hint: command.hint };
}
