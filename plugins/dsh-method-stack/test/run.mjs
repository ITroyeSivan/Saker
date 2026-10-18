// dsh-method-stack 离线契约测试：host 侧方法引擎 + 已退出设置页的装载契约。
//
// v6 第 4.1 节起，设置页「方法编排」与聊天工具栏的「测试模块」选择器退出运行，
// 测试内容选择并入 Saker 的「测试设置」。本文件只保留两类断言：
//   ① host 侧真实行为（RPC handler、目录缓存失效、开场 persona）；
//   ② 装载契约（客户端 bundle 能被宿主加载，且不注册任何插槽）。
// 已删除的界面不再用源码字符串锁住 —— 那种锁会让人以为废弃页面还在运行。
import { readFileSync } from 'node:fs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let pass = 0
let fail = 0
const ok = (label, cond) => {
  if (cond) { pass++; console.log(`ok   ${label}`) } else { fail++; console.log(`FAIL ${label}`) }
}

const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// ── host 侧：组合可删 + 客户端不再用原生阻塞对话框 ────────────────────────────
{
  const svr = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

  // ① 组合删除。此前只有 save-combo / use-combo：误存一个组合就永久留下，
  //    只能手改 profile JSON 才能去掉。设置页已退出，但 RPC 端点仍是迁移路径。
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

  // ② 不用原生阻塞对话框。window.alert/confirm/prompt 会阻塞渲染进程：实测一旦弹出，
  //    连 `1+1` 都求值超时，Page.handleJavaScriptDialog 报 No dialog is showing，
  //    只能关标签页重开。任何 Agent / 自动化驱动该面板都会整体卡死。
  const nativeDialogs = src.match(/(?<![\w.$])(?:window\s*\.\s*)?(alert|confirm|prompt)\s*\(/g) || []
  ok('client.js 不再使用原生 alert/confirm/prompt', nativeDialogs.length === 0)
}

// Web selections are verified behaviorally in test/web-selection.mjs.
// ── 2026-09-18 轮次：装配期目录缓存必须有效且不能吃旧正文 ───────────────────
// fullCatalog() 被 systemPrompt.context 每轮调用，旧实现每轮遍历目录并读取全部
// prompt.md（实测 8.5ms/回合）。这里用临时 DSH_HOME 走真实 RPC handler：
// 缓存命中不读目录；save/restore/clone 三个写路径必须显式失效并读到新状态。
{
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-method-stack-cache-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = tmpHome
  let handler = null
  let modeOpening = null
  try {
    const mod = await import(new URL(`../lib/index.js?cache-test=${Date.now()}`, import.meta.url))
    mod.apply({
      tools: { register() {} },
      connection: {
        rpc: { handle: () => {} },
        register: (_ctx, _channel, fn) => { handler = fn },
      },
      systemPrompt: {
        context: () => {},
        section: (section) => { if (section.name === 'saker-mode-opening') modeOpening = section },
      },
      agentPresets: { composedPreset: (agentCtx) => agentCtx?.preset || 'pentest' },
      logger: { warn: () => {} },
    })
    ok('能拿到 method-stack RPC handler', typeof handler === 'function')

    const findMethod = () => {
      for (const group of mod.fullCatalog()) {
        for (const method of group.methods) {
          if (group.group === 'recon' && method.id === 'port-scan') return method
        }
      }
      return null
    }

    const originalReaddir = fs.readdirSync
    let reads = 0
    fs.readdirSync = (...args) => { reads += 1; return originalReaddir(...args) }
    try {
      mod.fullCatalog()
      const afterFirst = reads
      mod.fullCatalog()
      ok('第二次 fullCatalog 命中缓存：不再遍历方法目录',
        afterFirst > 0 && reads === afterFirst, `reads=${reads}/${afterFirst}`)

      const saved = await handler('save-prompt', { group: 'recon', id: 'port-scan', text: '# cache probe\n' })
      const afterSave = reads
      const savedMethod = findMethod()
      ok('save-prompt 后目录缓存立即失效并读到用户正文',
        saved?.ok === true && reads > afterSave && savedMethod?.prompt === '# cache probe',
        `reads=${reads}/${afterSave}, prompt=${savedMethod?.prompt ?? ''}`)

      // 覆盖写用户正文前必须先备份：第二次保存应留下第一版的副本。
      ok('首次 save-prompt（用户层原本没有正文）不产生备份',
        saved?.ok === true && !saved.value?.backup, JSON.stringify(saved?.value))
      const saved2 = await handler('save-prompt', { group: 'recon', id: 'port-scan', text: '# cache probe v2\n' })
      ok('save-prompt 覆盖前留备份（内容是上一版）',
        saved2?.ok === true && typeof saved2.value?.backup === 'string' && fs.existsSync(saved2.value.backup)
        && fs.readFileSync(saved2.value.backup, 'utf8').includes('cache probe'), JSON.stringify(saved2?.value))
      ok('save-prompt 覆盖后新正文生效', findMethod()?.prompt === '# cache probe v2')

      const restored = await handler('restore', { group: 'recon', id: 'port-scan' })
      const afterRestore = reads
      const restoredMethod = findMethod()
      ok('restore 后目录缓存立即失效并恢复官方正文',
        restored?.ok === true && reads > afterRestore && restoredMethod?.origin === 'official' && restoredMethod?.prompt !== '# cache probe',
        `reads=${reads}/${afterRestore}, origin=${restoredMethod?.origin ?? ''}`)
      // restore 不直接 rm：用户改过的正文移进 methods/.trash/，可人工找回。
      ok('restore 把用户正文移进 .trash/（可找回）',
        restored?.ok === true && typeof restored.value?.trash === 'string' && fs.existsSync(restored.value.trash)
        && fs.existsSync(path.join(restored.value.trash, 'prompt.md'))
        && fs.readFileSync(path.join(restored.value.trash, 'prompt.md'), 'utf8').includes('cache probe'),
        JSON.stringify(restored?.value))

      const cloned = await handler('clone', { group: 'recon', id: 'port-scan' })
      const afterClone = reads
      const clonedMethod = findMethod()
      ok('clone 后目录缓存立即失效并切换为用户层来源',
        cloned?.ok === true && reads > afterClone && clonedMethod?.origin === 'user',
        `reads=${reads}/${afterClone}, origin=${clonedMethod?.origin ?? ''}`)

      // The settings editor loads the complete shipped persona, saves a true
      // replacement, and the next prompt assembly reads it without restarting.
      const defaultOpening = fs.readFileSync(new URL('../../../preset/pentest/opening.md', import.meta.url), 'utf8')
      const openingGet = await handler('opening-get', { presetId: 'pentest' })
      ok('开场编辑器首开读取完整默认 persona',
        openingGet?.ok === true && openingGet.value.text === defaultOpening && openingGet.value.isCustom === false)
      ok('模式 persona 槽位清空，由方法库插件提供唯一开场',
        !!modeOpening && modeOpening.order < 0 && modeOpening.text({ agent: { ctx: {} } }).includes(defaultOpening.trim()))
      ok('模式 persona 开场拒绝路径穿越',
        (await handler('opening-get', { presetId: '../../outside' }))?.ok === false)

      const customOpening = '用户自定义的完整渗透测试开场。'
      const openingSaved = await handler('opening-save', { presetId: 'pentest', text: customOpening })
      ok('保存完整自定义开场，且首存不产生虚假备份',
        openingSaved?.ok === true && openingSaved.value.text === customOpening && openingSaved.value.isCustom === true && !openingSaved.value.backup)
      ok('下一轮 prompt assembly 直接采用用户全文替换默认 persona',
        modeOpening.text({ agent: { ctx: {} } }) === customOpening)
      const openingSaved2 = await handler('opening-save', { presetId: 'pentest', text: '第二版完整开场。' })
      ok('替换自定义开场前备份旧全文',
        openingSaved2?.ok === true && fs.existsSync(openingSaved2.value.backup)
        && fs.readFileSync(openingSaved2.value.backup, 'utf8') === customOpening)
      const blankOpening = await handler('opening-save', { presetId: 'pentest', text: '' })
      ok('空白内容也作为用户自定义全文保存，不会悄悄回到默认',
        blankOpening?.ok === true && blankOpening.value.isCustom === true && blankOpening.value.text === ''
        && modeOpening.text({ agent: { ctx: {} } }) === '')
      const blankReset = await handler('opening-reset', { presetId: 'pentest' })
      ok('恢复默认后重新注入随包默认全文',
        blankReset?.ok === true && blankReset.value.isCustom === false
        && modeOpening.text({ agent: { ctx: {} } }) === defaultOpening)

      // Migrate old prepend-only data by displaying it after the official text;
      // an explicit save creates the new replacement file, and reset removes both.
      const openingDir = path.join(tmpHome, 'method-stack', 'opening')
      fs.mkdirSync(openingDir, { recursive: true })
      const legacyNote = '旧版附加开场内容'
      fs.writeFileSync(path.join(openingDir, 'code-audit.md'), legacyNote, 'utf8')
      const auditDefault = fs.readFileSync(new URL('../../../preset/code-audit/opening.md', import.meta.url), 'utf8')
      const migrated = await handler('opening-get', { presetId: 'code-audit' })
      ok('旧版追加文本迁移时与完整默认 persona 合并保留',
        migrated?.ok === true && migrated.value.migrated === true
        && migrated.value.text === `${auditDefault.trimEnd()}\n\n${legacyNote}`)
      await handler('opening-save', { presetId: 'code-audit', text: '代码审计自定义完整开场。' })
      ok('切换到其他模式后读取其独立用户全文',
        modeOpening.text({ agent: { ctx: { preset: 'code-audit' } } }) === '代码审计自定义完整开场。')
      const openingReset = await handler('opening-reset', { presetId: 'code-audit' })
      ok('恢复默认会备份并移除新旧自定义稿',
        openingReset?.ok === true && openingReset.value.isCustom === false
        && !fs.existsSync(path.join(openingDir, 'code-audit.custom.md'))
        && !fs.existsSync(path.join(openingDir, 'code-audit.md'))
        && openingReset.value.text === auditDefault
        && openingReset.value.backups.length === 2
        && openingReset.value.backups.some((file) => fs.readFileSync(file, 'utf8') === legacyNote))
    } finally {
      fs.readdirSync = originalReaddir
    }
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    const resolved = path.resolve(tmpHome)
    const tempRoot = path.resolve(os.tmpdir()) + path.sep
    if (!resolved.startsWith(tempRoot)) throw new Error('refusing to remove non-temp path: ' + resolved)
    fs.rmSync(resolved, { recursive: true, force: true })
  }
}

// ── 模式开场：注入的是完整 persona，而不是前置附加段 ──
{
  const svr = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  ok('保存后不再把默认 persona 与用户开场叠加',
    svr.includes("name: 'saker-mode-opening'") && !svr.includes("name: 'saker-opening'"))
  for (const preset of ['pentest', 'code-audit', 'ctf-solver']) {
    const declarative = readFileSync(new URL(`../../../preset/${preset}/agent.cordis.yml`, import.meta.url), 'utf8')
    const legacy = readFileSync(new URL(`../../../preset/${preset}/agent.patch.yml`, import.meta.url), 'utf8')
    const opening = readFileSync(new URL(`../../../preset/${preset}/opening.md`, import.meta.url), 'utf8')
    ok(`${preset} 两种声明都把 persona 槽位交给可编辑开场`,
      /^\s*prefix: ''$/m.test(declarative) && /^\s*prefix: ''$/m.test(legacy) && opening.trim().length > 0)
  }
}

try { await import('./web-selection.mjs'); pass += 9; } catch (error) { fail++; console.error('FAIL Web module behavior', error); }
console.log(fail === 0 ? `\nall ${pass} tests passed` : `\n${fail} FAILED, ${pass} passed`)
process.exit(fail ? 1 : 0)
