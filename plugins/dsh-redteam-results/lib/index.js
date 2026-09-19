
// ── 平台数据根（$DSH_HOME）────────────────────────────────────────────
// 宿主按 $DSH_HOME 装配 profiles/会话/存储；插件一律跟随，避免「一半落 A 一半落 B」。
// 未设置时等价于 ~/.dsh，故对既有用户是零行为变更。
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
// dsh-redteam-results — 会话隔离的 redteam 成果登记（渗透 / 代码审计 / CTF）宿主插件。
//
// 三件事：
//   1) 模型侧工具：redteam_finding_register / update / delete——执行时从 exec.agent
//      自动取 sessionId 与 agentPreset，成果严格按「会话 × 模式」隔离；
//   2) 存储：node:sqlite 单库 ~/.dsh/redteam-results/results.db（行级持久——删除某条
//      成果即删除对应行，除非删库，数据永远在）；
//   3) Web 通道：不走 connection.rpc（其在部分 fiber 上注册 webServer 路由会静默失败），
//      而是 better-sidebar 同款配方——静态注入 webServer/webRuntime，自己注册
//      /dsh-redteam-results 前缀路由 + 同源信任栅栏，会话标签页直接 POST JSON 读写。
//
// 「验证」按钮：取 agents 注册表把复核请求作为一条用户消息 followup 进当前会话，
// 模型按模式验证纪律复核后用 redteam_finding_update 回写状态。

import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { openStore, registerFinding, updateFinding, removeFinding, getFinding, allFindings, listFindings, listFindingsAll, groupByTarget, groupByTargetAll, computeStats, computeStatsAll, modeCounts, modeCountsAll, ledgerOverview, ledgerOverviewAll, getMeta, setMeta, SEVERITIES, STATUSES, MODE_STATUSES, ALL_STATUSES, EVIDENCE_LEVELS, SOURCE_ORIGINS, SECOND_RATINGS, secondReviewError, secondReviewVerdict, statusesOf } from "./store.js";

const name = "dsh-redteam-results";
const inject = ["tools", "webServer", "webRuntime", "agentPresets"];

const ROUTE_PATH = "/dsh-redteam-results";
/** 进程级 CSRF token：GET <route>/csrf 由同源页取走（跨源响应不可读），POST 须回带 x-dsh-csrf 头。 */
const CSRF_TOKEN = crypto.randomBytes(24).toString("hex");
export function checkCsrf(req, token) {
	return String(req?.headers?.["x-dsh-csrf"] ?? "") === String(token ?? "");
}
/** 验证按钮防重：sessionId:id → 最近注入时间（10 分钟窗口内不重复 followup，防连点灌多条复核消息）。 */
const VERIFY_SENT = new Map();
const VERIFY_WINDOW_MS = 10 * 60 * 1000;

/** 链路互链（chain 三模式）：反查 AttackAtlas 链路节点对各 finding 的引用——行带 chainNodes
 *  供 Detail 互链显示。atlas 包/库不可用时静默缺省（不阻塞成果读取）。
 *
 *  句柄缓存存 { dbPath, store }：atlas 的 openStore 返回对象**不带 dbPath 字段**，
 *  原先写 `cache.dbPath !== dbPath` 判定恒真 → 每次列表/分组请求都新开一个 SQLite 连接、
 *  旧句柄永不关闭（连接泄漏；Windows 上还表现为库文件被长期占用、临时目录删不掉）。 */
let atlasStoreCache; // { dbPath: string, store: { close(): void } }
/** 释放互链句柄（换库/测试/宿主卸载时用——Windows 上不关句柄则库文件不可删）。 */
export function releaseChainRefs() {
	if (atlasStoreCache === undefined) return;
	try { atlasStoreCache.store.close(); } catch { /* 已关或句柄失效 */ }
	atlasStoreCache = undefined;
}
/** 取 atlas 句柄（进程级缓存）；库不存在或包不可用返回 undefined（调用方静默降级）。 */
async function atlasHandle() {
	try {
		const mod = await import("@dsh-external/dsh-attack-atlas/store");
		const dbPath = process.env.DSH_ATLAS_DB || path.join(DSH_HOME, "attack-atlas", "atlas.db");
		if (dbPath !== ":memory:" && !fs.existsSync(dbPath)) return undefined;
		if (!atlasStoreCache || atlasStoreCache.dbPath !== dbPath) {
			releaseChainRefs();
			atlasStoreCache = { dbPath, store: mod.openStore(dbPath) };
		}
		return { mod, store: atlasStoreCache.store };
	} catch { return undefined; }
}

