// What a deck is in the file, and how a slide's text is read. Pure: no DOM, no window.nendo,
// so the view, the exports, the build script and node's tests share it.

export const E = { deck: 'dk.deck', slide: 'dk.slide', template: 'dk.template', brand: 'dk.brand', ask: 'dk.ask', variant: 'dk.variant' };
export const F = {
  deck: { title: 'dk.deck.title', subtitle: 'dk.deck.subtitle', author: 'dk.deck.author', date: 'dk.deck.date', audience: 'dk.deck.audience',
    goal: 'dk.deck.goal', aspect: 'dk.deck.aspect', template: 'dk.deck.template', brand: 'dk.deck.brand', footer: 'dk.deck.footer',
    numbers: 'dk.deck.numbers', status: 'dk.deck.status', transition: 'dk.deck.transition', minutes: 'dk.deck.minutes' },
  slide: { deck: 'dk.slide.deck', order: 'dk.slide.order', layout: 'dk.slide.layout', title: 'dk.slide.title', kicker: 'dk.slide.kicker',
    body: 'dk.slide.body', body2: 'dk.slide.body2', notes: 'dk.slide.notes', image: 'dk.slide.image', imageAlt: 'dk.slide.imageAlt',
    image2: 'dk.slide.image2', image3: 'dk.slide.image3', image4: 'dk.slide.image4',
    chart: 'dk.slide.chart', hidden: 'dk.slide.hidden', format: 'dk.slide.format', build: 'dk.slide.build', transition: 'dk.slide.transition',
    seconds: 'dk.slide.seconds' },
  template: { name: 'dk.template.name', family: 'dk.template.family', description: 'dk.template.description', headingFont: 'dk.template.headingFont',
    bodyFont: 'dk.template.bodyFont', background: 'dk.template.background', surface: 'dk.template.surface', ink: 'dk.template.ink',
    muted: 'dk.template.muted', primary: 'dk.template.primary', secondary: 'dk.template.secondary', accent: 'dk.template.accent',
    mode: 'dk.template.mode', style: 'dk.template.style', backgrounds: 'dk.template.backgrounds', chart: 'dk.template.chart',
    logoPlacement: 'dk.template.logoPlacement', titleImage: 'dk.template.titleImage', sectionImage: 'dk.template.sectionImage',
    closingImage: 'dk.template.closingImage', contentImage: 'dk.template.contentImage', brand: 'dk.template.brand', source: 'dk.template.source' },
  brand: { name: 'dk.brand.name', source: 'dk.brand.source', primary: 'dk.brand.primary', secondary: 'dk.brand.secondary', accent: 'dk.brand.accent',
    background: 'dk.brand.background', surface: 'dk.brand.surface', ink: 'dk.brand.ink', muted: 'dk.brand.muted', headingFont: 'dk.brand.headingFont',
    bodyFont: 'dk.brand.bodyFont', monoFont: 'dk.brand.monoFont', logo: 'dk.brand.logo', logoDark: 'dk.brand.logoDark', voice: 'dk.brand.voice',
    tagline: 'dk.brand.tagline', tokens: 'dk.brand.tokens', mark: 'dk.brand.mark' },
  ask: { deck: 'dk.ask.deck', scope: 'dk.ask.scope', request: 'dk.ask.request', selection: 'dk.ask.selection', status: 'dk.ask.status',
    progress: 'dk.ask.progress', reply: 'dk.ask.reply', made: 'dk.ask.made' },
  variant: { ask: 'dk.variant.ask', slide: 'dk.variant.slide', label: 'dk.variant.label', changes: 'dk.variant.changes',
    rationale: 'dk.variant.rationale', status: 'dk.variant.status' },
};

/**
 * The layouts, in the order the gallery shows them. `uses` names the slide fields a layout draws,
 * which the inspector shows and the skill tells the agent; `hint` is the body's grammar.
 */
