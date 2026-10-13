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

  // W-207. The record's text fields, and a host request from the page's own client.
  const textInputs = () => page.evaluate(() => [...document.querySelectorAll('#record-form label > input[type="text"]')].map(input => input.name));
  const request = (method, payload) => page.evaluate(([method, payload]) => import('/src/client.ts').then(module => module.client.request(method, payload)), [method, payload]);
  const save = () => page.click('#record-form button[type="submit"]');
  const message = () => page.evaluate(() => document.querySelector('.message-slot:not([hidden])')?.textContent?.trim() ?? '');
  const pickView = async (pattern) => {
    await page.click('#place-pickers details.surface-picker > summary');
    const picked = await page.evaluate(pattern => { const button = [...document.querySelectorAll('#place-pickers [data-select-surface]')].find(candidate => new RegExp(pattern, 'i').test(candidate.textContent)); button?.click(); return button !== undefined; }, pattern);
    assert(picked, `no view matches ${pattern}`);
    await page.waitForTimeout(800);
  };

  // WDV-08: a save refused over a newer version keeps the typing on the new version, and the next save writes it.
  await check('WDV-08 save over a newer version', 'decision', async () => {
    await openRecord();
    const id = await page.evaluate(() => document.querySelector('.record-row > button[aria-current="true"], .record-row > button').dataset.recordId);
    const [typed, other] = await textInputs();
    assert(typed && other, 'the record has fewer than two text fields; the check measures nothing');
    await page.fill(`#record-form input[name="${typed}"]`, 'My typing');
    const current = (await request('data.queryRecords', { entityId: 'entity.decision', recordId: id, limit: 1 })).items[0];
    await request('data.setField', { entityId: 'entity.decision', recordId: id, expectedRecordVersion: current.recordVersion, fieldId: other, value: 'Changed underneath', idempotencyKey: `underneath-${Date.now()}` });
    await save();
    await until(() => /changed while you edited/.test(document.querySelector('.message-slot:not([hidden])')?.textContent ?? ''), null, 'the conflict message', 6000);
    const kept = await page.evaluate(name => document.querySelector(`#record-form input[name="${name}"]`)?.value ?? null, typed);
    assert(kept === 'My typing', `WDV-08: after the conflict the field shows ${JSON.stringify(kept)}, not the typing.`);
    await save();
    await page.waitForTimeout(800);
    const stored = (await request('data.queryRecords', { entityId: 'entity.decision', recordId: id, limit: 1 })).items[0].values;
    assert(stored[typed] === 'My typing' && stored[other] === 'Changed underneath', `WDV-08: the second save left ${JSON.stringify({ [typed]: stored[typed], [other]: stored[other] })}; ${await message()}`);
  });

  // WDV-10: a value that does not parse is reported with its field's name.
  await check('WDV-10 parse error names its field', 'tree', async () => {
    await openRecord();
    await page.fill('#record-form input[name="field.capability.order"]', '1,000');
    await save();
    await page.waitForTimeout(400);
    const said = await message();
    assert(/^Order:/.test(said), `WDV-10: an unparseable Order says ${JSON.stringify(said)}.`);
  });

  // WDV-12: typing and taking it back is not a change, so a card still moves.
  await check('WDV-12 board drag after reverted typing', 'idea', async () => {
    await pickView('board');
    const cards = await page.evaluate(() => [...document.querySelectorAll('.board-column .record-card')].length);
    assert(cards >= 2, 'the board has fewer than two cards; the check measures nothing');
    await page.locator('.board-column .record-card').first().click();
    await until(() => document.querySelector('#record-form') !== null, null, 'the record form');
    const [name] = await textInputs();
    const input = page.locator(`#record-form input[name="${name}"]`);
    await input.focus();
    await page.keyboard.press('End');
    await page.keyboard.type('x');
    await page.keyboard.press('Backspace');
    const card = page.locator('.board-column .record-card').nth(1);
    const movedId = await card.getAttribute('data-record-id');
    const movedFrom = await page.evaluate(() => document.querySelectorAll('.board-column .record-card')[1].closest('.board-column').dataset.group);
    const box = await card.boundingBox();
    const target = await page.evaluate(() => { const columns = [...document.querySelectorAll('.board-column')]; const own = document.querySelectorAll('.board-column .record-card')[1].closest('.board-column');
      const other = columns.find(column => column !== own); const box = other.getBoundingClientRect(); return { x: box.left + box.width / 2, y: box.top + 80 }; });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 2 + 5, { steps: 4 });
    await page.mouse.move(target.x, target.y, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const said = await message();
    assert(!/Save or discard your changes before moving a card/.test(said), `WDV-12: a drag after typing taken back was refused: ${said}`);
    const moved = await page.evaluate(id => document.querySelector(`.board-column .record-card[data-record-id="${CSS.escape(id)}"]`)?.closest('.board-column')?.dataset.group ?? null, movedId);
    assert(moved !== null && moved !== movedFrom, `WDV-12: the drag did not move the card (still in ${moved}); the check measures nothing.`);
  });

  // UIS-12, the reference half: the tree fixture has a reference field, Part of.
  await check('UIS-12 reference controls named by field', 'tree', async () => {
    await openRecord();
    const name = await page.evaluate(() => document.querySelector('.record-inspector .reference-choose')?.getAttribute('aria-label') ?? null);
    assert(name !== null && name.includes('Part of'), `UIS-12: the reference's Choose button is named ${JSON.stringify(name)}.`);
  });

  // WDV-08 in Studio's record sheet, which is drawn outside the Use renderer: the typing stays.
  await check('WDV-08 Studio sheet over a newer version', 'decision', async () => {
    await page.click('#nav-data');
    await until(() => document.querySelector('.record-open-button') !== null, null, 'the Data grid', 8000);
    const id = await page.evaluate(() => document.querySelector('.ag-row[row-index="0"]')?.getAttribute('row-id') ?? null);
    await page.locator('.ag-row[row-index="0"] .record-open-button').click({ force: true });
    await until(() => document.querySelector('#record-form') !== null, null, 'the record sheet');
    const recordId = id ?? await page.evaluate(() => document.querySelector('#record-form')?.closest('[data-record-id]')?.dataset.recordId ?? null);
    const [typed, other] = await textInputs();
    assert(typed && other, 'the sheet has fewer than two text fields; the check measures nothing');
    await page.fill(`#record-form input[name="${typed}"]`, 'Typed in the sheet');
    const page1 = await request('data.queryRecords', { entityId: 'entity.decision', limit: 10 });
    const current = page1.items.find(item => item.recordId === recordId) ?? page1.items[0];
    await request('data.setField', { entityId: 'entity.decision', recordId: current.recordId, expectedRecordVersion: current.recordVersion, fieldId: other, value: 'Changed under the sheet', idempotencyKey: `sheet-${Date.now()}` });
    await save();
    await until(() => /changed while you edited/.test(document.querySelector('.message-slot:not([hidden])')?.textContent ?? ''), null, 'the conflict message', 6000);
    const kept = await page.evaluate(name => document.querySelector(`#record-form input[name="${name}"]`)?.value ?? null, typed);
    assert(kept === 'Typed in the sheet', `WDV-08: in Studio's sheet the typing became ${JSON.stringify(kept)} after the conflict.`);
    await save();
    await page.waitForTimeout(800);
    const stored = (await request('data.queryRecords', { entityId: 'entity.decision', recordId: current.recordId, limit: 1 })).items[0].values;
    assert(stored[typed] === 'Typed in the sheet' && stored[other] === 'Changed under the sheet', `WDV-08: the sheet's second save left ${JSON.stringify({ [typed]: stored[typed], [other]: stored[other] })}; ${await message()}`);
  });

  // UX-01: Health is refused while a record holds unsaved typing, by the rail and by Ctrl 6.
  await check('UX-01 Health keeps unsaved typing', 'decision', async () => {
    await openRecord();
    const [name] = await textInputs();
    assert(name, 'the record has no text field; the check measures nothing');
    await page.fill(`#record-form input[name="${name}"]`, 'Unsaved typing');
    await page.click('#nav-health');
    await page.waitForTimeout(500);
    const said = await message();
    const kept = await page.evaluate(name => document.querySelector(`#record-form input[name="${name}"]`)?.value ?? null, name);
    assert(/Save or discard your changes before opening Health/.test(said) && kept === 'Unsaved typing',
      `UX-01: Health from the rail left ${JSON.stringify(kept)} in the field and said ${JSON.stringify(said)}.`);
    await page.locator(`#record-form input[name="${name}"]`).focus();
    await page.keyboard.press('Control+6');
    await page.waitForTimeout(500);
    const after = await page.evaluate(name => document.querySelector(`#record-form input[name="${name}"]`)?.value ?? null, name);
    assert(after === 'Unsaved typing', `UX-01: Ctrl 6 left ${JSON.stringify(after)} in the field.`);
  });

  // UX-12: Escape, or the close button, asks before unsaved typing goes, and Cancel keeps it.
  await check('UX-12 closing asks before discarding', 'decision', async () => {
    await openRecord();
    const [name] = await textInputs();
    const input = page.locator(`#record-form input[name="${name}"]`);
    await input.fill('Two paragraphs of notes');
    await input.focus();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const asked = await page.evaluate(() => document.querySelector('dialog[open] h2')?.textContent ?? null);
    assert(asked === 'Discard your changes?', `UX-12: Escape with unsaved typing ${asked === null ? 'closed the record without asking' : `asked ${JSON.stringify(asked)}`}.`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    const kept = await page.evaluate(name => document.querySelector(`#record-form input[name="${name}"]`)?.value ?? null, name);
    assert(kept === 'Two paragraphs of notes', `UX-12: Cancel did not keep the typing: ${JSON.stringify(kept)}.`);
    await page.click('#close-inspector');
    await until(() => document.querySelector('dialog[open] [data-confirm]') !== null, null, 'the discard question');
    await page.click('dialog[open] [data-confirm]');
    await until(() => document.querySelector('.record-inspector') === null, null, 'the record to close after Discard');
  });

  // UX-02: a cell edit the host refuses shows the stored value again, beside the reason.
  await check('UX-02 refused grid edit', 'tree', async () => {
    await page.click('#nav-data');
    await until(() => document.querySelector('.ag-cell[col-id="field.capability.order"]') !== null, null, 'the Order column', 8000);
    const cell = '.ag-row[row-index="0"] .ag-cell[col-id="field.capability.order"]';
    const before = (await page.locator(cell).textContent()).trim();
    await page.locator(cell).dblclick();
    await page.waitForTimeout(200);
    await page.keyboard.press('Control+A');
    await page.keyboard.type('77');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1200);
    const after = (await page.locator(cell).textContent()).trim();
    const said = await message();
    assert(said !== '', 'UX-02: the host did not refuse the edit; the check measures nothing.');
    assert(after === before, `UX-02: after the refusal (${said}) the cell shows ${JSON.stringify(after)}, not the stored ${JSON.stringify(before)}.`);
  });

  // UX-03 and UX-04: a keyboard save keeps the focus on its cell and the columns where they were,
  // and says it saved where it can be seen.
  await check('UX-03 UX-04 grid save keeps its place', 'idea', async () => {
    await page.click('#nav-data');
    await until(() => document.querySelector('.ag-row[row-index="1"] .ag-cell') !== null, null, 'the Data grid', 8000);
    const viewport = '#record-grid .ag-grid-viewport';
    const scrollable = await page.evaluate(selector => { const element = document.querySelector(selector); return element.scrollWidth - element.clientWidth; }, viewport);
    assert(scrollable > 40, `the grid does not scroll sideways at this width (${scrollable} px); the check measures nothing`);
    await page.evaluate(selector => { document.querySelector(selector).scrollLeft = 40; }, viewport);
    await page.waitForTimeout(200);
    const target = await page.evaluate(() => {
      const viewport = document.querySelector('#record-grid .ag-grid-viewport').getBoundingClientRect();
      const cells = [...document.querySelectorAll('.ag-row[row-index="0"] .ag-cell[col-id]')].filter(cell => {
        const box = cell.getBoundingClientRect();
        return box.left >= viewport.left && box.right <= viewport.right && !cell.classList.contains('record-open-cell') && /text|title|name/i.test(cell.getAttribute('col-id') + ' ' + (cell.closest('[role="gridcell"]')?.textContent ?? ''));
      });
      return cells[0]?.getAttribute('col-id') ?? null;
    });
    assert(target !== null, 'no text cell is in view; the check measures nothing');
    const scrollBefore = await page.evaluate(selector => document.querySelector(selector).scrollLeft, viewport);
    await page.locator(`.ag-row[row-index="0"] .ag-cell[col-id="${target}"]`).click();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    await page.keyboard.press('End');
    await page.keyboard.type(' (kept)');
    await page.keyboard.press('Enter');
    await until(() => /saved/.test(document.querySelector('.message-slot:not([hidden])')?.textContent ?? ''), null, 'a visible saved message', 6000);
    await page.waitForTimeout(400);
    const where = await page.evaluate(() => { const cell = document.activeElement?.closest('.ag-cell'); return cell ? `${cell.closest('.ag-row')?.getAttribute('row-index')}:${cell.getAttribute('col-id')}` : document.activeElement?.tagName ?? 'none'; });
    assert(where === `0:${target}`, `UX-03: after the save the focus is on ${where}, not the cell it saved.`);
    const scrollAfter = await page.evaluate(selector => document.querySelector(selector).scrollLeft, viewport);
    assert(Math.abs(scrollAfter - scrollBefore) <= 2, `UX-03: the columns scrolled from ${scrollBefore} to ${scrollAfter} px.`);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(150);
    const down = await page.evaluate(() => document.activeElement?.closest('.ag-row')?.getAttribute('row-index') ?? null);
    assert(down === '1', `UX-03: ArrowDown after the save went to row ${down}.`);
  }, 900, 800);

  // UX-24 and UX-04: rejecting an agent's proposal asks first, and the outcome is on screen.
  await check('UX-24 UX-04 reject asks and says so', 'idea', async () => {
    await agentPage('activity');
    await until(() => document.querySelector('[data-review-agent-proposal]') !== null, null, 'a waiting proposal');
    await page.click('[data-review-agent-proposal]');
    await until(() => document.querySelector('#reject-agent-proposal') !== null, null, 'the review');
    await page.click('#reject-agent-proposal');
    await page.waitForTimeout(300);
    const asked = await page.evaluate(() => document.querySelector('dialog[open] h2')?.textContent ?? null);
    assert(asked === 'Reject this proposal?', `UX-24: Reject ${asked === null ? 'discarded the proposal without asking' : `asked ${JSON.stringify(asked)}`}.`);
    await page.click('dialog[open] [data-cancel]');
    await page.waitForTimeout(300);
    assert(await page.evaluate(() => document.querySelector('.agent-proposal-page') !== null), 'UX-24: Cancel left the review.');
    await page.click('#reject-agent-proposal');
    await until(() => document.querySelector('dialog[open] [data-confirm]') !== null, null, 'the question again');
    await page.click('dialog[open] [data-confirm]');
    await until(() => document.querySelector('.agent-proposal-page') === null, null, 'the Agent page after Reject', 6000);
    await page.waitForTimeout(300);
    const said = await message();
    assert(said !== '', 'UX-04: after Reject nothing on screen says what happened.');
  });

  // UX-14 and UX-10: the Agent page speaks of edit access and the file, not leases and workspaces.
  await check('UX-14 UX-10 Agent page words', 'idea', async () => {
    await agentPage('activity');
    const activity = await page.evaluate(() => document.querySelector('#studio-content').innerText);
    await page.click('[data-agent-tab="connect"]');
    await page.waitForTimeout(300);
    const text = activity + ' ' + await page.evaluate(() => document.querySelector('#studio-content').innerText);
    const found = ['\\blease\\b', '\\bworkspace\\b', '\\bsurfaces?\\b', '\\bHarden\\b'].filter(word => new RegExp(word, 'i').test(text));
    assert(found.length === 0, `UX-14: the Agent page still says ${found.join(', ')}.`);
  });

  // UX-10: one word for screens, in the rail, the Use picker and the Screens page.
  await check('UX-10 one word for screens', 'decision', async () => {
    const picker = await page.evaluate(() => document.querySelector('.surface-picker-label')?.textContent ?? null);
    await page.click('#nav-surfaces');
    await page.waitForTimeout(600);
    const rail = await page.evaluate(() => document.querySelector('#nav-surfaces')?.innerText ?? '');
    const pageText = await page.evaluate(() => document.querySelector('#studio-content').innerText);
    assert(picker === 'Screen' && /Screens/.test(rail) && !/\bsurfaces?\b/i.test(pageText),
      `UX-10: the picker says ${JSON.stringify(picker)}, the rail ${JSON.stringify(rail)}${/\bsurfaces?\b/i.test(pageText) ? ', and the page still says surface' : ''}.`);
  });

  // UX-18: ticking Not set empties its box, and unticking brings the text back.
  await check('UX-18 Not set empties its box', 'decision', async () => {
    await openRecord();
    const name = await page.evaluate(() => [...document.querySelectorAll('#record-form [data-null-field]')].map(box => box.dataset.nullField)
      .find(field => { const control = document.querySelector(`#record-form [name="${CSS.escape(field)}"]`); return control instanceof HTMLInputElement && control.type === 'text' && control.offsetParent !== null; }) ?? null);
    assert(name !== null, 'the record has no optional text field; the check measures nothing');
    const box = `#record-form [name="${name}"]`;
    await page.fill(box, 'Try it on Friday');
    await page.check(`#record-form [data-null-field="${name}"]`);
    const ticked = await page.evaluate(box => document.querySelector(box).value, box);
    assert(ticked === '', `UX-18: with Not set ticked the box still shows ${JSON.stringify(ticked)}, which a save throws away.`);
    await page.uncheck(`#record-form [data-null-field="${name}"]`);
    const back = await page.evaluate(box => document.querySelector(box).value, box);
    assert(back === 'Try it on Friday', `UX-18: unticking Not set left ${JSON.stringify(back)} in the box.`);
  });

  // UX-20: with no file open, nothing in the rail is the current page.
  await check('UX-20 no current page without a file', 'decision', async () => {
    await page.click('#file-menu > summary');
    await page.click('[data-file-action="file.close"]');
    await until(() => document.querySelector('[data-testid="no-file-state"]') !== null, null, 'the start screen', 6000);
    const current = await page.evaluate(() => [...document.querySelectorAll('[aria-current="page"]')].map(element => element.id || element.tagName));
    assert(current.length === 0, `UX-20: with no file open ${current.join(', ')} is marked as the current page.`);
    // Help draws with no file, so it is the current page then (the review's catch).
    await page.click('#nav-help');
    await page.waitForTimeout(400);
    const help = await page.evaluate(() => document.querySelector('#nav-help')?.getAttribute('aria-current'));
    assert(help === 'page', `UX-20: Help with no file open is not marked as the current page (${help}).`);
  });

  // UX-08, the Reference half: Studio's filter takes a reference by choosing its record.
  await check('UX-08 reference filter by its record', 'tree', async () => {
    await page.click('#nav-data');
    await until(() => document.querySelector('[data-layout="table"]') !== null, null, 'the layout switch', 8000);
    await page.click('[data-layout="table"]');
    await until(() => document.querySelector('#studio-query select[name="field"]') !== null, null, 'the Data filter', 8000);
    await page.selectOption('#studio-query select[name="field"]', 'field.capability.parent');
    await page.waitForTimeout(200);
    const shown = await page.evaluate(() => ({ box: !document.querySelector('#studio-query input[name="value"]').closest('label').hidden,
      picker: document.querySelector('[data-query-reference] .reference-choose') !== null }));
    assert(shown.picker && !shown.box, `UX-08: a Reference filter offers ${shown.box ? 'a box for a record ID' : 'nothing'} rather than a record picker.`);
    await page.click('[data-query-reference] .reference-choose');
    await until(() => document.querySelector('[data-query-reference] .reference-result') !== null, null, 'records to choose from', 6000);
    const picked = await page.evaluate(() => { const button = document.querySelector('[data-query-reference] .reference-result'); const text = button.textContent; button.click(); return text; });
    const [label, id] = picked.split(' · ');
    await page.click('#studio-query button[type="submit"]');
    await until(() => /Part of/.test(document.querySelector('#studio-query .query-status')?.textContent ?? ''), null, 'the filter to apply', 6000);
    const status = await page.evaluate(() => document.querySelector('#studio-query .query-status').textContent);
    assert(status.includes(label) && !status.includes(id), `UX-08: the filter status reads ${JSON.stringify(status)}, not the record's label.`);
  });

  // UX-04: a delete says what it deleted and offers History, where Undo brings it back.
  await check('UX-04 delete offers History', 'decision', async () => {
    await openRecord();
    await page.click('#delete-record');
    await until(() => document.querySelector('dialog[open] [data-confirm]') !== null, null, 'the delete question');
    await page.click('dialog[open] [data-confirm]');
    await until(() => document.querySelector('#outcome-action') !== null, null, 'the delete outcome and its action', 6000);
    const said = await message();
    assert(/History can bring it back/.test(said), `UX-04: the delete said ${JSON.stringify(said)}.`);
    await page.click('#outcome-action');
    await until(() => document.querySelector('.history-entry') !== null, null, 'History', 6000);
    const first = await page.evaluate(() => document.querySelector('.history-entry h3')?.textContent ?? '');
    assert(/Delete/.test(first), `UX-04: Open History showed ${JSON.stringify(first)} first, not the delete.`);
  });

  // --- W-215: CSS tokens, contrast themes and narrow windows (FIXES.md CSS-01 to CSS-20) ---------
  // Each measures what the eye would check: a box, a computed style, a contrast ratio.

  // A new window size, waited for until the page has laid itself out at it.
  const resized = async (width, height) => {
    await page.setViewportSize({ width, height });
    await page.waitForFunction(([width, height]) => innerWidth === width && innerHeight === height, [width, height], { timeout: 4000 });
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
  };

  // Windows' caption buttons, as the Desktop host reports them (title-bar.ts sets the same two).
  const captionButtons = (right = 138) => page.evaluate(right => {
    document.documentElement.dataset.titleBar = 'window';
    document.documentElement.style.setProperty('--title-bar-right', `${right}px`);
    document.documentElement.style.setProperty('--title-bar-height', '48px');
  }, right);
  // The part of every control in the title band that is drawn: its box cut by each box that clips it.
  const underCaption = (right = 138) => page.evaluate(right => {
    const hits = [];
    for (const element of document.querySelectorAll('button, summary, input, select, a[href]')) {
      let box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0 || getComputedStyle(element).visibility === 'hidden') continue;
      let { left, top, right: end, bottom } = box;
      for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
        const clip = parent.getBoundingClientRect();
        left = Math.max(left, clip.left); top = Math.max(top, clip.top); end = Math.min(end, clip.right); bottom = Math.min(bottom, clip.bottom);
      }
      if (end - left < 1 || bottom - top < 1) continue;
      if (top < 48 && end > innerWidth - right + 0.5) hits.push(`${element.id || element.className || element.tagName} [${Math.round(left)}-${Math.round(end)}]`);
    }
    return hits;
  }, right);

  // CSS-01: a narrow, short window keeps the navigation as the bar across the top, every item
  // readable, and nothing under Windows' buttons.
  await check('CSS-01 narrow short window', 'decision', async () => {
    await captionButtons();
    for (const [width, height] of [[800, 560], [683, 480]]) {
      await resized(width, height);
      const bar = await page.evaluate(() => {
        const rail = document.querySelector('.rail').getBoundingClientRect();
        const items = [...document.querySelectorAll('.rail .nav-item')].filter(item => getComputedStyle(item).display !== 'none').map(item => {
          const box = item.getBoundingClientRect();
          const shown = [...item.children].some(child => child.tagName === 'SPAN' && getComputedStyle(child).display !== 'none'
            && child.getBoundingClientRect().width > 4 && getComputedStyle(child).clipPath === 'none');
          return { id: item.id, width: Math.round(box.width), top: box.top, bottom: box.bottom, shown };
        });
        return { rail: [Math.round(rail.left), Math.round(rail.top), Math.round(rail.width), Math.round(rail.height)], width: innerWidth, items };
      });
      const wrong = bar.items.filter(item => item.width < 24 || !item.shown || item.top < bar.rail[1] - 0.5 || item.bottom > bar.rail[1] + bar.rail[3] + 0.5);
      assert(bar.rail[2] >= width - 160 && bar.rail[3] <= 49 && bar.rail[0] === 0,
        `CSS-01: at ${width}x${height} the navigation is a ${bar.rail[2]}x${bar.rail[3]} box at ${bar.rail[0]},${bar.rail[1]}, not the bar across the top.`);
      assert(wrong.length === 0, `CSS-01: at ${width}x${height} these navigation items are blank or squeezed: ${wrong.map(item => `${item.id} ${item.width}px${item.shown ? '' : ' no icon or label'}`).join(', ')}.`);
      const hidden = await underCaption();
      assert(hidden.length === 0, `CSS-01: at ${width}x${height} Windows' Minimise, Maximise and Close sit over ${hidden.join(', ')}.`);
    }
    // A wide window with no file open has no tabs, so the address row is the top of the window.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.click('#file-menu > summary');
    await page.click('[data-file-action="file.close"]');
    await until(() => document.querySelector('[data-testid="no-file-state"]') !== null, null, 'the start screen', 6000);
    const wide = await underCaption();
    assert(wide.length === 0, `CSS-01: in a wide window with no file open Windows' buttons sit over ${wide.join(', ')}.`);
  }, 1440, 900);

  // CSS-01: the narrow bar keeps the hairline between it and the layer, which has no border there.
  await check('CSS-01 narrow bar hairline', 'decision', async () => {
    const line = await page.evaluate(() => {
      const rail = document.querySelector('.rail');
      const style = getComputedStyle(rail);
      const probe = document.createElement('span');
      probe.style.color = 'var(--line)';
      document.body.append(probe);
      const colour = getComputedStyle(probe).color;
      probe.remove();
      const layer = document.querySelector('.workspace-layer').getBoundingClientRect();
      return { width: style.borderBottomWidth, style: style.borderBottomStyle, colour: style.borderBottomColor, line: colour,
        joins: Math.abs(rail.getBoundingClientRect().bottom - layer.top) <= 0.5, layerTop: getComputedStyle(document.querySelector('.workspace-layer')).borderTopStyle };
    });
    assert(line.width === '1px' && line.style === 'solid' && line.colour === line.line && line.joins,
      `CSS-01: at 800px the bar across the top meets the layer with no hairline: ${JSON.stringify(line)}.`);
  }, 800, 700);

  // CSS-19: a top bar wider than the window shows that it scrolls, and nothing it scrolls slides
  // under Windows' buttons.
  await check('CSS-19 narrow top bar scrolls visibly', 'decision', async () => {
    const bar = await page.evaluate(() => {
      const rail = document.querySelector('.rail');
      const inView = (id) => { const box = document.getElementById(id).getBoundingClientRect(); return box.right <= innerWidth && box.left >= 0; };
      return { overflows: rail.scrollWidth > rail.clientWidth + 1, scrollbar: getComputedStyle(rail).scrollbarWidth, agent: inView('nav-agent'), help: inView('nav-help'),
        overflowY: getComputedStyle(rail).overflowY, brand: Math.round(document.querySelector('.brand').getBoundingClientRect().height), room: rail.clientHeight };
    });
    assert(bar.overflowY === 'hidden' && bar.brand <= bar.room, `CSS-19: the top bar can scroll up and down: overflow-y ${bar.overflowY}, its brand ${bar.brand}px in ${bar.room}px.`);
    assert(bar.overflows, 'CSS-19: at 400px the top bar fits the window; the check measures nothing.');
    assert((bar.agent && bar.help) || bar.scrollbar !== 'none',
      `CSS-19: at 400px Agent and Help are past the window's edge (${JSON.stringify(bar)}) and the bar hides its scrollbar, so nothing shows it scrolls.`);
    await captionButtons();
    await resized(585, 700);
    const hidden = await underCaption();
    assert(hidden.length === 0, `CSS-19: at 585px with the bar scrolled to its start, Windows' buttons sit over ${hidden.join(', ')}.`);
  }, 400, 700);

  // CSS-02 and CSS-07: Health's recovery panels stack in a narrow window, and their headings are
  // the card size, spanning the compact action grid.
  const health = async () => {
    await page.click('#nav-health');
    await until(() => document.querySelector('.recovery-layout .recovery-action-list > h2') !== null, null, 'Health', 6000);
  };
  await check('CSS-02 recovery layout stacks', 'decision', async () => {
    await health();
    for (const width of [700, 400]) {
      await resized(width, 800);
      const layout = await page.evaluate(() => {
        const grid = document.querySelector('.recovery-layout');
        return { tracks: getComputedStyle(grid).gridTemplateColumns.split(' ').length, columns: getComputedStyle(grid).gridTemplateColumns,
          findings: Math.round(document.querySelector('.recovery-findings').getBoundingClientRect().width), grid: Math.round(grid.getBoundingClientRect().width) };
      });
      assert(layout.tracks === 1 && layout.findings >= layout.grid - 1,
        `CSS-02: at ${width}px the recovery layout keeps columns ${layout.columns}, so File status is ${layout.findings}px of ${layout.grid}px.`);
    }
  }, 1440, 900);

  await check('CSS-07 recovery headings', 'decision', async () => {
    await health();
    const sizes = await page.evaluate(() => [...document.querySelectorAll('.recovery-findings > h2, .recovery-action-list > h2')].map(heading => getComputedStyle(heading).fontSize));
    assert(sizes.length === 2 && sizes.every(size => size === '14.7px'), `CSS-07: Health's card headings are ${sizes.join(' and ')}, not the 1.05rem (14.7px) of a card heading.`);
    await resized(800, 560);
    const compact = await page.evaluate(() => {
      const list = document.querySelector('.recovery-action-list');
      const heading = list.querySelector(':scope > h2');
      const first = list.querySelector(':scope > button');
      const style = getComputedStyle(list);
      const inner = list.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return { columns: style.gridTemplateColumns.split(' ').length, end: getComputedStyle(heading).gridColumnEnd,
        width: Math.round(heading.getBoundingClientRect().width), inner: Math.round(inner), below: first.getBoundingClientRect().top >= heading.getBoundingClientRect().bottom - 0.5 };
    });
    assert(compact.columns === 2 && compact.end === '-1' && compact.width >= compact.inner - 1 && compact.below,
      `CSS-07: in the compact action grid the Recovery actions heading is ${JSON.stringify(compact)}; it should span the grid with the actions under it.`);
  }, 1440, 900);

  // CSS-03: the agent and health pills stay on the status line in a narrow window.
  await check('CSS-03 status pills in a narrow window', 'decision', async () => {
    const pills = await page.evaluate(() => {
      const bar = document.querySelector('#session-status').getBoundingClientRect();
      return ['agent-working', 'session-health'].map(id => {
        const pill = document.getElementById(id);
        pill.hidden = false;
        const box = pill.getBoundingClientRect();
        return { id, display: getComputedStyle(pill).display, inside: box.width > 0 && box.left >= bar.left - 0.5 && box.right <= bar.right + 0.5 && box.top >= bar.top - 0.5 && box.bottom <= bar.bottom + 0.5 };
      });
    });
    const lost = pills.filter(pill => pill.display === 'none' || !pill.inside);
    assert(lost.length === 0, `CSS-03: at 800px ${lost.map(pill => `#${pill.id} is ${pill.display === 'none' ? 'display: none' : 'outside the status line'}`).join(', ')}.`);
  }, 800, 700);

  // CSS-03: at 400px the status line holds both pills, as dots that keep their words for a screen
  // reader, and still ends inside the window.
  await check('CSS-03 status line at 400px', 'decision', async () => {
    const line = await page.evaluate(() => {
      const agent = document.getElementById('agent-working');
      agent.hidden = false;
      agent.querySelector('.status-pill-text').textContent = 'An agent is working';
      const health = document.getElementById('session-health');
      health.hidden = false;
      health.dataset.state = 'warning';
      health.querySelector('.status-pill-text').textContent = 'Acceptance unconfirmed';
      const bar = document.querySelector('#session-status');
      const past = [...bar.querySelectorAll('.status-end > *')].filter(item => getComputedStyle(item).display !== 'none' && !item.matches('.status-keys'))
        .map(item => ({ item: item.id || item.className, right: Math.round(item.getBoundingClientRect().right) })).filter(item => item.right > innerWidth + 0.5);
      return { past, scrolls: bar.scrollWidth > bar.clientWidth + 1, pills: [agent, health].map(pill => ({ id: pill.id, display: getComputedStyle(pill).display, words: pill.querySelector('.status-pill-text').textContent })) };
    });
    assert(line.pills.every(pill => pill.display !== 'none' && pill.words.length > 0), `CSS-03: at 400px the status pills are ${JSON.stringify(line.pills)}.`);
    assert(line.past.length === 0 && !line.scrolls, `CSS-03: at 400px with both pills showing the status line runs past the window: ${line.past.map(item => `${item.item} ends at ${item.right}px`).join(', ')}${line.scrolls ? '; it scrolls' : ''}.`);
  }, 400, 700);

  // CSS-05: the address row is one row at every width.
  await check('CSS-05 address row one row', 'decision', async () => {
    for (const width of [600, 400]) {
      await resized(width, 800);
      const row = await page.evaluate(() => {
        const header = document.querySelector('.workspace-header');
        const box = header.getBoundingClientRect();
        return { height: Math.round(box.height), direction: getComputedStyle(header).flexDirection };
      });
      assert(row.height <= 52 && row.direction === 'row', `CSS-05: at ${width}px the address row is ${row.height}px tall, laid out as a ${row.direction}.`);
    }
  }, 600, 800);

  // CSS-08: the status line ends on the window's bottom edge in a short wide window.
  await check('CSS-08 status line at the bottom', 'decision', async () => {
    const edge = await page.evaluate(() => ({ bottom: document.querySelector('#session-status').getBoundingClientRect().bottom, height: innerHeight }));
    assert(Math.abs(edge.bottom - edge.height) <= 0.5, `CSS-08: at 1280x700 the status line ends at ${edge.bottom}px of ${edge.height}px.`);
  }, 1280, 700);

  // CSS-12: a focus ring in the navigation is whole, not cut by the list's clip.
  await check('CSS-12 navigation focus ring whole', 'decision', async () => {
    const rings = [];
    for (const selector of ['#nav-use', '.nav-place']) {
      await page.focus(selector);
      rings.push(await page.evaluate(selector => {
        const item = document.querySelector(selector);
        const style = getComputedStyle(item);
        const grow = parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth);
        const box = item.getBoundingClientRect();
        let clip = null;
        for (let parent = item.parentElement; parent !== null && clip === null; parent = parent.parentElement) {
          const own = getComputedStyle(parent);
          if (own.overflowX !== 'visible' || own.overflowY !== 'visible') clip = parent.getBoundingClientRect();
        }
        const ring = { left: box.left - grow, right: box.right + grow };
        return { selector, visible: item.matches(':focus-visible'), style: style.outlineStyle, ring: [Math.round(ring.left), Math.round(ring.right)],
          clip: clip && [Math.round(clip.left), Math.round(clip.right)], inside: clip === null || (ring.left >= clip.left - 0.5 && ring.right <= clip.right + 0.5) };
      }, selector));
    }
    assert(rings.every(ring => ring.visible && ring.style !== 'none'), `CSS-12: the navigation shows no focus ring to measure: ${JSON.stringify(rings)}.`);
    const cut = rings.filter(ring => !ring.inside);
    assert(cut.length === 0, `CSS-12: the focus ring's sides are cut off by the navigation's clip: ${cut.map(ring => `${ring.selector} ring ${ring.ring} clip ${ring.clip}`).join('; ')}.`);
  }, 1440, 900);

  // CSS-13: Structure's field rows stay inside their card at the widths that overflowed.
  await check('CSS-13 field rows inside their card', 'decision', async () => {
    await page.click('#nav-structure');
    await until(() => document.querySelector('.definition-card .field-row:not(.field-row-head)') !== null, null, 'Structure', 6000);
    for (const width of [960, 900, 680]) {
      await resized(width, 800);
      const fit = await page.evaluate(() => {
        const card = document.querySelector('.definition-card').getBoundingClientRect();
        const pane = document.querySelector('#studio-content');
        const over = [];
        for (const row of document.querySelectorAll('.definition-card .field-row:not(.field-row-head)')) {
          const box = row.getBoundingClientRect();
          if (box.right > card.right + 0.5 || row.scrollWidth > row.clientWidth + 1) over.push(`row ${Math.round(box.left)}-${Math.round(box.right)} scroll ${row.scrollWidth}/${row.clientWidth}`);
          for (const cell of row.children) { const part = cell.getBoundingClientRect(); if (part.right > box.right + 0.5) over.push(`${cell.className} ends at ${Math.round(part.right)} past ${Math.round(box.right)}`); }
        }
        return { card: [Math.round(card.left), Math.round(card.right)], over: over.slice(0, 4), paneScroll: pane.scrollWidth > pane.clientWidth + 1 };
      });
      assert(fit.over.length === 0 && !fit.paneScroll, `CSS-13: at ${width}px the field rows overflow their card ${fit.card}: ${fit.over.join('; ')}${fit.paneScroll ? '; the page scrolls sideways' : ''}.`);
    }
  }, 1440, 900);

  // CSS-14: the command box's Ctrl K sits in the middle of its key cap.
  await check('CSS-14 Ctrl K key cap centred', 'decision', async () => {
    const cap = await page.evaluate(() => {
      const kbd = document.querySelector('.palette-trigger kbd');
      const style = getComputedStyle(kbd);
      const range = document.createRange();
      range.selectNodeContents(kbd);
      const text = range.getBoundingClientRect();
      const box = kbd.getBoundingClientRect();
      return { display: style.display, top: +(text.top - box.top - parseFloat(style.borderTopWidth)).toFixed(1), bottom: +(box.bottom - parseFloat(style.borderBottomWidth) - text.bottom).toFixed(1) };
    });
    assert(Math.abs(cap.top - cap.bottom) <= 1, `CSS-14: Ctrl K in the command box sits ${cap.top}px from the cap's top and ${cap.bottom}px from its bottom (display ${cap.display}).`);
  }, 1280, 800);

  // CSS-15: the @ menu stays inside the pane above the message box in a short wide window. The
  // preview file offers only a few choices, so the menu is filled to the length a real file's
  // reaches (about 18 with no query) before it is measured.
  // It opens in a tall window, which then shrinks, so the room is measured again while it is open.
  await check('CSS-15 @ menu inside the pane', 'idea', async () => {
    await launch();
    await page.locator('#agent-prompt').fill('@');
    await until(() => document.querySelector('#chat-mention:not([hidden]) [data-choice]') !== null, null, 'the @ menu');
    await page.evaluate(() => document.querySelector('#chat-mention').insertAdjacentHTML('beforeend',
      Array.from({ length: 18 }, (_, index) => `<div class="mention-option" role="option" aria-selected="false"><span class="mention-icon"></span><span>Choice ${index}</span></div>`).join('')));
    await resized(1024, 560);
    const menu = await page.evaluate(() => {
      const list = document.querySelector('#chat-mention');
      const box = list.getBoundingClientRect();
      const pane = list.closest('.studio-content').getBoundingClientRect();
      const head = list.querySelector('.mention-head')?.getBoundingClientRect();
      const composer = list.offsetParent.getBoundingClientRect();
      return { top: Math.round(box.top), pane: Math.round(pane.top), height: Math.round(box.height), content: list.scrollHeight, room: Math.round(composer.top - pane.top), head: head ? Math.round(head.top) : null };
    });
    assert(menu.content > menu.room, `CSS-15: the @ menu's ${menu.content}px fit the ${menu.room}px above the box; the check measures nothing.`);
    assert(menu.top >= menu.pane - 0.5 && (menu.head === null || menu.head >= menu.pane), `CSS-15: at 1024x560 the @ menu's top is ${menu.top}px, above the pane's ${menu.pane}px, so ${menu.pane - menu.top}px of it is clipped (${JSON.stringify(menu)}).`);
  }, 1440, 900);

  // CSS-20: Studio, Agent and Help are in navigation landmarks, and no generic box is named.
  await check('CSS-20 navigation landmarks', 'decision', async () => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Accessibility.enable');
    const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
    const roles = async (selector) => {
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
      const { nodes } = await cdp.send('Accessibility.getAXNodeAndAncestors', { nodeId });
      return nodes.map(node => ({ role: node.role?.value ?? '', name: node.name?.value ?? '' }));
    };
    const problems = [];
    for (const id of ['#nav-data', '#nav-agent', '#nav-help']) {
      const chain = await roles(id);
      if (!chain.some(node => node.role === 'navigation' && node.name !== '')) problems.push(`${id} is in ${chain.map(node => `${node.role}${node.name ? ` "${node.name}"` : ''}`).join(' < ')}, no named navigation landmark`);
    }
    for (const selector of ['.brand', '.studio-nav']) {
      const [node] = await roles(selector);
      if (node.role === 'generic' && node.name !== '') problems.push(`${selector} is a generic box named "${node.name}"`);
    }
    await cdp.detach();
    assert(problems.length === 0, `CSS-20: ${problems.join('; ')}.`);
  }, 1440, 900);

  // CSS-04: under a Windows contrast theme every selected, pressed or focused state still differs
  // from its plain twin, and selection and focus differ from each other: focus on a selected
  // control still shows, and a selected row is not mistaken for the focused one. Forced colors
  // makes fills Canvas and drops shadows, so this compares what survives: the outline, the
  // borders and the fill (the control's own and its ::before's) as forced colors computes them.
  await check('CSS-04 states under forced colors', 'decision', async () => {
    await page.emulateMedia({ forcedColors: 'active' });
    try {
      await page.reload();
      await page.waitForFunction(() => document.querySelector('#studio-content')?.getAttribute('aria-busy') === 'false' && document.querySelector('.nav-place.is-selected') !== null, null, { timeout: 15000 });
      const states = await page.evaluate(() => {
        const host = document.createElement('div');
        host.innerHTML = `<div class="rating-picker"><label><input type="radio" name="w215" checked></label><label><input type="radio" name="w215"></label></div>
          <span class="rating"><span class="rating-dot is-filled"></span><span class="rating-dot"></span></span>
          <div class="tablist" role="tablist"><button role="tab" aria-selected="true">One</button><button role="tab" aria-selected="false">Two</button></div>
          <div class="view-switcher"><button aria-pressed="true">Board</button><button aria-pressed="false">Table</button></div>
          <div class="theme-control layout-control" role="group"><button type="button" aria-pressed="true">Outline</button><button type="button" aria-pressed="false">Table</button></div>
          <div class="chat-mention"><div class="mention-option" aria-selected="true">One</div><div class="mention-option" aria-selected="false">Two</div></div>
          <table class="outline-table"><tbody><tr class="outline-row is-selected" tabindex="-1"><td>One</td></tr><tr class="outline-row" tabindex="0"><td>Two</td></tr></tbody></table>
          <div class="calendar-cell is-today">1</div><div class="calendar-cell">2</div>`;
        document.body.append(host);
        // A fill of the theme's Canvas, at any opacity, over Canvas is no fill a person can see.
        const probe = document.createElement('span');
        probe.style.background = 'Canvas';
        host.append(probe);
        const canvas = getComputedStyle(probe).backgroundColor.match(/[\d.]+/g).slice(0, 3).join(',');
        const fill = (value) => {
          const [r, g, b, a = '1'] = value.match(/[\d.]+/g) ?? ['0', '0', '0', '0'];
          return Number(a) < 0.5 || `${r},${g},${b}` === canvas ? 'no fill' : `fill ${value}`;
        };
        const own = (element, pseudo) => {
          const style = getComputedStyle(element, pseudo);
          if (pseudo !== null && (style.content === 'none' || style.content === 'normal')) return '';
          const sides = ['Top', 'Right', 'Bottom', 'Left'].map(side => style[`border${side}Style`] === 'none' || parseFloat(style[`border${side}Width`]) === 0
            ? '-' : `${style[`border${side}Width`]} ${style[`border${side}Color`]}`);
          return [style.outlineStyle === 'none' ? 'no outline' : `outline ${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
            sides.every(side => side === '-') ? 'no border' : `border ${sides.join(' / ')}`, fill(style.backgroundColor)].join(', ');
        };
        // A row is drawn by its cells too.
        const mark = (element) => [own(element, null), own(element, '::before'), ...[...element.querySelectorAll(':scope > td')].map(cell => own(cell, null))].filter(Boolean).join(' | ');
        const pair = (name, on, off) => ({ name, on: mark(on), off: mark(off) });
        const q = (selector) => document.querySelector(selector);
        const pairs = [
          pair('selected navigation place', q('.nav-place.is-selected'), q('#nav-data')),
          pair('pressed theme button', q('.status-bar .theme-control button[aria-pressed="true"]'), q('.status-bar .theme-control button[aria-pressed="false"]')),
          pair('pressed layout button', host.querySelector('.layout-control [aria-pressed="true"]'), host.querySelector('.layout-control [aria-pressed="false"]')),
          pair('checked rating', host.querySelector('.rating-picker input:checked'), host.querySelector('.rating-picker input:not(:checked)')),
          pair('filled rating dot', host.querySelector('.rating-dot.is-filled'), host.querySelector('.rating-dot:not(.is-filled)')),
          pair('selected record-page tab', host.querySelector('[aria-selected="true"][role="tab"]'), host.querySelector('[aria-selected="false"][role="tab"]')),
          pair('pressed view switcher segment', host.querySelector('.view-switcher [aria-pressed="true"]'), host.querySelector('.view-switcher [aria-pressed="false"]')),
          pair('selected @ menu option', host.querySelector('.mention-option[aria-selected="true"]'), host.querySelector('.mention-option[aria-selected="false"]')),
          pair('selected outline row', host.querySelector('.outline-row.is-selected'), host.querySelectorAll('.outline-row')[1]),
          pair('today in the calendar', host.querySelector('.calendar-cell.is-today'), host.querySelector('.calendar-cell:not(.is-today)')),
        ];
        // Focus against selection: a focused plain control and a selected one look different, and
        // a selected control looks different focused and not.
        const notVisible = [];
        const focused = (element) => {
          element.focus();
          if (!element.matches(':focus-visible')) notVisible.push(element.id || element.className || element.textContent.trim());
          const seen = mark(element);
          element.blur();
          return seen;
        };
        for (const [name, selected, plain] of [
          ['tab', host.querySelector('[aria-selected="true"][role="tab"]'), host.querySelector('[aria-selected="false"][role="tab"]')],
          ['view switcher segment', host.querySelector('.view-switcher [aria-pressed="true"]'), host.querySelector('.view-switcher [aria-pressed="false"]')],
          ['theme button', q('.status-bar .theme-control button[aria-pressed="true"]'), q('.status-bar .theme-control button[aria-pressed="false"]')],
          ['layout button', host.querySelector('.layout-control [aria-pressed="true"]'), host.querySelector('.layout-control [aria-pressed="false"]')],
          ['navigation place', q('.nav-place.is-selected'), q('#nav-data')],
          ['outline row', host.querySelector('.outline-row.is-selected'), host.querySelectorAll('.outline-row')[1]],
        ]) {
          const still = mark(selected);
          pairs.push({ name: `focused ${name} against a selected one`, on: focused(plain), off: still });
          pairs.push({ name: `selected ${name} focused against not`, on: focused(selected), off: still });
        }
        const forced = matchMedia('(forced-colors: active)').matches;
        host.remove();
        return { forced, notVisible, pairs };
      });
      assert(states.forced && states.notVisible.length === 0, `CSS-04: forced colors ${states.forced ? 'is' : 'is not'} active, and focus is not focus-visible on ${states.notVisible.join(', ') || 'nothing'}; the check measures nothing.`);
      const same = states.pairs.filter(state => state.on === state.off);
      assert(same.length === 0, `CSS-04: under forced colors these states look the same: ${same.map(state => `${state.name} (${state.on})`).join('; ')}.`);
    } finally {
      await page.emulateMedia({ forcedColors: 'none' });
    }
  }, 1440, 900);

  // CSS-09, CSS-10 and CSS-11: colours in both themes, as the page computes them.
  await check('CSS-09 CSS-10 CSS-11 theme colours', 'decision', async () => {
    const problems = [];
    for (const theme of ['light', 'dark']) {
      await page.click(`[data-theme-option="${theme}"]`);
      await until(theme => document.documentElement.dataset.theme === theme, theme, `the ${theme} theme`);
      const measured = await page.evaluate(() => {
        const rgb = (value) => {
          const plain = value.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
          if (plain) return [+plain[1], +plain[2], +plain[3], plain[4] === undefined ? 1 : +plain[4]];
          const srgb = value.match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/);
          if (srgb) return [srgb[1] * 255, srgb[2] * 255, srgb[3] * 255, srgb[4] === undefined ? 1 : +srgb[4]];
          return null;
        };
        const channel = (value) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
        const luminance = (c) => 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
        const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
        const host = document.createElement('div');
        host.innerHTML = '<button class="connection-toggle" aria-pressed="true" type="button"><span class="switch-glyph"></span></button><article class="record-card">Card</article><span class="summary-failed">Unavailable</span><span class="w215-danger" style="color: var(--danger)">x</span>';
        document.body.append(host);
        const glyph = host.querySelector('.switch-glyph');
        const knob = rgb(getComputedStyle(glyph, '::after').backgroundColor);
        const track = rgb(getComputedStyle(glyph).backgroundColor);
        const shadows = (getComputedStyle(host.querySelector('.record-card')).boxShadow.match(/rgba?\([^)]*\)|color\(srgb[^)]*\)/g) ?? []).map(rgb);
        const failed = getComputedStyle(host.querySelector('.summary-failed')).color;
        const danger = getComputedStyle(host.querySelector('.w215-danger')).color;
        host.remove();
        return { knob: knob && knob.map(Math.round), track: track && track.map(Math.round), ratio: knob && track ? +contrast(knob, track).toFixed(2) : 0,
          shadows: shadows.map(colour => colour && colour.slice(0, 3).map(value => +(value / 255).toFixed(2))), failed, danger };
      });
      if (measured.ratio < 3) problems.push(`CSS-09: in ${theme} the on switch's knob ${measured.knob} on its track ${measured.track} is ${measured.ratio}:1, below 3:1`);
      if (theme === 'dark' && (measured.shadows.length === 0 || measured.shadows.some(colour => colour === null || colour.some(value => value >= 0.2))))
        problems.push(`CSS-10: in dark a card's shadow is drawn in ${JSON.stringify(measured.shadows)}, a light glow rather than a shadow`);
      if (measured.failed !== measured.danger) problems.push(`CSS-11: in ${theme} a failed total is ${measured.failed}, not the danger colour ${measured.danger}`);
    }
    assert(problems.length === 0, problems.join('; ') + '.');
  }, 1440, 900);

  return { complete: failures.length === 0, checks, errors, failure: failures.join(' || ') };
  })(); } catch (error) {
    return { complete: false, checks, errors, failure: [...failures, String(error?.message ?? error)].join(' || ') };
  }
}
