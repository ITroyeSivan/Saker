import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { formatMcpJson, parseMcpJson, type McpJsonErrorCode } from '../src/client/mcp-json.ts'
import { en, zh } from '../src/client/locales.ts'

// 粘贴/导入诊断的本地化契约锁。历史缺陷：mcp-json.ts 直接返回英文句子
//   `empty input` / `invalid JSON: <引擎原文>` / `expected a JSON object` /
//   `skipped "x": no command (stdio) or url (http)` / `no server entries found: …`
// 页面把 result.error 原样渲染，于是中文设置页里冒出英文诊断，实测截图可见
//   `已导入 1 · skipped "ui-probe-bad": no command (stdio) or url (http)`
//   `invalid JSON: Expected property name or '}' in JSON at position 16 (line 1 column 17)`
// 修法：解析层只返回结构化 code（+ 位置数字），措辞全部交给 locales 字典。
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p: string): string => readFileSync(join(root, p), 'utf8')

const CODES: McpJsonErrorCode[] = ['empty', 'badJson', 'notObject', 'noServers', 'skipped']
const KEY_OF: Record<McpJsonErrorCode, keyof typeof zh> = {
  empty: 'errEmpty',
  badJson: 'errBadJson',
  notObject: 'errNotObject',
  noServers: 'errNoServers',
  skipped: 'errSkipped',
}

function errOf(result: unknown): { code?: string; line?: number; column?: number; position?: number; name?: string } {
  const error = (result as { error?: unknown }).error
  return typeof error === 'object' && error !== null ? (error as { code?: string }) : {}
}

test('mcp-json-i18n: 每个失败路径返回结构化 code，而不是英文句子', () => {
  assert.equal(errOf(formatMcpJson('')).code, 'empty')
  assert.equal(errOf(formatMcpJson('   ')).code, 'empty')
  assert.equal(errOf(formatMcpJson('nope')).code, 'badJson')
  assert.equal(errOf(parseMcpJson('')).code, 'empty')
  assert.equal(errOf(parseMcpJson('not json')).code, 'badJson')
  assert.equal(errOf(parseMcpJson('[1,2]')).code, 'notObject')
  assert.equal(errOf(parseMcpJson('{"foo":"bar"}')).code, 'noServers')
})

test('mcp-json-i18n: badJson 带上引擎给的位置数字，供 UI 组装中文提示', () => {
  const located = errOf(parseMcpJson('{\n  "mcpServers": {\n    "a" 1\n  }\n}'))
  assert.equal(located.code, 'badJson')
  assert.equal(typeof located.line, 'number', '缺少 line：UI 只能退回无位置提示')
  assert.equal(typeof located.column, 'number', '缺少 column')
  assert.equal(typeof located.position, 'number', '缺少 position')
  assert.ok((located.line ?? 0) > 0 && (located.column ?? 0) > 0)

  // 第二种引擎形态（Unexpected token '}' …）**不带任何位置**，此时必须退到出错字符。
  const tokenized = errOf(formatMcpJson('{"a": }'))
  assert.equal(tokenized.code, 'badJson')
  assert.equal(typeof tokenized.token, 'string', '引擎没给位置时要能给出出错字符')
  assert.ok((tokenized.token ?? '').length > 0)
})

test('mcp-json-i18n: 被跳过的条目也是结构化诊断，并带上条目名', () => {
  const result = parseMcpJson(JSON.stringify({
    mcpServers: {
      good: { command: 'npx' },
      bad: { foo: 1 },
    },
  }))
  assert.ok(!('error' in result), '有可用条目时不该整体报错')
  assert.deepEqual(result.warnings, [{ code: 'skipped', name: 'bad' }])
})

test('mcp-json-i18n: 源码里不再留任何英文诊断句子', () => {
  const source = read('src/client/mcp-json.ts')
  for (const sentence of [
    'empty input',
    'invalid JSON:',
    'expected a JSON object',
    'no command (stdio) or url (http)',
    'no server entries found',
  ]) {
    assert.ok(!source.includes(sentence), `mcp-json.ts 仍残留英文诊断：${sentence}`)
  }
})

test('mcp-json-i18n: 每个诊断码在 zh/en 都有措辞，且中文确实是中文', () => {
  for (const code of CODES) {
    const key = KEY_OF[code]
    for (const [name, dict] of [['zh', zh], ['en', en]] as const) {
      const text = dict[key] as string
      assert.equal(typeof text, 'string', `${name} 缺少词条 ${String(key)}`)
      assert.ok(text.length > 0, `${name}.${String(key)} 为空`)
    }
    assert.match(zh[key] as string, /[\u4e00-\u9fff]/, `zh.${String(key)} 不含中文：${zh[key]}`)
    assert.notEqual(zh[key], en[key], `${String(key)} 没有本地化，中英同文`)
  }
})

test('mcp-json-i18n: 页面用 mcpErrText 本地化，且覆盖全部诊断码', () => {
  const page = read('src/client/McpStudioPage.tsx')
  assert.ok(page.includes('mcpErrText(result.error)'), '错误分支没有经过本地化')
  assert.ok(!page.includes('text: result.error'), '仍有把原始 error 直接塞进提示的路径')
  assert.ok(page.includes("result.warnings.map(mcpErrText)"), '导入告警没有经过本地化')
  for (const code of CODES) {
    assert.ok(page.includes(`case '${code}':`), `mcpErrText 未覆盖诊断码 ${code}`)
  }
  for (const key of Object.values(KEY_OF)) {
    assert.ok(page.includes(`t('${String(key)}'`), `页面没有消费词条 ${String(key)}`)
  }
  // 带位置的 badJson 有两条专用词条，位置数字是唯一进提示的动态内容。
  assert.ok(page.includes("t('errBadJsonAt', { line: error.line, column: error.column })"))
  assert.ok(page.includes("t('errBadJsonToken', { token: error.token })"))
  assert.ok(page.includes("t('errBadJsonPos', { position: error.position })"))
})
