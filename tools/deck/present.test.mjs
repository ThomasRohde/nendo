import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutSlide, approxMeasure } from '../../extensions/deck/layout.mjs';
import { slideHtml } from '../../extensions/deck/render.mjs';
import { buildPptx } from '../../extensions/deck/pptx.mjs';
import { buildHtml, planOf } from '../../extensions/deck/export-html.mjs';
import { checkDeck, lengthLine, spokenSeconds, wordsOf, clock, SLIDE_WORDS, DEFAULT_SECONDS } from '../../extensions/deck/check.mjs';
import { slideFrom, transitionOf, F } from '../../extensions/deck/model.mjs';
import { unzip } from '../../extensions/deck/zip.mjs';
import { TEMPLATES, resolveTheme } from '../../extensions/deck/themes.mjs';

const theme = resolveTheme(TEMPLATES[0], null, { aspect: '16:9' });
const lay = (slide, t = theme) => layoutSlide({ title: 'T', kicker: '', body: '', body2: '', chart: 'Column', image: null, ...slide }, t, { measure: approxMeasure, number: 1 });
const text = async entry => new TextDecoder().decode(await entry.bytes());
const stepsOf = l => [...new Set([...l.items.map(p => p.step), ...l.items.flatMap(p => (p.paragraphs ?? []).map(q => q.step))].filter(Boolean))].sort((a, b) => a - b);

test('a slide built one by one counts a click per point, and one that is not counts none', () => {
  const bullets = lay({ layout: 'Bullets', body: '- One\n  - under one\n- Two\n- Three', build: 'One by one' });
  assert.equal(bullets.steps, 3);
  const body = bullets.items.find(p => p.role === 'body');
  assert.deepEqual(body.paragraphs.map(p => p.step), [1, 1, 2, 3], 'a sub-point comes with its point');
  assert.ok(bullets.items.filter(p => p.role === 'title').every(p => !p.step), 'the title is there from the start');
  const flat = lay({ layout: 'Bullets', body: '- One\n- Two' });
  assert.equal(flat.steps, 0);
  assert.ok(flat.items.every(p => !p.step && !(p.paragraphs ?? []).some(q => q.step)), 'no build, no steps');
  for (const [layout, body, steps] of [
    ['Cards', '- A | a\n- B | b\n- C | c\n- D | d', 4], ['Big numbers', '- 1 | a\n- 2 | b\n- 3 | c', 3], ['Agenda', '- A\n- B\n- C\n- D\n- E', 5],
    ['Timeline', '- 2024 | a\n- 2025 | b', 2], ['Table', '| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |', 3],
    ['Two columns', '- a\n- b', 2], ['Comparison', '### Before\n- a\n- b', 3],
  ]) {
    const l = lay({ layout, body, body2: layout === 'Comparison' ? '### After\n- c' : '', build: 'One by one' });
    assert.equal(l.steps, steps, layout);
    assert.deepEqual(stepsOf(l), Array.from({ length: steps }, (_, i) => i + 1), `${layout}: every click brings something on`);
  }
  for (const layout of ['Title', 'Section', 'Statement', 'Quote', 'Closing', 'Full image']) assert.equal(lay({ layout, body: '- a\n- b', build: 'One by one' }).steps, 0, layout);
});

test('a chart builds its bars by label, its series by series, and its takeaway last', () => {
  const one = lay({ layout: 'Chart', body: '| Q | n |\n| --- | --- |\n| a | 1 |\n| b | 2 |\n| c | 3 |', body2: 'Up and up.', build: 'One by one' });
  assert.equal(one.steps, 4);
  assert.equal(one.items.find(p => p.role === 'body2').step, 4, 'the takeaway comes last');
  const two = lay({ layout: 'Chart', body: '| Q | n | m |\n| --- | --- | --- |\n| a | 1 | 2 |\n| b | 2 | 3 |', build: 'One by one' });
  assert.equal(two.steps, 2, 'two series, two clicks');
  const ring = lay({ layout: 'Chart', chart: 'Doughnut', body: '| Q | n |\n| --- | --- |\n| a | 1 |\n| b | 2 |\n| c | 3 |', build: 'One by one' });
  assert.equal(ring.steps, 3);
  assert.ok(ring.items.filter(p => p.type === 'arc').every((p, i) => p.step === i + 1), 'each part of the doughnut a click');
  assert.ok(one.items.filter(p => p.type === 'line').every(p => !p.step), 'the grid is there from the start');
});

