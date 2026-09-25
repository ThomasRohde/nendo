# Iframe views spike: findings

Measured on 2026-09-25. Windows 11 Home 10.0.26300 on 22 logical processors, display scaled
150%. WebView2 Runtime **153.0.4234.48** (`CoreWebView2Environment.BrowserVersionString`).
WebView2 SDK **1.0.3179.45** (the file version of the loaded Core and WinForms assemblies).
.NET SDK 10.0.204 with runtime 10.0.8. The harness and how to rerun it are in
[README.md](README.md).

Everything below is an automated observation by an agent of a synthetic harness. It is not
the Workbench, not a production test and not owner-accepted. **Measured** means this harness
observed it; statements marked *inferred* were not measured. Figures come from the final
full run (main phase 16:07, restart phase 16:15: `results-main.json` and
`results-persist-read.json`). The S11 CSP-header trial and the S10 saved-grant trials were
added afterwards and ran on their own at 16:16 (`followup/results-main.json`). S10's
clipboard content check comes from a rerun at 16:20 (`followup-clipboard/results-main.json`),
because another process held the OS clipboard open until 16:15. Development runs at 15:51 and
16:02 gave the same answers; their figures are not quoted.

## Results

| # | Result | Evidence | Implication |
| --- | --- | --- | --- |
| S1 | **Isolated by default.** The Workbench, package A and package B each run in their own renderer. Two frames of one package share a renderer. | `GetProcessExtendedInfosAsync`: main frame in PID 41620; `a-1` and `a-2` (one origin) both in 36944; `b-1` in 38036. `Target.getTargets`: 1 page and 3 iframe targets. | `--site-per-process` is not needed. The process boundary is the package, not the panel. |
| S2 | **No `ProcessFailed` of any kind**, and the Workbench stayed responsive. | Waited 36 s after a real click into the spinning frame. Neither mouse event was ever acknowledged (`WaitingForActivation`), and a frame evaluate timed out. On the main target, 20 `Runtime.evaluate` calls had a median of 0.19 / 0.26 / 0.25 ms before / during / after (max 1.29). A Workbench button click registered in all three phases (1.4–2.3 ms dispatch); 57 / 49 / 54 animation frames per second. | As documented, `RenderProcessUnresponsive` covers only the main frame. The Workbench must detect a stuck view itself, e.g. with a postMessage heartbeat (*inferred*). |
| S3 | **Removing the element: not within 5 s.** The renderer exits about **10 s** later, spinning or idle alike. **`about:blank` ends it in 0.56 s**; killing the PID ends it at once. | Exit after removal: 10 052 ms (spinning, had input), 10 043 (spinning), 10 015 (idle). After `src = 'about:blank'`: 555 ms (spinning), 55 (idle). `Process.Kill`: 0 ms. Only the kill raised `ProcessFailed` (`FrameRenderProcessExited`, `Crashed`, exit code -1, frame `hang-d`). | The 10 s is Chromium's delay after the last frame leaves, not hang detection. To end a view promptly, navigate its frames to `about:blank`. |
| S4 | **`FrameRenderProcessExited`**. `FrameInfosForFailedProcess` carries `name="nendo-view-1"` and also `nendo-view-2`, the other frame of the same package. The Workbench survived. | `Page.crash` on the iframe target; the event arrived 902 ms later. Reason `Crashed`, exit code -2147483645 (0x80000003). Both names with sources, but `FrameKind` `Unknown` and `FrameId` 0. Two CDP `targetCrashed` events. Workbench: evaluate median 0.35 ms, button click registered. Both iframe elements stay (error page). Setting `src` again reloaded the view in a new renderer (27616). | Key crash reporting on the `name` attribute, not on `FrameId`. A crash takes down every panel of that package. Recover by reassigning `src`. |
| S5 | **Fast.** | Three runs. 5 MiB `.wasm` fetched in 42 / 38 / 37 ms. 200 small scripts loaded in parallel in 73 / 81 / 68 ms. Host time from event to `deferral.Complete()` (including a `Task.Run` lookup): median 3.9 / 0.6 / 0.3 ms, max 14 / 22 / 1 ms. 200 of 200 requests served. | `WebResourceRequested` with a deferral is not a bottleneck at this size, so no local HTTP server is needed. |
| S6 | **Yes.** The Workbench loads with only the `https://*.example/*` filter, and CSP blocks `fetch('https://example.org/')`. | `NavigationCompleted.IsSuccess` true. `securitypolicyviolation`: `connect-src`, blocked `https://example.org/`, then `TypeError: Failed to fetch`. A fetch to a view origin is blocked the same way. No request reached `WebResourceRequested`. | The catch-all 403 filter is not needed for the Workbench document. It also stopped view frames reaching the network, and nothing does that now (S11). |
| S7 | **Yes.** View frames load; `https://other.test/` is blocked. | `securitypolicyviolation` `frame-src`, blocked `https://other.test`. Console: "Framing 'https://other.test/' violates … frame-src https://*.example". The frame gets an error page (one load event, not readable). `FrameNavigationStarting` still fired for it before CSP blocked it. | `frame-src https://*.example` is enough for the Workbench document. |
| S8 | **`window.chrome.webview` is defined in view frames**, but a frame's `postMessage` **never reached** `CoreWebView2.WebMessageReceived`. | In a frame: `chrome.webview` object, `postMessage` function, and calling it throws nothing. With no frame handler, no host event at all. With a `CoreWebView2Frame.WebMessageReceived` handler, that event fired (`Source` = view URL). Control: the Workbench's own message reached the top-level event. | Never subscribe `CoreWebView2Frame.WebMessageReceived`. Keep the `Source` check on the top-level handler. |
| S9 | **Blocked by the sandbox.** Top-level `NavigationStarting` did not fire. | Scripted: `SecurityError: … does not have permission to navigate the target frame`. Console: "Unsafe attempt to initiate navigation … sandboxed, but the flag of 'allow-top-navigation' or 'allow-top-navigation-by-user-activation' is not set". Same after a real click (`hasBeenActive` true). No navigation event; the Workbench URL is unchanged. | The sandbox holds. Keep the `NavigationStarting` allowlist as the second line. |
| S9b | **Yes.** `CoreWebView2.FrameNavigationStarting` fires for a frame nested in a view, and `Cancel` works. The view frame's own `CoreWebView2Frame.NavigationStarting` does not fire for it. | Cancelled: one event for `https://app.nendo.local/index.html?nested=…`, and the nested frame stayed `about:blank`. Not cancelled (control): the nested frame loaded the Workbench origin. It is same-origin with the Workbench, which read its location; it can reach `top.document` and it has `chrome.webview`. Its `postMessage` reached no host handler. | Frame navigations need an allowlist (view origins, `about:blank`). Otherwise a view can place a second Workbench-origin document that can script the Workbench page. The view cannot run code in it (*inferred*). |
| S10 | **Yes: Allow makes `readText` work, and the request carries the Workbench's origin.** `clipboard-read` raises `CoreWebView2Frame.PermissionRequested`, then `CoreWebView2.PermissionRequested` (`ClipboardRead`, `IsUserInitiated` true), with **`Uri` = `https://app.nendo.local/`**, not the view's origin. `writeText` raises none. | 16:20 rerun, after a real click: the view's `writeText` put the token on the OS clipboard (the harness read it back). Allow: `readText` returned the token. Deny: `NotAllowedError: Read permission denied`. Without activation, both calls fail: `Document is not focused`. With the default `SavesInProfile`, an Allow for one view applied to a second view origin under a Deny policy: no event, `permissions.query` `granted`, token read. Results were the same with real OS focus. At 16:07 another process held the clipboard open (`OpenClipboard` error 5 on 92 attempts); `writeText` still resolved and `readText` returned `""`. | `Uri` cannot identify the view, and a saved grant covers every view. Handle `CoreWebView2Frame.PermissionRequested` (raised first, per frame) and set `SavesInProfile = false`. |
| S11 | **Loopback arrives. No Local/Private Network Access preflight or prompt. Public fetch works (online).** A host-set CSP header on the view document blocks loopback. | Under both Deny and Allow policies: fetch 200 `canary` and WebSocket open. The canary saw `GET` with `Origin: https://spike-net1-….example` and `Sec-Fetch-Site: cross-site`, no `OPTIONS`, no `Access-Control-Request-Private-Network`; 0 permission events. `https://example.org/`: `no-cors` gives `opaque`; `cors` gives `TypeError`. With `Content-Security-Policy: connect-src 'self'`: fetch `TypeError`, WebSocket error, same-origin fetch 200, 0 hits. | Runtime 153 does not gate loopback or the internet for views. Send a CSP with every view document from `WebResourceRequested`. |
| S12 | **`moveBefore` keeps the frame.** `appendChild` and `innerHTML` reload it. | `typeof Element.prototype.moveBefore` is `function`. After `moveBefore`: `performance.timeOrigin` unchanged (1790345265485), no new hello, load events stay 1. After `appendChild`: new `timeOrigin` (+2466 ms), a second load event. After `innerHTML`: a new document. The renderer PID is unchanged throughout. | Move live views only with `moveBefore`. |
| S13 | **DevTools works.** `ContextMenuRequested` fires for a right-click in a view, but **`IsRequestedForMainFrame` was false for the Workbench's own main frame too**. So the rule handled nothing, and the default menu opened in both places. | `OpenDevToolsWindow()`: a `DevTools` window and a `devtools://` target, closed again. Workbench right-click: `FrameUri` = `PageUri` = the Workbench URL, flag `false`, menu window 405×384. View right-click: `FrameUri` = view URL, `PageUri` = Workbench URL, flag `false`, menu window (Back, Refresh, Save as, Print, More tools, Inspect). Handling every event: no menu in either place. | Do not use `IsRequestedForMainFrame`; decide by `FrameUri`. A view's default menu offers Inspect, Save as and Print. |
| S14 | **One renderer per package.** 6 panels from 3 packages plus a screen: **108–109 MiB** of view renderers (screen from one of the 3) or **117–126 MiB** (screen from a 4th), and 310–335 MiB across all WebView2 processes. | Private working set (`PROCESS_MEMORY_COUNTERS_EX2`), median of 5 samples 5 s after load, two rounds. The table below has every row. | See the budget under Decisions. |
| S15 | **`IsUserInitiated` is true for a click on `<a target=_blank>` and false for `window.open` without activation.** The event is raised either way; `Uri` is the full target URL. | Link click: `true`, `https://spike-alpha-….example/popup.html?from=link`. Scripted, no activation: `false`, raised anyway (no popup blocker). `window.open` inside a click handler: `true`. `OriginalSourceFrameInfo` gives the view frame's name and URL; `Name` is empty. `window.open` returns `null` when the host sets `Handled`. | The host can gate new windows on `IsUserInitiated` and name the view from `OriginalSourceFrameInfo`. |
| S16 | **Both survive a restart.** | Token written in a frame of `https://spike-persist-d31802fc7f.example` (the write phase's `hasStorageAccess()` returned true). A new harness process on the same user data folder read the same token from `localStorage` and IndexedDB. A frame of another origin saw neither. | View state persists per package origin, so a stable `{slug}-{key}` keeps it (*inferred*). |
| S17 | **No: it loads well before it is visible.** | Nothing was requested while the frame sat 5 679 px below the scroller's visible bottom (3 s). The first request came after scrolling to 2 429 px below it (250 px steps). The scroller's bottom was at the viewport's bottom (650 vs 634 CSS px). | `loading="lazy"` starts a view about 2.4k px early. If a view must start only when visible, set `src` from an `IntersectionObserver` (*inferred*). |
| S18 | **Yes.** | Through `WebResourceRequested`: classic worker `/w.js` (`Other`) and its fetch `/data.json` (`XmlHttpRequest`); module worker `/wm.js` and its import `/mod.js` (`Other`); the page's `import('/mod.js')` (`Script`). Every request had `RequestedSourceKind` `Document`. The workers report the view origin and `isSecureContext` true. | The All/All filter covers dedicated workers and modules. |
| S19 | **With no handler, both downloads completed** (to `Profile.DefaultDownloadFolderPath`, redirected here) and the default download dialog opened. | Files `spike-blob.txt` (78 bytes) and `served.bin` (65 536 bytes). `DownloadStarting` gave `blob:https://spike-alpha-….example/<uuid>` (`text/plain`, no disposition, 78 bytes) and `https://…/file.bin` (`attachment; filename="served.bin"`, 65 536 bytes), both `Completed`. No frame identity in the args. | A view can save files unless the host handles `DownloadStarting`. The origin in `Uri` is the only link to the view. |
| S20 | **Yes.** Everything used compiles against 1.0.3179.45. Only nested-frame `CoreWebView2Frame.FrameCreated` needs a newer SDK. | `dotnet build`: 0 warnings, 0 errors, with `TreatWarningsAsErrors`. Against 1.0.3179.45, `-p:SpikeProbe=true` fails with CS1061 (`'CoreWebView2Frame' does not contain a definition for 'FrameCreated'`); against the cached 1.0.3719.77 it compiles. | 1.0.3179.45 is sufficient, because `FrameNavigationStarting` covers nested frames (S9b). |
| S21 | **Yes.** | `isSecureContext` true, `crypto.subtle` present (SHA-256 of `abc` starts `ba7816bf`), `crypto.randomUUID` present, origin `https://spike-alpha-72a5da4be2.example`. | Views get secure-context APIs without a certificate. |
| S22 | **Shown**, as an in-page dialog titled "An embedded page at &lt;view host&gt; says". **`ScriptDialogOpening` is not raised** while default dialogs are enabled, so it cannot observe them. | Enabled: 0 `ScriptDialogOpening`. CDP `Page.javascriptDialogOpening` (view URL, `hasBrowserHandler` true). No new window (the capture shows the dialog in the page). `alert` and `confirm` blocked the view until dismissed over CDP (3.8 s and 3.0 s). Disabled: `ScriptDialogOpening` fires with `Uri` = view URL. Without a deferral, `alert` returns in 3 ms, and `confirm` returns the host's answer (`Accept()` gives `true`). | To control view dialogs, turn default dialogs off and handle `ScriptDialogOpening`, or drop `allow-modals` (*inferred*). |

### S14 memory detail

Each row is the private working set in MiB, as the median of five samples taken 5 s after
every frame had loaded. The results come from two rounds of the same run. The view page is a
200-row table; the screen is 1200×700 with 400 rows. The Workbench-only baseline was 179 MiB
across all processes. That includes a 20 MiB Workbench renderer and one renderer with no
frame, which the first view takes over.

| Configuration | View renderers | View renderers, MiB (round 1 / 2) | All WebView2 processes, MiB (1 / 2) |
| --- | --- | --- | --- |
| 1 frame, one package | 1 | 27.6 / 21.7 | 184 / 214 |
| 5 frames, one package | 1 | 58.0 / 65.7 | 245 / 273 |
| 10 frames, one package | 1 | 100.5 / 110.4 | 323 / 332 |
| 20 frames, one package | 1 | 142.9 / 164.7 | 370 / 436 |
| 1 frame, 1 package | 1 | 24.8 / 24.9 | 195 / 218 |
| 5 frames, 5 packages | 5 | 108.6 / 118.5 | 301 / 335 |
| 10 frames, 10 packages | 10 | 261.0 / 256.4 | 484 / 487 |
| 6 panels from 3 packages + screen from one of them | 3 | 109.2 / 108.4 | 310 / 335 |
| 6 panels from 3 packages + screen from a 4th package | 4 | 125.7 / 117.0 | 335 / 334 |

A package's first frame costs about 25 MiB; each further frame in the same renderer costs
about 7–10 MiB. After their frames were removed, the view renderers exited 10.0–10.1 s later
in every row (S3).

## Decisions for the implementation

1. **Do not add `--site-per-process`.** The default already puts the Workbench and each
   package origin in separate renderers (S1). Guard that at runtime: after the first view
   loads, check with `GetProcessExtendedInfosAsync` that the view frame is outside the main
   frame's renderer, and refuse to show views if it is not (*inferred*).
2. **Ending a hung frame.** Nothing reports it: detect it in the Workbench with a heartbeat
   (S2, *inferred*). Then:
   1. Set `src = 'about:blank'` on **every** frame of that package, because they share the
      renderer (S1, S4). That ended a spinning renderer in 555 ms (S3).
   2. Remove the elements. Removal alone leaves the renderer alive for about 10 s.
   3. If the renderer is still alive after about a second, kill the PID from
      `AssociatedFrameInfos`. The kill raises `FrameRenderProcessExited` with the frame names:
      expect it, and do not report it as a crash.
3. **Moving frames.** `moveBefore` keeps a live view: same document, no reload (S12). The
   fallback when `Element.prototype.moveBefore` is missing is never to re-parent a live view
   frame. Keep it in one stable container and place, size and clip it with CSS over its
   placeholder: `appendChild` and `innerHTML` both reload the view.
4. **Memory budget for "6 panels from 3 packages plus one screen".** Assert, 5 s after the
   views load and as the median of five samples:
   - exactly **one view renderer per distinct package** (3 or 4);
   - view renderers' private working set **≤ 160 MiB** (measured 108–126);
   - all WebView2 processes **≤ 420 MiB** (measured 310–335).

   These figures hold for this spike's 200-row page only. Take a new baseline with the real
   packages before applying them to Gantt, Graph or Systems Lens (*inferred*).
5. **APIs that behave differently from the expectation in the brief.**
   - `ContextMenuTarget.IsRequestedForMainFrame` is `false` on the main frame too, so the
     rule "handled when `IsRequestedForMainFrame`" suppresses no menu. Use `FrameUri` (S13).
   - `ScriptDialogOpening` cannot observe dialogs while `AreDefaultScriptDialogsEnabled` is
     true, as its documentation says (S22).
   - `PermissionRequested.Uri` is the Workbench origin, not the view's, and the default
     `SavesInProfile` extends one grant to every view (S10).
   - `window.chrome.webview` exists inside view frames. It is harmless only while nobody
     subscribes `CoreWebView2Frame.WebMessageReceived` (S8).
   - `FrameInfosForFailedProcess` has names and sources but `FrameKind` `Unknown` and
     `FrameId` 0 (S4).
   - Nested-frame `CoreWebView2Frame.FrameCreated` needs SDK ≥ 1.0.3719.77 (S20). It is not
     needed: `CoreWebView2.FrameNavigationStarting` sees and cancels nested navigations (S9b).
   - The filter `https://*.example/*` also matched `https://example.org/?probe=a.example/`,
     which the host check refused. The handler must check the parsed host, not trust the
     filter (S11).
   - There is no Local/Private Network Access gate for views in runtime 153 (S11).
     `loading="lazy"` loads about 2.4k px early (S17). Downloads and scripted popups proceed
     unless the host acts (S15, S19).

## Limits

- The Workbench stand-in and the view page are synthetic. Input came from CDP
  `Input.dispatchMouseEvent`. The harness window had no OS focus in the main run, where S10
  used focus emulation; it had real focus in the 16:20 rerun.
- The S13 and S22 captures are `PrintWindow` images of the harness's own windows. They
  support the measurements; they are not the measurements.
- One machine, one runtime (153.0.4234.48), one display scale.
