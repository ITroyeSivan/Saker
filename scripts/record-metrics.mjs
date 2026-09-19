#!/usr/bin/env node
// 把「这一轮门禁测到的数字」写进指标历史（每跑一次发版门禁追加一行）。
//
// 数字来源全部是**已经存在的产物**：长会话 30 轮审计的 summary.json、大结果裁剪审计的
// summary.json、以及各插件库的只读统计。**没测到就写 null**——不写 0，避免趋势里出现
// "突然降到零"的假回退（这是最容易骗到自己的一种数据事故）。
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { appendMetric } from "./metrics-history.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const index = argv.indexOf(`--${name}`);
	return index >= 0 ? argv[index + 1] : fallback;
};
const HOME = resolve(arg("home", process.env.DSH_HOME || join(homedir(), ".dsh")));
const LABEL = String(arg("label", "") || "");
const JSON_OUT = arg("json", "");

function readJson(file) {
	if (!file || !existsSync(file)) return null;
	try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}
const num = (value) => {
	if (value === null || value === undefined || value === "") return null;
	return Number.isFinite(Number(value)) ? Number(value) : null;
};

const long = readJson(arg("long-session", ""));
const large = readJson(arg("large-result", ""));

const row = {
	label: LABEL,
	home: HOME,
	toolSurface: long
		? {
			count: num(long.first?.tools),
			bytes: num(long.first?.toolsBytes),
			stableCount: typeof long.toolCountStable === "boolean" ? long.toolCountStable : null,
			stableBytes: typeof long.toolBytesStable === "boolean" ? long.toolBytesStable : null,
		}
		: null,
	request: long
		? {
			first: num(long.first?.requestBytes),
			tenth: num(long.tenth?.requestBytes),
			last: num(long.last?.requestBytes),
			max: num(long.maxRequestBytes),
			turns: num(long.turns),
		}
		: null,
	pruning: large
		? {
			longestToolResultChars: num(large.longestToolResultChars),
			pruned: typeof large.pruned === "boolean" ? large.pruned : null,
			underThreshold: typeof large.underThreshold === "boolean" ? large.underThreshold : null,
		}
		: null,
	memory: null,
	findings: null,
	traces: null,
};

// 各库只读统计（库不在就保持 null：没测到 ≠ 0）
const memoryFile = join(HOME, "campaign-memory", "memory.db");
if (existsSync(memoryFile)) {
	try {
		const { openStore } = await import("../plugins/dsh-campaign-memory/lib/store.js");
		const store = openStore(memoryFile);
		try {
			const row0 = store.db.prepare(`
				SELECT COUNT(*) AS total,
					SUM(CASE WHEN usage_count > 0 THEN 1 ELSE 0 END) AS read,
					SUM(CASE WHEN feedback_score > 0 THEN 1 ELSE 0 END) AS helpful,
					SUM(CASE WHEN feedback_score < 0 AND feedback_score > -5 THEN 1 ELSE 0 END) AS misleading,
					SUM(CASE WHEN feedback_score <= -5 THEN 1 ELSE 0 END) AS obsolete
				FROM memories`).get();
			row.memory = {
				total: num(row0.total), read: num(row0.read), helpful: num(row0.helpful),
				misleading: num(row0.misleading), obsolete: num(row0.obsolete),
			};
		} finally { store.close(); }
	} catch { row.memory = null; }
}

const findingsFile = join(HOME, "redteam-results", "results.db");
if (existsSync(findingsFile)) {
	try {
		const { openStore } = await import("../plugins/dsh-redteam-results/lib/store.js");
		const store = openStore(findingsFile);
		try {
			const total = store.db.prepare("SELECT COUNT(*) AS n FROM findings").get();
			const verified = store.db.prepare("SELECT COUNT(*) AS n FROM findings WHERE status = 'verified'").get();
			row.findings = { total: num(total.n), verified: num(verified.n) };
		} finally { store.close(); }
	} catch { row.findings = null; }
}

const tracesFile = join(HOME, "trace-vault", "traces.db");
if (existsSync(tracesFile)) {
	try {
		const { openStore, sessionMetrics } = await import("../plugins/dsh-trace-vault/lib/store.js");
		const store = openStore(tracesFile);
		try {
			const metrics = sessionMetrics(store);
			const stats = store.db.prepare(`
				SELECT COUNT(*) AS total,
					SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS error,
					SUM(CASE WHEN outcome = 'blocked' THEN 1 ELSE 0 END) AS blocked,
					SUM(CASE WHEN outcome = 'interrupted' THEN 1 ELSE 0 END) AS interrupted
				FROM traces WHERE tool != '(intervention)'`).get();
			row.traces = {
				total: num(stats.total), error: num(stats.error),
				blocked: num(stats.blocked), interrupted: num(stats.interrupted),
				firstEffectiveActionMs: num(metrics.firstEffectiveActionMs),
				toolFailureRate: num(metrics.toolFailureRate),
				errorRate: num(metrics.errorRate),
				blockedRate: num(metrics.blockedRate),
			};
		} finally { store.close(); }
	} catch { row.traces = null; }
}

const entry = appendMetric(HOME, row);
if (JSON_OUT) {
	const { writeFileSync, mkdirSync } = await import("node:fs");
	const { dirname } = await import("node:path");
	mkdirSync(dirname(resolve(JSON_OUT)), { recursive: true });
	writeFileSync(resolve(JSON_OUT), `${JSON.stringify(entry, null, 2)}\n`, "utf8");
}
console.log(`指标已入历史：${entry.at}`);
console.log(`  工具面 ${row.toolSurface ? `${row.toolSurface.count} 个 / ${row.toolSurface.bytes}B` : "（本轮未测）"}`);
console.log(`  请求体 first=${row.request?.first ?? "—"} last=${row.request?.last ?? "—"} max=${row.request?.max ?? "—"}`);
console.log(`  大结果裁剪 ${row.pruning ? `${row.pruning.longestToolResultChars} 字符（pruned=${row.pruning.pruned}）` : "（本轮未测）"}`);
console.log(`  记忆 ${row.memory ? `${row.memory.total} 条 / 读取 ${row.memory.read}` : "（无库）"}｜成果 ${row.findings ? `${row.findings.total} 条` : "（无库）"}｜轨迹 ${row.traces ? `${row.traces.total} 条 / firstAction=${row.traces.firstEffectiveActionMs ?? "—"}ms / toolFailure=${row.traces.toolFailureRate ?? "—"}%` : "（无库）"}`);
