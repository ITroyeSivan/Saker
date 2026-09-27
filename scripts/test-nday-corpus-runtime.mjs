// Nday 语料的**运行时**门禁：每一条自称可筛（normalized / verified）的条目，
// 在它自己声明的路径都真实存在时，必须能被真实匹配器 `nday_match` 命中。
//
// 为什么需要：`test-nday-catalog.mjs` 只证明「结构合法」。一条条目完全可能字段齐全、
// 探针也在，但探针**永远打不中**（expect 自相矛盾/不可能满足、字段写法匹配器消费不了、
// 匹配器链路本身坏了）——那种条目在结构门禁下全绿，实战时却是哑弹。
// 这里把「能筛」变成可证伪的断言，两个方向都测：
//   ① 正向：为每条可筛条目起一个**只满足它自己探针**的 fixture，必须命中；
//   ② 反向：一个「什么都不存在」（一律 404）的站点上，任何条目都不得命中。
//
// **这条门禁证明什么、不证明什么**：fixture 是**按条目自己的探针路径**搭出来的，
// 所以它证明的是「探针能被匹配器消费并产生命中」；它**不能**证明那条路径在真实产品上
// 真的存在——那属于复现（`verification.reproduced`），只有真环境能证。
//
// 全程只打 127.0.0.1，不发任何真实流量，也不投递任何利用载荷。
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG = path.join(ROOT, "preset", "pentest", "refs", "nday", "catalog.json");

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

const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8"));
const entries = Array.isArray(catalog.entries) ? catalog.entries : [];
const filterable = entries.filter((e) => e.status === "normalized" || e.status === "verified");

ok("语料非空且存在可筛条目", filterable.length > 0, `filterable=${filterable.length}`);
ok("每条可筛条目都声明了至少一个探针",
  filterable.every((e) => Array.isArray(e.fingerprint?.probes) && e.fingerprint.probes.length > 0));

const nday = await import(new URL("../plugins/dsh-nday-hunter/lib/index.js", import.meta.url).href);
const tools = new Map();
nday.apply({
  effect(fn) { fn(); return () => {}; },
  tools: { register(def) { tools.set(def.name, def); } },
  settings: { get() { return undefined; } },
});
const matchTool = tools.get("nday_match");
ok("nday_match 已注册", matchTool !== undefined);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "saker-nday-runtime-"));

/**
 * 为一条条目算出「满足它全部探针」的 fixture 路由表。
 * 同一路径上的多个探针会被合并：状态码取一个不被任何 statusNotIn 排除的值，
 * 响应体拼上所有 bodyContainsAny 的首选项。
 */
function fixtureFor(entry, { redirect = false } = {}) {
  const byPath = new Map();
  for (const probe of entry.fingerprint.probes) {
    const spec = byPath.get(probe.path)
      ?? { statusNotIn: [], statusIn: [], body: [], headers: {} };
    if (Array.isArray(probe.expect?.statusNotIn)) spec.statusNotIn.push(...probe.expect.statusNotIn);
    if (Array.isArray(probe.expect?.statusIn)) spec.statusIn.push(...probe.expect.statusIn);
    if (Array.isArray(probe.expect?.bodyContainsAny)) spec.body.push(...probe.expect.bodyContainsAny);
    if (Array.isArray(probe.expect?.headerContainsAny)) {
      for (const raw of probe.expect.headerContainsAny) {
        const at = String(raw).indexOf(":");
        if (at > 0) spec.headers[String(raw).slice(0, at).trim()] = String(raw).slice(at + 1).trim();
      }
    }
    byPath.set(probe.path, spec);
  }
  const routes = new Map();
  for (const [routePath, spec] of byPath) {
    const status = [500, 418, 200, 302, 403, 599, 204].find((code) =>
      !spec.statusNotIn.includes(code)
      && (spec.statusIn.length === 0 || spec.statusIn.includes(code))) ?? 500;
    const bodyText = spec.body.length > 0 ? `fixture ${spec.body.join(" ")}` : "fixture";
    // 判据里有非 ASCII 串（如金蝶 Apusic 的中文欢迎页标题）时，按**声明字符集**编码响应体。
    // 为什么必须：信创/国产系统大量返回 GBK，只按 UTF-8 解码的实现会让这类探针
    // 在真实目标上永远打不中（实测 GBK 靶子上命中数为 0）。这里用 utf-16le 是因为
    // Node 能原生编码它，不需要额外依赖就能把「按 charset 解码」这条路径钉住。
    const charset = spec.body.some((s) => /[^\x00-\x7F]/.test(String(s))) ? "utf-16le" : "";
    if (!redirect) {
      routes.set(routePath, {
        status,
        body: charset ? Buffer.from(bodyText, charset) : bodyText,
        charset,
        headers: spec.headers,
      });
      continue;
    }
    // 重定向模式：探针路径本身 301 到同主机的一个合成路径，真内容放在合成路径上。
    // 这样「跟随同主机重定向」这条路径对**每一条**可筛条目都被覆盖——
    // 内网/信创系统大量把 http:// 301 到 https:// 或把 / 跳到 /login，
    // 不跟随的话 body 类判据拿到的是空响应体（实测命中数会变成 0）。
    const targetPath = `${routePath}${routePath.includes("?") ? "&" : "?"}__redir=1`;
    routes.set(routePath, { status: 301, body: "", charset: "", headers: { location: targetPath } });
    routes.set(targetPath, {
      status,
      body: charset ? Buffer.from(bodyText, charset) : bodyText,
      charset,
      headers: spec.headers,
    });
  }
  return routes;
}

