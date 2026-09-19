// 项目工作台快照（只读）：把「目标契约 → 准则/意图/任务 → 产物 → 待处理事项」
// 汇总成一份给宿主 web 页面用的 JSON。
//
// 只读**本工作区文件**（operation-state.json / gate-log.md / evidence-index.md /
// scan-reconcile.md / reports/）。**不读别的插件的 SQLite**——那是隐式耦合，
// 对方改一次 schema 这里就静默失效；需要 trace-vault / campaign-memory 的视图，
// 由各自标签页负责（离线报告脚本 `scripts/project-status.mjs` 才做跨库汇总）。
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const STATE_FILE = "operation-state.json";
const GATE_LOG = "gate-log.md";
const EVIDENCE_INDEX = "evidence-index.md";
const SCAN_RECONCILE = "scan-reconcile.md";

function readJson(file) {
	try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

function countText(file, pattern) {
	try { return (readFileSync(file, "utf8").match(pattern) || []).length; } catch { return 0; }
}

function lastLine(file) {
	try {
		const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
		return lines.at(-1) || "";
	} catch { return ""; }
}

/** 只列一层报告文件（reports/ 下的 md/html/py），按修改时间从新到旧。 */
function listReports(dir, limit = 40) {
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && /\.(md|html|py|txt|json)$/i.test(entry.name))
			.map((entry) => {
				const full = join(dir, entry.name);
				let mtime = 0;
				try { mtime = statSync(full).mtimeMs; } catch { /* 读不到时间就不排它 */ }
				return { name: entry.name, bytes: (() => { try { return statSync(full).size; } catch { return 0; } })(), mtime };
			})
			.sort((a, b) => b.mtime - a.mtime)
			.slice(0, limit)
			.map((item) => ({ name: item.name, bytes: item.bytes, mtime: item.mtime ? new Date(item.mtime).toISOString() : "" }));
	} catch { return []; }
}

/**
 * @param {string} workspace 工作区根（绝对路径）
 * @returns 项目工作台快照；工作区不存在/没有台账时也返回结构完整的结果（字段为空）
 */
export function projectSnapshot(workspace, { now = new Date() } = {}) {
	const root = String(workspace ?? "").trim();
	const state = root ? readJson(join(root, STATE_FILE)) : null;
	const criteria = Array.isArray(state?.criteria) ? state.criteria : [];
	const intents = Array.isArray(state?.intents) ? state.intents : [];
	const tasks = intents
		.map((intent) => ({
			id: String(intent?.id ?? ""),
			summary: String(intent?.summary ?? ""),
			status: String(intent?.status ?? "open"),
			...(intent?.task && typeof intent.task === "object" ? intent.task : {}),
		}))
		.filter((task) => task.state);

	const openCriteria = criteria.filter((item) => item && item.status !== "met" && item.status !== "failed");
	const openIntents = intents.filter((item) => item?.status === "open");
	const interrupted = tasks.filter((item) => item.state === "interrupted");
	const conflicted = tasks.filter((item) => Array.isArray(item.conflicts) && item.conflicts.length > 0);

	const evidenceRows = root ? countText(join(root, EVIDENCE_INDEX), /^\|\s*E\d+\s*\|/gm) : 0;
	const pendingScanRows = root ? countText(join(root, SCAN_RECONCILE), /\|\s*待处置/g) : 0;
	const gateLine = root ? lastLine(join(root, GATE_LOG)) : "";
	const reports = root ? listReports(join(root, "reports")) : [];

	// 台账存在但 goal 为空 = 模型跳过了 operation_goal。
	// 这时 criteria 也是 0 —— 但 0/0 读起来像"全部收口"，其实是"根本没立标准"，
	// 必须显式区分，否则工作台会把没登记目标的项目显示成健康状态。
	const goalText = String(typeof state?.goal === "string" ? state.goal : state?.goal?.text ?? state?.goal?.summary ?? "");
	const goalRegistered = goalText.trim().length > 0;

	const attention = [];
	if (state && !goalRegistered) {
		attention.push({ kind: "目标契约", text: "尚未登记目标契约（operation_goal）——准则 0/0 不等于已收口" });
	}
	for (const item of openCriteria) attention.push({ kind: "未收口准则", text: `${item.id}：${item.text || item.summary || ""}` });
	for (const item of openIntents) attention.push({ kind: "未收口意图", text: `${item.id}：${item.summary || ""}（${item?.task?.state || "open"}）` });
	for (const item of interrupted) attention.push({ kind: "中断任务", text: `${item.id}：${item.summary || ""}（${item.error || "需要恢复或重试"}）` });
	for (const item of conflicted) {
		const last = item.conflicts[item.conflicts.length - 1] || {};
		attention.push({
			kind: "任务结果冲突",
			text: `${item.id}：${item.summary || ""}（终态 ${item.state}，收到 ${item.conflicts.length} 条不同结果；最近 ${last.from || "?"}→${last.to || "?"}：${last.detail || ""}）`,
		});
	}
	if (pendingScanRows > 0) attention.push({ kind: "扫描对账", text: `${pendingScanRows} 条命中仍为“待处置”` });
	if (!gateLine) attention.push({ kind: "阶段门禁", text: `尚未找到 ${GATE_LOG} 记录` });
	else if (/FAIL|失败|reject/i.test(gateLine)) attention.push({ kind: "阶段门禁", text: gateLine });

	return {
		workspace: root,
		name: root ? basename(root) : "",
		generatedAt: now.toISOString(),
		hasLedger: state !== null,
		goal: goalText,
		goalRegistered,
		criteria: {
			total: criteria.length,
			met: criteria.filter((item) => item?.status === "met").length,
			failed: criteria.filter((item) => item?.status === "failed").length,
			open: openCriteria.length,
			openItems: openCriteria.map((item) => ({ id: String(item?.id ?? ""), text: String(item?.text ?? item?.summary ?? "") })),
		},
		intents: {
			total: intents.length,
			open: openIntents.length,
			openItems: openIntents.map((item) => ({ id: String(item?.id ?? ""), summary: String(item?.summary ?? ""), task: item?.task ?? null })),
		},
		tasks: tasks.map((task) => ({
			id: task.id,
			summary: task.summary,
			status: task.status,
			state: String(task.state ?? ""),
			owner: String(task.owner ?? ""),
			attempts: Number(task.attempts) || 0,
			maxAttempts: Number(task.maxAttempts) || 1,
			progress: Number(task.progress) || 0,
			error: String(task.error ?? ""),
			result: String(task.result ?? ""),
			conflicts: Array.isArray(task.conflicts) ? task.conflicts : [],
		})),
		artifacts: {
			evidenceRows,
			pendingScanRows,
			gateLine,
			reports,
			files: { state: STATE_FILE, gateLog: GATE_LOG, evidenceIndex: EVIDENCE_INDEX, scanReconcile: SCAN_RECONCILE },
		},
		counts: {
			openCriteria: openCriteria.length,
			openIntents: openIntents.length,
			interrupted: interrupted.length,
			conflicts: conflicted.length,
			reports: reports.length,
		},
		attention,
	};
}
