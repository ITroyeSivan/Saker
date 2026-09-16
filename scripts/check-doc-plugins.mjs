#!/usr/bin/env node
// check-doc-plugins.mjs —— 文档与实际的**插件清单/版本**一致性检查。
//
// 为什么需要：`docs/plugin-list.md` 与 `README.md` 里的插件数与版本号是**手写的**，
// 而插件版本几乎每轮都在升 → 文档必然悄悄过时（实测：README 写 21、清单写 22、实际 23，
// 且 8 个插件的版本号已落后好几个 patch）。
// 这种"文档版本与实物不符"是交付物最容易被挑的毛病，而且**没有任何检查会失败**。
//
// 本脚本把「实际」当唯一真源（`plugins/*/package.json`），逐条核对文档里的记账：
//   · README 的「N 个独立插件」
//   · docs/plugin-list.md 的「N 个独立插件」
//   · plugin-list.md 表格里每个插件的版本号
// 任何一项对不上就列出具体差异并 exit 1。
//
// 用法: node scripts/check-doc-plugins.mjs          # 检查
//       node scripts/check-doc-plugins.mjs --fix     # 顺手把版本号与计数改对（只改数字）
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const FIX = process.argv.includes('--fix')

// ── 实际清单（唯一真源）────────────────────────────────────────────────────
const actual = new Map() // 包名 → { dir, version }
for (const d of readdirSync(join(ROOT, 'plugins')).sort()) {
  if (!d.startsWith('dsh-')) continue
  const pkgPath = join(ROOT, 'plugins', d, 'package.json')
  if (!existsSync(pkgPath)) continue
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  actual.set(pkg.name, { dir: d, version: String(pkg.version), label: pkg.name.replace(/^@dsh-external\//, '') })
}
const nActual = actual.size

// ── 文档 ──────────────────────────────────────────────────────────────────
const readmePath = join(ROOT, 'README.md')
const listPath = join(ROOT, 'docs', 'plugin-list.md')
const readme = readFileSync(readmePath, 'utf8')
const list = readFileSync(listPath, 'utf8')

const problems = []
const fixes = []

/** ① 计数：文档里「N 个独立插件」「N 个插件包」应与实际一致。 */
function checkCount(text, label) {
  let out = text
  for (const [re, what] of [
    [/(\d+)\s*个独立插件/g, '个独立插件'],
    [/(\d+)\s*个插件包/g, '个插件包'],
  ]) {
    const found = [...text.matchAll(re)]
    if (found.length === 0) continue
    for (const m of found) {
      if (Number(m[1]) !== nActual) {
        problems.push(`${label}：写「${m[1]} ${what}」，实际 ${nActual}`)
        if (FIX) out = out.replace(m[0], `${nActual} ${what}`)
      }
    }
  }
  return out
}
const readmeFixed = checkCount(readme, 'README.md')
const listFixed = checkCount(list, 'docs/plugin-list.md')

/** ② 表格版本号：`| ... | \`dsh-x\` | 1.2.3 | ...` 形式。 */
let listTable = listFixed
const rowRe = /^(\|[^\n]*?`(dsh-[a-z0-9-]+)`\s*\|\s*)(\d+\.\d+\.\d+)(\s*\|)/gm
const seen = new Set()
listTable = listTable.replace(rowRe, (whole, pre, dir, ver, post) => {
  const pkgName = `@dsh-external/${dir}`
  const a = actual.get(pkgName)
  if (!a) { problems.push(`docs/plugin-list.md：表格里的 \`${dir}\` 在 plugins/ 里不存在`); return whole }
  seen.add(dir)
  if (a.version !== ver) {
    problems.push(`docs/plugin-list.md：\`${dir}\` 写 ${ver}，实际 ${a.version}`)
    if (FIX) return pre + a.version + post
  }
  return whole
})
const missingRows = [...actual.values()].filter((a) => !seen.has(a.dir)).map((a) => a.dir)
if (missingRows.length) problems.push(`docs/plugin-list.md：表格缺少 ${missingRows.join(', ')}`)

/**
 * ③ 文档里引用的 tgz 文件名版本号（`dsh-saker-<v>.tgz` / `dsh-external-<name>-<v>.tgz`）。
 * 这类引用最致命：用户**照抄命令**时 `file:` 路径不存在会直接失败。
 * 覆盖所有 docs/ 下的 Markdown 与其它的 README。
 */
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const TGZ_RE = /dsh-(?:saker|external-dsh-[a-z0-9-]+?)-(\d+\.\d+\.\d+)\.tgz/g
const currentDocs = ['README.md', 'docs/getting-started.md', 'docs/installation.md', 'docs/development.md']
for (const d of readdirSync(join(ROOT, 'plugins')).sort()) {
  const p = join(ROOT, 'plugins', d, 'README.md')
  if (existsSync(p)) currentDocs.push(`plugins/${d}/README.md`)
}
for (const rel of currentDocs) {
  const p = join(ROOT, rel)
  if (!existsSync(p)) continue
  let text = readFileSync(p, 'utf8')
  const before = text
  text = text.replace(TGZ_RE, (whole, ver) => {
    const stem = whole.replace(/-\d+\.\d+\.\d+\.tgz$/, '')
    const expected = stem === 'dsh-saker'
      ? String(rootPkg.version)
      : actual.get(`@dsh-external/${stem.replace(/^dsh-external-/, '')}`)?.version
    if (expected === undefined) { problems.push(`${rel}：引用了未知包的 tgz（${whole}）`); return whole }
    if (expected !== ver) {
      problems.push(`${rel}：tgz 版本写 ${ver}，实际 ${expected}（照抄会失败）`)
      return FIX ? `${stem}-${expected}.tgz` : whole        // ← FIX 时替换
    }
    return whole
  })
  if (FIX && text !== before) {
    writeFileSync(p, text, 'utf8')
    fixes.push(`${rel} 的 tgz 版本`)
  }
}

// ── 输出 ──────────────────────────────────────────────────────────────────
console.log(`实际插件数：${nActual}`)
console.log(`文档表格覆盖：${seen.size} 个`)
if (problems.length === 0) {
  console.log('\n✓ 文档的插件清单与版本号与实际一致')
  process.exit(0)
}
console.log(`\n发现 ${problems.length} 处不一致：`)
for (const p of problems) console.log('  · ' + p)

if (FIX) {
  if (readmeFixed !== readme) { writeFileSync(readmePath, readmeFixed, 'utf8'); fixes.push('README.md 计数') }
  if (listTable !== list) { writeFileSync(listPath, listTable, 'utf8'); fixes.push('docs/plugin-list.md 计数/版本') }
  console.log(`\n已修正：${fixes.join('、') || '（无可自动修正项）'}`)
  if (missingRows.length) console.log('⚠ 缺行仍需手工补表格行（脚本不猜描述文案）')
} else {
  console.log('\n加 --fix 可自动改计数 / 表格版本号 / tgz 文件名版本')
}
process.exit(1)
