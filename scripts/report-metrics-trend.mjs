#!/usr/bin/env node
// 指标趋势：把 `saker-metrics/history.jsonl` 里的行读成"最近 N 次门禁的数字 + 相对上一条的增减"。
//
// 这是**报告**不是门禁：只呈现事实，不设通过线。硬门禁仍在 release-gate 里
// （工具描述预算、同步、知识/任务基线等），这里负责让"是不是在慢慢变胖"看得见。
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readMetrics, trendOf } from "./metrics-history.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const index = argv.indexOf(`--${name}`);
	return index >= 0 ? argv[index + 1] : fallback;
};
const HOME = resolve(arg("home", process.env.DSH_HOME || join(homedir(), ".dsh")));
const LIMIT = Math.max(1, Math.min(Number(arg("limit", "10")) || 10, 200));
const JSON_OUT = arg("json", "");

const rows = readMetrics(HOME, LIMIT);
const { deltas } = trendOf(rows);

const show = (value) => (value === null || value === undefined ? "—" : String(value));
const signed = (value) => (value === null || value === undefined ? "—" : `${value > 0 ? "+" : ""}${value}`);

if (rows.length === 0) {
	console.log(`指标历史为空：${join(HOME, "saker-metrics", "history.jsonl")}`);
	console.log("跑一次 release gate（含 --context）会自动记一行。");
} else {
	console.log(`最近 ${rows.length} 次记录（新→旧）：`);
	console.log("时间                 工具(个/B)        请求 max    记忆(总/读)      成果   轨迹(err)     首动ms 失败%");
	for (const row of rows) {
		const tool = row.toolSurface ? `${show(row.toolSurface.count)}/${show(row.toolSurface.bytes)}` : "—";
		const mem = row.memory ? `${show(row.memory.total)}/${show(row.memory.read)}` : "—";
		console.log([
			String(row.at ?? "").replace("T", " ").slice(0, 19).padEnd(20),
			tool.padEnd(17),
			show(row.request?.max).padEnd(11),
			mem.padEnd(16),
			show(row.findings?.total).padEnd(6),
			(show(row.traces?.total) + (row.traces ? `(${show(row.traces.error)})` : "")).padEnd(14),
			show(row.traces?.firstEffectiveActionMs).padEnd(7),
			show(row.traces?.toolFailureRate),
		].join(" "));
	}
	console.log("\n相对上一条的变化（没测到一律 —，不假装是 0）：");
	for (const [key, item] of Object.entries(deltas)) {
		if (item.current === null && item.previous === null) continue;
		console.log(`  ${key.padEnd(28)} ${show(item.current)} (${signed(item.delta)})`);
	}
}

if (JSON_OUT) {
	const { writeFileSync, mkdirSync } = await import("node:fs");
	const { dirname } = await import("node:path");
	mkdirSync(dirname(resolve(JSON_OUT)), { recursive: true });
	writeFileSync(resolve(JSON_OUT), `${JSON.stringify({ home: HOME, rows, deltas }, null, 2)}\n`, "utf8");
	console.log(`\nreport: ${resolve(JSON_OUT)}`);
}
