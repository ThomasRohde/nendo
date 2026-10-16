// The Quiet sheet: the whole manuscript as one continuous page, saved paragraph by paragraph.
import { BLOCK, NOTE, LINK, F, GAP, NOTE_KINDS, LINK_KINDS, REVIEW, ROLES, readManuscript, planWrites, chunkWrites, withTargetVersions, countWords, levelOf } from './model.mjs';
import { createSheet, freshId } from './editor.mjs';
import { exportPlan, safeName, pictureFiles, toMarkdown, toDocx } from './export.mjs';
import { Lexer } from './vendor/editor.js';

const nendo = window.nendo;
const $ = id => document.getElementById(id);
const STYLES = ['Paragraph', 'Section', 'Chapter', 'Part'];
const PAUSE = 1200, LONGEST = 10000;

const state = {
  root: null, cuttings: null, title: '', savedTitle: '', saved: new Map(), notes: [], links: [],
  gone: new Set(), drawer: null, selected: null, pinned: false, saving: null, again: false, timer: null, firstEdit: 0,
  status: 'Reading the file…', savedAt: null, problem: null, external: false, readOnly: false, chrome: false,
  appearance: readAppearance(), popover: null, roles: false,
};
window.manuscript = state;   // for the browser lane

// ---------- Appearance, per device ----------

function readAppearance() {
  const plain = { font: 'serif', size: 'medium', width: 'medium', pictures: 'small' };
  try { return { ...plain, ...JSON.parse(localStorage.getItem('manuscript.appearance') ?? '{}') }; }
  catch { return plain; }
}
function applyAppearance() {
  const a = state.appearance;
  document.documentElement.dataset.font = a.font;
  document.documentElement.dataset.size = a.size;
  document.documentElement.dataset.width = a.width;
  document.documentElement.dataset.pictures = a.pictures;
  try { localStorage.setItem('manuscript.appearance', JSON.stringify(a)); } catch { /* a private window keeps it for now */ }
  placeOverlays();
}

// ---------- The sheet ----------

const sheet = createSheet({
  element: $('sheet-text'),
  editable: false,
  placeholder: 'Write…',
  onChange: () => edited(),
  onSelect: where => selected(where),
  resolvePicture,
});

// Where a picture's address loads from: the open file's media origin for an embedded one.
const pictureUrls = new Map();
function resolvePicture(address) {
  if (!address) return null;
  if (!pictureUrls.has(address)) {
    pictureUrls.set(address, nendo.ready.then(() => nendo.has?.('media.describe') ? nendo.media.urlFor(address) : null).catch(() => null));
  }
  return pictureUrls.get(address);
}
window.manuscriptSheet = sheet;

// ---------- Drafts, on this device ----------
// Nendo stops a view that is off screen without asking, so text typed in the pause before a
// save is kept in the view's own storage (one origin per file and package) until it is saved.
const DRAFT_CHARACTERS = 2000000;
let draftTimer = null;
const draftKey = () => `manuscript.draft.v1.${nendo.context?.viewId ?? 'sheet'}`;
function keepDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    try {
      if (state.root === null || !pending()) { localStorage.removeItem(draftKey()); return; }
      const nodes = sheet.read(), present = new Set(nodes.map(n => n.id)), touched = {};
      for (const n of nodes) if (n.changed || !state.saved.has(n.id)) touched[n.id] = state.saved.get(n.id)?.version ?? null;
      for (const s of state.saved.values()) if (s.visible && !present.has(s.id)) touched[s.id] = s.version;
      const text = JSON.stringify({ root: state.root, title: state.title, titleVersion: state.saved.get(state.root)?.version ?? null, doc: sheet.json(), touched });
      if (text.length <= DRAFT_CHARACTERS) localStorage.setItem(draftKey(), text); else localStorage.removeItem(draftKey());
    } catch { /* storage refused: the next save is all there is */ }
  }, 300);
}
function dropDraft() { clearTimeout(draftTimer); try { localStorage.removeItem(draftKey()); } catch { /* nothing kept */ } }
function readDraft() { try { return JSON.parse(localStorage.getItem(draftKey()) ?? 'null'); } catch { return null; } }

/** A draft from before goes back on the page if nothing it touched has changed since; else the person decides. */
function offerDraft() {
  const draft = readDraft();
  if (!draft || draft.root !== state.root) { if (draft) dropDraft(); return; }
  const stale = Object.entries(draft.touched ?? {}).filter(([id, version]) => (state.saved.get(id)?.version ?? null) !== version);
  const titleStale = draft.title !== state.savedTitle && (state.saved.get(state.root)?.version ?? null) !== draft.titleVersion;
  const restore = () => {
    sheet.restore(draft.doc);
    state.title = draft.title; $('title').value = draft.title;
    state.problem = null;
    setStatus('Unsaved text kept from before; saving it');
    render();
    save();
  };
  if (!stale.length && !titleStale) { restore(); return; }
  state.problem = { text: `Text you had not saved is kept from before, but ${stale.length + (titleStale ? 1 : 0)} of the blocks it changes were changed since. Put yours back over them, or discard it.`,
    actions: [{ label: 'Put mine back', run: restore }, { label: 'Discard mine', run: () => { dropDraft(); state.problem = null; render(); } }] };
  render();
}

