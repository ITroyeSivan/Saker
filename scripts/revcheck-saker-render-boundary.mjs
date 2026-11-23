import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = resolve(root, '..', '_ref', 'tmp')
const fixture = fs.mkdtempSync(join(tmp, 'revcheck-render-boundary-'))
try {
  fs.mkdirSync(join(fixture, 'src', 'client'), { recursive: true })
  fs.mkdirSync(join(fixture, 'scripts'), { recursive: true })
  const client = join(fixture, 'src', 'client', 'index.js')
  const original = fs.readFileSync(join(root, 'src', 'client', 'index.js'), 'utf8')
  const anchor = '}, h(SakerBoundaryContent, { build: buildPageContent })))));'
  assert.equal(original.split(anchor).length - 1, 1, 'boundary wiring anchor must occur exactly once')
  fs.writeFileSync(client, original.replace(anchor, '}, buildPageContent())))));'))
  fs.copyFileSync(join(root, 'scripts', 'test-saker-render-boundary.mjs'), join(fixture, 'scripts', 'test-saker-render-boundary.mjs'))
  const result = spawnSync(process.execPath, [join(fixture, 'scripts', 'test-saker-render-boundary.mjs')], {
    cwd: fixture, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp },
  })
  assert.notEqual(result.status, 0, 'outside-boundary page build falsely passed')
  assert((result.stdout + result.stderr).includes('FAIL 生产接线把整页构建函数放进边界内部'),
    'reverse check failed for an unrelated reason: ' + result.stdout + result.stderr)
  console.log('ok reverse page build outside the boundary is detected')
} finally {
  fs.rmSync(fixture, { recursive: true, force: true })
}
