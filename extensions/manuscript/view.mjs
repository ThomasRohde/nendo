// The Quiet sheet: the whole manuscript as one continuous page, saved paragraph by paragraph.
import { BLOCK, NOTE, LINK, PROFILE, OUTPUT_LAYOUTS, PAGE_SIZES, SPACINGS, FONTS, F, GAP, NOTE_KINDS, LINK_KINDS, REVIEW, ROLES, readManuscript, planWrites, planFootnotes, withFootnotes, withLinkReviews, wordDiff, withoutAsRead, valuesOf, sortDraft, forceDraft, chunkWrites, withTargetVersions, countWords, levelOf, ASK_MODES, askMessage } from './model.mjs';
import { createSheet, freshId } from './editor.mjs';
import { exportPlan, safeName, pictureFiles, toMarkdown, toDocx, packDocx, draftLine, PAGE_TWIPS, article, paperTableColumns, BIBLIOGRAPHY } from './export.mjs';
import { previewBlocks, figureWidths, PAGES, paperSheet, paperStyle, softHyphens } from './preview.mjs';
import { markdownToInline } from './inline.mjs';
import { setLines, timesWidth, termesWidth, lineDepth, drawnSpaces, TEX } from './typeset.mjs';
import { Lexer } from './vendor/editor.js';
import { hyphenate } from './hyphenation.mjs';

const nendo = window.nendo;
const $ = id => document.getElementById(id);
const STYLES = ['Paragraph', 'Section', 'Chapter', 'Part'];
const PAUSE = 1200, LONGEST = 10000;

const state = {
  root: null, cuttings: null, title: '', savedTitle: '', saved: new Map(), notes: [], links: [],
  gone: new Set(), drawer: null, selected: null, pinned: false, saving: null, again: false, timer: null, firstEdit: 0,
  status: 'Reading the file…', savedAt: null, problem: null, external: false, readOnly: false, chrome: false,
  appearance: readAppearance(), popover: null, roles: false, aligns: false, lists: false, tables: false, mode: 'write', pins: [], more: false,
  hover: null, blockMenu: null, deletedIn: new Map(), newCuttings: null, footnotes: new Map(), footnoteTexts: new Map(), footnotesOn: false,
  linkSeen: false, linksView: 'review', notesOf: null, threadContext: new Set(), profilesOn: false, profiles: [], setupLayout: null,
  // Questions to the person's agent still waiting for an answer (ADR-0033).
  assistant: false, asks: new Set(),
};
window.manuscript = state;   // for the browser lane

// ---------- Appearance: the settings the package declares (ADR-0038) ----------

// Nendo keeps these and draws them on its Settings page: typeface, line length and pictures on
// this computer, text size in the file too, so a manuscript can give its readers a size. The
// Appearance menu changes this computer's value; Settings, another window or the file move them too.
// The package's defaults; a function, because the state that holds them is built before this line runs.
function readAppearance() { return { font: 'serif', size: 'medium', width: 'medium', pictures: 'small' }; }
function takeAppearance(values) {
  const next = readAppearance();
  for (const id of Object.keys(next)) if (typeof values?.[id] === 'string') next[id] = values[id];
  state.appearance = next;
}
function applyAppearance() {
  const a = state.appearance;
  document.documentElement.dataset.font = a.font;
  document.documentElement.dataset.size = a.size;
  document.documentElement.dataset.width = a.width;
  document.documentElement.dataset.pictures = a.pictures;
  placeOverlays();
}
async function keepAppearance(id, value) {
  if (!nendo.has('settings.set')) return;
  try { await nendo.settings.set(id, value); }
  catch (error) { state.problem = `${error?.message ?? error}`; render(); }
}

// ---------- The sheet ----------

const sheet = createSheet({
  element: $('sheet-text'),
  editable: false,
  placeholder: 'Write…',
  onChange: () => edited(),
  onSelect: where => selected(where),
  resolvePicture,
  canAlign: () => state.aligns && !state.readOnly,
  canList: () => state.lists && !state.readOnly,
  canReuse: id => mayComeBack(id),
  onFind: withReplace => openFind(withReplace),
  onFootnote: () => { if (!state.footnotesOn || state.readOnly) return false; runTool(TOOLS.find(t => t.id === 'footnote')); return true; },
  onFootnoteCopied: (from, to) => state.footnoteTexts.set(to, footnoteText(from)),
});

/** A footnote's words: as edited and not yet saved, or as the file holds them. */
function footnoteText(id) { return state.footnoteTexts.has(id) ? state.footnoteTexts.get(id) : state.footnotes.get(id)?.text ?? state.saved.get(id)?.text ?? ''; }

/**
 * Whether a block arriving on the page with this ID (pasted, or brought back by undo) may keep it:
 * one never saved, one of this manuscript's that is off the page (deleted or cut since it was
 * read), or one of its cuttings. A block of another manuscript, pasted here, is a copy.
 */
function mayComeBack(id) {
  const s = state.saved.get(id);
  if (!s) return true;
  // A footnote may come back with the paragraph that cites it.
  if (s.kind === 'Footnote') return s.parent ? mayComeBack(s.parent) : false;
  if (s.visible) return true;
  for (let p = s.parent, d = 0; p && d < 64; p = state.saved.get(p)?.parent, d++) if (p === state.cuttings) return true;
  return false;
}

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
// Nendo stops a view that is off screen without asking, so what was changed in the pause before
// a save is kept in the view's own storage (one origin per file and package) until it is saved.
// A draft is the writes the next save would make, each at the version it was based on, never a
// copy of the whole manuscript: brought back, it can only touch what the person changed.
let draftTimer = null;
const draftKey = (kind = 'draft') => `manuscript.${kind}.v2.${nendo.context?.viewId ?? 'sheet'}.${state.root ?? 'none'}`;
function keepDraft(now = false) {
  clearTimeout(draftTimer);
  const keep = () => {
    if (state.root === null) return;
    const { plan } = planNow();
    try {
      if (plan.length) localStorage.setItem(draftKey(), JSON.stringify({ root: state.root, writes: plan }));
      else localStorage.removeItem(draftKey());
      state.unkept = false;
    } catch {
      // Storage refused (full, or a private window): the next save is all there is, and the person is told.
      state.unkept = plan.length > 0;
      if (state.unkept && !state.saving) setStatus('Editing, not kept on this device until it saves');
    }
  };
  if (now) keep(); else draftTimer = setTimeout(keep, 300);
}
function dropDraft() { clearTimeout(draftTimer); state.unkept = false; try { localStorage.removeItem(draftKey()); } catch { /* nothing kept */ } }
function readKept(kind) { try { return JSON.parse(localStorage.getItem(draftKey(kind)) ?? 'null'); } catch { return null; } }

/** The record as the file now has it, in the terms a write uses, or null. */
function currentRecord(entityId, recordId) {
  if (entityId === BLOCK) { const b = state.saved.get(recordId); return b ? { version: b.version, values: valuesOf(b) } : null; }
  return (entityId === NOTE ? state.notes : state.links).find(r => r.recordId === recordId) ?? null;
}

/**
 * Puts back what was changed and not saved before the view last stopped. A change whose record
 * is as it was then is saved at once; one whose record changed or went since is held, the person
 * told which passages, and theirs goes in only if they say so. Nothing else is written.
 */
async function offerDraft() {
  try { for (const key of Object.keys(localStorage)) if (key.startsWith('manuscript.draft.v1.')) localStorage.removeItem(key); } catch { /* nothing kept */ }
  const draft = readKept('draft'), held = readKept('held');
  if (!draft && !held) return;
  if (draft && (draft.root !== state.root || !Array.isArray(draft.writes))) { dropDraft(); return; }
  sheet.editor.setEditable(false);
  try {
    const { fresh, stale } = sortDraft(draft?.writes ?? [], currentRecord);
    if (fresh.length) {
      for (const batch of chunkWrites(fresh)) await send(batch, 'Changes kept from before');
      state.savedAt = new Date();
      toast(`Saved ${fresh.length} change${fresh.length === 1 ? '' : 's'} kept from before Nendo last closed.`);
    }
    const holding = [...(held?.writes ?? []), ...stale];
    if (stale.length) localStorage.setItem(draftKey('held'), JSON.stringify({ root: state.root, writes: holding }));
    dropDraft();
    if (fresh.length) await load();
    if (holding.length) offerHeld(holding);
  } catch (error) {
    state.problem = { text: `Changes kept from before could not be saved: ${refusalText(error)}`, sticky: true,
      actions: [{ label: 'Discard them', run: () => { dropDraft(); dropHeld(); state.problem = null; render(); } }] };
  } finally {
    sheet.editor.setEditable(!state.readOnly && state.root !== null);
    render();
  }
}

function dropHeld() { try { localStorage.removeItem(draftKey('held')); } catch { /* nothing kept */ } }

function offerHeld(writes) {
  const passages = [...new Set(writes.map(w => w.entityId === BLOCK ? w.values?.[F.text] ?? state.saved.get(w.recordId)?.text : null).filter(Boolean))];
  const named = passages.slice(0, 3).map(t => `“${t.length > 40 ? `${t.slice(0, 39)}…` : t}”`).join(', ');
  state.problem = {
    sticky: true,
    text: `${writes.length} change${writes.length === 1 ? '' : 's'} you made before Nendo last closed ${writes.length === 1 ? 'was' : 'were'} not saved, and the passage${writes.length === 1 ? ' was' : 's were'} changed elsewhere since${named ? `: ${named}${passages.length > 3 ? ' and more' : ''}` : ''}. Put yours back over them, or discard yours.`,
    actions: [
      { label: 'Put mine back', run: () => putHeldBack(writes).catch(fail) },
      { label: 'Discard mine', run: () => { dropHeld(); state.problem = null; render(); } },
    ],
  };
  render();
}

async function putHeldBack(writes) {
  await flush();
  sheet.editor.setEditable(false);
  try {
    const forced = forceDraft(writes, currentRecord);
    for (const batch of chunkWrites(forced)) await send(batch, 'Put back changes kept from before');
    dropHeld();
    state.problem = null;
    await load();
  } finally { sheet.editor.setEditable(!state.readOnly && state.root !== null); render(); }
}

function edited() {
  if (!state.problem?.sticky) state.problem = null;
  keepDraft();
  state.status = 'Editing';
  clearTimeout(state.timer);
  if (!state.firstEdit) state.firstEdit = Date.now();
  const wait = Date.now() - state.firstEdit > LONGEST ? 0 : PAUSE;
  state.timer = setTimeout(() => save(), wait);
  soon();
}

function selected(where) {
  if (!where) return;
  const footnote = sheet.footnoteHere();
  if (footnote && state.popover?.id !== footnote) { state.selected = where.id; openPopover('footnote', { id: footnote }); return; }
  if (state.pinned && !state.popover && where.id !== state.selected) { state.pinned = false; state.more = false; }
  state.selected = where.id;
  if (!state.pinned && where.empty) closePopover();
  soon();
}

// A keystroke changes the text and the selection at once: the margin, the toolbar and the side
// panel are drawn again once for the frame, not once for each.
let drawing = 0;
function soon() { if (!drawing) drawing = requestAnimationFrame(() => { drawing = 0; render(); }); }

// ---------- Reading ----------

// Blocks are read flat, a cursor page at a time, and the tree is built here. READ_MAX is only a
// guard against reading without end.
const READ_MAX = 1000000;
async function readBlocks() { return nendo.records.queryAll({ entityId: BLOCK }, { max: READ_MAX }); }

async function readAll() {
  const [blocks, notes, links, profiles] = await Promise.all([
    readBlocks(),
    nendo.records.queryAll({ entityId: NOTE }, { max: READ_MAX }),
    nendo.records.queryAll({ entityId: LINK }, { max: READ_MAX }),
    state.profilesOn ? nendo.records.queryAll({ entityId: PROFILE }, { max: 1000 }) : [],
  ]);
  return { manuscript: readManuscript(blocks, state.wanted ?? state.root), notes, links, profiles };
}

async function load() {
  const { manuscript, notes, links, profiles } = await readAll();
  state.profiles = profiles;
  state.loads = (state.loads ?? 0) + 1;
  const switched = manuscript.root !== state.root;
  state.root = manuscript.root; state.cuttings = manuscript.cuttings; state.manuscripts = manuscript.manuscripts; state.wanted = null;
  state.saved = manuscript.saved; state.notes = notes; state.links = links;
  state.footnotes = manuscript.footnotes; state.footnoteTexts.clear();
  state.title = state.savedTitle = manuscript.title;
  $('title').value = manuscript.title;
  $('empty').hidden = state.root !== null;
  $('page').hidden = state.root === null || state.mode !== 'write';
  if (state.root !== null) {
    const keep = switched ? null : sheet.where();
    sheet.load(manuscript.nodes);
    // What the page would write only because of how it read the file: a block out of place is
    // shown where it would go, and left as it is stored until the person changes it.
    state.asRead = planWrites({ saved: state.saved, current: sheet.read(), root: state.root });
    const misplaced = state.asRead.filter(w => w.op === 'update' && (F.kind in w.values || F.parent in w.values)).length;
    if (misplaced && misplaced !== state.misplaced) toast(`${misplaced} block${misplaced === 1 ? ' is' : 's are'} not where a manuscript keeps ${misplaced === 1 ? 'it' : 'them'}: shown where ${misplaced === 1 ? 'it' : 'they'} would go, and left as stored.`);
    state.misplaced = misplaced;
    if (keep?.id && sheet.locate(keep.id)) sheet.editor.commands.setTextSelection(sheet.locate(keep.id).pos + 1);
    // A switch the person made is a step in Back and Forward; one Back or Forward made is not.
    if (switched) placeHere(state.placeStep !== false);
    state.placeStep = null;
  }
  sheet.editor.setEditable(!state.readOnly && state.root !== null);
  state.external = false;
  setStatus(state.savedAt ? `Saved ${clock(state.savedAt)}` : 'Up to date');
  render();
}

// ---------- Saving ----------

/**
 * The writes that would make the file what the page shows: text, kinds, settings, order,
 * parents, new and deleted blocks, their notes and links, and the title. The one answer to
 * whether anything is unsaved, for saving, the draft, and whether a change made elsewhere may
 * reload the page.
 */
function planNow() {
  const current = sheet.read();
  const { merged, cut } = sheet.lineage();
  if (cut.size && state.cuttings === null) state.newCuttings ??= `b-cuttings-${freshId().slice(2, 8)}`;
  const blocks = withoutAsRead(planWrites({ saved: state.saved, current, root: state.root, notes: state.notes, links: state.links,
    merged, cut, cuttings: state.cuttings, newCuttings: state.newCuttings }), state.asRead);
  const withNotes = state.footnotesOn ? withFootnotes(blocks, planFootnotes({ saved: state.saved, refs: sheet.footnoteRefs(), texts: state.footnoteTexts,
    footnotes: state.footnotes, notes: state.notes, links: state.links })) : blocks;
  // A link whose end's words change is marked for review, keeping the words it was reviewed with.
  const plan = withLinkReviews(withNotes, { saved: state.saved, links: state.links, seen: state.linkSeen });
  const root = state.saved.get(state.root);
  if (state.title !== state.savedTitle && root) plan.unshift({ op: 'update', entityId: BLOCK, recordId: state.root, version: root.version, values: { [F.text]: state.title || null }, refs: {} });
  return { plan, current };
}

function pending() { return state.root !== null && planNow().plan.length > 0; }

/**
 * Blocks a save deleted and the person brought back with Ctrl+Z: the revision that deleted them is
 * undone (records.undo), so each comes back under its own ID with its notes and links, and the
 * next plan writes whatever else that revision had changed that the page still shows. Refused
 * (another writer changed one of its records since, or the view has started again since) the
 * block is new instead.
 */
async function bringBack() {
  const cited = new Set(state.footnotesOn ? sheet.footnoteRefs().map(r => r.id) : []);
  const back = [...state.gone].filter(id => sheet.locate(id) || cited.has(id));
  const revisions = [...new Set(back.map(id => state.deletedIn.get(id)).filter(Boolean))].reverse();
  for (const revision of revisions) {
    try {
      const result = await nendo.records.undo(revision, { label: 'Undo a deletion' });
      for (const r of result.records) {
        if (r.version === null) { applyWrite({ op: 'delete', entityId: r.entityId, recordId: r.recordId }, null); continue; }
        const record = await nendo.records.get(r.entityId, r.recordId);
        if (record) restoreRecord(record);
      }
    } catch { /* refused: the blocks it would have brought back are new below */ }
  }
  for (const id of state.gone) {
    if (sheet.locate(id)) sheet.renumber(id);
    else if (cited.has(id)) { const text = footnoteText(id); const next = sheet.renumberFootnote(id); if (next) state.footnoteTexts.set(next, text); }
  }
}

/** A record read back after an undo, as the page keeps it. */
function restoreRecord(record) {
  state.gone.delete(record.recordId);
  if (record.entityId !== BLOCK) {
    const list = record.entityId === NOTE ? state.notes : state.links;
    const at = list.findIndex(r => r.recordId === record.recordId);
    if (at >= 0) list[at] = record; else list.push(record);
    return;
  }
  const v = record.values;
  const next = { id: record.recordId, kind: v[F.kind] ?? 'Paragraph', text: v[F.text] ?? '', parent: v[F.parent] ?? null, order: v[F.order] ?? null,
    role: v[F.role] ?? null, align: v[F.align] ?? null, list: v[F.list] ?? null, level: v[F.level] ?? null, version: record.version };
  next.visible = next.id !== state.root && next.kind !== 'Cuttings' && next.kind !== 'Footnote' && next.parent !== state.cuttings;
  state.saved.set(record.recordId, next);
  if (next.kind === 'Footnote') state.footnotes.set(next.id, { id: next.id, parent: next.parent, text: next.text, version: next.version });
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
      await bringBack();
      const { plan, current } = planNow();
      state.firstEdit = 0;
      state.saveError = null;
      if (!plan.length) { setStatus(state.savedAt ? `Saved ${clock(state.savedAt)}` : 'Up to date'); return; }
      // The title as it was planned: one typed while this save runs is the next save's.
      const title = state.title;
      setStatus('Saving…');
      for (const batch of chunkWrites(plan)) await send(batch);
      sheet.saved(current);
      // Lineage the save has settled: a merged or cut block is now deleted or in the Cuttings.
      sheet.settle([...sheet.lineage().merged.keys(), ...sheet.lineage().cut].filter(id => !state.saved.get(id)?.visible));
      state.savedTitle = title;
      state.savedAt = new Date();
      setStatus(`Saved ${clock(state.savedAt)}`);
      // What was typed while it saved is kept against the versions this save made.
      keepDraft(true);
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
  return state.saved.get(id)?.version ?? state.notes.find(n => n.recordId === id)?.version ?? state.links.find(l => l.recordId === id)?.version ?? state.profiles.find(p => p.recordId === id)?.version;
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
  // Which revision deleted which block, so Ctrl+Z after the save can undo it (bringBack).
  for (const w of writes) if (w.entityId === BLOCK && w.op === 'delete' && result.revision) state.deletedIn.set(w.recordId, result.revision);
  return result;
}

