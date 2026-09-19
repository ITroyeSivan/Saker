#!/usr/bin/env node
// Cost budget gate for release evidence.
//
// This reads already-produced summaries instead of measuring twice. It turns
// "the model is getting expensive" into explicit byte budgets, so a release
// cannot pass only because quality metrics still look good.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const index = argv.indexOf(`--${name}`);
	return index >= 0 ? argv[index + 1] : fallback;
};
const numArg = (name, fallback) => {
	const value = Number(arg(name, ""));
	return Number.isFinite(value) && arg(name, "") !== "" ? value : fallback;
};
const readJson = (file) => {
	if (!file || !existsSync(file)) return null;
	try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
};

const long = readJson(arg("long-session", ""));
const large = readJson(arg("large-result", ""));
const thresholds = {
	maxToolBytes: numArg("max-tool-bytes", 100_000),
	maxRequestBytes: numArg("max-request-bytes", 200_000),
	maxRequestGrowthBytes: numArg("max-request-growth-bytes", 20_000),
	maxToolResultChars: numArg("max-tool-result-chars", 40_000),
};
const report = {
	generatedAt: new Date().toISOString(),
	thresholds,
	toolSurface: long ? {
		count: Number(long.first?.tools) || 0,
		bytes: Number(long.first?.toolsBytes) || 0,
		stableCount: long.toolCountStable === true,
		stableBytes: long.toolBytesStable === true,
	} : null,
	request: long ? {
		first: Number(long.first?.requestBytes) || 0,
		last: Number(long.last?.requestBytes) || 0,
		max: Number(long.maxRequestBytes) || 0,
		growth: (Number(long.last?.requestBytes) || 0) - (Number(long.first?.requestBytes) || 0),
	} : null,
	largeResult: large ? {
		longest: Number(large.longestToolResultChars) || 0,
		pruned: large.pruned === true,
		underThreshold: large.underThreshold === true,
	} : null,
};

const violations = [];
if (!long) violations.push("缺少长会话 summary");
else {
	if (!report.toolSurface.stableCount) violations.push("工具数量不稳定");
	if (!report.toolSurface.stableBytes) violations.push("工具定义体积不稳定");
	if (report.toolSurface.bytes > thresholds.maxToolBytes) violations.push(`工具定义 ${report.toolSurface.bytes}B > ${thresholds.maxToolBytes}B`);
	if (report.request.max > thresholds.maxRequestBytes) violations.push(`最大请求体 ${report.request.max}B > ${thresholds.maxRequestBytes}B`);
	if (report.request.growth > thresholds.maxRequestGrowthBytes) violations.push(`请求增长 ${report.request.growth}B > ${thresholds.maxRequestGrowthBytes}B`);
}
if (!large) violations.push("缺少大结果裁剪 summary");
else {
	if (!report.largeResult.pruned || !report.largeResult.underThreshold) violations.push("大工具结果未被裁到压力门以内");
	if (report.largeResult.longest > thresholds.maxToolResultChars) violations.push(`最长工具结果 ${report.largeResult.longest} 字符 > ${thresholds.maxToolResultChars}`);
}

const out = arg("json-out", "");
if (out) {
	const file = resolve(out);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

console.log(`cost-budget tools=${report.toolSurface?.bytes ?? "—"}B requestMax=${report.request?.max ?? "—"}B requestGrowth=${report.request?.growth ?? "—"}B toolResult=${report.largeResult?.longest ?? "—"}chars`);
if (violations.length) {
	console.error(`cost-budget violation: ${violations.join("; ")}`);
	process.exitCode = 1;
}
