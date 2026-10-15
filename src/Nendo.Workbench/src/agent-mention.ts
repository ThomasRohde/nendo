import { state } from './app-state';
import { client } from './client';
import { fileViews } from './file-view-model';
import { storageLabel } from './format';
import type { ReadPage, RecordSnapshot } from './host';
import { WorkbenchHostError } from './host-types';
import type { SearchPageView } from './search-text';
import { announce } from './shell';
import { viewTitle } from './view-frame-markup';
import { placesInOtherTabs, tabLabel } from './workspace-tabs';
import {
  attachmentsMarkup, contextChoices, contextForHost, describeField, describeProposal, describeRecord, describeType, describeView,
  isAttached, maximumAttachments, mentionAt, mentionMenuMarkup, recordUri, withAttachment,
  type ContextAttachment, type ContextChoice, type ContextEntity, type ContextRecordHit, type ContextSource,
} from './agent-context-model';

/**
 * The @ menu in the agent tab's message box (W-200). What the person points at is kept here
 * until the message goes; the message box asks for it then and clears it.
 *
 * On a large file the menu stays cheap: names come from the schema the Workbench already holds,
 * each group is capped, records come from the search index once two letters are typed and the
 * typing pauses, and a record is read on its own only when it is chosen.
 */

let attached: ContextAttachment[] = [];
/**
 * Moves on whenever the composer starts again (a new file, a new session): a record still being
 * read for a chip chosen before then is dropped when it arrives, not added to the new message.
 */
let composerGeneration = 0;
/** The open menu. Its source is gathered once when it opens and kept while the person types. */
let menu: { start: number; query: string; choices: ContextChoice[]; active: number; records: ContextRecordHit[] | null; note: string | null; source: ContextSource } | null = null;
let searchTimer = 0;
let searchSequence = 0;
const searchMinimum = 2;
const searchPauseMs = 180;
const searchLimit = 6;

/** What the message points at, for the host: the address, the name (as long as the host takes) and the description. */
export function pointedAt(): Array<{ uri: string; title: string; text: string }> {
  return contextForHost(attached);
}

export function clearPointedAt(page: ParentNode): void {
  attached = [];
  written = null;
  drawAttachments(page);
  composerNote(page, null, 'mention');
}

/**
 * A line in the composer, under what the message points at, that says why something did not
 * happen: a thing that could not be pointed at, or a message that waits for the agent. Said aloud
 * too. It was said only to screen readers, so a sighted person saw nothing (WAU-03, WAU-10). Null
 * takes the line away when it is of `kind`.
 */
export function composerNote(page: ParentNode, text: string | null, kind: 'waiting' | 'mention' = 'waiting'): void {
  const note = page.querySelector<HTMLElement>('#chat-composer-note');
  if (note === null) return;
  if (text === null) {
    if (note.dataset.kind === kind && !note.hidden) { note.hidden = true; note.textContent = ''; }
    return;
  }
  note.dataset.kind = kind;
  note.textContent = text;
  note.hidden = false;
  announce(text);
}

/**
 * Forget everything the composer held: a new file, or a new session, is a new conversation, and
 * what the person pointed at for the old one does not go with the new one's first message (ACP-02).
 */
export function resetMentions(): void {
  attached = [];
  menu = null;
  written = null;
  composerGeneration += 1;
  clearTimeout(searchTimer);
  searchSequence += 1;
}

/** The pages whose place names something to point at: a record type, a view, a record or a proposal. */
const pointablePages = new Set(['use', 'data', 'structure', 'agentProposal']);

