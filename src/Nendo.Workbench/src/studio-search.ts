import { buildSearchIndex } from './actions';
import { state } from './app-state';
import { client } from './client';
import { openRecordFromView } from './extension-ui';
import { escapeAttribute, escapeHtml, messageFor } from './format';
import { WorkbenchHostError, type EntitySnapshot } from './host-types';
import { highlightedSnippet, type SearchPageView } from './search-text';
import { showError } from './shell';

/**
 * Search on Studio's per-type table (ADR-0028): a box in the filter bar that finds this record
 * type's records by any word in their text, best match first, from the file's search index. The
 * results are listed under the bar and the table stays as it is; a result opens the record. The
 * list is redrawn in place, so typing never loses the caret to a page redraw.
 */

const searchTexts = new Map<string, string>();
const pauseMs = 200;
const limit = 20;

export function studioSearchFieldMarkup(entity: EntitySnapshot): string {
  return `<label class="studio-search-field">Search text<input id="studio-search" name="search" type="search" autocomplete="off" spellcheck="false"
    placeholder="Words in any text field" value="${escapeAttribute(searchTexts.get(entity.entityId) ?? '')}" /></label>`;
}

export function studioSearchResultsMarkup(): string {
  return '<div id="studio-search-results" class="studio-search-results" hidden></div>';
}

export function wireStudioSearch(entity: EntitySnapshot): void {
  const input = document.querySelector<HTMLInputElement>('#studio-search');
  const results = document.querySelector<HTMLElement>('#studio-search-results');
  if (input === null || results === null) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;

  const show = (html: string): void => {
    results.innerHTML = html;
    results.hidden = html.length === 0;
    for (const button of results.querySelectorAll<HTMLButtonElement>('[data-search-open]')) {
      button.addEventListener('click', () => void openRecordFromView(entity.entityId, button.dataset.searchOpen!)
        .catch((error: unknown) => showError(messageFor(error))));
    }
    results.querySelector<HTMLButtonElement>('[data-search-build]')?.addEventListener('click', () => {
      void buildSearchIndex();
    });
  };

  const search = async (text: string, mine: number): Promise<void> => {
    let html: string;
    try {
      const page = await client.request<SearchPageView>('data.searchRecords', { text, limit, entityIds: [entity.entityId], fieldIds: [] });
      const nameOf = (fieldId: string): string => entity.fields.find((field) => field.fieldId === fieldId)?.displayName ?? fieldId;
      html = page.items.length === 0
        ? `<p class="query-status" role="status">No ${escapeHtml(entity.displayName)} record holds ${escapeHtml(text)}.</p>`
        : `<p class="query-status" role="status">${page.items.length}${page.nextCursor === null ? '' : '+'} ${page.items.length === 1 ? 'record holds' : 'records hold'} what you typed, best match first.</p>
          <ol class="studio-search-list" aria-label="Search results">${page.items.map((hit) => `<li><button type="button" class="studio-search-hit" data-search-open="${escapeAttribute(hit.recordId)}">
            <strong>${escapeHtml(hit.label ?? hit.recordId)}</strong>
            ${hit.fields.filter((field) => field.snippet !== hit.label).slice(0, 2).map((field) =>
              `<span class="studio-search-snippet"><span class="studio-search-field-name">${escapeHtml(nameOf(field.fieldId))}</span> ${highlightedSnippet(field.snippet, field.ranges)}</span>`).join('')}
          </button></li>`).join('')}</ol>`;
    } catch (error) {
      html = error instanceof WorkbenchHostError && error.code === 'search-index-missing'
        ? `<p class="query-status" role="status">This file has no search index yet. Build it once and Nendo keeps it current after every save.
            ${state.session.capabilities.mutate ? '<button type="button" class="secondary-button" data-search-build>Build the search index</button>' : ''}</p>`
        : `<p class="query-status" role="alert">${escapeHtml(messageFor(error))}</p>`;
    }
    if (mine === sequence && input.isConnected) show(html);
  };

  const schedule = (now: boolean): void => {
    clearTimeout(timer);
    const text = input.value.trim();
    searchTexts.set(entity.entityId, input.value);
    const mine = ++sequence;
    if (text.length === 0) { show(''); return; }
    if (now) void search(text, mine);
    else timer = setTimeout(() => void search(text, mine), pauseMs);
  };

  input.addEventListener('input', () => schedule(false));
  // Enter searches at once and does not apply the filter form the box sits in.
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    schedule(true);
  });
  if (input.value.trim().length > 0) schedule(true);
}
