// What a deck is in the file, and how a slide's text is read. Pure: no DOM, no window.nendo,
// so the view, the exports, the build script and node's tests share it.

export const E = { deck: 'dk.deck', slide: 'dk.slide', template: 'dk.template', brand: 'dk.brand', ask: 'dk.ask', variant: 'dk.variant' };
export const F = {
  deck: { title: 'dk.deck.title', subtitle: 'dk.deck.subtitle', author: 'dk.deck.author', date: 'dk.deck.date', audience: 'dk.deck.audience',
    goal: 'dk.deck.goal', aspect: 'dk.deck.aspect', template: 'dk.deck.template', brand: 'dk.deck.brand', footer: 'dk.deck.footer',
    numbers: 'dk.deck.numbers', status: 'dk.deck.status' },
  slide: { deck: 'dk.slide.deck', order: 'dk.slide.order', layout: 'dk.slide.layout', title: 'dk.slide.title', kicker: 'dk.slide.kicker',
    body: 'dk.slide.body', body2: 'dk.slide.body2', notes: 'dk.slide.notes', image: 'dk.slide.image', imageAlt: 'dk.slide.imageAlt',
    chart: 'dk.slide.chart', hidden: 'dk.slide.hidden' },
  template: { name: 'dk.template.name', family: 'dk.template.family', description: 'dk.template.description', headingFont: 'dk.template.headingFont',
    bodyFont: 'dk.template.bodyFont', background: 'dk.template.background', surface: 'dk.template.surface', ink: 'dk.template.ink',
    muted: 'dk.template.muted', primary: 'dk.template.primary', secondary: 'dk.template.secondary', accent: 'dk.template.accent' },
  brand: { name: 'dk.brand.name', source: 'dk.brand.source', primary: 'dk.brand.primary', secondary: 'dk.brand.secondary', accent: 'dk.brand.accent',
    background: 'dk.brand.background', surface: 'dk.brand.surface', ink: 'dk.brand.ink', muted: 'dk.brand.muted', headingFont: 'dk.brand.headingFont',
    bodyFont: 'dk.brand.bodyFont', monoFont: 'dk.brand.monoFont', logo: 'dk.brand.logo', logoDark: 'dk.brand.logoDark', voice: 'dk.brand.voice',
    tagline: 'dk.brand.tagline', tokens: 'dk.brand.tokens' },
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
  { id: 'Two columns', label: 'Two columns', uses: ['title', 'kicker', 'body', 'body2'], hint: 'Left column in Body, right column in Body 2.' },
  { id: 'Comparison', label: 'Comparison', uses: ['title', 'kicker', 'body', 'body2'], hint: 'Each side starts with ### Heading, then bullets.' },
  { id: 'Image left', label: 'Image left', uses: ['title', 'kicker', 'body', 'image'], hint: 'A picture on the left half, text on the right.' },
  { id: 'Image right', label: 'Image right', uses: ['title', 'kicker', 'body', 'image'], hint: 'Text on the left, a picture on the right half.' },
  { id: 'Full image', label: 'Full image', uses: ['title', 'kicker', 'image'], hint: 'The picture fills the slide; the title sits on it.' },
  { id: 'Quote', label: 'Quote', uses: ['body', 'kicker', 'title'], hint: 'Body is the quote, Kicker who said it. Title is not drawn.' },
  { id: 'Big numbers', label: 'Big numbers', uses: ['title', 'kicker', 'body'], hint: 'One line each: - 42% | what it counts | where from (2 to 4).' },
  { id: 'Agenda', label: 'Agenda', uses: ['title', 'kicker', 'body'], hint: 'One item per line: - Item | short note.' },
  { id: 'Timeline', label: 'Timeline', uses: ['title', 'kicker', 'body'], hint: 'One step per line: - When | What | detail (3 to 6).' },
  { id: 'Cards', label: 'Cards', uses: ['title', 'kicker', 'body'], hint: 'One card per line: - Heading | text (2 to 6).' },
  { id: 'Table', label: 'Table', uses: ['title', 'kicker', 'body'], hint: 'A Markdown table: | A | B | then | --- | --- | then rows.' },
  { id: 'Chart', label: 'Chart', uses: ['title', 'kicker', 'body', 'body2', 'chart'], hint: 'Body is a Markdown table: first column the labels, then one column per series. Body 2 is the takeaway.' },
  { id: 'Closing', label: 'Closing', uses: ['title', 'kicker', 'body'], hint: 'Thanks or the ask; Body holds contact lines.' },
];
export const LAYOUT_IDS = LAYOUTS.map(l => l.id);
export const layoutOf = id => LAYOUTS.find(l => l.id === id) ?? LAYOUTS[3];
export const CHARTS = ['Column', 'Bar', 'Line', 'Doughnut'];

