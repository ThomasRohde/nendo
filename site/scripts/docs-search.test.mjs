// The documentation search answers a query over several awaits: loading Pagefind, the
// debounced search, then each result's data. The reader can type again, clear the
// field or dismiss the panel while any of them is pending, and an answer that arrives
// afterwards must not reopen the panel or replace a newer answer.
//
// This runs the component's own <script>, transpiled in memory, against a stand-in for
// the elements it touches and a Pagefind whose every answer is held until the test
// releases it. It also measures which excerpt markup reaches the rendered results, the
// combobox state a screen reader hears, what Escape leaves behind, which section a
// result opens at, and whether a failed load of Pagefind is tried again. Nothing is
// built and no browser is started; tools/Gate-SiteSearch.mjs drives the built site.
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
// A pagefind.js whose download failed: importing it rejects.
const unreachableModule = 'data:text/javascript,' + encodeURIComponent('throw new Error("offline");');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

class FakeNode {}

// An element that keeps its attributes, so a test can read what the component set.
function element(properties) {
  const attributes = new Map();
  return Object.assign(new FakeNode(), {
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: name => attributes.get(name) ?? null,
  }, properties);
}

function mount({ pagefindBase = pagefindModule } = {}) {
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
  const input = element({
    value: '',
    blurs: 0,
    dataset: { pagefindBase },
    addEventListener: (name, handler) => inputHandlers.set(name, handler),
    blur: () => { input.blurs += 1; },
    focus: () => {},
  });
  const results = element({
    hidden: true,
    innerHTML: '',
    contains: node => node === results,
    addEventListener: () => {},
    querySelectorAll: () => [],
  });
  const status = element({ textContent: '' });
  const elements = { '#docs-search-input': input, '.docs-search-results': results, '.docs-search-status': status };
  const document = {
    querySelector: selector => elements[selector] ?? null,
    addEventListener: (name, handler) => documentHandlers.set(name, handler),
    activeElement: null,
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
    input, results, status, type, searchCall, answer,
    // A component with no focusout listener simply does nothing when the focus leaves.
    leave: relatedTarget => inputHandlers.get('focusout')?.({ relatedTarget }),
    escape: () => {
      const event = { key: 'Escape', defaultPrevented: false, preventDefault() { event.defaultPrevented = true; } };
      inputHandlers.get('keydown')(event);
      return event;
    },
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

test('search excerpts keep match highlights and strip other markup', async () => {
  const view = mount();
  const pending = view.type('record');
  const call = await view.searchCall(1);
  call.answer.resolve({
    results: [{ data: async () => ({
      url: '/nendo/docs/records',
      meta: { title: 'Records' },
      excerpt: '<p>Open <a href="/nendo/docs/records"><mark>record</mark></a> in <strong>Studio</strong>; <marking>other markup</marking>.</p>',
    }) }],
  });
  await pending;
  assert.match(view.results.innerHTML, /<mark>record<\/mark>/,
    'The search excerpt stripped Pagefind match highlighting.');
  assert.equal(view.results.innerHTML,
    '<a href="/nendo/docs/records" role="option" id="docs-search-option-0" tabindex="-1" aria-selected="false"><strong>Records</strong><span>Open <mark>record</mark> in Studio; other markup.</span></a>',
    'The search excerpt retained markup other than its match highlight.');
});

test('the combobox says when its results are open, and the status line says what was found', async () => {
  const view = mount();
  const pending = view.type('records');
  view.answer(await view.searchCall(1), 'Records');
  await pending;
  assert.equal(view.input.getAttribute('aria-expanded'), 'true',
    'Results are showing but the search field does not say its list is expanded.');
  assert.match(view.status.textContent, /1 result/,
    'Results arrived and the live status line announced nothing.');
  view.escape();
  assert.equal(view.input.getAttribute('aria-expanded'), 'false',
    'The results were dismissed but the search field still says its list is expanded.');
});

test('Escape closes the results and keeps the query and the focus', async () => {
  const view = mount();
  const pending = view.type('lease');
  view.answer(await view.searchCall(1), 'Agents');
  await pending;
  const event = view.escape();
  assert.equal(view.results.hidden, true, 'Escape did not close the results.');
  assert.equal(event.defaultPrevented, true,
    "Escape was left to the browser, whose default on a search field wipes the reader's query.");
  assert.equal(view.input.value, 'lease', "Escape wiped the reader's query.");
  assert.equal(view.input.blurs, 0, 'Escape moved the focus out of the search field.');
});

test('focus leaving the field closes the results', async () => {
  const view = mount();
  const pending = view.type('records');
  view.answer(await view.searchCall(1), 'Records');
  await pending;
  view.leave(view.results);
  assert.equal(view.results.hidden, false, 'Moving into the results closed them.');
  view.leave(new FakeNode());
  assert.equal(view.results.hidden, true, 'The focus left the search field and the results stayed open.');
  assert.equal(view.input.getAttribute('aria-expanded'), 'false',
    'The focus left the search field and it still says its list is expanded.');
});

test('a result opens at the section that matched', async () => {
  const view = mount();
  const pending = view.type('lease');
  const call = await view.searchCall(1);
  call.answer.resolve({
    results: [{ data: async () => ({
      url: '/nendo/docs/agents/',
      meta: { title: 'Agents' },
      excerpt: 'whole page',
      sub_results: [
        { title: 'Agents', url: '/nendo/docs/agents/', excerpt: 'top', weighted_locations: [{ balanced_score: 1 }] },
        { title: 'The lease', url: '/nendo/docs/agents/#the-lease', excerpt: 'take the <mark>lease</mark>', weighted_locations: [{ balanced_score: 9 }, { balanced_score: 4 }] },
        { title: 'Writing data', url: '/nendo/docs/agents/#writing-data', excerpt: 'one <mark>lease</mark>', weighted_locations: [{ balanced_score: 2 }] },
      ],
    }) }],
  });
  await pending;
  assert.match(view.results.innerHTML, /href="\/nendo\/docs\/agents\/#the-lease"/,
    'The result links to the top of the guide instead of the section that matched.');
  assert.match(view.results.innerHTML, /Agents › The lease/, 'The result does not name the section it opens at.');
});

test('a failed load of Pagefind is tried again on the next keystroke', async () => {
  const view = mount({ pagefindBase: unreachableModule });
  await view.type('records');
  assert.equal(view.results.hidden, false, 'A failed load of Pagefind said nothing.');
  assert.match(view.results.innerHTML, /Search could not load\. Try again\./,
    'A failed load on the built site blamed the build instead of asking the reader to try again.');
  view.input.dataset.pagefindBase = pagefindModule;
  const pending = view.type('records');
  const call = await view.searchCall(1).catch(() => assert.fail(
    'After one failed load of Pagefind, search stayed dead until the page was reloaded: the next keystroke never reached Pagefind.'));
  view.answer(call, 'Records');
  await pending;
  assert.match(view.results.innerHTML, /Records/,
    'After one failed load of Pagefind, search stayed dead until the page was reloaded.');
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
