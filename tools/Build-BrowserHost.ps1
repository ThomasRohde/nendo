#Requires -Version 7
<#
.SYNOPSIS
Builds the browser host (ADR-0036) as one self-contained page: artifacts/browser-host/Nendo.html.

.DESCRIPTION
Publishes Nendo.Browser (the Engine and Nendo.Session on WebAssembly; needs the wasm-tools
workload), builds the Workbench and its view API, inlines the Workbench into one page, and packs
the runtime and the view API into it.
#>
[CmdletBinding()]
param([switch]$SkipWorkbenchBuild)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$workbench = Join-Path $repoRoot 'src/Nendo.Workbench'
$output = Join-Path $repoRoot 'artifacts/browser-host'
$runtime = Join-Path $output 'runtime'

function Invoke-Checked([string]$File, [string[]]$Arguments, [string]$What) {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$What failed ($LASTEXITCODE)." }
}

New-Item -ItemType Directory -Force $output | Out-Null
# Publishing over an earlier runtime leaves that build's fingerprinted files beside the new ones,
# and the page carries every file in the folder.
if (Test-Path -LiteralPath $runtime) { Remove-Item -LiteralPath $runtime -Recurse -Force }
Invoke-Checked 'dotnet' @('publish', (Join-Path $repoRoot 'src/Nendo.Browser/Nendo.Browser.csproj'), '-c', 'Release', '-o', $runtime, '--nologo') 'Browser host publish'
$npm = if ($IsWindows) { 'npm.cmd' } else { 'npm' }
$npx = if ($IsWindows) { 'npx.cmd' } else { 'npx' }
Push-Location $workbench
try {
    if (-not $SkipWorkbenchBuild) { Invoke-Checked $npm @('run', 'build') 'Workbench build' }
    Invoke-Checked $npx @('vite', 'build', '--config', 'vite.browser.config.ts') 'Browser host page build'
    Invoke-Checked 'node' @('scripts/pack-browser-host.mjs', (Join-Path $output 'page/index.html'), (Join-Path $runtime 'wwwroot'),
        (Join-Path $workbench 'dist/_nendo/api.js'), (Join-Path $output 'Nendo.html')) 'Browser host packing'
}
finally {
    Pop-Location
}
Write-Host "Browser host: $(Join-Path $output 'Nendo.html')"
