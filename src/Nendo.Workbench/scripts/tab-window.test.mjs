import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { bundleOf } from './bundle-of.mjs';

// W-277 (ADR-0002, 2026-10-16): a tab dragged out of the strip moves to a window of its own. The
// moves on the tabs are held here; the host's half is held by DesktopTabWindowTests, and the
// second window by the tab-window journey.
const { dragState, dragThreshold, leaveMargin, putTabBack, readTabTrail, trailOfTab } = await bundleOf('src/tab-set.ts');
const { createTrail } = await bundleOf('src/navigation-trail.ts');
const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

const place = (title) => ({ view: 'use', eyebrow: 'Use · Work', title, applicationEntityId: 'work', studioEntityId: null, showOverview: false,
  fileView: null, surfaceId: title, recordId: null, returnTo: null, drill: null, tabs: [], calendar: null, timeline: null, helpTopicId: '',
  proposalId: null, agentProposalId: null, proposalReturnView: null, viewPlaces: [] });

test('a press is a press until it moves, a drag inside the window stays, and one let go past its edge leaves', () => {
  assert.equal(dragState(100, 20, 100 + dragThreshold - 1, 20, 1600, 900), 'press', 'a press that wobbled became a drag');
  assert.equal(dragState(100, 20, 400, 30, 1600, 900), 'inside');
  // Past the edge by less than the margin is still the window: the band's own edge is not a drop.
  assert.equal(dragState(100, 20, 100, -leaveMargin, 1600, 900), 'inside');
  for (const [x, y] of [[100, -leaveMargin - 1], [-leaveMargin - 1, 20], [1600 + leaveMargin + 1, 20], [100, 900 + leaveMargin + 1], [-300, -200]])
    assert.equal(dragState(100, 20, x, y, 1600, 900), 'out', `let go at ${x}, ${y} did not leave the window`);
});

test('the trail that moves is the window trail for the tab on screen and the saved one for another, and a lone tab stays', () => {
  const trail = createTrail();
  trail.record(place('Board'));
  trail.record(place('List'));
  const other = { places: [place('Calendar')], cursor: 0 };
  const set = { tabs: [{ id: 1, saved: null }, { id: 2, saved: other }], active: 0 };
  const onScreen = trailOfTab(set, 0, trail);
  assert.deepEqual(onScreen?.places.map((entry) => entry.title), ['Board', 'List'], 'the tab on screen moved without its Back');
  assert.equal(onScreen?.cursor, 1);
  assert.equal(trailOfTab(set, 1, trail), other);
  assert.equal(trailOfTab({ tabs: [{ id: 1, saved: null }], active: 0 }, 0, trail), null, 'a window gave up its only tab');
  assert.equal(trailOfTab({ tabs: [{ id: 1, saved: null }, { id: 2, saved: { places: [], cursor: -1 } }], active: 0 }, 1, trail), null,
    'a tab with no place to show opened a window on nothing');
  assert.equal(trailOfTab(set, 5, trail), null);
});

test('a tab whose window did not open goes back where it stood, and the tab on screen stays on screen', () => {
  const saved = { places: [place('Calendar')], cursor: 0 };
  const before = { tabs: [{ id: 1, saved: null }, { id: 3, saved: null }], active: 1 };
  putTabBack(before, 1, { id: 2, saved: null }, saved);
  assert.deepEqual(before.tabs.map((tab) => tab.id), [1, 2, 3]);
  assert.equal(before.active, 2, 'the tab on screen changed under a failed move');
  assert.equal(before.tabs[1].saved, saved, 'the tab came back without its places');
  const after = { tabs: [{ id: 1, saved: null }], active: 0 };
  putTabBack(after, 9, { id: 2, saved: null }, saved);
  assert.deepEqual(after.tabs.map((tab) => tab.id), [1, 2]);
  assert.equal(after.active, 0);
});

test('a window reads back only a trail with places and a cursor among them', () => {
  const sent = { places: [place('Board'), place('List')], cursor: 1 };
  assert.deepEqual(readTabTrail(JSON.stringify(sent)), sent);
  for (const bad of ['', 'not json', 'null', '[]', '{"places":[],"cursor":0}', '{"places":[{"view":"use"}],"cursor":1}',
    '{"places":[{"view":"use"}],"cursor":-1}', '{"places":[{"view":"use"}],"cursor":0.5}', '{"places":[{}],"cursor":0}', '{"places":"x","cursor":0}'])
    assert.equal(readTabTrail(bad), null, `${bad} was taken as a trail`);
});

test('moving a tab is not closing it: no closed-tab listener hears it, so a launched agent keeps running', () => {
  const tabs = source('../src/workspace-tabs.ts');
  const move = tabs.slice(tabs.indexOf('export async function moveTabToWindow'), tabs.indexOf('export function moveActiveTabToWindow'));
  assert.ok(move.includes('closeTabAt('), 'the move does not take the tab out of the window');
  assert.ok(!move.includes('closedListeners') && !move.includes('closeTab('), 'the move tells the closed-tab listeners, which end the agent');
  assert.match(move, /window\.detachTab/);
  assert.match(move, /putTabBack\(/, 'a window that did not open lost the tab');
});

test('the main window alone offers the file actions that switch the file, and the host refuses the same set', () => {
  const role = source('../src/window-role.ts');
  const page = new Set([...role.slice(role.indexOf('mainWindowOnly')).matchAll(/'([a-zA-Z.]+)'/g)].map((match) => match[1]));
  const host = source('../../Nendo.Desktop/WorkbenchProtocol.TabWindows.cs');
  const block = host.slice(host.indexOf('MainWindowOnly ='), host.indexOf('};', host.indexOf('MainWindowOnly =')));
  const names = [...block.matchAll(/WorkbenchMethods\.(\w+)/g)].map((match) => match[1]);
  const constants = ['WorkbenchProtocol.cs', 'WorkbenchFileActions.cs'].map((file) => source(`../../Nendo.Desktop/${file}`)).join('\n');
  const methods = new Set(names.map((name) => {
    const found = constants.match(new RegExp(`const string ${name} = "([^"]+)"`));
    assert.ok(found, `WorkbenchMethods.${name} is not declared where the test reads`);
    return found[1];
  }));
  assert.ok(methods.size >= 10, `the host refuses only ${methods.size} file actions in a tab window`);
  assert.deepEqual([...page].sort(), [...methods].sort(), 'the page and the host disagree on which file actions are the main window\'s');
  const menu = source('../src/file-actions.ts');
  assert.match(menu, /mainWindowOnly\.has\(method\)/, 'the File menu offers a tab window the actions the host refuses');
});

test('a tab window asks its role before it has a file session of its own, as the host answers it', () => {
  const desktop = source('../src/host-desktop.ts');
  assert.match(desktop, /independentMethods = new Set\(\[[^\]]*'window\.takeTab'/, 'window.takeTab is checked against a file session the host does not bind');
  const host = source('../../Nendo.Desktop/WorkbenchProtocol.cs');
  assert.match(host, /or WorkbenchMethods\.WindowTakeTab;/);
  assert.doesNotMatch(host.slice(host.indexOf('var independent ='), host.indexOf('var expectedSession')), /WindowDetachTab/,
    'a tab of one file session could open a window on another');
});
