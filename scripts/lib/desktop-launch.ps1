param([int]$DebugPort = 0)
$ErrorActionPreference = 'Stop'
$settings = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'saker-desktop-launch.json') -Raw | ConvertFrom-Json
$executable = Join-Path $settings.desktopDirectory 'DeepSeek Harness.exe'
if (-not (Test-Path -LiteralPath $executable)) { throw 'Desktop runtime is missing. Refresh the Saker desktop shortcut after updating Desktop.' }
# 0.2.0 used a fixed loopback port; 0.2.1 uses a random port. Neither version
# may start a second instance for the same daily profile. Ownership is decided
# by the absolute executable path and userData, never by a fixed port.
$running = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -eq $executable })
# Verification runs start the very same executable with an isolated
# --user-data-dir and a temp DSH_HOME, so their session list is empty. They look
# exactly like the daily app, and focusing one of them makes the user believe
# every previous session is gone. Only an instance carrying this launcher's own
# userData directory is the daily window; a foreign instance is never focused.
$dailyUserData = $settings.userDataDirectory
$daily = @($running | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($dailyUserData) })
$foreign = @($running | Where-Object { $daily -notcontains $_ })
if ($daily.Count -gt 0) {
  $ids = ($daily | Select-Object -ExpandProperty ProcessId) -join ', '
  # Bring the existing window forward: the shortcut runs hidden, so a bare message
  # would be invisible and the user would think the double-click did nothing.
  $idList = @($daily | Select-Object -ExpandProperty ProcessId)
  $root = @($daily | Where-Object { $idList -notcontains $_.ParentProcessId } | Select-Object -First 1)
  $target = if ($root.Count -gt 0) { $root[0].ProcessId } else { $idList[0] }
  $activated = $false
  try { $activated = (New-Object -ComObject WScript.Shell).AppActivate([int]$target) } catch { $activated = $false }
  Write-Host "Saker Desktop is already running (PID: $ids)."
  Write-Host "This daily configuration cannot start twice; the existing window was focused: $activated"
  exit 0
}
if ($foreign.Count -gt 0) {
  # The port is held by a test/isolated instance. The shortcut runs hidden, so a
  # console line is invisible: say it in a dialog and never steal focus, because
  # activating that window would show an empty session list.
  $ids = ($foreign | Select-Object -ExpandProperty ProcessId) -join ', '
  $message = @(
    'A Saker test instance is running with a different user-data directory.'
    "It was started for verification with a temporary DSH_HOME, so its session list is empty on purpose."
    'Your own sessions are untouched under ' + $settings.home + '; they are not shown in that window.'
    ''
    "Test instance PID: $ids"
    'Close that window, then start Saker again from this shortcut.'
  ) -join [Environment]::NewLine
  Write-Host $message
  try {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($message, 'Saker is already running (test instance)', 'OK', 'Warning') | Out-Null
  } catch { Write-Host 'Could not show the warning dialog; see the console output above.' }
  exit 1
}
New-Item -ItemType Directory -Force -Path $settings.tempDirectory, $settings.userDataDirectory | Out-Null
$env:TEMP = $settings.tempDirectory
$env:TMP = $settings.tempDirectory
$env:TMPDIR = $settings.tempDirectory
$env:DSH_HOME = $settings.home
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$launchArguments = @('--user-data-dir="' + $settings.userDataDirectory + '"')
if ($DebugPort -gt 0) { $launchArguments += '--remote-debugging-port=' + $DebugPort }
Start-Process -FilePath $executable -ArgumentList $launchArguments -WorkingDirectory $settings.workspace -WindowStyle Normal | Out-Null
