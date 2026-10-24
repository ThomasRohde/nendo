// Copies Deck's engine into the Brandkits package: node tools/brandkits/Sync-DeckEngine.mjs
// Run it after any change to a file engine.mjs names, and commit both together.

import fs from 'node:fs/promises';
import path from 'node:path';
import { DECK_FOLDER, COPY_FOLDER, ENGINE_FILES } from './engine.mjs';

await fs.mkdir(COPY_FOLDER, { recursive: true });
for (const name of await fs.readdir(COPY_FOLDER)) if (!ENGINE_FILES.includes(name)) await fs.rm(path.join(COPY_FOLDER, name));
for (const name of ENGINE_FILES) await fs.copyFile(path.join(DECK_FOLDER, name), path.join(COPY_FOLDER, name));
console.log(`Copied ${ENGINE_FILES.length} engine files from extensions/deck to extensions/brandkits/deck.`);
