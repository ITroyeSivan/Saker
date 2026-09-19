// 低频工具包：保留核心工具常驻，把只在特定阶段使用的工具大类按需加载。
// 设计约束：
//   · 只隐藏「当前模式存在、但通常属于后续阶段」的工具；基础侦察/记录/报告工具不收；
//   · 包的可见性仍以插件自身模式门禁为前提，工具包不会越过门禁；
//   · 默认只影响可见性，不改变工具执行或权限。

export const PACKS = [
  {
    id: 'webshell',
    label: 'WebShell 管理',
    prefixes: ['webshell_'],
    modes: ['pentest'],
    defaultVisible: false,
    hint: '连接、文件、数据库、载荷生成',
  },
]

export function enabledPacks(toggles) {
  const t = toggles && typeof toggles === 'object' ? toggles : {}
  return PACKS.filter((pack) => t[pack.id] !== false)
}

export function packsForMode(mode, packs = PACKS) {
  return packs.filter((pack) => pack.modes.includes(mode) && pack.defaultVisible !== true)
}

export function packTools(known, pack) {
  return known.filter((name) => pack.prefixes.some((prefix) => name.startsWith(prefix))).sort()
}

export function deferredPackTools(mode, known, packs = PACKS) {
  const deny = new Set()
  for (const pack of packsForMode(mode, packs)) {
    for (const name of packTools(known, pack)) deny.add(name)
  }
  return [...deny].sort()
}

export function findPack(id, packs = PACKS) {
  const key = String(id ?? '').trim().toLowerCase()
  return packs.find((pack) => pack.id === key) ?? null
}
