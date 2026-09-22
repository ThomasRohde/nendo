import type { SurfaceNodePlan } from './host';
import { cacheKey, clauseFilters, declaredQuery, type QueryFilter } from './record-window';

// Pure traversal and read composition for summary tiles. A tile states one exact
// number over the records its scope covers, which is never the page in view: a
// surface tile counts everything the surface shows and a board column tile counts
// one column, whichever cards happen to be loaded.
//
// The scope is passed explicitly. The record page's loader used to stand in for it
// with the selected record's ID, which meant a tile on a list had to be given a
// record it had nothing to do with.

/** The whole record type, as a record page tile has always meant. */
export interface PageTileScope { kind: 'page' }
/** The related records of one selected record. */
export interface RelationTileScope { kind: 'relation'; recordId: string; relation: SurfaceNodePlan }
/** Everything the selected list or board shows. */
export interface SurfaceTileScope { kind: 'surface'; surface: SurfaceNodePlan }
/**
 * A tile on the front page, which names the record type it reads because the
 * surface it sits on has none to lend it.
 */
export interface OverviewTileScope { kind: 'overview'; entityId: string }
/** One board column, addressed by its stored choice ID — null for Ungrouped. */
export interface GroupTileScope {
  kind: 'group';
  surface: SurfaceNodePlan;
  groupByFieldId: string;
  groupId: string | null;
}

export type TileScope =
  | PageTileScope | RelationTileScope | SurfaceTileScope | GroupTileScope | OverviewTileScope;

export interface ScopedTile { tile: SurfaceNodePlan; scope: TileScope }

/** One exact read: the record type, the aggregate and the effective filters. */
export interface TileRead {
  entityId: string;
  aggregate: string;
  fieldId: string | null;
  filters: QueryFilter[];
}

const property = (node: SurfaceNodePlan, key: string): string | null =>
  typeof node.properties[key] === 'string' ? (node.properties[key] as string) : null;

const directTiles = (node: SurfaceNodePlan): SurfaceNodePlan[] =>
  node.children.filter((child) => child.kind === 'summaryTile');

/** The declared scope of a list or board tile. An absent scope is the default. */
export function declaredScope(tile: SurfaceNodePlan): 'surface' | 'group' {
  return property(tile, 'scope') === 'group' ? 'group' : 'surface';
}

/** Tiles that count the whole selected surface, in declared order. */
export function surfaceScopedTiles(surface: SurfaceNodePlan | null): SurfaceNodePlan[] {
  return surface === null ? [] : directTiles(surface).filter((tile) => declaredScope(tile) === 'surface');
}

/**
 * Tiles that count one column. Only a direct child of a board can declare this —
 * the compiler refuses it elsewhere — so there is no ancestor search here either.
 */
export function groupScopedTiles(surface: SurfaceNodePlan | null): SurfaceNodePlan[] {
  return surface === null || surface.kind !== 'boardSurface'
    ? []
    : directTiles(surface).filter((tile) => declaredScope(tile) === 'group');
}

/**
 * Tiles anywhere on a record page, each with the scope it actually covers: the
 * whole record type, or the relation it sits inside.
 */
export function pageScopedTiles(page: SurfaceNodePlan | null, recordId: string): ScopedTile[] {
  if (page === null) return [];
  const walk = (nodes: SurfaceNodePlan[], relation: SurfaceNodePlan | null): ScopedTile[] =>
    nodes.flatMap((node) => node.kind === 'summaryTile'
      ? [{ tile: node, scope: relation === null ? { kind: 'page' } as TileScope : { kind: 'relation', recordId, relation } }]
      : walk(node.children, node.kind === 'relatedList' ? node : relation));
  return walk(page.children, null);
}

/** The scope of one column's tile. Ungrouped is the null group, not the text "null". */
export function groupTileScope(
  surface: SurfaceNodePlan,
  groupByFieldId: string,
  groupId: string | null,
): GroupTileScope {
  return { kind: 'group', surface, groupByFieldId, groupId };
}

/**
 * The effective filters one tile read carries, composed from its scope. The
 * compiler bounds this composition against the published ceiling, so nothing is
 * dropped or deduplicated here.
 */
