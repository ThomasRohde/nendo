// The Graph screen: the whole garden as a living d3 graph. Its controls are Nendo's: find,
// colour by stage or kind, tags as nodes, orphans, arrows, spread and fit. A click opens a note;
// a right-click offers its neighbourhood. The file's changes flow in without losing the layout.
import { buildGraph } from './graph-data.mjs';
import { createGraph } from './graph.js';
import { createFinder } from './search.mjs';

const $ = id => document.getElementById(id);

export async function startGraphScreen(nendo, context, kit) {
  const screen = $('graph-screen'), canvas = $('graph-canvas'), problem = $('graph-problem'), summaryLine = $('graph-summary');
  screen.hidden = false;
  document.body.classList.add('graph-mode');
  const can = name => typeof nendo.has === 'function' && nendo.has(name);
  const options = { colour: 'stage', tags: false, orphans: true, arrows: false, spread: 'normal', query: '', ids: null, focus: null, about: false };
  const state = { ready: false, data: null, options, records: null };
  const expose = () => { window.gardenGraph = { ...state, graph, state: () => graph.state() }; };

  let choices = { stage: [], kind: [] };
  try {
    const schema = await nendo.schema.describe();
    const fields = schema.entities.find(entity => entity.entityId === 'gd.note')?.fields ?? [];
    choices = { stage: fields.find(f => f.fieldId === 'gd.note.stage')?.choices ?? [], kind: fields.find(f => f.fieldId === 'gd.note.kind')?.choices ?? [] };
  } catch { /* the schema is a nicety: grey is still a colour */ }

  const colour = node => node.type === 'tag' ? 'var(--nendo-muted, #5d5d5d)' : kit.toneFor(node[options.colour], choices[options.colour]);
  const open = node => {
    const entityId = node.type === 'tag' ? 'gd.tag' : 'gd.note';
    nendo.ui.openRecord(entityId, node.id).catch(error => showProblem(error.message));
  };
  const onContext = async (node, event) => {
    if (!can('ui.showMenu')) { open(node); return; }
    const pick = await nendo.ui.showMenu([
      { id: 'open', label: node.type === 'tag' ? 'Open tag' : 'Open note', icon: 'external' },
      { id: 'focus', label: 'Show its neighbourhood', icon: 'focus' },
      ...(options.focus ? [{ id: 'all', label: 'Show the whole garden', icon: 'fit' }] : []),
    ], event).catch(() => null);
    if (pick?.id === 'open') open(node);
    if (pick?.id === 'focus') { options.focus = node.id; draw({ refit: true }); }
    if (pick?.id === 'all') { options.focus = null; draw({ refit: true }); }
  };
  const graph = createGraph(canvas, { kit, colour, onOpen: open, onContext, label: 'The garden: notes and their links' });

  function showProblem(text) { problem.textContent = text; problem.hidden = !text; }

  async function load({ refit = false } = {}) {
    try {
      const [notes, links, tags, noteTags] = await Promise.all([
        nendo.records.queryAll({ entityId: 'gd.note' }, { max: 10000 }),
        nendo.records.queryAll({ entityId: 'gd.link' }, { max: 10000 }),
        options.tags ? nendo.records.queryAll({ entityId: 'gd.tag' }, { max: 5000 }) : [],
        options.tags ? nendo.records.queryAll({ entityId: 'gd.noteTag' }, { max: 10000 }) : [],
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
    state.data = buildGraph(state.records, { showTags: options.tags, showOrphans: options.orphans, focus: options.focus, depth: 2 });
    graph.update(state.data, { focus: options.focus, refit });
    graph.setOptions({ arrows: options.arrows, spread: options.spread, query: options.query, ids: options.ids });
    const notes = state.data.nodes.filter(n => n.type === 'note').length;
    const text = `${notes} ${notes === 1 ? 'note' : 'notes'} · ${state.data.links.filter(l => l.type === 'link').length} links${options.focus ? ' · neighbourhood' : ''}${state.data.hidden ? ` · ${state.data.hidden} to notes not shown` : ''}`;
    summaryLine.textContent = text;
    declare(text);
    state.ready = true;
    expose();
  }

  // ---- Controls: Nendo's row where offered, the view's own row otherwise.
  let native = false;
  function declare(summary) {
    if (!native) { drawOwnToolbar(); return; }
    nendo.ui.setToolbar({ items: [
      { kind: 'search', id: 'find', label: 'Find a note', placeholder: 'Find…', value: options.query, keys: 'Ctrl+Shift+F' },
      { kind: 'choice', id: 'colour', label: 'Colour by', options: [{ value: 'stage', label: 'Stage' }, { value: 'kind', label: 'Kind' }], value: options.colour },
      { kind: 'toggle', id: 'tags', label: 'Tags', icon: 'layers', pressed: options.tags },
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
      case 'colour': options.colour = value === 'kind' ? 'kind' : 'stage'; draw(); return;
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
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && options.about) command('about', false); });
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
