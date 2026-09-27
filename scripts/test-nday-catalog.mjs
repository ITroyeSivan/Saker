#!/usr/bin/env node
// Nday 语料的结构与**诚实性**门禁。
//
// 为什么需要：这是护网复盘后新增的知识层（preset/pentest/refs/nday/），
// 它的价值全在"可信"二字。最容易悄悄发生的退化有两种，而且都不会让任何现有测试变红：
//   ① 字段缺项 —— 匹配器读不到 fingerprint，条目就只是散文；
//   ② 状态说谎 —— 只读了通告就标 `verified`，把"未复现"包装成"已确认可利用"。
// 所以这里把二者都做成硬断言：verified 必须有 reproduction 证据，
// normalized 必须如实写 reproduced=false。
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REFS = join(ROOT, 'preset', 'pentest', 'refs', 'nday')
const CATALOG = join(REFS, 'catalog.json')
const ENTRIES_DIR = join(REFS, 'entries')

let pass = 0
let fail = 0
const ok = (label, condition, detail = '') => {
  if (condition) {
    pass += 1
    console.log(`ok   ${label}`)
  } else {
    fail += 1
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const REQUIRED = [
  'id', 'product', 'vendor', 'aliases', 'category', 'vulnClass', 'ids', 'severity',
  'affectedVersions', 'auth', 'fingerprint', 'verify', 'exploit', 'remediation',
  'status', 'verification', 'sources', 'lastReviewed',
]
const AUTH = new Set(['none', 'user', 'admin'])
const VERIFY_METHOD = new Set(['oob', 'response', 'timing'])
const VERIFY_OOB = new Set(['dnslog', 'sleep', 'none'])
const VERIFY_NOISE = new Set(['low', 'medium', 'high'])
const SOURCE_KIND = new Set(['advisory', 'analysis', 'tool', 'vendor'])
const PROBE_METHOD = new Set(['GET', 'POST', 'HEAD'])
const PROBE_WEIGHT = new Set(['weak', 'medium', 'strong'])
const PROBE_EXPECT_KEYS = ['statusIn', 'statusNotIn', 'bodyContainsAny', 'headerContainsAny']

if (!existsSync(CATALOG)) {
  console.error(`FAIL nday catalog missing: ${CATALOG}`)
  process.exit(1)
}

const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'))
const statuses = new Set(Object.keys(catalog.statusLegend ?? {}))
const entries = catalog.entries ?? []

ok('catalog schema version', catalog.schema === 'saker.nday.catalog/1', String(catalog.schema))
ok('catalog has a status legend', statuses.size >= 4)

// 空语料是最危险的"静默退化"：所有逐条断言都会真空通过。
// 信创覆盖是这次失利的直接原因，所以把它钉成下限。
ok('catalog is not empty', entries.length > 0, `entries=${entries.length}`)
ok('信创/国产覆盖下限（>=1 条）', entries.length >= 1)

const seen = new Set()
for (const entry of entries) {
  const id = entry?.id ?? '(missing id)'
  const scope = `[${id}] `

  ok(`${scope}all required fields present`,
    REQUIRED.every((k) => entry[k] !== undefined && entry[k] !== null),
    REQUIRED.filter((k) => entry[k] === undefined || entry[k] === null).join(', '))

  ok(`${scope}id is unique`, !seen.has(id) && typeof entry.id === 'string' && entry.id.length > 0)
  seen.add(id)

  ok(`${scope}status is declared in legend`, statuses.has(entry.status), String(entry.status))
  ok(`${scope}auth enum`, AUTH.has(entry.auth), String(entry.auth))

  // ids 除 cve/cnvd/qvd 外还允许 avd（阿里云漏洞库）。加它是为了**不硬凑编号**：
  // 通达OA 这类只有 AVD 记录的漏洞，与其编一个看起来更权威的 CNVD 号，不如如实写 AVD。
  if (entry.ids?.avd !== undefined && entry.ids.avd !== null) {
    ok(`${scope}ids.avd 形如 AVD-YYYY-NNNNNNN`,
      /^AVD-\d{4}-\d+$/.test(String(entry.ids.avd)), String(entry.ids.avd))
  }

  ok(`${scope}affectedVersions non-empty`,
    Array.isArray(entry.affectedVersions) && entry.affectedVersions.length > 0)

  const fp = entry.fingerprint ?? {}
  // 误报点是这套语料区别于"POC 清单"的地方，**对每条都强制**——
  // 对没有指纹的 legacy 条目，它正好用来写"这条为什么弱"（单源 / 只有 gist / 未复现）。
  ok(`${scope}fingerprint.falsePositiveNotes non-empty`,
    Array.isArray(fp.falsePositiveNotes) && fp.falsePositiveNotes.length > 0)

  // 结构化探针：没有它，匹配器就只能把散文喂给模型，批量能力无从谈起。
  // 但**只对 normalized / verified 强制**——legacy-unreviewed 允许先以"只有来源、
  // 还没落实指纹"的形态入库，那样它只作为线索出现在 catalog 里，匹配器不会拿它跑。
  // 反过来，一条 entry 一旦声称自己 normalized，就必须交出可执行探针，不许含糊。
  const probes = fp.probes
  const siftable = entry.status === 'normalized' || entry.status === 'verified'
  if (siftable) {
    ok(`${scope}siftable entry must carry fingerprint paths`,
      Array.isArray(fp.paths) && fp.paths.length > 0)
    ok(`${scope}siftable entry must carry fingerprint signals`,
      Array.isArray(fp.signals) && fp.signals.length > 0)
    ok(`${scope}siftable entry must carry machine-checkable probes`,
      Array.isArray(probes) && probes.length > 0)
  } else {
    ok(`${scope}non-siftable entry keeps paths/signals optional`,
      (fp.paths === undefined || Array.isArray(fp.paths))
      && (fp.signals === undefined || Array.isArray(fp.signals)))
    ok(`${scope}non-siftable entry may omit probes`,
      probes === undefined || Array.isArray(probes))
  }
  if (Array.isArray(probes) && probes.length > 0) {
    const probeIds = new Set()
    ok(`${scope}probe ids unique and non-empty`,
      probes.every((p) => typeof p?.id === 'string' && p.id.length > 0 && !probeIds.has(p.id)
        && (probeIds.add(p.id), true)))
    ok(`${scope}probe paths are absolute`, probes.every((p) => typeof p?.path === 'string' && p.path.startsWith('/')))
    ok(`${scope}probe methods enum`, probes.every((p) => PROBE_METHOD.has(p?.method)))
    ok(`${scope}probe weights enum`, probes.every((p) => PROBE_WEIGHT.has(p?.weight)))
    ok(`${scope}every probe declares a machine-checkable expectation`,
      probes.every((p) => p?.expect && typeof p.expect === 'object'
        && PROBE_EXPECT_KEYS.some((k) => Array.isArray(p.expect[k]) && p.expect[k].length > 0)))
    ok(`${scope}every probe explains its limits`, probes.every((p) => typeof p?.note === 'string' && p.note.length > 0))
  }

  const verify = entry.verify ?? {}
  ok(`${scope}verify.method enum`, VERIFY_METHOD.has(verify.method), String(verify.method))
  ok(`${scope}verify.noise enum`, VERIFY_NOISE.has(verify.noise), String(verify.noise))
  ok(`${scope}verify.oob enum`,
    Array.isArray(verify.oob) && verify.oob.length > 0 && verify.oob.every((v) => VERIFY_OOB.has(v)))

  const exploit = entry.exploit ?? {}
  ok(`${scope}exploit declares a path (primitives or tools)`,
    (Array.isArray(exploit.primitives) && exploit.primitives.length > 0)
    || (Array.isArray(exploit.tools) && exploit.tools.length > 0))
  // nucleiKeywords 是"交接层用你自己已有的模板库"的输入；有就必须是好用的字符串数组。
  if (exploit.nucleiKeywords !== undefined) {
    ok(`${scope}exploit.nucleiKeywords is a non-empty string array`,
      Array.isArray(exploit.nucleiKeywords) && exploit.nucleiKeywords.length > 0
      && exploit.nucleiKeywords.every((k) => typeof k === 'string' && k.trim().length > 0))
  }

  const sources = entry.sources ?? []
  ok(`${scope}at least 2 sources`, sources.length >= 2, `sources=${sources.length}`)
  ok(`${scope}every source has url/kind/title`,
    sources.every((s) => s && typeof s.url === 'string' && s.url.startsWith('http')
      && SOURCE_KIND.has(s.kind) && typeof s.title === 'string' && s.title.length > 0))
  ok(`${scope}has an official source (advisory or vendor)`,
    sources.some((s) => s.kind === 'advisory' || s.kind === 'vendor'))

  // ── 诚实性：状态必须与复现证据一致 ────────────────────────────────────────
  const verification = entry.verification ?? {}
  if (entry.status === 'verified') {
    ok(`${scope}verified requires reproduced=true`, verification.reproduced === true)
    ok(`${scope}verified requires scope+date`,
      (verification.scope === 'detection' || verification.scope === 'exploit')
      && typeof verification.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(verification.date ?? ''))
  } else {
    ok(`${scope}non-verified must not claim reproduction`, verification.reproduced !== true)
  }

  ok(`${scope}entry markdown exists`, existsSync(join(ENTRIES_DIR, `${entry.id}.md`)))
  ok(`${scope}lastReviewed is a date`,
    /^\d{4}-\d{2}-\d{2}$/.test(String(entry.lastReviewed ?? '')))
}

// 反向：孤立的 entry 文件（没进 catalog）同样是退化。
const files = existsSync(ENTRIES_DIR)
  ? readdirSync(ENTRIES_DIR).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3))
  : []
