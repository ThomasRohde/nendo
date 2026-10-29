import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

const { bytesFromBase64 } = await bundleOf('src/base64.ts');
const frames = await bundleOf('src/view-frame-loader.ts');

// Bytes 0–255 three times over, so every value and every padding length is decoded.
const sample = Uint8Array.from({ length: 770 }, (_, at) => at % 256);
const encoded = Buffer.from(sample).toString('base64');

test('base64 decodes to the same bytes through the native decoder and without one', () => {
  assert.deepEqual(bytesFromBase64(encoded), sample);
  const native = Uint8Array.fromBase64;
  delete Uint8Array.fromBase64;
  try { assert.deepEqual(bytesFromBase64(encoded), sample); }
  finally { Uint8Array.fromBase64 = native; }
});

// An exported page carries tens of megabytes of base64. Mapping each byte through a function
// with Uint8Array.from took 2.6 s on Archi's file before its first screen; nothing decodes so.
test('nothing decodes base64 through a function called per byte', () => {
  const perByte = /Uint8Array\.from\(\s*atob\(/;
  const sources = readdirSync('src', { recursive: true }).filter(path => /\.ts$/.test(path));
  const found = sources.filter(path => perByte.test(readFileSync(`src/${path}`, 'utf8')));
  assert.deepEqual(found, [], `decodes base64 per byte: ${found.join(', ')}`);
  const frame = frames.viewFrameDocument({}, 'index.js', '');
  assert.doesNotMatch(frame, perByte, 'a view frame decodes its package files per byte');
  assert.match(frame, /Uint8Array\.fromBase64/, 'a view frame does not use the native decoder');
});