test('the slide HTML says what each click brings on', () => {
  const l = lay({ layout: 'Cards', body: '- A | a\n- B | b', build: 'One by one' });
  const html = slideHtml(l);
  assert.match(html, /class="dk-slide [^"]*" data-steps="2"/);
  assert.equal((html.match(/ data-step="1"/g) ?? []).length, l.items.filter(p => p.step === 1).length);
  const bullets = slideHtml(lay({ layout: 'Bullets', body: '- a\n- b', build: 'One by one' }));
  assert.match(bullets, /<p data-step="1"[^>]*>.*<p data-step="2"/s, 'a body\'s paragraphs carry their own clicks');
});

test('PowerPoint gets the transition and a fade on click for each step', async () => {
  const slides = [
    { laid: lay({ layout: 'Bullets', body: '- One\n  - under\n- Two\n- Three', build: 'One by one' }), hidden: false, transition: 'Push' },
    { laid: lay({ layout: 'Cards', body: '- A | a\n- B | b', build: 'One by one' }), hidden: false, transition: 'Fade' },
    { laid: lay({ layout: 'Bullets', body: '- One' }), hidden: false, transition: 'None' },
    { laid: lay({ layout: 'Title' }), hidden: false, transition: 'Zoom' },
  ];
  const entries = unzip(buildPptx({ deck: { title: 'T' }, theme, slides, now: new Date('2026-10-24T12:00:00Z') }));
  const xml = await Promise.all([1, 2, 3, 4].map(n => text(entries.find(e => e.name === `ppt/slides/slide${n}.xml`))));
  assert.match(xml[0], /<\/p:clrMapOvr><p:transition spd="med"><p:push dir="l"\/><\/p:transition><p:timing>/, 'transition, then timing, after the colour map');
  assert.equal((xml[0].match(/<p:cond delay="indefinite"\/>/g) ?? []).length, 3, 'three clicks');
  assert.deepEqual([...xml[0].matchAll(/<p:pRg st="(\d+)" end="(\d+)"\/>/g)].map(m => [m[1], m[2]]).filter((_, i) => i % 2 === 0), [['0', '1'], ['2', '2'], ['3', '3']], 'a point and its sub-point are one range');
  assert.match(xml[0], /<p:bldP spid="\d+" grpId="0" build="p"\/>/);
  assert.equal((xml[0].match(/nodeType="clickEffect"/g) ?? []).length, 3);
  assert.match(xml[1], /<p:transition spd="med"><p:fade\/><\/p:transition>/);
  assert.equal((xml[1].match(/<p:cond delay="indefinite"\/>/g) ?? []).length, 2, 'a card a click');
  assert.ok((xml[1].match(/nodeType="withEffect"/g) ?? []).length > 0, 'a card\'s shapes come together');
  assert.ok(!xml[2].includes('<p:transition') && !xml[2].includes('<p:timing>'), 'no transition, no build');
  assert.match(xml[3], /<p:zoom dir="in"\/>/);
  // Every cTn id in a slide is its own.
  for (const x of xml) { const ids = [...x.matchAll(/<p:cTn id="(\d+)"/g)].map(m => m[1]); assert.equal(new Set(ids).size, ids.length); }
});

test('the plan: rehearsed times fitted to the target, the notes where there is no time', () => {
  assert.equal(planOf([null, null], null), null, 'no time and no target, no plan');
  assert.deepEqual(planOf([null, null], 2), [60, 60]);
  assert.deepEqual(planOf([30, 90], null), [30, 90]);
  assert.deepEqual(planOf([30, 90], 4), [60, 180]);
  const words = n => Array.from({ length: n }, () => 'word').join(' ');
  assert.deepEqual(planOf([null, null], 4, [words(130), words(390)]), [60, 180], 'the notes weigh the slides');
  assert.deepEqual(planOf([null, null], null, [words(130), '']), [60, DEFAULT_SECONDS], 'notes make a plan without a target');
  assert.deepEqual(planOf([40, null], null, ['', words(130)]), [40, 60], 'a rehearsed time wins, the notes fill the rest');
  assert.equal(planOf([null, null], null, ['', '']), null, 'empty notes, no plan');
});

