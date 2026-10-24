// Deck: write slides, pick a template and a brand kit, present, and export to HTML and
// PowerPoint. Slides are records; the stage, the thumbnails, Present and both exports draw the
// same primitives from layout.mjs. The person's own agent writes whole decks, reworks one slide
// as variants, or runs a mission, through nendo.assistant.ask; its work lands as records.

import { E, F, LAYOUTS, LAYOUT_IDS, CHARTS, layoutOf, slideFrom, sortSlides, reorder } from './model.mjs';
import { TEMPLATES, resolveTheme, sizeOf, webFonts, BRAND_ROLES, normalHex } from './themes.mjs';
import { layoutSlide } from './layout.mjs';
import { slideHtml, SLIDE_CSS } from './render.mjs';
import { canvasMeasure, forgetMeasurements } from './measure.mjs';
import { buildPptx } from './pptx.mjs';
import { buildHtml } from './export-html.mjs';
import { importBrandFile, kitValues } from './brand-import.mjs';
import { differing, readDrafts, writeDrafts, sortDrafts, withoutWritten } from './drafts.mjs';
import { installFocusRing } from './kit/nendo-view-kit.js';

const nendo = window.nendo;
const $ = id => document.getElementById(id);
const SKILL = 'skill://dev.nendo.deck/deck/SKILL.md';

