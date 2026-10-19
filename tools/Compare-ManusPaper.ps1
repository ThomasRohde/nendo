<#
.SYNOPSIS
Sets a manuscript's paper four ways and measures them against each other: the LaTeX
reference (AASTeX 6.3.1 twocolumn, tools/manus/latex.mjs, compiled with Tectonic), the Word
export as Word sets it and the Word export set as TeX sets it (both converted to PDF by Word),
and the view's Paper preview (in Edge, against the fixture broker). Writes
artifacts/manus/paper-compare: report.txt, sheets-N.png side by side and overlay-*-N.png over
the reference.

.DESCRIPTION
Optional and outside the gate: it needs Tectonic, Microsoft Word, and Python with PyMuPDF and
Pillow. -Endpoint reads the records of a manuscript file Nendo has open, over its MCP endpoint
(reading only); without it, the snapshot already in the output folder is used again.
The reference starts a column before any heading the class's grid leaves at a column's foot,
as the exports keep a heading with its text, and sets it again until none is left.
#>
[CmdletBinding()]
param(
    [string]$Endpoint,
    [string]$Root,
    [string]$Output = (Join-Path $PSScriptRoot '../artifacts/manus/paper-compare'),
    [switch]$NoWord
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$tools = Join-Path $repoRoot 'tools/manus/paper-compare'
$Output = [IO.Path]::GetFullPath($Output)
[void][IO.Directory]::CreateDirectory($Output)
foreach ($command in 'tectonic', 'python', 'node') { if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "$command is not on the path." } }
& python -c 'import pymupdf, PIL' 2>$null
if ($LASTEXITCODE -ne 0) { throw 'Python needs PyMuPDF and Pillow: python -m pip install pymupdf pillow' }

Push-Location $repoRoot
try {
    if ($Endpoint) { & node (Join-Path $tools 'snapshot.mjs') $Endpoint $Output; if ($LASTEXITCODE -ne 0) { throw 'The snapshot failed.' } }
    elseif (-not (Test-Path -LiteralPath (Join-Path $Output 'snapshot.json'))) { throw 'Name the open file with -Endpoint http://127.0.0.1:PORT/mcp.' }
    Set-Content -LiteralPath (Join-Path $Output 'breaks.json') -Value '[]' -Encoding utf8NoBOM
    & node (Join-Path $tools 'render.mjs') $Output $Root
    if ($LASTEXITCODE -ne 0) { throw 'The renders could not be written.' }

    # The reference: a column starts before any heading the grid left at a column's foot.
    $tex = Join-Path $Output 'tex'
    Copy-Item -LiteralPath (Join-Path $env:WINDIR 'Fonts/consola.ttf') -Destination $tex -Force
    for ($pass = 1; $pass -le 8; $pass++) {
        Push-Location $tex
        Remove-Item paper.aux -ErrorAction SilentlyContinue
        $log = & tectonic -X compile paper.tex 2>&1 | Out-String
        Pop-Location
        if ($log -notmatch 'Writing `paper.pdf`') { Write-Host $log.Substring([Math]::Max(0, $log.Length - 1500)); throw 'TeX could not set the reference.' }
        $stranded = @(& python (Join-Path $tools 'pdf.py') stranded (Join-Path $tex 'paper.pdf') (Join-Path $Output 'plan.json'))
        if ($stranded.Count -eq 0) { break }
        $known = @(Get-Content -LiteralPath (Join-Path $Output 'breaks.json') -Raw | ConvertFrom-Json)
        ConvertTo-Json -InputObject @($known + $stranded | Select-Object -Unique) -Compress | Set-Content -LiteralPath (Join-Path $Output 'breaks.json') -Encoding utf8NoBOM
        & node (Join-Path $tools 'render.mjs') $Output $Root tex | Out-Null
    }
    & python (Join-Path $tools 'pdf.py') pages $Output latex (Join-Path $tex 'paper.pdf')

    # The Word exports, as Word lays them out, starting the references where the reference does.
    & node (Join-Path $tools 'render.mjs') $Output $Root docx
    if ($LASTEXITCODE -ne 0) { throw 'The Word exports could not be written.' }
    if (-not $NoWord) {
        $word = New-Object -ComObject Word.Application
        $word.Visible = $false; $word.DisplayAlerts = 0
        try {
            foreach ($pair in @(@('paper.docx', 'word.pdf'), @('paper-typeset.docx', 'wordset.pdf'))) {
                $document = $word.Documents.Open((Join-Path $Output $pair[0]), $false, $true)
                $document.ExportAsFixedFormat((Join-Path $Output $pair[1]), 17)
                $document.Close(0)
            }
        } finally { $word.Quit(); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word) }
        & python (Join-Path $tools 'pdf.py') pages $Output word (Join-Path $Output 'word.pdf')
        & python (Join-Path $tools 'pdf.py') pages $Output wordset (Join-Path $Output 'wordset.pdf')
    }

    # The preview, in the view itself against the fixture broker.
    $runId = [Guid]::NewGuid().ToString('N')
    $infoPath = Join-Path $Output "server-$runId.json"
    $server = Start-Process node -ArgumentList @('tools/Graph-FixtureServer.mjs', $infoPath, '../extensions/manuscript') -WindowStyle Hidden -PassThru
    $session = "manuspaper-$runId"
    try {
        $deadline = [DateTime]::UtcNow.AddSeconds(20)
        while (-not (Test-Path -LiteralPath $infoPath)) { if ($server.HasExited -or [DateTime]::UtcNow -gt $deadline) { throw 'The fixture server did not start.' }; Start-Sleep -Milliseconds 100 }
        $info = Get-Content -LiteralPath $infoPath -Raw | ConvertFrom-Json
        $probe = Join-Path $Output "probe-$runId.mjs"
        & node (Join-Path $tools 'preview-fixture.mjs') $Output $probe $info.brokerUrl $Output $Root
        Push-Location $Output
        & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" open about:blank --browser msedge | Out-Null
        $ran = & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" run-code --filename $probe 2>&1 | Out-String
        Pop-Location
        $result = [regex]::Match($ran, '### Result\r?\n("[^\r\n]+")')
        if (-not $result.Success) { Write-Host $ran.Substring(0, [Math]::Min(2000, $ran.Length)); throw 'The preview could not be measured.' }
        $preview = $result.Groups[1].Value | ConvertFrom-Json | ConvertFrom-Json
        [IO.File]::WriteAllText((Join-Path $Output 'preview.json'), ($preview.pages | ConvertTo-Json -Depth 6 -Compress), [Text.UTF8Encoding]::new($false))
        "preview: $($preview.pages.Count) pages"
    } finally {
        & npx.cmd --yes --package '@playwright/cli@0.1.21' playwright-cli "-s=$session" close | Out-Null
        if (-not $server.HasExited) { Stop-Process -Id $server.Id }
        Remove-Item -LiteralPath $infoPath -ErrorAction SilentlyContinue
        Get-ChildItem -LiteralPath $Output -Filter 'probe-*.mjs' | Remove-Item
    }
    & python (Join-Path $tools 'compare.py') $Output
    "Report: $(Join-Path $Output 'report.txt')"
} finally { Pop-Location }
