import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DECK_FOLDER, COPY_FOLDER, ENGINE_FILES } from '../brandkits/engine.mjs';

// Brandkits previews slides and writes Deck designs with its copy of this engine: what it shows
// is what Deck draws only while the copy is Deck's own files, byte for byte.
test('Brandkits carries Deck\'s engine byte for byte, and every module the engine imports', async () => {
  const differ = [];
  for (const name of ENGINE_FILES) {
    const [deck, copy] = await Promise.all([fs.readFile(path.join(DECK_FOLDER, name)), fs.readFile(path.join(COPY_FOLDER, name)).catch(() => null)]);
    if (!copy || !deck.equals(copy)) differ.push(name);
  }
  assert.deepEqual(differ, [], `extensions/brandkits/deck differs from extensions/deck in ${differ.join(', ')}: run node tools/brandkits/Sync-DeckEngine.mjs`);
  for (const name of ENGINE_FILES) {
    const text = await fs.readFile(path.join(DECK_FOLDER, name), 'utf8');
    for (const [, target] of text.matchAll(/^import [^;]*? from '\.\/([^']+)';/gm)) assert.ok(ENGINE_FILES.includes(target), `${name} imports ${target}, which Brandkits does not copy: add it to tools/brandkits/engine.mjs`);
  }
  assert.deepEqual((await fs.readdir(COPY_FOLDER)).sort(), [...ENGINE_FILES].sort(), 'the copy holds only the engine files');
});
