// 语料转换的瓶颈不在"收录"，在"从几千份 POC 文档里挑出哪几份值得转"。
// 现状：本地知识包上万篇文档，机器可筛条目只有十来条，`nday_draft` 一次只吃一篇。
// 这个模块把「挑」这一步机器化：扫一批文档，按**可解释的加分项**排成待转工作单。
//
// 三条纪律：
//   1) 只产出**候选**，不写库、不改语料——落库仍要过 nday_learn 的诚实性门禁；
//   2) 分数必须**可解释**：每一项加分都对应一句人话，模型和人都能复核；
//   3) 已经进过语料的（编号或路径命中）单独标出来，不再占工作单前排——
//      否则每次跑都推荐同一批已完成的。
import { extractNdayCandidates } from "./extract.js";

/** 信创/国产组件观察名单：语料的收录优先级就是按这个来的（护网复盘的直接教训）。 */
export const WATCHLIST = [
  "东方通", "tongweb", "宝兰德", "bes", "金蝶", "kingdee", "apusic", "中创", "infor",
  "帆软", "finereport", "finebi", "泛微", "weaver", "ecology", "e-office",
  "致远", "seeyon", "通达", "tongda", "用友", "yonyou", "yonbip", "ufida",
  "蓝凌", "landray", "万户", "红帆", "华天", "金和", "新点", "信呼", "源天", "智明", "o2oa",
];

/** 高价值漏洞类：能直接拿权限或读数据的那几类。 */
const HIGH_IMPACT = [
  { re: /未授权|unauth|免登录|无需登录/i, label: "未授权" },
  { re: /rce|命令执行|代码执行|远程执行|反序列化|deseriali/i, label: "RCE/反序列化" },
  { re: /任意文件上传|文件上传|upload/i, label: "文件上传" },
  { re: /sql\s*注入|sqli|注入/i, label: "注入" },
  { re: /任意文件读取|文件读取|目录遍历|path\s*traversal|lfi/i, label: "文件读取/遍历" },
  { re: /ssrf|服务端请求/i, label: "SSRF" },
];

