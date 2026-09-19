#!/usr/bin/env node
// Read-only project workbench snapshot for one workspace.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";

const arg = (name, fallback) => {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] : fallback;
};

const workspace = resolve(arg("workspace", process.cwd()));
const home = resolve(arg("home", process.env.DSH_HOME || join(homedir(), ".dsh")));
const workspaceName = basename(workspace).slice(0, 60);
const workspaceKey = `${workspaceName}@${createHash("sha256").update(workspace).digest("hex").slice(0, 8)}`;
const jsonOut = arg("json", "");
const htmlOut = arg("html", "");

function readJson(file) {
	try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

function countText(file, pattern) {
	try { return (readFileSync(file, "utf8").match(pattern) || []).length; } catch { return 0; }
}

function filesUnder(dir, limit = 100) {
	if (!existsSync(dir)) return [];
	const out = [];
	const stack = [dir];
	while (stack.length && out.length < limit) {
		const current = stack.pop();
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) stack.push(full);
			else if (entry.isFile()) out.push(full);
			if (out.length >= limit) break;
		}
	}
	return out.sort();
}

function escapeHtml(value) {
	return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function renderHtml(report) {
	const rows = (items, empty) => items.length
		? items.map((item) => `<tr><td>${escapeHtml(item.id || "")}</td><td>${escapeHtml(item.summary || item.text || "")}</td><td>${escapeHtml(item.state || "")}</td></tr>`).join("")
		: `<tr><td colspan="3">${escapeHtml(empty)}</td></tr>`;
	const reports = report.reports.length
		? report.reports.map((file) => `<li>${escapeHtml(file.replace(workspace, "").replace(/^[\\/]/, ""))}</li>`).join("")
		: "<li>暂无报告</li>";
	const attention = report.attention.length
		? report.attention.map((item) => `<li><b>${escapeHtml(item.kind)}</b>：${escapeHtml(item.text)}</li>`).join("")
		: "<li class=\"ok\">当前无待处理项</li>";
	const jobs = report.jobs.combined.length
		? report.jobs.combined.map((job) => `<tr><td>${escapeHtml(job.source)}</td><td>${escapeHtml(job.id)}</td><td>${escapeHtml(job.tool || job.summary || "")}</td><td>${escapeHtml(job.state)}</td><td>${escapeHtml(job.error || "")}</td></tr>`).join("")
		: "<tr><td colspan=\"5\">暂无任务</td></tr>";
	const memories = report.memory.rows.length
		? report.memory.rows.map((row) => `<tr><td>${escapeHtml(row.mode)}</td><td>${escapeHtml(row.kind)}</td><td>${escapeHtml(row.title)}</td><td>${row.usageCount}</td><td>${row.feedbackScore}</td></tr>`).join("")
		: "<tr><td colspan=\"5\">暂无项目记忆</td></tr>";
	return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>项目工作台 · ${escapeHtml(report.project)}</title>
<style>
body{margin:0;background:#f3f5f7;color:#17212b;font:14px/1.55 system-ui,"Microsoft YaHei",sans-serif}
header{padding:28px 32px;background:#16212b;color:#fff}main{max-width:1180px;margin:0 auto;padding:24px 20px 48px}
h1{margin:0 0 6px;font-size:24px}h2{font-size:16px;margin:0 0 12px}.muted{color:#66717c}
.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;background:#d6dce1;border:1px solid #d6dce1;margin:18px 0 26px}
.metric{background:#fff;padding:14px 16px}.metric b{display:block;font-size:22px}.section{background:#fff;border-top:3px solid #2f81f7;padding:18px 20px;margin:16px 0}
table{width:100%;border-collapse:collapse}th,td{text-align:left;border-bottom:1px solid #e7ebee;padding:9px 8px;vertical-align:top}th{font-size:12px;color:#66717c;text-transform:uppercase}
code{background:#eef2f5;padding:2px 5px;border-radius:4px}.ok{color:#1a7f37}.warn{color:#9a6700}.bad{color:#c83232}
ul{margin:8px 0 0;padding-left:20px}
</style></head><body><header><h1>${escapeHtml(report.project)}</h1><div class="muted">${escapeHtml(report.goal || "尚未登记目标")} · ${escapeHtml(report.generatedAt)}</div></header>
<main>
<div class="metrics">
<div class="metric"><span class="muted">需处理</span><b class="${report.attention.length ? "warn" : "ok"}">${report.attention.length}</b></div>
<div class="metric"><span class="muted">准则</span><b class="${report.goalRegistered === false ? "warn" : ""}">${report.goalRegistered === false ? "未登记" : `${report.criteria.total - report.criteria.open}/${report.criteria.total}`}</b></div>
<div class="metric"><span class="muted">意图</span><b>${report.intents.total - report.intents.open}/${report.intents.total}</b></div>
<div class="metric"><span class="muted">未完成任务</span><b>${report.tasks.open}</b></div>
<div class="metric"><span class="muted">证据行</span><b>${report.evidence.count}</b></div>
<div class="metric"><span class="muted">待处置命中</span><b>${report.scanReconcile.pending}</b></div>
<div class="metric"><span class="muted">报告产物</span><b>${report.reports.length}</b></div>
</div>
<section class="section"><h2>需要处理</h2><ul>${attention}</ul></section>
<section class="section"><h2>未收口准则</h2><table><thead><tr><th>ID</th><th>准则</th><th>状态</th></tr></thead><tbody>${rows(report.criteria.openItems, "无")}</tbody></table></section>
<section class="section"><h2>未收口意图 / 任务</h2><table><thead><tr><th>ID</th><th>方向</th><th>执行状态</th></tr></thead><tbody>${rows(report.intents.openItems.map((item) => ({ id: item.id, summary: item.summary, state: item.task?.state || "open" })), "无")}</tbody></table></section>
<section class="section"><h2>统一 Job 视图</h2><table><thead><tr><th>来源</th><th>ID</th><th>任务 / 工具</th><th>状态</th><th>错误</th></tr></thead><tbody>${jobs}</tbody></table></section>
<section class="section"><h2>项目长期记忆</h2><div class="muted">总数 ${report.memory.total} · 有帮助 ${report.memory.feedback.helpful} · 误导 ${report.memory.feedback.misleading} · 已退役 ${report.memory.feedback.obsolete}</div><table><thead><tr><th>模式</th><th>类型</th><th>标题</th><th>使用</th><th>反馈分</th></tr></thead><tbody>${memories}</tbody></table></section>
<section class="section"><h2>项目产物</h2><ul><li><code>${escapeHtml(report.evidence.index)}</code></li><li><code>${escapeHtml(report.scanReconcile.file)}</code></li><li>${escapeHtml(report.lastGate || "暂无 gate-log 记录")}</li></ul><ul>${reports}</ul></section>
</main></body></html>`;
}

const stateFile = join(workspace, "operation-state.json");
const state = readJson(stateFile);
const criteria = Array.isArray(state?.criteria) ? state.criteria : [];
const intents = Array.isArray(state?.intents) ? state.intents : [];
const tasks = intents.map((intent) => ({ id: intent.id, summary: intent.summary, ...(intent.task || {}) })).filter((task) => task.state);
const openCriteria = criteria.filter((item) => item && item.status !== "met" && item.status !== "failed");
const openIntents = intents.filter((item) => item?.status === "open");
const runningTasks = tasks.filter((item) => item.state === "running" || item.state === "queued" || item.state === "interrupted");
const findingsFiles = filesUnder(join(workspace, "reports"));
const evidenceCount = countText(join(workspace, "evidence-index.md"), /^\|\s*E\d+\s*\|/gm);
const pendingScanRows = countText(join(workspace, "scan-reconcile.md"), /\|\s*待处置/g);
const gateLog = (() => {
	try {
		const lines = readFileSync(join(workspace, "gate-log.md"), "utf8").split(/\r?\n/).filter(Boolean);
		return lines.at(-1) || "";
	} catch { return ""; }
})();

const traceJobs = await (async () => {
	const file = join(home, "trace-vault", "traces.db");
	if (!existsSync(file)) return { path: file, rows: [] };
	try {
		const { openStore, listRecent } = await import("../plugins/dsh-trace-vault/lib/store.js");
		const store = openStore(file);
		try {
			const rows = listRecent(store, { limit: 60 })
				.filter((row) => row.outcome === "running" || row.outcome === "interrupted")
				.map((row) => ({
					source: "trace-vault",
					id: row.id,
					tool: row.tool,
					state: row.outcome,
					error: row.result || "",
					sessionId: row.sessionId,
					lastSeen: row.lastSeen,
				}));
			return { path: file, rows };
		} finally {
			store.close();
		}
	} catch (error) {
		return { path: file, rows: [], error: error instanceof Error ? error.message : String(error) };
	}
})();

const stageGateJobs = runningTasks.map((task) => ({
	source: "stage-gate",
	id: task.id,
	summary: task.summary,
	state: task.state,
	owner: task.owner || "",
	progress: task.progress ?? 0,
	error: task.error || "",
}));
const combinedJobs = [...stageGateJobs, ...traceJobs.rows];

const projectMemory = await (async () => {
	const file = join(home, "campaign-memory", "memory.db");
	if (!existsSync(file)) return { path: file, total: 0, byMode: {}, feedback: { helpful: 0, misleading: 0, obsolete: 0 }, rows: [] };
	try {
		const { openStore } = await import("../plugins/dsh-campaign-memory/lib/store.js");
		const store = openStore(file);
		try {
			const grouped = store.db.prepare(`
				SELECT mode,
					COUNT(*) AS total,
					SUM(CASE WHEN feedback_score > 0 THEN 1 ELSE 0 END) AS helpful,
					SUM(CASE WHEN feedback_score < 0 AND feedback_score > -5 THEN 1 ELSE 0 END) AS misleading,
					SUM(CASE WHEN feedback_score <= -5 THEN 1 ELSE 0 END) AS obsolete
				FROM memories
				WHERE workspace_key = ? OR (workspace_key = '' AND workspace = ?)
				GROUP BY mode
			`).all(workspaceKey, workspaceName);
			const rows = store.db.prepare(`
				SELECT id, mode, kind, title, usage_count, feedback_score, last_used_at, updated_at
				FROM memories
				WHERE workspace_key = ? OR (workspace_key = '' AND workspace = ?)
				ORDER BY (usage_count + feedback_score) DESC, updated_at DESC
				LIMIT 12
			`).all(workspaceKey, workspaceName).map((row) => ({
				id: row.id,
				mode: row.mode,
				kind: row.kind,
				title: row.title,
				usageCount: Number(row.usage_count) || 0,
				feedbackScore: Number(row.feedback_score) || 0,
				lastUsedAt: row.last_used_at,
			}));
			const byMode = Object.fromEntries(grouped.map((row) => [row.mode, {
				total: Number(row.total) || 0,
				helpful: Number(row.helpful) || 0,
				misleading: Number(row.misleading) || 0,
				obsolete: Number(row.obsolete) || 0,
			}]));
			return {
				path: file,
				total: grouped.reduce((sum, row) => sum + Number(row.total || 0), 0),
				byMode,
				feedback: {
					helpful: grouped.reduce((sum, row) => sum + Number(row.helpful || 0), 0),
					misleading: grouped.reduce((sum, row) => sum + Number(row.misleading || 0), 0),
					obsolete: grouped.reduce((sum, row) => sum + Number(row.obsolete || 0), 0),
				},
				rows,
			};
		} finally {
			store.close();
		}
	} catch (error) {
		return { path: file, total: 0, byMode: {}, feedback: { helpful: 0, misleading: 0, obsolete: 0 }, rows: [], error: error instanceof Error ? error.message : String(error) };
	}
})();

const attention = [];
// 台账存在但 goal 为空 = 模型跳过了 operation_goal。
// 此时 criteria 也是 0，但「0/0 closed」读起来像"全部收口"，其实是"没立过标准"。
// 与项目工作台客户端保持同一套语义，避免两边说法不一致。
const goalRegistered = String(state?.goal || "").trim().length > 0;
if (state && !goalRegistered) {
	attention.push({ kind: "目标契约", text: "尚未登记目标契约（operation_goal）——准则 0/0 不等于已收口" });
}
for (const item of openCriteria) attention.push({ kind: "未收口准则", text: `${item.id}：${item.text || item.summary || ""}` });
for (const item of openIntents) attention.push({ kind: "未收口意图", text: `${item.id}：${item.summary || ""}（${item.task?.state || "open"}）` });
for (const item of runningTasks.filter((task) => task.state === "interrupted")) {
	attention.push({ kind: "中断任务", text: `${item.id}：${item.summary || ""}（${item.error || "需要恢复或重试"}）` });
}
// 任务结果冲突（P1-9）：台账终态与执行体后来的结论不一致——状态没有被覆盖，
// 但必须让人看见，否则"模型说成功、子代理其实失败"会静默留在台账里。
for (const item of intents) {
	const conflicts = Array.isArray(item?.task?.conflicts) ? item.task.conflicts : [];
	if (conflicts.length === 0) continue;
	const last = conflicts[conflicts.length - 1] || {};
	attention.push({
		kind: "任务结果冲突",
		text: `${item.id}：${item.summary || ""}（终态 ${item.task.state}，收到 ${conflicts.length} 条不同结果；最近 ${last.from || "?"}→${last.to || "?"}：${last.detail || ""}）`,
	});
}
if (pendingScanRows > 0) attention.push({ kind: "扫描对账", text: `${pendingScanRows} 条命中仍为“待处置”` });
if (!gateLog) attention.push({ kind: "阶段门禁", text: "尚未找到 gate-log.md 记录" });
if (gateLog && /FAIL|失败|reject/i.test(gateLog)) attention.push({ kind: "阶段门禁", text: gateLog });
for (const job of traceJobs.rows.filter((row) => row.state === "interrupted")) {
	attention.push({ kind: "中断工具调用", text: `${job.id}：${job.tool || "unknown"}（${job.error || "无错误摘要"}）` });
}
if (projectMemory.feedback.misleading > 0) {
	attention.push({ kind: "记忆治理", text: `本项目有 ${projectMemory.feedback.misleading} 条误导记忆待复核` });
}

const result = {
	generatedAt: new Date().toISOString(),
	workspace,
	project: basename(workspace),
	goal: state?.goal || "",
	goalRegistered,
	criteria: { total: criteria.length, open: openCriteria.length, openItems: openCriteria.map((item) => ({ id: item.id, text: item.text })) },
	intents: { total: intents.length, open: openIntents.length, openItems: openIntents.map((item) => ({ id: item.id, summary: item.summary, task: item.task || null })) },
	tasks: { total: tasks.length, open: runningTasks.length, openItems: runningTasks },
	evidence: { count: evidenceCount, index: "evidence-index.md" },
	scanReconcile: { pending: pendingScanRows, file: "scan-reconcile.md" },
	reports: findingsFiles.slice(0, 30),
	lastGate: gateLog,
	attention,
	jobs: {
		home,
		traceStore: traceJobs.path,
		traceError: traceJobs.error || "",
		combined: combinedJobs,
		counts: Object.fromEntries(["queued", "running", "succeeded", "failed", "cancelled", "interrupted"].map((state) => [state, combinedJobs.filter((job) => job.state === state).length])),
	},
	memory: projectMemory,
};

console.log(`project: ${result.project}`);
console.log(`goal: ${result.goal || "(unregistered)"}`);
console.log(`criteria: ${result.goalRegistered === false ? "未登记（目标契约未登记）" : `${result.criteria.total - result.criteria.open}/${result.criteria.total} closed`}`);
console.log(`intents: ${result.intents.total - result.intents.open}/${result.intents.total} closed`);
console.log(`tasks: ${result.tasks.open} open / ${result.tasks.total}`);
console.log(`evidence rows: ${result.evidence.count}; pending scan rows: ${result.scanReconcile.pending}; reports: ${result.reports.length}`);
console.log(`attention: ${result.attention.length}`);
console.log(`jobs: stage=${stageGateJobs.length}; trace=${traceJobs.rows.length}; interrupted=${result.jobs.counts.interrupted}`);
console.log(`memory: total=${result.memory.total} helpful=${result.memory.feedback.helpful} misleading=${result.memory.feedback.misleading} obsolete=${result.memory.feedback.obsolete}`);
if (result.lastGate) console.log(`last gate: ${result.lastGate}`);

if (jsonOut) {
	const out = resolve(jsonOut);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, JSON.stringify(result, null, 2) + "\n", "utf8");
	console.log(`report: ${out}`);
}
if (htmlOut) {
	const out = resolve(htmlOut);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, renderHtml(result), "utf8");
	console.log(`html: ${out}`);
}
