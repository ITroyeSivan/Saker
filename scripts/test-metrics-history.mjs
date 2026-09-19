#!/usr/bin/env node
// 指标历史回归：有界追加、坏行容错、趋势增减，以及最要紧的一条——
// **没测到的量必须是 null，不能是 0**（否则趋势里会出现"突然降到零"的假回退）。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { HISTORY_LIMIT, appendMetric, historyPath, readMetrics, trendOf } from "./metrics-history.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
let fail = 0;
const ok = (label, condition, detail = "") => {
	if (condition) { pass += 1; console.log(`ok   ${label}`); }
	else { fail += 1; console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
};

const sandbox = mkdtempSync(join(tmpdir(), "saker-metrics-"));
const home = join(sandbox, "home");
try {
	ok("空历史读成空数组", readMetrics(home, 10).length === 0);

	appendMetric(home, { label: "a", toolSurface: { count: 90 } });
	appendMetric(home, { label: "b", toolSurface: { count: 94 } });
	appendMetric(home, { label: "c", toolSurface: { count: 98 } });
	const rows = readMetrics(home, 10);
	ok("追加 3 行、读取新→旧", rows.length === 3 && rows[0].label === "c" && rows[2].label === "a", JSON.stringify(rows.map((r) => r.label)));
	ok("每行自动带时间戳", typeof rows[0].at === "string" && rows[0].at.includes("T"));

	// 坏行容错：手工塞一行垃圾
	const file = historyPath(home);
	writeFileSync(file, `${readFileSync(file, "utf8")}{ this is not json\n`, "utf8");
	ok("坏行被跳过而不是抛错", readMetrics(home, 10).length === 3);

	// 有界：写到超过上限，保留最近 HISTORY_LIMIT 行
	for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) appendMetric(home, { label: `bulk-${i}`, toolSurface: { count: i } });
	const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
	ok(`历史上限 ${HISTORY_LIMIT} 行（丢最旧、留最新）`,
		lines.length === HISTORY_LIMIT && JSON.parse(lines.at(-1)).label === `bulk-${HISTORY_LIMIT + 4}`);

	// 趋势：增减算得对；缺测的写 null 而不是 0
	const t = trendOf([
		{ toolSurface: { count: 94, bytes: 83920 }, request: { max: 144461 }, memory: { total: 10 } },
		{ toolSurface: { count: 90, bytes: 80000 }, request: { max: 140000 }, memory: { total: 10 } },
	]);
	ok("趋势：工具个数/体积/请求体的增减算对",
		t.deltas["toolSurface.count"].delta === 4
		&& t.deltas["toolSurface.bytes"].delta === 3920
		&& t.deltas["request.max"].delta === 4461);
	ok("趋势：没测到的量是 null（不是 0）",
		t.deltas["traces.total"].current === null && t.deltas["traces.total"].delta === null
		&& t.deltas["memory.misleading"].current === null);
	const t2 = trendOf([
		{ traces: { firstEffectiveActionMs: 3000, toolFailureRate: 10, errorRate: 0 } },
		{ traces: { firstEffectiveActionMs: 5000, toolFailureRate: 25, errorRate: 5 } },
	]);
	ok("趋势：首次动作/工具失败率/错误率的增减也算进去",
		t2.deltas["traces.firstEffectiveActionMs"].delta === -2000
		&& t2.deltas["traces.toolFailureRate"].delta === -15
		&& t2.deltas["traces.errorRate"].delta === -5);

	// 端到端：record-metrics 读审计产物 → 写历史；无库时必须 null
	const auditLong = join(sandbox, "long.json");
	const auditLarge = join(sandbox, "large.json");
	writeFileSync(auditLong, JSON.stringify({
		turns: 30,
		first: { tools: 94, toolsBytes: 83920, requestBytes: 126789 },
		tenth: { requestBytes: 141821 },
		last: { requestBytes: 144461 },
		maxRequestBytes: 144461,
		toolCountStable: true,
		toolBytesStable: true,
	}), "utf8");
	writeFileSync(auditLarge, JSON.stringify({ longestToolResultChars: 30759, pruned: true, underThreshold: true }), "utf8");
	const recorded = spawnSync(process.execPath, [
		join(ROOT, "scripts", "record-metrics.mjs"),
		"--home", home, "--label", "gate-test",
		"--long-session", auditLong, "--large-result", auditLarge,
	], { cwd: ROOT, encoding: "utf8" });
	ok("record-metrics 正常退出", recorded.status === 0, (recorded.stderr || "").slice(0, 200));
	const latest = readMetrics(home, 1)[0];
	ok("录到的工具面/请求体/裁剪数字与产物一致",
		latest.label === "gate-test" && latest.toolSurface.count === 94 && latest.toolSurface.bytes === 83920
		&& latest.request.max === 144461 && latest.pruning.longestToolResultChars === 30759);
	ok("没有库时记忆/成果/轨迹写 null（不写 0）",
		latest.memory === null && latest.findings === null && latest.traces === null);

	// 空 trace 库：total=0 是真实测量；SUM(error)/首次动作/失败率没样本时必须 null。
	const traceHome = join(sandbox, "trace-home");
	mkdirSync(join(traceHome, "trace-vault"), { recursive: true });
	const { openStore } = await import("../plugins/dsh-trace-vault/lib/store.js");
	const emptyTraceStore = openStore(join(traceHome, "trace-vault", "traces.db"));
	emptyTraceStore.close();
	const emptyTraceRun = spawnSync(process.execPath, [
		join(ROOT, "scripts", "record-metrics.mjs"), "--home", traceHome, "--label", "empty-trace",
	], { cwd: ROOT, encoding: "utf8" });
	const emptyTraceRow = readMetrics(traceHome, 1)[0];
	ok("空 trace 库：total 写 0，但无样本的 error/首动/失败率写 null",
		emptyTraceRun.status === 0 && emptyTraceRow?.traces?.total === 0
		&& emptyTraceRow.traces.error === null
		&& emptyTraceRow.traces.firstEffectiveActionMs === null
		&& emptyTraceRow.traces.toolFailureRate === null);

	// 缺审计产物时，对应块必须是 null
	const noAudit = spawnSync(process.execPath, [join(ROOT, "scripts", "record-metrics.mjs"), "--home", home], { cwd: ROOT, encoding: "utf8" });
	const rowNoAudit = readMetrics(home, 1)[0];
	ok("没有审计产物时工具面/请求体/裁剪都是 null",
		noAudit.status === 0 && rowNoAudit.toolSurface === null && rowNoAudit.request === null && rowNoAudit.pruning === null);

	// 趋势报告能读出来
	const trendOut = spawnSync(process.execPath, [join(ROOT, "scripts", "report-metrics-trend.mjs"), "--home", home, "--limit", "3"], { cwd: ROOT, encoding: "utf8" });
	ok("趋势报告输出最近记录与变化",
		trendOut.status === 0 && /最近 3 次记录/.test(trendOut.stdout) && /相对上一条的变化/.test(trendOut.stdout));
} finally {
	rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
