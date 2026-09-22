import { rankedWindows, recentWindows, state, summaryCounts, surfaceErrors } from './app-state';
import { foldSection, sectionIsOpen } from './fold-state';
import { escapeAttribute, escapeHtml, messageFor } from './format';
import { strip, type ChartStatus } from './chart-kit';
import type { OverviewPlan, RecordPlan, SurfaceNodePlan } from './host';
import {
  nodeEntityId, overviewDescription, overviewTitle, rangeEndKey, rangeEndText, rangeTitle, rankFieldId,
  rankedLimit, rankedMaxKey, rankedTitle, rankedWindowKey, recentLimit, recentTitle, recentWindowKey,
} from './overview-model';
import { drillInto, refreshOverview } from './panels';
import { createReadChase } from './read-chase';
import { applicationPlans, chartPending, overviewPlan, recordPlanOf, tilePending } from './plan-selection';
import { chartStates, chartTables } from './app-state';
import { overviewCharts, overviewRanges, overviewRankedLists, overviewRecentLists, overviewTiles, rangeReads } from './overview-model';
import { chartTileMarkupFor, recordFieldDisplay, summaryTileMarkup } from './record-markup';
import { content, rerender, showError, interactionInProgress } from './shell';
import { isSettledSummaryFailure, type OverviewTileScope } from './summary-tiles';
import { chartKey, isChartKind, rankNumerals, rankProportion, rankValue } from './charts';
import { refreshDerived } from './actions';
import { leaveRecordContext } from './app-state';

/**
 * The file's front page (ADR-0004, 2026-09-14 amendment, S4).
 *
 * It is the one Use surface that is not about a record type, so nothing here
 * reads `plan.entity`: every tile, chart and recent list names the type it reads
 * and is drawn from the entity plans the overview carries. A file without one is
 * not affected by any of this — Use opens on a record type exactly as it did.
 */

const entityOf = (overview: OverviewPlan, entityId: string | null): OverviewPlan['entities'][number] | null =>
  entityId === null ? null : overview.entities.find((entity) => entity.semanticId === entityId) ?? null;

/** Whether a record type has a list to drill into. A type with no surfaces has not. */
const hasPlan = (entityId: string): boolean =>
  applicationPlans().some((plan) => plan.entity.semanticId === entityId);

function rangeMarkup(overview: OverviewPlan, tile: SurfaceNodePlan, scope: OverviewTileScope): string {
  const lowKey = rangeEndKey(tile, scope, 'min');
  const highKey = rangeEndKey(tile, scope, 'max');
  const low = summaryCounts.get(lowKey);
  const high = summaryCounts.get(highKey);
  const failed = [low, high].find((end) => end?.state === 'failed');
  const status: ChartStatus = failed?.state === 'failed'
    ? { state: 'failed', message: failed.message, retry: !isSettledSummaryFailure(failed.code) }
    : low === undefined || high === undefined || low.state === 'loading' || high.state === 'loading'
      ? { state: 'loading' }
      : { state: 'ready' };
  const entity = entityOf(overview, scope.entityId);
  return strip({
    key: lowKey,
    title: rangeTitle(tile),
    context: entity === null ? 'all matching records' : `all matching ${entity.displayName}`,
    status,
    low: low?.state === 'ready' ? rangeEndText(low.value) : null,
    high: high?.state === 'ready' ? rangeEndText(high.value) : null,
    tableOpen: chartTables.has(lowKey),
  });
}

function recentRowMarkup(entity: OverviewPlan['entities'][number], record: RecordPlan, fieldIds: string[]): string {
  const [headingFieldId, ...detailFieldIds] = fieldIds;
  const heading = recordFieldDisplay(record, headingFieldId, entity.derivedFields) || `Untitled ${entity.displayName}`;
  const details = detailFieldIds
    .map((fieldId) => {
      const display = recordFieldDisplay(record, fieldId, entity.derivedFields);
      const name = entity.fields.find((field) => field.semanticId === fieldId)?.displayName ?? fieldId;
      return display === '' ? '' : `<span><small>${escapeHtml(name)}</small>${escapeHtml(display)}</span>`;
    })
    .join('');
  return `<li><button type="button" class="recent-row" data-overview-record="${escapeAttribute(record.semanticId)}" data-overview-entity="${escapeAttribute(entity.semanticId)}" aria-label="Open ${escapeAttribute(heading)}"><strong>${escapeHtml(heading)}</strong>${details === '' ? '' : `<span class="recent-values">${details}</span>`}</button></li>`;
}

