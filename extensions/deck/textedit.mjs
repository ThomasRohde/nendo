// The words of one text box as the stage edits them: paragraphs of runs, positions in them, and
// the changes a person makes. Pure, so node's tests hold it; stage-editor.mjs ties it to the page.
//
// A document is the paragraphs of one field, read the way the layout reads that field:
//   blocks     a body: bullets, numbers, headings and plain paragraphs (paragraphs/blocksMarkdown)
//   lines      a title: one paragraph to a line, with marks
//   plain      a kicker: lines of words, no marks
//   cell       one cell of a `- a | b` row or a table, with marks, one paragraph
//   cellPlain  one cell drawn as plain words, such as a big number
// A position is {p, o}: a paragraph and a character offset in its words.

import { inline, paragraphs, mergeRuns, run, inlineMarkdown, blocksMarkdown, linesMarkdown, plainText } from './model.mjs';

export const DIALECTS = ['blocks', 'lines', 'plain', 'cell', 'cellPlain'];
/** Whether a dialect holds more than one paragraph, takes marks, and takes bullets. */
export const multiline = dialect => dialect === 'blocks' || dialect === 'lines';
export const marked = dialect => dialect !== 'plain' && dialect !== 'cellPlain';
export const listed = dialect => dialect === 'blocks';

const para = (kind, level, runs, number) => ({ kind, level, runs, ...(number ? { number } : {}) });
const normal = text => String(text ?? '').replace(/\r\n?/g, '\n');

/** A field's words as paragraphs {kind, level, number, runs}, read the way the layout reads them. */
export function readDoc(dialect, text) {
  const source = normal(text);
  if (dialect === 'blocks') {
    const read = paragraphs(source).map(p => para(p.heading ? 'heading' : p.bullet ?? 'plain', p.level ?? 0, mergeRuns(p.runs), p.number));
    return read.length ? read : [para('plain', 0, [])];
  }
  if (dialect === 'lines') return source.split('\n').map(line => para('plain', 0, mergeRuns(inline(line))));
  if (dialect === 'plain') return source.split('\n').map(line => para('plain', 0, line ? [{ text: line }] : []));
  if (dialect === 'cell') return [para('plain', 0, mergeRuns(inline(source)))];
  return [para('plain', 0, source ? [{ text: source }] : [])];
}

/** Paragraphs as the field's text, which readDoc reads back as the same words and marks. */
export function writeDoc(dialect, doc) {
  if (dialect === 'blocks') return blocksMarkdown(doc);
  if (dialect === 'lines') return linesMarkdown(doc);
  if (dialect === 'plain') return doc.length === 1 && !textOf(doc[0]) ? '' : doc.map(textOf).join('\n');
  if (dialect === 'cell') return inlineMarkdown(doc[0]?.runs ?? []);
  return textOf(doc[0] ?? para('plain', 0, []));
}

/**
 * Pasted or typed paragraphs made fit for a dialect: a title takes no bullets, a kicker no marks,
 * and a cell one line with no bar, which would split it.
 */
export function conform(dialect, paras) {
  if (dialect === 'blocks') return paras.map(p => para(p.kind ?? 'plain', p.level ? 1 : 0, mergeRuns(p.runs)));
  if (dialect === 'lines') return paras.map(p => para('plain', 0, mergeRuns(p.runs)));
  if (dialect === 'plain') return paras.map(p => para('plain', 0, mergeRuns([{ text: textOf(p) }])));
  const runs = paras.flatMap((p, i) => i ? [{ text: ' ' }, ...p.runs] : p.runs)
    .map(r => run(r.text.replace(/[|\n]/g, ' '), dialect === 'cell' ? r : {}));
  return [para('plain', 0, mergeRuns(runs))];
}

export const textOf = p => plainText(p.runs);
export const lengthOf = p => textOf(p).length;
export const cmp = (a, b) => a.p - b.p || a.o - b.o;
export const ordered = (a, b) => cmp(a, b) <= 0 ? [a, b] : [b, a];
export const same = (a, b) => a.p === b.p && a.o === b.o;
/** A position inside the document, and inside paragraphs lo to hi. */
export function clampPos(doc, pos, lo = 0, hi = doc.length - 1) {
  const p = Math.max(lo, Math.min(hi, pos?.p ?? lo));
  return { p, o: Math.max(0, Math.min(lengthOf(doc[p]), pos?.o ?? 0)) };
}
const copy = doc => doc.map(p => ({ ...p, runs: p.runs.map(r => ({ ...r })) }));

/** Runs cut at offset o: [before, after]. */
export function splitRuns(runs, o) {
  const before = [], after = [];
  let at = 0;
  for (const r of runs) {
    const end = at + r.text.length;
    if (end <= o) before.push(r);
    else if (at >= o) after.push(r);
    else { before.push(run(r.text.slice(0, o - at), r)); after.push(run(r.text.slice(o - at), r)); }
    at = end;
  }
  return [before, after];
}
export const sliceRuns = (runs, from, to) => splitRuns(splitRuns(runs, to)[0], from)[1];

