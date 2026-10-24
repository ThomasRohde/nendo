// Ask kit: the parts of an app that asks the person's launched agent for work and gets it
// back as records. It knows nothing of any one app: the app names its record types and
// fields, and draws what the kit hands back.
//
// - createAsker: every request is an Ask record written before the agent is asked, so a
//   reload, a refusal or a closed frame never loses it; the agent updates that record.
// - selectionText and selectionChip: what is selected, as text for the agent and a chip.
// - applyWrites: a variant's writes applied to a copy of the records in memory, with what
//   they change, so a view can draw the result before anything is written.
// - prepareBatch: the same writes made ready for nendo.records.batch against the records
//   as they stand now, or refused with the reason when they no longer fit.
// - variantStrip: the picker for up to three variants.
// - refusalText: the assistant refusals in plain words.

export const REFUSALS = {
  'assistant-off': 'Views may not message the agent on this computer. Change it on Nendo’s Agent page.',
  'assistant-declined': 'Not sent: you said Not now. Send it again in a moment.',
  'assistant-busy': 'The agent has too many messages waiting. Send it again when it has answered one.',
  'assistant-unavailable': 'No agent can answer now.',
};

/** The refusal in plain words, with Nendo's own reason where it gives one. */
export function refusalText(error) {
  const code = error?.code;
  if (code === 'assistant-unavailable' && error.message) return `${REFUSALS[code]} ${error.message}`;
  return REFUSALS[code] ?? (error?.message || String(error));
}
export const isRefusal = error => Object.hasOwn(REFUSALS, error?.code ?? '');

const nowIso = () => new Date().toISOString();

/**
 * fields names the Ask record's fields: { subject, scope, request, selection, state,
 * progress, reply, asked, finished }. words names the choice values: { whole, selection,
 * waiting, working, cancelled }. message(ask, request) is the text the agent gets, and
 * context(subject, items) the context items.
 */
export function createAsker(nendo, { entityId, fields, words, message, context }) {
  const pending = new Map();
  const has = () => nendo.has('assistant.ask');

  async function write(subject, request, items) {
    return nendo.records.create(entityId, {
      [fields.subject]: subject.recordId,
      [fields.scope]: items.length ? words.selection : words.whole,
      [fields.request]: request,
      [fields.selection]: items.length ? selectionText(items) : null,
      [fields.state]: words.waiting,
      [fields.asked]: nowIso(),
    }, { targetVersions: { [fields.subject]: subject.version } });
  }

  /** Asks the agent about an Ask already written. Answers {reply, stopReason} or throws. */
  async function ask(askRecord, subject, items = []) {
    if (!has()) throw Object.assign(new Error('No agent can be asked from here.'), { code: 'assistant-unavailable' });
    const request = String(askRecord.values[fields.request] ?? '');
    const turn = nendo.assistant.ask(message(askRecord, request), { context: context(subject, items, askRecord) });
    pending.set(askRecord.recordId, turn);
    try { return await turn; } finally { pending.delete(askRecord.recordId); }
  }

  /** Writes the Ask, then asks. Answers {askRecord, turn}: turn is null without an agent. */
  async function send(subject, request, items = []) {
    const askRecord = await write(subject, request, items);
    return { askRecord, turn: has() ? ask(askRecord, subject, items) : null };
  }

  /** Stops this frame's turn and marks the Ask Cancelled, unless it already finished. */
  async function stop(askRecord, finishedStates = []) {
    try { await nendo.assistant.cancel(); } catch { /* No turn of ours runs. */ }
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await nendo.records.get(entityId, askRecord.recordId);
      if (!current || finishedStates.includes(current.values[fields.state])) return current;
      const note = [current.values[fields.progress], 'Stopped by the person.'].filter(Boolean).join('\n');
      try {
        return await nendo.records.update(current, { [fields.state]: words.cancelled, [fields.progress]: note, [fields.finished]: nowIso() });
      } catch (error) { if (error.code !== 'record-version-conflict') throw error; }
    }
    return null;
  }

  return { send, ask, stop, write, has, isPending: id => pending.has(id) };
}

