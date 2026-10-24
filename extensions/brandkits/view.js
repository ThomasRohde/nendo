// Brandkits: a brand kit drawn as one brand board, made with the person's launched agent. It
// reads and writes only through window.nendo. The agent's work arrives as records (the Kit's
// own fields, Colours, Typefaces, Logos, Samples, and Variants of an Ask), and this view draws
// them as they land. It works out every contrast ratio itself, by WCAG 2.2.
import {
  createAsker, refusalText, isRefusal, selectionChip, selectionIds, parseWrites, applyWrites,
  prepareBatch, variantStrip, keyOf,
} from './ask-kit.js';
import { normalHex, ratio, shown, grade, inkOn } from './contrast.js';
import { designBundle } from './design-bundle.js';
import { zip } from './zip.js';
import { kitDesign, readChoices, SLIDE_PICTURE_FIELDS, FAMILIES, BACKGROUNDS, PLACEMENTS, KICKERS, CORNERS, WEIGHTS } from './slides.js';
import { layoutSlide } from './deck/layout.mjs';
import { resolveTheme } from './deck/themes.mjs';
import { slideHtml, SLIDE_CSS } from './deck/render.mjs';
import { canvasMeasure, forgetMeasurements } from './deck/measure.mjs';
import { designSpecs, writeDesignPackage, designFileName } from './deck/design.mjs';

const $ = id => document.getElementById(id);
const EXAMPLE = 'A brand kit for a small coffee roaster in Aarhus';
const LIVE = ['Waiting', 'Working'];
const FINISHED = ['Done', 'Failed', 'Cancelled', 'Variants ready'];
const PARTS = ['colour', 'typeface', 'logo', 'sample'];
const KIT_FIELD = { colour: 'colourKit', typeface: 'typeKit', logo: 'logoKit', sample: 'sampleKit' };
const ORDER_FIELD = { colour: 'colourOrder', logo: 'logoOrder', sample: 'sampleOrder' };
const NAME_FIELD = { kit: 'kitName', colour: 'colourName', typeface: 'typeFamily', logo: 'logoName', sample: 'sampleName' };
const TYPE_ROLES = ['Display', 'Heading', 'Body', 'Mono'];
const SURFACE_ROLES = ['Background', 'Neutral', 'Primary', 'Secondary'];
const SAMPLE_REFS = ['sampleBackground', 'sampleInk', 'sampleAccent'];
const FALLBACK = { Display: 'Georgia, serif', Heading: 'Georgia, serif', Body: '"Segoe UI", system-ui, sans-serif', Mono: '"Cascadia Mono", Consolas, monospace' };

const S = {
  context: null, readOnly: false, kits: [], kitId: null,
  records: new Map(),            // the kit and its colours, typefaces, logos and samples, by keyOf
  asks: [], variants: [], variantAsk: null, matrix: false,
  selection: new Set(),          // keys of selected parts; kit/<id> is the kit's own words
  hover: null,                   // the variant shown on the board
  known: null,                   // keys drawn so far, to fade in new ones
  references: {}, agent: null, note: null, busy: false, target: 'AA',
  variantErrors: new Map(),
  slides: false,                 // the file has the kit's slide fields (kitSlides and its pictures)
  media: new Map(),              // a picture's address → the URL an <img> shows it at
};

// ---------- records

const kit = () => S.kits.find(k => k.recordId === S.kitId) ?? null;
const newId = entityId => `${entityId.slice(0, 1)}-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
const byKey = key => S.records.get(key) ?? null;
const str = value => String(value ?? '');

async function loadSchema() {
  const schema = await nendo.schema.describe();
  S.references = {};
  S.slides = schema.entities.some(e => e.entityId === 'kit' && e.fields.some(f => f.fieldId === 'kitSlides'));
  for (const entity of schema.entities) {
    S.references[entity.entityId] = {};
    for (const field of entity.fields) if (field.reference) S.references[entity.entityId][field.fieldId] = field.reference.targetEntityId;
  }
}

async function load() {
  S.kits = await nendo.records.queryAll({ entityId: 'kit', sortFieldId: 'kitName' });
  if (!S.kits.some(k => k.recordId === S.kitId)) S.kitId = S.kits[0]?.recordId ?? null;
  const records = new Map();
  S.asks = []; S.variants = []; S.variantAsk = null;
  const current = kit();
  if (current) {
    records.set(keyOf('kit', current.recordId), current);
    const on = fieldId => [{ fieldId, operator: 'eq', value: current.recordId }];
    const [parts, asks] = await Promise.all([
      Promise.all(PARTS.map(entityId => nendo.records.queryAll({ entityId, filters: on(KIT_FIELD[entityId]) }))),
      nendo.records.query({ entityId: 'ask', filters: on('askKit'), sortFieldId: 'askAsked', descending: true, limit: 20 }),
    ]);
    for (const record of parts.flat()) records.set(keyOf(record.entityId, record.recordId), record);
    const asked = ask => Date.parse(ask.values.askAsked ?? '') || 0;
    S.asks = asks.items.sort((a, b) => asked(b) - asked(a));
    S.variantAsk = S.asks.find(a => a.values.askState === 'Variants ready') ?? null;
    if (S.variantAsk) S.variants = (await nendo.records.queryAll({ entityId: 'variant', filters: [{ fieldId: 'variantAsk', operator: 'eq', value: S.variantAsk.recordId }] }))
      .filter(v => (v.values.variantStatus ?? 'Proposed') === 'Proposed');
  }
  S.records = records;
  if (current) await Promise.all(Object.values(SLIDE_PICTURE_FIELDS).map(f => current.values[f]).filter(a => a && !S.media.has(a)).map(async address => {
    try { S.media.set(address, await nendo.media.urlFor(address)); } catch { S.media.set(address, null); }
  }));
  for (const key of [...S.selection]) if (!records.has(key)) S.selection.delete(key);
  if (S.hover && !S.variants.some(v => v.recordId === S.hover.id)) S.hover = null;
}

/** Fills what a create made by the agent or the view may leave out. */
function fill(entityId, values) {
  const field = KIT_FIELD[entityId];
  if (field && !values[field]) values[field] = S.kitId;
  if (entityId === 'colour') { if (!values.colourRole) values.colourRole = 'Neutral'; if (values.colourHex) values.colourHex = normalHex(values.colourHex) ?? values.colourHex; }
  if (entityId === 'typeface' && !values.typeRole) values.typeRole = 'Body';
  if (entityId === 'logo' && !values.logoKind) values.logoKind = 'Primary';
  if (entityId === 'sample' && !values.sampleKind) values.sampleKind = 'Card';
  return values;
}
const references = entityId => S.references[entityId] ?? {};

async function batch(writes, label, undo = true) {
  if (S.readOnly) { flash('This file takes no edits.'); return null; }
  try { return await nendo.records.batch(writes, { label: label.slice(0, 80), offerUndo: undo }); }
  catch (error) { flash(error.code === 'record-version-conflict' ? 'Someone changed that just now. Try again.' : error.message); return null; }
}

// ---------- the kit as the board draws it

/** The kit's parts from a map of records, in the order the board shows them. */
function modelOf(records) {
  const all = [...records.values()];
  const of = entityId => all.filter(r => r.entityId === entityId);
  const byOrder = field => (a, b) => Number(a.values[field] ?? 0) - Number(b.values[field] ?? 0) || str(a.values[NAME_FIELD[a.entityId]]).localeCompare(str(b.values[NAME_FIELD[b.entityId]]));
  const colours = of('colour').sort(byOrder('colourOrder'));
  const typefaces = of('typeface').sort((a, b) => TYPE_ROLES.indexOf(a.values.typeRole) - TYPE_ROLES.indexOf(b.values.typeRole));
  const logos = of('logo').sort(byOrder('logoOrder'));
  const samples = of('sample').sort(byOrder('sampleOrder'));
  const k = of('kit')[0] ?? null;
  const hexOf = r => normalHex(r?.values.colourHex);
  const valid = colours.filter(hexOf);
  const role = name => valid.find(c => c.values.colourRole === name) ?? null;
  const lum = c => ratio(hexOf(c), '#000000');
  const lightest = [...valid].sort((a, b) => lum(b) - lum(a))[0] ?? null;
  const darkest = [...valid].sort((a, b) => lum(a) - lum(b))[0] ?? null;
  const background = role('Background') ?? lightest;
  const text = role('Text') ?? (darkest !== background ? darkest : null);
  const face = name => typefaces.find(t => t.values.typeRole === name) ?? null;
  const fonts = {
    display: face('Display') ?? face('Heading'), heading: face('Heading') ?? face('Display'),
    body: face('Body') ?? face('Heading'), mono: face('Mono'),
  };
  return { kit: k, colours, typefaces, logos, samples, background, text, fonts, hexOf,
    bg: hexOf(background) ?? '#FFFFFF', ink: hexOf(text) ?? inkOn(hexOf(background) ?? '#FFFFFF'),
    primaryLogo: logos.find(l => l.values.logoKind === 'Primary') ?? logos[0] ?? null,
    colour: id => colours.find(c => c.recordId === id) ?? null, logo: id => logos.find(l => l.recordId === id) ?? null };
}

function stackOf(typeface, roleName = 'Body') {
  if (!typeface) return FALLBACK[roleName];
  const family = str(typeface.values.typeFamily).replace(/["\\;{}]/g, '').trim();
  const stack = str(typeface.values.typeStack).replace(/[;{}\\]/g, '').trim() || FALLBACK[typeface.values.typeRole] || FALLBACK.Body;
  return family ? `"${family}", ${stack}` : stack;
}
const weightOf = (typeface, otherwise = 400) => Math.min(900, Math.max(100, Number(typeface?.values.typeWeight) || otherwise));

// Google Fonts, where the family is one: a link per family, plain family name if the weights fail.
const fontLinks = new Map();
function loadFonts(typefaces) {
  for (const t of typefaces) {
    const family = str(t.values.typeFamily).trim();
    if (!/^[A-Za-z0-9 ]{2,60}$/.test(family) || fontLinks.has(family)) continue;
    const weights = [...new Set([400, 700, weightOf(t)])].sort((a, b) => a - b).join(';');
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    const base = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}`;
    link.href = `${base}:wght@${weights}&display=swap`;
    link.onerror = () => { if (!link.dataset.plain) { link.dataset.plain = '1'; link.href = `${base}&display=swap`; } };
    fontLinks.set(family, link);
    document.head.append(link);
  }
}

