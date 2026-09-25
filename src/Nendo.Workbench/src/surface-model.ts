import type { ApplicationPlan, FieldPlan, SurfaceNodePlan } from './host';

// Pure plan-shape resolution shared by the Use renderer. Surfaces are an ordered
// node tree; there are no fixed slots to read instead.

/** The first root of a kind, in compiled order. */
export function surfaceRoot(plan: ApplicationPlan, kind: string): SurfaceNodePlan | null {
  return plan.surfaces?.find((node) => node.kind === kind) ?? null;
}

/** Every root kind Use can show as a whole surface, in the order they appear. */
const useKinds = ['recordList', 'boardSurface', 'calendarSurface', 'timelineSurface', 'gallerySurface', 'matrixSurface', 'extensionGraphSurface', 'extensionRecordsSurface'];

/**
 * A custom view of either shape (ADR-0013): a graph, or one record type as typed columns.
 * Either fills its Use screen with a frame running the view's code from the file, and reads
 * its records itself, so the Workbench opens no record window for it.
 */
export function isCustomViewKind(kind: string | undefined): boolean {
  return kind === 'extensionGraphSurface' || kind === 'extensionRecordsSurface';
}

/**
 * A calendar and a timeline read their own bounded pages, keyed by the range
 * and mode in view, rather than one window per surface: their records are what
 * they have accumulated so far, and the surface says whether that is all.
 */
export function accumulatesPages(kind: string): boolean {
  return kind === 'calendarSurface' || kind === 'timelineSurface';
}

/**
 * The surfaces Use offers for one entity, in compiled order. An entity may own
 * eight of each kind, so the first of a kind is a default rather than the answer:
 * resolving by kind alone left seven of eight lists unreachable.
 */
export function useSurfaces(plan: ApplicationPlan): SurfaceNodePlan[] {
  return (plan.surfaces ?? []).filter((node) => useKinds.includes(node.kind));
}

/** One surface by its stable semantic ID, or null when the definition no longer has it. */
export function surfaceById(plan: ApplicationPlan, surfaceId: string | null): SurfaceNodePlan | null {
  if (surfaceId === null) return null;
  return useSurfaces(plan).find((node) => node.semanticId === surfaceId) ?? null;
}

/**
 * The surface a remembered choice resolves to: the chosen one when it is still
 * there, otherwise the first eligible root. The remembered choice is not
 * rewritten here — a surface removed by one proposal and restored by the next
 * comes back to the same selection.
 */
export function resolveSurface(plan: ApplicationPlan, surfaceId: string | null): SurfaceNodePlan | null {
  return surfaceById(plan, surfaceId) ?? useSurfaces(plan)[0] ?? null;
}

export function bindingFieldId(node: SurfaceNodePlan): string | null {
  const value = node.properties.fieldId;
  return typeof value === 'string' ? value : null;
}

// A version 3 list declares its own columns in the tree. Falling through to every
// field of the record type would show whichever field sorts first as the heading.
export function nodeFieldIds(node: SurfaceNodePlan): string[] {
  return node.children
    .filter((child) => child.kind === 'fieldBinding')
    .map((child) => bindingFieldId(child))
    .filter((fieldId): fieldId is string => fieldId !== null);
}

/**
 * How many columns a board grouped by a reference draws, and the whole of the S7 ceiling.
 *
 * The host publishes the same number at `boards.maximumReferenceColumns` in
 * `nendo://application/vocabulary`, and holds it in
 * `NendoSemanticVocabulary.MaximumReferenceBoardColumns`. It is repeated here because the
 * renderer decides what to draw before a read of the vocabulary would have answered. The
 * Workbench tests assert this value and the Engine tests assert that one, which is what
 * keeps the two from drifting apart unnoticed.
 */
export const maximumReferenceBoardColumns = 24;

/**
 * What a board says instead of drawing, when its target type holds more records than a
 * board can show.
 *
 * It lives here rather than inside the markup because it is a sentence a person reads,
 * and a sentence nobody can read back is a sentence nobody checks. The first version of
 * it shipped saying "holds 27 records than the 24 columns a board draws": the count and
 * the word `more` were alternatives in one template, so the branch that knew the number
 * lost the comparison. Every gate step draws a board that fits, so nothing ever rendered
 * this line, and the defect reached a person on the first file that crossed the ceiling.
 */
