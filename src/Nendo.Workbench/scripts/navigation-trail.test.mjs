import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleOf } from './bundle-of.mjs';

// Back and forward, everywhere, not only out of a relation (W-046).
//
// W-033 gave a related row one step back to the record it was opened from; everything
// else a person navigates had no way back at all. What is asserted here is the trail
// itself: when a draw counts as a move, what going somewhere new does to the way forward,
// and what a restore is allowed to record while it runs.
//
// The other half — reading a place out of the session and putting one back — reads the
// shared `state`, which this bundle owns a private copy of, so it belongs to the gate
// (C-196, C-197), exactly as the related-row journey does.
const { createTrail, placeKey, trailCeiling } = await bundleOf('src/navigation-trail.ts');

const place = (over = {}) => ({
  view: 'use',
  eyebrow: 'Use · Work',
  title: 'Board',
  applicationEntityId: 'nd.work',
  studioEntityId: null,
  showOverview: false,
  surfaceId: 'nd.work.board',
  recordId: null,
  returnTo: null,
  drill: null,
  tabs: [],
  calendar: null,
  timeline: null,
  helpTopicId: 'start',
  proposalId: null,
  agentProposalId: null,
  proposalReturnView: null,
  viewPlaces: [],
  ...over,
});

test('the same place drawn again is a repaint, not a move', () => {
  const trail = createTrail();
  trail.record(place());
  trail.record(place());
  trail.record(place());
  assert.equal(trail.inspect().places.length, 1);
  assert.equal(trail.canGoBack(), false);
});

test('a place renamed under the reader is still the same place, and keeps the newer name', () => {
  // A file reopened, or a surface retitled by an accepted proposal, changes what a place
  // is called without moving anybody. A trail that pushed for that would fill with
  // entries leading to the screen already on view.
  const trail = createTrail();
  trail.record(place());
  trail.record(place({ title: 'Board of work' }));
  assert.equal(trail.inspect().places.length, 1);
  assert.equal(trail.inspect().places[0].title, 'Board of work');
});

test('the drill, the open tab and the month are part of where somebody is', () => {
  // The acceptance criterion: a place carries its drill, its open tab and its calendar
  // position. If it did not, going back to a board you had since un-drilled would put
  // the drill back on, because the map still holds whatever it holds now.
  const drilled = place({ drill: { listId: 'nd.work.list', label: 'Now', filters: [{ fieldId: 'nd.work.horizon', operator: 'equals', value: 'Now' }] } });
  assert.notEqual(placeKey(place()), placeKey(drilled));
  assert.notEqual(placeKey(place()), placeKey(place({ tabs: [['["f","nd.work","page","tabs"]', 'section.evidence']] })));
  assert.notEqual(placeKey(place()), placeKey(place({ calendar: { surfaceId: 's', month: { year: 2026, month: 9 }, mode: 'dated' } })));
  assert.notEqual(placeKey(place()), placeKey(place({ recordId: 'nd.work.r.back-and-forward' })));
});

test('the tabs of a place compare the same however they were collected', () => {
  // They come out of a map, whose order is insertion order, and two draws can collect
  // the same two tabs in either order. Without sorting, opening a second tab and closing
  // it again would leave a phantom move in the trail.
  const one = place({ tabs: [['a', 'x'], ['b', 'y']] });
  const other = place({ tabs: [['b', 'y'], ['a', 'x']] });
  assert.equal(placeKey(one), placeKey(other));
});

test('going somewhere new from part-way back abandons the way forward', () => {
  const trail = createTrail();
  trail.record(place({ surfaceId: 'one' }));
  trail.record(place({ surfaceId: 'two' }));
  trail.record(place({ surfaceId: 'three' }));
  trail.stepBack();
  trail.stepBack();
  assert.equal(trail.canGoForward(), true);
  trail.record(place({ surfaceId: 'four' }));
  assert.equal(trail.canGoForward(), false);
  assert.deepEqual(trail.inspect().places.map(entry => entry.surfaceId), ['one', 'four']);
});

test('back and forward walk the trail and stop at its ends', () => {
  const trail = createTrail();
  trail.record(place({ surfaceId: 'one' }));
  trail.record(place({ surfaceId: 'two' }));
  assert.equal(trail.canGoBack(), true);
  assert.equal(trail.canGoForward(), false);
  assert.equal(trail.peekBack().surfaceId, 'one');
  trail.stepBack();
  assert.equal(trail.canGoBack(), false);
  assert.equal(trail.peekBack(), null);
  assert.equal(trail.peekForward().surfaceId, 'two');
  trail.stepBack();
  assert.equal(trail.inspect().cursor, 0, 'a step past the start moves nobody');
  trail.stepForward();
  assert.equal(trail.inspect().cursor, 1);
  trail.stepForward();
  assert.equal(trail.inspect().cursor, 1, 'a step past the end moves nobody');
});

