# ADR 0008 historical acceptance evidence

Recorded 2026-09-12. This is the concise evidence carried forward when the owner
requested a standalone [production implementation plan](adr-0008-implementation-plan.md)
and cleanup of the disposable suite. ADR 0008 remains Accepted on its historical
design evidence. **The prototype code, runners, copied hosts and scratch outputs
have been retired. The old commands below no longer run.** Implement the
[regression specifications](adr-0008-regressions.md) in normal tests before
claiming production results. No current executable-acceptance claim is made here.

## Scope and literal outcomes

| Lane | Historical command | Observed outcome |
| --- | --- | --- |
| Final complete suite | `pwsh ./prototypes/adr-0008/Run.ps1 -Lane All -NoRestore` | Exit0; 70 console cases passed, 0 failed; isolated WinUI/WebView2 host passed |
| D1 | Selected by `-Lane D1` | 25 typed scalar/runtime cases passed in final complete run |
| D2 | Selected by `-Lane D2` | 25 budget/parser/allocation/cancellation cases passed in final complete run |
| D3 | Selected by `-Lane D3` | 12 real SQLite action/receipt cases passed in final complete run |
| D4 | Selected by `-Lane D4` | 8 physical-clone/read-set/local-trust cases passed in final complete run |
| Final expanded host check | `pwsh ./prototypes/adr-0008/Run-Host.ps1` | Exit0; retained input and unchanged records/manifest after action1, action2 and precommit failure |
| Original raw candidate | `dotnet ./artifacts/bin/Experiment/debug/Nendo.Adr0008.Experiment.dll --raw` | 15 passed, 4 failed, exit1; raw NCalc decimal mode alone was insufficient |
| Locked restore | `dotnet restore prototypes/adr-0008/Experiment.csproj --locked-mode` | Succeeded for preserved resolution |
| Prototype console build | `dotnet build prototypes/adr-0008/Experiment.csproj --no-restore` | Succeeded, 0 warnings/errors |
| Copied Desktop build | `dotnet build artifacts/adr-0008/host/Nendo.Desktop/Nendo.Adr0008.Desktop.csproj -p:Platform=x64 -p:SelfContained=false` | Succeeded, 0 warnings/errors after source/XAML inclusion fix |
| Copied Workbench | `npm ci`, `npm run build` in isolated Workbench copy | Succeeded; Vite large-chunk warning remained |
| Repository | `pwsh ./tools/Test-Repository.ps1` | Exit0; `Repository verification passed.` |
| Production full gate/app packaging/installed application | Not run by experiment | No production scripting implementation, installer or installed-app claim |

All experiment files used task-owned roots. Owner application files and the
installed Nendo application were not opened/changed by the experiment. Existing
unrelated working changes remained; the baseline commit alone does not reproduce
the dirty source snapshot used. The console suite compiled an isolated copy of
actual Engine sources and used SQLite, canonical operations, coordinator transactions,
physical clones, revision history and receipts, not an in-memory substitute.

## Candidate and numeric defect

