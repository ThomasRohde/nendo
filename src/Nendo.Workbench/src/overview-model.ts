import type { CompileResult, OverviewPlan, SurfaceNodePlan } from './host';
import { sectionIsOpen } from './fold-state';
import { cacheKey, declaredQuery, type WindowQuery } from './record-window';
import { isChartKind, type ScopedChart } from './charts';
import { tileFilters, tileKey, type OverviewTileScope, type ScopedTile, type TileRead } from './summary-tiles';

// Pure composition for the file's front page (ADR-0004, 2026-09-14 amendment, S4).
//
// The overview is the one surface with no record type of its own, so everything
// here answers the same question twice: which record type does this node read,
// and what does it read of it. The scope that carries the answer is the tile
// scope every other surface already uses, with the entity on it rather than on
// the surface, so the reads, the cache keys and the failure states are the ones
// the renderer already has.

/** The front page of a compilation, when it has one. */
export function overviewOf(compilation: CompileResult | null): OverviewPlan | null {
  return compilation?.isValid === true ? compilation.overview ?? null : null;
}

const property = (node: SurfaceNodePlan, key: string): string | null =>
  typeof node.properties[key] === 'string' ? (node.properties[key] as string) : null;

const numeric = (node: SurfaceNodePlan, key: string): number | null =>
  typeof node.properties[key] === 'number' ? (node.properties[key] as number) : null;

export function overviewTitle(overview: OverviewPlan): string {
  return property(overview.surface, 'title') ?? 'Overview';
}

/**
 * What this file is for, in the author's words. Prose, not markup and not a
 * template: it is rendered as text, and an absent one is absent rather than
 * replaced with something derived from the file name.
 */
export function overviewDescription(overview: OverviewPlan): string | null {
  const value = property(overview.surface, 'description');
  return value !== null && value.length > 0 ? value : null;
}

/** The record type a front-page node reads. Every one of them declares it. */
export function nodeEntityId(node: SurfaceNodePlan): string | null {
  return property(node, 'entityId');
}

function overviewScope(node: SurfaceNodePlan): OverviewTileScope | null {
  const entityId = nodeEntityId(node);
  return entityId === null ? null : { kind: 'overview', entityId };
}

/**
 * Walks the front page in declared order, visiting sections and tab groups on the
 * way. Nothing here searches upward for an entity: a node that does not name one
 * is skipped, because the compiler has already refused that definition and a
 * renderer inventing a record type would be answering a question nobody asked.
 */
function walk<T>(nodes: SurfaceNodePlan[], take: (node: SurfaceNodePlan) => T | null): T[] {
  return nodes.flatMap((node) => {
    const taken = take(node);
    if (taken !== null) return [taken];
    // A closed section is not walked: what it holds is not read until it is opened.
    if (node.kind === 'section') return sectionIsOpen(node) ? walk(node.children, take) : [];
    return node.kind === 'tabGroup' ? walk(node.children, take) : [];
  });
}

/** Summary tiles anywhere on the front page, each scoped to the type it names. */
export function overviewTiles(overview: OverviewPlan | null): ScopedTile[] {
  if (overview === null) return [];
  return walk(overview.surface.children, (node) => {
    if (node.kind !== 'summaryTile') return null;
    const scope = overviewScope(node);
    return scope === null ? null : { tile: node, scope };
  });
}

/** Every chart kind anywhere on the front page: breakdowns, rings, trends and activity grids. */
export function overviewCharts(overview: OverviewPlan | null): ScopedChart[] {
  if (overview === null) return [];
  return walk(overview.surface.children, (node) => {
    if (!isChartKind(node.kind)) return null;
    const scope = overviewScope(node);
    return scope === null ? null : { node, scope };
  });
}

/** Range tiles anywhere on the front page. */
export function overviewRanges(overview: OverviewPlan | null): ScopedTile[] {
  if (overview === null) return [];
  return walk(overview.surface.children, (node) => {
    if (node.kind !== 'rangeTile') return null;
    const scope = overviewScope(node);
    return scope === null ? null : { tile: node, scope };
  });
}

/** Recent lists anywhere on the front page. */
export function overviewRecentLists(overview: OverviewPlan | null): SurfaceNodePlan[] {
  if (overview === null) return [];
  return walk(overview.surface.children, (node) =>
    node.kind === 'recentList' && nodeEntityId(node) !== null ? node : null);
}

/**
 * A range is two exact reads of one field, not one: the host answers min and max
 * separately, and the strip is drawn only when both have answered. Drawing one
 * end would state a bound as though it were a range.
 */
export function rangeReads(tile: SurfaceNodePlan, scope: OverviewTileScope): { min: TileRead; max: TileRead } | null {
  const fieldId = property(tile, 'fieldId');
  if (fieldId === null) return null;
  const filters = tileFilters(tile, scope);
  return {
    min: { entityId: scope.entityId, aggregate: 'min', fieldId, filters },
    max: { entityId: scope.entityId, aggregate: 'max', fieldId, filters },
  };
}

/**
 * One end's cache identity. It extends the tile's own key rather than replacing
 * it, so the two ends of one strip stay together and neither can collide with a
 * summary tile that happens to read the same field.
 */