export const LAYOUTS = [
  { id: 'Title', label: 'Title', uses: ['title', 'kicker', 'body'], hint: 'Kicker above, the deck title, one line below (who and when).' },
  { id: 'Section', label: 'Section', uses: ['title', 'kicker', 'body'], hint: 'Kicker is the section number, such as 02.' },
  { id: 'Statement', label: 'Statement', uses: ['title', 'kicker'], hint: 'One sentence that carries the point.' },
  { id: 'Bullets', label: 'Title and text', uses: ['title', 'kicker', 'body'], hint: 'Bullets (- ) or short paragraphs. Indent two spaces for a second level.' },
  { id: 'Title only', label: 'Title only', uses: ['title', 'kicker', 'image'], hint: 'The title, and free space under it. A picture you add fills the space whole, such as a diagram or a screen.' },
  { id: 'Two columns', label: 'Two columns', uses: ['title', 'kicker', 'body', 'body2'], hint: 'Left column in Body, right column in Body 2.' },
  { id: 'Comparison', label: 'Comparison', uses: ['title', 'kicker', 'body', 'body2'], hint: 'Each side starts with ### Heading, then bullets.' },
  { id: 'Image left', label: 'Image left', uses: ['title', 'kicker', 'body', 'image'], hint: 'A picture on the left half, text on the right.' },
  { id: 'Image right', label: 'Image right', uses: ['title', 'kicker', 'body', 'image'], hint: 'Text on the left, a picture on the right half.' },
  { id: 'Full image', label: 'Full image', uses: ['title', 'kicker', 'image'], hint: 'The picture fills the slide; the title sits on it.' },
  { id: 'Picture grid', label: 'Picture grid', uses: ['title', 'kicker', 'body', 'image', 'pictures'], hint: 'Two to four pictures side by side. Body holds a caption for each, one line per picture: - Caption.' },
  { id: 'Quote', label: 'Quote', uses: ['body', 'kicker', 'title'], hint: 'Body is the quote, Kicker who said it. Title is not drawn.' },
  { id: 'Big numbers', label: 'Big numbers', uses: ['title', 'kicker', 'body'], hint: 'One line each: - 42% | what it counts | where from (2 to 4).' },
  { id: 'Agenda', label: 'Agenda', uses: ['title', 'kicker', 'body'], hint: 'One item per line: - Item | short note.' },
  { id: 'Timeline', label: 'Timeline', uses: ['title', 'kicker', 'body'], hint: 'One step per line: - When | What | detail (3 to 6).' },
  { id: 'Process', label: 'Process', uses: ['title', 'kicker', 'body'], hint: 'Steps from left to right, one per line: - Step | detail (2 to 6).' },
  { id: 'Cycle', label: 'Cycle', uses: ['title', 'kicker', 'body'], hint: 'Steps round a circle, back to the first, one per line: - Step | detail (3 to 6).' },
  { id: 'Cards', label: 'Cards', uses: ['title', 'kicker', 'body'], hint: 'One card per line: - Heading | text (2 to 6).' },
  { id: 'Table', label: 'Table', uses: ['title', 'kicker', 'body'], hint: 'A Markdown table: | A | B | then | --- | --- | then rows.' },
  { id: 'Chart', label: 'Chart', uses: ['title', 'kicker', 'body', 'body2', 'chart'], hint: 'Body is a Markdown table: first column the labels, then one column per series. Body 2 is the takeaway.' },
  { id: 'Closing', label: 'Closing', uses: ['title', 'kicker', 'body'], hint: 'Thanks or the ask; Body holds contact lines.' },
];
export const LAYOUT_IDS = LAYOUTS.map(l => l.id);
export const layoutOf = id => LAYOUTS.find(l => l.id === id) ?? LAYOUTS.find(l => l.id === 'Bullets');
export const CHARTS = ['Column', 'Bar', 'Line', 'Doughnut', 'Pie', 'Area', 'Stacked'];
/** A slide's pictures, in order: the first is its Picture, the others are for the Picture grid. */
export const PICTURES = ['image', 'image2', 'image3', 'image4'];
/** How a slide comes on, in Present, the HTML file and PowerPoint. A slide's own `Deck` takes the deck's. */
export const TRANSITIONS = ['None', 'Fade', 'Push', 'Zoom'];
export const SLIDE_TRANSITIONS = ['Deck', ...TRANSITIONS];
/** Whether a slide's points come one click at a time. */
export const BUILDS = ['None', 'One by one'];
/** The transition a slide plays: its own, or the deck's when it says `Deck`. */
export const transitionOf = (slide, deckTransition) => TRANSITIONS.includes(slide?.transition) ? slide.transition : TRANSITIONS.includes(deckTransition) ? deckTransition : 'None';

