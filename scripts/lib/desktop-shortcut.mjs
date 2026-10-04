import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const defaultWorkspace = existsSync(join(root, '..', '_ref', 'tools')) ? resolve(root, '..') : root

export function refreshDesktopShortcut({ desktopDirectory, workspace, userDataDirectory, home = process.env.DSH_HOME || join(homedir(), '.dsh') }) {
  if (process.platform !== 'win32') throw new Error('Desktop shortcut maintenance currently supports Windows only.')
  const desktop = resolve(desktopDirectory)
  const executable = join(desktop, 'DeepSeek Harness.exe')
  if (!existsSync(executable)) throw new Error('The selected official Desktop executable does not exist.')
  // A new release may be extracted elsewhere. Reuse the existing shortcut's
  // persistent launcher and daily profile, rather than making a new login home.
  const discover = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $path=Join-Path ([Environment]::GetFolderPath('Desktop')) 'Saker (dsh Desktop).lnk'; if(Test-Path -LiteralPath $path){$link=(New-Object -ComObject WScript.Shell).CreateShortcut($path); if($link.Description -eq 'Saker / dsh Desktop' -and $link.Arguments -match '-File "([^\"]+Start-SakerDesktop\\.ps1)"'){ $settings=Join-Path (Split-Path -Parent $Matches[1]) 'saker-desktop-launch.json'; if(Test-Path -LiteralPath $settings){Get-Content -LiteralPath $settings -Raw} }}`
  const discovered = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(discover, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, env: process.env })
  if (discovered.error || discovered.status !== 0) throw discovered.error || new Error('Cannot read the existing Desktop shortcut; no shortcut was changed.')
  const previous = discovered.stdout.trim() ? JSON.parse(discovered.stdout.replace(/^\uFEFF/, '')) : {}
  const sameHome = previous.home && resolve(previous.home).toLowerCase() === resolve(home).toLowerCase()
  const persistent = sameHome ? previous : {}
  const launchWorkspace = resolve(workspace || persistent.workspace || defaultWorkspace)
  const toolsDirectory = join(launchWorkspace, '_ref', 'tools')
  mkdirSync(toolsDirectory, { recursive: true })
  const configPath = join(toolsDirectory, 'saker-desktop-launch.json')
  const old = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')) : {}
  const config = {
    desktopDirectory: desktop,
    // Updating the executable must not change the daily browser profile.
    userDataDirectory: resolve(userDataDirectory || old.userDataDirectory || persistent.userDataDirectory || join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), '@deepseek-ai', 'dsh-desktop')),
    home: resolve(home), workspace: launchWorkspace,
    tempDirectory: join(launchWorkspace, '_ref', 'tmp'),
  }
  const launcher = join(toolsDirectory, 'Start-SakerDesktop.ps1')
  copyFileSync(join(dirname(fileURLToPath(import.meta.url)), 'desktop-launch.ps1'), launcher)
  // BOM permits Windows PowerShell 5.1 to read Chinese paths reliably.
  writeFileSync(configPath, '\uFEFF' + JSON.stringify(config, null, 2) + '\n')
  const quote = value => "'" + value.replaceAll("'", "''") + "'"
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $desktop=[Environment]::GetFolderPath('Desktop'); if(-not $desktop){throw 'Windows Desktop folder unavailable'}; $shell=New-Object -ComObject WScript.Shell; $link=$shell.CreateShortcut((Join-Path $desktop 'Saker (dsh Desktop).lnk')); $link.TargetPath=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'; $link.Arguments=${quote('-NoLogo -NoProfile -ExecutionPolicy RemoteSigned -WindowStyle Hidden -File "' + launcher + '"')}; $link.WorkingDirectory=${quote(config.workspace)}; $link.IconLocation=${quote(executable + ',0')}; $link.Description='Saker / dsh Desktop'; $link.Save(); $check=$shell.CreateShortcut($link.FullName); if($check.TargetPath -ne $link.TargetPath -or $check.Arguments -ne $link.Arguments){throw 'Shortcut verification failed'}; Write-Output $link.FullName`
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true,
    env: { ...process.env, TEMP: config.tempDirectory, TMP: config.tempDirectory, TMPDIR: config.tempDirectory },
  })
  if (result.error || result.status !== 0) throw result.error || new Error(result.stderr || 'Desktop shortcut update failed.')
  return { shortcut: result.stdout.trim(), launcher, configPath, ...config }
}