export function rangeEndKey(tile: SurfaceNodePlan, scope: OverviewTileScope, end: 'min' | 'max'): string {
  return cacheKey([tileKey(tile, scope), end]);
}

/**
 * One end of a range as a person reads it. The host answers an exact lexeme, which
 * for a number is the digits themselves and for a civil date is that date as a
 * JSON string — quotes and all, because the lexeme is the raw text and every digit
 * of a number has to survive it. A date is shown as the date; a number is shown
 * exactly as it was answered, so no trailing zero is lost on the way to the screen.
 */
export function rangeEndText(lexeme: string | null): string | null {
  if (lexeme === null) return null;
  if (lexeme.length >= 2 && lexeme.startsWith('"') && lexeme.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(lexeme);
      if (typeof parsed === 'string') return parsed;
    } catch {
      // An unparsable lexeme is shown as it came rather than guessed at.
    }
  }
  return lexeme;
}

export function rangeTitle(tile: SurfaceNodePlan): string {
  return property(tile, 'title') ?? 'Range';
}

/** The maximum a recent list may show. The host refuses more; this never narrows one. */
export const recentListCeiling = 10;

/**
 * How many records a recent list shows. An absent limit means the ceiling, which
 * is what the published note says; a declared one is used as declared, because
 * the host refused anything outside the range rather than clamping it.
 */
export function recentLimit(node: SurfaceNodePlan): number {
  return numeric(node, 'limit') ?? recentListCeiling;
}

export function recentTitle(node: SurfaceNodePlan): string {
  return property(node, 'title') ?? 'Recent';
}

/** One recent list's read: the record type it names, and the window a list would read. */
export interface RecentRead { entityId: string; query: WindowQuery; limit: number }

export function recentRead(node: SurfaceNodePlan): RecentRead | null {
  const entityId = nodeEntityId(node);
  if (entityId === null) return null;
  return { entityId, query: declaredQuery(node), limit: recentLimit(node) };
}

/** Ranked lists anywhere on the front page. */
export function overviewRankedLists(overview: OverviewPlan | null): SurfaceNodePlan[] {
  if (overview === null) return [];
  return walk(overview.surface.children, (node) =>
    node.kind === 'rankedList' && nodeEntityId(node) !== null ? node : null);
}

/** The maximum a ranked list may rank. The host refuses more; this never narrows one. */
export const rankedListCeiling = 50;

export function rankedLimit(node: SurfaceNodePlan): number {
  return numeric(node, 'limit') ?? rankedListCeiling;
}

export function rankedTitle(node: SurfaceNodePlan): string {
  return property(node, 'title') ?? 'Ranking';
}

/** The field a ranking is by. Every bar on the list is a proportion of its largest value. */
export function rankFieldId(node: SurfaceNodePlan): string | null {
  return property(node, 'rankByFieldId');
}

/**
 * One ranking's read: the record type it names, and a window ordered by the rank field.
 *
 * The isNotNull predicate is the host's, not the author's — a record with no number
 * cannot be ranked against one, and leaving it in would put an empty row at one end of
 * every ranking. It is why the compiler gives a ranking seven authored clauses where a
 * tile elsewhere has eight.
 */
export interface RankedRead { entityId: string; query: WindowQuery; limit: number; rankByFieldId: string }

export function rankedRead(node: SurfaceNodePlan): RankedRead | null {
  const entityId = nodeEntityId(node);
  const rankByFieldId = rankFieldId(node);
  if (entityId === null || rankByFieldId === null) return null;
  const declared = declaredQuery(node);
  return {
    entityId,
    rankByFieldId,
    limit: rankedLimit(node),
    query: {
      filters: [...declared.filters, { fieldId: rankByFieldId, operator: 'isNotNull' }],
      sortFieldId: rankByFieldId,
      // Largest first unless the author said otherwise: a leaderboard counts down.
      descending: property(node, 'orderDirection') === 'ascending' ? undefined : true,
    },
  };
}

/** A ranking's window key, carrying the limit for the reason a recent list's does. */
export function rankedWindowKey(node: SurfaceNodePlan): string {
  return cacheKey(['ranked', node.semanticId, nodeEntityId(node), rankFieldId(node), rankedLimit(node)]);
}

/**
 * The one exact aggregate a ranking reads besides its window: the largest value over
 * everything it covers, which every bar is a proportion of. It is read separately
 * because the window is one page and the maximum is about the whole set — a bar drawn
 * against the largest value on the page would rescale itself as the page changed.
 */
export function rankedMaxRead(node: SurfaceNodePlan): TileRead | null {
  const read = rankedRead(node);
  if (read === null) return null;
  return { entityId: read.entityId, aggregate: 'max', fieldId: read.rankByFieldId, filters: read.query.filters };
}

export function rankedMaxKey(node: SurfaceNodePlan): string {
  return cacheKey(['ranked-max', node.semanticId, nodeEntityId(node), rankFieldId(node)]);
}

/**
 * A recent list's window key. It carries the limit as well as the node, because
 * two definitions of the same list differing only in how many rows they show are
 * two different windows, and the shorter one must not be served from the longer
 * one's page.
 */
export function recentWindowKey(node: SurfaceNodePlan): string {
  return cacheKey(['recent', node.semanticId, nodeEntityId(node), recentLimit(node)]);
}
