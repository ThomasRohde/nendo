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
  let selected = null, records = [];
  // Reads are numbered so an answer that arrives after a newer read has started is dropped.
  let latest = 0, pending = null;
  const element = id => document.getElementById(id);

  function describe(error) { return error instanceof Error && error.message ? error.message : String(error); }
  // Dates arrive as exact ISO text; a civil date is placed at UTC midnight so a day is a day.
  function day(text) {
    if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const time = Date.parse(text + 'T00:00:00Z');
    return Number.isFinite(time) ? time : null;
  }
  function month(time) { return new Date(time).toLocaleDateString(document.documentElement.lang || 'en', { month: 'short', year: '2-digit', timeZone: 'UTC' }); }

  function render(projection) {
    // A re-read keeps the selection when its record is still on the time line, without
    // opening it again.
    const keep = selected;
    selected = null;
    const fields = projection.fields;
    const dates = fields.filter(field => field.type === 'date');
    // The first field that is not a date is shown under the label, as the record's group.
    const detail = fields.find(field => field.type !== 'date') ?? null;
    records = projection.records;
    // On a record page the box is small and the record is already the page's: no title,
    // no instructions about selecting, and the label above its bar rather than cut beside it.
    const single = projection.single;
    document.body.classList.toggle('single', single);
    element('rows').replaceChildren();
    element('axis').replaceChildren();
    element('selection').textContent = 'No record selected';
    const empty = element('empty');
    if (dates.length === 0) {
      empty.hidden = false;
      empty.textContent = 'This view has no date field, so there is nothing to place on a time line. Add a start date to its fields, and an end date if there is one.';
      element('summary').textContent = `${records.length} ${records.length === 1 ? 'record' : 'records'} · no date field`;
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
    if (keep !== null && placed.some(p => p.record.id === keep)) highlight(keep);
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
      if (number === latest) element('summary').textContent = `The records could not be read. ${describe(error)}`;
      return;
    }
    if (number !== latest) return;
    try { render(project(list, schema)); } catch {
      element('summary').textContent = 'This chart could not be displayed. Open your records in Nendo.';
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

  if (nendo === undefined) {
    element('summary').textContent = 'This chart runs inside Nendo. Open the screen that shows it.';
    return;
  }
  nendo.ready.then(context => {
    document.documentElement.lang = context.locale || 'en';
    applyTheme(nendo.ui.theme);
    nendo.on('theme', applyTheme);
    // A new context can name other fields or another record type: read again under it.
    nendo.on('context', next => { applyTheme(next.theme); schedule(); });
    nendo.on('changes', schedule);
    return read();
  }).catch(error => { element('summary').textContent = `This chart could not start. ${describe(error)}`; });
})();