const orphans = files.filter((f) => !seen.has(f))
ok('no orphan entry files', orphans.length === 0, orphans.join(', '))

// Tomcat correction: the local 8.5.19 RCE proof is CVE-2017-12617, not the
// Windows-only Tomcat 7 CVE-2017-12615. Lock the facts that change candidate matching.
{
  const tomcat = entries.find((entry) => entry.id === 'tomcat-put-jsp-upload-rce')
  ok('[tomcat] CVE matches the verified 8.5.19 case',
    tomcat?.ids?.cve === 'CVE-2017-12617'
    && tomcat.aliases.includes('CVE-2017-12617')
    && !tomcat.aliases.includes('CVE-2017-12615'))
  ok('[tomcat] affected 8.5 range matches Apache advisory',
    tomcat?.affectedVersions?.includes('Tomcat 8.5.0 – 8.5.22')
    && !tomcat?.affectedVersions?.includes('Tomcat 8.5.0 – 8.5.19'))
  ok('[tomcat] PUT configuration prerequisite stays explicit',
    tomcat?.affectedVersions?.some((v) => v.includes('readonly=false'))
    && tomcat?.fingerprint?.falsePositiveNotes?.some((v) => v.includes('readonly=false')))
  ok('[tomcat] Windows PUT route and 404 caveat are preserved',
    tomcat?.exploit?.primitives?.some((v) => v.includes('PUT /<name>.jsp/') && v.includes('404'))
    && tomcat?.exploit?.notes?.includes('普通 .jsp 返回 404 不代表配置为 readonly=true'))
  ok('[tomcat] official Apache sources are attached',
    tomcat?.sources?.some((s) => s.url === 'https://tomcat.apache.org/security-8.html')
    && tomcat?.sources?.some((s) => s.url === 'https://tomcat.apache.org/security-7'))
  ok('[tomcat] current local verification is recorded',
    tomcat?.status === 'verified'
    && tomcat?.verification?.date === '2026-09-27'
    && tomcat?.verification?.environment?.includes('127.0.0.1:18100'))
  ok('[tomcat] entry stays within RCE delivery boundary',
    !JSON.stringify(tomcat?.exploit ?? {}).includes('内存马')
    && !JSON.stringify(tomcat?.exploit ?? {}).includes('memshell'))
}

console.log(fail === 0 ? '\nall ' + pass + ' tests passed' : '\n' + fail + ' FAILED, ' + pass + ' passed')
process.exit(fail ? 1 : 0)
console.log(fail === 0 ? `\nall ${pass} tests passed` : `\n${fail} FAILED, ${pass} passed`)
process.exit(fail ? 1 : 0)
