import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js'
import { workbenchQuery } from '../plugins/dsh-redteam-results/lib/workbench.js'

const root = mkdtempSync(join(tmpdir(), 'saker-project-files-'))
const store = openStore(':memory:')
let failed = 0
async function test(name, fn) {
  try { await fn(); console.log('ok   ' + name) }
  catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)) }
}

try {
  mkdirSync(join(root, 'reports'), { recursive: true })
  mkdirSync(join(root, 'exp'), { recursive: true })
  writeFileSync(join(root, 'reports', 'r1.md'), '# 导出越权复测报告\n\n地址：http://127.0.0.1:19196/api/export\n')
  writeFileSync(join(root, 'exp', 'poc.py'), 'print("fixture")\n')
  const session = { id: 'project-files-root', header: { cwd: root } }
  const ctx = {
    agents: { get: id => id === session.id ? { session } : null },
    tools: { schemas: () => [] },
  }

  await test('project.files 从真实会话工作区读取报告与复现文件', () => {
    const response = workbenchQuery(ctx, store, { kind: 'project.files', context: { sessionId: session.id } })
    assert.equal(response.ok, true)
    const files = (response.data.artifacts.reportGroups || []).flatMap(group => group.files || [])
    assert.equal(files.length, 2)
    assert.ok(files.some(file => file.relPath === 'reports/r1.md' && file.title.includes('导出越权')))
    assert.ok(files.some(file => file.relPath === 'exp/poc.py' && file.kind === 'poc'))
    assert.equal(response.data.workspace, root)
  })

  await test('project.files 不按任意客户端路径读取，未知会话明确失败', () => {
    assert.throws(() => workbenchQuery(ctx, store, {
      kind: 'project.files', context: { sessionId: 'unknown-session', workspace: 'C:\\' },
    }), /工作区|会话/)
  })

  await test('project.files 查询不写数据库控制状态', () => {
    const before = store.db.prepare('SELECT COUNT(*) AS n FROM saker_command_records').get().n
    workbenchQuery(ctx, store, { kind: 'project.files', context: { sessionId: session.id } })
    const after = store.db.prepare('SELECT COUNT(*) AS n FROM saker_command_records').get().n
    assert.equal(after, before)
  })
} finally {
  store.db.close()
  rmSync(root, { recursive: true, force: true })
}

console.log(failed ? `\n${failed} failed` : '\nall project.files tests passed')
process.exit(failed ? 1 : 0)