function edited() {
  state.problem = null;
  keepDraft();
  setStatus('Editing');
  clearTimeout(state.timer);
  if (!state.firstEdit) state.firstEdit = Date.now();
  const wait = Date.now() - state.firstEdit > LONGEST ? 0 : PAUSE;
  state.timer = setTimeout(() => save(), wait);
  placeOverlays();
  declare();
}

function selected(where) {
  if (!where) return;
  state.selected = where.id;
  if (!state.pinned && where.empty) closePopover();
  render();
}

// ---------- Reading ----------

async function readAll() {
  const items = await nendo.records.treeAll({ entityId: BLOCK, depth: 32 }, { max: 10000 });
  const [notes, links] = await Promise.all([
    nendo.records.queryAll({ entityId: NOTE }, { max: 10000 }),
    nendo.records.queryAll({ entityId: LINK }, { max: 10000 }),
  ]);
  return { manuscript: readManuscript(items), notes, links };
}

async function load() {
  const { manuscript, notes, links } = await readAll();
  state.root = manuscript.root; state.cuttings = manuscript.cuttings;
  state.saved = manuscript.saved; state.notes = notes; state.links = links;
  state.title = state.savedTitle = manuscript.title;
  $('title').value = manuscript.title;
  $('empty').hidden = state.root !== null;
  $('page').hidden = state.root === null;
  if (state.root !== null) {
    const keep = sheet.where();
    sheet.load(manuscript.nodes);
    if (keep?.id && sheet.locate(keep.id)) sheet.editor.commands.setTextSelection(sheet.locate(keep.id).pos + 1);
  }
  sheet.editor.setEditable(!state.readOnly && state.root !== null);
  state.external = false;
  setStatus(state.savedAt ? `Saved ${clock(state.savedAt)}` : 'Up to date');
  render();
}

// ---------- Saving ----------

function pending() {
  if (state.title !== state.savedTitle) return true;
  return sheet.read().some(n => n.changed || !state.saved.has(n.id));
}

async function save() {
  clearTimeout(state.timer);
  if (state.saving) { state.again = true; return state.saving; }
  if (state.root === null || state.readOnly) return;
  // The run is stored before any of it happens: a save with nothing to write finishes at its
  // first await, and its `finally` must find itself in state.saving to clear it.
  const run = (async () => {
    await null;
    try {
      for (const id of state.gone) if (sheet.locate(id)) sheet.renumber(id);
      const current = sheet.read();
      const plan = planWrites({ saved: state.saved, current, root: state.root, notes: state.notes, links: state.links });
      const root = state.saved.get(state.root);
      if (state.title !== state.savedTitle && root) plan.unshift({ op: 'update', entityId: BLOCK, recordId: state.root, version: root.version, values: { [F.text]: state.title || null }, refs: {} });
      state.firstEdit = 0;
      state.saveError = null;
      if (!plan.length) { setStatus(state.savedAt ? `Saved ${clock(state.savedAt)}` : 'Up to date'); return; }
      setStatus('Saving…');
      for (const batch of chunkWrites(plan)) await send(batch);
      sheet.saved(current);
      state.savedTitle = state.title;
      state.savedAt = new Date();
      setStatus(`Saved ${clock(state.savedAt)}`);
      if (!pending()) dropDraft();
    } catch (error) {
      state.saveError = refusalText(error);
      state.problem = { text: state.saveError, reload: true };
      setStatus('Not saved');
    } finally {
      if (state.saving === run) state.saving = null;
      render();
      if (state.again) { state.again = false; save(); }
    }
  })();
  state.saving = run;
  return run;
}

function versionOf(id) {
  return state.saved.get(id)?.version ?? state.notes.find(n => n.recordId === id)?.version ?? state.links.find(l => l.recordId === id)?.version;
}

async function send(batch, label = 'Write') {
  const writes = withTargetVersions(batch, versionOf);
  const writeKey = `mn-${freshId().slice(2)}`;
  let result;
  try { result = await nendo.records.batch(writes, { label, writeKey }); }
  catch (error) {
    if (error?.code !== 'disconnected' && error?.code !== 'host-timeout') throw error;
    result = await nendo.records.batch(writes, { label, writeKey });
  }
  result.records.forEach((r, i) => applyWrite(writes[i], r.version));
  return result;
}

