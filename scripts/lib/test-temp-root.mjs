// 测试临时根：优先显式环境变量，其次**从自身位置向上找带 `saker(github)` 的工作区**。
//
// 为什么需要：反向检查会把套件复制到 `_ref/tmp/<变体>/` 下再跑。套件里原来写
// `resolve(dirname(import.meta.url), '..', '..', '_ref', 'tmp')` —— 在正常位置推导正确，
// 在复制位置会得到 `<ws>/_ref/_ref/tmp`（不存在），`mkdtempSync` 直接 ENOENT。
// 2026-10-11 连续踩了三次（浏览器复验、知识增量、回退保护），所以抽成一处。
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 解析工作区临时根 `<workspace>/_ref/tmp`。
 * @param importMetaUrl - 调用方的 `import.meta.url`。
 * @returns 绝对路径（不保证目录已存在）。
 * @throws 向上找不到工作区时抛出（宁可报错，也不悄悄写到系统临时目录）。
 */
export function testTempRoot(importMetaUrl) {
  const explicit = process.env.SAKER_TMP_ROOT
  if (explicit) return resolve(explicit)
  let current = resolve(dirname(fileURLToPath(importMetaUrl)))
  for (;;) {
    if (existsSync(join(current, 'saker(github)'))) return join(current, '_ref', 'tmp')
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new Error('cannot locate the workspace (no saker(github) directory above this test); '
    + 'set SAKER_TMP_ROOT to the workspace _ref/tmp')
}
