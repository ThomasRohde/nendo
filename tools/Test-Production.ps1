[CmdletBinding()]
param(
    [switch] $SkipRestore
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

Push-Location $repoRoot
try {
    Write-Host '== Workbench =='
    $npmCommand = Get-NpmCommand
    Push-Location $workbenchRoot
    try {
        if (-not $SkipRestore) {
            Invoke-Npm $npmCommand @('ci') 'Workbench restore'
        }
        Invoke-Npm $npmCommand @('run', 'check') 'Workbench type check'
        Invoke-Npm $npmCommand @('test') 'Workbench behavior tests'
        Invoke-Npm $npmCommand @('run', 'verify:dependencies') 'Workbench dependency verification'
        Invoke-Npm $npmCommand @('run', 'build') 'Workbench build'
    }
    finally {
        Pop-Location
    }

    Write-Host '== .NET =='
    if (-not $SkipRestore) {
        Invoke-Checked 'dotnet' @('restore', 'Nendo.slnx', '--nologo') '.NET restore'
    }
    Invoke-Checked 'dotnet' @('build', 'Nendo.slnx', '--no-restore', '--nologo') '.NET build'
    Invoke-Checked 'dotnet' @('test', 'Nendo.slnx', '--no-build', '--no-restore', '--nologo', '--logger', 'trx') '.NET tests'

    Write-Host '== Production boundaries =='
    & (Join-Path $PSScriptRoot 'Test-ApplicationNeutrality.ps1')

    $desktopBundleRoot = Join-Path $repoRoot 'artifacts\bin\Nendo.Desktop'
    $bundledEntryPoints = @(
        Get-ChildItem -LiteralPath $desktopBundleRoot -Recurse -File -Filter 'index.html' |
            Where-Object { $_.DirectoryName -match '[\\/]Workbench$' }
    )
    if ($bundledEntryPoints.Count -eq 0) {
        throw 'The Desktop output does not contain Workbench/index.html.'
    }
    Write-Host "OK       bundled Workbench entry point ($($bundledEntryPoints.Count) output(s))"

    $adapterFiles = @(
        foreach ($adapterRoot in @('src\Nendo.Desktop', 'src\Nendo.LocalMcp', 'src\Nendo.ExtensionHost')) {
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
    Write-Host "OK       Desktop, local MCP and custom-view helper storage boundary ($($adapterFiles.Count) source files)"

    $helperProject = [xml][IO.File]::ReadAllText((Join-Path $repoRoot 'src/Nendo.ExtensionHost/Nendo.ExtensionHost.csproj'))
    if ($helperProject.SelectNodes('//ProjectReference').Count -ne 0) { throw 'The custom-view helper must not reference application assemblies.' }
    $helperPackages = @($helperProject.SelectNodes('//PackageReference') | ForEach-Object { $_.Include })
    if ($helperPackages.Count -ne 1 -or $helperPackages[0] -ne 'Microsoft.Web.WebView2') { throw 'The custom-view helper dependency inventory changed.' }
    $helperLinks = @($helperProject.SelectNodes('//Compile[@Include]') | ForEach-Object { $_.Include })
    if ($helperLinks.Count -ne 1 -or $helperLinks[0].Replace('\', '/') -ne '../Nendo.Engine/Extensions/ExtensionFrameCodec.cs') {
        throw 'The custom-view helper may share only the bounded frame codec.'
    }
    Write-Host 'OK       custom-view helper has no application dependency or privileged shared source'

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
        if ($text -match '(?i)DesktopExtensionGrantStore|DesktopExtensionPackageStore|ApproveExtensionAsync|PrepareExtensionConsentAsync') {
            throw "The local MCP surface can install or approve a custom view: $($file.FullName)"
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
        'nendo.application.entity.export',
        'nendo.application.entity.records',
        'nendo.application.entity.schema',
        'nendo.application.examples',
        'nendo.application.health',
        'nendo.application.history',
        'nendo.application.manifest',
        'nendo.application.proposals',
        'nendo.application.revision.operations',
        'nendo.application.surfaces',
        'nendo.application.vocabulary',
        'nendo.host.instances'
    )
    $expectedTools = @(
        'nendo.change_set.accept',
        'nendo.change_set.add_operations',
        'nendo.change_set.amend',
        'nendo.change_set.begin',
        'nendo.change_set.preview',
        'nendo.change_set.reject',
        'nendo.change_set.validate',
        'nendo.data.create_record',
        'nendo.data.create_records',
        'nendo.data.delete_record',
        'nendo.data.execute_command',
        'nendo.data.get_receipt',
        'nendo.data.import_records',
        'nendo.data.set_field',
        'nendo.health.verify_integrity',
        'nendo.lease.acquire',
        'nendo.lease.release',
        'nendo.lease.renew',
        'nendo.lease.status'
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
        [regex]::Matches($localMcpSource, 'UriTemplate\s*=\s*"(nendo://[^"]+)"') |
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
        [regex]::Matches($helpAgentsSource, '\bnendo\.(?:lease|data|health|change_set)\.[a-z_]+\b') |
            ForEach-Object { $_.Value } |
            Sort-Object -Unique
    )
    $helpToolDifference = @(Compare-Object -ReferenceObject $expectedTools -DifferenceObject $helpToolNames)
    if ($helpToolDifference.Count -gt 0) {
        throw "Help names a tool the local MCP surface does not declare, or misses one ($helpAgentsPath):`n$($helpToolDifference | Out-String)"
    }
    Write-Host "OK       Help inventory matches the local MCP surface ($($declaredUriTemplates.Count) resources, $($expectedTools.Count) tools)"

    # The host turns the browser's own dialogs off and handles none of them, so
    # window.confirm draws nothing and returns false, window.alert draws nothing at all,
    # and window.prompt returns null. A renderer that calls one has a control that
    # silently does nothing -- which is what the fifth access level shipped as (F-120).
    # The app has its own <dialog>; this check is what stops the browser's being reached
    # for again.
    $rendererSource = @(
        Get-ChildItem -LiteralPath (Join-Path $workbenchRoot 'src') -Recurse -File -Include '*.ts', '*.js' |
            Where-Object { $_.FullName -notmatch '[\/](?:node_modules|dist)[\/]' }
    )
    if ($rendererSource.Count -eq 0) {
        throw 'The Workbench renderer sources were not found; this check would pass vacuously.'
    }
    foreach ($file in $rendererSource) {
        $text = [IO.File]::ReadAllText($file.FullName)
        if ($text -match '(?<![A-Za-z0-9_.$])(?:window\.)?(?:confirm|alert|prompt)\s*\(') {
            throw "The renderer calls a browser dialog the host has disabled, so the control does nothing: $($file.FullName)"
        }
    }
    $settings = [IO.File]::ReadAllText((Join-Path $repoRoot 'src/Nendo.Desktop/MainPage.xaml.cs'))
    if ($settings -notmatch 'AreDefaultScriptDialogsEnabled\s*=\s*false') {
        throw 'The host no longer disables browser dialogs; the renderer check above is guarding nothing.'
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
    Invoke-Checked 'pwsh' @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'Review-NendoGraph.ps1')) 'Offline graph presentation'
    Invoke-Checked 'pwsh' @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'Review-WorkDependencies.ps1')) 'Work-dependency view presentation'
    Invoke-Checked 'pwsh' @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'Review-SystemsLens.ps1')) 'Systems Lens presentation'
    Invoke-Checked 'pwsh' @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'Review-Gantt.ps1')) 'Gantt record-set presentation'
    Invoke-Checked 'pwsh' @('-NoProfile', '-File', (Join-Path $PSScriptRoot 'Review-ExtensionDialogs.ps1')) 'Native custom-view dialogs'

    Write-Host '== Repository =='
    & (Join-Path $PSScriptRoot 'Test-Repository.ps1')

    Write-Host 'Production verification passed.'
}
finally {
    Pop-Location
}
