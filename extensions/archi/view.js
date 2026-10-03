// The Archi workbench (W-109, W-110): Archi's model tree, the open view drawn in the middle with
// archi-online's own figures (canvas.js), and the properties of what is selected, one selection
// shared by all three. Every rule lives in model.js; this file reads the file through
// window.nendo, draws, and sends the writes model.js plans.

import * as M from './model.js';

const nendo = window.nendo;
const $ = id => document.getElementById(id);
const escape = text => String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const describe = error => error?.message ?? String(error);
const LAYER_TONE = { Strategy: 'orange', Business: 'amber', Application: 'teal', Technology: 'green', Physical: 'green',
  Motivation: 'violet', 'Implementation & Migration': 'red', Other: 'grey', Relationship: 'grey' };
const FOLDER_TONE = { Strategy: 'orange', Business: 'amber', Application: 'teal', 'Technology & Physical': 'green',
  Motivation: 'violet', 'Implementation & Migration': 'red', Other: 'grey', Relations: 'grey', Views: 'blue' };
const tone = name => name ? `var(--nendo-tone-${name})` : '';
const READS = { models: M.E.model, folders: M.E.folder, types: M.E.type, concepts: M.E.concept,
  specializations: M.E.specialization, views: M.E.view, items: M.E.item, properties: M.E.property };

/*
 * The Appearance panel beside the view while editing (W-114) takes room from the drawing, so it
 * starts hidden; the Appearance toggle shows it, and this device remembers the choice.
 */
const APPEARANCE_KEY = 'archi-appearance';
function appearanceKept() { try { return localStorage.getItem(APPEARANCE_KEY) === 'shown'; } catch { return false; } }

const state = {
  model: null, selected: null, expanded: new Set(), modelOpen: true, filter: { text: '', layer: '' },
  nativeChrome: false, renaming: null, draftProperties: null, readOnly: false, loaded: false,
  sets: null, openView: null, diagramSelection: [], zoom: 1, editing: false, pending: 0, transparent: false, styleShown: appearanceKept(),
  validator: { open: false, issues: null, of: null, current: null },
};

// The canvas is archi-online's renderer, bundled; it loads beside the tree, not before it.
let canvasModule = null, canvas = null, drawnSets = null;
const canvasReady = import('./canvas.js').then(module => { canvasModule = module; }).catch(error => {
  setStatus(`The diagram could not load: ${describe(error)}`, true);
});

// ---------------------------------------------------------------- reading

async function readAll() {
  const entries = await Promise.all(Object.entries(READS).map(async ([key, entityId]) =>
    [key, await nendo.records.queryAll({ entityId }, { max: 50000 })]));
  const sets = Object.fromEntries(entries);
  state.sets = sets;
  state.model = M.buildModel(sets);
  if (state.openView && !state.model.records.has(state.openView)) state.openView = null;
  if (!state.loaded) {
    state.loaded = true;
    // Back or Forward, or a return to this screen, starts the workbench where it was.
    applyPlace(startPlace);
  }
  if (state.selected && !state.model.records.has(state.selected)) state.selected = modelRecord()?.recordId ?? null;
  render();
  startEmptyModel();
}

/**
 * A new Archi model (ADR-0022) keeps the concept types and the top-level folders and leaves the
 * Model record out with the rest of the work, so its tree would have no root. The workbench
 * starts an empty model there, once a session: a refusal is said and not retried on every read.
 */
let emptyModelTried = false;
function startEmptyModel() {
  if (emptyModelTried || state.readOnly || !state.model || modelRecord() !== null) return;
  emptyModelTried = true;
  write(() => modelRecord() !== null ? [] : [{
    op: 'create', entityId: M.E.model, recordId: `ar.model.r.${crypto.randomUUID()}`, values: { 'ar.model.name': 'New model' },
  }], 'Start a new model', { undoable: false });
}

let pendingRead = null;
function schedule() {
  clearTimeout(pendingRead);
  pendingRead = setTimeout(() => readAll().catch(error => setStatus(`The model could not be read. ${describe(error)}`, true)), 120);
}

const modelRecord = () => state.model?.of(M.E.model)[0] ?? null;

// ---------------------------------------------------------------- writing

/**
 * The writes one gesture makes. Where Nendo offers records.batch they are one revision, named
 * by the gesture; a larger gesture goes in batches of 200, and an older Nendo writes them one
 * by one, in the order planned, so nothing is written before what it points at.
 *
 * An atomic gesture, a Commit of the editor's waiting edits, is the exception (R30-001): its
 * later writes point at records its earlier writes create, and a second batch cannot name
 * their versions, so a Commit over 200 writes would save its first batch and have the rest
 * refused. With records.batch it is sent as one batch or, over 200, refused before anything
 * is written. The limit is a batch's, so an older Nendo's one-by-one path is not held to it.
 */
let writing = Promise.resolve();

/*
 * Undo and Redo of what the file has saved (W-112). Each gesture written as one batch leaves its
 * opposite, planned by model.js: Undo writes it as a new revision, version-checked, so a record
 * changed, deleted or used since refuses the whole undo and nothing is written. An undo leaves a
 * redo the same way. The steps are this visit's; a gesture over 200 writes, or one made by a Nendo
 * without records.batch, is not undoable here, because its writes were not one revision.
 */
const saved = { undo: [], redo: [] };
// The state each record the steps wrote is in now (model.js, undoStep): shared by the steps that
// expect it, so an undo that moves a record's version on is followed by every step kept.
const states = new Map();
const STEPS_KEPT = 50;
/**
 * One gesture's writes, after every earlier gesture and the reread it caused: `plan` is called
 * only then, so it plans from the records as they now stand. Planned at once, a second edit
 * made while the first was still being read back pointed at versions the first had moved on
 * (F-211).
 */
function write(plan, label, { atomic = false, undoable = true, history = null } = {}) {
  const run = writing.then(() => writeNow(plan, label, atomic, undoable, history));
  writing = run.catch(() => undefined);
  return run;
}

/**
 * Writes one gesture and reads the model back. `history` is set for an undo or a redo: {kind,
 * entry}, the step being taken. Answers whether the writes were saved.
 */
async function writeNow(plan, label, atomic, undoable, history) {
  let writes;
  const before = state.model;
  try { writes = typeof plan === 'function' ? plan() : plan; } catch (error) {
    setStatus(history ? `${label} was refused: ${describe(error)} Nothing was changed.` : describe(error), true);
    return false;
  }
  if (writes.length === 0) return false;
  if (state.readOnly) { setStatus('This file is open read-only.', true); return false; }
  const batched = nendo.has('records.batch');
  if (atomic && batched && writes.length > 200) {
    setStatus(`${label} was refused: This change needs ${writes.length} record writes; at most 200 can be saved together. Nothing was saved. Reduce the change and try again.`, true);
    return false;
  }
  let outcome = `${label}.`, problem = false;
  const answers = [];
  try {
    if (batched) {
      for (let start = 0; start < writes.length; start += 200) {
        const answer = await nendo.records.batch(writes.slice(start, start + 200).map(single => ({
          op: single.op, entityId: single.entityId, recordId: single.recordId,
          ...(single.version === undefined ? {} : { version: single.version }),
          ...(single.values === undefined ? {} : { values: single.values }),
          ...(single.targetVersions === undefined ? {} : { targetVersions: single.targetVersions }),
        })), { label: label.slice(0, 80) });
        answers.push(...(answer?.records ?? []));
      }
    } else {
      for (const single of writes) {
        const at = { entityId: single.entityId, recordId: single.recordId, version: single.version };
        if (single.op === 'create') await nendo.records.create(single.entityId, single.values, { recordId: single.recordId, targetVersions: single.targetVersions });
        else if (single.op === 'update') await nendo.records.update(at, single.values, { targetVersions: single.targetVersions });
        else await nendo.records.delete(at);
      }
    }
  } catch (error) {
    outcome = `${label} was refused: ${describe(error)}${history ? ' Nothing was changed.' : ''}`;
    problem = true;
  }
  if (!problem) remember(before, writes, answers, batched, label, undoable, history);
  // Said once the model is read back, so what the status line reports is what the view shows.
  await readAll().catch(error => { outcome = `The model could not be read. ${describe(error)}`; problem = true; });
  setStatus(outcome, problem);
  return !problem;
}

/** Keeps the opposite of what was just saved: a gesture's undo, an undo's redo, a redo's undo. */
function remember(before, writes, answers, batched, label, undoable, history) {
  const one = batched && writes.length <= 200 && answers.length === writes.length;
  let step = null;
  if (one && undoable) {
    try {
      step = history ? M.oppositeStep(before, history.entry.step, writes, answers, states) : M.undoStep(before, writes, answers, states);
    } catch { step = null; }
  }
  const entry = step ? { label: history?.entry.label ?? label, step } : null;
  if (history?.kind === 'undo') { if (entry) saved.redo.push(entry); return; }
  // A new gesture leaves nothing to redo; a redo leaves the rest of what can be redone.
  if (!history) saved.redo = [];
  if (entry) saved.undo.push(entry);
  if (saved.undo.length > STEPS_KEPT) saved.undo.shift();
}

/** What Undo and Redo would do now: the editor's waiting edit first, then what the file saved. */
function undoName() {
  if (editor?.canUndo()) return editor.undoLabel?.() || 'the last edit';
  return saved.undo.at(-1)?.label ?? null;
}
function redoName() {
  if (editor?.canRedo()) return editor.redoLabel?.() || 'the last edit';
  return saved.redo.at(-1)?.label ?? null;
}

function undoAny() {
  if (editor?.canUndo()) { editor.undo(); return; }
  const entry = saved.undo.pop();
  if (!entry) { setStatus('There is nothing to undo.', true); return; }
  declareToolbar();
  write(() => M.planStep(state.model, entry.step), `Undo ${entry.label}`, { atomic: true, history: { kind: 'undo', entry } });
}

function redoAny() {
  if (editor?.canRedo()) { editor.redo(); return; }
  const entry = saved.redo.pop();
  if (!entry) { setStatus('There is nothing to redo.', true); return; }
  declareToolbar();
  write(() => M.planStep(state.model, entry.step), `Redo ${entry.label}`, { atomic: true, history: { kind: 'redo', entry } });
}

// ---------------------------------------------------------------- the tree

function rows() {
  const model = state.model, root = modelRecord();
  if (!model || !root) return [];
  const head = { id: root.recordId, entityId: M.E.model, depth: 0, label: root.values['ar.model.name'] || '(model)',
    children: model.roots.length, expanded: state.modelOpen };
  if (!state.modelOpen) return [head];
  return [head, ...M.treeRows(model, state.expanded, state.filter).map(row => ({ ...row, depth: row.depth + 1 }))];
}

function glyph(row) {
  if (row.entityId === M.E.model) return '<span class="glyph model" aria-hidden="true"></span>';
  if (row.entityId === M.E.folder) return `<span class="glyph folder" style="--tone:${tone(FOLDER_TONE[row.kind])}" aria-hidden="true"></span>`;
  if (row.entityId === M.E.view) return '<span class="glyph view" aria-hidden="true"></span>';
  if (row.layer === 'Relationship') return '<span class="glyph relationship" aria-hidden="true"></span>';
  return `<span class="glyph" style="--tone:${tone(LAYER_TONE[row.layer])}" aria-hidden="true"></span>`;
}

/** The tree shows a diagram object as the concept it shows, as Archi's tree follows its editor. */
function treeSelection() {
  const record = state.model?.records.get(state.selected);
  if (record?.entityId === M.E.item) return record.values['ar.item.concept'] ?? record.values['ar.item.view'];
  return state.selected;
}