test('the HTML file carries the steps, the transitions, the plan, and a rehearsal opens on the console', () => {
  const laid = lay({ layout: 'Bullets', body: '- a\n- b', build: 'One by one' });
  const slides = [{ html: slideHtml(laid), notes: 'n', title: 'A', steps: laid.steps, transition: 'Push', seconds: 30 }, { html: slideHtml(lay({ layout: 'Title' })), notes: '', title: 'B', steps: 0, transition: 'Fade', seconds: null }];
  const html = buildHtml({ title: 'D', W: 1280, H: 720, theme, slides, rehearse: true, embedded: true, minutes: 2 });
  const data = JSON.parse(/<script type="application\/json" id="data">(.*?)<\/script>/s.exec(html)[1]);
  assert.deepEqual(data.steps, [2, 0]);
  assert.deepEqual(data.transitions, ['Push', 'Fade']);
  assert.deepEqual(data.plan, [60, 60]);
  assert.equal(data.rehearse, true);
  assert.match(html, /<body class="rehearse">/);
  assert.ok(html.includes('Finish rehearsal') && !html.includes('id="c-audience"'), 'a frame in Nendo offers no second window');
  const shared = buildHtml({ title: 'D', W: 1280, H: 720, theme, slides });
  assert.ok(shared.includes('id="c-audience"'), 'the file in a browser offers the audience window');
  assert.ok(!/<script[^>]+src=/.test(shared), 'the player is written into the file');
});

test('the deck check finds what would trip the talk', () => {
  const s = (values, id) => ({ id, ...slideFrom({ recordId: id, values: Object.fromEntries(Object.entries(values).map(([k, x]) => [F.slide[k], x])) }) });
  const many = Array.from({ length: SLIDE_WORDS + 5 }, (_, i) => `word${i}`).join(' ');
  const slides = [
    s({ layout: 'Bullets', title: 'Fine', body: '- one\n- two', notes: 'Say it in about ten words here, plainly and slowly please.' }, 'a'),
    s({ layout: 'Bullets', title: '', body: '' }, 'b'),
    s({ layout: 'Bullets', title: 'Wordy', body: many, notes: 'n' }, 'c'),
    s({ layout: 'Image right', title: 'Picture', body: '- a', image: 'media:x', notes: 'n' }, 'd'),
    s({ layout: 'Title', title: 'Builds', build: 'One by one', notes: 'n', seconds: 45 }, 'e'),
    s({ layout: 'Bullets', title: 'Gone', hidden: true }, 'f'),
  ];
  const r = checkDeck(slides, { laid: x => lay(x), minutes: 3 });
  const of = id => r.issues.filter(x => x.slideId === id).map(x => x.text);
  assert.deepEqual(of('a'), []);
  assert.ok(of('b').includes('No title.') && of('b').includes('Nothing in the body yet.') && of('b').includes('No speaker notes.'));
  assert.ok(of('c').some(x => x.startsWith(`${SLIDE_WORDS + 6} words`)));
  assert.ok(of('d').some(x => x.includes('picture text')));
  assert.ok(of('e').some(x => x.includes('nothing to bring on')));
  assert.deepEqual(of('f'), [], 'a hidden slide is not checked');
  assert.equal(r.shown, 5); assert.equal(r.hidden, 1); assert.equal(r.rehearsed, 1);
  assert.equal(r.seconds[4], 45, 'a rehearsed time is the plan');
  assert.equal(r.seconds[1], 30, 'a slide with nothing is given the default');
  assert.match(lengthLine(r), /^About \d+:\d\d for a 3:00 talk: /);
  assert.equal(wordsOf('| a | b |\n| --- | --- |\n- **bold** [link](https://x.y)'), 4);
  assert.equal(spokenSeconds(''), null);
  assert.equal(spokenSeconds(Array(130).fill('w').join(' ')), 60);
  assert.equal(clock(3725), '1:02:05');
});

test('a slide reads its build, transition and time, and the deck\'s transition fills in', () => {
  const plain = slideFrom({ recordId: 's', values: {} });
  assert.deepEqual([plain.build, plain.transition, plain.seconds], ['None', 'Deck', null]);
  const set = slideFrom({ recordId: 's', values: { [F.slide.build]: 'One by one', [F.slide.transition]: 'Zoom', [F.slide.seconds]: 42 } });
  assert.deepEqual([set.build, set.transition, set.seconds], ['One by one', 'Zoom', 42]);
  assert.equal(transitionOf(plain, 'Fade'), 'Fade');
  assert.equal(transitionOf(set, 'Fade'), 'Zoom');
  assert.equal(transitionOf(plain, null), 'None');
  assert.equal(slideFrom({ recordId: 's', values: { [F.slide.seconds]: -3 } }).seconds, null);
});
