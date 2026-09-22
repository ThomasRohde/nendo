[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../artifacts/evidence/runs'))) ('prune-tests-' + [Guid]::NewGuid().ToString('N'))
$payload = Join-Path $root 'payload'
[void][IO.Directory]::CreateDirectory($payload)
$owned = Join-Path $payload 'app.txt'
$user = Join-Path $payload 'user.nendo'
[IO.File]::WriteAllText($owned,'owned build bytes')
[IO.File]::WriteAllText($user,'retain user bytes')
$userHash = (Get-FileHash -LiteralPath $user).Hash
$manifest = @{kind='local-pilot'; files=@(@{path='app.txt'; sha256=(Get-FileHash -LiteralPath $owned).Hash})}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $root 'manifest.json')
$prune = Join-Path $PSScriptRoot 'Remove-NendoBuildPayload.ps1'
$preview = & $prune -BuildRoot $root
if ($preview.applied -or -not (Test-Path -LiteralPath $owned)) { throw 'Dry run deleted payload.' }
[IO.File]::WriteAllText($owned,'changed bytes')
$refused = $false
try { & $prune -BuildRoot $root -Apply | Out-Null } catch { $refused = $true }
if (-not $refused -or -not (Test-Path -LiteralPath $owned)) { throw 'Changed payload not retained.' }
[IO.File]::WriteAllText($owned,'owned build bytes')
& $prune -BuildRoot $root -Apply | Out-Null
if ((Test-Path -LiteralPath $owned) -or (Get-FileHash -LiteralPath $user).Hash -ne $userHash -or -not (Test-Path -LiteralPath (Join-Path $root 'manifest.json'))) { throw 'Pruning did not preserve unknown files and evidence.' }
$repeat = & $prune -BuildRoot $root -Apply
if ($repeat.files -ne 0 -or $repeat.bytes -ne 0) { throw 'Already-pruned payload is not a no-op.' }
$manifest.files[0].path = '..\escape.txt'
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $root 'manifest.json')
$refused = $false
try { & $prune -BuildRoot $root -Apply | Out-Null } catch { $refused = $true }
if (-not $refused) { throw 'Traversal was not refused.' }
@{result='passed'; checks=@('dry run','changed payload refused','owned bytes removed','already-pruned no-op','unknown user bytes retained','manifest retained','traversal refused')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'results.json')
Write-Output "Build pruning checks passed: $root"
