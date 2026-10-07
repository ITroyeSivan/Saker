import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

function ok(label, condition, detail = '') {
  if (condition) {
    console.log(`ok   ${label}${detail === '' ? '' : ` (${detail})`}`)
    return
  }
  console.log(`FAIL ${label}${detail === '' ? '' : ` (${detail})`}`)
  process.exitCode = 1
}

ok(
  'v0.2 空白会话绑定回退已接线',
  source.includes('scope.sessions.retainInfo(row.id)') && source.includes('blanks[0]'),
)
ok('mode-group 版本包含空白会话绑定修复', manifest.version.localeCompare('1.0.5', undefined, { numeric: true }) >= 0, manifest.version)
