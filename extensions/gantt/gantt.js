(() => {
  'use strict';
  // A Gantt chart of one record type, protocol 2's record-set shape (ADR-0013,
  // 2026-09-24). The view discloses its dates as typed fields: the first date field is
  // the start and the second the end. On a record page the host sends that one record
  // instead of a set, and it is drawn as a chart of one. Nothing here reads, writes or
  // opens anything; a selection is a suggestion, and Open record is the host's.
  const PROTOCOL = 2;
  const DAY = 86400000;
  let session = null, generation = 0, selected = null, records = [];
  const element = id => document.getElementById(id);

  function send(method, values = {}) {
    if (session !== null) window.chrome.webview.postMessage({ version: PROTOCOL, session, generation, method, ...values });
  }
  // Dates arrive as exact ISO text; a civil date is placed at UTC midnight so a day is a day.
  function day(text) {
    if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const time = Date.parse(text + 'T00:00:00Z');
    return Number.isFinite(time) ? time : null;
  }
  function month(time) { return new Date(time).toLocaleDateString(document.documentElement.lang || 'en', { month: 'short', year: '2-digit', timeZone: 'UTC' }); }

  function render(projection) {
    selected = null;
    const fields = (projection.fields ?? []).filter(field => field.of === 'node');
    const dates = fields.filter(field => field.type === 'date');
    // The first field that is not a date is shown under the label, as the record's group.
    const detail = fields.find(field => field.type !== 'date') ?? null;
    records = projection.records ?? (projection.record ? [projection.record] : []);
    // On a record page the box is small and the record is already the page's: no title,
    // no instructions about selecting, and the label above its bar rather than cut beside it.
    const single = projection.records === undefined && projection.record !== undefined;
    document.body.classList.toggle('single', single);
    element('rows').replaceChildren();
    element('axis').replaceChildren();
    element('selection').textContent = 'No record selected';
    const empty = element('empty');
    if (dates.length === 0) {
      empty.hidden = false;
      empty.textContent = 'This view discloses no date field, so there is nothing to place on a time line. Disclose a start date, and an end date if there is one.';
      element('summary').textContent = `${records.length} ${records.length === 1 ? 'record' : 'records'} · no dates disclosed`;
      return;
    }
    const [start, end] = dates;
    const placed = [];
    let undated = 0;
    for (const record of records) {
      const from = day(record.values?.[start.id]);
      const to = end === undefined ? null : day(record.values?.[end.id]);
      if (from === null) { undated += 1; continue; }
      placed.push({ record, from, to: to !== null && to >= from ? to : null });
    }
    placed.sort((a, b) => a.from - b.from || String(a.record.label).localeCompare(String(b.record.label)));
    empty.hidden = placed.length > 0;
    empty.textContent = placed.length > 0 ? '' : `No record has a ${start.name} yet.`;
    const first = Math.min(...placed.map(p => p.from));
    const last = Math.max(...placed.map(p => p.to ?? p.from));
    // A span of at least a week, so one dated record still reads as a moment, not a wall.
    const low = placed.length ? first - DAY : 0, high = placed.length ? Math.max(last + DAY, first + 7 * DAY) : 1;
    const at = time => ((time - low) / (high - low)) * 100;
    const iso = time => new Date(time).toISOString().slice(0, 10);
    if (single) {
      const only = placed[0];
      element('summary').textContent = only === undefined ? '' : only.to === null ? `${start.name} ${iso(only.from)}`
        : `${iso(only.from)} to ${iso(only.to)} · ${Math.round((only.to - only.from) / DAY) + 1} days`;
    } else {
      const summary = [`${records.length} ${records.length === 1 ? 'record' : 'records'}`, `${placed.length} on the time line`];
      if (undated > 0) summary.push(`${undated} without a ${start.name}`);
      if (placed.length) summary.push(`${iso(first)} to ${iso(last)}`);
      element('summary').textContent = summary.join(' · ');
    }

    // Month ticks, at most twelve, so the axis stays readable at any span.
    if (placed.length) {
      const cursor = new Date(low); cursor.setUTCDate(1); cursor.setUTCMonth(cursor.getUTCMonth() + 1);
      const ticks = [];
      while (cursor.getTime() <= high) { ticks.push(cursor.getTime()); cursor.setUTCMonth(cursor.getUTCMonth() + 1); }
      const step = Math.max(1, Math.ceil(ticks.length / 12));
      ticks.filter((_, i) => i % step === 0).forEach(time => {
        const tick = document.createElement('span');
        tick.style.left = at(time) + '%'; tick.textContent = month(time);
        element('axis').append(tick);
      });
    }

    for (const { record, from, to } of placed) {
      const item = document.createElement('li');
      const row = document.createElement('button');
      row.type = 'button'; row.className = 'row'; row.dataset.id = record.id; row.setAttribute('aria-pressed', 'false');
      const span = to === null ? `${start.name} ${new Date(from).toISOString().slice(0, 10)}`
        : `${new Date(from).toISOString().slice(0, 10)} to ${new Date(to).toISOString().slice(0, 10)}`;
      row.setAttribute('aria-label', `${record.label}, ${span}`);
      const label = document.createElement('span'); label.className = 'label';
      label.textContent = record.label; // text, never markup
      if (detail !== null && record.values?.[detail.id] != null) {
        const small = document.createElement('small'); small.textContent = String(record.values[detail.id]); label.append(small);
      }
      const track = document.createElement('span'); track.className = 'track';
      const mark = document.createElement('span');
      if (to === null) { mark.className = 'milestone'; mark.style.left = at(from) + '%'; }
      else { mark.className = 'bar'; mark.style.left = at(from) + '%'; mark.style.width = Math.max(0, at(to + DAY) - at(from)) + '%'; }
      track.append(mark);
      row.append(label, track);
      row.addEventListener('click', () => select(record.id));
      item.append(row);
      element('rows').append(item);
    }
  }

  function select(id) {
    selected = id;
    for (const row of document.querySelectorAll('.row')) row.setAttribute('aria-pressed', String(row.dataset.id === id));
    const record = records.find(r => r.id === id);
    element('selection').textContent = record ? `${record.label} selected. Use Open record in Nendo to edit it.` : 'No record selected';
    send('selectRecord', { recordId: id });
  }

  window.chrome.webview.addEventListener('message', event => {
    const message = event.data;
    if (message.version !== PROTOCOL) return;
    try {
      if (message.method === 'initialize' && session === null) {
        session = message.session; generation = message.generation;
        document.documentElement.dataset.theme = message.theme;
        document.documentElement.lang = message.locale || 'en';
        render(message.projection); send('ready');
      } else if (message.session === session && message.method === 'replaceProjection' && message.generation > generation) {
        generation = message.generation; render(message.projection);
      } else if (message.session === session && message.method === 'setTheme') document.documentElement.dataset.theme = message.theme;
    } catch {
      element('summary').textContent = 'This chart could not be displayed. Open your records in Nendo.';
      send('reportError', { code: 'render-failed', message: 'The chart could not be displayed.' });
    }
  });
})();
