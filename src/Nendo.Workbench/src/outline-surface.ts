import { runMutation } from './actions';
import { outlineErrors, outlineSurfaces, state, type SurfaceOutline } from './app-state';
import { client } from './client';
import { holdingThePage, refuseWhileDirty } from './draft-guard';
import { messageFor, mutationKey } from './format';
import type { ApplicationPlan, ReadPage, RecordSnapshot, SurfaceNodePlan } from './host';
import {
  type DropZone, type MoveDirection, type MoveTarget, type OutlineLevel, type OutlineNode,
  TOP, dropTarget, dropZoneAt, emptyOutline, findNode, movePayload, moveTarget, rememberRow, rememberedRows, startsOpen,
} from './outline-model';
import { type OutlineConfig, canMove, findLimit, outlineConfig } from './outline-surface-markup';
import { createReadChase } from './read-chase';
import { content, rerender, showError } from './shell';

/**
 * The outline surface (ADR-0019 stage 6, ADR-0004's B6): a declared hierarchy in Use, drawn
 * as an ARIA treegrid. It reads the tree a level at a time in sibling order -- the top level,
 * then each open record's children, in pages of 100 -- and opens `expandDepth` levels by
 * itself. What a person opens or closes is kept on their device, never in the file. With
 * `reorder` on, rows move by drag and by keyboard through `data.moveRecord`, whose refusal
 * leaves the rows where they were and says why.
 */

/** Children read per level, as the ADR states. */
const pageSize = 100;
/** How many levels the first draw may read to open `expandDepth` levels; further rows stay closed. */
const openingReads = 40;

// ---------------------------------------------------------------- reads

async function readLevel(entityId: string, parentKey: string, cursor: string | null): Promise<OutlineLevel & { changeSequence: number }> {
  const page = await client.request<ReadPage<OutlineNode>>('data.treeRecords', {
    entityId, rootRecordId: parentKey === TOP ? null : parentKey, depth: 1, limit: pageSize, cursor,
  });
  return { items: page.items, nextCursor: page.nextCursor, changeSequence: page.changeSequence };
}

function deviceStorage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

function remembered(nodeId: string): Record<string, 'open' | 'closed'> {
  const applicationId = state.session.manifest?.applicationId;
  const storage = deviceStorage();
  return applicationId && storage !== null ? rememberedRows(storage, applicationId, nodeId) : {};
}

function remember(nodeId: string, recordId: string, open: boolean): void {
  const applicationId = state.session.manifest?.applicationId;
  const storage = deviceStorage();
  if (applicationId && storage !== null) rememberRow(storage, applicationId, nodeId, recordId, open ? 'open' : 'closed');
}

/**
 * The top level, then each record that starts open, breadth first. A record starts open by
 * what the person last did with it on this device, else by what was open before this read,
 * else by `expandDepth`. Every level is read at one change sequence or the pass starts again.
 */
async function loadOutline(config: OutlineConfig, nodeId: string): Promise<void> {
  const previous = outlineSurfaces.get(nodeId);
  const folds = remembered(nodeId);
  for (let attempt = 0; attempt < 3; attempt++) {
    const top = await readLevel(config.entityId, TOP, null);
    const next = emptyOutline(config.entityId, top.changeSequence);
    next.levels.set(TOP, top);
    const queue: Array<[OutlineNode, number]> = top.items.map(item => [item, 1]);
    let reads = 0;
    let consistent = true;
    while (queue.length > 0 && reads < openingReads) {
      const [item, depth] = queue.shift()!;
      const id = item.record.recordId;
      if (item.childCount === 0) continue;
      const open = folds[id] !== undefined || previous === undefined
        ? startsOpen(depth, config.expandDepth, folds[id])
        : previous.state.expanded.has(id);
      if (!open) continue;
      let level: OutlineLevel & { changeSequence: number };
      try { level = await readLevel(config.entityId, id, null); } catch { continue; }
      reads++;
      if (level.changeSequence !== top.changeSequence) { consistent = false; break; }
      next.levels.set(id, level);
      next.expanded.add(id);
      queue.push(...level.items.map((child): [OutlineNode, number] => [child, depth + 1]));
    }
    if (!consistent) continue;
    outlineSurfaces.set(nodeId, { state: next, error: null, focus: previous?.focus ?? null, found: previous?.found ?? null });
    return;
  }
  throw new Error('The file kept changing while the outline was read. It will be read again.');
}

const outlineChase = createReadChase();

/** Whether the outline in view has been read at the file's current change. */
function current(nodeId: string): SurfaceOutline | undefined {
  const entry = outlineSurfaces.get(nodeId);
  return entry !== undefined && entry.state.changeSequence === state.session.manifest?.changeSequence ? entry : undefined;
}

// ---------------------------------------------------------------- behaviour

let hadFocus = false;

