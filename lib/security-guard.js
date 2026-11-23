import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sessionWorkingDirectory } from './working-directory.mjs'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

export const SECURITY_MODES = new Set([
  'pentest',
  'code-audit',
  'binary-analysis',
  'attack-defense',
  'av-evasion',
  'redteam',
  'incident-response',
  'cloud-security',
  'ctf-solver',
])

const WRITE_TOOLS = new Set(['write', 'edit'])
const SHELL_TOOLS = new Set(['bash', 'pwsh', 'powershell', 'cmd', 'shell', 'sh', 'zsh'])
const TASK_BRIEF_ANCHOR_RE = /^[ \t]*(?:[-*][ \t]*)?(?:依据|锚点)[：:]/m

/** Resolve a write target against the live session workspace, not the Host cwd. */
export function resolveTargetPath(target, workspace) {
  const raw = typeof target === 'string' ? target : String(target ?? '')
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workspace ?? '.', raw)
}

/** True when the target stays inside the workspace or one explicit allow dir. */
export function isWritable(target, workspace, allowDirs = []) {
  const resolved = resolveTargetPath(target, workspace)
  return [workspace, ...allowDirs].some((dir) => {
    if (!dir) return false
    const rel = path.relative(path.resolve(dir), resolved)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  })
}

/** redteam task briefs must keep a "依据/锚点" line. */
export function isTaskBriefPath(target, workspace) {
  const rel = path.relative(path.resolve(workspace), resolveTargetPath(target, workspace))
  return !rel.startsWith('..') && rel.split(path.sep)[0] === 'task-briefs' && /\.md$/i.test(rel)
}

/** Conservative destructive-command denials. */
export function scanDangerous(command) {
  const compact = String(command ?? '').replace(/\\\n/g, ' ').replace(/\s+/g, ' ')
  if (/(^|[;&|]\s*)rm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+(\/|~|\$HOME)(\/|\s|$)/.test(compact)) {
    return '大范围删除（rm 涉及 / 或 ~ 根级路径）被确定性门禁拦截：删除范围必须限定在任务工作区内；确需删除请先列出清单征得用户批准（ask_user_question），再逐项执行。降级替代：cd 到工作区后限定路径逐项删除，或只生成删除清单交由用户手动执行。'
  }
  const windowsDelete = /\b(Remove-Item|ri|del|erase|rd|rmdir)\b/i.test(compact)
  const recursiveDelete = /(?:-Recurse\b|(?:^|\s)-r\b)/i.test(compact)
  const rootTarget = /(?:[A-Za-z]:\\(?:\s|$|\*)|%USERPROFILE%|\$env:USERPROFILE|\$HOME|~)/i.test(compact)
  if (windowsDelete && recursiveDelete && rootTarget) {
    return 'Windows 根级/用户目录递归删除被确定性门禁拦截：删除范围必须限定在任务工作区内；确需删除请先列出绝对路径清单征得用户批准（ask_user_question），再逐项执行。降级替代：先 Get-ChildItem 列清单，确认路径后用 Remove-Item -LiteralPath 逐项删除。'
  }
  if (/\b(Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition)\b/i.test(compact)) {
    return '磁盘/分区破坏性操作被拦截：这类操作会破坏主机或目标磁盘，必须由用户在隔离环境手动执行，不能由模型直接调用。'
  }
  if (/\b(DROP\s+TABLE|DROP\s+DATABASE|TRUNCATE\s+TABLE)\b/i.test(compact) && !/^\s*#/.test(compact)) {
    return '破坏数据完整性操作（DROP/TRUNCATE）被拦截：负面清单禁止破坏数据完整性；验证类需求请用 SELECT 复现影响或在对靶场快照说明并获用户批准后进行。降级替代：SELECT 只读查询复现影响；或靶场快照上验证并注明环境。'
  }
  if (/\b(shutdown\b|reboot\b|Stop-Computer\b|Restart-Computer\b|systemctl\s+(stop|restart|disable)\b|service\s+\w+\s+(stop|restart)\b|kill\s+-9\s+1\b)/i.test(compact)) {
    return '停机/重启/杀服务属变更性操作，被拦截：需先询问用户（ask_user_question 呈报影响与理由），获批准后执行。降级替代：systemctl status/日志只读收集根因，处置步骤列入建议清单由用户执行。'
  }
  const fundsUrl = /(pay|refund|withdraw|order|recharge|transfer)[a-z]*\/|[?&](out_trade_no|trade_no|order_id)=/i
  const isPost = /(\bcurl(?:\.exe)?\b[^|;&]*(-X\s*(POST|PUT)|--data(-raw|-binary)?\s|\s-d\s))|(\bwget\b[^|;&]*--post-data)|(\bInvoke-(?:WebRequest|RestMethod)\b[^|;&]*-Method\s+(POST|PUT))/i.test(compact)
  if (isPost && fundsUrl.test(compact)) {
    return '资金类接口写请求（支付/退款/提现/下单）被拦截：只生成重放计划呈报用户（ask_user_question），获明确批准后才执行。降级替代：生成只读重放计划（curl 命令+预期响应比对）呈报用户，不实际发送。'
  }
  return undefined
}

