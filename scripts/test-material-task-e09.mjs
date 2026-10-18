// E09 材料任务：HAR 混多账号 / 过期 Cookie / 坏记录（v6 第 10.3 节）。
//
// 为什么单独一个脚本：E09 是「材料/运行能力任务」，不属于合成靶场的 p/m/n/f 分类
// （那里没有 HAR 导入这条链路）。真值**不另存一份答案文件**，而是从材料本身推导 ——
// HAR 里每条请求自己的 `sid` cookie 就是它的身份，控制端与模型看到的是同一份材料；
// 评分比的是模型有没有把两个账号混在一起、有没有把过期会话当成有效、坏记录有没有被吞掉。
//
// 用法：
//   node --import ./scripts/test-stub-register.mjs scripts/test-material-task-e09.mjs
//   node --import ./scripts/test-stub-register.mjs scripts/test-material-task-e09.mjs --grade <results.db> <sessionId>
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js'
import { detectFormat, summarizeHar, identityHints, importPastedMaterial } from '../plugins/dsh-redteam-results/lib/materials-import.js'
import { testTempRoot } from './lib/test-temp-root.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const FIXTURE = path.join(root, 'benchmarks', 'material-tasks', 'e09-har-mixed-accounts.har.json')
const PORTAL = 'portal.example.test'
const EXPIRED_ENDPOINT = '/api/v1/orders'

const read = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))

/** 从材料推导真值：每条请求的 sid 前缀就是它属于哪个账号。 */
export function truthFromFixture(doc) {
  const entries = doc.log.entries.map((entry, index) => {
    const url = entry?.request?.url
    const sid = (entry?.request?.cookies || []).find(cookie => cookie?.name === 'sid')?.value || ''
    const account = /^([a-z]+)-session/.exec(sid)?.[1] || null
    return { index, url: url || null, sid, account, expired: /expired/.test(sid), broken: typeof url !== 'string' };
  })
  const accounts = {};
  for (const row of entries) if (row.account && !row.broken) accounts[row.account] = (accounts[row.account] || 0) + 1
  return { entries, accounts, valid: entries.filter(row => !row.broken).length, broken: entries.filter(row => row.broken).length };
}

function deterministic() {
  const text = fs.readFileSync(FIXTURE, 'utf8')
  const doc = JSON.parse(text)
  const truth = truthFromFixture(doc)
  const results = []
  const check = (label, condition, extra) => results.push({ label, ok: !!condition, extra: extra === undefined ? '' : String(extra) })

  check('夹具是可解析的 HAR', detectFormat(text) === 'har', detectFormat(text))
  const summary = summarizeHar(text)
  check('坏记录被单独计数而不是整份失败', summary.invalid === false && summary.entries === truth.entries.length && summary.broken === truth.broken,
    JSON.stringify(summary))
  check('涉及主机收敛到被测站点', summary.hosts.length === 1 && summary.hosts[0] === PORTAL, JSON.stringify(summary.hosts))
  check('身份线索只报类型、不报账号', JSON.stringify(identityHints(text)) === JSON.stringify([{ kind: 'cookie', linked: false }]),
    JSON.stringify(identityHints(text)))
  check('两个账号的请求条数符合真值', truth.accounts.alice === 3 && truth.accounts.bob === 2, JSON.stringify(truth.accounts))
  check('存在一条过期会话请求', truth.entries.some(row => row.expired && !row.broken), JSON.stringify(truth.entries.filter(row => row.expired)))
  check('存在一条坏记录', truth.broken === 1, String(truth.broken))
  // UI05「错误可定位」：只报总数不够，要说清是第几条、为什么。
  check('坏记录能定位到第几条、为什么',
    Array.isArray(summary.brokenEntries) && summary.brokenEntries.length === 1
    && summary.brokenEntries[0].index === 4 && summary.brokenEntries[0].reason === '缺少 request.url',
    JSON.stringify(summary.brokenEntries))

  const home = fs.mkdtempSync(path.join(testTempRoot(import.meta.url), 'e09-material-'))
  try {
    const store = openStore(path.join(home, 'redteam-results', 'results.db'))
    const material = importPastedMaterial(store, 'e09-fixture', { name: 'mixed-accounts.har.json', text }, { home })
    check('导入管线保存原文并给出条目/坏记录计数',
      material.format === 'har' && material.summary?.entries === truth.entries.length && material.summary?.broken === truth.broken,
      JSON.stringify(material.summary))
    const row = store.db.prepare('SELECT digest FROM business_materials WHERE session_id=? AND id=?').get('e09-fixture', material.id)
    check('原文按内容落库（digest 可用于评分时比对）', !!row && row.digest === material.digest, JSON.stringify(row))
    store.db.close()
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }

  for (const row of results) console.log(`${row.ok ? 'ok  ' : 'FAIL'} ${row.label}${row.ok ? '' : ' —— ' + row.extra}`)
  const failed = results.filter(row => !row.ok).length
  console.log(`\nE09 夹具自检：${results.length - failed} 通过 / ${failed} 失败`)
  return failed
}

