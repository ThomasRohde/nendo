[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# The offline dependency graph, built by the shared packer. Its entry order and manifest key
# order are the ones this package was first published with: changing either changes the digest,
# and a file pinned to the old one would report the package as changed.
& (Join-Path $PSScriptRoot 'Build-NendoViewPackage.ps1') `
    -Source 'extensions/dependency-graph' `
    -PackageId 'org.nendo.dependency-graph' `
    -PackageVersion '0.1.0' `
    -EntryPoint 'index.html' `
    -Assets @('index.html', 'graph.css', 'graph.js', 'LICENSE.txt')