function applyWrite(write, version) {
  if (write.entityId === BLOCK) {
    if (write.op === 'delete') { state.saved.delete(write.recordId); state.gone.add(write.recordId); sheet.forget(write.recordId); return; }
    const was = state.saved.get(write.recordId) ?? { id: write.recordId, visible: true };
    const v = write.values;
    const next = { ...was, version };
    if (F.text in v) next.text = v[F.text] ?? '';
    if (F.kind in v) next.kind = v[F.kind];
    if (F.parent in v) next.parent = v[F.parent];
    if (F.order in v) next.order = v[F.order];
    if (F.role in v) next.role = v[F.role];
    next.visible = write.recordId !== state.root && next.kind !== 'Cuttings' && next.parent !== state.cuttings;
    state.saved.set(write.recordId, next);
    return;
  }
  const list = write.entityId === NOTE ? state.notes : state.links;
  const at = list.findIndex(r => r.recordId === write.recordId);
  if (write.op === 'delete') { if (at >= 0) list.splice(at, 1); return; }
  const record = at >= 0 ? list[at] : { entityId: write.entityId, recordId: write.recordId, values: {} };
  const next = { ...record, version, values: { ...record.values, ...write.values } };
  if (at >= 0) list[at] = next; else list.push(next);
}

// ---------- Somebody else's changes ----------

let changeTimer = null;
function changed() {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(async () => {
    if (state.saving) { await state.saving; }
    try {
      const { manuscript, notes, links } = await readAll();
      const differs = [...manuscript.saved.values()].some(r => state.saved.get(r.id)?.version !== r.version) ||
        [...state.saved.keys()].some(id => !manuscript.saved.has(id));
      state.notes = notes; state.links = links;
      if (!differs) { render(); return; }
      if (!pending()) { await load(); return; }
      state.external = true;
      render();
    } catch (error) { state.problem = { text: refusalText(error), reload: true }; render(); }
  }, 300);
}

// ---------- Acting on the selected paragraph ----------

// What stops an action is this save failing, never a notice left on the page by something else.
async function flush() { await save(); if (state.saveError) throw Error(state.saveError); }

function block(id) { return state.saved.get(id); }
function preview(id, length = 70) {
  const node = sheet.locate(id)?.node;
  if (node?.type.name === 'picture') return `Picture: ${node.attrs.alt || 'no description'}`;
  const text = (node?.textContent ?? block(id)?.text ?? '').trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text || '(empty)';
}

async function addNote(kind, text) {
  await flush();
  const id = state.selected;
  if (!block(id)) return;
  await send([{ op: 'create', entityId: NOTE, recordId: `n-${freshId().slice(2)}`, values: { [F.noteBlock]: id, [F.noteKind]: kind, [F.noteText]: text, [F.noteDone]: false }, refs: { [F.noteBlock]: id } }], 'Add a note');
  closePopover(); state.drawer = 'notes'; render(); declare();
}

async function addLink(kind, target) {
  await flush();
  const id = state.selected;
  if (!block(id) || !block(target)) return;
  await send([{ op: 'create', entityId: LINK, recordId: `l-${freshId().slice(2)}`, values: { [F.linkFrom]: id, [F.linkTo]: target, [F.linkKind]: kind, [F.linkReview]: REVIEW.current }, refs: { [F.linkFrom]: id, [F.linkTo]: target } }], 'Link passages');
  closePopover(); state.drawer = 'related'; render(); declare();
}

async function keepAsCutting() {
  await flush();
  const id = state.selected, b = block(id);
  if (!b || levelOf(b.kind)) return;
  const writes = [];
  let cuttings = state.cuttings;
  if (cuttings === null) {
    cuttings = `b-cuttings-${freshId().slice(2, 8)}`;
    writes.push({ op: 'create', entityId: BLOCK, recordId: cuttings, values: { [F.kind]: 'Cuttings', [F.text]: 'Cuttings', [F.parent]: state.root, [F.order]: 1073741824 }, refs: { [F.parent]: state.root } });
  }
  const last = Math.max(0, ...[...state.saved.values()].filter(s => s.parent === cuttings).map(s => s.order ?? 0));
  writes.push({ op: 'update', entityId: BLOCK, recordId: id, version: b.version, values: { [F.parent]: cuttings, [F.order]: last + GAP }, refs: { [F.parent]: cuttings } });
  await send(writes, 'Keep as a cutting');
  state.cuttings = cuttings;
  const moved = state.saved.get(id);
  state.saved.set(id, { ...moved, visible: false });
  sheet.remove(id);
  state.selected = null; state.pinned = false; closePopover();
  toast('Kept in Cuttings, out of the manuscript.');
  render();
}

async function copyReference() {
  const id = state.selected;
  const text = `Manuscript block ${id}: “${preview(id, 90)}”`;
  try { await navigator.clipboard.writeText(text); toast('Copied a reference to this paragraph for the agent.'); closePopover(); }
  catch { openPopover('reference', { text }); }
}

async function setNoteDone(note, done) {
  await send([{ op: 'update', entityId: NOTE, recordId: note.recordId, version: note.version, values: { [F.noteDone]: done }, refs: {} }], 'Tick a note');
  render();
}
async function deleteRecord(record, label) {
  await send([{ op: 'delete', entityId: record.entityId, recordId: record.recordId, version: record.version }], label);
  render(); declare();
}

