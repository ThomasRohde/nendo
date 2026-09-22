[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outputRoot = Join-Path $repoRoot 'artifacts/build/publish'
$payload = Join-Path $outputRoot 'payload'
[void][IO.Directory]::CreateDirectory($outputRoot)
if (Test-Path -LiteralPath (Join-Path $outputRoot 'manifest.json')) {
    $id = (Get-FileHash -LiteralPath (Join-Path $outputRoot 'manifest.json')).Hash.Substring(0,16).ToLowerInvariant()
    $evidence = Join-Path $repoRoot "artifacts/evidence/installers/$id"
    [void][IO.Directory]::CreateDirectory($evidence)
    Get-ChildItem -LiteralPath $outputRoot -File | Copy-Item -Destination $evidence -Force
    & (Join-Path $PSScriptRoot 'Remove-NendoBuildPayload.ps1') -BuildRoot $outputRoot -Apply | Out-Null
    Copy-Item -LiteralPath (Join-Path $outputRoot 'payload-pruned.json') -Destination $evidence -Force
    if (Test-Path -LiteralPath $payload) { throw 'Unrecognized payload files were retained; inspect before republishing.' }
    foreach ($name in @('manifest.json','installer.json','installer-smoke.json','nendo-install.json','nendo.nsi','payload-pruned.json','workbench-restore.log','workbench-check.log','workbench-test.log','workbench-build.log','publish.log','installer-build.log','installed-runtime.log','installed-performance.log')) {
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
    Invoke-PilotCommand 'dotnet' @('publish', 'src/Nendo.Desktop/Nendo.Desktop.csproj', '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-p:PublishTrimmed=false', '-p:PublishReadyToRun=true', '-o', $payload, '--nologo') 'publish.log'
    # A separate runtime payload keeps the contained helper free of Engine and MCP assemblies.
    $helperPayload = Join-Path $payload 'ExtensionHost'
    Invoke-PilotCommand 'dotnet' @('publish', 'src/Nendo.ExtensionHost/Nendo.ExtensionHost.csproj', '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-p:PublishTrimmed=false', '-p:PublishReadyToRun=true', '-o', $helperPayload, '--nologo') 'extension-publish.log'
    foreach ($required in @('Nendo.ExtensionHost.exe', 'Nendo.ExtensionHost.dll', 'coreclr.dll', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll')) {
        if (-not (Test-Path -LiteralPath (Join-Path $helperPayload $required))) { throw "Missing custom-view helper dependency: $required" }
    }
    foreach ($forbidden in @('Nendo.Engine.dll', 'Nendo.LocalMcp.dll', 'Microsoft.Data.Sqlite.dll', 'e_sqlite3.dll')) {
        if (Get-ChildItem -LiteralPath $helperPayload -Recurse -File -Filter $forbidden) { throw "Privileged dependency in custom-view helper: $forbidden" }
    }
    foreach ($required in @('Nendo.Desktop.exe', 'Nendo.Desktop.dll', 'Nendo.Engine.dll', 'Nendo.LocalMcp.dll', 'coreclr.dll', 'Microsoft.UI.Xaml.dll', 'e_sqlite3.dll', 'Workbench/index.html', 'App.xbf', 'MainPage.xbf', 'MainWindow.xbf', 'Nendo.Desktop.pri')) {
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