export function referenceColumnsOverflow(typeName: string, count: number | null, ceiling: number): string {
  const held = count === null ? 'more records' : `${count} records, more`;
  return `This board groups by ${typeName}, which holds ${held} than the ${ceiling} columns a board draws, ` +
    'so it is not drawn at all \u2014 a board missing its last columns would read as a complete one. ' +
    `Group by a field with fewer values, or keep fewer ${typeName} records.`;
}

/**
 * The other end of the same range, and the half nobody wrote.
 *
 * Above the ceiling a board names the target type, its count and the bound. At zero it
 * said nothing at all, so a person had no way to tell an empty record type from a broken
 * screen or a board somebody misconfigured. The asymmetry is the whole finding: the rule
 * that the columns are every record of the target type is just as true at zero, and just
 * as invisible.
 *
 * `inPicker` is whether the target type has a Use surface of its own, decided by the
 * caller rather than looked up here. It changes the second sentence because it changes
 * what a person can do without leaving the screen they are on, and an instruction they
 * cannot follow from here is worse than none.
 */
export function referenceColumnsEmpty(typeName: string, inPicker: boolean): string {
  return `This board groups by ${typeName}, and there are no ${typeName} records yet, so it has no columns \u2014 ` +
    'every record of that type would be one. ' +
    (inPicker
      ? `Choose ${typeName} under Showing and add one, and this board gains a column for it.`
      : `${typeName} records are made in Studio, and this board gains a column for each one.`);
}

/**
 * What a board or a grid says when its own clauses have excluded every lane.
 *
 * `reachableGroups` removes an option the surface declares `ne` against and keeps only
 * the one it declares `eq` against, so a surface can name a field whose options all fall
 * away and draw an axis with nothing on it. The board then drew one nameless lane and the
 * grid drew a bare corner, neither saying that the filter is what emptied them.
 */
export function excludedLanesNote(fieldName: string, lanes: 'columns' | 'rows'): string {
  const surface = lanes === 'columns' ? 'board' : 'grid';
  return `This ${surface}'s own filter excludes every ${fieldName} option, so it has no ${lanes}. ` +
    `Remove a condition on ${fieldName} to bring its ${lanes} back.`;
}

/**
 * One board's columns.
 *
 * `groups` are the stored values a column stands for: a choice field's option IDs, or a
 * reference field's target record IDs. `reference` is set when they are records, and it
 * is what tells every caller that the columns had to be read rather than taken from the
 * definition — the headings, the drag and the ceiling all turn on it.
 */
export interface BoardView {
  groupByFieldId: string;
  cardFieldIds: string[];
  groups: string[];
  reference: { targetEntityId: string; labelFieldId: string } | null;
}

/**
 * The columns of one board, taken from the node that is selected rather than from
 * whichever board sorts first. The entity fields are passed in because the
 * grouping choices live on the field, not on the node: resolving them from the
 * plan again would tie this to a single board per plan.
 *
 * A column the board's own filter excludes is not drawn. A board that declares
 * "status is not Done" and then draws an empty Done column is telling a person
 * that nothing is done, when what is true is that this board does not show it —
 * and the count under the heading reads 0 for the same wrong reason.
 */
export function boardViewOf(
  node: SurfaceNodePlan | null,
  fields: readonly FieldPlan[],
  referenceColumns: readonly string[] | null = null,
): BoardView | null {
  if (node === null || node.kind !== 'boardSurface') return null;
  const groupByFieldId = typeof node.properties.groupByFieldId === 'string' ? node.properties.groupByFieldId : null;
  if (groupByFieldId === null) return null;
  // options is the authoritative ordered set of choice IDs; choices carries display
  // metadata only for the options given some, so the columns come from options.
  const field = fields.find((candidate) => candidate.semanticId === groupByFieldId);
  // A reference board's columns are records of another type, so they arrive from a read
  // and are passed in. Until they do the board has no columns rather than no board: the
  // view still describes which field groups it and what a card shows.
  const reference = field?.reference ?? null;
  return {
    groupByFieldId,
    cardFieldIds: nodeFieldIds(node),
    groups: reachableGroups(node, groupByFieldId, reference === null ? field?.options ?? [] : referenceColumns ?? []),
    reference,
  };
}

/**
 * The groups this board can actually contain, given the clauses it declares on the
 * very field it groups by.
 *
 * Only the two operators that answer exactly are read. `ne` removes one value and
 * `eq` keeps one; a comparison or a null test over a choice says nothing definite
 * about which options remain, so every column stays rather than guessing one away.
 * Clauses on other fields are irrelevant here: they narrow which records land in a
 * column, not which columns exist.
 *
 * A reference board is the same rule over record IDs instead of option IDs. A board that
 * declares "client is not Acme" and then draws an empty Acme lane says something untrue
 * about Acme, exactly as one that declares "status is not Done" does about Done.
 */
