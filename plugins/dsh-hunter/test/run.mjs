// dsh-hunter 离线单测：DSL 解析与平台转换 / 去重合并 / 指纹节解析 / L0 指纹匹配 /
// L1 授权验证 / 流水线（mock 搜索与探测）/ 放宽寻源阶梯 / 配置视图与存储。
import assert from "node:assert";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDsl, buildQueries, mergeAssets, fofaGuard, LIMITS, searchFofaPage } from "../lib/adapters.js";
import { parseFingerprint, fingerprintQuery, fingerprintLadder, searchWithRelax, fingerprintMatches, verifyPipeline } from "../lib/verify.js";
import { openHunterStore, configView, getKey } from "../lib/store.js";

const TEST_HOME = mkdtempSync(join(tmpdir(), "hunter-test-home-"));
process.env.DSH_HOME = TEST_HOME;
const { isTrustedRequest, checkCsrf, buildFindingPatch, apply, closeSharedStore, dispatch } = await import("../lib/index.js");

let pass = 0, fail = 0;
// 异步用例必须等待完成后再计数，否则断言未执行就被进程退出（假绿）。
async function ok(name, fn) {
	try { await fn(); pass++; console.log("ok   " + name); }
	catch (e) { fail++; console.log("FAIL " + name + "\n     " + (e?.message ?? e)); }
}

// 1. DSL 解析
await ok("dsl 解析多字段", () => {
	const f = parseDsl('title:"login page" body:xxl-job port:8080 protocol:"http"');
	assert.equal(f.get("title"), "login page");
	assert.equal(f.get("body"), "xxl-job");
	assert.equal(f.get("port"), "8080");
	assert.equal(f.get("protocol"), "http");
});
await ok("dsl 未知字段抛错", () => {
	assert.throws(() => parseDsl('foo:"bar"'), /未知字段/);
});
await ok("dsl 空输入抛错", () => {
	assert.throws(() => parseDsl("   "), /查询为空/);
});
await ok("dsl 无解析片段抛错", () => {
	assert.throws(() => parseDsl("hello world"), /未识别到任何/);
});

// 2. 平台转换
await ok("转换：FOFA/Hunter/Quake 语法差异", () => {
	const q = buildQueries('title:"login" app:"Nginx" port:8080', "dsl");
	assert.ok(q.fofa.includes('title="login"') && q.fofa.includes('app="Nginx"') && q.fofa.includes(" && "));
	assert.ok(q.hunter.includes('web.title="login"') && q.hunter.includes('app.name="Nginx"') && q.hunter.includes('ip.port="8080"'));
	assert.ok(q.quake.includes('title:"login"') && q.quake.includes('app:"Nginx"') && q.quake.includes('port:"8080"'));
});
await ok("转换：native 模式直贴", () => {
	const q = buildQueries('title="x" && port="80"', "native");
	assert.equal(q.fofa, 'title="x" && port="80"');
	assert.equal(q.hunter, 'title="x" && port="80"');
});
await ok("FOFA ICP/域名精确匹配，机构指纹不误发到其他平台", () => {
	const q = buildQueries('icp:"湘ICP备20260001号" domain:"hospital.example" host:"oa.hospital.example" asn:4134 city:"上海" region:"上海" title:"市立医院" cert.subject.org:"市立医院"', "dsl");
	assert.ok(q.fofa.includes('icp=="湘ICP备20260001号"'), q.fofa);
	assert.ok(q.fofa.includes('domain=="hospital.example"'), q.fofa);
	assert.ok(q.fofa.includes('host=="oa.hospital.example"') && q.fofa.includes('asn=="4134"'), q.fofa);
	assert.ok(q.fofa.includes('city="上海"') && q.fofa.includes('region="上海"'), q.fofa);
	assert.ok(q.fofa.includes('title="市立医院"') && q.fofa.includes('cert.subject.org="市立医院"'), q.fofa);
	assert.equal(q.hunter, "");
	assert.equal(q.quake, "");
	const cidr = buildQueries('ip:"203.0.113.0/24"', "dsl");
	assert.ok(cidr.fofa.includes('ip="203.0.113.0/24"'), cidr.fofa);
});
await ok("蜜罐过滤附加", () => {
	assert.ok(fofaGuard('app="Nginx"').includes("is_honeypot=false"));
});
await ok("限额常量", () => {
	assert.equal(LIMITS.fofa.freeExport, 10000);
	assert.ok(LIMITS.fofa.nextSize >= 1000);
	assert.equal(LIMITS.hunter.pageSize, 100);
});

