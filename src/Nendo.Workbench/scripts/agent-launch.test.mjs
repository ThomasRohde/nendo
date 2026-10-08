import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// ADR-0030: the rows under Launch on the Agent page. A missing agent says what installs it, and one
// found from a package that was renamed and left behind says so (2026-10-08: the owner's adapter
// had stopped at its last version under the old name and refused to start).
const { launchCopyText, launchRowMarkup } = await bundleOf('src/agent-launch-model.ts');

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

test('nothing the host names becomes markup', () => {
  const markup = launchRowMarkup(agent({ found: false, name: hostile, installCommand: `npm install -g ${hostile}` }), true)
    + launchRowMarkup(agent({ name: hostile, package: hostile, renamedFrom: hostile, updateCommand: hostile }), true);
  assert.doesNotMatch(markup, /<img/);
});