/** A Slide record's values as the plain slide the engine draws. */
export function slideFrom(record) {
  const v = record?.values ?? {};
  return {
    id: record?.recordId ?? null, version: record?.version ?? null,
    layout: LAYOUT_IDS.includes(v[F.slide.layout]) ? v[F.slide.layout] : 'Bullets',
    title: str(v[F.slide.title]), kicker: str(v[F.slide.kicker]), body: str(v[F.slide.body]), body2: str(v[F.slide.body2]),
    notes: str(v[F.slide.notes]), image: v[F.slide.image] || null, imageAlt: str(v[F.slide.imageAlt]),
    image2: v[F.slide.image2] || null, image3: v[F.slide.image3] || null, image4: v[F.slide.image4] || null,
    chart: CHARTS.includes(v[F.slide.chart]) ? v[F.slide.chart] : 'Column', hidden: v[F.slide.hidden] === true, format: str(v[F.slide.format]),
    build: BUILDS.includes(v[F.slide.build]) ? v[F.slide.build] : 'None', transition: SLIDE_TRANSITIONS.includes(v[F.slide.transition]) ? v[F.slide.transition] : 'Deck',
    seconds: Number.isInteger(v[F.slide.seconds]) && v[F.slide.seconds] > 0 ? v[F.slide.seconds] : null,
    order: Number.isFinite(v[F.slide.order]) ? v[F.slide.order] : 0,
  };
}
const str = value => value === null || value === undefined ? '' : String(value);

/** Slides of one deck, in order; ties keep their record ID order so the order never flickers. */
export function sortSlides(slides) {
  return [...slides].sort((a, b) => (a.order - b.order) || String(a.id).localeCompare(String(b.id)));
}
/** Orders that place `moving` between its new neighbours, renumbering only when there is no room. */
export function reorder(slides, fromIndex, toIndex) {
  const list = [...slides];
  const [moved] = list.splice(fromIndex, 1);
  list.splice(toIndex, 0, moved);
  return list.map((s, i) => ({ id: s.id, version: s.version, order: (i + 1) * 10, changed: s.order !== (i + 1) * 10 })).filter(s => s.changed);
}

// ---- Text: a small Markdown, enough for slides. ------------------------------------------------
// The stage edits this text in place (stage-editor.mjs), so every reader here has a writer that
// gives back the same words and marks: inline/inlineMarkdown, paragraphs/blocksMarkdown.

/** A link goes to the web or to mail; a `javascript:` or other address would run in the view's frame. */
export const safeLink = address => /^(?:https?:\/\/|mailto:)/i.test(String(address ?? '')) ? String(address) : null;

