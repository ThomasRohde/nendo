import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// ADR-0031: the Workbench's reading of a media address follows the Engine's grammar, so a value
// the Engine stored is shown as a picture and anything else as text (NendoMediaAddress in the Engine).
const { parseMediaAddress, mediaUrl } = await bundleOf('src/media-model.ts');
const sha = 'a'.repeat(64);

test('the addresses the Engine accepts are read by source', () => {
  for (const [value, source] of [
    [`media:${sha}`, 'embedded'], ['https://example.org/cover.jpg', 'web'], ['C:\\Pictures\\cover.jpg', 'localAbsolute'],
    ['D:/Music/Album 1/front.png', 'localAbsolute'], ['.\\Media\\cover.jpg', 'localRelative'], ['../Shared/logo.png', 'localRelative'],
  ]) assert.equal(parseMediaAddress(value)?.source, source, value);
});

test('the values the Engine refuses are not read as pictures', () => {
  for (const value of ['', ` media:${sha}`, `media:${sha.toUpperCase()}`, 'http://example.org/a.png', 'https://user:pw@example.org/a.png',
    'https://example.org/a b.png', '\\\\server\\share\\a.jpg', 'cover.jpg', 'Media\\cover.jpg', 'C:\\Pictures\\', '.\\Media\\..',
    'file:///C:/a.jpg', 'javascript:alert(1)', null, 42])
    assert.equal(parseMediaAddress(value), null, String(value));
});

test('each source has its page address, and a web picture waits while the device does not load them', () => {
  const origin = 'https://media-0123456789abcdef.example';
  assert.equal(mediaUrl(parseMediaAddress(`media:${sha}`), origin, true), `${origin}/m/${sha}`);
  assert.equal(mediaUrl(parseMediaAddress('.\\Media\\a b.png'), origin, true), `${origin}/f/?a=.%5CMedia%5Ca%20b.png`);
  assert.equal(mediaUrl(parseMediaAddress('https://example.org/a.png'), origin, true), 'https://example.org/a.png');
  assert.equal(mediaUrl(parseMediaAddress('https://example.org/a.png'), origin, false), null);
  assert.equal(mediaUrl(parseMediaAddress(`media:${sha}`), null, true), null);
});
