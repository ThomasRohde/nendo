async page => {
  // An exported web app (ADR-0037), served from a static site: the browser's own installability
  // check, the service worker answering it offline with the visitor's edit, a republished version
  // offered with Reload rather than swapped in, and the visitor's changes carried over to it: the
  // owner changed incident.002 before republishing, so the visitor's edit of it is left out. tools/Review-BrowserHost.ps1 -Served fills the
  // placeholders and runs this with playwright-cli. A failure names the last check that passed.
  const checks = [];
  const errors = [];
  const requests = [];
  try { return await (async () => {
  const assert = (ok, message) => { if (!ok) throw Error(message); };
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { errors.push(`Browser dialog (${dialog.type()}): ${dialog.message()}`); dialog.dismiss().catch(() => {}); });
  // The app asks for its own folder's files and nothing else.
  page.on('request', request => { const url = request.url(); if (!/^(data|blob|about|nendo-media):/.test(url) && !url.startsWith('__APP_URL__')) requests.push(url); });
  await page.setViewportSize({ width: 1440, height: 900 });

  const open = async () => {
    await page.goto('__APP_URL__');
    await page.waitForSelector('[data-rail-place]', { timeout: 60000 });
  };
  const carried = () => page.evaluate(() => {
    const text = document.getElementById('nendo-file')?.textContent ?? '';
    return `${text.length}:${text.slice(-48)}`;
  });
  const keptCopies = () => page.evaluate(() => new Promise((resolve) => {
    const request = indexedDB.open('nendo-browser-host');
    request.onerror = () => resolve('none');
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('files')) { resolve('none'); return; }
      const all = database.transaction('files', 'readonly').objectStore('files').getAll();
      // A web app keeps its copy with the export it came from: { carried, bytes }.
      all.onsuccess = () => resolve(all.result.map((value) => value instanceof Uint8Array ? value : value.bytes).map((bytes) => `${bytes.length}:${bytes.reduce((sum, b, i) => (sum + b * (i % 251 + 1)) % 1000000007, 0)}`).join('|'));
      all.onerror = () => resolve('none');
    };
  }));
  const keptSettles = async (before) => {
    let last = before, steady = 0;
    for (let i = 0; i < 120 && steady < 4; i++) {
      await page.waitForTimeout(250);
      const now = await keptCopies();
      steady = now !== before && now === last ? steady + 1 : 0;
      last = now;
    }
    assert(steady >= 4, 'This browser did not keep the edit.');
  };
  const severity = async () => {
    await page.click('[data-rail-place="type:incident"]');
    await page.click('[data-record-id="incident.001"]');
    return page.$eval('select[name="incidentSeverity"]', (select) => select.selectedOptions[0]?.textContent?.trim());
  };
  const titleCell = '.ag-row[row-id="incident.002"] .ag-cell[col-id="incidentTitle"]';
  const title = async () => {
    await page.click('#nav-data');
    await page.click('[data-entity-id="incident"]');
    await page.waitForSelector(titleCell, { timeout: 15000 });
    return (await page.textContent(titleCell))?.trim();
  };

  await open();
  await page.waitForFunction(() => navigator.serviceWorker?.controller != null, null, { timeout: 30000 })
    .catch(() => { throw Error('The web app\'s service worker never took control of the page.'); });
  checks.push('the service worker controls the page');
  const browser = await page.context().newCDPSession(page);
  // playwright-cli's context is a private one, which no browser installs from; that is the lane's, not the app's.
  const installabilityErrors = (await browser.send('Page.getInstallabilityErrors')).installabilityErrors.filter((error) => error.errorId !== 'in-incognito');
  assert(installabilityErrors.length === 0, `The browser would not install the web app: ${JSON.stringify(installabilityErrors)}.`);
  const manifest = await browser.send('Page.getAppManifest');
  assert(manifest.errors.length === 0, `The manifest has errors: ${JSON.stringify(manifest.errors)}.`);
  await browser.detach();
  checks.push('the browser can install it');

  // The carried file is a Duplicate, a new instance, so its automatic actions are approved for it afresh.
  await page.waitForFunction(() => document.body.innerText.includes('Approval needed'), null, { timeout: 30000 });
  await page.click('#nav-health');
  await page.click('#approve-behaviour');
  await page.waitForFunction(() => !document.body.innerText.includes('Approval needed'), null, { timeout: 30000 });
  const before = await keptCopies();
  assert(await severity() !== 'Elevated', 'The incident is Elevated before the visitor edits it.');
  await page.selectOption('select[name="incidentSeverity"]', { label: 'Elevated' });
  await page.click('text=Save changes');
  await page.waitForFunction(() => !document.body.innerText.includes('Saving'), null, { timeout: 15000 });
  assert(await title() !== 'Changed by the owner', 'The published app already holds the owner\'s later change.');
  await page.dblclick(titleCell);
  await page.waitForSelector('.ag-cell-inline-editing input', { timeout: 10000 });
  await page.keyboard.press('Control+a');
  await page.keyboard.type('Changed by the visitor');
  await page.keyboard.press('Enter');
  await page.waitForFunction((cell) => document.querySelector(cell)?.textContent?.trim() === 'Changed by the visitor', titleCell, { timeout: 15000 })
    .catch(() => { throw Error('The visitor\'s list edit did not save.'); });
  await keptSettles(before);

  await page.context().setOffline(true);
  try {
    await open();
    assert(await severity() === 'Elevated', 'The app opened offline without the visitor\'s edit.');
  } finally {
    await page.context().setOffline(false);
  }
  checks.push('it opens offline with the visitor\'s edit');

  // A newer export published in the folder installs beside the running version and waits.
  const published = await carried();
  const republished = await page.request.post('__PUBLISH_URL__');
  assert(republished.ok(), `Republishing failed: ${republished.status()}.`);
  const offered = (tab) => tab.waitForFunction(() => document.body.innerText.includes('A newer version of this app is published.'), null, { timeout: 30000 })
    .catch(() => { throw Error('A republished version was not offered.'); });
  const reload = async (tab) => {
    await Promise.all([
      tab.waitForEvent('load', { timeout: 30000 }),
      tab.click('.notice-actions button:has-text("Reload")'),
    ]);
    await tab.waitForSelector('[data-rail-place]', { timeout: 60000 });
  };
  await open();
  await offered(page);
  // Opening the app again, without Reload, still opens the version it was running.
  await open();
  await offered(page);
  assert(await carried() === published, 'A republished version was swapped in before the person chose Reload.');
  checks.push('a republished version is offered, not swapped in');
  // A second tab is offered the same version, and chooses Reload after this one has.
  const other = await page.context().newPage();
  await other.goto('__APP_URL__');
  await other.waitForSelector('[data-rail-place]', { timeout: 60000 });
  await offered(other);
  await reload(page);
  assert(await carried() !== published, 'Reload did not move to the newer version.');
  await reload(other).catch((error) => { throw Error(`Reload in a second tab, after the first one's, did not move to the newer version: ${error.message}`); });
  await other.close();
  checks.push('Reload moves to the newer version, in a second tab too');

  await page.waitForFunction(() => document.body.innerText.includes('Your changes were carried to the newer version of this app, except one.'), null, { timeout: 30000 })
    .catch(async () => { throw Error(`The carry-over was not reported: ${(await page.textContent('body'))?.slice(0, 400)}`); });
  assert(await severity() === 'Elevated', 'The visitor\'s edit was not carried to the newer version.');
  assert(await title() === 'Changed by the owner', 'The visitor\'s edit of a record the owner changed was carried over it.');
  checks.push('the visitor\'s edit is carried over, and one the owner overtook is left out');
  await page.click('#file-menu summary');
  const [previous] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.click('#file-actions [data-file-action="downloadPrevious"]'),
  ]);
  assert(await previous.failure() === null, `Download previous copy failed: ${await previous.failure()}.`);
  await previous.saveAs('__PREVIOUS_PATH__');
  await page.click('#file-menu summary');
  const [working] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.click('#file-actions [data-file-action="download"]'),
  ]);
  await working.saveAs('__DOWNLOAD_PATH__');
  checks.push('the previous copy and the carried copy download');

  assert(requests.length === 0, `The app reached outside its folder: ${JSON.stringify(requests.slice(0, 5))}.`);
  assert(errors.length === 0, `Browser exceptions: ${JSON.stringify(errors)}`);
  return { complete: true, checks, errors };
  })(); } catch (error) { throw Error(`${error.message} [after: ${checks.at(-1) ?? 'nothing'}]`); }
}
