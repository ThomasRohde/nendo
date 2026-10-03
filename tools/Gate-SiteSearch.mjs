async (page) => {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const measurements = [];
  for (const theme of ['light', 'dark']) {
    for (const width of [1280, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('__SITE_URL__/nendo/docs/getting-started');
      await page.evaluate(choice => localStorage.setItem('nendo.appearance', choice), theme);
      await page.reload();
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
      assert(result.theme === theme, `Site theme did not become ${theme}.`);
      assert(result.panelRight <= result.railRight + 1 && result.panelLeft >= 0 && result.panelRight <= width,
        `R02-021: search panel is clipped at ${width}px ${theme}: panel right ${result.panelRight}, rail right ${result.railRight}.`);
      assert(result.linkHit, `R02-021: search result right edge is not clickable at ${width}px ${theme}; hit ${result.hit}.`);
      assert(result.scrollWidth <= baselineScrollWidth, `Search introduced horizontal overflow at ${width}px ${theme}.`);
      // Measure the right edge of every result after scrolling it into the panel.
      for (const link of await panel.locator('a').all()) {
        await link.scrollIntoViewIfNeeded();
        const reachable = await link.evaluate(anchor => {
          const box = anchor.getBoundingClientRect();
          const hit = document.elementFromPoint(box.right - 2, box.top + Math.min(box.height / 2, 30));
          return anchor.contains(hit);
        });
        assert(reachable, `A search result is clipped after scrolling at ${width}px ${theme}.`);
      }
      measurements.push(result);
    }
  }
  return JSON.stringify({ complete: true, measurements });
}
