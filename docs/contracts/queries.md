# Query contract

This contract covers bounded typed record queries: sorting, predicates and
cursor discipline.

The existing typed record query gets one optional sort field, a direction, and
up to eight AND predicates. The predicates are:

- equal and not-equal;
- ordered comparisons;
- text contains;
- explicit null and not-null;
- `descendantOf`, on the parent field of a declared hierarchy
  ([ADR-0019](../decisions/0019-hierarchies-in-the-schema.md)): every record under the
  named record, down to 32 levels. It holds in the page, the count and every aggregate,
  and it is refused as `hierarchy-too-wide` when more than 10,000 records sit under that
  record, and as `hierarchy-not-declared` on any other field.

The sort field and any predicate may name a **calculated field** (2026-09-30, F-222). It is
compared as a stored field of its result type is: `contains` only for a Text result, and
never `descendantOf`. A calculated field has no column, so the host first reads every record
the stored predicates leave, with its calculations, and gives the database the ones that pass
and their order. The page, its continuation, the count and every aggregate read that one set.
A value that could not be worked out matches no predicate, not even null, and sorts last in
either direction. The read is refused as `calculated-query-too-wide` when more than 10,000
records would be worked out; a stored predicate narrows it.

A **tree read** (`NendoTreeQuery`: a record type, an optional root, a depth of 1 to 32 and
a page of 1 to 200) returns a declared hierarchy depth-first: the records under the root,
or the whole tree from the top level, siblings in the order field's order, unordered ones
last, then by record ID. Each item is the record with its parent, its depth below the root
(1 for the top of the window) and its child count. The walk is refused as
`hierarchy-too-wide` when it would cover more than 10,000 records. Pages are cut by
position; the cursor binds the change sequence, so a write between pages makes it stale,
as for any query.

The field search in the UI uses contains. Contains is ordinal, case-insensitive
and literal (no wildcard language). Text sort is ordinal. Integers and decimals
compare exactly. Datetimes compare their instants, and the stored offsets do not
change. Missing values sort first in ascending order and last in descending
order. When sort values are equal, ascending record ID is the deterministic
final key. The default order remains record-ID order.

Pages keep the 1–200 limit. A query reads only the requested page plus one row.
Sorting and filtering may scan inside SQLite. No full record set crosses the
storage boundary. Only the storage mappings supply SQL identifiers. Predicate
values are parameters. Managed typed comparisons prevent decimal coercion.
Performance qualification must include these scans. It does not assume that
every field is indexed.

Authenticated cursors bind the file identity, the open session, the change
sequence and all sort and filter parameters. If a write occurs between pages,
the host rejects the continuation as stale. If the query parameters changed, the
host rejects the continuation as belonging to another query. The client must
offer an explicit restart. A query change resets previous-page navigation. Field
IDs must belong to the selected entity, and scalar types must match. Null checks
are separate from scalar equality, so the query keeps null distinct from empty
text.

The Engine implements this contract in `RecordQuerySemantics.cs` and
`NendoQueryCursor.cs`. `TypedRecordQueryTests`, `BoundedQueryTests`,
`CursorCodecTests` and `WorkbenchDeclaredQueryPagingTests` test it. This file does
not map each rule to a test case.

Read-only snapshots use the same typed filtered set for pages, counts, numeric
aggregates, groups, date buckets and cells. Stored, calculated and `descendantOf`
predicates apply before folding. `ReviewStorageRegressionTests` compares all five
folds with their writable answers and checks the corresponding page.