function reachableGroups(
  node: SurfaceNodePlan,
  groupByFieldId: string,
  options: readonly string[],
): string[] {
  let groups = [...options];
  for (const child of node.children) {
    if (child.kind !== 'filterClause' || child.properties.fieldId !== groupByFieldId) continue;
    const { operator, value } = child.properties;
    if (typeof value !== 'string') continue;
    if (operator === 'ne') groups = groups.filter((group) => group !== value);
    else if (operator === 'eq') groups = groups.filter((group) => group === value);
  }
  return groups;
}

export interface MatrixView {
  rowByFieldId: string;
  columnByFieldId: string;
  cardFieldIds: string[];
  rows: string[];
  columns: string[];
}

/**
 * The shape of one matrix: the lanes on each axis, and the fields that make a card.
 *
 * Both axes use the board's rule — an option the surface's own eq or ne clauses exclude
 * is not a lane, because a lane that cannot contain a record spends a row or a column of
 * screen saying something false, and in two dimensions it says it twice. The unset lanes
 * are not here: nobody arranged them, so each is drawn only when the grid's own exact
 * number for it is not zero, which the markup decides from the answer.
 */
export function matrixViewOf(node: SurfaceNodePlan | null, fields: readonly FieldPlan[]): MatrixView | null {
  if (node === null || node.kind !== 'matrixSurface') return null;
  const rowByFieldId = typeof node.properties.rowByFieldId === 'string' ? node.properties.rowByFieldId : null;
  const columnByFieldId = typeof node.properties.columnByFieldId === 'string' ? node.properties.columnByFieldId : null;
  if (rowByFieldId === null || columnByFieldId === null) return null;
  return {
    rowByFieldId,
    columnByFieldId,
    cardFieldIds: nodeFieldIds(node),
    rows: reachableGroups(node, rowByFieldId, axisOptions(fields, rowByFieldId)),
    columns: reachableGroups(node, columnByFieldId, axisOptions(fields, columnByFieldId)),
  };
}

/**
 * The lanes a field contributes before its clauses are read. A Boolean has two, written
 * false then true, which is the order the host folds them in.
 */
function axisOptions(fields: readonly FieldPlan[], fieldId: string): readonly string[] {
  const field = fields.find((candidate) => candidate.semanticId === fieldId);
  if (field === undefined) return [];
  const options = field.options ?? [];
  return options.length > 0 ? options : isBooleanFieldPlan(field) ? ['false', 'true'] : [];
}

function isBooleanFieldPlan(field: FieldPlan): boolean {
  return field.storageKind === 3 || String(field.storageKind).toLowerCase() === 'boolean';
}

/** The first board of the plan, for callers that have no selection of their own. */
export function boardView(plan: ApplicationPlan): BoardView | null {
  return boardViewOf(surfaceRoot(plan, 'boardSurface'), plan.entity.fields);
}

export function hasListSurface(plan: ApplicationPlan): boolean {
  return surfaceRoot(plan, 'recordList') !== null;
}

/**
 * A surface's own name, for a selector button. Several roots of a kind are
 * ordinary now, so an untitled one falls back to its kind and a title shared with
 * another surface keeps its stable ID: two buttons reading "Deals" name nothing.
 */
export function surfaceLabel(node: SurfaceNodePlan, siblings: readonly SurfaceNodePlan[]): string {
  const own = typeof node.properties.title === 'string' && node.properties.title.length > 0
    ? node.properties.title
    : kindLabel(node.kind);
  const shared = siblings.some((other) =>
    other.semanticId !== node.semanticId && surfaceOwnLabel(other) === own);
  return shared ? `${own} (${node.semanticId})` : own;
}

function surfaceOwnLabel(node: SurfaceNodePlan): string {
  return typeof node.properties.title === 'string' && node.properties.title.length > 0
    ? node.properties.title
    : kindLabel(node.kind);
}

/** Whether a root of this kind is one a person opens from the view picker in Use. */
export function isUseSurfaceKind(kind: string): boolean {
  return useKinds.includes(kind);
}

export interface AddedSurface { nodeId: string; kind: string; title?: string | null; entityId?: string | null }

