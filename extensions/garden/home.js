// The Overview: the garden's front page, led by its graph. Beside the graph, how many notes and
// links there are, a box that finds a note or names a new one, the stages and the unlinked notes,
// each a button that picks its notes out on the graph. Under it, the pinned notes and the notes
// tended lately as cards with their first line, the tasks due next and the tags.
//
// A note picked here opens in the Garden view, not on its record page: the request is handed over
// through the package's storage (handover.mjs) and the Garden screen is opened. A host without
// ui.openScreen opens the record page instead.
import { buildGraph } from './graph-data.mjs';
import { createGraph } from './graph.js';
import { createFinder } from './search.mjs';
import { overview, findNotes, whenTended } from './home-data.mjs';
import { handOver } from './handover.mjs';
import { F } from './sync.mjs';

const $ = id => document.getElementById(id);
const GARDEN_VIEW = 'gd.garden';
const GRAPH_SCREEN = 'gd.note.graph';
const STAGE_TONES = { Seed: 'amber', Growing: 'teal', Evergreen: 'green' };

const today = () => { const d = new Date(), pad = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const element = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('data-') || key.startsWith('aria-') || key === 'role' || key === 'type' || key === 'title') node.setAttribute(key, value);
    else node[key] = value;
  }
  node.append(...children.filter(child => child !== null && child !== undefined));
  return node;
};

