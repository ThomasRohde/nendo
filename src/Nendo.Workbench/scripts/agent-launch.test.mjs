import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// ADR-0030 and W-199: Launch on the Agent page as tiles, behind the owner's design A tabs. A
// missing agent says what installs it, one found from a renamed package says so (2026-10-08: the
// owner's adapter had stopped at its last version under the old name and refused to start), a
// Copy shows that it ran, and any agent can be hidden on this computer ("at work we only have
// Copilot") and brought back.
const { agentTabsMarkup, copyButtonContent, copyHintMarkup, launchCopyText, launchTilesMarkup } = await bundleOf('src/agent-launch-model.ts');

const hostile = '<img src=x onerror="alert(1)">';

function agent(fields) {
  return {
    id: 'adapter', name: 'An adapter', commandLine: 'adapter-acp', found: true, package: '@new-scope/adapter-acp',
    installCommand: 'npm install -g @new-scope/adapter-acp', renamedFrom: null, updateCommand: null, ...fields,
  };
}

function offer(agents, fields = {}) {
  return { canLaunch: true, reason: null, agents, customCommandLine: null, running: null, hidden: [], ...fields };
}

function view(fields = {}) {
  return { canLaunch: true, running: null, showHidden: false, copyFor: () => null, ...fields };
}

const tile = (markup, id) => markup.match(new RegExp(`<li class="launch-tile[^"]*" data-agent-tile="${id}">[\\s\\S]*?</li>`))?.[0] ?? null;

test('a missing agent says what installs it and offers to copy that, not to launch', () => {
  const missing = agent({ found: false });
  const markup = tile(launchTilesMarkup(offer([missing]), view()), 'adapter');
  assert.match(markup, /class="launch-tile is-missing"/);
  assert.match(markup, /Not installed/);
  assert.match(markup, /<code class="launch-command-line">npm install -g @new-scope\/adapter-acp<\/code>/);
  assert.match(markup, /data-copy-agent="adapter"/);
  assert.doesNotMatch(markup, /data-launch-agent/);
  assert.equal(launchCopyText(missing), 'npm install -g @new-scope/adapter-acp');
});

test('an agent from a renamed package still launches and says how to move it', () => {
  const renamed = agent({ renamedFrom: '@old-scope/adapter-acp', updateCommand: 'npm uninstall -g @old-scope/adapter-acp\nnpm install -g @new-scope/adapter-acp' });
  const markup = tile(launchTilesMarkup(offer([renamed]), view()), 'adapter');
  assert.match(markup, /data-launch-agent="adapter" data-action >Launch/);
  assert.match(markup, /class="launch-renamed"/, 'The renamed package was not said.');
  assert.match(markup, /<code>@old-scope\/adapter-acp<\/code>, a package that was renamed/);
  assert.match(markup, /aria-label="Copy the commands that move An adapter to @new-scope\/adapter-acp"/);
  assert.equal(launchCopyText(renamed), 'npm uninstall -g @old-scope/adapter-acp\nnpm install -g @new-scope/adapter-acp');
});

test('the running agent comes first and opens its conversation; the others wait', () => {
  const agents = [agent({ id: 'one', name: 'One' }), agent({ id: 'two', name: 'Two' })];
  const markup = launchTilesMarkup(offer(agents), view({ running: { agentId: 'two', name: 'Two', label: 'Waiting for you to sign in' } }));
  assert.ok(markup.indexOf('data-agent-tile="two"') < markup.indexOf('data-agent-tile="one"'), 'The running agent is not first.');
  assert.match(tile(markup, 'two'), /is-running[\s\S]*Waiting for you to sign in[\s\S]*data-open-agent-chat/);
  assert.match(tile(markup, 'one'), /data-launch-agent="one" data-action disabled>/);
  assert.equal(launchCopyText(agent({})), null);
  assert.equal(launchCopyText(agent({ found: false, installCommand: null })), null, 'The person\'s own command has nothing to install.');
});

