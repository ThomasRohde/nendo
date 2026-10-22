/**
 * The pictures the launched agent and its tools show (ADR-0030). The host keeps each one's bytes;
 * an entry names them, and the tab reads one in windows and draws it from a data: address, never
 * from an address the agent named. A picture already read is kept here for the conversation, so
 * an entry drawn again does not read it again.
 */

/** A window of a picture's bytes, as `agentSession.image` answers. */
export interface PictureWindow { base64: string; mediaType: string; next: number | null }

import { fileScopedClearable } from './app-state';

const maximumKept = 32;
/** Read pictures by conversation and ID, oldest first. */
const kept = new Map<string, string>();
const reading = new Set<string>();

/** Forget every picture read: a new launch's IDs start again, and another file is another conversation. */
export function resetShownPictures(): void {
  kept.clear();
  reading.clear();
}

fileScopedClearable({
  clear(): void {
    kept.clear();
    reading.clear();
  },
});

function keep(key: string, url: string): void {
  kept.set(key, url);
  while (kept.size > maximumKept) kept.delete(kept.keys().next().value!);
}

/**
 * Fill every picture under `root` that has no address yet, reading the ones not kept. A picture
 * the host no longer keeps is said in words instead. Windows are whole multiples of three bytes,
 * so their base64 joins as one.
 */
export async function fillPictures(root: ParentNode, conversation: string, read: (imageId: string, offset: number) => Promise<PictureWindow>): Promise<void> {
  for (const image of root.querySelectorAll<HTMLImageElement>('img[data-agent-image]:not([src])')) {
    const id = image.dataset.agentImage!;
    const key = `${conversation}:${id}`;
    const url = kept.get(key);
    if (url !== undefined) { image.src = url; continue; }
    if (reading.has(key)) continue;
    reading.add(key);
    try {
      const parts: string[] = [];
      let mediaType = '';
      let offset: number | null = 0;
      while (offset !== null) {
        const window: PictureWindow = await read(id, offset);
        parts.push(window.base64);
        mediaType = window.mediaType;
        offset = window.next;
      }
      const filled = `data:${mediaType};base64,${parts.join('')}`;
      keep(key, filled);
      // The entry may have been drawn again while the picture was read.
      for (const drawn of root.querySelectorAll<HTMLImageElement>(`img[data-agent-image="${CSS.escape(id)}"]:not([src])`)) drawn.src = filled;
    } catch {
      for (const drawn of root.querySelectorAll<HTMLImageElement>(`img[data-agent-image="${CSS.escape(id)}"]:not([src])`)) {
        const gone = document.createElement('span');
        gone.className = 'chat-picture-gone';
        gone.textContent = '(a picture no longer kept)';
        drawn.replaceWith(gone);
      }
    } finally {
      reading.delete(key);
    }
  }
}
