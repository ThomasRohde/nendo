# W-007 boundary experiment

The first candidate below failed. The subsequent
[OS boundary experiment](OS-BOUNDARY.md) closes the tested IPv4 loopback path using
AppContainer and a Job Object, with explicit remaining qualification gates.

This standalone Windows Forms/WebView2 executable probes a proposed custom-view
boundary. It has no references to production projects and opens no `.nendo` file.
The host page is a synthetic sentinel, **not Studio**. Passing its checks would not
qualify WinUI composition, the production bridge or the whole extension design.

## Run

Requires the repository's .NET 10 SDK, installed Windows Desktop targeting pack,
WebView2 Runtime and cached `Microsoft.Web.WebView2` **1.0.3719.77**. The local
NuGet.Config intentionally has no download sources. A missing dependency is a
restore failure, not permission to silently upgrade the probe.

From the repository root in PowerShell:

```powershell
dotnet restore prototypes/custom-views/BoundaryProbe.csproj --configfile prototypes/custom-views/NuGet.Config
dotnet build prototypes/custom-views/BoundaryProbe.csproj --no-restore -v minimal
& ./artifacts/bin/BoundaryProbe/debug/BoundaryProbe.exe
$LASTEXITCODE
# Negative control: deliberately remove independent browser environments.
& ./artifacts/bin/BoundaryProbe/debug/BoundaryProbe.exe --shared-environment
$LASTEXITCODE
# Restore the independent configuration and repeat.
& ./artifacts/bin/BoundaryProbe/debug/BoundaryProbe.exe
$LASTEXITCODE
```

Exit 0 means all implemented assertions passed, 1 is a harness failure, and 2 is
a boundary assertion failure. **The current isolated configuration returns 2.**
Do not turn this into a passing security gate by expecting the leak forever.

The form is invisible, but uses a real native window and UI message loop. Each run
creates new profiles under `artifacts/custom-view-probe/<random-id>`, never the
owner's profile. Only process IDs returned by these environments are terminated.
Its UDP/TCP listeners bind ephemeral loopback ports; there are no Internet targets
or connections to the live MCP server. Results and browser profiles are disposable
scratch. The source and assertions are the reproducible evidence.

## Measured on 2026-09-20

.NET SDK 10.0.204; WebView2 Runtime 153.0.4234.32; Windows x64. These results are
automated observations of this harness, not owner acceptance or production tests.

| Check | Result |
| --- | --- |
| Restore with explicit local config | Passed outside the agent sandbox; cache used, no downloads |
| Build, final source | Exit 0; 0 warnings, 0 errors |
| Separate environments | Different browser PIDs, 77644 and 78228 |
| UDP observer calibration | Received the known 3-byte control datagram |
| Fetch/WebSocket attempt | No TCP accept during 500 ms; a limited observation, not a universal network claim |
| WebRTC under restrictive CSP and request interception | **Failed**: 20-byte STUN packet received; magic cookie matched; request filter did not observe it |
| Host script while extension loops forever | Host sentinel edited to `After` within the 2-second timeout |
| Host script after terminating extension tree | Still read `After`; termination/failure notification/read sequence 71 ms |
| Shared-environment negative control | **Expected failure**: both browser IDs 66452; termination skipped to avoid killing the sentinel |
| Restored independent environments | Independence/hang checks passed again; network assertion still failed; exit 2 |

Literal network failure (repeatable in both environment configurations):

```json
{"check":"deny-webrtc-loopback-egress","passed":false,"detail":{"launch":"\u0022started\u0022","receivedBytes":20,"stunMagicCookie":true,"interceptedStun":false}}
```

Literal isolation falsification:

```json
{"check":"independent-browser-processes","passed":false,"detail":{"hostId":66452,"extensionId":66452,"sharedEnvironment":true,"runtime":"153.0.4234.32"}}
```

An initial sandboxed restore could not read the user NuGet.Config; an explicit
config still encountered that SDK access. Restore succeeded with scoped escalation.
An initial sandboxed runtime attempt timed out on navigation; it supplied no
security evidence. Subsequent runs outside that sandbox produced the results above.
An initial build included an unused package WPF reference and emitted MSB3277;
the probe now removes that unused reference and builds without warnings.

## Consequence and remaining work

CSP plus `WebResourceRequested` is insufficient for the required no-network
boundary. Separate environments improve failure containment but do not fix this.
The WebRTC guard is a detected, **unfixed** boundary failure. Only the environment
separation guard has been falsified and restored. No production defect is alleged:
the shipped host does not execute arbitrary extension packages.

P1 stops at this gate as required by the plan. Before adopting arbitrary package
JavaScript, investigate an independently enforceable OS/process network policy,
including non-HTTP traffic, all child processes and CPU/memory enforcement. This
would need a revised composition decision and another disposable experiment.
Do not equate removing the WebRTC JavaScript global or a browser startup flag with
an established security boundary. A narrower declarative graph rendered by the host
is the fallback option for owner review, not a silently substituted implementation.

Not run: production Studio during failure, full network matrix (DNS, TURN, external
destinations and other protocols), package lifecycle, broker fuzzing, coherent
Engine projection, migration/downgrade, consent/revocation, UI accessibility/theme,
hard CPU/memory limits, installer, production tests or owner usefulness review.

Technical references used to select the probe:
[WebView2 process model](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model)
and [request interception](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/webresourcerequested).
The packet and process outcomes above were measured locally rather than inferred
from those documents.
