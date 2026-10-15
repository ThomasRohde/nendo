// Clay: shelves of anything, whose shape grows from what a person types. Every record type
// in the file is a shelf. A detail a shelf has no field for becomes a proposal the person
// accepts in Nendo's review; once it is accepted Clay writes the value it was typed with.
import { KINDS, parseDetail, inferKind, coerce, readFieldRows, shelfOperations, detailOperations, display, typed, kindOf, nameFieldOf, todayIso }
  from './shape.mjs';

const nendo = window.nendo;
const $ = id => document.getElementById(id);
const GLYPH = { text: 'Aa', longText: '¶', integer: '123', decimal: '1.5', date: 'Date', boolean: 'Y/N', rating: '★', choice: '◉', reference: '→', calculated: 'ƒ' };
const SAYS = { text: 'text', longText: 'long text', integer: 'a whole number', decimal: 'a number', date: 'a date', boolean: 'yes or no', rating: 'a rating out of 5', choice: 'a choice', reference: 'a link', calculated: 'worked out by the file' };
// A shelf to start from, with the fields such a shelf usually holds; the form takes them as rows.
const IDEAS = {
  Books: [['Author', 'text'], ['Year', 'integer'], ['Rating', 'rating'], ['Status', 'choice', 'Wishlist, Reading, Finished']],
  Plants: [['Light', 'choice', 'Bright, Medium, Low'], ['Last watered', 'date'], ['Pet safe', 'boolean']],
  Recipes: [['Course', 'choice', 'Starter, Main, Side, Dessert'], ['Serves', 'integer'], ['Ingredients', 'longText'], ['Method', 'longText']],
  Records: [['Artist', 'text'], ['Year', 'integer'], ['Format', 'choice', 'LP, Single, CD'], ['Rating', 'rating']],
  'Board games': [['Players', 'text'], ['Minutes', 'integer'], ['Rating', 'rating'], ['Owned', 'boolean']],
  Trips: [['Where', 'text'], ['From', 'date'], ['To', 'date'], ['Notes', 'longText']],
};

let context = null;
let schema = null;
let shelves = [];          // { entityId, displayName, entity, nameField, records }
let selected = null;       // entityId
let pending = null;        // { proposalId, title, kind, entityId, fieldId, recordId, value, label, says, opened }
let growth = [];           // newest first: { at, text }
let growthVersion = 0;
let builder = null;        // the open field form: { mode: 'shelf' | 'fields', entityId, name, rows, writeBack, problem }
let problems = {};         // recordId -> message under its detail line
let drafts = {};           // recordId -> what is typed in its detail line
let freshFields = new Set(); // fields just grown, drawn once with a mark
let flashRecord = null;
let armed = null;          // a delete waiting for its second press
const expanded = new Set(); // cards showing every long detail
let focusKey = null;
let busy = false;
let pendingTimer = 0, checking = false;

// ---- Small helpers -------------------------------------------------------------------

function h(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
    else if (key === 'class') element.className = value;
    else if (key === 'style') element.style.cssText = value;
    else element.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false)
    element.append(child instanceof Node ? child : String(child));
  return element;
}
// replaceChildren writes a null child as the word "null"; fill leaves it out.
const fill = (element, ...children) => element.replaceChildren(...children.flat().filter(c => c !== null && c !== undefined && c !== false));
const remember = (key, value) => { try { value === null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage off */ } };
const recall = key => { try { return JSON.parse(localStorage.getItem(key) ?? 'null'); } catch { return null; } };
let statusTimer = 0;
function say(text, { problem = false } = {}) {
  const line = $('status');
  line.textContent = text;
  line.classList.toggle('problem-line', problem);
  clearTimeout(statusTimer);
  if (text) statusTimer = setTimeout(() => { line.textContent = ''; }, problem ? 8000 : 4000);
}
const shelfOf = entityId => shelves.find(s => s.entityId === entityId) ?? null;
const current = () => shelfOf(selected);
const readOnly = () => context?.readOnly === true;
// Every ID the file or Clay has used: a retired field keeps its ID, and describe leaves it out.
function takenIds() {
  const taken = new Set(recall('clay.made') ?? []);
  for (const entity of schema?.entities ?? []) {
    taken.add(entity.entityId);
    for (const field of entity.fields) taken.add(field.fieldId);
  }
  return taken;
}
function rememberMade(ids) { remember('clay.made', [...new Set([...(recall('clay.made') ?? []), ...ids])].slice(-500)); }
function shelvesForInference(except = null) {
  return shelves.filter(s => s.nameField && s.entityId !== except).map(s => ({ entityId: s.entityId, displayName: s.displayName, nameFieldId: s.nameField.fieldId,
    records: s.records.map(r => ({ recordId: r.recordId, name: r.values[s.nameField.fieldId] })) }));
}

// ---- Reading the file ----------------------------------------------------------------

