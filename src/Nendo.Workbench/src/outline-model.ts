/**
 * Studio's outline of a declared hierarchy (ADR-0019 stage 5), as data: the levels read so
 * far, which records are open, the rows that makes, and where a keyboard move sends a record.
 * Nothing here reads the host or touches the page, so the node tests drive it directly.
 */

/** One record of a tree read, in the host's shape. */
export interface OutlineNode {
  record: { recordId: string; recordVersion: number; values: Record<string, unknown> };
  parentRecordId: string | null;
  depth: number;
  childCount: number;
}

/** The children of one parent read so far, in sibling order, and the cursor to the rest. */
export interface OutlineLevel {
  items: OutlineNode[];
  nextCursor: string | null;
}

/** The key of the top level, which has no parent record. */
export const TOP = '';

export interface OutlineState {
  entityId: string;
  /** Children by parent record ID; TOP for the top level. */
  levels: Map<string, OutlineLevel>;
  /** Records whose children are shown. */
  expanded: Set<string>;
  /** The change the levels were read at. A different one means read them again. */
  changeSequence: number;
}

export type OutlineRow =
  | { kind: 'node'; node: OutlineNode; depth: number; expanded: boolean }
  | { kind: 'more'; parentKey: string; depth: number; loaded: number };

export function emptyOutline(entityId: string, changeSequence: number): OutlineState {
  return { entityId, levels: new Map(), expanded: new Set(), changeSequence };
}

/**
 * The rows the outline shows: depth-first through the open records, each level followed by a
 * "more" row when the host has more children than have been read.
 */
export function visibleRows(state: OutlineState): OutlineRow[] {
  const rows: OutlineRow[] = [];
  const visit = (parentKey: string, depth: number): void => {
    const level = state.levels.get(parentKey);
    if (level === undefined) return;
    for (const node of level.items) {
      const expanded = state.expanded.has(node.record.recordId) && node.childCount > 0;
      rows.push({ kind: 'node', node, depth, expanded });
      if (expanded) visit(node.record.recordId, depth + 1);
    }
    if (level.nextCursor !== null) rows.push({ kind: 'more', parentKey, depth, loaded: level.items.length });
  };
  visit(TOP, 1);
  return rows;
}

/** A node the outline has read, by record ID. */
export function findNode(state: OutlineState, recordId: string): OutlineNode | null {
  for (const level of state.levels.values()) {
    const node = level.items.find(item => item.record.recordId === recordId);
    if (node !== undefined) return node;
  }
  return null;
}

export type MoveDirection = 'up' | 'down' | 'indent' | 'outdent';

/** Where a move sends a record: under which parent (null for the top level), before which sibling (null for last). */
export interface MoveTarget {
  parentRecordId: string | null;
  beforeRecordId: string | null;
}

/**
 * Where a keyboard move sends a record, or null when there is nowhere to go: up and down swap
 * with the neighbouring sibling, indent makes the record the last child of the sibling above,
 * and outdent places it after its parent. A move past siblings not yet read is refused, so it
 * never lands somewhere the person cannot see. Without an order field (`ordered` false) there
 * is no sibling position to choose: up and down are refused, and indent and outdent only
 * change the parent.
 */
export function moveTarget(state: OutlineState, recordId: string, direction: MoveDirection, ordered = true): MoveTarget | null {
  if (!ordered) {
    if (direction === 'up' || direction === 'down') return null;
    const target = moveTarget(state, recordId, direction, true);
    return target === null ? null : { parentRecordId: target.parentRecordId, beforeRecordId: null };
  }
  const node = findNode(state, recordId);
  if (node === null) return null;
  const parentKey = node.parentRecordId ?? TOP;
  const level = state.levels.get(parentKey);
  if (level === undefined) return null;
  const siblings = level.items;
  const index = siblings.findIndex(item => item.record.recordId === recordId);
  const complete = level.nextCursor === null;
  switch (direction) {
    case 'up':
      return index > 0 ? { parentRecordId: node.parentRecordId, beforeRecordId: siblings[index - 1].record.recordId } : null;
    case 'down':
      if (index + 1 >= siblings.length) return null;
      if (index + 2 < siblings.length) return { parentRecordId: node.parentRecordId, beforeRecordId: siblings[index + 2].record.recordId };
      return complete ? { parentRecordId: node.parentRecordId, beforeRecordId: null } : null;
    case 'indent':
      return index > 0 ? { parentRecordId: siblings[index - 1].record.recordId, beforeRecordId: null } : null;
    case 'outdent': {
      if (node.parentRecordId === null) return null;
      const parent = findNode(state, node.parentRecordId);
      if (parent === null) return null;
      const upper = state.levels.get(parent.parentRecordId ?? TOP);
      if (upper === undefined) return null;
      const at = upper.items.findIndex(item => item.record.recordId === parent.record.recordId);
      if (at + 1 < upper.items.length) return { parentRecordId: parent.parentRecordId, beforeRecordId: upper.items[at + 1].record.recordId };
      return upper.nextCursor === null ? { parentRecordId: parent.parentRecordId, beforeRecordId: null } : null;
    }
  }
}

