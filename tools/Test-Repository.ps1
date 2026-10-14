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
    # A tracked source file deleted and not yet staged stopped this loop with a bare "Could not
    # find file"; it is named with its remedy instead, as the binary check names one (BL-04).
    $deleted = @($sourceLikeFiles | Where-Object { -not (Test-Path -LiteralPath (Join-Path $repoRoot $_) -PathType Leaf) })
    if ($deleted.Count -gt 0) {
        throw "Tracked file(s) deleted from the working tree. Stage the deletion (git rm <path>) or restore the file (git restore <path>):`n$($deleted -join "`n")"
    }
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

    # AGENTS.md says UTF-8 without a BOM, and eight template-generated files kept the
    # EF BB BF prefix because nothing here looked for it (BL-07).
    $textPaths = @(
        $eolRows |
            Where-Object { $_ -match '\sattr/text' } |
            ForEach-Object { ($_ -split "`t", 2)[1] }
    )
    $withBom = [Collections.Generic.List[string]]::new()
    $head = [byte[]]::new(3)
    foreach ($path in $textPaths) {
        $fullPath = Join-Path $repoRoot $path
        if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { continue }
        $stream = [IO.File]::OpenRead($fullPath)
        try { $count = $stream.Read($head, 0, 3) } finally { $stream.Dispose() }
        if ($count -eq 3 -and $head[0] -eq 0xEF -and $head[1] -eq 0xBB -and $head[2] -eq 0xBF) {
            $withBom.Add($path)
        }
    }
    if ($withBom.Count -gt 0) {
        throw "Tracked text file(s) start with a UTF-8 byte order mark; the repository is UTF-8 without one. Remove the first three bytes (EF BB BF) of each (see AGENTS.md, Files and line endings):`n$($withBom -join "`n")"
    }
    Write-Host "OK       $($textPaths.Count) tracked text path(s) carry no byte order mark."

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

    Write-Host '== MCP surface count =='
    # The contract opens by counting the resources and tools an agent sees, and the
    # sentence drifted when a tool arrived without it moving (W-144). The count is read
    # from the same declarations Test-Production.ps1 pins by name.
    # Get-ChildItem returns backslash paths, and '[\/]' in a .NET pattern is a class of
    # one slash, so the exclusion matched nothing on Windows. The pattern is tried on a
    # Windows path first, so a slip of that kind stops here rather than counting
    # generated sources the day an obj folder appears.
    $generatedOutput = '[\\/](?:bin|obj)[\\/]'
    if ('C:\x\src\Nendo.LocalMcp\obj\Debug\Generated.cs' -notmatch $generatedOutput) { throw "The bin/obj exclusion does not match a Windows path: $generatedOutput" }
    $mcpSource = (Get-ChildItem -LiteralPath (Join-Path $repoRoot 'src/Nendo.LocalMcp') -Recurse -File -Filter '*.cs' |
        Where-Object { $_.FullName -notmatch $generatedOutput } |
        ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw }) -join "`n"
    $mcpNames = @([regex]::Matches($mcpSource, 'Name\s*=\s*"(nendo\.[^"]+)"') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
    $mcpResourceCount = @($mcpNames | Where-Object { $_.StartsWith('nendo.application.') -or $_.StartsWith('nendo.host.') }).Count
    $mcpToolCount = $mcpNames.Count - $mcpResourceCount
    $contractText = Get-Content -LiteralPath (Join-Path $repoRoot 'docs/contracts/mcp-interface.md') -Raw
    $counted = [regex]::Match($contractText, '(?s)This contract lists the ([a-z-]+) resources and ([a-z-]+) tools')
    if (-not $counted.Success) { throw 'docs/contracts/mcp-interface.md no longer opens by counting its resources and tools.' }
    $numberWords = @{ 'ten' = 10; 'eleven' = 11; 'twelve' = 12; 'thirteen' = 13; 'fourteen' = 14; 'fifteen' = 15; 'sixteen' = 16; 'seventeen' = 17; 'eighteen' = 18; 'nineteen' = 19; 'twenty' = 20; 'twenty-one' = 21; 'twenty-two' = 22; 'twenty-three' = 23; 'twenty-four' = 24; 'twenty-five' = 25; 'twenty-six' = 26; 'twenty-seven' = 27; 'twenty-eight' = 28; 'twenty-nine' = 29; 'thirty' = 30 }
    foreach ($word in @($counted.Groups[1].Value, $counted.Groups[2].Value)) {
        if (-not $numberWords.ContainsKey($word)) { throw "docs/contracts/mcp-interface.md counts '$word', which this check cannot read; use a number word from ten to thirty." }
    }
    if ($numberWords[$counted.Groups[1].Value] -ne $mcpResourceCount -or $numberWords[$counted.Groups[2].Value] -ne $mcpToolCount) {
        throw ("docs/contracts/mcp-interface.md says {0} resources and {1} tools; src/Nendo.LocalMcp declares {2} and {3}. Move the opening sentence with the surface." -f
            $counted.Groups[1].Value, $counted.Groups[2].Value, $mcpResourceCount, $mcpToolCount)
    }
    Write-Host "OK       the contract counts $mcpResourceCount resources and $mcpToolCount tools, as declared"
    # The outsiders' guide counted resources by hand and fell one behind (review R-016).
    foreach ($guide in @(Get-ChildItem -LiteralPath (Join-Path $repoRoot 'site/src/content/docs') -Filter '*.md' -File)) {
        foreach ($match in [regex]::Matches((Get-Content -LiteralPath $guide.FullName -Raw), '(?i)\bthe (\d+) resources\b')) {
            if ([int]$match.Groups[1].Value -ne $mcpResourceCount) {
                throw ("site/src/content/docs/{0} says '{1}'; src/Nendo.LocalMcp declares {2} resources." -f $guide.Name, $match.Value, $mcpResourceCount)
            }
        }
    }
    Write-Host "OK       the site guides count $mcpResourceCount resources where they count them"

    Write-Host '== Documents that state the code =='
    # The broad review found contracts restating a number or a list the code had moved past
    # (W-222). Each check below reads the declaration and the sentence that restates it.

    # DOC-02: the host-version ladder. architecture.md names the highest rung, and
    # semantic-surfaces.md places every rung above 1.11 either in its node-shape table or in
    # the sentence that lists the rest; a rung added to NendoFormat.cs without either drifted.
    $formatText = Get-Content -LiteralPath (Join-Path $repoRoot 'src/Nendo.Engine/NendoFormat.cs') -Raw
    $currentName = [regex]::Match($formatText, 'CurrentHostVersion\s*=\s*(\w+)\s*;')
    if (-not $currentName.Success) { throw 'NendoFormat.cs no longer sets CurrentHostVersion from a named rung.' }
    $currentValue = [regex]::Match($formatText, "const string $($currentName.Groups[1].Value)\s*=\s*`"(\d+\.\d+\.\d+)`"")
    if (-not $currentValue.Success) { throw "NendoFormat.cs names $($currentName.Groups[1].Value) as the current host version but declares no value for it." }
    $currentHost = $currentValue.Groups[1].Value
    $architectureText = Get-Content -LiteralPath (Join-Path $repoRoot 'docs/architecture.md') -Raw
    $statedHighest = [regex]::Match($architectureText, 'The highest version\s+is\s+`(\d+\.\d+\.\d+)`')
    if (-not $statedHighest.Success) { throw 'docs/architecture.md no longer says "The highest version is `x.y.z`" in its host-version ladder.' }
    if ($statedHighest.Groups[1].Value -ne $currentHost) {
        throw ("docs/architecture.md says the highest host version is {0}; NendoFormat.CurrentHostVersion is {1}. Add the new rung to the ladder paragraph." -f $statedHighest.Groups[1].Value, $currentHost)
    }
    $surfacesText = Get-Content -LiteralPath (Join-Path $repoRoot 'docs/contracts/semantic-surfaces.md') -Raw
    $shapeTable = [regex]::Match($surfacesText, '(?s)\| Feature \| Minimum host \|\s*\n\| --- \| --- \|\s*\n(.+?)\n\s*\n')
    if (-not $shapeTable.Success) { throw 'docs/contracts/semantic-surfaces.md no longer has its node-shape table (| Feature | Minimum host |).' }
    $tableRungs = @([regex]::Matches($shapeTable.Groups[1].Value, '(?m)^\|.*\|\s*(1\.\d+)\s*\|\s*$') | ForEach-Object { $_.Groups[1].Value })
    $restSentence = [regex]::Match($surfacesText, '(?s)Every rung above 1\.11 that is not in the table is not a shape of the node tree:(.+?)\(`NendoFormat`\)')
    if (-not $restSentence.Success) { throw 'docs/contracts/semantic-surfaces.md no longer lists the rungs above 1.11 that are not node shapes.' }
    $listedRungs = @([regex]::Matches($restSentence.Groups[1].Value, '\b1\.\d+\b') | ForEach-Object { $_.Value })
    $declaredRungs = @([regex]::Matches($formatText, 'const string \w+\s*=\s*"1\.(\d+)\.0"') |
        ForEach-Object { [int]$_.Groups[1].Value } | Where-Object { $_ -gt 11 } | Sort-Object -Unique | ForEach-Object { "1.$_" })
    # A floor, so a change in how the constants or the table are written cannot pass by reading nothing.
    if ($declaredRungs.Count -lt 30 -or $tableRungs.Count -lt 10) {
        throw "Read only $($declaredRungs.Count) rungs above 1.11 from NendoFormat.cs and $($tableRungs.Count) from the node-shape table; the patterns no longer fit what they read."
    }
    $unplaced = @($declaredRungs | Where-Object { $_ -notin $tableRungs -and $_ -notin $listedRungs })
    if ($unplaced.Count -gt 0) {
        throw "docs/contracts/semantic-surfaces.md places no host rung $($unplaced -join ', ') from NendoFormat.cs: add it to the node-shape table or to the sentence listing the other rungs."
    }
    Write-Host "OK       the ladder reaches $currentHost in architecture.md, and semantic-surfaces.md places all $($declaredRungs.Count) rungs above 1.11"

    # DOC-11: every precondition code the MCP adapter lets through whole is named in the
    # contract's list, by itself or by a family written as `prefix-*`.
    $errorsText = Get-Content -LiteralPath (Join-Path $repoRoot 'src/Nendo.LocalMcp/NendoToolErrors.cs') -Raw
    $auditedBlock = [regex]::Match($errorsText, '(?s)HashSet<string>\s+DiagnosablePreconditions\s*=\s*new\(\[(.+?)\],\s*StringComparer')
    if (-not $auditedBlock.Success) { throw 'NendoToolErrors.cs no longer declares DiagnosablePreconditions as a list this check can read.' }
    $auditedBody = [regex]::Replace($auditedBlock.Groups[1].Value, '(?m)//.*$', '')
    $auditedCodes = @([regex]::Matches($auditedBody, '"([a-z0-9-]+)"') | ForEach-Object { $_.Groups[1].Value })
    if ($auditedCodes.Count -lt 20) { throw "Only $($auditedCodes.Count) codes were read from DiagnosablePreconditions; the pattern no longer fits the declaration." }
    $refusalSection = [regex]::Match($contractText, '(?s)## What a refusal says(.+?)(?=\n## |\z)')
    if (-not $refusalSection.Success) { throw 'docs/contracts/mcp-interface.md has no section "What a refusal says".' }
    $named = @([regex]::Matches($refusalSection.Groups[1].Value, '`([a-z0-9-]+\*?)`') | ForEach-Object { $_.Groups[1].Value })
    $families = @($named | Where-Object { $_.EndsWith('-*') } | ForEach-Object { $_.TrimEnd('*') })
    $unnamed = @($auditedCodes | Where-Object { $code = $_; $code -notin $named -and -not ($families | Where-Object { $code.StartsWith($_) }) })
    if ($unnamed.Count -gt 0) {
        throw "docs/contracts/mcp-interface.md ('What a refusal says') does not name these codes NendoToolErrors.DiagnosablePreconditions lets through: $($unnamed -join ', ')"
    }
    Write-Host "OK       the contract names all $($auditedCodes.Count) precondition codes the MCP adapter lets through"

    # DOC-04: the layout ladder only grows, so a contract that calls a table "the last rung"
    # is wrong the day the next rung lands. Name the rung and its neighbour instead; a dated
    # ADR may still say "a new last rung".
    $lastRung = @(Get-ChildItem -LiteralPath (Join-Path $repoRoot 'docs/contracts') -Filter '*.md' -File |
        Where-Object { [IO.File]::ReadAllText($_.FullName) -match '(?<![-\w])last\s+rung' } | ForEach-Object Name)
    if ($lastRung.Count -gt 0) {
        throw "These contracts call a table the last rung of the layout ladder; name its rung and the one before it instead: $($lastRung -join ', ')"
    }
    Write-Host 'OK       no contract calls a table the last rung of the layout ladder'

    # BL-06: the README said a fresh clone's dotnet build succeeds without the Workbench while
    # Nendo.LocalMcp refuses to build without its view-api.json, and six documents said the
    # gate takes about a minute when the .NET suites alone take several.
    $localMcpProject = Get-Content -LiteralPath (Join-Path $repoRoot 'src/Nendo.LocalMcp/Nendo.LocalMcp.csproj') -Raw
    $readmeText = Get-Content -LiteralPath (Join-Path $repoRoot 'README.md') -Raw
    if ($localMcpProject -match 'RequireViewApiReference' -and $readmeText -match '(?s)fresh\s+clone\s+succeeds') {
        throw 'README.md says dotnet build on a fresh clone succeeds, but Nendo.LocalMcp.csproj stops the build until the Workbench is built (RequireViewApiReference).'
    }
    $minuteClaims = @('README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'docs/architecture.md', 'docs/decisions/0018-public-website-and-deployment-lane.md', 'site/src/content/docs/getting-started.md' |
        Where-Object { (Get-Content -LiteralPath (Join-Path $repoRoot $_) -Raw) -match '(?s)about\s+a\s+minute' })
    if ($minuteClaims.Count -gt 0) {
        throw "These documents say the gate or the suite runs in about a minute; it takes several: $($minuteClaims -join ', ')"
    }
    Write-Host 'OK       the README and the guides state what a fresh build needs and how long the gate takes'

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

    Write-Host '== Publish trimming =='
    # The shipped payload is published untrimmed, and the host depends on it: its bridge and
    # device stores serialise JSON by reflection and its taskbar and Jump List use COM interop,
    # both of which trimming switches off. The project file used to trim every Release publish
    # that the pipeline did not override, so a plain 'dotnet publish -c Release' made a host
    # that ended on its first bridge response (DSH-18). Every setting in the project file has
    # to say what the pipeline passes.
    $projectTrimming = @([regex]::Matches(
        (Get-Content -LiteralPath (Join-Path $repoRoot 'src/Nendo.Desktop/Nendo.Desktop.csproj') -Raw),
        '<PublishTrimmed(?:\s[^>]*)?>\s*([^<]+?)\s*</PublishTrimmed>') | ForEach-Object { $_.Groups[1].Value })
    $pipelineTrimming = [regex]::Match(
        (Get-Content -LiteralPath (Join-Path $repoRoot 'tools/Publish-NendoPayload.ps1') -Raw),
        '-p:PublishTrimmed=(\w+)')
    if (-not $pipelineTrimming.Success) { throw 'Publish-NendoPayload.ps1 no longer says whether it trims (-p:PublishTrimmed=...).' }
    if ($projectTrimming.Count -eq 0) { throw 'Nendo.Desktop.csproj does not say whether it trims; a Release publish would follow the SDK default.' }
    $disagreeing = @($projectTrimming | Where-Object { $_ -ne $pipelineTrimming.Groups[1].Value })
    if ($disagreeing.Count -ne 0) {
        throw ("Nendo.Desktop.csproj sets PublishTrimmed to {0}, but Publish-NendoPayload.ps1 publishes with {1}. A publish outside the pipeline would make a different host." -f
            ($projectTrimming -join ', '), $pipelineTrimming.Groups[1].Value)
    }
    Write-Host "OK       the project and the payload pipeline agree on PublishTrimmed=$($pipelineTrimming.Groups[1].Value)"

    Write-Host '== No archive of build records =='
    # artifacts/ is scratch, and AGENTS.md says not to archive run outputs there. The
    # payload publish copied every earlier build's records into a folder that only grew
    # (TBI-16). The folder's name is assembled here so this check does not find itself.
    $archiveName = 'evidence' + '[\\/]' + 'installers'
    $archivers = @(Get-ChildItem -LiteralPath (Join-Path $repoRoot 'tools') -File |
        Where-Object { $_.Extension -in @('.ps1', '.mjs') -and [IO.File]::ReadAllText($_.FullName) -match $archiveName })
    if ($archivers.Count -gt 0) {
        throw "A tool archives build records under artifacts/evidence, which the repository rules out: $(($archivers | ForEach-Object { $_.Name }) -join ', ')"
    }
    Write-Host 'OK       no tool archives build records under artifacts/'

    Write-Host '== Native lane teardown =='
    # A lane whose window would not close threw from its finally block, which replaced the
    # failure on its way out and left the process running (TGA-05). The shared teardown is
    # run here against a stand-in for a stuck window, and no lane may close a host its own way.
    . (Join-Path $PSScriptRoot 'Lane-NativeHost.ps1')
    function New-StuckWindow {
        $stuck = [pscustomobject]@{ Id = 4242; HasExited = $false; Killed = $false }
        $stuck | Add-Member -MemberType ScriptMethod -Name CloseMainWindow -Value { $false }
        $stuck | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param($milliseconds) $false }
        $stuck | Add-Member -MemberType ScriptMethod -Name Kill -Value { param($tree) $this.Killed = $true }
        return $stuck
    }
    $failedLane = New-StuckWindow
    try { Stop-OwnedNendo $failedLane $false 3> $null } catch { throw "The native teardown threw after a failed lane, which hides that lane's own failure: $($_.Exception.Message)" }
    if (-not $failedLane.Killed) { throw 'The native teardown left a window that would not close running.' }
    $passedLane = New-StuckWindow
    $reported = $false
    try { Stop-OwnedNendo $passedLane $true 3> $null } catch { $reported = $true }
    if (-not $reported -or -not $passedLane.Killed) { throw 'The native teardown let a lane pass whose window would not close, or left it running.' }
    $ownTeardown = @(Get-ChildItem -LiteralPath (Join-Path $repoRoot 'tools') -File -Filter '*.ps1' |
        Where-Object { $_.Name -ne 'Lane-NativeHost.ps1' -and [IO.File]::ReadAllText($_.FullName) -match 'CloseMainWindow\(\)\s+-or' })
    if ($ownTeardown.Count -gt 0) { throw "These lanes close their host their own way; use Stop-OwnedNendo from Lane-NativeHost.ps1: $(($ownTeardown | ForEach-Object Name) -join ', ')" }
    Write-Host 'OK       a stuck window is stopped without hiding the failure, and every lane closes its host that way'
    # The owner-state check those lanes make, against a stand-in device folder: the owner's
    # own Nendo opening a file (a new port, a moved timestamp) is not the lane's doing; a
    # port kept for the lane's own file, or a changed theme, is.
    $standIn = Join-Path ([IO.Path]::GetTempPath()) ('nendo-owner-state-' + [Guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($standIn)
    try {
        $writePorts = { param($entries) @{ Version = 1; Files = $entries } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $standIn 'agent-ports.json') }
        Set-Content -LiteralPath (Join-Path $standIn 'appearance.json') -Value '{"Version":1,"Preference":"system"}'
        & $writePorts @{ 'application-a' = @{ Port = 41766; Name = 'Planner.nendo'; UsedAt = '2026-10-13T08:00:00Z' } }
        $ownerBefore = Get-OwnerDeviceSnapshot $standIn
        & $writePorts @{ 'application-a' = @{ Port = 41766; Name = 'Planner.nendo'; UsedAt = '2026-10-13T09:00:00Z' }; 'application-b' = @{ Port = 41767; Name = 'Notes.nendo'; UsedAt = '2026-10-13T09:00:00Z' } }
        try { Assert-OwnerDeviceUnchanged $ownerBefore @('pilot.nendo') 'Stand-in lane' } catch { throw "The owner-state check blamed a lane for the owner opening a file: $($_.Exception.Message)" }
        & $writePorts @{ 'application-a' = @{ Port = 41766; Name = 'Planner.nendo'; UsedAt = '2026-10-13T09:00:00Z' }; 'application-c' = @{ Port = 41768; Name = 'pilot.nendo'; UsedAt = '2026-10-13T09:00:00Z' } }
        $caught = $false
        try { Assert-OwnerDeviceUnchanged $ownerBefore @('pilot.nendo') 'Stand-in lane' } catch { $caught = $true }
        if (-not $caught) { throw "The owner-state check missed a port kept for the lane's own file." }
        & $writePorts @{ 'application-a' = @{ Port = 41766; Name = 'Planner.nendo'; UsedAt = '2026-10-13T08:00:00Z' } }
        Set-Content -LiteralPath (Join-Path $standIn 'appearance.json') -Value '{"Version":1,"Preference":"dark"}'
        $caught = $false
        try { Assert-OwnerDeviceUnchanged $ownerBefore @('pilot.nendo') 'Stand-in lane' } catch { $caught = $true }
        if (-not $caught) { throw "The owner-state check missed a changed theme." }
    } finally { Remove-Item -LiteralPath $standIn -Recurse -Force -ErrorAction SilentlyContinue }
    Write-Host "OK       the lanes' owner-state check finds their own traces and ignores the owner's use of Nendo"

    Write-Host 'Repository verification passed.'
}
finally {
    Pop-Location
}
