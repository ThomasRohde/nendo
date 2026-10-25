// The layout engine: one slide and a resolved theme in, a list of drawing primitives out, in the
// slide's own pixels (1280 × 720, or 960 × 720 at 4:3). The view, the HTML export and the
// PowerPoint export all draw these same primitives, so what the stage shows is what PowerPoint
// opens. Text is fitted here, by measuring, so every renderer is told the size to use.
//
// Primitives:
//   rect / ellipse  {x, y, w, h, fill, alpha, radius, stroke, strokeWidth, shadow}
//   line            {x1, y1, x2, y2, stroke, width, dash}
//   path            {points: [[x, y]…], closed, fill, alpha, stroke, width}
//   arc             {cx, cy, r, inner, start, end, fill}   degrees, 0 at the top, clockwise
//   image           {x, y, w, h, src, fit: cover|contain, align, radius, alt, slot}
//   text            {x, y, w, h, font, size, weight, italic, color, align, valign, lineHeight,
//                    tracking, caps, paragraphs: [{runs, bullet, number, level, heading}], role,
//                    key, and while editing `edit`: where its words are in the slide (below)}
// A fill is a colour or {type: linear|radial, angle, stops: [{at, color, alpha}]}. A picture, or the
// place where one goes, says in `slot` which of the slide's pictures it is (0 to 3), so the stage can
// put a picture dropped on it into that one.
//
// Builds: on a slide whose build is `One by one`, a primitive with `step` k, or a paragraph with
// `step` k, comes on with the k-th click; one without is there from the start. The slide says how
// many clicks it has in `steps`.

import { paragraphs, rows, rowCells, table, chartData, formatNumber, signedScale, inline, plainText, parseFormat, PICTURES } from './model.mjs';
import { sizeOf, fontStack, mix, isDark, readableOn, holdContrast, colorsOn } from './themes.mjs';
import { slotOf } from './design.mjs';

