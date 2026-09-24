async (page) => {
  const root = '__NENDO_REPOSITORY__';
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.viewMessages = [];
    window.chrome ??= {};
    window.chrome.webview = {
      addEventListener: (_, listener) => { window.deliverView = message => listener({ data: message }); },
      postMessage: message => window.viewMessages.push(message),
    };
  });
  await page.setViewportSize({ width: 1024, height: 700 });
  await page.goto('__VIEW_BASE_URL__/index.html');
  const assert = (value, message) => { if (!value) throw new Error(message); };

  // The record-set shape protocol 2 sends (ADR-0013, 2026-09-24): fields named once,
  // records with exactly those values. Two start on the same day with different lengths,
  // one has only a start, one has no date at all, and one label looks like markup.
  const fields = [
    { id: 'starts', name: 'Starts', type: 'date', of: 'node' },
    { id: 'ends', name: 'Ends', type: 'date', of: 'node' },
    { id: 'owner', name: 'Owner', type: 'text', of: 'node' },
  ];
  const record = (id, label, starts, ends, owner = null) => ({ id, label, status: null, values: { starts, ends, owner } });
  const projection = { sourceChangeSequence: 1, fields, records: [
    record('short', 'Short task', '2026-10-01', '2026-10-05', 'Ada'),
    record('long', 'Long task', '2026-10-01', '2026-10-21', 'Bo'),
    record('late', 'Late task', '2026-11-10', '2026-11-20'),
    record('moment', 'Launch', '2026-10-15', null),
    record('someday', 'Undated idea', null, null),
    record('markup', '<img src=x onerror=alert(1)>', '2026-10-10', '2026-10-12'),
  ] };
  await page.evaluate(p => window.deliverView({ version: 2, method: 'initialize', session: 'gate', generation: 1, theme: 'light', locale: 'en', projection: p }), projection);

  const messages = () => page.evaluate(() => window.viewMessages);
  assert((await messages()).filter(m => m.method === 'ready' && m.version === 2).length === 1, 'The ready handshake was not sent exactly once at version 2: ' + JSON.stringify(await messages()));
  assert(await page.locator('#summary').innerText() === '6 records · 5 on the time line · 1 without a Starts · 2026-10-01 to 2026-11-20',
    'The summary is wrong: ' + await page.locator('#summary').innerText());

  // Geometry, measured rather than looked at: same start means the same left edge, a
  // longer span a wider bar, a later start further right, and a start alone a diamond.
  const box = id => page.evaluate(id => {
    const mark = document.querySelector(`.row[data-id="${id}"] .bar, .row[data-id="${id}"] .milestone`);
    if (!mark) return null;
    const r = mark.getBoundingClientRect();
    return { kind: mark.className, left: Math.round(r.left), width: Math.round(r.width) };
  }, id);
  const [short, long, late, moment] = [await box('short'), await box('long'), await box('late'), await box('moment')];
  assert(short && long && Math.abs(short.left - long.left) <= 1, 'Two records starting the same day do not share a left edge: ' + JSON.stringify({ short, long }));
  assert(long.width > short.width * 3, 'A twenty-day span is not drawn about four times a five-day one: ' + JSON.stringify({ short, long }));
  assert(late.left > long.left + long.width, 'A later record is not drawn after an earlier one: ' + JSON.stringify({ long, late }));
  assert(moment && moment.kind === 'milestone', 'A record with only a start is not a milestone: ' + JSON.stringify(moment));
  assert(await page.locator('.row[data-id="someday"]').count() === 0, 'An undated record was drawn on the time line.');
  assert(await page.locator('.row img').count() === 0 && (await page.locator('.row[data-id="markup"] .label').innerText()).startsWith('<img'),
    'A label that looks like markup became an element.');
  const order = await page.evaluate(() => [...document.querySelectorAll('.row')].map(r => r.dataset.id));
  assert(JSON.stringify(order) === JSON.stringify(['long', 'short', 'markup', 'moment', 'late']), 'Rows are not in start order: ' + JSON.stringify(order));
  assert((await page.locator('.row[data-id="short"] .label small').innerText()) === 'Ada', 'The first non-date field is not shown under the label.');
  assert(await page.locator('#axis span').count() >= 1, 'The time axis has no ticks.');

  // Selection is a suggestion with the exact keys the host accepts, from a pointer and from the keyboard.
  await page.locator('.row[data-id="late"]').click();
  let select = (await messages()).filter(m => m.method === 'selectRecord').at(-1);
  assert(JSON.stringify(Object.keys(select).sort()) === JSON.stringify(['generation', 'method', 'recordId', 'session', 'version']) &&
    select.recordId === 'late' && select.version === 2, 'The selection message is wrong: ' + JSON.stringify(select));
  await page.locator('.row[data-id="moment"]').focus();
  await page.keyboard.press('Enter');
  select = (await messages()).filter(m => m.method === 'selectRecord').at(-1);
  assert(select.recordId === 'moment', 'Enter on a focused row did not select it.');
  assert(await page.locator('.row[aria-pressed=true]').count() === 1, 'More than one row reads as selected.');
  assert((await messages()).every(m => ['ready', 'selectRecord'].includes(m.method)), 'The view sent something other than a handshake and selections.');
  const chrome = await page.evaluate(() => ['header', '#axis', 'footer'].map(s => getComputedStyle(document.querySelector(s)).userSelect));
  assert(chrome.every(value => value === 'none'), 'Chart chrome is text-selectable: ' + JSON.stringify(chrome));

  // A new generation replaces everything and clears the selection.
  await page.evaluate(() => window.deliverView({ version: 2, method: 'replaceProjection', session: 'gate', generation: 2,
    projection: { sourceChangeSequence: 2, fields: [{ id: 'starts', name: 'Starts', type: 'date', of: 'node' }],
      records: [{ id: 'only', label: 'Only', status: null, values: { starts: '2026-12-01' } }] } }));
  assert(await page.locator('#summary').innerText() === '1 record · 1 on the time line · 2026-12-01 to 2026-12-01', 'Replacement summary is wrong: ' + await page.locator('#summary').innerText());
  assert(await page.locator('#selection').innerText() === 'No record selected', 'Replacement kept a stale selection.');
  assert(await page.locator('.row[data-id="only"] .milestone').count() === 1, 'One record with only a start is not drawn as a milestone.');

  // A view that discloses no date says so rather than drawing nothing.
  await page.evaluate(() => window.deliverView({ version: 2, method: 'replaceProjection', session: 'gate', generation: 3,
    projection: { sourceChangeSequence: 3, fields: [], records: [{ id: 'a', label: 'A', status: null, values: {} }] } }));
  assert(await page.locator('#empty').isVisible() && (await page.locator('#empty').innerText()).includes('no date field'), 'A view without dates did not say why it is empty.');

  // On a record page the host sends one record rather than a set, and it is a chart of one.
  await page.evaluate(() => window.deliverView({ version: 2, method: 'replaceProjection', session: 'gate', generation: 4,
    projection: { sourceChangeSequence: 3, fields: [{ id: 'starts', name: 'Starts', type: 'date', of: 'node' }, { id: 'ends', name: 'Ends', type: 'date', of: 'node' }],
      record: { id: 'solo', label: 'Solo', status: null, values: { starts: '2026-12-01', ends: '2026-12-10' } } } }));
  assert(await page.locator('#summary').innerText() === '1 record · 1 on the time line · 2026-12-01 to 2026-12-10',
    'The one record a record page sends was not drawn: ' + await page.locator('#summary').innerText());
  assert(await page.locator('.row[data-id="solo"] .bar').count() === 1, 'The one record on a record page is not drawn as a bar.');

  // A version-1 message is not this page's.
  await page.evaluate(() => window.deliverView({ version: 1, method: 'setTheme', session: 'gate', generation: 3, theme: 'dark' }));
  assert(await page.evaluate(() => document.documentElement.dataset.theme) === 'light', 'A protocol-1 message was acted on.');
  await page.evaluate(p => window.deliverView({ version: 2, method: 'replaceProjection', session: 'gate', generation: 5, projection: { ...p, sourceChangeSequence: 5 } }), projection);
  await page.evaluate(() => window.deliverView({ version: 2, method: 'setTheme', session: 'gate', generation: 5, theme: 'dark' }));
  assert(await page.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'The theme message was ignored.');
  const dark = await page.evaluate(() => { const bar = document.querySelector('.bar'); return getComputedStyle(bar).backgroundColor !== getComputedStyle(document.body).backgroundColor; });
  assert(dark, 'A bar is invisible against the dark background.');
  await page.screenshot({ path: root + '/artifacts/extension-runtime-results/gantt-dark.png' });

  // The pane is half a window and can be small: 512x384 is a 1024x768 window at 200%.
  await page.setViewportSize({ width: 512, height: 384 });
  await page.waitForTimeout(150);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  assert(!overflow, 'The chart overflows horizontally at 512x384.');

  assert(errors.length === 0, 'The view raised: ' + errors.join(' | '));
  return 'gantt ok';
}