/** Rate discipline for full-port scans and unbounded fuzzing. */
export function scanRate(command) {
  const compact = String(command ?? '').replace(/\\\n/g, ' ').replace(/\s+/g, ' ')
  if (/\bnmap\b/.test(compact) && /(-p-\s|--p\s*1-65535|-p\s*1-65535)/.test(compact) && !/(--max-rate|-T[0-3]\b|--min-rate)/.test(compact)) {
    return '全端口 nmap 未带速率控制被拦截（速率纪律）：加 --max-rate（如 --max-rate 300）或 -T2/-T3 后重试；WAF/生产目标从严。降级替代：--top-ports 100 常见端口概览；或先被动侦察（子域/DNS/公开情报）再定向验证。'
  }
  const massRate = compact.match(/--rate\s+(\d+)/)
  if (/\bmasscan\b/.test(compact) && massRate && Number(massRate[1]) > 1000) {
    return `masscan --rate ${massRate[1]} 超保守上限（1000）被拦截：下调 --rate（500 起步）后重试。降级替代：--rate 500 并缩小到授权网段；或改 nmap -sS --max-rate 300 定向扫描。`
  }
  if (/(^|\s|\/)ffuf\b/.test(compact) && /-u\s/.test(compact) && !/-rate\b/.test(compact)) {
    return '裸 ffuf 未带 -rate 被拦截：加 -rate 50（保守默认）重试，或改用已封装的 ffuf_fuzz 工具（速率纪律/防盲打/证据留痕内置）。降级替代：-rate 50 重试，或改 ffuf_fuzz 封装工具（防盲打/证据落盘内置）。'
  }
  return undefined
}

/** Reversible-but-sensitive changes become host-native approval requests. */
export function scanAsk(command) {
  const compact = String(command ?? '').replace(/\\\n/g, ' ').replace(/\s+/g, ' ')
  if (/\b(useradd|usermod|userdel|adduser|deluser)\b/.test(compact)
    || /\b(New-LocalUser|Set-LocalUser|Remove-LocalUser|Add-LocalGroupMember|Remove-LocalGroupMember|net\s+user\b[^|;&]*\/(?:add|delete))\b/i.test(compact)
    || /(^|[|;&]|sudo )\s*(passwd|chpasswd)\b/.test(compact)
    || /\b(mysql|mariadb|psql|sqlplus|sqlite3)\b[^|;&]*\b(GRANT\s+|REVOKE\s+|CREATE\s+USER|DROP\s+USER|ALTER\s+USER)\b/i.test(compact)) {
    return { reason: '账号/权限体系变更类命令需人工审批：改的是目标环境的身份与授权面（不可轻动、影响所有后续访问）——批准即执行，拒绝则换只读方案（如 SELECT 验证权限现状）。' }
  }
  if (/\biptables\s+(-F\b|--flush)|\bnft\s+(add|delete|flush)\b|\bufw\s+(enable|disable|allow|deny|insert|delete)\b|\b(New|Set|Remove)-NetFirewallRule\b|\bnetsh\s+advfirewall\b/i.test(compact)) {
    return { reason: '防火墙/安全规则修改需人工审批：直接改变目标网络暴露面（可能自断回连或放大暴露）——批准即执行，拒绝则先 iptables -L/nft list ruleset 只读核对再呈报变更清单。' }
  }
  if (/\b(hping3|hping)\b[^|;&]*\b--flood\b|--flood\b|\bslowloris\b|\bsynflood\b/i.test(compact)) {
    return { reason: 'flood 类压测命令需人工审批：显式洪水语义（--flood/slowloris/synflood）可能构成对目标的服务压力——批准即执行（确在授权范围），拒绝则改用带速率上限的常规验证。' }
  }
  return undefined
}

export function killMarkerPaths() {
  const explicit = process.env.SAKER_KILL_SWITCH_FILE || process.env.DSH_KILL_SWITCH_FILE
  if (explicit) return [explicit]
  return [
    path.join(DSH_HOME, 'saker', 'KILL'),
    path.join(DSH_HOME, 'sec-enforce', 'KILL'),
  ]
}

export function killSwitchTripped() {
  return killMarkerPaths().some((file) => {
    try { return fs.existsSync(file) } catch { return false }
  })
}

function allowDirsFromEnv() {
  return String(process.env.SAKER_GUARD_ALLOW_DIRS || '')
    .split(path.delimiter)
    .map((dir) => dir.trim())
    .filter(Boolean)
}

export function appendGuardLog(workspace, line) {
  if (!workspace) return
  fs.appendFileSync(path.join(workspace, 'enforce-log.md'), line)
}

