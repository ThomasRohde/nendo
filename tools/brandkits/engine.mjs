// Brandkits draws its slide preview and writes its Deck design with Deck's own engine. A package
// carries every file it runs, so Brandkits holds a copy under extensions/brandkits/deck/. This
// names the copied files; Sync-DeckEngine.mjs makes the copy and engine-copy.test.mjs, in Deck's
// lane and Brandkits', fails when the copy and Deck's files differ by one byte.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DECK_FOLDER = path.resolve(here, '..', '..', 'extensions', 'deck');
export const COPY_FOLDER = path.resolve(here, '..', '..', 'extensions', 'brandkits', 'deck');
/** The engine and what it imports: layout, its theme, its text model, the HTML it draws, the design file. */
export const ENGINE_FILES = ['design.mjs', 'layout.mjs', 'measure.mjs', 'model.mjs', 'render.mjs', 'themes.mjs', 'zip.mjs'];
