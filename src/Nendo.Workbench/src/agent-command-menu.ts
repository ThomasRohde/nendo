import { commandAt, commandChoices, commandHint, commandMenuMarkup } from './agent-command-model';
import { fitMenu } from './agent-mention';
import type { AgentCommand } from './host-types';
import { announce } from './shell';

/**
 * The / menu in the agent tab's message box: the agent's own slash commands (ACP). It opens while
 * a message starts with / and the caret is in its first word, so it never meets the @ menu, which
 * wants an @ where a word starts. A choice writes /name and a space; the message then goes as any
 * other, and the agent runs the command it names.
 */

let menu: { query: string; choices: AgentCommand[]; active: number } | null = null;
let commands: () => { list: readonly AgentCommand[]; agent: string } = () => ({ list: [], agent: 'The agent' });

function drawMenu(page: ParentNode): void {
  const list = page.querySelector<HTMLElement>('#chat-commands');
  const prompt = page.querySelector<HTMLTextAreaElement>('#agent-prompt');
  if (list === null || prompt === null) return;
  if (menu === null) {
    if (list.hidden) return;
    list.hidden = true;
    list.innerHTML = '';
    prompt.removeAttribute('aria-activedescendant');
    prompt.setAttribute('aria-controls', 'chat-mention');
    return;
  }
  const opening = list.hidden;
  list.hidden = false;
  list.innerHTML = commandMenuMarkup(menu.choices, menu.active, commands().agent);
  fitMenu(list);
  prompt.setAttribute('aria-controls', 'chat-commands');
  if (opening && menu.choices.length > 0) announce(`${menu.choices.length} ${menu.choices.length === 1 ? 'command' : 'commands'}; up and down to choose, Tab to write one.`);
  if (menu.choices.length > 0) {
    prompt.setAttribute('aria-activedescendant', `command-option-${menu.active}`);
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  } else prompt.removeAttribute('aria-activedescendant');
}

/** The line under the box names what the command written takes, until something is written after it. */
function drawHint(page: ParentNode, prompt: HTMLTextAreaElement): void {
  const slot = page.querySelector<HTMLElement>('#chat-command-hint');
  if (slot === null) return;
  const hint = commandHint(prompt.value, commands().list);
  const text = hint === null ? '' : `/${hint.name}: ${hint.hint}`;
  if (slot.textContent === text) return;
  slot.textContent = text;
  slot.hidden = hint === null;
  // The hint takes the keys' place while it shows.
  const keys = page.querySelector<HTMLElement>('#chat-keys');
  if (keys !== null) keys.hidden = hint !== null;
}

/** Open, refresh or close the menu from where the caret is. */
function follow(page: ParentNode, prompt: HTMLTextAreaElement): void {
  drawHint(page, prompt);
  const { list } = commands();
  const found = list.length > 0 && prompt.selectionStart === prompt.selectionEnd ? commandAt(prompt.value, prompt.selectionStart) : null;
  if (found === null) { close(page); return; }
  const same = menu !== null && menu.query === found.query;
  const choices = commandChoices(list, found.query);
  menu = { query: found.query, choices, active: same ? Math.min(menu!.active, Math.max(choices.length - 1, 0)) : 0 };
  drawMenu(page);
}

function close(page: ParentNode): void {
  if (menu === null) return;
  menu = null;
  drawMenu(page);
}

/** Write /name and a space in place of the first word, and leave the caret after it. */
function choose(page: ParentNode, prompt: HTMLTextAreaElement, index: number): void {
  const chosen = menu?.choices[index];
  if (chosen === undefined) return;
  close(page);
  const rest = prompt.value.slice(prompt.selectionStart).replace(/^\s+/, '');
  const written = `/${chosen.name} `;
  prompt.value = written + rest;
  prompt.selectionStart = prompt.selectionEnd = written.length;
  prompt.dispatchEvent(new Event('input', { bubbles: true }));
  announce(chosen.hint !== null && chosen.hint !== '' ? `/${chosen.name}: ${chosen.hint}` : `/${chosen.name}`);
}

/**
 * The keys the menu takes while it is open; true when the key was the menu's. Enter on a name
 * typed out in full is the person sending it, so it goes on to the box; Tab always writes.
 */
export function commandKey(event: KeyboardEvent, page: ParentNode, prompt: HTMLTextAreaElement): boolean {
  if (menu === null) return false;
  const count = menu.choices.length;
  switch (event.key) {
    case 'ArrowDown': case 'ArrowUp':
      if (count === 0) return true;
      event.preventDefault();
      menu.active = (menu.active + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
      drawMenu(page);
      return true;
    case 'Enter': case 'Tab': {
      if (count === 0 || event.shiftKey) return false;
      if (event.key === 'Enter' && menu.choices[menu.active]!.name === menu.query) { close(page); return false; }
      event.preventDefault();
      choose(page, prompt, menu.active);
      return true;
    }
    case 'Escape':
      event.preventDefault();
      close(page);
      return true;
    default:
      return false;
  }
}

/** Wire the menu of a freshly drawn tab to the agent's commands, read afresh as the person types. */
export function wireCommands(page: HTMLElement, read: () => { list: readonly AgentCommand[]; agent: string }): void {
  commands = read;
  const prompt = page.querySelector<HTMLTextAreaElement>('#agent-prompt')!;
  const list = page.querySelector<HTMLElement>('#chat-commands')!;
  prompt.addEventListener('input', () => follow(page, prompt));
  prompt.addEventListener('click', () => follow(page, prompt));
  prompt.addEventListener('blur', () => window.setTimeout(() => { if (document.activeElement !== prompt) close(page); }, 120));
  list.addEventListener('mousedown', (event) => event.preventDefault());
  list.addEventListener('click', (event) => {
    const option = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-command]') : null;
    if (option !== null) choose(page, prompt, Number(option.dataset.command));
  });
  menu = null;
  drawHint(page, prompt);
}

/** The agent restated its commands: an open menu shows the new ones at once. */
export function commandsChanged(page: ParentNode): void {
  const prompt = page.querySelector<HTMLTextAreaElement>('#agent-prompt');
  if (prompt !== null && document.activeElement === prompt && (menu !== null || prompt.value.startsWith('/'))) follow(page, prompt);
  else if (prompt !== null) drawHint(page, prompt);
}