function renderTree() {
  const list = rows();
  const tree = $('tree');
  const hadFocus = tree.contains(document.activeElement);
  const inTree = treeSelection();
  const active = list.some(row => row.id === inTree) ? inTree : list[0]?.id;
  tree.innerHTML = list.map(row => {
    const openable = row.entityId === M.E.folder || row.entityId === M.E.model;
    const twisty = openable && row.children > 0 ? (row.expanded ? '▾' : '▸') : '';
    const draggable = row.entityId !== M.E.model && !(row.entityId === M.E.folder && row.depth === 1) && !state.readOnly;
    const name = state.renaming === row.id
      ? `<input class="rename" value="${escape(row.label)}" aria-label="New name" maxlength="400">`
      : `<span class="label">${escape(row.label)}</span>`;
    return `<li class="row" role="treeitem" data-id="${escape(row.id)}" aria-level="${row.depth + 1}" style="--depth:${row.depth}"
      aria-selected="${row.id === inTree}" tabindex="${row.id === active ? 0 : -1}"
      ${openable && row.children > 0 ? `aria-expanded="${row.expanded}"` : ''} ${draggable ? 'draggable="true"' : ''}
      title="${escape(row.typeName ? `${row.typeName}: ${row.label}` : row.label)}"><span class="twisty" aria-hidden="true">${twisty}</span>${glyph(row)}${name}</li>`;
  }).join('');
  $('tree-empty').hidden = list.length > 1 || !state.filter.text && !state.filter.layer;
  $('tree-empty').textContent = 'Nothing in the model matches.';
  const renaming = tree.querySelector('input.rename');
  if (renaming) { renaming.focus(); renaming.select(); return; }
  if (hadFocus) tree.querySelector('[tabindex="0"]')?.focus();
  tree.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
}

/** Select a record everywhere, opening the folders on the way to it. */
function select(id, { reveal = true, focus = false, fromDiagram = null } = {}) {
  if (!state.model?.records.has(id)) return;
  state.selected = id;
  state.draftProperties = null;
  const chosen = state.model.records.get(id);
  if (chosen.entityId === M.E.view) state.openView = id;
  // What the diagram outlines: the object clicked, or every occurrence of a concept on the open view.
  state.diagramSelection = fromDiagram ? [fromDiagram]
    : chosen.entityId === M.E.concept && state.openView
      ? state.model.of(M.E.item).filter(item => item.values['ar.item.view'] === state.openView && item.values['ar.item.concept'] === id).map(item => item.recordId)
      : chosen.entityId === M.E.item ? [id] : [];
  if (reveal) {
    state.modelOpen = true;
    const record = state.model.records.get(id);
    // A record the filter hides is shown by clearing the filter, as the new element Add made is.
    if ((state.filter.text || state.filter.layer) && record.entityId !== M.E.model && !M.matches(state.model, record, state.filter)) {
      state.filter = { text: '', layer: '' };
      $('own-find').value = '';
      $('own-layer').value = '';
    }
    const folderId = record.entityId === M.E.folder ? record.values['ar.folder.parent']
      : record.values['ar.concept.folder'] ?? record.values['ar.view.folder'];
    for (let at = state.model.records.get(folderId); at; at = state.model.records.get(at.values['ar.folder.parent'])) state.expanded.add(at.recordId);
  }
  render();
  if (focus) $('tree').querySelector(`[data-id="${CSS.escape(id)}"]`)?.focus();
}

function toggle(id) {
  if (id === modelRecord()?.recordId) state.modelOpen = !state.modelOpen;
  else if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
  renderTree();
}

function treeKeys(event) {
  if (event.target.matches('input.rename')) return;
  const list = rows();
  const index = list.findIndex(row => row.id === treeSelection());
  const row = list[index];
  const go = at => { const next = list[Math.max(0, Math.min(list.length - 1, at))]; if (next) select(next.id, { reveal: false, focus: true }); };
  const openable = row && (row.entityId === M.E.folder || row.entityId === M.E.model) && row.children > 0;
  switch (event.key) {
    case 'ArrowDown': go(index + 1); break;
    case 'ArrowUp': go(index - 1); break;
    case 'Home': go(0); break;
    case 'End': go(list.length - 1); break;
    case 'ArrowRight': if (openable && !row.expanded) toggle(row.id); else if (openable) go(index + 1); break;
    case 'ArrowLeft':
      if (openable && row.expanded) toggle(row.id);
      else { const parent = list.slice(0, index).findLastIndex(candidate => candidate.depth === row.depth - 1); if (parent >= 0) go(parent); }
      break;
    case 'Enter': $('properties').querySelector('input, textarea, select')?.focus(); break;
    case 'F2': startRename(); break;
    case 'Delete': remove(); break;
    default: return;
  }
  event.preventDefault();
}

function startRename() {
  const record = state.model?.records.get(state.selected);
  if (!record || state.readOnly || ![M.E.folder, M.E.concept, M.E.view, M.E.model].includes(record.entityId)) return;
  state.renaming = record.recordId;
  renderTree();
}

function finishRename(input, keep) {
  const id = state.renaming;
  state.renaming = null;
  const record = state.model.records.get(id);
  const name = input.value.trim();
  if (keep && record && name !== M.label(state.model, record) && (name || record.entityId === M.E.concept)) {
    write(() => [M.renameWrite(state.model, id, name)], `Rename ${M.label(state.model, record)}`).then(() => select(id, { focus: true }));
  } else { renderTree(); $('tree').querySelector('[tabindex="0"]')?.focus(); }
}

// ---------------------------------------------------------------- the centre

function listOf(ids) {
  return `<ul class="links">${ids.map(id => `<li><button type="button" data-select="${escape(id)}">${escape(M.label(state.model, state.model.records.get(id)))}</button></li>`).join('')}</ul>`;
}

function renderDiagram() {
  const centre = $('centre');
  const view = state.model.records.get(state.openView);
  centre.classList.add('diagram');
  if (state.editing && canvasModule?.createEditor) { renderEditor(view); return; }
  if (editor) stopEditor();
  if (!canvasModule) { centre.innerHTML = '<p class="quiet">Drawing the view…</p>'; canvasReady.then(() => renderCentre()); return; }
  let host = centre.querySelector('.canvas-host');
  if (!host) {
    centre.innerHTML = '<div class="canvas-host"></div><div class="diagram-alternative"></div>';
    host = centre.querySelector('.canvas-host');
    canvas = canvasModule.createCanvas(host, {
      onSelect: id => {
        if (!id) { select(state.openView, { reveal: false }); return; }
        const item = state.model.records.get(id);
        const concept = item?.values['ar.item.concept'];
        select(concept && state.model.records.has(concept) ? concept : id, { fromDiagram: id });
      },
      onOpen: id => {
        const target = state.model.records.get(id)?.values['ar.item.refView'];
        if (target) select(target);
      },
      onZoom: scale => { state.zoom = scale; declareToolbar(); },
    });
  }
  // Drawn again only when the file or the view changed; a new selection only moves the outline.
  if (canvas.viewId() !== view.recordId || drawnSets !== state.sets) {
    const shown = canvas.viewId() === view.recordId;
    canvas.show(canvasModule.buildMirror(state.sets), view.recordId, { keepCamera: shown });
    drawnSets = state.sets;
  }
  canvas.select(state.diagramSelection);
  if (state.diagramSelection.length) canvas.reveal(state.diagramSelection[0]);
  host.querySelector('svg.stage')?.setAttribute('aria-label', `The view ${M.label(state.model, view)}`);
  import('./kit/nendo-view-kit.js').then(kit => kit.textAlternative(centre.querySelector('.diagram-alternative'), {
    label: `What the view ${M.label(state.model, view)} shows`,
    items: state.model.of(M.E.item).filter(item => item.values['ar.item.view'] === view.recordId && item.values['ar.item.kind'] === 'Element')
      .map(item => M.label(state.model, state.model.records.get(item.values['ar.item.concept']))).filter(Boolean),
  })).catch(() => undefined);
}

/** Archi's Analysis: the model relations of a concept and the views it is on, each selectable. */
function renderAnalysis(record) {
  const model = state.model;
  const concepts = model.of(M.E.concept);
  const out = concepts.filter(r => r.values['ar.concept.source'] === record.recordId).map(r => r.recordId);
  const into = concepts.filter(r => r.values['ar.concept.target'] === record.recordId).map(r => r.recordId);
  const views = [...new Set(model.of(M.E.item).filter(r => r.values['ar.item.concept'] === record.recordId).map(r => r.values['ar.item.view']))]
    .filter(id => model.records.has(id));
  return `<h3>Model relations (${out.length + into.length})</h3>${out.length + into.length ? listOf([...out, ...into]) : '<p class="quiet">None.</p>'}
    <h3>In views (${views.length})</h3>${views.length ? listOf(views) : '<p class="quiet">Not on any view.</p>'}`;
}

function renderCentre() {
  const model = state.model, record = model?.records.get(state.selected);
  const centre = $('centre');
  if (state.openView && model?.records.has(state.openView)) { renderDiagram(); return; }
  if (canvas) { canvas.destroy(); canvas = null; drawnSets = null; }
  if (editor) stopEditor();
  centre.classList.remove('diagram');
  if (!record) { centre.innerHTML = '<p class="quiet">Select something in the model tree.</p>'; return; }
  const all = [...model.records.values()];
  const concepts = all.filter(r => r.entityId === M.E.concept);
  const count = (value, word) => `<div><strong>${value}</strong><span class="quiet">${word}</span></div>`;
  const inViews = id => [...new Set(all.filter(r => r.entityId === M.E.item && r.values['ar.item.concept'] === id).map(r => r.values['ar.item.view']))];
  let html = `<h2>${escape(M.label(model, record))}</h2>`;
  if (record.entityId === M.E.model) {
    html += `<div class="counts">${count(concepts.filter(r => r.values['ar.concept.category'] === 'Element').length, 'elements')}
      ${count(concepts.filter(r => r.values['ar.concept.category'] === 'Relationship').length, 'relationships')}
      ${count(all.filter(r => r.entityId === M.E.view).length, 'views')}${count(all.filter(r => r.entityId === M.E.folder).length, 'folders')}</div>`;
  } else if (record.entityId === M.E.folder) {
    const content = model.children.get(record.recordId) ?? { folders: [], concepts: [], views: [] };
    html += `<p class="quiet">${escape(M.folderPath(model, record.recordId))}</p><div class="counts">${count(content.folders.length, 'folders')}
      ${count(content.concepts.length, 'concepts')}${count(content.views.length, 'views')}</div>`;
  } else if (record.entityId === M.E.concept) {
    const type = M.typeOf(model, record)?.values['ar.type.name'] ?? '';
    html += `<p class="quiet">${escape(type)}</p>`;
    if (record.values['ar.concept.category'] === 'Relationship') {
      html += `<h3>From and to</h3>${listOf([record.values['ar.concept.source'], record.values['ar.concept.target']].filter(id => model.records.has(id)))}`;
    }
    const out = concepts.filter(r => r.values['ar.concept.source'] === record.recordId).map(r => r.recordId);
    const into = concepts.filter(r => r.values['ar.concept.target'] === record.recordId).map(r => r.recordId);
    if (out.length) html += `<h3>Relationships from here (${out.length})</h3>${listOf(out)}`;
    if (into.length) html += `<h3>Relationships to here (${into.length})</h3>${listOf(into)}`;
    const views = inViews(record.recordId);
    html += `<h3>In views (${views.length})</h3>${views.length ? listOf(views) : '<p class="quiet">Not on any view.</p>'}`;
  } else if (record.entityId === M.E.view) {
    const items = all.filter(r => r.entityId === M.E.item && r.values['ar.item.view'] === record.recordId);
    const lines = items.filter(r => /connection/i.test(r.values['ar.item.kind'] ?? ''));
    const shown = [...new Set(items.filter(r => r.values['ar.item.kind'] === 'Element').map(r => r.values['ar.item.concept']))].filter(id => model.records.has(id));
    html += `<p class="quiet">The diagram is not drawn here yet; this is what the view holds.</p>
      <div class="counts">${count(items.length - lines.length, 'objects')}${count(lines.length, 'connections')}</div>
      <h3>Elements on this view (${shown.length})</h3>${listOf(shown.sort((a, b) => M.label(model, model.records.get(a)).localeCompare(M.label(model, model.records.get(b)))))}`;
  }
  centre.innerHTML = html;
}

