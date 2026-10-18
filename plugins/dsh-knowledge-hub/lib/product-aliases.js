// 产品别名（v6 第 6.1 节）：每条知识要带「产品别名」，检索前要「规范化产品别名和 CVE」。
//
// 词典不靠猜，只来自**源侧自述**的条目：`nday/catalog.json` 里每条漏洞记录自己的
// `product` / `vendor` / `aliases` 字段（厂商与研究者写下的名字）。没有词典就返回空，
// 不用规则把普通英文词当成产品名。
//
// 清洗规则都是拿仓库里 333 条 catalog 统计出来的（2026-10-17）：
//   · 产品粒度取「去掉尾部括号说明」：同一个产品的多条记录会写成
//     `泛微 e-cology（BeanShell 组件）`，去掉括号才是产品而不是某条漏洞。
//   · 带括号的值整条丢弃（243 条）：括号里是组件注释或厂商法人后缀，都不是产品写法。
//   · 归一化后超过长度上限的丢弃：目录里有 463 条是整句英文标题
//     （`Ruijie Switch Web Management System EXCU_SHELL - Information Disclosure`），
//     既不会原样出现在正文里，也不适合当别名。
//   · 一个词如果被**多个厂商**的产品声明就丢弃：`oa` 横跨 31 个产品、`auth-bypass`/`disclosure`/
//     `cve2025` 这类标签也是被一堆不同厂商的条目挂在 `aliases` 上，它们都不是产品别名。
//     判据是「产品 → 多数厂商」再比厂商，而不是直接比 vendor 字符串：源侧同一个厂商会写成
//     中文法人名、`weaver`、`（厂商见模板与来源链接）`三种身份，先按产品投票取厂商能把
//     大部分写法收拢。收不拢的（`weaver` 同时挂在泛微和 SAP NetWeaver 条目上，属于源数据
//     本身的污染）按「指向不明」丢弃。
//
// 本模块保持纯函数（不读文件、不碰数据库、不调模型），便于在无宿主的单测里逐条断言。

