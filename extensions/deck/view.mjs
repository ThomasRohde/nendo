// Deck: write slides, pick a template and a brand kit, present, and export to HTML and
// PowerPoint. Slides are records; the stage, the thumbnails, Present and both exports draw the
// same primitives from layout.mjs. The person's own agent writes whole decks, reworks one slide
// as variants, or runs a mission, through nendo.assistant.ask; its work lands as records.

import { E, F, LAYOUTS, LAYOUT_IDS, CHARTS, PICTURES, TRANSITIONS, SLIDE_TRANSITIONS, BUILDS, transitionOf, layoutOf, slideFrom, sortSlides, reorder } from './model.mjs';
import { TEMPLATES, resolveTheme, sizeOf, webFonts, BRAND_ROLES, normalHex } from './themes.mjs';
import { layoutSlide } from './layout.mjs';
import { slideHtml, SLIDE_CSS } from './render.mjs';
import { canvasMeasure, forgetMeasurements } from './measure.mjs';
import { buildPptx } from './pptx.mjs';
import { buildHtml } from './export-html.mjs';
import { checkDeck, lengthLine, spokenSeconds, clock } from './check.mjs';
import { importBrandFile, kitValues } from './brand-import.mjs';
import { readDesignPackage, designValues, templateSpecFrom, brandSpecFrom, sourceKey, IMAGE_FIELDS, SLOTS, DESIGN_EXTENSION } from './design.mjs';
import { differing, readDrafts, writeDrafts, sortDrafts, withoutWritten } from './drafts.mjs';
import { installFocusRing } from './kit/nendo-view-kit.js';
import { createStageEditor } from './stage-editor.mjs';
import { moveBlock, nudge, ordersFor, pick as pickSlides } from './order.mjs';
import { createSlideDrag, places, flip, ownMenu } from './arrange.mjs';

const nendo = window.nendo;
const $ = id => document.getElementById(id);
const SKILL = 'skill://dev.nendo.deck/deck/SKILL.md';

// Everything the probes read is on window.deck.
const deck = window.deck = {
  stageEditor: () => editor?.state() ?? null,
  ready: false, decks: [], templates: [], brands: [], slides: [], asks: [], variants: [],
  deckId: null, slideId: null, scope: 'Whole deck', tab: 'slide', theme: null, media: new Map(),
  pending: new Map(), held: [], problem: null, toolbars: 0, exports: [], presenting: false, canAsk: false, chrome: false,
  // The slides picked in the list or the sorter, in no order; the current slide is always one of them.
  selected: [], anchor: null, sorter: false, zoom: 220, steps: { undo: [], redo: [] }, clipboard: null,
};

document.getElementById('slide-css').textContent = SLIDE_CSS;
installFocusRing?.(document);

// ---- Small helpers -----------------------------------------------------------------------------

let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4200);
}
function problem(error, what) {
  const text = `${what}: ${error?.message ?? error}`;
  deck.problem = text;
  console.warn(text);
  toast(text);
}
const newId = prefix => `${prefix}-${(crypto.randomUUID?.() ?? Math.random().toString(16).slice(2) + Date.now().toString(16)).replace(/-/g, '').slice(0, 16)}`;
const today = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const v = (record, field) => record?.values?.[field] ?? null;
const currentDeck = () => deck.decks.find(d => d.recordId === deck.deckId) ?? null;
const currentSlide = () => deck.slides.find(s => s.id === deck.slideId) ?? deck.slides[0] ?? null;
/** The picked slides in the deck's order: the current one at least. */
const selectedSlides = () => deck.slides.filter(s => deck.selected.includes(s.id) || s.id === deck.slideId);
/** Keeps the pick to slides still in the deck, with the current slide in it. */
function keepSelection() {
  const here = new Set(deck.slides.map(s => s.id));
  deck.selected = deck.selected.filter(id => here.has(id));
  if (deck.slideId && !deck.selected.includes(deck.slideId)) deck.selected = deck.selected.length ? [...deck.selected, deck.slideId] : [deck.slideId];
  if (!here.has(deck.anchor)) deck.anchor = deck.slideId;
}
function debounce(fn, ms) { let t = null; const run = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; run.flush = (...a) => { clearTimeout(t); return fn(...a); }; return run; }

// ---- Reading the file --------------------------------------------------------------------------

async function all(entityId, filters) {
  return nendo.records.queryAll({ entityId, ...(filters ? { filters } : {}) }, { max: 5000 });
}

async function load() {
  const [decks, templates, brands] = await Promise.all([all(E.deck), all(E.template), all(E.brand)]);
  deck.decks = decks.sort((a, b) => String(v(a, F.deck.title)).localeCompare(String(v(b, F.deck.title))));
  deck.templates = templates;
  deck.brands = brands;
  if (!deck.decks.some(d => d.recordId === deck.deckId)) {
    const place = nendo.context?.place;
    deck.deckId = deck.decks.find(d => d.recordId === place?.deck)?.recordId
      ?? deck.decks.find(d => !/^example:/i.test(v(d, F.deck.title) ?? ''))?.recordId ?? deck.decks[0]?.recordId ?? null;
    if (place?.slide) deck.slideId = place.slide;
  }
  if (deck.deckId) {
    const byDeck = field => [{ fieldId: field, operator: 'eq', value: deck.deckId }];
    const [slides, asks] = await Promise.all([all(E.slide, byDeck(F.slide.deck)), all(E.ask, byDeck(F.ask.deck))]);
    const askIds = new Set(asks.map(a => a.recordId));
    const variants = askIds.size ? (await all(E.variant)).filter(x => askIds.has(v(x, F.variant.ask))) : [];
    deck.slides = sortSlides(slides.map(record => {
      const slide = slideFrom(record);
      slide.record = record;
      // Typing not yet saved stays on screen over what the file says.
      const pending = deck.pending.get(slide.id);
      if (pending) Object.assign(slide, pending.values);
      return slide;
    }));
    deck.asks = asks.sort((a, b) => String(v(b, F.ask.made)).localeCompare(String(v(a, F.ask.made))));
    deck.variants = variants;
  } else {
    deck.slides = []; deck.asks = []; deck.variants = [];
  }
  if (!deck.slides.some(s => s.id === deck.slideId)) deck.slideId = deck.slides[0]?.id ?? null;
  keepSelection();
  deck.theme = themeFor(currentDeck());
  await resolveMedia();
  await loadFonts(deck.theme);
}

/** The template and brand a deck names, resolved into the theme the engine draws with. */
function themeFor(record) {
  const tpl = deck.templates.find(t => t.recordId === v(record, F.deck.template));
  const brandRecord = deck.brands.find(b => b.recordId === v(record, F.deck.brand));
  return resolveTheme(templateSpec(tpl), brandSpec(brandRecord), {
    footer: v(record, F.deck.footer) ?? '', slideNumbers: v(record, F.deck.numbers) !== false, aspect: v(record, F.deck.aspect) ?? '16:9',
  });
}
export const templateSpec = record => record ? templateSpecFrom(record.values, record.recordId) : TEMPLATES[0];
export const brandSpec = record => record ? brandSpecFrom(record.values) : null;
/** A Design is a Template that names its Brand kit: both came from one Brandkits export. */
const designsOf = () => deck.templates.filter(t => v(t, F.template.brand) && deck.brands.some(b => b.recordId === v(t, F.template.brand)));

/** Every picture address the deck draws, resolved once to a URL the stage can show. */
async function resolveMedia() {
  const addresses = new Set();
  for (const s of deck.slides) for (const key of PICTURES) if (s[key]) addresses.add(s[key]);
  for (const variant of deck.variants) { try { const c = JSON.parse(v(variant, F.variant.changes) ?? '{}'); if (c.image) addresses.add(c.image); } catch { /* shown as text */ } }
  const brand = deck.theme?.brand;
  if (brand?.logo) addresses.add(brand.logo);
  if (brand?.logoDark) addresses.add(brand.logoDark);
  for (const b of deck.brands) for (const f of [F.brand.logo, F.brand.logoDark, F.brand.mark]) if (v(b, f)) addresses.add(v(b, f));
  for (const t of deck.templates) for (const f of Object.values(IMAGE_FIELDS)) if (v(t, f)) addresses.add(v(t, f));
  await Promise.all([...addresses].filter(a => !deck.media.has(a)).map(async address => {
    try { deck.media.set(address, await nendo.media.urlFor(address)); } catch { deck.media.set(address, null); }
  }));
}
const urlFor = address => address ? deck.media.get(address) ?? null : null;

let fontLink = null;
async function loadFonts(theme) {
  const href = theme ? webFonts(theme) : null;
  if (href && fontLink?.href !== href) {
    fontLink?.remove();
    fontLink = Object.assign(document.createElement('link'), { rel: 'stylesheet', href });
    document.head.append(fontLink);
  }
  if (!theme) return;
  const wanted = [theme.fonts.heading, theme.fonts.body].map(f => `16px '${f}'`);
  await Promise.race([Promise.all(wanted.map(f => document.fonts.load(f).catch(() => null))), new Promise(r => setTimeout(r, 1500))]);
  forgetMeasurements();
}
document.fonts?.addEventListener?.('loadingdone', () => { forgetMeasurements(); laidCache.clear(); drawAll(); });

// ---- Drawing -----------------------------------------------------------------------------------

const laidCache = new Map();
// Words are edited in place on the stage (stage-editor.mjs); it is made in wire().
let editor = null;
function laid(slide, theme = deck.theme, editing = true, number = null) {
  const n = number ?? numberOf(slide);
  // The field being edited keeps its box while it is empty.
  const keep = editing ? editor?.keep() ?? null : null;
  const key = JSON.stringify([slide.layout, slide.title, slide.kicker, slide.body, slide.body2, ...PICTURES.map(k => slide[k]), slide.chart, slide.imageAlt, slide.notes, slide.format, slide.build, n, editing, keep, theme]);
  let hit = laidCache.get(key);
  if (!hit) {
    if (laidCache.size > 600) laidCache.clear();
    hit = layoutSlide(slide, theme, { measure: canvasMeasure, number: n, total: deck.slides.length, editing, keep });
    laidCache.set(key, hit);
  }
  return hit;
}
function numberOf(slide) {
  const shown = deck.slides.filter(s => !s.hidden);
  const i = shown.findIndex(s => s.id === slide.id);
  return i < 0 ? null : i + 1;
}
/** A slide drawn at a width, as an element. */
function scaled(slideLaid, width) {
  const box = document.createElement('div');
  box.className = 'thumb';
  const h = width * slideLaid.H / slideLaid.W;
  box.style.width = `${width}px`; box.style.height = `${h}px`;
  box.innerHTML = slideHtml(slideLaid, { urlFor, className: 'scaled' });
  box.firstElementChild.style.transform = `scale(${width / slideLaid.W})`;
  return box;
}

function drawAll() {
  if (!deck.ready) return;
  const d = currentDeck();
  $('start').hidden = !!d && !deck.starting;
  $('app').setAttribute('aria-busy', 'false');
  $('deck-count').textContent = d ? `${deck.slides.length} ${deck.slides.length === 1 ? 'slide' : 'slides'}` : 'No deck yet';
  // Slides a step or a paste moved slide from where they stood.
  const moved = deck.flip;
  deck.flip = null;
  drawSorter({ moved });
  drawGrid({ moved });
  // The layouts first: the stage is sized to the height they leave it.
  drawLayouts(currentSlide());
  drawStage({ ifChanged: true });
  drawInspector();
  drawVariants();
  drawAsk();
  drawHeld();
  drawRehearsed();
  declareToolbar();
}

/** One slide in the list or the sorter: its number, its drawing and what marks it. */
function slideItem(slide, i, width, variants, where) {
  const li = document.createElement('li');
  li.setAttribute('role', 'option');
  li.id = `${where}-${slide.id}`;
  li.dataset.id = slide.id;
  li.setAttribute('aria-selected', String(deck.selected.includes(slide.id)));
  li.classList.toggle('current', slide.id === deck.slideId);
  li.setAttribute('aria-label', `Slide ${i + 1}: ${slide.title || slide.layout}${slide.hidden ? ', hidden' : ''}`);
  li.classList.toggle('hidden-slide', slide.hidden);
  const count = variants.get(slide.id)?.length ?? 0;
  li.classList.toggle('has-variants', count > 0);
  const num = document.createElement('span'); num.className = 'num'; num.textContent = String(i + 1);
  const thumb = scaled(laid(slide, deck.theme, false), width);
  if (count) thumb.dataset.variants = String(count);
  li.append(num, thumb);
  return li;
}

// A list being dragged in keeps what it shows, the lifted slides and the mark, until the drag ends.
const drags = {};
/** Draws the slide list. `moved` slides the slides from where they stood, and marks the ones that moved. */
function drawSorter({ moved = null } = {}) {
  const list = $('slides');
  if (drags.list?.active()) return;
  const width = Math.max(90, list.clientWidth - 34 || 150);
  const variantsBySlide = proposedBySlide();
  const was = moved ? places(list) : null;
  list.replaceChildren(...deck.slides.map((slide, i) => slideItem(slide, i, width, variantsBySlide, 'slide')));
  list.setAttribute('aria-activedescendant', deck.slideId ? `slide-${deck.slideId}` : '');
  if (was) flip(list, was, { moved });
  const picked = deck.selected.length;
  if (picked > 1) $('deck-count').textContent = `${picked} of ${deck.slides.length} slides selected`;
  list.querySelector('li.current')?.scrollIntoView({ block: 'nearest' });
}

/** The slide sorter: every slide of the deck as a card on a grid, to see and rearrange the whole. */
function drawGrid({ moved = null } = {}) {
  const view = $('grid-view');
  view.hidden = !deck.sorter || !currentDeck();
  if (view.hidden) return;
  const list = $('grid');
  if (drags.grid?.active()) return;
  const variantsBySlide = proposedBySlide();
  const was = moved ? places(list) : null;
  list.style.setProperty('--card', `${deck.zoom}px`);
  list.replaceChildren(...deck.slides.map((slide, i) => {
    const li = slideItem(slide, i, deck.zoom, variantsBySlide, 'card');
    const name = document.createElement('span'); name.className = 'name'; name.textContent = slide.title || slide.layout;
    li.append(name);
    return li;
  }));
  list.setAttribute('aria-activedescendant', deck.slideId ? `card-${deck.slideId}` : '');
  if (was) flip(list, was, { moved });
  const picked = deck.selected.length, hidden = deck.slides.filter(s => s.hidden).length;
  $('grid-count').textContent = `${deck.slides.length} ${deck.slides.length === 1 ? 'slide' : 'slides'}${hidden ? `, ${hidden} hidden` : ''}${picked > 1 ? ` · ${picked} selected` : ''}`;
  $('grid-zoom').value = String(deck.zoom);
  list.querySelector('li.current')?.scrollIntoView({ block: 'nearest' });
}
/** Cards across one row of the sorter, for the arrow keys that go up and down. */
function gridColumns() {
  const items = [...$('grid').children];
  if (items.length < 2) return 1;
  const top = items[0].getBoundingClientRect().top;
  const n = items.findIndex(el => Math.abs(el.getBoundingClientRect().top - top) > 4);
  return n < 0 ? items.length : n;
}

let drawn = null;
/** Draws the current slide on the stage. `ifChanged` keeps a stage that already shows the same drawing, so a pointer dragging a selection over it keeps its hold. */
function drawStage({ ifChanged = false } = {}) {
  const stage = $('stage'), wrap = $('stage-wrap');
  // An input method composing in a box owns its words until it ends (stage-editor.mjs).
  if (editor?.composing()) return;
  const slide = currentSlide();
  if (!slide) { drawn = null; stage.replaceChildren(); stage.style.width = '0px'; $('fit-warning').hidden = true; editor?.attach(); return; }
  const l = laid(slide);
  // The row of layouts under the slide takes its height first.
  const strip = $('layout-strip');
  const availW = wrap.clientWidth - 48, availH = wrap.clientHeight - 34 - 12 - strip.offsetHeight;
  const scale = Math.max(0.1, Math.min(availW / l.W, availH / l.H));
  const pictures = l.items.filter(p => p.type === 'image').map(p => urlFor(p.src)).join('\n');
  if (ifChanged && drawn && drawn.l === l && drawn.scale === scale && drawn.pictures === pictures && stage.firstElementChild) return;
  drawn = { l, scale, pictures };
  stage.style.width = `${l.W * scale}px`; stage.style.height = `${l.H * scale}px`;
  strip.style.width = `${Math.max(l.W * scale, Math.min(availW, 480))}px`;
  stage.innerHTML = slideHtml(l, { urlFor, className: 'scaled' });
  stage.firstElementChild.style.transform = `scale(${scale})`;
  deck.stageScale = scale;
  editor?.attach();
  drawStepMarks(stage, slide, l);
  const over = l.items.filter(p => p.type === 'text' && p.overflow && !p.ghost);
  const boxes = over.map(p => p.role === 'body2' ? 'second column' : p.role).filter((x, i, a) => a.indexOf(x) === i).join(' and ');
  $('fit-warning').hidden = over.length === 0;
  $('fit-warning').textContent = over.length ? `The ${boxes} is at its smallest size and still runs over. Shorten it, or split the slide.` : '';
  $('fit-card').classList.toggle('over', over.length > 0);
  $('fit-text').textContent = over.length ? `The ${boxes} runs over` : 'Everything fits';
  $('fit-layout').textContent = layoutOf(slide.layout).label;
}