// ---------------------------------------------------------------- properties

const field = (label, control) => `<label class="field">${escape(label)}${control}</label>`;
const text = (fieldId, value, attrs = '') => `<input data-field="${fieldId}" value="${escape(value)}" ${attrs}>`;
const area = (fieldId, value) => `<textarea data-field="${fieldId}" rows="4">${escape(value)}</textarea>`;
const options = (fieldId, choices, value, empty) => `<select data-field="${fieldId}">${empty ? `<option value="">${escape(empty)}</option>` : ''}${choices
  .map(choice => `<option value="${escape(choice.id)}" ${choice.id === value ? 'selected' : ''} ${choice.disabled ? 'disabled' : ''}>${escape(choice.label)}</option>`).join('')}</select>`;

/**
 * Archi's 25 viewpoints by name, as archi-online's properties offer them (W-116); a key no
 * viewpoint has, from another tool, is kept and named as unknown. Until the canvas has loaded the
 * stored key is the one choice, and the pane is drawn again when it has.
 */
function viewpointChoices(value) {
  if (!canvasModule) {
    canvasReady.then(() => { if (canvasModule) renderProperties(); });
    return value ? [{ id: value, label: value }] : [];
  }
  const choices = [...canvasModule.VIEWPOINTS].sort((a, b) => a.name.localeCompare(b.name)).map(viewpoint => ({ id: viewpoint.id, label: viewpoint.name }));
  return value && !choices.some(choice => choice.id === value) ? [{ id: value, label: `${value} (unknown)` }, ...choices] : choices;
}

function renderProperties() {
  const model = state.model, record = model?.records.get(state.selected);
  const pane = $('properties');
  if (!record) { pane.innerHTML = ''; return; }
  // A reread after anybody's write must not take a field from under the person typing in it:
  // the pane is drawn again once they leave it, or select something else.
  const typing = pane.contains(document.activeElement) && document.activeElement.matches('input:not([type=checkbox]), textarea');
  if (typing && pane.dataset.record === record.recordId) { pane.dataset.stale = 'true'; return; }
  pane.dataset.record = record.recordId;
  delete pane.dataset.stale;
  const v = record.values;
  const heading = record.entityId === M.E.item
    ? (v['ar.item.concept'] && model.records.has(v['ar.item.concept']) ? M.label(model, model.records.get(v['ar.item.concept'])) : v['ar.item.name'] || v['ar.item.kind'])
    : M.label(model, record);
  let html = `<h2>${escape(heading)}</h2>`;
  if (record.entityId === M.E.model) {
    html += '<span class="chip">Model</span>' + field('Name', text('ar.model.name', v['ar.model.name'], 'required')) +
      field('Purpose', area('ar.model.documentation', v['ar.model.documentation'])) + field('Version', text('ar.model.version', v['ar.model.version']));
  } else if (record.entityId === M.E.folder) {
    const top = !v['ar.folder.parent'];
    html += `<span class="chip">${top ? 'Top-level folder' : 'Folder'}</span>` + field('Name', text('ar.folder.name', v['ar.folder.name'], 'required')) +
      field('Documentation', area('ar.folder.documentation', v['ar.folder.documentation'])) +
      (top ? '' : field('In folder', options('folder', M.folderChoices(model, record.recordId).map(c => ({ ...c, disabled: Boolean(c.reason) && c.id !== v['ar.folder.parent'] })), v['ar.folder.parent']))) +
      field('Label expression', text('ar.folder.labelExpression', v['ar.folder.labelExpression']));
  } else if (record.entityId === M.E.view) {
    html += '<span class="chip">View</span>' + field('Name', text('ar.view.name', v['ar.view.name'], 'required')) +
      field('Documentation', area('ar.view.documentation', v['ar.view.documentation'])) +
      field('Folder', options('folder', M.folderChoices(model, record.recordId).map(c => ({ ...c, disabled: Boolean(c.reason) && c.id !== v['ar.view.folder'] })), v['ar.view.folder'])) +
      field('Viewpoint', options('ar.view.viewpoint', viewpointChoices(v['ar.view.viewpoint']), v['ar.view.viewpoint'], 'None')) +
      field('Connection router', options('ar.view.router', [{ id: 'Manual', label: 'Manual' }, { id: 'Manhattan', label: 'Manhattan' }], v['ar.view.router'], 'Manual (Archi default)'));
  } else if (record.entityId === M.E.concept) {
    const type = M.typeOf(model, record);
    const key = type?.values['ar.type.key'];
    const relationship = v['ar.concept.category'] === 'Relationship';
    const specializations = model.of(M.E.specialization).filter(s => s.values['ar.specialization.type'] === type?.recordId)
      .map(s => ({ id: s.recordId, label: s.values['ar.specialization.name'] }));
    html += `<span class="chip" style="color:${tone(LAYER_TONE[type?.values['ar.type.layer']])}">${escape(type?.values['ar.type.name'] ?? '')}</span>` +
      field('Name', text('ar.concept.name', v['ar.concept.name'])) +
      field(relationship ? 'Relationship type' : 'Element type', options('type', M.typeChoices(model, record), type?.recordId)) +
      field('Documentation', area('ar.concept.documentation', v['ar.concept.documentation'])) +
      field('Folder', options('folder', M.folderChoices(model, record.recordId).map(c => ({ ...c, disabled: Boolean(c.reason) && c.id !== v['ar.concept.folder'] })), v['ar.concept.folder'])) +
      (specializations.length ? field('Specialization', options('ar.concept.specialization', specializations, v['ar.concept.specialization'], 'None')) : '');
    if (relationship) {
      const end = id => model.records.has(id) ? `<button type="button" class="value" data-select="${escape(id)}">${escape(M.label(model, model.records.get(id)))}</button>` : '<span class="value">—</span>';
      html += `<div class="field">Source ${end(v['ar.concept.source'])}</div><div class="field">Target ${end(v['ar.concept.target'])}</div>`;
      if (key === 'AccessRelationship') html += field('Access', options('ar.concept.access', ['Write', 'Read', 'Access', 'Read and write'].map(id => ({ id, label: id })), v['ar.concept.access'], 'Write (Archi default)'));
      if (key === 'InfluenceRelationship') html += field('Influence strength', text('ar.concept.strength', v['ar.concept.strength'], 'placeholder="+, ++, -, --, or 0 to 10"'));
      if (key === 'AssociationRelationship') html += `<label class="field check"><input type="checkbox" data-field="ar.concept.directed" ${v['ar.concept.directed'] ? 'checked' : ''}>Directed</label>`;
    }
    if (key === 'Junction') html += field('Junction type', options('ar.concept.junction', [{ id: 'And', label: 'And' }, { id: 'Or', label: 'Or' }], v['ar.concept.junction'] ?? 'And'));
  }
  if (record.entityId === M.E.item) {
    const kind = v['ar.item.kind'];
    const shows = v['ar.item.concept'] && model.records.has(v['ar.item.concept'])
      ? `<div class="field">Shows <button type="button" class="value" data-select="${escape(v['ar.item.concept'])}">${escape(M.label(model, model.records.get(v['ar.item.concept'])))}</button></div>` : '';
    html += `<span class="chip">${escape(kind)}</span>${shows}` +
      (v['ar.item.name'] ? `<div class="field">Name <span class="value">${escape(v['ar.item.name'])}</span></div>` : '') +
      (v['ar.item.content'] ? `<div class="field">Text <span class="value">${escape(v['ar.item.content'])}</span></div>` : '') +
      (kind.includes('onnection') ? '' : `<div class="field">Bounds <span class="value">${[v['ar.item.x'], v['ar.item.y'], v['ar.item.width'], v['ar.item.height']].join(', ')}</span></div>`);
  }
  if (record.entityId === M.E.concept) html += renderAnalysis(record);
  html += renderPropertyList(record);
  html += `<div class="pane-actions"><button type="button" data-action="open">Open record page</button>
    ${record.entityId !== M.E.model && !(record.entityId === M.E.folder && !v['ar.folder.parent']) ? '<button type="button" data-action="delete">Delete…</button>' : ''}</div>`;
  pane.innerHTML = html;
  for (const control of pane.querySelectorAll('input, select, textarea, button[data-action="delete"]')) control.disabled = state.readOnly;
}

function currentPropertyRows(record) {
  if (state.draftProperties?.owner === record.recordId) return state.draftProperties.rows;
  return (state.model.propertiesOf.get(record.recordId) ?? []).map(p => ({ recordId: p.recordId, key: p.values['ar.property.key'] ?? '', value: p.values['ar.property.value'] ?? '' }));
}

function renderPropertyList(record) {
  const list = currentPropertyRows(record);
  const body = list.map((row, index) => `<tr data-index="${index}"><td><input data-prop="key" value="${escape(row.key)}" aria-label="Key ${index + 1}"></td>
    <td><input data-prop="value" value="${escape(row.value)}" aria-label="Value ${index + 1}"></td>
    <td class="row-actions"><button type="button" data-prop-action="up" aria-label="Move up" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" data-prop-action="down" aria-label="Move down" ${index === list.length - 1 ? 'disabled' : ''}>↓</button><button type="button" data-prop-action="remove" aria-label="Remove ${escape(row.key)}">×</button></td></tr>`).join('');
  return `<h3>Properties</h3>${list.length ? `<table class="props"><tbody>${body}</tbody></table>` : '<p class="quiet">None.</p>'}
    <div class="pane-actions"><button type="button" data-prop-action="add">Add property</button></div>`;
}

function saveProperties(record, list) {
  const kept = list.filter(row => row.key.trim() !== '');
  // What is saved comes back with the reread; a row still without a key is dropped with the draft.
  state.draftProperties = null;
  write(() => M.propertyWrites(state.model, record.recordId, kept.map(row => ({ ...row, key: row.key.trim() }))), `Change the properties of ${M.label(state.model, record)}`);
}

async function propertyChanged(event) {
  const record = state.model.records.get(state.selected);
  const control = event.target;
  if (control.dataset.prop) {
    const list = currentPropertyRows(record).map(row => ({ ...row }));
    const row = list[Number(control.closest('tr').dataset.index)];
    row[control.dataset.prop] = control.value;
    if (row.key.trim() === '') { state.draftProperties = { owner: record.recordId, rows: list }; return; }
    saveProperties(record, list);
    return;
  }
  const fieldId = control.dataset.field;
  if (!fieldId) return;
  const value = control.type === 'checkbox' ? control.checked : control.value === '' ? null : control.value;
  const name = M.label(state.model, record);
  try {
    if (fieldId === 'type') await write(() => [M.typeWrite(state.model, record.recordId, value)], `Change the type of ${name}`);
    else if (fieldId === 'folder') await write(() => [M.moveWrite(state.model, record.recordId, value)], `Move ${name}`);
    else await write(() => [M.fieldWrite(state.model, record.recordId, fieldId, value)], `Change ${name}`);
  } catch (error) { setStatus(describe(error), true); renderProperties(); }
}

