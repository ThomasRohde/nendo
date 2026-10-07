// The Graph screen: the whole garden as a living d3 graph. Its controls are Nendo's: find, colour
// by stage, kind or branch (the section of the garden a note grows in), tag dots, orphans, arrows,
// spread and fit. A click opens a note; a right-click offers its neighbourhood. The file's changes
// flow in without losing the layout.
//
// Highlighting picks notes out without moving the camera: a tag in the panel beside the graph, a
// colour in the legend, or a tag dot. A note with several tags is picked out when what is chosen
// asks for one of them; two tags or more highlight the notes that carry all of them, or any, as the
// person says; a colour and tags together highlight the notes that are both; Find narrows it as
// well. Hovering a note still shows its own neighbourhood over the highlight. Esc clears it.
import { buildGraph, branchTones } from './graph-data.mjs';
import { createGraph } from './graph.js';
import { createFinder } from './search.mjs';

const $ = id => document.getElementById(id);

export async function startGraphScreen(nendo, context, kit) {
  const screen = $('graph-screen'), canvas = $('graph-canvas'), problem = $('graph-problem'), summaryLine = $('graph-summary');
  screen.hidden = false;
  document.body.classList.add('graph-mode');
  const can = name => typeof nendo.has === 'function' && nendo.has(name);
  // Colour starts by branch when the garden has a tree, so each section shows; otherwise by stage.
  const options = { colour: null, tags: false, orphans: true, arrows: false, spread: 'normal', query: '', ids: null, focus: null, about: false,
    tagged: new Set(), match: 'all', group: null };
  const state = { ready: false, data: null, options, records: null, highlight: null };
  const expose = () => { window.gardenGraph = { ...state, graph, state: () => graph.state() }; };

  let choices = { stage: [], kind: [] };
  try {
    const schema = await nendo.schema.describe();
    const fields = schema.entities.find(entity => entity.entityId === 'gd.note')?.fields ?? [];
    choices = { stage: fields.find(f => f.fieldId === 'gd.note.stage')?.choices ?? [], kind: fields.find(f => f.fieldId === 'gd.note.kind')?.choices ?? [] };
  } catch { /* the schema is a nicety: grey is still a colour */ }

  let tones = new Map();
  const colour = node => node.type === 'tag' ? 'var(--nendo-muted, #5d5d5d)'
    : options.colour === 'branch' ? `var(--nendo-tone-${tones.get(node.branch) ?? 'grey'})` : kit.toneFor(node[options.colour], choices[options.colour]);
  const openRecord = node => {
    const entityId = node.type === 'tag' ? 'gd.tag' : 'gd.note';
    nendo.ui.openRecord(entityId, node.id).catch(error => showProblem(error.message));
  };
  // A click on a note opens it; a click on a tag dot highlights the notes that carry the tag.
  const open = node => { if (node.type === 'tag') toggleTag(node.id); else openRecord(node); };
  const onContext = async (node, event) => {
    if (!can('ui.showMenu')) { openRecord(node); return; }
    const pick = await nendo.ui.showMenu([
      { id: 'open', label: node.type === 'tag' ? 'Open tag' : 'Open note', icon: 'external' },
      { id: 'focus', label: 'Show its neighbourhood', icon: 'focus' },
      ...(options.focus ? [{ id: 'all', label: 'Show the whole garden', icon: 'fit' }] : []),
    ], event).catch(() => null);
    if (pick?.id === 'open') openRecord(node);
    if (pick?.id === 'focus') { options.focus = node.id; draw({ refit: true }); }
    if (pick?.id === 'all') { options.focus = null; draw({ refit: true }); }
  };
  const graph = createGraph(canvas, { kit, colour, onOpen: open, onContext, label: 'The garden: notes and their links' });

  // What the colours mean: the branches, stages or kinds the drawing shows, in their own order.
  // Each is a button: pressed, it highlights the notes of that colour.
  function drawLegend() {
    const legend = $('graph-legend');
    const shown = new Set(state.data.nodes.filter(n => n.type === 'note').map(n => n[options.colour]).filter(value => value != null));
    const titles = new Map(state.records.notes.map(note => [note.recordId, note.values['gd.note.title'] ?? note.recordId]));
    const entries = options.colour === 'branch'
      ? [...tones].filter(([id]) => shown.has(id)).map(([id, tone]) => [id, titles.get(id), `var(--nendo-tone-${tone})`])
      : choices[options.colour].filter(choice => shown.has(choice.id)).map(choice => [choice.id, choice.displayName ?? choice.id, kit.toneFor(choice.id, choices[options.colour])]);
    legend.replaceChildren(...entries.map(([value, label, tone]) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'chip';
      item.dataset.value = value;
      item.setAttribute('aria-pressed', String(options.group === value));
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = tone;
      item.append(dot, document.createTextNode(label));
      return item;
    }));
    legend.classList.toggle('picking', options.group !== null);
    legend.hidden = entries.length === 0;
  }
  $('graph-legend').addEventListener('click', event => {
    const button = event.target.closest('button[data-value]');
    if (!button) return;
    options.group = options.group === button.dataset.value ? null : button.dataset.value;
    applyHighlight();
  });

  // ---- The highlight: the notes a tag, a colour or both pick out.
  let tagsOf = new Map(), carriers = new Map();
  function indexTags() {
    tagsOf = new Map(); carriers = new Map();
    for (const row of state.records.noteTags) {
      const note = row.values['gd.noteTag.note'], tag = row.values['gd.noteTag.tag'];
      if (!tagsOf.has(note)) tagsOf.set(note, new Set());
      tagsOf.get(note).add(tag);
      if (!carriers.has(tag)) carriers.set(tag, new Set());
      carriers.get(tag).add(note);
    }
  }
  const carries = noteId => {
    if (options.tagged.size === 0) return true;
    const own = tagsOf.get(noteId) ?? new Set();
    return options.match === 'any' ? [...options.tagged].some(tag => own.has(tag)) : [...options.tagged].every(tag => own.has(tag));
  };
  const inGroup = node => options.group === null || node[options.colour] === options.group;
  function highlighted() {
    if (options.tagged.size === 0 && options.group === null) return null;
    const picked = new Set();
    for (const node of state.data.nodes) {
      if (node.type === 'tag') { if (options.tagged.has(node.id)) picked.add(node.id); continue; }
      if (carries(node.id) && inGroup(node)) picked.add(node.id);
    }
    return picked;
  }
  function applyHighlight() {
    const picked = highlighted();
    graph.select(picked);
    const notes = picked === null ? null : state.data.nodes.filter(node => node.type === 'note' && picked.has(node.id)).length;
    state.highlight = picked === null ? null : { tags: [...options.tagged], match: options.match, group: options.group, notes };
    drawLegend();
    drawTagPanel(notes);
    summarise();
    expose();
  }
  function toggleTag(tagId) {
    if (options.tagged.has(tagId)) options.tagged.delete(tagId); else options.tagged.add(tagId);
    applyHighlight();
  }
  function clearHighlight() {
    options.tagged.clear();
    options.group = null;
    applyHighlight();
  }

  // ---- The tags beside the graph, in the order of how many notes carry each, which stays put
  // while the person clicks. With tags chosen to match all of, each other tag says how many of the
  // highlighted notes carry it, so a tag that would leave nothing is seen before it is clicked.
  const tagPanel = $('graph-tags'), tagList = $('graph-tags-list');
  let panelOpen = (() => { try { const kept = localStorage.getItem('garden.graphTags'); return kept === null ? innerWidth >= 900 : kept === 'open'; } catch { return innerWidth >= 900; } })();
  function showPanel(open) {
    panelOpen = open;
    try { localStorage.setItem('garden.graphTags', open ? 'open' : 'closed'); } catch { /* a private window keeps none */ }
    drawTagPanel(state.highlight?.notes ?? null);
  }
  function drawTagPanel(notes) {
    const tags = state.records?.tags ?? [];
    const has = tags.length > 0;
    tagPanel.hidden = !has || !panelOpen;
    $('graph-tags-show').hidden = !has || panelOpen;
    if (!has) return;
    const names = new Map(tags.map(tag => [tag.recordId, tag.values['gd.tag.name'] ?? tag.recordId]));
    const size = id => carriers.get(id)?.size ?? 0;
    const ordered = [...tags].filter(tag => size(tag.recordId) > 0 || options.tagged.has(tag.recordId))
      .sort((a, b) => size(b.recordId) - size(a.recordId) || names.get(a.recordId).localeCompare(names.get(b.recordId)));
    const narrowing = options.tagged.size > 0 && options.match === 'all';
    const shownNotes = state.data.nodes.filter(node => node.type === 'note');
    const focused = tagList.contains(document.activeElement) ? document.activeElement.dataset.tag : null;
    tagList.replaceChildren(...ordered.map(tag => {
      const id = tag.recordId, pressed = options.tagged.has(id);
      const count = narrowing && !pressed ? shownNotes.filter(node => carries(node.id) && inGroup(node) && tagsOf.get(node.id)?.has(id)).length : size(id);
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.tag = id;
      button.setAttribute('aria-pressed', String(pressed));
      button.classList.toggle('empty', !pressed && count === 0);
      const name = document.createElement('span');
      name.textContent = `#${names.get(id)}`;
      const number = document.createElement('span');
      number.className = 'count';
      number.textContent = String(count);
      button.append(name, number);
      button.title = narrowing && !pressed ? `${count} of the highlighted notes carry #${names.get(id)}` : `${count} ${count === 1 ? 'note carries' : 'notes carry'} #${names.get(id)}`;
      item.append(button);
      return item;
    }));
    if (focused) tagList.querySelector(`button[data-tag="${CSS.escape(focused)}"]`)?.focus();
    $('graph-tags-match').hidden = options.tagged.size < 2;
    for (const button of $('graph-tags-match').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.match === options.match));
    $('graph-tags-clear').hidden = options.tagged.size === 0 && options.group === null;
    const result = $('graph-tags-result');
    if (notes === null || notes === undefined) result.textContent = 'Click a tag to highlight the notes that carry it.';
    else if (notes === 0) result.textContent = options.tagged.size > 1 && options.match === 'all' ? 'No note carries all of these. Try Any of them.' : 'No note shown here is picked out.';
    else result.textContent = `${notes} ${notes === 1 ? 'note' : 'notes'} highlighted.`;
  }
  tagList.addEventListener('click', event => { const button = event.target.closest('button[data-tag]'); if (button) toggleTag(button.dataset.tag); });
  $('graph-tags-match').addEventListener('click', event => {
    const button = event.target.closest('button[data-match]');
    if (!button || options.match === button.dataset.match) return;
    options.match = button.dataset.match;
    applyHighlight();
  });
  $('graph-tags-clear').addEventListener('click', clearHighlight);
  $('graph-tags-hide').addEventListener('click', () => { showPanel(false); $('graph-tags-show').focus(); });
  $('graph-tags-show').addEventListener('click', () => { showPanel(true); tagList.querySelector('button')?.focus(); });

  function summarise() {
    if (!state.data) return;
    const notes = state.data.nodes.filter(n => n.type === 'note').length;
    const text = `${notes} ${notes === 1 ? 'note' : 'notes'} · ${state.data.links.filter(l => l.type === 'link').length} links${options.focus ? ' · neighbourhood' : ''}${state.highlight ? ` · ${state.highlight.notes} highlighted` : ''}${state.data.hidden ? ` · ${state.data.hidden} to notes not shown` : ''}`;
    if (text === summaryLine.textContent) return;
    summaryLine.textContent = text;
    declare(text);
  }

  function showProblem(text) { problem.textContent = text; problem.hidden = !text; }

  async function load({ refit = false } = {}) {
    try {
      const [notes, links, tags, noteTags] = await Promise.all([
        nendo.records.queryAll({ entityId: 'gd.note' }, { max: 10000 }),
        nendo.records.queryAll({ entityId: 'gd.link' }, { max: 10000 }),
        nendo.records.queryAll({ entityId: 'gd.tag' }, { max: 5000 }),
        nendo.records.queryAll({ entityId: 'gd.noteTag' }, { max: 10000 }),
      ]);
      state.records = { notes, links, tags, noteTags };
      showProblem('');
    } catch (error) {
      showProblem(`The garden could not be read: ${error.message}`);
      return;
    }
    draw({ refit });
  }

  function draw({ refit = false } = {}) {
    if (!state.records) return;
    tones = branchTones(state.records.notes);
    options.colour ??= tones.size ? 'branch' : 'stage';
    state.data = buildGraph(state.records, { showTags: options.tags, showOrphans: options.orphans, focus: options.focus, depth: 2 });
    indexTags();
    // A chosen tag or colour that is gone from the garden is let go.
    for (const tag of [...options.tagged]) if (!carriers.has(tag)) options.tagged.delete(tag);
    if (options.group !== null && !state.data.nodes.some(node => node.type === 'note' && node[options.colour] === options.group)) options.group = null;
    graph.update(state.data, { focus: options.focus, refit });
    graph.setOptions({ arrows: options.arrows, spread: options.spread, query: options.query, ids: options.ids });
    state.ready = true;
    summaryLine.textContent = '';
    applyHighlight();
  }

  // ---- Controls: Nendo's row where offered, the view's own row otherwise.
  let native = false;
  function declare(summary) {
    if (!native) { drawOwnToolbar(); return; }
    nendo.ui.setToolbar({ items: [
      { kind: 'search', id: 'find', label: 'Find a note', placeholder: 'Find…', value: options.query, keys: 'Ctrl+Shift+F' },
      { kind: 'choice', id: 'colour', label: 'Colour by', options: [{ value: 'stage', label: 'Stage' }, { value: 'kind', label: 'Kind' }, { value: 'branch', label: 'Branch' }], value: options.colour },
      { kind: 'toggle', id: 'tags', label: 'Tag dots', icon: 'layers', pressed: options.tags },
      { kind: 'toggle', id: 'orphans', label: 'Orphans', pressed: options.orphans },
      { kind: 'toggle', id: 'arrows', label: 'Arrows', icon: 'arrowUp', pressed: options.arrows },
      { kind: 'select', id: 'spread', label: 'Spread', options: [{ value: 'tight', label: 'Tight' }, { value: 'normal', label: 'Normal' }, { value: 'loose', label: 'Loose' }], value: options.spread },
      { kind: 'text', id: 'summary', text: summary },
      { kind: 'group', label: 'Zoom', items: [
        { kind: 'button', id: 'zoom-out', label: 'Zoom out', icon: 'minus', iconOnly: true, keys: 'Ctrl+-' },
        { kind: 'button', id: 'fit', label: 'Fit', icon: 'fit', keys: 'Ctrl+0' },
        { kind: 'button', id: 'zoom-in', label: 'Zoom in', icon: 'plus', iconOnly: true, keys: 'Ctrl+Plus' },
      ] },
      ...(options.focus ? [{ kind: 'button', id: 'all', label: 'Whole garden', icon: 'fit' }] : []),
      { kind: 'toggle', id: 'about', label: 'About', icon: 'info', iconOnly: true, pressed: options.about },
    ] }).catch(error => { native = false; document.documentElement.classList.remove('native-chrome'); showProblem(error.message); drawOwnToolbar(); });
  }
  function drawOwnToolbar() {
    const bar = $('graph-toolbar');
    bar.hidden = false;
    for (const button of bar.querySelectorAll('[data-command]')) {
      if (button.dataset.toggle) button.setAttribute('aria-pressed', String(options[button.dataset.command] === true));
    }
  }
  function command(id, value) {
    switch (id) {
      // Names match at once; the notes Nendo's search finds by their text follow (ADR-0028).
      case 'find': options.query = value ?? ''; options.ids = null; graph.search(options.query, null); finder.find(options.query); break;
      case 'colour': options.colour = ['kind', 'branch'].includes(value) ? value : 'stage'; options.group = null; draw(); return;
      case 'tags': options.tags = typeof value === 'boolean' ? value : !options.tags; load({ refit: true }); return;
      case 'orphans': options.orphans = typeof value === 'boolean' ? value : !options.orphans; draw({ refit: true }); return;
      case 'arrows': options.arrows = typeof value === 'boolean' ? value : !options.arrows; graph.setOptions({ arrows: options.arrows }); break;
      case 'spread': options.spread = ['tight', 'normal', 'loose'].includes(value) ? value : 'normal'; graph.setOptions({ spread: options.spread }); break;
      case 'fit': graph.fit(); break;
      case 'zoom-in': graph.zoomBy(1.4); break;
      case 'zoom-out': graph.zoomBy(1 / 1.4); break;
      case 'all': options.focus = null; draw({ refit: true }); return;
      case 'about': options.about = typeof value === 'boolean' ? value : !options.about; $('about-graph').hidden = !options.about; break;
      default: return;
    }
    declare(summaryLine.textContent);
    expose();
  }
  $('graph-toolbar').addEventListener('click', event => {
    const button = event.target.closest('[data-command]');
    if (button) command(button.dataset.command, button.dataset.value ?? null);
  });
  const finder = createFinder(nendo, {
    entityId: 'gd.note',
    onResult(hits, text) {
      if (text !== options.query.trim()) return;
      options.ids = hits === null ? null : new Set(hits.keys());
      graph.search(options.query, options.ids);
      expose();
    },
  });
  $('graph-find').addEventListener('input', event => command('find', event.target.value));
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (options.about) command('about', false);
    else if (options.tagged.size > 0 || options.group !== null) clearHighlight();
  });
  if (can('ui.setToolbar')) {
    native = true;
    document.documentElement.classList.add('native-chrome');
    nendo.on('command', ({ id, value }) => command(id, value));
  }

  let pending = null;
  const schedule = () => { if (pending === null) pending = setTimeout(() => { pending = null; load(); }, 300); };
  nendo.on('changes', schedule);
  nendo.on('context', schedule);
  await load();
}
