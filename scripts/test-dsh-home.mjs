// 仓库级不变量：**平台数据根必须跟随 $DSH_HOME**。
//
// 背景（2026-09-12 浏览器实测）：宿主按 $DSH_HOME 装配 profiles / sessions / storages /
// settings.yaml，但插件里 13 个硬编码 os.homedir()/.dsh。后果：
//   ① 用户用 DSH_HOME 迁移数据目录 → 一半落 A 一半落 B；
//   ② 本项目的隔离演练（DSH_HOME 指临时目录）根本隔离不住 —— 实测在隔离宿主里点
//      「保存开场」，文件写进了真实 C:\Users\<me>\.dsh\method-stack\opening\pentest.md。
//
// 这里的断言在修复前对 13 个插件全部失败；把任一个改回 `os.homedir(), ".dsh"` 也会立刻失败。
//
// 人工核对入口：`node scripts/test-dsh-home.mjs`
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGINS = join(ROOT, 'plugins')

const CANON = 'const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");'

/** 递归收集 .js 文件（不跟 node_modules）。 */
function walkJs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walkJs(p, out)
    else if (name.endsWith('.js') || name.endsWith('.mjs')) out.push(p)
  }
  return out
}

/** 只认「把 .dsh 直接拼在 homedir/HOME 之后」这种硬编码。 */
const BARE_DOTDSH = /(?:os\.)?homedir\(\)\s*,\s*["']\.dsh["']|process\.env\.HOME[^,]*,\s*["']\.dsh["']/g

/** 一行里同时出现 DSH_HOME 与 homedir() ⇒ 它就是「回退默认」那一行，不算硬编码。
 *  （`path.join(os.homedir(), ".dsh")` 出现在默认值里是正确的，不能误判成违规。）*/
const isDefaultLine = (l) => l.includes('process.env.DSH_HOME') && /homedir\(\)/.test(l)

/** 从 pos 向前找最近的 function 关键字，返回其开括号位置（-1 表示不在函数内）。 */
function enclosingFunctionStart(src, pos) {
  const idx = src.lastIndexOf('function', pos)
  if (idx < 0) return -1
  const brace = src.indexOf('{', idx)
  return brace < 0 ? -1 : brace
}

/** 从开括号处配平，返回闭合括号位置。 */
function matchBrace(src, openIdx) {
  let depth = 0
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return i }
  }
  return src.length
}

/** useState 风格混用点（同一函数作用域内）。
 *
 * 声明写成解构 `var [x, setX] = useState(null)`，渲染处却按该文件主流的元组风格读 `x[0]`
 * ⇒ 运行时 `null[0]` 抛 TypeError ⇒ 宿主 SlotErrorBoundary 捕获后把整块设置分区换成
 * 空的 `<div data-slot-error="settings.section">`：面板整片空白，console 里也看不到错误。
 * 语法检查查不出来，只有真跑浏览器量 DOM 才现形。
 *
 * 只认数字字面量索引 x[0]/x[1]：x[key] 是对象索引，即使声明是解构也合法（draft[k]）。
 * 作用域化是必须的——不同组件可以各自风格，跨作用域同名会误报。 */