const PUNCTUATION = /[!-/:-@[-`{-~]/;
const MARK_KEYS = ['b', 'i', 'u', 'code', 'link'];
const sameMarks = (a, b) => MARK_KEYS.every(k => (a[k] ?? null) === (b[k] ?? null));
/** A run with only the marks it has: no key is ever present and false. */
export function run(text, marks = {}) {
  const r = { text };
  for (const k of MARK_KEYS) if (marks[k]) r[k] = marks[k];
  return r;
}
/** Runs with neighbours of the same marks joined and empty ones dropped. */
export function mergeRuns(runs) {
  const out = [];
  for (const r of runs) {
    if (!r.text) continue;
    const last = out.at(-1);
    if (last && sameMarks(last, r)) last.text += r.text; else out.push(run(r.text, r));
  }
  return out;
}

/** Where `delimiter` next closes in `text` from `at`, stepping over escapes, code spans and doubled marks. */
function closing(text, at, delimiter) {
  for (let j = at; j < text.length; j++) {
    const ch = text[j];
    if (ch === '\\' && PUNCTUATION.test(text[j + 1] ?? '')) { j++; continue; }
    if (ch === '`' && delimiter !== '`') { const end = text.indexOf('`', j + 1); if (end > j + 1) { j = end; continue; } }
    if (!text.startsWith(delimiter, j)) continue;
    // A single * or _ never closes on half of a doubled one: that is bold inside the italic.
    if (delimiter.length === 1 && (delimiter === '*' || delimiter === '_') && text[j + 1] === delimiter) { j++; continue; }
    return j;
  }
  return -1;
}

function parseInline(text, marks, out) {
  let plain = '';
  const flush = () => { if (plain) { out.push(run(plain, marks)); plain = ''; } };
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (ch === '\\' && PUNCTUATION.test(text[i + 1] ?? '')) { plain += text[i + 1]; i += 2; continue; }
    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i + 1) { flush(); out.push(run(text.slice(i + 1, end), { ...marks, code: true })); i = end + 1; continue; }
    }
    const tags = [['***', { b: true, i: true }], ['**', { b: true }], ['__', { b: true }], ['<u>', { u: true }, '</u>'], ['*', { i: true }], ['_', { i: true }]];
    let taken = false;
    for (const [open, add, close = open] of tags) {
      if (!text.startsWith(open, i)) continue;
      const from = i + open.length;
      // A lone * before a space is a times sign or a star, not italic.
      if (open === '*' && /\s/.test(text[from] ?? ' ')) continue;
      const end = closing(text, from, close);
      if (end <= from) continue;
      flush();
      parseInline(text.slice(from, end), { ...marks, ...add }, out);
      i = end + close.length; taken = true; break;
    }
    if (taken) continue;
    if (ch === '[') {
      const end = closing(text, i + 1, ']');
      const m = end > i + 1 ? /^\(([^)\s]+)\)/.exec(text.slice(end + 1)) : null;
      if (m) {
        flush();
        const link = safeLink(m[1]);
        parseInline(text.slice(i + 1, end), link ? { ...marks, link } : marks, out);
        i = end + 1 + m[0].length; continue;
      }
    }
    plain += ch; i++;
  }
  flush();
}

/**
 * Inline marks: **bold**, *italic* or _italic_, <u>underline</u>, `code` and [text](link), nested
 * as deep as they go; a backslash keeps the punctuation after it as itself. Returns runs.
 */
export function inline(text) {
  const out = [];
  parseInline(String(text ?? ''), {}, out);
  const runs = mergeRuns(out);
  return runs.length ? runs : [{ text: '' }];
}

/** Text with every character a mark could take escaped, so it reads back as the same words. */
function escapeText(text) {
  return text.replace(/[\\`*_[\]]/g, '\\$&').replace(/<(?=\/?u>|br>)/gi, '\\<');
}
const OPEN = { link: () => '[', b: () => '**', i: () => '_', u: () => '<u>' };
const CLOSE = { link: r => `](${r.link.replace(/[()\s]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)})`, b: () => '**', i: () => '_', u: () => '</u>' };
const NESTING = ['link', 'b', 'i', 'u'];
/** Runs as inline Markdown that `inline` reads back as the same runs. */
export function inlineMarkdown(runs) {
  let out = '';
  const open = [];
  const wants = (r, k) => k === 'link' ? r.link ?? null : !!r[k];
  for (const r of mergeRuns(runs)) {
    // Close from the inside out until every mark still open is one this run keeps, as it is.
    let keep = 0;
    while (keep < open.length && wants(r, open[keep].k) && (open[keep].k !== 'link' || open[keep].link === r.link)) keep++;
    while (open.length > keep) { const m = open.pop(); out += CLOSE[m.k](m); }
    for (const k of NESTING) if (wants(r, k) && !open.some(m => m.k === k)) { out += OPEN[k](r); open.push({ k, link: r.link }); }
    // Code cannot hold a backtick; such a run keeps its words and loses the mark.
    out += r.code && !r.text.includes('`') ? `\`${r.text}\`` : escapeText(r.text);
  }
  while (open.length) { const m = open.pop(); out += CLOSE[m.k](m); }
  return out;
}

