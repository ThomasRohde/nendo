'use strict';

// The Workbench stand-in. The harness drives it over CDP; nothing here runs on its own
// except the message, violation and click recorders.
(() => {
  const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals allow-pointer-lock allow-presentation';
  const ALLOW = 'clipboard-read; clipboard-write; fullscreen';

  const spike = {
    messages: [],
    violations: [],
    clicks: 0,
    loads: {},

    addFrame(options) {
      const frame = document.createElement('iframe');
      frame.name = options.name;
      frame.setAttribute('sandbox', SANDBOX);
      frame.setAttribute('allow', ALLOW);
      frame.style.width = (options.width || 360) + 'px';
      frame.style.height = (options.height || 200) + 'px';
      if (options.lazy) frame.loading = 'lazy';
      spike.loads[options.name] = 0;
      frame.addEventListener('load', () => { spike.loads[options.name] = (spike.loads[options.name] || 0) + 1; });
      frame.src = options.src;
      document.getElementById(options.parent || 'stage').append(frame);
      return true;
    },

    frame: (name) => document.querySelector('iframe[name="' + name + '"]'),

    remove(name) {
      const frame = spike.frame(name);
      if (frame) frame.remove();
      return Boolean(frame);
    },

    clear() {
      document.querySelectorAll('iframe').forEach((frame) => frame.remove());
      spike.messages.length = 0;
      spike.violations.length = 0;
      spike.loads = {};
      document.getElementById('scroller').scrollTop = 0;
      return true;
    },

    // The frame's content box in the Workbench viewport, in CSS pixels.
    rect(name) {
      const frame = spike.frame(name);
      const r = frame.getBoundingClientRect();
      return { x: r.left + frame.clientLeft, y: r.top + frame.clientTop, w: frame.clientWidth, h: frame.clientHeight };
    },

    elementCenter(selector) {
      const r = document.querySelector(selector).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    },

    byType: (type, name) => spike.messages.filter((m) => m.data && m.data.type === type && m.data.name === name)
      .map((m) => ({ origin: m.origin, timeOrigin: m.data.timeOrigin, href: m.data.href, t: m.t })),
    hellos: (name) => spike.byType('hello', name),
    pongs: (name) => spike.byType('pong', name),

    ping(name) {
      spike.frame(name).contentWindow.postMessage({ type: 'ping' }, '*');
      return true;
    },

    async fetchProbe(url) {
      const before = spike.violations.length;
      let outcome;
      try {
        const response = await fetch(url, { cache: 'no-store' });
        outcome = 'resolved with status ' + response.status;
      } catch (e) {
        outcome = e.name + ': ' + e.message;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { outcome, violations: spike.violations.slice(before) };
    },

    rafRate(ms) {
      return new Promise((resolve) => {
        let frames = 0;
        const end = performance.now() + ms;
        const tick = () => {
          frames += 1;
          if (performance.now() < end) requestAnimationFrame(tick); else resolve(frames);
        };
        requestAnimationFrame(tick);
      });
    },

    lazyGeometry(name) {
      const scroller = document.getElementById('scroller');
      const s = scroller.getBoundingClientRect();
      const f = spike.frame(name).getBoundingClientRect();
      return {
        scrollTop: scroller.scrollTop,
        scrollerHeight: scroller.clientHeight,
        scrollerBottomInViewport: Math.round(s.bottom),
        viewportHeight: innerHeight,
        distanceBelowVisibleBottom: Math.round(f.top - s.bottom),
      };
    },

    // Frames nested inside the view frames, as the Workbench can reach them.
    nestedAppFrames() {
      const out = [];
      for (let i = 0; i < window.frames.length; i++) {
        let count = 0;
        try { count = window.frames[i].frames.length; } catch (e) { out.push({ view: i, error: e.name }); continue; }
        for (let j = 0; j < count; j++) {
          const nested = window.frames[i].frames[j];
          try {
            out.push({
              view: i,
              nested: j,
              href: nested.location.href,
              sameOriginWithWorkbench: true,
              chromeWebview: typeof nested.chrome?.webview,
              readsWorkbenchDocument: nested.top.document === document,
            });
          } catch (e) {
            out.push({ view: i, nested: j, sameOriginWithWorkbench: false, error: e.name });
          }
        }
      }
      return out;
    },

    postFromNestedApp() {
      const out = [];
      for (let i = 0; i < window.frames.length; i++) {
        let count = 0;
        try { count = window.frames[i].frames.length; } catch { continue; }
        for (let j = 0; j < count; j++) {
          try {
            const nested = window.frames[i].frames[j];
            if (nested.chrome?.webview) {
              nested.chrome.webview.postMessage({ from: 'nested app-origin frame', href: nested.location.href });
              out.push('posted from ' + nested.location.href);
            } else {
              out.push('no chrome.webview in ' + nested.location.href);
            }
          } catch (e) {
            out.push(e.name);
          }
        }
      }
      return out;
    },
  };

  window.spike = spike;
  window.addEventListener('message', (e) => { spike.messages.push({ origin: e.origin, data: e.data, t: performance.now() }); });
  document.addEventListener('securitypolicyviolation', (e) => {
    spike.violations.push({ directive: e.effectiveDirective, blocked: e.blockedURI, disposition: e.disposition });
  });
  spike.onClick = null;
  spike.clickResults = [];
  document.getElementById('wb-button').addEventListener('click', async () => {
    spike.clicks += 1;
    if (!spike.onClick) return;
    try {
      spike.clickResults.push(await spike.onClick());
    } catch (e) {
      spike.clickResults.push({ error: e.name + ': ' + e.message });
    }
  });
})();
