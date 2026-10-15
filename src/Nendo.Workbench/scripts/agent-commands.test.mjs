import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// ACP slash commands (owner, 2026-10-15): the agent advertises its commands, the message box
// offers them after a / that starts the message, and running one is the message itself.
const { commandAt, commandChoices, commandHint, commandMenuMarkup, keysLine, maximumCommandChoices } = await bundleOf('src/agent-command-model.ts');
const { emptyChat, mergeChat } = await bundleOf('src/agent-chat-model.ts');

const commands = [
  { name: 'review', description: 'Review the open changes', hint: 'what to review' },
  { name: 'compact', description: 'Summarise the conversation so far', hint: null },
  { name: 'pr-comments', description: 'Read the comments on a pull request', hint: '' },
];

test('a / menu opens only in the first word of a message that starts with /', () => {
  assert.deepEqual(commandAt('/', 1), { query: '' });
  assert.deepEqual(commandAt('/rev', 4), { query: 'rev' });
  assert.deepEqual(commandAt('/rev the books', 4), { query: 'rev' });
  assert.equal(commandAt('/review the books', 10), null, 'The menu followed the caret past the command into its input.');
  assert.equal(commandAt('/review', 3), null, 'The menu opened with the caret inside a name, which a choice would split.');
  assert.equal(commandAt('Please /review', 14), null, 'A / later in the message is not a command.');
  assert.equal(commandAt(' /review', 8), null);
  assert.equal(commandAt('/rev', 0), null);
});

test('typing narrows the commands: names that start with it first, then names that contain it', () => {
  assert.deepEqual(commandChoices(commands, '').map((command) => command.name), ['review', 'compact', 'pr-comments']);
  assert.deepEqual(commandChoices(commands, 'com').map((command) => command.name), ['compact', 'pr-comments']);
  assert.deepEqual(commandChoices(commands, 'RE').map((command) => command.name), ['review']);
  assert.deepEqual(commandChoices(commands, 'zzz'), []);
  const many = Array.from({ length: 80 }, (_, index) => ({ name: `c${index}`, description: '', hint: null }));
  assert.equal(commandChoices(many, '').length, maximumCommandChoices);
});

test('the menu draws the agent\'s words as text', () => {
  const hostile = '<img src=x onerror="alert(1)">';
  const html = commandMenuMarkup([{ name: hostile, description: hostile, hint: hostile }], 0, hostile);
  assert.ok(!html.includes('<img'), html);
  assert.match(html, /role="option" id="command-option-0"/);
  assert.match(html, /aria-selected="true"/);
  assert.match(commandMenuMarkup([], 0, 'Claude'), /Claude has no command by that name/);
});

test('the hint of the command written shows until its input follows', () => {
  assert.deepEqual(commandHint('/review', commands), { name: 'review', hint: 'what to review' });
  assert.deepEqual(commandHint('/review ', commands), { name: 'review', hint: 'what to review' });
  assert.equal(commandHint('/review the books', commands), null);
  assert.equal(commandHint('/compact ', commands), null, 'A command that takes no input was given a hint.');
  assert.equal(commandHint('/pr-comments ', commands), null, 'An empty hint was shown.');
  assert.equal(commandHint('/unknown ', commands), null);
  assert.equal(commandHint('review ', commands), null);
});

test('the keys under the box name / only when the agent has commands', () => {
  assert.doesNotMatch(keysLine(false), /\//);
  assert.match(keysLine(true), / \/ runs one of the agent's commands/);
});

test('a read carries the agent\'s commands into the chat, and an older host\'s read leaves none', () => {
  const chat = emptyChat();
  const view = (fields) => ({
    exists: true, conversationId: 'c1', agentId: 'claude', name: 'Claude', commandLine: null, endpoint: null, level: 'Edit data',
    state: 'ready', working: false, notice: null, agentTitle: null, revision: 1, entries: [], more: false, signInMethods: [], options: [], firstOrder: 0, ...fields,
  });
  mergeChat(chat, view({ commands }), 'k');
  assert.deepEqual(chat.commands.map((command) => command.name), ['review', 'compact', 'pr-comments']);
  mergeChat(chat, view({ revision: 2 }), 'k');
  assert.deepEqual(chat.commands, []);
});
