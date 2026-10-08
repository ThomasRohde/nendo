// Tend (W-184), a screen of the Notes: the seeds and growing notes nobody has tended within the span
// chosen, the longest untended first, and the notes that are still only a name. Each note opens in
// the Garden view, and Tended today, Mark growing and Mark evergreen write what the commands of the
// same names write, as one batch the line under the heading offers to take back.
import { tend, quietFor, SPANS, DEFAULT_SPAN } from './tend.mjs';
import { F } from './sync.mjs';
import { createWriter, element, noteOpener, stageTone, today } from './screen.js';

const $ = id => document.getElementById(id);
const SPAN_KEY = 'garden.tend.span.v1';

// What each button writes: the command it stands for, and the stage it moves a note to.
const ACTIONS = {
  tend: { label: 'Tended today', said: title => `Tended “${title}” today.`, values: () => ({}) },
  growing: { label: 'Mark growing', said: title => `“${title}” is growing.`, values: () => ({ [F.note.stage]: 'Growing' }) },
  evergreen: { label: 'Mark evergreen', said: title => `“${title}” is evergreen.`, values: () => ({ [F.note.stage]: 'Evergreen' }) },
};

export async function startTend(nendo, context, kit) {
  const root = $('tend');
  root.hidden = false;
  document.body.classList.add('list-mode');
  const span = (() => { try { const kept = Number(localStorage.getItem(SPAN_KEY)); return SPANS.some(s => s.days === kept) ? kept : DEFAULT_SPAN; } catch { return DEFAULT_SPAN; } })();
  const state = { ready: false, notes: null, view: null, span };
  const expose = () => { window.gardenTend = state; };
  const writer = createWriter(nendo, { status: $('tend-status'), problem: $('tend-problem'), after: () => load(), retry: () => load() });
  const openNote = noteOpener(nendo, text => writer.showProblem(text));
  const tone = await stageTone(nendo, kit);

  $('tend-spans').replaceChildren(...SPANS.map(s => element('button', { type: 'button', 'data-span': String(s.days), 'aria-pressed': String(s.days === state.span), text: s.label })));

  function row(item, actions) {
    const when = item.stage ? `${item.stage} · ${item.days === null ? 'never tended' : `${quietFor(item.days)} untended`}` : quietFor(item.days);
    return element('li', { className: 'tend-note', 'data-id': item.id, style: `--stage:${tone(item.stage)}` },
      element('span', { className: 'dot', 'aria-hidden': 'true' }),
      element('div', { className: 'tend-main' },
        element('button', { type: 'button', className: 'note-link', 'data-note': item.id, title: `Open ${item.title} in the Garden view`, text: item.title }),
        item.excerpt ? element('span', { className: 'tend-excerpt', text: item.excerpt }) : null,
        element('span', { className: 'tend-when', text: when })),
      element('div', { className: 'tend-actions' }, ...actions.map(action => element('button', { type: 'button', 'data-action': action, 'data-id': item.id, text: ACTIONS[action].label }))));
  }

  function draw() {
    const { quiet, empty } = state.view;
    const spanLabel = SPANS.find(s => s.days === state.span)?.label ?? `${state.span} days`;
    $('tend-summary').textContent = quiet.length + empty.length === 0 ? `Every note was tended in the last ${spanLabel}.`
      : `${quiet.length} ${quiet.length === 1 ? 'note has' : 'notes have'} waited ${spanLabel} or more; ${empty.length} ${empty.length === 1 ? 'is' : 'are'} not written yet.`;
    for (const button of $('tend-spans').querySelectorAll('button')) button.setAttribute('aria-pressed', String(Number(button.dataset.span) === state.span));
    $('tend-quiet-count').textContent = String(quiet.length);
    $('tend-quiet').replaceChildren(...quiet.map(item => row(item, ['tend', item.stage === 'Seed' ? 'growing' : 'evergreen'])));
    $('tend-quiet-none').hidden = quiet.length > 0;
    $('tend-quiet-none').textContent = `No seed or growing note has waited ${spanLabel}.`;
    $('tend-empty-section').hidden = empty.length === 0;
    $('tend-empty-count').textContent = String(empty.length);
    $('tend-empty').replaceChildren(...empty.map(item => row(item, [])));
    state.shown = { quiet: quiet.map(item => ({ id: item.id, title: item.title, stage: item.stage, days: item.days })), empty: empty.map(item => ({ id: item.id, title: item.title })) };
    expose();
  }

  async function act(action, id) {
    const note = state.notes.find(candidate => candidate.recordId === id);
    if (!note) return;
    const title = String(note.values[F.note.title] ?? id);
    const values = { ...ACTIONS[action].values(), [F.note.touched]: today() };
    await writer.write([{ op: 'update', entityId: 'gd.note', recordId: id, version: note.version, values }], `${ACTIONS[action].label}: ${title}`, ACTIONS[action].said(title));
  }

  root.addEventListener('click', event => {
    const spanButton = event.target.closest('button[data-span]');
    if (spanButton) {
      state.span = Number(spanButton.dataset.span);
      try { localStorage.setItem(SPAN_KEY, String(state.span)); } catch { /* a private window keeps none */ }
      if (state.notes) { state.view = tend(state.notes, today(), state.span); draw(); }
      return;
    }
    const action = event.target.closest('button[data-action]');
    if (action) { act(action.dataset.action, action.dataset.id); return; }
    const note = event.target.closest('button.note-link');
    if (note) openNote(note.dataset.note);
  });

  let readFailed = false;
  async function load() {
    try {
      state.notes = await nendo.records.queryAll({ entityId: 'gd.note' }, { max: 10000 });
    } catch (error) {
      readFailed = true;
      writer.showProblem(`The notes could not be read (${error.code ?? 'error'}): ${error.message}`, { retrying: true });
      return;
    }
    if (readFailed) { readFailed = false; writer.showProblem(''); }
    state.view = tend(state.notes, today(), state.span);
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
