// Draws a laid-out slide as HTML: absolutely placed boxes in the slide's own pixels. The stage,
// the thumbnails, Present and the HTML export all use this, so they cannot disagree.

import { fontStack, parseHex } from './themes.mjs';
import { bulletIndent } from './layout.mjs';

export const SLIDE_CSS = `
.dk-slide{position:relative;overflow:hidden;contain:strict;-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;font-kerning:normal}
.dk-slide *{box-sizing:border-box}
.dk-slide .dk-t{position:absolute;display:flex;flex-direction:column;white-space:normal;overflow-wrap:break-word;margin:0}
.dk-slide .dk-t p{margin:0;position:relative}
.dk-slide .dk-t .dk-b{position:absolute;left:0;top:0}
.dk-slide .dk-t code{font-family:Consolas,'Cascadia Mono',monospace;font-size:.92em;padding:0 .2em;border-radius:.2em;background:rgba(127,127,127,.16)}
.dk-slide .dk-t a{color:inherit;text-decoration:underline;text-decoration-thickness:.06em;text-underline-offset:.12em}
.dk-slide .dk-r,.dk-slide .dk-i,.dk-slide svg{position:absolute}
.dk-slide svg{left:0;top:0;overflow:visible;pointer-events:none}
.dk-slide .dk-i{display:block;object-fit:cover}
.dk-slide .dk-ghost{opacity:.38}
.dk-slide [data-step]{transition:opacity .45s ease,transform .45s cubic-bezier(.2,.7,.2,1)}
.dk-slide .dk-later{opacity:0!important;transform:translateY(14px)}
.dk-slide svg.dk-later{transform:none}
`;

/** A primitive or a paragraph that comes on with a click carries that click's number. */
const stepOf = x => x?.step ? ` data-step="${x.step}"` : '';
/** Which of the slide's pictures a picture, or its empty place, is: the stage puts a dropped one there. */
const slotOf = x => Number.isInteger(x?.slot) ? ` data-slot="${x.slot}"` : '';
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const n = v => Math.round(v * 100) / 100;
export function rgba(hex, alpha = 1) {
  const rgb = parseHex(hex) ?? [0, 0, 0];
  return alpha >= 1 ? `rgb(${rgb.join(',')})` : `rgba(${rgb.join(',')},${n(alpha)})`;
}
/** A fill as CSS background. */
export function cssFill(fill, alpha = 1, shape = 'rect') {
  if (!fill) return 'transparent';
  if (typeof fill === 'string') return rgba(fill, alpha);
  // A glow fades out along a smooth curve: a straight fade to nothing draws its own outline.
  const list = fill.type === 'radial' && fill.stops.length === 2 ? eased(fill.stops) : fill.stops;
  const stops = list.map(s => `${rgba(s.color, (s.alpha ?? 1) * alpha)} ${n(s.at * 100)}%`).join(',');
  return fill.type === 'radial' ? `radial-gradient(${shape === 'ellipse' ? 'closest-side' : 'farthest-side'},${stops})` : `linear-gradient(${fill.angle ?? 180}deg,${stops})`;
}

function eased([from, to]) {
  const a = from.alpha ?? 1, b = to.alpha ?? 1;
  return [0, 0.2, 0.4, 0.6, 0.8, 1].map(at => {
    const k = (1 - Math.cos(Math.PI * at)) / 2;
    return { at: from.at + (to.at - from.at) * at, color: at < 0.5 ? from.color : to.color, alpha: a + (b - a) * k };
  });
}

function runs(list) {
  return list.map(r => {
    let html = esc(r.text);
    if (r.code) html = `<code>${html}</code>`;
    if (r.b) html = `<strong>${html}</strong>`;
    if (r.i) html = `<em>${html}</em>`;
    if (r.u) html = `<u>${html}</u>`;
    if (r.link) html = `<a href="${esc(r.link)}" target="_blank" rel="noopener">${html}</a>`;
    if (r.color) html = `<span style="color:${rgba(r.color)}">${html}</span>`;
    return html;
  }).join('');
}

function textHtml(p, index) {
  const justify = p.valign === 'middle' ? 'center' : p.valign === 'bottom' ? 'flex-end' : 'flex-start';
  const style = [`left:${n(p.x)}px`, `top:${n(p.y)}px`, `width:${n(p.w)}px`, `height:${n(p.h)}px`, `justify-content:${justify}`,
    `font-family:${esc(fontStack(p.font))}`, `font-size:${n(p.size)}px`, `font-weight:${p.weight}`, `line-height:${p.lineHeight}`,
    `color:${rgba(p.color)}`, `text-align:${p.align}`, p.italic ? 'font-style:italic' : '', p.tracking ? `letter-spacing:${n(p.tracking)}em` : '',
    p.caps ? 'text-transform:uppercase' : ''].filter(Boolean).join(';');
  let number = 0;
  const paras = p.paragraphs.map((para, i) => {
    const scale = para.heading ? 1 : para.level > 0 ? 0.86 : 1;
    const space = para.spaceBefore ?? (para.heading ? 0.7 : para.level > 0 ? 0.25 : 0.55) * p.size;
    const indent = para.bullet ? bulletIndent(p, para) : 0;
    const bits = [i > 0 ? `margin-top:${n(space)}px` : '', scale !== 1 ? `font-size:${n(p.size * scale)}px` : '', indent ? `padding-left:${n(indent)}px` : '', para.heading ? 'font-weight:700' : ''].filter(Boolean).join(';');
    let mark = '';
    if (para.bullet) {
      number = para.bullet === 'number' ? (para.number ?? number + 1) : number;
      const char = para.bullet === 'number' ? `${number}.` : (para.level > 0 ? '–' : p.bulletChar ?? '•');
      const left = para.level > 0 ? bulletIndent(p, { ...para, level: para.level - 1 }) : 0;
      mark = `<span class="dk-b"${p.edit ? ' contenteditable="false"' : ''} style="left:${n(left)}px;color:${rgba(p.bulletColor ?? p.color)};${para.bullet === 'number' ? 'font-weight:700;' : ''}${char === '■' ? 'font-size:.6em;top:.42em;' : ''}">${esc(char)}</span>`;
    }
    // An empty paragraph keeps its line, as the layout counted it, and a caret has somewhere to stand.
    const words = runs(para.runs);
    return `<p${stepOf(para)} style="${bits}">${mark}${words || '<br>'}</p>`;
  }).join('');
  return `<div class="dk-t${p.ghost ? ' dk-ghost' : ''}" data-role="${esc(p.role ?? '')}" data-i="${index}"${stepOf(p)}${slotOf(p)}${editAttributes(p)} style="${style}">${paras}</div>`;
}