function logRejection(workspace, mode, name, reason, appendLog = appendGuardLog) {
  try {
    appendLog(workspace, `| ${new Date().toISOString()} | ${mode} | ${name} | ${String(reason).split('：')[0]} |\n`)
  } catch {
    // Logging is best-effort; the denial itself already took effect.
  }
}

export function buildSecurityGuard({
  resolveMode,
  appendLog = appendGuardLog,
  allowDirs = allowDirsFromEnv(),
  isKillTripped = killSwitchTripped,
} = {}) {
  return function securityGuard(exec) {
    const agent = exec?.agent
    if (!agent) return undefined
    if (isKillTripped()) {
      return `全局熔断已触发：所有工具执行暂停（一键停止）。恢复方法：移除标记文件 ${killMarkerPaths()[0]}。熔断期间仅回答问题，不执行任何操作。`
    }
    const mode = typeof resolveMode === 'function' ? resolveMode(agent) : undefined
    if (!mode || !SECURITY_MODES.has(mode)) return undefined
    const workspace = sessionWorkingDirectory(agent.ctx, agent.session)
    if (!workspace) return undefined
    let reason
    if (WRITE_TOOLS.has(exec.name)) {
      const target = exec.arguments?.file_path ?? exec.arguments?.path
      if (typeof target === 'string' && target) {
        if (!isWritable(target, workspace, allowDirs)) {
          reason = `写入目标在任务工作区之外（${path.resolve(workspace)}）被拦截：安全预设写操作限工作区内（工具级最小权限）；确需写外部路径，先征得用户批准并在会话中说明。`
        } else if (mode === 'redteam' && typeof exec.arguments?.content === 'string' && isTaskBriefPath(target, workspace) && !TASK_BRIEF_ANCHOR_RE.test(exec.arguments.content)) {
          reason = '任务书缺「依据：」锚点行被拦截：写明凭什么开这单——用户目标原句引用 / 已收集材料落盘路径 / 关联成果 id（顶层任务=用户目标即锚）。在任务书末尾补一行「依据：…」后重写。'
        }
      }
    } else if (SHELL_TOOLS.has(exec.name) && typeof exec.arguments?.command === 'string') {
      reason = scanDangerous(exec.arguments.command) ?? scanRate(exec.arguments.command)
    }
    if (reason !== undefined) logRejection(workspace, mode, exec.name, reason, appendLog)
    return reason
  }
}

export function buildAskListener({ resolveMode, appendLog = appendGuardLog } = {}) {
  return async function guardAskListener(exec, next) {
    const agent = exec?.agent
    if (!agent) return next()
    const mode = typeof resolveMode === 'function' ? resolveMode(agent) : undefined
    if (!mode || !SECURITY_MODES.has(mode)) return next()
    if (!SHELL_TOOLS.has(exec.name) || typeof exec.arguments?.command !== 'string') return next()
    const ask = scanAsk(exec.arguments.command)
    if (!ask) return next()
    const downstream = await next()
    if (downstream?.kind !== 'allow') return downstream
    const workspace = sessionWorkingDirectory(agent.ctx, agent.session)
    try {
      appendLog(workspace, `| ${new Date().toISOString()} | ${mode} | ask | ${exec.name} | ${ask.reason.split('：')[0]} |\n`)
    } catch {
      // Logging is best-effort; approval still applies.
    }
    return { kind: 'ask', reason: ask.reason }
  }
}

/** Register the root guard once. No separate sec-enforce hook remains. */
export function installSecurityGuard(ctx, options = {}) {
  if (!ctx || ctx.__sakerSecurityGuardInstalled) return
  const install = (scoped) => {
    const target = scoped || ctx
    if (target.__sakerSecurityGuardInstalled) return
    const tools = target.tools ?? target.get?.('tools')
    if (!tools?.guard) return
    const presets = target.agentPresets ?? target.get?.('agentPresets')
    const resolveMode = options.resolveMode || ((agent) => {
      try { return presets?.composedPreset?.(agent?.ctx) } catch { return undefined }
    })
    const register = () => {
      const disposeGuard = tools.guard(buildSecurityGuard({ resolveMode, allowDirs: options.allowDirs }))
      const disposeAsk = typeof target.on === 'function'
        ? target.on('tools/pre-execute', buildAskListener({ resolveMode }))
        : undefined
      return () => {
        try { disposeGuard?.() } catch { /* already disposed */ }
        try { disposeAsk?.() } catch { /* already disposed */ }
      }
    }
    target.__sakerSecurityGuardInstalled = true
    if (typeof target.effect === 'function') target.effect(() => register())
    else register()
  }
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['tools'], install)
      return
    } catch {
      // Fall through for minimal test hosts without an injection helper.
    }
  }
  install(ctx)
}

export { TASK_BRIEF_ANCHOR_RE }