/** On a slide that builds, a numbered mark beside the first thing each click brings on. */
function drawStepMarks(stage, slide, l) {
  stage.querySelector('.step-marks')?.remove();
  if (slide.build !== 'One by one' || !l.steps) return;
  const marks = document.createElement('div');
  marks.className = 'step-marks'; marks.setAttribute('aria-hidden', 'true');
  const origin = stage.getBoundingClientRect(), seen = new Set();
  for (const el of stage.querySelectorAll('[data-step]')) {
    const k = el.dataset.step;
    if (seen.has(k)) continue;
    seen.add(k);
    const r = el.getBoundingClientRect();
    const mark = document.createElement('span');
    mark.className = 'step-mark'; mark.textContent = k;
    mark.style.left = `${Math.max(22, r.left - origin.left)}px`; mark.style.top = `${Math.max(0, r.top - origin.top)}px`;
    marks.append(mark);
  }
  stage.append(marks);
}

let drawingInspector = false;
function drawInspector() {
  drawingInspector = true;
  try {
    for (const tab of ['slide', 'design', 'asks', 'check']) {
      $(`tab-${tab}`).setAttribute('aria-selected', String(deck.tab === tab));
      $(`pane-${tab}`).hidden = deck.tab !== tab;
    }
    const slide = currentSlide();
    drawLayouts(slide);
    if (deck.tab === 'slide') drawSlidePane(slide);
    if (deck.tab === 'design') drawDesignPane();
    if (deck.tab === 'asks') drawAsksPane();
    drawCheck();
    const notes = $('notes');
    if (document.activeElement !== notes) notes.value = slide?.notes ?? '';
    notes.disabled = !slide;
    countNotes();
  } finally { drawingInspector = false; }
}
function countNotes() {
  const words = $('notes').value.trim().split(/\s+/).filter(Boolean).length;
  const said = spokenSeconds($('notes').value);
  $('notes-count').textContent = words ? `${words} ${words === 1 ? 'word' : 'words'} · ${clock(said)}` : '';
  $('notes-count').title = words ? `About ${clock(said)} to say, at 130 words a minute` : '';
}

/** The Check tab: what would trip the talk, and how long it runs. Its count shows on the tab. */
function drawCheck() {
  const d = currentDeck();
  const result = checkDeck(deck.slides, { laid: s => laid(s, deck.theme, false), minutes: v(d, F.deck.minutes) });
  deck.check = result;
  const needs = result.issues.filter(x => x.level !== 'info').length;
  $('check-count').textContent = needs ? String(needs) : '';
  $('tab-check').setAttribute('aria-label', needs ? `Check, ${needs} to look at` : 'Check');
  if (deck.tab !== 'check') return;
  $('check-length').textContent = lengthLine(result);
  $('check-rehearse').disabled = !result.shown;
  $('check-none').hidden = result.issues.length > 0;
  const order = { error: 0, warn: 1, info: 2 };
  const list = [...result.issues].sort((a, b) => (a.number - b.number) || (order[a.level] - order[b.level]));
  const key = JSON.stringify(list);
  const host = $('check-list');
  if (host.dataset.key === key) return;
  host.dataset.key = key;
  host.replaceChildren(...list.map(issue => {
    const li = document.createElement('li');
    li.className = issue.level;
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.slide = issue.slideId;
    const dot = document.createElement('span'); dot.className = 'dot';
    dot.setAttribute('aria-label', issue.level === 'error' ? 'Must fix' : issue.level === 'warn' ? 'Look at' : 'Note');
    const num = document.createElement('span'); num.className = 'num'; num.textContent = String(issue.number);
    const words = document.createElement('span'); words.textContent = issue.text;
    b.append(dot, num, words);
    li.append(b);
    return li;
  }));
}

const SAMPLE = {
  Title: { title: 'Title', kicker: 'Kicker', body: 'Subtitle' }, Section: { title: 'Section', kicker: '01' }, Statement: { title: 'One idea in one sentence' },
  Bullets: { title: 'Title', body: '- Point\n- Point\n- Point' }, 'Title only': { title: 'Title' }, 'Two columns': { title: 'Title', body: 'Text on the left', body2: 'Text on the right' },
  Comparison: { title: 'Title', body: '### Before\n- Point\n- Point', body2: '### After\n- Point\n- Point' }, 'Image left': { title: 'Title', body: '- Point\n- Point' },
  'Image right': { title: 'Title', body: '- Point\n- Point' }, 'Full image': { title: 'Title on a picture' }, Quote: { body: 'A line worth quoting.', kicker: 'Someone' },
  'Big numbers': { title: 'Title', body: '- 42% | label\n- 3× | label\n- 12 | label' }, Agenda: { title: 'Agenda', body: '- One\n- Two\n- Three\n- Four' },
  Timeline: { title: 'Title', body: '- 2024 | Start\n- 2025 | Grow\n- 2026 | Lead' }, Process: { title: 'Title', body: '- Plan | text\n- Make | text\n- Ship | text' },
  Cycle: { title: 'Title', body: '- Plan | text\n- Do | text\n- Check | text\n- Act | text' }, 'Picture grid': { title: 'Title', body: '- Caption\n- Caption\n- Caption' }, Cards: { title: 'Title', body: '- One | text\n- Two | text\n- Three | text' },
  Table: { title: 'Title', body: '| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |' }, Chart: { title: 'Title', body: '| A | n |\n| --- | --- |\n| a | 3 |\n| b | 5 |\n| c | 4 |\n| d | 7 |' },
  Closing: { title: 'Thank you', kicker: 'Questions' },
};

/** The row of layouts under the stage: each drawn with this slide's own title where it has one. */
function drawLayouts(slide) {
  const gallery = $('layouts');
  const key = JSON.stringify([slide?.id ?? null, slide?.layout ?? null, deck.theme, slide?.title ?? null]);
  if (gallery.dataset.key === key) return;
  gallery.dataset.key = key;
  if (!slide) { gallery.replaceChildren(); return; }
  gallery.replaceChildren(...LAYOUTS.map(layout => {
    const b = document.createElement('button');
    b.type = 'button'; b.setAttribute('role', 'option'); b.dataset.layout = layout.id;
    b.setAttribute('aria-selected', String(layout.id === slide.layout));
    b.title = `${layout.label}: ${layout.hint}`;
    const sample = { ...SAMPLE[layout.id], layout: layout.id, image: null, chart: 'Column' };
    if (slide.title && layout.uses.includes('title')) sample.title = slide.title;
    const label = document.createElement('span'); label.textContent = layout.label;
    b.append(scaled(layoutSlide(sample, deck.theme, { measure: canvasMeasure, number: null, editing: false }), 76), label);
    return b;
  }));
  const chosen = gallery.querySelector('[aria-selected="true"]');
  if (chosen) gallery.scrollLeft = Math.max(0, chosen.offsetLeft - (gallery.clientWidth - chosen.offsetWidth) / 2);
}

function drawSlidePane(slide) {
  const pane = $('pane-slide');
  pane.querySelectorAll('input,textarea,button,select').forEach(el => { el.disabled = !slide; });
  drawDesignCard();
  if (!slide) return;
  const layout = layoutOf(slide.layout);
  $('layout-hint').textContent = layout.hint;
  for (const field of pane.querySelectorAll('.field[data-uses]')) field.hidden = !layout.uses.includes(field.dataset.uses);
  $('l-body').textContent = slide.layout === 'Quote' ? 'Quote' : slide.layout === 'Chart' || slide.layout === 'Table' ? 'Table' : slide.layout === 'Two columns' || slide.layout === 'Comparison' ? 'Left'
    : slide.layout === 'Process' || slide.layout === 'Cycle' ? 'Steps' : slide.layout === 'Picture grid' ? 'Captions' : 'Body';
  $('l-body2').textContent = slide.layout === 'Chart' ? 'Takeaway' : 'Right';
  for (const input of pane.querySelectorAll('[data-field]')) if (document.activeElement !== input) input.value = slide[input.dataset.field] ?? '';
  $('f-hidden').checked = slide.hidden;
  segmented($('f-chart'), CHARTS.map(c => [c, c]), slide.chart, value => typed({ chart: value }));
  const steps = laid(slide, deck.theme, false).steps;
  segmented($('f-build'), [['None', 'All at once'], ['One by one', 'One by one']], slide.build, value => setSlides({ build: value }, value === 'None' ? 'All points at once' : 'Points one by one'));
  $('build-hint').textContent = slide.build !== 'One by one' ? '' : steps ? `${steps} ${steps === 1 ? 'click' : 'clicks'} bring the points on, numbered on the slide.` : `The ${layoutOf(slide.layout).label} layout has nothing to bring on one by one.`;
  const deckTransition = v(currentDeck(), F.deck.transition) ?? 'None';
  segmented($('f-transition'), SLIDE_TRANSITIONS.map(x => [x, x]), slide.transition, value => setSlides({ transition: value }, value === 'Deck' ? 'The deck’s transition' : `${value} transition`));
  $('f-transition').title = `Deck: the deck’s own transition, now ${deckTransition}. Set it on the Design tab.`;
  const planned = deck.check?.seconds?.[deck.slides.filter(s => !s.hidden).findIndex(s => s.id === slide.id)];
  $('slide-time').textContent = slide.hidden ? 'Hidden: Present leaves this slide out.' : slide.seconds ? `Rehearsed: ${clock(slide.seconds)} on this slide.` : planned ? `About ${clock(planned)} on this slide${slide.notes ? ', from the notes' : ''}. Rehearse to time it.` : '';
  const grid = slide.layout === 'Picture grid';
  $('l-image').textContent = grid ? 'Picture 1' : 'Picture';
  PICTURES.forEach((key, i) => {
    const pick = $(i ? `pick-image${i + 1}` : 'pick-image'), clear = $(i ? `clear-image${i + 1}` : 'clear-image');
    clear.hidden = !slide[key];
    pick.textContent = `${slide[key] ? 'Change' : 'Choose'} ${grid && i ? `picture ${i + 1}` : 'picture'}…`;
  });
}

function drawDesignCard() {
  const d = currentDeck(), theme = deck.theme;
  $('design-change').disabled = !d;
  const brand = theme?.brand?.name ?? null;
  const key = JSON.stringify([d?.recordId ?? null, v(d, F.deck.title), theme, deck.media.size]);
  const host = $('design-thumb');
  if (host.dataset.key === key) return;
  host.dataset.key = key;
  if (!d || !theme) { host.replaceChildren(); $('design-name').textContent = ''; $('design-note').textContent = ''; return; }
  host.replaceChildren(scaled(layoutSlide({ layout: 'Title', title: v(d, F.deck.title) || 'Title', kicker: '', body: '', image: null }, theme, { measure: canvasMeasure, number: null, editing: false }), 64));
  $('design-name').textContent = brand ?? theme.name;
  const aspect = v(d, F.deck.aspect) ?? '16:9';
  $('design-note').textContent = brand && brand !== theme.name ? `${theme.name} template · ${aspect}` : brand ? `Design · ${aspect}` : `Template · ${aspect}`;
}

function segmented(host, options, value, onPick) {
  if (host.dataset.value !== String(value) || host.childElementCount !== options.length) {
    host.dataset.value = String(value);
    host.replaceChildren(...options.map(([val, label]) => {
      const b = document.createElement('button');
      b.type = 'button'; b.setAttribute('role', 'radio'); b.textContent = label;
      b.setAttribute('aria-checked', String(val === value));
      b.addEventListener('click', () => onPick(val));
      return b;
    }));
  }
}

function drawDesignPane() {
  const d = currentDeck();
  const pane = $('pane-design');
  pane.querySelectorAll('input,textarea,button').forEach(el => { el.disabled = !d; });
  if (!d) return;
  const sample = currentSlide() ?? { layout: 'Title', title: v(d, F.deck.title) ?? 'Title', kicker: '', body: '' };
  const tplKey = JSON.stringify([sample.id, sample.title, v(d, F.deck.template), v(d, F.deck.brand), v(d, F.deck.aspect), deck.templates.map(t => t.version), deck.brands.map(b => b.version), deck.media.size]);
  const designs = designsOf();
  const designHost = $('designs');
  $('designs-empty').hidden = designs.length > 0;
  if (designHost.dataset.key !== tplKey) {
    designHost.dataset.key = tplKey;
    designHost.replaceChildren(...designs.map(t => {
      const brand = deck.brands.find(b => b.recordId === v(t, F.template.brand));
      const b = document.createElement('button');
      b.type = 'button'; b.setAttribute('role', 'option'); b.dataset.design = t.recordId;
      b.setAttribute('aria-selected', String(v(d, F.deck.template) === t.recordId && v(d, F.deck.brand) === brand.recordId));
      const theme = resolveTheme(templateSpec(t), brandSpec(brand), { aspect: v(d, F.deck.aspect) ?? '16:9' });
      const label = document.createElement('span'); label.textContent = v(t, F.template.name) ?? 'Design';
      b.title = v(t, F.template.description) ?? '';
      b.append(scaled(layoutSlide({ ...sample, layout: 'Title', title: sample.title || v(d, F.deck.title) || 'Title', image: null }, theme, { measure: canvasMeasure, number: 1, editing: false }), 130), label);
      return b;
    }));
  }
  const gallery = $('templates');
  if (gallery.dataset.key !== tplKey) {
    gallery.dataset.key = tplKey;
    gallery.replaceChildren(...templateRecordsOrBuiltIns().map(t => {
      const b = document.createElement('button');
      b.type = 'button'; b.setAttribute('role', 'option'); b.dataset.template = t.recordId ?? '';
      const chosen = (v(d, F.deck.template) ?? null) === (t.recordId ?? null) || (!v(d, F.deck.template) && t.builtIn && t.spec.id === 'keynote');
      b.setAttribute('aria-selected', String(chosen));
      const theme = resolveTheme(t.spec, brandSpec(deck.brands.find(x => x.recordId === v(d, F.deck.brand))), { aspect: v(d, F.deck.aspect) ?? '16:9' });
      const label = document.createElement('span'); label.textContent = t.spec.name;
      b.title = t.description ?? '';
      b.append(scaled(layoutSlide({ ...sample, image: null }, theme, { measure: canvasMeasure, number: 2, editing: false }), 130), label);
      return b;
    }));
  }
  const brands = $('brands');
  brands.replaceChildren(...[null, ...deck.brands].map(record => {
    const b = document.createElement('button');
    b.type = 'button'; b.setAttribute('role', 'option'); b.dataset.brand = record?.recordId ?? '';
    b.setAttribute('aria-selected', String((v(d, F.deck.brand) ?? null) === (record?.recordId ?? null)));
    const name = document.createElement('strong'); name.textContent = record ? v(record, F.brand.name) ?? 'Brand' : 'No brand kit';
    const chips = document.createElement('span'); chips.className = 'chips';
    if (record) for (const role of ['primary', 'secondary', 'accent', 'background', 'ink']) {
      const hex = normalHex(v(record, F.brand[role])); if (!hex) continue;
      const c = document.createElement('span'); c.className = 'chip'; c.style.background = hex; c.title = `${role} ${hex}`; chips.append(c);
    }
    const note = document.createElement('small');
    note.textContent = record ? [v(record, F.brand.headingFont), v(record, F.brand.bodyFont)].filter(Boolean).join(' · ') || v(record, F.brand.source) || '' : 'The template’s own colours and fonts';
    b.append(name, chips, note);
    if (record) { const edit = document.createElement('span'); edit.className = 'edit'; edit.textContent = 'Open'; edit.dataset.open = record.recordId; edit.setAttribute('role', 'link'); b.append(edit); }
    return b;
  }));
  for (const input of pane.querySelectorAll('[data-deck]')) if (document.activeElement !== input) input.value = v(d, F.deck[input.dataset.deck]) ?? '';
  segmented($('d-aspect'), [['16:9', 'Wide 16:9'], ['4:3', 'Standard 4:3']], v(d, F.deck.aspect) ?? '16:9', value => editDeck({ aspect: value }));
  $('d-numbers').checked = v(d, F.deck.numbers) !== false;
  segmented($('d-transition'), TRANSITIONS.map(x => [x, x]), v(d, F.deck.transition) ?? 'None', value => editDeck({ transition: value }));
  if (document.activeElement !== $('d-minutes')) $('d-minutes').value = v(d, F.deck.minutes) ?? '';
}
function templateRecordsOrBuiltIns() {
  // A design's own template shows under Designs, beside its kit, not again among the templates.
  const designs = new Set(designsOf().map(t => t.recordId));
  const plain = deck.templates.filter(r => !designs.has(r.recordId));
  if (plain.length) return plain.map(r => ({ recordId: r.recordId, spec: templateSpec(r), description: v(r, F.template.description) }));
  return TEMPLATES.map(t => ({ recordId: null, builtIn: true, spec: t, description: t.description }));
}

