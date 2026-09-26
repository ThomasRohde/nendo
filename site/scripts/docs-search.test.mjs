// The documentation search answers a query over several awaits: loading Pagefind, the
// debounced search, then each result's data. The reader can type again, clear the
// field or dismiss the panel while any of them is pending, and an answer that arrives
// afterwards must not reopen the panel or replace a newer answer.
//
// This runs the component's own <script>, transpiled in memory, against a stand-in for
// the two elements it touches and a Pagefind whose every answer is held until the test
// releases it. Nothing is built and no browser is started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const componentPath = new URL('../src/components/DocsSearch.astro', import.meta.url);
const source = await readFile(componentPath, 'utf8');
const script = source.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, 'DocsSearch.astro carries no <script> block.');
const code = ts.transpileModule(script, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/^export \{\};?\s*$/m, '');

// Pagefind, as a module the component can import by URL. Each call is recorded with a
// deferred answer, and so is each result's data, so a test decides what finishes when.
globalThis.__docsSearchStub = null;
const pagefindModule = 'data:text/javascript,' + encodeURIComponent(
  'export const debouncedSearch = (...args) => globalThis.__docsSearchStub.debouncedSearch(...args);');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

class FakeNode {}

function mount() {
  const calls = [];
  globalThis.__docsSearchStub = {
    debouncedSearch(term) {
      const answer = deferred();
      calls.push({ term, answer });
      return answer.promise;
    },
  };
  const inputHandlers = new Map();
  const documentHandlers = new Map();
  const input = Object.assign(new FakeNode(), {
    value: '',
    dataset: { pagefindBase: pagefindModule },
    addEventListener: (name, handler) => inputHandlers.set(name, handler),
    blur: () => {},
  });
  const results = Object.assign(new FakeNode(), {
    hidden: true,
    innerHTML: '',
    contains: node => node === results,
  });
  const document = {
    querySelector: selector => (selector === '#docs-search-input' ? input : results),
    addEventListener: (name, handler) => documentHandlers.set(name, handler),
  };
  new Function('document', 'Node', code)(document, FakeNode);

  const type = value => { input.value = value; return inputHandlers.get('input')(); };
  // Wait until the component has asked Pagefind for its nth search.
  const searchCall = async n => {
    for (let spin = 0; spin < 1000 && calls.length < n; spin++) await new Promise(done => setImmediate(done));
    assert.ok(calls.length >= n, `The component never asked Pagefind for search ${n}.`);
    return calls[n - 1];
  };
  const answer = (call, title) => call.answer.resolve({
    results: [{ data: async () => ({ url: `/nendo/docs/${title}`, meta: { title }, excerpt: `about ${title}` }) }],
  });
  return {
    input, results, type, searchCall, answer,
    escape: () => inputHandlers.get('keydown')({ key: 'Escape' }),
    clickOutside: () => documentHandlers.get('click')({ target: new FakeNode() }),
  };
}

test('an answered search is shown', async () => {
  const view = mount();
  const pending = view.type('records');
  view.answer(await view.searchCall(1), 'Records');
  await pending;
  assert.equal(view.results.hidden, false);
  assert.match(view.results.innerHTML, /Records/);
});

test('clearing the field keeps an answer that arrives later hidden', async () => {
  const view = mount();
  const pending = view.type('records');
  const call = await view.searchCall(1);
  await view.type('');
  assert.equal(view.results.hidden, true);
  view.answer(call, 'Stale');
  await pending;
  assert.equal(view.results.hidden, true, 'A search answered after the field was cleared reopened the results.');
  assert.doesNotMatch(view.results.innerHTML, /Stale/);
});

test('Escape keeps an answer that arrives later hidden', async () => {
  const view = mount();
  const pending = view.type('records');
  const call = await view.searchCall(1);
  view.escape();
  view.answer(call, 'Stale');
  await pending;
  assert.equal(view.results.hidden, true, 'A search answered after Escape reopened the results.');
});

test('a click outside keeps an answer that arrives later hidden', async () => {
  const view = mount();
  const pending = view.type('records');
  const call = await view.searchCall(1);
  view.clickOutside();
  assert.equal(view.results.hidden, true);
  view.answer(call, 'Stale');
  await pending;
  assert.equal(view.results.hidden, true, 'A search answered after an outside click reopened the results.');
});

test('dismissal while the result data is still loading keeps it hidden', async () => {
  const view = mount();
  const pending = view.type('records');
  const call = await view.searchCall(1);
  const data = deferred();
  call.answer.resolve({ results: [{ data: () => data.promise }] });
  await new Promise(done => setImmediate(done));
  view.escape();
  data.resolve({ url: '/nendo/docs/stale', meta: { title: 'Stale' }, excerpt: 'stale' });
  await pending;
  assert.equal(view.results.hidden, true, 'Result data that arrived after Escape reopened the results.');
});

test('a slower earlier search does not replace a newer answer', async () => {
  const view = mount();
  const older = view.type('rec');
  const olderCall = await view.searchCall(1);
  const newer = view.type('records');
  const newerCall = await view.searchCall(2);
  view.answer(newerCall, 'Newer');
  await newer;
  assert.match(view.results.innerHTML, /Newer/);
  view.answer(olderCall, 'Older');
  await older;
  assert.match(view.results.innerHTML, /Newer/, 'An older search answered last replaced the newer results.');
  assert.doesNotMatch(view.results.innerHTML, /Older/);
});
