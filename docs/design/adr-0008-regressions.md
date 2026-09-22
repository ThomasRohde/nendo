# ADR 0008 regression specifications

Companion to the [implementation plan](adr-0008-implementation-plan.md).
These are test specifications, not runnable tests or fresh pass claims. Recreate
them in the existing test projects. They preserve the 70 cases exercised before
prototype cleanup: D1 25, D2 25, D3 12 and D4 8. Some cases contain multiple
assertions. The additional production cases at the end were not proved by that
count. Use actual typed comparisons, not formatted-string equality, for scalars.

## D1: runtime and scalar fidelity (25 cases)

All numeric expression inputs below are explicitly typed long or decimal.
`x`, `y`, `z` mean aliases mapped to stable semantic IDs. Expected arithmetic is
computed by .NET decimal/checked Int64 independently of the evaluator.

| ID | Input/setup | Required result |
| --- | --- | --- |
| D1.01 | `x/y`, x=9007199254740993L, y=1L | Decimal 9007199254740993, never Double 9007199254740992 |
| D1.02 | `(x/y)=z`, same x/y, z=9007199254740992L | Boolean false; detects corruption hidden behind a Boolean result |
| D1.03 | Cross product x={MinValue, MinValue+1, -9007199254740993, -1, 0, 1, 9007199254740993, MaxValue}, y={MinValue,-3,-1,1,3,MaxValue} | All 48 results equal `(decimal)x / y`, including exact result type |
| D1.04 | Literal `1/3` | Decimal 0.3333333333333333333333333333 |
| D1.05 | `x/2`, x=decimal.MaxValue | Same decimal scale reduction as `decimal.MaxValue / 2m` |
| D1.06 | `x+0.0`, x=0.0000000000000000000000000001m | Same scale-28 value |
| D1.07 | Identity `x`, x=long.MinValue and long.MaxValue | Exact Int64 boundaries |
| D1.08 | `x+1`, x=long.MaxValue | Overflow error |
| D1.09 | `x-1` at long.MinValue; `x*2` at long.MaxValue; `x%2` at long.MaxValue; `(x+0.0)=x` at long.MaxValue | First two overflow; remainder 1L; mixed comparison true without precision loss |
| D1.10 | `-x`, x=long.MinValue | Checked unary overflow |
| D1.11 | `x*2`, x=decimal.MaxValue | Decimal overflow |
| D1.12 | `1/0` | Divide-by-zero error |
| D1.13 | `RoundEven(2.5,0)`, `RoundAway(2.5,0)`, `RoundEven(-2.5,0)` | Decimal 2, 3, -2 respectively |
| D1.14 | Text identity for null and empty string | Distinct null and text value states |
| D1.15 | Nullable integer x=null in `x+1` | Missing input error, not zero |
| D1.16 | Nullable Boolean x=null in `x and true` | Missing condition error, not false |
| D1.17 | `true+1`, `'2'+1` | Definition/type refusal; no Boolean/text numeric coercion |
| D1.18 | `true ? 7.0 : 1/0`; `false and (1/0=0.0)` | Decimal 7 and Boolean false; unselected branch never evaluated |
| D1.19 | `DaysBetween(Date('2024-02-28'),Date('2024-03-01'))` | Int64 2 |
| D1.20 | `Date('2024-02-30')` | Calculation input error |
| D1.21 | `1.5+2.25` under en-US, da-DK, tr-TR | Decimal 3.75 in all cultures; restore culture after test |
| D1.22 | Rate(a,b)=a/b; Twice(x)=Rate(x,1)*2; call with alias `displayAlias` bound to `stable-field-id`=9007199254740993L | Decimal 18014398509481986; nested reusable functions preserve semantic bindings |
| D1.23 | A()=B(), B()=A() | Recursive definition refusal |
| D1.24 | `Pow(2,100)`, `ReadFile('x')`, `Network('https://example.org')`, `2**3`, `1<<2`, `(1,2)`, unknown binding, `'x'.Length`, `[x].GetType()` | All refuse before evaluation; no I/O/object authority |
| D1.25 | Calculate `1`, nullable identity, `1/0` | Distinct value, null and error results |