async function joinChainRefs(rows, mode) {
	if (!Array.isArray(rows) || rows.length === 0) return;
	const atlas = await atlasHandle();
	if (atlas === undefined) return;
	try {
		const refIdx = atlas.mod.chainRefIndex(atlas.store, mode);
		for (const f of rows) {
			const refs = refIdx[`${f.sessionId ?? ""}:${f.id}`];
			if (refs) f.chainNodes = refs.map((r) => ({ id: r.nodeId, label: r.label, kind: r.kind, major: !!r.major }));
		}
	} catch { /* atlas 不可用或无链路数据——互链缺省 */ }
}

/** 读本会话链路的全部节点（省略 target = 全目标并集）；atlas 不可用返回 undefined。 */
async function atlasChainNodes(sessionId, mode) {
	const atlas = await atlasHandle();
	if (atlas === undefined) return undefined;
	try { return atlas.mod.listChain(atlas.store, sessionId, mode); } catch { return undefined; }
}

/** 攻击图 ↔ 成果 只读对账（P1-2 步 2）。返回两清单，不改任何数据。
 *
 *  - **unlinked**：有成果、但没有任何链路节点引用它 —— 图漏了。stage-gate 读的就是这张图，
 *    图不全，门禁就是拿着一张不全的图在做判断。
 *  - **dangling**：链路节点引用了存在不了的成果（写错了 id / 来自别会话）—— 图脏了，
 *    在跨会话聚合视图里会误连到别人的成果上。
 *
 *  为什么只报告不自动修：自动补节点会制造噪声，自动删节点会吃掉人工编排的拓扑。
 *  修不修、怎么修由人判；这里只把不一致摊开。 */
export function reconcileChain({ findings, nodes, sessionId }) {
	const keyOf = (sid, id) => `${sid ?? ""}:${id ?? ""}`;
	const known = new Set(findings.map((f) => keyOf(f.sessionId, f.id)));
	const linked = new Set();
	const dangling = [];
	for (const n of nodes) {
		const ref = String(n.findingRef ?? "").trim();
		if (ref === "") continue;   // 无关联节点是合法拓扑（纯资产节点），不算脏
		// listChain 的节点投影不带 sessionId（查询本身就是按会话过滤的）——缺省按被查会话归属，
		// 否则每个节点都会被误判成「他会话」。显式带 sessionId 的调用方（跨会话对账）仍然生效。
		const nodeSid = n.sessionId ?? sessionId;
		const k = keyOf(nodeSid, ref);
		if (known.has(k)) { linked.add(k); continue; }
		dangling.push({
			nodeId: n.id, nodeLabel: n.label, sessionId: nodeSid, target: n.target, findingRef: ref,
			reason: String(nodeSid) === String(sessionId) ? "指向本会话不存在的成果" : "指向他会话的成果（聚合视图会误连）"
		});
	}
	const unlinked = findings
		.filter((f) => !linked.has(keyOf(f.sessionId, f.id)))
		.map((f) => ({ id: f.id, title: f.title, status: f.status, severity: f.severity, target: f.target }));
	return { unlinked, dangling, checked: { findings: findings.length, nodes: nodes.length } };
}

/** 渲染链路对账结果。纯函数，便于对“超过 12 条”的省略分支做回归测试。 */
export function renderChainReconcile(v) {
	if (!v.ok) return `对账失败：${v.error}`;
	if (v.available === false) return "未安装攻击图插件或本机尚无攻击图库——本次只核对成果侧，无图可对。";
	if (v.unlinked.length === 0 && v.dangling.length === 0) {
		return `对账通过：${v.checked.findings} 条成果、${v.checked.nodes} 个链路节点，两边一致。`;
	}
	const lines = [`链路对账：${v.checked.findings} 条成果 / ${v.checked.nodes} 个节点`];
	if (v.unlinked.length > 0) {
		lines.push(`未上图 ${v.unlinked.length} 条（图会失真，门禁据此判断）：`);
		for (const f of v.unlinked.slice(0, 12)) lines.push(`  - ${f.id} ${f.title}（${f.status}）`);
		if (v.unlinked.length > 12) lines.push(`  …另有 ${v.unlinked.length - 12} 条`);
	}
	if (v.dangling.length > 0) {
		lines.push(`悬挂引用 ${v.dangling.length} 处（节点指向不存在的成果）：`);
		for (const d of v.dangling.slice(0, 12)) lines.push(`  - 节点 ${d.nodeId} → ${d.findingRef}：${d.reason}`);
		if (v.dangling.length > 12) lines.push(`  …另有 ${v.dangling.length - 12} 处`);
	}
	lines.push("本条只报告不修改：补节点请在攻击图里手动加（自动补会造噪声），删错引用请人工确认后处理。");
	return lines.join("\n");
}
/** 发现自动上图（P1-2 步 1）：登记成功后，在本会话链路上补一个引用该 finding 的节点，
 *  让「攻击图」与「redteam 成果」页天然同步（stage-gate 读的就是这张图）。
 *
 *  三条自我约束：
 *  - **幂等**：节点 id 取 finding id，addChainNode 按 (session,mode,target,id) upsert，重复登记不产重复节点。
 *  - **不为不用图的用户凭空建库**：只在 atlas 库已存在时执行（":memory:" 除外）。
 *  - **失败绝不阻塞登记**：atlas 未装/库损坏一律静默返回 undefined。
 *
 *  kind 固定 other（「资产」）——按 finding.type 猜图例类型会制造错色节点，宁可交给人在图里改。
 */
