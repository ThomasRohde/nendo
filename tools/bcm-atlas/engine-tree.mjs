// The capability tree as the Engine's records.tree returns it (ADR-0019), for the node tests, the
// expansion builder and nothing in the package: siblings by Display order (whole numbers
// ascending, a missing order last), then record ID; depth first. A loop or a parent that is not
// there is thrown, as declaring the hierarchy over such data is refused.
export function engineTree(records, parentField = 'cap.parent', orderField = 'cap.order') {
  const byId = new Map(records.map(record => [record.recordId, record]));
  const children = new Map();
  for (const record of records) {
    const parent = record.values[parentField] ?? null;
    if (parent !== null && !byId.has(parent)) throw new Error(`${record.recordId} names a parent that is not there: ${parent}`);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(record);
  }
  const order = record => record.values[orderField] ?? null;
  const sibling = (a, b) =>
    (order(a) === null) - (order(b) === null) || (order(a) ?? 0) - (order(b) ?? 0) ||
    (a.recordId < b.recordId ? -1 : a.recordId > b.recordId ? 1 : 0);
  const nodes = [];
  const visit = (parent, depth) => {
    for (const record of (children.get(parent) ?? []).sort(sibling)) {
      nodes.push({ record, parentRecordId: parent, depth, childCount: children.get(record.recordId)?.length ?? 0 });
      visit(record.recordId, depth + 1);
    }
  };
  visit(null, 1);
  if (nodes.length !== records.length) throw new Error(`${records.length - nodes.length} records sit on a loop, out of reach of the top level.`);
  return nodes;
}
