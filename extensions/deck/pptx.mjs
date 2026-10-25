// Writes a PowerPoint file from laid-out slides: every primitive becomes a native shape, text box
// or picture, so the deck stays editable in PowerPoint. Speaker notes go to the notes pages and
// the theme's colours and fonts to PowerPoint's own theme, so new slides added there match.

import { zip } from './zip.mjs';
import { bulletIndent } from './layout.mjs';
import { normalHex } from './themes.mjs';

const EMU = 9525; // per CSS pixel at 96 dpi
const e = px => Math.round(px * EMU);
const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const esc = value => String(value ?? '').replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch])
  // Characters XML 1.0 refuses, which a pasted text can carry.
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
const hex = c => (normalHex(c, '#000000')).slice(1);
const pt100 = px => Math.round(px * 0.75 * 100);

function color(c, alpha = 1) {
  return alpha < 1 ? `<a:srgbClr val="${hex(c)}"><a:alpha val="${Math.round(alpha * 100000)}"/></a:srgbClr>` : `<a:srgbClr val="${hex(c)}"/>`;
}
function fill(f, alpha = 1) {
  if (!f) return '<a:noFill/>';
  if (typeof f === 'string') return `<a:solidFill>${color(f, alpha)}</a:solidFill>`;
  const stops = f.stops.map(s => `<a:gs pos="${Math.round(s.at * 100000)}">${color(s.color, (s.alpha ?? 1) * alpha)}</a:gs>`).join('');
  if (f.type === 'radial') return `<a:gradFill rotWithShape="1"><a:gsLst>${stops}</a:gsLst><a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path></a:gradFill>`;
  const ang = ((((f.angle ?? 180) - 90) % 360) + 360) % 360;
  return `<a:gradFill rotWithShape="1"><a:gsLst>${stops}</a:gsLst><a:lin ang="${ang * 60000}" scaled="0"/></a:gradFill>`;
}
const line = (stroke, width, dash) => stroke ? `<a:ln w="${e(width ?? 1)}">${fill(stroke)}${dash ? '<a:prstDash val="dash"/>' : ''}</a:ln>` : '<a:ln><a:noFill/></a:ln>';
const xfrm = (x, y, w, h, flips = '') => `<a:xfrm${flips}><a:off x="${e(x)}" y="${e(y)}"/><a:ext cx="${Math.max(e(w), 0)}" cy="${Math.max(e(h), 0)}"/></a:xfrm>`;
const shadow = '<a:effectLst><a:outerShdw blurRad="304800" dist="114300" dir="5400000" algn="t" rotWithShape="0"><a:srgbClr val="14103C"><a:alpha val="11000"/></a:srgbClr></a:outerShdw></a:effectLst>';
const geometry = (prst, adj) => adj === undefined ? `<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>` : `<a:prstGeom prst="${prst}"><a:avLst>${adj}</a:avLst></a:prstGeom>`;