/** 起一个只在 127.0.0.1 上监听的路由服务器；未命中的路径一律 404。 */
async function serve(routes) {
  const server = http.createServer((req, res) => {
    // 路由键必须带上查询串：探针路径可以写 `/?mode=getconfig` 这类带参数的形态
    // （真实匹配器是 `base + path` 直接拼接，查询串本来就发得出去）。
    // 早期这里只按 pathname 查表，导致所有带 `?` 的探针在 fixture 上一律 404 ——
    // 那是**测试装置**的缺陷，不是条目缺陷。
    const url = new URL(req.url ?? "/", "http://fixture.invalid");
    const hit = routes.get(url.pathname + url.search);
    if (hit === undefined) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    res.writeHead(hit.status, {
      "content-type": hit.charset ? `text/html; charset=${hit.charset}` : "text/html",
      ...hit.headers,
    }).end(hit.body);
  });
  const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  return { server, port };
}

/** 起一个**软 404**服务器：任何路径都 200 + 同一张通用页（SPA / 统一错误页 / WAF 挑战页）。 */
async function serveSoft404() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><html><title>Welcome</title><body>Please login to continue</body></html>");
  });
  const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  return { server, port };
}

try {
  // ① 正向：每条可筛条目在「自己的路径都在」的站点上必须命中
  for (const entry of filterable) {
    const { server, port } = await serve(fixtureFor(entry));
    try {
      const out = await matchTool.execute({
        targets: `http://127.0.0.1:${port}`,
        scope: "127.0.0.1",
        workspace: temp,
        entryIds: entry.id,
      });
      const row = (out.rows ?? []).find((r) => String(r.asset).includes(String(port)));
      ok(`[${entry.id}] 探针在路径存在时可命中`, out.ok === true && row !== undefined,
        out.error ?? JSON.stringify(out.rows ?? []));
      ok(`[${entry.id}] 命中给出结论强度与下一步`,
        typeof row?.verdict === "string" && row.verdict.startsWith("fingerprint-")
        && typeof row?.nextStep === "string" && row.nextStep.length > 0,
        JSON.stringify(row ?? {}));
      // 逐条探针断言：只要求「条目命中」是不够的——一条死探针会被同条目里
      // 其它活探针盖住，条目照样命中、门禁照样全绿。这里要求**每个探针自己**
      // 都在证据列表里出现，死探针才藏不住。
      const fired = new Set((row?.evidence ?? []).map((h) => h.probeId));
      const dead = entry.fingerprint.probes.filter((p) => !fired.has(p.id)).map((p) => p.id);
      ok(`[${entry.id}] 每个探针都能单独命中`, dead.length === 0, `未命中探针: ${dead.join(", ")}`);
    } finally {
      server.close();
    }
  }

  // ② 反向：一律 404 的站点上，任何可筛条目都不得命中（防"什么都能中"的假绿）
  {
    const { server, port } = await serve(new Map());
    try {
      const offenders = [];
      for (const entry of filterable) {
        const out = await matchTool.execute({
          targets: `http://127.0.0.1:${port}`,
          scope: "127.0.0.1",
          workspace: temp,
          entryIds: entry.id,
        });
        if ((out.rows ?? []).some((r) => String(r.asset).includes(String(port)))) offenders.push(entry.id);
      }
      ok("404 站点上没有任何条目命中", offenders.length === 0, offenders.join(", "));
    } finally {
      server.close();
    }
  }

  // ③ 重定向：每条可筛条目的探针路径都 301 到**同主机**的另一路径，探针必须跟随并命中。
  //    内网/信创系统大量把 http:// 301 到 https://、把 / 跳到 /login；
  //    不跟随的话 body 类判据拿到的是空响应体（实测命中数会变成 0）。
  for (const entry of filterable) {
    const { server, port } = await serve(fixtureFor(entry, { redirect: true }));
    try {
      const out = await matchTool.execute({
        targets: `http://127.0.0.1:${port}`,
        scope: "127.0.0.1",
        workspace: temp,
        entryIds: entry.id,
      });
      const row = (out.rows ?? []).find((r) => String(r.asset).includes(String(port)));
      ok(`[${entry.id}] 同主机重定向后仍能命中`, out.ok === true && row !== undefined,
        out.error ?? JSON.stringify(out.rows ?? []));
      const fired = new Set((row?.evidence ?? []).map((h) => h.probeId));
      const dead = entry.fingerprint.probes.filter((p) => !fired.has(p.id)).map((p) => p.id);
      ok(`[${entry.id}] 重定向后每个探针都能单独命中`, dead.length === 0, `未命中探针: ${dead.join(", ")}`);
    } finally {
      server.close();
    }
  }

  // ④ 软 404：任何路径都 200 + 同一张通用页。语料里 53/63 条探针只看状态码，
  //    没有「随机不存在路径」做对照的话，一台这种目标能让**整库假命中**
  //    （实测：修之前 3/3 条目全部"命中"）。这里断言一条都不许命中。
  {
    const { server, port } = await serveSoft404();
    try {
      const offenders = [];
      for (const entry of filterable) {
        const out = await matchTool.execute({
          targets: `http://127.0.0.1:${port}`,
          scope: "127.0.0.1",
          workspace: temp,
          entryIds: entry.id,
        });
        if ((out.rows ?? []).some((r) => String(r.asset).includes(String(port)))) offenders.push(entry.id);
      }
      ok("软 404 站点上没有任何条目命中（随机对照生效）", offenders.length === 0, offenders.join(", "));
    } finally {
      server.close();
    }
  }
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log(fail === 0 ? `\nall ${pass} tests passed` : `\n${fail} FAILED, ${pass} passed`);
process.exit(fail ? 1 : 0);
