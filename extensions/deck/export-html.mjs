// The HTML export: one self-contained file that plays the deck in any browser. Slides are the
// same HTML the stage draws, pictures are inlined, and a small player moves through them: builds,
// transitions, a presenter console with a timer and the pace against the plan, a laser pointer
// and a pen. Present in the view plays this same file in a frame, so rehearsing and sharing show
// the same thing. In a browser the console can open a second window for the audience, which it
// drives; Nendo opens no second window, so in Present the console and the slides share one.

import { SLIDE_CSS } from './render.mjs';
import { webFonts } from './themes.mjs';
import { spokenSeconds, DEFAULT_SECONDS } from './check.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
// JSON in a script element: never let the text close the element.
const json = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/**
 * How long a slide's plan is, in seconds, for each shown slide: its rehearsed time, else the time
 * its notes take to say, else the Check tab's default, fitted to the target length when there is
 * one. No rehearsal, no notes and no target is no plan.
 */
export function planOf(seconds, minutes, notes = []) {
  const said = seconds.map((s, i) => Number.isFinite(s) && s > 0 ? s : spokenSeconds(notes[i]));
  const target = Number.isFinite(minutes) && minutes > 0 ? minutes * 60 : null;
  if (!said.some(s => s) && !target) return null;
  const base = said.map(s => s ?? DEFAULT_SECONDS);
  const sum = base.reduce((a, b) => a + b, 0) || 1;
  return target ? base.map(s => s * target / sum) : base;
}

/**
 * slides: [{html, notes, title, steps, transition, seconds}] already drawn with inlined pictures.
 * embedded: played in the view's frame; rehearse: the console records the time on each slide and
 * hands the times back when it ends. minutes: the talk's target length.
 */
