import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../plugins/dsh-redteam-results/lib/client.js', import.meta.url), 'utf8')
const start = source.indexOf('function readJsonResponse(')
const end = source.indexOf('/** CSRF', start)
assert(start >= 0 && end > start, 'readJsonResponse is present in the shipped client')

const sandbox = {}
runInNewContext(source.slice(start, end) + ';this.readJsonResponse = readJsonResponse', sandbox)
const readJsonResponse = sandbox.readJsonResponse
const response = (status, body, type = 'application/json') => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: name => name.toLowerCase() === 'content-type' ? type : null },
  text: async () => body,
})

assert.equal((await readJsonResponse(response(200, '{"ok":true}'), '测试接口')).ok, true)
await assert.rejects(() => readJsonResponse(response(500, 'server exploded', 'text/plain'), '测试接口'), /HTTP 500/)
await assert.rejects(() => readJsonResponse(response(400, JSON.stringify({
  ok: false, code: 'session-not-found', error: '未找到该会话，请重新选择', requestId: 'read-1', hint: 'internal hint',
})), '测试接口'), error => {
  assert.equal(error.message, '未找到该会话，请重新选择（HTTP 400）')
  assert.equal(error.code, 'session-not-found')
  assert.equal(error.requestId, 'read-1')
  assert.equal(error.status, 400)
  return true
})
await assert.rejects(() => readJsonResponse(response(502, '{"error":{"message":"unexpected shape"}}'), '测试接口'), /HTTP 502/)
await assert.rejects(() => readJsonResponse(response(200, ''), '测试接口'), /响应为空/)
await assert.rejects(() => readJsonResponse(response(200, '{bad json', 'application/json'), '测试接口'), /不是 JSON/)
assert.match(source, /readJsonResponse\(r, "Saker " \+ endpoint\)/, 'the API path must use the shared parser')
assert.match(source, /readJsonResponse\(r, "读取 CSRF"\)/, 'the CSRF path must use the shared parser')

console.log('ok   client JSON responses keep status, empty-body and non-JSON failures explicit')
