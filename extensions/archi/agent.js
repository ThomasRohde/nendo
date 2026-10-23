// The Archi workbench and the person's launched agent (ADR-0033): what a request to the agent
// says and carries, and an agent's proposal made into writes the editor can preview and Commit
// can save. No DOM and no window.nendo, so it is tested in Node (tools/archi/agent.test.mjs).
//
// Every request is an Ask record, written before the agent is messaged, so a refusal, a reload
// or a closed frame never loses it; the agent updates it as it works. A change the agent would
// make is a Proposal: a list of writes in nendo.records.batch's shape, without versions, which
// the person opens in the editor as waiting edits and commits, or rejects. The skill the file
// carries (tools/archi/skill/SKILL.md) is the agent's half of this.

import { E, HOME_OF_LAYER, deletePlan, label, newArchiId, rootFolderOfKind, typeOf } from './model.js';

export const A = Object.freeze({ ask: 'ar.ask', proposal: 'ar.proposal' });
export const SKILL = Object.freeze({ packageId: 'org.nendo.archimate', name: 'archimate', uri: 'skill://org.nendo.archimate/archimate/SKILL.md' });
export const MODES = Object.freeze(['Propose', 'Answer']);
/** An Ask in one of these is done with: the agent does not take it up again. */
export const FINISHED = Object.freeze(['Answered', 'Proposed', 'Failed', 'Cancelled']);

// Nendo's bounds on one message's context (custom-views.md, assistant.ask): eight items, a
// description of at most 8,000 characters each and 32,000 in all, a title of 120, an address of 600.
const ITEM_CHARACTERS = 7800;
const TITLE_CHARACTERS = 120;
const CONTEXT_LINES = 60;

const MODEL_TYPES = new Set([E.folder, E.concept, E.view, E.item, E.property, E.specialization]);
const CONNECTION_KINDS = new Set(['Relationship connection', 'Connection']);
const ITEM_KIND_WORDS = {
  element: 'Element', box: 'Element', group: 'Group', note: 'Note', ref: 'View reference', 'view reference': 'View reference',
  line: 'Relationship connection', connection: 'Relationship connection', 'relationship connection': 'Relationship connection', plain: 'Connection',
};
const DEFAULT_BOX = { width: 120, height: 55 };
const GAP = 40;
const PER_ROW = 5;

export const oneLine = (text, most = 80) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > most ? `${flat.slice(0, most - 1)}…` : flat;
};
const quoted = text => `«${oneLine(text, 120).replace(/[«»]/g, '"')}»`;
const nowIso = () => new Date().toISOString();

/** Lines of text cut to `most` characters, with a line saying what was left out and where to read it. */
function bounded(lines, most, rest) {
  const kept = [];
  let length = 0;
  for (const [index, line] of lines.entries()) {
    if (length + line.length + 1 > most - 160) {
      kept.push(`… and ${lines.length - index} more lines. ${rest}`);
      break;
    }
    kept.push(line);
    length += line.length + 1;
  }
  return kept.join('\n');
}

const typeKeyOf = (model, concept) => typeOf(model, concept)?.values['ar.type.key'] ?? 'Unknown';
const at = values => {
  const size = (value, fallback) => (typeof value === 'number' && value > 0 ? value : fallback);
  return `at ${values['ar.item.x'] ?? 0},${values['ar.item.y'] ?? 0} ${size(values['ar.item.width'], 'default')}×${size(values['ar.item.height'], 'default')}`;
};

/**
 * The open view as the agent reads it: one line per box and per line, with the record IDs a
 * proposal names. A box's place is relative to the box it sits in, as Archi keeps it.
 */
export function viewListing(model, viewId) {
  const view = model.records.get(viewId);
  if (!view) return '';
  const items = model.of(E.item).filter(item => item.values['ar.item.view'] === viewId);
  const lines = [`view ${viewId} ${quoted(view.values['ar.view.name'])} viewpoint ${view.values['ar.view.viewpoint'] || 'none'}, ${items.length} objects`];
  for (const item of items) {
    const values = item.values;
    const kind = values['ar.item.kind'];
    const inside = values['ar.item.parent'] ? ` in ${values['ar.item.parent']}` : '';
    if (CONNECTION_KINDS.has(kind)) {
      const relationship = model.records.get(values['ar.item.concept']);
      lines.push(kind === 'Connection'
        ? `line ${item.recordId} plain from ${values['ar.item.source']} to ${values['ar.item.target']}`
        : `line ${item.recordId} ${typeKeyOf(model, relationship)} concept ${values['ar.item.concept']} from ${values['ar.item.source']} to ${values['ar.item.target']}`);
    } else if (kind === 'Element') {
      const concept = model.records.get(values['ar.item.concept']);
      lines.push(`box ${item.recordId} ${typeKeyOf(model, concept)} ${quoted(label(model, concept))} concept ${values['ar.item.concept']} ${at(values)}${inside}`);
    } else if (kind === 'Group') {
      lines.push(`group ${item.recordId} ${quoted(values['ar.item.name'])} ${at(values)}${inside}`);
    } else if (kind === 'Note') {
      lines.push(`note ${item.recordId} ${quoted(values['ar.item.content'])} ${at(values)}${inside}`);
    } else if (kind === 'View reference') {
      lines.push(`ref ${item.recordId} view ${values['ar.item.refView']} ${quoted(label(model, model.records.get(values['ar.item.refView'])))} ${at(values)}${inside}`);
    }
  }
  return bounded(lines, ITEM_CHARACTERS, `Read the rest at nendo://application/entity/ar.item/records with ar.item.view eq ${viewId}.`);
}

