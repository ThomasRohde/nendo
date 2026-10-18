[CmdletBinding()]
param(
    [switch] $SkipRestore,
    # W-158: the opt-in lanes. -Inspector runs the reference Inspector's tools/list against a
    # host (needs @modelcontextprotocol/inspector where npx finds it); -Soak renews a lease
    # under expiry and fills the proposal cap twice. Without them those tests report
    # Inconclusive, never a pass.
    [switch] $Inspector,
    [switch] $Soak
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workbenchRoot = Join-Path $repoRoot 'src\Nendo.Workbench'

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string] $FilePath,
        [Parameter(Mandatory = $true)][string[]] $Arguments,
        [Parameter(Mandatory = $true)][string] $Description
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE."
    }
}

function Get-NpmCommand {
    $nodes = @(Get-Command node -CommandType Application -All -ErrorAction Stop)
    foreach ($node in $nodes) {
        $nodeDirectory = Split-Path -Parent $node.Source
        $bundledNpmCli = Join-Path $nodeDirectory 'node_modules\npm\bin\npm-cli.js'

        if (Test-Path -LiteralPath $bundledNpmCli -PathType Leaf) {
            return @{
                FilePath = [string] $node.Source
                Prefix = @($bundledNpmCli)
            }
        }
    }

    $npm = @(Get-Command npm -CommandType Application -All -ErrorAction Stop)[0]
    return @{
        FilePath = [string] $npm.Source
        Prefix = @()
    }
}

function Invoke-Npm {
    param(
        [Parameter(Mandatory = $true)][hashtable] $Command,
        [Parameter(Mandatory = $true)][string[]] $Arguments,
        [Parameter(Mandatory = $true)][string] $Description
    )

    $allArguments = @($Command.Prefix) + $Arguments
    Invoke-Checked -FilePath $Command.FilePath -Arguments $allArguments -Description $Description
}