/**
 * Paragraphs of a body: bullets (- or *), numbers (1.), ### headings and plain lines. A plain
 * line directly under another plain line continues it, as Markdown does. A lone `<br>` is an
 * empty paragraph, and a lone marker an empty item, so a writer can keep an empty line.
 */
export function paragraphs(body) {
  const out = [];
  let previousPlain = false;
  for (const raw of String(body ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (!raw.trim()) { previousPlain = false; continue; }
    const indent = raw.match(/^\s*/)[0].replace(/\t/g, '  ').length;
    // What follows the marker keeps its trailing spaces: the stage types into them.
    const line = raw.trimStart();
    let m;
    if (/^<br>\s*$/i.test(line)) { out.push({ runs: [{ text: '' }], level: 0 }); previousPlain = false; continue; }
    if ((m = /^#{1,6}(?:\s+(.*)|\s*)$/.exec(line))) { out.push({ runs: inline(m[1] ?? ''), heading: true, level: 0 }); previousPlain = false; continue; }
    if ((m = /^[-*•](?:\s+(.*)|\s*)$/.exec(line))) { out.push({ runs: inline(m[1] ?? ''), bullet: 'bullet', level: indent >= 2 ? 1 : 0 }); previousPlain = false; continue; }
    if ((m = /^(\d+)[.)](?:\s+(.*)|\s*)$/.exec(line))) { out.push({ runs: inline(m[2] ?? ''), bullet: 'number', number: Number(m[1]), level: indent >= 2 ? 1 : 0 }); previousPlain = false; continue; }
    if (previousPlain && out.length) { out[out.length - 1].runs = mergeRuns([...out[out.length - 1].runs, { text: ' ' }, ...inline(line)]); continue; }
    out.push({ runs: inline(line), level: 0 });
    previousPlain = true;
  }
  return out;
}
export const plainText = runs => runs.map(r => r.text).join('');

/**
 * Paragraphs ({kind: plain|bullet|number|heading, level, runs}) as the body Markdown that
 * `paragraphs` reads back the same. Numbers count on from the first of each list.
 */
export function blocksMarkdown(paras) {
  if (paras.length === 1 && paras[0].kind === 'plain' && !plainText(paras[0].runs)) return '';
  const lines = [];
  let previous = null;
  const counters = [0, 0];
  paras.forEach(para => {
    const content = inlineMarkdown(para.runs);
    const level = para.level > 0 ? 1 : 0, pad = level ? '  ' : '';
    if (para.kind !== 'number') counters[level] = 0;
    if (level === 0 && para.kind !== 'number') counters[1] = 0;
    let line;
    if (para.kind === 'bullet') line = `${pad}-${content ? ` ${content}` : ''}`;
    else if (para.kind === 'number') {
      counters[level] = counters[level] ? counters[level] + 1 : (para.number ?? 1);
      line = `${pad}${counters[level]}.${content ? ` ${content}` : ''}`;
    } else if (para.kind === 'heading') line = `###${content ? ` ${content}` : ''}`;
    else if (!content) line = '<br>';
    else {
      // A plain line that starts like a marker keeps it as words.
      line = content.replace(/^\s+/, '').replace(/^([-+]|#{1,6})(?=\s|$)/, '\\$1').replace(/^(\d+)([.)])(?=\s|$)/, '$1\\$2');
      if (previous === 'plain') lines.push('');
    }
    lines.push(line);
    previous = para.kind === 'plain' && content ? 'plain' : para.kind;
  });
  return lines.join('\n');
}

/** Lines of runs (a title) as Markdown, one paragraph to a line. */
export const linesMarkdown = paras => paras.length === 1 && !plainText(paras[0].runs) ? '' : paras.map(p => inlineMarkdown(p.runs)).join('\n');

/** Lines of the form `- a | b | c`, as cells {text, from, to} with each cell's place in the body. */
export function rowCells(body) {
  const out = [];
  let at = 0;
  for (const raw of String(body ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const start = at;
    at += raw.length + 1;
    if (!raw.trim() || /^#{1,6}\s/.test(raw.trim())) continue;
    // The line keeps its trailing spaces, so an empty last cell keeps the space after its bar.
    const line = raw.trimStart();
    const marker = /^([-*•]|\d+[.)])\s/.exec(line)?.[0] ?? '';
    let pos = start + (raw.length - line.length) + marker.length;
    out.push(line.slice(marker.length).split('|').map((piece, i) => {
      const lead = piece.length - piece.trimStart().length, text = piece.trim();
      // An empty cell stays where its words were: after its marker, or after the one space past its bar.
      const skip = text ? lead : Math.min(lead, i ? 1 : 0);
      const cell = { text, from: pos + skip, to: pos + skip + text.length };
      pos += piece.length + 1;
      return cell;
    }));
  }
  return out;
}
/** Lines of the form `- a | b | c`, as arrays of trimmed cells; plain lines count too. */
export const rows = body => rowCells(body).map(r => r.map(c => c.text));

/** A Markdown table: {head, rows, align, at}; null when the body holds none. `at` places each cell in the body. */
export function table(body) {
  let offset = 0;
  const lines = [];
  for (const raw of String(body ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('|') || /\|/.test(line)) lines.push({ line, start: offset + (raw.length - raw.trimStart().length) });
    offset += raw.length + 1;
  }
  if (lines.length < 2) return null;
  const cells = ({ line, start }) => {
    let pos = start, inner = line;
    if (inner.startsWith('|')) { inner = inner.slice(1); pos += 1; }
    if (inner.endsWith('|')) inner = inner.slice(0, -1);
    return inner.split('|').map(piece => {
      const lead = piece.length - piece.trimStart().length, text = piece.trim();
      const skip = text ? lead : Math.min(lead, 1);
      const cell = { text, from: pos + skip, to: pos + skip + text.length };
      pos += piece.length + 1;
      return cell;
    });
  };
  const separator = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;
  const head = cells(lines[0]);
  const rest = lines.slice(1).filter(l => !separator.test(l.line)).map(cells);
  const align = separator.test(lines[1]?.line ?? '') ? cells(lines[1]).map(({ text: c }) => c.endsWith(':') && c.startsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left') : head.map(() => 'left');
  const width = head.length;
  return {
    head: head.map(c => c.text), rows: rest.map(r => Array.from({ length: width }, (_, i) => r[i]?.text ?? '')), align,
    at: { head: head.map(({ from, to }) => ({ from, to })), rows: rest.map(r => Array.from({ length: width }, (_, i) => r[i] ? { from: r[i].from, to: r[i].to } : null)) },
  };
}

// ---- Text format: size and alignment, per text box, kept on the slide as JSON. ------------------

export const ALIGNS = ['left', 'center', 'right', 'justify'];
/** The scales of a layout's size a slide's format keeps: a quarter to six times. */
export const SCALE = { min: 0.25, max: 6 };
/**
 * A slide's text format as {key: {size, align}}: `size` scales the layout's own size for that box
 * (1 is the layout's), `align` replaces its alignment. Anything else is dropped.
 */
export function parseFormat(text) {
  let raw = null;
  try { raw = typeof text === 'string' && text.trim() ? JSON.parse(text) : (typeof text === 'object' ? text : null); } catch { raw = null; }
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (!/^[a-z0-9.]{1,32}$/i.test(key) || !value || typeof value !== 'object') continue;
    const entry = {};
    if (Number.isFinite(value.size) && value.size >= SCALE.min && value.size <= SCALE.max && Math.abs(value.size - 1) > 0.001) entry.size = Math.round(value.size * 1000) / 1000;
    if (ALIGNS.includes(value.align)) entry.align = value.align;
    if (Object.keys(entry).length) out[key] = entry;
  }
  return out;
}
/** A format as the slide keeps it: JSON, or '' when nothing differs from the layout. */
export function formatText(format) {
  const clean = parseFormat(format);
  const keys = Object.keys(clean).sort();
  return keys.length ? JSON.stringify(Object.fromEntries(keys.map(k => [k, clean[k]]))) : '';
}

/** A number in a cell: 1,234.5 or 12% or €3.4m; null when the cell is no number. */
export function numberIn(cell) {
  // A leading point is a fraction: .5 and -.25, never 5 and 25.
  const m = /-?(?:\d[\d,]*(?:\.\d+)?|\.\d+)/.exec(String(cell ?? '').replace(/\s/g, ''));
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** The chart a table describes: labels down the first column, one series per other column. */
export function chartData(body) {
  const t = table(body);
  // A table with no rows is no data: a chart of nothing would divide by nothing.
  if (!t || t.head.length < 2 || !t.rows.length) return null;
  const series = t.head.slice(1).map((name, i) => ({ name, values: t.rows.map(r => numberIn(r[i + 1]) ?? 0) }));
  return { labels: t.rows.map(r => r[0]), series, unit: unitOf(t.rows.map(r => r[1]).join(' ')) };
}
const unitOf = text => /%/.test(text) ? '%' : '';

/** A tidy number for a label, or for an axis whose ticks are `step` apart. */
export function formatNumber(n, unit = '', step = 0) {
  const abs = Math.abs(n);
  // An axis says as many decimals as its step has; a value under one keeps two significant digits.
  const places = step ? decimalsOf(step) : abs > 0 && abs < 1 ? Math.min(10, 1 - Math.floor(Math.log10(abs))) : abs < 10 ? 1 : 0;
  const text = abs >= 1e9 ? (n / 1e9).toFixed(abs >= 1e10 ? 0 : 1) + 'B' : abs >= 1e6 ? (n / 1e6).toFixed(abs >= 1e7 ? 0 : 1) + 'M'
    : abs >= 1e4 ? (n / 1e3).toFixed(0) + 'k' : Number.isInteger(n) ? String(n) : n.toFixed(places);
  return text.replace(/(\.\d*?)0+(?=[BMk]|$)/, '$1').replace(/\.(?=[BMk]|$)/, '') + unit;
}
const decimalsOf = step => {
  for (let d = 0; d < 10; d++) if (Math.abs(step * 10 ** d - Math.round(step * 10 ** d)) < 1e-6) return d;
  return 10;
};
/** A nice upper bound and step for an axis from 0. */
/** A signed axis from the data's least to its greatest value, always through zero, in tidy steps. */
export function signedScale(values, ticks = 4) {
  const least = Math.min(0, ...values), most = Math.max(0, ...values);
  if (!(most - least > 0)) return { min: 0, max: 1, step: 0.25 };
  const { step } = niceScale(most - least, ticks);
  // + 0 turns a negative nought into nought, which an axis label would otherwise print with its sign.
  return { min: Math.floor(least / step + 1e-9) * step + 0, max: Math.ceil(most / step - 1e-9) * step + 0, step };
}

export function niceScale(max, ticks = 4) {
  if (!(max > 0)) return { max: 1, step: 0.25 };
  const raw = max / ticks, power = 10 ** Math.floor(Math.log10(raw)), f = raw / power;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * power;
  return { max: Math.ceil(max / step) * step, step };
}
