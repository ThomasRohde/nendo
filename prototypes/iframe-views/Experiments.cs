using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;

namespace IframeViewsSpike;

/// <summary>S1-S22. Each writes its measurements into the evidence object it is given.</summary>
internal sealed partial class Harness
{
    private const string StorageReadScript = """
        (async () => ({
          local: localStorage.getItem('spike'),
          idb: await new Promise((resolve) => {
            const open = indexedDB.open('spike', 1);
            open.onupgradeneeded = () => open.result.createObjectStore('kv');
            open.onerror = () => resolve('open error');
            open.onsuccess = () => {
              const get = open.result.transaction('kv').objectStore('kv').get('token');
              get.onsuccess = () => { resolve(get.result ?? null); open.result.close(); };
              get.onerror = () => resolve('get error');
            };
          }),
        }))()
        """;

    private const string WebviewProbe = """
        (() => {
          const r = { chrome: typeof window.chrome, webview: typeof window.chrome?.webview, postMessage: typeof window.chrome?.webview?.postMessage };
          try { window.chrome.webview.postMessage({ from: window.name }); r.posted = 'called without error'; } catch (e) { r.posted = e.name + ': ' + e.message; }
          return r;
        })()
        """;

    private const string S5Script = """
        (async () => {
          const t0 = performance.now();
          const response = await fetch('/big.wasm?r=' + Math.random());
          const bytes = (await response.arrayBuffer()).byteLength;
          const t1 = performance.now();
          window.__s5 = 0;
          const nonce = Math.random();
          await Promise.all(Array.from({ length: 200 }, (_, i) => new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = '/s5/m' + i + '.js?r=' + nonce;
            s.onload = resolve;
            s.onerror = () => reject(new Error('script ' + i));
            document.head.append(s);
          })));
          const t2 = performance.now();
          return { wasmBytes: bytes, wasmMs: Math.round(t1 - t0), scriptsExecuted: window.__s5, scriptsMs: Math.round(t2 - t1) };
        })()
        """;

    private int? _hungPid;

    private async Task MainAsync()
    {
        await Step("S1", "Frames from two package origins: renderer processes", 60, S1);
        await Step("S16", "localStorage and IndexedDB in a view frame (write, before restart)", 30, S16Write);
        await Step("S21", "Secure context and crypto.subtle in a view frame", 30, S21);
        await Step("S8", "chrome.webview inside a view frame", 40, S8);
        await Step("S6", "No catch-all filter: the Workbench CSP blocks an outside fetch", 30, S6);
        await Step("S7", "frame-src allows the view origins and blocks others", 30, S7);
        await Step("S18", "Worker and module import from the view origin", 40, S18);
        await Step("S5", "Serving 5 MB and 200 scripts through a deferral", 120, S5);
        await Step("S17", "Lazy iframe below the fold in a nested scroller", 60, S17);
        await Step("S12", "Moving a live iframe: moveBefore, appendChild, innerHTML", 60, S12);
        await Step("S9", "Top navigation from a view frame", 30, S9);
        await Step("S9b", "Nested frame navigating to the Workbench origin", 40, S9b);
        await Step("S15", "NewWindowRequested from a view frame", 30, S15);
        await Step("S19", "Downloads from a view frame", 60, S19);
        await Step("S10", "Clipboard from a view frame after a real click", 60, S10);
        await Step("S11", "Loopback and public network from a view frame", 90, S11);
        await Step("S22", "alert and confirm in a view frame", 60, S22);
        await Step("S2", "A view frame spinning while(true)", 90, S2, reset: false);
        await Step("S3", "Ending a hung frame's renderer", 150, S3);
        await Step("S4", "Crashing a view frame's renderer", 40, S4);
        await Step("S14", "Renderer memory by frame count and package count", 600, S14);
        await Step("S13", "DevTools and the default context menu in a frame", 60, S13);
    }

    private async Task PersistReadAsync()
    {
        await Step("S16", "localStorage and IndexedDB after closing and restarting the harness (read)", 40, async ev =>
        {
            var tokenPath = Path.Combine(_o.OutDir, "s16-token" + Suffix + ".txt");
            var expected = File.Exists(tokenPath) ? (await File.ReadAllTextAsync(tokenPath)).Trim() : null;
            ev["expected"] = expected;
            await AddFrameAsync("persist-1", Origin("spike.persist"));
            var read = await EvalAsync(await FrameAsync("persist-1"), StorageReadScript);
            ev["read"] = read;
            await AddFrameAsync("persist-2", Origin("spike.other"));
            ev["otherOriginControl"] = await EvalAsync(await FrameAsync("persist-2"), StorageReadScript);
            var local = (string?)read?["local"];
            var idb = (string?)read?["idb"];
            ev["answer"] = $"localStorage survived: {expected is not null && local == expected}; IndexedDB survived: {expected is not null && idb == expected}";
        });
    }

    // S1: which renderer hosts the Workbench, two frames of package a and one of package b.
    private async Task S1(JsonObject ev)
    {
        await AddFrameAsync("a-1", Origin("spike.alpha"));
        await AddFrameAsync("a-2", Origin("spike.alpha"));
        await AddFrameAsync("b-1", Origin("spike.beta"));
        await Task.Delay(500);
        ev["origins"] = new JsonObject { ["a"] = Origin("spike.alpha"), ["b"] = Origin("spike.beta") };
        ev["processes"] = await ProcessesAsync();
        var targets = await C.SendAsync("Target.getTargets");
        var list = new JsonArray();
        foreach (var t in targets?["targetInfos"]?.AsArray() ?? new JsonArray())
        {
            if ((string?)t?["type"] is "page" or "iframe")
            {
                list.Add(new JsonObject { ["type"] = (string?)t!["type"], ["url"] = Trim((string?)t["url"], 100) });
            }
        }

        ev["cdpTargets"] = list;
        var workbench = await PidOfWorkbenchAsync();
        var a1 = await PidOfFrameAsync("a-1");
        var a2 = await PidOfFrameAsync("a-2");
        var b1 = await PidOfFrameAsync("b-1");
        ev["pids"] = new JsonObject { ["workbench"] = workbench, ["a-1"] = a1, ["a-2"] = a2, ["b-1"] = b1, ["browser"] = (long)Core.BrowserProcessId };
        var iframeTargets = list.Count(t => (string?)t?["type"] == "iframe");
        ev["answer"] = $"workbench {workbench}, a-1 {a1}, a-2 {a2}, b-1 {b1}; views apart from workbench: {a1 != workbench && b1 != workbench}; " +
            $"a and b apart: {a1 != b1}; a-1 and a-2 share: {a1 == a2}; CDP iframe targets: {iframeTargets}";
    }

    private async Task S16Write(JsonObject ev)
    {
        var token = Guid.NewGuid().ToString("N");
        var origin = Origin("spike.persist");
        await AddFrameAsync("persist-1", origin);
        var frame = await FrameAsync("persist-1");
        ev["origin"] = origin;
        ev["token"] = token;
        ev["write"] = await EvalAsync(frame, $$"""
            (async () => {
              localStorage.setItem('spike', {{Js(token)}});
              await new Promise((resolve, reject) => {
                const open = indexedDB.open('spike', 1);
                open.onupgradeneeded = () => open.result.createObjectStore('kv');
                open.onerror = () => reject(open.error);
                open.onsuccess = () => {
                  const tx = open.result.transaction('kv', 'readwrite');
                  tx.objectStore('kv').put({{Js(token)}}, 'token');
                  tx.oncomplete = () => { open.result.close(); resolve(); };
                  tx.onerror = () => reject(tx.error);
                };
              });
              let storageAccess;
              try { storageAccess = await document.hasStorageAccess(); } catch (e) { storageAccess = e.name; }
              return { local: localStorage.getItem('spike'), hasStorageAccess: storageAccess };
            })()
            """);
        await File.WriteAllTextAsync(Path.Combine(_o.OutDir, "s16-token" + Suffix + ".txt"), token);
        ev["answer"] = "written; the persist-read phase reads it back after a restart";
    }

    private async Task S21(JsonObject ev)
    {
        await AddFrameAsync("sc-1", Origin("spike.alpha"));
        var frame = await FrameAsync("sc-1");
        var result = await EvalAsync(frame, """
            (async () => {
              const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc')));
              return {
                origin: location.origin,
                isSecureContext,
                subtle: typeof crypto.subtle,
                sha256OfAbcPrefix: Array.from(bytes.slice(0, 4), b => b.toString(16).padStart(2, '0')).join(''),
                randomUUID: typeof crypto.randomUUID === 'function',
              };
            })()
            """);
        ev["frame"] = result;
        ev["workbench"] = await EvalAsync(_page, "({ origin: location.origin, isSecureContext })");
        ev["answer"] = $"isSecureContext {result?["isSecureContext"]}, crypto.subtle {result?["subtle"]}, SHA-256('abc') starts {result?["sha256OfAbcPrefix"]} (expected ba7816bf)";
    }

