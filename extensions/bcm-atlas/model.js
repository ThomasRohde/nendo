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
 * The hierarchy of a set of capability records.
 *
 * Stored parent links are read, never rewritten. A link to a missing record puts the capability
 * at the top level, and a cycle is cut at one deterministic edge, so every record stays visible
 * and editable; each repair is reported in issues.
 *
 * Returns:
 *   byId         record ID -> record
 *   parents      record ID -> parent record ID, or null at the top level (after repair)
 *   children     record ID -> child records, in display order
 *   roots        top-level records, in display order
 *   issues       one sentence per repaired link
 *   descendants  (id) -> every record under id, depth first
 *   tree         (record) -> { id, name, children } for the layout engine
 */
export function hierarchy(records) {
  const byId = new Map(records.map(record => [record.recordId, record]));
  const parents = new Map(), issues = [];
  for (const record of records) {
    const parent = value(record, 'parent');
    if (parent && !byId.has(parent)) issues.push(`${title(record)} has a missing parent; shown at the top level.`);
    parents.set(record.recordId, byId.has(parent) ? parent : null);
  }

  // Walk up from every record, in record ID order. The first record met twice closes a cycle:
  // cut its link, which leaves it at the top level.
  for (const id of [...byId.keys()].sort()) {
    const seen = new Set();
    for (let current = id; current; current = parents.get(current)) {
      if (seen.has(current)) {
        parents.set(current, null);
        issues.push(`${title(byId.get(current))} has a circular hierarchy; repair its parent.`);
        break;
      }
      seen.add(current);
    }
  }

  const children = new Map([...byId.keys()].map(id => [id, []]));
  const roots = [];
  for (const record of records) {
    const parent = parents.get(record.recordId);
    (parent ? children.get(parent) : roots).push(record);
  }

  // Display order: the stored order number (missing sorts as 999), then the reference code, then
  // the name, then the record ID, so the order is total and stable.
  const displayOrder = (a, b) =>
    (Number(value(a, 'order') ?? 999) - Number(value(b, 'order') ?? 999)) ||
    String(value(a, 'code') || '').localeCompare(String(value(b, 'code') || '')) ||
    title(a).localeCompare(title(b)) ||
    a.recordId.localeCompare(b.recordId);
  roots.sort(displayOrder);
  for (const list of children.values()) list.sort(displayOrder);

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

  return { byId, parents, children, roots, issues, descendants, tree };
}

/** Whether parent may become id's parent: not itself, not missing, not one of its descendants. */
export function validParent(records, id, parent) {
  if (!parent) return true;
  if (id === parent) return false;
  const byId = new Map(records.map(record => [record.recordId, record]));
  if (!byId.has(parent)) return false;
  // Climb from the proposed parent. Meeting id means id is above it; meeting a record twice
  // means the stored links already loop, which is refused as well.
  const seen = new Set();
  for (let current = parent; current; current = value(byId.get(current), 'parent')) {
    if (current === id || seen.has(current)) return false;
    seen.add(current);
  }
  return true;
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
