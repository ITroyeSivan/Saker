#!/usr/bin/env node
// Repeatable knowledge retrieval smoke evaluation.
//
// The bundled case set is keyword ground truth, not a human-labelled IR set. It
// is useful for catching ranking regressions and measuring latency before/after
// a retrieval change without pretending to be a benchmark.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const value = (name, fallback) => {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] : fallback;
};

process.env.DSH_HOME = process.env.DSH_HOME || resolve(homedir(), ".dsh");
const casesFile = resolve(ROOT, value("cases", "docs/reports/02-体检与评估/knowledge-eval-cases-2026-09-17.json"));
const modeOverride = value("mode", "");
const limit = Math.max(1, Number(value("limit", "5")) || 5);
const jsonOut = value("json-out", "");
const numberArg = (name, fallback) => {
	const raw = value(name, "");
	const number = Number(raw);
	return raw !== "" && Number.isFinite(number) ? number : fallback;
};

const fixture = JSON.parse(readFileSync(casesFile, "utf8"));
const { ensureKnowledgeIndex, searchAll } = await import("../plugins/dsh-knowledge-hub/lib/index.js");
const { indexDbPath } = await import("../plugins/dsh-knowledge-hub/lib/index-build.js");

/** 大小写/分隔符归一，便于比对索引里的相对路径。 */
const normPath = (value) => String(value || "").replace(/\\/g, "/").toLowerCase();

ensureKnowledgeIndex();
let top1 = 0;
let top5 = 0;
let reciprocal = 0;
let lowConfidenceTop1 = 0;
let totalMs = 0;
const rows = [];
const negativeRows = [];

for (const item of fixture.cases) {
	const mode = modeOverride || item.mode || "";
	const started = Date.now();
	let hits = [];
	try {
		hits = searchAll(item.query, mode, Math.max(limit, 5));
	} catch (error) {
		hits = [];
		console.error(`search failed for ${item.id}: ${error?.message ?? error}`);
	}
	const ms = Date.now() - started;
	totalMs += ms;
	const expected = (item.expect || []).map((x) => String(x).toLowerCase());
	const expectedPaths = (item.expectPaths || []).map(normPath).filter(Boolean);
	// 有 expectPaths 的用例按**精确文档**判命中（人工核对过），否则退回关键词判定。
	// 两种判定都只回答"该文档是否出现在前 N 名"，不假装是完整相关性标注。
	const isHit = (hit) => {
		if (expectedPaths.length > 0) return expectedPaths.some((p) => normPath(hit.path).includes(p));
		const hay = `${hit.path || ""}\n${hit.title || ""}\n${hit.heading || ""}\n${hit.preview || ""}`.toLowerCase();
		return expected.some((term) => hay.includes(term));
	};
	const rank = hits.findIndex(isHit);
	if (rank === 0) top1 += 1;
	if (hits[0] && hits[0].lowConfidence === true) lowConfidenceTop1 += 1;
	if (rank >= 0 && rank < Math.min(5, hits.length)) reciprocal += 1 / (rank + 1);
	if (hits.slice(0, 5).some(isHit)) top5 += 1;
	rows.push({ id: item.id, mode, query: item.query, ms, hitRank: rank < 0 ? null : rank + 1, top: hits.slice(0, limit).map((h) => ({ path: h.path, title: h.title, score: h.score })) });
}

for (const item of fixture.negativeCases || []) {
	const mode = modeOverride || item.mode || "";
	const started = Date.now();
	let hits = [];
	try {
		hits = searchAll(item.query, mode, limit);
	} catch (error) {
		console.error(`negative search failed for ${item.id}: ${error?.message ?? error}`);
	}
	const ms = Date.now() - started;
	totalMs += ms;
	negativeRows.push({
		id: item.id,
		mode,
		query: item.query,
		ms,
		topScore: hits[0]?.score ?? null,
		flagged: hits.length === 0 || hits[0]?.lowConfidence === true,
		top: hits.slice(0, Math.min(3, limit)).map((h) => ({ path: h.path, title: h.title, score: h.score })),
	});
}

