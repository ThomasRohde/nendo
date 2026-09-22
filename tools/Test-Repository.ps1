[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$gitSafeRoot = $repoRoot.Replace('\', '/')

function Assert-Match {
    param(
        [Parameter(Mandatory = $true)][string] $Text,
        [Parameter(Mandatory = $true)][string] $Pattern,
        [Parameter(Mandatory = $true)][string] $Message
    )

    if ($Text -notmatch $Pattern) {
        throw $Message
    }
}

Push-Location $repoRoot
try {
    Write-Host '== Vendored .NET skills =='
    & (Join-Path $PSScriptRoot 'Sync-DotnetSkills.ps1') -Check

    Write-Host '== JSON manifests =='
    $jsonFiles = @(
        '.agents/skills/dotnet-skills.lock.json',
        'fixtures/idea-garden/expected-shape.json',
        'fixtures/decision-log/expected-shape.json',
        'fixtures/decision-log/records.json'
    )
    foreach ($path in $jsonFiles) {
        $fullPath = Join-Path $repoRoot $path
        if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
            throw "Required JSON file is missing: $path"
        }
        Get-Content -LiteralPath $fullPath -Raw | ConvertFrom-Json | Out-Null
        Write-Host "OK       $path"
    }

    Write-Host '== Tracked-file hygiene =='
    $tracked = @(& git -c "safe.directory=$gitSafeRoot" -C $repoRoot ls-files)
    if ($LASTEXITCODE -ne 0) {
        throw 'git ls-files failed.'
    }

    $forbiddenDirectories = @(
        $tracked | Where-Object {
            $_ -match '(^|/)(bin|obj|node_modules|artifacts|\.dotnet)(/|$)'
        }
    )
    if ($forbiddenDirectories.Count -gt 0) {
        throw "Generated/dependency directories are tracked:`n$($forbiddenDirectories -join "`n")"
    }

    $rootBrandFiles = @($tracked | Where-Object { $_ -in @('nendo.png', 'nendo.mp4') })
    if ($rootBrandFiles.Count -gt 0) {
        throw "Brand binaries must live under docs/assets/brand/: $($rootBrandFiles -join ', ')"
    }

    $sourceLikeFiles = @(
        $tracked | Where-Object {
            $_ -notmatch '^(docs/|\.agents/skills/)' -and
            $_ -match '\.(json|js|jsx|ts|tsx|mjs|cjs|cs|csproj|props|targets|xml|yaml|yml)$'
        }
    )
    $enterpriseToken = 'ag-grid-' + 'enterprise'
    foreach ($path in $sourceLikeFiles) {
        $fullPath = Join-Path $repoRoot $path
        $text = [IO.File]::ReadAllText($fullPath)
        if ($text.IndexOf($enterpriseToken, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            throw "Commercial AG Grid dependency/reference detected in implementation file: $path"
        }
    }
    Write-Host "Verified $($tracked.Count) tracked path(s)."

    # Everything above counts binaries and places them; nothing above opens one.
    # `attr/-text` excuses a file from every content check this gate runs, which is
    # how corrupted image assets passed it (W-019).
    Write-Host '== Binary assets =='
    & (Join-Path $PSScriptRoot 'Test-BinaryAssets.ps1')

    Write-Host '== Line endings =='
    # The repository is eol=lf. A CRLF working copy passes git, which normalises on
    # add, and then fails this gate's (?m)^...$ checks on a line nobody touched, so
    # the endings are refused by file name here, before any check that would
    # misreport them. Binary paths carry attr/-text and are not text.
    $eolRows = @(& git -c "safe.directory=$gitSafeRoot" -C $repoRoot ls-files --eol)
    if ($LASTEXITCODE -ne 0) {
        throw 'git ls-files --eol failed.'
    }
    $wrongEndings = @(
        $eolRows |
            Where-Object { $_ -match '\s(i|w)/(crlf|mixed)\s' -and $_ -match '\sattr/text' } |
            ForEach-Object { ($_ -split "`t", 2)[1] }
    )
    if ($wrongEndings.Count -gt 0) {
        throw "Tracked text file(s) with CRLF or mixed line endings; the repository is eol=lf. Rewrite each to LF by replacing the bytes \r\n with \n (see AGENTS.md, Files and line endings):`n$($wrongEndings -join "`n")"
    }
    Write-Host "OK       $($eolRows.Count) tracked path(s) end their lines with LF."

    Write-Host '== ADR structure =='
    $adrFiles = @(
        Get-ChildItem -LiteralPath (Join-Path $repoRoot 'docs/decisions') -File -Filter '*.md' |
            Where-Object { $_.Name -notin @('README.md', 'template.md') }
    )
    $seenNumbers = @{}
    foreach ($file in $adrFiles) {
        $text = Get-Content -LiteralPath $file.FullName -Raw
        $heading = [regex]::Match($text, '(?m)^# ADR-(\d{4}): .+$')
        if (-not $heading.Success) {
            throw "ADR heading is missing or malformed: $($file.Name)"
        }

        $number = $heading.Groups[1].Value
        if ($seenNumbers.ContainsKey($number)) {
            throw "Duplicate top-level ADR number $number in $($seenNumbers[$number]) and $($file.Name)."
        }
        $seenNumbers[$number] = $file.Name

        Assert-Match $text '(?m)^- \*\*Status:\*\* (Proposed|Accepted|Rejected|Deferred|Superseded)$' "ADR Status is missing or invalid: $($file.Name)"
        Assert-Match $text '(?m)^- \*\*Date:\*\* \d{4}-\d{2}-\d{2}$' "ADR Date is missing or invalid: $($file.Name)"
        Assert-Match $text '(?m)^- \*\*Owners:\*\* .+$' "ADR Owners is missing: $($file.Name)"
        Assert-Match $text '(?m)^- \*\*Confidence:\*\* (Low|Medium|High|Medium-low)$' "ADR Confidence is missing or invalid: $($file.Name)"
        Assert-Match $text '(?m)^- \*\*Evidence:\*\* .+$' "ADR Evidence is missing: $($file.Name)"
        Write-Host "OK       $($file.Name)"
    }

    foreach ($requiredNumber in @('0000', '0015', '0016')) {
        if (-not $seenNumbers.ContainsKey($requiredNumber)) {
            throw "Required ADR $requiredNumber is missing."
        }
    }

    Write-Host '== Blackbox review coverage =='
    # The blackbox prompt is the only lane that measures what the interface teaches an
    # outside client. A contract it never reaches is a feature a review passes over in
    # silence, so every published contract has to be accounted for in the coverage table.
    $promptPath = Join-Path $repoRoot 'docs/reviews/blackbox-prompt.md'
    $coveragePath = Join-Path $repoRoot 'docs/reviews/README.md'
    foreach ($required in @($promptPath, $coveragePath)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
            throw "The blackbox review lane is missing a file: $required"
        }
    }

    $promptText = Get-Content -LiteralPath $promptPath -Raw
    $coverageText = Get-Content -LiteralPath $coveragePath -Raw

    $contractFiles = @(
        Get-ChildItem -LiteralPath (Join-Path $repoRoot 'docs/contracts') -File -Filter '*.md' |
            Where-Object { $_.Name -ne 'README.md' }
    )
    foreach ($contract in $contractFiles) {
        if ($coverageText -notmatch [regex]::Escape("../contracts/$($contract.Name)")) {
            throw "docs/reviews/README.md does not say how the blackbox prompt reaches $($contract.Name). Add a coverage row — including one that says the contract is person-owned or out of scope, with the reason."
        }
    }

    $phases = @(
        [regex]::Matches($coverageText, 'Phase (\d+)') |
            ForEach-Object { $_.Groups[1].Value } |
            Sort-Object -Unique
    )
    if ($phases.Count -eq 0) {
        throw 'docs/reviews/README.md names no prompt phase; the coverage table cannot be checked.'
    }
    foreach ($phase in $phases) {
        Assert-Match $promptText "(?m)^## Phase $phase — " "docs/reviews/README.md maps a contract onto Phase $phase, which docs/reviews/blackbox-prompt.md does not contain."
    }
    Write-Host "OK       $($contractFiles.Count) contract(s) across $($phases.Count) prompt phase(s)."

    Write-Host '== Shell identity =='
    # The application names itself to Windows in C# and setup registers that name in
    # PowerShell. Neither can see the other, and the failure when they drift is silent:
    # the taskbar groups on one identity, the Jump List and the notification display
    # name are filed under the other, and everything still starts. Checked here because
    # this is the only lane that reads both files.
    $identityInCode = [regex]::Match(
        (Get-Content -LiteralPath (Join-Path $repoRoot 'src/Nendo.Desktop/DesktopShellIdentity.cs') -Raw),
        'DefaultAppUserModelId\s*=\s*"([^"]+)"')
    $identityInSetup = [regex]::Match(
        (Get-Content -LiteralPath (Join-Path $repoRoot 'tools/Invoke-NendoSetup.ps1') -Raw),
        "(?m)^\`$appUserModelId\s*=\s*'([^']+)'")
    if (-not $identityInCode.Success) { throw 'DesktopShellIdentity.cs declares no DefaultAppUserModelId.' }
    if (-not $identityInSetup.Success) { throw 'Invoke-NendoSetup.ps1 declares no $appUserModelId.' }
    if ($identityInCode.Groups[1].Value -ne $identityInSetup.Groups[1].Value) {
        throw ("The application names itself '{0}' but setup registers '{1}'. Windows would group the taskbar on one and file the Jump List under the other." -f
            $identityInCode.Groups[1].Value, $identityInSetup.Groups[1].Value)
    }
    Write-Host "OK       the application and setup agree on $($identityInCode.Groups[1].Value)"

    Write-Host 'Repository verification passed.'
}
finally {
    Pop-Location
}
