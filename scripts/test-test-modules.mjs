import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js'
import { startTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js'
import { createWorkItem, readWorkItem } from '../plugins/dsh-redteam-results/lib/role-orchestration.js'
import { saveTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js'
import { createCompetitionChallenge } from '../plugins/dsh-redteam-results/lib/competition-store.js'
import { challengeRoot, runCompetitionExecution, readCompetitionExecution } from '../plugins/dsh-redteam-results/lib/competition-execution.js'
import {
  listModuleDefinitions, detailModuleDefinition, defineModuleDraft, reviseModuleDraft,
  saveModulePersonal, beginModuleInvocation, finishModuleInvocation, cancelModuleInvocation,
  listModuleInvocations, readModulePreference, writeModulePreference,
} from '../plugins/dsh-redteam-results/lib/test-module-registry.js'

let failed = 0
async function test(name, fn) {
  try { await fn(); console.log('ok   ' + name) }
  catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)) }
}

const store = openStore(':memory:')
const rootA = 'module-root-a'
const rootB = 'module-root-b'
for (const rootId of [rootA, rootB]) {
  startTaskPolicy(store, rootId, { mode: 'regular', target: 'https://module.fixture.test', budget: { toolCalls: 30, modelCalls: 20, workers: 2 } })
}

const sha = value => createHash('sha256').update(value).digest('hex')
const wireRequest = (identity = 'alpha') => [
  'GET /api/export HTTP/1.1',
  'Host: module.fixture.test',
  'x-identity: ' + identity,
  '',
  '',
].join('\r\n')
const responseHead = 'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\n\r\n'
function requestBasis(requestId, revision, endpoint, authContext, wire) {
  return sha(JSON.stringify([requestId, revision, endpoint, authContext, wire]))
}
function freshReceipt({
  id, requestId, revision = 'r1', endpoint = 'https://module.fixture.test/api/export',
  authContext = 'alpha', completedAt = new Date(Date.now() + 1000).toISOString(),
}) {
  const wire = wireRequest(authContext)
  const body = Buffer.from('ok')
  return {
    id, requestId, requestRevision: revision, endpoint, authContext,
    identity: { name: authContext }, identitySource: 'account', source: 'host-http-execution',
    request: wire, requestSha256: sha(wire),
    responseHead, responseBodyBase64: body.toString('base64'),
    responseSha256: sha(Buffer.concat([Buffer.from(responseHead), body])),
    status: 200, capturedBytes: body.length, responseBytes: body.length,
    outcome: 'response', completedAt, requestBasis: requestBasis(requestId, revision, endpoint, authContext, wire),
  }
}
function receiptRefs(...ids) {
  return {
    kind: 'artifact',
    artifact: {
      kind: 'observation',
      title: '账号对照观察',
      detail: 'alpha 与 beta 的身份、对象归属和响应边界已分别记录。',
      sourceRefs: ids.map(id => ({ kind: 'receipt', id })),
    },
  }
}

await test('内置目录：54 个种子、7 类、分页与搜索可用', () => {
  const first = listModuleDefinitions(store, { rootId: rootA, page: { limit: 20 } })
  assert.equal(first.page.total, 54)
  assert.equal(first.items.length, 20)
  assert.equal(first.taxonomy.primaryCategories.length, 7)
  assert.ok(first.page.nextCursor)
  const second = listModuleDefinitions(store, { rootId: rootA, page: { limit: 20, cursor: first.page.nextCursor } })
  assert.equal(second.items.length, 20)
  const fofa = listModuleDefinitions(store, { rootId: rootA, filter: { text: 'FOFA' }, page: { limit: 50 } })
  assert.ok(fofa.items.some(item => item.id === 'asset-discovery'))
  const none = listModuleDefinitions(store, { rootId: rootA, filter: { text: 'no-such-module-xyz' } })
  assert.equal(none.page.total, 0)
})

await test('详情：完整 instructions 只按需返回', () => {
  const list = listModuleDefinitions(store, { rootId: rootA, filter: { text: 'nday-match' } })
  assert.equal(list.items.length, 1)
  assert.equal(list.items[0].instructions, undefined)
  const detail = detailModuleDefinition(store, { rootId: rootA, ref: { id: 'nday-match' } })
  assert.match(detail.instructions, /纪律/)
  assert.equal(detail.version, 1)
})

