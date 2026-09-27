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
 * never lands somewhere the person cannot see.
 */
export function moveTarget(state: OutlineState, recordId: string, direction: MoveDirection): MoveTarget | null {
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