function source(): ContextSource {
  const entities: ContextEntity[] = state.session.entities.filter((entity) => entity.retired !== true).map((entity) => ({
    entityId: entity.entityId,
    name: entity.displayName,
    recordCount: null,
    fields: entity.fields.filter((field) => field.retired !== true).map((field) => ({
      fieldId: field.fieldId,
      name: field.displayName,
      kind: storageLabel(field.storageKind, field.unsupportedStorageKind),
      required: field.required,
      choices: (field.choices ?? []).filter((option) => !option.retired).map((option) => ({ id: option.id, name: option.displayName })),
      scale: field.scale ?? null,
      referenceTo: field.reference?.targetEntityId ?? null,
    })),
  }));
  return {
    fileName: state.session.fileName ?? 'this file',
    entities,
    views: fileViews().map((view) => ({
      viewId: view.semanticId,
      title: viewTitle(view),
      kind: view.kind,
      entityId: typeof view.properties.entityId === 'string' ? view.properties.entityId : null,
    })),
    proposals: (state.agentStatus?.pendingProposals ?? []).map((proposal) => ({ proposalId: proposal.proposalId, title: proposal.title, operationCount: proposal.operationCount })),
    // A place keeps the record type it last showed even on a page about something else, such
    // as the Agent page, so only the pages that show one are offered.
    places: placesInOtherTabs().filter((place) => pointablePages.has(place.view)).map((place) => ({
      label: tabLabel(place),
      entityId: place.view === 'use' ? place.applicationEntityId : place.view === 'agentProposal' ? null : place.studioEntityId ?? place.applicationEntityId,
      viewId: place.view === 'use' ? place.fileView : null,
      recordId: place.view === 'use' ? place.recordId : null,
      proposalId: place.view === 'agentProposal' ? place.agentProposalId : null,
    })),
  };
}

function drawAttachments(page: ParentNode): void {
  const row = page.querySelector<HTMLElement>('#chat-attachments');
  if (row === null) return;
  row.innerHTML = attachmentsMarkup(attached);
  row.hidden = attached.length === 0;
}

function drawMenu(page: ParentNode): void {
  const list = page.querySelector<HTMLElement>('#chat-mention');
  const prompt = page.querySelector<HTMLTextAreaElement>('#agent-prompt');
  if (list === null || prompt === null) return;
  if (menu === null) {
    list.hidden = true;
    list.innerHTML = '';
    prompt.removeAttribute('aria-activedescendant');
    return;
  }
  // A textbox has no expanded state; the list is said aloud when it opens (UIK-10).
  const opening = list.hidden;
  list.hidden = false;
  list.innerHTML = mentionMenuMarkup(menu.choices, menu.active, menu.note);
  fitMenu(list);
  if (opening && menu.choices.length > 0) announce(`${menu.choices.length} ${menu.choices.length === 1 ? 'choice' : 'choices'}; up and down to choose, Enter to point at one.`);
  if (menu.choices.length > 0) {
    prompt.setAttribute('aria-activedescendant', `mention-option-${menu.active}`);
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  } else prompt.removeAttribute('aria-activedescendant');
}

/**
 * The menu opens upward from the box, and the pane above clips. A fixed height took its top, the
 * heading with it, off the top of a short pane (CSS-15), so the menu is told the room above the
 * box: from the pane's top to the box, less the stylesheet's gap under the menu and as much again
 * over it (--mention-gap, styles/22-agent-chat.css). A window that changes size while the menu is
 * open changes the room, so it is measured again then.
 */
export function fitMenu(list: HTMLElement): void {
  const box = list.offsetParent;
  const pane = list.closest('.studio-content');
  if (box === null || pane === null) return;
  const gap = parseFloat(getComputedStyle(list).getPropertyValue('--mention-gap')) || 0;
  const room = box.getBoundingClientRect().top - pane.getBoundingClientRect().top - 2 * gap;
  list.style.setProperty('--mention-room', `${Math.max(96, Math.floor(room))}px`);
  if (!refitsOnResize) {
    refitsOnResize = true;
    window.addEventListener('resize', () => {
      for (const open of document.querySelectorAll<HTMLElement>('#chat-mention, #chat-commands')) if (!open.hidden) fitMenu(open);
    });
  }
}
let refitsOnResize = false;

/**
 * Where the last choice wrote its @name, so the menu does not open again on the name it just
 * wrote: "@Books " reads as an @ being typed, and the next Enter chose it again instead of sending.
 */
let written: { start: number; name: string } | null = null;

