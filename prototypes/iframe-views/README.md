# Iframe views spike

A disposable measurement harness for moving custom views out of the contained helper
process and into cross-origin `<iframe>`s inside the Workbench's own WebView2. The results
and what they mean are in [FINDINGS.md](FINDINGS.md).

It is a standalone Windows Forms executable with one WebView2. It references no production
project, is not in `Nendo.slnx`, and opens no `.nendo` file. The page at
`https://app.nendo.local/` is a stand-in for the Workbench, **not the Workbench**. It carries
the proposed CSP, including `frame-src https://*.example`. Each view package gets its own
`https://{slug}-{key}.example` origin, served through `WebResourceRequested` with a deferral.
The harness drives the page over the Chrome DevTools Protocol on the browser's debugging
port. It uses `Input.dispatchMouseEvent` wherever a test needs real user activation, and it
writes machine-readable JSON.

## Requirements

- Windows x64 with an interactive desktop. A window is shown for about eight minutes; it
  does not take focus.
- A free system clipboard for S10. If another process holds the clipboard open, `writeText`
  still resolves and `readText` returns an empty string. That happened on 2026-09-25 until
  16:15; S10 was rerun at 16:20 with `--only S10` once the clipboard was free (see
  FINDINGS.md).
- The repository's .NET SDK (`global.json`, 10.0.204) and the WebView2 Evergreen Runtime.
- `Microsoft.Web.WebView2` **1.0.3179.45** in the NuGet global packages folder. That is the
  version `Nendo.Desktop` resolves from Windows App SDK 1.8. The local `NuGet.Config` clears
  every source, so a missing package is a restore failure, not a silent upgrade.

## Run

From the repository root, in PowerShell 7:

```powershell
./prototypes/iframe-views/run.ps1
```

That is exactly:

```powershell
$out = "$PWD/artifacts/spike-iframe-views"
dotnet restore prototypes/iframe-views/IframeViewsSpike.csproj --configfile prototypes/iframe-views/NuGet.Config "-p:ArtifactsPath=$out/build"
dotnet build prototypes/iframe-views/IframeViewsSpike.csproj --no-restore -c Release "-p:ArtifactsPath=$out/build" -v minimal
& "$out/build/bin/IframeViewsSpike/release/IframeViewsSpike.exe" --phase main --out $out
& "$out/build/bin/IframeViewsSpike/release/IframeViewsSpike.exe" --phase persist-read --out $out
```

The main phase deletes and recreates `artifacts/spike-iframe-views/profile`, then runs every
experiment and writes into `profile` for S16. The `persist-read` phase is a new process on
the same profile: it reads the S16 values back, which is the restart that S16 needs.

Variants:

```powershell
./prototypes/iframe-views/run.ps1 -Only S2,S3          # selected steps; persist-read runs only with S16
./prototypes/iframe-views/run.ps1 -SitePerProcess      # adds --site-per-process; own profile, *-spp files

# The two follow-up runs FINDINGS.md cites, each in its own folder with a fresh profile:
& "$out/build/bin/IframeViewsSpike/release/IframeViewsSpike.exe" --phase main --out "$out/followup" --only S10,S11
& "$out/build/bin/IframeViewsSpike/release/IframeViewsSpike.exe" --phase main --out "$out/followup-clipboard" --only S10

# S20 negative probe: one API that 1.0.3179.45 lacks. Expect CS1061 on CoreWebView2Frame.FrameCreated.
dotnet build prototypes/iframe-views/IframeViewsSpike.csproj -c Release -p:SpikeProbe=true "-p:ArtifactsPath=$PWD/artifacts/spike-iframe-views/probe-build"
# The same probe against the cached 1.0.3719.77 compiles.
dotnet build prototypes/iframe-views/IframeViewsSpike.csproj -c Release -p:SpikeProbe=true -p:SpikeWebView2Version=1.0.3719.77 "-p:ArtifactsPath=$PWD/artifacts/spike-iframe-views/probe-build-3719"
```

The two probe builds restore on their own because they build without `--no-restore`. If the
restore fails, run `dotnet restore` first with the same properties and
`--configfile prototypes/iframe-views/NuGet.Config`.

Exit code 0 means the harness completed; it does not mean every expectation held. Each
step's `status` in the JSON is `ran`, `error` or `timeout`. The answers are in its `evidence`.

## Output

Everything goes under `artifacts/spike-iframe-views/`, which is git-ignored:

| Path | Content |
| --- | --- |
| `results-main.json` | `meta`, then `steps.S1`…`S22` with evidence and a one-line `answer`, all host and CDP `events`, every `served` request |
| `results-persist-read.json` | S16 after the restart |
| `run-main.log`, `run-persist-read.log` | the same run as text |
| `s13-*.png`, `s22-default-alert.png` | `PrintWindow` captures of the menu window and of the harness window only |
| `downloads/` | S19 downloads, including the ones made with no handler |
| `profile/`, `build/` | the WebView2 user data folder and the build output |

## What it touches

- **The system clipboard and focus (S10).** S10 writes tokens and tries to restore previous
  text, an image or a file list. It records only whether the clipboard held the token, never
  other content. It also calls `Activate()` once, to repeat two trials with real OS focus;
  Windows may or may not grant the foreground (`foregroundTaken` in the JSON).
- **Windows it opens itself.** A DevTools window (S13), default context menus (S13) and an
  in-page script dialog (S22). The harness closes them.
- **Network.** A loopback listener on an ephemeral port (S11), and requests from a view frame
  to `https://example.org/` (S11). The Workbench stand-in tries `https://example.org/` too
  (S6); CSP blocks that request before it leaves.
- **Processes.** Renderer processes of its own WebView2 environment only (S3 kills one by
  PID). It never touches an installed Nendo, its profile or `%LOCALAPPDATA%\Nendo`.

## Files

| File | Role |
| --- | --- |
| `Program.cs` | options, the harness form, WebView2 setup, event recording, the view origin server, CDP helpers |
| `Experiments.cs` | S1–S22 |
| `Cdp.cs` | a small CDP client over the debugging port (flattened sessions) |
| `Canary.cs` | the loopback HTTP and WebSocket listener that records what arrives |
| `Native.cs` | private working set, process liveness, window snapshots, `PrintWindow` |
| `app/` | the Workbench stand-in page and its script |
| `view/` | the view package every `*.example` origin serves |
| `run.ps1` | build, main phase, restart phase |
