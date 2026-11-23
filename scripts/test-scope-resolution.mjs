import assert from 'node:assert/strict'
import {
  assertRootScope,
  resolveScopeDescriptor,
  sessionWorkspaceIdentity,
  scopeError,
} from '../plugins/dsh-redteam-results/lib/scope-resolution.js'

let checks = 0
const ok = (name, fn) => {
  checks += 1
  try {
    fn()
    console.log('ok   ' + name)
  } catch (error) {
    console.log('FAIL ' + name)
    throw error
  }
}

const session = { workspaceId: 'workspace-A', cwd: 'E:\\work\\A' }

ok('读取 Host 工作区身份', () => assert.equal(sessionWorkspaceIdentity(session), 'workspace-A'))
ok('无身份拒绝', () => assert.throws(
  () => resolveScopeDescriptor({ entrySessionId: 's1', session: {}, projectKey: 'p1' }),
  error => error.code === 'SCOPE_MISMATCH',
))
ok('会话不存在拒绝', () => assert.throws(
  () => resolveScopeDescriptor({ entrySessionId: 's1', session: null, projectKey: 'p1' }),
  error => error.code === 'SCOPE_MISMATCH',
))
ok('请求另一个不可访问 workspace 拒绝', () => assert.throws(
  () => resolveScopeDescriptor({ entrySessionId: 's1', workspaceId: 'workspace-B', session, projectKey: 'p1' }),
  error => error.code === 'SCOPE_MISMATCH',
))
ok('显式可访问 workspace 通过', () => {
  const value = resolveScopeDescriptor({ entrySessionId: 's1', workspaceId: 'workspace-B', session, projectKey: 'p1', workspaceAccessible: true })
  assert.equal(value.workspaceId, 'workspace-B')
})
ok('稳定 workspace/project 描述', () => {
  const value = resolveScopeDescriptor({ entrySessionId: 's1', session, projectKey: 'workspace:p1', cwd: 'E:\\work\\A' })
  assert.equal(value.entrySessionId, 's1')
  assert.equal(value.rootId, 's1')
  assert.equal(value.projectKey, 'workspace:p1')
  assert.match(value.workspaceKey, /^workspace:[a-f0-9]{32}$/)
  assert.match(value.scopeRevision, /^[a-f0-9]{64}$/)
  assert.equal(value.classification, 'resolved')
})
ok('root project 不同标记 legacy-unassigned', () => {
  const value = resolveScopeDescriptor({ entrySessionId: 's1', session, projectKey: 'workspace:new', rootProjectKey: 'workspace:old' })
  assert.equal(value.classification, 'legacy-unassigned')
  assert.throws(() => assertRootScope({ rootProjectKey: 'workspace:old', projectKey: 'workspace:new' }), error => error.code === 'SCOPE_MISMATCH')
})
ok('同一 project 放行', () => assert.doesNotThrow(() => assertRootScope({ rootProjectKey: 'workspace:p1', projectKey: 'workspace:p1' })))
ok('缺失 project 不误伤历史数据', () => assert.doesNotThrow(() => assertRootScope({ rootProjectKey: '', projectKey: 'workspace:p1' })))
ok('scopeError 带 code', () => assert.equal(scopeError('x', 'MISSING_PREREQUISITE').code, 'MISSING_PREREQUISITE'))

console.log(`ok   ${checks} scope resolution checks`)
