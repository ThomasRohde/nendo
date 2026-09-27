// Capability Atlas: a business capability map over one hierarchical record type (ADR-0013).
//
// Everything arrives through window.nendo. The capabilities are read as the tree the file
// declares (nendo.records.treeAll, ADR-0019), so the Engine keeps it free of loops and orders
// each level; the applications, support links and initiatives are read to show
// what supports and changes the selected capability. The map is packed by the owner's BCM
// reference layout (layout.js, loaded as window.BcmLayout) with the lab preset in
// layout-profile.js; Assessment and Outline are tables of the same rows. The only writes are
// capability creates and updates, sent with the parent's version so a stale parent is refused,
// and a parent that would close a loop is refused by the Engine in words the editor shows.
// Nothing leaves Nendo.
import {
  CAPABILITY, FIELD, value, title, gap, hierarchy, projectHierarchy,
  maturityLabels, importanceOptions, investmentOptions, lifecycleOptions,
} from './model.js';
import { layoutCapabilities, fitViewport } from './layout-profile.js';

// ---------------------------------------------------------------------------------------------
// State

// The records as last read, and the hierarchy built from the capabilities (model.js).
let records = [], applications = [], supports = [], initiatives = [];
let model = hierarchy([]);
// Whether the file declares no capability hierarchy, which is the one thing the map needs.
let undeclared = false;

// What the person is looking at.
let selected = null;        // record ID of the selected capability
let scope = null;           // record ID of the focused group; null is the whole enterprise
let mode = 'map';           // 'map', 'assessment' or 'outline'
let colour = 'maturity';    // what card colour shows: maturity, gap, importance, investment, none
let layoutMode = 'compact'; // the reference layout's 'compact' or 'ordered' packing
let levels = 2;             // levels shown below the scope; Infinity shows them all
let query = '';             // the search text, trimmed and lower case

// The rows and tree for the current scope and levels (projectHierarchy).
let projection = null;

// The packed map, the inputs it was packed for (see renderMap), and the camera.
let layout = null, layoutKey = null, modelGeneration = 0;
let zoom = 1, pan = { x: 20, y: 20 };

// The capability in the editor (null for a new one), and whether its form has changed.
let editing = null, dirty = false;

// The latest refresh wins over one still in flight; a burst of changes is read once.
let loading = 0, refreshTimer;

// ---------------------------------------------------------------------------------------------
// Small helpers

const $ = id => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** A button whose action may be async. A failure is shown in the status line. */
function button(label, action, className) {
  const b = el('button', className, label);
  b.type = 'button';
  b.addEventListener('click', async event => {
    try {
      await action(event);
    } catch (error) {
      say(error.message);
    }
  });
  return b;
}

function say(message) {
  $('status').textContent = message;
}

/** "3 · Defined", or the fallback when there is no assessment. */
function maturityText(level, fallback) {
  return level == null ? fallback : `${level} · ${maturityLabels[level]}`;
}

// ---------------------------------------------------------------------------------------------
// Colour. Cards use the Workbench's tone tokens (--nendo-tone-*), set per card as --tone.

const maturityTones = ['grey', 'red', 'orange', 'amber', 'teal', 'green']; // by level 0-5
const importanceTones = { Supporting: 'grey', Core: 'blue', Differentiating: 'violet' };
const investmentTones = { Tolerate: 'blue', Invest: 'teal', Migrate: 'amber', Eliminate: 'red' };

function toneFor(record) {
  switch (colour) {
    case 'none':
      return 'grey';
    case 'maturity':
      return maturityTones[Number(value(record, 'maturity'))] || 'grey';
    case 'gap': {
      const g = gap(record);
      if (g == null) return 'grey';
      if (g <= 0) return 'teal';
      return g === 1 ? 'amber' : g === 2 ? 'orange' : 'red';
    }
    case 'importance':
      return importanceTones[value(record, 'importance')] || 'grey';
    default:
      return investmentTones[value(record, 'investment')] || 'grey';
  }
}

