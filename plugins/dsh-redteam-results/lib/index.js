
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
import { recordRetest, listRetests, retestSummary, RETEST_VERDICTS, markVerifyStarted, clearVerifyStarted, listVerifyStarted } from './retest.js';
import { verifyEffect, readEffectVerification } from './effect-verifications.js';
import { readOobConfig, issueCallbackHost, fetchOobRecords, recordInteraction, readInteractionRecord, interactionSummary } from './server-side-access.js';
import { runBrowserExecution, recordBrowserReceipt, readBrowserReceipt } from './browser-execution.js';
import { runEffectJob, readEffectJob } from './effect-jobs.js';
import { startTaskPolicy, updateTaskProgress, taskPolicyStatus, readTaskPolicy, taskExecutionGuard, taskPrompt, taskPromptStable, taskOverview, chooseTaskMode, pauseTaskPolicy, resumeTaskPolicy, archiveTaskRound, takeTaskContinuation, finishTaskOnTurnEnd, checkpointTask, setTaskInteraction, setTaskWorkers, setTaskExplain, setTaskActionLimits, updateTaskFromChat, targetTrafficDenial, excludedPathDenial, effectivePolicy, confirmTaskCheckpoint } from './task-policy.js';
import { projectContinuation, projectTurnDecision, markProjectContinuation, pauseProjectRun, resumeProjectRun, projectExecutableChecks, selectProjectCheck, startProjectTask, setProjectRunState, completeProjectRun } from './project-runtime.js';
import { activeProjectRun, readProjectRun, listProjectRuns, listProjectChecks, listProjectSources, readProjectSource, listProjectActions, defineProjectChecks, recordProjectCheck, readProjectCheck, upsertProjectSource, beginProjectAction, finishProjectAction, reconcileProjectAction, saveProjectBrowserObservation } from './project-store.js';
import { zipProjectDelivery, projectCounts, projectCheckView } from './project-delivery.js';
import { startBrowserSession } from './browser-session.js';
import { executeProjectHttp } from './project-execution.js';
import { readDocumentSection } from './project-documents.js';
import { parseDocumentIsolated } from './project-document-parser.js';
import { recordProjectDocumentRead } from './project-progress.js';
import { taskStartInput, taskProgressInput } from './task-inputs.js';
import { chatDefaults, saveChatDefaults, promptDraft, promptTemplates } from './chat-setup.js';
import { listAccounts, saveAccount, removeAccount, ACCOUNT_STATUSES } from './accounts.js';
import { builtinTemplates, promptFields, searchTemplates, renderTemplate, missingRequired, importTemplates, validateTemplate } from './prompt-templates.js';
import { listUserTemplates, upsertUserTemplate, deleteUserTemplate, saveAsTemplate, readDraft, listDrafts, saveDraft } from './prompt-store.js';
import { materialsList, materialsDetail, searchMaterials, readMaterialExcerpt, removeMaterial } from './materials-view.js';
import { importPastedMaterial } from './materials-import.js';
import { listWorkDependingOnMaterial } from './work-lease.js';
import { executionLedger } from './execution-view.js';
import { readPentestSession } from './session-read.js';
import { knowledgeSwitchView, setKnowledgeEnabled } from './knowledge-switch.js';
import { testContentCatalog, TEST_CONTENT_KEYS } from './test-catalog.js';
import { taskModuleSelection, saveTaskModules } from './task-modules.js';
import { rootModuleSelection } from './execution-modules.js';
import { listKnowledgeUsage, recordKnowledgeUsage } from './knowledge-usage.js';
import { createPurposeTasks } from './purpose-tasks.js';
import { breakdownFromEvents, maskedRecord, diagnosticsDelta } from './request-diagnostics.js';
import { redactText, redactValue } from './redaction.js';
import { recordMaterialRead, recordMaterialView, materialReadKey } from './material-reads.js';
import { captureTaskCost, taskCostOverview } from './task-cost.js';
import { registerModelAdmission, recoverModelRuntime, modelBudgetOverview } from './model-budget.js';
import { createSiteWorkers, siteWorkerView, siteWorkerRows, siteWorkerParent, hostWorkerLimit } from './site-workers.js';
import { indexBusinessMaterials, businessMaterialView } from './business-materials.js';
import { runComparisonJob, readComparisonJob, comparisonFindingInput } from './comparison-jobs.js';
import { recordImpactReview } from './impact-reviews.js';
import { PROOF_KINDS, parseReproduction, renderReproduction, renderFindingDelivery } from './delivery.js';
import { registerTaskPrompt } from './task-prompt.js';
import { writeTaskPolicy, listTaskEvents, taskTransaction } from './task-policy-record.js';
import { defineTool } from "@deepseek-ai/dsh-tools";
import { sessionWorkingDirectory, ensureWorkingDirectory } from 'dsh-saker/working-directory';
import { saveChecks, readChecks, compactChecks, renderCheckedTsv } from './checked.js';
import { openStore, registerFinding, updateFinding, removeFinding, getFinding, allFindings, listFindings, listFindingsAll, groupByTarget, groupByTargetAll, computeStats, computeStatsAll, modeCounts, modeCountsAll, ledgerOverview, ledgerOverviewAll, getMeta, setMeta, SEVERITIES, STATUSES, REGISTER_STATUSES, MODE_STATUSES, ALL_STATUSES, EVIDENCE_LEVELS, SOURCE_ORIGINS, SECOND_RATINGS, secondReviewError, secondReviewVerdict, statusesOf } from "./store.js";

const name = "dsh-redteam-results";
// webServer/webRuntime 在 0.2.1 web profile 里可能由 host 平面后注册；
// 不把它们放进硬 inject，否则整个插件会因缺少一个可选路由服务而不激活。
const inject = { tools: { required: true }, agentPresets: { required: true }, systemPrompt: { required: true },
  sessions: { required: true }, agents: { required: true }, subagents: { required: true }, llm: { required: true },
  sessionQuery: { required: false } };

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
const purposeManagers = new WeakMap();
const modelAdmissions = new WeakMap();
const projectBrowsers = new Map();

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
		`复核「发现的问题」中的 #${finding.seq}：${finding.title}`,
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

// A purpose task owns a bounded child policy but reads the parent task's
// evidence snapshot. Only the parent recorded at admission is readable, and
// the parent round must still match, so a stale child cannot read a new round.
export function purposeReadSessionId(store, session) {
	const own = readTaskPolicy(store, session.id);
	if (own?.purposeTask !== true || !own.parentSession) return session.id;
	const parent = readTaskPolicy(store, String(own.parentSession));
	if (!parent) throw new Error('父任务不存在或已归档，不能读取复核资料');
	if (own.parentRound !== parent.startedAt) throw new Error('父任务轮次已变化，请重新派发复核或报告');
	return String(own.parentSession);
}
export function findingReadView(store, sessionId, args = {}) {
  const offset = args.id ? (args.read ?? args.offset ?? 0) : (args.offset ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('发现读取偏移必须是非负整数');
  if (!args.id) {
    if (args.read !== undefined) throw new Error('发现详情分段需要id');
    const rows = store.db.prepare("SELECT id,substr(title,1,60) AS title,status,severity,substr(target,1,80) AS target FROM findings WHERE session_id=? AND mode='pentest' ORDER BY seq DESC LIMIT 10 OFFSET ?").all(sessionId, offset);
    const total = store.db.prepare("SELECT count(*) AS n FROM findings WHERE session_id=? AND mode='pentest'").get(sessionId).n;
    const index = { rows, total, nextOffset: offset + rows.length < total ? offset + rows.length : null };
    return { ...index, text: JSON.stringify(index) };
  }
  const finding = getFinding(store, sessionId, args.id);
  if (!finding || finding.mode !== 'pentest') throw new Error('发现不存在于当前可读任务');
  const content = Buffer.from(JSON.stringify(finding, null, 2));
  if (offset > content.length) throw new Error('发现读取偏移超过正文');
  let end = Math.min(content.length, offset + 6000), text;
  for (let trim = 0; trim < 4; trim++) {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(content.subarray(offset, end)); break; }
    catch { end--; }
  }
  if (text === undefined) throw new Error('读取偏移落在字符中间，请使用上次返回的nextOffset');
  const nextOffset = end < content.length ? end : null;
  return { id: args.id, offset, nextOffset, totalBytes: content.length,
    text: `发现 ${args.id}；正文UTF-8字节 ${offset}–${end}/${content.length}；nextOffset=${nextOffset}\n` + text };
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

/**
 * 错误里的「可恢复操作」（v6 第 9.3 节）：返回错误时同时告诉调用方下一步能做什么，
 * 而不是只丢一句报错。code 缺失时给通用提示，并建议把 requestId 一并反馈。
 */
function recoverableHint(code) {
  const value = String(code || '');
  if (/-conflict$/.test(value) || value === 'work-lease-held') return '现状和你手上的版本对不上：刷新后重试，本地未提交的内容仍保留。';
  if (/csrf/.test(value)) return '令牌可能已过期：关闭并重新打开面板后再试。';
  if (/untrusted-host/.test(value)) return '只允许本机同源页面调用：重新打开 Saker 面板后再试。';
  if (/method-not-allowed/.test(value)) return '这是客户端内部接口；重新打开面板会重新发起正确的请求。';
  if (/not-found|missing/.test(value)) return '检查端点和参数名；可用端点见插件 README。';
  return '按提示修正后重试；若持续失败，把 requestId 一并反馈。';
}

/**
 * v6 第 9.3 节统一返回契约：保留旧顶层字段（旧客户端继续可用），
 * 同时补 data / revision / requestId。没有版本号的端点返回 revision: null，
 * 不拿别的修订号冒充。
 */
export function contractEnvelope(body, requestId) {
  const id = requestId === undefined ? 'rtr-' + crypto.randomUUID() : String(requestId);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: String(body ?? ''), revision: null, requestId: id };
  }
  const { ok: okValue, data: explicitData, revision: explicitRevision, requestId: _requestId, ...legacy } = body;
  const ok = okValue !== false;
  const revision = explicitRevision === undefined ? null : explicitRevision;
  if (!ok) return { ...legacy, ok: false, revision, requestId: id };
  return { ...legacy, ok: true, data: explicitData === undefined ? legacy : explicitData, revision, requestId: id };
}

/**
 * 本次模型输入分项（v6 第 6.3 节）：读当前会话最近一次装配的事件，拆成六类字节数，
 * 并把**已遮蔽**的原始记录写进私有目录（<home>/saker-diagnostics/），不随公开内容发布。
 */
