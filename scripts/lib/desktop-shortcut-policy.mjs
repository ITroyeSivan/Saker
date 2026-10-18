// 桌面快捷方式是「日常入口」，不能因为一次隔离/临时安装被改指向。
//
// 2026-10-10 实测：install-desktop.mjs 允许 DSH_HOME 指向隔离目录（为了验证时不动
// 用户数据），但它在装配结束后无条件调 refreshDesktopShortcut({ home }) —— 那个函数
// 会把 <工作区>/_ref/tools/saker-desktop-launch.json 的 home 写成传入值，并重写用户
// 桌面上的 Saker (dsh Desktop).lnk。于是「装到隔离 home」会把日常快捷方式指到临时
// 目录；临时目录一清，快捷方式就成了死链（用户侧表现为"点了没反应"）。
//
// 这里把判断抽成纯函数：只有装到日常 home 才刷新，其它情况必须显式覆盖。
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export function dailyDesktopHome() {
  return resolve(join(homedir(), '.dsh'))
}

export function shouldRefreshDailyShortcut({ home, override = false, dailyHome = dailyDesktopHome() } = {}) {
  if (typeof home !== 'string' || !home.trim()) throw new Error('home is required to decide whether the daily shortcut may be refreshed')
  const target = resolve(home)
  const daily = resolve(dailyHome)
  const sameHome = target.toLowerCase() === daily.toLowerCase()
  return { refresh: sameHome || override === true, sameHome, home: target, dailyHome: daily }
}
