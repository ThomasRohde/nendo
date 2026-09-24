import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';

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
const bundleOf = async (entry) => {
  const bundle = await build({ configFile: false, logLevel: 'error', build: { ssr: entry, write: false, rollupOptions: { output: { codeSplitting: false } } } });
  return import('data:text/javascript;base64,' + Buffer.from(bundle.output.find(item => item.type === 'chunk').code).toString('base64'));
};
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