// Everything the probes read is on window.deck.
const deck = window.deck = {
  ready: false, decks: [], templates: [], brands: [], slides: [], asks: [], variants: [],
  deckId: null, slideId: null, scope: 'Whole deck', tab: 'slide', theme: null, media: new Map(),
  pending: new Map(), held: [], problem: null, toolbars: 0, exports: [], presenting: false, canAsk: false, chrome: false,
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
const visibleSlides = () => deck.slides;
const currentSlide = () => deck.slides.find(s => s.id === deck.slideId) ?? deck.slides[0] ?? null;
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
export function templateSpec(record) {
  if (!record) return TEMPLATES[0];
  const fam = String(v(record, F.template.family) ?? 'Keynote').toLowerCase();
  const hex = field => normalHex(v(record, field));
  return {
    id: record.recordId, family: fam, name: v(record, F.template.name) ?? 'Template',
    colors: { bg: hex(F.template.background), surface: hex(F.template.surface), ink: hex(F.template.ink), muted: hex(F.template.muted),
      primary: hex(F.template.primary), secondary: hex(F.template.secondary), accent: hex(F.template.accent) },
    fonts: { heading: v(record, F.template.headingFont), body: v(record, F.template.bodyFont) },
  };
}
export function brandSpec(record) {
  if (!record) return null;
  const colors = {};
  for (const role of BRAND_ROLES) { const hex = normalHex(v(record, F.brand[role])); if (hex) colors[role] = hex; }
  return {
    name: v(record, F.brand.name) ?? 'Brand', colors,
    fonts: { heading: v(record, F.brand.headingFont), body: v(record, F.brand.bodyFont), mono: v(record, F.brand.monoFont) },
    logo: v(record, F.brand.logo), logoDark: v(record, F.brand.logoDark),
  };
}

/** Every picture address the deck draws, resolved once to a URL the stage can show. */
async function resolveMedia() {
  const addresses = new Set();
  for (const s of deck.slides) if (s.image) addresses.add(s.image);
  for (const variant of deck.variants) { try { const c = JSON.parse(v(variant, F.variant.changes) ?? '{}'); if (c.image) addresses.add(c.image); } catch { /* shown as text */ } }
  const brand = deck.theme?.brand;
  if (brand?.logo) addresses.add(brand.logo);
  if (brand?.logoDark) addresses.add(brand.logoDark);
  for (const b of deck.brands) for (const f of [F.brand.logo, F.brand.logoDark]) if (v(b, f)) addresses.add(v(b, f));
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
function laid(slide, theme = deck.theme, editing = true, number = null) {
  const n = number ?? numberOf(slide);
  const key = JSON.stringify([slide.layout, slide.title, slide.kicker, slide.body, slide.body2, slide.image, slide.chart, slide.imageAlt, slide.notes, n, editing, theme]);
  let hit = laidCache.get(key);
  if (!hit) {
    if (laidCache.size > 600) laidCache.clear();
    hit = layoutSlide(slide, theme, { measure: canvasMeasure, number: n, total: deck.slides.length, editing });
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
  $('deck-title').textContent = d ? v(d, F.deck.title) ?? 'Untitled deck' : 'Deck';
  $('deck-count').textContent = d ? `${deck.slides.length} ${deck.slides.length === 1 ? 'slide' : 'slides'} · ${deck.theme.name}${deck.theme.brand ? ' · ' + deck.theme.brand.name : ''}` : 'No deck yet';
  drawSorter();
  drawStage();
  drawInspector();
  drawVariants();
  drawAsk();
  drawHeld();
  declareToolbar();
}

function drawSorter() {
  const list = $('slides');
  const width = Math.max(90, list.clientWidth - 34 || 150);
  const variantsBySlide = proposedBySlide();
  list.replaceChildren(...deck.slides.map((slide, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.dataset.id = slide.id;
    li.setAttribute('aria-selected', String(slide.id === deck.slideId));
    li.setAttribute('aria-label', `Slide ${i + 1}: ${slide.title || slide.layout}${slide.hidden ? ', hidden' : ''}`);
    li.draggable = true;
    li.classList.toggle('hidden-slide', slide.hidden);
    const count = variantsBySlide.get(slide.id)?.length ?? 0;
    li.classList.toggle('has-variants', count > 0);
    const num = document.createElement('span'); num.className = 'num'; num.textContent = String(i + 1);
    const thumb = scaled(laid(slide, deck.theme, false), width);
    if (count) thumb.dataset.variants = String(count);
    li.append(num, thumb);
    return li;
  }));
  list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}

function drawStage() {
  const stage = $('stage'), wrap = $('stage-wrap');
  const slide = currentSlide();
  if (!slide) { stage.replaceChildren(); stage.style.width = '0px'; $('fit-warning').hidden = true; return; }
  const l = laid(slide);
  const availW = wrap.clientWidth - 48, availH = wrap.clientHeight - 34;
  const scale = Math.max(0.1, Math.min(availW / l.W, availH / l.H));
  stage.style.width = `${l.W * scale}px`; stage.style.height = `${l.H * scale}px`;
  stage.innerHTML = slideHtml(l, { urlFor, className: 'scaled' });
  stage.firstElementChild.style.transform = `scale(${scale})`;
  deck.stageScale = scale;
  const over = l.items.filter(p => p.type === 'text' && p.overflow && !p.ghost);
  $('fit-warning').hidden = over.length === 0;
  $('fit-warning').textContent = over.length ? `The ${over.map(p => p.role === 'body2' ? 'second column' : p.role).filter((x, i, a) => a.indexOf(x) === i).join(' and ')} is at its smallest size and still runs over. Shorten it, or split the slide.` : '';
}

let drawingInspector = false;
function drawInspector() {
  drawingInspector = true;
  try {
    for (const tab of ['slide', 'design', 'asks']) {
      $(`tab-${tab}`).setAttribute('aria-selected', String(deck.tab === tab));
      $(`pane-${tab}`).hidden = deck.tab !== tab;
    }
    const slide = currentSlide();
    if (deck.tab === 'slide') drawSlidePane(slide);
    if (deck.tab === 'design') drawDesignPane();
    if (deck.tab === 'asks') drawAsksPane();
    const notes = $('notes');
    if (document.activeElement !== notes) notes.value = slide?.notes ?? '';
    notes.disabled = !slide;
  } finally { drawingInspector = false; }
}

const SAMPLE = {
  Title: { title: 'Title', kicker: 'Kicker', body: 'Subtitle' }, Section: { title: 'Section', kicker: '01' }, Statement: { title: 'One idea in one sentence' },
  Bullets: { title: 'Title', body: '- Point\n- Point\n- Point' }, 'Two columns': { title: 'Title', body: 'Text on the left', body2: 'Text on the right' },
  Comparison: { title: 'Title', body: '### Before\n- Point\n- Point', body2: '### After\n- Point\n- Point' }, 'Image left': { title: 'Title', body: '- Point\n- Point' },
  'Image right': { title: 'Title', body: '- Point\n- Point' }, 'Full image': { title: 'Title on a picture' }, Quote: { body: 'A line worth quoting.', kicker: 'Someone' },
  'Big numbers': { title: 'Title', body: '- 42% | label\n- 3× | label\n- 12 | label' }, Agenda: { title: 'Agenda', body: '- One\n- Two\n- Three\n- Four' },
  Timeline: { title: 'Title', body: '- 2024 | Start\n- 2025 | Grow\n- 2026 | Lead' }, Cards: { title: 'Title', body: '- One | text\n- Two | text\n- Three | text' },
  Table: { title: 'Title', body: '| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |' }, Chart: { title: 'Title', body: '| A | n |\n| --- | --- |\n| a | 3 |\n| b | 5 |\n| c | 4 |\n| d | 7 |' },
  Closing: { title: 'Thank you', kicker: 'Questions' },
};

function drawSlidePane(slide) {
  const pane = $('pane-slide');
  pane.querySelectorAll('input,textarea,button,select').forEach(el => { el.disabled = !slide; });
  if (!slide) return;
  // The gallery shows each layout drawn with this slide's own words where it has them.
  const gallery = $('layouts');
  const key = JSON.stringify([slide.id, slide.layout, deck.theme, slide.title, slide.kicker].map(String));
  if (gallery.dataset.key !== key) {
    gallery.dataset.key = key;
    gallery.replaceChildren(...LAYOUTS.map(layout => {
      const b = document.createElement('button');
      b.type = 'button'; b.setAttribute('role', 'option'); b.dataset.layout = layout.id;
      b.setAttribute('aria-selected', String(layout.id === slide.layout));
      b.title = `${layout.label}: ${layout.hint}`;
      const sample = { ...SAMPLE[layout.id], layout: layout.id, image: null, chart: 'Column' };
      if (slide.title && layout.uses.includes('title')) sample.title = slide.title;
      const label = document.createElement('span'); label.textContent = layout.label;
      b.append(scaled(layoutSlide(sample, deck.theme, { measure: canvasMeasure, number: null, editing: false }), 84), label);
      return b;
    }));
  }
  const layout = layoutOf(slide.layout);
  $('layout-hint').textContent = layout.hint;
  for (const field of pane.querySelectorAll('.field[data-uses]')) field.hidden = !layout.uses.includes(field.dataset.uses);
  $('l-body').textContent = slide.layout === 'Quote' ? 'Quote' : slide.layout === 'Chart' || slide.layout === 'Table' ? 'Table' : slide.layout === 'Two columns' || slide.layout === 'Comparison' ? 'Left' : 'Body';
  $('l-body2').textContent = slide.layout === 'Chart' ? 'Takeaway' : 'Right';
  for (const input of pane.querySelectorAll('[data-field]')) if (document.activeElement !== input) input.value = slide[input.dataset.field] ?? '';
  $('f-hidden').checked = slide.hidden;
  segmented($('f-chart'), CHARTS.map(c => [c, c]), slide.chart, value => edit({ chart: value }));
  $('clear-image').hidden = !slide.image;
  $('pick-image').textContent = slide.image ? 'Change picture…' : 'Choose picture…';
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
  const tplKey = JSON.stringify([sample.id, sample.title, v(d, F.deck.template), v(d, F.deck.brand), v(d, F.deck.aspect), deck.templates.map(t => t.version), deck.brands.map(b => b.version)]);
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
}
function templateRecordsOrBuiltIns() {
  if (deck.templates.length) return deck.templates.map(r => ({ recordId: r.recordId, spec: templateSpec(r), description: v(r, F.template.description) }));
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
const EDITABLE = ['layout', 'title', 'kicker', 'body', 'body2', 'notes', 'chart', 'image', 'imageAlt', 'hidden'];
// A variant writes words, never a picture: the pictures in a slide are the person's.
const VARIANT_FIELDS = EDITABLE.filter(k => k !== 'image');
/** The slide fields a variant changes, by the slide model's names; anything else is dropped. */
export function pick(changes) {
  const out = {};
  for (const [k, value] of Object.entries(changes ?? {})) {
    const key = k.startsWith('dk.slide.') ? k.slice(9) : k;
    if (!VARIANT_FIELDS.includes(key)) continue;
    if (key === 'layout' && !LAYOUT_IDS.includes(value)) continue;
    if (key === 'chart' && !CHARTS.includes(value)) continue;
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
  chart: F.slide.chart, image: F.slide.image, imageAlt: F.slide.imageAlt, hidden: F.slide.hidden, order: F.slide.order };
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
const redrawSoon = debounce(() => { drawStage(); drawSorter(); if (deck.tab !== 'slide' || !document.activeElement?.dataset?.field) drawInspector(); else drawSlidePaneQuiet(); }, 60);
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

/** A new slide after the current one, ordered between its neighbours. */
async function addSlide(layout = 'Bullets', values = {}) {
  await flushAll();
  const d = currentDeck();
  if (!d) return;
  const at = deck.slides.findIndex(s => s.id === deck.slideId);
  const before = deck.slides[at] ?? deck.slides.at(-1), after = deck.slides[at + 1];
  let order = (before?.order ?? 0) + 10;
  const writes = [];
  if (after && order >= after.order) {
    if (after.order - before.order >= 2) order = Math.floor((before.order + after.order) / 2);
    else {
      // No room: number every slide again, in tens, in the same revision.
      deck.slides.forEach((s, i) => { const o = (i + 1) * 10 + (i > at ? 10 : 0); if (o !== s.order) writes.push({ op: 'update', entityId: E.slide, recordId: s.id, version: s.record.version, values: { [F.slide.order]: o } }); });
      order = (at + 2) * 10;
    }
  }
  const id = newId('slide');
  writes.push({ op: 'create', entityId: E.slide, recordId: id, values: { [F.slide.deck]: d.recordId, [F.slide.order]: order, [F.slide.layout]: layout, [F.slide.hidden]: false, ...toValues(values) }, targetVersions: { [F.slide.deck]: d.version } });
  try {
    await nendo.records.batch(writes, { label: `Add a ${layoutOf(layout).label} slide`, offerUndo: true });
    deck.slideId = id;
    await refresh();
    deck.tab = 'slide'; drawInspector();
    $('f-title').focus();
  } catch (error) { problem(error, 'The slide could not be added'); }
}

async function duplicateSlide() {
  const s = currentSlide(); if (!s) return;
  const copy = Object.fromEntries(EDITABLE.filter(k => k !== 'hidden').map(k => [k, s[k] ?? '']));
  await addSlide(s.layout, copy);
}

async function deleteSlide() {
  await flushAll();
  const s = currentSlide(); if (!s) return;
  const at = deck.slides.indexOf(s);
  const writes = deck.variants.filter(x => v(x, F.variant.slide) === s.id).map(x => ({ op: 'delete', entityId: E.variant, recordId: x.recordId, version: x.version }));
  writes.push({ op: 'delete', entityId: E.slide, recordId: s.id, version: s.record.version });
  try {
    await nendo.records.batch(writes, { label: `Delete slide ${at + 1}`, offerUndo: true });
    // Only a slide that is gone lets go of its typing; a refused delete keeps it.
    deck.pending.delete(s.id);
    keepDrafts();
    deck.slideId = deck.slides[at + 1]?.id ?? deck.slides[at - 1]?.id ?? null;
    await refresh();
  } catch (error) { problem(error, 'The slide could not be deleted'); }
}

async function moveSlide(from, to) {
  await flushAll();
  if (to < 0 || to >= deck.slides.length || from === to) return;
  const changes = reorder(deck.slides, from, to);
  const writes = changes.map(c => ({ op: 'update', entityId: E.slide, recordId: c.id, version: deck.slides.find(s => s.id === c.id).record.version, values: { [F.slide.order]: c.order } }));
  try {
    if (writes.length) await nendo.records.batch(writes, { label: 'Move a slide', offerUndo: true });
    await refresh();
  } catch (error) { problem(error, 'The slide could not be moved'); }
}

async function setHidden(hidden) { edit({ hidden }, { now: true }); }

// ---- Pictures ----------------------------------------------------------------------------------

async function putPicture(file, slide = currentSlide()) {
  if (!slide || !file) return;
  if (!/^image\/(png|jpeg|gif|webp|svg\+xml|avif)$/.test(file.type)) { toast(`${file.name} is not a picture Deck can use: PNG, JPEG, GIF, WebP or SVG.`); return; }
  await flushAll();
  try {
    toast(`Putting ${file.name} into the file…`);
    const fresh = await nendo.records.get(E.slide, slide.id);
    const { address } = await nendo.media.put(file, { name: file.name, mediaType: file.type, record: { entityId: E.slide, recordId: slide.id, version: fresh.version }, fieldId: F.slide.image });
    if (!layoutOf(slide.layout).uses.includes('image')) {
      const record = await nendo.records.get(E.slide, slide.id);
      await nendo.records.update({ entityId: E.slide, recordId: slide.id, version: record.version }, { [F.slide.layout]: 'Image right' });
    }
    deck.media.delete(address);
    await refresh();
    toast(`${file.name} is on slide ${deck.slides.indexOf(currentSlide()) + 1}.`);
  } catch (error) { problem(error, 'The picture could not be put in the file'); }
}

// ---- Brand kits --------------------------------------------------------------------------------

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

async function htmlDocument({ embedded = false, start = 0, leftOut = [] } = {}) {
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
  return buildHtml({ title: v(d, F.deck.title) ?? 'Deck', author: v(d, F.deck.author) ?? '', W, H, theme: deck.theme, start, embedded,
    slides: laidSlides.map((l, i) => ({ html: slideHtml(l, { urlFor: a => urls.get(a) ?? null }), notes: shown[i].notes, title: shown[i].title || shown[i].layout })) });
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
  const slides = deck.slides.map((s, i) => ({ laid: laid(s, deck.theme, false, numberOf(s)), hidden: s.hidden, i }));
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
async function present(fromHere = false) {
  await flushAll();
  const shown = deck.slides.filter(s => !s.hidden);
  if (!shown.length) { toast('There is no slide to show: every slide is hidden.'); return; }
  const start = fromHere ? Math.max(0, shown.findIndex(s => s.id === deck.slideId)) : 0;
  if (presentUrl) URL.revokeObjectURL(presentUrl);
  presentUrl = URL.createObjectURL(new Blob([await htmlDocument({ embedded: true, start })], { type: 'text/html' }));
  const overlay = $('present');
  overlay.hidden = false;
  deck.presenting = true;
  $('present-frame').src = presentUrl;
  overlay.requestFullscreen?.().catch(() => {});
  $('present-frame').addEventListener('load', () => $('present-frame').contentWindow?.focus(), { once: true });
}
function stopPresenting(index) {
  $('present').hidden = true;
  deck.presenting = false;
  $('present-frame').src = 'about:blank';
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  const shown = deck.slides.filter(s => !s.hidden);
  if (Number.isInteger(index) && shown[index]) select(shown[index].id);
  $('slides').focus();
}
addEventListener('message', event => {
  if (event.source !== $('present-frame').contentWindow || !event.data) return;
  if (event.data.deck === 'close') stopPresenting(event.data.index);
});
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && deck.presenting) { /* stays in the frame */ } });

// ---- Selection, places, commands ---------------------------------------------------------------

function select(id, { place = true } = {}) {
  if (!deck.slides.some(s => s.id === id)) return;
  save.flush();
  deck.slideId = id;
  drawSorter(); drawStage(); drawInspector(); drawVariants();
  if (place && nendo.has('ui.setPlace')) nendo.ui.setPlace?.({ deck: deck.deckId, slide: id }, { label: `Slide ${deck.slides.findIndex(s => s.id === id) + 1}`, replace: true })?.catch?.(() => {});
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
    if (id === 'slide.duplicate') return duplicateSlide();
    if (id === 'slide.delete') return deleteSlide();
    if (id === 'slide.hide') return setHidden(!currentSlide()?.hidden);
    if (id === 'slide.up') return moveSlide(deck.slides.indexOf(currentSlide()), deck.slides.indexOf(currentSlide()) - 1);
    if (id === 'slide.down') return moveSlide(deck.slides.indexOf(currentSlide()), deck.slides.indexOf(currentSlide()) + 1);
    if (id === 'present') return present(false);
    if (id === 'present.here') return present(true);
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
  items.push({ kind: 'button', id: 'new-deck', label: 'New deck', icon: 'plus' });
  items.push({ kind: 'separator' });
  items.push({ kind: 'menu', id: 'add', label: 'Add slide', icon: 'layout', disabled: !d, items: LAYOUTS.map((l, i) => ({ id: `add.${i}`, label: l.label, detail: l.hint.slice(0, 120) })) });
  items.push({ kind: 'menu', id: 'slide', label: 'Slide', icon: 'more', disabled: !s, items: [
    { id: 'slide.duplicate', label: 'Duplicate' },
    { kind: 'check', id: 'slide.hide', label: 'Hide when presenting', checked: !!s?.hidden },
    { kind: 'separator' },
    { id: 'slide.up', label: 'Move up', icon: 'arrowUp' },
    { id: 'slide.down', label: 'Move down', icon: 'arrowDown' },
    { kind: 'separator' },
    { id: 'slide.delete', label: 'Delete slide', icon: 'trash', danger: true },
  ] });
  items.push({ kind: 'spacer' });
  items.push({ kind: 'menu', id: 'export', label: 'Export', icon: 'export', disabled: !s, items: [
    { id: 'export.pptx', label: 'PowerPoint (.pptx)', detail: 'Editable slides, speaker notes and the theme' },
    { id: 'export.html', label: 'HTML (one file)', detail: 'Plays in any browser; P for presenter view, Ctrl P for PDF' },
    { id: 'export.notes', label: 'Speaker notes (.md)' },
  ] });
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
  bar.replaceChildren(...items.filter(i => i.kind !== 'separator').map(item => {
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
  const list = $('slides');
  list.addEventListener('click', e => { const li = e.target.closest('li[data-id]'); if (li) select(li.dataset.id); });
  list.addEventListener('dblclick', e => { const li = e.target.closest('li[data-id]'); if (li) present(true); });
  list.addEventListener('keydown', e => {
    const i = deck.slides.findIndex(s => s.id === deck.slideId);
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); if (e.ctrlKey) moveSlide(i, i + 1); else select(deck.slides[Math.min(i + 1, deck.slides.length - 1)]?.id); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); if (e.ctrlKey) moveSlide(i, i - 1); else select(deck.slides[Math.max(i - 1, 0)]?.id); }
    else if (e.key === 'Home') select(deck.slides[0]?.id);
    else if (e.key === 'End') select(deck.slides.at(-1)?.id);
    else if (e.key === 'Delete') deleteSlide();
    else if (e.key === 'Enter') addSlide(currentSlide()?.layout === 'Section' ? 'Bullets' : currentSlide()?.layout ?? 'Bullets');
    else if (e.key === 'd' && e.ctrlKey) { e.preventDefault(); duplicateSlide(); }
  });
  // Drag a thumbnail to move the slide.
  let dragging = null;
  list.addEventListener('dragstart', e => { const li = e.target.closest('li[data-id]'); if (!li) return; dragging = li.dataset.id; li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragging); });
  list.addEventListener('dragover', e => {
    if (!dragging) return;
    e.preventDefault();
    list.querySelectorAll('.drop-before').forEach(x => x.classList.remove('drop-before'));
    const li = e.target.closest('li[data-id]'); if (li) li.classList.add('drop-before');
  });
  list.addEventListener('dragend', () => { dragging = null; list.querySelectorAll('.dragging,.drop-before').forEach(x => x.classList.remove('dragging', 'drop-before')); });
  list.addEventListener('drop', e => {
    if (!dragging) return;
    e.preventDefault();
    const li = e.target.closest('li[data-id]');
    const from = deck.slides.findIndex(s => s.id === dragging);
    let to = li ? deck.slides.findIndex(s => s.id === li.dataset.id) : deck.slides.length - 1;
    // Before a thumbnail, a later one counts the moved slide out; below the list is simply the end.
    if (li && to > from) to -= 1;
    dragging = null;
    moveSlide(from, to);
  });
  $('add-slide').addEventListener('click', async e => {
    if (!deck.chrome || !nendo.has('ui.showMenu')) return addSlide('Bullets');
    const r = e.currentTarget.getBoundingClientRect();
    const picked = await nendo.ui.showMenu(LAYOUTS.map((l, i) => ({ id: `add.${i}`, label: l.label })), { x: r.left, y: r.top }).catch(() => null);
    if (picked?.id) command(picked.id); else if (picked === null) { /* dismissed */ }
  });

  // The stage: a click on text goes to its field; a picture dropped on it goes into the slide.
  const stage = $('stage');
  stage.addEventListener('click', e => {
    const role = e.target.closest('[data-role]')?.dataset.role;
    const field = { title: 'f-title', kicker: 'f-kicker', body: 'f-body', body2: 'f-body2', image: 'pick-image', hint: 'pick-image' }[role];
    if (!field) return;
    deck.tab = 'slide'; drawInspector();
    const el = $(field); if (!el.closest('[hidden]')) { el.focus(); if (field === 'pick-image') $('image-file').click(); }
  });
  for (const target of [$('stage-wrap')]) {
    target.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); stage.classList.add('drop'); } });
    target.addEventListener('dragleave', () => stage.classList.remove('drop'));
    target.addEventListener('drop', e => { if (!e.dataTransfer.files.length) return; e.preventDefault(); stage.classList.remove('drop'); putPicture(e.dataTransfer.files[0]); });
  }
  new ResizeObserver(() => drawStage()).observe($('stage-wrap'));
  new ResizeObserver(debounce(() => drawSorter(), 120)).observe($('slides'));

  // The inspector.
  for (const tab of ['slide', 'design', 'asks']) $(`tab-${tab}`).addEventListener('click', () => { deck.tab = tab; drawInspector(); });
  $('layouts').addEventListener('click', e => { const b = e.target.closest('[data-layout]'); if (b) edit({ layout: b.dataset.layout }, { now: true }); });
  for (const input of document.querySelectorAll('#pane-slide [data-field]')) {
    input.addEventListener('input', () => { if (!drawingInspector) edit({ [input.dataset.field]: input.value }); });
    input.addEventListener('blur', () => save.flush());
  }
  $('notes').addEventListener('input', () => edit({ notes: $('notes').value }));
  $('notes').addEventListener('blur', () => save.flush());
  $('f-hidden').addEventListener('change', () => setHidden($('f-hidden').checked));
  $('pick-image').addEventListener('click', () => $('image-file').click());
  $('image-file').addEventListener('change', () => { const f = $('image-file').files[0]; $('image-file').value = ''; if (f) putPicture(f); });
  $('clear-image').addEventListener('click', () => edit({ image: '' }, { now: true }));
  $('templates').addEventListener('click', e => { const b = e.target.closest('[data-template]'); if (b && b.dataset.template) editDeck({ template: b.dataset.template }); });
  $('brands').addEventListener('click', e => {
    const open = e.target.closest('[data-open]');
    if (open) { nendo.ui.openRecord(E.brand, open.dataset.open).catch(err => problem(err, 'The kit could not be opened')); return; }
    const b = e.target.closest('[data-brand]'); if (b) editDeck({ brand: b.dataset.brand || null });
  });
  $('import-brand').addEventListener('click', () => $('brand-file').click());
  $('brand-file').addEventListener('change', () => { const f = $('brand-file').files[0]; $('brand-file').value = ''; if (f) importBrand(f); });
  const inspector = $('inspector');
  inspector.addEventListener('dragover', e => { if (deck.tab === 'design' && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); inspector.classList.add('drop'); } });
  inspector.addEventListener('dragleave', () => inspector.classList.remove('drop'));
  inspector.addEventListener('drop', e => { if (deck.tab !== 'design' || !e.dataTransfer.files.length) return; e.preventDefault(); inspector.classList.remove('drop'); importBrand(e.dataTransfer.files[0]); });
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
    if (deck.presenting) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '');
    if (e.key === 'F5' && !deck.chrome) { e.preventDefault(); present(e.shiftKey); }
    if (typing) return;
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
const chosenStartTemplate = () => $('start-templates').dataset.chosen || deck.templates[0]?.recordId || null;

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