await test('定义：本任务草稿可见，超长拒绝，同版本不同内容冲突', () => {
  const saved = defineModuleDraft(store, 'session:' + rootA, {
    id: 'task-local-check', title: '本次专项核对',
    purpose: '核对本次输入中的具体前提。',
    instructions: '只使用真实材料；没有材料时输出 unknown。',
    outputs: [{ kind: 'ObservationBundle' }], operations: ['auto'],
  })
  assert.equal(saved.version, 1)
  const detail = detailModuleDefinition(store, { rootId: rootA, ref: { id: 'task-local-check', ownerKey: 'session:' + rootA } })
  assert.equal(detail.title, '本次专项核对')
  assert.throws(() => defineModuleDraft(store, 'session:' + rootA, {
    id: 'too-long', purpose: 'x'.repeat(4001), instructions: 'ok',
  }), /4000/)
  const other = defineModuleDraft(store, 'session:' + rootA, {
    id: 'same-version', purpose: '第一版', instructions: '第一版说明',
  })
  assert.equal(other.version, 1)
  const revised = reviseModuleDraft(store, 'session:' + rootA, {
    baseSnapshotRef: { id: other.id, version: 1, digest: other.digest, ownerKey: 'session:' + rootA },
    changes: { purpose: '第二版', instructions: '第二版说明' },
    reason: '补齐判据',
  })
  assert.equal(revised.version, 2)
  assert.equal(detailModuleDefinition(store, { rootId: rootA, ref: { id: other.id, version: 1, ownerKey: 'session:' + rootA } }).purpose, '第一版')
})

await test('归属：本任务草稿不串到另一个 root', () => {
  const listB = listModuleDefinitions(store, { rootId: rootB, filter: { text: 'task-local-check' } })
  assert.equal(listB.page.total, 0)
  assert.throws(() => detailModuleDefinition(store, { rootId: rootB, ref: { id: 'task-local-check', ownerKey: 'session:' + rootA } }), /不属于当前任务|not found|不存在/)
})

await test('另存个人库：新 owner 可跨 root 读取，源版本不变', () => {
  const source = detailModuleDefinition(store, { rootId: rootA, ref: { id: 'task-local-check', ownerKey: 'session:' + rootA } })
  const saved = saveModulePersonal(store, { moduleSnapshotRef: { id: source.id, version: source.version, digest: source.digest, ownerKey: 'session:' + rootA }, name: 'personal-check', rootId: rootA })
  assert.equal(saved.ownerKey, 'personal')
  const readBack = detailModuleDefinition(store, { rootId: rootB, ref: { id: 'personal-check', ownerKey: 'personal' } })
  assert.equal(readBack.title, source.title)
  assert.equal(source.version, 1)
})

await test('调用：begin 固定版本/任务包，缺少 artifact 合同拒绝，完成后 cancel 拒绝', () => {
  const work = createWorkItem(store, rootA, { question: '核对目录里的已知漏洞前提', target: 'https://module.fixture.test' }).work
  const started = beginModuleInvocation(store, {
    rootId: rootA, generation: 1, workId: work.workId, executorRef: rootA,
    moduleSnapshotRef: { id: 'nday-match', version: 1 },
    operation: 'auto', inputRefs: [{ kind: 'component-fact', id: 'C1', revision: 1 }],
  })
  assert.equal(started.invocationRef.state, 'active')
  assert.match(started.taskPack.instructions, /可独立调用/)
  assert.throws(() => beginModuleInvocation(store, {
    rootId: rootA, generation: 1, workId: work.workId, executorRef: rootA,
    moduleSnapshotRef: { id: 'nday-match', version: 1 },
  }), /已有活动模块调用/)
  assert.throws(() => finishModuleInvocation(store, {
    rootId: rootA, invocationRef: started.invocationRef, outcome: 'analysis-complete', outputRefs: [],
  }), error => error.code === 'OUTPUT_CONTRACT_UNSATISFIED' && Boolean(error.details?.missing?.length))
  assert.throws(() => finishModuleInvocation(store, {
    rootId: rootA, invocationRef: started.invocationRef, outcome: 'verification-observed',
    outputRefs: [{ kind: 'receipt', id: 'does-not-exist' }],
  }), /不存在|不属于当前任务/)
  const finished = finishModuleInvocation(store, {
    rootId: rootA, invocationRef: started.invocationRef, outcome: 'analysis-complete',
    outputRefs: [{
      kind: 'artifact',
      artifact: { kind: 'analysis', title: '组件前提分析', detail: '只记录输入里已知的组件版本与缺口，不把版本命中升级为漏洞。',
        sourceRefs: [{ kind: 'component-fact', id: 'C1' }] },
    }],
  })
  assert.equal(finished.invocationRef.state, 'completed')
  assert.equal(finished.outputRefs[0].kind, 'artifact')
  assert.equal(finished.validation.productStatus, 'satisfied')
  assert.equal(finished.validation.findingStatus, 'not-assessed')
  assert.throws(() => cancelModuleInvocation(store, { rootId: rootA, invocationRef: finished.invocationRef }), /已结束/)
})