# Where this run has got to, in artifacts/gate-progress.json, for anything that shows it while it
# runs (GateProgress.psm1). The steps are planned here, in the order they run below.
Import-Module (Join-Path $PSScriptRoot 'GateProgress.psm1') -Force
$plannedSteps = @(
    if (-not $SkipRestore) { , @('workbench.restore', 'Workbench restore') }
    , @('workbench.check', 'Workbench type check')
    , @('workbench.test', 'Workbench tests')
    , @('workbench.dependencies', 'Workbench dependencies')
    , @('workbench.build', 'Workbench build')
    if (-not $SkipRestore) { , @('dotnet.restore', '.NET restore') }
    , @('dotnet.build', '.NET build')
    , @('dotnet.Nendo.Engine.Tests', 'Engine tests')
    , @('dotnet.Nendo.LocalMcp.Tests', 'MCP tests')
    , @('dotnet.Nendo.Desktop.Tests', 'Desktop tests')
    , @('tool-boundaries', 'Tool boundaries')
    , @('production-boundaries', 'Production boundaries')
    , @('view.graph', 'Graph view')
    , @('view.work-dependencies', 'Work dependencies view')
    , @('view.systems-lens', 'Systems Lens')
    , @('view.gantt', 'Gantt')
    , @('view.capability-atlas', 'Capability Atlas')
    , @('view.archi', 'Archi workbench')
    , @('view.swarm', 'Swarm')
    , @('view.garden', 'Garden')
    , @('view.manuscript', 'Manuscript')
    , @('agent-chat', 'Agent conversation')
    , @('workbench-shell', 'Workbench shell')
    , @('repository', 'Repository')
)
Start-GateProgress -Path (Join-Path $repoRoot 'artifacts/gate-progress.json') -Steps $plannedSteps `
    -TimingsPath (Join-Path $repoRoot 'artifacts/gate-timings.json')

Push-Location $repoRoot
try {
    Write-Host '== Workbench =='
    $npmCommand = Get-NpmCommand
    Push-Location $workbenchRoot
    try {
        if (-not $SkipRestore) {
            Enter-GateStep 'workbench.restore'
            Invoke-Npm $npmCommand @('ci') 'Workbench restore'
        }
        Enter-GateStep 'workbench.check'
        Invoke-Npm $npmCommand @('run', 'check') 'Workbench type check'
        Enter-GateStep 'workbench.test'
        Invoke-Npm $npmCommand @('test') 'Workbench behavior tests'
        Enter-GateStep 'workbench.dependencies'
        Invoke-Npm $npmCommand @('run', 'verify:dependencies') 'Workbench dependency verification'
        Enter-GateStep 'workbench.build'
        Invoke-Npm $npmCommand @('run', 'build') 'Workbench build'
    }
    finally {
        Pop-Location
    }

    Write-Host '== .NET =='
    if (-not $SkipRestore) {
        Enter-GateStep 'dotnet.restore'
        Invoke-Checked 'dotnet' @('restore', 'Nendo.slnx', '--nologo') '.NET restore'
    }
    Enter-GateStep 'dotnet.build'
    Invoke-Checked 'dotnet' @('build', 'Nendo.slnx', '--no-restore', '--nologo') '.NET build'
    if ($Inspector) { $env:NENDO_RUN_INSPECTOR = '1' }
    if ($Soak) { $env:NENDO_RUN_SOAK = '1' }
    # One suite at a time (TST-02). Run together, the three suites' parallel methods each start
    # hosts, children and files at once, and a fresh MCP host's first answer queued behind them
    # past its client's bound: "Initialization timed out" on 2026-10-05, 2026-10-10 and
    # 2026-10-12, never with a suite alone. Each suite still runs its own methods in parallel.
    # A failing suite does not stop the next, so one run still reports all three.
    # Each suite's TRX goes under artifacts/test-results and is kept only when the suite failed.
    # Without a results directory every run wrote one into tests/<suite>/TestResults, which
    # nothing read or removed: 467 MB from 285 runs (BL-05).
    $failedSuites = @()
    $testResults = Join-Path $repoRoot "artifacts/test-results/$([DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'))"
    foreach ($suite in @('Nendo.Engine.Tests', 'Nendo.LocalMcp.Tests', 'Nendo.Desktop.Tests')) {
        $project = Join-Path $repoRoot "tests/$suite/$suite.csproj"
        $suiteResults = Join-Path $testResults $suite
        Enter-GateStep "dotnet.$suite"
        & dotnet test $project --no-build --no-restore --nologo --logger trx --results-directory $suiteResults
        if ($LASTEXITCODE -ne 0) { $failedSuites += $suite; Write-Host "Test results kept: $suiteResults" }
        else { Remove-Item -LiteralPath $suiteResults -Recurse -Force -ErrorAction SilentlyContinue }
    }
    if ($failedSuites.Count -eq 0) { Remove-Item -LiteralPath $testResults -Recurse -Force -ErrorAction SilentlyContinue }
    if ($failedSuites.Count -gt 0) { throw ".NET tests failed in $($failedSuites -join ', ')." }

    Write-Host '== Tool boundaries =='
    Enter-GateStep 'tool-boundaries'
    Invoke-Checked 'node' @('--test', (Join-Path $PSScriptRoot 'put-package.test.mjs'), (Join-Path $PSScriptRoot 'clipboard-probe.test.mjs'), (Join-Path $PSScriptRoot 'info-file.test.mjs'), (Join-Path $PSScriptRoot 'gate-progress.test.mjs')) 'Package uploader, clipboard probe, fixture address file and gate progress boundaries'

    Write-Host '== Production boundaries =='
    Enter-GateStep 'production-boundaries'
    & (Join-Path $PSScriptRoot 'Test-ApplicationNeutrality.ps1')

    # The output this gate built and its tests ran against, not any output: a Release or
    # an older build's Workbench satisfied the search this replaced. And the bundle this
    # gate just built, compared by bytes, since a copy step that stopped copying leaves
    # the previous bundle in place.
    $bundledEntryPoint = Join-Path $repoRoot 'artifacts\bin\Nendo.Desktop\debug_win-x64\Workbench\index.html'
    $builtEntryPoint = Join-Path $workbenchRoot 'dist\index.html'
    if (-not (Test-Path -LiteralPath $bundledEntryPoint -PathType Leaf)) {
        throw "The Debug Desktop output this gate built does not contain Workbench/index.html: $bundledEntryPoint"
    }
    if ((Get-FileHash -LiteralPath $bundledEntryPoint).Hash -ne (Get-FileHash -LiteralPath $builtEntryPoint).Hash) {
        throw "The Debug Desktop output carries a different Workbench from the one this gate built: $bundledEntryPoint differs from $builtEntryPoint"
    }
    Write-Host 'OK       the Debug Desktop output carries the Workbench this gate built'

    $adapterFiles = @(
        foreach ($adapterRoot in @('src\Nendo.Desktop', 'src\Nendo.LocalMcp')) {
            Get-ChildItem -LiteralPath (Join-Path $repoRoot $adapterRoot) -Recurse -File |
                Where-Object {
                    $_.Extension -in @('.cs', '.csproj', '.xaml') -and
                    $_.FullName -notmatch '[\\/](?:bin|obj)[\\/]'
                }
        }
    )
    $forbiddenStoragePattern = '(?i)Microsoft\.Data\.Sqlite|SQLiteConnection|SqliteConnection|SQLitePCL'
    foreach ($file in $adapterFiles) {
        $text = [IO.File]::ReadAllText($file.FullName)
        if ($text -match $forbiddenStoragePattern) {
            throw "SQLite escaped the Engine boundary: $($file.FullName)"
        }
    }
    Write-Host "OK       Desktop and local MCP storage boundary ($($adapterFiles.Count) source files)"

    # ADR-0013. Custom views run as frames of the Workbench's own browser, served from the open
    # file. The contained helper is gone, and a filter that answered every address would stop
    # views reaching the network the decision gives them.
    if (Test-Path -LiteralPath (Join-Path $repoRoot 'src/Nendo.ExtensionHost')) {
        throw 'src/Nendo.ExtensionHost is back. Custom views run inside the Workbench under ADR-0013.'
    }
    foreach ($file in @($adapterFiles | Where-Object { $_.FullName -like '*Nendo.Desktop*' })) {
        if ([IO.File]::ReadAllText($file.FullName) -match 'AddWebResourceRequestedFilter\(\s*"\*"') {
            throw "A catch-all resource filter would answer every address a view asks for: $($file.FullName)"
        }
    }
    Write-Host 'OK       custom views run in the Workbench browser, with no helper and no catch-all filter'

    # A view reaches the file only through window.nendo. chrome.webview exists inside a view's
    # frame (prototypes/iframe-views/FINDINGS.md, S8) and answers nothing, so a package that
    # names it is a package written for the retired helper.
    $packageSources = @(
        Get-ChildItem -LiteralPath (Join-Path $repoRoot 'extensions') -Recurse -File |
            Where-Object { $_.Extension -in @('.js', '.mjs', '.html') }
    )
    if ($packageSources.Count -eq 0) { throw 'No custom-view package sources were found; this check would pass vacuously.' }
    foreach ($file in $packageSources) {
        if ([IO.File]::ReadAllText($file.FullName) -match 'chrome\.webview') {
            throw "A custom-view package still speaks to the retired helper: $($file.FullName)"
        }
    }
    Write-Host "OK       custom-view packages speak only window.nendo ($($packageSources.Count) source files)"

    # ADR-0008. The Engine is the only consumer of the expression library, and
    # consent is the desktop host's to give. An adapter that could name either
    # would be a way to evaluate outside the typed adapter, or to approve without
    # asking anyone.
    $forbiddenEvaluatorPattern = '(?i)\bNCalc\b|\bParlot\b'
    foreach ($file in $adapterFiles) {
        $text = [IO.File]::ReadAllText($file.FullName)
        if ($text -match $forbiddenEvaluatorPattern) {
            throw "The expression evaluator escaped the Engine boundary: $($file.FullName)"
        }
    }
    $localMcpRootForConsent = Join-Path $repoRoot 'src\Nendo.LocalMcp'
    $mcpAdapterFiles = @($adapterFiles | Where-Object { $_.FullName -like '*Nendo.LocalMcp*' })
    if ($mcpAdapterFiles.Count -eq 0) {
        throw 'The local MCP adapter sources were not found; this check would pass vacuously.'
    }
    foreach ($file in $mcpAdapterFiles) {
        $text = [IO.File]::ReadAllText($file.FullName)
        if ($text -match '(?i)BehaviourGrantStore|ApproveBehaviourAsync|BehaviourAuthority') {
            throw "The local MCP surface can reach behaviour approval: $($file.FullName)"
        }
        if ($text -match '(?i)DesktopExtensionSettingsStore|DesktopExtensionDevLinks|SetExtensionSettingAsync|SuspendExtensions') {
            throw "The local MCP surface can switch this device's custom views: $($file.FullName)"
        }
        # The notification area is where an owner answers, so it must stay as far from
        # the agent surface as approval itself. An adapter that could raise a Nendo
        # notification could put a sentence of its own choosing in front of the person
        # it is asking, wearing this application's name.
        if ($text -match '(?i)DesktopTrayIcon|DesktopNotifier|DesktopNotificationContent|AppNotificationManager|Shell_NotifyIcon') {
            throw "The local MCP surface can reach the notification area: $($file.FullName)"
        }
    }
    Write-Host "OK       evaluator, approval and notifications stay outside the adapters ($($mcpAdapterFiles.Count) local MCP source files)"
    # The adapter still cannot reach grant storage or the Engine's authority interface --
    # the three names above are unchanged. What it may now do, at one access level, is ask
    # its host to record the consent the person would have given
    # (ADR-0009, 2026-09-22 amendment). That ask is a delegate the host supplies, and this
    # check is what keeps it one delegate rather than a capability that spread: the type is
    # declared in one file, bound to the mode in one more, and used only where the level is
    # already required.
    $consentDeclaration = Join-Path $localMcpRootForConsent 'NendoUnattendedConsent.cs'
    if (-not (Test-Path -LiteralPath $consentDeclaration -PathType Leaf)) {
        throw "The unattended consent seam is missing; this check would pass vacuously: $consentDeclaration"
    }
    $consentCallers = @(
        $mcpAdapterFiles |
            Where-Object { [IO.File]::ReadAllText($_.FullName) -match '(?<!NendoUnattendedConsent\?? )\bunattended\.GrantAsync\b' } |
            ForEach-Object { $_.Name } |
            Sort-Object -Unique
    )
    $allowedConsentCallers = @('NendoAgentAuthoringService.cs', 'NendoDataMutationService.cs')
    $consentDifference = @(Compare-Object -ReferenceObject $allowedConsentCallers -DifferenceObject $consentCallers)
    if ($consentDifference.Count -gt 0) {
        throw "Unattended behaviour consent is granted somewhere new, or no longer where it was:`n$($consentDifference | Out-String)"
    }
    foreach ($file in $mcpAdapterFiles) {
        $text = [IO.File]::ReadAllText($file.FullName)
        if ($text -match '(?i)NendoUnattendedAuthority' -and
            $file.Name -notin @('NendoUnattendedConsent.cs', 'NendoLocalMcpHost.cs', 'NendoAgentAuthoringService.cs', 'NendoDataMutationService.cs')) {
            throw "The unattended consent seam reached a new file: $($file.FullName)"
        }
    }
    Write-Host "OK       unattended behaviour consent is one host-supplied delegate, granted in $($consentCallers.Count) named places"


    $implementationProjects = @(
        foreach ($projectRoot in @('src', 'tests')) {
            Get-ChildItem -LiteralPath (Join-Path $repoRoot $projectRoot) -Recurse -File -Filter '*.csproj'
        }
    )
    foreach ($project in $implementationProjects) {
        $text = [IO.File]::ReadAllText($project.FullName)
        if ($text -match '(?i)(?:^|[\\/])prototypes(?:[\\/]|$)') {
            throw "Production or test project references disposable prototype code: $($project.FullName)"
        }
    }
    Write-Host "OK       production and test projects exclude prototypes ($($implementationProjects.Count) project files)"

    $localMcpRoot = Join-Path $repoRoot 'src\Nendo.LocalMcp'
    $localMcpFiles = @(
        Get-ChildItem -LiteralPath $localMcpRoot -Recurse -File -Filter '*.cs' |
            Where-Object { $_.FullName -notmatch '[\\/](?:bin|obj)[\\/]' }
    )
    $localMcpSource = ($localMcpFiles | ForEach-Object { [IO.File]::ReadAllText($_.FullName) }) -join "`n"
    $declaredMcpNames = @(
        [regex]::Matches($localMcpSource, 'Name\s*=\s*"(nendo\.[^"]+)"') |
            ForEach-Object { $_.Groups[1].Value } |
            Sort-Object -Unique
    )
    $expectedResources = @(
        'nendo.application.describe',
        'nendo.application.entities',
        'nendo.application.entity',
        'nendo.application.entity.aggregate',
        'nendo.application.entity.export',
        'nendo.application.entity.records',
        'nendo.application.entity.schema',
        'nendo.application.entity.tree',
        'nendo.application.examples',
        'nendo.application.extension.events',
        'nendo.application.extension.file',
        'nendo.application.extensions',
        'nendo.application.health',
        'nendo.application.history',
        'nendo.application.manifest',
        'nendo.application.media',
        'nendo.application.proposal',
        'nendo.application.proposals',
        'nendo.application.revision.operations',
        'nendo.application.search',
        'nendo.application.surfaces',
        'nendo.application.view.api',
        'nendo.application.vocabulary',
        'nendo.host.instances',
        'nendo.host.skill',
        'nendo.host.skill.file',
        'nendo.application.skill.file'
    )
    $expectedTools = @(
        'nendo.change_set.accept',
        'nendo.change_set.add_operations',
        'nendo.change_set.amend',
        'nendo.change_set.begin',
        'nendo.change_set.preview',
        'nendo.change_set.reject',
        'nendo.change_set.revalidate',
        'nendo.change_set.validate',
        'nendo.data.apply_writes',
        'nendo.data.create_record',
        'nendo.data.create_records',
        'nendo.data.delete_record',
        'nendo.data.execute_command',
        'nendo.data.get_receipt',
        'nendo.data.import_records',
        'nendo.data.move_record',
        'nendo.data.put_media',
        'nendo.data.set_field',
        'nendo.data.set_kept_in_new_files',
        'nendo.data.undo_revision',
        'nendo.data.update_record',
        'nendo.health.verify_integrity',
        'nendo.lease.acquire',
        'nendo.lease.release',
        'nendo.lease.renew',
        'nendo.lease.status',
        'nendo.read.list',
        'nendo.read.resource'
    )
    # Resources are named for what they describe. Almost all of them describe the open
    # application; nendo.host.instances describes the device, because which Nendos are
    # running is not a fact about any one file.
    $resourcePrefixes = @('nendo.application.', 'nendo.host.')
    $isResource = { param($name) @($resourcePrefixes | Where-Object { $name.StartsWith($_, [StringComparison]::Ordinal) }).Count -gt 0 }
    $actualResources = @($declaredMcpNames | Where-Object { & $isResource $_ })
    $actualTools = @($declaredMcpNames | Where-Object { -not (& $isResource $_) })
    $resourceDifference = @(Compare-Object -ReferenceObject $expectedResources -DifferenceObject $actualResources)
    if ($resourceDifference.Count -gt 0) {
        throw "Local MCP resource surface drifted:`n$($resourceDifference | Out-String)"
    }
    $toolDifference = @(Compare-Object -ReferenceObject $expectedTools -DifferenceObject $actualTools)
    if ($toolDifference.Count -gt 0) {
        throw "Local MCP tool surface drifted:`n$($toolDifference | Out-String)"
    }
    # 'no promotion tool' until 2026-09-22. There is one now, at one access level, and it
    # is named in this list like every other tool -- which is the point of the list: a
    # surface this size changes deliberately or it fails here.
    Write-Host "OK       local MCP surface ($($expectedResources.Count) resources, $($expectedTools.Count) closed tools, acceptance only at Unattended)"

    # Help lists the surface for a person. It must be the same closed set pinned above,
    # or the article drifts the day a tool is added or a URI changes.
    $helpAgentsPath = Join-Path $workbenchRoot 'src\help-agents.ts'
    $helpAgentsSource = [IO.File]::ReadAllText($helpAgentsPath)
    $declaredUriTemplates = @(
        # Every scheme: the two skill:// resources (W-154) are part of the surface, and a count
        # that saw only nendo:// failed the gate at 21 of 23 once they existed (F-262).
        [regex]::Matches($localMcpSource, 'UriTemplate\s*=\s*"([a-z]+://[^"]+)"') |
            ForEach-Object { $_.Groups[1].Value } |
            Sort-Object -Unique
    )
    if ($declaredUriTemplates.Count -ne $expectedResources.Count) {
        throw "Expected $($expectedResources.Count) resource URI templates in the local MCP source; found $($declaredUriTemplates.Count)."
    }
    foreach ($uri in $declaredUriTemplates) {
        if ($helpAgentsSource.IndexOf($uri, [StringComparison]::Ordinal) -lt 0) {
            throw "Help does not describe MCP resource $uri : $helpAgentsPath"
        }
    }
    $helpToolNames = @(
        [regex]::Matches($helpAgentsSource, '\bnendo\.(?:read|lease|data|health|change_set)\.[a-z_]+\b') |
            ForEach-Object { $_.Value } |
            Sort-Object -Unique
    )
    $helpToolDifference = @(Compare-Object -ReferenceObject $expectedTools -DifferenceObject $helpToolNames)
    if ($helpToolDifference.Count -gt 0) {
        throw "Help names a tool the local MCP surface does not declare, or misses one ($helpAgentsPath):`n$($helpToolDifference | Out-String)"
    }
    Write-Host "OK       Help inventory matches the local MCP surface ($($declaredUriTemplates.Count) resources, $($expectedTools.Count) tools)"

    # The Workbench asks with its own <dialog>. The browser's are on for custom views, which
    # may call them, but in the Workbench they would be a second, foreign kind of question --
    # and while they were off, the fifth access level shipped with a control that silently did
    # nothing (F-120). This check is what stops the browser's being reached for again.
    # Tried on a Windows path first: '[\/]' is a class of one slash in .NET, and the
    # exclusion written that way never matched the backslash paths Get-ChildItem returns.
    $bundledOutput = '[\\/](?:node_modules|dist)[\\/]'
    if ('C:\x\src\node_modules\y.ts' -notmatch $bundledOutput) { throw "The node_modules/dist exclusion does not match a Windows path: $bundledOutput" }
    $rendererSource = @(
        Get-ChildItem -LiteralPath (Join-Path $workbenchRoot 'src') -Recurse -File -Include '*.ts', '*.js' |
            Where-Object { $_.FullName -notmatch $bundledOutput }
    )
    if ($rendererSource.Count -eq 0) {
        throw 'The Workbench renderer sources were not found; this check would pass vacuously.'
    }
    foreach ($file in $rendererSource) {
        $text = [IO.File]::ReadAllText($file.FullName)
        if ($text -match '(?<![A-Za-z0-9_.$])(?:window\.)?(?:confirm|alert|prompt)\s*\(') {
            throw "The renderer calls a browser dialog; use the Workbench's own dialog: $($file.FullName)"
        }
    }
    Write-Host "OK       the renderer asks with its own dialog, never the browser's ($($rendererSource.Count) source files)"

    $boundedContractFiles = @(
        'NendoMcpContracts.cs',
        'NendoAuthoringContracts.cs',
        'NendoMcpResources.cs',
        'NendoLeaseTools.cs',
        'NendoDataTools.cs',
        'NendoAuthoringTools.cs',
        'NendoAuthoringExamples.cs',
        'NendoAuthoringOperations.cs',
        'NendoHealthTools.cs',
        'NendoMcpReadIndex.cs'
    )
    $forbiddenContractPattern = '(?i)\b(?:databasePath|filePath|sqliteConnection|bearerToken|accessToken)\b'
    foreach ($name in $boundedContractFiles) {
        $path = Join-Path $localMcpRoot $name
        $text = [IO.File]::ReadAllText($path)
        if ($text -match $forbiddenContractPattern) {
            throw "Local MCP public contract exposes privileged host material: $path"
        }
    }
    Write-Host "OK       local MCP contracts exclude database paths, connections and credentials"

    Write-Host '== Custom-view presentation =='
    Enter-GateStep 'view.graph'
    Invoke-Checked 'pwsh' @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'Review-NendoGraph.ps1')) 'Offline graph presentation'
    Enter-GateStep 'view.work-dependencies'
    Invoke-Checked 'pwsh' @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'Review-WorkDependencies.ps1')) 'Work-dependency view presentation'
    Enter-GateStep 'view.systems-lens'
    Invoke-Checked 'pwsh' @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'Review-SystemsLens.ps1')) 'Systems Lens presentation'
    Enter-GateStep 'view.gantt'
    Invoke-Checked 'pwsh' @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'Review-Gantt.ps1')) 'Gantt record-set presentation'
    Enter-GateStep 'view.capability-atlas'
    Invoke-Checked 'pwsh' @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'Review-BcmAtlas.ps1')) 'Capability Atlas presentation'
    Enter-GateStep 'view.archi'
    Invoke-Checked 'pwsh' @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'Review-ArchiWorkbench.ps1')) 'Archi workbench presentation'
    Enter-GateStep 'view.swarm'
    Invoke-Checked 'pwsh' @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'Review-Swarm.ps1')) 'Swarm behaviour, simulation and replay'
    Enter-GateStep 'view.garden'
    Invoke-Checked 'pwsh' @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'Review-Garden.ps1')) 'Garden notes, sync and backlinks'
    Enter-GateStep 'view.manuscript'
    Invoke-Checked 'pwsh' @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'Review-Manus.ps1')) 'Manuscript sheet, autosave and block identity'

    Write-Host '== Launched agent conversation =='
    Enter-GateStep 'agent-chat'
    Invoke-Checked 'pwsh' @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'Review-AgentChat.ps1')) 'Launched agent conversation tab'

    Write-Host '== Workbench shell =='
    Enter-GateStep 'workbench-shell'
    Invoke-Checked 'pwsh' @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'Review-WorkbenchShell.ps1')) 'Workbench shell, Use screens and Agent page'

    Write-Host '== Repository =='
    Enter-GateStep 'repository'
    & (Join-Path $PSScriptRoot 'Test-Repository.ps1')

    Complete-GateProgress
    Write-Host 'Production verification passed.'
}
catch {
    Complete-GateProgress -Failure $_.Exception.Message
    throw
}
finally {
    Pop-Location
}