/** A logo's SVG as an image address. An <img> never runs what an SVG carries. */
function logoUrl(logo) {
  let svg = str(logo?.values.logoSvg).trim();
  if (!/^<svg[\s>]/i.test(svg.replace(/^<\?xml[^>]*>\s*/i, ''))) return null;
  if (!/xmlns=/.test(svg)) svg = svg.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

// ---------- drawing

function h(tag, attributes = {}, ...children) {
  const item = document.createElement(tag);
  for (const [k, v] of Object.entries(attributes)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'style' && typeof v === 'object') Object.assign(item.style, v);
    else if (k === 'class') item.className = v;
    else item.setAttribute(k, v === true ? '' : String(v));
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) item.append(child instanceof Node ? child : String(child));
  return item;
}

function gradeChip(label, value, kind = 'text') {
  const g = grade(value, S.target);
  const pass = kind === 'ui' ? g.large : g.pass;
  const cls = pass ? 'pass' : (kind === 'text' && g.large) ? 'large' : 'fail';
  return h('span', { class: `grade ${cls}`, title: kind === 'ui' ? 'Buttons and graphics need 3:1' : 'Body text needs 4.5:1 (AA) or 7:1 (AAA); large text 3:1' },
    label, h('b', {}, `${shown(value)} ${g.label}`));
}

/** Marks: {selected, working, enter, added, changed, interactive}. */
function pick(tag, key, marks, attributes, ...children) {
  const classes = ['pick', attributes.class ?? '', marks.selected?.has(key) && 'selected', marks.working?.has(key) && 'working',
    marks.enter?.has(key) && 'enter', marks.added?.has(key) && 'added', marks.changed?.has(key) && 'changed'].filter(Boolean).join(' ');
  return h(tag, { ...attributes, class: classes, 'data-key': marks.interactive ? key : undefined, tabindex: marks.interactive ? 0 : undefined,
    role: marks.interactive ? 'button' : undefined, 'aria-pressed': marks.interactive ? String(Boolean(marks.selected?.has(key))) : undefined }, ...children);
}

// The brand board: the whole kit on one screen, in tiles sized by what matters most.
const ROLE_WEIGHT = { Primary: 3, Background: 3, Text: 2, Secondary: 2, Accent: 1.5, Neutral: 1.3 };
const shortGrade = value => `${shown(value)} ${grade(value, S.target).label}`;

function tile(area, title, note, ...children) {
  return h('section', { class: `tile t-${area}`, 'aria-label': title },
    title ? h('div', { class: 'tile-head' }, h('h2', {}, title), note ? h('span', {}, note) : null) : null, ...children);
}
function emptyTile(text) { return h('p', { class: 'tile-empty' }, text); }

/** The hero's colours: the Primary when the kit's light colour reads on it, else the background. */
function heroColours(m) {
  const primary = m.colours.find(c => c.values.colourRole === 'Primary' && m.hexOf(c));
  if (primary) {
    const hex = m.hexOf(primary);
    const ink = [m.bg, m.ink, '#FFFFFF', '#000000'].sort((a, b) => (ratio(b, hex) ?? 0) - (ratio(a, hex) ?? 0))[0];
    if ((ratio(ink, hex) ?? 0) >= 4.5) return { back: hex, ink, dark: true };
  }
  return { back: m.bg, ink: m.ink, dark: false };
}