/** Where an editable box's words are in the slide, for the stage's editor (stage-editor.mjs). */
function editAttributes(p) {
  const e = p.edit;
  if (!e) return '';
  const place = e.from === undefined ? ` data-first="${e.first}"${e.single ? ' data-single=""' : ''}` : ` data-from="${e.from}" data-to="${e.to}"`;
  return ` data-field="${esc(e.field)}" data-dialect="${esc(e.dialect)}" data-key="${esc(e.key)}" data-base="${n(e.base)}" data-size="${n(p.size)}"${place}`;
}

function shapeHtml(p, W, H) {
  switch (p.type) {
    case 'rect':
    case 'ellipse': {
      const radius = p.type === 'ellipse' ? '50%' : p.radius ? `${n(p.radius)}px` : '0';
      const style = [`left:${n(p.x)}px`, `top:${n(p.y)}px`, `width:${n(p.w)}px`, `height:${n(p.h)}px`, `border-radius:${radius}`,
        `background:${cssFill(p.fill, p.alpha ?? 1, p.type)}`, p.stroke ? `box-shadow:0 0 0 ${n(p.strokeWidth ?? 1)}px ${rgba(p.stroke)} inset` : '',
        p.shadow ? 'box-shadow:0 14px 34px rgba(20,16,60,.10),0 2px 6px rgba(20,16,60,.06)' : ''].filter(Boolean).join(';');
      return `<div class="dk-r" data-role="${esc(p.role ?? '')}"${stepOf(p)}${slotOf(p)} style="${style}"></div>`;
    }
    case 'line':
      return `<svg${stepOf(p)} width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><line x1="${n(p.x1)}" y1="${n(p.y1)}" x2="${n(p.x2)}" y2="${n(p.y2)}" stroke="${rgba(p.stroke)}" stroke-width="${p.width ?? 1}"${p.dash ? ' stroke-dasharray="4 6"' : ''}/></svg>`;
    case 'path': {
      const d = p.points.map(([x, y], i) => `${i ? 'L' : 'M'}${n(x)} ${n(y)}`).join(' ') + (p.closed ? ' Z' : '');
      return `<svg${stepOf(p)} width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><path d="${d}" fill="${p.fill ? rgba(p.fill, p.alpha ?? 1) : 'none'}" stroke="${p.stroke ? rgba(p.stroke) : 'none'}" stroke-width="${p.width ?? 0}" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
    }
    case 'arc':
      return `<svg${stepOf(p)} width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><path d="${arcPath(p)}" fill="${rgba(p.fill)}"/></svg>`;
    default: return '';
  }
}
export function arcPath({ cx, cy, r, inner, start, end }) {
  const pt = (radius, deg) => { const a = (deg - 90) * Math.PI / 180; return [cx + radius * Math.cos(a), cy + radius * Math.sin(a)]; };
  const large = end - start > 180 ? 1 : 0;
  const [x1, y1] = pt(r, start), [x2, y2] = pt(r, end), [x3, y3] = pt(inner, end), [x4, y4] = pt(inner, start);
  return `M${n(x1)} ${n(y1)} A${n(r)} ${n(r)} 0 ${large} 1 ${n(x2)} ${n(y2)} L${n(x3)} ${n(y3)} A${n(inner)} ${n(inner)} 0 ${large} 0 ${n(x4)} ${n(y4)} Z`;
}

function imageHtml(p, urlFor) {
  const url = urlFor(p.src);
  const position = p.fit === 'contain' ? (p.align === 'right' ? 'right center' : p.align === 'center' ? 'center' : 'left center') : 'center';
  const style = `left:${n(p.x)}px;top:${n(p.y)}px;width:${n(p.w)}px;height:${n(p.h)}px;object-fit:${p.fit};object-position:${position};border-radius:${n(p.radius ?? 0)}px`;
  if (!url) return `<div class="dk-r" data-role="${esc(p.role ?? '')}"${stepOf(p)}${slotOf(p)} style="${style};background:rgba(127,127,127,.18)"></div>`;
  return `<img class="dk-i" data-role="${esc(p.role ?? '')}"${stepOf(p)}${slotOf(p)} src="${esc(url)}" alt="${esc(p.alt ?? '')}" draggable="false" style="${style}">`;
}

/** The slide as an HTML string, `W` × `H` pixels; scale it with CSS. urlFor maps a media address to a URL. */
export function slideHtml(laid, { urlFor = src => src, className = '' } = {}) {
  const { W, H } = laid;
  const parts = laid.items.map((p, i) => p.type === 'text' ? textHtml(p, i) : p.type === 'image' ? imageHtml(p, urlFor) : shapeHtml(p, W, H));
  return `<div class="dk-slide ${className}" data-steps="${laid.steps ?? 0}" style="width:${W}px;height:${H}px;background:${cssFill(laid.background)}">${parts.join('')}</div>`;
}