/** The records selected, as the agent reads them: concepts with their type, documentation and relationships. */
export function selectionListing(model, ids) {
  const concepts = model.of(E.concept);
  const lines = [];
  for (const id of ids) {
    const record = model.records.get(id);
    if (!record) continue;
    if (record.entityId === E.concept) {
      const relationship = record.values['ar.concept.category'] === 'Relationship';
      if (relationship) {
        lines.push(`relationship ${id} ${typeKeyOf(model, record)} ${quoted(label(model, record))} from ${record.values['ar.concept.source']} to ${record.values['ar.concept.target']}`);
      } else {
        const from = concepts.filter(other => other.values['ar.concept.source'] === id).length;
        const to = concepts.filter(other => other.values['ar.concept.target'] === id).length;
        const views = new Set(model.of(E.item).filter(item => item.values['ar.item.concept'] === id).map(item => item.values['ar.item.view'])).size;
        lines.push(`element ${id} ${typeKeyOf(model, record)} ${quoted(label(model, record))}: ${from} relationships from it, ${to} to it, on ${views} ${views === 1 ? 'view' : 'views'}`);
      }
      const documentation = oneLine(record.values['ar.concept.documentation'], 240);
      if (documentation) lines.push(`  documentation: ${documentation}`);
    } else if (record.entityId === E.view) {
      lines.push(`view ${id} ${quoted(label(model, record))}`);
    } else if (record.entityId === E.folder) {
      lines.push(`folder ${id} ${quoted(label(model, record))}`);
    } else if (record.entityId === E.item) {
      lines.push(`diagram object ${id} on view ${record.values['ar.item.view']}`);
    }
  }
  return bounded(lines, ITEM_CHARACTERS, 'Read each by its record ID.');
}

/** The Ask's Context: what the person had open and selected, named by record ID, short enough to keep. */
export function askContext(model, { viewId = null, selected = [] } = {}) {
  const lines = [];
  const view = viewId ? model.records.get(viewId) : null;
  if (view) lines.push(`view ${viewId} ${quoted(label(model, view))}`);
  for (const id of selected) {
    const record = model.records.get(id);
    if (!record || id === viewId || record.entityId === E.model) continue;
    const word = record.entityId === E.concept ? (record.values['ar.concept.category'] === 'Relationship' ? 'relationship' : 'element')
      : record.entityId === E.view ? 'view' : record.entityId === E.folder ? 'folder' : 'object';
    lines.push(`${word} ${id} ${quoted(label(model, record))}`);
    if (lines.length >= CONTEXT_LINES) break;
  }
  return lines.join('\n');
}

/** The Ask record for a request, before the agent is messaged. */
export function askRecord(model, { request, mode = 'Propose', viewId = null, selected = [], recordId = `ar.ask.r.${crypto.randomUUID()}` }) {
  const text = String(request ?? '').trim();
  if (!text) throw new Error('Say what to ask the agent.');
  if (!MODES.includes(mode)) throw new Error(`${mode} is not a way to ask.`);
  return { op: 'create', entityId: A.ask, recordId, values: {
    'ar.ask.request': text.slice(0, 20000), 'ar.ask.mode': mode, 'ar.ask.context': askContext(model, { viewId, selected }) || null,
    'ar.ask.state': 'Waiting', 'ar.ask.asked': nowIso(),
  } };
}

const MODE_RULES = {
  Propose: 'Change nothing in the model yourself. Write each change you would make as an Agent proposal (ar.proposal): record writes, at most three alternatives, '
    + 'as the skill says. The person previews each on its view in Archi\'s editor and applies it. Then set the Ask\'s state to Proposed.',
  Answer: 'Answer only. Write nothing but the Ask: its Progress, its Reply and the state Answered.',
};

/**
 * The message for an Ask, and its context: the Ask itself, the open view's objects, what is
 * selected, and the validator's findings when the request is about them. Each item names a record
 * address the agent can read for more.
 */