/** items: [{kind, id, label}] as lines the agent reads: `node <id> «label»`. */
export function selectionText(items) {
  return items.map(item => `${item.kind} ${item.id} «${String(item.label ?? '').replace(/[«»\n]/g, ' ').slice(0, 120)}»`).join('\n');
}
/** The record IDs a selection text names. */
export function selectionIds(text) {
  return String(text ?? '').split('\n').map(line => line.split(' ')[1]).filter(Boolean);
}

/** A chip saying how many are selected, with a clear button. Hidden at zero. */
export function selectionChip(chip, count, onClear) {
  chip.hidden = count === 0;
  chip.replaceChildren();
  if (count === 0) return;
  const label = document.createElement('span');
  label.textContent = `${count} selected`;
  const clear = document.createElement('button');
  clear.type = 'button'; clear.className = 'chip-clear'; clear.textContent = '×';
  clear.title = 'Clear the selection'; clear.setAttribute('aria-label', 'Clear the selection');
  clear.onclick = onClear;
  chip.append(label, clear);
}

/** Parses a variant's writes, answering [] with an error rather than throwing. */
export function parseWrites(text) {
  try {
    const value = JSON.parse(String(text ?? ''));
    const writes = Array.isArray(value) ? value : Array.isArray(value?.writes) ? value.writes : null;
    if (!writes) return { writes: [], error: 'Operations is not a list of writes.' };
    for (const write of writes) {
      if (!['create', 'update', 'delete'].includes(write?.op) || typeof write.entityId !== 'string')
        return { writes: [], error: 'A write has no op or entityId.' };
      if (write.op !== 'create' && typeof write.recordId !== 'string') return { writes: [], error: `An ${write.op} names no record.` };
    }
    return { writes, error: null };
  } catch (error) { return { writes: [], error: `Operations is not JSON: ${error.message}` }; }
}

export const keyOf = (entityId, recordId) => `${entityId}/${recordId}`;
const isTemporary = id => typeof id === 'string' && id.startsWith('$');

/**
 * Applies writes to a copy of records (a Map of key to {entityId, recordId, values}).
 * Temporary IDs stay as they are. Answers {records, created, updated, deleted, problems}.
 * fill(entityId, values) may add values a create leaves out, such as the board.
 */
export function applyWrites(records, writes, fill = (_, values) => values) {
  const next = new Map([...records].map(([key, record]) => [key, { ...record, values: { ...record.values } }]));
  const created = new Set(), updated = new Set(), deleted = new Set(), problems = [];
  let serial = 0;
  for (const write of writes) {
    if (write.op === 'create') {
      const id = write.recordId ?? `$auto${++serial}`;
      const key = keyOf(write.entityId, id);
      next.set(key, { entityId: write.entityId, recordId: id, version: 0, values: fill(write.entityId, { ...(write.values ?? {}) }) });
      created.add(key);
      continue;
    }
    const key = keyOf(write.entityId, write.recordId);
    const record = next.get(key);
    if (!record) { problems.push(`${write.op} of ${key}, which is not there`); continue; }
    if (write.op === 'update') { Object.assign(record.values, write.values ?? {}); if (!created.has(key)) updated.add(key); }
    else { next.delete(key); created.delete(key); updated.delete(key); deleted.add(key); }
  }
  return { records: next, created, updated, deleted, problems };
}

/**
 * The writes ready for nendo.records.batch against current (a Map of key to record with
 * version): temporary IDs given real ones by newId(entityId), versions filled in, creates
 * first, then updates, then deletes. A reference carries its target's version unless the
 * target is created or updated earlier in the batch, which is the only case Nendo resolves
 * itself. references(entityId) answers {fieldId: targetEntityId}. Throws with a plain reason
 * when a write names a record that has gone.
 */