function drawAsksPane() {
  const list = $('asks');
  if (!deck.asks.length) { list.innerHTML = '<li><p>No asks yet. Use the ask bar under the slide.</p></li>'; return; }
  list.replaceChildren(...deck.asks.map(ask => {
    const li = document.createElement('li');
    const meta = document.createElement('div'); meta.className = 'meta';
    const status = document.createElement('span'); status.className = `status ${v(ask, F.ask.status)}`; status.textContent = v(ask, F.ask.status) ?? '';
    const when = document.createElement('span'); when.textContent = `${v(ask, F.ask.scope) ?? ''} · ${String(v(ask, F.ask.made) ?? '').replace('T', ' ').slice(0, 16)}`;
    meta.append(status, when);
    const request = document.createElement('p'); request.textContent = v(ask, F.ask.request) ?? '';
    li.append(meta, request);
    const progress = v(ask, F.ask.progress);
    if (progress) { const p = document.createElement('p'); p.className = 'reply'; p.textContent = lastLine(progress); li.append(p); }
    const reply = v(ask, F.ask.reply);
    if (reply) { const p = document.createElement('p'); p.className = 'reply'; p.textContent = reply; li.append(p); }
    const waiting = deck.variants.filter(x => v(x, F.variant.ask) === ask.recordId && v(x, F.variant.status) === 'Proposed');
    if (waiting.length) {
      const row = document.createElement('div'); row.className = 'picture-row';
      const use = document.createElement('button'); use.type = 'button'; use.className = 'ghost-button agent'; use.textContent = `Use all ${waiting.length}`; use.dataset.useAll = ask.recordId;
      const drop = document.createElement('button'); drop.type = 'button'; drop.className = 'ghost-button'; drop.textContent = 'Dismiss all'; drop.dataset.dismissAll = ask.recordId;
      row.append(use, drop); li.append(row);
    }
    return li;
  }));
}
const lastLine = text => String(text ?? '').trim().split('\n').filter(Boolean).at(-1) ?? '';

function proposedBySlide() {
  const map = new Map();
  for (const x of deck.variants) {
    if (v(x, F.variant.status) !== 'Proposed') continue;
    const id = v(x, F.variant.slide);
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(x);
  }
  return map;
}

function drawVariants() {
  const host = $('variants');
  const slide = currentSlide();
  const list = slide ? proposedBySlide().get(slide.id) ?? [] : [];
  host.hidden = list.length === 0;
  if (!list.length) { host.replaceChildren(); return; }
  const head = document.createElement('div'); head.className = 'v-head';
  const t = document.createElement('strong'); t.textContent = `${list.length} ${list.length === 1 ? 'variant' : 'variants'} from your agent`;
  const s = document.createElement('span'); s.textContent = 'Use one to replace this slide’s fields. Undo puts them back.';
  head.append(t, s);
  host.replaceChildren(head, ...list.map(variant => {
    let changes = {};
    try { changes = JSON.parse(v(variant, F.variant.changes) ?? '{}'); } catch { changes = {}; }
    const preview = { ...slide, ...pick(changes) };
    const card = document.createElement('div'); card.className = 'variant'; card.dataset.variant = variant.recordId;
    const label = document.createElement('span'); label.className = 'label'; label.textContent = v(variant, F.variant.label) ?? 'Variant';
    const why = document.createElement('span'); why.className = 'why'; why.textContent = v(variant, F.variant.rationale) ?? describeChanges(slide, changes);
    const row = document.createElement('div'); row.className = 'row';
    const use = document.createElement('button'); use.type = 'button'; use.className = 'ghost-button agent'; use.textContent = 'Use this'; use.dataset.use = variant.recordId;
    const drop = document.createElement('button'); drop.type = 'button'; drop.className = 'ghost-button'; drop.textContent = 'Dismiss'; drop.dataset.dismiss = variant.recordId;
    row.append(use, drop);
    card.append(scaled(laid(preview, deck.theme, false), 198), label, why, row);
    card.title = describeChanges(slide, changes);
    return card;
  }));
}
const EDITABLE = ['layout', 'title', 'kicker', 'body', 'body2', 'notes', 'chart', 'image', 'image2', 'image3', 'image4', 'imageAlt', 'hidden', 'format', 'build', 'transition', 'seconds'];
// A variant writes words and how they come on, never a picture, a size, a transition or a time: those are the person's.
const VARIANT_FIELDS = EDITABLE.filter(k => !PICTURES.includes(k) && !['format', 'transition', 'seconds'].includes(k));
/** The slide fields a variant changes, by the slide model's names; anything else is dropped. */
export function pick(changes) {
  const out = {};
  for (const [k, value] of Object.entries(changes ?? {})) {
    const key = k.startsWith('dk.slide.') ? k.slice(9) : k;
    if (!VARIANT_FIELDS.includes(key)) continue;
    if (key === 'layout' && !LAYOUT_IDS.includes(value)) continue;
    if (key === 'chart' && !CHARTS.includes(value)) continue;
    if (key === 'build' && !BUILDS.includes(value)) continue;
    out[key] = key === 'hidden' ? value === true : value === null ? '' : String(value);
  }
  return out;
}
function describeChanges(slide, changes) {
  const c = pick(changes);
  return Object.keys(c).map(k => k === 'layout' ? `layout ${slide.layout} → ${c.layout}` : `${k} changed`).join(', ') || 'No change';
}

function drawAsk() {
  const form = $('ask');
  form.hidden = !deck.canAsk || !currentDeck();
  for (const b of form.querySelectorAll('[data-scope]')) b.setAttribute('aria-checked', String(deck.scope === b.dataset.scope && !$('mission').value));
  $('mission').classList.toggle('chosen', !!$('mission').value);
  const working = deck.asks.find(a => ['Waiting', 'Working'].includes(v(a, F.ask.status)));
  const status = $('ask-status');
  status.classList.toggle('working', !!working || deck.asking === true);
  $('ask-stop').hidden = !deck.asking;
  if (working) status.textContent = `${v(working, F.ask.status) === 'Waiting' ? 'Waiting for your agent' : 'Your agent is working'}: ${v(working, F.ask.request)}${v(working, F.ask.progress) ? ` — ${lastLine(v(working, F.ask.progress))}` : ''}`;
  else if (deck.lastReply) status.textContent = deck.lastReply;
  else status.textContent = '';
}

// ---- Writing -----------------------------------------------------------------------------------

const SLIDE_FIELD = { layout: F.slide.layout, title: F.slide.title, kicker: F.slide.kicker, body: F.slide.body, body2: F.slide.body2, notes: F.slide.notes,
  chart: F.slide.chart, image: F.slide.image, image2: F.slide.image2, image3: F.slide.image3, image4: F.slide.image4, imageAlt: F.slide.imageAlt,
  hidden: F.slide.hidden, order: F.slide.order, format: F.slide.format,
  build: F.slide.build, transition: F.slide.transition, seconds: F.slide.seconds };
const toValues = changes => Object.fromEntries(Object.entries(changes).map(([k, val]) => [SLIDE_FIELD[k], val === '' ? null : val]));

/** Typing changes the slide on screen at once and is saved after a pause. */
function edit(changes, { now = false } = {}) {
  const slide = currentSlide();
  if (!slide || nendo.context?.readOnly) return;
  Object.assign(slide, changes);
  const pending = deck.pending.get(slide.id) ?? { values: {}, version: slide.record.version };
  Object.assign(pending.values, changes);
  deck.pending.set(slide.id, pending);
  keepDrafts();
  redrawSoon();
  if (now) save.flush(); else save();
}
/** Typing in the inspector is a new change: it ends what Ctrl Y could put back. */
function typed(changes, options) {
  deck.steps.redo = [];
  editor?.forgetRedo();
  edit(changes, options);
}
const redrawSoon = debounce(() => { drawStage({ ifChanged: true }); drawSorter(); drawGrid(); declareToolbar(); if (deck.tab !== 'slide' || !document.activeElement?.dataset?.field) drawInspector(); else drawSlidePaneQuiet(); }, 60);
function drawSlidePaneQuiet() { const s = currentSlide(); if (s) { $('layout-hint').textContent = layoutOf(s.layout).hint; } }

const conflict = error => !!error?.code && /version|conflict|stale/i.test(`${error.code} ${error.message}`);

/** Saves the slide typing and the deck typing, for whatever reads the deck next. */
const flushAll = () => Promise.all([save.flush(), saveDeckTyping.flush()]);

let saving = null;
/** A save asked for while one is out waits for it and then saves what is left, so awaiting a flush waits for the write. */
const save = debounce(() => {
  if (saving) return saving.then(() => deck.pending.size ? save.flush() : undefined);
  saving = savePending().finally(() => { saving = null; keepDrafts(); });
  return saving;
}, 650);
async function savePending() {
  // A write that meets a newer version reads the record again and goes once more, in this same save.
  for (let pass = 0; pass < 3 && deck.pending.size; pass++) {
    let again = false;
    for (const [id, pending] of [...deck.pending]) {
      const slide = deck.slides.find(s => s.id === id);
      const values = { ...pending.values };
      const written = toValues(values);
      try {
        const version = slide?.record.version ?? (await nendo.records.get(E.slide, id))?.version;
        if (version === undefined) { deck.pending.delete(id); continue; }
        const record = await nendo.records.update({ entityId: E.slide, recordId: id, version }, written);
        if (slide) { slide.record = record; slide.version = record.version; }
        pending.version = record.version;
        deck.held = withoutWritten(deck.held, E.slide, id, written);
        // Typing that arrived while the write was out stays pending.
        for (const [k, val] of Object.entries(values)) if (pending.values[k] === val) delete pending.values[k];
        if (!Object.keys(pending.values).length) deck.pending.delete(id);
      } catch (error) {
        // null is a slide deleted since; a read that fails says nothing, so the typing stays.
        const fresh = await nendo.records.get(E.slide, id).catch(() => undefined);
        if (fresh === null) { deck.pending.delete(id); problem(error, 'The slide could not be saved; it was deleted'); continue; }
        if (fresh && slide) slide.record = fresh;
        if (fresh && !Object.keys(differing(written, fresh)).length) {
          // The record holds what this write carried; typing made since stays and goes once more.
          for (const [k, val] of Object.entries(values)) if (pending.values[k] === val) delete pending.values[k];
          if (!Object.keys(pending.values).length) deck.pending.delete(id); else { pending.version = fresh.version; again = true; }
          continue;
        }
        if (fresh && conflict(error)) { pending.version = fresh.version; again = true; continue; }
        // Anything else keeps the typing, on screen and on the device; the next save tries again.
        problem(error, 'The slide could not be saved; your typing is kept and goes with the next save');
      }
    }
    if (!again) break;
  }
}

// ---- Drafts, on this device --------------------------------------------------------------------
// Nendo ends a view's frame without asking (ADR-0013). Typing still waiting for its save is kept in
// the package's own storage with the version it was typed over (drafts.mjs), and restored over that
// version when the view starts again. What meets a newer version is held for the person to put
// back or discard; it is never saved over somebody else's change on its own.

const draftKey = () => `deck.drafts.v2.${nendo.context?.viewId ?? 'deck'}`;
// Until the start has read the stored drafts (restoreDrafts), nothing replaces them: a frame that ends
// or fails to load before then leaves them for the next start.
let draftsRead = false;
const deckValues = changes => Object.fromEntries(Object.entries(changes).map(([k, val]) => [F.deck[k], val === '' ? null : val]));
function draftEntries() {
  const entries = [...deck.pending].filter(([, p]) => Object.keys(p.values).length)
    .map(([id, p]) => ({ entityId: E.slide, recordId: id, version: p.version, values: toValues(p.values) }));
  // Deck typing on its way to the file stays kept until it lands: a frame may end before the answer.
  for (const typed of [deckSaving, ...deckQueued, deckTyping]) if (typed) entries.push({ entityId: E.deck, recordId: typed.id, version: typed.version, values: deckValues(typed.changes) });
  // Held first, so the newer typing on the same record wins when both come back.
  return [...deck.held, ...entries];
}
function keepDrafts() {
  if (!draftsRead || nendo.context?.readOnly) return;
  try {
    const text = writeDrafts(draftEntries());
    if (text) localStorage.setItem(draftKey(), text); else localStorage.removeItem(draftKey());
  } catch { /* storage off: the next save is all there is */ }
}
/** Puts back what was typed and not saved before the view last stopped. Answers how many records it saved. */
async function restoreDrafts() {
  if (nendo.context?.readOnly) return 0;
  let entries = [];
  try { entries = readDrafts(localStorage.getItem(draftKey())); } catch { draftsRead = true; return 0; }
  if (!entries.length) { draftsRead = true; return 0; }
  const now = new Map(), unread = [];
  for (const entry of entries) {
    const key = `${entry.entityId}\n${entry.recordId}`;
    if (!now.has(key)) now.set(key, await nendo.records.get(entry.entityId, entry.recordId).catch(() => undefined));
    if (now.get(key) === undefined) unread.push(entry);
  }
  const { fresh, stale } = sortDrafts(entries.filter(e => !unread.includes(e)), (entityId, recordId) => now.get(`${entityId}\n${recordId}`));
  let restored = 0;
  for (const entry of fresh) {
    try { await nendo.records.update({ entityId: entry.entityId, recordId: entry.recordId, version: entry.version }, entry.values); restored++; }
    catch { stale.push(entry); }
  }
  deck.held = [...unread, ...stale];
  draftsRead = true;
  keepDrafts();
  if (restored) toast(`Saved typing on ${restored} ${restored === 1 ? 'slide' : 'slides'} kept from before Deck last closed.`);
  return restored;
}
function drawHeld() {
  const n = deck.held.length;
  $('held').hidden = n === 0;
  if (!n) return;
  const nameOf = e => e.values[F.slide.title] ?? e.values[F.deck.title] ?? deck.slides.find(s => s.id === e.recordId)?.title ?? v(deck.decks.find(d => d.recordId === e.recordId), F.deck.title);
  const names = [...new Set(deck.held.map(nameOf).filter(Boolean))].slice(0, 3).map(t => `“${t.length > 40 ? `${t.slice(0, 39)}…` : t}”`).join(', ');
  $('held-text').textContent = `Typing from before Deck last closed was not saved, and ${n === 1 ? 'what it was typed over has' : `the ${n} places it was typed over have`} changed since${names ? `: ${names}` : ''}. Put yours back over the change, or discard yours.`;
}
async function putHeldBack() {
  const left = [];
  for (const entry of deck.held) {
    const record = await nendo.records.get(entry.entityId, entry.recordId).catch(() => undefined);
    if (record === null) continue;
    if (record === undefined) { left.push(entry); continue; }
    try { await nendo.records.update({ entityId: entry.entityId, recordId: entry.recordId, version: record.version }, entry.values); }
    catch (error) { left.push(entry); problem(error, 'Your typing could not be put back'); }
  }
  deck.held = left;
  keepDrafts();
  await refresh();
}
function discardHeld() { deck.held = []; keepDrafts(); drawHeld(); }