export function askMessage(model, ask, { viewId = null, selected = [], issues = [] } = {}) {
  const request = String(ask.values['ar.ask.request'] ?? '');
  const mode = MODES.includes(ask.values['ar.ask.mode']) ? ask.values['ar.ask.mode'] : 'Propose';
  const text = [
    `Work Archi ask ${quoted(oneLine(request, 60))} (${A.ask} record ${ask.recordId}) by this file's ${SKILL.name} skill (${SKILL.uri}), as a message from the Archi view.`,
    MODE_RULES[mode],
    'Reply to this message in one or two sentences: the person reads it in the Agent panel beside the model.',
    '',
    'The request, in the person\'s words:',
    request,
  ].join('\n');
  const title = words => oneLine(words, TITLE_CHARACTERS);
  const context = [{
    uri: `nendo://application/entity/${A.ask}/records?recordId=${encodeURIComponent(ask.recordId)}`,
    title: title(`Ask: ${request}`),
    text: [`ask ${ask.recordId}`, `mode ${mode}`, String(ask.values['ar.ask.context'] ?? '')].filter(Boolean).join('\n').slice(0, ITEM_CHARACTERS),
  }];
  const view = viewId ? model.records.get(viewId) : null;
  if (view) {
    const filter = encodeURIComponent(JSON.stringify([{ fieldId: 'ar.item.view', op: 'eq', value: viewId }]));
    context.push({ uri: `nendo://application/entity/${E.item}/records?filter=${filter}&limit=100`, title: title(`View: ${label(model, view)}`), text: viewListing(model, viewId) });
  }
  const chosen = selected.filter(id => id !== viewId && model.records.has(id) && model.records.get(id).entityId !== E.model);
  if (chosen.length > 0) {
    const first = model.records.get(chosen[0]);
    context.push({
      uri: `nendo://application/entity/${first.entityId}/records?recordId=${encodeURIComponent(first.recordId)}`,
      title: title(chosen.length === 1 ? `Selected: ${label(model, first)}` : `Selected: ${chosen.length} records`),
      text: selectionListing(model, chosen),
    });
  }
  if (issues.length > 0) {
    context.push({
      uri: `nendo://application/entity/${E.concept}/records?limit=100`,
      title: title(`The validator's findings (${issues.length})`),
      text: bounded(issues.map(issue => `${issue.severity} ${quoted(issue.message)}${issue.objectId ? ` on ${issue.objectId}` : ''}${issue.where ? ` (${oneLine(issue.where, 80)})` : ''}`),
        ITEM_CHARACTERS, 'Run the checks again over the records for the rest.'),
    });
  }
  return { text, context };
}

/** The Ask once its turn has ended, when the agent left it unfinished: the fallback that keeps every Ask true. */
export function finishedAsk(ask, { reply = '', stopReason = 'end_turn', proposals = 0, refusal = null } = {}) {
  if (!ask || FINISHED.includes(ask.values['ar.ask.state'])) return null;
  const progress = String(ask.values['ar.ask.progress'] ?? '');
  const values = { 'ar.ask.finished': nowIso() };
  if (refusal) Object.assign(values, { 'ar.ask.state': 'Failed', 'ar.ask.progress': [progress, `Not sent: ${refusal}`].filter(Boolean).join('\n') });
  else if (stopReason === 'cancelled') Object.assign(values, { 'ar.ask.state': 'Cancelled', 'ar.ask.progress': [progress, 'Stopped by the person.'].filter(Boolean).join('\n') });
  else Object.assign(values, { 'ar.ask.state': proposals > 0 ? 'Proposed' : 'Answered' });
  if (!refusal && reply && !ask.values['ar.ask.reply']) values['ar.ask.reply'] = String(reply).slice(0, 20000);
  return { op: 'update', entityId: A.ask, recordId: ask.recordId, version: ask.version, values };
}

/** The last line of an Ask's Progress, and the step it names ("3 of 7"), for the panel. */
export function progressOf(ask) {
  const lines = String(ask?.values['ar.ask.progress'] ?? '').split('\n').map(line => line.trim()).filter(Boolean);
  const last = lines.at(-1) ?? '';
  const step = /(\d+)\s+of\s+(\d+)/.exec(last);
  return { last, step: step ? { done: Number(step[1]), of: Number(step[2]) } : null };
}

/** A Proposal's writes, parsed: a JSON list, or an object holding one as `writes`. */
export function parseWrites(text) {
  let value;
  try { value = JSON.parse(String(text ?? '')); } catch (error) { return { writes: [], error: `Its writes are not JSON: ${error.message}` }; }
  const writes = Array.isArray(value) ? value : Array.isArray(value?.writes) ? value.writes : null;
  if (!writes) return { writes: [], error: 'Its writes are not a list.' };
  for (const [index, write] of writes.entries()) {
    if (!write || typeof write !== 'object') return { writes: [], error: `Write ${index + 1} is not an object.` };
    if (!['create', 'update', 'delete'].includes(write.op)) return { writes: [], error: `Write ${index + 1} has no op of create, update or delete.` };
    if (write.op !== 'create' && typeof write.recordId !== 'string') return { writes: [], error: `Write ${index + 1}, an ${write.op}, names no record.` };
  }
  return { writes, error: null };
}