function useStateStyleMisuse(src) {
  const out = []
  const re = /var\s*\[(\w+)\s*,\s*(\w+)\s*\]\s*=\s*useState\s*\(/g
  let m
  while ((m = re.exec(src)) !== null) {
    const name = m[1]
    const fOpen = enclosingFunctionStart(src, m.index)
    if (fOpen < 0) continue
    const body = src.slice(fOpen, matchBrace(src, fOpen))
    const hit = new RegExp('(?<![\\w.$])' + name + '\\s*\\[\\s*[01]\\s*\\]').exec(body)
    if (hit) {
      const line = src.slice(0, fOpen + hit.index).split(/\r?\n/).length
      out.push(`line ${line} → '${name}'`)
    }
  }
  return out
}

let pass = 0
let fail = 0
const ok = (label, cond) => {
  if (cond) { pass++; console.log(`ok   ${label}`) } else { fail++; console.log(`FAIL ${label}`) }
}

const plugins = readdirSync(PLUGINS).filter((n) => {
  try { return statSync(join(PLUGINS, n)).isDirectory() } catch { return false }
})

const bareHits = []        // 仍硬编码的
const missingDefine = []   // 用了 DSH_HOME 却没定义
const badDefine = []       // 定义写法不是规范形态
const touched = []         // 涉及 .dsh 的插件
const dialogs = []         // 原生阻塞对话框清点（已升为硬断言）
const useStyle = []        // useState 风格混用点（解构声明 + 元组读取）

for (const plug of plugins) {
  let files = []
  for (const sub of ['lib', 'mcp']) {
    try { files.push(...walkJs(join(PLUGINS, plug, sub))) } catch { /* 该目录不存在 */ }
  }
  let pluginTouches = false

  for (const file of files) {
    const raw = readFileSync(file, 'utf8')
    const rel = `${plug}/${relative(join(PLUGINS, plug), file)}`.replace(/\\/g, '/')
    // 剔掉「回退默认」那一行再扫，否则默认值本身会被误判成硬编码
    const src = raw.split(/\r?\n/).filter((l) => !isDefaultLine(l)).join('\n')

    for (const m of src.match(BARE_DOTDSH) || []) bareHits.push(`${rel} → ${m}`)

    if (raw.includes('process.env.DSH_HOME')) {
      pluginTouches = true
      // 规范形态：至少有一行同时给出 DSH_HOME 与 homedir() 回退（写法/引号不限）
      const hasDefault = raw.split(/\r?\n/).some(isDefaultLine)
      const definesName = /(?:const|let|var)\s+\w*DSH_HOME\w*\s*=/.test(raw)
      if (!hasDefault) missingDefine.push(rel)
      else if (!definesName && !/DSH_HOME\s*\|\|\s*path\.join/.test(raw)) badDefine.push(rel)
    }

    // 原生阻塞对话框：**硬断言**（不是信息项）。window.alert/confirm/prompt 会阻塞渲染进程——
    // 对话框一弹，页面 JS 全部停摆，CDP 里连 1+1 都求值超时，任何 Agent 驱动的面板整体卡死。
    // 曾实测：多个插件共 28 处，点「说明」即整页冻结。全部改为应用内 UI 后归零。
    const re = /(?<![\w.$])(?:window\s*\.\s*)?(alert|confirm|prompt)\s*\(/g
    raw.split(/\r?\n/).forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '')
      let m
      re.lastIndex = 0
      while ((m = re.exec(code)) !== null) dialogs.push(`${rel}:${i + 1} → ${m[1]}(`)
    })

    // useState 风格混用：解构声明 + 元组读取（同一函数作用域内）
    for (const hit of useStateStyleMisuse(raw)) useStyle.push(`${rel}:${hit}`)
  }
  if (pluginTouches) touched.push(plug)
}

