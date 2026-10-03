import { fileScopedClearable, state } from './app-state';
import { client } from './client';
import { holdingThePage } from './draft-guard';
import { messageFor } from './format';
import type { EntitySnapshot, ReadPage } from './host';
import { type OutlineLevel, type OutlineNode, type OutlineState, TOP, emptyOutline } from './outline-model';
import { createReadChase, type ReadChase } from './read-chase';
import { rerender } from './shell';

export type StudioLayout = 'table' | 'outline';
export const studioLayouts = fileScopedClearable(new Map<string, StudioLayout>());
export const outlines = fileScopedClearable(new Map<string, OutlineState>());
export const studioOutlineErrors = fileScopedClearable(new Map<string, string>());
const studioOutlineErrorSequences = fileScopedClearable(new Map<string, number | undefined>());
const chases = fileScopedClearable(new Map<string, ReadChase>());
let generation = 0;
fileScopedClearable({ clear() { generation++; } });

/** Even an identical entity ID and change sequence cannot make another file's reply current. */
export function captureOutlineRead(): () => boolean {
  const started = generation;
  const fileSessionId = state.session.fileSessionId;
  return () => started === generation && fileSessionId === state.session.fileSessionId;
}

export async function readOutlineLevel(entityId: string, parentKey: string, cursor: string | null): Promise<OutlineLevel & { changeSequence: number }> {
  const page = await client.request<ReadPage<OutlineNode>>('data.treeRecords', {
    entityId, rootRecordId: parentKey === TOP ? null : parentKey, depth: 1, limit: 200, cursor,
  });
  return { items: page.items, nextCursor: page.nextCursor, changeSequence: page.changeSequence };
}

/** Reads the top level and every open record's children again, keeping what was open. */
async function loadOutline(entityId: string, current: () => boolean): Promise<void> {
  const previous = outlines.get(entityId);
  for (let attempt = 0; attempt < 3; attempt++) {
    const top = await readOutlineLevel(entityId, TOP, null);
    if (!current()) return;
    const next = emptyOutline(entityId, top.changeSequence);
    next.levels.set(TOP, top);
    let consistent = true;
    for (const id of previous?.expanded ?? []) {
      try {
        const level = await readOutlineLevel(entityId, id, null);
        if (!current()) return;
        if (level.changeSequence !== top.changeSequence) { consistent = false; break; }
        next.levels.set(id, level);
        next.expanded.add(id);
      } catch { if (!current()) return; /* A record that has gone is no longer open. */ }
    }
    if (!consistent) continue;
    outlines.set(entityId, next);
    return;
  }
  throw new Error('The file kept changing while the outline was read. Try reading it again.');
}

/**
 * A failed read waits for the retry control only while the file stands where it failed.
 * Once the file has moved on, the error is out of date too and the outline is read again.
 */
export function outlineErrorIsCurrent(entityId: string): boolean {
  return studioOutlineErrors.has(entityId)
    && studioOutlineErrorSequences.get(entityId) === state.session.manifest?.changeSequence;
}

export function refreshOutline(entity: EntitySnapshot): void {
  const entityId = entity.entityId;
  const sequence = state.session.manifest?.changeSequence;
  if (outlines.get(entityId)?.changeSequence === sequence) return;
  const current = captureOutlineRead();
  const failed = (error: unknown) => {
    if (!current()) return;
    studioOutlineErrors.set(entityId, messageFor(error));
    studioOutlineErrorSequences.set(entityId, sequence);
  };
  let chase = chases.get(entityId);
  if (chase === undefined) { chase = createReadChase(); chases.set(entityId, chase); }
  // A failed read is not a successful revision marker. The retry control clears the
  // error; the same bounded chase can then request the same sequence again.
  studioOutlineErrors.delete(entityId);
  studioOutlineErrorSequences.delete(entityId);
  chase.run(async () => {
    try { await loadOutline(entityId, current); }
    catch (error) { failed(error); }
  }, () => { if (current()) rerender(); }, failed, holdingThePage);
}