function applyWrite(write, version) {
  if (write.entityId === BLOCK) {
    if (write.op === 'delete') { state.saved.delete(write.recordId); state.footnotes.delete(write.recordId); state.gone.add(write.recordId); sheet.forget(write.recordId); return; }
    const was = state.saved.get(write.recordId) ?? { id: write.recordId, visible: true };
    const v = write.values;
    const next = { ...was, version };
    if (F.text in v) next.text = v[F.text] ?? '';
    if (F.kind in v) next.kind = v[F.kind];
    if (F.parent in v) next.parent = v[F.parent];
    if (F.order in v) next.order = v[F.order];
    if (F.role in v) next.role = v[F.role];
    if (F.align in v) next.align = v[F.align];
    if (F.list in v) next.list = v[F.list];
    if (F.level in v) next.level = v[F.level];
    if (next.kind === 'Cuttings' && next.parent === state.root && state.cuttings === null) { state.cuttings = write.recordId; state.newCuttings = null; }
    next.visible = write.recordId !== state.root && next.kind !== 'Cuttings' && next.kind !== 'Footnote' && next.parent !== state.cuttings;
    state.saved.set(write.recordId, next);
    if (next.kind === 'Footnote') state.footnotes.set(write.recordId, { id: write.recordId, parent: next.parent, text: next.text, version });
    return;
  }
  const list = write.entityId === NOTE ? state.notes : write.entityId === PROFILE ? state.profiles : state.links;
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
      const { manuscript, notes, links, profiles } = await readAll();
      state.profiles = profiles;
      const differs = [...manuscript.saved.values()].some(r => state.saved.get(r.id)?.version !== r.version) ||
        [...state.saved.keys()].some(id => !manuscript.saved.has(id));
      state.notes = notes; state.links = links;
      if (!differs) { render(); return; }
      if (!pending()) { await load(); if (state.mode !== 'write') renderPreview(); return; }
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
  closePopover(); state.drawer = 'notes'; state.notesOf = id; render(); declare();
}

async function addLink(kind, target) {
  await flush();
  const id = state.selected;
  if (!block(id) || !block(target)) return;
  const seen = state.linkSeen ? { [F.linkFromSeen]: block(id).text ?? '', [F.linkToSeen]: block(target).text ?? '' } : {};
  await send([{ op: 'create', entityId: LINK, recordId: `l-${freshId().slice(2)}`, values: { [F.linkFrom]: id, [F.linkTo]: target, [F.linkKind]: kind, [F.linkReview]: REVIEW.current, ...seen }, refs: { [F.linkFrom]: id, [F.linkTo]: target } }], 'Link passages');
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

/**
 * The passage a question is about: the paragraph, or for a heading its section, the heading and
 * every block after it up to the next heading at its level or above, in reading order.
 */
function passageOf(id) {
  const blocks = [];
  let heading = null, level = 0, inside = false;
  sheet.editor.state.doc.forEach(node => {
    const at = node.attrs.blockId;
    if (!inside) {
      if (at !== id) return;
      inside = true;
      if (node.type.name === 'heading') { heading = node.textContent.trim() || 'Untitled'; level = node.attrs.level; }
      blocks.push({ id: at, text: block(at)?.text ?? node.textContent });
      return;
    }
    if (heading === null || (node.type.name === 'heading' && node.attrs.level <= level)) { inside = false; id = null; return; }
    if (block(at)) blocks.push({ id: at, text: block(at).text ?? node.textContent });
  });
  return { heading, blocks };
}

/**
 * Ask the person's launched agent about the passage (ADR-0033). What is on the page is saved
 * first, so the agent reads it as it stands. Nendo asks the person in its own cards; the answer
 * is shown in the popover if it is still open, otherwise said in Nendo's notice. What the agent
 * writes reaches the page as any other writer's change does.
 */
async function askAgent(request, mode) {
  await flush();
  const id = state.selected;
  if (!block(id)) return;
  const passage = passageOf(id);
  const message = askMessage({ request, mode, title: state.title ?? $('title').value, heading: passage.heading, blocks: passage.blocks });
  const ask = { id, mode, heading: passage.heading, state: 'asking', reply: '', stopReason: null, error: null };
  state.popover = { ...state.popover, ask };
  state.asks.add(ask);
  redrawPopover();
  try {
    const answer = await nendo.assistant.ask(message.text, { context: message.context });
    Object.assign(ask, { state: 'answered', reply: answer.reply ?? '', stopReason: answer.stopReason ?? 'end_turn' });
  } catch (error) {
    Object.assign(ask, { state: 'refused', error: assistantRefusal(error) });
  } finally {
    state.asks.delete(ask);
  }
  if (state.popover?.ask === ask) { redrawPopover(); return; }
  const what = ask.heading === null ? 'this paragraph' : `“${ask.heading}”`;
  toast(ask.state === 'refused' ? ask.error : `The agent answered about ${what}: ${ask.reply.replace(/\s+/g, ' ').slice(0, 220) || 'no words.'}`);
}

/** Why a question did not reach the agent, in the person's words. */
function assistantRefusal(error) {
  switch (error?.code) {
    case 'assistant-off': return 'Views may not message the agent on this computer. Change it on Nendo’s Agent page, under Launch.';
    case 'assistant-declined': return 'Not sent: you said Not now. Ask again once the conversation has changed.';
    case 'assistant-busy': return 'The agent has too many messages waiting. Ask again when it has answered some.';
    case 'assistant-unavailable': return `No agent can answer now: ${error.message}`;
    default: return `Not sent: ${error?.message ?? String(error)}`;
  }
}

function redrawPopover() { state.popoverEl?.remove(); state.popoverEl = null; placeOverlays(); }

/** A link reviewed: current again, keeping its ends' words as they are now. */
async function reviewed(link) {
  await flush();
  const now = state.links.find(l => l.recordId === link.recordId) ?? link;
  const seen = state.linkSeen ? { [F.linkFromSeen]: block(now.values[F.linkFrom])?.text ?? '', [F.linkToSeen]: block(now.values[F.linkTo])?.text ?? '' } : {};
  await send([{ op: 'update', entityId: LINK, recordId: now.recordId, version: now.version, values: { [F.linkReview]: REVIEW.current, ...seen }, refs: {} }], 'Review a link');
  render(); declare();
}

/** How an end of a link changed since it was reviewed: its words then and now, word by word, or null when unchanged. */
function endChange(link, end) {
  const field = end === 'from' ? F.linkFromSeen : F.linkToSeen, id = link.values[end === 'from' ? F.linkFrom : F.linkTo];
  const then = link.values[field], now = block(id)?.text ?? '';
  if (then === undefined || then === null) return state.linkSeen ? el('p', { class: 'muted', text: 'Its words before were not kept.' }) : null;
  if (then === now) return null;
  return el('p', { class: 'diff', 'aria-label': `${preview(id, 40)}, changed` }, wordDiff(then, now).map(part =>
    part.kind === 'same' ? document.createTextNode(part.text) : el(part.kind === 'gone' ? 'del' : 'ins', { text: part.text })));
}

/** A link that needs review, as a card: its kind, its ends, what changed at each, and Reviewed. */
function reviewCard(link) {
  const from = link.values[F.linkFrom], to = link.values[F.linkTo];
  return el('div', { class: 'card', 'data-id': link.recordId },
    el('div', { class: 'row' }, el('span', { class: 'kind', text: `${link.values[F.linkKind] ?? 'Linked'} →` }), el('span', { class: 'chip issue', text: 'Needs review' })),
    el('button', { type: 'button', class: 'passage', on: { click: () => sheet.focusBlock(from) } }, preview(from, 120)), endChange(link, 'from'),
    el('button', { type: 'button', class: 'passage', on: { click: () => sheet.focusBlock(to) } }, preview(to, 120)), endChange(link, 'to'),
    state.readOnly ? null : el('div', { class: 'row end' }, el('button', { type: 'button', class: 'primary', text: 'Reviewed', on: { click: () => reviewed(link).catch(fail) } })));
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
async function exportAs(format, layout = 'book', typeset = false) {
  // The manuscript the person asked for, even if another is opened while this one is read.
  const root = state.root;
  await flush();
  setStatus('Exporting…');
  const plan = exportPlan(readManuscript(await readBlocks(), root));
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
    const referencesOnNewPage = typeset ? await referencesStartPage(plan) : false;
    const built = toDocx(plan, pictures, lib, Lexer, layout, { profile: profileOf(layout), typeset, referencesOnNewPage });
    blob = await packDocx(built, lib);
    file = typeset ? `${name} (as typeset).docx` : `${name}.docx`;
    missing = built.missing.map(m => m.alt || m.address);
  }
  download(blob, file);
  const counts = { blocks: plan.items.length, pictures: plan.items.filter(i => i.type === 'picture').length };
  state.lastExport = { format, layout: format === 'word' ? layout : null, typeset, file, bytes: blob.size, missing, ...counts };
  setStatus(`Exported ${file}`);
  toast(`Exported ${file} to your Downloads folder.`);
  if (missing.length) {
    state.problem = { text: `Exported ${file}, but ${missing.length} picture${missing.length === 1 ? '' : 's'} could not go in and stand${missing.length === 1 ? 's' : ''} as ${missing.length === 1 ? 'its description' : 'their descriptions'}: ${missing.join('; ')}.` };
  }
  render();
}

// ---------- Preview ----------

/** Inline Markdown as DOM: bold, italic, underline, strikethrough, highlight, code and line breaks. */
let previewNumbers = new Map();
// While the paper's running text is drawn, its words carry TeX's soft hyphens.
let hyphenating = false;
function inlineNodes(markdown) {
  const out = document.createDocumentFragment();
  for (const node of markdownToInline(markdown, Lexer)) {
    if (node.type === 'hardBreak') { out.append(document.createElement('br')); continue; }
    if (node.type === 'footnote') { if (previewNumbers.has(node.attrs.id)) out.append(el('sup', { class: 'pv-fn', text: String(previewNumbers.get(node.attrs.id)) })); continue; }
    let element = document.createTextNode(hyphenating ? softHyphens(node.text, hyphenate) : node.text);
    for (const mark of node.marks ?? []) {
      const tag = { bold: 'strong', italic: 'em', underline: 'u', strike: 's', highlight: 'mark', code: 'code', link: 'a' }[mark.type];
      if (!tag) continue;
      const wrap = document.createElement(tag); wrap.append(element); element = wrap;
    }
    out.append(element);
  }
  return out;
}

const PREVIEW_ALIGN = { Left: 'left', Centre: 'center', Right: 'right', Justify: 'justify' };

/** A block drawn for the preview, set as its own alignment says when it has one. */
function blockElement(block, layout, sizes = new Map()) {
  const element = blockBody(block, layout, sizes);
  if (block.align && PREVIEW_ALIGN[block.align]) element.style.textAlign = PREVIEW_ALIGN[block.align];
  return element;
}

function blockBody(block, layout, sizes) {
  const slug = role => `role-${String(role).toLowerCase().replace(/\s+/g, '-')}`;
  if (block.kind === 'title') return el('h1', { class: `pv-title${block.titlePage ? ' title-page' : ''}` }, inlineNodes(block.text));
  if (block.kind === 'heading') return el(`h${block.level + 1}`, { class: `pv-h${block.level}${block.centred ? ' centred' : ''}${block.part ? ' part' : ''}${block.role ? ` ${slug(block.role)}` : ''}` }, inlineNodes(block.text));
  if (block.kind === 'caption') return el('p', { class: `pv-caption${block.aboveTable ? ' above-table' : ''}` }, block.label ? el(layout === 'book' ? 'em' : 'strong', { text: `${block.label} ` }) : null, inlineNodes(block.text));
  if (block.kind === 'figure') {
    const widths = figureWidths(block, layout);
    return el('div', { class: 'pv-figure' }, block.pictures.map((picture, i) => {
      // Its height is known before it is laid out, so a sheet is filled with the room it takes:
      // the picture's own shape, or three by two for one that is missing or could not be read.
      const size = sizes.get(picture.address), known = size && size !== MISSING;
      const height = Math.round(widths[i] * (known ? size.height / size.width : 2 / 3));
      const box = el('span', { class: 'pv-picture', style: `width:${widths[i]}px;height:${height}px${known ? '' : ';overflow:hidden'}` });
      const missing = () => el('span', { class: 'pv-missing', text: `Picture: ${picture.alt || 'no description'}` });
      if (size === MISSING) box.append(missing());
      else Promise.resolve(resolvePicture(picture.address)).then(url => box.append(url ? el('img', { src: url, alt: picture.alt || '', style: `width:${widths[i]}px` }) : missing()));
      return box;
    }));
  }
  if (block.kind === 'table') {
    // The paper's columns are shared as the Word export and the reference share them.
    const shares = layout === 'paper' ? paperTableColumns(block.rows, article(profileOf('paper'))) : null;
    return el('table', { class: 'pv-table' }, shares ? el('colgroup', {}, shares.map(s => el('col', { style: `width:${(s * 100).toFixed(3)}%` }))) : null,
      el('tbody', {}, block.rows.map((cells, r) => el('tr', {}, (shares ?? cells).map((_, c) => el(r === 0 ? 'th' : 'td', {}, inlineNodes(cells[c] ?? '')))))));
  }
  if (block.list) {
    return el('p', { class: `pv-p pv-li level-${block.listLevel}`, style: layout === 'paper' ? null : `padding-left:${22 * (block.listLevel + 1)}px` }, el('span', { class: 'pv-marker', text: block.marker ?? '' }), inlineNodes(block.text));
  }
  const classes = ['pv-p', block.indent ? 'indent' : '', block.front ? 'front' : '', block.across ? 'across' : '', block.role ? slug(block.role) : ''].filter(Boolean).join(' ');
  if (block.role === 'Scene break' && !block.text.trim()) return el('p', { class: classes, text: '* * *' });
  return el('p', { class: classes }, block.label ? el('em', { text: `${block.label} ` }) : null, inlineNodes(block.text));
}

/**
 * Draws the page on page-sized sheets as the chosen layout sets it, a block at a time: a block
 * that must start a page, or would run past the sheet, starts the next one. An article's body
 * fills its left column, then its right, then the next sheet's, under the blocks that run
 * across the first page. An approximation of Word's pagination: a paragraph is never split
 * across columns or sheets.
 */
/** Each picture's natural size, by address, for the pictures the plan shows and that load. */
// A picture the file cannot show: its box is drawn at once, with the room it takes, rather than
// after the page is laid out, where it would push what follows past the sheet's edge.
const MISSING = 'missing';
async function pictureSizes(plan) {
  const addresses = [...new Set(plan.items.filter(item => item.type === 'picture').map(item => item.address))];
  const sizes = new Map();
  await Promise.all(addresses.map(async address => {
    const url = await resolvePicture(address);
    if (!url) { sizes.set(address, MISSING); return; }
    const image = new Image();
    image.src = url;
    try { await image.decode(); } catch { return; }
    if (image.naturalWidth && image.naturalHeight) sizes.set(address, { width: image.naturalWidth, height: image.naturalHeight });
  }));
  return sizes;
}

let previewRun = 0;
async function renderPreview() {
  const layout = state.mode, page = previewPage(layout), run = ++previewRun;
  const footnotes = new Map([...state.footnotes.values()].map(f => [f.id, { text: footnoteText(f.id) }]));
  for (const [id, text] of state.footnoteTexts) footnotes.set(id, { text });
  const plan = exportPlan({ title: state.title, nodes: sheet.read(), footnotes });
  previewNumbers = plan.footnoteNumbers;
  // Every picture's size first: a figure laid out before its picture loads takes no room, then
  // grows, and pushes the lines under it past the sheet's edge, where they are cut off.
  const sizes = await pictureSizes(plan);
  if (run !== previewRun || state.mode !== layout) return;
  const host = $('preview');
  host.dataset.layout = layout;
  host.style.removeProperty('--zoom');
  host.replaceChildren();
  if (layout === 'paper') { renderPaper(host, plan, page, sizes); previewZoom(); state.previewPages = host.childElementCount; return; }
  const limit = page.height - 2 * page.top;
  let body = null, columns = null, column = 0, current = null;
  // A block taller than a page: shown whole on a sheet that grows, and said, since a page cannot
  // hold it; Word carries it on to the next page.
  const runsOver = () => {
    if (current.classList.contains('runs-over')) return;
    current.classList.add('runs-over');
    current.append(el('p', { class: 'runs-over-note', text: 'This block is longer than a page. Word carries it on to the next one.' }));
  };
  const newSheet = () => {
    const number = host.childElementCount + 1;
    const sheetPage = el('section', { class: 'sheet-page', 'aria-label': `Page ${number}`, style: page.style ?? null });
    body = el('div', { class: 'sheet-body' });
    // An article's first page carries the draft line; every later one its number at the top.
    const folio = !page.columns ? el('div', { class: 'folio', text: String(number) })
      : number === 1 ? el('div', { class: 'running', text: draftLine() }) : el('div', { class: 'running number', text: String(number) });
    sheetPage.append(body, folio);
    host.append(sheetPage);
    current = sheetPage;
    columns = null;
  };
  const newColumns = () => {
    columns = Array.from({ length: page.columns }, () => el('div', { class: 'pv-column' }));
    body.append(el('div', { class: 'pv-columns' }, columns));
    column = 0;
  };
  const past = target => target.getBoundingClientRect().bottom - body.getBoundingClientRect().top > limit + 0.5;
  // What moves on when a block does not fit: the block, and the headings just above it, so a
  // heading is never left at the foot of a column or a sheet without its text, as Word keeps a
  // heading with the next paragraph. A container that would be left empty keeps them.
  const carried = element => {
    const moving = [element];
    let before = element.previousElementSibling;
    while (before && /^H[2-4]$/.test(before.tagName) && before.previousElementSibling) { moving.unshift(before); before = before.previousElementSibling; }
    return moving;
  };
  // A block that starts a page takes the headings just above it along, for the same reason; a
  // heading that starts a page itself stays, and a sheet that held only them is that page already.
  const startPage = () => {
    const box = columns ? columns[column] : body, moving = [];
    for (let last = box.lastElementChild; last && /^H[2-4]$/.test(last.tagName) && !last.hasAttribute('data-opens'); last = box.lastElementChild) { moving.unshift(last); last.remove(); }
    if (columns ? !columns.some(c => c.childElementCount) && body.childElementCount === 1 : !body.childElementCount) { box.append(...moving); return; }
    const inColumns = columns !== null;
    newSheet();
    if (inColumns) newColumns();
    (inColumns ? columns[0] : body).append(...moving);
  };
  newSheet();
  // The preview sets the footnotes after the text, numbered; a Word export puts each at the foot of its page.
  const notes = plan.footnotes.length ? [{ kind: 'heading', level: 2, text: 'Notes', breakBefore: false, indent: false, across: false },
    ...plan.footnotes.map(f => ({ kind: 'paragraph', role: null, text: `${f.n}. ${f.text}`, indent: false, breakBefore: false, across: false }))] : [];
  for (const block of [...previewBlocks(plan, layout), ...notes]) {
    const element = blockElement(block, layout, sizes);
    if (block.breakBefore) element.setAttribute('data-opens', '');
    if (!page.columns || block.across) {
      if (block.breakBefore && body.childElementCount) startPage();
      body.append(element);
      if (body.scrollHeight > limit && body.childElementCount > 1) { const moving = carried(element); moving.forEach(e => e.remove()); newSheet(); body.append(...moving); }
      if (body.scrollHeight > limit + 0.5) runsOver();
      continue;
    }
    if (block.breakBefore && (columns ? columns.some(c => c.childElementCount) : body.childElementCount)) startPage();
    if (!columns) newColumns();
    columns[column].append(element);
    if (past(columns[column]) && columns[column].childElementCount > 1) {
      const moving = carried(element);
      moving.forEach(e => e.remove());
      if (column + 1 < columns.length) column++;
      else { newSheet(); newColumns(); }
      columns[column].append(...moving);
    }
    if (past(columns[column])) runsOver();
  }
  previewZoom();
  state.previewPages = host.childElementCount;
}

// ---------- The paper's sheets ----------
// AASTeX's page as the Word export sets it: the title block across the first page, then two
// columns through which a paragraph runs on line by line, from the foot of one column to the
// head of the next, as Word and TeX carry it; a heading keeps two lines with it, a figure its
// caption and a table's caption its table; the columns above the references and those of the
// last page are balanced. A paragraph carried on is drawn once per column it reaches, each copy
// cut to its own lines; the first is the paragraph itself, the others are hidden from a reader.

// A piece of a paragraph: the paragraph, its first line here and how many lines.
const pieceOf = new WeakMap();
const HEADING = /^H[2-4]$/;

// A paragraph of the paper set as TeX sets it: its runs measured as the reference sets
// them in Termes, broken into lines by setLines with the reference's parameters, and each line
// drawn as a block of its own in Times New Roman (unkerned, as Word sets it), its spaces as wide
// as fill the line it has in TeX. The words keep their marks; a soft hyphen where a line breaks becomes a hyphen. The
// paragraph's last line's depth is kept, for the room TeX leaves under it before a picture. A
// paragraph no set of breaks fits is left to the browser.
const PT = 0.75;
function styleOf(element) {
  const s = getComputedStyle(element);
  return { bold: Number(s.fontWeight) >= 600, italic: s.fontStyle !== 'normal', code: /consolas|mono/i.test(s.fontFamily), size: parseFloat(s.fontSize) * PT };
}

function typesetParagraph(node, params = TEX) {
  const style = getComputedStyle(node);
  // The used width, unrounded: clientWidth rounds to whole pixels, and a fifth of a point decides a line.
  const width = (parseFloat(style.width) - (style.boxSizing === 'border-box' ? parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) : 0)) * PT;
  const indent = (parseFloat(style.textIndent) || 0) * PT;
  if (!(width > 0) || node.querySelector('br, img')) return false;
  // The runs of text in order, each with the elements that mark it (strong, em, code, a …).
  const pieces = [];
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    if (text.parentElement.closest('.pv-marker')) continue;
    const wrappers = [];
    for (let e = text.parentElement; e && e !== node; e = e.parentElement) wrappers.unshift(e);
    pieces.push({ text: text.data, wrappers, style: styleOf(text.parentElement) });
  }
  const size = parseFloat(style.fontSize) * PT, space = timesWidth(' ', { size });
  const widths = line => line === 0 ? width - indent : width;
  const lines = setLines(pieces, { measure: termesWidth, space: { width: space, stretch: space / 2, shrink: space / 3, extra: space / 3 }, widths, params });
  if (!lines) return false;
  const drawn = lines.map(line => {
    const block = el('span', { class: 'pv-line' });
    const spaces = drawnSpaces(line, timesWidth);
    let at = 0;
    for (const part of line.parts) {
      if (part.space === undefined) block.append(marked(part.text, part.piece.wrappers));
      else block.append(el('span', { class: 'pv-space', style: `word-spacing:${((spaces[at++] - part.natural) / PT).toFixed(3)}px` }, ' '));
    }
    if (line.hyphen) block.append(marked('-', line.hyphen.piece.wrappers));
    return block;
  });
  const last = lines.at(-1);
  node.dataset.depth = String(lineDepth(last.parts.filter(p => p.space === undefined).map(p => ({ text: p.text, style: p.piece.style }))));
  const marker = node.querySelector(':scope > .pv-marker');
  node.replaceChildren(...(marker ? [marker] : []), ...drawn);
  node.classList.add('typeset');
  return true;
}