SDK: **10.0.204**, target net10.0, Windows x64. Repository baseline commit:
`813b56a6b4d804605741a9fda3c25460786c491a` plus working-tree source hashes below.
NCalc **7.1.0**, MIT licence, matching upstream source commit
[`da4f6eab38c00287f53a8d6b221727b5b9113a3c`](https://github.com/ncalc/ncalc/tree/da4f6eab38c00287f53a8d6b221727b5b9113a3c).

The exact NuGet transitive versions/content hashes are preserved in
[adr-0008-dependencies.lock.json](adr-0008-dependencies.lock.json), a reference
resolution only. It includes NCalc/Core/Parser/Domain 7.1.0, Parlot 1.5.8,
ExtendedNumerics.BigDecimal 3003.2.0.161, Microsoft.Extensions logging/DI
abstractions 10.0.10, Microsoft.Data.Sqlite/Core 10.0.11 and SQLitePCLRaw
bundle/core/native/provider 2.1.12. BigDecimal was transitive, not an accepted
scalar type. No NCalc dependency entered the production graph during acceptance.

The first configuration used DecimalAsDefault, LongAsDefault, OverflowProtection,
NoStringTypeCoercion, OrdinalStringComparer, NoCache and invariant culture.
It still produced these failures:

| Input | Required | Raw result |
| --- | --- | --- |
| Int64 1/3 | Decimal 0.3333333333333333333333333333 | Double 0.3333333333333333 |
| Int64 9007199254740993/1 | Decimal 9007199254740993 | Double 9007199254740992 |
| `(x/y)=z`, same large x/y, z=9007199254740992L | false | true |
| Literal `1/3` | Decimal quotient | Double quotient |

The authorised follow-up used a **272-line** typed adapter. It kept NCalc parsing
and evaluation, intercepted division on its typed operands, guarded null/control
flow, validated an AST allow-list, and counted visits. It did not replace the
interpreter or move evaluation to another process. The Boolean comparison failure
shows why rejecting/casting only the final floating result would be insufficient.

Matching upstream source inspection identified:

- `src/NCalc.Core/Helpers/MathHelper.cs`, `Divide`: an integer-only path calls
  `Convert.ToDouble`. Other mathematical built-ins also use Double; they were
  excluded from the approved function list.
- `src/NCalc.Parser/LogicalExpressionParser.cs`: deferred recursive expression,
  grouping, function and unary parsing. The adapter limited source/nesting/lexical
  size before this path and AST size/depth afterwards. Cancellation tokens alone
  were not considered proof of parser containment.
- `src/NCalc.Core/Visitors/EvaluationVisitor.cs`: recursive traversal and custom
  handler invocation. A counting visitor charged permitted nodes/functions; all
  application function calls shared the same budget. Async uncounted entrypoints,
  arbitrary object parameters and general built-ins were not exposed.

## Measured cost and host behaviour

These are old local observations, not promised production latency or a real-time
memory/CPU guarantee. Repeated expressions used `1/3+2.0`, with a new budget for
each independent evaluation and a cache in the adapter. Timing includes harness
overhead; allocation uses process-wide `GC.GetTotalAllocatedBytes`, which includes
runtime activity. Cancellation timing runs from Cancel through actual worker join.

| Evaluations before measurement/cancellation | Evaluation elapsed ms | Allocated bytes | Cancellation completion ms |
| ---: | ---: | ---: | ---: |
| 1 | 0.449 | 3,792 | 0.1042 |
| 100 | 0.360 | 198,624 | 0.0504 |
| 1000 | 4.4256 | 1,972,248 | 0.0591 |

Finite limits and exact boundary inputs are preserved in
[semantics](adr-0008-semantics.md) and [regressions](adr-0008-regressions.md).
The outer watchdog was 60 seconds; termination was a failed case, not an isolation
mechanism. The promotion-interruption child expected exit 73 after commit; it was
a failure injection tool only, not a worker-process expression runtime.

Final host result: UI thread 2, worker thread 5; three real WebView ticks while
evaluation was active; cancellation joined the worker; depth 25 returned
`LimitException: parse depth`; Studio remained reachable. The form retained
Done=Yes and `Retain this unsaved input` after failures after action1, action2 and
immediately before commit; all records and manifest remained equal to the before
snapshot. Native recovery was reachable and Studio restarted. Light and Dark
captures were inspected. This was an isolated real WinUI/WebView2 process, not
inferred from console success or a separately healthy application.

## Integration lessons and limitations

The fixture had one project, two related tasks and two ordered actions. It proved
the transaction/replay mechanism, not generic dependency-driven calculated fields.
Its total was an action-written field. Whole-definition/data revision checks were
deliberately conservative. Read-record versions were captured in host memory;
production must persist them bound to the exact reviewed plan. The protected
singleton behaviour JSON, `experiment-1`, internal digest override, AsyncLocal
scope and simple grant file were disposable test mechanisms, not stable formats.

The host exposed a production form-recovery defect: `runMutation` refreshes/renders
after a validation failure and discards unsaved input. The isolated Workbench
patch skipped both renders for a same-file editable validation refusal. The
production fix, authority-loss/unknown-outcome handling and lifecycle tests remain
work in S7. No production `main.ts` change was made by the experiment.

Early host attempts built successfully but did not include source/Pages under
MSBuild's excluded artifacts directory. Explicit source/XAML inclusion fixed that;
those earlier builds were not successful runtime evidence. The actual Windows
apphost was required for runtime activation. Input/change events had to be
dispatched to update the real form before submission. These details matter when
building the production host test, not as requirements to keep a copied host.

## Cleanup disposition

At the owner's request, source/runner/fixture knowledge was transferred to the
implementation plan, semantics and regression specifications; the exact package
resolution and selected historical source hashes were retained as references.
The disposable project, patched copies, downloaded upstream source, generated
binaries/intermediates, screenshots/logs, local grants and test profiles were
removed. No code archive or retention scheme for scratch artifacts was introduced.
Recreate lasting executable tests during production implementation.

## Selected source provenance

These SHA-256 values identify relevant original working sources read by the
prototype, before experimental modifications. They are historical identification,
not a claim that current source matches or that deleted code can be reconstructed
from hashes. Source manifests were captured separately as Engine/host copies were
prepared; unrelated work could proceed concurrently.

| Source path | SHA-256 |
| --- | --- |
| global.json | `5175676ED73FA6A3A0628CB146E79DB5A5E7112130ADAA8164EB59ACF01D438E` |
| Directory.Build.props | `837F78821264AD2DBF8B80B6877A599B8FBA68A1CA01239F18BD4B01F0C8CB1A` |
| Directory.Packages.props | `BE69DC2365869E2AEFD823BCB495AC3A23D0E4636AEE8DC073EB2BD998152F66` |
| src/Nendo.Engine/NendoWriteCoordinator.cs | `4B42185273B1440A39A75A33FB9525FD42BF7AC508A1C90C90890ED355E47983` |
| src/Nendo.Engine/Operations.cs | `A5D62FFEF431A30040E3E3EBC5E7CB4B35C174922300E5BA863FE494486D9937` |
| src/Nendo.Engine/SemanticDiff.cs | `5F81752B6510D05B1F57864671E5EADBEF190FBBA48CC29046B34F733E631161` |
| src/Nendo.Engine/Storage/SqliteNendoStore.cs | `71E8A8128066A90B276080CA8313FFB2FF8442D94F502F3376DA183191EB2E0D` |
| src/Nendo.Desktop/DesktopSessionController.cs | `67559C07F5E8DDB43F83F9AE28980D221B8B8834068101FF2246577ED829E504` |
| src/Nendo.Desktop/MainPage.xaml.cs | `BDA525EAD6B80E872DB3EB17A49E95BE5B33C41F5C3BC097B13C5F6722508C10` |
| src/Nendo.Desktop/WorkbenchProtocol.cs | `9070B355A85CDE32D809B71782C526C56439873BAD9B51A32411F93BDAB8B535` |
| src/Nendo.Workbench/src/main.ts | `8A90761A206234E6738BBCBDEAF523D369BD4A193F019322DABA84706DA31704` |
