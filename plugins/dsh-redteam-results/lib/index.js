
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
import { fileURLToPath } from 'node:url';
import { buildDeliveryFiles, zipDelivery } from './bundle.js';
import { saveTaskContext, readTaskContext, readTaskRecord, taskContextView } from './task-context.js';
import { stageMethodPackage, readMethodPackage, methodPackageState, recordMethodReview, activateMethodPackage, listMethodPackages, activeMethodPackage } from './method-packages.js';
import { createResearch, observeResearch, assessResearch, closeResearch, researchDetail, researchIndex, researchGroups, researchNext, compactResearchResult } from './research.js';
import { executeRecordedRequest, readExecutionReceipt, executionReceiptSummary } from './execution-receipts.js';
import { verifyEffect, readEffectVerification } from './effect-verifications.js';
import { runEffectJob, readEffectJob } from './effect-jobs.js';
import { startTaskPolicy, updateTaskProgress, taskPolicyStatus, taskExecutionGuard, taskPrompt, taskOverview, chooseTaskMode, pauseTaskPolicy, resumeTaskPolicy, archiveTaskRound, takeTaskContinuation, checkpointTask, setTaskInteraction, setTaskWorkers, confirmTaskCheckpoint } from './task-policy.js';
import { taskStartInput, taskProgressInput } from './task-inputs.js';
import { chatDefaults, saveChatDefaults, promptDraft, promptTemplates } from './chat-setup.js';
import { captureTaskCost, taskCostOverview } from './task-cost.js';
import { registerModelAdmission, recoverModelRuntime, modelBudgetOverview } from './model-budget.js';
import { createSiteWorkers, siteWorkerView, siteWorkerRows, siteWorkerParent } from './site-workers.js';
import { indexBusinessMaterials, businessMaterialView } from './business-materials.js';
import { runComparisonJob, readComparisonJob, comparisonFindingInput } from './comparison-jobs.js';
import { recordImpactReview } from './impact-reviews.js';
import { PROOF_KINDS, parseReproduction, renderReproduction, renderFindingDelivery } from './delivery.js';
import { registerTaskPrompt } from './task-prompt.js';
import { defineTool } from "@deepseek-ai/dsh-tools";
import { saveChecks, readChecks, compactChecks, renderCheckedTsv } from './checked.js';
import { openStore, registerFinding, updateFinding, removeFinding, getFinding, allFindings, listFindings, listFindingsAll, groupByTarget, groupByTargetAll, computeStats, computeStatsAll, modeCounts, modeCountsAll, ledgerOverview, ledgerOverviewAll, getMeta, setMeta, SEVERITIES, STATUSES, REGISTER_STATUSES, MODE_STATUSES, ALL_STATUSES, EVIDENCE_LEVELS, SOURCE_ORIGINS, SECOND_RATINGS, secondReviewError, secondReviewVerdict, statusesOf } from "./store.js";

const name = "dsh-redteam-results";
const inject = ["tools", "webServer", "webRuntime", "agentPresets", "systemPrompt", "sessions", "agents", "subagents", "llm"];

const ROUTE_PATH = "/dsh-redteam-results";
/** 进程级 CSRF token：GET <route>/csrf 由同源页取走（跨源响应不可读），POST 须回带 x-dsh-csrf 头。 */
const CSRF_TOKEN = crypto.randomBytes(24).toString("hex");
export function checkCsrf(req, token) {
	return String(req?.headers?.["x-dsh-csrf"] ?? "") === String(token ?? "");
}
/** 验证按钮防重：sessionId:id → 最近注入时间（10 分钟窗口内不重复 followup，防连点灌多条复核消息）。 */
const VERIFY_SENT = new Map();
const VERIFY_WINDOW_MS = 10 * 60 * 1000;
const workerManagers = new WeakMap();
const modelAdmissions = new WeakMap();

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
	if (finding.mode === 'pentest' && finding.reproduction) {
		try { lines.push('完整复现方法：\n' + renderReproduction(parseReproduction(finding.reproduction))); }
		catch { lines.push('结构化复现方法不完整，请核对原记录后补齐。'); }
	}
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

const FINDING_POLICY_MODES = new Set([
	"pentest", "code-audit", "redteam", "attack-defense", "cloud-security", "incident-response",
]);
const FINDING_POLICY_SEVERITIES = new Set(["medium", "high", "critical"]);
const WEAK_FINDING_RE = /(^|[^a-z])(tls|ssl|cors|hsts|csp|x-frame-options|security headers?|missing headers?|clickjacking|banner|version disclosure|information disclosure|info disclosure|self-xss|open redirect|rate limit|cookie flags?)([^a-z]|$)/i;

/**
 * Model-facing admission policy: only medium/high/critical findings enter the
 * result ledger. Weak configuration findings need a real chain plus impact or
 * PoC; a header checklist or scanner note is not enough.
 */
