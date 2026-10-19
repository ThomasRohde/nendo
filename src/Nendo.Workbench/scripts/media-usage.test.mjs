import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// ADR-0031 point 8: History says what a file's pictures weigh against its budget and how
// much nothing names, and offers to remove only that, behind a backup.
const { byteSize, mediaUsageMarkup, removeUnusedQuestion } = await bundleOf('src/media-usage.ts');

const budget = 2 * 1024 * 1024 * 1024;
const usage = (count, bytes, unusedCount, unusedBytes) => ({ count, bytes, unusedCount, unusedBytes, budgetBytes: budget });

test('a file without pictures shows nothing', () => {
  assert.equal(mediaUsageMarkup(null, true), '');
  assert.equal(mediaUsageMarkup(usage(0, 0, 0, 0), true), '');
});

test('the weight is said against the budget, and every named picture is said to be kept', () => {
  const markup = mediaUsageMarkup(usage(3, 5 * 1024 * 1024, 0, 0), true);
  assert.match(markup, /3 pictures in this file: 5 MB of 2 GB/);
  assert.match(markup, /data-media-unused="0"/);
  assert.doesNotMatch(markup, /data-remove-unused-media/);
});

test('unused pictures are counted and offered for removal only where the file can change', () => {
  const markup = mediaUsageMarkup(usage(3, 5 * 1024 * 1024, 1, 2 * 1024 * 1024), true);
  assert.match(markup, /1 picture, 2 MB, is no longer named/);
  assert.match(markup, /data-remove-unused-media/);
  assert.doesNotMatch(mediaUsageMarkup(usage(3, 5 * 1024 * 1024, 1, 2 * 1024 * 1024), false), /data-remove-unused-media/);
});

test('near the budget the section is tinted', () => {
  assert.match(mediaUsageMarkup(usage(900, Math.ceil(budget * 0.85), 0, 0), true), /callout is-tinted/);
});

test('the question names what goes, that a backup comes first, and that it cannot be undone here', () => {
  const question = removeUnusedQuestion(usage(4, 10_000_000, 2, 3 * 1024 * 1024));
  assert.equal(question.confirmLabel, 'Back up and remove');
  assert.match(question.bodyHtml, /2 pictures, 3 MB/);
  assert.match(question.bodyHtml, /backup beside this file/);
  assert.match(question.bodyHtml, /cannot be undone here/);
});

test('sizes read as a person reads them', () => {
  assert.equal(byteSize(512), '512 bytes');
  assert.equal(byteSize(1536), `${(1.5).toLocaleString()} KB`);
  assert.equal(byteSize(64 * 1024 * 1024), '64 MB');
});
