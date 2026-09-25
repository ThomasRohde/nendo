using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace IframeViewsSpike;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        Options options;
        try
        {
            options = Options.Parse(args);
        }
        catch (ArgumentException ex)
        {
            Console.Error.WriteLine(ex.Message);
            Console.Error.WriteLine("usage: IframeViewsSpike --out <dir> [--phase main|persist-read] [--site-per-process] [--only S1,S2]");
            return 2;
        }

        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using var harness = new Harness(options);
        Application.Run(harness);
        return harness.ExitCode;
    }
}

internal sealed record Options(string Phase, string OutDir, bool SitePerProcess, HashSet<string> Only)
{
    public static Options Parse(string[] args)
    {
        var phase = "main";
        var outDir = "";
        var sitePerProcess = false;
        var only = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--phase" when i + 1 < args.Length:
                    phase = args[++i];
                    break;
                case "--out" when i + 1 < args.Length:
                    outDir = args[++i];
                    break;
                case "--site-per-process":
                    sitePerProcess = true;
                    break;
                case "--only" when i + 1 < args.Length:
                    foreach (var step in args[++i].Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
                    {
                        only.Add(step);
                    }

                    break;
                default:
                    throw new ArgumentException("Unknown or incomplete argument: " + args[i]);
            }
        }

        if (outDir.Length == 0)
        {
            throw new ArgumentException("--out <dir> is required.");
        }

        if (phase is not ("main" or "persist-read"))
        {
            throw new ArgumentException("--phase must be main or persist-read.");
        }

        return new Options(phase, Path.GetFullPath(outDir), sitePerProcess, only);
    }

    public bool Runs(string step) => Only.Count == 0 || Only.Contains(step);
}

internal sealed record Served(double T, string Uri, string Context, string Kind, double HandlerMs, long Bytes, string? Note)
{
    public JsonObject ToJson() => new()
    {
        ["t"] = T,
        ["uri"] = Uri.Length > 140 ? Uri[..140] : Uri,
        ["context"] = Context,
        ["sourceKind"] = Kind,
        ["handlerMs"] = HandlerMs,
        ["bytes"] = Bytes,
        ["note"] = Note,
    };
}

/// <summary>
/// One visible WinForms window with one WebView2. The page at https://app.nendo.local/ stands in
/// for the Workbench; each view package is its own https://{slug}-{key}.example origin served
/// through WebResourceRequested with a deferral. Every experiment writes JSON evidence.
/// </summary>
internal sealed partial class Harness : Form
{
    private const string AppHost = "app.nendo.local";
    private const string AppUrl = "https://app.nendo.local/index.html";
    private static readonly JsonSerializerOptions Pretty = new() { WriteIndented = true, Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping };

    private readonly Options _o;
    private readonly WebView2 _web = new() { Dock = DockStyle.Fill };
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private readonly List<JsonObject> _events = [];
    private readonly List<Served> _served = [];
    private readonly JsonObject _steps = new();
    private readonly Dictionary<string, string> _sessions = [];
    private readonly Dictionary<string, int> _contexts = [];
    private readonly string _appDir = Path.Combine(AppContext.BaseDirectory, "app");
    private readonly string _viewDir = Path.Combine(AppContext.BaseDirectory, "view");
    private readonly object _saveLock = new();
    private readonly object _logLock = new();
    private JsonObject? _meta;
    private CoreWebView2Environment? _env;
    private CoreWebView2? _core;
    private Cdp? _cdp;
    private StreamWriter? _log;
    private System.Threading.Timer? _watchdog;
    private string _page = "";
    private byte[]? _big;
    private CoreWebView2PermissionState _permissionPolicy = CoreWebView2PermissionState.Deny;
    private Func<string, bool>? _cancelFrameNavigation;
    private bool _frameMessageHooks = true;
    private bool _savesInProfile = true;
    private bool _contextMenuHandleAll;

    public Harness(Options options)
    {
        _o = options;
        Text = "Iframe views spike (" + options.Phase + (options.SitePerProcess ? ", site-per-process" : "") + ")";
        StartPosition = FormStartPosition.Manual;
        Location = new Point(40, 40);
        ClientSize = new Size(1400, 950);
        Controls.Add(_web);
        Shown += async (_, _) => await RunAsync();
    }

    public int ExitCode { get; private set; } = 1;

    protected override bool ShowWithoutActivation => true;

    private CoreWebView2Environment Env => _env ?? throw new InvalidOperationException("No environment.");

    private CoreWebView2 Core => _core ?? throw new InvalidOperationException("No CoreWebView2.");

    private Cdp C => _cdp ?? throw new InvalidOperationException("No CDP connection.");