await test('M01：work-only、未知完整性、错误 outcome/类型/目标/身份不能完成验证；失败不改 revision', () => {
  const work = createWorkItem(store, rootA, {
    title: '自有账号权限对照', question: '对照 alpha 与 beta 的对象权限',
    target: 'https://module.fixture.test', identityRef: 'alpha',
  }).work
  const begin = () => beginModuleInvocation(store, {
    rootId: rootA, generation: 1, workId: work.workId, executorRef: rootA,
    moduleSnapshotRef: { id: 'identity-compare', version: 1 },
  })
  const state = ref => store.db.prepare('SELECT state,revision FROM saker_module_invocations WHERE root_id=? AND invocation_id=?')
    .get(rootA, ref.id)

  let started = begin()
  assert.throws(() => finishModuleInvocation(store, { rootId: rootA, invocationRef: started.invocationRef,
    outcome: 'verification-observed', outputRefs: [{ kind: 'work', id: work.workId }] }),
  error => error.code === 'OUTPUT_CONTRACT_UNSATISFIED'
    && error.details.missing.some(item => item.includes('artifact'))
    && error.details.missing.some(item => item.includes('receipt/browser')))
  assert.deepEqual({ ...state(started.invocationRef) }, { state: 'active', revision: 1 })
  cancelModuleInvocation(store, { rootId: rootA, invocationRef: started.invocationRef, reason: 'M01 work-only' })

  store.db.prepare('INSERT INTO execution_receipts(session_id,id,record) VALUES(?,?,?)')
    .run(rootA, 'legacy-unknown-integrity', JSON.stringify({
      request: wireRequest('alpha'), responseHead, status: 200,
    }))
  started = begin()
  assert.throws(() => finishModuleInvocation(store, { rootId: rootA, invocationRef: started.invocationRef,
    outcome: 'verification-observed', outputRefs: [
      { kind: 'receipt', id: 'legacy-unknown-integrity' }, receiptRefs('legacy-unknown-integrity')] }),
  error => error.code === 'EVIDENCE_INTEGRITY_UNKNOWN')
  assert.deepEqual({ ...state(started.invocationRef) }, { state: 'active', revision: 1 })
  cancelModuleInvocation(store, { rootId: rootA, invocationRef: started.invocationRef, reason: 'M01 integrity' })

  started = begin()
  assert.throws(() => finishModuleInvocation(store, { rootId: rootA, invocationRef: started.invocationRef,
    outcome: 'analysis-complete', outputRefs: [{
      kind: 'artifact', artifact: { kind: 'analysis', title: '错误 outcome', detail: '没有真实对照却试图以分析完成。', sourceRefs: [] },
    }] }), error => error.code === 'OUTCOME_NOT_ALLOWED')
  assert.deepEqual({ ...state(started.invocationRef) }, { state: 'active', revision: 1 })
  cancelModuleInvocation(store, { rootId: rootA, invocationRef: started.invocationRef, reason: 'M01 outcome' })

  const wrongTarget = freshReceipt({ id: 'wrong-target', requestId: 'request-wrong-target',
    endpoint: 'https://other.fixture.test/api/export', authContext: 'alpha' })
  store.db.prepare('INSERT INTO execution_receipts(session_id,id,record) VALUES(?,?,?)').run(rootA, wrongTarget.id, JSON.stringify(wrongTarget))
  started = begin()
  assert.throws(() => finishModuleInvocation(store, { rootId: rootA, invocationRef: started.invocationRef,
    outcome: 'verification-observed', outputRefs: [
      { kind: 'receipt', id: wrongTarget.id }, receiptRefs(wrongTarget.id)] }),
  error => error.code === 'EVIDENCE_TARGET_MISMATCH')
  assert.deepEqual({ ...state(started.invocationRef) }, { state: 'active', revision: 1 })
  cancelModuleInvocation(store, { rootId: rootA, invocationRef: started.invocationRef, reason: 'M01 target' })

  const wrongIdentity = freshReceipt({ id: 'wrong-identity', requestId: 'request-wrong-identity', authContext: 'beta' })
  store.db.prepare('INSERT INTO execution_receipts(session_id,id,record) VALUES(?,?,?)').run(rootA, wrongIdentity.id, JSON.stringify(wrongIdentity))
  started = begin()
  assert.throws(() => finishModuleInvocation(store, { rootId: rootA, invocationRef: started.invocationRef,
    outcome: 'verification-observed', outputRefs: [
      { kind: 'receipt', id: wrongIdentity.id }, receiptRefs(wrongIdentity.id)] }),
  error => error.code === 'EVIDENCE_IDENTITY_MISMATCH')
  assert.deepEqual({ ...state(started.invocationRef) }, { state: 'active', revision: 1 })
  cancelModuleInvocation(store, { rootId: rootA, invocationRef: started.invocationRef, reason: 'M01 identity' })

  const wrongTypeWork = createWorkItem(store, rootA, { title: '错误产物类型', question: '错误 artifact 类型',
    target: 'https://module.fixture.test' }).work
  const wrongType = beginModuleInvocation(store, {
    rootId: rootA, generation: 1, workId: wrongTypeWork.workId, executorRef: rootA,
    moduleSnapshotRef: { id: 'nday-match', version: 1 },
  })
  assert.throws(() => finishModuleInvocation(store, { rootId: rootA, invocationRef: wrongType.invocationRef,
    outcome: 'analysis-complete', outputRefs: [{
      kind: 'artifact', artifact: { kind: 'material', title: '错误类型', detail: 'material 不是这张固定产物的完成类型。', sourceRefs: [] },
    }] }), error => error.code === 'OUTPUT_CONTRACT_UNSATISFIED')
  assert.deepEqual({ ...state(wrongType.invocationRef) }, { state: 'active', revision: 1 })
  cancelModuleInvocation(store, { rootId: rootA, invocationRef: wrongType.invocationRef, reason: 'M01 type' })
})

