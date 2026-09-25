async (page) => {
  const root = '__NENDO_REPOSITORY__';
  const errors = [];
  // Errors in the view's own frame reach the page too, uncaught rejections included.
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push('console: ' + message.text()); });
  await page.setViewportSize({ width: 1024, height: 700 });
  // The broker page frames the package from another origin and answers it as the Workbench would.
  await page.goto('__BROKER_URL__');
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const origin = await page.evaluate(() => window.broker.viewOrigin);

  // A record type of jobs: a name, two dates and an owner that is a reference to a person. The
  // view binds its columns as fields of the job; the schema names and types them.
  const field = (fieldId, displayName, storageKind, extra = {}) => ({ fieldId, displayName, storageKind, required: false,
    presentation: null, calculated: false, expression: null, choices: [], reference: null, scale: null, ...extra });
  const record = (entityId, recordId, values, labels = {}) => ({ entityId, recordId, version: 1, values, exact: {}, labels, calculated: {} });
  const fixture = ({ records, bound = ['starts', 'ends', 'owner'], recordId = null }) => ({
    context: { viewId: recordId === null ? 'gantt' : 'ganttPanel', kind: recordId === null ? 'extensionRecordsSurface' : 'extensionRecordPanel',
      placement: recordId === null ? 'screen' : 'recordPage', title: 'Gantt', entityId: 'job', recordId,
      bindings: { labelFieldId: 'jobName', statusFieldId: null, edgeEntityId: null, sourceFieldId: null, targetFieldId: null,
        fields: bound.map(fieldId => ({ fieldId, entityId: 'job' })), filters: [] } },
    schema: { entities: [
      { entityId: 'job', displayName: 'Job', fields: [field('jobName', 'Name', 'text'), field('starts', 'Starts', 'date'), field('ends', 'Ends', 'date'),
        field('owner', 'Owner', 'reference', { reference: { targetEntityId: 'person', labelFieldId: 'personName' } })] },
      { entityId: 'person', displayName: 'Person', fields: [field('personName', 'Name', 'text')] },
    ] },
    records: {
      job: records.map(job => record('job', job.id, { jobName: job.label, starts: job.starts, ends: job.ends, owner: job.owner ? 'person-' + job.owner.toLowerCase() : null },
        job.owner ? { owner: job.owner } : {})),
      person: ['Ada', 'Bo'].map(name => record('person', 'person-' + name.toLowerCase(), { personName: name })),
    },
  });
  const job = (id, label, starts, ends, owner = null) => ({ id, label, starts, ends, owner });

  let view = null;
  const frameOf = async (previous = null) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const frame = page.frames().find(candidate => candidate !== previous && !candidate.isDetached() && candidate.url().startsWith(origin + '/'));
      if (frame !== undefined) { await frame.waitForSelector('#summary'); return frame; }
      await page.waitForTimeout(25);
    }
    throw new Error('The view never loaded from its own origin.');
  };
  const summary = () => view.locator('#summary').innerText();
  const until = async (predicate, arg, message) => {
    try { await view.waitForFunction(predicate, arg, { timeout: 5000, polling: 50 }); } catch {
      throw new Error(message + ' The view says: ' + JSON.stringify(await view.evaluate(() => document.getElementById('summary').textContent)));
    }
  };
  const showing = (expected, message) => until(text => document.getElementById('summary').textContent === text, expected, message ?? `The chart never showed "${expected}".`);
  const requests = (from = 0) => page.evaluate(start => window.broker.requests.slice(start), from);
  const requestCount = () => page.evaluate(() => window.broker.requests.length);
  const openCount = () => page.evaluate(() => window.broker.opened().length);
  // What one action asked Nendo to open: wait for the first request, then long enough for a second.
  const opens = async action => {
    const before = await openCount();
    await action();
    await page.waitForFunction(count => window.broker.opened().length > count, before, { timeout: 3000 }).catch(() => undefined);
    await page.waitForTimeout(200);
    return page.evaluate(count => window.broker.opened().slice(count), before);
  };
  const exactlyOne = (list, recordId, message) =>
    assert(list.length === 1 && list[0].entityId === 'job' && list[0].recordId === recordId && Object.keys(list[0]).sort().join() === 'entityId,recordId',
      message + ' ' + JSON.stringify(list));

  // Two start on the same day with different lengths, one has only a start, one has no date at
  // all, and one label looks like markup.
  const set = [
    job('short', 'Short task', '2026-10-01', '2026-10-05', 'Ada'),
    job('long', 'Long task', '2026-10-01', '2026-10-21', 'Bo'),
    job('late', 'Late task', '2026-11-10', '2026-11-20'),
    job('moment', 'Launch', '2026-10-15', null),
    job('someday', 'Undated idea', null, null),
    job('markup', '<img src=x onerror=alert(1)>', '2026-10-10', '2026-10-12'),
  ];
  const setSummary = '6 records · 5 on the time line · 1 without a Starts · 2026-10-01 to 2026-11-20';
  await page.evaluate(value => window.broker.setFixture(value), fixture({ records: set }));
  view = await frameOf();
  await showing(setSummary, 'The chart never drew its records, or its summary is wrong.');

  // One hello and one connect, at the API version protocol.ts declares: the handshake is api.js's.
  const handshake = await page.evaluate(() => ({ connects: window.broker.connects, hellos: [...window.broker.hellos], apiVersion: window.broker.apiVersion }));
  assert(handshake.connects === 1 && JSON.stringify(handshake.hellos) === JSON.stringify([handshake.apiVersion]),
    'The view did not connect exactly once at the API version protocol.ts declares: ' + JSON.stringify(handshake));

  // Geometry, measured rather than looked at: same start means the same left edge, a
  // longer span a wider bar, a later start further right, and a start alone a diamond.
  const box = id => view.evaluate(id => {
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
  assert(await view.locator('.row[data-id="someday"]').count() === 0, 'An undated record was drawn on the time line.');
  assert(await view.locator('.row img').count() === 0 && (await view.locator('.row[data-id="markup"] .label').innerText()).startsWith('<img'),
    'A label that looks like markup became an element.');
  const order = await view.evaluate(() => [...document.querySelectorAll('.row')].map(r => r.dataset.id));
  assert(JSON.stringify(order) === JSON.stringify(['long', 'short', 'markup', 'moment', 'late']), 'Rows are not in start order: ' + JSON.stringify(order));
  // The owner is a reference: it is shown by the name it points at, not by the ID it stores.
  assert((await view.locator('.row[data-id="short"] .label small').innerText()) === 'Ada', 'The first non-date field is not shown under the label by its name.');
  assert(await view.locator('#axis span').count() >= 1, 'The time axis has no ticks.');

  // Selecting a record asks Nendo to open it, once, from a pointer and from the keyboard.
  exactlyOne(await opens(() => view.locator('.row[data-id="late"]').click()), 'late', 'Selecting a record did not ask Nendo to open exactly it, once:');
  await view.locator('.row[data-id="moment"]').focus();
  exactlyOne(await opens(() => page.keyboard.press('Enter')), 'moment', 'Enter on a focused row did not open it, once:');
  assert(await view.locator('.row[aria-pressed=true]').count() === 1, 'More than one row reads as selected.');
  const chrome = await view.evaluate(() => ['header', '#axis', 'footer'].map(s => getComputedStyle(document.querySelector(s)).userSelect));
  assert(chrome.every(value => value === 'none'), 'Chart chrome is text-selectable: ' + JSON.stringify(chrome));

  // The file changes. The chart reads again only when Nendo says so, keeps the selected record
  // selected without opening it again, and shows what changed.
  const opened = await openCount();
  let mark = await requestCount();
  await page.evaluate(value => window.broker.setFixture(value), fixture({ records: set.map(entry => entry.id === 'late' ? { ...entry, ends: '2026-11-30' } : entry) }));
  await page.waitForTimeout(400);
  const early = await requests(mark);
  assert(early.length === 0, 'The chart read the file before Nendo said it changed: ' + JSON.stringify(early.map(r => r.m)));
  const heard = await page.evaluate(() => { window.broker.pushChanges(); return window.broker.events.at(-1); });
  await showing('6 records · 5 on the time line · 1 without a Starts · 2026-10-01 to 2026-11-30',
    'The chart did not read again and show the change after Nendo said the file changed.');
  const reread = await requests(mark);
  assert(reread.some(r => r.m === 'records.query'), 'The chart showed a change without reading the records again: ' + JSON.stringify(reread.map(r => r.m)));
  assert(reread[0].t - heard.t >= 150, `The chart read again ${reread[0].t - heard.t} ms after the change, not about a quarter of a second.`);
  assert(await view.locator('.row[data-id="moment"]').getAttribute('aria-pressed') === 'true' && await view.locator('#selection').innerText() === 'Launch selected.',
    'The re-read lost the selection: ' + await view.locator('#selection').innerText());
  assert(await openCount() === opened, 'The re-read opened the selected record again.');
  mark = await requestCount();
  await page.evaluate(() => { for (let index = 0; index < 5; index += 1) window.broker.pushChanges(); });
  await page.waitForTimeout(900);
  const burst = (await requests(mark)).filter(r => r.m === 'records.query' && r.p.entityId === 'job' && (r.p.cursor ?? null) === null).length;
  assert(burst === 1, `A burst of five changes made ${burst} reads of the records, not one.`);
  // A refusal to open is said in the view, as text, and not thrown.
  await page.evaluate(() => window.broker.fail('ui.openRecord', { code: 'not-allowed', message: 'A record page has unsaved changes, so Nendo stays where it is until they are saved or closed.' }));
  await view.locator('.row[data-id="short"]').click();
  await until(() => document.getElementById('selection').textContent.includes('unsaved changes'), undefined, 'A refused open was not shown as text in the chart.');

  // The view's definition changes: Nendo hands it a new context, and the chart reads again
  // under the fields it now binds. A selection whose record is gone is dropped.
  await page.evaluate(value => { window.broker.setFixture(value); window.broker.pushContext(); }, fixture({ records: [job('only', 'Only', '2026-12-01', null)], bound: ['starts'] }));
  await showing('1 record · 1 on the time line · 2026-12-01 to 2026-12-01', 'A new context did not make the chart read again under its fields.');
  assert(await view.locator('#selection').innerText() === 'No record selected', 'Replacement kept a stale selection.');
  assert(await view.locator('.row[data-id="only"] .milestone').count() === 1, 'One record with only a start is not drawn as a milestone.');

  // A view that binds no date says so rather than drawing nothing.
  await page.evaluate(value => { window.broker.setFixture(value); window.broker.pushContext(); }, fixture({ records: [job('a', 'A', null, null)], bound: [] }));
  await until(() => !document.getElementById('empty').hidden && document.getElementById('empty').textContent.includes('no date field'), undefined,
    'A view without dates did not say why it is empty.');

  // On a record page the view reads that page's one record, in a frame of its own, and it is a
  // chart of one. The record is the page's own: selecting it opens nothing.
  let previous = view;
  mark = await requestCount();
  await page.evaluate(value => { window.broker.setFixture(value); window.broker.remount(); },
    fixture({ records: [job('solo', 'Solo', '2026-12-01', '2026-12-10'), ...set], recordId: 'solo' }));
  view = await frameOf(previous);
  await showing('2026-12-01 to 2026-12-10 · 10 days', 'The one record a record page reads was not drawn.');
  assert(await view.locator('.row[data-id="solo"] .bar').count() === 1 && await view.locator('.row').count() === 1, 'The one record on a record page is not drawn as one bar.');
  const pageReads = (await requests(mark)).filter(r => r.m === 'records.get' || r.m === 'records.query');
  assert(pageReads.length > 0 && pageReads.every(r => r.m === 'records.get' && r.p.entityId === 'job' && r.p.recordId === 'solo'),
    'A record page did not read exactly its own record: ' + JSON.stringify(pageReads));
  const pageOpens = await openCount();
  await view.locator('.row[data-id="solo"]').click();
  await page.waitForTimeout(500);
  assert(await openCount() === pageOpens, 'Selecting the record page\'s own record asked Nendo to open it again.');
  // The box on a record page is small: the owner met most of it spent on a title, a paragraph
  // of instructions and a selection footer, and the label cut to "Pour the f...". Measured at
  // the placeholder's own size, after the record changed and was read again.
  await page.setViewportSize({ width: 380, height: 360 });
  mark = await requestCount();
  await page.evaluate(value => { window.broker.setFixture(value); window.broker.pushChanges(); },
    fixture({ records: [job('solo', 'Pour the foundation for the east wing', '2026-11-03', '2026-11-14')], recordId: 'solo' }));
  await showing('2026-11-03 to 2026-11-14 · 12 days', 'The record page did not read its record again after a change.');
  assert((await requests(mark)).some(r => r.m === 'records.get'), 'The record page showed a change without reading its record again.');
  const compact = await view.evaluate(() => {
    const label = document.querySelector('.row[data-id="solo"] .label');
    const shown = selector => { const e = document.querySelector(selector); return e !== null && getComputedStyle(e).display !== 'none'; };
    const bar = document.querySelector('.row[data-id="solo"] .bar').getBoundingClientRect();
    return { chrome: ['h1', '.hint', 'footer'].filter(shown), labelCut: label.scrollWidth > label.clientWidth + 1,
      barWidth: Math.round(bar.width), bottom: Math.round(bar.bottom), height: innerHeight };
  });
  assert(compact.chrome.length === 0, "A record page's chart still spends its box on: " + compact.chrome.join(', '));
  assert(!compact.labelCut, "The record's label is cut on a record page.");
  assert(compact.barWidth > 150 && compact.bottom < compact.height, 'The bar does not use the box: ' + JSON.stringify(compact));
  await page.setViewportSize({ width: 1024, height: 700 });

  // Back on a screen, in a fresh frame. The Workbench's dark theme arrives as an event, and the
  // colours are the Workbench's own: a token the Workbench sends is the colour the chart draws with.
  previous = view;
  await page.evaluate(value => { window.broker.setFixture(value); window.broker.remount(); }, fixture({ records: set }));
  view = await frameOf(previous);
  await showing(setSummary, 'The chart did not draw its records in a fresh frame.');
  const lightColour = await view.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await page.evaluate(() => window.broker.pushTheme('dark'));
  await until(colour => getComputedStyle(document.body).backgroundColor !== colour, lightColour, 'A dark theme event did not change the chart\'s colours.');
  assert(await view.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'The theme event was ignored.');
  const darkColour = await view.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const visible = await view.evaluate(() => { const bar = document.querySelector('.bar'); return getComputedStyle(bar).backgroundColor !== getComputedStyle(document.body).backgroundColor; });
  assert(visible, 'A bar is invisible against the dark background.');
  await page.screenshot({ path: root + '/artifacts/extension-runtime-results/gantt-dark.png' });
  await page.evaluate(() => window.broker.pushTheme({ mode: 'dark', tokens: { ...window.broker.themes.dark, canvas: '#010203' } }));
  await until(() => getComputedStyle(document.body).backgroundColor === 'rgb(1, 2, 3)', undefined, 'The chart does not draw with the Workbench\'s canvas token.');
  await page.evaluate(() => window.broker.pushTheme('dark'));

  // A refused read is said in the view, as text, never thrown.
  await page.evaluate(() => {
    window.broker.fail('records.query', { code: 'views-off', message: 'Custom views are off, so this view cannot read the file.' });
    window.broker.pushChanges();
  });
  await until(() => document.getElementById('summary').textContent.includes('Custom views are off'), undefined, 'A refused read was not shown as text in the chart.');

  // A record type with no records says so.
  await page.evaluate(value => { window.broker.setFixture(value); window.broker.pushChanges(); }, fixture({ records: [] }));
  await showing('0 records · 0 on the time line', 'The chart did not recover and say it has no records.');
  assert(await view.locator('#empty').isVisible() && (await view.locator('#empty').innerText()).startsWith('No records yet'), 'A chart with no records did not say so.');

  // The pane is half a window and can be small: 512x384 is a 1024x768 window at 200%.
  await page.evaluate(value => { window.broker.setFixture(value); window.broker.pushChanges(); }, fixture({ records: set }));
  await showing(setSummary);
  await page.setViewportSize({ width: 512, height: 384 });
  await page.waitForTimeout(150);
  const overflow = await view.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  assert(!overflow, 'The chart overflows horizontally at 512x384.');

  const methods = [...new Set((await requests()).map(r => r.m))].sort();
  assert(JSON.stringify(methods) === JSON.stringify(['records.get', 'records.query', 'schema.describe', 'ui.openRecord']),
    'The chart asked for something other than reads and opening a record: ' + JSON.stringify(methods));
  assert(errors.length === 0, 'The view raised: ' + errors.join(' | '));
  return 'gantt ok ' + JSON.stringify({ themes: { light: lightColour, dark: darkColour }, burstReads: burst });
}