    private async Task S8(JsonObject ev)
    {
        _frameMessageHooks = false;
        await AddFrameAsync("wv-1", Origin("spike.alpha"));
        var mark = Mark();
        var noHook = await EvalAsync(await FrameAsync("wv-1"), WebviewProbe);
        await Task.Delay(1000);
        ev["frameWithoutFrameHook"] = new JsonObject { ["probe"] = noHook, ["hostEvents"] = Logged(mark, "WebMessageReceived", "Frame.WebMessageReceived") };

        _frameMessageHooks = true;
        await AddFrameAsync("wv-2", Origin("spike.beta"));
        mark = Mark();
        var withHook = await EvalAsync(await FrameAsync("wv-2"), WebviewProbe);
        await Task.Delay(1000);
        ev["frameWithFrameHook"] = new JsonObject { ["probe"] = withHook, ["hostEvents"] = Logged(mark, "WebMessageReceived", "Frame.WebMessageReceived") };

        mark = Mark();
        await EvalAsync(_page, "chrome.webview.postMessage({ from: 'workbench-control' }), true");
        await Task.Delay(500);
        ev["workbenchControl"] = Logged(mark, "WebMessageReceived");
        ev["answer"] = $"frame chrome.webview: {noHook?["webview"]} (no frame hook) / {withHook?["webview"]} (frame hook); " +
            $"top-level WebMessageReceived from frames: {CountKind(ev, "WebMessageReceived")}; CoreWebView2Frame.WebMessageReceived: {CountKind(ev, "Frame.WebMessageReceived")}";
    }

    private static int CountKind(JsonObject ev, string kind) =>
        new[] { "frameWithoutFrameHook", "frameWithFrameHook" }.Sum(k => ev[k]?["hostEvents"]?.AsArray().Count(e => (string?)e?["kind"] == kind) ?? 0);

    private async Task S6(JsonObject ev)
    {
        ev["filters"] = "AddWebResourceRequestedFilter(\"https://*.example/*\", All, All) only; no \"*\" filter";
        ev["workbenchLoaded"] = _meta?["workbenchLoaded"]?.DeepClone();
        ev["workbenchHref"] = await EvalAsync(_page, "location.href");
        var served = ServedCount();
        var mark = Mark();
        ev["fetchPublic"] = await EvalAsync(_page, "spike.fetchProbe('https://example.org/')");
        ev["fetchViewOrigin"] = await EvalAsync(_page, $"spike.fetchProbe({Js(Origin("spike.alpha") + "/data.json")})");
        ev["servedDuring"] = Json(ServedSince(served));
        ev["log"] = Logged(mark, "cdp:Log");
        ev["answer"] = $"workbench loaded {ev["workbenchLoaded"]}; example.org: {ev["fetchPublic"]?["outcome"]} " +
            $"[{ev["fetchPublic"]?["violations"]?.ToJsonString()}]; view origin: {ev["fetchViewOrigin"]?["outcome"]}";
    }

    private async Task S7(JsonObject ev)
    {
        var served = ServedCount();
        var mark = Mark();
        await EvalAsync(_page, "spike.addFrame({ name: 'other-1', src: 'https://other.test/index.html?n=other-1&v=1' })");
        await AddFrameAsync("allowed-1", Origin("spike.alpha"));
        await Task.Delay(1500);
        ev["violations"] = await EvalAsync(_page, "spike.violations");
        ev["otherFrame"] = await EvalAsync(_page, "(() => { const f = spike.frame('other-1'); let href; try { href = f.contentWindow.location.href; } catch (e) { href = 'not readable: ' + e.name; } return { loadEvents: spike.loads['other-1'], href }; })()");
        ev["allowedFrameHello"] = await EvalAsync(_page, "spike.hellos('allowed-1').length");
        ev["frameNavigationStarting"] = Logged(mark, "FrameNavigationStarting");
        ev["log"] = Logged(mark, "cdp:Log");
        ev["servedHosts"] = new JsonArray(ServedSince(served).Select(s => (JsonNode?)new Uri(s.Uri).Host).Distinct().ToArray());
        ev["answer"] = $"allowed frame hello: {ev["allowedFrameHello"]}; violations: {ev["violations"]?.ToJsonString()}";
    }

    private async Task S18(JsonObject ev)
    {
        await AddFrameAsync("wk-1", Origin("spike.alpha"));
        var frame = await FrameAsync("wk-1");
        var served = ServedCount();
        ev["classicWorker"] = await EvalAsync(frame, """
            new Promise((resolve) => {
              const w = new Worker('/w.js');
              const t = setTimeout(() => resolve({ error: 'timeout' }), 5000);
              w.onmessage = (e) => { clearTimeout(t); resolve(e.data); };
              w.onerror = (e) => { clearTimeout(t); resolve({ error: e.message || 'error event' }); };
              w.postMessage('go');
            })
            """);
        ev["moduleWorker"] = await EvalAsync(frame, """
            new Promise((resolve) => {
              const w = new Worker('/wm.js', { type: 'module' });
              const t = setTimeout(() => resolve({ error: 'timeout' }), 5000);
              w.onmessage = (e) => { clearTimeout(t); resolve(e.data); };
              w.onerror = (e) => { clearTimeout(t); resolve({ error: e.message || 'error event' }); };
            })
            """);
        ev["dynamicImport"] = await EvalAsync(frame, "import('/mod.js').then(m => ({ answer: m.answer() }), e => ({ error: String(e) }))");
        await Task.Delay(300);
        var list = ServedSince(served);
        ev["served"] = Json(list);
        ev["answer"] = "served through WebResourceRequested: " + string.Join(", ", list.Select(s => new Uri(s.Uri).AbsolutePath + " [" + s.Context + "/" + s.Kind + "]"));
    }

    private async Task S5(JsonObject ev)
    {
        await AddFrameAsync("perf-1", Origin("spike.perf"));
        var frame = await FrameAsync("perf-1");
        var runs = new JsonArray();
        for (var i = 0; i < 3; i++)
        {
            var served = ServedCount();
            var run = (JsonObject)(await EvalAsync(frame, S5Script, 90000))!;
            var list = ServedSince(served);
            var scripts = list.Where(s => s.Uri.Contains("/s5/", StringComparison.Ordinal)).Select(s => s.HandlerMs).Order().ToList();
            run["hostWasmHandlerMs"] = list.FirstOrDefault(s => s.Uri.Contains("/big.wasm", StringComparison.Ordinal))?.HandlerMs;
            run["hostScriptRequests"] = scripts.Count;
            run["hostScriptHandlerMedianMs"] = scripts.Count > 0 ? scripts[scripts.Count / 2] : null;
            run["hostScriptHandlerMaxMs"] = scripts.Count > 0 ? scripts[^1] : null;
            runs.Add(run);
        }

        ev["runs"] = runs;
        ev["answer"] = string.Join("; ", runs.Select(r => $"5 MB {r?["wasmMs"]} ms, 200 scripts {r?["scriptsMs"]} ms"));
    }

    private async Task S17(JsonObject ev)
    {
        var origin = Origin("spike.lazy");
        var host = new Uri(origin).Host;
        var served = ServedCount();
        await AddFrameAsync("lazy-1", origin, parent: "scroll-end", lazy: true, wait: false);
        ev["layoutAtStart"] = await EvalAsync(_page, "spike.lazyGeometry('lazy-1')");
        await Task.Delay(3000);
        var early = ServedSince(served).Count(s => s.Uri.Contains(host, StringComparison.Ordinal));
        ev["requestsWhileFarBelow"] = early;
        JsonNode? at = null;
        for (var i = 0; i < 40 && at is null; i++)
        {
            var state = await EvalAsync(_page, "(() => { document.getElementById('scroller').scrollTop += 250; return spike.lazyGeometry('lazy-1'); })()");
            await Task.Delay(300);
            if (ServedSince(served).Any(s => s.Uri.Contains(host, StringComparison.Ordinal)))
            {
                at = state;
            }
        }

        ev["firstRequestAfterScrollingTo"] = at;
        ev["hello"] = await TryWaitTrueAsync(_page, "spike.hellos('lazy-1').length >= 1", 5000);
        ev["answer"] = $"requests while 6000 px below: {early}; first request when the frame's top was {at?["distanceBelowVisibleBottom"]} px below the scroller's visible bottom (250 px steps)";
    }

