import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildAskListener,
  buildSecurityGuard,
  installSecurityGuard,
  isWritable,
  scanAsk,
  scanDangerous,
  scanRate,
} from '../lib/security-guard.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const tmp = fs.mkdtempSync(path.join(root, '..', '_ref', 'tmp', 'security-guard-'))
const workspace = path.join(tmp, 'workspace')
fs.mkdirSync(path.join(workspace, 'reports'), { recursive: true })

const agent = { ctx: {}, session: { header: { cwd: workspace } } }
const mode = () => 'pentest'
const guard = buildSecurityGuard({ resolveMode: mode, appendLog: () => {} })
const ask = buildAskListener({ resolveMode: mode, appendLog: () => {} })
let checks = 0
const ok = (name, condition) => {
  checks += 1
  assert.ok(condition, name)
  console.log('ok   ' + name)
}

try {
  ok('非安全模式不拦截', buildSecurityGuard({ resolveMode: () => 'chat', appendLog: () => {} })({
    name: 'write',
    arguments: { file_path: path.join(os.tmpdir(), 'outside.txt') },
    agent: { ...agent, ctx: {}, session: { header: { cwd: workspace } } },
  }) === undefined)

  ok('工作区外写入被拦截', /工作区之外/.test(guard({
    name: 'write',
    arguments: { file_path: path.join(os.tmpdir(), 'outside.txt') },
    agent,
  })))

  ok('工作区内写入放行', guard({
    name: 'write',
    arguments: { file_path: path.join(workspace, 'notes', 'a.md') },
    agent,
  }) === undefined)

  ok('reports 写入不再依赖 gate-log', guard({
    name: 'write',
    arguments: { file_path: path.join(workspace, 'reports', 'r.md'), content: 'report' },
    agent,
  }) === undefined)

  ok('edit 同样受写入边界约束', /工作区之外/.test(guard({
    name: 'edit',
    arguments: { path: path.join(os.tmpdir(), 'outside.txt'), old_text: 'a', new_text: 'b' },
    agent,
  })))

  ok('根级 rm 被拦截', /大范围删除/.test(scanDangerous('rm -rf /')))
  ok('pwsh 根级递归删除被拦截', /Windows 根级/.test(scanDangerous('Remove-Item -LiteralPath C:\\ -Recurse -Force')))
  ok('pwsh 用户目录递归删除被拦截', /Windows 根级/.test(scanDangerous('Remove-Item $env:USERPROFILE -Recurse -Force')))
  ok('磁盘破坏操作被拦截', /磁盘\/分区/.test(scanDangerous('Format-Volume -DriveLetter D')))
  ok('DROP TABLE 被拦截', /破坏数据完整性/.test(scanDangerous('mysql -e "DROP TABLE users"')))
  ok('全端口 nmap 无速率被拦截', /全端口 nmap/.test(scanRate('nmap -p- 127.0.0.1')))
  ok('带速率 nmap 放行', scanRate('nmap -p- --max-rate 300 127.0.0.1') === undefined)
  ok('裸 ffuf 被拦截', /裸 ffuf/.test(scanRate('ffuf -u http://127.0.0.1/FUZZ -w words.txt')))
  ok('masscan 超速被拦截', /超保守上限/.test(scanRate('masscan --rate 5000 10.0.0.0/24')))

  const redteamGuard = buildSecurityGuard({ resolveMode: () => 'redteam', appendLog: () => {} })
  const brief = path.join(workspace, 'task-briefs', 'b.md')
  ok('任务书缺依据被拦截', /依据/.test(redteamGuard({
    name: 'write',
    arguments: { file_path: brief, content: '# 任务书\n执行 A' },
    agent,
  })))
  ok('任务书带依据放行', redteamGuard({
    name: 'write',
    arguments: { file_path: brief, content: '# 任务书\n依据：用户目标\n执行 A' },
    agent,
  }) === undefined)

  ok('熔断标记拦截全部工具', /全局熔断/.test(buildSecurityGuard({
    resolveMode: mode,
    appendLog: () => {},
    isKillTripped: () => true,
  })({ name: 'write', arguments: { file_path: path.join(workspace, 'a.md') }, agent })))

  ok('账号变更进入审批', /账号\/权限体系/.test(scanAsk('useradd demo').reason))
  ok('pwsh 本地账号变更进入审批', /账号\/权限体系/.test(scanAsk('New-LocalUser -Name demo').reason))
  ok('防火墙变更进入审批', /防火墙/.test(scanAsk('iptables -F').reason))
  ok('pwsh 防火墙变更进入审批', /防火墙/.test(scanAsk('New-NetFirewallRule -DisplayName demo').reason))
  ok('flood 压测进入审批', /flood/.test(scanAsk('hping3 --flood 127.0.0.1').reason))
  ok('普通命令不进入审批', scanAsk('curl -s http://127.0.0.1/') === undefined)

  const allowDownstream = async () => ({ kind: 'allow' })
  const denyDownstream = async () => ({ kind: 'deny', reason: 'downstream' })
  const askExec = { name: 'bash', arguments: { command: 'useradd demo' }, agent }
  const pwshAskExec = { name: 'pwsh', arguments: { command: 'New-LocalUser -Name demo' }, agent }
  const asked = await ask(askExec, allowDownstream)
  ok('下游 allow 时升级为 ask', asked.kind === 'ask' && /账号\/权限体系/.test(asked.reason))
  const denied = await ask(askExec, denyDownstream)
  ok('下游 deny 不被 ask 覆盖', denied.kind === 'deny' && denied.reason === 'downstream')
  const pwshAsked = await ask(pwshAskExec, allowDownstream)
  ok('pwsh 账号变更同样升级为 ask', pwshAsked.kind === 'ask' && /账号\/权限体系/.test(pwshAsked.reason))
  const notBash = await ask({ name: 'write', arguments: { file_path: path.join(workspace, 'a.md') }, agent }, allowDownstream)
  ok('非 bash 工具不进入 ask', notBash.kind === 'allow')

  let capturedGuard
  let capturedAsk
  const fakeCtx = {
    tools: { guard(fn) { capturedGuard = fn; return () => {} } },
    on(event, fn) { if (event === 'tools/pre-execute') capturedAsk = fn; return () => {} },
    effect(fn) { return fn() },
    inject(_services, fn) { return fn(this) },
  }
  installSecurityGuard(fakeCtx, { resolveMode: mode })
  ok('根包装配注册唯一 guard', typeof capturedGuard === 'function')
  ok('根包装配注册 ask 监听', typeof capturedAsk === 'function')
  ok('注册后的 guard 真实拦截', /工作区之外/.test(capturedGuard({
    name: 'write',
    arguments: { file_path: path.join(os.tmpdir(), 'outside.txt') },
    agent,
  })))
  installSecurityGuard(fakeCtx, { resolveMode: mode })
  ok('重复装配不重复注册', fakeCtx.__sakerSecurityGuardInstalled === true)

  ok('允许目录内写入放行', isWritable(path.join(tmp, 'allow', 'a.md'), workspace, [path.join(tmp, 'allow')]))
  console.log(`ok   ${checks} security guard checks`)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
