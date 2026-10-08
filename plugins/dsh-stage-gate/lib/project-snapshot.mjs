// 项目工作台快照（只读）：把「目标契约 → 准则/意图/任务 → 产物 → 待处理事项」
// 汇总成一份给宿主 web 页面用的 JSON。
//
// 只读**本工作区文件**（operation-state.json / gate-log.md / evidence-index.md /
// scan-reconcile.md / reports/）。**不读别的插件的 SQLite**——那是隐式耦合，
// 对方改一次 schema 这里就静默失效；需要 trace-vault / campaign-memory 的视图，
// 由各自标签页负责（离线报告脚本 `scripts/project-status.mjs` 才做跨库汇总）。
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { taskReadiness } from "./task-dependencies.mjs";

const STATE_FILE = "operation-state.json";
const GATE_LOG = "gate-log.md";
const EVIDENCE_INDEX = "evidence-index.md";
const SCAN_RECONCILE = "scan-reconcile.md";
const ASSET_INVENTORY = "asset-inventory.json";
const ATTACK_PLAN = "fingerprint-buckets.json";
const ATTACK_PROGRESS = "attack-progress.json";

function readJson(file) {
	try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

function taskStateLabel(state) {
	const labels = { queued: "排队", running: "进行中", succeeded: "已完成", failed: "失败", interrupted: "中断", cancelled: "已取消", open: "待处理", pending: "待处理" };
	return labels[state] || state || "待处理";
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

function artifactMeta(file, relPath, kind) {
	let bytes = 0;
	let mtime = 0;
	let text = "";
	try {
		bytes = statSync(file).size;
		mtime = statSync(file).mtimeMs;
		if (/\.(md|txt)$/i.test(file)) text = readFileSync(file, "utf8").slice(0, 16 * 1024);
	} catch { /* unreadable file still appears with zero metadata */ }
	const title = (text.match(/^#\s+(.+)$/m) || [])[1]?.trim() || "";
	const target = (text.match(/(?:漏洞\/问题\s*)?地址[：:]\s*(.+)$/m) || [])[1]?.trim() || "";
	return {
		name: file.split(/[\\/]/).pop(),
		relPath,
		absPath: file,
		kind,
		title,
		target,
		bytes,
		mtime: mtime ? new Date(mtime).toISOString() : "",
	};
}

/** List report and PoC artifacts one level deep; project workbench links to paths, not copies text. */
function listArtifacts(root, limit = 80) {
	const out = [];
	for (const [dirName, kind] of [["reports", "report"], ["exp", "poc"]]) {
		const dir = join(root, dirName);
		if (!existsSync(dir)) continue;
		try {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				if (!entry.isFile() || !/\.(md|html|py|txt|json)$/i.test(entry.name)) continue;
				out.push(artifactMeta(join(dir, entry.name), `${dirName}/${entry.name}`, kind));
			}
		} catch { /* unreadable artifact directory is reported as empty */ }
	}
	return out.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime))).slice(0, limit);
}

function groupArtifacts(artifacts) {
	const groups = new Map();
	for (const artifact of artifacts) {
		const key = artifact.target || "未标注目标";
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(artifact);
	}
	return [...groups.entries()].map(([target, files]) => ({ target, files }));
}

function buildTaskTree(tasks) {
	const nodes = new Map(tasks.map((task) => [task.id, { ...task, children: [] }]));
	const roots = [];
	for (const node of nodes.values()) {
		const parent = node.parentTaskId ? nodes.get(node.parentTaskId) : null;
		if (parent && parent.id !== node.id) parent.children.push(node);
		else roots.push(node);
	}
	const sort = (items) => {
		items.sort((a, b) => String(a.id).localeCompare(String(b.id)));
		for (const item of items) sort(item.children);
	};
	sort(roots);
	return roots;
}

