using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Nendo.Engine;

namespace Nendo.ExtensionHost;

internal sealed class ExtensionWindow : Form
{
    private const string Origin = "https://nendo.extension.local";
    // The OS boundary does not cover the clipboard: an AppContainer page with a user click can read and write it
    // (measured 2026-09-20, prototype clipboard lane). Every document in this view therefore loses the page-side
    // clipboard entry points before its own script runs; the properties are sealed so a page cannot put them back.
    private const string ClipboardPolicy = """
        (() => {
          try { Object.defineProperty(Navigator.prototype, 'clipboard', { get() { return undefined; }, configurable: false }); } catch { }
          try {
            const execCommand = Document.prototype.execCommand;
            Object.defineProperty(Document.prototype, 'execCommand', {
              value(command, ...rest) { return /^(copy|cut|paste)$/i.test(String(command)) ? false : execCommand.call(this, command, ...rest); },
              configurable: false, writable: false
            });
          } catch { }
        })();
        """;
    private readonly Stream _incoming;
    private readonly Stream _outgoing;
    private readonly string _assets;
    private readonly string _state;
    private readonly string _entry;
    private readonly WebView2 _view = new() { Dock = DockStyle.Fill };
    private readonly Channel<byte[]> _messages = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(16) { SingleReader = true, SingleWriter = false });
    private readonly CancellationTokenSource _lifetime = new();
    private int _resourcesDisposed;
    internal int ExitCode { get; private set; } = 70;

    internal ExtensionWindow(Stream incoming, Stream outgoing, string assets, string state, string entry)
    {
        _incoming = incoming; _outgoing = outgoing;
        _assets = Path.GetFullPath(assets); _state = Path.GetFullPath(state); _entry = entry;
        Text = "Nendo custom view"; Width = 960; Height = 640;
        ShowInTaskbar = false; FormBorderStyle = FormBorderStyle.None;
        Opacity = 0; // Invisible until the native host composes the contained child window.
        Controls.Add(_view);
        _view.KeyDown += (_, e) =>
        {
            if (e.KeyCode != Keys.F6) return;
            e.Handled = true; e.SuppressKeyPress = true;
            Emit(new { type = "focusHost" }); // Native key event; page messages cannot create this envelope.
        };
        Shown += async (_, _) => await StartAsync();
        FormClosed += (_, _) => { _lifetime.Cancel(); _messages.Writer.TryComplete(); };
    }

    private void Emit(object message)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(message);
        if (bytes.Length > 96 * 1024 || !_messages.Writer.TryWrite(bytes)) Fail();
    }

    private void Fail()
    {
        ExitCode = 70;
        if (!IsDisposed) Close();
    }

    private async Task StartAsync()
    {
        _ = PumpOutputAsync();
        try
        {
            var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(_state, "webview"));
            await _view.EnsureCoreWebView2Async(environment);
            var core = _view.CoreWebView2;
            core.Settings.AreHostObjectsAllowed = false;
            core.Settings.AreDevToolsEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = false;
            core.Settings.AreDefaultScriptDialogsEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = false;
            core.Settings.IsBuiltInErrorPageEnabled = false;
            core.Settings.IsStatusBarEnabled = false;
            core.SetVirtualHostNameToFolderMapping("nendo.extension.local", _assets, CoreWebView2HostResourceAccessKind.DenyCors);
            core.PermissionRequested += (_, e) => { e.State = CoreWebView2PermissionState.Deny; e.Handled = true; };
            core.NewWindowRequested += (_, e) => e.Handled = true;
            core.DownloadStarting += (_, e) => { e.Cancel = true; e.Handled = true; };
            core.ProcessFailed += (_, _) => Fail();
            var navigationStarted = false;
            core.NavigationStarting += (_, e) =>
            {
                if (navigationStarted || e.Uri != Origin + "/" + _entry) e.Cancel = true;
                else navigationStarted = true;
            };
            core.FrameNavigationStarting += (_, e) => e.Cancel = true;
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
            core.WebResourceRequested += (_, e) =>
            {
                try
                {
                    if (!Uri.TryCreate(e.Request.Uri, UriKind.Absolute, out var uri) || uri.Scheme != "https" || uri.Host != "nendo.extension.local" || !uri.IsDefaultPort)
                        throw new IOException("External resource.");
                    var path = Path.GetFullPath(Path.Combine(_assets, Uri.UnescapeDataString(uri.AbsolutePath).TrimStart('/').Replace('/', Path.DirectorySeparatorChar)));
                    if (!path.StartsWith(Path.TrimEndingDirectorySeparator(_assets) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
                        (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new IOException("Invalid asset path.");
                    var contentType = Path.GetExtension(path) switch
                    { ".html" => "text/html", ".js" => "text/javascript", ".css" => "text/css", ".txt" => "text/plain", _ => throw new IOException("Invalid asset type.") };
                    var headers = "Content-Type: " + contentType + "; charset=utf-8\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n" +
                        "Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'\r\n";
                    e.Response = environment.CreateWebResourceResponse(File.OpenRead(path), 200, "OK", headers);
                }
                catch { e.Response = environment.CreateWebResourceResponse(null, 403, "Blocked", "Content-Type: text/plain"); }
            };
            core.WebMessageReceived += (_, e) =>
            {
                try
                {
                    if (e.Source != Origin + "/" + _entry) { Fail(); return; }
                    var bytes = Encoding.UTF8.GetBytes(e.WebMessageAsJson);
                    if (bytes.Length > 64 * 1024) { Fail(); return; }
                    // Page JSON cannot impersonate a native report: always wrap it as bytes.
                    Emit(new { type = "view", data = Convert.ToBase64String(bytes) });
                }
                catch { Fail(); }
            };
            var navigated = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
            core.NavigationCompleted += (_, e) => navigated.TrySetResult(e.IsSuccess);
            await core.AddScriptToExecuteOnDocumentCreatedAsync(ClipboardPolicy);
            core.Navigate(Origin + "/" + _entry);
            if (!await navigated.Task.WaitAsync(TimeSpan.FromSeconds(10))) { Fail(); return; }
            Emit(new { type = "ready", processId = Environment.ProcessId, windowHandle = Handle.ToInt64(),
                browserProcessIds = environment.GetProcessInfos().Select(p => p.ProcessId).ToArray() });
            await PumpInputAsync();
        }
        catch { Fail(); }
    }

    private async Task PumpInputAsync()
    {
        while (!_lifetime.IsCancellationRequested)
        {
            var bytes = await NendoExtensionFrameCodec.ReadAsync(_incoming, 2 * 1024 * 1024, _lifetime.Token);
            if (bytes is null) { ExitCode = 0; Close(); return; }
            using var document = JsonDocument.Parse(bytes);
            if (!document.RootElement.TryGetProperty("method", out var method)) { Fail(); return; }
            if (method.GetString() == "dispose") { ExitCode = 0; Close(); return; }
            if (method.GetString() == "focus") { _view.Focus(); continue; }
            if (method.GetString() is not ("initialize" or "replaceProjection" or "setTheme")) { Fail(); return; }
            _view.CoreWebView2.PostWebMessageAsJson(Encoding.UTF8.GetString(bytes));
        }
    }

    private async Task PumpOutputAsync()
    {
        try
        {
            await foreach (var bytes in _messages.Reader.ReadAllAsync(_lifetime.Token))
                await NendoExtensionFrameCodec.WriteAsync(_outgoing, bytes, 96 * 1024, _lifetime.Token);
        }
        catch { if (!IsDisposed) BeginInvoke(Fail); }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && Interlocked.Exchange(ref _resourcesDisposed, 1) == 0)
        { _lifetime.Cancel(); _messages.Writer.TryComplete(); _view.Dispose(); _lifetime.Dispose(); }
        base.Dispose(disposing);
    }
}