/** The paragraphs between two positions, as a clipboard holds them. */
export function slice(doc, a, b) {
  [a, b] = ordered(a, b);
  const out = [];
  for (let p = a.p; p <= b.p; p++) {
    const from = p === a.p ? a.o : 0, to = p === b.p ? b.o : lengthOf(doc[p]);
    out.push(para(doc[p].kind, doc[p].level, sliceRuns(doc[p].runs, from, to)));
  }
  return out;
}

/** Takes out what lies between two positions; the paragraphs it joins keep the first one's kind. */
export function remove(doc, a, b) {
  [a, b] = ordered(a, b);
  const out = copy(doc);
  const [keep] = splitRuns(out[a.p].runs, a.o);
  const [, rest] = splitRuns(out[b.p].runs, b.o);
  out[a.p].runs = mergeRuns([...keep, ...rest]);
  out.splice(a.p + 1, b.p - a.p);
  return { doc: out, at: a };
}

/**
 * The marks a character typed at `pos` takes: bold, italic and underline of the one before it, or
 * at a paragraph's start the one after; a link or code only inside it, as PowerPoint extends a link.
 */
export function marksAt(doc, pos) {
  const [before, after] = splitRuns(doc[pos.p].runs, pos.o);
  const r = before.at(-1) ?? after[0], next = after[0];
  const inside = k => before.length && next && r[k] && r[k] === next[k] ? { [k]: r[k] } : {};
  return { b: !!r?.b, i: !!r?.i, u: !!r?.u, ...inside('link'), ...inside('code') };
}

/**
 * Puts paragraphs in at a position: the first joins the paragraph there, the last takes what
 * followed. An empty paragraph takes the first one's bullet, number or heading as well.
 */
export function insert(doc, pos, paras) {
  if (!paras.length) return { doc, at: pos };
  const out = copy(doc);
  if (!lengthOf(out[pos.p]) && paras[0].kind && paras[0].kind !== 'plain') { out[pos.p].kind = paras[0].kind; out[pos.p].level = paras[0].level ?? 0; delete out[pos.p].number; }
  const [before, after] = splitRuns(out[pos.p].runs, pos.o);
  if (paras.length === 1) {
    out[pos.p].runs = mergeRuns([...before, ...paras[0].runs, ...after]);
    return { doc: out, at: { p: pos.p, o: pos.o + plainText(paras[0].runs).length } };
  }
  out[pos.p].runs = mergeRuns([...before, ...paras[0].runs]);
  const rest = paras.slice(1).map(p => para(p.kind ?? 'plain', p.level ?? 0, mergeRuns(p.runs)));
  const last = rest.at(-1), end = plainText(last.runs).length;
  last.runs = mergeRuns([...last.runs, ...after]);
  out.splice(pos.p + 1, 0, ...rest);
  return { doc: out, at: { p: pos.p + rest.length, o: end } };
}

/**
 * Paragraphs without the spaces before their words, and the selection moved with them. A field
 * keeps no such space (a body or a cell is read trimmed), so the words being edited keep none either.
 */
export function trimLeads(doc, sel) {
  let out = doc;
  const shift = { ...sel };
  doc.forEach((p, i) => {
    const text = textOf(p), lead = text.length - text.trimStart().length;
    if (!lead) return;
    out = remove(out, { p: i, o: 0 }, { p: i, o: lead }).doc;
    for (const k of ['anchor', 'focus']) if (shift[k].p === i) shift[k] = { p: i, o: Math.max(0, shift[k].o - lead) };
  });
  return { doc: out, sel: shift };
}

/**
 * Pasted paragraphs with the spaces the plain text of the same copy has at its start and end, which
 * an HTML reading drops: a copied "hello " pastes as "hello ", not "hello".
 */
export function withEdges(paras, text) {
  const plain = normal(text).replace(/\n+$/, '');
  if (!paras.length || !plain) return paras;
  const lead = /^[ \t\u00a0]*/.exec(plain)[0], trail = /[ \t\u00a0]*$/.exec(plain)[0];
  const out = copy(paras), first = out[0], last = out.at(-1);
  if (lead && !textOf(first).startsWith(lead)) first.runs = mergeRuns([run(lead, first.runs[0] ?? {}), ...first.runs]);
  if (trail && !textOf(last).endsWith(trail)) last.runs = mergeRuns([...last.runs, run(trail, last.runs.at(-1) ?? {})]);
  return out;
}

/** Words typed as paragraphs with the given marks: a line break starts a new paragraph. */
export const typed = (text, marks = {}) => normal(text).split('\n').map(line => para('plain', 0, line ? [run(line, marks)] : []));

/**
 * Enter: the paragraph splits at the caret and the new one keeps its kind and level, as a list goes
 * on. At the very start of a paragraph with words, an empty one opens above it instead.
 */