function recentListMarkup(overview: OverviewPlan, node: SurfaceNodePlan): string {
  const entity = entityOf(overview, nodeEntityId(node));
  const title = recentTitle(node);
  const failure = surfaceErrors.get(node.semanticId);
  const window = recentWindows.get(recentWindowKey(node));
  const fieldIds = node.children
    .filter((child) => child.kind === 'fieldBinding')
    .map((child) => (typeof child.properties.fieldId === 'string' ? child.properties.fieldId : ''))
    .filter((fieldId) => fieldId !== '');
  const body = entity === null
    ? '<p class="empty-note">This list names a record type this file does not have.</p>'
    : failure !== undefined
      ? `<p class="empty-note" role="alert">${escapeHtml(failure)}</p>`
      : window === undefined
        ? '<p class="empty-note" aria-busy="true">Loading…</p>'
        : window.page.items.length === 0
          ? `<p class="empty-note">No ${escapeHtml(entity.displayName)} yet.</p>`
          : `<ul class="recent-list">${window.page.items
            .slice(0, recentLimit(node))
            .map((record) => recentRowMarkup(entity, recordPlanOf(record), fieldIds))
            .join('')}</ul>`;
  // What the list covers is stated, because "the five most recent" is a claim
  // about an order, and the order is the author's rather than the reader's guess.
  const context = entity === null ? '' : `<span class="summary-context">up to ${recentLimit(node)} of ${escapeHtml(entity.displayName)}</span>`;
  return `<section class="overview-recent" data-recent="${escapeAttribute(node.semanticId)}"><header><span class="summary-title">${escapeHtml(title)}</span>${context}</header>${body}</section>`;
}

/**
 * One ranking on the front page: the top few records by one number, each with a bar
 * against the exact largest.
 *
 * Two answers make it, and it waits for both. The window is one page of records in rank
 * order; the maximum is about everything the ranking covers, not about the page, so a bar
 * means the same thing however many rows are shown. When the largest value is not greater
 * than zero, no bars are drawn at all and every row states its number instead.
 */
function rankedListMarkup(overview: OverviewPlan, node: SurfaceNodePlan): string {
  const entity = entityOf(overview, nodeEntityId(node));
  const title = rankedTitle(node);
  const failure = surfaceErrors.get(node.semanticId);
  const window = rankedWindows.get(rankedWindowKey(node));
  const largest = summaryCounts.get(rankedMaxKey(node));
  const rankBy = rankFieldId(node);
  const fieldIds = node.children
    .filter((child) => child.kind === 'fieldBinding')
    .map((child) => (typeof child.properties.fieldId === 'string' ? child.properties.fieldId : ''))
    .filter((fieldId) => fieldId !== '');
  const body = entity === null || rankBy === null
    ? '<p class="empty-note">This ranking names a record type this file does not have.</p>'
    : failure !== undefined
      ? `<p class="empty-note" role="alert">${escapeHtml(failure)}</p>`
      : window === undefined || largest === undefined || largest.state === 'loading'
        ? '<p class="empty-note" aria-busy="true">Loading…</p>'
        : largest.state === 'failed'
          ? `<p class="empty-note" role="alert">${escapeHtml(largest.message)}</p>`
          : rankedRowsMarkup(entity, window.page.items.slice(0, rankedLimit(node)).map(recordPlanOf),
            rankBy, fieldIds, rankValue(largest.value) ?? 0);
  const rankName = entity?.fields.find((field) => field.semanticId === rankBy)?.displayName ?? '';
  const context = entity === null
    ? ''
    : `<span class="summary-context">top ${rankedLimit(node)} of ${escapeHtml(entity.displayName)}${rankName === '' ? '' : ` by ${escapeHtml(rankName)}`}</span>`;
  return `<section class="overview-ranked" data-ranked="${escapeAttribute(node.semanticId)}"><header><span class="summary-title">${escapeHtml(title)}</span>${context}</header>${body}</section>`;
}

