// dsh-nday-hunter / home.js —— 平台数据根的单一来源。
//
// 为什么单独成文件：Nday 语料分两层 —— 包层只读（随包升级覆盖），
// 用户层可写（现场新收的条目落 `<DSH_HOME>/refs/<mode>/nday/`，不随升级丢失）。
// 宿主不设 DSH_HOME 时必须回落到 ~/.dsh，否则用户层语料会**静默数成 0**
// （真实验收踩过：本地明明有 49 个文件名命中，工具却报 0 篇）。
//
// 全插件只有这一个文件读环境变量，其余模块一律 import 这里 ——
// 避免再出现「一处回落了、另一处漏了」的分叉。

import os from 'node:os'
import path from 'node:path'

// 规范形态（与仓库其余插件一致）：DSH_HOME 优先，缺失时回落 ~/.dsh。
export const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

/** 显式注入版（测试 / 迁移场景）；默认值与 DSH_HOME 同一套规则。 */
export function resolveDshHome(env = process.env, homedir = os.homedir()) {
  const value = String(env.DSH_HOME || '').trim()
  return value || path.join(homedir, '.dsh')
}
