
// ── 平台数据根（$DSH_HOME）────────────────────────────────────────────
// 宿主按 $DSH_HOME 装配 profiles/会话/存储；插件一律跟随，避免「一半落 A 一半落 B」。
// 未设置时等价于 ~/.dsh，故对既有用户是零行为变更。
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
// dsh-campaign-memory — 战役记忆宿主插件（渗透 / 代码审计 / CTF 三种安全模式）。
//
// 三件事：
//   1) 沉淀：模型侧 campaign_memory_write 随战随记（存储原文不脱敏——内网地址/指纹细节是打法价值所在，凭据同样原样入库）；
//   2) 召回：campaign_memory_search 检索预览不记账，campaign_memory_get 读全文即记账
//      （usage/last_used 是热度排序的唯一驱动——排序=热度×30 天半衰，久未读取自然让位）；
//      装配期把该模式本工作区高频记忆注入上下文（<dsh-campaign-memory> 标记块）；
//   3) 治理：detect 默认 30 天过期并自动清理；fingerprint 默认 180 天——到期退出自动召回、
//      检索仍可命中带过期标记、同题重写即刷新；同模式同工作区同题写入=刷新不重复；
//      Web 标签页「战役记忆」浏览/检索/删除，loopback RPC 同源栅栏。
//   4) 收尾：顶层会话销毁时读工作区意图台账（operation-state.json），把受阻/放弃/已完成/已判定
//      四类可迁移项抽成候选清单落盘 memory-candidates.md——**只出候选、不自动写库**（记忆带 TTL
//      与冷淘汰，入库必须过人）。
//
// 记忆是模式作用域的跨会话资产：渗透的目标指纹打法与入口战法、代审的框架 sink 与审计结论。

import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { openStore, writeMemory, searchMemories, topForInjection, listMemories, getMemory, removeMemory, statsMemories, purgeExpired, kindLabel, MEMORY_KINDS, setIdeaStatus, listIdeas, IDEA_STATUSES } from "./store.js";
import { readLedger, distillCandidates, renderCandidates, OUT_FILE } from "./distill.js";

const name = "dsh-campaign-memory";
const inject = ["tools", "webServer", "webRuntime", "agentPresets", "systemPrompt"];

export const MODE_IDS = ["pentest", "code-audit", "ctf-solver"];
const MODE_LABELS = {
	pentest: "渗透测试", "code-audit": "代码审计", "ctf-solver": "CTF 解题"
};
/** 记忆库路径：默认 `~/.dsh/campaign-memory/memory.db`；`DSH_CAMPAIGN_MEMORY_DB` 可覆盖
 *  （与兄弟插件 `DSH_ATLAS_DB` 同约定——便于把库挪到别处，也让离线测试不必碰真实记忆库）。 */
function dbPath() {
	const override = process.env.DSH_CAMPAIGN_MEMORY_DB;
	return typeof override === "string" && override !== "" ? override : path.join(DSH_HOME, "campaign-memory", "memory.db");
}

let store;
function theStore() {
	if (store === undefined) store = openStore(dbPath());
	return store;
}

/** 释放模块级库句柄（插件卸载 / 测试收尾）。句柄不释放会在 Windows 上锁住 `-wal`/`-shm`，
 *  之后删除工作目录报 EBUSY——排查时会误以为是权限或杀软。 */
export function closeStore() {
	if (store === undefined) return;
	try { store.close(); } catch { /* 已关闭或已随进程回收 */ }
	store = undefined;
}
const ROUTE_PATH = "/dsh-campaign-memory";
/** 进程级 CSRF token：GET <route>/csrf 由同源页取走（跨源响应不可读），POST 须回带 x-dsh-csrf 头。 */
const CSRF_TOKEN = crypto.randomBytes(24).toString("hex");
export function checkCsrf(req, token) {
	return String(req?.headers?.["x-dsh-csrf"] ?? "") === String(token ?? "");
}
const MAX_BODY = 1024 * 1024;

