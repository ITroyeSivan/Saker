// Cross-plugin scope-first pipeline test: fake FOFA -> scoped asset ledger -> attack plan ->
// inventory-backed Nday match -> hand-off, without touching the internet.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// TEMP may be configured with the workspace-relative path required by AGENTS.md.
// Normalize the mkdtemp result before passing it both as a workspace and session cwd;
// relative cwd + relative workspace would otherwise resolve twice in tool adapters.
const temp = path.resolve(fs.mkdtempSync(path.join(os.tmpdir(), "saker-flow-")));
const workspace = path.join(temp, "workspace");
const home = path.join(temp, "home");
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(path.join(home, ".config", "nuclei", "templates", "weaver", "ecology"), { recursive: true });
fs.writeFileSync(path.join(home, ".config", "nuclei", "templates", "weaver", "ecology", "weaver-dubbo-debug.yaml"), "id: weaver-dubbo-debug\ninfo:\n  name: Weaver Dubbo Debug\n");

const oldHome = process.env.DSH_HOME;
const oldProfile = process.env.USERPROFILE;
const oldSaker = process.env.SAKER_ROOT;
process.env.DSH_HOME = home;
process.env.USERPROFILE = home;
process.env.SAKER_ROOT = ROOT;

const hunter = await import(pathToImport("../plugins/dsh-hunter/lib/index.js"));
const nday = await import(pathToImport("../plugins/dsh-nday-hunter/lib/index.js"));

function pathToImport(relative) {
  return new URL(relative, import.meta.url).href;
}

