import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// W-266 to W-268 (ADR-0031): a picture field on the record page, a thumbnail wherever a value is
// shown, a gallery cover and Studio's cell, drawn as the image canvas's direction A.
const { mediaFieldMarkup, mediaThumbMarkup, mediaCoverMarkup, mediaMenuMarkup } = await bundleOf('src/media-markup.ts');
const { parseMediaAddress } = await bundleOf('src/media-model.ts');

const origin = 'https://media-0123456789abcdef.example';
const where = { origin, canEdit: true, loadWeb: true };
const sha = 'b'.repeat(64);
const field = { semanticId: 'album.cover', displayName: 'Cover', presentation: 'media', storageKind: 0, required: false, options: [], choices: [] };
const record = { semanticId: 'a1', version: 3, values: {} };

test('an embedded picture is drawn from the media origin, opens larger, and keeps its address in the form', () => {
  const markup = mediaFieldMarkup(field, `media:${sha}`, record, where);
  assert.match(markup, new RegExp(`<img src="${origin}/m/${sha}"`));
  assert.match(markup, /data-media-open aria-label="Open Cover larger"/);
  assert.match(markup, new RegExp(`<input type="hidden" name="album.cover" value="media:${sha}" data-media-value`));
  assert.match(markup, /<span class="media-source">In file<\/span>/);
  assert.match(markup, /aria-haspopup="menu"/);
  assert.match(markup, /data-media-missing hidden/, 'the missing row waits for the picture to fail');
});

test('a local picture is asked for by its address, and the web waits while the device does not load it', () => {
  assert.match(mediaFieldMarkup(field, '.\\Covers\\blue.png', record, where), new RegExp(`src="${origin}/f/\\?a=.%5CCovers%5Cblue.png"`));
  const waiting = mediaFieldMarkup(field, 'https://example.org/a.png', record, { ...where, loadWeb: false });
  assert.doesNotMatch(waiting, /<img/);
  assert.match(waiting, /data-media-action="web-on">Load pictures from the internet/);
});

test('an empty field is a drop zone with its three ways in, and a record not saved yet says to save first', () => {
  const empty = mediaFieldMarkup(field, null, record, where);
  assert.match(empty, /data-media-drop/);
  for (const action of ['pick', 'link', 'web']) assert.match(empty, new RegExp(`data-media-action="${action}"`));
  const unsaved = mediaFieldMarkup(field, null, null, where);
  assert.match(unsaved, /Save the record first, then add a picture\./);
  assert.doesNotMatch(unsaved, /data-media-action="pick"/);
});

test('a value that is not an address is shown as text, never dropped', () => {
  const markup = mediaFieldMarkup(field, 'liner notes', record, where);
  assert.match(markup, /Not a picture's address: <code>liner notes<\/code>/);
  assert.match(markup, /value="liner notes"/);
});

test('the menu offers what each source can do', () => {
  const items = (value) => [...mediaMenuMarkup(parseMediaAddress(value), true).matchAll(/data-media-action="([a-z-]+)"(?: disabled)?/g)]
    .map(match => match[0].endsWith('disabled') ? `${match[1]}:off` : match[1]);
  assert.deepEqual(items(`media:${sha}`), ['pick', 'paste', 'link', 'web', 'save', 'embed-copy:off', 'reveal:off', 'remove']);
  assert.deepEqual(items('C:\\Pictures\\a.png'), ['pick', 'paste', 'link', 'web', 'save:off', 'embed-copy', 'reveal', 'remove']);
  assert.deepEqual(items('https://example.org/a.png'), ['pick', 'paste', 'link', 'web', 'save:off', 'embed-copy', 'reveal:off', 'web-off', 'remove']);
});

test('a thumbnail and a cover come from the same origin; anything else is not drawn', () => {
  assert.match(mediaThumbMarkup(`media:${sha}`, 'Cover', false, where), new RegExp(`class="media-thumb" title="media:${sha}"><img src="${origin}/m/${sha}"`));
  assert.match(mediaThumbMarkup(`media:${sha}`, 'Cover', true, where), /media-thumb is-small/);
  assert.equal(mediaThumbMarkup('not an address', 'Cover', false, where), '');
  assert.match(mediaCoverMarkup(`media:${sha}`, where), new RegExp(`class="media-cover"><img src="${origin}/m/${sha}"`));
  assert.match(mediaCoverMarkup(null, where), /media-cover is-empty/);
});