/** The payload data.moveRecord takes for a move, with the versions the outline read. */
export function movePayload(state: OutlineState, recordId: string, target: MoveTarget, idempotencyKey: string): Record<string, unknown> | null {
  const node = findNode(state, recordId);
  if (node === null) return null;
  const parent = target.parentRecordId === null ? null : findNode(state, target.parentRecordId);
  if (target.parentRecordId !== null && parent === null) return null;
  return {
    entityId: state.entityId,
    recordId,
    expectedRecordVersion: node.record.recordVersion,
    parentRecordId: target.parentRecordId,
    expectedParentVersion: parent?.record.recordVersion ?? null,
    beforeRecordId: target.beforeRecordId,
    idempotencyKey,
  };
}

/** Whether `recordId` is `ancestorId` or sits under it, as far as the outline has read. */
export function isWithin(state: OutlineState, recordId: string, ancestorId: string): boolean {
  for (let current: string | null = recordId, hops = 0; current !== null && hops <= 32; hops++) {
    if (current === ancestorId) return true;
    current = findNode(state, current)?.parentRecordId ?? null;
  }
  return false;
}

/** Where on a row a dragged record is dropped: above it, below it, or onto it as its last child. */
export type DropZone = 'before' | 'after' | 'inside';

/** The zone a pointer at `offset` down a row of `height` names: the top and bottom quarters are between rows. */
export function dropZoneAt(offset: number, height: number, ordered: boolean): DropZone {
  if (!ordered || height <= 0) return 'inside';
  return offset < height / 4 ? 'before' : offset > height * 3 / 4 ? 'after' : 'inside';
}

/**
 * Where a drop sends a record, or null when it would change nothing, land it under itself, or
 * land past siblings not yet read. The Engine refuses a loop on its own; this only declines the
 * drops the outline can already see are wrong, so the row does not look as if it could land.
 */
export function dropTarget(state: OutlineState, draggedId: string, targetId: string, zone: DropZone, ordered = true): MoveTarget | null {
  const dragged = findNode(state, draggedId);
  const target = findNode(state, targetId);
  if (dragged === null || target === null || isWithin(state, targetId, draggedId)) return null;
  if (zone === 'inside') {
    if (dragged.parentRecordId === targetId) {
      // Already its child: only a record that is not yet last has somewhere to go.
      const level = state.levels.get(targetId);
      if (!ordered || (level !== undefined && level.nextCursor === null && level.items.at(-1)?.record.recordId === draggedId)) return null;
    }
    return { parentRecordId: targetId, beforeRecordId: null };
  }
  if (!ordered) return null;
  const level = state.levels.get(target.parentRecordId ?? TOP);
  if (level === undefined) return null;
  const siblings = level.items.filter(item => item.record.recordId !== draggedId);
  const at = siblings.findIndex(item => item.record.recordId === targetId);
  const before = zone === 'before' ? targetId : siblings[at + 1]?.record.recordId ?? null;
  if (before === null && level.nextCursor !== null) return null;
  // Dropped where it already is: directly above the sibling it already precedes.
  const own = level.items.findIndex(item => item.record.recordId === draggedId);
  if (own >= 0 && (level.items[own + 1]?.record.recordId ?? null) === before) return null;
  return { parentRecordId: target.parentRecordId, beforeRecordId: before };
}

export type RowFold = 'open' | 'closed';

/**
 * Whether a record starts open in an outline surface: what the person last did with it on this
 * device, else the author's `expandDepth` (a record at depth 1 is open when two levels are).
 */
export function startsOpen(depth: number, expandDepth: number, remembered: RowFold | undefined): boolean {
  return remembered === undefined ? depth < expandDepth : remembered === 'open';
}

/** The device key for one file's outline rows, by application ID as section folds are. */
export function outlineRowsKey(applicationId: string): string {
  return `nendo.outlineRows.${applicationId}`;
}

/** What this device remembers of one outline's rows. Anything unreadable is simply not remembered. */
export function rememberedRows(storage: Pick<Storage, 'getItem'>, applicationId: string, nodeId: string): Record<string, RowFold> {
  const rows: Record<string, RowFold> = {};
  try {
    const parsed: unknown = JSON.parse(storage.getItem(outlineRowsKey(applicationId)) ?? '{}');
    const node: unknown = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>)[nodeId] : null;
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return rows;
    for (const [recordId, value] of Object.entries(node as Record<string, unknown>))
      if (value === 'open' || value === 'closed') rows[recordId] = value;
  } catch {
    // Storage that refuses to answer leaves the author's expandDepth in charge.
  }
  return rows;
}

/** Record one row's fold for one outline, keeping every other outline's. */
export function rememberRow(storage: Pick<Storage, 'getItem' | 'setItem'>, applicationId: string, nodeId: string, recordId: string, fold: RowFold): void {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(outlineRowsKey(applicationId)) ?? '{}');
    const all = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    all[nodeId] = { ...rememberedRows(storage, applicationId, nodeId), [recordId]: fold };
    storage.setItem(outlineRowsKey(applicationId), JSON.stringify(all));
  } catch {
    // The fold still holds for this session when device persistence is unavailable.
  }
}