test('the trail is bounded, and it is the oldest place that goes', () => {
  const trail = createTrail(3);
  for (const id of ['one', 'two', 'three', 'four']) trail.record(place({ surfaceId: id }));
  assert.deepEqual(trail.inspect().places.map(entry => entry.surfaceId), ['two', 'three', 'four']);
  assert.equal(trail.inspect().cursor, 2, 'the person is still on the place they are on');
  assert.equal(trail.peekBack().surfaceId, 'three');
});

test('the ceiling is a real number and the default trail uses it', () => {
  assert.ok(Number.isInteger(trailCeiling) && trailCeiling > 1);
  const trail = createTrail();
  for (let index = 0; index < trailCeiling + 10; index += 1) trail.record(place({ surfaceId: `s${index}` }));
  assert.equal(trail.inspect().places.length, trailCeiling);
});

test('a place put back is not a place gone to, even when it lands a hair off', () => {
  // Restoring redraws, and a draw records. Without the hold, a restore would push the
  // place it had just restored and eat everything ahead of it — so forward would work
  // exactly once.
  //
  // The hair matters. A restore that lands exactly on its target is caught by the
  // repaint rule above whether the hold exists or not, so a test written that way passes
  // against a build with no hold at all — it guards the symptom. A restore does not
  // always land exactly: refreshDerived settles showOverview for the file, the record
  // page fills in returnTo, and the draw that follows is a place one field away from the
  // one aimed at. That is the draw the hold is for, so that is what is asserted.
  const trail = createTrail();
  trail.record(place({ surfaceId: 'one', showOverview: null }));
  trail.record(place({ surfaceId: 'two' }));
  trail.stepBack();
  trail.setRestoring(true);
  trail.record(place({ surfaceId: 'one', showOverview: false }));
  trail.setRestoring(false);
  assert.equal(trail.canGoForward(), true, 'the way forward survived the restore');
  assert.equal(trail.peekForward().surfaceId, 'two');
  assert.equal(trail.inspect().places.length, 2);
});

test('a place that is no longer there is forgotten without moving anybody', () => {
  const trail = createTrail();
  trail.record(place({ surfaceId: 'one' }));
  trail.record(place({ surfaceId: 'two' }));
  trail.record(place({ surfaceId: 'three' }));
  trail.dropBack();
  assert.equal(trail.inspect().places[trail.inspect().cursor].surfaceId, 'three',
    'dropping the way back left the person where they were');
  assert.equal(trail.peekBack().surfaceId, 'one');
  trail.stepBack();
  trail.dropForward();
  assert.equal(trail.canGoForward(), false);
  assert.equal(trail.inspect().places[trail.inspect().cursor].surfaceId, 'one');
});

test('a place corrected in place is not a move, and does not read as one afterwards', () => {
  // Switching a tab patches the tablist and deliberately does not redraw, so the entry
  // would otherwise keep the tab from the last draw: restoring the wrong one, and then
  // reading as a phantom move the first time anything else redrew — which eats the way
  // forward, because a move discards it.
  const trail = createTrail();
  trail.record(place({ surfaceId: 'one' }));
  trail.record(place({ surfaceId: 'two', recordId: 'r1' }));
  trail.stepBack();
  trail.stepForward();
  assert.equal(trail.canGoBack(), true);

  const opened = [['["f","nd.work","page","tabs"]', 'section.evidence']];
  trail.amendCurrent(entry => ({ ...entry, tabs: opened }));
  assert.equal(trail.inspect().places.length, 2, 'correcting a place did not add one');
  assert.equal(trail.inspect().cursor, 1, 'correcting a place did not move anybody');
  assert.deepEqual(trail.current().tabs, opened);

  // And the next ordinary draw agrees with it, so nothing is recorded.
  trail.record(place({ surfaceId: 'two', recordId: 'r1', tabs: opened }));
  assert.equal(trail.inspect().places.length, 2);
  assert.equal(trail.peekBack().surfaceId, 'one', 'the way back survived the tab');
});

test('two reviews that close to different places are two places', () => {
  // proposalReturnView decides which section the rail shows as current while a review is
  // open, and where its Close button goes. A place that did not tell two reviews apart by
  // it came back to one whose Close led wherever the last review had been opened from.
  const fromStructure = place({ view: 'proposal', proposalId: 'p1', proposalReturnView: 'structure' });
  const fromSurfaces = place({ view: 'proposal', proposalId: 'p1', proposalReturnView: 'surfaces' });
  assert.notEqual(placeKey(fromStructure), placeKey(fromSurfaces));
});