/** A concept type named by its record ID, its key or its name, as an agent may name it. */
function typeFinder(model) {
  const found = new Map();
  for (const type of model.types.values()) {
    found.set(type.recordId, type);
    found.set(String(type.values['ar.type.key']).toLowerCase(), type);
    found.set(String(type.values['ar.type.name']).toLowerCase(), type);
    found.set(String(type.values['ar.type.name']).toLowerCase().replace(/\s+/g, ''), type);
  }
  return value => (typeof value === 'string' ? found.get(value) ?? found.get(value.toLowerCase()) ?? found.get(value.toLowerCase().replace(/[\s-]+/g, '')) ?? null : null);
}

/**
 * A Proposal's writes made ready for the editor: the agent's own IDs given record IDs, concept
 * types named by key or name resolved, a concept's folder and a box's kind and size filled in
 * where the agent left them out, a line's ends found from its relationship's ends, a delete
 * taking with it what Archi's would, and boxes given no place placed. `allowed(source, target,
 * relationship)` answers whether ArchiMate allows a relationship between two type keys.
 *
 * Answers { writes, viewId, layout, unplaced, problems, blocking, counts, changes }: `layout` is
 * the view ELK should lay out because none of its boxes has a place; `blocking` is true when a
 * write would be refused by the file, so the proposal can be previewed and changed but not applied as it is.
 */
