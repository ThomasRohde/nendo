async page => {
  // The browser host (ADR-0036), measured where the person meets it: one page opened from disk,
  // the real Engine in it. tools/Review-BrowserHost.ps1 fills the placeholders and runs this with
  // playwright-cli. A failure names the last check that passed, so a timeout says where it happened.
  const checks = [];
  const errors = [];
  const requests = [];
  try { return await (async () => {
  const assert = (ok, message) => { if (!ok) throw Error(message); };
  const watch = (target) => {
    target.on('pageerror', error => errors.push(error.message));
    // nendo-media: is the page's own picture address: the browser tries it and fails on the
    // scheme without any network, then the page shows the picture from the file.
    target.on('request', request => { const url = request.url(); if (!/^(file|data|blob|about|nendo-media):/.test(url)) requests.push(url); });
    target.on('dialog', dialog => { errors.push(`Browser dialog (${dialog.type()}): ${dialog.message()}`); dialog.dismiss().catch(() => {}); });
  };
  watch(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  const ready = async (target) => {
    await target.goto('__PAGE_URL__');
    // The host's version arrives with its first snapshot, which gives the page its file session.
    await target.waitForFunction(() => /Nendo \d+\.\d+/.test(document.body.innerText), null, { timeout: 60000 });
  };
  // Opening by drop rather than through the file chooser, which playwright-cli treats as a modal.
  const drop = async (target, base64, name) => {
    await target.evaluate(({ base64, name }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], name));
      document.dispatchEvent(new DragEvent('dragenter', { dataTransfer: transfer, bubbles: true, cancelable: true }));
      document.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    }, { base64, name });
    await target.waitForSelector('[data-rail-place]', { timeout: 60000 });
  };
  const clearFlagState = () => page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Clear review flag');
    return button === undefined ? 'missing' : button.disabled ? 'disabled' : 'enabled';
  });

  // Station: its automatic action runs in the page once the person approves it.
  await ready(page);
  await drop(page, '__STATION_BASE64__', 'Nendo Station.nendo');
  assert(await page.isHidden('#nav-agent'), 'The Agent page is offered in a host with no agents.');
  checks.push('Station opens from a dropped file');
  // The file's own picture is read from the file, never fetched.
  await page.waitForFunction(() => document.querySelector('img[src^="blob:"]') !== null, null, { timeout: 15000 })
    .catch(() => { throw Error('Station\'s picture was not shown from the file.'); });
  checks.push('the file\'s picture is shown from the page');
  await page.waitForFunction(() => document.body.innerText.includes('Approval needed'), null, { timeout: 30000 });
  await page.click('#nav-health');
  await page.click('#approve-behaviour');
  await page.waitForFunction(() => !document.body.innerText.includes('Approval needed'), null, { timeout: 30000 });
  checks.push('automatic actions approved');
  await page.click('[data-rail-place="type:system"]');
  await page.click('[data-record-id="system.co2"]');
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Clear review flag'), null, { timeout: 15000 });
  assert(await clearFlagState() === 'enabled', `CO2 Scrubbing's review flag is not up to start with: ${await clearFlagState()}.`);
  await page.click('text=Clear review flag');
  await page.waitForFunction(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Clear review flag')?.disabled === true, null, { timeout: 15000 });
  checks.push('a command ran');
  await page.click('[data-rail-place="type:incident"]');
  await page.click('[data-record-id="incident.001"]');
  await page.selectOption('select[name="incidentSeverity"]', { label: 'Elevated' });
  await page.click('text=Save changes');
  await page.waitForFunction(() => !document.body.innerText.includes('Saving'), null, { timeout: 15000 });
  await page.waitForTimeout(1000);
  await page.click('[data-rail-place="type:system"]');
  await page.click('[data-record-id="system.co2"]');
  await page.waitForFunction(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Clear review flag')?.disabled === false, null, { timeout: 15000 })
    .catch(() => { throw Error('Editing the incident did not raise its system\'s review flag: the automatic action did not run in the page.'); });
  checks.push('an incident edit ran the automatic action');
  // The approval is device state, kept in the page's IndexedDB: another visit does not ask again.
  await ready(page);
  await drop(page, '__STATION_BASE64__', 'Nendo Station.nendo');
  await page.waitForTimeout(1500);
  assert(!(await page.evaluate(() => document.body.innerText.includes('Approval needed'))), 'The approval did not outlast the visit.');
  checks.push('the approval is kept across visits');

  // Deck, opened through the File System Access picker so the page can write it back in place. The
  // picker is the browser's own dialog, which no lane can drive; a handle stands in for it here and
  // records what the page writes.
  await page.addInitScript((base64) => {
    const saved = { writes: 0, bytes: 0 };
    window.__nendoSaved = saved;
    window.showOpenFilePicker = async () => [{
      kind: 'file', name: 'Deck.nendo',
      requestPermission: async () => 'granted',
      getFile: async () => new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], 'Deck.nendo'),
      createWritable: async () => ({
        write: async (data) => { saved.bytes = data.byteLength ?? data.size ?? 0; },
        close: async () => { saved.writes += 1; },
      }),
    }];
  }, '__DECK_BASE64__');
  await ready(page);
  await page.click('#file-menu summary');
  await page.click('#file-actions [data-file-action="session.openFile"]');
  await page.waitForSelector('[data-rail-place]', { timeout: 60000 });
  const deckPlace = await page.$$eval('[data-rail-place]', list => list.find(b => b.textContent.trim() === 'Deck')?.dataset.railPlace);
  await page.click(`[data-rail-place="${deckPlace}"]`);
  await page.waitForSelector('iframe.view-frame', { timeout: 15000 });
  const frameName = await page.$eval('iframe.view-frame', e => e.name);
  let frame = null;
  for (let i = 0; i < 120 && frame === null; i++) { frame = page.frame({ name: frameName }); if (frame === null) await page.waitForTimeout(250); }
  assert(frame !== null, 'Deck\'s frame never started.');
  await frame.waitForFunction(() => /^\d+ slides?$/.test(document.getElementById('deck-count')?.textContent ?? ''), null, { timeout: 30000 });
  const before = await frame.evaluate(() => ({ origin: self.origin, slides: document.querySelectorAll('#slides > *').length }));
  assert(before.origin === 'null', `Deck's frame has an origin of its own, not an opaque one: ${before.origin}.`);
  assert(before.slides > 0, 'Deck drew no slides.');
  checks.push('Deck\'s view draws in an opaque-origin frame');
  const writesBefore = await page.evaluate(() => window.__nendoSaved.writes);
  await frame.click('#add-slide');
  await page.waitForSelector('[role="menuitem"]', { timeout: 10000 });
  await page.click('[role="menuitem"] >> nth=0');
  await frame.waitForFunction((n) => document.querySelectorAll('#slides > *').length === n + 1, before.slides, { timeout: 15000 })
    .catch(() => { throw Error('Adding a slide in Deck changed nothing.'); });
  await page.waitForFunction((n) => window.__nendoSaved.writes > n && window.__nendoSaved.bytes > 0, writesBefore, { timeout: 15000 })
    .catch(() => { throw Error('The new slide was not written back to the file the person opened.'); });
  checks.push('Deck\'s view writes, and the page saves it in place');
  await page.click('#nav-history');
  await page.waitForFunction(() => document.body.innerText.includes('by the custom view Deck'), null, { timeout: 15000 })
    .catch(() => { throw Error('History does not show the view\'s write as the view\'s.'); });
  checks.push('History names the view');

  // One tab writes a file at a time: a second tab opening the same instance gets it read-only.
  const other = await page.context().newPage();
  watch(other);
  await ready(other);
  await drop(other, '__DECK_BASE64__', 'Deck.nendo');
  await other.waitForFunction(() => document.body.innerText.includes('open read-only here') || document.body.innerText.includes('Read-only'), null, { timeout: 15000 })
    .catch(() => { throw Error('A second tab opened the same file for editing.'); });
  await other.close();
  checks.push('a second tab opens the file read-only');

  // A proposal is previewed on a clone in the page and promoted into the file.
  await page.click('#nav-structure');
  await page.click('#rename-entity');
  await page.fill('#schema-name', 'Requests');
  await page.click('text=Preview rename');
  await page.waitForSelector('#accept-proposal', { timeout: 15000 });
  await page.click('#accept-proposal');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-rail-place]')].some(b => b.textContent.trim() === 'Requests'), null, { timeout: 15000 })
    .catch(() => { throw Error('The accepted rename did not reach the file.'); });
  checks.push('a proposal is promoted');

  // Download keeps a copy wherever the browser saves files.
  await page.click('#file-menu summary');
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.click('#file-actions [data-file-action="download"]'),
  ]);
  assert(download.suggestedFilename() === 'Deck.nendo', `Download named the file ${download.suggestedFilename()}.`);
  assert(await download.failure() === null, `Download failed: ${await download.failure()}.`);
  checks.push('Download keeps a copy');

  // An exported page (ADR-0035) carries its file and keeps the working copy in this browser's
  // IndexedDB. Leaving the page releases its writer lock on Deck, which an exported Deck takes.
  await page.goto('about:blank');
  const openExported = async (target, url) => {
    await target.goto(url);
    await target.waitForSelector('[data-rail-place]', { timeout: 60000 });
  };
  // The working copies as they stand, so a reload waits for the write the edit made to settle.
  const keptCopies = (target) => target.evaluate(() => new Promise((resolve) => {
    const request = indexedDB.open('nendo-browser-host');
    request.onerror = () => resolve('none');
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('files')) { resolve('none'); return; }
      const all = database.transaction('files', 'readonly').objectStore('files').getAll();
      all.onsuccess = () => resolve(all.result.map((bytes) => `${bytes.length}:${bytes.reduce((sum, b, i) => (sum + b * (i % 251 + 1)) % 1000000007, 0)}`).join('|'));
      all.onerror = () => resolve('none');
    };
  }));
  const keptSettles = async (target, before, what) => {
    let last = before, steady = 0;
    for (let i = 0; i < 120 && steady < 4; i++) {
      await target.waitForTimeout(250);
      const now = await keptCopies(target);
      steady = now !== before && now === last ? steady + 1 : 0;
      last = now;
    }
    assert(steady >= 4, `This browser did not keep ${what}.`);
  };
  const exported = await page.context().newPage();
  watch(exported);
  await exported.setViewportSize({ width: 1440, height: 900 });
  await openExported(exported, '__STATION_PAGE_URL__');
  checks.push('an exported page opens the file it carries');
  const stationKept = await keptCopies(exported);
  await exported.click('[data-rail-place="type:incident"]');
  await exported.click('[data-record-id="incident.001"]');
  await exported.selectOption('select[name="incidentSeverity"]', { label: 'Elevated' });
  await exported.click('text=Save changes');
  await exported.waitForFunction(() => !document.body.innerText.includes('Saving'), null, { timeout: 15000 });
  await exported.click('#nav-data');
  await exported.click('[data-entity-id="incident"]');
  const titleCell = '.ag-row[row-id="incident.002"] .ag-cell[col-id="incidentTitle"]';
  await exported.waitForSelector(titleCell, { timeout: 15000 });
  await exported.dblclick(titleCell);
  await exported.waitForSelector('.ag-cell-inline-editing input', { timeout: 10000 });
  await exported.keyboard.press('Control+a');
  await exported.keyboard.type('Kept across visits');
  await exported.keyboard.press('Enter');
  await exported.waitForFunction((cell) => document.querySelector(cell)?.textContent?.trim() === 'Kept across visits', titleCell, { timeout: 15000 })
    .catch(() => { throw Error('The list edit did not save.'); });
  await keptSettles(exported, stationKept, 'the record page and list edits');
  await openExported(exported, '__STATION_PAGE_URL__');
  await exported.click('[data-rail-place="type:incident"]');
  await exported.click('[data-record-id="incident.001"]');
  const severity = await exported.$eval('select[name="incidentSeverity"]', (select) => select.selectedOptions[0]?.textContent?.trim());
  assert(severity === 'Elevated', `The record page edit did not survive a reload: the severity is ${severity}.`);
  await exported.click('#nav-data');
  await exported.click('[data-entity-id="incident"]');
  await exported.waitForFunction((cell) => document.querySelector(cell)?.textContent?.trim() === 'Kept across visits', titleCell, { timeout: 15000 })
    .catch(() => { throw Error('The list edit did not survive a reload.'); });
  checks.push('a record page edit and a list edit survive a reload');
  await exported.click('#file-menu summary');
  const keptDetail = await exported.textContent('#file-actions [data-file-action="download"]');
  assert(keptDetail.includes('This browser keeps your changes'), `Download does not say the browser keeps the changes: ${keptDetail}.`);
  const [stationDownload] = await Promise.all([
    exported.waitForEvent('download', { timeout: 15000 }),
    exported.click('#file-actions [data-file-action="download"]'),
  ]);
  assert(stationDownload.suggestedFilename() === 'Nendo Station.nendo', `Download named the file ${stationDownload.suggestedFilename()}.`);
  await stationDownload.saveAs('__DOWNLOAD_PATH__');
  checks.push('the exported page downloads its working file');
  await exported.close();

  const deckExport = await page.context().newPage();
  watch(deckExport);
  await deckExport.setViewportSize({ width: 1440, height: 900 });
  const deckFrame = async () => {
    const place = await deckExport.$$eval('[data-rail-place]', list => list.find(b => b.textContent.trim() === 'Deck')?.dataset.railPlace);
    await deckExport.click(`[data-rail-place="${place}"]`);
    await deckExport.waitForSelector('iframe.view-frame', { timeout: 15000 });
    const name = await deckExport.$eval('iframe.view-frame', e => e.name);
    let found = null;
    for (let i = 0; i < 120 && found === null; i++) { found = deckExport.frame({ name }); if (found === null) await deckExport.waitForTimeout(250); }
    assert(found !== null, 'The exported Deck\'s frame never started.');
    await found.waitForFunction(() => /^\d+ slides?$/.test(document.getElementById('deck-count')?.textContent ?? ''), null, { timeout: 30000 });
    return found;
  };
  await openExported(deckExport, '__DECK_PAGE_URL__');
  let slidesFrame = await deckFrame();
  const slidesBefore = await slidesFrame.evaluate(() => document.querySelectorAll('#slides > *').length);
  const deckKept = await keptCopies(deckExport);
  await slidesFrame.click('#add-slide');
  await deckExport.waitForSelector('[role="menuitem"]', { timeout: 10000 });
  await deckExport.click('[role="menuitem"] >> nth=0');
  await slidesFrame.waitForFunction((n) => document.querySelectorAll('#slides > *').length === n + 1, slidesBefore, { timeout: 15000 })
    .catch(() => { throw Error('Adding a slide in the exported Deck changed nothing.'); });
  await keptSettles(deckExport, deckKept, 'Deck\'s new slide');
  await openExported(deckExport, '__DECK_PAGE_URL__');
  slidesFrame = await deckFrame();
  const slidesAfter = await slidesFrame.evaluate(() => document.querySelectorAll('#slides > *').length);
  assert(slidesAfter === slidesBefore + 1, `Deck's new slide did not survive a reload: ${slidesBefore} slides before, ${slidesAfter} after.`);
  checks.push('Deck\'s view write survives a reload');
  await deckExport.close();

  // A browser that refuses storage holds the page's changes for the visit only, and says so.
  const refused = await page.context().newPage();
  watch(refused);
  await refused.addInitScript(() => {
    IDBFactory.prototype.open = function () { throw new DOMException('Storage is refused here.', 'SecurityError'); };
  });
  await openExported(refused, '__STATION_PAGE_URL__');
  await refused.waitForFunction(() => document.body.innerText.includes('your changes last only this visit'), null, { timeout: 15000 })
    .catch(() => { throw Error('A refused storage did not show the visit-only notice.'); });
  await refused.click('#file-menu summary');
  const visitDetail = await refused.textContent('#file-actions [data-file-action="download"]');
  assert(visitDetail.includes('Your changes last only this visit'), `Download does not say the changes last this visit only: ${visitDetail}.`);
  await refused.close();
  checks.push('a refused storage shows the visit-only notice');

  assert(requests.length === 0, `The page reached the network: ${JSON.stringify(requests.slice(0, 5))}.`);
  assert(errors.length === 0, `Browser exceptions: ${JSON.stringify(errors)}`);
  return { complete: true, checks, errors };
  })(); } catch (error) { throw Error(`${error.message} [after: ${checks.at(-1) ?? 'nothing'}]`); }
}