export async function autoLinkFinding(sessionId, mode, finding) {
	try {
		const mod = await import("@dsh-external/dsh-attack-atlas/store");
		const dbPath = process.env.DSH_ATLAS_DB || path.join(DSH_HOME, "attack-atlas", "atlas.db");
		if (dbPath !== ":memory:" && !fs.existsSync(dbPath)) return undefined;
		if (!atlasStoreCache || atlasStoreCache.dbPath !== dbPath) {
			releaseChainRefs();
			atlasStoreCache = { dbPath, store: mod.openStore(dbPath) };
		}
		return mod.addChainNode(atlasStoreCache.store, sessionId, mode, {
			id: finding.id,
			label: finding.title || finding.target || finding.id,
			kind: "other",
			note: `自动补登自成果 ${finding.id}${finding.type ? `（类型：${finding.type}）` : ""}`,
			findingRef: finding.id
		});
	} catch { return undefined; }
}

/** 登记 + 自动上图（模型工具与测试共用同一路径）。 */
export async function registerFindingWithLink(store, sessionId, mode, args) {
	const finding = registerFinding(store, sessionId, mode, args);
	const node = await autoLinkFinding(sessionId, mode, finding);
	return { finding, node };
}

const MODES = ["pentest", "code-audit", "ctf-solver"];
const MODE_LABELS = {
	pentest: "渗透测试模式",
	"code-audit": "代码审计模式"
};
const DB_PATH = path.join(DSH_HOME, "redteam-results", "results.db");
const MAX_BODY = 5 * 1024 * 1024;

let store; // 进程级单句柄（DatabaseSync 同步 API，SQLite 自带串行化）
function theStore() {
	if (store === undefined) store = openStore(DB_PATH);
	return store;
}

//#region 通道与工具共用的业务逻辑