function propertyAction(button) {
  const record = state.model.records.get(state.selected);
  const list = currentPropertyRows(record).map(row => ({ ...row }));
  const index = Number(button.closest('tr')?.dataset.index);
  switch (button.dataset.propAction) {
    case 'add': state.draftProperties = { owner: record.recordId, rows: [...list, { key: '', value: '' }] }; renderProperties();
      $('properties').querySelector(`tr[data-index="${list.length}"] input[data-prop="key"]`)?.focus(); return;
    case 'remove': list.splice(index, 1); break;
    case 'up': [list[index - 1], list[index]] = [list[index], list[index - 1]]; break;
    case 'down': [list[index + 1], list[index]] = [list[index], list[index + 1]]; break;
  }
  saveProperties(record, list);
}

// ---------------------------------------------------------------- making and removing

function selectedFolder() {
  const record = state.model?.records.get(state.selected);
  if (!record) return null;
  if (record.entityId === M.E.folder) return record.recordId;
  return record.values['ar.concept.folder'] ?? record.values['ar.view.folder'] ?? null;
}

let lastType = 'BusinessActor';
function newElement() {
  if (state.readOnly || !state.model) return;
  const types = [...state.model.types.values()].filter(t => t.values['ar.type.category'] === 'Element');
  const groups = M.LAYERS.filter(layer => layer !== 'Relationship').map(layer => {
    const members = types.filter(t => t.values['ar.type.layer'] === layer).sort((a, b) => a.values['ar.type.name'].localeCompare(b.values['ar.type.name']));
    return members.length ? `<optgroup label="${escape(layer)}">${members.map(t => `<option value="${escape(t.values['ar.type.key'])}" ${t.values['ar.type.key'] === lastType ? 'selected' : ''}>${escape(t.values['ar.type.name'])}</option>`).join('')}</optgroup>` : '';
  }).join('');
  $('new-element-type').innerHTML = groups;
  $('new-element-name').value = '';
  const hint = () => {
    const probe = M.createElement(state.model, $('new-element-type').value, selectedFolder());
    $('new-element-folder').textContent = `It goes in ${M.folderPath(state.model, probe.values['ar.concept.folder'])}.`;
  };
  $('new-element-type').onchange = hint;
  hint();
  $('new-element').returnValue = '';
  $('new-element').showModal();
  $('new-element-type').focus();
}

$('new-element').addEventListener('close', () => {
  if ($('new-element').returnValue !== 'create') return;
  lastType = $('new-element-type').value;
  const type = lastType, name = $('new-element-name').value.trim() || undefined, folder = selectedFolder();
  let created = null;
  const typeName = [...state.model.types.values()].find(candidate => candidate.values['ar.type.key'] === type)?.values['ar.type.name'] ?? type;
  write(() => [created = M.createElement(state.model, type, folder, name)], `Create ${name ?? typeName}`)
    .then(() => { if (created) select(created.recordId, { focus: true }); });
});

function newFolder() {
  if (state.readOnly || !state.model) return;
  const parent = selectedFolder() ?? state.model.roots[0];
  let created = null;
  write(() => [created = M.createFolder(state.model, parent)], 'Create a folder')
    .then(() => { if (created) { select(created.recordId); startRename(); } });
}

function newView() {
  if (state.readOnly || !state.model) return;
  const folder = selectedFolder();
  let created = null;
  write(() => [created = M.createView(state.model, folder)], 'Create a view')
    .then(() => { if (created) { select(created.recordId); startRename(); } });
}

let pendingDelete = null;
function remove() {
  const record = state.model?.records.get(state.selected);
  if (!record || state.readOnly) return;
  let plan;
  try { plan = M.deletePlan(state.model, [record.recordId]); } catch (error) { setStatus(describe(error), true); return; }
  const { summary } = plan;
  const parts = [['element', 'elements', summary.elements], ['relationship', 'relationships', summary.relationships],
    ['view', 'views', summary.views], ['folder', 'folders', summary.folders],
    ['diagram object or connection', 'diagram objects and connections', summary.items], ['property', 'properties', summary.properties]]
    .filter(([, , n]) => n > 0).map(([one, many, n]) => `${n} ${n === 1 ? one : many}`);
  pendingDelete = { plan, id: record.recordId, name: M.label(state.model, record), parent: selectedParent(record) };
  $('confirm-delete-title').textContent = `Delete ${pendingDelete.name}?`;
  $('confirm-delete-text').textContent = `This removes ${parts.join(', ')} from the model, as Archi does: relationships and diagram objects go with what they belong to.`;
  $('confirm-delete').returnValue = '';
  $('confirm-delete').showModal();
}

function selectedParent(record) {
  return record.values['ar.concept.folder'] ?? record.values['ar.view.folder'] ?? record.values['ar.folder.parent'] ?? modelRecord()?.recordId;
}

$('confirm-delete').addEventListener('close', () => {
  const pending = pendingDelete;
  pendingDelete = null;
  if ($('confirm-delete').returnValue !== 'delete' || !pending) return;
  write(() => M.deletePlan(state.model, [pending.id]).writes, `Delete ${pending.name}`).then(() => select(pending.parent, { focus: true }));
});

// ---------------------------------------------------------------- the toolbar

function summary() {
  const concepts = state.model?.of(M.E.concept) ?? [];
  const elements = concepts.filter(r => r.values['ar.concept.category'] === 'Element').length;
  return `${elements} elements · ${concepts.length - elements} relationships · ${state.model?.of(M.E.view).length ?? 0} views`;
}

function declareToolbar() {
  if (!state.nativeChrome) return;
  const items = [
    { kind: 'search', id: 'find', label: 'Find in the model', placeholder: 'Find…', value: state.filter.text.slice(0, 256), keys: 'Ctrl+F' },
    { kind: 'select', id: 'layer', label: 'Layer', value: state.filter.layer || 'all',
      options: [{ value: 'all', label: 'All layers' }, ...M.LAYERS.map(layer => ({ value: layer, label: layer }))] },
    { kind: 'separator' },
    { kind: 'text', text: summary() },
    { kind: 'menu', id: 'new', label: 'New', icon: 'plus', items: [
      { id: 'new-element', label: 'Element…', detail: 'Of any ArchiMate element type' },
      { id: 'new-folder', label: 'Folder', detail: 'Inside the selected folder' },
      { id: 'new-view', label: 'View', detail: 'In the Views folder' },
      { id: 'generate-view', label: 'View for the selected elements…', detail: 'Generate View For: the elements and those related to them' },
    ] },
    { kind: 'button', id: 'rename', label: 'Rename', icon: 'edit', iconOnly: true, keys: 'F2' },
    { kind: 'button', id: 'delete', label: 'Delete…', icon: 'trash', iconOnly: true },
    { kind: 'menu', id: 'archi-file', label: 'Archi file', items: [
      { id: 'open-archimate', label: 'Open .archimate…', detail: 'Read an Archi model into this empty one' },
      { id: 'open-exchange', label: 'Open Exchange XML…', detail: 'Read an Open Exchange model into this empty one' },
      { kind: 'separator' },
      { id: 'save-archimate', label: 'Save as .archimate', detail: 'Download the model for Archi' },
      { id: 'save-exchange', label: 'Save as Exchange XML', detail: 'Download it in The Open Group’s format, checked against Archi 5.9’s schemas' },
    ] },
    ...(state.openView && !state.readOnly && canvasModule?.createEditor
      ? [{ kind: 'toggle', id: 'edit', label: 'Edit the view', icon: 'edit', pressed: state.editing, keys: 'Ctrl+E' }] : []),
    // Undo and Redo name what they would do (W-112), here, in Ctrl K and in More.
    ...(!state.readOnly ? [{ kind: 'group', label: 'Undo and redo', items: [
      { kind: 'button', id: 'undo', label: undoName() ? `Undo ${undoName()}`.slice(0, 80) : 'Undo', icon: 'undo', iconOnly: true, keys: 'Ctrl+Z', disabled: !undoName() },
      { kind: 'button', id: 'redo', label: redoName() ? `Redo ${redoName()}`.slice(0, 80) : 'Redo', icon: 'redo', iconOnly: true, keys: 'Ctrl+Y', disabled: !redoName() },
    ] }] : []),
    ...(state.editing ? [{ kind: 'group', label: 'Edits', items: [
      { kind: 'button', id: 'commit', label: state.pending > 0 ? `Commit ${state.pending}` : 'Commit', icon: 'check', keys: 'Ctrl+S', disabled: state.pending === 0 },
      { kind: 'button', id: 'discard', label: 'Discard', disabled: state.pending === 0 },
      { kind: 'toggle', id: 'appearance', label: 'Appearance', icon: 'eye', iconOnly: true, pressed: state.styleShown },
    ] }] : []),
    ...(state.editing ? editingMenus() : []),
    { kind: 'toggle', id: 'validator', label: 'Validator', icon: 'info', iconOnly: true, pressed: state.validator.open },
    ...(state.openView ? [{ kind: 'menu', id: 'export', label: 'Export', icon: 'export', iconOnly: true, items: [
      { id: 'export-png-1', label: 'PNG', detail: 'At the view’s own size' },
      { id: 'export-png-2', label: 'PNG at 2×', detail: 'Sharp on a slide' },
      { id: 'export-png-4', label: 'PNG at 4×', detail: 'For print' },
      { id: 'export-svg', label: 'SVG', detail: 'Shapes and text a drawing program keeps' },
      { id: 'export-copy', label: 'Copy as picture', detail: 'At 2×, on white, to paste elsewhere' },
      { kind: 'check', id: 'export-transparent', label: 'Transparent background in files', checked: state.transparent },
    ] }] : []),
    ...(state.openView ? [{ kind: 'group', label: 'Zoom', items: [
      { kind: 'button', id: 'zoom-out', label: 'Zoom out', icon: 'minus', iconOnly: true, keys: 'Ctrl+-' },
      { kind: 'button', id: 'fit', label: `Fit (${Math.round(state.zoom * 100)}%)`, keys: 'Ctrl+0' },
      { kind: 'button', id: 'zoom-in', label: 'Zoom in', icon: 'plus', iconOnly: true, keys: 'Ctrl+Plus' },
    ] }] : []),
  ];
  nendo.ui.setToolbar({ items: knownIcons(items), add: 'new-element' }).catch(error => {
    // A Nendo from before W-115 has no clipboard, layout, undo or redo icon and refuses the
    // row: it is declared again with words where those icons would be.
    if (!plainIcons && /icon/i.test(describe(error))) { plainIcons = true; declareToolbar(); return; }
    leaveNativeChrome(describe(error));
  });
}

const NEW_ICONS = new Set(['clipboard', 'layout', 'undo', 'redo']);
let plainIcons = false;
function knownIcons(items) {
  if (!plainIcons) return items;
  const plain = item => (NEW_ICONS.has(item.icon) ? { ...item, icon: undefined, iconOnly: false } : item);
  return items.map(item => (item.kind === 'group' ? { ...item, items: item.items.map(plain) } : plain(item)));
}