    private async Task S12(JsonObject ev)
    {
        ev["moveBeforeType"] = await EvalAsync(_page, "typeof Element.prototype.moveBefore");
        await AddFrameAsync("mv-1", Origin("spike.alpha"), parent: "left");
        var origin = await TimeOriginAsync("mv-1");
        ev["initialTimeOrigin"] = origin;
        ev["pidBefore"] = await PidOfFrameAsync("mv-1");
        ev["moveBefore"] = await MoveAsync("mv-1", "document.getElementById('right').moveBefore(spike.frame('mv-1'), null)", origin);
        ev["appendChild"] = await MoveAsync("mv-1", "document.getElementById('left').appendChild(spike.frame('mv-1'))", await TimeOriginAsync("mv-1"));
        ev["innerHTML"] = await MoveAsync("mv-1", "(() => { const l = document.getElementById('left'); l.innerHTML = l.innerHTML; })()", await TimeOriginAsync("mv-1"));
        ev["pidAfter"] = await PidOfFrameAsync("mv-1");
        ev["answer"] = $"moveBefore kept: {ev["moveBefore"]?["kept"]}; appendChild kept: {ev["appendChild"]?["kept"]}; innerHTML kept: {ev["innerHTML"]?["kept"]}";
    }

    private async Task<JsonObject> MoveAsync(string name, string action, double? timeOriginBefore)
    {
        var hellos = (await EvalAsync(_page, $"spike.hellos({Js(name)}).length"))!.GetValue<int>();
        var loads = await EvalAsync(_page, $"spike.loads[{Js(name)}] ?? 0");
        string? error = null;
        try
        {
            await EvalAsync(_page, action + ", true");
        }
        catch (InvalidOperationException ex)
        {
            error = ex.Message;
        }

        await Task.Delay(2000);
        var after = await TimeOriginAsync(name);
        var newHellos = (await EvalAsync(_page, $"spike.hellos({Js(name)}).length"))!.GetValue<int>() - hellos;
        return new JsonObject
        {
            ["error"] = error,
            ["parent"] = await EvalAsync(_page, $"spike.frame({Js(name)})?.parentElement?.id ?? null"),
            ["newHelloMessages"] = newHellos,
            ["loadEventsBefore"] = loads,
            ["loadEventsAfter"] = await EvalAsync(_page, $"spike.loads[{Js(name)}] ?? 0"),
            ["timeOriginBefore"] = timeOriginBefore,
            ["timeOriginAfter"] = after,
            ["kept"] = error is null && newHellos == 0 && after is not null && after == timeOriginBefore,
        };
    }

    private async Task<double?> TimeOriginAsync(string name)
    {
        var before = (await EvalAsync(_page, $"spike.pongs({Js(name)}).length"))!.GetValue<int>();
        await EvalAsync(_page, $"spike.ping({Js(name)})");
        if (!await TryWaitTrueAsync(_page, $"spike.pongs({Js(name)}).length > {before}", 3000))
        {
            return null;
        }

        return (await EvalAsync(_page, $"spike.pongs({Js(name)}).at(-1).timeOrigin"))?.GetValue<double>();
    }

    private async Task S9(JsonObject ev)
    {
        await AddFrameAsync("top-1", Origin("spike.alpha"));
        var frame = await FrameAsync("top-1");
        var mark = Mark();
        ev["scripted"] = await EvalAsync(frame, "(() => { try { top.location = 'https://example.org/?scripted'; return 'no exception'; } catch (e) { return e.name + ': ' + e.message; } })()");
        await Task.Delay(1500);
        ev["scriptedEvents"] = Logged(mark, "NavigationStarting", "FrameNavigationStarting", "Frame.NavigationStarting", "cdp:Log");
        ev["topAfterScripted"] = await EvalAsync(_page, "location.href");

        await EvalAsync(frame, "view.onAct = () => { try { top.location = 'https://example.org/?clicked'; return 'no exception'; } catch (e) { return e.name + ': ' + e.message; } }, true");
        mark = Mark();
        await ClickInFrameAsync("top-1", "#act");
        await Task.Delay(1500);
        ev["clicked"] = await EvalAsync(frame, "({ clicks: view.clicks, results: view.results, activation: navigator.userActivation.hasBeenActive })");
        ev["clickedEvents"] = Logged(mark, "NavigationStarting", "FrameNavigationStarting", "Frame.NavigationStarting", "cdp:Log");
        ev["topAfterClicked"] = await EvalAsync(_page, "location.href");
        ev["answer"] = $"scripted: {ev["scripted"]}; clicked: {ev["clicked"]?["results"]?.ToJsonString()}; " +
            $"top-level NavigationStarting fired: {Logged(0, "NavigationStarting").Any(e => ((string?)e?["uri"] ?? "").Contains("example.org", StringComparison.Ordinal))}";
    }

    private static string NestScript(string name) => $$"""
        (() => {
          const n = document.createElement('iframe');
          n.name = {{Js(name)}};
          n.src = 'https://app.nendo.local/index.html?nested=' + {{Js(name)}};
          n.style.cssText = 'position:absolute;left:220px;top:120px;width:130px;height:70px';
          document.body.append(n);
          return true;
        })()
        """;

    private static string NestedStateScript(string name) => $$"""
        (() => {
          const n = document.querySelector('iframe[name=' + JSON.stringify({{Js(name)}}) + ']');
          let href;
          try { href = n.contentWindow.location.href; } catch (e) { href = 'not readable from the view: ' + e.name; }
          return { href, childFrames: window.frames.length };
        })()
        """;

    private async Task S9b(JsonObject ev)
    {
        await AddFrameAsync("nest-1", Origin("spike.alpha"));
        var view = await FrameAsync("nest-1");

        _cancelFrameNavigation = uri => uri.StartsWith("https://" + AppHost + "/", StringComparison.Ordinal);
        var mark = Mark();
        await EvalAsync(view, NestScript("nested-armed"));
        await Task.Delay(2500);
        ev["cancelInFrameNavigationStarting"] = new JsonObject
        {
            ["events"] = Logged(mark, "FrameNavigationStarting", "Frame.NavigationStarting", "NavigationStarting", "FrameCreated"),
            ["fromView"] = await EvalAsync(view, NestedStateScript("nested-armed")),
            ["appOriginNestedFramesSeenFromWorkbench"] = await EvalAsync(_page, "spike.nestedAppFrames()"),
        };

        _cancelFrameNavigation = null;
        mark = Mark();
        await EvalAsync(view, NestScript("nested-open"));
        await Task.Delay(3000);
        var control = new JsonObject
        {
            ["events"] = Logged(mark, "FrameNavigationStarting", "Frame.NavigationStarting", "NavigationStarting", "FrameCreated"),
            ["fromView"] = await EvalAsync(view, NestedStateScript("nested-open")),
            ["appOriginNestedFramesSeenFromWorkbench"] = await EvalAsync(_page, "spike.nestedAppFrames()"),
        };
        var messages = Mark();
        control["postFromNestedAppFrame"] = await EvalAsync(_page, "spike.postFromNestedApp()");
        await Task.Delay(800);
        control["hostMessagesFromNestedAppFrame"] = Logged(messages, "WebMessageReceived", "Frame.WebMessageReceived");
        ev["notCancelledControl"] = control;
        var armed = ev["cancelInFrameNavigationStarting"]!["events"]!.AsArray();
        ev["answer"] = $"FrameNavigationStarting for the nested app URL: {armed.Count(e => (string?)e?["kind"] == "FrameNavigationStarting" && ((string?)e["uri"] ?? "").Contains(AppHost, StringComparison.Ordinal))}, " +
            $"cancelled: {armed.Any(e => e?["cancelled"]?.GetValue<bool>() == true)}; view frame's own NavigationStarting saw it: {armed.Any(e => (string?)e?["kind"] == "Frame.NavigationStarting" && ((string?)e["uri"] ?? "").Contains(AppHost, StringComparison.Ordinal))}";
    }