export function buildHtml({ title, author = '', W, H, slides, theme, start = 0, embedded = false, rehearse = false, minutes = null }) {
  const fonts = webFonts(theme);
  const bg = theme.colors.bg;
  const primary = theme.colors.primary;
  const data = {
    notes: slides.map(s => s.notes ?? ''), titles: slides.map(s => s.title ?? ''), steps: slides.map(s => s.steps ?? 0),
    transitions: slides.map(s => s.transition ?? 'None'), plan: planOf(slides.map(s => s.seconds ?? null), minutes, slides.map(s => s.notes)),
    start, embedded, rehearse, deck: title,
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="generator" content="Nendo Deck">
${author ? `<meta name="author" content="${esc(author)}">` : ''}
<title>${esc(title)}</title>
${fonts ? `<link rel="stylesheet" href="${esc(fonts)}">` : ''}
<style>
${SLIDE_CSS}
html,body{margin:0;height:100%;background:#0b0b0c;color:#eee;font:14px/1.4 'Segoe UI',system-ui,sans-serif;overflow:hidden}
button{font:inherit}
#deck{position:fixed;inset:0;display:grid;place-items:center}
#frame{position:relative;width:${W}px;height:${H}px;transform-origin:center;box-shadow:0 20px 60px rgba(0,0,0,.5);overflow:hidden;background:${esc(bg)}}
#frame>.dk-slide{position:absolute;inset:0}
#frame>.dk-slide.off{visibility:hidden}
.ink{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:3}
.laser-dot{position:absolute;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:radial-gradient(circle,#fff 0 18%,#ff2a2a 34%,rgba(255,42,42,.35) 62%,rgba(255,42,42,0) 72%);box-shadow:0 0 18px 6px rgba(255,40,40,.45);pointer-events:none;z-index:4;display:none}
body.laser #frame,body.laser .now{cursor:none}
body.pen #frame,body.pen .now{cursor:crosshair}
#cover{position:absolute;inset:0;z-index:5;display:none}
body.black #cover{display:block;background:#000}
body.white #cover{display:block;background:#fff}
#end{position:fixed;inset:0;display:none;place-items:center;background:#000;color:#bbb;font-size:18px;z-index:5}
body.ended #end{display:grid}
#bar{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);display:flex;gap:4px;align-items:center;padding:6px 8px;border-radius:999px;background:rgba(20,20,22,.78);backdrop-filter:blur(8px);opacity:0;transition:opacity .2s;z-index:8}
body:hover #bar,#bar:focus-within{opacity:1}
body.presenter #bar,body.audience #bar{display:none}
#bar button,#console button{all:unset;cursor:pointer;padding:6px 10px;border-radius:999px;color:#fff;font-size:13px}
#bar button:hover,#bar button:focus-visible,#console button:hover,#console button:focus-visible{background:rgba(255,255,255,.16)}
#bar button[aria-pressed="true"],#console button[aria-pressed="true"]{background:${esc(primary)};color:#fff}
#count{font-variant-numeric:tabular-nums;color:#ccc;padding:0 6px}
#progress{position:fixed;left:0;top:0;height:3px;background:${esc(primary)};transition:width .3s;z-index:6}
body.audience #progress{display:none}
#console{position:fixed;inset:0;display:none;grid-template-columns:minmax(0,1.55fr) minmax(280px,1fr);grid-template-rows:auto minmax(0,1fr);gap:14px;padding:16px 18px 18px;background:#121214;z-index:7;box-sizing:border-box}
body.presenter #console{display:grid}
body.presenter #deck{visibility:hidden}
#console .top{grid-column:1/3;display:flex;align-items:center;gap:18px;flex-wrap:wrap}
#console .timer{font:600 40px/1 'Segoe UI',system-ui,sans-serif;font-variant-numeric:tabular-nums;color:#fff;min-width:4.2ch}
#console .timer.paused{color:#f5c04a}
#console .meta{display:flex;flex-direction:column;gap:2px;color:#aaa;font-size:13px;font-variant-numeric:tabular-nums}
#console .meta strong{color:#eee;font-weight:600;font-size:15px}
#console .pace{flex:1;min-width:180px;display:flex;flex-direction:column;gap:6px}
#console .pace-text{font-size:14px;color:#ddd}
#console .pace-text.ahead{color:#7fd6a3}#console .pace-text.behind{color:#ff9a8a}
#console .track{position:relative;height:8px;border-radius:4px;background:#2a2a2e;overflow:hidden}
#console .track .done{position:absolute;left:0;top:0;bottom:0;background:${esc(primary)};border-radius:4px}
#console .track .plan{position:absolute;top:0;bottom:0;background:rgba(255,255,255,.22)}
#console .tools{display:flex;gap:2px;flex-wrap:wrap}
#console .rec{display:none;align-items:center;gap:6px;color:#ff8a8a;font-weight:600}
#console .rec::before{content:'';width:10px;height:10px;border-radius:50%;background:#ff4b4b;animation:blink 1.2s infinite}
body.rehearse #console .rec{display:flex}
@keyframes blink{50%{opacity:.25}}
#console .main{display:flex;flex-direction:column;gap:8px;min-height:0}
#console .now,#console .next{position:relative;overflow:hidden;background:${esc(bg)};border-radius:8px;flex:none}
#console .next{aspect-ratio:${W}/${H};width:100%}
#console .now{margin:0 auto}
#now-cover{position:absolute;inset:0;z-index:5;display:none;place-items:center;text-align:center;padding:12px;font-size:15px}
body.black #now-cover{display:grid;background:rgba(0,0,0,.9);color:#bbb}
body.white #now-cover{display:grid;background:rgba(255,255,255,.92);color:#444}
#console .strip{flex:none;display:flex;gap:8px;overflow-x:auto;padding:4px 2px 6px;margin-top:auto}
#console .strip button{all:unset;cursor:pointer;flex:none;position:relative;width:112px;aspect-ratio:${W}/${H};border-radius:4px;overflow:hidden;background:${esc(bg)};outline:2px solid transparent;outline-offset:1px}
#console .strip button.here{outline-color:${esc(primary)}}
#console .strip button:focus-visible{outline-color:#fff}
#console .strip span{position:absolute;left:4px;bottom:3px;font-size:11px;color:#fff;background:rgba(0,0,0,.6);padding:0 5px;border-radius:3px}
#console .side{display:flex;flex-direction:column;gap:8px;min-height:0}
#console .label{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8a8a90;display:flex;justify-content:space-between;align-items:center;gap:8px}
#console .label button{padding:2px 8px;font-size:12px;letter-spacing:0;text-transform:none}
#console .notes{flex:1;overflow:auto;font-size:var(--notes,22px);line-height:1.5;color:#eee;white-space:pre-wrap;background:#1b1b1e;border-radius:8px;padding:14px 16px;min-height:80px}
#console .notes.empty{color:#777}
#console .slide-time{font-variant-numeric:tabular-nums}
#grid{position:fixed;inset:0;overflow:auto;display:none;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:18px;padding:28px;background:#111;z-index:9;box-sizing:border-box}
body.grid #grid{display:grid}
#grid button{all:unset;cursor:pointer;position:relative;aspect-ratio:${W}/${H};overflow:hidden;border-radius:6px;outline:2px solid transparent;background:${esc(bg)}}
#grid button:focus-visible,#grid button.here{outline-color:${esc(primary)}}
#grid button span{position:absolute;left:8px;bottom:6px;font-size:12px;color:#fff;background:rgba(0,0,0,.55);padding:1px 6px;border-radius:4px}
.thumb{position:absolute;left:0;top:0;transform-origin:0 0}
#help{position:fixed;right:16px;top:16px;max-width:320px;padding:14px 16px;border-radius:10px;background:rgba(20,20,22,.94);font-size:13px;display:none;z-index:10}
body.help #help{display:block}
#help p{margin:6px 0}
#help kbd{display:inline-block;min-width:18px;text-align:center;padding:0 4px;border:1px solid #555;border-radius:4px;margin-right:6px;font:12px Consolas,monospace}
@media (prefers-reduced-motion:reduce){.dk-slide [data-step]{transition:opacity .2s linear}.dk-slide .dk-later{transform:none}}
@media print{
  @page{size:${W}px ${H}px;margin:0}
  html,body{overflow:visible;height:auto;background:none}
  #bar,#progress,#console,#grid,#help,#end,#cover,.ink,.laser-dot{display:none!important}
  #deck,body.presenter #deck{position:static;display:block;visibility:visible}
  #frame{transform:none!important;box-shadow:none;width:auto;height:auto;overflow:visible}
  #frame>.dk-slide{position:relative;visibility:visible!important;page-break-after:always;break-after:page}
  .dk-slide .dk-later{opacity:1!important;transform:none!important}
}
</style>
</head>
<body${rehearse ? ' class="rehearse"' : ''}>
<div id="progress"></div>
<main id="deck" aria-live="polite"><div id="frame">
${slides.map((s, i) => s.html.replace('class="dk-slide ', `class="dk-slide ${i === start ? '' : 'off'} `).replace('<div class="dk-slide', `<div role="group" aria-roledescription="slide" aria-label="${i + 1} of ${slides.length}: ${esc(s.title)}" class="dk-slide`)).join('\n')}
<canvas class="ink" id="ink" width="${W}" height="${H}" aria-hidden="true"></canvas><div class="laser-dot" id="laser"></div><div id="cover"></div>
</div></main>
<section id="console" aria-label="Presenter view">
<div class="top">
<div class="timer" id="clock" title="Time presenting">0:00</div>
<div class="meta"><strong id="pcount"></strong><span id="slide-time" class="slide-time"></span><span id="wall"></span></div>
<div class="pace"><div class="pace-text" id="pace"></div><div class="track"><div class="plan" id="plan"></div><div class="done" id="done"></div></div></div>
<span class="rec">Rehearsing</span>
<div class="tools" role="toolbar" aria-label="Presenting">
<button id="c-pause" title="Pause or go on with the timer (T)">Pause</button><button id="c-reset" title="Start the timer again">Reset</button>
<button id="c-laser" aria-pressed="false" title="Laser pointer (L)">Laser</button><button id="c-pen" aria-pressed="false" title="Pen (D); E clears">Pen</button>
<button id="c-black" aria-pressed="false" title="Black screen (B)">Black</button>
${embedded ? '' : '<button id="c-audience" title="Open the slides in a window of their own, for the projector">Audience window</button>'}
<button id="c-grid" title="All slides (G)">Slides</button>
<button id="c-end">${rehearse ? 'Finish rehearsal' : embedded ? 'End' : 'Close console'}</button>
</div>
</div>
<div class="main"><div class="label"><span>Now <span id="now-step"></span></span></div><div class="now" id="now"><canvas class="ink" id="now-ink" aria-hidden="true"></canvas><div class="laser-dot" id="now-laser"></div><div id="now-cover" role="status"></div></div><nav class="strip" id="strip" aria-label="Go to a slide"></nav></div>
<div class="side"><div class="label"><span id="next-label">Next</span></div><div class="next" id="next-box"></div>
<div class="label"><span>Notes</span><span><button id="n-smaller" title="Smaller notes">A&#8722;</button><button id="n-larger" title="Larger notes">A+</button></span></div><div class="notes" id="notes"></div></div>
</section>
<nav id="grid" aria-label="All slides"></nav>
<div id="end">End of the slides. Press &#8592; to go back${embedded ? ', Esc to stop' : ''}.</div>
<div id="bar" role="toolbar" aria-label="Slides"><button id="prev" aria-label="Previous">&#8592;</button><span id="count"></span><button id="next" aria-label="Next">&#8594;</button><button id="b-grid" title="All slides (G)">Slides</button><button id="b-laser" aria-pressed="false" title="Laser pointer (L)">Laser</button><button id="b-pen" aria-pressed="false" title="Pen (D)">Pen</button><button id="b-pres" title="Presenter view (P)">Presenter</button><button id="b-full" title="Full screen (F)">Full screen</button>${embedded ? '<button id="b-close" title="Stop presenting (Esc)">Close</button>' : ''}</div>
<div id="help"><p><kbd>&#8594;</kbd>next point or slide &nbsp;<kbd>&#8592;</kbd>back</p><p><kbd>P</kbd>presenter view: notes, next, timer and pace</p><p><kbd>L</kbd>laser pointer &nbsp;<kbd>D</kbd>pen &nbsp;<kbd>E</kbd>clear the pen</p><p><kbd>B</kbd>black &nbsp;<kbd>W</kbd>white &nbsp;<kbd>T</kbd>pause the timer</p><p><kbd>G</kbd>all slides &nbsp;<kbd>F</kbd>full screen &nbsp;<kbd>Ctrl P</kbd>print or PDF</p><p>Type a number and <kbd>Enter</kbd> to go to that slide.</p></div>
<script type="application/json" id="data">${json(data)}</script>
<script>
(${player.toString()})(${W}, ${H});
</script>
</body>
</html>
`;
}

/* The player, written into the file as its own text: no import, no module, nothing from elsewhere. */
/* eslint-disable no-restricted-globals */
function player(W, H) {
  const data = JSON.parse(document.getElementById('data').textContent);
  const $ = id => document.getElementById(id);
  const body = document.body;
  const frame = $('frame');
  const slides = [...frame.querySelectorAll(':scope > .dk-slide')];
  const n = slides.length;
  const audience = /(^|[#&])audience\b/.test(location.hash);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fromHash = (location.hash.match(/^#(\d+)$/) || [])[1];
  // Where the talk is: the slide, how many of its points are showing, and whether it has ended.
  let at = Math.min(Math.max(0, fromHash ? Number(fromHash) - 1 : data.start), n - 1);
  let shown = 0, ended = false, cover = '';
  let tool = '', laser = null, stroke = null, typed = '';
  const ink = new Map();
  let peer = null; // the audience window this console drives, or the console that drives this one
  if (audience) { body.classList.add('audience'); peer = window.opener; }

  // ---- Time: the talk's clock, each slide's own, and the plan they are held to.
  let running = false, paused = false, total = 0, last = 0;
  const spent = new Array(n).fill(0);
  const clockText = s => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s % 60).padStart(2, '0'); };
  function begin() { if (!running) { running = true; last = performance.now(); } }
  function tick() {
    const now = performance.now();
    if (running && !paused) { const dt = (now - last) / 1000; total += dt; if (!ended) spent[at] += dt; }
    last = now;
    drawTime();
  }
  const plan = data.plan;
  const ends = plan ? plan.reduce((list, s) => { list.push((list.at(-1) || 0) + s); return list; }, []) : null;
  function drawTime() {
    if (!body.classList.contains('presenter')) return;
    $('clock').textContent = clockText(total);
    $('clock').classList.toggle('paused', paused);
    $('c-pause').textContent = paused ? 'Go on' : running ? 'Pause' : 'Start';
    const d = new Date();
    $('wall').textContent = 'Clock ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    $('slide-time').textContent = 'This slide ' + clockText(spent[at]) + (plan ? ' of ' + clockText(plan[at]) : '');
    const pace = $('pace');
    if (!plan) { pace.textContent = data.rehearse ? 'Rehearsing: the time on each slide is kept when you finish.' : 'No plan yet: set a talk length, or rehearse.'; pace.className = 'pace-text'; $('done').style.width = '0'; $('plan').style.width = '0'; return; }
    const whole = ends.at(-1), from = at ? ends[at - 1] : 0, to = ends[at];
    let words = 'On time', kind = '';
    if (total > to + 5) { words = clockText(total - to) + ' behind'; kind = 'behind'; }
    else if (total < from - 5) { words = clockText(from - total) + ' ahead'; kind = 'ahead'; }
    pace.textContent = words + ' · ' + clockText(Math.max(0, whole - total)) + ' left of ' + clockText(whole);
    pace.className = 'pace-text ' + kind;
    $('done').style.width = Math.min(100, total / whole * 100) + '%';
    $('plan').style.left = from / whole * 100 + '%';
    $('plan').style.width = Math.max(0.5, (to - from) / whole * 100) + '%';
  }
  setInterval(tick, 250);

  // ---- Drawing the slides: the audience's frame, and copies in the console and the grid.
  function fit() {
    const s = Math.min(innerWidth / W, innerHeight / H);
    frame.style.transform = 'scale(' + s + ')';
  }
  /** Shows `count` of a slide's points; what changes fades, unless `still`. */
  function showSteps(slide, count, still = false) {
    const marked = slide.querySelectorAll('[data-step]');
    if (still) marked.forEach(el => { el.style.transition = 'none'; });
    for (const el of marked) el.classList.toggle('dk-later', Number(el.dataset.step) > count);
    if (still) { void slide.offsetWidth; marked.forEach(el => { el.style.transition = ''; }); }
  }
  /** A copy of slide i in box, `count` points showing (all when null), fitted to the box's width. */
  function thumb(i, box, count) {
    box.querySelectorAll('.thumb').forEach(t => t.remove());
    if (i < 0 || i >= n) return null;
    const clone = slides[i].cloneNode(true);
    clone.classList.remove('off'); clone.classList.add('thumb'); clone.removeAttribute('aria-label'); clone.removeAttribute('role'); clone.setAttribute('aria-hidden', 'true');
    showSteps(clone, count === null ? Infinity : count);
    clone.querySelectorAll('[data-step]').forEach(el => { el.style.transition = 'none'; });
    clone.style.transform = 'scale(' + (box.clientWidth / W) + ')';
    box.prepend(clone);
    return clone;
  }
  const kindOf = i => {
    const t = data.transitions[i] || 'None';
    return reduced && t !== 'None' ? 'Fade' : t;
  };
  // The end of the transition still running: a turn settles it before it starts its own, so the
  // last one's late callback cannot hide the slide a quick turn back has brought in again.
  let settle = null;
  /** Turns to slide i with `count` points showing; `dir` is 1 forward, -1 back, 0 a jump. */
  function go(i, count, dir) {
    i = Math.min(Math.max(0, i), n - 1);
    if (settle) settle();
    const from = slides[at], to = slides[i];
    frame.getAnimations({ subtree: true }).forEach(a => a.finish());
    if (to !== from) {
      showSteps(to, count, true);
      to.classList.remove('off');
      const kind = kindOf(dir < 0 ? at : i);
      const time = { duration: kind === 'Push' ? 560 : 460, easing: 'cubic-bezier(.2,.7,.2,1)' };
      let over = false;
      const done = () => { if (over) return; over = true; settle = null; from.classList.add('off'); from.style.zIndex = ''; to.style.zIndex = ''; };
      if (kind === 'None' || !to.animate) done();
      else {
        settle = done;
        from.style.zIndex = 1; to.style.zIndex = 2;
        let anim;
        if (kind === 'Fade') anim = to.animate([{ opacity: 0 }, { opacity: 1 }], time);
        else if (kind === 'Push') {
          const d = dir < 0 ? -1 : 1;
          from.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(' + (-d * 100) + '%)' }], time);
          anim = to.animate([{ transform: 'translateX(' + (d * 100) + '%)' }, { transform: 'translateX(0)' }], time);
        } else {
          from.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.06)' }], time);
          anim = to.animate([{ opacity: 0, transform: 'scale(.86)' }, { opacity: 1, transform: 'scale(1)' }], time);
        }
        anim.finished.then(done, done);
      }
    } else showSteps(to, count);
    at = i; shown = count; ended = false;
    draw();
  }
  function draw(push) {
    body.classList.toggle('ended', ended);
    body.classList.toggle('black', cover === 'black');
    body.classList.toggle('white', cover === 'white');
    $('count').textContent = (at + 1) + ' / ' + n;
    $('progress').style.width = (n > 1 ? at / (n - 1) * 100 : 100) + '%';
    // The address keeps the slide where it can; a copy shown from text (srcdoc) has no address of its own.
    if (push !== false && !data.embedded && !audience) try { history.replaceState(null, '', '#' + (at + 1)); } catch { /* no address to keep */ }
    drawInk();
    if (body.classList.contains('presenter')) drawConsole();
    if (data.embedded) parent.postMessage({ deck: 'at', index: at }, '*');
    tell();
  }
  function drawConsole() {
    const steps = data.steps[at];
    $('pcount').textContent = ended ? 'End of the slides' : 'Slide ' + (at + 1) + ' of ' + n;
    $('now-step').textContent = steps ? '· point ' + shown + ' of ' + steps : '';
    const nowBox = $('now'), main = nowBox.parentElement;
    // The slide as large as the column lets it be, in its own shape.
    const strip = $('strip');
    if (!strip.childElementCount) slides.forEach((_, i) => {
      const b = document.createElement('button');
      b.setAttribute('aria-label', 'Slide ' + (i + 1) + ': ' + data.titles[i]);
      b.addEventListener('click', () => jump(i));
      strip.append(b);
      thumb(i, b, null);
      const sp = document.createElement('span'); sp.textContent = i + 1; b.append(sp);
    });
    [...strip.children].forEach((b, i) => b.classList.toggle('here', i === at));
    strip.children[at]?.scrollIntoView({ block: 'nearest', inline: 'center' });
    const width = Math.max(120, Math.min(main.clientWidth, (main.clientHeight - 28 - strip.offsetHeight - 8) * W / H));
    nowBox.style.width = width + 'px'; nowBox.style.height = width * H / W + 'px';
    thumb(at, nowBox, shown);
    sizeInk($('now-ink'), nowBox);
    if (shown < steps) { $('next-label').textContent = 'Next: point ' + (shown + 1) + ' of ' + steps; thumb(at, $('next-box'), shown + 1); }
    else if (at + 1 < n) { $('next-label').textContent = 'Next slide: ' + (data.titles[at + 1] || at + 2); thumb(at + 1, $('next-box'), 0); }
    else { $('next-label').textContent = 'Next: the end'; thumb(-1, $('next-box'), 0); }
    const notes = data.notes[at];
    $('notes').textContent = notes || 'No notes for this slide.';
    $('notes').classList.toggle('empty', !notes);
    $('c-black').setAttribute('aria-pressed', String(cover === 'black'));
    // The console stands where the slides would be, so it shows what the audience sees instead.
    $('now-cover').textContent = cover ? 'The audience sees a ' + cover + ' screen. Press ' + (cover === 'black' ? 'B' : 'W') + ' to show the slide again.' : '';
    drawTime();
  }

  // ---- Moving through the talk: a click brings the next point, then the next slide.
  function forward() {
    begin();
    if (ended) return;
    if (shown < data.steps[at]) { shown++; showSteps(slides[at], shown); draw(); }
    else if (at + 1 < n) go(at + 1, 0, 1);
    else { ended = true; draw(); }
  }
  function back() {
    if (ended) { ended = false; draw(); return; }
    if (shown > 0) { shown--; showSteps(slides[at], shown); draw(); }
    else if (at > 0) go(at - 1, data.steps[at - 1], -1);
  }
  const jump = i => { begin(); go(i, 0, 0); };

  // ---- The laser and the pen, in the slide's own pixels, so every copy draws them alike.
  function toSlide(e, box) {
    const r = box.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width * W, (e.clientY - r.top) / r.height * H];
  }
  function sizeInk(canvas, box) {
    const k = devicePixelRatio || 1;
    const w = Math.round(box.clientWidth * k), h = Math.round(box.clientHeight * k);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }
  function paint(canvas, laserEl, box) {
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#ff2d55'; ctx.lineWidth = 5;
    for (const line of ink.get(at) || []) {
      ctx.beginPath();
      line.forEach(([x, y], k) => k ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
      if (line.length === 1) ctx.lineTo(line[0][0] + 0.1, line[0][1]);
      ctx.stroke();
    }
    laserEl.style.display = laser && !ended ? 'block' : 'none';
    if (laser) { laserEl.style.left = laser[0] / W * box.clientWidth + 'px'; laserEl.style.top = laser[1] / H * box.clientHeight + 'px'; }
  }
  function drawInk() {
    paint($('ink'), $('laser'), { clientWidth: W, clientHeight: H });
    if (body.classList.contains('presenter')) paint($('now-ink'), $('now-laser'), $('now'));
  }
  function pointing(box) {
    box.addEventListener('pointermove', e => {
      if (tool === 'laser') { laser = toSlide(e, box); drawInk(); tell(); }
      if (tool === 'pen' && stroke) { stroke.push(toSlide(e, box)); drawInk(); tell(); }
    });
    box.addEventListener('pointerleave', () => { if (laser) { laser = null; drawInk(); tell(); } });
    box.addEventListener('pointerdown', e => {
      if (tool !== 'pen' || e.button !== 0) return;
      e.preventDefault();
      box.setPointerCapture?.(e.pointerId);
      stroke = [toSlide(e, box)];
      if (!ink.has(at)) ink.set(at, []);
      ink.get(at).push(stroke);
      drawInk(); tell();
    });
    box.addEventListener('pointerup', () => { stroke = null; });
  }
  function useTool(name) {
    tool = tool === name ? '' : name;
    laser = null; stroke = null;
    body.classList.toggle('laser', tool === 'laser');
    body.classList.toggle('pen', tool === 'pen');
    for (const id of ['b-laser', 'c-laser']) $(id).setAttribute('aria-pressed', String(tool === 'laser'));
    for (const id of ['b-pen', 'c-pen']) $(id).setAttribute('aria-pressed', String(tool === 'pen'));
    drawInk(); tell();
  }
  function clearInk() { ink.delete(at); drawInk(); tell(); }

  // ---- The console, and the audience window it drives.
  function presenter(on) {
    body.classList.toggle('presenter', on);
    if (on) { begin(); requestAnimationFrame(drawConsole); } else fit();
    drawTime();
  }
  /** Sends the audience window where the talk is. */
  function tell() {
    if (!peer || audience || peer.closed) return;
    try { peer.postMessage({ deck: 'state', at, shown, ended, cover, laser, ink: ink.get(at) || [] }, '*'); } catch { /* the window has gone */ }
  }
  function openAudience() {
    const url = location.href.replace(/#.*$/, '') + '#audience';
    const w = window.open(url, 'deck-audience', 'popup,width=' + Math.round(window.screen.width || 1280) + ',height=' + Math.round(window.screen.height || 720));
    if (!w) { $('pace').textContent = 'The browser kept the window from opening. Allow pop-ups for this file and try again.'; return; }
    peer = w;
    presenter(true);
  }
  addEventListener('message', e => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (audience && e.source === window.opener && m.deck === 'state') {
      if (m.at !== at) go(m.at, m.shown, m.at > at ? 1 : -1);
      else if (m.shown !== shown) { shown = m.shown; showSteps(slides[at], shown); }
      ended = !!m.ended; cover = m.cover || '';
      laser = m.laser; ink.set(at, m.ink || []);
      draw(false);
    } else if (!audience && peer && e.source === peer && m.deck === 'key') press(m.key);
    // The audience window says when its player is ready, however long its fonts took, and is told where the talk is.
    else if (!audience && peer && e.source === peer && m.deck === 'ready') tell();
    else if (data.embedded && e.source === parent && m.deck === 'go') jump(m.index);
  });

  function grid() {
    const g = $('grid');
    if (!g.childElementCount) slides.forEach((_, i) => {
      const b = document.createElement('button');
      b.setAttribute('aria-label', 'Slide ' + (i + 1) + ': ' + data.titles[i]);
      b.addEventListener('click', () => { body.classList.remove('grid'); jump(i); });
      g.append(b);
    });
    body.classList.toggle('grid');
    if (body.classList.contains('grid')) [...g.children].forEach((b, i) => { b.classList.toggle('here', i === at); b.querySelector('span')?.remove(); thumb(i, b, null); const sp = document.createElement('span'); sp.textContent = i + 1; b.append(sp); if (i === at) b.focus(); });
  }
  function full() {
    if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.().catch(() => {});
  }
  function finish() {
    if (data.embedded) parent.postMessage({ deck: 'close', index: at, timings: data.rehearse ? spent.map(s => Math.round(s)) : null }, '*');
    else if (audience) window.close();
    else presenter(false);
  }

  /** One key, from this window or forwarded from the audience window. True when it was the player's. */
  function press(k) {
    if (/^[0-9]$/.test(k)) { typed = (typed + k).slice(-3); return true; }
    if (k === 'Enter' && typed) { jump(Number(typed) - 1); typed = ''; return true; }
    typed = '';
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n', 'N'].includes(k)) forward();
    else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(k)) back();
    else if (k === 'Home') jump(0); else if (k === 'End') jump(n - 1);
    else if (k === 'p' || k === 'P') presenter(!body.classList.contains('presenter'));
    else if (k === 'g' || k === 'G') grid();
    else if (k === 'f' || k === 'F') full();
    else if (k === 'b' || k === 'B' || k === '.') { cover = cover === 'black' ? '' : 'black'; draw(false); }
    else if (k === 'w' || k === 'W' || k === ',') { cover = cover === 'white' ? '' : 'white'; draw(false); }
    else if (k === 'l' || k === 'L') useTool('laser');
    else if (k === 'd' || k === 'D') useTool('pen');
    else if (k === 'e' || k === 'E') clearInk();
    else if (k === 't' || k === 'T') { begin(); paused = !paused; last = performance.now(); drawTime(); }
    else if (k === '?') body.classList.toggle('help');
    else if (k === 'Escape') {
      if (body.classList.contains('grid')) body.classList.remove('grid');
      else if (body.classList.contains('help')) body.classList.remove('help');
      else if (tool) useTool(tool);
      else if (cover) { cover = ''; draw(false); }
      else if (body.classList.contains('presenter') && !data.rehearse) presenter(false);
      else finish();
    } else return false;
    return true;
  }
  addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if ((e.key === ' ' || e.key === 'Enter') && e.target.closest && e.target.closest('button, a, input, select, textarea')) return;
    // Full screen is the window's own: the audience window fills the projector, not the console's screen.
    if (audience && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); full(); return; }
    if (relay(e.key)) { e.preventDefault(); return; }
    if (press(e.key)) e.preventDefault();
  });
  /** In the audience window a key, click or swipe goes to the console, which holds where the talk is. */
  function relay(key) {
    if (!audience || !peer || peer.closed) return false;
    try { peer.postMessage({ deck: 'key', key }, '*'); } catch { /* gone */ }
    return true;
  }
  const turn = dir => { if (relay(dir > 0 ? 'ArrowRight' : 'ArrowLeft')) return; if (dir > 0) forward(); else back(); };

  frame.addEventListener('click', e => { if (tool === 'pen' || e.target.closest('a')) return; turn(e.clientX < innerWidth / 4 ? -1 : 1); });
  $('now').addEventListener('click', () => { if (tool !== 'pen') forward(); });
  pointing(frame); pointing($('now'));
  let touch = null;
  addEventListener('touchstart', e => { touch = e.touches[0].clientX; }, { passive: true });
  addEventListener('touchend', e => { if (touch === null || tool === 'pen') return; const dx = e.changedTouches[0].clientX - touch; if (Math.abs(dx) > 40) turn(dx < 0 ? 1 : -1); touch = null; });
  $('prev').onclick = () => turn(-1); $('next').onclick = () => turn(1);
  $('b-grid').onclick = grid; $('c-grid').onclick = grid; $('b-full').onclick = full;
  $('b-laser').onclick = $('c-laser').onclick = () => useTool('laser');
  $('b-pen').onclick = $('c-pen').onclick = () => useTool('pen');
  $('c-black').onclick = () => press('b');
  $('c-pause').onclick = () => press('t');
  $('c-reset').onclick = () => { total = 0; spent.fill(0); paused = false; running = false; begin(); drawTime(); };
  $('c-end').onclick = finish;
  $('b-pres').onclick = () => presenter(!body.classList.contains('presenter'));
  if ($('c-audience')) $('c-audience').onclick = openAudience;
  if ($('b-close')) $('b-close').onclick = finish;
  let notesSize = 22;
  try { notesSize = Number(localStorage.getItem('deck.notes.size')) || 22; } catch { /* no storage here */ }
  const setNotes = size => { notesSize = Math.min(48, Math.max(12, size)); $('console').style.setProperty('--notes', notesSize + 'px'); try { localStorage.setItem('deck.notes.size', String(notesSize)); } catch { /* no storage here */ } };
  $('n-smaller').onclick = () => setNotes(notesSize - 2); $('n-larger').onclick = () => setNotes(notesSize + 2);
  setNotes(notesSize);
  addEventListener('resize', () => { fit(); if (body.classList.contains('presenter')) drawConsole(); });

  // Every slide starts with its points hidden, as it will be when the talk reaches it, and only the
  // slide the talk opens on (the address's, when it names one) is in view.
  slides.forEach((s, i) => { showSteps(s, 0, true); s.classList.toggle('off', i !== at); });
  fit(); draw(false);
  if (data.rehearse) presenter(true);
  if (document.fonts) document.fonts.ready.then(fit);
  window.deckPlayer = { state: () => ({ at, shown, ended, cover, tool, total, spent: [...spent], presenter: body.classList.contains('presenter') }), press };
  if (audience && peer) try { peer.postMessage({ deck: 'ready' }, '*'); } catch { /* the console has gone */ }
  window.focus();
}
