import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// ADR-0030: the rows under Launch on the Agent page. A missing agent says what installs it, and one
// found from a package that was renamed and left behind says so (2026-10-08: the owner's adapter
// had stopped at its last version under the old name and refused to start).
const { copyButtonContent, copyHintMarkup, launchCopyText, launchRowMarkup } = await bundleOf('src/agent-launch-model.ts');

const hostile = '<img src=x onerror="alert(1)">';

function agent(fields) {
  return {
    id: 'adapter', name: 'An adapter', commandLine: 'adapter-acp', found: true, package: '@new-scope/adapter-acp',
    installCommand: 'npm install -g @new-scope/adapter-acp', renamedFrom: null, updateCommand: null, ...fields,
  };
}

test('a missing agent says what installs it and offers to copy that, not to launch', () => {
  const missing = agent({ found: false });
  const markup = launchRowMarkup(missing, true);
  assert.match(markup, /Not installed · npm install -g @new-scope\/adapter-acp/);
  assert.match(markup, /data-copy-agent="adapter"/);
  assert.doesNotMatch(markup, /data-launch-agent/);
  assert.equal(launchCopyText(missing), 'npm install -g @new-scope/adapter-acp');
});

test('an agent from a renamed package still launches and says how to move it', () => {
  const renamed = agent({ renamedFrom: '@old-scope/adapter-acp', updateCommand: 'npm uninstall -g @old-scope/adapter-acp\nnpm install -g @new-scope/adapter-acp' });
  const markup = launchRowMarkup(renamed, true);
  assert.match(markup, /data-launch-agent="adapter" data-action >/);
  assert.match(markup, /class="launch-renamed"/, 'The renamed package was not said.');
  assert.match(markup, /<code>@old-scope\/adapter-acp<\/code>, a package that was renamed/);
  assert.match(markup, /aria-label="Copy the commands that move An adapter to @new-scope\/adapter-acp"/);
  assert.equal(launchCopyText(renamed), 'npm uninstall -g @old-scope/adapter-acp\nnpm install -g @new-scope/adapter-acp');
});

test('an agent from the package still updated says nothing more, and waits while one runs', () => {
  const current = agent({});
  const markup = launchRowMarkup(current, false);
  assert.doesNotMatch(markup, /launch-renamed|data-copy-agent/);
  assert.match(markup, /data-action disabled>/);
  assert.equal(launchCopyText(current), null);
  assert.equal(launchCopyText(agent({ found: false, installCommand: null })), null, 'The person\'s own command has nothing to install.');
});

test('a Copy that ran says so on its button and under it, and shows the text when it failed', () => {
  // The owner could not tell that anything had been copied: the words went to a screen reader only.
  const missing = agent({ found: false });
  const copied = launchRowMarkup(missing, true, { ok: true, text: missing.installCommand });
  assert.match(copied, /class="launch-copy is-copied"[^>]*>.*<span>Copied<\/span><\/button>/s, 'The button does not say it copied.');
  assert.match(copied, /class="copy-hint" role="status">.*Copied to the clipboard\. Paste it into a terminal and run it, then open this page again\./s);

  const failed = launchRowMarkup(missing, true, { ok: false, text: missing.installCommand });
  assert.doesNotMatch(failed, /is-copied/);
  assert.match(failed, /Copy failed\. Run this in a terminal, then open this page again:<\/span><code>npm install -g @new-scope\/adapter-acp<\/code>/);

  const renamed = agent({ renamedFrom: '@old-scope/adapter-acp', updateCommand: 'a\nb' });
  assert.match(launchRowMarkup(renamed, true, { ok: true, text: 'a\nb' }), /class="launch-renamed">.*Copied to the clipboard/s);
  assert.doesNotMatch(launchRowMarkup(renamed, true), /copy-hint|Copied/, 'A row nobody copied from says it copied.');
  assert.equal(copyHintMarkup(null, ' once'), '');
  assert.match(copyHintMarkup({ ok: true, text: 'x' }, ' once'), /run it once\./);
  assert.equal(copyButtonContent('Copy for <b>', null), 'Copy for &lt;b&gt;');
});

test('nothing the host names becomes markup', () => {
  const markup = launchRowMarkup(agent({ found: false, name: hostile, installCommand: `npm install -g ${hostile}` }), true)
    + launchRowMarkup(agent({ name: hostile, package: hostile, renamedFrom: hostile, updateCommand: hostile }), true)
    + launchRowMarkup(agent({ found: false, installCommand: hostile }), true, { ok: false, text: hostile });
  assert.doesNotMatch(markup, /<img/);
});
