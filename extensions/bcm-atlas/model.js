// The Capability Atlas model: the capability record type, its choice lists, and the hierarchy
// built from each capability's stored parent link. Nothing here touches the page or Nendo, so
// view.js and the node tests (tools/bcm-atlas/model.test.mjs) share it.

/** The capability record type. */
export const CAPABILITY = 'bcm.capability';

/** Capability field IDs by short name: FIELD.parent is 'cap.parent'. */
export const FIELD = Object.fromEntries(
  ['name', 'code', 'parent', 'description', 'owner', 'maturity', 'target', 'importance',
    'investment', 'lifecycle', 'reviewed', 'evidence', 'order'].map(key => [key, `cap.${key}`]));

/** Maturity labels by level. Level 0 stands for no assessment; 1 to 5 are the scale. */
export const maturityLabels = ['Unassessed', 'Initial', 'Repeatable', 'Defined', 'Managed', 'Optimising'];
export const importanceOptions = ['Supporting', 'Core', 'Differentiating'];
export const investmentOptions = ['Tolerate', 'Invest', 'Migrate', 'Eliminate'];
export const lifecycleOptions = ['Proposed', 'Active', 'Retiring'];

/** A capability's value by short field name, or null. Accepts a missing record. */
export const value = (record, key) => record?.values?.[FIELD[key]] ?? null;

export const title = record => String(value(record, 'name') || '(Unnamed capability)');

/**
 * Target minus current maturity, or null when either is missing. A group's assessment is its
 * own judgement: nothing here averages or infers it from the children.
 */
export function gap(record) {
  const current = value(record, 'maturity'), target = value(record, 'target');
  return current == null || target == null ? null : Number(target) - Number(current);
}

/**
 * The capability hierarchy as the Engine keeps it (ADR-0019): the nodes of one records.treeAll
 * read, depth first, each with its parent. The file declares Parent capability a hierarchy, so
 * every write that would close a loop or go deeper than 32 levels is refused before it lands,
 * and siblings arrive in the Engine's order -- the Display order field, then record ID. Nothing
 * here repairs a link or sorts a level.
 *
 * Returns:
 *   records      every capability, in the Engine's depth-first order
 *   byId         record ID -> record
 *   parents      record ID -> parent record ID, or null at the top level
 *   children     record ID -> child records, in sibling order
 *   roots        top-level records, in sibling order
 *   descendants  (id) -> every record under id, depth first
 *   tree         (record) -> { id, name, children } for the layout engine
 */
export function hierarchy(nodes) {
  const records = nodes.map(node => node.record);
  const byId = new Map(records.map(record => [record.recordId, record]));
  const parents = new Map(nodes.map(node => [node.record.recordId, node.parentRecordId ?? null]));
  const children = new Map(records.map(record => [record.recordId, []]));
  const roots = [];
  for (const node of nodes) (node.parentRecordId ? children.get(node.parentRecordId) : roots).push(node.record);

  function descendants(id) {
    const found = [];
    const visit = parentId => {
      for (const child of children.get(parentId) || []) {
        found.push(child);
        visit(child.recordId);
      }
    };
    visit(id);
    return found;
  }

  const tree = record => ({
    id: record.recordId,
    name: title(record),
    children: (children.get(record.recordId) || []).map(tree),
  });

  return { records, byId, parents, children, roots, descendants, tree };
}

/**
 * What the map and the tables show for a scope and a level choice.
 *
 * At the enterprise the top-level capabilities are level 1. A focused group is context at
 * level 0, so one level below it still shows its immediate children. A group whose children lie
 * beyond the chosen level is drawn collapsed; hiddenCounts says how many capabilities it holds.
 *
 * Returns:
 *   tree          [{ id, name, children }] cut at the chosen level, for the layout engine
 *   rows          [{ record, depth }] in hierarchy order, depth 0 at the top of the scope
 *   hiddenCounts  record ID -> number of capabilities under it, whether shown or not
 *   maxDepth      the deepest level in the scope, whatever the choice
 */
export function projectHierarchy(model, scope, levels = Infinity) {
  const focused = scope && model.byId.has(scope);
  const roots = focused ? [model.byId.get(scope)] : model.roots;
  const topLevel = focused ? 0 : 1;
  const rows = [], hiddenCounts = new Map();
  let maxDepth = 0;

  function measure(record, depth) {
    maxDepth = Math.max(maxDepth, depth);
    let count = 0;
    for (const child of model.children.get(record.recordId) || []) count += 1 + measure(child, depth + 1);
    hiddenCounts.set(record.recordId, count);
    return count;
  }
  roots.forEach(record => measure(record, topLevel));

  function visit(record, depth) {
    rows.push({ record, depth: depth - topLevel });
    return {
      id: record.recordId,
      name: title(record),
      children: depth < levels ? (model.children.get(record.recordId) || []).map(child => visit(child, depth + 1)) : [],
    };
  }
  const tree = roots.map(record => visit(record, topLevel));

  return { tree, rows, hiddenCounts, maxDepth };
}
