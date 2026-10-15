// What Clay reads into a line a person types, and the canonical operations that grow a
// shelf to hold it. Nothing here touches Nendo: clay.mjs sends what these functions build,
// and tools/clay/shape.test.mjs holds them to their word.

export const RATING_MAX = 5;
const CHOICE_TONES = ['teal', 'blue', 'violet', 'amber', 'green', 'orange', 'red', 'grey'];

/** The kinds a person can pick for a new detail, in the order the picker lists them. */
export const KINDS = [
  { id: 'text', label: 'Text' },
  { id: 'longText', label: 'Long text' },
  { id: 'integer', label: 'Whole number' },
  { id: 'decimal', label: 'Number with decimals' },
  { id: 'date', label: 'Date' },
  { id: 'boolean', label: 'Yes or no' },
  { id: 'rating', label: 'Rating (1 to 5 stars)' },
  { id: 'choice', label: 'Choice' },
  { id: 'reference', label: 'Link to a shelf' },
];

/** A readable identifier part: "First published" becomes "firstPublished". */
export function camel(text) {
  const words = String(text).toLowerCase().replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
  if (!words.length) return 'detail';
  const joined = words.map((word, index) => index ? word[0].toUpperCase() + word.slice(1) : word).join('').slice(0, 32);
  return /^[0-9]/.test(joined) ? 'n' + joined : joined;
}

/** base, or base2, base3 … whichever the file does not use yet. */
export function uniqueId(base, taken) {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(base + n)) return base + n;
}

/** "Label: value" split at its first colon, or null when there is no label. */
export function parseDetail(line) {
  const text = String(line ?? '');
  const colon = text.indexOf(':');
  if (colon <= 0) return null;
  const label = text.slice(0, colon).trim().replace(/\s+/g, ' ');
  if (!label || label.length > 60) return null;
  return { label, raw: text.slice(colon + 1).trim() };
}