test('there is nothing to correct before there is a place', () => {
  const trail = createTrail();
  assert.equal(trail.current(), null);
  trail.amendCurrent(entry => ({ ...entry, tabs: [] }));
  assert.equal(trail.inspect().places.length, 0);
});

test('closing the file closes the way back to it', () => {
  const trail = createTrail();
  trail.record(place({ surfaceId: 'one' }));
  trail.record(place({ surfaceId: 'two' }));
  trail.setRestoring(true);
  trail.clear();
  assert.equal(trail.canGoBack(), false);
  assert.equal(trail.canGoForward(), false);
  assert.equal(trail.inspect().places.length, 0);
  assert.equal(trail.isRestoring(), false, 'a cleared trail is not left holding a restore');
});

test('a view that moves makes a step, and a view that corrects its place does not (W-127)', () => {
  const trail = createTrail();
  trail.record(place({ surfaceId: 'ar.screen.archi' }));
  const at = (value, label = 'View') => place({ surfaceId: 'ar.screen.archi', viewPlaces: [{ view: '["screen","archi",null]', value, label }] });
  trail.record(at({ view: 'v-1' }, 'Main view'));
  trail.amendCurrent(() => at({ view: 'v-1', selected: 'e-1' }, 'Main view'));
  trail.record(at({ view: 'v-2' }, 'Layered view'));
  assert.equal(trail.inspect().places.length, 3, 'Opening a second diagram was not a step.');
  assert.deepEqual(trail.peekBack().viewPlaces[0].value, { view: 'v-1', selected: 'e-1' }, 'The selection corrected on the first diagram was not the step back.');
  trail.record(at({ view: 'v-2' }, 'Layered view, renamed'));
  assert.equal(trail.inspect().places.length, 3, 'A new label on the same place counted as a move.');
});

const places = await bundleOf('src/view-places.ts');

test('a view keeps its place on the screen it declared it on, and Back puts the old one back (W-127)', () => {
  const archi = places.viewAnchor({ view: 'use', applicationEntityId: 'ar.model', showOverview: false, surfaceId: 'ar.screen.archi', recordId: null });
  const record = places.viewAnchor({ view: 'use', applicationEntityId: 'ar.concept', showOverview: false, surfaceId: 'ar.concept.list', recordId: 'ar-1' });
  const view = places.viewPlaceKey({ placement: 'screen', viewId: 'archi', recordId: null });
  assert.equal(places.keepViewPlace(archi, { view, value: { view: 'v-1' }, label: 'Main' }), true);
  assert.equal(places.keepViewPlace(archi, { view, value: { view: 'v-1' }, label: 'Main' }), false, 'The same place declared again counted as a change.');
  assert.equal(places.keepViewPlace(archi, { view, value: { view: 'v-1' }, label: 'Main view' }), true, 'A new label was not kept.');
  assert.deepEqual(places.viewPlacesAt(record), [], 'A place declared on one screen appeared on another.');
  assert.equal(places.keepViewPlace(archi, { view, value: { view: 'v-2' }, label: 'Layered' }), true);
  places.restoreViewPlaces(archi, [{ view, value: { view: 'v-1' }, label: 'Main view' }]);
  assert.deepEqual(places.viewPlaceOf(archi, view)?.value, { view: 'v-1' }, 'Back did not put the earlier place back.');
  places.restoreViewPlaces(archi, []);
  assert.equal(places.viewPlaceOf(archi, view), null, 'A place the view had not declared yet survived going back to before it.');
});

test('the places kept are bounded, and it is the one used longest ago that goes', () => {
  const view = places.viewPlaceKey({ placement: 'recordPage', viewId: 'panel', recordId: null });
  const anchorOf = (index) => places.viewAnchor({ view: 'use', applicationEntityId: 'e', showOverview: false, surfaceId: `s-${index}`, recordId: null });
  for (let index = 0; index <= places.viewPlaceCeiling; index += 1) places.keepViewPlace(anchorOf(index), { view, value: index, label: 'x' });
  assert.equal(places.viewPlaceOf(anchorOf(0), view), null);
  assert.equal(places.viewPlaceOf(anchorOf(places.viewPlaceCeiling), view)?.value, places.viewPlaceCeiling);
});

// Review R-002: going to a tab is a transaction. The tab controller's moves (tab-set.ts) are
// driven here with the real trail; `show` stands for revisitCurrent, which answers false when
// the destination's record type has gone or its record cannot be read.
const { switchTab, closeTabAt } = await bundleOf('src/tab-set.ts');
const { createTrail: makeTrail } = await bundleOf('src/navigation-trail.ts');