    private string Suffix => _o.SitePerProcess ? "-spp" : "";

    private string ResultsPath => Path.Combine(_o.OutDir, $"results-{_o.Phase}{Suffix}.json");

    private string DownloadsDir => Path.Combine(_o.OutDir, "downloads" + Suffix);

    private async Task RunAsync()
    {
        try
        {
            Directory.CreateDirectory(_o.OutDir);
            _log = new StreamWriter(Path.Combine(_o.OutDir, $"run-{_o.Phase}{Suffix}.log"), false, new UTF8Encoding(false)) { AutoFlush = true };
            _watchdog = new System.Threading.Timer(_ => Watchdog(), null, TimeSpan.FromMinutes(15), Timeout.InfiniteTimeSpan);
            var profile = Path.Combine(_o.OutDir, "profile" + Suffix);
            if (_o.Phase == "main" && Directory.Exists(profile))
            {
                Directory.Delete(profile, recursive: true);
            }

            var port = FreePort();
            var arguments = $"--remote-debugging-port={port}" + (_o.SitePerProcess ? " --site-per-process" : "");
            _env = await CoreWebView2Environment.CreateAsync(null, profile, new CoreWebView2EnvironmentOptions { AdditionalBrowserArguments = arguments });
            await _web.EnsureCoreWebView2Async(_env);
            _core = _web.CoreWebView2;
            Configure();
            _meta = Meta(arguments, port);
            Log("meta " + _meta.ToJsonString());
            _meta["workbenchLoaded"] = await NavigateAsync(AppUrl);
            _cdp = await Cdp.ConnectAsync(port, OnCdpEvent);
            await C.SendAsync("Target.setDiscoverTargets", new JsonObject { ["discover"] = true });
            _page = await AttachPageAsync();
            await C.SendAsync("Runtime.enable", null, _page);
            await C.SendAsync("Log.enable", null, _page);
            await WaitTrueAsync(_page, "typeof spike === 'object'", 10000);
            if (_o.Phase == "persist-read")
            {
                await PersistReadAsync();
            }
            else
            {
                await MainAsync();
            }

            ExitCode = 0;
        }
        catch (Exception ex)
        {
            _meta ??= new JsonObject();
            _meta["fatal"] = ex.ToString();
            Log("FATAL " + ex);
        }
        finally
        {
            Save();
            await ShutdownAsync();
            Save();
            _watchdog?.Dispose();
            Close();
        }
    }

