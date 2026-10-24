// Editing words in place on the stage, as PowerPoint does it: a click puts the caret where it
// lands, a drag, a double click or Shift and an arrow select, typing goes in anywhere, Ctrl Z and
// Ctrl Y take it back and forth, cut, copy and paste keep marks and lists, and a right click opens
// a menu with bold, italic, underline, font size, alignment and bullets.
//
// The words stay Markdown in the slide's fields. Each text box the layout drew carries where its
// words are (data-field, data-dialect, data-first or data-from and data-to: layout.mjs, render.mjs).
// The box being edited is contenteditable, so the browser draws the caret and the selection and
// moves them. Every change the browser would make is refused (beforeinput) and made to the box's
// paragraphs instead (textedit.mjs); they are written to the field, the slide is drawn again, and
// the selection is put back where the paragraphs say.

import * as T from './textedit.mjs';
import { parseFormat, formatText, safeLink, mergeRuns, run, SCALE } from './model.mjs';

/** PowerPoint's font sizes, in points. */
export const SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 66, 72, 80, 88, 96, 112, 128, 144];
/** A slide pixel in points: a slide 1280 pixels wide is 13.33 inches, 960 points. */
export const PT = 0.75;
const ALIGN_LABELS = [['left', 'Align left', 'Ctrl+L'], ['center', 'Centre', 'Ctrl+E'], ['right', 'Align right', 'Ctrl+R'], ['justify', 'Justify', 'Ctrl+J']];
const FIELD_NAMES = { title: 'Title', kicker: 'Kicker', body: 'Text', body2: 'Second text' };
const empty = () => ({ kind: 'plain', level: 0, runs: [] });
const normal = text => String(text ?? '').replace(/\r\n?/g, '\n');

/**
 * host: {stage, slide(), write(field, value), selectSlide(id), ended({quiet}), redraw(), toast(text), readOnly()}.
 * write changes the current slide's field and draws the stage at once; the view calls attach()
 * after every drawing of the stage. ended saves, and unless quiet draws the stage without the box.
 */
