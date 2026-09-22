import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

// The indicator lives in index.html, shell.ts and one stylesheet, and the event that
// drives it crosses three more files. None of it goes through a markup function, so this
// pairs the sources the way rail-collapse.test.mjs does — what is on screen, what turns
// it on, and what carries the signal to it.
const shell = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../src/shell.ts', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles/07-studio.css', import.meta.url), 'utf8');
const desktop = readFileSync(new URL('../src/host-desktop.ts', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const agentView = readFileSync(new URL('../src/view-agent.ts', import.meta.url), 'utf8');

test('the indicator is in the status bar, which is on every screen', () => {
  // Not the Agent page. A person whose window has stopped answering is somewhere else,
  // which is the whole reason this exists.
  const statusBar = shell.slice(shell.indexOf('<footer id="session-status"'), shell.indexOf('</footer>'));
  assert.match(statusBar, /id="agent-working"/, 'the status bar has no agent indicator');
  assert.match(statusBar, /id="agent-working-text"/, 'the indicator has no text node to write into');
  const pill = statusBar.slice(statusBar.indexOf('id="agent-working"'));
  assert.match(pill.slice(0, pill.indexOf('>')), /data-state="agent"/);
  // Hidden until something is happening, or an idle file reads as a busy one.
  assert.match(pill.slice(0, pill.indexOf('>')), /hidden/);
});

test('it appears only after the same wait the busy bar uses', () => {
  const setter = script.slice(script.indexOf('export function setAgentWork'));
  const body = setter.slice(0, setter.indexOf('\n}'));
  // A read takes a few milliseconds and a build makes hundreds of them. Reporting every
  // one would leave the corner of the window flickering for the whole of a session.
  assert.match(body, /busyBarDelayMs/, 'the pill is drawn without the delay the busy bar uses');
});

test('the countdown is neither restarted by a call nor cancelled by the gap before it', () => {
  // Both were tried and both had the same result: a burst of calls each shorter than
  // 700ms never reached the delay, and a real unattended build -- 27 signals, an accepted
  // proposal and an import -- ran from start to finish behind an empty status bar.
  const setter = script.slice(script.indexOf('export function setAgentWork'));
  const body = setter.slice(0, setter.indexOf('\n}'));
  assert.doesNotMatch(body, /clearTimeout\(agentPillTimer\)/,
    'something cancels the timer that counts how long the agent has been working');
  assert.match(body, /if \(!work\.busy \|\| agentPillTimer !== null\) return;/,
    'a second call restarts the countdown instead of leaving the first one running');
});

test('nothing appears for work that finished inside the wait', () => {
  const setter = script.slice(script.indexOf('export function setAgentWork'));
  const body = setter.slice(0, setter.indexOf('\n}'));
  assert.match(body, /if \(!agentWork\.busy && Date\.now\(\) - lastAgentWorkAt >= agentIdleMs\) return;/,
    'the pill can appear after the agent has already stopped');
});

test('it comes down after the agent goes quiet, and no later', () => {
  // A gap between two calls must not blink the status bar; an agent that has stopped
  // must not leave it up. Both, which means a bounded wait rather than either extreme.
  assert.match(script, /const agentIdleMs = 1_200;/);
  const hide = script.slice(script.indexOf('function hideTheAgentPillSoon'));
  assert.match(hide.slice(0, hide.indexOf('\n}')), /agentPillShown = false;[\s\S]*?\}, agentIdleMs\);/);
  const setter = script.slice(script.indexOf('export function setAgentWork'));
  const body = setter.slice(0, setter.indexOf('\n}'));
  assert.match(body, /if \(work\.busy\) \{[\s\S]*?window\.clearTimeout\(agentPillHideTimer\)/,
    'a new call does not cancel the pending hide, so the pill blinks between two calls');
});

test('the wait names its cause instead of saying the host is slow', () => {
  const busy = script.slice(script.indexOf('export function setBusyBar'));
  const body = busy.slice(0, busy.indexOf('\n}'));
  assert.match(body, /agentWork\.busy/, 'the busy bar cannot tell an agent write from a slow read');
  assert.match(body, /is writing to this file/);
  assert.match(body, /Still working/, 'the ordinary wait lost its own sentence');
  // Stop keeps its meaning. It stops waiting for this view; the thing that stops the
  // agent is Revoke edit access, which the pill's own title points at.
  const draw = script.slice(script.indexOf('function drawAgentPill'));
  assert.match(draw.slice(0, draw.indexOf('\n}')), /Revoke edit access/);
});

test('the signal is validated at the renderer rather than trusted', () => {
  const receive = desktop.slice(desktop.indexOf("if (message.event === 'agentActivity')"));
  const body = receive.slice(0, receive.indexOf('return;'));
  assert.match(body, /typeof work\.busy !== 'boolean'/);
  assert.match(body, /work\.client\.length > 200/, 'a client name is drawn as text and is not bounded');
  assert.match(body, /work\.activity\.length > 260/);
});

test('the renderer listens for it without waiting for a render pass', () => {
  // It has to appear while a request is queued behind an agent's write, which is exactly
  // when a render cannot run. So it is drawn by the shell, not by a view.
  assert.match(main, /client\.onAgentActivity\?\.\(\(work\) => \{ setAgentWork\(work\); \}\);/);
});

test('the pill reads as activity rather than as a fault, and respects reduced motion', () => {
  assert.match(styles, /\.status-pill\[data-state="agent"\] \{[^}]*color: var\(--cobalt\)/);
  assert.match(styles, /@keyframes agent-working-pulse/);
  const reduced = styles.slice(styles.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.status-pill\[data-state="agent"\] > span:first-child \{ animation: none; \}/);
});

test('the access ladder does not claim a review the chosen level has given up', () => {
  // The fixed sentence said the person reviews every proposed change. At Unattended they
  // review none, so the panel contradicted the level standing beside it -- on the one
  // screen whose whole job is to say what has been given away.
  const intro = agentView.slice(agentView.indexOf('function ladderIntro'));
  const body = intro.slice(0, intro.indexOf('\n}'));
  assert.match(body, /mode === 'unattended'/, 'the ladder says the same thing at every level');
  assert.match(body, /you review nothing/i);
  // And the heading is written from the mode rather than baked into the markup.
  assert.match(agentView, /ladderIntro\(status\.mode\)/);
});