// 3. 去重合并
await ok("merge：ip:port 去重，冲突取时间新者", () => {
	const a = [{ ip: "1.1.1.1", port: "80", title: "旧标题", time: "2025-01-01", platform: "fofa" }];
	const b = [{ ip: "1.1.1.1", port: "80", title: "新标题", time: "2025-06-01", platform: "hunter" }];
	const m = mergeAssets(a, b);
	assert.equal(m.length, 1);
	assert.equal(m[0].title, "新标题");
	assert.deepEqual(m[0].platforms, ["fofa", "hunter"]);
});

// 4. 指纹节解析
await ok("指纹节与 L1 验证节解析", () => {
	const fp = parseFingerprint(`指纹:framework=xxl-job,version=2.4.0,title="任务调度中心",body="XXL-JOB"\nL1验证:GET /toLogin 期望:任务调度中心`);
	assert.equal(fp.fields.get("framework"), "xxl-job");
	assert.equal(fp.fields.get("title"), "任务调度中心");
	assert.equal(fp.l1.method, "GET");
	assert.equal(fp.l1.path, "/toLogin");
	assert.equal(fp.l1.expect, "任务调度中心");
});
await ok("无指纹节返回空字段", () => {
	const fp = parseFingerprint("普通 poc 文本");
	assert.equal(fp.fields.size, 0);
	assert.equal(fp.l1, null);
});
await ok("指纹生成查询（title/body 特征）", () => {
	const fp = parseFingerprint('指纹:title="任务调度中心",body="XXL-JOB"');
	assert.equal(fingerprintQuery(fp), 'title:"任务调度中心" body:"XXL-JOB"');
});
await ok("指纹仅 framework 时兜底 app 查询", () => {
	const fp = parseFingerprint("指纹:framework=xxl-job");
	assert.equal(fingerprintQuery(fp), 'app:"xxl-job"');
});

// 5. L0 指纹匹配
await ok("L0：title 特征命中", () => {
	const fp = parseFingerprint('指纹:title="任务调度中心"');
	const probe = { title: "任务调度中心 v2.4", bodyPrefix: "", server: "" };
	assert.deepEqual(fingerprintMatches(probe, fp), { match: true, kind: "title", value: "任务调度中心" });
});
await ok("L0：body 特征命中", () => {
	const fp = parseFingerprint('指纹:body="XXL-JOB"');
	const probe = { title: "", bodyPrefix: "<html>XXL-JOB admin</html>", server: "" };
	assert.equal(fingerprintMatches(probe, fp).match, true);
});
await ok("L0：特征均未命中", () => {
	const fp = parseFingerprint('指纹:title="任务调度中心"');
	const probe = { title: "别的系统", bodyPrefix: "", server: "" };
	assert.equal(fingerprintMatches(probe, fp).match, false);
});