    private async Task S15(JsonObject ev)
    {
        await AddFrameAsync("nw-1", Origin("spike.alpha"));
        var frame = await FrameAsync("nw-1");
        var mark = Mark();
        await ClickInFrameAsync("nw-1", "#newwin");
        await Task.Delay(1500);
        ev["linkTargetBlankClick"] = Logged(mark, "NewWindowRequested");

        mark = Mark();
        ev["scriptedReturnValue"] = await EvalAsync(frame, "(() => { const w = window.open('/popup.html?from=script', '_blank'); return w === null ? 'null' : 'a window'; })()");
        await Task.Delay(1500);
        ev["windowOpenWithoutActivation"] = Logged(mark, "NewWindowRequested");

        await EvalAsync(frame, "view.onAct = () => { const w = window.open('/popup.html?from=clicked-script', '_blank'); return w === null ? 'null' : 'a window'; }, true");
        mark = Mark();
        await ClickInFrameAsync("nw-1", "#act");
        await Task.Delay(1500);
        ev["windowOpenAfterClick"] = Logged(mark, "NewWindowRequested");
        ev["windowOpenAfterClickReturn"] = await EvalAsync(frame, "view.results");
        string Summary(string key) => string.Join(", ", ev[key]!.AsArray().Select(e => $"userInitiated={e?["userInitiated"]} uri={e?["uri"]}"));
        ev["answer"] = $"link click: [{Summary("linkTargetBlankClick")}]; window.open no activation: [{Summary("windowOpenWithoutActivation")}]; window.open after click: [{Summary("windowOpenAfterClick")}]";
    }

    private async Task S19(JsonObject ev)
    {
        foreach (var file in Directory.GetFiles(DownloadsDir))
        {
            File.Delete(file);
        }

        await AddFrameAsync("dl-1", Origin("spike.alpha"));
        var mark = Mark();
        await ClickInFrameAsync("dl-1", "#dlblob");
        await Task.Delay(700);
        await ClickInFrameAsync("dl-1", "#dlfile");
        var files = await WaitFilesAsync(["spike-blob.txt", "served.bin"], 8000);
        var dialogOpen = Core.IsDefaultDownloadDialogOpen;
        ev["noHandler"] = new JsonObject
        {
            ["filesInDownloadFolder"] = files,
            ["defaultDownloadDialogOpen"] = dialogOpen,
            ["events"] = Logged(mark, "PermissionRequested", "Frame.PermissionRequested", "NewWindowRequested", "cdp:Log"),
        };
        if (dialogOpen)
        {
            Core.CloseDefaultDownloadDialog();
        }

        var records = new JsonArray();
        void Starting(object? sender, CoreWebView2DownloadStartingEventArgs e)
        {
            var operation = e.DownloadOperation;
            var record = new JsonObject
            {
                ["t"] = Now(),
                ["uri"] = Trim(operation.Uri, 160),
                ["mimeType"] = operation.MimeType,
                ["contentDisposition"] = operation.ContentDisposition,
                ["totalBytesToReceive"] = operation.TotalBytesToReceive,
                ["proposedFile"] = Path.GetFileName(e.ResultFilePath),
            };
            records.Add(record);
            e.ResultFilePath = Path.Combine(DownloadsDir, "handled-" + Path.GetFileName(e.ResultFilePath));
            e.Handled = true;
            operation.StateChanged += (_, _) =>
            {
                record["state"] = operation.State.ToString();
                record["interruptReason"] = operation.InterruptReason.ToString();
                record["bytesReceived"] = operation.BytesReceived;
            };
        }

        Core.DownloadStarting += Starting;
        try
        {
            await ClickInFrameAsync("dl-1", "#dlblob");
            await Task.Delay(700);
            await ClickInFrameAsync("dl-1", "#dlfile");
            var handled = await WaitFilesAsync(["handled-spike-blob.txt", "handled-served.bin"], 8000);
            await Task.Delay(700);
            ev["withHandler"] = new JsonObject
            {
                ["downloadStarting"] = records.DeepClone(),
                ["filesInDownloadFolder"] = handled,
                ["defaultDownloadDialogOpen"] = Core.IsDefaultDownloadDialogOpen,
            };
        }
        finally
        {
            Core.DownloadStarting -= Starting;
        }

        ev["answer"] = $"no handler: {files.ToJsonString()}; DownloadStarting: {records.Count} event(s)";
    }

    private async Task<JsonArray> WaitFilesAsync(string[] names, int timeoutMs)
    {
        var watch = Stopwatch.StartNew();
        while (watch.ElapsedMilliseconds < timeoutMs && !names.All(n => File.Exists(Path.Combine(DownloadsDir, n))))
        {
            await Task.Delay(100);
        }

        return new JsonArray(Directory.GetFiles(DownloadsDir)
            .Select(f => (JsonNode?)$"{Path.GetFileName(f)} ({new FileInfo(f).Length} bytes)").ToArray());
    }

    private static string ClipboardScript(string token) => $$"""
        async () => {
          const query = async (name) => { try { return (await navigator.permissions.query({ name })).state; } catch (e) { return e.name; } };
          const r = { hasFocus: document.hasFocus(), activation: navigator.userActivation.isActive, readPermissionBefore: await query('clipboard-read'), writePermission: await query('clipboard-write') };
          try { await navigator.clipboard.writeText({{Js(token)}}); r.write = 'resolved'; } catch (e) { r.write = e.name + ': ' + e.message; }
          await new Promise((resolve) => setTimeout(resolve, 150));
          try {
            const t = await navigator.clipboard.readText();
            r.read = t === {{Js(token)}} ? 'the token' : 'other text (' + t.length + ' chars)';
          } catch (e) { r.read = e.name + ': ' + e.message; }
          r.readPermissionAfter = await query('clipboard-read');
          return r;
        }
        """;

    private static string Token() => "nendo-spike-" + Guid.NewGuid().ToString("N")[..8];

    // What the OS clipboard holds, compared with the token only; other content is never recorded.
    private static string OsClipboard(string token)
    {
        try
        {
            if (!Clipboard.ContainsText())
            {
                return "no text";
            }

            var text = Clipboard.GetText();
            return text == token ? "the token" : $"other text ({text.Length} chars)";
        }
        catch (ExternalException ex)
        {
            return "unreadable: " + ex.Message;
        }
    }

    private async Task S10(JsonObject ev)
    {
        var saved = SaveClipboard();
        ev["ownerClipboardBefore"] = saved.Describe;
        _savesInProfile = false;
        try
        {
            try
            {
                await C.SendAsync("Emulation.setFocusEmulationEnabled", new JsonObject { ["enabled"] = true }, _page);
                ev["focusEmulation"] = "Emulation.setFocusEmulationEnabled on the page target";
            }
            catch (InvalidOperationException ex)
            {
                ev["focusEmulation"] = ex.Message;
            }

            ev["harnessWindowIsForeground"] = Native.IsForeground(Handle);
            _permissionPolicy = CoreWebView2PermissionState.Allow;
            ev["workbenchDocument"] = await WorkbenchClipboardTrialAsync();
            _permissionPolicy = CoreWebView2PermissionState.Deny;
            ev["frameDeny"] = await ClipboardTrialAsync("clip-1", "spike.clip1");
            _permissionPolicy = CoreWebView2PermissionState.Allow;
            ev["frameAllow"] = await ClipboardTrialAsync("clip-2", "spike.clip2");
            await AddFrameAsync("clip-3", Origin("spike.clip3"));
            var mark = Mark();
            var token = Token();
            ev["frameAllowWithoutActivation"] = new JsonObject
            {
                ["result"] = await EvalAsync(await FrameAsync("clip-3"), "(" + ClipboardScript(token) + ")()"),
                ["osClipboard"] = OsClipboard(token),
                ["events"] = Logged(mark, "PermissionRequested", "Frame.PermissionRequested"),
            };

            // The default SavesInProfile: an Allow for one view, then a Deny policy for a second view origin.
            _savesInProfile = true;
            _permissionPolicy = CoreWebView2PermissionState.Allow;
            ev["savedAllowFirstView"] = await ClipboardTrialAsync("clip-5", "spike.clip5");
            _permissionPolicy = CoreWebView2PermissionState.Deny;
            ev["savedAllowSecondViewUnderDenyPolicy"] = await ClipboardTrialAsync("clip-6", "spike.clip6");
            _savesInProfile = false;

            // With real OS focus, if Windows lets this process take the foreground.
            _permissionPolicy = CoreWebView2PermissionState.Allow;
            Activate();
            _web.Focus();
            await Task.Delay(500);
            var foreground = Native.IsForeground(Handle);
            ev["foregroundTaken"] = foreground;
            if (foreground)
            {
                ev["workbenchDocumentForeground"] = await WorkbenchClipboardTrialAsync();
                ev["frameAllowForeground"] = await ClipboardTrialAsync("clip-4", "spike.clip4");
            }
        }
        finally
        {
            _savesInProfile = true;
            try
            {
                await C.SendAsync("Emulation.setFocusEmulationEnabled", new JsonObject { ["enabled"] = false }, _page);
            }
            catch (InvalidOperationException)
            {
            }

            ev["ownerClipboardAfter"] = RestoreClipboard(saved);
        }

        string Line(string key) => ev[key] is null ? "not run" :
            $"write {ev[key]?["result"]?["write"]}, read {ev[key]?["result"]?["read"]}, OS clipboard {ev[key]?["osClipboard"]}, permission events {ev[key]?["events"]?.AsArray().Count}";
        ev["answer"] = $"workbench: {Line("workbenchDocument")} | frame deny: {Line("frameDeny")} | frame allow: {Line("frameAllow")} | " +
            $"no activation: {Line("frameAllowWithoutActivation")} | saved Allow, second view under Deny: {Line("savedAllowSecondViewUnderDenyPolicy")} | " +
            $"foreground taken {ev["foregroundTaken"]}: {Line("frameAllowForeground")}";
    }