/** Open, refresh or close the menu from where the caret is. */
function follow(page: ParentNode, prompt: HTMLTextAreaElement): void {
  const found = prompt.selectionStart === prompt.selectionEnd ? mentionAt(prompt.value, prompt.selectionStart) : null;
  if (written !== null && !prompt.value.startsWith(written.name, written.start)) written = null;
  if (found === null || found.start === written?.start) { close(page); return; }
  const sameQuery = menu !== null && menu.query === found.query && menu.start === found.start;
  const records = sameQuery ? menu!.records : null;
  const note = sameQuery ? menu!.note : null;
  const from = menu !== null && menu.start === found.start ? menu.source : source();
  menu = { start: found.start, query: found.query, choices: contextChoices(from, found.query, records), active: sameQuery ? menu!.active : 0, records, note, source: from };
  if (!sameQuery) scheduleRecords(page, found.query);
  drawMenu(page);
}

function close(page: ParentNode): void {
  clearTimeout(searchTimer);
  searchSequence += 1;
  if (menu === null) return;
  menu = null;
  drawMenu(page);
}

/** Records by name from the search index, once the typing pauses. A late answer is dropped. */
function scheduleRecords(page: ParentNode, query: string): void {
  clearTimeout(searchTimer);
  const sequence = ++searchSequence;
  const text = query.trim();
  if (text.length < searchMinimum || !state.session.capabilities.readData) return;
  searchTimer = window.setTimeout(() => void (async () => {
    let records: ContextRecordHit[] = [];
    let note: string | null = null;
    try {
      const found = await client.request<SearchPageView>('data.searchRecords', { text, limit: searchLimit, entityIds: [], fieldIds: [] });
      records = found.items.map((hit) => ({ entityId: hit.entityId, recordId: hit.recordId, label: hit.label }));
    } catch (error) {
      note = error instanceof WorkbenchHostError && error.code === 'search-index-missing'
        ? 'Records are found by name once the file has a search index: Ctrl K, then Build the search index.'
        : null;
    }
    if (sequence !== searchSequence || menu === null || menu.query !== query) return;
    menu = { ...menu, records, note, choices: contextChoices(menu.source, query, records) };
    menu.active = Math.min(menu.active, Math.max(menu.choices.length - 1, 0));
    drawMenu(page);
  })(), searchPauseMs);
}

/** Write the description of a choice: from the schema held, or, for a record, read on its own. */
async function describe(chosen: ContextChoice): Promise<string> {
  const from = source();
  const entity = from.entities.find((candidate) => candidate.entityId === chosen.entityId) ?? null;
  switch (chosen.kind) {
    case 'type': return describeType(from.fileName, entity!);
    case 'field': return describeField(from.fileName, entity!, entity!.fields.find((field) => field.fieldId === chosen.fieldId)!);
    case 'view': return describeView(from.fileName, from.views.find((view) => view.viewId === chosen.viewId)!, entity);
    case 'proposal': return describeProposal(from.proposals.find((proposal) => proposal.proposalId === chosen.proposalId)!);
    case 'record': {
      const page = await client.request<ReadPage<RecordSnapshot>>('data.queryRecords', { entityId: chosen.entityId, recordId: chosen.recordId, limit: 1 });
      const record = page.items[0];
      if (record === undefined) throw new Error(`${chosen.label} is no longer in the file.`);
      return describeRecord(from.fileName, entity, chosen.label, record);
    }
  }
}

async function choose(page: ParentNode, prompt: HTMLTextAreaElement, index: number): Promise<void> {
  const chosen = menu?.choices[index];
  const at = menu;
  if (chosen === undefined || at === null) return;
  close(page);
  // A thing that cannot be pointed at is refused before its @name is written: the name stood in
  // the sentence with nothing behind it, and the agent got the words but not the thing (WAU-03).
  if (!isAttached(attached, chosen) && attached.length >= maximumAttachments) {
    composerNote(page, `A message points at ${maximumAttachments} things at most. Take one back to point at ${chosen.label}.`, 'mention');
    return;
  }
  // The @name takes the place of what was typed, so the sentence reads as the person meant it.
  const caret = prompt.selectionStart;
  const before = prompt.value.slice(0, at.start);
  const after = prompt.value.slice(caret);
  const name = `@${chosen.label} `;
  prompt.value = before + name + after.replace(/^ /, '');
  prompt.selectionStart = prompt.selectionEnd = before.length + name.length;
  written = { start: before.length, name };
  prompt.dispatchEvent(new Event('input', { bubbles: true }));
  if (isAttached(attached, chosen)) return;
  const generation = composerGeneration;
  let text: string;
  try {
    text = await describe(chosen);
  } catch {
    text = `${chosen.label}: read it through Nendo at ${chosen.recordId !== null && chosen.entityId !== null ? recordUri(chosen.entityId, chosen.recordId) : chosen.uri}`;
  }
  // The composer started again while the record was read: this chip belonged to the old message.
  if (generation !== composerGeneration || isAttached(attached, chosen)) return;
  // What the host takes together is bounded, so the description is cut to the room left (ACP-10).
  const added = withAttachment(attached, { key: chosen.key, kind: chosen.kind, label: chosen.label, uri: chosen.uri, text });
  if (added.refused !== null) {
    // No room left: the @name just written comes out again, and the line says which chip to take back.
    unwrite(prompt, before.length, name);
    composerNote(page, added.refused, 'mention');
    return;
  }
  attached = added.attached;
  drawAttachments(page);
  composerNote(page, null, 'mention');
  announce(`${chosen.label} goes with this message.`);
}

