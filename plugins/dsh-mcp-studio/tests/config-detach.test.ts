import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toMcpClientConfig, type ServerEntry } from '../src/types.ts'
import { Config } from '@deepseek-ai/dsh-mcp-client'

test('direct mounts detach reflected dictionaries before the client schema validates', () => {
  const reflected = Object.assign(Object.create({ reflected: true }), { TEMP: 'local-temp' })
  const row = { name: 'fixture', transport: 'stdio', command: 'node', argsLine: '', cwd: '', env: reflected, toolCallTimeoutMs: 10000, failOnStartupError: false } as ServerEntry
  const config = toMcpClientConfig(row)
  const result = Config['~standard'].validate(config)
  assert(!('issues' in result), JSON.stringify(result))
  if (config.transport !== 'stdio') throw new Error('stdio expected')
  assert.equal(Object.getPrototypeOf(config.env), Object.prototype)
  assert.notEqual(config.env, row.env)
  assert.deepEqual(config.env, { TEMP: 'local-temp' })
})