/**
 * What a proposal added, in the words a person needs to go and find it.
 *
 * Accepting one made its panel disappear and said nothing else: a new screen existed,
 * behind a picker, and nothing on screen mentioned either. The sentence names the screens
 * by their titles and the record type they belong to, because "accepted" answers what
 * happened and not where it went.
 *
 * Only the roots a person opens are named. A record page, a form or a command is reached
 * through a record rather than from the picker, so pointing somebody at the picker for one
 * would send them to the wrong place.
 */
export function addedSurfaceSentence(
  before: ReadonlySet<string>,
  after: readonly AddedSurface[],
  entities: ReadonlyArray<{ entityId: string; displayName: string }>,
): string {
  const added = after.filter((surface) => !before.has(surface.nodeId));
  if (added.some((surface) => surface.kind === 'overviewSurface'))
    return 'This file has a front page now. Use opens on it.';
  const views = added.filter((surface) => isUseSurfaceKind(surface.kind));
  if (views.length === 0) return '';
  const named = (surface: AddedSurface): string => {
    const title = typeof surface.title === 'string' && surface.title.length > 0 ? surface.title : kindLabel(surface.kind);
    const entity = entities.find((candidate) => candidate.entityId === surface.entityId);
    return entity === undefined ? title : `${title}, under View in ${entity.displayName}`;
  };
  if (views.length === 1) return `${named(views[0])}, is new.`;
  return `${views.length} new views: ${views.map((view) =>
    typeof view.title === 'string' && view.title.length > 0 ? view.title : kindLabel(view.kind)).join(', ')}. ` +
    'Open them from View in Use.';
}

export function kindLabel(kind: string): string {
  switch (kind) {
    case 'recordList': return 'List';
    case 'boardSurface': return 'Board';
    case 'calendarSurface': return 'Calendar';
    case 'timelineSurface': return 'Timeline';
    case 'gallerySurface': return 'Gallery';
    case 'matrixSurface': return 'Matrix';
    case 'extensionGraphSurface': return 'Custom graph';
    case 'extensionRecordsSurface': return 'Custom view';
    case 'rankedList': return 'Ranking';
    case 'overviewSurface': return 'Front page';
    case 'recentList': return 'Recent records';
    case 'rangeTile': return 'Range';
    case 'detailSurface': return 'Record page';
    case 'recordForm': return 'Form';
    case 'recordCommand': return 'Action';
    default: return kind;
  }
}

/** The title of the first titled root, used to name the Use view. */
export function surfaceTitle(plan: ApplicationPlan): string | null {
  for (const node of plan.surfaces) {
    const title = node.properties.title ?? node.properties.label;
    if (typeof title === 'string' && title.length > 0) return title;
  }
  return null;
}

// The record page is a detail surface when the application declares one, and the
// record form otherwise. Both group fields the same way. This precedence is
// existing behaviour: the compiler permits both, and page selection is not what
// the surface selector chooses between.
export function pageRoot(plan: ApplicationPlan): SurfaceNodePlan | null {
  return surfaceRoot(plan, 'detailSurface') ?? surfaceRoot(plan, 'recordForm');
}

/** The sections of a tab group, in declared order. A group contains only these. */
export function tabSections(group: SurfaceNodePlan): SurfaceNodePlan[] {
  return group.children.filter((child) => child.kind === 'section');
}

/**
 * Which tab is open: the remembered one while it still exists, otherwise the
 * first. A tab removed or reordered by a proposal must not leave the page with
 * no open panel, and the remembered ID is not rewritten by the fallback.
 */
export function activeTabSection(
  group: SurfaceNodePlan,
  remembered: string | undefined,
): SurfaceNodePlan | null {
  const sections = tabSections(group);
  if (sections.length === 0) return null;
  return sections.find((section) => section.semanticId === remembered) ?? sections[0];
}

export function descendants(nodes: SurfaceNodePlan[], kind: string): SurfaceNodePlan[] {
  return nodes.flatMap((node) => node.kind === kind ? [node] : descendants(node.children, kind));
}

// A command may stand as its own root or sit inside the record page, and the
// vocabulary allows both. Reading only the page left a standalone command with no
// button anywhere, so the one node kind that writes had no way to run.
export function treeCommands(plan: ApplicationPlan): SurfaceNodePlan[] {
  const page = pageRoot(plan);
  return [
    ...plan.surfaces.filter((node) => node.kind === 'recordCommand'),
    ...(page === null ? [] : descendants(page.children, 'recordCommand')),
  ];
}