    private async Task<JsonObject> WorkbenchClipboardTrialAsync()
    {
        var token = Token();
        await EvalAsync(_page, "spike.clickResults.length = 0, spike.onClick = " + ClipboardScript(token) + ", true");
        var mark = Mark();
        var (x, y) = await PointInPageAsync("#wb-button");
        await ClickAsync(x, y);
        var completed = await TryWaitTrueAsync(_page, "spike.clickResults.length > 0", 8000);
        var result = new JsonObject
        {
            ["policy"] = _permissionPolicy.ToString(),
            ["completed"] = completed,
            ["result"] = await EvalAsync(_page, "spike.clickResults[0] ?? null"),
            ["osClipboard"] = OsClipboard(token),
            ["events"] = Logged(mark, "PermissionRequested", "Frame.PermissionRequested"),
        };
        await EvalAsync(_page, "spike.onClick = null, true");
        return result;
    }

    private async Task<JsonObject> ClipboardTrialAsync(string name, string package)
    {
        await AddFrameAsync(name, Origin(package));
        var frame = await FrameAsync(name);
        var token = Token();
        await EvalAsync(frame, "view.onAct = " + ClipboardScript(token) + ", true");
        var mark = Mark();
        await ClickInFrameAsync(name, "#act");
        var completed = await TryWaitTrueAsync(frame, "view.results.length > 0", 8000);
        return new JsonObject
        {
            ["policy"] = _permissionPolicy.ToString(),
            ["completed"] = completed,
            ["result"] = await EvalAsync(frame, "view.results[0] ?? null"),
            ["osClipboard"] = OsClipboard(token),
            ["events"] = Logged(mark, "PermissionRequested", "Frame.PermissionRequested"),
        };
    }

    private sealed record ClipboardSnapshot(string? Text, Image? Picture, System.Collections.Specialized.StringCollection? Files)
    {
        public string Describe => Text is not null ? "text" : Picture is not null ? "image" : Files is not null ? "file list" : "empty or another format";
    }

    private static ClipboardSnapshot SaveClipboard()
    {
        try
        {
            if (Clipboard.ContainsText())
            {
                return new ClipboardSnapshot(Clipboard.GetText(), null, null);
            }

            if (Clipboard.ContainsImage())
            {
                return new ClipboardSnapshot(null, Clipboard.GetImage(), null);
            }

            if (Clipboard.ContainsFileDropList())
            {
                return new ClipboardSnapshot(null, null, Clipboard.GetFileDropList());
            }
        }
        catch (ExternalException)
        {
        }

        return new ClipboardSnapshot(null, null, null);
    }

    private static string RestoreClipboard(ClipboardSnapshot saved)
    {
        try
        {
            if (saved.Text is not null)
            {
                Clipboard.SetText(saved.Text);
            }
            else if (saved.Picture is not null)
            {
                Clipboard.SetImage(saved.Picture);
            }
            else if (saved.Files is not null)
            {
                Clipboard.SetFileDropList(saved.Files);
            }
            else
            {
                return "nothing restorable was saved";
            }

            return "restored (" + saved.Describe + ")";
        }
        catch (ExternalException ex)
        {
            return "restore failed: " + ex.Message;
        }
    }

    private static string FetchScript(string url) => $$"""
        (async () => {
          const t0 = performance.now();
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10000);
          try {
            const r = await fetch({{Js(url)}}, { signal: controller.signal, cache: 'no-store' });
            return { ok: true, status: r.status, body: (await r.text()).slice(0, 20), ms: Math.round(performance.now() - t0) };
          } catch (e) {
            return { ok: false, error: e.name + ': ' + e.message, ms: Math.round(performance.now() - t0) };
          } finally { clearTimeout(timer); }
        })()
        """;

    private static string SocketScript(string url) => $$"""
        new Promise((resolve) => {
          const t0 = performance.now();
          let ws;
          try { ws = new WebSocket({{Js(url)}}); } catch (e) { resolve({ error: 'constructor ' + e.name + ': ' + e.message }); return; }
          const timer = setTimeout(() => resolve({ error: 'timeout', readyState: ws.readyState }), 10000);
          ws.onmessage = (m) => { clearTimeout(timer); resolve({ open: true, message: String(m.data), ms: Math.round(performance.now() - t0) }); ws.close(); };
          ws.onerror = () => { clearTimeout(timer); resolve({ error: 'error event', readyState: ws.readyState, ms: Math.round(performance.now() - t0) }); };
        })
        """;

    private async Task S11(JsonObject ev)
    {
        using var canary = new Canary(Now);
        ev["canaryPort"] = canary.Port;
        var trials = new[] { (CoreWebView2PermissionState.Deny, "net-1", "spike.net1"), (CoreWebView2PermissionState.Allow, "net-2", "spike.net2") };
        foreach (var (policy, name, package) in trials)
        {
            _permissionPolicy = policy;
            await AddFrameAsync(name, Origin(package));
            var frame = await FrameAsync(name);
            var mark = Mark();
            var hits = canary.Count;
            var fetched = await EvalAsync(frame, FetchScript($"http://127.0.0.1:{canary.Port}/fetch?{name}"), 20000);
            var socket = await EvalAsync(frame, SocketScript($"ws://127.0.0.1:{canary.Port}/ws?{name}"), 20000);
            await Task.Delay(300);
            ev["permission" + policy] = new JsonObject
            {
                ["fetch"] = fetched,
                ["webSocket"] = socket,
                ["canaryReceived"] = canary.Since(hits),
                ["events"] = Logged(mark, "PermissionRequested", "Frame.PermissionRequested", "cdp:Log"),
            };
        }

        // The host's own lever: a CSP response header on the view document, set in WebResourceRequested.
        _permissionPolicy = CoreWebView2PermissionState.Deny;
        await AddFrameAsync("net-3", Origin("spike.net3"), "&csp=connect-self");
        var cspFrame = await FrameAsync("net-3");
        var cspMark = Mark();
        var cspHits = canary.Count;
        var cspResult = new JsonObject
        {
            ["header"] = "Content-Security-Policy: connect-src 'self'",
            ["fetch"] = await EvalAsync(cspFrame, FetchScript($"http://127.0.0.1:{canary.Port}/fetch?net-3"), 20000),
            ["webSocket"] = await EvalAsync(cspFrame, SocketScript($"ws://127.0.0.1:{canary.Port}/ws?net-3"), 20000),
            ["sameOriginFetch"] = await EvalAsync(cspFrame, "fetch('/data.json', { cache: 'no-store' }).then(r => 'status ' + r.status, e => e.name + ': ' + e.message)"),
        };
        await Task.Delay(300);
        cspResult["canaryReceived"] = canary.Since(cspHits);
        cspResult["log"] = Logged(cspMark, "cdp:Log");
        ev["viewDocumentWithCspHeader"] = cspResult;

        var public1 = await FrameAsync("net-2");
        var served = ServedCount();
        ev["publicNoCors"] = await EvalAsync(public1, "fetch('https://example.org/', { mode: 'no-cors', cache: 'no-store' }).then(r => ({ type: r.type, status: r.status }), e => ({ error: e.name + ': ' + e.message }))", 20000);
        ev["publicCors"] = await EvalAsync(public1, "fetch('https://example.org/', { cache: 'no-store' }).then(r => ({ status: r.status }), e => ({ error: e.name + ': ' + e.message }))", 20000);
        ev["filterWildcardInQuery"] = await EvalAsync(public1, "fetch('https://example.org/?probe=a.example/', { mode: 'no-cors', cache: 'no-store' }).then(r => ({ type: r.type, status: r.status }), e => ({ error: e.name + ': ' + e.message }))", 20000);
        ev["servedDuringPublic"] = Json(ServedSince(served));
        ev["answer"] = $"deny: fetch {ev["permissionDeny"]?["fetch"]?["ok"]} ws {ev["permissionDeny"]?["webSocket"]?["open"]} canary {ev["permissionDeny"]?["canaryReceived"]?.AsArray().Count}; " +
            $"allow: fetch {ev["permissionAllow"]?["fetch"]?["ok"]} ws {ev["permissionAllow"]?["webSocket"]?["open"]} canary {ev["permissionAllow"]?["canaryReceived"]?.AsArray().Count}; " +
            $"CSP header: fetch {cspResult["fetch"]?["ok"]} ws {cspResult["webSocket"]?["open"]} canary {cspResult["canaryReceived"]?.AsArray().Count}; public no-cors {ev["publicNoCors"]?.ToJsonString()}";
    }