function rankedRowsMarkup(
  entity: OverviewPlan['entities'][number],
  records: RecordPlan[],
  rankByFieldId: string,
  fieldIds: string[],
  largest: number,
): string {
  if (records.length === 0) return `<p class="empty-note">No ${escapeHtml(entity.displayName)} has a number to rank.</p>`;
  const values = records.map((record) => rankValue(record.values[rankByFieldId]));
  const numerals = rankNumerals(values);
  // A maximum that is not positive means no bar is honest, so none is drawn and the
  // numbers carry the whole of it.
  const bars = largest > 0;
  const [headingFieldId, ...detailFieldIds] = fieldIds.length > 0 ? fieldIds : [''];
  return `<ol class="ranked-list"${bars ? '' : ' data-bars="none"'}>${records.map((record, index) => {
    const heading = headingFieldId === ''
      ? `Untitled ${entity.displayName}`
      : recordFieldDisplay(record, headingFieldId, entity.derivedFields) || `Untitled ${entity.displayName}`;
    const amount = recordFieldDisplay(record, rankByFieldId, entity.derivedFields);
    const details = detailFieldIds
      .filter((fieldId) => fieldId !== rankByFieldId)
      .map((fieldId) => {
        const display = recordFieldDisplay(record, fieldId, entity.derivedFields);
        return display === '' ? '' : `<span>${escapeHtml(display)}</span>`;
      })
      .join('');
    const width = rankProportion(values[index], largest);
    return `<li><button type="button" class="ranked-row" data-overview-record="${escapeAttribute(record.semanticId)}" data-overview-entity="${escapeAttribute(entity.semanticId)}" aria-label="${escapeAttribute(`${heading}, ranked ${numerals[index]}, ${amount === '' ? 'no value' : amount}`)}">` +
      `<span class="ranked-numeral" aria-hidden="true">${numerals[index]}</span>` +
      `<span class="ranked-body"><strong>${escapeHtml(heading)}</strong>${details === '' ? '' : `<span class="recent-values">${details}</span>`}` +
      `${bars ? `<span class="ranked-bar" aria-hidden="true"><span class="ranked-bar-fill" style="width: ${width.toFixed(2)}%"></span></span>` : ''}</span>` +
      `<span class="ranked-value">${escapeHtml(amount === '' ? '—' : amount)}</span></button></li>`;
  }).join('')}</ol>`;
}

/**
 * One level of the front page, in declared order. Tiles, charts and ranges gather
 * into one row as they do on a surface; a recent list is its own block, and a
 * section or a tab group draws its own children the same way.
 */
