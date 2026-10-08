// What the Agenda and Tend screens share: elements, today's date, the stages' colours, a note opened
// in the Garden view through the package's storage (handover.mjs), and a status line whose Undo takes
// back the screen's last write (ADR-0023: a view undoes its own revisions).
import { handOver } from './handover.mjs';
import { F } from './sync.mjs';

export const GARDEN_VIEW = 'gd.garden';
const STAGE_TONES = { Seed: 'amber', Growing: 'teal', Evergreen: 'green' };

export const today = () => { const d = new Date(), pad = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

export const element = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'className') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('data-') || key.startsWith('aria-') || key === 'role' || key === 'type' || key === 'title' || key === 'style') node.setAttribute(key, value);
    else node[key] = value;
  }
  node.append(...children.filter(child => child !== null && child !== undefined));
  return node;
};

/** The colour of a stage: its tone in the file's schema, else Garden's own. */
export async function stageTone(nendo, kit) {
  let stages = [];
  try {
    const schema = await nendo.schema.describe();
    stages = schema.entities.find(entity => entity.entityId === 'gd.note')?.fields.find(field => field.fieldId === F.note.stage)?.choices ?? [];
  } catch { /* without the schema the stages take Garden's own colours */ }
  return stage => stages.some(choice => choice.id === stage && choice.tone) ? kit.toneFor(stage, stages) : `var(--nendo-tone-${STAGE_TONES[stage] ?? 'grey'})`;
}

/** Opens a note in the Garden view; a host without ui.openScreen opens its record page instead. */
export function noteOpener(nendo, onProblem) {
  const can = name => typeof nendo.has === 'function' && nendo.has(name);
  return async noteId => {
    if (can('ui.openScreen') && handOver({ open: noteId })) {
      try { await nendo.ui.openScreen(GARDEN_VIEW); return; } catch (error) { onProblem(error.message); return; }
    }
    nendo.ui.openRecord('gd.note', noteId).catch(error => onProblem(error.message));
  };
}

/**
 * One records.batch with its label, and the line that says what it did with an Undo beside it.
 * Ctrl Z takes back the last one too. `after` reads the screen again once a write or an undo lands.
 * One write or undo at a time: while one travels, Undo is off and asks nothing of the history, so
 * an Undo pressed then never spends the step before. `retry`, when given, is offered beside a problem.
 */
export function createWriter(nendo, { status, problem, after, retry = null }) {
  const can = name => typeof nendo.has === 'function' && nendo.has(name);
  const steps = [];
  let busy = false;
  const say = (text, undoable) => {
    status.replaceChildren(...(text ? [element('span', { text })] : []),
      ...(undoable && can('records.undo') ? [element('button', { type: 'button', className: 'link-like', 'data-undo': '', text: 'Undo' })] : []));
  };
  const setBusy = value => {
    busy = value;
    for (const button of status.querySelectorAll('[data-undo]')) button.disabled = value;
  };
  const showProblem = (text, { retrying = false } = {}) => {
    problem.replaceChildren(...(text ? [element('span', { text })] : []),
      ...(retrying && retry ? [' ', element('button', { type: 'button', className: 'link-like', 'data-retry': '', text: 'Retry' })] : []));
    problem.hidden = !text;
  };
  problem.addEventListener('click', event => { if (event.target.closest('[data-retry]')) retry?.(); });
  async function write(writes, label, said) {
    if (busy || !can('records.batch')) return false;
    setBusy(true);
    try {
      const result = await nendo.records.batch(writes, { label: label.slice(0, 80), writeKey: crypto.randomUUID() });
      steps.push({ revision: result.revision, label: label.slice(0, 80) });
      showProblem('');
      say(said, true);
      return true;
    } catch (error) {
      showProblem(`That was refused (${error.code ?? 'error'}): ${error.message}`);
      return false;
    } finally {
      setBusy(false);
      await after();
    }
  }
  async function undo() {
    if (busy || steps.length === 0 || !can('records.undo')) return;
    const step = steps.pop();
    setBusy(true);
    try {
      await nendo.records.undo(step.revision, { label: `Undo ${step.label}`.slice(0, 80) });
      showProblem('');
      say(`Took back: ${step.label}.`, steps.length > 0);
    } catch (error) {
      steps.push(step);
      showProblem(`Undo was refused (${error.code ?? 'error'}): ${error.message}`);
    } finally {
      setBusy(false);
      await after();
    }
  }
  status.addEventListener('click', event => { if (event.target.closest('[data-undo]')) undo(); });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'z' && !event.target.closest?.('input[type=text], input[type=search], textarea')) {
      event.preventDefault();
      undo();
    }
  });
  return { write, undo, showProblem, steps, busy: () => busy };
}