/** A Slide record's values as the plain slide the engine draws. */
export function slideFrom(record) {
  const v = record?.values ?? {};
  return {
    id: record?.recordId ?? null, version: record?.version ?? null,
    layout: LAYOUT_IDS.includes(v[F.slide.layout]) ? v[F.slide.layout] : 'Bullets',
    title: str(v[F.slide.title]), kicker: str(v[F.slide.kicker]), body: str(v[F.slide.body]), body2: str(v[F.slide.body2]),
    notes: str(v[F.slide.notes]), image: v[F.slide.image] || null, imageAlt: str(v[F.slide.imageAlt]),
    chart: CHARTS.includes(v[F.slide.chart]) ? v[F.slide.chart] : 'Column', hidden: v[F.slide.hidden] === true,
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

/** A link goes to the web or to mail; a `javascript:` or other address would run in the view's frame. */
export const safeLink = address => /^(?:https?:\/\/|mailto:)/i.test(String(address ?? '')) ? String(address) : null;

/** Inline marks: **bold**, *italic* or _italic_, `code`, [text](link). Returns runs. */
export function inline(text) {
  const runs = [];
  const pattern = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\))/g;
  let at = 0, m;
  const plain = s => { if (s) runs.push({ text: s }); };
  while ((m = pattern.exec(text)) !== null) {
    plain(text.slice(at, m.index));
    if (m[2] ?? m[3]) runs.push({ text: m[2] ?? m[3], b: true });
    else if (m[4] ?? m[5]) runs.push({ text: m[4] ?? m[5], i: true });
    else if (m[6]) runs.push({ text: m[6], code: true });
    else if (m[7]) runs.push(safeLink(m[8]) ? { text: m[7], link: m[8] } : { text: m[7] });
    at = pattern.lastIndex;
  }
  plain(text.slice(at));
  return runs.length ? runs : [{ text: '' }];
}

/**
 * Paragraphs of a body: bullets (- or *), numbers (1.), ### headings and plain lines. A plain
 * line directly under another plain line continues it, as Markdown does.
 */
export function paragraphs(body) {
  const out = [];
  let previousPlain = false;
  for (const raw of String(body ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (!raw.trim()) { previousPlain = false; continue; }
    const indent = raw.match(/^\s*/)[0].replace(/\t/g, '  ').length;
    const line = raw.trim();
    let m;
    if ((m = /^#{1,6}\s+(.*)$/.exec(line))) { out.push({ runs: inline(m[1]), heading: true, level: 0 }); previousPlain = false; continue; }
    if ((m = /^[-*•]\s+(.*)$/.exec(line))) { out.push({ runs: inline(m[1]), bullet: 'bullet', level: indent >= 2 ? 1 : 0 }); previousPlain = false; continue; }
    if ((m = /^(\d+)[.)]\s+(.*)$/.exec(line))) { out.push({ runs: inline(m[2]), bullet: 'number', number: Number(m[1]), level: indent >= 2 ? 1 : 0 }); previousPlain = false; continue; }
    if (previousPlain && out.length) { out[out.length - 1].runs.push({ text: ' ' }, ...inline(line)); continue; }
    out.push({ runs: inline(line), level: 0 });
    previousPlain = true;
  }
  return out;
}
export const plainText = runs => runs.map(r => r.text).join('');

/** Lines of the form `- a | b | c`, as arrays of trimmed cells; plain lines count too. */
export function rows(body) {
  return String(body ?? '').replace(/\r\n?/g, '\n').split('\n').map(l => l.trim()).filter(Boolean)
    .filter(l => !/^#{1,6}\s/.test(l))
    .map(l => l.replace(/^([-*•]|\d+[.)])\s+/, '').split('|').map(c => c.trim()));
}

/** A Markdown table: {head, rows}; null when the body holds none. */
export function table(body) {
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n').map(l => l.trim()).filter(l => l.startsWith('|') || /\|/.test(l));
  if (lines.length < 2) return null;
  const cells = line => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  const separator = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;
  const head = cells(lines[0]);
  const rest = lines.slice(1).filter(l => !separator.test(l)).map(cells);
  const align = separator.test(lines[1] ?? '') ? cells(lines[1]).map(c => c.endsWith(':') && c.startsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left') : head.map(() => 'left');
  const width = head.length;
  return { head, rows: rest.map(r => Array.from({ length: width }, (_, i) => r[i] ?? '')), align };
}

/** A number in a cell: 1,234.5 or 12% or €3.4m; null when the cell is no number. */
export function numberIn(cell) {
  const m = /-?\d[\d,]*(\.\d+)?/.exec(String(cell ?? '').replace(/\s/g, ''));
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** The chart a table describes: labels down the first column, one series per other column. */
export function chartData(body) {
  const t = table(body);
  if (!t || t.head.length < 2) return null;
  const series = t.head.slice(1).map((name, i) => ({ name, values: t.rows.map(r => numberIn(r[i + 1]) ?? 0) }));
  return { labels: t.rows.map(r => r[0]), series, unit: unitOf(t.rows.map(r => r[1]).join(' ')) };
}
const unitOf = text => /%/.test(text) ? '%' : '';

/** A tidy number for an axis or a label. */
export function formatNumber(n, unit = '') {
  const abs = Math.abs(n);
  const text = abs >= 1e9 ? (n / 1e9).toFixed(abs >= 1e10 ? 0 : 1) + 'B' : abs >= 1e6 ? (n / 1e6).toFixed(abs >= 1e7 ? 0 : 1) + 'M'
    : abs >= 1e4 ? (n / 1e3).toFixed(0) + 'k' : Number.isInteger(n) ? String(n) : n.toFixed(Math.abs(n) < 10 ? 1 : 0);
  return text.replace(/\.0(?=[BMk]|$)/, '') + unit;
}
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
