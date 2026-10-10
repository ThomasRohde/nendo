import { escapeAttribute, escapeHtml } from './format';
import { icon, type IconName } from './icons';

/**
 * Pointing a launched agent at the file's own things with @ (W-200, the owner's design A with
 * D's menu, 2026-10-09). The owner's first try at "Add more books!" stalled because the agent
 * did not know the record type's ID or its fields; what the person points at travels with the
 * message, with its IDs and the nendo:// address that reads more, so the agent can act at once.
 *
 * Built to stay cheap on a large file. The menu matches names the Workbench already holds
 * (record types, fields, views, what the other tabs show, proposals waiting), capped per group;
 * records come from the file's search index a few at a time, never from a scan. A description
 * is written only for what the person chooses, and is bounded.
 */

export type ContextKind = 'type' | 'field' | 'view' | 'record' | 'proposal';

/** A field as a description needs it. */
export interface ContextField {
  fieldId: string;
  name: string;
  kind: string;
  required: boolean;
  choices: Array<{ id: string; name: string }>;
  scale: { min: number; max: number } | null;
  referenceTo: string | null;
}

export interface ContextEntity {
  entityId: string;
  name: string;
  recordCount: number | null;
  fields: ContextField[];
}

export interface ContextView { viewId: string; title: string; kind: string; entityId: string | null }

export interface ContextProposal { proposalId: string; title: string; operationCount: number }

/** What another tab shows: a record type, one of the file's views, a record, or a proposal. */
export interface ContextPlace { label: string; entityId: string | null; viewId: string | null; recordId: string | null; proposalId: string | null }

/** Everything the menu offers without asking the host. Schema-sized, never record-sized. */
export interface ContextSource {
  fileName: string;
  entities: ContextEntity[];
  views: ContextView[];
  proposals: ContextProposal[];
  places: ContextPlace[];
}

/** A record the search index found. */
export interface ContextRecordHit { entityId: string; recordId: string; label: string | null }

/** One line of the menu. Its description is written when it is chosen, not before. */
export interface ContextChoice {
  key: string;
  kind: ContextKind;
  group: string;
  label: string;
  detail: string;
  uri: string;
  entityId: string | null;
  fieldId: string | null;
  viewId: string | null;
  recordId: string | null;
  proposalId: string | null;
}

/** What goes to the host: the address, the name, and the description. */
export interface ContextAttachment { key: string; kind: ContextKind; label: string; uri: string; text: string }

export const groupOrder = ['Open in your tabs', 'Record types', 'Fields', 'Views', 'Records', 'Waiting for you'] as const;
const perGroup: Record<string, number> = { 'Open in your tabs': 3, 'Record types': 6, Fields: 6, Views: 5, Records: 6, 'Waiting for you': 4 };
const maximumFieldsDescribed = 60;
const maximumValueCharacters = 300;
export const maximumDescriptionCharacters = 6_000;
export const maximumAttachments = 8;
/** The host's bounds on what one message points at (AgentConversation.Context.cs): all descriptions together, and each name. */
export const maximumContextCharacters = 32_000;
export const maximumLabelCharacters = 120;
/** A description cut shorter than this says too little to be worth sending. */
const minimumDescriptionCharacters = 400;
const readMorePrefix = '\n\nRead more through Nendo: ';

export function entityUri(entityId: string): string {
  return `nendo://application/entity/${encodeURIComponent(entityId)}`;
}

export function recordUri(entityId: string, recordId: string): string {
  return `${entityUri(entityId)}/records?recordId=${encodeURIComponent(recordId)}`;
}

/**
 * The @ being typed at the caret, if any: an @ at the start or after a space, then up to 40
 * characters with no line break. Null when the caret is not in one.
 */
export function mentionAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1]!)) return null;
  const query = before.slice(at + 1);
  if (query.length > 40 || /[\r\n]/.test(query) || /\s{2}/.test(query)) return null;
  return { start: at, query };
}

let folds = 0;