    private void Configure()
    {
        var core = Core;
        var settings = core.Settings;
        settings.AreDefaultContextMenusEnabled = true;
        settings.AreDefaultScriptDialogsEnabled = true;
        settings.AreDevToolsEnabled = true;
        settings.AreHostObjectsAllowed = false;
        settings.IsStatusBarEnabled = false;
        settings.IsWebMessageEnabled = true;
        settings.IsZoomControlEnabled = false;
        Directory.CreateDirectory(DownloadsDir);
        core.Profile.DefaultDownloadFolderPath = DownloadsDir;
        core.SetVirtualHostNameToFolderMapping(AppHost, _appDir, CoreWebView2HostResourceAccessKind.DenyCors);

        // Only the view origins are intercepted. There is deliberately no catch-all "*" filter (S6).
        core.AddWebResourceRequestedFilter("https://*.example/*", CoreWebView2WebResourceContext.All, CoreWebView2WebResourceRequestSourceKinds.All);
        core.WebResourceRequested += OnWebResourceRequested;
        core.NavigationStarting += (_, e) =>
        {
            var allowed = e.Uri.StartsWith("https://" + AppHost + "/", StringComparison.Ordinal);
            Ev("NavigationStarting", new JsonObject { ["uri"] = e.Uri, ["userInitiated"] = e.IsUserInitiated, ["cancelled"] = !allowed });
            if (!allowed)
            {
                e.Cancel = true;
            }
        };
        core.FrameNavigationStarting += (_, e) =>
        {
            var cancel = _cancelFrameNavigation?.Invoke(e.Uri) == true;
            Ev("FrameNavigationStarting", new JsonObject { ["uri"] = Trim(e.Uri, 160), ["userInitiated"] = e.IsUserInitiated, ["cancelled"] = cancel });
            if (cancel)
            {
                e.Cancel = true;
            }
        };
        core.FrameCreated += OnFrameCreated;
        core.ProcessFailed += OnProcessFailed;
        core.WebMessageReceived += (_, e) =>
            Ev("WebMessageReceived", new JsonObject { ["source"] = e.Source, ["json"] = Trim(e.WebMessageAsJson, 200) });
        core.PermissionRequested += (_, e) =>
        {
            Ev("PermissionRequested", new JsonObject
            {
                ["permission"] = $"{e.PermissionKind} ({(int)e.PermissionKind})",
                ["uri"] = e.Uri,
                ["userInitiated"] = e.IsUserInitiated,
                ["savesInProfileDefault"] = e.SavesInProfile,
                ["decided"] = _permissionPolicy.ToString(),
                ["savesInProfileSet"] = _savesInProfile,
            });
            e.SavesInProfile = _savesInProfile;
            e.State = _permissionPolicy;
        };
        core.NewWindowRequested += (_, e) =>
        {
            Ev("NewWindowRequested", new JsonObject
            {
                ["uri"] = e.Uri,
                ["userInitiated"] = e.IsUserInitiated,
                ["name"] = e.Name,
                ["sourceFrameName"] = e.OriginalSourceFrameInfo?.Name,
                ["sourceFrameSource"] = Trim(e.OriginalSourceFrameInfo?.Source, 120),
            });
            e.Handled = true;
        };
        core.ContextMenuRequested += (_, e) =>
        {
            var target = e.ContextMenuTarget;
            Ev("ContextMenuRequested", new JsonObject
            {
                ["isRequestedForMainFrame"] = target.IsRequestedForMainFrame,
                ["frameUri"] = Trim(target.FrameUri, 120),
                ["pageUri"] = Trim(target.PageUri, 120),
                ["targetKind"] = target.Kind.ToString(),
                ["menuItems"] = e.MenuItems.Count,
                ["labels"] = string.Join(" | ", e.MenuItems.Take(12).Select(i => i.Name)),
                ["handledByHost"] = target.IsRequestedForMainFrame || _contextMenuHandleAll,
            });

            // The rule under test: suppress the menu for the main frame only. S13 also runs a handle-all pass.
            if (target.IsRequestedForMainFrame || _contextMenuHandleAll)
            {
                e.Handled = true;
            }
        };
        core.ScriptDialogOpening += (_, e) =>
        {
            Ev("ScriptDialogOpening", new JsonObject { ["dialogKind"] = e.Kind.ToString(), ["uri"] = Trim(e.Uri, 120), ["message"] = e.Message });
            if (e.Kind == CoreWebView2ScriptDialogKind.Confirm)
            {
                e.Accept();
            }
        };
        Env.BrowserProcessExited += (_, e) =>
            Ev("BrowserProcessExited", new JsonObject { ["exitKind"] = e.BrowserProcessExitKind.ToString(), ["pid"] = (long)e.BrowserProcessId });
    }

    private void OnFrameCreated(object? sender, CoreWebView2FrameCreatedEventArgs e)
    {
        var frame = e.Frame;
        var name = frame.Name;
        Ev("FrameCreated", new JsonObject { ["frame"] = name, ["frameId"] = (long)frame.FrameId, ["messageHook"] = _frameMessageHooks });
        frame.NavigationStarting += (_, a) =>
        {
            var cancel = _cancelFrameNavigation?.Invoke(a.Uri) == true;
            Ev("Frame.NavigationStarting", new JsonObject { ["frame"] = name, ["uri"] = Trim(a.Uri, 160), ["cancelled"] = cancel });
            if (cancel)
            {
                a.Cancel = true;
            }
        };
        frame.PermissionRequested += (_, a) => Ev("Frame.PermissionRequested", new JsonObject
        {
            ["frame"] = name,
            ["permission"] = $"{a.PermissionKind} ({(int)a.PermissionKind})",
            ["uri"] = a.Uri,
            ["userInitiated"] = a.IsUserInitiated,
        });
        frame.Destroyed += (_, _) => Ev("Frame.Destroyed", new JsonObject { ["frame"] = name });
        if (_frameMessageHooks)
        {
            frame.WebMessageReceived += (_, a) =>
                Ev("Frame.WebMessageReceived", new JsonObject { ["frame"] = name, ["source"] = a.Source, ["json"] = Trim(a.WebMessageAsJson, 200) });
        }
#if PROBE_NESTED_FRAMECREATED
        frame.FrameCreated += (_, _) => { };
#endif
    }

