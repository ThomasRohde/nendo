# W-007: AppContainer and Job Object experiment

2026-09-20. The owner retained executable extensions and authorized an OS-enforced
isolation prototype. This is the second P1 experiment, not production integration
or architecture acceptance. The original [CSP-only failure](README.md) remains a
valid historical result.

This document records that experiment's original observations. The owner later
accepted the architecture amendment in ADR-0013; W-007 is now Doing within accepted
scope. Production integration and its separate evidence are in
[`docs/contracts/custom-views.md`](../../docs/contracts/custom-views.md).

## Implemented boundary

The supervisor creates a uniquely named AppContainer profile with **zero
capabilities**, starts a helper suspended using `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`,
assigns it to an unnamed Job Object, and only then resumes execution. It never
permits job breakaway. The job has kill-on-close, an aggregate memory-commit limit,
and a 20% CPU hard-cap policy. CPU/memory policy readback is checked; CPU saturation
and an allocation-pressure guard are not yet tested.

Only a copied probe payload receives that profile SID's read/execute ACL. Only its
task-owned state directory receives modify access and a low-integrity label. A
synthetic secret outside those grants is the file-denial target. No owner data or
global runtime directory receives an ACL change. The child gets a minimal environment
with no inherited credentials, proxy settings, user profile or parent environment
block. There are no machine firewall rules, loopback exemptions or browser security
flags. The profile is deleted in `finally`; every completed run below returned
`DeleteAppContainerProfile HRESULT=0x00000000`.

The helper launches a native-socket descendant and then WebView2 with its own data
directory. No CSP or network-request interception mediates this probe. Both native
processes attempt UDP/TCP loopback; the WebView attempts the WebRTC STUN path that
bypassed the previous candidate. The outer supervisor owns the packet listeners
and independently checks the reported browser PIDs' tokens and membership in its
**exact** Job Object. JavaScript never receives OS handles or APIs. Native socket
probes exercise containment underneath it; the helper is trusted prototype code,
not a native extension-loading facility.

Microsoft documents capability-controlled network isolation in
[AppContainer launch](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)
and process inheritance/termination in
[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).
The results below are measurements, not conclusions inferred from documentation.
Recheck the grant set and process tree when the helper, runtime or capability
requirements change.

## Reproduce

Use the restore/build prerequisites in [README](README.md). From repository root:

```powershell
dotnet build prototypes/custom-views/BoundaryProbe.csproj --no-restore -v minimal
# Contained case.
& ./artifacts/bin/BoundaryProbe/debug/BoundaryProbe.exe --os-parent --512-mib
$LASTEXITCODE
# Falsification: same code, listeners and assertions, without AppContainer.
& ./artifacts/bin/BoundaryProbe/debug/BoundaryProbe.exe --os-parent --512-mib --control
$LASTEXITCODE
# Restore containment; loop the renderer, close the job and measure termination.
& ./artifacts/bin/BoundaryProbe/debug/BoundaryProbe.exe --os-parent --512-mib --terminate-tree
$LASTEXITCODE
```

Exit 0 means all implemented assertions passed; 2 means a measured assertion failed,
including expected negative-control failures; 1 means harness failure. Control mode
does not force an exit code: it runs the same assertions. The supervisor stays
outside the job it terminates. Omitting budget flags tests the original 256 MiB budget;
`--wide-budget` tests 1 GiB for diagnosis. Neither changes capabilities.

UI is hidden; only synthetic content and ephemeral local listeners are used. No
`.nendo` file or running Nendo process is opened. Task-owned profiles and run results
are scratch; source and linked planner Checks carry reproducible evidence. The
installed app and installer were not rebuilt because production code did not change.

## Observations

Windows x64, .NET SDK 10.0.204, WebView2 SDK 1.0.3719.77, runtime 153.0.4234.32.
Build: exit 0, zero warnings/errors.

