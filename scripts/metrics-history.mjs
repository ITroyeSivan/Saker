// 指标历史（本地时间序列，零依赖）：每次发版门禁跑完追加一行，供趋势报告读取。
//
// 为什么要它：单点数字只能回答"现在多大"，回答不了"是不是在变胖"。
// 护网最关心的三个量——工具面、请求体、任务成功率——需要**随时间的序列**才能看出回退。
//
// 两条约束：
//  1) **没测到就写 null**，不写 0——0 会被趋势读成"降到零"，是假数据；
//  2) 文件有上限（默认 200 行），超了丢最旧的，避免无限增长。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const HISTORY_LIMIT = 200;

export function historyPath(home) {
	return join(home || process.env.DSH_HOME || join(homedir(), ".dsh"), "saker-metrics", "history.jsonl");
}

/** 读历史（新→旧）。坏行直接跳过，不抛错。 */
export function readMetrics(home, limit = 50) {
	const file = historyPath(home);
	if (!existsSync(file)) return [];
	let lines = [];
	try { lines = readFileSync(file, "utf8").split("\n").filter(Boolean); } catch { return []; }
	return lines
		.slice(-Math.max(1, Math.min(Number(limit) || 50, HISTORY_LIMIT)))
		.map((line) => { try { return JSON.parse(line); } catch { return null; } })
		.filter(Boolean)
		.reverse();
}

/** 追加一行；超过上限时保留最近的 limit 行。写入走同盘临时文件 + rename。 */
export function appendMetric(home, row, { limit = HISTORY_LIMIT } = {}) {
	const file = historyPath(home);
	mkdirSync(dirname(file), { recursive: true });
	const entry = { at: new Date().toISOString(), ...row };
	let lines = [];
	try { lines = readFileSync(file, "utf8").split("\n").filter(Boolean); } catch { lines = []; }
	lines.push(JSON.stringify(entry));
	if (lines.length > limit) lines = lines.slice(-limit);
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, `${lines.join("\n")}\n`, "utf8");
	// rename 覆盖：同盘原子，读到半截文件的风险降到最低
	renameSync(tmp, file);
	return entry;
}

function num(value) {
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

function delta(current, previous) {
	if (current === null || previous === null || current === undefined || previous === undefined) return null;
	return Number((current - previous).toFixed(2));
}

function pick(row, path) {
	return path.split(".").reduce((acc, key) => (acc && typeof acc === "object" ? acc[key] : undefined), row);
}

/**
 * 趋势：拿最近两行算关键量的增减（没测到就 null，不做假比较）。
 * @returns {{latest: object|null, previous: object|null, deltas: object}}
 */
export function trendOf(rows) {
	const latest = rows?.[0] ?? null;
	const previous = rows?.[1] ?? null;
	const keys = [
		"toolSurface.count", "toolSurface.bytes",
		"request.first", "request.tenth", "request.last", "request.max",
		"memory.total", "memory.helpful", "memory.misleading",
		"findings.total", "traces.total", "traces.error",
		"traces.firstEffectiveActionMs", "traces.toolFailureRate", "traces.errorRate", "traces.blockedRate",
	];
	const deltas = {};
	for (const key of keys) {
		const current = latest ? num(pick(latest, key)) : null;
		const before = previous ? num(pick(previous, key)) : null;
		deltas[key] = { current, previous: before, delta: delta(current, before) };
	}
	return { latest, previous, deltas };
}