//#region 召回注入块（纯函数，供测试）

const INJECT_TAG = "dsh-campaign-memory";
const INJECT_BUDGET = 700;

/** 装配期召回块：标记化（压缩后可识别）、预算内（超限先减记忆行——数据让位，指引行最后丢；
 *  n 属性随实留行数重建）。确定性：同库状态同文。 */
export function buildMemoryBlock(mode, workspace, rows) {
	if (!rows || rows.length === 0) return "";
	const close = `</${INJECT_TAG}>`;
	const guide = "沉淀/检索：有效打法即时 campaign_memory_write 记忆（正文原样入库不脱敏——凭据可入库或只写指位指向本地凭据库）；开战/接案或换目标类型先 campaign_memory_search 检索。";
	const build = (kept) => {
		const kinds = [...new Set(kept.map((r) => r.targetKind).filter(Boolean))];
		const topicLine = kinds.length > 1 ? `本工作区记忆含多目标（${kinds.slice(0, 4).join("/")}${kinds.length > 4 ? " 等" : ""}）——适用性按目标自判，检索可加 target_kind 过滤。` : "";
		return [
			`<${INJECT_TAG} mode="${mode}" workspace="${workspace}" n="${kept.length}">`,
			"本工作区战役记忆（历史战役沉淀；适用性自判——目标环境可能已变化）：",
			...kept.map((r, i) => `${i + 1}. [${kindLabel(r.kind)}${r.targetKind ? "·" + r.targetKind : ""}] ${r.title}——${String(r.content).split("\n")[0].slice(0, 160)}`),
			...(topicLine ? [topicLine] : []),
			guide
		].join("\n") + "\n" + close;
	};
	let kept = rows.slice();
	let text = build(kept);
	while (kept.length > 0 && text.length > INJECT_BUDGET) {
		kept = kept.slice(0, -1);
		text = build(kept);
	}
	if (text.length > INJECT_BUDGET) {
		const tail = "…\n" + close; // 兜底（固定行极端超限）：硬截到预算内，截点在闭合标签前
		text = text.slice(0, INJECT_BUDGET - tail.length) + tail;
	}
	return text;
}

//#endregion

/** 工作区标识：name=目录 basename（展示与旧库兼容），key=basename@全路径哈希 8 位（隔离键——
 *  同名目录不串场、移动/改名目录=新 key 干净开局，旧记忆仍可跨工作区检索找回）。cwd 缺失时
 *  key=""（回落 basename 旧语义，注入只匹配无键行）。 */
function workspaceOf(agent) {
	const cwd = agent?.session?.header?.cwd;
	if (typeof cwd !== "string" || !cwd) return { name: "", key: "" };
	const base = path.basename(cwd).slice(0, 60);
	return { name: base, key: base + "@" + crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 8) };
}

function sessionOf(ctx, exec) {
	const agent = exec?.agent;
	const id = agent?.session?.id;
	if (!id) return undefined;
	let preset;
	try { preset = ctx.agentPresets?.composedPreset?.(agent.ctx); } catch { /* 组合未就绪 */ }
	if (typeof preset !== "string") preset = agent?.session?.header?.agentPreset;
	return { id: String(id), mode: MODE_IDS.includes(preset) ? preset : undefined };
}

//#region 会话收尾蒸馏（P1-3：只出候选、不自动写库）

/** 顶层会话判定：子代理在战役中途反复创建与销毁，收尾蒸馏只认顶层——否则同一工作区会被反复覆写、
 *  半成品台账也会被当成收尾结果。深度取自会话头（权威且单调），运行期缺省即深度 0。 */
export function isRootSession(agent) {
	const header = agent?.session?.header;
	if (header?.origin === "subagent") return false;
	const depth = header?.delegationDepth ?? 0;
	return !(Number.isSafeInteger(depth) && depth > 0);
}

