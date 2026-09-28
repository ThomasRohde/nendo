// Capability Atlas: a business capability map over one hierarchical record type (ADR-0013).
//
// Everything arrives through window.nendo. Which record type the map draws, and which of its
// fields plays which part, come from the view that shows the Atlas and from the file's schema
// (bindAtlas in model.js), so nothing here names a record type or a field. The capabilities are
// read as the tree the file declares (nendo.records.treeAll, ADR-0019), so the Engine keeps it
// free of loops and orders each level; the record types that refer to it are read to show what
// supports and changes the selected capability. The map is packed by the owner's BCM reference
// layout (layout.js, loaded as window.BcmLayout) with the lab preset in layout-profile.js;
// Assessment and Outline are tables of the same rows. The only writes are capability creates and
// updates, sent with the parent's version so a stale parent is refused, and a parent that would
// close a loop is refused by the Engine in words the editor shows. Nothing leaves Nendo.
import { bindAtlas, hierarchy, projectHierarchy, maturityLabels, relatedName, relatedRow, dropTarget, stepTarget } from './model.js';
import { mapSvg, printPalette, paletteTokens } from './export.js';
import { layoutCapabilities, fitViewport } from './layout-profile.js';

// ---------------------------------------------------------------------------------------------
// State

// What the view binds (model.js), the capabilities as last read, the related records by record
// type, and the hierarchy built from the capabilities.
let binding = bindAtlas(null, null);
let records = [], relatedRecords = new Map();
let model = hierarchy([], binding.title);
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

// Whether Nendo draws the Atlas's controls in its own toolbar, menus, Ctrl K and keys (W-090).
// On a host that does not offer it, the Atlas draws its own toolbar, as it always has.
let nativeChrome = false;
// Export's "Light colours for print", which the Atlas's own menu keeps in a checkbox.
let lightPrint = false;

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

// What a move or a rename says -- done, or refused and why -- is held in the footer until the
// person acts again or six seconds pass. Without the hold, a redraw that a change elsewhere
// set off moments earlier wrote the counts over it, and a refusal went unread.
let held = null;

function tell(message) {
  held = { text: message, until: Date.now() + 6000 };
  say(message);
}

/** The footer between messages: a held one while it lasts, else the counts. */
function footer() {
  return held !== null && Date.now() < held.until ? held.text : statusLine();
}

// Any press or key the person makes lets a held message go.
document.addEventListener('pointerdown', () => { held = null; }, true);
document.addEventListener('keydown', () => { held = null; }, true);

/** "3 · Defined", or the fallback when there is no assessment. */
function maturityText(level, fallback) {
  if (level == null) return fallback;
  return level > 0 && maturityLabels[level] ? `${level} · ${maturityLabels[level]}` : String(level);
}

// ---------------------------------------------------------------------------------------------
// Colour. Cards use the Workbench's tone tokens (--nendo-tone-*), set per card as --tone.

// Maturity has its own scale of tones; a choice part takes each choice's tone from the schema.
const maturityTones = ['grey', 'red', 'orange', 'amber', 'teal', 'green']; // by level 0-5

/** The parts each colour mode needs the view to bind. Neutral needs none. */
const colourNeeds = { maturity: ['maturity'], gap: ['maturity', 'target'], importance: ['importance'], investment: ['investment'], none: [] };