function toast(text) { if (nendo.has?.('ui.toast')) nendo.ui.toast(text).catch(() => {}); }

// ---------- Export (Markdown and Word) ----------

function download(blob, name) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 60000);
}

/** Exports the manuscript as saved in the file, after saving what is on the page. */
async function exportAs(format, layout = 'book') {
  await flush();
  setStatus('Exporting…');
  const items = await nendo.records.treeAll({ entityId: BLOCK, depth: 32 }, { max: 10000 });
  const plan = exportPlan(readManuscript(items));
  const lib = await import('./vendor/export.js');
  const pictures = new Map(), unread = [];
  for (const item of plan.items) {
    if (item.type !== 'picture' || pictures.has(item.address) || !item.address.startsWith('media:')) continue;
    try {
      if (!nendo.has('media.read')) throw Error('This Nendo does not let views read pictures.');
      const info = await nendo.media.describe(item.address);
      const blob = await nendo.media.read(item.address);
      pictures.set(item.address, { data: new Uint8Array(await blob.arrayBuffer()), mediaType: info.mediaType ?? blob.type, width: info.width, height: info.height });
    } catch { unread.push(item.alt || item.address); }
  }
  const name = safeName(plan.title);
  let file, blob, missing = [];
  if (format === 'markdown') {
    const files = pictureFiles(plan, pictures);
    const text = toMarkdown(plan, files);
    if (files.size) {
      const zip = new lib.JSZip();
      zip.file(`${name}.md`, text);
      for (const [address, path] of files) zip.file(path, pictures.get(address).data);
      blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/zip' });
      file = `${name}.zip`;
    } else { blob = new Blob([text], { type: 'text/markdown' }); file = `${name}.md`; }
    missing = plan.items.filter(i => i.type === 'picture' && i.address.startsWith('media:') && !files.has(i.address)).map(i => i.alt || i.address);
  } else {
    const built = toDocx(plan, pictures, lib, Lexer, layout);
    blob = await lib.Packer.toBlob(built.document);
    file = `${name}.docx`;
    missing = built.missing.map(m => m.alt || m.address);
  }
  download(blob, file);
  const counts = { blocks: plan.items.length, pictures: plan.items.filter(i => i.type === 'picture').length };
  state.lastExport = { format, layout: format === 'word' ? layout : null, file, bytes: blob.size, missing, ...counts };
  setStatus(`Exported ${file}`);
  toast(`Exported ${file} to your Downloads folder.`);
  if (missing.length) {
    state.problem = { text: `Exported ${file}, but ${missing.length} picture${missing.length === 1 ? '' : 's'} could not go in and stand${missing.length === 1 ? 's' : ''} as ${missing.length === 1 ? 'its description' : 'their descriptions'}: ${missing.join('; ')}.` };
  }
  render();
}

// ---------- Drawing ----------