/**
 * The editor's menus in Nendo's row while editing, so they are in Ctrl K too: Arrange (W-113),
 * Copy and paste, Lay out (W-115), and the editor's settings behind the gear, each an icon whose
 * name shows on hover, so the row fits beside Add; Nendo puts what still does not fit in More
 * (the owner, W-115). Each command is
 * archi-online's own, as its context menu runs it: one edit waiting to be committed and one Undo
 * step. Cut, copy, paste and duplicate keep their keys in the view.
 */
function editingMenus() {
  const settings = canvasModule?.editorSettings?.() ?? { grid: false, snap: true, guides: true };
  const item = (id, label, detail) => ({ id, label, ...(detail ? { detail } : {}) });
  return [
    { kind: 'menu', id: 'arrange', label: 'Arrange', icon: 'layers', iconOnly: true, items: [
      { kind: 'label', label: 'Align to the last box selected' },
      item('align-left', 'Align left'), item('align-center', 'Align centre'), item('align-right', 'Align right'),
      item('align-top', 'Align top'), item('align-middle', 'Align middle'), item('align-bottom', 'Align bottom'),
      item('match-width', 'Match width'), item('match-height', 'Match height'), item('match-size', 'Match size'),
      { kind: 'separator' },
      item('distribute-horizontal', 'Distribute horizontally', 'Three boxes or more'), item('distribute-vertical', 'Distribute vertically', 'Three boxes or more'),
      { kind: 'separator' },
      item('order-front', 'Bring to front'), item('order-forward', 'Bring forward'), item('order-backward', 'Send backward'), item('order-back', 'Send to back'),
    ] },
    { kind: 'menu', id: 'clipboard', label: 'Copy and paste', icon: 'clipboard', iconOnly: true, items: [
      item('cut', 'Cut', 'Ctrl X in the view'), item('copy', 'Copy', 'Ctrl C in the view'), item('paste', 'Paste', 'Ctrl V in the view'),
      item('paste-reference', 'Paste as reference', 'New boxes for the same elements'), item('paste-copy', 'Paste as copy', 'New elements'),
      { kind: 'separator' },
      item('duplicate', 'Duplicate', 'Ctrl D in the view'), item('select-same-type', 'Select the same type'),
    ] },
    { kind: 'menu', id: 'layout', label: 'Lay out', icon: 'layout', iconOnly: true, items: [
      { kind: 'label', label: 'With ELK: the boxes selected, or the whole view' },
      item('layout-right', 'Left to right'), item('layout-down', 'Top to bottom'),
    ] },
    { kind: 'menu', id: 'editor-settings', label: 'Editor settings', icon: 'settings', iconOnly: true, items: [
      { kind: 'check', id: 'grid', label: 'Show grid', checked: settings.grid },
      { kind: 'check', id: 'snap', label: 'Snap to grid', checked: settings.snap },
      { kind: 'check', id: 'guides', label: 'Snap to alignment guides', checked: settings.guides },
      { kind: 'separator' },
      item('automatic-relationships', 'Automatic relationships…', 'What nesting a box offers, and which lines it hides'),
    ] },
  ];
}

function arrange(command) {
  if (!editor) { setStatus('Press Edit to arrange the view.', true); return; }
  const refusal = editor.arrange(command);
  if (refusal) setStatus(refusal, true);
}

function leaveNativeChrome(reason) {
  state.nativeChrome = false;
  nendo.ui.setToolbar([]).catch(() => undefined);
  showOwnToolbar();
  setStatus(`Nendo could not show the workbench's controls, so they are drawn here: ${reason}`, true);
}

function showOwnToolbar() {
  $('own-toolbar').hidden = false;
  $('own-layer').innerHTML = `<option value="">All layers</option>${M.LAYERS.map(layer => `<option>${escape(layer)}</option>`).join('')}`;
}

function runCommand({ id, value }) {
  switch (id) {
    case 'find': setFilter({ text: String(value ?? '') }); break;
    case 'layer': setFilter({ layer: value === 'all' ? '' : String(value ?? '') }); break;
    case 'new-element': newElement(); break;
    case 'new-folder': newFolder(); break;
    case 'new-view': newView(); break;
    case 'generate-view': generateView(); break;
    case 'layout-right': layoutView('right'); break;
    case 'layout-down': layoutView('down'); break;
    case 'automatic-relationships': showAutomaticRelationships(); break;
    case 'rename': startRename(); break;
    case 'delete': remove(); break;
    case 'zoom-in': if (editor) editor.zoomIn(); else canvas?.zoom(1.25); break;
    case 'zoom-out': if (editor) editor.zoomOut(); else canvas?.zoom(0.8); break;
    case 'fit': if (editor) editor.fit(); else canvas?.fit(); break;
    case 'edit': toggleEditing(value === true); break;
    case 'undo': undoAny(); break;
    case 'redo': redoAny(); break;
    case 'commit': commitEdits(); break;
    case 'discard': discardEdits(); break;
    case 'validator': showValidator(value === true); break;
    case 'open-archimate': case 'open-exchange': showOpenArchimate(); break;
    case 'save-archimate': saveArchimate(); break;
    case 'save-exchange': saveExchange(); break;
    case 'export-png-1': exportView('png', 1); break;
    case 'export-png-2': exportView('png', 2); break;
    case 'export-png-4': exportView('png', 4); break;
    case 'export-svg': exportView('svg'); break;
    case 'export-copy': copyView(); break;
    case 'export-transparent': state.transparent = value === true; declareToolbar(); break;
    case 'grid': case 'snap': case 'guides': canvasModule?.setEditorSetting?.(id, value === true); declareToolbar(); break;
    case 'appearance':
      state.styleShown = value === true;
      try { localStorage.setItem(APPEARANCE_KEY, state.styleShown ? 'shown' : 'hidden'); } catch { /* this visit only */ }
      editor?.showStyle?.(state.styleShown);
      declareToolbar();
      break;
    default: if (canvasModule?.ARRANGE_COMMANDS?.includes(id)) arrange(id);
  }
}

function setFilter(change) {
  state.filter = { ...state.filter, ...change };
  renderTree();
  declareToolbar();
}

// ---------------------------------------------------------------- editing a view (W-111)

/*
 * Edit turns the open view into archi-online's own editor: its palette, gestures, magic connector
 * and menus, on a copy of the model. The edits collect there, with Undo and Redo, and Commit
 * writes up to 200 record changes to the file as one revision; a larger change keeps waiting
 * without saving anything (an older Nendo without records.batch writes them one by one).
 * Discard drops them. A box moved five times is
 * one change of its place when committed, which is what keeps an editing session inside the
 * file's operation-row bound (W-101). The waiting edits are kept in this browser, so leaving the
 * screen, or Back, finds them again; a change to the file meanwhile is carried under them.
 */
const EDITS_KEY = 'archi-edits';
let editor = null, editBase = null, editSets = null, selectionFromEditor = false;

/** The edits kept in this browser, and the view they were made on; null when none wait. */
function readEdits() {
  try {
    const saved = JSON.parse(localStorage.getItem(EDITS_KEY) ?? 'null');
    return Array.isArray(saved?.writes) && saved.writes.length > 0 ? { viewId: saved.viewId ?? null, writes: saved.writes } : null;
  } catch { return null; }
}

function keepEdits(writes) {
  try {
    if (writes.length === 0) localStorage.removeItem(EDITS_KEY);
    else localStorage.setItem(EDITS_KEY, JSON.stringify({ viewId: editor?.viewId() ?? state.openView, writes }));
  } catch { /* kept for this visit only */ }
}

const waitingWrites = () => (editor ? canvasModule.writesFor(editSets, editBase, editor.model()) : []);

function editsChanged() {
  const writes = waitingWrites();
  state.pending = writes.length;
  keepEdits(writes);
  declareToolbar();
  markStale();
}

/** The whole drawing in sight when the editor opens a view (the owner, W-114), once it is laid out. */
function fitEditorSoon() {
  requestAnimationFrame(() => requestAnimationFrame(() => { editor?.fit(); declareToolbar(); }));
}

function renderEditor(view) {
  const centre = $('centre');
  if (canvas) { canvas.destroy(); canvas = null; drawnSets = null; }
  let host = centre.querySelector('.editor-host');
  if (!host || !editor) {
    centre.innerHTML = '<div class="editor-host"></div>';
    host = centre.querySelector('.editor-host');
    editSets = state.sets;
    editBase = canvasModule.buildMirror(state.sets);
    const saved = readEdits()?.writes ?? null;
    const start = saved ? canvasModule.buildMirror(canvasModule.applyWrites(state.sets, saved)) : editBase;
    editor = canvasModule.createEditor(host, start, {
      onChange: editsChanged,
      onSelect: ids => {
        const id = ids[0];
        const item = state.model.records.get(id);
        const concept = item?.values['ar.item.concept'];
        selectionFromEditor = true;
        try {
          if (!id) select(state.openView, { reveal: false });
          else select(concept && state.model.records.has(concept) ? concept : id, { fromDiagram: id });
        } finally { selectionFromEditor = false; }
      },
      onOpenView: id => { if (state.model.records.has(id)) select(id); },
      onIdle: () => { if (editor && editSets !== state.sets) renderCentre(); },
      styleShown: state.styleShown,
    });
    editor.show(view.recordId);
    fitEditorSoon();
    if (saved) setStatus(`${saved.length} edits were waiting to be committed, and are here again.`);
    editsChanged();
  } else if (editSets !== state.sets && !editor.busy()) {
    // The file changed: after a commit, a change in the tree, or somebody else's. Whatever still
    // waits is carried onto the file as it now is. Held back while a gesture is under way, which
    // a new model would cancel; and when the file now says what the editor shows, as after a
    // commit, the editor keeps its model, and with it Undo.
    const waiting = waitingWrites();
    editSets = state.sets;
    editBase = canvasModule.buildMirror(state.sets);
    const next = waiting.length === 0 ? editBase : canvasModule.buildMirror(canvasModule.applyWrites(state.sets, waiting));
    const differs = canvasModule.writesFor(state.sets, next, editor.model()).length > 0
      || canvasModule.writesFor(state.sets, editor.model(), next).length > 0;
    if (differs) editor.reset(next);
    editsChanged();
  }
  if (editor.viewId() !== view.recordId) { editor.show(view.recordId); fitEditorSoon(); }
  if (!selectionFromEditor) editor.select(state.diagramSelection);
}

function stopEditor() {
  editor?.destroy();
  editor = null; editBase = null; editSets = null;
}

function toggleEditing(on) {
  if (on && state.readOnly) { setStatus('This file is open read-only.', true); declareToolbar(); return; }
  if (on && !canvasModule?.createEditor) { setStatus('The editor has not loaded yet.', true); declareToolbar(); return; }
  if (!on && state.pending > 0) {
    setStatus(`Commit or discard the ${state.pending} waiting ${state.pending === 1 ? 'change' : 'changes'} first.`, true);
    declareToolbar();
    return;
  }
  state.editing = on;
  if (!on) stopEditor();
  render();
}

function commitEdits() {
  if (!editor || state.pending === 0) return;
  const count = state.pending;
  // Once saved, the edits are undone as one step of the file's (W-112), not one by one in the editor.
  return write(() => waitingWrites(), `Commit ${count} ${count === 1 ? 'change' : 'changes'} to the view`, { atomic: true })
    .then(ok => { if (ok) { editor?.clearHistory?.(); declareToolbar(); } return ok; });
}