function toneFor(record) {
  switch (colour) {
    case 'maturity':
      return maturityTones[Number(binding.value(record, 'maturity'))] || 'grey';
    case 'gap': {
      const g = binding.gap(record);
      if (g == null) return 'grey';
      if (g <= 0) return 'teal';
      return g === 1 ? 'amber' : g === 2 ? 'orange' : 'red';
    }
    case 'importance':
    case 'investment':
      return binding.tone(colour, binding.value(record, colour)) || 'grey';
    default:
      return 'grey';
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
    case 'investment':
      return binding.choices[colour].map(choice => [choice.displayName, choice.tone || 'grey']);
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
  const text = [binding.title(record), binding.value(record, 'code'), binding.value(record, 'owner'), binding.value(record, 'description')].join(' ');
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
  $('gaps').textContent = inScope.filter(record => binding.gap(record) > 0).length;
  $('unassessed').textContent = inScope.filter(record => binding.value(record, 'maturity') == null).length;
}

function breadcrumbs() {
  const nav = $('breadcrumbs');
  nav.replaceChildren(button('Enterprise', () => scopeTo(null)));
  const ancestors = [];
  for (let id = scope; id && model.byId.has(id); id = model.parents.get(id)) ancestors.unshift(id);
  for (const id of ancestors) nav.append(el('span', 'muted', '/'), button(binding.title(model.byId.get(id)), () => scopeTo(id)));
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
  // Nendo's toolbar shows the zoom too; a pan leaves it as it is and declares nothing.
  if (nativeChrome && declaredZoom !== $('zoom').textContent) declareToolbar();
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
  if (renaming) drawing.append(renaming.input);
  if (refit) fit();
  else applyTransform();
}

/** One capability card. A leaf of the layout may be a group the level choice has collapsed. */
function card(node, lit) {
  const record = model.byId.get(node.id);
  const isGroup = !!model.children.get(node.id)?.length;
  const hidden = collapsedCount(node);

  const classes = ['cap', node.isLeaf ? 'leaf' : 'branch'];
  if (selected === node.id) classes.push('selected');
  if (query && !lit.has(node.id)) classes.push('dim');
  if (query && matches(record)) classes.push('matched');

  const b = button('', () => select(node.id), classes.join(' '));
  b.dataset.id = node.id;
  const maturity = binding.has('maturity') ? `, ${maturityText(binding.value(record, 'maturity'), 'Unassessed').replace(/^\d+ · /, '')}` : '';
  b.setAttribute('aria-label',
    `${binding.title(record)}${maturity}${isGroup ? ', group' : ''}${hidden ? ', ' + hidden + ' capabilities inside' : ''}`);
  b.setAttribute('aria-pressed', String(selected === node.id));
  b.title = `${binding.value(record, 'code') || ''} ${binding.title(record)}\n${isGroup ? 'Double-click to focus this group' : 'Select to inspect'}` +
    (canMove() ? '\nDrag to move · Alt+Shift+arrows move the selection' : '') + (canRename() ? ' · F2 renames' : '');
  Object.assign(b.style, { left: `${node.x}px`, top: `${node.y}px`, width: `${node.width}px`, height: `${node.height}px` });
  setTone(b, toneFor(record));
  b.append(el('span', 'cap-title', binding.title(record)));
  if (node.isLeaf) b.append(el('span', 'cap-meta', String(binding.value(record, 'code') || '')), score(record, hidden));
  b.addEventListener('dblclick', () => {
    if (isGroup) scopeTo(node.id);
  });
  return b;
}

/** How many capabilities a card holds out of sight: a group the level choice has collapsed. */
function collapsedCount(node) {
  return node.isLeaf && model.children.get(node.id)?.length ? projection.hiddenCounts.get(node.id) : 0;
}

/** A leaf card's corner figure: what a collapsed group holds, the gap, or the maturity. */
function scoreText(record, hidden) {
  if (hidden) return `${hidden} inside`;
  if (colour === 'gap') return binding.gap(record) == null ? '—' : `Δ ${binding.gap(record)}`;
  if (binding.has('maturity')) return binding.value(record, 'maturity') == null ? '—' : `${binding.value(record, 'maturity')} / ${binding.scale.max}`;
  return '';
}

function score(record, hidden) {
  return el('span', hidden ? 'score cap-count' : 'score', scoreText(record, hidden));
}

// ---------------------------------------------------------------------------------------------
// Export (W-078)
//
// The map as a file: SVG to edit, PNG for a slide. export.js builds both from the packed layout,
// so a file holds every card of the scope at the chosen levels in the chosen colour, whatever
// the camera shows. Search and selection are the person's working state and stay out of it.

let measuring = null;

function canvasContext() {
  measuring ??= document.createElement('canvas').getContext('2d');
  return measuring;
}

/** A width in pixels in one of the fonts the export sets, measured as the browser draws it. */
function measure(text, font) {
  const context = canvasContext();
  context.font = font;
  return context.measureText(text).width;
}

/** The theme in effect, from the tokens api.js sets on the page, each as the browser resolves it. */
function themePalette() {
  const style = getComputedStyle(document.documentElement);
  const context = canvasContext();
  return Object.fromEntries(paletteTokens.map(name => {
    const value = style.getPropertyValue(`--nendo-${name}`).trim();
    if (!value) return [name, printPalette[name]];
    context.fillStyle = printPalette[name];
    context.fillStyle = value;
    return [name, context.fillStyle];
  }));
}

function exportDocument() {
  const cards = layout.nodes.filter(node => !node.synthetic).map(node => {
    const record = model.byId.get(node.id);
    return {
      x: node.x, y: node.y, width: node.width, height: node.height, isLeaf: node.isLeaf,
      title: binding.title(record),
      meta: node.isLeaf ? String(binding.value(record, 'code') || '') : '',
      score: node.isLeaf ? scoreText(record, collapsedCount(node)) : '',
      tone: toneFor(record),
    };
  });
  const place = scope && model.byId.has(scope) ? binding.title(model.byId.get(scope)) : 'Enterprise';
  const depth = Number.isFinite(levels) ? `${levels} level${levels === 1 ? '' : 's'}` : 'all levels';
  return mapSvg({
    cards,
    title: nendo.context?.title || 'Capability map',
    subtitle: `${place} · ${depth} · Colour: ${$('colour').selectedOptions[0]?.textContent ?? ''} · ${cards.length} capabilities`,
    note: binding.banner ? [binding.banner.title, binding.banner.note].filter(Boolean).join(' · ') : null,
    legend: legendEntries(),
    palette: (nativeChrome ? lightPrint : $('export-light').checked) ? printPalette : themePalette(),
    measure,
  });
}

/** capability-map-enterprise-2026-09-28: the view's title and the scope, dated. */
function exportName() {
  const now = new Date();
  const day = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map(n => String(n).padStart(2, '0')).join('-');
  const place = scope && model.byId.has(scope) ? binding.title(model.byId.get(scope)) : 'enterprise';
  const slug = `${nendo.context?.title || 'capability map'} ${place}`.toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${slug || 'capability-map'}-${day}`;
}

/** Hand a file to the browser's own download handling, which the view's frame allows. */
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function exportMap(format) {
  $('export').open = false;
  if (!layout) {
    say('There is no map to export.');
    return;
  }
  const file = exportDocument();
  const svg = new Blob([file.svg], { type: 'image/svg+xml' });
  if (format === 'svg') {
    download(svg, `${exportName()}.svg`);
  } else {
    // Twice the size for a sharp slide, within what one canvas can hold.
    const scale = Math.min(2, 8192 / Math.max(file.width, file.height), Math.sqrt(40e6 / (file.width * file.height)));
    const url = URL.createObjectURL(svg);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(file.width * scale);
      canvas.height = Math.round(file.height * scale);
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      const png = await new Promise((resolve, reject) =>
        canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('the image could not be drawn'))), 'image/png'));
      download(png, `${exportName()}.png`);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  say(`Exported ${file.cards} capabilities as ${format.toUpperCase()}.`);
}

// ---------------------------------------------------------------------------------------------
// Assessment and Outline tables

/** The columns after the name, each with the parts it needs the view to bind. */
const columns = [
  ['Maturity', ['maturity']], ['Target', ['target']], ['Gap', ['maturity', 'target']],
  ['Importance', ['importance']], ['Direction', ['investment']],
];
const shownColumns = () => columns.filter(([, needs]) => needs.every(binding.has));

function renderTable() {
  const rows = projection.rows.filter(({ record }) => matches(record));
  // Assessment puts the largest gap first; Outline keeps hierarchy order and indents by depth.
  if (mode === 'assessment') {
    rows.sort((a, b) => (binding.gap(b.record) ?? -99) - (binding.gap(a.record) ?? -99) || binding.title(a.record).localeCompare(binding.title(b.record)));
  }
  const table = el('table'), head = el('thead'), headings = el('tr');
  for (const text of ['Capability', ...shownColumns().map(([heading]) => heading)]) headings.append(el('th', null, text));
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
  const b = button(binding.title(record), () => select(record.recordId));
  b.style.border = '0';
  b.style.background = 'transparent';
  b.style.textAlign = 'left';
  if (mode === 'outline') b.style.marginLeft = `${depth * 18}px`;
  name.append(b, el('div', 'eyebrow', String(binding.value(record, 'code') || '')));
  row.append(name);

  const g = binding.gap(record);
  const cells = {
    Maturity: maturityText(binding.value(record, 'maturity'), '—'),
    Target: binding.value(record, 'target') ?? '—',
    Gap: g == null ? '—' : g > 0 ? `+${g}` : String(g),
    Importance: binding.choiceName('importance', binding.value(record, 'importance')) || '—',
    Direction: binding.choiceName('investment', binding.value(record, 'investment')) || '—',
  };
  for (const [heading] of shownColumns()) row.append(el('td', heading === 'Gap' && g > 0 ? 'gap numeric' : 'numeric', String(cells[heading])));
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
    ...relatedSections(record));
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
    // With Nendo's toolbar, its own Add adds one here (W-090).
    ...(nativeChrome ? [] : [button('+ Top-level capability', () => edit(null, null), 'primary')]),
  ];
}

function summary(record) {
  const badges = el('div');
  for (const key of ['lifecycle', 'importance', 'investment']) {
    if (binding.value(record, key)) badges.append(el('span', 'badge', binding.choiceName(key, binding.value(record, key))));
  }
  const nodes = [
    el('div', 'eyebrow', String(binding.value(record, 'code') || 'CAPABILITY')),
    el('h2', null, binding.title(record)),
    badges,
  ];
  if (binding.has('description')) {
    nodes.push(el('p', null, binding.value(record, 'description') || 'No definition yet. Describe the business outcome this capability enables.'));
  }
  return nodes;
}

function assessment(record) {
  const facts = el('div', 'facts');
  const rows = [
    ['maturity', 'Current', maturityText(binding.value(record, 'maturity'), 'Unassessed')],
    ['target', 'Target', maturityText(binding.value(record, 'target'), 'Unassessed')],
    ['owner', 'Owner', binding.value(record, 'owner') || 'Unassigned'],
    ['reviewed', 'Reviewed', binding.value(record, 'reviewed') || 'Not yet'],
  ].filter(([part]) => binding.has(part));
  for (const [, label, text] of rows) {
    const fact = el('div');
    fact.append(el('span', null, label), el('strong', null, String(text)));
    facts.append(fact);
  }
  const nodes = rows.length ? [facts] : [];

  // One pip a level, filled up to the current maturity, in the colour the map is using.
  if (binding.has('maturity')) {
    const scale = el('div', 'scale');
    setTone(scale, toneFor(record));
    for (let level = binding.scale.min; level <= binding.scale.max; level++) {
      scale.append(el('i', level <= Number(binding.value(record, 'maturity')) ? 'filled' : ''));
    }
    nodes.push(scale);
  }
  const g = binding.gap(record);
  if (g > 0) nodes.push(el('p', 'gap', `${g} maturity level${g === 1 ? '' : 's'} below target.`));
  if (binding.value(record, 'evidence')) nodes.push(el('p', null, binding.value(record, 'evidence')));
  return nodes.length ? [el('h3', null, 'Assessment'), ...nodes] : [];
}

function actions(record) {
  const bar = el('div', 'inspector-actions');
  bar.append(button('Edit', () => edit(record)));
  // With Nendo's toolbar, its Add adds under the selected capability (W-090).
  if (binding.parentFieldId && !nativeChrome) bar.append(button('+ Child', () => edit(null, record.recordId)));
  bar.append(button('Open record', () => nendo.ui.openRecord(binding.entityId, record.recordId)));
  if (model.children.get(record.recordId)?.length) bar.append(button('Focus group', () => scopeTo(record.recordId)));
  return bar;
}

function childList(record) {
  const children = model.children.get(record.recordId) || [];
  if (!children.length) return [];
  return [
    el('h3', null, `${children.length} child capabilities`),
    ...children.map(child => button(binding.title(child), () => select(child.recordId), 'relation')),
  ];
}

/**
 * The record types that refer to this one, as the schema shows them (model.js): what links to it,
 * such as the applications that support it, and what points at it, such as the initiatives that
 * change it. Each row opens its own record.
 */
function relatedSections(record) {
  const nodes = [];
  for (const entry of binding.related) {
    const rows = (relatedRecords.get(entry.entityId) ?? []).filter(item => item.values?.[entry.viaFieldId] === record.recordId);
    nodes.push(el('h3', null, entry.title));
    if (!rows.length) nodes.push(el('p', null, entry.empty));
    for (const item of rows) {
      const b = button(relatedName(entry, item), () => nendo.ui.openRecord(entry.entityId, item.recordId), 'relation');
      const line = relatedRow(entry, item);
      if (line) b.append(el('small', null, line));
      nodes.push(b);
    }
  }
  return nodes;
}

// ---------------------------------------------------------------------------------------------
// Rendering and reading

/** Redraw everything from state; refit also fits the camera to the map. */
function render(refit = false) {
  projection = projectHierarchy(model, scope, levels);
  applyBinding();
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
  say(footer());
  const notices = [...(undeclared ? [undeclaredNotice()] : []), ...binding.problems];
  $('notice').hidden = notices.length === 0;
  $('notice').textContent = notices.join(' ');
  declareToolbar();
}

/** What to declare when the record type keeps no tree: its reference to itself, if it has one. */
function undeclaredNotice() {
  const remedy = binding.selfReferences.length === 1
    ? `Declare ${binding.selfReferences[0]} as the hierarchy of ${binding.typeName}`
    : `Give ${binding.typeName} a reference to itself for each capability's parent, and declare it as the hierarchy`;
  return `This file does not keep capabilities as a tree, so there is no map to draw. ${remedy} in Studio or through an agent.`;
}

/**
 * Show only what the view binds: the colour modes, the figures, the banner and the editor's
 * inputs. A colour mode whose parts are missing gives way to the first one the view can show.
 */
function applyBinding() {
  const available = mode => colourNeeds[mode].every(binding.has);
  for (const option of $('colour').options) {
    option.hidden = !available(option.value);
    option.disabled = !available(option.value);
  }
  if (!available(colour)) {
    colour = Object.keys(colourNeeds).find(available);
    $('colour').value = colour;
  }
  document.querySelectorAll('[data-needs]').forEach(node => {
    node.hidden = !node.dataset.needs.split(' ').every(part => part === 'parent' ? binding.parentFieldId !== null : binding.has(part));
  });
  $('banner').hidden = binding.banner === null;
  $('banner-title').textContent = binding.banner?.title ?? '';
  $('banner-note').textContent = binding.banner?.note ?? '';
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
    // The view's context names the record type and what it binds; the schema says what each
    // field holds and which record types refer to it. Either can change while the Atlas runs.
    const schema = await nendo.schema.describe();
    if (request !== loading) return;
    binding = bindAtlas(nendo.context, schema);
    const relatedTypes = [...new Set(binding.related.map(entry => entry.entityId))];
    const [nodes, ...lists] = await Promise.all([
      nendo.records.treeAll({ entityId: binding.entityId, depth: 32 }, { max: 10000 }),
      ...relatedTypes.map(entityId => nendo.records.queryAll({ entityId }, { max: 5000 })),
    ]);
    if (request !== loading) return;
    // The first map is fitted. After that a change keeps the camera where the person put it,
    // unless the focused group has gone.
    const first = layout === null;
    relatedRecords = new Map(relatedTypes.map((entityId, index) => [entityId, lists[index]]));
    modelGeneration++;
    model = hierarchy(nodes, binding.title);
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
      model = hierarchy([], binding.title);
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

/** The levels the maturity field's scale allows, as [3, '3 · Defined']. */
const maturityChoices = () => Array.from({ length: binding.scale.max - binding.scale.min + 1 },
  (_, i) => binding.scale.min + i).map(level => [level, maturityText(level, '')]);
/** The editor's inputs by part. The name is the view's label field and the parent the tree's. */
const textParts = ['code', 'owner', 'description', 'evidence', 'reviewed'];
const choiceParts = ['importance', 'investment', 'lifecycle'];
const choiceOptions = part => (binding.choices[part] ?? []).map(choice => [choice.id, choice.displayName]);

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
  form.elements.name.value = (binding.labelFieldId !== null && record?.values?.[binding.labelFieldId]) || '';
  for (const part of textParts) form.elements[part].value = binding.value(record, part) || '';
  fillSelect('maturity', maturityChoices(), binding.value(record, 'maturity'));
  fillSelect('target', maturityChoices(), binding.value(record, 'target'));
  fillSelect('importance', choiceOptions('importance'), binding.value(record, 'importance'));
  fillSelect('investment', choiceOptions('investment'), binding.value(record, 'investment'));
  fillSelect('lifecycle', choiceOptions('lifecycle'), binding.value(record, 'lifecycle') ?? binding.choices.lifecycle?.[0]?.id ?? null, null);
  // Only places a capability can go are offered: not itself, and not anything under it. The
  // Engine refuses the rest anyway; this keeps the list to choices that can succeed.
  const beneath = new Set(record ? [record.recordId, ...model.descendants(record.recordId).map(item => item.recordId)] : []);
  const parents = records
    .filter(candidate => !beneath.has(candidate.recordId))
    .sort((a, b) => binding.title(a).localeCompare(binding.title(b)))
    .map(candidate => [candidate.recordId, `${binding.value(candidate, 'code') || ''} ${binding.title(candidate)}`]);
  fillSelect('parent', parents, record ? model.parents.get(record.recordId) ?? null : parent, 'Enterprise / top level');
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
  const name = form.elements.name.value.trim();
  if (!name || binding.labelFieldId === null) return;
  // Only what the view binds is written: its label, the tree's parent and each part it gives.
  values[binding.labelFieldId] = name;
  for (const part of [...textParts, ...choiceParts]) {
    if (binding.has(part)) values[binding.fields[part]] = form.elements[part].value.trim() || null;
  }
  for (const part of ['maturity', 'target']) {
    if (binding.has(part)) values[binding.fields[part]] = form.elements[part].value ? Number(form.elements[part].value) : null;
  }
  const parentId = binding.parentFieldId === null ? null : form.elements.parent.value || null;
  if (binding.parentFieldId !== null) values[binding.parentFieldId] = parentId;
  $('save').disabled = true;
  try {
    // The parent's version goes with the write, so a parent changed meanwhile is refused. An
    // update carries the version the editor opened at, so a stale capability is refused too.
    const parent = parentId ? await nendo.records.get(binding.entityId, parentId) : null;
    const options = parent ? { targetVersions: { [binding.parentFieldId]: parent.version } } : {};
    const saved = editing
      ? await nendo.records.update(editing, values, options)
      : await nendo.records.create(binding.entityId, values, options);
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
document.querySelectorAll('[data-export]').forEach(b => {
  b.onclick = () => exportMap(b.dataset.export).catch(error => say(`Could not export the map: ${error.message}`));
});
// The export menu closes when the person clicks anywhere else.
document.addEventListener('click', event => {
  if ($('export').open && !$('export').contains(event.target)) $('export').open = false;
});
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
  if (drag?.moving) endMove();
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
  if (drag.moving) {
    trackMove(event);
    return;
  }
  // Ctrl pressed after the button turns a press on a card into a pan.
  if (!drag.active && (panMode || event.ctrlKey || event.metaKey)) activatePan(event);
  // Without it, a press on a card that travels four pixels picks the card up (W-079).
  if (!drag.active && drag.card !== null && canMove() && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) >= 4) {
    startMove(event);
    return;
  }
  if (!drag.active) return;
  const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  drag.moved = true;
  map.classList.add('panning');
  pan = { x: drag.px + dx, y: drag.py + dy };
  applyTransform();
}

function setPanMode(on) {
  panMode = on;
  endPan(true);
  map.classList.toggle('pan-ready', panMode);
  $('pan-tool').setAttribute('aria-pressed', String(panMode));
  declareToolbar();
}

$('pan-tool').onclick = () => setPanMode(!panMode);

map.addEventListener('pointerdown', event => {
  suppressPanClick = false;
  if (event.button !== 0) return;
  drag = {
    pointerId: event.pointerId, x: event.clientX, y: event.clientY, px: pan.x, py: pan.y, moved: false, active: false,
    card: event.target.closest('.cap')?.dataset.id ?? null, moving: false, plan: null,
  };
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
  if (drag.moving) {
    trackMove(event);
    const { card: id, plan } = drag;
    endPan();
    dropCard(id, plan);
    return;
  }
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
  if (event.target !== map || event.altKey) return;
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

// ---------------------------------------------------------------------------------------------
// Moving and renaming (W-079)
//
// Dragging a card without a key picks it up: over the middle of a card it goes in, as that
// card's last child; over a card's left or right edge it goes beside it, before or after. A drop
// inside its own subtree is refused before anything is written, and so is one where it already
// stands. Alt+Shift+arrows move the selection as the outline does, and F2 renames it in place.
// Each move is one records.move, which the Engine checks against the versions read: a refused
// write reads the file again, so the map shows what the file holds, and says why.

/** Whether this map can move capabilities: a declared tree, a host that moves, a file that writes. */
function canMove() {
  return binding.parentFieldId !== null && typeof nendo.has === 'function' && nendo.has('records.move') && nendo.context?.readOnly !== true;
}

function canRename() {
  return binding.labelFieldId !== null && typeof nendo.has === 'function' && nendo.has('records.update') && nendo.context?.readOnly !== true;
}

let dragLabel = null;

/** The node the layout packed for a record, in the drawing's coordinates. */
const nodeOf = id => layout?.nodes.find(node => node.id === id && !node.synthetic) ?? null;

function startMove(event) {
  drag.moving = true;
  drag.moved = true;
  map.setPointerCapture(event.pointerId);
  document.querySelector(`.cap[data-id="${CSS.escape(drag.card)}"]`)?.classList.add('dragging');
  dragLabel = el('div', 'drag-label', binding.title(model.byId.get(drag.card)));
  document.body.append(dragLabel);
  trackMove(event);
}

/** Where the pointer would drop the card: into a card, or before or after it. */
function dropAt(x, y) {
  const over = document.elementFromPoint(x, y)?.closest('.cap');
  if (!over || !map.contains(over)) return null;
  const box = over.getBoundingClientRect();
  const along = (x - box.left) / Math.max(1, box.width);
  // A group's edges are a thin band either side; a card's are its outer thirds.
  const edge = over.classList.contains('branch') ? Math.min(0.5, 12 / Math.max(1, box.width)) : 0.3;
  const kind = binding.orderFieldId === null || (along > edge && along < 1 - edge) ? 'into' : along <= edge ? 'before' : 'after';
  return { kind, targetId: over.dataset.id };
}

function trackMove(event) {
  if (dragLabel) Object.assign(dragLabel.style, { left: `${event.clientX + 14}px`, top: `${event.clientY + 12}px` });
  const drop = dropAt(event.clientX, event.clientY);
  drag.plan = drop === null ? null : { drop, ...dropTarget(model, drag.card, drop, binding.orderFieldId !== null) };
  markDrop(drag.plan);
  const name = binding.title(model.byId.get(drag.card));
  if (drag.plan === null) say(`Drop ${name} on a capability, or into a group.`);
  else if (drag.plan.refused) say(`${name} cannot move into its own group.`);
  else if (drag.plan.unchanged) say(`${name} is already there.`);
  else say(`Move ${name} ${placeWords(drag.plan.drop)}.`);
}

function placeWords(drop) {
  const target = binding.title(model.byId.get(drop.targetId));
  return drop.kind === 'into' ? `into ${target}` : `${drop.kind} ${target}`;
}

/** The drop mark: an outline round the group it goes into, or a bar on the side it goes. */
function markDrop(plan) {
  let mark = $('drop');
  const node = plan ? nodeOf(plan.drop.targetId) : null;
  if (!node || plan.unchanged) {
    mark?.remove();
    return;
  }
  if (!mark) {
    mark = el('div');
    mark.id = 'drop';
  }
  $('drawing').append(mark);
  const bar = plan.drop.kind !== 'into' && !plan.refused;
  mark.className = plan.refused ? 'refused' : bar ? 'bar' : 'into';
  const left = !bar ? node.x : plan.drop.kind === 'before' ? node.x - 5 : node.x + node.width + 2;
  Object.assign(mark.style, { left: `${left}px`, top: `${node.y}px`, width: `${bar ? 3 : node.width}px`, height: `${node.height}px` });
}

function endMove() {
  document.querySelectorAll('.cap.dragging').forEach(node => node.classList.remove('dragging'));
  dragLabel?.remove();
  dragLabel = null;
  $('drop')?.remove();
}

/** A drop that the rules allow is one move; any other says why and writes nothing. */
function dropCard(id, plan) {
  if (plan === null) {
    say(statusLine());
    return;
  }
  const name = binding.title(model.byId.get(id));
  if (plan.refused) tell(`${name} cannot move into its own group.`);
  else if (plan.unchanged) tell(`${name} is already there.`);
  else moveCard(id, plan, placeWords(plan.drop));
}

let movingNow = false;

/** One records.move, with the versions read; the map reads the file again either way. */
async function moveCard(id, plan, words, keepFocus = false) {
  if (movingNow) return;
  const record = model.byId.get(id);
  const parent = plan.parentId === null ? null : model.byId.get(plan.parentId);
  const name = binding.title(record);
  movingNow = true;
  try {
    await nendo.records.move(record, { parentRecordId: plan.parentId, parentVersion: parent?.version, beforeRecordId: plan.beforeId });
    selected = id;
    await refresh();
    tell(`Moved ${name} ${words}.`);
  } catch (error) {
    await refresh();
    tell(`${name} was not moved: ${error.message}`);
  } finally {
    movingNow = false;
  }
  if (keepFocus) document.querySelector(`.cap[data-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
}

const steps = { ArrowUp: 'up', ArrowDown: 'down', ArrowRight: 'in', ArrowLeft: 'out' };
const stepWords = { up: 'up', down: 'down', in: 'into the capability above', out: 'out of its group' };

let renaming = null;

function startRename(id) {
  const node = nodeOf(id);
  if (!node) return;
  const record = model.byId.get(id);
  const input = el('input', 'cap-rename');
  input.value = String(record.values?.[binding.labelFieldId] ?? '');
  input.setAttribute('aria-label', `Rename ${binding.title(record)}`);
  Object.assign(input.style, { left: `${node.x + 6}px`, top: `${node.y + 4}px`, width: `${Math.max(80, node.width - 12)}px` });
  renaming = { id, input };
  $('drawing').append(input);
  input.focus();
  input.select();
  input.addEventListener('pointerdown', event => event.stopPropagation());
  input.addEventListener('blur', () => endRename());
  input.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      endRename();
      document.querySelector(`.cap[data-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      saveRename();
    }
  });
}

function endRename() {
  if (!renaming) return;
  const { input } = renaming;
  renaming = null;
  input.remove();
}

async function saveRename() {
  const { id, input } = renaming;
  const name = input.value.trim();
  const record = model.byId.get(id);
  endRename();
  if (!name || name === record.values?.[binding.labelFieldId]) return;
  try {
    await nendo.records.update(record, { [binding.labelFieldId]: name });
    await refresh();
    tell(`Renamed to ${name}.`);
  } catch (error) {
    await refresh();
    tell(`${binding.title(record)} was not renamed: ${error.message}`);
  }
  document.querySelector(`.cap[data-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
}

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && drag?.moving) {
    endPan(true);
    say(statusLine());
    return;
  }
  if (renaming || mode !== 'map' || !selected || !model.byId.has(selected)) return;
  if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && Object.hasOwn(steps, event.key)) {
    event.preventDefault();
    if (!canMove()) return;
    const step = steps[event.key];
    const plan = stepTarget(model, selected, step, binding.orderFieldId !== null);
    if (plan === null) tell(`${binding.title(model.byId.get(selected))} cannot move ${stepWords[step]} from here.`);
    else moveCard(selected, plan, stepWords[step], true);
  } else if (event.key === 'F2' && !event.altKey && !event.ctrlKey && canRename()) {
    event.preventDefault();
    startRename(selected);
  }
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
// Nendo's own chrome (W-090)
//
// Where the host offers it, the Atlas does not draw its toolbar: it declares its controls and
// Nendo draws them in the toolbar every screen has, lists them in Ctrl K with their keys, and
// sends a press back as a command. Nendo's own Add adds a capability under the selected card, or
// the focused group, and a right-click on a card opens Nendo's menu. The declaration follows the
// state: render and the camera declare it again, and the API sends at most ten a second.

const modeOptions = [{ value: 'map', label: 'Map' }, { value: 'assessment', label: 'Assessment' }, { value: 'outline', label: 'Outline' }];
let declaredZoom = null;

function canAdd() {
  return binding.labelFieldId !== null && nendo.context?.readOnly !== true;
}

function declareToolbar() {
  if (!nativeChrome || projection === null) return;
  const levelOptions = [
    ...Array.from({ length: Math.max(1, projection.maxDepth) }, (_, i) => ({ value: String(i + 1), label: String(i + 1) })),
    { value: 'all', label: 'All' },
  ];
  const colours = [...$('colour').options].filter(option => !option.disabled).map(option => ({ value: option.value, label: option.textContent }));
  // A value Nendo would not find among the options would refuse the whole toolbar, so a level
  // deeper than the model, or a mode the configuration misspelt, shows no option chosen.
  const chosen = (options, value) => (options.some(option => option.value === value) ? value : null);
  const items = [
    { kind: 'choice', id: 'mode', label: 'Mode', hideLabel: true, value: chosen(modeOptions, mode), options: modeOptions },
    { kind: 'choice', id: 'levels', label: 'Levels', value: chosen(levelOptions, Number.isFinite(levels) ? String(levels) : 'all'), options: levelOptions },
  ];
  if (colours.length > 1) items.push({ kind: 'select', id: 'colour', label: 'Colour', value: chosen(colours, colour), options: colours });
  items.push({ kind: 'spacer' }, { kind: 'search', id: 'find', label: 'Find a capability', placeholder: 'Find a capability…', value: $('search').value.slice(0, 256), keys: 'Ctrl+F' });
  declaredZoom = $('zoom').textContent;
  if (mode === 'map') {
    items.push(
      { kind: 'separator' },
      { kind: 'toggle', id: 'pan', label: 'Pan', icon: 'pan', iconOnly: true, pressed: panMode },
      { kind: 'group', label: 'Zoom', items: [
        { kind: 'button', id: 'zoom-out', label: 'Zoom out', icon: 'minus', iconOnly: true, keys: 'Ctrl+-' },
        { kind: 'button', id: 'fit', label: 'Fit', keys: 'Ctrl+0' },
        { kind: 'button', id: 'zoom-in', label: 'Zoom in', icon: 'plus', iconOnly: true, keys: 'Ctrl+Plus' },
      ] },
      { kind: 'text', text: declaredZoom, mono: true },
      { kind: 'menu', id: 'map-options', label: 'Map layout', icon: 'settings', iconOnly: true, items: [
        { kind: 'label', label: 'Layout' },
        { kind: 'radio', id: 'layout', value: 'compact', label: 'Reference · compact', checked: layoutMode === 'compact' },
        { kind: 'radio', id: 'layout', value: 'ordered', label: 'Reference · ordered', checked: layoutMode === 'ordered' },
      ] },
      { kind: 'separator' },
      { kind: 'menu', id: 'export', label: 'Export', icon: 'export', disabled: !layout, items: [
        { id: 'export-svg', label: 'SVG, to edit', detail: 'Plain shapes and text that a slide editor keeps as text' },
        { id: 'export-png', label: 'PNG, for a slide', detail: 'Twice the size, with the title and the legend' },
        { kind: 'separator' },
        { kind: 'check', id: 'export-light', label: 'Light colours for print', checked: lightPrint },
      ] },
    );
  }
  nendo.ui.setToolbar({ items, add: canAdd() ? 'add-capability' : null }).catch(error => leaveNativeChrome(error.message));
}

/** A Nendo that refuses the declaration leaves the Atlas its own toolbar, and the Atlas says why. */
function leaveNativeChrome(reason) {
  if (!nativeChrome) return;
  nativeChrome = false;
  document.documentElement.classList.remove('native-chrome');
  document.querySelector('.subbar').prepend($('breadcrumbs'));
  nendo.ui.setToolbar([]).catch(() => undefined);
  render(false);
  tell(`Nendo could not show the Atlas's controls, so the Atlas shows its own: ${reason}`);
}

/** A new capability under the selected card, else under the focused group, else at the top. */
function addCapability() {
  const parent = selected && model.byId.has(selected) ? selected : scope;
  edit(null, binding.parentFieldId === null ? null : parent);
}

function runCommand({ id, value }) {
  switch (id) {
    case 'mode': if (typeof value === 'string') setMode(value); break;
    case 'levels':
      levels = value === 'all' ? Infinity : Number(value);
      render(true);
      break;
    case 'colour':
      colour = String(value);
      $('colour').value = colour;
      render(false);
      break;
    case 'find':
      $('search').value = String(value ?? '');
      query = $('search').value.toLowerCase().trim();
      render(false);
      break;
    case 'pan': setPanMode(value === true); break;
    case 'zoom-in': zoomBy(1.2); break;
    case 'zoom-out': zoomBy(1 / 1.2); break;
    case 'fit': fit(); break;
    case 'layout':
      layoutMode = String(value);
      $('layout').value = layoutMode;
      render(true);
      break;
    case 'export-svg':
    case 'export-png':
      exportMap(id === 'export-svg' ? 'svg' : 'png').catch(error => say(`Could not export the map: ${error.message}`));
      break;
    case 'export-light':
      lightPrint = value === true;
      $('export-light').checked = lightPrint;
      declareToolbar();
      break;
    case 'add-capability': addCapability(); break;
    default: break;
  }
}

/** Nendo's menu for a card: what the card offers, each greyed where it cannot happen now. */
function cardMenu(id) {
  const isGroup = !!model.children.get(id)?.length;
  const ordered = binding.orderFieldId !== null;
  const items = [
    { id: 'open', label: 'Open record', icon: 'external' },
    { id: 'edit', label: 'Edit…', icon: 'edit', disabled: nendo.context?.readOnly === true },
  ];
  if (binding.parentFieldId !== null && canAdd()) items.push({ id: 'add-child', label: 'Add a capability under it', icon: 'plus' });
  if (canRename()) items.push({ id: 'rename', label: 'Rename', keys: 'F2' });
  if (isGroup) items.push({ id: 'focus', label: 'Focus this group', icon: 'focus' });
  if (canMove()) {
    items.push({ kind: 'separator' });
    for (const [step, label, icon, key] of [
      ['up', 'Move up', 'arrowUp', 'ArrowUp'], ['down', 'Move down', 'arrowDown', 'ArrowDown'],
      ['in', 'Put under the card above', 'indent', 'ArrowRight'], ['out', 'Move out of its group', 'outdent', 'ArrowLeft'],
    ]) items.push({ id: `move-${step}`, label, icon, keys: `Alt+Shift+${key}`, disabled: stepTarget(model, id, step, ordered) === null });
  }
  return items;
}

async function openCardMenu(id, at) {
  select(id);
  const pick = await nendo.ui.showMenu(cardMenu(id), at);
  if (pick === null || !model.byId.has(id)) return;
  const record = model.byId.get(id);
  switch (pick.id) {
    case 'open': await nendo.ui.openRecord(binding.entityId, id); break;
    case 'edit': edit(record); break;
    case 'add-child': edit(null, id); break;
    case 'rename': startRename(id); break;
    case 'focus': scopeTo(id); break;
    default:
      if (pick.id.startsWith('move-')) {
        const step = pick.id.slice(5);
        const plan = stepTarget(model, id, step, binding.orderFieldId !== null);
        if (plan === null) tell(`${binding.title(record)} cannot move ${stepWords[step]} from here.`);
        else await moveCard(id, plan, stepWords[step], true);
      }
  }
}

// A right-click on a card, or the context-menu key on a focused one, opens Nendo's menu. A host
// without menus leaves the browser's own, as before.
map.addEventListener('contextmenu', event => {
  if (!nativeChrome || !nendo.has('ui.showMenu')) return;
  const card = event.target.closest('.cap');
  if (!card) return;
  event.preventDefault();
  let at = event;
  if (event.clientX === 0 && event.clientY === 0) {
    const box = card.getBoundingClientRect();
    at = { x: box.left + 8, y: box.bottom - 4 };
  }
  openCardMenu(card.dataset.id, at).catch(error => say(error.message));
});

/** Hand the controls to Nendo when it offers to draw them. */
function adoptNativeChrome() {
  if (typeof nendo.has !== 'function' || !nendo.has('ui.setToolbar')) return;
  nativeChrome = true;
  document.documentElement.classList.add('native-chrome');
  // The group breadcrumbs move into the summary line: the Atlas's own toolbar rows are gone.
  document.querySelector('.metrics').prepend($('breadcrumbs'));
  nendo.on('command', command => {
    held = null;
    try { runCommand(command); } catch (error) { say(error.message); }
  });
}

// ---------------------------------------------------------------------------------------------
// Start

try {
  const context = await nendo.ready;
  adoptNativeChrome();
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