export async function startHome(nendo, context, kit) {
  const home = $('home');
  home.hidden = false;
  document.body.classList.add('home-mode');
  const can = name => typeof nendo.has === 'function' && nendo.has(name);
  const locale = context.locale ?? 'en';
  const state = { ready: false, records: null, view: null, picked: new Set(), unlinkedPicked: false, tagPicked: null, query: '', ids: null, found: [], active: -1, opened: [], problem: '' };
  const expose = () => { window.gardenHome = state; };

  let stages = [];
  try {
    const schema = await nendo.schema.describe();
    stages = schema.entities.find(entity => entity.entityId === 'gd.note')?.fields.find(field => field.fieldId === F.note.stage)?.choices ?? [];
  } catch { /* without the schema the stages come from the notes, in the order they are met */ }
  const tone = stage => stages.some(choice => choice.id === stage && choice.tone) ? kit.toneFor(stage, stages) : `var(--nendo-tone-${STAGE_TONES[stage] ?? 'grey'})`;

  function showProblem(text) { state.problem = text; $('home-problem').textContent = text; $('home-problem').hidden = !text; expose(); }

  // ---- Going somewhere: a note in the Garden view, the Graph screen, a new note, today's note.
  async function inGarden(request, fallbackNote = null) {
    state.opened.push(request);
    expose();
    if (can('ui.openScreen') && handOver(request)) {
      try { await nendo.ui.openScreen(GARDEN_VIEW); return; } catch (error) { showProblem(error.message); return; }
    }
    if (fallbackNote) nendo.ui.openRecord('gd.note', fallbackNote).catch(error => showProblem(error.message));
    else showProblem('This Nendo cannot open the Garden view from here. Open it from the list of screens.');
  }
  const openNote = id => inGarden({ open: id }, id);
  const plant = title => inGarden({ plant: title });
  const daily = () => inGarden({ daily: true });
  const openGraph = () => {
    if (!can('ui.openScreen')) { showProblem('This Nendo cannot open the Graph screen from here.'); return; }
    nendo.ui.openScreen(GRAPH_SCREEN).catch(error => showProblem(error.message));
  };

  // ---- The graph: the whole garden, coloured by stage, as the buttons beside it that pick a stage out.
  const colour = node => tone(node.stage);
  const graph = createGraph($('home-graph'), { kit, colour, onOpen: node => openNote(node.id), label: 'The garden: notes and their links' });

  // What is picked out on the graph: the pressed stages, the unlinked notes, a tag, and what Find found.
  function applyPicks() {
    const view = state.view;
    if (!view) return;
    let picked = null;
    const add = ids => { picked ??= new Set(); for (const id of ids) picked.add(id); };
    if (state.picked.size) add(state.records.notes.filter(note => state.picked.has(note.values[F.note.stage])).map(note => note.recordId));
    if (state.unlinkedPicked) add(view.unlinked);
    if (state.tagPicked) add(state.records.noteTags.filter(row => row.values[F.noteTag.tag] === state.tagPicked).map(row => row.values[F.noteTag.note]));
    graph.select(picked);
    for (const button of $('home-stages').querySelectorAll('button')) button.setAttribute('aria-pressed', String(state.picked.has(button.dataset.stage)));
    $('home-unlinked').setAttribute('aria-pressed', String(state.unlinkedPicked));
    for (const button of $('home-tags').querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.tag === state.tagPicked));
    state.highlighted = picked === null ? null : picked.size;
    expose();
  }
  function clearPicks() { state.picked.clear(); state.unlinkedPicked = false; state.tagPicked = null; applyPicks(); }

  // ---- Find: the notes it matches light up on the graph and are listed under the box; Enter opens
  // the first, and words no note is titled offer a new note of that name.
  const input = $('home-find'), list = $('home-found');
  const finder = createFinder(nendo, {
    entityId: 'gd.note',
    onResult(hits, text) {
      if (text !== state.query.trim()) return;
      state.ids = hits === null ? null : new Set(hits.keys());
      drawFound();
    },
  });
  function drawFound() {
    const text = state.query.trim();
    graph.search(text, state.ids);
    if (!text) { list.hidden = true; input.setAttribute('aria-expanded', 'false'); state.found = []; state.active = -1; expose(); return; }
    const { notes, exact } = findNotes(state.records?.notes ?? [], text, state.ids);
    state.found = [...notes.map(note => ({ kind: 'open', ...note })), ...(exact ? [] : [{ kind: 'plant', id: null, title: text }])];
    state.active = state.found.length ? Math.min(Math.max(state.active, 0), state.found.length - 1) : -1;
    list.replaceChildren(...state.found.map((item, index) => {
      const option = element('li', { role: 'option', id: `home-found-${index}`, 'aria-selected': String(index === state.active), 'data-index': String(index) });
      if (item.kind === 'plant') option.append(element('span', { className: 'plant-label', text: 'New note ' }), element('b', { text: `“${item.title}”` }));
      else option.append(element('span', { className: 'dot', style: `background:${tone(item.stage)}` }), element('span', { text: item.title }));
      return option;
    }));
    list.hidden = state.found.length === 0;
    input.setAttribute('aria-expanded', String(!list.hidden));
    if (state.active >= 0) input.setAttribute('aria-activedescendant', `home-found-${state.active}`); else input.removeAttribute('aria-activedescendant');
    expose();
  }
  const choose = item => { if (!item) return; if (item.kind === 'plant') plant(item.title); else openNote(item.id); };
  input.addEventListener('input', () => { state.query = input.value; state.ids = null; state.active = 0; drawFound(); finder.find(state.query); });
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!state.found.length) return;
      event.preventDefault();
      state.active = (state.active + (event.key === 'ArrowDown' ? 1 : -1) + state.found.length) % state.found.length;
      drawFound();
    } else if (event.key === 'Enter') { event.preventDefault(); choose(state.found[state.active] ?? state.found[0]); }
    else if (event.key === 'Escape' && input.value) { event.preventDefault(); event.stopPropagation(); input.value = ''; state.query = ''; state.ids = null; drawFound(); }
  });
  list.addEventListener('pointerdown', event => event.preventDefault());
  list.addEventListener('click', event => { const option = event.target.closest('li[data-index]'); if (option) choose(state.found[Number(option.dataset.index)]); });

  // ---- The page around the graph.
  function card(note) {
    const when = whenTended(note.touched, today(), locale);
    const button = element('button', { type: 'button', className: 'home-card', 'data-id': note.id },
      element('span', { className: 'home-card-stage' }, element('span', { className: 'dot', style: `background:${tone(note.stage)}` }), note.stage ? `${note.stage}${when ? ` · ${when}` : ''}` : when),
      element('span', { className: 'home-card-title', text: note.title }),
      note.excerpt ? element('span', { className: 'home-card-text', text: note.excerpt }) : element('span', { className: 'home-card-text none', text: 'Nothing written yet.' }),
      element('span', { className: 'home-card-links', text: `${note.linksIn} in · ${note.linksOut} out` }));
    button.style.setProperty('--stage', tone(note.stage));
    return element('li', {}, button);
  }

  function draw() {
    const view = state.view;
    $('home-notes').textContent = String(view.counts.notes);
    $('home-notes-word').textContent = view.counts.notes === 1 ? 'note' : 'notes';
    $('home-links').textContent = String(view.counts.links);
    $('home-links-word').textContent = view.counts.links === 1 ? 'link' : 'links';

    $('home-stages').replaceChildren(...view.stages.map(stage => element('button', { type: 'button', 'data-stage': stage.id, 'aria-pressed': 'false', title: `Pick out the ${stage.label.toLowerCase()} notes on the graph` },
      element('span', { className: 'dot', style: `background:${tone(stage.id)}` }), element('span', { className: 'name', text: stage.id === 'Seed' ? 'Seeds to write' : stage.label }),
      element('b', { text: String(stage.count) }))));
    const unlinked = $('home-unlinked');
    unlinked.hidden = view.counts.unlinked === 0;
    unlinked.textContent = view.counts.unlinked === 1 ? '1 note has no links yet' : `${view.counts.unlinked} notes have no links yet`;
    $('home-graph-action').hidden = !can('ui.openScreen');

    $('home-pinned-section').hidden = view.pinned.length === 0;
    $('home-pinned').replaceChildren(...view.pinned.map(card));
    $('home-lately-section').hidden = view.lately.length === 0;
    $('home-lately').replaceChildren(...view.lately.map(card));

    $('home-tasks-count').textContent = view.counts.openTasks ? `· ${view.counts.openTasks} open` : '';
    $('home-tasks').replaceChildren(...(view.due.length ? view.due.map(task => element('li', {},
      element('button', { type: 'button', className: 'home-task', 'data-note': task.noteId ?? '', disabled: !task.noteId },
        element('span', { className: 'home-task-title', text: task.title }),
        element('span', { className: 'home-task-meta', text: [task.due ? whenDue(task.due) : null, task.note].filter(Boolean).join(' · ') }))))
      : [element('li', { className: 'none', text: 'No open tasks. A line that starts with - [ ] in a note is one.' })]));

    $('home-tags-card').hidden = view.tags.length === 0;
    $('home-tags').replaceChildren(...view.tags.map(tag => element('li', {},
      element('button', { type: 'button', className: `home-tag size-${tag.size}`, 'data-tag': tag.id, 'aria-pressed': 'false', title: `Pick out the ${tag.count} ${tag.count === 1 ? 'note' : 'notes'} tagged #${tag.name} on the graph` },
        `#${tag.name}`, element('span', { className: 'count', text: String(tag.count) })))));
    applyPicks();
  }
  const whenDue = date => {
    const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / 86_400_000);
    if (days < 0) return `overdue since ${whenTended(date, today(), locale)}`;
    if (days === 0) return 'due today';
    if (days === 1) return 'due tomorrow';
    return `due ${new Date(Date.parse(`${date}T00:00:00Z`)).toLocaleDateString(locale, { weekday: days < 7 ? 'long' : undefined, day: days < 7 ? undefined : 'numeric', month: days < 7 ? undefined : 'short', timeZone: 'UTC' })}`;
  };

  $('home-stages').addEventListener('click', event => {
    const button = event.target.closest('button[data-stage]');
    if (!button) return;
    const stage = button.dataset.stage;
    if (state.picked.has(stage)) state.picked.delete(stage); else state.picked.add(stage);
    applyPicks();
  });
  $('home-unlinked').addEventListener('click', () => { state.unlinkedPicked = !state.unlinkedPicked; applyPicks(); });
  $('home-tags').addEventListener('click', event => {
    const button = event.target.closest('button[data-tag]');
    if (!button) return;
    state.tagPicked = state.tagPicked === button.dataset.tag ? null : button.dataset.tag;
    applyPicks();
  });
  for (const id of ['home-pinned', 'home-lately']) $(id).addEventListener('click', event => { const button = event.target.closest('button[data-id]'); if (button) openNote(button.dataset.id); });
  $('home-tasks').addEventListener('click', event => { const button = event.target.closest('button[data-note]'); if (button?.dataset.note) openNote(button.dataset.note); });
  home.addEventListener('click', event => {
    const action = event.target.closest('[data-home]')?.dataset.home;
    if (action === 'graph') openGraph();
    if (action === 'new') plant('');
    if (action === 'daily') daily();
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    if (state.picked.size || state.unlinkedPicked || state.tagPicked) clearPicks();
  });

  // Nendo's Add, where the host offers its row, makes a new note; the page's own buttons stay.
  if (can('ui.setToolbar')) {
    nendo.ui.setToolbar({ items: [], add: 'new' }).catch(() => undefined);
    nendo.on('command', ({ id }) => { if (id === 'new') plant(''); });
  }

  async function load({ refit = false } = {}) {
    try {
      const [notes, links, tasks, tags, noteTags] = await Promise.all([
        nendo.records.queryAll({ entityId: 'gd.note' }, { max: 10000 }),
        nendo.records.queryAll({ entityId: 'gd.link' }, { max: 10000 }),
        nendo.records.queryAll({ entityId: 'gd.task' }, { max: 10000 }),
        nendo.records.queryAll({ entityId: 'gd.tag' }, { max: 5000 }),
        nendo.records.queryAll({ entityId: 'gd.noteTag' }, { max: 10000 }),
      ]);
      state.records = { notes, links, tasks, tags, noteTags };
      showProblem('');
    } catch (error) {
      showProblem(`The garden could not be read: ${error.message}`);
      return;
    }
    state.view = overview(state.records, { stages });
    // A tag or stage that is gone from the garden is let go.
    if (state.tagPicked && !state.view.tags.some(tag => tag.id === state.tagPicked)) state.tagPicked = null;
    graph.update(buildGraph(state.records), { refit });
    draw();
    if (state.query) drawFound();
    state.ready = true;
    expose();
  }

  let pending = null;
  const schedule = () => { if (pending === null) pending = setTimeout(() => { pending = null; load(); }, 300); };
  nendo.on('changes', schedule);
  nendo.on('context', schedule);
  await load();
}
