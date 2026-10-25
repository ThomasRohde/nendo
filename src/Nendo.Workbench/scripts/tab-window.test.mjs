import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { bundleOf } from './bundle-of.mjs';

// ADR-0002: a tab dragged out of the strip moves to a window of its own. The
// moves on the tabs are held here; the host's half is held by DesktopTabWindowTests, and the
// second window by the tab-window journey.
const { arrivalIndex, dragState, dragThreshold, leaveMargin, moveTab, pullDistance, putTabBack, readTabTrail, slotFor, trailOfTab } = await bundleOf('src/tab-set.ts');
const { createTrail } = await bundleOf('src/navigation-trail.ts');
const source = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

const place = (title) => ({ view: 'use', eyebrow: 'Use · Work', title, applicationEntityId: 'work', studioEntityId: null, showOverview: false,
  fileView: null, surfaceId: title, recordId: null, returnTo: null, drill: null, tabs: [], calendar: null, timeline: null, helpTopicId: '',
  proposalId: null, agentProposalId: null, proposalReturnView: null, viewPlaces: [] });

test('a press is a press until it moves, a drag along the strip stays, and one let go past the edge or pulled down leaves', () => {
  const strip = 48;
  assert.equal(dragState(100, 20, 100 + dragThreshold - 1, 20, 1600, 900, strip), 'press', 'a press that wobbled became a drag');
  assert.equal(dragState(100, 20, 400, 30, 1600, 900, strip), 'inside');
  // Past the edge by less than the margin is still the window: the band's own edge is not a drop.
  assert.equal(dragState(100, 20, 100, -leaveMargin, 1600, 900, strip), 'inside');
  for (const [x, y] of [[100, -leaveMargin - 1], [-leaveMargin - 1, 20], [1600 + leaveMargin + 1, 20], [100, 900 + leaveMargin + 1], [-300, -200]])
    assert.equal(dragState(100, 20, x, y, 1600, 900, strip), 'out', `let go at ${x}, ${y} did not leave the window`);
  // A window that fills the screen has no edge to drag past. A tab pulled down
  // into the page leaves; one dragged along the strip, or a little below it, stays.
  const screen = [2560, 1392];
  assert.equal(dragState(770, 30, 770, strip + pullDistance, ...screen, strip), 'inside', 'a tab just below the strip left the window');
  assert.equal(dragState(770, 30, 970, strip + pullDistance + 1, ...screen, strip), 'out', 'a tab pulled down in a full-screen window stayed in it');
  assert.equal(dragState(770, 30, 970, 430, ...screen, strip), 'out', 'a tab pulled down in a full-screen window stayed in it');
  assert.equal(dragState(770, 30, 1900, 40, ...screen, strip), 'inside', 'a tab dragged along the strip left the window');
});

test("a tab dragged along the strip takes a neighbour's place past its middle, and the tab on screen stays on screen", () => {
  // Three tabs 100 wide with 4 between them, from 8.
  const spans = [{ left: 8, width: 100 }, { left: 112, width: 100 }, { left: 216, width: 100 }];
  assert.equal(slotFor(spans, 0, 8), 0, 'a tab that has not moved moved');
  assert.equal(slotFor(spans, 0, 8 + 50), 0, "a tab short of its neighbour's middle took its place");
  assert.equal(slotFor(spans, 0, 8 + 60), 1, "a tab past its neighbour's middle kept its place");
  assert.equal(slotFor(spans, 0, 260), 2, 'a tab dragged past two kept to the first');
  assert.equal(slotFor(spans, 2, 216 - 50), 2);
  assert.equal(slotFor(spans, 2, 216 - 60), 1);
  assert.equal(slotFor(spans, 2, -40), 0, 'a tab dragged past the first did not go first');

  const set = { tabs: [{ id: 1, saved: null }, { id: 2, saved: null }, { id: 3, saved: null }], active: 1 };
  assert.equal(moveTab(set, 0, 2), true);
  assert.deepEqual(set.tabs.map((tab) => tab.id), [2, 3, 1]);
  assert.equal(set.tabs[set.active].id, 2, 'the tab on screen changed when another one moved');
  assert.equal(moveTab(set, 0, 9), true, 'a move past the end was refused rather than kept to it');
  assert.deepEqual(set.tabs.map((tab) => tab.id), [3, 1, 2]);
  assert.equal(set.tabs[set.active].id, 2);
  assert.equal(moveTab(set, 1, 1), false);
  assert.equal(moveTab(set, 5, 0), false);
});

test('a tab from another window lands where it was let go along the strip', () => {
  const spans = [{ left: 8, width: 100 }, { left: 112, width: 100 }];
  assert.equal(arrivalIndex(spans, 20, 0), 0, "let go over the first tab's left half, it did not go first");
  assert.equal(arrivalIndex(spans, 100, 0), 1);
  assert.equal(arrivalIndex(spans, 900, 0), 2, 'let go past the tabs, it did not go last');
  assert.equal(arrivalIndex(spans, null, 0), 1, 'with no point, it did not go beside the tab on screen');
  assert.equal(arrivalIndex([], 50, 0), 1);
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
  const independent = host.slice(host.indexOf('var independent ='), host.indexOf('var expectedSession'));
  assert.match(independent, /WorkbenchMethods\.WindowTakeTab\b/);
  // A drag's picture comes and goes whatever the file does meanwhile, so it is not bound to the file either.
  assert.match(independent, /WorkbenchMethods\.WindowEndTabDrag\b/, 'a drag let go after the file changed kept its picture on screen');
  assert.doesNotMatch(host.slice(host.indexOf('var independent ='), host.indexOf('var expectedSession')), /WindowDetachTab/,
    'a tab of one file session could open a window on another');
});
