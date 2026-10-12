async page => {
  // The Workbench's shell, Use screens and Agent page against the browser preview host (W-206).
  // Each check measures one finding of the broad review of 2026-10-10 (FIXES.md) by what a person
  // would meet: where focus is, what is open, what is on screen. The Vite dev server serves the
  // page, so a probe can import the shell's own module (the same instance the page runs) for the
  // redraw hold. A failure names the checks that passed before it.
  const checks = [];
  const failures = [];
  const errors = [];
  try { return await (async () => {
  const assert = (ok, message) => { if (!ok) throw Error(message); };
  page.on('pageerror', error => errors.push(error.message));
  const base = '__WORKBENCH_URL__';
  const open = async (fixture, width = 1440, height = 900) => {
    await page.setViewportSize({ width, height });
    await page.goto(`${base}?preview=${fixture}`);
    await page.waitForFunction(() => document.querySelector('#studio-content')?.getAttribute('aria-busy') === 'false'
      && document.querySelector('.record-row > button, .record-card, [data-record-id]') !== null, null, { timeout: 15000 });
  };
  const until = async (fn, arg, what, timeout = 4000) => {
    try { await page.waitForFunction(fn, arg, { timeout }); } catch { throw Error(`Timed out waiting for ${what}.`); }
  };
  const focus = () => page.evaluate(() => {
    const element = document.activeElement;
    if (element === null || element === document.body) return 'body';
    return element.tagName.toLowerCase() + (element.id ? `#${element.id}` : '') + (element.className && typeof element.className === 'string' ? `.${element.className.trim().split(/\s+/).join('.')}` : '');
  });
  const shell = (expression) => page.evaluate(expression);
  const quiet = () => page.waitForTimeout(900); // past the shell's 750 ms quiet window
  const openRecord = async () => {
    await page.click('.record-row > button');
    await until(() => document.querySelector('.record-inspector') !== null, null, 'the record inspector');
  };

  // The Agent page, and a scripted agent launched from it (the preview host plays the agent).
  const listen = () => page.evaluate(() => {
    window.__said = [];
    new MutationObserver(() => { const text = document.getElementById('announcement').textContent; if (text) window.__said.push(text); })
      .observe(document.getElementById('announcement'), { childList: true, characterData: true, subtree: true });
  });
  const said = () => page.evaluate(() => window.__said.slice());
  const agentPage = async (tab = 'activity') => {
    await until(() => document.querySelector('#nav-agent')?.disabled === false, null, 'the Agent route');
    await page.click('#nav-agent');
    await until(() => document.querySelector('[data-agent-mode]') !== null, null, 'the Agent page');
    await page.click(`[data-agent-tab="${tab}"]`);
    await listen();
  };
  const launch = async () => {
    await agentPage('activity');
    await page.click('[data-agent-mode="shapeApp"]');
    await until(() => document.querySelector('[data-agent-mode="shapeApp"]')?.getAttribute('aria-pressed') === 'true', null, 'Shape app');
    await page.click('[data-agent-tab="launch"]');
    await page.click('[data-launch-agent="copilot"]');
    await until(() => document.querySelector('#chat-state-label')?.textContent === 'Ready', null, 'the agent to be ready', 8000);
    await listen();
  };

  // Each check starts from a fresh page and runs whether or not the one before it passed.
  const check = async (name, fixture, body, width, height) => {
    try { await open(fixture, width, height); await body(); checks.push(name); } catch (error) { failures.push(`${name}: ${error?.message ?? error}`); }
  };

  // UIS-21: a button's glyph is not part of its name in Ctrl K.
  await check('UIS-21 palette label', 'decision', async () => {
  await page.keyboard.press('Control+k');
  await until(() => document.querySelector('#command-palette')?.open === true, null, 'the palette');
  const addLabel = await page.evaluate(() => [...document.querySelectorAll('#command-palette-list li')].map(item => item.textContent.trim()).find(text => /Add Decision/.test(text)) ?? null);
  assert(addLabel !== null && !addLabel.includes('+Add'), `UIS-21: Ctrl K lists the Add command as ${JSON.stringify(addLabel)}.`);
  await page.keyboard.press('Escape');
  await until(() => document.querySelector('#command-palette')?.open !== true, null, 'the palette to close');
  });

  // UIS-04: Escape in the Filter menu or the View picker closes that menu and leaves the open record alone.
  await check('UIS-04 Escape stays in its menu', 'decision', async () => {
  await openRecord();
  await page.click('[data-testid="quick-filter"] > summary');
  await until(() => document.querySelector('[data-testid="quick-filter"]')?.open === true, null, 'the Filter menu');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  let after = await page.evaluate(() => ({ filter: document.querySelector('[data-testid="quick-filter"]')?.open ?? null, inspector: document.querySelector('.record-inspector') !== null }));
  assert(after.filter === false && after.inspector, `UIS-04: Escape in the Filter menu left ${JSON.stringify(after)}; the menu should close and the record stay open.`);
  await page.click('#place-pickers details.surface-picker > summary');
  await until(() => document.querySelector('#place-pickers details.surface-picker')?.open === true, null, 'the View picker');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  after = await page.evaluate(() => ({ picker: document.querySelector('#place-pickers details.surface-picker')?.open ?? null, inspector: document.querySelector('.record-inspector') !== null }));
  assert(after.picker === false && after.inspector, `UIS-04: Escape in the View picker left ${JSON.stringify(after)}; the picker should close and the record stay open.`);
  });

  // UIS-03: an open breadcrumb picker holds the automatic redraws, as a menu in the page does.
  await check('UIS-03 breadcrumb picker holds redraws', 'decision', async () => {
  await page.click('#place-pickers details.surface-picker > summary');
  await until(() => document.querySelector('#place-pickers details.surface-picker')?.open === true, null, 'the View picker');
  await quiet();
  const held = await shell(() => import('/src/draft-guard.ts').then(module => module.holdingThePage()));
  assert(held === true, 'UIS-03: the page is not held while the View picker is open, so an automatic redraw closes it under the pointer.');
  await page.keyboard.press('Escape');
  // Focus left on the record-type list after a pick is not a hand on the page: holding for it kept
  // every read waiting for as long as the list kept focus.
  const typeList = await page.evaluate(() => { const select = document.querySelector('#place-pickers select'); select?.focus(); return select !== null; });
  if (typeList) {
    await quiet();
    const heldByFocus = await shell(() => import('/src/draft-guard.ts').then(module => module.holdingThePage()));
    assert(heldByFocus === false, 'UIS-03: focus resting on the record-type list holds every automatic read.');
  }
  });

  // UIS-15: Alt+F with the navigation folded opens a File menu that is there.
  await check('UIS-15 Alt+F with the rail folded', 'decision', async () => {
  await page.click('#rail-toggle');
  await until(() => document.documentElement.dataset.rail === 'collapsed', null, 'the folded rail');
  await page.keyboard.press('Alt+f');
  await page.waitForTimeout(300);
  const file = await page.evaluate(() => {
    const element = document.activeElement;
    const box = element?.getBoundingClientRect();
    return { inMenu: element?.closest('#file-actions') != null, visible: box !== undefined && box.width > 0 && box.height > 0, name: element?.textContent?.trim() ?? null };
  });
  assert(file.inMenu && file.visible, `UIS-15: Alt+F with the rail folded left focus on ${JSON.stringify(file)}.`);
  await page.keyboard.press('Escape');
  // Alt+F unfolded the rail and kept that, so the next page starts unfolded as before.
  });

  // UIK-07: an arrow key in a Filter select looks; Enter applies, and focus comes back to Filter.
  await check('UIK-07 Filter keys', 'idea', async () => {
    await page.click('[data-testid="quick-filter"] > summary');
    await until(() => document.querySelector('[data-quick-filter]') !== null, null, 'a Filter select');
    await page.focus('[data-quick-filter]');
    const before = await page.evaluate(() => document.querySelector('[data-quick-filter]').value);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(600);
    const looked = await page.evaluate(() => ({ open: document.querySelector('[data-testid="quick-filter"]')?.open ?? null,
      focused: document.activeElement?.matches?.('[data-quick-filter]') ?? false, value: document.activeElement?.value ?? null }));
    assert(looked.open === true && looked.focused, `UIK-07: one ArrowDown in a Filter select left ${JSON.stringify(looked)}; the menu should stay open with focus on the select.`);
    assert(looked.value !== before, 'UIK-07: ArrowDown did not move the select; the check measures nothing.');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
    const backedOut = await page.evaluate(() => ({ pill: document.querySelector('[data-quick-filter-clear]') !== null, open: document.querySelector('[data-testid="quick-filter"]')?.open ?? null }));
    assert(!backedOut.pill && backedOut.open === false, `UIK-07: Escape after looking with ArrowDown left ${JSON.stringify(backedOut)}; nothing should be applied.`);
    await page.click('[data-testid="quick-filter"] > summary');
    await until(() => document.querySelector('[data-quick-filter]') !== null, null, 'a Filter select again');
    await page.focus('[data-quick-filter]');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await until(() => document.querySelector('[data-testid="quick-filter"]')?.open === false, null, 'the Filter menu to close after Enter');
    await until(() => document.activeElement?.matches?.('[data-testid="quick-filter"] > summary') === true, null, 'focus back on Filter', 4000);
  });

  // UIK-04 and UIS-11: a record opened from the keyboard takes focus to its named inspector; it is
  // marked in the list; Escape hands focus back to its row.
  await check('UIK-04 UIS-11 record focus and mark', 'decision', async () => {
    const id = await page.evaluate(() => document.querySelector('.record-row > button').dataset.recordId);
    const title = await page.evaluate(() => document.querySelector('.record-row > button strong').textContent.trim());
    await page.focus('.record-row > button');
    await page.keyboard.press('Enter');
    await until(() => document.querySelector('.record-inspector') !== null, null, 'the record inspector');
    await page.waitForTimeout(200);
    const opened = await page.evaluate(id => {
      const row = document.querySelector(`.record-row > button[data-record-id="${CSS.escape(id)}"]`);
      return { focus: document.activeElement?.id ?? null, heading: document.querySelector('#inspector-heading')?.textContent ?? '',
        current: row?.getAttribute('aria-current') ?? null, fill: row === null ? null : getComputedStyle(row).backgroundColor };
    }, id);
    const problems = [];
    if (opened.focus !== 'inspector-heading') problems.push(`UIK-04: opening a record left focus on ${opened.focus || 'body'}.`);
    if (!opened.heading.includes(title)) problems.push(`UIS-11: the inspector is headed ${JSON.stringify(opened.heading)}, not by its record ${JSON.stringify(title)}.`);
    if (opened.current !== 'true' || opened.fill === 'rgba(0, 0, 0, 0)') problems.push(`UIS-11: the open record's row is not marked: ${JSON.stringify({ current: opened.current, fill: opened.fill })}.`);
    assert(problems.length === 0, problems.join(' '));
    await page.waitForTimeout(2500);
    // A chase that lands (related rows, a tile) redraws the screen; the inspector keeps the keyboard.
    await shell(() => import('/src/shell.ts').then(module => module.rerender()));
    await page.waitForTimeout(100);
    const later = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName || null);
    assert(later === 'inspector-heading', `UIK-04: after a redraw of the open record's screen, focus is on ${later}.`);
    await page.keyboard.press('Escape');
    await until(() => document.querySelector('.record-inspector') === null, null, 'the inspector to close');
    const back = await page.evaluate(() => document.activeElement?.dataset?.recordId ?? null);
    assert(back === id, `UIK-04: Escape from the inspector left focus on ${back ?? 'body'}, not on the record's row.`);
  });

  // UIS-05: no control Tab reaches in the inspector sits under its sticky header or Save bar.
  await check('UIS-05 focus not obscured', 'decision', async () => {
    await openRecord();
    await page.focus('#close-inspector');
    const hidden = [];
    for (let step = 0; step < 40; step++) {
      await page.keyboard.press('Tab');
      const measure = await page.evaluate(() => {
        const element = document.activeElement;
        const inspector = document.querySelector('.record-inspector');
        if (element === null || inspector === null || !inspector.contains(element)) return { inside: false };
        if (element.closest('.form-actions, .record-inspector > header')) return { inside: true, covered: 0 };
        const box = element.getBoundingClientRect();
        const bar = inspector.querySelector('.form-actions')?.getBoundingClientRect();
        const head = inspector.querySelector(':scope > header')?.getBoundingClientRect();
        const under = (cover) => cover === undefined ? 0 : Math.max(0, Math.min(box.bottom, cover.bottom) - Math.max(box.top, cover.top));
        return { inside: true, name: element.getAttribute('name') ?? element.textContent?.trim().slice(0, 30), covered: Math.max(under(bar), under(head)), height: box.height };
      });
      if (!measure.inside) break;
      if (measure.covered > 1) hidden.push(`${measure.name} ${Math.round(measure.covered)}/${Math.round(measure.height)}px`);
    }
    assert(hidden.length === 0, `UIS-05: focus moved to controls under the sticky header or Save bar: ${hidden.join(', ')}.`);
  }, 1024, 768);

  // UIS-10: a stored value reads at the body size, not at its label's.
  await check('UIS-10 value size', 'decision', async () => {
    await openRecord();
    const style = await page.evaluate(() => { const input = document.querySelector('.record-form label input[type="text"], .record-form label select');
      const computed = getComputedStyle(input); return { size: computed.fontSize, weight: computed.fontWeight }; });
    assert(style.size === '14px' && style.weight === '400', `UIS-10: a record value is drawn at ${style.size}, weight ${style.weight}.`);
  });

  // UIS-12: each optional field's Not set and each reference's Choose names its field.
  await check('UIS-12 controls named by field', 'decision', async () => {
    await openRecord();
    const names = await page.evaluate(() => ({
      unset: [...document.querySelectorAll('.record-inspector [data-null-field]')].map(input => input.getAttribute('aria-label') ?? input.closest('label')?.textContent?.trim() ?? ''),
      choose: [...document.querySelectorAll('.record-inspector .reference-choose')].map(button => button.getAttribute('aria-label') ?? button.textContent.trim()),
    }));
    const all = [...names.unset, ...names.choose];
    assert(all.length > 0, 'UIS-12: the record has no optional field or reference; the check measures nothing.');
    assert(new Set(all).size === all.length && !all.includes('Not set') && !all.includes('Choose record'), `UIS-12: controls share a name without their field: ${JSON.stringify(names)}.`);
  });

  // UIS-14: the formatted text above a Markdown field follows its source as it is typed.
  await check('UIS-14 live Markdown', 'decision', async () => {
    await openRecord();
    const has = await page.evaluate(() => document.querySelector('.record-inspector .markdown-field details.markdown-source') !== null);
    assert(has, 'UIS-14: the record has no Markdown field; the check measures nothing.');
    await page.evaluate(() => { document.querySelector('.record-inspector .markdown-field details.markdown-source').open = true; });
    await page.focus('.record-inspector .markdown-field textarea');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('## Reasons for the change');
    await page.waitForTimeout(500);
    const shown = await page.evaluate(() => document.querySelector('.record-inspector .markdown-field .markdown-body')?.textContent?.trim() ?? null);
    assert(shown !== null && shown.includes('Reasons for the change'), `UIS-14: the formatted text shows ${JSON.stringify(shown)} while its source says "## Reasons for the change".`);
  });

  // UIS-20: the view's name in the breadcrumb says itself in full when it is cut.
  await check('UIS-20 view name title', 'decision', async () => {
    const name = await page.evaluate(() => { const strong = document.querySelector('#place-pickers .surface-picker summary strong'); return { text: strong?.textContent ?? null, title: strong?.title ?? null }; });
    assert(name.text !== null && name.title === name.text, `UIS-20: the View picker's name carries no title: ${JSON.stringify(name)}.`);
  });

  // UIS-01: past the tabs' narrowest, the tab on screen and New tab stay inside the window.
  await check('UIS-01 tab strip overflow', 'decision', async () => {
    for (let index = 0; index < 11; index++) {
      await page.click('#tab-new');
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(300);
    const strip = await page.evaluate(() => {
      const active = document.querySelector('#tab-strip .tab.is-active')?.getBoundingClientRect();
      const plus = document.querySelector('#tab-new')?.getBoundingClientRect();
      const room = document.querySelector('#tab-strip .tab-list')?.getBoundingClientRect() ?? document.querySelector('#tab-strip').getBoundingClientRect();
      return { tabs: document.querySelectorAll('#tab-strip .tab').length, width: innerWidth, room: [Math.round(room.left), Math.round(room.right)],
        active: active && [Math.round(active.left), Math.round(active.right)], plus: plus && [Math.round(plus.left), Math.round(plus.right)] };
    });
    assert(strip.tabs >= 12, `UIS-01: only ${strip.tabs} tabs opened; the check measures nothing.`);
    assert(strip.active && strip.active[0] >= strip.room[0] - 1 && strip.active[1] <= Math.min(strip.room[1], strip.width) + 1 && strip.plus && strip.plus[1] <= strip.width,
      `UIS-01: with ${strip.tabs} tabs at ${strip.width}px the active tab is at ${JSON.stringify(strip.active)} and New tab at ${JSON.stringify(strip.plus)}.`);
  }, 1024, 768);

  // UIK-11: the tab list holds only tabs, and one of them is the Tab stop.
  await check('UIK-11 tab list holds only tabs', 'decision', async () => {
    await page.click('#tab-new');
    await page.waitForTimeout(200);
    const roles = await page.evaluate(() => {
      const list = document.querySelector('#tab-strip [role="tablist"]');
      if (list === null) return { list: false };
      const focusable = [...list.querySelectorAll('button, [tabindex]')].filter(element => element.tabIndex >= 0);
      const exposed = [...list.querySelectorAll('button')].filter(button => button.getAttribute('role') !== 'tab' && button.getAttribute('aria-hidden') !== 'true');
      return { list: true, stops: focusable.map(element => element.getAttribute('role') ?? element.id ?? element.className), exposed: exposed.map(button => button.id || button.className),
        newTabInside: list.querySelector('#tab-new') !== null };
    });
    assert(roles.list && !roles.newTabInside && roles.exposed.length === 0 && roles.stops.length === 1 && roles.stops[0] === 'tab',
      `UIK-11: the tab list exposes ${JSON.stringify(roles)}; it should hold only tabs, one of them a Tab stop.`);
  });

  // UIS-02: in a narrow window the File menu opens whole, not clipped to the top bar.
  await check('UIS-02 narrow File menu', 'decision', async () => {
    await page.click('#file-menu > summary');
    await page.waitForTimeout(300);
    const panel = await page.evaluate(() => {
      const box = document.querySelector('#file-actions')?.closest('.file-menu-panel')?.getBoundingClientRect() ?? document.querySelector('#file-actions')?.getBoundingClientRect();
      if (!box) return null;
      const probe = document.elementFromPoint(box.left + box.width / 2, Math.min(box.top + 120, box.bottom - 4));
      return { height: Math.round(box.height), hit: probe !== null && probe.closest('#file-menu') !== null };
    });
    assert(panel !== null && panel.height > 200 && panel.hit, `UIS-02: at 800px the File menu shows ${JSON.stringify(panel)}; it should open whole and take the pointer.`);
  }, 800, 700);

  // UIK-08: in a narrow window, where no tab is on screen, Ctrl W closes nothing.
  await check('UIK-08 narrow tab keys', 'decision', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.click('#tab-new');
    await page.waitForTimeout(200);
    await page.setViewportSize({ width: 800, height: 700 });
    await page.waitForTimeout(200);
    const before = await page.evaluate(() => document.querySelectorAll('#tab-strip .tab').length);
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', ctrlKey: true, bubbles: true, cancelable: true })));
    await page.waitForTimeout(300);
    const after = await page.evaluate(() => document.querySelectorAll('#tab-strip .tab').length);
    assert(before === 2 && after === before, `UIK-08: with the tabs hidden, Ctrl W took the tabs from ${before} to ${after}.`);
  }, 1440, 900);

  // UIK-14: Tab leaves the Data grid instead of walking every cell.
  await check('UIK-14 grid Tab leaves', 'decision', async () => {
    await page.click('#nav-data');
    await until(() => document.querySelector('.ag-cell') !== null, null, 'the Data grid', 8000);
    // A real press, so the grid itself holds the focused cell.
    await page.locator('.ag-row .ag-cell:not(.record-open-cell)').first().click();
    await page.waitForTimeout(150);
    const inGrid = await page.evaluate(() => document.activeElement?.closest('.ag-root-wrapper') !== null);
    assert(inGrid, 'UIK-14: the click did not focus a grid cell; the check measures nothing.');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(150);
    const left = await page.evaluate(() => document.activeElement?.closest('.ag-root-wrapper') === null);
    assert(left, 'UIK-14: one Tab from a grid cell stayed in the grid.');
  });

  // UIK-01: an unchanged status is not drawn again; a selection and an open dialog are left alone.
  await check('UIK-01 Agent page poll', 'idea', async () => {
    await agentPage('connect');
    await page.evaluate(() => {
      window.__rebuilds = 0;
      new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) if (node.classList?.contains('agent-page')) window.__rebuilds++; })
        .observe(document.getElementById('studio-content'), { childList: true });
      const code = document.getElementById('agent-endpoint');
      const range = document.createRange(); range.selectNodeContents(code);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      window.__selected = selection.toString();
    });
    await page.waitForTimeout(7000);
    const after = await page.evaluate(() => ({ rebuilds: window.__rebuilds, kept: getSelection().toString() === window.__selected && window.__selected !== '' }));
    const problems = [];
    if (after.rebuilds !== 0) problems.push(`the page was rebuilt ${after.rebuilds} times in 7 s with nothing changed`);
    if (!after.kept) problems.push('the selected address was lost');
    await page.evaluate(() => getSelection().removeAllRanges());
    await page.click('[data-agent-tab="activity"]');
    await page.click('[data-agent-mode="unattended"]');
    await until(() => document.querySelector('dialog[open]') !== null, null, 'the Unattended dialog');
    await page.waitForTimeout(4000);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const focus = await page.evaluate(() => document.activeElement?.dataset?.agentMode ?? document.activeElement?.tagName ?? null);
    if (focus !== 'unattended') problems.push(`cancelling the Unattended dialog after 4 s left focus on ${focus}`);
    assert(problems.length === 0, `UIK-01: ${problems.join('; ')}.`);
  });

  // UIK-02: a copy that failed keeps the command to run by hand.
  await check('UIK-02 failed copy stays', 'idea', async () => {
    await agentPage('launch');
    await page.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new Error('refused')); });
    await page.locator('[data-copy-agent]').first().click();
    await until(() => document.querySelector('.copy-hint.is-failed code') !== null, null, 'the failed copy hint');
    await page.waitForTimeout(9000);
    const kept = await page.evaluate(() => document.querySelector('.copy-hint.is-failed code')?.textContent ?? null);
    assert(kept !== null && kept !== '', 'UIK-02: the command shown after a failed copy was gone 9 s later.');
  });

  // UIK-04, the review: it takes focus; Escape hands focus back to Review changes; Accept to the outcome.
  await check('UIK-04 agent proposal review focus', 'idea', async () => {
    await agentPage('activity');
    await until(() => document.querySelector('[data-review-agent-proposal]') !== null, null, 'a waiting proposal');
    const id = await page.evaluate(() => document.querySelector('[data-review-agent-proposal]').dataset.reviewAgentProposal);
    await page.focus('[data-review-agent-proposal]');
    await page.keyboard.press('Enter');
    await until(() => document.querySelector('.agent-proposal-page') !== null, null, 'the review');
    await page.waitForTimeout(200);
    const problems = [];
    if (!(await page.evaluate(() => document.activeElement?.closest('.agent-proposal-page') != null))) problems.push('opening the review left focus outside it');
    await page.keyboard.press('Escape');
    await until(() => document.querySelector('.agent-proposal-page') === null, null, 'the Agent page again');
    const back = await page.evaluate(() => document.activeElement?.dataset?.reviewAgentProposal ?? document.activeElement?.tagName ?? null);
    if (back !== id) problems.push(`Escape from the review left focus on ${back}`);
    assert(problems.length === 0, `UIK-04: ${problems.join('; ')}.`);
  });

  // UIK-03, UIK-12, UIK-05, UIK-10: the conversation keeps the keyboard and the log holds still.
  await check('UIK-03 UIK-05 UIK-10 UIK-12 conversation keys', 'idea', async () => {
    await launch();
    const problems = [];
    const active = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName || null);
    if (await active() !== 'agent-prompt') problems.push(`UIK-03: after Launch focus is on ${await active()}`);
    const box = await page.evaluate(() => { const box = document.getElementById('agent-prompt'); return { popup: box.getAttribute('aria-haspopup'), expanded: box.getAttribute('aria-expanded') }; });
    if (box.popup !== 'listbox' || box.expanded !== null) problems.push(`UIK-10: the message box says ${JSON.stringify(box)}`);
    await page.locator('#agent-prompt').fill('@');
    await until(() => document.querySelector('#chat-mention:not([hidden]) [data-choice]') !== null, null, 'the @ menu');
    await page.waitForTimeout(200);
    if (!(await said()).some(line => /choices?;/.test(line))) problems.push('UIK-10: opening the @ list was not said');
    await page.locator('#agent-prompt').fill('');
    await page.locator('#agent-prompt').press('Escape');
    await page.evaluate(() => {
      window.__agentAdds = 0; window.__emptyAdds = 0;
      new MutationObserver(records => { for (const record of records) for (const node of record.addedNodes) {
        if (node.classList?.contains('chat-agent')) window.__agentAdds++;
        if (node.classList?.contains('chat-empty')) window.__emptyAdds++;
      } }).observe(document.getElementById('chat-thread'), { childList: true, subtree: true });
    });
    await page.focus('#chat-options select');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(600);
    const emptyAdds = await page.evaluate(() => window.__emptyAdds);
    if (emptyAdds > 0) problems.push(`UIK-05: changing an option wrote the empty conversation into the log again ${emptyAdds} times`);
    await page.locator('#agent-prompt').fill('Add a record type for requests');
    await page.focus('#send-prompt');
    await page.keyboard.press('Enter');
    await until(() => document.getElementById('stop-agent')?.hidden === false, null, 'the agent to work');
    await page.waitForTimeout(100);
    const afterSend = await active();
    if (afterSend !== 'stop-agent' && afterSend !== 'agent-prompt') problems.push(`UIK-03: after Send focus is on ${afterSend}`);
    await page.locator('#agent-prompt').fill('and some authors');
    await page.locator('#agent-prompt').press('Enter');
    await page.waitForTimeout(200);
    if (!(await said()).some(line => line.includes('is working'))) problems.push('UIK-12: Enter while the agent works said nothing');
    await page.locator('#agent-prompt').fill('');
    await until(() => document.querySelector('[data-answer-entry][data-option-id="allow"]') !== null, null, 'the permission request', 8000);
    await page.focus('[data-answer-entry][data-option-id="allow"]');
    await page.keyboard.press('Enter');
    await until(() => document.querySelector('#chat-state-label')?.textContent === 'Ready' && document.querySelector('.chat-agent') !== null, null, 'the reply', 8000);
    await page.waitForTimeout(200);
    const afterAnswer = await active();
    if (afterAnswer !== 'agent-prompt') problems.push(`UIK-03: after answering Allow focus is on ${afterAnswer}`);
    const adds = await page.evaluate(() => window.__agentAdds);
    if (adds > 1) problems.push(`UIK-05: the streamed reply was added to the log ${adds} times`);
    assert(problems.length === 0, problems.join('; ') + '.');
  });

  // UIK-06 and UIK-09: an arrow key in an option looks and keeps More open; the focused option says so.
  await check('UIK-06 UIK-09 agent options', 'idea', async () => {
    await launch();
    const problems = [];
    await page.focus('#agent-prompt');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const ring = await page.evaluate(() => { const element = document.activeElement; if (!(element instanceof HTMLSelectElement)) return null;
      const style = getComputedStyle(element); return { style: style.outlineStyle, width: style.outlineWidth }; });
    if (ring === null || ring.style !== 'solid' || parseFloat(ring.width) < 2) problems.push(`UIK-09: a focused composer option shows ${JSON.stringify(ring)}`);
    await page.click('.chat-more summary');
    await until(() => document.querySelector('details.chat-more')?.open === true, null, 'More');
    await page.focus('.chat-more-panel select');
    const valueBefore = await page.evaluate(() => document.activeElement.value);
    const before = (await said()).length;
    await page.keyboard.press(await page.evaluate(() => document.activeElement.selectedIndex === 0 ? 'ArrowDown' : 'ArrowUp'));
    await page.waitForTimeout(400);
    const moved = await page.evaluate(before => document.activeElement?.value !== before, valueBefore);
    if (!moved) problems.push('UIK-06: the arrow key did not move the option; the check measures nothing');
    const looked = await page.evaluate(() => ({ open: document.querySelector('details.chat-more')?.open ?? null, focused: document.activeElement?.matches?.('.chat-more-panel select') ?? false }));
    const spoke = (await said()).slice(before);
    if (!looked.open || !looked.focused || spoke.length > 0) problems.push(`UIK-06: one ArrowUp in More left ${JSON.stringify(looked)} and said ${JSON.stringify(spoke)}`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    const afterEscape = (await said()).slice(before);
    const valueAfter = await page.evaluate(() => document.querySelector('.chat-more-panel select')?.value ?? null);
    if (afterEscape.length > 0 || valueAfter !== valueBefore) problems.push(`UIK-06: Escape after looking chose the option: said ${JSON.stringify(afterEscape)}, value ${valueAfter}`);
    assert(problems.length === 0, problems.join('; ') + '.');
  });

  // UIK-15: focus on Open conversation comes back to the copy on screen after a redraw.
  await check('UIK-15 Open conversation focus', 'idea', async () => {
    await launch();
    await agentPage('launch');
    await page.focus('#agent-panel-launch [data-open-agent-chat]');
    await shell(() => import('/src/shell.ts').then(module => module.rerender()));
    await page.waitForTimeout(200);
    const focus = await page.evaluate(() => ({ open: document.activeElement?.dataset?.openAgentChat !== undefined, visible: document.activeElement?.closest('.agent-panel:not([hidden])') != null }));
    assert(focus.open && focus.visible, `UIK-15: after a redraw focus was ${JSON.stringify(focus)}, not the Launch tile's Open conversation.`);
  });

  return { complete: failures.length === 0, checks, errors, failure: failures.join(' || ') };
  })(); } catch (error) {
    return { complete: false, checks, errors, failure: [...failures, String(error?.message ?? error)].join(' || ') };
  }
}