function discardEdits() {
  if (!editor) return;
  editor.reset(editBase);
  editsChanged();
  setStatus('The waiting changes were discarded.');
}

// ---------------------------------------------------------------- automation (W-115)

/*
 * Archi's automation, each archi-online's own operation. Auto-layout runs ELK on the open view in
 * the editor: one edit waiting and one Undo step, committed like any other. Generate View For
 * builds a view around the elements selected (boxes on the view while editing, else the element
 * in the tree), lays it out with ELK and saves it at once, as one revision; while editing it is
 * also one Undo step in the editor. Automatic relationships are Archi's preferences for what
 * nesting a box offers and which lines a nesting stands for; the canvas and the editor both
 * draw by them. ELK runs in a worker from vendor/elkjs.
 */
let generating = null;

function generateFocus() {
  const model = editor?.model();
  const boxes = editor ? editor.selected().map(id => model.nodes[id]?.elementId).filter(Boolean) : [];
  if (boxes.length > 0) return [...new Set(boxes)];
  const record = state.model?.records.get(treeSelection());
  return record?.entityId === M.E.concept && record.values['ar.concept.category'] === 'Element' ? [record.recordId] : [];
}

function generateView() {
  if (state.readOnly || !state.model) { setStatus('This file is open read-only.', true); return; }
  if (!canvasModule?.generatedViewModel) { setStatus('The editor has not loaded yet.', true); return; }
  if (state.pending > 0) { setStatus(`Commit or discard the ${state.pending} waiting ${state.pending === 1 ? 'change' : 'changes'} first.`, true); return; }
  const focus = generateFocus();
  if (focus.length === 0) { setStatus('Select an element in the tree, or boxes on the view, to generate a view for.', true); return; }
  const model = editor ? editor.model() : canvasModule.buildMirror(state.sets);
  const elements = focus.map(id => model.elements[id]);
  generating = { focus, model };
  $('generate-view-text').textContent = focus.length === 1
    ? `A new view of ${elements[0].name || 'the element'} and the elements related to it, laid out by ELK.`
    : `A new view of the ${focus.length} selected elements and those related to them, laid out by ELK.`;
  $('generate-view-name').value = focus.length === 1 ? `${elements[0].name || 'Element'} View` : 'Generated View';
  const fits = canvasModule.VIEWPOINTS.filter(viewpoint => elements.every(element => canvasModule.isAllowedElementInViewpoint(viewpoint.id, element.type)));
  $('generate-view-viewpoint').innerHTML = `<option value="">None</option>${fits.map(viewpoint => `<option value="${escape(viewpoint.id)}">${escape(viewpoint.name)}</option>`).join('')}`;
  $('generate-view-depth').value = '1';
  $('generate-view-direction').value = 'both';
  $('generate-view-internal').checked = false;
  $('generate-view').returnValue = '';
  $('generate-view').showModal();
  $('generate-view-name').select();
}

$('generate-view').addEventListener('close', async () => {
  const request = generating;
  generating = null;
  if ($('generate-view').returnValue !== 'generate' || !request) return;
  const options = { focusIds: request.focus, name: $('generate-view-name').value.trim() || 'Generated View',
    viewpointId: $('generate-view-viewpoint').value || undefined, depth: Number($('generate-view-depth').value),
    direction: $('generate-view-direction').value, allInternalRelationships: $('generate-view-internal').checked };
  const label = `Generate view ${options.name}`;
  setStatus('Generating the view…');
  let made = null;
  try {
    if (editor) {
      // On the editor's model, so Undo there takes the view away again.
      made = await editor.generateView(options);
      if (state.pending > 200) {
        editor.undo();
        setStatus(`${label} was refused: it needs more than 200 record writes, and at most 200 can be saved together. Nothing was saved. Choose a smaller depth.`, true);
        return;
      }
      if (await write(() => waitingWrites(), label, { atomic: true })) { editor?.clearHistory?.(); declareToolbar(); }
    } else {
      const { result, model } = await canvasModule.generatedViewModel(request.model, options);
      made = result;
      await write(() => canvasModule.writesFor(state.sets, request.model, model), label, { atomic: true });
    }
  } catch (error) { setStatus(`${label} was refused: ${describe(error)}`, true); return; }
  if (!state.model?.records.has(made.viewId)) return;
  select(made.viewId);
  const counted = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  setStatus(`${label}: ${counted(made.nodeIds.length, 'element', 'elements')} and ${counted(made.connectionIds.length, 'relationship', 'relationships')}${made.truncated ? ', cut short at 1,000 concepts' : ''}, in one revision.`);
});

async function layoutView(direction) {
  if (!editor) { setStatus('Press Edit to lay out the view.', true); return; }
  setStatus('Laying out the view…');
  try {
    const refusal = await editor.layout(direction);
    setStatus(refusal ?? 'Laid out by ELK. Commit to keep it, or Undo.', refusal !== null);
  } catch (error) { setStatus(`The layout was refused: ${describe(error)}`, true); }
}

function showAutomaticRelationships() {
  if (!canvasModule?.automaticRelationshipSettings) { setStatus('The editor has not loaded yet.', true); return; }
  const { description, rows, types } = canvasModule.automaticRelationshipSettings();
  $('arm-settings-text').textContent = `${description} Kept in this browser, for every Archi model.`;
  $('arm-settings-list').innerHTML = rows.map(row => row.kind === 'boolean'
    ? `<label class="check"><input type="checkbox" data-arm="${escape(row.key)}" ${row.value ? 'checked' : ''}><span>${escape(row.label)}<small>${escape(row.description)}</small></span></label>`
    : `<fieldset data-arm-mask="${escape(row.key)}"><legend>${escape(row.label)}</legend><p>${escape(row.description)}</p><div class="arm-types">${types.map(entry =>
      `<label><input type="checkbox" data-bit="${entry.bit}" ${row.value & entry.bit ? 'checked' : ''}>${escape(entry.label)}</label>`).join('')}</div></fieldset>`).join('');
  $('arm-settings').returnValue = '';
  $('arm-settings').showModal();
}

$('arm-settings').addEventListener('close', () => {
  const choice = $('arm-settings').returnValue;
  if (choice !== 'save' && choice !== 'defaults') return;
  for (const row of canvasModule.automaticRelationshipSettings().rows) {
    let value = row.initial;
    if (choice === 'save') {
      const box = $('arm-settings-list').querySelector(`[data-arm="${row.key}"]`);
      const mask = $('arm-settings-list').querySelector(`[data-arm-mask="${row.key}"]`);
      value = box ? box.checked : [...mask.querySelectorAll('input[data-bit]:checked')].reduce((sum, input) => sum | Number(input.dataset.bit), 0);
    }
    canvasModule.setAutomaticRelationshipSetting(row.key, value);
  }
  setStatus(choice === 'save' ? 'Automatic relationships saved.' : "Automatic relationships are Archi's defaults again.");
});

// ---------------------------------------------------------------- the validator (W-117)

/*
 * Archi's validator is archi-online's, bundled in canvas.js, run on the mirror of the file's
 * records: its eight checks, which a person can turn off, and its model-integrity pass. While a
 * view is being edited it validates what the editor shows, waiting edits included. It runs when
 * opened and when asked, as Archi's does, and says when the model has changed since.
 */
const RULES_KEY = 'archi-validator-rules';
const SEVERITIES = [['error', 'Errors'], ['warning', 'Warnings'], ['advice', 'Advice']];
const SOURCES = [['hammer', "Archi's checks"], ['integrity', 'Model integrity']];

function validatorConfig() {
  const config = structuredClone(canvasModule.DEFAULT_VALIDATION_CONFIG);
  try {
    const off = JSON.parse(localStorage.getItem(RULES_KEY) ?? '[]');
    if (Array.isArray(off)) for (const id of off) if (id in config.enabled) config.enabled[id] = false;
  } catch { /* every rule on */ }
  return config;
}

const validatedModel = () => (editor ? editor.model() : canvasModule.buildMirror(state.sets));

function showValidator(open) {
  state.validator.open = open;
  $('validator').hidden = !open;
  $('own-validator').setAttribute('aria-pressed', String(open));
  declareToolbar();
  if (open) validate(); else $('validator-list').innerHTML = '';
}

async function validate() {
  if (!canvasModule) await canvasReady;
  if (!canvasModule?.validateModel || !state.sets) { setStatus('The validator has not loaded yet.', true); return; }
  const model = validatedModel();
  state.validator = { ...state.validator, issues: canvasModule.validateModel(model, validatorConfig()), of: { sets: state.sets, model: editor ? model : null }, current: null };
  renderValidator();
}

function validatorStale() {
  const of = state.validator.of;
  return Boolean(of) && (of.sets !== state.sets || (editor ? of.model !== editor.model() : of.model !== null));
}

function renderValidator() {
  if (!state.validator.open) return;
  const { issues } = state.validator;
  const list = $('validator-list');
  if (!issues) { list.innerHTML = '<p class="quiet">Validating…</p>'; return; }
  const count = severity => issues.filter(issue => issue.severity === severity).length;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  $('validator-summary').textContent = `${plural(count('error'), 'error', 'errors')}, ${plural(count('warning'), 'warning', 'warnings')}, ${count('advice')} advice`;
  const stale = `<p class="stale" ${validatorStale() ? '' : 'hidden'}>The model has changed since. Validate again to check it as it is now.</p>`;
  if (issues.length === 0) { list.innerHTML = `${stale}<p class="quiet">No issues found.</p>`; return; }
  let html = stale, index = 0;
  const numbered = issues.map(issue => ({ issue, index: index++ }));
  for (const [source, sourceLabel] of SOURCES) {
    const section = numbered.filter(({ issue }) => issue.source === source);
    if (section.length === 0) continue;
    html += `<h3>${escape(sourceLabel)} (${section.length})</h3>`;
    for (const [severity, severityLabel] of SEVERITIES) {
      const group = section.filter(({ issue }) => issue.severity === severity);
      if (group.length === 0) continue;
      html += `<h4>${severityLabel} (${group.length})</h4><ul>${group.map(({ issue, index: at }) => {
        const where = issue.location.modelTree.labelPath.join(' / ') + (issue.location.view?.objectId ? ' · on the view' : '');
        return `<li class="${severity}"><button type="button" data-issue="${at}" title="${escape(issue.rule)}" ${at === state.validator.current ? 'aria-current="true"' : ''}><span class="severity" aria-label="${escape(severityLabel.replace(/s$/, ''))}"></span><span class="message">${escape(issue.message)}</span><span class="where">${escape(where)}</span></button></li>`;
      }).join('')}</ul>`;
    }
  }
  list.innerHTML = html;
}

/** Open what an issue names: the object on its view, or the concept, view or folder in the tree. */
function openIssue(issue) {
  const records = state.model.records;
  const view = issue.location.view;
  if (view) {
    if (!records.has(view.viewId)) { setStatus('That view has not been committed yet.', true); return; }
    state.openView = view.viewId;
    const objectId = view.objectId;
    if (!objectId) { select(view.viewId); return; }
    const concept = records.get(objectId)?.values['ar.item.concept'] ?? editor?.model().nodes[objectId]?.elementId;
    if (concept && records.has(concept)) select(concept, { fromDiagram: objectId });
    else if (records.has(objectId)) select(objectId, { fromDiagram: objectId });
    else { state.selected = view.viewId; state.diagramSelection = [objectId]; render(); }
    return;
  }
  const target = issue.location.modelTree.idPath.at(-1);
  if (records.has(target)) select(target, { focus: true });
  else setStatus('That has not been committed yet; it is in the edits waiting on the view.', true);
}

