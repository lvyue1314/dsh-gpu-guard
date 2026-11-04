# Register the watchdog as a Scheduled Task instead of keeping a console open.
#
#   powershell -ExecutionPolicy Bypass -File examples/scheduled-task.ps1
#   powershell -ExecutionPolicy Bypass -File examples/scheduled-task.ps1 -EveryMinutes 5 -Apply
#   powershell -ExecutionPolicy Bypass -File examples/scheduled-task.ps1 -Remove
param(
  [string]$NodePath = "",
  [int]$EveryMinutes = 5,
  [switch]$Apply,
  [switch]$Remove,
  [string]$TaskName = "dsh-gpu-guard"
)

$ErrorActionPreference = "Stop"

if ($Remove) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "removed scheduled task $TaskName"
  exit 0
}

$pluginRoot = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $pluginRoot "bin\gpu-guard.mjs"
if (-not (Test-Path $entry)) { throw "cannot find $entry" }

if (-not $NodePath) {
  $NodePath = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $NodePath) { throw "node.exe not found; pass -NodePath" }
}

# Without -Apply the task only reports; with -Apply it kills orphaned GPU trees.
$verb = if ($Apply) { "reap --apply" } else { "status" }
$arguments = '"' + $entry + '" ' + $verb

$action = New-ScheduledTaskAction -Execute $NodePath -Argument $arguments -WorkingDirectory $pluginRoot
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "registered ${TaskName}: every $EveryMinutes min, verb=$verb"
