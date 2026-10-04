// 低频工具包：保留核心工具常驻，把只在特定阶段使用的工具大类按需加载。
// 设计约束：
//   · 记录、对照、结果工具常驻；测绘和情报工具按本轮问题加载；
//   · 包的可见性仍以插件自身模式门禁为前提，工具包不会越过门禁；
//   · 默认只影响可见性，不改变工具执行或权限。

export const PACKS = [
  {
    id: 'asset-discovery',
    label: '目标识别与资产查询',
    prefixes: ['asset_search', 'asset_candidate_search', 'asset_ingest', 'subfinder_enum', 'httpx_probe', 'whatweb_fingerprint', 'wafw00f_detect'],
    modes: ['pentest'],
    defaultVisible: false,
    hint: '只给 URL 需有限识别，或用户明确要求查少量资产时加载；不自动扩大范围',
  },
  {
    id: 'nday',
    label: '公开漏洞与情报源',
    prefixes: ['nday_'],
    modes: ['pentest'],
    defaultVisible: false,
    hint: 'Nday发现、核对明确组件或维护情报源时加载；已有业务问题无需先查全库',
  },
  {
    id: 'active-scan',
    label: '主动扫描器',
    prefixes: ['nmap_portscan', 'dirsearch_dirs', 'ffuf_fuzz', 'nuclei_scan', 'afrog_scan', 'sqlmap_inject', 'katana_crawl', 'gau_urls'],
    modes: ['pentest'],
    defaultVisible: false,
    hint: 'Nmap、目录/内容发现、Nuclei、Afrog、SQLMap 与爬取；按单个假设加载，不默认全扫',
  },
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