function buildGraph(tasks, buckets) {
	const byBucket = new Map();
	for (const bucket of buckets) {
		byBucket.set(bucket.bucketId, {
			kind: "asset-group",
			id: bucket.bucketId,
			title: bucket.product || bucket.entryId || bucket.bucketId,
			entryId: bucket.entryId,
			status: bucket.status,
			owner: bucket.owner,
			assetIds: bucket.assetIds,
			representativeAssetId: bucket.representativeAssetId,
			reuseScore: bucket.reuseScore,
			verificationStatus: bucket.verificationStatus,
			spreadAllowed: bucket.spreadAllowed,
			gateEvidence: bucket.gateEvidence,
			gateNote: bucket.gateNote,
			tasks: [],
		});
	}
	const byTask = new Map(tasks.map((task) => [String(task.id), task]));
	const effectiveBucket = (task) => {
		const seen = new Set();
		let current = task;
		while (current && current.id && !seen.has(current.id)) {
			seen.add(current.id);
			if (current.bucketId) return String(current.bucketId);
			current = current.parentTaskId ? byTask.get(String(current.parentTaskId)) : null;
		}
		return "";
	};
	const ungrouped = [];
	for (const task of tasks) {
		const group = byBucket.get(effectiveBucket(task));
		if (group) group.tasks.push(task);
		else if (!task.parentTaskId) ungrouped.push(task);
	}
	const groups = [...byBucket.values()].sort((a, b) => {
		if (b.reuseScore !== a.reuseScore) return b.reuseScore - a.reuseScore;
		return String(a.id).localeCompare(String(b.id));
	});
	return {
		groups,
		ungrouped,
		groupCount: groups.length,
		taskCount: groups.reduce((sum, group) => sum + group.tasks.length, 0) + ungrouped.length,
	};
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
			stage: String(intent?.stage ?? ""),
			bucketId: String(intent?.bucketId ?? ""),
			targetIds: Array.isArray(intent?.targetIds) ? intent.targetIds : [],
			reuseScore: Number(intent?.reuseScore) || 0,
			parentTaskId: String(intent?.parentTaskId ?? ""),
			...(intent?.task && typeof intent.task === "object" ? intent.task : {}),
			dependsOn: intent?.dependsOn || [],
			...taskReadiness(state, intent, root),
		}))
		.filter((task) => task.state);

	const openCriteria = criteria.filter((item) => item && item.status !== "met" && item.status !== "failed");
	const openIntents = intents.filter((item) => item?.status === "open");
	const interrupted = tasks.filter((item) => item.state === "interrupted");
	const conflicted = tasks.filter((item) => Array.isArray(item.conflicts) && item.conflicts.length > 0);

	const evidenceRows = root ? countText(join(root, EVIDENCE_INDEX), /^\|\s*E\d+\s*\|/gm) : 0;
	const pendingScanRows = root ? countText(join(root, SCAN_RECONCILE), /\|\s*待处置/g) : 0;
	const gateLine = root ? lastLine(join(root, GATE_LOG)) : "";
	const artifacts = root ? listArtifacts(root) : [];
	const reports = artifacts.filter((item) => item.kind === "report");
	const reportGroups = groupArtifacts(artifacts);
	const inventory = root ? readJson(join(root, ASSET_INVENTORY)) : null;
	const plan = root ? readJson(join(root, ATTACK_PLAN)) : null;
	const attackProgress = root ? readJson(join(root, ATTACK_PROGRESS)) : null;
	const planBuckets = Array.isArray(plan?.buckets) ? plan.buckets : [];
	const taskByBucket = new Map(tasks.filter((task) => task.bucketId).map((task) => [String(task.bucketId), task]));
	const buckets = planBuckets.map((bucket) => {
		const task = taskByBucket.get(String(bucket?.bucketId ?? ""));
		const record = attackProgress?.buckets?.[String(bucket?.bucketId ?? "")];
		const verificationStatus = record?.outcome === "confirmed" ? "verified" : record?.outcome === "refuted" ? "refuted" : "pending";
		return {
			bucketId: String(bucket?.bucketId ?? ""),
			entryId: String(bucket?.entryId ?? ""),
			product: String(bucket?.product ?? ""),
			assetIds: Array.isArray(bucket?.assetIds) ? bucket.assetIds : [],
			representativeAssetId: String(bucket?.representativeAssetId || bucket?.assetIds?.[0] || ""),
			reuseScore: Number(bucket?.reuseScore) || 0,
			status: String(task?.state || bucket?.status || "queued"),
			owner: String(task?.owner || bucket?.owner || ""),
			verificationStatus,
			spreadAllowed: verificationStatus === "verified",
			gateEvidence: String(record?.evidence ?? ""),
			gateNote: String(record?.note ?? ""),
		};
	});
	const taskTree = buildTaskTree(tasks);
	const graph = buildGraph(tasks, buckets);

	// 台账存在但 goal 为空 = 模型跳过了 operation_goal。
	// 这时 criteria 也是 0 —— 但 0/0 读起来像"全部收口"，其实是"根本没立标准"，
	// 必须显式区分，否则工作台会把没登记目标的项目显示成健康状态。
	const goalText = String(typeof state?.goal === "string" ? state.goal : state?.goal?.text ?? state?.goal?.summary ?? "");
	const goalRegistered = goalText.trim().length > 0;
	const assetCount = Array.isArray(inventory?.assets) ? inventory.assets.length : 0;
	const runningBucket = buckets.find((bucket) => bucket.status === "running");
	const failedBucket = buckets.find((bucket) => ["failed", "interrupted", "cancelled"].includes(bucket.status));
	let currentStage = "S0";
	if (goalRegistered) currentStage = "S1";
	if (assetCount > 0) currentStage = "S2";
	if (buckets.length > 0) currentStage = "S4";
	if (runningBucket || failedBucket) currentStage = "S5";
	else if (reports.length > 0) currentStage = "S6";
	const flow = {
		current: currentStage,
		assets: assetCount,
		buckets: buckets.length,
		running: buckets.filter((bucket) => bucket.status === "running").length,
		queued: buckets.filter((bucket) => bucket.status === "queued").length,
		blocked: buckets.filter((bucket) => ["failed", "interrupted", "cancelled"].includes(bucket.status)).length,
		stages: [
			{ id: "S0", label: "确认目标", state: goalRegistered ? "done" : (currentStage === "S0" ? "current" : "pending") },
			{ id: "S1", label: "快速摸底", state: assetCount > 0 ? "done" : (currentStage === "S1" ? "current" : "pending") },
			{ id: "S2", label: "整理合并", state: assetCount > 0 ? "done" : "pending" },
			{ id: "S3", label: "按指纹归类", state: buckets.length > 0 ? "done" : "pending" },
			{ id: "S4", label: "排优先级", state: buckets.length > 0 ? "done" : "pending" },
			{ id: "S5", label: "先验证再铺开", state: currentStage === "S5" ? "current" : (currentStage === "S6" ? "done" : "pending") },
			{ id: "S6", label: "RCE 证据与报告（停止）", state: currentStage === "S6" ? "current" : (reports.length > 0 ? "done" : "pending") },
		],
		buckets,
	};

	const attention = [];
	for (const item of tasks.filter((task) => task.state === "queued" && !task.ready)) attention.push({ kind: "等待前置条件", text: `${item.id}：${item.blockedReason}` });
	if (state && !goalRegistered) {
		attention.push({ kind: "目标未登记", text: "还没登记任务目标——完成标准 0/0 不代表已经做完" });
	}
	for (const item of openCriteria) attention.push({ kind: "未完成标准", text: `${item.id}：${item.text || item.summary || ""}` });
	for (const item of openIntents) attention.push({ kind: "未完成方向", text: `${item.id}：${item.summary || ""}（${taskStateLabel(item?.task?.state)}）` });
	for (const item of interrupted) attention.push({ kind: "中断任务", text: `${item.id}：${item.summary || ""}（${item.error || "需要恢复或重试"}）` });
	for (const item of conflicted) {
		const last = item.conflicts[item.conflicts.length - 1] || {};
		attention.push({
			kind: "任务结果不一致",
			text: `${item.id}：${item.summary || ""}（当前 ${taskStateLabel(item.state)}，收到 ${item.conflicts.length} 条不同结果；最近 ${taskStateLabel(last.from)}→${taskStateLabel(last.to)}：${last.detail || ""}）`,
		});
	}
	if (pendingScanRows > 0) attention.push({ kind: "扫描对账", text: `${pendingScanRows} 条命中仍为“待处置”` });
	if (!gateLine) attention.push({ kind: "阶段检查", text: `尚未找到 ${GATE_LOG} 记录` });
	else if (/FAIL|失败|reject/i.test(gateLine)) attention.push({ kind: "阶段检查", text: gateLine });

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
			stage: String(task.stage ?? ""),
			bucketId: String(task.bucketId ?? ""),
			targetIds: Array.isArray(task.targetIds) ? task.targetIds : [],
			reuseScore: Number(task.reuseScore) || 0,
			parentTaskId: String(task.parentTaskId ?? ""),
			dependsOn: task.dependsOn,
			ready: task.ready,
			blockedReason: task.blockedReason,
		})),
		taskTree,
		graph,
		flow,
		flowLabel: flow.stages.find((stage) => stage.id === flow.current)?.label || flow.current,
		artifacts: {
			evidenceRows,
			pendingScanRows,
			gateLine,
			reports,
			reportGroups,
			files: { state: STATE_FILE, gateLog: GATE_LOG, evidenceIndex: EVIDENCE_INDEX, scanReconcile: SCAN_RECONCILE },
			assetInventory: ASSET_INVENTORY,
			attackPlan: ATTACK_PLAN,
			attackProgress: ATTACK_PROGRESS,
		},
		counts: {
			openCriteria: openCriteria.length,
			ready: tasks.filter((item) => item.ready).length,
			waiting: tasks.filter((item) => item.state === "queued" && !item.ready).length,
			openIntents: openIntents.length,
			interrupted: interrupted.length,
			conflicts: conflicted.length,
			reports: reports.length,
		},
		attention,
	};
}