function setTone(node, tone) {
  node.style.setProperty('--tone', `var(--nendo-tone-${tone})`);
}

function legendEntries() {
  switch (colour) {
    case 'maturity':
      return maturityLabels.map((label, level) => [label, maturityTones[level]]);
    case 'gap':
      return [['At / above target', 'teal'], ['1 level', 'amber'], ['2 levels', 'orange'], ['3+ levels', 'red'], ['Unassessed', 'grey']];
    case 'importance':
      return Object.entries(importanceTones);
    case 'investment':
      return Object.entries(investmentTones);
    default:
      return [['Neutral', 'grey']];
  }
}

function legend() {
  $('legend').replaceChildren(...legendEntries().map(([label, tone]) => {
    const entry = el('span'), dot = el('i');
    setTone(dot, tone);
    entry.append(dot, document.createTextNode(label));
    return entry;
  }));
}

// ---------------------------------------------------------------------------------------------
// Search and scope

/** Whether a capability matches the search, by name, reference, owner or definition. */
function matches(record) {
  if (!query) return true;
  const text = [title(record), value(record, 'code'), value(record, 'owner'), value(record, 'description')].join(' ');
  return text.toLowerCase().includes(query);
}

/** The focused group and everything under it, or every capability at the enterprise. */
function recordsInScope() {
  return scope && model.byId.has(scope) ? [model.byId.get(scope), ...model.descendants(scope)] : records;
}

/** Focus a group, or the enterprise with null, keeping the level choice within its depth. */
function scopeTo(id) {
  scope = id;
  selected = id;
  const depth = projectHierarchy(model, scope).maxDepth;
  if (Number.isFinite(levels)) levels = Math.min(levels, Math.max(1, depth));
  render(true);
}

function setMode(next) {
  mode = next;
  document.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  render(true);
}

// ---------------------------------------------------------------------------------------------
// Header: summary, breadcrumbs and level choice

/** The summary figures describe the whole scope, whatever the level choice hides. */
function stats() {
  const inScope = recordsInScope();
  $('total').textContent = inScope.length;
  $('leaves').textContent = inScope.filter(record => !model.children.get(record.recordId)?.length).length;
  $('gaps').textContent = inScope.filter(record => gap(record) > 0).length;
  $('unassessed').textContent = inScope.filter(record => value(record, 'maturity') == null).length;
}

function breadcrumbs() {
  const nav = $('breadcrumbs');
  nav.replaceChildren(button('Enterprise', () => scopeTo(null)));
  const ancestors = [];
  for (let id = scope; id && model.byId.has(id); id = model.parents.get(id)) ancestors.unshift(id);
  for (const id of ancestors) nav.append(el('span', 'muted', '/'), button(title(model.byId.get(id)), () => scopeTo(id)));
}

/** One button per level the scope has, then All. A focused button keeps focus across the redraw. */
function levelControls() {
  const control = $('levels');
  const focused = document.activeElement?.dataset.level;
  control.replaceChildren();
  control.setAttribute('aria-label', scope ? 'Levels below the focused group' : 'Levels from the enterprise');
  const counted = Array.from({ length: Math.max(1, projection.maxDepth) }, (_, i) => [i + 1, String(i + 1)]);
  for (const [count, label] of [...counted, [Infinity, 'All']]) {
    const b = button(label, () => {
      levels = count;
      render(true);
    });
    b.dataset.level = String(count);
    b.setAttribute('aria-label', count === Infinity
      ? 'Show all levels'
      : `Show ${count} level${count === 1 ? '' : 's'}${scope ? ' below this group' : ''}`);
    b.setAttribute('aria-pressed', String(levels === count));
    control.append(b);
  }
  if (focused) control.querySelector(`[data-level="${focused}"]`)?.focus();
}

// ---------------------------------------------------------------------------------------------
// Camera