export function createStageEditor(host) {
  let session = null;
  let composing = null;
  let menu = null;
  let plainPaste = false;
  const undo = [], redo = [];

  // ---- The box and its paragraphs -----------------------------------------------------------------

  const boxFor = s => !s ? null : s.from === undefined
    ? host.stage.querySelector(`.dk-t[data-field="${s.field}"][data-first="${s.first}"]`)
    : host.stage.querySelector(`.dk-t[data-field="${s.field}"][data-from="${s.from}"]`);
  const lo = () => session.first;
  const hi = () => session.single || session.from !== undefined ? session.first : session.doc.length - 1;
  const ordered = () => T.ordered(session.sel.anchor, session.sel.focus);
  const collapsed = () => T.same(session.sel.anchor, session.sel.focus);
  const caret = at => ({ anchor: at, focus: at });
  const clamp = pos => T.clampPos(session.doc, pos, lo(), hi());

  function readField(s, value, box) {
    s.value = value;
    if (s.from !== undefined) {
      if (box) s.to = Number(box.dataset.to);
      s.doc = T.readDoc(s.dialect, value.slice(s.from, s.to));
    } else {
      s.doc = T.readDoc(s.dialect, value);
      // A side of a comparison with only its heading: the box under it stands for a first item.
      while (s.doc.length <= s.first) s.doc.push(empty());
    }
  }

  function begin(box) {
    const slide = host.slide();
    if (!slide || host.readOnly()) return null;
    // The box under the pointer must outlive this press, so the one left is not drawn again yet.
    if (session) end({ quiet: true });
    const d = box.dataset;
    const s = { slideId: slide.id, field: d.field, dialect: d.dialect, key: d.key, single: 'single' in d, marks: null, focused: false };
    if (d.from !== undefined) { s.from = Number(d.from); s.to = Number(d.to); s.first = 0; } else s.first = Number(d.first);
    readField(s, normal(slide[s.field]), null);
    s.sel = caret({ p: s.first, o: 0 });
    session = s;
    prepare(box);
    return s;
  }

  /** The box as an editor: the browser's caret and selection, and no placeholder words. */
  function prepare(box) {
    if (box.getAttribute('contenteditable') !== 'true') box.setAttribute('contenteditable', 'true');
    box.spellcheck = false;
    box.setAttribute('role', 'textbox');
    box.setAttribute('aria-multiline', String(T.multiline(session.dialect) && !session.single));
    box.setAttribute('aria-label', FIELD_NAMES[session.field] ?? 'Text');
    box.classList.add('editing');
    if (box.classList.contains('dk-ghost')) {
      box.classList.remove('dk-ghost');
      for (const p of box.querySelectorAll(':scope > p')) {
        for (const node of [...p.childNodes]) if (!node.classList?.contains('dk-b')) node.remove();
        p.append(document.createElement('br'));
      }
    }
  }

  const paraEls = box => [...box.children].filter(el => el.tagName === 'P');
  function textNodes(p) {
    const out = [];
    const walk = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) if (!walk.currentNode.parentElement.closest('.dk-b')) out.push(walk.currentNode);
    return out;
  }
  /** A point in the box's DOM as {i, o}: its paragraph in the box, and the characters before it there. */
  function domToPos(box, node, offset) {
    if (!node || !box.contains(node)) return null;
    const ps = paraEls(box);
    if (node === box) return offset >= ps.length ? { i: ps.length - 1, o: Infinity } : { i: offset, o: 0 };
    const element = node.nodeType === 1 ? node : node.parentElement;
    const p = element.closest('p');
    if (!p || p.parentElement !== box) return null;
    const i = ps.indexOf(p);
    if (element.closest('.dk-b')) return { i, o: 0 };
    const point = document.createRange();
    point.setStart(node, offset);
    let o = 0;
    for (const t of textNodes(p)) {
      if (t === node) { o += offset; break; }
      if (point.comparePoint(t, t.length) <= 0) o += t.length; else break;
    }
    return { i, o };
  }
  /** A paragraph in the box and an offset in its words as a DOM point; at a run's edge, the end of the earlier run. */
  function posToDom(box, i, o) {
    const p = paraEls(box)[i];
    if (!p) return null;
    const nodes = textNodes(p);
    let left = o;
    for (const t of nodes) { if (left <= t.length) return [t, left]; left -= t.length; }
    if (nodes.length) return [nodes.at(-1), nodes.at(-1).length];
    const bullet = p.querySelector(':scope > .dk-b');
    return [p, bullet ? [...p.childNodes].indexOf(bullet) + 1 : 0];
  }
  const toDoc = ({ i, o }) => clamp({ p: session.first + i, o });

  /** The browser's selection, as positions in the paragraphs. A move of the caret forgets marks chosen for typing. */
  function readSelection() {
    if (!session || composing) return;
    const box = boxFor(session), sel = getSelection();
    if (!box || !sel?.rangeCount || !box.contains(sel.anchorNode)) return;
    const a = domToPos(box, sel.anchorNode, sel.anchorOffset), f = domToPos(box, sel.focusNode, sel.focusOffset);
    if (!a || !f) return;
    const next = { anchor: toDoc(a), focus: toDoc(f) };
    if (!T.same(next.anchor, session.sel.anchor) || !T.same(next.focus, session.sel.focus)) session.marks = null;
    session.sel = next;
  }
  function writeSelection(box) {
    const { anchor, focus } = session.sel;
    const a = posToDom(box, anchor.p - session.first, anchor.o), f = posToDom(box, focus.p - session.first, focus.o);
    if (a && f) getSelection().setBaseAndExtent(a[0], a[1], f[0], f[1]);
  }

  /** After each drawing of the stage: the edited box again, with the caret where it was. */
  function attach() {
    if (!session) return;
    const slide = host.slide();
    const box = boxFor(session);
    if (!slide || slide.id !== session.slideId || !box) { end(); return; }
    const value = normal(slide[session.field]);
    if (value !== session.value) {
      // The field changed under the box: Undo, the inspector, the agent. Read it again.
      readField(session, value, box);
      session.sel = { anchor: clamp(session.sel.anchor), focus: clamp(session.sel.focus) };
    }
    prepare(box);
    if (session.focused) {
      if (document.activeElement !== box) box.focus({ preventScroll: true });
      writeSelection(box);
    }
  }

  function end({ blur = false, quiet = false } = {}) {
    if (!session) return;
    const box = boxFor(session);
    session = null; composing = null;
    closeMenu(false);
    if (box) {
      box.removeAttribute('contenteditable'); box.removeAttribute('role'); box.removeAttribute('aria-multiline'); box.removeAttribute('aria-label');
      box.classList.remove('editing');
      if (blur) { box.blur(); getSelection()?.removeAllRanges(); }
    }
    host.ended({ quiet });
  }

  // ---- Changes ------------------------------------------------------------------------------------

  /** The paragraphs as the field's words: written, drawn, and kept for Undo. */
  function commit(doc, sel, label) {
    const s = session;
    // A space before a paragraph's words is not kept: the field drops it, the box would not show
    // it, and a cell would no longer start where its box says.
    ({ doc, sel } = T.trimLeads(doc, sel));
    const text = T.writeDoc(s.dialect, doc);
    const value = s.from === undefined ? text : s.value.slice(0, s.from) + text + s.value.slice(s.to);
    const before = { value: s.value, sel: s.sel, to: s.to };
    s.doc = doc; s.sel = sel;
    if (s.from !== undefined) s.to = s.from + text.length;
    if (value === s.value) { const box = boxFor(s); if (box) writeSelection(box); return; }
    s.value = value;
    remember({ slideId: s.slideId, field: s.field, from: s.from, before: before.value, after: value, selBefore: before.sel, selAfter: sel, toBefore: before.to, toAfter: s.to, label });
    host.write(s.field, value);
  }
  function remember(entry) {
    const last = undo.at(-1), now = Date.now();
    // A run of typing in one place is one step back, as in PowerPoint: it goes on from where the
    // last letter left the caret, with no selection to replace.
    const goesOn = () => T.same(entry.selBefore.anchor, last.selAfter.focus) && T.same(entry.selBefore.focus, last.selAfter.focus);
    if (entry.label === 'typing' && last?.label === 'typing' && goesOn() && last.slideId === entry.slideId && last.field === entry.field && last.from === entry.from && now - last.time < 2000) {
      Object.assign(last, { after: entry.after, selAfter: entry.selAfter, toAfter: entry.toAfter, time: now, at: now });
    } else undo.push({ ...entry, time: now, at: now });
    if (undo.length > 300) undo.shift();
    redo.length = 0;
    // A new change of words ends what the view's own steps could redo, as one Ctrl Y would.
    host.changed?.();
  }
  /** The top step Ctrl Z (back) or Ctrl Y would take, of a slide still in the deck. */
  function top(back) {
    const stack = back ? undo : redo;
    for (let at = stack.length - 1; at >= 0; at--) if (host.hasSlide(stack[at].slideId)) return stack[at];
    return null;
  }
  /**
   * Ctrl Z (back) and Ctrl Y: the slide's words as they were, and the selection with them. Only a
   * slide of the open deck is stepped; a change to one in another deck, or deleted, waits.
   */
  function step(back) {
    const stack = back ? undo : redo;
    let at = stack.length - 1;
    while (at >= 0 && !host.hasSlide(stack[at].slideId)) at--;
    if (at < 0) return false;
    const entry = stack[at];
    if (host.slide()?.id !== entry.slideId) host.selectSlide(entry.slideId);
    if (host.slide()?.id !== entry.slideId) return false;
    stack.splice(at, 1);
    entry.at = Date.now();
    (back ? redo : undo).push(entry);
    const value = back ? entry.before : entry.after;
    if (session && session.slideId === entry.slideId && session.field === entry.field && session.from === entry.from) {
      if (session.from !== undefined) session.to = back ? entry.toBefore : entry.toAfter;
      readField(session, value, null);
      const sel = back ? entry.selBefore : entry.selAfter;
      session.sel = { anchor: clamp(sel.anchor), focus: clamp(sel.focus) };
    }
    host.write(entry.field, value);
    return true;
  }

  /** Paragraphs fit for the box: a single-line box takes them as one line. */
  function fitted(paras) {
    const fit = T.conform(session.dialect, paras);
    if (fit.length > 1 && (session.single || !T.multiline(session.dialect))) {
      return [{ kind: 'plain', level: 0, runs: mergeRuns(fit.flatMap((p, i) => i ? [{ text: ' ' }, ...p.runs] : p.runs)) }];
    }
    return fit;
  }
  function removeSelection() {
    const [a, b] = ordered();
    return T.same(a, b) ? { doc: session.doc, at: a } : T.remove(session.doc, a, b);
  }
  function typeText(text) {
    if (!text) return;
    const { doc, at } = removeSelection();
    const marks = T.marked(session.dialect) ? session.marks ?? T.marksAt(doc, at) : {};
    const r = T.insert(doc, at, fitted(T.typed(text, marks)));
    commit(r.doc, caret(r.at), 'typing');
  }
  function enter() {
    if (!T.multiline(session.dialect) || session.single) return;
    const { doc, at } = removeSelection();
    const r = T.split(doc, at);
    commit(r.doc, caret(r.at), 'enter');
  }
  function del(type, ranges) {
    if (!collapsed()) { const r = removeSelection(); commit(r.doc, caret(r.at), 'delete'); return; }
    const at = session.sel.focus, doc = session.doc, here = doc[at.p];
    const back = /Backward$/.test(type);
    if (back && at.o === 0) {
      // At a list item's start Backspace takes a level, then the bullet, before it joins paragraphs.
      if (here.kind === 'bullet' || here.kind === 'number') {
        commit(here.level ? T.shiftLevel(doc, at.p, at.p, -1) : T.setKind(doc, at.p, at.p, 'plain'), caret(at), 'list');
      } else if (at.p > lo()) {
        const r = T.remove(doc, { p: at.p - 1, o: T.lengthOf(doc[at.p - 1]) }, at);
        commit(r.doc, caret(r.at), 'delete');
      }
      return;
    }
    if (!back && at.o === T.lengthOf(here)) {
      if (at.p < hi()) { const r = T.remove(doc, at, { p: at.p + 1, o: 0 }); commit(r.doc, caret(r.at), 'delete'); }
      return;
    }
    // Inside a paragraph the browser says how far a character, a word or a line reaches.
    let from = null, to = null;
    const box = boxFor(session), range = ranges[0];
    if (box && range && !range.collapsed) {
      const a = domToPos(box, range.startContainer, range.startOffset), b = domToPos(box, range.endContainer, range.endOffset);
      if (a && b) { from = toDoc(a); to = toDoc(b); }
    }
    if (!from || T.same(from, to)) {
      const t = T.textOf(here);
      const width = back ? (at.o > 1 && /[\uDC00-\uDFFF]/.test(t[at.o - 1]) ? 2 : 1) : (/[\uD800-\uDBFF]/.test(t[at.o]) ? 2 : 1);
      from = back ? { p: at.p, o: at.o - width } : at;
      to = back ? at : { p: at.p, o: at.o + width };
    }
    const r = T.remove(doc, from, to);
    commit(r.doc, caret(r.at), 'delete');
  }

  /** Bold, italic or underline: on the selection; with none, on the word the caret is in, or on what is typed next. */
  function toggle(mark) {
    if (!session || !T.marked(session.dialect)) return;
    let [a, b] = ordered();
    if (T.same(a, b)) {
      const word = T.wordAt(session.doc, a);
      if (!word) { const m = session.marks ?? T.marksAt(session.doc, a); session.marks = { ...m, [mark]: !m[mark] }; return; }
      [a, b] = word;
    } else [a, b] = T.inward(session.doc, a, b);
    const on = !T.hasMark(session.doc, a, b, mark);
    commit(T.setMark(session.doc, a, b, mark, on), session.sel, 'format');
  }
  /** Whether the selection (or what the caret types) has a mark. */
  function markState(mark) {
    const [a, b] = ordered();
    if (T.same(a, b)) {
      const word = T.wordAt(session.doc, a);
      if (!word) return !!(session.marks ?? T.marksAt(session.doc, a))[mark];
      return !!T.hasMark(session.doc, word[0], word[1], mark);
    }
    return !!T.hasMark(session.doc, ...T.inward(session.doc, a, b), mark);
  }
  const listable = () => T.listed(session.dialect) && !session.single;
  /** The paragraphs the selection touches, as one kind when they share it. */
  function kindState() {
    const [a, b] = ordered();
    const kinds = new Set(session.doc.slice(a.p, b.p + 1).map(p => p.kind === 'heading' ? 'plain' : p.kind));
    return kinds.size === 1 ? [...kinds][0] : null;
  }
  function list(kind) {
    if (!listable()) return;
    const [a, b] = ordered();
    commit(T.setKind(session.doc, a.p, b.p, kind), session.sel, 'list');
  }
  function level(delta) {
    if (!listable()) return;
    const [a, b] = ordered();
    commit(T.shiftLevel(session.doc, a.p, b.p, delta), session.sel, 'list');
  }
  function selectAll() {
    session.sel = { anchor: { p: lo(), o: 0 }, focus: { p: hi(), o: T.lengthOf(session.doc[hi()]) } };
    const box = boxFor(session);
    if (box) writeSelection(box);
  }

  // ---- Size and alignment, kept on the slide (format) ----------------------------------------------

  function formatOf() { return parseFormat(host.slide()?.format); }
  function setFormat(change) {
    const slide = host.slide();
    if (!session || !slide) return;
    const format = formatOf();
    const entry = { ...(format[session.key] ?? {}), ...change };
    for (const k of Object.keys(entry)) if (entry[k] === undefined || entry[k] === null) delete entry[k];
    format[session.key] = entry;
    const value = formatText(format), before = slide.format ?? '';
    if (value === before) return;
    remember({ slideId: slide.id, field: 'format', before, after: value, label: 'format' });
    host.write('format', value);
  }
  /** The size set for the box, in points: the layout's own times the slide's scale for it. */
  function setSize() {
    const box = boxFor(session);
    return box ? Number(box.dataset.base) * (formatOf()[session.key]?.size ?? 1) * PT : 0;
  }
  /** The size the box is drawn at, which is smaller when its words are shrunk to fit. */
  const drawnSize = () => Number(boxFor(session)?.dataset.size ?? 0) * PT;
  /** The sizes in points the box can take: those within the scales a slide's format keeps. */
  function sizes() {
    const points = Number(boxFor(session)?.dataset.base) * PT;
    return points > 0 ? SIZES.filter(x => x >= points * SCALE.min - 0.01 && x <= points * SCALE.max + 0.01) : [];
  }
  function sizeTo(points) {
    const base = Number(boxFor(session)?.dataset.base);
    if (!session || !(base > 0) || !(points > 0)) return;
    const scale = Math.min(SCALE.max, Math.max(SCALE.min, points / PT / base));
    setFormat({ size: Math.abs(scale - 1) < 0.005 ? undefined : Math.round(scale * 1000) / 1000 });
  }
  function grow(direction) {
    const now = Math.round(setSize() * 2) / 2, all = sizes();
    const next = direction > 0 ? all.find(x => x > now + 0.01) : [...all].reverse().find(x => x < now - 0.01);
    if (next) sizeTo(next);
  }
  const align = value => setFormat({ align: value });
  const alignState = () => formatOf()[session.key]?.align ?? boxFor(session)?.style.textAlign ?? 'left';

  // ---- Clipboard ----------------------------------------------------------------------------------

  function copySelection(data) {
    const [a, b] = ordered();
    if (T.same(a, b)) return false;
    const paras = T.slice(session.doc, a, b);
    data.setData('text/plain', T.toPlain(paras));
    data.setData('text/html', T.toHtml(paras));
    return true;
  }
  function pasteData(html, text) {
    let paras = html ? T.withEdges(fromHtml(html), text) : [];
    if (!paras.length && text) paras = T.typed(text);
    if (!paras.length) return;
    if (!T.marked(session.dialect)) paras = paras.map(p => ({ ...p, runs: [{ text: T.textOf(p) }] }));
    const { doc, at } = removeSelection();
    const r = T.insert(doc, at, fitted(paras));
    commit(r.doc, caret(r.at), 'paste');
  }
  /** Copy, cut and paste from the menu: the browser's own commands where it allows them, the clipboard API where not. */
  async function clipboard(action) {
    const box = boxFor(session);
    if (!box) return;
    box.focus({ preventScroll: true });
    writeSelection(box);
    if (action === 'paste' || action === 'plain') {
      try {
        let html = '', text = '';
        if (action === 'paste' && navigator.clipboard?.read) {
          for (const item of await navigator.clipboard.read()) {
            if (!html && item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
            if (!text && item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
          }
        } else text = await navigator.clipboard.readText();
        if (session) pasteData(html, text);
      } catch { host.toast('Deck could not read the clipboard from the menu. Press Ctrl+V to paste.'); }
      return;
    }
    if (document.execCommand(action)) return;
    const [a, b] = ordered();
    if (T.same(a, b)) return;
    const paras = T.slice(session.doc, a, b);
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([T.toPlain(paras)], { type: 'text/plain' }), 'text/html': new Blob([T.toHtml(paras)], { type: 'text/html' }) })]);
      if (action === 'cut' && session) { const r = removeSelection(); commit(r.doc, caret(r.at), 'cut'); }
    } catch { host.toast(`Deck could not reach the clipboard from the menu. Press Ctrl+${action === 'cut' ? 'X' : 'C'}.`); }
  }

  // ---- Events on the stage ------------------------------------------------------------------------

  const inBox = e => !!session && !!e.target?.closest?.('.dk-t.editing');
  const stage = host.stage;

  stage.addEventListener('mousedown', e => {
    if (e.button !== 0 && e.button !== 2) return;
    const box = e.target.closest?.('.dk-t[data-field]');
    if (!box || host.readOnly()) return;
    if (session && boxFor(session) === box) return;
    // Editable before the browser handles the press, so the press itself places the caret.
    if (begin(box)) session.focused = true;
  });
  stage.addEventListener('dragstart', e => { if (inBox(e)) e.preventDefault(); });
  stage.addEventListener('focusin', e => { if (inBox(e)) session.focused = true; });
  stage.addEventListener('focusout', e => {
    if (!session) return;
    const to = e.relatedTarget;
    // No next element: the window lost focus, or the box was drawn again. Neither ends the editing.
    if (!to || menu?.contains(to) || boxFor(session)?.contains(to)) return;
    end();
  });
  document.addEventListener('selectionchange', () => readSelection());
  document.addEventListener('mousedown', e => {
    if (menu && !menu.contains(e.target)) closeMenu(false);
    if (!session || menu?.contains(e.target) || boxFor(session)?.contains(e.target)) return;
    // Another box of the slide begins its own editing; anywhere else ends this one.
    if (stage.contains(e.target) && e.target.closest?.('.dk-t[data-field]')) return;
    end();
  }, true);

  stage.addEventListener('beforeinput', e => {
    if (!inBox(e)) return;
    // The input method's own text is settled when it ends (compositionend).
    if (e.inputType === 'insertCompositionText') return;
    e.preventDefault();
    readSelection();
    const type = e.inputType, ranges = e.getTargetRanges?.() ?? [];
    if (type === 'insertText' || type === 'insertReplacementText') {
      const box = boxFor(session), range = ranges[0];
      if (type === 'insertReplacementText' && box && range) {
        const a = domToPos(box, range.startContainer, range.startOffset), b = domToPos(box, range.endContainer, range.endOffset);
        if (a && b) session.sel = { anchor: toDoc(a), focus: toDoc(b) };
      }
      typeText(e.data ?? e.dataTransfer?.getData('text/plain') ?? '');
    } else if (type === 'insertParagraph' || type === 'insertLineBreak') enter();
    else if (type.startsWith('delete') && type !== 'deleteByCut' && type !== 'deleteByDrag') del(type, ranges);
    else if (type === 'historyUndo') step(true);
    else if (type === 'historyRedo') step(false);
    else if (type === 'formatBold') toggle('b');
    else if (type === 'formatItalic') toggle('i');
    else if (type === 'formatUnderline') toggle('u');
    else if (type === 'insertFromPaste' || type === 'insertFromDrop' || type === 'insertFromYank') {
      if (e.dataTransfer) pasteData(e.dataTransfer.getData('text/html'), e.dataTransfer.getData('text/plain'));
    }
  });
  stage.addEventListener('compositionstart', e => {
    if (!inBox(e)) return;
    readSelection();
    composing = { doc: session.doc, sel: session.sel };
  });
  stage.addEventListener('compositionend', e => {
    if (!session || !composing) return;
    const before = composing;
    composing = null;
    session.doc = before.doc; session.sel = before.sel;
    if (e.data) typeText(e.data); else host.redraw();
  });
  stage.addEventListener('copy', e => { if (inBox(e)) { readSelection(); if (copySelection(e.clipboardData)) e.preventDefault(); } });
  stage.addEventListener('cut', e => {
    if (!inBox(e)) return;
    e.preventDefault();
    readSelection();
    if (copySelection(e.clipboardData)) { const r = removeSelection(); commit(r.doc, caret(r.at), 'cut'); }
  });
  stage.addEventListener('paste', e => {
    if (!inBox(e)) return;
    e.preventDefault();
    readSelection();
    const plain = plainPaste;
    plainPaste = false;
    pasteData(plain ? '' : e.clipboardData.getData('text/html'), e.clipboardData.getData('text/plain'));
  });
  stage.addEventListener('keydown', e => {
    if (!inBox(e) || e.isComposing) return;
    readSelection();
    const ctrl = e.ctrlKey || e.metaKey, key = e.key, lower = key.length === 1 ? key.toLowerCase() : key;
    const take = fn => { e.preventDefault(); fn(); };
    if (key === 'Escape') return take(() => end({ blur: true }));
    if (key === 'Tab') return take(() => level(e.shiftKey ? -1 : 1));
    if (key === 'ContextMenu' || (key === 'F10' && e.shiftKey)) return take(() => openMenuAtCaret());
    if (!ctrl || e.altKey) return;
    if (lower === 'z' && !e.shiftKey) return take(() => step(true));
    if (lower === 'y' || (lower === 'z' && e.shiftKey)) return take(() => step(false));
    // Ctrl B is Nendo's own key and never arrives here inside Nendo; the menu has Bold.
    if (lower === 'b' || lower === 'i' || lower === 'u') return take(() => toggle(lower));
    if (lower === 'l' || lower === 'e' || lower === 'r' || lower === 'j') return take(() => align({ l: 'left', e: 'center', r: 'right', j: 'justify' }[lower]));
    if (key === ']' || (e.shiftKey && (key === '>' || key === '.'))) return take(() => grow(1));
    if (key === '[' || (e.shiftKey && (key === '<' || key === ','))) return take(() => grow(-1));
    if (lower === 'a') return take(() => selectAll());
    if (lower === 'v' && e.shiftKey) plainPaste = true;
  });
  stage.addEventListener('contextmenu', e => {
    const box = e.target.closest?.('.dk-t[data-field]');
    if (!box || host.readOnly()) return;
    e.preventDefault();
    if (!session || boxFor(session) !== box) { begin(box); session.focused = true; box.focus({ preventScroll: true }); placeAt(box, e.clientX, e.clientY); }
    else { readSelection(); if (!insideSelection(e.clientX, e.clientY)) placeAt(box, e.clientX, e.clientY); }
    openMenu(e.clientX, e.clientY);
  });

  function placeAt(box, x, y) {
    const range = document.caretRangeFromPoint?.(x, y);
    if (range && box.contains(range.startContainer)) getSelection().collapse(range.startContainer, range.startOffset);
    readSelection();
  }
  function insideSelection(x, y) {
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return false;
    return [...sel.getRangeAt(0).getClientRects()].some(r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
  }
  function openMenuAtCaret() {
    const sel = getSelection();
    const rect = sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
    const box = boxFor(session)?.getBoundingClientRect();
    openMenu(rect && rect.height ? rect.left : box?.left ?? 0, rect && rect.height ? rect.bottom : box?.top ?? 0, true);
  }

  // ---- The menu -----------------------------------------------------------------------------------

  /** A menu item: {id, label, keys, kind: item|check|radio|sub, checked, disabled, items}. */
  function menuItems() {
    const marks = T.marked(session.dialect), lists = listable(), some = !collapsed();
    const now = Math.round(setSize() * 2) / 2, drawn = Math.round(drawnSize() * 2) / 2;
    const kind = kindState(), aligned = alignState();
    return [
      { id: 'cut', label: 'Cut', keys: 'Ctrl+X', disabled: !some },
      { id: 'copy', label: 'Copy', keys: 'Ctrl+C', disabled: !some },
      { id: 'paste', label: 'Paste', keys: 'Ctrl+V' },
      { id: 'plain', label: 'Paste as plain text', keys: 'Ctrl+Shift+V' },
      { kind: 'separator' },
      { id: 'b', kind: 'check', label: 'Bold', checked: marks && markState('b'), disabled: !marks },
      { id: 'i', kind: 'check', label: 'Italic', keys: 'Ctrl+I', checked: marks && markState('i'), disabled: !marks },
      { id: 'u', kind: 'check', label: 'Underline', keys: 'Ctrl+U', checked: marks && markState('u'), disabled: !marks },
      { kind: 'separator' },
      { id: 'size', kind: 'sub', label: 'Font size', detail: `${now} pt`, items: [
        { id: 'grow', label: 'Larger', keys: 'Ctrl+]' },
        { id: 'shrink', label: 'Smaller', keys: 'Ctrl+[' },
        { id: 'size.reset', label: 'The layout’s size', disabled: !formatOf()[session.key]?.size },
        { kind: 'separator' },
        ...(drawn && drawn < now - 0.25 ? [{ kind: 'label', label: `Shrunk to ${drawn} pt to fit` }] : []),
        ...sizes().filter(x => x >= 10).map(x => ({ id: `size.${x}`, kind: 'radio', label: `${x}`, checked: Math.abs(x - now) < 0.26 })),
      ] },
      { id: 'align', kind: 'sub', label: 'Alignment', items: ALIGN_LABELS.map(([value, label, keys]) => ({ id: `align.${value}`, kind: 'radio', label, keys, checked: aligned === value })) },
      { id: 'list', kind: 'sub', label: 'Bullets and numbering', disabled: !lists, items: [
        { id: 'list.plain', kind: 'radio', label: 'None', checked: kind === 'plain' },
        { id: 'list.bullet', kind: 'radio', label: 'Bullets', checked: kind === 'bullet' },
        { id: 'list.number', kind: 'radio', label: 'Numbering', checked: kind === 'number' },
        { kind: 'separator' },
        { id: 'level.in', label: 'Increase list level', keys: 'Tab', disabled: kind === 'plain' },
        { id: 'level.out', label: 'Decrease list level', keys: 'Shift+Tab', disabled: kind === 'plain' },
      ] },
      { kind: 'separator' },
      { id: 'all', label: 'Select all', keys: 'Ctrl+A' },
    ];
  }

  function act(id) {
    if (!session) return;
    if (['cut', 'copy', 'paste', 'plain'].includes(id)) { clipboard(id); return; }
    if (id === 'b' || id === 'i' || id === 'u') toggle(id);
    else if (id === 'grow') grow(1);
    else if (id === 'shrink') grow(-1);
    else if (id === 'size.reset') setFormat({ size: undefined });
    else if (id.startsWith('size.')) sizeTo(Number(id.slice(5)));
    else if (id.startsWith('align.')) align(id.slice(6));
    else if (id.startsWith('list.')) list(id.slice(5));
    else if (id === 'level.in') level(1);
    else if (id === 'level.out') level(-1);
    else if (id === 'all') selectAll();
  }

  function buildMenu(items, sub = false) {
    const el = document.createElement('div');
    el.className = sub ? 'tx-menu tx-sub' : 'tx-menu';
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-label', sub ? 'Submenu' : 'Text');
    for (const item of items) {
      if (item.kind === 'separator') { const s = document.createElement('div'); s.setAttribute('role', 'separator'); s.className = 'tx-sep'; el.append(s); continue; }
      if (item.kind === 'label') { const s = document.createElement('div'); s.className = 'tx-label'; s.textContent = item.label; el.append(s); continue; }
      const b = document.createElement('button');
      b.type = 'button'; b.tabIndex = -1; b.dataset.id = item.id;
      b.setAttribute('role', item.kind === 'check' ? 'menuitemcheckbox' : item.kind === 'radio' ? 'menuitemradio' : 'menuitem');
      if (item.kind === 'check' || item.kind === 'radio') b.setAttribute('aria-checked', String(!!item.checked));
      if (item.disabled) b.setAttribute('aria-disabled', 'true');
      const mark = document.createElement('span'); mark.className = 'tx-mark'; mark.setAttribute('aria-hidden', 'true');
      mark.textContent = item.checked ? (item.kind === 'radio' ? '•' : '✓') : '';
      const label = document.createElement('span'); label.className = 'tx-text'; label.textContent = item.label;
      const keys = document.createElement('span'); keys.className = 'tx-keys';
      keys.textContent = item.kind === 'sub' ? `${item.detail ? `${item.detail}  ` : ''}›` : item.keys ?? '';
      if (item.keys) b.setAttribute('aria-keyshortcuts', item.keys.replace('Ctrl+]', 'Control+BracketRight').replace('Ctrl+[', 'Control+BracketLeft').replaceAll('Ctrl', 'Control'));
      b.append(mark, label, keys);
      if (item.kind === 'sub') { b.setAttribute('aria-haspopup', 'menu'); b.setAttribute('aria-expanded', 'false'); b._items = item.items; }
      el.append(b);
    }
    return el;
  }

  /** A mini toolbar over the menu, as PowerPoint draws one: B, I, U, the size, alignment and bullets. */
  function buildBar() {
    const bar = document.createElement('div');
    bar.className = 'tx-bar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Format');
    const marks = T.marked(session.dialect), lists = listable();
    const button = (id, text, label, pressed, disabled, cls = '') => {
      const b = document.createElement('button');
      b.type = 'button'; b.tabIndex = -1; b.dataset.id = id; b.className = cls; b.textContent = text; b.title = label;
      b.setAttribute('aria-label', label);
      if (pressed !== null) b.setAttribute('aria-pressed', String(!!pressed));
      if (disabled) b.disabled = true;
      return b;
    };
    const size = document.createElement('select');
    size.className = 'tx-size'; size.title = 'Font size'; size.setAttribute('aria-label', 'Font size'); size.tabIndex = -1;
    const now = Math.round(setSize() * 2) / 2;
    const options = [...new Set([...sizes(), now])].sort((a, b) => a - b);
    for (const x of options) size.append(new Option(String(x), String(x), false, Math.abs(x - now) < 0.01));
    size.addEventListener('change', () => { const value = Number(size.value); closeMenu(true); sizeTo(value); });
    const kind = kindState(), aligned = alignState();
    bar.append(
      button('b', 'B', 'Bold', marks && markState('b'), !marks, 'tx-b'), button('i', 'I', 'Italic (Ctrl+I)', marks && markState('i'), !marks, 'tx-i'),
      button('u', 'U', 'Underline (Ctrl+U)', marks && markState('u'), !marks, 'tx-u'),
      size, button('grow', 'A+', 'Larger (Ctrl+])', null, false), button('shrink', 'A−', 'Smaller (Ctrl+[)', null, false),
      ...ALIGN_LABELS.map(([value, label, keys]) => button(`align.${value}`, { left: '⫷', center: '≡', right: '⫸', justify: '☰' }[value], `${label} (${keys})`, aligned === value, false, 'tx-align')),
      button(kind === 'bullet' ? 'list.plain' : 'list.bullet', '•', 'Bullets', kind === 'bullet', !lists), button(kind === 'number' ? 'list.plain' : 'list.number', '1.', 'Numbering', kind === 'number', !lists),
    );
    return bar;
  }

  function place(el, x, y, beside = null) {
    if (!el.isConnected) document.body.append(el);
    const r = el.getBoundingClientRect(), W = innerWidth, H = innerHeight;
    let left = beside ? beside.right - 2 : x, top = beside ? beside.top - 5 : y;
    if (left + r.width > W - 4) left = beside ? beside.left - r.width + 2 : W - r.width - 4;
    if (top + r.height > H - 4) top = Math.max(4, H - r.height - 4);
    el.style.left = `${Math.max(4, left)}px`; el.style.top = `${Math.max(4, top)}px`;
  }

  function openMenu(x, y, fromKeys = false) {
    closeMenu(false);
    if (!session) return;
    const wrap = document.createElement('div');
    wrap.className = 'tx-popup';
    const main = buildMenu(menuItems());
    wrap.append(buildBar(), main);
    menu = wrap;
    place(wrap, x, y);
    let sub = null;
    const items = el => [...el.querySelectorAll(':scope > button')];
    const openSub = (button, focus) => {
      if (sub?.owner === button) { if (focus) items(sub.el)[0]?.focus(); return; }
      closeSub();
      if (button.getAttribute('aria-disabled') === 'true') return;
      const el = buildMenu(button._items, true);
      wrap.append(el);
      sub = { el, owner: button };
      button.setAttribute('aria-expanded', 'true');
      place(el, 0, 0, button.getBoundingClientRect());
      el.style.position = 'fixed';
      if (focus) (items(el).find(b => b.getAttribute('aria-checked') === 'true') ?? items(el)[0])?.focus();
    };
    const closeSub = () => { if (!sub) return; sub.owner.setAttribute('aria-expanded', 'false'); sub.el.remove(); sub = null; };
    const pick = button => {
      if (!button || button.getAttribute('aria-disabled') === 'true' || button.disabled) return;
      if (button.getAttribute('aria-haspopup')) { openSub(button, true); return; }
      const id = button.dataset.id;
      closeMenu(true);
      act(id);
    };
    wrap.addEventListener('mousedown', e => { if (e.target.tagName !== 'SELECT') e.preventDefault(); });
    wrap.addEventListener('click', e => { const b = e.target.closest('button'); if (b) pick(b); });
    wrap.addEventListener('mouseover', e => {
      const b = e.target.closest('.tx-menu > button');
      if (!b) return;
      if (b.parentElement === main) { if (b.getAttribute('aria-haspopup')) openSub(b, false); else closeSub(); }
      b.focus({ preventScroll: true });
    });
    wrap.addEventListener('keydown', e => {
      const current = document.activeElement;
      const list = current?.parentElement?.classList.contains('tx-menu') ? current.parentElement : main;
      const all = items(list).filter(b => b.getAttribute('aria-disabled') !== 'true');
      const at = all.indexOf(current);
      const move = to => { e.preventDefault(); all[(to + all.length) % all.length]?.focus(); };
      if (e.key === 'ArrowDown') move(at + 1);
      else if (e.key === 'ArrowUp') move(at < 0 ? all.length - 1 : at - 1);
      else if (e.key === 'Home') move(0);
      else if (e.key === 'End') move(all.length - 1);
      else if (e.key === 'ArrowRight' && current?.getAttribute('aria-haspopup')) { e.preventDefault(); openSub(current, true); }
      else if ((e.key === 'ArrowLeft' || e.key === 'Escape') && list !== main) { e.preventDefault(); const owner = sub.owner; closeSub(); owner.focus(); }
      else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); closeMenu(true); }
      else if ((e.key === 'Enter' || e.key === ' ') && current?.tagName === 'BUTTON') { e.preventDefault(); pick(current); }
    });
    const first = items(main).find(b => b.getAttribute('aria-disabled') !== 'true');
    if (fromKeys) first?.focus(); else (first ?? main).focus?.({ preventScroll: true });
    if (window.deck) window.deck.menus = (window.deck.menus ?? 0) + 1;
  }

  /** Closes the menu; with `back`, the caret goes back into the box where it was. */
  function closeMenu(back) {
    if (!menu) return;
    menu.remove();
    menu = null;
    const box = boxFor(session);
    if (back && session && box) { box.focus({ preventScroll: true }); writeSelection(box); }
  }
  addEventListener('blur', () => closeMenu(false));
  addEventListener('resize', () => closeMenu(false));

  // ---- What a paste brings ------------------------------------------------------------------------

  /** HTML from the clipboard (Word, PowerPoint, a web page, this stage) as paragraphs with marks and lists. */
  function fromHtml(html) {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const out = [];
    let current = null;
    const open = (kind = 'plain', level = 0) => { current = { kind, level, runs: [] }; out.push(current); };
    const BLOCK = /^(P|DIV|H[1-6]|LI|TR|BLOCKQUOTE|PRE|SECTION|ARTICLE|HEADER|FOOTER|TABLE|DT|DD)$/;
    const walk = (node, marks, depth, listKind, item = null) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          const t = child.data.replace(/\s+/g, ' ');
          if (t.trim() || current?.runs.length) { if (!current) open(); current.runs.push(run(t, marks)); }
          continue;
        }
        if (child.nodeType !== 1) continue;
        const tag = child.tagName, style = child.getAttribute('style') ?? '';
        if (/^(STYLE|SCRIPT|HEAD|TITLE|META|LINK|TEMPLATE|NOSCRIPT)$/.test(tag)) continue;
        if (tag === 'BR') { open(current?.kind === 'heading' ? 'plain' : current?.kind ?? 'plain', current?.level ?? 0); continue; }
        const m = { ...marks };
        if (/^(B|STRONG)$/.test(tag) || /font-weight:\s*(bold|[6-9]00)/i.test(style)) m.b = true;
        // Google Docs wraps a whole copy in <b style="font-weight:normal">.
        if (/font-weight:\s*(normal|[1-5]00)/i.test(style)) delete m.b;
        if (/^(I|EM)$/.test(tag) || /font-style:\s*italic/i.test(style)) m.i = true;
        if (/^(U|INS)$/.test(tag) || /text-decoration[^;]*underline/i.test(style)) m.u = true;
        if (/^(CODE|KBD|SAMP)$/.test(tag)) m.code = true;
        if (tag === 'A') { const link = safeLink(child.getAttribute('href')); if (link) m.link = link; }
        if (tag === 'UL' || tag === 'OL') { current = null; walk(child, m, depth + 1, tag === 'OL' ? 'number' : 'bullet'); current = null; continue; }
        // Word and Google Docs wrap a list item's words in a paragraph: they stay the item's.
        if (item && current === item && !T.textOf(item) && /^(P|DIV)$/.test(tag)) { walk(child, m, depth, listKind, item); continue; }
        if (BLOCK.test(tag)) {
          const kind = tag === 'LI' ? listKind ?? 'bullet' : /^H[1-6]$/.test(tag) ? 'heading' : 'plain';
          open(kind, tag === 'LI' ? Math.min(1, Math.max(depth - 1, /margin-left:\s*[1-9]/.test(style) ? 1 : 0)) : 0);
          walk(child, m, depth, listKind, tag === 'LI' ? current : null);
          current = null;
          continue;
        }
        walk(child, m, depth, listKind);
      }
    };
    walk(parsed.body, {}, 0, null);
    return out.map(p => {
      const runs = mergeRuns(p.runs);
      if (runs.length) { runs[0] = run(runs[0].text.replace(/^\s+/, ''), runs[0]); const l = runs.length - 1; runs[l] = run(runs[l].text.replace(/\s+$/, ''), runs[l]); }
      return { ...p, runs: mergeRuns(runs) };
    }).filter(p => T.textOf(p));
  }

  return {
    attach,
    end,
    /** The field the stage is editing, which the layout keeps drawn while it is empty. */
    keep: () => session ? { field: session.field, from: session.from } : null,
    composing: () => !!composing,
    active: () => !!session,
    /** Ctrl Z and Ctrl Y when no field has focus: the stage's last change of words. */
    undo: back => step(back),
    /** When the step Ctrl Z (back) or Ctrl Y would take landed where it is, so the view can weigh it against its own; null for none. */
    peek: back => top(back)?.at ?? null,
    /** A slide was added, moved or deleted: the words' redo goes, as a new change of words ends it. */
    forgetRedo: () => { redo.length = 0; },
    /** A slide came back under a new ID: the typing steps on it follow it there. */
    renamed: (from, to) => { for (const entry of [...undo, ...redo]) if (entry.slideId === from) entry.slideId = to; },
    /** What the probes read: the box, its paragraphs and the selection as the page holds it now. */
    state: () => (readSelection(), session) ? { field: session.field, dialect: session.dialect, key: session.key, from: session.from, value: session.value, sel: session.sel,
      text: session.doc.map(T.textOf), kinds: session.doc.map(p => p.kind), marks: session.marks, undo: undo.length, redo: redo.length, menu: !!menu } : { undo: undo.length, redo: redo.length, menu: !!menu },
  };
}