let pass = 0;
let fail = 0;
function ok(label, condition, detail = "") {
  if (condition) {
    pass += 1;
    console.log(`ok   ${label}`);
  } else {
    fail += 1;
    console.log(`FAIL ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

const tools = new Map();
const fakeCtx = {
  effect(fn) { fn(); return () => {}; },
  tools: {
    register(def) { tools.set(def.name, def); },
    async execute(call) {
      const def = tools.get(call.name);
      if (!def) throw new Error(`unknown test tool: ${call.name}`);
      return def.execute(call.arguments ?? {}, {
        agent: call.agent,
        signal: call.signal,
        rootCallId: call.rootCallId,
        token: call.parent,
      });
    },
  },
  settings: { get() { return {}; } },
  webServer: { register() {} },
  webRuntime: { trustedHosts: [] },
};
hunter.apply(fakeCtx);
nday.apply(fakeCtx);

const store = hunter.openHunterStore(path.join(home, "hunter", "hunter.db"));
store.setKey.run("fofa", "test-key", new Date().toISOString());
store.close();
const fixture = http.createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  if (path.startsWith("/papi/esearch/data/devops/dubboApi/debug/method")) {
    res.writeHead(req.method === "POST" ? 500 : 405, { "content-type": "text/plain" });
    res.end("error");
    return;
  }
  if (path === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<title>泛微 e-cology</title>");
    return;
  }
  // 未知路径必须 404：以前这里对任何路径都回 200 + 品牌页（软 404），
  // 于是「随机对照」会把它判成不具区分度——那正是本轮修掉的假命中形态。
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});
const port = await new Promise((resolve) => fixture.listen(0, "127.0.0.1", () => resolve(fixture.address().port)));
const target = `http://127.0.0.1:${port}`;
/** 批量场景里额外起的 4 台同指纹靶机；放外面是为了 finally 里能关掉。 */
let extra = [];

try {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      error: false,
      size: 1,
      results: [[target, "泛微 e-cology", "127.0.0.1", "example.test", String(port), "http", "nginx", "test", "", "", "2026-09-24 00:00:00"]],
    }),
  });
  let result;
  try {
    result = await tools.get("asset_search").execute({
      query: 'title:"泛微 e-cology"',
      scope: "127.0.0.1",
      workspace,
    });
  } finally {
    globalThis.fetch = oldFetch;
  }
  ok("asset_search 写入统一资产账本", result.ok && result.inScope === 1, JSON.stringify(result));
  const inventory = JSON.parse(fs.readFileSync(path.join(workspace, "asset-inventory.json"), "utf8"));
  ok("资产账本保留目标与来源", inventory.assets.length === 1 && inventory.assets[0].target === target && inventory.assets[0].sources.includes("fofa"), JSON.stringify(inventory));

  // ── Nday-first：绕过常规侦察，按比赛范围直接生成 FOFA 指纹查询 ──────────────
  // 这个跨插件测试必须走生产中的 nday_scope_hunt -> asset_search_batch ->
  // FOFA adapter -> candidate ledger -> nday_match(assetSource=nday-search) 链路。
  // 只 mock FOFA 响应；资产归一、范围约束、证据落盘和本地探针都是真实现。
  const providerQueries = [];
  const ndayFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const encoded = url.searchParams.get("qbase64");
    if (encoded) providerQueries.push(Buffer.from(encoded, "base64").toString("utf8"));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        error: false,
        size: 1,
        results: [[target, "泛微 e-cology", "127.0.0.1", "example.test", String(port), "http", "nginx", "test", "", "", "2026-09-24 00:00:00"]],
      }),
    };
  };
  let scoped;
  try {
    scoped = await tools.get("nday_scope_hunt").execute({
      scope: "127.0.0.1",
      workspace,
      entryIds: "weaver-ecology-dubboapi-debug-rce",
      limit: 1,
      size: 1,
    }, { agent: { session: { header: { cwd: workspace } } } });
  } finally {
    globalThis.fetch = ndayFetch;
  }
  ok("Nday-first 一次调用就生成并执行范围内 FOFA 查询", scoped?.ok === true && scoped.queryCount === 1 && scoped.candidateCount === 1,
    JSON.stringify({ ok: scoped?.ok, queryCount: scoped?.queryCount, candidateCount: scoped?.candidateCount }));
  ok("FOFA 请求同时含产品指纹与授权 IP 约束", providerQueries.length === 1
    && providerQueries[0].includes("ip==\"127.0.0.1\"")
    && /\b(?:app|title|body|header|icon_hash|fid)=/.test(providerQueries[0]),
  providerQueries.map((query) => query.replace(/key=[^&]+/g, "key=[redacted]")).join(" | "));
  ok("候选保存了 Nday 条目映射和可复用 searchId", scoped?.searchId
    && scoped.candidates?.[0]?.entryIds?.includes("weaver-ecology-dubboapi-debug-rce"));

  const searchedMatch = await tools.get("nday_match").execute({
    workspace,
    assetSource: "nday-search",
    searchId: scoped.searchId,
    scope: "127.0.0.1",
    entryIds: "weaver-ecology-dubboapi-debug-rce",
  });
  ok("Nday FOFA 候选可直接进入条目映射探针，不需要手抄目标", searchedMatch.ok
    && searchedMatch.summary.assets === 1
    && searchedMatch.rows.some((row) => row.asset === target), JSON.stringify({
      searchedMatch,
      scopedFile: scoped.file,
      scopedFileExists: fs.existsSync(path.join(workspace, scoped.file)),
      ndayDirectory: fs.existsSync(path.join(workspace, "artifacts", "nday"))
        ? fs.readdirSync(path.join(workspace, "artifacts", "nday")) : null,
    }));

  const inventoryBeforeCampaign = JSON.parse(fs.readFileSync(path.join(workspace, "asset-inventory.json"), "utf8")).assets.length;
  const campaignQueries = [];
  const oldCampaignFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    campaignQueries.push(Buffer.from(url.searchParams.get("qbase64"), "base64").toString("utf8"));
    return { ok: true, status: 200, text: async () => JSON.stringify({
      error: false, size: 1,
      results: [["", "市立医院管理平台", "203.0.113.44", "", "8443", "https", "nginx", "湘ICP备20260001号", "4134", "Example Hospital Network", "上海", "上海", "市立医院", "市立医院管理平台"]],
    }) };
  };
  let campaign;
  try {
    campaign = await tools.get("nday_scope_hunt").execute({
      workspace, identity: { icp: "湘ICP备20260001号" },
      entryIds: "weaver-ecology-dubboapi-debug-rce", limit: 1, size: 5,
    }, { agent: { session: { header: { cwd: workspace } } } });
  } finally { globalThis.fetch = oldCampaignFetch; }
  ok("机构 Nday 模式由 ICP 直接发起 FOFA 候选搜索", campaign?.ok === true && campaign.candidateOnly === true && campaign.candidateCount === 1, JSON.stringify(campaign));
  ok("FOFA 查询用精确 ICP 与目录 Nday 指纹组合", campaignQueries.length === 1 && campaignQueries[0].includes('icp=="湘ICP备20260001号"') && /(?:app|title|body|header|icon_hash|fid|product)=/.test(campaignQueries[0]), campaignQueries.join(" | "));
  ok("IP-only 搜索结果保留作被动候选且不进入活动资产账本", campaign.candidates?.[0]?.asset?.ip === "203.0.113.44" && !campaign.candidates[0].asset.domain && JSON.parse(fs.readFileSync(path.join(workspace, "asset-inventory.json"), "utf8")).assets.length === inventoryBeforeCampaign, JSON.stringify(campaign.candidates?.[0]));
  ok("IP-only 样例显示 IP:端口及 ICP/证书/网络归属线索", campaign.text.includes("203.0.113.44:8443") && campaign.text.includes("ICP=湘ICP备20260001号") && campaign.text.includes("证书组织=市立医院"), campaign.text);
  ok("只有被动候选时不建议调用 nday_match", campaign.candidateOnly && !campaign.text.includes("下一步：nday_match"));
  const noScope = await tools.get("nday_scope_hunt").execute({ workspace }, { agent: { session: { header: { cwd: workspace } } } });
  ok("缺范围和机构线索返回 scope_missing，不提问、不发 FOFA 请求", noScope.state === "scope_missing" && campaignQueries.length === 1);

  const plan = await tools.get("attack_plan").execute({ workspace, scope: "127.0.0.1" });
  ok("attack_plan 生成泛微桶", plan.ok && plan.plan.buckets.some((bucket) => bucket.entryId === "weaver-ecology-dubboapi-debug-rce"), JSON.stringify(plan));
  const bucket = plan.plan.buckets.find((item) => item.entryId === "weaver-ecology-dubboapi-debug-rce");
  ok("桶覆盖范围内账本资产且默认不建内部任务", bucket?.assetIds.length === 1 && plan.graph.registered === 0, JSON.stringify(plan.graph));

  const matched = await tools.get("nday_match").execute({
    workspace,
    assetSource: "inventory",
    scope: "127.0.0.1",
    entryIds: "weaver-ecology-dubboapi-debug-rce",
  });
  ok("nday_match 直接消费资产账本", matched.ok && matched.summary.assets === 1, JSON.stringify(matched.summary));
  ok("本地 fixture 命中为 fingerprint-weak", matched.rows.some((row) => row.verdict === "fingerprint-weak" && row.asset === target), JSON.stringify(matched.rows));

  const handoff = await tools.get("nday_handoff").execute({
    entryId: "weaver-ecology-dubboapi-debug-rce",
    asset: target,
    scope: "127.0.0.1",
    workspace,
  });
  ok("nday_handoff 使用本机模板库出计划", handoff.ok && handoff.templates >= 1 && handoff.nucleiCommand.includes("weaver-dubbo-debug.yaml"), JSON.stringify(handoff));
  ok("handoff 明确只出计划不执行", handoff.text.includes("只出计划"));
  ok("全链路产物齐备", ["asset-inventory.json", "assets.md", "fingerprint-buckets.json", "attack-plan.md", "evidence-index.md"].every((file) => fs.existsSync(path.join(workspace, file))));

  // ── 同一指纹的多资产批量验证（复用率的核心机制）────────────────────────────
  // P0-0 的战略判断是「收益函数是复用率，不是挖得深」：对手用一个 Nday 打穿一整类资产。
  // 上面那条只验了**单资产**；这里补上「一次命令扫一整个同指纹资产列表、并给出命中清单」。
  // 造 4 台同指纹靶机：2 台「有洞」（漏洞路径非 404），2 台「已打补丁」（漏洞路径 404）。
  // 期望：5 台全被扫（含原有 1 台），命中恰好 3 台，且命中清单里**不出现**那 2 台已修补的。
  extra = [];
  for (const vulnerable of [true, false, true, false]) {
    const server = http.createServer((req, res) => {
      const p = new URL(req.url ?? "/", "http://x").pathname;
      if (p.startsWith("/papi/esearch/data/devops/dubboApi/debug/method")) {
        if (!vulnerable) { res.writeHead(404, { "content-type": "text/plain" }); res.end("not found"); return; }
        res.writeHead(req.method === "POST" ? 500 : 405, { "content-type": "text/plain" });
        res.end("error");
        return;
      }
      if (p === "/") { res.writeHead(200, { "content-type": "text/html" }); res.end("<title>泛微 e-cology</title>"); return; }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
    const p = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
    extra.push({ server, vulnerable, target: `http://127.0.0.1:${p}`, port: p });
  }
  const inventoryFile = path.join(workspace, "asset-inventory.json");
  const base = JSON.parse(fs.readFileSync(inventoryFile, "utf8"));
  extra.forEach((item, index) => {
    base.assets.push({
      ...base.assets[0],
      id: `asset-batch-${index + 1}`,
      target: item.target,
      host: "127.0.0.1",
      port: item.port,
      sources: ["httpx"],
    });
  });
  fs.writeFileSync(inventoryFile, JSON.stringify(base, null, 2));

  const batch = await tools.get("nday_match").execute({
    workspace,
    assetSource: "inventory",
    scope: "127.0.0.1",
    entryIds: "weaver-ecology-dubboapi-debug-rce",
  });
  const expectedHits = [target, ...extra.filter((item) => item.vulnerable).map((item) => item.target)].sort();
  const hitAssets = [...new Set(batch.rows.map((row) => row.asset))].sort();
  ok("一次命令扫完整张资产列表（5 台全扫）", batch.ok && batch.summary.assets === 5, JSON.stringify(batch.summary));
  ok("命中数等于「有洞」的台数（3 台）", batch.summary.screenedHits === 3, JSON.stringify(batch.summary));
  ok("命中清单正好是那 3 台、且不含已修补的 2 台",
    JSON.stringify(hitAssets) === JSON.stringify(expectedHits),
    `hit=${JSON.stringify(hitAssets)} expected=${JSON.stringify(expectedHits)}`);
  ok("每台都做了随机对照（软 404 抑制有据可依）",
    batch.summary.controlRequests === 5 && batch.summary.transportErrors === 0,
    JSON.stringify(batch.summary));
} finally {
  for (const item of extra ?? []) await new Promise((resolve) => item.server.close(resolve));
  await new Promise((resolve) => fixture.close(resolve));
  try { hunter.closeSharedStore?.(); } catch { /* already closed */ }
  fs.rmSync(temp, { recursive: true, force: true });
  if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
  if (oldProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = oldProfile;
  if (oldSaker === undefined) delete process.env.SAKER_ROOT; else process.env.SAKER_ROOT = oldSaker;
}

console.log(fail === 0 ? `\nall ${pass} tests passed` : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