function applyTransform() {
  $('drawing').style.transform = `translate(${pan.x}px,${pan.y}px) scale(${zoom})`;
  $('zoom').textContent = `${Math.round(zoom * 100)}%`;
}

function fit() {
  if (!layout) return;
  const camera = fitViewport(layout, $('map').getBoundingClientRect());
  if (!camera) return;
  zoom = camera.zoom;
  pan = camera.pan;
  applyTransform();
}

/** Zoom about the map's centre, from 2% up to 800%, or up to the current zoom if Fit went higher. */
function zoomBy(factor) {
  const box = $('map').getBoundingClientRect();
  const next = Math.max(0.02, Math.min(Math.max(8, zoom), zoom * factor));
  pan = {
    x: box.width / 2 - (box.width / 2 - pan.x) * next / zoom,
    y: box.height / 2 - (box.height / 2 - pan.y) * next / zoom,
  };
  zoom = next;
  applyTransform();
}

// ---------------------------------------------------------------------------------------------
// Map

function renderMap(refit) {
  const drawing = $('drawing');
  if (!projection.tree.length) {
    layout = null;
    drawing.replaceChildren();
    return;
  }

  // Packing the whole model takes about half a second, and only the tree, the scope, the levels
  // and the layout mode change it. Search and colour restyle the cards; the packing is reused.
  const key = [modelGeneration, scope, levels, layoutMode].join('|');
  if (key !== layoutKey) {
    layout = layoutCapabilities(window.BcmLayout, projection.tree, layoutMode);
    layoutKey = null;
    const problems = window.BcmLayout.validateBcmLayout(layout);
    if (problems.length) throw new Error('Layout geometry validation failed: ' + problems.map(x => x.message).join('; '));
    layoutKey = key;
  }

  drawing.replaceChildren();
  drawing.style.width = `${layout.width}px`;
  drawing.style.height = `${layout.height}px`;

  // A match keeps its ancestors undimmed, so the path down to it stays readable.
  const lit = new Set(records.filter(matches).map(record => record.recordId));
  if (query) {
    for (const id of [...lit]) {
      for (let parent = model.parents.get(id); parent; parent = model.parents.get(parent)) lit.add(parent);
    }
  }

  // The layout's synthetic root holds the top level together and is never drawn.
  for (const node of layout.nodes) {
    if (!node.synthetic) drawing.append(card(node, lit));
  }
  if (refit) fit();
  else applyTransform();
}

/** One capability card. A leaf of the layout may be a group the level choice has collapsed. */
function card(node, lit) {
  const record = model.byId.get(node.id);
  const isGroup = !!model.children.get(node.id)?.length;
  const hidden = node.isLeaf && isGroup ? projection.hiddenCounts.get(node.id) : 0;

  const classes = ['cap', node.isLeaf ? 'leaf' : 'branch'];
  if (selected === node.id) classes.push('selected');
  if (query && !lit.has(node.id)) classes.push('dim');
  if (query && matches(record)) classes.push('matched');

  const b = button('', () => select(node.id), classes.join(' '));
  b.dataset.id = node.id;
  b.setAttribute('aria-label',
    `${title(record)}, ${maturityLabels[value(record, 'maturity') || 0]}${isGroup ? ', group' : ''}${hidden ? ', ' + hidden + ' capabilities inside' : ''}`);
  b.setAttribute('aria-pressed', String(selected === node.id));
  b.title = `${value(record, 'code') || ''} ${title(record)}\n${isGroup ? 'Double-click to focus this group' : 'Select to inspect'}`;
  Object.assign(b.style, { left: `${node.x}px`, top: `${node.y}px`, width: `${node.width}px`, height: `${node.height}px` });
  setTone(b, toneFor(record));
  b.append(el('span', 'cap-title', title(record)));
  if (node.isLeaf) b.append(el('span', 'cap-meta', String(value(record, 'code') || '')), score(record, hidden));
  b.addEventListener('dblclick', () => {
    if (isGroup) scopeTo(node.id);
  });
  return b;
}