const normalizePath = (value) => String(value || "").trim().replace(/[?#].*$/, "").replace(/\/+$/, "").toLowerCase();

const escapeRe = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 观察名单命中判定。两类假命中都实际踩过，所以规则分两套：
 *
 * ① ASCII 词按**词边界**匹配：`/defaultroot/upload/information` 里的 `information`
 *    一度把 `infor` 判成中创，把无关文档顶到前排。
 * ② 中文词按**段首**匹配：中文没有词边界，而厂商名常常是常用短语的子串——
 *    实测 `Apache OFBiz 身份验证绕过导致远程代码执行` 里的「**导致远**程」正好含
 *    「致远」，于是这份 Apache 文档被加上「信创优先」的 30 分排到了第一名。
 *    所以中文词只认「以它开头的那一段」（如 `致远OA`、`帆软报表`），不认句中子串。
 */
const CJK_RE = /[\u4e00-\u9fff]/;

function segmentStarts(haystack, word) {
  for (const segment of haystack.split(/[^\p{L}\p{N}]+/u)) {
    if (segment.startsWith(word)) return true;
  }
  return false;
}

function watchHit(haystack, word) {
  if (CJK_RE.test(word)) return segmentStarts(haystack, word);
  return new RegExp(`(^|[^a-z0-9])${escapeRe(word)}([^a-z0-9]|$)`, "i").test(haystack);
}

/**
 * 一条文档 vs 现有语料：命中编号或路径就算已覆盖。
 * @param {object} candidates - extractNdayCandidates 的输出。
 * @param {object[]} entries - catalog.entries。
 * @returns {{ covered: boolean, why: string[] }}
 */
export function coverageOf(candidates, entries = []) {
  const why = [];
  const ids = [
    ...(candidates.ids?.cve || []),
    ...(candidates.ids?.cnvd || []),
    ...(candidates.ids?.qvd || []),
  ].map((v) => String(v).toUpperCase());
  const paths = (candidates.paths || []).map(normalizePath).filter(Boolean);
  for (const entry of entries) {
    const entryIds = [entry?.ids?.cve, entry?.ids?.cnvd, entry?.ids?.qvd]
      .filter(Boolean)
      .map((v) => String(v).toUpperCase());
    const hitId = entryIds.find((id) => ids.includes(id));
    if (hitId !== undefined) {
      why.push(`编号 ${hitId} 已在 ${entry.id}`);
      return { covered: true, why };
    }
    const entryPaths = (entry?.fingerprint?.paths || []).map(normalizePath).filter(Boolean);
    const hitPath = entryPaths.find((p) => paths.some((candidate) => candidate === p || candidate.startsWith(`${p}/`)));
    if (hitPath !== undefined) {
      why.push(`路径 ${hitPath} 已在 ${entry.id}`);
      return { covered: true, why };
    }
  }
  return { covered: false, why };
}

/**
 * 给一份文档打分。分数是**加分项之和**，每一项都写进 reasons 里，便于复核。
 * @param {object} candidates - extractNdayCandidates 的输出。
 * @param {{ covered?: boolean, coveredWhy?: string[] }} coverage
 * @param {{ file?: string }} context - 文档路径。文件名/标题是**有意**纳入的信号
 *   （标题写着「任意文件上传」就该加分），不靠链接里恰好带了标题。
 * @returns {{ score: number, reasons: string[] }}
 */
export function scoreDoc(candidates, coverage = {}, context = {}) {
  const reasons = [];
  let score = 0;

  const ids = [
    ...(candidates.ids?.cve || []),
    ...(candidates.ids?.cnvd || []),
    ...(candidates.ids?.qvd || []),
  ];
  if (ids.length > 0) {
    score += 40;
    reasons.push(`+40 有官方编号（${ids.slice(0, 3).join(" / ")}）——好找权威来源，门禁好过`);
  }

  const paths = (candidates.paths || []).filter(Boolean);
  if (paths.length > 0) {
    score += 25;
    reasons.push(`+25 抽到 ${paths.length} 条 URL 级路径——能直接写成探针`);
  } else {
    reasons.push("+0 没抽到 URL 级路径——按现状只能标 legacy-unreviewed");
  }

  const signatures = (candidates.signatures || []).filter(Boolean);
  if (signatures.length > 0) {
    score += 15;
    reasons.push(`+15 抽到错误签名（${signatures[0].slice(0, 40)}）——判据可从 weak 升到 medium`);
  }

  // 只用**这篇文档自己的身份**（文件名 + 它自己的路径/端点/命名空间）判类目与厂商，
  // **不看 links**。踩过两次：`android-physical-attacks.md` 因为参考文献里出现
  // `weaver` 被当成泛微；引用链接说的是"参考了什么"，不是"这是谁的产品"。
  const identity = [
    String(context.file || ""),
    ...(candidates.paths || []),
    ...(candidates.endpoints || []),
    ...(candidates.namespaces || []),
  ].join(" ");
  const impact = HIGH_IMPACT.filter((item) => item.re.test(identity));
  if (impact.length > 0) {
    score += 15;
    reasons.push(`+15 高价值类目（${impact.map((i) => i.label).join(" / ")}）`);
  }

  const watch = WATCHLIST.find((word) => watchHit(identity.toLowerCase(), word));
  if (watch !== undefined) {
    // 权重刻意给到 30：语料 README 写的收录优先级就是「信创与国产组件优先，
    // 而不是按漏洞知名度排」。给 10 的话，一条 Apache 通用 CVE 会把国产 OA 顶下去，
    // 与既定口径相反。
    score += 30;
    reasons.push(`+30 信创/国产观察名单命中「${watch}」——语料收录优先级最高的一档`);
  }

  if ((candidates.versions || []).length > 0) {
    score += 5;
    reasons.push("+5 有影响版本线索");
  }

  if (coverage.covered === true) {
    score -= 100;
    reasons.push(`-100 已覆盖：${(coverage.coveredWhy || []).join("；")}`);
  }

  return { score, reasons };
}

/**
 * 把一批文档排成待转工作单。
 * @param {{ file: string, text: string }[]} docs - 待评估文档。
 * @param {{ entries?: object[], limit?: number, minScore?: number }} options
 * @returns {{ ranked: object[], stats: object }}
 */
export function triageDocs(docs, { entries = [], limit = 20, minScore = 30 } = {}) {
  const all = [];
  for (const doc of docs) {
    let candidates;
    try {
      candidates = extractNdayCandidates(doc.text);
    } catch {
      continue;
    }
    // **文件名也是标题**：大量 POC 文档把 `CVE-xxxx-xxxxx` / `CNVD-xxxx-xxxxx`
    // 写在文件名上，正文里不再重复。只从正文抽编号会漏掉一整类文档
    // （第一次跑工作单时合成的 `致远OA … CNVD-2021-01627.md` 就因为编号只在文件名里而落榜）。
    // 只并**编号与版本**，不并路径——文件名里没有 URL，而相对目录名混进 paths 会造假探针。
    try {
      const fromName = extractNdayCandidates(String(doc.file || "").split("/").pop() || "");
      candidates.ids = {
        cve: [...new Set([...(candidates.ids?.cve || []), ...fromName.ids.cve])],
        cnvd: [...new Set([...(candidates.ids?.cnvd || []), ...fromName.ids.cnvd])],
        qvd: [...new Set([...(candidates.ids?.qvd || []), ...fromName.ids.qvd])],
      };
      candidates.versions = [...new Set([...(candidates.versions || []), ...fromName.versions])].slice(0, 40);
    } catch { /* 文件名抽不出来不影响正文结果 */ }
    const coverage = coverageOf(candidates, entries);
    const { score, reasons } = scoreDoc(candidates, {
      covered: coverage.covered,
      coveredWhy: coverage.why,
    }, { file: doc.file });
    all.push({
      file: doc.file,
      score,
      covered: coverage.covered,
      reasons,
      ids: candidates.ids,
      paths: (candidates.paths || []).slice(0, 3),
      signatures: (candidates.signatures || []).slice(0, 2),
      versions: (candidates.versions || []).slice(0, 4),
    });
  }

  const eligible = all.filter((item) => item.covered === false && item.score >= minScore);
  eligible.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));

  // 跨知识包去重：同一个漏洞在 awesome-poc 与 peiqi-wiki 里各有一篇，
  // 不去重的话工作单前十有一半是同一件事的两个副本（实测第 1/5、第 3/6 就是）。
  // 判据优先用**官方编号**（唯一性最强），没有编号才退回第一条路径。
  const keyOf = (item) => {
    const ids = [...(item.ids?.cve || []), ...(item.ids?.cnvd || []), ...(item.ids?.qvd || [])]
      .map((v) => String(v).toUpperCase());
    if (ids.length > 0) return `id:${ids[0]}`;
    const path0 = (item.paths || []).map(normalizePath).filter(Boolean)[0];
    return path0 ? `path:${path0}` : `file:${item.file}`;
  };

  const byKey = new Map();
  for (const item of eligible) {
    const key = keyOf(item);
    const kept = byKey.get(key);
    if (kept === undefined) {
      byKey.set(key, { ...item, duplicates: [] });
      continue;
    }
    kept.duplicates.push(item.file);
  }
  const deduped = [...byKey.values()];

  return {
    ranked: deduped.slice(0, limit),
    stats: {
      scanned: all.length,
      alreadyCovered: all.filter((item) => item.covered).length,
      eligible: eligible.length,
      unique: deduped.length,
      duplicatesCollapsed: eligible.length - deduped.length,
      returned: Math.min(deduped.length, limit),
      minScore,
    },
  };
}