export function planProposal(model, input, { allowed = () => true, viewId: wantedView = null, newId = () => `ar-${newArchiId()}` } = {}) {
  const problems = [];
  let blocking = false;
  const findType = typeFinder(model);
  const ids = new Map();
  for (const write of input) {
    if (write.op !== 'create') continue;
    const own = write.recordId;
    const real = typeof own === 'string' && own.startsWith('ar-') && !model.records.has(own) && !ids.has(own) ? own : newId();
    if (typeof own === 'string') ids.set(own, real);
    write.__id = real;
  }
  const resolve = value => (typeof value === 'string' && ids.has(value) ? ids.get(value) : value);
  // The proposal's view may be one its writes make, named by the agent's own ID.
  wantedView = resolve(wantedView);
  const planned = new Map();
  const exists = id => model.records.has(id) || planned.has(id);
  const entityOf = id => model.records.get(id)?.entityId ?? planned.get(id)?.entityId ?? null;
  const valuesOf = id => planned.get(id)?.values ?? model.records.get(id)?.values ?? null;
  const out = [];
  const removed = new Set();

  const cleanValues = (entityId, values) => {
    const clean = {};
    for (const [fieldId, value] of Object.entries(values ?? {})) {
      if (!fieldId.startsWith(`${entityId}.`) || fieldId.endsWith('.archiId')) continue;
      clean[fieldId] = resolve(value);
    }
    return clean;
  };
  const conceptType = (values, where) => {
    if (!('ar.concept.type' in values)) return true;
    const type = findType(values['ar.concept.type']);
    if (!type) { problems.push(`${where}: ${values['ar.concept.type']} is not an ArchiMate type.`); return false; }
    values['ar.concept.type'] = type.recordId;
    values['ar.concept.category'] = type.values['ar.type.category'];
    return true;
  };

  for (const write of input) {
    const entityId = write.op === 'create' ? write.entityId : entityOf(resolve(write.recordId)) ?? write.entityId;
    if (!MODEL_TYPES.has(entityId)) {
      problems.push(`A write to ${entityId ?? 'an unnamed record type'} was left out: a proposal changes only the model.`);
      continue;
    }
    if (write.op === 'create') {
      const recordId = write.__id;
      const values = cleanValues(entityId, write.values);
      if (entityId === E.concept) {
        if (!values['ar.concept.type']) { problems.push(`A new concept ${quoted(values['ar.concept.name'])} has no type; it was left out.`); continue; }
        if (!conceptType(values, `The new concept ${quoted(values['ar.concept.name'])}`)) continue;
        const type = model.types.get(values['ar.concept.type']);
        if (!values['ar.concept.folder'] || entityOf(values['ar.concept.folder']) !== E.folder) {
          values['ar.concept.folder'] = rootFolderOfKind(model, HOME_OF_LAYER[type.values['ar.type.layer']])?.recordId ?? null;
        }
        if (values['ar.concept.category'] === 'Element' && !values['ar.concept.name']) values['ar.concept.name'] = type.values['ar.type.name'];
        if (type.values['ar.type.key'] === 'Junction' && !values['ar.concept.junction']) values['ar.concept.junction'] = 'And';
      } else if (entityId === E.view) {
        if (!values['ar.view.folder'] || entityOf(values['ar.view.folder']) !== E.folder) values['ar.view.folder'] = rootFolderOfKind(model, 'Views')?.recordId ?? null;
        if (!values['ar.view.name']) values['ar.view.name'] = 'New view';
      } else if (entityId === E.folder) {
        if (entityOf(values['ar.folder.parent']) !== E.folder) { problems.push(`The new folder ${quoted(values['ar.folder.name'])} names no folder to go in; it was left out.`); continue; }
        if (!values['ar.folder.name']) values['ar.folder.name'] = 'New folder';
      } else if (entityId === E.item) {
        values['ar.item.view'] ??= wantedView;
        if (entityOf(values['ar.item.view']) !== E.view) { problems.push('A diagram object names no view it is on; it was left out.'); continue; }
        const word = typeof values['ar.item.kind'] === 'string' ? ITEM_KIND_WORDS[values['ar.item.kind'].toLowerCase()] ?? values['ar.item.kind'] : null;
        const concept = values['ar.item.concept'] ? valuesOf(values['ar.item.concept']) : null;
        values['ar.item.kind'] = word ?? (concept ? (concept['ar.concept.category'] === 'Relationship' ? 'Relationship connection' : 'Element')
          : values['ar.item.refView'] ? 'View reference' : values['ar.item.content'] ? 'Note' : 'Group');
        if (values['ar.item.kind'] === 'Relationship connection') {
          if (!concept || concept['ar.concept.category'] !== 'Relationship') { problems.push('A line names no relationship it shows; it was left out.'); continue; }
          // A line between the boxes that show its relationship's ends, when the agent named none.
          const end = (fieldId, conceptField) => {
            if (values[fieldId] && exists(values[fieldId])) return;
            const wanted = concept[conceptField];
            const boxes = [...planned.entries()].filter(([, entry]) => entry.entityId === E.item).map(([id, entry]) => ({ recordId: id, values: entry.values }))
              .concat(model.of(E.item).filter(item => !removed.has(item.recordId)));
            const box = boxes.find(item => item.values['ar.item.view'] === values['ar.item.view'] && item.values['ar.item.concept'] === wanted && !CONNECTION_KINDS.has(item.values['ar.item.kind']));
            values[fieldId] = box?.recordId ?? null;
          };
          end('ar.item.source', 'ar.concept.source');
          end('ar.item.target', 'ar.concept.target');
          if (!values['ar.item.source'] || !values['ar.item.target']) { problems.push(`A line for ${quoted(concept['ar.concept.name'] || 'a relationship')} has no box at one of its ends on the view; it was left out.`); continue; }
        } else if (values['ar.item.kind'] === 'Element') {
          if (!concept || concept['ar.concept.category'] !== 'Element') { problems.push('A box names no element it shows; it was left out.'); continue; }
          const type = model.types.get(concept['ar.concept.type']);
          values['ar.item.width'] ??= type?.values['ar.type.width'] ?? DEFAULT_BOX.width;
          values['ar.item.height'] ??= type?.values['ar.type.height'] ?? DEFAULT_BOX.height;
        } else if (values['ar.item.kind'] === 'Group') {
          values['ar.item.width'] ??= 400;
          values['ar.item.height'] ??= 140;
        }
      } else if (entityId === E.property) {
        if (!values['ar.property.key']) { problems.push('A property has no key; it was left out.'); continue; }
      }
      planned.set(recordId, { entityId, values });
      out.push({ op: 'create', entityId, recordId, values });
      continue;
    }

    const recordId = resolve(write.recordId);
    if (write.op === 'update') {
      const values = cleanValues(entityId, write.values);
      if (entityId === E.concept && !conceptType(values, `The change to ${quoted(label(model, model.records.get(recordId)) || recordId)}`)) continue;
      if (planned.has(recordId)) { Object.assign(planned.get(recordId).values, values); continue; }
      const record = model.records.get(recordId);
      if (!record || removed.has(recordId)) { problems.push(`A change names ${recordId}, which is not in the model; it was left out.`); continue; }
      if (Object.keys(values).length === 0) continue;
      out.push({ op: 'update', entityId, recordId, values });
      continue;
    }

    // A delete: of something this proposal makes, it is not made; of a record, it takes what Archi's delete takes.
    if (planned.has(recordId)) {
      planned.delete(recordId);
      out.splice(out.findIndex(entry => entry.recordId === recordId), 1);
      continue;
    }
    if (!model.records.has(recordId)) { problems.push(`A delete names ${recordId}, which is not in the model; it was left out.`); continue; }
    try {
      for (const entry of deletePlan(model, [recordId]).writes) {
        if (removed.has(entry.recordId)) continue;
        removed.add(entry.recordId);
        out.push({ op: 'delete', entityId: entry.entityId, recordId: entry.recordId });
      }
    } catch (error) { problems.push(`${error.message} It was left out.`); }
  }
  for (const write of input) delete write.__id;

  // ArchiMate's relationships, checked as the file will check them when they are saved.
  const finalValues = id => {
    const base = model.records.get(id)?.values ?? {};
    const change = out.filter(entry => entry.recordId === id && entry.op !== 'delete').reduce((all, entry) => ({ ...all, ...entry.values }), {});
    return { ...base, ...change };
  };
  for (const entry of out) {
    if (entry.entityId !== E.concept || entry.op === 'delete') continue;
    const values = finalValues(entry.recordId);
    if (values['ar.concept.category'] !== 'Relationship') continue;
    if (!('ar.concept.type' in entry.values || 'ar.concept.source' in entry.values || 'ar.concept.target' in entry.values)) continue;
    const source = valuesOfFinal(values['ar.concept.source']), target = valuesOfFinal(values['ar.concept.target']);
    const keyOf = typeId => model.types.get(typeId)?.values['ar.type.key'];
    const nameOf = typeId => model.types.get(typeId)?.values['ar.type.name'] ?? 'an unknown type';
    if (!source || !target) {
      problems.push(`The relationship ${quoted(values['ar.concept.name'] || nameOf(values['ar.concept.type']))} is missing an end.`);
      blocking = true;
      continue;
    }
    if (!allowed(keyOf(source['ar.concept.type']), keyOf(target['ar.concept.type']), keyOf(values['ar.concept.type']))) {
      problems.push(`ArchiMate does not allow ${nameOf(values['ar.concept.type'])} from ${quoted(source['ar.concept.name'] || nameOf(source['ar.concept.type']))} (${nameOf(source['ar.concept.type'])}) to ${quoted(target['ar.concept.name'] || nameOf(target['ar.concept.type']))} (${nameOf(target['ar.concept.type'])}).`);
      blocking = true;
    }
  }
  function valuesOfFinal(id) { return id && !removed.has(id) && exists(id) ? finalValues(id) : null; }

  const createdViews = out.filter(entry => entry.op === 'create' && entry.entityId === E.view).map(entry => entry.recordId);
  const firstItemView = out.find(entry => entry.entityId === E.item && entry.op !== 'delete')?.values?.['ar.item.view']
    ?? model.records.get(out.find(entry => entry.entityId === E.item && entry.op === 'update')?.recordId)?.values['ar.item.view'];
  const viewId = (wantedView && exists(wantedView) && entityOf(wantedView) === E.view && !removed.has(wantedView) ? wantedView : null)
    ?? createdViews[0] ?? (firstItemView && !removed.has(firstItemView) ? firstItemView : null);
  const { layout, unplaced } = place(model, out);
  return { writes: out, viewId, layout, unplaced, problems, blocking, counts: countOf(model, out), changes: changesOf(model, out, planned) };
}

