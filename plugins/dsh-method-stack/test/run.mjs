// dsh-method-stack 离线契约测试：设置页「方法正文」抽屉的唯一性。
//
// 历史缺陷：MethodRow 每行各自持 open 状态并各自渲染一个 Modal（position:fixed 全屏遮罩、
// z-index 2000），于是同时点开多行会叠出多个**完全重叠**的抽屉 —— 肉眼只看到一个，
// 点「关闭」只关掉最上面那个，需要点 N 次才清空。实测在设置页同屏存在 4 个同位置、
// 同尺寸（y=264）的「方法正文」标题：recon/port-scan、exploit/access-control、
// exploit/business-logic、intranet/cred-relation。
//
// lib/client.js 是 ModuleLoader bundle（顶层引用 window.__ModuleLoader__），无法直接 import
// 渲染，故这里做**源码契约锁** —— 与 dsh-mcp-studio tests/ui-contract.test.ts 同一种纪律。
// 这些断言在修复前全部失败。
import { readFileSync } from 'node:fs'

let pass = 0
let fail = 0
const ok = (label, cond) => {
  if (cond) { pass++; console.log(`ok   ${label}`) } else { fail++; console.log(`FAIL ${label}`) }
}

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/** MethodRow 的函数体切片。MethodDock 里的下拉也有 setOpen(false)（点击外部/Esc 关闭），
 *  那是另一个组件、另一个用途，不能算进这里。 */
function methodRowBody(text) {
  const a = text.indexOf('function MethodRow(props) {')
  const b = text.indexOf('\nfunction GroupSection(props) {', a)
  return a === -1 || b === -1 ? '' : text.slice(a, b)
}
const row = methodRowBody(src)