export function split(doc, pos) {
  const out = copy(doc);
  const here = out[pos.p];
  if (pos.o === 0 && lengthOf(here) > 0) {
    out.splice(pos.p, 0, para(here.kind === 'heading' ? 'plain' : here.kind, here.level, []));
    return { doc: out, at: { p: pos.p + 1, o: 0 } };
  }
  const [before, after] = splitRuns(here.runs, pos.o);
  here.runs = before;
  out.splice(pos.p + 1, 0, para(here.kind === 'heading' ? 'plain' : here.kind, here.level, after));
  return { doc: out, at: { p: pos.p + 1, o: 0 } };
}

/** Whether every character between two positions has a mark; null when there is none between them. */
export function hasMark(doc, a, b, mark) {
  [a, b] = ordered(a, b);
  let any = false;
  for (let p = a.p; p <= b.p; p++) {
    const from = p === a.p ? a.o : 0, to = p === b.p ? b.o : lengthOf(doc[p]);
    for (const r of sliceRuns(doc[p].runs, from, to)) { any = true; if (!r[mark]) return false; }
  }
  return any ? true : null;
}
/** Sets or clears a mark on every character between two positions. */
export function setMark(doc, a, b, mark, on) {
  [a, b] = ordered(a, b);
  const out = copy(doc);
  for (let p = a.p; p <= b.p; p++) {
    const from = p === a.p ? a.o : 0, to = p === b.p ? b.o : lengthOf(out[p]);
    const [head, rest] = splitRuns(out[p].runs, from);
    const [middle, tail] = splitRuns(rest, to - from);
    out[p].runs = mergeRuns([...head, ...middle.map(r => run(r.text, { ...r, [mark]: on })), ...tail]);
  }
  return out;
}

/**
 * The part of a selection a mark takes: without the spaces at its ends, which a double click on
 * Windows takes in with the word. A selection of spaces alone stays as it is.
 */
export function inward(doc, a, b) {
  [a, b] = ordered(a, b);
  let s = { ...a }, e = { ...b };
  const at = pos => textOf(doc[pos.p])[pos.o];
  for (;;) {
    if (s.p < e.p && s.o >= lengthOf(doc[s.p])) s = { p: s.p + 1, o: 0 };
    else if (cmp(s, e) < 0 && /\s/.test(at(s) ?? '')) s = { p: s.p, o: s.o + 1 };
    else break;
  }
  for (;;) {
    if (e.p > s.p && e.o === 0) e = { p: e.p - 1, o: lengthOf(doc[e.p - 1]) };
    else if (cmp(s, e) < 0 && /\s/.test(textOf(doc[e.p])[e.o - 1] ?? '')) e = { p: e.p, o: e.o - 1 };
    else break;
  }
  return cmp(s, e) < 0 ? [s, e] : [a, b];
}

const WORD = /[\p{L}\p{N}_'’-]/u;
/** The word the caret stands inside, as PowerPoint's Bold takes it; null at a word's edge or in a space. */
export function wordAt(doc, pos) {
  const t = textOf(doc[pos.p]);
  let s = pos.o, e = pos.o;
  while (s > 0 && WORD.test(t[s - 1])) s--;
  while (e < t.length && WORD.test(t[e])) e++;
  return s < pos.o && e > pos.o ? [{ p: pos.p, o: s }, { p: pos.p, o: e }] : null;
}

/** The kind of every paragraph from one to another: plain, bullet or number. */
export function setKind(doc, from, to, kind) {
  const out = copy(doc);
  for (let p = from; p <= to; p++) { out[p].kind = kind; delete out[p].number; if (kind === 'plain') out[p].level = 0; }
  return out;
}
/** Moves list paragraphs a level in or out; there are two levels. */
export function shiftLevel(doc, from, to, delta) {
  const out = copy(doc);
  for (let p = from; p <= to; p++) if (out[p].kind === 'bullet' || out[p].kind === 'number') out[p].level = Math.max(0, Math.min(1, (out[p].level ?? 0) + delta));
  return out;
}

/** Paragraphs as plain text, one to a line. */
export const toPlain = paras => paras.map(textOf).join('\n');

const escapeHtml = value => String(value).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
/** Paragraphs as HTML another program pastes with their marks and lists: Word, PowerPoint, a mail. */
export function toHtml(paras) {
  const inner = runs => runs.map(r => {
    let h = escapeHtml(r.text);
    if (r.code) h = `<code>${h}</code>`;
    if (r.u) h = `<u>${h}</u>`;
    if (r.i) h = `<em>${h}</em>`;
    if (r.b) h = `<strong>${h}</strong>`;
    if (r.link) h = `<a href="${escapeHtml(r.link)}">${h}</a>`;
    return h;
  }).join('');
  let html = '', list = null;
  for (const p of paras) {
    const tag = p.kind === 'bullet' ? 'ul' : p.kind === 'number' ? 'ol' : null;
    if (list !== tag) { if (list) html += `</${list}>`; if (tag) html += `<${tag}>`; list = tag; }
    if (tag) html += `<li${p.level ? ' style="margin-left:2em"' : ''}>${inner(p.runs)}</li>`;
    else if (p.kind === 'heading') html += `<h3>${inner(p.runs)}</h3>`;
    else html += `<p>${inner(p.runs) || '<br>'}</p>`;
  }
  if (list) html += `</${list}>`;
  return html;
}
