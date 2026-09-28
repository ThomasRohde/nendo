// Capability Atlas export: the packed map as one SVG document, for a slide or a poster.
//
// It is built from the layout, never from the screen, so the camera plays no part: every card
// the map has packed, cropped to the cards' bounds, under a title band and over the legend.
// Colours are plain hex and every style is a presentation attribute -- no CSS variables, style
// sheets, foreignObject or filters -- so PowerPoint and other editors keep the shapes as shapes
// and the text as text. Nothing here touches the page: view.js measures the text and makes the
// download, and the node tests (tools/bcm-atlas/export.test.mjs) call this directly.

/** The Workbench's light theme (src/Nendo.Workbench/src/styles/02-tokens.css), on white paper. */
export const printPalette = Object.freeze({
  canvas: '#ffffff', surface: '#ffffff', 'surface-soft': '#f1f2f5', ink: '#14171c', muted: '#5b6370',
  line: '#e2e5ea', 'line-strong': '#cdd2da',
  'tone-red': '#c93a3a', 'tone-orange': '#c75a17', 'tone-amber': '#a37608', 'tone-green': '#1f8a52',
  'tone-teal': '#16837e', 'tone-blue': '#2f63d6', 'tone-violet': '#7446d4', 'tone-grey': '#677080',
});

/** The token names the export reads from a palette. */
export const paletteTokens = Object.keys(printPalette);

// Unquoted, so the attribute holds no entity a slide editor might not decode.
export const SANS = 'Segoe UI, Arial, sans-serif';
export const MONO = 'Cascadia Code, Consolas, monospace';

// The card geometry follows view.css: 12px side padding, a 12px heading on a group, a 13px title
// of at most two lines on a leaf, and the reference and the corner figure on its last line.
const MARGIN = 24;
const fonts = {
  title: { size: 20, weight: 600, family: SANS },
  subtitle: { size: 12, weight: 400, family: SANS },
  note: { size: 10, weight: 400, family: SANS },
  branch: { size: 12, weight: 600, family: SANS },
  leaf: { size: 13, weight: 500, family: SANS },
  meta: { size: 10, weight: 400, family: SANS },
  score: { size: 10, weight: 400, family: MONO },
  legend: { size: 11, weight: 400, family: SANS },
};

/** A CSS font shorthand, for measuring with a canvas. */
export const cssFont = font => `${font.weight} ${font.size}px ${font.family}`;

const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

/** [r, g, b] of a #rgb, #rrggbb or rgb()/rgba() colour, or null. */
export function rgb(colour) {
  const text = String(colour ?? '').trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map(c => c + c).join('') : hex[1];
    return [0, 2, 4].map(i => parseInt(digits.slice(i, i + 2), 16));
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(text);
  return fn ? fn.slice(1, 4).map(Number) : null;
}

const hexOf = ([r, g, b]) => '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

/** A colour as #rrggbb, so the file names no variable and no function a slide editor may not know. */
export function hex(colour, fallback = '#000000') {
  const parts = rgb(colour);
  return parts ? hexOf(parts) : fallback;
}

/** share of tone over base, as the screen's color-mix(in srgb, tone share, base) draws a leaf. */
function mix(tone, share, base) {
  const a = rgb(tone), b = rgb(base);
  return a && b ? hexOf(a.map((value, i) => value * share + b[i] * (1 - share))) : hex(base);
}

/** text cut to fit maxWidth, with an ellipsis when anything was cut. */
function ellipsise(text, maxWidth, font, measure) {
  if (measure(text, cssFont(font)) <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && measure(`${cut}…`, cssFont(font)) > maxWidth) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/** Words set in lines of at most maxWidth; the last of maxLines takes the rest, ellipsised. */
export function wrap(text, maxWidth, maxLines, font, measure) {
  const lines = [];
  let line = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (!line || measure(next, cssFont(font)) <= maxWidth) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) lines.splice(maxLines - 1, lines.length, lines.slice(maxLines - 1).join(' '));
  return lines.map(each => ellipsise(each, maxWidth, font, measure));
}

const textAt = (x, y, font, fill, content, className) =>
  `<text${className ? ` class="${className}"` : ''} x="${x}" y="${y}" font-family="${escape(font.family)}" font-size="${font.size}" font-weight="${font.weight}" fill="${fill}">${content}</text>`;

/**
 * The map as an SVG document.
 *
 *   cards     [{ x, y, width, height, isLeaf, title, meta, score, tone }] in layout coordinates,
 *             in drawing order (a group before what it holds); tone is a tone name such as teal
 *   title     the heading; subtitle the line under it; note the file's banner, or null
 *   legend    [[label, tone]]
 *   palette   token name -> colour, for paletteTokens
 *   measure   (text, cssFont) -> width in pixels
 *
 * Returns { svg, width, height, cards } with width and height in pixels.
 */