/**
 * A Proposal as the editor's waiting edits: planned, applied to the records, laid out by ELK
 * where it gave its boxes no place, and taken back to writes as a Commit would send them, with
 * Archi IDs and the versions of what they point at. `canvas` is canvas.js, passed in so Node runs
 * the same code the workbench does.
 */
export async function proposalEdits(canvas, sets, model, proposal) {
  const { writes, error } = parseWrites(proposal.values['ar.proposal.writes']);
  if (error) return { error };
  const allowed = (source, target, relationship) => canvas.validRelationshipTypes(source, target).includes(relationship);
  const plan = planProposal(model, writes, { allowed, viewId: proposal.values['ar.proposal.view'] || null });
  if (plan.writes.length === 0) return { ...plan, edits: [], error: plan.problems[0] ?? 'It changes nothing.' };
  const base = canvas.buildMirror(sets);
  let after = canvas.buildMirror(canvas.applyWrites(sets, plan.writes));
  for (const viewId of plan.layout) after = (await canvas.layoutModel(after, viewId, [], 'right')).model;
  return { ...plan, edits: canvas.writesFor(sets, base, after), error: null };
}

/**
 * Places the boxes a proposal gives no place. On a view of its own making, or one none of whose
 * boxes has a place, they are put in a grid and the view is named for ELK to lay out. On a view
 * that has boxes, they go in rows below them; inside a box, in rows inside it.
 */