/** 一键验证的注入文案（用户消息；进入会话后由模型按模式验证纪律复核并回写状态）。 */
export function verifyMessage(finding) {
	const lines = [
		`[成果验证请求] 复核「redteam 成果」页 finding #${finding.seq}：${finding.title}`,
		finding.mode === "ctf-solver"
			? `模块 ${finding.type || "（未填）"} ｜ 题目地址 ${finding.target || "（未填）"} ｜ 当前状态 ${finding.status} ｜ 证据等级 ${finding.evidenceLevel}`
			: finding.mode === "incident-response"
			? `等级 ${finding.severity} ｜ 主机 ${finding.target || "（未填）"} ｜ 当前状态 ${finding.status} ｜ 证据等级 ${finding.evidenceLevel}`
			: `等级 ${finding.severity} ｜ 目标 ${finding.target || "（未填）"} ｜ 当前状态 ${finding.status} ｜ 证据等级 ${finding.evidenceLevel}`
	];
	if (finding.poc) lines.push(`${finding.mode === "ctf-solver" ? "解题材料（脚本/过程）" : finding.mode === "incident-response" ? "取证过程 / 检测命令" : "复现材料"}：\n${finding.poc}`);
	if (finding.requestPkt) lines.push(`完整请求包：\n${finding.requestPkt}`);
	if (finding.responsePkt) lines.push(`关键响应：\n${finding.responsePkt}`);
	if (finding.baseline || finding.diffEvidence || finding.markerEcho) lines.push(`对照三件套：基线=${finding.baseline || "缺"} ｜ 差分=${finding.diffEvidence || "缺"} ｜ marker=${finding.markerEcho || "缺"}`);
	if (finding.impact) lines.push(`${finding.mode === "binary-analysis" ? "能力与危害" : "影响证明"}：${finding.impact}`);
	if (finding.chain) lines.push(`${finding.mode === "code-audit" ? "工人链" : finding.mode === "attack-defense" ? "获取路径（L<级>: 链级前缀照录）" : finding.mode === "binary-analysis" ? "还原/产出链" : finding.mode === "cloud-security" ? "路径链（入口→身份→权限→资源）" : finding.mode === "ctf-solver" ? "解题路径（怎么解的）" : finding.mode === "incident-response" ? "取证过程（怎么证实）" : "调用链（entry → sink）"}：${finding.chain}`);
	if (finding.mode === "code-audit" && finding.chainTracer) lines.push(`追踪员链：${finding.chainTracer}`);
	if (finding.evidence) lines.push(`证据引用：${finding.evidence}`);
	if (finding.timelineAt) lines.push(`攻击时间：${finding.timelineAt}`);
	if (finding.entry || finding.identity || finding.permission || finding.resource) lines.push(`攻击路径四要素：入口=${finding.entry || "缺"} ｜ 身份=${finding.identity || "缺"} ｜ 权限=${finding.permission || "缺"} ｜ 资源=${finding.resource || "缺"}`);
	const statusGuide = finding.mode === "code-audit"
		? ["请按代审验证纪律复核（双链一致/扫描对账），复核后调 redteam_finding_update 回写 status / verifyNote / secondRating+secondRatingNote（首次转 verified 须成对给齐，缺一被拒）：",
			"- 静态审计：复核通过只能回写 code-reviewed（代码侧已复核）——代码级推理不得标 verified；",
			"- verified 仅限动态验证成功：EXP 本地复现真实生效，或在线授权环境实测 L1 通过；",
			"- 动态审计复现不成立 → false-positive；验证未完成/环境性失败保持 pending。"].join("\n")
		: finding.mode === "attack-defense"
		? ["请按攻防评估验证纪律复核（确定性信号按战果类型择一：对照文件字节一致 / victim 侧标记数据被读到 / OOB 回调命中；入口/注入类战果仍用对照三件套：基线/差分/marker 逐字回显），复核后调 redteam_finding_update 回写 status / verifyNote / secondRating+secondRatingNote（首次转 verified 须成对给齐，缺一被拒）：",
			"- verified=战果真实有效（上述信号至少其一成立，L 链级如实）；",
			"- 验证未完成或环境性失败（目标不可达/WAF 拦截/超时）→ 保持 pending，不得因此判 false-positive；",
			"- false-positive=复核后确认战果不成立或误记；",
			"- fixed=已交付（仅当此前已 verified）。"].join("\n")
		: finding.mode === "binary-analysis"
		? ["请按二进制分析验证纪律复核（静态优先：独立重读关键反汇编段/重跑分析脚本比对一致性；多视角结论一致=更高可信、分歧=对比结论如实写；动态验证仅在必要时建议用户指定干净隔离 VM——本次复核默认静态），复核后调 redteam_finding_update 回写 status / verifyNote / secondRating+secondRatingNote（首次转 verified 须成对给齐，缺一被拒）：",
			"- verified=已定论（字节/指令级证据支撑，结论可独立复核复现）；",
			"- suspect=疑似（静态线索成立但未到定论强度，或还原三验未全过）——合法中间态，不强行升格；",
			"- pending=分析中（复核未完成或需补充证据）；",
			"- 复核推翻原结论 → 更新 description/chain 如实记录矛盾证据，不删行。"].join("\n")
		: finding.mode === "cloud-security"
		? ["请按云安全攻防验证纪律复核（三重证据：云 API 响应+策略文档+权限清单至少其二；只读 Describe/Get/List 验证优先、限速、账单意识；四要素闭环核对：入口/身份/权限/资源逐项对证据），复核后调 redteam_finding_update 回写 status / verifyNote / secondRating+secondRatingNote（首次转 verified 须成对给齐，缺一被拒）：",
			"- verified=已证实（路径可到达性有真实云证据支撑，四要素无悬空）；",
			"- 验证未完成或环境性失败（API 不可达/权限不足/限速）→ 保持 pending，不得因此判 false-positive；",
			"- false-positive=复核后确认路径不成立或误判；",
			"- fixed=已修复（仅当此前已 verified、修复后复测不成功才可标记）。"].join("\n")
		: finding.mode === "ctf-solver"
		? ["请按 CTF 解题验证纪律复核（flag 真实性主线：flag 原文+平台回执/得分变动+解题脚本可重放，至少其二可追溯；web 题可附请求-响应对），复核后调 redteam_finding_update 回写 status / verifyNote / secondRating+secondRatingNote（首次转 verified 须成对给齐，缺一被拒）：",
			"- verified=已解（flag 已提交且平台确认得分，证据可追溯）；",
			"- stuck=卡点（思路断/技术堵点/环境问题）——写明卡在哪一步、已试过什么；",
			"- pending=未解（尚未出 flag 或验证未完成）；",
			"- 复核推翻原结论（flag 无效/非本题 flag）→ 如实更新 description 与验证记录，不删行。"].join("\n")
		: finding.mode === "incident-response"
		? ["请按应急溯源验证纪律复核（证据链交叉：日志/样本/时间戳/网络记录多源一致，时间线逐节点闭合；单条日志不构成结论），复核后调 redteam_finding_update 回写 status / verifyNote / secondRating+secondRatingNote（首次转 verified 须成对给齐，缺一被拒）：",
			"- verified=已证实（多源证据交叉确凿，证据编号可追溯）；",
			"- code-reviewed=复核通过（证据链形式复核完成，未到已证实强度不升格）；",
			"- 复核未完成或证据不足（日志缺失/时间窗未定）→ 保持 pending；",
			"- false-positive=排除（误报或与失陷无关的正常业务现象）；",
			"- fixed=已处置（处置清单执行完成并复测无再生即标——与渗透「修复后复测不成功」语义不同）；",
			"- 复核推翻原结论 → 如实更新 description 与验证记录，不删行。"].join("\n")
		: ["请按本模式验证纪律复核（渗透模式=对照三件套：基线/差分/marker 逐字回显），复核后调 redteam_finding_update 回写 status / verifyNote / secondRating+secondRatingNote（首次转 verified 须成对给齐，缺一被拒）：",
			"- verified=验证完成且真实可再复现；",
			"- suspect=疑似未定论（静态线索/侧信道现象成立，但影响链未闭环或复核只能部分复现）——合法中间态，报告按未验证项处理；",
			"- 验证未完成或环境性失败（WAF 拦截/目标不可达/超时）→ 保持 pending，不得因此判 suspect/false-positive；",
			"- false-positive=验证后确认漏洞不存在或误判；",
			"- fixed=仅当此前已 verified 真实存在、用户修复后本次复测不成功才可标记（须有本次复测记录）。"].join("\n");
	lines.push(statusGuide);
	return lines.join("\n");
}