/** A leaf card's corner figure: what a collapsed group holds, the gap, or the maturity. */
function score(record, hidden) {
  if (hidden) return el('span', 'score cap-count', `${hidden} inside`);
  let text;
  if (colour === 'gap') text = gap(record) == null ? '—' : `Δ ${gap(record)}`;
  else text = value(record, 'maturity') == null ? '—' : `${value(record, 'maturity')} / 5`;
  return el('span', 'score', text);
}

// ---------------------------------------------------------------------------------------------
// Assessment and Outline tables

const columns = ['Capability', 'Maturity', 'Target', 'Gap', 'Importance', 'Direction'];

function renderTable() {
  const rows = projection.rows.filter(({ record }) => matches(record));
  // Assessment puts the largest gap first; Outline keeps hierarchy order and indents by depth.
  if (mode === 'assessment') {
    rows.sort((a, b) => (gap(b.record) ?? -99) - (gap(a.record) ?? -99) || title(a.record).localeCompare(title(b.record)));
  }
  const table = el('table'), head = el('thead'), headings = el('tr');
  for (const text of columns) headings.append(el('th', null, text));
  head.append(headings);
  table.append(head);
  const body = el('tbody');
  for (const { record, depth } of rows) body.append(tableRow(record, depth));
  table.append(body);
  $('table').replaceChildren(table);
  if (!rows.length) $('table').append(el('p', 'muted', 'No capabilities match your search.'));
}

function tableRow(record, depth) {
  const row = el('tr', selected === record.recordId ? 'selected' : '');
  row.dataset.id = record.recordId;

  const name = el('td', 'name');
  const b = button(title(record), () => select(record.recordId));
  b.style.border = '0';
  b.style.background = 'transparent';
  b.style.textAlign = 'left';
  if (mode === 'outline') b.style.marginLeft = `${depth * 18}px`;
  name.append(b, el('div', 'eyebrow', String(value(record, 'code') || '')));
  row.append(name);

  const g = gap(record);
  const cells = [
    ['maturity', maturityText(value(record, 'maturity'), '—')],
    ['target', value(record, 'target') ?? '—'],
    ['gap', g == null ? '—' : g > 0 ? `+${g}` : String(g)],
    ['importance', value(record, 'importance') || '—'],
    ['investment', value(record, 'investment') || '—'],
  ];
  for (const [key, text] of cells) row.append(el('td', key === 'gap' && g > 0 ? 'gap numeric' : 'numeric', String(text)));
  row.addEventListener('click', () => select(record.recordId));
  return row;
}

// ---------------------------------------------------------------------------------------------
// Selection and the inspector

/** Select without redrawing the map: mark the cards and rows, then refill the inspector. */
function select(id) {
  selected = id;
  document.querySelectorAll('[data-id]').forEach(node => {
    node.classList.toggle('selected', node.dataset.id === id);
    if (node.classList.contains('cap')) node.setAttribute('aria-pressed', String(node.dataset.id === id));
  });
  inspector();
}

function inspector() {
  const panel = $('inspector');
  panel.replaceChildren();
  const record = model.byId.get(selected);
  if (!record) {
    panel.append(...introduction());
    return;
  }
  panel.append(
    ...summary(record),
    ...assessment(record),
    actions(record),
    ...childList(record),
    ...applicationSupport(record),
    ...changePortfolio(record));
}

/** What the inspector says while nothing is selected. */
function introduction() {
  return [
    el('div', 'eyebrow', 'BUSINESS CAPABILITY MODEL'),
    el('h2', null, 'The enterprise, at a glance.'),
    el('p', null, 'Explore what the organisation does, how well it does it, and where to invest next.'),
    el('h3', null, 'Read the map'),
    el('p', null, 'Select a capability to inspect it. Double-click a group to focus. Colour reveals maturity, strategic importance or investment direction.'),
    el('h3', null, 'A model you can evolve'),
    el('p', null, 'Create capabilities, organise the hierarchy and record assessments. Link applications and initiatives through the record page.'),
    button('+ Top-level capability', () => edit(null, null), 'primary'),
  ];
}

