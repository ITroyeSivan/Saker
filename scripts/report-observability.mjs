#!/usr/bin/env node
// Read-only local observability summary across Saker's durable stores.
import { existsSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const arg = (name, fallback) => {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] : fallback;
};

const HOME = resolve(arg("home", process.env.DSH_HOME || join(homedir(), ".dsh")));
const JSON_OUT = arg("json", "");
const MODES = ["pentest", "code-audit", "ctf-solver"];

const result = {
	generatedAt: new Date().toISOString(),
	home: HOME,
	stores: {},
	traces: null,
	memory: null,
	findings: null,
};

function sizeOf(file) {
	try { return statSync(file).size; } catch { return 0; }
}

const traceFile = join(HOME, "trace-vault", "traces.db");
if (existsSync(traceFile)) {
	const { openStore, statsTraces, sessionStats, sessionMetrics } = await import("../plugins/dsh-trace-vault/lib/store.js");
	const store = openStore(traceFile);
	try {
		const metrics = sessionMetrics(store);
		result.traces = {
			...statsTraces(store),
			...sessionStats(store),
			sessionMetrics: metrics,
			firstEffectiveActionMs: metrics.firstEffectiveActionMs,
			toolFailureRate: metrics.toolFailureRate,
			blockedRate: metrics.blockedRate,
			errorRate: metrics.errorRate,
		};
	} finally {
		store.close();
	}
}
result.stores["trace-vault"] = traceFile;

const memoryFile = join(HOME, "campaign-memory", "memory.db");
if (existsSync(memoryFile)) {
	const { openStore, statsMemories } = await import("../plugins/dsh-campaign-memory/lib/store.js");
	const store = openStore(memoryFile);
	try {
		result.memory = {
			byMode: Object.fromEntries(MODES.map((mode) => [mode, statsMemories(store, mode)])),
		};
		result.memory.total = Object.values(result.memory.byMode).reduce((sum, value) => sum + value.total, 0);
		result.memory.feedback = Object.fromEntries(["helpful", "misleading", "obsolete"].map((key) => [
			key,
			Object.values(result.memory.byMode).reduce((sum, value) => sum + Number(value.feedback?.[key] || 0), 0),
		]));
	} finally {
		store.close();
	}
}
result.stores["campaign-memory"] = memoryFile;

const findingsFile = join(HOME, "redteam-results", "results.db");
if (existsSync(findingsFile)) {
	const { openStore, modeCountsAll, computeStatsAll } = await import("../plugins/dsh-redteam-results/lib/store.js");
	const store = openStore(findingsFile);
	try {
		result.findings = {
			counts: modeCountsAll(store),
			byMode: Object.fromEntries(MODES.map((mode) => [mode, computeStatsAll(store, mode)])),
		};
	} finally {
		store.close();
	}
}
result.stores["redteam-results"] = findingsFile;

for (const [name, file] of Object.entries(result.stores)) {
	result.stores[name] = { path: file, bytes: sizeOf(file), exists: existsSync(file) };
}

if (result.traces) {
	console.log(`traces: calls=${result.traces.calls} ok=${result.traces.ok} blocked=${result.traces.blocked} error=${result.traces.error} interrupted=${result.traces.interrupted} running=${result.traces.running} interventions=${result.traces.interventions} success=${result.traces.successRate ?? "-"}% firstAction=${result.traces.firstEffectiveActionMs ?? "-"}ms toolFailure=${result.traces.toolFailureRate ?? "-"}%（只看 error/interrupted）targetBlocked=${result.traces.blockedRate ?? "-"}%（目标回 403/WAF/限速，是情报不是故障）`);
}
if (result.memory) {
	console.log(`memory: total=${result.memory.total} byMode=${MODES.map((mode) => `${mode}:${result.memory.byMode[mode].total}`).join(" ")} feedback=helpful:${result.memory.feedback.helpful} misleading:${result.memory.feedback.misleading} obsolete:${result.memory.feedback.obsolete}`);
}
if (result.findings) console.log(`findings: ${MODES.map((mode) => `${mode}:${result.findings.counts[mode] || 0}`).join(" ")}`);
console.log(`stores: ${Object.entries(result.stores).map(([name, value]) => `${name}:${value.exists ? value.bytes + "B" : "missing"}`).join(" ")}`);

if (JSON_OUT) {
	const out = resolve(JSON_OUT);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, JSON.stringify(result, null, 2) + "\n", "utf8");
	console.log(`report: ${out}`);
}
