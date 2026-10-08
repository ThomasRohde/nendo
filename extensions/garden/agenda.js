// The Agenda (W-184), a screen of the Tasks: every open task in the garden by when it is due, each
// with its box and the note it belongs to. Ticking a box writes the tick as one batch, into the
// note's line too when the body says the task (agenda.mjs), and the line under the heading offers to
// take it back. A ticked task stays, ticked, until the screen is read afresh, so a slip can be unticked.
import { agenda, tickWrites } from './agenda.mjs';
import { dueText } from './tasks.mjs';
import { inline } from './render.mjs';
import { resolveTarget, F } from './sync.mjs';
import { plainText } from './related.mjs';
import { createWriter, element, noteOpener, today } from './screen.js';

const $ = id => document.getElementById(id);
const OPEN_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';

export async function startAgenda(nendo, context) {
  const root = $('agenda');
  root.hidden = false;
  document.body.classList.add('list-mode');
  const locale = context.locale ?? 'en';
  const state = { ready: false, records: null, view: null, kept: new Set(), problem: '' };
  const expose = () => { window.gardenAgenda = state; };
  const writer = createWriter(nendo, { status: $('agenda-status'), problem: $('agenda-problem'), after: () => load() });
  const openNote = noteOpener(nendo, text => writer.showProblem(text));

  let index = [];
  const resolve = target => {
    const found = resolveTarget(target, index);
    return found ? { recordId: found.recordId, title: found.title } : null;
  };

  function row(task, group) {
    const box = element('input', { type: 'checkbox', className: 'box', 'data-id': task.id });
    box.checked = task.done;
    const due = group === 'today' || task.done ? null : dueText(task.due, today(), locale);
    return element('li', { className: `agenda-task${task.done ? ' done' : ''}`, 'data-id': task.id },
      element('label', {}, box, element('span', { className: 'text', html: inline(task.text, resolve) })),
      task.noteTitle ? element('button', { type: 'button', className: 'note-link', 'data-note': task.noteId, title: `Open ${task.noteTitle} in the Garden view`, text: task.noteTitle }) : null,
      due ? element('span', { className: `due${due.late ? ' late' : ''}`, text: due.text }) : null,
      element('button', { type: 'button', className: 'open-task', 'data-record': task.recordId, title: "Open the task's record", 'aria-label': "Open the task's record", html: OPEN_ICON }));
  }

  function draw() {
    const view = state.view;
    const summary = view.open === 0 ? 'Nothing open.'
      : `${view.open} open ${view.open === 1 ? 'task' : 'tasks'}${view.overdue ? `, ${view.overdue} overdue` : ''}.`;
    $('agenda-summary').textContent = summary;
    const groups = view.groups.filter(group => group.tasks.length > 0);
    $('agenda-groups').replaceChildren(...groups.map(group => element('section', { className: `list-group group-${group.id}`, 'data-group': group.id, 'aria-labelledby': `agenda-${group.id}` },
      element('h2', { id: `agenda-${group.id}` }, group.title, ' ', element('span', { className: 'count', text: String(group.tasks.filter(task => !task.done).length) })),
      element('ul', { className: 'list-rows' }, ...group.tasks.map(task => row(task, group.id))))));
    $('agenda-empty').hidden = groups.length > 0;
    state.groups = groups.map(group => ({ id: group.id, tasks: group.tasks.map(task => ({ id: task.id, text: task.text, done: task.done, note: task.noteTitle, due: task.due })) }));
    expose();
  }

  async function tick(task, done) {
    const note = state.records.notes.find(candidate => candidate.recordId === task.noteId) ?? null;
    const writes = tickWrites(task, note, done, today());
    const words = plainText(task.text).slice(0, 60);
    state.kept.add(task.recordId);
    state.lastWrites = writes;
    await writer.write(writes, `${done ? 'Tick' : 'Untick'} ${words}`, `${done ? 'Ticked' : 'Unticked'} “${words}”.`);
  }

  $('agenda-groups').addEventListener('change', event => {
    const box = event.target.closest('input.box');
    const task = box && state.view?.groups.flatMap(group => group.tasks).find(candidate => candidate.id === box.dataset.id);
    if (task) tick(task, box.checked);
  });
  $('agenda-groups').addEventListener('click', event => {
    const opener = event.target.closest('button.open-task');
    if (opener) { nendo.ui.openRecord('gd.task', opener.dataset.record).catch(error => writer.showProblem(error.message)); return; }
    const note = event.target.closest('button.note-link');
    if (note) { openNote(note.dataset.note); return; }
    const link = event.target.closest('a');
    if (!link) return;
    event.preventDefault();
    if (link.classList.contains('wikilink') && link.dataset.id) openNote(link.dataset.id);
    else if (link.classList.contains('tag')) {
      const tag = state.records.tags.find(candidate => String(candidate.values[F.tag.name] ?? '').toLowerCase() === link.dataset.tag);
      if (tag) nendo.ui.openRecord('gd.tag', tag.recordId).catch(error => writer.showProblem(error.message));
    } else if (link.href && !link.classList.contains('wikilink')) window.open(link.href, '_blank', 'noopener');
  });

  async function load() {
    try {
      const [tasks, notes, tags] = await Promise.all([
        nendo.records.queryAll({ entityId: 'gd.task' }, { max: 10000 }),
        nendo.records.queryAll({ entityId: 'gd.note' }, { max: 10000 }),
        nendo.records.queryAll({ entityId: 'gd.tag' }, { max: 5000 }),
      ]);
      state.records = { tasks, notes, tags };
      index = notes.map(note => ({ recordId: note.recordId, slug: note.values[F.note.slug] ?? '', title: String(note.values[F.note.title] ?? note.recordId) }));
    } catch (error) {
      writer.showProblem(`The tasks could not be read: ${error.message}`);
      return;
    }
    state.view = agenda(state.records.tasks, state.records.notes, today(), { keep: state.kept });
    draw();
    state.ready = true;
    expose();
  }

  let pending = null;
  const schedule = () => { if (pending === null) pending = setTimeout(() => { pending = null; load(); }, 300); };
  nendo.on('changes', schedule);
  nendo.on('context', schedule);
  await load();
}