function summary(record) {
  const badges = el('div');
  for (const key of ['lifecycle', 'importance', 'investment']) {
    if (value(record, key)) badges.append(el('span', 'badge', value(record, key)));
  }
  return [
    el('div', 'eyebrow', String(value(record, 'code') || 'CAPABILITY')),
    el('h2', null, title(record)),
    badges,
    el('p', null, value(record, 'description') || 'No definition yet. Describe the business outcome this capability enables.'),
  ];
}

function assessment(record) {
  const facts = el('div', 'facts');
  const rows = [
    ['Current', maturityText(value(record, 'maturity'), 'Unassessed')],
    ['Target', maturityText(value(record, 'target'), 'Unassessed')],
    ['Owner', value(record, 'owner') || 'Unassigned'],
    ['Reviewed', value(record, 'reviewed') || 'Not yet'],
  ];
  for (const [label, text] of rows) {
    const fact = el('div');
    fact.append(el('span', null, label), el('strong', null, text));
    facts.append(fact);
  }

  // Five pips, filled up to the current maturity, in the colour the map is using.
  const scale = el('div', 'scale');
  setTone(scale, toneFor(record));
  for (let level = 1; level <= 5; level++) scale.append(el('i', level <= Number(value(record, 'maturity')) ? 'filled' : ''));

  const nodes = [el('h3', null, 'Assessment'), facts, scale];
  const g = gap(record);
  if (g > 0) nodes.push(el('p', 'gap', `${g} maturity level${g === 1 ? '' : 's'} below target.`));
  if (value(record, 'evidence')) nodes.push(el('p', null, value(record, 'evidence')));
  return nodes;
}

function actions(record) {
  const bar = el('div', 'inspector-actions');
  bar.append(
    button('Edit', () => edit(record)),
    button('+ Child', () => edit(null, record.recordId)),
    button('Open record', () => nendo.ui.openRecord(CAPABILITY, record.recordId)));
  if (model.children.get(record.recordId)?.length) bar.append(button('Focus group', () => scopeTo(record.recordId)));
  return bar;
}

function childList(record) {
  const children = model.children.get(record.recordId) || [];
  if (!children.length) return [];
  return [
    el('h3', null, `${children.length} child capabilities`),
    ...children.map(child => button(title(child), () => select(child.recordId), 'relation')),
  ];
}

/** The applications that support this capability, through its support records. */
function applicationSupport(record) {
  const links = supports.filter(link => link.values['support.capability'] === record.recordId);
  const nodes = [el('h3', null, 'Application support')];
  if (!links.length) nodes.push(el('p', null, 'No applications linked. Add support links in the record page.'));
  for (const link of links) {
    const application = applications.find(candidate => candidate.recordId === link.values['support.application']);
    const b = button(application?.values['app.name'] || 'Missing application',
      () => nendo.ui.openRecord('bcm.support', link.recordId), 'relation');
    b.append(el('small', null, `${link.values['support.fit'] || 'Unassessed'} fit · ${link.values['support.role'] || 'Support'}`));
    nodes.push(b);
  }
  return nodes;
}

/** The initiatives whose primary capability this is. */
function changePortfolio(record) {
  const projects = initiatives.filter(initiative => initiative.values['initiative.capability'] === record.recordId);
  const nodes = [el('h3', null, 'Change portfolio')];
  if (!projects.length) nodes.push(el('p', null, 'No initiatives linked.'));
  for (const project of projects) {
    const b = button(project.values['initiative.name'], () => nendo.ui.openRecord('bcm.initiative', project.recordId), 'relation');
    b.append(el('small', null, `${project.values['initiative.stage'] || 'Proposed'} · ${project.values['initiative.end'] || 'No target date'}`));
    nodes.push(b);
  }
  return nodes;
}