    private async Task S22(JsonObject ev)
    {
        ev["defaultDialogsEnabled"] = await DialogTrialAsync("dlg-1", "spike.alpha");
        Core.Settings.AreDefaultScriptDialogsEnabled = false;
        try
        {
            await ReloadWorkbenchAsync();
            ev["defaultDialogsDisabled"] = await DialogTrialAsync("dlg-2", "spike.beta");
        }
        finally
        {
            Core.Settings.AreDefaultScriptDialogsEnabled = true;
            await ReloadWorkbenchAsync();
        }

        ev["answer"] = $"enabled: alert ScriptDialogOpening {ev["defaultDialogsEnabled"]?["alert"]?["scriptDialogOpening"]?.AsArray().Count}, " +
            $"CDP dialog {ev["defaultDialogsEnabled"]?["alert"]?["cdpDialogOpening"]?.AsArray().Count}, new windows {ev["defaultDialogsEnabled"]?["alert"]?["newWindows"]?.AsArray().Count}; " +
            $"disabled: alert ScriptDialogOpening {ev["defaultDialogsDisabled"]?["alert"]?["scriptDialogOpening"]?.AsArray().Count}, confirm returned {ev["defaultDialogsDisabled"]?["confirm"]?["returnedBeforeDismiss"]?.ToJsonString()}";
    }

    private async Task<JsonObject> DialogTrialAsync(string name, string package)
    {
        var result = new JsonObject { ["areDefaultScriptDialogsEnabled"] = Core.Settings.AreDefaultScriptDialogsEnabled };
        await AddFrameAsync(name, Origin(package));
        var frame = await FrameAsync(name);
        foreach (var session in new[] { _page, frame })
        {
            try
            {
                await C.SendAsync("Page.enable", null, session, 3000);
            }
            catch (Exception ex) when (ex is InvalidOperationException or TimeoutException)
            {
                result["pageEnableError"] = ex.Message;
            }
        }

        foreach (var kind in new[] { "alert", "confirm" })
        {
            var before = await WindowsAsync();
            var mark = Mark();
            await EvalAsync(frame, $"window.__dialog = 'pending'; setTimeout(() => {{ const t0 = performance.now(); const value = {kind}('spike {kind} from ' + location.host); window.__dialog = {{ value, blockedMs: Math.round(performance.now() - t0) }}; }}, 0); true");
            await Task.Delay(1500);
            var windows = NewWindows(before, await WindowsAsync());
            string? capture = null;
            if (Core.Settings.AreDefaultScriptDialogsEnabled && kind == "alert")
            {
                // The harness window only (PrintWindow), while the frame is inside alert().
                capture = Native.Capture(Handle, Path.Combine(_o.OutDir, "s22-default-alert.png")) ? "s22-default-alert.png" : "PrintWindow failed";
            }
            var cdp = Logged(mark, "cdp:Page.javascriptDialogOpening");
            var trial = new JsonObject
            {
                ["scriptDialogOpening"] = Logged(mark, "ScriptDialogOpening"),
                ["cdpDialogOpening"] = cdp,
                ["newWindows"] = Describe(windows),
                ["capture"] = capture,
                ["returnedBeforeDismiss"] = await TryEvalAsync(frame, "window.__dialog", 1500),
            };
            if (trial["returnedBeforeDismiss"] is JsonValue pending && pending.TryGetValue<string>(out var text) && (text == "pending" || text.StartsWith("no answer", StringComparison.Ordinal)))
            {
                foreach (var e in cdp)
                {
                    var session = (string?)e?["session"];
                    try
                    {
                        await C.SendAsync("Page.handleJavaScriptDialog", new JsonObject { ["accept"] = true }, session, 3000);
                        trial["dismissedWith"] = "Page.handleJavaScriptDialog on the " + (session == _page ? "page" : "frame") + " session";
                        break;
                    }
                    catch (Exception ex) when (ex is InvalidOperationException or TimeoutException)
                    {
                        trial["dismissError"] = ex.Message;
                    }
                }

                if (trial["dismissedWith"] is null)
                {
                    foreach (var w in windows)
                    {
                        Native.Post(w.Handle, Native.WmClose);
                    }

                    trial["dismissedWith"] = "WM_CLOSE to the new windows";
                }

                trial["returnedAfterDismiss"] = await TryEvalAsync(frame, "window.__dialog", 3000);
            }

            result[kind] = trial;
        }

        return result;
    }

    private async Task<JsonNode?> TryEvalAsync(string target, string expression, int timeoutMs)
    {
        try
        {
            return await EvalAsync(target, expression, timeoutMs) ?? "undefined";
        }
        catch (Exception ex) when (ex is InvalidOperationException or TimeoutException)
        {
            return "no answer: " + ex.Message;
        }
    }

    private static async Task SwallowAsync(Task task)
    {
        try
        {
            await task;
        }
        catch (Exception ex) when (ex is InvalidOperationException or TimeoutException)
        {
        }
    }

    private async Task<JsonObject> ResponsivenessAsync()
    {
        var latencies = new List<double>();
        for (var i = 0; i < 20; i++)
        {
            var watch = Stopwatch.StartNew();
            await EvalAsync(_page, "performance.now()", 5000);
            latencies.Add(Math.Round(watch.Elapsed.TotalMilliseconds, 2));
        }

        latencies.Sort();
        var clicks = (await EvalAsync(_page, "spike.clicks"))!.GetValue<int>();
        var (x, y) = await PointInPageAsync("#wb-button");
        var clickWatch = Stopwatch.StartNew();
        await ClickAsync(x, y);
        var clickMs = Math.Round(clickWatch.Elapsed.TotalMilliseconds, 1);
        var registered = await TryWaitTrueAsync(_page, $"spike.clicks === {clicks + 1}", 2000);
        return new JsonObject
        {
            ["evalMsMin"] = latencies[0],
            ["evalMsMedian"] = latencies[latencies.Count / 2],
            ["evalMsMax"] = latencies[^1],
            ["buttonClickDispatchMs"] = clickMs,
            ["buttonClickRegistered"] = registered,
            ["animationFramesPerSecond"] = await EvalAsync(_page, "spike.rafRate(1000)"),
        };
    }

    private async Task S2(JsonObject ev)
    {
        await AddFrameAsync("hang-1", Origin("spike.hang1"));
        var frame = await FrameAsync("hang-1");
        var hung = await PidOfFrameAsync("hang-1");
        var workbench = await PidOfWorkbenchAsync();
        _hungPid = hung;
        ev["pids"] = new JsonObject { ["spinningFrame"] = hung, ["workbench"] = workbench };
        ev["before"] = await ResponsivenessAsync();
        var mark = Mark();
        await EvalAsync(frame, "setTimeout(() => { for (;;) {} }, 50), 'armed'");
        await Task.Delay(500);
        ev["frameEvalWhileSpinning"] = await TryEvalAsync(frame, "'frame answered'", 2000);
        ev["during"] = await ResponsivenessAsync();

        // Input into the spinning frame is what starts the browser's hang timer for that renderer.
        var rect = await EvalAsync(_page, "spike.rect('hang-1')");
        var x = rect!["x"]!.GetValue<double>() + 60;
        var y = rect["y"]!.GetValue<double>() + 100;
        ev["inputIntoSpinningFrameAtMs"] = Now();
        var pressed = Mouse("mousePressed", x, y, "left", 1, 60000);
        var released = Mouse("mouseReleased", x, y, "left", 0, 60000);
        _ = SwallowAsync(pressed);
        _ = SwallowAsync(released);
        var watch = Stopwatch.StartNew();
        while (watch.ElapsedMilliseconds < 35000 && Logged(mark, "ProcessFailed").Count == 0)
        {
            await Task.Delay(250);
        }

        await Task.Delay(1000);
        ev["processFailed"] = Logged(mark, "ProcessFailed");
        ev["waitedMs"] = watch.ElapsedMilliseconds;

        // A dispatch that is still pending means the input was routed to the spinning renderer and never acknowledged.
        ev["inputDispatchStatus"] = $"mousePressed {pressed.Status}, mouseReleased {released.Status}";
        ev["afterInput"] = await ResponsivenessAsync();
        ev["spinningRendererAlive"] = hung is int pid && Native.IsAlive(pid);
        ev["answer"] = $"ProcessFailed events within 35 s of input: {ev["processFailed"]!.AsArray().Count} " +
            $"({string.Join(", ", ev["processFailed"]!.AsArray().Select(e => (string?)e?["failedKind"]))}); " +
            $"eval median before/during/after {ev["before"]?["evalMsMedian"]}/{ev["during"]?["evalMsMedian"]}/{ev["afterInput"]?["evalMsMedian"]} ms; " +
            $"button click registered during: {ev["during"]?["buttonClickRegistered"]}";
    }

