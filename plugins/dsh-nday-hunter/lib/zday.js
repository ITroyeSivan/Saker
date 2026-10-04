// Zero-day reasoning aid: match a feature/surface against a curated library of
// vulnerability patterns, and force every hypothesis to carry a falsifier.

import fs from "node:fs";

export function observedResearchInputs(context, requestId, revision) {
  if (!context || !Array.isArray(context.assets) || !Array.isArray(context.requests)) return [];
  return context.requests.filter(request => {
    if (requestId && request.id !== requestId) return false;
    if (revision && request.revision !== revision) return false;
    if (!['backend', 'api'].includes(request.kind) || request.valid !== true || !request.request?.trim() || !request.response?.trim()) return false;
    if (!Array.isArray(request.inputs) || !request.inputs.some(input => typeof input.name === 'string' && input.name.trim()
      && ['query', 'body', 'path', 'header'].includes(input.location) && input.evidenceIds?.includes(request.id))) return false;
    const status = Number(request.response.match(/^HTTP\/\S+\s+(\d{3})/i)?.[1]);
    if (!Number.isInteger(status) || status < 200 || status >= 300) return false;
    let url;
    try { url = new URL(request.endpoint) } catch { return false }
    return context.assets.some(asset => {
      try { return asset.inScope === true && asset.reachable === true && new URL(asset.url).origin === url.origin }
      catch { return false }
    });
  });
}

function clean(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function list(value) {
  return Array.isArray(value) ? value.map((item) => clean(item, 500)).filter(Boolean) : [];
}

export function loadZdayCatalog(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (raw?.schema !== "saker.zeroday.patterns/1" || !Array.isArray(raw.patterns)) {
    throw new Error(`invalid zero-day pattern catalog: ${file}`);
  }
  return raw;
}

function termsOf(pattern) {
  return list([
    pattern.id,
    pattern.title,
    pattern.category,
    ...(pattern.surfaces || []),
    ...(pattern.signals || []),
    pattern.hypothesis,
    ...(pattern.safeTests || []),
    ...(pattern.falsifyFirst || []),
    ...(pattern.impact ? [pattern.impact] : []),
  ]).map((item) => item.toLowerCase());
}

export function matchZdayPatterns(catalog, query, options = {}) {
  const text = clean(query, 1000).toLowerCase();
  const limit = Math.max(1, Math.min(Number(options.limit) || 5, 12));
  if (!text) return { exact: false, matches: [] };
  const scored = [];
  for (const pattern of catalog.patterns || []) {
    let score = 0;
    const title = clean(pattern.title).toLowerCase();
    const id = clean(pattern.id).toLowerCase();
    if (title.includes(text) || text.includes(title)) score += 8;
    if (id.includes(text) || text.includes(id)) score += 8;
    for (const surface of pattern.surfaces || []) {
      const value = clean(surface).toLowerCase();
      if (value && text.includes(value)) score += 5;
    }
    for (const signal of pattern.signals || []) {
      const value = clean(signal).toLowerCase();
      if (value && text.split(/[\s,;，。]+/).some((token) => token.length >= 2 && value.includes(token))) score += 2;
    }
    for (const term of termsOf(pattern)) {
      if (term.length >= 3 && text.includes(term)) score += 3;
    }
    if (score > 0) scored.push({ pattern, score });
  }
  scored.sort((a, b) => b.score - a.score || a.pattern.id.localeCompare(b.pattern.id));
  if (scored.length === 0) {
    return {
      exact: false,
      matches: (catalog.patterns || []).slice(0, limit).map((pattern) => ({ pattern, score: 0 })),
    };
  }
  return { exact: true, matches: scored.slice(0, limit) };
}

export function renderZdayHypotheses(query, result) {
  const lines = [
    `零日假设草稿：${clean(query, 200)}`,
    result.exact ? "匹配到本地功能缺陷模式。" : "本地模式库没有精确命中；以下是通用切入点，必须先补足本目标的信号再采信。",
    "",
    "口径：这些是**待证伪假设**，不是漏洞发现，也不是漏洞结论。",
  ];
  result.matches.forEach((item, index) => {
    const p = item.pattern;
    lines.push(
      `${index + 1}. ${p.title}（${p.id}）`,
      `   假设：${p.hypothesis}`,
      `   先想什么会推翻：${(p.falsifyFirst || []).join("；")}`,
      `   最小验证：${(p.safeTests || []).join("；")}`,
      `   升级链：${(p.chainWith || []).join(" → ") || "无"}`,
    );
  });
  lines.push("", "纪律：先验证最便宜、最可能推翻假设的观察；被证伪的假设也要落 fact_key，避免重复试。");
  return lines.join("\n");
}