/** 抽候选并落盘到工作区（返回 {written,file,count,error?}）。**绝不抛错**——收尾钩子不许打断销毁流程。
 *  只写文件、不碰记忆库：记忆带 TTL 与 400 条冷淘汰，一条错指纹会污染后续每一局，入库必须过人。 */
export function distillWorkspace({ cwd, mode, existing = [], now = new Date() }) {
	try {
		const ledger = readLedger(cwd);
		const candidates = distillCandidates({ ledger, existing });
		if (candidates.length === 0) return { written: false, file: "", count: 0 };
		const text = renderCandidates({ cwd, mode, candidates, now });
		if (text === "") return { written: false, file: "", count: 0 };
		const file = path.join(cwd, OUT_FILE);
		fs.writeFileSync(file, text, "utf8");
		return { written: true, file, count: candidates.length };
	} catch (e) {
		return { written: false, file: "", count: 0, error: e?.message ?? String(e) };
	}
}

//#endregion

//#region HTTP 通道（自注册路由 + 同源信任栅栏）

function hostOf(headers) {
	const h = headers?.host;
	return typeof h === "string" ? h : "";
}
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}
export function isTrustedRequest(req, trustedHosts) {
	const host = hostOf(req.headers);
	if (host === "") return false;
	let hostUrl;
	try { hostUrl = new URL(`http://${host}`); } catch { return false; }
	const okHost = isLoopbackHostname(hostUrl.hostname) || (trustedHosts ?? []).some((t) => {
		try { return new URL(`http://${t}`).hostname === hostUrl.hostname; } catch { return false; }
	});
	if (!okHost) return false;
	const origin = req.headers?.origin;
	if (typeof origin === "string" && origin !== "null") {
		try {
			const originUrl = new URL(origin);
			if (originUrl.host !== hostUrl.host) return false; // 含端口：本机他端口页面的 Origin 不放行
		} catch { return false; }
	}
	return true;
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (c) => {
			size += c.length;
			if (size > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; }
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/** 通道端点分发（纯逻辑，供路由与测试复用）。 */
export async function dispatch(ctx, st, endpoint, payload) {
	const p = payload ?? {};
	if (endpoint === "memory.list") {
		const mode = String(p.mode ?? "");
		if (!mode) throw new Error("mode required");
		return { memories: listMemories(st, { mode, kind: p.kind ? String(p.kind) : "", includeExpired: !!p.includeExpired, limit: p.limit }) };
	}
	if (endpoint === "memory.search") {
		const mode = String(p.mode ?? "");
		if (!mode) throw new Error("mode required");
		return { memories: searchMemories(st, { mode, query: p.query, kind: p.kind, target_kind: p.target_kind, limit: p.limit }) };
	}
	if (endpoint === "memory.get") {
		const m = getMemory(st, String(p.id ?? ""), { account: !p.peek }); // peek=纯浏览不记账（Web 标签页展开全文）
		if (!m) throw new Error(`记忆不存在：${p.id}`);
		return { memory: m };
	}
	if (endpoint === "memory.write") {
		const m = writeMemory(st, { mode: p.mode, kind: p.kind, title: p.title, content: p.content, tags: p.tags, target_kind: p.target_kind, expires_days: p.expires_days, source_session: p.sessionId, workspace: p.workspace, workspace_key: p.workspaceKey });
		return { ok: true, ...m };
	}
	if (endpoint === "memory.remove") {
		return { ok: true, ...removeMemory(st, String(p.id ?? "")) };
	}
	if (endpoint === "memory.stats") {
		const mode = String(p.mode ?? "");
		if (!mode) throw new Error("mode required");
		return { stats: statsMemories(st, mode) };
	}
	if (endpoint === "memory.purge") {
		return { ok: true, ...purgeExpired(st) };
	}
	if (endpoint === "idea.list") {
		const mode = String(p.mode ?? "");
		if (!mode) throw new Error("mode required");
		return { ideas: listIdeas(st, { mode, status: p.status ? String(p.status) : "", includeSettled: !!p.includeSettled, limit: p.limit }) };
	}
	if (endpoint === "idea.set") {
		return { ok: true, idea: setIdeaStatus(st, String(p.id ?? ""), String(p.status ?? ""), String(p.note ?? "")) };
	}
	throw new Error(`unknown endpoint ${endpoint}`);
}

//#endregion

function apply(ctx) {
	//#region 装配期召回块（systemPrompt 动态上下文：记忆集变化才重新快照）
	ctx.systemPrompt.context({
		name: "campaign-memory",
		order: 600,
		text: (assembly) => {
			const agent = assembly?.agent;
			if (!agent) return "";
			let presetId = "";
			try { presetId = String(ctx.agentPresets.composedPreset(agent.ctx) ?? ""); } catch { /* 组合未就绪 */ }
			if (!MODE_IDS.includes(presetId)) return "";
			try {
				const ws = workspaceOf(agent);
				return buildMemoryBlock(presetId, ws.name, topForInjection(theStore(), presetId, ws.name, 3, ws.key));
			} catch { return ""; }
		}
	});
	//#endregion

	//#region 收尾蒸馏钩子（顶层会话销毁时把台账里可迁移的部分抽成候选清单，落盘不落库）
	ctx.on("agent/disposed", (payload) => {
		try {
			const agent = payload?.agent ?? payload; // 宿主载荷是 {agent}；同时容错旧形（直接给 agent）
			if (!isRootSession(agent)) return;
			const cwd = agent?.session?.header?.cwd;
			if (typeof cwd !== "string" || cwd === "") return;
			const session = sessionOf(ctx, { agent });
			if (!session?.mode) return;
			let existing = [];
			try { existing = listMemories(theStore(), { mode: session.mode, limit: 200 }); } catch { existing = []; }
			const r = distillWorkspace({ cwd, mode: session.mode, existing });
			if (r.written) ctx.logger?.info?.(`dsh-campaign-memory: 收尾蒸馏落盘 ${r.count} 条记忆候选 → ${r.file}（未入库，需 campaign_memory_write 确认后写入）`);
		} catch { /* 收尾蒸馏失败不得影响销毁流程 */ }
	});
	// 插件卸载即释放库句柄：句柄悬着会锁住 -wal/-shm（Windows 上表现为删不掉目录）。
	ctx.effect(() => () => { closeStore(); }, "dsh-campaign-memory: store handle");
	//#endregion

	//#region 模型工具（宿主平面；三种安全模式会话内可用）
	ctx.tools.register(defineTool({
		name: "campaign_memory_write",
		description: "沉淀跨会话记忆。kind=tactic / fingerprint / tooling / lesson / detect；detect 默认 30 天、fingerprint 180 天，其余永久。同模式同工作区同题写入即刷新，每工作区上限 400 条。存储原文不做脱敏；有效即可记。",
		parameters: {
			title: { type: "string", required: true, description: "一句话标题（如：XX 框架后台默认凭据直连）；同题同 target_kind 即刷新而非新增（跨平台同名题不互覆）" },
			content: { type: "string", required: true, description: "打法/事实正文（怎么做的、命中条件、关键参数；原样入库不做脱敏——凭据/密钥也原样存储）" },
			kind: { type: "string", required: true, enum: MEMORY_KINDS, description: "记忆类别" },
			tags: { type: "string", description: "检索标签（逗号分隔，如：java,后台,弱口令）" },
				target_kind: { type: "string", description: "适用目标形态（web/api/域环境/家族名/案件号等，召回过滤用）" },
			expires_days: { type: "number", description: "有效期天数（省略时 detect=30 天、fingerprint=180 天，其余永久）" }
		},
		output: {
			schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true } } },
			render: (_a, v) => [{ type: "text", text: v.ok ? `记忆已${v.refreshed ? "刷新" : "沉淀"}：${v.id}${v.expires_at ? "（" + v.expires_at + " 过期）" : ""}${v.evicted ? `（本工作区超上限，冷淘汰 ${v.evicted} 条）` : ""}` : `沉淀失败：${v.error}` }]
		},
		execute(args, exec) {
			const session = sessionOf(ctx, exec);
			if (!session?.mode) return Promise.resolve({ ok: false, error: "仅安全模式会话内可用" });
			try {
				const ws = workspaceOf(exec?.agent);
				const m = writeMemory(theStore(), { mode: session.mode, kind: args.kind, title: args.title, content: args.content, tags: args.tags, target_kind: args.target_kind, expires_days: args.expires_days, source_session: session.id, workspace: ws.name, workspace_key: ws.key });
				return Promise.resolve({ ok: true, id: m.id, expires_at: m.expires_at, refreshed: m.refreshed, evicted: m.evicted });
			} catch (e) {
				return Promise.resolve({ ok: false, error: e?.message ?? String(e) });
			}
		}
	}));

	ctx.tools.register(defineTool({
		name: "campaign_memory_search",
		description: "检索本模式跨工作区记忆，按热度排序，返回正文预览；全文用 campaign_memory_get。开战或换目标类型时先查。",
		parameters: {
			query: { type: "string", required: true, description: "关键词（标题/正文/标签匹配，如：XX 云台 弱口令）" },
			kind: { type: "string", enum: MEMORY_KINDS, description: "限定类别（可选）" },
			target_kind: { type: "string", description: "限定目标形态（可选）" },
			limit: { type: "number", description: "返回条数（默认 8，上限 20）" }
		},
		output: {
			schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true } } },
			render: (_a, v) => [{ type: "text", text: v.ok ? `命中 ${v.memories.length} 条战役记忆` : `检索失败：${v.error}` }]
		},
		execute(args, exec) {
			const session = sessionOf(ctx, exec);
			if (!session?.mode) return Promise.resolve({ ok: false, error: "仅安全模式会话内可用" });
			try {
				return Promise.resolve({ ok: true, memories: searchMemories(theStore(), { mode: session.mode, query: args.query, kind: args.kind, target_kind: args.target_kind, limit: args.limit }) });
			} catch (e) {
				return Promise.resolve({ ok: false, error: e?.message ?? String(e) });
			}
		}
	}));

	ctx.tools.register(defineTool({
		name: "campaign_memory_get",
		description: "按 id 读取记忆全文；读取计入热度并驱动召回排序。",
		parameters: {
			id: { type: "string", required: true, description: "记忆 id（cm- 开头）" }
		},
		output: {
			schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true } } },
			render: (_a, v) => [{ type: "text", text: v.ok ? `记忆全文：${v.memory.title}` : `读取失败：${v.error}` }]
		},
		execute(args, exec) {
			const session = sessionOf(ctx, exec);
			if (!session?.mode) return Promise.resolve({ ok: false, error: "仅安全模式会话内可用" });
			try {
				const m = getMemory(theStore(), args.id);
				return Promise.resolve(m ? { ok: true, memory: m } : { ok: false, error: `记忆不存在：${args.id}` });
			} catch (e) {
				return Promise.resolve({ ok: false, error: e?.message ?? String(e) });
			}
		}
	}));

	ctx.tools.register(defineTool({
		name: "campaign_memory_list",
		description: "列出本模式有效记忆，按热度排序；收口复盘与治理用。",
		parameters: { kind: { type: "string", enum: MEMORY_KINDS, description: "限定类别（可选）" }, limit: { type: "number", description: "返回条数（默认 50，上限 200）" } },
		output: {
			schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true } } },
			render: (_a, v) => [{ type: "text", text: v.ok ? `本模式战役记忆 ${v.memories.length} 条` : `读取失败：${v.error}` }]
		},
		execute(args, exec) {
			const session = sessionOf(ctx, exec);
			if (!session?.mode) return Promise.resolve({ ok: false, error: "仅安全模式会话内可用" });
			try {
				return Promise.resolve({ ok: true, memories: listMemories(theStore(), { mode: session.mode, kind: args.kind, limit: args.limit }) });
			} catch (e) {
				return Promise.resolve({ ok: false, error: e?.message ?? String(e) });
			}
		}
	}));

	ctx.tools.register(defineTool({
		name: "campaign_memory_remove",
		description: "按 id 删除一条记忆。",
		parameters: { id: { type: "string", required: true, description: "记忆 id（cm- 开头）" } },
		output: {
			schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true } } },
			render: (_a, v) => [{ type: "text", text: v.ok ? `记忆已删除：${v.removed}` : `删除失败：${v.error}` }]
		},
		execute(args, exec) {
			const session = sessionOf(ctx, exec);
			if (!session?.mode) return Promise.resolve({ ok: false, error: "仅安全模式会话内可用" });
			try {
				return Promise.resolve({ ok: true, ...removeMemory(theStore(), args.id) });
			} catch (e) {
				return Promise.resolve({ ok: false, error: e?.message ?? String(e) });
			}
		}
	}));
	//#endregion

	//#region 方向层工具（Idea：还没做但值得做的假设——与"已发生的事实"分开维护）
	ctx.tools.register(defineTool({
		name: "campaign_idea_open",
		description: "登记待验证方向（事实用 campaign_memory_write；本工具记下一步该往哪打）。同模式同工作区同题写入即刷新，收口走 campaign_idea_settle。",
		parameters: {
			title: { type: "string", required: true, description: "方向一句话（如：api.example.com 的 /admin 未授权访问未验证）" },
			content: { type: "string", required: true, description: "方向正文：假设是什么、打算怎么验、预期结果" },
			basis: { type: "string", description: "判断依据（哪个事实/证据让你觉得值得试——这是方向的信噪比来源）" },
			asset: { type: "string", description: "关联资产（域名/IP/URL，便于和 attack-atlas 的攻击面覆盖联动对账）" },
			target_kind: { type: "string", description: "适用目标形态（web/api/域环境/平台名等）" },
			status: { type: "string", enum: IDEA_STATUSES, description: "初始状态（默认 open 待验证）" }
		},
		output: {
			schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true } } },
			render: (_a, v) => [{ type: "text", text: v.ok ? `方向已${v.refreshed ? "刷新" : "登记"}：${v.id}（${v.idea_status}）` : `登记失败：${v.error}` }]
		},
		execute(args, exec) {
			const session = sessionOf(ctx, exec);
			if (!session?.mode) return Promise.resolve({ ok: false, error: "仅安全模式会话内可用" });
			try {
				const ws = workspaceOf(exec?.agent);
				const m = writeMemory(theStore(), {
					mode: session.mode, kind: "idea", title: args.title,
					content: [args.content, args.basis ? "依据：" + args.basis : ""].filter(Boolean).join("\n"),
					target_kind: args.target_kind, source_session: session.id,
					workspace: ws.name, workspace_key: ws.key,
					idea_status: args.status, idea_basis: args.basis, idea_asset: args.asset,
				});
				return Promise.resolve({ ok: true, id: m.id, idea_status: m.refreshed ? "(保留原状态)" : (args.status || "open"), refreshed: m.refreshed, evicted: m.evicted });
			} catch (e) {
				return Promise.resolve({ ok: false, error: e?.message ?? String(e) });
			}
		}
	}));

	ctx.tools.register(defineTool({
		name: "campaign_idea_settle",
		description: "收口方向：confirmed=已验证成立，ruled-out=验证后排除。note 记录依据并追加到正文；没试过不要排除。",
		parameters: {
			id: { type: "string", required: true, description: "方向 id（cm- 开头，来自 campaign_idea_open/list）" },
			status: { type: "string", required: true, enum: ["confirmed", "ruled-out"], description: "confirmed=已验证成立 / ruled-out=已排除" },
			note: { type: "string", description: "结论依据（为什么成立/为什么排除——会写进正文留痕）" }
		},
		output: {
			schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true } } },
			render: (_a, v) => [{ type: "text", text: v.ok ? `方向已收口：${v.id} → ${v.idea_status}` : `收口失败：${v.error}` }]
		},
		execute(args, exec) {
			const session = sessionOf(ctx, exec);
			if (!session?.mode) return Promise.resolve({ ok: false, error: "仅安全模式会话内可用" });
			try {
				const r = setIdeaStatus(theStore(), args.id, args.status, args.note);
				return Promise.resolve({ ok: true, id: r.id, idea_status: r.ideaStatus });
			} catch (e) {
				return Promise.resolve({ ok: false, error: e?.message ?? String(e) });
			}
		}
	}));

	ctx.tools.register(defineTool({
		name: "campaign_idea_list",
		description: "列出未收口方向；开新局、换目标或卡住时先看。includeSettled=true 可复盘已收口项。",
		parameters: {
			status: { type: "string", enum: IDEA_STATUSES, description: "只看某个状态（省略=只看 open 未收口）" },
			includeSettled: { type: "boolean", description: "包含已收口的方向（复盘用）" },
			limit: { type: "number", description: "返回条数（默认 30，上限 200）" }
		},
		output: {
			schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true } } },
			render: (_a, v) => {
				if (!v.ok) return [{ type: "text", text: `查询失败：${v.error}` }];
				if (!v.ideas.length) return [{ type: "text", text: "当前没有未收口的方向——侦察时若发现「没测但可疑」的点，用 campaign_idea_open 登记。" }];
				return [{ type: "text", text: v.ideas.map((i) => `[${i.ideaStatus}${i.ideaAsset ? "｜" + i.ideaAsset : ""}] ${i.title}（${i.id}）——${String(i.content).split("\\n")[0].slice(0, 120)}`).join("\n") }];
			}
		},
		execute(args, exec) {
			const session = sessionOf(ctx, exec);
			if (!session?.mode) return Promise.resolve({ ok: false, error: "仅安全模式会话内可用" });
			try {
				const ideas = listIdeas(theStore(), { mode: session.mode, status: args.status ?? "", includeSettled: !!args.includeSettled, limit: args.limit });
				return Promise.resolve({ ok: true, ideas });
			} catch (e) {
				return Promise.resolve({ ok: false, error: e?.message ?? String(e) });
			}
		}
	}));
	//#endregion

	//#region Web 通道路由（自注册 + 同源栅栏）
	const trustedHosts = () => {
		try { return ctx.webRuntime?.trustedHosts ?? []; } catch { return []; }
	};
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: ROUTE_PATH,
		handler: async (req, res) => {
			const send = (code, body) => {
				const text = JSON.stringify(body);
				res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
				res.end(text);
			};
			if (!isTrustedRequest(req, trustedHosts())) { res.writeHead(403); res.end("forbidden"); return; }
			let csrfPath = "";
			try { csrfPath = new URL(req.url ?? "/", "http://x").pathname; } catch { csrfPath = ""; }
			if (req.method === "GET" && csrfPath === ROUTE_PATH + "/csrf") { send(200, { token: CSRF_TOKEN }); return; }
			if (req.method !== "POST") { res.writeHead(405); res.end("method not allowed"); return; }
			if (!checkCsrf(req, CSRF_TOKEN)) { res.writeHead(403); res.end("csrf token missing or invalid"); return; }
			let endpoint = "";
			try { endpoint = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname.slice(ROUTE_PATH.length)).replace(/^\/+/, ""); } catch { endpoint = ""; }
			if (endpoint === "") { res.writeHead(404); res.end("not found"); return; }
			try {
				const raw = await readBody(req);
				const payload = raw === "" ? {} : JSON.parse(raw);
				const result = await dispatch(ctx, theStore(), endpoint, payload);
				send(200, result);
			} catch (e) {
				send(400, { ok: false, error: e?.message ?? String(e) });
			}
		}
	}), "dsh-campaign-memory: web route");
	//#endregion
}

export { MODE_LABELS, MEMORY_KINDS, kindLabel, ROUTE_PATH, apply, inject, name, openStore };

//#endregion
