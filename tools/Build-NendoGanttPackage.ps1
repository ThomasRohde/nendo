[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# A Gantt chart of one record type: the first record-set package (extensionRecordsSurface,
# protocol 2), built by the shared packer. The printed SHA-256 is what a file pins: rebuild
# it and the pin changes, so the view must be installed and allowed again.
& (Join-Path $PSScriptRoot 'Build-NendoViewPackage.ps1') `
    -Source 'extensions/gantt' `
    -PackageId 'org.nendo.gantt' `
    -PackageVersion '0.1.0' `
    -ProtocolVersion 2 `
    -EntryPoint 'index.html' `
    -Assets @('index.html', 'gantt.css', 'gantt.js', 'LICENSE.txt')