function clock(date) { return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function setStatus(text) { state.status = text; declare(); renderStatus(); }

function refusalText(error) {
  const message = error?.message ?? String(error);
  if (/version|stale|changed/i.test(error?.code ?? '') || /changed/i.test(message))
    return `Not saved: this part of the manuscript changed elsewhere (${message}). Your text is still on the page; Reload takes the saved version.`;
  return `Not saved: ${message} Your text is still on the page.`;
}

function counts() {
  const notes = new Map(), links = new Map();
  for (const n of state.notes) { const b = n.values[F.noteBlock]; notes.set(b, (notes.get(b) ?? 0) + 1); }
  for (const l of state.links) for (const b of [l.values[F.linkFrom], l.values[F.linkTo]]) links.set(b, (links.get(b) ?? 0) + 1);
  return { notes, links };
}

/** Words in the chapter (or part) the caret is in, and in the whole manuscript. */
function summary() {
  const doc = sheet.editor.state.doc, here = state.selected;
  let chapter = null, found = false;
  doc.forEach(node => {
    if (found) return;
    if (node.type.name === 'heading' && node.attrs.level <= 2) chapter = node;
    if (node.attrs.blockId === here) found = true;
  });
  if (!found) chapter = null;
  let words = 0, chapterWords = 0, inside = false;
  doc.forEach(node => {
    const w = countWords(node.textContent);
    words += w;
    if (node === chapter) { inside = true; return; }
    if (inside && node.type.name === 'heading' && node.attrs.level <= chapter.attrs.level) inside = false;
    if (inside) chapterWords += w;
  });
  const total = `${words.toLocaleString()} words`;
  if (!chapter) return total;
  const name = chapter.textContent.trim() || 'Untitled';
  return `${name.length > 40 ? `${name.slice(0, 39)}…` : name}: ${chapterWords.toLocaleString()} of ${total}`;
}

let declared = null;
function declare() {
  if (!state.chrome) { renderOwnToolbar(); return; }
  const style = state.root !== null ? sheet.styleHere() : 'Paragraph';
  const a = state.appearance;
  const radio = (id, value, label, current) => ({ kind: 'radio', id, value, label, checked: current === value });
  const items = [
    { kind: 'select', id: 'style', label: 'Style', value: style, options: STYLES.map(s => ({ value: s, label: s })) },
    ...(state.roles ? [{ kind: 'select', id: 'role', label: 'Role', value: (state.root !== null && sheet.roleHere()) || 'none', options: [{ value: 'none', label: 'No role' }, ...ROLES.map(r => ({ value: r, label: r }))] }] : []),
    { kind: 'text', text: `${state.status} · ${summary()}` },
    { kind: 'spacer' },
    { kind: 'toggle', id: 'outline', label: 'Outline', icon: 'list', pressed: state.drawer === 'outline' },
    { kind: 'toggle', id: 'notes', label: `Notes ${state.notes.length || ''}`.trim(), icon: 'edit', pressed: state.drawer === 'notes' },
    { kind: 'toggle', id: 'related', label: 'Related', icon: 'link', pressed: state.drawer === 'related' },
    { kind: 'menu', id: 'export', label: 'Export', icon: 'export', items: [
      { id: 'export-markdown', label: 'Markdown', detail: 'A .zip with the text and its pictures' },
      { id: 'export-word', label: 'Word document, book layout', detail: 'A 6 by 9 inch book: title page, chapters on new pages' },
      { id: 'export-word-paper', label: 'Word document, paper layout', detail: 'An article: title block, abstract, numbered sections, figures' },
    ] },
    { kind: 'menu', id: 'appearance', label: 'Appearance', icon: 'settings', iconOnly: true, items: [
      { kind: 'label', label: 'Typeface' }, radio('font', 'serif', 'Serif', a.font), radio('font', 'sans', 'Sans serif', a.font),
      { kind: 'separator' }, { kind: 'label', label: 'Size' },
      radio('size', 'small', 'Small', a.size), radio('size', 'medium', 'Medium', a.size), radio('size', 'large', 'Large', a.size),
      { kind: 'separator' }, { kind: 'label', label: 'Line length' },
      radio('width', 'narrow', 'Narrow', a.width), radio('width', 'medium', 'Medium', a.width), radio('width', 'wide', 'Wide', a.width),
      { kind: 'separator' }, { kind: 'label', label: 'Pictures' },
      radio('pictures', 'small', 'Thumbnails', a.pictures), radio('pictures', 'full', 'Full width', a.pictures),
    ] },
  ];
  const text = JSON.stringify(items);
  if (text === declared) return;
  declared = text;
  nendo.ui.setToolbar({ items }).catch(error => { state.chrome = false; state.problem = { text: `Nendo did not take the view's controls: ${error.message}` }; render(); });
}

function command({ id, value }) {
  if (id === 'export-markdown') { exportAs('markdown').catch(fail); return; }
  if (id === 'export-word' || id === 'export-word-paper') { exportAs('word', id === 'export-word-paper' ? 'paper' : 'book').catch(fail); return; }
  if (id === 'style') { sheet.setStyle(value); return; }
  if (id === 'role') { sheet.setRole(value === 'none' ? null : value); return; }
  if (id === 'outline' || id === 'notes' || id === 'related') { state.drawer = state.drawer === id ? null : id; render(); declare(); return; }
  if (id === 'font' || id === 'size' || id === 'width' || id === 'pictures') { state.appearance = { ...state.appearance, [id]: value }; applyAppearance(); declare(); }
}

function renderOwnToolbar() {
  const bar = $('own-toolbar');
  bar.hidden = false;
  $('own-status').textContent = `${state.status} · ${state.root !== null ? summary() : ''}`;
  for (const b of bar.querySelectorAll('[data-drawer]')) b.setAttribute('aria-pressed', String(state.drawer === b.dataset.drawer));
}

function renderStatus() { if (!state.chrome) renderOwnToolbar(); }

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'on') for (const [event, handler] of Object.entries(v)) node.addEventListener(event, handler);
    else if (k === 'text') node.textContent = v;
    else if (v !== false && v !== null && v !== undefined) node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

function render() {
  const problem = $('problem');
  const message = state.problem?.text ?? (state.external ? 'This manuscript changed elsewhere while you were writing. Your next save is checked against it; Reload takes the saved version now.' : null);
  problem.hidden = !message;
  const actions = (state.problem?.actions ?? []).map(a => el('button', { type: 'button', text: a.label, on: { click: a.run } }));
  if (state.problem?.reload || state.external) actions.push(el('button', { type: 'button', text: 'Reload', on: { click: () => { state.problem = null; dropDraft(); load(); } } }));
  problem.replaceChildren(...(message ? [el('span', { text: message }), ...actions] : []));
  renderDrawer();
  placeOverlays();
  declare();
}