async function load() {
  schema = await nendo.schema.describe();
  const read = await Promise.all(schema.entities.map(async entity => {
    const records = await nendo.records.queryAll({ entityId: entity.entityId }, { max: 2000 });
    return { entityId: entity.entityId, displayName: entity.displayName, entity, nameField: nameFieldOf(entity), records };
  }));
  shelves = read.sort((a, b) => a.displayName.localeCompare(b.displayName));
  for (const shelf of shelves) {
    const name = shelf.nameField?.fieldId;
    shelf.records.sort((a, b) => String(a.values[name] ?? '').localeCompare(String(b.values[name] ?? '')));
  }
  if (!shelfOf(selected)) selected = shelfOf(recall('clay.selected'))?.entityId ?? shelves[0]?.entityId ?? null;
}

async function loadGrowth() {
  if (!nendo.has('state.get')) return;
  const entry = await nendo.state.get('growth', { scope: 'package' }).catch(() => null);
  growth = Array.isArray(entry?.value) ? entry.value : [];
  growthVersion = entry?.version ?? 0;
}
async function logGrowth(text) {
  growth = [{ at: new Date().toISOString(), text }, ...growth].slice(0, 100);
  renderGrowth();
  if (!nendo.has('state.set')) return;
  try { growthVersion = (await nendo.state.set('growth', growth, { scope: 'package' }))?.version ?? growthVersion; }
  catch (error) { say(`Clay could not keep its growth log: ${error.message}`, { problem: true }); }
}

let reloadTimer = 0;
function reloadSoon() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    try { await load(); render(); } catch (error) { say(error.message, { problem: true }); }
    if (pending) checkPending();
  }, 120);
}

// ---- Growing the shape ---------------------------------------------------------------

// Prepares a proposal from build(taken), which answers { operations, ids }. When Nendo finds
// it invalid, Clay tries once more with those IDs counted as taken, since a retired field's ID
// is one Clay cannot see.
async function propose(title, build, meta) {
  if (pending) { say(`Clay is still waiting for you to accept "${pending.title}".`); return false; }
  if (readOnly()) { say('This file is open read-only, so Clay cannot grow it.', { problem: true }); return false; }
  const taken = takenIds();
  // Nendo 1.0.0 leaves an operation's definition revision to the caller on a view's
  // proposal, and a view cannot know it. Choice colours are the only such operation Clay can do
  // without, so Clay asks once more without them; links and retiring need the newer Nendo.
  let plain = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const built = build(taken, { plain });
    rememberMade(built.ids);
    let answer;
    try { answer = await nendo.proposals.prepare(title, built.operations); }
    catch (error) {
      if (/expectedDefinitionRevision/.test(error.message ?? '')) {
        if (!plain && built.operations.some(o => o.operationType === 'schema.setChoiceMetadata')) { plain = true; attempt -= 1; continue; }
        say('This version of Nendo cannot make links or retire fields from a view. Update Nendo, or do it in Studio.', { problem: true });
        return false;
      }
      say(error.code === 'proposal-waiting' ? 'Another of Clay\'s proposals is waiting in Nendo. Accept or reject it first.' : `Nendo did not take it: ${error.message}`, { problem: true });
      return false;
    }
    if (answer.state === 'invalid') { built.ids.forEach(id => taken.add(id)); if (attempt === 0) continue;
      const why = answer.diagnostics?.find(d => d.severity !== 'warning') ?? answer.diagnostics?.[0];
      say(`Nendo could not grow the shelf: ${why?.message ?? why?.code ?? 'the change was invalid'}`, { problem: true });
      return false;
    }
    pending = { proposalId: answer.proposalId, title, opened: answer.opened, ...meta, ...built.meta };
    remember('clay.pending', pending);
    renderPending();
    // A rejection commits nothing, so no change arrives to say so: keep asking while it waits.
    if (answer.state === 'previewable') pendingTimer = setTimeout(checkPending, 1500); else await checkPending();
    return true;
  }
  return false;
}

async function checkPending() {
  clearTimeout(pendingTimer);
  if (!pending || checking) return;
  checking = true;
  try { await checkOnce(); } finally { checking = false; }
}
async function checkOnce() {
  let state;
  try { state = (await nendo.proposals.get(pending.proposalId)).state; }
  catch (error) {
    // A proposal from an earlier session of the file is no longer Clay's to ask about: the
    // shape itself says whether it was accepted.
    if (error.code !== 'proposal-not-found') { pendingTimer = setTimeout(checkPending, 3000); return; }
    await load();
    state = landed(pending) ? 'active' : 'gone';
  }
  if (state === 'previewable') { pendingTimer = setTimeout(checkPending, 1500); return; }
  const done = pending;
  pending = null;
  remember('clay.pending', null);
  if (state === 'active') await settle(done);
  else say(state === 'rejected' ? `"${done.title}" was not accepted. Nothing changed.` : `"${done.title}" is ${state}. Nothing changed.`);
  await load();
  render();
}
function landed(proposal) {
  const entity = schema?.entities.find(e => e.entityId === proposal.entityId);
  if (proposal.kind === 'shelf') return Boolean(entity);
  if (proposal.kind === 'fields' || proposal.kind === 'detail')
    return Boolean(entity) && (proposal.fields ?? [{ fieldId: proposal.fieldId }]).every(made => entity.fields.some(f => f.fieldId === made.fieldId));
  if (proposal.kind === 'retire') return proposal.fieldId ? !entity?.fields.some(f => f.fieldId === proposal.fieldId) : !entity;
  return false;
}