/** Writes the deck's own fields; true when they landed. A newer version is read and written over once. */
async function editDeck(changes, id = deck.deckId) {
  const d = deck.decks.find(x => x.recordId === id);
  if (!d) return false;
  const values = deckValues(changes);
  const targetVersions = {};
  if (changes.template) targetVersions[F.deck.template] = deck.templates.find(t => t.recordId === changes.template)?.version;
  if (changes.brand) targetVersions[F.deck.brand] = deck.brands.find(b => b.recordId === changes.brand)?.version;
  const write = () => nendo.records.update({ entityId: E.deck, recordId: d.recordId, version: d.version }, values, Object.keys(targetVersions).length ? { targetVersions } : undefined);
  try {
    let record;
    try { record = await write(); }
    catch (error) {
      const fresh = conflict(error) ? await nendo.records.get(E.deck, id).catch(() => null) : null;
      if (!fresh) throw error;
      Object.assign(d, fresh);
      record = await write();
    }
    Object.assign(d, record);
    deck.held = withoutWritten(deck.held, E.deck, id, values);
    if (id === deck.deckId) {
      deck.theme = themeFor(d);
      await resolveMedia(); await loadFonts(deck.theme);
      laidCache.clear(); drawAll();
    }
    return true;
  } catch (error) { problem(error, 'The deck could not be changed'); return false; }
}
// Typing in the deck's own fields gathers under the deck it was typed in: a second field in the
// pause never drops the first, and a deck opened before the pause never takes the other's words.
// One deck write is out at a time; typing made meanwhile waits for it, and a flush waits for all.
// Typing for a deck left while a write was out waits in deckQueued, apart from the next deck's.
let deckTyping = null, deckSaving = null, deckWriting = null;
const deckQueued = [];
const saveDeckTyping = debounce(() => {
  if (deckWriting) return deckWriting.then(() => deckTyping || deckQueued.length ? saveDeckTyping.flush() : undefined);
  if (!deckTyping && !deckQueued.length) return Promise.resolve();
  deckWriting = writeDeckTyping().finally(() => { deckWriting = null; });
  // The queue only shrinks, so this ends; a refused write goes back to deckTyping and waits for more typing.
  return deckWriting.then(() => deckQueued.length ? saveDeckTyping.flush() : undefined);
}, 700);
async function writeDeckTyping() {
  const typed = deckQueued.length ? deckQueued.shift() : deckTyping;
  if (typed === deckTyping) deckTyping = null;
  deckSaving = typed;
  const landed = await editDeck(typed.changes, typed.id);
  deckSaving = null;
  if (!landed) {
    // Refused: the typing stays, under newer typing on the same deck, or held for another deck's.
    const queued = deckQueued.find(q => q.id === typed.id);
    if (queued) queued.changes = { ...typed.changes, ...queued.changes };
    else if (!deckTyping || deckTyping.id === typed.id) deckTyping = { ...typed, changes: { ...typed.changes, ...(deckTyping?.changes ?? {}) } };
    else deck.held.push({ entityId: E.deck, recordId: typed.id, version: typed.version, values: deckValues(typed.changes) });
  }
  keepDrafts();
}
function typeDeck(changes) {
  const d = currentDeck();
  if (!d || nendo.context?.readOnly) return;
  // Typing for another deck never merges into this one's: it waits for its own write.
  if (deckTyping && deckTyping.id !== d.recordId) { deckQueued.push(deckTyping); deckTyping = null; saveDeckTyping.flush(); }
  deckTyping = { id: d.recordId, version: deckTyping?.version ?? d.version, changes: { ...(deckTyping?.changes ?? {}), ...changes } };
  keepDrafts();
  saveDeckTyping();
}

// ---- Steps: what Ctrl Z takes back -------------------------------------------------------------
// Adding, duplicating, pasting, moving, hiding, a layout and deleting each land as one batch, which
// Nendo offers to undo in its notice and Ctrl Z takes back here (ADR-0023). The stage's typing has
// its own steps (stage-editor.mjs); Ctrl Z takes whichever came last. Nendo refuses to take back a
// batch whose slides changed since, such as a moved slide typed in afterwards, so each step also
// keeps its slides' fields before and after: a refused step is put back by hand, as a new batch.

const STEPS_KEPT = 100;
// records.batch takes at most this many writes.
const BATCH_MOST = 200;
let stepping = Promise.resolve();
const ofSelection = () => ({ ids: selectedSlides().map(s => s.id), current: deck.slideId });

/** Writes one step. `records` hold each slide's fields before and after it, null where there is none. */
async function writeStep(label, writes, records, selection) {
  // The deck the step changed, though another deck may be open by the time the batch lands.
  const deckId = deck.deckId;
  const answer = await nendo.records.batch(writes, { label: label.slice(0, 80), offerUndo: true });
  deck.steps.redo = [];
  editor?.forgetRedo();
  if (answer?.revision && nendo.has('records.undo')) {
    deck.steps.undo.push({ label, deckId, next: { method: 'undo', revision: answer.revision }, records, selection, at: Date.now() });
    if (deck.steps.undo.length > STEPS_KEPT) deck.steps.undo.shift();
  }
  declareToolbar();
  return answer;
}

/** The last step Ctrl Z (back) or Ctrl Y would take in the open deck: a step in another deck waits for it. */
const topStep = back => (back ? deck.steps.undo : deck.steps.redo).findLast(step => step.deckId === deck.deckId) ?? null;

/** Ctrl Z (back) or Ctrl Y: the stage's last change of words or the last step, whichever is later. True when there was one. */
function undoAny(back) {
  const top = topStep(back);
  const words = editor?.peek(back) ?? null;
  if (words !== null && (!top || words >= top.at)) { const done = editor.undo(back); declareToolbar(); return done; }
  if (!top) return false;
  takeStep(back);
  return true;
}
const undoLabel = back => {
  const top = topStep(back);
  const words = editor?.peek(back) ?? null;
  if (words !== null && (!top || words >= top.at)) return 'typing';
  return top?.label ?? null;
};

function takeStep(back) {
  const from = back ? deck.steps.undo : deck.steps.redo;
  const step = topStep(back);
  if (!step) return stepping;
  from.splice(from.indexOf(step), 1);
  declareToolbar();
  stepping = stepping.then(async () => {
    const name = `${back ? 'Undo' : 'Redo'} ${step.label}`;
    try {
      await flushAll();
      try {
        const answer = await nendo.records[step.next.method](step.next.revision);
        step.next = { method: step.next.method === 'undo' ? 'redo' : 'undo', revision: answer.revision };
      } catch {
        const answer = await byHand(step, back ? 'before' : 'after', name);
        if (answer?.revision) step.next = { method: 'undo', revision: answer.revision };
      }
      step.at = Date.now();
      (back ? deck.steps.redo : deck.steps.undo).push(step);
      const sel = step.selection?.[back ? 'before' : 'after'];
      if (sel) { deck.selected = [...sel.ids]; deck.slideId = sel.current ?? deck.slideId; deck.anchor = deck.slideId; }
      deck.flip = sel?.ids ?? [];
      announce(`${name}.`);
      await refresh();
    } catch (error) {
      from.push(step);
      problem(error, `${name} did not work`);
    }
    declareToolbar();
  });
  return stepping;
}

// The references a step's records carry, and the record type each points at.
const REFERS = { [F.slide.deck]: E.deck, [F.variant.ask]: E.ask, [F.variant.slide]: E.slide };

/**
 * A step put back by writing: fields as they were, a made record deleted, a deleted one made again
 * under a new ID. Records are kept in the order they are made in (slides before their variants), so
 * deletes go in the reverse order: a variant before the slide it points at.
 */
async function byHand(step, which, label) {
  const writes = [], gone = [], made = new Map();
  for (const rec of step.records) {
    const want = rec[which], other = rec[which === 'before' ? 'after' : 'before'];
    const now = await nendo.records.get(rec.entityId, rec.id);
    if (want === null) { if (now) gone.push({ op: 'delete', entityId: rec.entityId, recordId: rec.id, version: now.version }); continue; }
    if (other !== null) {
      if (!now) continue;
      const values = Object.fromEntries(Object.entries(want).filter(([f, x]) => (now.values?.[f] ?? null) !== (x ?? null)));
      if (Object.keys(values).length) writes.push({ op: 'update', entityId: rec.entityId, recordId: rec.id, version: now.version, values });
      continue;
    }
    if (now) continue;
    // A deleted record's ID stays the file's, so it comes back under a new one. Each record it points
    // at is named at the version it has now, or at its first when it comes back in this batch too; a
    // record whose target is gone stays gone.
    const values = { ...want }, targetVersions = {};
    let lost = false;
    for (const [field, entityId] of Object.entries(REFERS)) {
      const target = values[field];
      if (!target) continue;
      if (made.has(target)) { values[field] = made.get(target); targetVersions[field] = 1; continue; }
      const found = await nendo.records.get(entityId, target).catch(() => null);
      if (!found) { lost = true; break; }
      targetVersions[field] = found.version;
    }
    if (lost) continue;
    const id = newId(rec.entityId === E.slide ? 'slide' : 'variant');
    made.set(rec.id, id);
    writes.push({ op: 'create', entityId: rec.entityId, recordId: id, values, ...(Object.keys(targetVersions).length ? { targetVersions } : {}) });
  }
  writes.unshift(...gone.reverse());
  if (!writes.length) return null;
  const answer = await nendo.records.batch(writes, { label: label.slice(0, 80) });
  for (const [from, to] of made) renamed(from, to, step);
  return answer;
}

/**
 * A record that came back under a new ID: every kept step, this one among them, and the stage's
 * typing steps name it by the new one, so taking back what was done to it earlier still finds it.
 */
function renamed(from, to, step) {
  for (const s of new Set([step, ...deck.steps.undo, ...deck.steps.redo])) {
    for (const rec of s.records) {
      if (rec.id === from) rec.id = to;
      for (const side of [rec.before, rec.after]) for (const field of Object.keys(REFERS)) if (side?.[field] === from) side[field] = to;
    }
    for (const sel of [s.selection?.before, s.selection?.after]) if (sel) { sel.ids = sel.ids.map(id => id === from ? to : id); if (sel.current === from) sel.current = to; }
  }
  editor?.renamed(from, to);
}

/** Said to a screen reader, and nowhere else. */
function announce(text) {
  const el = $('announce');
  el.textContent = '';
  requestAnimationFrame(() => { el.textContent = text; });
}
const slidesWord = n => n === 1 ? 'a slide' : `${n} slides`;

// ---- Slides made, moved, hidden and deleted ----------------------------------------------------

/**
 * Makes slides from `list` (each the slide fields by their model names) to stand at `at` in the
 * deck, as one step, and picks them. Slides around them are numbered again only when there is no
 * room. A picture another file holds is left out when this file refuses it. Answers the new IDs.
 */
async function insertSlides(list, label, at) {
  await flushAll();
  const d = currentDeck();
  if (!d || !list.length || nendo.context?.readOnly) return [];
  const fresh = list.map(values => ({ id: newId('slide'), values }));
  const orders = ordersFor([...deck.slides.slice(0, at), ...fresh.map(f => ({ id: f.id, order: null })), ...deck.slides.slice(at)].map(s => ({ id: s.id, order: s.order ?? null })));
  const write = withPictures => {
    const writes = [], records = [];
    for (const s of deck.slides) {
      if (!orders.has(s.id)) continue;
      writes.push({ op: 'update', entityId: E.slide, recordId: s.id, version: s.record.version, values: { [F.slide.order]: orders.get(s.id) } });
      records.push({ entityId: E.slide, id: s.id, before: { [F.slide.order]: s.order }, after: { [F.slide.order]: orders.get(s.id) } });
    }
    for (const f of fresh) {
      const values = { [F.slide.deck]: d.recordId, [F.slide.order]: orders.get(f.id), [F.slide.hidden]: false, ...toValues(f.values) };
      if (!withPictures) for (const key of PICTURES) values[F.slide[key]] = null;
      writes.push({ op: 'create', entityId: E.slide, recordId: f.id, values, targetVersions: { [F.slide.deck]: d.version } });
      records.push({ entityId: E.slide, id: f.id, before: null, after: values });
    }
    if (writes.length > BATCH_MOST) throw Object.assign(Error(`It would change ${writes.length} slides at once, and one change holds at most ${BATCH_MOST}. Put fewer slides, or put them at the end.`), { code: 'too_many' });
    return writeStep(label, writes, records, { before: ofSelection(), after: { ids: fresh.map(f => f.id), current: fresh[0].id } });
  };
  try {
    try { await write(true); }
    catch (error) {
      // A picture copied from another file is not this file's to point at.
      if (!fresh.some(f => PICTURES.some(key => f.values[key])) || !/media/i.test(`${error?.code} ${error?.message}`)) throw error;
      await write(false);
      toast('The pictures stayed behind: they belong to another file. Put them in again on these slides.');
    }
  } catch (error) { problem(error, `${label} did not work`); return []; }
  if (deck.deckId !== d.recordId) { await refresh(); return fresh.map(f => f.id); }
  deck.selected = fresh.map(f => f.id); deck.slideId = fresh[0].id; deck.anchor = deck.slideId;
  deck.flip = deck.selected;
  await refresh();
  announce(`${label}: ${fresh.length === 1 ? `slide ${deck.slides.findIndex(s => s.id === fresh[0].id) + 1}` : `slides ${at + 1} to ${at + fresh.length}`}.`);
  return fresh.map(f => f.id);
}

/** A new slide after the current one. */
async function addSlide(layout = 'Bullets', values = {}) {
  const at = deck.slides.findIndex(s => s.id === deck.slideId) + 1 || deck.slides.length;
  const made = await insertSlides([{ layout, ...values }], `Add a ${layoutOf(layout).label} slide`, at);
  if (!made.length) return;
  deck.tab = 'slide'; drawInspector();
  if (!deck.sorter) $('f-title').focus();
}

/** The picked slides' fields, as a copy, a duplicate or a paste carries them. */
const copyOf = s => Object.fromEntries(EDITABLE.map(k => [k, s[k] ?? (k === 'hidden' ? false : '')]));
const afterPicked = () => { const picked = selectedSlides(); return picked.length ? deck.slides.indexOf(picked.at(-1)) + 1 : deck.slides.length; };

/** The picked slides again, right after the last of them, picked in their place. */
async function duplicateSlides() {
  const picked = selectedSlides();
  if (!picked.length) return;
  await insertSlides(picked.map(s => ({ ...copyOf(s), hidden: false })), `Duplicate ${slidesWord(picked.length)}`, afterPicked());
}

/**
 * Deletes the picked slides and their variants, as one step; the slide after them is current. A cut
 * names the slides it copied, so a pick changed while it waits never deletes slides it did not copy.
 */
async function deleteSlides(verb = 'Delete', ids = null) {
  await flushAll();
  const doomed = ids ? deck.slides.filter(s => ids.includes(s.id)) : selectedSlides();
  if (!doomed.length || nendo.context?.readOnly) return;
  const gone = new Set(doomed.map(s => s.id));
  const variants = deck.variants.filter(x => gone.has(v(x, F.variant.slide)));
  const writes = variants.map(x => ({ op: 'delete', entityId: E.variant, recordId: x.recordId, version: x.version }));
  for (const s of doomed) writes.push({ op: 'delete', entityId: E.slide, recordId: s.id, version: s.record.version });
  // The slides and then their variants, as a by-hand undo makes them again.
  const kept = record => Object.fromEntries(Object.entries(record.values ?? {}).filter(([, x]) => x !== null && x !== undefined));
  const records = [...doomed.map(s => ({ entityId: E.slide, id: s.id, before: kept(s.record), after: null })),
    ...variants.map(x => ({ entityId: E.variant, id: x.recordId, before: kept(x), after: null }))];
  const first = deck.slides.indexOf(doomed[0]);
  const label = doomed.length === 1 && verb === 'Delete' ? `Delete slide ${first + 1}` : `${verb} ${slidesWord(doomed.length)}`;
  const next = deck.slides.slice(first).find(s => !gone.has(s.id)) ?? deck.slides.slice(0, first).reverse().find(s => !gone.has(s.id)) ?? null;
  const from = deck.deckId;
  try {
    await writeStep(label, writes, records, { before: ofSelection(), after: { ids: next ? [next.id] : [], current: next?.id ?? null } });
    // Only a slide that is gone lets go of its typing; a refused delete keeps it.
    for (const id of gone) deck.pending.delete(id);
    keepDrafts();
    if (deck.deckId === from) { deck.slideId = next?.id ?? null; deck.selected = next ? [next.id] : []; deck.anchor = deck.slideId; }
    deck.flip = [];
    await refresh();
    announce(`${label}.`);
  } catch (error) { problem(error, doomed.length === 1 ? 'The slide could not be deleted' : 'The slides could not be deleted'); }
}

/**
 * Puts the deck's slides in the order of `ids`, as one step. The list shows the new order at once
 * and the file follows; only the slides whose order must change are written.
 */
async function arrange(ids, moved) {
  if (nendo.context?.readOnly) return false;
  await flushAll();
  const was = deck.slides.map(s => s.id);
  if (ids.length !== was.length || ids.every((id, i) => id === was[i])) return false;
  const byId = new Map(deck.slides.map(s => [s.id, s]));
  const orders = ordersFor(ids.map(id => ({ id, order: byId.get(id).order })));
  const writes = [], records = [];
  for (const [id, order] of orders) {
    const s = byId.get(id);
    writes.push({ op: 'update', entityId: E.slide, recordId: id, version: s.record.version, values: { [F.slide.order]: order } });
    records.push({ entityId: E.slide, id, before: { [F.slide.order]: s.order }, after: { [F.slide.order]: order } });
  }
  const label = moved.length === 1 ? 'Move a slide' : `Move ${moved.length} slides`;
  const selection = { before: ofSelection(), after: ofSelection() };
  for (const [id, order] of orders) byId.get(id).order = order;
  deck.slides = ids.map(id => byId.get(id));
  drawSorter({ moved }); drawGrid({ moved }); drawStage({ ifChanged: true });
  try {
    await writeStep(label, writes, records, selection);
    const spots = moved.map(id => ids.indexOf(id) + 1).sort((a, b) => a - b);
    announce(moved.length === 1 ? `Moved to slide ${spots[0]} of ${ids.length}.` : `${moved.length} slides moved to ${spots.join(', ')}.`);
  } catch (error) { problem(error, moved.length === 1 ? 'The slide could not be moved' : 'The slides could not be moved'); }
  // Drawn again from where the slides are on their way, so the slide into place goes on.
  deck.flip = moved;
  await refresh();
  return true;
}