export function findingAdmissionError(mode, args = {}) {
	if (!FINDING_POLICY_MODES.has(String(mode || ""))) return "";
	const severity = String(args.severity || "").toLowerCase();
	if (!FINDING_POLICY_SEVERITIES.has(severity)) {
		return "成果等级只接收 medium / high / critical；low / info 不进入成果库。请继续利用链验证，或不要登记。";
	}
	const text = [args.title, args.type, args.summary, args.description, args.impact, args.chain, args.note]
		.filter(Boolean).join(" ");
	if (!WEAK_FINDING_RE.test(text)) return "";
	const chain = String(args.chain || "").trim();
	const impact = String(args.impact || "").trim();
	const poc = String(args.poc || "").trim();
	if (!chain || (!impact && !poc)) {
		return "该条属于 TLS/CORS/安全头/信息泄露等弱配置项，默认不接收。确有利用链时，请补齐 chain（入口→影响）与 impact 或 PoC 后重新登记；否则不要写入成果。";
	}
	return "";
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

function methodAction(st, args, actor) {
  const parse = () => typeof args.document === 'string' ? JSON.parse(args.document) : args.document;
  if (args.action === 'list') return listMethodPackages(st, args.offset ?? 0);
  if (args.action === 'detail') return { ...readMethodPackage(st, args.digest), ...methodPackageState(st, args.digest) };
  if (args.action === 'active') return { method: activeMethodPackage(st, args.id) };
  if (args.action === 'stage') return stageMethodPackage(st, parse());
  if (args.action === 'review' || args.action === 'verify') return recordMethodReview(st, args.digest, args.action === 'review' ? 'review' : 'verification', parse(), actor);
  if (args.action === 'activate' || args.action === 'rollback') return activateMethodPackage(st, args.digest, args.expectedDigest, actor, args.action === 'rollback');
  throw new Error('invalid method action');
}

/** 通道端点分发（纯逻辑，供路由与测试复用）。 */
export async function dispatch(ctx, st, endpoint, payload) {
  const p = payload ?? {};
  if (endpoint === 'finding.impact-review') {
    const sid = String(p.sessionId || ''), finding = getFinding(st, sid, String(p.id || ''));
    if (!finding || finding.mode !== 'pentest') throw new Error('current pentest finding required');
    st.db.exec('BEGIN IMMEDIATE');
    try {
      recordImpactReview(st, sid, finding, p, 'desktop-action');
      const updated = updateFinding(st, sid, 'pentest', finding.id, { status: 'verified', secondRating: p.secondRating, secondRatingNote: p.note, verifyNote: p.note });
      st.db.exec('COMMIT');
      return { ok: true, id: updated.id, review: getFinding(st, sid, finding.id).executionEvidence.effectEvidence };
    } catch (error) { st.db.exec('ROLLBACK'); throw error; }
  }
  if (endpoint === 'workers.findings') {
    const row = siteWorkerRows(st, String(p.sessionId || '')).find(worker => worker.childId === p.childId);
    if (!row) throw new Error('子任务不属于当前会话');
    return { ok: true, childId: row.childId, site: row.site, question: row.question,
      list: listFindings(st, row.childId, 'pentest', { page: p.page || 1, pageSize: 12, delivery: p.delivery || 'ready' }) };
  }
  if (endpoint === 'research.index' || endpoint === 'research.detail') {
    if (!p.sessionId) throw new Error('sessionId required');
    return { ok: true, ...(endpoint === 'research.index' ? researchIndex(st, p.sessionId, p.offset) : researchDetail(st, p.sessionId, p.id)) };
  }
  if (endpoint === 'methods.action') {
    const sessionId = String(p.sessionId || '');
    const session = ctx.sessions?.get(sessionId);
    if (!session || session.header?.agentPreset !== 'pentest') throw new Error('请选择当前可用的渗透会话');
    return { ok: true, ...methodAction(st, p, 'desktop-user') };
  }
  if (['chat.settings', 'chat.defaults', 'chat.draft', 'chat.templates'].includes(endpoint)) {
    const sessionId = String(p.sessionId || '');
    const session = (ctx.sessions || ctx.get?.('sessions'))?.get(sessionId);
    if (!session || session.header?.agentPreset !== 'pentest') throw Error('请选择当前可用的渗透会话');
    if (endpoint === 'chat.draft') return { ok: true, draft: promptDraft(st, sessionId, p.mode, p.draft) };
    if (endpoint === 'chat.templates') return { ok: true, templates: promptTemplates(st, p.template) };
    if (endpoint === 'chat.defaults') return { ok: true, defaults: saveChatDefaults(st, p) };
    const state = taskPolicyStatus(st, sessionId), workers = siteWorkerView(st, sessionId);
    return { ok: true, ...state, active: workers.active, defaults: chatDefaults(st),
      agentRunning: (ctx.agents || ctx.get?.('agents'))?.get(sessionId)?.status === 'running' };
  }
  if (['task.status', 'task.choose', 'task.start', 'task.cancel', 'task.resume', 'task.cleanup', 'task.new-round', 'task.interaction', 'task.workers', 'task.continue'].includes(endpoint)) {
    const sessionId = String(p.sessionId || '');
    if (!sessionId) throw new Error('sessionId required');
    let sessions;
    try { sessions = ctx.sessions || ctx.get?.('sessions'); } catch { /* unavailable */ }
    const session = sessions?.get(sessionId);
    if (endpoint !== 'task.status') {
      if (!session || session.header?.agentPreset !== 'pentest') throw new Error('请选择当前可用的渗透会话');
      if (typeof ctx.tools?.guard !== 'function') throw new Error('桌面宿主缺少任务预算守卫');
      if (endpoint === 'task.choose') chooseTaskMode(st, sessionId, p.mode, { workflow: p.workflow, workers: p.workers, interaction: p.interaction, reporting: p.reporting });
      else if (endpoint === 'task.interaction') setTaskInteraction(st, sessionId, p.interaction, 'desktop-user', p.reporting);
      else if (endpoint === 'task.workers') setTaskWorkers(st, sessionId, p.workers, 'desktop-user');
      else if (endpoint === 'task.continue') {
        if (p.note !== undefined && (typeof p.note !== 'string' || p.note.length > 2000)) throw Error('补充思路应为2000字以内文本');
        const agent = (ctx.agents || ctx.get?.('agents'))?.get(sessionId);
        if (typeof agent?.followup !== 'function' || agent.status === 'running') throw new Error('请先等待当前回合结束，再确认继续');
        const before = taskPolicyStatus(st, sessionId).policy;
        const policy = confirmTaskCheckpoint(st, sessionId, 'desktop-user');
        try {
          // 注入安全：桌面确认 RPC 在空闲代理上追加，不在 Session.append 临界区内。
          agent.followup({ id: `saker-confirm-${sessionId}-${before.awaitingConfirmation.at}`, role: 'user', source: { kind: 'user' },
            content: [{ type: 'text', text: '[Saker 用户确认继续] '+taskPrompt(taskPolicyStatus(st, sessionId))+(p.note?.trim()?'\n用户补充思路：'+p.note.trim()+'\n':'')+'沿用户指定的思路继续，保留原预算与资料。' }] });
        } catch (error) {
          st.db.prepare('UPDATE task_policy SET record=? WHERE session_id=?').run(JSON.stringify({ ...policy, awaitingConfirmation: before.awaitingConfirmation }), sessionId);
          throw new Error('未能投递继续消息，仍等待确认：'+error.message);
        }
      }
      else if (endpoint === 'task.start') {
        if((p.policy?.budget?.modelCalls!==undefined || p.policy?.budget?.tokens!==undefined) && !modelAdmissions.get(ctx)?.available)
          throw new Error('宿主缺少模型请求准入钩子，不能执行共享模型额度');
        const agent = (ctx.agents || ctx.get?.('agents'))?.get(sessionId);
        if (typeof agent?.followup !== 'function') throw new Error('当前代理不可用，任务尚未开始；请打开该会话后重试');
        if (agent.status === 'running') throw new Error('当前模型仍在运行，请先停止或等待完成');
        const policy = startTaskPolicy(st, sessionId, p.policy);
        try {
          // 注入安全：由桌面 task.start RPC 在空闲代理上触发，不在 Session.append 临界区内。
          agent.followup({ id: `saker-task-${sessionId}-${policy.startedAt}`, role: 'user',
            content: [{ type: 'text', text: `请开始桌面已经设置的小任务：${policy.question}。沿相关路径推进，使用已有资料、范围和预算；不要重复开始任务或重置预算。缺少关键资料、遇到阻碍或当前路径结束时再向用户说明。` }], source: { kind: 'user' } });
        } catch (error) {
          updateTaskProgress(st, sessionId, { cancelled: true });
          throw new Error(`模型未能开始，已停止本轮，请保留资料后重新选择问题：${error.message}`);
        }
      }
      else if (endpoint === 'task.resume') resumeTaskPolicy(st, sessionId, p.note, 'desktop-user');
      else if (endpoint === 'task.cancel') {
        const agent = (ctx.agents || ctx.get?.('agents'))?.get(sessionId);
        if (typeof agent?.cancel !== 'function') throw new Error('当前代理不可用，尚未确认模型停止；请打开该会话后重试');
        updateTaskProgress(st, sessionId, { cancelled: true });
        agent.cancel({ kind: 'user' });
      }
      else if (endpoint === 'task.new-round') {
        const agent = (ctx.agents || ctx.get?.('agents'))?.get(sessionId);
        if (agent?.status === 'running') throw new Error('当前模型仍在运行，请先停止或等待完成');
        archiveTaskRound(st, sessionId, 'desktop-user');
      }
      if (endpoint === 'task.cancel' || endpoint === 'task.cleanup') {
        const manager = workerManagers.get(ctx), agent = (ctx.agents || ctx.get?.('agents'))?.get(sessionId);
        if (siteWorkerView(st, sessionId).active) {
          if (!manager || !agent) throw new Error('当前代理不可用；子代理释放尚未确认，请刷新或重启宿主后核对');
          await manager.cleanup(agent, p.childId, endpoint === 'task.cancel' ? 'desktop-user cancelled' : 'desktop-user cleanup');
        }
      }
    }
    let workers = siteWorkerView(st, sessionId);
    const manager = workerManagers.get(ctx), agent = (ctx.agents || ctx.get?.('agents'))?.get(sessionId);
    if (manager && agent && workers.workers.length) workers = await manager.status(agent);
    const overview = taskOverview(st, sessionId), cost = taskCostOverview(ctx, st, sessionId);
    return { ok: true, isPentest: session?.header?.agentPreset === 'pentest', ...overview, ...workers, cost,
      roundCost: overview.policy ? taskCostOverview(ctx, st, sessionId, overview.policy.startedAt) : null,
      modelBudget: overview.policy ? modelBudgetOverview(st,sessionId) : null,
      previousRounds: st.db.prepare('SELECT count(*) AS n FROM task_rounds WHERE session_id=?').get(sessionId).n,
      elapsedSeconds: overview.policy ? Math.max(0, Math.floor((Math.min(Date.now(), overview.policy.finishedAt ?? Infinity, overview.policy.budget.deadline ?? Infinity) - overview.policy.startedAt) / 1000)) : 0 };
  }
  if (endpoint === 'context.index' || endpoint === 'context.detail') {
    const sessionId = String(p.sessionId || '');
    if (!sessionId) throw new Error('sessionId required');
    const context = readTaskContext(st, sessionId);
    if (endpoint === 'context.detail' && p.version !== undefined && ['request', 'method'].includes(p.kind)) {
      const field = p.kind === 'request' ? 'requests' : 'methods';
      if (!context?.[field].some(row => row.id === p.id && (row.revision || row.version) === p.version)) {
        const item = readTaskRecord(st, sessionId, p.kind, p.id, p.version);
        if (!item) throw new Error('record not found in current session');
        return { ok: true, item, historical: true, text: '历史版本，须核对当前身份和基线后使用：\n' + JSON.stringify(item, null, 2) };
      }
    }
    return { ok: true, ...taskContextView(context, endpoint === 'context.index' ? { offset: p.offset } : p) };
  }
	if (endpoint === 'delivery.bundle') {
		const sessionId = String(p.sessionId ?? '');
		if (!sessionId) throw new Error('sessionId required');
		const bundle = buildDeliveryFiles(allFindings(st, sessionId, 'pentest'), readChecks(st, sessionId));
		return { ok: true, filename: 'saker-delivery.zip', archive: zipDelivery(bundle.files).toString('base64'),
			confirmedFindings: bundle.confirmedFindings, incompleteRecords: bundle.incompleteRecords, checkedCount: bundle.checkedCount };
	}
	if (endpoint === 'checks.list' || endpoint === 'checks.export') {
		const rows = readChecks(st, String(p.sessionId ?? ''));
		return endpoint === 'checks.list' ? { ok: true, rows: compactChecks(rows) }
			: { ok: true, text: renderCheckedTsv(rows), filename: 'checked.tsv' };
	}
	if (endpoint === "findings.list") {
		const mode = String(p.mode ?? "redteam");
		if (p.scope === "all") {
			// 跨会话模式页：该模式全表 + created_at 范围过滤；counts=全时域侧栏计数；行带 sessionId；
			// meta 取请求会话（标签页所属会话）——模式页元数据栏不为空。
			const range = { from: String(p.from ?? ""), to: String(p.to ?? "") };
			const out = { list: listFindingsAll(st, mode, { ...p, ...range }), stats: computeStatsAll(st, mode, range), counts: modeCountsAll(st), meta: p.sessionId ? getMeta(st, String(p.sessionId)) : undefined };
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
			return out;
		}
		const sessionId = String(p.sessionId ?? "");
		if (!sessionId) throw new Error("sessionId required");
		return { groups: groupByTarget(st, sessionId, mode, p), stats: computeStats(st, sessionId, mode), meta: getMeta(st, sessionId) };
	}
	if (endpoint === "counts.all") {
		return { counts: modeCountsAll(st) };
	}
	if (endpoint === "counts.session") {
		const sessionId = String(p.sessionId ?? "");
		if (!sessionId) throw new Error("sessionId required");
		return { counts: modeCounts(st, sessionId) };
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
	if (endpoint === 'finding.delivery') {
		const sessionId = String(p.sessionId ?? '');
		if (!sessionId) throw new Error('sessionId required');
		const finding = getFinding(st, sessionId, String(p.id ?? ''));
		if (!finding || finding.mode !== 'pentest') return { ok: false, error: 'pentest finding not found' };
		return { ok: true, text: renderFindingDelivery(finding), filename: finding.id + '-reproduction.md' };
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
  const modelAdmission=registerModelAdmission(ctx,theStore,{countInput:options=>{
    let counter;try{counter=ctx.get?.('sakerInputCounter');}catch{ /* optional certified provider counter is unavailable */ }
    return counter?.countInput?.(options);
  }});
  modelAdmissions.set(ctx,modelAdmission);
  ctx.on?.('session/event', (session, event) => {
    if (session?.header?.agentPreset !== 'pentest' && !siteWorkerParent(theStore(), session?.id || '')) return;
    captureTaskCost(theStore(), session, event);
  });
  ctx.on?.('agent/turn-stopping', ({ agent, signal }) => {
    const session = sessionOf(ctx, { agent });
    if (!session || session.mode !== 'pentest' || signal?.aborted || typeof agent.steer !== 'function') return;
    const message = takeTaskContinuation(theStore(), session.id);
    if (message) {
      // 注入安全：agent/turn-stopping 在回合停止检查中派发，不在 Session.append 发布临界区内；steer 使宿主继续当前回合。
      try { agent.steer(message); }
      catch (error) { pauseTaskPolicy(theStore(), session.id, { code: 'needs-user', reason: '自动衔接未能继续', evidence: String(error.message || error) }, 'host-continuation-failure'); }
    }
  });
  const siteWorkers = createSiteWorkers(ctx, theStore);
  workerManagers.set(ctx, siteWorkers);
  registerTaskPrompt(ctx, assembly => sessionOf(ctx, { agent: assembly?.agent })?.mode === 'pentest',
    assembly => {
      const session = sessionOf(ctx, { agent: assembly?.agent });
      if (!session || session.mode !== 'pentest') return '';
      try { return taskPrompt(taskPolicyStatus(theStore(), session.id)); }
      catch { return '本会话任务状态无法读取，停止目标操作并报告原因；不要重建或重置历史。'; }
    });
  const enforcementAvailable = typeof ctx.tools.guard === 'function';
  if (enforcementAvailable) ctx.tools.guard(exec => {
    const session = sessionOf(ctx, exec);
    if (!session || session.mode !== 'pentest') return undefined;
    try { return taskExecutionGuard(theStore(), session.id, exec.name); }
    catch (error) { return '任务策略无法读取，停止目标操作：' + error.message; }
  });
	// 插件卸载时释放库句柄。句柄悬着会锁住 -wal/-shm —— Windows 上表现为这个库文件
	// 既删不掉也改不了名（备份/迁移/损坏自愈都要 rename 它）。
	// 对照 campaign-memory：它一直有这条 ctx.effect，其余插件此前都缺，
	// 插件重载/HMR 会因此留下永不回收的句柄（实测同进程二次 openStore 会 EBUSY）。
	ctx.effect(() => async () => { await siteWorkers.dispose(); workerManagers.delete(ctx); await modelAdmission.dispose(); modelAdmissions.delete(ctx); if(store)recoverModelRuntime(store,modelAdmission.runtimeId); try { store?.close?.(); } catch { /* 已关或句柄失效 */ } store = undefined; }, "dsh-redteam-results: store handle");
	//#region 模型工具（宿主平面，三种安全模式可见）
	ctx.tools.register(defineTool({
		name: "redteam_finding_register",
		description: "登记本会话成果。弱配置须有真实影响和利用链；登记后独立复核才能交付。子代理成果保存在子会话。",
		parameters: {
			title: { type: "string", required: true, description: "名称（简短）" },
			severity: { type: "string", enum: SEVERITIES, description: "等级；漏洞型必填，其他模式可省略（默认 medium）" },
			target: { type: "string", required: true, description: "地址/目标/位置" },
			summary: { type: "string", required: true, description: "一句话简介" },
			type: { type: "string", description: "类型标签；按当前模式词表填写，详见 finding-fields.md" },
			description: { type: "string", description: "描述（影响与成因）" },
			poc: { type: "string", description: "测试过程+完整 EXP；复杂场景写 exp/<id>.py，简单场景写可直接复现的请求/命令" },
			proofKind: { type: "string", enum: PROOF_KINDS, description: "证据类型；interaction 不代表 execution" },
			reproduction: { type: "string", description: "旧完整方法JSON；reviewSteps为字符串。已有对照优先用comparisonId" },
      comparisonId: { type: 'string', description: 'run-pair的id（pair-…）：自动填回执和方法，保留待复核读取线索' },
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
			status: { type: "string", enum: REGISTER_STATUSES, description: "默认pending，登记拒绝verified；复核用finding_update同时给secondRating及≥40字secondRatingNote。fixed仅redteam模式，详见finding-fields.md" },
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
			render: (_a, v) => [{ type: "text", text: v.ok ? `已登记成果 #${v.seq} ${v.title}（${v.mode}，${v.severity}）——本会话「redteam 成果」页可见` : `登记失败：${v.error}${v.recovery ? '\n' + v.recovery : ''}` }]
		},
		async execute(args, exec) {
			const session = sessionOf(ctx, exec);
			if (!session) return { ok: false, id: "", error: "无法解析当前会话（工具需在会话内调用）" };
      try {
        const input = args.comparisonId ? comparisonFindingInput(theStore(), session.id, args) : args;
        const policyError = findingAdmissionError(session.mode, input);
        if (policyError) return { ok: false, id: '', error: policyError };
        if (input.reproduction) {
          try { parseReproduction(input.reproduction); }
          catch (error) { return { ok: false, id: '', error: error.message,
            recovery: 'reproduction须为JSON方法对象，不能填编号文本。一次补齐：kind="method"；mechanism/methodVersion/endpoint/successCriterion/reviewSteps/recovery为非空字符串；prerequisites/dependencies/parameters/steps为字符串数组（steps须含实际可操作步骤）；verification为嵌套对象，含status="verified"或"not-run"及evidenceIds字符串数组。verified必须有实际复现依据，不得补造；宿主执行及独立影响复核仍另行校验。普通步骤文本放poc；已有run-pair用comparisonId。无法补齐时保留原始依据并停止登记重试。' }; }
        }
        if (args.comparisonId) {
          const saved = allFindings(theStore(), session.id, session.mode).find(row => row.reproduction === input.reproduction);
          if (saved) return { ok: true, id: saved.id, seq: saved.seq, title: saved.title, mode: saved.mode, severity: saved.severity, reused: true };
        }
        const finding = registerFinding(theStore(), session.id, session.mode, input);
        return { ok: true, id: finding.id, seq: finding.seq, title: finding.title, mode: finding.mode, severity: finding.severity };
      } catch (error) { return { ok: false, id: '', error: error.message }; }
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
			proofKind: { type: "string", enum: PROOF_KINDS },
			reproduction: { type: "string" },
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
				const delivery = v.delivery ? (v.delivery.ready ? ' ｜ 可交付' : ' ｜ 待验证／不可交付：' + v.delivery.gaps.join(', ')) : '';
				return [{ type: "text", text: `成果已更新：${v.id} → ${v.status ?? "字段修订"}${v.verifyNote ? `（${v.verifyNote}）` : ""}${review}${delivery}` }];
			}
		},
		execute(args, exec) {
			const session = sessionOf(ctx, exec);
			if (!session) return Promise.resolve({ ok: false, error: "无法解析当前会话" });
			if (args.severity !== undefined) {
				const current = getFinding(theStore(), session.id, args.id);
				const policyError = findingAdmissionError(session.mode, { ...(current || {}), ...args });
				if (policyError) return Promise.resolve({ ok: false, error: policyError });
			}
			const finding = updateFinding(theStore(), session.id, session.mode, args.id, args);
			if (finding === undefined) return Promise.resolve({ ok: false, error: `finding ${args.id} 不存在（本会话 ${session.mode} 页）` });
			return Promise.resolve({ ok: true, id: finding.id, status: finding.status, verifyNote: finding.verifyNote, secondRating: finding.secondRating, severity: finding.severity, verdict: secondReviewVerdict(finding),
        ...(finding.delivery ? { delivery: { ready: finding.delivery.ready, executionVerified: finding.delivery.executionVerified, gaps: finding.delivery.gaps } } : {}) });
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
  ctx.tools.register(defineTool({
    name: 'redteam_method',
    description: '精选方法包：按摘要读取离线资料，暂存固定版本与审阅/正反例证据。激活和回退由成果页明确审阅操作完成。',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'detail', 'active', 'stage', 'review', 'verify'], description: '方法资料操作，契约见README' },
      digest: { type: 'string', description: '固定版本SHA256摘要' },
      id: { type: 'string', description: 'active读取的方法ID' },
      document: { type: 'string', description: 'stage方法包或review/verify记录的JSON' },
      offset: { type: 'integer', description: '索引偏移，每页20条' }
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.ok ? JSON.stringify(value, null, 2) : value.error }]
    },
    execute(args, exec) {
      const session = sessionOf(ctx, exec);
      if (!session || session.mode !== 'pentest') return Promise.resolve({ ok: false, error: '仅当前渗透会话可管理方法资料' });
      try { return Promise.resolve({ ok: true, ...methodAction(theStore(), args, 'model:' + session.id) }); }
      catch (error) { return Promise.resolve({ ok: false, error: error.message }); }
    }
  }));
  ctx.tools.register(defineTool({
    name: 'redteam_execution',
    description: '执行已存请求。run-pair批次保存正常/异常对照与事实差异；run-effect核对已审阅效果；回执不是漏洞。契约见README。',
    parameters: {
      action: { type: 'string', required: true, enum: ['run', 'detail', 'run-pair', 'pair-detail', 'run-effect', 'job-detail', 'verify-effect', 'effect-detail'] },
      document: { type: 'string', description: 'JSON：run-pair含hypothesisId、normal/probe请求引用；run-effect含methodId/version、roles；verify-effect含rounds，见README' },
      hypothesisId: { type: 'string', description: 'run：当前验证方向ID' },
      requestId: { type: 'string', description: 'run：redteam_context中已保存的请求ID' },
      requestRevision: { type: 'string', description: 'run：已保存请求版本' },
      purpose: { type: 'string', enum: ['baseline'], description: 'run：用户处理阻碍后复查正常GET/HEAD' },
      methodId: { type: 'string', description: 'run：用于复现绑定时提供当前已审阅方法ID' },
      methodVersion: { type: 'string', description: 'run：与methodId同时提供，绑定当前方法版本' },
      id: { type: 'string', description: 'detail：宿主生成的回执ID' },
      timeoutMs: { type: 'integer', description: 'run：100到15000，默认5000' },
      maxBytes: { type: 'integer', description: 'run：响应体上限64到65536，默认65536' }
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } },
      render: (args, value) => [{ type: 'text', text: value.ok ? JSON.stringify(args.action === 'run' ? { ok: true, ...executionReceiptSummary(value) } : value) : value.error }]
    },
    async execute(args, exec) {
      const session = sessionOf(ctx, exec);
      if (!session || session.mode !== 'pentest') return { ok: false, error: '仅当前渗透会话可执行已保存请求' };
      try {
        const store = theStore();
        if (args.action === 'run') return { ok: true, ...await executeRecordedRequest(store, session.id, args, undefined, exec.signal) };
        if (args.action === 'run-pair') return { ok: true, ...await runComparisonJob(store, session.id, JSON.parse(args.document), exec.signal) };
        if (args.action === 'pair-detail') return { ok: true, ...readComparisonJob(store, session.id, args.id) };
        if (args.action === 'detail') return { ok: true, ...readExecutionReceipt(store, session.id, args.id) };
        if (args.action === 'run-effect') return { ok: true, ...await runEffectJob(store, session.id, JSON.parse(args.document), exec.signal) };
        if (args.action === 'job-detail') return { ok: true, ...readEffectJob(store, session.id, args.id) };
        if (args.action === 'verify-effect') return { ok: true, ...verifyEffect(store, session.id, JSON.parse(args.document)) };
        if (args.action === 'effect-detail') return { ok: true, ...readEffectVerification(store, session.id, args.id) };
        throw new Error('invalid execution action');
      } catch (error) { return { ok: false, error: error.message }; }
    }
  }));
  ctx.tools.register(defineTool({
    name: 'redteam_research',
    description: '围绕实际输入研究具体问题，自动保留对照证据；无新信息停止当前方向。结论须独立复核，detail读完整记录。',
    parameters: {
      action: { type: 'string', required: true, enum: ['groups', 'list', 'detail', 'create', 'observe', 'assess', 'close'], description: '契约见README' },
      id: { type: 'string', description: 'detail/observe/assess/close必填：验证方向ID；不是观察id' },
      document: { type: 'string', description: 'create JSON：id/requestId/requestRevision/question/expectedEffect/negativeResult/nextStep。observe绑定两张回执；close写理由。assess旧JSON兼容。' },
      observationId: { type: 'string', description: 'assess：run-pair返回的观察ID，不重发请求' },
      outcome: { type: 'string', enum: ['support', 'counterevidence', 'no-information'], description: 'assess：支持/反证/无新信息；difference不能作为结论' },
      interpretation: { type: 'string', description: 'assess：身份、对象和实际效果如何支持或反驳；回执已保存，不另填阴性台账' },
      nextInformation: { type: 'string', description: 'assess：下一项必要信息或待独立复核' },
      restriction: { type: 'string', enum: ['safety-policy', 'tool-policy'], description: '仅close：实际被安全或工具策略中断时填写；记录受限未覆盖，不增加尝试或伪造报文' },
      offset: { type: 'integer', description: 'list索引偏移，每页20条' }
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } },
      render: (args, value) => [{ type: 'text', text: value.ok ? JSON.stringify(args.action === 'detail' ? value : { ok: true, ...compactResearchResult(value) }, null, 2) : value.error }]
    },
    execute(args, exec) {
      const session = sessionOf(ctx, exec);
      if (!session || session.mode !== 'pentest') return Promise.resolve({ ok: false, error: '仅当前渗透会话可管理研究记录' });
      try {
        if (args.restriction !== undefined && args.action !== 'close') throw new Error('restriction is only valid for close');
        if (['detail', 'observe', 'assess', 'close'].includes(args.action) && !args.id) throw new Error('outer id=<hypothesis ID> is required; assess uses observationId for the comparison ID, observe uses document.id');
        const store = theStore();
        let result;
        if (args.action === 'groups') result = researchGroups(store, session.id);
        else if (args.action === 'list') result = researchIndex(store, session.id, args.offset);
        else if (args.action === 'detail') result = researchDetail(store, session.id, args.id);
        else if (args.action === 'create') result = createResearch(store, session.id, JSON.parse(args.document));
        else if (args.action === 'observe') result = observeResearch(store, session.id, args.id, JSON.parse(args.document));
        else if (args.action === 'assess') result = assessResearch(store, session.id, args.id, args.document ? JSON.parse(args.document) : { observationId: args.observationId, outcome: args.outcome, interpretation: args.interpretation, nextInformation: args.nextInformation });
        else if (args.action === 'close') result = closeResearch(store, session.id, args.id, args.document, args.restriction);
        else throw new Error('invalid research action');
        return Promise.resolve({ ok: true, ...result });
      } catch (error) { return Promise.resolve({ ok: false, error: error.message }); }
    }
  }));
	ctx.tools.register(defineTool({
		name: 'redteam_task',
		description: 'start用独立字段。progress：单模式planComplete，衔接regularComplete/ndayComplete。checkpoint按频率等待；delegate说明必要性，结束cleanup。',
		parameters: {
			action: { type: 'string', enum: ['start', 'status', 'next', 'progress', 'checkpoint', 'cancel', 'pause', 'delegate', 'workers', 'send', 'report', 'cleanup'], required: true },
			mode: { type: 'string', enum: ['regular', 'nday', '0day'] },
			target: { type: 'string' },
			question: { type: 'string', description: '问题≤600字' },
			toolCalls: { type: 'integer', description: '整轮共享工具上限1–10000' },
      modelCalls: { type: 'integer', description: '可选：主/子代理、重试、压缩及标题共享模型调用上限1–10000；开始前设置' },
			minutes: { type: 'integer', description: '时间上限1–10080分钟' },
			workers: { type: 'integer', description: '子代理0–16，≤桌面上限；小任务0' },
			discoveryCalls: { type: 'integer', description: '0day探路额度0至toolCalls' },
			workflow: { type: 'string', enum: ['single', 'regular-to-nday', 'regular-with-nday'], description: '省略沿用桌面；衔接限regular' },
			stop: { type: 'string', enum: ['budget', 'queue', 'first-high', 'first-rce'] },
			policy: { type: 'string', description: '旧JSON，与独立字段互斥' },
			progress: { type: 'string', description: '进度JSON：完成标记和note' },
      planComplete: { type: 'boolean' },
      queueComplete: { type: 'boolean' },
      regularComplete: { type: 'boolean' },
      ndayComplete: { type: 'boolean' },
      document: { type: 'string', description: 'JSON：delegate site/question/need/reason/focus；send childId/message；report state/summary；pause code/reason/evidence；checkpoint note；cleanup可选childId' }
		},
		output: {
			schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } },
			render: (_args, value) => [{ type: 'text', text: value.ok ? JSON.stringify(value, null, 2) : `错误：${value.error}${value.recovery ? '\n' + value.recovery : ''}` }]
		},
		async execute(args, exec) {
			const session = sessionOf(ctx, exec);
			if (!session || session.mode !== 'pentest') return Promise.resolve({ ok: false, error: '仅当前渗透会话可管理任务策略' });
			try {
				if (args.action === 'start') {
					if (!enforcementAvailable) throw new Error('宿主缺少tools.guard，不能启动有预算保证的任务；请使用受支持桌面版本');
          const input=taskStartInput(args);
          if((input.budget?.modelCalls!==undefined || input.budget?.tokens!==undefined) && !modelAdmission.available)
            throw new Error('宿主缺少模型请求准入钩子，不能执行共享模型额度');
					startTaskPolicy(theStore(), session.id, input);
				} else if (args.action === 'progress') {
          updateTaskProgress(theStore(), session.id, taskProgressInput(args));
        }
        else if (args.action === 'checkpoint') checkpointTask(theStore(), session.id, JSON.parse(args.document).note);
        else if (args.action === 'pause') pauseTaskPolicy(theStore(), session.id, JSON.parse(args.document));
        else if (args.action === 'delegate') return { ok: true, ...await siteWorkers.delegate(exec.agent, JSON.parse(args.document), exec.signal) };
        else if (args.action === 'workers') return { ok: true, ...await siteWorkers.status(exec.agent, exec.signal) };
        else if (args.action === 'send') return { ok: true, ...await siteWorkers.send(exec.agent, JSON.parse(args.document), exec.signal) };
        else if (args.action === 'report') return { ok: true, ...await siteWorkers.report(exec.agent, JSON.parse(args.document), exec.signal) };
        else if (args.action === 'cleanup') { const input = args.document ? JSON.parse(args.document) : {}; return { ok: true, ...await siteWorkers.cleanup(exec.agent, input.childId, input.reason || 'task ended') }; }
				else if (args.action === 'cancel') {
          updateTaskProgress(theStore(), session.id, { cancelled: true });
          if (siteWorkerParent(theStore(), session.id)) await siteWorkers.report(exec.agent, { state: 'blocked', summary: '子任务已取消；保留实际证据并释放子代理。' }, exec.signal);
          else await siteWorkers.cleanup(exec.agent, undefined, 'cancelled');
        }
				else if (!['status', 'next'].includes(args.action)) throw new Error('invalid task action');
				const state = taskPolicyStatus(theStore(), session.id);
				return Promise.resolve({ ok: true, enforcementAvailable, ...state, ...(args.action === 'next' && state.configured && !state.stopped ? { next: researchNext(theStore(), session.id) } : {}) });
			} catch (error) { return Promise.resolve({ ok: false, error: error.message,
        ...(args.action === 'start' ? { recovery: '使用start独立字段：mode=regular/nday/0day，target=实际URL，question=当前问题，toolCalls=有限额度；workflow通常省略，人数沿用桌面上限。已有任务不能重启或重置预算。' } : {}) }); }
		}
	}));
	ctx.tools.register(defineTool({
		name: 'redteam_context',
		description: '保存或读取本渗透会话共享资产、入口条件、请求及方法上下文；供Nday/常规/研究复用。',
		parameters: {
			context: { type: 'string', description: '省略读索引；JSON快照assets/checks/requests/methods/maxSupplementAttempts；契约见README。' },
			kind: { type: 'string', description: 'asset/request/method详情；material读业务材料索引或详情' },
      materials: { type: 'string', description: 'JSON：site、files[{path,url}]；离线索引选定JS，增量摘要不证明接口可用' },
			id: { type: 'string', description: '详情记录ID，仅本会话' },
			version: { type: 'string', description: '请求revision或方法version；多版本时必填' },
			offset: { type: 'integer', description: '索引偏移，默认0，每次20条' }
		},
		output: {
			schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } },
			render: (_args, value) => [{ type: 'text', text: value.ok ? value.text : value.error }]
		},
		execute(args, exec) {
			const session = sessionOf(ctx, exec);
			if (!session || session.mode !== 'pentest') return Promise.resolve({ ok: false, error: '仅当前渗透会话可读写共享上下文' });
		try {
        if (args.materials !== undefined && ([args.context, args.id, args.version].some(value => value !== undefined)
          || (args.kind !== undefined && args.kind !== 'material') || (args.offset !== undefined && args.offset !== 0)))
          throw new Error('索引只传materials；可附kind=material和offset=0。不要context/id/version；files需要选定文件的path和url。');
        if (args.materials === undefined && args.kind === 'material' && [args.context, args.version, args.offset].some(value => value !== undefined)) throw new Error('材料详情不能与快照或版本查询混用');
        if (args.materials !== undefined) return Promise.resolve({ ok: true, ...indexBusinessMaterials(theStore(), session.id, exec.agent.session.header.cwd, JSON.parse(args.materials)) });
        if (args.kind === 'material') return Promise.resolve({ ok: true, ...businessMaterialView(theStore(), session.id, { id: args.id }) });
				if (args.context !== undefined && (args.kind !== undefined || args.id !== undefined || args.version !== undefined)) throw new Error('保存快照与详情查询应分开调用');
				const context = args.context === undefined ? readTaskContext(theStore(), session.id) : saveTaskContext(theStore(), session.id, JSON.parse(args.context));
				if (args.version !== undefined && ['request', 'method'].includes(args.kind)) {
					const field = args.kind === 'request' ? 'requests' : 'methods';
					if (!context?.[field].some(row => row.id === args.id && (row.revision || row.version) === args.version)) {
						const item = readTaskRecord(theStore(), session.id, args.kind, args.id, args.version);
						if (!item) throw new Error('record not found in current session');
						return Promise.resolve({ ok: true, item, historical: true, text: '历史版本，须核对当前身份和基线后使用：\n' + JSON.stringify(item, null, 2) });
					}
				}
				return Promise.resolve({ ok: true, context, ...taskContextView(context, args) });
			} catch (error) { return Promise.resolve({ ok: false, error: error.message }); }
		}
	}));
	ctx.tools.register(defineTool({
		name: 'redteam_delivery',
		description: '将本会话已复核有效漏洞、完整复现材料、脱敏关键证据和极简已测清单打为ZIP，保存到会话工作目录；不完整成果不计入。',
		parameters: {},
		output: {
			schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } },
			render: (_args, value) => [{ type: 'text', text: value.ok ? `交付包：${value.path}；有效漏洞 ${value.confirmedFindings}，检查 ${value.checkedCount}，待补齐 ${value.incompleteRecords}` : value.error }]
		},
		execute(_args, exec) {
			const session = sessionOf(ctx, exec);
			if (!session || session.mode !== 'pentest') return Promise.resolve({ ok: false, error: '仅当前渗透会话可生成交付包' });
			try {
				let cwd = exec.agent.session.header?.cwd;
				if (typeof cwd !== 'string' || !cwd) throw new Error('会话工作目录缺失');
				if (cwd.startsWith('file:')) cwd = fileURLToPath(cwd);
				if (!path.isAbsolute(cwd)) throw new Error('会话工作目录必须为绝对路径');
				cwd = fs.realpathSync(cwd);
				const bundle = buildDeliveryFiles(allFindings(theStore(), session.id, 'pentest'), readChecks(theStore(), session.id));
				const target = path.join(cwd, 'saker-delivery-' + crypto.randomUUID() + '.zip');
				fs.writeFileSync(target, zipDelivery(bundle.files), { flag: 'wx' });
				return Promise.resolve({ ok: true, path: target, confirmedFindings: bundle.confirmedFindings, incompleteRecords: bundle.incompleteRecords, checkedCount: bundle.checkedCount });
			} catch (error) { return Promise.resolve({ ok: false, error: error.message }); }
		}
	}));
	ctx.tools.register(defineTool({
		name: 'redteam_checks',
		description: '本会话渗透检查记录：批量保存或读取。未命中需有效请求、观察及执行证据；详细原因留本地，交付仅三列。',
		parameters: { records: { type: 'string', description: '省略读取；JSON数组，含assetId/entryId/endpoint/methodVersion/authContext/requestRevision、status(not-hit/not-applicable/blocked/not-tested)、executed/requestValid/observationValid、evidenceIds、reason；可附asset/check及supplementAttempts。' } },
		output: {
			schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } },
			render: (_args, value) => [{ type: 'text', text: value.ok ? value.text : value.error }]
		},
		execute(args, exec) {
			const session = sessionOf(ctx, exec);
			if (!session || session.mode !== 'pentest') return Promise.resolve({ ok: false, error: '仅当前渗透会话可读写检查记录' });
			try {
				const rows = args.records === undefined ? readChecks(theStore(), session.id) : saveChecks(theStore(), session.id, JSON.parse(args.records));
				return Promise.resolve({ ok: true, rows, text: renderCheckedTsv(rows) });
			} catch (error) { return Promise.resolve({ ok: false, error: error.message }); }
		}
	}));
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
	//#endregion
}

export { MODES, MODE_LABELS, SEVERITIES, STATUSES, EVIDENCE_LEVELS, ROUTE_PATH, apply, inject, name, openStore };

//#endregion