const icon = {
  link: '<path d="M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1"/>',
  note: '<path d="M3 3h10v7l-3 3H3z"/><path d="M10 13v-3h3"/>',
  cut: '<circle cx="4.5" cy="11.5" r="2"/><circle cx="11.5" cy="11.5" r="2"/><path d="M6 10 12 3M10 10 4 3"/>',
  agent: '<path d="M3 3.5h10v7H7l-3 2.5v-2.5H3z"/>',
};
function svg(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = icon[name];
  return s;
}

/** Gutter marks beside paragraphs that carry notes or links, and the bar over the selected one. */
function placeOverlays() {
  const layer = $('overlays');
  if (!layer || state.root === null) return;
  const origin = $('page').getBoundingClientRect();
  const { notes, links } = counts();
  const marks = [];
  sheet.editor.state.doc.forEach((node, offset) => {
    const id = node.attrs.blockId, n = (notes.get(id) ?? 0) + (links.get(id) ?? 0);
    if (!n) return;
    const dom = sheet.editor.view.nodeDOM(offset);
    if (!dom?.getBoundingClientRect) return;
    const top = dom.getBoundingClientRect().top - origin.top;
    marks.push(el('button', { type: 'button', class: `mark${id === state.selected ? ' on' : ''}`, style: `top:${top + 6}px`, 'data-id': id,
      'aria-label': `${notes.get(id) ?? 0} notes and ${links.get(id) ?? 0} links on this paragraph`,
      on: { mousedown: e => e.preventDefault(), click: () => { sheet.focusBlock(id); state.selected = id; state.pinned = true; render(); } } }, svg('link'), String(n)));
  });
  const where = sheet.where();
  const show = !state.readOnly && state.selected && sheet.locate(state.selected) && (state.pinned || state.popover || (where && !where.empty && where.single && where.id === state.selected));
  let bar = null, pop = null;
  if (show) {
    const at = sheet.locate(state.selected);
    const rect = at.dom.getBoundingClientRect();
    // Over the selected words when the selection is in this block, else over the block's start.
    const sel = sheet.editor.state.selection;
    let top = rect.top - origin.top, bottom = rect.top - origin.top + 34, centre = rect.left - origin.left + 120;
    if (!sel.empty && sel.from > at.pos && sel.to < at.pos + at.node.nodeSize) {
      const a = sheet.editor.view.coordsAtPos(sel.from), z = sheet.editor.view.coordsAtPos(sel.to);
      top = a.top - origin.top; bottom = z.bottom - origin.top;
      centre = (a.top === z.top ? (a.left + z.left) / 2 : a.left) - origin.left;
    }
    const b = block(state.selected);
    const isHeading = at.node.type.name === 'heading';
    const action = (label, name, handler, extra = {}) => el('button', { type: 'button', ...extra, on: { mousedown: e => e.preventDefault(), click: handler } }, svg(name), label);
    bar = el('div', { class: 'bar', role: 'toolbar', 'aria-label': 'This paragraph', style: `top:${Math.max(0, top - 48)}px`, 'data-centre': String(centre) },
      action('Link', 'link', () => openPopover('link')),
      action('Note', 'note', () => openPopover('note')),
      isHeading ? null : action('Keep as cutting', 'cut', () => keepAsCutting().catch(fail)),
      el('span', { class: 'divider' }),
      action('Copy for the agent', 'agent', () => copyReference(), { class: 'accent' }),
      el('span', { class: 'mono' }, `${state.selected} · ${b ? `v${b.version}` : 'not saved yet'}`));
    // The box is built once and only moved after: a redraw while the person types into it (a
    // save finishing, somebody else's change) must not take their words or their focus.
    if (state.popover) { pop = state.popoverEl ??= popover(bottom + 8); pop.style.top = `${bottom + 8}px`; }
  }
  layer.replaceChildren(...marks, ...(bar ? [bar] : []));
  const popLayer = $('popover-layer');
  if (pop ? popLayer.firstChild !== pop : popLayer.firstChild) popLayer.replaceChildren(...(pop ? [pop] : []));
  // Centred on its anchor, kept inside the page.
  const width = $('page').clientWidth;
  for (const box of [bar, pop]) {
    if (!box) continue;
    const centre = Number(bar.dataset.centre), w = box.offsetWidth;
    box.style.left = `${Math.max(8, Math.min(width - w - 8, centre - w / 2))}px`;
    box.style.right = 'auto';
  }
}

function fail(error) { state.problem = { text: refusalText(error), reload: true }; render(); }

function openPopover(kind, data = {}) { state.popover = { kind, ...data, query: '', linkKind: LINK_KINDS[0], noteKind: NOTE_KINDS[0] }; state.popoverEl = null; state.pinned = true; placeOverlays(); setTimeout(() => document.querySelector('.popover input, .popover textarea, .popover select')?.focus(), 0); }
function closePopover() { state.popover = null; state.popoverEl = null; state.pinned = false; }

