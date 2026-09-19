#!/usr/bin/env node
// Read-only memory effectiveness report: 写入 → 召回窗口 → 读取 → 反馈 → 项目任务结果。
//
// 只回答「记忆有没有被用起来、用了之后项目推进得怎样」，不做因果声明：
// 关联分组只在样本量达标时输出，样本不足时明确标注，避免把 3 条记忆说成"提升 40%"。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const index = argv.indexOf(`--${name}`);
	return index >= 0 ? argv[index + 1] : fallback;
};
const argList = (name) => {
	const out = [];
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === `--${name}` && argv[i + 1]) out.push(argv[i + 1]);
	}
	return out;
};

const HOME = resolve(arg("home", process.env.DSH_HOME || join(homedir(), ".dsh")));
const JSON_OUT = arg("json", "");
const MIN_SAMPLE = Math.max(1, Number(arg("min-sample", "3")) || 3);
const rawWorkspaces = argList("workspace");
const workspaces = rawWorkspaces.map((dir) => resolve(dir));

/** 与 campaign-memory 一致的键位：basename(≤60) + "@" + sha256(路径) 前 8 位。 */
function workspaceKeys(dir, raw) {
	const name = basename(dir).slice(0, 60);
	const keys = new Set([`${name}@${createHash("sha256").update(dir).digest("hex").slice(0, 8)}`]);
	// 旧行可能用未 resolve 的原始 cwd 计算，保留候选键位（仅用于匹配，不写库）
	if (typeof raw === "string" && raw !== "" && raw !== dir) {
		keys.add(`${name}@${createHash("sha256").update(raw).digest("hex").slice(0, 8)}`);
	}
	return { name, keys: [...keys] };
}

function readLedger(dir) {
	try {
		const state = JSON.parse(readFileSync(join(dir, "operation-state.json"), "utf8"));
		return state && typeof state === "object" ? state : null;
	} catch { return null; }
}

function rate(part, whole) {
	return whole > 0 ? Number((part / whole).toFixed(3)) : null;
}

/** 项目推进度：准则/意图的「有结论」比例，任务的交付比例。 */
function outcomeOf(state) {
	if (!state) return { present: false };
	const criteria = Array.isArray(state.criteria) ? state.criteria : [];
	const intents = Array.isArray(state.intents) ? state.intents : [];
	const settledCriteria = criteria.filter((c) => c?.status === "met" || c?.status === "failed").length;
	const settledIntents = intents.filter((i) => "done blocked dropped".split(" ").includes(i?.status)).length;
	const taskStates = {};
	for (const intent of intents) {
		const st = intent?.task?.state;
		if (typeof st === "string" && st !== "") taskStates[st] = (taskStates[st] || 0) + 1;
	}
	const succeeded = taskStates.succeeded || 0;
	const failed = taskStates.failed || 0;
	const interrupted = taskStates.interrupted || 0;
	return {
		present: true,
		criteria: { total: criteria.length, settled: settledCriteria, rate: rate(settledCriteria, criteria.length) },
		intents: { total: intents.length, settled: settledIntents, rate: rate(settledIntents, intents.length) },
		tasks: {
			states: taskStates,
			successRate: rate(succeeded, succeeded + failed),
			deliveryRate: rate(succeeded, succeeded + failed + interrupted),
		},
	};
}

const result = {
	generatedAt: new Date().toISOString(),
	home: HOME,
	store: join(HOME, "campaign-memory", "memory.db"),
	funnel: { written: 0, read: 0, injectionWindow: 0, helpful: 0, misleading: 0, obsolete: 0 },
	byKind: {},
	workspaces: [],
	association: { verdict: "样本不足", minSample: MIN_SAMPLE, groups: {}, disclaimer: "关联不是因果：这里只比较「有被读取过的记忆」与「没有」的项目推进度。" },
};

