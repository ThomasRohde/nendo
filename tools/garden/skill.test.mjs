import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse, EXCERPT_WIDTH } from '../../extensions/garden/parse.mjs';
import { SKILL_FOLDER } from './definition.mjs';

// The skill tells an agent how to write a note's Body rows over MCP. If it says them differently from
// the view, the next save in the view rewrites what the agent wrote, so its worked example is checked
// against the view's own parser.
const skill = readFileSync(path.join(SKILL_FOLDER, 'SKILL.md'), 'utf8');

function workedExample() {
  const section = skill.slice(skill.indexOf('### Worked example'));
  const body = /\n````markdown\n([\s\S]*?)\n````\n/.exec(section);
  const rows = /\n```json\n([\s\S]*?)\n```\n/.exec(section);
  assert.ok(body && rows, 'the skill has a worked example: a ````markdown body and the ```json rows it makes');
  return { body: body[1], rows: JSON.parse(rows[1]) };
}

test('the skill\'s worked example derives the rows the view derives', () => {
  const { body, rows } = workedExample();
  const parsed = parse(body);
  assert.deepEqual(rows.links, parsed.links.map(link => ({ target: link.target, context: link.excerpt })), 'links: target and context');
  assert.deepEqual(rows.tags, parsed.tags, 'tags');
  assert.deepEqual(rows.tasks, parsed.tasks.map(task => ({ text: task.text, done: task.done, key: task.key })), 'tasks: text, done and key');
  // The example earns its place only if it shows the rules an agent gets wrong.
  assert.ok(parsed.links.length >= 2 && /\.\s.*\[\[/.test(parsed.links[0].excerpt), 'a link whose line holds more than one sentence');
  assert.ok(parsed.tasks.some(task => task.key.endsWith('-2')), 'a repeated checkbox line');
  assert.ok(/\n```\n[^`]*\[\[[^`]*\n```(\n|$)/.test(body), 'a fence with a [[link]] the view ignores');
});

test('the skill says a link\'s context is its line, and names the view\'s code as the reference', () => {
  assert.ok(!/sentence/i.test(skill), 'a link\'s context is the line it is on, not a sentence');
  assert.ok(skill.includes('the line the link is on'), 'the record table says what the context is');
  assert.ok(skill.includes(`over ${EXCERPT_WIDTH} characters`), `the skill names the ${EXCERPT_WIDTH}-character cut`);
  for (const file of ['parse.mjs', 'sync.mjs']) assert.ok(skill.includes(file), `the skill names ${file}`);
  assert.ok(/apply_writes`[^.]*`label`/.test(skill), 'the skill tells an agent to label its batch for History');
});