// 6. 流水线（mock 搜索 + 假探测：用 stopOnFirstL0=false 统计，验证分级与停止）
const makeAsset = (ip, port, title) => ({ ip, port, title, protocol: "http", platform: "fofa", host: ip });
await ok("流水线：无资产 → no-assets + 建议", async () => {
	const r = await verifyPipeline(async () => [], async () => new Set(), { fingerprint: parseFingerprint('指纹:title="x"') });
	assert.equal(r.verdict, "no-assets");
	assert.ok(r.suggestions.length >= 3);
});
await ok("流水线：L0 成立未授权 → 建议含渗透模式交接路径（不做死路拒绝）", async () => {
	const http = await import("node:http");
	const server = http.createServer((req, res) => { res.end("<html><head><title>调度中心</title></head></html>"); });
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const assets = [makeAsset("127.0.0.1", String(server.address().port))];
	const r = await verifyPipeline(async () => assets, async () => new Set(), { fingerprint: parseFingerprint('指纹:title="调度中心"'), budget: 1 });
	assert.equal(r.verdict, "l0-confirmed");
	assert.ok(r.suggestions.some((s) => s.includes("渗透测试模式")), "建议须含渗透模式路径");
	assert.ok(r.suggestions.some((s) => s.includes("标记授权")), "建议须保留标记授权快验路径");
	await new Promise((r2) => server.close(r2));
});
await ok("流水线：搜索抛错 → search-error", async () => {
	const r = await verifyPipeline(async () => { throw new Error("401: key invalid"); }, async () => new Set(), { fingerprint: parseFingerprint('指纹:title="x"') });
	assert.equal(r.verdict, "search-error");
	assert.ok(r.detail.includes("401"));
});
await ok("流水线：L0 成立（真实探测 localhost HTTP）", async () => {
	// 本地起一个 HTTP 服务充当“存活且指纹一致”的资产（真实探测路径）
	const http = await import("node:http");
	const server = http.createServer((req, res) => {
		res.setHeader("server", "test-srv");
		res.end("<html><head><title>任务调度中心</title></head><body>XXL-JOB</body></html>");
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const port = server.address().port;
	const fp = parseFingerprint('指纹:title="任务调度中心"');
	const assets = [makeAsset("127.0.0.1", String(port)), makeAsset("10.0.0.9", "80")];
	const r = await verifyPipeline(async () => assets, async () => new Set(), { fingerprint: fp, budget: 2 });
	assert.equal(r.verdict, "l0-confirmed");
	assert.equal(r.detail.l0Hits, 1);
	assert.ok(r.detail.firstL0.title.includes("任务调度中心"));
	await new Promise((r2) => server.close(r2));
});
await ok("流水线：授权资产 L1 通过 → l1-passed 且立即停", async () => {
	const http = await import("node:http");
	const server = http.createServer((req, res) => {
		res.setHeader("server", "s");
		if (req.url.startsWith("/toLogin")) { res.end("任务调度中心 VERIFY_7f3a9c"); return; }
		res.end("<html><head><title>任务调度中心</title></head><body>x</body></html>");
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const port = server.address().port;
	const fp = parseFingerprint('指纹:title="任务调度中心"\nL1验证:GET /toLogin 期望:VERIFY_7f3a9c');
	const assets = [makeAsset("127.0.0.1", String(port)), makeAsset("127.0.0.1", String(port))];
	const authorized = new Set([`127.0.0.1:${port}`]);
	const r = await verifyPipeline(async () => assets, async () => authorized, { fingerprint: fp, budget: 2 });
	assert.equal(r.verdict, "l1-passed");
	assert.equal(r.detail.l1Passed, 1);
	assert.ok(r.detail.stoppedEarly);
	await new Promise((r2) => server.close(r2));
});
await ok("FOFA 高级产品/版本/哈希字段可用，非 FOFA 平台不退化成宽查询", () => {
	const q = buildQueries('product.version:"7.0.4.9" icon_hash:"-692947551"', "dsl");
	assert.ok(q.fofa.includes('product.version="7.0.4.9"') && q.fofa.includes('icon_hash="-692947551"'));
	assert.equal(q.hunter, "");
	assert.equal(q.quake, "");
});
await ok("FOFA 官方 fid/category 字段可用，错误别名拒绝且不向其他平台降级", () => {
	const q = buildQueries('fid:"iaytNA57019/kADk8Nev7g==" category:"服务"', "dsl");
	assert.ok(q.fofa.includes('fid="iaytNA57019/kADk8Nev7g=="') && q.fofa.includes('category="服务"'));
	assert.equal(q.hunter, "");
	assert.equal(q.quake, "");
	assert.throws(() => parseDsl('product_category:"服务"'), /未知字段/);
});
await ok("FOFA banner/JARM/证书/TLS/状态码指纹可用且不被其他平台静默降级", () => {
	const q = buildQueries('banner:"TongWeb" jarm:"abc123" cert.issuer.org:"TongTech" tls.ja3s:"deadbeef" status_code:200', "dsl");
	assert.ok(q.fofa.includes('banner="TongWeb"') && q.fofa.includes('jarm="abc123"'));
	assert.ok(q.fofa.includes('cert.issuer.org="TongTech"') && q.fofa.includes('tls.ja3s="deadbeef"'));
	assert.ok(q.fofa.includes('status_code="200"'));
	assert.equal(q.hunter, "");
	assert.equal(q.quake, "");
});
await ok("FOFA 默认字段集不要求专业版 lastupdatetime", async () => {
	const oldFetch = globalThis.fetch;
	let requestedUrl = "";
	globalThis.fetch = async (url) => {
		requestedUrl = String(url);
		return { ok: true, status: 200, text: async () => JSON.stringify({ error: false, results: [] }) };
	};
	try {
		await searchFofaPage("test-key", 'app="Tomcat"', 10);
		const fields = new URL(requestedUrl).searchParams.get("fields");
		assert.equal(fields, "host,title,ip,domain,port,protocol,server,icp,asn,org,city,region,cert.subject.org,cert.subject.cn");
		assert.ok(!fields.includes("lastupdatetime"));
	} finally {
		globalThis.fetch = oldFetch;
	}
});

await ok("实测回写：L1 通过必须带二次评级与足量依据", () => {
	const patch = buildFindingPatch(
		{ severity: "high", evidence: "scan-reconcile.md#1" },
		{ verdict: "l1-passed", summary: "授权资产 L1 marker 回显成功", detail: { l0Hits: 1, l1Passed: 1 } },
	);
	assert.equal(patch.status, "verified");
	assert.equal(patch.secondRating, "high");
	assert.ok(String(patch.secondRatingNote).length >= 40, "二次复核依据必须至少 40 字");
	assert.equal(patch.auditMode, "dynamic");
});
await ok("流水线：未授权资产不做 L1（L0 成立但 L1=0）", async () => {
	const http = await import("node:http");
	const server = http.createServer((req, res) => {
		res.setHeader("server", "s");
		if (req.url.startsWith("/toLogin")) { res.end("VERIFY_7f3a9c"); return; }
		res.end("<html><head><title>任务调度中心</title></head></html>");
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const port = server.address().port;
	const fp = parseFingerprint('指纹:title="任务调度中心"\nL1验证:GET /toLogin 期望:VERIFY_7f3a9c');
	const r = await verifyPipeline(async () => [makeAsset("127.0.0.1", String(port))], async () => new Set(), { fingerprint: fp, budget: 1 });
	assert.equal(r.verdict, "l0-confirmed");
	assert.equal(r.detail.l1Passed, 0, "未授权资产绝不执行 L1");
	await new Promise((r2) => server.close(r2));
});
await ok("流水线：全部不匹配 → l0-none + 检查建议", async () => {
	const http = await import("node:http");
	const server = http.createServer((req, res) => { res.end("<html><title>别的系统</title></html>"); });
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const port = server.address().port;
	const fp = parseFingerprint('指纹:title="任务调度中心"');
	const r = await verifyPipeline(async () => [makeAsset("127.0.0.1", String(port))], async () => new Set(), { fingerprint: fp, budget: 1 });
	assert.equal(r.verdict, "l0-none");
	assert.ok(r.suggestions.length >= 3);
	await new Promise((r2) => server.close(r2));
});

// 7. hunter store
await ok("hunter store：配置视图不回传完整 key", () => {
	const st = openHunterStore(":memory:");
	st.setKey.run("fofa", "abcdef1234567890", "2026-01-01T00:00:00.000Z");
	const view = configView(st);
	assert.equal(view.fofa.configured, true);
	assert.equal(view.fofa.tail, "…7890");
	assert.ok(!JSON.stringify(view).includes("abcdef1234567890"));
	assert.equal(getKey(st, "fofa"), "abcdef1234567890", "插件内部可读完整 key");
	st.close();
});
await ok("hunter client：主设置页提供三平台 key 配置入口且不回显完整值", () => {
	const src = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
	assert.match(src, /id: "hunter-api-platforms"/);
	assert.match(src, /label: function \(\) \{ return "资产平台 API"; \}/);
	assert.match(src, /type: "password"/);
	assert.match(src, /api\("config\.set"/);
	assert.ok(!/(?:fofa|hunter|quake)[^\n]{0,50}["'][A-Za-z0-9_-]{24,}["']/i.test(src), "客户端不应硬编码长 API key");
});
	await ok("hunter store：历史与授权白名单", () => {
		const st = openHunterStore(":memory:");
		st.insertHistory.run("2026-01-01T00:00:00Z", "code-audit-1", "code-audit", 'title:"x"', "fofa,hunter", "l0-confirmed", "{}");
		assert.equal(st.listHistory.all(10).length, 1);
		st.authorize.run("1.2.3.4:80", "测试资产", "2026-01-01T00:00:00Z");
		assert.equal(st.listAuthorized.all().length, 1);
		st.unauthorize.run("1.2.3.4:80");
		assert.equal(st.listAuthorized.all().length, 0);
		st.close();
	});

	await ok("SRC 范围策略 RPC 已移除，资产授权功能仍可用", async () => {
		const st = openHunterStore(":memory:");
		try {
			for (const endpoint of ["scope.list", "scope.bulkAdd", "scope.program.list", "scope.program.upsert", "scope.program.expand", "scope.target.setStatus"])
				await assert.rejects(dispatch(null, st, endpoint, {}), /unknown endpoint/);
			assert.equal((await dispatch(null, st, "authorized.list", {})).ok, true);
		} finally { st.close(); }
	});

// 7. 互联网侧寻源（放宽阶梯）
await ok("阶梯：全特征有序且框架兜底在末", () => {
	const l = fingerprintLadder(parseFingerprint('指纹:framework=xxl-job,title="任务调度中心",body="XXL-JOB",header="xxl"'));
	assert.equal(l.length, 5);
	assert.equal(l[0].label, "特征组合");
	assert.equal(l[0].query, 'title:"任务调度中心" body:"XXL-JOB" header:"xxl"');
	assert.equal(l[4].label, "框架名兜底");
	assert.equal(l[4].query, 'app:"xxl-job"');
});
await ok("阶梯：单一特征不出重复级", () => {
	const l = fingerprintLadder(parseFingerprint('指纹:title="abc"'));
	assert.equal(l.length, 1);
	assert.equal(l[0].query, 'title:"abc"');
});
await ok("放宽寻源：主查询零命中→放宽级命中并衔接", async () => {
	const calls = [];
	const r = await searchWithRelax(
		async (q) => { calls.push(q); return q === 'title:"调度中心"' ? [] : [makeAsset("1.2.3.4", "80", "x")]; },
		fingerprintLadder(parseFingerprint('指纹:framework=xxl-job,title="调度中心"'))
	);
	assert.equal(r.assets.length, 1);
	assert.equal(r.hit.label, "框架名兜底");
	assert.equal(calls.length, 2);
});
await ok("放宽寻源：全部零命中→空+null（衔接 no-assets 建议）", async () => {
	const r = await searchWithRelax(async () => [], fingerprintLadder(parseFingerprint('指纹:title="x"')));
	assert.equal(r.assets.length, 0);
	assert.equal(r.hit, null);
});


// 信任栅栏：端口比对（本机他端口 Origin 拒）
{
	const mk = (h) => ({ headers: h });
	await ok("栅栏：loopback 放行、外域拒、本机他端口 Origin 拒", () => {
		assert.equal(isTrustedRequest(mk({ host: "127.0.0.1:3080" }), []), true);
		assert.equal(isTrustedRequest(mk({ host: "evil.com:3080" }), []), false);
		assert.equal(isTrustedRequest(mk({ host: "127.0.0.1:3080", origin: "http://127.0.0.1:9999" }), []), false, "本机他端口 Origin 拒（端口比对）");
		assert.equal(isTrustedRequest(mk({ host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" }), []), true);
	});
}
await ok("CSRF 头校验：匹配放行/缺失或错值拒", () => {
	assert.equal(checkCsrf({ headers: { "x-dsh-csrf": "T" } }, "T"), true);
	assert.equal(checkCsrf({ headers: { "x-dsh-csrf": "X" } }, "T"), false);
	assert.equal(checkCsrf({}, "T"), false);
});

// ── 库损坏自愈（2026-09-13 夜：与另外 5 个插件同类的孪生 bug）────────────────
// 背景：`new DatabaseSync` 遇到坏文件直接抛 `file is not a database`，
// 而 hunter 的**全部功能**（key / 历史 / 授权白名单）都挂在这个库上 —— 一抛全废。
// 磁盘满、强杀、网盘回写、误改名都会造成这种文件。
{
	const { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");

	const dir = mkdtempSync(join(tmpdir(), "hunter-heal-"));
	const dbPath = join(dir, "hunter.db");

	await ok("坏库（垃圾字节）不抛异常，且功能可用", () => {
		writeFileSync(dbPath, Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x7f, 0x00, 0x42]));
		const st = openHunterStore(dbPath);            // 修复前：这里抛 file is not a database
		st.setKey.run("fofa", "cipher-x", new Date().toISOString());
		assert.equal(configView(st).fofa.configured, true, "自愈后应能正常读写");
		st.close();
	});

	await ok("坏库被改名备份（原文件不丢，可人工找回）", () => {
		const backups = readdirSync(dir).filter((f) => f.includes(".corrupt-"));
		assert.equal(backups.length, 1, `应恰好有 1 个备份，实际 ${backups.length}`);
	});

	await ok("备份内容就是原始垃圾字节（没被覆盖或清空）", () => {
		const bak = readdirSync(dir).find((f) => f.includes(".corrupt-"));
		const bytes = readFileSync(join(dir, bak));
		assert.equal(bytes.length, 8, "备份应与原文件等长");
		assert.equal(bytes[3], 0xff, "字节内容应原样保留");
	});

	await ok("正常库不会被误判为坏库（幂等）", () => {
		const st = openHunterStore(dbPath);            // 第二次打开：库头已是 SQLite
		assert.equal(configView(st).fofa.configured, true, "数据应还在");
		st.close();
		const backups = readdirSync(dir).filter((f) => f.includes(".corrupt-"));
		assert.equal(backups.length, 1, "不应新增备份");
	});

	await ok(":memory: 不走自愈路径（不报错）", () => {
		const st = openHunterStore(":memory:");
		assert.equal(configView(st).hunter.configured, false);
		st.close();
	});

	rmSync(dir, { recursive: true, force: true });
}

// ── 8. 资产搜索模型工具：接入统一资产账本 ─────────────────────────────────────
{
	const tools = new Map();
	apply({
		effect(fn) { fn(); return () => {}; },
		webServer: { register() {} },
		webRuntime: { trustedHosts: [] },
		tools: { register(def) { tools.set(def.name, def); } },
	});

	await ok("asset_search 注册为模型工具", () => {
		assert.ok(tools.has("asset_search"));
	});
	await ok("SRC 范围模型工具已移除", () => {
		assert.ok(!tools.has("scope_program_list"));
		assert.ok(!tools.has("scope_program_get"));
		assert.ok(!tools.has("scope_program_expand"));
	});

	await ok("asset_search_batch 数组项用宿主支持的字段级必填并保留 Nday 映射", () => {
		const itemSchema = tools.get("asset_search_batch").parameters.queries.items;
		assert.equal(itemSchema.required, undefined);
		assert.equal(itemSchema.properties.id.required, true);
		assert.equal(itemSchema.properties.query.required, true);
		assert.equal(itemSchema.properties.basis.type, "string");
		assert.equal(itemSchema.properties.entryIds.items.type, "string");
	});

	await ok("FOFA candidate batch 保持只读候选且不写入资产账本", async () => {
		const st = openHunterStore(join(TEST_HOME, "hunter", "hunter.db"));
		st.setKey.run("fofa", "test-key", new Date().toISOString());
		st.close();
		const oldFetch = globalThis.fetch;
		const workspace = mkdtempSync(join(process.env.TEMP || process.env.TMP || process.cwd(), "hunter-candidate-"));
		try {
			globalThis.fetch = async (url) => {
				const q = Buffer.from(new URL(String(url)).searchParams.get("qbase64"), "base64").toString("utf8");
				assert.ok(q.includes('icp=="湘ICP备20260001号"') && q.includes('title="市立医院"'), q);
				return { ok: true, status: 200, text: async () => JSON.stringify({ error: false, size: 1, results: [["203.0.113.9:8443", "市立医院管理平台", "203.0.113.9", "", "8443", "https", "nginx"]] }) };
			};
			const out = await tools.get("asset_candidate_search_batch").execute({
				queries: [{ id: "org-rce", query: 'icp:"湘ICP备20260001号" title:"市立医院" app:"Example-Portal"', identityType: "icp+title" }],
				workspace, size: 5,
			});
			assert.equal(out.ok, true, JSON.stringify(out));
			assert.equal(out.candidateOnly, true);
			assert.equal(out.assetCount, 1);
			assert.equal(existsSync(join(workspace, "asset-inventory.json")), false);
			assert.ok(existsSync(join(workspace, out.rawFile)));
		} finally {
			globalThis.fetch = oldFetch;
			rmSync(workspace, { recursive: true, force: true });
			const cleanupStore = openHunterStore(join(TEST_HOME, "hunter", "hunter.db"));
			cleanupStore.setKey.run("fofa", "", new Date().toISOString());
			cleanupStore.close();
		}
	});
	await ok("asset search 工具描述要求显式授权子域通配符", () => {
		assert.match(tools.get("asset_search").parameters.scope.description, /bare domain.*(?:exact|only itself).*\*\.example\.com/i);
		assert.match(tools.get("asset_search_batch").parameters.scope.description, /bare domain.*(?:exact|itself).*\*\.example\.com/i);
	});

	await ok("asset_search 未配置平台时明确降级，不返回空成功", async () => {
		const out = await tools.get("asset_search").execute({
			query: 'domain:"example.com"',
			scope: "example.com",
			workspace: TEST_HOME,
		});
		assert.equal(out.ok, false);
		assert.equal(out.degraded, true);
		assert.ok(out.next.join(" ").includes("subfinder_enum"));
	});

	await ok("asset_search 所有配置平台失败时不伪报零资产成功", async () => {
		const st = openHunterStore(join(TEST_HOME, "hunter", "hunter.db"));
		st.setKey.run("fofa", "test-key", new Date().toISOString());
		st.close();
		const oldFetch = globalThis.fetch;
		globalThis.fetch = async () => ({
			ok: true, status: 200,
			text: async () => JSON.stringify({ error: true, errmsg: "invalid key" }),
		});
		try {
			const out = await tools.get("asset_search").execute({
				query: 'app:"Tomcat"', scope: "example.com", workspace: TEST_HOME,
			});
			assert.equal(out.ok, false);
			assert.match(out.error, /所有已配置平台搜索失败/);
			assert.match(out.error, /fofa=.*invalid key/);
		} finally {
			globalThis.fetch = oldFetch;
		}
	});

	await ok("asset_search 按 scope 过滤并写入资产账本", async () => {
		const st = openHunterStore(join(TEST_HOME, "hunter", "hunter.db"));
		st.setKey.run("fofa", "test-key", new Date().toISOString());
		st.close();
		const oldFetch = globalThis.fetch;
		const requestedUrls = [];
		const workspace = mkdtempSync(join(tmpdir(), "hunter-assets-"));
		try {
			globalThis.fetch = async (url) => {
				requestedUrls.push(String(url));
				return {
					ok: true,
					status: 200,
					text: async () => JSON.stringify({
						error: false,
						size: 3,
						results: [
							["https://oa.example.com", "Portal", "203.0.113.10", "example.com", "443", "https", "nginx"],
							["https://evil.example.net", "Other", "198.51.100.9", "example.net", "443", "https", "nginx"],
							["https://shared.example.net", "Shared", "203.0.113.77", "example.net", "443", "https", "nginx"],
						],
					}),
				};
			};
			const out = await tools.get("asset_search").execute({
				query: 'domain:"example.com"',
				scope: "*.example.com",
				workspace,
			});
			assert.equal(out.ok, true, JSON.stringify(out));
			assert.equal(out.inScope, 1);
			assert.equal(out.outOfScope, 2);
			assert.equal(out.inventoryTotal, 1);
			const inventory = JSON.parse(readFileSync(join(workspace, "asset-inventory.json"), "utf8"));
			assert.equal(inventory.assets.length, 1);
			assert.equal(inventory.assets[0].host, "oa.example.com");
			assert.ok(inventory.assets[0].sources.includes("fofa"));
			assert.ok(existsSync(join(workspace, "assets.md")));
			assert.ok(readFileSync(join(workspace, "evidence-index.md"), "utf8").includes("asset_search"));
			assert.ok(out.rawFile.startsWith("artifacts/recon/"));
			assert.ok(existsSync(join(workspace, out.rawFile)));
			const raw = readFileSync(join(workspace, out.rawFile), "utf8");
			assert.ok(!raw.includes("evil.example.net") && !raw.includes("198.51.100.9") && !raw.includes("shared.example.net"));
			assert.ok(requestedUrls.length === 1);
			const fofaQuery = new URL(requestedUrls[0]).searchParams.get("qbase64");
			const decodedQuery = Buffer.from(fofaQuery, "base64").toString("utf8");
			assert.ok(decodedQuery.includes('domain="example.com"'), decodedQuery);
			assert.ok(out.assets[0].target.includes("oa.example.com"));

			const cidrOut = await tools.get("asset_search").execute({
				query: 'app:"Tomcat"', scope: "203.0.113.0/24", workspace,
			});
			assert.equal(cidrOut.ok, true, JSON.stringify(cidrOut));
			assert.equal(cidrOut.assets.length, 2);
			assert.ok(cidrOut.assets.every((asset) => asset.target.includes("203.0.113.")));
			assert.ok(cidrOut.assets.every((asset) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(asset.host)));
			const cidrRaw = readFileSync(join(workspace, cidrOut.rawFile), "utf8");
			assert.ok(!cidrRaw.includes("shared.example.net") && !cidrRaw.includes("oa.example.com"));
			assert.equal(requestedUrls.length, 2);
			const cidrQuery = Buffer.from(new URL(requestedUrls[1]).searchParams.get("qbase64"), "base64").toString("utf8");
			assert.ok(cidrQuery.includes('ip="203.0.113.0/24"'), cidrQuery);
		} finally {
			globalThis.fetch = oldFetch;
			rmSync(workspace, { recursive: true, force: true });
		}
	});

	await ok("asset_search_batch 在 FOFA 查询中约束整组授权域名并保留逐查询候选映射", async () => {
		const st = openHunterStore(join(TEST_HOME, "hunter", "hunter.db"));
		st.setKey.run("fofa", "test-key", new Date().toISOString());
		st.close();
		const oldFetch = globalThis.fetch;
		const requestedQueries = [];
		const workspace = mkdtempSync(join(process.env.TEMP || process.env.TMP || process.cwd(), "hunter-batch-"));
		try {
			globalThis.fetch = async (url) => {
				const parsed = new URL(String(url));
				requestedQueries.push(Buffer.from(parsed.searchParams.get("qbase64"), "base64").toString("utf8"));
				const rows = requestedQueries.length === 1
					? [
						["https://oa.example.com", "Portal", "203.0.113.10", "example.com", "443", "https", "nginx"],
						["https://evil.example.net", "Other", "198.51.100.9", "example.net", "443", "https", "nginx"],
					]
					: [["https://portal.corp.example.net", "Portal 2", "203.0.113.11", "corp.example.net", "443", "https", "nginx"]];
				return { ok: true, status: 200, text: async () => JSON.stringify({ error: false, size: rows.length, results: rows }) };
			};
			const out = await tools.get("asset_search_batch").execute({
				queries: [
					{ id: "q-portal", query: '(body="Portal" || header="Portal") && title=="Admin"', basis: "catalog-fingerprint", entryIds: ["nday-portal-rce"] },
					{ id: "q-version", query: 'product.version:"7.0.4.9"' },
				],
				scope: "*.example.com,*.corp.example.net", workspace, platform: "fofa", size: 10,
			});
			assert.equal(out.ok, true, JSON.stringify(out));
			assert.equal(out.queryResults.length, 2);
			assert.equal(out.queryResults[0].assets.length, 1);
			assert.equal(out.queryResults[0].outOfScopeCount, 1);
			assert.equal(out.queryResults[0].basis, "catalog-fingerprint");
			assert.deepEqual(out.queryResults[0].entryIds, ["nday-portal-rce"]);
			assert.equal(out.queryResults[1].assets.length, 1);
			assert.equal(out.queryResults[1].assets[0].host, "portal.corp.example.net");
			assert.equal(requestedQueries.length, 2);
			assert.ok(requestedQueries[0].includes('(body="Portal" || header="Portal")') && requestedQueries[0].includes('title=="Admin"'), requestedQueries[0]);
			assert.ok(requestedQueries.every((query) => query.includes('domain="example.com"') && query.includes('domain="corp.example.net"')));
			assert.ok(requestedQueries[1].includes('product.version="7.0.4.9"'));
			const saved = JSON.parse(readFileSync(join(workspace, out.rawFile), "utf8"));
			assert.equal(saved.queryResults[0].assets.length, 1);
			assert.equal(saved.queryResults[0].assets[0].host, "oa.example.com");
		} finally {
			globalThis.fetch = oldFetch;
			rmSync(workspace, { recursive: true, force: true });
		}
	});
}

closeSharedStore();
rmSync(TEST_HOME, { recursive: true, force: true });

console.log(fail === 0 ? `\nall ${pass} tests passed` : `\n${fail} FAILED, ${pass} passed`);
process.exit(fail ? 1 : 0);
