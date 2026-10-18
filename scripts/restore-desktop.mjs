#!/usr/bin/env node
// 按备份档案回退桌面配置与数据（v6 第 13 节「必要时使用对应备份恢复」）。
//
// 默认只打印方案、不写任何文件；加 --apply 才真的回退，且会先把当前配置存成
// `backups/desktop-pre-restore-<时间>`，所以回退本身也可以再回退。
// 回退前会跑档案自检：配置副本必须逐字节对得上记录，数据副本必须认得出格式。
//
// 用法: node scripts/restore-desktop.mjs --backup "<home>/backups/desktop-...>" [--home "<.dsh>"] [--apply]
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { inspectDesktopBackup, restoreDesktopProfile } from './lib/desktop-backup.mjs'
import { desktopProcesses } from './lib/desktop-process.mjs'

const argv = process.argv.slice(2)
const value = (flag) => { const i = argv.indexOf(flag); return i < 0 ? undefined : argv[i + 1] }
const apply = argv.includes('--apply')
const known = new Set(['--backup', '--home', '--apply', '--workspace', '--desktop-dir', '--user-data-dir'])
for (let i = 0; i < argv.length; i++) {
  if (!known.has(argv[i])) throw new Error(`Unknown argument: ${argv[i]}`)
  if (argv[i] !== '--apply') i++
}

const home = resolve(value('--home') ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'))
const workspace = resolve(value('--workspace') ?? process.cwd())
const launchConfigPath = join(workspace, '_ref', 'tools', 'saker-desktop-launch.json')
let launchConfig = {}
if (existsSync(launchConfigPath)) {
  try { launchConfig = JSON.parse(readFileSync(launchConfigPath, 'utf8').replace(/^\uFEFF/, '')) } catch { launchConfig = {} }
}
const desktopDirectory = value('--desktop-dir') ?? launchConfig.desktopDirectory
const userDataDirectory = value('--user-data-dir') ?? launchConfig.userDataDirectory
let backup = value('--backup')
if (!backup) {
  // 不写备份目录时，列出这台机器上最近的一次，避免让人去翻目录名。
  const root = join(home, 'backups')
  // 只认安装器写的档案名（desktop-<ISO 时间>）；`desktop-pre-restore-…` 是回退前的快照，
  // 它没有 backup.json，按字典序却排在后面，直接用会把默认值指错。
  const candidates = existsSync(root) ? readdirSync(root).filter(name => /^desktop-\d{4}-\d{2}-\d{2}T/.test(name)).sort() : []
  backup = candidates.at(-1) ? join(root, candidates.at(-1)) : undefined
}
if (!backup) { console.error('没有可用的备份：请先运行安装器（会自动备份），或用 --backup 指定目录。'); process.exit(1) }
backup = resolve(backup)
if (!existsSync(backup)) { console.error('备份目录不存在：' + backup); process.exit(1) }

const inspection = inspectDesktopBackup(backup)
console.log(`备份：${backup}`)
console.log(`时间：${inspection.record.createdAt}  数据整体复制：${inspection.record.includeData ? '是' : '否'}`)
console.log(`配置：${inspection.files.map(file => file.name).join('、') || '（无）'}`)
console.log(`数据：${inspection.data.map(entry => `${entry.path}${entry.copied ? '(可恢复)' : '(仅登记)'}`).join('、') || '（无）'}`)
if (inspection.problems.length) {
  console.error('档案自检未通过，已停止：\n  ' + inspection.problems.join('\n  '))
  process.exit(1)
}

const plan = restoreDesktopProfile({ home, directory: backup })
// bundles 里除 Saker 包外还有宿主自带的 base / web-app，计数要分开说，否则会让人以为多装了两个。
const bundles = plan.plan.rebuild.bundles
const productBundles = bundles.filter((name) => name.startsWith('@dsh-external/') || name === 'dsh-saker')
console.log(`匹配构建：${Object.keys(plan.plan.rebuild.dependencies).length} 个依赖；已启用 ${productBundles.length} 个 Saker 包`
  + (bundles.length > productBundles.length ? `（另有 ${bundles.length - productBundles.length} 个宿主 bundle）` : ''))
if (!apply) {
  console.log('以上只是方案，没有写任何文件。确认无误后加 --apply 执行回退。')
  process.exit(0)
}

// 应用还在跑的时候盖配置会被它重新写回去，所以这里直接拒绝。
// 0.2.1 使用随机端口，不能再靠固定端口；按可执行文件 + 日常 userData 归属判断。
const owned = desktopProcesses({ executable: desktopDirectory ? join(desktopDirectory, 'DeepSeek Harness.exe') : undefined, userDataDirectory })
if (owned.length) {
  console.error(`Desktop 仍在运行（PID ${owned.map(row => row.ProcessId).join(', ')}）。完全退出后再执行回退。`)
  process.exit(1)
}
if (!desktopDirectory && !userDataDirectory) {
  const any = desktopProcesses({})
  if (any.length) {
    console.error('检测到 DeepSeek Harness 进程，但没有 --desktop-dir/--user-data-dir 可供确认归属；完全退出后再执行回退。')
    process.exit(1)
  }
}

const result = restoreDesktopProfile({ home, directory: backup, apply: true })
console.log(`已回退配置${result.plan.data.length ? `与 ${result.plan.data.length} 处数据` : ''}。`)
console.log(`回退前的配置已存到：${result.safety}`)
console.log('重新打开 Desktop 前，请用备份记录里的依赖版本装回匹配构建。')