// ---------------------------------------------------------------------------------------------
// Rendering and reading

/** Redraw everything from state; refit also fits the camera to the map. */
function render(refit = false) {
  projection = projectHierarchy(model, scope, levels);
  levelControls();
  stats();
  breadcrumbs();
  legend();
  const empty = records.length === 0;
  $('empty').hidden = !empty || undeclared;
  $('map').hidden = mode !== 'map' || empty;
  $('table').hidden = mode === 'map' || empty;
  document.querySelector('.map-tools').hidden = mode !== 'map';
  if (mode === 'map') renderMap(refit);
  else renderTable();
  inspector();
  say(statusLine());
  $('notice').hidden = !undeclared;
  $('notice').textContent = undeclared
    ? 'This file does not keep capabilities as a tree, so there is no map to draw. Declare Parent capability as the hierarchy (with Display order as its order) in Studio or through an agent.'
    : '';
}

/** The footer separates what is shown from what is in scope and in the model. */
function statusLine() {
  const inScope = recordsInScope();
  if (!query) return `${projection.rows.length} shown · ${inScope.length} in scope · ${records.length} total`;
  const found = inScope.filter(matches).length;
  const shown = projection.rows.filter(({ record }) => matches(record)).length;
  return `${found} matches · ${shown} shown${found > shown ? ' · Choose All levels to reveal deeper matches' : ''}`;
}

async function refresh() {
  const request = ++loading;
  try {
    const loaded = await Promise.all([
      nendo.records.treeAll({ entityId: CAPABILITY, depth: 32 }, { max: 10000 }),
      nendo.records.queryAll({ entityId: 'bcm.application' }, { max: 5000 }),
      nendo.records.queryAll({ entityId: 'bcm.support' }, { max: 5000 }),
      nendo.records.queryAll({ entityId: 'bcm.initiative' }, { max: 5000 }),
    ]);
    if (request !== loading) return;
    // The first map is fitted. After that a change keeps the camera where the person put it,
    // unless the focused group has gone.
    const first = layout === null;
    let nodes;
    [nodes, applications, supports, initiatives] = loaded;
    modelGeneration++;
    model = hierarchy(nodes);
    records = model.records;
    undeclared = false;
    if (!model.byId.has(selected)) selected = null;
    const lostScope = scope !== null && !model.byId.has(scope);
    if (lostScope) scope = null;
    render(first || lostScope);
  } catch (error) {
    // The map is the tree the file keeps. A file that does not declare it has no map to draw.
    if (error.code === 'hierarchy-not-declared') {
      undeclared = true;
      records = [];
      model = hierarchy([]);
      render(false);
      return;
    }
    say(`Could not load model: ${error.message}`);
    $('notice').hidden = false;
    $('notice').textContent = 'The model could not be refreshed. Your current view is retained. ' + error.message;
  }
}

// ---------------------------------------------------------------------------------------------
// Editor

const maturityChoices = maturityLabels.slice(1).map((label, i) => [i + 1, `${i + 1} · ${label}`]);
const textFields = ['name', 'code', 'owner', 'description', 'evidence', 'reviewed', 'parent', 'importance', 'investment', 'lifecycle'];

/** Fill one select: an optional empty choice, then [value, label] pairs or plain strings. */
function fillSelect(name, options, current, empty = 'Not assessed') {
  const field = $('edit-form').elements[name];
  field.replaceChildren();
  if (empty !== null) field.append(new Option(empty, ''));
  for (const option of options) {
    const [optionValue, label] = Array.isArray(option) ? option : [option, option];
    field.append(new Option(label, String(optionValue)));
  }
  field.value = current == null ? '' : String(current);
}

