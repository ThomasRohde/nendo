[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outputRoot = Join-Path $repoRoot 'artifacts/build/publish'
$payload = Join-Path $outputRoot 'payload'
[void][IO.Directory]::CreateDirectory($outputRoot)
# The previous build's records are replaced, not archived: artifacts/ is scratch, and a
# build is reproduced from its commit rather than from a copy of its logs (AGENTS.md).
if (Test-Path -LiteralPath (Join-Path $outputRoot 'manifest.json')) {
    & (Join-Path $PSScriptRoot 'Remove-NendoBuildPayload.ps1') -BuildRoot $outputRoot -Apply | Out-Null
    if (Test-Path -LiteralPath $payload) { throw 'Unrecognized payload files were retained; inspect before republishing.' }
    foreach ($name in @('manifest.json','installer.json','installer-smoke.json','nendo-install.json','nendo.nsi','payload-pruned.json','workbench-restore.log','workbench-check.log','workbench-test.log','workbench-build.log','web-page-build.log','publish.log','installer-build.log','installed-runtime.log','installed-performance.log')) {
        $file = Join-Path $outputRoot $name
        if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file }
    }
} elseif (Test-Path -LiteralPath $payload) { throw 'An incomplete publish was retained. Inspect it before retrying.' }

function Invoke-PilotCommand {
    param([string] $File, [string[]] $Arguments, [string] $Log)
    & $File @Arguments *> (Join-Path $outputRoot $Log)
    if ($LASTEXITCODE -ne 0) { throw "$File failed ($LASTEXITCODE). See $outputRoot/$Log" }
}

Push-Location $repoRoot
try {
    $revision = & git -c "safe.directory=$($repoRoot.Replace('\','/'))" rev-parse HEAD
    if ($LASTEXITCODE -ne 0) { throw 'Cannot identify source revision.' }
    $sourceFiles = @(Get-ChildItem src -Recurse -File | Where-Object {
        $_.FullName -notmatch '[\\/](node_modules|dist|bin|obj)[\\/]'
    }) + @(Get-Item global.json, Directory.Build.props, Directory.Packages.props, $PSCommandPath)
    $sourceHashes = @($sourceFiles | Sort-Object FullName | ForEach-Object {
        @{ path = [IO.Path]::GetRelativePath($repoRoot, $_.FullName); sha256 = (Get-FileHash -LiteralPath $_.FullName).Hash }
    })
    Push-Location (Join-Path $repoRoot 'src/Nendo.Workbench')
    try {
        Invoke-PilotCommand 'npm.cmd' @('ci') 'workbench-restore.log'
        Invoke-PilotCommand 'npm.cmd' @('run', 'check') 'workbench-check.log'
        Invoke-PilotCommand 'npm.cmd' @('test') 'workbench-test.log'
        Invoke-PilotCommand 'npm.cmd' @('run', 'build') 'workbench-build.log'
    } finally { Pop-Location }
    # Export → Web page writes this page with a copy of the file in it (ADR-0035), so it ships with Nendo.
    Invoke-PilotCommand 'pwsh' @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'Build-BrowserHost.ps1'), '-SkipWorkbenchBuild') 'web-page-build.log'
    Invoke-PilotCommand 'dotnet' @('publish', 'src/Nendo.Desktop/Nendo.Desktop.csproj', '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-p:PublishTrimmed=false', '-p:PublishReadyToRun=true', '-o', $payload, '--nologo') 'publish.log'
    [void][IO.Directory]::CreateDirectory((Join-Path $payload 'WebPage'))
    Copy-Item -LiteralPath (Join-Path $repoRoot 'artifacts/browser-host/Nendo.html') -Destination (Join-Path $payload 'WebPage/Nendo.html')
    # Export → Web app puts this service worker beside the page (ADR-0037).
    Copy-Item -LiteralPath (Join-Path $repoRoot 'src/Nendo.Workbench/web-app/sw.js') -Destination (Join-Path $payload 'WebPage/sw.js')
    # Custom views run inside the Workbench's own browser; the API script they load is part of it.
    foreach ($required in @('Nendo.Desktop.exe', 'Nendo.Desktop.dll', 'Nendo.Engine.dll', 'Nendo.LocalMcp.dll', 'coreclr.dll', 'Microsoft.UI.Xaml.dll', 'e_sqlite3.dll', 'Workbench/index.html', 'Workbench/_nendo/api.js', 'WebPage/Nendo.html', 'WebPage/sw.js', 'App.xbf', 'MainPage.xbf', 'MainWindow.xbf', 'Nendo.Desktop.pri')) {
        if (-not (Test-Path -LiteralPath (Join-Path $payload $required))) { throw "Missing payload dependency: $required" }
    }
    foreach ($source in $sourceHashes) {
        if ((Get-FileHash -LiteralPath (Join-Path $repoRoot $source.path)).Hash -ne $source.sha256) { throw "Source changed while publishing: $($source.path)" }
    }
    $files = @(Get-ChildItem -LiteralPath $payload -Recurse -File | Sort-Object FullName | ForEach-Object {
        @{ path = [IO.Path]::GetRelativePath($payload, $_.FullName); length = $_.Length; sha256 = (Get-FileHash -LiteralPath $_.FullName).Hash }
    })
    # The product version the payload actually carries, read from the built
    # assembly rather than from the props file, so the manifest cannot claim a
    # version this payload was not built at.
    $productVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo((Join-Path $payload 'Nendo.Engine.dll')).ProductVersion
    if ([string]::IsNullOrWhiteSpace($productVersion)) { throw 'The published payload carries no product version.' }
    $productVersion = $productVersion.Split('+')[0]
    @{
        schemaVersion = 1; kind = 'local-pilot'; version = $productVersion
        revision = "$revision"; createdUtc = [DateTime]::UtcNow.ToString('O')
        configuration = 'Release'; runtimeIdentifier = 'win-x64'; selfContained = $true; trimmed = $false
        sdk = (& dotnet --version); sourceHashes = $sourceHashes; files = $files
        signatureStatus = [string](Get-AuthenticodeSignature -LiteralPath (Join-Path $payload 'Nendo.Desktop.exe')).Status
        webView2 = 'External Evergreen runtime prerequisite; not included or qualified by this publish.'
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $outputRoot 'manifest.json')
    Write-Output "Published pilot: $outputRoot"
} finally { Pop-Location }