await test('M01：合法 fresh 对照、历史 reuse 与本机分析产物分别按合同完成', () => {
  const work = createWorkItem(store, rootA, {
    title: '完全独立的权限对照', question: '对照 alpha 与 beta',
    target: 'https://module.fixture.test', identityRef: '',
  }).work
  const alpha = freshReceipt({ id: 'receipt-alpha', requestId: 'request-alpha', authContext: 'alpha' })
  const beta = freshReceipt({ id: 'receipt-beta', requestId: 'request-beta', authContext: 'beta' })
  store.db.prepare('INSERT INTO execution_receipts(session_id,id,record) VALUES(?,?,?)').run(rootA, alpha.id, JSON.stringify(alpha))
  store.db.prepare('INSERT INTO execution_receipts(session_id,id,record) VALUES(?,?,?)').run(rootA, beta.id, JSON.stringify(beta))
  saveTaskContext(store, rootA, {
    assets: [{ id: 'module-asset', url: 'https://module.fixture.test', inScope: true, reachable: true }],
    requests: [
      { id: alpha.requestId, revision: 'r1', endpoint: alpha.endpoint, authContext: 'alpha', request: alpha.request, valid: true, responseReceiptId: alpha.id },
      { id: beta.requestId, revision: 'r1', endpoint: beta.endpoint, authContext: 'beta', request: beta.request, valid: true, responseReceiptId: beta.id },
    ],
    checks: [], methods: [],
  })
  const started = beginModuleInvocation(store, {
    rootId: rootA, generation: 1, workId: work.workId, executorRef: rootA,
    moduleSnapshotRef: { id: 'identity-compare', version: 1 },
  })
  const result = finishModuleInvocation(store, {
    rootId: rootA, invocationRef: started.invocationRef, outcome: 'verification-observed',
    outputRefs: [
      { kind: 'receipt', id: alpha.id }, { kind: 'receipt', id: beta.id },
      receiptRefs(alpha.id, beta.id), {
      kind: 'artifact',
      artifact: { kind: 'analysis', title: '权限对照结论', detail: '两个身份均留在各自对象边界内；只记录观察，不升级为漏洞。',
        sourceRefs: [{ kind: 'receipt', id: alpha.id }, { kind: 'receipt', id: beta.id }] },
    }],
  })
  assert.equal(result.invocationRef.state, 'completed')
  assert.equal(result.validation.observationStatus, 'verified')
  assert.equal(readWorkItem(store, rootA, work.workId).state, 'completed')
  assert.equal(result.validation.contract.evidencePolicy, 'fresh')
  assert.equal(result.validation.contract.moduleId, 'identity-compare')
  assert.equal(result.validation.contract.outputKind, 'AuthorizationComparison')
  assert.equal(result.outputRefs.filter(item => item.kind === 'receipt').length, 2)
  assert.equal(Object.hasOwn(result.outputRefs[0], 'verified'), false)

  const draft = defineModuleDraft(store, 'session:' + rootA, {
    id: 'm01-analysis-fixture', title: 'M01 分析夹具', purpose: '只验证分析产物合同。',
    instructions: '使用已有材料输出 analysis。', outputs: [{ kind: 'ObservationBundle', evidencePolicy: 'reuse' }],
  })
  const analysisWork = createWorkItem(store, rootA, { title: '本机分析', question: '分析已有材料', target: 'https://module.fixture.test' }).work
  const analysisStart = beginModuleInvocation(store, {
    rootId: rootA, generation: 1, workId: analysisWork.workId, executorRef: rootA,
    moduleSnapshotRef: { id: draft.id, version: draft.version, digest: draft.digest, ownerKey: 'session:' + rootA },
  })
  const analysis = finishModuleInvocation(store, {
    rootId: rootA, invocationRef: analysisStart.invocationRef, outcome: 'analysis-complete',
    outputRefs: [{ kind: 'artifact', artifact: { kind: 'analysis', title: '本机分析结果', detail: '这是基于已有材料的分析产物，未发送新的目标请求。', sourceRefs: [] } }],
  })
  assert.equal(analysis.validation.productStatus, 'satisfied')
  assert.equal(analysis.validation.observationStatus, 'not-required')

  const historical = freshReceipt({ id: 'receipt-reuse', requestId: 'request-reuse', authContext: 'alpha' })
  store.db.prepare('INSERT INTO execution_receipts(session_id,id,record) VALUES(?,?,?)').run(rootA, historical.id, JSON.stringify(historical))
  saveTaskContext(store, rootA, {
    assets: [{ id: 'module-asset', url: 'https://module.fixture.test', inScope: true, reachable: true }],
    requests: [{ id: historical.requestId, revision: 'r1', endpoint: historical.endpoint,
      authContext: 'alpha', request: historical.request, valid: true, responseReceiptId: historical.id }],
    checks: [], methods: [],
  })
  saveTaskContext(store, rootA, {
    assets: [{ id: 'module-asset', url: 'https://module.fixture.test', inScope: true, reachable: true }],
    requests: [{ id: historical.requestId, revision: 'r2', endpoint: historical.endpoint,
      authContext: 'alpha', valid: false }],
    checks: [], methods: [],
  })
  const reuseWork = createWorkItem(store, rootA, { title: '历史回执复用', question: '复用已有观察',
    target: 'https://module.fixture.test' }).work
  const reuseStart = beginModuleInvocation(store, {
    rootId: rootA, generation: 1, workId: reuseWork.workId, executorRef: rootA,
    moduleSnapshotRef: { id: draft.id, version: draft.version, digest: draft.digest, ownerKey: 'session:' + rootA },
  })
  const reuse = finishModuleInvocation(store, {
    rootId: rootA, invocationRef: reuseStart.invocationRef, outcome: 'verification-observed',
    outputRefs: [{
      kind: 'artifact',
      artifact: { kind: 'observation', title: '历史观察复用', detail: '引用完整性有效但不再 current 的历史回执，仅用于 reuse 合同。',
        sourceRefs: [{ kind: 'receipt', id: historical.id }] },
    }, { kind: 'receipt', id: historical.id }],
  })
  assert.equal(reuse.validation.contract.evidencePolicy, 'reuse')
  assert.equal(reuse.outputRefs.find(item => item.kind === 'receipt').observation.current, false)
})