/** Reads the outline when it is missing or stale, and wires its rows. Called by the Use view after each draw. */
export function wireOutlineSurface(plan: ApplicationPlan, node: SurfaceNodePlan): void {
  const config = outlineConfig(plan, node);
  const nodeId = node.semanticId;
  if (config.parentFieldId === null) return;
  if (current(nodeId) === undefined) {
    outlineChase.run(async () => {
      try { await loadOutline(config, nodeId); outlineErrors.delete(nodeId); } catch (error) { outlineErrors.set(nodeId, messageFor(error)); }
    }, rerender, error => showError(messageFor(error)), holdingThePage);
  }
  content.querySelector<HTMLButtonElement>('[data-outline-retry]')?.addEventListener('click', () => { outlineErrors.delete(nodeId); rerender(); });
  const entry = outlineSurfaces.get(nodeId);
  const table = content.querySelector<HTMLTableElement>(`[data-outline-surface="${CSS.escape(nodeId)}"]`);
  if (entry === undefined || table === null) return;

  const rowOf = (id: string): HTMLTableRowElement | null => table.querySelector<HTMLTableRowElement>(`tr[data-outline-row="${CSS.escape(id)}"]`);
  const setFocus = (id: string, move = true): void => {
    entry.focus = id;
    for (const row of table.querySelectorAll<HTMLTableRowElement>('tr[data-outline-row]')) row.tabIndex = row.dataset.outlineRow === id ? 0 : -1;
    if (move) rowOf(id)?.focus();
    syncMoveButtons(entry, config);
  };
  const toggle = async (id: string): Promise<void> => {
    const found = findNode(entry.state, id);
    if (found === null || found.childCount === 0) return;
    entry.focus = id;
    hadFocus = true;
    if (entry.state.expanded.delete(id)) { remember(nodeId, id, false); rerender(); return; }
    if (!entry.state.levels.has(id)) {
      try {
        const level = await readLevel(config.entityId, id, null);
        if (level.changeSequence !== entry.state.changeSequence) { rerender(); return; }
        entry.state.levels.set(id, level);
      } catch (error) { showError(messageFor(error)); return; }
    }
    entry.state.expanded.add(id);
    remember(nodeId, id, true);
    rerender();
  };
  const openRecord = (id: string): void => {
    if (refuseWhileDirty('opening another record')) return;
    entry.focus = id;
    state.selectedRecordId = id;
    state.creatingRecord = false;
    state.returnTo = null;
    rerender();
  };
  const move = (target: MoveTarget | null, id: string, label: string): void => {
    if (target === null || !canMove(config) || refuseWhileDirty('moving a record')) return;
    const payload = movePayload(entry.state, id, target, mutationKey());
    if (payload === null) return;
    // A record moved under another stays in view: its new parent opens, and stays open.
    if (target.parentRecordId !== null) { entry.state.expanded.add(target.parentRecordId); remember(nodeId, target.parentRecordId, true); }
    entry.focus = id;
    hadFocus = true;
    void runMutation('data.moveRecord', payload, label, true);
  };
  const keyMove = (direction: MoveDirection): void => {
    if (entry.focus === null) return;
    const labels = { up: 'Moved up.', down: 'Moved down.', indent: 'Indented.', outdent: 'Outdented.' };
    move(moveTarget(entry.state, entry.focus, direction, config.ordered), entry.focus, labels[direction]);
  };

  for (const button of table.querySelectorAll<HTMLButtonElement>('[data-outline-toggle]'))
    button.addEventListener('click', event => { event.stopPropagation(); void toggle(button.dataset.outlineToggle!); });
  for (const button of table.querySelectorAll<HTMLButtonElement>('[data-outline-open]'))
    button.addEventListener('click', event => { event.stopPropagation(); if (!suppressClick) openRecord(button.dataset.outlineOpen!); });
  for (const button of table.querySelectorAll<HTMLButtonElement>('[data-outline-more]'))
    button.addEventListener('click', () => void readMore(config, entry, button.dataset.outlineMore!));
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-outline-move]'))
    button.addEventListener('click', () => keyMove(button.dataset.outlineMove as MoveDirection));
  content.querySelector<HTMLFormElement>('[data-outline-find]')?.addEventListener('submit', event => {
    event.preventDefault();
    const text = (new FormData(event.currentTarget as HTMLFormElement).get('find') ?? '').toString().trim();
    void find(config, entry, text);
  });

  table.addEventListener('focusin', event => {
    hadFocus = true;
    const row = (event.target as HTMLElement).closest<HTMLTableRowElement>('tr[data-outline-row]');
    if (row !== null && row.dataset.outlineRow !== entry.focus) setFocus(row.dataset.outlineRow!, false);
  });
  // A redraw removes the focused row, and that fires focusout too; only a table still on the
  // page can say the person took their focus elsewhere.
  table.addEventListener('focusout', () => {
    setTimeout(() => { if (table.isConnected) hadFocus = table.contains(document.activeElement); }, 0);
  });
  table.addEventListener('click', event => {
    const row = (event.target as HTMLElement).closest<HTMLTableRowElement>('tr[data-outline-row]');
    if (row !== null) setFocus(row.dataset.outlineRow!);
  });
  table.addEventListener('keydown', event => {
    const row = (event.target as HTMLElement).closest<HTMLTableRowElement>('tr[data-outline-row]');
    if (row === null) return;
    const id = row.dataset.outlineRow!;
    const found = findNode(entry.state, id);
    const all = [...table.querySelectorAll<HTMLTableRowElement>('tr[data-outline-row]')];
    const at = all.indexOf(row);
    if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey) {
      const direction = ({ ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'outdent', ArrowRight: 'indent' } as Record<string, MoveDirection>)[event.key];
      if (direction === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      if (canMove(config)) keyMove(direction);
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const go = (target: HTMLTableRowElement | undefined): void => { if (target !== undefined) setFocus(target.dataset.outlineRow!); };
    switch (event.key) {
      case 'ArrowDown': go(all[at + 1]); break;
      case 'ArrowUp': go(all[at - 1]); break;
      case 'Home': go(all[0]); break;
      case 'End': go(all.at(-1)); break;
      case 'ArrowRight':
        if (found !== null && found.childCount > 0 && !entry.state.expanded.has(id)) void toggle(id);
        else if (found !== null && entry.state.expanded.has(id)) go(all[at + 1]);
        break;
      case 'ArrowLeft':
        if (entry.state.expanded.has(id)) void toggle(id);
        else if (found?.parentRecordId) go(rowOf(found.parentRecordId) ?? undefined);
        break;
      case 'Enter': openRecord(id); break;
      case ' ': void toggle(id); break;
      default: return;
    }
    event.preventDefault();
  });
  if (canMove(config)) wireDrag(table, entry, config, (target, id) => move(target, id, 'Moved.'));
  // A redraw that happened while the outline held focus puts it back on the same row.
  if (hadFocus && entry.focus !== null) rowOf(entry.focus)?.focus();
}

