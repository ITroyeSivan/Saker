import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { configuredToolPaths, resolveToolInvocation } from 'dsh-saker/tool-runtime';

// Fixed no-target calls only. A configured custom command is never guessed.
const SPECS = {
  subfinder: { args: ['-h'], identity: /subfinder/i },
  httpx: { args: ['-h'], identity: /httpx/i },
  nuclei: { args: ['-h'], identity: /nuclei/i },
  katana: { args: ['-h'], identity: /katana/i },
  ffuf: { args: ['-h'], identity: /\bffuf\b|Fuzz Faster U Fool/i },
  afrog: { args: ['-h'], identity: /afrog/i },
  nmap: { args: ['--version'], identity: /Nmap version/i },
  sqlmap: { args: ['-h'], identity: /sqlmap/i },
  dirsearch: { args: ['-h'], identity: /dirsearch/i },
  semgrep: { args: ['--help'], identity: /semgrep/i },
};

export async function probeToolStartup(section, payload, { timeoutMs = 8000 } = {}) {
  const key = String(payload?.key ?? '').toLowerCase();
  const configured = configuredToolPaths(section), configuredPath = Object.hasOwn(configured, key) ? configured[key] : '';
  const base = { key, configuredPath, checkedAt: new Date().toISOString(), probeKind: 'local-startup' };
  const result = (state, reason, extra = {}) => ({ ...base, state, reason, ...extra });
  if (!configuredPath) return result('unconfigured', '未保存路径，或此工具已隐藏；请在安全配置中检查。');
  if (payload?.expectedPath !== configuredPath) return result('stale', '界面路径与已保存配置不同；请先保存配置再检查。');
  if ((configuredPath.includes('/') || configuredPath.includes('\\')) &&
      ![configuredPath, ...(['.exe', '.cmd', '.bat', '.com'].map(ext => configuredPath + ext))].some(existsSync)) {
    return result('missing', '已保存路径不存在；执行解析可能退回其他入口，请修正路径后再检查。');
  }
  const spec = Object.hasOwn(SPECS, key) ? SPECS[key] : null;
  if (!spec) return result('unsupported', '尚无此工具的固定启动检查；未执行程序，不能仅凭路径判为可用。');
  const invocation = resolveToolInvocation(key, configuredPath, { configured, roots: section.roots ?? [] });
  if (!invocation) return result('missing', '未找到可执行入口；请检查已保存路径或工具根目录。');
  if (invocation.error) return result('failed', invocation.error);
  if (/setup|install|uninstall|\.msi$/i.test(basename(invocation.file))) return result('unsupported', '配置入口像安装程序；本检查不启动安装器，请选择已安装工具入口。');

  const directory = mkdtempSync(join(tmpdir(), 'saker-tool-startup-'));
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/api.?key|password|secret|(^|_)token($|_)/i.test(name)) delete env[name];
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) {
    env[name] = join(directory, name.toLowerCase()); mkdirSync(env[name], { recursive: true });
  }
  Object.assign(env, { TEMP: directory, TMP: directory, TMPDIR: directory, PYTHONDONTWRITEBYTECODE: '1', SEMGREP_SEND_METRICS: 'off' });
  const started = performance.now();
  try {
    const outcome = await new Promise(resolve => {
      let child, size = 0, timedOut = false, error = '', output = [];
      const limit = 64 * 1024;
      try { child = spawn(invocation.bin, [...invocation.prefix, ...spec.args], { cwd: directory, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (failure) { resolve({ error: failure.message, exitCode: null, size: 0, output: '', timedOut: false }); return; }
      const collect = chunk => { const remaining = Math.max(0, limit - size); if (remaining) output.push(chunk.subarray(0, remaining)); size += chunk.length; };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      child.on('error', failure => { error = failure.message; });
      const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
      child.on('close', (exitCode, signal) => { clearTimeout(timer); resolve({ exitCode, signal, timedOut, error, size, output: Buffer.concat(output).toString('utf8') }); });
    });
    const metadata = { actualFile: invocation.file, exitCode: outcome.exitCode, signal: outcome.signal ?? null,
      durationMs: Math.round(performance.now() - started), outputBytes: outcome.size,
      outputSha256: createHash('sha256').update(outcome.output).digest('hex'), outputTruncated: outcome.size > 64 * 1024,
      preview: outcome.output.slice(0, 4000) };
    if (outcome.timedOut) return result('timeout', '启动检查超时，已停止本次程序；请检查运行环境。', metadata);
    if (outcome.error) return result('failed', '启动失败：' + outcome.error, metadata);
    if (metadata.outputTruncated) return result('inconclusive', '输出超过检查上限，结果不能确认。', metadata);
    if (outcome.exitCode !== 0) return result('failed', '程序非正常退出；请查看输出并检查解释器或依赖。', metadata);
    if (!spec.identity.test(outcome.output)) return result('mismatch', '输出不符合此工具的帮助或版本标识；请检查是否配置到了其他程序。', metadata);
    return result('available', '已实际返回帮助或版本；仅证明本机启动，未验证目标操作或插件工具是否已加载。', metadata);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export function createToolStartupChecks(current) {
  const pending = new Map();
  return payload => {
    const section = current() ?? {}, fingerprint = JSON.stringify([payload, configuredToolPaths(section), section.roots]);
    if (!pending.has(fingerprint)) {
      const promise = probeToolStartup(section, payload).finally(() => pending.delete(fingerprint));
      pending.set(fingerprint, promise);
    }
    return pending.get(fingerprint);
  };
}
