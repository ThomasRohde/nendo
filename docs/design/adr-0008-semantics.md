# ADR 0008 execution semantics to carry into production

This preserves the retired experiment's contract, formerly `experiment-1`, for
the [implementation plan](adr-0008-implementation-plan.md). Use these scalar and
ordering rules as the initial production defaults; publish a production contract
and version in stage S1. This document introduces no public API, persisted format
or MCP capability. The [evidence report](adr-0008-evidence.md) records historical
measurements; the [regression specifications](adr-0008-regressions.md) define the
tests to recreate. References to the prototype below describe its historical
design: its code and runner have been removed at the owner's request.

## Scalars and results

Inputs and declared results are Int64, .NET decimal, Boolean, text or DateOnly,
with nullable values. Names in expressions bind through declared semantic IDs,
not mutable display labels. Reusable functions declare typed parameters and a
result; recursive definitions and mismatched types refuse validation.

Integer addition/subtraction/multiplication/negation are checked. Decimal uses
.NET's 96-bit coefficient and scale 0–28, including normal scale reduction.
Integer/integer and mixed numeric division convert operands to decimal before
division, never after a binary float result. Division by zero and overflow are
errors. `%` uses the corresponding typed numeric remainder. No Double, Single,
BigDecimal, collection or general object is an accepted scalar.

`RoundEven(number, digits)` and `RoundAway(number, digits)` use .NET decimal
rounding with explicit midpoint policy. `Date(text)` accepts invariant ISO
`yyyy-MM-dd`; `DaysBetween(start,end)` returns the signed day difference. Dates
are calendar dates with no inferred timezone. Numeric text and Booleans never
coerce into numbers. Parsing and comparison are culture-independent/ordinal.

Results distinguish typed **value**, **null**, and **error**. Null identity is
allowed and differs from empty text. Null used in arithmetic, comparisons or
Boolean control yields an input error. Ternary and Boolean branches are lazy;
unselected work is not executed. Definition errors refuse installation; input,
arithmetic and resource errors produce calculation errors. Cancellation stops
work and must also be checked before any transaction can commit.

The closed syntax permits declared identifiers, scalar literals, typed numeric
arithmetic/comparisons, Boolean control, ternaries and approved pure calls.
`Concat` checks length before allocating its result. Built-ins outside the list,
object access, power, shifts, lists, recursion, arbitrary code and I/O refuse.
NCalc remains responsible for parsing and evaluating the accepted syntax; only
division is intercepted as arithmetic. The adapter does not expose async visitor
entrypoints or general host services to formulas.

## Finite experimental ceilings

All settings are host-owned, never supplied as authority by a file. Tests use
lower settings to exercise exact boundaries inside real transactions as well as
default-ceiling counter tests.

| Resource | Ceiling | Enforcement and rationale |
| --- | ---: | --- |
| Source UTF-16 length | 2,048 | Before parser allocation; enough for small formulas |
| Lexical syntax items and AST nodes | 128 each | Conservative preflight then typed AST walk; syntax count includes punctuation |
| Parse nesting and AST depth | 24 each | Preflight for brackets/parentheses; AST guard for unary/call chains |
| Definition graph depth | 8 | Revalidate nested graph even with warm cache |
| Function catalogue | 32 | Before building lookup table |
| Parameters per formula | 16 | Before parameter binding/type-map allocation |
| Formula/parameter ID or alias length | 128 | Before compilation |
| Shared work units | 16,384 | Source/validation/evaluation visits, calls, scans and changes consume units |
| Function calls | 64 | One counter across nested evaluations and action chains |
| Text input/output UTF-16 length | 4,096 | Check binding/result; precheck Concat sum |
| Cached expressions per adapter | 16 | Clear before inserting the seventeenth; cache key includes limits |
| Related rows read per chain | 256 | SQL LIMIT plus charge before materializing each row; repeated reads count again |
| Generated non-no-op changes per chain | 64 | Before each canonical generated operation |

These intentionally small supported experiment limits combine a bounded parser
input, bounded recursion, bounded primitive work and bounded host functions.
They are not a hard wall-clock guarantee or a memory sandbox against native
library defects. No invocation is abandoned on cancellation: callers await the
worker's completion. A 60-second external watchdog protects the test machine;
using it to stop evaluation fails the containment lane.

The same Budget instance spans nested calls and the causal transaction. Fresh
budgets are only for independent evaluations/transactions. Related query scans
are charged even when they read rows that do not contribute to the aggregate;
partial totals never return as complete. Larger datasets and a more selective
query implementation require new measurements before widening these limits.

## Transactions and action outcomes

Use the actual Engine SQLite store, coordinator, canonical operations, versions,
revision history and durable receipts. Stage every initiating operation before
emitting logical record events. Process a FIFO queue; order initial record keys
and trigger IDs ordinally. Suppress events/actions whose scalar values did not
change. Evaluate conditions and action inputs against staged state. Generated
changes enqueue subsequent events and consume the original shared budget.

The project/task fixture totals completed related tasks, then sets project
completion. Creation, deletion and relationship reassignment affect membership;
reassignment updates old and new parents. Trigger IDs `10-total` and
`20-complete` provide stable action ordering and generated-operation attribution.

A calculation error or erroneous condition is a visible blocked result and does
not invalidate otherwise valid input. A selected action-input/operation failure,
budget exhaustion, cancellation or revoked grant aborts the entire transaction.
Records, record versions and both revision lineages remain unchanged; no success
receipt exists. The editor retains unsaved values for correction.

A successful causal chain produces one commit and history entry containing all
generated operations. Its receipt is keyed to the initiating request, while the
operation digest covers expanded effects. Same-key retries and postcommit
response loss resolve through the durable receipt without re-executing actions.

## Proposal replay and trust

Expand the chain on a physical SQLite backup clone, then validate the expanded
canonical change set through the existing physical proposal clone path. The
review includes generated operation IDs/attribution and digest. Promotion applies
exactly those operations under the coordinator's transaction; only host-owned
experimental replay context can suppress expansion. There is no public bypass.

Capture versions of all records read to determine actions, including untouched
records. Check those versions before replay. Conservatively require unchanged
data revision for collection membership and unchanged definition revision for
behaviour meaning. The prototype carries read versions in the host-owned scope;
production must retain them with the exact reviewed proposal, not recompute them
at acceptance. A stale plan is refused, never silently re-expanded.

Host-local grants bind application ID, instance ID, SHA-256 definition digest,
capabilities, execution-contract version and conservatively definition revision.
File metadata cannot grant trust. Opening/inspecting definitions requires no
grant; editing requiring automatic actions does. Revocation is rechecked before
commit, including promotion. Definition promotion and grant persistence are
separate storage operations: interruption after promotion leaves installed,
inspectable definitions with editing blocked until explicit approval.

The fixed behaviour JSON and protected experiment table exist only in copied
Engine code. They are fixtures for these checks, not proposed durable formats.
Network/filesystem callbacks, external effects, background workers, plug-ins and
general scripts receive no authority from this contract.