function paintBoard(host, m, marks) {
  host.replaceChildren();
  if (!m.kit) return;
  loadFonts(m.typefaces);
  const kitKey = keyOf('kit', m.kit.recordId);
  const v = m.kit.values;
  const heading = stackOf(m.fonts.heading, 'Heading'), body = stackOf(m.fonts.body, 'Body'), display = stackOf(m.fonts.display, 'Display');
  const bgName = str(m.background?.values.colourName) || 'background';
  const grid = h('div', { class: 'bento' });
  host.append(grid);

  // Hero: the brand at a glance, on its own colour.
  const hero = heroColours(m);
  const heroLogo = (hero.dark ? m.logos.find(l => l.values.logoKind === 'Reversed' && logoUrl(l)) : null) ?? (hero.dark ? null : m.primaryLogo);
  const heroSrc = logoUrl(heroLogo);
  const traits = str(v.kitPersonality).split(/[,;\n]/).map(t => t.trim()).filter(Boolean).slice(0, 6);
  grid.append(pick('section', kitKey, marks, { class: 'tile t-hero hero', style: { background: hero.back, color: hero.ink }, 'aria-label': `Kit: ${str(v.kitName)}` },
    heroSrc ? h('img', { class: 'hero-logo', src: heroSrc, alt: str(heroLogo.values.logoName) }) : h('div', { class: 'hero-name', style: { fontFamily: heading } }, str(v.kitName) || 'Untitled kit'),
    h('div', { class: 'hero-words' },
      h('div', { class: 'hero-line', style: { fontFamily: display, fontWeight: weightOf(m.fonts.display, 800) } }, str(v.kitTagline) || str(v.kitName) || 'Untitled kit'),
      traits.length ? h('div', { class: 'traits', style: { fontFamily: body } }, traits.map(t => h('span', {}, t))) : null)));

  // Palette: a tile per colour, wider for the colours used most.
  const palette = h('div', { class: 'palette' }, m.colours.map(c => {
    const hex = m.hexOf(c);
    const role = str(c.values.colourRole);
    const isBg = c === m.background;
    const value = !hex ? null : isBg ? ratio(m.ink, hex) : ratio(hex, m.bg);
    const kind = isBg || role === 'Text' ? 'text' : 'ui';
    const g = grade(value, S.target);
    const pass = isBg || role === 'Neutral' || (kind === 'ui' ? g.large : g.pass);
    const line = !hex ? 'Not a hex colour' : isBg ? `${str(m.text?.values.colourName) || 'Text'} on it ${shortGrade(value)}` : `On ${bgName} ${shortGrade(value)}`;
    const ink = hex ? inkOn(hex) : 'inherit';
    return pick('article', keyOf('colour', c.recordId), marks, {
      class: `swatch${hex ? '' : ' invalid'}${hex && !pass ? ' failing' : ''}`, style: { flexGrow: String(ROLE_WEIGHT[role] ?? 1.15), ...(hex ? { background: hex, color: ink } : {}) },
      title: `${str(c.values.colourName)} ${hex ?? ''}${c.values.colourUsage ? `\n${str(c.values.colourUsage)}` : ''}\n${line}`, 'aria-label': `Colour: ${str(c.values.colourName)} ${str(c.values.colourHex)}` },
      h('span', { class: 'role' }, role || 'Colour'),
      h('span', { class: 'meta' }, h('b', { class: 'name' }, str(c.values.colourName) || 'Unnamed'), h('span', { class: 'hex' }, hex ?? str(c.values.colourHex)),
        h('span', { class: 'ratio' }, line)));
  }));
  grid.append(tile('palette', 'Colours', `${m.colours.length} · contrast by WCAG 2.2, worked out here`, m.colours.length ? palette : emptyTile('No colours yet. Ask for a palette.')));

  // Type: one specimen, then a row per typeface.
  const primaryColour = m.colours.find(c => c.values.colourRole === 'Primary' && m.hexOf(c)) ?? m.colours.find(c => m.hexOf(c));
  const monoLine = primaryColour ? `--brand-${slug(primaryColour.values.colourName)}: ${m.hexOf(primaryColour)};` : 'TICKET 0412 · 12:00';
  const typeRows = m.typefaces.map(t => {
    const role = str(t.values.typeRole) || 'Body';
    const size = Math.min(48, Math.max(11, Number(t.values.typeSize) || { Display: 40, Heading: 26, Body: 16, Mono: 14 }[role] || 16));
    const sample = role === 'Mono' ? monoLine : role === 'Body' ? (str(m.samples.find(s => s.values.sampleBody)?.values.sampleBody) || str(v.kitBrief) || 'The quick brown fox jumps over the lazy dog') : (str(v.kitTagline) || str(v.kitName));
    return pick('div', keyOf('typeface', t.recordId), marks, { class: `typecard r-${role.toLowerCase()}`, 'aria-label': `Typeface: ${role} ${str(t.values.typeFamily)}`, title: str(t.values.typeUsage) },
      h('div', { class: 'specimen', style: { fontFamily: stackOf(t, role), fontWeight: weightOf(t), fontSize: `${role === 'Body' || role === 'Mono' ? Math.min(size, 16) : Math.min(size, 26)}px` } }, sample),
      h('div', { class: 'info' }, h('span', { class: 'tag' }, role), h('b', {}, str(t.values.typeFamily)), `${weightOf(t)} · ${size}px`));
  });
  grid.append(tile('type', null, null, h('div', { class: 'type-inner', style: { background: m.bg, color: m.ink } },
    h('div', { class: 'type-head' }, h('span', { class: 'big', style: { fontFamily: heading, fontWeight: weightOf(m.fonts.heading, 700) } }, 'Aa'),
      h('span', { class: 'tile-note' }, m.typefaces.length ? `${m.typefaces.length} typeface${m.typefaces.length > 1 ? 's' : ''}` : 'No type yet')),
    typeRows.length ? h('div', { class: 'type-rows' }, typeRows) : emptyTile('Ask for a type pair.'))));

  // Logos: each on the plate it is made for, and the mark at the sizes it must read at.
  const darkHex = m.hexOf(m.colours.find(c => c.values.colourRole === 'Primary' && m.hexOf(c))) ?? m.ink;
  const plates = m.logos.slice(0, 4).map(l => {
    const src = logoUrl(l);
    const dark = l.values.logoKind === 'Reversed';
    return pick('div', keyOf('logo', l.recordId), marks, { class: 'logocard', style: { background: dark ? darkHex : m.bg }, title: `${str(l.values.logoName)} · ${str(l.values.logoKind)}${l.values.logoUsage ? `\n${str(l.values.logoUsage)}` : ''}`, 'aria-label': `Logo: ${str(l.values.logoName)}` },
      src ? h('img', { src, alt: str(l.values.logoName) }) : h('span', { class: 'tile-empty' }, 'No SVG yet'));
  });
  const mark = m.logos.find(l => l.values.logoKind === 'Mark' && logoUrl(l)) ?? m.logos.find(l => logoUrl(l));
  const markSrc = logoUrl(mark);
  grid.append(tile('logos', 'Logos', mark ? `${str(mark.values.logoName)} at 16, 32 and 64 px` : null,
    plates.length ? h('div', { class: `plates n${Math.min(plates.length, 4)}` }, plates) : emptyTile('No logos yet. Ask for a mark and a wordmark.'),
    markSrc ? h('div', { class: 'sizes' }, [16, 32, 64].map(px => h('img', { src: markSrc, alt: `${px} px`, style: { width: `${px}px`, height: `${px}px` } }))) : null));

  // Samples: the kit applied, each with the pairs it uses.
  const sampleCards = m.samples.slice(0, 4).map(sample => {
    const sv = sample.values;
    const { back, ink, accent, actionInk } = sampleColours(m, sv);
    const src = logoUrl(m.logo(sv.sampleLogo));
    const isButton = sv.sampleKind === 'Button';
    const action = sv.sampleAction || isButton ? h('span', { class: 'action', style: { background: accent, color: actionInk, fontFamily: body } }, str(sv.sampleAction) || str(sv.sampleHeadline) || 'Continue') : null;
    return pick('article', keyOf('sample', sample.recordId), marks, { class: `sample${isButton ? ' k-button' : ''}`, 'aria-label': `Sample: ${str(sv.sampleName)}` },
      h('div', { class: 'art', style: { background: back, color: ink } },
        !isButton && src ? h('img', { class: 'logo', src, alt: '' }) : null,
        !isButton && sv.sampleHeadline ? h('h3', { style: { fontFamily: heading, fontWeight: weightOf(m.fonts.heading, 700) } }, str(sv.sampleHeadline)) : null,
        !isButton && sv.sampleBody ? h('p', { style: { fontFamily: body } }, str(sv.sampleBody)) : null,
        action),
      h('div', { class: 'foot' }, h('span', { class: 'name' }, str(sv.sampleName) || str(sv.sampleKind)),
        isButton ? null : gradeChip('Text ', ratio(ink, back)),
        action ? gradeChip('Button ', ratio(accent, back), 'ui') : null,
        action ? gradeChip('Label ', ratio(actionInk, accent)) : null));
  });
  grid.append(tile('samples', 'Samples', m.samples.length > 4 ? `4 of ${m.samples.length}` : null,
    sampleCards.length ? h('div', { class: `sample-grid n${sampleCards.length}` }, sampleCards) : emptyTile('No samples yet. Ask for a card, a post and a button.')));

  // Voice: the traits as "this, not that", then do and don't.
  const lines = str(v.kitVoice).split('\n').map(l => l.trim()).filter(Boolean);
  const voiceItems = lines.map(line => {
    const dont = /^(don'?t|don’t|avoid)\b[:\s]/i.test(line), doo = /^do\b[:\s]/i.test(line);
    const text = line.replace(/^(do|don'?t|don’t|avoid)\s*:\s*/i, '');
    if (dont || doo) return h('li', { class: dont ? 'dont' : 'do' }, text);
    const [lead, ...rest] = text.split(/,\s*/);
    return h('li', { class: 'trait' }, h('b', {}, lead), rest.length ? `, ${rest.join(', ')}` : '');
  });
  grid.append(pick('section', kitKey, marks, { class: 'tile t-voice voice', 'aria-label': 'The kit’s voice and words' },
    h('div', { class: 'tile-head' }, h('h2', {}, 'Voice'), v.kitImagery ? h('span', {}, 'and imagery') : null),
    voiceItems.length ? h('ul', { class: 'lines' }, voiceItems) : emptyTile('No voice yet. Select this and ask for one.'),
    v.kitImagery ? h('p', { class: 'imagery' }, str(v.kitImagery)) : null));

  // Contrast: the pairs the kit uses, failures first; the whole matrix on request.
  const used = usedPairs(m);
  const passes = p => p.kind === 'ui' ? grade(p.value, S.target).large : grade(p.value, S.target).pass;
  const failing = used.filter(p => !passes(p));
  const listed = [...failing, ...used.filter(passes).sort((a, b) => a.value - b.value)].slice(0, 6);
  const contrast = h('section', { class: `tile t-contrast contrast${failing.length ? ' bad' : ''}`, 'aria-label': 'Contrast' },
    h('div', { class: 'tile-head' }, h('h2', {}, 'Contrast'), h('span', { class: 'summary' }, used.length
      ? failing.length ? `${failing.length} of ${used.length} pairs in use fail ${S.target}` : `All ${used.length} pairs in use pass ${S.target}`
      : 'No pairs in use yet')),
    h('ul', { class: 'pairs' }, listed.map(p => h('li', { class: passes(p) ? 'ok' : 'no' }, h('span', {}, p.label), h('b', {}, shortGrade(p.value))))));
  const toggle = h('button', { type: 'button', class: 'linkish' }, S.matrix ? 'Hide the full matrix' : 'Every colour on every surface');
  toggle.addEventListener('click', event => { event.stopPropagation(); S.matrix = !S.matrix; render(); });
  contrast.append(toggle);
  grid.append(contrast);

  if (S.slides) host.append(slidesTile(m));

  const valid = m.colours.filter(c => m.hexOf(c));
  if (S.matrix && valid.length >= 2) host.append(h('section', { class: 'matrix', 'aria-label': 'Contrast matrix' },
    h('div', { class: 'tile-head' }, h('h2', {}, 'Every colour on every surface'), h('span', {}, `target ${S.target}: text ${S.target === 'AAA' ? '7' : '4.5'}:1, large text and graphics ${S.target === 'AAA' ? '4.5' : '3'}:1`)),
    contrastTable(m, valid)));
}

/** Every colour on every surface colour. */
function contrastTable(m, valid) {
  const surfaces = valid.filter(c => SURFACE_ROLES.includes(c.values.colourRole)).slice(0, 8);
  if (!surfaces.length) surfaces.push(m.background ?? valid[0]);
  const head = h('tr', {}, h('th', {}, ''), surfaces.map(s => h('th', {}, `on ${str(s.values.colourName)}`)));
  const rows = valid.map(fg => h('tr', {}, h('th', {}, str(fg.values.colourName)), surfaces.map(bg => {
    if (fg === bg) return h('td', {}, h('div', { class: 'cell', style: { background: m.hexOf(bg), color: m.hexOf(fg), opacity: .35 } }, '—'));
    const value = ratio(m.hexOf(fg), m.hexOf(bg));
    const g = grade(value, S.target);
    return h('td', {}, h('div', { class: `cell${g.large ? '' : ' fail'}`, style: { background: m.hexOf(bg), color: m.hexOf(fg) }, title: `${str(fg.values.colourName)} on ${str(bg.values.colourName)}: ${shown(value)}:1, ${g.label}` },
      shown(value), h('small', {}, g.label)));
  })));
  return h('div', { class: 'matrix-scroll' }, h('table', {}, h('thead', {}, head), h('tbody', {}, rows)));
}

/** The pairs the kit puts text or buttons on: text on background, and each sample's. */
function usedPairs(m) {
  const pairs = [];
  if (m.background && m.text) pairs.push({ label: `${str(m.text.values.colourName)} on ${str(m.background.values.colourName)}`, value: ratio(m.ink, m.bg), kind: 'text' });
  for (const sample of m.samples) {
    const sv = sample.values;
    const back = m.colour(sv.sampleBackground), ink = m.colour(sv.sampleInk), accent = m.colour(sv.sampleAccent);
    const name = str(sv.sampleName) || 'a sample';
    if (back && ink && m.hexOf(back) && m.hexOf(ink) && sv.sampleKind !== 'Button') pairs.push({ label: `${name}: text`, value: ratio(m.hexOf(ink), m.hexOf(back)), kind: 'text' });
    if (back && accent && m.hexOf(back) && m.hexOf(accent) && (sv.sampleAction || sv.sampleKind === 'Button')) {
      pairs.push({ label: `${name}: button`, value: ratio(m.hexOf(accent), m.hexOf(back)), kind: 'ui' });
      const drawn = sampleColours(m, sv);
      pairs.push({ label: `${name}: button label`, value: ratio(drawn.actionInk, drawn.accent), kind: 'text' });
    }
  }
  return pairs;
}

/** A sample's colours as its card draws them: the button's label takes whichever of the background and the text reads better on it. */
function sampleColours(m, sv) {
  const back = m.hexOf(m.colour(sv.sampleBackground)) ?? m.bg;
  const ink = m.hexOf(m.colour(sv.sampleInk)) ?? (back === m.bg ? m.ink : inkOn(back));
  const accent = m.hexOf(m.colour(sv.sampleAccent)) ?? m.hexOf(m.colours.find(c => c.values.colourRole === 'Accent' || c.values.colourRole === 'Primary')) ?? ink;
  const actionInk = (ratio(back, accent) ?? 0) >= (ratio(ink, accent) ?? 0) ? back : ink;
  return { back, ink, accent, actionInk };
}

// ---------- the board

const stage = $('stage'), boardHost = $('board');
let renderSeq = 0;
function render() {
  const seq = ++renderSeq;
  let records = S.records, added = new Set(), changed = new Set();
  if (S.hover) { const ghost = ghostOf(S.hover.record); records = ghost.records; added = ghost.created; changed = ghost.updated; }
  const m = modelOf(records);
  const enter = new Set();
  if (!S.hover) {
    const keys = [...S.records.keys()].filter(k => !k.startsWith('kit/'));
    if (S.known) for (const k of keys) if (!S.known.has(k)) enter.add(k);
    S.known = new Set(keys);
  }
  if (seq !== renderSeq) return;
  S.model = m;
  boardHost.classList.toggle('ghost', Boolean(S.hover));
  paintBoard(boardHost, m, { selected: S.hover ? new Set() : S.selection, working: workingKeys(), enter, added, changed, interactive: !S.hover });
}

function workingKeys() {
  const ask = latestAsk();
  if (!ask || !LIVE.includes(ask.values.askState)) return new Set();
  if (ask.values.askScope !== 'Selection') return S.kitId ? new Set([keyOf('kit', S.kitId)]) : new Set();
  return new Set(str(ask.values.askSelection).split('\n').map(line => line.split(' ')).filter(p => p.length > 1).map(([kind, id]) => keyOf(kind, id)).filter(k => S.records.has(k)));
}

boardHost.addEventListener('click', event => {
  if (S.hover) return;
  const item = event.target.closest?.('[data-key]');
  if (!item) { if (S.selection.size) { S.selection.clear(); drawSelection(); } return; }
  const key = item.getAttribute('data-key');
  if (event.shiftKey || event.ctrlKey) { if (S.selection.has(key)) S.selection.delete(key); else S.selection.add(key); }
  else if (!S.selection.has(key) || S.selection.size > 1) { S.selection.clear(); S.selection.add(key); }
  else S.selection.clear();
  drawSelection();
});
boardHost.addEventListener('dblclick', event => {
  const item = event.target.closest?.('[data-key]');
  if (item && !S.hover) { S.selection.clear(); S.selection.add(item.getAttribute('data-key')); drawSelection(); startEdit(item.getAttribute('data-key')); }
});
stage.addEventListener('keydown', event => {
  if (event.target.closest?.('.inline-edit')) return;
  if (event.key === 'Delete' || (event.key === 'Backspace' && !event.target.matches?.('input'))) { event.preventDefault(); removeSelection(); }
  else if (event.key === 'Escape') { S.selection.clear(); drawSelection(); }
  else if (event.key === 'F2' && S.selection.size === 1) startEdit([...S.selection][0]);
  else if ((event.key === 'Enter' || event.key === ' ') && event.target.matches?.('[data-key]')) { event.preventDefault(); event.target.click(); }
});

function drawSelection() {
  for (const item of boardHost.querySelectorAll('[data-key]')) {
    const on = S.selection.has(item.getAttribute('data-key'));
    item.classList.toggle('selected', on);
    item.setAttribute('aria-pressed', String(on));
  }
  drawAskBar();
}

// ---------- editing by hand

let editor = null;
function closeEditor() {
  editor?.remove(); editor = null;
  if (S.pendingRefresh) { S.pendingRefresh = false; refresh(); }
}

function startEdit(key) {
  const record = byKey(key);
  const item = boardHost.querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (!record || !item || S.readOnly) return;
  closeEditor();
  const rect = item.getBoundingClientRect();
  const field = NAME_FIELD[record.entityId];
  const name = h('input', { type: 'text', value: str(record.values[field]), 'aria-label': 'Name', maxlength: 120 });
  const box = h('div', { class: 'inline-edit', style: { left: `${Math.max(8, rect.left)}px`, top: `${Math.max(8, rect.top + 8)}px` } }, name);
  let hex = null, picker = null;
  if (record.entityId === 'colour') {
    hex = h('input', { type: 'text', value: str(record.values.colourHex), 'aria-label': 'Hex', maxlength: 7, size: 8 });
    picker = h('input', { type: 'color', value: normalHex(record.values.colourHex)?.toLowerCase() ?? '#888888', 'aria-label': 'Pick a colour' });
    picker.addEventListener('input', () => { hex.value = picker.value.toUpperCase(); });
    hex.addEventListener('input', () => { const n = normalHex(hex.value); if (n) picker.value = n.toLowerCase(); });
    box.append(hex, picker);
  }
  document.body.append(box);
  editor = box;
  (hex ?? name).focus(); (hex ?? name).select();
  let done = false;
  const finish = async commit => {
    if (done) return; done = true;
    closeEditor(); stage.focus({ preventScroll: true });
    if (!commit) return;
    const values = {};
    const text = name.value.trim();
    if (text !== str(record.values[field])) {
      if (!text && record.entityId !== 'sample') { flash('A name cannot be empty.'); return; }
      values[field] = text || null;
    }
    if (hex) {
      const n = normalHex(hex.value);
      if (!n) { flash(`“${hex.value}” is not a hex colour such as #B4532A.`); return; }
      if (n !== str(record.values.colourHex)) values.colourHex = n;
    }
    if (!Object.keys(values).length) return;
    await batch([{ op: 'update', entityId: record.entityId, recordId: record.recordId, version: record.version, values }],
      `Change ${record.entityId} ${str(values[field] ?? record.values[field])}${values.colourHex ? ` to ${values.colourHex}` : ''}`);
  };
  box.addEventListener('keydown', event => { event.stopPropagation(); if (event.key === 'Enter') finish(true); else if (event.key === 'Escape') finish(false); });
  box.addEventListener('focusout', event => { if (!box.contains(event.relatedTarget)) setTimeout(() => { if (!box.contains(document.activeElement)) finish(true); }, 0); });
}

async function addColour() {
  const k = kit();
  if (!k) { flash('Make a kit first: describe one above, or choose New kit.'); return; }
  const order = Math.max(0, ...[...S.records.values()].filter(r => r.entityId === 'colour').map(r => Number(r.values.colourOrder ?? 0))) + 1;
  const recordId = newId('colour');
  const result = await batch([{ op: 'create', entityId: 'colour', recordId, values: { colourKit: k.recordId, colourName: 'New colour', colourHex: '#888888', colourRole: 'Neutral', colourOrder: order },
    targetVersions: { colourKit: k.version } }], 'Add colour');
  if (result) { S.selection.clear(); S.selection.add(keyOf('colour', recordId)); S.editAfter = keyOf('colour', recordId); }
}

async function removeSelection() {
  if (!S.selection.size || S.hover) return;
  const keys = [...S.selection].filter(k => !k.startsWith('kit/'));
  if (!keys.length) { flash('The kit itself is not deleted here. Delete it from the Kits list.'); return; }
  const gone = new Set(keys);
  const clear = [];
  for (const r of S.records.values()) {
    if (r.entityId !== 'sample' || gone.has(keyOf('sample', r.recordId))) continue;
    const values = {};
    for (const f of SAMPLE_REFS) if (r.values[f] && gone.has(keyOf('colour', r.values[f]))) values[f] = null;
    if (r.values.sampleLogo && gone.has(keyOf('logo', r.values.sampleLogo))) values.sampleLogo = null;
    if (Object.keys(values).length) clear.push({ op: 'update', entityId: 'sample', recordId: r.recordId, version: r.version, values });
  }
  const deletes = keys.map(byKey).filter(Boolean).map(r => ({ op: 'delete', entityId: r.entityId, recordId: r.recordId, version: r.version }));
  const what = keys.length === 1 ? `${byKey(keys[0])?.entityId} ${str(byKey(keys[0])?.values[NAME_FIELD[byKey(keys[0])?.entityId]])}` : `${keys.length} parts`;
  if (await batch([...clear, ...deletes], `Delete ${what}`)) S.selection.clear();
}

async function newKit(name = 'Untitled kit') {
  if (S.readOnly) return null;
  try {
    const created = await nendo.records.create('kit', { kitName: name.slice(0, 80), kitStatus: 'Draft' }, { recordId: newId('kit') });
    S.kitId = created.recordId; S.selection.clear(); S.known = null;
    await refresh();
    place();
    return created;
  } catch (error) { flash(error.message); return null; }
}

// ---------- slides: the kit as Deck draws it

/** The kit as plain values, as slides.js reads it. */
function kitPlain(m) {
  const v = m.kit.values;
  const pictures = {};
  for (const [slot, field] of Object.entries(SLIDE_PICTURE_FIELDS)) if (v[field]) pictures[slot] = { address: v[field], type: 'image/png' };
  return {
    recordId: m.kit.recordId, version: m.kit.version, name: str(v.kitName), tagline: str(v.kitTagline), voice: str(v.kitVoice), personality: str(v.kitPersonality),
    colours: m.colours.map(c => ({ role: str(c.values.colourRole), hex: m.hexOf(c) })),
    typefaces: m.typefaces.map(t => ({ role: str(t.values.typeRole), family: str(t.values.typeFamily) })),
    logos: m.logos.map(l => ({ kind: str(l.values.logoKind), svg: str(l.values.logoSvg) })), pictures,
  };
}
const svgUrl = text => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;

// Slides are fitted with measured text: when a kit's web font arrives the widths measured with the
// fallback are wrong, so they are forgotten and the slides drawn again, as Deck does.
document.fonts?.addEventListener?.('loadingdone', () => {
  forgetMeasurements();
  const tile = document.querySelector('.t-slides');
  if (tile && S.slides) { const m = modelOf(S.records); if (m.kit) tile.replaceWith(slidesTile(m)); }
});
const slideScale = new ResizeObserver(entries => {
  for (const { target } of entries) { const inner = target.firstElementChild; if (inner) inner.style.transform = `scale(${target.clientWidth / Number(inner.dataset.w || 1280)})`; }
});

/** The four slides Deck would draw with this kit, and the choices beside them. */
function slidesTile(m) {
  const kitPlainValues = kitPlain(m);
  const choices = readChoices(m.kit.values.kitSlides);
  const { design, pictures, pictureSlots } = kitDesign(kitPlainValues, choices);
  const urlOf = path => {
    const slot = Object.keys(pictureSlots).find(s => pictureSlots[s] === path);
    if (slot) return S.media.get(kitPlainValues.pictures[slot].address) ?? null;
    return pictures.has(path) ? svgUrl(pictures.get(path)) : null;
  };
  const specs = designSpecs(design, urlOf);
  const theme = resolveTheme(specs.template, specs.brand, { footer: str(m.kit.values.kitName), slideNumbers: true, aspect: '16:9' });
  const v = m.kit.values;
  const traits = str(v.kitPersonality).split(/[,;\n]/).map(t => t.trim()).filter(Boolean).slice(0, 3);
  const examples = [
    { layout: 'Title', kicker: str(v.kitName), title: str(v.kitTagline) || str(v.kitName) || 'Title', body: 'A deck in this kit' },
    { layout: 'Section', kicker: '01', title: 'What we stand for', body: '' },
    { layout: 'Cards', kicker: 'Our voice', title: 'How we sound', body: (traits.length ? traits : ['Clear', 'Kind', 'Exact']).map(t => `- ${t} | ${t} in every line we write.`).join('\n') },
    { layout: 'Chart', kicker: 'Example', title: 'Numbers in our colours', body: '| Quarter | This year | Last year |\n| --- | --- | --- |\n| Q1 | 12 | 9 |\n| Q2 | 15 | 11 |\n| Q3 | 19 | 14 |\n| Q4 | 23 | 16 |', body2: '', chart: 'Column' },
  ];
  if (!document.getElementById('dk-slide-css')) document.head.append(h('style', { id: 'dk-slide-css' }, SLIDE_CSS));
  const shots = examples.map((slide, i) => {
    const laid = layoutSlide({ ...slide, notes: '', image: null }, theme, { measure: canvasMeasure, number: i + 1, editing: false });
    const box = h('div', { class: 'slide-shot', 'aria-label': `${slide.layout} slide` });
    box.innerHTML = slideHtml(laid, { urlFor: src => src });
    const inner = box.firstElementChild;
    if (inner) { inner.style.transformOrigin = '0 0'; inner.dataset.w = String(laid.W); }
    box.style.aspectRatio = `${laid.W} / ${laid.H}`;
    return box;
  });
  // Each slide is drawn at its own size and scaled to its box, again whenever the box changes width.
  slideScale.disconnect();
  for (const box of shots) slideScale.observe(box);

  const select = (label, key, options, value, slot = null) => {
    const el = h('select', { 'aria-label': label, 'data-slide-choice': slot ? `bg:${slot}` : key, disabled: S.readOnly || undefined },
      options.map(([val, text]) => { const o = h('option', { value: String(val) }, text); if (String(val) === String(value)) o.selected = true; return o; }));
    return h('label', { class: 'choice' }, h('span', {}, label), el);
  };
  const bg = slot => choices.backgrounds?.[slot] ?? 'family';
  const controls = h('div', { class: 'slide-choices' },
    select('Family', 'family', FAMILIES, design.template.family),
    select('Stage', 'mode', [['light', 'Light'], ['dark', 'Dark']], design.template.mode),
    select('Titles', 'titleWeight', [['', 'Family’s'], ...WEIGHTS], choices.titleWeight ?? ''),
    select('Corners', 'radius', [['', 'Family’s'], ...CORNERS], choices.radius ?? ''),
    select('Kicker', 'kicker', [['', 'Family’s'], ...KICKERS], choices.kicker ?? ''),
    select('Logo', 'placement', PLACEMENTS, design.logos?.placement ?? 'top-right'),
    ...[['title', 'Title slides'], ['section', 'Section slides'], ['closing', 'Closing slide'], ['content', 'Other slides']].map(([slot, label]) =>
      select(label, null, [...BACKGROUNDS.map(([val, text]) => [val, val === 'picture' && kitPlainValues.pictures[slot] ? 'Picture' : text]),
        ...(kitPlainValues.pictures[slot] ? [['picture-new', 'Another picture…']] : [])], bg(slot), slot)));
  const note = `${templateLabel(design.template.family)} · ${design.template.mode === 'dark' ? 'dark' : 'light'} stage · Export → Deck design takes this look to Deck`;
  const section = h('section', { class: 'tile t-slides slides', 'aria-label': 'Slides' },
    h('div', { class: 'tile-head' }, h('h2', {}, 'Slides'), h('span', {}, note)),
    h('div', { class: 'slide-row' }, shots), controls);
  section.addEventListener('change', event => {
    const el = event.target.closest('[data-slide-choice]');
    if (el) chooseSlides(el.getAttribute('data-slide-choice'), el.value);
  });
  section.addEventListener('click', event => event.stopPropagation());
  section.addEventListener('keydown', event => event.stopPropagation());
  return section;
}
const templateLabel = id => FAMILIES.find(([f]) => f === id)?.[1] ?? 'Keynote';

/**
 * One choice on the Slides tile, written to the kit as one undoable step. A picture asks for its file
 * first. Choices made in quick succession are written one after another, each on the kit as the last
 * one left it, so the second is never refused for the version the first changed.
 */
let slideWrites = Promise.resolve();
function chooseSlides(key, value) {
  const k = kit();
  if (!k || S.readOnly) return;
  if (key.startsWith('bg:')) {
    const slot = key.slice(3);
    if (value === 'picture-new' || (value === 'picture' && !k.values[SLIDE_PICTURE_FIELDS[slot]])) { pickPicture(slot); return; }
  }
  slideWrites = slideWrites.then(() => writeSlideChoice(k.recordId, key, value)).catch(error => flash(error.message));
}
async function writeSlideChoice(recordId, key, value) {
  const k = await nendo.records.get('kit', recordId);
  const choices = readChoices(k.values.kitSlides);
  if (key.startsWith('bg:')) {
    const slot = key.slice(3);
    choices.backgrounds = { ...(choices.backgrounds ?? {}) };
    if (value === 'family') delete choices.backgrounds[slot]; else choices.backgrounds[slot] = value;
  } else if (value === '') delete choices[key];
  else choices[key] = ['titleWeight', 'radius'].includes(key) ? Number(value) : value;
  await batch([{ op: 'update', entityId: 'kit', recordId: k.recordId, version: k.version, values: { kitSlides: JSON.stringify(choices) } }], `Slides: ${key.replace(/^bg:/, '')} for ${str(k.values.kitName)}`);
}

const pictureInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml', hidden: true });
document.body.append(pictureInput);
let pictureSlot = null;
function pickPicture(slot) { pictureSlot = slot; pictureInput.value = ''; pictureInput.click(); render(); }
pictureInput.addEventListener('change', async () => {
  const file = pictureInput.files[0], slot = pictureSlot;
  const k = kit();
  if (!file || !slot || !k) return;
  if (file.size > 8 * 1024 * 1024) { flash('Pick a picture of at most 8 MB.'); return; }
  const put = slideWrites.then(async () => {
    const now = await nendo.records.get('kit', k.recordId);
    await nendo.media.put(file, { name: file.name, mediaType: file.type || 'image/png', record: { entityId: 'kit', recordId: now.recordId, version: now.version }, fieldId: SLIDE_PICTURE_FIELDS[slot] });
    const fresh = await nendo.records.get('kit', k.recordId);
    const choices = readChoices(fresh.values.kitSlides);
    choices.backgrounds = { ...(choices.backgrounds ?? {}), [slot]: 'picture' };
    await batch([{ op: 'update', entityId: 'kit', recordId: fresh.recordId, version: fresh.version, values: { kitSlides: JSON.stringify(choices) } }], `Slides: a picture behind ${slot} slides`);
  });
  // The picture joins the queue of slide writes, so a choice or an export after it waits for it.
  slideWrites = put.catch(error => flash(error.message));
});

/** The kit's Deck design, with its logos and pictures: the file Deck imports on its Design tab. */
async function exportDeckDesign(m) {
  // A choice still being written, or a picture still being put, belongs in the file: wait for it,
  // then read the kit as it now stands rather than as the board last drew it.
  await slideWrites;
  try { m = { ...m, kit: await nendo.records.get('kit', m.kit.recordId) }; } catch (error) { flash(error.message); return; }
  const plain = kitPlain(m);
  for (const [slot, p] of Object.entries(plain.pictures)) {
    try { const blob = await nendo.media.read(p.address); p.blob = blob; p.type = blob.type || p.type; } catch { delete plain.pictures[slot]; }
  }
  const { design, pictures, pictureSlots } = kitDesign({ ...plain, exported: new Date().toISOString() }, readChoices(m.kit.values.kitSlides));
  for (const [slot, path] of Object.entries(pictureSlots)) pictures.set(path, new Uint8Array(await plain.pictures[slot].blob.arrayBuffer()));
  download(designFileName(design), new Blob([writeDesignPackage(design, pictures)], { type: 'application/zip' }));
  S.note = { text: `Downloaded ${designFileName(design)}. In Deck, open the Design tab, choose Import from Brandkits… and pick it.`, reply: true };
  drawAskBar();
}

// ---------- export

function slug(text) { return str(text).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-') || 'colour'; }
function download(name, text, type) {
  const url = URL.createObjectURL(text instanceof Blob ? text : new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
function uniqueSlugs(items, nameOf) {
  const seen = new Map();
  return items.map(item => { let s = slug(nameOf(item)); const n = seen.get(s) ?? 0; seen.set(s, n + 1); return n ? `${s}-${n + 1}` : s; });
}
function exportCss(m) {
  const lines = [`/* ${str(m.kit.values.kitName)}: brand tokens from Brandkits */`, ':root {'];
  const colours = m.colours.filter(c => m.hexOf(c));
  uniqueSlugs(colours, c => c.values.colourName).forEach((s, i) => lines.push(`  --brand-${s}: ${m.hexOf(colours[i])};${colours[i].values.colourRole ? ` /* ${colours[i].values.colourRole} */` : ''}`));
  for (const t of m.typefaces) {
    const r = slug(t.values.typeRole || 'body');
    lines.push(`  --font-${r}: ${stackOf(t, t.values.typeRole)};`, `  --font-${r}-weight: ${weightOf(t)};`);
    if (t.values.typeSize) lines.push(`  --font-${r}-size: ${Number(t.values.typeSize)}px;`);
  }
  lines.push('}', '');
  return lines.join('\n');
}
function exportTokens(m) {
  const tokens = { color: {}, font: {} };
  const colours = m.colours.filter(c => m.hexOf(c));
  uniqueSlugs(colours, c => c.values.colourName).forEach((s, i) => {
    const c = colours[i];
    tokens.color[s] = { $type: 'color', $value: m.hexOf(c), ...(c.values.colourRole || c.values.colourUsage ? { $description: [c.values.colourRole, c.values.colourUsage].filter(Boolean).join(': ') } : {}) };
  });
  for (const t of m.typefaces) {
    const r = slug(t.values.typeRole || 'body');
    tokens.font[r] = {
      family: { $type: 'fontFamily', $value: [str(t.values.typeFamily), ...str(t.values.typeStack).split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean)] },
      weight: { $type: 'fontWeight', $value: weightOf(t) },
      ...(t.values.typeSize ? { size: { $type: 'dimension', $value: { value: Number(t.values.typeSize), unit: 'px' } } } : {}),
    };
  }
  return `${JSON.stringify(tokens, null, 2)}\n`;
}
function runExport(id) {
  const m = modelOf(S.records);
  if (!m.kit) return;
  const base = slug(m.kit.values.kitName) || 'brand';
  if (id === 'export-css') download(`${base}.css`, exportCss(m), 'text/css');
  else if (id === 'export-tokens') download(`${base}.tokens.json`, exportTokens(m), 'application/json');
  else if (id === 'export-deck-design') exportDeckDesign(m);
  else if (id === 'export-claude-design') {
    const bundle = designBundle(m, { css: exportCss(m), tokens: exportTokens(m), stackOf, weightOf, slug, isLogo: logo => Boolean(logoUrl(logo)) });
    download(`${bundle.root}-design-system.zip`, zip(bundle.files));
    S.note = { text: `Downloaded ${bundle.files.length} files. Unzip them and run /design-sync in Claude Code to put them in a Claude Design project.`, reply: true };
    drawAskBar();
  }
  else if (id.startsWith('export-logo:')) {
    const logo = m.logo(id.slice('export-logo:'.length));
    if (logo && logoUrl(logo)) download(`${base}-${slug(logo.values.logoName)}.svg`, str(logo.values.logoSvg), 'image/svg+xml');
  }
}

// ---------- asking the agent

const asker = createAsker(nendo, {
  entityId: 'ask',
  fields: { subject: 'askKit', scope: 'askScope', request: 'askRequest', selection: 'askSelection', state: 'askState', progress: 'askProgress', reply: 'askReply', asked: 'askAsked', finished: 'askFinished' },
  words: { whole: 'Whole kit', selection: 'Selection', waiting: 'Waiting', working: 'Working', cancelled: 'Cancelled' },
  message: (ask, request) => {
    const short = request.replace(/\s+/g, ' ').trim();
    return `Work Brandkits ask «${short.length > 60 ? short.slice(0, 59) + '…' : short}» (record ${ask.recordId}) by this file's Brandkits skill, as a message from the Brandkits view. Write results as records. Reply in one line.`;
  },
  context: (subject, items, ask) => [
    { uri: `nendo://application/entity/kit/records?recordId=${encodeURIComponent(subject.recordId)}`, title: `Kit: ${str(subject.values.kitName)}`.slice(0, 120),
      text: (items.length ? `Selected:\n${items.map(i => `${i.kind} ${i.id} «${i.label}»`).join('\n')}` : `Whole kit. ${str(subject.values.kitBrief)}`).slice(0, 8000) },
    { uri: `nendo://application/entity/ask/records?recordId=${encodeURIComponent(ask.recordId)}`, title: 'The ask', text: str(ask.values.askRequest).slice(0, 8000) },
  ],
});

function itemOf(record) {
  const v = record.values;
  switch (record.entityId) {
    case 'kit': return { kind: 'kit', id: record.recordId, label: 'voice and words' };
    case 'colour': return { kind: 'colour', id: record.recordId, label: `${str(v.colourName)} ${str(v.colourHex)} ${str(v.colourRole)}`.trim() };
    case 'typeface': return { kind: 'typeface', id: record.recordId, label: `${str(v.typeRole)} ${str(v.typeFamily)}`.trim() };
    case 'logo': return { kind: 'logo', id: record.recordId, label: `${str(v.logoName)} (${str(v.logoKind) || 'Logo'})` };
    default: return { kind: record.entityId, id: record.recordId, label: str(v[NAME_FIELD[record.entityId]]) };
  }
}
const selectedItems = () => [...S.selection].map(byKey).filter(Boolean).map(itemOf);
const latestAsk = () => S.asks[0] ?? null;

async function send(text) {
  const request = text.trim();
  if (!request || S.busy) return;
  if (S.readOnly) { flash('This file takes no edits.'); return; }
  S.busy = true; S.note = null; drawAskBar();
  try {
    let subject = kit();
    if (!subject) subject = await newKit(request.length > 48 ? `${request.slice(0, 47)}…` : request);
    if (!subject) return;
    const items = selectedItems();
    const { askRecord, turn } = await asker.send(subject, request, items);
    $('askInput').value = '';
    S.asks = [askRecord, ...S.asks];
    if (!turn) S.note = { text: 'Saved as an Ask. Say "tidy the kits" in an agent session connected to this file to have it made.' };
    drawAskBar();
    if (turn) follow(turn, askRecord);
  } catch (error) { S.note = { text: error.message, error: true }; }
  finally { S.busy = false; drawAskBar(); }
}

/** Asks again for an Ask that waits: after a refusal, a reload or a Not now. */
function sendAgain(ask) {
  const subject = kit();
  if (!subject) return;
  const items = str(ask.values.askSelection).split('\n').map(line => {
    const [kind, id] = line.split(' ');
    const record = byKey(keyOf(kind, id));
    return record ? itemOf(record) : id ? { kind, id, label: id } : null;
  }).filter(Boolean);
  S.note = null;
  follow(asker.ask(ask, subject, items), ask);
  drawAskBar();
}

async function follow(turn) {
  try {
    const { reply, stopReason } = await turn;
    const said = str(reply).trim().split('\n').filter(Boolean).pop() ?? '';
    S.note = stopReason === 'end_turn' ? (said ? { text: said, reply: true } : null)
      : { text: stopReason === 'cancelled' ? 'Stopped.' : `The agent stopped (${stopReason}). ${said}`.trim(), error: stopReason !== 'cancelled' };
  } catch (error) {
    S.note = { text: isRefusal(error) ? `${refusalText(error)} The ask is saved.` : error.message, error: true, refused: true };
  }
  await refresh();
}

async function stop() {
  const ask = latestAsk();
  if (!ask) return;
  try { await asker.stop(ask, FINISHED); } catch (error) { flash(error.message); }
  await refresh();
}

// ---------- variants

function ghostOf(variant) {
  const { writes, error } = parseWrites(variant.values.variantOperations);
  const ghost = applyWrites(S.records, withDanglingReferences(writes), fill);
  ghost.error = error ?? (ghost.problems.length ? `It names records that are no longer there: ${ghost.problems[0]}.` : null);
  return ghost;
}

/** A variant that deletes a colour or a logo also clears the samples that point at it. */
function withDanglingReferences(writes) {
  const ghost = applyWrites(S.records, writes, fill);
  const extra = [];
  for (const [key, r] of ghost.records) {
    if (r.entityId !== 'sample' || !S.records.has(key)) continue;
    const values = {};
    for (const f of SAMPLE_REFS) if (r.values[f] && ghost.deleted.has(keyOf('colour', r.values[f]))) values[f] = null;
    if (r.values.sampleLogo && ghost.deleted.has(keyOf('logo', r.values.sampleLogo))) values.sampleLogo = null;
    if (Object.keys(values).length) extra.push({ op: 'update', entityId: 'sample', recordId: r.recordId, values });
  }
  return extra.length ? [...writes, ...extra] : writes;
}

/** What the view works out about a variant: the ratio its changed colour reaches, or the kit's. */
function variantNote(ghost) {
  const m = modelOf(ghost.records);
  const changedColours = m.colours.filter(c => ghost.created.has(keyOf('colour', c.recordId)) || ghost.updated.has(keyOf('colour', c.recordId)));
  const failing = usedPairs(m).filter(p => !(p.kind === 'ui' ? grade(p.value, S.target).large : grade(p.value, S.target).pass)).length;
  const tail = failing ? ` · ${failing} pair${failing > 1 ? 's' : ''} fail` : '';
  if (changedColours.length === 1 && m.hexOf(changedColours[0]) && changedColours[0] !== m.background) {
    const c = changedColours[0];
    const value = ratio(m.hexOf(c), m.bg);
    return `${str(c.values.colourName)} on ${str(m.background?.values.colourName) || 'background'} ${shown(value)} ${grade(value, S.target).label}${tail}`;
  }
  if (m.background && m.text) { const value = ratio(m.ink, m.bg); return `Text ${shown(value)} ${grade(value, S.target).label}${tail}`; }
  return tail.slice(3);
}

function drawVariants() {
  const ask = S.variantAsk;
  const list = ask ? S.variants.map(record => {
    const ghost = ghostOf(record);
    const counts = [ghost.created.size && `+${ghost.created.size}`, ghost.updated.size && `~${ghost.updated.size}`, ghost.deleted.size && `−${ghost.deleted.size}`].filter(Boolean).join(' ');
    return { id: record.recordId, record, title: str(record.values.variantTitle) || 'Variant', summary: str(record.values.variantSummary),
      note: ghost.error ? 'Out of date' : S.variantErrors.get(record.recordId) ?? (variantNote(ghost) || counts), error: ghost.error, ghost };
  }) : [];
  variantStrip($('variants'), {
    heading: ask ? `Variants for «${str(ask.values.askRequest).slice(0, 60)}»` : '',
    variants: list, busy: S.busy || S.readOnly,
    preview: (variant, host) => drawPreview(variant, host),
    hover: variant => { const next = variant && !variant.error ? variant : null; if ((S.hover?.id ?? null) !== (next?.id ?? null)) { S.hover = next; render(); } },
    use: variant => useVariant(variant),
    none: () => rejectAll(),
  });
}

/** A small brand board: the palette as a strip, the name in the heading face, and the logo. */
function drawPreview(variant, host) {
  const ghost = variant.ghost;
  const m = modelOf(ghost.records);
  const touched = key => ghost.created.has(key) || ghost.updated.has(key);
  const strip = h('div', { class: 'strip' }, m.colours.filter(c => m.hexOf(c)).map(c => h('span', { class: touched(keyOf('colour', c.recordId)) ? 'changed' : '', style: { background: m.hexOf(c) }, title: `${str(c.values.colourName)} ${m.hexOf(c)}` })));
  const kitChanged = m.kit && touched(keyOf('kit', m.kit.recordId));
  const typeChanged = m.typefaces.some(t => touched(keyOf('typeface', t.recordId)));
  const logo = m.logos.find(l => touched(keyOf('logo', l.recordId))) ?? m.primaryLogo;
  const sample = m.samples.find(s => touched(keyOf('sample', s.recordId)));
  const src = logoUrl(logo);
  const words = h('div', { class: 'words' },
    h('b', { class: typeChanged ? 'changed-text' : '', style: { fontFamily: stackOf(m.fonts.heading, 'Heading'), fontWeight: weightOf(m.fonts.heading, 700) } }, sample ? str(sample.values.sampleHeadline) || str(sample.values.sampleName) : str(m.kit?.values.kitName)),
    h('span', { class: kitChanged || sample ? 'changed-text' : '', style: { fontFamily: stackOf(m.fonts.body, 'Body') } }, sample ? str(sample.values.sampleBody) : str(m.kit?.values.kitTagline) || str(m.kit?.values.kitPersonality)));
  loadFonts(m.typefaces);
  host.replaceChildren(h('div', { class: 'mini', style: { background: m.bg, color: m.ink } }, strip,
    h('div', { class: 'body' }, words, src ? h('img', { src, alt: '', class: logo && touched(keyOf('logo', logo.recordId)) ? 'changed-text' : '' }) : null)));
}

async function useVariant(variant) {
  const ask = S.variantAsk;
  if (!ask || S.busy) return;
  const { writes, error } = parseWrites(variant.record.values.variantOperations);
  if (error) { flash(error); return; }
  let prepared;
  const tidy = writes.map(w => ({ ...w, values: w.values ? { ...w.values } : undefined }));
  for (const w of tidy) if (w.entityId === 'colour' && w.values?.colourHex) w.values.colourHex = normalHex(w.values.colourHex) ?? w.values.colourHex;
  try {
    prepared = prepareBatch(withDanglingReferences(tidy), new Map(S.records), { newId, references, fill });
  } catch (problem) { refuseVariant(variant, `This variant no longer fits the kit: ${problem.message}`); return; }
  const statuses = S.variants.map(v => ({ op: 'update', entityId: 'variant', recordId: v.recordId, version: v.version,
    values: { variantStatus: v.recordId === variant.id ? 'Applied' : 'Rejected' } }));
  const close = { op: 'update', entityId: 'ask', recordId: ask.recordId, version: ask.version, values: { askState: 'Done' } };
  S.busy = true; S.hover = null; drawVariants();
  const result = await batch([...prepared, ...statuses, close], `Use variant: ${variant.title}`);
  S.busy = false;
  if (!result) refuseVariant(variant, `Not used: ${S.note?.text ?? 'Nendo refused it.'}`);
  else S.note = { text: `Used “${variant.title}”. Undo is in Nendo’s notice.`, reply: true };
  await refresh();
}

function refuseVariant(variant, text) {
  S.variantErrors.set(variant.id, 'Not used, see above');
  flash(text);
  if (nendo.has('ui.toast')) nendo.ui.toast(text.slice(0, 300)).catch(() => {});
  drawVariants();
}

async function rejectAll() {
  const ask = S.variantAsk;
  if (!ask || S.busy) return;
  S.hover = null;
  await batch([...S.variants.map(v => ({ op: 'update', entityId: 'variant', recordId: v.recordId, version: v.version, values: { variantStatus: 'Rejected' } })),
    { op: 'update', entityId: 'ask', recordId: ask.recordId, version: ask.version, values: { askState: 'Done' } }], 'Reject the variants');
  await refresh();
}

// ---------- the ask bar, agent strip and empty states

function drawAskBar() {
  const count = S.selection.size;
  selectionChip($('chip'), count, () => { S.selection.clear(); drawSelection(); });
  const hasContent = (S.model?.colours.length ?? 0) + (S.model?.typefaces.length ?? 0) + (S.model?.logos.length ?? 0) > 0;
  $('askInput').placeholder = count ? 'What should change in the selection?' : kit() && hasContent ? 'What should change in this kit?' : 'Describe a brand in one line';
  $('askInput').disabled = S.readOnly;
  $('askSend').disabled = S.busy || S.readOnly;
  const ask = latestAsk();
  const live = ask && LIVE.includes(ask.values.askState);
  $('askStop').hidden = !live;
  const status = $('askStatus');
  status.replaceChildren();
  status.classList.toggle('error', Boolean(S.note?.error));
  const showAsk = ask && (live || ask.values.askState === 'Variants ready' || (!S.note && ask.values.askReply));
  status.hidden = !showAsk && !S.note;
  if (showAsk) {
    const state = str(ask.values.askState) || 'Waiting';
    status.append(h('span', { class: `pill ${{ Waiting: 'waiting', Working: 'working', 'Variants ready': 'ready', Done: 'done', Failed: 'failed' }[state] ?? ''}` }, state));
  }
  const lines = h('div', { class: 'lines' });
  if (S.note) { lines.textContent = S.note.text; if (S.note.reply) lines.classList.add('reply'); }
  else if (showAsk) {
    const progress = str(ask.values.askProgress).trim().split('\n').filter(Boolean).slice(-3).join('\n');
    lines.textContent = ask.values.askReply && !live ? str(ask.values.askReply) : progress || (ask.values.askState === 'Waiting' ? 'Waiting for the agent to pick it up.' : 'Working…');
    if (ask.values.askReply && !live) lines.classList.add('reply');
  }
  status.append(lines);
  if (ask?.values.askState === 'Waiting' && asker.has() && !asker.isPending(ask.recordId) && !S.busy) {
    status.append(h('button', { type: 'button' }, 'Send again'));
    status.lastChild.onclick = () => sendAgain(ask);
    status.hidden = false;
  }
  drawAgent();
}

function drawAgent() {
  const strip = $('agent');
  strip.hidden = !nendo.has('assistant.ask');
  if (strip.hidden) return;
  const a = S.agent ?? { state: 'none' };
  const state = a.access === 'never' ? 'Views may not message it' : a.state === 'none' ? 'Not started: Send starts it'
    : a.state === 'starting' ? 'Starting' : a.state === 'signIn' ? 'Needs sign-in' : a.state === 'ended' ? 'Ended' : a.working ? 'Working' : 'Ready';
  strip.className = `agent ${a.access === 'never' ? 'off' : a.working ? 'working' : a.state === 'ready' ? 'ready' : ''}`;
  strip.replaceChildren(h('span', { class: 'dot' }), h('span', {}, a.name ? `${a.name} · ${state}` : `Agent · ${state}`));
}

function drawEmpty() {
  const empty = $('empty');
  const m = S.model;
  const noKits = S.kits.length === 0;
  const blank = kit() && m && m.colours.length + m.typefaces.length + m.logos.length + m.samples.length === 0 && !m.kit?.values.kitVoice;
  const waiting = latestAsk() && LIVE.includes(latestAsk().values.askState);
  empty.hidden = !(noKits || (blank && !waiting));
  if (empty.hidden) return;
  const example = h('button', { type: 'button', class: 'primary', disabled: S.readOnly }, `Try: “${EXAMPLE}”`);
  example.onclick = () => { $('askInput').value = EXAMPLE; send(EXAMPLE); };
  empty.replaceChildren(h('h2', {}, noKits ? 'Make a brand kit with your agent' : 'This kit is empty'),
    h('ol', {}, ['Describe a brand in one line above and press Send.', 'The agent writes its colours, type, logos, voice and samples here, one by one.',
      'Select one part and ask again: you pick from up to three variants. Nendo checks every contrast pair.'].map(t => h('li', {}, t))),
    example);
}

let flashTimer = null;
function flash(text) {
  S.note = { text, error: true };
  drawAskBar();
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { if (S.note?.text === text) { S.note = null; drawAskBar(); } }, 6000);
}

// ---------- toolbar, place and refresh

async function toolbar() {
  if (!nendo.has('ui.setToolbar')) return;
  const k = kit();
  const options = S.kits.slice(0, 64).map(r => ({ value: r.recordId, label: str(r.values.kitName).slice(0, 80) || 'Kit' }));
  const items = [];
  if (options.length) items.push({ kind: 'select', id: 'kit', label: 'Kit', hideLabel: true, options, value: S.kitId });
  items.push({ kind: 'button', id: 'new-kit', label: 'New kit', icon: 'plus', disabled: S.readOnly });
  items.push({ kind: 'choice', id: 'target', label: 'Contrast target', hideLabel: true, value: S.target,
    options: [{ value: 'AA', label: 'AA' }, { value: 'AAA', label: 'AAA' }] });
  items.push({ kind: 'spacer' });
  if (k) {
    const logos = [...S.records.values()].filter(r => r.entityId === 'logo' && logoUrl(r)).slice(0, 20);
    items.push({ kind: 'menu', id: 'export', label: 'Export', icon: 'export', items: [
      { id: 'export-css', label: 'CSS custom properties', detail: 'Colours and type as --brand and --font variables' },
      { id: 'export-tokens', label: 'Design tokens (JSON)', detail: 'The W3C Design Tokens format' },
      { id: 'export-claude-design', label: 'Claude Design bundle (zip)', detail: 'Guidelines, tokens, logos and preview cards for /design-sync' },
      { id: 'export-deck-design', label: 'Deck design', detail: 'The Slides look, logos and backgrounds, for Deck’s Design tab' },
      ...(logos.length ? [{ kind: 'separator' }, { kind: 'label', label: 'Logos as SVG' }] : []),
      ...logos.map(l => ({ id: `export-logo:${l.recordId}`.slice(0, 64), label: str(l.values.logoName).slice(0, 80) || 'Logo' })),
    ] });
  }
  try { await nendo.ui.setToolbar({ items, add: k && !S.readOnly ? 'add-colour' : undefined }); }
  catch (error) { console.error(error); }
}

nendo.on?.('command', async ({ id, value }) => {
  if (id === 'kit' && value) { S.kitId = value; S.selection.clear(); S.hover = null; S.known = null; S.note = null; await refresh(); place(); }
  else if (id === 'new-kit') await newKit();
  else if (id === 'target' && value) { S.target = value; try { await nendo.state.set('target', value); } catch { /* Kept for this visit only. */ } await refresh(); }
  else if (id === 'add-colour') await addColour();
  else if (id.startsWith('export-')) { window.focus(); runExport(id); }
});

function place() {
  if (!nendo.has('ui.setPlace') || !S.kitId) return;
  nendo.ui.setPlace({ kit: S.kitId }, { label: str(kit()?.values.kitName).slice(0, 80) || 'Kit', replace: true }).catch(() => {});
}

let refreshing = null, again = false;
async function refresh() {
  if (editor) { S.pendingRefresh = true; return; }
  if (refreshing) { again = true; return refreshing; }
  refreshing = (async () => {
    do {
      again = false;
      try { await load(); } catch (error) { if (error.code !== 'stale-cursor') { flash(error.message); break; } again = true; continue; }
      render();
      drawAskBar(); drawVariants(); drawEmpty(); await toolbar();
      if (S.editAfter) { const key = S.editAfter; S.editAfter = null; if (S.records.has(key)) startEdit(key); }
    } while (again);
  })();
  try { await refreshing; } finally { refreshing = null; }
}

$('askForm').addEventListener('submit', event => { event.preventDefault(); send($('askInput').value); });
$('askStop').addEventListener('click', stop);

nendo.ready.then(async context => {
  S.context = context; S.readOnly = Boolean(context.readOnly);
  if (context.place?.kit) S.kitId = context.place.kit;
  try { const saved = await nendo.state.get('target'); if (saved?.value === 'AAA') S.target = 'AAA'; } catch { /* Starts at AA. */ }
  await loadSchema();
  if (nendo.has('assistant.status')) {
    try { S.agent = await nendo.assistant.status(); } catch { /* Shown as not started. */ }
    nendo.on('assistant', status => { S.agent = status; drawAgent(); });
  }
  nendo.on('context', next => { S.context = next; S.readOnly = Boolean(next.readOnly); loadSchema().then(refresh); });
  nendo.on('place', next => { if (next?.kit && next.kit !== S.kitId) { S.kitId = next.kit; S.selection.clear(); S.known = null; refresh(); } });
  nendo.changes.subscribe(() => refresh());
  await refresh();
  place();
}).catch(error => {
  document.body.textContent = error.code === 'not-framed' ? 'Brandkits runs inside Nendo.' : str(error.message || error);
});