const n = rows.length;
const thresholds = {
  minCases: numberArg("min-cases", 50),
  minNegativeCases: numberArg("min-negative-cases", 5),
  top1: numberArg("min-top1", 0.90),
  top5: numberArg("min-top5", 0.98),
  mrr: numberArg("min-mrr", 0.92),
  maxLowConfidenceTop1: numberArg("max-low-confidence-top1", 0.15),
  minNegativeFlagRate: numberArg("min-negative-flag-rate", 0.60),
  maxAvgMs: numberArg("max-avg-ms", 120),
  maxIndexMb: numberArg("max-index-mb", 600),
};
const dbPath = indexDbPath();
const indexBytes = existsSync(dbPath) ? statSync(dbPath).size : 0;
const report = {
  generatedAt: new Date().toISOString(),
  dshHome: process.env.DSH_HOME,
  cases: n,
  thresholds,
  top1: n ? top1 / n : 0,
  top5: n ? top5 / n : 0,
  mrr: n ? reciprocal / n : 0,
  lowConfidenceTop1Rate: n ? lowConfidenceTop1 / n : 0,
  latencyMs: { total: totalMs, avg: n ? totalMs / n : 0 },
  index: { path: dbPath, bytes: indexBytes, mb: indexBytes / 1024 / 1024 },
  rows,
  negative: {
    cases: negativeRows.length,
    avgTopScore: negativeRows.length ? negativeRows.reduce((sum, row) => sum + Number(row.topScore || 0), 0) / negativeRows.length : 0,
    maxTopScore: negativeRows.length ? Math.max(...negativeRows.map((row) => Number(row.topScore || 0))) : 0,
    flagRate: negativeRows.length ? negativeRows.filter((row) => row.flagged).length / negativeRows.length : 0,
    rows: negativeRows,
  },
};

console.log(`knowledge-eval cases=${n} top1=${(report.top1 * 100).toFixed(1)}% top5=${(report.top5 * 100).toFixed(1)}% mrr=${report.mrr.toFixed(3)} lowConfTop1=${(report.lowConfidenceTop1Rate * 100).toFixed(1)}% avg=${report.latencyMs.avg.toFixed(1)}ms index=${report.index.mb.toFixed(1)}MB`);
for (const row of rows) console.log(`${row.hitRank ? "HIT " : "MISS"} ${row.id.padEnd(24)} rank=${row.hitRank ?? "-"} ${row.ms}ms  ${row.query}`);
if (negativeRows.length) {
	console.log(`knowledge-negative cases=${report.negative.cases} flagRate=${(report.negative.flagRate * 100).toFixed(1)}% avgTopScore=${report.negative.avgTopScore.toFixed(2)} maxTopScore=${report.negative.maxTopScore.toFixed(2)}`);
	for (const row of negativeRows) console.log(`NEG ${row.id.padEnd(24)} flagged=${row.flagged ? "yes" : "no"} topScore=${row.topScore ?? "-"} ${row.ms}ms  ${row.query}`);
}

if (jsonOut) {
	const out = resolve(jsonOut);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, JSON.stringify(report, null, 2) + "\n", "utf8");
	console.log(`report: ${out}`);
}

const regressions = [];
if (n < thresholds.minCases) regressions.push(`正样例 ${n} < ${thresholds.minCases}（样本太少会制造高指标的假绿）`);
if (negativeRows.length < thresholds.minNegativeCases) regressions.push(`负样例 ${negativeRows.length} < ${thresholds.minNegativeCases}`);
if (report.top1 < thresholds.top1) regressions.push(`Top-1 ${(report.top1 * 100).toFixed(1)}% < ${(thresholds.top1 * 100).toFixed(0)}%`);
if (report.top5 < thresholds.top5) regressions.push(`Top-5 ${(report.top5 * 100).toFixed(1)}% < ${(thresholds.top5 * 100).toFixed(0)}%`);
if (report.mrr < thresholds.mrr) regressions.push(`MRR ${report.mrr.toFixed(3)} < ${thresholds.mrr.toFixed(2)}`);
if (report.lowConfidenceTop1Rate > thresholds.maxLowConfidenceTop1) regressions.push(`Top-1 低置信率 ${(report.lowConfidenceTop1Rate * 100).toFixed(1)}% > ${(thresholds.maxLowConfidenceTop1 * 100).toFixed(0)}%`);
if (report.negative.flagRate < thresholds.minNegativeFlagRate) regressions.push(`负样例标记率 ${(report.negative.flagRate * 100).toFixed(1)}% < ${(thresholds.minNegativeFlagRate * 100).toFixed(0)}%`);
if (report.latencyMs.avg > thresholds.maxAvgMs) regressions.push(`平均延迟 ${report.latencyMs.avg.toFixed(1)}ms > ${thresholds.maxAvgMs}ms`);
if (report.index.mb > thresholds.maxIndexMb) regressions.push(`索引体积 ${report.index.mb.toFixed(1)}MB > ${thresholds.maxIndexMb}MB`);
if (regressions.length) {
	console.error(`knowledge-eval regression: ${regressions.join("; ")}`);
	process.exitCode = 1;
}