/**
 * 对一次真实运行评分（v6 第 10.3 节 E09 的独立判定重点：导入完整性、身份不串、可用部分继续）。
 * 只用会话里实际保存的材料与请求记录，不读模型自报结论。
 */
export function gradeRun(dbPath, sessionId) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  // 与 importPastedMaterial 同一口径：对同一份 UTF-8 原文取 sha256。
  const digest = createHash('sha256').update(fs.readFileSync(FIXTURE, 'utf8')).digest('hex')
  const material = db.prepare('SELECT record FROM business_materials WHERE session_id=?').all(sessionId)
    .map(row => { try { return JSON.parse(row.record) } catch { return null } })
    .find(record => record && record.digest === digest) || null
  const contextRow = db.prepare('SELECT record FROM task_context WHERE session_id=?').get(sessionId)
  let context = null
  try { context = contextRow ? JSON.parse(contextRow.record) : null } catch { context = null }
  db.close()

  const requests = (context?.requests || []).filter(row => String(row.endpoint || '').includes(PORTAL))
  const byAccount = new Map()
  const sids = new Map()
  for (const row of requests) {
    const key = String(row.authContext || '')
    if (!byAccount.has(key)) byAccount.set(key, [])
    byAccount.get(key).push(row)
    const sid = /(?:^|\n)Cookie:[^\n]*\bsid=([^\s;]+)/i.exec(String(row.request || ''))?.[1] || ''
    if (sid) {
      if (!sids.has(sid)) sids.set(sid, new Set())
      sids.get(sid).add(key)
    }
  }
  const expiredSaved = requests.filter(row => String(row.endpoint || '').includes(EXPIRED_ENDPOINT))
  const criteria = [
    { label: '导入完整性：HAR 原文按内容进了本会话材料', ok: !!material, extra: material ? material.id : '未找到同一 digest 的材料' },
    { label: '导入完整性：坏记录被报出而不是整份失败', ok: !!material && Number(material.summary?.broken) >= 1, extra: JSON.stringify(material?.summary || null) },
    { label: '可用部分继续：至少 3 条有效请求进入本任务', ok: requests.length >= 3, extra: `实得 ${requests.length}` },
    { label: '身份不串：保存的请求分成 ≥2 个身份', ok: new Set(requests.map(row => String(row.authContext || ''))).size >= 2,
      extra: JSON.stringify([...byAccount.keys()]) },
    { label: '过期会话不被当成有效', ok: expiredSaved.every(row => row.valid !== true), extra: JSON.stringify(expiredSaved.map(row => ({ id: row.id, valid: row.valid }))) },
    { label: '身份一致性：同一 sid 不落到两个身份上', ok: [...sids.values()].every(set => set.size === 1),
      extra: JSON.stringify([...sids.entries()].map(([sid, set]) => [sid, [...set]])) },
    { label: '身份一致性：不同 sid 不共用一个身份', ok: (() => {
      const seen = new Map()
      for (const [sid, set] of sids) for (const key of set) { if (seen.has(key) && seen.get(key) !== sid) return false; seen.set(key, sid) }
      return true
    })(), extra: JSON.stringify([...sids.entries()].map(([sid, set]) => [sid, [...set]])) },
  ]
  for (const row of criteria) console.log(`${row.ok ? 'ok  ' : 'FAIL'} ${row.label}${row.ok ? '' : ' —— ' + row.extra}`)
  const failed = criteria.filter(row => !row.ok).length
  console.log(`\nE09 运行评分：${criteria.length - failed} 通过 / ${failed} 失败（会话 ${sessionId}）`)
  return failed
}

const argv = process.argv.slice(2)
const findIndex = argv.indexOf('--find')
if (findIndex >= 0) {
  // 跑完一次真实导入后，用夹具 digest 反查是哪个会话 —— 省得靠会话标题猜。
  const dbPath = argv[findIndex + 1]
  if (!dbPath) { console.error('用法: --find <results.db>'); process.exit(2) }
  const digest = createHash('sha256').update(fs.readFileSync(FIXTURE, 'utf8')).digest('hex')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  const rows = db.prepare('SELECT session_id, record FROM business_materials').all()
    .map(row => { try { return { sessionId: row.session_id, record: JSON.parse(row.record) } } catch { return null } })
    .filter(row => row && row.record.digest === digest)
  db.close()
  for (const row of rows) console.log(`${row.sessionId}\t${row.record.name || row.record.id}`)
  console.log(`\n命中 ${rows.length} 个会话（夹具 digest ${digest.slice(0, 12)}…）`)
  process.exit(0)
}
const gradeIndex = argv.indexOf('--grade')
if (gradeIndex >= 0) {
  const dbPath = argv[gradeIndex + 1]
  const sessionId = argv[gradeIndex + 2]
  if (!dbPath || !sessionId) { console.error('用法: --grade <results.db> <sessionId>'); process.exit(2) }
  process.exitCode = gradeRun(dbPath, sessionId) ? 1 : 0
} else {
  process.exitCode = deterministic() ? 1 : 0
}
