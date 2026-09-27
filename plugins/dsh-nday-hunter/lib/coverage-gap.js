// S2 的第二个产物：**覆盖缺口**。
//
// 方案 §4.3 写的是「归一后的 asset-inventory.json + 覆盖缺口」，但此前只有
// `nday_coverage(keyword)` 这种**手输关键词**的体检——打完一轮侦察拿到资产账本之后，
// 没有人回答「我这批目标里，哪些产品是我三层全瞎的」。这个模块补的就是这一格。
//
// 做法：从账本的 tech / title 派生产品关键词 → 逐关键词跑既有的三层体检
// （精选语料 / 本地知识包 / 本地 nuclei 模板）→ 按「盲得最狠」排序输出。
// 只读账本与本地库存，不发任何流量。
import { WATCHLIST } from "./triage.js";

/** 标题里常见的非产品词：命中它们只会把噪音排到缺口表前排。 */
const STOPWORDS = new Set([
  "http", "https", "www", "com", "cn", "net", "html", "index", "login", "admin",
  "error", "default", "server", "welcome", "portal", "home", "page", "system",
  "管理", "登录", "首页", "系统", "平台", "门户", "欢迎", "控制台", "后台",
]);

const CJK_VENDORS = WATCHLIST.filter((word) => /[\u4e00-\u9fff]/.test(word));

/**
 * 从资产账本派生产品关键词。
 *
 * 只用两个来源：`tech`（归一阶段抽出的技术栈，最干净）与 `title`（常含产品名）。
 * 刻意**不从 URL 派生**——域名与路径会带出成百上千个噪音词。
 * @param {object[]} assets - asset-inventory.json 的 assets。
 * @param {{ limit?: number }} options
 * @returns {{ keyword: string, assets: number, from: string }[]}
 */
export function deriveProductKeywords(assets, { limit = 15 } = {}) {
  const counts = new Map(); // keyword -> { assets:Set<index>, from:Set<string> }
  const bump = (keyword, index, from) => {
    const key = String(keyword || "").trim().toLowerCase();
    // 中文厂商名大多是**两个字**（泛微/致远/用友/金蝶/帆软/通达/蓝凌/中创/万户）——
    // 用「长度 ≥3」一刀切会把它们全滤掉，只剩 tech 里的英文名能进表。
    const minLength = /[\u4e00-\u9fff]/.test(key) ? 2 : 3;
    if (key.length < minLength || STOPWORDS.has(key)) return;
    const row = counts.get(key) ?? { assets: new Set(), from: new Set() };
    row.assets.add(index);
    row.from.add(from);
    counts.set(key, row);
  };

  for (const [index, asset] of (Array.isArray(assets) ? assets : []).entries()) {
    for (const tech of (Array.isArray(asset?.tech) ? asset.tech : [])) {
      // tech 是归一阶段抽好的，整条当一个关键词（"TongWeb 7.0" 这类也照收）。
      bump(String(tech).split(/[\s/]+/)[0], index, "tech");
    }
    const title = String(asset?.title ?? "");
    for (const word of title.match(/[A-Za-z][A-Za-z0-9-]{3,}/g) ?? []) bump(word, index, "title");
    for (const vendor of CJK_VENDORS) if (title.includes(vendor)) bump(vendor, index, "title");
  }

  return [...counts.entries()]
    .map(([keyword, row]) => ({ keyword, assets: row.assets.size, from: [...row.from].join("+") }))
    .sort((a, b) => b.assets - a.assets || a.keyword.localeCompare(b.keyword))
    .slice(0, limit);
}

/**
 * 把每个关键词的三层体检结果分成三档——**盲得最狠的排最前**，
 * 因为那才是"接下来该补什么"的答案。
 * @param {{ keyword: string, assets: number, scan: object }[]} rows
 * @returns {{ blind: object[], docsOnly: object[], siftable: object[] }}
 */
export function classifyCoverageGap(rows) {
  const blind = [];
  const docsOnly = [];
  const siftable = [];
  for (const row of rows) {
    const scan = row.scan ?? {};
    const siftableCount = scan.l1?.siftable ?? 0;
    const docs = scan.l2?.total ?? 0;
    const templates = scan.l3?.total ?? 0;
    const bucket = siftableCount > 0 ? siftable : (docs === 0 && templates === 0 ? blind : docsOnly);
    bucket.push({ ...row, siftableCount, docs, templates });
  }
  return { blind, docsOnly, siftable };
}

/** 渲染成模型可读的缺口表。 */
export function renderCoverageGap(rows, { totalAssets = 0, inventoryFile = "" } = {}) {
  const { blind, docsOnly, siftable } = classifyCoverageGap(rows);
  // 「可筛」那一档把**命中了哪些条目**也列出来：关键词是子串匹配，像 `spring`
  // 会命中 `tongtech-tongweb-spring-httpinvoker-rce`——那其实是东方通的条目。
  // 不列出来，看表的人会以为「Spring 已覆盖」。
  const line = (row) => {
    const ids = (row.scan?.l1?.ids ?? []).slice(0, 3).join(" / ");
    return `- ${row.keyword}（${row.assets} 个资产，来自 ${row.from}）  语料可筛 ${row.siftableCount} / 知识包 ${row.docs} 篇 / 模板 ${row.templates} 个`
      + (ids ? `  命中：${ids}` : "");
  };
  const out = [
    `覆盖缺口（账本 ${totalAssets} 个资产 · 派生出 ${rows.length} 个产品关键词${inventoryFile ? ` · 来源 ${inventoryFile}` : ""}）`,
    "",
    "口径：只读本地三层库存，不发任何流量；模板多≠本条已覆盖，这里看的是**这个产品**有没有存货。",
    "",
  ];
  if (rows.length === 0) {
    out.push("账本里没派生出可用的产品关键词——先跑 `asset_search` / `asset_ingest` 把资产与指纹落进账本。");
    return out.join("\n");
  }
  if (blind.length > 0) {
    out.push(`【三层全空】${blind.length} 个——最该补的方向：`);
    for (const row of blind) out.push(line(row));
    out.push("  下一步：`nday_coverage(keyword)` 看单产品细节；本地没有就实时检索（产品+版本+漏洞类型+(POC|EXP|github)），找到后用 `nday_learn` 落库。", "");
  }
  if (docsOnly.length > 0) {
    out.push(`【有文档/模板但没有可筛条目】${docsOnly.length} 个——用 nday_draft 把文档转成条目：`);
    for (const row of docsOnly) out.push(line(row));
    out.push("");
  }
  if (siftable.length > 0) {
    out.push(`【已有可筛条目】${siftable.length} 个——直接 nday_match：`);
    for (const row of siftable) out.push(line(row));
    out.push("");
  }
  return out.join("\n");
}