await test('M01/T01：competition_execution 非 HTTP 产物可接入固定模块合同', () => {
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = 'E:\\工作\\WorkBuddy\\WebSec\\dsh\\_ref\\tmp\\competition-module-test'
  const rootId = 'competition-module-root'
  try {
    startTaskPolicy(store, rootId, { mode: 'regular', target: 'http://127.0.0.1', question: '非 HTTP 本机命令', budget: { workers: 0 } })
    const challenge = createCompetitionChallenge(store, rootId, {
      challengeId: 'challenge-local-command',
      title: '本机命令取证', prompt: '运行本机命令并验证 stdout。',
      environment: { kind: 'host', network: 'none' },
    })
    const work = createWorkItem(store, rootId, {
      title: '本机命令模式', question: '用本机命令产生可验证输出',
      target: '', capabilities: ['competition_execution'],
    }).work
    const started = beginModuleInvocation(store, {
      rootId, generation: 1, workId: work.workId, executorRef: rootId,
      moduleSnapshotRef: { id: 'ctf-solve', version: 1 },
    })
    const root = challengeRoot(rootId, challenge.challengeId)
    const workDir = path.join(root, 'work')
    const outputDir = path.join(root, 'output')
    fs.mkdirSync(workDir, { recursive: true })
    fs.mkdirSync(outputDir, { recursive: true })
    const stdoutFile = path.join(outputDir, 'competition-non-http.stdout.log')
    const stderrFile = path.join(outputDir, 'competition-non-http.stderr.log')
    const stdoutBuffer = Buffer.from('SAKER_NON_HTTP_OK\n')
    const stderrBuffer = Buffer.alloc(0)
    fs.writeFileSync(stdoutFile, stdoutBuffer)
    fs.writeFileSync(stderrFile, stderrBuffer)
    const capturedAt = new Date().toISOString()
    const outputAnchors = {
      revision: 1,
      capturedAt,
      environment: 'host',
      executorPid: 4242,
      stdout: { bytes: stdoutBuffer.length, sha256: createHash('sha256').update(stdoutBuffer).digest('hex'), capturedAt },
      stderr: { bytes: stderrBuffer.length, sha256: createHash('sha256').update(stderrBuffer).digest('hex'), capturedAt },
    }
    const endedAt = new Date(Date.now() + 1000).toISOString()
    store.db.prepare('INSERT INTO competition_executions(session_id,challenge_id,execution_id,state,record,updated_at) VALUES(?,?,?,?,?,?)')
      .run(rootId, challenge.challengeId, 'competition-non-http', 'completed', JSON.stringify({
        sessionId: rootId, challengeId: challenge.challengeId, executionId: 'competition-non-http',
        state: 'completed', environment: 'host', image: '', command: 'printf SAKER_NON_HTTP_OK',
        pid: 4242, network: 'none', instanceRevision: 1, workDir, inputDir: path.join(root, 'input'),
        outputDir, stdoutFile, stderrFile, exitCode: 0, signal: null, timedOut: false,
        outputRevision: 1, outputAnchors, endedAt, updatedAt: endedAt,
      }), endedAt)
    const result = finishModuleInvocation(store, {
      rootId, invocationRef: started.invocationRef, outcome: 'verification-observed',
      outputRefs: [
        { kind: 'competition', id: 'competition-non-http', challengeId: challenge.challengeId },
        { kind: 'artifact', artifact: { kind: 'answer', title: '本机命令输出',
          detail: '命令 exit 0，stdout 为 SAKER_NON_HTTP_OK；没有发送 HTTP 请求。',
          sourceRefs: [{ kind: 'competition', id: 'competition-non-http' }] } },
      ],
    })
    assert.equal(result.invocationRef.state, 'completed')
    assert.equal(result.validation.contract.moduleId, 'ctf-solve')
    assert.equal(result.validation.contract.outputKind, 'CtfResultBundle')
    assert.equal(result.validation.observationStatus, 'verified')
    assert.equal(result.outputRefs.find(item => item.kind === 'competition').observation.source, 'competition-execution')
    assert.equal(result.outputRefs.find(item => item.kind === 'competition').observation.exitCode, 0)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync('E:\\工作\\WorkBuddy\\WebSec\\dsh\\_ref\\tmp\\competition-module-test',
      { recursive: true, force: true })
  }
})

