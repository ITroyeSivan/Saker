// Saker 统一出站策略（跨插件契约，零依赖）。
//
// 为什么要有它：Saker 原先只有"模型代理这一条出站"做了脱敏与审计，
// 知识包 git 同步、MCP 包下载这类**基础设施出站**没有统一闸门——
// 护网/OPSEC 场景下需要一个总闸，且每次放行/拦截都要留痕。
//
// 契约（**策略文件的唯一真源**，别的插件按这个文件判断，不互相 import）：
//   $DSH_HOME/saker-egress/policy.json
//     { "version": 1, "mode": "allow" | "allowlist" | "frozen",
//       "allowHosts": ["github.com", "registry.npmjs.org"], "updatedAt": "..." }
//   $DSH_HOME/saker-egress/audit.jsonl   —— 每次判定一行（超限轮转，只留最近若干条）
//
// 对标来源（2026-09-18 读源码，不靠印象）：openai/codex 的 network policy —
//   domains 用 `{ host: "allow" | "deny" }` 的权限映射、`managedAllowedDomainsOnly`
//   的"只认托管白名单"模式、以及每次判定带 reason 的审计
//   （`not_allowed` / `not_allowed_local` / `method_not_allowed`）。
//   本模块保留同样的三件事：权限映射语义、冻结档、判定带原因且留痕；
//   但**不引入 OS 级沙箱**（Saker 明确不做隔离执行面）。
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 出站类别：infra=基础设施（模型/知识同步/包下载）；target=目标流量（渗透作业本身）。 */
export const EGRESS_KINDS = ['infra', 'target']
/** 策略档位：allow=不拦；allowlist=只放白名单；frozen=基础设出站全冻。 */
export const EGRESS_MODES = ['allow', 'allowlist', 'frozen']
/** 单条审计行上限与文件轮转阈值（护网长跑不涨爆磁盘）。 */
export const AUDIT_MAX_BYTES = 256 * 1024
export const AUDIT_KEEP_LINES = 400

export function egressRoot(home) {
	return join(home || process.env.DSH_HOME || join(homedir(), '.dsh'), 'saker-egress')
}
export function policyPath(home) {
	return join(egressRoot(home), 'policy.json')
}
export function auditPath(home) {
	return join(egressRoot(home), 'audit.jsonl')
}

/** 默认策略：不拦（fail-open），但判定原因写清楚，便于事后区分"放行"和"没配策略"。 */
export function defaultPolicy() {
	return { version: 1, mode: 'allow', allowHosts: [], updatedAt: '' }
}