/** Writes one primitive; ids count up within a slide. */
function shape(p, id, ctx) {
  const name = `${p.role || p.type} ${id}`;
  switch (p.type) {
    case 'rect':
    case 'ellipse': {
      let geom;
      if (p.type === 'ellipse') geom = geometry('ellipse');
      else if (p.radius) geom = geometry('roundRect', `<a:gd name="adj" fmla="val ${Math.min(50000, Math.round(p.radius / Math.max(1, Math.min(p.w, p.h)) * 100000))}"/>`);
      else geom = geometry('rect');
      // A glow is a radial fade to nothing. Gradient transparency is read differently by
      // PowerPoint, Keynote and LibreOffice, so it is written as a soft-edged solid instead.
      const glow = p.type === 'ellipse' && p.fill?.type === 'radial';
      const paint = glow ? fill(p.fill.stops[0].color, (p.fill.stops[0].alpha ?? 1) * (p.alpha ?? 1) * 0.8) : fill(p.fill, p.alpha ?? 1);
      const effects = glow ? `<a:effectLst><a:softEdge rad="${e(Math.min(p.w, p.h) * 0.22)}"/></a:effectLst>` : p.shadow ? shadow : '';
      return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(p.x, p.y, p.w, p.h)}${geom}${paint}${line(p.stroke, p.strokeWidth)}${effects}</p:spPr></p:sp>`;
    }
    case 'line': {
      const x = Math.min(p.x1, p.x2), y = Math.min(p.y1, p.y2);
      const flips = `${p.x2 < p.x1 ? ' flipH="1"' : ''}${p.y2 < p.y1 ? ' flipV="1"' : ''}`;
      return `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>${xfrm(x, y, Math.abs(p.x2 - p.x1), Math.abs(p.y2 - p.y1), flips)}${geometry('line')}${line(p.stroke, p.width, p.dash)}</p:spPr></p:cxnSp>`;
    }
    case 'path': {
      const xs = p.points.map(q => q[0]), ys = p.points.map(q => q[1]);
      const x = Math.min(...xs), y = Math.min(...ys), w = Math.max(1, Math.max(...xs) - x), h = Math.max(1, Math.max(...ys) - y);
      const pts = p.points.map(([px, py], i) => `<a:${i ? 'lnTo' : 'moveTo'}><a:pt x="${e(px - x)}" y="${e(py - y)}"/></a:${i ? 'lnTo' : 'moveTo'}>`).join('');
      const geom = `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="${e(w)}" h="${e(h)}"${p.fill ? '' : ' fill="none"'}>${pts}${p.closed ? '<a:close/>' : ''}</a:path></a:pathLst></a:custGeom>`;
      const ln = p.stroke ? `<a:ln w="${e(p.width ?? 1)}" cap="rnd">${fill(p.stroke)}<a:round/></a:ln>` : '<a:ln><a:noFill/></a:ln>';
      return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(x, y, w, h)}${geom}${fill(p.fill, p.alpha ?? 1)}${ln}</p:spPr></p:sp>`;
    }
    case 'arc': {
      const toDml = deg => Math.round(((((deg - 90) % 360) + 360) % 360) * 60000);
      // An arc with no hole is a pie's slice, PowerPoint's own pie shape; one with a hole, a block arc.
      const angles = `<a:gd name="adj1" fmla="val ${toDml(p.start)}"/><a:gd name="adj2" fmla="val ${toDml(p.end)}"/>`;
      const geom = p.inner > 0 ? geometry('blockArc', `${angles}<a:gd name="adj3" fmla="val ${Math.round((p.r - p.inner) / (2 * p.r) * 100000)}"/>`) : geometry('pie', angles);
      return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(p.cx - p.r, p.cy - p.r, 2 * p.r, 2 * p.r)}${geom}${fill(p.fill)}<a:ln><a:noFill/></a:ln></p:spPr></p:sp>`;
    }
    case 'image': return picture(p, id, name, ctx);
    case 'text': return textBox(p, id, name, ctx);
    default: return '';
  }
}

function picture(p, id, name, ctx) {
  const image = ctx.image(p.src);
  if (!image) return '';
  let { x, y, w, h } = p, crop = '';
  const ratio = image.width / image.height, box = w / h;
  if (p.fit === 'contain') {
    if (ratio > box) { const nh = w / ratio; y += (h - nh) / 2; h = nh; } else {
      const nw = h * ratio; x += p.align === 'right' ? w - nw : p.align === 'center' ? (w - nw) / 2 : 0; w = nw;
    }
  } else if (Number.isFinite(ratio) && Math.abs(ratio - box) > 0.001) {
    if (ratio > box) { const cut = (1 - box / ratio) / 2 * 100000; crop = `<a:srcRect l="${Math.round(cut)}" r="${Math.round(cut)}"/>`; } else { const cut = (1 - ratio / box) / 2 * 100000; crop = `<a:srcRect t="${Math.round(cut)}" b="${Math.round(cut)}"/>`; }
  }
  const geom = p.radius ? geometry('roundRect', `<a:gd name="adj" fmla="val ${Math.min(50000, Math.round(p.radius / Math.min(w, h) * 100000))}"/>`) : geometry('rect');
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${esc(name)}" descr="${esc(p.alt ?? '')}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${image.rel}"/>${crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(x, y, w, h)}${geom}</p:spPr></p:pic>`;
}