    private async Task S3(JsonObject ev)
    {
        var mark = Mark();
        if (_hungPid is int first)
        {
            await EvalAsync(_page, "spike.remove('hang-1')");
            var removed = await WaitExitAsync(first, 15000);
            removed["how"] = "remove";
            removed["spinning"] = true;
            removed["receivedInputWhileSpinning"] = true;
            ev["spinningWithInputRemove"] = removed;
        }
        else
        {
            ev["spinningWithInputRemove"] = "no spinning frame was left by S2";
        }

        ev["spinningRemove"] = await EndFrameAsync("hang-b", "spike.hang2", spin: true, how: "remove");
        ev["spinningAboutBlank"] = await EndFrameAsync("hang-c", "spike.hang3", spin: true, how: "about:blank");
        ev["spinningKill"] = await EndFrameAsync("hang-d", "spike.hang4", spin: true, how: "kill");
        ev["idleRemove"] = await EndFrameAsync("idle-e", "spike.idle1", spin: false, how: "remove");
        ev["idleAboutBlank"] = await EndFrameAsync("idle-f", "spike.idle2", spin: false, how: "about:blank");
        ev["processFailed"] = Logged(mark, "ProcessFailed");
        ev["workbenchAfter"] = await ResponsivenessAsync();
        _hungPid = null;
        string Line(string key) => ev[key] is JsonObject o ? $"{key}: exited {o["exited"]} after {o["ms"]} ms" : $"{key}: {ev[key]}";
        ev["answer"] = string.Join("; ", new[] { "spinningWithInputRemove", "spinningRemove", "spinningAboutBlank", "spinningKill", "idleRemove", "idleAboutBlank" }.Select(Line)) +
            $"; ProcessFailed events: {ev["processFailed"]!.AsArray().Count}";
    }

    private async Task<JsonNode> EndFrameAsync(string name, string package, bool spin, string how)
    {
        await AddFrameAsync(name, Origin(package));
        var frame = await FrameAsync(name);
        if (await PidOfFrameAsync(name) is not int pid)
        {
            return "no renderer pid for " + name;
        }

        if (spin)
        {
            await EvalAsync(frame, "setTimeout(() => { for (;;) {} }, 50), 'armed'");
            await Task.Delay(500);
        }

        var mark = Mark();
        switch (how)
        {
            case "remove":
                await EvalAsync(_page, $"spike.remove({Js(name)})");
                break;
            case "about:blank":
                await EvalAsync(_page, $"spike.frame({Js(name)}).src = 'about:blank', true");
                break;
            default:
                {
                    using var process = Process.GetProcessById(pid);
                    process.Kill();
                    break;
                }
        }

        var exit = await WaitExitAsync(pid, 15000);
        await Task.Delay(300);
        exit["how"] = how;
        exit["spinning"] = spin;
        exit["processFailed"] = Logged(mark, "ProcessFailed");
        return exit;
    }

    private async Task S4(JsonObject ev)
    {
        await AddFrameAsync("nendo-view-1", Origin("spike.crash"));
        await AddFrameAsync("nendo-view-2", Origin("spike.crash"));
        var frame = await FrameAsync("nendo-view-1");
        var pid = await PidOfFrameAsync("nendo-view-1");
        ev["pid"] = pid;
        ev["pidOfSecondFrameSamePackage"] = await PidOfFrameAsync("nendo-view-2");
        var mark = Mark();
        _ = SwallowAsync(C.SendAsync("Page.crash", null, frame, 5000));
        var watch = Stopwatch.StartNew();
        while (watch.ElapsedMilliseconds < 8000 && Logged(mark, "ProcessFailed").Count == 0)
        {
            await Task.Delay(50);
        }

        ev["processFailedAfterMs"] = watch.ElapsedMilliseconds;
        await Task.Delay(500);
        ev["processFailed"] = Logged(mark, "ProcessFailed");
        ev["pidExit"] = pid is int p ? await WaitExitAsync(p, 3000) : "no pid";
        ev["cdpTargetEvents"] = Logged(mark, "cdp:Target.targetCrashed", "cdp:Target.targetDestroyed");
        ev["workbench"] = await ResponsivenessAsync();
        ev["frameElementsStillPresent"] = await EvalAsync(_page, "[spike.frame('nendo-view-1') !== null, spike.frame('nendo-view-2') !== null]");
        var hellos = (await EvalAsync(_page, "spike.hellos('nendo-view-1').length"))!.GetValue<int>();
        await EvalAsync(_page, "(() => { const f = spike.frame('nendo-view-1'); f.src = f.src; return true; })()");
        ev["reloadedBySettingSrc"] = await TryWaitTrueAsync(_page, $"spike.hellos('nendo-view-1').length > {hellos}", 8000);
        ev["pidAfterReload"] = await PidOfFrameAsync("nendo-view-1");
        var failed = ev["processFailed"]!.AsArray();
        ev["answer"] = $"ProcessFailed: {string.Join(", ", failed.Select(e => $"{e?["failedKind"]} frames=[{string.Join(", ", e?["frames"]?.AsArray().Select(f => (string?)f?["name"]) ?? [])}]"))}; " +
            $"workbench click registered: {ev["workbench"]?["buttonClickRegistered"]}; reload by src: {ev["reloadedBySettingSrc"]}";
    }

    private async Task S14(JsonObject ev)
    {
        await ReloadWorkbenchAsync();
        await Task.Delay(5000);
        var baseline = await MemoryAsync();
        ev["baselineWorkbenchOnly"] = baseline;
        var rows = new JsonArray();
        ev["rows"] = rows;

        async Task MeasureAsync(int round, string label, List<(string Name, string Package, int Width, int Height, int Rows)> frames)
        {
            var watch = Stopwatch.StartNew();
            foreach (var f in frames)
            {
                await AddFrameAsync(f.Name, Origin(f.Package), $"&rows={f.Rows}", width: f.Width, height: f.Height, wait: false);
            }

            var loaded = await TryWaitTrueAsync(_page, string.Join(" && ", frames.Select(f => $"spike.hellos({Js(f.Name)}).length >= 1")), 30000);
            var loadMs = watch.ElapsedMilliseconds;
            await Task.Delay(5000);
            var m = await MemoryAsync();
            m["round"] = round;
            m["label"] = label;
            m["frames"] = frames.Count;
            m["packages"] = frames.Select(f => f.Package).Distinct().Count();
            m["allLoaded"] = loaded;
            m["loadMs"] = loadMs;
            m["deltaAllRenderersMiB"] = Math.Round(m["rendererPrivateWsMiB"]!.GetValue<double>() - baseline["rendererPrivateWsMiB"]!.GetValue<double>(), 1);
            m["deltaAllProcessesMiB"] = Math.Round(m["allPrivateWsMiB"]!.GetValue<double>() - baseline["allPrivateWsMiB"]!.GetValue<double>(), 1);
            var viewPids = new List<int>();
            foreach (var p in await Env.GetProcessExtendedInfosAsync())
            {
                if (p.AssociatedFrameInfos.Any(f => (f.Source ?? "").Contains(".example/", StringComparison.Ordinal)))
                {
                    viewPids.Add(p.ProcessInfo.ProcessId);
                }
            }

            rows.Add(m);
            Log($"S14 r{round} {label}: view renderers {m["viewRenderers"]} = {m["viewRendererPrivateWsMiB"]} MiB, workbench renderer {m["workbenchRendererPrivateWsMiB"]} MiB, all processes {m["allPrivateWsMiB"]} MiB");
            await EvalAsync(_page, "spike.clear()");
            var cleanup = Stopwatch.StartNew();
            while (cleanup.ElapsedMilliseconds < 15000 && viewPids.Any(Native.IsAlive))
            {
                await Task.Delay(100);
            }

            m["viewRenderersExitedAfterRemovalMs"] = viewPids.Any(Native.IsAlive) ? null : cleanup.ElapsedMilliseconds;
            Save();
        }

        for (var round = 1; round <= 2; round++)
        {
            foreach (var n in new[] { 1, 5, 10, 20 })
            {
                await MeasureAsync(round, $"{n} frame(s), one package", Enumerable.Range(0, n).Select(i => ($"mem{round}-s{n}-{i}", "spike.mem.same", 240, 160, 200)).ToList());
            }

            foreach (var n in new[] { 1, 5, 10 })
            {
                await MeasureAsync(round, $"{n} frame(s), {n} package(s)", Enumerable.Range(0, n).Select(i => ($"mem{round}-d{n}-{i}", $"spike.mem.d{i}", 240, 160, 200)).ToList());
            }

            var panels = Enumerable.Range(0, 6).Select(i => ($"panel{round}-{i}", $"spike.pkg{(i % 3) + 1}", 400, 260, 200)).ToList();
            await MeasureAsync(round, "6 panels from 3 packages + 1 screen from one of them", [.. panels, ($"screen{round}-a", "spike.pkg1", 1200, 700, 400)]);
            await MeasureAsync(round, "6 panels from 3 packages + 1 screen from a 4th package", [.. panels, ($"screen{round}-b", "spike.pkg4", 1200, 700, 400)]);
        }

        ev["answer"] = string.Join("; ", rows.Select(r => $"r{r?["round"]} {r?["label"]}: {r?["viewRenderers"]} view renderer(s) {r?["viewRendererPrivateWsMiB"]} MiB"));
    }