function normalizeHost(value) {
	return String(value ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
}

/** 读策略；文件缺失/损坏一律回默认档，并把原因标出来（不抛，调用方在生产路径上）。 */
export function readPolicy(home) {
	const file = policyPath(home)
	try {
		const raw = JSON.parse(readFileSync(file, 'utf8'))
		const mode = EGRESS_MODES.includes(raw?.mode) ? raw.mode : 'allow'
		const allowHosts = Array.isArray(raw?.allowHosts)
			? raw.allowHosts.map(normalizeHost).filter(Boolean)
			: []
		return { policy: { version: 1, mode, allowHosts, updatedAt: String(raw?.updatedAt ?? '') }, source: 'file' }
	} catch (error) {
		const reason = existsSync(file) ? 'policy-invalid' : 'policy-missing'
		return { policy: defaultPolicy(), source: reason, error: error instanceof Error ? error.message : String(error) }
	}
}

/** 写策略（同盘临时文件 + rename；调用方只管内容合法性）。 */
export function writePolicy(home, next) {
	const mode = EGRESS_MODES.includes(next?.mode) ? next.mode : null
	if (!mode) throw new Error(`未知出站策略档位：${next?.mode}（可选 ${EGRESS_MODES.join(' / ')}）`)
	const allowHosts = Array.isArray(next?.allowHosts)
		? [...new Set(next.allowHosts.map(normalizeHost).filter(Boolean))].sort()
		: []
	const policy = { version: 1, mode, allowHosts, updatedAt: new Date().toISOString() }
	const file = policyPath(home)
	mkdirSync(dirname(file), { recursive: true })
	const tmp = `${file}.tmp-${process.pid}`
	writeFileSync(tmp, JSON.stringify(policy, null, 2) + '\n', 'utf8')
	renameSync(tmp, file)
	return policy
}

/** 回环地址（本机代理/本机服务）不算出站，任何档位都放行。 */
export function isLoopbackHost(host) {
	const h = normalizeHost(host)
	if (h === '' ) return false
	if (h === 'localhost' || h.endsWith('.localhost')) return true
	if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true
	return /^127\./.test(h)
}

/** 白名单匹配：域名按标签后缀（`github.com` 命中 `api.github.com`），IP 只精确匹配。 */
export function hostAllowed(host, allowHosts) {
	const h = normalizeHost(host)
	if (h === '') return false
	for (const raw of allowHosts || []) {
		const rule = normalizeHost(raw)
		if (rule === '') continue
		if (rule === h) return true
		if (/^[0-9a-f:.]+$/.test(rule)) continue // IP 规则不做后缀匹配
		if (h.endsWith(`.${rule}`)) return true
	}
	return false
}

/**
 * 判定一次出站。
 * @returns {{ decision: 'allow'|'deny', reason: string, mode: string }}
 *   reason ∈ target-traffic / loopback / allow-all / allowlisted / not_allowed / infra_frozen
 */
export function evaluateEgress({ kind = 'infra', host = '', local = false, policy } = {}) {
	const effective = policy && EGRESS_MODES.includes(policy.mode) ? policy : defaultPolicy()
	const mode = effective.mode
	if (kind === 'target') return { decision: 'allow', reason: 'target-traffic', mode }
	if (local) return { decision: 'allow', reason: 'local-source', mode }
	if (isLoopbackHost(host)) return { decision: 'allow', reason: 'loopback', mode }
	if (mode === 'allow') return { decision: 'allow', reason: 'allow-all', mode }
	if (mode === 'frozen') return { decision: 'deny', reason: 'infra_frozen', mode }
	return hostAllowed(host, effective.allowHosts)
		? { decision: 'allow', reason: 'allowlisted', mode }
		: { decision: 'deny', reason: 'not_allowed', mode }
}

/** 从 URL 取 host（取不到按空串，判定里会落到 not_allowed）。 */
export function hostOf(url) {
	try { return normalizeHost(new URL(String(url)).hostname) } catch { return '' }
}

/**
 * 判断一个来源是"网络目的地"还是"本地路径"。
 * 本地路径（Windows 盘符、POSIX 路径）不走网络，冻结档也不该拦；
 * `git@github.com:org/repo.git` 这种 scp 语法没有 scheme，但**是**网络目的地。
 */
export function describeSource(source) {
	const raw = String(source ?? '').trim()
	if (raw === '') return { host: '', local: true }
	if (/^[a-zA-Z]:[\\/]/.test(raw)) return { host: '', local: true }
	if (raw.startsWith('/') || raw.startsWith('./') || raw.startsWith('../')) return { host: '', local: true }
	const scp = /^[^/@\\\s]+@([^:/\s]+):/.exec(raw)
	if (scp) return { host: normalizeHost(scp[1]), local: isLoopbackHost(scp[1]) }
	try {
		const url = new URL(raw)
		if (url.protocol === 'file:') return { host: '', local: true }
		const host = normalizeHost(url.hostname)
		return { host, local: isLoopbackHost(host) }
	} catch {
		// 解析不了又没有本地路径特征：按"未知网络目的地"处理，从严。
		return { host: '', local: false }
	}
}

function rotateIfNeeded(file) {
	try {
		if (statSync(file).size < AUDIT_MAX_BYTES) return
		renameSync(file, `${file}.1`)
	} catch { /* 文件不存在或轮转失败都不该影响判定 */ }
}

/** 记一行判定（失败静默——审计不能反过来打断生产路径）。 */
export function appendAudit(home, entry) {
	try {
		const file = auditPath(home)
		mkdirSync(dirname(file), { recursive: true })
		rotateIfNeeded(file)
		const row = {
			at: new Date().toISOString(),
			plugin: String(entry?.plugin ?? ''),
			kind: EGRESS_KINDS.includes(entry?.kind) ? entry.kind : 'infra',
			host: normalizeHost(entry?.host),
			decision: entry?.decision === 'deny' ? 'deny' : 'allow',
			reason: String(entry?.reason ?? ''),
			mode: EGRESS_MODES.includes(entry?.mode) ? entry.mode : 'allow',
			note: String(entry?.note ?? '').slice(0, 160),
		}
		appendFileSync(file, JSON.stringify(row) + '\n', 'utf8')
		return row
	} catch { return null }
}

/** 读最近 N 条判定（面板/报告用）。 */
export function readAudit(home, limit = 50) {
	try {
		const lines = readFileSync(auditPath(home), 'utf8').split('\n').filter(Boolean)
		return lines.slice(-Math.max(1, Math.min(Number(limit) || 50, AUDIT_KEEP_LINES)))
			.map((line) => { try { return JSON.parse(line) } catch { return null } })
			.filter(Boolean)
	} catch { return [] }
}

/**
 * 一步到位：读策略 → 判定 → 留痕。生产路径只需要调这个。
 * @returns {{ decision: 'allow'|'deny', reason: string, mode: string, policySource: string }}
 */
export function checkEgress(home, { plugin = '', kind = 'infra', host = '', local = false, note = '' } = {}) {
	const { policy, source } = readPolicy(home)
	const verdict = evaluateEgress({ kind, host, local, policy })
	appendAudit(home, { plugin, kind, host, note, ...verdict })
	return { ...verdict, policySource: source }
}
