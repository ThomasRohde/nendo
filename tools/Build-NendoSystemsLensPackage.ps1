[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Nendo Station's schematic view, built by the shared packer. The printed SHA-256 is what a
# file pins: rebuild it and the pin changes, so the view must be installed and allowed again.
& (Join-Path $PSScriptRoot 'Build-NendoViewPackage.ps1') `
    -Source 'extensions/systems-lens' `
    -PackageId 'org.nendo.systems-lens' `
    -PackageVersion '0.1.0' `
    -EntryPoint 'index.html' `
    -Assets @('index.html', 'lens.css', 'lens.js', 'LICENSE.txt')
