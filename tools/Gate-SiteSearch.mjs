async (page) => {
  // The built public site in a real browser (tools/Test-SiteSearch.ps1 serves dist/ and
  // runs this). It began as the docs-search measurement and now measures the rest of
  // what only a browser can: layout at each width, the header's height, contrast and
  // focus rings in both themes, the accessible names, the page without script, motion
  // and the home page's first download. Every check records a failure and the run
  // goes on, so one run reports every defect; the ID in each message is the FIXES.md
  // finding the check guards.
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  const SITE = '__SITE_URL__/nendo';
  const guides = ['agents', 'calculations-and-actions', 'concepts', 'custom-views', 'files-and-data', 'getting-started', 'roadmap', 'screens'];
  const pages = ['/', '/concept/', '/how-it-works/', '/use/', '/status/', '/docs/', ...guides.map(id => `/docs/${id}/`), '/404.html'];
  const measurements = [];

  const open = async (path, width, height = 900) => {
    await page.setViewportSize({ width, height });
    await page.goto(`${SITE}${path}`);
    await page.evaluate(() => document.fonts.ready.then(() => true));
  };
  // Smooth scrolling and a late layout change both move the page after load, so a
  // position is read only once scrollY has held still for several frames.
  const settled = () => page.waitForFunction(() => new Promise(resolve => {
    let last = scrollY;
    let still = 0;
    const frame = () => {
      still = scrollY === last ? still + 1 : 0;
      last = scrollY;
      if (still >= 8) resolve(true); else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }), null, { timeout: 5000 });
  const setTheme = async theme => {
    await page.goto(`${SITE}/`);
    await page.evaluate(choice => localStorage.setItem('nendo.appearance', choice), theme);
  };

  // Shared colour arithmetic, installed in every page before its own scripts run. The
  // rAF sampler records how far the document is ever wider than the window during
  // the first 1.5 s, which a measurement after load cannot see (SITE-26).
  await page.addInitScript(() => {
    const parse = value => {
      let match = value.match(/^rgba?\(([^)]+)\)$/);
      if (match) {
        const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
        return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 };
      }
      match = value.match(/^color\(srgb ([^)]+)\)$/);
      if (match) {
        const parts = match[1].split(/[\s/]+/).filter(Boolean).map(Number);
        return { r: parts[0] * 255, g: parts[1] * 255, b: parts[2] * 255, a: parts[3] ?? 1 };
      }
      return null;
    };
    const over = (top, bottom) => ({
      r: top.r * top.a + bottom.r * (1 - top.a),
      g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a),
      a: 1,
    });
    const luminance = c => {
      const channel = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
    };
    const ratio = (a, b) => {
      const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (high + 0.05) / (low + 0.05);
    };
    // The colour behind an element: its own and its ancestors' backgrounds, composited
    // down to the first opaque one. A gradient is skipped for the colour beneath it.
    const background = element => {
      const layers = [];
      for (let node = element; node; node = node.parentElement) {
        const colour = parse(getComputedStyle(node).backgroundColor);
        if (colour && colour.a > 0) { layers.push(colour); if (colour.a >= 1) break; }
      }
      let result = { r: 255, g: 255, b: 255, a: 1 };
      for (const layer of layers.reverse()) result = over(layer, result);
      return result;
    };
    const show = c => `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;
    window.__siteGate = { parse, over, ratio, background, show };

    window.__maxOverflow = 0;
    const started = performance.now();
    const sample = () => {
      const root = document.documentElement;
      if (root) window.__maxOverflow = Math.max(window.__maxOverflow, root.scrollWidth - root.clientWidth);
      if (performance.now() - started < 1500) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);

    // Whether the guide list was open when the parser reached the #fragment's target.
    // A list closed after that point (a deferred script) shrinks under the reader and
    // carries the heading the browser scrolled to up past the header (SITE-04). Where
    // the browser keeps the heading in place anyway, this still sees the late close.
    window.__guidesOpenAtTarget = undefined;
    const id = location.hash ? decodeURIComponent(location.hash.slice(1)) : '';
    if (id) {
      const watch = new MutationObserver(() => {
        if (!document.getElementById(id)) return;
        window.__guidesOpenAtTarget = document.querySelector('.docs-guides')?.open ?? null;
        watch.disconnect();
      });
      watch.observe(document, { childList: true, subtree: true });
      document.addEventListener('DOMContentLoaded', () => watch.disconnect());
    }
  });

  // ---- The documentation search: geometry and clicks (R02-021) ----
  for (const theme of ['light', 'dark']) {
    await setTheme(theme);
    for (const width of [1280, 1024, 768, 390]) {
      await open('/docs/getting-started/', width);
      const baselineScrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      // Exercise the built Pagefind index and the shipped input listener.
      await page.locator('#docs-search-input').fill('record');
      const panel = page.locator('.docs-search-results');
      await panel.waitFor({ state: 'visible' });
      await panel.locator('a').first().waitFor({ state: 'visible' });
      const result = await page.evaluate(() => {
        const panel = document.querySelector('.docs-search-results');
        const rail = document.querySelector('.docs-rail');
        const bounds = panel.getBoundingClientRect();
        const railBounds = rail.getBoundingClientRect();
        const first = panel.querySelector('a');
        const anchor = first.getBoundingClientRect();
        const x = anchor.right - 2;
        const y = anchor.top + Math.min(anchor.height / 2, 30);
        const hit = document.elementFromPoint(x, y);
        return {
          theme: document.documentElement.dataset.theme,
          width: innerWidth, panelLeft: bounds.left, panelRight: bounds.right, panelWidth: bounds.width,
          railRight: railBounds.left + rail.clientWidth,
          hit: hit?.tagName ?? null, linkHit: first.contains(hit), results: panel.querySelectorAll('a').length,
          scrollWidth: document.documentElement.scrollWidth,
        };
      });
      check(result.theme === theme, `Site theme did not become ${theme}.`);
      check(result.panelRight <= result.railRight + 1 && result.panelLeft >= 0 && result.panelRight <= width,
        `R02-021: search panel is clipped at ${width}px ${theme}: panel right ${result.panelRight}, rail right ${result.railRight}.`);
      check(result.linkHit, `R02-021: search result right edge is not clickable at ${width}px ${theme}; hit ${result.hit}.`);
      check(result.scrollWidth <= baselineScrollWidth, `Search introduced horizontal overflow at ${width}px ${theme}.`);
      // Measure the right edge of every result after scrolling it into the panel.
      for (const link of await panel.locator('a').all()) {
        await link.scrollIntoViewIfNeeded();
        const reachable = await link.evaluate(anchor => {
          const box = anchor.getBoundingClientRect();
          const hit = document.elementFromPoint(box.right - 2, box.top + Math.min(box.height / 2, 30));
          return anchor.contains(hit);
        });
        check(reachable, `A search result is clipped after scrolling at ${width}px ${theme}.`);
      }
      measurements.push(result);
    }
  }

  // ---- The search as a combobox, from the keyboard (SITE-08, SITE-09) ----
  await setTheme('light');
  await open('/docs/getting-started/', 1280);
  const field = page.locator('#docs-search-input');
  await field.click();
  await field.pressSequentially('lease', { delay: 30 });
  await page.locator('.docs-search-results a').first().waitFor({ state: 'visible' });
  await page.waitForTimeout(400);
  const searched = await page.evaluate(() => ({
    expanded: document.querySelector('#docs-search-input').getAttribute('aria-expanded'),
    role: document.querySelector('#docs-search-input').getAttribute('role'),
    status: document.querySelector('.docs-search-status')?.textContent ?? '',
    hrefs: [...document.querySelectorAll('.docs-search-results a')].map(a => a.getAttribute('href')),
  }));
  check(searched.role === 'combobox' && searched.expanded === 'true',
    `SITE-08: the search field is not announced as an expanded combobox while results show (role ${searched.role}, aria-expanded ${searched.expanded}).`);
  check(/result/.test(searched.status), `SITE-08: results arrived and the live status line announced nothing (it reads "${searched.status}").`);
  check(searched.hrefs.some(href => href.includes('#the-lease')),
    `SITE-09: searching "lease" links only to the tops of guides, not to the section "The lease": ${JSON.stringify(searched.hrefs)}.`);
  await page.keyboard.press('ArrowDown');
  const arrowed = await page.evaluate(() => document.activeElement?.closest('.docs-search-results') !== null);
  check(arrowed, 'SITE-08: ArrowDown in the search field does not move to the results.');
  await page.keyboard.press('Escape');
  await field.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  const escaped = await page.evaluate(() => ({
    value: document.querySelector('#docs-search-input').value,
    hidden: document.querySelector('.docs-search-results').hidden,
    active: document.activeElement?.id ?? document.activeElement?.tagName,
  }));
  check(escaped.hidden, 'SITE-08: Escape did not close the search results.');
  check(escaped.value === 'lease', `SITE-08: Escape wiped the reader's query (the field reads "${escaped.value}").`);
  check(escaped.active === 'docs-search-input', `SITE-08: Escape moved the focus out of the search field, to ${escaped.active}.`);
  await field.fill('');
  await field.pressSequentially('lease', { delay: 30 });
  await page.locator('.docs-search-results a').first().waitFor({ state: 'visible' });
  await page.keyboard.press('Tab');
  const tabbed = await page.evaluate(() => ({
    expanded: document.querySelector('#docs-search-input').getAttribute('aria-expanded'),
    hidden: document.querySelector('.docs-search-results').hidden,
  }));
  check(tabbed.hidden && tabbed.expanded === 'false',
    `SITE-08: tabbing out of the search field left its results open (hidden ${tabbed.hidden}, aria-expanded ${tabbed.expanded}).`);

  // ---- Layout at every width (SITE-01, SITE-02, SITE-25, SITE-13) ----
  for (const width of [1440, 1024, 800, 375, 320]) {
    for (const path of pages) {
      await open(path, width, width <= 375 ? 812 : 900);
      const layout = await page.evaluate(() => {
        const root = document.documentElement;
        const body = document.querySelector('.docs-body');
        const toc = document.querySelector('.docs-toc');
        const tocVisible = toc && getComputedStyle(toc).display !== 'none';
        const spills = [];
        if (body) {
          const limit = Math.min(body.getBoundingClientRect().right, tocVisible ? toc.getBoundingClientRect().left : Infinity);
          for (const table of body.querySelectorAll('table, pre')) {
            let visibleRight = table.getBoundingClientRect().right;
            for (let node = table.parentElement; node && node !== body; node = node.parentElement) {
              if (getComputedStyle(node).overflowX !== 'visible') { visibleRight = Math.min(visibleRight, node.getBoundingClientRect().right); break; }
            }
            if (visibleRight > limit + 1) spills.push(`${table.tagName.toLowerCase()} right ${Math.round(visibleRight)} past ${Math.round(limit)}`);
          }
        }
        const h1 = document.querySelector('h1')?.getBoundingClientRect().top ?? 0;
        // An in-page link a reader can reach: drawn on the page, or inside a closed
        // disclosure whose summary is drawn. A link in a column hidden at this width is not.
        const reachableLink = a => {
          if (a.getClientRects().length > 0) return true;
          const details = a.closest('details');
          return Boolean(details && !details.open && details.querySelector('summary')?.getClientRects().length > 0
            && getComputedStyle(details).display !== 'none');
        };
        const h2Ids = [...document.querySelectorAll('.prose > h2[id]')].map(h => h.id);
        const reachable = new Set([...document.querySelectorAll('nav a[href^="#"]')].filter(reachableLink).map(a => a.getAttribute('href')));
        const brokenNames = [...document.querySelectorAll('.operations code')].filter(code => code.getClientRects().length > 1).map(code => code.textContent);
        return {
          scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, spills, h1, innerHeight,
          isGuide: !!body, tocVisible, unreachable: h2Ids.filter(id => !reachable.has(`#${id}`)), brokenNames,
        };
      });
      check(layout.scrollWidth <= layout.clientWidth,
        `SITE-01/02/25: ${path} scrolls sideways at ${width}px: the document is ${layout.scrollWidth}px wide in a ${layout.clientWidth}px window.`);
      for (const spill of layout.spills) check(false, `SITE-01: on ${path} at ${width}px a ${spill} (the column's edge or the On-this-page list).`);
      check(layout.brokenNames.length === 0,
        `SITE-02: on ${path} at ${width}px ${layout.brokenNames.length} operation name(s) break across lines instead of the table scrolling: ${layout.brokenNames.slice(0, 3).join(', ')}.`);
      if (layout.isGuide && width <= 1100) {
        check(layout.unreachable.length === 0,
          `SITE-13: ${path} at ${width}px has no in-page link to ${layout.unreachable.length} of its sections (${layout.unreachable.slice(0, 3).join(', ')}).`);
      }
      // The finding's own bound (the title inside the first screen) passed against the
      // defect, whose title sat at about 590px of 812. The guide list ahead of it is
      // what pushed it down, so the title must start in the top half of the screen.
      if (layout.isGuide && width <= 375) {
        check(layout.h1 < layout.innerHeight / 2,
          `SITE-13: on ${path} at ${width}px the title starts at ${Math.round(layout.h1)}px, below the top half of a ${layout.innerHeight}px screen: the whole guide list comes first.`);
      }
    }
  }

  // ---- The hero mark's settle animation (SITE-26) ----
  for (const width of [900, 1024, 1100]) {
    await page.mouse.move(1, 1);
    await open('/', width);
    await page.waitForTimeout(1700);
    const overflow = await page.evaluate(() => window.__maxOverflow);
    check(overflow <= 0, `SITE-26: the home page was ${overflow}px wider than a ${width}px window during its first second.`);
  }

  // ---- The sticky header's height (SITE-04) ----
  for (const width of [1440, 860, 800, 375]) {
    // A query per width makes each a fresh load: the same URL again with only the
    // fragment is a same-document jump, which re-measures the previous width's page.
    await open(`/docs/files-and-data/?width=${width}#history-and-undo`, width, 800);
    await settled();
    const anchor = await page.evaluate(() => ({
      header: document.querySelector('.site-nav').getBoundingClientRect().bottom,
      heading: document.getElementById('history-and-undo').getBoundingClientRect().top,
      openAtTarget: window.__guidesOpenAtTarget,
    }));
    if (width <= 820) {
      check(anchor.openAtTarget === false,
        `SITE-04: at ${width}px the guide list was still open (${anchor.openAtTarget}) when the page reached #history-and-undo, so closing it afterwards moves the heading the browser scrolled to.`);
    }
    // scroll-padding-top puts the heading 24px below the header; 48px allows for the
    // heading's own margin.
    check(anchor.heading >= anchor.header - 0.5 && anchor.heading <= anchor.header + 48,
      `SITE-04: at ${width}px a link to #history-and-undo lands the heading at ${Math.round(anchor.heading)}px, not just below the ${Math.round(anchor.header)}px header.`);
  }
  for (const width of [1440, 1024, 860]) {
    await open('/docs/agents/', width, 800);
    await page.evaluate(() => window.scrollTo({ top: 2000, behavior: 'instant' }));
    await page.waitForFunction(() => scrollY >= 1990, null, { timeout: 5000 });
    await settled();
    const rail = await page.evaluate(() => ({
      header: document.querySelector('.site-nav').getBoundingClientRect().bottom,
      rail: document.querySelector('.docs-rail').getBoundingClientRect().top,
    }));
    check(rail.rail >= rail.header - 0.5,
      `SITE-04: at ${width}px the docs rail sticks at ${Math.round(rail.rail)}px, under the ${Math.round(rail.header)}px header, hiding its search field.`);
  }

  // ---- The header on a phone (SITE-05, SITE-12) ----
  const cdp = await page.context().newCDPSession(page);
  for (const path of ['/', '/docs/agents/']) {
    await open(path, 375, 812);
    await cdp.send('DOM.enable');
    await cdp.send('Accessibility.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '.site-nav a, .site-nav button' });
    const names = [];
    for (const nodeId of nodeIds) {
      const { nodes } = await cdp.send('Accessibility.getPartialAXTree', { nodeId, fetchRelatives: false });
      const node = nodes.find(item => !item.ignored) ?? nodes[0];
      const { outerHTML } = await cdp.send('DOM.getOuterHTML', { nodeId });
      names.push(node?.name?.value?.trim() ?? '');
      check(Boolean(node?.name?.value?.trim()),
        `SITE-05: on ${path} at 375px a header control has no accessible name: ${outerHTML.slice(0, 80)}.`);
    }
    // The phone label is shortened for sight only; the link keeps its full name.
    check(names.includes('Using Nendo'), `SITE-12: on ${path} at 375px the shortened "Using" link lost its full name; the header's names are ${JSON.stringify(names)}.`);
    const row = await page.evaluate(() => {
      const nav = document.querySelector('.site-nav nav').getBoundingClientRect();
      return [...document.querySelectorAll('.site-nav nav a')].map(a => {
        const box = a.getBoundingClientRect();
        return { label: a.textContent.trim(), inside: box.left >= nav.left - 0.5 && box.right <= nav.right + 0.5, right: Math.round(box.right), navRight: Math.round(nav.right) };
      });
    });
    for (const link of row) check(link.inside, `SITE-12: on ${path} at 375px the header's "${link.label}" link is cut off at the row's edge (right ${link.right}, row ends ${link.navRight}).`);
  }
  await open('/docs/agents/', 320, 700);
  const current = await page.evaluate(() => {
    const nav = document.querySelector('.site-nav nav').getBoundingClientRect();
    const link = document.querySelector('.site-nav nav a[aria-current="page"]').getBoundingClientRect();
    return { visible: link.left >= nav.left - 0.5 && link.right <= nav.right + 0.5, right: Math.round(link.right), navRight: Math.round(nav.right) };
  });
  check(current.visible, `SITE-12: at 320px the current page's header link is off the row (right ${current.right}, row ends ${current.navRight}).`);

  // ---- Contrast and focus rings in both themes (SITE-06, SITE-07) ----
  for (const theme of ['light', 'dark']) {
    await setTheme(theme);
    for (const path of pages) {
      await page.mouse.move(1, 1);
      await open(path, 1280);
      const low = await page.evaluate(() => {
        const { parse, over, ratio, background, show } = window.__siteGate;
        const found = [];
        for (const element of document.body.querySelectorAll('*')) {
          if (element.closest('script, style, svg, video, .shot-frame')) continue;
          const own = [...element.childNodes].some(node => node.nodeType === 3 && node.textContent.trim() !== '');
          if (!own) continue;
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          if (box.width <= 1 || box.height <= 1 || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
          const behind = background(element);
          let colour = parse(style.color);
          if (!colour) continue;
          if (colour.a < 1) colour = over(colour, behind);
          const size = parseFloat(style.fontSize);
          const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
          const need = large ? 3 : 4.5;
          const value = ratio(colour, behind);
          if (value < need) found.push(`"${element.textContent.trim().slice(0, 40)}" (${element.tagName.toLowerCase()}.${[...element.classList].join('.')}) ${value.toFixed(2)}:1, needs ${need}: ${show(colour)} on ${show(behind)}`);
        }
        for (const control of document.querySelectorAll('input, select, textarea')) {
          const box = control.getBoundingClientRect();
          if (box.width <= 1) continue;
          const border = parse(getComputedStyle(control).borderTopColor);
          const behind = background(control.parentElement);
          const value = ratio(border.a < 1 ? over(border, behind) : border, behind);
          if (value < 3) found.push(`the boundary of #${control.id || control.tagName.toLowerCase()} ${value.toFixed(2)}:1, needs 3: ${show(border)} on ${show(behind)}`);
        }
        return found;
      });
      for (const item of low.slice(0, 6)) check(false, `SITE-06: ${theme} ${path}: ${item}.`);
    }

    // Tab through the home page and measure each focus ring against what is behind it.
    await open('/', 1280);
    await page.evaluate(() => document.activeElement?.blur());
    const rings = [];
    for (let stop = 0; stop < 70; stop++) {
      await page.keyboard.press('Tab');
      const ring = await page.evaluate(() => {
        const element = document.activeElement;
        if (!element || element === document.body) return null;
        const { parse, ratio, background, show } = window.__siteGate;
        const style = getComputedStyle(element);
        const colour = parse(style.outlineColor);
        const behind = background(element.parentElement);
        const width = parseFloat(style.outlineWidth);
        const box = element.getBoundingClientRect();
        const reach = width + Math.max(0, parseFloat(style.outlineOffset) || 0);
        const ring = { left: box.left - reach, right: box.right + reach, top: box.top - reach, bottom: box.bottom + reach };
        let clippedBy = null;
        for (let node = element.parentElement; node && node !== document.documentElement; node = node.parentElement) {
          const clip = getComputedStyle(node);
          const edge = node.getBoundingClientRect();
          if (clip.overflowX !== 'visible' && (ring.left < edge.left - 0.5 || ring.right > edge.right + 0.5)) { clippedBy = node.className || node.tagName; break; }
          if (clip.overflowY !== 'visible' && (ring.top < edge.top - 0.5 || ring.bottom > edge.bottom + 0.5)) { clippedBy = node.className || node.tagName; break; }
        }
        return {
          clippedBy,
          label: (element.getAttribute('aria-label') || element.textContent || element.id || element.tagName).trim().slice(0, 40),
          drawn: style.outlineStyle !== 'none' && width > 0,
          value: colour ? ratio(colour, behind) : 0,
          colours: `${colour ? show(colour) : style.outlineColor} on ${show(behind)}`,
        };
      });
      if (ring === null) break;
      rings.push(ring);
    }
    for (const ring of rings) {
      check(ring.drawn, `SITE-07: ${theme}: the focused "${ring.label}" shows no focus ring.`);
      check(!ring.drawn || ring.value >= 3, `SITE-07: ${theme}: the focus ring on "${ring.label}" is ${ring.value.toFixed(2)}:1 against what is behind it, under 3:1 (${ring.colours}).`);
      check(ring.clippedBy === null, `SITE-07: ${theme}: the focus ring on "${ring.label}" is cut off by its ancestor .${ring.clippedBy}.`);
    }
  }

  // ---- The page without script (SITE-14) ----
  await page.route('**/*', async route => {
    if (route.request().resourceType() !== 'document') return route.continue();
    const response = await route.fetch();
    const body = (await response.text()).replace(/<script\b[\s\S]*?<\/script>/gi, '');
    return route.fulfill({ response, body });
  });
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const path of ['/how-it-works/', '/']) {
      await open(path, 1280);
      const noScript = await page.evaluate(() => ({
        stamped: document.documentElement.hasAttribute('data-theme'),
        canvas: getComputedStyle(document.body).backgroundColor,
        figures: [...document.querySelectorAll('figure.shot')].map(figure =>
          [...figure.querySelectorAll('img')].filter(img => getComputedStyle(img).display !== 'none').map(img => img.className)),
      }));
      const expectedCanvas = scheme === 'dark' ? 'rgb(18, 22, 52)' : 'rgb(237, 239, 251)';
      check(!noScript.stamped, `SITE-14: the no-script probe still ran the theme script on ${path}.`);
      check(noScript.canvas === expectedCanvas,
        `SITE-14: without script and with a ${scheme} device preference, ${path} paints ${noScript.canvas}, not the ${scheme} canvas ${expectedCanvas}.`);
      noScript.figures.forEach((visible, index) => check(visible.length === 1 && visible[0].includes(`shot-${scheme}`),
        `SITE-14: without script, screenshot ${index + 1} on ${path} shows ${visible.length} image(s) (${visible.join(' + ') || 'none'}) instead of the ${scheme} one alone.`));
    }
  }
  await page.unroute('**/*');
  await page.emulateMedia({ colorScheme: 'light' });

  // ---- The home page's first download and its motion (SITE-11, SITE-10) ----
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  // A streamed or aborted request never reaches loadingFinished, so a video fetched
  // in part counts by the bytes that arrived for it. A finished request counts its
  // transferred size; dataReceived reports a compressed response's encoded length as 0.
  const urls = new Map();
  const received = new Map();
  const finished = new Map();
  cdp.on('Network.requestWillBeSent', event => urls.set(event.requestId, event.request.url));
  cdp.on('Network.dataReceived', event => received.set(event.requestId, (received.get(event.requestId) ?? 0) + (event.encodedDataLength || event.dataLength)));
  cdp.on('Network.loadingFinished', event => finished.set(event.requestId, event.encodedDataLength));
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${SITE}/`);
  await page.waitForTimeout(4000);
  const transfer = { bytes: 0, videoBytes: 0 };
  for (const id of new Set([...received.keys(), ...finished.keys()])) {
    const size = finished.has(id) ? finished.get(id) : received.get(id) ?? 0;
    transfer.bytes += size;
    if ((urls.get(id) ?? '').split('?')[0].endsWith('.mp4')) transfer.videoBytes += size;
  }
  measurements.push({ homeTransferAt375: transfer });
  check(transfer.videoBytes < 300000,
    `SITE-11: the home page fetched ${transfer.videoBytes} bytes of the brand video on load, though it sits far below the first screen.`);
  check(transfer.bytes < 600000, `SITE-11: the home page's first load at 375px transferred ${transfer.bytes} bytes, over the 600 KB budget.`);
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: false });

  await page.evaluate(() => document.querySelector('.brand-video').scrollIntoView({ block: 'center' }));
  await page.waitForFunction(() => !document.querySelector('.brand-video video').paused, null, { timeout: 5000 }).catch(() => {});
  const toggle = page.locator('.brand-video button');
  const toggleCount = await toggle.count();
  check(toggleCount === 1 && await toggle.first().isVisible(), 'SITE-10: the looping brand video has no visible pause control.');
  if (toggleCount === 1) {
    const name = await toggle.first().getAttribute('aria-label') ?? await toggle.first().textContent();
    check(/pause/i.test(name ?? ''), `SITE-10: the brand video's control does not offer to pause it while it plays (it says "${name}").`);
    await toggle.first().click();
    check(await page.evaluate(() => document.querySelector('.brand-video video').paused), 'SITE-10: pressing the brand video\'s control did not pause it.');
  }
  await page.mouse.move(1, 1);
  await open('/', 1280);
  await page.waitForTimeout(1500);
  const endless = await page.evaluate(() => document.getAnimations()
    .filter(animation => animation.playState === 'running' && animation.effect?.getComputedTiming().iterations === Infinity)
    .map(animation => animation.animationName ?? 'an animation'));
  check(endless.length === 0, `SITE-10: the home page runs animation that never stops, with no control to stop it: ${endless.join(', ')}.`);
  const mark = page.locator('.hero-mark .brand-mark');
  await mark.hover();
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    window.__markOpacity = 1;
    const element = document.querySelector('.hero-mark .brand-mark');
    const started = performance.now();
    const sample = () => {
      window.__markOpacity = Math.min(window.__markOpacity, Number(getComputedStyle(element).opacity));
      if (performance.now() - started < 600) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.mouse.move(1, 1);
  await page.waitForTimeout(700);
  const markOpacity = await page.evaluate(() => window.__markOpacity);
  check(markOpacity >= 0.99, `SITE-10: leaving the hero mark replays its entrance, fading it to opacity ${markOpacity.toFixed(2)}.`);

  if (failures.length > 0) throw new Error(`${failures.length} site check(s) failed:\n${failures.join('\n')}`);
  return JSON.stringify({ complete: true, measurements });
}
