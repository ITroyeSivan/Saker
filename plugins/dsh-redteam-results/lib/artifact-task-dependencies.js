import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export class TaskBlockedError extends Error {
	constructor(reason) { super(reason); this.name = "TaskBlockedError"; this.code = "TASK_NOT_READY"; }
}

export function normalizeTaskDependencies({ dependsOn = [], requiredArtifacts = [] } = {}) {
	if (!Array.isArray(dependsOn) || dependsOn.length > 64) throw new Error("depends_on 必须是至多 64 个任务 id");
	if (!Array.isArray(requiredArtifacts) || requiredArtifacts.length > 20) throw new Error("required_artifacts 必须是至多 20 个产物引用");
	const dependencies = [...new Set(dependsOn.map((id) => {
		if (typeof id !== "string" || !/^i[1-9]\d*$/.test(id)) throw new Error(`依赖任务 id 非法：${String(id)}`);
		return id;
	}))].sort();
	const artifacts = requiredArtifacts.map((item) => {
		if (!item || !dependencies.includes(item.taskId)) throw new Error("产物 taskId 必须在 depends_on 中");
		const file = item.path;
		if (typeof file !== "string" || !file || file.length > 300 || path.isAbsolute(file) || /^[a-z]:/i.test(file) || /[\x00-\x1f]/.test(file) || file.split(/[\\/]/).includes("..")) throw new Error("依赖产物必须是工作区内相对路径");
		if (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(item.sha256)) throw new Error("依赖产物需要完整 sha256；摘要文字不能替代产物");
		return { taskId: item.taskId, path: file.replace(/\\/g, "/"), sha256: item.sha256.toLowerCase() };
	}).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
	return { dependsOn: dependencies, requiredArtifacts: artifacts };
}

function sameScope(item, dependency) {
	if (item.sessionId && dependency.sessionId && item.sessionId !== dependency.sessionId) return "依赖来自其他会话";
	if (item.bucketId && dependency.bucketId && item.bucketId !== dependency.bucketId) return "依赖来自其他资产组";
	if (item.targetIds?.length && dependency.targetIds?.length && !item.targetIds.some((id) => dependency.targetIds.includes(id))) return "依赖资产范围不相交";
	return "";
}

export function assertTaskDependencies(st, item) {
	const byId = new Map((st?.intents || []).map((entry) => [entry.id, entry]));
	byId.set(item.id, item);
	const visiting = new Set();
	const visited = new Set();
	function visit(current) {
		if (visiting.has(current.id)) throw new Error(`任务依赖成环：${current.id}`);
		if (visited.has(current.id)) return;
		visiting.add(current.id);
		const normalized = normalizeTaskDependencies(current);
		for (const id of normalized.dependsOn) {
			const dependency = byId.get(id);
			if (!dependency?.task) throw new Error(`依赖执行任务不存在：${id}`);
			const bad = sameScope(current, dependency);
			if (bad) throw new Error(`${id}：${bad}`);
			visit(dependency);
		}
		visiting.delete(current.id);
		visited.add(current.id);
	}
	visit(item);
}

function artifactReason(workspace, reference, dependency) {
	try {
		if (!workspace) return "无法核对工作区产物";
		const root = fs.realpathSync(workspace);
		const file = fs.realpathSync(path.resolve(root, reference.path));
		const rel = path.relative(root, file);
		if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return "产物越出工作区";
		const declared = (dependency.task.artifacts || []).some((entry) => path.resolve(root, entry) === path.resolve(root, reference.path));
		if (!declared) return "前置任务未登记此产物";
		const stat = fs.statSync(file);
		if (!stat.isFile() || stat.size === 0 || stat.size > 16 * 1024 * 1024) return "产物为空、不是文件或超过 16 MiB";
		const hash = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
		return hash === reference.sha256 ? "" : "产物已改变，sha256 不一致";
	} catch { return "依赖产物不存在或不可读取"; }
}

/** Live readiness, shared by claim/start and Desktop. Hash integrity is not semantic validation. */
export function taskReadiness(st, item, workspace) {
	let blockedReason = "";
	try {
		assertTaskDependencies(st, item);
		if (item.status !== "open") blockedReason = "工作方向已关闭";
		else if (item.task?.state !== "queued") blockedReason = `任务状态为 ${item.task?.state || "无执行状态"}`;
		else if ((Number(item.task.attempts) || 0) >= (Number(item.task.maxAttempts) || 1)) blockedReason = "尝试次数已达上限";
		const byId = new Map((st?.intents || []).map((entry) => [entry.id, entry]));
		const checked = new Set();
		function requirements(current) {
			if (checked.has(current.id)) return "";
			checked.add(current.id);
			for (const id of current.dependsOn || []) {
				const dependency = byId.get(id);
				if (dependency.status === "blocked" || dependency.status === "dropped" || dependency.task.state !== "succeeded") return `等待前置任务 ${id}（${dependency.task.state}）`;
				const reason = requirements(dependency);
				if (reason) return reason;
			}
			for (const reference of current.requiredArtifacts || []) {
				const reason = artifactReason(workspace, reference, byId.get(reference.taskId));
				if (reason) return `${reference.taskId} / ${reference.path}：${reason}`;
			}
			return "";
		}
		if (!blockedReason) blockedReason = requirements(item);
	} catch (error) { blockedReason = error.message; }
	return { ready: !blockedReason, blockedReason };
}
