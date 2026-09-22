# Query contract

This contract covers bounded typed record queries: sorting, predicates and
cursor discipline.

The existing typed record query gets one optional sort field, a direction, and
up to eight AND predicates. The predicates are:

- equal and not-equal;
- ordered comparisons;
- text contains;
- explicit null and not-null.

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