const storeFile = result.store;
if (!existsSync(storeFile)) {
	result.error = "记忆库不存在（本机还没有写入过战役记忆）";
} else {
	const { openStore, topForInjection } = await import("../plugins/dsh-campaign-memory/lib/store.js");
	const store = openStore(storeFile);
	try {
		const totals = store.db.prepare(`
			SELECT
				COUNT(*) AS written,
				SUM(CASE WHEN usage_count > 0 THEN 1 ELSE 0 END) AS read,
				SUM(CASE WHEN feedback_score > 0 THEN 1 ELSE 0 END) AS helpful,
				SUM(CASE WHEN feedback_score < 0 AND feedback_score > -5 THEN 1 ELSE 0 END) AS misleading,
				SUM(CASE WHEN feedback_score <= -5 THEN 1 ELSE 0 END) AS obsolete
			FROM memories
		`).get();
		result.funnel = {
			written: Number(totals.written) || 0,
			read: Number(totals.read) || 0,
			injectionWindow: 0,
			helpful: Number(totals.helpful) || 0,
			misleading: Number(totals.misleading) || 0,
			obsolete: Number(totals.obsolete) || 0,
		};

		// 当前召回窗口：完全走插件自己的 topForInjection（不复制排序逻辑），按 (mode, 工作区) 分组各取前 3。
		const groups = store.db.prepare(`
			SELECT DISTINCT mode, workspace, workspace_key FROM memories
			WHERE (expires_at IS NULL OR expires_at > datetime('now')) AND COALESCE(feedback_score, 0) > -5
		`).all();
		const windowIds = new Set();
		for (const group of groups) {
			const rows = topForInjection(store, String(group.mode), String(group.workspace || ""), 3, String(group.workspace_key || ""));
			for (const row of rows) windowIds.add(row.id);
		}
		result.funnel.injectionWindow = windowIds.size;

		const kindRows = store.db.prepare(`
			SELECT kind,
				COUNT(*) AS total,
				SUM(CASE WHEN usage_count > 0 THEN 1 ELSE 0 END) AS read,
				SUM(CASE WHEN feedback_score > 0 THEN 1 ELSE 0 END) AS helpful,
				SUM(CASE WHEN feedback_score < 0 AND feedback_score > -5 THEN 1 ELSE 0 END) AS misleading
			FROM memories GROUP BY kind ORDER BY total DESC
		`).all();
		for (const row of kindRows) {
			result.byKind[row.kind] = {
				total: Number(row.total) || 0,
				read: Number(row.read) || 0,
				helpful: Number(row.helpful) || 0,
				misleading: Number(row.misleading) || 0,
			};
		}

		for (const [index, dir] of workspaces.entries()) {
			const { name, keys } = workspaceKeys(dir, rawWorkspaces[index]);
			const placeholders = keys.map(() => "?").join(", ");
			const mem = store.db.prepare(`
				SELECT
					COUNT(*) AS total,
					SUM(CASE WHEN usage_count > 0 THEN 1 ELSE 0 END) AS read,
					SUM(CASE WHEN feedback_score > 0 THEN 1 ELSE 0 END) AS helpful,
					SUM(CASE WHEN feedback_score < 0 AND feedback_score > -5 THEN 1 ELSE 0 END) AS misleading,
					SUM(CASE WHEN feedback_score <= -5 THEN 1 ELSE 0 END) AS obsolete
				FROM memories
				WHERE workspace_key IN (${placeholders}) OR (workspace_key = '' AND workspace = ?)
			`).get(...keys, name);
			result.workspaces.push({
				path: dir,
				workspaceKey: keys[0],
				memory: {
					total: Number(mem.total) || 0,
					read: Number(mem.read) || 0,
					helpful: Number(mem.helpful) || 0,
					misleading: Number(mem.misleading) || 0,
					obsolete: Number(mem.obsolete) || 0,
				},
				outcome: outcomeOf(readLedger(dir)),
			});
		}
	} finally {
		store.close();
	}

	// 关联分组：有被读取过的记忆 vs 没有。样本不足就只说样本不足。
	const withRead = result.workspaces.filter((w) => w.memory.read > 0 && w.outcome.present);
	const withoutRead = result.workspaces.filter((w) => w.memory.read === 0 && w.outcome.present);
	const group = (list) => {
		const settled = list.reduce((sum, w) => sum + (w.outcome.intents.settled || 0), 0);
		const total = list.reduce((sum, w) => sum + (w.outcome.intents.total || 0), 0);
		const succeeded = list.reduce((sum, w) => sum + ((w.outcome.tasks.states || {}).succeeded || 0), 0);
		const failed = list.reduce((sum, w) => sum + ((w.outcome.tasks.states || {}).failed || 0), 0);
		return {
			workspaces: list.length,
			intents: { settled, total, rate: rate(settled, total) },
			tasks: { succeeded, failed, successRate: rate(succeeded, succeeded + failed) },
		};
	};
	result.association.groups = { withRead: group(withRead), withoutRead: group(withoutRead) };
	const enough = withRead.length >= MIN_SAMPLE && withoutRead.length >= MIN_SAMPLE;
	result.association.verdict = enough ? "可比较" : `样本不足（有读取=${withRead.length} / 无读取=${withoutRead.length}，需各自 ≥${MIN_SAMPLE}）`;
}

if (JSON_OUT) {
	mkdirSync(dirname(resolve(JSON_OUT)), { recursive: true });
	writeFileSync(resolve(JSON_OUT), JSON.stringify(result, null, 2) + "\n", "utf8");
}

const f = result.funnel;
console.log(`记忆库：${result.store}`);
console.log(`写入 ${f.written} 条 · 当前召回窗口 ${f.injectionWindow} 条 · 被读取过 ${f.read} 条 · 有帮助 ${f.helpful} · 误导 ${f.misleading} · 已退役 ${f.obsolete}`);
for (const [kind, row] of Object.entries(result.byKind)) {
	console.log(`  ${kind.padEnd(12)} 共 ${row.total} · 读过 ${row.read} · 有帮助 ${row.helpful} · 误导 ${row.misleading}`);
}
for (const item of result.workspaces) {
	const out = item.outcome.present
		? `准则 ${item.outcome.criteria.settled}/${item.outcome.criteria.total} · 意图 ${item.outcome.intents.settled}/${item.outcome.intents.total} · 任务 ${JSON.stringify(item.outcome.tasks.states)}`
		: "无 operation-state.json";
	console.log(`${basename(item.path)}  记忆 ${item.memory.total}（读过 ${item.memory.read}）  ${out}`);
}
console.log(`关联：${result.association.verdict}`);
console.log(`  有读取：${JSON.stringify(result.association.groups.withRead || {})}`);
console.log(`  无读取：${JSON.stringify(result.association.groups.withoutRead || {})}`);
if (result.error) console.log(`注意：${result.error}`);
