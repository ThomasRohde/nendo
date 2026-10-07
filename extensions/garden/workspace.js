// The Garden workspace, the screen the file opens on: the notes as a tree on the left and one
// note in the middle, in one of two modes: View, the page, and Edit (Ctrl E toggles them), its
// Markdown with the preview beside it. The page is Narrow, Medium or Full, as the person picks. Under the note are its backlinks, its local graph, its tags and its tasks.
// Save derives the note's links, tags and tasks from its body and writes everything as one
// records.batch (sync.mjs), which the view can undo; ticking a task while reading saves it at
// once. Nendo draws the controls where it offers its toolbar; otherwise the view draws its own.
// Every colour is the theme's.
import { parse, slugify } from './parse.mjs';
import { render } from './render.mjs';
import { plan, resolveTarget, F } from './sync.mjs';
import { readRelated, readTags, drawRelated } from './related.mjs';
import { buildGraph } from './graph-data.mjs';
import { createGraph } from './graph.js';
import { localDate, uncertain, readDrafts, writeDrafts } from './drafts.mjs';
import { createFinder, localMatch } from './search.mjs';
import { createFindMarks, searchTerms } from './findmarks.mjs';

const STAGE_TONES = { Seed: 'amber', Growing: 'teal', Evergreen: 'green' };
const TASK_LINE = /^(\s*[-*+]\s+\[)( |x|X)(\])/;
const $ = id => document.getElementById(id);