// What the accepted proposal was for: select the new shelf, or fill in the value an item was
// typed with when its label opened the form.
async function settle(done) {
  await load();
  if (done.kind === 'retire') { await logGrowth(done.fieldId ? `${done.shelfName} let go of ${done.label}` : `Put the shelf ${done.label} away`); say(`${done.title}: done.`); return; }
  const fields = done.fields ?? (done.fieldId ? [{ fieldId: done.fieldId, label: done.label, says: done.says }] : []);
  const grown = fields.map(f => `${f.label} (${f.says})`).join(', ');
  if (done.kind === 'shelf') {
    selected = done.entityId; remember('clay.selected', selected);
    focusKey = 'item-name';
    await logGrowth(`Made the shelf ${done.label}${grown ? ' with ' + grown : ''}`);
    say(`${done.label} is ready. Add the first item.`);
    return;
  }
  freshFields = new Set(fields.map(f => f.fieldId));
  await logGrowth(`${done.shelfName} grew ${grown}`);
  const back = done.writeBack;
  if (back) {
    const made = fields.find(f => f.label.toLowerCase() === back.label.toLowerCase());
    const field = shelfOf(done.entityId)?.entity.fields.find(f => f.fieldId === made?.fieldId);
    const read = field ? coerce(back.raw, field, { shelves: shelvesForInference(), today: todayIso() }) : null;
    if (read && !read.ok) problems[back.recordId] = read.message;
    else if (read?.value !== null && read?.value !== undefined) {
      try {
        const record = await nendo.records.get(done.entityId, back.recordId);
        if (record) { await nendo.records.update(record, { [field.fieldId]: read.value }); flashRecord = back.recordId; }
      } catch (error) { say(`${back.label} was added, but the value could not be written: ${error.message}`, { problem: true }); return; }
    }
    focusKey = 'detail:' + back.recordId;
  }
  say(`${done.shelfName} now holds ${fields.map(f => f.label).join(', ')}.`);
}

// ---- The field form: a label and a type for each field, and Create ---------------------

const emptyRow = () => ({ label: '', kind: 'text', options: '' });
function openShelfBuilder(name = '') {
  const label = String(name).trim();
  const idea = Object.entries(IDEAS).find(([key]) => key.toLowerCase() === label.toLowerCase())?.[1];
  builder = { mode: 'shelf', entityId: null, name: label, writeBack: null, problem: null,
    rows: idea ? idea.map(([rowLabel, kind, options = '']) => ({ label: rowLabel, kind, options })).concat([emptyRow()]) : [emptyRow()] };
  focusKey = label ? 'b-label-' + (builder.rows.length - 1) : 'b-name';
  render();
}
function openFieldsBuilder(shelf, row = emptyRow(), writeBack = null) {
  builder = { mode: 'fields', entityId: shelf.entityId, name: '', rows: [row], writeBack, problem: null };
  focusKey = writeBack ? 'b-create' : 'b-label-0';
  render();
}
function closeBuilder() {
  const back = builder?.writeBack;
  builder = null;
  focusKey = back ? 'detail:' + back.recordId : null;
  render();
}

async function createFromBuilder() {
  const form = builder;
  const name = form.mode === 'shelf' ? form.name.trim().replace(/\s+/g, ' ') : shelfOf(form.entityId)?.displayName;
  const shelf = form.mode === 'fields' ? shelfOf(form.entityId) : null;
  const refuse = (message, focus = null) => { form.problem = message; focusKey = focus; render(); return false; };
  if (form.mode === 'shelf' && !name) return refuse('Give the shelf a name.', 'b-name');
  if (form.mode === 'shelf' && shelves.some(s => s.displayName.toLowerCase() === name.toLowerCase())) return refuse(`There is already a shelf called ${name}.`, 'b-name');
  if (form.mode === 'fields' && !shelf) return refuse('That shelf is no longer in the file.');
  const read = readFieldRows(form.rows, form.mode === 'shelf' ? ['Name'] : shelf.entity.fields.map(f => f.displayName));
  if (!read.ok) return refuse(read.message);
  if (form.mode === 'fields' && !read.fields.length) return refuse('Give the new field a label.', 'b-label-0');
  const unnamed = read.fields.find(f => f.kind === 'reference' && !shelfOf(f.target)?.nameField);
  if (unnamed) return refuse(`${unnamed.label} links to a shelf that has nothing to name its items by.`);
  const list = read.fields.map(f => f.label).join(', ');
  const title = form.mode === 'shelf' ? `Make the shelf ${name}${list ? ' with ' + list : ''}` : `Add ${list} to ${name}`;
  form.problem = null;
  const proposed = await propose(title, (taken, { plain = false } = {}) => {
    const operations = [], ids = [], made = [];
    let entityId = form.entityId;
    if (form.mode === 'shelf') {
      const created = shelfOperations(name, taken);
      entityId = created.entityId;
      operations.push(...created.operations); ids.push(created.entityId, created.nameFieldId);
      taken.add(created.entityId); taken.add(created.nameFieldId);
    }
    for (const field of read.fields) {
      const target = field.target ? shelfOf(field.target) : null;
      const grown = detailOperations({ entityId, label: field.label, kind: field.kind, options: field.options, target: field.target, targetNameFieldId: target?.nameField.fieldId, colours: !plain }, taken);
      taken.add(grown.fieldId); ids.push(grown.fieldId); operations.push(...grown.operations);
      made.push({ fieldId: grown.fieldId, label: field.label,
        says: field.kind === 'reference' ? `a link to ${target.displayName}` : field.kind === 'choice' ? `a choice of ${field.options.join(', ')}` : SAYS[field.kind] });
    }
    return { operations, ids, meta: { entityId, fields: made } };
  }, { kind: form.mode, label: name, shelfName: name, writeBack: form.writeBack });
  if (proposed && builder === form) { builder = null; render(); }
  return proposed;
}