function fold(text: string): string {
  folds += 1;
  return text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

/** How many names and queries have been folded so far: a keystroke folds its query, not the file's names. */
export function foldsSoFar(): number {
  return folds;
}

/**
 * Names folded once, not on every keystroke: a large file has a hundred thousand field names,
 * and folding each again per letter typed was a tenth of a second a key.
 */
const foldedNames = new Map<string, string>();

function folded(name: string): string {
  let value = foldedNames.get(name);
  if (value === undefined) {
    if (foldedNames.size > 250_000) foldedNames.clear();
    value = fold(name);
    foldedNames.set(name, value);
  }
  return value;
}

/** 0 when the name starts with the query, 1 when a word in it does, 2 when it only contains it, -1 when it does not match. */
function rank(name: string, wanted: string): number {
  if (wanted === '') return 0;
  const text = folded(name);
  // The cheap test first: most names do not contain the query at all.
  const at = text.indexOf(wanted);
  if (at < 0) return -1;
  if (at === 0) return 0;
  return /[^\p{L}\p{N}]/u.test(text[at - 1]!) || text.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(wanted)) ? 1 : 2;
}

function choice(fields: Partial<ContextChoice> & Pick<ContextChoice, 'key' | 'kind' | 'group' | 'label' | 'detail' | 'uri'>): ContextChoice {
  return { entityId: null, fieldId: null, viewId: null, recordId: null, proposalId: null, ...fields };
}

/**
 * The first `limit` items by rank, keeping the file's order within a rank. One pass, stopping
 * once the best rank is full, so a long list costs one cheap test per name.
 */
function best<T>(items: readonly T[], name: (item: T) => string, query: string, limit: number): T[] {
  const wanted = query === '' ? '' : fold(query.trim());
  const ranks: T[][] = [[], [], []];
  for (const item of items) {
    const at = rank(name(item), wanted);
    if (at < 0 || ranks[at]!.length >= limit) continue;
    ranks[at]!.push(item);
    if (ranks[0]!.length >= limit) break;
  }
  return ranks.flat().slice(0, limit);
}

/**
 * The menu for a query, group by group in a fixed order. With no query it offers what the other
 * tabs show, the record types, the views and the proposals waiting; fields and records need a
 * word typed, since a large file has thousands. `records` are the search index's hits for the
 * query, or null while none are known.
 */
export function contextChoices(source: ContextSource, query: string, records: readonly ContextRecordHit[] | null): ContextChoice[] {
  const entityName = new Map(source.entities.map((entity) => [entity.entityId, entity.name]));
  const choices: ContextChoice[] = [];
  const typed = query.trim();

  for (const place of best(source.places, (candidate) => candidate.label, typed, perGroup['Open in your tabs']!)) {
    const group = 'Open in your tabs';
    if (place.proposalId !== null) {
      const proposal = source.proposals.find((candidate) => candidate.proposalId === place.proposalId);
      if (proposal !== undefined) choices.push(proposalChoice(proposal, group, `screen:proposal:${proposal.proposalId}`));
    } else if (place.recordId !== null && place.entityId !== null) {
      choices.push(choice({ key: `screen:record:${place.entityId}:${place.recordId}`, kind: 'record', group, label: place.label,
        detail: `Record open in a tab · ${entityName.get(place.entityId) ?? place.entityId}`, uri: recordUri(place.entityId, place.recordId),
        entityId: place.entityId, recordId: place.recordId }));
    } else if (place.viewId !== null) {
      const view = source.views.find((candidate) => candidate.viewId === place.viewId);
      if (view !== undefined) choices.push(viewChoice(view, entityName, group, `screen:view:${view.viewId}`));
    } else if (place.entityId !== null && entityName.has(place.entityId)) {
      choices.push(choice({ key: `screen:type:${place.entityId}`, kind: 'type', group, label: place.label,
        detail: 'Open in a tab', uri: entityUri(place.entityId), entityId: place.entityId }));
    }
  }

  for (const entity of best(source.entities, (candidate) => candidate.name, typed, perGroup['Record types']!)) {
    choices.push(choice({ key: `type:${entity.entityId}`, kind: 'type', group: 'Record types', label: entity.name,
      detail: [`${entity.fields.length} field${entity.fields.length === 1 ? '' : 's'}`, entity.recordCount === null ? null : `${entity.recordCount} record${entity.recordCount === 1 ? '' : 's'}`].filter(Boolean).join(' · '),
      uri: entityUri(entity.entityId), entityId: entity.entityId }));
  }

  if (typed !== '') {
    const fields = fieldsOf(source.entities);
    for (const { entity, field } of best(fields, (candidate) => candidate.field.name, typed, perGroup.Fields!)) {
      choices.push(choice({ key: `field:${entity.entityId}:${field.fieldId}`, kind: 'field', group: 'Fields', label: `${entity.name} › ${field.name}`,
        detail: field.kind, uri: entityUri(entity.entityId), entityId: entity.entityId, fieldId: field.fieldId }));
    }
  }

  for (const view of best(source.views, (candidate) => candidate.title, typed, perGroup.Views!)) {
    choices.push(viewChoice(view, entityName, 'Views', `view:${view.viewId}`));
  }

  for (const hit of (records ?? []).slice(0, perGroup.Records!)) {
    choices.push(choice({ key: `record:${hit.entityId}:${hit.recordId}`, kind: 'record', group: 'Records', label: hit.label ?? hit.recordId,
      detail: entityName.get(hit.entityId) ?? hit.entityId, uri: recordUri(hit.entityId, hit.recordId), entityId: hit.entityId, recordId: hit.recordId }));
  }

  for (const proposal of best(source.proposals, (candidate) => candidate.title, typed, perGroup['Waiting for you']!)) {
    choices.push(proposalChoice(proposal, 'Waiting for you', `proposal:${proposal.proposalId}`));
  }
  return choices;
}