function popover(top) {
  const p = state.popover;
  const close = el('button', { type: 'button', class: 'quiet', text: 'Cancel', on: { click: () => { closePopover(); placeOverlays(); sheet.editor.commands.focus(); } } });
  if (p.kind === 'note') {
    const kind = el('select', { id: 'note-kind', 'aria-label': 'Kind of note' }, NOTE_KINDS.map(k => el('option', { value: k, text: k })));
    const text = el('textarea', { id: 'note-text', rows: '3', 'aria-label': 'Note', placeholder: 'What should you remember about this paragraph?' });
    return el('form', { class: 'popover', style: `top:${top}px`, on: { submit: e => { e.preventDefault(); if (text.value.trim()) addNote(kind.value, text.value.trim()).catch(fail); } } },
      el('div', { class: 'row' }, el('strong', { text: 'Note on this paragraph' }), kind), text,
      el('div', { class: 'row end' }, close, el('button', { type: 'submit', class: 'primary', text: 'Add note' })));
  }
  if (p.kind === 'reference') {
    return el('div', { class: 'popover', style: `top:${top}px` }, el('strong', { text: 'Copy this, then paste it into the Agent tab' }),
      el('input', { value: p.text, readonly: true, 'aria-label': 'Reference to this paragraph', on: { focus: e => e.target.select() } }), el('div', { class: 'row end' }, close));
  }
  const kind = el('select', { id: 'link-kind', 'aria-label': 'Kind of link' }, LINK_KINDS.map(k => el('option', { value: k, text: k })));
  const results = el('div', { class: 'results', role: 'list' });
  const search = el('input', { id: 'link-search', type: 'search', placeholder: 'Find the passage to link to', 'aria-label': 'Find a passage', autocomplete: 'off' });
  const fill = () => {
    const q = search.value.trim().toLowerCase();
    const hits = [];
    sheet.editor.state.doc.forEach(node => {
      const id = node.attrs.blockId;
      if (id === state.selected || hits.length >= 8 || !block(id)) return;
      if (q && !node.textContent.toLowerCase().includes(q)) return;
      if (!q && node.type.name !== 'heading') return;
      hits.push(el('button', { type: 'button', role: 'listitem', class: node.type.name === 'heading' ? 'hit heading' : 'hit', on: { click: () => addLink(kind.value, id).catch(fail) } }, preview(id, 90)));
    });
    results.replaceChildren(...(hits.length ? hits : [el('p', { class: 'muted', text: q ? 'No saved passage holds that.' : 'Type a few words from the passage.' })]));
  };
  search.addEventListener('input', fill);
  fill();
  return el('div', { class: 'popover', style: `top:${top}px` }, el('div', { class: 'row' }, el('strong', { text: 'Link this paragraph' }), kind), search, results, el('div', { class: 'row end' }, close));
}

function renderDrawer() {
  const drawer = $('drawer');
  drawer.hidden = state.drawer === null;
  document.documentElement.dataset.drawer = state.drawer ?? '';
  if (state.drawer === null) return;
  const title = { outline: 'Outline', notes: 'Notes', related: 'Related passages' }[state.drawer];
  const body = [];
  if (state.drawer === 'outline') {
    sheet.editor.state.doc.forEach(node => {
      if (node.type.name !== 'heading') return;
      const id = node.attrs.blockId;
      body.push(el('button', { type: 'button', class: `outline level-${node.attrs.level}`, on: { click: () => sheet.focusBlock(id) } }, node.textContent || 'Untitled'));
    });
    if (!body.length) body.push(el('p', { class: 'muted', text: 'No headings yet. Make a line a Part, Chapter or Section with Style, or start it with #, ## or ###.' }));
  }
  if (state.drawer === 'notes') {
    const here = state.selected && block(state.selected) ? state.selected : null;
    const list = state.notes.filter(n => !here || n.values[F.noteBlock] === here);
    body.push(el('p', { class: 'muted', text: here ? `On “${preview(here, 50)}”` : 'Every note in the manuscript' }));
    for (const n of list) {
      const done = n.values[F.noteDone] === true;
      body.push(el('div', { class: 'card' },
        el('div', { class: 'row' }, el('span', { class: `chip ${String(n.values[F.noteKind]).toLowerCase()}`, text: n.values[F.noteKind] ?? 'Note' }),
          el('button', { type: 'button', class: 'quiet', text: 'Go to', on: { click: () => sheet.focusBlock(n.values[F.noteBlock]) } })),
        el('p', { class: done ? 'done' : '', text: n.values[F.noteText] ?? '' }),
        el('div', { class: 'row' },
          el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: done, on: { change: e => setNoteDone(n, e.target.checked).catch(fail) } }), 'Done'),
          el('button', { type: 'button', class: 'quiet', text: 'Delete', on: { click: () => deleteRecord(n, 'Delete a note').catch(fail) } }))));
    }
    if (!list.length) body.push(el('p', { class: 'muted', text: here ? 'No notes on this paragraph. Select some text and choose Note.' : 'No notes yet.' }));
  }
  if (state.drawer === 'related') {
    const here = state.selected && block(state.selected) ? state.selected : null;
    if (!here) body.push(el('p', { class: 'muted', text: 'Put the caret in a paragraph to see what it is linked to.' }));
    else {
      const mine = state.links.filter(l => l.values[F.linkFrom] === here || l.values[F.linkTo] === here);
      body.push(el('p', { class: 'muted', text: `Linked to “${preview(here, 50)}”` }));
      for (const l of mine) {
        const out = l.values[F.linkFrom] === here, other = out ? l.values[F.linkTo] : l.values[F.linkFrom];
        const review = l.values[F.linkReview] === REVIEW.needsReview;
        body.push(el('div', { class: 'card' },
          el('div', { class: 'row' }, el('span', { class: 'kind', text: `${out ? '' : '← '}${l.values[F.linkKind] ?? 'Linked'}${out ? ' →' : ''}` }),
            review ? el('span', { class: 'chip issue', text: 'Needs review' }) : null),
          el('button', { type: 'button', class: 'passage', on: { click: () => sheet.focusBlock(other) } }, preview(other, 120)),
          el('div', { class: 'row end' }, el('button', { type: 'button', class: 'quiet', text: 'Remove link', on: { click: () => deleteRecord(l, 'Remove a link').catch(fail) } }))));
      }
      if (!mine.length) body.push(el('p', { class: 'muted', text: 'Nothing linked yet. Select some text in it and choose Link.' }));
    }
  }
  drawer.replaceChildren(el('div', { class: 'drawer-head' }, el('strong', { text: title }),
    el('button', { type: 'button', class: 'quiet', 'aria-label': `Close ${title}`, text: 'Close', on: { click: () => { state.drawer = null; render(); } } })),
  el('div', { class: 'drawer-body' }, body));
}

