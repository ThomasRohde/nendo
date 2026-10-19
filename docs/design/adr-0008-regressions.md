# Regression catalogue for calculations and actions

The regression lanes D1–D4 behind
[ADR-0008](../decisions/0008-general-scripting-and-capability-isolation.md) and the
[calculations and actions contract](../contracts/calculations-and-actions.md). Each
row is a test specification; a test named `D<lane>_<n>_…` implements row D*lane*.*n*,
and `RegressionLaneIdTests` refuses a D1 test without a row here. Where a row and the
contract disagree, the contract is current. Compare scalars by typed value, never by
formatted string.

## D1: runtime and scalar fidelity

`BehaviourScalarTests`. Numeric inputs are explicitly typed long or decimal. `x`,
`y`, `z` are aliases mapped to stable semantic IDs. Expected arithmetic is computed by
.NET decimal and checked Int64, independently of the evaluator.

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
| D1.26 | `x+1` with x=null Int64, `x and true` with x=null Boolean, each under a result declared to allow empty | Empty result of the declared kind, never zero or false |
| D1.27 | `x` with x=null Text under a result declared always to answer | Missing input error |
| D1.28 | Optional function `Score(value,effort)=value/effort`; callers `Score(v,e)` (optional) and `Score(v,e)+1` (required), with e=null and e=2 | Optional caller reads empty, required caller a missing input; 2 and 3 when rated |
| D1.29 | `x > 5 ? Refuse('Ratings are 1 to 5.') : x` with x=3 and 7, also under an optional result | 3; refused with the author's sentence, not quietened by the optional result; the refusal takes the other outcome's kind |
| D1.30 | `Refuse('...')` alone, inside arithmetic, on both sides of a choice, with a non-text or second argument | Definition refusal |

**Failure oracle.** With the same decimal, Int64, overflow and invariant options but
without the division interception, `1L/3L` and literal `1/3` return Double
0.3333333333333333, 9007199254740993L/1L returns Double 9007199254740992, and the
D1.02 comparison returns true. The lane asserts that this control still fails; these
are never acceptable production values.

## D2: limits, allocation and cancellation

