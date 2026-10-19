(() => {
  'use strict';
  // A Gantt chart of one record type (ADR-0013). The view binds its dates as fields: the first
  // date field is the start and the second the end. On a record page it reads that page's one
  // record and draws a chart of one. Everything arrives through window.nendo: the records from
  // nendo.view.loadRecords, the fields' names and types from nendo.schema.describe, and the
  // theme, whose colours api.js sets on this page as --nendo-* tokens. Selecting a record asks
  // Nendo to open it.
  const DAY = 86400000;
  const nendo = window.nendo;
  let selected = null, records = [], single = false, query = '';
  // True where Nendo draws this view's controls in its own toolbar, and whether the
  // explanation is shown over the chart.
  let nativeChrome = false, aboutShown = false;
  // Reads are numbered so an answer that arrives after a newer read has started is dropped.
  let latest = 0, pending = null;
  const element = id => document.getElementById(id);
  // The view kit (tools/view-kit, copied into kit/): one tab stop for the rows, the arrow keys,
  // Home and End between them, and a focus ring in the theme's colour. Loaded as a
  // module from this classic script; until it arrives, every row is a tab stop as before.
  let keys = null;
  import('./kit/nendo-view-kit.js').then(kit => {
    kit.installFocusRing(document);
    keys = kit.roving(element('rows'), { items: '.row', orientation: 'vertical' });
  }).catch(() => undefined);

  function describe(error) { return error instanceof Error && error.message ? error.message : String(error); }
  // Dates arrive as exact ISO text; a civil date is placed at UTC midnight so a day is a day.
  function day(text) {
    if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const time = Date.parse(text + 'T00:00:00Z');
    return Number.isFinite(time) ? time : null;
  }
  // The view's own words are English, as its index.html says; the person's locale formats dates only.
  let locale = 'en';
  function month(time) { return new Date(time).toLocaleDateString(locale, { month: 'short', year: '2-digit', timeZone: 'UTC' }); }
  function dayOf(time) { return new Date(time).toLocaleDateString(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' }); }
  // The axis's ticks: the first of each month where the span holds at least two, else
  // each Monday where it holds two, else each day. At most twelve, so it stays readable at any
  // span, and a two-week sprint inside one month still has dates to read its bars against.
  function ticksOf(low, high) {
    const months = [], weeks = [], days = [];
    const cursor = new Date(low); cursor.setUTCDate(1); cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    while (cursor.getTime() <= high) { months.push(cursor.getTime()); cursor.setUTCMonth(cursor.getUTCMonth() + 1); }
    if (months.length < 2) {
      for (let time = low + DAY; time <= high; time += DAY) { days.push(time); if (new Date(time).getUTCDay() === 1) weeks.push(time); }
    }
    const [list, label] = months.length >= 2 ? [months, month] : weeks.length >= 2 ? [weeks, dayOf] : [days, dayOf];
    const step = Math.max(1, Math.ceil(list.length / 12));
    return list.filter((_, i) => i % step === 0).map(time => ({ time, text: label(time) }));
  }
  // Field names as a sentence reads them: "Starts at", "Starts at and Ends at".
  function named(list) {
    const names = list.map(field => field.name);
    return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  }

  function render(projection) {
    // A re-read keeps the selection when its record is still on the time line, without
    // opening it again.
    const keep = selected;
    selected = null;
    const fields = projection.fields;
    const dates = fields.filter(field => field.type === 'date');
    // The chart draws date fields. A date and time is not a day on its time line, and never the
    // line under a label either, where it would show as raw ISO text.
    const timed = fields.filter(field => field.type === 'dateTime');
    // The first field that is neither is shown under the label, as the record's group.
    const detail = fields.find(field => field.type !== 'date' && field.type !== 'dateTime') ?? null;
    records = projection.records;
    // On a record page the box is small and the record is already the page's: no title,
    // no instructions about selecting, and the label above its bar rather than cut beside it.
    single = projection.single;
    document.body.classList.toggle('single', single);
    declareToolbar();
    // The redraw replaces every row. The row that had the keyboard gets it back afterwards, or the
    // row now where it was, rather than focus falling to the page.
    const rows = element('rows');
    const had = rows.contains(document.activeElement) && document.activeElement.classList.contains('row')
      ? { id: document.activeElement.dataset.id, index: [...rows.querySelectorAll('.row')].indexOf(document.activeElement) } : null;
    rows.replaceChildren();
    element('ticks').replaceChildren();
    element('selection').textContent = 'No record selected';
    const empty = element('empty');
    if (dates.length === 0) {
      empty.hidden = false;
      empty.textContent = timed.length === 0
        ? 'This view has no date field, so there is nothing to place on a time line. Add a start date to its fields, and an end date if there is one.'
        : `This chart draws date fields, and ${named(timed)} ${timed.length === 1 ? 'holds' : 'hold'} a date and a time, so there is nothing to place on a time line. Add a start date to the view's fields, and an end date if there is one.`;
      setSummary(`${records.length} ${records.length === 1 ? 'record' : 'records'} · no date field`);
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
    empty.textContent = placed.length > 0 ? '' : records.length === 0
      ? (single ? 'This record is not in the file any more.' : 'No records yet. Add one in Nendo and it appears here.')
      : `No record has a ${start.name} yet.`;
    const first = Math.min(...placed.map(p => p.from));
    const last = Math.max(...placed.map(p => p.to ?? p.from));
    // A span of at least a week, so one dated record still reads as a moment, not a wall.
    const low = placed.length ? first - DAY : 0, high = placed.length ? Math.max(last + DAY, first + 7 * DAY) : 1;
    const at = time => ((time - low) / (high - low)) * 100;
    const iso = time => new Date(time).toISOString().slice(0, 10);
    if (single) {
      const only = placed[0];
      setSummary(only === undefined ? '' : only.to === null ? `${start.name} ${iso(only.from)}`
        : `${iso(only.from)} to ${iso(only.to)} · ${Math.round((only.to - only.from) / DAY) + 1} days`);
    } else {
      const summary = [`${records.length} ${records.length === 1 ? 'record' : 'records'}`, `${placed.length} on the time line`];
      if (undated > 0) summary.push(`${undated} without a ${start.name}`);
      if (placed.length) summary.push(`${iso(first)} to ${iso(last)}`);
      setSummary(summary.join(' · '));
    }

    if (placed.length) {
      for (const { time, text } of ticksOf(low, high)) {
        const tick = document.createElement('span');
        tick.style.left = at(time) + '%'; tick.textContent = text;
        element('ticks').append(tick);
      }
    }

    for (const { record, from, to } of placed) {
      const item = document.createElement('li');
      const row = document.createElement('button');
      row.type = 'button'; row.className = 'row'; row.dataset.id = record.id; row.setAttribute('aria-pressed', 'false');
      const span = to === null ? `${start.name} ${new Date(from).toISOString().slice(0, 10)}`
        : `${new Date(from).toISOString().slice(0, 10)} to ${new Date(to).toISOString().slice(0, 10)}`;
      const detailText = detail !== null && record.values?.[detail.id] != null ? String(record.values[detail.id]) : null;
      // The name is everything the row shows: the label, the group line under it, and the span.
      // aria-label replaces the button's content, so a line left out is never heard.
      row.setAttribute('aria-label', [record.label, detailText, span].filter(part => part !== null).join(', '));
      const label = document.createElement('span'); label.className = 'label';
      label.textContent = record.label; // text, never markup
      if (detailText !== null) {
        const small = document.createElement('small'); small.textContent = detailText; label.append(small);
      }
      const track = document.createElement('span'); track.className = 'track';
      const mark = document.createElement('span');
      if (to === null) { mark.className = 'milestone'; mark.style.left = at(from) + '%'; }
      else { mark.className = 'bar'; mark.style.left = at(from) + '%'; mark.style.width = Math.max(0, at(to + DAY) - at(from)) + '%'; }
      track.append(mark);
      row.append(label, track);
      row.addEventListener('click', () => select(record.id));
      item.append(row);
      rows.append(item);
    }
    if (keep !== null && placed.some(p => p.record.id === keep)) highlight(keep);
    keys?.refresh();
    if (had !== null) {
      const all = [...rows.querySelectorAll('.row')];
      (all.find(row => row.dataset.id === had.id) ?? all[Math.min(had.index, all.length - 1)])?.focus({ preventScroll: true });
    }
    find();
  }

  // Rows whose label or detail holds the text stay as they are, and the rest step back. Nothing
  // is hidden, so a row can still be picked while it does not match.
  function matches() {
    const text = query.trim().toLowerCase();
    if (text === '') return [];
    return [...document.querySelectorAll('.row')].filter(row => row.querySelector('.label').textContent.toLowerCase().includes(text));
  }
  function find() {
    const found = new Set(matches());
    const searching = query.trim() !== '';
    for (const row of document.querySelectorAll('.row')) row.classList.toggle('dimmed', searching && !found.has(row));
    const first = [...found][0];
    if (first !== undefined) first.scrollIntoView({ block: 'nearest' });
  }

  function highlight(id) {
    selected = id;
    for (const row of document.querySelectorAll('.row')) row.setAttribute('aria-pressed', String(row.dataset.id === id));
    const record = records.find(r => r.id === id);
    element('selection').textContent = record ? `${record.label} selected.` : 'No record selected';
  }

  function select(id) {
    highlight(id);
    const record = records.find(r => r.id === id);
    // On a record page the record is the page's own, and it is open already.
    if (record === undefined || id === nendo.context.recordId) return;
    nendo.ui.openRecord(record.entityId, id).catch(error => {
      if (selected === id) element('selection').textContent = `${record.label} selected. Nendo could not open it: ${describe(error)}`;
    });
  }

  // A field's value as a person reads it: a reference by its target's label, a choice by its
  // name, a number by its exact digits. Null when the record has none.
  function display(schema, record, fieldId) {
    const label = record.labels?.[fieldId];
    if (typeof label === 'string') return label;
    const value = record.values?.[fieldId];
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') {
      const field = schema.entities.find(entity => entity.entityId === record.entityId)?.fields.find(candidate => candidate.fieldId === fieldId);
      return field?.choices.find(choice => choice.id === value)?.displayName ?? value;
    }
    return record.exact?.[fieldId] ?? (typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  /**
   * The chart's columns are the fields the view binds on its own record type, named and typed
   * by the schema. Each record's label is its label field; a view that names none falls back to
   * the record type's first plain text field, and then to the record's ID.
   */
  function project(list, schema) {
    const context = nendo.context;
    const entity = schema.entities.find(candidate => candidate.entityId === context.entityId);
    const fields = context.bindings.fields.filter(binding => binding.entityId === context.entityId).map(binding => {
      const field = entity?.fields.find(candidate => candidate.fieldId === binding.fieldId);
      return { id: binding.fieldId, name: field?.displayName ?? binding.fieldId, type: field?.storageKind ?? 'text' };
    });
    const labelFieldId = context.bindings.labelFieldId
      ?? entity?.fields.find(field => field.storageKind === 'text' && !field.calculated && field.choices.length === 0)?.fieldId ?? null;
    return {
      single: context.recordId !== null,
      fields,
      records: list.map(record => ({
        id: record.recordId, entityId: record.entityId,
        label: (labelFieldId === null ? null : display(schema, record, labelFieldId)) ?? record.recordId,
        values: Object.fromEntries(fields.map(field => [field.id, display(schema, record, field.id)])),
      })),
    };
  }
  async function read() {
    const number = ++latest;
    let list, schema;
    try {
      [list, schema] = await Promise.all([nendo.view.loadRecords(), nendo.schema.describe()]);
    } catch (error) {
      if (number === latest) setSummary(`The records could not be read. ${describe(error)}`, true);
      return;
    }
    if (number !== latest) return;
    try { render(project(list, schema)); } catch {
      setSummary('This chart could not be displayed. Open your records in Nendo.', true);
    }
  }
  // Nendo says the file changed at most four times a second. A burst of changes is one read,
  // a quarter of a second after the first of them.
  function schedule() {
    if (pending !== null) return;
    pending = setTimeout(() => { pending = null; read(); }, 250);
  }
  function applyTheme(theme) {
    if (theme?.mode === 'light' || theme?.mode === 'dark') document.documentElement.dataset.theme = theme.mode;
  }

  // --- Nendo's own chrome ---------------------------------------------------------
  //
  // Where the host offers it, the chart's title gives way to Nendo's breadcrumb, Nendo's
  // toolbar carries a Find box with Ctrl F, and a right-click on a row opens Nendo's menu. A
  // chart of one on a record page has nothing to find and declares nothing.

  // The view's own lines: where Nendo draws the controls, the summary is declared as
  // text in Nendo's row and the explanation waits behind About, so neither spends a line of the
  // frame. A summary that reports a problem stays in the frame, whole.
  function setSummary(text, problem = false) {
    const line = element('summary');
    line.textContent = text;
    line.classList.toggle('problem', problem);
    declareToolbar();
  }
  function summaryItem() {
    const line = element('summary'), text = line.textContent.trim();
    if (line.classList.contains('problem') || text === '') return null;
    return { kind: 'text', text: text.length > 80 ? text.slice(0, 79) + '\u2026' : text };
  }
  function setAboutShown(on) {
    aboutShown = on;
    document.documentElement.classList.toggle('about-shown', on);
    declareToolbar();
  }
  function aboutItem() {
    return { kind: 'toggle', id: 'about', label: 'About this view', icon: 'info', iconOnly: true, pressed: aboutShown };
  }

  function declareToolbar() {
    if (!nativeChrome) return;
    const summary = summaryItem();
    const items = single ? [] : [{ kind: 'search', id: 'find', label: 'Find a record', placeholder: 'Find…', value: query.slice(0, 256), keys: 'Ctrl+F' },
      ...(summary === null ? [{ kind: 'spacer' }] : [{ kind: 'separator' }, summary]), aboutItem()];
    nendo.ui.setToolbar(items).catch(error => leaveNativeChrome(describe(error)));
  }

  // A Nendo that refuses the declaration leaves the chart as it was, and says why.
  function leaveNativeChrome(reason) {
    if (!nativeChrome) return;
    nativeChrome = false;
    document.documentElement.classList.remove('native-chrome', 'about-shown');
    query = ''; find();
    nendo.ui.setToolbar([]).catch(() => undefined);
    element('selection').textContent = `Nendo could not show this chart's controls: ${reason}`;
  }

  function runCommand({ id, value }) {
    if (id === 'about') { setAboutShown(value === true); return; }
    if (id !== 'find') return;
    const text = String(value ?? '');
    // Enter sends the text again: the same text twice opens the first row it matches.
    if (text === query && text.trim() !== '') {
      const first = matches()[0];
      if (first !== undefined) select(first.dataset.id);
      return;
    }
    query = text; find();
  }

  document.addEventListener('keydown', event => { if (event.key === 'Escape' && aboutShown) setAboutShown(false); });
  document.addEventListener('contextmenu', event => {
    if (!nativeChrome || single || !nendo.has('ui.showMenu')) return;
    const row = event.target.closest('.row');
    if (row === null) return;
    event.preventDefault();
    let at = event;
    // The keyboard's menu key names no point: the menu opens at the row.
    if (event.clientX === 0 && event.clientY === 0) {
      const box = row.getBoundingClientRect();
      at = { x: box.left + 8, y: box.bottom - 4 };
    }
    const id = row.dataset.id;
    highlight(id);
    nendo.ui.showMenu([{ id: 'open', label: 'Open record', icon: 'external' }], at)
      .then(pick => { if (pick?.id === 'open') select(id); })
      .catch(error => { element('selection').textContent = describe(error); });
  });

  function adoptNativeChrome() {
    if (typeof nendo.has !== 'function' || !nendo.has('ui.setToolbar')) return;
    nativeChrome = true;
    document.documentElement.classList.add('native-chrome');
    nendo.on('command', command => { try { runCommand(command); } catch (error) { element('selection').textContent = describe(error); } });
    declareToolbar();
  }

  if (nendo === undefined) {
    element('summary').textContent = 'This chart runs inside Nendo. Open the screen that shows it.';
    return;
  }
  nendo.ready.then(context => {
    locale = context.locale || 'en';
    single = context.recordId !== null;
    adoptNativeChrome();
    applyTheme(nendo.ui.theme);
    nendo.on('theme', applyTheme);
    // A new context can name other fields or another record type: read again under it.
    nendo.on('context', next => { applyTheme(next.theme); schedule(); });
    nendo.on('changes', schedule);
    return read();
  }).catch(error => { setSummary(`This chart could not start. ${describe(error)}`, true); });
})();