/** Every field with its record type, made once per list of record types rather than per keystroke. */
const fieldLists = new WeakMap<readonly ContextEntity[], Array<{ entity: ContextEntity; field: ContextField }>>();

function fieldsOf(entities: readonly ContextEntity[]): Array<{ entity: ContextEntity; field: ContextField }> {
  let list = fieldLists.get(entities);
  if (list === undefined) {
    list = entities.flatMap((entity) => entity.fields.map((field) => ({ entity, field })));
    fieldLists.set(entities, list);
  }
  return list;
}

function viewChoice(view: ContextView, entityName: ReadonlyMap<string, string>, group: string, key: string): ContextChoice {
  return choice({ key, kind: 'view', group, label: view.title,
    detail: ['View', view.entityId === null ? null : entityName.get(view.entityId) ?? null].filter(Boolean).join(' · '),
    uri: view.entityId === null ? 'nendo://application/surfaces' : entityUri(view.entityId), entityId: view.entityId, viewId: view.viewId });
}

function proposalChoice(proposal: ContextProposal, group: string, key: string): ContextChoice {
  return choice({ key, kind: 'proposal', group, label: proposal.title,
    detail: `Proposal waiting for you · ${proposal.operationCount} change${proposal.operationCount === 1 ? '' : 's'}`,
    uri: `nendo://application/proposal/${encodeURIComponent(proposal.proposalId)}`, proposalId: proposal.proposalId });
}

const kindIcon: Record<ContextKind, IconName> = { type: 'box', field: 'structure', view: 'surfaces', record: 'data', proposal: 'studio' };

/** The menu: a listbox the message box drives by aria-activedescendant. Everything named is text. */
export function mentionMenuMarkup(choices: readonly ContextChoice[], active: number, note: string | null): string {
  const groups = groupOrder.map((group) => ({ group, items: choices.map((item, index) => ({ item, index })).filter((entry) => entry.item.group === group) }))
    .filter((entry) => entry.items.length > 0);
  const body = groups.map((entry) => `<div class="mention-group" role="group" aria-label="${escapeAttribute(entry.group)}"><div class="mention-head" aria-hidden="true">${escapeHtml(entry.group)}</div>${entry.items.map(({ item, index }) =>
    `<div class="mention-option" role="option" id="mention-option-${index}" data-choice="${index}" aria-selected="${index === active}"><span class="mention-icon">${icon(kindIcon[item.kind])}</span><span class="mention-label">${escapeHtml(item.label)}</span><span class="mention-detail">${escapeHtml(item.detail)}</span></div>`).join('')}</div>`).join('');
  const empty = choices.length === 0 ? '<div class="mention-empty">Nothing in this file has that name.</div>' : '';
  return `${body}${empty}${note === null ? '' : `<div class="mention-note">${escapeHtml(note)}</div>`}<div class="mention-keys" aria-hidden="true"><span><kbd>↑</kbd> <kbd>↓</kbd> choose</span><span><kbd>Enter</kbd> add</span><span><kbd>Esc</kbd> close</span></div>`;
}

