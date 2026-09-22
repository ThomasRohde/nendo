import type { EntitySnapshot, ReadPage, RecordSnapshot } from './host';

type Field = EntitySnapshot['fields'][number];
type Query = (payload: Record<string, unknown>) => Promise<ReadPage<RecordSnapshot>>;
const escape = (value: string): string => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function referenceControl(field: Field, value: string): string {
  return `<div class="reference-control" data-reference-field="${escape(field.fieldId)}">
    <span class="field-label">${escape(field.displayName)}</span>
    <input type="hidden" name="${escape(field.fieldId)}" value="${escape(value)}" />
    ${field.reference ? `<div class="reference-value">
      <span class="reference-selected${value ? '' : ' is-unset'}">${escape(value || 'Not set')}</span>
      <span class="reference-actions"><button type="button" class="secondary-button reference-choose">Choose record</button>${field.required ? '' : '<button type="button" class="text-button reference-clear">Clear</button>'}</span>
    </div>
    <section class="reference-picker" hidden aria-label="Choose ${escape(field.displayName)}"><div class="reference-search-row"><label class="reference-search-label">Find a record<input type="search" maxlength="200" class="reference-search" placeholder="Search by label" /></label><button type="button" class="secondary-button reference-find">Search</button></div><div class="reference-results"></div><p class="reference-status" role="status"></p><div class="reference-pager"><button type="button" class="text-button reference-previous">Previous</button><button type="button" class="text-button reference-next">Next</button><button type="button" class="text-button reference-cancel">Cancel</button></div></section>`
      : `<span class="reference-selected is-unset">${escape(value || 'Not set')}</span><p class="reference-unconfigured">Choose a target type and label in Structure before assigning this field.</p>`}
  </div>`;
}

export function wireReferenceControls(form: HTMLFormElement, fields: Field[], query: Query): void {
  for (const root of form.querySelectorAll<HTMLElement>('[data-reference-field]')) {
    const field = fields.find(field => field.fieldId === root.dataset.referenceField);
    if (!field?.reference) continue;
    const reference = field.reference;
    const input = root.querySelector<HTMLInputElement>('input[type=hidden]')!;
    const selected = root.querySelector<HTMLElement>('.reference-selected')!;
    const choose = root.querySelector<HTMLButtonElement>('.reference-choose')!;
    const panel = root.querySelector<HTMLElement>('.reference-picker')!;
    const search = root.querySelector<HTMLInputElement>('.reference-search')!;
    const status = root.querySelector<HTMLElement>('.reference-status')!;
    const results = root.querySelector<HTMLElement>('.reference-results')!;
    const previous = root.querySelector<HTMLButtonElement>('.reference-previous')!;
    const next = root.querySelector<HTMLButtonElement>('.reference-next')!;
    let request = 0;
    let nextCursor: string | null = null;
    let cursors: Array<string | null> = [null];
    const label = (record: RecordSnapshot): string => `${String(record.values[reference.labelFieldId] ?? '(No label)')} · ${record.recordId}`;
    const hide = (): void => { panel.hidden = true; ++request; choose.focus(); };
    const select = (record: RecordSnapshot | null): void => {
      input.value = record?.recordId ?? '';
      root.dataset.targetVersion = record ? String(record.recordVersion) : '';
      selected.textContent = record ? label(record) : 'Not set';
      selected.classList.toggle('is-unset', record === null);
      input.dispatchEvent(new Event('change', { bubbles: true }));
      hide();
    };
    const load = async (): Promise<void> => {
      const generation = ++request;
      status.textContent = 'Loading records…'; results.replaceChildren(); previous.disabled = true; next.disabled = true;
      try {
        const page = await query({ entityId: reference.targetEntityId, limit: 25, cursor: cursors.at(-1),
          sortFieldId: reference.labelFieldId, filters: search.value ? [{ fieldId: reference.labelFieldId, operator: 'contains', value: search.value }] : [] });
        if (!root.isConnected || generation !== request) return;
        nextCursor = page.nextCursor;
        for (const record of page.items) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'reference-result';
          button.textContent = label(record); button.addEventListener('click', () => select(record)); results.append(button);
        }
        status.textContent = page.items.length ? `${page.items.length} records · Page ${cursors.length}` : 'No matching records.';
        previous.disabled = cursors.length < 2; next.disabled = nextCursor === null;
      } catch (error) {
        if (!root.isConnected || generation !== request) return;
        status.textContent = `${error instanceof Error ? error.message : 'Unable to load records.'} Search again to restart.`;
      }
    };
    choose.addEventListener('click', () => { panel.hidden = false; cursors = [null]; search.focus(); void load(); });
    root.querySelector('.reference-clear')?.addEventListener('click', () => select(null));
    root.querySelector('.reference-cancel')!.addEventListener('click', hide);
    const find = (): void => { cursors = [null]; void load(); };
    root.querySelector('.reference-find')!.addEventListener('click', find);
    search.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); find(); } });
    panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); hide(); } });
    previous.addEventListener('click', () => { cursors.pop(); void load(); });
    next.addEventListener('click', () => { if (nextCursor) { cursors.push(nextCursor); void load(); } });
    if (input.value) {
      const original = input.value;
      void query({ entityId: reference.targetEntityId, recordId: original, limit: 1 }).then(page => {
        if (root.isConnected && input.value === original && !root.dataset.targetVersion) {
          selected.textContent = page.items[0] ? label(page.items[0]) : `Unavailable target · ${original}`;
          selected.classList.remove('is-unset');
        }
      }).catch(() => { /* Keep the stable ID visible; never guess a label or target version. */ });
    }
  }
}

export function referenceVersions(form: HTMLFormElement, values: Record<string, unknown>): Record<string, number> {
  const result: Record<string, number> = {};
  for (const root of form.querySelectorAll<HTMLElement>('[data-reference-field]')) {
    const id = root.dataset.referenceField!;
    if (values[id] != null && values[id] !== '' && root.dataset.targetVersion)
      result[id] = Number(root.dataset.targetVersion);
  }
  return result;
}
