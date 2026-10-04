param([int]$DebugPort = 0)
$ErrorActionPreference = 'Stop'
$settings = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'saker-desktop-launch.json') -Raw | ConvertFrom-Json
$executable = Join-Path $settings.desktopDirectory 'DeepSeek Harness.exe'
if (-not (Test-Path -LiteralPath $executable)) { throw 'Desktop runtime is missing. Refresh the Saker desktop shortcut after updating Desktop.' }
New-Item -ItemType Directory -Force -Path $settings.tempDirectory, $settings.userDataDirectory | Out-Null
$env:TEMP = $settings.tempDirectory
$env:TMP = $settings.tempDirectory
$env:TMPDIR = $settings.tempDirectory
$env:DSH_HOME = $settings.home
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$launchArguments = @('--user-data-dir="' + $settings.userDataDirectory + '"')
if ($DebugPort -gt 0) { $launchArguments += '--remote-debugging-port=' + $DebugPort }
Start-Process -FilePath $executable -ArgumentList $launchArguments -WorkingDirectory $settings.workspace -WindowStyle Normal | Out-Null