export function tileFilters(tile: SurfaceNodePlan, scope: TileScope): QueryFilter[] {
  const own = clauseFilters(tile);
  switch (scope.kind) {
    case 'page':
    // The front page adds no predicate of its own, so a tile there carries only
    // what its author declared — over the whole record type it names.
    case 'overview':
      return own;
    case 'relation': {
      const viaFieldId = property(scope.relation, 'viaFieldId');
      if (viaFieldId === null) return own;
      return [{ fieldId: viaFieldId, operator: 'eq', value: scope.recordId }, ...clauseFilters(scope.relation), ...own];
    }
    case 'surface':
      return [...clauseFilters(scope.surface), ...own];
    case 'group':
      return [
        ...clauseFilters(scope.surface),
        ...own,
        // A column is addressed by its stored choice ID. Its display name names
        // nothing the host stores, and Ungrouped is an absent value: eq null is
        // not how the host asks for that, and would refuse.
        scope.groupId === null
          ? { fieldId: scope.groupByFieldId, operator: 'isNull' }
          : { fieldId: scope.groupByFieldId, operator: 'eq', value: scope.groupId },
      ];
  }
}

/**
 * The record type a tile aggregates: the related one inside a relation, the one
 * the tile itself names on the front page, else the surface's. The surface's is
 * null where there is no surface entity to pass, which is exactly the overview
 * case — so a caller cannot reach here having quietly substituted something.
 */
export function tileEntityId(scope: TileScope, surfaceEntityId: string | null): string | null {
  if (scope.kind === 'relation') return property(scope.relation, 'targetEntityId');
  if (scope.kind === 'overview') return scope.entityId;
  return surfaceEntityId;
}

export function tileRead(tile: SurfaceNodePlan, scope: TileScope, surfaceEntityId: string | null): TileRead | null {
  const entityId = tileEntityId(scope, surfaceEntityId);
  if (entityId === null) return null;
  if (scope.kind === 'relation' && property(scope.relation, 'viaFieldId') === null) return null;
  const aggregate = property(tile, 'aggregate') ?? 'count';
  const fieldId = property(tile, 'fieldId');
  return {
    entityId,
    aggregate,
    // count reads no field, and the compiler refuses a fieldId on it.
    fieldId: aggregate === 'count' ? null : fieldId,
    filters: tileFilters(tile, scope),
  };
}

/**
 * One tile's cache identity, over a structured tuple. Concatenating the pieces
 * could not tell a null group from a column literally named "null", and a
 * semantic ID containing the delimiter collided with a different tile.
 */
export function tileKey(tile: SurfaceNodePlan, scope: TileScope): string {
  switch (scope.kind) {
    case 'page':
      return cacheKey(['tile', tile.semanticId, 'page']);
    case 'relation':
      return cacheKey(['tile', tile.semanticId, 'relation', scope.relation.semanticId, scope.recordId]);
    case 'surface':
      return cacheKey(['tile', tile.semanticId, 'surface', scope.surface.semanticId]);
    case 'group':
      return cacheKey(['tile', tile.semanticId, 'group', scope.surface.semanticId, scope.groupId]);
    case 'overview':
      return cacheKey(['tile', tile.semanticId, 'overview', scope.entityId]);
  }
}

export function tileTitle(tile: SurfaceNodePlan): string {
  const title = property(tile, 'title');
  if (title !== null && title.length > 0) return title;
  const aggregate = property(tile, 'aggregate') ?? 'count';
  return aggregate === 'count' ? 'Count' : aggregate;
}

/**
 * What the number covers, in words. Without it a total over the whole filtered
 * set reads as a count of the cards on screen, which is the one thing it is not.
 */
export function tileScopeLabel(scope: TileScope): string {
  switch (scope.kind) {
    case 'page':
      return 'all records of this type';
    case 'relation':
      return 'all related records';
    case 'surface':
      return 'all matching records, not just this page';
    case 'group':
      return scope.groupId === null
        ? 'all matching records with no value set'
        : 'all matching records in this column';
    case 'overview':
      return 'all matching records of this type';
  }
}

/**
 * A tile whose declared ordering or query cannot be composed is not silently
 * skipped; the caller states it. Exported so the renderer and the preview agree
 * on what unreadable means.
 */
/**
 * A host code that says the number itself cannot be given, not that the read went
 * wrong: a total past what the host holds exactly, or a stored value it will not
 * aggregate lossily. Retrying recomputes the same refusal, so a tile that carries
 * one of these states the reason and offers nothing.
 */
export function isSettledSummaryFailure(code: string): boolean {
  return code === 'aggregate-not-representable' || code === 'aggregate-not-exact';
}

export function tileIsReadable(tile: SurfaceNodePlan, scope: TileScope, surfaceEntityId: string | null): boolean {
  return tileRead(tile, scope, surfaceEntityId) !== null;
}

/** The declared surface query, re-exported so a caller composes one query source. */
export const surfaceQuery = declaredQuery;
