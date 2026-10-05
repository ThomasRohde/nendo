// Flow's model: what a flow is, what makes one walkable, and the sample it ships with.
// Pure functions over plain objects, shared by the view, the build and the tests.

export const KINDS = ['Start', 'Step', 'End'];
export const PREFIX = { flows: 'fl.flow', steps: 'fl.step', edges: 'fl.edge', runs: 'fl.run' };

/** A key an agent can read and type: lowercase words joined by hyphens, under its flow's key. */
export function slug(text) {
  const words = String(text ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (words || 'step').slice(0, 40).replace(/-+$/, '');
}

/** A step key not yet taken anywhere in the file: keys are unique across every flow. */
export function uniqueKey(flowKey, name, taken) {
  const base = `${flowKey}.${slug(name)}`;
  const used = new Set([...taken].map(key => key.toLowerCase()));
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * What stops a flow from being walked the same way every time. Each problem names the
 * step or edge it is about, so the view can point at it. An empty list means an agent
 * can start a run and every outcome it reports leads somewhere.
 */
export function validate(flow) {
  const problems = [];
  const say = (message, id = null) => problems.push({ message, id });
  const steps = new Map(flow.steps.map(step => [step.id, step]));
  const out = id => flow.edges.filter(edge => edge.from === id);
  const into = id => flow.edges.filter(edge => edge.to === id);
  const name = step => step.name || step.key;

  const starts = flow.steps.filter(step => step.kind === 'Start');
  if (starts.length !== 1) say(starts.length ? `A flow has one Start; this one has ${starts.length}.` : 'Add a Start: a run begins on the edge that leaves it.');
  if (!flow.steps.some(step => step.kind === 'End')) say('Add an End: a run is finished when it reaches one.');

  for (const edge of flow.edges) {
    if (!steps.has(edge.from) || !steps.has(edge.to)) say(`The edge “${edge.outcome}” joins a step outside this flow.`, edge.id);
    if (!String(edge.outcome ?? '').trim()) say('Every edge needs an outcome: the word an agent reports to take it.', edge.id);
  }
  for (const step of flow.steps) {
    const leaving = out(step.id);
    if (step.kind === 'Start') {
      if (into(step.id).length) say('Nothing leads back into the Start.', step.id);
      if (leaving.length !== 1) say('The Start has exactly one edge leaving it: the one a run begins on.', step.id);
    } else if (step.kind === 'End') {
      if (leaving.length) say(`“${name(step)}” is an End, so nothing leaves it.`, step.id);
    } else if (!leaving.length) say(`“${name(step)}” has no way out. Connect it, or make it an End.`, step.id);
    const seen = new Map();
    for (const edge of leaving) {
      const word = String(edge.outcome ?? '').trim().toLowerCase();
      if (word && seen.has(word)) say(`Two edges leave “${name(step)}” with the outcome “${edge.outcome}”, so that outcome does not decide where a run goes.`, edge.id);
      seen.set(word, edge);
    }
    if (step.kind === 'Step' && !String(step.instructions ?? '').trim()) say(`Say what to do at “${name(step)}”.`, step.id);
  }

  if (starts.length === 1) {
    const reached = walk(starts[0].id, id => out(id).map(edge => edge.to));
    for (const step of flow.steps) if (!reached.has(step.id)) say(`“${name(step)}” cannot be reached from the Start.`, step.id);
    const ends = flow.steps.filter(step => step.kind === 'End').map(step => step.id);
    const finishing = new Set(ends.flatMap(id => [...walk(id, at => into(at).map(edge => edge.from))]));
    for (const step of flow.steps) if (reached.has(step.id) && !finishing.has(step.id)) say(`A run that reaches “${name(step)}” can never finish.`, step.id);
  }
  return problems;
}

function walk(from, next) {
  const seen = new Set([from]), queue = [from];
  while (queue.length) for (const id of next(queue.shift())) if (!seen.has(id)) { seen.add(id); queue.push(id); }
  return seen;
}

/** Records, keyed by type, into flows with their steps, edges and runs. */
export function fromRecords(records) {
  const value = (record, entity, key) => record.values[`${entity}.${key}`] ?? null;
  return records.flows.map(flow => ({
    id: flow.recordId, version: flow.version,
    name: value(flow, 'fl.flow', 'name'), key: value(flow, 'fl.flow', 'key'), purpose: value(flow, 'fl.flow', 'purpose'),
    steps: records.steps.filter(r => value(r, 'fl.step', 'flow') === flow.recordId).map(r => ({
      id: r.recordId, version: r.version, name: value(r, 'fl.step', 'name'), key: value(r, 'fl.step', 'key'),
      kind: value(r, 'fl.step', 'kind'), instructions: value(r, 'fl.step', 'instructions'), doneWhen: value(r, 'fl.step', 'doneWhen'),
      x: Number(value(r, 'fl.step', 'x') ?? 0), y: Number(value(r, 'fl.step', 'y') ?? 0),
    })),
    edges: records.edges.filter(r => value(r, 'fl.edge', 'flow') === flow.recordId).map(r => ({
      id: r.recordId, version: r.version, outcome: value(r, 'fl.edge', 'outcome'), when: value(r, 'fl.edge', 'when'),
      from: value(r, 'fl.edge', 'from'), to: value(r, 'fl.edge', 'to'),
    })),
    runs: records.runs.filter(r => value(r, 'fl.run', 'flow') === flow.recordId).map(r => ({
      id: r.recordId, version: r.version, title: value(r, 'fl.run', 'title'), choice: value(r, 'fl.run', 'choice'),
      currentKey: value(r, 'fl.run', 'currentKey'), status: value(r, 'fl.run', 'status'), path: value(r, 'fl.run', 'path'),
      notes: value(r, 'fl.run', 'notes'),
    })),
  }));
}

/** The keys a run passed through, in order, from its path. */
export const pathKeys = run => String(run?.path ?? '').split(' › ').map(key => key.trim()).filter(Boolean);

/** How an agent walks this flow over MCP, in words it can follow without reading the view. */
export function agentGuide(flow) {
  const start = flow.steps.find(step => step.kind === 'Start');
  const first = start && flow.edges.find(edge => edge.from === start.id);
  return [
    `To run “${flow.name}”:`,
    `1. Create a fl.run record: fl.run.title, fl.run.flow = ${flow.id}, fl.run.choice = ${first?.id ?? '(the edge leaving the Start)'}. Nendo sets fl.run.currentKey to the first step.`,
    '2. Read the fl.step whose fl.step.key equals fl.run.currentKey. Do what fl.step.instructions says until fl.step.doneWhen holds.',
    '3. Read the fl.edge records whose fl.edge.from is that step. Pick the one whose fl.edge.when matches what happened.',
    '4. Set fl.run.choice to that edge at the run’s current version. Nendo moves the run, or refuses an edge that does not leave its step and changes nothing.',
    '5. Repeat from 2 until fl.run.status is Finished. Never write fl.run.currentKey, fl.run.path or fl.run.status yourself.',
  ].join('\n');
}

/** The flow every new Flow file starts with: the repository's own loop for a reported defect. */
export function sample() {
  const flow = { id: 'fl_flow_defect', name: 'Fix a reported defect', key: 'defect',
    purpose: 'The loop for something reported broken: locate, fix, guard, falsify the guard, record. The last two steps are the ones that get skipped, so the flow will not let a run skip them.' };
  const step = (suffix, kind, name, x, y, instructions = null, doneWhen = null) =>
    ({ id: `fl_step_defect_${suffix.replaceAll('-', '_')}`, key: `defect.${suffix}`, kind, name, x, y, instructions, doneWhen });
  const steps = [
    step('reported', 'Start', 'Reported', 30, 0),
    step('locate', 'Step', 'Locate it in the code', 0, 110,
      'Find where it is wrong before changing anything. A screenshot says where it looks wrong, not where it is wrong.',
      'You can name the file and the line that produce the defect.'),
    step('fix', 'Step', 'Fix it', 0, 230, 'Change the code that produces the defect, and nothing beside it.', 'The defect no longer reproduces by hand.'),
    step('guard', 'Step', 'Add a measuring guard', 0, 350,
      'Add a check that measures what was wrong, in a lane that already runs. A guard that would pass against the old code guards the symptom.',
      'The guard passes with the fix in place.'),
    step('falsify', 'Step', 'Falsify the guard', 0, 470,
      'Put the defect back and run the guard. Keep the failure text exactly as it printed.',
      'You have the guard’s output with the defect back in.'),
    step('restore', 'Step', 'Restore and rerun', 0, 590, 'Restore the fix and run the lane again.', 'The lane has run once more with the fix restored.'),
    step('record', 'Step', 'Record a Finding', 0, 710, 'Record a Finding that carries the falsification text, the guard and where it runs.', 'The Finding exists and quotes the failure.'),
    step('done', 'End', 'Done', 30, 830),
  ];
  const id = key => steps.find(s => s.key === `defect.${key}`).id;
  const edge = (from, to, outcome, when = null) => ({ id: `fl_edge_defect_${from}_${to}`.replaceAll('-', '_'), from: id(from), to: id(to), outcome, when });
  const edges = [
    edge('reported', 'locate', 'begin'),
    edge('locate', 'fix', 'found', 'You can name where it is wrong.'),
    edge('fix', 'guard', 'fixed', 'The defect no longer reproduces.'),
    edge('guard', 'falsify', 'guarded', 'The new guard passes with the fix in place.'),
    edge('falsify', 'restore', 'caught', 'The guard failed with the defect back in.'),
    edge('falsify', 'guard', 'missed', 'The guard still passed with the defect back in: it measures the symptom, so write the one that fails.'),
    edge('restore', 'record', 'green', 'The lane passes with the fix restored.'),
    edge('restore', 'fix', 'red', 'The lane fails with the fix restored: the fix was incomplete.'),
    edge('record', 'done', 'recorded', 'The Finding is recorded.'),
  ];
  return { ...flow, steps, edges, runs: [] };
}