const pad = n => String(n).padStart(2, '0');
export function todayIso(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
function validDate(y, m, d) {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
}
/** An ISO date, a day-first date (15/10/2026, 15.10.2026), or "today"; else null. */
export function parseDate(raw, today = todayIso()) {
  const text = String(raw).trim().toLowerCase();
  if (text === 'today') return today;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (match) return validDate(+match[1], +match[2], +match[3]);
  match = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(text);
  if (match) return validDate(+match[3], +match[2], +match[1]);
  return null;
}
export function parseBoolean(raw) {
  const text = String(raw).trim().toLowerCase();
  if (['yes', 'true', 'y', '✓', '✔'].includes(text)) return true;
  if (['no', 'false', 'n', '✗', '✘'].includes(text)) return false;
  return null;
}
/** ★★★ or *** or 3/5 or "3 stars": 1 to 5, else null. */
export function parseRating(raw, { bare = false } = {}) {
  const text = String(raw).trim().toLowerCase();
  let n = null;
  if (/^[★☆]+$/.test(text)) n = [...text].filter(c => c === '★').length;
  else if (/^\*{1,5}$/.test(text)) n = text.length;
  else {
    const match = /^([0-5])\s*(?:\/\s*5|stars?|★)$/.exec(text) ?? (bare ? /^([0-5])$/.exec(text) : null);
    if (match) n = +match[1];
  }
  return n !== null && n >= 1 && n <= RATING_MAX ? n : null;
}
export function parseInteger(raw) {
  const text = String(raw).trim().replace(/^\+/, '');
  if (!/^-?\d{1,18}$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : { $nendoNumber: text };
}
/** 12.5, 12,5 or €12.50 as an exact decimal; a whole number is not a decimal here. */
export function parseDecimal(raw, { allowWhole = false } = {}) {
  const text = String(raw).trim().replace(/^[$€£]\s*/, '');
  const match = /^([-+]?\d{1,15})(?:[.,](\d{1,10}))?$/.exec(text);
  if (!match || (!match[2] && !allowWhole)) return null;
  return { $nendoNumber: match[1].replace(/^\+/, '') + (match[2] ? '.' + match[2] : '') };
}
/** Choice options as a person lists them: "Reading, Finished | Wishlist". At most 12, each 40 characters. */
export function parseOptions(text) {
  return [...new Set(String(text ?? '').split(/[|,]/).map(part => part.trim().replace(/\s+/g, ' ')).filter(Boolean))]
    .filter(option => option.length <= 40).slice(0, 12);
}

/**
 * Reads the rows of the field form: [{ label, kind, options }] where kind is a KINDS id or
 * ref:<entityId>. Answers { ok: true, fields } with each { label, kind, options, target }, or
 * { ok: false, message }. Rows without a label are skipped; existing names are refused.
 */
export function readFieldRows(rows, existingNames = []) {
  const seen = new Set(existingNames.map(name => name.toLowerCase()));
  const fields = [];
  for (const row of rows) {
    const label = String(row.label ?? '').trim().replace(/\s+/g, ' ');
    if (!label) continue;
    if (label.length > 60) return { ok: false, message: `"${label.slice(0, 20)}…" is longer than 60 characters.` };
    if (seen.has(label.toLowerCase())) return { ok: false, message: `There is already a field called ${label}.` };
    seen.add(label.toLowerCase());
    const [kind, target] = String(row.kind ?? 'text').startsWith('ref:') ? ['reference', row.kind.slice(4)] : [row.kind ?? 'text', null];
    const options = kind === 'choice' ? parseOptions(row.options) : [];
    if (kind === 'choice' && options.length < 2) return { ok: false, message: `${label} is a choice: list at least two options, such as Reading, Finished, Wishlist.` };
    fields.push({ label, kind, options, target });
  }
  return { ok: true, fields };
}

function parseChoices(raw) {
  if (!raw.includes('|')) return null;
  const options = [...new Set(raw.split('|').map(part => part.trim().replace(/\s+/g, ' ')).filter(Boolean))];
  return options.length >= 2 && options.length <= 12 && options.every(o => o.length <= 40) ? options : null;
}

/**
 * A shelf as Clay reads it: { entityId, displayName, nameFieldId, records: [{recordId, name}] }.
 * The record named exactly raw, ignoring case, on any shelf, or null.
 */
export function findNamed(raw, shelves) {
  const wanted = String(raw).trim().toLowerCase();
  if (!wanted) return null;
  for (const shelf of shelves) {
    const record = shelf.records?.find(r => String(r.name ?? '').trim().toLowerCase() === wanted);
    if (record) return { shelf, record };
  }
  return null;
}

/**
 * Guesses the kind a new detail should have from the first value typed for it. Answers
 * { kind, value, options?, target?, says } where says is how Clay names the guess.
 */
export function inferKind(raw, { shelves = [], today } = {}) {
  const text = String(raw ?? '').trim();
  if (!text) return { kind: 'text', value: null, says: 'text' };
  const choices = parseChoices(text);
  if (choices) return { kind: 'choice', value: choices[0], options: choices, says: `a choice of ${listed(choices)}` };
  const yes = parseBoolean(text);
  if (yes !== null) return { kind: 'boolean', value: yes, says: 'yes or no' };
  const stars = parseRating(text);
  if (stars !== null) return { kind: 'rating', value: stars, says: 'a rating out of 5' };
  const whole = parseInteger(text);
  if (whole !== null) return { kind: 'integer', value: whole, says: 'a whole number' };
  const decimal = parseDecimal(text);
  if (decimal !== null) return { kind: 'decimal', value: decimal, says: 'a number' };
  const date = parseDate(text, today);
  if (date !== null) return { kind: 'date', value: date, says: 'a date' };
  const named = findNamed(text, shelves);
  if (named) return { kind: 'reference', value: named.record.recordId, target: named.shelf.entityId, says: `a link to ${named.shelf.displayName}` };
  if (text.length > 80 || text.includes('\n')) return { kind: 'longText', value: text, says: 'long text' };
  return { kind: 'text', value: text, says: 'text' };
}

function listed(items) {
  return items.length <= 1 ? items.join('') : items.slice(0, -1).join(', ') + ' or ' + items.at(-1);
}

/** The kind Clay shows for a field the file already has. */
export function kindOf(field) {
  if (field.calculated) return 'calculated';
  const storage = String(field.storageKind ?? '').toLowerCase();
  if (storage === 'reference') return 'reference';
  if (storage === 'boolean') return 'boolean';
  if (storage === 'date' || storage === 'datetime') return 'date';
  if (storage === 'decimal') return 'decimal';
  if (storage === 'integer') return field.presentation === 'rating' ? 'rating' : 'integer';
  if (field.presentation === 'singleChoice') return 'choice';
  if (field.presentation === 'longText' || field.presentation === 'markdown') return 'longText';
  return 'text';
}

/**
 * Reads raw as a value for a field the shelf already has: { ok: true, value } or
 * { ok: false, message }. An empty raw clears the field unless it is required.
 */
export function coerce(raw, field, { shelves = [], today } = {}) {
  const text = String(raw ?? '').trim();
  const name = field.displayName;
  const kind = kindOf(field);
  if (kind === 'calculated') return { ok: false, message: `${name} is worked out by the file, so it cannot be typed.` };
  if (!text) return field.required ? { ok: false, message: `${name} cannot be empty.` } : { ok: true, value: null };
  const fail = what => ({ ok: false, message: `${name} holds ${what}.` });
  switch (kind) {
    case 'boolean': { const v = parseBoolean(text); return v === null ? fail('yes or no') : { ok: true, value: v }; }
    case 'rating': { const v = parseRating(text, { bare: true }); return v === null ? fail('a rating from 1 to 5') : { ok: true, value: v }; }
    case 'integer': { const v = parseInteger(text); return v === null ? fail('a whole number') : { ok: true, value: v }; }
    case 'decimal': { const v = parseDecimal(text, { allowWhole: true }); return v === null ? fail('a number') : { ok: true, value: v }; }
    case 'date': {
      const v = parseDate(text, today);
      if (v === null) return fail('a date, such as 2026-10-15 or 15/10/2026');
      return { ok: true, value: String(field.storageKind).toLowerCase() === 'datetime' ? `${v}T00:00:00Z` : v };
    }
    case 'choice': {
      const choice = (field.choices ?? []).find(c => !c.retired && (c.displayName.toLowerCase() === text.toLowerCase() || c.id.toLowerCase() === text.toLowerCase()));
      return choice ? { ok: true, value: choice.id } : fail(listed((field.choices ?? []).filter(c => !c.retired).map(c => c.displayName)) || 'a choice');
    }
    case 'reference': {
      const target = shelves.find(s => s.entityId === field.reference?.targetEntityId);
      const record = target?.records?.find(r => String(r.name ?? '').trim().toLowerCase() === text.toLowerCase());
      if (!record) return { ok: false, message: `${target?.displayName ?? 'That shelf'} has nothing named "${text}".` };
      return { ok: true, value: record.recordId };
    }
    default: return { ok: true, value: text };
  }
}

/** The operations that make a new shelf: a record type with a required Name. */
export function shelfOperations(displayName, taken) {
  const entityId = uniqueId('clay.' + camel(displayName), taken);
  const nameFieldId = entityId + '.name';
  return {
    entityId, nameFieldId,
    operations: [
      { operationType: 'schema.createEntity', payload: { entityId, displayName } },
      { operationType: 'schema.addField', payload: { entityId, fieldId: nameFieldId, displayName: 'Name', storageKind: 'text', required: true, presentation: 'singleLine', options: [] } },
    ],
  };
}

/**
 * The operations that grow a shelf by one detail of the kind given. guess carries options for
 * a choice and target (with its name field) for a link.
 */
export function detailOperations({ entityId, label, kind, options = [], target = null, targetNameFieldId = null, colours = true }, taken) {
  const fieldId = uniqueId(entityId + '.' + camel(label), taken);
  const base = { entityId, fieldId, displayName: label, required: false, options: [] };
  const add = {
    text: { storageKind: 'text', presentation: 'singleLine' },
    longText: { storageKind: 'text', presentation: 'longText' },
    integer: { storageKind: 'integer', presentation: null },
    decimal: { storageKind: 'decimal', presentation: null },
    date: { storageKind: 'date', presentation: 'date' },
    boolean: { storageKind: 'boolean', presentation: null },
    rating: { storageKind: 'integer', presentation: 'rating', min: 1, max: RATING_MAX },
    choice: { storageKind: 'text', presentation: 'singleChoice', options },
    reference: { storageKind: 'reference', presentation: null },
  }[kind];
  if (!add) throw Error(`Clay cannot grow a detail of kind ${kind}.`);
  if (kind === 'choice' && options.length < 2) throw Error('A choice needs at least two options, written as A | B.');
  if (kind === 'reference' && (!target || !targetNameFieldId)) throw Error('A link needs the shelf it points at.');
  const operations = [{ operationType: 'schema.addField', payload: { ...base, ...add } }];
  if (kind === 'choice' && colours) options.forEach((option, index) => operations.push({ operationType: 'schema.setChoiceMetadata',
    payload: { entityId, fieldId, choiceId: option, displayName: option, retired: false, tone: CHOICE_TONES[index % CHOICE_TONES.length] } }));
  if (kind === 'reference') operations.push({ operationType: 'schema.configureReference',
    payload: { entityId, fieldId, targetEntityId: target, labelFieldId: targetNameFieldId } });
  return { fieldId, operations };
}

/** Converts a typed value to the kind a person picked over Clay's guess, or says why it cannot. */
export function valueForKind(raw, kind, { shelves = [], today, target = null } = {}) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: true, value: null };
  const field = { displayName: 'It', required: false, storageKind: { integer: 'integer', rating: 'integer', decimal: 'decimal', date: 'date', boolean: 'boolean', reference: 'reference' }[kind] ?? 'text',
    presentation: { rating: 'rating', longText: 'longText', choice: 'singleChoice' }[kind] ?? null,
    choices: kind === 'choice' ? (parseChoices(text) ?? [text]).map(o => ({ id: o, displayName: o, retired: false })) : [],
    reference: kind === 'reference' ? { targetEntityId: target } : null };
  if (kind === 'choice') return { ok: true, value: field.choices[0].id };
  return coerce(text, field, { shelves, today });
}

