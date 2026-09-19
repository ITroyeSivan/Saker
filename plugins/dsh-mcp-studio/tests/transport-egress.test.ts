/**
 * 统一出站策略：包运行器（npx/npm/pnpm/uvx…）首次启动会访问公网 registry，
 * 冻结档必须在 spawn 之前拦下——不能"先拉包再报错"。
 *
 * 这里测的是本地**同步**判定与阻塞通道；判定语义与根包 `dsh-saker/lib/egress.js`
 * 的一致性由 `scripts/test-egress-policy-consistency.mjs` 单独锁。
 */
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { evaluateRunnerEgress, openChannel, runnerRegistryHost } from '../src/transport.ts'
import type { ServerEntry } from '../src/types.ts'

const serverOf = (command: string, argsLine = ''): ServerEntry => ({
  id: 's1',
  enabled: true,
  name: 'demo',
  transport: 'stdio',
  command,
  argsLine,
  env: [],
  cwd: '',
  exposure: 'direct',
  toolCallTimeoutMs: 5000,
  url: '',
  headers: [],
  description: '',
} as unknown as ServerEntry)

const withPolicy = (mode: string, allowHosts: string[] = []): { home: string; restore: () => void } => {
  const home = mkdtempSync(join(tmpdir(), 'mcs-egress-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  mkdirSync(join(home, 'saker-egress'), { recursive: true })
  writeFileSync(join(home, 'saker-egress', 'policy.json'), JSON.stringify({ version: 1, mode, allowHosts }), 'utf8')
  return {
    home,
    restore: () => {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      rmSync(home, { recursive: true, force: true })
    },
  }
}

test('runnerRegistryHost 只认包运行器', () => {
  assert.equal(runnerRegistryHost('npx'), 'registry.npmjs.org')
  assert.equal(runnerRegistryHost('C:\\Program Files\\nodejs\\npx.cmd'), 'registry.npmjs.org')
  assert.equal(runnerRegistryHost('uvx'), 'pypi.org')
  assert.equal(runnerRegistryHost('node'), '')
  assert.equal(runnerRegistryHost('/usr/bin/python3'), '')
})

test('冻结档：npx 服务器在任何进程启动前被拦下，并写审计', () => {
  const ctx = withPolicy('frozen')
  try {
    const verdict = evaluateRunnerEgress(serverOf('npx', '-y @modelcontextprotocol/server-everything'))
    assert.equal(verdict.decision, 'deny')
    assert.equal(verdict.reason, 'infra_frozen')
    assert.equal(verdict.host, 'registry.npmjs.org')

    const channel = openChannel(serverOf('npx', '-y @modelcontextprotocol/server-everything'))
    assert.equal(channel.alive, false)
    assert.match(String(channel.closedReason), /统一出站策略拦截/)
    assert.match(String(channel.closedReason), /registry\.npmjs\.org/)

    const audit = readFileSync(join(ctx.home, 'saker-egress', 'audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    assert.ok(audit.some((row) => row.plugin === 'dsh-mcp-studio' && row.decision === 'deny' && row.host === 'registry.npmjs.org'))
    channel.close()
  } finally {
    ctx.restore()
  }
})

test('白名单档：只有列出的 registry 放行', () => {
  const ctx = withPolicy('allowlist', ['registry.npmjs.org'])
  try {
    assert.equal(evaluateRunnerEgress(serverOf('npx')).decision, 'allow')
    assert.equal(evaluateRunnerEgress(serverOf('uvx')).decision, 'deny')
  } finally {
    ctx.restore()
  }
})

test('非包运行器不受策略影响（本地可执行文件仍然能起）', () => {
  const ctx = withPolicy('frozen')
  const channel = openChannel(serverOf(process.execPath, '-e "process.exit(0)"'))
  try {
    assert.equal(evaluateRunnerEgress(serverOf(process.execPath)).reason, 'no-registry-fetch')
    assert.equal(channel.alive, true)
  } finally {
    channel.close()
    ctx.restore()
  }
})