test('a hidden agent leaves Launch, is named in the line that brings it back, and returns faded when asked', () => {
  // W-199: "at work we only have Copilot".
  const agents = [agent({ id: 'copilot', name: 'GitHub Copilot CLI' }), agent({ id: 'claude', name: 'Claude Code' }), agent({ id: 'gemini', name: 'Gemini CLI', found: false })];
  const hidden = offer(agents, { hidden: ['claude', 'gemini', 'custom'] });
  const markup = launchTilesMarkup(hidden, view());
  assert.equal(tile(markup, 'claude'), null, 'A hidden agent is still shown.');
  assert.equal(tile(markup, 'gemini'), null, 'A hidden missing agent is still shown.');
  assert.equal(tile(markup, 'custom'), null, 'The hidden own command is still shown.');
  assert.match(tile(markup, 'copilot'), /data-agent-hide="copilot" aria-label="Hide GitHub Copilot CLI on this computer">Hide/);
  assert.match(markup, /3 hidden on this computer: Claude Code, Gemini CLI, Your own command\.<\/span><button class="text-button" type="button" data-toggle-hidden>Show hidden/);

  const shown = launchTilesMarkup(hidden, view({ showHidden: true }));
  assert.match(tile(shown, 'claude'), /class="launch-tile is-hidden"[\s\S]*data-agent-show="claude"[\s\S]*data-launch-agent="claude" data-action disabled>/,
    'A hidden agent shown to be brought back can be launched, or cannot be brought back.');
  assert.match(tile(shown, 'custom'), /is-custom is-hidden[\s\S]*data-agent-show="custom"/);
  assert.match(shown, /data-toggle-hidden>Done/);

  const running = launchTilesMarkup(offer(agents, { hidden: ['claude'] }), view({ running: { agentId: 'claude', name: 'Claude Code', label: 'Running' } }));
  assert.notEqual(tile(running, 'claude'), null, 'The running agent was hidden from view while it runs.');
  assert.match(launchTilesMarkup(offer([agent({ id: 'copilot' })], { hidden: ['copilot', 'custom'] }), view()), /Every agent is hidden on this computer/);
});

test('the tabs say what is behind them, and only the chosen one is selected', () => {
  const markup = agentTabsMarkup('launch', { pending: 2, running: 'Claude Code', endpoint: 'http://127.0.0.1:41763/mcp' });
  assert.deepEqual([...markup.matchAll(/data-agent-tab="(\w+)" aria-selected="(\w+)"/g)].map((match) => `${match[1]}:${match[2]}`),
    ['activity:false', 'launch:true', 'connect:false']);
  assert.match(markup, /Activity<span class="tab-badge">2 waiting<\/span>/);
  assert.match(markup, /Claude Code running/);
  assert.match(markup, /Connect<span class="tab-note">127\.0\.0\.1:41763<\/span>/);
  assert.match(markup, /id="agent-tab-launch"[^>]*aria-controls="agent-panel-launch" tabindex="0"/);
  assert.match(agentTabsMarkup('activity', { pending: 0, running: null, endpoint: null }), /Connect<span class="tab-note">Off<\/span>/);
});

test('a Copy that ran says so on its button and under it, and shows the text when it failed', () => {
  // The owner could not tell that anything had been copied: the words went to a screen reader only.
  const missing = agent({ found: false });
  const copied = tile(launchTilesMarkup(offer([missing]), view({ copyFor: () => ({ ok: true, text: missing.installCommand }) })), 'adapter');
  assert.match(copied, /class="launch-copy is-copied"[^>]*>.*<span>Copied<\/span><\/button>/s, 'The button does not say it copied.');
  assert.match(copied, /class="copy-hint" role="status">.*Copied to the clipboard\. Paste it into a terminal and run it, then open this page again\./s);

  const failed = tile(launchTilesMarkup(offer([missing]), view({ copyFor: () => ({ ok: false, text: missing.installCommand }) })), 'adapter');
  assert.doesNotMatch(failed, /is-copied/);
  assert.match(failed, /Copy failed\. Run this in a terminal, then open this page again:<\/span><code>npm install -g @new-scope\/adapter-acp<\/code>/);

  const renamed = agent({ renamedFrom: '@old-scope/adapter-acp', updateCommand: 'a\nb' });
  assert.match(launchTilesMarkup(offer([renamed]), view({ copyFor: () => ({ ok: true, text: 'a\nb' }) })), /class="launch-renamed">.*Copied to the clipboard/s);
  assert.doesNotMatch(launchTilesMarkup(offer([renamed]), view()), /copy-hint|Copied/, 'A tile nobody copied from says it copied.');
  assert.equal(copyHintMarkup(null, ' once'), '');
  assert.match(copyHintMarkup({ ok: true, text: 'x' }, ' once'), /run it once\./);
  assert.equal(copyButtonContent('Copy for <b>', null), 'Copy for &lt;b&gt;');
});

test('nothing the host names becomes markup', () => {
  const agents = [
    agent({ id: 'a', found: false, name: hostile, installCommand: `npm install -g ${hostile}` }),
    agent({ id: 'b', name: hostile, package: hostile, renamedFrom: hostile, updateCommand: hostile, commandLine: hostile }),
    agent({ id: 'custom', name: 'Your command', commandLine: hostile }),
  ];
  const markup = launchTilesMarkup(offer(agents, { customCommandLine: hostile, hidden: ['b'] }), view({ copyFor: () => ({ ok: false, text: hostile }) }))
    + launchTilesMarkup(offer(agents, { hidden: ['a', 'b'] }), view({ showHidden: true, running: { agentId: 'b', name: hostile, label: hostile } }))
    + agentTabsMarkup('connect', { pending: 1, running: hostile, endpoint: hostile });
  assert.doesNotMatch(markup, /<img/);
});