// Text inside fresh copies of the elements that marked it, outermost first.
function marked(text, wrappers) {
  let out = document.createTextNode(text);
  for (let i = wrappers.length - 1; i >= 0; i--) { const copy = wrappers[i].cloneNode(false); copy.append(out); out = copy; }
  return out;
}

// Where this browser sets the baseline of a line of `line` points in type of `size` points,
// below the line's top, in points: a zero-sized inline block stands on the baseline.
function measuredBaseline(font) {
  const known = new Map();
  return (line, size) => {
    const key = `${line}/${size}`;
    if (!known.has(key)) {
      const mark = el('span', { style: 'display:inline-block;width:0;height:0' });
      const probe = el('p', { style: `position:absolute;visibility:hidden;left:0;top:0;margin:0;font:${size}pt/${line}pt ${font}` }, mark, 'Hg');
      document.body.append(probe);
      known.set(key, (mark.getBoundingClientRect().bottom - probe.getBoundingClientRect().top) * 0.75);
      probe.remove();
    }
    return known.get(key);
  };
}


function renderPaper(host, plan, page, sizes) {
  const style = $('paper-style') ?? document.head.appendChild(el('style', { id: 'paper-style' }));
  const below = measuredBaseline(page.font);
  style.textContent = paperStyle(page.article, page.font, below);
  // The sheet's body starts where its first baseline falls on the article's, and a column's
  // lines end where its last may; both from the baseline this browser sets.
  const A = page.article;
  page = { ...page, limit: (A.bottom + A.pitch - below(A.pitch, A.size) - (A.top - below(A.pitch, A.size))) * 4 / 3 };
  let body = null, columns = null, column = 0, current = null, limit = page.limit, balancing = false, splitting = false, referencesOnNewPage = false;
  const newSheet = () => {
    const number = host.childElementCount + 1;
    current = el('section', { class: 'sheet-page', 'aria-label': `Page ${number}` });
    body = el('div', { class: 'sheet-body' });
    // The first page carries the draft line; every later one its number on the outer side.
    const running = number === 1 ? el('div', { class: 'running draft', text: draftLine() }) : el('div', { class: `running ${number % 2 ? 'odd' : 'even'}`, text: String(number) });
    current.append(body, running);
    host.append(current);
    columns = null;
  };
  const newColumns = () => {
    columns = [el('div', { class: 'pv-column' }), el('div', { class: 'pv-column' })];
    body.append(el('div', { class: 'pv-columns' }, columns));
    column = 0;
  };
  const top = node => node.getBoundingClientRect().top - body.getBoundingClientRect().top;
  const fits = node => node.getBoundingClientRect().bottom - body.getBoundingClientRect().top <= limit + 0.5;
  const runsOver = () => {
    if (current.classList.contains('runs-over')) return;
    current.classList.add('runs-over');
    current.append(el('p', { class: 'runs-over-note', text: 'This block is longer than a page. Word carries it on to the next one.' }));
  };
  // Lines of running text can be cut between; a caption, a heading or the title block cannot.
  const cuttable = node => pieceOf.has(node) || (node.tagName === 'P' && node.classList.contains('pv-p') && !node.classList.contains('front') && !node.classList.contains('role-author'));
  const piece = (source, from, count, line, marginTop, marginBottom) => {
    const content = from === 0 ? source : Object.assign(source.cloneNode(true), { inert: true });
    if (from > 0) content.setAttribute('aria-hidden', 'true');
    content.style.margin = '0';
    content.style.marginTop = `${-from * line}px`;
    const wrap = el('div', { class: `pv-piece ${source.className}`, style: `height:${count * line}px;overflow:hidden;margin-top:${marginTop}px;margin-bottom:${marginBottom}px` }, content);
    pieceOf.set(wrap, { source, from, count, line, marginTop, marginBottom });
    return wrap;
  };
  // Cuts a block of lines where the column ends: the lines that fit stay, the rest go on.
  const cut = node => {
    const known = pieceOf.get(node), source = known?.source ?? node, computed = getComputedStyle(known ? node : source);
    const line = known?.line ?? parseFloat(computed.lineHeight);
    const from = known?.from ?? 0, total = known?.count ?? Math.round(node.getBoundingClientRect().height / line);
    let fit = Math.floor((limit - top(node) + 0.5) / line);
    if (fit >= total) return null;
    // Never one line of a paragraph alone at the foot of a column or the head of the next, as
    // Word's widow control and TeX's penalties keep it; a heading keeps two lines with it too.
    if (from === 0 && fit < 2) return null;
    if (total - fit < 2) fit = total - 2;
    if (fit < (from === 0 ? 2 : 1)) return null;
    const marginTop = parseFloat(computed.marginTop), marginBottom = known?.marginBottom ?? parseFloat(computed.marginBottom);
    // The head takes the paragraph itself into it, so it goes where the block was by a marker.
    const marker = document.createComment('');
    node.before(marker);
    const head = piece(source, from, fit, line, marginTop, 0), tail = piece(source, from + fit, total - fit, line, 0, marginBottom);
    marker.replaceWith(head);
    if (node !== source) node.remove();
    return tail;
  };
  // What moves on with a block that does not fit: the headings above it, the figure above a
  // caption, and a table's caption above its table.
  const carried = node => {
    const moving = [node];
    for (let before = node.previousElementSibling; before && before.previousElementSibling; before = before.previousElementSibling) {
      const keeps = HEADING.test(before.tagName) || before.classList.contains('above-table') || (before.classList.contains('pv-figure') && moving[0].classList.contains('pv-caption'));
      if (!keeps) break;
      moving.unshift(before);
    }
    return moving;
  };
  const next = () => {
    // Split as \vsplit splits, the second column takes all that is left.
    if (column + 1 < columns.length) { column++; if (splitting) limit = Infinity; return true; }
    if (balancing) return false;
    newSheet(); newColumns();
    return true;
  };
  const place = node => {
    // `lead` is the first of the blocks moving together; at the head of a column they stay.
    let lead = node;
    for (;;) {
      columns[column].append(node);
      if (fits(node)) return true;
      if (cuttable(node)) {
        const tail = cut(node);
        if (tail) { if (!next()) return false; node = lead = tail; continue; }
      }
      // At the head of a column it stays: longer than any column, the sheet grows to show it;
      // unless the columns start lower on this sheet, under what runs across it.
      if (columns[column].firstElementChild === lead) {
        if (splitting && column === 0) { moveOn(lead); node = lead; continue; }
        if (balancing) return false;
        if (body.firstElementChild === columns[0].parentElement) { runsOver(); return true; }
        lead.remove(); newSheet(); newColumns(); node = lead; continue;
      }
      const moving = carried(node);
      moving.forEach(m => m.remove());
      if (!next()) return false;
      columns[column].append(...moving.slice(0, -1));
      lead = moving[0]; node = moving.at(-1);
    }
  };
  const moveOn = node => { node.remove(); next(); };
  // Balances the open columns as revtex does (\balance@two): the pieces of one paragraph joined
  // again, the first column split off at half their height, then the split moved by half as much
  // again each time towards the longer column, until the two end within half a point of each other
  // or the step is under half a point; the last split stands.
  // `full` lays them out again filling the first column, as before balancing.
  const balance = (full = false) => {
    if (!columns) return;
    const items = [];
    for (const node of [...columns[0].children, ...columns[1].children]) {
      const p = pieceOf.get(node), last = items.at(-1), q = last && pieceOf.get(last);
      if (p && q && q.source === p.source && q.from + q.count === p.from) {
        items[items.length - 1] = piece(p.source, q.from, q.count + p.count, p.line, q.marginTop, p.marginBottom);
        continue;
      }
      items.push(node);
    }
    // A paragraph whose pieces were all joined is the paragraph again.
    const ready = items.map(node => {
      const p = pieceOf.get(node);
      if (p && p.from === 0 && Math.abs(p.count * p.line - p.source.scrollHeight) < 1) { p.source.style.margin = ''; p.source.style.marginTop = ''; return p.source; }
      return node;
    });
    const [a, b] = columns, columnsTop = top(a), saved = limit;
    a.replaceChildren(...ready); b.replaceChildren();
    const needed = a.getBoundingClientRect().height;
    const lay = height => { limit = Math.min(saved, columnsTop + height); a.replaceChildren(); b.replaceChildren(); column = 0; ready.every(node => place(node)); };
    balancing = true;
    if (full) lay(saved - columnsTop);
    else {
      const ends = c => c.lastElementChild ? c.lastElementChild.getBoundingClientRect().bottom - c.getBoundingClientRect().top : 0;
      const halfPoint = 0.5 * 96 / 72.27;
      let at = needed / 2, step = needed / 2;
      splitting = true;
      for (;;) {
        lay(at);
        step /= 2;
        const difference = ends(a) - ends(b);
        if (Math.abs(difference) < halfPoint || step < halfPoint) break;
        at += difference < 0 ? step : -step;
      }
      splitting = false;
    }
    balancing = false; limit = saved;
  };
  // The room TeX leaves around a picture or a table runs from the bottom of the line above it, so
  // it grows with how far that line reaches below its baseline: a paragraph set here knows its
  // last line's depth; anything else is taken to reach a descender down.
  const P = A.pitch, S = A.size, C = A.captionPitch, CS = A.captionSize;
  const after = (line, size) => line - below(line, size);
  const depthOf = (node, size) => {
    const known = node?.dataset.depth ?? node?.firstElementChild?.dataset.depth;
    return known !== undefined ? Number(known) : A.descender * size;
  };
  const set = (node, property, points) => node.style.setProperty(property, `${points.toFixed(3)}pt`);
  const roomAround = (node, above) => {
    const caption = above?.matches('.pv-caption');
    if (node.matches('.pv-figure') && above) set(node, 'margin-top', caption ? A.pictureAfterCaption + depthOf(above, CS) - after(C, CS) : A.pictureAbove + depthOf(above, S) - after(P, S));
    if (node.matches('.pv-caption.above-table')) {
      if (above) set(node, 'margin-top', A.tableCaption + depthOf(above, S) - after(P, S) - below(C, CS));
      set(node, 'margin-bottom', A.ruleBelowCaption + depthOf(node, CS) - after(C, CS));
    } else if (node.matches('.pv-caption')) set(node, 'margin-bottom', A.afterCaption + depthOf(node, CS) - after(C, CS) - below(P, S));
    if (/^H[2-4]$/.test(node.tagName) && caption) set(node, 'margin-top', A.headingAfterCaption + depthOf(above, CS) - after(C, CS) - below(P, S));
  };
  newSheet();
  const notes = plan.footnotes.length ? [{ kind: 'heading', level: 2, text: 'Notes', breakBefore: false, indent: false, across: false },
    ...plan.footnotes.map(f => ({ kind: 'paragraph', role: null, text: `${f.n}. ${f.text}`, indent: false, breakBefore: false, across: false }))] : [];
  for (const block of [...previewBlocks(plan, 'paper'), ...notes]) {
    // TeX hyphenates running text and captions; never the references, and headings rarely.
    hyphenating = (block.kind === 'paragraph' && block.role !== 'References' && block.role !== 'Glossary' && !block.front && block.role !== 'Author') || block.kind === 'caption';
    const element = blockElement(block, 'paper', sizes);
    hyphenating = false;
    // Running text, the abstract and captions are set as TeX sets them, at the width they take.
    const typeset = () => {
      if ((element.matches('p.pv-p') && !element.matches('.front, .role-author, .role-references, .role-glossary, .role-keywords')) || element.matches('p.pv-caption')) typesetParagraph(element);
      // The references as AASTeX sets them: ragged right, French spacing, never hyphenated.
      else if (element.matches('p.pv-p.role-references')) typesetParagraph(element, BIBLIOGRAPHY);
    };
    if (block.across) {
      body.append(element);
      typeset();
      if (!fits(element)) runsOver();
      continue;
    }
    // The references' heading runs across the page, under the columns above it balanced.
    if (block.kind === 'heading' && block.role === 'References' && block.part) {
      balance();
      body.append(element);
      // It needs room for two of the references under it, or it starts the next sheet.
      const room = element.getBoundingClientRect().bottom - body.getBoundingClientRect().top + (A.firstReference + 2 * A.referencePitch) * 4 / 3;
      // Moving on, it leaves the columns above it as they were, filled from the first.
      if (room > limit + 0.5) { element.remove(); balance(true); newSheet(); body.append(element); referencesOnNewPage = true; }
      newColumns();
      continue;
    }
    // A block that starts a page takes the headings just above it along, as Word keeps them.
    if (block.breakBefore && columns && columns.some(c => c.childElementCount)) {
      const moving = [];
      for (let last = columns[column].lastElementChild; last && HEADING.test(last.tagName); last = columns[column].lastElementChild) { moving.unshift(last); last.remove(); }
      if (columns.some(c => c.childElementCount)) { newSheet(); newColumns(); }
      columns[column].append(...moving);
    }
    if (!columns) newColumns();
    const before = columns[column].lastElementChild;
    columns[column].append(element);
    typeset();
    roomAround(element, before);
    element.remove();
    place(element);
  }
  balance();
  return { referencesOnNewPage };
}

