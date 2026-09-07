# pick-worker.ps1 - resident folder-picker worker for sec-config "select directory".
# Host spawns this ONCE with -STA; it stays resident. Each request = one stdin line,
# one stdout line back. Worker exits when stdin hits EOF (host gone) or on 'quit'.
# Commands:
#   ping          -> pong                      (readiness probe)
#   echo <text>   -> OK:<text>                 (round-trip / encoding self-test)
#   pick          -> PICK:<abs path> | CANCEL | ERR:<msg>
#   quit          -> exit
# NOTE: Windows PowerShell 5.1 parses .ps1 as ANSI unless the file has a UTF-8 BOM,
# so this file must stay pure ASCII (no Chinese literals).
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try { Add-Type -AssemblyName System.Windows.Forms | Out-Null } catch {
  [Console]::Out.WriteLine('ERR:AddType:' + $_.Exception.Message)
  [Console]::Out.Flush()
  exit 1
}
while ($true) {
  $cmd = [Console]::In.ReadLine()
  if ($null -eq $cmd) { break }
  $line = $cmd.TrimEnd("`r", "`n")
  if ($line -eq 'quit') { break }
  if ($line -eq 'ping') {
    [Console]::Out.WriteLine('pong')
    [Console]::Out.Flush()
    continue
  }
  if ($line.StartsWith('echo ')) {
    [Console]::Out.WriteLine('OK:' + $line.Substring(5))
    [Console]::Out.Flush()
    continue
  }
  if ($line -eq 'pick') {
    try {
      $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
      $dlg.Description = 'Select the tool directory'
      $dlg.ShowNewFolderButton = $false
      if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        [Console]::Out.WriteLine('PICK:' + $dlg.SelectedPath)
      } else {
        [Console]::Out.WriteLine('CANCEL')
      }
    } catch {
      [Console]::Out.WriteLine('ERR:' + $_.Exception.Message)
    }
    [Console]::Out.Flush()
    continue
  }
}