{
  ok('能切出 MethodRow 函数体', row.length > 0)

  // ① 行内不再自持 open
  ok('MethodRow 不再自己持有 open 状态', !/var \[open, setOpen\] = useState/.test(row))
  ok('MethodRow 的 open 由 props.openKey 推导', row.includes('var open = props.openKey === k;'))
  ok('MethodRow 内不再出现 setOpen(…)', !/setOpen\(/.test(row))

  // ② 开关都走 Page 的唯一 openKey
  ok('打开走 props.setOpenKey(k)', row.includes('props.setOpenKey(k)'))
  ok('关闭走 props.setOpenKey(null)', row.includes('props.setOpenKey(null)'))

  // ③ 全页只有一个 openKey 状态源
  ok('Page 持有唯一 openKey 状态', src.includes('var [openKey, setOpenKey] = useState(null)'))
  ok('Page 只声明一次 openKey', (src.match(/\[openKey, setOpenKey\] = useState/g) || []).length === 1)
  ok('切换模式时强制收起抽屉',
    /function load\(preset\) \{\s*\n\s*setData\(null\);\s*\n\s*setOpenKey\(null\);/.test(src))

  // ④ 链路两跳都要透传，否则 openKey 永远传不到行里
  ok('GroupSection 把 openKey/setOpenKey 透传给 MethodRow',
    src.includes('openKey: props.openKey, setOpenKey: props.setOpenKey'))
  ok('Page 把 openKey/setOpenKey 下发给 GroupSection',
    src.includes('openKey: openKey, setOpenKey: setOpenKey'))

  // ⑤ 全文件只有一个 Modal 渲染点（每行一个实例无妨 —— 只有 open 为真的那行会真正渲染，
  //    而 open 由全局唯一 openKey 决定，所以运行时最多一个）
  ok('全文件只有一个 Modal 渲染点',
    (src.match(/React\.createElement\(Modal, \{ open: open \}/g) || []).length === 1)
}

// ── 2026-09-12 轮次：组合可删 + 不再用原生阻塞对话框 ──────────────────────────
{
  const svr = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

  // ① 组合删除。此前只有 save-combo / use-combo：误存一个组合就永久留在设置页，
  //    界面上没有任何删除入口，只能手改 profile JSON 才能去掉。
  ok('服务端有 delete-combo 端点', svr.includes("endpoint === 'delete-combo'"))
  ok('delete-combo 写审计', /audit\(presetId, 'delete-combo'/.test(svr))
  ok('delete-combo 对不存在的组合返回失败', svr.includes("failure('组合不存在：' + name)"))
  {
    const a = svr.indexOf("endpoint === 'delete-combo'")
    const b = svr.indexOf("if (endpoint === 'clone')", a)
    const block = a >= 0 && b > a ? svr.slice(a, b) : ''
    ok('能切出 delete-combo 代码块', block.length > 0)
    ok('delete-combo 不递增 rev（组合定义不改变注入正文）', block.length > 0 && !block.includes('profile.rev'))
  }
  ok('客户端有 deleteCombo', src.includes('function deleteCombo(name)'))
  ok('客户端调用 delete-combo', src.includes("'delete-combo', { presetId: presetId, name: name }"))
  ok('删除走行内二次确认（confirmDel）', src.includes('var [confirmDel, setConfirmDel] = useState'))
  ok('组合 chip 带删除入口', src.includes("}, '✕'));"))

  // ② 不用原生阻塞对话框。window.alert/confirm/prompt 会阻塞渲染进程：实测一旦弹出，
  //    连 `1+1` 都求值超时，Page.handleJavaScriptDialog 报 No dialog is showing，
  //    只能关标签页重开。任何 Agent / 自动化驱动该面板都会整体卡死。
  const nativeDialogs = src.match(/(?<![\w.$])(?:window\s*\.\s*)?(alert|confirm|prompt)\s*\(/g) || []
  ok('client.js 不再使用原生 alert/confirm/prompt', nativeDialogs.length === 0)
  ok('注入预览结果就地显示（note 状态）', src.includes("var [note, setNote] = useState('')"))
  ok('还原失败也走就地提示而非 alert', src.includes("|| '还原失败');"))
}

// ── 2026-09-12 轮次（二）：注入预览结果必须落在 preset 行的 flex 容器内 ──────────
// 历史缺陷：`}, '注入预览')),` 多了一个 )，提前闭合了 preset 行的 flex 容器，
// 于是 note 的 <span> 变成了页面根 div 的子节点（块级另起一行），而不是紧跟在
// 「注入预览」按钮右侧的行内兄弟。语法合法、原有断言全绿，只有真跑浏览器量 DOM
// 才现形：note span 的 parentElement.children.length 是 11（页面根）而不是 5（flex 行）。
{
  /** 从 preset 行 flex 容器的 createElement( 起做括号深度扫描，返回参数区间 [start,end)。 */
  function flexArgsRange(text) {
    const marker = "display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8"
    const at = text.indexOf(marker)
    if (at < 0) return null
    const open = text.lastIndexOf('React.createElement(', at)
    if (open < 0) return null
    const parenOpen = text.indexOf('(', open)
    let depth = 0
    for (let i = parenOpen; i < text.length; i += 1) {
      if (text[i] === '(') depth += 1
      else if (text[i] === ')') { depth -= 1; if (depth === 0) return [parenOpen, i] }
    }
    return null
  }
  const range = flexArgsRange(src)
  ok('能定位 preset 行 flex 容器', range !== null)
  const noteAt = src.indexOf("note ? React.createElement('span'")
  ok('能找到 note 的 span 渲染', noteAt >= 0)
  ok('note 的 span 落在 preset 行 flex 容器内',
    range !== null && noteAt > range[0] && noteAt < range[1])
  ok('flex 容器不再被「注入预览」提前闭合', !src.includes("}, '注入预览')),"))
}

// ── 模式清单：client 的 PRESETS 必须列出所有已实装模式 ──────────────────────
// 实测漏改：ctf-solver 落地后本插件的 PRESETS 仍只有两项，设置页模式 tab 里
// 就选不到 CTF —— 不报错、不崩，只是少一项（最难发现的那类）。preset 名单变化必须同步。
{
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const m = /var PRESETS = \[([\s\S]*?)\n\];/.exec(src)
  const ids = ['pentest', 'code-audit', 'ctf-solver']
  ok('client PRESETS 含全部已实装模式', !!m && ids.every((id) => m[1].includes(`'${id}'`)))
}

// ── 2026-09-13 轮次：默认不启用任何方法 + 「仅此组」必须排他 ────────────────
// 两个都来自用户实测报障：
//  ① 「点仅此组没用」—— 旧实现是"把本组设为全启用"（其他组不动），默认全开时点它原地踏步。
//  ② 「默认应该一个都不选，不然每轮提示词太爆炸」—— 方法正文是每轮常驻注入，
//     26 个方法 ≈ 14KB（约 4–5K token），32K 窗口的模型实测被顶到 CONTEXT_WINDOW_EXCEEDED。
{
  const svr = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const cli = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

  // ① 默认空
  {
    const a = svr.indexOf('function currentProfile(presetId)')
    const b = svr.indexOf('/** 把 active（group/id 数组）渲染成', a)
    const block = a >= 0 && b > a ? svr.slice(a, b) : ''
    ok('能切出 currentProfile 函数体', block.length > 0)
    ok('默认 profile 的 active 是空数组（不再默认全开）', /active:\s*\[\]/.test(block))
    ok('默认仍保留「全部启用」组合作一键恢复', block.includes("'全部启用'"))
    ok('默认值注释写明「常驻注入」理由（防被改回全开）', block.includes('常驻注入'))
  }

  // ② 「仅此组」排他
  {
    const a = cli.indexOf('function setOnlyGroup(g)')
    const b = cli.indexOf('function setAllGroups(on)', a)
    const block = a >= 0 && b > a ? cli.slice(a, b) : ''
    ok('能切出 setOnlyGroup 函数体', block.length > 0)
    ok('setOnlyGroup 从空数组起手（排他，不保留其他组）', /var next = \[\];/.test(block))
    ok('setOnlyGroup 不再用「先滤掉本组再整组加回」的旧写法',
      !/filter\(function \(x\) \{ return x\.split\('\/'\)\[0\] !== g; \}\)/.test(block))
    ok('「仅此组」链接指向 setOnlyGroup', cli.includes('setOnlyGroup(g.group)'))
    ok('不再残留 toggleGroupOnly 标识符', !cli.includes('toggleGroupOnly'))
  }

  // ③ 一键全开/全关（26 个逐个勾太累；「清空」是收窄上下文时最常用的动作）
  ok('有 setAllGroups 快捷', cli.includes('function setAllGroups(on)'))
  ok('浮层有「全部关闭」入口', cli.includes("'全部关闭'"))
  ok('浮层有「全部启用」入口', cli.includes("'全部启用'"))
  ok('空态明示「不注入方法正文」', cli.includes('未启用任何方法'))
}

console.log(fail === 0 ? `\nall ${pass} tests passed` : `\n${fail} FAILED, ${pass} passed`)
process.exit(fail ? 1 : 0)