/** The things a message points at, as chips with a way to take each back. */
export function attachmentsMarkup(attached: readonly ContextAttachment[]): string {
  return attached.map((item) => `<span class="chat-attachment" data-attachment="${escapeAttribute(item.key)}" title="${escapeAttribute(`${item.label}: ${item.text.length.toLocaleString('en-US')} of the ${maximumContextCharacters.toLocaleString('en-US')} characters a message carries`)}">${icon(kindIcon[item.kind])}<span>${escapeHtml(item.label)}</span><button type="button" data-remove-attachment="${escapeAttribute(item.key)}" aria-label="Stop pointing at ${escapeAttribute(item.label)}">${icon('close')}</button></span>`).join('');
}

function bounded(text: string, maximum: number): string {
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

/** A name as the host takes it: at most 120 characters. */
export function contextLabel(label: string): string {
  return bounded(label.trim(), maximumLabelCharacters);
}

/**
 * Fit one more description into what the message already carries (ACP-10). Eight descriptions of
 * 6,000 characters each are more than the 32,000 the host takes together, and a message the host
 * refuses cannot be sent at all. A description is cut to the room left, keeping the address that
 * reads the rest; null when too little room is left to say anything useful.
 */
export function fitDescription(text: string, attached: readonly ContextAttachment[]): string | null {
  const used = attached.reduce((sum, item) => sum + item.text.length, 0);
  const room = Math.min(maximumDescriptionCharacters, maximumContextCharacters - used);
  if (text.length <= room) return text;
  const at = text.lastIndexOf(readMorePrefix);
  const tail = at < 0 ? '' : text.slice(at);
  const keep = room - tail.length - 1;
  if (keep < minimumDescriptionCharacters) return null;
  return `${text.slice(0, keep)}…${tail}`;
}

/** The thing a message points at that says the most: the one to take back when another does not fit. */
export function largestAttachment(attached: readonly ContextAttachment[]): ContextAttachment | null {
  return attached.reduce<ContextAttachment | null>((largest, item) => largest === null || item.text.length > largest.text.length ? item : largest, null);
}

/** Whether a message already points at this thing. */
export function isAttached(attached: readonly ContextAttachment[], item: Pick<ContextAttachment, 'key' | 'uri' | 'label'>): boolean {
  return attached.some((held) => held.key === item.key || held.uri === item.uri && held.label === item.label);
}

/**
 * Add one thing the person chose to what the message points at, as the host will take it: once,
 * no more than eight, and its description cut to the room left (ACP-10). `refused` says why it
 * was not added, naming what to take back; null with the list unchanged when it was there already.
 */
export function withAttachment(attached: readonly ContextAttachment[], item: ContextAttachment): { attached: ContextAttachment[]; refused: string | null } {
  if (isAttached(attached, item)) return { attached: [...attached], refused: null };
  if (attached.length >= maximumAttachments) return { attached: [...attached], refused: `A message points at ${maximumAttachments} things at most.` };
  const text = fitDescription(item.text, attached);
  if (text === null) {
    const largest = largestAttachment(attached);
    return { attached: [...attached], refused: `${item.label} does not fit: this message already carries as much as one message can.${largest === null ? '' : ` Stop pointing at ${largest.label}, which says the most, to make room.`}` };
  }
  return { attached: [...attached, { ...item, text }], refused: null };
}

/** What the message points at, for the host: the address, the name as long as the host takes it, and the description. */
export function contextForHost(attached: readonly ContextAttachment[]): Array<{ uri: string; title: string; text: string }> {
  return attached.map((item) => ({ uri: item.uri, title: contextLabel(item.label), text: item.text }));
}

function fieldLine(field: ContextField): string {
  const parts = [`fieldId \`${field.fieldId}\``, field.kind];
  if (field.required) parts.push('required');
  if (field.scale !== null) parts.push(`${field.scale.min} to ${field.scale.max}`);
  if (field.choices.length > 0) parts.push(`choices ${field.choices.slice(0, 20).map((option) => `${option.name} (\`${option.id}\`)`).join(', ')}${field.choices.length > 20 ? ', …' : ''}`);
  if (field.referenceTo !== null) parts.push(`refers to entityId \`${field.referenceTo}\``);
  return `- ${field.name}: ${parts.join(', ')}`;
}