/** How a stored value reads on a card. */
export function display(field, record) {
  const value = record.values?.[field.fieldId];
  if (value === null || value === undefined || value === '') return null;
  switch (kindOf(field)) {
    case 'boolean': return value ? 'Yes' : 'No';
    case 'rating': return '★'.repeat(Math.max(0, Math.min(RATING_MAX, value))) + '☆'.repeat(Math.max(0, RATING_MAX - value));
    case 'choice': return field.choices?.find(c => c.id === value)?.displayName ?? String(value);
    case 'reference': return record.labels?.[field.fieldId] ?? String(value);
    case 'decimal': case 'integer': return record.exact?.[field.fieldId] ?? String(value);
    case 'date': return String(value).slice(0, 10);
    case 'calculated': return record.calculated?.[field.fieldId]?.state === 'value' ? String(record.calculated[field.fieldId].value) : null;
    default: return String(value);
  }
}

/** What a person would type to get the stored value back, for editing a detail in place. */
export function typed(field, record) {
  const shown = display(field, record);
  if (shown === null) return '';
  if (kindOf(field) === 'rating') return '★'.repeat(record.values[field.fieldId]);
  return shown;
}

/** The field that names a shelf's records: Clay's own Name, else the first required text, else the first text. */
export function nameFieldOf(entity) {
  const texts = entity.fields.filter(f => !f.calculated && kindOf(f) === 'text');
  return entity.fields.find(f => f.fieldId === entity.entityId + '.name')
    ?? texts.find(f => f.required) ?? texts[0] ?? null;
}