/** Moves the picked slides: one up or down each, to the start or the end, or by a row of the sorter. */
function moveSelection(how) {
  const ids = deck.slides.map(s => s.id), picked = selectedSlides().map(s => s.id);
  if (!picked.length) return;
  let next;
  if (how === 'up' || how === 'down') next = nudge(ids, picked, how === 'up' ? -1 : 1);
  else if (how === 'start') next = moveBlock(ids, picked, ids[0]);
  else if (how === 'end') next = moveBlock(ids, picked, null);
  else {
    const rest = ids.filter(id => !picked.includes(id));
    const to = Math.max(0, Math.min(rest.length, ids.indexOf(picked[0]) + how));
    next = moveBlock(ids, picked, rest[to] ?? null);
  }
  return arrange(next, picked);
}

/** Hides the picked slides when presenting, or shows them again, as one step. */
async function setHidden(hidden) {
  if (nendo.context?.readOnly) return;
  await flushAll();
  const picked = selectedSlides().filter(s => s.hidden !== hidden);
  if (!picked.length) { drawInspector(); return; }
  const writes = picked.map(s => ({ op: 'update', entityId: E.slide, recordId: s.id, version: s.record.version, values: { [F.slide.hidden]: hidden } }));
  const records = picked.map(s => ({ entityId: E.slide, id: s.id, before: { [F.slide.hidden]: s.hidden }, after: { [F.slide.hidden]: hidden } }));
  try {
    await writeStep(`${hidden ? 'Hide' : 'Show'} ${slidesWord(picked.length)}`, writes, records, { before: ofSelection(), after: ofSelection() });
    await refresh();
  } catch (error) { problem(error, 'The slide could not be hidden'); await refresh(); }
}

/** Sets fields on every picked slide, such as how its points come on or its transition, as one step. */
async function setSlides(changes, label) {
  if (nendo.context?.readOnly) return;
  await flushAll();
  const keys = Object.keys(changes);
  const picked = selectedSlides().filter(s => keys.some(k => s[k] !== changes[k]));
  if (!picked.length) { drawInspector(); return; }
  const values = toValues(changes);
  const writes = picked.map(s => ({ op: 'update', entityId: E.slide, recordId: s.id, version: s.record.version, values }));
  const records = picked.map(s => ({ entityId: E.slide, id: s.id, before: toValues(Object.fromEntries(keys.map(k => [k, s[k] ?? '']))), after: values }));
  for (const s of picked) Object.assign(s, changes);
  laidCache.clear(); drawStage(); drawSorter(); drawGrid(); drawInspector();
  try { await writeStep(picked.length === 1 ? label : `${label} on ${picked.length} slides`, writes, records, { before: ofSelection(), after: ofSelection() }); }
  catch (error) { problem(error, 'The slide could not be changed'); }
  await refresh();
}

/** A layout for the picked slides, as one step. */
async function setLayout(layout) {
  if (nendo.context?.readOnly) return;
  await flushAll();
  const picked = selectedSlides().filter(s => s.layout !== layout);
  if (!picked.length) return;
  const writes = picked.map(s => ({ op: 'update', entityId: E.slide, recordId: s.id, version: s.record.version, values: { [F.slide.layout]: layout } }));
  const records = picked.map(s => ({ entityId: E.slide, id: s.id, before: { [F.slide.layout]: s.layout }, after: { [F.slide.layout]: layout } }));
  for (const s of picked) s.layout = layout;
  laidCache.clear(); drawSorter(); drawGrid(); drawStage(); drawInspector();
  try { await writeStep(picked.length === 1 ? `${layoutOf(layout).label} layout` : `${layoutOf(layout).label} layout on ${picked.length} slides`, writes, records, { before: ofSelection(), after: ofSelection() }); }
  catch (error) { problem(error, 'The layout could not be changed'); }
  await refresh();
}

// ---- Copy, cut and paste slides ----------------------------------------------------------------
// The clipboard carries the slides as Deck's own type, read back by a paste in this deck, another
// deck or another Deck file, and their words as plain text for anywhere else. Deck keeps its last
// copy too, for Paste from a menu, where the browser does not hand a view the clipboard.

const SLIDES_TYPE = 'application/x-nendo-deck-slides';
// A paste reads at most this many slides, so cut and copy refuse a bigger pick before deleting any.
const CLIPBOARD_MOST = 100;
const outline = slides => slides.map(s => [s.kicker, s.title, s.body, s.body2].filter(Boolean).join('\n')).join('\n\n');
/** The slide list or the sorter has the keys, and no field or box of words. */
const slidesFocused = () => !!document.activeElement?.closest?.('#slides, #grid') && !editor?.active();

function copySlides() {
  const picked = selectedSlides();
  if (picked.length > CLIPBOARD_MOST) { toast(`Cut and copy take up to ${CLIPBOARD_MOST} slides at a time, and ${picked.length} are picked. Pick fewer slides.`); return null; }
  const payload = { format: 'nendo.deck-slides', version: 1, slides: picked.map(copyOf) };
  const text = outline(picked) || picked.map(s => s.layout).join('\n');
  deck.clipboard = { payload, text };
  return { payload, text, count: picked.length, ids: picked.map(s => s.id) };
}
function putOnClipboard(data) {
  const copied = copySlides();
  if (!copied) return 0;
  const { payload, text, count } = copied;
  data.setData('text/plain', text);
  data.setData(SLIDES_TYPE, JSON.stringify(payload));
  return count;
}
/** Slides from Deck's own clipboard type, kept to what a slide can hold. */
function readSlides(payload) {
  if (payload?.format !== 'nendo.deck-slides' || !Array.isArray(payload.slides)) return [];
  return payload.slides.slice(0, CLIPBOARD_MOST).filter(x => x && typeof x === 'object').map(x => {
    const s = {};
    for (const k of EDITABLE) {
      const value = x[k];
      if (k === 'hidden') s.hidden = value === true;
      else if (k === 'layout') s.layout = LAYOUT_IDS.includes(value) ? value : 'Bullets';
      else if (k === 'chart') s.chart = CHARTS.includes(value) ? value : '';
      else if (k === 'build') s.build = BUILDS.includes(value) ? value : 'None';
      else if (k === 'transition') s.transition = SLIDE_TRANSITIONS.includes(value) ? value : 'Deck';
      else if (k === 'seconds') s.seconds = Number.isInteger(value) && value > 0 ? value : '';
      else s[k] = typeof value === 'string' ? value : '';
    }
    return s;
  });
}
async function pasteSlides(payload) {
  const list = readSlides(payload);
  if (!list.length) { toast('The clipboard holds no slides. Copy slides in Deck first.'); return; }
  await insertSlides(list, `Paste ${slidesWord(list.length)}`, afterPicked());
}
/** Copy, cut and paste from a menu: the browser's own command where it allows it, Deck's own copy where not. */
async function clipboardCommand(action) {
  window.focus();
  (deck.sorter ? $('grid') : $('slides')).focus({ preventScroll: true });
  let heard = false;
  const hear = () => { heard = true; };
  document.addEventListener(action, hear, true);
  try { document.execCommand(action); } catch { /* refused: below */ }
  document.removeEventListener(action, hear, true);
  if (heard) return;
  if (action === 'paste') {
    let text = null;
    try { text = await navigator.clipboard.readText(); } catch { /* not offered: Deck's own copy */ }
    if (deck.clipboard && (text === null || text === deck.clipboard.text)) return pasteSlides(deck.clipboard.payload);
    toast('Press Ctrl+V to paste slides here.');
    return;
  }
  const copied = copySlides();
  if (!copied) return;
  const { text, count, ids } = copied;
  try { await navigator.clipboard.writeText(text); } catch { /* Deck's own copy still pastes here */ }
  if (action === 'cut') return deleteSlides('Cut', ids);
  toast(`Copied ${slidesWord(count)}.`);
}

// ---- Pictures ----------------------------------------------------------------------------------

/**
 * Puts a picture into one of the slide's pictures: `slot` 0 is its Picture, 1 to 3 the Picture grid's
 * others. A slide whose layout draws no such picture takes one that does.
 */
async function putPicture(file, slide = currentSlide(), slot = 0) {
  if (!slide || !file) return;
  if (!/^image\/(png|jpeg|gif|webp|svg\+xml|avif)$/.test(file.type)) { toast(`${file.name} is not a picture Deck can use: PNG, JPEG, GIF, WebP or SVG.`); return; }
  await flushAll();
  try {
    toast(`Putting ${file.name} into the file…`);
    const fresh = await nendo.records.get(E.slide, slide.id);
    const { address } = await nendo.media.put(file, { name: file.name, mediaType: file.type, record: { entityId: E.slide, recordId: slide.id, version: fresh.version }, fieldId: F.slide[PICTURES[slot]] });
    const wanted = slot > 0 ? (slide.layout === 'Picture grid' ? null : 'Picture grid') : layoutOf(slide.layout).uses.includes('image') ? null : 'Image right';
    if (wanted) {
      const record = await nendo.records.get(E.slide, slide.id);
      await nendo.records.update({ entityId: E.slide, recordId: slide.id, version: record.version }, { [F.slide.layout]: wanted });
    }
    deck.media.delete(address);
    await refresh();
    toast(`${file.name} is on slide ${deck.slides.indexOf(currentSlide()) + 1}.`);
  } catch (error) { problem(error, 'The picture could not be put in the file'); }
}

/** Which of the slide's pictures the file chooser fills when it answers. */
let pictureSlot = 0;
function choosePicture(slot) {
  pictureSlot = slot;
  $('image-file').click();
}
/**
 * Which picture a file dropped on the stage goes into: the picture or the place it falls on, else in
 * a Picture grid its first empty place, else the slide's Picture.
 */
function dropSlot(target) {
  const on = target?.closest?.('[data-slot]')?.dataset.slot;
  if (on !== undefined) return Number(on);
  const slide = currentSlide();
  if (slide?.layout !== 'Picture grid') return 0;
  const empty = PICTURES.findIndex(key => !slide[key]);
  return empty < 0 ? 0 : empty;
}

// ---- Brand kits --------------------------------------------------------------------------------

/** A Deck design from Brandkits, or a brand kit's tokens, CSS, bundle or logo: each by its own reader. */
function importDesignOrBrand(file) {
  return String(file?.name ?? '').toLowerCase().endsWith(DESIGN_EXTENSION) ? importDesign(file) : importBrand(file);
}

/**
 * A .deckdesign file becomes one Brand kit and one Template that names it: a Design. A second
 * import of the same Brandkits kit updates both in place, so every deck that uses it follows.
 * The records land in one revision; the pictures follow, one media write each.
 */
async function importDesign(file) {
  try {
    const { design, pictures } = await readDesignPackage(new Uint8Array(await file.arrayBuffer()), file.name);
    const key = sourceKey(design);
    const template = deck.templates.find(t => v(t, F.template.source) === key) ?? null;
    const brand = template ? deck.brands.find(b => b.recordId === v(template, F.template.brand)) ?? null : null;
    const values = designValues(design);
    const brandId = brand?.recordId ?? newId('brand'), templateId = template?.recordId ?? newId('template');
    const writes = [
      brand ? { op: 'update', entityId: E.brand, recordId: brandId, version: brand.version, values: values.brand }
        : { op: 'create', entityId: E.brand, recordId: brandId, values: values.brand },
      template ? { op: 'update', entityId: E.template, recordId: templateId, version: template.version, values: { ...values.template, [F.template.brand]: brandId } }
        : { op: 'create', entityId: E.template, recordId: templateId, values: { ...values.template, [F.template.brand]: brandId } },
    ];
    await nendo.records.batch(writes, { label: `Import the design ${design.name}`.slice(0, 80) });
    const put = async (entityId, recordId, fieldId, path) => {
      const fresh = await nendo.records.get(entityId, recordId);
      const picture = path ? pictures.get(path) : null;
      if (picture) await nendo.media.put(new Blob([picture.bytes], { type: picture.type }), { name: picture.name, mediaType: picture.type, record: { entityId, recordId, version: fresh.version }, fieldId });
      else if (fresh.values?.[fieldId]) await nendo.records.update({ entityId, recordId, version: fresh.version }, { [fieldId]: null });
    };
    for (const [key, fieldId] of [['light', F.brand.logo], ['dark', F.brand.logoDark], ['mark', F.brand.mark]]) await put(E.brand, brandId, fieldId, design.logos?.[key]);
    for (const slot of SLOTS) await put(E.template, templateId, IMAGE_FIELDS[slot], design.backgrounds?.[slot]?.kind === 'image' ? design.backgrounds[slot].src : null);
    await refresh();
    await useDesign(templateId, design.deck);
    toast(`${design.name} is in as a design${template ? ', updated in place' : ''}: ${Object.keys(design.colors ?? {}).length} colours, ${pictures.size} ${pictures.size === 1 ? 'picture' : 'pictures'}.`);
  } catch (error) { problem(error, 'The design could not be imported'); }
}

/** Puts a design on the deck: its template and its kit, and its footer and numbers where the deck has none. */
async function useDesign(templateId, defaults = null) {
  const d = currentDeck();
  const t = deck.templates.find(x => x.recordId === templateId);
  if (!d || !t) return;
  const changes = { template: t.recordId, brand: v(t, F.template.brand) };
  if (defaults?.footer && !v(d, F.deck.footer)) changes.footer = defaults.footer;
  if (defaults?.slideNumbers === false && v(d, F.deck.numbers) !== false) changes.numbers = false;
  if (v(d, F.deck.template) === changes.template && v(d, F.deck.brand) === changes.brand && Object.keys(changes).length === 2) return;
  await editDeck(changes);
}

async function importBrand(file) {
  try {
    const kit = await importBrandFile(file);
    const id = newId('brand');
    // What the file holds, by field: an import again changes only that and keeps the rest of the kit.
    const held = Object.fromEntries(Object.entries(kitValues(kit)).map(([k, val]) => [F.brand[k], val]));
    const existing = deck.brands.find(b => (v(b, F.brand.name) ?? '').toLowerCase() === (kit.name || '').toLowerCase());
    let record;
    if (existing && Object.keys(kit.colors).length) {
      record = await nendo.records.update({ entityId: E.brand, recordId: existing.recordId, version: existing.version }, held);
    } else if (Object.keys(kit.colors).length) {
      const values = { [F.brand.name]: 'Imported kit', [F.brand.voice]: null, [F.brand.tagline]: null, [F.brand.tokens]: null, [F.brand.headingFont]: null, [F.brand.bodyFont]: null, [F.brand.monoFont]: null };
      for (const role of BRAND_ROLES) values[F.brand[role]] = null;
      record = await nendo.records.create(E.brand, { ...values, ...held }, { recordId: id });
    } else {
      // A logo on its own goes onto the kit the deck uses.
      const target = deck.brands.find(b => b.recordId === v(currentDeck(), F.deck.brand));
      if (!target) { toast('Choose a brand kit first, then add its logo.'); return; }
      record = target;
    }
    for (const [slot, field] of [['light', F.brand.logo], ['dark', F.brand.logoDark]]) {
      const logo = kit.logos[slot];
      if (!logo) continue;
      const fresh = await nendo.records.get(E.brand, record.recordId);
      await nendo.media.put(new Blob([logo.bytes], { type: logo.type }), { name: logo.name, mediaType: logo.type, record: { entityId: E.brand, recordId: record.recordId, version: fresh.version }, fieldId: field });
    }
    await refresh();
    const d = currentDeck();
    if (d && v(d, F.deck.brand) !== record.recordId) await editDeck({ brand: record.recordId });
    const logos = Object.keys(kit.logos).length;
    toast(`${kit.name || 'The kit'} is in: ${Object.keys(kit.colors).length} colours${kit.fonts.heading ? ', fonts' : ''}${logos ? `, ${logos} logo${logos > 1 ? 's' : ''}` : ''}${kit.voice ? ', voice' : ''}.`);
  } catch (error) { problem(error, 'The brand kit could not be imported'); }
}

// ---- Asking the agent --------------------------------------------------------------------------

