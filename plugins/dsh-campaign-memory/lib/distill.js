// dsh-campaign-memory 会话收尾蒸馏（P1-3）：从工作区已落盘的过程产物抽「可迁移」候选。
//
// 两条自我约束：
//  1) **只出候选、不自动写库**。记忆库带 TTL（fingerprint 180 天 / detect 30 天）与 400 条冷淘汰，
//     一条错指纹会污染后续每一局。写库必须过人（或模型显式确认后调 campaign_memory_write）。
//  2) **只读工作区文件，不按路径去开别的插件的 SQLite**。operation-state.json 是插件之间既有的
//     公开交换面；直接开别人的库属于隐式耦合，对方改一次 schema 这里就静默失效。
//
// 抽的是「能跨目标复用」的东西：受阻条件（什么路走不通）、放弃理由（边界在哪）、
// 已完成的打法、以及被判定成立的验收判据。原始过程记录不进来——那不是记忆，是日志。

import fs from "node:fs";
import path from "node:path";

/** 工作区里的意图台账文件名（与 stage-gate 同源）。 */
export const STATE_FILE = "operation-state.json";
/** 候选清单落盘文件名（写在任务工作区根，便于随任务产物一起归档）。 */
export const OUT_FILE = "memory-candidates.md";
/** 候选条数上限：多了没人看，反而变成噪声。 */
export const MAX_CANDIDATES = 40;
/** 判定「已有相似记忆」的最短可比片段（太短的标题比不出东西）。 */
const DUP_MIN = 8;
/** 准则文本可能落在的字段名（防御性：读的是别的插件的文件，字段名以对方为准）。 */
const CRITERION_KEYS = ["text", "desc", "detail", "summary", "criterion"];

function clean(value, max) {
	return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** 归一化：去空白与标点，用于「是否已有相似记忆」的比较。 */
function norm(value) {
	return String(value ?? "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function criterionText(criterion) {
	for (const key of CRITERION_KEYS) {
		const value = criterion?.[key];
		if (typeof value === "string" && value.trim() !== "") return clean(value, 300);
	}
	return "";
}

/** 读工作区意图台账。文件不存在/JSON 损坏一律返回 null——收尾蒸馏绝不因台账异常而抛错。 */
export function readLedger(cwd) {
	if (typeof cwd !== "string" || cwd === "") return null;
	try {
		const raw = fs.readFileSync(path.join(cwd, STATE_FILE), "utf8");
		const state = JSON.parse(raw);
		if (state === null || typeof state !== "object") return null;
		const goal = typeof state.goal === "string"
			? clean(state.goal, 300)
			: clean(state.goal?.text ?? state.goal?.desc ?? state.goal?.summary, 300);
		return {
			goal,
			criteria: Array.isArray(state.criteria) ? state.criteria : [],
			intents: Array.isArray(state.intents) ? state.intents : [],
			note: clean(state.note, 500),
			pending: Array.isArray(state.pending) ? state.pending.map((line) => clean(line, 200)).filter(Boolean) : []
		};
	} catch { return null; }
}

/** 抽候选（纯函数）。existing = 已有记忆 [{id,title,content}]，仅用于判重标注。 */
export function distillCandidates({ ledger, existing = [] }) {
	if (ledger === null || ledger === undefined) return [];
	const pool = existing.map((m) => ({ id: String(m?.id ?? ""), text: norm(`${m?.title ?? ""}${m?.content ?? ""}`) }));
	const out = [];
	// basis：判重用的裸语义（不含「打法：」这类展示前缀）——前缀进比较会导致永远匹配不上。
	const push = (kind, title, content, tags, basis) => {
		if (out.length >= MAX_CANDIDATES) return;
		const t = clean(title, 80);
		if (t === "") return;
		const n = norm(basis === undefined ? t : basis);
		const hit = n.length >= DUP_MIN ? pool.find((m) => m.text.includes(n)) : undefined;
		out.push({ kind, title: t, content: clean(content, 600), tags, dup: hit ? hit.id : "" });
	};
	for (const intent of ledger.intents) {
		const summary = clean(intent?.summary, 200);
		if (summary === "") continue;
		const kind = clean(intent?.anchor?.kind, 20);
		const ref = clean(intent?.anchor?.ref, 80);
		const anchor = ref === "" ? (kind || "未记") : `${kind}:${ref}`;
		const status = clean(intent?.status, 20);
		if (status === "blocked") {
			push("lesson", `受阻：${summary}`, `方向「${summary}」以 blocked 收口（锚 ${anchor}）。受阻原因：${ledger.note || "台账未记——补记后再入库才有复用价值"}。`, "受阻条件,负结果", summary);
		} else if (status === "dropped") {
			push("lesson", `放弃：${summary}`, `方向「${summary}」以 dropped 收口（锚 ${anchor}）。放弃理由：${ledger.note || "台账未记"}。`, "边界,放弃理由", summary);
		} else if (status === "done") {
			push("tactic", `打法：${summary}`, `方向「${summary}」已完成（锚 ${anchor}）。登记时预期：${clean(intent?.note, 300) || "未记"}。`, "打法,可复用", summary);
		}
	}
	for (const criterion of ledger.criteria) {
		const text = criterionText(criterion);
		if (text === "") continue;
		if (clean(criterion?.status, 20) !== "met") continue;
		push("detect", `判据：${text}`, `该准则在本目标上被判定为 met（${ledger.goal ? `目标：${ledger.goal}；` : ""}未记为 failed 或 open）——可直接复用作同类目标的验收判据。`, "验收判据,detect", text);
	}
	return out;
}

/** 渲染候选清单（Markdown）。返回空字符串表示没有可写内容。 */
export function renderCandidates({ cwd, mode, candidates, now = new Date() }) {
	if (!Array.isArray(candidates) || candidates.length === 0) return "";
	const lines = [
		"# 会话收尾·记忆候选",
		"",
		"> 由 dsh-campaign-memory 在会话结束时按规则抽取，**未写入记忆库**。",
		"> 确认有价值再调 `campaign_memory_write` 落库；没用就直接删掉本文件。",
		"",
		`- 工作区：\`${cwd}\``,
		`- 模式：${mode || "未知"}`,
		`- 生成时间：${now.toISOString()}`,
		`- 候选：${candidates.length} 条`,
		"",
		"| # | kind | 标题 | 已有相似记忆 |",
		"|---|---|---|---|",
	];
	candidates.forEach((c, i) => {
		lines.push(`| ${i + 1} | ${c.kind} | ${c.title.replace(/\|/g, "\\|")} | ${c.dup ? `是（${c.dup}）` : "否"} |`);
	});
	lines.push("");
	for (const c of candidates) {
		lines.push(`## ${c.kind}｜${c.title}`, "", c.content, "", `- tags：\`${c.tags}\``);
		if (c.dup) lines.push(`- 已有相似记忆 \`${c.dup}\`——建议按「同题重写=刷新」处理，别新增一条重复的。`);
		lines.push("");
	}
	return lines.join("\n");
}
