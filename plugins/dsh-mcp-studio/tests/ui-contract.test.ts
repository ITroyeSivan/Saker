import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// 设置页 UI 的源码契约锁。这些断言都是「修复前必失败」的：
//   1) 筛选/搜索无结果时过去渲染成空白列表（只有筛选栏的 0 / 5），没有任何解释；
//   2) 卡片头名字曾被无条件压到 48px（fixture-big / fixture-hybrid 都显示成 fixtur...，
//      无法分辨）。第一版修法给名字加 min-width:88px 看着有效，但 Chrome 会把 flex
//      基准钳到 min-width，短名字被撑成 88px 白留空白、命令预览只剩 4px，故最终只让出
//      间隙与内边距，不给名字设下限。
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p: string): string => readFileSync(join(root, p), 'utf8')

test('ui-contract: 筛选/搜索无结果时给出空态文案，而不是空白列表', () => {
  const page = read('src/client/McpStudioPage.tsx')
  const locales = read('src/client/locales.ts')
  assert.ok(locales.includes("'noMatch'"), 'locales 缺少 noMatch 键')
  assert.ok(page.includes('visibleServers.length === 0'), '页面没有「已配置但被筛空」的渲染分支')
  assert.ok(page.includes("t('noMatch')"), '页面没有消费 noMatch 文案')
})

test('ui-contract: 卡片头名字不设 min-width、也不设为不可收缩', () => {
  const styles = read('src/client/styles.ts')
  const rule = styles.match(/\.dsh-mcs-name\{[^}]*\}/)?.[0] ?? ''
  assert.ok(rule.length > 0, '找不到 .dsh-mcs-name 规则')
  assert.ok(
    !/min-width/.test(rule),
    `名字不该设 min-width：Chrome 会把 flex 基准钳到该值，短名字白留空白 —— ${rule}`,
  )
  assert.ok(
    !/flex:\s*0\s+0\s+auto/.test(rule),
    `名字不该设为不可收缩：过长名字会撑破整行 —— ${rule}`,
  )
  assert.ok(/text-overflow:ellipsis/.test(rule), '名字仍需省略号作为过长时的降级')
})

// #5：工具条脏态标记是 .dsh-mcs-toolbar 的第一个子元素，而工具条 flex-wrap:wrap。
// 内容宽 482px，干净态 6 个按钮合计 455px 刚好放下；加上 81px 的脏态标记后 536 > 482，
// 于是「保存」被挤到第二行、孤立左对齐（实测 (x,y) 从 (1052,255) 跳到 (1132,293)）。
// 而 canSave = dirty && …，意味着能保存时标记必然在 —— 干净态反而布局正常，极具欺骗性。
// 修法：给状态标记 order:9，按钮整组保持一行，标记在需要时落到下一行。
test('ui-contract: 工具条状态标记让出换行顺序，不把「保存」挤下第二行', () => {
  const styles = read('src/client/styles.ts')
  for (const cls of ['dsh-mcs-dirty', 'dsh-mcs-failed']) {
    const rule = styles.match(new RegExp(`\\.${cls}\\{[^}]*\\}`))?.[0] ?? ''
    assert.ok(rule.length > 0, `找不到 .${cls} 规则`)
    assert.match(rule, /order:\s*\d/, `.${cls} 必须让出换行顺序：否则脏态时「保存」会被挤到第二行 —— ${rule}`)
  }
  const toolbar = styles.match(/\.dsh-mcs-toolbar\{[^}]*\}/)?.[0] ?? ''
  assert.match(toolbar, /flex-wrap:\s*wrap/, '工具条仍是可换行的（这正是需要 order 让位的前提）')
})