| Lane | Outcome and scope |
| --- | --- |
| 512 MiB contained run | Exit 0; rendered and exited normally; 0 datagrams and 0 TCP connections received; both synthetic file reads refused |
| Parent-observed processes | Five WebView2 PIDs (browser, renderer, GPU, two utility processes) had AppContainer tokens and belonged to the exact job |
| Native descendant | Also AppContainer; file read raised `UnauthorizedAccessException`; TCP timed out; UDP did not reach the listener |
| Matched control | Exit 2; both helpers read `synthetic-only`; two TCP connections; two 3-byte native datagrams and five 20-byte STUN packets received |
| Restored containment and loop | Exit 0; zero traffic; final run acknowledged JavaScript entering the loop, then job close terminated helper and all five observed browser processes within 50 ms (earlier run: 55 ms) |
| Memory policy | 512 MiB readback = 536870912 bytes; final loop run peak job commit = 276480000 bytes (about 264 MiB) |
| CPU policy | Readback flags 5 (enable plus hard cap), rate 2000 (20%); workload-throughput ceiling not measured |
| 256 MiB attempts | Timed out, including the control; control peak job commit 271355904 bytes; this budget is not qualified |
| 1 GiB diagnostic | Rendered and exited 0; no traffic received; peak job commit 282255360 bytes |

UDP `Send` returned success inside AppContainer while the receiver saw nothing.
The guard therefore asserts receiver observations, not a particular socket error.
Native TCP deadlines are 2 seconds; the WebRTC observation window is 5 seconds.
These are IPv4 loopback results, not every destination/protocol/runtime version.

Literal guard failures after removing AppContainer, all passing again on restoration:

```json
"helper-appcontainer": false,
"native-and-webrtc-no-received-packets": false,
"helper-file-denied": false,
"descendant-file-denied": false,
"descendant-appcontainer": false,
"browser-processes-appcontainer": false
```

`browser-processes-in-exact-job` and `job-limits-readback` stayed true in the control:
removing AppContainer does not remove the job. Kill-on-close was exercised, but
not yet falsified by removing that flag. CPU/memory readback is not pressure evidence.

The initial harness incorrectly read `ExitCode` through `Process.GetProcessById`
after exit and reported a harness error. It now uses `GetExitCodeProcess` with the
retained creation handle. The 256 MiB runs still timed out after this repair.

## Candidate and remaining gates

Keep trusted Studio in its host process. Launch an AppContainer helper per active
extension, containing WebView2 and its descendants in one job. Start suspended,
establish authority/limits, then resume. Setup failure terminates the suspended
helper; never fall back to an uncontained renderer. Treat 512 MiB as the next
experimental budget, replacing the unusable 256 MiB assumption, not a production
capacity promise.

The specific IPv4 loopback hole now has a measured countermeasure, so this candidate
can progress through P1. W-007 remains Needs decision/ADR. The owner authorized the
investigation, not architecture acceptance. Before an acceptance-ready decision:

- Implement a bounded, authenticated host/helper IPC broker and audit inherited
  handles. Projection is not yet passed across this boundary.
- Complete IPv6, non-loopback, DNS, HTTP(S), WebSocket, TURN, worker, redirect and
  permission probes with positive controls; policy/service changes must fail closed.
- Attempt process breakaway and broker escapes. Failure to inspect a process must
  fail the check, not be silently treated as containment.
- Run CPU/memory pressure tests and falsify resource/termination guards; size real
  workloads. Policy readback does not satisfy those obligations.
- Prove WinUI surface composition, focus, accessibility, themes, real Studio
  recovery, package/consent lifecycle, coherent projection and format compatibility.

These bounded checks alone do not constitute an acceptance-ready ADR.

## Additional local network checks, 2026-09-20

`--ipv6` selects IPv6 loopback for native TCP/UDP and browser STUN probes.
`--http-web` adds independent HTTP/UDP receivers and the shared `HttpCanary`
browser workload. For each address family, run the probe with and without
`--control`, keeping `--os-parent --512-mib --http-web` unchanged.

Final IPv4 and IPv6 controls each received all eight HTTP routes (fetch,
WebSocket upgrade request, worker, frame, redirect, redirected target, localhost
hostname and download), plus five 20-byte STUN datagrams on the HTTP canary's
UDP socket. Controls exited 2 as expected because the containment guards failed.
Both contained runs exited 0, with zero HTTP requests and zero UDP datagrams.
Control downloads are restricted to a synthetic file under the owned state root.
Logs are `artifacts/extension-runtime-results/egress-{ipv4,ipv6}-{control,contained}.log`.