await test('F03 生产者在实际进程结束后持久化输出锚点', async () => {
  const previousHome = process.env.DSH_HOME
  const home = 'E:\\工作\\WorkBuddy\\WebSec\\dsh\\_ref\\tmp\\competition-anchor-test'
  process.env.DSH_HOME = home
  const rootId = 'competition-anchor-root'
  try {
    startTaskPolicy(store, rootId, { mode: 'regular', target: 'http://127.0.0.1', budget: { workers: 0 } })
    const challenge = createCompetitionChallenge(store, rootId, {
      challengeId: 'challenge-anchor', title: '输出锚点',
      prompt: '运行命令并保存锚点。', environment: { kind: 'host', network: 'none' },
    })
    const first = runCompetitionExecution(store, rootId, challenge.challengeId, {
      command: 'echo SAKER_ANCHOR_OK', environment: 'host', network: 'none',
      requestId: 'anchor-request-' + Date.now(),
    })
    let record = first
    const deadline = Date.now() + 12000
    while (!['completed', 'failed', 'stopped', 'unknown'].includes(record.state) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
      record = readCompetitionExecution(store, rootId, challenge.challengeId, first.executionId)
    }
    assert.equal(record.state, 'completed')
    assert.equal(typeof record.exitCode, 'number')
    assert.equal(record.exitCode, 0)
    assert.equal(record.signal, null)
    assert.equal(record.timedOut, false)
    assert.ok(Number.isSafeInteger(record.outputRevision) && record.outputRevision >= 1)
    assert.ok(record.outputAnchors?.stdout)
    assert.ok(record.outputAnchors?.stderr)
    const stdout = fs.readFileSync(record.stdoutFile)
    const stderr = fs.readFileSync(record.stderrFile)
    assert.equal(stdout.length, record.outputAnchors.stdout.bytes)
    assert.equal(stderr.length, record.outputAnchors.stderr.bytes)
    assert.equal(createHash('sha256').update(stdout).digest('hex'), record.outputAnchors.stdout.sha256)
    assert.equal(createHash('sha256').update(stderr).digest('hex'), record.outputAnchors.stderr.sha256)
    assert.match(stdout.toString('utf8'), /SAKER_ANCHOR_OK/)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(home, { recursive: true, force: true })
  }
})

