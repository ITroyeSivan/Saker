import './test-home-isolation.mjs'
import assert from 'node:assert/strict'
import { openStore, registerFinding, allFindings } from '../plugins/dsh-redteam-results/lib/store.js'
import { saveTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js'

const store = openStore(':memory:')
try {
  const sessionId = 'evidence-refs'
  const endpoint = 'https://fixture.test/api/orders'
  saveTaskContext(store, sessionId, {
    assets: [{ id: 'asset-1', url: 'https://fixture.test', inScope: true }],
    requests: [{
      id: 'request-1',
      revision: 'r1',
      endpoint,
      authContext: 'request-material',
      method: 'GET',
      headers: { Host: 'fixture.test' },
      request: 'GET /api/orders HTTP/1.1\r\nHost: fixture.test\r\n\r\n',
      valid: true,
      response: 'HTTP/1.1 200 OK\r\n\r\n{}',
    }],
    checks: [],
    methods: [],
    maxSupplementAttempts: 2,
  })
  registerFinding(store, sessionId, 'pentest', {
    title: '引用绑定回归',
    severity: 'high',
    target: endpoint,
    summary: '请求引用应被识别为当前会话的已有证据。',
    evidenceRefs: [{ kind: 'request', id: 'request-1:r1' }],
  })
  const finding = allFindings(store, sessionId, 'pentest')[0]
  assert.equal(finding.evidenceReferenceValidation.refs[0].exists, true,
    'an existing task-context request must validate as evidence')
  assert.deepEqual(finding.evidenceReferenceValidation.missing, [])
  assert(!finding.delivery.gaps.includes('actual-evidence-reference-invalid'))
  console.log('ok   request evidenceRefs resolve against the current task context')
  console.log('ok   valid request references no longer block delivery as missing files')
} finally {
  store.close()
}
console.log('\n2 evidence reference checks passed')