function retire(shelf, field) {
  const what = field ? field.displayName : shelf.displayName;
  return propose(field ? `Retire ${what} from ${shelf.displayName}` : `Put the shelf ${what} away`, () => ({
    operations: [{ operationType: 'schema.setRetired', payload: { entityId: shelf.entityId, fieldId: field?.fieldId ?? null, retired: true } }], ids: [], meta: {},
  }), { kind: 'retire', entityId: shelf.entityId, fieldId: field?.fieldId ?? null, shelfName: shelf.displayName, label: what });
}

// ---- Writing the data ----------------------------------------------------------------

async function addItem(name) {
  const shelf = current();
  const text = name.trim();
  if (!shelf || !text || busy) return;
  if (!shelf.nameField) { say(`${shelf.displayName} has no text field to name an item by. Grow it in Studio first.`, { problem: true }); return; }
  busy = true;
  try {
    const record = await nendo.records.create(shelf.entityId, { [shelf.nameField.fieldId]: text });
    $('item-name').value = '';
    flashRecord = record?.recordId ?? null;
    focusKey = flashRecord ? 'detail:' + flashRecord : 'item-name';
    await load(); render();
  } catch (error) { say(`Nendo did not add it: ${error.message}`, { problem: true }); }
  finally { busy = false; }
}

// A detail line: set a field the shelf has, or open the grow sheet for one it has not.
async function submitDetail(shelf, record, line) {
  delete problems[record.recordId];
  const parsed = parseDetail(line);
  if (!parsed) { problems[record.recordId] = 'Write a detail as Label: value, such as Year: 1965.'; render(); return; }
  const field = shelf.entity.fields.find(f => f.displayName.toLowerCase() === parsed.label.toLowerCase());
  if (field) {
    const read = coerce(parsed.raw, field, { shelves: shelvesForInference(), today: todayIso() });
    if (!read.ok && kindOf(field) === 'reference' && parsed.raw) {
      // A link to something its shelf does not have yet: offer to make it there and link it.
      const target = shelfOf(field.reference?.targetEntityId);
      if (target?.nameField) {
        problems[record.recordId] = { message: read.message, act: `Add ${parsed.raw} to ${target.displayName} and link it`,
          run: () => linkNew(shelf, record, field, target, parsed.raw) };
        render(); return;
      }
    }
    if (!read.ok) { problems[record.recordId] = read.message; render(); return; }
    try {
      await nendo.records.update(record, { [field.fieldId]: read.value });
      drafts[record.recordId] = '';
      flashRecord = record.recordId; focusKey = 'detail:' + record.recordId;
      await load(); render();
    } catch (error) {
      problems[record.recordId] = error.code === 'record-version-conflict' || /version/i.test(error.message)
        ? 'Someone changed this item meanwhile. Clay read it again; try once more.' : error.message;
      await load(); render();
    }
    return;
  }
  if (pending) { problems[record.recordId] = `Clay is waiting for you to accept "${pending.title}" first.`; render(); return; }
  // A label the shelf does not have opens the field form with that label and a guessed type;
  // the value is filled in once the field exists.
  const guess = inferKind(parsed.raw, { shelves: shelvesForInference(), today: todayIso() });
  const row = { label: parsed.label, kind: guess.kind === 'reference' ? 'ref:' + guess.target : guess.kind, options: (guess.options ?? []).join(', ') };
  const raw = guess.kind === 'choice' ? guess.options[0] : parsed.raw;
  drafts[record.recordId] = '';
  openFieldsBuilder(shelf, row, raw ? { recordId: record.recordId, name: record.values[shelf.nameField?.fieldId] ?? 'the item', raw, label: parsed.label } : null);
}