/**
 * Whether the paper's references start a page, as the preview lays the paper out: the Word
 * export set as TeX sets it starts them there too. Laid out off screen when the preview is not.
 */
async function referencesStartPage(plan) {
  const sizes = await pictureSizes(plan);
  const host = el('div', { class: 'preview', 'data-layout': 'paper', 'aria-hidden': 'true', style: 'position:fixed;left:-30000px;top:0;visibility:hidden' });
  document.body.append(host);
  const numbers = previewNumbers;
  previewNumbers = plan.footnoteNumbers;
  try { return renderPaper(host, plan, previewPage('paper'), sizes).referencesOnNewPage; }
  finally { previewNumbers = numbers; host.remove(); }
}

// The line length chosen under Appearance is how wide a sheet's text column appears on screen:
// the sheets are scaled to it, and Full scales them to the frame. The text size scales them
// again, by what it does to the writing sheet's type (17, 19 or 22 pixels), since a page's own
// type is the layout's. A sheet is never wider than the frame. Pagination is measured at the
// sheet's real size first, so a scale changes nothing.
const MEASURE = { narrow: 620, medium: 760, wide: 960 };
const SIZE = { small: 17 / 19, medium: 1, large: 22 / 19 };
function previewZoom() {
  if (state.mode === 'write') return;
  const host = $('preview'), page = PAGES[state.mode];
  const room = host.clientWidth - 32, text = page.width - page.margin - (page.right ?? page.margin);
  const measure = MEASURE[state.appearance.width];
  let zoom = (measure ? measure / text : room / page.width) * (SIZE[state.appearance.size] ?? 1);
  if (room > 0) zoom = Math.min(zoom, room / page.width);
  host.style.setProperty('--zoom', String(Math.max(0.25, zoom)));
  state.previewZoom = zoom;
}

