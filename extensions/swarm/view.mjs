import { Simulation, replayAsync, validate, ACTIONS, CONDITIONS, LIMITS } from './simulation.mjs';
import { diagramXML, fromRecords, KIND, TYPES, size } from './model.mjs';
const $ = id => document.getElementById(id);
const api = window.nendo;
const prefix = { species: 'sw.species', nodes: 'sw.node', links: 'sw.link', habitats: 'sw.habitat', experiments: 'sw.experiment' };
const colours = { Wander: '--nendo-cobalt', Gather: '--nendo-healthy', Align: '--nendo-warning', Flee: '--nendo-danger', Rest: '--nendo-tone-violet' };
let records, model, sim, selectedSpecies, selectedHabitat, diagram, selectedElement, importing = false;
let dirty = false, saving = false, externalChange = false, playing = false, replayMode = false, loading = false, pendingReload = false;
let last = 0, accumulator = 0, displayedTick = -1, canvasWidth = 0, canvasHeight = 0;
let palette = {}, unsubscribe = [];
const notice = text => { $('status').textContent = text; };
const problem = error => { $('problem').textContent = error?.message ?? String(error); $('problem').hidden = false; };
const clearProblem = () => { $('problem').hidden = true; $('problem').textContent = ''; };
const canWrite = () => !api.context.readOnly && !replayMode && !saving && !loading;
function toolbar() {
  if (!records) return;
  api.ui.setToolbar({ items: [
    { kind: 'select', id: 'species', label: 'Species', value: selectedSpecies, options: records.species.map(r => ({ value: r.recordId, label: r.values['sw.species.name'] })) },
    { kind: 'button', id: 'play', label: playing ? 'Pause' : 'Play', disabled: !sim || loading, keys: 'Alt+P' },
    { kind: 'button', id: 'reset', label: 'Reset', disabled: !sim || loading },
    { kind: 'button', id: 'save-behaviour', label: saving ? 'Saving…' : 'Save behaviour', disabled: !dirty || !canWrite(), keys: 'Ctrl+S' },
    { kind: 'button', id: 'save-experiment', label: 'Save experiment', disabled: !canWrite() || !sim },
    { kind: 'spacer' },
    { kind: 'text', text: replayMode ? 'Captured experiment · Reload saved to return' : 'Click the habitat to startle creatures' },
  ] }).catch(problem);
}
function markDirty() {
  if (importing || replayMode) return;
  dirty = true; $('draft-state').textContent = 'Unsaved behaviour'; toolbar(); keepSoon();
}
// The behaviour being edited outlasts the view: Nendo stops a view when the person goes to another
// screen and starts it again on return. The draft waits in the view's own storage, which Nendo
// gives each package in each file, never in the file, until it is saved or Reload saved drops it.
const draftKey = () => `swarm.draft.v1.${api.context.viewId ?? 'swarm'}`;
const DRAFT_CHARACTERS = 256 * 1024;
let keepTimer = null, recovering = true;
const baseOf = species => JSON.stringify([records.species.find(r => r.recordId === species)?.version ?? null,
  ...records.nodes.filter(r => r.values['sw.node.species'] === species).map(r => [r.recordId, r.version]),
  ...records.links.filter(r => r.values['sw.link.species'] === species).map(r => [r.recordId, r.version])]);