await test('调用：取消只影响该调用，兄弟 work 不受影响', () => {
  const work1 = createWorkItem(store, rootA, { question: '可取消的专项一', target: 'https://module.fixture.test' }).work
  const work2 = createWorkItem(store, rootA, { question: '独立专项二', target: 'https://module.fixture.test' }).work
  const one = beginModuleInvocation(store, { rootId: rootA, generation: 1, workId: work1.workId, executorRef: rootA, moduleSnapshotRef: { id: 'web-liveness' } })
  const two = beginModuleInvocation(store, { rootId: rootA, generation: 1, workId: work2.workId, executorRef: rootA, moduleSnapshotRef: { id: 'web-liveness' } })
  const cancelled = cancelModuleInvocation(store, { rootId: rootA, invocationRef: one.invocationRef, reason: '用户停止该调用' })
  assert.equal(cancelled.invocationRef.state, 'cancelled')
  const listed = listModuleInvocations(store, { rootId: rootA, filter: { workId: work2.workId } })
  assert.equal(listed.items[0].state, 'active')
  assert.equal(listed.items[0].invocationRef.id, two.invocationRef.id)
})

await test('调用：能力缺项时不创建 active 调用，返回真实缺项', () => {
  const work = createWorkItem(store, rootA, { question: '缺少隔离环境的两版本复现', target: 'https://module.fixture.test' }).work
  const preview = beginModuleInvocation(store, {
    rootId: rootA, generation: 1, workId: work.workId, executorRef: rootA,
    moduleSnapshotRef: { id: 'version-reproduction' },
    prerequisites: { canExecute: false, missingPrerequisites: [{ code: 'MISSING_CAPABILITY', message: '缺少隔离环境' }] },
  })
  assert.equal(preview.invocationRef, null)
  assert.equal(preview.canExecute, false)
  assert.equal(preview.missingPrerequisites[0].message, '缺少隔离环境')
  assert.equal(listModuleInvocations(store, { rootId: rootA, filter: { workId: work.workId } }).page.total, 0)
})

await test('调用列表按 root 隔离，未知 root 为空', () => {
  const a = listModuleInvocations(store, { rootId: rootA })
  const b = listModuleInvocations(store, { rootId: rootB })
  assert.ok(a.page.total >= 2)
  assert.equal(b.page.total, 0)
})

await test('偏好：CAS 版本递增，旧 revision 冲突', () => {
  assert.throws(() => writeModulePreference(store, {
    hostSession: '', workspaceKey: '', projectKey: '',
    moduleSnapshotRef: { id: 'web-liveness', version: 1 },
  }), /真实 Host 会话/)
  const first = writeModulePreference(store, {
    hostSession: rootA, workspaceKey: 'w', projectKey: 'p',
    moduleSnapshotRef: { id: 'web-liveness', version: 1 }, operation: 'auto',
  }, { expectedRevision: 0 })
  assert.equal(first.preferenceRevision, 1)
  assert.throws(() => writeModulePreference(store, {
    hostSession: rootA, workspaceKey: 'w', projectKey: 'p',
    moduleSnapshotRef: { id: 'fingerprint', version: 1 },
  }, { expectedRevision: 0 }), /刷新/)
  const second = writeModulePreference(store, {
    hostSession: rootA, workspaceKey: 'w', projectKey: 'p',
    moduleSnapshotRef: { id: 'fingerprint', version: 1 },
  }, { expectedRevision: 1 })
  assert.equal(second.preferenceRevision, 2)
  assert.equal(readModulePreference(store, { hostSession: rootA, workspaceKey: 'w', projectKey: 'p' }).revision, 2)
})