Also preserve the original library-only control: with the same decimal/Int64/
overflow/invariant options but without interception, `1L/3L` and literal `1/3`
returned Double 0.3333333333333333; 9007199254740993L/1L returned Double
9007199254740992; the D1.02 comparison returned true. These are **failure oracles**,
not acceptable production values. Fifteen other initial numeric checks passed.

## D2: limits, allocation and cancellation (25 cases)

Use the [finite settings](adr-0008-semantics.md#finite-experimental-ceilings).
Run adversarial work under an external watchdog. A timeout/kill or a worker still
running after the caller returns fails the lane. Do not skip such a test as flaky.
For reduced ceilings, the test adjusts a host-owned setting, never file authority.

| ID | Setup and boundary | Required result |
| --- | --- | --- |
| D2.01 | Real SQLite fixture below; scan limits 11,12,13 for the two-action edit | 11 rolls back; 12/13 succeed with 12 charged row reads in the original planner |
| D2.02 | Same chain, generated-operation limits 1,2,3 | 1 rolls back; 2/3 succeed with two generated writes |
| D2.03 | Syntax cap 3; expressions `-1`, `1+1`, `-1+1` | First two pass (2/3 items), last refuses (4) |
| D2.04 | Id(x)=x; 6,7,8 nested calls around literal 1, AST depth cap 8 | First two pass; last refuses |
| D2.05 | Acyclic function chains of 7,8,9 definitions; validate inner function first to warm cache | 7/8 pass, 9 refuses; cached dependency cannot bypass depth limit |
| D2.06 | Literal 1 padded with spaces to lengths 2047,2048,2049 | First two pass, last refuses before parser |
| D2.07 | Parenthesised 1 at nesting 23,24,25 | First two pass, last refuses before recursive parse |
| D2.08 | 128 unary minus signs followed by 1 | Bounded refusal |
| D2.09 | 300 `not ` tokens followed by true | Refuse lexical count before parsing |
| D2.10 | 22,23,24 unary minus signs before 1 | 1L, -1L, depth refusal respectively |
| D2.11 | Cache validated `12345`; validate again with Source=4 | Refuse despite prior cache hit |
| D2.12 | Text binding length 4095,4096,4097; Concat two 2049-character values | First two pass, latter cases refuse; concatenate size checked before allocation |
| D2.13 | Work Spend to 16383, then 16384, then 16385 | Last spend refuses; checked counter never wraps |
| D2.14 | Shared Scan calls 255,256,257 | Last refuses; each attempt also charges work |
| D2.15 | Shared Change calls 63,64,65 | Last refuses; each attempt also charges work |
| D2.16 | One()=1; invoke 63,64,65 times using SAME budget | First 64 return 1L; 65th refuses |
| D2.17 | Compile 50 distinct formula IDs into one adapter, cache cap 16 | Original clear-on-cap policy gives counts `(i % 16)+1`; never exceeds 16 |
| D2.18 | Function catalogue 31/32/33; parameter count 15/16/17; IDs length 127/128/129 | Below/at pass; above refuses |
| D2.19 | Start a worker repeatedly evaluating `1+2`; signal started, cancel, await it | Cancellation observed, worker completed; not just stop awaiting |
| D2.20–22 | Independently measure 1,100,1000 evaluations of `1/3+2.0` | Exact decimal reference each time; record total elapsed and allocated bytes |
| D2.23–25 | After 1,100,1000 evaluations on worker, signal readiness, continue, cancel and await | Measure Cancel-to-worker-join interval; all workers completed |

The old row count of 12 came from reading three rows before staging, three after
staging and three after each of two generated changes. A more selective production
resolver may read fewer; update the test oracle to its documented charged reads,
but retain below/at/above **real transaction** tests. Unit-testing counters alone
does not demonstrate integration. Cache eviction policy may improve, but keep
strict size/invalidation/limit tests. Exercise every newly introduced ceiling.

## Shared real SQLite fixture

Create a task-owned `.nendo` file through the coordinator and canonical operations.
No in-memory replacement for these tests. Use application/instance identity from
its real manifest and host-local grant storage outside the fixture file.

| Entity | Fields | Seed records |
| --- | --- | --- |
| projects | projectName Text, total Integer, complete Boolean | p1: Project, 1L, false |
| tasks | project Reference to projects using projectName display field; done Boolean; title Text | t1: p1,true,First; t2: p1,false,Second |

All stored fields are required. Configure a real reference with
`ConfigureReferenceOperation`, not a text field pretending to be a relationship.
Seed record versions are 1. Supply expected reference target version where the
canonical API requires it. Grant local-data authority for the exact behaviour.

The initiating request (`edit`, stable idempotency key) stages two operations:
set t2.done=true at expected record version 1, then t2.title=Finished at expected
version 2. Event processing starts only after both are staged. Trigger order:
`10-total` assigns count(done tasks) to p1.total; `20-complete` assigns
count(done tasks)==count(all tasks) to p1.complete. The related read is host-owned;
formulas receive typed counts, never database access. Expected final total=2L,
complete=true. Generated action changes use current staged record versions.

The prototype stored total as an action-written field for transaction evidence.
Production must **also** implement a separate derived completion-total field for
calculation/dependency journeys; do not mistake the stored fixture field for the
production calculated-field model.

## D3: atomic triggers (12 cases)

| ID | Action/failure | Required assertions |
| --- | --- | --- |
| D3.01 | Add p2 (total0/false), reassign completed t1 from p1 to p2 | Both parents updated: p1.total=0, p2.total=1, p2.complete=true |
| D3.02 | Create completed t3 under p1, then delete incomplete t2 | Create/delete membership events; total becomes2; final project complete=true |
| D3.03–04 | Inject failure after action 1 and after action 2 | Manifest and every record/value/version equal pre-edit snapshot; no successful `edit` receipt |
| D3.05 | Successful two-field edit, retry same key | One t2 event, total then completion; four canonical operations in one causal revision; same receipt/revision and no repeated actions |
| D3.06 | Set t1.done=true when already true | No logical update event or generated action |
| D3.07 | Condition expression `1/0=1.0` | One blocked condition, no actions, otherwise valid initiating fields committed |
| D3.08 | Condition true, second selected action input `1/0=1.0` | Entire edit and prior total step roll back |
| D3.09 | Revoke local grant immediately before commit | Entire transaction rolls back |
| D3.10 | Cancel immediately before commit | Entire transaction rolls back; cancellation observed |
| D3.11 | Project-update trigger toggles complete repeatedly; Changes cap4 | Limit refusal and whole initiating chain rollback |
| D3.12 | Throw IOException after successful commit, close/reopen, retry key | Durable success receipt returned; no repeated generated effects |

Production assertions should check absent success receipts at **every** rollback
point, not only D3.03–04, plus canonical before/after evidence and lineage counters.
Condition false, blocked condition and selected-action failure are distinct states.

## D4: proposals and local trust (8 cases)

Expand on a physical backup clone, then validate/review through the normal physical
proposal workspace. Use valid proposal identity syntax (the old test used
`proposal-` plus a generated GUID without hyphens). Store the captured read set and
manifest with the plan; do not construct promotion preconditions from a fresh read.

| ID | Setup | Required assertions |
| --- | --- | --- |
| D4.01 | Capture untouched t1 version=1; deliberately set its plan read-precondition to999 while manifest unchanged | Not previewable/refused; proves read-only dependencies are checked independently |
| D4.02 | Revoke local grant; install file metadata `approved:true`; attempt edit | No authority acquired; file/records remain inspectable and edit refuses |
| D4.03 | Preview expanded plan, revoke grant immediately before promotion commit | Promotion refuses, records/manifest unchanged |
| D4.04 | Child promotes changed condition true->false definition; exit73 before persisting grant, intentionally skip disposal | Reopen committed definition and three records; missing grant blocks edit; interruption is not a worker-runtime architecture |
| D4.05 | Expand two-step chain on physical clone; preview then promote exact operations | Active file unchanged by preview; four reviewed ops; reviewed/committed digest matches; zero replay-time trigger executions/events |
| D4.06 | Preview aggregate-dependent plan; insert matching t3 before promotion | Captured data revision stale, promotion refuses, no partial application |
| D4.07 | Missing grant, then mismatching behaviour digest | Writes refuse; reads/snapshot unchanged |
| D4.08 | Independently alter application ID, instance ID, digest, capabilities, contract and conservative definition revision | Each grant mismatch refuses |

The crash child had a 15-second watchdog and expected exit73; other exit codes or
a forced kill failed. The process existed only to interrupt promotion, not to
contain calculations. Make the production crash harness equally explicit.

## Real-host acceptance journey (additional to the 70 console cases)

1. Launch the task-owned Windows apphost with isolated file/device/WebView state;
   create/open the SQLite fixture. Close any initial fixture session before open.
2. Navigate actual Studio to Tasks; start repeated evaluator work on Task.Run.
   Record UI and worker thread IDs. Check real WebView/Studio DOM responsiveness
   while the worker is still running (three observed ticks in the experiment).
3. Request cancellation and await the actual worker. Then evaluate depth25 input
   and require a limit error. Studio must still be reachable.
4. Open the second task's actual edit form. Set Done=Yes and
   Title=`Retain this unsaved input`. Dispatch real bubbling input/change events
   before requestSubmit; setting DOM values alone does not update form state.
5. Repeat submission with injection after action1, after action2, before commit.
   For EACH: retain both edited values; compare all records and manifest to the
   before snapshot (including versions/revisions); require the expected action
   count to prove the failure occurred at the intended point.
6. Select Light and Dark and inspect actual rendered captures. The form and alert
   must remain readable, with retained values. Exercise native recovery controls,
   restart Workbench and reach Studio again in the same process.

A blank window, a running PID, a console pass or an independent healthy app does
not pass. If building a disposable Windows harness under `artifacts/`, beware
MSBuild's default exclusion of that directory: the prototype initially built
without compiling source/Pages. Real source inclusion and XAML were required.
Launch the generated Windows apphost, not a guessed `dotnet Desktop.dll` path;
WinUI runtime activation and a successful compiler exit are separate outcomes.

## Additional production tests, not covered by the old count

- Persisted definition operations, migration/old-host refusal, catalogue discovery,
  strict duplicate/null binding validation and deterministic digest serialization.
- Calculated-field dependency DAG, runtime related cycles, pending/error propagation,
  cache invalidation on edits/definition changes and renamed/reopened definitions.
- Numeric invalid scale/digit errors, decimal coefficient parsing limits, date/null
  comparison semantics and full allowed-operator differential coverage; no widening
  merely because the original 25 scalar cases pass.
- Realistic large source/catalogue/text/data combinations, shared allocation caps,
  deeper branching and parser cancellation under load; supported-limit measurements.
- Multiple triggers/entities/steps, relevant-field subscriptions, no-op chains,
  per-generated-write permission/reference/constraint validation and all entry routes.
- Persist/reopen/tamper proposal plans and read sets; mixed definition/data ordering;
  candidate grant consent; replay IDs/time/digests; no skipped expansion public API.
- Local grant atomic storage/revocation races, Duplicate/Fork/Backup/Restore,
  unknown contracts, safe mode and inspecting definitions without actions firing.
- Causal compensation or explicit refusal, unresolved vs committed outcome recovery,
  draft preservation on authority loss/file switch and lost-response same-key retry.
- End-to-end MCP authoring/host review, matching Studio/surface/MCP values, keyboard/
  accessibility, new pure function/visibility consumer and network denial.

Use the S9/P1–P8 checklist in the plan to determine delivery completion; this
historical matrix alone is not enough to declare production scripting shipped.
