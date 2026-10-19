import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, slugify, idPart, fnv1a, excerptAround } from '../../extensions/garden/parse.mjs';

test('wikilinks: plain, aliased, once each, trimmed, with the line around them as context', () => {
  const { links } = parse('See [[How links work]] and [[how-links-work|the same note]] and [[ Daily notes ]].');
  assert.deepEqual(links.map(l => [l.target, l.label]), [['How links work', null], ['how-links-work', 'the same note'], ['Daily notes', null]]);
  assert.equal(links[0].excerpt, 'See [[How links work]] and [[how-links-work|the same note]] and [[ Daily notes ]].');
  assert.equal(links[0].line, 0);
  assert.deepEqual(parse('[[a]] [[A]] [[a]]').links.length, 1, 'a target is one link however often it is named');
});

test('a fenced block and inline code say nothing: no link, tag or task inside them', () => {
  const body = ['Before [[real]] #real', '```', '[[not-a-link]] #not-a-tag', '- [ ] not a task', '```', 'After `[[inline]] #inline` - [ ] real task'].join('\n');
  const parsed = parse(body);
  assert.deepEqual(parsed.links.map(l => l.target), ['real']);
  assert.deepEqual(parsed.tags, ['real']);
  assert.deepEqual(parsed.tasks.map(t => t.text), []);
  assert.deepEqual(parse('~~~\n[[x]]\n~~~\n- [ ] after').tasks.map(t => t.text), ['after'], 'tildes fence too');
  assert.deepEqual(parse('````\n```\n[[x]]\n````\n[[y]]').links.map(l => l.target), ['y'], 'a shorter fence inside a longer one does not close it');
});

test('tags: after a space or at the start, lower-cased, never a heading, a number or a URL fragment', () => {
  const { tags } = parse('# Heading\n#Garden and #how-to, #agents/claude; not#this nor https://x.y/#frag nor #2026 but #a1');
  assert.deepEqual(tags, ['garden', 'how-to', 'agents/claude', 'a1']);
});

test('checkbox tasks keep a key from their text that survives ticking and reordering', () => {
  const open = parse('- [ ] Water the seeds\n* [x] Prune\n+ [X] Weed  ').tasks;
  assert.deepEqual(open.map(t => [t.text, t.done]), [['Water the seeds', false], ['Prune', true], ['Weed', true]]);
  const ticked = parse('- [x] Water   the seeds').tasks[0];
  assert.equal(ticked.key, open[0].key, 'the key ignores the box and the spacing');
  assert.equal(ticked.done, true);
  // Two lines that say the same task are two tasks, the second keyed -2, a case-only variant too.
  const twice = parse('- [ ] Repeat\n## Later\n- [x] Repeat\n- [ ] repeat').tasks;
  assert.deepEqual(twice.map(t => [t.key, t.done, t.line]), [[twice[0].key, false, 0], [`${twice[0].key}-2`, true, 2], [`${twice[0].key}-3`, false, 3]]);
  assert.equal(new Set(twice.map(t => t.key)).size, 3);
  assert.match(open[0].key, /^[0-9a-f]{8}$/);
});

test('slugify makes a stable address and fnv1a a stable key', () => {
  assert.equal(slugify('  Café — Notes & Ideas!  '), 'cafe-notes-ideas');
  assert.equal(slugify('x'.repeat(100)).length, 64);
  assert.equal(slugify('!!!'), 'note');
  assert.equal(fnv1a('water the seeds'), fnv1a('water the seeds'));
  assert.notEqual(fnv1a('a'), fnv1a('b'));
});

test('an excerpt keeps the match inside a window of the width asked for', () => {
  const long = `${'x'.repeat(300)} [[target]] ${'y'.repeat(300)}`;
  const excerpt = excerptAround(long, 301, 200);
  assert.ok(excerpt.includes('[[target]]'));
  assert.ok(excerpt.length <= 202);
  // Seven-letter words, so the window (66 characters before the link) opens in the middle of one.
  const words = excerptAround(`${'alphas '.repeat(60)}[[target]] ${'omegas '.repeat(60)}`, 420, 200);
  assert.match(words, /^…alphas /, `an excerpt starts at a word: ${words.slice(0, 20)}`);
  assert.match(words, / omegas…$/, `an excerpt ends at a word: ${words.slice(-20)}`);
  assert.equal(excerptAround('  short  ', 2, 200), 'short');
});

test('a title in any script keeps a readable slug of its own, and a record ID stays a-z', () => {
  const titles = ['Заметки о саде', '庭のメモ', 'Σημειώσεις', 'ملاحظات', 'Smørrebrød'];
  const slugs = titles.map(slugify);
  assert.deepEqual(slugs, ['заметки-о-саде', '庭のメモ', 'σημειωσεισ', 'ملاحظات', 'smørrebrød'],
    `a non-Latin title must keep its letters in its slug rather than become 'note': ${JSON.stringify(slugs)}`);
  assert.equal(new Set(slugs).size, titles.length, 'titles in different scripts must not share a slug');
  assert.equal(slugify('Café — Notes'), 'cafe-notes', 'a Latin accent is still dropped, so existing slugs keep meaning the same');
  assert.equal(slugify('ガーデン'), 'ガーデン', 'a voiced kana keeps its mark');
  assert.equal(slugify('ΣΗΜΕΙΩΣΕΙΣ'), slugify('Σημειώσεις'), 'a Greek final sigma is a sigma, so one title in either case makes one slug');
  assert.equal(Array.from(slugify('ж'.repeat(100))).length, 64, 'at most 64 characters, counted as characters');
  assert.equal(idPart('Заметки о саде'), 'note', 'a record ID part keeps only a-z, 0-9 and hyphens');
  assert.equal(idPart('Café — Notes'), 'cafe-notes');
});