async function ask(text, { scope = deck.scope, mission = '' } = {}) {
  const d = currentDeck();
  const request = String(text ?? '').trim() || mission;
  if (!d || !request || deck.asking) return;
  const slide = currentSlide();
  const realScope = mission ? 'Mission' : scope;
  const id = newId('ask');
  const selection = realScope === 'Selection' && slide ? `${slide.id} (slide ${deck.slides.indexOf(slide) + 1}: ${slide.title || slide.layout})` : '';
  try {
    await flushAll();
    await nendo.records.create(E.ask, {
      [F.ask.deck]: d.recordId, [F.ask.scope]: realScope, [F.ask.request]: mission && text ? `${mission}: ${text}` : request, [F.ask.selection]: selection || null,
      [F.ask.status]: 'Waiting', [F.ask.made]: new Date().toISOString() }, { recordId: id, targetVersions: { [F.ask.deck]: d.version } });
  } catch (error) { problem(error, 'The ask could not be written'); return; }
  deck.asking = true; deck.lastReply = '';
  $('ask-text').value = ''; $('mission').value = '';
  await refresh();
  const lines = [
    `Deck ask ${id}. Work it by the Deck skill (${SKILL}): read it first if you have not.`,
    `Deck: ${d.recordId} "${v(d, F.deck.title) ?? ''}" with ${deck.slides.length} slides, template ${deck.theme.name}${deck.theme.brand ? `, brand kit ${deck.theme.brand.name}` : ''}.`,
    `Scope: ${realScope}${mission ? ` (${mission})` : ''}.`,
    selection ? `Selected slide: ${selection}. Change it only through Variant records.` : '',
    `Request: ${request}`,
    'Set the Ask to Working, write a Progress line per slide, and set it to Done with a one-paragraph Reply when you finish.',
  ].filter(Boolean);
  const context = [
    { uri: `nendo://application/entity/${E.ask}/records?recordId=${id}`, title: 'This ask', text: request.slice(0, 2000) },
    { uri: `nendo://application/entity/${E.deck}/records?recordId=${d.recordId}`, title: `Deck: ${(v(d, F.deck.title) ?? '').slice(0, 100) || 'Untitled'}`, text: [v(d, F.deck.audience), v(d, F.deck.goal)].filter(Boolean).join('\n').slice(0, 2000) || 'The deck record.' },
  ];
  if (selection) context.push({ uri: `nendo://application/entity/${E.slide}/records?recordId=${slide.id}`, title: `Slide ${deck.slides.indexOf(slide) + 1}`, text: `${slide.layout}: ${slide.title}\n${slide.body}`.slice(0, 3000) });
  drawAsk();
  try {
    const answer = await nendo.assistant.ask(lines.join('\n'), { context });
    deck.lastReply = answer?.reply ? answer.reply.trim().split('\n').slice(0, 6).join('\n') : '';
    // A turn cut short (max_tokens, max_turn_requests, refusal) may leave slides half written.
    const stop = answer?.stopReason;
    await finishAsk(id, stop === 'end_turn' ? 'Done' : stop === 'cancelled' ? 'Cancelled' : 'Failed', answer?.reply || (stop ? `The agent stopped: ${stop}.` : ''));
  } catch (error) {
    deck.lastReply = refusalText(error);
    await finishAsk(id, 'Failed', deck.lastReply);
  } finally {
    deck.asking = false;
    await refresh();
  }
}
/** The agent closes its own Ask; this closes one it left open, so nothing stays Working forever. */
async function finishAsk(id, status, reply) {
  const record = await nendo.records.get(E.ask, id).catch(() => null);
  if (!record || !['Waiting', 'Working'].includes(v(record, F.ask.status))) return;
  await nendo.records.update({ entityId: E.ask, recordId: id, version: record.version }, { [F.ask.status]: status, [F.ask.reply]: v(record, F.ask.reply) ?? (reply.slice(0, 8000) || null) }).catch(() => null);
}
function refusalText(error) {
  switch (error?.code) {
    case 'assistant-off': return 'Views may not message your agent: the Agent page is set to Never.';
    case 'assistant-declined': return 'Not sent: you said Not now. Ask again in half a minute.';
    case 'assistant-unavailable': return 'No agent can run now. Launch one from the Agent page.';
    case 'assistant-busy': return 'Your agent already has messages waiting. Ask again when it is done.';
    default: return `The ask did not reach your agent: ${error?.message ?? error}`;
  }
}

async function useVariants(list) {
  await flushAll();
  const writes = [], touched = new Set(), replaced = [];
  for (const variant of list) {
    const slideId = v(variant, F.variant.slide);
    const slide = deck.slides.find(s => s.id === slideId);
    if (!slide || touched.has(slideId)) continue;
    touched.add(slideId);
    let changes = {};
    try { changes = pick(JSON.parse(v(variant, F.variant.changes) ?? '{}')); } catch { /* nothing to use */ }
    const pending = deck.pending.get(slideId);
    if (pending) replaced.push([slideId, Object.keys(changes).filter(k => k in pending.values).map(k => [k, pending.values[k]])]);
    writes.push({ op: 'update', entityId: E.slide, recordId: slideId, version: slide.record.version, values: toValues(changes) });
    writes.push({ op: 'update', entityId: E.variant, recordId: variant.recordId, version: variant.version, values: { [F.variant.status]: 'Used' } });
    for (const other of deck.variants.filter(x => x !== variant && v(x, F.variant.slide) === slideId && v(x, F.variant.ask) === v(variant, F.variant.ask) && v(x, F.variant.status) === 'Proposed'))
      writes.push({ op: 'update', entityId: E.variant, recordId: other.recordId, version: other.version, values: { [F.variant.status]: 'Dismissed' } });
  }
  if (!writes.length) return;
  try {
    await nendo.records.batch(writes, { label: list.length > 1 ? `Use ${touched.size} variants` : `Use ${v(list[0], F.variant.label) ?? 'a variant'}`.slice(0, 80), offerUndo: true });
    // The variant replaced these fields; typing made in them since stays.
    for (const [slideId, fields] of replaced) {
      const pending = deck.pending.get(slideId);
      if (!pending) continue;
      for (const [k, val] of fields) if (pending.values[k] === val) delete pending.values[k];
      if (!Object.keys(pending.values).length) deck.pending.delete(slideId);
    }
    keepDrafts();
    await refresh();
  } catch (error) { problem(error, 'The variant could not be used'); }
}
async function dismissVariants(list) {
  const writes = list.map(x => ({ op: 'update', entityId: E.variant, recordId: x.recordId, version: x.version, values: { [F.variant.status]: 'Dismissed' } }));
  if (!writes.length) return;
  try { await nendo.records.batch(writes, { label: 'Dismiss variants', offerUndo: true }); await refresh(); } catch (error) { problem(error, 'The variants could not be dismissed'); }
}

// ---- Present and export ------------------------------------------------------------------------

/** Pictures as data: URLs (HTML) or bytes (PowerPoint), read from the file. */
async function pictureBytes(address) {
  let blob = null;
  if (/^media:/.test(address) && nendo.has('media.read')) blob = await nendo.media.read(address);
  else { const url = urlFor(address); if (url) { const r = await fetch(url).catch(() => null); if (r?.ok) blob = await r.blob(); } }
  return blob;
}
async function rasterise(blob, width = 1600) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const w = img.naturalWidth || width, h = img.naturalHeight || Math.round(width * 0.5);
    const scale = blob.type === 'image/svg+xml' ? Math.max(1, width / w) : 1;
    const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(w * scale), height: Math.round(h * scale) });
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const png = await new Promise(r => canvas.toBlob(r, 'image/png'));
    return { bytes: new Uint8Array(await png.arrayBuffer()), ext: 'png', width: canvas.width, height: canvas.height };
  } finally { URL.revokeObjectURL(url); }
}
function addressesOf(laidSlides) {
  const set = new Set();
  for (const l of laidSlides) for (const p of l.items) if (p.type === 'image' && p.src) set.add(p.src);
  return set;
}
const dataUrl = blob => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = reject; r.readAsDataURL(blob); });

async function htmlDocument({ embedded = false, start = 0, leftOut = [], rehearse = false } = {}) {
  const d = currentDeck();
  const shown = deck.slides.filter(s => !s.hidden);
  const laidSlides = shown.map((s, i) => laid(s, deck.theme, false, i + 1));
  const urls = new Map();
  for (const address of addressesOf(laidSlides)) {
    if (embedded) { urls.set(address, urlFor(address)); continue; }
    const blob = await pictureBytes(address).catch(() => null);
    if (blob) urls.set(address, await dataUrl(blob));
    // A web picture Nendo cannot read stays linked by its address; one in a folder on this computer cannot travel.
    else if (/^https:\/\//i.test(address)) urls.set(address, address);
    else { urls.set(address, null); leftOut.push(address); }
  }
  const { W, H } = sizeOf(deck.theme.aspect);
  const deckTransition = v(d, F.deck.transition);
  return buildHtml({ title: v(d, F.deck.title) ?? 'Deck', author: v(d, F.deck.author) ?? '', W, H, theme: deck.theme, start, embedded, rehearse, minutes: v(d, F.deck.minutes),
    slides: laidSlides.map((l, i) => ({ html: slideHtml(l, { urlFor: a => urls.get(a) ?? null }), notes: shown[i].notes, title: shown[i].title || shown[i].layout,
      steps: l.steps, transition: transitionOf(shown[i], deckTransition), seconds: shown[i].seconds })) });
}

function download(blob, name) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  deck.exports.push({ name, size: blob.size, type: blob.type });
  deck.lastExport = blob;
}
const fileName = ext => `${String(v(currentDeck(), F.deck.title) ?? 'Deck').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Deck'}.${ext}`;

async function exportHtml() {
  await flushAll();
  toast('Making the HTML file…');
  const leftOut = [];
  download(new Blob([await htmlDocument({ leftOut })], { type: 'text/html' }), fileName('html'));
  deck.exports.at(-1).leftOut = leftOut.length;
  const n = leftOut.length;
  if (n) toast(`${n} ${n === 1 ? 'picture is' : 'pictures are'} linked from a folder on this computer and not in the HTML file. Embed ${n === 1 ? 'it' : 'them'} in the file to take ${n === 1 ? 'it' : 'them'} along.`);
}
async function exportPptx() {
  await flushAll();
  toast('Making the PowerPoint file…');
  const deckTransition = v(currentDeck(), F.deck.transition);
  const slides = deck.slides.map((s, i) => ({ laid: laid(s, deck.theme, false, numberOf(s)), hidden: s.hidden, i, transition: transitionOf(s, deckTransition) }));
  const images = new Map(), missing = [];
  for (const address of addressesOf(slides.map(s => s.laid))) {
    try {
      const blob = await pictureBytes(address);
      if (!blob) { missing.push(address); continue; }
      if (/^image\/(png|jpeg|gif)$/.test(blob.type)) {
        const bitmap = await createImageBitmap(blob);
        images.set(address, { bytes: new Uint8Array(await blob.arrayBuffer()), ext: blob.type === 'image/jpeg' ? 'jpeg' : blob.type.slice(6), width: bitmap.width, height: bitmap.height });
        bitmap.close?.();
      } else images.set(address, await rasterise(blob));
    } catch { missing.push(address); }
  }
  const d = currentDeck();
  const bytes = buildPptx({ deck: { title: v(d, F.deck.title), author: v(d, F.deck.author) }, theme: deck.theme, slides, images });
  download(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }), fileName('pptx'));
  if (missing.length) toast(`${missing.length} picture${missing.length > 1 ? 's are' : ' is'} linked, not in the file, so PowerPoint leaves ${missing.length > 1 ? 'them' : 'it'} out.`);
}
async function exportNotes() {
  await flushAll();
  const d = currentDeck();
  const lines = [`# ${v(d, F.deck.title) ?? 'Deck'}`, ''];
  deck.slides.filter(s => !s.hidden).forEach((s, i) => { lines.push(`## ${i + 1}. ${s.title || s.layout}`, '', s.notes || '_No notes._', ''); });
  download(new Blob([lines.join('\n')], { type: 'text/markdown' }), fileName('md').replace(/\.md$/, ' - notes.md'));
}

let presentUrl = null;
/** Present, from the start or from this slide; a rehearsal starts the console's clock and keeps the time on each slide. */
async function present(fromHere = false, { rehearse = false } = {}) {
  await flushAll();
  const shown = deck.slides.filter(s => !s.hidden);
  if (!shown.length) { toast('There is no slide to show: every slide is hidden.'); return; }
  const start = fromHere ? Math.max(0, shown.findIndex(s => s.id === deck.slideId)) : 0;
  if (presentUrl) URL.revokeObjectURL(presentUrl);
  deck.rehearsing = rehearse ? shown.map(s => s.id) : null;
  presentUrl = URL.createObjectURL(new Blob([await htmlDocument({ embedded: true, start, rehearse })], { type: 'text/html' }));
  const overlay = $('present');
  overlay.hidden = false;
  deck.presenting = true;
  $('present-frame').src = presentUrl;
  overlay.requestFullscreen?.().catch(() => {});
  $('present-frame').addEventListener('load', () => $('present-frame').contentWindow?.focus(), { once: true });
}
function stopPresenting(index, timings = null) {
  $('present').hidden = true;
  deck.presenting = false;
  const ran = deck.rehearsing;
  deck.rehearsing = null;
  if (ran && Array.isArray(timings)) offerTimings(ran, timings);
  $('present-frame').src = 'about:blank';
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  const shown = deck.slides.filter(s => !s.hidden);
  if (Number.isInteger(index) && shown[index]) select(shown[index].id);
  (deck.sorter ? $('grid') : $('slides')).focus();
}
addEventListener('message', event => {
  if (event.source !== $('present-frame').contentWindow || !event.data) return;
  if (event.data.deck === 'close') stopPresenting(event.data.index, event.data.timings);
});
/**
 * After a rehearsal: the time on each slide reached, offered to keep. A slide not reached keeps the
 * time it had. Kept, they are one step, and the presenter view paces the talk by them.
 */
function offerTimings(ids, timings) {
  const times = ids.map((id, i) => ({ id, seconds: Math.round(Number(timings[i]) || 0) })).filter(x => x.seconds >= 1 && deck.slides.some(s => s.id === x.id));
  if (!times.length) { deck.timings = null; drawRehearsed(); return; }
  const total = times.reduce((a, b) => a + b.seconds, 0);
  const minutes = v(currentDeck(), F.deck.minutes);
  deck.timings = { deckId: deck.deckId, times };
  const of = minutes ? `, for a ${clock(minutes * 60)} talk` : '';
  $('rehearsed-text').textContent = `You rehearsed for ${clock(total)} over ${times.length} ${times.length === 1 ? 'slide' : 'slides'}${of}. Keep the time on each slide? The presenter view then paces the talk by it.`;
  drawRehearsed();
}
function drawRehearsed() { $('rehearsed').hidden = !deck.timings || deck.timings.deckId !== deck.deckId; }
async function keepTimings() {
  // The offer is put away while the times are written, and back if the file refuses them.
  const kept = deck.timings;
  deck.timings = null; drawRehearsed();
  if (!kept || kept.deckId !== deck.deckId || nendo.context?.readOnly) return;
  await flushAll();
  const list = kept.times.map(x => ({ ...x, slide: deck.slides.find(s => s.id === x.id) })).filter(x => x.slide);
  const writes = list.map(x => ({ op: 'update', entityId: E.slide, recordId: x.id, version: x.slide.record.version, values: { [F.slide.seconds]: x.seconds } }));
  const records = list.map(x => ({ entityId: E.slide, id: x.id, before: { [F.slide.seconds]: x.slide.seconds ?? null }, after: { [F.slide.seconds]: x.seconds } }));
  try {
    await writeStep('Keep the rehearsal times', writes, records, { before: ofSelection(), after: ofSelection() });
    announce(`Kept the times on ${slidesWord(list.length)}.`);
  } catch (error) {
    deck.timings ??= kept;
    problem(error, 'The times could not be kept');
  }
  await refresh();
  drawRehearsed();
}
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && deck.presenting) { /* stays in the frame */ } });

// ---- Selection, places, commands ---------------------------------------------------------------

/** Makes a slide the current one, on the stage; `keep` keeps the pick, otherwise it is this slide alone. */
function select(id, { place = true, keep = false } = {}) {
  if (!deck.slides.some(s => s.id === id)) return;
  save.flush();
  deck.slideId = id;
  if (!keep) { deck.selected = [id]; deck.anchor = id; }
  keepSelection();
  drawSorter(); drawGrid(); drawLayouts(currentSlide()); drawStage(); drawInspector(); drawVariants(); declareToolbar();
  if (place && nendo.has('ui.setPlace')) nendo.ui.setPlace?.({ deck: deck.deckId, slide: id }, { label: `Slide ${deck.slides.findIndex(s => s.id === id) + 1}`, replace: true })?.catch?.(() => {});
}