/** 匹配用归一化：大小写、全角半角、空格与常见标点都不参与比较。 */
export function normalizeAliasTerm(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[._\-/\\()[\]{}（）【】《》,，;；:：'"“”‘’·、|+*]+/g, '')
}

/** 去掉尾部括号说明，留下产品主体（`泛微 e-cology（BeanShell 组件）` → `泛微 e-cology`）。 */
export function productFamilyOf(value) {
  return String(value || '').replace(/[（(][^（()）]*[)）]\s*$/u, '').trim()
}

function hasHan(value) {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(value)
}

/** 两个字符的 charCode 拼成一个整数锚点（都 ≤ 0xFFFF，不会溢出）。 */
function anchorKey(first, second) {
  return (first << 16) | second
}

const MAX_TERM_CHARS = 16
const MAX_VENDOR_TERM_CHARS = 12
const DEFAULT_MAX_PRODUCTS_PER_TERM = 40

/** 清洗一条候选写法：返回可用的归一化词，不可用返回空串。 */
function cleanTerm(value, options) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  // 带括号的整条丢弃（组件注释 / 厂商法人后缀），不做局部截取，避免制造半截词。
  if (/[（(]/.test(raw)) return ''
  const key = normalizeAliasTerm(raw)
  if (!key) return ''
  // 纯数字别名（`360`）不能当产品证据：正文里的数字到处都是，拿它匹配等于随机命中。
  if (/^\d+$/.test(key)) return ''
  // 太短的词不参与匹配：纯拉丁词至少 3 字符，含汉字的至少 2 字符。
  const min = hasHan(key) ? options.minHan : options.minLatin
  if (key.length < min) return ''
  const max = options.vendorField ? MAX_VENDOR_TERM_CHARS : MAX_TERM_CHARS
  return key.length > max ? '' : key
}

/** 厂商展示名：源侧字段常常是占位符，占位符不算厂商。 */
function usableVendor(value) {
  const vendor = String(value || '').trim()
  if (!vendor || /见模板|见来源|^[-—]+$/.test(vendor)) return ''
  return vendor
}

/**
 * 厂商归一键：先去掉尾部括号（`上海泛微网络科技股份有限公司（Weaver Network Co., Ltd.）`
 * 与不带括号的那一份是同一个厂商），再按匹配用归一化。
 */
function vendorKeyOf(vendor) {
  const key = normalizeAliasTerm(productFamilyOf(vendor))
  return key || normalizeAliasTerm(vendor)
}

/**
 * 用源侧条目建词典。
 *
 * 返回：
 *   terms         Map<归一化词, { term, display, products }>
 *   productTerms  Map<产品, [{ term, display }]>（长的在前，检索扩展与展示都先给信息量大的写法）
 *   anchors       Map<前 2 字符, 归一化词[]>（扫描时按窗口取候选，避免整表全扫）
 *   ambiguousTerms / droppedValues / size / products 计数，供上层如实说明
 */
export function buildAliasDictionary(entries, options = {}) {
  const minLatin = Number.isInteger(options.minLatin) ? options.minLatin : 3
  const minHan = Number.isInteger(options.minHan) ? options.minHan : 2
  const maxProductsPerTerm = Number.isInteger(options.maxProductsPerTerm) ? options.maxProductsPerTerm : DEFAULT_MAX_PRODUCTS_PER_TERM
  const rows = Array.isArray(entries) ? entries : []

  const termProducts = new Map()
  const termDisplay = new Map()
  const termCount = new Map()
  const productVendors = new Map()
  const vendorDisplay = new Map()

  let droppedValues = 0
  // 第一遍：产品 → 厂商投票。源侧 vendor 字段写法不统一（中文法人名 / weaver / 占位符），
  // 先用 vendorKeyOf 归一，再按产品收敛到多数厂商。
  for (const row of rows) {
    const product = productFamilyOf(row && row.product)
    if (!product) continue
    const vendor = usableVendor(row && row.vendor)
    if (!vendor) continue
    const key = vendorKeyOf(vendor)
    if (!key) continue
    if (!vendorDisplay.has(key)) vendorDisplay.set(key, vendor)
    if (!productVendors.has(product)) productVendors.set(product, new Map())
    const counts = productVendors.get(product)
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  const canonicalVendor = new Map()
  for (const [product, counts] of productVendors) {
    canonicalVendor.set(product, [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0])
  }

  // 第二遍：收集每个词的候选写法与它被哪些产品声明。
  for (const row of rows) {
    const product = productFamilyOf(row && row.product)
    if (!product) continue
    const declared = [[row.product, false], [row.vendor, true],
      ...(Array.isArray(row.aliases) ? row.aliases.map((alias) => [alias, false]) : [])]
    const seenInEntry = new Set()
    for (const [value, vendorField] of declared) {
      if (!String(value || '').trim()) continue
      const key = cleanTerm(value, { minLatin, minHan, vendorField })
      if (!key) {
        droppedValues++
        continue
      }
      if (!termProducts.has(key)) {
        termProducts.set(key, new Set())
        termDisplay.set(key, String(value).trim())
      }
      termProducts.get(key).add(product)
      // 被多少条条目声明过：多次出现的多是品牌/产品名，只出现一次的常是组件名或参数名。
      if (!seenInEntry.has(key)) {
        seenInEntry.add(key)
        termCount.set(key, (termCount.get(key) || 0) + 1)
      }
    }
  }

  const terms = new Map()
  let ambiguousTerms = 0
  for (const [key, products] of termProducts) {
    // 指向多个厂商（或产品数过多）说明不了是哪个产品，直接丢弃；不挑一个"最像的"充数。
    const vendors = new Set()
    let unknownVendor = 0
    for (const product of products) {
      const vendor = canonicalVendor.get(product)
      if (vendor) vendors.add(vendor)
      else unknownVendor++
    }
    // 只要有一个产品说不清厂商，这个词就归不到具体产品上（`config` 这类泛词就是这样
    // 混进来的：它挂在一条有厂商、一条没厂商的条目上，只数"已知厂商"会漏判）。
    if (unknownVendor > 0 || vendors.size !== 1 || products.size > maxProductsPerTerm) {
      ambiguousTerms++
      continue
    }
    terms.set(key, {
      term: key,
      display: termDisplay.get(key) || key,
      count: termCount.get(key) || 1,
      products: [...products].sort((a, b) => a.length - b.length || (a < b ? -1 : 1)),
    })
  }

  const productTerms = new Map()
  for (const info of terms.values()) {
    for (const product of info.products) {
      if (!productTerms.has(product)) productTerms.set(product, [])
      productTerms.get(product).push({ term: info.term, display: info.display, count: info.count })
    }
  }
  for (const list of productTerms.values()) {
    // 先给"被多条条目声明过"的写法（品牌/产品名），再给只出现一次的（组件名、参数名）。
    list.sort((a, b) => b.count - a.count || b.term.length - a.term.length || (a.term < b.term ? -1 : 1))
  }

  // 锚点用两个字符的 charCode 拼成一个整数当键：逐窗口 `slice(0,2)` 会为每个位置分配
  // 一个字符串，实测 32MB 语料下这一项就占了大头（109 ms/MB → 见下方 anchorKey）。
  const anchors = new Map()
  for (const key of terms.keys()) {
    const anchor = anchorKey(key.charCodeAt(0), key.charCodeAt(1))
    if (!anchors.has(anchor)) anchors.set(anchor, [])
    anchors.get(anchor).push(key)
  }
  // 同一窗口下先试最长的词：`e-cology` 要压过 `ecology` 之类的短词。
  for (const list of anchors.values()) list.sort((a, b) => b.length - a.length || (a < b ? -1 : 1))

  return {
    terms, productTerms, anchors, productVendors, ambiguousTerms, droppedValues,
    canonicalVendor, vendorDisplay, products: productVendors.size, size: terms.size,
  }
}

/**
 * 纯 ASCII 的别名要做词边界校验。
 *
 * 归一化把空格和标点都去掉了，`eweb` 会在 `AppleWebKit` 里命中（真机实测：
 * 一篇泛微 E-Office 的 POC 因此多出一个"锐捷 EWEB"分组）。所以命中后回到**原始行**确认
 * 前后不是拉丁字母/数字。汉字别名不需要这一步（汉字串本身够具体）。
 */
function asciiBoundaryOk(originalLine, display) {
  const hay = originalLine.toLowerCase()
  const needle = display.toLowerCase()
  if (!needle) return false
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
    const before = at > 0 ? hay[at - 1] : ''
    const after = hay[at + needle.length] || ''
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true
  }
  return false
}

/** 在一行里找该行出现的所有词典词（同一窗口只取最长命中）。 */
function matchTermsInLine(normalizedLine, originalLine, dictionary) {
  const out = []
  for (let at = 0; at + 1 < normalizedLine.length; at++) {
    const candidates = dictionary.anchors.get(anchorKey(normalizedLine.charCodeAt(at), normalizedLine.charCodeAt(at + 1)))
    if (!candidates) continue
    for (const key of candidates) {
      if (!normalizedLine.startsWith(key, at)) continue
      const info = dictionary.terms.get(key)
      if (!info) break
      if (!hasHan(key) && !asciiBoundaryOk(originalLine, info.display)) break
      out.push(key)
      at += key.length - 1
      break
    }
  }
  return out
}

function topVendor(dictionary, product) {
  const key = dictionary.canonicalVendor ? dictionary.canonicalVendor.get(product) : ''
  if (!key) return ''
  return (dictionary.vendorDisplay && dictionary.vendorDisplay.get(key)) || key
}

/**
 * 从一篇原文里抽产品别名（v6 第 6.1 节「提取字段关联原文段落」）。
 *
 * 产品靠命中词投票选出：被最多命中词声明的那个产品排在前。每组给出产品、厂商、
 * 命中到的别名写法（按首次出现排序）以及首次出现的行号 —— 行号就是与原文段落的关联。
 */
export function extractProductAliases(text, dictionary, options = {}) {
  if (!dictionary || !dictionary.terms || dictionary.terms.size === 0) return []
  const limit = Number.isInteger(options.limit) ? options.limit : 5
  const maxAliasesPerGroup = Number.isInteger(options.maxAliasesPerGroup) ? options.maxAliasesPerGroup : 6
  const lines = String(text || '').split(/\r?\n/)

  const firstLine = new Map()
  for (let i = 0; i < lines.length; i++) {
    const normalized = normalizeAliasTerm(lines[i])
    if (normalized.length < 2) continue
    for (const key of matchTermsInLine(normalized, lines[i], dictionary)) {
      if (!firstLine.has(key)) firstLine.set(key, i + 1)
    }
  }
  if (firstLine.size === 0) return []

  const votes = new Map()
  for (const [key] of firstLine) {
    const info = dictionary.terms.get(key)
    if (!info) continue
    for (const product of info.products) votes.set(product, (votes.get(product) || 0) + 1)
  }
  if (votes.size === 0) return []

  return [...votes.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([product, matched]) => {
      const hits = [...firstLine.entries()]
        .filter(([key]) => (dictionary.terms.get(key)?.products || []).includes(product))
        .sort((a, b) => a[1] - b[1])
      const aliases = [...new Set(hits.map(([key]) => dictionary.terms.get(key).display))].slice(0, maxAliasesPerGroup)
      const line = hits.length ? hits[0][1] : 0
      return { product, vendor: topVendor(dictionary, product), aliases, line, matched }
    })
    .map(({ product, vendor, aliases, line }) => ({ product, vendor, aliases, line }))
}

/**
 * 检索前的产品别名规范化（v6 第 6.1 节）：查询里出现的别名词，换成同一产品下
 * 其余的写法，交给调用方拼一条兜底检索计划。
 *
 * 返回的是**原始写法**而不是拆好的词元：调用方应当把它们当成短语去查，
 * 否则中文会被拆成一堆 bigram，`应用服务器` 会退化成 `应用`/`服务` 这种泛词。
 */
export function expandQueryAliases(query, dictionary, options = {}) {
  if (!dictionary || !dictionary.terms || dictionary.terms.size === 0) return []
  const limit = Number.isInteger(options.limit) ? options.limit : 6
  const normalized = normalizeAliasTerm(query)
  if (normalized.length < 2) return []

  const products = new Set()
  // 查询串本身没有"原始行"概念，直接用查询原文做边界校验。
  for (const key of matchTermsInLine(normalized, String(query || ''), dictionary)) {
    const info = dictionary.terms.get(key)
    if (info) for (const product of info.products) products.add(product)
  }
  if (products.size === 0) return []

  const out = []
  for (const product of products) {
    for (const item of dictionary.productTerms.get(product) || []) {
      // 查询里已经写了这个写法就不用再补，避免把原查询重复一遍。
      if (normalized.includes(item.term)) continue
      // 只出现一次的写法多是组件名/参数名（`VerifyQuickLogin`、`userIdentifiers`），
      // 拿它们去检索会把无关文档拉进来；兜底计划只用被多条条目声明过的写法。
      if (Number(item.count || 0) < 2) continue
      if (out.includes(item.display)) continue
      out.push(item.display)
      if (out.length >= limit) return out
    }
  }
  return out
}