function syncMoveButtons(entry: SurfaceOutline, config: OutlineConfig): void {
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-outline-move]'))
    button.disabled = entry.focus === null || moveTarget(entry.state, entry.focus, button.dataset.outlineMove as MoveDirection, config.ordered) === null;
}

async function readMore(config: OutlineConfig, entry: SurfaceOutline, parentKey: string): Promise<void> {
  const level = entry.state.levels.get(parentKey);
  if (level === undefined || level.nextCursor === null) return;
  try {
    const more = await readLevel(config.entityId, parentKey, level.nextCursor);
    if (more.changeSequence !== entry.state.changeSequence) { rerender(); return; }
    entry.state.levels.set(parentKey, { items: [...level.items, ...more.items], nextCursor: more.nextCursor });
    rerender();
  } catch (error) { showError(messageFor(error)); }
}

/**
 * The find box: one bounded query on the title field, then each match's ancestors opened
 * from the top down, reading each level -- and its next pages -- until the next record on
 * the path is there. A filtered tree would hide the ancestors that give a match its meaning,
 * which is why this opens paths rather than narrowing the rows.
 */
async function find(config: OutlineConfig, entry: SurfaceOutline, text: string): Promise<void> {
  if (text === '') { entry.found = null; rerender(); return; }
  if (config.titleFieldId === null || config.parentFieldId === null) return;
  try {
    const page = await client.request<ReadPage<RecordSnapshot>>('data.queryRecords', {
      entityId: config.entityId, limit: findLimit, cursor: null,
      filters: [{ fieldId: config.titleFieldId, operator: 'contains', value: text }],
    });
    const parentField = config.parentFieldId;
    const parentOf = async (id: string): Promise<string | null> => {
      const known = findNode(entry.state, id);
      if (known !== null) return known.parentRecordId;
      const read = await client.request<ReadPage<RecordSnapshot>>('data.queryRecords', { entityId: config.entityId, recordId: id, limit: 1, cursor: null });
      const value = read.items[0]?.values[parentField];
      return typeof value === 'string' ? value : null;
    };
    for (const match of page.items) {
      const path: string[] = [];
      let parent = typeof match.values[parentField] === 'string' ? match.values[parentField] as string : null;
      for (let hops = 0; parent !== null && hops < 32; hops++) { path.unshift(parent); parent = await parentOf(parent); }
      let parentKey = TOP;
      for (const id of [...path, match.recordId]) {
        if (!(await readUntil(config, entry, parentKey, id))) break;
        if (id === match.recordId) break;
        entry.state.expanded.add(id);
        parentKey = id;
      }
    }
    entry.found = { text, ids: new Set(page.items.map(item => item.recordId)), more: page.nextCursor !== null };
    entry.focus = page.items[0]?.recordId ?? entry.focus;
    hadFocus = page.items.length > 0;
    rerender();
  } catch (error) { showError(messageFor(error)); }
}