/** A click on a slide: it alone, with Ctrl added or taken out, with Shift the run from the anchor. */
function choose(id, e = {}) {
  const r = pickSlides(deck.slides.map(s => s.id), selectedSlides().map(s => s.id), deck.anchor, id, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
  deck.selected = r.selected; deck.anchor = r.anchor;
  select(r.current, { keep: true });
}
function selectAll() {
  deck.selected = deck.slides.map(s => s.id);
  select(deck.slideId ?? deck.slides[0]?.id, { keep: true });
  announce(`All ${deck.slides.length} slides selected.`);
}

/** The slide sorter, over the whole view, or back to the slide on the stage. */
function setSorter(on) {
  deck.sorter = !!on && !!currentDeck();
  drawGrid();
  if (deck.sorter) $('grid').focus({ preventScroll: true });
  else { drawStage(); drawSorter(); $('slides').focus({ preventScroll: true }); }
  declareToolbar();
}
/** A slide opened from the sorter: back to the stage with it current. */
function openFromSorter(id) { select(id); setSorter(false); }

/** The keys of the slide list (`list`) and the sorter (`grid`), as PowerPoint's slide pane and sorter take them. */
function slideKeys(e, where) {
  const ids = deck.slides.map(s => s.id);
  const ctrl = e.ctrlKey || e.metaKey, key = e.key;
  if (!ids.length) { if (key === 'Enter' || (ctrl && /^m$/i.test(key))) { e.preventDefault(); addSlide('Title'); } return; }
  const i = Math.max(0, ids.indexOf(deck.slideId));
  const cols = where === 'grid' ? gridColumns() : 1;
  const by = { ArrowDown: cols, ArrowUp: -cols, ArrowRight: 1, ArrowLeft: -1 }[key];
  const to = n => ids[Math.max(0, Math.min(ids.length - 1, n))];
  const extend = id => choose(id, { shiftKey: true, ctrlKey: false });
  if (by !== undefined || key === 'Home' || key === 'End') {
    e.preventDefault();
    const start = key === 'Home' || (by !== undefined && by < 0);
    if (ctrl && e.shiftKey) return moveSelection(start ? 'start' : 'end');
    if (by !== undefined && ctrl) return moveSelection(Math.abs(by) === 1 ? (by < 0 ? 'up' : 'down') : by);
    const target = by !== undefined ? to(i + by) : key === 'Home' ? ids[0] : ids.at(-1);
    return e.shiftKey ? extend(target) : select(target);
  }
  if (ctrl && /^a$/i.test(key)) { e.preventDefault(); selectAll(); }
  else if (ctrl && /^d$/i.test(key)) { e.preventDefault(); duplicateSlides(); }
  else if (ctrl && /^m$/i.test(key)) { e.preventDefault(); addSlide(nextLayout()); }
  else if (key === 'Delete' || key === 'Backspace') { e.preventDefault(); deleteSlides(); }
  else if (key === 'Enter') { e.preventDefault(); if (where === 'grid') openFromSorter(deck.slideId); else addSlide(nextLayout()); }
  else if (key === 'Escape' && where === 'grid') { e.preventDefault(); setSorter(false); }
  else if (key === 'Escape' && deck.selected.length > 1) { e.preventDefault(); select(deck.slideId); }
  else if (key === 'ContextMenu' || (e.shiftKey && key === 'F10')) {
    e.preventDefault();
    const list = where === 'grid' ? $('grid') : $('slides');
    const r = (list.querySelector('li.current') ?? list).getBoundingClientRect();
    slideMenu(r.left + Math.min(40, r.width / 2), r.top + Math.min(30, r.height / 2), true);
  }
}
const nextLayout = () => currentSlide()?.layout === 'Section' || currentSlide()?.layout === 'Title' ? 'Bullets' : currentSlide()?.layout ?? 'Bullets';

/** The slides' own menu, at a point in the view: Nendo's menu where it has one, the view's own where not. */
async function slideMenu(x, y, onSlide) {
  const picked = selectedSlides(), n = picked.length, ids = deck.slides.map(s => s.id);
  const of = n > 1 ? ` ${n} slides` : ' slide';
  const first = ids.indexOf(picked[0]?.id), last = ids.indexOf(picked.at(-1)?.id);
  const atStart = picked.every((s, k) => ids.indexOf(s.id) === k), atEnd = picked.every((s, k) => ids.indexOf(s.id) === ids.length - n + k);
  const readOnly = !!nendo.context?.readOnly;
  const items = [{ id: 'slide.new', label: 'New slide', keys: 'Ctrl+M', disabled: readOnly }];
  if (onSlide && n) items.push(
    { id: 'slide.duplicate', label: `Duplicate${of}`, keys: 'Ctrl+D', disabled: readOnly },
    { kind: 'separator' },
    { id: 'slide.cut', label: 'Cut', keys: 'Ctrl+X', disabled: readOnly },
    { id: 'slide.copy', label: 'Copy', keys: 'Ctrl+C' },
    { id: 'slide.paste', label: 'Paste', keys: 'Ctrl+V', disabled: readOnly },
    { kind: 'separator' },
    { id: 'slide.hide', kind: 'check', label: `Hide${of}`, checked: picked.every(s => s.hidden), disabled: readOnly },
    { kind: 'separator' },
    { id: 'slide.top', label: 'Move to start', keys: 'Ctrl+Shift+ArrowUp', disabled: readOnly || atStart },
    { id: 'slide.up', label: 'Move up', keys: 'Ctrl+ArrowUp', disabled: readOnly || first <= 0 && atStart },
    { id: 'slide.down', label: 'Move down', keys: 'Ctrl+ArrowDown', disabled: readOnly || last >= ids.length - 1 && atEnd },
    { id: 'slide.bottom', label: 'Move to end', keys: 'Ctrl+Shift+ArrowDown', disabled: readOnly || atEnd },
    { kind: 'separator' },
  );
  else items.push({ id: 'slide.paste', label: 'Paste', keys: 'Ctrl+V', disabled: readOnly }, { kind: 'separator' });
  items.push({ id: 'slide.all', label: 'Select all', keys: 'Ctrl+A', disabled: !ids.length }, { id: 'view.sorter', label: deck.sorter ? 'Back to the slide' : 'Slide sorter' });
  if (onSlide && n) items.push({ kind: 'separator' }, { id: 'slide.delete', label: `Delete${of}`, danger: true, disabled: readOnly });
  const shown = items.map(it => it.kind === 'separator' ? it : { ...it, ...(it.disabled ? { disabled: true } : {}) });
  const answer = deck.chrome && nendo.has('ui.showMenu') ? await nendo.ui.showMenu(shown, { x, y }).catch(() => null) : { id: await ownMenu(shown, x, y) };
  if (answer?.id) command(answer.id, answer.value ?? null);
}

async function openDeck(id) {
  if (id === deck.deckId) return;
  await flushAll();
  deck.deckId = id; deck.slideId = null;
  laidCache.clear();
  await refresh();
  if (nendo.has('ui.setPlace')) nendo.ui.setPlace?.({ deck: id, slide: deck.slideId }, { label: v(currentDeck(), F.deck.title) ?? 'Deck' })?.catch?.(() => {});
}

async function createDeck({ title, about = '', templateId = null, agent = false }) {
  await flushAll();
  const id = newId('deck');
  const tpl = deck.templates.find(t => t.recordId === templateId) ?? null;
  const brand = deck.brands.find(b => b.recordId === v(currentDeck(), F.deck.brand)) ?? null;
  const values = { [F.deck.title]: title, [F.deck.date]: today(), [F.deck.aspect]: '16:9', [F.deck.numbers]: true, [F.deck.status]: 'Draft', [F.deck.goal]: about || null };
  const targetVersions = {};
  if (tpl) { values[F.deck.template] = tpl.recordId; targetVersions[F.deck.template] = tpl.version; }
  if (brand) { values[F.deck.brand] = brand.recordId; targetVersions[F.deck.brand] = brand.version; }
  const writes = [{ op: 'create', entityId: E.deck, recordId: id, values, ...(Object.keys(targetVersions).length ? { targetVersions } : {}) }];
  if (!agent) writes.push({ op: 'create', entityId: E.slide, recordId: newId('slide'), values: { [F.slide.deck]: id, [F.slide.order]: 10, [F.slide.layout]: 'Title', [F.slide.title]: title, [F.slide.kicker]: null, [F.slide.hidden]: false } });
  try {
    await nendo.records.batch(writes, { label: `New deck ${title}`.slice(0, 80), offerUndo: true });
    deck.starting = false;
    deck.deckId = id; deck.slideId = null;
    await refresh();
    if (agent) await ask(about ? `${title}. ${about}` : title, { scope: 'Whole deck' });
  } catch (error) { problem(error, 'The deck could not be made'); }
}

function showStart(cancelable) {
  deck.starting = true;
  $('start').hidden = false;
  $('start-cancel').hidden = !cancelable;
  $('start-agent').hidden = !deck.canAsk;
  const host = $('start-templates');
  const chosen = host.dataset.chosen ?? '';
  host.replaceChildren(...templateRecordsOrBuiltIns().map((t, i) => {
    const b = document.createElement('button');
    b.type = 'button'; b.setAttribute('role', 'option'); b.dataset.template = t.recordId ?? '';
    b.setAttribute('aria-selected', String((chosen || (templateRecordsOrBuiltIns()[0].recordId ?? '')) === (t.recordId ?? '') && (chosen !== '' || i === 0)));
    const label = document.createElement('span'); label.textContent = t.spec.name;
    const about = document.createElement('small'); about.textContent = t.description ?? '';
    const theme = resolveTheme(t.spec, null, {});
    b.append(scaled(layoutSlide({ layout: 'Title', title: $('start-name').value || 'Your title here', kicker: t.spec.name, body: 'Subtitle', image: null }, theme, { measure: canvasMeasure, editing: false }), 230), label, about);
    return b;
  }));
  $('start-name').focus();
}

async function command(id, value) {
  try {
    if (id === 'deck') return openDeck(value);
    if (id === 'new-deck') return showStart(true);
    if (id === 'add.default') return addSlide('Bullets');
    if (id.startsWith('add.')) return addSlide(LAYOUT_IDS[Number(id.slice(4))] ?? 'Bullets');
    if (id === 'slide.new') return addSlide(nextLayout());
    if (id === 'slide.duplicate') return duplicateSlides();
    if (id === 'slide.delete') return deleteSlides();
    if (id === 'slide.hide') return setHidden(!selectedSlides().every(s => s.hidden));
    if (id === 'slide.up' || id === 'slide.down') return moveSelection(id.slice(6));
    if (id === 'slide.top') return moveSelection('start');
    if (id === 'slide.bottom') return moveSelection('end');
    if (id === 'slide.all') return selectAll();
    if (id === 'slide.cut' || id === 'slide.copy' || id === 'slide.paste') return clipboardCommand(id.slice(6));
    if (id === 'view.sorter') return setSorter(typeof value === 'boolean' ? value : !deck.sorter);
    if (id === 'undo' || id === 'redo') return undoAny(id === 'undo');
    if (id === 'present') return present(false);
    if (id === 'present.here') return present(true);
    if (id === 'present.rehearse') return present(false, { rehearse: true });
    if (id === 'export.html') return exportHtml();
    if (id === 'export.pptx') return exportPptx();
    if (id === 'export.notes') return exportNotes();
  } catch (error) { problem(error, 'That did not work'); }
}

function toolbarItems() {
  const d = currentDeck();
  const s = currentSlide();
  const items = [];
  if (deck.decks.length) items.push({ kind: 'select', id: 'deck', label: 'Deck', hideLabel: true, value: deck.deckId, options: deck.decks.slice(0, 64).map(x => ({ value: x.recordId, label: String(v(x, F.deck.title) ?? 'Untitled').slice(0, 80) })) });
  items.push({ kind: 'button', id: 'new-deck', label: 'New deck', icon: 'plus', iconOnly: true });
  items.push({ kind: 'separator' });
  items.push({ kind: 'menu', id: 'add', label: 'New slide', icon: 'layout', disabled: !d, items: LAYOUTS.map((l, i) => ({ id: `add.${i}`, label: l.label, detail: l.hint.slice(0, 120) })) });
  const picked = selectedSlides(), n = picked.length, of = n > 1 ? ` ${n} slides` : ' slide';
  const ids = deck.slides.map(x => x.id);
  const atStart = picked.every((x, k) => ids.indexOf(x.id) === k), atEnd = picked.every((x, k) => ids.indexOf(x.id) === ids.length - n + k);
  // Ctrl C, X and V are the browser's own, so the clipboard keeps Deck's slides for another window;
  // a declared key would be Nendo's, so the menu names them in its detail line instead.
  items.push({ kind: 'menu', id: 'slide', label: 'Slide', icon: 'more', disabled: !s, items: [
    { id: 'slide.duplicate', label: `Duplicate${of}`, keys: 'Ctrl+D' },
    { id: 'slide.cut', label: 'Cut', detail: 'Ctrl X in the slide list' },
    { id: 'slide.copy', label: 'Copy', detail: 'Ctrl C in the slide list' },
    { id: 'slide.paste', label: 'Paste', detail: 'Ctrl V in the slide list' },
    { kind: 'check', id: 'slide.hide', label: 'Hide when presenting', checked: n > 0 && picked.every(x => x.hidden) },
    { kind: 'separator' },
    { id: 'slide.top', label: 'Move to start', keys: 'Ctrl+Shift+ArrowUp', disabled: atStart },
    { id: 'slide.up', label: 'Move up', icon: 'arrowUp', keys: 'Ctrl+ArrowUp', disabled: atStart },
    { id: 'slide.down', label: 'Move down', icon: 'arrowDown', keys: 'Ctrl+ArrowDown', disabled: atEnd },
    { id: 'slide.bottom', label: 'Move to end', keys: 'Ctrl+Shift+ArrowDown', disabled: atEnd },
    { kind: 'separator' },
    { id: 'slide.all', label: 'Select all slides' },
    { kind: 'separator' },
    { id: 'slide.delete', label: `Delete${of}`, icon: 'trash', danger: true },
  ] });
  items.push({ kind: 'toggle', id: 'view.sorter', label: 'Slide sorter', icon: 'layers', iconOnly: true, pressed: deck.sorter, disabled: !d });
  // Ctrl Z and Ctrl Y are the view's own keys, so they are not declared here: Nendo would take them first.
  const undoing = undoLabel(true), redoing = undoLabel(false);
  items.push({ kind: 'group', label: 'Undo and redo', items: [
    { kind: 'button', id: 'undo', label: undoing ? `Undo ${undoing}`.slice(0, 80) : 'Undo', icon: 'undo', iconOnly: true, disabled: !undoing },
    { kind: 'button', id: 'redo', label: redoing ? `Redo ${redoing}`.slice(0, 80) : 'Redo', icon: 'redo', iconOnly: true, disabled: !redoing },
  ] });
  items.push({ kind: 'spacer' });
  items.push({ kind: 'menu', id: 'export', label: 'Export', icon: 'export', disabled: !s, items: [
    { id: 'export.pptx', label: 'PowerPoint (.pptx)', detail: 'Editable slides, speaker notes and the theme' },
    { id: 'export.html', label: 'HTML (one file)', detail: 'Plays in any browser; P for presenter view, Ctrl P for PDF' },
    { id: 'export.notes', label: 'Speaker notes (.md)' },
  ] });
  items.push({ kind: 'button', id: 'present.rehearse', label: 'Rehearse', disabled: !s });
  items.push({ kind: 'button', id: 'present.here', label: 'From this slide', icon: 'eye', disabled: !s, keys: 'Shift+F5' });
  items.push({ kind: 'button', id: 'present', label: 'Present', icon: 'eye', disabled: !s, keys: 'F5' });
  return items;
}
let lastToolbar = '';
function declareToolbar() {
  const items = toolbarItems();
  if (deck.chrome) {
    const json = JSON.stringify(items);
    if (json === lastToolbar) return;
    lastToolbar = json;
    deck.toolbars++;
    nendo.ui.setToolbar({ items, add: currentDeck() ? 'add.default' : null }).catch(error => problem(error, 'Nendo refused the toolbar'));
    return;
  }
  // Without Nendo's toolbar, the same controls in the view's own row.
  const bar = $('own-toolbar');
  bar.hidden = false; document.body.classList.add('has-own-toolbar');
  bar.replaceChildren(...items.flatMap(i => i.kind === 'group' ? i.items : [i]).filter(i => i.kind !== 'separator').map(item => {
    if (item.kind === 'spacer') { const s = document.createElement('span'); s.style.flex = '1'; return s; }
    if (item.kind === 'select') {
      const sel = document.createElement('select'); sel.setAttribute('aria-label', item.label);
      for (const o of item.options) sel.append(new Option(o.label, o.value, false, o.value === item.value));
      sel.onchange = () => command(item.id, sel.value); return sel;
    }
    if (item.kind === 'menu') {
      const sel = document.createElement('select'); sel.setAttribute('aria-label', item.label); sel.disabled = !!item.disabled;
      sel.append(new Option(item.label, ''));
      for (const o of item.items) if (o.id) sel.append(new Option(o.label, o.id));
      sel.onchange = () => { const id = sel.value; sel.value = ''; if (id) command(id, true); }; return sel;
    }
    const b = document.createElement('button'); b.type = 'button'; b.className = 'ghost-button'; b.textContent = item.label; b.disabled = !!item.disabled;
    b.onclick = () => command(item.id, null); return b;
  }));
}

// ---- Events ------------------------------------------------------------------------------------

function wire() {
  // The slide list and the sorter: a click picks, Ctrl and Shift pick more, a drag moves the pick,
  // the keys move and pick as PowerPoint's do, and a right click opens the slides' menu.
  const list = $('slides'), grid = $('grid');
  for (const [el, where] of [[list, 'list'], [grid, 'grid']]) {
    el.addEventListener('click', e => { const li = e.target.closest('li[data-id]'); if (li) choose(li.dataset.id, e); });
    el.addEventListener('keydown', e => slideKeys(e, where));
    el.addEventListener('contextmenu', e => {
      e.preventDefault();
      const li = e.target.closest('li[data-id]');
      if (li && !deck.selected.includes(li.dataset.id)) select(li.dataset.id);
      else if (li && li.dataset.id !== deck.slideId) select(li.dataset.id, { keep: true });
      el.focus({ preventScroll: true });
      slideMenu(e.clientX, e.clientY, !!li);
    });
    drags[where] = createSlideDrag({
      list: el, item: 'li[data-id]', grid: where === 'grid',
      ended: () => queueMicrotask(() => { drawSorter(); drawGrid(); }),
      readOnly: () => !!nendo.context?.readOnly,
      ids: () => deck.slides.map(s => s.id),
      // A press on a picked slide lifts the whole pick; on another, that slide alone.
      lift: id => {
        if (!deck.selected.includes(id)) select(id); else if (id !== deck.slideId) select(id, { keep: true });
        return selectedSlides().map(s => s.id);
      },
      ghost: ids => scaled(laid(deck.slides.find(s => s.id === (ids.includes(deck.slideId) ? deck.slideId : ids[0])), deck.theme, false), 148),
      drop: (ids, before, { copy }) => {
        if (!copy) return arrange(moveBlock(deck.slides.map(s => s.id), ids, before), ids);
        const at = before === null ? deck.slides.length : deck.slides.findIndex(s => s.id === before);
        const copies = deck.slides.filter(s => ids.includes(s.id)).map(copyOf);
        return insertSlides(copies, `Copy ${slidesWord(copies.length)}`, at);
      },
    });
  }
  list.addEventListener('dblclick', e => { const li = e.target.closest('li[data-id]'); if (li) present(true); });
  grid.addEventListener('dblclick', e => { const li = e.target.closest('li[data-id]'); if (li) openFromSorter(li.dataset.id); });
  // Copy, cut and paste while the slide list or the sorter has the keys.
  document.addEventListener('copy', e => { if (!slidesFocused() || !deck.slides.length) return; e.preventDefault(); const n = putOnClipboard(e.clipboardData); if (n) announce(`Copied ${slidesWord(n)}.`); });
  document.addEventListener('cut', e => {
    if (!slidesFocused() || !deck.slides.length || nendo.context?.readOnly) return;
    e.preventDefault();
    const ids = selectedSlides().map(s => s.id);
    if (putOnClipboard(e.clipboardData)) deleteSlides('Cut', ids);
  });
  document.addEventListener('paste', e => {
    if (!slidesFocused() || nendo.context?.readOnly) return;
    e.preventDefault();
    let payload = null;
    try { payload = JSON.parse(e.clipboardData.getData(SLIDES_TYPE) || 'null'); } catch { payload = null; }
    // A browser that drops the slides' own type still carries their words: Deck's own copy, if it is that one.
    if (!payload && deck.clipboard && e.clipboardData.getData('text/plain') === deck.clipboard.text) payload = deck.clipboard.payload;
    pasteSlides(payload);
  });
  $('grid-done').addEventListener('click', () => setSorter(false));
  const zoom = value => {
    deck.zoom = Math.max(120, Math.min(420, Math.round(value / 10) * 10));
    try { localStorage.setItem('deck.zoom', String(deck.zoom)); } catch { /* the size is for this visit only */ }
    drawGrid();
  };
  $('grid-zoom').addEventListener('input', () => zoom(Number($('grid-zoom').value)));
  grid.addEventListener('wheel', e => { if (!e.ctrlKey) return; e.preventDefault(); zoom(deck.zoom - Math.sign(e.deltaY) * 20); }, { passive: false });
  try { const kept = Number(localStorage.getItem('deck.zoom')); if (kept >= 120 && kept <= 420) deck.zoom = kept; } catch { /* the default size */ }
  $('add-slide').addEventListener('click', async e => {
    if (!deck.chrome || !nendo.has('ui.showMenu')) return addSlide('Bullets');
    const r = e.currentTarget.getBoundingClientRect();
    const picked = await nendo.ui.showMenu(LAYOUTS.map((l, i) => ({ id: `add.${i}`, label: l.label })), { x: r.left, y: r.top }).catch(() => null);
    if (picked?.id) command(picked.id); else if (picked === null) { /* dismissed */ }
  });

  // The stage: words are edited where they stand (stage-editor.mjs). A click on a picture picks
  // one, and on words drawn from a table, such as a chart's, goes to the field they come from.
  const stage = $('stage');
  editor = createStageEditor({
    stage,
    slide: () => currentSlide(),
    write: (field, value) => { edit({ [field]: value }); drawStage(); },
    selectSlide: id => select(id),
    hasSlide: id => deck.slides.some(s => s.id === id),
    ended: ({ quiet }) => { save.flush(); if (!quiet) drawStage(); },
    redraw: () => drawStage(),
    toast,
    readOnly: () => !!nendo.context?.readOnly,
    // New words end what Ctrl Y could put back of the slides' own steps.
    changed: () => { deck.steps.redo = []; },
  });
  stage.addEventListener('click', e => {
    if (e.target.closest('.dk-t[data-field]')) return;
    const role = e.target.closest('[data-role]')?.dataset.role;
    const field = { title: 'f-title', kicker: 'f-kicker', body: 'f-body', body2: 'f-body2', image: 'pick-image', hint: 'pick-image' }[role];
    if (!field) return;
    deck.tab = 'slide'; drawInspector();
    // A picture, or its place, opens the chooser for that one of the slide's pictures.
    // A layout without a picture has hints of its own, such as a pie's, which open nothing.
    if (field === 'pick-image') { if (layoutOf(currentSlide()?.layout).uses.includes('image')) choosePicture(Number(e.target.closest('[data-slot]')?.dataset.slot ?? 0)); return; }
    const el = $(field); if (!el.closest('[hidden]')) el.focus();
  });
  for (const target of [$('stage-wrap')]) {
    target.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); stage.classList.add('drop'); } });
    target.addEventListener('dragleave', () => stage.classList.remove('drop'));
    target.addEventListener('drop', e => { if (!e.dataTransfer.files.length) return; e.preventDefault(); stage.classList.remove('drop'); putPicture(e.dataTransfer.files[0], currentSlide(), dropSlot(e.target)); });
  }
  new ResizeObserver(() => drawStage()).observe($('stage-wrap'));
  new ResizeObserver(debounce(() => drawSorter(), 120)).observe($('slides'));

  // The inspector.
  for (const tab of ['slide', 'design', 'asks', 'check']) $(`tab-${tab}`).addEventListener('click', () => { deck.tab = tab; drawInspector(); });
  $('check-list').addEventListener('click', e => { const b = e.target.closest('[data-slide]'); if (b) select(b.dataset.slide); });
  $('check-rehearse').addEventListener('click', () => present(false, { rehearse: true }));
  $('rehearsed-keep').addEventListener('click', () => keepTimings());
  $('rehearsed-discard').addEventListener('click', () => { deck.timings = null; drawRehearsed(); });
  $('d-minutes').addEventListener('change', () => {
    const n = Math.round(Number($('d-minutes').value));
    editDeck({ minutes: Number.isFinite(n) && n > 0 ? Math.min(600, n) : '' });
  });
  $('layouts').addEventListener('click', e => { const b = e.target.closest('[data-layout]'); if (b) setLayout(b.dataset.layout); });
  for (const input of document.querySelectorAll('#pane-slide [data-field]')) {
    input.addEventListener('input', () => { if (!drawingInspector) typed({ [input.dataset.field]: input.value }); });
    input.addEventListener('blur', () => save.flush());
  }
  $('notes').addEventListener('input', () => { typed({ notes: $('notes').value }); countNotes(); });
  $('design-change').addEventListener('click', () => { deck.tab = 'design'; drawInspector(); $('tab-design').focus(); });
  $('notes').addEventListener('blur', () => save.flush());
  $('f-hidden').addEventListener('change', () => setHidden($('f-hidden').checked));
  PICTURES.forEach((key, i) => {
    $(i ? `pick-image${i + 1}` : 'pick-image').addEventListener('click', () => choosePicture(i));
    $(i ? `clear-image${i + 1}` : 'clear-image').addEventListener('click', () => typed({ [key]: '' }, { now: true }));
  });
  $('image-file').addEventListener('change', () => { const f = $('image-file').files[0]; $('image-file').value = ''; if (f) putPicture(f, currentSlide(), pictureSlot); });
  $('templates').addEventListener('click', e => { const b = e.target.closest('[data-template]'); if (b && b.dataset.template) editDeck({ template: b.dataset.template }); });
  $('brands').addEventListener('click', e => {
    const open = e.target.closest('[data-open]');
    if (open) { nendo.ui.openRecord(E.brand, open.dataset.open).catch(err => problem(err, 'The kit could not be opened')); return; }
    const b = e.target.closest('[data-brand]'); if (b) editDeck({ brand: b.dataset.brand || null });
  });
  $('import-brand').addEventListener('click', () => $('brand-file').click());
  $('brand-file').addEventListener('change', () => { const f = $('brand-file').files[0]; $('brand-file').value = ''; if (f) importDesignOrBrand(f); });
  $('designs').addEventListener('click', e => { const b = e.target.closest('[data-design]'); if (b) useDesign(b.dataset.design); });
  const inspector = $('inspector');
  inspector.addEventListener('dragover', e => { if (deck.tab === 'design' && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); inspector.classList.add('drop'); } });
  inspector.addEventListener('dragleave', () => inspector.classList.remove('drop'));
  inspector.addEventListener('drop', e => { if (deck.tab !== 'design' || !e.dataTransfer.files.length) return; e.preventDefault(); inspector.classList.remove('drop'); importDesignOrBrand(e.dataTransfer.files[0]); });
  for (const input of document.querySelectorAll('[data-deck]')) input.addEventListener('input', () => typeDeck({ [input.dataset.deck]: input.value }));
  $('d-numbers').addEventListener('change', () => editDeck({ numbers: $('d-numbers').checked }));
  $('asks').addEventListener('click', e => {
    const use = e.target.closest('[data-use-all]'), drop = e.target.closest('[data-dismiss-all]');
    if (use) useVariants(deck.variants.filter(x => v(x, F.variant.ask) === use.dataset.useAll && v(x, F.variant.status) === 'Proposed'));
    if (drop) dismissVariants(deck.variants.filter(x => v(x, F.variant.ask) === drop.dataset.dismissAll && v(x, F.variant.status) === 'Proposed'));
  });
  $('variants').addEventListener('click', e => {
    const use = e.target.closest('[data-use]'), drop = e.target.closest('[data-dismiss]');
    if (use) useVariants(deck.variants.filter(x => x.recordId === use.dataset.use));
    if (drop) dismissVariants(deck.variants.filter(x => x.recordId === drop.dataset.dismiss));
  });

  // The ask bar.
  const form = $('ask');
  form.addEventListener('click', e => { const b = e.target.closest('[data-scope]'); if (b) { deck.scope = b.dataset.scope; $('mission').value = ''; drawAsk(); } });
  $('mission').addEventListener('change', drawAsk);
  form.addEventListener('submit', e => { e.preventDefault(); ask($('ask-text').value, { scope: deck.scope, mission: $('mission').value }); });
  $('ask-text').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  $('ask-text').addEventListener('input', () => { const t = $('ask-text'); t.style.height = 'auto'; t.style.height = `${Math.min(120, t.scrollHeight)}px`; });
  $('ask-stop').addEventListener('click', () => nendo.assistant.cancel().catch(err => problem(err, 'Stop did not reach the agent')));

  // The start screen.
  $('start-templates').addEventListener('click', e => { const b = e.target.closest('[data-template]'); if (!b) return; $('start-templates').dataset.chosen = b.dataset.template; for (const x of $('start-templates').children) x.setAttribute('aria-selected', String(x === b)); });
  $('start-form').addEventListener('submit', e => { e.preventDefault(); createDeck({ title: $('start-name').value.trim(), about: $('start-about').value.trim(), templateId: chosenStartTemplate(), agent: true }); });
  $('start-blank').addEventListener('click', () => { if (!$('start-name').reportValidity()) return; createDeck({ title: $('start-name').value.trim(), about: $('start-about').value.trim(), templateId: chosenStartTemplate(), agent: false }); });
  $('start-cancel').addEventListener('click', () => { deck.starting = false; $('start').hidden = true; });

  // Keys the view keeps for itself when no field has focus.
  addEventListener('keydown', e => {
    if (deck.presenting || e.defaultPrevented) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '') || !!document.activeElement?.isContentEditable;
    if (e.key === 'F5' && !deck.chrome) { e.preventDefault(); present(e.shiftKey); }
    if (typing) return;
    // Ctrl Z and Ctrl Y outside a field take back the last change, of words on the stage or of the
    // slides themselves, as PowerPoint's do.
    if ((e.ctrlKey || e.metaKey) && !e.altKey && /^[zy]$/i.test(e.key)) { if (undoAny(e.key.toLowerCase() === 'z' && !e.shiftKey)) e.preventDefault(); return; }
    if (e.key === 'Escape' && deck.sorter) { e.preventDefault(); setSorter(false); return; }
    if ((e.key === 'PageDown' || e.key === 'PageUp') && deck.slides.length) {
      e.preventDefault();
      const i = deck.slides.findIndex(s => s.id === deck.slideId);
      select(deck.slides[Math.max(0, Math.min(deck.slides.length - 1, i + (e.key === 'PageDown' ? 1 : -1)))].id);
    }
  });
  addEventListener('pagehide', () => { save.flush(); saveDeckTyping.flush(); });
  $('held-put').addEventListener('click', () => putHeldBack());
  $('held-discard').addEventListener('click', () => discardHeld());
}
// Unset, the choice is the first the screen shows, which is never a design's template.
const chosenStartTemplate = () => $('start-templates').dataset.chosen || templateRecordsOrBuiltIns()[0]?.recordId || null;

