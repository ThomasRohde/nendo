# Where a run of Test-Production.ps1 has got to, as a small JSON file another program can read
# while the gate runs: the planned steps in order, when each started and ended, and how the run
# ended. The Claude Code mod in .claude/skills/nendo-planner draws it as a progress bar; anything
# else may read it too. It says nothing about whether a step passed until the run ends: a failing
# step ends the run.
#
# Each step carries the seconds it took in the last run that passed (artifacts/gate-timings.json),
# so a reader can weigh the steps by how long they take rather than count them. A step with no
# earlier time carries null.
#
# The file is replaced whole on every write, through a temporary file beside it, so a reader never
# sees half of one.

Set-StrictMode -Version Latest

$script:progress = $null
$script:path = $null
$script:timingsPath = $null

function Get-GateProgressNow { [DateTimeOffset]::UtcNow.ToString('o') }

function Save-GateProgress {
    $script:progress.updatedAt = Get-GateProgressNow
    $json = $script:progress | ConvertTo-Json -Depth 5
    $temporary = "$script:path.$PID.tmp"
    [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $script:path -Force
}

# Begin a run: every planned step, in order, as [id, label] pairs.
function Start-GateProgress {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][object[]] $Steps,
        [string] $TimingsPath = ''
    )
    $script:path = $Path
    $script:timingsPath = $TimingsPath
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path))
    $earlier = @{}
    if ($TimingsPath -ne '' -and (Test-Path -LiteralPath $TimingsPath -PathType Leaf)) {
        try {
            $read = Get-Content -LiteralPath $TimingsPath -Raw | ConvertFrom-Json -AsHashtable
            if ($read -is [hashtable] -and $read.ContainsKey('steps') -and $read.steps -is [hashtable]) { $earlier = $read.steps }
        }
        catch { $earlier = @{} } # A timings file that cannot be read only costs the weights.
    }
    $script:progress = [ordered]@{
        version = 1
        processId = $PID
        startedAt = Get-GateProgressNow
        updatedAt = $null
        state = 'running'
        current = $null
        failure = $null
        steps = @($Steps | ForEach-Object {
            $id = [string]$_[0]
            [ordered]@{
                id = $id
                label = [string]$_[1]
                expectedSeconds = if ($earlier.ContainsKey($id)) { [double]$earlier[$id] } else { $null }
                startedAt = $null
                endedAt = $null
            }
        })
    }
    Save-GateProgress
}

function Close-CurrentGateStep {
    $now = Get-GateProgressNow
    foreach ($step in $script:progress.steps) {
        if ($null -ne $step.startedAt -and $null -eq $step.endedAt) { $step.endedAt = $now }
    }
}

# The step that starts now. The one before it ends here. A step the plan did not name is added
# at the end, so the file never claims a step that did not run.
function Enter-GateStep {
    param([Parameter(Mandatory = $true)][string] $Id)
    if ($null -eq $script:progress) { return }
    Close-CurrentGateStep
    $step = $script:progress.steps | Where-Object { $_.id -eq $Id } | Select-Object -First 1
    if ($null -eq $step) {
        $step = [ordered]@{ id = $Id; label = $Id; expectedSeconds = $null; startedAt = $null; endedAt = $null }
        $script:progress.steps = @($script:progress.steps) + $step
    }
    $step.startedAt = Get-GateProgressNow
    $script:progress.current = $Id
    Save-GateProgress
}

# End the run. A run that passed keeps each step's seconds for the next run's weights.
function Complete-GateProgress {
    param([string] $Failure = '')
    if ($null -eq $script:progress) { return }
    Close-CurrentGateStep
    $script:progress.current = $null
    if ($Failure -ne '') {
        $script:progress.state = 'failed'
        $script:progress.failure = $Failure
    }
    else {
        $script:progress.state = 'passed'
        if ($script:timingsPath -ne '') {
            $seconds = [ordered]@{}
            foreach ($step in $script:progress.steps) {
                if ($null -ne $step.startedAt -and $null -ne $step.endedAt) {
                    $seconds[$step.id] = [Math]::Round(([DateTimeOffset]::Parse($step.endedAt) - [DateTimeOffset]::Parse($step.startedAt)).TotalSeconds, 1)
                }
            }
            $json = [ordered]@{ version = 1; recordedAt = Get-GateProgressNow; steps = $seconds } | ConvertTo-Json -Depth 4
            [IO.File]::WriteAllText($script:timingsPath, $json, [Text.UTF8Encoding]::new($false))
        }
    }
    Save-GateProgress
    $script:progress = $null
}

Export-ModuleMember -Function Start-GateProgress, Enter-GateStep, Complete-GateProgress