function sessionOf(ctx, exec) {
	const agent = exec?.agent;
	const id = agent?.session?.id;
	if (!id) return undefined;
	let preset;
	try { preset = ctx.agentPresets?.composedPreset?.(agent.ctx); } catch { /* 组合未就绪 */ }
	if (typeof preset !== "string") preset = agent?.session?.header?.agentPreset;
	return { id: String(id), mode: MODES.includes(preset) ? preset : "" };
}

function resolveAgents(ctx) {
	try { return ctx.get("agents"); } catch { /* 该 fiber 未声明 agents */ }
	try { return ctx.agents; } catch { /* 同上 */ }
	return undefined;
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

/** 同源信任栅栏：Host 是本机/受信授权，且 Origin（浏览器跨站标记）与 Host 同源。 */
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
	if (endpoint === "findings.list") {
		const mode = String(p.mode ?? "redteam");
		if (p.scope === "all") {
			// 跨会话模式页：该模式全表 + created_at 范围过滤；counts=全时域侧栏计数；行带 sessionId；
			// meta 取请求会话（标签页所属会话）——模式页元数据栏不为空。
			const range = { from: String(p.from ?? ""), to: String(p.to ?? "") };
			const out = { list: listFindingsAll(st, mode, { ...p, ...range }), stats: computeStatsAll(st, mode, range), counts: modeCountsAll(st), meta: p.sessionId ? getMeta(st, String(p.sessionId)) : undefined };
			await joinChainRefs(out.list.rows, mode);
			return out;
		}
		const sessionId = String(p.sessionId ?? "");
		if (!sessionId) throw new Error("sessionId required");
		return { list: listFindings(st, sessionId, mode, p), stats: computeStats(st, sessionId, mode), counts: modeCounts(st, sessionId), meta: getMeta(st, sessionId) };
	}
	if (endpoint === "findings.groups") {
		const mode = String(p.mode ?? "redteam");
		if (p.scope === "all") {
			const range = { from: String(p.from ?? ""), to: String(p.to ?? "") };
			// 分组视图带统计（四档卡/状态 chips 在分组态不再全零）+ 请求会话 meta
			const out = { groups: groupByTargetAll(st, mode, { ...p, ...range }), stats: computeStatsAll(st, mode, range), meta: p.sessionId ? getMeta(st, String(p.sessionId)) : undefined };
			await joinChainRefs(out.groups.flatMap((g) => g.items), mode);
			return out;
		}
		const sessionId = String(p.sessionId ?? "");
		if (!sessionId) throw new Error("sessionId required");
		return { groups: groupByTarget(st, sessionId, mode, p) };
	}
	if (endpoint === "counts.all") {
		return { counts: modeCountsAll(st) };
	}
	if (endpoint === "ledger.overview") {
		if (p.scope === "all") {
			// 跨会话全局大屏：按登记时间（created_at）过滤，from/to 为 ISO 字符串（可空）
			return { overview: ledgerOverviewAll(st, { from: String(p.from ?? ""), to: String(p.to ?? "") }) };
		}
		const sessionId = String(p.sessionId ?? "");
		if (!sessionId) throw new Error("sessionId required");
		return { overview: ledgerOverview(st, sessionId), meta: getMeta(st, sessionId) };
	}
	if (endpoint === "meta.set") {
		const sessionId = String(p.sessionId ?? "");
		if (!sessionId) throw new Error("sessionId required");
		return { ok: true, meta: setMeta(st, sessionId, p) };
	}
	if (endpoint === "finding.delete") {
		const sessionId = String(p.sessionId ?? "");
		if (!sessionId) throw new Error("sessionId required");
		removeFinding(st, sessionId, String(p.id ?? ""));
		return { ok: true, counts: modeCounts(st, sessionId) };
	}
	if (endpoint === "finding.verify") {
		const sessionId = String(p.sessionId ?? "");
		const finding = getFinding(st, sessionId, String(p.id ?? ""));
		if (!finding) return { ok: false, error: "finding 不存在" };
		// 防重：同条 finding 10 分钟窗口内不重复注入复核消息（连点保护）。
		const vkey = `${sessionId}:${finding.id}`;
		const last = VERIFY_SENT.get(vkey) ?? 0;
		if (Date.now() - last < VERIFY_WINDOW_MS) return { ok: false, error: "复核请求已在此前 10 分钟内发送——请到原会话查看处理进展；确需重发请稍后再试" };
		const agents = resolveAgents(ctx);
		const agent = agents?.get?.(sessionId);
		if (!agent || typeof agent.followup !== "function") return { ok: false, unreachable: true, error: "原会话不可达（会话可能已删除或代理未运行）——可人工复核后使用「标记验证结果」兜底" };
		// 注入安全：本调用在 RPC 端点处理器内（UI 点「复核」触发），不在 Session.append 临界区里。
		agent.followup({ id: `rtr-${Date.now()}-${finding.seq}`, role: "user", content: [{ type: "text", text: verifyMessage(finding) }], source: { kind: "user" } });
		VERIFY_SENT.set(vkey, Date.now());
		if (VERIFY_SENT.size > 500) for (const [k, t] of VERIFY_SENT) if (Date.now() - t >= VERIFY_WINDOW_MS) VERIFY_SENT.delete(k);
		return { ok: true };
	}
	if (endpoint === "finding.mark") {
		// 原会话已删/不可达时的人工复核兜底：直接回写状态与复核注记（UI 动作，不经模型工具）。
		const sessionId = String(p.sessionId ?? "");
		const id = String(p.id ?? "");
		const finding = getFinding(st, sessionId, id);
		if (!finding) return { ok: false, error: "finding 不存在" };
		// 状态词表按 finding 的模式取（产物型=各自本体词、redteam=台账词表）——与 register/update 同源。
		const allowed = statusesOf(finding.mode);
		if (!allowed.includes(p.status)) return { ok: false, error: `status 必须是 ${allowed.join("/")}` };
		// 人工复核兜底同样受「二次复核成对校验」约束：转 verified 必须同一次调用给齐独立评级 + 依据。
		// 依据同时写入 secondRatingNote（评级依据）与 verifyNote（既有视图读的复核记录字段）；
		// 调用方只给 verifyNote 时自动镜像——避免 UI 多一个输入框就与模型工具路径行为不一致。
		const reviewNote = String(p.secondRatingNote ?? "").trim() || String(p.verifyNote ?? "").trim();
		const updated = updateFinding(st, sessionId, finding.mode, id, {
			status: p.status,
			verifyNote: String(p.verifyNote ?? "") || undefined,
			secondRating: p.secondRating !== undefined && String(p.secondRating) !== "" ? String(p.secondRating) : undefined,
			secondRatingNote: reviewNote || undefined,
		});
		return { ok: true, id: updated.id, status: updated.status, verifyNote: updated.verifyNote, secondRating: updated.secondRating, verdict: secondReviewVerdict(updated) };
	}
	throw new Error(`unknown endpoint ${endpoint}`);
}

