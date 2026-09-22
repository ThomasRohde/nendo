import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
const bundle = await build({configFile:false,logLevel:'error',build:{ssr:'src/read-chase.ts',write:false,rollupOptions:{output:{codeSplitting:false}}}});
const { createReadChase, chaseIntervalMs } = await import('data:text/javascript;base64,'+Buffer.from(bundle.output.find(item=>item.type==='chunk').code).toString('base64'));

// A clock that runs only when the test says so, so "at most once a second" is a
// measurement rather than a wait.
const testClock = () => {
 const timers = [];
 let clock = 0;
 return {
  now: () => clock,
  later: (run, ms) => timers.push({ at: clock + ms, run }),
  advance(ms) {
   clock += ms;
   for (const timer of timers.filter((entry) => entry.at <= clock).splice(0)) {
    timers.splice(timers.indexOf(timer), 1);
    timer.run();
   }
  },
  get pending() { return timers.length; },
 };
};

const settled = () => new Promise((resolve) => setImmediate(resolve));

test('a redraw that finds work missing cannot start a second pass while the first runs',async()=>{
 const clock = testClock();
 const chase = createReadChase(clock);
 let passes = 0;
 let release;
 const pass = () => { passes += 1; return new Promise((resolve) => { release = resolve; }); };
 const redraw = () => chase.run(pass, redraw, () => {});

 redraw();
 assert.equal(passes, 1);
 assert.equal(chase.busy, true);
 // Every draw while the read is in flight — a keystroke, a resize, anything —
 // must not add another read.
 for (let index = 0; index < 50; index += 1) redraw();
 assert.equal(passes, 1);

 release();
 await settled();
 assert.equal(chase.busy, false);
 // The redraw at the end of the pass found the work still missing and did not
 // start another pass: that is the loop this exists to stop.
 assert.equal(passes, 1);
});

test('a file being written to continuously costs one pass a second, not one a round trip',async()=>{
 const clock = testClock();
 const chase = createReadChase(clock);
 let passes = 0;
 // Every pass "fails" to land anything, exactly as a read does when the file
 // moves under it, so the screen is always missing something.
 //
 // The cap turns an unbounded chase into a failure with a number in it. Without
 // it this test simply never returns, and a suite that hangs reads as a broken
 // machine rather than as the defect it is.
 const runaway = 100;
 const pass = async () => {
  passes += 1;
  if (passes > runaway) throw new Error(`the chase ran away: ${passes} passes without the clock moving`);
 };
 const redraw = () => chase.run(pass, redraw, () => {});

 redraw();
 await settled();
 assert.equal(passes, 1);

 // Ten seconds of a continuously changing file.
 for (let second = 0; second < 10; second += 1) {
  clock.advance(chaseIntervalMs);
  await settled();
 }
 // One a second, and never the hundreds a second an unbounded chase would run.
 assert.equal(passes, 11);
});

test('a draw inside the interval arranges exactly one wake-up, however many draws there are',async()=>{
 const clock = testClock();
 const chase = createReadChase(clock);
 let passes = 0;
 const pass = async () => { passes += 1; };
 const redraw = () => chase.run(pass, redraw, () => {});

 redraw();
 await settled();
 assert.equal(passes, 1);

 for (let index = 0; index < 20; index += 1) redraw();
 assert.equal(clock.pending, 1, 'twenty draws inside the interval queued more than one wake-up');

 clock.advance(chaseIntervalMs);
 await settled();
 assert.equal(passes, 2);
});

test('the screen catches up by itself once the writing stops',async()=>{
 const clock = testClock();
 const chase = createReadChase(clock);
 let passes = 0;
 let missing = true;
 const pass = async () => { passes += 1; if (passes >= 2) missing = false; };
 const redraw = () => { if (missing) chase.run(pass, redraw, () => {}); };

 redraw();
 await settled();
 clock.advance(chaseIntervalMs);
 await settled();
 assert.equal(passes, 2);
 assert.equal(missing, false);

 // Nothing is missing now, so nothing is chased, however long passes.
 clock.advance(chaseIntervalMs * 10);
 await settled();
 assert.equal(passes, 2);
});