export async function startWorkspace(nendo, context, kit) {
  const app = $('app'), tree = $('tree'), treeEmpty = $('tree-empty'), find = $('find');
  const status = $('status'), problem = $('problem'), empty = $('empty'), noteSection = $('note');
  const title = $('title'), meta = $('meta'), editor = $('editor'), preview = $('preview'), autocomplete = $('autocomplete');
  const readingTitle = $('reading-title'), readingMeta = $('reading-meta'), readingBody = $('reading-body');
  const ownSummary = $('own-summary'), guide = $('guide'), hoverCard = $('hover-card');
  const lists = { backlinks: $('backlinks'), backlinksCount: $('backlinks-count'), tags: $('note-tags'), tasks: $('note-tasks'), tasksCount: $('tasks-count') };
  app.hidden = false;

  const can = name => typeof nendo.has === 'function' && nendo.has(name);
  const today = () => localDate();
  const newId = (entityId, hint) => `${entityId}.${slugify(hint).slice(0, 40)}-${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;

  // State the probe reads through window.garden.
  const state = { ready: false, index: [], byId: new Map(), links: [], note: null, draft: null, dirty: false, external: false, problem: null,
    mode: 'read', width: 'full', undo: [], redo: [], filter: '', tags: [], related: null, stubs: [], local: null,
    saving: false, unanswered: null, restored: 0,
    // Find: the index's hits by record ID once they arrive, or null while the view matches what it
    // holds; and which of the two answered the last search ('index', or why the index did not).
    hits: null, findSource: 'local',
    // How many words Find marked in the open note: in the reading view and preview, and in the editor.
    findMarks: { text: 0, editor: 0 } };
  const expose = () => { window.garden = state; };

  // ---- The index: every note, the links between them, and the tree they make.
  async function loadIndex() {
    const [records, links, tags] = await Promise.all([
      nendo.records.queryAll({ entityId: 'gd.note', sortFieldId: F.note.title }, { max: 10000 }),
      nendo.records.queryAll({ entityId: 'gd.link' }, { max: 10000 }),
      readTags(nendo),
    ]);
    state.index = records.map(record => ({ recordId: record.recordId, version: record.version, values: record.values,
      slug: record.values[F.note.slug] ?? '', title: record.values[F.note.title] ?? record.recordId }));
    state.byId = new Map(state.index.map(note => [note.recordId, note]));
    state.links = links;
    state.tags = tags;
    drawTree();
    declareToolbar();
    // The notes changed under a search: ask the index again, as it now reads.
    if (state.filter.trim() !== '') finder.find(state.filter);
  }

  // ---- Find. What is typed is matched at once against the notes the view holds (title, slug and
  // body), and then searched in the file's own index (ADR-0028), whose hits replace the first
  // answer when they arrive: ranked by Nendo, with the line of the body that matched.
  const finder = createFinder(nendo, {
    entityId: 'gd.note',
    onResult(hits, text, source) {
      if (text !== state.filter.trim()) return;
      state.hits = hits;
      state.findSource = source;
      drawTree();
      expose();
    },
  });
  function setFilter(value) {
    state.filter = value ?? '';
    state.hits = null;
    state.findSource = 'local';
    drawTree();
    markFinds();
    finder.find(state.filter);
  }
  // The words Find holds, marked in the open note: highlighted in the reading view and the preview,
  // and on the layer behind the editor. Opening a note while Find holds words brings the first into sight.
  const marks = createFindMarks(document, { editor });
  function markFinds({ reveal = false } = {}) {
    const terms = state.filter.trim() === '' ? [] : searchTerms(state.filter);
    const { count, first } = marks.mark([readingBody, preview], terms);
    state.findMarks = { text: count, editor: marks.markEditor(terms, { reveal: reveal && state.mode === 'edit' }) };
    if (reveal && first !== null && state.mode === 'read') first.startContainer.parentElement?.scrollIntoView({ block: 'center' });
  }

  // ---- The tree. A branch folds away with the arrow beside its note, or with Left and Right; what
  // is folded is this person's, so it stays in this browser rather than in the file. Find shows
  // every branch that holds a match, folded or not, and opening a note unfolds the branch it is in.
  const collapsedKey = `garden.tree.collapsed.v1.${context.viewId ?? 'workspace'}`;
  const collapsed = new Set((() => { try { const kept = JSON.parse(localStorage.getItem(collapsedKey) ?? '[]'); return Array.isArray(kept) ? kept : []; } catch { return []; } })());
  const keepCollapsed = () => { try { localStorage.setItem(collapsedKey, JSON.stringify([...collapsed])); } catch { /* a private window keeps none */ } };
  const parentOf = recordId => { const parent = state.byId.get(recordId)?.values[F.note.parent] ?? null; return state.byId.has(parent) ? parent : null; };
  const hasChildren = recordId => state.index.some(note => parentOf(note.recordId) === recordId);
  const TWISTY = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.5 6.5 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function drawTree() {
    const filter = state.filter.trim().toLowerCase();
    const children = new Map();
    for (const note of state.index) {
      const key = parentOf(note.recordId);
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(note);
    }
    for (const list of children.values()) list.sort((a, b) => (a.values[F.note.order] ?? Infinity) - (b.values[F.note.order] ?? Infinity) || a.title.localeCompare(b.title));
    const matches = note => !filter || (state.hits !== null ? state.hits.has(note.recordId) : localMatch(note, filter, F.note.body));
    const build = parent => {
      const list = document.createElement('ul');
      list.setAttribute('role', parent === null ? 'tree' : 'group');
      for (const note of children.get(parent) ?? []) {
        const kids = children.get(note.recordId)?.length ?? 0;
        // A folded branch is not drawn at all, so the arrow keys and the count of rows only meet what shows.
        const unfolded = kids > 0 && (filter !== '' || !collapsed.has(note.recordId));
        const below = unfolded || filter !== '' ? build(note.recordId) : null;
        if (!matches(note) && (below?.childElementCount ?? 0) === 0) continue;
        const item = document.createElement('li');
        item.setAttribute('role', 'treeitem');
        if (kids > 0) item.setAttribute('aria-expanded', String(unfolded));
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'row';
        row.dataset.id = note.recordId;
        if (state.note?.recordId === note.recordId) row.setAttribute('aria-current', 'true');
        if (drafts.has(note.recordId)) { row.classList.add('draft'); row.title = 'Has an unsaved draft'; }
        const twisty = document.createElement('span');
        twisty.className = kids > 0 ? 'twisty' : 'twisty leaf';
        if (kids > 0) { twisty.innerHTML = TWISTY; twisty.title = unfolded ? 'Fold away' : 'Unfold'; }
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = `var(--nendo-tone-${STAGE_TONES[note.values[F.note.stage]] ?? 'grey'})`;
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = note.title;
        row.append(twisty, dot, name);
        // A note Find found is marked, so it reads apart from the branch above it kept for context.
        if (filter !== '' && matches(note)) row.classList.add('match');
        const count = filter !== '' ? below.childElementCount : kids;
        if (count) { const n = document.createElement('span'); n.className = 'n'; n.textContent = String(count); row.append(n); }
        row.addEventListener('click', event => {
          if (kids > 0 && event.target.closest('.twisty')) fold(note.recordId, !collapsed.has(note.recordId));
          else open(note.recordId);
        });
        item.append(row);
        if (unfolded && below.childElementCount) item.append(below);
        list.append(item);
      }
      return list;
    };
    const focused = document.activeElement?.closest?.('#tree .row')?.dataset.id ?? null;
    tree.replaceChildren(...build(null).children);
    treeEmpty.hidden = state.index.length > 0;
    treeKeys.refresh();
    // A redraw replaces the rows: keep the keyboard on the note it was on.
    if (focused !== null) tree.querySelector(`.row[data-id="${CSS.escape(focused)}"]`)?.focus();
    ownSummary.textContent = summary();
    state.collapsed = [...collapsed];
  }
  const treeKeys = kit.roving(tree, { items: '.row' });

  function fold(recordId, shut) {
    if (shut === collapsed.has(recordId)) return;
    if (shut) collapsed.add(recordId); else collapsed.delete(recordId);
    keepCollapsed();
    drawTree();
    expose();
  }
  function foldAll(shut) {
    collapsed.clear();
    if (shut) for (const note of state.index) if (hasChildren(note.recordId)) collapsed.add(note.recordId);
    keepCollapsed();
    drawTree();
    expose();
  }
  // Opening a note unfolds every branch above it, so the tree always shows where you are.
  function reveal(recordId) {
    let changed = false;
    for (let at = parentOf(recordId), guard = 0; at !== null && guard < 1000; at = parentOf(at), guard++) if (collapsed.delete(at)) changed = true;
    if (changed) keepCollapsed();
  }
  // Right unfolds a branch, or steps into it; Left folds it, or steps up to the note it is under.
  tree.addEventListener('keydown', event => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const row = event.target.closest?.('.row');
    if (!row) return;
    event.preventDefault();
    const id = row.dataset.id, item = row.parentElement, expanded = item.getAttribute('aria-expanded');
    if (event.key === 'ArrowRight') {
      if (expanded === 'false') fold(id, false);
      else if (expanded === 'true') item.querySelector(':scope > ul .row')?.focus();
    } else if (expanded === 'true' && state.filter.trim() === '') fold(id, true);
    else {
      const up = parentOf(id);
      if (up !== null) tree.querySelector(`.row[data-id="${CSS.escape(up)}"]`)?.focus();
    }
  });
  const summary = () => `${state.index.length} ${state.index.length === 1 ? 'note' : 'notes'}${state.note ? ` · ${state.dirty ? 'unsaved changes' : 'saved'}` : ''}`;

  // ---- One note.
  // A draft left when the person moves to another note is kept, so no dialog ever asks to discard it.
  // The drafts are kept in the view's own storage too (drafts.mjs), so a view Nendo stops when the
  // person goes to another screen, or starts again, finds them where they were left.
  const draftKey = `garden.drafts.v1.${context.viewId ?? 'workspace'}`;
  const storage = (() => { try { return window.localStorage; } catch { return null; } })();
  const drafts = readDrafts(storage, draftKey);
  state.restored = drafts.size;
  function keepDraft() {
    if (!state.dirty || !state.draft) return;
    drafts.set(state.note?.recordId ?? 'new', { ...state.draft, version: state.note?.version ?? null, at: Date.now() });
  }
  let storeTimer = null;
  function storeDrafts() {
    clearTimeout(storeTimer);
    storeTimer = null;
    const all = new Map(drafts);
    if (state.dirty && state.draft) all.set(state.note?.recordId ?? 'new', { ...state.draft, version: state.note?.version ?? null, at: Date.now() });
    writeDrafts(storage, draftKey, all);
  }
  const storeSoon = () => { if (storeTimer === null) storeTimer = setTimeout(storeDrafts, 250); };
  addEventListener('pagehide', storeDrafts);
  // Only the newest open lands: a note read late never replaces the one the person went to since.
  let openTicket = 0;
  async function open(recordId, { fromPlace = false } = {}) {
    hideHover();
    const ticket = ++openTicket;
    let record;
    try {
      record = await nendo.records.get('gd.note', recordId);
    } catch (error) { if (ticket === openTicket) showProblem(error.message); return; }
    if (ticket !== openTicket) return;
    if (record === null) { showProblem('That note is not in this file any more.'); return; }
    const moving = state.note?.recordId !== recordId;
    if (moving) keepDraft();
    state.note = record;
    // Going to a note unfolds its branch; reading the same note again leaves the tree as the person left it.
    if (moving) reveal(recordId);
    const kept = drafts.get(recordId);
    if (kept !== undefined) {
      state.draft = { title: kept.title, body: kept.body };
      state.dirty = true;
      state.external = kept.version !== record.version;
    } else {
      state.draft = { title: record.values[F.note.title] ?? '', body: record.values[F.note.body] ?? '' };
      state.dirty = false;
      state.external = false;
    }
    drafts.delete(recordId);
    storeDrafts();
    await showNote();
    if (ticket !== openTicket) return;
    if (state.filter.trim() !== '') markFinds({ reveal: true });
    tree.querySelector('.row[aria-current=true]')?.scrollIntoView({ block: 'nearest' });
    if (!fromPlace && can('ui.setPlace')) nendo.ui.setPlace({ noteId: recordId }, { label: state.draft.title.slice(0, 80) || 'Note', replace: state.firstPlace !== false }).catch(() => undefined);
    state.firstPlace = false;
  }

  function startNew(values = {}, body = '') {
    openTicket += 1;
    if (state.note !== null) keepDraft();
    state.note = null;
    const kept = drafts.get('new');
    drafts.delete('new');
    state.draft = kept && !values[F.note.kind] ? { title: kept.title, body: kept.body, values: kept.values ?? {} } : { title: values[F.note.title] ?? '', body, values };
    state.dirty = true;
    state.external = false;
    state.related = { backlinks: [], links: [], noteTags: [], tasks: [] };
    storeDrafts();
    setMode('edit', { quiet: true });
    showNote().then(() => title.focus());
  }

  async function showNote() {
    hideProblem();
    empty.hidden = true;
    noteSection.hidden = false;
    // Only when it differs: setting a field's value moves its caret to the end under the person's typing.
    if (title.value !== state.draft.title) title.value = state.draft.title;
    if (editor.value !== state.draft.body) editor.value = state.draft.body;
    drawMeta();
    drawPreview();
    if (state.note !== null) {
      const shown = state.note, ticket = openTicket;
      let related;
      try { related = await readRelated(nendo, shown.recordId); } catch (error) { related = { backlinks: [], links: [], noteTags: [], tasks: [] }; if (ticket === openTicket && state.note === shown) showProblem(error.message); }
      // The person went to another note while these were read: they belong to a note no longer shown.
      if (ticket !== openTicket || state.note !== shown) return;
      state.related = related;
    }
    drawRelated(state.related, lists, openRecord, state.byId, new Map(state.tags.map(tag => [tag.recordId, { title: tag.values[F.tag.name] }])));
    drawLocalGraph();
    drawTree();
    setStatus();
    expose();
  }

  function drawMeta() {
    const chips = [];
    if (state.note === null) chips.push(chip('New note, not saved yet'));
    else {
      const values = state.note.values;
      chips.push(chip(values[F.note.stage] ?? 'Seed', 'stage', STAGE_TONES[values[F.note.stage]] ?? 'grey'));
      if (values[F.note.kind]) chips.push(chip(values[F.note.kind]));
      if (values[F.note.touched]) chips.push(chip(`tended ${values[F.note.touched]}`));
      if (values[F.note.pinned]) chips.push(chip('pinned'));
      chips.push(chip(values[F.note.slug] ?? '', 'slug'));
    }
    meta.replaceChildren(...chips);
    readingMeta.replaceChildren(...chips.map(element => element.cloneNode(true)));
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
    readingTitle.textContent = state.draft.title.trim() || 'Untitled';
    readingBody.innerHTML = render(state.draft.body, { resolve, interactive: true });
    if (state.mode === 'edit' && state.split < 100) preview.innerHTML = render(state.draft.body, { resolve });
    markFinds();
  }

  // ---- Reading: links follow, tags open, a task's box saves, a link previews its note.
  function onLinkClick(event) {
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
  }
  readingBody.addEventListener('click', onLinkClick);
  preview.addEventListener('click', onLinkClick);
  readingBody.addEventListener('change', event => {
    const box = event.target.closest('input[type=checkbox][data-line]');
    if (box) toggleTask(Number(box.dataset.line), box.checked);
  });
  async function toggleTask(line, done) {
    const lines = state.draft.body.split('\n');
    if (!TASK_LINE.test(lines[line] ?? '')) return;
    lines[line] = lines[line].replace(TASK_LINE, `$1${done ? 'x' : ' '}$3`);
    const wasDirty = state.dirty;
    state.draft.body = lines.join('\n');
    editor.value = state.draft.body;
    state.dirty = true;
    drawPreview();
    storeSoon();
    if (wasDirty) { setStatus('Ticked. Save to keep it with your other changes.'); expose(); return; }
    await save({ quiet: true });
  }

  let hoverTimer = null, hideTimer = null;
  function onLinkOver(event) {
    const link = event.target.closest('a.wikilink[data-id]');
    if (!link) return;
    clearTimeout(hideTimer);
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => showHover(link), 300);
  }
  function onLinkOut(event) {
    if (!event.target.closest('a.wikilink')) return;
    clearTimeout(hoverTimer);
    hideTimer = setTimeout(hideHover, 200);
  }
  function showHover(link) {
    const note = state.byId.get(link.dataset.id);
    if (!note) return;
    $('hover-title').textContent = note.title;
    const body = note.values[F.note.summary] || String(note.values[F.note.body] ?? '').slice(0, 900);
    $('hover-body').innerHTML = body ? render(body, { resolve }) : '<p class="none">Nothing written here yet.</p>';
    hoverCard.hidden = false;
    const box = link.getBoundingClientRect(), card = hoverCard.getBoundingClientRect();
    const left = Math.max(8, Math.min(innerWidth - card.width - 8, box.left));
    const below = box.bottom + 6 + card.height < innerHeight;
    hoverCard.style.left = `${left}px`;
    hoverCard.style.top = `${below ? box.bottom + 6 : Math.max(8, box.top - card.height - 6)}px`;
    expose();
  }
  function hideHover() { clearTimeout(hoverTimer); hoverCard.hidden = true; }
  for (const host of [readingBody, preview]) { host.addEventListener('pointerover', onLinkOver); host.addEventListener('pointerout', onLinkOut); }
  hoverCard.addEventListener('pointerenter', () => clearTimeout(hideTimer));
  hoverCard.addEventListener('pointerleave', () => { hideTimer = setTimeout(hideHover, 150); });

  // ---- The local graph: the note and what it links to and from, one step out.
  const colour = node => node.type === 'tag' ? 'var(--nendo-muted, #5d5d5d)' : `var(--nendo-tone-${STAGE_TONES[node.stage] ?? 'grey'})`;
  let localGraph = null;
  function drawLocalGraph() {
    const card = $('local-graph-card');
    if (state.note === null) { card.hidden = true; return; }
    card.hidden = false;
    try {
      localGraph ??= createGraph($('local-graph'), { kit, colour, compact: true, label: 'This note and its neighbours',
        onOpen: node => open(node.id) });
    } catch (error) { card.hidden = true; return; }
    const data = buildGraph({ notes: state.index, links: state.links }, { focus: state.note.recordId, depth: 1 });
    localGraph.update(data, { focus: state.note.recordId, refit: true });
    $('local-count').textContent = String(data.nodes.length - 1);
    state.local = { nodes: data.nodes.length, links: data.links.length };
  }

  // ---- The divider between the editor and the preview: dragged, or moved with the arrow keys.
  // Where it sits is this person's, so it stays in this browser rather than in the file.
  const panes = $('panes'), splitter = $('splitter');
  const storedSplit = (() => { try { return Number(localStorage.getItem('garden.split')); } catch { return NaN; } })();
  function setSplit(percent, { keep = true } = {}) {
    let value = Math.round(Math.max(20, Math.min(100, Number.isFinite(percent) ? percent : 50)));
    if (value >= 92) value = 100;
    const unfolded = state.split === 100 && value < 100;
    panes.classList.toggle('preview-folded', value === 100);
    panes.style.setProperty('--split', String(value));
    splitter.setAttribute('aria-valuenow', String(value));
    state.split = value;
    if (unfolded && state.draft) drawPreview();
    if (keep) { try { localStorage.setItem('garden.split', String(value)); } catch { /* a private window keeps none */ } }
    expose();
  }
  setSplit(storedSplit > 0 ? storedSplit : 50, { keep: false });
  splitter.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    splitter.setPointerCapture(event.pointerId);
    splitter.classList.add('dragging');
    const box = panes.getBoundingClientRect();
    const move = moved => setSplit((moved.clientX - box.left) / box.width * 100, { keep: false });
    const up = () => {
      splitter.classList.remove('dragging');
      splitter.removeEventListener('pointermove', move);
      splitter.removeEventListener('pointerup', up);
      splitter.removeEventListener('pointercancel', up);
      setSplit(state.split);
    };
    splitter.addEventListener('pointermove', move);
    splitter.addEventListener('pointerup', up);
    splitter.addEventListener('pointercancel', up);
  });
  splitter.addEventListener('dblclick', () => setSplit(50));
  splitter.addEventListener('keydown', event => {
    const step = { ArrowLeft: -5, ArrowRight: 5 }[event.key];
    if (step !== undefined) { event.preventDefault(); setSplit(state.split + step); }
    if (event.key === 'Home') { event.preventDefault(); setSplit(20); }
    if (event.key === 'End') { event.preventDefault(); setSplit(100); }
  });

  // ---- The line between the tree and the page: dragged, or moved with the arrow keys; kept in this browser.
  const treeSplitter = $('tree-splitter'), TREE_WIDTH = 250, TREE_MIN = 160;
  const treeMax = () => Math.max(TREE_MIN, Math.min(720, Math.round(innerWidth * 0.6)));
  function setTreeWidth(px, { keep = true } = {}) {
    const value = Math.round(Math.max(TREE_MIN, Math.min(treeMax(), Number.isFinite(px) ? px : TREE_WIDTH)));
    app.style.setProperty('--tree-width', `${value}px`);
    treeSplitter.setAttribute('aria-valuenow', String(value));
    treeSplitter.setAttribute('aria-valuemax', String(treeMax()));
    state.treeWidth = value;
    if (keep) { try { localStorage.setItem('garden.treeWidth', String(value)); } catch { /* a private window keeps none */ } }
    expose();
  }
  setTreeWidth((() => { try { return Number(localStorage.getItem('garden.treeWidth')) || TREE_WIDTH; } catch { return TREE_WIDTH; } })(), { keep: false });
  treeSplitter.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    treeSplitter.setPointerCapture(event.pointerId);
    treeSplitter.classList.add('dragging');
    app.classList.add('resizing');
    const left = app.getBoundingClientRect().left;
    const move = moved => setTreeWidth(moved.clientX - left, { keep: false });
    const up = () => {
      treeSplitter.classList.remove('dragging');
      app.classList.remove('resizing');
      treeSplitter.removeEventListener('pointermove', move);
      treeSplitter.removeEventListener('pointerup', up);
      treeSplitter.removeEventListener('pointercancel', up);
      setTreeWidth(state.treeWidth);
    };
    treeSplitter.addEventListener('pointermove', move);
    treeSplitter.addEventListener('pointerup', up);
    treeSplitter.addEventListener('pointercancel', up);
  });
  treeSplitter.addEventListener('dblclick', () => setTreeWidth(TREE_WIDTH));
  treeSplitter.addEventListener('keydown', event => {
    const step = { ArrowLeft: -16, ArrowRight: 16 }[event.key];
    if (step !== undefined) { event.preventDefault(); setTreeWidth(state.treeWidth + step); }
    if (event.key === 'Home') { event.preventDefault(); setTreeWidth(TREE_MIN); }
    if (event.key === 'End') { event.preventDefault(); setTreeWidth(treeMax()); }
  });
  // A window made narrower never leaves the tree wider than the page can spare.
  addEventListener('resize', () => { if (state.treeWidth > treeMax()) setTreeWidth(treeMax(), { keep: false }); });

  // ---- The page's width, as the person picks it; kept in this browser.
  function setWidth(level, { keep = true } = {}) {
    state.width = ['narrow', 'medium', 'full'].includes(level) ? level : 'full';
    noteSection.dataset.width = state.width;
    for (const button of $('own-toolbar').querySelectorAll('[data-command=width]')) button.setAttribute('aria-pressed', String(button.dataset.value === state.width));
    if (keep) { try { localStorage.setItem('garden.width', state.width); } catch { /* a private window keeps none */ } }
    expose();
  }
  setWidth((() => { try { return localStorage.getItem('garden.width'); } catch { return null; } })(), { keep: false });

  // ---- View and Edit.
  function setMode(mode, { quiet = false } = {}) {
    state.mode = mode === 'edit' ? 'edit' : 'read';
    noteSection.classList.toggle('reading-mode', state.mode === 'read');
    noteSection.classList.toggle('editing-mode', state.mode === 'edit');
    for (const button of $('own-toolbar').querySelectorAll('[data-command=mode]')) button.setAttribute('aria-pressed', String((button.dataset.value === 'edit') === (state.mode === 'edit')));
    hideHover();
    if (state.draft) drawPreview();
    if (!quiet) declareToolbar();
    expose();
  }

  function edited() {
    state.draft.title = title.value;
    state.draft.body = editor.value;
    state.dirty = true;
    drawPreview();
    setStatus();
    storeSoon();
    expose();
  }
  title.addEventListener('input', edited);
  editor.addEventListener('input', () => { edited(); suggest(); });

  function setStatus(text = null) {
    status.classList.toggle('external', state.external);
    status.textContent = text ?? (state.saving ? 'Saving…' : state.external ? 'This note changed elsewhere. Reload it before saving; your draft is kept.'
      : state.note === null && state.draft ? 'A new note. Save plants it.' : state.dirty ? 'Unsaved changes.' : '');
    ownSummary.textContent = summary();
    declareToolbar();
  }
  function showProblem(text) { state.problem = text; problem.textContent = text; problem.hidden = false; expose(); }
  function hideProblem() { state.problem = null; problem.hidden = true; expose(); }

  // ---- Save: the body becomes records, in one batch the view can undo.
  // One write at a time. What a save sends is fixed when it starts: the note, the draft it came
  // from and the text, so typing that arrives while it travels is never mistaken for what was saved.
  async function save({ quiet = false } = {}) {
    if (!state.draft || state.saving) return;
    if (state.external) { showProblem('This note changed elsewhere, so this draft is kept and not saved. Reload the note, then make your change again.'); return; }
    // A save Nendo never answered goes again as it was, under its key, so it is kept once whatever happened to it.
    if (state.unanswered !== null) { await send(state.unanswered); return; }
    const body = editor.value, noteTitle = title.value;
    const planned = plan({ note: state.note, title: noteTitle, body, parsed: parse(body), index: state.index,
      existing: state.related ?? {}, tags: state.tags, today: today(), newId, values: state.draft.values ?? {} });
    if (planned.problems.length) { showProblem(planned.problems.join(' ')); return; }
    if (planned.writes.length === 0) { state.dirty = false; storeDrafts(); setStatus('Nothing changed.'); return; }
    if (!can('records.batch')) { showProblem('This Nendo does not let views write records.'); return; }
    await send({ noteId: state.note?.recordId ?? null, draft: state.draft, title: noteTitle, body, writes: planned.writes, stubs: planned.stubs,
      label: `Save ${noteTitle.trim().slice(0, 60) || 'note'}`, writeKey: crypto.randomUUID(), quiet });
  }

  async function send(sent) {
    state.saving = true;
    setStatus();
    expose();
    try {
      let result;
      try {
        result = await nendo.records.batch(sent.writes, { label: sent.label, writeKey: sent.writeKey });
      } catch (error) {
        if (uncertain(error)) {
          state.unanswered = sent;
          showProblem(`Nendo did not answer whether the save was kept (${error.code}). Save again to finish it: the same save goes again and is kept once. Your draft is kept.`);
        } else {
          state.unanswered = null;
          showProblem(`The save was refused (${error.code}): ${error.message} Your draft is kept.`);
        }
        return;
      }
      state.unanswered = null;
      hideProblem();
      state.undo.push({ revision: result.revision, label: sent.label });
      state.redo = [];
      state.stubs = sent.stubs.map(stub => stub.recordId);
      const savedId = sent.noteId ?? result.records[0].recordId;
      const saidSaved = sent.stubs.length ? `Saved. Planted ${sent.stubs.length} ${sent.stubs.length === 1 ? 'seed' : 'seeds'}: ${sent.stubs.map(s => s.title).join(', ')}.` : 'Saved.';
      try { await loadIndex(); } catch (error) {
        showProblem(`Saved, but the garden could not be read again (${error.code}): ${error.message} Open the note again to see it.`);
        return;
      }
      const same = draft => draft.title === sent.title && draft.body === sent.body;
      // Still on the note this save came from, or back on it.
      const here = state.draft === sent.draft || (sent.noteId !== null && state.note?.recordId === sent.noteId);
      if (here && same(state.draft)) {
        await open(savedId, { fromPlace: true });
        setStatus(saidSaved);
        return;
      }
      if (here) {
        // Typing arrived while the save travelled: what was sent is saved, the newer text stays a draft on top of it.
        const ticket = ++openTicket;
        const record = await nendo.records.get('gd.note', savedId);
        if (ticket !== openTicket || record === null) return;
        state.note = record;
        state.dirty = true;
        state.external = false;
        storeDrafts();
        await showNote();
        setStatus('Saved what was written when Save was pressed. What you typed since is not saved yet.');
        return;
      }
      // The person went to another note: theirs stays put; the saved note's kept draft is spent, or moves onto the saved version.
      const keptKey = sent.noteId ?? 'new', kept = drafts.get(keptKey);
      if (kept !== undefined) {
        drafts.delete(keptKey);
        if (!same(kept)) drafts.set(savedId, { ...kept, version: state.byId.get(savedId)?.version ?? kept.version });
        storeDrafts();
        drawTree();
      }
      setStatus(`${saidSaved.slice(0, -1)} (${sent.title.trim() || 'note'}).`);
    } finally {
      state.saving = false;
      if (status.textContent === 'Saving…') setStatus();
      declareToolbar();
      expose();
    }
  }

  async function undo() {
    if (state.saving) return;
    const step = state.undo.pop();
    if (!step || !can('records.undo')) return;
    state.saving = true;
    try {
      const result = await nendo.records.undo(step.revision);
      state.redo.push({ revision: result.revision, label: step.label });
      await afterStep();
    } catch (error) { state.undo.push(step); showProblem(`Undo was refused (${error.code}): ${error.message}`); }
    finally { state.saving = false; declareToolbar(); expose(); }
  }
  async function redo() {
    if (state.saving) return;
    const step = state.redo.pop();
    if (!step || !can('records.redo')) return;
    state.saving = true;
    try {
      const result = await nendo.records.redo(step.revision);
      state.undo.push({ revision: result.revision, label: step.label });
      await afterStep();
    } catch (error) { state.redo.push(step); showProblem(`Redo was refused (${error.code}): ${error.message}`); }
    finally { state.saving = false; declareToolbar(); expose(); }
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
  let nativeChrome = false, aboutShown = false, widthIcons = true;
  const WIDTHS = [['narrow', 'Narrow width', 'widthNarrow'], ['medium', 'Medium width', 'widthMedium'], ['full', 'Full width', 'widthFull']];
  function declareToolbar() {
    if (!nativeChrome) return;
    const hasNote = state.draft !== null, editing = state.mode === 'edit';
    nendo.ui.setToolbar({
      items: [
        { kind: 'search', id: 'find', label: 'Find a note', placeholder: 'Find…', value: state.filter, keys: 'Ctrl+Shift+F' },
        { kind: 'button', id: 'new', label: 'New note', icon: 'plus' },
        { kind: 'button', id: 'daily', label: 'Today', icon: 'list' },
        { kind: 'choice', id: 'mode', label: 'Mode', hideLabel: true, value: editing ? 'edit' : 'view',
          options: [{ value: 'view', label: 'View' }, { value: 'edit', label: 'Edit' }] },
        widthIcons
          ? { kind: 'group', label: 'Width', items: WIDTHS.map(([value, label, icon]) => ({ kind: 'toggle', id: `width-${value}`, label, icon, iconOnly: true, pressed: state.width === value })) }
          : { kind: 'choice', id: 'width', label: 'Width', hideLabel: true, value: state.width,
            options: WIDTHS.map(([value, label]) => ({ value, label: label.replace(' width', '') })) },
        { kind: 'button', id: 'save', label: 'Save', icon: 'check', keys: 'Ctrl+S', disabled: !hasNote || !state.dirty || state.saving },
        { kind: 'group', label: 'History', items: [
          { kind: 'button', id: 'undo', label: 'Undo save', icon: 'undo', iconOnly: true, disabled: state.undo.length === 0 || state.saving },
          { kind: 'button', id: 'redo', label: 'Redo save', icon: 'redo', iconOnly: true, disabled: state.redo.length === 0 || state.saving },
        ] },
        { kind: 'text', id: 'summary', text: summary() },
        { kind: 'toggle', id: 'about', label: 'Garden guide', icon: 'info', iconOnly: true, pressed: aboutShown },
        { kind: 'menu', id: 'more', label: 'Note', icon: 'more', items: [
          { id: 'open-record', label: 'Open record page', icon: 'external', disabled: state.note === null },
          { id: 'graph', label: 'Graph of the garden', icon: 'chain' },
          { id: 'evergreen', label: 'Mark evergreen', icon: 'check', disabled: state.note === null },
          { kind: 'separator' },
          { id: 'expand-all', label: 'Expand all', icon: 'chevronRight' },
          { id: 'collapse-all', label: 'Collapse all', icon: 'chevronLeft' },
        ] },
      ],
      add: 'new',
    }).catch(error => {
      // A Nendo from before the width icons refuses the row that names them: say it in words.
      if (widthIcons && /icon/.test(error.message ?? '')) { widthIcons = false; declareToolbar(); return; }
      nativeChrome = false; document.documentElement.classList.remove('native-chrome'); setStatus(error.message);
    });
  }
  async function command(id, value) {
    if (id.startsWith('width-')) { setWidth(id.slice('width-'.length)); declareToolbar(); expose(); return; }
    switch (id) {
      case 'find': setFilter(value); find.value = state.filter; break;
      case 'new': startNew(); break;
      case 'daily': await daily(); break;
      case 'mode': if (state.draft) setMode(value === 'edit' ? 'edit' : 'read'); else declareToolbar(); break;
      case 'edit': if (state.draft) setMode(state.mode === 'edit' ? 'read' : 'edit'); break;
      case 'width': setWidth(value); declareToolbar(); break;
      case 'save': await save(); break;
      case 'undo': await undo(); break;
      case 'redo': await redo(); break;
      case 'open-record': if (state.note) nendo.ui.openRecord('gd.note', state.note.recordId).catch(error => setStatus(error.message)); break;
      case 'graph': if (can('ui.openScreen')) nendo.ui.openScreen('gd.note.graph').catch(error => setStatus(error.message)); break;
      case 'evergreen': await runCommand('gd.cmd.evergreen'); break;
      case 'about': showGuide(typeof value === 'boolean' ? value : !aboutShown); break;
      case 'expand-all': foldAll(false); break;
      case 'collapse-all': foldAll(true); break;
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
    if (button) command(button.dataset.command, button.dataset.value ?? null);
  });
  find.addEventListener('input', () => setFilter(find.value));
  document.addEventListener('keydown', event => {
    const ctrl = (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey;
    if (ctrl && event.key.toLowerCase() === 's') { event.preventDefault(); save(); }
    if (ctrl && event.key.toLowerCase() === 'e' && !event.defaultPrevented) { event.preventDefault(); command('edit', null); }
    if (event.key === 'Escape') { hideHover(); if (aboutShown) showGuide(false); }
  });
  if (can('ui.setToolbar')) {
    nativeChrome = true;
    document.documentElement.classList.add('native-chrome');
    nendo.on('command', ({ id, value }) => { command(id, value); });
  }

  // ---- The Garden guide: how the garden works, with the person's own garden in numbers and a few
  // ways in. A sheet beside the page rather than a dialog, so the page stays usable while it is open.
  let guideReturn = null;
  function showGuide(shown) {
    aboutShown = shown;
    if (shown) {
      if (guide.hidden) guideReturn = document.activeElement;
      drawGuide();
      guide.hidden = false;
      guide.focus({ preventScroll: true });
    } else if (!guide.hidden) {
      guide.hidden = true;
      if (guideReturn?.isConnected) guideReturn.focus({ preventScroll: true });
      guideReturn = null;
    }
    for (const button of $('own-toolbar').querySelectorAll('[data-command=about]')) button.setAttribute('aria-pressed', String(aboutShown));
    declareToolbar();
    expose();
  }
  function drawGuide() {
    const linked = new Set(), into = new Map();
    for (const link of state.links) {
      const from = link.values[F.link.from], to = link.values[F.link.to];
      if (from === to) continue;
      linked.add(from); linked.add(to);
      into.set(to, (into.get(to) ?? 0) + 1);
    }
    const notes = state.index.filter(note => note.values[F.note.kind] !== 'Template');
    const stageOf = note => note.values[F.note.stage] ?? 'Seed';
    const seeds = notes.filter(note => stageOf(note) === 'Seed');
    const lonely = notes.filter(note => !linked.has(note.recordId));
    const stats = { notes: state.index.length, links: state.links.length, tags: state.tags.length, seeds: seeds.length, orphans: lonely.length };
    for (const [name, value] of Object.entries(stats)) guide.querySelector(`[data-stat=${name}]`).textContent = value.toLocaleString();
    state.guide = stats;
    for (const stage of ['Seed', 'Growing', 'Evergreen']) {
      const count = notes.filter(note => stageOf(note) === stage).length;
      guide.querySelector(`[data-stage-count=${stage}]`).textContent = String(count);
      // Drawn from nothing on the next frame, so the bar grows as the guide opens.
      const bar = guide.querySelector(`.stage-bar[data-stage=${stage}]`);
      bar.style.width = '0';
      requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.width = notes.length ? `${count / notes.length * 100}%` : '0'; }));
    }
    // Two ways in: the seed most asked for, and a note nothing links to yet.
    const wanted = [...seeds].sort((a, b) => (into.get(b.recordId) ?? 0) - (into.get(a.recordId) ?? 0) || a.title.localeCompare(b.title))[0];
    const alone = lonely.find(note => note !== wanted);
    const picks = [];
    if (wanted) {
      const asked = into.get(wanted.recordId) ?? 0;
      picks.push(['Grow next: ', wanted, asked ? `, asked for by ${asked} ${asked === 1 ? 'link' : 'links'}.` : ', still a seed.']);
    }
    if (alone) picks.push(['Link up: ', alone, ' has no links in or out yet.']);
    if (!picks.length) picks.push(['Every note is linked and nothing waits to grow. Plant something new.', null, '']);
    $('guide-picks').replaceChildren(...picks.map(([before, note, after]) => {
      const item = document.createElement('li');
      const words = document.createElement('span');
      words.append(before);
      if (note) { const name = document.createElement('b'); name.textContent = note.title; words.append(name); }
      words.append(after);
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.guide = note ? `open:${note.recordId}` : 'new';
      button.textContent = note ? 'Open' : 'New note';
      item.append(words, button);
      return item;
    }));
  }
  guide.addEventListener('click', async event => {
    const link = event.target.closest('.guide-toc a');
    if (link) { event.preventDefault(); guide.querySelector(link.getAttribute('href'))?.scrollIntoView({ block: 'start' }); return; }
    if (event.target.closest('#guide-close')) { showGuide(false); return; }
    const button = event.target.closest('button[data-guide]');
    if (!button) return;
    const action = button.dataset.guide;
    if (action === 'graph') { await command('graph'); return; }
    showGuide(false);
    if (action === 'new') startNew();
    else if (action === 'daily') await daily();
    else if (action.startsWith('open:')) await open(action.slice('open:'.length));
  });
  $('empty').addEventListener('click', event => { if (event.target.closest('button[data-guide=open]')) showGuide(true); });

  // ---- Following the file, and Back and Forward.
  let pending = null;
  async function changed() {
    pending = null;
    // A save on its way changes the note under the draft it came from: look again once it is answered.
    if (state.saving) { pending = setTimeout(changed, 400); return; }
    const current = state.note?.recordId ?? null, ticket = openTicket;
    await loadIndex();
    // The person went to another note while the garden was read: theirs wins, and its own open declares its place.
    if (current === null || ticket !== openTicket) return;
    if (!state.dirty) { await open(current, { fromPlace: true }); return; }
    const latest = state.byId.get(current);
    if (latest === undefined || latest.version !== state.note.version) { state.external = true; setStatus(); expose(); }
    drawLocalGraph();
  }
  nendo.on('changes', () => { if (pending === null) pending = setTimeout(changed, 400); });
  nendo.on('context', () => { if (pending === null) pending = setTimeout(changed, 400); });
  nendo.on('place', place => { if (place?.noteId) open(place.noteId, { fromPlace: true }); });

  setMode('read', { quiet: true });
  await loadIndex();
  state.ready = true;
  expose();
  // The garden opens on the place Back left, or on its first pinned map, or on its first note.
  const pinned = state.index.find(note => note.values[F.note.pinned] && note.values[F.note.kind] === 'Map') ?? state.index.find(note => note.values[F.note.pinned]);
  const start = context.place?.noteId && state.byId.has(context.place.noteId) ? context.place.noteId : pinned?.recordId ?? null;
  if (start) await open(start, { fromPlace: !!context.place?.noteId });
  else setStatus('');
  if (state.restored > 0) setStatus(`${state.restored === 1 ? 'An unsaved draft was' : `${state.restored} unsaved drafts were`} kept from before; the tree marks ${state.restored === 1 ? 'its note' : 'their notes'}.`);
}
