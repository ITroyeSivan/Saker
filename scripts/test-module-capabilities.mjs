import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js'
import { listModuleDefinitions, detailModuleDefinition } from '../plugins/dsh-redteam-results/lib/test-module-registry.js'
import { moduleCapabilityResolver } from '../plugins/dsh-redteam-results/lib/module-capabilities.js'
import { markToolAvailable, resetToolAvailability } from '../lib/tool-availability.js'

const toolRoot = mkdtempSync(join(tmpdir(), 'saker-cap-root-'))
const store = openStore(':memory:')
let failed = 0
async function test(name, fn) {
  try { await fn(); console.log('ok   ' + name) }
  catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)) }
}

try {
  resetToolAvailability()
  markToolAvailable('seatbelt_posture')
  markToolAvailable('ad_export_ingest')
  markToolAvailable('js_deobfuscate')
  markToolAvailable('version_reproduce')
  mkdirSync(join(toolRoot, 'bin'), { recursive: true })
  mkdirSync(join(toolRoot, 'node_modules', '.bin'), { recursive: true })
  writeFileSync(join(toolRoot, 'bin', 'httpx.exe'), '')
  writeFileSync(join(toolRoot, 'bin', 'Seatbelt.exe'), '')
  writeFileSync(join(toolRoot, 'node_modules', '.bin', 'webcrack.cmd'), '')
  process.env.SAKER_TOOL_ROOTS = toolRoot
  const session = { id: 'cap-root', header: { cwd: toolRoot } }
  const ctx = {
    agents: { get: id => id === session.id ? { session } : null },
    settings: null,
    tools: { schemas: () => [
      { name: 'redteam_execution' }, { name: 'saker_material' }, { name: 'saker_component' },
      { name: 'asset_search' }, { name: 'httpx_probe' }, { name: 'tls_probe' },
      { name: 'seatbelt_posture' }, { name: 'ad_export_ingest' },
    ] },
  }
  const resolver = moduleCapabilityResolver(ctx, { session })

  await test('能力合并：内置研究可用，httpx 已验证，版本复现已接隔离 lab', () => {
    assert.equal(resolver({ id: 'nday-match', source: 'builtin' }).runtimeStatus, 'available')
    assert.equal(resolver({ id: 'web-liveness', source: 'builtin' }).runtimeStatus, 'available')
    assert.equal(resolver({ id: 'version-reproduction', source: 'builtin' }).runtimeStatus, 'available')
    assert.ok(resolver({ id: 'web-liveness', source: 'builtin' }).tools.includes('httpx'))
    assert.equal(resolver({ id: 'protocol-boundary-test', source: 'builtin' }).runtimeStatus, 'available')
    assert.equal(resolver({ id: 'sourcemap-recovery', source: 'builtin' }).runtimeStatus, 'available')
    assert.equal(resolver({ id: 'crypto-transport-test', source: 'builtin' }).runtimeStatus, 'available')
    assert.equal(resolver({ id: 'host-posture', source: 'builtin' }).runtimeStatus, 'available')
    assert.equal(resolver({ id: 'ad-recon', source: 'builtin' }).runtimeStatus, 'available')
    assert.equal(resolver({ id: 'ad-path-review', source: 'builtin' }).runtimeStatus, 'available')
    assert.equal(resolver({ id: 'js-deobfuscation', source: 'builtin' }).runtimeStatus, 'available')
    assert.equal(resolver({ id: 'version-reproduction', source: 'builtin' }).runtimeStatus, 'available')
  })

  await test('preset 已注册工具即使不在工作台受限 schema 中，也不误报缺失', () => {
    const fallbackCtx = {
      ...ctx,
      tools: {
        schemas: () => [
          { name: 'redteam_execution' }, { name: 'saker_material' }, { name: 'saker_component' },
          { name: 'asset_search' }, { name: 'httpx_probe' }, { name: 'tls_probe' },
        ],
        view: () => ({ knownNames: new Set([
          'redteam_execution', 'saker_material', 'saker_component', 'asset_search',
          'httpx_probe', 'tls_probe',
        ]) }),
      },
    }
    const fallback = moduleCapabilityResolver(fallbackCtx, { session })
    assert.equal(fallback({ id: 'host-posture', source: 'builtin' }).runtimeStatus, 'available')
    assert.equal(fallback({ id: 'ad-recon', source: 'builtin' }).runtimeStatus, 'available')
    assert.equal(fallback({ id: 'ad-path-review', source: 'builtin' }).runtimeStatus, 'available')
  })

  await test('能力过滤：status/source/toolRef 在分页前生效', () => {
    const partial = listModuleDefinitions(store, { rootId: session.id, capabilityResolver: resolver, filter: { status: 'partial' }, page: { limit: 100 } })
    assert.ok(partial.items.some(item => item.id === 'network-path-check'))
    assert.ok(partial.items.every(item => item.runtimeStatus === 'partial'))
    const builtin = listModuleDefinitions(store, { rootId: session.id, capabilityResolver: resolver, filter: { source: 'builtin' }, page: { limit: 100 } })
    assert.ok(builtin.items.every(item => item.source === 'builtin'))
    const httpx = listModuleDefinitions(store, { rootId: session.id, capabilityResolver: resolver, filter: { toolRef: 'httpx' }, page: { limit: 100 } })
    assert.ok(httpx.items.some(item => item.id === 'web-liveness'))
  })

  await test('详情带真实能力与版本复现工具', () => {
    const detail = detailModuleDefinition(store, { rootId: session.id, ref: { id: 'version-reproduction' }, capabilityResolver: resolver })
    assert.equal(detail.runtimeStatus, 'available')
    assert.equal(detail.canExecute, true)
    assert.ok(detail.tools.includes('隔离容器复现'))
  })

  await test('未配置隔离 lab 时版本复现仍为 blocked', () => {
    resetToolAvailability()
    markToolAvailable('seatbelt_posture')
    markToolAvailable('ad_export_ingest')
    markToolAvailable('js_deobfuscate')
    const blockedResolver = moduleCapabilityResolver(ctx, { session })
    const blocked = detailModuleDefinition(store, { rootId: session.id, ref: { id: 'version-reproduction' }, capabilityResolver: blockedResolver })
    assert.equal(blocked.runtimeStatus, 'blocked')
    assert.equal(blocked.canExecute, false)
    assert.ok(blocked.missingPrerequisites.length > 0)
  })
} finally {
  delete process.env.SAKER_TOOL_ROOTS
  resetToolAvailability()
  store.db.close()
  rmSync(toolRoot, { recursive: true, force: true })
}

console.log(failed ? `\n${failed} failed` : '\nall module capability tests passed')
process.exit(failed ? 1 : 0)