    private async Task<JsonObject> MemoryAsync()
    {
        var samples = new List<JsonObject>();
        for (var i = 0; i < 5; i++)
        {
            if (i > 0)
            {
                await Task.Delay(400);
            }

            double renderers = 0, views = 0, workbench = 0, all = 0;
            int count = 0, spare = 0, viewCount = 0;
            var detail = new JsonArray();
            foreach (var p in await Env.GetProcessExtendedInfosAsync())
            {
                if (Native.Memory(p.ProcessInfo.ProcessId) is not { } m)
                {
                    continue;
                }

                var mib = m.PrivateWorkingSet / 1048576.0;
                all += mib;
                var frames = p.AssociatedFrameInfos;
                if (p.ProcessInfo.Kind == CoreWebView2ProcessKind.Renderer)
                {
                    renderers += mib;
                    count++;
                    if (frames.Count == 0)
                    {
                        spare++;
                    }

                    if (frames.Any(f => f.FrameKind == CoreWebView2FrameKind.MainFrame))
                    {
                        workbench += mib;
                    }

                    if (frames.Any(f => (f.Source ?? "").Contains(".example/", StringComparison.Ordinal)))
                    {
                        views += mib;
                        viewCount++;
                    }
                }

                detail.Add(new JsonObject
                {
                    ["pid"] = p.ProcessInfo.ProcessId,
                    ["kind"] = p.ProcessInfo.Kind.ToString(),
                    ["frames"] = frames.Count,
                    ["privateWsMiB"] = Math.Round(mib, 1),
                    ["commitMiB"] = Math.Round(m.PrivateBytes / 1048576.0, 1),
                });
            }

            samples.Add(new JsonObject
            {
                ["renderers"] = count,
                ["rendererWithoutFrames"] = spare,
                ["viewRenderers"] = viewCount,
                ["viewRendererPrivateWsMiB"] = Math.Round(views, 1),
                ["workbenchRendererPrivateWsMiB"] = Math.Round(workbench, 1),
                ["rendererPrivateWsMiB"] = Math.Round(renderers, 1),
                ["allPrivateWsMiB"] = Math.Round(all, 1),
                ["processes"] = detail,
            });
        }

        // The median of five samples, by total renderer memory.
        return samples.OrderBy(s => s["rendererPrivateWsMiB"]!.GetValue<double>()).ElementAt(2);
    }

    private async Task S13(JsonObject ev)
    {
        ev["areDevToolsEnabled"] = Core.Settings.AreDevToolsEnabled;
        ev["areDefaultContextMenusEnabled"] = Core.Settings.AreDefaultContextMenusEnabled;
        var before = await WindowsAsync();
        Core.OpenDevToolsWindow();
        JsonObject? devtools = null;
        for (var i = 0; i < 30 && devtools is null; i++)
        {
            await Task.Delay(200);
            var targets = await C.SendAsync("Target.getTargets");
            foreach (var t in targets?["targetInfos"]?.AsArray() ?? new JsonArray())
            {
                if (((string?)t?["url"] ?? "").StartsWith("devtools://", StringComparison.Ordinal))
                {
                    devtools = new JsonObject { ["type"] = (string?)t!["type"], ["url"] = Trim((string?)t["url"], 90), ["targetId"] = (string?)t["targetId"] };
                }
            }
        }

        ev["devtoolsTarget"] = devtools;
        ev["devtoolsNewWindows"] = Describe(NewWindows(before, await WindowsAsync()));
        if ((string?)devtools?["targetId"] is { } devtoolsTarget)
        {
            try
            {
                await C.SendAsync("Target.closeTarget", new JsonObject { ["targetId"] = devtoolsTarget }, null, 3000);
            }
            catch (Exception ex) when (ex is InvalidOperationException or TimeoutException)
            {
                ev["devtoolsCloseError"] = ex.Message;
            }
        }

        await Task.Delay(600);
        ev["devtoolsWindowsLeftOpen"] = await CloseNewWindowsAsync(before);

        await AddFrameAsync("cm-1", Origin("spike.alpha"));
        var frame = await FrameAsync("cm-1");
        foreach (var handleAll in new[] { false, true })
        {
            _contextMenuHandleAll = handleAll;
            var tag = handleAll ? "all" : "main";
            var pass = new JsonObject
            {
                ["workbench"] = await RightClickAsync(await PointInPageAsync("#wb-title"), $"s13-{tag}-workbench.png"),
                ["viewFrame"] = await RightClickAsync(await PointInFrameAsync("cm-1", "#blank"), $"s13-{tag}-frame.png"),
                ["frameContextmenuDomEventsSoFar"] = await TryEvalAsync(frame, "view.contextmenus", 2000),
            };
            ev[handleAll ? "handlerHandlesEveryEvent" : "handlerHandlesMainFrameOnly"] = pass;
        }

        _contextMenuHandleAll = false;
        string Line(string pass, string where)
        {
            var o = ev[pass]![where]!;
            var events = o["events"]!.AsArray();
            return $"{where}: {events.Count} event(s) (isRequestedForMainFrame {events.FirstOrDefault()?["isRequestedForMainFrame"]?.ToJsonString() ?? "-"}), {o["newWindows"]!.AsArray().Count} menu window(s)";
        }

        ev["answer"] = $"DevTools target opened: {devtools is not null}; handle main frame only: {Line("handlerHandlesMainFrameOnly", "workbench")}, {Line("handlerHandlesMainFrameOnly", "viewFrame")}; " +
            $"handle every event: {Line("handlerHandlesEveryEvent", "workbench")}, {Line("handlerHandlesEveryEvent", "viewFrame")}";
    }

    private async Task<JsonObject> RightClickAsync((double X, double Y) point, string capture)
    {
        var before = await WindowsAsync();
        var mark = Mark();
        await ClickAsync(point.X, point.Y, "right");
        await Task.Delay(1200);
        var opened = NewWindows(before, await WindowsAsync());
        var result = new JsonObject { ["events"] = Logged(mark, "ContextMenuRequested"), ["newWindows"] = Describe(opened) };
        if (opened.Count > 0)
        {
            var file = Path.Combine(_o.OutDir, capture);
            result["capture"] = Native.Capture(opened[0].Handle, file) ? capture : "PrintWindow failed";
        }

        result["leftOpenAfterClosing"] = await CloseNewWindowsAsync(before);
        return result;
    }

    private async Task<JsonArray> CloseNewWindowsAsync(List<Native.WindowInfo> before)
    {
        foreach (var w in NewWindows(before, await WindowsAsync()))
        {
            Native.Post(w.Handle, Native.WmKeyDown, Native.VkEscape);
            Native.Post(w.Handle, Native.WmKeyUp, Native.VkEscape);
        }

        await Task.Delay(500);
        foreach (var w in NewWindows(before, await WindowsAsync()))
        {
            Native.Post(w.Handle, Native.WmClose);
        }

        await Task.Delay(500);
        return Describe(NewWindows(before, await WindowsAsync()));
    }
}