/** Open the editor on a capability, or on a new one under parent (null: at the top level). */
function edit(record, parent) {
  editing = record;
  dirty = false;
  const form = $('edit-form');
  form.reset();
  $('form-error').textContent = '';
  $('edit-title').textContent = record ? 'Edit capability' : 'New capability';
  for (const key of ['name', 'code', 'owner', 'description', 'evidence', 'reviewed']) form.elements[key].value = value(record, key) || '';
  fillSelect('maturity', maturityChoices, value(record, 'maturity'));
  fillSelect('target', maturityChoices, value(record, 'target'));
  fillSelect('importance', importanceOptions, value(record, 'importance'));
  fillSelect('investment', investmentOptions, value(record, 'investment'));
  fillSelect('lifecycle', lifecycleOptions, value(record, 'lifecycle') || 'Proposed', null);
  // Only places a capability can go are offered: not itself, and not anything under it. The
  // Engine refuses the rest anyway; this keeps the list to choices that can succeed.
  const beneath = new Set(record ? [record.recordId, ...model.descendants(record.recordId).map(item => item.recordId)] : []);
  const parents = records
    .filter(candidate => !beneath.has(candidate.recordId))
    .sort((a, b) => title(a).localeCompare(title(b)))
    .map(candidate => [candidate.recordId, `${value(candidate, 'code') || ''} ${title(candidate)}`]);
  fillSelect('parent', parents, record ? value(record, 'parent') : parent, 'Enterprise / top level');
  $('editor').showModal();
  form.elements.name.focus();
}

function closeEditor() {
  if (dirty && !confirm('Discard your unsaved changes?')) return;
  $('editor').close();
}

async function save(event) {
  event.preventDefault();
  const form = event.target, values = {};
  for (const key of textFields) values[FIELD[key]] = form.elements[key].value.trim() || null;
  for (const key of ['maturity', 'target']) values[FIELD[key]] = form.elements[key].value ? Number(form.elements[key].value) : null;
  if (!values[FIELD.name]) return;
  $('save').disabled = true;
  try {
    // The parent's version goes with the write, so a parent changed meanwhile is refused. An
    // update carries the version the editor opened at, so a stale capability is refused too.
    const parent = values[FIELD.parent] ? await nendo.records.get(CAPABILITY, values[FIELD.parent]) : null;
    const options = parent ? { targetVersions: { [FIELD.parent]: parent.version } } : {};
    const saved = editing
      ? await nendo.records.update(editing, values, options)
      : await nendo.records.create(CAPABILITY, values, options);
    selected = saved.recordId;
    dirty = false;
    $('editor').close();
    await refresh();
    say('Capability saved.');
  } catch (error) {
    // The form keeps the draft, so nothing typed is lost.
    $('form-error').textContent = `Your changes have not been saved. ${error.message} Your draft is still here.`;
  } finally {
    $('save').disabled = false;
  }
}

$('edit-form').addEventListener('input', () => dirty = true);
$('editor').addEventListener('cancel', event => {
  event.preventDefault();
  closeEditor();
});
$('close-editor').onclick = closeEditor;
$('cancel-editor').onclick = closeEditor;
$('edit-form').onsubmit = save;

// ---------------------------------------------------------------------------------------------
// Toolbar

document.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => setMode(b.dataset.mode));
$('search').oninput = event => {
  query = event.target.value.toLowerCase().trim();
  render(false);
};
$('colour').onchange = event => {
  colour = event.target.value;
  render(false);
};
$('layout').onchange = event => {
  layoutMode = event.target.value;
  render(true);
};
$('add').onclick = () => edit(null, scope);
$('empty-add').onclick = () => edit(null, null);
$('fit').onclick = fit;
$('zoom-in').onclick = () => zoomBy(1.2);
$('zoom-out').onclick = () => zoomBy(1 / 1.2);

// ---------------------------------------------------------------------------------------------
// Panning
//
// Dragging the background pans. So does dragging anywhere, cards included, with Ctrl (or Cmd)
// held, whether it is pressed before or after the button, and dragging anywhere with the Pan
// tool on. A press becomes a pan after four pixels of movement, and a pan never selects the
// card it started on. The release position counts too: some Windows input delivers the
// displacement only with pointerup.

