// dsh-knowledge-hub host logic drill (no platform needed).
// Run: node scripts/drill-knowledge-hub.mjs
// Covers: stats, import_local (ok / dup / missing-src / self-nested), .git skip,
// browse, search across import layer, remove.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// Plugin entry to test. argv[2] = absolute path to lib/index.js (use when the
// plugin is installed inside a profile whose node_modules provides its deps);
// default = this repo's plugin source (deps must be resolvable from cwd).
const pluginIndex =
  process.argv[2] && process.argv[2] !== ''
    ? path.resolve(process.argv[2])
    : path.resolve('plugins/dsh-knowledge-hub/lib/index.js')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-drill-'))
process.env.DSH_HOME = path.join(tmp, 'dsh')

// fixture: local knowledge folder to import
const srcRoot = path.join(tmp, 'src')
fs.mkdirSync(path.join(srcRoot, 'docs'), { recursive: true })
fs.mkdirSync(path.join(srcRoot, '.git'), { recursive: true })
fs.writeFileSync(path.join(srcRoot, 'docs', 'readme.md'), '# KB Drill\n\nfastjson payload PATTvTestMarker-9f3k\n')
fs.writeFileSync(path.join(srcRoot, '.git', 'deep.md'), 'should never be copied\n')
fs.writeFileSync(path.join(srcRoot, 'note.txt'), 'order-by 盲注备忘\n')
fs.writeFileSync(path.join(srcRoot, 'skip.bin'), Buffer.from([0, 1, 2, 3, 255]))

const { dispatch } = await import(pathToFileURL(pluginIndex).href)
const run = (ep, p) => dispatch(ep, p || {})

const results = []
const check = (name, cond, extra) => {
  results.push(cond ? 'PASS' : 'FAIL')
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`)
}

// stats baseline
let r = await run('stats')
check('stats ok', r.ok === true)
check('stats user/imports = 0 baseline', r.ok && r.value.user === 0 && r.value.imports === 0)

// ── bundled PATT source layer (root package preset/shared/refs/PayloadsAllTheThings)
r = await run('stats')
check('stats.patt shipped (>=200 text files)', r.ok && typeof r.value.patt === 'number' && r.value.patt >= 200, r.ok ? 'patt=' + r.value.patt : '')

r = await run('browse', { source: 'patt', mode: 'pentest', dir: '' })
check('browse patt lists chapters', r.ok && r.value.dirs.length > 30, r.ok ? 'chapters=' + r.value.dirs.length : '')
check('browse patt has SQL Injection + XSS chapters', r.ok && r.value.dirs.some((d) => d.name === 'SQL Injection') && r.value.dirs.some((d) => d.name === 'XSS Injection'))
check('browse patt dirs carry fileCount', r.ok && r.value.dirs.every((d) => typeof d.fileCount === 'number'))

r = await run('browse', { source: 'patt', mode: 'pentest', dir: 'SQL Injection' })
check('browse patt SQL Injection has Intruder + readme', r.ok && r.value.dirs.some((d) => d.name === 'Intruder') && r.value.files.some((f) => f.name === 'README.md'))

r = await run('read', { source: 'patt', mode: 'pentest', path: 'SQL Injection/README.md' })
check('read patt SQL Injection README', r.ok && r.value.content.length > 500)

r = await run('search', { query: 'order by', mode: 'pentest' })
check('search finds patt source hits', r.ok && r.value.hits.some((h) => h.source === 'patt'))

r = await run('write', { source: 'patt', mode: 'pentest', path: 'x.md', content: 'no' })
check('patt layer write refused (read-only)', r.ok === false)
r = await run('remove', { source: 'patt', mode: 'pentest', path: 'SQL Injection' })
check('patt layer remove refused (read-only)', r.ok === false)

// import_local: happy path
r = await run('import_local', { path: srcRoot, name: 'payloads-test' })
check('import_local ok', r.ok === true, r.ok ? r.value.path + ' files=' + r.value.files : JSON.stringify(r))
check('import_local file count = 2 (md+txt, .git/bin skipped)', r.ok && r.value.files === 2)
check('import_local .git not copied', !fs.existsSync(path.join(process.env.DSH_HOME, 'refs', 'imports', 'payloads-test', '.git')))
check('import_local content copied', fs.existsSync(path.join(process.env.DSH_HOME, 'refs', 'imports', 'payloads-test', 'docs', 'readme.md')))

// import_local: duplicate name
r = await run('import_local', { path: srcRoot, name: 'payloads-test' })
check('import_local dup name refused', r.ok === false && /已存在/.test(r.error || ''))

// import_local: missing source
r = await run('import_local', { path: path.join(tmp, 'no-such-dir'), name: 'x' })
check('import_local missing src refused', r.ok === false && /不存在/.test(r.error || ''))

// import_local: source is a file
r = await run('import_local', { path: path.join(srcRoot, 'note.txt'), name: 'file-src' })
check('import_local file src refused', r.ok === false && /不是文件夹/.test(r.error || ''))

// import_local: copying the imports area into itself must be refused
r = await run('import_local', { path: path.join(process.env.DSH_HOME, 'refs', 'imports'), name: 'loop' })
check('import_local self-nested refused', r.ok === false && /导入区/.test(r.error || ''))

// browse: import root now lists the package
r = await run('browse', { source: 'import', mode: 'pentest', dir: '' })
check('browse import shows payloads-test', r.ok && r.value.dirs.some((d) => d.name === 'payloads-test'))

// browse into package
r = await run('browse', { source: 'import', mode: 'pentest', dir: 'payloads-test/docs' })
check('browse import nested dir', r.ok && r.value.files.some((f) => f.name === 'readme.md'))

// search across import layer
r = await run('search', { query: 'PATTvTestMarker', mode: 'pentest' })
check('search finds marker in import', r.ok && r.value.hits.some((h) => h.source === 'import' && h.path.includes('payloads-test')))

// remove the import package (dir delete)
r = await run('remove', { source: 'import', mode: 'pentest', path: 'payloads-test' })
check('remove import dir ok', r.ok === true)
r = await run('browse', { source: 'import', mode: 'pentest', dir: '' })
check('browse import empty after remove', r.ok && r.value.dirs.length === 0)

// path escape attempts must fail
r = await run('read', { source: 'user', mode: 'pentest', path: '../evil.md' })
check('path escape refused', r.ok === false)
r = await run('write', { source: 'bundle', mode: 'pentest', path: 'a.md', content: 'x' })
check('bundle write refused', r.ok === false)

const failed = results.filter((x) => x === 'FAIL').length
console.log(`\nresult: ${results.length - failed}/${results.length} PASS`)
process.exit(failed ? 1 : 0)