function twoTabs() {
  const trail = makeTrail();
  const a = place({ title: 'Board A', surfaceId: 'nd.work.a' });
  const a2 = place({ title: 'List A', surfaceId: 'nd.work.a2' });
  const b = place({ applicationEntityId: 'nd.retired', eyebrow: 'Use · Retired', title: 'B', surfaceId: 'nd.retired.b' });
  trail.record(a); trail.record(a2);
  const set = { tabs: [{ id: 1, saved: null }, { id: 2, saved: { places: [b], cursor: 0 } }], active: 0 };
  return { trail, set, a, a2, b };
}

test('R-002: a tab whose place is refused leaves the tab on screen selected, with its own trail', async () => {
  for (const reason of ['record type retired', 'record read failed']) {
    const { trail, set, a2, b } = twoTabs();
    const before = JSON.stringify(trail.inspect());
    let shownAt = null;
    const moved = await switchTab(set, 1, trail, async () => { shownAt = trail.current(); return false; });
    assert.equal(moved, false, reason);
    assert.equal(shownAt?.title, b.title, `${reason}: the destination's place was the one tried`);
    assert.equal(set.active, 0, `${reason}: the selected tab must stay the one on screen`);
    assert.equal(placeKey(trail.current()), placeKey(a2), `${reason}: the heading's place must stay the page on screen`);
    assert.equal(JSON.stringify(trail.inspect()), before, `${reason}: Back and Forward must still be the tab's own`);
    assert.equal(trail.canGoBack(), true);
    assert.deepEqual(set.tabs[1].saved, { places: [b], cursor: 0 }, `${reason}: the refused tab keeps its trail`);
    assert.equal(set.tabs[0].saved, null, `${reason}: the tab on screen holds its trail in the window, not saved`);
  }
});

test('R-002: closing the tab on screen when its neighbour is refused closes nothing', async () => {
  const { trail, set, a2 } = twoTabs();
  assert.equal(await closeTabAt(set, 0, trail, async () => false), false);
  assert.equal(set.tabs.length, 2);
  assert.equal(set.active, 0);
  assert.equal(placeKey(trail.current()), placeKey(a2));
});

test('R-002: a tab that is shown swaps the trails, and closing the old one keeps the right one', async () => {
  const { trail, set, a2, b } = twoTabs();
  assert.equal(await switchTab(set, 1, trail, async () => true), true);
  assert.equal(set.active, 1);
  assert.equal(placeKey(trail.current()), placeKey(b));
  assert.equal(placeKey(set.tabs[0].saved.places[set.tabs[0].saved.cursor]), placeKey(a2));
  assert.equal(await closeTabAt(set, 0, trail, async () => true), true);
  assert.equal(set.tabs.length, 1);
  assert.equal(set.active, 0);
  assert.equal(placeKey(trail.current()), placeKey(b));
});

// ACP-06 (review of 2026-10-10): + on a launched agent's conversation made a second tab of the
// same conversation, and closing either ended the agent the other still showed; a conversation
// tab that went on to Data no longer counted as its owner, so closing it left the agent running.
const { trailForNewTab, trailHolds } = await bundleOf('src/tab-set.ts');

test('ACP-06: a new tab beside a conversation starts from the place before it, and a trail owns what it holds', () => {
  const chat = place({ view: 'agentChat', eyebrow: 'Local collaboration', title: 'Copilot', surfaceId: null });
  const board = place();
  const data = place({ view: 'data', eyebrow: 'Studio', title: 'Data', surfaceId: null });
  const oneOfAKind = (candidate) => candidate.view === 'agentChat';
  const copied = trailForNewTab({ places: [board, chat], cursor: 1 }, oneOfAKind);
  assert.equal(copied.places.length, 1);
  assert.equal(copied.places[0].view, 'use', 'A new tab copied the conversation, so two tabs showed it.');
  assert.deepEqual(trailForNewTab({ places: [chat], cursor: 0 }, oneOfAKind), { places: [], cursor: -1 });
  assert.equal(trailForNewTab({ places: [board, data], cursor: 1 }, oneOfAKind).places[0].view, 'data', 'An ordinary place was not copied as it is.');

  const holdsChat = (candidate) => candidate.view === 'agentChat';
  assert.equal(trailHolds({ places: [chat, data], cursor: 1 }, holdsChat), true, 'A conversation tab that went on to Data lost the conversation.');
  assert.equal(trailHolds({ places: [board], cursor: 0 }, holdsChat), false);
  assert.equal(trailHolds(null, holdsChat), false);
});
