// The HTML export: one self-contained file that plays the deck in any browser. Slides are the
// same HTML the stage draws, pictures are inlined, and a small player moves through them. Present
// in the view plays this same file in a frame, so rehearsing and sharing show the same thing.

import { SLIDE_CSS } from './render.mjs';
import { webFonts } from './themes.mjs';

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
// JSON in a script element: never let the text close the element.
const json = value => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/** slides: [{html, notes, title}] already drawn with inlined pictures. */
export function buildHtml({ title, author = '', W, H, slides, theme, start = 0, embedded = false }) {
  const fonts = webFonts(theme);
  const bg = theme.colors.bg;
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
#deck{position:fixed;inset:0;display:grid;place-items:center}
#frame{position:relative;width:${W}px;height:${H}px;transform-origin:center;box-shadow:0 20px 60px rgba(0,0,0,.5)}
#frame>.dk-slide{position:absolute;inset:0;transition:opacity .28s ease}
#frame>.dk-slide.off{opacity:0;pointer-events:none}
#bar{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);display:flex;gap:6px;align-items:center;padding:6px 8px;border-radius:999px;background:rgba(20,20,22,.78);backdrop-filter:blur(8px);opacity:0;transition:opacity .2s;z-index:5}
body:hover #bar,#bar:focus-within{opacity:1}
#bar button{all:unset;cursor:pointer;padding:6px 10px;border-radius:999px;color:#fff;font-size:13px}
#bar button:hover,#bar button:focus-visible{background:rgba(255,255,255,.16)}
#count{font-variant-numeric:tabular-nums;color:#ccc;padding:0 6px}
#progress{position:fixed;left:0;top:0;height:3px;background:${esc(theme.colors.primary)};transition:width .3s;z-index:5}
#presenter{position:fixed;inset:0;display:none;grid-template-columns:62% 38%;grid-template-rows:auto 1fr;gap:16px;padding:20px;background:#111;z-index:4;box-sizing:border-box}
body.presenter #presenter{display:grid}
body.presenter #deck{display:none}
#presenter .now,#presenter .next{position:relative;overflow:hidden;background:${esc(bg)};border-radius:8px}
#presenter .now{grid-row:1/3}
#presenter .side{display:flex;flex-direction:column;gap:12px;min-height:0}
#presenter .clock{font:600 34px/1 'Segoe UI',system-ui,sans-serif;font-variant-numeric:tabular-nums;color:#fff;display:flex;justify-content:space-between;align-items:baseline}
#presenter .clock small{font-size:14px;color:#aaa;font-weight:400}
#presenter .notes{flex:1;overflow:auto;font-size:20px;line-height:1.5;color:#eee;white-space:pre-wrap;background:#1b1b1e;border-radius:8px;padding:16px}
#presenter .label{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#888}
#grid{position:fixed;inset:0;overflow:auto;display:none;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:18px;padding:28px;background:#111;z-index:6;box-sizing:border-box}
body.grid #grid{display:grid}
#grid button{all:unset;cursor:pointer;position:relative;aspect-ratio:${W}/${H};overflow:hidden;border-radius:6px;outline:2px solid transparent;background:${esc(bg)}}
#grid button:focus-visible,#grid button.here{outline-color:${esc(theme.colors.primary)}}
#grid button span{position:absolute;left:8px;bottom:6px;font-size:12px;color:#fff;background:rgba(0,0,0,.55);padding:1px 6px;border-radius:4px}
.thumb{position:absolute;left:0;top:0;transform-origin:0 0}
#help{position:fixed;right:16px;top:16px;max-width:280px;padding:14px 16px;border-radius:10px;background:rgba(20,20,22,.92);font-size:13px;display:none;z-index:7}
body.help #help{display:block}
#help kbd{display:inline-block;min-width:18px;text-align:center;padding:0 4px;border:1px solid #555;border-radius:4px;margin-right:6px;font:12px Consolas,monospace}
@media print{
  @page{size:${W}px ${H}px;margin:0}
  html,body{overflow:visible;height:auto;background:none}
  #bar,#progress,#presenter,#grid,#help{display:none!important}
  #deck,body.presenter #deck{position:static;display:block}
  #frame{transform:none!important;box-shadow:none;width:auto;height:auto}
  #frame>.dk-slide{position:relative;opacity:1!important;page-break-after:always;break-after:page}
}
</style>
</head>
<body>
<div id="progress"></div>
<main id="deck" aria-live="polite"><div id="frame">
${slides.map((s, i) => s.html.replace('class="dk-slide ', `class="dk-slide ${i === start ? '' : 'off'} `).replace('<div class="dk-slide', `<div role="group" aria-roledescription="slide" aria-label="${i + 1} of ${slides.length}: ${esc(s.title)}" class="dk-slide`)).join('\n')}
</div></main>
<section id="presenter" aria-label="Presenter view"><div class="now"></div><div class="side"><div class="clock"><span id="clock">0:00</span><small id="pcount"></small></div><div class="label">Next</div><div class="next" style="aspect-ratio:${W}/${H}"></div><div class="label">Notes</div><div class="notes" id="notes"></div></div></section>
<nav id="grid" aria-label="All slides"></nav>
<div id="bar" role="toolbar" aria-label="Slides"><button id="prev" aria-label="Previous slide">&#8592;</button><span id="count"></span><button id="next" aria-label="Next slide">&#8594;</button><button id="b-grid" title="All slides (G)">Slides</button><button id="b-pres" title="Presenter view (P)">Presenter</button><button id="b-full" title="Full screen (F)">Full screen</button>${embedded ? '<button id="b-close" title="Stop presenting (Esc)">Close</button>' : ''}</div>
<div id="help"><p><kbd>&#8594;</kbd>next &nbsp;<kbd>&#8592;</kbd>back</p><p><kbd>P</kbd>presenter view with notes and a clock</p><p><kbd>G</kbd>all slides &nbsp;<kbd>F</kbd>full screen</p><p><kbd>B</kbd>black screen &nbsp;<kbd>Ctrl P</kbd>print or PDF</p></div>
<script type="application/json" id="data">${json({ notes: slides.map(s => s.notes ?? ''), titles: slides.map(s => s.title ?? ''), start, embedded })}</script>
<script>
(() => {
  const data = JSON.parse(document.getElementById('data').textContent);
  const frame = document.getElementById('frame');
  const slides = [...frame.children];
  const W = ${W}, H = ${H}, n = slides.length;
  const fromHash = (location.hash.match(/^#(\\d+)$/) || [])[1];
  let at = Math.min(Math.max(0, fromHash ? Number(fromHash) - 1 : data.start), n - 1);
  let started = null, black = false;
  const $ = id => document.getElementById(id);
  function fit() {
    const s = Math.min(innerWidth / W, innerHeight / H);
    frame.style.transform = 'scale(' + s + ')';
  }
  function thumb(i, box) {
    box.querySelectorAll('.thumb').forEach(t => t.remove());
    if (i < 0 || i >= n) return;
    const clone = slides[i].cloneNode(true);
    clone.classList.remove('off'); clone.classList.add('thumb'); clone.removeAttribute('aria-label'); clone.setAttribute('aria-hidden', 'true');
    clone.style.transform = 'scale(' + (box.clientWidth / W) + ')';
    box.append(clone);
  }
  function show(i, push) {
    at = Math.min(Math.max(0, i), n - 1);
    slides.forEach((s, k) => s.classList.toggle('off', k !== at || black));
    $('count').textContent = (at + 1) + ' / ' + n;
    $('pcount').textContent = 'Slide ' + (at + 1) + ' of ' + n;
    $('progress').style.width = (n > 1 ? at / (n - 1) * 100 : 100) + '%';
    // The address keeps the slide where it can; a copy shown from text (srcdoc) has no address of its own.
    if (push !== false && !data.embedded) try { history.replaceState(null, '', '#' + (at + 1)); } catch { /* no address to keep */ }
    if (document.body.classList.contains('presenter')) presenter();
    if (data.embedded) parent.postMessage({ deck: 'at', index: at }, '*');
  }
  function presenter() {
    thumb(at, document.querySelector('#presenter .now'));
    thumb(at + 1, document.querySelector('#presenter .next'));
    $('notes').textContent = data.notes[at] || 'No notes for this slide.';
  }
  function grid() {
    const g = $('grid');
    if (!g.childElementCount) slides.forEach((_, i) => {
      const b = document.createElement('button');
      b.setAttribute('aria-label', 'Slide ' + (i + 1) + ': ' + data.titles[i]);
      b.addEventListener('click', () => { document.body.classList.remove('grid'); show(i); });
      g.append(b);
    });
    document.body.classList.toggle('grid');
    if (document.body.classList.contains('grid')) [...g.children].forEach((b, i) => { b.classList.toggle('here', i === at); const sp = document.createElement('span'); thumb(i, b); b.querySelector('span')?.remove(); sp.textContent = i + 1; b.append(sp); if (i === at) b.focus(); });
  }
  function full() {
    if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.().catch(() => {});
  }
  function tick() {
    if (started === null) return;
    const s = Math.floor((Date.now() - started) / 1000);
    $('clock').textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  setInterval(tick, 1000);
  addEventListener('resize', () => { fit(); if (document.body.classList.contains('presenter')) presenter(); });
  addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if ((k === ' ' || k === 'Enter') && e.target.closest && e.target.closest('button, a, input, select, textarea')) return;
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n'].includes(k)) { e.preventDefault(); show(at + 1); }
    else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(k)) { e.preventDefault(); show(at - 1); }
    else if (k === 'Home') show(0); else if (k === 'End') show(n - 1);
    else if (k === 'p' || k === 'P') { document.body.classList.toggle('presenter'); started ??= Date.now(); presenter(); tick(); }
    else if (k === 'g' || k === 'G') grid();
    else if (k === 'f' || k === 'F') full();
    else if (k === 'b' || k === 'B' || k === '.') { black = !black; show(at, false); }
    else if (k === '?') document.body.classList.toggle('help');
    else if (k === 'Escape') {
      if (document.body.classList.contains('grid')) document.body.classList.remove('grid');
      else if (document.body.classList.contains('help')) document.body.classList.remove('help');
      else if (document.body.classList.contains('presenter')) { document.body.classList.remove('presenter'); fit(); }
      else if (data.embedded) parent.postMessage({ deck: 'close', index: at }, '*');
    }
  });
  frame.addEventListener('click', e => { if (!e.target.closest('a')) show(at + (e.clientX < innerWidth / 4 ? -1 : 1)); });
  let touch = null;
  addEventListener('touchstart', e => { touch = e.touches[0].clientX; }, { passive: true });
  addEventListener('touchend', e => { if (touch === null) return; const dx = e.changedTouches[0].clientX - touch; if (Math.abs(dx) > 40) show(at + (dx < 0 ? 1 : -1)); touch = null; });
  $('prev').onclick = () => show(at - 1); $('next').onclick = () => show(at + 1);
  $('b-grid').onclick = grid; $('b-full').onclick = full;
  $('b-pres').onclick = () => { document.body.classList.toggle('presenter'); started ??= Date.now(); presenter(); };
  if ($('b-close')) $('b-close').onclick = () => parent.postMessage({ deck: 'close', index: at }, '*');
  addEventListener('message', e => { if (e.source === parent && e.data && e.data.deck === 'go') show(e.data.index); });
  fit(); show(at, false);
  if (document.fonts) document.fonts.ready.then(fit);
  window.focus();
})();
</script>
</body>
</html>
`;
}