function place(model, writes) {
  const unplaced = [];
  const views = new Map();
  for (const write of writes) {
    if (write.op !== 'create' || write.entityId !== E.item || CONNECTION_KINDS.has(write.values['ar.item.kind'])) continue;
    if (typeof write.values['ar.item.x'] === 'number' && typeof write.values['ar.item.y'] === 'number') continue;
    unplaced.push(write);
    const viewId = write.values['ar.item.view'];
    if (!views.has(viewId)) views.set(viewId, []);
    views.get(viewId).push(write);
  }
  const layout = [];
  for (const [viewId, boxes] of views) {
    const placedHere = [...model.of(E.item).filter(item => item.values['ar.item.view'] === viewId), ...writes.filter(write =>
      write.op === 'create' && write.entityId === E.item && write.values['ar.item.view'] === viewId && !boxes.includes(write)).map(write => ({ recordId: write.recordId, values: write.values }))]
      .filter(item => !CONNECTION_KINDS.has(item.values['ar.item.kind']));
    const topLevel = placedHere.filter(item => !item.values['ar.item.parent']);
    const fresh = !model.records.has(viewId) || topLevel.length === 0;
    if (fresh && boxes.length > 1) layout.push(viewId);
    const bottom = topLevel.reduce((most, item) => Math.max(most, (item.values['ar.item.y'] ?? 0) + Math.max(item.values['ar.item.height'] ?? DEFAULT_BOX.height, 0)), 0);
    const left = topLevel.length ? Math.min(...topLevel.map(item => item.values['ar.item.x'] ?? 0)) : 24;
    const rows = new Map();
    for (const box of boxes) {
      const parent = box.values['ar.item.parent'] ?? null;
      const slot = rows.get(parent) ?? 0;
      rows.set(parent, slot + 1);
      const width = box.values['ar.item.width'] ?? DEFAULT_BOX.width, height = box.values['ar.item.height'] ?? DEFAULT_BOX.height;
      const column = slot % PER_ROW, row = Math.floor(slot / PER_ROW);
      if (parent) {
        box.values['ar.item.x'] = 12 + column * (width + 16);
        box.values['ar.item.y'] = 28 + row * (height + 16);
      } else {
        box.values['ar.item.x'] = left + column * (width + GAP);
        box.values['ar.item.y'] = (topLevel.length ? bottom + GAP + 8 : 24) + row * (height + GAP);
      }
    }
  }
  return { layout, unplaced: unplaced.map(write => write.recordId) };
}

function countOf(model, writes) {
  const counts = { elements: 0, relationships: 0, views: 0, boxes: 0, lines: 0, changed: 0, removed: 0 };
  for (const write of writes) {
    if (write.op === 'update') { counts.changed++; continue; }
    if (write.op === 'delete') { if (write.entityId !== E.item && write.entityId !== E.property) counts.removed++; continue; }
    if (write.entityId === E.concept) counts[write.values['ar.concept.category'] === 'Relationship' ? 'relationships' : 'elements']++;
    else if (write.entityId === E.view) counts.views++;
    else if (write.entityId === E.item) counts[CONNECTION_KINDS.has(write.values['ar.item.kind']) ? 'lines' : 'boxes']++;
  }
  return counts;
}

/** What a proposal's counts say, in words: "3 elements, 4 relationships, a view". */
export function countsSentence(counts) {
  const part = (n, one, many) => (n === 0 ? null : n === 1 ? `1 ${one}` : `${n} ${many}`);
  const made = [part(counts.elements, 'new element', 'new elements'), part(counts.relationships, 'new relationship', 'new relationships'),
    part(counts.views, 'new view', 'new views'), part(counts.boxes, 'box', 'boxes'), part(counts.lines, 'line', 'lines'),
    part(counts.changed, 'change', 'changes'), part(counts.removed, 'removal', 'removals')].filter(Boolean);
  return made.length ? made.join(' · ') : 'No changes';
}

/** The changes a person reads before applying: what is made, renamed, documented or removed. */
function changesOf(model, writes, planned) {
  const lines = [];
  const name = id => {
    const record = model.records.get(id);
    if (record) return label(model, record);
    const values = planned.get(id)?.values;
    return values?.['ar.concept.name'] || values?.['ar.view.name'] || values?.['ar.folder.name'] || 'a new concept';
  };
  const typeName = typeId => model.types.get(typeId)?.values['ar.type.name'] ?? 'Concept';
  let moved = 0;
  for (const write of writes) {
    const values = write.values ?? {};
    if (write.op === 'create' && write.entityId === E.concept) {
      lines.push(values['ar.concept.category'] === 'Relationship'
        ? `New ${typeName(values['ar.concept.type'])}: ${quoted(name(values['ar.concept.source']))} → ${quoted(name(values['ar.concept.target']))}`
        : `New ${typeName(values['ar.concept.type'])} ${quoted(values['ar.concept.name'])}`);
    } else if (write.op === 'create' && write.entityId === E.view) lines.push(`New view ${quoted(values['ar.view.name'])}`);
    else if (write.op === 'create' && write.entityId === E.folder) lines.push(`New folder ${quoted(values['ar.folder.name'])}`);
    else if (write.op === 'create' && write.entityId === E.property) lines.push(`Property ${quoted(values['ar.property.key'])} on ${quoted(name(values['ar.property.concept'] ?? values['ar.property.view'] ?? values['ar.property.folder']))}`);
    else if (write.op === 'update' && write.entityId === E.item) moved++;
    else if (write.op === 'update') {
      const record = model.records.get(write.recordId);
      const was = label(model, record);
      for (const fieldId of Object.keys(values)) {
        if (fieldId.endsWith('.name')) lines.push(`Rename ${quoted(was)} to ${quoted(values[fieldId])}`);
        else if (fieldId.endsWith('.documentation')) lines.push(`Document ${quoted(was)}`);
        else if (fieldId === 'ar.concept.type') lines.push(`${quoted(was)} becomes ${typeName(values[fieldId])}`);
        else if (fieldId === 'ar.concept.category') continue;
        else lines.push(`Change ${quoted(was)}: ${fieldId.split('.').at(-1)}`);
      }
    } else if (write.op === 'delete' && write.entityId !== E.item && write.entityId !== E.property) lines.push(`Remove ${quoted(label(model, model.records.get(write.recordId)))}`);
  }
  if (moved) lines.push(`${moved} ${moved === 1 ? 'box moved or resized' : 'boxes moved or resized'}`);
  return lines;
}