`BehaviourLimitTests`, and `BehaviourActionTests` for D2.01–02. The ceilings are
those of the [contract](../contracts/calculations-and-actions.md#limits). Adversarial
work runs under an external watchdog: a timeout, a kill or a worker still running
after the caller returns fails the lane, and is not skipped as flaky. A reduced
ceiling is a host-owned setting, never file authority.

| ID | Setup and boundary | Required result |
| --- | --- | --- |
| D2.01 | Real fixture below; related-row ceiling 3 and 64 for the two-action edit | 3 rolls back with `calculation-limit-reached` and no receipt; 64 succeeds with total 2 |
| D2.02 | Same chain, generated-change ceiling 1, 2, 3 | 1 rolls back; 2 and 3 succeed with two generated writes |
| D2.03 | Syntax cap 3; expressions `-1`, `1+1`, `-1+1` | First two pass (2/3 items), last refuses (4) |
| D2.04 | Id(x)=x; 6,7,8 nested calls around literal 1, tree depth cap 8 | First two pass; last refuses |
| D2.05 | Acyclic function chains of 15, 16, 17 definitions; validate the inner function first to warm the cache | 15 and 16 pass, 17 refuses; a cached dependency cannot bypass the depth limit |
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
| D2.16 | One()=1; invoke 63,64,65 times using the same budget | First 64 return 1L; 65th refuses |
| D2.17 | Compile 50 distinct formula IDs into one adapter, cache cap 16 | Clear-on-cap gives counts `(i % 16)+1`; never exceeds 16 |
| D2.18 | Function catalogue 31/32/33; parameter count 15/16/17; IDs length 127/128/129 | Below/at pass; above refuses |
| D2.19 | Start a worker repeatedly evaluating `1+2`; signal started, cancel, await it | Cancellation observed, worker completed; not just stop awaiting |
| D2.20–22 | Independently measure 1,100,1000 evaluations of `1/3+2.0` | Exact decimal reference each time; record total elapsed and allocated bytes |
| D2.23–25 | After 1,100,1000 evaluations on worker, signal readiness, continue, cancel and await | Measure Cancel-to-worker-join interval; all workers completed |
| D2.26 | Cold compile of 17 calculations, each a ~1,000-character text literal | Succeeds: each formula compiles under its own work allowance, whatever the cache holds |
| D2.27 | Definitions ceiling 4; 3, 4, 5 calculations | 3 and 4 pass; 5 refuses naming the limit; every kind counts |

Keep below/at/above tests in a **real transaction** where the ceiling is a save's;
counter unit tests alone do not show integration. Exercise every new ceiling the same
way.

## Shared real SQLite fixture

A task-owned `.nendo` file created through the coordinator and canonical operations;
no in-memory replacement. Application and instance identity come from its real
manifest, and the device grant is stored outside the file.

| Entity | Fields | Seed records |
| --- | --- | --- |
| projects | projectName Text, total Integer, complete Boolean | p1: Project, 1L, false |
| tasks | project Reference to projects using projectName display field; done Boolean; title Text | t1: p1,true,First; t2: p1,false,Second |

All stored fields are required. The reference is configured with
`ConfigureReferenceOperation`. Seed record versions are 1; supply the expected
reference target version where the canonical API requires it. Grant local-data
authority for the exact behaviour.

The initiating request (`edit`, stable idempotency key) stages two operations: set
t2.done=true at expected record version 1, then t2.title=Finished at expected version
2. Event processing starts only after both are staged. Trigger order: `10-total`
assigns count(done tasks) to p1.total; `20-complete` assigns count(done
tasks)==count(all tasks) to p1.complete. The related read is host-owned; formulas
receive typed counts, never database access. Expected final total=2L, complete=true.
Generated changes use current staged record versions.

`total` is an action-written stored field here. Calculated totals are covered
separately by `BehaviourCalculationTests`.

## D3: atomic triggers

`BehaviourActionTests`, and `BehaviourGrantTests` for revocation mid-save.

| ID | Action/failure | Required assertions |
| --- | --- | --- |
| D3.01 | Add p2 (total 0, false), reassign completed t1 from p1 to p2 | Both parents updated: p1.total=0, p2.total=1, p2.complete=true |
| D3.02 | Create completed t3 under p1, then delete incomplete t2 | Create/delete membership events; total becomes 2; final project complete=true |
| D3.03–04 | Inject failure after action 1 and after action 2 | Manifest and every record/value/version equal the pre-edit snapshot; no successful `edit` receipt |
| D3.05 | Successful two-field edit, retry same key | One t2 event, total then completion; four canonical operations in one causal revision; same receipt/revision and no repeated actions |
| D3.06 | Set t1.done=true when already true | No logical update event or generated action |
| D3.07 | Condition expression `1/0=1.0` | One blocked condition, no actions, otherwise valid initiating fields committed |
| D3.08 | Condition true, second selected action input `1/0=1.0` | Entire edit and prior total step roll back |
| D3.09 | Revoke local grant immediately before commit | Entire transaction rolls back |
| D3.10 | Cancel immediately before commit | Entire transaction rolls back; cancellation observed |
| D3.11 | Project-update trigger toggles complete repeatedly; change cap 4 | Limit refusal and whole initiating chain rollback |
| D3.12 | Throw IOException after successful commit, close/reopen, retry key | Durable success receipt returned; no repeated generated effects |
| D3.15 | Deletion trigger whose condition is a constant false | The action does not run |
| D3.16 | An action clears a task's reference; a second recounts the parent | The former parent's total drops |
| D3.17 | An action assigns a Text result to an Integer field | Refused at install as `action-target-mismatch`; a stored one refuses the save with a typed error |
| D3.18 | An action assigns an Integer result to a Text field | Refused at install; a stored one is refused even when the stored text has the same digits |

Check for an absent success receipt at **every** rollback point, with canonical
before/after evidence and lineage counters. Condition false, blocked condition and
selected-action failure are distinct states.

## D4: proposals and local trust

`BehaviourProposalTests` and `BehaviourGrantTests`. Expand on a physical backup clone,
then validate and review through the normal physical proposal workspace, with a valid
proposal ID (`proposal-` and 32 hex). Store the captured read set and manifest with
the plan; never build promotion preconditions from a fresh read.

| ID | Setup | Required assertions |
| --- | --- | --- |
| D4.01 | Capture untouched t1 version=1; set its plan read-precondition to 999 while the manifest is unchanged | Not previewable/refused; read-only dependencies are checked independently |
| D4.02 | Revoke local grant; install file metadata `approved:true`; attempt edit | No authority acquired; file/records remain inspectable and edit refuses |
| D4.03 | Preview expanded plan, revoke grant immediately before promotion commit | Promotion refuses, records/manifest unchanged |
| D4.04 | A child process promotes a changed condition true→false definition and exits 73 before persisting the grant, skipping disposal | Reopen shows the committed definition and three records; the missing grant blocks edit |
| D4.05 | Expand two-step chain on physical clone; preview then promote exact operations | Active file unchanged by preview; four reviewed ops; reviewed/committed digest matches; zero replay-time trigger executions/events |
| D4.06 | Preview aggregate-dependent plan; insert matching t3 before promotion | Captured data revision stale, promotion refuses, no partial application |
| D4.07 | Missing grant, then mismatching behaviour digest | Writes refuse; reads/snapshot unchanged |
| D4.08 | Independently alter application ID, instance ID, digest, capabilities, contract and definition revision | Each grant mismatch refuses |

The crash child runs under a 15-second watchdog and must exit 73; any other exit code
or a forced kill fails. The process exists only to interrupt promotion.

## Beyond the numbered lanes

The real-host lane is `tools/Journey-Behaviour.mjs` (`tools/Test-JourneyPilot.ps1`).
It, and the suites that cover what the numbered rows do not, are listed in the
contract under
[where the assertions live](../contracts/calculations-and-actions.md#where-the-assertions-live).
