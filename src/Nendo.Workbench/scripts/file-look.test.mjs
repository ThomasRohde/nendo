import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { build } from 'vite';

const bundle = await build({ configFile: false, logLevel: 'error',
  build: { ssr: 'src/file-look.ts', write: false, rollupOptions: { output: { codeSplitting: false } } } });
const look = await import('data:text/javascript;base64,' + Buffer.from(bundle.output.find(item => item.type === 'chunk').code).toString('base64'));

// W-089. The About page shows a file's icon, the badge the taskbar, the notification area and
// every notification carry, and lets the person choose its colour and letter by proposal.
const byDefault = { tone: 'amber', letter: 'N', toneChosen: false, letterChosen: false, defaultTone: 'amber', defaultLetter: 'N' };
const chosen = { tone: 'violet', letter: 'P', toneChosen: true, letterChosen: true, defaultTone: 'amber', defaultLetter: 'N' };

test('the page shows the icon as the taskbar draws it, and says whether it was chosen', () => {
  const markup = look.aboutLookMarkup(byDefault, true);
  assert.match(markup, /<span class="look-badge" data-tone="amber">N<\/span>/);
  assert.match(markup, /Amber with the letter N, by default\./);
  assert.match(look.aboutLookMarkup(chosen, true), /Violet with the letter P\./);
  assert.match(markup, /<input type="radio" name="look-tone" value="amber" checked \/>/);
  assert.equal((markup.match(/name="look-tone"/g) ?? []).length, 8, 'every choice tone is offered');
  assert.match(markup, /data-look-defaults disabled/, 'a file already on its defaults has nothing to return to');
  assert.doesNotMatch(look.aboutLookMarkup(chosen, true), /data-look-defaults disabled/);
  // Where the file cannot be changed the icon is shown and nothing is offered.
  const readOnly = look.aboutLookMarkup(chosen, false);
  assert.match(readOnly, /look-badge/);
  assert.doesNotMatch(readOnly, /look-tone|look-letter|data-look-review/);
});

test('opening the page and reviewing changes nothing, and a change becomes one reviewed operation', () => {
  assert.equal(look.lookProposal(byDefault, look.chosenLook(byDefault, 'amber', 'N'), 7), null, 'the defaults as shown are no change');
  assert.equal(look.lookProposal(chosen, look.chosenLook(chosen, 'violet', 'P'), 7), null, 'a chosen look as shown is no change');

  const tone = look.lookProposal(byDefault, look.chosenLook(byDefault, 'teal', 'N'), 7);
  const operation = tone.mutations[0].operations[0];
  assert.equal(operation.operationType, 'application.setLook');
  assert.deepEqual(operation.payload, { tone: 'teal', letter: null, expectedDefinitionRevision: 7 },
    'the letter left as it was stays the default, and follows the file name');
  assert.equal(tone.title, 'Give this file its own icon');
  assert.match(tone.proposalId, /^proposal-[0-9a-f]{32}$/);

  const back = look.lookProposal(chosen, { tone: null, letter: null }, 9);
  assert.deepEqual(back.mutations[0].operations[0].payload, { tone: null, letter: null, expectedDefinitionRevision: 9 });
  assert.equal(back.title, 'Give this file back its default icon');
  assert.equal(look.lookProposal(byDefault, { tone: null, letter: null }, 9), null, 'defaults to defaults is no change');
  assert.throws(() => look.lookProposal(byDefault, { tone: 'pink', letter: null }, 1), /Choose one of the offered colours/);
});

test('a letter is one letter or digit, in upper case', () => {
  assert.equal(look.normaliseLetter('p'), 'P');
  assert.equal(look.normaliseLetter(' 7 '), '7');
  assert.equal(look.normaliseLetter('ø'), 'Ø');
  for (const refused of ['', 'AB', '-', '😀', ' ']) assert.equal(look.normaliseLetter(refused), null, JSON.stringify(refused));
});

test('every class the look markup emits has a rule, and every tone has a colour token', () => {
  const source = readFileSync(new URL('../src/file-look.ts', import.meta.url), 'utf8');
  const styles = readFileSync(new URL('../src/styles/01-file-menu.css', import.meta.url), 'utf8');
  const tokens = readFileSync(new URL('../src/styles/02-tokens.css', import.meta.url), 'utf8');
  const emitted = [...source.matchAll(/class="([a-z][a-z0-9- ]*)"/g)].flatMap((match) => match[1].split(' ')).filter(Boolean);
  assert.ok(emitted.length >= 6, 'the guard reads the markup');
  for (const name of new Set(emitted)) {
    if (name === 'secondary-button' || name === 'visually-hidden') continue;
    assert.ok(styles.includes(`.${name}`), `class "${name}" has no rule in 01-file-menu.css`);
  }
  const light = tokens.slice(0, tokens.indexOf(':root[data-theme="dark"]'));
  for (const tone of look.lookTones) {
    const toneValue = light.match(new RegExp(`--tone-${tone}: (#[0-9a-f]{6});`))?.[1];
    const lookValue = light.match(new RegExp(`--look-${tone}: (#[0-9a-f]{6});`))?.[1];
    assert.ok(toneValue && lookValue, `--tone-${tone} and --look-${tone} are both declared`);
    assert.equal(lookValue, toneValue, `the icon's ${tone} is the light choice tone`);
    assert.match(styles, new RegExp(`\\.look-badge\\[data-tone="${tone}"\\][^{]*\\{ background: var\\(--look-${tone}\\); \\}`));
  }
});