function levelMarkup(overview: OverviewPlan, nodes: SurfaceNodePlan[]): string {
  const parts: string[] = [];
  let row: string[] = [];
  const flushRow = (): void => {
    if (row.length > 0) parts.push(`<div class="summary-tiles">${row.join('')}</div>`);
    row = [];
  };
  for (const node of nodes) {
    const entityId = nodeEntityId(node);
    const scope: OverviewTileScope | null = entityId === null ? null : { kind: 'overview', entityId };
    if (scope !== null && node.kind === 'summaryTile') { row.push(summaryTileMarkup(node, scope)); continue; }
    if (scope !== null && node.kind === 'rangeTile') { row.push(rangeMarkup(overview, node, scope)); continue; }
    if (scope !== null && isChartKind(node.kind)) {
      const entity = entityOf(overview, entityId);
      row.push(chartTileMarkupFor({
        fields: entity?.fields ?? [],
        names: (fieldId) => entity?.fields.find((field) => field.semanticId === fieldId)?.displayName ?? fieldId,
        drillable: entityId !== null && hasPlan(entityId),
      }, { node, scope }));
      continue;
    }
    flushRow();
    if (node.kind === 'recentList') { parts.push(recentListMarkup(overview, node)); continue; }
    if (node.kind === 'rankedList') { parts.push(rankedListMarkup(overview, node)); continue; }
    if (node.kind === 'section') {
      const title = typeof node.properties.title === 'string' ? node.properties.title : '';
      // A disclosure: the heading is the control, and a closed section draws its
      // children but reads nothing for them until it is opened.
      // The layout sits on a body of its own: a details element given a flex or grid
      // display of its own keeps drawing its content when closed.
      parts.push(`<details class="overview-section" data-section="${escapeAttribute(node.semanticId)}" ${sectionIsOpen(node) ? 'open' : ''}><summary><h3>${escapeHtml(title)}</h3></summary><div class="overview-section-body">${levelMarkup(overview, node.children)}</div></details>`);
      continue;
    }
    if (node.kind === 'tabGroup') parts.push(levelMarkup(overview, node.children));
  }
  flushRow();
  return parts.join('');
}

export function overviewMarkup(overview: OverviewPlan): string {
  const description = overviewDescription(overview);
  return `<div class="overview-page" data-testid="overview-page">
    <header class="overview-header"><h2>${escapeHtml(overviewTitle(overview))}</h2>${description === null ? '' : `<p class="overview-description">${escapeHtml(description)}</p>`}</header>
    ${levelMarkup(overview, overview.surface.children)}
  </div>`;
}

/**
 * Open the record type a front-page row belongs to, at that record. The overview
 * is left behind rather than kept beside it: a record is edited on its own type's
 * surface, which is where its form, its commands and its related records are.
 */
function openRecord(entityId: string, recordId: string): void {
  if (!hasPlan(entityId)) return;
  state.showOverview = false;
  state.selectedApplicationEntity = entityId;
  leaveRecordContext();
  state.selectedRecordId = recordId;
  void (async () => { await refreshDerived(); rerender(); })().catch((error) => showError(messageFor(error)));
}