The production helper tests compile-link the same `HttpCanary` fixture and use
its exact browser workload. Both cases passed, with a valid selection received
after the observation window and no traffic received by either canary. Each test
first exercises a separate receiver with native HTTP/UDP positive controls.
The Desktop regression excluding only the locked interactive journey passed
277/277 in 57 seconds, exit 0 (`egress-desktop-regression.log`).

These observations cover local destinations only. `localhost` is not an external
DNS test. At this point the HTTP fixture recorded a WebSocket upgrade request but
did not complete a WebSocket handshake; the section below closes that gap.
External destinations, TLS, clipboard and broader file-URL handling remain open.

## Completed WebSocket exchange, 2026-09-20

`HttpCanary` now answers the upgrade with `HTTP/1.1 101 Switching Protocols`,
wraps the accepted stream in a server `WebSocket` and reads one bounded text
frame. The shared browser script sends `synthetic-websocket-canary` as soon as
its socket opens. The supervisor records `webSocketMessages` and adds the
guard `websocket-no-received-messages`, which requires an empty list.

| Case | Exit | Received messages | `websocket-no-received-messages` |
| --- | ---: | --- | --- |
| IPv4 contained | 0 | none | true |
| IPv4 control | 2 | `synthetic-websocket-canary` | false |
| IPv6 contained | 0 | none | true |
| IPv6 control | 2 | `synthetic-websocket-canary` | false |

Each control also received all eight HTTP routes and five STUN datagrams, and
each contained run received no HTTP request, datagram or message while the
WebView still completed. All four profiles were deleted with HRESULT 0. Logs are
`artifacts/extension-runtime-results/websocket-{ipv4,ipv6}-{control,contained}.log`.

The first contained attempt failed as a harness defect, not a containment one:
the supervisor read `webview.json` with `File.ReadAllText`, whose `FileShare.Read`
open refused the helper's concurrent `WriteAllText`, and the helper recorded
`The process cannot access the file ... webview.json because it is being used by
another process.` at its navigation stage. The reader now opens the report with
`FileShare.ReadWrite` and still retries partial JSON. That race has no
deterministic falsification guard; it is recorded as an observed fixture defect.

The production helper tests link the same fixture. Each IPv4/IPv6 case first
proves a native `ClientWebSocket` control is received, then requires no message
from the contained page (`A WebSocket message reached the receiver.`); both
passed, 2/2 in 16 seconds (`websocket-production.log`).

## TLS, resolver, file URL and loopback MCP shape, 2026-09-20

`--http-web` now also runs these attempts and observers:

| Attempt from the page | Independent observer | Control | Contained |
| --- | --- | --- | --- |
| `https:` fetch to a loopback port | Raw listener records the first TLS record (`0x16`) | 2 client hellos per family | none |
| JSON-RPC `initialize` POST to `/mcp` | HTTP receiver records `POST /mcp?probe-canary` | received | none |
| `http://www.example.com:65535/` | Native `Dns.GetHostAddresses` in helper and descendant | four addresses | `SocketException:HostNotFound:11001` |
| `http://probe-canary-<id>.local:65535/` | mDNS listener on 224.0.0.251:5353 | 2 query datagrams | none |
| `file:` fetch, XHR, image, script, worker, frame | Page report only | all refused by Chromium | all refused |
| Helper navigates to the ungranted file | Batch oplock on the file, plus the page text | opened and displayed `synthetic-only` | navigation failed, no open |

Both contained runs exited 0 and both controls exited 2. Logs are
`storage-{ipv4,ipv6}-{control,contained}.log`. The loopback MCP row is the shape
of the call against the same receiver, not the owner's real host on port 41763.

Two observer lessons. `ipconfig /displaydns` and `Get-DnsClientCache` require
elevation on this Windows 11 26300 build, so the resolver cache cannot serve as
an unelevated observer; the native resolution result inside the same AppContainer
stands in for the browser's unicast query, and the `.local` query is observed on
the wire. A denied native open still breaks the oplock: the contained runs
observed two native attempts (both refused by the ACL, as `helper-file-denied`
and `descendant-file-denied` record) and zero from the browser, so the guard
counts only opens after the helper starts its file navigation.

## Clipboard, 2026-09-20

`--clipboard` shows the helper window, and the supervisor delivers a real
`SendInput` click to the page's button, so user activation and foreground come
from the OS. The supervisor first copies every clipboard format aside, places a
sentinel text, and puts the original formats back in `finally`. The page then
reads the clipboard, runs `execCommand('copy')` on a selection and calls
`navigator.clipboard.writeText`; browser permissions are allowed in both modes so
that only the OS boundary is measured.