/** The asks newest first, each with its proposals in their order. */
export function asksWithProposals(asks, proposals) {
  const byAsk = new Map();
  for (const proposal of proposals) {
    const askId = proposal.values['ar.proposal.ask'];
    if (!byAsk.has(askId)) byAsk.set(askId, []);
    byAsk.get(askId).push(proposal);
  }
  for (const list of byAsk.values()) list.sort((a, b) => (a.values['ar.proposal.order'] ?? 0) - (b.values['ar.proposal.order'] ?? 0) || (a.recordId < b.recordId ? -1 : 1));
  return [...asks].sort((a, b) => String(b.values['ar.ask.asked'] ?? '').localeCompare(String(a.values['ar.ask.asked'] ?? '')) || (a.recordId < b.recordId ? 1 : -1))
    .map(ask => ({ ask, proposals: byAsk.get(ask.recordId) ?? [] }));
}

/** The writes that remove asks with their proposals: proposals first, as they point at their ask. */
export function removeAsks(asks, proposals, askIds) {
  const doomed = new Set(askIds);
  return [
    ...proposals.filter(proposal => doomed.has(proposal.values['ar.proposal.ask']))
      .map(proposal => ({ op: 'delete', entityId: A.proposal, recordId: proposal.recordId, version: proposal.version })),
    ...asks.filter(ask => doomed.has(ask.recordId)).map(ask => ({ op: 'delete', entityId: A.ask, recordId: ask.recordId, version: ask.version })),
  ];
}

/** The quick asks the panel offers for what is open and selected: each a request and its mode. */
export function quickAsks(model, { viewId = null, selected = [], issues = 0, empty = false } = {}) {
  const view = viewId ? model.records.get(viewId) : null;
  const elements = selected.map(id => model.records.get(id)).filter(record => record?.entityId === E.concept && record.values['ar.concept.category'] === 'Element');
  const asks = [];
  if (empty) asks.push({ id: 'model-from', label: 'Model from a description…', mode: 'Propose', draft: 'Build a first model of ' });
  if (view) {
    const name = quoted(label(model, view));
    asks.push({ id: 'explain-view', label: 'Explain this view', mode: 'Answer',
      request: `Explain the view ${name} to someone new to it: what it shows, how its parts depend on each other, and anything that looks wrong or missing.` });
    asks.push({ id: 'review-view', label: 'Review this view', mode: 'Propose',
      request: `Review the view ${name} against ArchiMate and its viewpoint: relationship types that should be others, elements in the wrong layer, unclear names, relationships the model has between elements on it that the view does not show. Propose the fixes, and say in the summary what you found.` });
    asks.push({ id: 'complete-view', label: 'Complete this view', mode: 'Propose',
      request: `Complete the view ${name}: add the elements and relationships that belong on it to tell its story, reusing the model's own concepts where they exist. Place the new boxes beside the ones there.` });
  }
  if (elements.length > 0) {
    const what = elements.length === 1 ? quoted(label(model, elements[0])) : `the ${elements.length} selected elements`;
    asks.push({ id: 'document', label: elements.length === 1 ? 'Document it' : 'Document them', mode: 'Propose',
      request: `Write ArchiMate documentation for ${what}: one or two plain sentences each saying what it is and why it matters here. Keep any documentation already there unless it is wrong.` });
    asks.push({ id: 'relate', label: 'Suggest relationships', mode: 'Propose',
      request: `Suggest the relationships ${what} should have with the rest of the model, of the types ArchiMate allows, and show them on ${view ? 'the open view' : 'a new view'}.` });
    asks.push({ id: 'view-around', label: 'Draft a view around them', mode: 'Propose',
      request: `Draft a new view around ${what}, with what they depend on and what depends on them, under a fitting viewpoint. Leave the boxes without places so Archi lays them out.` });
  }
  if (issues > 0) {
    asks.push({ id: 'fix-issues', label: `Fix the validator’s ${issues} ${issues === 1 ? 'finding' : 'findings'}`, mode: 'Propose', issues: true,
      request: 'Propose fixes for the validator\'s findings attached: for each, change the model so it is no longer found, or say in the summary why it should stay.' });
  }
  asks.push({ id: 'draft-view', label: 'Draft a view…', mode: 'Propose', draft: 'Draft a new view showing ' });
  asks.push({ id: 'gaps', label: 'What is missing?', mode: 'Answer',
    request: 'Look over the whole model and say what an architect would expect to find that is missing or inconsistent: unrealised services, applications serving nothing, elements on no view, layers that do not connect.' });
  return asks;
}