await test('F03 competition 输出锚点、exitCode 类型和超时负例不能完成验证', () => {
  let sequence = 0
  const runCase = (label, mutateRecord, mutateFiles, expectedCode) => {
    sequence += 1
    const rootId = 'f03-root-' + sequence
    const challengeId = 'f03-challenge-' + sequence
    startTaskPolicy(store, rootId, { mode: 'regular', target: 'http://127.0.0.1', budget: { workers: 0 } })
    createCompetitionChallenge(store, rootId, {
      challengeId, title: 'F03 ' + label, prompt: '验证输出锚点。',
      environment: { kind: 'host', network: 'none' },
    })
    const work = createWorkItem(store, rootId, {
      title: 'F03 ' + label, question: '验证输出锚点。',
      target: '', capabilities: ['competition_execution'],
    }).work
    const started = beginModuleInvocation(store, {
      rootId, generation: 1, workId: work.workId, executorRef: rootId,
      moduleSnapshotRef: { id: 'ctf-solve', version: 1 },
    })
    const root = challengeRoot(rootId, challengeId)
    const workDir = path.join(root, 'work')
    const outputDir = path.join(root, 'output')
    fs.mkdirSync(workDir, { recursive: true })
    fs.mkdirSync(outputDir, { recursive: true })
    const executionId = 'f03-execution-' + sequence
    const stdoutFile = path.join(outputDir, executionId + '.stdout.log')
    const stderrFile = path.join(outputDir, executionId + '.stderr.log')
    const stdout = Buffer.from('F03_OUT_' + sequence + '\n')
    const stderr = Buffer.from('F03_ERR_' + sequence + '\n')
    fs.writeFileSync(stdoutFile, stdout)
    fs.writeFileSync(stderrFile, stderr)
    const capturedAt = new Date().toISOString()
    const record = {
      sessionId: rootId, challengeId, executionId,
      state: 'completed', environment: 'host', image: '', command: 'fixture',
      pid: 6000 + sequence, network: 'none', instanceRevision: 1,
      workDir, inputDir: path.join(root, 'input'), outputDir,
      stdoutFile, stderrFile, exitCode: 0, signal: null, timedOut: false,
      outputRevision: 1,
      outputAnchors: {
        revision: 1, capturedAt, environment: 'host', executorPid: 6000 + sequence,
        stdout: { bytes: stdout.length, sha256: createHash('sha256').update(stdout).digest('hex'), capturedAt },
        stderr: { bytes: stderr.length, sha256: createHash('sha256').update(stderr).digest('hex'), capturedAt },
      },
      endedAt: new Date(Date.now() + 1000).toISOString(), updatedAt: new Date().toISOString(),
    }
    mutateRecord(record)
    store.db.prepare('INSERT INTO competition_executions(session_id,challenge_id,execution_id,state,record,updated_at) VALUES(?,?,?,?,?,?)')
      .run(rootId, challengeId, executionId, record.state, JSON.stringify(record), record.updatedAt)
    mutateFiles({ stdoutFile, stderrFile })
    assert.throws(() => finishModuleInvocation(store, {
      rootId, invocationRef: started.invocationRef, outcome: 'verification-observed',
      outputRefs: [
        { kind: 'competition', id: executionId, challengeId },
        { kind: 'artifact', artifact: { kind: 'answer', title: 'F03', detail: label,
          sourceRefs: [{ kind: 'competition', id: executionId }] } },
      ],
    }), error => error.code === expectedCode, label + ' expected ' + expectedCode)
    const invocation = store.db.prepare('SELECT state,revision FROM saker_module_invocations WHERE invocation_id=?').get(started.invocationRef.id)
    assert.equal(invocation.state, 'active')
    assert.equal(invocation.revision, 1)
    cancelModuleInvocation(store, { rootId, invocationRef: started.invocationRef, reason: label })
  }

  runCase('tampered stdout', () => {}, ({ stdoutFile }) => fs.writeFileSync(stdoutFile, 'TAMPERED\n'), 'EVIDENCE_INTEGRITY_FAILED')
  runCase('missing anchor', record => { delete record.outputAnchors; delete record.outputRevision }, () => {}, 'EVIDENCE_INTEGRITY_UNKNOWN')
  runCase('string exitCode', record => { record.exitCode = '0' }, () => {}, 'EVIDENCE_CONTRACT_UNSATISFIED')
  runCase('null exitCode', record => { record.exitCode = null }, () => {}, 'EVIDENCE_CONTRACT_UNSATISFIED')
  runCase('timed out', record => { record.timedOut = true }, () => {}, 'EVIDENCE_CONTRACT_UNSATISFIED')
  runCase('deleted stdout', () => {}, ({ stdoutFile }) => fs.rmSync(stdoutFile), 'MISSING_PREREQUISITE')
})

store.db.close()
console.log(failed ? `\n${failed} failed` : '\nall module tests passed')
process.exit(failed ? 1 : 0)
