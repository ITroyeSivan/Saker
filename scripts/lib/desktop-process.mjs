// Desktop 进程归属判断：0.2.0 用固定端口，0.2.1 改为随机端口。
// 不能再用单一端口判断应用是否运行；按可执行文件绝对路径和日常 userData 归属核对。
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const normalizePath = value => value ? resolve(value).replace(/[\\/]+$/, '').toLowerCase() : '';

/**
 * 返回当前 DeepSeek Harness 进程中符合归属条件的条目。
 * 不传 executable/userDataDirectory 时返回全部；检测失败抛错，不默认“已退出”。
 */
export function desktopProcesses({ executable, userDataDirectory } = {}) {
  const script = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'DeepSeek Harness.exe' } | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`;
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, env: process.env,
  });
  if (result.error || result.status !== 0) throw result.error || new Error('Cannot inspect Desktop process ownership: ' + (result.stderr || 'unknown error'));
  const raw = String(result.stdout || '').trim();
  if (!raw) return [];
  const rows = JSON.parse(raw);
  const list = Array.isArray(rows) ? rows : [rows];
  const exe = normalizePath(executable);
  const userData = userDataDirectory ? resolve(userDataDirectory).toLowerCase() : '';
  return list.filter(row => {
    if (exe && normalizePath(row.ExecutablePath) !== exe) return false;
    if (userData && !String(row.CommandLine || '').toLowerCase().includes(userData)) return false;
    return true;
  });
}
