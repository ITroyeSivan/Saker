import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const source = join(root, 'src', 'client', 'index.js')
const target = join(root, 'plugins', 'dsh-redteam-results', 'lib', 'client.js')

const sourceCode = readFileSync(source, 'utf8')
assert.ok(sourceCode.includes('__ModuleLoader__'), 'source registers a ModuleLoader factory')
assert.ok(sourceCode.includes('Saker workbench client source'), 'source is marked as the client source')
assert.ok(sourceCode.includes('__SAKER_WB_CSS__'), 'source keeps the stylesheet as a build placeholder')
assert.ok(sourceCode.includes('__SAKER_DESIGN_CSS__'), 'source keeps the design system as a build placeholder')
assert.ok(sourceCode.includes('__SAKER_ICONS__'), 'source keeps icons as a build placeholder')

const build = spawnSync(process.execPath, [join(root, 'scripts', 'build-client.mjs'), '--check'], {
  cwd: root, encoding: 'utf8',
})
assert.equal(build.status, 0, `build-client --check failed: ${build.stderr || build.stdout}`)
const css = readFileSync(join(root, 'src', 'client', 'styles', 'workbench.css'), 'utf8')
const designCss = readFileSync(join(root, 'src', 'client', 'styles', 'design-system.css'), 'utf8')
const icons = readFileSync(join(root, 'src', 'client', 'parts', 'icons.js'), 'utf8')
const expected = sourceCode.split('__SAKER_WB_CSS__').join(JSON.stringify(css))
  .split('__SAKER_DESIGN_CSS__').join(JSON.stringify(designCss))
  .split('__SAKER_ICONS__').join(icons.trimEnd())
const targetCode = readFileSync(target, 'utf8')
assert.ok(!targetCode.includes('__SAKER_WB_CSS__'), 'runtime has no unresolved stylesheet placeholder')
assert.ok(!targetCode.includes('__SAKER_DESIGN_CSS__'), 'runtime has no unresolved design system placeholder')
assert.ok(targetCode.includes('.saker-wb{'), 'runtime contains the extracted workbench stylesheet')
assert.ok(targetCode.includes('Saker design system 1.0'), 'runtime contains the extracted design system')
assert.ok(targetCode.includes('function ChatIcon'), 'runtime contains the extracted icon component')
assert.equal(targetCode, expected, 'runtime client matches the built source + stylesheet')

console.log('ok   src/client builds byte-identical lib/client.js')
