// 工具描述预算门禁：防止 README/技能已经有的长文再次塞回模型工具 schema。
//
// 统计范围是源码里的 `description:` 字符串/模板字面量。它不是语义测试，而是代价门禁：
// 语义行为仍由各插件的 test/run.mjs + 真宿主抓包验证。
import { readFileSync } from 'node:fs'

const QUOTES = new Set(['"', "'", '`'])

/** 读取一个 JS 字符串/模板字面量的原文；返回 [content, endExclusive]。 */
function readLiteral(src, start) {
  const quote = src[start]
  if (!QUOTES.has(quote)) return null
  let out = ''
  for (let i = start + 1; i < src.length; i += 1) {
    const ch = src[i]
    if (ch === '\\') {
      out += src.slice(i, i + 2)
      i += 1
      continue
    }
    if (ch === quote) return [out, i + 1]
    out += ch
  }
  return [out, src.length]
}

/** 提取源码里所有 `description:` 字面量。 */
export function toolDescriptionEntries(source) {
  const out = []
  const re = /description\s*:\s*/g
  let match
  while ((match = re.exec(source)) !== null) {
    let i = re.lastIndex
    while (i < source.length && /\s/.test(source[i])) i += 1
    const lit = readLiteral(source, i)
    if (!lit) continue
    const [text, end] = lit
    const line = source.slice(0, match.index).split(/\r?\n/).length
    out.push({ line, text, bytes: Buffer.byteLength(text, 'utf8') })
    re.lastIndex = end
  }
  return out
}

/**
 * 读取文件并断言描述预算。
 * @param file URL/string
 * @param options maxEntryBytes 单条上限；maxTotalBytes 文件合计上限
 */
export function assertToolDescriptionBudget(file, options = {}) {
  const maxEntryBytes = options.maxEntryBytes ?? 480
  const maxTotalBytes = options.maxTotalBytes ?? 6000
  const source = readFileSync(file, 'utf8')
  const entries = toolDescriptionEntries(source)
  const violations = entries.filter((entry) => entry.bytes > maxEntryBytes)
  const total = entries.reduce((sum, entry) => sum + entry.bytes, 0)
  if (violations.length || total > maxTotalBytes) {
    const details = violations
      .map((entry) => `line ${entry.line}: ${entry.bytes}B > ${maxEntryBytes}B`)
      .join('; ')
    throw new Error(
      `工具描述预算超限：${violations.length} 条过长，合计 ${total}B / ${maxTotalBytes}B`
      + (details ? `；${details}` : ''),
    )
  }
  return { count: entries.length, total, maxEntryBytes, maxTotalBytes }
}