/** Say that the list is of an earlier model, without drawing it again under the person. */
function markStale() {
  const note = state.validator.open && $('validator-list').querySelector('.stale');
  if (note) note.hidden = !validatorStale();
}

function configureRules() {
  const config = validatorConfig();
  $('validator-config-list').innerHTML = canvasModule.VALIDATION_RULES.map(rule => `<label><input type="checkbox" data-rule="${escape(rule.id)}" ${config.enabled[rule.id] ? 'checked' : ''}>
    <span>${escape(rule.name)}</span><small>${escape(rule.severity)}</small></label>`).join('');
  $('validator-config').showModal();
}

$('validator-config').addEventListener('close', () => {
  const off = [...$('validator-config-list').querySelectorAll('input[data-rule]')].filter(box => !box.checked).map(box => box.dataset.rule);
  try { localStorage.setItem(RULES_KEY, JSON.stringify(off)); } catch { /* kept for this visit only */ }
  validate();
});

// ---------------------------------------------------------------- .archimate files (W-120)

/*
 * Archi's own files, read and written with archi-online's parser and serializer in canvas.js.
 * Open reads a model into an empty one, as Archi opens a model into a new tree: a file that
 * already holds a model says how to make an empty one. The person chooses the file in the
 * workbench's own dialog, because a picker opens only on a click inside the view, or drops it on
 * the workbench. Images are left out and counted (F-208). Save downloads the model as plain XML.
 */
let opening = null;

async function showOpenArchimate(file = null) {
  await canvasReady;
  if (!canvasModule?.readModelFile) { setStatus('Opening a model file needs the diagram code, which could not load.', true); return; }
  opening = null;
  const blocked = state.readOnly ? 'This file is open read-only, so nothing can be opened into it.'
    : !nendo.has('records.batch') ? 'Opening a model needs a newer Nendo, one that saves several records together.'
    : !canvasModule.holdsNoModel(state.sets)
      ? 'This file already holds a model. Open the model file in a new one: in Nendo, File › New Archi model…, then Archi file › Open .archimate… or Open Exchange XML… there.'
      : null;
  $('open-archimate-text').textContent = blocked ??
    'The model is read into this file’s empty model and saved in a few changes. History cannot undo them; to start again, make a new Archi model.';
  $('open-archimate-choose').disabled = blocked !== null;
  $('open-archimate-drop').hidden = blocked !== null;
  $('open-archimate-summary').textContent = '';
  $('open-archimate-summary').classList.remove('problem');
  $('open-archimate-open').disabled = true;
  const dialog = $('open-archimate');
  if (!dialog.open) dialog.showModal();
  if (file && blocked === null) await readChosen(file);
}

async function readChosen(file) {
  const summary = $('open-archimate-summary');
  summary.classList.remove('problem');
  summary.textContent = `Reading ${file.name}…`;
  $('open-archimate-open').disabled = true;
  try {
    // An .archimate file, plain or an archive, or Open Exchange XML (W-121), told apart by what it holds.
    const { model, leftOut, format } = canvasModule.readModelFile(new Uint8Array(await file.arrayBuffer()));
    const plan = canvasModule.planImport(model, importTarget(), leftOut);
    opening = { name: file.name, model, leftOut };
    const counts = plan.counts;
    summary.textContent = [`${model.info.name || file.name}: ${counts.elements} elements, ${counts.relationships} relationships, ${counts.views} views.`,
      format === 'exchange' ? 'Read as Open Exchange XML.' : null, canvasModule.leftOutSentence(plan.leftOut)].filter(Boolean).join(' ');
    $('open-archimate-open').disabled = false;
  } catch (error) {
    opening = null;
    summary.textContent = `${file.name} could not be opened. ${describe(error)}`;
    summary.classList.add('problem');
  }
}

function importTarget() {
  const rootFolders = {};
  for (const folder of state.sets.folders ?? []) {
    if (!folder.values['ar.folder.parent']) rootFolders[folder.values['ar.folder.kind']] = folder.recordId;
  }
  return { rootFolders, modelRecordId: modelRecord()?.recordId ?? `ar.model.r.${crypto.randomUUID()}` };
}

/** The chosen model, written in batches after every earlier gesture, planned from the records as they then stand. */
function openChosen() {
  if (!opening) return;
  const { name, model, leftOut } = opening;
  opening = null;
  const run = writing.then(async () => {
    if (!canvasModule.holdsNoModel(state.sets)) { setStatus(`${name} was not opened: this file holds a model now.`, true); return; }
    const plan = canvasModule.planImport(model, importTarget(), leftOut);
    const batches = canvasModule.importBatches(plan, state.sets, 200);
    let saved = 0, outcome = null, problem = false;
    try {
      for (const [index, batch] of batches.entries()) {
        setStatus(`Opening ${name}: saving ${index + 1} of ${batches.length}…`);
        await nendo.records.batch(batch, { label: `Open ${name}${batches.length > 1 ? ` (${index + 1} of ${batches.length})` : ''}`.slice(0, 80) });
        saved += 1;
      }
      const counts = plan.counts;
      outcome = [`Opened ${name}: ${counts.elements} elements, ${counts.relationships} relationships, ${counts.views} views.`,
        canvasModule.leftOutSentence(plan.leftOut)].filter(Boolean).join(' ');
    } catch (error) {
      problem = true;
      outcome = saved === 0 ? `${name} was not opened: ${describe(error)}`
        : `${name} was opened only in part: ${saved} of ${batches.length} saves went through before this was refused: ${describe(error)} To start again, make a new Archi model.`;
    }
    state.selected = null;
    await readAll().catch(error => { outcome = `The model could not be read. ${describe(error)}`; problem = true; });
    if (!problem) select(modelRecord()?.recordId ?? null, { reveal: true });
    setStatus(outcome, problem);
  });
  writing = run.catch(() => undefined);
  return run;
}

/** The model as an .archimate file, handed to the browser's own downloads. */
async function saveArchimate() {
  await canvasReady;
  if (!canvasModule?.exportArchimate || !state.sets) { setStatus('Saving an .archimate file needs the diagram code, which could not load.', true); return; }
  let file;
  try { file = canvasModule.exportArchimate(state.sets); } catch (error) { setStatus(`The model could not be saved as .archimate: ${describe(error)}`, true); return; }
  download(new Blob([file.xml], { type: 'application/xml' }), file.fileName);
  const waiting = state.pending > 0 ? ` The ${state.pending} edits still waiting to be committed are not in it.` : '';
  setStatus(`Saved ${file.fileName}, ${summary()}.${waiting}`, state.pending > 0);
}

/**
 * The model as Open Exchange XML (W-121), as archi-online's export makes it, checked first against
 * Archi 5.9's schemas by libxml2, which xsd.js brings only now. A file that does not validate is
 * not saved, and the status names the first thing the schemas refused.
 */
async function saveExchange() {
  await canvasReady;
  if (!canvasModule?.exportExchange || !state.sets) { setStatus('Saving Exchange XML needs the diagram code, which could not load.', true); return; }
  let file;
  try { file = canvasModule.exportExchange(state.sets); } catch (error) { setStatus(`The model could not be saved as Exchange XML: ${describe(error)}`, true); return; }
  setStatus('Checking the Exchange XML against Archi 5.9’s schemas…');
  let problems;
  try { problems = await (await import('./xsd.js')).validateExchangeXml(file.xml); } catch (error) {
    setStatus(`The Exchange XML could not be checked, so it was not saved: ${describe(error)}`, true);
    return;
  }
  if (problems.length > 0) {
    const first = problems[0];
    setStatus(`Not saved: the Exchange XML does not validate against Archi 5.9’s schemas${first.line ? ` (line ${first.line})` : ''}: ${first.message}` +
      (problems.length > 1 ? ` ${problems.length - 1} more.` : ''), true);
    return;
  }
  download(new Blob([file.xml], { type: 'application/xml' }), file.fileName);
  const waiting = state.pending > 0 ? ` The ${state.pending} edits still waiting to be committed are not in it.` : '';
  setStatus(`Saved ${file.fileName}, valid against Archi 5.9’s schemas, ${summary()}.${waiting}`, state.pending > 0);
}

const isArchimateName = name => /\.(archimate|xml)$/i.test(name);
const draggedFiles = event => [...(event.dataTransfer?.types ?? [])].includes('Files');

// ---------------------------------------------------------------- view images (W-123)

/*
 * A view as a picture, as Archi's File › Export › View As Image makes one: archi-online's own
 * export in canvas.js, cropped to the drawing with a 10-pixel margin, its labels as SVG text in
 * the canvas's font. The picture is what the view shows, edits still waiting included. Archi's
 * figures draw the same in both themes, so the only choice is white or transparent behind them.
 */
const imageModel = () => (editor ? editor.model() : canvasModule.buildMirror(state.sets));
const fileBase = name => String(name || 'View').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 120) || 'View';

function openViewRecord() {
  const view = state.openView ? state.model?.records.get(state.openView) : null;
  if (!view) setStatus('Open a view in the tree to export it.', true);
  return view ?? null;
}

async function exportView(format, scale = 1) {
  await canvasReady;
  if (!canvasModule?.viewSvg) { setStatus('Exporting a view needs the diagram code, which could not load.', true); return; }
  const view = openViewRecord();
  if (!view) return;
  const name = fileBase(view.values['ar.view.name']);
  const background = state.transparent ? 'transparent' : 'white';
  try {
    if (format === 'svg') {
      const { svg, width, height } = canvasModule.viewSvg(imageModel(), view.recordId, background);
      download(new Blob([svg], { type: 'image/svg+xml' }), `${name}.svg`);
      setStatus(`Exported ${name}.svg, ${width} × ${height}.`);
      return;
    }
    const png = await canvasModule.viewPng(imageModel(), view.recordId, scale, background);
    download(png.blob, `${name}.png`);
    const smaller = png.scale < scale ? `, at ${Math.round(png.scale * 100) / 100}×, the largest one picture holds` : '';
    setStatus(`Exported ${name}.png, ${png.width} × ${png.height}${smaller}.`);
  } catch (error) {
    setStatus(`${name} could not be exported: ${describe(error)}`, true);
  }
}

async function copyView() {
  await canvasReady;
  if (!canvasModule?.copyViewPng) { setStatus('Copying a view needs the diagram code, which could not load.', true); return; }
  const view = openViewRecord();
  if (!view) return;
  const name = fileBase(view.values['ar.view.name']);
  try {
    // Chosen in Nendo's row, the command reaches a frame without focus, and the clipboard refuses
    // a frame without focus; the view takes it first (measured, G36 in Review-ExtensionViews.mjs).
    window.focus();
    // Always on the white page, as Archi copies a view: a program that pastes Windows' bitmap
    // shows a transparent picture's see-through pixels as black. At twice the view's size, as
    // PNG at 2×, so it stays sharp on a slide; at its own size it pasted small (owner, W-123).
    await canvasModule.copyViewPng(imageModel(), view.recordId, 'white', 2);
    setStatus(`Copied ${name} to the clipboard as a picture.`);
  } catch (error) {
    setStatus(`${name} could not be copied: ${describe(error)}`, true);
  }
}

/** Hand a file to the browser's own downloads, which the view's frame allows. */
function download(blob, name) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 60000);
}

// ---------------------------------------------------------------- the whole page

function setStatus(message, problem = false) {
  const status = $('status');
  status.textContent = message;
  status.classList.toggle('problem', problem);
}