/** Take an @name back out of the box, where it still stands as it was written. */
function unwrite(prompt: HTMLTextAreaElement, start: number, name: string): void {
  if (!prompt.value.startsWith(name, start)) return;
  prompt.value = prompt.value.slice(0, start) + prompt.value.slice(start + name.length);
  prompt.selectionStart = prompt.selectionEnd = start;
  if (written?.start === start) written = null;
  prompt.dispatchEvent(new Event('input', { bubbles: true }));
}

/** The keys the menu takes while it is open. True when the key was the menu's, so the box does not also act on it. */
export function mentionKey(event: KeyboardEvent, page: ParentNode, prompt: HTMLTextAreaElement): boolean {
  if (menu === null) return false;
  const count = menu.choices.length;
  switch (event.key) {
    case 'ArrowDown': case 'ArrowUp':
      if (count === 0) return true;
      event.preventDefault();
      menu.active = (menu.active + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
      drawMenu(page);
      return true;
    case 'Enter': case 'Tab':
      if (count === 0 || event.shiftKey) return false;
      event.preventDefault();
      void choose(page, prompt, menu.active);
      return true;
    case 'Escape':
      event.preventDefault();
      close(page);
      return true;
    default:
      return false;
  }
}

/** Wire the message box, the + button, the menu and the chips of a freshly drawn tab. */
export function wireMentions(page: HTMLElement): void {
  const prompt = page.querySelector<HTMLTextAreaElement>('#agent-prompt')!;
  const list = page.querySelector<HTMLElement>('#chat-mention')!;
  prompt.addEventListener('input', () => follow(page, prompt));
  prompt.addEventListener('click', () => follow(page, prompt));
  prompt.addEventListener('blur', () => window.setTimeout(() => { if (document.activeElement !== prompt) close(page); }, 120));
  // The list never takes focus: the box keeps it, and a press on an option chooses it.
  list.addEventListener('mousedown', (event) => event.preventDefault());
  list.addEventListener('click', (event) => {
    const option = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-choice]') : null;
    if (option !== null) void choose(page, prompt, Number(option.dataset.choice));
  });
  page.querySelector<HTMLButtonElement>('#chat-add-context')!.addEventListener('click', () => {
    // + writes the @ itself, so the menu opens as if it had been typed.
    const caret = prompt.selectionStart;
    const before = prompt.value.slice(0, caret);
    const spacer = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
    prompt.value = `${before}${spacer}@${prompt.value.slice(prompt.selectionEnd)}`;
    prompt.selectionStart = prompt.selectionEnd = caret + spacer.length + 1;
    prompt.focus();
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
  });
  page.querySelector<HTMLElement>('#chat-attachments')!.addEventListener('click', (event) => {
    const remove = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-remove-attachment]') : null;
    if (remove === null) return;
    const gone = attached.find((item) => item.key === remove.dataset.removeAttachment);
    attached = attached.filter((item) => item.key !== remove.dataset.removeAttachment);
    drawAttachments(page);
    composerNote(page, null, 'mention');
    prompt.focus();
    if (gone !== undefined) announce(`${gone.label} no longer goes with this message.`);
  });
  menu = null;
  drawAttachments(page);
  drawMenu(page);
}
