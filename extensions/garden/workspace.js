// The Garden workspace, the screen the file opens on: the notes as a tree on the left, one note's
// editor and preview in the middle, and what links to it below. Save derives the note's links,
// tags and tasks from its body and writes everything as one records.batch (sync.mjs), which the
// view can undo. Nendo draws the controls where it offers its toolbar; otherwise the view draws its
// own. Every colour is the theme's.
import { parse, slugify } from './parse.mjs';
import { render } from './render.mjs';
import { plan, resolveTarget, F } from './sync.mjs';
import { readRelated, readTags, drawRelated } from './related.mjs';

const STAGE_TONES = { Seed: 'amber', Growing: 'teal', Evergreen: 'green' };
const $ = id => document.getElementById(id);

export async function startWorkspace(nendo, context, kit) {
  const app = $('app'), tree = $('tree'), treeEmpty = $('tree-empty'), find = $('find');
  const status = $('status'), problem = $('problem'), empty = $('empty'), noteSection = $('note');
  const title = $('title'), meta = $('meta'), editor = $('editor'), preview = $('preview'), autocomplete = $('autocomplete');
  const ownSummary = $('own-summary'), aboutText = $('about-text');
  const lists = { backlinks: $('backlinks'), backlinksCount: $('backlinks-count'), tags: $('note-tags'), tasks: $('note-tasks'), tasksCount: $('tasks-count') };
  app.hidden = false;

  const can = name => typeof nendo.has === 'function' && nendo.has(name);
  const today = () => new Date().toISOString().slice(0, 10);
  const newId = (entityId, hint) => `${entityId}.${slugify(hint).slice(0, 40)}-${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;

  // State the probe reads through window.garden.
  const state = { ready: false, index: [], byId: new Map(), note: null, draft: null, dirty: false, external: false, problem: null,
    preview: true, undo: [], redo: [], filter: '', tags: [], related: null, stubs: [] };
  const expose = () => { window.garden = state; };

  // ---- The index: every note, without its body, and the tree they make.
  async function loadIndex() {
    const records = await nendo.records.queryAll({ entityId: 'gd.note', sortFieldId: F.note.title }, { max: 10000 });
    state.index = records.map(record => ({ recordId: record.recordId, version: record.version, values: record.values,
      slug: record.values[F.note.slug] ?? '', title: record.values[F.note.title] ?? record.recordId }));
    state.byId = new Map(state.index.map(note => [note.recordId, note]));
    state.tags = await readTags(nendo);
    drawTree();
    declareToolbar();
  }

  function drawTree() {
    const filter = state.filter.trim().toLowerCase();
    const children = new Map();
    for (const note of state.index) {
      const parent = note.values[F.note.parent] ?? null;
      const key = state.byId.has(parent) ? parent : null;
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(note);
    }
    for (const list of children.values()) list.sort((a, b) => (a.values[F.note.order] ?? Infinity) - (b.values[F.note.order] ?? Infinity) || a.title.localeCompare(b.title));
    const matches = note => !filter || note.title.toLowerCase().includes(filter) || note.slug.includes(filter);
    const build = (parent, depth) => {
      const list = document.createElement('ul');
      list.setAttribute('role', parent === null ? 'tree' : 'group');
      for (const note of children.get(parent) ?? []) {
        const below = build(note.recordId, depth + 1);
        if (!matches(note) && below.childElementCount === 0) continue;
        const item = document.createElement('li');
        item.setAttribute('role', 'treeitem');
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'row';
        row.dataset.id = note.recordId;
        if (state.note?.recordId === note.recordId) row.setAttribute('aria-current', 'true');
        if (drafts.has(note.recordId)) { row.classList.add('draft'); row.title = 'Has an unsaved draft'; }
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = `var(--nendo-tone-${STAGE_TONES[note.values[F.note.stage]] ?? 'grey'})`;
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = note.title;
        row.append(dot, name);
        const count = below.childElementCount;
        if (count) { const n = document.createElement('span'); n.className = 'n'; n.textContent = String(count); row.append(n); }
        row.addEventListener('click', () => open(note.recordId));
        item.append(row);
        if (count) item.append(below);
        list.append(item);
      }
      return list;
    };
    const built = build(null, 0);
    tree.replaceChildren(...built.children);
    treeEmpty.hidden = state.index.length > 0;
    treeKeys.refresh();
    ownSummary.textContent = summary();
  }
  const treeKeys = kit.roving(tree, { items: '.row' });
  const summary = () => `${state.index.length} ${state.index.length === 1 ? 'note' : 'notes'}${state.note ? ` · ${state.dirty ? 'unsaved changes' : 'saved'}` : ''}`;

  // ---- One note.
  // A draft left when the person moves to another note is kept, so no dialog ever asks to discard it.
  const drafts = new Map();
  function keepDraft() {
    if (!state.dirty || !state.draft) return;
    drafts.set(state.note?.recordId ?? 'new', { ...state.draft, version: state.note?.version ?? null });
  }
  async function open(recordId, { fromPlace = false } = {}) {
    if (state.note?.recordId !== recordId) keepDraft();
    let record;
    try {
      record = await nendo.records.get('gd.note', recordId);
    } catch (error) { showProblem(error.message); return; }
    if (record === null) { showProblem('That note is not in this file any more.'); return; }
    state.note = record;
    const kept = drafts.get(recordId);
    if (kept !== undefined && kept.version === record.version) {
      state.draft = { title: kept.title, body: kept.body };
      state.dirty = true;
      state.external = false;
    } else {
      state.draft = { title: record.values[F.note.title] ?? '', body: record.values[F.note.body] ?? '' };
      state.dirty = false;
      state.external = kept !== undefined;
      if (kept !== undefined) { state.draft = { title: kept.title, body: kept.body }; state.dirty = true; }
    }
    drafts.delete(recordId);
    await showNote();
    if (!fromPlace && can('ui.setPlace')) nendo.ui.setPlace({ noteId: recordId }, { label: state.draft.title.slice(0, 80) || 'Note', replace: state.firstPlace !== false }).catch(() => undefined);
    state.firstPlace = false;
  }

  function startNew(values = {}, body = '') {
    if (state.note !== null) keepDraft();
    state.note = null;
    const kept = drafts.get('new');
    drafts.delete('new');
    state.draft = kept && !values[F.note.kind] ? { title: kept.title, body: kept.body, values: kept.values ?? {} } : { title: values[F.note.title] ?? '', body, values };
    state.dirty = true;
    state.external = false;
    state.related = { backlinks: [], links: [], noteTags: [], tasks: [] };
    showNote().then(() => title.focus());
  }

  async function showNote() {
    hideProblem();
    empty.hidden = true;
    noteSection.hidden = false;
    title.value = state.draft.title;
    editor.value = state.draft.body;
    drawMeta();
    drawPreview();
    if (state.note !== null) {
      try { state.related = await readRelated(nendo, state.note.recordId); } catch (error) { showProblem(error.message); state.related = { backlinks: [], links: [], noteTags: [], tasks: [] }; }
    }
    drawRelated(state.related, lists, openRecord, state.byId, new Map(state.tags.map(tag => [tag.recordId, { title: tag.values[F.tag.name] }])));
    drawTree();
    setStatus();
    expose();
  }

  function drawMeta() {
    meta.replaceChildren();
    if (state.note === null) { meta.append(chip('New note, not saved yet')); return; }
    const values = state.note.values;
    meta.append(chip(values[F.note.slug] ?? '', 'slug'));
    meta.append(chip(values[F.note.stage] ?? 'Seed', 'stage', STAGE_TONES[values[F.note.stage]] ?? 'grey'));
    if (values[F.note.kind]) meta.append(chip(values[F.note.kind]));
    if (values[F.note.touched]) meta.append(chip(`tended ${values[F.note.touched]}`));
    if (values[F.note.pinned]) meta.append(chip('pinned'));
  }
  function chip(text, kind = '', tone = null) {
    const element = document.createElement('span');
    element.className = `chip ${kind}`.trim();
    if (tone) { const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = `var(--nendo-tone-${tone})`; element.append(dot); }
    element.append(document.createTextNode(text));
    return element;
  }

  const resolve = target => {
    const found = resolveTarget(target, state.index);
    return found ? { recordId: found.recordId, title: found.title } : null;
  };
  function drawPreview() {
    preview.innerHTML = render(state.draft.body, { resolve });
  }
  preview.addEventListener('click', event => {
    const link = event.target.closest('a');
    if (!link) return;
    event.preventDefault();
    if (link.classList.contains('wikilink')) {
      if (link.dataset.id) open(link.dataset.id);
      else setStatus(`Save this note to plant "${link.dataset.target}" as a Seed.`);
    } else if (link.classList.contains('tag')) {
      const tag = state.tags.find(candidate => (candidate.values[F.tag.name] ?? '').toLowerCase() === link.dataset.tag);
      if (tag) openRecord('gd.tag', tag.recordId); else setStatus(`Save this note to make the tag #${link.dataset.tag}.`);
    } else if (link.href) {
      window.open(link.href, '_blank', 'noopener');
    }
  });

  function edited() {
    state.draft.title = title.value;
    state.draft.body = editor.value;
    state.dirty = true;
    drawPreview();
    setStatus();
    expose();
  }
  title.addEventListener('input', edited);
  editor.addEventListener('input', () => { edited(); suggest(); });

  function setStatus(text = null) {
    status.classList.toggle('external', state.external);
    status.textContent = text ?? (state.external ? 'This note changed elsewhere. Reload it before saving; your draft is kept.'
      : state.note === null && state.draft ? 'A new note. Save plants it.' : state.dirty ? 'Unsaved changes.' : state.note ? 'Saved.' : '');
    ownSummary.textContent = summary();
    declareToolbar();
  }
  function showProblem(text) { state.problem = text; problem.textContent = text; problem.hidden = false; expose(); }
  function hideProblem() { state.problem = null; problem.hidden = true; expose(); }

  // ---- Save: the body becomes records, in one batch the view can undo.
  async function save() {
    if (!state.draft) return;
    if (state.external) { showProblem('This note changed elsewhere, so this draft is kept and not saved. Reload the note, then make your change again.'); return; }
    const body = editor.value, noteTitle = title.value;
    const planned = plan({ note: state.note, title: noteTitle, body, parsed: parse(body), index: state.index,
      existing: state.related ?? {}, tags: state.tags, today: today(), newId, values: state.draft.values ?? {} });
    if (planned.problems.length) { showProblem(planned.problems.join(' ')); return; }
    if (planned.writes.length === 0) { state.dirty = false; setStatus('Nothing changed.'); return; }
    if (!can('records.batch')) { showProblem('This Nendo does not let views write records.'); return; }
    const label = `Save ${noteTitle.trim().slice(0, 60) || 'note'}`;
    let result;
    try {
      result = await nendo.records.batch(planned.writes, { label });
    } catch (error) {
      showProblem(`The save was refused (${error.code}): ${error.message} Your draft is kept.`);
      return;
    }
    hideProblem();
    state.undo.push({ revision: result.revision, label });
    state.redo = [];
    state.stubs = planned.stubs.map(stub => stub.recordId);
    const noteId = state.note?.recordId ?? result.records[0].recordId;
    await loadIndex();
    await open(noteId, { fromPlace: true });
    setStatus(planned.stubs.length ? `Saved. Planted ${planned.stubs.length} ${planned.stubs.length === 1 ? 'seed' : 'seeds'}: ${planned.stubs.map(s => s.title).join(', ')}.` : 'Saved.');
  }

  async function undo() {
    const step = state.undo.pop();
    if (!step || !can('records.undo')) return;
    try {
      const result = await nendo.records.undo(step.revision);
      state.redo.push({ revision: result.revision, label: step.label });
      await afterStep();
    } catch (error) { state.undo.push(step); showProblem(`Undo was refused (${error.code}): ${error.message}`); }
  }
  async function redo() {
    const step = state.redo.pop();
    if (!step || !can('records.redo')) return;
    try {
      const result = await nendo.records.redo(step.revision);
      state.undo.push({ revision: result.revision, label: step.label });
      await afterStep();
    } catch (error) { state.redo.push(step); showProblem(`Redo was refused (${error.code}): ${error.message}`); }
  }
  async function afterStep() {
    hideProblem();
    await loadIndex();
    if (state.note && state.byId.has(state.note.recordId)) await open(state.note.recordId, { fromPlace: true });
    else { state.note = null; state.draft = null; state.dirty = false; noteSection.hidden = true; empty.hidden = false; setStatus(''); }
  }

  async function daily() {
    const date = today();
    const existing = state.index.find(note => note.values[F.note.kind] === 'Daily' && note.values[F.note.date] === date);
    if (existing) { await open(existing.recordId); return; }
    const template = state.index.find(note => note.values[F.note.kind] === 'Template');
    let body = '';
    if (template) { const full = await nendo.records.get('gd.note', template.recordId); body = full?.values[F.note.body] ?? ''; }
    startNew({ [F.note.title]: date, [F.note.kind]: 'Daily', [F.note.date]: date }, body);
  }

  const openRecord = (entityId, recordId) => {
    if (entityId === 'gd.note') return open(recordId);
    return nendo.ui.openRecord(entityId, recordId).catch(error => setStatus(error.message));
  };

  // ---- [[ autocomplete in the editor.
  let picks = [], picked = 0, anchor = -1;
  function suggest() {
    const caret = editor.selectionStart, text = editor.value.slice(0, caret);
    const at = text.lastIndexOf('[[');
    if (at === -1 || text.slice(at).includes(']]') || /\n/.test(text.slice(at))) { closeSuggest(); return; }
    const query = text.slice(at + 2).toLowerCase();
    anchor = at;
    picks = state.index.filter(note => note.recordId !== state.note?.recordId && (note.slug.includes(query) || note.title.toLowerCase().includes(query))).slice(0, 8);
    if (!picks.length) { closeSuggest(); return; }
    picked = 0;
    drawSuggest();
  }
  function drawSuggest() {
    autocomplete.replaceChildren(...picks.map((note, index) => {
      const item = document.createElement('li');
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(index === picked));
      item.textContent = note.title;
      const slug = document.createElement('span'); slug.className = 'slug'; slug.textContent = note.slug; item.append(slug);
      item.addEventListener('mousedown', event => { event.preventDefault(); picked = index; insertPick(); });
      return item;
    }));
    autocomplete.hidden = false;
  }
  function closeSuggest() { autocomplete.hidden = true; picks = []; anchor = -1; }
  function insertPick() {
    const note = picks[picked];
    if (!note || anchor < 0) return;
    const after = editor.value.slice(editor.selectionStart);
    const before = editor.value.slice(0, anchor);
    const inserted = `[[${note.slug}]]`;
    editor.value = `${before}${inserted}${after}`;
    editor.selectionStart = editor.selectionEnd = before.length + inserted.length;
    closeSuggest();
    edited();
  }
  editor.addEventListener('keydown', event => {
    if (autocomplete.hidden) return;
    if (event.key === 'ArrowDown') { picked = (picked + 1) % picks.length; drawSuggest(); event.preventDefault(); }
    else if (event.key === 'ArrowUp') { picked = (picked + picks.length - 1) % picks.length; drawSuggest(); event.preventDefault(); }
    else if (event.key === 'Enter' || event.key === 'Tab') { insertPick(); event.preventDefault(); }
    else if (event.key === 'Escape') { closeSuggest(); event.preventDefault(); }
  });
  editor.addEventListener('blur', () => setTimeout(closeSuggest, 150));

  // ---- Controls: Nendo's row where it is offered, the view's own otherwise.
  let nativeChrome = false, aboutShown = false;
  function declareToolbar() {
    if (!nativeChrome) return;
    const hasNote = state.draft !== null;
    nendo.ui.setToolbar({
      items: [
        { kind: 'search', id: 'find', label: 'Find a note', placeholder: 'Find…', value: state.filter, keys: 'Ctrl+Shift+F' },
        { kind: 'button', id: 'new', label: 'New note', icon: 'plus' },
        { kind: 'button', id: 'daily', label: 'Today', icon: 'edit' },
        { kind: 'toggle', id: 'preview', label: 'Preview', icon: 'eye', pressed: state.preview },
        { kind: 'button', id: 'save', label: 'Save', icon: 'check', keys: 'Ctrl+S', disabled: !hasNote || !state.dirty },
        { kind: 'group', label: 'History', items: [
          { kind: 'button', id: 'undo', label: 'Undo save', icon: 'undo', iconOnly: true, disabled: state.undo.length === 0 },
          { kind: 'button', id: 'redo', label: 'Redo save', icon: 'redo', iconOnly: true, disabled: state.redo.length === 0 },
        ] },
        { kind: 'text', id: 'summary', text: summary() },
        { kind: 'menu', id: 'more', label: 'Note', icon: 'more', items: [
          { id: 'open-record', label: 'Open record page', icon: 'external', disabled: state.note === null },
          { id: 'graph', label: 'Graph', icon: 'chain' },
          { id: 'evergreen', label: 'Mark evergreen', icon: 'check', disabled: state.note === null },
          { kind: 'separator' },
          { kind: 'check', id: 'about', label: 'About this view', checked: aboutShown },
        ] },
      ],
      add: 'new',
    }).catch(error => { nativeChrome = false; document.documentElement.classList.remove('native-chrome'); setStatus(error.message); });
  }
  async function command(id, value) {
    switch (id) {
      case 'find': state.filter = value ?? ''; find.value = state.filter; drawTree(); break;
      case 'new': startNew(); break;
      case 'daily': await daily(); break;
      case 'preview': state.preview = typeof value === 'boolean' ? value : !state.preview; document.documentElement.classList.toggle('editor-only', !state.preview); $('own-toolbar').querySelector('[data-command=preview]').setAttribute('aria-pressed', String(state.preview)); declareToolbar(); break;
      case 'save': await save(); break;
      case 'undo': await undo(); break;
      case 'redo': await redo(); break;
      case 'open-record': if (state.note) nendo.ui.openRecord('gd.note', state.note.recordId).catch(error => setStatus(error.message)); break;
      case 'graph': if (can('ui.openScreen')) nendo.ui.openScreen('gd.note.graph').catch(error => setStatus(error.message)); break;
      case 'evergreen': await runCommand('gd.cmd.evergreen'); break;
      case 'about': aboutShown = typeof value === 'boolean' ? value : !aboutShown; aboutText.hidden = !aboutShown; declareToolbar(); break;
      default: break;
    }
    expose();
  }
  async function runCommand(commandId) {
    if (!state.note) return;
    try {
      await nendo.commands.run(commandId, state.note);
      await loadIndex();
      await open(state.note.recordId, { fromPlace: true });
    } catch (error) { showProblem(`${commandId} was refused (${error.code}): ${error.message}`); }
  }
  $('own-toolbar').addEventListener('click', event => {
    const button = event.target.closest('button[data-command]');
    if (button) command(button.dataset.command, null);
  });
  find.addEventListener('input', () => { state.filter = find.value; drawTree(); });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 's') { event.preventDefault(); save(); }
    if (event.key === 'Escape' && aboutShown) command('about', false);
  });
  if (can('ui.setToolbar')) {
    nativeChrome = true;
    document.documentElement.classList.add('native-chrome');
    nendo.on('command', ({ id, value }) => { command(id, value); });
  }

  // ---- Following the file, and Back and Forward.
  let pending = null;
  async function changed() {
    pending = null;
    const current = state.note?.recordId ?? null;
    await loadIndex();
    if (current === null) return;
    if (!state.dirty) { await open(current, { fromPlace: true }); return; }
    const latest = state.byId.get(current);
    if (latest === undefined || latest.version !== state.note.version) { state.external = true; setStatus(); expose(); }
  }
  nendo.on('changes', () => { if (pending === null) pending = setTimeout(changed, 400); });
  nendo.on('context', () => { if (pending === null) pending = setTimeout(changed, 400); });
  nendo.on('place', place => { if (place?.noteId) open(place.noteId, { fromPlace: true }); });

  await loadIndex();
  state.ready = true;
  expose();
  const start = context.place?.noteId && state.byId.has(context.place.noteId) ? context.place.noteId : null;
  if (start) await open(start, { fromPlace: true });
  else setStatus('');
}
