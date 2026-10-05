import { validate, fromRecords, uniqueKey, slug, agentGuide, pathKeys, PREFIX } from './model.mjs';
const { React, createRoot, ReactFlow, Background, Controls, Handle, Position, MarkerType, applyNodeChanges, applyEdgeChanges } = window.FlowKit;
const h = React.createElement;
const $ = id => document.getElementById(id);
const api = window.nendo;

// What the file holds, the flow on screen and the draft of it the person is editing.
let records = { flows: [], steps: [], edges: [], runs: [] };
let flows = [], flowId = null, runId = null;
let saved = null;                 // the shown flow as last read
let nodes = [], edges = [];       // xyflow's nodes and edges for the draft
let stepInfo = new Map(), edgeInfo = new Map(), flowInfo = { name: '', purpose: '' };
let instance = null, root = null, inspected = undefined, theme = 'light';
let loading = false, saving = false, pendingLoad = false, fitPending = true, externalChange = false;

const notice = text => { $('status').textContent = text; };
const problem = error => { $('problem').textContent = error?.message ?? String(error); $('problem').hidden = false; };
const clearProblem = () => { $('problem').hidden = true; $('problem').textContent = ''; };
const canWrite = () => !api.context.readOnly && !saving && !loading;
const flow = () => flows.find(f => f.id === flowId) ?? null;
const newId = kind => `fl_${kind}_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;

// ---- The draft as a flow, and whether it differs from what is saved ----

function draft() {
  return {
    id: flowId, key: saved?.key, name: flowInfo.name, purpose: flowInfo.purpose,
    steps: nodes.map(n => ({ ...stepInfo.get(n.id), id: n.id, x: Math.round(n.position.x), y: Math.round(n.position.y) })),
    edges: edges.map(e => ({ ...edgeInfo.get(e.id), id: e.id, from: e.source, to: e.target })),
  };
}
const shape = f => JSON.stringify({
  name: f.name ?? '', purpose: f.purpose ?? '',
  steps: f.steps.map(s => [s.id, s.name ?? '', s.instructions ?? '', s.doneWhen ?? '', Math.round(s.x), Math.round(s.y)]).sort(),
  edges: f.edges.map(e => [e.id, e.outcome ?? '', e.when ?? '', e.from, e.to]).sort(),
});
const isDirty = () => !!saved && shape(draft()) !== shape(saved);

function openDraft(f) {
  saved = f;
  flowInfo = { name: f.name ?? '', purpose: f.purpose ?? '' };
  stepInfo = new Map(f.steps.map(s => [s.id, { ...s }]));
  edgeInfo = new Map(f.edges.map(e => [e.id, { ...e }]));
  nodes = f.steps.map(s => ({ id: s.id, type: 'step', position: { x: s.x, y: s.y }, data: {}, deletable: true }));
  edges = f.edges.map(e => ({ id: e.id, source: e.from, target: e.to }));
  inspected = undefined; externalChange = false;
}

// ---- Reading ----

async function readAll() {
  const out = {};
  for (const [key, entityId] of Object.entries(PREFIX)) out[key] = await api.records.queryAll({ entityId }, { max: 5000 });
  return out;
}

async function load({ keepDraft = false } = {}) {
  if (loading) { pendingLoad = true; return; }
  loading = true; toolbar();
  try {
    records = await readAll();
    flows = fromRecords(records);
    if (!flows.length) { saved = null; nodes = []; edges = []; loading = false; render(); renderRuns(); notice('This file has no flows yet. Choose New flow.'); return; }
    if (!flows.some(f => f.id === flowId)) { flowId = flows[0].id; keepDraft = false; fitPending = true; }
    const latest = flow();
    if (!keepDraft || !isDirty()) openDraft(latest);
    else if (shape(latest) !== shape(saved)) { externalChange = true; notice('This flow changed elsewhere while you were editing. Your draft is kept; saving checks every record against what it last read.'); }
    if (!latest.runs.some(r => r.id === runId)) runId = latest.runs.find(r => r.status !== 'Finished')?.id ?? null;
    $('workspace').setAttribute('aria-busy', 'false'); clearProblem();
    // Drawn after the read ends: what is drawn while loading is drawn read-only, and stays so.
    loading = false; render(); renderRuns();
  } catch (e) { problem(e); }
  finally { loading = false; toolbar(); if (pendingLoad) { pendingLoad = false; await load({ keepDraft: true }); } }
}

// ---- Nendo's toolbar ----

function toolbar() {
  const dirty = isDirty(), count = saved ? validate(draft()).length : 0;
  // Nendo refuses a select with no options, so the picker waits for a flow to pick.
  const picker = flows.length ? [{ kind: 'select', id: 'flow', label: 'Flow', value: flowId, options: flows.slice(0, 64).map(f => ({ value: f.id, label: f.name || f.key })) }] : [];
  api.ui.setToolbar({ items: [
    ...picker,
    { kind: 'button', id: 'new-flow', label: 'New flow', disabled: !canWrite() },
    { kind: 'separator' },
    { kind: 'button', id: 'add-step', label: 'Add step', disabled: !canWrite() || !saved, keys: 'Alt+N' },
    { kind: 'button', id: 'add-end', label: 'Add end', disabled: !canWrite() || !saved },
    { kind: 'button', id: 'fit', label: 'Fit', disabled: !saved },
    { kind: 'separator' },
    { kind: 'button', id: 'save', label: saving ? 'Saving…' : 'Save', disabled: !dirty || !canWrite(), keys: 'Ctrl+S' },
    { kind: 'button', id: 'discard', label: 'Reload saved', disabled: !dirty || saving },
    { kind: 'spacer' },
    // A text item holds 1 to 80 characters, so it is left out until there is something to say.
    ...(saved ? [{ kind: 'text', text: dirty ? 'Unsaved changes' : count ? `Not walkable yet · ${count} to fix` : 'Saved · walkable' }] : []),
  ] }).catch(problem);
}

// ---- The diagram ----

function StepNode({ id, data, selected }) {
  const s = data.step;
  const classes = ['step', `kind-${String(s.kind).toLowerCase()}`];
  if (selected) classes.push('selected');
  if (data.flagged) classes.push('flagged');
  if (data.current) classes.push('current'); else if (data.visited) classes.push('visited');
  return h('div', { className: classes.join(' '), 'data-step': id },
    s.kind !== 'Start' ? h(Handle, { type: 'target', id: 'in', position: Position.Top, isConnectable: canWrite() }) : null,
    h('span', { className: 'step-kind' }, s.kind),
    h('strong', null, s.name || 'Untitled'),
    h('code', null, s.key),
    s.kind !== 'End' ? h(Handle, { type: 'source', id: 'out', position: Position.Bottom, isConnectable: canWrite() }) : null,
    // An edge that goes back up leaves and arrives on the right, so a loop runs beside the
    // column instead of over the edges going down. These two are for drawing, not for dragging.
    s.kind !== 'End' ? h(Handle, { type: 'source', id: 'back-out', position: Position.Right, isConnectable: false, className: 'side out' }) : null,
    s.kind !== 'Start' ? h(Handle, { type: 'target', id: 'back-in', position: Position.Right, isConnectable: false, className: 'side in' }) : null);
}
const nodeTypes = { step: StepNode };

function overlay() {
  const run = flow()?.runs.find(r => r.id === runId);
  if (!run) return { current: null, visited: new Set(), taken: new Set() };
  const keys = pathKeys(run), idOf = new Map([...stepInfo.values()].map(s => [s.key, s.id]));
  const visited = new Set(keys.map(key => idOf.get(key)).filter(Boolean));
  const taken = new Set();
  for (let i = 1; i < keys.length; i++) {
    for (const e of edges) if (e.source === idOf.get(keys[i - 1]) && e.target === idOf.get(keys[i])) taken.add(e.id);
  }
  const start = [...stepInfo.values()].find(s => s.kind === 'Start');
  for (const e of edges) if (start && e.source === start.id && e.target === idOf.get(keys[0])) taken.add(e.id);
  return { current: idOf.get(run.currentKey) ?? null, visited, taken };
}

function renderCanvas() {
  if (!root) root = createRoot($('canvas'));
  if (!saved) { root.render(null); return; }
  const flagged = new Set(validate(draft()).map(p => p.id).filter(Boolean));
  const { current, visited, taken } = overlay();
  const shownNodes = nodes.map(n => ({ ...n, data: { step: stepInfo.get(n.id), flagged: flagged.has(n.id), current: n.id === current, visited: visited.has(n.id) } }));
  // Edges going back up take the side handles, the shorter loops inside the longer ones.
  const at = new Map(nodes.map(n => [n.id, n.position]));
  const back = edges.filter(e => (at.get(e.target)?.y ?? 0) < (at.get(e.source)?.y ?? 0))
    .sort((a, b) => (at.get(a.source).y - at.get(a.target).y) - (at.get(b.source).y - at.get(b.target).y)).map(e => e.id);
  const shownEdges = edges.map(e => ({
    ...e, type: 'smoothstep', label: edgeInfo.get(e.id)?.outcome || '(no outcome)',
    ...(back.includes(e.id)
      ? { sourceHandle: 'back-out', targetHandle: 'back-in', pathOptions: { offset: 30 + 56 * back.indexOf(e.id), borderRadius: 8 } }
      : { sourceHandle: 'out', targetHandle: 'in', pathOptions: { borderRadius: 8 } }),
    markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
    className: [taken.has(e.id) ? 'taken' : '', flagged.has(e.id) ? 'flagged' : ''].join(' ').trim(),
    labelBgPadding: [6, 3], labelBgBorderRadius: 4,
  }));
  root.render(h(ReactFlow, {
    nodes: shownNodes, edges: shownEdges, nodeTypes, colorMode: theme,
    onNodesChange, onEdgesChange, onConnect, onInit: value => { instance = value; },
    isValidConnection: c => c.source !== c.target && stepInfo.get(c.source)?.kind !== 'End' && stepInfo.get(c.target)?.kind !== 'Start',
    nodesDraggable: canWrite(), nodesConnectable: canWrite(), elementsSelectable: true, deleteKeyCode: canWrite() ? ['Delete', 'Backspace'] : null,
    minZoom: 0.2, maxZoom: 2, fitView: true, fitViewOptions: { padding: 0.2 },
  }, h(Background, { gap: 22, size: 1 }), h(Controls, { showInteractive: false })));
  if (fitPending && instance) { fitPending = false; requestAnimationFrame(() => instance?.fitView({ padding: 0.2 })); }
}

function onNodesChange(changes) {
  if (!canWrite()) changes = changes.filter(c => c.type === 'select' || c.type === 'dimensions');
  for (const c of changes) if (c.type === 'remove') { stepInfo.delete(c.id); edges = edges.filter(e => e.source !== c.id && e.target !== c.id); }
  nodes = applyNodeChanges(changes, nodes);
  changed(changes.some(c => c.type !== 'dimensions'));
}

function onEdgesChange(changes) {
  if (!canWrite()) changes = changes.filter(c => c.type === 'select');
  for (const c of changes) if (c.type === 'remove') edgeInfo.delete(c.id);
  edges = applyEdgeChanges(changes, edges);
  changed(true);
}

function onConnect({ source, target }) {
  if (!canWrite()) return;
  const used = new Set(edges.filter(e => e.source === source).map(e => String(edgeInfo.get(e.id)?.outcome ?? '').toLowerCase()));
  const outcome = ['next', 'yes', 'no'].find(word => !used.has(word)) ?? `outcome-${used.size + 1}`;
  const id = newId('edge');
  edgeInfo.set(id, { id, outcome, when: '' });
  nodes = nodes.map(n => ({ ...n, selected: false }));
  edges = [...edges.map(e => ({ ...e, selected: false })), { id, source, target, selected: true }];
  changed(true);
}

function addStep(kind) {
  if (!canWrite() || !saved) return;
  const taken = new Set([...records.steps.map(r => r.values['fl.step.key']), ...[...stepInfo.values()].map(s => s.key)]);
  const name = kind === 'End' ? 'Done' : 'New step';
  const id = newId('step'), key = uniqueKey(saved.key, kind === 'End' ? 'done' : name, taken);
  const box = $('canvas').getBoundingClientRect();
  const at = instance?.screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 2 }) ?? { x: 0, y: 0 };
  const offset = nodes.length % 5 * 16;
  stepInfo.set(id, { id, key, kind, name, instructions: '', doneWhen: '' });
  nodes = [...nodes.map(n => ({ ...n, selected: false })), { id, type: 'step', position: { x: Math.round(at.x - (kind === 'End' ? 70 : 100) + offset), y: Math.round(at.y - 30 + offset) }, data: {}, selected: true }];
  edges = edges.map(e => ({ ...e, selected: false }));
  changed(true);
}

/** After any edit: redraw, and rebuild the side panels whose contents are not being typed in. */
function changed(structural) {
  renderCanvas();
  const selection = nodes.find(n => n.selected)?.id ?? edges.find(e => e.selected)?.id ?? null;
  if (selection !== inspected) renderInspector(selection);
  if (structural) { renderProblems(); renderGuide(); toolbar(); }
}

function render() {
  renderCanvas(); renderInspector(nodes.find(n => n.selected)?.id ?? edges.find(e => e.selected)?.id ?? null);
  renderProblems(); renderGuide(); toolbar();
}

// ---- Side panels ----

function field(label, control) { const wrap = document.createElement('label'); wrap.append(document.createTextNode(label), control); return wrap; }
function input(value, onInput, { multiline = false, readOnly = false, max = 4000 } = {}) {
  const control = document.createElement(multiline ? 'textarea' : 'input');
  control.value = value ?? ''; control.maxLength = max; control.readOnly = readOnly || !canWrite();
  if (multiline) control.rows = 3;
  if (onInput && !control.readOnly) control.addEventListener('input', () => { onInput(control.value); renderCanvas(); toolbar(); renderGuide(); renderProblems(); });
  return control;
}

function renderInspector(selection) {
  inspected = selection;
  const panel = $('inspector'); panel.replaceChildren();
  const step = stepInfo.get(selection), edge = edgeInfo.get(selection);
  if (!saved) { $('inspector-title').textContent = 'Flow'; return; }
  if (step) {
    $('inspector-title').textContent = step.kind === 'Step' ? 'Step' : step.kind;
    const pair = document.createElement('div'); pair.className = 'pair';
    const key = input(step.key, null, { readOnly: true }); key.classList.add('mono');
    pair.append(field('Key', key), field('Kind', input(step.kind, null, { readOnly: true })));
    panel.append(field('Name', input(step.name, v => { step.name = v; }, { max: 200 })), pair);
    if (step.kind !== 'Start') {
      panel.append(field('Instructions', input(step.instructions, v => { step.instructions = v; }, { multiline: true })));
      if (step.kind === 'Step') panel.append(field('Done when', input(step.doneWhen, v => { step.doneWhen = v; }, { multiline: true })));
    } else {
      const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'A run begins on the one edge that leaves the Start.'; panel.append(p);
    }
    const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'The key and kind stay as drawn: runs and edges name a step by its key.'; panel.append(p);
    return;
  }
  if (edge) {
    const e = edges.find(x => x.id === selection);
    $('inspector-title').textContent = 'Edge';
    const p = document.createElement('p'); p.className = 'hint';
    p.textContent = `${stepInfo.get(e?.source)?.name ?? '?'} → ${stepInfo.get(e?.target)?.name ?? '?'}`;
    panel.append(p,
      field('Outcome', input(edge.outcome, v => { edge.outcome = v.trim(); }, { max: 80 })),
      field('Choose when', input(edge.when, v => { edge.when = v; }, { multiline: true })));
    return;
  }
  $('inspector-title').textContent = 'Flow';
  const key = input(saved.key, null, { readOnly: true }); key.classList.add('mono');
  panel.append(field('Name', input(flowInfo.name, v => { flowInfo.name = v; }, { max: 200 })), field('Key', key),
    field('Purpose', input(flowInfo.purpose, v => { flowInfo.purpose = v; }, { multiline: true })));
  const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'Select a step or an edge to edit it.'; panel.append(p);
}

function renderProblems() {
  const list = $('problems'); list.replaceChildren();
  if (!saved) { $('problem-count').textContent = ''; return; }
  const problems = validate(draft());
  $('problem-count').textContent = problems.length ? `· ${problems.length} to fix` : '';
  if (!problems.length) { const li = document.createElement('li'); li.className = 'clear'; li.textContent = 'Every outcome leads somewhere, and every step can reach an End.'; list.append(li); return; }
  for (const p of problems) {
    const li = document.createElement('li'); li.textContent = p.message; li.tabIndex = 0;
    const go = () => focusElement(p.id);
    li.addEventListener('click', go); li.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    list.append(li);
  }
}

function focusElement(id) {
  if (!id) return;
  nodes = nodes.map(n => ({ ...n, selected: n.id === id }));
  edges = edges.map(e => ({ ...e, selected: e.id === id }));
  const node = nodes.find(n => n.id === id) ?? nodes.find(n => n.id === edges.find(e => e.id === id)?.source);
  if (node && instance) instance.setCenter(node.position.x + 100, node.position.y + 30, { zoom: Math.max(instance.getZoom(), 0.9), duration: 250 });
  changed(false);
}

function renderGuide() {
  $('agent-guide').textContent = saved ? agentGuide({ ...draft(), id: flowId }) : '';
}

function renderRuns() {
  const f = flow(), list = $('runs'); list.replaceChildren(); $('run').replaceChildren();
  $('run-count').textContent = f?.runs.length ? `· ${f.runs.length}` : '';
  $('start-run').hidden = !f || api.context.readOnly;
  if (!f) return;
  if (!f.runs.length) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = 'No runs yet. An agent starts one over MCP (see For agents), or start one here.'; list.append(p); }
  for (const r of [...f.runs].reverse()) {
    const row = document.createElement('button'); row.type = 'button'; row.className = 'run-row'; row.setAttribute('aria-pressed', String(r.id === runId));
    const name = document.createElement('span'); name.textContent = r.title;
    const where = document.createElement('small'); where.textContent = r.status === 'Finished' ? 'Finished' : stepName(r.currentKey);
    row.append(name, where);
    row.addEventListener('click', () => { runId = r.id === runId ? null : r.id; renderRuns(); renderCanvas(); });
    list.append(row);
  }
  const run = f.runs.find(r => r.id === runId);
  if (run) $('run').append(runCard(f, run));
}

const stepName = key => [...stepInfo.values()].find(s => s.key === key)?.name ?? key ?? '—';

function runCard(f, run) {
  const card = document.createElement('div'); card.className = 'run-card';
  const title = document.createElement('h3'); title.textContent = run.title;
  const badge = document.createElement('span'); badge.className = `badge${run.status === 'Finished' ? ' finished' : ''}`; badge.textContent = run.status ?? '—';
  const head = document.createElement('div'); head.className = 'row'; head.style.justifyContent = 'space-between'; head.append(title, badge);
  card.append(head);
  const step = f.steps.find(s => s.key === run.currentKey);
  const at = document.createElement('p'); at.innerHTML = ''; at.append(document.createTextNode('At '), Object.assign(document.createElement('strong'), { textContent: step?.name ?? run.currentKey }));
  card.append(at);
  if (step?.instructions) card.append(Object.assign(document.createElement('p'), { textContent: step.instructions }));
  if (step?.doneWhen) card.append(Object.assign(document.createElement('p'), { className: 'muted', textContent: `Done when: ${step.doneWhen}` }));
  if (run.status !== 'Finished' && step) {
    const leaving = f.edges.filter(e => e.from === step.id);
    const outcomes = document.createElement('div'); outcomes.className = 'outcomes';
    for (const e of leaving) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = e.outcome; button.title = e.when ?? '';
      button.disabled = api.context.readOnly || saving;
      button.addEventListener('click', () => choose(run, e));
      outcomes.append(button);
    }
    if (leaving.length) card.append(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Choose what happened:' }), outcomes);
  }
  const path = document.createElement('p'); path.className = 'muted mono'; path.textContent = pathKeys(run).join(' › ');
  card.append(path);
  return card;
}

// ---- Writing ----

function writesForDraft() {
  const d = draft(), f = flow(), writes = [];
  const record = (list, id) => list.find(r => r.recordId === id);
  const pick = (values, old) => Object.fromEntries(Object.entries(values).filter(([k, v]) => (old.values[k] ?? null) !== v));
  const flowValues = { 'fl.flow.name': d.name, 'fl.flow.purpose': d.purpose || null };
  const flowRecord = record(records.flows, f.id), flowChanged = Object.keys(pick(flowValues, flowRecord)).length > 0;
  // Edges go before the steps they join, so a step can be deleted once nothing points at it.
  for (const r of records.edges.filter(r => r.values['fl.edge.flow'] === f.id && !d.edges.some(e => e.id === r.recordId)))
    writes.push({ op: 'delete', entityId: 'fl.edge', recordId: r.recordId, version: r.version });
  for (const r of records.steps.filter(r => r.values['fl.step.flow'] === f.id && !d.steps.some(s => s.id === r.recordId)))
    writes.push({ op: 'delete', entityId: 'fl.step', recordId: r.recordId, version: r.version });
  if (flowChanged) writes.push({ op: 'update', entityId: 'fl.flow', recordId: f.id, version: flowRecord.version, values: pick(flowValues, flowRecord) });
  const touched = new Set();
  for (const s of d.steps) {
    const old = record(records.steps, s.id);
    const values = { 'fl.step.name': s.name || 'Untitled', 'fl.step.instructions': s.instructions || null, 'fl.step.doneWhen': s.doneWhen || null, 'fl.step.x': s.x, 'fl.step.y': s.y };
    if (!old) {
      writes.push({ op: 'create', entityId: 'fl.step', recordId: s.id, values: { ...values, 'fl.step.key': s.key, 'fl.step.kind': s.kind, 'fl.step.flow': f.id },
        targetVersions: flowChanged ? {} : { 'fl.step.flow': flowRecord.version } });
      touched.add(s.id);
    } else {
      const delta = pick(values, old);
      if (Object.keys(delta).length) { writes.push({ op: 'update', entityId: 'fl.step', recordId: s.id, version: old.version, values: delta }); touched.add(s.id); }
    }
  }
  const versionOf = id => touched.has(id) ? null : record(records.steps, id)?.version;
  for (const e of d.edges) {
    const old = record(records.edges, e.id);
    const values = { 'fl.edge.outcome': e.outcome || 'next', 'fl.edge.when': e.when || null, 'fl.edge.from': e.from, 'fl.edge.to': e.to };
    const targets = Object.fromEntries([['fl.edge.from', versionOf(e.from)], ['fl.edge.to', versionOf(e.to)]].filter(([, v]) => v != null));
    if (!old) {
      if (!flowChanged) targets['fl.edge.flow'] = flowRecord.version;
      writes.push({ op: 'create', entityId: 'fl.edge', recordId: e.id, values: { ...values, 'fl.edge.flow': f.id }, targetVersions: targets });
    } else {
      const delta = pick(values, old);
      if (Object.keys(delta).length) writes.push({ op: 'update', entityId: 'fl.edge', recordId: e.id, version: old.version, values: delta,
        targetVersions: Object.fromEntries(Object.entries(targets).filter(([k]) => k in delta)) });
    }
  }
  return writes;
}

async function save() {
  if (!canWrite() || !isDirty()) return;
  saving = true; toolbar();
  try {
    const writes = writesForDraft();
    if (writes.length > 200) throw new Error(`This save is ${writes.length} record writes; Nendo takes 200 at a time. Save part of the change first.`);
    if (writes.length) await api.records.batch(writes, { label: `Flow: save ${flowInfo.name}`.slice(0, 80) });
    clearProblem(); notice(`Saved “${flowInfo.name}” in one revision.`);
    saving = false; await load();
  } catch (e) { problem(`The flow was not saved. Your draft is kept. ${e.message}`); }
  finally { saving = false; toolbar(); }
}

async function createFlow(name) {
  const key = (() => { const base = slug(name), used = new Set(flows.map(f => String(f.key).toLowerCase())); let k = base, n = 2; while (used.has(k)) k = `${base}-${n++}`; return k; })();
  const id = newId('flow'), start = newId('step'), first = newId('step'), end = newId('step');
  const taken = new Set(records.steps.map(r => r.values['fl.step.key']));
  const step = (recordId, kind, stepName, y, extra = {}) => ({ op: 'create', entityId: 'fl.step', recordId, values: {
    'fl.step.name': stepName, 'fl.step.key': uniqueKey(key, kind === 'Start' ? 'start' : kind === 'End' ? 'done' : stepName, taken), 'fl.step.kind': kind,
    'fl.step.flow': id, 'fl.step.x': kind === 'Step' ? 0 : 30, 'fl.step.y': y, ...extra } });
  const edge = (from, to, outcome) => ({ op: 'create', entityId: 'fl.edge', recordId: newId('edge'), values: { 'fl.edge.outcome': outcome, 'fl.edge.flow': id, 'fl.edge.from': from, 'fl.edge.to': to } });
  await api.records.batch([
    { op: 'create', entityId: 'fl.flow', recordId: id, values: { 'fl.flow.name': name, 'fl.flow.key': key } },
    step(start, 'Start', 'Start', 0), step(first, 'Step', 'First step', 110, { 'fl.step.instructions': 'Say what to do here.', 'fl.step.doneWhen': 'Say how to tell it is done.' }), step(end, 'End', 'Done', 240),
    edge(start, first, 'begin'), edge(first, end, 'done'),
  ], { label: `Flow: new flow ${name}`.slice(0, 80) });
  flowId = id; runId = null; fitPending = true; await load();
}

async function startRun(title) {
  const f = flow(); if (!f) return;
  if (isDirty()) { problem('Save the flow before starting a run: a run walks what is saved.'); return; }
  const start = f.steps.find(s => s.kind === 'Start'), edge = start && f.edges.find(e => e.from === start.id);
  if (!edge) { problem('This flow needs a Start with an edge leaving it before a run can begin.'); return; }
  const id = newId('run');
  try {
    await api.records.create('fl.run', { 'fl.run.title': title, 'fl.run.flow': f.id, 'fl.run.choice': edge.id },
      { recordId: id, targetVersions: { 'fl.run.flow': f.version, 'fl.run.choice': edge.version } });
    runId = id; $('run-title').value = ''; clearProblem(); await load({ keepDraft: true });
  } catch (e) { problem(`The run did not start. ${e.message}`); }
}

async function choose(run, edge) {
  try {
    await api.records.update({ entityId: 'fl.run', recordId: run.id, version: run.version }, { 'fl.run.choice': edge.id },
      { targetVersions: { 'fl.run.choice': edge.version } });
    clearProblem(); await load({ keepDraft: true });
  } catch (e) { problem(`Nendo did not move the run. ${e.message}`); }
}

// ---- Wiring ----

async function boot() {
  if (!api) { problem('Open this file in Nendo to use Flow.'); return; }
  await api.ready;
  if (!api.has('records.batch')) throw new Error('Flow needs a Nendo host with records.batch. Update Nendo and reopen the file.');
  theme = api.ui.theme?.mode === 'dark' ? 'dark' : 'light';
  api.on('theme', value => { theme = value?.mode === 'dark' ? 'dark' : 'light'; renderCanvas(); });
  api.on('command', e => {
    if (e.id === 'flow') {
      if (isDirty()) { problem('Save this flow or Reload saved before opening another.'); toolbar(); return; }
      flowId = e.value; runId = null; fitPending = true; openDraft(flow()); render(); renderRuns();
    }
    else if (e.id === 'new-flow' && canWrite()) { $('new-flow-name').value = ''; $('new-flow-dialog').showModal(); }
    else if (e.id === 'add-step') addStep('Step');
    else if (e.id === 'add-end') addStep('End');
    else if (e.id === 'fit') instance?.fitView({ padding: 0.2, duration: 200 });
    else if (e.id === 'save') save();
    else if (e.id === 'discard') { openDraft(flow()); clearProblem(); render(); renderRuns(); notice('Reloaded the saved flow.'); }
  });
  api.on('changes', () => { if (!saving) load({ keepDraft: true }); });
  $('new-flow-form').addEventListener('submit', async e => {
    e.preventDefault(); const name = $('new-flow-name').value.trim(); if (!name) return;
    $('new-flow-dialog').close();
    try { await createFlow(name); notice(`Created “${name}”.`); } catch (error) { problem(`The flow was not created. ${error.message}`); }
  });
  $('cancel-new-flow').addEventListener('click', () => $('new-flow-dialog').close());
  $('start-run').addEventListener('submit', e => { e.preventDefault(); const title = $('run-title').value.trim() || `Run ${new Date().toLocaleString()}`; startRun(title); });
  $('copy-guide').addEventListener('click', async () => {
    try { window.focus(); await navigator.clipboard.writeText($('agent-guide').textContent); notice('Copied the steps for agents.'); }
    catch { notice('Select the text and copy it.'); }
  });
  await load();
  notice(api.context.readOnly ? 'This file is read-only here.' : 'Ready. Edit the flow, then Save; or start a run and choose what happened at each step.');
  // A read-only measurement surface for the gate: no storage or host access.
  window.flowApp = {
    get draft() { return saved ? structuredClone(draft()) : null; },
    get problems() { return saved ? validate(draft()) : []; },
    get dirty() { return isDirty(); },
    get runId() { return runId; },
  };
}
boot().catch(problem);
