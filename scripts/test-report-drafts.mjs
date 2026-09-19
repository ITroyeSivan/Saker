#!/usr/bin/env node
// 报告草稿生成器回归：结构化的东西确定性落盘、缺的东西如实标"待补"、
// 已有文件绝不覆盖，而且**证据不足的草稿必须仍然过不了 stage_gate P2**
// （防止生成器用占位文字把门禁骗过去）。
//
// 用法：node --import ./scripts/test-stub-register.mjs scripts/test-report-drafts.mjs
import * as nodeFs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "generate-report-drafts.mjs");
let pass = 0;
let fail = 0;
const ok = (label, condition, detail = "") => {
	if (condition) { pass += 1; console.log(`ok   ${label}`); }
	else { fail += 1; console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
};

const sandbox = mkdtempSync(join(tmpdir(), "saker-report-drafts-"));
const home = join(sandbox, "home");
const ws = join(sandbox, "ws");
const SESSION = "session-draft-1";
mkdirSync(join(home, "redteam-results"), { recursive: true });
mkdirSync(ws, { recursive: true });
writeFileSync(join(ws, "operation-state.json"), JSON.stringify({
	goal: "报告草稿探针",
	criteria: [{ id: "g1", text: "出报告", status: "open" }],
	intents: [{ id: "i1", summary: "登记 finding", status: "open", sessionId: SESSION }],
}, null, 2), "utf8");

const { openStore, registerFinding, updateFinding } = await import("../plugins/dsh-redteam-results/lib/store.js");
const store = openStore(join(home, "redteam-results", "results.db"));
try {
	// 证据齐全的一条：三件套 + 复核都在台账里
	const full = registerFinding(store, SESSION, "pentest", {
		title: "门户站 SQL 注入",
		severity: "high",
		type: "sqli",
		target: "http://demo.example/admin?id=1",
		summary: "id 参数可注入",
		description: "布尔盲注可判定，超时注入可拿数据。",
		poc: "sqlmap -u 'http://demo.example/admin?id=1' --technique=B --batch",
		evidenceLevel: "impact",
	});
	updateFinding(store, SESSION, "pentest", full.id, {
		baseline: "id=1 正常返回 200，页面含「查询结果」",
		diffEvidence: "id=1' AND 1=1 返回「查询结果」，id=1' AND 1=2 返回「无结果」",
		markerEcho: "7f3a2b1c",
		verifyNote: "复核：独立子代理重放两条差分，结论一致",
		requestPkt: "GET /admin?id=1'%20AND%201=1-- HTTP/1.1",
		responsePkt: "HTTP/1.1 200 OK",
		fix: "参数化查询；对 id 做整型校验。",
	});
	// 证据不足的一条：只登记了标题/等级/地址
	registerFinding(store, SESSION, "pentest", {
		title: "上传点未做类型校验",
		severity: "medium",
		type: "upload",
		target: "http://demo.example/upload",
		summary: "疑似可传脚本",
	});
	// 误报：默认不该出报告文件
	const fp = registerFinding(store, SESSION, "pentest", {
		title: "误报样例", severity: "low", type: "xss", target: "http://demo.example/x",
	});
	updateFinding(store, SESSION, "pentest", fp.id, { status: "false-positive", verifyNote: "复核：前端已转义" });
	// 疑似态也应进入报告草稿，并保留“未定论”语义，不能退化成英文枚举。
	registerFinding(store, SESSION, "pentest", {
		title: "疑似路径归一化", severity: "low", type: "path-normalization",
		target: "http://demo.example/static/../.git/config", status: "suspect",
		summary: "路径归一化现象成立，但影响链未闭环",
	});
} finally {
	store.close();
}

const run = (extra = []) => spawnSync(process.execPath, [
	SCRIPT, "--workspace", ws, "--home", home, ...extra,
], { cwd: ROOT, encoding: "utf8" });

try {
	const first = run();
	ok("脚本正常退出", first.status === 0, `${first.status} ${(first.stderr || "").slice(0, 200)}`);
	const reportsDir = join(ws, "reports");
	const listReports = () => (existsSync(reportsDir) ? readdirSync(reportsDir).filter((f) => f.endsWith(".md")) : []);
	ok("为三条非误报 finding 生成草稿、误报跳过",
		listReports().length === 3
		&& listReports().some((f) => f.includes("SQL"))
		&& listReports().some((f) => f.includes("上传"))
		&& listReports().some((f) => f.includes("疑似路径归一化"))
		&& !listReports().some((f) => f.includes("误报")),
		listReports().join(", "));

	const fullPath = join(reportsDir, listReports().find((f) => f.includes("SQL")));
	const sparsePath = join(reportsDir, listReports().find((f) => f.includes("上传")));
	const suspectPath = join(reportsDir, listReports().find((f) => f.includes("疑似路径归一化")));
	const fullText = readFileSync(fullPath, "utf8");
	const sparseText = readFileSync(sparsePath, "utf8");
	const suspectText = readFileSync(suspectPath, "utf8");
	ok("草稿含六字段骨架", ["漏洞/问题 名称", "漏洞/问题 描述", "漏洞/问题 等级", "漏洞/问题 地址", "测试过程", "修复建议"]
		.every((k) => fullText.includes(k)));
	ok("证据齐全的草稿把三件套与复核原样带上",
		fullText.includes("基线") && fullText.includes("差分") && fullText.includes("marker") && fullText.includes("复核"));
	ok("证据等级按用户界面中文词表落盘（impact → 影响已证）",
		fullText.includes("证据等级：影响已证") && !fullText.includes("证据等级：impact"));
	ok("证据不足的草稿如实标「待补」而不是编内容",
		sparseText.includes("（待补：") && sparseText.includes("对照三件套"));
	ok("suspect 草稿落中文疑似状态，不退化成英文枚举",
		suspectText.includes("状态：疑似·未定论") && !suspectText.includes("状态：suspect"));

	// 门禁当裁判：齐全的过、缺的不过 —— 证明生成器没有伪造可过门禁的内容
	const { runGate } = await import("../plugins/dsh-stage-gate/lib/index.js");
	const gateFull = runGate(nodeFs, { mode: "pentest", stage: "P2", workspace: ws, file: fullPath });
	const gateSparse = runGate(nodeFs, { mode: "pentest", stage: "P2", workspace: ws, file: sparsePath });
	ok("证据齐全的草稿能过 P2 结构门禁", gateFull.pass === true, JSON.stringify(gateFull.missing));
	ok("证据不足的草稿**过不了** P2（生成器不伪造 marker）", gateSparse.pass === false, JSON.stringify(gateSparse.missing));

	// 不覆盖：再跑一次，内容与数量都不变
	const before = listReports().map((f) => [f, readFileSync(join(reportsDir, f), "utf8")]);
	const second = run();
	const after = listReports().map((f) => [f, readFileSync(join(reportsDir, f), "utf8")]);
	ok("重复运行不覆盖已有报告",
		second.status === 0 && JSON.stringify(before) === JSON.stringify(after)
		&& /跳过/.test(second.stdout || ""));

	// dry-run 不落盘
	const dryWs = join(sandbox, "ws-dry");
	mkdirSync(dryWs, { recursive: true });
	writeFileSync(join(dryWs, "operation-state.json"), JSON.stringify({ intents: [{ id: "i1", summary: "x", status: "open", sessionId: SESSION }] }), "utf8");
	const dry = spawnSync(process.execPath, [SCRIPT, "--workspace", dryWs, "--home", home, "--dry"], { cwd: ROOT, encoding: "utf8" });
	ok("--dry 不写盘但报告计划",
		dry.status === 0 && !existsSync(join(dryWs, "reports")) && /dry-run/.test(dry.stdout || ""));
} finally {
	rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
