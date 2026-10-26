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

  assert(requests.length === 0, `The page reached the network: ${JSON.stringify(requests.slice(0, 5))}.`);
  assert(errors.length === 0, `Browser exceptions: ${JSON.stringify(errors)}`);
  return { complete: true, checks, errors };
  })(); } catch (error) { throw Error(`${error.message} [after: ${checks.at(-1) ?? 'nothing'}]`); }
}
