# Query contract

Bounded typed record queries: sorting, predicates and cursor discipline.

The existing typed record query gains one optional sort field, direction and up
to eight AND predicates. Predicates are equal/not-equal, ordered comparisons,
text contains, and explicit null/not-null. The UI's field search uses contains.
Contains is ordinal case-insensitive and literal (no wildcard language). Text
sort is ordinal; integers and decimals compare exactly; datetimes compare their
instants while stored offsets remain unchanged. Missing values sort first in
ascending order and last in descending order. Equal sort values use ascending
record ID as a deterministic final key. The default remains record-ID order.

Pages retain the 1–200 limit and read only the requested page plus one row.
Sorting/filtering may scan inside SQLite; no full record set crosses the storage
boundary. Storage mappings alone supply SQL identifiers; predicate values are
parameters. Managed typed comparisons prevent decimal coercion. Performance
qualification must include these scans and does not assume every field is indexed.

Authenticated cursors bind file identity, open session, change sequence and all
sort/filter parameters. Any intervening write rejects continuation as stale;
changed query parameters reject it as belonging to another query. The client
must offer an explicit restart. Query changes reset previous-page navigation.
Field IDs must belong to the selected entity and scalar types must match.
Null checks are separate from scalar equality, preserving null versus empty text.

This contract is an implementation target, not passed acceptance evidence.