test('a failed pass waits its turn rather than failing in a loop',async()=>{
 const clock = testClock();
 const chase = createReadChase(clock);
 let passes = 0;
 let failures = 0;
 const pass = async () => {
  passes += 1;
  // Capped for the reason the pass above is: without the interval this retry is a
  // loop, and a test that hangs says less than one that fails with a count.
  if (passes > 100) throw new Error(`the failure retry ran away: ${passes} passes without the clock moving`);
  throw new Error('the file is changing');
 };
 const redraw = () => chase.run(pass, redraw, () => { failures += 1; if (passes <= 100) redraw(); });

 redraw();
 await settled();
 assert.equal(passes, 1);
 assert.equal(failures, 1);

 // The failure handler redrew immediately, as the real one does; the interval
 // still holds, so the failure cannot spin either.
 for (let index = 0; index < 20; index += 1) redraw();
 await settled();
 assert.equal(passes, 1);

 clock.advance(chaseIntervalMs);
 await settled();
 assert.equal(passes, 2);
});

test('nothing is read or redrawn while the person has hold of something',async()=>{
 const clock = testClock();
 const chase = createReadChase(clock);
 let passes = 0;
 let redraws = 0;
 let holding = false;
 const pass = async () => { passes += 1; };
 const redraw = () => { redraws += 1; chase.run(pass, redraw, () => {}, () => holding); };

 // An open picker, and the file changing underneath it.
 holding = true;
 chase.run(pass, redraw, () => {}, () => holding);
 assert.equal(passes, 0, 'a read started while a menu was open');
 for (let second = 0; second < 5; second += 1) { clock.advance(chaseIntervalMs); await settled(); }
 assert.equal(passes, 0, 'the hold was waited out rather than asked again');

 // The menu closes; the next wake-up finds the hold gone and reads.
 holding = false;
 clock.advance(chaseIntervalMs);
 await settled();
 assert.equal(passes, 1);
});

test('a pass that finishes under an open menu keeps its answers and waits to draw',async()=>{
 const clock = testClock();
 const chase = createReadChase(clock);
 let passes = 0;
 let redraws = 0;
 let holding = false;
 // The menu opens while the read is in flight, which is the ordinary case: the
 // person clicks the picker a moment after the second ticks over.
 const pass = async () => { passes += 1; holding = true; };
 const redraw = () => { redraws += 1; };

 chase.run(pass, redraw, () => {}, () => holding);
 await settled();
 assert.equal(passes, 1, 'the read did not run');
 assert.equal(redraws, 0, 'the screen was rebuilt under an open menu');
});

// Reported by the owner against the planner's own front page: the Showing picker could
// not be used. Holding it open blocks the pass, so whatever was pending stayed pending,
// so the next render armed another wake-up -- and the wake-up redrew, which replaced the
// content pane and closed the menu under the pointer. Once a second, for as long as they
// held it. The hold existed precisely to stop that and did not cover its own wake-up.
test('a hold is never redrawn through, and resumes the moment it ends', () => {
 const clock = testClock();
 const chase = createReadChase(clock);
 let held = true;
 let draws = 0;
 let passes = 0;
 const run = () => chase.run(async () => { passes++; }, () => { draws++; }, () => {}, () => held);

 run();
 for (let second = 0; second < 10; second++) clock.advance(chaseIntervalMs);
 assert.equal(draws, 0, 'a held page is not redrawn, however long the hold lasts');
 assert.equal(passes, 0, 'and nothing is read under it either');

 // Letting go resumes on the next interval, without needing another render to ask.
 held = false;
 clock.advance(chaseIntervalMs);
 assert.equal(draws, 1, 'releasing the hold redraws once');
});

test('a pass that finishes while somebody has hold of the page still gets drawn',async()=>{
 const clock = testClock();
 const chase = createReadChase(clock);
 let draws = 0;
 let holding = true;
 let release;
 const pass = () => new Promise((resolve) => { release = resolve; });
 const redraw = () => { draws += 1; };

 // The pass starts before the hold: somebody clicks a view, the screen draws, the
 // read goes out, and the click is still inside the quiet window when it comes back.
 holding = false;
 chase.run(pass, redraw, () => {}, () => holding);
 holding = true;
 release();
 await settled();

 // Nothing is drawn while the hold is on, which is the rule. What was missing is that
 // nothing was arranged for afterwards either: the answers sat in hand, the screen went
 // on saying it was waiting for them, and the only thing that ever drew them was the
 // person giving up and clicking something. The owner watched an empty matrix for
 // thirty seconds and then clicked an empty space to make it appear.
 assert.equal(draws, 0);

 holding = false;
 clock.advance(chaseIntervalMs);
 assert.equal(draws, 1, 'the answers are drawn once the hold ends, without being asked');

 // And once only: a held pass arms one wake-up, not one per second for ever.
 clock.advance(chaseIntervalMs * 5);
 assert.equal(draws, 1);
});