/** The description, bounded, and then always the address that reads the rest: a cut never takes it. */
function readMore(lines: string[], uri: string): string {
  const tail = `${readMorePrefix}${uri}`;
  return `${bounded(lines.join('\n'), maximumDescriptionCharacters - tail.length)}${tail}`;
}

/** A record type: its ID and its fields with theirs, so the agent can write to it at once. */
export function describeType(fileName: string, entity: ContextEntity): string {
  const lines = [`Record type "${entity.name}" in ${fileName}`, `entityId: \`${entity.entityId}\`${entity.recordCount === null ? '' : `, ${entity.recordCount} records`}`, '', 'Fields:',
    ...entity.fields.slice(0, maximumFieldsDescribed).map(fieldLine)];
  if (entity.fields.length > maximumFieldsDescribed) lines.push(`- … and ${entity.fields.length - maximumFieldsDescribed} more fields`);
  lines.push('', `Its records: ${entityUri(entity.entityId)}/records`);
  return readMore(lines, entityUri(entity.entityId));
}

export function describeField(fileName: string, entity: ContextEntity, field: ContextField): string {
  return readMore([`Field "${field.name}" of record type "${entity.name}" in ${fileName}`, `entityId: \`${entity.entityId}\``, fieldLine(field)], entityUri(entity.entityId));
}

export function describeView(fileName: string, view: ContextView, entity: ContextEntity | null): string {
  const lines = [`View "${view.title}" in ${fileName}`, `viewId: \`${view.viewId}\`, kind ${view.kind}`];
  if (entity !== null) lines.push(`It shows record type "${entity.name}", entityId \`${entity.entityId}\`; its records: ${entityUri(entity.entityId)}/records`);
  return readMore(lines, 'nendo://application/surfaces');
}

export function describeProposal(proposal: ContextProposal): string {
  return readMore([`Proposal "${proposal.title}", waiting for the person to review it`, `proposalId: \`${proposal.proposalId}\`, ${proposal.operationCount} changes`],
    `nendo://application/proposal/${encodeURIComponent(proposal.proposalId)}`);
}

function valueText(field: ContextField | undefined, value: unknown, referenceLabel: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '(empty)';
  if (field?.referenceTo !== null && field?.referenceTo !== undefined && referenceLabel) return `${referenceLabel} (\`${String(value)}\`)`;
  const name = (id: unknown): string => field?.choices.find((option) => option.id === id)?.name ?? String(id);
  if (Array.isArray(value)) return bounded(value.map(name).join(', '), maximumValueCharacters);
  if (typeof value === 'object') return bounded(JSON.stringify(value), maximumValueCharacters);
  return bounded(field !== undefined && field.choices.length > 0 ? name(value) : String(value), maximumValueCharacters);
}

/** A record: its IDs, version and every field's value, read from the file when it was chosen. */
export function describeRecord(fileName: string, entity: ContextEntity | null, label: string,
  record: { entityId: string; recordId: string; recordVersion: number; values: Record<string, unknown>; referenceLabels?: Record<string, string | null> }): string {
  const lines = [`Record "${label}" of record type "${entity?.name ?? record.entityId}" in ${fileName}`,
    `entityId: \`${record.entityId}\`, recordId: \`${record.recordId}\`, recordVersion ${record.recordVersion}`, '', 'Values:'];
  const fields = entity?.fields ?? [];
  const known = fields.slice(0, maximumFieldsDescribed).map((field) =>
    `- ${field.name} (\`${field.fieldId}\`): ${valueText(field, record.values[field.fieldId], record.referenceLabels?.[field.fieldId])}`);
  const others = Object.keys(record.values).filter((fieldId) => !fields.some((field) => field.fieldId === fieldId)).slice(0, 20)
    .map((fieldId) => `- \`${fieldId}\`: ${valueText(undefined, record.values[fieldId], null)}`);
  lines.push(...known, ...others);
  return readMore(lines, recordUri(record.entityId, record.recordId));
}
