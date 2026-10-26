async page => {
  // The browser host (ADR-0036), measured where the person meets it: one page opened from disk,
  // the real Engine in it. tools/Review-BrowserHost.ps1 fills the placeholders and runs this with
  // playwright-cli. A failure names the last check that passed, so a timeout says where it happened.
  const checks = [];
  const errors = [];
  const requests = [];
  try { return await (async () => {
  const assert = (ok, message) => { if (!ok) throw Error(message); };
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { const url = request.url(); if (!/^(file|data|blob|about):/.test(url)) requests.push(url); });
  page.on('dialog', dialog => { errors.push(`Browser dialog (${dialog.type()}): ${dialog.message()}`); dialog.dismiss().catch(() => {}); });
  await page.setViewportSize({ width: 1440, height: 900 });

  // Opening by drop rather than through the file chooser, which playwright-cli treats as a modal.
  const open = async (base64, name) => {
    await page.goto('__PAGE_URL__');
    // The host's version arrives with its first snapshot, which gives the page its file session.
    await page.waitForFunction(() => /Nendo \d+\.\d+/.test(document.body.innerText), null, { timeout: 60000 });
    await page.evaluate(({ base64, name }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], name));
      document.dispatchEvent(new DragEvent('dragenter', { dataTransfer: transfer, bubbles: true, cancelable: true }));
      document.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    }, { base64, name });
    await page.waitForSelector('[data-rail-place]', { timeout: 60000 });
  };

  // Station: its automatic action runs in the page once the person approves it.
  await open('__STATION_BASE64__', 'Nendo Station.nendo');
  assert(await page.isHidden('#nav-agent'), 'The Agent page is offered in a host with no agents.');
  checks.push('Station opens from a dropped file');
  await page.waitForFunction(() => document.body.innerText.includes('Approval needed'), null, { timeout: 30000 });
  await page.click('#nav-health');
  await page.click('#approve-behaviour');
  await page.waitForFunction(() => !document.body.innerText.includes('Approval needed'), null, { timeout: 30000 });
  checks.push('automatic actions approved');
  // Clear review flag is offered only while a system's flag is up.
  const command = () => page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Clear review flag');
    return button === undefined ? 'missing' : button.disabled ? 'disabled' : 'enabled';
  });
  await page.click('[data-rail-place="type:system"]');
  await page.click('[data-record-id="system.co2"]');
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Clear review flag'), null, { timeout: 15000 });
  assert(await command() === 'enabled', `CO2 Scrubbing's review flag is not up to start with: ${await command()}.`);
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

  // Deck: its own view runs in an opaque-origin frame and writes through the broker.
  await open('__DECK_BASE64__', 'Deck.nendo');
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
  await frame.click('#add-slide');
  await page.waitForSelector('[role="menuitem"]', { timeout: 10000 });
  await page.click('[role="menuitem"] >> nth=0');
  await frame.waitForFunction((n) => document.querySelectorAll('#slides > *').length === n + 1, before.slides, { timeout: 15000 })
    .catch(() => { throw Error('Adding a slide in Deck changed nothing.'); });
  await page.click('#nav-history');
  await page.waitForFunction(() => document.body.innerText.includes('by the custom view Deck'), null, { timeout: 15000 })
    .catch(() => { throw Error('History does not show the view\'s write as the view\'s.'); });
  checks.push('Deck\'s view writes, and History names it');

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

  // The only addresses the page reaches are pictures linked into the files, from the media
  // origin a Windows host serves (not yet served in the page).
  const strays = requests.filter(url => !/^https:\/\/media-[0-9a-f]+\.example\//.test(url));
  assert(strays.length === 0, `The page reached the network: ${JSON.stringify(strays.slice(0, 5))}.`);
  assert(errors.length === 0, `Browser exceptions: ${JSON.stringify(errors)}`);
  return { complete: true, checks, errors, mediaRequests: requests.length };
  })(); } catch (error) { throw Error(`${error.message} [after: ${checks.at(-1) ?? 'nothing'}]`); }
}