function keepDraft() {
  clearTimeout(keepTimer); keepTimer = null;
  try {
    if (!dirty || replayMode || !model || !records) { localStorage.removeItem(draftKey()); return; }
    const text = JSON.stringify({ species: selectedSpecies, base: baseOf(selectedSpecies), model });
    if (text.length <= DRAFT_CHARACTERS) localStorage.setItem(draftKey(), text);
  } catch { /* A window with no storage keeps the draft only while the view runs. */ }
}
const keepSoon = () => { if (keepTimer === null) keepTimer = setTimeout(keepDraft, 250); };
function keptDraft() {
  try {
    const kept = JSON.parse(localStorage.getItem(draftKey()) ?? 'null');
    return kept && typeof kept.species === 'string' && kept.model?.species && Array.isArray(kept.model.nodes) && Array.isArray(kept.model.links) ? kept : null;
  } catch { return null; }
}
function refreshPalette() {
  const style = getComputedStyle(document.documentElement);
  const read = name => style.getPropertyValue(name).trim();
  palette = { background: read('--nendo-surface-soft'), grid: read('--nendo-line'), text: read('--nendo-muted'), accent: read('--nendo-cobalt') };
  for (const [name, token] of Object.entries(colours)) palette[name] = read(token) || read('--nendo-cobalt');
  // Tone tokens differ between host versions; every fallback remains a host colour.
  redraw(true); updateMetrics();
}
function controls() {
  for (const [id, field] of [['population', 'population'], ['speed', 'speed'], ['perception', 'perception'], ['cohesion', 'cohesion'], ['align-strength', 'alignment'], ['separation', 'separation'], ['seed', 'seed']]) {
    $(id).value = model.species[field]; $(id).disabled = replayMode || api.context.readOnly;
  }
  $('species-name').textContent = model.species.name;
  $('description').textContent = model.species.description;
  $('population-count').textContent = `${model.species.population} creatures`;
  $('draft-state').textContent = replayMode ? 'Captured behaviour · read only' : dirty ? 'Unsaved behaviour' : 'Saved behaviour';
  $('add-action').disabled = $('add-decision').disabled = replayMode || api.context.readOnly;
}
function readDiagram() {
  const previous = new Map(model.nodes.map(n => [n.id, n]));
  const elements = diagram.get('elementRegistry').getAll().filter(e => !e.labelTarget && e.type !== 'bpmn:Process');
  const nodes = elements.filter(e => !e.waypoints).map(e => {
    const old = previous.get(e.id);
    return { id: e.id, kind: KIND[e.type] ?? e.type, name: e.businessObject.name ?? '', x: Math.round(e.x), y: Math.round(e.y),
      action: old?.action ?? 'Wander', condition: old?.condition ?? 'Nearby', duration: old?.duration ?? 40 };
  });
  const links = elements.filter(e => e.waypoints).map(e => ({ id: e.id, source: e.source.id, target: e.target.id,
    branch: e.businessObject.name === 'Yes' ? 'Yes' : e.businessObject.name === 'No' ? 'No' : 'Next', name: e.businessObject.name || 'Next',
    waypoints: e.waypoints.map(p => ({ x: p.x, y: p.y })) }));
  model.nodes = nodes; model.links = links;
  return model;
}
function restart() {
  clearProblem();
  try { readDiagram(); sim = new Simulation(model); playing = false; accumulator = 0; displayedTick = -1; redraw(true); updateMetrics(); notice('Reset to the seed. Press Play to explore this behaviour.'); }
  catch (e) { sim = null; playing = false; problem(e); }
  toolbar();
}
function play() {
  if (!sim) return;
  if (!playing && !replayMode) {
    readDiagram(); const errors = validate(model); if (errors.length) { problem(errors.join('\n')); return; }
    // Editing changes the next run, not the frozen model of an existing run.
    if (JSON.stringify(sim.model) !== JSON.stringify(model)) { sim = new Simulation(model); redraw(true); notice('Started a new run with the edited behaviour.'); }
  }
  if (sim.tick >= LIMITS.ticks) { notice('This run reached 18,000 steps. Save it or Reset to start another.'); return; }
  playing = !playing; accumulator = 0; last = performance.now(); updateMetrics(); toolbar(); clearProblem();
}
function add(kind) {
  if (!canWrite()) return;
  const root = diagram.get('canvas').getRootElement();
  const shape = diagram.get('modeling').createShape({ type: TYPES[kind], ...size(kind) }, { x: 240 + model.nodes.length * 14, y: 390 }, root);
  diagram.get('modeling').updateProperties(shape, { name: kind === 'Action' ? 'Wander' : 'Neighbours?' });
  diagram.get('selection').select(shape); selectedElement = shape; readDiagram(); inspector(shape);
}
function field(label, input) { const wrap = document.createElement('label'); input.setAttribute('aria-label', label); wrap.append(document.createTextNode(label), input); return wrap; }
function select(values, value, onChange) {
  const input = document.createElement('select');
  for (const name of values) input.add(new Option(name, name)); input.value = value; input.disabled = !canWrite();
  input.addEventListener('change', () => { onChange(input.value); markDirty(); }); return input;
}
function inspector(element) {
  $('inspector').replaceChildren();
  if (!element || element.labelTarget || element.type === 'bpmn:Process') { const p = document.createElement('p'); p.textContent = 'Select an action or a decision to change what it does. Use its ↗ control to connect it.'; $('inspector').append(p); return; }
  readDiagram();
  const node = model.nodes.find(n => n.id === element.id), link = model.links.find(l => l.id === element.id);
  const grid = document.createElement('div'); grid.className = 'inspector-fields';
  const name = document.createElement('input'); name.value = element.businessObject.name ?? ''; name.maxLength = 120; name.disabled = !canWrite();
  name.addEventListener('change', () => { diagram.get('modeling').updateProperties(element, { name: name.value }); readDiagram(); markDirty(); });
  grid.append(field('Name', name));
  if (node?.kind === 'Action') {
    grid.append(field('Action', select(ACTIONS, node.action, value => { model.nodes.find(n => n.id === element.id).action = value; })));
    const duration = document.createElement('input'); duration.type = 'number'; duration.min = 1; duration.max = 600; duration.step = 1; duration.value = node.duration; duration.disabled = !canWrite();
    duration.addEventListener('change', () => { model.nodes.find(n => n.id === element.id).duration = Number(duration.value); markDirty(); }); grid.append(field('Steps', duration));
  } else if (node?.kind === 'Decision') grid.append(field('Question', select(CONDITIONS, node.condition, value => { model.nodes.find(n => n.id === element.id).condition = value; })));
  else if (link) grid.append(field('Path', select(['Next', 'Yes', 'No'], link.branch, value => { diagram.get('modeling').updateProperties(element, { name: value === 'Next' ? '' : value }); readDiagram(); })));
  $('inspector').append(grid);
}
function SwarmContextPad(contextPad, connect, modeling) {
  // Run after the BPMN provider so only Swarm's supported operations remain.
  contextPad.registerProvider(500, this);
  this.getContextPadEntries = element => () => canWrite() ? {
    connect: { group: 'connect', html: '<div class="entry" title="Connect to another node" aria-label="Connect to another node">↗</div>', action: { click: e => connect.start(e, element), dragstart: e => connect.start(e, element) } },
    remove: { group: 'edit', html: '<div class="entry" title="Remove selection" aria-label="Remove selection">×</div>', action: { click: () => modeling.removeElements([element]) } },
  } : {};
}
SwarmContextPad.$inject = ['contextPad', 'connect', 'modeling'];
function SwarmRules(eventBus) {
  for (const action of ['shape.create', 'shape.move', 'elements.move', 'shape.resize', 'connection.create', 'connection.reconnect', 'elements.delete', 'shape.replace'])
    eventBus.on(`commandStack.${action}.canExecute`, 10000, () => canWrite() ? undefined : false);
}
SwarmRules.$inject = ['eventBus'];
async function loadDiagram() {
  importing = true;
  try { await diagram.importXML(diagramXML(model)); diagram.get('canvas').zoom('fit-viewport', 'auto'); selectedElement = null; inspector(null); }
  finally { importing = false; }
}
async function readAll() {
  const out = {};
  // Sequential reads minimise overlapping full-file traversals in the host.
  for (const [key, entityId] of Object.entries(prefix)) out[key] = await api.records.queryAll({ entityId }, { max: 2000 });
  return out;
}
async function load() {
  if (loading) { pendingReload = true; return; }
  loading = true; playing = false; toolbar();
  try {
    records = await readAll();
    if (!records.species.length || !records.habitats.length) throw new Error('This Swarm file needs a species and a habitat. Restore the seeded app or add records in Studio.');
    const kept = recovering ? keptDraft() : null;
    if (kept && records.species.some(r => r.recordId === kept.species)) selectedSpecies = kept.species;
    if (!records.species.some(r => r.recordId === selectedSpecies)) selectedSpecies = records.species.find(r => r.recordId === 'sw_species_murmuration')?.recordId ?? records.species[0].recordId;
    selectedHabitat ??= records.habitats[0].recordId;
    model = fromRecords(records, selectedSpecies, selectedHabitat); dirty = false; externalChange = false; replayMode = false;
    const restored = kept && kept.species === selectedSpecies;
    if (restored) { model = { ...kept.model, habitat: model.habitat }; dirty = true; externalChange = kept.base !== baseOf(selectedSpecies); }
    recovering = false;
    keepDraft();
    await loadDiagram(); sim = new Simulation(model); controls(); redraw(true); updateMetrics(); renderExperiments();
    $('workspace').setAttribute('aria-busy', 'false'); clearProblem();
    notice(!restored ? 'Ready. Edit the behaviour, or press Play and startle a group.'
      : externalChange ? 'Your unsaved behaviour was kept from before, but the saved behaviour changed since. Reload saved discards the draft.'
        : 'Your unsaved behaviour was kept from before. Save behaviour keeps it in the file; Reload saved discards it.');
  } catch (e) { sim = null; problem(e); }
  finally { loading = false; toolbar(); if (pendingReload) { pendingReload = false; await load(); } }
}
const pack = (object, p, keys) => Object.fromEntries(keys.map(k => [`${p}.${k}`, object[k] ?? null]));
function writesForDraft() {
  const s = records.species.find(r => r.recordId === selectedSpecies), versionOf = id => records.nodes.find(r => r.recordId === id)?.version;
  const nodeKeys = ['name', 'kind', 'action', 'condition', 'duration', 'x', 'y'];
  const linkKeys = ['name', 'source', 'target', 'branch', 'waypoints'];
  const writes = [];
  function edit(old, entityId, id, values, targets = {}) {
    const changed = Object.fromEntries(Object.entries(values).filter(([k, v]) => !old || old.values[k] !== v));
    if (!Object.keys(changed).length) return;
    const targetVersions = Object.fromEntries(Object.entries(targets).filter(([k]) => k in changed));
    writes.push(old ? { op: 'update', entityId, recordId: id, version: old.version, values: changed, targetVersions } : { op: 'create', entityId, recordId: id, values, targetVersions });
  }
  for (const r of records.links.filter(r => r.values['sw.link.species'] === selectedSpecies && !model.links.some(l => l.id === r.recordId))) writes.push({ op: 'delete', entityId: r.entityId, recordId: r.recordId, version: r.version });
  for (const r of records.nodes.filter(r => r.values['sw.node.species'] === selectedSpecies && !model.nodes.some(n => n.id === r.recordId))) writes.push({ op: 'delete', entityId: r.entityId, recordId: r.recordId, version: r.version });
  // Species update first; later references use its returned batch version implicitly.
  edit(s, 'sw.species', selectedSpecies, pack(model.species, 'sw.species', ['population', 'speed', 'perception', 'cohesion', 'alignment', 'separation', 'seed']));
  const speciesChanged = writes.some(w => w.entityId === 'sw.species');
  for (const n of model.nodes) {
    const old = records.nodes.find(r => r.recordId === n.id);
    const values = pack(n, 'sw.node', nodeKeys); if (!old) values['sw.node.species'] = selectedSpecies;
    edit(old, 'sw.node', n.id, values, speciesChanged ? {} : { 'sw.node.species': s.version });
  }
  const changedNodes = new Set(writes.filter(w => w.entityId === 'sw.node' && w.op !== 'delete').map(w => w.recordId));
  for (const l of model.links) {
    const old = records.links.find(r => r.recordId === l.id), values = pack({ ...l, waypoints: JSON.stringify(l.waypoints ?? []) }, 'sw.link', linkKeys); if (!old) values['sw.link.species'] = selectedSpecies;
    const targets = {}; if (!speciesChanged) targets['sw.link.species'] = s.version;
    if (!changedNodes.has(l.source)) targets['sw.link.source'] = versionOf(l.source);
    if (!changedNodes.has(l.target)) targets['sw.link.target'] = versionOf(l.target);
    edit(old, 'sw.link', l.id, values, targets);
  }
  return writes;
}
async function saveBehaviour() {
  if (!canWrite() || !dirty) return;
  readDiagram(); const errors = validate(model); if (errors.length) { problem(errors.join('\n')); return; }
  if (externalChange) { problem('The file changed while you were editing. Your draft is kept. Reload saved before making a new edit.'); return; }
  saving = true; playing = false; toolbar();
  try {
    const writes = writesForDraft();
    try {
      if (writes.length) await api.records.batch(writes, { label: `Swarm: save ${model.species.name} behaviour` });
    } catch (e) {
      // Only a refusal says nothing was kept; a timeout or a reconnect leaves it unknown.
      problem(['host-timeout', 'disconnected'].includes(e.code)
        ? `Nendo did not answer whether the behaviour was saved. Your draft is kept. Reload saved shows what the file holds now. ${e.message}`
        : `The behaviour was not saved. Your draft is kept. ${e.message}`);
      return;
    }
    dirty = false; externalChange = false; keepDraft(); $('draft-state').textContent = 'Saved behaviour';
    try { records = await readAll(); } catch (e) { problem(`The behaviour was saved, but reading it back failed. Reload saved to see it. ${e.message}`); return; }
    clearProblem(); notice('Behaviour saved in one revision. Reset to run it from the seed.');
  } catch (e) { problem(`The behaviour was not saved. Your draft is kept. ${e.message}`); }
  finally { saving = false; toolbar(); }
}
async function saveExperiment(name) {
  if (!canWrite() || !sim) return;
  saving = true; playing = false; toolbar();
  try {
    const s = records.species.find(r => r.recordId === selectedSpecies), h = records.habitats.find(r => r.recordId === selectedHabitat);
    const snapshot = sim.snapshot(name);
    await api.records.create('sw.experiment', {
      'sw.experiment.name': name, 'sw.experiment.species': s.recordId, 'sw.experiment.habitat': h.recordId,
      'sw.experiment.seed': snapshot.model.species.seed, 'sw.experiment.steps': snapshot.ticks,
      'sw.experiment.population': snapshot.model.species.population, 'sw.experiment.snapshot': JSON.stringify(snapshot),
    }, { targetVersions: { 'sw.experiment.species': s.version, 'sw.experiment.habitat': h.version } });
    records.experiments = await api.records.queryAll({ entityId: 'sw.experiment' }, { max: 2000 }); renderExperiments(); $('save-dialog').close(); $('experiments').open = true; clearProblem(); notice(`Saved “${name}”, including the rules used by this run.`);
  } catch (e) { problem(`The experiment was not saved. ${e.message}`); }
  finally { saving = false; toolbar(); updateMetrics(); }
}
async function replayExperiment(record) {
  if (dirty) { problem('Save your behaviour or Reload saved before opening an experiment.'); return; }
  playing = false; loading = true; toolbar(); notice('Replaying captured steps…');
  try {
    const snapshot = JSON.parse(record.values['sw.experiment.snapshot']);
    const restored = await replayAsync(snapshot, (tick, total) => notice(`Replaying captured steps… ${Math.round(tick / total * 100)}%`)); model = structuredClone(snapshot.model); sim = restored; replayMode = true;
    await loadDiagram(); controls(); redraw(true); updateMetrics(); clearProblem(); notice(`Replayed “${record.values['sw.experiment.name']}” at step ${sim.tick}. Its captured rules are shown. Reload saved returns to the live species.`);
  } catch (e) { problem(`This experiment could not be replayed: ${e.message}`); }
  finally { loading = false; toolbar(); if (pendingReload) { pendingReload = false; await load(); } }
}
function renderExperiments() {
  $('experiment-count').textContent = records.experiments.length; $('experiment-list').replaceChildren();
  if (!records.experiments.length) { const p = document.createElement('p'); p.textContent = 'Save a run to keep its behaviour and replay it later.'; $('experiment-list').append(p); }
  for (const record of [...records.experiments].reverse()) {
    const row = document.createElement('div'); row.className = 'experiment-row';
    const copy = document.createElement('span'); copy.className = 'experiment-copy'; copy.textContent = record.values['sw.experiment.name'];
    const small = document.createElement('small'); small.textContent = `${record.values['sw.experiment.population']} creatures · ${record.values['sw.experiment.steps']} steps · seed ${record.values['sw.experiment.seed']}`; copy.append(small);
    const button = document.createElement('button'); button.textContent = 'Replay'; button.type = 'button'; button.addEventListener('click', () => replayExperiment(record)); row.append(copy, button); $('experiment-list').append(row);
  }
}
function redraw(clear = false) {
  if (!sim || !palette.background) return;
  const canvas = $('habitat'), rect = canvas.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
  if (canvasWidth !== rect.width || canvasHeight !== rect.height) { canvasWidth = rect.width; canvasHeight = rect.height; canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr); clear = true; }
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = clear ? 1 : .2; ctx.fillStyle = palette.background; ctx.fillRect(0, 0, rect.width, rect.height); ctx.globalAlpha = 1;
  const sx = rect.width / sim.model.habitat.width, sy = rect.height / sim.model.habitat.height;
  if (clear) { ctx.fillStyle = palette.grid; for (let y = 18; y < rect.height; y += 28) for (let x = 18; x < rect.width; x += 28) ctx.fillRect(x, y, 1, 1); }
  for (const a of sim.agents) {
    ctx.fillStyle = palette[a.action]; const x = a.x * sx, y = a.y * sy, angle = Math.atan2(a.vy, a.vx);
    ctx.save(); ctx.translate(x, y); ctx.rotate(angle); ctx.beginPath();
    if (a.action === 'Rest') ctx.arc(0, 0, 2.2, 0, Math.PI * 2);
    else { ctx.moveTo(4, 0); ctx.lineTo(-2.6, 1.7); ctx.lineTo(-1.3, 0); ctx.lineTo(-2.6, -1.7); ctx.closePath(); }
    ctx.fill(); ctx.restore();
  }
  for (const e of sim.activeDisturbances) {
    const age = sim.tick - e.tick; ctx.strokeStyle = palette.Flee; ctx.globalAlpha = Math.max(0, 1 - age / 150); ctx.beginPath(); ctx.arc(e.x * sx, e.y * sy, (12 + age * 1.5) * sx, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
function updateMetrics() {
  if (!sim) return;
  $('run-state').textContent = replayMode ? 'Captured run' : playing ? 'Living' : 'Paused';
  $('paused-hint').hidden = playing || sim.tick > 0;
  const seconds = Math.floor(sim.tick / 60); $('time').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  $('alignment').textContent = `${Math.round(sim.metrics.alignment * 100)}%`; $('neighbours').textContent = sim.metrics.neighbours.toFixed(1);
  $('state-counts').replaceChildren(...ACTIONS.map(action => {
    const span = document.createElement('span'); span.className = 'state'; const dot = document.createElement('i'); dot.className = 'dot'; dot.style.setProperty('--state-colour', palette[action] || palette.accent);
    span.append(dot, document.createTextNode(`${action} ${sim.metrics.states[action] ?? (sim.tick === 0 && action === 'Wander' ? sim.agents.length : 0)}`)); return span;
  }));
  if (diagram) { const canvas = diagram.get('canvas'), active = new Set(sim.agents.map(a => a.node)); for (const n of model.nodes) { if (!diagram.get('elementRegistry').get(n.id)) continue; canvas[active.has(n.id) ? 'addMarker' : 'removeMarker'](n.id, 'swarm-active'); } }
}
function animate(now) {
  if (playing && sim && document.visibilityState !== 'hidden') {
    accumulator += Math.min((now - last) / 1000, .1); let steps = 0;
    while (accumulator >= 1 / 60 && steps++ < 6) { if (!sim.step()) { playing = false; toolbar(); notice('This run reached 18,000 steps. Save it or Reset.'); break; } accumulator -= 1 / 60; }
    redraw(); if (sim.tick - displayedTick >= 12) { displayedTick = sim.tick; updateMetrics(); }
  }
  last = now; requestAnimationFrame(animate);
}
async function boot() {
  if (!api) { problem('Open Swarm.nendo in Nendo to use this app.'); return; }
  await api.ready;
  if (!api.has('records.batch')) throw new Error('Swarm needs a Nendo host with records.batch. Update Nendo and reopen the file.');
  diagram = new window.BpmnJS({ container: '#diagram', additionalModules: [{ __init__: ['swarmContextPad', 'swarmRules'], swarmContextPad: ['type', SwarmContextPad], swarmRules: ['type', SwarmRules] }] });
  diagram.on('commandStack.changed', () => { if (!importing) { readDiagram(); markDirty(); } });
  diagram.on('selection.changed', e => { selectedElement = e.newSelection[0]; inspector(selectedElement); });
  $('add-action').addEventListener('click', () => add('Action')); $('add-decision').addEventListener('click', () => add('Decision'));
  $('fit').addEventListener('click', () => diagram.get('canvas').zoom('fit-viewport', 'auto'));
  $('discard').addEventListener('click', () => load());
  $('parameters').addEventListener('submit', e => e.preventDefault());
  for (const [id, field] of [['population', 'population'], ['speed', 'speed'], ['perception', 'perception'], ['cohesion', 'cohesion'], ['align-strength', 'alignment'], ['separation', 'separation'], ['seed', 'seed']])
    $(id).addEventListener('change', () => { model.species[field] = Number($(id).value); markDirty(); });
  $('habitat').addEventListener('pointerdown', e => {
    if (!sim || replayMode) return; const rect = $('habitat').getBoundingClientRect();
    try { sim.disturb((e.clientX - rect.left) / rect.width * sim.model.habitat.width, (e.clientY - rect.top) / rect.height * sim.model.habitat.height); redraw(); notice('Disturbance added. Creatures follow their Disturbed decision when they reach it.'); } catch (error) { problem(error); }
  });
  $('habitat').addEventListener('keydown', e => { if (e.key === 'Enter' && sim && !replayMode) { e.preventDefault(); try { sim.disturb(sim.model.habitat.width / 2, sim.model.habitat.height / 2); redraw(); } catch (error) { problem(error); } } });
  $('cancel-save').addEventListener('click', () => $('save-dialog').close());
  $('save-form').addEventListener('submit', e => { e.preventDefault(); const name = $('experiment-name').value.trim(); if (name) saveExperiment(name); });
  unsubscribe.push(api.on('command', e => {
    if (e.id === 'play') play();
    else if (e.id === 'reset') restart();
    else if (e.id === 'save-behaviour') saveBehaviour();
    else if (e.id === 'save-experiment' && canWrite() && sim) { playing = false; toolbar(); updateMetrics(); $('experiment-name').value = `${sim.model.species.name} · ${sim.tick} steps`; $('save-dialog').showModal(); }
    else if (e.id === 'species') {
      if (dirty) { problem('Save your behaviour or Reload saved before choosing another species.'); toolbar(); return; }
      selectedSpecies = e.value; load();
    }
  }));
  unsubscribe.push(api.on('theme', () => refreshPalette()));
  unsubscribe.push(api.on('changes', () => {
    if (saving) return;
    if (dirty || replayMode) { externalChange = true; notice('The file changed elsewhere. Your draft or captured run is kept. Reload saved to read the latest records.'); }
    else load();
  }));
  const resize = new ResizeObserver(() => redraw(true)); resize.observe($('habitat-stage'));
  window.addEventListener('pagehide', () => { keepDraft(); unsubscribe.forEach(fn => fn()); resize.disconnect(); diagram.destroy(); });
  refreshPalette(); await load(); requestAnimationFrame(animate);
  // A compact read-only measurement surface: no storage or privileged host access.
  window.swarm = { get model() { return structuredClone(model); }, get metrics() { return structuredClone(sim?.metrics); }, get tick() { return sim?.tick; }, get dirty() { return dirty; }, get snapshot() { return sim?.snapshot(); }, get digest() { return sim?.digest(); } };
}
boot().catch(problem);