| Run | `readText` | `execCommand('copy')` | `writeText` | Clipboard afterwards | Exit |
| --- | --- | --- | --- | --- | ---: |
| Control | sentinel | true | ok | `synthetic-clipboard-canary` | 2 |
| Contained | sentinel | true | ok | `synthetic-clipboard-canary` | 2 |

**The zero-capability AppContainer does not isolate the clipboard.** The
contained page read the supervisor's sentinel and overwrote the clipboard exactly
as the uncontained control did. Windows scopes the clipboard to the window
station, which the helper shares with the host. The production helper therefore
denies the clipboard-read permission and seals the page-side entry points before
any page script runs; that policy and its falsification are recorded in the
custom-view contract, and the OS result stays here as the reason the policy
exists. Logs: `clipboard-{control,contained}.log`. The first two attempts
missed the button because the supervisor injected virtualized coordinates at
150% display scaling; it is now per-monitor DPI aware and scales the page
rectangle by `devicePixelRatio`.

## Explicit Job breakaway, 2026-09-20

The probe now accepts `--breakaway`, testing ordinary and explicit
`CREATE_BREAKAWAY_FROM_JOB` child creation inside the AppContainer helper.
Both children are created suspended and never resumed. The supervisor inspects
membership against its exact Job handle before acknowledging the report; both
the helper and supervisor retain cleanup paths for created children.

`BoundaryProbe.exe --os-parent --512-mib --breakaway` passed, exit 0. Ordinary
creation succeeded inside the exact Job; explicit breakaway was refused with
Win32 error 5. Adding only `--allow-breakaway` sets the disposable Job's
`JOB_OBJECT_LIMIT_BREAKAWAY_OK` flag, as described by
[Microsoft's Job documentation](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).
That control exited 2: `"explicit-breakaway-refused": false` and
`"job-limits-readback": false`. Parent observation recorded ordinary-child
membership true and breakaway-child membership false for the exact Job. The
escaped child still had an AppContainer token and belonged to another enclosing
Job; checking membership in any Job would have concealed this escape.

Restoring the original flags passed all guards, exit 0. Both completed final
runs deleted their AppContainer profile with HRESULT 0. Logs:
`artifacts/extension-runtime-results/breakaway-exact-{control,contained}.log`.
This is a measured native CreateProcess attempt in the disposable OS prototype,
not a production browser exploit or a claim about every process-creation API.
CPU throughput, inherited-handle canaries and the other remaining P1 rows stay open.

## Bounded CPU workload, 2026-09-20

`--cpu-workload` runs a separate native workload instead of creating WebView2:
22 dedicated worker threads on this 22-logical-processor machine each spin for
eight seconds. Workers signal readiness before the supervisor takes baseline Job
accounting and releases them. The supervisor measures final user+kernel CPU time
and wall time independently. Parent timeout and kill-on-close remain active.

| Run | CPU seconds | Wall seconds | CPU / wall / 22 | Exit |
| --- | ---: | ---: | ---: | ---: |
| 20% configured cap | 38.484375 | 8.0721012 | 21.67% | 0 |
| Control permitting 100% | 152.765625 | 8.1309260 | 85.40% | 2 |
| Restored 20% cap | 37.031250 | 8.0574837 | 20.89% | 0 |

The identical measured guard requires a completed workload and a fraction above
2% and at most 25%; the five-percentage-point tolerance is explicit. The control
sets only `--cpu-control` and fails `"measured-cpu-within-25-percent": false`
(and the unchanged policy-readback guard). Restored containment passes. This is
elapsed aggregate CPU time, not an exact measurement of Windows' cycle quota;
[Microsoft documents the quota in processor cycles](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_cpu_rate_control_information).
It is one native saturation workload, not browser responsiveness or throughput.

Reproduce with `BoundaryProbe.exe --os-parent --512-mib --cpu-workload`, then add
`--cpu-control`, then repeat without it. Logs are
`artifacts/extension-runtime-results/cpu-{contained,control,restored}.log`.
The build had zero warnings/errors and all three completed profiles were deleted.
Production inherited-event evidence is separately in the custom-view contract;
visible recovery, broader network/storage and installed journeys remain open.
