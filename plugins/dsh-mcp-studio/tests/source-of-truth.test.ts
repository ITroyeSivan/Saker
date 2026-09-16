/**
 * 「真源纪律」测试 —— 防「改产物不改源码」这类静默回退。
 *
 * ## 为什么需要这个文件（2026-09-13 夜实测踩中）
 *
 * 本插件是**唯一**带 `src/ → lib/` 构建链的插件（`scripts/build.mjs` 用 esbuild 打包，
 * 且**先 `rm('lib')` 再生成**）。于是存在一个很隐蔽的失效：
 *
 *   **直接把修复写进 `lib/index.js`（产物），而 `src/index.ts`（真源）没改。**
 *
 * 后果是：当下能跑、测试全绿、装机也正常 —— **但任何人跑一次 `pnpm build`，
 * 修复就被抹掉、原始 bug 原样回来**，而且不会报任何错。
 * 实测案例：看门狗的异常隔离（定时器回调抛错会打挂整个宿主进程）就曾被这样写进 lib。
 *
 * ## 本文件的两条纪律
 *
 * 1. **修复必须落在 src**：断言 `src/index.ts` 里确实有这些防御；
 * 2. **lib 必须是产物**：断言 `lib/index.js` 头部带 esbuild 的 `// src/…` 来源标注，
 *    且其内容与 src 的关键结构一致（不是手工编辑出来的）。
 *
 * 若哪天真的需要重建，跑 `pnpm build` 即可 —— 本测试会守住重建后修复仍在。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const srcUrl = new URL('../src/index.ts', import.meta.url)
const libUrl = new URL('../lib/index.js', import.meta.url)

/** 读文件；不存在时返回空串（让断言给出可读失败而不是 ENOENT 堆栈）。 */
function read(url: URL): string {
  return existsSync(fileURLToPath(url)) ? readFileSync(url, 'utf8') : ''
}

test('定时器回调的异常隔离必须在 src 里（不是只在产物里）', () => {
  const src = read(srcUrl)
  assert.ok(src.length > 0, 'src/index.ts 应存在')

  // ① 看门狗被拆成「守卫 + 实体」两段：守卫负责兜异常，实体负责干活
  assert.match(
    src,
    /const watchdogTick\s*=\s*\(\)\s*:\s*void\s*=>\s*\{[\s\S]{0,220}?try\s*\{\s*tickOnce\(\)/,
    'src 里 watchdogTick 必须把 tickOnce() 包在 try 里 —— setInterval 回调抛异常会直接终止宿主进程',
  )
  assert.match(src, /const tickOnce\s*=\s*\(\)\s*:\s*void\s*=>/, 'src 里应有 tickOnce 实体')

  // ② 守卫必须记日志（只吞不报同样不可接受：后台坏掉而没人知道）
  assert.match(
    src,
    /watchdog tick failed/,
    'src 里守卫必须 logger.warn 出失败原因，不能静默吞',
  )

  // ③ serversOf：读配置永不抛（settings 未就绪 / 被手改坏时不能把宿主带走）
  assert.match(src, /const serversOf\s*=\s*\(\)\s*:\s*ServerEntry\[\]\s*=>/, 'src 里应有 serversOf')
  assert.match(
    src,
    /const serversOf[\s\S]{0,300}?catch\s*\{\s*return\s*\[\]\s*\}/,
    'serversOf 必须在异常时返回空数组',
  )
})

test('定时器路径上不再有裸 current().servers', () => {
  const src = read(srcUrl)
  // 把 src 里的 watchdog 段切出来，断言其中不出现 current().servers
  const at = src.indexOf('const tickOnce')
  assert.ok(at > 0, '应先能找到 tickOnce')
  const body = src.slice(at, at + 2600)
  assert.ok(
    !/current\(\)\s*\.\s*servers/.test(body),
    'tickOnce 里不得直接读 current().servers —— 那正是会抛的那句',
  )
  assert.match(body, /serversOf\(\)/, 'tickOnce 应改用 serversOf()')
})

test('lib/index.js 必须是构建产物（带来源标注），不是手工编辑的', () => {
  const lib = read(libUrl)
  assert.ok(lib.length > 0, 'lib/index.js 应存在')
  // esbuild 在 bundle 时会写入 `// src/<file>.ts` 分段注释
  assert.match(
    lib.slice(0, 400),
    /\/\/ src\/index\.ts/,
    'lib/index.js 头部应带 esbuild 的 // src/index.ts 来源标注 —— 缺了说明它被手工改过',
  )
  // 产物的关键结构应与 src 对得上（重建后仍成立）
  assert.match(lib, /const serversOf\s*=/, '产物里应有 serversOf（由 src 生成）')
  assert.match(lib, /const tickOnce\s*=/, '产物里应有 tickOnce（由 src 生成）')
})
