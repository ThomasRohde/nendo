[CmdletBinding()]
param(
    # For a repeat run with unchanged dependencies; npm ci reinstalls from scratch.
    [switch] $SkipInstall
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$siteRoot = Join-Path $repoRoot 'site'
if (-not (Test-Path -LiteralPath (Join-Path $siteRoot 'package.json') -PathType Leaf)) { throw "No site project at $siteRoot." }

# The same npm resolution Test-Production.ps1 uses: npm.cmd is not always the one
# on PATH, and the shim swallows the exit code on some machines.
function Get-NpmCommand {
    $node = (Get-Command node -ErrorAction SilentlyContinue)?.Source
    if ($node) {
        $cli = Join-Path (Split-Path $node) 'node_modules/npm/bin/npm-cli.js'
        if (Test-Path -LiteralPath $cli -PathType Leaf) { return @{ File = $node; Prefix = @($cli) } }
    }
    $npm = (Get-Command npm -ErrorAction SilentlyContinue)?.Source
    if (-not $npm) { throw 'npm was not found. Install the Node version site/package.json declares under engines.' }
    return @{ File = $npm; Prefix = @() }
}

$npm = Get-NpmCommand
function Invoke-Npm([string[]] $Arguments) {
    Push-Location $siteRoot
    try {
        & $npm.File @($npm.Prefix + $Arguments)
        if ($LASTEXITCODE -ne 0) {
            # -4048 is EPERM on the unlink npm ci does before reinstalling. On Windows
            # that is a running preview or dev server holding a native .node file open,
            # not a permissions problem, whatever npm's own message says.
            $hint = if ($LASTEXITCODE -eq -4048 -and $Arguments[0] -eq 'ci') {
                ' A running "npm --prefix site run preview" or "npm --prefix site run dev" locks site/node_modules; stop it, or pass -SkipInstall.'
            } else { '' }
            throw "npm $($Arguments -join ' ') failed with exit code $LASTEXITCODE.$hint"
        }
    }
    finally { Pop-Location }
}

Write-Host '== Website =='
if (-not $SkipInstall) { Invoke-Npm @('ci') }
Invoke-Npm @('run', 'check')
Invoke-Npm @('run', 'build')

Write-Host ''
Write-Host 'Website build passed.'
Write-Host "Output: $(Join-Path $siteRoot 'dist')  ·  preview with: npm --prefix site run preview"