let drag = null;               // the press in progress: where it started, and whether it pans
let suppressPanClick = false;  // swallow the click that ends a pan
let panMode = false;           // the Pan tool
const map = $('map');

function endPan(cancelled = false) {
  if (drag) suppressPanClick = !cancelled && drag.moved;
  drag = null;
  map.classList.remove('panning');
}

function activatePan(event) {
  if (!drag || drag.active) return;
  drag.active = true;
  map.setPointerCapture(event.pointerId);
}

function movePan(event) {
  if (!drag || drag.pointerId !== event.pointerId) return;
  // Ctrl pressed after the button turns a press on a card into a pan.
  if (!drag.active && (panMode || event.ctrlKey || event.metaKey)) activatePan(event);
  if (!drag.active) return;
  const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  drag.moved = true;
  map.classList.add('panning');
  pan = { x: drag.px + dx, y: drag.py + dy };
  applyTransform();
}

$('pan-tool').onclick = () => {
  panMode = !panMode;
  endPan(true);
  map.classList.toggle('pan-ready', panMode);
  $('pan-tool').setAttribute('aria-pressed', String(panMode));
};

map.addEventListener('pointerdown', event => {
  suppressPanClick = false;
  if (event.button !== 0) return;
  drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, px: pan.x, py: pan.y, moved: false, active: false };
  // A press on a card stays a candidate: it pans only if Ctrl arrives (see movePan).
  if (panMode || event.ctrlKey || event.metaKey || !event.target.closest('button')) {
    activatePan(event);
    event.preventDefault();
  }
});
map.addEventListener('pointermove', event => {
  // The button was released outside the frame.
  if (drag && !(event.buttons & 1)) {
    endPan(true);
    return;
  }
  movePan(event);
});
map.addEventListener('pointerup', event => {
  if (drag?.pointerId !== event.pointerId) return;
  if (drag.active) movePan(event);
  endPan();
});
map.addEventListener('pointercancel', () => endPan(true));
map.addEventListener('lostpointercapture', () => {
  if (drag) endPan(true);
});
window.addEventListener('blur', () => endPan(true));
map.addEventListener('dragstart', event => event.preventDefault());
// Capture phase, so a pan's closing click and every click in Pan mode never reach a card.
map.addEventListener('click', event => {
  if (suppressPanClick || panMode) {
    suppressPanClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);
map.addEventListener('dblclick', event => {
  if (panMode || event.ctrlKey || event.metaKey) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);

// ---------------------------------------------------------------------------------------------
// Wheel and keyboard: Ctrl + wheel zooms; on the focused map, + and - zoom, 0 fits, arrows pan.

const arrowSteps = { ArrowLeft: [30, 0], ArrowRight: [-30, 0], ArrowUp: [0, 30], ArrowDown: [0, -30] };

map.addEventListener('wheel', event => {
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault();
    zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1);
  }
}, { passive: false });

map.addEventListener('keydown', event => {
  if (event.target !== map) return;
  if (event.key === '+' || event.key === '=') zoomBy(1.2);
  else if (event.key === '-') zoomBy(1 / 1.2);
  else if (event.key === '0') fit();
  else if (Object.hasOwn(arrowSteps, event.key)) {
    const [dx, dy] = arrowSteps[event.key];
    pan.x += dx;
    pan.y += dy;
    applyTransform();
  } else return;
  event.preventDefault();
});

// Resizing refits once the size settles; the packing itself does not change.
let resizeTimer;
new ResizeObserver(() => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (mode === 'map' && records.length) fit();
  }, 120);
}).observe($('workspace'));

// ---------------------------------------------------------------------------------------------
// Start

try {
  const context = await nendo.ready;
  if (context.configuration?.mode) setMode(context.configuration.mode);
  await refresh();
  nendo.on('changes', () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 150);
  });
  nendo.on('context', refresh);
} catch (error) {
  say(`Cannot start Capability Atlas: ${error.message}`);
}
