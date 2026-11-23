// The Host owns the user's text size. Saker may tune spacing and hierarchy,
// but it must not override content typography with fixed pixel sizes.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const files = [
  'src/client/styles/design-system.css',
  'src/client/styles/workbench.css',
]
const violations = []
for (const relative of files) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8')
  for (const match of source.matchAll(/font-size:\s*([0-9.]+)px/g)) {
    violations.push({ file: relative, size: match[1] })
  }
}
assert.deepEqual(violations, [], 'Saker content font sizes must follow --dsh-content-font-size tokens')
const base = fs.readFileSync(path.join(root, 'src/client/styles/workbench.css'), 'utf8')
assert.match(base, /\.saker-wb\{[^}]*font-size:var\(--dsh-content-font-size/)
assert.match(base, /\.saker-wb-sub\{[^}]*font-size:var\(--dsh-content-font-size-secondary/)
console.log('ok   Saker 不再用固定 px 覆盖宿主正文字号，正文/次要文字均跟随 Host token')