function render() {
  renderTree();
  renderCentre();
  renderProperties();
  declareToolbar();
  declarePlace();
  markStale();
}

// ---------------------------------------------------------------- Back and Forward

/*
 * Where the workbench is, for Nendo's Back and Forward (W-127): the open view, the record
 * selected and the object picked on the diagram. Opening another view is a step; a new
 * selection corrects the step the person is on, so Back from a record page, or from the next
 * view, comes back to it. Selections are declared once the person pauses, a view at once.
 */
let startPlace = null, declaredPlace = null, waitingPlace = null, placeTimer = null;

const placeNow = () => ({ view: state.openView, selected: state.selected, item: state.diagramSelection[0] ?? null });
const samePlace = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function placeLabel(place) {
  const record = state.model?.records.get(place.view ?? place.selected);
  return record ? M.label(state.model, record).slice(0, 80) : 'Model';
}

function sendPlace(place, replace) {
  declaredPlace = place;
  nendo.ui.setPlace(place, { label: placeLabel(place), replace }).catch(error => setStatus(describe(error), true));
}

function declarePlace() {
  if (!state.loaded || !nendo.has('ui.setPlace')) return;
  const place = placeNow();
  if (samePlace(place, waitingPlace ?? declaredPlace)) return;
  const step = declaredPlace !== null && place.view !== (waitingPlace ?? declaredPlace).view;
  clearTimeout(placeTimer);
  if (step) {
    // The selection made on the view being left belongs to its step, so it goes first.
    if (waitingPlace) sendPlace(waitingPlace, true);
    waitingPlace = null;
    sendPlace(place, false);
    return;
  }
  if (declaredPlace === null) { sendPlace(place, true); return; }
  waitingPlace = place;
  placeTimer = setTimeout(() => { const waiting = waitingPlace; waitingPlace = null; if (waiting) sendPlace(waiting, true); }, 150);
}

/** Put the workbench where a place says, as far as the model still has it. */
function applyPlace(place) {
  const has = id => typeof id === 'string' && state.model.records.has(id);
  state.openView = has(place?.view) ? place.view : null;
  state.selected = has(place?.selected) ? place.selected : state.openView ?? modelRecord()?.recordId ?? null;
  state.diagramSelection = has(place?.item) ? [place.item] : [];
  state.draftProperties = null;
  // Edits left waiting on this view open it in the editor again, so they are seen.
  if (state.openView && !state.readOnly && readEdits()?.viewId === state.openView) state.editing = true;
  const record = state.model.records.get(state.selected);
  const folderId = record && (record.entityId === M.E.folder ? record.values['ar.folder.parent']
    : record.values['ar.concept.folder'] ?? record.values['ar.view.folder']);
  for (let at = state.model.records.get(folderId); at; at = state.model.records.get(at.values['ar.folder.parent'])) state.expanded.add(at.recordId);
}

/** Back or Forward moved the person to a place of this workbench's: show it, and declare nothing. */
function restorePlace(place) {
  if (!state.loaded) { startPlace = place; return; }
  clearTimeout(placeTimer);
  waitingPlace = null;
  applyPlace(place);
  declaredPlace = placeNow();
  render();
}

function wire() {
  const tree = $('tree');
  tree.addEventListener('click', event => {
    const row = event.target.closest('.row');
    if (!row || event.target.matches('input.rename')) return;
    if (event.target.closest('.twisty')?.textContent) { toggle(row.dataset.id); return; }
    select(row.dataset.id, { reveal: false, focus: true });
  });
  tree.addEventListener('dblclick', event => {
    const row = event.target.closest('.row');
    if (row && row.getAttribute('aria-expanded') !== null) toggle(row.dataset.id);
  });
  tree.addEventListener('keydown', event => {
    if (event.target.matches('input.rename')) {
      if (event.key === 'Enter') { event.preventDefault(); finishRename(event.target, true); }
      else if (event.key === 'Escape') { event.preventDefault(); finishRename(event.target, false); }
      return;
    }
    treeKeys(event);
  });
  tree.addEventListener('focusout', event => { if (event.target.matches('input.rename')) finishRename(event.target, true); });
  tree.addEventListener('contextmenu', async event => {
    const row = event.target.closest('.row');
    if (!row || !nendo.has('ui.showMenu')) return;
    event.preventDefault();
    select(row.dataset.id, { reveal: false, focus: true });
    const record = state.model.records.get(row.dataset.id);
    const deletable = record.entityId !== M.E.model && !(record.entityId === M.E.folder && !record.values['ar.folder.parent']);
    let at = event;
    if (event.clientX === 0 && event.clientY === 0) { const box = row.getBoundingClientRect(); at = { x: box.left + 24, y: box.bottom - 4 }; }
    const pick = await nendo.ui.showMenu([
      { id: 'rename', label: 'Rename', keys: 'F2', disabled: state.readOnly || record.entityId === M.E.type },
      { kind: 'separator' },
      { id: 'new-element', label: 'New element…', disabled: state.readOnly },
      { id: 'new-folder', label: 'New folder', disabled: state.readOnly },
      { id: 'new-view', label: 'New view', disabled: state.readOnly },
      { id: 'generate-view', label: 'Generate view for…', disabled: state.readOnly || record.values['ar.concept.category'] !== 'Element' },
      { kind: 'separator' },
      { id: 'open', label: 'Open record page', icon: 'external' },
      { id: 'delete', label: 'Delete…', icon: 'trash', danger: true, disabled: state.readOnly || !deletable },
    ], at).catch(error => { setStatus(describe(error), true); return null; });
    if (pick?.id === 'open') openRecord(); else if (pick) runCommand(pick);
  });

  // Drag a concept, a view or a folder onto a folder of the same layer's tree.
  let dragged = null;
  tree.addEventListener('dragstart', event => {
    const row = event.target.closest('.row');
    dragged = row?.dataset.id ?? null;
    if (dragged) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', dragged); }
  });
  tree.addEventListener('dragover', event => {
    const row = event.target.closest('.row');
    for (const marked of tree.querySelectorAll('.drop-target')) marked.classList.remove('drop-target');
    if (!row || !dragged || M.whyNotMove(state.model, dragged, row.dataset.id)) return;
    event.preventDefault();
    row.classList.add('drop-target');
  });
  tree.addEventListener('dragleave', event => event.target.closest?.('.row')?.classList.remove('drop-target'));
  tree.addEventListener('drop', event => {
    const row = event.target.closest('.row');
    event.preventDefault();
    const id = dragged;
    dragged = null;
    if (!row || !id) return;
    const reason = M.whyNotMove(state.model, id, row.dataset.id);
    if (reason) { setStatus(reason, true); return; }
    state.expanded.add(row.dataset.id);
    write(() => [M.moveWrite(state.model, id, row.dataset.id)], `Move ${M.label(state.model, state.model.records.get(id))}`).then(() => select(id));
  });
  tree.addEventListener('dragend', () => { dragged = null; for (const marked of tree.querySelectorAll('.drop-target')) marked.classList.remove('drop-target'); });

  $('centre').addEventListener('click', event => { const button = event.target.closest('[data-select]'); if (button) select(button.dataset.select); });
  const pane = $('properties');
  pane.addEventListener('change', event => { propertyChanged(event); });
  pane.addEventListener('focusout', () => {
    setTimeout(() => { if (pane.dataset.stale === 'true' && !pane.contains(document.activeElement)) renderProperties(); }, 0);
  });
  pane.addEventListener('click', event => {
    const target = event.target.closest('[data-select], [data-action], [data-prop-action]');
    if (!target) return;
    if (target.dataset.select) select(target.dataset.select);
    else if (target.dataset.action === 'open') openRecord();
    else if (target.dataset.action === 'delete') remove();
    else propertyAction(target);
  });

  $('own-find').addEventListener('input', event => setFilter({ text: event.target.value }));
  $('own-layer').addEventListener('change', event => setFilter({ layer: event.target.value }));
  $('own-new-element').addEventListener('click', newElement);
  $('own-new-folder').addEventListener('click', newFolder);
  $('own-new-view').addEventListener('click', newView);
  $('own-delete').addEventListener('click', remove);
  $('own-validator').addEventListener('click', () => showValidator(!state.validator.open));
  $('own-open-archimate').addEventListener('click', () => showOpenArchimate());
  $('own-save-archimate').addEventListener('click', () => saveArchimate());
  $('own-save-exchange').addEventListener('click', () => saveExchange());
  $('own-export-png').addEventListener('click', () => exportView('png', 2));
  $('own-export-svg').addEventListener('click', () => exportView('svg'));
  // The picker opens on this click, inside the view: a command from Nendo's toolbar cannot open it.
  $('open-archimate-choose').addEventListener('click', () => $('open-archimate-file').click());
  $('open-archimate-file').addEventListener('change', event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) readChosen(file);
  });
  $('open-archimate').addEventListener('close', () => {
    if ($('open-archimate').returnValue === 'open') openChosen(); else opening = null;
  });
  // An .archimate file dropped anywhere on the workbench opens the dialog with it read.
  document.addEventListener('dragover', event => {
    if (!draggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('drop', event => {
    if (!draggedFiles(event)) return;
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    if (!isArchimateName(file.name)) { setStatus(`${file.name} is not an Archi model. Archi opens .archimate files.`, true); return; }
    showOpenArchimate(file);
  });
  $('validate').addEventListener('click', () => validate());
  $('validator-rules').addEventListener('click', () => { if (canvasModule) configureRules(); });
  $('validator-close').addEventListener('click', () => showValidator(false));
  $('validator-list').addEventListener('click', event => {
    const row = event.target.closest('[data-issue]');
    const issue = row && state.validator.issues?.[Number(row.dataset.issue)];
    if (!issue) return;
    // The issue opened stays marked, so the next one down is easy to find.
    for (const marked of $('validator-list').querySelectorAll('[aria-current]')) marked.removeAttribute('aria-current');
    row.setAttribute('aria-current', 'true');
    state.validator.current = Number(row.dataset.issue);
    openIssue(issue);
  });
}

function openRecord() {
  const record = state.model?.records.get(state.selected);
  if (!record) return;
  // The selection is the place Back comes back to, so it is declared before the page goes.
  if (waitingPlace) { clearTimeout(placeTimer); const waiting = waitingPlace; waitingPlace = null; sendPlace(waiting, true); }
  nendo.ui.openRecord(record.entityId, record.recordId).catch(error => setStatus(describe(error), true));
}

if (nendo === undefined) {
  setStatus('The Archi workbench runs inside Nendo. Open Archi.nendo and choose Views → Archi.', true);
} else {
  import('./kit/nendo-view-kit.js').then(kit => kit.installFocusRing(document)).catch(() => undefined);
  wire();
  nendo.ready.then(context => {
    document.documentElement.lang = context.locale || 'en';
    state.readOnly = context.readOnly === true;
    startPlace = context.place ?? null;
    if (nendo.has('ui.setPlace')) nendo.on('place', restorePlace);
    if (nendo.has('ui.setToolbar')) {
      state.nativeChrome = true;
      document.body.classList.add('native-chrome');
      nendo.on('command', command => { try { runCommand(command); } catch (error) { setStatus(describe(error), true); } });
    } else showOwnToolbar();
    nendo.on('changes', schedule);
    nendo.on('context', next => { state.readOnly = next.readOnly === true; schedule(); });
    return readAll();
  }).then(() => setStatus(summary())).catch(error => setStatus(`The workbench could not start. ${describe(error)}`, true));
}