async function linkNew(shelf, record, field, target, name) {
  delete problems[record.recordId];
  // One revision: the new record, and the link to it, which needs no version since the
  // batch itself makes the target.
  const recordId = 'record-' + [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
  try {
    await nendo.records.batch([
      { op: 'create', entityId: target.entityId, recordId, values: { [target.nameField.fieldId]: name } },
      { op: 'update', entityId: shelf.entityId, recordId: record.recordId, version: record.version, values: { [field.fieldId]: recordId } },
    ], { label: `Add ${name} to ${target.displayName}` });
    drafts[record.recordId] = ''; flashRecord = record.recordId; focusKey = 'detail:' + record.recordId;
    say(`Added ${name} to ${target.displayName}.`);
  } catch (error) { problems[record.recordId] = error.message; }
  await load(); render();
}

async function removeItem(shelf, record) {
  if (armed !== record.recordId) { armed = record.recordId; render(); setTimeout(() => { if (armed === record.recordId) { armed = null; render(); } }, 3000); return; }
  armed = null;
  try { await nendo.records.delete(record); say(`Removed ${record.values[shelf.nameField?.fieldId] ?? 'the item'}.`); await load(); render(); }
  catch (error) { say(`Nendo did not remove it: ${error.message}`, { problem: true }); }
}

// ---- Drawing -------------------------------------------------------------------------

function render() {
  // A redraw replaces the cards, so whatever had the cursor gets it back, where it was.
  const active = document.activeElement;
  const kept = active?.dataset?.focus ?? (active?.id && active !== document.body ? active.id : null);
  const caret = kept && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  const app = $('app');
  app.removeAttribute('aria-busy');
  const total = shelves.reduce((n, s) => n + s.records.length, 0);
  $('tally').textContent = shelves.length ? `${shelves.length} ${shelves.length === 1 ? 'shelf' : 'shelves'} · ${total} ${total === 1 ? 'item' : 'items'}` : 'An empty file';
  $('shelf-name').disabled = readOnly();
  renderRail();
  renderPending();
  renderGrowth();
  const shelf = current();
  const making = builder?.mode === 'shelf';
  $('hero').hidden = Boolean(shelf) || making;
  $('shelf').hidden = !shelf || making;
  if (making) $('pending').after($('builder')); else if (builder) $('shape').after($('builder'));
  renderBuilder();
  if (!making) { if (shelf) renderShelf(shelf); else renderHero(); }
  if (!focusKey && kept) {
    const again = document.querySelector(`[data-focus="${CSS.escape(kept)}"]`) ?? $(kept);
    if (again && again !== document.activeElement && !again.disabled) {
      again.focus({ preventScroll: true });
      if (caret && again.setSelectionRange) try { again.setSelectionRange(...caret); } catch { /* not a text field */ }
    }
  }
  restoreFocus();
}

function renderRail() {
  fill($('shelves'), ...shelves.map(shelf => h('li', {},
    h('button', { type: 'button', class: 'shelf-link', 'aria-current': shelf.entityId === selected ? 'true' : null,
      onclick: () => { selected = shelf.entityId; remember('clay.selected', selected); if (builder?.entityId !== shelf.entityId) builder = null; $('find').value = ''; render(); } },
      h('span', {}, shelf.displayName), h('span', { class: 'n' }, shelf.records.length)))));
}

function renderPending() {
  const banner = $('pending');
  banner.hidden = !pending;
  if (!pending) return fill(banner);
  fill(banner, h('span', { class: 'spin', 'aria-hidden': 'true' }),
    h('p', {}, 'Waiting for you to accept ', h('strong', {}, pending.title), ' in Nendo\'s review. Nothing changes until you do.'),
    h('button', { type: 'button', class: 'button', onclick: async () => {
      try { const answer = await nendo.proposals.open(pending.proposalId); if (!answer.opened) say('Nendo could not open the review just now. Finish what is open there first.'); }
      catch (error) { say(error.message, { problem: true }); }
    } }, 'Open review'));
}

function renderGrowth() {
  $('growth-count').textContent = growth.length;
  $('growth').hidden = growth.length === 0;
  fill($('growth-list'), ...growth.map(entry => h('li', {}, entry.text,
    h('time', { datetime: entry.at }, new Date(entry.at).toLocaleString(context?.locale ?? undefined, { dateStyle: 'medium', timeStyle: 'short' })))));
}

function renderHero() {
  const input = h('input', { id: 'hero-name', maxlength: '60', placeholder: 'Name your first shelf', 'aria-label': 'Name your first shelf', autocomplete: 'off', disabled: readOnly() });
  fill($('hero'),
    h('div', { class: 'mark', 'aria-hidden': 'true' }, 'C'),
    h('h1', {}, shelves.length ? 'Choose a shelf' : 'Clay starts as nothing'),
    h('p', {}, 'Make a shelf and say what its items hold: a label and a type for each field. Add more fields whenever a shelf needs them, and you accept each change in Nendo.'),
    h('form', { onsubmit: event => { event.preventDefault(); openShelfBuilder(input.value); } }, input, h('button', { type: 'submit', class: 'button primary', disabled: readOnly() }, 'Make shelf')),
    h('div', { class: 'ideas' }, Object.keys(IDEAS).map(idea => h('button', { type: 'button', class: 'chip', disabled: readOnly(), onclick: () => openShelfBuilder(idea) }, idea))),
    readOnly() ? h('p', { class: 'read-only' }, 'This file is open read-only.') : null);
  if (document.activeElement === document.body || !document.activeElement) focusKey ??= 'hero-name';
}

function kindSelect(row, index, exceptEntityId) {
  const links = shelves.filter(s => s.nameField && s.entityId !== exceptEntityId);
  return h('select', { 'data-focus': `b-kind-${index}`, 'aria-label': `Type of field ${index + 1}`,
    onchange: event => { row.kind = event.target.value; if (row.kind === 'choice') focusKey = `b-opts-${index}`; render(); } },
    KINDS.filter(k => k.id !== 'reference').map(k => h('option', { value: k.id, selected: row.kind === k.id }, k.label)),
    links.length ? h('optgroup', { label: 'Link to a shelf' }, links.map(s =>
      h('option', { value: 'ref:' + s.entityId, selected: row.kind === 'ref:' + s.entityId }, `Link to ${s.displayName}`))) : null);
}

function renderBuilder() {
  const panel = $('builder');
  panel.hidden = !builder;
  if (!builder) return fill(panel);
  const form = builder;
  const shelf = form.mode === 'fields' ? shelfOf(form.entityId) : null;
  const rows = form.rows.map((row, index) => h('div', { class: 'b-row' + (row.kind === 'choice' ? ' with-options' : '') },
    h('input', { 'data-focus': `b-label-${index}`, value: row.label, maxlength: '60', placeholder: index === 0 ? 'Label, such as Year' : 'Label',
      'aria-label': `Label of field ${index + 1}`, autocomplete: 'off', oninput: event => { row.label = event.target.value; } }),
    kindSelect(row, index, form.entityId),
    form.rows.length > 1 ? h('button', { type: 'button', class: 'b-remove', 'aria-label': `Remove field ${index + 1}`, title: 'Remove this field',
      onclick: () => { form.rows.splice(index, 1); render(); } }, '×') : h('span'),
    row.kind === 'choice' ? h('input', { class: 'b-options', 'data-focus': `b-opts-${index}`, value: row.options ?? '', placeholder: 'Options: Reading, Finished, Wishlist',
      'aria-label': `Options of ${row.label || 'field ' + (index + 1)}`, autocomplete: 'off', oninput: event => { row.options = event.target.value; } }) : null));
  const hint = form.mode === 'shelf' ? 'Every item has a Name. Add the fields its items hold; you can add more later.'
    : form.writeBack ? `${shelf?.displayName} has no ${form.rows[0]?.label || 'such field'} yet. Create it, and Clay fills in "${form.writeBack.raw}" on ${form.writeBack.name}.`
    : 'A new field is offered on every item of the shelf.';
  fill(panel, h('form', { autocomplete: 'off', onsubmit: event => { event.preventDefault(); createFromBuilder(); },
    onkeydown: event => { if (event.key === 'Escape') { event.preventDefault(); closeBuilder(); } } },
    h('h2', {}, form.mode === 'shelf' ? 'New shelf' : `Add fields to ${shelf?.displayName ?? 'the shelf'}`),
    form.mode === 'shelf' ? h('label', { class: 'b-name' }, h('span', {}, 'Shelf name'),
      h('input', { 'data-focus': 'b-name', value: form.name, maxlength: '60', placeholder: 'Books, Plants, Recipes…', oninput: event => { form.name = event.target.value; } })) : null,
    h('p', { class: 'b-hint' }, hint),
    h('div', { class: 'b-head', 'aria-hidden': 'true' }, h('span', {}, 'Label'), h('span', {}, 'Type')),
    rows,
    h('button', { type: 'button', class: 'b-add', onclick: () => { form.rows.push(emptyRow()); focusKey = `b-label-${form.rows.length - 1}`; render(); } }, '+ Another field'),
    form.problem ? h('p', { class: 'problem', role: 'alert' }, form.problem) : null,
    pending ? h('p', { class: 'b-hint' }, `Accept or reject "${pending.title}" first.`) : null,
    h('div', { class: 'b-actions' },
      h('button', { type: 'submit', class: 'button primary', 'data-focus': 'b-create', disabled: Boolean(pending) || readOnly() }, form.mode === 'shelf' ? 'Create shelf' : 'Create fields'),
      h('button', { type: 'button', class: 'button', onclick: closeBuilder }, 'Cancel'))));
}

function renderShelf(shelf) {
  $('shelf-title').textContent = shelf.displayName;
  $('shelf-count').textContent = `${shelf.records.length} ${shelf.records.length === 1 ? 'item' : 'items'}`;
  $('item-name').placeholder = `Add to ${shelf.displayName}…`;
  $('item-name').disabled = readOnly() || !shelf.nameField;
  $('put-away').disabled = readOnly() || Boolean(pending);
  const fields = shelf.entity.fields;
  fill($('shape'), ...fields.map(field => {
    const kind = kindOf(field);
    const removable = !readOnly() && field.fieldId !== shelf.nameField?.fieldId && !field.required && !pending;
    return h('span', { class: 'tag' + (freshFields.has(field.fieldId) ? ' fresh' : ''), title: `${field.displayName}: ${SAYS[kind]}` },
      h('span', { class: 'k', 'aria-hidden': 'true' }, GLYPH[kind]), field.displayName,
      removable ? h('button', { type: 'button', 'aria-label': `Retire ${field.displayName}`, title: `Retire ${field.displayName}; its values stay in the file`,
        onclick: () => retire(shelf, field) }, '×') : null);
  }), readOnly() || builder?.entityId === shelf.entityId ? null
    : h('button', { type: 'button', class: 'tag add', disabled: Boolean(pending), title: pending ? `Accept or reject "${pending.title}" first` : 'Add fields to this shelf',
      onclick: () => openFieldsBuilder(shelf) }, '+ Add fields'));
  freshFields = new Set();

  const wanted = $('find').value.trim().toLowerCase();
  const shown = shelf.records.filter(record => !wanted || fields.some(field => (display(field, record) ?? '').toLowerCase().includes(wanted)));
  fill($('items'), ...shown.map(record => card(shelf, record)));
  $('empty').hidden = shown.length > 0;
  $('empty').textContent = shelf.records.length ? `Nothing on ${shelf.displayName} matches "${$('find').value.trim()}".` : `${shelf.displayName} is empty. Add the first item above.`;
  flashRecord = null;
}

function card(shelf, record) {
  const nameId = shelf.nameField?.fieldId;
  const name = record.values[nameId] ?? '(no name)';
  const edit = (field) => { drafts[record.recordId] = `${field.displayName}: ${typed(field, record)}`; focusKey = 'detail:' + record.recordId; render(); };
  // Short details read as one line of facts; long text is what makes a card tall, so a card
  // shows the first long text cut to two lines and keeps the rest behind Show all.
  const filled = shelf.entity.fields.filter(f => f.fieldId !== nameId).map(field => ({ field, shown: display(field, record) })).filter(d => d.shown !== null);
  const facts = filled.filter(d => kindOf(d.field) !== 'longText');
  const long = filled.filter(d => kindOf(d.field) === 'longText');
  const open = expanded.has(record.recordId);
  const toggle = () => { open ? expanded.delete(record.recordId) : expanded.add(record.recordId); focusKey = 'toggle:' + record.recordId; render(); };
  const factLine = facts.length ? h('ul', { class: 'facts', 'aria-label': 'Details' }, facts.map(({ field, shown }) =>
    h('li', {}, factNode(shelf, field, record, shown, () => edit(field))))) : null;
  let body = null;
  if (open && long.length) body = h('dl', { class: 'details' }, long.flatMap(({ field, shown }) =>
    [h('dt', {}, field.displayName), h('dd', {}, valueNode(shelf, field, record, shown, () => edit(field)))]));
  else if (long.length) body = h('p', { class: 'excerpt', title: `${long[0].field.displayName}. Select to change it` },
    h('button', { type: 'button', onclick: () => edit(long[0].field) }, long[0].shown.replace(/\s*\n+\s*/g, ' ')));
  const more = long.length > 1 || (long.length === 1 && long[0].shown.length > 140)
    ? h('button', { type: 'button', class: 'more', 'data-focus': 'toggle:' + record.recordId, 'aria-expanded': open ? 'true' : 'false', onclick: toggle },
      open ? 'Show less' : long.length > 1 ? 'Show ' + long.slice(1).map(d => d.field.displayName).join(', ') : 'Show all') : null;
  const line = h('input', { 'data-focus': 'detail:' + record.recordId, maxlength: '2000', placeholder: 'Add a detail — Year: 1965', 'aria-label': `Add a detail to ${name}`,
    value: drafts[record.recordId] ?? '', disabled: readOnly(),
    oninput: event => { drafts[record.recordId] = event.target.value; },
    onkeydown: event => { if (event.key === 'Escape') { drafts[record.recordId] = ''; delete problems[record.recordId]; event.target.value = ''; } } });
  return h('li', { class: 'card' + (record.recordId === flashRecord ? ' flash' : ''), 'data-record': record.recordId },
    h('div', { class: 'card-head' },
      h('h2', {}, h('button', { type: 'button', title: 'Rename', onclick: () => nameId && edit(shelf.nameField) }, name)),
      h('div', { class: 'card-tools' },
        h('button', { type: 'button', title: 'Open in Nendo', onclick: () => nendo.ui.openRecord(shelf.entityId, record.recordId).catch(e => say(e.message, { problem: true })) }, 'Open'),
        readOnly() ? null : h('button', { type: 'button', class: armed === record.recordId ? 'armed' : null, onclick: () => removeItem(shelf, record) }, armed === record.recordId ? 'Remove?' : 'Remove'))),
    factLine, body, more,
    h('form', { class: 'detail-line', onsubmit: event => { event.preventDefault(); submitDetail(shelf, record, line.value); } }, line),
    problemNode(problems[record.recordId]));
}

function problemNode(problem) {
  if (!problem) return null;
  if (typeof problem === 'string') return h('p', { class: 'problem', role: 'alert' }, problem);
  return h('p', { class: 'problem', role: 'alert' }, problem.message, ' ',
    h('button', { type: 'button', class: 'button', onclick: problem.run }, problem.act));
}

// One fact on a card's line: its label small, then its value; yes or no reads as the label alone.
function factNode(shelf, field, record, shown, edit) {
  if (kindOf(field) === 'boolean') {
    const yes = record.values[field.fieldId] === true;
    return h('button', { type: 'button', class: 'fact' + (yes ? '' : ' off'), title: `${field.displayName}: ${shown}. Select to change it`, onclick: edit },
      (yes ? '✓ ' : '✗ ') + field.displayName);
  }
  const value = valueNode(shelf, field, record, shown, edit);
  return h('span', { class: 'fact' }, h('span', { class: 'fact-label' }, field.displayName), ' ', value);
}

function valueNode(shelf, field, record, shown, edit) {
  const kind = kindOf(field);
  if (kind === 'calculated') return shown;
  if (kind === 'reference') {
    const target = field.reference?.targetEntityId;
    return h('span', { class: 'link', role: 'link', tabindex: '0', title: `Go to ${shown}`,
      onclick: () => jumpTo(target, record.values[field.fieldId]), onkeydown: e => { if (e.key === 'Enter') jumpTo(target, record.values[field.fieldId]); } }, '→ ' + shown);
  }
  const inner = kind === 'rating' ? h('span', { class: 'stars', 'aria-label': `${record.values[field.fieldId]} of 5` }, shown)
    : kind === 'choice' ? h('span', { class: 'pill', style: `--tone:var(--tone-${field.choices?.find(c => c.id === record.values[field.fieldId])?.tone ?? 'grey'})` }, shown)
    : kind === 'longText' ? h('span', { class: 'long' }, shown) : shown;
  return h('button', { type: 'button', title: `Change ${field.displayName}`, onclick: edit }, inner);
}

function jumpTo(entityId, recordId) {
  if (!shelfOf(entityId)) return;
  selected = entityId; remember('clay.selected', selected);
  $('find').value = ''; flashRecord = recordId;
  render();
  document.querySelector(`[data-record="${CSS.escape(recordId)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function restoreFocus() {
  if (!focusKey) return;
  const target = document.querySelector(`[data-focus="${CSS.escape(focusKey)}"]`) ?? $(focusKey);
  // Show all and Show less keep the page where it is: the card grows below the reader.
  const stay = focusKey.startsWith('toggle:');
  focusKey = null;
  if (!target || target.disabled) return;
  target.focus({ preventScroll: stay });
  if (target.setSelectionRange && target.value) target.setSelectionRange(target.value.length, target.value.length);
}

function applyTheme(theme) {
  if (theme?.mode === 'light' || theme?.mode === 'dark') document.documentElement.dataset.theme = theme.mode;
}

// ---- Wiring --------------------------------------------------------------------------

$('new-shelf').addEventListener('submit', async event => {
  event.preventDefault();
  const input = $('shelf-name');
  openShelfBuilder(input.value);
  input.value = '';
});
$('new-item').addEventListener('submit', event => { event.preventDefault(); addItem($('item-name').value); });
$('find').addEventListener('input', () => renderShelf(current()));
$('studio').addEventListener('click', () => nendo.ui.openStudio(selected).catch(e => say(e.message, { problem: true })));
$('put-away').addEventListener('click', event => {
  const button = event.currentTarget, shelf = current();
  if (!shelf) return;
  if (button.dataset.armed !== 'true') { button.dataset.armed = 'true'; button.textContent = 'Put away?'; setTimeout(() => { button.dataset.armed = ''; button.textContent = 'Put away'; }, 3000); return; }
  button.dataset.armed = ''; button.textContent = 'Put away';
  retire(shelf, null);
});

async function start() {
  try {
    context = await nendo.ready;
    applyTheme(context.theme);
    nendo.on('context', next => { context = next; applyTheme(next.theme); render(); });
    nendo.on('theme', applyTheme);
    nendo.on('changes', reloadSoon);
    pending = recall('clay.pending');
    await Promise.all([load(), loadGrowth()]);
    render();
    if (pending) checkPending();
  } catch (error) {
    $('app').removeAttribute('aria-busy');
    $('tally').textContent = 'Not connected';
    say(error.code === 'not-framed' ? 'Clay runs inside Nendo. Open Clay.nendo to use it.' : `Clay could not read the file: ${error.message}`, { problem: true });
  }
}
start();