/** A measurer for node and for tests: close to Segoe UI's widths, and the same on every machine. */
export function approxMeasure(text, { size, weight = 400, font = '' }) {
  let w = 0;
  const mono = /consol|mono|courier/i.test(font);
  for (const ch of String(text)) {
    if (mono) { w += 0.55; continue; }
    if (ch === ' ') w += 0.27;
    else if (/[il.,:;'!|]/.test(ch)) w += 0.25;
    else if (/[mwMW]/.test(ch)) w += 0.82;
    else if (/[A-Z0-9]/.test(ch)) w += 0.62;
    else w += 0.5;
  }
  return w * size * (weight >= 600 ? 1.06 : weight <= 300 ? 0.96 : 1);
}

const DEFAULTS = { lineHeight: 1.2, weight: 400, italic: false, align: 'left', valign: 'top', tracking: 0, caps: false };

/** The lines a text primitive wraps to at its size, per paragraph; each line is {width, height}. */
export function wrap(p, measure) {
  const out = [];
  for (const para of p.paragraphs) {
    const scale = paraScale(para);
    const size = p.size * scale;
    const indent = para.bullet ? bulletIndent(p, para) : 0;
    const width = Math.max(10, p.w - indent);
    const words = [];
    for (const run of para.runs) {
      const text = p.caps ? run.text.toUpperCase() : run.text;
      for (const piece of text.split(/(\s+)/)) if (piece) words.push({ text: piece, weight: run.b || para.heading ? Math.max(600, p.weight) : p.weight, code: run.code });
    }
    let line = 0, lines = 1;
    for (const word of words) {
      const font = word.code ? 'Consolas' : p.font;
      const ww = measure(word.text, { size, weight: word.weight, font }) + (p.tracking ?? 0) * size * word.text.length;
      if (/^\s+$/.test(word.text)) { line += ww; continue; }
      if (ww > width) {
        const parts = Math.ceil(ww / width);
        lines += (line > 0 ? 1 : 0) + parts - 1;
        line = ww - (parts - 1) * width;
      } else if (line > 0 && line + ww > width) { lines++; line = ww; } else line += ww;
    }
    out.push({ lines, size, height: lines * size * (p.lineHeight ?? 1.2), space: paraSpace(p, para) });
  }
  return out;
}
const paraScale = para => para.heading ? 1 : para.level > 0 ? 0.86 : 1;
const paraSpace = (p, para) => para.spaceBefore ?? (para.heading ? 0.7 : para.level > 0 ? 0.25 : 0.55) * p.size;
export const bulletIndent = (p, para) => p.size * (para.bullet === 'number' ? 1.5 : p.bulletChar === '—' ? 1.6 : 1.15) * (1 + (para.level ?? 0) * 0.9);

/** The height a text primitive takes at its size. */
export function textHeight(p, measure) {
  const lines = wrap(p, measure);
  return lines.reduce((h, l, i) => h + l.height + (i > 0 ? l.space : 0), 0);
}
/** Shrinks a text primitive until it fits its box, never below `min`. Answers the height used. */
export function fit(p, measure, min = 14) {
  let h = textHeight(p, measure);
  while (h > p.h && p.size > min) {
    p.size = Math.max(min, Math.floor(p.size * 0.93));
    h = textHeight(p, measure);
  }
  p.overflow = h > p.h + 1;
  return h;
}

// The slide being laid out: its text format, and whether the stage is editing it. Set by layoutSlide
// for the length of one synchronous call, so text() need not be handed them by every layout.
let format = {}, editing = null;

/**
 * A text primitive from plain text or from parsed paragraphs. `src` says where its words are in
 * the slide, {field, dialect, key, first | from, to}: the stage edits them in place, and `key`
 * names the box in the slide's text format, whose size scales the layout's and whose alignment
 * replaces it.
 */
function text(spec) {
  const { src, ...rest } = spec;
  const paragraphs = rest.paragraphs ?? String(rest.text ?? '').split('\n').map(line => ({ runs: rest.markdown === false ? [{ text: line }] : inline(line), level: 0 }));
  const p = { type: 'text', ...DEFAULTS, ...rest, paragraphs, text: undefined };
  if (!src) return p;
  const style = format[src.key];
  p.key = src.key;
  if (style?.size) p.size = Math.max(6, p.size * style.size);
  if (style?.align) p.align = style.align;
  if (editing) p.edit = { ...src, base: rest.size };
  return p;
}
/** Where a whole field's words are: a title's lines, a kicker's plain words, or a body's paragraphs from `first`. */
const whole = (field, dialect, key = field, first = 0, single = false) => ({ field, dialect, key, first, single });
/** Where one cell of a row or a table is in the body. */
const cell = (at, key, plain = false) => at ? { field: 'body', dialect: plain ? 'cellPlain' : 'cell', key, from: at.from, to: at.to } : null;
/** Whether the stage is editing this cell, which keeps its box while it is empty. */
const keeps = at => !!at && editing?.field === 'body' && editing.from === at.from;
/**
 * Boxes drawn side by side take the smallest size among them, so they read alike; a box the
 * person sized in the slide's format keeps its own.
 */
function alike(boxes) {
  const free = boxes.filter(p => !format[p.key]?.size);
  const size = Math.min(...free.map(p => p.size));
  free.forEach(p => { p.size = size; });
}
/** Whether a field has words, or is the one the stage is editing, which keeps its box while it is empty. */
const shows = (g, field, value = g.slide[field]) => !!value || (editing?.field === field && editing.from === undefined);

/** Lays out one slide. ctx: {measure, number, total, editing, keep}; keep names the field the stage edits, {field, from}. */
export function layoutSlide(slide, theme, ctx = {}) {
  format = parseFormat(slide.format);
  editing = ctx.editing ? ctx.keep ?? {} : null;
  try { return layoutWith(slide, theme, ctx); } finally { format = {}; editing = null; }
}
function layoutWith(slide, theme, ctx) {
  const measure = ctx.measure ?? approxMeasure;
  const { W, H } = sizeOf(theme.aspect);
  const c = theme.colors, s = theme.style;
  const X = W >= 1200 ? 80 : 64;
  const g = { W, H, X, c, s, theme, measure, ctx, slide, items: [], fonts: { heading: theme.fonts.heading, body: theme.fonts.body, mono: theme.fonts.mono },
    build: slide.build === 'One by one', steps: 0 };
  const kind = slide.layout;
  const feature = ['Title', 'Section', 'Closing', 'Statement'].includes(kind) ? kind : null;
  g.bg = background(g, feature, kind);
  // On a design's own background the layouts read the theme's colours as worked out for that ground.
  if (theme.backgrounds?.[slotOf(kind)] && kind !== 'Full image') g.c = colorsOn(c, g.bg.base, g.bg.ink);
  const draw = LAYOUT_FUNCTIONS[kind] ?? LAYOUT_FUNCTIONS.Bullets;
  draw(g);
  chrome(g, feature, kind);
  return { W, H, background: g.bg.fill, dark: g.bg.dark, items: g.items, notes: slide.notes ?? '', steps: g.steps };
}

// ---- Backgrounds and decorations, per template family ------------------------------------------

function background(g, feature, kind) {
  const { W, H, c, theme } = g;
  const fam = theme.family;
  let fill = c.bg;
  const deco = [];
  if (kind === 'Full image') return { fill: '#000000', base: '#000000', dark: true, ink: '#FFFFFF', muted: '#E6E6E6', accent: '#FFFFFF' };
  if (fam === 'keynote') {
    if (feature) {
      deco.push({ type: 'ellipse', x: W * 0.52, y: H * 0.18, w: W * 0.9, h: H * 1.5, fill: { type: 'radial', stops: [{ at: 0, color: c.primary, alpha: 0.55 }, { at: 1, color: c.primary, alpha: 0 }] } });
      deco.push({ type: 'ellipse', x: W * 0.78, y: -H * 0.35, w: W * 0.5, h: H * 0.9, fill: { type: 'radial', stops: [{ at: 0, color: c.accent, alpha: 0.35 }, { at: 1, color: c.accent, alpha: 0 }] } });
    }
  } else if (fam === 'editorial') {
    if (kind === 'Section') fill = c.secondary;
  } else if (fam === 'swiss') {
    if (kind === 'Section' || kind === 'Closing') fill = c.primary;
  } else if (fam === 'boardroom') {
    if (feature && kind !== 'Statement') fill = c.primary;
    if (kind === 'Title') deco.push({ type: 'rect', x: W * 0.7, y: 0, w: W * 0.3, h: H, fill: c.secondary, alpha: 0.9 });
  } else if (fam === 'studio') {
    if (kind === 'Title' || kind === 'Section' || kind === 'Closing') {
      fill = { type: 'linear', angle: 135, stops: [{ at: 0, color: c.primary }, { at: 1, color: c.secondary }] };
      deco.push({ type: 'ellipse', x: W * 0.62, y: H * 0.45, w: W * 0.6, h: W * 0.6, fill: { type: 'radial', stops: [{ at: 0, color: c.accent, alpha: 0.55 }, { at: 1, color: c.accent, alpha: 0 }] } });
    } else {
      deco.push({ type: 'ellipse', x: W * 0.72, y: -H * 0.42, w: W * 0.55, h: W * 0.55, fill: { type: 'radial', stops: [{ at: 0, color: c.primary, alpha: 0.16 }, { at: 1, color: c.primary, alpha: 0 }] } });
      deco.push({ type: 'ellipse', x: -W * 0.2, y: H * 0.62, w: W * 0.45, h: W * 0.45, fill: { type: 'radial', stops: [{ at: 0, color: c.secondary, alpha: 0.12 }, { at: 1, color: c.secondary, alpha: 0 }] } });
    }
  }
  let dark = isDark(typeof fill === 'string' ? fill : mix(fill.stops[0].color, fill.stops.at(-1).color, 0.5));
  // A design's own background for this kind of slide replaces the family's fill and decorations.
  const own = theme.backgrounds?.[slotOf(kind)];
  if (own) {
    deco.length = 0;
    fill = own.fill; dark = own.dark;
    if (own.image) {
      deco.push({ type: 'image', x: 0, y: 0, w: W, h: H, src: own.image, fit: 'cover', role: 'background', alt: '' });
      if (own.tintAlpha > 0) deco.push({ type: 'rect', x: 0, y: 0, w: W, h: H, fill: own.fill, alpha: own.tintAlpha, role: 'background' });
    }
  }
  let base = typeof fill === 'string' ? fill : fill.stops[0].color;
  // Under a picture the tint may be faint: text is set for the darkness the design declares.
  if (own?.image && isDark(base) !== dark) base = dark ? '#111111' : '#FFFFFF';
  g.items.push(...deco);
  const onFill = base !== c.bg || dark !== isDark(c.bg);
  // `base` is the ground as one colour, for contrast: a gradient's first stop, or what a picture's text is set on.
  return {
    fill, dark, base,
    ink: onFill ? readableOn(base, '#FFFFFF', c.ink, c.bg) : c.ink,
    muted: onFill ? mix(readableOn(base, '#FFFFFF', c.ink, c.bg), base, 0.28) : c.muted,
    accent: onFill ? (fam === 'swiss' || fam === 'studio' ? readableOn(base, '#FFFFFF') : holdContrast(c.accent, base, 3)) : c.accentText,
  };
}

/** Footer, slide number and logo; drawn last so they sit over pictures. */
function chrome(g, feature, kind) {
  const { W, H, X, c, theme, ctx } = g;
  const fam = theme.family;
  const ink = g.bg.muted;
  const showFooter = !['Title', 'Full image'].includes(kind);
  const imageSide = kind === 'Image left' ? 'left' : kind === 'Image right' ? 'right' : null;
  const left = imageSide === 'left' ? W * 0.5 + 56 : X, right = imageSide === 'right' ? W * 0.5 - 56 : W - X;
  if (showFooter && fam === 'editorial' && !feature) g.items.push({ type: 'line', x1: left, y1: H - 54, x2: right, y2: H - 54, stroke: c.line, width: 1 });
  const fl = footerRoom(theme, 'left'), fr = footerRoom(theme, 'right');
  if (showFooter && theme.footer) g.items.push(text({ x: left + fl, y: H - 44, w: (right - left) * 0.7 - fl, h: 18, size: 12, font: g.fonts.body, color: ink, text: theme.footer, markdown: false, role: 'footer' }));
  if (showFooter && theme.slideNumbers && ctx.number) {
    const label = fam === 'minimal' ? String(ctx.number).padStart(2, '0') : String(ctx.number);
    g.items.push(text({ x: right - 80 - fr, y: H - 44, w: 80, h: 18, size: 12, align: 'right', font: fam === 'minimal' ? g.fonts.mono : g.fonts.body,
      weight: fam === 'swiss' ? 700 : 400, color: ink, text: label, markdown: false, role: 'number' }));
  }
  const brand = theme.brand;
  const place = theme.logoPlacement ?? 'top-right';
  if (hasLogo(theme) && place !== 'none') {
    // A brand with only a mark shows the mark wherever the logo would go.
    const src = (g.bg.dark ? (brand.logoDark ?? brand.logo) : (brand.logo ?? brand.logoDark)) ?? brand.mark;
    if (kind === 'Title' || kind === 'Closing') {
      const center = kind === 'Closing' && fam !== 'swiss';
      g.items.push({ type: 'image', x: center ? W / 2 - 110 : X, y: kind === 'Closing' ? H - 150 : 56, w: 220, h: 56, src, fit: 'contain', align: center ? 'center' : 'left', role: 'logo', alt: `${brand.name} logo` });
    } else if (kind !== 'Full image' && kind !== 'Section') {
      // Content slides carry the small mark when the brand has one, else the logo.
      const mark = brand.mark ?? null;
      const w = mark ? 40 : 150, h = mark ? 40 : 28;
      const [vertical, side] = place.split('-');
      const x = side === 'left' ? left : (imageSide === 'right' ? W * 0.5 - 56 : W - X) - w;
      const y = vertical === 'top' ? 40 - (mark ? 6 : 0) : H - 46 - (h - 18) / 2 - (mark ? 6 : 0);
      g.items.push({ type: 'image', x, y, w, h, src: mark ?? src, fit: 'contain', align: side, role: 'logo', alt: `${brand.name} logo` });
    }
  }
}

/** Whether the brand has anything to show on a slide: a logo, a logo for dark grounds, or a mark. */
const hasLogo = theme => !!(theme.brand?.logo || theme.brand?.logoDark || theme.brand?.mark);
/** The room a content slide's logo takes beside the header or the footer at one corner, such as 'top-left'. */
function logoRoom(theme, corner) {
  if (!hasLogo(theme) || (theme.logoPlacement ?? 'top-right') !== corner) return 0;
  return (theme.brand.mark ? 40 : 150) + 20;
}
const footerRoom = (theme, side) => logoRoom(theme, `bottom-${side}`);

// ---- Builds ------------------------------------------------------------------------------------
// The points of a content slide come one click at a time: a body's top-level paragraphs, each card,
// number, agenda item or timeline step, a table's rows, a chart's bars or series. A title, a kicker
// and the slide's furniture are there from the start.

/** The next click's number, or 0 when the slide does not build. */
const nextStep = g => g.build ? ++g.steps : 0;
/** Every primitive drawn since `from` comes on with click `step`. */
function stepFrom(g, from, step) { if (step) for (const p of g.items.slice(from)) p.step ??= step; }
/**
 * Each top-level paragraph of a box comes on with a click of its own, and its sub-points with it.
 * `join` puts the first paragraph in the click already counted, such as a card's own.
 */
function stepParagraphs(g, p, join = false) {
  if (!g.build || p.ghost) return;
  p.paragraphs.forEach((para, i) => {
    // An empty line has nothing to bring on.
    if (!para.runs.some(r => r.text)) return;
    const along = i === 0 ? join && g.steps > 0 : (para.level ?? 0) > 0;
    para.step = along ? g.steps : ++g.steps;
  });
}

// ---- Shared pieces -----------------------------------------------------------------------------

/** The kicker above a title, in the template's manner. Answers its bottom edge. */
function kicker(g, value, x, y, w, opts = {}) {
  if (!shows(g, 'kicker', value)) return y;
  const { s, measure } = g;
  const color = opts.color ?? g.bg.accent;
  const src = whole('kicker', 'plain');
  if (s.kicker === 'pill' && !opts.plain) {
    const p = text({ x: x + 14, y: y + 5, w: w - 28, h: 20, size: 14, weight: 600, font: g.fonts.body, color: opts.onFeature ? g.bg.ink : g.c.primaryText, text: value, markdown: false, role: 'kicker', src });
    const k = p.size / 14;
    p.h = 20 * k;
    const tw = Math.min(w - 28 * k, Math.max(measure(value, { size: p.size, weight: 600, font: g.fonts.body }), editing ? p.size : 0) + 4 * k);
    p.w = tw + 8 * k;
    g.items.push({ type: 'rect', x, y, w: tw + 36 * k, h: 30 * k, radius: 15 * k, fill: opts.onFeature ? '#FFFFFF' : g.c.primary, alpha: opts.onFeature ? 0.2 : 0.12 });
    p.x = x + 14 * k; p.y = y + 5 * k;
    g.items.push(p);
    return y + 30 * k;
  }
  const spec = s.kicker === 'italic' ? { size: 20, italic: true, font: g.fonts.heading, weight: 400 }
    : s.kicker === 'mono' ? { size: 14, font: g.fonts.mono, weight: 400, tracking: 0.04 }
      : { size: 14, weight: 700, tracking: 0.14, caps: true, font: g.fonts.body };
  const p = text({ x, y, w, h: spec.size * 1.4, color, text: value, markdown: false, role: 'kicker', ...spec, ...(opts.spec ?? {}), src });
  p.h = p.size * 1.4;
  fit(p, measure, 11);
  g.items.push(p);
  return y + p.h;
}

function title(g, value, x, y, w, h, opts = {}) {
  const { s, measure } = g;
  const p = text({ x, y, w, h, size: opts.size ?? 44, weight: opts.weight ?? s.titleWeight, font: g.fonts.heading, color: opts.color ?? g.bg.ink,
    lineHeight: opts.lineHeight ?? 1.08, tracking: s.titleTracking, text: value || (g.ctx.editing ? 'Title' : ''), markdown: true, role: 'title',
    align: opts.align ?? 'left', valign: opts.valign ?? 'top', ghost: !value && g.ctx.editing, src: whole('title', 'lines') });
  const used = fit(p, measure, opts.min ?? 26);
  g.items.push(p);
  return used;
}

/** Kicker and title at the top of a content slide, with the family's rule. Answers the content top. */
function header(g, opts = {}) {
  const { X, W, c, theme, slide } = g;
  // A logo at the top (chrome) sits beside the kicker and title, however wide the header is given;
  // the family's rules keep the header's full width.
  const x = opts.x ?? X, full = opts.w ?? W - 2 * X;
  const before = logoRoom(theme, 'top-left'), tx = x + before, w = full - before - logoRoom(theme, 'top-right');
  const fam = theme.family;
  let y = 52;
  if (fam === 'swiss') g.items.push({ type: 'rect', x: tx, y: 36, w: 56, h: 8, fill: c.primary });
  if (fam === 'boardroom') g.items.push({ type: 'rect', x: 0, y: 0, w: g.W, h: 8, fill: c.primary });
  if (fam === 'minimal') g.items.push({ type: 'line', x1: x, y1: 36, x2: x + (opts.w ?? W - 2 * X), y2: 36, stroke: c.line, width: 1 });
  if (fam === 'swiss') y = 60;
  const ky = kicker(g, slide.kicker, tx, y, w);
  const ty = ky > y ? ky + 8 : y;
  const used = title(g, slide.title, tx, ty, w, opts.titleH ?? 108, { size: opts.titleSize ?? (fam === 'swiss' ? 46 : 42), min: 24 });
  let bottom = ty + Math.max(used, 46);
  if (fam === 'editorial') g.items.push({ type: 'line', x1: x, y1: bottom + 18, x2: x + (opts.w ?? W - 2 * X), y2: bottom + 18, stroke: c.ink, width: 1.25 });
  if (fam === 'boardroom') g.items.push({ type: 'rect', x, y: bottom + 16, w: 56, h: 4, fill: c.accent });
  return Math.max(opts.minTop ?? 196, bottom + 40);
}

function body(g, value, x, y, w, h, opts = {}) {
  const paras = paragraphs(value).map(p => ({ ...p, bullet: p.bullet ?? (opts.bullets ? 'bullet' : null) }));
  const p = text({ x, y, w, h, size: opts.size ?? bodySize(paras), font: g.fonts.body, color: opts.color ?? g.bg.ink, lineHeight: 1.3, paragraphs: paras.length ? paras : [{ runs: [{ text: g.ctx.editing ? 'Text' : '' }], level: 0 }],
    bulletChar: g.s.bullet, bulletColor: opts.bulletColor ?? g.bg.accent, role: opts.role ?? 'body', valign: opts.valign ?? 'top', align: opts.align ?? 'left', ghost: !paras.length && g.ctx.editing,
    src: whole(opts.role ?? 'body', 'blocks') });
  fit(p, g.measure, opts.min ?? 15);
  g.items.push(p);
  if (opts.build) stepParagraphs(g, p);
  return p;
}
/** Fewer, shorter lines read larger. */
function bodySize(paras) {
  const chars = paras.reduce((n, p) => n + plainText(p.runs).length, 0);
  return paras.length <= 3 && chars < 160 ? 30 : paras.length <= 5 && chars < 360 ? 26 : 22;
}

function card(g, x, y, w, h, opts = {}) {
  const { c, s, theme } = g;
  const fam = theme.family;
  if (fam === 'swiss' || fam === 'minimal' || fam === 'editorial') {
    g.items.push({ type: 'line', x1: x, y1: y, x2: x + w, y2: y, stroke: opts.accent ?? (fam === 'swiss' ? c.ink : c.line), width: fam === 'swiss' ? 3 : 1.25 });
    return { x, y: y + 18, w, h: h - 18 };
  }
  g.items.push({ type: 'rect', x, y, w, h, fill: c.surface, radius: s.radius, shadow: fam === 'studio', stroke: fam === 'boardroom' ? c.line : null, strokeWidth: 1 });
  if (opts.accentBar) g.items.push({ type: 'rect', x, y, w: 6, h, fill: opts.accent ?? c.primary, radius: 0 });
  return { x: x + 24, y: y + 22, w: w - 48, h: h - 44 };
}

/** One of the slide's pictures, the first unless `slot` says another; a drawn place for it when it has none. */
function picture(g, x, y, w, h, opts = {}) {
  const { slide, c } = g;
  const slot = opts.slot ?? 0, src = slide[PICTURES[slot]];
  if (src) {
    g.items.push({ type: 'image', x, y, w, h, src, fit: 'cover', radius: opts.radius ?? 0, alt: opts.alt ?? slide.imageAlt, role: 'image', slot });
  } else {
    g.items.push({ type: 'rect', x, y, w, h, fill: { type: 'linear', angle: 160, stops: [{ at: 0, color: mix(c.surface, c.primary, 0.18) }, { at: 1, color: mix(c.surface, c.accent, 0.22) }] }, radius: opts.radius ?? 0, role: 'image', slot });
    const cx = x + w / 2, cy = y + h / 2;
    g.items.push({ type: 'path', points: [[cx - 70, cy + 40], [cx - 20, cy - 20], [cx + 10, cy + 12], [cx + 32, cy - 6], [cx + 70, cy + 40]], closed: true, fill: c.primary, alpha: 0.28 });
    g.items.push({ type: 'ellipse', x: cx + 26, y: cy - 52, w: 22, h: 22, fill: c.accent, alpha: 0.5 });
    if (g.ctx.editing) g.items.push(text({ x, y: cy + 56, w, h: 24, size: 15, align: 'center', color: mix(c.ink, c.surface, 0.35), font: g.fonts.body, text: 'Drop a picture here', markdown: false, role: 'hint', slot }));
  }
}

// ---- The layouts -------------------------------------------------------------------------------

const LAYOUT_FUNCTIONS = {
  Title(g) {
    const { W, H, X, slide, theme, c } = g;
    const fam = theme.family;
    const w = fam === 'boardroom' ? W * 0.7 - 2 * X : W - 2 * X - (fam === 'keynote' ? W * 0.12 : 0);
    if (fam === 'swiss') {
      g.items.push({ type: 'rect', x: X, y: 96, w: 96, h: 96, fill: c.primary });
      kicker(g, slide.kicker, X, H - 318, w);
      title(g, slide.title, X, H - 284, w, 196, { size: 76, min: 40, lineHeight: 1.0 });
      if (shows(g, 'body')) body(g, slide.body, X, H - 82, w, 40, { size: 18, color: g.bg.muted, min: 13 });
      return;
    }
    if (fam === 'editorial') {
      g.items.push({ type: 'line', x1: X, y1: 64, x2: W - X, y2: 64, stroke: c.ink, width: 1.5 });
      g.items.push({ type: 'line', x1: X, y1: 70, x2: W - X, y2: 70, stroke: c.ink, width: 0.75 });
      kicker(g, slide.kicker, X, 196, W - 2 * X, { spec: { align: 'center' } });
      title(g, slide.title, X + 60, 240, W - 2 * X - 120, 230, { size: 68, min: 36, align: 'center', lineHeight: 1.05 });
      if (shows(g, 'body')) body(g, slide.body, X, H - 150, W - 2 * X, 60, { size: 20, color: g.bg.muted, align: 'center', min: 13 });
      g.items.push({ type: 'line', x1: W / 2 - 40, y1: H - 176, x2: W / 2 + 40, y2: H - 176, stroke: c.primary, width: 2 });
      return;
    }
    if (fam === 'minimal') {
      kicker(g, slide.kicker, X, H * 0.30, w);
      title(g, slide.title, X, H * 0.30 + 34, w * 0.86, 230, { size: 72, min: 36, lineHeight: 1.04 });
      g.items.push({ type: 'line', x1: X, y1: H - 120, x2: W - X, y2: H - 120, stroke: c.line, width: 1 });
      if (shows(g, 'body')) body(g, slide.body, X, H - 104, w, 50, { size: 18, color: g.bg.muted, min: 13 });
      return;
    }
    // keynote, boardroom, studio: title low on the left, on the stage or the fill.
    const top = fam === 'boardroom' ? H * 0.32 : H * 0.36;
    kicker(g, slide.kicker, X, top - 44, w, { onFeature: fam === 'studio' });
    const used = title(g, slide.title, X, top, w, 230, { size: fam === 'boardroom' ? 56 : 70, min: 34, lineHeight: 1.04 });
    if (fam === 'keynote') g.items.push({ type: 'rect', x: X, y: top + used + 30, w: 72, h: 6, fill: c.accent, radius: 3 });
    if (shows(g, 'body')) body(g, slide.body, X, top + used + (fam === 'keynote' ? 58 : 36), w * 0.8, 90, { size: 22, color: g.bg.muted, min: 14 });
  },

  Section(g) {
    const { W, H, X, slide, theme, c } = g;
    const fam = theme.family;
    const number = slide.kicker || '';
    if (fam === 'editorial' || fam === 'minimal' || fam === 'swiss') {
      const numberColor = fam === 'swiss' ? g.bg.ink : fam === 'editorial' ? holdContrast(c.accent, g.bg.base, 3) : c.accentText;
      if (shows(g, 'kicker')) g.items.push(text({ x: X, y: H * 0.22, w: 360, h: 220, size: fam === 'minimal' ? 140 : 190, weight: fam === 'swiss' ? 700 : 300, font: fam === 'minimal' ? g.fonts.mono : g.fonts.heading,
        color: numberColor, text: number, markdown: false, lineHeight: 1, role: 'kicker', tracking: -0.04, src: whole('kicker', 'plain') }));
      const tx = shows(g, 'kicker') ? X + 400 : X;
      const used = title(g, slide.title, tx, H * 0.36, W - tx - X, 200, { size: 56, min: 30, lineHeight: 1.05 });
      if (shows(g, 'body')) body(g, slide.body, tx, H * 0.36 + used + 24, W - tx - X, 100, { size: 22, color: g.bg.muted, min: 14 });
      return;
    }
    kicker(g, number, X, H * 0.34 - 40, W - 2 * X, { onFeature: fam === 'studio' });
    const used = title(g, slide.title, X, H * 0.34, W - 2 * X - 120, 200, { size: 60, min: 32, lineHeight: 1.05 });
    if (fam === 'keynote') g.items.push({ type: 'rect', x: X, y: H * 0.34 + used + 28, w: 72, h: 6, fill: c.accent, radius: 3 });
    if (shows(g, 'body')) body(g, slide.body, X, H * 0.34 + used + 56, W - 2 * X - 200, 100, { size: 22, color: g.bg.muted, min: 14 });
  },

  Statement(g) {
    const { W, H, X, slide, theme, c } = g;
    const fam = theme.family;
    if (fam === 'editorial' || fam === 'swiss' || fam === 'minimal' || fam === 'boardroom') g.items.push({ type: 'rect', x: X, y: H * 0.26, w: fam === 'minimal' ? 24 : 56, h: fam === 'minimal' ? 2 : 6, fill: c.primary });
    const ky = kicker(g, slide.kicker, X, H * 0.26 + 22, W - 2 * X);
    title(g, slide.title, X, ky + 14, W - 2 * X - 80, H * 0.5, { size: 60, min: 30, lineHeight: 1.1, weight: Math.max(theme.style.titleWeight, fam === 'minimal' ? 300 : 500) });
  },

  Bullets(g) {
    const { W, H, X, slide } = g;
    const top = header(g);
    body(g, slide.body, X, top, W - 2 * X - (W > 1000 ? 120 : 0), H - top - 76, { bullets: false, build: true });
  },

  'Title only'(g) {
    const { W, H, X, slide } = g;
    const top = header(g);
    const h = H - top - 76;
    // The space under the title is free: a picture fills it whole, and PowerPoint gets it empty to draw in.
    if (slide.image) g.items.push({ type: 'image', x: X, y: top, w: W - 2 * X, h, src: slide.image, fit: 'contain', align: 'center', alt: slide.imageAlt, role: 'image', slot: 0 });
    else if (g.ctx.editing) g.items.push(text({ x: X, y: top + h / 2 - 14, w: W - 2 * X, h: 28, size: 16, align: 'center', color: g.bg.muted, font: g.fonts.body,
      text: 'Free space. Drop a picture here, or draw in it in PowerPoint.', markdown: false, role: 'hint', ghost: true, slot: 0 }));
  },

  'Two columns'(g) {
    const { W, H, X, slide } = g;
    const top = header(g);
    const gap = 64, w = (W - 2 * X - gap) / 2;
    const size = Math.min(bodySize(paragraphs(slide.body)), bodySize(paragraphs(slide.body2)), 26);
    const a = body(g, slide.body, X, top, w, H - top - 76, { size, build: true });
    const b = body(g, slide.body2, X + w + gap, top, w, H - top - 76, { size, role: 'body2', build: true });
    alike([a, b]);
    g.items.push({ type: 'line', x1: X + w + gap / 2, y1: top + 4, x2: X + w + gap / 2, y2: H - 96, stroke: g.c.line, width: 1 });
  },

  Comparison(g) {
    const { W, H, X, slide, c } = g;
    const top = header(g);
    const gap = 40, w = (W - 2 * X - gap) / 2, h = H - top - 80;
    const sides = [[slide.body, c.primary, 'body'], [slide.body2, c.accent, 'body2']];
    const fitted = [];
    sides.forEach(([value, colour, role], i) => {
      const x = X + i * (w + gap);
      const paras = paragraphs(value);
      const head = paras[0]?.heading ? paras.shift() : null;
      const from = g.items.length, step = nextStep(g);
      const inner = card(g, x, top, w, h, { accent: colour });
      const fam = g.theme.family;
      let y = inner.y;
      if (head) {
        if (fam !== 'swiss' && fam !== 'minimal' && fam !== 'editorial') {
          g.items.push({ type: 'rect', x, y: top, w, h: 64, fill: colour, radius: g.s.radius });
          if (g.s.radius) g.items.push({ type: 'rect', x, y: top + 40, w, h: 24, fill: colour });
          const band = text({ x: x + 24, y: top + 16, w: w - 48, h: 34, size: 24, weight: 600, font: g.fonts.heading, color: readableOn(colour, '#FFFFFF', c.ink), paragraphs: [{ runs: head.runs, level: 0 }], role, src: whole(role, 'blocks', `${role}.head`, 0, true) });
          fit(band, g.measure, 14);
          g.items.push(band);
          y = top + 88;
        } else {
          const heading = text({ x: inner.x, y, w: inner.w, h: 36, size: 26, weight: 700, font: g.fonts.heading, color: holdContrast(colour, g.bg.base, 3), paragraphs: [{ runs: head.runs, level: 0 }], role, src: whole(role, 'blocks', `${role}.head`, 0, true) });
          fit(heading, g.measure, 14);
          g.items.push(heading);
          y += 50;
        }
      }
      const p = text({ x: inner.x, y, w: inner.w, h: top + h - y - 22, size: 22, font: g.fonts.body, color: fam === 'swiss' || fam === 'minimal' || fam === 'editorial' ? g.bg.ink : c.onSurface, lineHeight: 1.3,
        paragraphs: paras.length || !editing ? paras.map(p => ({ ...p, bullet: p.bullet ?? 'bullet' })) : [{ runs: [{ text: '' }], level: 0 }], bulletChar: g.s.bullet, bulletColor: holdContrast(colour, c.surface, 3), role,
        src: whole(role, 'blocks', role, head ? 1 : 0) });
      fit(p, g.measure, 14);
      g.items.push(p); fitted.push(p);
      stepParagraphs(g, p, true);
      stepFrom(g, from, step);
    });
    alike(fitted);
  },

  'Image left'(g) { imageSplit(g, 'left'); },
  'Image right'(g) { imageSplit(g, 'right'); },

  'Full image'(g) {
    const { W, H, X, slide } = g;
    picture(g, 0, 0, W, H);
    g.items.push({ type: 'rect', x: 0, y: H * 0.38, w: W, h: H * 0.62, fill: { type: 'linear', angle: 180, stops: [{ at: 0, color: '#000000', alpha: 0 }, { at: 1, color: '#000000', alpha: 0.72 }] } });
    const ky = kicker(g, slide.kicker, X, H - 210, W - 2 * X, { color: '#FFFFFF', plain: true });
    title(g, slide.title, X, ky > H - 210 ? ky + 8 : H - 200, W - 2 * X - 160, 150, { size: 52, min: 28, color: '#FFFFFF', valign: 'top' });
  },

  'Picture grid'(g) {
    const { W, H, X, slide, theme } = g;
    const top = header(g);
    const at = rowCells(slide.body).slice(0, 4);
    // As many places as the last picture or the last caption needs, two to four.
    const last = PICTURES.reduce((n, key, i) => slide[key] ? i + 1 : n, 0);
    const n = Math.min(4, Math.max(2, last, at.length));
    const square = n === 4 && W < 1200;
    const cols = square ? 2 : n, rowsN = square ? 2 : 1, gap = 24, captionH = at.length ? 44 : 0;
    const w = (W - 2 * X - gap * (cols - 1)) / cols, cellH = (H - top - 76 - gap * (rowsN - 1)) / rowsN;
    const captions = [];
    for (let i = 0; i < n; i++) {
      const x = X + (i % cols) * (w + gap), y = top + Math.floor(i / cols) * (cellH + gap);
      const caption = at[i]?.[0];
      const from = g.items.length, step = nextStep(g);
      picture(g, x, y, w, cellH - captionH, { radius: Math.min(theme.style.radius, 12), slot: i, alt: (i === 0 && slide.imageAlt) || caption?.text || '' });
      if (caption?.text || keeps(caption)) {
        const t = text({ x, y: y + cellH - captionH + 10, w, h: captionH - 10, size: 18, font: g.fonts.body, color: g.bg.muted, text: caption.text, role: 'body', lineHeight: 1.2, src: cell(caption, 'body.0') });
        captions.push(t); g.items.push(t);
      }
      stepFrom(g, from, step);
    }
    for (const p of captions) fit(p, g.measure, 12);
    if (captions.length) alike(captions);
  },

  Quote(g) {
    const { W, H, X, slide, c, theme } = g;
    const fam = theme.family;
    g.items.push(text({ x: X - 8, y: 40, w: 200, h: 200, size: 220, font: fam === 'swiss' ? g.fonts.heading : 'Georgia', weight: 700, color: g.bg.accent, text: '“', markdown: false, lineHeight: 1, role: 'deco' }));
    const p = text({ x: X + 40, y: 170, w: W - 2 * X - 120, h: H - 330, size: 46, weight: fam === 'swiss' ? 700 : 400, font: g.fonts.heading, italic: fam === 'editorial', color: g.bg.ink, lineHeight: 1.18,
      tracking: theme.style.titleTracking, paragraphs: paragraphs(slide.body).map(p => ({ ...p, bullet: null })), role: 'body', valign: 'middle', src: whole('body', 'blocks') });
    if (!p.paragraphs.length) { p.paragraphs = [{ runs: [{ text: g.ctx.editing ? 'The quote' : '' }], level: 0 }]; p.ghost = !!g.ctx.editing; }
    fit(p, g.measure, 24);
    g.items.push(p);
    if (shows(g, 'kicker')) {
      g.items.push({ type: 'rect', x: X + 40, y: H - 132, w: 40, h: 3, fill: c.primary });
      g.items.push(text({ x: X + 96, y: H - 146, w: W - 2 * X - 140, h: 30, size: 20, font: g.fonts.body, weight: 600, color: g.bg.muted, text: slide.kicker, markdown: false, role: 'kicker', src: whole('kicker', 'plain') }));
    }
  },

  'Big numbers'(g) {
    const { W, H, X, slide, c, theme } = g;
    const top = header(g);
    const at = rowCells(slide.body).slice(0, 4);
    const items = at.map(r => r.map(x => x.text));
    const list = items.length ? items : g.ctx.editing ? [['42%', 'What it counts'], ['3×', 'What it counts'], ['12', 'What it counts']] : [];
    const n = Math.max(1, list.length), gap = 32, w = (W - 2 * X - gap * (n - 1)) / n, h = Math.min(320, H - top - 90);
    const valueSize = n <= 2 ? 120 : n === 3 ? 96 : 80;
    const values = [];
    list.forEach(([value, label, note], i) => {
      const x = X + i * (w + gap);
      const from = g.items.length, step = nextStep(g);
      const inner = card(g, x, top, w, h, { accent: i === 0 ? c.primary : c.line });
      const onSurface = ['swiss', 'minimal', 'editorial'].includes(theme.family) ? g.bg.ink : c.onSurface;
      const v = text({ x: inner.x, y: inner.y, w: inner.w, h: valueSize * 1.1, size: valueSize, weight: 700, font: g.fonts.heading, tracking: -0.03, lineHeight: 1,
        color: holdContrast(i % 2 ? c.accent : c.primary, ['swiss', 'minimal', 'editorial'].includes(theme.family) ? g.bg.base : c.surface, 3), text: value ?? '', markdown: false, role: 'body', ghost: !items.length, src: cell(at[i]?.[0], 'body.0', true) });
      values.push(v); g.items.push(v);
      g.items.push(text({ x: inner.x, y: inner.y + valueSize * 1.1 + 14, w: inner.w, h: 64, size: 22, weight: 600, font: g.fonts.body, color: onSurface, text: label ?? '', role: 'body', lineHeight: 1.2, src: cell(at[i]?.[1], 'body.1') }));
      if (note || keeps(at[i]?.[2])) g.items.push(text({ x: inner.x, y: inner.y + valueSize * 1.1 + 84, w: inner.w, h: inner.h - valueSize * 1.1 - 84, size: 16, font: g.fonts.body, color: ['swiss', 'minimal', 'editorial'].includes(theme.family) ? g.bg.muted : mix(onSurface, c.surface, 0.3), text: note, role: 'body', lineHeight: 1.3, src: cell(at[i]?.[2], 'body.2') }));
      stepFrom(g, from, step);
    });
    for (const v of values) fit(v, g.measure, 36);
    const shared = Math.min(...values.map(v => v.size)); values.forEach(v => { v.size = shared; });
  },

  Agenda(g) {
    const { W, H, X, slide, c } = g;
    const top = header(g);
    const at = rowCells(slide.body).slice(0, 10);
    const items = at.map(r => r.map(x => x.text));
    const cols = items.length > 5 ? 2 : 1;
    const per = Math.ceil(items.length / cols) || 1;
    const colW = (W - 2 * X - (cols - 1) * 56) / cols;
    const rowH = Math.min(84, (H - top - 80) / per);
    items.forEach(([item, note], i) => {
      const col = Math.floor(i / per), row = i % per;
      const x = X + col * (colW + 56), y = top + row * rowH;
      const from = g.items.length, step = nextStep(g);
      g.items.push(text({ x, y, w: 64, h: rowH, size: Math.min(34, rowH * 0.55), weight: 700, font: g.fonts.heading, color: g.bg.accent, text: String(i + 1).padStart(2, '0'), markdown: false, role: 'body', lineHeight: 1 }));
      const t = text({ x: x + 76, y: y + 2, w: colW - 76, h: rowH * 0.5, size: Math.min(26, rowH * 0.36), weight: 600, font: g.fonts.body, color: g.bg.ink, text: item, role: 'body', lineHeight: 1.15, src: cell(at[i][0], 'body.0') });
      fit(t, g.measure, 15); g.items.push(t);
      if (note || keeps(at[i][1])) g.items.push(text({ x: x + 76, y: y + rowH * 0.42, w: colW - 76, h: rowH * 0.45, size: Math.min(17, rowH * 0.24), font: g.fonts.body, color: g.bg.muted, text: note, role: 'body', src: cell(at[i][1], 'body.1') }));
      if (row < per - 1) g.items.push({ type: 'line', x1: x + 76, y1: y + rowH - 8, x2: x + colW, y2: y + rowH - 8, stroke: c.line, width: 1 });
      stepFrom(g, from, step);
    });
  },

  Timeline(g) {
    const { W, H, X, slide, c } = g;
    const top = header(g);
    const at = rowCells(slide.body).slice(0, 6);
    const items = at.map(r => r.map(x => x.text));
    const n = Math.max(items.length, 1);
    const lineY = top + 92, stepW = (W - 2 * X) / n;
    g.items.push({ type: 'line', x1: X, y1: lineY, x2: W - X, y2: lineY, stroke: c.line, width: 3 });
    items.forEach(([when, what, detail], i) => {
      const x = X + i * stepW, cx = x + 12;
      const colour = i === n - 1 ? c.accent : c.primary;
      const from = g.items.length, step = nextStep(g);
      g.items.push(text({ x, y: lineY - 64, w: stepW - 20, h: 40, size: 26, weight: 700, font: g.fonts.heading, color: holdContrast(colour, g.bg.base, 3), text: when ?? '', markdown: false, role: 'body', lineHeight: 1.1, src: cell(at[i][0], 'body.0', true) }));
      g.items.push({ type: 'ellipse', x: cx - 12, y: lineY - 12, w: 24, h: 24, fill: colour, stroke: g.bg.base === c.bg ? c.bg : null, strokeWidth: 4 });
      const t = text({ x, y: lineY + 34, w: stepW - 28, h: 64, size: 22, weight: 600, font: g.fonts.body, color: g.bg.ink, text: what ?? '', role: 'body', lineHeight: 1.2, src: cell(at[i][1], 'body.1') });
      fit(t, g.measure, 14); g.items.push(t);
      if (detail || keeps(at[i][2])) { const d = text({ x, y: lineY + 104, w: stepW - 28, h: H - lineY - 190, size: 16, font: g.fonts.body, color: g.bg.muted, text: detail, role: 'body', lineHeight: 1.35, src: cell(at[i][2], 'body.2') }); fit(d, g.measure, 12); g.items.push(d); }
      stepFrom(g, from, step);
    });
  },

  Process(g) {
    const { W, H, X, slide, c } = g;
    const top = header(g);
    const at = rowCells(slide.body).slice(0, 6);
    const n = Math.max(at.length, 1);
    // Chevrons that nest: each one's point goes into the notch of the next, `gap` apart.
    const gap = 10, h = 104, tip = 34;
    const w = (W - 2 * X + (n - 1) * (tip - gap)) / n;
    const heads = [], details = [];
    at.forEach((row, i) => {
      const x = X + i * (w + gap - tip), y = top + 8;
      const fill = i === n - 1 && n > 1 ? c.accent : c.primary;
      const from = g.items.length, step = nextStep(g);
      const points = [[x, y], [x + w - tip, y], [x + w, y + h / 2], [x + w - tip, y + h], [x, y + h]];
      if (i > 0) points.push([x + tip, y + h / 2]);
      g.items.push({ type: 'path', points, closed: true, fill });
      const inset = i > 0 ? tip : 14;
      const head = text({ x: x + inset, y, w: w - tip - inset - 8, h, size: 22, weight: 700, font: g.fonts.heading, color: readableOn(fill, '#FFFFFF', c.ink), align: 'center', valign: 'middle',
        text: row[0]?.text ?? '', role: 'body', lineHeight: 1.12, src: cell(row[0], 'body.0') });
      heads.push(head); g.items.push(head);
      if (row[1]?.text || keeps(row[1])) {
        const d = text({ x: x + (i > 0 ? tip / 2 : 0), y: y + h + 24, w: w - tip - 4, h: H - y - h - 24 - 80, size: 18, font: g.fonts.body, color: g.bg.ink, text: row[1].text, role: 'body', lineHeight: 1.35, src: cell(row[1], 'body.1') });
        details.push(d); g.items.push(d);
      }
      stepFrom(g, from, step);
    });
    for (const p of heads) fit(p, g.measure, 12);
    for (const p of details) fit(p, g.measure, 12);
    if (heads.length) alike(heads);
    if (details.length) alike(details);
  },

  Cycle(g) {
    const { W, H, X, slide, c } = g;
    const top = header(g);
    const at = rowCells(slide.body).slice(0, 6);
    const n = at.length;
    if (!n) return;
    const areaH = H - top - 70;
    const r = Math.min(areaH / 2 - 36, (W - 2 * X) * 0.18), cx = W / 2, cy = top + areaH / 2;
    const node = n > 4 ? 52 : 60;
    // A step's words stand beside it, no taller than the room to the next step down.
    const labelH = Math.min(100, Math.max(60, r * (1 - Math.cos(2 * Math.PI / n))));
    const at360 = deg => { const a = deg * Math.PI / 180; return { x: cx + r * Math.sin(a), y: cy - r * Math.cos(a), a }; };
    g.items.push({ type: 'ellipse', x: cx - r, y: cy - r, w: 2 * r, h: 2 * r, fill: null, stroke: c.line, strokeWidth: 3 });
    const heads = [], details = [], stepOf = [];
    at.forEach((row, i) => {
      const p = at360(i * 360 / n);
      const colour = [c.primary, c.accent, c.secondary][i % 3];
      const from = g.items.length, step = nextStep(g);
      stepOf.push(step);
      g.items.push({ type: 'ellipse', x: p.x - node / 2, y: p.y - node / 2, w: node, h: node, fill: colour, stroke: g.bg.base === c.bg ? c.bg : null, strokeWidth: 4 });
      g.items.push(text({ x: p.x - node / 2, y: p.y - node / 2, w: node, h: node, size: Math.round(node * 0.42), weight: 700, font: g.fonts.heading, color: readableOn(colour, '#FFFFFF', c.ink),
        align: 'center', valign: 'middle', text: String(i + 1), markdown: false, role: 'deco', lineHeight: 1 }));
      // Steps on the right half, and the top and the foot, read from the node out; the left half towards it.
      const right = Math.sin(p.a) > -0.01;
      // At the top and the foot of five or six, the words start past the arrow beside the step.
      const past = Math.abs(Math.sin(p.a)) < 0.01 && n >= 5 ? r * Math.sin(Math.PI / n) + 20 : 0;
      const lx = right ? p.x + Math.max(node / 2 + 18, past) : X, lw = right ? W - X - lx : p.x - node / 2 - 18 - X;
      // The step at the foot has its words lower, clear of the ring rising beside it, and above the footer.
      const foot = Math.cos(p.a) < -0.99;
      const ly = foot ? p.y - 16 : p.y - labelH / 2, labelBox = foot ? Math.min(labelH, H - 50 - ly) : labelH, align = right ? 'left' : 'right';
      const head = text({ x: lx, y: ly, w: lw, h: 32, size: 22, weight: 700, font: g.fonts.heading, color: g.bg.ink, align, text: row[0]?.text ?? '', role: 'body', lineHeight: 1.15, src: cell(row[0], 'body.0') });
      heads.push(head); g.items.push(head);
      if (row[1]?.text || keeps(row[1])) {
        const d = text({ x: lx, y: ly + 34, w: lw, h: labelBox - 34, size: 16, font: g.fonts.body, color: g.bg.muted, align, text: row[1].text, role: 'body', lineHeight: 1.3, src: cell(row[1], 'body.1') });
        details.push(d); g.items.push(d);
      }
      stepFrom(g, from, step);
    });
    // An arrow half way to each next step, clockwise, comes on with that step; the one back to the first, with the last.
    if (n > 1) for (let i = 0; i < n; i++) {
      const p = at360((i + 0.5) * 360 / n), s = 11;
      const tx = Math.cos(p.a), ty = Math.sin(p.a), nx = Math.sin(p.a), ny = -Math.cos(p.a);
      const arrow = { type: 'path', closed: true, fill: g.bg.muted, points: [[p.x + tx * s, p.y + ty * s], [p.x - tx * s * 0.6 + nx * s * 0.8, p.y - ty * s * 0.6 + ny * s * 0.8], [p.x - tx * s * 0.6 - nx * s * 0.8, p.y - ty * s * 0.6 - ny * s * 0.8]] };
      const step = stepOf[i + 1 < n ? i + 1 : n - 1];
      if (step) arrow.step = step;
      g.items.push(arrow);
    }
    for (const p of heads) fit(p, g.measure, 13);
    for (const p of details) fit(p, g.measure, 11);
    alike(heads);
    if (details.length) alike(details);
  },

  Cards(g) {
    const { W, H, X, slide, c, theme } = g;
    const top = header(g);
    const at = rowCells(slide.body).slice(0, 6);
    const items = at.map(r => r.map(x => x.text));
    const n = Math.max(items.length, 1);
    const cols = n <= 3 ? n : n === 4 ? 2 : 3, rowsN = Math.ceil(n / cols), gap = 28;
    const w = (W - 2 * X - gap * (cols - 1)) / cols, h = (H - top - 80 - gap * (rowsN - 1)) / rowsN;
    const flat = ['swiss', 'minimal', 'editorial'].includes(theme.family);
    const heads = [], texts = [];
    items.forEach(([head, detail], i) => {
      const x = X + (i % cols) * (w + gap), y = top + Math.floor(i / cols) * (h + gap);
      const accent = [c.primary, c.accent, c.secondary][i % 3];
      const from = g.items.length, step = nextStep(g);
      const inner = card(g, x, y, w, h, { accentBar: !flat && theme.family === 'boardroom', accent });
      if (!flat && theme.family !== 'boardroom') g.items.push({ type: 'ellipse', x: inner.x, y: inner.y, w: 14, h: 14, fill: accent });
      const off = !flat && theme.family !== 'boardroom' ? 28 : 0;
      const hp = text({ x: inner.x, y: inner.y + off, w: inner.w, h: 64, size: 24, weight: 700, font: g.fonts.heading, color: flat ? g.bg.ink : c.onSurface, text: head ?? '', role: 'body', lineHeight: 1.15, src: cell(at[i][0], 'body.0') });
      heads.push(hp); g.items.push(hp);
      const dp = text({ x: inner.x, y: inner.y + off + 70, w: inner.w, h: inner.h - off - 70, size: 18, font: g.fonts.body, color: flat ? g.bg.muted : mix(c.onSurface, c.surface, 0.25), text: detail ?? '', role: 'body', lineHeight: 1.35, src: cell(at[i][1], 'body.1') });
      texts.push(dp); g.items.push(dp);
      stepFrom(g, from, step);
    });
    for (const p of heads) fit(p, g.measure, 15);
    for (const p of texts) fit(p, g.measure, 12);
    const hs = Math.min(...heads.map(p => p.size)), ts = Math.min(...texts.map(p => p.size));
    heads.forEach(p => { p.size = hs; }); texts.forEach(p => { p.size = ts; });
  },

  Table(g) {
    const { W, H, X, slide, c, theme } = g;
    const top = header(g);
    const t = table(slide.body) ?? (g.ctx.editing ? { head: ['Column', 'Column'], rows: [['Cell', 'Cell']], align: ['left', 'left'] } : null);
    if (!t) return;
    const cols = t.head.length, rowsN = t.rows.length + 1;
    const avail = H - top - 80;
    const rowH = Math.min(64, avail / rowsN);
    const size = Math.max(12, Math.min(22, rowH * 0.4));
    const widths = columnWidths(t, W - 2 * X, g.measure, size, g.fonts.body);
    const headFill = theme.family === 'minimal' || theme.family === 'editorial' ? null : c.primary;
    let x = X;
    // A row comes on with its own click; the head is there from the start.
    const base = g.steps, rowStep = r => g.build ? base + r + 1 : 0;
    if (g.build) g.steps += t.rows.length;
    if (headFill) g.items.push({ type: 'rect', x: X, y: top, w: W - 2 * X, h: rowH, fill: headFill, radius: Math.min(theme.style.radius, 8) });
    t.rows.forEach((_, r) => { if (r % 2 === 1) g.items.push({ type: 'rect', x: X, y: top + (r + 1) * rowH, w: W - 2 * X, h: rowH, fill: c.surface, step: rowStep(r) || undefined }); });
    if (!headFill) g.items.push({ type: 'line', x1: X, y1: top + rowH, x2: W - X, y2: top + rowH, stroke: c.ink, width: 1.5 });
    g.items.push({ type: 'line', x1: X, y1: top + rowsN * rowH, x2: W - X, y2: top + rowsN * rowH, stroke: c.line, width: 1 });
    t.head.forEach((name, i) => {
      const align = t.align[i] ?? 'left';
      const head = text({ x: x + 14, y: top, w: widths[i] - 28, h: rowH, size, weight: 700, font: g.fonts.body, color: headFill ? c.onPrimary : g.bg.ink, text: name, valign: 'middle', align, role: 'body', lineHeight: 1.15, src: cell(t.at?.head[i], `body.c${i}`) });
      fit(head, g.measure, 11);
      g.items.push(head);
      t.rows.forEach((row, r) => {
        const p = text({ x: x + 14, y: top + (r + 1) * rowH, w: widths[i] - 28, h: rowH, size, font: g.fonts.body, color: r % 2 === 1 ? c.onSurface : g.bg.ink, text: row[i], valign: 'middle', align, role: 'body', lineHeight: 1.15, weight: i === 0 ? 600 : 400, src: cell(t.at?.rows[r][i], `body.c${i}`) });
        fit(p, g.measure, 11);
        if (rowStep(r)) p.step = rowStep(r);
        g.items.push(p);
      });
      x += widths[i];
    });
  },

  Chart(g) {
    const { W, H, X, slide, c } = g;
    const top = header(g);
    const data = chartData(slide.body) ?? (g.ctx.editing ? { labels: ['A', 'B', 'C', 'D'], series: [{ name: 'Series', values: [3, 5, 4, 7] }], unit: '' } : null);
    const takeaway = !!slide.body2?.trim() || shows(g, 'body2', '');
    const chartW = takeaway ? (W - 2 * X) * 0.64 : W - 2 * X;
    if (data) drawChart(g, slide.chart, data, X, top, chartW, H - top - 84);
    if (takeaway) {
      const x = X + chartW + 48, w = W - X - x;
      g.items.push({ type: 'rect', x, y: top + 8, w: 6, h: 64, fill: c.accent });
      const from = g.items.length - 1, step = nextStep(g);
      body(g, slide.body2, x + 26, top, w - 26, H - top - 90, { size: 26, role: 'body2', min: 15 });
      stepFrom(g, from, step);
    }
  },

  Closing(g) {
    const { W, H, X, slide, theme } = g;
    const fam = theme.family;
    const center = fam !== 'swiss';
    const ky = kicker(g, slide.kicker, X, H * 0.26, W - 2 * X, { onFeature: fam === 'studio', spec: center ? { align: 'center' } : {} });
    if (center && theme.style.kicker === 'pill' && ky > H * 0.26) {
      // A pill is drawn from its left edge; centre the pill and its words together.
      const pill = g.items.at(-2), words = g.items.at(-1);
      const shift = (W - pill.w) / 2 - pill.x; pill.x += shift; words.x += shift;
    }
    const used = title(g, slide.title, X, ky + 16, W - 2 * X, 200, { size: 76, min: 36, align: center ? 'center' : 'left', lineHeight: 1.04 });
    if (shows(g, 'body')) body(g, slide.body, center ? X + 120 : X, ky + used + 52, W - 2 * X - (center ? 240 : 0), 160, { size: 22, color: g.bg.muted, align: center ? 'center' : 'left', min: 14 });
  },
};

function imageSplit(g, side) {
  const { W, H, slide, theme } = g;
  const half = W * 0.5;
  const inset = theme.family === 'studio' ? 28 : 0;
  const ix = side === 'left' ? inset : half - (theme.family === 'studio' ? 0 : 0);
  picture(g, side === 'left' ? inset : half, inset, half - inset, H - 2 * inset, { radius: inset ? theme.style.radius : 0 });
  void ix;
  const x = side === 'left' ? half + 56 : g.X, w = half - 56 - g.X;
  const top = header(g, { x, w, titleSize: 38, minTop: 200 });
  body(g, slide.body, x, top, w, H - top - 76, { size: Math.min(24, bodySize(paragraphs(slide.body))), build: true });
}

function columnWidths(t, total, measure, size, font) {
  const want = t.head.map((h, i) => Math.max(measure(h, { size, weight: 700, font }), ...t.rows.map(r => measure(r[i] ?? '', { size, font }))) + 28);
  const sum = want.reduce((a, b) => a + b, 0);
  if (sum <= total) return want.map(w => w * total / sum);
  const floor = total / t.head.length * 0.5;
  const scaled = want.map(w => Math.max(floor, w * total / sum));
  const k = total / scaled.reduce((a, b) => a + b, 0);
  return scaled.map(w => w * k);
}

/** Charts are drawn as shapes, so they look the same in the stage, the HTML and PowerPoint. */
function drawChart(g, type, data, x, y, w, h) {
  const { c } = g;
  const palette = g.theme.chart?.length ? g.theme.chart : [c.primary, c.accent, c.secondary, mix(c.primary, c.bg, 0.45)];
  const ink = g.bg.ink, muted = g.bg.muted;
  // Built, a chart's marks come a click each: a doughnut's parts, one series' bars by label, more
  // series by series. The axes, the grid and the labels are there from the start.
  const base = g.steps;
  const mark = (p, i) => { if (g.build) { p.step = base + i + 1; g.steps = Math.max(g.steps, p.step); } g.items.push(p); };
  // A doughnut or a pie shows one column, its first, and names its parts beside it: no series legend above.
  const round = type === 'Doughnut' || type === 'Pie';
  const legend = data.series.length > 1 && !round;
  if (legend) {
    let lx = x;
    data.series.forEach((s, i) => {
      g.items.push({ type: 'rect', x: lx, y: y + 4, w: 14, h: 14, fill: palette[i % palette.length], radius: 3 });
      g.items.push(text({ x: lx + 22, y: y, w: 220, h: 22, size: 15, font: g.fonts.body, color: muted, text: s.name, markdown: false, role: 'chart' }));
      lx += 40 + g.measure(s.name, { size: 15, font: g.fonts.body });
    });
    y += 38; h -= 38;
  }
  if (round) {
    // The middle says the data's own total, nought included; only the sweep needs a share of something.
    const values = data.series[0].values.map(v => Math.max(0, v)), total = values.reduce((a, b) => a + b, 0), share = total || 1;
    const r = Math.min(h, w * 0.5) / 2, cx = x + r + 10, cy = y + h / 2;
    let at = 0;
    const parts = g.theme.chart?.length ? g.theme.chart : [c.primary, c.accent, c.secondary, mix(c.primary, c.bg, 0.5), mix(c.accent, c.bg, 0.5), mix(c.secondary, c.bg, 0.5)];
    const colours = values.map((_, i) => parts[i % parts.length]);
    values.forEach((v, i) => {
      const sweep = v / share * 360;
      if (sweep > 0) mark({ type: 'arc', cx, cy, r, inner: type === 'Pie' ? 0 : r * 0.58, start: at, end: at + Math.min(sweep, 359.99), fill: colours[i] }, i);
      at += sweep;
    });
    // A doughnut says the total in its middle, and under it which column it is; a pie has no middle.
    if (type === 'Doughnut') g.items.push(text({ x: cx - r * 0.5, y: cy - 30, w: r, h: 60, size: 40, weight: 700, font: g.fonts.heading, color: ink, align: 'center', valign: 'middle', text: formatNumber(total, data.unit), markdown: false, role: 'chart', lineHeight: 1 }));
    if (type === 'Doughnut' && data.series.length > 1) g.items.push(text({ x: cx - r * 0.6, y: cy + 28, w: r * 1.2, h: 22, size: 15, font: g.fonts.body, color: muted, align: 'center', text: data.series[0].name, markdown: false, role: 'chart' }));
    // With more than one column, the editor says the others are not drawn.
    if (data.series.length > 1 && g.ctx.editing) g.items.push(text({ x, y: y + h - 22, w, h: 22, size: 14, font: g.fonts.body, color: muted, text: `A ${type.toLowerCase()} draws the first column only; ${data.series.slice(1).map(s => s.name).join(', ')} ${data.series.length > 2 ? 'are' : 'is'} not drawn.`, markdown: false, role: 'hint', ghost: true }));
    const lx = cx + r + 48, rowH = Math.min(44, h / values.length);
    data.labels.forEach((label, i) => {
      const ly = cy - (values.length * rowH) / 2 + i * rowH;
      mark({ type: 'rect', x: lx, y: ly + rowH / 2 - 8, w: 16, h: 16, fill: colours[i], radius: 4 }, i);
      mark(text({ x: lx + 28, y: ly, w: x + w - lx - 28, h: rowH, size: Math.min(20, rowH * 0.5), font: g.fonts.body, color: ink, valign: 'middle', role: 'chart',
        paragraphs: [{ runs: [{ text: label + '  ' }, { text: formatNumber(values[i], data.unit), b: true }], level: 0 }] }), i);
    });
    return;
  }
  const stacked = type === 'Stacked';
  // A stack reaches the sum of its values each way: the positive ones up, the negative ones down.
  const all = stacked ? data.labels.flatMap((_, i) => [data.series.reduce((t, s) => t + Math.max(0, s.values[i]), 0), data.series.reduce((t, s) => t + Math.min(0, s.values[i]), 0)])
    : data.series.flatMap(s => s.values);
  // A signed axis: a negative value is drawn below (or left of) nought, never as nought.
  const { min, max, step } = signedScale(all);
  const frac = v => (v - min) / (max - min);
  const horizontal = type === 'Bar';
  const labelW = horizontal ? Math.min(w * 0.3, Math.max(...data.labels.map(l => g.measure(l, { size: 16, font: g.fonts.body }))) + 16) : 0;
  const scaled = horizontal && data.series.length > 1;
  const axisH = horizontal ? (scaled ? 28 : 0) : 34;
  const px = x + (horizontal ? labelW : 44), pw = w - (horizontal ? labelW : 44), ph = h - axisH - 8, py = y + 8;
  // Grid and axis labels.
  for (let v = min; v <= max + step * 1e-6; v += step) {
    if (Math.abs(v) < step * 1e-6) v = 0;
    if (horizontal) {
      const gx = px + frac(v) * pw;
      g.items.push({ type: 'line', x1: gx, y1: py, x2: gx, y2: py + ph, stroke: c.line, width: v === 0 ? 1.5 : 1, dash: v !== 0 });
      if (scaled) g.items.push(text({ x: gx - 40, y: py + ph + 6, w: 80, h: 20, size: 13, font: g.fonts.body, color: muted, align: 'center', text: formatNumber(v, data.unit, step), markdown: false, role: 'chart' }));
    } else {
      const gy = py + ph - frac(v) * ph;
      g.items.push({ type: 'line', x1: px, y1: gy, x2: px + pw, y2: gy, stroke: c.line, width: v === 0 ? 1.5 : 1, dash: v !== 0 });
      g.items.push(text({ x: x, y: gy - 10, w: 36, h: 20, size: 13, font: g.fonts.body, color: muted, align: 'right', text: formatNumber(v, data.unit, step), markdown: false, role: 'chart' }));
    }
  }
  const n = data.labels.length, k = data.series.length;
  if (type === 'Line' || type === 'Area') {
    const dx = n > 1 ? pw / (n - 1) : 0, zeroY = py + ph - frac(0) * ph;
    data.labels.forEach((label, i) => g.items.push(text({ x: px + i * dx - 60, y: py + ph + 10, w: 120, h: 22, size: 15, font: g.fonts.body, color: muted, align: 'center', text: label, markdown: false, role: 'chart' })));
    data.series.forEach((s, j) => {
      const points = s.values.map((v, i) => [px + i * dx, py + ph - frac(v) * ph]);
      // An area is the ground between the line and nought, see-through where the series cross.
      if (type === 'Area') mark({ type: 'path', points: [[px, zeroY], ...points, [px + (n - 1) * dx, zeroY]], closed: true, fill: palette[j % palette.length], alpha: k > 1 ? 0.32 : 0.42 }, j);
      mark({ type: 'path', points, closed: false, stroke: palette[j % palette.length], width: type === 'Area' ? 3 : 4 }, j);
      points.forEach(([cx, cy], i) => {
        if (type === 'Line') mark({ type: 'ellipse', x: cx - 6, y: cy - 6, w: 12, h: 12, fill: palette[j % palette.length], stroke: g.bg.base === c.bg ? c.bg : '#FFFFFF', strokeWidth: 2 }, j);
        if (k === 1) mark(text({ x: cx - 50, y: cy - 34, w: 100, h: 22, size: 15, weight: 700, font: g.fonts.body, color: ink, align: 'center', text: formatNumber(s.values[i], data.unit), markdown: false, role: 'chart' }), j);
      });
    });
    return;
  }
  if (stacked) {
    const band = pw / n, barW = band * 0.56;
    data.labels.forEach((label, i) => {
      g.items.push(text({ x: px + i * band, y: py + ph + 10, w: band, h: 22, size: 15, font: g.fonts.body, color: muted, align: 'center', text: label, markdown: false, role: 'chart' }));
      const bx = px + i * band + (band - barW) / 2;
      let up = 0, down = 0;
      data.series.forEach((s, j) => {
        const v = s.values[i];
        if (!v) return;
        const from = v > 0 ? up : down, to = from + v;
        if (v > 0) up = to; else down = to;
        const y1 = py + ph - frac(Math.max(from, to)) * ph, y2 = py + ph - frac(Math.min(from, to)) * ph;
        // A hair between the parts of a stack, so two of one colour still read as two.
        const hair = k > 1 ? 1 : 0;
        mark({ type: 'rect', x: bx, y: y1 + hair, w: barW, h: Math.max(1, y2 - y1 - 2 * hair), fill: palette[j % palette.length], radius: 0 }, k === 1 ? i : j);
      });
      // The stack's total over its top, with the last part of it.
      const total = data.series.reduce((t, s) => t + s.values[i], 0), topY = py + ph - frac(up) * ph;
      mark(text({ x: bx - 30, y: topY - 26, w: barW + 60, h: 22, size: 15, weight: 700, font: g.fonts.body, color: ink, align: 'center', text: formatNumber(total, data.unit), markdown: false, role: 'chart' }), k === 1 ? i : k - 1);
    });
    return;
  }
  const band = (horizontal ? ph : pw) / n, inner = band * 0.68, barW = inner / k;
  data.labels.forEach((label, i) => {
    if (horizontal) g.items.push(text({ x, y: py + i * band, w: labelW - 12, h: band, size: 16, font: g.fonts.body, color: ink, align: 'right', valign: 'middle', text: label, markdown: false, role: 'chart' }));
    else g.items.push(text({ x: px + i * band, y: py + ph + 10, w: band, h: 22, size: 15, font: g.fonts.body, color: muted, align: 'center', text: label, markdown: false, role: 'chart' }));
    data.series.forEach((s, j) => {
      // Each bar runs from nought to its value, either way.
      const v = s.values[i], zero = frac(0), end = frac(v), len = Math.abs(end - zero) * (horizontal ? pw : ph);
      const fill = palette[j % palette.length];
      const click = k === 1 ? i : j;
      if (horizontal) {
        const by = py + i * band + (band - inner) / 2 + j * barW, from = px + Math.min(zero, end) * pw;
        mark({ type: 'rect', x: from, y: by, w: Math.max(len, 1), h: barW - 3, fill, radius: Math.min(4, g.s.radius) }, click);
        if (k === 1) mark(text({ x: v < 0 ? from - 98 : from + len + 8, y: by, w: 90, h: barW - 3, size: 15, weight: 700, font: g.fonts.body, color: ink, align: v < 0 ? 'right' : 'left', valign: 'middle', text: formatNumber(v, data.unit), markdown: false, role: 'chart' }), click);
      } else {
        const bx = px + i * band + (band - inner) / 2 + j * barW, top = py + ph - Math.max(zero, end) * ph;
        mark({ type: 'rect', x: bx, y: top, w: barW - 4, h: Math.max(len, 1), fill, radius: Math.min(4, g.s.radius) }, click);
        if (k === 1) mark(text({ x: bx - 20, y: v < 0 ? top + len + 4 : top - 26, w: barW + 36, h: 22, size: 15, weight: 700, font: g.fonts.body, color: ink, align: 'center', text: formatNumber(v, data.unit), markdown: false, role: 'chart' }), click);
      }
    });
  });
}

/** Re-exported for renderers that need the CSS stack of a font name. */
export { fontStack };