function requestDiagnosticsView(session, sessionId) {
  // 先只取当前 surface（本次仍可见的消息）；request/header 不是 surface 事件，
  // 单独从完整日志里取最近一条工具定义。不能把完整日志的所有旧消息都累加成本次输入。
  let events = [];
  if (session?.surface && typeof session.eventAt === 'function') {
    for (const seq of session.surface.nodes || []) {
      try { events.push(session.eventAt(seq)); } catch { /* 坏节点隔离，不拖垮整页 */ }
    }
  }
  let toolEvent = null;
  if (typeof session?.snapshotEvents === 'function') {
    try {
      const all = [...session.snapshotEvents()];
      for (let i = all.length - 1; i >= 0; i--) if (all[i]?.type === 'request/header') { toolEvent = all[i]; break; }
      if (!events.length) events = all; // surface 不可用时才退回完整日志，并保留这一限制。
    } catch { /* 读取失败不编造 */ }
  }
  if (toolEvent && !events.includes(toolEvent)) events.push(toolEvent);
  const breakdown = breakdownFromEvents(events);
  let rawPath = '';
  let previous = null, history = [];
  try {
    const dir = path.join(DSH_HOME, 'saker-diagnostics');
    fs.mkdirSync(dir, { recursive: true });
    rawPath = path.join(dir, String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_') + '.json');
    // 上下文增长（v6 第 10.5 节）：读上一次记录做逐项差，再把本次追加进最多 20 条的历史。
    try {
      const existing = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
      if (existing && existing.breakdown) previous = existing.breakdown;
      else if (existing && Array.isArray(existing.history) && existing.history.length) previous = existing.history[existing.history.length - 1].breakdown;
      if (existing && Array.isArray(existing.history)) history = existing.history.slice(-19);
    } catch { /* 首次诊断或旧文件损坏：没有上一次基线，不编造 */ }
    const at = new Date().toISOString();
    history.push({ at, breakdown });
    fs.writeFileSync(rawPath, JSON.stringify({ sessionId, at, breakdown, history, events: maskedRecord(events) }, null, 1), 'utf8');
  } catch { rawPath = ''; }
  return { ...breakdown, previous, delta: diagnosticsDelta(previous, breakdown), rawPath,
    note: '按实际装配的事件分项计量；单位是 UTF-8 字节（当前没有可用的 token 计量器，不冒充精确 token）。'
      + '敏感字段已遮蔽，原始记录在私有目录。' };
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
  if (['chat.settings', 'chat.defaults', 'chat.draft', 'chat.templates', 'chat.models'].includes(endpoint)) {
    const sessionId = String(p.sessionId || '');
    const session = (ctx.sessions || ctx.get?.('sessions'))?.get(sessionId);
    if (!session || session.header?.agentPreset !== 'pentest') throw Error('请选择当前可用的渗透会话');
    if (endpoint === 'chat.draft') return { ok: true, draft: promptDraft(st, sessionId, p.mode, p.draft) };
    if (endpoint === 'chat.templates') return { ok: true, templates: promptTemplates(st, p.template) };
    if (endpoint === 'chat.defaults') return { ok: true, defaults: saveChatDefaults(st, p) };
    // v6 5.5「给助手选择模型」：可选模型来自宿主自己的授权偏好，不在这里另造一份。
    if (endpoint === 'chat.models') {
      let enabled = false, models = [];
      try {
        const selection = (ctx.get?.('subagentModelSelection') ?? ctx.subagentModelSelection)?.current?.();
        if (selection?.enabled && Array.isArray(selection.allowedModels)) {
          enabled = true;
          models = selection.allowedModels
            .filter(row => row && typeof row.provider === 'string' && typeof row.model === 'string' && row.provider && row.model)
            .map(row => ({ provider: row.provider, model: row.model }));
        }
      } catch { enabled = false; models = []; }
      return { ok: true, enabled, models };
    }
    const state = taskPolicyStatus(st, sessionId), workers = siteWorkerView(st, sessionId);
    return { ok: true, ...state, active: workers.active, hostWorkerLimit: hostWorkerLimit(ctx), defaults: chatDefaults(st),
      attention: taskAttention(st, sessionId),
      currentAction: taskCurrentAction(st, sessionId),
      // 「暂停中」：已请求停止但代理还在收尾（v6 第 8.2 节）；收尾结束才是「已暂停」。
      phase: state.phase === 'paused' && (ctx.agents || ctx.get?.('agents'))?.get(sessionId)?.status === 'running' ? 'pausing' : state.phase,
      agentRunning: (ctx.agents || ctx.get?.('agents'))?.get(sessionId)?.status === 'running' };
  }
  // v6 5.5「登录账号（可选）」：列表只给名称与状态，秘密单独保存、永不随列表返回。
  if (['account.list', 'account.save', 'account.remove'].includes(endpoint)) {
    const sessionId = String(p.sessionId || '');
    const session = (ctx.sessions || ctx.get?.('sessions'))?.get(sessionId);
    if (!session || session.header?.agentPreset !== 'pentest') throw Error('请选择当前可用的渗透会话');
    if (endpoint === 'account.list') return { ok: true, accounts: listAccounts(st, sessionId), statuses: ACCOUNT_STATUSES };
    if (endpoint === 'account.save') return { ok: true, account: saveAccount(st, sessionId, p), accounts: listAccounts(st, sessionId) };
    return { ok: true, accounts: removeAccount(st, sessionId, p.id) };
  }
  if (['prompt.library', 'prompt.draft', 'prompt.render'].includes(endpoint)) {
    const sessionId = String(p.sessionId || '');
    if (endpoint !== 'prompt.render' && !sessionId) throw new Error('sessionId required');
    const action = p.action || 'list';
    if (endpoint === 'prompt.library') {
      const user = listUserTemplates(st, { offset: p.offset, limit: p.limit });
      if (action === 'list') return { ok: true, builtin: builtinTemplates(), fields: promptFields(), user };
      if (action === 'search') {
        const all = [...builtinTemplates(), ...user.templates];
        return { ok: true, query: String(p.query ?? ''), results: searchTemplates(p.query, all) };
      }
      if (action === 'upsert') return { ok: true, template: upsertUserTemplate(st, p.template) };
      if (action === 'delete') return { ok: true, ...deleteUserTemplate(st, p.id, p.expectedRevision) };
      if (action === 'save-as') return { ok: true, template: saveAsTemplate(st, validateTemplate(p.template), p.newId) };
      if (action === 'import') return { ok: true, ...importTemplates(p.document, new Set(user.templates.map(t => t.id))) };
      if (action === 'export') return { ok: true, document: { schemaVersion: 1, templates: user.templates.filter(t => !t.builtin) } };
      throw new Error('未知 prompt.library 动作：' + action);
    }
    if (endpoint === 'prompt.render') {
      const template = builtinTemplates().find(t => t.id === p.templateId) || listUserTemplates(st, { offset: 0, limit: 200 }).templates.find(t => t.id === p.templateId);
      if (!template) throw new Error('模板不存在：' + (p.templateId ?? ''));
      const values = p.values && typeof p.values === 'object' ? p.values : {};
      return { ok: true, ...renderTemplate(template, values), missing: missingRequired(template, values) };
    }
    // prompt.draft
    if (action === 'read') return { ok: true, draft: readDraft(st, sessionId, String(p.templateId ?? '')) };
    if (action === 'list') return { ok: true, drafts: listDrafts(st, sessionId) };
    if (action === 'save') return { ok: true, draft: saveDraft(st, sessionId, { ...p, templateId: p.templateId }) };
    throw new Error('未知 prompt.draft 动作：' + action);
  }
  if (endpoint === 'materials.list') {
    const sessionId = String(p.sessionId || '');
    const session = await readPentestSession(ctx, sessionId);
    // 带上会话工作区：资料列表要把工作区资产账本里"已收集"的资产也列出来（第 7.2 节）。
    const workspace = sessionWorkingDirectory(ctx, session, '');
    return { ok: true, ...materialsList(st, sessionId, { ...p, workspace }) };
  }
  if (endpoint === 'materials.detail') {
    const sessionId = String(p.sessionId || '');
    await readPentestSession(ctx, sessionId);
    return { ok: true, detail: materialsDetail(st, sessionId, { kind: String(p.kind || ''), id: String(p.id || ''),
      offset: Number.isInteger(p.offset) ? p.offset : undefined, limit: Number.isInteger(p.limit) ? p.limit : undefined }) };
  }
  if (endpoint === 'materials.import') {
    const sessionId = String(p.sessionId || '');
    const session = (ctx.sessions || ctx.get?.('sessions'))?.get(sessionId);
    if (!session || session.header?.agentPreset !== 'pentest') throw Error('请选择当前可用的渗透会话');
    const material = importPastedMaterial(st, sessionId, { name: p.name, text: p.text });
    // 资料更新后按 ID 唤醒依赖它的工作（v6 第 8.3 节）：只叫声明过这条资料的工作，不广播。
// 完全相同原文只是「合并来源」（第 5.4 节），不是新版本 —— 不能假称「有新版本」去唤醒工作。
const woken = material.reused ? [] : wakeWorkersForMaterial(ctx, st, sessionId, 'file:' + material.id);
    return { ok: true, material, woken };
  }
  if (endpoint === 'materials.remove') {
    const sessionId = String(p.sessionId || '');
    const session = (ctx.sessions || ctx.get?.('sessions'))?.get(sessionId);
    if (!session || session.header?.agentPreset !== 'pentest') throw Error('请选择当前可用的渗透会话');
    return { ok: true, ...removeMaterial(st, sessionId, { id: p.id }) };
  }
  if (endpoint === 'materials.viewed') {
    const sessionId = String(p.sessionId || '');
    await readPentestSession(ctx, sessionId);
    // 本地查看是普通数据动作：只记本地状态，不创建模型回合、不增加模型输入（v6 第 5.4.1 节）。
    // 与 materials.detail 分开，读取详情保持纯读。
    const kind = String(p.kind || ''), id = String(p.id || '');
    if (!kind || !id) throw Error('记录本地查看需要材料类型与 id');
    return { ok: true, view: recordMaterialView(st, sessionId, { materialId: materialReadKey(kind, id) }) };
  }
  if (endpoint === 'execution.list') {
    const sessionId = String(p.sessionId || '');
    await readPentestSession(ctx, sessionId);
    return { ok: true, ...executionLedger(st, sessionId, p) };
  }
  if (endpoint === 'usage.get') {
    const sessionId = String(p.sessionId || '');
    await readPentestSession(ctx, sessionId);
    const overview = taskOverview(st, sessionId), cost = taskCostOverview(ctx, st, sessionId);
    const policy = overview.policy;
    return { ok: true, configured: overview.configured, elapsedSeconds: policy
        ? Math.max(0, Math.floor((Math.min(Date.now(), policy.finishedAt ?? Infinity, policy.budget.deadline ?? Infinity) - policy.startedAt) / 1000)) : 0,
      operations: policy ? { used: policy.used.toolCalls, budget: policy.budget.toolCalls } : null,
      unmetered: policy ? { used: policy.used.unmeteredToolCalls ?? 0, budget: policy.budget.unmeteredToolCalls ?? 0 } : null,
      // 网站回执数：宿主真正落库的目标执行回执。工具调用数不等于目标请求数——
      // 用宿主 shell 发的请求不会进这里，这一列让"请求发生了但没证据"看得见（第 8.2 节分列计量）。
      receipts: { total: Number(st.db.prepare('SELECT COUNT(*) AS n FROM execution_receipts WHERE session_id=?').get(sessionId)?.n ?? 0) },
      // 本地/规划类工具调用（status/context/research/读写/检索）：不占目标预算，但要如实显示。
      localTools: { used: policy?.used?.localToolCalls ?? 0 },
      modelBudget: modelBudgetOverview(st, sessionId),
      refused: modelBudgetOverview(st, sessionId)?.blocked ?? null,
      cost: { modelCalls: cost.modelCalls, attemptCalls: cost.attemptCalls, auxiliaryCalls: cost.auxiliaryCalls,
        toolCalls: cost.toolCalls, unknownUsageCalls: cost.unknownUsageCalls,
        totalTokens: cost.totalTokens, inputTokens: cost.inputTokens, outputTokens: cost.outputTokens, cacheReadTokens: cost.cacheReadTokens,
        elapsedModelMs: cost.elapsedModelMs, unavailableSessions: cost.unavailableSessions,
        sessions: cost.sessions.map(row => ({ sessionId: row.sessionId, role: row.role, available: row.available, modelCalls: row.modelCalls,
          toolCalls: row.toolCalls, unknownUsageCalls: row.unknownUsageCalls, totalTokens: row.totalTokens })) } };
  }
  if (endpoint === 'knowledge.status' || endpoint === 'knowledge.toggle') {
    const sessionId = String(p.sessionId || '');
    const session = endpoint === 'knowledge.status' ? await readPentestSession(ctx, sessionId)
      : (ctx.sessions || ctx.get?.('sessions'))?.get(sessionId);
    if (!session || session.header?.agentPreset !== 'pentest') throw Error('请选择当前可用的渗透会话');
    // 能力标志随开关视图一起给（v6 第 5.6 节）：缺自动匹配时浮层要如实说明。
    if (endpoint === 'knowledge.status') return { ok: true, knowledge: { ...knowledgeSwitchView(st, sessionId), autoMatch: knowledgeAutoMatchAvailable() } };
    return { ok: true, knowledge: setKnowledgeEnabled(st, sessionId, p.enabled, 'desktop-user') };
  }
  if (endpoint === 'knowledge.usage') {
    const sessionId = String(p.sessionId || '');
    await readPentestSession(ctx, sessionId);
    // 能力探测结果随用量一起返回（v6 第 5.6 节）：缺自动匹配时界面要如实说明。
    return { ok: true, knowledgeAutoMatch: knowledgeAutoMatchAvailable(),
      ...listKnowledgeUsage(st, sessionId, { page: Number.isInteger(p.page) ? p.page : 1, pageSize: Number.isInteger(p.pageSize) ? p.pageSize : 50 }) };
  }
  if (endpoint === 'diagnostics.request') {
    const sessionId = String(p.sessionId || '');
    const session = (ctx.sessions || ctx.get?.('sessions'))?.get(sessionId);
    if (!session || session.header?.agentPreset !== 'pentest') throw Error('请选择当前可用的渗透会话');
    return { ok: true, ...requestDiagnosticsView(session, sessionId) };
  }
  if (endpoint === 'task.events') {
    const sessionId = String(p.sessionId || '');
    await readPentestSession(ctx, sessionId);
    return { ok: true, ...listTaskEvents(st, sessionId, { afterCursor: Number.isInteger(p.afterCursor) ? p.afterCursor : 0, limit: Number.isInteger(p.limit) ? p.limit : 50 }) };
  }
  if (endpoint === 'test.content') {
    const sessionId = String(p.sessionId || '');
    const session = (ctx.sessions || ctx.get?.('sessions'))?.get(sessionId);
    if (!session || session.header?.agentPreset !== 'pentest') throw Error('请选择当前可用的渗透会话');
    const { selection, config } = rootModuleSelection(st, sessionId);
    if (p.action === 'save') {
      const next = saveTaskModules(st, sessionId, { mode: p.mode ?? selection.mode, active: p.active,
        rev: p.rev ?? selection.rev, policyRev: p.policyRev ?? selection.policyRev }, config);
      // 第 4.3 节：全不选必须同时关闭本任务的网站访问；再次选择项目不暗中恢复，由用户明确打开。
      if (Array.isArray(next.active) && next.active.length === 0)
        setTaskActionLimits(st, sessionId, { allowTargetNetwork: false }, 'test-content-empty');
			// 返回**写完之后**的选择：全不选会顺带写一次动作限制（policyRev +1），返回旧对象会让界面
			// 拿着过期 revision 再点「全选」时被乐观并发挡下。真机实测报「任务状态已变化，请刷新后重试」，
			// 而且不重开设置面板就一直失败。
			return { ok: true, selection: rootModuleSelection(st, sessionId).selection, catalog: testContentCatalog() };
    }
    return { ok: true, selection, catalog: testContentCatalog(), keys: TEST_CONTENT_KEYS };
  }
  if (['task.status', 'task.choose', 'task.start', 'task.cancel', 'task.resume', 'task.cleanup', 'task.new-round', 'task.interaction', 'task.workers', 'task.explain', 'task.limits', 'task.continue'].includes(endpoint)) {
    const sessionId = String(p.sessionId || '');
    if (!sessionId) throw new Error('sessionId required');
    let sessions;
    try { sessions = ctx.sessions || ctx.get?.('sessions'); } catch { /* unavailable */ }
    const session = sessions?.get(sessionId);
    if (endpoint !== 'task.status') {
      if (!session || session.header?.agentPreset !== 'pentest') throw new Error('请选择当前可用的渗透会话');
      if (typeof ctx.tools?.guard !== 'function') throw new Error('桌面宿主缺少任务预算守卫');
      if (endpoint === 'task.choose') {
        const hostLimit = hostWorkerLimit(ctx);
        if (p.workers !== undefined && Number(p.workers) > hostLimit) throw new Error(`worker limit exceeds host maxActiveSubagents (${hostLimit}); allowed 0 and ${hostLimit}`);
        chooseTaskMode(st, sessionId, p.mode, { workflow: p.workflow, workers: p.workers, interaction: p.interaction, reporting: p.reporting, startMode: p.startMode, explain: p.explain,
          workerModel: p.workerModel, reviewModel: p.reviewModel, reportModel: p.reportModel,
          allowTargetNetwork: p.allowTargetNetwork, readOnly: p.readOnly, excludedPaths: p.excludedPaths, requestRatePerMinute: p.requestRatePerMinute, requestConcurrency: p.requestConcurrency });
      }
      else if (endpoint === 'task.interaction') setTaskInteraction(st, sessionId, p.interaction, 'desktop-user', p.reporting);
      else if (endpoint === 'task.workers') {
        const hostLimit = hostWorkerLimit(ctx);
        if (Number(p.workers) > hostLimit) throw new Error(`worker limit exceeds host maxActiveSubagents (${hostLimit}); allowed 0 and ${hostLimit}`);
        setTaskWorkers(st, sessionId, p.workers, 'desktop-user');
      }
      else if (endpoint === 'task.explain') setTaskExplain(st, sessionId, p.explain, 'desktop-user');
      else if (endpoint === 'task.limits') setTaskActionLimits(st, sessionId,
        { allowTargetNetwork: p.allowTargetNetwork, readOnly: p.readOnly, excludedPaths: p.excludedPaths,
          requestRatePerMinute: p.requestRatePerMinute, requestConcurrency: p.requestConcurrency }, 'desktop-user');
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
          writeTaskPolicy(st, sessionId, { ...policy, awaitingConfirmation: before.awaitingConfirmation }, 'confirmation-delivery-failed');
          throw new Error('未能投递继续消息，仍等待确认：'+error.message);
        }
      }
      else if (endpoint === 'task.start') {
        if((p.policy?.budget?.modelCalls!==undefined || p.policy?.budget?.tokens!==undefined) && !modelAdmissions.get(ctx)?.available)
          throw new Error('宿主缺少模型请求准入钩子，不能执行共享模型额度');
        const agent = (ctx.agents || ctx.get?.('agents'))?.get(sessionId);
        if (typeof agent?.followup !== 'function') throw new Error('当前代理不可用，任务尚未开始；请打开该会话后重试');
        if (agent.status === 'running') throw new Error('当前模型仍在运行，请先停止或等待完成');
        const policyInput = { ...(p.policy || {}) };
        if (policyInput.budget && policyInput.budget.workers !== undefined && Number(policyInput.budget.workers) > hostWorkerLimit(ctx))
          throw new Error(`worker limit exceeds host maxActiveSubagents (${hostWorkerLimit(ctx)}); allowed 0 and ${hostWorkerLimit(ctx)}`);
        const policy = startTaskPolicy(st, sessionId, policyInput);
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
          const purposeManager = purposeManagers.get(ctx);
          if (!purposeManager) throw new Error('用途助手管理器尚未就绪，释放未确认');
          const retained = await purposeManager.cleanup(agent, p.childId);
          if (!p.childId || !readTaskPolicy(st, p.childId)?.purposeTask)
            await manager.cleanup(agent, p.childId, endpoint === 'task.cancel' ? 'desktop-user cancelled' : 'desktop-user cleanup');
          if (retained.length) throw new Error('部分助手释放未确认，名额已保留；请重试清理');
        }
      }
    }
    let workers = siteWorkerView(st, sessionId);
    const manager = workerManagers.get(ctx), agent = (ctx.agents || ctx.get?.('agents'))?.get(sessionId);
    if (manager && agent && workers.workers.length) workers = await manager.status(agent);
    const overview = taskOverview(st, sessionId), cost = taskCostOverview(ctx, st, sessionId);
    return { ok: true, isPentest: session?.header?.agentPreset === 'pentest', hostWorkerLimit: hostWorkerLimit(ctx), ...overview, ...workers, cost,
      attention: taskAttention(st, sessionId),
      // 「暂停中」：已请求停止但代理还在收尾（v6 第 8.2 节）。
      phase: overview.phase === 'paused' && agent?.status === 'running' ? 'pausing' : overview.phase,
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
		// 列表行带复测摘要（第 9.2 节）：三结论的最新一次 + 次数，不覆盖历史发现。
		// 同时带「复测中」标记（第 5.3 节）：复核消息已投递但还没有复测结论。
		const verifyCache = new Map();
		const verifyingFor = (sid) => { if (!verifyCache.has(sid)) verifyCache.set(sid, listVerifyStarted(st, sid)); return verifyCache.get(sid); };
		const attachRetests = (fallbackSessionId, list) => (list && Array.isArray(list.rows))
			? { ...list, rows: list.rows.map(row => { const sid = String(row.sessionId || fallbackSessionId || '');
				return { ...row, retest: retestSummary(st, sid, row.id), verifying: verifyingFor(sid).has(String(row.id)) }; }) }
			: list;
		if (p.scope === "all") {
			// 跨会话模式页：该模式全表 + created_at 范围过滤；counts=全时域侧栏计数；行带 sessionId；
			// meta 取请求会话（标签页所属会话）——模式页元数据栏不为空。
			const range = { from: String(p.from ?? ""), to: String(p.to ?? "") };
			const out = { list: attachRetests(String(p.sessionId ?? ''), listFindingsAll(st, mode, { ...p, ...range })), stats: computeStatsAll(st, mode, range), counts: modeCountsAll(st), meta: p.sessionId ? getMeta(st, String(p.sessionId)) : undefined };
			return out;
		}
		const sessionId = String(p.sessionId ?? "");
		if (!sessionId) throw new Error("sessionId required");
		return { list: attachRetests(sessionId, listFindings(st, sessionId, mode, p)), stats: computeStats(st, sessionId, mode), counts: modeCounts(st, sessionId), meta: getMeta(st, sessionId) };
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
  if (String(endpoint).startsWith('project.')) {
    const sessionId = String(p.sessionId || '');
    if (!sessionId) throw new Error('sessionId required');
    let sessions;
    try { sessions = ctx.sessions || ctx.get?.('sessions'); } catch { /* unavailable */ }
    const session = ['project.status', 'project.check-detail', 'project.export'].includes(endpoint)
      ? await readPentestSession(ctx, sessionId) : sessions?.get(sessionId);
    if (!session || session.header?.agentPreset !== 'pentest') throw new Error('请选择当前可用的渗透会话');
    const requestedRunId = String(p.runId || '');
    if (endpoint === 'project.status') {
      const run = requestedRunId ? readProjectRun(st, sessionId, requestedRunId)
        : activeProjectRun(st, sessionId) || listProjectRuns(st, sessionId, { limit: 1 })[0] || null;
      if (requestedRunId && !run) return { ok: false, error: '未找到该项目运行' };
      const checks = run ? listProjectChecks(st, sessionId, run.runId) : [];
      const sources = (run?.sourceSnapshot || []).map(snapshot => readProjectSource(st, sessionId, snapshot.sourceId, snapshot.sourceRevision))
        .filter(Boolean).map(source => ({
        sourceId: source.sourceId, sourceRevision: source.sourceRevision,
        displayName: source.displayName || '', kind: source.kind || 'text',
        parseState: source.parseState, sectionCount: (source.sections || []).length,
        unreadCount: (source.unread || []).length,
      }));
      return {
        ok: true, configured: !!run, run, checks: checks.map(projectCheckView), sources, counts: projectCounts(checks),
        runs: listProjectRuns(st, sessionId, { limit: 50 }).map(item => ({
          runId: item.runId, state: item.state, updatedAt: item.updatedAt, question: item.question || '',
        })),
      };
    }
    if (endpoint === 'project.import') {
      const existingPolicy = readTaskPolicy(st, sessionId);
      if (existingPolicy && existingPolicy.scenario !== 'project') throw new Error('当前会话已有安全测试任务，请新建会话后添加项目文档');
      if (activeProjectRun(st, sessionId)) throw new Error('本次运行已开始，来源快照已固定；请在下一轮重新添加文档');
      const imported = await importProjectSource(st, sessionId, p);
      return { ok: true, ...imported };
    }
    if (endpoint === 'project.start') {
      const existing = activeProjectRun(st, sessionId);
      if (existing) return { ok: true, existing: true, run: existing, counts: projectCounts(listProjectChecks(st, sessionId, existing.runId)) };
      const latestSources = new Map();
      for (const source of listProjectSources(st, sessionId)) if (!latestSources.has(source.sourceId)) latestSources.set(source.sourceId, source);
      const sourceSnapshot = [...latestSources.values()].map(source => ({
        sourceId: source.sourceId,
        sourceRevision: source.sourceRevision,
        displayName: source.displayName || '',
        snapshotRef: source.snapshotRef || '',
        snapshotMaterialId: source.snapshotMaterialId || '',
      }));
      const run = startProjectTask(st, sessionId, { ...p, sourceSnapshot });
      if (p.autoStart !== false) {
        const agent = (ctx.agents || ctx.get?.('agents'))?.get(sessionId);
        if (typeof agent?.followup !== 'function' || agent.status === 'running') {
          setProjectRunState(st, sessionId, run.runId, 'failed', run.controlRev, { blocker: { code: 'needs-user', reason: '当前代理不可用或仍在运行' } });
          throw new Error('当前代理不可用或仍在运行，任务尚未开始');
        }
        try {
          // 注入安全：由同源 Desktop RPC 触发，不在 Session.append 发布临界区内。
          await agent.followup({ id: `saker-project-${sessionId}-${run.runId}`, role: 'user', source: { kind: 'user' },
            content: [{ type: 'text', text: '请开始按文档测试：先读取本次添加的来源和用户说明；用 project_check define 同批提交 checks 的 sourceRefs 与 sectionDecisions（requirements/reference/unreadable），然后逐项执行。缺条件的项写清缺口并继续独立项。不要重复开始任务或重置预算。' }] });
        } catch (error) {
          setProjectRunState(st, sessionId, run.runId, 'failed', run.controlRev, { blocker: { code: 'needs-user', reason: '模型未能开始', evidence: String(error.message || error) } });
          throw new Error('模型未能开始，已停止本次运行：' + error.message);
        }
      }
      return { ok: true, existing: false, run, counts: projectCounts([]) };
    }
    const run = requestedRunId ? readProjectRun(st, sessionId, requestedRunId) : activeProjectRun(st, sessionId);
    if (!run) return { ok: false, error: '没有活动的项目运行' };
    if (endpoint === 'project.pause' || endpoint === 'project.stop') {
      const next = endpoint === 'project.pause'
        ? pauseProjectRun(st, sessionId, run.runId, { code: 'needs-user', reason: '用户暂停', at: new Date().toISOString() }, p.expectedControlRev)
        : setProjectRunState(st, sessionId, run.runId, 'cancelled', p.expectedControlRev ?? run.controlRev, { blocker: { code: 'cancelled', reason: '用户停止' } });
      const agent = (ctx.agents || ctx.get?.('agents'))?.get(sessionId);
      let controlError = null;
      if (agent?.status === 'running') {
        if (typeof agent.cancel !== 'function') controlError = new Error('已阻止新项目动作，但当前模型停止接口不可用，请核对在途状态');
        else agent.cancel({ kind: 'user' });
      }
      const browser = projectBrowsers.get(sessionId);
      if (browser) {
        try { await browser.close(); } finally { projectBrowsers.delete(sessionId); }
      }
      if (controlError) throw controlError;
      return { ok: true, run: next };
    }
    if (endpoint === 'project.resume') {
      const agent = (ctx.agents || ctx.get?.('agents'))?.get(sessionId);
      if (typeof agent?.followup !== 'function' || agent.status === 'running') throw new Error('模型仍在收尾或不可用，请稍后继续');
      const resumed = resumeProjectRun(st, sessionId, run.runId, p.expectedControlRev);
      try {
        // 注入安全：由同源 Desktop RPC 恢复空闲代理，不在 Session.append 临界区内。
        await agent.followup({ id: `saker-project-resume-${resumed.runId}-${resumed.controlRev}`, role: 'user', source: { kind: 'user' },
          content: [{ type: 'text', text: '继续当前文档测试。先核对影响当前项的环境和身份，读取已保存的要求、进度与缺口，继续未完成项；不重建运行、不重置额度、不重复已完成检查。' }] });
      } catch (error) {
        pauseProjectRun(st, sessionId, run.runId, { code: 'needs-user', reason: '模型未能恢复', evidence: String(error.message || error) });
        throw new Error('模型未能恢复，已保留暂停状态：' + error.message);
      }
      return { ok: true, run: resumed };
    }
    if (endpoint === 'project.check-detail') {
      const check = readProjectCheck(st, sessionId, run.runId, String(p.checkId || ''));
      if (!check) return { ok: false, error: '未找到该检查' };
      return { ok: true, run, check, actions: listProjectActions(st, sessionId, run.runId).filter(action => (check.actionRefs || []).includes(action.actionId)) };
    }
    if (endpoint === 'project.action-reconcile') {
      const action = reconcileProjectAction(st, sessionId, run.runId, String(p.actionId || ''), p);
      return { ok: true, action };
    }
    if (endpoint === 'project.define-checks') {
      const checks = defineProjectChecks(st, sessionId, run.runId, Array.isArray(p.checks) ? p.checks : []);
      return { ok: true, checks, counts: projectCounts(listProjectChecks(st, sessionId, run.runId)) };
    }
    if (endpoint === 'project.export') {
      const bundle = zipProjectDelivery(st, sessionId, run.runId);
      return { ok: true, filename: 'saker-project-' + run.runId + '.zip', archive: bundle.archive.toString('base64'), counts: bundle.counts };
    }
    return { ok: false, error: '未知的项目操作：' + endpoint };
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
	if (endpoint === 'finding.retest') {
		// 复测：新建版本记录，引用原发现与本次 execution；三结论（第 9.2 节）。不覆盖历史发现。
		const sessionId = String(p.sessionId ?? '');
		if (!sessionId) throw new Error('sessionId required');
		if (String(p.action ?? 'list') === 'record') return { ok: true, retest: recordRetest(st, sessionId, p) };
		return { ok: true, retests: listRetests(st, sessionId, String(p.id ?? ''), { limit: Number.isInteger(p.limit) ? p.limit : 20 }) };
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
		// 登记「复测中」（v6 第 5.3 节）：详情据此显示状态和运行记录入口；
		// 写入复测结论或人工标记后由 clearVerifyStarted 清掉。
		markVerifyStarted(st, sessionId, finding.id);
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
		// 人工标记已经有结论，不再显示「复测中」（v6 第 5.3 节）。
		clearVerifyStarted(st, sessionId, id);
		return { ok: true, id: updated.id, status: updated.status, verifyNote: updated.verifyNote, secondRating: updated.secondRating, verdict: secondReviewVerdict(updated) };
	}
	throw new Error(`unknown endpoint ${endpoint}`);
}

//#endregion

//#region host wiring

/**
 * 知识适配器能力探测（v6 第 5.6 节）：自动匹配从 knowledge-hub 0.3.23 起提供。
 * 缺能力时界面要如实显示「本版本由 AI 主动查询」，不能默认自动匹配存在。结果按进程缓存。
 */
let knowledgeAutoMatchCache = null;
function knowledgeAutoMatchAvailable() {
  if (knowledgeAutoMatchCache !== null) return knowledgeAutoMatchCache;
  knowledgeAutoMatchCache = (() => {
    try {
      const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
      const pkgPath = path.join(home, 'profiles', 'desktop', 'node_modules', '@dsh-external', 'dsh-knowledge-hub', 'package.json');
      const version = String(JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || '');
      const parts = version.split('.').map(Number);
      if (parts.length < 3 || !parts.slice(0, 3).every(Number.isInteger)) return false;
      const [major, minor, patch] = parts;
      return major > 0 || minor > 3 || (minor === 3 && patch >= 23);
    } catch { return false; }
  })();
  return knowledgeAutoMatchCache;
}

/** 「需要你处理」的单条事项（v6 第 5.2 节）：目前只有账号失效一类，不替用户猜原因。 */
function taskAttention(store, sessionId) {
  return listAccounts(store, sessionId)
    .filter((account) => account.status === 'expired')
    .map((account) => ({ kind: 'account-expired', accountId: account.id, accountName: account.name,
      message: account.name + ' 已失效，相关验证暂停' }));
}

/**
 * 标题栏的「当前动作」（v6 第 5.1 节）：取最近一条真实执行回执，不额外调用模型生成口号。
 * 没有回执时返回空串，界面就不显示，避免堆零指标。
 */
function taskCurrentAction(store, sessionId) {
  try {
    const row = store.db.prepare('SELECT record FROM execution_receipts WHERE session_id=? ORDER BY rowid DESC LIMIT 1').get(sessionId);
    if (!row) return '';
    const record = JSON.parse(row.record || '{}');
    const endpoint = String(record.endpoint || '').trim();
    if (!endpoint) return '';
    return '最近动作：' + endpoint;
  } catch { return ''; }
}

/**
 * 资料更新后唤醒依赖它的工作（v6 第 8.3 节）：只给声明过该 materialId 的子代理投递一条具体说明，
 * 不广播给无关工作；投递失败的工作保持原状，不伪造唤醒。
 */
function wakeWorkersForMaterial(ctx, store, sessionId, materialId) {
  const dependent = listWorkDependingOnMaterial(store, sessionId, materialId);
  if (!dependent.length) return [];
  let agents; try { agents = ctx.agents || ctx.get?.('agents'); } catch { agents = null; }
  const woken = [];
  for (const work of dependent) {
    if (work.state !== 'claimed') continue;
    const child = agents?.get?.(work.worker);
    if (!child || typeof child.followup !== 'function') continue;
    try {
      // 注入安全：资料更新由同源 RPC 处理，不在 Session.append 发布临界区内。
      child.followup({ id: 'saker-material-wake-' + work.workKey + '-' + Date.now(), role: 'user',
        content: [{ type: 'text', text: '[Saker 资料更新] 你依赖的资料 ' + materialId + ' 有新版本；请重新读取后再下结论，不要沿用旧版本。' }],
        source: { kind: 'user' } });
      woken.push({ workKey: work.workKey, worker: work.worker });
    } catch { /* 投递失败的工作保持原状，不假装已唤醒 */ }
  }
  return woken;
}

async function importProjectSource(store, sessionId, input = {}) {
  const displayName = String(input.name || input.displayName || '未命名文档').trim().slice(0, 300) || '未命名文档';
  const base64 = String(input.base64 || '').trim();
  const plainText = typeof input.text === 'string' ? input.text : '';
  if (base64 && !/^[A-Za-z0-9+/=\r\n]+$/.test(base64)) throw new Error('文档 base64 内容无效');
  const buffer = base64 ? Buffer.from(base64, 'base64') : Buffer.from(plainText, 'utf8');
  if (!buffer.length) throw new Error('文档内容为空');
  if (buffer.length > 20 * 1024 * 1024) throw new Error('单个项目文档不能超过 20MB');
  const digest = crypto.createHash('sha256').update(buffer).digest('hex');
  const snapshotMaterialId = 'project-source-' + digest;
  const parsed = await parseDocumentIsolated(buffer, { displayName });
  // Parsing yields to other RPCs. Recheck before saving a now-fixed run snapshot.
  if (activeProjectRun(store, sessionId)) throw new Error('文档读取期间任务已开始，请在下一轮重新添加文档');
  const currentPolicy = readTaskPolicy(store, sessionId);
  if (currentPolicy && currentPolicy.scenario !== 'project') throw new Error('当前会话已有安全测试任务，请新建会话后添加项目文档');
  const existingSources = listProjectSources(store, sessionId)
    .filter(source => source.displayName === displayName)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const sameContent = existingSources.find(source => source.snapshotRef === digest);
  const sourceId = sameContent?.sourceId || existingSources[0]?.sourceId
    || 'project-source-' + crypto.createHash('sha256').update(displayName).digest('hex').slice(0, 20);
  const sourceRevision = sameContent?.sourceRevision || 'r' + (existingSources.reduce((max, source) => {
    const match = /^r(\d+)$/.exec(String(source.sourceRevision || ''));
    return Math.max(max, match ? Number(match[1]) : 0);
  }, 0) + 1);
  return taskTransaction(store, () => {
    const source = upsertProjectSource(store, sessionId, {
      sourceId,
      sourceRevision,
      displayName,
      kind: parsed.kind || 'text',
      parseState: (parsed.unread || []).length ? 'partial' : (parsed.parseState || 'ready'),
      snapshotRef: digest,
      snapshotMaterialId,
      sections: parsed.sections || [],
      unread: parsed.unread || [],
    });
    const material = {
      id: snapshotMaterialId, kind: 'project-source', sourceId, sourceRevision,
      displayName, digest, bytes: buffer.length, originalBase64: buffer.toString('base64'),
      indexedAt: new Date().toISOString(),
    };
    store.db.prepare('INSERT INTO business_materials(session_id,id,source_url,digest,record) VALUES(?,?,?,?,?) '
      + 'ON CONFLICT(session_id,id) DO UPDATE SET record=excluded.record,digest=excluded.digest')
      .run(sessionId, snapshotMaterialId, 'https://project-source.invalid/' + digest, digest, JSON.stringify(material));
    return {
      source: {
        sourceId: source.sourceId, sourceRevision: source.sourceRevision,
        displayName: source.displayName, kind: source.kind, parseState: source.parseState,
        snapshotMaterialId,
      },
      sections: (source.sections || []).length,
      unread: (source.unread || []).length,
      parseState: source.parseState,
    };
  });
}

function apply(ctx) {
  const modelAdmission=registerModelAdmission(ctx,theStore,{countInput:options=>{
    let counter;try{counter=ctx.get?.('sakerInputCounter');}catch{ /* optional certified provider counter is unavailable */ }
    return counter?.countInput?.(options);
  }});
  modelAdmissions.set(ctx,modelAdmission);
  ctx.on?.('session/event', (session, event) => {
    if (session?.header?.agentPreset !== 'pentest' && !siteWorkerParent(theStore(), session?.id || '')
      && !readTaskPolicy(theStore(), session?.id || '')?.purposeTask) return;
    captureTaskCost(theStore(), session, event);
  });
  ctx.on?.('agent/turn-stopping', ({ agent, signal }) => {
    const session = sessionOf(ctx, { agent });
    if (!session || session.mode !== 'pentest' || signal?.aborted || typeof agent.steer !== 'function') return;
    const store = theStore();
    if (readTaskPolicy(store, session.id)?.scenario === 'project') {
      try {
        const decision = projectTurnDecision(store, session.id);
        if (decision.action === 'continue') {
          const continuation = decision.continuation;
          const current = readProjectRun(store, session.id, decision.run.runId);
          if (current?.state === decision.run.state && current.controlRev === decision.run.controlRev && !signal?.aborted
            && !taskPolicyStatus(store, session.id).stopped) {
            // 注入安全：turn-stopping 在 Session.append 临界区外派发；投递前重核本次控制版本。
            agent.steer(continuation.text);
            markProjectContinuation(store, session.id, decision.run.runId, continuation.fingerprint, continuation.attempts, continuation.controlRev);
          }
          return;
        }
        if (decision.action === 'waiting') {
          setProjectRunState(store, session.id, decision.run.runId, 'waiting', decision.run.controlRev, { blocker: decision.blocker });
          return;
        }
        if (decision.action === 'completed') {
          completeProjectRun(store, session.id, decision.run.runId);
          const browser = projectBrowsers.get(session.id);
          if (browser) void browser.close().finally(() => projectBrowsers.delete(session.id));
          return;
        }
        return;
      } catch (error) {
        const run = activeProjectRun(store, session.id);
        if (run && ['preparing', 'running'].includes(run.state))
          pauseProjectRun(store, session.id, run.runId, { code: 'needs-user', reason: '自动衔接未能继续', evidence: String(error.message || error) });
      }
      return;
    }
    const message = takeTaskContinuation(store, session.id);
    if (message) {
      // 注入安全：agent/turn-stopping 在回合停止检查中派发，不在 Session.append 发布临界区内；steer 使宿主继续当前回合。
      try { agent.steer(message); }
      catch (error) { pauseTaskPolicy(store, session.id, { code: 'needs-user', reason: '自动衔接未能继续', evidence: String(error.message || error) }, 'host-continuation-failure'); }
      return;
    }
    try { finishTaskOnTurnEnd(store, session.id); }
    catch (error) { pauseTaskPolicy(store, session.id, { code: 'needs-user', reason: '回合结束收口失败', evidence: String(error.message || error) }, 'host-turn-end-failure'); }
  });
  const siteWorkers = createSiteWorkers(ctx, theStore);
  workerManagers.set(ctx, siteWorkers);
  const purposeTasks = createPurposeTasks(ctx, theStore);
  purposeManagers.set(ctx, purposeTasks);
  // 受控工具面（效果基准或宿主限制）只暴露 exercise_request/exercise_submit 时，
  // 常驻提示必须跟着实际工具面走，不能继续引用被隐藏的 Saker 工具。
  const controlledInterface = agent => {
    try {
      const names = new Set((ctx.tools?.schemas?.(agent) || []).map(tool => tool.name));
      return names.has('exercise_request') && !names.has('redteam_context');
    } catch { return false; }
  };
  registerTaskPrompt(ctx, assembly => sessionOf(ctx, { agent: assembly?.agent })?.mode === 'pentest',
    assembly => {
      const session = sessionOf(ctx, { agent: assembly?.agent });
      if (!session || session.mode !== 'pentest') return '';
      try {
        const store = theStore();
        // v6 第 4.3 节：把当前测试内容选择一起交给提示，筛过才发一行已选重点。
        const state = taskPolicyStatus(store, session.id);
        const selection = state.policy?.scenario === 'project' ? null : rootModuleSelection(store, session.id).selection;
        return taskPromptStable(state, { controlledInterface: controlledInterface(assembly?.agent), selection });
      }
      catch { return '本会话任务状态无法读取，停止目标操作并报告原因；不要重建或重置历史。'; }
    });
  const enforcementAvailable = typeof ctx.tools.guard === 'function';
  if (enforcementAvailable) ctx.tools.guard(exec => {
    const session = sessionOf(ctx, exec);
    if (!session || session.mode !== 'pentest') return undefined;
    try { return taskExecutionGuard(theStore(), session.id, exec.name, Date.now(), { args: exec.arguments }); }
    catch (error) { return '任务策略无法读取，停止目标操作：' + error.message; }
  });
	// 插件卸载时释放库句柄。句柄悬着会锁住 -wal/-shm —— Windows 上表现为这个库文件
	// 既删不掉也改不了名（备份/迁移/损坏自愈都要 rename 它）。
	// 对照 campaign-memory：它一直有这条 ctx.effect，其余插件此前都缺，
	// 插件重载/HMR 会因此留下永不回收的句柄（实测同进程二次 openStore 会 EBUSY）。
  async function disposeTaskRuntime() {
    await purposeTasks.dispose();
    await siteWorkers.dispose();
    workerManagers.delete(ctx);
    purposeManagers.delete(ctx);
    await modelAdmission.dispose();
    modelAdmissions.delete(ctx);
    if (store) recoverModelRuntime(store, modelAdmission.runtimeId);
  }
	ctx.effect(() => async () => { await disposeTaskRuntime(); try { store?.close?.(); } catch { /* 已关或句柄失效 */ } store = undefined; }, "dsh-redteam-results: store handle");
	//#region 模型工具（宿主平面，三种安全模式可见）
	ctx.tools.register(defineTool({
		name: "redteam_finding_register",
		description: "登记本会话成果。弱配置须有真实影响和利用链；独立复核后才能交付。子代理成果存子会话。",
		parameters: {
			title: { type: "string", required: true, description: "名称（简短）" },
			severity: { type: "string", enum: SEVERITIES, description: "等级；漏洞型必填，默认 medium" },
			target: { type: "string", required: true, description: "地址/目标/位置" },
			summary: { type: "string", required: true, description: "一句话简介" },
			type: { type: "string", description: "类型标签；词表见 finding-fields.md" },
			description: { type: "string", description: "描述（影响与成因）" },
			poc: { type: "string", description: "测试过程与完整EXP；复杂场景保存复现脚本" },
			proofKind: { type: "string", enum: PROOF_KINDS, description: "证据类型；interaction 不代表 execution" },
			reproduction: { type: "string", description: "旧完整方法JSON；已有对照优先用comparisonId" },
			evidenceRefs: { type: "string", description: 'JSON：[{kind:"request"|"file",id}]，引用原文' },
      comparisonId: { type: 'string', description: 'run-pair的id（pair-…）：自动填回执和方法，保留待复核读取线索' },
			chain: { type: "string", description: "调用链 entry→sink（审计双链之一，每行一链）" },
			chainTracer: { type: "string", description: "追踪员独立重追链（双链另一侧）" },
			chainVerdict: { type: "string", description: "双链结论：一致 / 不一致+差异" },
			snippetEntry: { type: "string", description: "entry 关键代码片段" },
			snippetSink: { type: "string", description: "sink 关键代码片段" },
			cwe: { type: "string", description: "CWE 编号" },
			patch: { type: "string", description: "修复 diff 建议（可选）" },
			sourceOrigin: { type: "string", enum: SOURCE_ORIGINS, description: "来源；语义见 finding-fields.md" },
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
			status: { type: "string", enum: REGISTER_STATUSES, description: "默认pending；verified需二次复核；fixed仅redteam。" },
			evidenceLevel: { type: "string", enum: EVIDENCE_LEVELS, description: "证据等级；语义见 finding-fields.md" },
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
		description: "按 id 更新 finding：状态、字段、复核/复测注记；首次转 verified 须给 secondRating 与 ≥40 字依据。",
		parameters: {
			id: { type: "string", required: true, description: "finding id（如 pentest-3）" },
			status: { type: "string", enum: ALL_STATUSES, description: "新状态；按当前模式终态规则，详见 finding-fields.md" },
			verifyNote: { type: "string", description: "复核注记（结论+依据，简短）" },
			evidenceRefs: { type: "string", description: 'JSON：[{kind:"request"|"file",id}]，引用原文' },
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
			retestNote: { type: "string", description: "复测注记（结论+依据）" },
			retestVerdict: { type: "string", enum: RETEST_VERDICTS, description: "结构化复测结论；给了它就同时留一条复测记录" },
			retestExecutionId: { type: "string", description: "本次复测的执行回执 ID" },
			retestControlExecutionId: { type: "string", description: "「本次未复现」必填：正常功能对照回执 ID" },
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
			const store = theStore();
			if (args.severity !== undefined) {
				const current = getFinding(store, session.id, args.id);
				const policyError = findingAdmissionError(session.mode, { ...(current || {}), ...args });
				if (policyError) return Promise.resolve({ ok: false, error: policyError });
			}
			let finding, retest;
			store.db.exec('BEGIN IMMEDIATE');
			try {
				if (args.retestVerdict !== undefined) {
					retest = recordRetest(store, session.id, { findingId: args.id, verdict: args.retestVerdict,
						note: args.retestNote || args.verifyNote || '', executionId: args.retestExecutionId,
						controlExecutionId: args.retestControlExecutionId });
				}
				finding = updateFinding(store, session.id, session.mode, args.id, args);
				if (finding === undefined) {
					store.db.exec('ROLLBACK');
					return Promise.resolve({ ok: false, error: "finding " + args.id + " 不存在（本会话 " + session.mode + " 页）" });
				}
				store.db.exec('COMMIT');
			} catch (error) {
				try { store.db.exec('ROLLBACK'); } catch { /* 事务可能已因错误结束 */ }
				return Promise.resolve({ ok: false, id: args.id,
					error: '本次更新与复测均未生效：' + error.message + '（可补齐依据后重试，或改走 finding.retest）' });
			}
			return Promise.resolve({ ok: true, id: finding.id, status: finding.status, verifyNote: finding.verifyNote, secondRating: finding.secondRating, severity: finding.severity, verdict: secondReviewVerdict(finding),
				...(retest ? { retest: { verdict: retest.verdict, verdictLabel: retest.verdictLabel, id: retest.id } } : {}),
        ...(finding.delivery ? { delivery: { ready: finding.delivery.ready, executionVerified: finding.delivery.executionVerified, gaps: finding.delivery.gaps } } : {}) });
		}
	}));

	ctx.tools.register(defineTool({
		name: "redteam_finding_delete",
		description: "按 id 删除本会话成果页的一条 finding（直接删库行，统计同步更新）。",
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
    description: '精选方法包：读取固定版本；激活/回退须成果页审阅。',
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
    description: '执行已存请求。run-pair保存正常/异常对照；run-effect核对已审阅效果；回执不是漏洞，见README。',
    parameters: {
      action: { type: 'string', required: true, enum: ['run', 'detail', 'run-pair', 'pair-detail', 'run-effect', 'job-detail', 'verify-effect', 'effect-detail', 'oob-issue', 'oob-check', 'browser-run'] },
      document: { type: 'string', description: 'JSON：run-pair含hypothesisId与请求引用；run-effect含methodId/version；verify-effect含rounds' },
      label: { type: 'string', description: 'oob-check：issue 的 label' },
      host: { type: 'string', description: 'oob-check：载荷回调域名' },
      hypothesisId: { type: 'string', description: 'run：当前验证方向ID' },
      requestId: { type: 'string', description: 'run：redteam_context中已保存的请求ID' },
      requestRevision: { type: 'string', description: 'run：已保存请求版本' },
      purpose: { type: 'string', enum: ['baseline', 'first-contact'], description: 'baseline复查；first-contact取基线/同级GET（5次）' },
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
        const readId = purposeReadSessionId(store, session);
        if (args.action === 'run') return { ok: true, ...await executeRecordedRequest(store, session.id, { ...args, callId: exec.callId }, undefined, exec.signal) };
        if (args.action === 'run-pair') return { ok: true, ...await runComparisonJob(store, session.id, { ...JSON.parse(args.document), callId: exec.callId }, exec.signal) };
        if (args.action === 'pair-detail') return { ok: true, ...readComparisonJob(store, readId, args.id) };
        if (args.action === 'detail') {
          // 按 ID 前缀读宿主回执：execution-* 是 HTTP 回执，interaction-* 是回连记录，browser-* 是浏览器执行。
          const id = String(args.id || '');
          if (id.startsWith('interaction-')) return { ok: true, ...redactValue(readInteractionRecord(store, readId, id)) };
          if (id.startsWith('browser-')) return { ok: true, ...redactValue(readBrowserReceipt(store, readId, id)) };
          return { ok: true, ...redactValue(readExecutionReceipt(store, readId, args.id)) };
        }
        if (args.action === 'run-effect') return { ok: true, ...await runEffectJob(store, session.id, { ...JSON.parse(args.document), callId: exec.callId }, exec.signal) };
        if (args.action === 'job-detail') return { ok: true, ...readEffectJob(store, readId, args.id) };
        if (args.action === 'verify-effect') return { ok: true, ...verifyEffect(store, session.id, JSON.parse(args.document)) };
        if (args.action === 'effect-detail') return { ok: true, ...readEffectVerification(store, readId, args.id) };
        if (args.action === 'oob-issue') {
          const issued = issueCallbackHost(readOobConfig(ctx.settings), { label: args.label });
          return { ok: true, ...issued, note: '把该域名注入载荷；目标回连后用 oob-check 回查（回连只证明服务端发起过访问，不等于漏洞影响）。' };
        }
        if (args.action === 'oob-check') {
          const config = readOobConfig(ctx.settings);
          const rows = (await fetchOobRecords({ base: config.base, token: config.token, filter: args.label || args.host })).rows;
          const record = recordInteraction(store, session.id, { label: args.label, host: args.host, rows, provider: 'dnslog' });
          return { ok: true, ...interactionSummary(record), note: '命中由宿主回查平台后落库；回连只证明载荷被处理并触发外连，不能当权限或影响。' };
        }
        if (args.action === 'browser-run') {
          // 动作限制：关闭“允许访问网站”后，浏览器执行同样是目标网络操作，必须在开浏览器前拒绝。
          // 缩范围沿任务树传播（v6 第 8.3 节）：子代理同样受主任务当前限制约束。
          const ownPolicy = readTaskPolicy(store, session.id);
          const browserDenial = targetTrafficDenial(ownPolicy ? effectivePolicy(store, ownPolicy) : ownPolicy);
          if (browserDenial) return { ok: false, error: browserDenial };
          const doc = JSON.parse(args.document);
          const denied = taskExecutionGuard(store, session.id, 'recorded-browser-execution', Date.now(), { args: { url: doc.url } });
          if (denied) return { ok: false, error: denied };
          const receipt = await runBrowserExecution({ url: doc.url, marker: doc.marker, executablePath: doc.executablePath, timeoutMs: doc.timeoutMs });
          const stored = recordBrowserReceipt(store, session.id, receipt);
          return { ok: true, ...stored, note: '宿主真开浏览器留下的回执；仅回显、被转义或被 CSP 拦下都不会让 probe 生效。执行现象不等于权限或 RCE。' };
        }
        throw new Error('invalid execution action');
      } catch (error) { return { ok: false, error: error.message }; }
    }
  }));
  ctx.tools.register(defineTool({
    name: 'redteam_research',
    description: '围绕实际输入研究具体问题，保留对照证据；结论须独立复核。',
    parameters: {
      action: { type: 'string', required: true, enum: ['groups', 'list', 'detail', 'create', 'observe', 'assess', 'close'], description: '契约见README' },
      id: { type: 'string', description: 'detail/observe/assess/close必填：验证方向ID；不是观察id' },
      document: { type: 'string', description: 'create用独立字段；observe绑定回执；close写理由；assess兼容旧JSON。' },
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
		description: 'start用独立字段；progress写完成标记；checkpoint等待；delegate/cleanup管理子代理。',
		parameters: {
			action: { type: 'string', enum: ['start', 'status', 'next', 'progress', 'checkpoint', 'cancel', 'pause', 'delegate', 'workers', 'send', 'report', 'review', 'report-draft', 'cleanup', 'update'], required: true },
			mode: { type: 'string', enum: ['regular', 'nday', '0day'] },
			target: { type: 'string' },
			question: { type: 'string', description: '问题≤600字' },
			toolCalls: { type: 'integer', description: '整轮共享工具上限1–10000' },
      modelCalls: { type: 'integer', description: '可选：主/子代理、重试、压缩及标题共享模型调用上限1–10000；开始前设置' },
			minutes: { type: 'integer', description: '时间上限1–10080分钟' },
			workers: { type: 'integer', description: '子代理0–16，≤桌面上限；小任务0' },
			discoveryCalls: { type: 'integer', description: '0day探路额度0至toolCalls' },
			unmeteredToolCalls: { type: 'integer', description: '未计量扫描额度0–100，默认0拒绝' },
			workflow: { type: 'string', enum: ['single', 'regular-to-nday', 'regular-with-nday'], description: '省略沿用桌面；衔接限regular' },
			stop: { type: 'string', enum: ['budget', 'queue', 'first-high', 'first-rce'] },
			policy: { type: 'string', description: '旧JSON，与独立字段互斥' },
			progress: { type: 'string', description: '进度JSON：完成标记和note' },
      planComplete: { type: 'boolean' },
      queueComplete: { type: 'boolean' },
      regularComplete: { type: 'boolean' },
      ndayComplete: { type: 'boolean' },
      document: { type: 'string', description: '子代理：delegate/send/report/pause/checkpoint/cleanup/update（范围与预算）。' }
		},
		output: {
			schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } },
			// update 的变更摘要放在最前面：这一行就是「消息旁显示的变更摘要」（v6 第 4.2 节）。
			render: (_args, value) => [{ type: 'text', text: value.ok
				? (value.summary ? `设置已更新：${value.summary}\n` : '') + JSON.stringify(value, null, 2)
				: `错误：${value.error}${value.recovery ? '\n' + value.recovery : ''}` }]
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
        // 聊天里明确要求改设置（v6 第 4.2 节）：只允许收紧，放宽返回具体缺项。
        else if (args.action === 'update') {
          const updated = updateTaskFromChat(theStore(), session.id, JSON.parse(args.document));
          const state = taskPolicyStatus(theStore(), session.id);
          return { ok: true, ...updated, phase: state.phase, stopped: state.stopped, reason: state.reason };
        }
        else if (args.action === 'checkpoint') checkpointTask(theStore(), session.id, JSON.parse(args.document).note);
        else if (args.action === 'pause') pauseTaskPolicy(theStore(), session.id, JSON.parse(args.document));
        else if (args.action === 'delegate') return { ok: true, ...await siteWorkers.delegate(exec.agent, JSON.parse(args.document), exec.signal) };
        else if (args.action === 'workers') return { ok: true, ...await siteWorkers.status(exec.agent, exec.signal) };
        else if (args.action === 'send') return { ok: true, ...await siteWorkers.send(exec.agent, JSON.parse(args.document), exec.signal) };
        else if (args.action === 'report') return { ok: true, ...await siteWorkers.report(exec.agent, JSON.parse(args.document), exec.signal) };
        else if (args.action === 'review') return { ok: true, ...await purposeTasks.run(exec.agent, 'review', exec.signal) };
        else if (args.action === 'report-draft') return { ok: true, ...await purposeTasks.run(exec.agent, 'report', exec.signal) };
        else if (args.action === 'cleanup') {
          const input = args.document ? JSON.parse(args.document) : {};
          const purpose = input.childId && readTaskPolicy(theStore(), input.childId)?.purposeTask;
          const remainingPurposeTasks = await purposeTasks.cleanup(exec.agent, input.childId);
          return { ok: remainingPurposeTasks.length === 0, remainingPurposeTasks,
            ...(!purpose ? await siteWorkers.cleanup(exec.agent, input.childId, input.reason || 'task ended') : {}) };
        }
				else if (args.action === 'cancel') {
          updateTaskProgress(theStore(), session.id, { cancelled: true });
          if (siteWorkerParent(theStore(), session.id)) await siteWorkers.report(exec.agent, { state: 'blocked', summary: '子任务已取消；保留实际证据并释放子代理。' }, exec.signal);
          else { await purposeTasks.cleanup(exec.agent); await siteWorkers.cleanup(exec.agent, undefined, 'cancelled'); }
        }
				else if (!['status', 'next'].includes(args.action)) throw new Error('invalid task action');
				const state = taskPolicyStatus(theStore(), session.id);
				return Promise.resolve({ ok: true, enforcementAvailable, ...state, ...(args.action === 'next' && state.configured && !state.stopped ? { next: researchNext(theStore(), session.id) } : {}) });
      } catch (error) { return Promise.resolve({ ok: false, error: error?.message ?? String(error),
        ...(args.action === 'start' ? { recovery: '使用start独立字段：mode=regular/nday/0day，target=实际URL，question=当前问题，toolCalls=有限额度；workflow通常省略，人数沿用桌面上限。已有任务不能重启或重置预算。' } : {}),
        ...(args.action === 'update' ? { recovery: 'update 只收紧：interaction/reporting/explain/workers/allowTargetNetwork/readOnly/excludedPaths/requestRatePerMinute/requestConcurrency/toolCalls/minutes。放宽（重开网站访问、取消只读、提高速率或助手上限、换目标）必须由用户在桌面设置里操作。' } : {}) }); }
		}
	}));
	ctx.tools.register(defineTool({
		name: 'redteam_context',
		description: '保存或读取本会话共享资产、入口条件、请求及方法上下文；供Nday/常规/研究复用。',
		parameters: {
			context: { type: 'string', description: '旧快照JSON；assets/requests增量；省略读索引' },
      assets: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {
        id: { type: 'string', required: true }, url: { type: 'string', required: true },
        inScope: { type: 'boolean' }, reachable: { type: 'boolean' }
      } } },
      requests: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {
        id: { type: 'string', required: true }, revision: { type: 'string', required: true },
        endpoint: { type: 'string', required: true }, authContext: { type: 'string', required: true },
        method: { type: 'string' }, headers: { type: 'object', additionalProperties: true },
        body: { type: 'string' }, request: { type: 'string' }, valid: { type: 'boolean' }, responseReceiptId: { type: 'string' }
      } } },
			kind: { type: 'string', description: 'asset/request/method详情；finding无id列索引、有id读详情；material索引或原文' },
      materials: { type: 'string', description: 'JSON：site、files[{path,url}]；离线索引选定JS，增量摘要不证明接口可用' },
			id: { type: 'string', description: '详情记录ID，仅本会话' },
			version: { type: 'string', description: '请求revision或方法version；多版本时必填' },
			search: { type: 'string', description: '按关键词在测试资料里定位：每页最多 5 条短结果（来源/身份/时间）' },
			read: { type: 'integer', description: 'material/finding正文UTF-8偏移，默认0；续读用nextOffset' },
			offset: { type: 'integer', description: '索引偏移；search 时是下一页游标' }
		},
		output: {
			schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } },
			render: (_args, value) => [{ type: 'text', text: value.ok ? value.text : value.error }]
		},
		execute(args, exec) {
			const session = sessionOf(ctx, exec);
			if (!session || session.mode !== 'pentest') return Promise.resolve({ ok: false, error: '仅当前渗透会话可读写共享上下文' });
		try {
        if (args.assets !== undefined || args.requests !== undefined) {
          if (args.context !== undefined) throw new Error('assets/requests 与旧 context 不可同时提供');
          const patch = { ...(readTaskContext(theStore(), session.id) || {}) };
          for (const field of ['assets', 'requests']) {
            if (args[field] === undefined) continue;
            if (!Array.isArray(args[field])) throw new Error(field + ' 必须是数组');
            const key = row => JSON.stringify(field === 'requests' ? [row?.id, row?.revision] : [row?.id]);
            const incoming = new Set(), rows = new Map((patch[field] || []).map(row => [key(row), row]));
            for (const row of args[field]) {
              const identity = key(row);
              if (incoming.has(identity)) throw new Error('duplicate ' + field + ' identity');
              incoming.add(identity);
              rows.set(identity, { ...rows.get(identity), ...row });
            }
            patch[field] = [...rows.values()];
          }
          args = { ...args, context: JSON.stringify(patch) };
        }
        const readId = purposeReadSessionId(theStore(), session);
        if (args.kind === 'finding') {
          if ([args.context, args.materials, args.search, args.version].some(value => value !== undefined)) throw new Error('发现查询只传kind、id和offset；详情支持read字节偏移');
          return Promise.resolve({ ok: true, ...findingReadView(theStore(), readId, args) });
        }
        if (args.materials !== undefined && ([args.context, args.id, args.version].some(value => value !== undefined)
          || (args.kind !== undefined && args.kind !== 'material') || (args.offset !== undefined && args.offset !== 0)))
          throw new Error('索引只传materials；可附kind=material和offset=0。不要context/id/version；files需要选定文件的path和url。');
        // 模型侧资料搜索（v6 第 5.4.1 节）：最多 5 条短结果 + 下一页游标，和快照/索引/详情分开调用。
        if (args.search !== undefined && [args.context, args.materials, args.kind, args.id, args.version].some(value => value !== undefined))
          throw new Error('搜索测试资料只传search（可附offset游标）；不要和快照、索引或详情混在一起。');
        if (args.search !== undefined) return Promise.resolve({ ok: true, ...searchMaterials(theStore(), readId, { query: args.search, offset: args.offset ?? 0, workspace: sessionWorkingDirectory(ctx, exec.agent.session) }) });
        if (args.materials === undefined && args.kind === 'material' && [args.context, args.version, args.offset].some(value => value !== undefined)) throw new Error('材料详情不能与快照或版本查询混用');
        if (args.materials !== undefined) {
          // 站点材料更新同样是「资料事件」（v6 第 8.3 节）：同一 URL 换了内容会写回同一 id 的新版本，
          // 这里按更新过的 id 唤醒依赖它的工作；只被复用、内容没变的材料不算事件。
          const indexed = indexBusinessMaterials(theStore(), session.id, sessionWorkingDirectory(ctx, exec.agent.session), JSON.parse(args.materials));
          const woken = (indexed.updatedIds || []).flatMap(id => wakeWorkersForMaterial(ctx, theStore(), session.id, 'file:' + id));
          return Promise.resolve({ ok: true, ...indexed, woken });
        }
        // 模型读原文（v6 第 5.4.1 节）：kind=material + id + read=字节偏移；每段 ≤6000 字节，代码 ≤80 行，HTTP 分头/体。
        if (args.read !== undefined && (args.kind !== 'material' || !args.id))
          throw new Error('读材料原文要 kind=material、id 和 read=字节偏移，不要和索引或搜索混用。');
        if (args.read !== undefined) {
          const excerpt = readMaterialExcerpt(theStore(), readId, { id: args.id, offset: args.read });
          // 模型真的读了原文才记「已读过」（v6 第 5.4 节）：本地浏览详情、引用到输入框都不算。
          if (!excerpt.missing) {
            const bytes = (excerpt.kind === 'code' || excerpt.kind === 'text')
              ? Buffer.byteLength(excerpt.content || '', 'utf8')
              : Buffer.byteLength((excerpt.head || '') + (excerpt.body || ''), 'utf8');
            recordMaterialRead(theStore(), session.id, { materialId: materialReadKey('file', args.id), bytes, offset: excerpt.offset });
          }
          return Promise.resolve({ ok: true, ...excerpt });
        }
        if (args.kind === 'material') return Promise.resolve({ ok: true, ...businessMaterialView(theStore(), readId, { id: args.id }) });
				if (args.context !== undefined && (args.kind !== undefined || args.id !== undefined || args.version !== undefined)) throw new Error('保存快照与详情查询应分开调用');
				const context = args.context === undefined ? readTaskContext(theStore(), readId) : saveTaskContext(theStore(), session.id, JSON.parse(args.context));
				if (args.version !== undefined && ['request', 'method'].includes(args.kind)) {
					const field = args.kind === 'request' ? 'requests' : 'methods';
					if (!context?.[field].some(row => row.id === args.id && (row.revision || row.version) === args.version)) {
						const item = readTaskRecord(theStore(), readId, args.kind, args.id, args.version);
						if (!item) throw new Error('record not found in current session');
						return Promise.resolve({ ok: true, item, historical: true, text: '历史版本，须核对当前身份和基线后使用：\n' + JSON.stringify(item, null, 2) });
					}
				}
				// 模型读请求原文也算「已读过」（v6 第 5.4 节）：本地浏览详情与引用到输入框都不算。
				if (args.kind === 'request' && args.id) {
					const row = (context?.requests || []).find(item => item.id === args.id && (!args.version || item.revision === args.version));
					if (row) recordMaterialRead(theStore(), session.id, { materialId: materialReadKey('request', row.id + ':' + row.revision),
						bytes: Buffer.byteLength(String(row.request || '') + String(row.response || ''), 'utf8') });
				}
				return Promise.resolve({ ok: true, context, ...taskContextView(context, args) });
			} catch (error) { return Promise.resolve({ ok: false, error: error.message }); }
		}
	}));
	//#region 项目测试工具（scenario=project）
	const projectScopeOf = exec => {
		const session = sessionOf(ctx, exec);
		if (!session || session.mode !== 'pentest') return { error: '仅当前渗透会话可用' };
		const store = theStore();
		const policy = readTaskPolicy(store, session.id);
		if (policy?.scenario !== 'project') return { error: '仅「按文档测试」场景可用' };
		const run = activeProjectRun(store, session.id);
		if (!run) return { error: '当前没有活动的项目运行' };
		return { session, policy, run, store };
	};
	const projectBrowserGuardOf = scope => async ({ url, method }) => {
		const currentRun = readProjectRun(scope.store, scope.session.id, scope.run.runId);
		if (!currentRun || currentRun.runId !== scope.run.runId || currentRun.state !== 'running')
			return { denial: '项目已暂停或停止，浏览器请求不能继续派发' };
		const currentPolicy = readTaskPolicy(scope.store, scope.session.id);
		if (currentPolicy?.scenario !== 'project') return { denial: '当前会话已不是按文档测试场景' };
		const limits = effectivePolicy(scope.store, currentPolicy);
		let parsed;
		try { parsed = new URL(String(url || '')); } catch { return { denial: '浏览器请求地址无效' }; }
		const denial = targetTrafficDenial(limits, { method })
			|| excludedPathDenial(limits, { url: parsed.href });
		if (denial) return { denial };
		const origins = new Set();
		if (limits.target) {
			try { origins.add(new URL(limits.target).origin); } catch { /* 无效目标由其他闸拒绝 */ }
		}
		for (const asset of readTaskContext(scope.store, scope.session.id)?.assets || []) {
			if (asset?.inScope !== true || asset?.reachable !== true) continue;
			try { origins.add(new URL(asset.url).origin); } catch { /* 忽略无效资产 */ }
		}
		if (!origins.has(parsed.origin)) return { denial: '浏览器请求不在本次授权站点或明确关联资产内' };
        return { policy: limits, revision: crypto.createHash('sha256').update(JSON.stringify([
          currentRun.runId, currentRun.controlRev, currentPolicy.policyRev, limits,
        ])).digest('hex') };
	};
	ctx.tools.register(defineTool({
		name: 'project_document',
		description: '项目文档：列出、搜索或分段读取。',
		parameters: {
			action: { type: 'string', required: true, enum: ['list', 'search', 'read'] },
			query: { type: 'string' }, sourceId: { type: 'string' }, sourceRevision: { type: 'string' },
			sectionId: { type: 'string' }, cursor: { type: 'integer' }, limit: { type: 'integer' }
		},
		output: { schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } }, render: (_args, value) => [{ type: 'text', text: value.ok ? value.text : value.error }] },
		execute(args, exec) {
			const scope = projectScopeOf(exec);
			if (scope.error) return Promise.resolve({ ok: false, error: scope.error });
			try {
				const sources = listProjectSources(scope.store, scope.session.id);
				if (args.action === 'list') {
					const entries = [];
					for (const source of sources) {
						const sections = source.sections || [];
						const candidates = sections.length ? sections : [{ sectionId: '#source', location: null, kind: 'source' }];
						for (const section of candidates) entries.push({
							sourceId: source.sourceId, sourceRevision: source.sourceRevision,
							displayName: source.displayName || '', parseState: source.parseState,
							sectionId: section.sectionId, location: section.location ?? null, kind: section.kind || '',
						});
					}
					const offset = Math.max(0, Number(args.cursor) || 0);
					const limit = Math.max(1, Math.min(200, Number(args.limit) || 80));
					const page = entries.slice(offset, offset + limit);
					const header = sources.map(source => source.sourceId + ' ' + (source.displayName || '') + ' ' + source.sourceRevision
						+ ' ' + source.parseState + '；段落 ' + (source.sections || []).length
						+ (source.unread?.length ? '；不可读区域 ' + source.unread.length : '')).join('\n');
					const text = (header ? header + '\n' : '') + (page.length
						? '目录 ' + (offset + 1) + '-' + (offset + page.length) + '/' + entries.length + '\n'
							+ page.map(item => item.sourceId + ' ' + item.sourceRevision + ' ' + item.sectionId
								+ (item.location ? ' @' + JSON.stringify(item.location) : '')).join('\n')
						: '没有可显示的文档段落');
					return Promise.resolve({ ok: true, text, sources: sources.map(source => ({
						sourceId: source.sourceId, sourceRevision: source.sourceRevision, displayName: source.displayName,
						parseState: source.parseState, sectionCount: (source.sections || []).length, unreadCount: (source.unread || []).length,
					})), entries: page, nextCursor: offset + page.length < entries.length ? offset + page.length : null, more: offset + page.length < entries.length });
				}
				if (args.action === 'search') {
					const query = String(args.query || '').toLowerCase();
					if (!query) throw new Error('search 需要 query');
					const hits = [];
					for (const source of sources) for (const section of source.sections || []) {
						const index = String(section.text || '').toLowerCase().indexOf(query);
            if (index >= 0) hits.push({ sourceId: source.sourceId, sourceRevision: source.sourceRevision, sectionId: section.sectionId, location: section.location ?? null, offset: Math.max(0, index - 60), snippet: String(section.text).slice(Math.max(0, index - 60), index + 140) });
					}
					const shown = hits.slice(0, 20);
          for (const hit of shown) {
            recordMaterialRead(scope.store, scope.session.id, { materialId: 'project:' + hit.sourceId + '@' + hit.sourceRevision + ':' + hit.sectionId, bytes: Buffer.byteLength(hit.snippet, 'utf8'), offset: hit.offset });
            recordProjectDocumentRead(scope.store, scope.session.id, scope.run.runId, { ...hit, cursor: hit.offset, text: hit.snippet, controlRev: scope.run.controlRev });
          }
					return Promise.resolve({ ok: true, text: shown.length ? shown.map(hit => hit.sourceId + ' ' + hit.sourceRevision + ' ' + hit.sectionId + '：' + hit.snippet).join('\n') : '没有命中：' + args.query, hits: shown });
				}
				if (args.action === 'read') {
					const source = sources.find(item => item.sourceId === args.sourceId && (!args.sourceRevision || item.sourceRevision === args.sourceRevision));
					if (!source) throw new Error('未找到该来源：' + args.sourceId);
					const result = readDocumentSection({ sections: source.sections || [] }, String(args.sectionId || ''), { cursor: args.cursor, limit: args.limit });
          recordMaterialRead(scope.store, scope.session.id, { materialId: 'project:' + source.sourceId + '@' + source.sourceRevision + ':' + result.sectionId, bytes: Buffer.byteLength(result.text, 'utf8'), offset: Math.max(0, Number(args.cursor) || 0) });
          recordProjectDocumentRead(scope.store, scope.session.id, scope.run.runId, { sourceId: source.sourceId, sourceRevision: source.sourceRevision, sectionId: result.sectionId, cursor: args.cursor, text: result.text, controlRev: scope.run.controlRev });
					const range = '[' + (Math.max(0, Number(args.cursor) || 0)) + ',' + (Math.max(0, Number(args.cursor) || 0) + result.text.length) + ')';
					const text = '来源：' + (source.displayName || source.sourceId) + ' · 修订：' + source.sourceRevision + ' · 段落：' + result.sectionId
						+ ' · 范围：' + range + ' · 后续：' + (result.more ? '有，nextCursor=' + result.nextCursor : '无')
						+ '\n\n' + result.text;
					return Promise.resolve({ ok: true, text, sourceId: source.sourceId, sourceRevision: source.sourceRevision, sectionId: result.sectionId, location: result.location ?? null, nextCursor: result.nextCursor, more: result.more });
				}
				throw new Error('未知的文档操作：' + args.action);
			} catch (error) { return Promise.resolve({ ok: false, error: error.message }); }
		}
	}));
	ctx.tools.register(defineTool({
		name: 'project_check',
		description: '项目检查：定义、领取、查看、记录。',
		parameters: {
			action: { type: 'string', required: true, enum: ['define', 'next', 'detail', 'record'] },
			checks: { type: 'array', description: 'define 时提供从文档整理的检查项。', items: { type: 'object', additionalProperties: false, properties: {
        requirement: { type: 'string', required: true, description: '本项实际要检查什么。' },
        sourceLocation: { type: 'string', description: '来源位置文本' },
        sourceRefs: { type: 'array', description: '本次固定来源引用', items: { type: 'object', additionalProperties: false, properties: {
          sourceId: { type: 'string', required: true }, sourceRevision: { type: 'string', required: true }, sectionId: { type: 'string', required: true },
        } } },
        checkId: { type: 'string' }, order: { type: 'integer' },
        dependencies: { type: 'array', items: { type: 'string' } },
        provides: { type: 'array', description: '本检查可向前项提供的事实名', items: { type: 'string' } },
        requiresFacts: { type: 'array', description: '要求依赖项实际提供的事实名', items: { type: 'string' } },
      } } },
      batchId: { type: 'string', description: '稳定批次幂等键；响应丢失后重试应复用相同值' },
      sectionDecisions: { type: 'array', description: '来源整理决定', items: { type: 'object', additionalProperties: false, properties: {
        sourceId: { type: 'string', required: true }, sourceRevision: { type: 'string', required: true },
        sectionId: { type: 'string', required: true, description: '来源段落 ID；无段落用 #source。' },
        decision: { type: 'string', required: true, enum: ['requirements', 'reference', 'unreadable'] },
        rationale: { type: 'string', description: '参考/不可读依据' },
        checkIds: { type: 'array', description: '关联本批 checkId', items: { type: 'string' } },
      } } },
      document: { type: 'string', description: '兼容旧 JSON；新调用用 checks' }, checkId: { type: 'string' },
			verdict: { type: 'string', enum: ['not_found', 'issue', 'needs_check', 'blocked', 'not_applicable'] },
			checkedContent: { type: 'string' }, gaps: { type: 'string' },
			findingRefs: { type: 'array', items: { type: 'string' } },
			reusedObservations: { type: 'array', description: '复用已有动作观察时提供 actionId 和具体理由', items: {
				type: 'object', additionalProperties: false, properties: {
					actionId: { type: 'string', required: true }, reason: { type: 'string', required: true },
				},
			} }
		},
		output: { schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } }, render: (_args, value) => [{ type: 'text', text: value.ok ? value.text : value.error }] },
		execute(args, exec) {
			const scope = projectScopeOf(exec);
			if (scope.error) return Promise.resolve({ ok: false, error: scope.error });
			try {
        if (['define', 'next', 'record'].includes(args.action) && !['preparing', 'running'].includes(scope.run.state))
          throw new Error('项目已暂停，继续后再修改检查');
				if (args.action === 'define') {
          let input = args.checks, decisions = args.sectionDecisions;
          if (input === undefined && args.document) {
            try { const legacy = JSON.parse(String(args.document)); input = legacy.checks; decisions = legacy.sectionDecisions; }
            catch { throw new Error('define 需要 checks 数组，例如 [{"requirement":"检查内容","sourceLocation":"文档段落或表格行"}]'); }
          }
          if (!Array.isArray(input)) input = [];
          if (!Array.isArray(decisions)) decisions = [];
          if (input.some(check => typeof check?.requirement !== 'string' || !check.requirement.trim()))
            throw new Error('checks 每项必须填写 requirement（检查内容）');
          if (!input.length && !decisions.length)
            throw new Error('define 需要 checks 或 sectionDecisions；纯参考资料也要保存明确的 reference 决定');
					const checks = defineProjectChecks(scope.store, scope.session.id, scope.run.runId, input, decisions, { batchId: args.batchId });
          const latestRun = readProjectRun(scope.store, scope.session.id, scope.run.runId);
					return Promise.resolve({ ok: true, ...(args.batchId ? { batchId: String(args.batchId) } : {}), text: (checks.length ? '已定义 ' + checks.length + ' 项检查：\n' + checks.map(check => check.checkId + ' ' + check.requirement).join('\n') : '未新增检查')
            + (decisions.length ? '\n已整理 ' + decisions.length + ' 个来源区域。' : '') + (Object.keys(latestRun?.sectionDecisions || {}).length ? ' 本次累计 ' + Object.keys(latestRun.sectionDecisions).length + ' 个区域。' : ''),
            checks: checks.map(check => ({ checkId: check.checkId, requirement: check.requirement, sourceLocation: check.sourceLocation, sourceRefs: check.sourceRefs })),
            sectionDecisions: decisions.map(item => ({ sourceId: item.sourceId, sourceRevision: item.sourceRevision, sectionId: item.sectionId, decision: item.decision })) });
				}
				if (args.action === 'next') {
          const check = selectProjectCheck(scope.store, scope.session.id, scope.run.runId);
					if (!check) return Promise.resolve({ ok: true, text: '没有可执行的未完成检查', check: null });
					return Promise.resolve({ ok: true, text: '当前检查：' + check.requirement + '（' + (check.sourceLocation || '未记录来源') + '）；checkId=' + check.checkId, check: { checkId: check.checkId, requirement: check.requirement, sourceLocation: check.sourceLocation, dependencies: check.dependencies } });
				}
				if (args.action === 'detail') {
					const check = readProjectCheck(scope.store, scope.session.id, scope.run.runId, String(args.checkId || ''));
					if (!check) throw new Error('未找到该检查');
					return Promise.resolve({ ok: true, text: JSON.stringify(check, null, 2), check });
				}
				if (args.action === 'record') {
					const findingRefs = Array.isArray(args.findingRefs) ? args.findingRefs.map(value => String(value)) : [];
					for (const findingId of findingRefs) if (!getFinding(scope.store, scope.session.id, findingId))
						throw new Error('未找到关联 finding：' + findingId);
					const currentCheck = readProjectCheck(scope.store, scope.session.id, scope.run.runId, String(args.checkId || ''));
					if (!currentCheck) throw new Error('未找到该检查');
					const check = recordProjectCheck(scope.store, scope.session.id, scope.run.runId, String(args.checkId || ''), {
						executionState: 'ended', verdict: args.verdict, checkedContent: args.checkedContent, gaps: args.gaps, findingRefs,
						reusedObservations: args.reusedObservations, controlRev: scope.run.controlRev,
						checkRevision: currentCheck.checkRevision,
					});
					return Promise.resolve({ ok: true, text: '已记录：' + check.requirement + ' → ' + check.verdict
						+ (check.findingRefs?.length ? '（关联 ' + check.findingRefs.join('、') + '）' : ''), check });
				}
				throw new Error('未知的检查操作：' + args.action);
			} catch (error) { return Promise.resolve({ ok: false, error: error.message }); }
		}
	}));
	ctx.tools.register(defineTool({
		name: 'saker_browser',
		description: '受管 CfT 浏览器：打开、观察、操作、请求。',
		parameters: {
			action: { type: 'string', required: true, enum: ['open', 'observe', 'act', 'requests', 'request-detail', 'close'] },
			url: { type: 'string' }, checkId: { type: 'string' }, selector: { type: 'string' },
			actType: { type: 'string', enum: ['click', 'type', 'select', 'navigate', 'upload', 'download', 'dialog'] },
			text: { type: 'string' }, value: { type: 'string' },
			files: { type: 'array', items: { type: 'string' } },
			requestId: { type: 'string' }, screenshot: { type: 'boolean' }, identityRef: { type: 'string' },
			accept: { type: 'boolean' }, promptText: { type: 'string' },
			cursor: { type: 'integer' }, limit: { type: 'integer' }, directory: { type: 'string' }
		},
		output: { schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } }, render: (_args, value) => [{ type: 'text', text: value.ok ? value.text : value.error }] },
		async execute(args, exec) {
			const scope = projectScopeOf(exec);
			if (scope.error) return { ok: false, error: scope.error };
			let begun;
			try {
				const action = String(args.action || '');
				const targetAction = ['open', 'act'].includes(action);
				if (targetAction) {
					if (scope.run.state !== 'running') throw new Error('项目运行当前不可派发浏览器动作');
					if (exec.signal?.aborted) throw new Error('项目动作已取消');
					const checkId = String(args.checkId || scope.run.currentCheckId
						|| projectExecutableChecks(scope.store, scope.session.id, scope.run.runId)[0]?.checkId || '');
					if (!checkId) throw new Error('请先用 project_check 选择当前检查，再执行浏览器目标动作');
					const denied = taskExecutionGuard(scope.store, scope.session.id, 'recorded-project-execution', Date.now(), {
						args: { url: args.url || '' },
						onReserve: () => { begun = beginProjectAction(scope.store, scope.session.id, scope.run.runId, checkId, {
							identityRef: String(args.identityRef || ''), controlRev: scope.run.controlRev,
						}); },
					});
					if (denied) throw new Error(denied);
				}
				let browser = projectBrowsers.get(scope.session.id);
				const identityRef = String(args.identityRef ?? browser?.identityRef ?? '').trim();
				if (browser && browser.identityRef !== identityRef) {
					await browser.close();
					projectBrowsers.delete(scope.session.id);
					browser = null;
				}
				if (action === 'close') {
					if (browser) { await browser.close(); projectBrowsers.delete(scope.session.id); }
					return { ok: true, text: '浏览器会话已关闭' };
				}
				if (!browser) {
					if (!targetAction) throw new Error('请先打开浏览器页面，再读取已有观察或请求');
					browser = await startBrowserSession({
						identity: scope.session.id, identityRef,
						requestGuard: projectBrowserGuardOf(scope),
						pacingSessionId: scope.session.id,
					});
					projectBrowsers.set(scope.session.id, browser);
				}
				try {
					let result;
					if (action === 'open') result = await browser.open(String(args.url || ''));
					else if (action === 'act') result = await browser.act({ type: args.actType, url: args.url, selector: args.selector, text: args.text, value: args.value, files: args.files, directory: args.directory, accept: args.accept, promptText: args.promptText });
					else if (action === 'observe') result = await browser.observe({ selector: args.selector, screenshot: args.screenshot === true });
					else if (action === 'requests') result = browser.listRequestsPage({ cursor: args.cursor, limit: args.limit });
					else if (action === 'request-detail') result = await browser.requestDetail(String(args.requestId || ''));
					else throw new Error('未知的浏览器操作：' + action);
					if (action === 'open') {
						const observationRef = saveProjectBrowserObservation(scope.store, scope.session.id, scope.run.runId, begun.action.actionId, result);
						const page = redactValue(result);
						return { ok: true, text: JSON.stringify({ title: page.title, url: page.url, executionId: begun.action.actionId, observationRef }), page, actionId: begun.action.actionId, observationRef };
					}
					if (action === 'act') {
						if (result.state === 'failed') {
							await finishProjectAction(scope.store, scope.session.id, scope.run.runId, begun?.action?.actionId, {
								executionState: 'failed', error: result.error || 'browser-action-failed',
							});
							return { ok: false, error: result.error || '浏览器动作失败', result, actionId: begun?.action?.actionId || null };
						}
						let attachmentRef = '';
						if (result.completed === true && result.file) {
							try {
								const bytes = fs.readFileSync(result.file);
								const digest = crypto.createHash('sha256').update(bytes).digest('hex');
								attachmentRef = 'project-attachment-' + digest;
								const material = {
									id: attachmentRef, kind: 'download', displayName: result.filename || path.basename(result.file),
									digest, bytes: bytes.length, originalBase64: bytes.toString('base64'),
									relativeRef: 'materials/' + attachmentRef, indexedAt: new Date().toISOString(),
								};
								scope.store.db.prepare('INSERT INTO business_materials(session_id,id,source_url,digest,record) VALUES(?,?,?,?,?) '
									+ 'ON CONFLICT(session_id,id) DO UPDATE SET record=excluded.record,digest=excluded.digest')
									.run(scope.session.id, attachmentRef, 'https://project-attachment.invalid/' + digest,
										digest, JSON.stringify(material));
								result = { ...result, attachmentRef };
							} catch (error) {
								result = { ...result, state: 'failed', completed: false, error: 'download-file-unreadable: ' + redactText(error.message) };
							}
						}
						await finishProjectAction(scope.store, scope.session.id, scope.run.runId, begun?.action?.actionId, {
							executionState: result.state === 'failed' ? 'failed' : 'completed',
							error: result.state === 'failed' ? result.error : undefined,
							attachmentRef,
						});
						const safeResult = redactValue(result);
						return { ok: result.state !== 'failed', text: JSON.stringify(safeResult), ...(result.state === 'failed' ? { error: result.error } : {}), result: safeResult, actionId: begun?.action?.actionId || null };
					}
					if (action === 'observe' && scope.run.state === 'running') {
						const checkId = String(args.checkId || scope.run.currentCheckId || '');
						if (checkId) {
							begun = beginProjectAction(scope.store, scope.session.id, scope.run.runId, checkId, { controlRev: scope.run.controlRev, identityRef });
							const observationRef = saveProjectBrowserObservation(scope.store, scope.session.id, scope.run.runId, begun.action.actionId, result);
							const page = redactValue(result);
							return { ok: true, text: JSON.stringify(page), page, actionId: begun.action.actionId, observationRef };
						}
					}
					const safeResult = redactValue(result);
					return { ok: true, text: action === 'request-detail' ? String(safeResult.responseBody || '').slice(0, 2000) : JSON.stringify(safeResult), [action === 'request-detail' ? 'request' : action === 'observe' ? 'page' : 'requests']: safeResult };
				} catch (error) {
					if (begun) {
						const sideEffectUnknown = action === 'act' && ['click', 'type', 'select', 'upload', 'dialog'].includes(String(args.actType || ''));
						await finishProjectAction(scope.store, scope.session.id, scope.run.runId, begun.action.actionId, {
							executionState: sideEffectUnknown ? 'unknown' : 'failed', error: redactText(error.message), sideEffectUnknown,
						});
					}
					throw error;
				}
				} catch (error) {
					if (begun) {
						const pending = listProjectActions(scope.store, scope.session.id, scope.run.runId).find(item => item.actionId === begun.action.actionId);
						if (['queued', 'dispatched'].includes(pending?.executionState))
							finishProjectAction(scope.store, scope.session.id, scope.run.runId, begun.action.actionId, { executionState: 'failed', error: redactText(error.message) });
					}
					return { ok: false, error: redactText(error.message) };
				}
		}
	}));
	ctx.tools.register(defineTool({
		name: 'project_request',
		description: '项目 HTTP 请求，自动绑定检查、范围、身份。',
		parameters: {
			method: { type: 'string' }, url: { type: 'string', required: true },
			headers: { type: 'object', additionalProperties: true }, body: { type: 'string' },
			authContext: { type: 'string' }, timeoutMs: { type: 'integer' }, checkId: { type: 'string' }
		},
		output: { schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } }, render: (_args, value) => [{ type: 'text', text: value.ok ? value.text : value.error }] },
		async execute(args, exec) {
			const scope = projectScopeOf(exec);
			if (scope.error) return { ok: false, error: scope.error };
			try {
				const checkId = String(args.checkId || scope.run.currentCheckId || projectExecutableChecks(scope.store, scope.session.id, scope.run.runId)[0]?.checkId || '');
				if (!checkId) throw new Error('请先用 project_check 选择当前检查');
        const result = await executeProjectHttp(scope.store, scope.session.id, scope.run.runId, checkId, args, exec.signal);
				return { ok: true, text: result.summary, ...result };
			} catch (error) { return { ok: false, error: redactText(error.message) }; }
		}
	}));
	//#endregion
	ctx.tools.register(defineTool({
		name: 'redteam_delivery',
		description: '将已复核有效漏洞、复现材料与脱敏证据打为ZIP到会话工作目录；不完整成果不计入。',
		parameters: {},
		output: {
			schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } },
			render: (_args, value) => [{ type: 'text', text: value.ok ? `交付包：${value.path}；有效漏洞 ${value.confirmedFindings}，检查 ${value.checkedCount}，待补齐 ${value.incompleteRecords}` : value.error }]
		},
		async execute(_args, exec) {
			const session = sessionOf(ctx, exec);
			if (!session || session.mode !== 'pentest') return Promise.resolve({ ok: false, error: '仅当前渗透会话可生成交付包' });
			try {
				const readId = purposeReadSessionId(theStore(), session);
				let cwd = await ensureWorkingDirectory(ctx, exec.agent, exec.signal);
				if (typeof cwd !== 'string' || !cwd) throw new Error('会话工作目录缺失');
				if (cwd.startsWith('file:')) cwd = fileURLToPath(cwd);
				if (!path.isAbsolute(cwd)) throw new Error('会话工作目录必须为绝对路径');
				cwd = fs.realpathSync(cwd);
				const bundle = buildDeliveryFiles(allFindings(theStore(), readId, 'pentest'), readChecks(theStore(), readId));
				const target = path.join(cwd, 'saker-delivery-' + crypto.randomUUID() + '.zip');
				fs.writeFileSync(target, zipDelivery(bundle.files), { flag: 'wx' });
				return Promise.resolve({ ok: true, path: target, confirmedFindings: bundle.confirmedFindings, incompleteRecords: bundle.incompleteRecords, checkedCount: bundle.checkedCount });
			} catch (error) { return Promise.resolve({ ok: false, error: error.message }); }
		}
	}));
	ctx.tools.register(defineTool({
		name: 'redteam_checks',
		description: '批量保存/读取本会话检查；未命中须有效请求与证据；交付仅三列。',
		parameters: { records: { type: 'string', description: '省略读取；JSON数组，字段见README（status 只有 not-hit/not-applicable/blocked/not-tested）。' } },
		output: {
			schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } },
			render: (_args, value) => [{ type: 'text', text: value.ok ? value.text : value.error }]
		},
		execute(args, exec) {
			const session = sessionOf(ctx, exec);
			if (!session || session.mode !== 'pentest') return Promise.resolve({ ok: false, error: '仅当前渗透会话可读写检查记录' });
			try {
				const readId = purposeReadSessionId(theStore(), session);
				const rows = args.records === undefined ? readChecks(theStore(), readId) : saveChecks(theStore(), session.id, JSON.parse(args.records));
				return Promise.resolve({ ok: true, rows, text: renderCheckedTsv(rows) });
			} catch (error) { return Promise.resolve({ ok: false, error: error.message }); }
		}
	}));
	const trustedHosts = () => {
		try { return ctx.webRuntime?.trustedHosts ?? []; } catch { return []; }
	};
	const registerWebRoute = (webCtx) => {
		const webServer = webCtx?.webServer ?? ctx.get?.('webServer') ?? ctx.webServer;
		if (!webServer?.register) return;
		ctx.effect(() => webServer.register({
		kind: "prefix",
		path: ROUTE_PATH,
		handler: async (req, res) => {
			// 统一返回契约（v6 第 9.3 节）：旧字段保持兼容，另补 data / revision / requestId。
			const requestId = "rtr-" + crypto.randomUUID();
			const send = (code, body) => {
				const payload = contractEnvelope(body, requestId);
				const text = JSON.stringify(payload);
				res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
				res.end(text);
			};
			if (!isTrustedRequest(req, trustedHosts())) { send(403, { ok: false, code: "route-untrusted-host", error: "请求来源不是受信主机", hint: recoverableHint("route-untrusted-host") }); return; }
			let csrfPath = "";
			try { csrfPath = new URL(req.url ?? "/", "http://x").pathname; } catch { csrfPath = ""; }
			if (req.method === "GET" && csrfPath === ROUTE_PATH + "/csrf") { send(200, { token: CSRF_TOKEN }); return; }
			if (req.method !== "POST") { send(405, { ok: false, code: "route-method-not-allowed", error: "只接受 POST", hint: recoverableHint("route-method-not-allowed") }); return; }
			if (!checkCsrf(req, CSRF_TOKEN)) { send(403, { ok: false, code: "route-csrf", error: "csrf token missing or invalid", hint: recoverableHint("route-csrf") }); return; }
			let endpoint = "";
			try { endpoint = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname.slice(ROUTE_PATH.length)).replace(/^\/+/, ""); } catch { endpoint = ""; }
			if (endpoint === "") { send(404, { ok: false, code: "route-endpoint-missing", error: "not found", hint: recoverableHint("route-endpoint-missing") }); return; }
			try {
				const raw = await readBody(req);
				const payload = raw === "" ? {} : JSON.parse(raw);
				const result = await dispatch(ctx, theStore(), endpoint, payload);
				send(200, result);
			} catch (e) {
				// 版本冲突用 409（v6 第 9.3 节「版本冲突 409 语义」）：模板 CAS、任务策略 CAS、
				// 工作租约被别人持有都属于"现状和你手上的版本对不上"，客户端要能据此刷新重试，
				// 而不是当成普通的参数错误。其余业务错误仍是 400。
				const code = e?.code === undefined ? "" : String(e.code);
				const status = /-conflict$/.test(code) || code === "work-lease-held" ? 409 : 400;
				send(status, { ok: false, ...(code ? { code } : {}), error: e?.message ?? String(e),
					hint: recoverableHint(code), ...(e?.details ? { details: e.details } : {}) });
			}
		}
		}), "dsh-redteam-results: web route");
	};
	if (typeof ctx.inject === 'function') ctx.inject(['webServer'], registerWebRoute);
	else registerWebRoute(ctx);
	// 卸载时释放 atlas 互链句柄——否则 Windows 上库文件被占，插件重装/库迁移会失败。
	//#endregion
}

export { MODES, MODE_LABELS, SEVERITIES, STATUSES, EVIDENCE_LEVELS, ROUTE_PATH, apply, inject, name, openStore };

//#endregion