// ---------- Start ----------

async function start(context) {
  state.readOnly = context.readOnly === true;
  state.chrome = nendo.has('ui.setToolbar');
  // A file built before roles has no Role field; the control waits for one.
  try {
    const schema = await nendo.schema.describe();
    state.roles = (schema.entities ?? []).some(e => e.entityId === BLOCK && (e.fields ?? []).some(f => f.fieldId === F.role));
  } catch { state.roles = false; }
  applyAppearance();
  try {
    const kit = await import('./kit/nendo-view-kit.js');
    kit.installFocusRing(document);
  } catch { /* the view works without the kit's ring */ }
  nendo.on('changes', changed);
  nendo.on('command', command);
  nendo.on('context', next => { state.readOnly = next.readOnly === true; sheet.editor.setEditable(!state.readOnly && state.root !== null); render(); });
  $('title').addEventListener('input', e => { state.title = e.target.value; edited(); });
  $('start').addEventListener('click', () => startManuscript().catch(fail));
  for (const b of document.querySelectorAll('#own-toolbar [data-drawer]')) b.addEventListener('click', () => command({ id: b.dataset.drawer }));
  for (const b of document.querySelectorAll('#own-toolbar [data-command]')) b.addEventListener('click', () => command({ id: b.dataset.command }));
  addEventListener('resize', () => placeOverlays());
  $('scroller').addEventListener('scroll', () => { if (state.popover) return; placeOverlays(); }, { passive: true });
  addEventListener('keydown', e => { if (e.key === 'Escape' && (state.popover || state.pinned)) { closePopover(); placeOverlays(); sheet.editor.commands.focus(); } });
  addEventListener('pagehide', () => { if (pending()) save(); });
  await load();
  if (state.root !== null) offerDraft();
  if (state.root !== null && !state.problem) {
    const first = sheet.read().find(n => n.kind === 'Paragraph');
    if (first) sheet.focusBlock(first.id);
  }
}

async function startManuscript() {
  const root = `b-root-${freshId().slice(2, 8)}`, chapter = freshId(), paragraph = freshId(), cuttings = `b-cuttings-${freshId().slice(2, 8)}`;
  await nendo.records.batch([
    { op: 'create', entityId: BLOCK, recordId: root, values: { [F.kind]: 'Manuscript', [F.text]: 'Untitled manuscript', [F.order]: GAP } },
    { op: 'create', entityId: BLOCK, recordId: chapter, values: { [F.kind]: 'Chapter', [F.text]: 'Chapter one', [F.parent]: root, [F.order]: GAP } },
    { op: 'create', entityId: BLOCK, recordId: paragraph, values: { [F.kind]: 'Paragraph', [F.text]: null, [F.parent]: chapter, [F.order]: GAP } },
    { op: 'create', entityId: BLOCK, recordId: cuttings, values: { [F.kind]: 'Cuttings', [F.text]: 'Cuttings', [F.parent]: root, [F.order]: 1073741824 } },
  ], { label: 'Start a manuscript' });
  await load();
}

nendo.ready.then(start).catch(error => {
  $('problem').hidden = false;
  $('problem').textContent = error?.code === 'not-framed' ? 'Open this view in Nendo.' : `The manuscript could not be read: ${error?.message ?? error}`;
});
