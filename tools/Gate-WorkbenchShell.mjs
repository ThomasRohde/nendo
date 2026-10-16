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
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
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
  // The lazy table is scrolled with the wheel, a little back and then on, until `done` holds.
  // AG Grid can drop a scroll that lands while it is still syncing its own, and writing the same
  // scrollTop again fires no event, so a check that only set scrollTop could wait forever on a
  // grid that never asked for the next block (W-235).
  const wheelGrid = async (deltaY, done, arg, what, timeout = 10000) => {
    const box = await page.locator('#record-grid .ag-grid-viewport').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (const deadline = Date.now() + timeout; ;) {
      if (await page.evaluate(done, arg)) return;
      if (Date.now() > deadline) throw Error(`Timed out waiting for ${what}.`);
      await page.mouse.wheel(0, -Math.sign(deltaY) * 60);
      await page.mouse.wheel(0, deltaY);
      await page.waitForTimeout(200);
    }
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
    if ("__SHELL_CHECK__" && !name.includes("__SHELL_CHECK__")) return;
    try { await open(fixture, width, height); await body(); checks.push(name); } catch (error) { failures.push(`${name}: ${error?.message ?? error}`); }
  };

  for (const theme of ['light', 'dark']) await check(`W-233 lazy grid ${theme}`, 'idea', async () => {
    await page.evaluate(async theme => {
      const { client } = await import('/src/client.ts');
      const { applyTheme } = await import('/src/shell.ts');
      applyTheme(theme, false);
      const template = client.session.records.find(record => record.entityId === 'entity.idea');
      client.session.records = Array.from({ length: 1000 }, (_, index) => ({ ...structuredClone(template),
        recordId: `lazy-${String(index).padStart(5, '0')}`, recordVersion: 1 }));
      window.__lazyCalls = [];
      const request = client.request.bind(client);
      client.request = async (method, payload) => {
        if (method === 'data.queryRecordWindow') window.__lazyCalls.push(structuredClone(payload));
        return request(method, payload);
      };
    }, theme);
    await page.click('#nav-data');
    await until(() => document.querySelector('.ag-row[row-id="lazy-00000"]') !== null, null, 'the first lazy row', 10000);
    assert(await page.evaluate(() => window.__lazyCalls.length <= 2), 'W-233: opening fetched beyond the first viewport.');
    assert(await page.locator('[data-page-next]').count() === 0, 'W-233: the table still needs its pager.');
    const grid = await page.locator('#record-grid').elementHandle();
    for (let index = 1; index < 10; index++) {
      await wheelGrid(100000, index => window.__lazyCalls.some(call => call.start >= index * 100), index, `a request for lazy block ${index}`);
      await until(index => [...document.querySelectorAll('#record-grid .ag-row[row-id]')].some(row =>
        Number(row.getAttribute('row-index')) >= index * 100), index, `loaded lazy block ${index}`, 10000);
    }
    const counts = await page.evaluate(async () => ({ ...(await import('/src/view-data.ts')).dataGridReadDiagnostics(),
      dom: document.querySelectorAll('#record-grid .ag-row').length }));
    assert(counts.cachedRecords > 0 && counts.cachedRecords <= 500 && counts.blocks > 0 && counts.blocks <= 5 && counts.dom > 0 && counts.dom < 200,
      `W-233: cache grew with visited rows: ${JSON.stringify(counts)}.`);
    assert(await grid.evaluate(element => element.isConnected), 'W-233: loading replaced the grid.');
    await wheelGrid(-100000, () => document.querySelector('.ag-row[row-id="lazy-00000"] .ag-cell[col-id="field.idea.title"]')?.textContent?.length > 0,
      null, 'evicted first block to reload');
    assert(await page.evaluate(() => window.__lazyCalls.filter(call => call.start === 0).length >= 2), 'W-233: evicted block did not reload.');
    const copiedCell = page.locator('.ag-row[row-id="lazy-00000"] .ag-cell[col-id="field.idea.title"]');
    const copiedText = await copiedCell.textContent();
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: async text => { window.__lazyCopied = text; } } }));
    await copiedCell.click();
    await page.click('[data-grid-copy]');
    await until(text => window.__lazyCopied === text, copiedText, 'the formatted cell to reach the clipboard adapter');
    await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw Error('clipboard refused'); }; });
    await page.click('[data-grid-copy]');
    await until(() => /clipboard refused/i.test(document.querySelector('.message-slot:not([hidden])')?.textContent ?? ''), null, 'clipboard refusal feedback');
    await page.click('details.grid-columns summary');
    const hide = '[data-column-visible="field.idea.title"]';
    await page.locator(hide).uncheck();
    assert(await page.locator('.ag-header-cell[col-id="field.idea.title"]').count() === 0, 'W-233: hiding the column left it visible.');
    await page.locator(hide).check();
    await page.locator('[data-column-pin="field.idea.title"]').selectOption('left');
    assert(await page.locator('.ag-header .ag-grid-pinned-left-cells .ag-header-cell[col-id="field.idea.title"]').count() === 1, 'W-233: pin left did not move the column.');
    await page.click('[data-grid-reset]');
    await page.click('details.grid-columns summary');
    const colors = await page.evaluate(() => { const root = getComputedStyle(document.documentElement); const box = document.querySelector('#record-grid').getBoundingClientRect();
      return { surface: root.getPropertyValue('--surface').trim(), width: box.width, height: box.height }; });
    assert(colors.width > 300 && colors.height > 200, `W-233: grid lost its viewport: ${JSON.stringify(colors)}.`);
    assert(theme === 'light' ? colors.surface === '#ffffff' : colors.surface === '#2d2e30', `W-233: wrong theme tokens: ${JSON.stringify(colors)}.`);
    await page.setViewportSize({ width: 600, height: 800 });
    const toolbarFits = await page.evaluate(() => {
      const toolbar = document.querySelector('.data-toolbar').getBoundingClientRect();
      return [...document.querySelectorAll('.data-toolbar > button, .data-toolbar > details')].every(control => {
        const box = control.getBoundingClientRect(); return box.left >= toolbar.left && box.right <= toolbar.right;
      });
    });
    assert(toolbarFits, 'W-233: table actions overflow the narrow toolbar.');
    await page.evaluate(async () => { (await import('/src/view-data.ts')).markDataGridChanged(999999); });
    assert(/Refresh/.test(await page.locator('[data-grid-load-status]').textContent()), 'W-233: stale data did not offer an explicit refresh.');
    assert(await grid.evaluate(element => element.isConnected), 'W-233: a stale notification replaced the reading position.');
  });

  // A record's long text is one document (W-242): its box is as tall as its text, with no
  // scrollbar or grip of its own, the field one under another, and Not set in the heading row.
  for (const theme of ['light', 'dark']) await check(`W-242 long text as a document ${theme}`, 'idea', async () => {
    await page.evaluate(async theme => (await import('/src/shell.ts')).applyTheme(theme, false), theme);
    await page.click('#nav-data');
    await until(() => document.querySelector('.ag-row[row-index="0"] .record-open-cell') !== null, null, 'the first row');
    await page.click('.ag-row[row-index="0"] .record-open-cell');
    const notes = 'textarea[name="field.idea.notes"]';
    await until(selector => document.querySelector(selector) !== null, notes, 'the record page');
    await page.fill(notes, [
      '1. Rinse the cold, peeled potatoes in a colander and leave them to drip. Wet potatoes help the caramel coat evenly.',
      '2. Melt the sugar in a wide frying pan over a medium heat without stirring, until it is a clear, golden-brown caramel. Do not let it go dark, or it turns bitter.',
      '3. Add the butter and stir until it melts into the caramel.',
      '4. Add the potatoes and turn them gently and often, 10-15 minutes, until every potato is glossy and evenly browned.',
      '5. Season with a pinch of salt and serve at once.'].join('\n'));
    const measured = await page.evaluate(selector => {
      const box = document.querySelector(selector);
      const sheet = document.querySelector('.record-sheet-document');
      const unset = document.querySelector('[data-null-field="field.idea.notes"]');
      const style = getComputedStyle(box);
      return { scroll: box.scrollHeight, client: box.clientHeight, resize: style.resize, overflowY: style.overflowY,
        width: box.getBoundingClientRect().width, sheet: sheet?.getBoundingClientRect().width ?? 0,
        unsetTop: unset.getBoundingClientRect().top, boxTop: box.getBoundingClientRect().top };
    }, notes);
    assert(measured.scroll <= measured.client + 1 && measured.client > 150,
      `W-242: the long text box does not grow with its text: ${JSON.stringify(measured)}.`);
    assert(measured.resize === 'none' && measured.overflowY === 'hidden', `W-242: the long text box keeps a grip or a scrollbar: ${JSON.stringify(measured)}.`);
    assert(measured.sheet > 0 && measured.width >= measured.sheet * 0.8, `W-242: the long text is not one column across the sheet: ${JSON.stringify(measured)}.`);
    assert(measured.unsetTop < measured.boxTop, `W-242: Not set is not in the field's heading row: ${JSON.stringify(measured)}.`);
    const surface = await page.evaluate(() => getComputedStyle(document.querySelector('.record-sheet-document')).backgroundColor);
    assert(surface === (theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(45, 46, 48)'), `W-242: the sheet is not on the theme's surface: ${surface}.`);
  });

  // "Save or discard your changes" names a discard the record page can be seen to offer (W-243):
  // Discard changes appears once something is typed, puts the stored text back and frees Back.
  await check('W-243 discard changes on the record page', 'idea', async () => {
    await page.click('#nav-data');
    await until(() => document.querySelector('.ag-row[row-index="0"] .record-open-cell') !== null, null, 'the first row');
    await page.click('.ag-row[row-index="0"] .record-open-cell');
    const notes = 'textarea[name="field.idea.notes"]';
    await until(selector => document.querySelector(selector) !== null, notes, 'the record page');
    const stored = await page.inputValue(notes);
    assert(!(await page.isVisible('#discard-changes')), 'W-243: Discard changes is offered before anything was typed.');
    await page.fill(notes, `${stored} and a sentence nobody wants`);
    assert(await page.isVisible('#discard-changes'), 'W-243: no visible Discard changes while the record holds unsaved typing.');
    await page.click('#nav-back');
    await until(() => /Save or discard/.test(document.querySelector('.message-slot:not([hidden])')?.textContent ?? ''), null, 'the refusal to go back');
    await page.click('#discard-changes');
    await until(([selector, text]) => document.querySelector(selector)?.value === text, [notes, stored], 'the stored text to come back');
    assert(!(await page.isVisible('#discard-changes')), 'W-243: Discard changes stays after discarding.');
    await page.click('#nav-back');
    await until(() => document.querySelector('textarea[name="field.idea.notes"]') === null, null, 'Back to leave the record page after discarding');
  });

  await check('W-243 discard changes on a Use record', 'idea', async () => {
    await openRecord();
    const control = await page.evaluate(() => {
      const found = document.querySelector('.record-inspector #record-form :is(textarea, input[type="text"])');
      return found === null ? null : `.record-inspector #record-form [name="${found.getAttribute('name')}"]`;
    });
    assert(control !== null, 'W-243: the Use record has no text control to type in.');
    const stored = await page.inputValue(control);
    assert(!(await page.isVisible('#discard-changes')), 'W-243: Discard changes is offered on a Use record before anything was typed.');
    await page.fill(control, `${stored} and more`);
    assert(await page.isVisible('#discard-changes'), 'W-243: no visible Discard changes on a Use record holding unsaved typing.');
    await page.click('#discard-changes');
    await until(([selector, text]) => document.querySelector(selector)?.value === text, [control, stored], 'the Use record to show its stored text again');
    assert(await page.locator('.record-inspector').count() === 1, 'W-243: discarding closed the Use record.');
    assert(!(await page.isVisible('#discard-changes')), 'W-243: Discard changes stays on a Use record after discarding.');
  });

  await check('W-233 deep edit and keyboard', 'idea', async () => {
    await page.evaluate(async () => {
      const { client } = await import('/src/client.ts');
      const template = client.session.records.find(record => record.entityId === 'entity.idea');
      client.session.records = Array.from({ length: 1000 }, (_, index) => ({ ...structuredClone(template),
        recordId: `lazy-${String(index).padStart(5, '0')}`, recordVersion: 1 }));
    });
    await page.click('#nav-data');
    await until(() => document.querySelector('.ag-row[row-id="lazy-00000"]') !== null, null, 'initial block');
    for (let index = 1; index < 6; index++)
      await wheelGrid(100000, index => [...document.querySelectorAll('#record-grid .ag-row[row-id]')]
        .some(row => Number(row.getAttribute('row-index')) >= index * 100), index, `loaded lazy block ${index}`);
    const deepRow = () => {
      const viewport = document.querySelector('#record-grid .ag-grid-viewport').getBoundingClientRect();
      return [...document.querySelectorAll('.ag-row[row-id]')].find(row => {
        const box = row.getBoundingClientRect();
        return /^lazy-00[5-9]/.test(row.getAttribute('row-id')) && box.top >= viewport.top && box.bottom <= viewport.bottom
          && row.querySelector('.ag-cell[col-id="field.idea.title"]')?.textContent?.length > 0;
      })?.getAttribute('row-id') ?? null;
    };
    await until(deepRow, null, 'a loaded record of the sixth block in view', 10000).catch(() => {});
    const target = await page.evaluate(deepRow);
    assert(target, 'W-233: the deep edit never reached the sixth block.');
    const cell = `.ag-row[row-id="${target}"] .ag-cell[col-id="field.idea.title"]`;
    await page.locator(cell).dblclick();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Lazy deep edit');
    await page.keyboard.press('Enter');
    await until(async id => {
      const { client } = await import('/src/client.ts');
      const record = client.session.records.find(record => record.recordId === id);
      return record?.recordVersion === 2 && record.values['field.idea.title'] === 'Lazy deep edit';
    }, target, 'the deep record and version to save');
    const continued = `lazy-${String(Number(target.slice(5)) + 1).padStart(5, '0')}`;
    await until(id => document.activeElement?.closest('.ag-row')?.getAttribute('row-id') === id, continued, 'Enter to continue on the next record');
    await page.keyboard.press('ArrowDown');
    const next = await page.evaluate(() => document.activeElement?.closest('.ag-row')?.getAttribute('row-id'));
    assert(next !== continued && next?.startsWith('lazy-'), 'W-233: ArrowDown lost the loaded record focus.');
    await page.keyboard.press('Enter');
    await page.keyboard.type('cancel me');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Tab');
    assert(await page.evaluate(() => !document.activeElement?.closest('.ag-cell')), 'W-233: Tab outside editing trapped focus in the grid.');
  });

  for (const key of ['Enter', 'Tab']) await check(`W-233 ${key} unloaded keyboard boundary`, 'idea', async () => {
    await page.evaluate(async () => {
      const { client } = await import('/src/client.ts');
      const template = client.session.records.find(record => record.entityId === 'entity.idea');
      client.session.records = Array.from({ length: 300 }, (_, index) => ({ ...structuredClone(template),
        recordId: `lazy-${String(index).padStart(5, '0')}`, recordVersion: 1 }));
      window.__lazyReleases = [];
      window.__lazyReleased = false;
      const request = client.request.bind(client);
      client.request = async (method, payload) => {
        if (method === 'data.queryRecordWindow' && payload.start === 100 && !window.__lazyReleased)
          await new Promise(resolve => window.__lazyReleases.push(resolve));
        return request(method, payload);
      };
    });
    await page.click('#nav-data');
    await until(() => document.querySelector('.ag-row[row-id="lazy-00000"]') !== null, null, 'initial keyboard block');
    if (key === 'Tab') {
      await page.click('details.grid-columns summary');
      await page.locator('[data-column-visible="field.idea.title"]').waitFor({ state: 'visible' });
      const columns = await page.locator('[data-column-visible]').evaluateAll(inputs => inputs.map(input => input.dataset.columnVisible));
      for (const column of columns) if (column !== 'field.idea.title') await page.locator(`[data-column-visible="${column}"]`).uncheck();
      await page.click('details.grid-columns summary');
      const visible = await page.locator('.ag-header-cell:not([col-id="openRecord"])').evaluateAll(cells => cells.map(cell => cell.getAttribute('col-id')));
      assert(visible.length === 1 && visible[0] === 'field.idea.title',
        `W-233: the Tab fixture did not leave exactly one data column visible: ${JSON.stringify(visible)}.`);
    }
    await wheelGrid(100000, () => window.__lazyReleases.length > 0, null, 'a blocked second block');
    await page.locator('.ag-row[row-id="lazy-00099"] .ag-cell[col-id="field.idea.title"]').dblclick();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Boundary edit');
    await page.keyboard.press(key);
    await until(async () => (await import('/src/client.ts')).client.session.records.find(record => record.recordId === 'lazy-00099')?.recordVersion === 2,
      null, 'the boundary save');
    await page.waitForTimeout(150);
    await page.evaluate(() => { window.__lazyReleased = true; window.__lazyReleases.splice(0).forEach(release => release()); });
    try { await until(() => document.activeElement?.closest('.ag-row')?.getAttribute('row-id') === 'lazy-00100', null, 'Enter focus after the missing block arrives', 8000); }
    catch (error) { throw Error(`${error.message} ${JSON.stringify(await page.evaluate(async () => ({ ...(await import('/src/view-data.ts')).dataGridReadDiagnostics(), active: document.activeElement?.outerHTML?.slice(0, 250), status: document.querySelector('[data-grid-load-status]')?.textContent })))}`); }
    assert(await page.evaluate(() => document.activeElement?.getAttribute('col-id')) === 'field.idea.title', 'W-233: continuation changed fields.');
    if (key === 'Tab') {
      await page.click('details.grid-columns summary');
      await page.click('[data-grid-reset]');
      await page.click('details.grid-columns summary');
    }
  });

  await check('W-233 column layout survives refused device storage', 'idea', async () => {
    await page.evaluate(() => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) { if (key.startsWith('nendo.studioLayout.')) throw Error('storage refused'); return set.call(this, key, value); };
    });
    await page.click('#nav-data');
    await until(() => document.querySelector('.ag-row .ag-cell[col-id="field.idea.title"]') !== null, null, 'the table before layout changes');
    await page.click('details.grid-columns summary');
    await page.locator('[data-column-visible="field.idea.title"]').uncheck();
    await page.click('details.grid-columns summary');
    const oldGrid = await page.locator('#record-grid').elementHandle();
    const oldColumns = await page.locator('details.grid-columns').elementHandle();
    await page.keyboard.press('F5');
    await until(async () => document.querySelector('#studio-content')?.getAttribute('aria-busy') === 'false', null, 'refresh after layout changes');
    await page.waitForTimeout(250);
    assert(!await oldGrid.evaluate(element => element.isConnected), 'W-233: the layout check did not rebuild the table.');
    // A queued toggle may arrive after disposal. It must not read the old grid API.
    await oldColumns.evaluate(element => element.dispatchEvent(new Event('toggle')));
    assert(await page.locator('.ag-header-cell[col-id="field.idea.title"]').count() === 0, 'W-233: a refused storage write lost the session column layout.');
    await page.click('details.grid-columns summary');
    await page.click('[data-grid-reset]');
  });

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
        // A Markdown editor can be taller than the room between the bars, and focus brings its caret
        // into view rather than the whole box: there it is the caret that must not be covered.
        const caret = element.isContentEditable ? window.getSelection()?.getRangeAt(0) : null;
        const caretBox = caret ? (caret.getClientRects()[0] ?? caret.startContainer.parentElement?.getBoundingClientRect()) : null;
        const box = caretBox ?? element.getBoundingClientRect();
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

  // The Markdown field's editor (Tiptap, 2026-10-16), typed into with the keyboard in both themes:
  // what it writes back is the Markdown typed, HTML and & stay text, the field counts as edited,
  // Alt and an arrow stay in the text, and the editor fits the record page.
  for (const theme of ['light', 'dark']) await check(`Tiptap Markdown editor ${theme}`, 'decision', async () => {
    await page.evaluate(async theme => { const { applyTheme } = await import('/src/shell.ts'); applyTheme(theme, false); }, theme);
    // A place to go Back to, so a Back taken from inside the editor would show.
    await page.click('#nav-history');
    await until(() => document.querySelector('.history-page') !== null, null, 'History');
    await page.click('#nav-use');
    await until(() => document.querySelector('.record-row > button') !== null, null, 'the records again');
    await openRecord();
    const surface = '.record-inspector .markdown-field .markdown-editor-surface[contenteditable="true"]';
    await until(selector => document.querySelector(selector) !== null, surface, 'the Markdown editor');
    // Stored HTML and an ampersand, put in through the source, then one character typed in the
    // editor: the editor writes back what was stored, plus the character.
    await page.evaluate(() => {
      const source = document.querySelector('.record-inspector .markdown-field textarea');
      source.value = 'Keep <b>tags</b> & amps';
      source.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click(surface);
    await page.keyboard.press('Control+End');
    await page.keyboard.type('.');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Control+b');
    await page.keyboard.type('Bold words');
    const pressed = await page.evaluate(() => document.querySelector('.record-inspector [data-markdown-command="bold"]')?.getAttribute('aria-pressed'));
    await page.keyboard.press('Control+b');
    await page.keyboard.type(' then plain');
    const written = await page.evaluate(() => document.querySelector('.record-inspector .markdown-field textarea').value);
    assert(written === 'Keep <b>tags</b> & amps.\n\n**Bold words** then plain',
      `The editor wrote ${JSON.stringify(written)} for 'Keep <b>tags</b> & amps.' and a bold line.`);
    assert(pressed === 'true', `Bold was ${pressed} on the toolbar while typing bold.`);
    const edited = await page.evaluate(() => document.querySelector('.record-inspector #discard-changes')?.hidden === false);
    assert(edited, 'Typing in the editor did not make the field edited: Discard changes stayed hidden.');
    // Alt and an arrow belong to the text; the page must not take them as Back. With typing
    // unsaved, a Back is refused out loud, so the page's answer is what is measured.
    const alerts = () => page.evaluate(() => [...document.querySelectorAll('[role="alert"]')].map(alert => alert.textContent.trim()).filter(Boolean).join(' | '));
    const before = await alerts();
    await page.keyboard.press('Alt+ArrowLeft');
    await page.waitForTimeout(400);
    const after = await alerts();
    assert(await page.evaluate(() => document.querySelector('.record-inspector') !== null && document.querySelector('.history-page') === null) && after === before,
      `Alt+Left in the editor was taken as Back: ${JSON.stringify(after)}.`);
    const box = await page.evaluate(selector => {
      const editor = document.querySelector(selector);
      const host = editor.closest('.markdown-editor').getBoundingClientRect();
      const page = editor.closest('.record-inspector').getBoundingClientRect();
      const toolbar = editor.closest('.markdown-editor').querySelector('.markdown-toolbar').getBoundingClientRect();
      return { host: [host.left, host.right], page: [page.left, page.right], toolbar: toolbar.height, overflow: editor.scrollWidth - editor.clientWidth };
    }, surface);
    assert(box.host[0] >= box.page[0] - 0.5 && box.host[1] <= box.page[1] + 0.5 && box.overflow <= 1 && box.toolbar > 0,
      `The editor does not fit the record page in ${theme}: ${JSON.stringify(box)}.`);
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

  // ACP slash commands (2026-10-15): / at the start of a message lists the agent's commands, Tab
  // writes one, its hint stands under the box until input follows, and Enter on a name typed out
  // in full sends it as the message.
  await check('ACP slash commands menu', 'idea', async () => {
    await launch();
    const problems = [];
    const box = page.locator('#agent-prompt');
    const menu = () => page.evaluate(() => {
      const list = document.getElementById('chat-commands');
      return { open: !list.hidden, names: [...list.querySelectorAll('[data-command] .mention-label')].map(label => label.textContent),
        controls: document.getElementById('agent-prompt').getAttribute('aria-controls'), mention: !document.getElementById('chat-mention').hidden };
    });
    const keys = await page.evaluate(() => document.getElementById('chat-keys').textContent);
    if (!keys.includes("/ runs one of the agent's commands")) problems.push(`the keys under the box do not name /: ${keys}`);
    await box.fill('/');
    await until(() => document.querySelector('#chat-commands:not([hidden]) [data-command]') !== null, null, 'the / menu');
    const all = await menu();
    if (all.names.join() !== '/review,/compact,/init') problems.push(`/ lists ${JSON.stringify(all.names)}`);
    if (all.controls !== 'chat-commands') problems.push(`the box controls ${all.controls} while the / menu is open`);
    if (all.mention) problems.push('the @ menu opened with the / menu');
    await box.fill('/re');
    await page.waitForTimeout(50);
    const narrowed = await menu();
    if (narrowed.names.join() !== '/review') problems.push(`/re lists ${JSON.stringify(narrowed.names)}`);
    await box.press('Tab');
    await page.waitForTimeout(50);
    const written = await page.evaluate(() => {
      const hint = document.getElementById('chat-command-hint');
      return { value: document.getElementById('agent-prompt').value, hint: hint.hidden ? null : hint.textContent, keys: document.getElementById('chat-keys').hidden };
    });
    if (written.value !== '/review ') problems.push(`Tab wrote ${JSON.stringify(written.value)}`);
    if (written.hint !== '/review: what to look at') problems.push(`the hint under the box is ${JSON.stringify(written.hint)}`);
    if (!written.keys) problems.push('the keys stayed beside the hint');
    if ((await menu()).open) problems.push('the / menu stayed open after a choice');
    await page.keyboard.type('the books');
    await page.waitForTimeout(50);
    if (await page.evaluate(() => !document.getElementById('chat-command-hint').hidden)) problems.push('the hint stayed once input followed');
    await box.fill('/compact');
    await page.waitForTimeout(50);
    await box.press('Enter');
    await until(() => [...document.querySelectorAll('.chat-agent')].some(item => item.textContent.includes('Ran /compact')), null, 'the command to run', 8000);
    const after = await page.evaluate(() => document.getElementById('agent-prompt').value);
    if (after !== '') problems.push(`the box still holds ${JSON.stringify(after)} after the command was sent`);
    if ((await menu()).open) problems.push('the / menu stayed open after sending');
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
  // The planner's By initiative board said "Reading the Initiatives records this board's columns
  // come from…" for good (2026-10-15): a reference board's columns were read only beside a pending
  // tile, and that board has none. This one has none either.
  await check('Reference board without tiles reads its columns', 'tree', async () => {
    await pickView('Capabilities by parent');
    try {
      await until(() => document.querySelectorAll('.record-board .board-column[data-group]').length > 0, null, 'the reference board\'s columns', 6000);
    } catch {
      const said = await page.evaluate(() => document.querySelector('.surface-empty')?.textContent ?? document.querySelector('#studio-content')?.textContent?.slice(0, 200));
      throw Error(`The board by parent drew no columns; it says ${JSON.stringify(said)}.`);
    }
    const lanes = await page.evaluate(() => [...document.querySelectorAll('.record-board .board-column[data-group] h3')].map(heading => heading.textContent.trim()));
    assert(lanes.length === 11, `The board by parent drew ${lanes.length} columns, not one per capability: ${JSON.stringify(lanes)}.`);
  });

  // "Complete completed" stayed on the planner's By initiative board after the person ran Complete
  // on a work item and chose another screen (2026-10-15). A sentence belongs to the screen it was said on.
  await check('A command outcome stays on its own screen', 'tree', async () => {
    await pickView('All capabilities');
    await page.click('[data-record-id="cap-performance"]');
    await until(() => document.querySelector('.record-inspector [data-run-command]') !== null, null, 'the record\'s command');
    await page.click('.record-inspector [data-run-command]');
    await until(() => /Activate completed/.test(document.querySelector('.message-slot')?.textContent ?? ''), null, 'the command\'s outcome');
    await pickView('Capabilities by status');
    await page.waitForTimeout(300);
    const left = await page.evaluate(() => { const slot = document.querySelector('.message-slot'); return slot === null || slot.hidden ? null : slot.textContent; });
    assert(left === null || !/Activate completed/.test(left), `The command's outcome followed the person to another screen: ${JSON.stringify(left)}.`);
  });

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

  // UX-03 and UX-04: Enter continues to the next row (W-233), keeping the field and horizontal position,
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
    const scrollAtClick = await page.evaluate(selector => document.querySelector(selector).scrollLeft, viewport);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    const scrollAtEditor = await page.evaluate(selector => document.querySelector(selector).scrollLeft, viewport);
    await page.keyboard.press('End');
    await page.keyboard.type(' (kept)');
    await page.keyboard.press('Enter');
    await until(() => /saved/.test(document.querySelector('.message-slot:not([hidden])')?.textContent ?? ''), null, 'a visible saved message', 6000);
    await page.waitForTimeout(400);
    const where = await page.evaluate(() => { const cell = document.activeElement?.closest('.ag-cell'); return cell ? `${cell.closest('.ag-row')?.getAttribute('row-index')}:${cell.getAttribute('col-id')}` : document.activeElement?.tagName ?? 'none'; });
    assert(where === `1:${target}`, `UX-03: after the save the focus is on ${where}, not the next row of the same field.`);
    const scrollAfter = await page.evaluate(selector => document.querySelector(selector).scrollLeft, viewport);
    const scrollDiagnostics = await page.evaluate(async () => (await import('/src/view-data.ts')).dataGridReadDiagnostics());
    assert(Math.abs(scrollAfter - scrollBefore) <= 2, `UX-03: the columns scrolled from ${scrollBefore} to ${scrollAfter} px. Click ${scrollAtClick}, editor ${scrollAtEditor}, target ${target}. ${JSON.stringify(scrollDiagnostics)}`);
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(150);
    const down = await page.evaluate(() => document.activeElement?.closest('.ag-row')?.getAttribute('row-index') ?? null);
    assert(down === '0', `UX-03: ArrowUp after the save went to row ${down}.`);
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

  // One bar above a Use screen. Where the address row's middle holds what the Use toolbar
  // needs (this list's pager makes it about 520 px, which a 1600 px window holds), the Use toolbar
  // shares that row (its top is the breadcrumb's, it stands between the breadcrumb and the command
  // box, and Add is pressable there), and the screen starts right under the address row; in a
  // narrow window the toolbar keeps a row of its own.
  for (const theme of ['light', 'dark']) await check(`One bar ${theme}`, 'decision', async () => {
    await page.evaluate(async theme => { const { applyTheme } = await import('/src/shell.ts'); applyTheme(theme, false); }, theme);
    await page.click('#nav-use');
    await until(() => document.querySelector('.workspace-layer[data-one-bar]') !== null && document.querySelector('.use-page > .use-toolbar #new-record') !== null, null, 'one bar', 6000)
      .catch(async error => { throw Error(`${error.message}: ${JSON.stringify(await page.evaluate(() => {
        const r = s => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.right), Math.round(b.width)]; };
        return { layer: r('.workspace-layer'), identity: r('.workspace-identity'), controls: r('.header-controls'), toolbar: r('.use-page > .use-toolbar'), useToolbarAnywhere: !!document.querySelector('.use-toolbar'),
          studio: !!document.getElementById('studio-content'), headerHidden: document.querySelector('.workspace-header')?.hidden, page: document.querySelector('#studio-content > *')?.className };
      }))}`); });
    const bar = await page.evaluate(() => {
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
      const add = document.querySelector('#new-record').getBoundingClientRect();
      const hit = document.elementFromPoint(add.left + add.width / 2, add.top + add.height / 2);
      const below = document.querySelector('.use-page > .use-layout') ?? document.querySelector('.use-page > :not(.use-toolbar)');
      return { toolbar: rect('.use-page > .use-toolbar'), identity: rect('.workspace-identity'), palette: rect('#palette-open'), header: rect('.workspace-header'),
        below: below ? Math.round(below.getBoundingClientRect().top) : null, addPressable: hit?.closest('#new-record') !== null };
    });
    assert(Math.abs(bar.toolbar.top - bar.identity.top) <= 2 && bar.toolbar.left >= bar.identity.right && bar.toolbar.right <= bar.palette.left && bar.addPressable,
      `One bar: the Use toolbar does not share the address row: ${JSON.stringify(bar)}`);
    assert(bar.below !== null && bar.below - bar.header.bottom <= 4, `One bar: a second row still stands under the address row: ${JSON.stringify(bar)}`);
    await resized(700, 800);
    await until(() => document.querySelector('.workspace-layer[data-one-bar]') === null, null, 'the toolbar back on its own row', 4000);
    const narrow = await page.evaluate(() => ({ toolbar: Math.round(document.querySelector('.use-page > .use-toolbar').getBoundingClientRect().top), header: Math.round(document.querySelector('.workspace-header').getBoundingClientRect().bottom) }));
    assert(narrow.toolbar >= narrow.header - 1, `One bar: in a narrow window the toolbar is not below the address row: ${JSON.stringify(narrow)}`);
  }, 1600, 900);

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

  // --- Studio as the person sees it: the broad review's W-225 findings -------------------------

  const appView = () => page.evaluate(() => import('/src/app-state.ts').then(module => module.state.view));
  const prepareField = async (name) => {
    await page.click('#nav-structure');
    await until(() => document.querySelector('#add-field')?.disabled === false, null, 'Structure', 6000);
    await page.click('#add-field');
    await page.locator('#add-field-form input[name="fieldName"]').fill(name);
    await page.click('#add-field-form button[type="submit"]');
    await until(() => document.querySelector('#accept-proposal')?.disabled === false, null, 'the field proposal', 6000);
  };

  // UIT-02: accepting a field added on Structure stays on Structure, and a sentence on the page says so.
  await check('UIT-02 accept stays on Structure', 'idea', async () => {
    await prepareField('Effort points');
    await page.click('#accept-proposal');
    await until(() => document.querySelector('[data-testid="proposal-review"]') === null, null, 'the review to close', 6000);
    await page.waitForTimeout(300);
    const view = await appView();
    const said = await message();
    assert(view === 'structure', `UIT-02: accepting a field added on Structure landed on ${view}, not Structure.`);
    assert(said.includes('Add Effort points field accepted.') || said.includes('accepted.'), `UIT-02: nothing on the page says the field was accepted (message slot: ${JSON.stringify(said)}).`);
  });

  // UIT-10: the review's Back discards a Studio proposal: the host no longer holds it, and the page says so.
  await check('UIT-10 Back discards the proposal', 'idea', async () => {
    await prepareField('Back test');
    const proposalId = await page.evaluate(() => import('/src/app-state.ts').then(module => module.state.proposal?.proposalId ?? null));
    assert(proposalId !== null, 'UIT-10: no proposal was prepared to go back from.');
    await page.click('#close-proposal');
    await until(() => document.querySelector('[data-testid="proposal-review"]') === null, null, 'Back to leave the review', 6000);
    await page.waitForTimeout(300);
    const held = await request('proposal.get', { proposalId });
    assert(held === null || held?.proposalId !== proposalId, `UIT-10: after Back the host still holds ${proposalId}, which nothing in Studio reaches.`);
    const said = await message();
    assert(said.includes('discarded'), `UIT-10: Back says nothing about the proposal it left (message slot: ${JSON.stringify(said)}).`);
  });

  // UIT-10 with the review's Escape: leaving by Escape rejects nothing, and the trail's Back returns to the review.
  await check('UIT-10 Escape leaves the proposal waiting', 'idea', async () => {
    await prepareField('Escape test');
    const proposalId = await page.evaluate(() => import('/src/app-state.ts').then(module => module.state.proposal?.proposalId ?? null));
    await page.evaluate(() => document.querySelector('.proposal-changes h3')?.setAttribute('tabindex', '-1'));
    await page.focus('.proposal-changes h3');
    await page.keyboard.press('Escape');
    await until(() => document.querySelector('[data-testid="proposal-review"]') === null, null, 'Escape to leave the review', 6000);
    await page.waitForTimeout(300);
    const held = await request('proposal.get', { proposalId });
    assert(held?.proposalId === proposalId, `UIT-10: Escape rejected ${proposalId}; a stray key cost the person the proposal.`);
    await page.keyboard.press('Alt+ArrowLeft');
    await until(() => document.querySelector('[data-testid="proposal-review"]') !== null, null, 'the trail’s Back to reopen the review', 6000);
    const label = await page.evaluate(() => document.querySelector('#close-proposal')?.textContent);
    assert(label === 'Discard', `UIT-10: the button that rejects the proposal reads "${label}".`);
  });

  // W-062 with UIT-02: a screen the Add view form made is accepted onto Use, where the outcome says it is open.
  await check('W-062 Add view lands on Use', 'idea', async () => {
    await page.click('#nav-surfaces');
    await until(() => document.querySelector('[data-view-add]') !== null, null, 'the Custom views panel', 6000);
    await page.click('[data-view-add]');
    await until(() => document.querySelector('#add-view-form button[type="submit"]')?.disabled === false, null, 'an Add view form ready to preview', 6000);
    await page.locator('#add-view-title').fill('Landing test');
    await page.click('#add-view-form button[type="submit"]');
    await until(() => document.querySelector('#accept-proposal')?.disabled === false, null, 'the Add view proposal', 6000);
    await page.click('#accept-proposal');
    await until(() => document.querySelector('[data-testid="proposal-review"]') === null, null, 'the review to close', 6000);
    await page.waitForTimeout(300);
    const view = await appView();
    const said = await message();
    assert(view === 'use' && said.includes('open now'), `W-062: accepting an added screen landed on ${view}, saying ${JSON.stringify(said)}.`);
  });

  // W-229 (from the W-230 review): an Add view preview the host refuses keeps the form, which the
  // person corrects and previews again; the form was cleared before the answer and did nothing.
  await check('W-229 refused Add view previews again', 'idea', async () => {
    await page.click('#nav-surfaces');
    await until(() => document.querySelector('[data-view-add]') !== null, null, 'the Custom views panel', 6000);
    await page.click('[data-view-add]');
    await until(() => document.querySelector('#add-view-form button[type="submit"]')?.disabled === false, null, 'an Add view form ready to preview', 6000);
    // The preview host validates nothing, so the first preview is answered invalid here.
    await page.evaluate(async () => {
      const { client } = await import('/src/client.ts');
      const request = client.request.bind(client);
      let refuse = true;
      client.request = async (method, payload) => {
        if (method === 'proposal.prepareChangeSet' && refuse) {
          refuse = false;
          return { proposalId: payload.proposalId, title: payload.title, state: 'invalid', diagnostics: [{ code: 'NUI450', message: 'The probe refused this view.', severity: 'error' }] };
        }
        return request(method, payload);
      };
    });
    await page.locator('#add-view-title').fill('Refused once');
    await page.click('#add-view-form button[type="submit"]');
    await until(() => (document.querySelector('.message-slot:not([hidden])')?.textContent ?? '').includes('The probe refused this view.'), null, 'the refusal', 6000);
    assert(await appView() !== 'proposal', 'W-229: a refused Add view opened a review; the check measures nothing.');
    await page.locator('#add-view-title').fill('Corrected');
    await page.click('#add-view-form button[type="submit"]');
    try {
      await until(() => document.querySelector('#accept-proposal') !== null, null, 'the corrected Add view proposal', 6000);
    } catch {
      throw Error(`W-229: after a refused preview the Add view form did nothing; the page is ${await appView()}, saying ${JSON.stringify(await message())}.`);
    }
  });

  // UIT-03: a custom view whose package the file lacks does not read Healthy on Surfaces.
  await check('UIT-03 Surfaces names a missing package', 'idea', async () => {
    await page.click('#nav-surfaces');
    await until(() => document.querySelector('.surface-card') !== null, null, 'Surfaces', 6000);
    const links = await page.evaluate(() => {
      const card = [...document.querySelectorAll('.surface-card')].find(candidate => candidate.querySelector('h3')?.textContent === 'Links');
      return card ? { chip: card.querySelector('.health-chip')?.textContent.trim(), note: card.querySelector('.surface-warning')?.textContent ?? null } : null;
    });
    assert(links !== null, 'UIT-03: the preview file has no Links card to measure.');
    assert(links.chip !== 'Healthy' && links.chip === 'Missing package' && links.note !== null, `UIT-03: the Links view, whose package the file lacks, reads ${JSON.stringify(links)}.`);
  });

  // UIT-11: a Help topic's location line has no separator hanging after it.
  await check('UIT-11 Help location has no slash', 'idea', async () => {
    await page.click('#nav-help');
    await until(() => document.querySelector('.help-article h2') !== null, null, 'Help', 6000);
    const line = await page.evaluate(() => {
      const element = document.querySelector('.help-article > p:first-child');
      return element ? { text: element.textContent, after: getComputedStyle(element, '::after').content } : null;
    });
    assert(line !== null, 'UIT-11: the Help article has no location line to measure.');
    assert(line.after === 'none' || line.after === 'normal', `UIT-11: the Help location line "${line.text}" ends in ${line.after}, a separator with nothing after it.`);
  });

  // UIT-12: Show as Markdown is drawn as an action, the colour of Make required beside it.
  await check('UIT-12 Show as Markdown is an action', 'idea', async () => {
    await page.click('#nav-structure');
    await until(() => document.querySelector('[data-presentation-field]') !== null, null, 'a Show as Markdown action', 6000);
    const colours = await page.evaluate(() => {
      const button = document.querySelector('[data-presentation-field]:not(:disabled)');
      const row = button.closest('.field-row');
      const required = row.querySelector('[data-require-field]:not(:disabled)');
      const style = getComputedStyle(button);
      return { markdown: style.color, required: getComputedStyle(required).color, align: getComputedStyle(button.parentElement).justifyItems };
    });
    assert(colours.markdown === colours.required, `UIT-12: Show as Markdown is ${colours.markdown}, its row's Make required ${colours.required}.`);
  }, 1024, 768);

  // W-232: Structure offers Label by… on a bound reference, lists the target's other active text
  // fields, and the proposal it sends is one schema.setReferenceLabel naming the chosen field.
  await check('W-232 Label by proposes the label', 'tree', async () => {
    const button = '[data-reference-label="field.capability.parent"]';
    await page.click('#nav-structure');
    await until((selector) => document.querySelector(selector) !== null, button, 'Label by… on Part of', 6000);
    const offered = await page.evaluate((selector) => {
      const element = document.querySelector(selector);
      return { disabled: element.disabled, text: element.textContent, target: element.parentElement.querySelector('.reference-target')?.textContent ?? '' };
    }, button);
    assert(!offered.disabled && offered.text === 'Label by…', `W-232: Part of offers ${JSON.stringify(offered.text)}${offered.disabled ? ', disabled' : ''}, not Label by….`);
    assert(offered.target === 'Capability by Name', `W-232: Part of says ${JSON.stringify(offered.target)}, not which record type and field it shows.`);
    await page.evaluate(async () => {
      const { client } = await import('/src/client.ts');
      const request = client.request.bind(client);
      window.__sentProposals = [];
      client.request = async (method, payload) => {
        if (method === 'proposal.prepareChangeSet') window.__sentProposals.push(JSON.parse(JSON.stringify(payload)));
        return request(method, payload);
      };
    });
    await page.click(button);
    await until(() => document.querySelector('#reference-label-form select') !== null, null, 'the Label by form', 6000);
    const options = await page.evaluate(() => [...document.querySelectorAll('#reference-label-form option')].map(option => option.value));
    assert(!options.includes('field.capability.name') && options.includes('field.capability.code') && !options.includes('field.capability.order'),
      `W-232: Label by lists ${JSON.stringify(options)}: the current label or a field that is not text is offered, or a text field is missing.`);
    await page.selectOption('#reference-label-form select', 'field.capability.code');
    await page.click('#reference-label-form button[type="submit"]');
    await until(() => document.querySelector('#accept-proposal') !== null, null, 'the label proposal', 6000);
    const sent = await page.evaluate(() => window.__sentProposals);
    const revision = await page.evaluate(() => import('/src/app-state.ts').then(module => module.state.session.manifest?.definitionRevision ?? null));
    const operations = sent.flatMap(proposal => proposal.mutations.flatMap(mutation => mutation.operations));
    assert(operations.length === 1, `W-232: Label by sent ${operations.length} operations: ${JSON.stringify(operations)}.`);
    const [operation] = operations;
    const expected = { entityId: 'entity.capability', fieldId: 'field.capability.parent', labelFieldId: 'field.capability.code', expectedDefinitionRevision: revision };
    assert(operation.operationType === 'schema.setReferenceLabel' && JSON.stringify(operation.payload) === JSON.stringify(expected),
      `W-232: Label by proposed ${operation.operationType} ${JSON.stringify(operation.payload)}, not schema.setReferenceLabel ${JSON.stringify(expected)}.`);
  });

  // W-232: Label by… is disabled, saying why, when the target has no other active text field.
  await check('W-232 Label by disabled without another text field', 'tree', async () => {
    const button = '[data-reference-label="field.capability.parent"]';
    await page.click('#nav-structure');
    await until((selector) => document.querySelector(selector) !== null, button, 'Label by… on Part of', 6000);
    // Every text field of Capability but its label, Name, retired in the page's own state, then redrawn.
    await page.evaluate(async () => {
      const { state } = await import('/src/app-state.ts');
      const { rerender } = await import('/src/shell.ts');
      for (const field of state.session.entities.find(entity => entity.entityId === 'entity.capability').fields)
        if (field.storageKind !== 'reference' && field.fieldId !== 'field.capability.name') field.retired = true;
      rerender();
    });
    await until((selector) => document.querySelector(selector)?.disabled === true, button, 'Label by… to be disabled', 4000).catch(() => {});
    const offered = await page.evaluate((selector) => {
      const element = document.querySelector(selector);
      return element === null ? null : { disabled: element.disabled, title: element.getAttribute('title') ?? '' };
    }, button);
    assert(offered !== null, 'W-232: Part of lost its Label by… when the other fields retired.');
    assert(offered.disabled, 'W-232: Label by… is offered on Part of though Capability has no other active text field to show it by.');
    assert(offered.title === 'Capability has no other active text field to show its records by.',
      `W-232: a disabled Label by… says ${JSON.stringify(offered.title)}, not why.`);
  });

  // UIT-13: the Make required form's action bar stays inside its card.
  await check('UIT-13 Make required bar inside the card', 'idea', async () => {
    await page.click('#nav-structure');
    await until(() => document.querySelector('[data-require-field]:not(:disabled)') !== null, null, 'Make required', 6000);
    await page.click('[data-require-field]:not(:disabled)');
    await until(() => document.querySelector('#preview-requirement') !== null, null, 'the Make required form', 6000);
    const fit = await page.evaluate(() => {
      const card = document.querySelector('.record-form-card').getBoundingClientRect();
      const bar = document.querySelector('.record-form-card > .form-actions').getBoundingClientRect();
      const button = document.querySelector('#preview-requirement').getBoundingClientRect();
      return { card: [Math.round(card.left), Math.round(card.right)], bar: [Math.round(bar.left), Math.round(bar.right)], inset: Math.round(card.right - button.right) };
    });
    assert(fit.bar[0] >= fit.card[0] - 0.5 && fit.bar[1] <= fit.card[1] + 0.5 && fit.inset >= 8,
      `UIT-13: the action bar spans ${fit.bar} across a card of ${fit.card}, and Preview sits ${fit.inset}px from the card's edge.`);
  }, 1024, 768);

  // UIT-14: opening Add view… brings its form into view before focusing its first field.
  await check('UIT-14 Add view form in view', 'idea', async () => {
    await page.click('#nav-surfaces');
    await until(() => document.querySelector('[data-view-add]') !== null, null, 'the Custom views panel', 6000);
    await page.focus('[data-view-add]');
    await page.keyboard.press('Enter');
    await until(() => document.activeElement?.id === 'add-view-title', null, 'focus in the Add view form', 6000);
    await page.waitForTimeout(300);
    const where = await page.evaluate(() => {
      const box = document.activeElement.getBoundingClientRect();
      const pane = document.querySelector('#studio-content').getBoundingClientRect();
      return { field: [Math.round(box.top), Math.round(box.bottom)], pane: [Math.round(pane.top), Math.round(pane.bottom)] };
    });
    assert(where.field[0] >= where.pane[0] - 0.5 && where.field[1] <= where.pane[1] + 0.5,
      `UIT-14: at 800x700 focus is on the Add view title at ${where.field}, outside the pane's visible ${where.pane}.`);
  }, 800, 700);

  // UIT-17: the File menu shows Close file without scrolling at 1440x900.
  await check('UIT-17 File menu shows Close file', 'idea', async () => {
    await page.click('#file-menu > summary');
    await page.waitForTimeout(300);
    const menu = await page.evaluate(() => {
      const panel = document.querySelector('#file-actions')?.closest('.file-menu-panel');
      const buttons = [...panel.querySelectorAll('button')].filter(button => button.offsetParent !== null);
      const last = buttons[buttons.length - 1];
      const box = panel.getBoundingClientRect();
      return { last: last.textContent.trim().slice(0, 30), lastBottom: Math.round(last.getBoundingClientRect().bottom), panelBottom: Math.round(box.bottom), scroll: panel.scrollHeight, client: panel.clientHeight };
    });
    assert(menu.scroll <= menu.client + 1 && menu.lastBottom <= menu.panelBottom, `UIT-17: at 1440x900 the File menu's last item "${menu.last}" ends at ${menu.lastBottom} below the panel's ${menu.panelBottom} (${menu.scroll}px of content in ${menu.client}).`);
  }, 1440, 900);

  // UIT-19: a calculated field is listed under Structure's Calculated group, and the field it reads
  // says why it cannot be retired. The preview file carries no calculation, so one is added to the
  // page's own session first.
  await check('UIT-19 Structure lists calculated fields', 'idea', async () => {
    await page.click('#nav-structure');
    await until(() => document.querySelector('.definition-card .field-row:not(.field-row-head)') !== null, null, 'Structure', 6000);
    const read = await page.evaluate(async () => {
      const { state } = await import('/src/app-state.ts');
      const entity = state.session.entities.find(candidate => candidate.entityId === document.querySelector('#structure-entity')?.value);
      const target = entity.fields.find(field => !field.retired);
      entity.derivedFields = [{ fieldId: 'w225.calc', displayName: 'Effort per day', calculationId: 'w225.calc', resultType: 'Decimal', resultNullable: true,
        expression: 'a_rather_long_formula_name_that_must_wrap / another_long_name_to_divide_by + yet_another_long_name', readsFieldIds: [target.fieldId] }];
      (await import('/src/shell.ts')).rerender();
      return target.fieldId;
    });
    await page.waitForTimeout(300);
    const seen = await page.evaluate((fieldId) => {
      const card = document.querySelector('.definition-card').getBoundingClientRect();
      const group = document.querySelector('[data-testid="calculated-fields"]');
      const row = document.querySelector('[data-calculated-field="w225.calc"]');
      const retire = document.querySelector(`[data-retire-field="${CSS.escape(fieldId)}"]`);
      return { group: group !== null, formula: row?.querySelector('.calculated-formula')?.textContent ?? null, count: document.querySelector('.definition-title-actions strong')?.textContent ?? '',
        right: row ? Math.round(row.getBoundingClientRect().right) : null, card: Math.round(card.right), scroll: row ? row.scrollWidth > row.clientWidth + 1 : null,
        retireDisabled: retire?.disabled ?? null, readBy: retire?.closest('.field-identity')?.querySelector('.field-read-by')?.textContent ?? null };
    }, read);
    assert(seen.group && seen.formula !== null, `UIT-19: Structure leaves out the record type's calculated field: ${JSON.stringify(seen)}.`);
    assert(seen.count.includes('1 calculated'), `UIT-19: the heading counts "${seen.count}", not the calculated field apart.`);
    assert(seen.right <= seen.card + 0.5 && seen.scroll === false, `UIT-19: the calculated row ends at ${seen.right}, past its card's ${seen.card}, or scrolls sideways.`);
    assert(seen.retireDisabled === true && seen.readBy?.includes('Effort per day reads this field'), `UIT-19: the field the calculation reads still offers Retire, or does not say why not: ${JSON.stringify(seen)}.`);
  }, 900, 800);

  // W-224. The broad review's Workbench state findings that a person meets on screen.
  const pretendPending = (extra = {}) => page.evaluate(async (extra) => {
    const { client } = await import('/src/client.ts');
    window.__w224 = { discarded: 0 };
    client.pendingMutation = () => ({ version: 1, fileIdentity: 'w224', fileSessionId: 'w224', method: 'data.setFields', payload: { idempotencyKey: 'w224' },
      state: 'pending', fileName: 'Decisions.nendo', savedAt: new Date().toISOString(), ...extra });
    client.discardPendingMutation = async () => { window.__w224.discarded += 1; client.pendingMutation = () => null; return null; };
    (await import('/src/shell.ts')).rerender();
  }, extra);

  // WCS-14 and WCS-22: an unconfirmed save is said in the status bar, which is on every screen, and
  // a save the person stopped that did not land can be discarded from its notice.
  await check('WCS-14 WCS-22 unconfirmed save pill and discard', 'decision', async () => {
    await pretendPending({ discardable: true });
    const pill = await page.evaluate(() => { const element = document.querySelector('#session-health'); return { text: element.textContent.trim(), hidden: element.hidden, shown: element.getClientRects().length > 0 }; });
    assert(pill.text.includes('Save unconfirmed') && !pill.hidden && pill.shown, `WCS-14: the status pill for an unconfirmed save is ${JSON.stringify(pill)}; it should say so where it is seen.`);
    // A chrome refresh without a render, as a view declaring its place makes, keeps it.
    const refreshed = await page.evaluate(async () => { (await import('/src/shell.ts')).refreshChrome(); const element = document.querySelector('#session-health'); return { text: element.textContent.trim(), shown: !element.hidden && element.getClientRects().length > 0 }; });
    assert(refreshed.shown && refreshed.text.includes('Save unconfirmed'), `WCS-14: after a chrome refresh the status pill is ${JSON.stringify(refreshed)}.`);
    const notice = await page.evaluate(() => ({ text: document.querySelector('#pending-save-notice')?.textContent ?? '', discard: document.querySelector('#discard-pending-save')?.disabled ?? null }));
    assert(notice.discard === false, `WCS-22: a stopped save offers no enabled Discard this unsent change: ${JSON.stringify(notice)}.`);
    assert(/Decisions\.nendo/.test(notice.text), `WCS-03: the notice does not name the file the save was made in: ${notice.text}`);
    await page.click('#discard-pending-save');
    await until(() => document.querySelector('#pending-save-notice') === null, null, 'the notice to go once discarded');
    const after = await page.evaluate(() => ({ discarded: window.__w224.discarded, said: document.querySelector('.message-slot:not([hidden])')?.textContent ?? '' }));
    assert(after.discarded === 1 && /discarded/i.test(after.said), `WCS-22: discarding left ${JSON.stringify(after)}.`);
  });

  // WCS-20: Revoke edit access stays pressable while a save is unconfirmed or in flight; it is how a
  // person ends the agent write their save is queued behind.
  await check('WCS-20 Revoke edit access while a save waits', 'idea', async () => {
    await agentPage('activity');
    await page.evaluate(async () => { const { state } = await import('/src/app-state.ts'); state.agentStatus = { ...state.agentStatus, editingOwner: 'Agent' }; });
    await pretendPending();
    const swept = await page.evaluate(() => document.querySelector('#revoke-agent')?.disabled ?? null);
    assert(swept === false, `WCS-20: with a save unconfirmed, Revoke edit access is ${swept === null ? 'missing' : 'disabled'}.`);
    // While a save is in flight it is pressable, and pressing it reaches the host.
    const pressed = await page.evaluate(async () => {
      const shell = await import('/src/shell.ts');
      const { state } = await import('/src/app-state.ts');
      const { client } = await import('/src/client.ts');
      const sent = [];
      const request = client.request.bind(client);
      client.request = (method, payload) => { sent.push(method); return request(method, payload); };
      state.actionInFlight = true;
      shell.setBusy(true);
      const disabled = document.querySelector('#revoke-agent').disabled;
      document.querySelector('#revoke-agent').click();
      await new Promise(resolve => setTimeout(resolve, 300));
      state.actionInFlight = false;
      shell.setBusy(false);
      client.request = request;
      return { disabled, sent };
    });
    assert(pressed.disabled === false, 'WCS-20: while a save is in flight, Revoke edit access is disabled.');
    assert(pressed.sent.includes('agent.revokeEditing'), `WCS-20: Revoke edit access pressed during a save sent nothing to the host: ${JSON.stringify(pressed.sent)}.`);
  });

  // WCS-15: the palette lists no record hits for text that has since changed, and Enter runs none.
  await check('WCS-15 palette drops hits for earlier text', 'decision', async () => {
    const word = await page.evaluate(() => (document.querySelector('.record-row > button')?.textContent ?? '').trim().split(/\s+/)[0].toLowerCase());
    assert(word.length >= 3, `no record title to search for (${JSON.stringify(word)}); the check measures nothing`);
    await page.keyboard.press('Control+k');
    await until(() => document.querySelector('#command-palette')?.open === true, null, 'the palette');
    await page.keyboard.type(word);
    await until(() => document.querySelector('#command-palette-list .command-record') !== null, null, 'record hits', 6000);
    await page.keyboard.type('qqxz');
    const stale = await page.evaluate(() => document.querySelectorAll('#command-palette-list .command-record').length);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    const after = await page.evaluate(async () => ({ open: document.querySelector('#command-palette')?.open === true, record: (await import('/src/app-state.ts')).state.selectedRecordId }));
    assert(stale === 0, `WCS-15: ${stale} record hit(s) for "${word}" stayed listed after the text changed.`);
    assert(after.open && after.record === null, `WCS-15: Enter on the changed text ran a hit for the earlier text: ${JSON.stringify(after)}.`);
    await page.keyboard.press('Escape');
  });

  // WCS-17: Ctrl+click on a route with unsaved typing makes no tab; the route says why it stays.
  await check('WCS-17 Ctrl+click with unsaved typing', 'decision', async () => {
    await openRecord();
    const [typed] = await textInputs();
    assert(typed, 'the record has no text field; the check measures nothing');
    await page.fill(`#record-form input[name="${typed}"]`, 'Unsaved typing');
    const before = await page.evaluate(() => document.querySelectorAll('#tab-strip .tab').length);
    await page.click('#nav-history', { modifiers: ['Control'] });
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => document.querySelectorAll('#tab-strip .tab').length);
    assert(after === before, `WCS-17: a refused Ctrl+click left ${after} tabs where there were ${before}.`);
    assert(/Save or discard/.test(await message()), `WCS-17: the refusal was not said: ${await message()}`);
  }, 1440, 900);

  // WCS-06: a window key pressed while a Data cell is being edited saves the cell before it moves.
  await check('WCS-06 window key saves the open cell', 'idea', async () => {
    await page.click('#nav-data');
    await until(() => document.querySelector('.ag-row[row-index="0"] .ag-cell') !== null, null, 'the Data grid', 8000);
    const target = await page.evaluate(() => [...document.querySelectorAll('.ag-row[row-index="0"] .ag-cell[col-id]')]
      .find(cell => !cell.classList.contains('record-open-cell') && /title|name/i.test(cell.getAttribute('col-id')))?.getAttribute('col-id') ?? null);
    assert(target !== null, 'no title cell in the grid; the check measures nothing');
    const cell = `.ag-row[row-index="0"] .ag-cell[col-id="${target}"]`;
    await page.locator(cell).click();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    await page.keyboard.press('End');
    await page.keyboard.type(' w224');
    await page.keyboard.press('Control+1');
    await until(() => document.querySelector('#nav-use')?.classList.contains('is-selected') === true, null, 'Use after Ctrl 1', 6000);
    await page.click('#nav-data');
    await until(() => document.querySelector('.ag-row[row-index="0"] .ag-cell') !== null, null, 'the Data grid again', 8000);
    const text = (await page.locator(cell).textContent()).trim();
    assert(text.endsWith('w224'), `WCS-06: after Ctrl 1 from an open cell, the cell reads ${JSON.stringify(text)}; the typing was not saved.`);
  }, 1440, 900);

  // WCS-24: Restart query outlasts a redraw, and goes once a read at a later change replaced the results.
  await check('WCS-24 Restart query survives a redraw', 'decision', async () => {
    await page.click('#nav-data');
    await until(() => document.querySelector('.ag-row[row-index="0"] .ag-cell') !== null, null, 'the Data grid', 8000);
    const kept = await page.evaluate(async () => {
      const actions = await import('/src/actions.ts');
      const { WorkbenchHostError } = await import('/src/host-types.ts');
      await actions.handlePageFailure(new WorkbenchHostError('stale-cursor', 'The file changed.'));
      (await import('/src/shell.ts')).rerender();
      return document.querySelector('.message-slot:not([hidden]) #outcome-action')?.textContent ?? null;
    });
    assert(kept === 'Restart query', `WCS-24: after a redraw the earlier-query notice offers ${JSON.stringify(kept)}, not Restart query.`);
    const later = await page.evaluate(async () => {
      const { state } = await import('/src/app-state.ts');
      state.session = { ...state.session, manifest: { ...state.session.manifest, changeSequence: state.session.manifest.changeSequence + 1 } };
      (await import('/src/shell.ts')).rerender();
      return document.querySelector('.message-slot:not([hidden])')?.textContent ?? '';
    });
    assert(!/earlier query/.test(later), `WCS-24: a redraw at a later change still says the results are from the earlier query: ${later}`);
  });

  // WST-01: a Help article keeps its place across a redraw, and reading it holds the automatic redraws.
  await check('WST-01 Help article keeps its place', 'idea', async () => {
    await page.click('#nav-help');
    await until(() => document.querySelector('.help-article h2') !== null, null, 'Help', 6000);
    const topic = await page.evaluate(() => {
      for (const button of [...document.querySelectorAll('.help-topics button')]) {
        document.querySelector(`.help-topics button[data-help-topic="${CSS.escape(button.dataset.helpTopic ?? '')}"]`)?.click();
        const article = document.querySelector('.help-article');
        if (article !== null && article.scrollHeight > article.clientHeight + 400) return button.textContent.trim();
      }
      return null;
    });
    await page.waitForTimeout(300);
    assert(topic !== null, 'no Help article is long enough to scroll; the check measures nothing');
    await quiet();
    await page.evaluate(() => { document.querySelector('.help-article').scrollTop = 300; });
    await page.waitForTimeout(100);
    const held = await shell(() => import('/src/shell.ts').then(module => module.interactionInProgress()));
    assert(held === true, 'WST-01: scrolling a Help article is not seen as reading, so an automatic redraw goes ahead under it.');
    const top = await page.evaluate(async () => { (await import('/src/shell.ts')).rerender(); return document.querySelector('.help-article').scrollTop; });
    assert(Math.abs(top - 300) <= 2, `WST-01: a redraw moved the Help article from 300 px to ${top} px.`);
  }, 1200, 700);

  // WCS-08: F5 and Ctrl R are Refresh view, not a reload; with unsaved typing they refuse and keep it.
  await check('WCS-08 F5 is Refresh view', 'decision', async () => {
    await page.evaluate(() => { window.__w224Marker = true; window.__w224Keys = []; window.addEventListener('keydown', event => { if (event.key === 'F5' || event.key === 'r') window.__w224Keys.push(event.defaultPrevented); }); });
    await openRecord();
    const [typed] = await textInputs();
    assert(typed, 'the record has no text field; the check measures nothing');
    await page.fill(`#record-form input[name="${typed}"]`, 'Kept through F5');
    await page.keyboard.press('F5');
    await page.waitForTimeout(300);
    await page.keyboard.press('Control+r');
    await page.waitForTimeout(300);
    const after = await page.evaluate(name => ({ marker: window.__w224Marker === true, keys: window.__w224Keys, value: document.querySelector(`#record-form input[name="${name}"]`)?.value ?? null }), typed);
    assert(after.marker && after.keys.length === 2 && after.keys.every(Boolean), `WCS-08: F5 or Ctrl R was left to the browser, which reloads the window: ${JSON.stringify(after)}.`);
    assert(after.value === 'Kept through F5', `WCS-08: the typing did not survive F5: ${JSON.stringify(after.value)}.`);
    assert(/refreshing the view/.test(await message()), `WCS-08: F5 with unsaved typing said ${JSON.stringify(await message())}.`);
  });

  // WCS-08 with WCS-06: F5 while a Data cell is being edited saves the cell before the refresh redraws.
  await check('WCS-08 F5 saves the open cell', 'idea', async () => {
    await page.click('#nav-data');
    await until(() => document.querySelector('.ag-row[row-index="0"] .ag-cell') !== null, null, 'the Data grid', 8000);
    const target = await page.evaluate(() => [...document.querySelectorAll('.ag-row[row-index="0"] .ag-cell[col-id]')]
      .find(cell => !cell.classList.contains('record-open-cell') && /title|name/i.test(cell.getAttribute('col-id')))?.getAttribute('col-id') ?? null);
    assert(target !== null, 'no title cell in the grid; the check measures nothing');
    const cell = `.ag-row[row-index="0"] .ag-cell[col-id="${target}"]`;
    await page.locator(cell).click();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    await page.keyboard.press('End');
    await page.keyboard.type(' f5');
    await page.keyboard.press('F5');
    await page.waitForTimeout(1500);
    await until(() => document.querySelector('.ag-row[row-index="0"] .ag-cell') !== null && document.querySelector('.ag-cell input, .ag-cell textarea') === null, null, 'the grid after the refresh', 6000);
    const text = (await page.locator(cell).textContent()).trim();
    assert(text.endsWith('f5'), `WCS-08: after F5 from an open cell, the cell reads ${JSON.stringify(text)}; the typing was not saved.`);
  }, 1440, 900);

  // WCS-16: a navigation place, Help and Agent pressed while an action runs are made when it ends.
  const pressDuringAction = (selector) => page.evaluate(async (selector) => {
    const { state } = await import('/src/app-state.ts');
    const shell = await import('/src/shell.ts');
    state.actionInFlight = true;
    document.querySelector(selector).click();
    await new Promise(resolve => setTimeout(resolve, 200));
    const during = state.view;
    state.actionInFlight = false;
    shell.setBusy(false);
    return during;
  }, selector);
  for (const [name, selector, view] of [['a navigation place', '.nav-place:not(.is-selected)', null], ['Help', '#nav-help', 'help'], ['Agent', '#nav-agent', 'agent']]) {
    await check(`WCS-16 ${name} pressed during an action`, 'idea', async () => {
      await page.click('#nav-data');
      await until(() => document.querySelector('.ag-row[row-index="0"] .ag-cell') !== null, null, 'the Data grid', 8000);
      assert(await page.evaluate(selector => document.querySelector(selector) !== null, selector), `no ${name} to press; the check measures nothing`);
      const during = await pressDuringAction(selector);
      assert(during === 'data', `WCS-16: ${name} moved while an action ran (${during}).`);
      await page.waitForTimeout(800);
      const after = await page.evaluate(async () => (await import('/src/app-state.ts')).state.view);
      assert(view === null ? after === 'use' : after === view, `WCS-16: ${name} pressed during an action was dropped; the view is ${after}.`);
    });
  }

  // WCS-03: a save made under another file name offers both ways out, and editing is not locked for good.
  await check('WCS-03 save made in another file', 'decision', async () => {
    await pretendPending({ fileName: 'Decisions (original).nendo', madeElsewhere: true });
    const offered = await page.evaluate(() => ({ send: document.querySelector('#send-pending-here')?.disabled ?? null, discard: document.querySelector('#discard-pending-save')?.disabled ?? null,
      retry: document.querySelector('#retry-pending-save') !== null, text: document.querySelector('#pending-save-notice')?.textContent ?? '' }));
    assert(offered.send === false && offered.discard === false, `WCS-03: a save made in another file offers no way out: ${JSON.stringify(offered)}.`);
    assert(!offered.retry, 'WCS-03: the notice still offers Check or retry, which refuses in a file of another name.');
  });

  // --- W-230: Studio flows and proposal review (FIXES.md WSP-01 to WSP-25) ----------------------

  // A write through the page's own write path, so the session and its reads follow it.
  const studioWrite = (method, payload) => page.evaluate(async ([method, payload]) => {
    const { runMutation } = await import('/src/actions.ts');
    return runMutation(method, { idempotencyKey: `w230-${crypto.randomUUID()}`, ...payload }, 'Saved.');
  }, [method, payload]);
  const ideaRecords = () => page.evaluate(() => import('/src/app-state.ts').then(({ state }) =>
    state.session.records.filter(record => record.entityId === 'entity.idea').map(record => ({ recordId: record.recordId, recordVersion: record.recordVersion }))));

  // WSP-02: Make required on a choice field starts each record on a placeholder, and an untouched preview is refused.
  await check('WSP-02 Make required asks for every choice', 'idea', async () => {
    const [first] = await ideaRecords();
    assert(first !== undefined, 'WSP-02: the preview file has no record to empty.');
    assert(await studioWrite('data.setField', { entityId: 'entity.idea', recordId: first.recordId, fieldId: 'field.idea.energy', expectedRecordVersion: first.recordVersion, value: null }) === 'saved',
      'WSP-02: emptying a record’s Energy did not save.');
    await page.click('#nav-structure');
    await until(() => document.querySelector('[data-require-field="field.idea.energy"]:not(:disabled)') !== null, null, 'Make Energy required', 6000);
    await page.click('[data-require-field="field.idea.energy"]');
    await until(() => document.querySelector('#preview-requirement') !== null, null, 'the Make required form', 6000);
    const selects = await page.evaluate(() => [...document.querySelectorAll('.backfill-record select')].map(select => ({ value: select.value, disabled: select.selectedOptions[0]?.disabled ?? null })));
    assert(selects.length > 0, 'WSP-02: the Make required form lists no record to fill; the check measures nothing.');
    assert(selects.every(select => select.value === '' && select.disabled === true), `WSP-02: the form starts each record on a choice nobody made: ${JSON.stringify(selects)}.`);
    await page.click('#preview-requirement');
    await page.waitForTimeout(400);
    const view = await appView();
    const said = await message();
    assert(view !== 'proposal' && said.includes('Fill every missing value before previewing.'), `WSP-02: an untouched form previewed (${view}, ${JSON.stringify(said)}).`);
  });

  // WSP-01: a search typed into a record's picker and abandoned does not count as clearing that record.
  await check('WSP-01 abandoned search maps nothing', 'idea', async () => {
    await page.click('#nav-structure');
    await until(() => document.querySelector('#add-field')?.disabled === false, null, 'Structure', 6000);
    await page.evaluate(async () => {
      const { state } = await import('/src/app-state.ts');
      const { renderReferenceConversion } = await import('/src/view-structure.ts');
      const entity = state.session.entities.find(candidate => candidate.entityId === 'entity.idea');
      const legacy = { fieldId: 'field.idea.legacyOwner', displayName: 'Legacy owner', storageKind: 'reference', required: false, retired: false, presentation: null, options: [], choices: [], reference: null };
      renderReferenceConversion({ ...entity, fields: [...entity.fields, legacy] }, 'field.idea.legacyOwner');
    });
    await page.selectOption('#conversion-target', 'entity.idea');
    await page.selectOption('#conversion-label', 'field.idea.title');
    await page.click('#conversion-target-form button[type="submit"]');
    await until(() => document.querySelectorAll('.conversion-record').length > 1, null, 'the records to map', 6000);
    const first = page.locator('.conversion-record').first();
    await first.locator('.reference-choose').click();
    await first.locator('.reference-search').fill('nothing matches this');
    await first.locator('.reference-find').click();
    await page.waitForTimeout(200);
    await first.locator('.reference-cancel').click();
    const others = await page.locator('.conversion-record').count();
    for (let index = 1; index < others; index++) await page.locator('.conversion-record').nth(index).locator('.reference-clear').click();
    await page.click('#preview-conversion');
    await page.waitForTimeout(400);
    const view = await appView();
    const said = await message();
    assert(view !== 'proposal' && said.includes('Choose a target or explicitly clear every record before previewing.'),
      `WSP-01: a record whose search was typed and abandoned was converted as cleared (${view}, ${JSON.stringify(said)}).`);
  });

  // WSP-16: View changes stays open across a redraw, and opens though the file moved since History was read.
  await check('WSP-16 View changes survives a redraw', 'idea', async () => {
    const records = (await ideaRecords()).slice(0, 2);
    for (const [index, record] of records.entries())
      assert(await studioWrite('data.setField', { entityId: 'entity.idea', recordId: record.recordId, fieldId: 'field.idea.nextAction', expectedRecordVersion: record.recordVersion, value: `Step ${index}` }) === 'saved',
        'WSP-16: a seed edit did not save.');
    await page.click('#nav-history');
    await until(() => document.querySelectorAll('[data-history-detail]').length > 1, null, 'two History entries', 6000);
    await page.click('[data-history-detail] >> nth=0');
    await until(() => document.querySelector('[data-operation-detail] .operation-details') !== null, null, 'the first entry’s changes', 6000);
    await page.evaluate(() => import('/src/shell.ts').then(shell => shell.rerender()));
    const kept = await page.evaluate(() => document.querySelectorAll('[data-operation-detail] .operation-details').length);
    assert(kept === 1, `WSP-16: a redraw closed the changes the person opened (${kept} open).`);
    // The file moved and the page has not caught up: the revision's operations are the same.
    await page.evaluate(() => import('/src/app-state.ts').then(({ state }) => { state.session.manifest.changeSequence -= 1; }));
    await page.click('[data-history-detail] >> nth=1');
    await page.waitForTimeout(500);
    const opened = await page.evaluate(() => document.querySelectorAll('[data-operation-detail] .operation-details').length);
    const said = await message();
    assert(opened === 2 && !said.includes('The file changed'), `WSP-16: View changes was refused while the file moved (${opened} open, ${JSON.stringify(said)}).`);
  });

  // WSP-18: a header rename the host refuses puts the header back, and says why.
  await check('WSP-18 refused header rename puts the header back', 'idea', async () => {
    await page.click('#nav-data');
    await until(() => document.querySelector('.studio-header-rename') !== null, null, 'a column header with Rename', 8000);
    await page.evaluate(async () => {
      const { client } = await import('/src/client.ts');
      const { WorkbenchHostError } = await import('/src/host.ts');
      window.__w230Request = client.request.bind(client);
      client.request = (method, payload) => method === 'proposal.prepareChangeSet'
        ? Promise.reject(new WorkbenchHostError('host-unavailable', 'The host did not answer.')) : window.__w230Request(method, payload);
      document.querySelector('.studio-header-rename').click();
    });
    await until(() => document.querySelector('.studio-header-input') !== null, null, 'the rename box', 4000);
    await page.locator('.studio-header-input').fill('Renamed column');
    await page.locator('.studio-header-input').press('Enter');
    await page.waitForTimeout(500);
    const after = await page.evaluate(async () => {
      const { client } = await import('/src/client.ts');
      client.request = window.__w230Request;
      return { box: document.querySelector('.studio-header-input') !== null, said: document.querySelector('.message-slot:not([hidden])')?.textContent ?? '' };
    });
    assert(!after.box && after.said.includes('The host did not answer.'), `WSP-18: after a refused rename the header is ${after.box ? 'still a box Escape no longer puts back' : 'back'}, saying ${JSON.stringify(after.said)}.`);
  });

  // W-229: custom views that run. The preview host serves no view origin, so the page is told it
  // is Nendo Desktop and the Board glance package's origin is answered here with a small view of
  // our own that speaks the port protocol directly: a real cross-origin frame, connected by the
  // page's own broker, whose requests and pings the checks drive.
  const viewOrigin = 'https://org-example-board-glance-5d1c7e9a20.example';
  const viewPage = `<!doctype html><meta charset="utf-8"><title>Probe view</title><body><input id="probe-field" aria-label="Probe field"><script>
window.__answers = {}; window.__events = []; window.__hang = false; window.__connected = false;
let port = null; let next = 1;
addEventListener('message', (event) => {
  if (event.source !== parent || !event.data || event.data.nendo !== 'connect') return;
  port = event.ports[0];
  window.__context = event.data.context;
  port.onmessage = (message) => {
    const data = message.data;
    if (data.t === 'res') window.__answers[data.id] = data;
    else if (data.t === 'ping') { if (!window.__hang) port.postMessage({ t: 'pong', id: data.id }); }
    else window.__events.push(data);
  };
  window.__connected = true;
});
parent.postMessage({ nendo: 'hello', apiVersion: 1 }, '*');
window.__send = (m, p) => { const id = next++; port.postMessage({ t: 'req', id, m, p }); return id; };
window.__ask = (m, p, wait = 3000) => new Promise((resolve) => {
  const id = window.__send(m, p); const until = Date.now() + wait;
  const poll = () => window.__answers[id] ? resolve(window.__answers[id]) : Date.now() > until ? resolve(null) : setTimeout(poll, 20);
  poll();
});
</script>`;
  let viewRouted = false;
  const runViews = async () => {
    if (!viewRouted) {
      await page.route(`${viewOrigin}/**`, route => route.fulfill({ status: 200, contentType: 'text/html', body: viewPage }));
      viewRouted = true;
    }
    await page.evaluate(async () => {
      const { client } = await import('/src/client.ts');
      Object.defineProperty(client, 'mode', { value: 'desktop', configurable: true, writable: true });
    });
  };
  const rerenderPage = () => page.evaluate(async () => (await import('/src/shell.ts')).rerender());
  /** The frame of the probe view under `selector` once it is connected. */
  const viewFrame = async (selector) => {
    await until(selector => document.querySelector(`${selector} iframe.view-frame`) !== null, selector, `a view frame in ${selector}`, 6000);
    const handle = await page.$(`${selector} iframe.view-frame`);
    const frame = await handle.contentFrame();
    await frame.waitForFunction(() => window.__connected === true, null, { timeout: 6000 }).catch(() => { throw Error(`The probe view in ${selector} never connected.`); });
    return frame;
  };
  const glanceScreen = async () => {
    await page.evaluate(async () => {
      const { state } = await import('/src/app-state.ts');
      const root = state.session.uiNodes.find(node => node.kind === 'extensionRecordsSurface' && node.parentNodeId === null);
      await (await import('/src/extension-ui.ts')).openScreenFromView(root.nodeId);
    });
    return viewFrame('.studio-content');
  };

  // WXS-04: the switch that turns views off, pressed while a view's own move of the page runs, is
  // made when the move ends; it was dropped.
  await check('WXS-04 view switch during a view’s move', 'idea', async () => {
    const run = await page.evaluate(async () => {
      const { state } = await import('/src/app-state.ts');
      const { openScreenFromView } = await import('/src/extension-ui.ts');
      const { setViewSwitch } = await import('/src/view-packages.ts');
      const root = state.session.uiNodes.find(node => node.kind === 'extensionRecordsSurface' && node.parentNodeId === null);
      // The press lands while the view's move holds the action, before anything is awaited.
      const moving = openScreenFromView(root.nodeId, false);
      const busy = state.actionInFlight;
      const pressed = setViewSwitch('device', false);
      await moving;
      await pressed;
      for (let wait = 0; wait < 60 && state.session.extensions?.run !== false; wait += 1) await new Promise(resolve => setTimeout(resolve, 50));
      return { busy, run: state.session.extensions?.run ?? null };
    });
    assert(run.busy, 'WXS-04: the view’s move held no action, so the check measures nothing.');
    assert(run.run === false, `WXS-04: turning views off while a view’s move ran was dropped; views still run (${JSON.stringify(run)}).`);
  });

  // WXS-04 again: the move ends in failure, which says an alert before the held press is made; an
  // ordinary held move is dropped then, and the switch was one.
  await check('WXS-04 view switch during a view’s failing move', 'idea', async () => {
    const run = await page.evaluate(async () => {
      const { state } = await import('/src/app-state.ts');
      const { openRecordFromView } = await import('/src/extension-ui.ts');
      const { setViewSwitch } = await import('/src/view-packages.ts');
      const entityId = state.session.entities.find(entity => entity.retired !== true).entityId;
      const moving = openRecordFromView(entityId, 'record-that-is-not-in-the-file', false);
      const busy = state.actionInFlight;
      const pressed = setViewSwitch('device', false);
      const opened = await moving;
      // Said before the held press is made, as the old queue read it.
      const alert = state.lastOutcome?.tone ?? null;
      await pressed;
      for (let wait = 0; wait < 60 && state.session.extensions?.run !== false; wait += 1) await new Promise(resolve => setTimeout(resolve, 50));
      return { busy, opened: opened.opened, alert, run: state.session.extensions?.run ?? null };
    });
    assert(run.busy && run.opened === false && run.alert === 'alert', `WXS-04: the view’s move did not fail with an alert while it held the action, so the check measures nothing (${JSON.stringify(run)}).`);
    assert(run.run === false, `WXS-04: turning views off during a view’s failing move was dropped; views still run (${JSON.stringify(run)}).`);
  });

  // WXS-17: views come on while the page is held by unsaved typing; the panel's frame starts in a
  // stage that no longer holds the 'Custom views are off' notice.
  await check('WXS-17 off notice gone when views come on held', 'idea', async () => {
    await page.evaluate(async () => {
      const { client } = await import('/src/client.ts');
      const { state } = await import('/src/app-state.ts');
      const result = await client.request('extension.settings.set', { scope: 'device', enabled: false });
      state.session = 'session' in result ? result.session : result;
      (await import('/src/shell.ts')).rerender();
    });
    await openRecord();
    await until(() => document.querySelector('.record-inspector [data-view-notice="off"]') !== null, null, 'the panel’s off notice');
    const field = page.locator('.record-inspector input[type="text"], .record-inspector textarea').first();
    await field.click();
    await field.pressSequentially(' held');
    await runViews();
    const after = await page.evaluate(async () => {
      const { client } = await import('/src/client.ts');
      const { holdingThePage } = await import('/src/draft-guard.ts');
      await client.request('extension.settings.set', { scope: 'device', enabled: true });
      const held = holdingThePage();
      await (await import('/src/extension-settings.ts')).refreshExtensionSettings();
      const stage = document.querySelector('.record-inspector [data-view-mount] [data-view-stage]');
      return { held, notice: stage?.querySelector('[data-view-notice]')?.textContent ?? null, isNotice: stage?.classList.contains('is-notice') ?? null };
    });
    assert(after.held, 'WXS-17: the page was not held, so the check measures nothing.');
    await until(() => document.querySelector('.record-inspector [data-view-mount] [data-view-stage] iframe.view-frame') !== null, null, 'the panel’s frame to start', 6000);
    const started = await page.evaluate(() => {
      const stage = document.querySelector('.record-inspector [data-view-mount] [data-view-stage]');
      return { notice: stage?.querySelector('[data-view-notice]')?.textContent ?? null, isNotice: stage?.classList.contains('is-notice') ?? null };
    });
    assert(after.notice === null && after.isNotice === false && started.notice === null && started.isNotice === false,
      `WXS-17: the panel started its view beside the stale notice: ${JSON.stringify({ after, started })}.`);
  });

  // WXS-06: a view that asks to open a record on its own, while the person types in a record
  // form, is refused without taking the person's focus.
  await check('WXS-06 a view’s move keeps the person’s field', 'idea', async () => {
    await runViews();
    await rerenderPage();
    await openRecord();
    const frame = await viewFrame('.record-inspector');
    const field = page.locator('.record-inspector input[type="text"], .record-inspector textarea').first();
    await field.click();
    await field.pressSequentially(' typing');
    const before = await focus();
    const target = await frame.evaluate(() => ({ entityId: window.__context.entityId, recordId: window.__context.recordId }));
    const answer = await frame.evaluate(target => window.__ask('ui.openRecord', target), target);
    const after = await focus();
    assert(answer?.ok === false && answer.e.code === 'not-allowed', `WXS-06: the view’s open over unsaved typing was answered ${JSON.stringify(answer)}.`);
    assert(after === before, `WXS-06: the refusal moved focus from ${before} to ${after}.`);
  });

  // WXS-07: a view held while the person reviews its own proposal neither draws a menu over the
  // review nor moves the person out of it.
  await check('WXS-07 a parked view stays out of the review', 'idea', async () => {
    await runViews();
    const frame = await glanceScreen();
    // A command Nendo just sent the view lets a menu answer it without the frame's focus (WXS-08).
    // The view declares Add first; a redraw that lands between the two can take the declaration
    // with it, so it is declared again, at most three times, before the check gives up.
    let added = false;
    let declared = null;
    for (let attempt = 0; attempt < 3 && !added; attempt += 1) {
      await frame.waitForFunction(() => window.__connected === true, null, { timeout: 6000 }).catch(() => undefined);
      declared = await frame.evaluate(() => window.__ask('ui.setToolbar', { items: [], add: 'probe-add' }));
      added = declared?.ok === true && await page.evaluate(async () => { const command = (await import('/src/view-frames.ts')).viewAddCommand(); command?.(); return command !== null; });
    }
    assert(added, `WXS-07: the probe view’s Add was not taken, so the check measures nothing (toolbar answer ${JSON.stringify(declared)}).`);
    const prepared = await frame.evaluate(() => window.__ask('proposals.prepare', { title: 'Probe look', operations: [{ operationType: 'application.setLook', payload: { tone: null, letter: 'Q' } }] }));
    assert(prepared?.ok === true && prepared.r.opened === true, `WXS-07: the probe view’s proposal did not open: ${JSON.stringify(prepared)}.`);
    await until(() => document.querySelector('[data-testid="proposal-review"]') !== null, null, 'the review of the view’s proposal');
    const menuId = await frame.evaluate(() => window.__send('ui.showMenu', { items: [{ id: 'probe', label: 'Probe item' }], x: 4, y: 4 }));
    // Settled when the view hears its answer, or when a menu is drawn, which waits for the person.
    let menu = false;
    let menuAnswer = null;
    for (let wait = 0; wait < 60 && menuAnswer === null && !menu; wait += 1) {
      menuAnswer = await frame.evaluate(id => window.__answers[id] ?? null, menuId);
      menu = await page.evaluate(() => document.querySelector('.view-menu') !== null);
      if (menuAnswer === null && !menu) await page.waitForTimeout(50);
    }
    if (menu) await page.keyboard.press('Escape');
    const moved = await frame.evaluate(async () => {
      const id = window.__send('ui.openScreen', { surfaceId: window.__context.viewId });
      for (let wait = 0; wait < 100 && !window.__answers[id]; wait += 1) await new Promise(resolve => setTimeout(resolve, 20));
      return window.__answers[id] ?? null;
    });
    const view = await page.evaluate(async () => (await import('/src/app-state.ts')).state.view);
    assert(!menu && menuAnswer?.ok === true && menuAnswer.r === null, `WXS-07: a parked view drew its menu over the review (menu ${menu}, answer ${JSON.stringify(menuAnswer)}).`);
    assert(moved?.ok === false && moved.e.code === 'not-allowed' && view === 'proposal', `WXS-07: a parked view’s move was answered ${JSON.stringify(moved)} and the page is ${view}.`);
  });

  // WXS-05: a view that hangs while it has focus hands the keyboard to the overlay's Stop.
  await check('WXS-05 a hung view’s overlay takes focus', 'idea', async () => {
    await runViews();
    const frame = await glanceScreen();
    await page.evaluate(() => document.querySelector('.studio-content iframe.view-frame').focus());
    const before = await focus();
    assert(before.startsWith('iframe'), `WXS-05: the view’s frame did not take focus (${before}), so the check measures nothing.`);
    const hungAt = Date.now();
    await frame.evaluate(() => { window.__hang = true; });
    try {
      await until(() => document.querySelector('[data-view-overlay="unresponsive"]') !== null, null, 'the not-responding overlay', 30000);
    } catch (error) {
      const seen = await page.evaluate(() => ({ state: document.querySelector('.studio-content [data-view-mount]')?.dataset.viewState ?? null, focus: document.activeElement?.tagName ?? null }));
      throw Error(`${error.message} After ${Date.now() - hungAt} ms the view reads ${JSON.stringify(seen)}.`);
    }
    const after = await page.evaluate(() => document.activeElement?.hasAttribute('data-view-stop') ?? false);
    assert(after, `WXS-05: the not-responding overlay left focus on ${await focus()}, where no key reaches Stop.`);
  });

  // WST-10: a window in dark mode is dark before the bundle has run. Last, since it changes the colour scheme.
  await check('WST-10 dark window paints dark first', 'decision', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.evaluate(() => { try { localStorage.removeItem('nendo.appearance'); } catch { /* none kept */ } });
    await page.addInitScript(() => {
      document.addEventListener('readystatechange', () => {
        if (document.readyState === 'interactive' && window.__w224FirstTheme === undefined)
          window.__w224FirstTheme = { theme: document.documentElement.dataset.theme ?? null, ran: document.querySelector('#studio-content')?.getAttribute('aria-busy') ?? null };
      });
    });
    await open('decision');
    const first = await page.evaluate(() => window.__w224FirstTheme ?? null);
    await page.emulateMedia({ colorScheme: null });
    assert(first !== null && first.theme === 'dark', `WST-10: in dark mode the page's first frame is themed ${JSON.stringify(first)}, before the module had run.`);
  });

  assert(checks.length + failures.length > 0, 'No browser checks matched the requested filter.');
  return { complete: failures.length === 0, checks, errors, failure: failures.join(' || ') };
  })(); } catch (error) {
    return { complete: false, checks, errors, failure: [...failures, String(error?.message ?? error)].join(' || ') };
  }
}