function textBox(p, id, name, ctx) {
  if (p.paragraphs.every(para => para.runs.every(r => !r.text)) || p.ghost) return '';
  const anchor = p.valign === 'middle' ? 'ctr' : p.valign === 'bottom' ? 'b' : 't';
  const algn = p.align === 'center' ? 'ctr' : p.align === 'right' ? 'r' : p.align === 'justify' ? 'just' : 'l';
  let number = 0;
  const paras = p.paragraphs.map((para, i) => {
    const scale = para.heading ? 1 : para.level > 0 ? 0.86 : 1;
    const size = p.size * scale;
    const space = i === 0 ? 0 : para.spaceBefore ?? (para.heading ? 0.7 : para.level > 0 ? 0.25 : 0.55) * p.size;
    let bullet = '<a:buNone/>', margin = '';
    if (para.bullet) {
      const indent = bulletIndent(p, para), left = para.level > 0 ? bulletIndent(p, { ...para, level: para.level - 1 }) : 0;
      margin = ` marL="${e(indent)}" indent="${-e(indent - left)}"`;
      const bc = `<a:buClr>${color(p.bulletColor ?? p.color)}</a:buClr>`;
      if (para.bullet === 'number') { number = para.number ?? number + 1; bullet = `${bc}<a:buFont typeface="${esc(p.font)}"/><a:buAutoNum type="arabicPeriod" startAt="${number}"/>`; }
      else { const char = para.level > 0 ? '–' : p.bulletChar ?? '•'; bullet = `${bc}${char === '■' ? '<a:buSzPct val="60000"/>' : ''}<a:buFont typeface="Arial"/><a:buChar char="${esc(char)}"/>`; }
    }
    const pPr = `<a:pPr algn="${algn}"${margin}><a:lnSpc><a:spcPts val="${pt100(p.lineHeight * size)}"/></a:lnSpc><a:spcBef><a:spcPts val="${pt100(space)}"/></a:spcBef>${bullet}</a:pPr>`;
    const runs = para.runs.filter(r => r.text).map(r => {
      const bold = r.b || para.heading || p.weight >= 600;
      const face = r.code ? 'Consolas' : p.font;
      // A link keeps its address: the run points at the slide's relationship for it.
      const link = r.link && ctx?.link ? ctx.link(r.link) : null;
      const attrs = `lang="en-US" sz="${pt100(size)}"${bold ? ' b="1"' : ' b="0"'}${r.i || p.italic ? ' i="1"' : ''}${link || r.u ? ' u="sng"' : ''}${p.caps ? ' cap="all"' : ''}${p.tracking ? ` spc="${Math.round(p.tracking * size * 0.75 * 100)}"` : ''} dirty="0"`;
      return `<a:r><a:rPr ${attrs}>${fill(r.color ?? p.color)}<a:latin typeface="${esc(face)}"/><a:cs typeface="${esc(face)}"/>${link ? `<a:hlinkClick r:id="${link}"/>` : ''}</a:rPr><a:t>${esc(r.text)}</a:t></a:r>`;
    }).join('');
    return `<a:p>${pPr}${runs}<a:endParaRPr lang="en-US" sz="${pt100(size)}" dirty="0"/></a:p>`;
  }).join('');
  // A little room, since PowerPoint's wrap and the browser's differ by a few pixels.
  const w = p.w + Math.min(12, p.w * 0.02);
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(p.x, p.y, w, p.h)}${geometry('rect')}<a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="${anchor}" rtlCol="0"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paras}</p:txBody></p:sp>`;
}

const group = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

function slideXml(laid, hidden, ctx, transition = 'None') {
  let id = 2;
  const built = [];
  const body = laid.items.map(p => {
    const spid = id++, xml = shape(p, spid, ctx);
    if (xml && laid.steps) built.push(...targetsOf(p, spid, xml));
    return xml;
  }).join('');
  return `${XML}<p:sld ${NS}${hidden ? ' show="0"' : ''}><p:cSld><p:bg><p:bgPr>${fill(laid.background)}<a:effectLst/></p:bgPr></p:bg><p:spTree>${group}${body}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${transitionXml(transition)}${timingXml(built, laid.steps)}</p:sld>`;
}

// ---- Transitions and builds --------------------------------------------------------------------
// A slide's transition is PowerPoint's own of the same name, and its build is PowerPoint's fade
// entrance on click: one click per step, a text box's paragraphs by their range.

const TRANSITION_XML = { Fade: '<p:fade/>', Push: '<p:push dir="l"/>', Zoom: '<p:zoom dir="in"/>' };
const transitionXml = kind => TRANSITION_XML[kind] ? `<p:transition spd="med">${TRANSITION_XML[kind]}</p:transition>` : '';

/** What one drawn shape brings on, and when: [{spid, step, range: [st, end] | null, kind}]. */
function targetsOf(p, spid, xml) {
  const kind = xml.startsWith('<p:pic') ? 'pic' : xml.startsWith('<p:cxnSp') ? 'line' : p.type === 'text' ? 'text' : 'shape';
  if (p.type === 'text' && p.paragraphs.some(para => para.step)) {
    // Runs of paragraphs that come on together are one range each.
    const out = [];
    p.paragraphs.forEach((para, i) => {
      const step = para.step ?? p.step ?? 1, last = out.at(-1);
      if (last && last.step === step && last.range[1] === i - 1) last.range[1] = i; else out.push({ spid, step, range: [i, i], kind });
    });
    return out;
  }
  return p.step ? [{ spid, step: p.step, range: null, kind }] : [];
}

function timingXml(targets, steps) {
  if (!targets.length) return '';
  let id = 3;
  const target = t => t.range ? `<p:spTgt spid="${t.spid}"><p:txEl><p:pRg st="${t.range[0]}" end="${t.range[1]}"/></p:txEl></p:spTgt>` : `<p:spTgt spid="${t.spid}"/>`;
  const effect = (t, first) => `<p:par><p:cTn id="${id++}" presetID="10" presetClass="entr" presetSubtype="0" fill="hold"${t.kind === 'text' || t.kind === 'shape' ? ' grpId="0"' : ''} nodeType="${first ? 'clickEffect' : 'withEffect'}"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>`
    + `<p:set><p:cBhvr><p:cTn id="${id++}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn><p:tgtEl>${target(t)}</p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>`
    + `<p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="${id++}" dur="500"/><p:tgtEl>${target(t)}</p:tgtEl></p:cBhvr></p:animEffect></p:childTnLst></p:cTn></p:par>`;
  const clicks = [];
  for (let step = 1; step <= steps; step++) {
    const now = targets.filter(t => t.step === step);
    if (!now.length) continue;
    const outer = id++, inner = id++;
    const effects = now.map((t, i) => effect(t, i === 0)).join('');
    clicks.push(`<p:par><p:cTn id="${outer}" fill="hold"><p:stCondLst><p:cond delay="indefinite"/></p:stCondLst><p:childTnLst><p:par><p:cTn id="${inner}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>${effects}</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>`);
  }
  // A text shape built by paragraph says so; a shape without words is built with its fill. Pictures and lines need no entry.
  const builds = [];
  for (const t of targets) {
    if (builds.some(b => b.spid === t.spid) || (t.kind !== 'text' && t.kind !== 'shape')) continue;
    builds.push({ spid: t.spid, xml: t.kind === 'shape' ? `<p:bldP spid="${t.spid}" grpId="0" animBg="1"/>` : `<p:bldP spid="${t.spid}" grpId="0"${t.range ? ' build="p"' : ''}/>` });
  }
  return '<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>'
    + clicks.join('')
    + '</p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst>'
    + `${builds.length ? `<p:bldLst>${builds.map(b => b.xml).join('')}</p:bldLst>` : ''}</p:timing>`;
}