//#endregion

//#region host wiring

function apply(ctx) {
	// 插件卸载时释放库句柄。句柄悬着会锁住 -wal/-shm —— Windows 上表现为这个库文件
	// 既删不掉也改不了名（备份/迁移/损坏自愈都要 rename 它）。
	// 对照 campaign-memory：它一直有这条 ctx.effect，其余插件此前都缺，
	// 插件重载/HMR 会因此留下永不回收的句柄（实测同进程二次 openStore 会 EBUSY）。
	ctx.effect(() => () => { try { store?.close?.(); } catch { /* 已关或句柄失效 */ } store = undefined; }, "dsh-redteam-results: store handle");
	//#region 模型工具（宿主平面，三种安全模式可见）
	ctx.tools.register(defineTool({
		name: "redteam_finding_register",
		description: "登记一条 finding 到本会话「redteam 成果」页。每条进报告的 finding 必登；完整字段语义、模式词表与填写纪律见 shared/refs/finding-fields.md。子代理登记落入其自身会话库。",
		parameters: {
			title: { type: "string", required: true, description: "名称（简短）" },
			severity: { type: "string", enum: SEVERITIES, description: "等级；漏洞型必填，其他模式可省略（默认 medium）" },
			target: { type: "string", required: true, description: "地址/目标/位置" },
			summary: { type: "string", required: true, description: "一句话简介" },
			type: { type: "string", description: "类型标签；按当前模式词表填写，详见 finding-fields.md" },
			description: { type: "string", description: "描述（影响与成因）" },
			poc: { type: "string", description: "测试过程+完整 EXP；复杂场景写 exp/<id>.py，简单场景写可直接复现的请求/命令" },
			chain: { type: "string", description: "调用链 entry→sink（审计双链之一，每行一链）" },
			chainTracer: { type: "string", description: "追踪员独立重追链（双链另一侧）" },
			chainVerdict: { type: "string", description: "双链结论：一致 / 不一致+差异" },
			snippetEntry: { type: "string", description: "entry 关键代码片段" },
			snippetSink: { type: "string", description: "sink 关键代码片段" },
			cwe: { type: "string", description: "CWE 编号" },
			patch: { type: "string", description: "修复 diff 建议（可选）" },
			sourceOrigin: { type: "string", enum: SOURCE_ORIGINS, description: "来源：manual / scan-confirmed / scan-false-positive" },
			sampleHash: { type: "string", description: "样本 SHA256（二进制）" },
			family: { type: "string", description: "家族/变种（二进制）" },
			packer: { type: "string", description: "壳/保护（二进制）" },
			iocs: { type: "string", description: "IOC 清单（二进制）" },
			detectionRule: { type: "string", description: "检测规则（二进制）" },
			baseline: { type: "string", description: "对照三件套①基线" },
			diffEvidence: { type: "string", description: "对照三件套②差分" },
			markerEcho: { type: "string", description: "对照三件套③marker 回显" },
			impact: { type: "string", description: "影响证明" },
			cvss: { type: "string", description: "CVSS 向量+评分" },
			requestPkt: { type: "string", description: "完整请求包（渗透）" },
			responsePkt: { type: "string", description: "关键响应（渗透）" },
			evidence: { type: "string", description: "证据引用（编号/产物路径）" },
			fix: { type: "string", description: "修复建议（每条 finding 必填）" },
			timelineAt: { type: "string", description: "时间节点（应急）" },
			entry: { type: "string", description: "入口身份（云）" },
			identity: { type: "string", description: "利用身份（云）" },
			permission: { type: "string", description: "权限（云）" },
			resource: { type: "string", description: "目标资源（云）" },
			status: { type: "string", enum: STATUSES, description: "默认 pending；suspect=疑似未定论；终态规则见 finding-fields.md" },
			evidenceLevel: { type: "string", enum: EVIDENCE_LEVELS, description: "impact / confirmed / partial / unknown；语义见 finding-fields.md" },
			auditMode: { type: "string", enum: ["static", "dynamic"], description: "代码审计必填：static=静态，dynamic=动态复现成功" }
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: true,
				properties: {
					ok: { type: "boolean", required: true },
					id: { type: "string", required: true }
				}
			},
			render: (_a, v) => [{ type: "text", text: v.ok ? `已登记成果 #${v.seq} ${v.title}（${v.mode}，${v.severity}）——本会话「redteam 成果」页可见${v.chainNode ? `，并已在攻击图补节点 ${v.chainNode}` : ""}` : `登记失败：${v.error}` }]
		},
		async execute(args, exec) {
			const session = sessionOf(ctx, exec);
			if (!session) return { ok: false, id: "", error: "无法解析当前会话（工具需在会话内调用）" };
			const { finding, node } = await registerFindingWithLink(theStore(), session.id, session.mode, args);
			return { ok: true, id: finding.id, seq: finding.seq, title: finding.title, mode: finding.mode, severity: finding.severity, chainNode: node ? node.id : "" };
		}
	}));

	ctx.tools.register(defineTool({
		name: "redteam_finding_update",
		description: "按 id 更新 finding：状态流转、字段修订、复核/复测注记。首次流转 verified 时必须同时给 secondRating 与至少 40 字的 secondRatingNote；完整语义见 shared/refs/finding-fields.md。",
		parameters: {
			id: { type: "string", required: true, description: "finding id（如 pentest-3）" },
			status: { type: "string", enum: ALL_STATUSES, description: "新状态；按当前模式终态规则，详见 finding-fields.md" },
			verifyNote: { type: "string", description: "复核注记（结论+依据，简短）" },
			secondRating: { type: "string", enum: SECOND_RATINGS, description: "复核独立给出的二次评级；首次流转 verified 时必填" },
			secondRatingNote: { type: "string", description: "二次评级依据（≥40 字）：复核方式与观察现象" },
			severity: { type: "string", enum: SEVERITIES },
			title: { type: "string" },
			type: { type: "string" },
			target: { type: "string" },
			summary: { type: "string" },
			description: { type: "string" },
			poc: { type: "string" },
			chain: { type: "string" },
			chainTracer: { type: "string" },
			chainVerdict: { type: "string" },
			snippetEntry: { type: "string" },
			snippetSink: { type: "string" },
			cwe: { type: "string" },
			patch: { type: "string" },
			sourceOrigin: { type: "string", enum: SOURCE_ORIGINS },
			sampleHash: { type: "string" },
			family: { type: "string" },
			packer: { type: "string" },
			iocs: { type: "string" },
			detectionRule: { type: "string" },
			baseline: { type: "string" },
			diffEvidence: { type: "string" },
			markerEcho: { type: "string" },
			impact: { type: "string" },
			cvss: { type: "string" },
			requestPkt: { type: "string" },
			responsePkt: { type: "string" },
			retestNote: { type: "string", description: "复测注记（修复后复测结论+依据）" },
			evidence: { type: "string" },
			fix: { type: "string" },
			timelineAt: { type: "string", description: "攻击时间节点（ISO 或 YYYY-MM-DD HH:MM）" },
			entry: { type: "string" },
			identity: { type: "string" },
			permission: { type: "string" },
			resource: { type: "string" },
			evidenceLevel: { type: "string", enum: EVIDENCE_LEVELS },
			auditMode: { type: "string", enum: ["static", "dynamic"] }
		},
		output: {
			schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true } } },
			render: (_a, v) => {
				if (!v.ok) return [{ type: "text", text: `更新失败：${v.error}` }];
				const review = v.secondRating
					? ` ｜ 二次评级 ${v.secondRating}${v.verdict === "downgrade" ? `（低于首次 ${v.severity}，报告会标注不一致）` : v.verdict === "upgrade" ? `（高于首次 ${v.severity}）` : "（与首次一致）"}`
					: "";
				return [{ type: "text", text: `成果已更新：${v.id} → ${v.status ?? "字段修订"}${v.verifyNote ? `（${v.verifyNote}）` : ""}${review}` }];
			}
		},
		execute(args, exec) {
			const session = sessionOf(ctx, exec);
			if (!session) return Promise.resolve({ ok: false, error: "无法解析当前会话" });
			const finding = updateFinding(theStore(), session.id, session.mode, args.id, args);
			if (finding === undefined) return Promise.resolve({ ok: false, error: `finding ${args.id} 不存在（本会话 ${session.mode} 页）` });
			return Promise.resolve({ ok: true, id: finding.id, status: finding.status, verifyNote: finding.verifyNote, secondRating: finding.secondRating, severity: finding.severity, verdict: secondReviewVerdict(finding) });
		}
	}));

	ctx.tools.register(defineTool({
		name: "redteam_chain_reconcile",
		description: "只读对账本会话「redteam 成果」与攻击图链路：列出未入图成果和引用不存在成果的节点。出报告前建议运行。",
		parameters: {},
		output: {
			schema: {
				type: "object", additionalProperties: true,
				properties: { ok: { type: "boolean", required: true }, available: { type: "boolean" } }
			},
			render: (_a, v) => [{ type: "text", text: renderChainReconcile(v) }]
		},
		async execute(_args, exec) {
			const session = sessionOf(ctx, exec);
			if (!session) return { ok: false, error: "无法解析当前会话" };
			const findings = allFindings(theStore(), session.id, session.mode).map((f) => ({ ...f, sessionId: session.id }));
			const chain = await atlasChainNodes(session.id, session.mode);
			if (chain === undefined) return { ok: true, available: false, unlinked: [], dangling: [], checked: { findings: findings.length, nodes: 0 } };
			const report = reconcileChain({ findings, nodes: chain.nodes, sessionId: session.id });
			return { ok: true, available: true, ...report };
		}
	}));

	ctx.tools.register(defineTool({
		name: "redteam_finding_delete",
		description: "按 id 删除本会话「redteam 成果」页的一条 finding（直接删除数据库行，统计同步更新）。",
		parameters: { id: { type: "string", required: true, description: "finding id" } },
		output: {
			schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true } } },
			render: (_a, v) => [{ type: "text", text: v.ok ? `已删除成果 ${v.id}` : `删除失败：${v.error}` }]
		},
		execute(args, exec) {
			const session = sessionOf(ctx, exec);
			if (!session) return Promise.resolve({ ok: false, error: "无法解析当前会话" });
			removeFinding(theStore(), session.id, args.id);
			return Promise.resolve({ ok: true, id: args.id });
		}
	}));
	//#endregion

	//#region Web 通道路由（better-sidebar 同款：webServer 自注册 + 同源栅栏）
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
	}), "dsh-redteam-results: web route");
	// 卸载时释放 atlas 互链句柄——否则 Windows 上库文件被占，插件重装/库迁移会失败。
	ctx.effect(() => () => { try { releaseChainRefs(); } catch { /* 卸载期静默 */ } }, "dsh-redteam-results: chain refs");
	//#endregion
}

export { MODES, MODE_LABELS, SEVERITIES, STATUSES, EVIDENCE_LEVELS, ROUTE_PATH, apply, inject, name, openStore };

//#endregion