export function mapSvg({ cards, title, subtitle, note = null, legend = [], palette, measure }) {
  if (!cards.length) throw new Error('There are no capabilities to export.');
  const colour = name => hex(palette[name], hex(printPalette[name]));
  const tone = name => colour(Object.hasOwn(printPalette, `tone-${name}`) ? `tone-${name}` : 'tone-grey');
  const left = Math.min(...cards.map(card => card.x)), top = Math.min(...cards.map(card => card.y));
  const mapWidth = Math.max(...cards.map(card => card.x + card.width)) - left;
  const mapHeight = Math.max(...cards.map(card => card.y + card.height)) - top;

  // The legend runs along the foot of the map, one entry after another.
  const legendItems = [];
  let legendWidth = 0;
  for (const [label, name] of legend) {
    legendItems.push({ x: legendWidth, label, fill: tone(name) });
    legendWidth += 14 + measure(label, cssFont(fonts.legend)) + 18;
  }
  const header = note ? 78 : 60;
  const footer = legend.length ? 34 : 0;
  const width = Math.ceil(Math.max(mapWidth, legendWidth, measure(title, cssFont(fonts.title))) + 2 * MARGIN);
  const height = Math.ceil(header + mapHeight + footer + 2 * MARGIN);

  const parts = [];
  parts.push(`<rect class="background" x="0" y="0" width="${width}" height="${height}" fill="${colour('canvas')}"/>`);
  parts.push(textAt(MARGIN, MARGIN + 18, fonts.title, colour('ink'), escape(title), 'heading'));
  parts.push(textAt(MARGIN, MARGIN + 38, fonts.subtitle, colour('muted'), escape(subtitle), 'subheading'));
  if (note) parts.push(textAt(MARGIN, MARGIN + 56, fonts.note, colour('muted'), escape(note), 'note'));

  const originX = MARGIN - left, originY = MARGIN + header - top;
  parts.push(`<g class="map" transform="translate(${originX} ${originY})">`);
  for (const card of cards) {
    const fill = card.isLeaf ? mix(tone(card.tone), 0.09, colour('surface')) : colour('surface-soft');
    const shape = `<rect class="card-shape" x="${card.x}" y="${card.y}" width="${card.width}" height="${card.height}" rx="7" ry="7" fill="${fill}" stroke="${colour('line-strong')}" stroke-width="1"/>`;
    const words = [];
    if (card.isLeaf) {
      wrap(card.title, card.width - 24, 2, fonts.leaf, measure).forEach((line, i) => {
        words.push(`<tspan x="${card.x + 12}" y="${card.y + 20 + i * 15}">${escape(line)}</tspan>`);
      });
    } else {
      words.push(`<tspan x="${card.x + 12}" y="${card.y + 19}">${escape(ellipsise(card.title, card.width - 22, fonts.branch, measure))}</tspan>`);
    }
    const font = card.isLeaf ? fonts.leaf : fonts.branch;
    const name = `<text class="title" font-family="${escape(font.family)}" font-size="${font.size}" font-weight="${font.weight}" fill="${colour('ink')}">${words.join('')}</text>`;
    const extra = [];
    if (card.isLeaf && card.meta) {
      extra.push(textAt(card.x + 12, card.y + card.height - 7, fonts.meta, colour('muted'), escape(ellipsise(card.meta, card.width - 70, fonts.meta, measure)), 'meta'));
    }
    if (card.isLeaf && card.score) {
      // Right-aligned by measuring, rather than text-anchor, which not every editor honours.
      const x = card.x + card.width - 10 - measure(card.score, cssFont(fonts.score));
      extra.push(textAt(Math.round(x * 10) / 10, card.y + card.height - 7, fonts.score, tone(card.tone), escape(card.score), 'score'));
    }
    parts.push(`<g class="card"><title>${escape(card.title)}</title>${shape}${name}${extra.join('')}</g>`);
  }
  parts.push('</g>');

  if (legendItems.length) {
    const y = MARGIN + header + mapHeight + 22;
    parts.push('<g class="legend">');
    for (const item of legendItems) {
      parts.push(`<rect x="${MARGIN + item.x}" y="${y - 9}" width="9" height="9" rx="2" ry="2" fill="${item.fill}"/>`);
      parts.push(textAt(MARGIN + item.x + 14, y, fonts.legend, colour('muted'), escape(item.label)));
    }
    parts.push('</g>');
  }

  const svg = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<title>${escape(title)}</title>`,
    ...parts,
    '</svg>',
    '',
  ].join('\n');
  return { svg, width, height, cards: cards.length };
}
