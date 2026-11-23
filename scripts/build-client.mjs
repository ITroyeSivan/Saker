#!/usr/bin/env node
// Build the Saker workbench client from src/client into the plugin runtime file.
// The Host still loads plugins/dsh-redteam-results/lib/client.js; that file is now
// a generated artifact. Use --check in tests to prove source and runtime agree.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'src', 'client', 'index.js')
const target = join(root, 'plugins', 'dsh-redteam-results', 'lib', 'client.js')
const check = process.argv.includes('--check')

if (!existsSync(source)) {
  console.error('build-client: missing source ' + source)
  process.exit(1)
}
let code = readFileSync(source, 'utf8')
const cssPath = join(root, 'src', 'client', 'styles', 'workbench.css')
if (code.includes('__SAKER_WB_CSS__')) {
  if (!existsSync(cssPath)) {
    console.error('build-client: missing stylesheet ' + cssPath)
    process.exit(1)
  }
  code = code.split('__SAKER_WB_CSS__').join(JSON.stringify(readFileSync(cssPath, 'utf8')))
}
const designCssPath = join(root, 'src', 'client', 'styles', 'design-system.css')
if (code.includes('__SAKER_DESIGN_CSS__')) {
  if (!existsSync(designCssPath)) {
    console.error('build-client: missing design system stylesheet ' + designCssPath)
    process.exit(1)
  }
  code = code.split('__SAKER_DESIGN_CSS__').join(JSON.stringify(readFileSync(designCssPath, 'utf8')))
}
const iconsPath = join(root, 'src', 'client', 'parts', 'icons.js')
if (code.includes('__SAKER_ICONS__')) {
  if (!existsSync(iconsPath)) {
    console.error('build-client: missing icons part ' + iconsPath)
    process.exit(1)
  }
  code = code.split('__SAKER_ICONS__').join(readFileSync(iconsPath, 'utf8').trimEnd())
}
if (code.includes('__SAKER_WB_CSS__')) {
  console.error('build-client: unresolved __SAKER_WB_CSS__ placeholder')
  process.exit(1)
}
if (code.includes('__SAKER_ICONS__')) {
  console.error('build-client: unresolved __SAKER_ICONS__ placeholder')
  process.exit(1)
}
if (code.includes('__SAKER_DESIGN_CSS__')) {
  console.error('build-client: unresolved __SAKER_DESIGN_CSS__ placeholder')
  process.exit(1)
}
if (!code.includes('__ModuleLoader__') || code.length < 1000) {
  console.error('build-client: source does not look like a plugin factory')
  process.exit(1)
}
const digest = createHash('sha256').update(code).digest('hex')
const before = existsSync(target) ? readFileSync(target, 'utf8') : ''
if (check) {
  if (before !== code) {
    console.error(`build-client: runtime is stale (source ${digest})`)
    process.exit(1)
  }
  console.log(`client build ok ${code.length} bytes sha256=${digest}`)
  process.exit(0)
}
if (before !== code) writeFileSync(target, code)
console.log(`client built ${code.length} bytes sha256=${digest}`)