function notesXml(text) {
  const paras = String(text ?? '').split(/\r?\n/).map(l => `<a:p>${l ? `<a:r><a:rPr lang="en-US" dirty="0"/><a:t>${esc(l)}</a:t></a:r>` : ''}<a:endParaRPr lang="en-US" dirty="0"/></a:p>`).join('') || '<a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p>';
  return `${XML}<p:notes ${NS}><p:cSld><p:spTree>${group}`
    + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>'
    + `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp>`
    + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>';
}

function notesMasterXml() {
  const level = n => `<a:lvl${n}pPr marL="${(n - 1) * 457200}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1200" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${n}pPr>`;
  return `${XML}<p:notesMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${group}`
    + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="1143000"/><a:ext cx="5486400" cy="3086100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp>'
    + '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle/><a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US"/><a:t>Notes</a:t></a:r></a:p></p:txBody></p:sp>'
    + `</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:notesStyle>${[1, 2, 3].map(level).join('')}</p:notesStyle></p:notesMaster>`;
}

function themeXml(theme, name) {
  const c = theme.colors;
  const sys = (tag, value) => `<a:${tag}><a:srgbClr val="${hex(value)}"/></a:${tag}>`;
  const dark = theme.mode === 'dark';
  const scheme = [sys('dk1', dark ? c.bg : c.ink), sys('lt1', dark ? c.ink : c.bg), sys('dk2', c.secondary), sys('lt2', c.surface),
    sys('accent1', c.primary), sys('accent2', c.accent), sys('accent3', c.secondary), sys('accent4', c.muted), sys('accent5', c.primaryText), sys('accent6', c.accentText),
    sys('hlink', c.primaryText), sys('folHlink', c.muted)].join('');
  const fonts = kind => `<a:latin typeface="${esc(kind)}"/><a:ea typeface=""/><a:cs typeface=""/>`;
  const plain = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  return `${XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${esc(name)}"><a:themeElements><a:clrScheme name="${esc(name)}">${scheme}</a:clrScheme>`
    + `<a:fontScheme name="${esc(name)}"><a:majorFont>${fonts(theme.fonts.heading)}</a:majorFont><a:minorFont>${fonts(theme.fonts.body)}</a:minorFont></a:fontScheme>`
    + `<a:fmtScheme name="${esc(name)}"><a:fillStyleLst>${plain}${plain}${plain}</a:fillStyleLst>`
    + '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>'
    + '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>'
    + `<a:bgFillStyleLst>${plain}${plain}${plain}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}

function masterXml() {
  const lvl = '<a:lvl1pPr><a:defRPr><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr>';
  return `${XML}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${group}</p:spTree></p:cSld>`
    + '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
    + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'
    + `<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle>${lvl}</p:bodyStyle><p:otherStyle>${lvl}</p:otherStyle></p:txStyles></p:sldMaster>`;
}
const layoutXml = () => `${XML}<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${group}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

const rels = list => `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map(([id, type, target, mode]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${esc(target)}"${mode ? ` TargetMode="${mode}"` : ''}/>`).join('')}</Relationships>`;

/**
 * Builds the .pptx bytes.
 * deck: {title, author}; theme: the resolved theme; slides: [{laid, hidden, transition}] in order;
 * images: Map of a primitive's src to {bytes, ext: png|jpeg|gif, width, height}.
 */
export function buildPptx({ deck = {}, theme, slides, images = new Map(), now = new Date() }) {
  const W = slides[0]?.laid.W ?? 1280, H = slides[0]?.laid.H ?? 720;
  const files = [];
  const media = new Map(); // src → {path, ext}
  const used = (src) => {
    const image = images.get(src);
    if (!image) return null;
    if (!media.has(src)) media.set(src, { path: `media/image${media.size + 1}.${image.ext}`, ext: image.ext, bytes: image.bytes });
    return media.get(src);
  };
  slides.forEach((slide, i) => {
    const n = i + 1;
    const slideRels = [['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'notesSlide', `../notesSlides/notesSlide${n}.xml`]];
    const byPath = new Map(), byLink = new Map();
    const ctx = { link: url => {
      if (!byLink.has(url)) { const rel = `rId${slideRels.length + 1}`; slideRels.push([rel, 'hyperlink', url, 'External']); byLink.set(url, rel); }
      return byLink.get(url);
    }, image: src => {
      const m = used(src);
      if (!m) return null;
      if (!byPath.has(m.path)) { const rel = `rId${slideRels.length + 1}`; slideRels.push([rel, 'image', `../${m.path}`]); byPath.set(m.path, rel); }
      const info = images.get(src);
      return { rel: byPath.get(m.path), width: info.width, height: info.height };
    } };
    files.push({ name: `ppt/slides/slide${n}.xml`, data: slideXml(slide.laid, slide.hidden, ctx, slide.transition) });
    files.push({ name: `ppt/slides/_rels/slide${n}.xml.rels`, data: rels(slideRels) });
    files.push({ name: `ppt/notesSlides/notesSlide${n}.xml`, data: notesXml(slide.laid.notes) });
    files.push({ name: `ppt/notesSlides/_rels/notesSlide${n}.xml.rels`, data: rels([['rId1', 'notesMaster', '../notesMasters/notesMaster1.xml'], ['rId2', 'slide', `../slides/slide${n}.xml`]]) });
  });
  const count = slides.length;
  const presRels = [['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ['rId2', 'notesMaster', 'notesMasters/notesMaster1.xml'],
    ['rId3', 'theme', 'theme/theme1.xml'], ['rId4', 'presProps', 'presProps.xml'], ['rId5', 'viewProps', 'viewProps.xml'], ['rId6', 'tableStyles', 'tableStyles.xml'],
    ...slides.map((_, i) => [`rId${7 + i}`, 'slide', `slides/slide${i + 1}.xml`])];
  const presentation = `${XML}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>`
    + '<p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst>'
    + `<p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${7 + i}"/>`).join('')}</p:sldIdLst>`
    + `<p:sldSz cx="${e(W)}" cy="${e(H)}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr></p:defaultTextStyle></p:presentation>`;
  const iso = now.toISOString().replace(/\.\d+Z$/, 'Z');
  const types = `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    + '<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/>'
    + '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
    + '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
    + '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>'
    + '<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>'
    + '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
    + '<Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
    + '<Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>'
    + '<Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>'
    + '<Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>'
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
    + slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/notesSlides/notesSlide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`).join('')
    + '</Types>';
  const head = [
    { name: '[Content_Types].xml', data: types },
    { name: '_rels/.rels', data: `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>` },
    { name: 'docProps/core.xml', data: `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(deck.title ?? '')}</dc:title><dc:creator>${esc(deck.author ?? '')}</dc:creator><cp:lastModifiedBy>Nendo Deck</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified></cp:coreProperties>` },
    { name: 'docProps/app.xml', data: `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Microsoft Office PowerPoint</Application><PresentationFormat>${W / H > 1.5 ? 'Widescreen' : 'On-screen Show (4:3)'}</PresentationFormat><Slides>${count}</Slides><Notes>${count}</Notes><HiddenSlides>${slides.filter(s => s.hidden).length}</HiddenSlides></Properties>` },
    { name: 'ppt/presentation.xml', data: presentation },
    { name: 'ppt/_rels/presentation.xml.rels', data: rels(presRels) },
    { name: 'ppt/presProps.xml', data: `${XML}<p:presentationPr ${NS}/>` },
    { name: 'ppt/viewProps.xml', data: `${XML}<p:viewPr ${NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>` },
    { name: 'ppt/tableStyles.xml', data: `${XML}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>` },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: masterXml() },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: rels([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml']]) },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: layoutXml() },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: rels([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']]) },
    { name: 'ppt/notesMasters/notesMaster1.xml', data: notesMasterXml() },
    { name: 'ppt/notesMasters/_rels/notesMaster1.xml.rels', data: rels([['rId1', 'theme', '../theme/theme2.xml']]) },
    { name: 'ppt/theme/theme1.xml', data: themeXml(theme, theme.brand?.name || theme.name) },
    { name: 'ppt/theme/theme2.xml', data: themeXml({ ...theme, mode: 'light', colors: { ...theme.colors, bg: '#FFFFFF', ink: '#000000' } }, 'Notes') },
  ];
  const mediaFiles = [...media.values()].map(m => ({ name: `ppt/${m.path}`, data: m.bytes }));
  return zip([...head, ...files, ...mediaFiles]);
}