console.log('── $DSH_HOME 跟随 ──')
ok(`扫到插件 ${plugins.length} 个，其中涉及平台数据根的 ${touched.length} 个`, plugins.length > 0)
ok('没有任何插件再把 .dsh 硬拼在 homedir/HOME 之后', bareHits.length === 0)
ok('用了 DSH_HOME 的文件都写了定义', missingDefine.length === 0)
ok('DSH_HOME 定义一律采用规范形态', badDefine.length === 0)
const routeBoost = readFileSync(join(PLUGINS, 'dsh-route-boost', 'lib', 'index.js'), 'utf8')
ok('route-boost 记账路径直接跟随 DSH_HOME', /accountingPath\(home = process\.env\.DSH_HOME/.test(routeBoost))

if (bareHits.length) console.log('  硬编码残留：\n    ' + bareHits.join('\n    '))
if (missingDefine.length) console.log('  缺定义：\n    ' + missingDefine.join('\n    '))
if (badDefine.length) console.log('  定义形态不符：\n    ' + badDefine.join('\n    '))

console.log('\n── 原生阻塞对话框（硬断言：弹窗会阻塞渲染进程，Agent 驱动整页卡死）──')
ok('没有任何插件使用原生 alert/confirm/prompt', dialogs.length === 0)
if (dialogs.length) console.log('  残留调用点：\n    ' + dialogs.join('\n    '))

console.log('\n── useState 风格一致（硬断言：混用会让整块面板空白且不报错）──')
ok('没有「解构声明 + 元组读取」的 useState 混用', useStyle.length === 0)
if (useStyle.length) console.log('  混用点：\n    ' + useStyle.join('\n    '))

/** 按行剥注释（保留行号对齐），用于「空白 catch」这类需要看注释的判断。
 *
 * **反引号必须跨行跟踪**：webshell-mgr 的 PHP/Java/C# payload 就写在多行模板串里，
 * 不跟踪的话里面的 `try{}catch{}` 会被当成真代码（实测 5 处假阳性全来自这里）。 */
function codeLinesAligned(src) {
  const out = []
  let inBlock = false
  let inTemplate = false
  for (const line of src.split('\n')) {
    let s2 = ''
    let i = 0
    while (i < line.length) {
      const two = line.slice(i, i + 2)
      if (inTemplate) {
        if (line[i] === '\\') { i += 2; continue }
        if (line[i] === '`') { inTemplate = false; i++; s2 += '""'; continue }
        i++
        continue
      }
      if (inBlock) { if (two === '*/') { inBlock = false; i += 2 } else i++; continue }
      if (two === '//') break
      if (two === '/*') { inBlock = true; i += 2; continue }
      if (line[i] === '`') { inTemplate = true; i++; s2 += '""'; continue }
      s2 += line[i]
      i++
    }
    out.push(s2)
  }
  return out
}

/** 扁平收集所有插件的 lib 源文件（供下面几条硬断言共用）。 */
const allLibFiles = []
for (const plug of plugins) {
  try { for (const f of walkJs(join(PLUGINS, plug, 'lib'))) allLibFiles.push({ plug, file: f }) } catch { /* 无 lib 目录 */ }
}

/**
 * 注入点必须在 Session.append 临界区之外（硬断言）。
 *
 * `ctx.on("session/event", …)` 由 `Session.append` 在**发布临界区内同步派发**；
 * 在该临界区内再触发一次 append 会被宿主拒绝：
 *   Error: session append cannot reenter while another append is being published
 *   栈：Session.append ← ReactLoopInbox.splice ← Agent.send ← Agent.followup
 *
 * 这个异常**极易被 catch 掉**，一旦吞掉就表现为「代码正常、日志无错、模型从没收到」——
 * 实测三个插件因此静默失效（ctf-observer / auto-advance / refusal-guard）：
 * 看板记了笔记、推进状态也变了，但全量会话抽查里注入落地 0 次。
 *
 * 判据（简单且可证伪，不做调用图分析 —— 试过一层可达性，箭头函数的解构参数会让
 * 「找函数体的第一个 {」取到形参，而且注入往往是两层（tryNudge → deliver），仍会漏）：
 *   `agent.followup(` / `agent.steer(` 的**每个调用点**必须满足其一 ——
 *     ① 前面 400 字符内有 `setTimeout(`（延后到下一拍，离开临界区）；或
 *     ② 前一行的注释里写明「注入安全：<原因>」（用于 RPC/工具处理器这类本来就在临界区外的点）。
 *   两条都不满足即为隐患：作者没说明它为什么安全，下一个人也无从判断。
 */
const INJECT_SAFE_MARK = /注入安全：/
function unsafeInjectSites(src) {
  const out = []
  const lines = src.split('\n')
  const code = codeLinesAligned(src)
  for (let i = 0; i < code.length; i++) {
    const re = /\.\s*(followup|steer)\s*\(/g
    let m
    while ((m = re.exec(code[i])) !== null) {
      // 回看窗口必须在**与 code 同一坐标系**里算：code 里字符串已被替换成 ""，
      // 用 code 的偏移去切 src 会切到错误位置（曾在 refusal-guard 上误报 —— 它明明是延后的）。
      const ctx = code.slice(Math.max(0, i - 12), i + 1).join('\n')
      const before = ctx.slice(0, ctx.length - code[i].length + m.index)
      if (/setTimeout\s*\(/.test(before)) continue
      // 安全性声明允许写成**向上连续的注释块**（多行说明很常见，只看一行会漏）。
      let note = lines[i]
      for (let k = i - 1; k >= 0 && k >= i - 5; k--) {
        const t = lines[k].trim()
        if (!/^(\/\/|\*|\/\*)/.test(t)) break
        note = lines[k] + '\n' + note
      }
      if (INJECT_SAFE_MARK.test(note)) continue
      out.push(`行 ${i + 1} → .${m[1]}(`)
    }
  }
  return out
}

const unsafeInject = []
for (const { plug, file: f } of allLibFiles) {
  // 构建产物不评判（有 src/ 的插件，lib/ 是编译输出）
  try { if (statSync(join(PLUGINS, plug, 'src')).isDirectory()) continue } catch { /* 手写 */ }
  for (const h of unsafeInjectSites(readFileSync(f, 'utf8'))) {
    unsafeInject.push(`${plug}/${relative(join(PLUGINS, plug), f).replace(/\\/g, '/')} ${h}`)
  }
}

console.log('\n── 注入点必须在 Session.append 临界区之外（硬断言：同步注入会被重入拒绝且极易被吞掉）──')
ok('每个 agent.followup/steer 调用点都已延后或已声明注入安全', unsafeInject.length === 0)

/** 投递体声明必须伴随真正的延后机制：凡写了「注入安全：…本函数（就）是…投递体」的文件，
 *  文件里必须仍存在 setTimeout( —— 否则是「调用方把延后删了、投递体上的声明还留着」，
 *  第一条规则看不见这种回归（它只看 .followup( 调用点本身）。 */
const deliveryMarked = []
for (const { plug, file: f } of allLibFiles) {
  const src = readFileSync(f, "utf8")
  if (!/注入安全：[^\n]*投递体/.test(src)) continue
  // 必须剥注释：注解里写的「只从 setTimeout(…,0) 里调用」自己会被正则匹配到（被骗过一次）。
  if (/setTimeout\s*\(/.test(codeLinesAligned(src).join("\n"))) continue
  deliveryMarked.push(`${plug}/${relative(join(PLUGINS, plug), f).replace(/\\/g, "/")}`)
}

ok('声明为投递体的文件都仍有 setTimeout 延后机制', deliveryMarked.length === 0)
if (deliveryMarked.length) console.log('  声明了投递体却找不到延后机制：\n    ' + deliveryMarked.join('\n    '))
if (unsafeInject.length) console.log('  隐患点（加 setTimeout 延后，或在前一行注明「注入安全：<原因>」）：\n    ' + unsafeInject.join('\n    '))
/** 静默吞错（硬断言）：`catch {}` 且没有任何注释说明 —— 本轮全仓事故的共同形态。 */
function silentCatches(src) {
  const out = []
  const lines = src.split('\n')
  const code = codeLinesAligned(src)
  for (let i = 0; i < code.length; i++) {
    if (!/catch\s*(\([^)]*\))?\s*\{\s*\}\s*;?\s*$/.test(code[i])) continue
    const hasNote = /\/[/*]/.test(lines[i]) || (i > 0 && /\/[/*]/.test(lines[i - 1]))
    if (!hasNote) out.push(`行 ${i + 1}`)
  }
  return out
}

const silent = []
for (const { plug, file: f } of allLibFiles) {
  // **构建产物不按手写代码评判**：插件若有 src/，lib/ 是编译输出，`catch {\n}` 是转译器风格。
  try { if (statSync(join(PLUGINS, plug, 'src')).isDirectory()) continue } catch { /* 无 src → 手写 */ }
  for (const h of silentCatches(readFileSync(f, 'utf8'))) {
    silent.push(`${plug}/${relative(join(PLUGINS, plug), f).replace(/\\/g, '/')} ${h}`)
  }
}

console.log('\n── 无注释的空 catch（硬断言：静默吞错是本轮三次「功能从未生效」的共同形态）──')
ok('没有既无注释又完全空白的 catch 块', silent.length === 0)
if (silent.length) console.log('  静默吞错点：\n    ' + silent.join('\n    '))

/**
 * 带构建链的插件：`lib/` 必须是 `src/` 的产物，不能手工编辑。
 *
 * 2026-09-13 夜实测踩中：`dsh-mcp-studio` 是唯一带 `src/ → lib/` 构建链的插件
 * （`scripts/build.mjs`，esbuild 打包且**先 `rm('lib')`**）。曾把一处修复
 * （看门狗定时器回调的异常隔离）直接写进 `lib/index.js`，而 `src/index.ts` 没改 ——
 * 当下测试全绿、装机正常，**但任何人跑一次 `pnpm build` 修复就被抹掉、bug 静默回来**。
 *
 * 两种产物形态要分别识别（实测：只有 host 侧 ESM bundle 会带 `// src/` 头）：
 *   · host bundle（ESM，outfile: lib/index.js）→ esbuild 会写 `// src/<file>.ts` 分段注释；
 *   · client bundle（CJS + `window.__ModuleLoader__` banner，outfile: lib/client.js）
 *     → **没有** `// src/` 头，判据改为「带 loader banner」（那是 build.mjs 注入的）。
 * 两者都不满足 = 该文件不是从 src 生成的，一律报警。
 */
console.log('\n── 构建链一致性（硬断言：lib 必须是 src 的产物，不能手工编辑）──')
const buildChainIssues = []
for (const plug of plugins) {
  const srcDir = join(PLUGINS, plug, 'src')
  let hasSrc = false
  try { hasSrc = statSync(srcDir).isDirectory() } catch { hasSrc = false }
  if (!hasSrc) continue
  const libDir = join(PLUGINS, plug, 'lib')
  let files = []
  try { files = walkJs(libDir) } catch { continue }
  for (const f of files) {
    const head = readFileSync(f, 'utf8').slice(0, 400)
    const isHostBundle = /\/\/ src\//.test(head)
    const isClientBundle = /__ModuleLoader__\s*\.\s*load\s*\(/.test(head)
    if (!isHostBundle && !isClientBundle) {
      buildChainIssues.push(`${plug}/${relative(join(PLUGINS, plug), f).replace(/\\/g, '/')}`)
    }
  }
}
ok('带 src/ 的插件，其 lib 产物都带构建标记（// src/ 或 loader banner）', buildChainIssues.length === 0)
if (buildChainIssues.length) {
  console.log('  疑似手工编辑的产物（改修请落到 src/，再跑 pnpm build）：\n    ' + buildChainIssues.join('\n    '))
}

console.log(fail === 0 ? `\nall ${pass} tests passed` : `\n${fail} FAILED, ${pass} passed`)
process.exit(fail ? 1 : 0)
