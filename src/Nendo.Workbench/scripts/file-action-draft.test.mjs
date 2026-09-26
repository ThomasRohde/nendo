import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

// R-010: typing in a record form, choosing File -> Open file and cancelling the picker lost
// the typing. The host answers a cancelled dialog with the same session and no notice, and
// the outcome redrew the page anyway, which discards the form it replaces. The real
// file-actions.ts runs here with the host, the page and the redraw replaced by stand-ins, and
// the real draft rules (app-state, draft-guard, draft-state) deciding.
const root = fileURLToPath(new URL('..', import.meta.url));
const page = { rerenders: 0, chrome: 0, errors: [], requests: [], retained: [], recovered: 0, reply: null, notice: { textContent: '', hidden: true } };
globalThis.fileActionPage = page;
const stubs = {
  './client': `export const client = { mode: 'desktop',
    request: async (method, payload) => { const p = globalThis.fileActionPage; p.requests.push(method); return p.reply(method, payload); },
    openDroppedFile: async () => { const p = globalThis.fileActionPage; p.requests.push('file.openDropped'); return p.reply('file.openDropped'); } };`,
  './shell': `const p = () => globalThis.fileActionPage;
    export const content = { querySelectorAll: () => [] };
    export const announce = () => {}; export const clearError = () => {}; export const setBusy = () => {};
    export const showError = (message) => p().errors.push(message);
    export const rerender = () => { p().rerenders += 1; };
    export const refreshChrome = () => { p().chrome += 1; };
    export const interactionInProgress = () => false;
    export const requiredElement = (selector) => selector === '#file-notice' ? p().notice : { open: false, addEventListener() {} };`,
  './actions': `const p = () => globalThis.fileActionPage;
    export const openHelp = async () => {}; export const refreshDerived = async () => {}; export const resetFileView = () => {};
    export const showOutcomeRefreshNotice = () => {};
    export const recoverAfterWriteFailure = async () => { p().recovered += 1; };
    export const retainDraftReadOnly = (reason) => { p().retained.push(reason); };`,
  './view-packages': 'export const openCustomViews = async () => {};',
};
const entry = [
  `export * from ${JSON.stringify(resolve(root, 'src/file-actions.ts'))};`,
  `export { state } from ${JSON.stringify(resolve(root, 'src/app-state.ts'))};`,
].join('\n');
const bundle = await build({
  root, configFile: false, logLevel: 'error',
  plugins: [{
    name: 'file-action-stubs', enforce: 'pre',
    resolveId(id) { if (id.endsWith('file-action-entry')) return '\0file-action-entry'; if (id in stubs) return `\0stub${id}`; return null; },
    load(id) { if (id === '\0file-action-entry') return entry; if (id.startsWith('\0stub')) return stubs[id.slice(5)]; return null; },
  }],
  build: { ssr: 'file-action-entry', write: false, rollupOptions: { output: { codeSplitting: false } } },
});
const f = await import('data:text/javascript;base64,' + Buffer.from(bundle.output.find((item) => item.type === 'chunk').code).toString('base64'));

const session = (overrides = {}) => ({
  ...f.state.session, fileSessionId: 'session-1', fileName: 'Work.nendo', hasFile: true,
  capabilities: { ...f.state.session.capabilities, mutate: true, backup: true }, manifest: { changeSequence: 5 }, ...overrides,
});

/** A record page with typing in it: the title field differs from what is stored. */
function typedDraft() {
  Object.assign(page, { rerenders: 0, chrome: 0, errors: [], requests: [], retained: [], recovered: 0 });
  f.state.actionInFlight = false;
  f.state.session = session();
  const edited = new Set(['title']);
  f.state.openDraft = { session: { fileSessionId: 'session-1', canMutate: true }, edited };
  return f.state.openDraft;
}

function assertKept(draft, what) {
  assert.equal(page.rerenders, 0, `${what} redrew the page, and the redraw discards the unsaved form.`);
  assert.equal(f.state.openDraft, draft, `${what} dropped the draft.`);
  assert.deepEqual([...draft.edited], ['title'], `${what} lost track of the edited field.`);
}

test('a cancelled Backup, Export, Duplicate or Import dialog leaves unsaved typing on screen and still edited', async () => {
  for (const method of ['file.backup', 'file.exportCsv', 'file.export', 'file.duplicate', 'file.fork', 'file.importCsv']) {
    const draft = typedDraft();
    // What the host answers when the person cancels its dialog: the same session, no notice.
    page.reply = () => ({ session: session(), notice: null });
    await f.runFileAction(method);
    assert.deepEqual(page.requests, [method]);
    assertKept(draft, `Cancelling ${method}`);
    assert.equal(page.retained.length, 0, `Cancelling ${method} locked a form that can still be saved.`);
  }
});

test('a finished backup says so without redrawing the form, and a file that turned read-only keeps the typing locked', async () => {
  let draft = typedDraft();
  page.reply = () => ({ session: session(), notice: 'Backup created.' });
  await f.runFileAction('file.backup');
  assertKept(draft, 'A finished backup');
  assert.equal(page.notice.textContent, 'Backup created.');
  assert.equal(page.notice.hidden, false);

  draft = typedDraft();
  page.reply = () => ({ session: session({ capabilities: { ...session().capabilities, mutate: false } }), notice: null });
  await f.runFileAction('file.backup');
  assert.equal(page.rerenders, 0, 'The typing was redrawn away when the file stopped being editable.');
  assert.deepEqual(page.retained, ['read-only']);
});

test('Open file, New file, Close, Restore and a dropped file are declined over unsaved typing before the host is asked', async () => {
  for (const [what, run] of [
    ['Open file', () => f.chooseFile('session.openFile', null)],
    ['New file', () => f.chooseFile('session.createFile', null)],
    ['Close file', () => f.runFileAction('file.close')],
    ['Restore backup', () => f.runFileAction('file.restore')],
    ['a dropped file', () => f.openDroppedFile({ name: 'Other.nendo' })],
  ]) {
    const draft = typedDraft();
    page.reply = () => { throw new Error(`${what} reached the host.`); };
    await run();
    assert.deepEqual(page.requests, [], `${what} asked the host while the form held unsaved typing.`);
    assert.equal(page.errors.length, 1, `${what} was declined without saying why.`);
    assert.match(page.errors[0], /^Save your changes or close record details before (opening another file|closing the file)\.$/);
    assertKept(draft, what);
  }
});

test('a file action the host refuses leaves the unsaved typing alone', async () => {
  const draft = typedDraft();
  page.reply = (method) => {
    if (method === 'session.getSnapshot') return session();
    throw new Error('The backup location is not writable.');
  };
  await f.runFileAction('file.backup');
  assertKept(draft, 'A refused backup');
  assert.equal(page.recovered, 0, 'The general recovery ran, and it redraws the page.');
  assert.deepEqual(page.errors, ['The backup location is not writable.']);
});

test('without unsaved typing, a cancelled Open file still refreshes the page as before', async () => {
  typedDraft();
  f.state.openDraft = null;
  page.reply = () => ({ session: session(), notice: null });
  await f.chooseFile('session.openFile', null);
  assert.deepEqual(page.requests, ['session.openFile']);
  assert.equal(page.rerenders, 1);
});
