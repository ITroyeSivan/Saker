import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(root, 'plugins/dsh-mode-group/lib/client.js'), 'utf8')
  .replace('module.exports = { name:', 'module.exports = { sceneApi: sceneApi, name:')

let factory
const context = {
  console,
  setTimeout,
  clearTimeout,
  Promise,
  Error,
  JSON,
  Date,
  Math,
  globalThis: {},
  document: { querySelector() { return null } },
  window: {
    __ModuleLoader__: {
      load(spec) {
        factory = spec.factory
      },
    },
  },
}
vm.runInNewContext(source, context, { filename: 'plugins/dsh-mode-group/lib/client.js' })
assert.equal(typeof factory, 'function', 'client factory must load')

const react = {
  createElement() {},
  Fragment: {},
  useState() {},
  useEffect() {},
  useCallback() {},
  useRef() {},
}
const client = factory((id) => {
  if (id === 'react') return react
  throw new Error('unexpected module: ' + id)
})
assert.equal(typeof client.sceneApi, 'function', 'sceneApi must be testable')

let serverToken = 'old-token'
let tokenReads = 0
let posts = []
let rejectAllPosts = false
context.fetch = async (url, options = {}) => {
  if (options.method === 'POST') {
    assert.equal(url.startsWith('/api/dsh-redteam-results/'), true, 'POST should use the detected API base')
    const token = String(options.headers?.['x-dsh-csrf'] || '')
    posts.push(token)
    const accepted = !rejectAllPosts && token === serverToken
    return response(accepted ? 200 : 403, accepted
      ? { ok: true, token }
      : { ok: false, code: 'route-csrf', error: 'csrf token missing or invalid' })
  }
  if (url === '/dsh-redteam-results/csrf') return response(404, {})
  assert.equal(url, '/api/dsh-redteam-results/csrf')
  tokenReads++
  return response(200, { token: serverToken })
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body },
  }
}

const first = await client.sceneApi('scene.get', { sessionId: 'session-test' })
assert.equal(first.ok, true)
assert.equal(tokenReads, 1)

serverToken = 'new-token'
const second = await client.sceneApi('scene.get', { sessionId: 'session-test' })
assert.equal(second.ok, true)
assert.equal(tokenReads, 2, 'a stale cached token should be refreshed exactly once')
assert.deepEqual(posts, ['old-token', 'old-token', 'new-token'])

posts = []
rejectAllPosts = true
await assert.rejects(
  () => client.sceneApi('scene.get', { sessionId: 'session-test' }),
  /令牌已刷新，但仍被拒绝/,
  'a second consecutive rejection must stop instead of looping',
)
assert.deepEqual(posts, ['new-token', 'new-token'])

console.log('ok   mode-group API-base detection and CSRF retry: 5/5 passed')
