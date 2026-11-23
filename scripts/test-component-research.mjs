import './test-home-isolation.mjs'
import assert from 'node:assert/strict'
import http from 'node:http'
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js'
import { saveTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js'
import {
  observeComponent,
  importComponentAdvisory,
  evaluateComponent,
  componentStatus,
} from '../plugins/dsh-redteam-results/lib/component-research.js'
import { mapComponentUpstream, researchComponentUpstream } from '../plugins/dsh-redteam-results/lib/component-upstream.js'
const results = await import('../plugins/dsh-redteam-results/lib/index.js')

const store = openStore(':memory:')
try {
  const sessionId = 'component-research'
  const sourceRef = 'material-advisory'
  store.db.prepare('INSERT INTO business_materials(session_id,id,source_url,digest,record) VALUES(?,?,?,?,?)')
    .run(sessionId, sourceRef, 'local:advisory.json', 'a'.repeat(64),
      JSON.stringify({ id: sourceRef, name: 'advisory.json', source: 'fixture' }))
  saveTaskContext(store, sessionId, {
    assets: [{ id: 'asset-app', url: 'https://app.fixture.test', inScope: true }],
    requests: [], checks: [], methods: [], maxSupplementAttempts: 2,
  })

  const fact = observeComponent(store, sessionId, {
    product: 'Acme Server',
    version: '1.2.3',
    assetId: 'asset-app',
    sourceRef,
  }).fact
  assert.equal(fact.targetMapped, true)
  assert.equal(fact.versionKind, 'numeric')

  const advisory = importComponentAdvisory(store, sessionId, {
    sourceRef,
    document: {
      id: 'ADV-1',
      product: 'AcmeServer',
      aliases: ['Acme Server'],
      sourceRef,
      sourceLabel: 'fixture advisory',
      affected: [{ introduced: '1.0.0', fixed: '1.5.0' }],
      conditions: [{ name: 'exposed admin endpoint', required: true }],
    },
  }).advisory
  assert.equal(advisory.productKey, 'acmeserver')

  const applicable = evaluateComponent(store, sessionId, {
    factId: fact.id,
    advisoryId: advisory.id,
    conditions: { 'exposed admin endpoint': { state: 'satisfied', evidenceRef: 'execution-fixture' } },
  }).evaluation
  assert.equal(applicable.status, 'applicable')
  assert.equal(applicable.targetMapped, true)

  const change = importComponentAdvisory(store, sessionId, {
    sourceRef,
    document: {
      id: 'CHANGE-1',
      kind: 'security-change',
      product: 'AcmeServer',
      aliases: ['Acme Server'],
      sourceRef,
      sourceKind: 'official-repository',
      upstreamUrl: 'https://upstream.fixture/acme/server',
      commit: 'abc123',
      fixedVersion: '1.5.0',
      changedFiles: ['src/orders/export.js'],
      changeSummary: 'Export now derives owner from session',
      affected: [{ introduced: '1.0.0', fixed: '1.5.0' }],
      conditions: [{ name: 'admin UI exposed', required: true }],
    },
  }).advisory
  assert.equal(change.kind, 'security-change')
  assert.equal(change.commit, 'abc123')
  assert.deepEqual(change.changedFiles, ['src/orders/export.js'])
  const changeEval = evaluateComponent(store, sessionId, {
    factId: fact.id,
    advisoryId: change.id,
    conditions: { 'admin UI exposed': { state: 'satisfied', evidenceRef: 'execution-fixture' } },
  }).evaluation
  assert.equal(changeEval.status, 'applicable')
  assert.equal(changeEval.advisoryKind, 'security-change')

  const missingCondition = evaluateComponent(store, sessionId, {
    factId: fact.id,
    advisoryId: advisory.id,
    conditions: [{ name: 'exposed admin endpoint', state: 'not-applicable' }],
  }).evaluation
  assert.equal(missingCondition.status, 'not-applicable')
  assert.match(missingCondition.reason, /precondition/)

  const versionAbove = observeComponent(store, sessionId, {
    product: 'AcmeServer', version: '1.6.0', assetId: 'asset-app', sourceRef,
  }).fact
  const notAffected = evaluateComponent(store, sessionId, {
    factId: versionAbove.id, advisoryId: advisory.id,
    conditions: { 'exposed admin endpoint': { state: 'satisfied' } },
  }).evaluation
  assert.equal(notAffected.status, 'not-applicable')
  assert.match(notAffected.reason, /outside|fixed/)

  const unknownVersion = observeComponent(store, sessionId, {
    product: 'AcmeServer', version: 'unknown', assetId: 'asset-app', sourceRef,
  }).fact
  const unknown = evaluateComponent(store, sessionId, {
    document: { factId: unknownVersion.id, advisoryId: advisory.id, conditions: [] },
  }).evaluation
  assert.equal(unknown.status, 'unknown')
  assert.match(unknown.reason, /version/)

  // 真实 Desktop 任务里模型用过 component/productVersion、ranges/from/to、
  // componentId/bulletinId、status/receiptId 等同义字段。必须映射到同一合同，
  // 否则模型会重复写入空公告，既浪费调用又可能留下错误结论。
  const aliasFact = observeComponent(store, sessionId, {
    component: 'AcmeServer', productVersion: '1.2.4', targetAssetId: 'asset-app', source: sourceRef,
  }).fact
  const aliasAdvisory = importComponentAdvisory(store, sessionId, {
    source: sourceRef,
    document: {
      advisoryId: 'ADV-2', component: 'AcmeServer', source: sourceRef,
      ranges: ['[1.0.0,1.5.0)'], preconditions: ['admin UI exposed'],
    },
  }).advisory
  assert.equal(aliasAdvisory.affected[0].introduced, '1.0.0')
  assert.equal(aliasAdvisory.affected[0].fixed, '1.5.0')
  assert.equal(aliasAdvisory.conditions[0].name, 'admin UI exposed')
  assert.throws(() => importComponentAdvisory(store, sessionId, {
    source: sourceRef,
    document: { advisoryId: 'ADV-EMPTY', component: 'AcmeServer', source: sourceRef, ranges: [{ note: '' }], preconditions: [] },
  }), /empty range/, 'an unparseable range must not be saved as empty')
  const aliasEval = evaluateComponent(store, sessionId, {
    componentId: aliasFact.id,
    bulletinId: 'ADV-2',
    conditionStates: { 'admin UI exposed': { status: 'not-applicable', receiptId: 'execution-alias' } },
  }).evaluation
  assert.equal(aliasEval.status, 'not-applicable')
  assert.equal(aliasEval.conditions[0].evidenceRef, 'execution-alias')

  // N01：用户已声明产品/公告时不能强迫它伪造一个回执来源。
  const declaredFact = observeComponent(store, sessionId, {
    component: 'AcmeServer', productVersion: '1.2.5', targetAssetId: 'asset-app', sourceRef: 'user-declared',
  }).fact
  assert.equal(declaredFact.sourceKind, 'user-declared')
  assert.equal(declaredFact.targetMapped, true)
  const declaredAdvisory = importComponentAdvisory(store, sessionId, {
    document: {
      id: 'ADV-3', product: 'AcmeServer', sourceRef: 'user-declared',
      affected: '[1.0.0,1.5.0)', conditions: 'admin UI exposed',
    },
  }).advisory
  assert.equal(declaredAdvisory.sourceKind, 'user-declared')
  assert.equal(declaredAdvisory.affected[0].introduced, '1.0.0')
  assert.equal(declaredAdvisory.affected[0].fixed, '1.5.0')
  assert.equal(declaredAdvisory.conditions.length, 1)
  assert.equal(declaredAdvisory.conditions[0].name, 'admin UI exposed')
  assert.equal(declaredAdvisory.conditions[0].required, true)

  const status = componentStatus(store, sessionId)
  assert.equal(status.facts.length, 5)
  assert.equal(status.advisories.length, 4)
  assert.equal(status.evaluations.length, 6)
  const rpc = await results.dispatch({
    sessions: { get: id => id === sessionId ? { id: sessionId, header: { agentPreset: 'pentest' } } : undefined },
  }, store, 'component.status', { sessionId })
  assert.equal(rpc.ok, true)
  assert.equal(rpc.facts.length, 5)

  // V01/V02：复核中的原始反例必须由源码回归直接覆盖，不能只靠汇总测试变绿。
  const edgeStore = openStore(':memory:')
  try {
    const edgeSession = 'component-edge'
    saveTaskContext(edgeStore, edgeSession, {
      assets: [{ id: 'asset-edge', url: 'https://edge.fixture.test', inScope: true }],
      requests: [], checks: [], methods: [], maxSupplementAttempts: 2,
    })
    const edgeFact = (product, version) => observeComponent(edgeStore, edgeSession, {
      product, version, assetId: 'asset-edge', sourceRef: 'user-declared',
    }).fact
    const edgeAdvisory = (id, product, affected, aliases = []) => importComponentAdvisory(edgeStore, edgeSession, {
      document: { id, product, aliases, affected, sourceRef: 'user-declared' },
    }).advisory
    const evaluate = (fact, advisory) => evaluateComponent(edgeStore, edgeSession, {
      factId: fact.id, advisoryId: advisory.id,
    }).evaluation

    const weaver = edgeFact('泛微', '1.2.3')
    const seeyon = edgeAdvisory('ADV-CN-WRONG', '致远', [{
      introduced: '1.0.0', fixed: '2.0.0',
    }])
    const crossProduct = evaluate(weaver, seeyon)
    assert.notEqual(weaver.productKey, seeyon.productKey)
    assert.equal(weaver.productKey, '泛微')
    assert.equal(seeyon.productKey, '致远')
    assert.equal(crossProduct.productMatch, false)
    assert.notEqual(crossProduct.status, 'applicable')

    const weaverOa = edgeFact('泛微OA', '1.2.3')
    const seeyonOa = edgeAdvisory('ADV-CN-OA-WRONG', '致远OA', [{
      introduced: '1.0.0', fixed: '2.0.0',
    }])
    const suffixOnly = evaluate(weaverOa, seeyonOa)
    assert.notEqual(weaverOa.productKey, seeyonOa.productKey)
    assert.notEqual(suffixOnly.status, 'applicable')

    const sameChinese = edgeAdvisory('ADV-CN-SAME', '泛微', [{
      introduced: '1.0.0', fixed: '2.0.0',
    }])
    assert.equal(evaluate(weaver, sameChinese).status, 'applicable')
    const explicitAlias = edgeAdvisory('ADV-CN-ALIAS', 'Weaver E-cology', [{
      introduced: '1.0.0', fixed: '2.0.0',
    }], ['泛微OA'])
    assert.equal(evaluate(weaverOa, explicitAlias).status, 'applicable')

    const acme = edgeFact('Acme', '1.5.0')
    const inclusiveUpper = edgeAdvisory('ADV-INC-UPPER', 'Acme', '>=1.0.0 <=1.5.0')
    assert.equal(inclusiveUpper.affected[0].fixedInclusive, true)
    assert.equal(evaluate(acme, inclusiveUpper).status, 'applicable')
    const exclusiveUpper = edgeAdvisory('ADV-EXC-UPPER', 'Acme', '>=1.0.0 <1.5.0')
    assert.equal(exclusiveUpper.affected[0].fixedInclusive, false)
    assert.equal(evaluate(acme, exclusiveUpper).status, 'not-applicable')
    const closedInterval = edgeAdvisory('ADV-CLOSED', 'Acme', '[1.0.0,1.5.0]')
    assert.equal(closedInterval.affected[0].introducedInclusive, true)
    assert.equal(closedInterval.affected[0].fixedInclusive, true)
    assert.equal(evaluate(acme, closedInterval).status, 'applicable')

    const lowerEdge = edgeFact('Acme', '1.0.0')
    assert.equal(evaluate(lowerEdge, edgeAdvisory('ADV-LOWER-INCLUSIVE', 'Acme', '>=1.0.0 <2.0.0')).status, 'applicable')
    assert.equal(evaluate(lowerEdge, edgeAdvisory('ADV-LOWER-EXCLUSIVE', 'Acme', '>1.0.0 <2.0.0')).status, 'not-applicable')

    const prerelease = edgeFact('Acme', '1.5.0-rc.1')
    const fixedAtOneFive = edgeAdvisory('ADV-PRERELEASE', 'Acme', [{
      introduced: '1.0.0', fixed: '1.5.0',
    }])
    assert.equal(prerelease.versionKind, 'semver-prerelease')
    assert.equal(evaluate(prerelease, fixedAtOneFive).status, 'applicable')
    const vendorSuffix = edgeFact('Acme', '1.5.0-p1')
    const vendorResult = evaluate(vendorSuffix, fixedAtOneFive)
    assert.equal(vendorSuffix.versionKind, 'unsupported')
    assert.equal(vendorResult.status, 'unknown')
    assert.match(vendorResult.reason, /unsupported|not supported|prerelease/)

    console.log('ok   V01 Chinese identities remain distinct and explicit aliases are required')
    console.log('ok   V02 inclusive/exclusive bounds and prerelease ordering are preserved')
  } finally {
    edgeStore.close()
  }

  console.log('ok   component facts bind product/version/source and target asset')
  console.log('ok   advisory ranges and required conditions produce applicable/not-applicable/unknown')
  console.log('ok   component evaluations stay session-scoped and auditable')
  console.log('ok   component status is available to the Desktop detail view without model calls')

  const upstreamServer = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.test')
    const json = body => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)) }
    if (url.pathname === '/-/v1/search') return json({ objects: [{ package: {
      name: 'AcmeExport', version: '1.4.0', date: '2026-01-01T00:00:00Z',
      links: { repository: `http://127.0.0.1:${upstreamServer.address().port}/acme/export`, homepage: 'https://acme.fixture/' },
    } }] })
    if (url.pathname === '/repos/acme/export') return json({ full_name: 'acme/export', default_branch: 'main' })
    if (url.pathname === '/repos/acme/export/tags') return json([
      { name: 'v1.4.0', commit: { sha: 'base-sha' } },
      { name: 'v1.5.0', commit: { sha: 'fixed-sha' } },
    ])
    if (url.pathname === '/repos/acme/export/compare/v1.4.0...v1.5.0') return json({
      commits: [{ sha: 'fixed-sha', commit: { message: 'security: enforce owner check on export' } }],
      files: [{ filename: 'src/export.js', status: 'modified', additions: 4, deletions: 1 }],
    })
    response.writeHead(404); response.end('not found')
  })
  await new Promise(resolve => upstreamServer.listen(0, '127.0.0.1', resolve))
  const previousNpm = process.env.SAKER_NPM_REGISTRY
  const previousGithub = process.env.SAKER_GITHUB_API
  process.env.SAKER_NPM_REGISTRY = `http://127.0.0.1:${upstreamServer.address().port}`
  process.env.SAKER_GITHUB_API = `http://127.0.0.1:${upstreamServer.address().port}`
  try {
    const upstreamFact = observeComponent(store, sessionId, {
      product: 'AcmeExport', version: '1.4.0', assetId: 'asset-app', sourceRef,
    }).fact
    const mapped = await mapComponentUpstream(store, sessionId, { factId: upstreamFact.id })
    assert.equal(mapped.ok, true)
    assert.equal(mapped.mapping.status, 'candidate')
    assert.equal(mapped.mapping.selected.packageName, 'AcmeExport')
    const researched = await researchComponentUpstream(store, sessionId, { mappingId: mapped.mapping.id })
    assert.equal(researched.ok, true)
    assert.equal(researched.research.base.name, 'v1.4.0')
    assert.equal(researched.research.head.name, 'v1.5.0')
    assert.equal(researched.research.securityCommits.length, 1)
    assert(researched.material.id)
    assert.equal(researched.advisoryDraft.sourceRef, researched.material.id)
    assert.equal(researched.advisoryDraft.affected.length, 0, 'a changed window does not invent a complete affected range')
    console.log('ok   target component maps to a public upstream without a pre-supplied repository/commit')
  } finally {
    if (previousNpm === undefined) delete process.env.SAKER_NPM_REGISTRY; else process.env.SAKER_NPM_REGISTRY = previousNpm
    if (previousGithub === undefined) delete process.env.SAKER_GITHUB_API; else process.env.SAKER_GITHUB_API = previousGithub
    await new Promise(resolve => upstreamServer.close(resolve))
  }
} finally {
  store.close()
}
console.log('\n7 component research checks passed')