// ---- Start -------------------------------------------------------------------------------------

let refreshing = null, again = false;
async function refresh() {
  if (refreshing) { again = true; return refreshing; }
  refreshing = (async () => {
    do { again = false; await load(); } while (again);
    if (!draftsRead && await restoreDrafts()) await load();
    drawAll();
  })().catch(error => problem(error, 'The deck could not be read')).finally(() => { refreshing = null; });
  return refreshing;
}

(async () => {
  if (!nendo) { document.body.textContent = 'Deck runs inside Nendo.'; return; }
  try { await nendo.ready; } catch (error) { document.body.textContent = error.message; return; }
  deck.chrome = nendo.has('ui.setToolbar');
  deck.canAsk = nendo.has('assistant.ask') && !nendo.context.readOnly;
  wire();
  let read = false;
  try { await load(); read = true; if (await restoreDrafts()) await load(); } catch (error) { problem(error, 'The deck could not be read'); }
  deck.ready = true;
  drawAll();
  // The start screen is for a file with no deck, not for a first read that failed.
  if (read && !deck.decks.length) showStart(false);
  nendo.on('changes', debounce(() => refresh(), 250));
  nendo.on('context', () => { deck.canAsk = nendo.has('assistant.ask') && !nendo.context.readOnly; deck.chrome = nendo.has('ui.setToolbar'); lastToolbar = ''; refresh(); });
  nendo.on('command', ({ id, value }) => command(id, value));
  nendo.on('place', place => { if (place?.deck && place.deck !== deck.deckId) openDeck(place.deck).then(() => place.slide && select(place.slide, { place: false })); else if (place?.slide) select(place.slide, { place: false }); });
  nendo.on('assistant', status => { deck.assistant = status; drawAsk(); });
  nendo.on('theme', () => drawAll());
})();