/** The front page, and the reads that fill it. */
export function renderOverview(overview: OverviewPlan): void {
  const plans = applicationPlans();
  content.innerHTML = `<div class="use-page" data-testid="semantic-application">
    <header class="use-toolbar"><div class="toolbar-group"><label class="select-field">Showing<select id="use-entity"><option value="" selected>${escapeHtml(overviewTitle(overview))}</option>${plans.map((app) => `<option value="${escapeAttribute(app.entity.semanticId)}">${escapeHtml(app.entity.displayName)}</option>`).join('')}</select></label></div></header>
    <div class="message-slot use-message" role="alert" hidden></div>
    <div class="use-layout"><section class="use-surface overview-surface">${overviewMarkup(overview)}</section></div>
  </div>`;

  const picker = content.querySelector<HTMLSelectElement>('#use-entity');
  picker?.addEventListener('change', (event) => {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (value === '') return;
    state.showOverview = false;
    state.selectedApplicationEntity = value;
    leaveRecordContext();
    void (async () => { await refreshDerived(); rerender(); })().catch((error) => showError(messageFor(error)));
  });
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-overview-record]'))
    button.addEventListener('click', () => openRecord(button.dataset.overviewEntity!, button.dataset.overviewRecord!));
  // A fold is remembered for the open file and redrawn: opening a section makes what
  // it holds pending, and the redraw is what starts the chase that reads it. The
  // front page holds no draft, so a redraw here loses nothing.
  // Chromium fires toggle on a details inserted open, so a redraw would count as a
  // fold and redraw again for ever: only a change from what was drawn is a fold.
  for (const fold of content.querySelectorAll<HTMLDetailsElement>('details[data-section]')) {
    let drawn = fold.open;
    fold.addEventListener('toggle', () => {
      if (fold.open === drawn) return;
      drawn = fold.open;
      foldSection(fold.dataset.section!, fold.open);
      rerender();
    });
  }

  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-summary-retry], [data-chart-retry]'))
    button.addEventListener('click', () => {
      const key = button.dataset.summaryRetry ?? button.dataset.chartRetry;
      if (key === undefined || state.actionInFlight) return;
      summaryCounts.delete(key);
      chartStates.delete(key);
      void refreshOverview(overview).then(rerender).catch((error) => showError(messageFor(error)));
    });
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-chart-table]'))
    button.addEventListener('click', () => {
      const key = button.dataset.chartTable;
      if (key === undefined) return;
      if (chartTables.has(key)) chartTables.delete(key); else chartTables.add(key);
      rerender();
      content.querySelector<HTMLElement>(`[data-chart-table="${CSS.escape(key)}"]`)?.focus();
    });
  // A chart on the front page drills into the record type it reads, which means
  // leaving the front page: the narrowed list is that type's, and it is shown
  // where that type's records are shown.
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-chart-drill]'))
    button.addEventListener('click', () => {
      const key = button.dataset.chartDrill;
      if (key === undefined || state.actionInFlight) return;
      const scoped = overviewCharts(overview).find((candidate) => chartKey(candidate.node, candidate.scope) === key);
      if (scoped === undefined || scoped.scope.kind !== 'overview') return;
      const target = applicationPlans().find((plan) => plan.entity.semanticId === (scoped.scope as OverviewTileScope).entityId);
      if (target === undefined) return;
      const group = button.dataset.chartRing === 'true'
        ? null
        : { key: button.dataset.chartUnset === 'true' ? null : (button.dataset.chartGroup ?? '') };
      state.showOverview = false;
      state.selectedApplicationEntity = target.entity.semanticId;
      void drillInto(target, scoped, group);
    });

  // Only read what is not already answered for this change sequence, or the
  // re-render after a load would ask for the same numbers again, for ever.
  // Bounded rather than immediate. A file being written to continuously never
  // satisfies overviewPending, so redrawing the moment a pass finishes is a loop
  // with nothing to end it — the one that stopped the view.
  if (overviewPending(overview))
    overviewChase.run(() => refreshOverview(overview), rerender, (error) => showError(messageFor(error)), interactionInProgress);
}

/** Whether anything on the front page is still to be read for the current file state. */
/** The front page's own chase, so its tiles cannot redraw faster than once a second. */
const overviewChase = createReadChase();

export function overviewPending(overview: OverviewPlan): boolean {
  const sequence = state.session.manifest?.changeSequence;
  const endPending = overviewRanges(overview).some((scoped) => {
    const scope = scoped.scope as OverviewTileScope;
    if (rangeReads(scoped.tile, scope) === null) return false;
    return (['min', 'max'] as const).some((end) => {
      const known = summaryCounts.get(rangeEndKey(scoped.tile, scope, end));
      return known === undefined || known.state === 'failed' ||
        (known.state === 'ready' && known.changeSequence !== sequence);
    });
  });
  const recentPending = overviewRecentLists(overview).some((node) =>
    recentWindows.get(recentWindowKey(node))?.page.changeSequence !== sequence &&
    surfaceErrors.get(node.semanticId) === undefined);
  const rankedPending = overviewRankedLists(overview).some((node) => {
    if (surfaceErrors.get(node.semanticId) !== undefined) return false;
    if (rankedWindows.get(rankedWindowKey(node))?.page.changeSequence !== sequence) return true;
    const largest = summaryCounts.get(rankedMaxKey(node));
    return largest === undefined || largest.state === 'failed' ||
      (largest.state === 'ready' && largest.changeSequence !== sequence);
  });
  return overviewTiles(overview).some(tilePending) || overviewCharts(overview).some(chartPending) ||
    endPending || recentPending || rankedPending;
}

/** Whether Use should open on the front page: there is one, and nothing else is chosen. */
export function showsOverview(): boolean {
  return state.showOverview === true && overviewPlan() !== null;
}