export function prepareBatch(writes, current, { newId, references, fill = (_, values) => values }) {
  const ids = new Map();
  const real = id => (isTemporary(id) ? ids.get(id) ?? id : id);
  const order = { create: 0, update: 1, delete: 2 };
  const entries = writes.map(write => {
    let id = write.recordId;
    if (write.op === 'create') {
      id = write.recordId && !isTemporary(write.recordId) ? write.recordId : newId(write.entityId);
      if (write.recordId) ids.set(write.recordId, id);
    }
    return { write, id };
  }).sort((a, b) => order[a.write.op] - order[b.write.op]);
  const earlier = new Set();
  const out = [];
  for (const { write, id } of entries) {
    const key = keyOf(write.entityId, id);
    if (write.op === 'delete') {
      const record = current.get(key);
      if (!record) throw new Error(`It deletes a record that is no longer there (${write.entityId} ${id}).`);
      out.push({ op: 'delete', entityId: write.entityId, recordId: id, version: record.version });
      earlier.add(key);
      continue;
    }
    const values = write.op === 'create' ? fill(write.entityId, { ...(write.values ?? {}) }) : { ...(write.values ?? {}) };
    const targetVersions = {};
    for (const [fieldId, targetEntityId] of Object.entries(references(write.entityId))) {
      if (!(fieldId in values) || values[fieldId] === null) continue;
      values[fieldId] = real(values[fieldId]);
      if (isTemporary(values[fieldId])) throw new Error(`It points at ${values[fieldId]}, which it never creates.`);
      const targetKey = keyOf(targetEntityId, values[fieldId]);
      if (earlier.has(targetKey)) continue;
      const target = current.get(targetKey);
      if (!target) throw new Error(`It points at a record that is no longer there (${targetEntityId} ${values[fieldId]}).`);
      targetVersions[fieldId] = target.version;
    }
    const extra = Object.keys(targetVersions).length ? { targetVersions } : {};
    if (write.op === 'create') out.push({ op: 'create', entityId: write.entityId, recordId: id, values, ...extra });
    else {
      const record = current.get(key);
      if (!record) throw new Error(`It changes a record that is no longer there (${write.entityId} ${id}).`);
      out.push({ op: 'update', entityId: write.entityId, recordId: id, version: record.version, values, ...extra });
    }
    earlier.add(key);
  }
  return out;
}

/**
 * The variant picker. variants: [{id, title, summary, note}]. preview(variant, host) draws
 * the small picture into host. hover(variant | null), use(variant) and none() are the
 * person's choices.
 */
export function variantStrip(strip, { heading, variants, preview, hover, use, none, busy = false }) {
  strip.hidden = variants.length === 0;
  strip.replaceChildren();
  if (variants.length === 0) return;
  const head = document.createElement('div');
  head.className = 'variants-head';
  const title = document.createElement('strong');
  title.textContent = heading;
  const reject = document.createElement('button');
  reject.type = 'button'; reject.textContent = 'None'; reject.disabled = busy;
  reject.title = 'Reject every variant';
  reject.onclick = none;
  head.append(title, reject);
  const row = document.createElement('div');
  row.className = 'variants-row';
  for (const variant of variants) {
    const card = document.createElement('article');
    card.className = 'variant';
    card.tabIndex = 0;
    const host = document.createElement('div');
    host.className = 'variant-preview';
    const name = document.createElement('h3');
    name.textContent = variant.title;
    const summary = document.createElement('p');
    summary.textContent = variant.summary || '';
    const foot = document.createElement('div');
    foot.className = 'variant-foot';
    const note = document.createElement('span');
    note.className = 'muted';
    note.textContent = variant.note || '';
    const apply = document.createElement('button');
    apply.type = 'button'; apply.className = 'primary'; apply.textContent = 'Use this';
    apply.disabled = busy || Boolean(variant.error);
    if (variant.error) apply.title = variant.error;
    apply.onclick = () => use(variant);
    foot.append(note, apply);
    card.append(host, name, summary, foot);
    card.addEventListener('pointerenter', () => hover(variant));
    card.addEventListener('pointerleave', () => hover(null));
    card.addEventListener('focus', () => hover(variant));
    card.addEventListener('blur', () => hover(null));
    row.append(card);
    preview(variant, host);
  }
  strip.append(head, row);
}