async function setMode(mode) {
  if (!['write', 'book', 'paper'].includes(mode) || mode === state.mode) return;
  if (state.mode === 'write' && pending()) await save();
  state.mode = mode;
  document.documentElement.dataset.mode = mode;
  closePopover(); state.pinned = false;
  if (mode !== 'write') state.drawer = null;
  $('page').hidden = mode !== 'write' || state.root === null;
  $('preview').hidden = mode === 'write';
  if (mode === 'write') sheet.editor.commands.focus();
  else { $('scroller').scrollTop = 0; renderPreview(); }
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

/** Whether a block is part of the open manuscript: in its sheet, its Cuttings or a footnote of either. */
function inManuscript(id) {
  for (let at = id, steps = 0; at != null && steps <= 66; at = block(at)?.parent ?? null, steps++) if (at === state.root) return true;
  return false;
}

/** The open manuscript's notes; the file may hold other manuscripts, and theirs are not counted. */
function manuscriptNotes() { return state.root === null ? [] : state.notes.filter(n => inManuscript(n.values[F.noteBlock])); }

function counts() {
  const notes = new Map(), links = new Map();
  for (const n of state.notes) { const b = n.values[F.noteBlock]; notes.set(b, (notes.get(b) ?? 0) + 1); }
  for (const l of state.links) for (const b of [l.values[F.linkFrom], l.values[F.linkTo]]) links.set(b, (links.get(b) ?? 0) + 1);
  return { notes, links };
}

/** Words in the chapter (or part) the caret is in, and in the whole manuscript. */
// Words per block, by the editor's node: a node is never changed, only replaced, so a count holds
// for as long as its node is on the page, and a keystroke recounts one paragraph.
const counted = new WeakMap();
function wordsIn(node) {
  let w = counted.get(node);
  if (w === undefined) { w = countWords(node.textContent); counted.set(node, w); }
  return w;
}

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
    const w = wordsIn(node);
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

// Nendo takes a toolbar text of at most 80 characters and refuses all the controls for a longer
// one; a status that names a long file name would pass it.
const TOOLBAR_TEXT = 80;
const fit = (text, max) => text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

let declared = null;
function declare() {
  if (!state.chrome) { renderOwnToolbar(); return; }
  const style = state.root !== null ? sheet.styleHere() : 'Paragraph';
  const a = state.appearance;
  const radio = (id, value, label, current) => ({ kind: 'radio', id, value, label, checked: current === value });
  const items = [
    ...(state.root !== null ? [{ kind: 'choice', id: 'mode', label: 'View', hideLabel: true, value: state.mode,
      options: [{ value: 'write', label: 'Write' }, { value: 'book', label: 'Book' }, { value: 'paper', label: 'Paper' }] }] : []),
    ...(state.root !== null ? [{ kind: 'select', id: 'manuscript', label: 'Manuscript', hideLabel: true, value: state.root,
      options: [...(state.manuscripts ?? []).slice(0, 63).map(m => ({ value: m.id, label: (m.id === state.root ? state.title || 'Untitled manuscript' : m.title || 'Untitled manuscript').slice(0, 80) })),
        { value: 'new', label: 'New manuscript\u2026' }] }] : []),
    ...(state.mode !== 'write' ? [] : [{ kind: 'select', id: 'style', label: 'Style', value: style, options: STYLES.map(s => ({ value: s, label: s })) }]),
    ...(state.mode === 'write' && state.root !== null && !state.readOnly ? [formatMenu()] : []),
    ...(state.roles && state.mode === 'write' ? [{ kind: 'select', id: 'role', label: 'Role', value: (state.root !== null && sheet.roleHere()) || 'none', options: [{ value: 'none', label: 'No role' }, ...ROLES.map(r => ({ value: r, label: r }))] }] : []),
    { kind: 'text', text: fit(`${state.status} · ${summary()}`, TOOLBAR_TEXT) },
    { kind: 'spacer' },
    ...(state.mode !== 'write' ? [] : [
      { kind: 'toggle', id: 'outline', label: 'Outline', icon: 'list', pressed: state.drawer === 'outline' },
      { kind: 'toggle', id: 'notes', label: `Notes ${manuscriptNotes().length || ''}`.trim(), icon: 'edit', pressed: state.drawer === 'notes' },
      { kind: 'toggle', id: 'related', label: 'Related', icon: 'link', pressed: state.drawer === 'related' },
      ...(state.profilesOn ? [{ kind: 'toggle', id: 'pagesetup', label: 'Page setup', icon: 'layout', pressed: state.drawer === 'pagesetup' }] : []),
      { kind: 'toggle', id: 'links', label: `Links${state.links.some(l => l.values[F.linkReview] === REVIEW.needsReview) ? ` ${state.links.filter(l => l.values[F.linkReview] === REVIEW.needsReview).length}` : ''}`, icon: 'chain', pressed: state.drawer === 'links' },
      { kind: 'toggle', id: 'cuttings', label: 'Cuttings', icon: 'layers', pressed: state.drawer === 'cuttings' },
      { kind: 'toggle', id: 'find', label: 'Find', icon: 'search', pressed: state.drawer === 'find' },
    ]),
    { kind: 'menu', id: 'export', label: 'Export', icon: 'export', items: [
      { id: 'export-markdown', label: 'Markdown', detail: 'A .zip with the text and its pictures' },
      { id: 'export-word', label: 'Word document, book layout', detail: 'A 6 by 9 inch book: title page, chapters on new pages' },
      { id: 'export-word-paper', label: 'Word document, paper layout', detail: 'An article: title block, abstract, numbered sections, figures' },
      { id: 'export-word-paper-typeset', label: 'Word document, paper as typeset', detail: 'The paper line for line as the preview sets it; its lines do not reflow' },
      { id: 'export-word-manuscript', label: 'Word document, manuscript layout', detail: 'For a submission: double-spaced Times at 12 points on Letter' },
    ] },
    { kind: 'menu', id: 'appearance', label: 'Appearance', icon: 'settings', iconOnly: true, items: [
      { kind: 'label', label: 'Typeface' }, radio('font', 'serif', 'Serif', a.font), radio('font', 'sans', 'Sans serif', a.font),
      { kind: 'separator' }, { kind: 'label', label: 'Size' },
      radio('size', 'small', 'Small', a.size), radio('size', 'medium', 'Medium', a.size), radio('size', 'large', 'Large', a.size),
      { kind: 'separator' }, { kind: 'label', label: 'Line length' },
      radio('width', 'narrow', 'Narrow', a.width), radio('width', 'medium', 'Medium', a.width), radio('width', 'wide', 'Wide', a.width), radio('width', 'full', 'Full', a.width),
      { kind: 'separator' }, { kind: 'label', label: 'Pictures' },
      radio('pictures', 'small', 'Thumbnails', a.pictures), radio('pictures', 'full', 'Full width', a.pictures),
    ] },
  ];
  const text = JSON.stringify(items);
  if (text === declared) return;
  declared = text;
  nendo.ui.setToolbar({ items }).catch(error => { state.chrome = false; state.problem = { text: `Nendo did not take the view's controls: ${error.message}` }; render(); });
}

/**
 * Every tool of the bar that applies where the caret is, by name, as a menu in Nendo's toolbar:
 * the way to them without a selection, from the toolbar, Ctrl K and More. A mark, a list or a
 * role is a check, an alignment or a style a radio. Their keys are the editor's own and are
 * named in the tooltips, not declared here, since a declared key would run the tool twice.
 */
function formatMenu() {
  const where = sheet.where();
  const node = where ? sheet.editor.state.doc.nodeAt(where.pos) : null;
  const here = node ? toolsFor(node) : [];
  const item = t => {
    const on = toolOn(t);
    if (t.align) return { kind: 'radio', id: 'fmt-align', value: t.align, label: t.label, checked: on === true };
    if (t.style) return { kind: 'radio', id: 'fmt-style', value: t.style, label: t.label, checked: on === true };
    if (on !== null) return { kind: 'check', id: `fmt-${t.id}`, label: t.label, checked: on };
    return { kind: 'item', id: `fmt-${t.id}`, label: t.label, detail: t.id === 'agent' && where ? `${where.id} · ${block(where.id) ? `v${block(where.id).version}` : 'not saved yet'}` : null };
  };
  const items = [];
  for (const [group, name] of GROUPS) {
    const tools = here.filter(t => t.group === group);
    if (!tools.length) continue;
    if (items.length) items.push({ kind: 'separator' });
    items.push({ kind: 'label', label: name }, ...tools.map(item));
  }
  if (!items.length) items.push({ kind: 'label', label: 'Put the caret in a paragraph' });
  return { kind: 'menu', id: 'format', label: 'Format', items };
}

function command({ id, value }) {
  if (id === 'fmt-align' || id === 'fmt-style') {
    const t = TOOLS.find(t => (id === 'fmt-align' ? t.align : t.style) === value);
    // A radio chosen again is the alignment chosen again: back to the layout's own.
    if (t) { state.selected = sheet.where()?.id ?? state.selected; runTool(t); }
    return;
  }
  if (id.startsWith('fmt-')) {
    const t = TOOLS.find(t => `fmt-${t.id}` === id);
    if (t) { state.selected = sheet.where()?.id ?? state.selected; runTool(t); }
    return;
  }
  if (id === 'export-markdown') { exportAs('markdown').catch(fail); return; }
  if (id === 'export-word-paper-typeset') { exportAs('word', 'paper', true).catch(fail); return; }
  if (id === 'export-word' || id === 'export-word-paper' || id === 'export-word-manuscript') { exportAs('word', { 'export-word-paper': 'paper', 'export-word-manuscript': 'manuscript' }[id] ?? 'book').catch(fail); return; }
  if (id === 'mode') { setMode(value).catch(fail); return; }
  if (id === 'manuscript') { (value === 'new' ? startManuscript() : openManuscript(value)).catch(fail); return; }
  if (id === 'style') { sheet.setStyle(value); return; }
  if (id === 'role') { sheet.setRole(value === 'none' ? null : value); return; }
  if (id === 'find') { if (state.drawer === 'find') closeDrawer(); else openFind(false); return; }
  if (id === 'notes') state.notesOf = null;
  if (id === 'outline' || id === 'notes' || id === 'related' || id === 'cuttings' || id === 'links' || id === 'pagesetup') { state.drawer = state.drawer === id ? null : id; render(); declare(); return; }
  if (id === 'font' || id === 'size' || id === 'width' || id === 'pictures') { state.appearance = { ...state.appearance, [id]: value }; applyAppearance(); previewZoom(); declare(); keepAppearance(id, value); }
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

// ---------- The selection bar ----------
// One row of icons over the selected words, in groups. Each tool's name and keys are in its
// tooltip. The tools not on the bar wait under More, where any of them can be pinned to it;
// right-click on a tool on the bar (or the context-menu key) puts it back. The choice is kept
// on this device, like Appearance.

const ICON = {
  bold: '<path class="heavy" d="M4.5 2.5h4a2.75 2.75 0 0 1 0 5.5h-4zM4.5 8h4.75a2.75 2.75 0 0 1 0 5.5H4.5z"/>',
  italic: '<path d="M7 2.5h5M4 13.5h5M10 2.5 6 13.5"/>',
  underline: '<path d="M4.5 2.5v5a3.5 3.5 0 0 0 7 0v-5M3.5 14h9"/>',
  strike: '<path d="M2.5 8h11M11.2 4.6C10.8 3.4 9.6 2.5 8 2.5 6.1 2.5 5 3.5 5 4.8c0 1 .6 1.7 1.6 2.1M10.6 9.6c.3.4.4.8.4 1.2 0 1.5-1.3 2.7-3.2 2.7-1.7 0-3-.9-3.4-2.1"/>',
  code: '<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/>',
  highlight: '<path d="M9.5 3 13 6.5 7 12.5H3.5V9zM8 4.5l3.5 3.5M2.5 14.5h11"/>',
  clear: '<path d="M4 3.5h8M8 3.5 6.5 12.5M10 10l3.5 3.5M13.5 10 10 13.5"/>',
  'align-left': '<path d="M2.5 3.5h11M2.5 6.5h7M2.5 9.5h11M2.5 12.5h7"/>',
  'align-centre': '<path d="M2.5 3.5h11M4.5 6.5h7M2.5 9.5h11M4.5 12.5h7"/>',
  'align-right': '<path d="M2.5 3.5h11M6.5 6.5h7M2.5 9.5h11M6.5 12.5h7"/>',
  'align-justify': '<path d="M2.5 3.5h11M2.5 6.5h11M2.5 9.5h11M2.5 12.5h11"/>',
  paragraph: '<path d="M10 3v10M12.5 3v10M13.5 3H7.5a2.75 2.75 0 0 0 0 5.5H10"/>',
  part: '<path d="M2.5 3.5v9M8.5 3.5v9M2.5 8h6M11.5 9.5l1.75-1.25v4.25"/>',
  chapter: '<path d="M2.5 3.5v9M8.5 3.5v9M2.5 8h6M11.3 9.3c.2-.6.7-.9 1.3-.9.7 0 1.2.5 1.2 1.1 0 1.1-2.5 1.8-2.5 3h2.6"/>',
  section: '<path d="M2.5 3.5v9M8.5 3.5v9M2.5 8h6M11.3 8.7c.3-.4.7-.6 1.2-.6.7 0 1.2.4 1.2 1s-.5 1-1.2 1c.8 0 1.4.4 1.4 1.1s-.6 1.2-1.4 1.2c-.6 0-1.1-.3-1.3-.7"/>',
  quotation: '<path d="M3 3.5v9M6 4.5h7.5M6 8h7.5M6 11.5h5"/>',
  bulleted: '<path d="M6.5 4h7M6.5 8h7M6.5 12h7M2.4 4a.6.6 0 1 0 1.2 0a.6.6 0 1 0-1.2 0M2.4 8a.6.6 0 1 0 1.2 0a.6.6 0 1 0-1.2 0M2.4 12a.6.6 0 1 0 1.2 0a.6.6 0 1 0-1.2 0"/>',
  numbered: '<path d="M6.5 4h7M6.5 8h7M6.5 12h7M2.5 2.8l1-.5v3.2M2.4 9.6c.1-.6.5-1 1.1-1 .6 0 1 .4 1 .9 0 .9-2.1 1.5-2.1 2.8h2.2"/>',
  indent: '<path d="M7 4h6.5M7 8h6.5M7 12h6.5M2.5 5.5 5 8l-2.5 2.5"/>',
  outdent: '<path d="M7 4h6.5M7 8h6.5M7 12h6.5M5 5.5 2.5 8 5 10.5"/>',
  table: '<path d="M2.5 3.5h11v9h-11zM2.5 6.5h11M2.5 9.5h11M6.2 3.5v9M9.8 3.5v9"/>',
  'row-after': '<path d="M2.5 2.5h11v6h-11zM2.5 5.5h11M8 10.5v4M6 12.5h4"/>',
  'column-after': '<path d="M2.5 2.5h6v11h-6zM5.5 2.5v11M10.5 8h4M12.5 6v4"/>',
  'row-delete': '<path d="M2.5 2.5h11v6h-11zM2.5 5.5h11M6 11.5l4 3M10 11.5l-4 3"/>',
  'column-delete': '<path d="M2.5 2.5h6v11h-6zM5.5 2.5v11M10.5 6l3 4M13.5 6l-3 4"/>',
  'table-delete': '<path d="M2.5 3.5h7v6h-7zM2.5 6.5h7M6 3.5v6M10.5 10.5l3 3M13.5 10.5l-3 3"/>',
  link: '<path d="M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1"/>',
  note: '<path d="M3 3h10v7l-3 3H3z"/><path d="M10 13v-3h3"/>',
  cut: '<circle cx="4.5" cy="11.5" r="2"/><circle cx="11.5" cy="11.5" r="2"/><path d="M6 10 12 3M10 10 4 3"/>',
  agent: '<path d="M3 3.5h10v7H7l-3 2.5v-2.5H3z"/>',
  more: '<path d="M3.2 8a.8.8 0 1 0 1.6 0a.8.8 0 1 0-1.6 0M7.2 8a.8.8 0 1 0 1.6 0a.8.8 0 1 0-1.6 0M11.2 8a.8.8 0 1 0 1.6 0a.8.8 0 1 0-1.6 0"/>',
  grip: '<path class="dots" d="M5.5 3.5a1.1 1.1 0 1 0 0 2.2a1.1 1.1 0 1 0 0-2.2M10.5 3.5a1.1 1.1 0 1 0 0 2.2a1.1 1.1 0 1 0 0-2.2M5.5 6.9a1.1 1.1 0 1 0 0 2.2a1.1 1.1 0 1 0 0-2.2M10.5 6.9a1.1 1.1 0 1 0 0 2.2a1.1 1.1 0 1 0 0-2.2M5.5 10.3a1.1 1.1 0 1 0 0 2.2a1.1 1.1 0 1 0 0-2.2M10.5 10.3a1.1 1.1 0 1 0 0 2.2a1.1 1.1 0 1 0 0-2.2"/>',
  add: '<path d="M8 3.5v9M3.5 8h9"/>',
  pin: '<path d="M9.5 2.5l4 4-2 1-2.5 2.5.5 2.5-1 1-6-6 1-1 2.5.5 2.5-2.5zM5.5 10.5 2.5 13.5"/>',
  'move-up': '<path d="M8 13V3.5M4.5 7 8 3.5 11.5 7"/>',
  weblink: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c-2 2-2 9 0 11M8 2.5c2 2 2 9 0 11"/>',
  picture: '<path d="M2.5 3.5h11v9h-11z"/><path d="M2.5 11l3.5-3.5 3 3 2-2 2.5 2.5"/><circle cx="10.5" cy="6" r="1"/>',
  describe: '<path d="M2.5 12.5h3l7-7-3-3-7 7z"/><path d="M8.5 3.5l3 3"/>',
  footnote: '<path d="M2.5 12h7M2.5 14h5M10.5 2.5v5M9 4l1.5-1.5"/>',
  caption: '<path d="M2.5 2.5h11v7h-11zM2.5 12h11M2.5 14h7"/>',
  'move-down': '<path d="M8 3v9.5M4.5 9 8 12.5 11.5 9"/>',
};
function svg(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('aria-hidden', 'true'); s.innerHTML = ICON[name];
  return s;
}

// In bar order. A tool names what it does: a mark it toggles, an alignment, a style or a role it
// sets, or an action of its own. The keys are the editor's own.
const TOOLS = [
  { id: 'bold', label: 'Bold', keys: 'Ctrl+B', group: 'text', mark: 'bold' },
  { id: 'italic', label: 'Italic', keys: 'Ctrl+I', group: 'text', mark: 'italic' },
  { id: 'underline', label: 'Underline', keys: 'Ctrl+U', group: 'text', mark: 'underline' },
  { id: 'strike', label: 'Strikethrough', keys: 'Ctrl+Shift+S', group: 'text', mark: 'strike' },
  { id: 'code', label: 'Inline code', keys: 'Ctrl+E', group: 'text', mark: 'code' },
  { id: 'highlight', label: 'Highlight', keys: 'Ctrl+Shift+H', group: 'text', mark: 'highlight' },
  { id: 'weblink', label: 'Web link', keys: '', group: 'text' },
  { id: 'clear', label: 'Clear formatting', keys: '', group: 'text' },
  { id: 'align-left', label: 'Align left', keys: 'Ctrl+Shift+L', group: 'align', align: 'Left' },
  { id: 'align-centre', label: 'Centre', keys: 'Ctrl+Shift+E', group: 'align', align: 'Centre' },
  { id: 'align-right', label: 'Align right', keys: 'Ctrl+Shift+R', group: 'align', align: 'Right' },
  { id: 'align-justify', label: 'Justify', keys: 'Ctrl+Shift+J', group: 'align', align: 'Justify' },
  { id: 'paragraph', label: 'Paragraph', keys: '', group: 'paragraph', style: 'Paragraph' },
  { id: 'part', label: 'Part heading', keys: '#', group: 'paragraph', style: 'Part' },
  { id: 'chapter', label: 'Chapter heading', keys: '##', group: 'paragraph', style: 'Chapter' },
  { id: 'section', label: 'Section heading', keys: '###', group: 'paragraph', style: 'Section' },
  { id: 'quotation', label: 'Quotation', keys: '', group: 'paragraph', role: 'Quotation' },
  { id: 'bulleted', label: 'Bulleted list', keys: 'Ctrl+Shift+8', group: 'paragraph', list: 'Bulleted' },
  { id: 'numbered', label: 'Numbered list', keys: 'Ctrl+Shift+7', group: 'paragraph', list: 'Numbered' },
  { id: 'indent', label: 'Indent list item', keys: 'Tab', group: 'paragraph', step: 1 },
  { id: 'outdent', label: 'Outdent list item', keys: 'Shift+Tab', group: 'paragraph', step: -1 },
  { id: 'table', label: 'Insert table', keys: '', group: 'paragraph' },
  { id: 'picture', label: 'Insert picture', keys: '', group: 'paragraph' },
  { id: 'footnote', label: 'Footnote', keys: 'Ctrl+Alt+F', group: 'paragraph' },
  { id: 'row-after', label: 'Add row below', keys: '', group: 'table', command: 'addRowAfter' },
  { id: 'column-after', label: 'Add column right', keys: '', group: 'table', command: 'addColumnAfter' },
  { id: 'row-delete', label: 'Delete row', keys: '', group: 'table', command: 'deleteRow' },
  { id: 'column-delete', label: 'Delete column', keys: '', group: 'table', command: 'deleteColumn' },
  { id: 'table-delete', label: 'Delete table', keys: '', group: 'table', command: 'deleteTable' },
  { id: 'link', label: 'Link to a passage', keys: '', group: 'manuscript' },
  { id: 'note', label: 'Add a note', keys: '', group: 'manuscript' },
  { id: 'cut', label: 'Keep as cutting', keys: '', group: 'manuscript' },
  { id: 'agent', label: 'Copy for the agent', keys: '', group: 'manuscript', accent: true },
];
const GROUPS = [['text', 'Text'], ['align', 'Alignment'], ['paragraph', 'Paragraph'], ['table', 'Table'], ['manuscript', 'Manuscript']];
const PINNED = ['bold', 'italic', 'underline', 'align-left', 'align-centre', 'align-right', 'bulleted', 'numbered', 'row-after', 'column-after', 'link', 'note', 'cut', 'agent'];

function readPins() {
  try {
    const kept = JSON.parse(localStorage.getItem('manuscript.bar') ?? 'null');
    if (Array.isArray(kept?.pinned)) return kept.pinned.filter(id => TOOLS.some(t => t.id === id));
  } catch { /* nothing kept: the bar as it comes */ }
  return [...PINNED];
}
function pin(id, on, keyboard) {
  state.pins = [...state.pins.filter(x => x !== id), ...(on ? [id] : [])];
  try { localStorage.setItem('manuscript.bar', JSON.stringify({ pinned: state.pins })); } catch { /* kept for this session */ }
  placeOverlays();
  // The bar was drawn again; the keyboard goes on from More rather than from nowhere.
  if (keyboard) $('more-tools')?.focus();
}

/**
 * The tools that apply here: none of the text tools on a picture; in a table its own tools and
 * the marks, not the paragraph's; lists on paragraphs; alignment, roles, lists and tables only
 * where the file has their fields and kinds.
 */
function toolsFor(node) {
  const kind = node.type.name;
  return TOOLS.filter(t => {
    if (kind === 'picture') return t.group === 'manuscript';
    if (t.group === 'table') return kind === 'table';
    if (kind === 'table') return t.group === 'text' || t.group === 'manuscript';
    if (t.align) return state.aligns;
    if (t.role) return state.roles;
    if (t.list) return state.lists && kind === 'paragraph';
    if (t.step) return state.lists && kind === 'paragraph' && !!node.attrs.list;
    if (t.id === 'table') return state.tables;
    if (t.id === 'picture') return state.media;
    if (t.id === 'footnote') return state.footnotesOn && !state.readOnly;
    if (t.id === 'cut') return kind !== 'heading';
    return true;
  });
}

/** Whether a tool's setting holds where the selection is, or null for a tool that is an action. */
function toolOn(t) {
  if (t.mark) return sheet.editor.isActive(t.mark);
  if (t.id === 'weblink') return sheet.editor.isActive('link');
  if (t.align) { const a = sheet.alignHere(); return t.align === 'Left' ? a === null || a === 'Left' : a === t.align; }
  if (t.style) return sheet.styleHere() === t.style;
  if (t.role) return sheet.roleHere() === t.role;
  if (t.list) return sheet.listHere() === t.list;
  return null;
}

function runTool(t) {
  state.more = false;
  const editor = sheet.editor;
  if (t.mark) editor.chain().focus().toggleMark(t.mark).run();
  else if (t.id === 'clear') { editor.chain().focus().unsetAllMarks().run(); if (state.aligns && sheet.alignHere() !== null) sheet.setAlign(null); }
  // An alignment chosen again goes back to the layout's own.
  else if (t.align) sheet.setAlign(sheet.alignHere() === t.align ? null : t.align);
  else if (t.style) sheet.setStyle(t.style);
  else if (t.role) sheet.setRole(sheet.roleHere() === t.role ? null : t.role);
  else if (t.list) sheet.setList(sheet.listHere() === t.list ? null : t.list);
  else if (t.step) sheet.indent(t.step);
  else if (t.id === 'table') sheet.insertTable();
  else if (t.id === 'picture') choosePicture();
  else if (t.id === 'footnote') { const id = sheet.insertFootnote(); openPopover('footnote', { id, fresh: true }); }
  else if (t.id === 'weblink') openPopover('weblink', { href: sheet.linkHere() ?? '' });
  else if (t.command) editor.chain().focus()[t.command]().run();
  else if (t.id === 'link') openPopover('link');
  else if (t.id === 'note') openPopover('note');
  else if (t.id === 'cut') keepAsCutting().catch(fail);
  else if (t.id === 'agent') { if (state.assistant) openPopover('ask'); else copyReference(); }
  placeOverlays(); declare();
}

const ariaKeys = keys => /^Ctrl/.test(keys) ? keys.replace('Ctrl', 'Control') : null;
const hold = e => e.preventDefault();   // a press on a tool leaves the selection where it is

function toolButton(t, version) {
  const on = toolOn(t);
  const keys = t.id === 'agent' ? `${state.selected} · ${version}` : t.keys;
  return el('button', { type: 'button', class: `tool${t.accent ? ' accent' : ''}`, 'data-tool': t.id, 'aria-label': t.label,
    'aria-pressed': on === null ? null : String(on), 'aria-keyshortcuts': ariaKeys(t.keys),
    on: { mousedown: hold, click: () => runTool(t), contextmenu: e => { e.preventDefault(); pin(t.id, false, e.button !== 2); } } },
  svg(t.id), el('span', { class: 'tip', role: 'tooltip' }, el('span', { text: t.label }), keys ? el('kbd', { text: keys }) : null));
}

function moreMenu(rest, version) {
  const row = t => {
    const on = toolOn(t), keys = t.id === 'agent' ? version : t.keys;
    return el('div', { class: 'more-row' },
      el('button', { type: 'button', class: 'more-tool', 'data-tool': t.id, 'aria-pressed': on === null ? null : String(on), 'aria-keyshortcuts': ariaKeys(t.keys),
        on: { mousedown: hold, click: () => runTool(t) } }, svg(t.id), el('span', { class: 'more-label', text: t.label }), keys ? el('kbd', { text: keys }) : null),
      el('button', { type: 'button', class: 'pin', 'data-pin': t.id, 'aria-label': `Pin ${t.label} to the bar`,
        on: { mousedown: hold, click: e => pin(t.id, true, e.detail === 0) } }, svg('pin')));
  };
  return el('div', { class: 'more', id: 'more-menu', role: 'group', 'aria-label': 'More tools' },
    GROUPS.flatMap(([group, name]) => { const tools = rest.filter(t => t.group === group); return tools.length ? [el('div', { class: 'more-head', text: name }), ...tools.map(row)] : []; }),
    el('p', { class: 'more-foot', text: 'Pin a tool to keep it on the bar. Right-click a tool on the bar to put it back here.' }));
}

/** Gutter marks beside paragraphs that carry notes or links, and the bar over the selected one. */
function placeOverlays() {
  const layer = $('overlays');
  if (!layer || state.root === null) return;
  const origin = $('page').getBoundingClientRect();
  const { notes, links } = counts();
  const marks = [];
  // Beside a paragraph with notes or links, how many of each, each by its own icon; pressed, the
  // side panel shows them: its notes when it has any, else what it is linked to. Only the
  // paragraphs on screen, and a screen either side: scrolling draws the margin again.
  const { doc } = sheet.editor.state, view = sheet.editor.view;
  const screen = $('scroller').getBoundingClientRect(), text = view.dom.getBoundingClientRect();
  const first = view.posAtCoords({ left: text.left + 4, top: Math.max(text.top + 1, screen.top - screen.height) });
  let index = 0, start = 0;
  if (first) { const $first = doc.resolve(first.pos); index = $first.index(0); for (let i = 0; i < index; i++) start += doc.child(i).nodeSize; }
  for (let offset = start; index < doc.childCount; index++) {
    const node = doc.child(index), at = offset;
    offset += node.nodeSize;
    const id = node.attrs.blockId, nc = notes.get(id) ?? 0, lc = links.get(id) ?? 0;
    if (!nc && !lc) continue;
    const dom = view.nodeDOM(at);
    if (!dom?.getBoundingClientRect) continue;
    const rect = dom.getBoundingClientRect();
    if (rect.top > screen.bottom + screen.height) break;
    const top = rect.top - origin.top;
    const said = [nc ? `${nc} note${nc === 1 ? '' : 's'}` : '', lc ? `${lc} link${lc === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
    marks.push(el('button', { type: 'button', class: `mark${id === state.selected ? ' on' : ''}`, style: `top:${top + 6}px`, 'data-id': id, 'data-notes': String(nc), 'data-links': String(lc),
      'aria-label': `${said} on this paragraph: show ${nc ? 'its notes' : 'what it is linked to'}`, title: `${said}: show ${nc ? 'them' : 'it'}`,
      on: { mousedown: e => e.preventDefault(), click: () => { sheet.focusBlock(id); state.selected = id; state.notesOf = nc ? id : null; state.drawer = nc ? 'notes' : 'related'; render(); declare(); } } },
    nc ? [svg('note'), el('span', { text: String(nc) })] : null, lc ? [svg('link'), el('span', { text: String(lc) })] : null));
  }
  const where = sheet.where();
  const show = !state.readOnly && state.selected && sheet.locate(state.selected) && (state.pinned || state.popover || (where && !where.empty && where.single && where.id === state.selected));
  // Beside the block under the pointer, faintly: a plus that adds a block below it and a grip
  // that opens the block's menu. Nothing is drawn
  // for a block the pointer is not over, so the writing stands alone.
  const gutterId = state.readOnly ? null : state.blockMenu?.id ?? state.hover;
  const gutterAt = gutterId ? sheet.locate(gutterId) : null;
  let menuBox = null;
  if (gutterAt?.dom?.getBoundingClientRect && TYPES_AT_TOP.has(gutterAt.node.type.name)) {
    const top = gutterAt.dom.getBoundingClientRect().top - origin.top;
    const kind = state.blockMenu?.kind;
    marks.push(el('span', { class: 'gutter', style: `top:${top + 2}px`, 'data-for': gutterId },
      el('button', { type: 'button', class: `gut add${kind === 'add' ? ' open' : ''}`, 'aria-label': 'Add a block below', 'aria-expanded': String(kind === 'add'),
        on: { mousedown: hold, click: () => toggleBlockMenu(gutterId, 'add') } }, svg('add'), el('span', { class: 'tip', role: 'tooltip' }, el('span', { text: 'Add a block below' }))),
      el('button', { type: 'button', class: `gut grip${kind === 'block' ? ' open' : ''}`, 'aria-label': 'This block\u2019s tools', 'aria-expanded': String(kind === 'block'),
        on: { mousedown: hold, click: () => toggleBlockMenu(gutterId, 'block') } }, svg('grip'), el('span', { class: 'tip', role: 'tooltip' }, el('span', { text: 'Click for this block\u2019s tools' })))));
    if (kind) { menuBox = kind === 'add' ? addMenu(gutterAt.node) : blockMenu(gutterAt.node); menuBox.style.top = `${top + 32}px`; }
  }
  let bar = null, pop = null, more = null, anchorTop = 0;
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
    anchorTop = top;
    const b = block(state.selected), version = b ? `v${b.version}` : 'not saved yet';
    const here = toolsFor(at.node);
    const rest = here.filter(t => !state.pins.includes(t.id));
    const items = [];
    for (const [group] of GROUPS) {
      const tools = here.filter(t => t.group === group && state.pins.includes(t.id));
      if (!tools.length) continue;
      if (items.length) items.push(el('span', { class: 'divider' }));
      items.push(...tools.map(t => toolButton(t, version)));
    }
    if (rest.length) {
      if (items.length) items.push(el('span', { class: 'divider' }));
      items.push(el('button', { type: 'button', class: `tool${state.more ? ' open' : ''}`, id: 'more-tools', 'aria-label': 'More tools', 'aria-expanded': String(state.more), 'aria-controls': 'more-menu',
        on: { mousedown: hold, click: () => { state.more = !state.more; placeOverlays(); } } }, svg('more'), el('span', { class: 'tip', role: 'tooltip' }, el('span', { text: 'More tools' }))));
    } else state.more = false;
    bar = el('div', { class: 'bar', role: 'toolbar', 'aria-label': 'This paragraph', 'data-centre': String(centre) }, items);
    if (state.more) more = moreMenu(rest, version);
    // The box is built once and only moved after: a redraw while the person types into it (a
    // save finishing, somebody else's change) must not take their words or their focus.
    if (state.popover) { pop = state.popoverEl ??= popover(bottom + 8); pop.style.top = `${bottom + 8}px`; }
  }
  layer.replaceChildren(...marks, ...(menuBox ? [menuBox] : []), ...(bar ? [bar] : []), ...(more ? [more] : []));
  if (menuBox) {
    // Kept inside the window: above the block's line when there is no room below it.
    const box = menuBox.getBoundingClientRect();
    if (box.bottom > innerHeight - 8 && box.top - box.height - 40 > 0) menuBox.style.top = `${parseFloat(menuBox.style.top) - box.height - 38}px`;
  }
  const popLayer = $('popover-layer');
  if (pop ? popLayer.firstChild !== pop : popLayer.firstChild) popLayer.replaceChildren(...(pop ? [pop] : []));
  if (!bar) return;
  // The bar sits just above the words, as tall as it has wrapped; its tooltips drop below it when
  // there is no room above. Centred on its anchor, kept inside the page.
  const barTop = Math.max(0, anchorTop - bar.offsetHeight - 10);
  bar.style.top = `${barTop}px`;
  bar.classList.toggle('tips-below', barTop < 40);
  const width = $('page').clientWidth, centre = Number(bar.dataset.centre);
  const place = (box, at) => { box.style.left = `${Math.max(8, Math.min(width - box.offsetWidth - 8, at - box.offsetWidth / 2))}px`; box.style.right = 'auto'; };
  place(bar, centre);
  if (pop) place(pop, centre);
  if (more) {
    // Under More, its right edge on the button's.
    const button = $('more-tools').getBoundingClientRect();
    place(more, button.right - origin.left - more.offsetWidth / 2);
    // Below the bar while it fits in the window; else above it when there is more room there,
    // scrolling inside itself when neither holds it all.
    const barBox = bar.getBoundingClientRect(), below = innerHeight - barBox.bottom - 14, above = barBox.top - 14;
    const up = more.offsetHeight > below && above > below;
    more.style.maxHeight = `${Math.max(120, Math.min(more.offsetHeight, up ? above : below))}px`;
    more.style.top = `${up ? barTop - more.offsetHeight - 6 : barTop + bar.offsetHeight + 6}px`;
  }
}

function fail(error) { state.problem = { text: refusalText(error), reload: true }; render(); }

function openPopover(kind, data = {}) { state.popover = { kind, ...data, query: '', linkKind: LINK_KINDS[0], noteKind: NOTE_KINDS[0] }; state.popoverEl = null; state.pinned = true; placeOverlays(); setTimeout(() => document.querySelector('.popover input, .popover textarea, .popover select')?.focus(), 0); }
function closePopover() { state.popover = null; state.popoverEl = null; state.pinned = false; state.more = false; state.blockMenu = null; }

// ---------- The block menu and the add menu ----------
const TYPES_AT_TOP = new Set(['paragraph', 'heading', 'picture', 'table']);

/** The top-level block under the pointer's height, by its ID, or null. */
function blockAt(y) {
  for (const child of sheet.editor.view.dom.children) {
    const r = child.getBoundingClientRect();
    if (y < r.top - 6 || y > r.bottom + 6) continue;
    return child.dataset.block || child.querySelector(':scope > table[data-block], :scope table[data-block]')?.dataset.block || null;
  }
  return null;
}

function toggleBlockMenu(id, kind) {
  if (state.blockMenu?.id === id && state.blockMenu.kind === kind) { state.blockMenu = null; placeOverlays(); return; }
  closePopover();
  // The menu acts on its block: the caret goes there unless it already is.
  if (sheet.where()?.id !== id) sheet.focusBlock(id);
  state.selected = id; state.blockMenu = { id, kind };
  render();
}

function closeBlockMenu() { if (!state.blockMenu) return; state.blockMenu = null; placeOverlays(); }

function menuItem({ label, icon, checked = null, keys = '', role = 'menuitem', run }) {
  return el('button', { type: 'button', class: `block-item${checked ? ' on' : ''}`, role, 'aria-checked': checked === null ? null : String(checked),
    on: { mousedown: hold, click: () => { state.blockMenu = null; run(); placeOverlays(); declare(); } } },
  svg(icon), el('span', { class: 'block-label', text: label }), keys ? el('kbd', { text: keys }) : null);
}

/** What a block can become, how it is set, and what can be done with it. */
function blockMenu(node) {
  const id = node.attrs.blockId, kind = node.type.name, sections = [];
  const section = (name, ...items) => { const real = items.flat().filter(Boolean); if (real.length) sections.push(el('div', { class: 'block-head', text: name }), ...real); };
  if (kind === 'paragraph' || kind === 'heading') {
    const list = kind === 'paragraph' ? node.attrs.list : null, style = sheet.styleHere();
    const turn = (label, icon, keys, target, isOn) => menuItem({ label, icon, keys, role: 'menuitemradio', checked: isOn, run: () => turnInto(target) });
    section('Turn into',
      turn('Paragraph', 'paragraph', '', 'Paragraph', !list && style === 'Paragraph'),
      turn('Part heading', 'part', '#', 'Part', style === 'Part'),
      turn('Chapter heading', 'chapter', '##', 'Chapter', style === 'Chapter'),
      turn('Section heading', 'section', '###', 'Section', style === 'Section'),
      state.lists && turn('Bulleted list', 'bulleted', '- ', 'Bulleted', list === 'Bulleted'),
      state.lists && turn('Numbered list', 'numbered', '1. ', 'Numbered', list === 'Numbered'),
      state.roles && menuItem({ label: 'Quotation', icon: 'quotation', role: 'menuitemcheckbox', checked: sheet.roleHere() === 'Quotation', run: () => runTool(TOOLS.find(t => t.id === 'quotation')) }),
      list && menuItem({ label: 'Indent list item', icon: 'indent', keys: 'Tab', run: () => sheet.indent(1) }),
      list && menuItem({ label: 'Outdent list item', icon: 'outdent', keys: 'Shift+Tab', run: () => sheet.indent(-1) }));
    if (state.aligns) {
      const row = el('div', { class: 'block-icons', role: 'group', 'aria-label': 'Align' },
        TOOLS.filter(t => t.align).map(t => {
          const on = toolOn(t);
          return el('button', { type: 'button', class: `tool${on ? ' on' : ''}`, 'aria-label': t.label, 'aria-pressed': String(on),
            on: { mousedown: hold, click: () => { state.blockMenu = null; runTool(t); } } }, svg(t.id), el('span', { class: 'tip', role: 'tooltip' }, el('span', { text: t.label }), el('kbd', { text: t.keys })));
        }));
      section('Align', row);
    }
  }
  if (kind === 'picture') {
    section('Picture',
      menuItem({ label: 'Describe picture', icon: 'describe', run: () => openPopover('describe', { id, alt: node.attrs.alt ?? '' }) }),
      state.roles && menuItem({ label: 'Add a caption below', icon: 'caption', run: () => { sheet.insertAfter(id, 'Paragraph'); sheet.setRole('Caption'); } }));
  }
  if (kind === 'table') {
    section('Table',
      menuItem({ label: 'Add a row at the end', icon: 'row-after', run: () => sheet.tableAction(id, 'addRowAfter') }),
      menuItem({ label: 'Add a column at the right', icon: 'column-after', run: () => sheet.tableAction(id, 'addColumnAfter') }),
      menuItem({ label: 'Delete table', icon: 'table-delete', run: () => sheet.tableAction(id, 'deleteTable') }));
  }
  section('Move',
    menuItem({ label: 'Move up', icon: 'move-up', keys: 'Alt+Shift+↑', run: () => sheet.move(-1) }),
    menuItem({ label: 'Move down', icon: 'move-down', keys: 'Alt+Shift+↓', run: () => sheet.move(1) }));
  section('Manuscript',
    menuItem({ label: 'Link to a passage', icon: 'link', run: () => runTool(TOOLS.find(t => t.id === 'link')) }),
    menuItem({ label: 'Add a note', icon: 'note', run: () => runTool(TOOLS.find(t => t.id === 'note')) }),
    kind !== 'heading' && menuItem({ label: 'Keep as cutting', icon: 'cut', run: () => runTool(TOOLS.find(t => t.id === 'cut')) }),
    menuItem({ label: TOOLS.find(t => t.id === 'agent').label, icon: 'agent', keys: block(id) ? `v${block(id).version}` : '', run: () => runTool(TOOLS.find(t => t.id === 'agent')) }));
  return el('div', { class: 'block-menu', role: 'menu', 'aria-label': 'This block' }, sections);
}

/** A paragraph, a heading of a kind, or a list item of a kind: the one the block becomes. */
function turnInto(target) {
  if (target === 'Bulleted' || target === 'Numbered') {
    if (sheet.styleHere() !== 'Paragraph') sheet.setStyle('Paragraph');
    sheet.setList(target);
  } else {
    if (sheet.listHere()) sheet.setList(null);
    sheet.setStyle(target);
  }
}

/** What can be added below a block. */
function addMenu(node) {
  const id = node.attrs.blockId;
  const add = (label, icon, keys, kind) => menuItem({ label, icon, keys, run: () => sheet.insertAfter(id, kind) });
  return el('div', { class: 'block-menu', role: 'menu', 'aria-label': 'Add below' },
    el('div', { class: 'block-head', text: 'Add below' }),
    [add('Paragraph', 'paragraph', '', 'Paragraph'),
      state.lists && add('Bulleted list', 'bulleted', '- ', 'Bulleted'),
      state.lists && add('Numbered list', 'numbered', '1. ', 'Numbered'),
      state.tables && add('Table', 'table', '', 'Table'),
      state.media && menuItem({ label: 'Picture', icon: 'picture', run: () => { sheet.focusBlock(id); choosePicture(); } }),
      add('Section heading', 'section', '###', 'Section'),
      add('Chapter heading', 'chapter', '##', 'Chapter')].filter(Boolean));
}

/**
 * Ask the agent: what to ask, what it may do (notes only, the text, or nothing), and then the
 * answer. The agent's steps and permission requests stay in its own conversation.
 */
function askPopover(p, top, close) {
  const about = state.selected && sheet.locate(state.selected)?.node.type.name === 'heading' ? 'this section' : 'this paragraph';
  const ask = p.ask;
  if (ask && ask.state === 'asking') {
    return el('div', { class: 'popover ask', style: `top:${top}px`, 'aria-live': 'polite' },
      el('strong', { text: 'Asking the agent…' }),
      el('p', { class: 'muted', text: 'Its steps and anything it asks permission for are in its conversation in Nendo. You can close this and go on writing; the answer comes as a notice.' }),
      el('div', { class: 'row end' },
        el('button', { type: 'button', class: 'quiet', text: 'Stop', on: { click: () => nendo.assistant.cancel().catch(() => {}) } }),
        el('button', { type: 'button', class: 'primary', text: 'Close', on: { click: () => { closePopover(); placeOverlays(); sheet.editor.commands.focus(); } } })));
  }
  if (ask) {
    const words = ask.state === 'refused' ? ask.error : (ask.reply.trim() || 'The agent said nothing.');
    const stopped = ask.state === 'answered' && ask.stopReason !== 'end_turn'
      ? el('p', { class: 'muted', text: ask.stopReason === 'cancelled' ? 'Stopped before it finished.' : ask.stopReason === 'ended' ? 'The conversation ended before it finished.' : `It stopped early (${ask.stopReason}).` }) : null;
    const notes = ask.state === 'answered' && ask.mode === 'notes'
      ? el('button', { type: 'button', class: 'quiet', text: 'Show notes', on: { click: () => { closePopover(); state.drawer = 'notes'; state.notesOf = ask.heading === null ? ask.id : null; render(); declare(); } } }) : null;
    return el('div', { class: 'popover ask', style: `top:${top}px`, 'aria-live': 'polite' },
      el('strong', { text: ask.state === 'refused' ? 'Not asked' : 'The agent answered' }),
      el('div', { class: 'ask-reply' }, ...words.split(/\n{2,}/).map(part => el('p', { text: part }))), stopped,
      el('div', { class: 'row end' }, notes,
        el('button', { type: 'button', class: 'quiet', text: 'Ask again', on: { click: () => { state.popover = { ...state.popover, ask: null }; redrawPopover(); } } }),
        el('button', { type: 'button', class: 'primary', text: 'Done', on: { click: () => { closePopover(); placeOverlays(); sheet.editor.commands.focus(); } } })));
  }
  const request = el('textarea', { id: 'ask-text', rows: '3', 'aria-label': 'What to ask the agent', placeholder: `What should the agent do with ${about}? For example: tighten it, check the facts, suggest a better opening.` });
  const mode = el('select', { id: 'ask-mode', 'aria-label': 'What the agent may do' }, ASK_MODES.map(m => el('option', { value: m.id, text: m.label })));
  const copy = el('button', { type: 'button', class: 'quiet', text: 'Copy reference', on: { click: () => copyReference() } });
  request.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.target.form.requestSubmit(); } });
  return el('form', { class: 'popover ask', style: `top:${top}px`, on: { submit: e => { e.preventDefault(); askAgent(request.value, mode.value).catch(fail); } } },
    el('div', { class: 'row' }, el('strong', { text: `Ask the agent about ${about}` }), mode), request,
    el('p', { class: 'muted', text: 'Notes only leaves your text as it is: each suggestion becomes a note in the margin.' }),
    el('div', { class: 'row end' }, copy, close, el('button', { type: 'submit', class: 'primary', text: 'Ask' })));
}

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
  if (p.kind === 'weblink') {
    const input = el('input', { id: 'weblink-href', type: 'text', inputmode: 'url', value: p.href ?? '', placeholder: 'https://…', 'aria-label': 'Web address', autocomplete: 'off' });
    const remove = p.href ? el('button', { type: 'button', class: 'quiet', text: 'Remove link', on: { click: () => { sheet.unsetLink(); closePopover(); placeOverlays(); declare(); } } }) : null;
    return el('form', { class: 'popover', style: `top:${top}px`, on: { submit: e => {
      e.preventDefault();
      const href = webAddress(input.value);
      if (!href) { input.setCustomValidity('A web address, such as example.org or https://example.org, or mailto: and an email address.'); input.reportValidity(); return; }
      sheet.setLink(href); closePopover(); placeOverlays(); declare();
    } } },
    el('strong', { text: p.href ? 'Web link' : 'Link to a web page' }), input,
    el('div', { class: 'row end' }, remove, close, el('button', { type: 'submit', class: 'primary', text: p.href ? 'Change' : 'Link' })));
  }
  if (p.kind === 'footnote') {
    const n = sheet.footnoteRefs().findIndex(r => r.id === p.id) + 1;
    const text = el('textarea', { id: 'footnote-text', rows: '3', 'aria-label': `Footnote ${n}`, placeholder: 'What the footnote says' });
    text.value = footnoteText(p.id);
    text.addEventListener('input', () => { state.footnoteTexts.set(p.id, text.value); edited(); });
    const done = () => { closePopover(); placeOverlays(); sheet.editor.commands.focus(); };
    text.addEventListener('keydown', e => { if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); done(); } });
    return el('div', { class: 'popover', style: `top:${top}px` }, el('strong', { text: `Footnote ${n || ''}`.trim() }), text,
      el('p', { class: 'muted', text: 'Saved as you type. Delete its number in the text to remove it.' }),
      el('div', { class: 'row end' }, el('button', { type: 'button', class: 'primary', text: 'Done', on: { click: done } })));
  }
  if (p.kind === 'describe') {
    const input = el('input', { id: 'picture-alt', type: 'text', value: p.alt ?? '', 'aria-label': 'What the picture shows', autocomplete: 'off' });
    return el('form', { class: 'popover', style: `top:${top}px`, on: { submit: e => { e.preventDefault(); sheet.describePicture(p.id, input.value.trim()); closePopover(); placeOverlays(); } } },
      el('strong', { text: 'What the picture shows' }), input,
      el('p', { class: 'muted', text: 'Shown under the picture, and read out for anyone who cannot see it. An export uses it as the picture’s description.' }),
      el('div', { class: 'row end' }, close, el('button', { type: 'submit', class: 'primary', text: 'Save' })));
  }
  if (p.kind === 'ask') return askPopover(p, top, close);
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

/**
 * Puts the side panel away: Nendo's toolbar is told, so its toggle is no longer pressed, and the
 * keyboard goes back to the writing when it was in the panel, rather than to nowhere.
 */
function closeDrawer() {
  if (state.drawer === null) return;
  const hadFocus = $('drawer').contains(document.activeElement);
  state.drawer = null;
  render(); declare();
  if (hadFocus) sheet.editor.commands.focus();
}

function renderDrawer() {
  const drawer = $('drawer');
  drawer.hidden = state.drawer === null;
  document.documentElement.dataset.drawer = state.drawer ?? '';
  if (state.drawer === null) return;
  const title = { outline: 'Outline', notes: 'Notes', related: 'Related passages', find: 'Find and replace', cuttings: 'Cuttings', links: 'Links', pagesetup: 'Page setup' }[state.drawer];
  const body = [];
  if (state.drawer === 'find') {
    body.push(findPanel());
    if (find.doc !== sheet.editor.state.doc) { clearTimeout(find.timer); find.timer = setTimeout(refreshFind, 250); }
  }
  if (state.drawer === 'outline') {
    // Each heading's section can be moved past its neighbour of the same level, by its arrows, by
    // Alt+Shift+Up or Down on the row, or dragged onto another heading: the same blocks, moved.
    const move = (id, step) => { if (sheet.moveSection(id, step)) render(); };
    sheet.editor.state.doc.forEach(node => {
      if (node.type.name !== 'heading') return;
      const id = node.attrs.blockId, name = node.textContent || 'Untitled';
      const row = el('div', { class: `outline-row level-${node.attrs.level}`, 'data-id': id, draggable: state.readOnly ? 'false' : 'true',
        on: {
          dragstart: e => { e.dataTransfer.setData('text/x-manuscript-section', id); e.dataTransfer.effectAllowed = 'move'; },
          dragover: e => { if (!e.dataTransfer.types.includes('text/x-manuscript-section')) return; e.preventDefault(); const r = e.currentTarget.getBoundingClientRect(); e.currentTarget.dataset.drop = e.clientY < r.top + r.height / 2 ? 'before' : 'after'; },
          dragleave: e => { delete e.currentTarget.dataset.drop; },
          drop: e => {
            e.preventDefault();
            const moving = e.dataTransfer.getData('text/x-manuscript-section'), before = e.currentTarget.dataset.drop !== 'after';
            delete e.currentTarget.dataset.drop;
            if (moving && sheet.moveSectionTo(moving, id, before)) { state.outlineFocus = moving; render(); }
          },
        } },
        el('button', { type: 'button', class: `outline level-${node.attrs.level}`, title: 'Go to it. Alt+Shift+Up or Down moves it; or drag it onto another heading.',
          on: { click: () => sheet.focusBlock(id), keydown: e => { if (e.altKey && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); move(id, e.key === 'ArrowUp' ? -1 : 1); } } } }, name),
        state.readOnly ? null : el('button', { type: 'button', class: 'quiet outline-move', 'aria-label': `Move ${name} up`, text: '↑', on: { click: () => move(id, -1) } }),
        state.readOnly ? null : el('button', { type: 'button', class: 'quiet outline-move', 'aria-label': `Move ${name} down`, text: '↓', on: { click: () => move(id, 1) } }));
      body.push(row);
    });
    if (!body.length) body.push(el('p', { class: 'muted', text: 'No headings yet. Make a line a Part, Chapter or Section with Style, or start it with #, ## or ###.' }));
  }
  if (state.drawer === 'links') body.push(...linksPanel());
  if (state.drawer === 'pagesetup') body.push(...pageSetupPanel());
  if (state.drawer === 'cuttings') {
    // What was kept out of the manuscript, in the order it was kept; put back after the
    // paragraph the caret is in, the same block with its notes and links.
    const kept = [...state.saved.values()].filter(b => b.parent === state.cuttings && state.cuttings !== null).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    body.push(el('p', { class: 'muted', text: kept.length ? 'Put back goes after the paragraph the caret is in.' : 'Nothing kept yet. Keep as cutting, or cutting a paragraph, puts it here.' }));
    for (const b of kept) {
      const notes = state.notes.filter(n => n.values[F.noteBlock] === b.id).length;
      body.push(el('div', { class: 'card', 'data-id': b.id },
        el('p', { text: b.kind === 'Table' ? 'A table' : preview(b.id, 160) }),
        notes ? el('p', { class: 'muted', text: `${notes} note${notes === 1 ? '' : 's'}` }) : null,
        state.readOnly ? null : el('div', { class: 'row end' },
          // Deleting for good asks once, on the button itself: a second press, not a dialog.
          el('button', { type: 'button', class: 'quiet', text: state.confirmCutting === b.id ? 'Delete for good' : 'Delete',
            on: { click: () => { if (state.confirmCutting !== b.id) { state.confirmCutting = b.id; render(); return; } state.confirmCutting = null; deleteCutting(b).catch(fail); } } }),
          el('button', { type: 'button', class: 'primary', text: 'Put back', on: { click: () => putBack(b) } }))));
    }
  }
  if (state.drawer === 'notes') {
    // From the toolbar, every note of this manuscript in reading order, each under the passage it
    // is on, which goes to it; from a paragraph's mark, that paragraph's notes.
    const mine = manuscriptNotes();
    const here = state.notesOf && block(state.notesOf) ? state.notesOf : null;
    const at = new Map();
    sheet.editor.state.doc.descendants((node, pos) => { if (node.attrs?.blockId && !at.has(node.attrs.blockId)) at.set(node.attrs.blockId, pos); });
    const place = n => at.get(n.values[F.noteBlock]) ?? Infinity;
    const list = here ? mine.filter(n => n.values[F.noteBlock] === here) : [...mine].sort((a, b) => place(a) - place(b));
    body.push(here
      ? el('div', { class: 'row' }, el('p', { class: 'muted', text: `On “${preview(here, 50)}”` }),
        el('button', { type: 'button', class: 'quiet', text: `All notes (${mine.length})`, on: { click: () => { state.notesOf = null; render(); } } }))
      : el('p', { class: 'muted', text: mine.length ? 'Every note in this manuscript, in reading order' : 'No notes in this manuscript yet. Select some text and choose Note.' }));
    for (const n of list) {
      const done = n.values[F.noteDone] === true, on = n.values[F.noteBlock];
      // A note on a footnote goes to the paragraph that cites it; one on a cutting has no place to go.
      const go = at.has(on) ? on : at.has(block(on)?.parent) ? block(on).parent : null;
      if (state.editingNote === n.recordId) { body.push(noteEditor(n)); continue; }
      body.push(el('div', { class: 'card', 'data-id': n.recordId },
        el('div', { class: 'row' }, el('span', { class: `chip ${String(n.values[F.noteKind]).toLowerCase()}`, text: n.values[F.noteKind] ?? 'Note' })),
        here ? null : go
          ? el('button', { type: 'button', class: 'passage', title: 'Go to this passage', on: { click: () => sheet.focusBlock(go) } }, preview(go, 120))
          : el('p', { class: 'muted', text: `In Cuttings: ${preview(on, 100)}` }),
        el('p', { class: done ? 'done' : '', text: n.values[F.noteText] ?? '' }),
        el('div', { class: 'row' },
          el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: done, on: { change: e => setNoteDone(n, e.target.checked).catch(fail) } }), 'Done'),
          state.readOnly ? null : el('span', {},
            el('button', { type: 'button', class: 'quiet', text: 'Edit', on: { click: () => { state.editingNote = n.recordId; state.noteDraft = { text: n.values[F.noteText] ?? '', kind: n.values[F.noteKind] ?? NOTE_KINDS[0] }; render(); $('note-edit')?.focus(); } } }),
            el('button', { type: 'button', class: 'quiet', text: 'Delete', on: { click: () => deleteRecord(n, 'Delete a note').catch(fail) } })))));
    }
    if (here && !list.length) body.push(el('p', { class: 'muted', text: 'No notes on this paragraph. Select some text and choose Note.' }));
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
        body.push(el('div', { class: 'card', 'data-id': l.recordId },
          el('div', { class: 'row' }, el('span', { class: 'kind', text: `${out ? '' : '← '}${l.values[F.linkKind] ?? 'Linked'}${out ? ' →' : ''}` }),
            review ? el('span', { class: 'chip issue', text: 'Needs review' }) : null),
          el('button', { type: 'button', class: 'passage', on: { click: () => sheet.focusBlock(other) } }, preview(other, 120)),
          review ? endChange(l, 'from') : null, review ? endChange(l, 'to') : null,
          el('div', { class: 'row end' }, el('button', { type: 'button', class: 'quiet', text: 'Remove link', on: { click: () => deleteRecord(l, 'Remove a link').catch(fail) } }),
            review && !state.readOnly ? el('button', { type: 'button', class: 'primary', text: 'Reviewed', on: { click: () => reviewed(l).catch(fail) } }) : null)));
      }
      if (!mine.length) body.push(el('p', { class: 'muted', text: 'Nothing linked yet. Select some text in it and choose Link.' }));
    }
  }
  drawer.setAttribute('aria-label', title);
  const close = el('button', { type: 'button', class: 'drawer-close', 'aria-label': `Close ${title}`, title: 'Close (Esc)', on: { click: closeDrawer } });
  close.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg>';
  // A note being edited keeps its words, its caret and the keyboard when the panel is drawn again,
  // and so does any control in a row or a card: the same one, found again by its record.
  const editing = document.activeElement?.id === 'note-edit' ? { start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd } : null;
  const holder = drawer.contains(document.activeElement) ? document.activeElement.closest('[data-id]') : null;
  const focused = holder ? { id: holder.dataset.id, index: [...holder.querySelectorAll('button, input, select, textarea')].indexOf(document.activeElement) } : null;
  // The find panel is kept, not drawn again, so typing in it is never interrupted.
  const kept = drawer.querySelector('.drawer-body');
  if (state.drawer === 'find' && kept?.firstChild === find.elements?.root && drawer.querySelector('.drawer-title')?.textContent === title) return;
  drawer.replaceChildren(el('div', { class: 'drawer-head' }, el('h2', { class: 'drawer-title', text: title }), close),
  el('div', { class: 'drawer-body' }, body));
  if (editing && $('note-edit')) { $('note-edit').focus(); $('note-edit').setSelectionRange(editing.start, editing.end); }
  else if (state.outlineFocus) { drawer.querySelector(`.outline-row[data-id="${state.outlineFocus}"] .outline`)?.focus(); state.outlineFocus = null; }
  else if (focused && focused.index >= 0) drawer.querySelector(`[data-id="${focused.id}"]`)?.querySelectorAll('button, input, select, textarea')[focused.index]?.focus();
}

/**
 * The Links panel: the links whose ends changed since they were reviewed, in reading order, or a
 * thread: every passage at an end of one kind of link, or connected to the paragraph the caret is
 * in, in reading order, with its chapter, the gap since the one before, and its neighbours on
 * request. Reading only: a thread's passages are edited on the page.
 */
function linksPanel() {
  const order = new Map(sheet.read().map((n, i) => [n.id, i]));
  const at = id => order.get(id) ?? Infinity;
  const stale = state.links.filter(l => l.values[F.linkReview] === REVIEW.needsReview)
    .sort((a, b) => Math.min(at(a.values[F.linkFrom]), at(a.values[F.linkTo])) - Math.min(at(b.values[F.linkFrom]), at(b.values[F.linkTo])));
  const kinds = [...new Set(state.links.map(l => l.values[F.linkKind]).filter(Boolean))];
  const choose = el('select', { id: 'links-view', 'aria-label': 'Show', on: { change: e => { state.linksView = e.target.value; render(); } } },
    el('option', { value: 'review', text: `To review (${stale.length})`, selected: state.linksView === 'review' }),
    el('option', { value: 'here', text: 'Connected to this paragraph', selected: state.linksView === 'here' }),
    kinds.map(k => el('option', { value: `kind:${k}`, text: `Thread: ${k}`, selected: state.linksView === `kind:${k}` })));
  const out = [choose];
  if (state.linksView === 'review') {
    if (!stale.length) out.push(el('p', { class: 'muted', text: 'Nothing to review. A link is listed here when the words at either end change.' }));
    out.push(...stale.map(reviewCard));
    return out;
  }
  let passages;
  if (state.linksView === 'here') {
    // Everything reachable from the paragraph by links, either way round.
    const start = state.selected && block(state.selected) ? state.selected : null;
    if (!start) return [...out, el('p', { class: 'muted', text: 'Put the caret in a paragraph to follow its links.' })];
    const seen = new Set([start]), queue = [start];
    while (queue.length) {
      const id = queue.shift();
      for (const l of state.links) {
        const other = l.values[F.linkFrom] === id ? l.values[F.linkTo] : l.values[F.linkTo] === id ? l.values[F.linkFrom] : null;
        if (other && !seen.has(other)) { seen.add(other); queue.push(other); }
      }
    }
    passages = [...seen];
  } else {
    const kind = state.linksView.slice(5);
    passages = [...new Set(state.links.filter(l => l.values[F.linkKind] === kind).flatMap(l => [l.values[F.linkFrom], l.values[F.linkTo]]))];
  }
  passages = passages.filter(id => order.has(id)).sort((a, b) => at(a) - at(b));
  if (passages.length < 2) out.push(el('p', { class: 'muted', text: 'No thread here yet: link passages with Link to a passage.' }));
  const nodes = sheet.read();
  const chapterOf = index => { for (let i = index; i >= 0; i--) if (levelOf(nodes[i].kind)) return nodes[i].text || 'Untitled'; return null; };
  let previous = null;
  for (const id of passages) {
    const index = at(id), gap = previous === null ? null : index - previous - 1;
    const near = state.threadContext.has(id);
    out.push(el('div', { class: 'card thread', 'data-id': id },
      el('div', { class: 'row' }, el('span', { class: 'muted', text: [chapterOf(index), gap === null ? null : gap === 0 ? 'right after' : `${gap} block${gap === 1 ? '' : 's'} later`].filter(Boolean).join(' · ') }),
        el('button', { type: 'button', class: 'quiet', 'aria-pressed': String(near), text: near ? 'Less' : 'Context', on: { click: () => { if (near) state.threadContext.delete(id); else state.threadContext.add(id); render(); } } })),
      near && index > 0 ? el('p', { class: 'muted context', text: preview(nodes[index - 1].id, 160) }) : null,
      el('button', { type: 'button', class: 'passage', on: { click: () => sheet.focusBlock(id) } }, preview(id, 160)),
      near && index + 1 < nodes.length ? el('p', { class: 'muted context', text: preview(nodes[index + 1].id, 160) }) : null));
    previous = index;
  }
  return out;
}

// ---------- Page setup ----------
// An output profile is one layout's settings for this manuscript, kept in the file: a page size,
// margins, a typeface and its size, line spacing and page numbers over the layout's own. The Word
// export and the preview both use it.

const LAYOUT_OF = { Book: 'book', Paper: 'paper', Manuscript: 'manuscript' };

function profileRecord(layoutName) {
  const choice = Object.keys(LAYOUT_OF).find(k => LAYOUT_OF[k] === layoutName) ?? layoutName;
  return state.profiles.find(p => p.values[F.profileRoot] === state.root && p.values[F.profileLayout] === choice) ?? null;
}

/** A layout's profile as the export takes it, or null. */
function profileOf(layoutName) {
  const r = profileRecord(layoutName);
  if (!r) return null;
  const v = r.values;
  return { page: v[F.profilePage] ?? null, margin: v[F.profileMargin] ?? null, font: v[F.profileFont] ?? null, size: v[F.profileSize] ?? null,
    spacing: v[F.profileSpacing] ?? null, numbers: typeof v[F.profileNumbers] === 'boolean' ? v[F.profileNumbers] : null };
}

/** The preview's page for a layout, with its profile over it: sizes in pixels, as a sheet is drawn. */
const LINE_HEIGHT = { 'Single': 1.2, '1.15': 1.35, '1.5': 1.75, 'Double': 2.3 };
function previewPage(layout) {
  const base = PAGES[layout], p = profileOf(layout);
  // The paper's sheet and type come from the article, its profile over it.
  if (layout === 'paper') return { ...base, ...paperSheet(article(p)), article: article(p), font: p?.font ? `'${p.font}', ${base.font}` : base.font };
  if (!p) return base;
  const page = { ...base }, twips = PAGE_TWIPS[p.page];
  if (twips) { page.width = Math.round(twips[0] / 15); page.height = Math.round(twips[1] / 15); }
  if (p.margin > 0) page.margin = page.top = Math.round(p.margin * 56.693 / 15);
  if (p.font) page.font = `'${p.font}', ${base.font}`;
  if (p.size > 0) page.size = Math.round(p.size * 4 / 3 * 10) / 10;
  if (LINE_HEIGHT[p.spacing]) page.line = LINE_HEIGHT[p.spacing];
  page.style = `width:${page.width}px;height:${page.height}px;padding:${page.top}px ${page.margin}px;font:${page.size}px/${page.line} ${page.font}`;
  return page;
}

/** Whether a typeface is on this computer: a line set in it is not the width of a fallback's. */
function fontInstalled(name) {
  const canvas = fontInstalled.canvas ??= document.createElement('canvas'), context = canvas.getContext('2d'), sample = 'mmmmmmmmmlliWW@#0';
  return ['monospace', 'serif', 'sans-serif'].some(fallback => {
    context.font = `72px ${fallback}`; const plain = context.measureText(sample).width;
    context.font = `72px '${name}', ${fallback}`; return context.measureText(sample).width !== plain;
  });
}
window.manuscriptFontInstalled = fontInstalled;

async function saveProfile(choice, values) {
  const record = state.profiles.find(p => p.values[F.profileRoot] === state.root && p.values[F.profileLayout] === choice);
  if (record) await send([{ op: 'update', entityId: PROFILE, recordId: record.recordId, version: record.version, values, refs: {} }], 'Page setup');
  else await send([{ op: 'create', entityId: PROFILE, recordId: `p-${freshId().slice(2)}`, values: { [F.profileRoot]: state.root, [F.profileLayout]: choice, ...values }, refs: { [F.profileRoot]: state.root } }], 'Page setup');
  if (state.mode !== 'write') renderPreview(); else render();
}

async function resetProfile(choice) {
  const record = state.profiles.find(p => p.values[F.profileRoot] === state.root && p.values[F.profileLayout] === choice);
  if (record) await send([{ op: 'delete', entityId: PROFILE, recordId: record.recordId, version: record.version }], 'Page setup');
  if (state.mode !== 'write') renderPreview(); else render();
}

function pageSetupPanel() {
  const choice = state.setupLayout ?? ({ book: 'Book', paper: 'Paper' }[state.mode] ?? 'Book');
  const record = state.profiles.find(p => p.values[F.profileRoot] === state.root && p.values[F.profileLayout] === choice);
  const v = record?.values ?? {};
  const own = 'The layout’s own';
  const select = (id, label, field, options, value) => el('label', { class: 'field' }, el('span', { text: label }),
    el('select', { id, disabled: state.readOnly || null, on: { change: e => saveProfile(choice, { [field]: e.target.value === '' ? null : field === F.profileSize ? Number(e.target.value) : e.target.value }).catch(fail) } },
      el('option', { value: '', text: own, selected: value === undefined || value === null }),
      options.map(o => el('option', { value: String(o), text: String(o), selected: String(value) === String(o) }))));
  const margin = el('input', { id: 'setup-margin', type: 'number', min: '5', max: '60', step: '1', value: v[F.profileMargin] ?? '', placeholder: own, disabled: state.readOnly || null,
    on: { change: e => saveProfile(choice, { [F.profileMargin]: e.target.value === '' ? null : Math.round(Number(e.target.value)) }).catch(fail) } });
  const numbers = el('input', { id: 'setup-numbers', type: 'checkbox', checked: v[F.profileNumbers] !== false, disabled: state.readOnly || null,
    on: { change: e => saveProfile(choice, { [F.profileNumbers]: e.target.checked }).catch(fail) } });
  const font = v[F.profileFont];
  const out = [
    el('label', { class: 'field' }, el('span', { text: 'Layout' }),
      el('select', { id: 'setup-layout', on: { change: e => { state.setupLayout = e.target.value; render(); } } }, OUTPUT_LAYOUTS.map(o => el('option', { value: o, text: o, selected: o === choice })))),
    select('setup-page', 'Page size', F.profilePage, PAGE_SIZES, v[F.profilePage]),
    el('label', { class: 'field' }, el('span', { text: 'Margins (mm)' }), margin),
    select('setup-font', 'Typeface', F.profileFont, FONTS, font),
    select('setup-size', 'Size (points)', F.profileSize, [9, 10, 11, 12, 13, 14, 16], v[F.profileSize]),
    select('setup-spacing', 'Line spacing', F.profileSpacing, SPACINGS, v[F.profileSpacing]),
    el('label', { class: 'check' }, numbers, 'Page numbers'),
  ];
  // Preflight: a typeface this computer does not have is set in a stand-in, here and in Word.
  if (font && !fontInstalled(font)) out.push(el('p', { class: 'warning', id: 'setup-font-missing', text: `${font} is not on this computer: the preview uses a stand-in, and Word will too wherever it is missing.` }));
  out.push(el('p', { class: 'muted', text: 'Kept with this manuscript in the file, for its Word export and its preview. Your writing appearance stays your own.' }));
  if (record && !state.readOnly) out.push(el('div', { class: 'row end' }, el('button', { type: 'button', class: 'quiet', text: 'Use the layout’s own', on: { click: () => resetProfile(choice).catch(fail) } })));
  return out;
}

/** A note's words and kind, edited where the note is. */
function noteEditor(note) {
  const draft = state.noteDraft;
  const kind = el('select', { 'aria-label': 'Kind of note', on: { change: e => { draft.kind = e.target.value; } } }, NOTE_KINDS.map(k => el('option', { value: k, text: k, selected: k === draft.kind })));
  const text = el('textarea', { id: 'note-edit', rows: '4', 'aria-label': 'Note', on: { input: e => { draft.text = e.target.value; } } });
  text.value = draft.text;
  const stop = () => { state.editingNote = null; state.noteDraft = null; render(); };
  return el('form', { class: 'card note-edit', 'data-id': note.recordId, on: { submit: e => { e.preventDefault(); saveNote(note, draft).catch(fail); },
    keydown: e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stop(); } } } },
    kind, text, el('div', { class: 'row end' }, el('button', { type: 'button', class: 'quiet', text: 'Cancel', on: { click: stop } }), el('button', { type: 'submit', class: 'primary', text: 'Save' })));
}

async function saveNote(note, draft) {
  const words = draft.text.trim();
  if (!words) return;
  const current = state.notes.find(n => n.recordId === note.recordId) ?? note;
  await send([{ op: 'update', entityId: NOTE, recordId: note.recordId, version: current.version, values: { [F.noteText]: words, [F.noteKind]: draft.kind }, refs: {} }], 'Edit a note');
  state.editingNote = null; state.noteDraft = null;
  render(); declare();
}

/** The blocks a cutting holds as the sheet reads them: itself, and a table's rows and cells. */
function cuttingNodes(block) {
  const nodes = [], children = id => [...state.saved.values()].filter(b => b.parent === id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const add = b => {
    nodes.push({ id: b.id, kind: b.kind, text: b.text, role: b.role, align: b.align, list: b.list, level: b.level });
    if (b.kind === 'Table' || b.kind === 'Row') children(b.id).forEach(add);
  };
  add(block);
  return nodes;
}

function putBack(block) {
  sheet.insertBlocks(cuttingNodes(block), state.selected && sheet.locate(state.selected) ? state.selected : null);
  toast('Put back in the manuscript.');
  render();
}

async function deleteCutting(block) {
  const ids = new Set(cuttingNodes(block).map(n => n.id));
  const writes = [
    ...state.notes.filter(n => ids.has(n.values[F.noteBlock])).map(n => ({ op: 'delete', entityId: NOTE, recordId: n.recordId, version: n.version })),
    ...state.links.filter(l => ids.has(l.values[F.linkFrom]) || ids.has(l.values[F.linkTo])).map(l => ({ op: 'delete', entityId: LINK, recordId: l.recordId, version: l.version })),
    ...[...ids].reverse().map(id => ({ op: 'delete', entityId: BLOCK, recordId: id, version: state.saved.get(id).version })),
  ];
  for (const batch of chunkWrites(writes)) await send(batch, 'Delete a cutting');
  render(); declare();
}

// ---------- Find and replace ----------
// Across the whole manuscript, the paragraphs off screen and the table cells included, and the
// Cuttings when asked. The run Find is on is drawn as found; the others are counted and listed.

const find = { query: '', matchCase: false, cuttings: false, at: -1, runs: [], kept: [], doc: null, timer: null, elements: null };
const FIND_LIST = 100;

function openFind(withReplace) {
  const { from, to, empty } = sheet.editor.state.selection;
  const picked = empty ? '' : sheet.editor.state.doc.textBetween(from, to, ' ');
  state.drawer = 'find';
  render(); declare();
  const e = find.elements;
  if (picked && picked.length <= 200 && !picked.includes('\n')) { e.query.value = picked; find.query = picked; find.at = -1; refreshFind(); }
  (withReplace && e.query.value ? e.replace : e.query).focus();
  (withReplace && e.query.value ? e.replace : e.query).select();
}

function findPanel() {
  if (find.elements) return find.elements.root;
  const query = el('input', { type: 'search', id: 'find-query', 'aria-label': 'Find', placeholder: 'Find in the manuscript', autocomplete: 'off', spellcheck: 'false' });
  const replace = el('input', { type: 'text', id: 'find-replace', 'aria-label': 'Replace with', placeholder: 'Replace with', autocomplete: 'off', spellcheck: 'false' });
  const matchCase = el('input', { type: 'checkbox', id: 'find-case' });
  const cuttings = el('input', { type: 'checkbox', id: 'find-cuttings' });
  const count = el('p', { class: 'muted', id: 'find-count', 'aria-live': 'polite' });
  const results = el('div', { class: 'results find-results', id: 'find-results' });
  const button = (text, run, primary = false) => el('button', { type: 'button', class: primary ? 'primary' : 'quiet', text, on: { click: () => run() } });
  query.addEventListener('input', () => { find.query = query.value; find.at = -1; clearTimeout(find.timer); find.timer = setTimeout(refreshFind, 120); });
  query.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); refreshFind(); stepFind(e.shiftKey ? -1 : 1); } });
  replace.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); replaceFound(false).catch(fail); } });
  matchCase.addEventListener('change', () => { find.matchCase = matchCase.checked; find.at = -1; refreshFind(); });
  cuttings.addEventListener('change', () => { find.cuttings = cuttings.checked; refreshFind(); });
  const root = el('div', { class: 'find' },
    query,
    el('div', { class: 'row' }, el('label', { class: 'check' }, matchCase, 'Match case'), el('label', { class: 'check' }, cuttings, 'Cuttings too')),
    el('div', { class: 'row end' }, button('Previous', () => stepFind(-1)), button('Next', () => stepFind(1))),
    replace,
    el('div', { class: 'row end' }, button('Replace', () => replaceFound(false).catch(fail)), button('Replace all', () => replaceFound(true).catch(fail), true)),
    count, results);
  find.elements = { root, query, replace, matchCase, cuttings, count, results };
  return root;
}

/** The cuttings of this manuscript whose words hold the query, as saved. */
function cuttingsFound() {
  if (!find.cuttings || !find.query || state.cuttings === null) return [];
  const pattern = findPattern();
  const under = id => { for (let p = state.saved.get(id)?.parent, d = 0; p && d < 64; p = state.saved.get(p)?.parent, d++) if (p === state.cuttings) return true; return false; };
  return [...state.saved.values()].filter(b => under(b.id) && b.text && (pattern.lastIndex = 0, pattern.test(b.text)));
}
const findPattern = () => new RegExp(find.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), find.matchCase ? 'gu' : 'giu');

function refreshFind() {
  clearTimeout(find.timer);
  const e = find.elements;
  if (!e) return;
  find.doc = sheet.editor.state.doc;
  find.runs = sheet.find(find.query, { matchCase: find.matchCase });
  find.kept = cuttingsFound();
  if (find.at >= find.runs.length) find.at = find.runs.length - 1;
  sheet.showFound(find.at >= 0 ? find.runs[find.at] : null);
  const n = find.runs.length, k = find.kept.length;
  e.count.textContent = !find.query ? 'Type a word or a phrase.'
    : `${n === 10000 ? 'At least 10,000' : n.toLocaleString()} in the manuscript${find.cuttings ? `, ${k.toLocaleString()} in Cuttings` : ''}${find.at >= 0 ? ` · on ${find.at + 1}` : ''}`;
  const doc = find.doc, items = [];
  // A block's ID, pasted as Copy for the agent copies it, goes straight to the block.
  const asked = /\bb-[0-9a-z][\w-]*/.exec(find.query)?.[0];
  if (asked && sheet.locate(asked)) items.push(el('button', { type: 'button', class: 'hit heading', on: { click: () => sheet.focusBlock(asked) } }, `Go to block ${asked}: ${preview(asked, 60)}`));
  find.runs.slice(0, FIND_LIST).forEach((run, i) => {
    const before = doc.textBetween(Math.max(0, run.from - 36), run.from, ' ', ' '), word = doc.textBetween(run.from, run.to, ' ', ' '), after = doc.textBetween(run.to, Math.min(doc.content.size, run.to + 36), ' ', ' ');
    items.push(el('button', { type: 'button', class: `hit${i === find.at ? ' on' : ''}`, 'aria-current': i === find.at ? 'true' : null, on: { click: () => { find.at = i; sheet.selectRange(run.from, run.to); refreshFind(); } } },
      `…${before.slice(-36)}`, el('mark', { text: word }), `${after.slice(0, 36)}…`));
  });
  if (n > FIND_LIST) items.push(el('p', { class: 'muted', text: `And ${(n - FIND_LIST).toLocaleString()} more: Next goes through them all.` }));
  for (const b of find.kept.slice(0, 20)) items.push(el('div', { class: 'hit kept' }, el('span', { class: 'chip', text: 'Cuttings' }), ` ${preview(b.id, 80)}`));
  e.results.replaceChildren(...items);
}

function stepFind(direction) {
  if (!find.runs.length) return;
  const n = find.runs.length;
  if (find.at < 0) {
    // From the caret: the first match after it, or before it going back.
    const caret = sheet.editor.state.selection.from;
    const next = find.runs.findIndex(r => r.from >= caret);
    find.at = direction > 0 ? (next < 0 ? 0 : next) : ((next < 0 ? n : next) - 1 + n) % n;
  } else find.at = (find.at + direction + n) % n;
  sheet.showFound(find.runs[find.at]);
  refreshFind();
}

/** Replaces the match Find is on, or every match; with Cuttings too, in the cuttings as saved. */
async function replaceFound(all) {
  refreshFind();
  const text = find.elements.replace.value;
  if (!find.query) return;
  if (!all) {
    if (find.at < 0) { stepFind(1); return; }
    sheet.replace([find.runs[find.at]], text);
    refreshFind();
    if (find.runs.length) { if (find.at >= find.runs.length) find.at = 0; sheet.showFound(find.runs[find.at]); refreshFind(); }
    return;
  }
  const n = find.runs.length, kept = find.kept;
  sheet.replace(find.runs, text);
  if (kept.length) {
    await flush();
    const pattern = findPattern();
    const writes = kept.map(b => ({ op: 'update', entityId: BLOCK, recordId: b.id, version: b.version, values: { [F.text]: b.text.replace(pattern, text.replace(/\$/g, '$$$$')) || null }, refs: {} }));
    for (const batch of chunkWrites(writes)) await send(batch, 'Replace in Cuttings');
  }
  find.at = -1;
  refreshFind();
  toast(`Replaced ${(n + kept.length).toLocaleString()}${n === 10000 ? ', the first 10,000 in the manuscript' : ''}.`);
}

/** A web address as typed, made whole: example.org is https://example.org. Null for anything that is not one. */
function webAddress(text) {
  const value = text.trim();
  if (!value) return null;
  const full = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  try { const url = new URL(full); return ['http:', 'https:', 'mailto:'].includes(url.protocol) && (url.protocol === 'mailto:' || url.hostname.includes('.')) ? full : null; } catch { return null; }
}

/** A picture from this computer, put in the file and on the page after the paragraph the caret is in. */
function choosePicture() {
  const input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp,image/avif,image/svg+xml', hidden: true });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    try {
      setStatus('Adding the picture…');
      const { address } = await nendo.media.put(file, { mediaType: file.type || undefined });
      sheet.insertPicture(address, file.name.replace(/\.[^.]+$/, ''));
    } catch (error) { fail(error); }
  }, { once: true });
  document.body.append(input);
  input.click();
}

// ---------- Start ----------

async function start(context) {
  state.readOnly = context.readOnly === true;
  state.chrome = nendo.has('ui.setToolbar');
  // The person's launched agent (ADR-0033): where Nendo lets a view message it, the agent tool asks
  // it; elsewhere it copies a reference to paste into the agent's tab.
  state.assistant = nendo.has('assistant.ask');
  TOOLS.find(t => t.id === 'agent').label = state.assistant ? 'Ask the agent' : 'Copy for the agent';
  // A file built before roles or alignment has no Role or Align field; their controls wait for one.
  try {
    const schema = await nendo.schema.describe();
    const field = id => (schema.entities ?? []).find(e => e.entityId === BLOCK)?.fields?.find(f => f.fieldId === id) ?? null;
    const has = id => field(id) !== null;
    // Tables need Table, Row and Cell among Kind's choices, which a file made before 0.10.0 lacks.
    const kinds = (field(F.kind)?.choices ?? []).filter(c => !c.retired).map(c => c.id ?? c);
    state.roles = has(F.role); state.aligns = has(F.align); state.lists = has(F.list) && has(F.level);
    state.tables = ['Table', 'Row', 'Cell'].every(kind => kinds.includes(kind));
    // A picture is added from this computer only where Nendo lets a view put media in the file.
    state.media = nendo.has?.('media.put') === true;
    // Footnotes where the file's Kind offers Footnote (Manuscript 0.17.0 adds it to an older file).
    state.footnotesOn = kinds.includes('Footnote');
    // A link keeps its ends' words where the file has the fields (Manuscript 0.18.0 adds them).
    state.linkSeen = (schema.entities ?? []).find(e => e.entityId === LINK)?.fields?.some(f => f.fieldId === F.linkFromSeen) ?? false;
    // Page setup where the file has the Output profiles type (Manuscript 0.19.0 adds it).
    state.profilesOn = (schema.entities ?? []).some(e => e.entityId === PROFILE);
  } catch { state.roles = false; state.aligns = false; state.lists = false; state.tables = false; }
  state.pins = readPins();
  if (nendo.has('settings.all')) {
    try { takeAppearance(await nendo.settings.all()); } catch { /* the defaults draw the page */ }
    nendo.on('settingsChanged', values => { takeAppearance(values); applyAppearance(); previewZoom(); declare(); });
  }
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
  addEventListener('resize', () => { placeOverlays(); previewZoom(); });
  $('scroller').addEventListener('scroll', () => { if (state.popover) return; placeOverlays(); }, { passive: true });
  addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    if (state.blockMenu) { closeBlockMenu(); sheet.editor.commands.focus(); return; }
    if (state.more) { state.more = false; placeOverlays(); sheet.editor.commands.focus(); return; }
    if (state.popover || state.pinned) { closePopover(); placeOverlays(); sheet.editor.commands.focus(); return; }
    // Escape inside the side panel puts it away, as it does any panel the person opened.
    if (state.drawer !== null && $('drawer').contains(document.activeElement)) { e.preventDefault(); closeDrawer(); }
  });
  addEventListener('pagehide', () => { if (pending()) save(); });
  // The gutter follows the pointer, block by block; while a block menu is open it stays put, so
  // the menu is not drawn again under the pointer on its way to an item.
  $('page').addEventListener('mousemove', e => {
    if (state.blockMenu || state.mode !== 'write') return;
    const id = blockAt(e.clientY);
    if (id !== state.hover) { state.hover = id; placeOverlays(); }
  }, { passive: true });
  $('page').addEventListener('mouseleave', () => { if (!state.blockMenu && state.hover) { state.hover = null; placeOverlays(); } });
  addEventListener('mousedown', e => { if (state.blockMenu && !e.target.closest?.('.block-menu, .gutter')) closeBlockMenu(); }, true);
  state.wanted = context.place?.manuscript ?? null;
  if (nendo.has('ui.setPlace')) nendo.on('place', place => { if (place?.manuscript) openManuscript(place.manuscript, false).catch(fail); });
  await load();
  placeHere(false);
  if (state.root !== null) await offerDraft();
  if (state.root !== null && !state.problem) {
    const first = sheet.read().find(n => n.kind === 'Paragraph');
    if (first) sheet.focusBlock(first.id);
  }
}

async function startManuscript() {
  if (state.root !== null) await flush();
  const root = `b-root-${freshId().slice(2, 8)}`, chapter = freshId(), paragraph = freshId(), cuttings = `b-cuttings-${freshId().slice(2, 8)}`;
  const last = Math.max(0, ...(state.manuscripts ?? []).map(m => m.order ?? 0));
  await nendo.records.batch([
    { op: 'create', entityId: BLOCK, recordId: root, values: { [F.kind]: 'Manuscript', [F.text]: 'Untitled manuscript', [F.order]: last + GAP } },
    { op: 'create', entityId: BLOCK, recordId: chapter, values: { [F.kind]: 'Chapter', [F.text]: 'Chapter one', [F.parent]: root, [F.order]: GAP } },
    { op: 'create', entityId: BLOCK, recordId: paragraph, values: { [F.kind]: 'Paragraph', [F.text]: null, [F.parent]: chapter, [F.order]: GAP } },
    { op: 'create', entityId: BLOCK, recordId: cuttings, values: { [F.kind]: 'Cuttings', [F.text]: 'Cuttings', [F.parent]: root, [F.order]: 1073741824 } },
  ], { label: 'Start a manuscript' });
  state.wanted = root;
  await load();
  sheet.focusBlock(paragraph);
}

// ---------- Several manuscripts in one file ----------

/** Tells Nendo which manuscript is open, so Back and Forward go between them. */
function placeHere(step) {
  if (!nendo.has?.('ui.setPlace') || state.root === null) return;
  const title = (state.title || 'Untitled manuscript').slice(0, 80);
  nendo.ui.setPlace({ manuscript: state.root }, { label: title, replace: !step }).catch(() => {});
}

/** Opens another manuscript of the file, after saving what is on the page. */
async function openManuscript(id, step = true) {
  if (id === state.root) return;
  await flush();
  state.wanted = id; state.placeStep = step;
  state.selected = null; state.pinned = false; closePopover();
  await load();
  await offerDraft();
}

nendo.ready.then(start).catch(error => {
  $('problem').hidden = false;
  $('problem').textContent = error?.code === 'not-framed' ? 'Open this view in Nendo.' : `The manuscript could not be read: ${error?.message ?? error}`;
});