    private void OnProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs e)
    {
        var frames = new JsonArray();
        foreach (var f in e.FrameInfosForFailedProcess ?? [])
        {
            frames.Add(FrameInfo(f));
        }

        Ev("ProcessFailed", new JsonObject
        {
            ["failedKind"] = e.ProcessFailedKind.ToString(),
            ["reason"] = e.Reason.ToString(),
            ["exitCode"] = e.ExitCode,
            ["description"] = e.ProcessDescription,
            ["frames"] = frames,
        });
    }

    private void OnCdpEvent(string method, JsonNode? p, string? session)
    {
        switch (method)
        {
            case "Target.targetCreated":
            case "Target.targetDestroyed":
            case "Target.targetCrashed":
                var info = p?["targetInfo"];
                Ev("cdp:" + method, new JsonObject
                {
                    ["targetId"] = (string?)(info?["targetId"] ?? p?["targetId"]),
                    ["type"] = (string?)info?["type"],
                    ["url"] = Trim((string?)info?["url"], 120),
                    ["status"] = (string?)p?["status"],
                });
                break;
            case "Page.javascriptDialogOpening":
                Ev("cdp:Page.javascriptDialogOpening", new JsonObject
                {
                    ["session"] = session,
                    ["url"] = Trim((string?)p?["url"], 120),
                    ["type"] = (string?)p?["type"],
                    ["message"] = (string?)p?["message"],
                    ["hasBrowserHandler"] = p?["hasBrowserHandler"]?.DeepClone(),
                });
                break;
            case "Log.entryAdded":
                var entry = p?["entry"];
                Ev("cdp:Log", new JsonObject
                {
                    ["session"] = session == _page ? "page" : session,
                    ["level"] = (string?)entry?["level"],
                    ["source"] = (string?)entry?["source"],
                    ["text"] = Trim((string?)entry?["text"], 300),
                    ["url"] = Trim((string?)entry?["url"], 120),
                });
                break;
            case "Target.detachedFromTarget":
                lock (_sessions)
                {
                    foreach (var stale in _sessions.Where(s => s.Value == (string?)p?["sessionId"]).Select(s => s.Key).ToList())
                    {
                        _sessions.Remove(stale);
                    }
                }

                break;
            case "Runtime.executionContextCreated":
                var context = p?["context"];
                if ((string?)context?["auxData"]?["frameId"] is { } frameId && context?["auxData"]?["isDefault"]?.GetValue<bool>() == true)
                {
                    lock (_contexts)
                    {
                        _contexts[(session ?? "") + "|" + frameId] = context["id"]!.GetValue<int>();
                    }
                }

                break;
        }
    }

    private void OnWebResourceRequested(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        var started = _clock.Elapsed;
        var uri = e.Request.Uri;
        var context = e.ResourceContext.ToString();
        var kind = e.RequestedSourceKind.ToString();
        if (!Uri.TryCreate(uri, UriKind.Absolute, out var parsed) || !parsed.Host.EndsWith(".example", StringComparison.OrdinalIgnoreCase))
        {
            // The wildcard filter also matches ".example/" anywhere in a URL; only real view hosts are served.
            lock (_served)
            {
                _served.Add(new Served(Now(), uri, context, kind, 0, -1, "refused: host is not a view origin"));
            }

            e.Response = Env.CreateWebResourceResponse(new MemoryStream(), 403, "Forbidden", "Content-Type: text/plain");
            return;
        }

        var deferral = e.GetDeferral();
        _ = ServeAsync(e, deferral, parsed, started, context, kind);
    }

    private async Task ServeAsync(CoreWebView2WebResourceRequestedEventArgs e, CoreWebView2Deferral deferral, Uri uri, TimeSpan started, string context, string kind)
    {
        long bytes = -1;
        string? note = null;
        try
        {
            // The lookup runs off the UI thread, as a package store read would; the response is created back on it.
            var (body, headers, status) = await Task.Run(() => Resolve(uri));
            bytes = body.Length;
            e.Response = Env.CreateWebResourceResponse(new MemoryStream(body, writable: false), status, status == 200 ? "OK" : "Not Found", headers);
        }
        catch (Exception ex)
        {
            note = "serve failed: " + ex.Message;
        }
        finally
        {
            deferral.Complete();
            lock (_served)
            {
                _served.Add(new Served(Now(), uri.AbsoluteUri, context, kind, Math.Round((_clock.Elapsed - started).TotalMilliseconds, 2), bytes, note));
            }
        }
    }

    private (byte[] Body, string Headers, int Status) Resolve(Uri uri)
    {
        const string noStore = "Cache-Control: no-store";
        var path = uri.AbsolutePath == "/" ? "/index.html" : uri.AbsolutePath;
        if (path == "/big.wasm")
        {
            _big ??= RandomNumberGenerator.GetBytes(5 * 1024 * 1024);
            return (_big, "Content-Type: application/wasm\r\n" + noStore, 200);
        }

        if (path.StartsWith("/s5/", StringComparison.Ordinal))
        {
            return (Encoding.UTF8.GetBytes("window.__s5 = (window.__s5 || 0) + 1; // " + path + "\n"), "Content-Type: text/javascript\r\n" + noStore, 200);
        }

        if (path == "/file.bin")
        {
            return (Enumerable.Repeat((byte)0x5A, 64 * 1024).ToArray(),
                "Content-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=\"served.bin\"\r\n" + noStore, 200);
        }

        if (path == "/data.json")
        {
            return (Encoding.UTF8.GetBytes("{\"ok\":true,\"from\":\"" + uri.Host + "\"}"), "Content-Type: application/json\r\n" + noStore, 200);
        }

        var file = Path.GetFullPath(Path.Combine(_viewDir, path.TrimStart('/')));
        if (file.StartsWith(_viewDir + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) && File.Exists(file))
        {
            var type = Path.GetExtension(file) switch
            {
                ".html" => "text/html; charset=utf-8",
                ".js" => "text/javascript; charset=utf-8",
                _ => "application/octet-stream",
            };

            // S11: the host chooses the response headers of every view document, so it can add a CSP.
            var csp = path == "/index.html" && uri.Query.Contains("csp=connect-self", StringComparison.Ordinal)
                ? "\r\nContent-Security-Policy: connect-src 'self'"
                : "";
            return (File.ReadAllBytes(file), "Content-Type: " + type + "\r\n" + noStore + csp, 200);
        }

        return (Encoding.UTF8.GetBytes("not found"), "Content-Type: text/plain\r\n" + noStore, 404);
    }

    private JsonObject Meta(string arguments, int port) => new()
    {
        ["date"] = DateTimeOffset.Now.ToString("yyyy-MM-dd HH:mm:ss zzz", CultureInfo.InvariantCulture),
        ["browserVersion"] = Env.BrowserVersionString,
        ["sdkCoreFileVersion"] = FileVersionInfo.GetVersionInfo(typeof(CoreWebView2).Assembly.Location).FileVersion,
        ["sdkWinFormsFileVersion"] = FileVersionInfo.GetVersionInfo(typeof(WebView2).Assembly.Location).FileVersion,
        ["logicalProcessors"] = Environment.ProcessorCount,
        ["os"] = RuntimeInformation.OSDescription,
        ["runtime"] = RuntimeInformation.FrameworkDescription,
        ["arguments"] = arguments,
        ["debugPort"] = port,
        ["phase"] = _o.Phase,
        ["harnessPid"] = Environment.ProcessId,
        ["browserPid"] = (long)Core.BrowserProcessId,
        ["userDataFolder"] = Env.UserDataFolder,
    };

    private async Task ShutdownAsync()
    {
        try
        {
            _cdp?.Dispose();
            if (_env is null)
            {
                return;
            }

            var exited = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            _env.BrowserProcessExited += (_, _) => exited.TrySetResult();
            _web.Dispose();
            var done = await Task.WhenAny(exited.Task, Task.Delay(15000));
            Log("browser process exited after close: " + (done == exited.Task));
        }
        catch (Exception ex)
        {
            Log("shutdown: " + ex.Message);
        }
    }

    private void Watchdog()
    {
        Log("WATCHDOG: the run exceeded 15 minutes; writing what exists and exiting.");
        Save();
        Environment.Exit(3);
    }

    // ---- stepping, events and results ----

    private async Task Step(string id, string title, int timeoutSeconds, Func<JsonObject, Task> body, bool reset = true)
    {
        if (!_o.Runs(id))
        {
            return;
        }

        var evidence = new JsonObject();
        var entry = new JsonObject { ["title"] = title, ["evidence"] = evidence };
        _steps[id] = entry;
        Log($"--- {id}: {title}");
        var watch = Stopwatch.StartNew();
        try
        {
            var task = body(evidence);
            if (await Task.WhenAny(task, Task.Delay(TimeSpan.FromSeconds(timeoutSeconds))) != task)
            {
                entry["status"] = "timeout";
            }
            else
            {
                await task;
                entry["status"] = "ran";
            }
        }
        catch (Exception ex)
        {
            entry["status"] = "error";
            entry["error"] = ex.GetType().Name + ": " + ex.Message;
            Log($"{id} error: {ex}");
        }

        entry["ms"] = watch.ElapsedMilliseconds;
        if (reset)
        {
            try
            {
                _permissionPolicy = CoreWebView2PermissionState.Deny;
                _cancelFrameNavigation = null;
                _frameMessageHooks = true;
                _savesInProfile = true;
                _contextMenuHandleAll = false;
                await EvalAsync(_page, "spike.clear()", 5000);
            }
            catch (Exception ex)
            {
                entry["resetError"] = ex.Message;
            }
        }

        Log($"{id} {entry["status"]} in {entry["ms"]} ms: {Trim(evidence["answer"]?.ToJsonString(), 400)}");
        Save();
    }

    private JsonObject Ev(string kind, JsonObject data)
    {
        data["t"] = Now();
        data["kind"] = kind;
        lock (_events)
        {
            _events.Add(data);
        }

        if (!kind.StartsWith("cdp:Target", StringComparison.Ordinal))
        {
            Log("event " + data.ToJsonString());
        }

        return data;
    }

    private int Mark()
    {
        lock (_events)
        {
            return _events.Count;
        }
    }

    private JsonArray Logged(int mark, params string[] kinds)
    {
        lock (_events)
        {
            return new JsonArray(_events.Skip(mark)
                .Where(e => kinds.Length == 0 || kinds.Contains((string?)e["kind"] ?? ""))
                .Select(e => (JsonNode?)e.DeepClone())
                .ToArray());
        }
    }

    private int ServedCount()
    {
        lock (_served)
        {
            return _served.Count;
        }
    }

    private List<Served> ServedSince(int mark)
    {
        lock (_served)
        {
            return _served.Skip(mark).ToList();
        }
    }

    private static JsonArray Json(IEnumerable<Served> served) => new(served.Select(s => (JsonNode?)s.ToJson()).ToArray());

    private double Now() => Math.Round(_clock.Elapsed.TotalMilliseconds, 1);

    private void Save()
    {
        lock (_saveLock)
        {
            try
            {
                JsonArray events;
                lock (_events)
                {
                    events = new JsonArray(_events.Select(e => (JsonNode?)e.DeepClone()).ToArray());
                }

                JsonArray served;
                lock (_served)
                {
                    served = Json(_served);
                }

                var document = new JsonObject
                {
                    ["meta"] = _meta?.DeepClone(),
                    ["steps"] = _steps.DeepClone(),
                    ["events"] = events,
                    ["served"] = served,
                };
                File.WriteAllText(ResultsPath, document.ToJsonString(Pretty), new UTF8Encoding(false));
            }
            catch (Exception ex)
            {
                Log("save failed: " + ex.Message);
            }
        }
    }

    private void Log(string line)
    {
        var text = $"[{Now(),9:0.0}] {line}";
        lock (_logLock)
        {
            Console.WriteLine(text);
            _log?.WriteLine(text);
        }
    }

    // ---- page, frames and CDP helpers ----

    private async Task<bool> NavigateAsync(string url)
    {
        var done = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        void Completed(object? sender, CoreWebView2NavigationCompletedEventArgs e) => done.TrySetResult(e.IsSuccess);
        Core.NavigationCompleted += Completed;
        try
        {
            Core.Navigate(url);
            return await done.Task.WaitAsync(TimeSpan.FromSeconds(20));
        }
        finally
        {
            Core.NavigationCompleted -= Completed;
        }
    }

    private async Task ReloadWorkbenchAsync()
    {
        lock (_sessions)
        {
            _sessions.Clear();
        }

        await NavigateAsync(AppUrl);
        await WaitTrueAsync(_page, "typeof spike === 'object'", 10000);
    }

    private async Task<string> AttachPageAsync()
    {
        var until = _clock.ElapsedMilliseconds + 10000;
        while (true)
        {
            var targets = await C.SendAsync("Target.getTargets");
            foreach (var t in targets?["targetInfos"]?.AsArray() ?? new JsonArray())
            {
                if ((string?)t?["type"] == "page" && ((string?)t["url"] ?? "").StartsWith("https://" + AppHost + "/", StringComparison.Ordinal))
                {
                    var attached = await C.SendAsync("Target.attachToTarget", new JsonObject { ["targetId"] = (string?)t["targetId"], ["flatten"] = true });
                    return (string)attached!["sessionId"]!;
                }
            }

            if (_clock.ElapsedMilliseconds > until)
            {
                throw new TimeoutException("No Workbench page target.");
            }

            await Task.Delay(150);
        }
    }

    /// <summary>
    /// A CDP handle for a view frame found by the n= marker in its URL: the out-of-process iframe
    /// target's session, or (if the frame shares the Workbench's process) "ctx:session:contextId".
    /// </summary>
    private async Task<string> FrameAsync(string name, int timeoutMs = 10000)
    {
        var marker = "?n=" + name + "&";
        var until = _clock.ElapsedMilliseconds + timeoutMs;
        var started = _clock.ElapsedMilliseconds;
        while (true)
        {
            var targets = await C.SendAsync("Target.getTargets");
            foreach (var t in targets?["targetInfos"]?.AsArray() ?? new JsonArray())
            {
                if ((string?)t?["type"] != "iframe" || !((string?)t["url"] ?? "").Contains(marker, StringComparison.Ordinal))
                {
                    continue;
                }

                var id = (string)t["targetId"]!;
                lock (_sessions)
                {
                    if (_sessions.TryGetValue(id, out var existing))
                    {
                        return existing;
                    }
                }

                var attached = await C.SendAsync("Target.attachToTarget", new JsonObject { ["targetId"] = id, ["flatten"] = true });
                var session = (string)attached!["sessionId"]!;
                lock (_sessions)
                {
                    _sessions[id] = session;
                }

                try
                {
                    await C.SendAsync("Log.enable", null, session, 3000);
                }
                catch (Exception)
                {
                    // Log is evidence only.
                }

                return session;
            }

            if (_clock.ElapsedMilliseconds - started > 1500 && await InProcessFrameAsync(marker) is { } inProcess)
            {
                return inProcess;
            }

            if (_clock.ElapsedMilliseconds > until)
            {
                throw new TimeoutException("No frame target for " + name);
            }

            await Task.Delay(150);
        }
    }

    private async Task<string?> InProcessFrameAsync(string marker)
    {
        var tree = await C.SendAsync("Page.getFrameTree", null, _page);
        var frameId = FindFrame(tree?["frameTree"], marker);
        if (frameId is null)
        {
            return null;
        }

        lock (_contexts)
        {
            return _contexts.TryGetValue(_page + "|" + frameId, out var context) ? $"ctx:{_page}:{context}" : null;
        }
    }

    private static string? FindFrame(JsonNode? node, string marker)
    {
        if (node is null)
        {
            return null;
        }

        if (((string?)node["frame"]?["url"] ?? "").Contains(marker, StringComparison.Ordinal))
        {
            return (string?)node["frame"]?["id"];
        }

        foreach (var child in node["childFrames"]?.AsArray() ?? new JsonArray())
        {
            if (FindFrame(child, marker) is { } found)
            {
                return found;
            }
        }

        return null;
    }

    private async Task<JsonNode?> EvalAsync(string target, string expression, int timeoutMs = 15000, bool userGesture = false)
    {
        var session = target;
        var parameters = new JsonObject { ["expression"] = expression, ["returnByValue"] = true, ["awaitPromise"] = true, ["userGesture"] = userGesture };
        if (target.StartsWith("ctx:", StringComparison.Ordinal))
        {
            var parts = target.Split(':');
            session = parts[1];
            parameters["contextId"] = int.Parse(parts[2], CultureInfo.InvariantCulture);
        }

        var result = await C.SendAsync("Runtime.evaluate", parameters, session, timeoutMs);
        if (result?["exceptionDetails"] is JsonNode details)
        {
            throw new InvalidOperationException("Evaluation failed: " + ((string?)details["exception"]?["description"] ?? (string?)details["text"]));
        }

        return result?["result"]?["value"]?.DeepClone();
    }

    private async Task WaitTrueAsync(string target, string expression, int timeoutMs)
    {
        var until = _clock.ElapsedMilliseconds + timeoutMs;
        while (true)
        {
            if (await EvalAsync(target, expression) is JsonValue value && value.TryGetValue<bool>(out var ok) && ok)
            {
                return;
            }

            if (_clock.ElapsedMilliseconds > until)
            {
                throw new TimeoutException("Timed out waiting for " + expression);
            }

            await Task.Delay(100);
        }
    }

    private async Task<bool> TryWaitTrueAsync(string target, string expression, int timeoutMs)
    {
        try
        {
            await WaitTrueAsync(target, expression, timeoutMs);
            return true;
        }
        catch (TimeoutException)
        {
            return false;
        }
    }

    private async Task AddFrameAsync(string name, string origin, string query = "", string parent = "stage", int width = 360, int height = 200, bool lazy = false, bool wait = true)
    {
        var src = $"{origin}/index.html?n={name}&v=1{query}";
        await EvalAsync(_page, $"spike.addFrame({{ name: {Js(name)}, src: {Js(src)}, parent: {Js(parent)}, width: {width}, height: {height}, lazy: {(lazy ? "true" : "false")} }})");
        if (wait)
        {
            await WaitTrueAsync(_page, $"spike.hellos({Js(name)}).length >= 1", 15000);
        }
    }

    private Task<JsonNode?> Mouse(string type, double x, double y, string button = "none", int buttons = 0, int timeoutMs = 5000) =>
        C.SendAsync("Input.dispatchMouseEvent", new JsonObject
        {
            ["type"] = type,
            ["x"] = x,
            ["y"] = y,
            ["button"] = button,
            ["buttons"] = buttons,
            ["clickCount"] = type == "mouseMoved" ? 0 : 1,
        }, _page, timeoutMs);

    private async Task ClickAsync(double x, double y, string button = "left")
    {
        await Mouse("mouseMoved", x, y);
        await Mouse("mousePressed", x, y, button, button == "right" ? 2 : 1);
        await Mouse("mouseReleased", x, y, button, 0);
    }

    private async Task<(double X, double Y)> PointInFrameAsync(string name, string selector)
    {
        var frame = await FrameAsync(name);
        var inner = await EvalAsync(frame, $"(() => {{ const r = document.querySelector({Js(selector)}).getBoundingClientRect(); return {{ x: r.left + r.width / 2, y: r.top + r.height / 2 }}; }})()");
        var outer = await EvalAsync(_page, $"spike.rect({Js(name)})");
        return (outer!["x"]!.GetValue<double>() + inner!["x"]!.GetValue<double>(), outer["y"]!.GetValue<double>() + inner["y"]!.GetValue<double>());
    }

    private async Task ClickInFrameAsync(string name, string selector, string button = "left")
    {
        var (x, y) = await PointInFrameAsync(name, selector);
        await ClickAsync(x, y, button);
    }

    private async Task<(double X, double Y)> PointInPageAsync(string selector)
    {
        var point = await EvalAsync(_page, $"spike.elementCenter({Js(selector)})");
        return (point!["x"]!.GetValue<double>(), point["y"]!.GetValue<double>());
    }

    private async Task<JsonArray> ProcessesAsync()
    {
        var result = new JsonArray();
        foreach (var p in await Env.GetProcessExtendedInfosAsync())
        {
            var frames = new JsonArray();
            foreach (var f in p.AssociatedFrameInfos)
            {
                frames.Add(FrameInfo(f));
            }

            var memory = Native.Memory(p.ProcessInfo.ProcessId);
            result.Add(new JsonObject
            {
                ["pid"] = p.ProcessInfo.ProcessId,
                ["kind"] = p.ProcessInfo.Kind.ToString(),
                ["privateWsMiB"] = memory is { } m ? Math.Round(m.PrivateWorkingSet / 1048576.0, 1) : null,
                ["frames"] = frames,
            });
        }

        return result;
    }

    private async Task<int?> PidOfFrameAsync(string name)
    {
        foreach (var p in await Env.GetProcessExtendedInfosAsync())
        {
            if (p.AssociatedFrameInfos.Any(f => f.Name == name))
            {
                return p.ProcessInfo.ProcessId;
            }
        }

        return null;
    }

    private async Task<int?> PidOfWorkbenchAsync()
    {
        foreach (var p in await Env.GetProcessExtendedInfosAsync())
        {
            if (p.AssociatedFrameInfos.Any(f => f.FrameKind == CoreWebView2FrameKind.MainFrame))
            {
                return p.ProcessInfo.ProcessId;
            }
        }

        return null;
    }

    private async Task<JsonObject> WaitExitAsync(int pid, int timeoutMs)
    {
        var watch = Stopwatch.StartNew();
        while (watch.ElapsedMilliseconds < timeoutMs)
        {
            if (!Native.IsAlive(pid))
            {
                return new JsonObject { ["pid"] = pid, ["exited"] = true, ["ms"] = watch.ElapsedMilliseconds };
            }

            await Task.Delay(50);
        }

        return new JsonObject { ["pid"] = pid, ["exited"] = false, ["ms"] = watch.ElapsedMilliseconds };
    }

    private async Task<List<Native.WindowInfo>> WindowsAsync()
    {
        var pids = new HashSet<int> { Environment.ProcessId, (int)Core.BrowserProcessId };
        foreach (var p in await Env.GetProcessExtendedInfosAsync())
        {
            pids.Add(p.ProcessInfo.ProcessId);
        }

        return Native.Windows(pids, Handle);
    }

    private static List<Native.WindowInfo> NewWindows(List<Native.WindowInfo> before, List<Native.WindowInfo> after) =>
        after.Where(w => before.All(b => b.Handle != w.Handle)).ToList();

    private static JsonArray Describe(IEnumerable<Native.WindowInfo> windows) =>
        new(windows.Select(w => (JsonNode?)w.ToString()).ToArray());

    private static JsonObject FrameInfo(CoreWebView2FrameInfo f) => new()
    {
        ["name"] = f.Name,
        ["source"] = Trim(f.Source, 120),
        ["frameKind"] = f.FrameKind.ToString(),
        ["frameId"] = (long)f.FrameId,
    };

    private static string Origin(string packageId)
    {
        var key = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(packageId)))[..10];
        return $"https://{packageId.Replace('.', '-')}-{key}.example";
    }

    private static string Js(string value) => JsonSerializer.Serialize(value);

    private static string? Trim(string? value, int max = 300) => value is null || value.Length <= max ? value : value[..max] + "...";

    private static int FreePort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }
}