/** 渲染成模型可读的工作单。 */
export function renderWorklist(result, { root = "" } = {}) {
  const { ranked, stats } = result;
  const lines = [
    `语料转换工作单（扫描 ${stats.scanned} 篇 · 已覆盖 ${stats.alreadyCovered} 篇 · 达标 ${stats.eligible} 篇`
    + ` · 去重后 ${stats.unique ?? stats.eligible} 篇（合并 ${stats.duplicatesCollapsed ?? 0} 个副本）`
    + ` · 本次列 ${stats.returned} 篇，阈值 ${stats.minScore} 分）`,
    "",
    "这是**候选排序**，不是漏洞结论；每一篇都要人工/模型复核路径与判据后才落库。",
    "",
  ];
  if (ranked.length === 0) {
    lines.push("没有达标候选。可降低 minScore，或换一个更聚焦的 root（例如某个厂商子目录）。");
    return lines.join("\n");
  }
  for (const [index, item] of ranked.entries()) {
    lines.push(`${index + 1}. [${item.score} 分] ${item.file}`);
    const ids = [...(item.ids?.cve || []), ...(item.ids?.cnvd || []), ...(item.ids?.qvd || [])];
    if (ids.length > 0) lines.push(`   编号：${ids.slice(0, 4).join(" / ")}`);
    if (item.paths.length > 0) lines.push(`   路径：${item.paths.join("  ")}`);
    for (const reason of item.reasons.filter((r) => !r.startsWith("-100"))) lines.push(`   ${reason}`);
    if ((item.duplicates || []).length > 0) {
      lines.push(`   同一漏洞另有 ${item.duplicates.length} 份副本（已合并）：${item.duplicates.slice(0, 2).join("；")}`);
    }
    lines.push("   下一步：用 nday_draft 把这篇转成条目草案，人工确认路径与判据后再 nday_learn。");
  }
  lines.push("");
  lines.push(`（扫描根：${root}）`);
  lines.push("注意：`nday_draft` 的 documentPath 要的是**工作区相对路径**；"
    + "若扫描根不在工作区内，改用 text 把正文传进去（或用 knowledge_read 先取正文）。");
  return lines.join("\n");
}