/** Reads one level, and its next pages, until `recordId` is among its items. False when it never appears. */
async function readUntil(config: OutlineConfig, entry: SurfaceOutline, parentKey: string, recordId: string): Promise<boolean> {
  let level = entry.state.levels.get(parentKey);
  if (level === undefined) {
    const read = await readLevel(config.entityId, parentKey, null);
    if (read.changeSequence !== entry.state.changeSequence) return false;
    level = { items: read.items, nextCursor: read.nextCursor };
    entry.state.levels.set(parentKey, level);
  }
  for (let pages = 0; !level.items.some(item => item.record.recordId === recordId) && level.nextCursor !== null && pages < 100; pages++) {
    const more = await readLevel(config.entityId, parentKey, level.nextCursor);
    if (more.changeSequence !== entry.state.changeSequence) return false;
    level = { items: [...level.items, ...more.items], nextCursor: more.nextCursor };
    entry.state.levels.set(parentKey, level);
  }
  return level.items.some(item => item.record.recordId === recordId);
}

let suppressClick = false;

/**
 * Moving a row by pointer. Native HTML drag events do not complete reliably in WinUI
 * WebView2, so this is the board's pointer-capture gesture: a row follows the pointer once
 * it has moved six pixels, and the row under the pointer says where it would land -- above
 * or below it in the top and bottom quarters, as its last child in the middle.
 */
function wireDrag(table: HTMLTableElement, entry: SurfaceOutline, config: OutlineConfig, drop: (target: MoveTarget, id: string) => void): void {
  let gesture: { id: string; row: HTMLTableRowElement; pointerId: number; x: number; y: number; active: boolean } | null = null;
  let landing: { row: HTMLTableRowElement; target: MoveTarget } | null = null;
  const mark = (row: HTMLTableRowElement | null, zone: DropZone | null): void => {
    for (const candidate of table.querySelectorAll('.drop-before, .drop-after, .drop-inside'))
      candidate.classList.remove('drop-before', 'drop-after', 'drop-inside');
    if (row !== null && zone !== null) row.classList.add(`drop-${zone}`);
  };
  const clear = (): void => {
    if (gesture?.row.hasPointerCapture(gesture.pointerId)) gesture.row.releasePointerCapture(gesture.pointerId);
    gesture?.row.classList.remove('is-dragging');
    gesture = null;
    landing = null;
    mark(null, null);
    setTimeout(() => { suppressClick = false; }, 0);
  };
  // Listened for on the table, and the row captured only once the gesture is a drag: capturing
  // on pointerdown would retarget the click, and a row's title could no longer be opened.
  table.addEventListener('pointerdown', event => {
    const row = (event.target as HTMLElement).closest<HTMLTableRowElement>('tr[data-outline-row]');
    if (row === null || !event.isPrimary || event.button !== 0 || state.actionInFlight) return;
    if ((event.target as HTMLElement).closest('.outline-toggle') !== null) return;
    gesture = { id: row.dataset.outlineRow!, row, pointerId: event.pointerId, x: event.clientX, y: event.clientY, active: false };
  });
  table.addEventListener('pointermove', event => {
    if (gesture === null || gesture.pointerId !== event.pointerId) return;
    if (event.buttons === 0) { clear(); return; }
    if (!gesture.active) {
      if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 6) return;
      gesture.active = true;
      suppressClick = true;
      gesture.row.setPointerCapture(event.pointerId);
      gesture.row.classList.add('is-dragging');
    }
    event.preventDefault();
    const under = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLTableRowElement>('tr[data-outline-row]') ?? null;
    if (under === null || !table.contains(under)) { landing = null; mark(null, null); return; }
    const box = under.getBoundingClientRect();
    const zone = dropZoneAt(event.clientY - box.top, box.height, config.ordered);
    const target = dropTarget(entry.state, gesture.id, under.dataset.outlineRow!, zone, config.ordered);
    landing = target === null ? null : { row: under, target };
    mark(target === null ? null : under, target === null ? null : zone);
  });
  table.addEventListener('pointerup', event => {
    if (gesture === null || gesture.pointerId !== event.pointerId) return;
    const id = gesture.id;
    const chosen = gesture.active ? landing : null;
    clear();
    if (chosen !== null) { event.preventDefault(); drop(chosen.target, id); }
  });
  table.addEventListener('pointercancel', clear);
  table.addEventListener('keydown', event => { if (event.key === 'Escape' && gesture !== null) { event.stopPropagation(); clear(); } }, true);
}
