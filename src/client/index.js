// Saker workbench client source. Runtime output: plugins/dsh-redteam-results/lib/client.js
// Rebuild: node scripts/build-client.mjs
window.__ModuleLoader__.load({ id: "@dsh-external/dsh-redteam-results", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
// dsh-redteam-results client — 执行记录、发现与测试资料的直接入口。
// 默认按 sessionId 隔离；只有历史页请求 scope=all。模式隔离由服务端双键强制。
"use strict";
/* SAKER-UI-KIT:BEGIN */
var SAKER_UI_KIT_CSS = "/* 5.7 共享组件层：Button / Input / Select / Badge / DataTable / Drawer / InlineNotice / EmptyState\n   单一来源：shared/ui-kit/ui-kit.css（令牌见 shared/ui-kit/ui-kit.json）。\n   由 scripts/sync-ui-kit.mjs 注入到各产品插件；插件里的同类尺寸规则应删除，避免双写。 */\n.saker-ui-btn{height:32px;display:inline-flex;align-items:center;justify-content:center;border-radius:6px}\n.saker-ui-input{height:36px;border-radius:6px}\n.saker-ui-select{height:32px;border-radius:6px}\n.saker-ui-table td{height:38px}\n.saker-ui-badge{border-radius:6px;font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.5}\n.saker-ui-drawer{border-radius:12px}\n.saker-ui-notice{border-radius:6px;font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.5}\n.saker-ui-empty{border-radius:6px;font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.5}\n/* 现有插件类别名：与 canonical 类共用同一套尺寸 */\n.dsh-chat-panel-head button,.dsh-chat-actions button,.dsh-chat-task-status button,.dsh-task-nav button,.dsh-task-actions button{height:32px;display:inline-flex;align-items:center;justify-content:center}\n.dsh-prompt-io button,.dsh-prompt-more,.dsh-prompt-scopes button,.dsh-prompt-modes button,.dsh-prompt-foot button{height:32px;display:inline-flex;align-items:center;justify-content:center}\n.dsh-materials-tools button,.dsh-materials-types button,.dsh-materials-foot button,.dsh-materials-table td button{height:32px;display:inline-flex;align-items:center;justify-content:center}\n.dsh-materials-new button,.dsh-materials-import-actions button,.dsh-execution-tools>button,.dsh-test-content-actions button,.dsh-rtr-btn{height:32px;display:inline-flex;align-items:center;justify-content:center}\n.dsh-task-nav select,.dsh-materials-tools select,.dsh-rtr-select{height:32px}\n.dsh-prompt-saveas input,.dsh-prompt-list input[type=search],.dsh-prompt-field input{height:36px}\n.dsh-materials-tools input[type=search],.dsh-materials-import input,.dsh-task-field input,.dsh-rtr-search{height:36px}\n.dsh-materials-table td{height:38px}\n.dsh-chat-setup svg,.dsh-task-workspace svg{width:16px;height:16px}\n.dsh-hnt-btn,.dsh-hnt-tab{height:32px}\n.dsh-hnt-input{height:36px}\n.dsh-hnt-select{height:32px}\n.dsh-mcs-btn,.dsh-mcs-iconbtn,.dsh-mcs-toolscount--btn{height:32px}\n.dsh-mcs-field input,.dsh-mcs-pairrow input,.dsh-mcs-search{height:36px}\n.dsh-mcs-field select,.dsh-mcs-seg button{height:32px}\n.dsh-sp-chip.is-btn{height:32px}\n.dsh-mg-chip{height:32px}\n/* 内联 style 插件（sec-config / skill-browse）：根容器打 data-saker-ui，\n   控件尺寸由共享层统一给，插件自己的 helper 不再写 height。 */\n[data-saker-ui] button{height:32px}\n[data-saker-ui] input:not([type=checkbox]):not([type=radio]):not([type=file]){height:36px}";
/* SAKER-UI-KIT:END */
var React = require("react");
var useState = React.useState, useEffect = React.useEffect, useCallback = React.useCallback, useRef = React.useRef;

var dshCsrf = {};
// 0.2.1 把插件自注册路由挂在 /api 前缀下；0.2.0 仍是根路径。
// 先探测两个候选，命中后固定本次会话的 base；不把端口或前缀写死在每个调用点。
var SAKER_API_BASES = ["/dsh-redteam-results", "/api/dsh-redteam-results"];
var sakerApiBase = null;
function readJsonResponse(response, label) {
	return response.text().catch(function () { throw Error(label + "失败：HTTP " + response.status + " · 响应体不可读"); }).then(function (text) {
		var body = String(text || ""), type = response.headers && response.headers.get ? (response.headers.get("content-type") || "") : "";
		if (!response.ok) {
			var problem;
			try { problem = JSON.parse(body); } catch (_) { /* 非 JSON 错误体继续走原始文本提示 */ }
			if (problem && typeof problem.error === 'string' && problem.error.trim()) {
				var failure = Error(problem.error.trim() + '（HTTP ' + response.status + '）');
				failure.code = problem.code;
				failure.requestId = problem.requestId;
				failure.status = response.status;
				throw failure;
			}
			var detail = body.trim().slice(0, 240);
			throw Error(label + "失败：HTTP " + response.status + (detail ? " · " + detail : " · 响应为空"));
		}
		if (!body.trim()) throw Error(label + "失败：HTTP " + response.status + " · 响应为空");
		try { return JSON.parse(body); }
		catch (_) { throw Error(label + "失败：响应不是 JSON（HTTP " + response.status + "，" + (type || "未知类型") + "，" + body.length + " 字节）"); }
	});
}
/** CSRF token 懒加载（同源 GET /csrf，跨源页面读不到）；POST 回带 x-dsh-csrf 头。
 *  token 缓存遇 403 即失效重取一次——宿主重启轮换 token 后已开标签页自愈，不再永久 403。 */
function csrfOf(base) {
	if (!dshCsrf[base]) dshCsrf[base] = fetch(base + "/csrf", { credentials: "same-origin" }).then(function (r) { return readJsonResponse(r, "读取 CSRF"); }).then(function (r) { return r && r.token ? r.token : ""; }).catch(function () { return ""; });
	return dshCsrf[base];
}
function detectApiBase() {
	if (sakerApiBase) return Promise.resolve(sakerApiBase);
	var index = 0;
	function next() {
		if (index >= SAKER_API_BASES.length) throw Error("Saker 接口不可用：CSRF 获取失败");
		var base = SAKER_API_BASES[index++];
		return fetch(base + "/csrf", { credentials: "same-origin" }).then(function (r) {
			if (!r.ok) return next();
			return readJsonResponse(r, "探测 Saker 接口").then(function (json) {
				if (!json || !json.token) return next();
				sakerApiBase = base;
				dshCsrf[base] = Promise.resolve(json.token);
				return base;
			});
		}).catch(function () { return next(); });
	}
	return Promise.resolve().then(next);
}
function postJson(tok, endpoint, payload) {
	return fetch((sakerApiBase || SAKER_API_BASES[0]) + "/" + endpoint, {
		method: "POST",
		headers: tok ? { "content-type": "application/json", "x-dsh-csrf": tok } : { "content-type": "application/json" },
		credentials: "same-origin",
		body: JSON.stringify(payload || {})
	});
}
function api(endpoint, payload) {
	return detectApiBase().then(function (base) {
		return csrfOf(base).then(function (tok) {
			return postJson(tok, endpoint, payload).then(function (r) {
				if (r.status === 403) {
					delete dshCsrf[base];
					return csrfOf(base).then(function (tok2) { return postJson(tok2, endpoint, payload); }).then(function (r2) { return readJsonResponse(r2, "Saker " + endpoint); });
				}
				return readJsonResponse(r, "Saker " + endpoint);
			});
		});
	});
}

var MODES = [
	{ id: "pentest", label: "渗透测试模式" },
	{ id: "code-audit", label: "代码审计模式" }
];
var SEVERITY_LABEL = { critical: "严重", high: "高危", medium: "中危", low: "低危" };
var SEVERITY_ORDER = ["critical", "high", "medium", "low"];
var SECOND_RATING_LIST = ["critical", "high", "medium", "low", "info"];
/** 严重度刻度（与服务端 RATING_SCALE 同源）：info 低于 low。 */
var RATING_SCALE_C = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
/** 两次评级的比对结论：unrated / match / downgrade / upgrade。 */
function ratingVerdict(f) {
	if (!f.secondRating || !(f.secondRating in RATING_SCALE_C) || !(f.severity in RATING_SCALE_C)) return "unrated";
	var a = RATING_SCALE_C[f.severity], b = RATING_SCALE_C[f.secondRating];
	return b === a ? "match" : (b < a ? "downgrade" : "upgrade");
}
function verdictSuffix(f) {
	var v = ratingVerdict(f);
	if (v === "downgrade") return "（低于首次 " + f.severity + "，报告标注不一致）";
	if (v === "upgrade") return "（高于首次 " + f.severity + "）";
	if (v === "match") return "（与首次 " + f.severity + " 一致）";
	return "";
}
// 状态词表按 v6 第 5.3 节的叫法：待核实 / 已确认；其余稳定值（代码侧已复核、疑似、误报、已修复）保留。
// 只改显示，store 里的稳定值不变，也不动数据库迁移。
var STATUS_LABEL = { pending: "待核实", "code-reviewed": "代码侧已复核", suspect: "疑似·未定论", verified: "已确认", "false-positive": "误报", fixed: "已修复" };
var EVIDENCE_LABEL = { impact: "影响已证", confirmed: "已证实", partial: "部分证据", unknown: "未知" };
var SOURCE_LABEL = { manual: "人工深审", "scan-confirmed": "扫描确认", "scan-false-positive": "扫描误报" };
var AUDIT_MODE_LABEL = { static: "静态审计", dynamic: "动态·验证成功" };
// 板式二分：findings=漏洞报告型（渗透/代审）；assets=产物/战果清单型（二进制/攻防/免杀）。
var MODE_META = {
	pentest: {
		archetype: "findings", label: "渗透测试", pocTitle: "测试过程 / 复现 EXP", groupLabel: "按目标分组",
		empty: "本会话暂无渗透测试成果。", allName: "pentest-findings-", reportName: "pentest-report-",
		tableTitle: "渗透测试成果清单", typeLabel: "类型分布", metaLabels: ["渗透范围", "版本/环境", "授权范围"]
	},
	"code-audit": {
		archetype: "findings", label: "代码审计", pocTitle: "复现条件 / 利用前提", groupLabel: "按文件/sink 分组",
		empty: "本会话暂无代码审计成果。", allName: "audit-findings-", reportName: "audit-report-",
		tableTitle: "代码审计成果清单", typeLabel: "RCE 主线分布", metaLabels: ["审计对象", "版本/commit", "审计范围"]
	},
	"binary-analysis": {
		archetype: "assets", label: "二进制分析", kindLabel: "产物类型", locLabel: "产物位置（路径）",
		descLabel: "内容 / 说明", chainLabel: "来源链路（怎么产出）", pocTitle: "使用 / 复现方法",
		groupLabel: "按样本分组", empty: "本会话暂无二进制分析产物。",
		allName: "binary-artifacts-", reportName: "binary-artifact-", tableTitle: "二进制分析产物清单",
		typeLabel: "产物类型分布", metaLabels: ["样本来源/任务", "环境与工具", "分析范围"],
		kinds: "脱壳还原二进制 / 反编译源码 / 提取配置 / 提取密钥(Key) / C2 配置 / 提取载荷 / 修复样本 / 脚本工具 / IOC 集 / YARA 规则"
	},
	"attack-defense": {
		archetype: "assets", label: "攻防评估", kindLabel: "战果类型", locLabel: "目标 / 位置",
		descLabel: "内容摘要（凭据 / 数据 / 权限）", chainLabel: "获取路径（怎么拿到的）", pocTitle: "利用 / 使用方法",
		groupLabel: "按目标分组", empty: "本会话暂无攻防评估战果。",
		allName: "ad-loot-", reportName: "ad-loot-", tableTitle: "攻防评估战果清单",
		typeLabel: "战果类型分布", metaLabels: ["评估范围", "环境", "授权"],
		kinds: "入口点 / 数据读取成果 / 凭据·密码本 / 哈希集(hash map) / 横向立足点 / 域控成果 / Webshell 部署 / 持久化项 / 内网资产 / 检测gap"
	},
	redteam: {
		archetype: "ledger", label: "研究员模式", kindLabel: "任务形态", locLabel: "任务对象 / 范围",
		descLabel: "结论摘要", chainLabel: "处理路径（怎么做 / 路由到哪）", pocTitle: "下一步行动",
		groupLabel: "按形态分组", empty: "本会话任务台账为空——研究员模式的产物就是台账（任务×状态×结论×证据等级×下一步）。",
		allName: "redteam-ledger-", reportName: "redteam-task-", tableTitle: "研究员任务台账",
		typeLabel: "任务形态分布", metaLabels: ["任务范围", "环境", "授权"],
		kinds: "A 浅层直做 / B 专业路由 / C 多任务协同"
	},
	"av-evasion": {
		archetype: "assets", label: "免杀对抗", kindLabel: "交付物类型", locLabel: "产物路径",
		descLabel: "说明（构建 / 效果）", chainLabel: "构建 / 改造链路", pocTitle: "使用方法与效果",
		groupLabel: "按技术分组", empty: "本会话暂无免杀交付物。",
		allName: "av-deliverables-", reportName: "av-deliverable-", tableTitle: "免杀对抗交付物清单",
		typeLabel: "交付物类型分布", metaLabels: ["实验课题", "测试环境", "边界"],
		kinds: "Webshell（可用） / 免杀二进制 / 加载器 / C2 二开 / 变形脚本 / 测试效果记录 / 检测规则（配对）"
	},
	"incident-response": {
		archetype: "timeline", label: "应急溯源", kindLabel: "节点类型", locLabel: "主机 / 路径",
		descLabel: "节点描述", chainLabel: "取证过程（怎么证实）", pocTitle: "取证过程 / 检测命令",
		groupLabel: "按节点类型分组", empty: "本会话暂无攻击链节点——应急模式的产物是时间线（时间节点×可疑IP×事件×证据）。",
		allName: "ir-timeline-", reportName: "ir-node-", tableTitle: "攻击链时间线",
		typeLabel: "节点类型分布", metaLabels: ["调查对象", "环境", "范围"],
		kinds: "入口点 / 执行 / 持久化 / 横向 / 数据外传 / 影响 / 处置清理 / 其他"
	},
	"cloud-security": {
		archetype: "cloudpath", label: "云安全攻防", kindLabel: "路径类型", locLabel: "目标资源",
		descLabel: "影响证明（拿到什么）", chainLabel: "路径链（入口→身份→权限→资源）", pocTitle: "复现过程",
		groupLabel: "按路径类型分组", empty: "本会话暂无攻击路径——云安全模式的产物是攻击路径（入口凭证→身份→权限→资源→影响证明）。",
		allName: "cloud-paths-", reportName: "cloud-path-", tableTitle: "云攻击路径清单",
		typeLabel: "路径类型分布", metaLabels: ["目标", "环境", "范围"],
		kinds: "凭证泄露利用 / 元数据服务 / 对象存储 / 云数据库 / 权限提升 / 容器逃逸 / K8s 集群 / Serverless / CI-CD / 横向 / 持久化 / 其他"
	},
	"ctf-solver": {
		archetype: "ledger", label: "CTF 解题", kindLabel: "题目模块", locLabel: "题目 URL / 附件",
		descLabel: "解题结论（已解+分值 / 未解+卡点）", chainLabel: "解题路径（怎么解的）", pocTitle: "下一步行动",
		groupLabel: "按模块分组", empty: "本会话暂无赛题——CTF 模式的产物是解题台账（题×模块×状态×flag 验证证据×下一步）。",
		allName: "ctf-ledger-", reportName: "ctf-challenge-", tableTitle: "CTF 解题台账",
		typeLabel: "模块分布", metaLabels: ["赛名", "环境", "范围"],
		kinds: "web / pwn / reverse / crypto / misc / forensics / mobile / cloud / AI / AD / 供应链 / 其他"
	}
};
var ASSET_STATUS_LABEL = { pending: "待验证", verified: "有效·已验证", "false-positive": "已失效", fixed: "已交付" };
var AV_STATUS_LABEL = { pending: "在验", verified: "过检", detected: "被检出", "false-positive": "已失效", fixed: "已交付" };
var BIN_STATUS_LABEL = { pending: "分析中", suspect: "疑似", verified: "已定论", "false-positive": "已失效", fixed: "已归档" };
var STATUS_OPTIONS_OF = {
	"av-evasion": ["pending", "verified", "detected"],
	"ctf-solver": ["pending", "stuck", "verified"],
	"binary-analysis": ["pending", "suspect", "verified"],
	"attack-defense": ["pending", "verified", "false-positive", "fixed"],
	"cloud-security": ["pending", "verified", "false-positive", "fixed"],
	"pentest": ["pending", "suspect", "verified", "false-positive", "fixed"],
	"code-audit": ["pending", "code-reviewed", "suspect", "verified", "false-positive", "fixed"]
};
var LEDGER_STATUS_LABEL = { pending: "进行中", verified: "已验证", "false-positive": "挂起", fixed: "已路由" };
var CTF_STATUS_LABEL = { pending: "未解", stuck: "卡点", verified: "已解·flag 验证", "false-positive": "放弃/排除", fixed: "已复盘" };
var TIMELINE_STATUS_LABEL = { pending: "待复核", "code-reviewed": "复核通过", verified: "已证实", "false-positive": "排除", fixed: "已处置" };
var CLOUDPATH_STATUS_LABEL = { pending: "待验证", verified: "已证实", "false-positive": "排除", fixed: "已修复" };

function fmtTime(iso) {
	if (!iso) return "";
	var d = new Date(iso);
	if (isNaN(d.getTime())) return String(iso).replace("T", " ").slice(0, 16);
	var p = function (n) { return (n < 10 ? "0" : "") + n; };
	return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}
function localDate() { var d = new Date(); var p = function (n) { return (n < 10 ? "0" : "") + n; }; return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); }
function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function fmtTimelineAt(v) {
	var s = String(v == null ? "" : v).trim();
	if (!s || s === "unknown" || s === "Unknown") return "时间未知";
	return s.indexOf("T") >= 0 ? fmtTime(s) : s;
}
function timelineKey(v) {
	var s = String(v == null ? "" : v).trim();
	if (!s || s === "unknown" || s === "Unknown") return null;
	var n = Date.parse(s);
	return isNaN(n) ? s : n;
}
function cmpTimeline(a, b) {
	var av = timelineKey(a.timelineAt), bv = timelineKey(b.timelineAt);
	if (av === null && bv === null) return b.seq - a.seq;
	if (av === null) return 1;
	if (bv === null) return -1;
	if (typeof av === "number" && typeof bv === "number") return av - bv;
	if (typeof av === "number") return -1;
	if (typeof bv === "number") return 1;
	return av < bv ? -1 : av > bv ? 1 : b.seq - a.seq;
}
function statusLabelSetFor(archetype, mode) {
	if (mode === "ctf-solver") return CTF_STATUS_LABEL;
	if (mode === "av-evasion") return AV_STATUS_LABEL;
	if (mode === "binary-analysis") return BIN_STATUS_LABEL;
	return archetype === "assets" ? ASSET_STATUS_LABEL : archetype === "ledger" ? LEDGER_STATUS_LABEL : archetype === "timeline" ? TIMELINE_STATUS_LABEL : archetype === "cloudpath" ? CLOUDPATH_STATUS_LABEL : STATUS_LABEL;
}
function statusTextFor(f, mode, labelSet) {
	if (mode === "pentest" && f.status === "verified" && (!f.delivery || !f.delivery.ready)) return "需重新验证";
	if (mode === "code-audit" && f.status === "pending" && f.auditMode !== "dynamic") return "待动态验证";
	return labelSet[f.status] || f.status;
}
function findingSummary(f) {
	if (f.status === 'false-positive') return '已排除，未计入确认漏洞。';
	if (f.status === 'fixed') return '已标记为修复，复测记录见详情。';
	if (f.delivery?.ready) return '已验证，已保存请求、响应和复现步骤。';
	var reason = [f.executionEvidence?.reason, f.executionEvidence?.impactReason].filter(Boolean).join(' ');
	if (reason.includes('不匹配') || reason.includes('已失效')) return '上次验证与当前请求、身份或目标实例不匹配，需要重新验证。';
	var gaps = f.delivery?.gaps || [];
	if (gaps.includes('request-response-evidence-missing')) return '还缺测试时的请求或响应。';
	if (gaps.includes('request-response-evidence-invalid')) return '保存的请求或响应与测试地址不符，需要核对。';
	if (gaps.includes('host-execution-evidence-missing')) return '还没有有效的验证记录，暂不能确认漏洞。';
	if (gaps.includes('independent-impact-verification-missing')) return '还需验证是否能实际读取、修改数据或执行代码。';
	if (gaps.includes('complete-reproduction-missing')) return '还缺可重复执行的测试步骤。';
	if (gaps.includes('reproduction-not-executed')) return '已有测试步骤，还没有执行复测。';
	return '尚未确认是否存在漏洞，详细记录见下方。';
}

function download(name, text, mime) {
	var blob = new Blob([text], { type: (mime || "text/markdown") + ";charset=utf-8" });
	var url = URL.createObjectURL(blob);
	var a = document.createElement("a");
	a.href = url; a.download = name;
	document.body.appendChild(a); a.click(); a.remove();
	setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}
function downloadArchive(name, base64) {
	var raw = atob(base64), bytes = new Uint8Array(raw.length);
	for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
	download(name, bytes, 'application/zip');
}

//#region 导出生成器（MD 报告 / MD 总览 / MD 表格 / HTML 报告包）

// 报告导出前自动遮蔽秘密（v6 第 9.2 节）：账号凭据不随交付物外流。
// 页面里本地查看原文不受影响；这里只处理要导出/交付的文本。
function maskSecrets(text) {
	return String(text == null ? "" : text)
		.replace(/^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)\s*:[^\r\n]*/gim,
			function (line) { return line.split(":")[0] + ": [已遮蔽]"; })
		.replace(/("(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token)"\s*:\s*")[^"]*(")/gi,
			"$1[已遮蔽]$2");
}

function mdReport(f, mode) {
	var M = MODE_META[mode];
	if (M && M.archetype === "ledger") {
		return [
			"# 任务卡：" + f.title,
			"",
			"- 任务：" + f.title,
			"- " + M.kindLabel + "：" + (f.type || "未分类"),
			"- " + M.locLabel + "：" + (f.target || "（未填写）"),
			"- 状态：" + ((mode === "ctf-solver" ? CTF_STATUS_LABEL : LEDGER_STATUS_LABEL)[f.status] || f.status) + (mode === "ctf-solver" ? " ｜ 模块：" + (f.type || "-") : " ｜ 优先级：" + (SEVERITY_LABEL[f.severity] || f.severity)) + " ｜ 证据等级：" + (EVIDENCE_LABEL[f.evidenceLevel] || f.evidenceLevel),
			"- 登记时间：" + fmtTime(f.createdAt) + (f.verifiedAt ? " ｜ 验证时间：" + fmtTime(f.verifiedAt) : ""),
			"",
			"## " + M.descLabel,
			"",
			f.description || f.summary || "（未填写）",
			"",
			"## " + M.chainLabel,
			"",
			f.chain || "（未填写）",
			"",
			"## " + M.pocTitle,
			"",
			f.poc || "（未填写——收尾必给下一步）",
			f.evidence ? "\n## 任务书 / 材料路径\n\n" + f.evidence + "\n" : "",
			"",
			"## 复核记录",
			"",
			f.verifyNote || "（未复核）",
			""
		].join("\n");
	}
	if (M && M.archetype === "timeline") {
		return [
			"# 攻击链节点：" + f.title,
			"",
			"- 节点名：" + f.title,
			"- 攻击时间：" + (f.timelineAt || "unknown"),
			"- 节点类型：" + (f.type || "未分类"),
			"- 主机/路径：" + (f.target || "（未填写）"),
			"- 严重度：" + (SEVERITY_LABEL[f.severity] || f.severity),
			"- 证据等级：" + (EVIDENCE_LABEL[f.evidenceLevel] || f.evidenceLevel) + " ｜ 状态：" + (TIMELINE_STATUS_LABEL[f.status] || f.status),
			"- 证据引用：" + (f.evidence || "（未填写）"),
			"",
			"## 取证过程 / 检测命令",
			"",
			f.poc || "（未填写）",
			"",
			"## 节点描述",
			"",
			f.description || "（未填写）",
			"",
			"## 结论",
			"",
			f.summary || f.description || "（未填写）",
			""
		].join("\n");
	}
	if (M && M.archetype === "cloudpath") {
		return [
			"# 云攻击路径：" + f.title,
			"",
			"- 路径名：" + f.title,
			"- 路径类型：" + (f.type || "未分类"),
			"- 目标资源：" + (f.target || f.resource || "（未填写）"),
			"- 严重度：" + (SEVERITY_LABEL[f.severity] || f.severity),
			"- 证据等级：" + (EVIDENCE_LABEL[f.evidenceLevel] || f.evidenceLevel) + " ｜ 状态：" + (CLOUDPATH_STATUS_LABEL[f.status] || f.status),
			"",
			"## 攻击路径链（四要素）",
			"",
			"1. 入口凭证/身份：" + (f.entry || "（未填写）"),
			"2. 利用身份：" + (f.identity || "（未填写）"),
			"3. 权限：" + (f.permission || "（未填写）"),
			"4. 目标资源：" + (f.resource || f.target || "（未填写）"),
			"",
			"## 影响证明（拿到什么）",
			"",
			f.impact || f.description || "（未填写）",
			"",
			"## 复现过程",
			"",
			f.poc || "（未填写）",
			f.evidence ? "\n## 证据引用\n\n" + f.evidence + "\n" : "",
			"",
			"## 结论与复核",
			"",
			f.summary || f.description || "（未填写）",
			"- 复核注记：" + (f.verifyNote || "（未复核）"),
			""
		].join("\n");
	}
	if (mode === "binary-analysis") { // 二进制专属报告分支——须在 assets 通用分支之前（binary 的 archetype=assets，否则被遮蔽成死代码）
		return [
			"# 二进制分析报告：" + f.title,
			"",
			"- 结论标题：" + f.title,
			"- 产物类型：" + (f.type || "未分类"),
			"- 样本：" + (f.target || "（未填写）") + (f.sampleHash ? "（SHA256: " + f.sampleHash + "）" : ""),
			"- 家族/变种：" + (f.family || "未知/未定"),
			"- 壳/保护：" + (f.packer || "未识别"),
			"- 分析结论：" + (BIN_STATUS_LABEL[f.status] || f.status) + " ｜ 证据等级：" + (EVIDENCE_LABEL[f.evidenceLevel] || f.evidenceLevel),
			"",
			"## 定性依据（结论摘要）",
			"",
			f.description || f.summary || "（未填写）",
			"",
			"## 执行链 / 还原链路",
			"",
			f.chain || "（未填写——如 loader → 解密 → OEP → dump、或 APK 壳 → dex 还原路径）",
			"",
			"## 能力与危害",
			"",
			f.impact || "（未填写——窃取/持久化/横向/破坏能力与影响范围）",
			"",
			"## IOC 清单",
			"",
			f.iocs || "（未提取）",
			"",
			"## 检测规则（YARA/Sigma）",
			"",
			f.detectionRule ? "```yara\n" + f.detectionRule + "\n```" : "（未产出）",
			"",
			"## 复现 / 验证步骤",
			"",
			f.poc || "（未填写——动态复现步骤或破解复现脚本）",
			"",
			"## 处置建议",
			"",
			f.fix || "（未填写）",
			f.retestNote ? "\n## 复测记录\n\n" + f.retestNote + (f.retestAt ? "（" + fmtTime(f.retestAt) + "）" : "") + "\n" : "",
			"",
			"## 证据与复核",
			"",
			"- 证据引用：" + (f.evidence || "（未填写；含 provenance 登记）"),
			"- 复核注记：" + (f.verifyNote || "（未复核）") + (f.verifiedAt ? "（验证时间 " + fmtTime(f.verifiedAt) + "）" : ""),
			""
		].join("\n");
	}
	if (M && M.archetype === "assets") {
		return [
			"# " + M.label + "资产卡片：" + f.title,
			"",
			"- 名称：" + f.title,
			"- " + M.kindLabel + "：" + (f.type || "未分类"),
			"- " + M.locLabel + "：" + (f.target || "（未填写）") + (f.sampleHash ? "（关联样本 " + f.sampleHash.slice(0, 12) + "…）" : ""),
			f.family ? "- 家族/变种：" + f.family : "",
			f.packer ? "- 壳/保护：" + f.packer : "",
			"- 状态：" + ((mode === "av-evasion" ? AV_STATUS_LABEL : mode === "binary-analysis" ? BIN_STATUS_LABEL : ASSET_STATUS_LABEL)[f.status] || f.status) + " ｜ 证据等级：" + (EVIDENCE_LABEL[f.evidenceLevel] || f.evidenceLevel),
			"- 登记时间：" + fmtTime(f.createdAt) + (f.verifiedAt ? " ｜ 验证时间：" + fmtTime(f.verifiedAt) : ""),
			"",
			"## " + M.descLabel,
			"",
			f.description || f.summary || "（未填写）",
			"",
			"## " + M.chainLabel,
			"",
			f.chain || "（未填写）",
			"",
			"## " + M.pocTitle,
			"",
			f.poc || "（未填写）",
			mode === "attack-defense" && f.impact ? "- 影响证明：" + f.impact : "",
			mode === "attack-defense" && (f.baseline || f.diffEvidence || f.markerEcho) ? "\n## 对照三件套\n\n- 基线：" + (f.baseline || "（未填）") + "\n- 差分（翻转）：" + (f.diffEvidence || "（未填）") + "\n- marker 回显：" + (f.markerEcho || "（未填）") + "\n" : "",
			mode === "attack-defense" && f.requestPkt ? "\n## 完整请求包\n\n```\n" + maskSecrets(f.requestPkt) + "\n```\n" : "",
			mode === "attack-defense" && f.responsePkt ? "\n## 关键响应\n\n```\n" + maskSecrets(f.responsePkt) + "\n```\n" : "",
			f.iocs ? "\n## IOC / 环境结果清单\n\n" + f.iocs + "\n" : "",
			f.detectionRule ? "\n## 检测规则（YARA/Sigma）\n\n```yara\n" + f.detectionRule + "\n```\n" : "",
			"",
			"## 验证记录",
			"",
			"- 证据引用：" + (f.evidence || "（未填写）"),
			"- 复核注记：" + (f.verifyNote || "（未复核）"),
			""
		].filter(function (s) { return s !== ""; }).join("\n");
	}
	if (mode === "code-audit") {
		return [
			"# 代码审计问题报告：" + f.title,
			"",
			"- 问题名称：" + f.title,
			"- 问题描述（成因与影响）：" + (f.description || f.summary || "（未填写）"),
			"- 问题等级：" + (SEVERITY_LABEL[f.severity] || f.severity) + (f.cvss ? "（" + f.cvss + "）" : ""),
			"- 问题类型 / RCE 主线归类：" + (f.type || "未分类") + (f.cwe ? " / " + f.cwe : ""),
			"- 问题所在代码位置（sink 点）：" + (f.target || "（未填写）"),
			"- 审计形态：" + (AUDIT_MODE_LABEL[f.auditMode] || "未标注（默认静态语义）"),
			"- 证据等级：" + (EVIDENCE_LABEL[f.evidenceLevel] || f.evidenceLevel) + " ｜ 状态：" + statusTextForExport(f, mode) + " ｜ 来源：" + (SOURCE_LABEL[f.sourceOrigin] || f.sourceOrigin),
			"",
			"## 审计链路（entry → sink）",
			"",
			f.chain || "（未填写——组合/复杂漏洞应给出完整链路，每行一链）",
			"",
			"## 双链对照",
			"",
			"### 审计工人链",
			"",
			f.chain || "（未填写）",
			"",
			"### 追踪员链（独立重追）",
			"",
			f.chainTracer || "（未填写）",
			"",
			"### 一致性结论",
			"",
			f.chainVerdict || "（未对照）",
			"",
			"## 关键代码",
			"",
			f.snippetEntry ? "入口（entry）：" : "",
			f.snippetEntry || "",
			f.snippetEntry ? "\n" : "",
			f.snippetSink ? "危险点（sink）：" : "",
			f.snippetSink || "",
			"",
			"## 复现条件 / 利用前提",
			"",
			f.poc || "（未填写）",
			"",
			"## 修复建议",
			"",
			f.fix || "（未填写）",
			f.patch ? "\n### 修复 diff 建议\n\n```diff\n" + f.patch + "\n```\n" : "",
			"",
			"## 证据与复核",
			"",
			"- 双链比对记录：" + (f.evidence || "（未填写）"),
			"- 复核注记：" + (f.verifyNote || "（未复核）") + (f.verifiedAt ? "（验证时间 " + fmtTime(f.verifiedAt) + "）" : ""),
			""
		].join("\n");
	}
	return [
		"# 渗透测试漏洞报告：" + f.title,
		"",
		"- 漏洞/问题 名称：" + f.title,
		"- 漏洞/问题 描述：" + (f.description || f.summary || "（未填写）"),
		"- 漏洞/问题 等级：" + (SEVERITY_LABEL[f.severity] || f.severity) + (f.type ? "（" + f.type + "）" : "") + (f.cvss ? " ｜ " + f.cvss : ""),
		"- 漏洞/问题 地址：" + (f.target || "（未填写）"),
		"- 证据等级：" + (EVIDENCE_LABEL[f.evidenceLevel] || f.evidenceLevel) + " ｜ 状态：" + (STATUS_LABEL[f.status] || f.status),
		"",
		"## 影响证明",
		"",
		f.impact || "（未填写——发现+验证=真实有效：拿到什么数据/执行到什么程度）",
		"",
		"## 对照三件套",
		"",
		"- 基线（正常请求）：" + (f.baseline || "（未填写）"),
		"- 差分（注入后翻转）：" + (f.diffEvidence || "（未填写）"),
		"- marker 逐字回显：" + (f.markerEcho || "（未填写）"),
		"",
		"## 测试过程",
		"",
		f.poc || f.description || "（未填写）",
		"",
		f.requestPkt ? "### 完整请求包\n\n```\n" + maskSecrets(f.requestPkt) + "\n```\n" : "",
		f.responsePkt ? "### 关键响应\n\n```\n" + maskSecrets(f.responsePkt) + "\n```\n" : "",
		"## 修复建议",
		"",
		f.fix || "（未填写）",
		f.retestNote ? "\n## 复测记录\n\n" + f.retestNote + (f.retestAt ? "（" + fmtTime(f.retestAt) + "）" : "") + "\n" : "",
		""
	].join("\n");
}

function jsonReport(meta, stats, rows, mode) {
	return JSON.stringify({
		schema: "saker.redteam.report.v1",
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		mode: mode,
		meta: meta || null,
		stats: stats || null,
		// 交付用 JSON 同样遮蔽秘密（v6 第 9.2 节）；页面本地查看不受影响。
		findings: (rows || []).map(function (row) {
			return Object.assign({}, row, {
				requestPkt: row && row.requestPkt ? maskSecrets(row.requestPkt) : row && row.requestPkt,
				responsePkt: row && row.responsePkt ? maskSecrets(row.responsePkt) : row && row.responsePkt
			});
		})
	}, null, 2) + "\n";
}

function mdOverview(meta, stats, rows, mode) {
	if (MODE_META[mode] && MODE_META[mode].archetype === "timeline") {
		var chrono = rows.slice().sort(cmpTimeline);
		var typeLines = (stats.byType || []).map(function (t) { return "- " + t.type + " × " + t.count; });
		var hostLines = (stats.byTarget || []).map(function (t) { return "- " + t.target + " × " + t.count; });
		var sevLine = SEVERITY_ORDER.map(function (s) { return SEVERITY_LABEL[s] + " " + (stats.bySeverity[s] || 0); }).join(" / ");
		var lines = [
			"# 攻击链还原总览（应急溯源）",
			"",
			"- 调查对象：" + (meta.targetLabel || "（未填写）"),
			"- 环境：" + (meta.version || "（未填写）") + " ｜ 范围：" + (meta.scope || "（未填写）"),
			"- 节点总数：" + stats.total,
			"- 严重度统计：" + sevLine,
			"",
			"## 节点类型分布",
			""
		].concat(typeLines.length ? typeLines : ["（无）"]);
		lines.push("", "## 主机分布", "");
		lines = lines.concat(hostLines.length ? hostLines : ["（无）"]);
		lines.push("", "## 攻击时间线（按时间排序）", "");
		if (chrono.length === 0) lines.push("（无）");
		lines = lines.concat(chrono.map(function (f, i) {
			return (i + 1) + ". [" + (f.timelineAt || "unknown") + "] " + (f.type || "未分类") + " · " + f.title + "（" + (f.target || "无主机") + "，严重度 " + (SEVERITY_LABEL[f.severity] || f.severity) + "）";
		}));
		lines.push("", "## 处置建议", "", "按时间线逐节点复核取证过程与证据引用，还原入口点→执行→持久化→横向→数据外传的完整攻击链；未证实（待复核）节点优先补证据，已排除/已处置节点标明结论。", "");
		return lines.join("\n");
	}
	if (MODE_META[mode] && MODE_META[mode].archetype === "cloudpath") {
		var sorted2 = rows.slice().sort(function (a, b) { return SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity); });
		var typeLines2 = (stats.byType || []).map(function (t) { return "- " + t.type + " × " + t.count; });
		var resLines = (stats.byTarget || []).map(function (t) { return "- " + t.target + " × " + t.count; });
		var sevLine2 = SEVERITY_ORDER.map(function (s) { return SEVERITY_LABEL[s] + " " + (stats.bySeverity[s] || 0); }).join(" / ");
		var lines2 = [
			"# 云攻击路径总览（云安全攻防）",
			"",
			"- 目标：" + (meta.targetLabel || "（未填写）"),
			"- 环境：" + (meta.version || "（未填写）") + " ｜ 范围：" + (meta.scope || "（未填写）"),
			"- 路径总数：" + stats.total,
			"- 严重度统计：" + sevLine2,
			"",
			"## 路径类型分布",
			""
		].concat(typeLines2.length ? typeLines2 : ["（无）"]);
		lines2.push("", "## 目标资源分布", "");
		lines2 = lines2.concat(resLines.length ? resLines : ["（无）"]);
		lines2.push("", "## 攻击路径清单（按严重度排序）", "");
		if (sorted2.length === 0) lines2.push("（无）");
		lines2 = lines2.concat(sorted2.map(function (f, i) {
			return (i + 1) + ". [" + (SEVERITY_LABEL[f.severity] || f.severity) + "] " + f.title + "（" + (f.type || "未分类") + "，资源 " + (f.resource || f.target || "无") + "）" + (f.summary ? " — " + f.summary : "");
		}));
		lines2.push("", "## 复核建议", "", "逐路径复核四要素证据（入口/身份/权限/资源）与影响证明，未验证路径优先补证据；已排除/已修复路径标明结论。", "");
		return lines2.join("\n");
	}
	var label = MODE_META[mode] ? MODE_META[mode].label : mode;
	var assetView = MODE_META[mode] && MODE_META[mode].archetype === "assets";
	var isCtf = mode === "ctf-solver";
	var sorted = isCtf
		? rows.slice().sort(function (a, b) { return ["stuck", "pending", "verified"].indexOf(a.status) - ["stuck", "pending", "verified"].indexOf(b.status); })
		: rows.slice().sort(function (a, b) { return SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity); });
	var top3 = sorted.slice(0, 3);
	var lines = [
		"# " + label + "总览报告",
		"",
		"- 对象/范围：" + (meta.targetLabel || "（未填写）"),
		"- 版本：" + (meta.version || "（未填写）") + " ｜ scope：" + (meta.scope || "（未填写）"),
		LABEL_BY_TYPE_MODES[mode] ? "- 成果总数：" + stats.total : "- 成果总数：" + stats.total + "（严重 " + (stats.bySeverity.critical || 0) + " / 高危 " + (stats.bySeverity.high || 0) + " / 中危 " + (stats.bySeverity.medium || 0) + " / 低危 " + (stats.bySeverity.low || 0) + "）",
		"- 状态分布：" + Object.keys(LABEL_BY_TYPE_MODES[mode] ? (mode === "av-evasion" ? AV_STATUS_LABEL : mode === "binary-analysis" ? BIN_STATUS_LABEL : mode === "attack-defense" ? ASSET_STATUS_LABEL : CTF_STATUS_LABEL) : STATUS_LABEL).map(function (s) { var set = LABEL_BY_TYPE_MODES[mode] ? (mode === "av-evasion" ? AV_STATUS_LABEL : mode === "binary-analysis" ? BIN_STATUS_LABEL : mode === "attack-defense" ? ASSET_STATUS_LABEL : CTF_STATUS_LABEL) : STATUS_LABEL; return (set[s] || s) + " " + (stats.byStatus[s] || 0); }).join(" / "),
		"",
		"## 总体结论",
		"",
		stats.total === 0 ? "本会话未登记成果。" : isCtf
			? "共 " + stats.total + " 道题，其中未解 " + (stats.byStatus.pending || 0) + " 项、卡点 " + (stats.byStatus.stuck || 0) + " 项（结论以 flag 验证状态为准）。"
			: "共 " + stats.total + " 项成果，其中待验证 " + (stats.byStatus.pending || 0) + " 项（结论以验证状态为准，未验证项按疑似处理）。",
		"",
		"## " + (assetView ? "Top-3 成果" : isCtf ? "Top-3 题目（未解/卡点优先）" : "Top-3 风险"),
		""
	];
	if (top3.length === 0) lines.push("（无）");
	top3.forEach(function (f) { lines.push("- [" + (LABEL_BY_TYPE_MODES[mode] ? (f.type || "未标注") : (SEVERITY_LABEL[f.severity] || f.severity)) + "] " + f.title + "（" + (f.target || "无地址") + "）" + (f.summary ? "—" + f.summary : "")); });
	lines.push("");
	lines.push("## " + (assetView ? "战果清单（交付/复测优先）" : isCtf ? "解题路线图（未解/卡点优先）" : "修复路线图（优先级从高到低）"));
	lines.push("");
	if (rows.length === 0) lines.push("（无）");
	sorted.forEach(function (f, i) {
		lines.push((i + 1) + ". [" + (LABEL_BY_TYPE_MODES[mode] ? (f.type || "未标注") : (SEVERITY_LABEL[f.severity] || f.severity)) + "] " + f.title + (f.fix ? "——" + f.fix.slice(0, 80) : ""));
	});
	lines.push("");
	return lines.join("\n");
}

function mdTable(rows, title, mode) {
	var audit = mode === "code-audit";
	var M = MODE_META[mode];
	var isAsset = M && M.archetype === "assets";
	var isLedger = M && M.archetype === "ledger";
	var isTimeline = M && M.archetype === "timeline";
	var isCloudpath = M && M.archetype === "cloudpath";
	var isCtf = mode === "ctf-solver";
	var head = isCloudpath
		? "| # | 路径 | 类型 | 入口 | 身份 | 权限 | 资源 | 严重度 | 影响证明 |"
		: isCtf
		? "| # | 任务 | 模块 | 题目地址 | 状态 | 证据等级 | 结论摘要 | 解题材料 |"
		: isTimeline
		? "| # | 攻击时间 | 节点 | 类型 | 主机 | 严重度 | 证据 | 结论 |"
		: isLedger
		? "| # | 任务 | 形态 | 对象/范围 | 状态 | 优先级 | 证据等级 | 结论摘要 | 下一步 |"
		: isAsset
		? "| 序号 | 名称 | " + M.kindLabel + " | " + M.locLabel + " | 状态 | 说明 |"
		: audit
		? "| 序号 | 名称 | 等级 | 主线类型 | CWE | sink 位置 | 状态 | 来源 | 简介 |"
		: "| 序号 | 名称 | 等级 | 类型 | CVSS | 地址 | 状态 | 简介 |";
	var sep = isCloudpath ? "|---|---|---|---|---|---|---|---|---|" : isCtf ? "|---|---|---|---|---|---|---|---|" : isTimeline ? "|---|---|---|---|---|---|---|---|" : isLedger ? "|---|---|---|---|---|---|---|---|---|" : audit ? "|---|---|---|---|---|---|---|---|---|" : isAsset ? "|---|---|---|---|---|---|" : "|---|---|---|---|---|---|---|---|";
	var body = rows.map(function (f) {
		var cells = isCloudpath
			? [f.seq, f.title, f.type || "-", (f.entry || "-").replace(/\|/g, "/").slice(0, 30), (f.identity || "-").replace(/\|/g, "/").slice(0, 30), (f.permission || "-").replace(/\|/g, "/").slice(0, 30), (f.resource || f.target || "-").replace(/\|/g, "/").slice(0, 40), SEVERITY_LABEL[f.severity] || f.severity, (f.impact || f.summary || "-").replace(/\|/g, "/").slice(0, 50)]
			: isCtf
			? [f.seq, f.title, f.type || "-", f.target || "-", CTF_STATUS_LABEL[f.status] || f.status, EVIDENCE_LABEL[f.evidenceLevel] || f.evidenceLevel, (f.summary || "-").replace(/\|/g, "/").slice(0, 50), (f.poc || "-").replace(/\|/g, "/").slice(0, 50)]
			: isTimeline
			? [f.seq, f.timelineAt || "unknown", f.title, f.type || "-", f.target || "-", SEVERITY_LABEL[f.severity] || f.severity, (f.evidence || "-").replace(/\|/g, "/").slice(0, 40), (f.summary || "-").replace(/\|/g, "/").slice(0, 50)]
			: isLedger
			? [f.seq, f.title, f.type || "-", f.target || "-", (mode === "ctf-solver" ? CTF_STATUS_LABEL : LEDGER_STATUS_LABEL)[f.status] || f.status, mode === "ctf-solver" ? (f.type || "-") : (SEVERITY_LABEL[f.severity] || f.severity), EVIDENCE_LABEL[f.evidenceLevel] || f.evidenceLevel, (f.summary || "-").replace(/\|/g, "/").slice(0, 50), (f.poc || "-").replace(/\|/g, "/").slice(0, 50)]
			: isAsset
			? [f.seq, f.title, f.type || "-", (f.target || "-") + (f.sampleHash ? " (" + f.sampleHash.slice(0, 8) + ")" : ""), (mode === "av-evasion" ? AV_STATUS_LABEL : mode === "binary-analysis" ? BIN_STATUS_LABEL : ASSET_STATUS_LABEL)[f.status] || f.status, (f.summary || f.description || "-").replace(/\|/g, "/").slice(0, 60)]
			: audit
			? [f.seq, f.title, SEVERITY_LABEL[f.severity] || f.severity, f.type || "-", f.cwe || "-", f.target || "-", statusTextForExport(f, mode), SOURCE_LABEL[f.sourceOrigin] || f.sourceOrigin, (f.summary || "-").replace(/\|/g, "/")]
			: [f.seq, f.title, SEVERITY_LABEL[f.severity] || f.severity, f.type || "-", f.cvss || "-", f.target || "-", STATUS_LABEL[f.status] || f.status, (f.summary || "-").replace(/\|/g, "/")];
		return "| " + cells.join(" | ") + " |";
	});
	return ["# " + (title || "成果清单"), "", head, sep].concat(body).concat([""]).join("\n");
}

/** 极简 MD→HTML：标题/列表/代码块（导出内联渲染足够）。 */
function toSimpleHtml(md) {
	var out = [];
	var inCode = false, inList = false;
	md.split("\n").forEach(function (line) {
		if (line.trim().slice(0, 3) === "```") {
			if (inList) { out.push("</ul>"); inList = false; }
			out.push(inCode ? "</pre>" : "<pre>");
			inCode = !inCode;
			return;
		}
		if (inCode) { out.push(esc(line)); return; }
		if (line.slice(0, 3) === "###") { if (inList) { out.push("</ul>"); inList = false; } out.push("<h3>" + esc(line.replace(/^#+\s*/, "")) + "</h3>"); return; }
		if (line.slice(0, 2) === "##") { if (inList) { out.push("</ul>"); inList = false; } out.push("<h2>" + esc(line.replace(/^#+\s*/, "")) + "</h2>"); return; }
		if (line.slice(0, 1) === "#") { if (inList) { out.push("</ul>"); inList = false; } out.push("<h2>" + esc(line.replace(/^#+\s*/, "")) + "</h2>"); return; }
		if (line.slice(0, 2) === "- ") { if (!inList) { out.push("<ul>"); inList = true; } out.push("<li>" + esc(line.slice(2)) + "</li>"); return; }
		if (/^\d+\.\s/.test(line)) { if (!inList) { out.push("<ul>"); inList = true; } out.push("<li>" + esc(line.replace(/^\d+\.\s*/, "")) + "</li>"); return; }
		if (line.trim() === "") { if (inList) { out.push("</ul>"); inList = false; } return; }
		if (inList) { out.push("</ul>"); inList = false; }
		out.push("<p>" + esc(line) + "</p>");
	});
	if (inList) out.push("</ul>");
	if (inCode) out.push("</pre>");
	return out.join("\n");
}

function htmlReport(meta, stats, rows, mode) {
	var label = MODE_META[mode] ? MODE_META[mode].label : mode;
	var sevColor = { critical: "#e5484d", high: "#e87d2e", medium: "#c2650a", low: "#3b7dd8" };
	var h = ['<!doctype html><html><head><meta charset="utf-8"><title>' + esc(label) + '报告</title><style>'];
	h.push('body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;background:#f6f7f9;color:#1a1a1a;line-height:1.65}');
	h.push('.page{max-width:880px;margin:0 auto;padding:40px 44px;background:#fff;min-height:100vh}');
	h.push('h1{font-size:24px;border-bottom:2px solid #1a1a1a;padding-bottom:10px}h2{font-size:17px;margin-top:34px;border-left:4px solid #4c6ef5;padding-left:10px}h3{font-size:14px;margin:18px 0 6px;color:#555}');
	h.push('.meta{color:#666;font-size:14px;margin:6px 0 2px}.card{border:1px solid #e5e5ea;border-radius:10px;padding:18px 20px;margin:18px 0;background:#fff}');
	h.push('.sev{display:inline-block;font-size:13px;font-weight:600;padding:2px 10px;border-radius:10px;color:#fff;margin-right:8px}');
	h.push('pre{background:#f4f4f6;border:1px solid #e9e9ec;border-radius:8px;padding:12px;white-space:pre-wrap;word-break:break-word;font-size:12.5px;overflow-x:auto}');
	h.push('table{border-collapse:collapse;width:100%;font-size:14px}td,th{border:1px solid #e5e5ea;padding:6px 10px;text-align:left}th{background:#f6f7f9}');
	h.push('</style></head><body><div class="page">');
	h.push('<h1>' + esc(label) + '报告</h1>');
	h.push('<p class="meta">' + esc(MODE_META[mode] ? MODE_META[mode].metaLabels[0] : "对象") + '：' + esc(meta.targetLabel || "—") + ' ｜ ' + esc(MODE_META[mode] ? MODE_META[mode].metaLabels[1] : "版本") + '：' + esc(meta.version || "—") + ' ｜ scope：' + esc(meta.scope || "—") + '</p>');
	var assetView = MODE_META[mode] && MODE_META[mode].archetype === "assets";
	var stSet = assetView ? (mode === "av-evasion" ? AV_STATUS_LABEL : mode === "binary-analysis" ? BIN_STATUS_LABEL : ASSET_STATUS_LABEL) : STATUS_LABEL;
	h.push(assetView
		? '<p class="meta">成果总数 ' + stats.total + '｜ 生成时间 ' + new Date().toLocaleString() + '</p>'
		: mode === "ctf-solver"
		? '<p class="meta">题目总数 ' + stats.total + '（未解 ' + (stats.byStatus.pending || 0) + ' / 卡点 ' + (stats.byStatus.stuck || 0) + ' / 已解 ' + (stats.byStatus.verified || 0) + '）｜ 生成时间 ' + new Date().toLocaleString() + '</p>'
		: '<p class="meta">总数 ' + stats.total + '（严重 ' + (stats.bySeverity.critical || 0) + ' / 高危 ' + (stats.bySeverity.high || 0) + ' / 中危 ' + (stats.bySeverity.medium || 0) + ' / 低危 ' + (stats.bySeverity.low || 0) + '）｜ 生成时间 ' + new Date().toLocaleString() + '</p>');
	h.push('<h2>成果清单</h2><table><tr>' + (mode === "code-audit" ? "<th>#</th><th>名称</th><th>等级</th><th>主线</th><th>CWE</th><th>sink</th><th>状态</th><th>来源</th>" : mode === "cloud-security" ? "<th>#</th><th>名称</th><th>等级</th><th>路径类型</th><th>目标资源</th><th>状态</th>" : mode === "ctf-solver" ? "<th>#</th><th>题目</th><th>模块</th><th>题目地址</th><th>状态</th>" : mode === "incident-response" ? "<th>#</th><th>节点</th><th>类型</th><th>主机</th><th>攻击时间</th><th>状态</th>" : assetView ? "<th>#</th><th>名称</th><th>类型</th><th>位置</th><th>状态</th>" : "<th>#</th><th>名称</th><th>等级</th><th>类型</th><th>地址</th><th>状态</th>") + '</tr>');
	rows.forEach(function (f) {
		h.push(mode === "cloud-security"
			? '<tr><td>' + f.seq + '</td><td>' + esc(f.title) + '</td><td><span class="sev" style="background:' + (sevColor[f.severity] || "#888") + '">' + esc(SEVERITY_LABEL[f.severity] || f.severity) + '</span></td><td>' + esc(f.type || "-") + '</td><td>' + esc(f.resource || f.target || "-") + '</td><td>' + esc(statusTextForExport(f, mode)) + '</td></tr>'
			: mode === "ctf-solver"
			? '<tr><td>' + f.seq + '</td><td>' + esc(f.title) + '</td><td>' + esc(f.type || "-") + '</td><td>' + esc(f.target || "-") + '</td><td>' + esc(statusTextForExport(f, mode)) + '</td></tr>'
			: mode === "incident-response"
			? '<tr><td>' + f.seq + '</td><td>' + esc(f.title) + '</td><td>' + esc(f.type || "-") + '</td><td>' + esc(f.target || "-") + '</td><td>' + esc(f.timelineAt || "-") + '</td><td>' + esc(statusTextForExport(f, mode)) + '</td></tr>'
			: assetView
			? '<tr><td>' + f.seq + '</td><td>' + esc(f.title) + '</td><td>' + esc(f.type || "-") + '</td><td>' + esc(f.target || "-") + '</td><td>' + esc(stSet[f.status] || f.status) + '</td></tr>'
			: '<tr><td>' + f.seq + '</td><td>' + esc(f.title) + '</td><td><span class="sev" style="background:' + (sevColor[f.severity] || "#888") + '">' + esc(SEVERITY_LABEL[f.severity] || f.severity) + '</span></td><td>' + esc(f.type || "-") + '</td>' + (mode === "code-audit" ? '<td>' + esc(f.cwe || "-") + '</td>' : '') + '<td>' + esc(f.target || "-") + '</td><td>' + esc(statusTextForExport(f, mode)) + '</td>' + (mode === "code-audit" ? '<td>' + esc(SOURCE_LABEL[f.sourceOrigin] || f.sourceOrigin || "manual") + '</td>' : '') + '</tr>');
	});
	h.push('</table>');
	rows.forEach(function (f) {
		h.push(assetView
			? '<div class="card"><h2>#' + f.seq + ' ' + esc(f.title) + ' <span class="sev" style="background:#3a7d5f">' + esc(f.type || (mode === "binary-analysis" ? "产物" : "战果")) + '</span></h2>'
			: mode === "ctf-solver"
			? '<div class="card"><h2>#' + f.seq + ' ' + esc(f.title) + ' <span class="sev" style="background:' + (f.status === "verified" ? "#3a7d5f" : f.status === "stuck" ? "#c2182f" : "#c2650a") + '">' + esc(CTF_STATUS_LABEL[f.status] || f.status) + '</span></h2>'
			: mode === "incident-response"
			? '<div class="card"><h2>#' + f.seq + ' ' + esc(f.title) + ' <span class="sev" style="background:' + (f.status === "verified" ? "#3a7d5f" : f.status === "fixed" ? "#3b7dd8" : f.status === "false-positive" ? "#8a8a8f" : "#c2650a") + '">' + esc(TIMELINE_STATUS_LABEL[f.status] || f.status) + '</span></h2>'
			: '<div class="card"><h2>#' + f.seq + ' ' + esc(f.title) + ' <span class="sev" style="background:' + (sevColor[f.severity] || "#888") + '">' + esc(SEVERITY_LABEL[f.severity] || f.severity) + '</span></h2>');
		h.push('<div class="md">' + toSimpleHtml(mdReport(f, mode)) + '</div></div>');
	});
	h.push('</div></body></html>');
	return h.join("\n");
}

//#endregion

//#region 样式


"".length; // noop
var CSS_SCREEN = [
	".dsh-rtr-screen{position:relative;height:100%;overflow:auto;width:100%;min-width:0;box-sizing:border-box;background:radial-gradient(900px 480px at 50% -10%,rgba(58,157,255,.10),transparent 60%),#050f1f;color:#e6f2ff;font-size:var(--dsh-content-font-size,1em)}",
	".dsh-rtr-screen::before{content:\"\";position:absolute;inset:0;pointer-events:none;background-image:linear-gradient(rgba(58,157,255,.08) 1px,transparent 1px),linear-gradient(90deg,rgba(58,157,255,.08) 1px,transparent 1px);background-size:40px 40px}",
	".dsh-rtr-screen::after{content:\"\"}",
	".dsh-scr-inner{position:relative;z-index:2;display:flex;flex-direction:column;gap:14px;container-type:inline-size;container-name:scrinner;padding:clamp(10px,1.6vw,20px) clamp(12px,1.8vw,24px) 26px;min-height:100%;box-sizing:border-box;max-width:1680px;margin:0 auto;width:100%}",
	".dsh-rtr-screen:fullscreen{width:100%;height:100%}",
	".dsh-rtr-screen:fullscreen .dsh-scr-inner{max-width:none;height:100%;min-height:0;gap:18px;padding:clamp(14px,2vh,26px) clamp(18px,2.4vw,36px) clamp(16px,2.6vh,30px)}",
	".dsh-rtr-screen:fullscreen .dsh-scr-header{padding:clamp(12px,1.8vh,20px) 26px}",
	".dsh-rtr-screen:fullscreen .dsh-scr-title{font-size:clamp(22px,2vw,30px)}",
	".dsh-rtr-screen:fullscreen .dsh-scr-clock{font-size:clamp(20px,1.6vw,26px)}",
	".dsh-rtr-screen:fullscreen .dsh-scr-hero{padding:clamp(8px,1.6vh,18px) 6px}",
	".dsh-rtr-screen:fullscreen .dsh-scr-num{padding:clamp(14px,2vh,22px) 14px 12px}",
	".dsh-rtr-screen:fullscreen .dsh-scr-num b{font-size:clamp(36px,3.2vw,52px)}",
	".dsh-rtr-screen:fullscreen .dsh-scr-num span{font-size:clamp(11px,1vw,14px)}",
	".dsh-rtr-screen:fullscreen .dsh-scr-globewrap{transform:scale(1.24)}",
	".dsh-rtr-screen:fullscreen .dsh-scr-grid{flex:1;min-height:0;grid-template-columns:minmax(260px,1.05fr) minmax(380px,2.3fr) minmax(280px,1.05fr)}",
	".dsh-rtr-screen:fullscreen .dsh-scr-grid>div{min-height:0;overflow-y:auto}",
	".dsh-rtr-screen:fullscreen .dsh-scr-grid>div>.dsh-scr-panel{min-height:0;overflow:auto}",
	".dsh-rtr-screen:fullscreen .dsh-scr-grid>div>.dsh-scr-panel:last-child{flex:1 1 auto}",
	".dsh-rtr-screen:fullscreen .dsh-scr-panel{padding:clamp(14px,1.8vh,20px) clamp(16px,1.4vw,22px)}",
	".dsh-rtr-screen:fullscreen .dsh-scr-panel h4{font-size:clamp(13px,1.05vw,16px);margin-bottom:clamp(8px,1vh,12px);padding-bottom:8px}",
	".dsh-rtr-screen:fullscreen .dsh-scr-bar{font-size:clamp(12px,1vw,14px);margin:clamp(3px,.6vh,7px) 0}",
	".dsh-rtr-screen:fullscreen .dsh-scr-bar .lbl{width:84px}",
	".dsh-rtr-screen:fullscreen .dsh-scr-bar .track{height:12px}",
	".dsh-rtr-screen:fullscreen .dsh-scr-bar .val{width:40px}",
	".dsh-rtr-screen:fullscreen .dsh-scr-b3d{font-size:clamp(10px,1.05vw,14px);height:clamp(170px,26vh,260px)}",
	".dsh-rtr-screen:fullscreen .dsh-scr-legend{font-size:clamp(11px,.95vw,13px)}",
	".dsh-rtr-screen:fullscreen .dsh-scr-table{font-size:clamp(12px,1vw,14px)}",
	".dsh-rtr-screen:fullscreen .dsh-scr-table th{padding:clamp(6px,1vh,10px) 10px;font-size:clamp(11px,.9vw,13px)}",
	".dsh-rtr-screen:fullscreen .dsh-scr-table td{padding:clamp(6px,1vh,11px) 10px}",
	".dsh-rtr-screen:fullscreen .dsh-scr-sev{font-size:clamp(11px,.9vw,13px)}",
	".dsh-rtr-screen:fullscreen .dsh-scr-empty{display:flex;align-items:center;justify-content:center;flex:1}",
	".dsh-scr-hleft{display:flex;align-items:center;gap:14px;min-width:0}",
	".dsh-scr-header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px 16px;min-width:0;padding:12px 24px;border:1px solid rgba(58,157,255,.45);border-radius:10px;background:rgba(10,30,60,.45);backdrop-filter:blur(10px);box-shadow:0 0 20px rgba(58,157,255,.15)}",
	".dsh-scr-title{font-size:22px;font-weight:700;letter-spacing:3px;background:linear-gradient(90deg,#7cc8ff,#ffffff,#7cc8ff);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:#7cc8ff}",
	".dsh-scr-title small{display:block;font-size:var(--dsh-content-font-size-secondary,0.93em);letter-spacing:4px;color:#8fb4d9;font-weight:600;margin-top:2px;-webkit-text-fill-color:#8fb4d9}",
	".dsh-scr-live{display:flex;align-items:center;gap:8px;font-size:var(--dsh-content-font-size,1em);color:#36f1b0;letter-spacing:1px}",
	".dsh-scr-dot{width:10px;height:10px;border-radius:50%;background:#36f1b0;box-shadow:0 0 8px #36f1b0;animation:dshPulse 2s ease-in-out infinite}",
	"@keyframes dshPulse{0%,100%{opacity:1}50%{opacity:.5}}",
	".dsh-scr-clock{font-family:monospace;font-size:22px;color:#3a9dff;letter-spacing:.08em}",
	".dsh-scr-grid{display:grid;grid-template-columns:minmax(180px,240px) minmax(260px,1fr) minmax(200px,250px);gap:14px;align-items:stretch;flex:1}",
	".dsh-scr-grid>div>.dsh-scr-panel:last-child{flex:1}",
	".dsh-scr-center,.dsh-scr-grid>div{min-width:0}",
	".dsh-scr-nums{grid-template-columns:repeat(auto-fit,minmax(110px,1fr))}",
	".dsh-scr-tablewrap{overflow:auto}",
	".dsh-scr-table{table-layout:fixed;width:100%}",
	".dsh-scr-table td,.dsh-scr-table th{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
	"@container scrinner (max-width:700px){.dsh-scr-grid{grid-template-columns:1fr}}",
	"@container scrinner (max-width:620px){.dsh-scr-nums{grid-template-columns:repeat(2,minmax(84px,1fr))}.dsh-scr-title{font-size:15px}.dsh-scr-clock{font-size:15px}}",
	"@container scrinner (max-width:460px){.dsh-scr-nums{grid-template-columns:repeat(auto-fit,minmax(72px,1fr))}.dsh-scr-bar .lbl{width:56px;font-size:var(--dsh-content-font-size-secondary,0.93em)}.dsh-scr-num b{font-size:24px}}",
	"@media (max-width:980px){.dsh-scr-grid{grid-template-columns:1fr}}",
	"@media (max-width:640px){.dsh-scr-nums{grid-template-columns:repeat(2,1fr)}.dsh-scr-title{font-size:15px}}",
	".dsh-scr-panel{position:relative;min-width:0;overflow:hidden;border:1px solid rgba(58,157,255,.45);border-radius:10px;background:rgba(10,30,60,.45);padding:16px 20px;backdrop-filter:blur(10px);box-shadow:0 0 15px rgba(58,157,255,.1)}",
	".dsh-scr-panel::before{content:\"\"}",
	".dsh-scr-panel::after{content:\"\"}",
	".dsh-scr-panel:hover{border-color:rgba(100,190,255,.65)}",
	".dsh-scr-num{transition:transform .3s,box-shadow .3s}",
	".dsh-scr-num:hover{transform:translateY(-2px);box-shadow:0 0 25px rgba(58,157,255,.25)}",
	".dsh-scr-num b{animation:none}",
	".dsh-scr-table tbody tr{transition:background .2s}",
	".dsh-scr-table tbody tr:hover td{background:rgba(56,190,255,.09)}",
	".dsh-scr-bar .track span{transition:width .6s ease}",
	".dsh-scr-hero{position:relative}",
	".dsh-scr-hero::after{content:\"\";position:absolute;left:6%;right:6%;bottom:-4px;height:1px;background:linear-gradient(90deg,transparent,rgba(70,190,255,.55),transparent)}",
	".dsh-scr-globewrap::before{content:\"\";position:absolute;left:-8%;right:-8%;top:33%;height:34%;border:1px solid rgba(150,225,255,.26);border-radius:50%}",
	".dsh-scr-donut{box-shadow:0 0 18px rgba(58,157,255,.2)}",
	"@keyframes dshShimmer{from{background-position:200% 0}to{background-position:-200% 0}}",
	"@keyframes dshNumGlow{0%,100%{text-shadow:0 0 12px rgba(64,196,255,.35)}50%{text-shadow:0 0 28px rgba(64,196,255,.8)}}",
	".dsh-scr-clockwrap{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}",
	".dsh-scr-range,.dsh-scr-date{background:rgba(58,157,255,.15);color:#fff;border:1px solid rgba(58,157,255,.45);border-radius:6px;padding:6px 12px;font-size:var(--dsh-content-font-size-secondary,0.93em);outline:none;color-scheme:dark;backdrop-filter:blur(8px);transition:border-color .2s,box-shadow .2s}",
	".dsh-scr-range:hover,.dsh-scr-date:hover{border-color:rgba(120,200,255,.75)}",
	".dsh-scr-range:focus,.dsh-scr-date:focus{border-color:rgba(140,220,255,.9);box-shadow:0 0 0 3px rgba(58,157,255,.18)}",
	".dsh-rtr-screen .dsh-rtr-btn{background:rgba(58,157,255,.15);color:#e6f2ff;border-color:rgba(58,157,255,.45);backdrop-filter:blur(8px);transition:background .2s,border-color .2s,color .2s}",
	".dsh-rtr-screen .dsh-rtr-btn:hover{background:rgba(58,157,255,.3);border-color:rgba(120,200,255,.75);color:#fff}",
	".dsh-rtr-screen .dsh-rtr-btn:active{background:rgba(58,157,255,.4);color:#fff}",
	".dsh-rtr-screen .dsh-rtr-btn:disabled{opacity:.45}",
	".dsh-scr-hero{display:flex;align-items:center;justify-content:center;gap:clamp(110px,13cqw,300px);padding:10px 6px 2px;flex-wrap:wrap}",
	".dsh-scr-heronums{display:grid;grid-template-columns:repeat(2,minmax(108px,1fr));gap:12px;min-width:0}",
	".dsh-scr-globewrap{position:relative;width:200px;height:200px;display:flex;align-items:center;justify-content:center;flex:none;perspective:900px;transform-style:preserve-3d}",
	".dsh-scr-globe{position:relative;width:130px;height:130px;border-radius:50%;flex:none;background:url(\"data:image/jpeg;base64,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xojhY9gI+QhpeBySSTV/5+6tRgs3BxLbH+i3GLQFsJ9fotQ5jmOIIPy91nafI98wYXAOdyS99Nry5SUb3HyS120gWBfK2+p6nhOgdkx6RHjkRim47nbS4dzRugeSf2XL42XHGHF0rQDRI9T9lObqjHY5hgcS4kgurjaR5edrmy4byZTwv3SRXka5lTMe1jI4g6xYskD05/zWtCttKuBevwcWHHNYxzVKIi2BERAREQEREBERAREQEREBERAREQEREBERAREQX8PLyMR+/HkLDxY8jXawsrK1rUcguvIMbXfyxgNAWuRZ5cPHll3XGbTuzwutyJ2kls0gsUfmPIVtxLjuc4uce5JtQivMZPUQIiKQREQEREBERAREQEREBERAREQEREBERAREQEKIggqhxVblbd6qmVTFtytuNlVuKtuXJyVeKURFzrA4NhVbrI3XXsqUQFNmvooRAREQEREE7qIIFELMy58V8WL+Gx3RyxxgTOe/f4j7JLqrgVQr291hKWkAgkWPRBcBc7c0jgmyK81diY5wJYGkXwSP2VsOZyQ6r5qrpbOObRHaNPHNHmjUt7Pw8jHjwWss72uaRZJ4III5sV5q2xhsDWOYyQEEm3bSDTSR2+1+avs1KfT4M7E07Jmigy2+DNtcWGWMOB2vANEEhpI5FhYU7omuIie94HZzm7f25Vpzi6r8lNs1oUoiKgIiICIiAqmgE0TXuqVXEx8kgYwFznGgB5oKXCiRdqFsM3J/Gl2Rlue/JIaHPNWa4HH0ACwXClOroUoiKAREQEREBERAREQEREBERAREQEREBERAREQEREBERAREQEREBERAREQEREBVxECRpPYG1QpaSDwpnsZD9pEpJHHDeLB58irLjucXUBfk0cBSfyHi78/RW1NFTK7G686KqY9rdx5vyA7JC5rHFzmb+DwragSCrjSrYVbStMKirzSrgKstKuNK68Kzq4igKVsgREQEREBERAREQEREBERAREQEREBERAREQEREBERAREQEREBERAREQEREBERAREQEREBERAREQEREBERAKHgIoJSilxVtxVTirbisM6tFDyqD3VTiqFyZ1eCIizSIiICIiAiIgIiICIiAq4mNcfmdtHmaulQpBoqYLk0QjAIka8H08laVySXfG1m1o23yByb9T5q2l19AiIoBERARFLQXGh3QB3VxjeCfEDHA8ApGNp707tz2CSmHwmCMSeJzvLiKPpQ8uFPoXch8cRj/AA829waCZA0tokCx9uRfmsVEUAiIgIiICIiAiIgIiICIiAiIgIiICIiAiIgIiICIiAiIgIiICIiAiIgIiICIiArkDA94bde5VtZGE1jpBuG7vwrY+xMzWhl/l9ODyqY5IQGBzOQSXXyHeg8qV3NsgCuBzfqsYN8zwP3U5TVRESHc5zg2hfYdgqURUSq3Dw9tc3ZKAqlSFbGi60q40qy0q408rpwqlXQVUFbaVcBXTjVKlERWBERAREQEREBERAREQEREBFNKEBERARFNIIREQEREBFNJSCERTSCFPl3UIgIppQgIiICIiAiIgIiICLa6Uzp9+mZP955GfDnCRv4fwImvjLKO4OsijdURfmtWas128k2IREQEREBEQoIJVDlUVQSqZVMUuKtuKqcrbja5s8l5FJUKSoXNVhERQCIiAiIgIiICIiAiIgIiICIiAiIgIiICriLQ4FxcB/291QiC6Zba4Vy7zJ5CtIiAiIgIiICIiAiIgIiICIiAiIgIiICIiAiIgIiICIiAiIgIiICIiAiIgIiICIiAiIgKuFxY8FqoRIMgGXdUd7mgkkHmq5/ZV+C2TCMge3ew8tvkj6eysCS+Hjd91WyZsfLN7T3FEd1bwLCKVCqCmxQ459VCIKgVW0q2FUDytsckWLzSqwVZBVxpXThkpV0KVQ0qoHhbS7VSOUWXpec3BmMj8DBzWEUY8qMuafoQQR9io1SXCnzpJdPxH4eO6i2B0xk2GuQHEAkXdXzXe+6lDFRERIiIgIiICIiAiIgIiICIpP0pBCIiAiIgIiICIiAiIglCoRAREQFKhEBERAREQEREBERBVIx8byx4pw7i1SiICIiAVSSpJVDiotEEqhxUuKoJWGeS0UuKpJQlQVzZVeIREWSRERAREQEREBERAREQEREBERAREQEREBERAREQEREBERAREQEREBERAREQEREBERAREQEREBERAREQEREBERAREQEREBERAREQEREBERAREQEREBERAREQFUCqVIVpRcBVTSrQKuRltncSPoPNbY5KrgKrBVoH0VQK6MclbF0FSqAVUCtZVUonuikVAEscbHy0qVJJIAvgKEBERAREQEREBERARFPkghERARTz3TlBCKVCAinlO6CEUpyghERAREQEU2oQ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\") 0 0/auto 100% repeat-x;box-shadow:0 0 20px rgba(255,255,255,.2),-3px 0 4px #c3f4ff inset,8px 1px 13px #000 inset,-12px -1px 18px rgba(195,244,255,.6) inset,130px 0 23px rgba(0,0,0,.4) inset,78px 0 20px rgba(0,0,0,.67) inset;animation:dshEarthTex 30s linear infinite,dshGlobeFloat 7s ease-in-out infinite}",
	".dsh-scr-grat{display:none}",
	".dsh-scr-sweep{display:none}",
	".dsh-scr-star{position:absolute;width:4px;height:4px;border-radius:50%;background:#fff;box-shadow:0 0 6px #fff,0 0 12px rgba(255,255,255,.5);animation:dshTwinkle 3s ease-in-out infinite;pointer-events:none}",
	".dsh-scr-orbitstage{position:absolute;inset:0;transform-style:preserve-3d;transform:rotateX(-16deg)}",
	".dsh-scr-orbittrack{position:absolute;left:50%;top:50%;width:calc(var(--r,150px)*2);height:calc(var(--r,150px)*2);margin:calc(var(--r,150px)*-1) 0 0 calc(var(--r,150px)*-1);border-radius:50%;border:1px solid rgba(255,255,255,.28);box-shadow:0 0 7px rgba(255,255,255,.14);transform:rotateX(90deg)}",
	".dsh-scr-orbiter{position:absolute;left:50%;top:50%;transform-style:preserve-3d;animation:dshOrbit3d 16s linear infinite}",
	".dsh-scr-planet{position:absolute;border-radius:50%;border:1px solid currentColor;background:radial-gradient(circle,transparent 58%,currentColor 100%);box-shadow:0 0 9px currentColor;transform-style:preserve-3d;animation:dshPlanetSpin 10s linear infinite}",
	".dsh-scr-planet::before{content:\"\";position:absolute;inset:-1px;border-radius:50%;border:1px solid currentColor;transform:rotateY(90deg)}",
	".dsh-scr-planet::after{content:\"\";position:absolute;inset:-1px;border-radius:50%;border:1px solid currentColor;transform:rotateX(90deg)}",
	"@keyframes dshOrbit3d{from{transform:rotateY(0deg) translateZ(var(--r,150px))}to{transform:rotateY(360deg) translateZ(var(--r,150px))}}",
	"@keyframes dshPlanetSpin{from{transform:rotateY(0deg) rotateX(0deg)}to{transform:rotateY(360deg) rotateX(360deg)}}",
	"@keyframes dshEarthTex{from{background-position:0 0}to{background-position:-260px 0}}",
	"@keyframes dshTwinkle{0%,100%{opacity:.1}50%{opacity:1}}",
	".dsh-scr-herotag{position:absolute;bottom:-4px;left:50%;transform:translateX(-50%);font-size:var(--dsh-content-font-size-secondary,0.93em);letter-spacing:.2em;color:#8fb4d9;white-space:nowrap}",
	"@keyframes dshGrat{from{background-position:0 0,0 0}to{background-position:190px 0,0 0}}",
	"@keyframes dshSweep{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}",
	"@keyframes dshOrbitSpin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}",
	"@keyframes dshGlobeFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}",
	"@container scrinner (max-width:980px){.dsh-scr-hero{gap:16px}.dsh-scr-globewrap{transform:scale(.85);order:-1;flex-basis:100%}}",
	"@container scrinner (max-width:760px){.dsh-scr-hero{gap:10px}.dsh-scr-globewrap{transform:scale(.62)}}",
	".dsh-rtr-distsec{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 220px}",
	".dsh-rtr-disthead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}",
	".dsh-rtr-distlegend{display:flex;gap:8px 12px;flex-wrap:wrap;min-width:0}",
	".dsh-rtr-distleg{font-size:var(--dsh-content-font-size-secondary,0.93em);color:var(--dsw-alias-label-secondary,#666);display:inline-flex;align-items:center;gap:4px;max-width:160px;overflow:hidden;white-space:nowrap}",
	".dsh-rtr-distleg i{width:7px;height:7px;border-radius:2px;flex:none}",
	".dsh-rtr-segbar{display:flex;height:14px;border-radius:6px;overflow:hidden;gap:0px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#1a1a1a) 4%,var(--dsw-alias-bg-base,#fff))}",
	".dsh-rtr-segbar span{display:block;min-width:3px;transition:width .5s ease}",
	".dsh-rtr-distdetails summary{font-size:var(--dsh-content-font-size-secondary,0.93em);color:var(--dsw-alias-label-tertiary,#8a8a8f);cursor:pointer;user-select:none;width:max-content}",
	".dsh-rtr-distdetails[open] summary{margin-bottom:4px;color:var(--dsw-alias-state-business-primary,#4c6ef5)}",
	".dsh-rtr-disttitle{font-size:var(--dsh-content-font-size-secondary,0.93em);letter-spacing:.05em;color:var(--dsw-alias-label-tertiary,#8a8a8f)}",
	".dsh-rtr-dist{display:flex;flex-direction:column;gap:4px;max-height:138px;overflow-y:auto;min-width:0}",
	".dsh-rtr-distrow{display:grid;grid-template-columns:minmax(60px,110px) 1fr 26px;align-items:center;gap:8px;min-width:0}",
	".dsh-rtr-distlbl{font-size:var(--dsh-content-font-size-secondary,0.93em);color:var(--dsw-alias-label-secondary,#666);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
	".dsh-rtr-disttrack{height:8px;border-radius:4px;background:rgba(120,150,190,.16);overflow:hidden}",
	".dsh-rtr-disttrack span{display:block;height:100%;border-radius:4px;background:linear-gradient(90deg,var(--dsw-alias-state-business-primary,#4c6ef5),color-mix(in srgb,var(--dsw-alias-state-business-primary,#4c6ef5) 55%,#9db8ff));transition:width .4s ease}",
	".dsh-rtr-distrow.is-click{cursor:pointer}",
	".dsh-rtr-distrow.is-click .dsh-rtr-disttrack span{background:linear-gradient(90deg,#7a5cf5,#b48cff)}",
	".dsh-rtr-distrow.is-click:hover .dsh-rtr-distlbl{color:var(--dsw-alias-state-business-primary,#4c6ef5)}",
	".dsh-rtr-distval{font-size:var(--dsh-content-font-size-secondary,0.93em);font-family:monospace;color:var(--dsw-alias-label-primary,#333);text-align:right}",
	".dsh-scr-panel h4{margin:0 0 14px;font-size:15px;font-weight:600;letter-spacing:.04em;color:#fff;padding-bottom:10px;border-bottom:1px solid rgba(58,157,255,.2)}",
	".dsh-scr-panel h4::before{content:\"\"}",
	".dsh-scr-center{display:flex;flex-direction:column;gap:14px}",
	".dsh-scr-nums{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}",
	".dsh-scr-num{border:1px solid rgba(58,157,255,.45);border-radius:10px;padding:16px 12px 12px;text-align:center;background:rgba(10,30,60,.45);backdrop-filter:blur(10px);box-shadow:0 0 15px rgba(58,157,255,.12)}",
	".dsh-scr-num b{display:block;font-size:36px;font-weight:700;color:#fff;font-family:monospace;line-height:1.1}",
	".dsh-scr-num span{font-size:var(--dsh-content-font-size,1em);letter-spacing:.1em;color:#8fb4d9}",
	".dsh-scr-num.is-good b{color:var(--rt-ok-bright,#36f1b0);text-shadow:0 0 10px rgba(54,241,176,.5)}",
	".dsh-scr-num.is-warn b{color:var(--rt-sev-medium-bright,#ffb454);text-shadow:0 0 10px rgba(255,180,84,.45)}",
	".dsh-scr-num.is-bad b{color:var(--rt-sev-high-bright,#ff6b8a);text-shadow:0 0 10px rgba(255,107,138,.5)}",
	".dsh-scr-bar{display:flex;align-items:center;gap:10px;margin:7px 0;font-size:var(--dsh-content-font-size-secondary,0.93em)}",
	".dsh-scr-bar .lbl{width:80px;color:#8fb4d9;flex:none;text-align:right}",
	".dsh-scr-bar .track{flex:1;height:8px;border-radius:4px;background:rgba(58,157,255,.15);overflow:hidden}",
	".dsh-scr-bar .fill{height:100%;border-radius:4px;background:#3a9dff;box-shadow:0 0 6px rgba(58,157,255,.6)}",
	".dsh-scr-bar .fill.is-alt{background:#3a9dff;box-shadow:0 0 6px rgba(58,157,255,.6)}",
	".dsh-scr-bar .val{width:34px;color:#fff;font-family:monospace;flex:none}",
	".dsh-scr-donut{width:132px;height:132px;border-radius:50%;margin:14px auto 24px;position:relative;isolation:isolate;transform:scaleY(.62);background:conic-gradient(#ff4d6d 0 25%,#ff8a3d 25% 50%,#ffb454 50% 75%,#3a9dff 75% 100%);box-shadow:0 0 18px rgba(58,157,255,.2)}",
	".dsh-scr-donut::before{content:\"\";position:absolute;left:2px;right:2px;top:0;bottom:-26px;border-radius:50%;background:linear-gradient(180deg,#0e2a52,#0a1c3a);z-index:-1;box-shadow:0 18px 28px rgba(2,8,20,.65)}",
	".dsh-scr-donut::after{content:attr(data-total);position:absolute;inset:27px;border-radius:50%;background:#050f1f;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;color:#fff;font-family:monospace;transform:scaleY(1.62)}",
	".dsh-scr-b3d{position:relative;height:clamp(150px,20vh,210px);font-size:var(--dsh-content-font-size-secondary,0.93em);perspective:56em;perspective-origin:50% calc(50% - 11em)}",
	".dsh-scr-b3stage{position:absolute;top:72%;left:50%;transform-style:preserve-3d;transform:rotateY(-38deg)}",
	".dsh-scr-b3floor{position:absolute;left:-14em;top:-7em;width:28em;height:14em;transform:translateY(6.5em) rotateX(90deg);background:radial-gradient(rgba(5,15,31,0) 40%,#050f1f 78%),linear-gradient(rgba(58,157,255,.16) 1px,transparent 1px),linear-gradient(90deg,rgba(58,157,255,.16) 1px,transparent 1px);background-size:100%,2em 2em,2em 2em}",
	".dsh-scr-b3slot{position:absolute;left:0;top:0;transform-style:preserve-3d;margin-left:var(--x)}",
	".dsh-scr-b3bar{position:absolute;left:0;top:0;transform-style:preserve-3d;transform-origin:0 6.5em 0;transform:scaleY(var(--v,.04));transition:transform .6s ease}",
	".dsh-scr-b3bar>i{position:absolute;margin:-1.3em;width:2.6em;height:2.6em;backface-visibility:hidden;box-shadow:0 0 1px currentColor;background:currentColor}",
	".dsh-scr-b3bar>i:nth-child(n+2){margin-top:-6.5em;height:13em}",
	".dsh-scr-b3bar>i:nth-child(1){transform:rotate3d(1,0,0,90deg) translateZ(6.5em);filter:brightness(1.25)}",
	".dsh-scr-b3bar>i:nth-child(2){transform:rotate3d(0,1,0,-90deg) translateZ(1.3em);filter:brightness(.55)}",
	".dsh-scr-b3bar>i:nth-child(3){transform:rotate3d(0,1,0,0deg) translateZ(1.3em);filter:brightness(.8)}",
	".dsh-scr-b3bar>i:nth-child(4){transform:rotate3d(0,1,0,90deg) translateZ(1.3em);filter:brightness(.4)}",
	".dsh-scr-b3num{position:absolute;left:-1.3em;width:2.6em;text-align:center;font-size:1.35em;font-weight:700;color:#fff;font-family:monospace;text-shadow:0 1px 5px rgba(0,0,0,.85);transform:rotateY(38deg) translateZ(1.6em) translateY(calc(max(1em,5em - 13em*var(--v,.04))))}",
	".dsh-scr-legend{display:flex;flex-wrap:wrap;gap:10px;justify-content:center;font-size:var(--dsh-content-font-size-secondary,0.93em);color:#8fb4d9}",
	".dsh-scr-legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px;vertical-align:-1px}",
	".dsh-scr-table{width:100%;border-collapse:collapse;font-size:var(--dsh-content-font-size,1em)}",
	".dsh-scr-table th{position:sticky;top:0;z-index:1;color:#3a9dff;font-weight:500;text-align:left;padding:10px 8px;border-bottom:1px solid rgba(58,157,255,.2);letter-spacing:.04em;font-size:var(--dsh-content-font-size,1em);background:rgba(10,40,80,.85)}",
	".dsh-scr-table td{padding:10px 8px;border-bottom:1px solid rgba(58,157,255,.08);color:#e6f2ff}",
	".dsh-scr-table tr:hover td{background:rgba(58,157,255,.1)}",
	".dsh-scr-sev{display:inline-block;padding:2px 9px;border-radius:999px;font-size:var(--dsh-content-font-size-secondary,0.93em);font-weight:600}",
	".dsh-scr-sev-critical{color:var(--rt-sev-critical-bright,#ff8fa0);background:rgba(194,24,47,.30);border:1px solid rgba(255,90,110,.45)}",
	".dsh-scr-sev-high{color:var(--rt-sev-high-bright,#ffb0b0);background:rgba(255,77,77,.20);border:1px solid rgba(255,90,90,.45)}",
	".dsh-scr-sev-medium{color:var(--rt-sev-medium-bright,#ffe98a);background:rgba(255,221,51,.12);border:1px solid rgba(255,221,51,.45)}",
	".dsh-scr-sev-low{color:var(--rt-sev-low-bright,#7cc0ff);background:rgba(58,157,255,.16);border:1px solid rgba(58,157,255,.45)}",
	".dsh-scr-mode{display:flex;align-items:center;gap:10px;margin:6px 0;font-size:var(--dsh-content-font-size,1em);color:#e6f2ff}",
	".dsh-scr-mode .tag{width:104px;flex:none;color:#8fb4d9}",
	".dsh-scr-mode .n{margin-left:auto;font-family:monospace;color:#fff}",
	".dsh-scr-empty{padding:60px 20px;text-align:center;color:#8fb4d9;letter-spacing:.12em;font-size:15px}"
].join("\n");

var CSS = [
	".dsh-rtr-root{height:100%;display:flex;min-height:0;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);font-size:var(--dsh-content-font-size,1em)}",
	".dsh-rtr-side{width:168px;flex:none;border-right:1px solid var(--dsw-alias-border-l1,#e9e9ec);padding:16px 12px;display:flex;flex-direction:column;gap:4px;background:linear-gradient(180deg,color-mix(in srgb,var(--rt-accent,#4c6ef5) 3%,var(--dsw-alias-bg-base,#fff)),color-mix(in srgb,var(--rt-accent,#4c6ef5) 6%,var(--dsw-alias-bg-base,#fff)));backdrop-filter:blur(12px) saturate(1.1)}",
	".dsh-rtr-side-title{font-size:var(--dsh-content-font-size-secondary,0.93em);letter-spacing:.12em;color:var(--dsw-alias-label-tertiary,#8a8a8f);padding:0 8px 12px;font-weight:600}",
	".dsh-rtr-side-item{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 10px;border:none;background:none;border-radius:6px;cursor:pointer;color:var(--dsw-alias-label-secondary,#5b5b60);font-size:var(--dsh-content-font-size,1em);text-align:left;transition:background .18s,color .18s,box-shadow .18s}",
	".dsh-rtr-side-item:hover{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,var(--dsw-alias-label-primary,#1a1a1a) 6%,transparent));color:var(--dsw-alias-label-primary,#1a1a1a)}",
	".dsh-rtr-side-item.is-active{background:color-mix(in srgb,var(--rt-accent,#4c6ef5) 10%,transparent);color:var(--rt-accent,#4c6ef5);font-weight:600;box-shadow:inset 3px 0 0 0 var(--rt-accent,#4c6ef5),inset 0 0 0 1px color-mix(in srgb,var(--rt-accent,#4c6ef5) 10%,transparent)}",
	".dsh-rtr-count{font-size:var(--dsh-content-font-size-secondary,0.93em);min-width:22px;text-align:center;border-radius:999px;padding:0px 8px;background:color-mix(in srgb,var(--rt-accent,#4c6ef5) 10%,transparent);border:1px solid color-mix(in srgb,var(--rt-accent,#4c6ef5) 28%,transparent);color:var(--rt-accent,#4c6ef5);font-variant-numeric:tabular-nums}",
	".dsh-rtr-main{flex:1;min-width:0;display:flex;flex-direction:column;overflow:auto;padding:16px 16px 16px;gap:12px}",
	".dsh-rtr-meta{display:flex;align-items:center;gap:16px;flex-wrap:wrap;font-size:var(--dsh-content-font-size-secondary,0.93em);color:var(--dsw-alias-label-secondary,#5b5b60);border:1px solid var(--dsw-alias-border-l1,#e9e9ec);border-radius:9px;padding:8px 12px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#1a1a1a) 4%,var(--dsw-alias-bg-base,#fff))}",
	".dsh-rtr-meta b{color:var(--dsw-alias-label-primary,#1a1a1a);font-weight:600;margin-left:4px}",
	".dsh-rtr-meta.is-ghost{border-style:dashed;background:transparent;color:var(--dsw-alias-label-tertiary,#8a8a8f);padding:4px 12px}",
	".dsh-rtr-metalink{font:inherit;font-size:var(--dsh-content-font-size-secondary,0.93em);color:var(--dsw-alias-state-business-primary,#4c6ef5);background:none;border:none;cursor:pointer;padding:0}",
	".dsh-rtr-metalink:hover{text-decoration:underline}",
	".dsh-rtr-meta input{font:inherit;font-size:var(--dsh-content-font-size,1em);padding:3px 8px;border:1px solid var(--dsw-alias-border-l2,#d4d4d8);border-radius:6px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1a1a1a)}",
	".dsh-rtr-stats{display:flex;flex-direction:column;gap:12px}",
	".dsh-rtr-cardsrow{display:flex;gap:12px;flex-wrap:wrap}",
	".dsh-rtr-statcard{flex:1;min-width:110px;border:1px solid var(--dsw-alias-border-l1,#e9e9ec);border-radius:10px;padding:8px 12px;background:var(--dsw-alias-bg-base,#fff);cursor:pointer}",
	".dsh-rtr-statcard:hover{border-color:var(--dsw-alias-border-l2,#d4d4d8)}",
	".dsh-rtr-statcard.is-dim{opacity:.55}",
	".dsh-rtr-statnum{font-size:21px;font-weight:700;line-height:1.2;margin-top:4px}",
	".dsh-rtr-statlabel{font-size:var(--dsh-content-font-size,1em);color:var(--dsw-alias-label-tertiary,#8a8a8f);letter-spacing:.05em}",
	".dsh-rtr-statextra{display:flex;flex-direction:row;flex-wrap:wrap;gap:8px 16px;width:100%;align-items:flex-start}",
	".dsh-rtr-bar{display:flex;height:10px;border-radius:5px;overflow:hidden;background:color-mix(in srgb,var(--dsw-alias-label-primary,#1a1a1a) 4%,var(--dsw-alias-bg-base,#fff));flex:1 1 100%}",
	".dsh-rtr-chiprow{display:flex;gap:8px;flex-wrap:wrap;flex:1 1 100%}",
	".dsh-rtr-types{display:flex;gap:8px;flex-wrap:wrap}",
	".dsh-rtr-typechip{font-size:var(--dsh-content-font-size-secondary,0.93em);padding:2px 8px;border-radius:6px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#1a1a1a) 4%,var(--dsw-alias-bg-base,#fff));color:var(--dsw-alias-label-secondary,#5b5b60);border:1px solid var(--dsw-alias-border-l1,#e9e9ec);cursor:pointer}",
	".dsh-rtr-typechip.is-static{cursor:default;opacity:.78}",
	".dsh-rtr-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
	".dsh-rtr-toolbar .dsh-rtr-spacer{flex:1}",
	".dsh-rtr-select,.dsh-rtr-search{font:inherit;font-size:var(--dsh-content-font-size,1em);padding:4px 8px;border:1px solid var(--dsw-alias-border-l2,#d4d4d8);border-radius:6px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1a1a1a)}",
	".dsh-rtr-search{width:170px}",
	".dsh-rtr-btn{font:inherit;font-size:var(--dsh-content-font-size,1em);padding:5px 11px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#d4d4d8);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);cursor:pointer;white-space:nowrap}",
	".dsh-rtr-btn:hover{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,var(--dsw-alias-label-primary,#1a1a1a) 7%,transparent))}",
	".dsh-rtr-btn.is-primary{border-color:transparent;background:var(--dsw-alias-state-business-primary,#4c6ef5);color:#fff}",
	".dsh-rtr-btn.is-primary:hover{filter:brightness(1.05)}",
	".dsh-rtr-btn.is-danger{color:var(--dsw-alias-state-error-primary,#d5333c);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d5333c) 35%,transparent)}",
	".dsh-rtr-btn:active{background:color-mix(in srgb,var(--dsw-alias-label-primary,#1a1a1a) 13%,transparent)}",
	".dsh-rtr-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4c6ef5);outline-offset:1px}",
	".dsh-rtr-btn:disabled{opacity:.5;cursor:default}",
	".dsh-rtr-grouphead{display:flex;align-items:center;gap:12px;padding:12px 12px 4px;font-weight:600;font-size:var(--dsh-content-font-size,1em);color:var(--dsw-alias-label-secondary,#5b5b60)}",
	".dsh-rtr-grouphead .dsh-rtr-count{font-weight:400}",
	".dsh-rtr-row{border:1px solid var(--dsw-alias-border-l1,#e9e9ec);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-base,#fff)}",
	".dsh-rtr-row + .dsh-rtr-row{margin-top:8px}",
	".dsh-rtr-rowhead{display:flex;align-items:center;gap:12px;padding:8px 12px;cursor:pointer}",
	".dsh-rtr-rowhead:hover{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,var(--dsw-alias-label-primary,#1a1a1a) 5%,transparent))}",
	".dsh-rtr-seq{font-size:var(--dsh-content-font-size,1em);color:var(--dsw-alias-label-tertiary,#8a8a8f);width:28px;flex:none;text-align:right}",
	".dsh-rtr-title{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
	".dsh-rtr-summ{flex:1;min-width:0;color:var(--dsw-alias-label-tertiary,#8a8a8f);font-size:var(--dsh-content-font-size,1em);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
	".dsh-rtr-time{font-size:var(--dsh-content-font-size,1em);color:var(--dsw-alias-label-tertiary,#8a8a8f);flex:none}",
	".dsh-rtr-sev{flex:none;font-size:var(--dsh-content-font-size,1em);font-weight:600;padding:4px 8px;border-radius:9px;border:1px solid}",
	".dsh-rtr-sev-critical{color:#c2182f;border-color:rgba(194,24,47,.35);background:rgba(194,24,47,.08)}",
	".dsh-rtr-sev-high{color:#ff4d4d;border-color:rgba(255,77,77,.35);background:rgba(255,77,77,.08)}",
	".dsh-rtr-sev-medium{color:#c2650a;border-color:rgba(194,101,10,.35);background:rgba(194,101,10,.08)}",
	".dsh-rtr-sev-low{color:#3b7dd8;border-color:rgba(59,125,216,.35);background:rgba(59,125,216,.08)}",
	".dsh-rtr-st{flex:none;font-size:var(--dsh-content-font-size,1em);padding:4px 8px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2,#d4d4d8);color:var(--dsw-alias-label-secondary,#5b5b60)}",
	".dsh-rtr-st-retesting{border-color:var(--dsw-alias-state-business-primary,#4c6ef5);color:var(--dsw-alias-state-business-primary,#4c6ef5);background:var(--dsw-alias-state-business-primary-alpha,rgba(76,110,245,.08))}",
	".dsh-rtr-st-verified{color:#2f9e63;border-color:rgba(47,158,99,.35);background:rgba(47,158,99,.08)}",
		".dsh-rtr-st-code-reviewed{color:#0b7285;border-color:rgba(11,114,133,.35);background:rgba(11,114,133,.08)}",
	".dsh-rtr-st-false-positive{color:#8a8a8f;text-decoration:line-through}",
	".dsh-rtr-am{flex:none;font-size:var(--dsh-content-font-size,1em);padding:4px 8px;border-radius:9px;border:1px solid}",
	".dsh-rtr-am-static{color:var(--dsw-alias-label-secondary,#5b5b60);border-color:rgba(91,91,96,.35);background:rgba(91,91,96,.07)}",
	".dsh-rtr-am-dynamic{color:#2f9e63;border-color:rgba(47,158,99,.35);background:rgba(47,158,99,.1);font-weight:600}",
	// 详情是覆盖面板（v6 第 5.3 节）：宽 min(640px, 内容区宽度)，覆盖而不挤压列表；窄屏改成贴边整宽。
	".dsh-rtr-detail{position:fixed;right:24px;bottom:24px;z-index:60;box-sizing:border-box;width:min(640px,calc(100vw - 48px));max-height:min(70vh,640px);overflow:auto;border:1px solid var(--dsw-alias-border-l1,#e9e9ec);border-radius:12px;padding:12px 16px;display:flex;flex-direction:column;gap:12px;background:var(--dsw-alias-bg-base,#fff);box-shadow:0 12px 36px rgba(0,0,0,.2)}",
	"@media(max-width:720px){.dsh-rtr-detail{left:12px;right:12px;bottom:12px;width:auto}}",
	".dsh-rtr-detail-head{position:sticky;top:0;z-index:1;display:flex;justify-content:flex-end;margin:-8px 0 4px;background:var(--dsw-alias-bg-base,#fff)}",
	".dsh-rtr-fields{display:flex;gap:16px;flex-wrap:wrap;font-size:var(--dsh-content-font-size,1em);color:var(--dsw-alias-label-secondary,#5b5b60)}",
	".dsh-rtr-fields b{color:var(--dsw-alias-label-primary,#1a1a1a);font-weight:600;margin-left:4px}",
	".dsh-rtr-block h4{margin:0 0 4px;font-size:var(--dsh-content-font-size,1em);color:var(--dsw-alias-label-tertiary,#8a8a8f);letter-spacing:.04em}",
	".dsh-rtr-block pre{margin:0;padding:12px 12px;border-radius:8px;background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l1,#e9e9ec);white-space:pre-wrap;word-break:break-word;font-size:var(--dsh-content-font-size,1em);max-height:280px;overflow:auto}",
	".dsh-rtr-duo{display:flex;gap:12px;flex-wrap:wrap}",
	".dsh-rtr-duo>div{flex:1;min-width:280px}",
	".dsh-rtr-duo pre{margin:0;padding:12px 12px;border-radius:8px;background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l1,#e9e9ec);white-space:pre-wrap;word-break:break-word;font-size:var(--dsh-content-font-size-secondary,0.93em);max-height:280px;overflow:auto}",
	// 原文双栏在窄屏改成上下栏（v6 第 5.3 节）；默认遮蔽秘密，展开按钮只在本地改显示。
	"@media(max-width:720px){.dsh-rtr-packets{display:block}.dsh-rtr-packets>div+div{margin-top:12px}}",
	".dsh-rtr-packet-actions{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-top:8px}",
	".dsh-rtr-packet-actions small{color:var(--dsw-alias-label-secondary,#5b5b60)}",
	".dsh-rtr-verdict{font-size:var(--dsh-content-font-size-secondary,0.93em);padding:8px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#d4d4d8);background:var(--dsw-alias-bg-base,#fff)}",
	".dsh-rtr-rowactions{display:flex;gap:8px;flex:none}",
	".dsh-rtr-check{accent-color:var(--dsw-alias-state-business-primary,#4c6ef5)}",
	".dsh-rtr-pager{display:flex;align-items:center;justify-content:center;gap:12px;padding:4px 0;font-size:var(--dsh-content-font-size-secondary,0.93em);color:var(--dsw-alias-label-secondary,#5b5b60)}",
	".dsh-rtr-empty{border:1px dashed var(--dsw-alias-border-l2,#d4d4d8);border-radius:10px;padding:24px 24px;text-align:center;color:var(--dsw-alias-label-tertiary,#8a8a8f);font-size:var(--dsh-content-font-size-secondary,0.93em);line-height:1.5}",
	".dsh-rtr-empty-actions{margin-top:16px}",
	".dsh-rtr-empty-actions button{font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l1,#d9d9de);border-radius:6px;padding:6px 14px;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,inherit)}",
	".dsh-rtr-notice{position:sticky;top:0;z-index:2;font-size:var(--dsh-content-font-size-secondary,0.93em);padding:8px 12px;border-radius:8px;background:rgba(76,110,245,.08);border:1px solid rgba(76,110,245,.25);color:var(--dsw-alias-label-primary,#1a1a1a)}",
	// 报告预览：定高、正文独立滚动，长报告不把页面撑爆，底部按钮始终可见。
	".dsh-rtr-report-preview{margin:12px 0;border:1px solid var(--dsw-alias-border-l1,#d9d9de);border-radius:10px;background:var(--dsw-alias-bg-base,#fff);overflow:hidden}",
	".dsh-rtr-preview-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#e5e5ea)}",
	".dsh-rtr-preview-name{font-size:var(--dsh-content-font-size-secondary,0.93em);color:var(--dsw-alias-label-secondary,#6e6e73);overflow-wrap:anywhere}",
	// 正文底色必须**跟随主题**：宿主没定义 --dsw-alias-bg-l1，写死浅色回退会让深色下变成白底白字。
	// 用半透明灰（和工具行 chip 同一手法）在浅色/深色都成立。
	".dsh-rtr-preview-body{max-height:min(420px,60vh);overflow:auto;margin:0;padding:12px;font-size:var(--dsh-content-font-size-secondary,0.93em);line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--dsw-alias-bg-l1,rgba(128,128,128,.08))}",
	".dsh-rtr-preview-head{border-bottom-color:var(--dsw-alias-border-l1,rgba(128,128,128,.25))}",
	".dsh-rtr-skel{color:var(--dsw-alias-label-tertiary,#8a8a8f);padding:24px;text-align:center;font-size:var(--dsh-content-font-size-secondary,0.93em)}",
	".dsh-rtr-tl{display:flex;flex-direction:column}",
	".dsh-rtr-tl-item{display:flex;gap:12px;align-items:stretch;min-width:0}",
	".dsh-rtr-tl-rail{display:flex;flex-direction:column;align-items:center;width:18px;flex:none}",
	".dsh-rtr-tl-dot{width:10px;height:10px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#4c6ef5);border:2px solid var(--dsw-alias-bg-base,#fff);flex:none;margin-top:24px;z-index:1}",
	".dsh-rtr-tl-line{flex:1;width:2px;background:var(--dsw-alias-border-l2,#d4d4d8);margin-top:4px}",
	".dsh-rtr-tl-item:last-child .dsh-rtr-tl-line{display:none}",
	".dsh-rtr-tl-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;padding-bottom:12px}",
	".dsh-rtr-tl-time{font-family:monospace;font-size:var(--dsh-content-font-size-secondary,0.93em);color:var(--dsw-alias-label-secondary,#5b5b60);letter-spacing:.04em}",
	".dsh-rtr-tl-card{border:1px solid var(--dsw-alias-border-l1,#e9e9ec);border-radius:10px;background:var(--dsw-alias-bg-base,#fff);overflow:hidden}",
	".dsh-rtr-tl-meta{display:flex;gap:16px;flex-wrap:wrap;font-size:var(--dsh-content-font-size-secondary,0.93em);color:var(--dsw-alias-label-secondary,#5b5b60);padding:0 12px 8px;cursor:pointer}",
	".dsh-rtr-tl-meta b{color:var(--dsw-alias-label-primary,#1a1a1a);font-weight:600;margin-left:4px}",
	".dsh-rtr-tl-concl{flex:1;min-width:0;color:var(--dsw-alias-label-tertiary,#8a8a8f);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
	"@media (max-width:720px){.dsh-rtr-tl-item{gap:8px}.dsh-rtr-tl-meta{gap:8px}}",
	".dsh-rtr-cp{display:flex;flex-direction:column;gap:12px}",
	".dsh-rtr-cp-item{display:flex;flex-direction:column;gap:0;min-width:0}",
	".dsh-rtr-cp-card{border:1px solid var(--dsw-alias-border-l1,#e9e9ec);border-radius:10px;background:var(--dsw-alias-bg-base,#fff);overflow:hidden}",
	".dsh-rtr-cp-chain{display:flex;gap:0;flex-wrap:wrap;align-items:stretch;padding:8px 12px;cursor:pointer;row-gap:8px}",
	".dsh-rtr-cp-hop{display:flex;align-items:baseline;gap:8px;font-size:var(--dsh-content-font-size-secondary,0.93em);max-width:100%}",
	".dsh-rtr-cp-hop:not(:last-child):after{content:'→';color:var(--dsw-alias-label-tertiary,#8a8a8f);margin:0 8px}",
	".dsh-rtr-cp-hop i{font-style:normal;color:var(--dsw-alias-label-tertiary,#8a8a8f);white-space:nowrap}",
	".dsh-rtr-cp-hop b{font-weight:600;color:var(--dsw-alias-label-primary,#1a1a1a);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}",
	".dsh-rtr-cp-hoplabel{font-size:var(--dsh-content-font-size-secondary,0.93em);color:var(--dsw-alias-label-tertiary,#8a8a8f);white-space:nowrap}",
	".dsh-rtr-cp-hopval{color:var(--dsw-alias-label-primary,#1a1a1a);font-size:var(--dsh-content-font-size-secondary,0.93em)}",
	".dsh-rtr-cp-impact{flex:1 1 100%;border-top:1px dashed var(--dsw-alias-border-l1,#e9e9ec);padding-top:8px}",
	"@media (max-width:720px){.dsh-rtr-cp-hop{flex-basis:100%}.dsh-rtr-cp-hop:not(:last-child):after{display:none}}",
	"@media (max-width:720px){.dsh-rtr-root{flex-direction:column}.dsh-rtr-side{width:auto;flex-direction:row;overflow-x:auto;padding:8px}.dsh-rtr-side-title{display:none}.dsh-rtr-side-item{white-space:nowrap}}",
	".dsh-rtr-exportpop{position:fixed;z-index:300;visibility:hidden;background:var(--rt-surface-card,#fff);border:1px solid var(--rt-border,#e9e9ec);border-radius:12px;box-shadow:0 10px 34px rgba(9,20,40,.18);padding:8px;min-width:180px;display:flex;flex-direction:column}",
	".dsh-rtr-exportitem{border:none;background:none;text-align:left;padding:8px 12px;font-size:var(--dsh-content-font-size,1em);border-radius:6px;cursor:pointer;color:var(--dsw-alias-label-primary,#1a1a1a)}",
	".dsh-rtr-exportitem:hover{background:var(--rt-surface-tint,#f7f7f8)}"
].join("\n");

function installStyles() {
	if (document.getElementById("dsh-rtr-style")) return function () {};
	// 红队四插件共享设计令牌（幂等注入，同 id 先到先得；与 pulse/hunter/webshell 同一份内容）
	if (!document.getElementById("dsh-rt-tokens")) {
		var tok = document.createElement("style");
		tok.id = "dsh-rt-tokens";
		tok.textContent = ".dsh-task-workspace,.dsh-rtr-screen{--rt-sev-critical:#c2182f;--rt-sev-high:#ff4d4d;--rt-sev-medium:#c2650a;--rt-sev-low:#3b7dd8;--rt-sev-critical-bright:#ff8fa0;--rt-sev-high-bright:#ff6b8a;--rt-sev-medium-bright:#ffb454;--rt-sev-low-bright:#4dabf7;--rt-ok:#2f9e44;--rt-dead:#c92a2a;--rt-ok-bright:#36f1b0;--rt-dead-bright:#ff8787;--rt-accent:var(--dsw-alias-state-business-primary,#4c6ef5);--rt-surface-card:var(--dsw-alias-bg-base,#fff);--rt-surface-tint:color-mix(in srgb,var(--dsw-alias-label-primary,#1a1a1a) 4%,var(--dsw-alias-bg-base,#fff));--rt-border:var(--dsw-alias-border-l1,#e9e9ec);--rt-mono:ui-monospace,\"SF Mono\",SFMono-Regular,Menlo,Consolas,monospace;--rt-navy-bg:rgba(8,24,46,.96);--rt-navy-bg-soft:rgba(12,32,62,.6);--rt-navy-line:rgba(58,157,255,.45);--rt-navy-line-soft:rgba(58,157,255,.28);--rt-navy-text:#e8f3ff;--rt-navy-text-2:#cfe6ff;--rt-navy-body:#b9d2ee;--rt-navy-dim:#7d97b8;--rt-navy-dim-2:#8fb4d9;--rt-navy-accent:#38d4ff;--rt-navy-accent-2:#3a9dff}";
		document.head.appendChild(tok);
	}
	var el = document.createElement("style");
	el.id = "dsh-rtr-style";
	el.textContent = CSS + CSS_SCREEN;
	document.head.appendChild(el);
	return function () { el.remove(); };
}

//#endregion

var LABEL_BY_TYPE_MODES = { "av-evasion": 1, "ctf-solver": 1, "binary-analysis": 1, "attack-defense": 1 };
function Chip(props) {
	if (props.typeLabel) return React.createElement("span", { className: "dsh-rtr-typechip is-static" }, props.typeLabel);
	return React.createElement("span", { className: "dsh-rtr-sev dsh-rtr-sev-" + props.severity }, SEVERITY_LABEL[props.severity] || props.severity);
}
function statusTextForExport(f, mode) {
	if (mode === "pentest" && f.status === "verified" && (!f.delivery || !f.delivery.ready)) return "需重新验证";
	if (mode === "code-audit" && f.status === "pending" && f.auditMode !== "dynamic") return "待动态验证";
	if (mode === "cloud-security") return CLOUDPATH_STATUS_LABEL[f.status] || f.status;
	if (mode === "ctf-solver") return CTF_STATUS_LABEL[f.status] || f.status;
	if (mode === "incident-response") return TIMELINE_STATUS_LABEL[f.status] || f.status;
	return STATUS_LABEL[f.status] || f.status;
}
function Btn(props) {
	return React.createElement("button", {
		className: "dsh-rtr-btn saker-ui-btn" + (props.primary ? " is-primary" : "") + (props.danger ? " is-danger" : ""),
		onClick: props.onClick, disabled: props.disabled, type: "button", 'aria-pressed': props['aria-pressed'],
		'aria-current': props['aria-current'], 'aria-expanded': props['aria-expanded'], style: props.style
	}, props.children);
}
/** 视口自适应 popover（手动触发打开，外点/ESC 关闭，位置钳制）——导出菜单等目录收纳用。 */
function PopMenu(props) {
	var ref = useRef(null);
	useEffect(function () {
		var el = ref.current;
		if (!el) return;
		var rect = el.getBoundingClientRect();
		var vw = window.innerWidth, vh = window.innerHeight;
		var w = el.offsetWidth || 200;
		var left = props.anchor.left, top = props.anchor.bottom + 6;
		if (left + w > vw - 8) left = Math.max(8, vw - w - 8);
		if (top + rect.height > vh - 8) top = Math.max(8, props.anchor.top - rect.height - 6);
		el.style.left = left + "px";
		el.style.top = top + "px";
		el.style.visibility = "visible";
	}, []);
	useEffect(function () {
		var onDown = function (e) { if (ref.current && !ref.current.contains(e.target)) props.onClose(); };
		var onKey = function (e) { if (e.key === "Escape") props.onClose(); };
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return function () {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, []);
	return React.createElement("div", { ref: ref, className: "dsh-rtr-exportpop", style: { left: "0px", top: "0px", visibility: "hidden" } },
		(props.items || []).map(function (it) {
			return React.createElement("button", { key: it.label, type: "button", className: "dsh-rtr-exportitem", title: it.title || "", onClick: function () { props.onClose(); it.onClick(); } }, it.label);
		}));
}
function Block(props, value) {
	return React.createElement("div", { className: "dsh-rtr-block" },
		React.createElement("h4", null, props.title),
		React.createElement("pre", null, props.children !== undefined ? props.children : value));
}

/** 紧凑分布条形图：多类型不换行堆叠，固定高度可滚动，行可点击（点击=触发筛选）。 */
function DistBars(props) {
	var items = props.items || [];
	if (items.length === 0) return null;
	var mx = Math.max.apply(null, items.map(function (i) { return i.count; }).concat([1]));
	return React.createElement("div", { className: "dsh-rtr-dist" },
		items.map(function (it) {
			return React.createElement("div", { key: it.key, className: "dsh-rtr-distrow" + (it.onClick ? " is-click" : ""), onClick: it.onClick || undefined, title: it.onClick ? "点击筛选 " + it.label : it.label },
				React.createElement("span", { className: "dsh-rtr-distlbl" }, it.label),
				React.createElement("span", { className: "dsh-rtr-disttrack" }, React.createElement("span", { style: { width: (it.count / mx * 100) + "%" } })),
				React.createElement("b", { className: "dsh-rtr-distval" }, it.count));
		}));
}

var DIST_PALETTE = ["#3f8ef7", "#38d4ff", "#7a5cf5", "#b48cff", "#2f9d63", "#e8a13a", "#e5484d", "#8a99ad"];

/** 时间范围 → [from,to] ISO（空串=不限）：today=本地今日零点；Nd=近 N 天；custom=日期闭区间。 */
function rangeIso(sel, cf, ct) {
	var now = new Date();
	if (sel === "today") return [new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(), ""];
	if (sel === "3d" || sel === "7d" || sel === "30d") return [new Date(now.getTime() - Number(sel.slice(0, -1)) * 86400000).toISOString(), ""];
	if (sel === "custom") return [cf ? new Date(cf + "T00:00:00").toISOString() : "", ct ? new Date(ct + "T23:59:59").toISOString() : ""];
	return ["", ""];
}
var RANGE_OPTIONS = [["today", "今日"], ["3d", "近3天"], ["7d", "近7天"], ["30d", "近30天"], ["all", "全部"], ["custom", "自定义"]];
/** 空态时间范围提示：当前范围可能滤掉了历史成果。 */
function rangeHint(sel) {
	var names = { today: "今日", "3d": "近3天", "7d": "近7天", "30d": "近30天", all: "全部", custom: "自定义" };
	return "当前时间范围：" + (names[sel] || sel) + "——历史成果请切换上方时间范围";
}
/** 时间范围选择器（大屏与模式页共用）。props: range/customFrom/customTo/onChange(sel,cf,ct) */
function RangePicker(props) {
	return React.createElement("span", { className: "dsh-rtr-rangepicker" },
		React.createElement("select", { className: "dsh-scr-range", value: props.range, onChange: function (e) { props.onChange(e.target.value, props.customFrom, props.customTo); } },
			RANGE_OPTIONS.map(function (r) { return React.createElement("option", { key: r[0], value: r[0] }, r[1]); })),
		props.range === "custom" ? React.createElement("input", { type: "date", className: "dsh-scr-date", value: props.customFrom, onChange: function (e) { props.onChange("custom", e.target.value, props.customTo); } }) : null,
		props.range === "custom" ? React.createElement("input", { type: "date", className: "dsh-scr-date", value: props.customTo, onChange: function (e) { props.onChange("custom", props.customFrom, e.target.value); } }) : null);
}

/** 分布节 v2（紧凑）：标题+色点图例一行 · 分段占比条 · <details> 可折叠明细条形。
 * 默认收起——零占高，统计卡片永不被分布内容拉长；明细展开才显示 DistBars。 */
function distSection(title, items) {
	if (!items || items.length === 0) return null;
	var top = items.slice(0, 8);
	var tot = top.reduce(function (n, i) { return n + i.count; }, 0) || 1;
	return React.createElement("div", { className: "dsh-rtr-distsec" },
		React.createElement("div", { className: "dsh-rtr-disthead" },
			React.createElement("span", { className: "dsh-rtr-disttitle" }, title),
			React.createElement("span", { className: "dsh-rtr-distlegend" }, top.map(function (it, i) {
				return React.createElement("span", { key: it.key, className: "dsh-rtr-distleg", title: it.label + " × " + it.count },
					React.createElement("i", { style: { background: DIST_PALETTE[i % DIST_PALETTE.length] } }), it.label, "·", it.count);
			}))),
		React.createElement("div", { className: "dsh-rtr-segbar" }, top.map(function (it, i) {
			return React.createElement("span", { key: it.key, style: { width: (it.count / tot * 100) + "%", background: DIST_PALETTE[i % DIST_PALETTE.length] }, title: it.label + " × " + it.count });
		})),
		React.createElement("details", { className: "dsh-rtr-distdetails" },
			React.createElement("summary", null, "分布明细"),
			DistBars({ items: items })));
}

var SEV_COLORS = { critical: "#c2182f", high: "#ff4d4d", medium: "#c2650a", low: "#3b7dd8" };

function StatsPanel(props) {
	var stats = props.stats, total = stats.total || 0;
	if (props.archetype === "ledger") {
		// 状态卡按模式词表出（redteam 台账四态、ctf 三态——不出永远为 0 的幽灵卡，卡点可一键过滤）
		var stLabel = props.mode === "ctf-solver" ? CTF_STATUS_LABEL : LEDGER_STATUS_LABEL;
		var lk = props.mode === "ctf-solver" ? ["pending", "stuck", "verified"] : ["pending", "verified", "fixed", "false-positive"];
		var cards = [{ key: "", label: "任务总数", color: null }].concat(lk.map(function (s) {
			return { key: s, label: stLabel[s], color: s === "verified" ? "#2f9e63" : s === "stuck" ? "#c2182f" : s === "fixed" ? "#3b7dd8" : s === "false-positive" ? "#8a8a8f" : "#c2650a" };
		}));
		return React.createElement("div", { className: "dsh-rtr-stats" },
			React.createElement("div", { className: "dsh-rtr-cardsrow" }, cards.map(function (c) {
				var value = c.key === "" ? total : (stats.byStatus[c.key] || 0);
				var active = props.statusFilter === c.key || (c.key === "" && !props.statusFilter);
				return React.createElement("div", { key: c.key || "all", className: "dsh-rtr-statcard" + (active ? "" : " is-dim"), onClick: function () { props.onStatus(c.key); } },
				React.createElement("div", { className: "dsh-rtr-statlabel" }, c.label),
				React.createElement("div", { className: "dsh-rtr-statnum", style: c.color ? { color: c.color } : null }, value));
			})),
			React.createElement("div", { className: "dsh-rtr-statextra" },
				distSection(props.mode === "ctf-solver" ? "模块分布" : "任务形态分布", (stats.byType || []).map(function (x) { return { key: x.type, label: x.type, count: x.count }; })),
				distSection("证据等级分布", ["impact", "confirmed", "partial", "unknown"].map(function (e) { return { key: e, label: EVIDENCE_LABEL[e] || e, count: (stats.byEvidence ? stats.byEvidence[e] : 0) || 0 }; }).filter(function (i) { return i.count > 0; }))));
	}
	if (props.archetype === "assets") {
		// 状态卡按模式词表出（binary=suspect 三态、av=detected 三态——不再出永远为 0 的幽灵卡）
		var stSet = props.mode === "binary-analysis" ? BIN_STATUS_LABEL : props.mode === "av-evasion" ? AV_STATUS_LABEL : ASSET_STATUS_LABEL;
		var stKeys = props.mode === "binary-analysis" ? ["pending", "suspect", "verified"] : props.mode === "av-evasion" ? ["pending", "verified", "detected"] : ["pending", "verified", "false-positive", "fixed"];
		var cards = [{ key: "", label: "总数", color: null }].concat(stKeys.map(function (s) {
			return { key: s, label: stSet[s], color: s === "verified" ? "#2f9e63" : s === "suspect" ? "#c2650a" : s === "false-positive" ? "#8a8a8f" : s === "fixed" ? "#3b7dd8" : "#c2650a" };
		}));
		return React.createElement("div", { className: "dsh-rtr-stats" },
			React.createElement("div", { className: "dsh-rtr-cardsrow" }, cards.map(function (c) {
				var value = c.key === "" ? total : (stats.byStatus[c.key] || 0);
				var active = props.statusFilter === c.key || (c.key === "" && !props.statusFilter);
				return React.createElement("div", { key: c.key || "all", className: "dsh-rtr-statcard" + (active ? "" : " is-dim"), onClick: function () { props.onStatus(c.key); } },
				React.createElement("div", { className: "dsh-rtr-statlabel" }, c.label),
				React.createElement("div", { className: "dsh-rtr-statnum", style: c.color ? { color: c.color } : null }, value));
			})),
			React.createElement("div", { className: "dsh-rtr-statextra" },
				distSection(props.typeLabel, (stats.byType || []).map(function (x) { return { key: x.type, label: x.type, count: x.count }; })),
				props.mode === "binary-analysis" ? distSection("家族分布", (stats.byFamily || []).map(function (c) { return { key: c.family, label: c.family, count: c.count }; })) : null,
				props.mode === "binary-analysis" ? distSection("壳/保护分布", (stats.byPacker || []).map(function (c) { return { key: c.packer, label: c.packer, count: c.count }; })) : null,
				props.mode !== "binary-analysis" ? distSection(props.mode === "attack-defense" ? "目标分布" : "分布", (stats.byTarget || []).filter(function (x) { return x.target !== "（未填）"; }).map(function (x) { return { key: x.target, label: x.target, count: x.count, onClick: function () { props.onTarget(x.target); } }; })) : null));
	}
	if (props.archetype === "timeline") {
		// 状态卡按模式词表出（IR 默认五态全出——code-reviewed=复核通过有语义，补全五卡不缺过滤面）
		var stKeys = ["pending", "code-reviewed", "verified", "false-positive", "fixed"];
		var cards = [{ key: "", label: "节点总数", color: null }].concat(stKeys.map(function (s) {
			return { key: s, label: TIMELINE_STATUS_LABEL[s], color: s === "verified" ? "#2f9e63" : s === "false-positive" ? "#8a8a8f" : s === "fixed" ? "#3b7dd8" : "#c2650a" };
		}));
		return React.createElement("div", { className: "dsh-rtr-stats" },
			React.createElement("div", { className: "dsh-rtr-cardsrow" }, cards.map(function (c) {
				var value = c.key === "" ? total : (stats.byStatus[c.key] || 0);
				var active = props.statusFilter === c.key || (c.key === "" && !props.statusFilter);
				return React.createElement("div", { key: c.key || "all", className: "dsh-rtr-statcard" + (active ? "" : " is-dim"), onClick: function () { props.onStatus(c.key); } },
				React.createElement("div", { className: "dsh-rtr-statlabel" }, c.label),
				React.createElement("div", { className: "dsh-rtr-statnum", style: c.color ? { color: c.color } : null }, value));
			})),
			React.createElement("div", { className: "dsh-rtr-statextra" },
				distSection(props.typeLabel, (stats.byType || []).map(function (x) { return { key: x.type, label: x.type, count: x.count }; })),
				distSection("主机分布", (stats.byTarget || []).filter(function (x) { return x.target !== "（未填）"; }).map(function (x) { return { key: x.target, label: x.target, count: x.count, onClick: function () { props.onTarget(x.target); } }; }))));
	}
	if (props.archetype === "cloudpath") {
		var stKeys = ["pending", "verified", "false-positive", "fixed"];
		var cards = [{ key: "", label: "路径总数", color: null }].concat(stKeys.map(function (s) {
			return { key: s, label: CLOUDPATH_STATUS_LABEL[s], color: s === "verified" ? "#2f9e63" : s === "false-positive" ? "#8a8a8f" : s === "fixed" ? "#3b7dd8" : "#c2650a" };
		}));
		return React.createElement("div", { className: "dsh-rtr-stats" },
			React.createElement("div", { className: "dsh-rtr-cardsrow" }, cards.map(function (c) {
				var value = c.key === "" ? total : (stats.byStatus[c.key] || 0);
				var active = props.statusFilter === c.key || (c.key === "" && !props.statusFilter);
				return React.createElement("div", { key: c.key || "all", className: "dsh-rtr-statcard" + (active ? "" : " is-dim"), onClick: function () { props.onStatus(c.key); } },
				React.createElement("div", { className: "dsh-rtr-statlabel" }, c.label),
				React.createElement("div", { className: "dsh-rtr-statnum", style: c.color ? { color: c.color } : null }, value));
			})),
			React.createElement("div", { className: "dsh-rtr-statextra" },
				distSection(props.typeLabel, (stats.byType || []).map(function (x) { return { key: x.type, label: x.type, count: x.count }; })),
				distSection("严重度分布", SEVERITY_ORDER.map(function (s) { return { key: s, label: SEVERITY_LABEL[s], count: (stats.bySeverity ? stats.bySeverity[s] : 0) || 0, onClick: function () { props.onSeverity(s); } }; }).filter(function (i) { return i.count > 0; })),
				distSection("目标资源分布", (stats.byTarget || []).filter(function (x) { return x.target !== "（未填）"; }).map(function (x) { return { key: x.target, label: x.target, count: x.count, onClick: function () { props.onTarget(x.target); } }; }))));
	}
	var bars = SEVERITY_ORDER.map(function (s) {
		return React.createElement("div", { key: s, title: SEVERITY_LABEL[s] + " " + (stats.bySeverity[s] || 0), style: { width: total > 0 ? ((stats.bySeverity[s] || 0) / total * 100) + "%" : 0, background: SEV_COLORS[s] } });
	});
	var cards = [{ key: "", label: "总数", color: null }].concat(SEVERITY_ORDER.map(function (s) { return { key: s, label: SEVERITY_LABEL[s], color: SEV_COLORS[s] }; }));
	return React.createElement("div", { className: "dsh-rtr-stats" },
		props.mode === 'pentest' && stats.delivery ? React.createElement('div', { role: 'status' }, '已确认漏洞 ' + stats.delivery.ready + '；其他记录 ' + stats.delivery.incomplete) : null,
		React.createElement("div", { className: "dsh-rtr-cardsrow" }, cards.map(function (c) {
			var value = c.key === "" ? total : (stats.bySeverity[c.key] || 0);
			var active = props.severityFilter === c.key || (c.key === "" && !props.severityFilter);
			return React.createElement("div", { key: c.key || "all", className: "dsh-rtr-statcard" + (active ? "" : " is-dim"), onClick: function () { props.onSeverity(c.key); } },
			React.createElement("div", { className: "dsh-rtr-statlabel" }, c.label),
			React.createElement("div", { className: "dsh-rtr-statnum", style: c.color ? { color: c.color } : null }, value));
		})),
		React.createElement("div", { className: "dsh-rtr-statextra" },
			React.createElement("div", { className: "dsh-rtr-bar" }, bars),
			React.createElement("div", { className: "dsh-rtr-chiprow" },
				Object.keys(STATUS_LABEL).map(function (st) {
					return React.createElement("span", {
						key: st, className: "dsh-rtr-typechip",
						style: props.statusFilter === st ? { borderColor: "var(--dsw-alias-state-business-primary,#4c6ef5)", color: "var(--dsw-alias-state-business-primary,#4c6ef5)" } : null,
						onClick: function () { props.onStatus(props.statusFilter === st ? "" : st); }
					}, STATUS_LABEL[st] + " " + (stats.byStatus[st] || 0));
				})),
			distSection(props.typeLabel, (stats.byType || []).map(function (t) { return { key: t.type, label: t.type, count: t.count }; })),
			props.mode === "code-audit" ? distSection("CWE 分布", (stats.byCwe || []).map(function (c) { return { key: c.cwe, label: c.cwe, count: c.count }; })) : null,
			(props.mode === "code-audit" || props.mode === "pentest") ? distSection("来源", (stats.bySource || []).map(function (c) { return { key: c.source, label: SOURCE_LABEL[c.source] || c.source, count: c.count }; })) : null,
			props.mode === "code-audit" ? distSection("审计形态", (stats.byAuditMode || []).map(function (c) { return { key: c.auditMode, label: AUDIT_MODE_LABEL[c.auditMode] || c.auditMode, count: c.count }; })) : null,
			props.mode === "binary-analysis" ? distSection("家族分布", (stats.byFamily || []).map(function (c) { return { key: c.family, label: c.family, count: c.count }; })) : null,
			props.mode === "binary-analysis" ? distSection("壳/保护分布", (stats.byPacker || []).map(function (c) { return { key: c.packer, label: c.packer, count: c.count }; })) : null,
			props.mode === "pentest" ? distSection("目标分布", (stats.byTarget || []).filter(function (t) { return t.target !== "（未填）"; }).map(function (t) { return { key: t.target, label: t.target, count: t.count, onClick: function () { props.onTarget(t.target); } }; })) : null));
}

function MetaBar(props) {
	var meta = props.meta || { targetLabel: "", version: "", scope: "" };
	var labels = props.labels;
	if (!props.editing) {
		var empty = !meta.targetLabel && !meta.version && !meta.scope;
		if (empty) {
			return React.createElement("div", { className: "dsh-rtr-meta is-ghost" },
				React.createElement("span", null, labels[0] + "未设置（导出报告将标注为未填写）"),
				React.createElement("span", { style: { flex: 1 } }),
				React.createElement("button", { type: "button", className: "dsh-rtr-metalink", onClick: props.onEdit }, "设置"));
		}
		return React.createElement("div", { className: "dsh-rtr-meta" },
			React.createElement("span", null, labels[0], React.createElement("b", null, meta.targetLabel || "未填写")),
			React.createElement("span", null, labels[1], React.createElement("b", null, meta.version || "未填写")),
			React.createElement("span", null, "范围", React.createElement("b", null, meta.scope || "未填写")),
			React.createElement("span", { style: { flex: 1 } }),
			React.createElement(Btn, { onClick: props.onEdit }, "编辑"));
	}
	return React.createElement("div", { className: "dsh-rtr-meta" },
		React.createElement("span", null, labels[0], React.createElement("input", { value: props.draft.targetLabel, onChange: function (e) { props.onDraft("targetLabel", e.target.value); }, placeholder: "对象/范围" })),
		React.createElement("span", null, labels[1], React.createElement("input", { value: props.draft.version, onChange: function (e) { props.onDraft("version", e.target.value); }, placeholder: "版本/commit" })),
		React.createElement("span", null, "范围", React.createElement("input", { value: props.draft.scope, onChange: function (e) { props.onDraft("scope", e.target.value); }, placeholder: "scope" })),
		React.createElement(Btn, { primary: true, onClick: props.onSave }, "保存"),
		React.createElement(Btn, { onClick: props.onCancel }, "取消"));
}

function Detail(props) {
	var deliveryError = useState('');
	// 原始报文默认遮蔽账号密钥；用户明确展开时才在本地显示（v6 第 5.3 节）。
	var revealPackets = useState(false);
	var f = props.f, mode = props.mode;
	var meta = props.meta || MODE_META.pentest;
	var curationText = [f.title, f.summary, f.description, f.poc, f.evidence, f.chain, f.impact]
		.filter(function (value) { return typeof value === 'string' && value.trim(); }).join('\n\n').slice(0, 16384);
	var curationButton = React.createElement(CurationAction, { sessionId: props.sessionId,
		selectedText: curationText, sourceRef: 'finding:' + String(f.id || ''), disabled: !curationText.trim() });
	var audit = mode === "code-audit";
	var binary = mode === "binary-analysis";
	if (meta.archetype === "ledger") {
		return React.createElement("div", { className: "dsh-rtr-detail" },
			React.createElement("div", { className: "dsh-rtr-fields" },
				React.createElement("span", null, meta.kindLabel, React.createElement("b", null, f.type || "未分类")),
				React.createElement("span", null, meta.locLabel, React.createElement("b", null, f.target || "未填写")),
				React.createElement("span", null, "状态", React.createElement("b", null, (mode === "ctf-solver" ? CTF_STATUS_LABEL : LEDGER_STATUS_LABEL)[f.status] || f.status)),
				mode === "ctf-solver" ? null : React.createElement("span", null, "优先级", React.createElement("b", null, SEVERITY_LABEL[f.severity] || f.severity)),
				React.createElement("span", null, "证据等级", React.createElement("b", null, EVIDENCE_LABEL[f.evidenceLevel] || f.evidenceLevel)),
				React.createElement("span", null, "登记时间", React.createElement("b", null, fmtTime(f.createdAt))),
				f.verifiedAt ? React.createElement("span", null, "验证时间", React.createElement("b", null, fmtTime(f.verifiedAt))) : null),
			f.description || f.summary ? Block({ title: meta.descLabel }, f.description || f.summary) : null,
			f.chain ? Block({ title: meta.chainLabel }, f.chain) : null,
			f.poc ? Block({ title: meta.pocTitle }, f.poc) : null,
			f.evidence ? Block({ title: "任务书 / 材料路径" }, f.evidence) : null,
			f.fix ? Block({ title: "备注 / 风险提示" }, f.fix) : null,
			f.secondRating ? Block({ title: "二次评级（独立复核）" }, f.secondRating + verdictSuffix(f) + (f.secondRatingNote ? "\n依据：" + f.secondRatingNote : "")) : null,
		f.verifyNote ? Block({ title: "复核记录" }, f.verifyNote) : null,
			React.createElement("div", { className: "dsh-rtr-rowactions" },
				React.createElement(Btn, { onClick: function () { props.onVerify(f); } }, "独立复核（可选）"),
				curationButton,
				React.createElement(Btn, { onClick: function () { props.onExportOne(f); } }, "导出任务卡（MD）")));
	}
	if (meta.archetype === "assets") {
		return React.createElement("div", { className: "dsh-rtr-detail" },
			React.createElement("div", { className: "dsh-rtr-fields" },
				React.createElement("span", null, meta.kindLabel, React.createElement("b", null, f.type || "未分类")),
				React.createElement("span", null, meta.locLabel, React.createElement("b", { style: { fontFamily: "monospace" } }, f.target || "未填写")),
				React.createElement("span", null, "状态", React.createElement("b", null, statusLabelSetFor("assets", mode)[f.status] || f.status)),
				React.createElement("span", null, "证据等级", React.createElement("b", null, EVIDENCE_LABEL[f.evidenceLevel] || f.evidenceLevel)),
				f.sampleHash ? React.createElement("span", null, "关联样本", React.createElement("b", { style: { fontFamily: "monospace" } }, f.sampleHash.slice(0, 16) + "…")) : null,
				f.family ? React.createElement("span", null, "家族", React.createElement("b", null, f.family)) : null,
				f.packer ? React.createElement("span", null, "壳", React.createElement("b", null, f.packer)) : null,
				React.createElement("span", null, "登记时间", React.createElement("b", null, fmtTime(f.createdAt))),
				f.verifiedAt ? React.createElement("span", null, "验证时间", React.createElement("b", null, fmtTime(f.verifiedAt))) : null),
			mode === "binary-analysis" && f.impact ? Block({ title: "能力与危害" }, f.impact) : null,
			f.description || f.summary ? Block({ title: meta.descLabel }, f.description || f.summary) : null,
			f.chain ? Block({ title: meta.chainLabel }, f.chain) : null,
			f.poc ? Block({ title: meta.pocTitle }, f.poc) : null,
			mode === "attack-defense" && (f.baseline || f.diffEvidence) ? React.createElement("div", { className: "dsh-rtr-duo" },
				React.createElement("div", null, React.createElement("h4", { style: { margin: "0 0 4px", fontSize:'var(--dsh-content-font-size-secondary,0.93em)', color: "#8a8a8f" } }, "对照三件套 · 基线"), React.createElement("pre", null, f.baseline || "（未填）")),
				React.createElement("div", null, React.createElement("h4", { style: { margin: "0 0 4px", fontSize:'var(--dsh-content-font-size-secondary,0.93em)', color: "#8a8a8f" } }, "差分（翻转）"), React.createElement("pre", null, f.diffEvidence || "（未填）"))) : null,
			mode === "attack-defense" && f.markerEcho ? Block({ title: "marker 逐字回显" }, f.markerEcho) : null,
			mode === "attack-defense" && f.requestPkt ? Block({ title: "完整请求包" }, f.requestPkt) : null,
			mode === "attack-defense" && f.responsePkt ? Block({ title: "关键响应" }, f.responsePkt) : null,
			f.iocs ? Block({ title: mode === "av-evasion" ? "环境 / 引擎效果清单" : "IOC 清单" }, f.iocs) : null,
			f.detectionRule ? Block({ title: "检测规则（YARA/Sigma）" }, f.detectionRule) : null,
			f.evidence ? Block({ title: "证据引用" }, f.evidence) : null,
			f.fix ? Block({ title: mode === "binary-analysis" ? "处置建议" : "备注" }, f.fix) : null,
			f.verifyNote ? Block({ title: "验证记录" }, f.verifyNote) : null,
			React.createElement("div", { className: "dsh-rtr-rowactions" },
				React.createElement(Btn, { onClick: function () { props.onVerify(f); } }, "独立复核（可选）"),
				curationButton,
				React.createElement(Btn, { onClick: function () { props.onExportOne(f); } }, "导出资产卡片（MD）")));
	}
	if (meta.archetype === "timeline") {
		return React.createElement("div", { className: "dsh-rtr-detail" },
			React.createElement("div", { className: "dsh-rtr-fields" },
				React.createElement("span", null, "攻击时间", React.createElement("b", { style: { fontFamily: "monospace" } }, fmtTimelineAt(f.timelineAt))),
				React.createElement("span", null, meta.kindLabel, React.createElement("b", null, f.type || "未分类")),
				React.createElement("span", null, meta.locLabel, React.createElement("b", { style: { fontFamily: "monospace" } }, f.target || "未填写")),
				React.createElement("span", null, "严重度", React.createElement("b", null, SEVERITY_LABEL[f.severity] || f.severity)),
				React.createElement("span", null, "状态", React.createElement("b", null, TIMELINE_STATUS_LABEL[f.status] || f.status)),
				React.createElement("span", null, "证据等级", React.createElement("b", null, EVIDENCE_LABEL[f.evidenceLevel] || f.evidenceLevel)),
				React.createElement("span", null, "登记时间", React.createElement("b", null, fmtTime(f.createdAt))),
				f.verifiedAt ? React.createElement("span", null, "验证时间", React.createElement("b", null, fmtTime(f.verifiedAt))) : null),
			f.description ? Block({ title: meta.descLabel }, f.description) : null,
			f.poc ? Block({ title: meta.pocTitle }, f.poc) : null,
			f.summary ? Block({ title: "结论" }, f.summary) : null,
			f.chain ? Block({ title: meta.chainLabel }, f.chain) : null,
			f.evidence ? Block({ title: "证据引用" }, f.evidence) : null,
			f.fix ? Block({ title: "处置建议" }, f.fix) : null,
			f.verifyNote ? Block({ title: "复核注记" }, f.verifyNote) : null,
			React.createElement("div", { className: "dsh-rtr-rowactions" },
				React.createElement(Btn, { onClick: function () { props.onVerify(f); } }, "发送到会话复核"),
				curationButton,
				React.createElement(Btn, { onClick: function () { props.onExportOne(f); } }, "导出节点卡（MD）")));
	}
	if (meta.archetype === "cloudpath") {
		var hop = function (label, value) {
			return React.createElement("div", { className: "dsh-rtr-cp-hop" },
				React.createElement("span", { className: "dsh-rtr-cp-hoplabel" }, label),
				React.createElement("span", { className: "dsh-rtr-cp-hopval" }, value || "（未填写）"));
		};
		return React.createElement("div", { className: "dsh-rtr-detail" },
			React.createElement("div", { className: "dsh-rtr-fields" },
				React.createElement("span", null, meta.kindLabel, React.createElement("b", null, f.type || "未分类")),
				React.createElement("span", null, meta.locLabel, React.createElement("b", { style: { fontFamily: "monospace" } }, f.resource || f.target || "未填写")),
				React.createElement("span", null, "严重度", React.createElement("b", null, SEVERITY_LABEL[f.severity] || f.severity)),
				React.createElement("span", null, "状态", React.createElement("b", null, CLOUDPATH_STATUS_LABEL[f.status] || f.status)),
				React.createElement("span", null, "证据等级", React.createElement("b", null, EVIDENCE_LABEL[f.evidenceLevel] || f.evidenceLevel)),
				React.createElement("span", null, "登记时间", React.createElement("b", null, fmtTime(f.createdAt))),
				f.verifiedAt ? React.createElement("span", null, "验证时间", React.createElement("b", null, fmtTime(f.verifiedAt))) : null),
			(f.entry || f.identity || f.permission || f.resource) ? React.createElement("div", { className: "dsh-rtr-block" },
				React.createElement("h4", null, "攻击路径链（入口→身份→权限→资源→影响）"),
				React.createElement("div", { className: "dsh-rtr-cp-chain" },
					hop("① 入口凭证/身份", f.entry),
					hop("② 利用身份", f.identity),
					hop("③ 权限", f.permission),
					hop("④ 目标资源", f.resource || f.target),
					React.createElement("div", { className: "dsh-rtr-cp-hop dsh-rtr-cp-impact" },
						React.createElement("span", { className: "dsh-rtr-cp-hoplabel" }, "⑤ 影响证明"),
						React.createElement("span", { className: "dsh-rtr-cp-hopval" }, f.impact || f.summary || "（未填写）")))) : null,
			f.description ? Block({ title: meta.descLabel }, f.description) : null,
			f.poc ? Block({ title: meta.pocTitle }, f.poc) : null,
			f.summary ? Block({ title: "结论" }, f.summary) : null,
			f.chain ? Block({ title: meta.chainLabel }, f.chain) : null,
			f.evidence ? Block({ title: "证据引用" }, f.evidence) : null,
			f.fix ? Block({ title: "修复建议" }, f.fix) : null,
			f.verifyNote ? Block({ title: "复核注记" }, f.verifyNote) : null,
			React.createElement("div", { className: "dsh-rtr-rowactions" },
				React.createElement(Btn, { onClick: function () { props.onVerify(f); } }, "发送到会话验证"),
				curationButton,
				React.createElement(Btn, { onClick: function () { props.onExportOne(f); } }, "导出路径卡（MD）")));
	}
	return React.createElement("div", { className: "dsh-rtr-detail" },
		// 关闭放在面板顶部的固定头部（v6 第 5.3 节）：长详情滚动到底也随时能关。
		props.onClose ? React.createElement("div", { className: "dsh-rtr-detail-head" },
			React.createElement(Btn, { onClick: function () { props.onClose(); } }, "关闭")) : null,
		// 详情顺序固定（v6 第 5.3 节）：一句话结论与影响 → 目标和身份条件 → 本次原始依据/关键差异
		// → 尚缺条件 → 历次复测。结论与影响排在最前，别被后面的字段挤下去。
		mode === "pentest" && (f.summary || f.description || f.impact)
			? Block({ title: "结论与影响" }, [f.summary, f.description, f.impact].filter(Boolean).join("\n\n"))
			: null,
		// 「复测中」给出对应运行链接（v6 第 5.3 节）：不另起重复会话，直接指到本任务的执行记录。
		f.verifying ? React.createElement("div", { className: "dsh-rtr-block" },
			React.createElement("h4", null, "复测中"),
			React.createElement("p", null, "复测请求已发送到原会话，等待结论；本次执行记录见「执行记录」。"),
			props.onOpenExecution ? React.createElement(Btn, { onClick: function () { props.onOpenExecution(); } }, "查看执行记录") : null) : null,
		props.workerReview ? Block({ title: "独立复核" }, props.workerReview.text) : null,
		React.createElement("div", { className: "dsh-rtr-fields" },
			React.createElement("span", null, audit ? "主线类型" : binary ? "结论类型" : "类型", React.createElement("b", null, f.type || "未分类")),
			binary && f.family ? React.createElement("span", null, "家族", React.createElement("b", null, f.family)) : null,
			binary && f.packer ? React.createElement("span", null, "壳", React.createElement("b", null, f.packer)) : null,
			binary && f.sampleHash ? React.createElement("span", null, "SHA256", React.createElement("b", null, f.sampleHash.slice(0, 16) + "…")) : null,
			audit && f.cwe ? React.createElement("span", null, "CWE", React.createElement("b", null, f.cwe)) : null,
			f.cvss ? React.createElement("span", null, "CVSS", React.createElement("b", null, f.cvss.slice(0, 40))) : null,
			React.createElement("span", null, "证据等级", React.createElement("b", null, EVIDENCE_LABEL[f.evidenceLevel] || f.evidenceLevel)),
			React.createElement("span", null, audit ? "sink 位置" : "地址", React.createElement("b", null, f.target || "未填写")),
			React.createElement("span", null, "发现时间", React.createElement("b", null, fmtTime(f.createdAt))),
			f.verifiedAt ? React.createElement("span", null, "验证时间", React.createElement("b", null, fmtTime(f.verifiedAt))) : null,
			(audit || mode === "pentest") ? React.createElement("span", null, "来源", React.createElement("b", null, SOURCE_LABEL[f.sourceOrigin] || f.sourceOrigin)) : null,
			audit && f.auditMode ? React.createElement("span", null, "审计形态", React.createElement("b", { style: f.auditMode === "dynamic" ? { color: "#2f9e63" } : null }, AUDIT_MODE_LABEL[f.auditMode] || f.auditMode)) : null),
		mode !== "pentest" && f.description ? Block({ title: binary ? "定性依据（结论摘要）" : "描述" }, f.description) : null,
		mode !== "pentest" && !audit && f.impact ? Block({ title: binary ? "能力与危害" : "影响证明" }, f.impact) : null,
		mode === "pentest" && (f.baseline || f.diffEvidence || f.markerEcho) ? React.createElement("div", { className: "dsh-rtr-duo" },
			React.createElement("div", null, React.createElement("h4", { style: { margin: "0 0 4px", fontSize:'var(--dsh-content-font-size-secondary,0.93em)', color: "#8a8a8f" } }, "对照三件套 · 基线"), React.createElement("pre", null, f.baseline || "（未填）")),
			React.createElement("div", null, React.createElement("h4", { style: { margin: "0 0 4px", fontSize:'var(--dsh-content-font-size-secondary,0.93em)', color: "#8a8a8f" } }, "差分（翻转）"), React.createElement("pre", null, f.diffEvidence || "（未填）"))) : null,
		mode === "pentest" && f.markerEcho ? Block({ title: "marker 逐字回显" }, f.markerEcho) : null,
		audit && (f.chain || f.chainTracer) ? React.createElement("div", { className: "dsh-rtr-block" },
			React.createElement("h4", null, "双链对照（entry → sink）"),
			React.createElement("div", { className: "dsh-rtr-duo" },
				React.createElement("div", null, React.createElement("h4", { style: { margin: "0 0 4px", fontSize:'var(--dsh-content-font-size-secondary,0.93em)', color: "#8a8a8f" } }, "审计工人链"), React.createElement("pre", null, f.chain || "（未填）")),
				React.createElement("div", null, React.createElement("h4", { style: { margin: "0 0 4px", fontSize:'var(--dsh-content-font-size-secondary,0.93em)', color: "#8a8a8f" } }, "追踪员链（独立重追）"), React.createElement("pre", null, f.chainTracer || "（未填）"))),
			f.chainVerdict ? React.createElement("div", { className: "dsh-rtr-verdict", style: { marginTop: 8 } }, "一致性结论：" + f.chainVerdict) : null) : null,
		!audit && f.chain ? Block({ title: binary ? "执行链 / 还原链路" : "调用链（entry → sink）" }, f.chain) : null,
		audit && (f.snippetEntry || f.snippetSink) ? React.createElement("div", { className: "dsh-rtr-block" },
			React.createElement("h4", null, "关键代码"),
			React.createElement("div", { className: "dsh-rtr-duo" },
				React.createElement("div", null, React.createElement("h4", { style: { margin: "0 0 4px", fontSize:'var(--dsh-content-font-size-secondary,0.93em)', color: "#8a8a8f" } }, "入口 entry"), React.createElement("pre", null, f.snippetEntry || "（未填）")),
				React.createElement("div", null, React.createElement("h4", { style: { margin: "0 0 4px", fontSize:'var(--dsh-content-font-size-secondary,0.93em)', color: "#8a8a8f" } }, "危险点 sink"), React.createElement("pre", null, f.snippetSink || "（未填）")))) : null,
		f.poc ? Block({ title: meta.pocTitle }, f.poc) : null,
		binary && f.iocs ? Block({ title: "IOC 清单" }, f.iocs) : null,
		deliveryError[0] ? Block({ title: '导出失败' }, deliveryError[0]) : null,
    mode === 'pentest' ? React.createElement(EffectEvidenceView, { finding: f, onReviewed: props.onEffectReview }) : null,
		binary && f.detectionRule ? Block({ title: "检测规则（YARA/Sigma）" }, f.detectionRule) : null,
		// 原文 HTTP 双栏查看（v6 第 5.3 节）：默认遮蔽账号密钥，展开只在本地显示，不增加模型输入。
		mode === "pentest" && (f.requestPkt || f.responsePkt) ? React.createElement("div", { className: "dsh-rtr-block" },
			React.createElement("h4", null, "原始依据（请求 / 响应）"),
			React.createElement("div", { className: "dsh-rtr-duo dsh-rtr-packets" },
				React.createElement("div", null, React.createElement("h4", { style: { margin: "0 0 4px", fontSize:'var(--dsh-content-font-size-secondary,0.93em)', color: "#8a8a8f" } }, "请求原文"),
					React.createElement("pre", null, revealPackets[0] ? (f.requestPkt || "（未保存）") : maskSecrets(f.requestPkt || "（未保存）"))),
				React.createElement("div", null, React.createElement("h4", { style: { margin: "0 0 4px", fontSize:'var(--dsh-content-font-size-secondary,0.93em)', color: "#8a8a8f" } }, "响应原文"),
					React.createElement("pre", null, revealPackets[0] ? (f.responsePkt || "（未保存）") : maskSecrets(f.responsePkt || "（未保存）")))),
			React.createElement("div", { className: "dsh-rtr-packet-actions" },
				React.createElement("small", null, revealPackets[0]
					? "当前显示本地原文，包含账号密钥；只在本机查看，不会因此增加模型输入。"
					: "账号密钥默认已遮蔽；需要本地核对时再展开。"),
				React.createElement(Btn, { onClick: function () { revealPackets[1](!revealPackets[0]); } },
					revealPackets[0] ? "重新遮蔽" : "展开原始内容"))) : null,
		f.evidence ? Block({ title: "证据引用" }, f.evidence) : null,
		// 「尚缺条件」排在原始依据之后（v6 第 5.3 节顺序）：先说依据，再说还缺什么。
		mode === 'pentest' && f.delivery ? Block({ title: '利用交付' },
			f.delivery.ready ? '材料完整；复现' + (f.delivery.reproductionVerified ? '已实测' : '尚未运行')
				: '材料待补齐：' + f.delivery.missing.join('、')) : null,
		mode === 'pentest' && f.delivery && !f.delivery.ready && f.executionEvidence && (f.executionEvidence.reason || f.executionEvidence.impactReason)
			? Block({ title: '需要重新核对' }, f.executionEvidence.reason || f.executionEvidence.impactReason) : null,
		f.fix ? Block({ title: binary ? "处置建议" : "修复建议" }, f.fix) : null,
		audit && f.patch ? Block({ title: "修复 diff 建议" }, f.patch) : null,
		f.verifyNote ? Block({ title: "复核注记" }, f.verifyNote) : null,
		f.retestNote ? Block({ title: "复测记录" }, f.retestNote + (f.retestAt ? "（" + fmtTime(f.retestAt) + "）" : "")) : null,
		// 结构化复测（v6 第 9.2 节）：三结论的最新一次 + 次数；详细历史按需读取。
		f.retest ? Block({ title: "复测（" + f.retest.count + " 次）" }, f.retest.latest.verdictLabel + " · " + fmtTime(f.retest.latest.at)) : null,
		React.createElement("div", { className: "dsh-rtr-rowactions" },
			mode === "code-audit" ? React.createElement(Btn, { primary: true, onClick: function () { props.onLiveVerify ? props.onLiveVerify(f) : null; } }, "实测") : null,
			// 底部操作按 v6 第 5.3 节的叫法：复核/复测、导出这条发现（功能不变）。
			props.onVerify ? React.createElement(Btn, { onClick: function () { props.onVerify(f); } }, "复核/复测") : null,
			mode === "pentest" && props.onWorkerReview
				? React.createElement(Btn, { disabled: props.workerReviewBusy, onClick: function () { props.onWorkerReview(f); } },
		props.workerReviewBusy ? "独立复核中…" : "请求独立复核") : null,
			props.onExportOne ? React.createElement(Btn, { onClick: function () { props.onExportOne(f); } }, "导出这条发现") : null,
			curationButton,
			mode === 'pentest' && f.delivery && f.delivery.ready ? React.createElement(Btn, { onClick: function () {
				api('finding.delivery', { sessionId: f.sessionId || props.sessionId, id: f.id }).then(function (result) {
					if (result.ok) { if (props.onPreview) props.onPreview(result.filename, result.text); else download(result.filename, result.text); }
					else deliveryError[1](result.error || '交付材料不完整');
				}).catch(function (error) { deliveryError[1](error.message || String(error)); });
			} }, '导出完整利用方法') : null));
}

function EffectEvidenceView(props) {
  var f=props.finding, host=f&&f.executionEvidence, saved=useState(null), note=useState(''), ids=useState((host&&host.receiptIds||[]).join(', ')), permission=useState(false), impact=useState(false), restoration=useState(false), rating=useState('high'), notice=useState(''), busy=useState(false);
  var evidence=saved[0]||(host&&host.effectEvidence);
  if(evidence) return React.createElement('details',{'aria-label':'独立影响对照',style:{margin:'12px 0'}},
    React.createElement('summary',null,(evidence.source==='desktop-impact-review'?'桌面人工复核':'自动影响对照')+' · '+evidence.kind),
    React.createElement('p',null,evidence.source==='desktop-impact-review'?'这是操作人的独立判断；不是程序自动证明，也不证明RCE。':'按已审阅业务条件比较两轮真实执行；结论限于对应对象、身份和执行时间。'),
    React.createElement('pre',{style:{whiteSpace:'pre-wrap',maxHeight:360,overflow:'auto'}},JSON.stringify(evidence,null,2)));
  if(!host||!host.verified||['access','write','other-impact'].indexOf(f.proofKind)<0)return null;
  function submit(){busy[1](true);notice[1]('');return api('finding.impact-review',{sessionId:f.sessionId,id:f.id,note:note[0],receiptIds:ids[0].split(/[\s,，]+/).filter(Boolean),permissionsConfirmed:permission[0],impactConfirmed:impact[0],restorationConfirmed:restoration[0],secondRating:rating[0]}).then(function(value){if(!value.ok)throw Error(typeof value.error==='string'?value.error:(value.error&&value.error.message)||'复核保存失败');saved[1](value.review);if(props.onReviewed)return props.onReviewed();}).catch(function(error){notice[1](error.message);}).finally(function(){busy[1](false);});}
  function check(state,label){return React.createElement('label',{style:{display:'block',margin:'8px 0'}},React.createElement('input',{type:'checkbox',checked:state[0],onChange:function(event){state[1](event.target.checked);}}),label);}
  return React.createElement('details',{'aria-label':'人工复核实际效果',style:{margin:'12px 0'}},React.createElement('summary',null,'人工复核实际效果'),
    React.createElement('p',null,'程序已保存正常与异常请求。请独立核对角色、对象和真实业务效果；状态码、success或菜单变化不足以确认。写入测试还需效果和还原的两次实际读取回执。'),
    React.createElement('label',null,'实际证据回执ID（逗号分隔）',React.createElement('textarea',{'aria-label':'效果证据回执',value:ids[0],onChange:function(event){ids[1](event.target.value);},style:{width:'100%'}})),
    React.createElement('label',null,'复核依据：角色、对象、影响、局限及恢复情况',React.createElement('textarea',{'aria-label':'效果复核依据',value:note[0],onChange:function(event){note[1](event.target.value);},style:{width:'100%',minHeight:80}})),
    check(permission,'已核对该身份本不应具有对应权限'),check(impact,'已核对独立证据中的实际效果'),f.proofKind==='write'?check(restoration,'已核对受控对象恢复到原状态'):null,
    React.createElement('label',null,'独立评级',React.createElement('select',{value:rating[0],onChange:function(event){rating[1](event.target.value);}},['critical','high','medium','low','info'].map(function(value){return React.createElement('option',{key:value,value:value},value);}))),
    React.createElement(Btn,{onClick:submit,disabled:busy[0]},busy[0]?'正在保存':'保存人工复核'),notice[0]?React.createElement('div',{role:'alert'},notice[0]):null);
}
function exampleTemplates(mode) {
  var examples = {
    regular: [
      ['我只有机构名称', '机构：[机构名称]。\n请先找出官网和主要业务入口，告诉我从哪里开始。测试前先确认范围。', '适合还没有网站清单，先整理入口。'],
      ['我有一个网站', '网站：[网站地址]。\n允许测试的范围：[测试范围]。\n请先了解主要功能，再检查可能的安全问题。', '适合已经知道要检查哪个网站。'],
      ['我有一条请求', '我已附上请求和响应。\n想检查：[想检查的问题]。\n请解释这条请求在做什么，再核查这个问题。', '适合已经抓到请求，不知道是否有问题。']
    ],
    nday: [
      ['我知道产品名称', '网站：[网站地址]。\n产品和版本：[产品名称及版本，不知道版本可写未知]。\n请查相关公开漏洞，先判断是否适用，再在已确认的范围内验证。', '适合知道系统用了什么产品，例如某个CMS。'],
      ['接着已有资料检查', '请继续使用本会话已有的资料，检查相关公开漏洞。\n先确认漏洞是否适用，再验证；缺什么资料就告诉我。', '适合此前已经整理过网站或产品，不用重新填写。'],
      ['我有扫描结果', '我已附上扫描结果。\n请帮我核实哪些确实有问题，哪些可能是误报，并说明依据。', '适合复核扫描器给出的结果。']
    ],
    '0day': [
      ['深入检查一个功能', '网站：[网站地址]。\n想检查的功能：[功能名称，例如导出或审批]。\n请先说明正常流程，再在已确认的范围内检查权限和业务逻辑。', '适合已经选定一个功能，想继续深入。'],
      ['我有页面或JS文件', '我已附上页面或JS文件。\n请分段分析，找出值得继续核查的接口或功能，并说明理由。\n需要实际请求时告诉我。', '适合从已有页面或前端代码寻找线索。'],
      ['我发现一个异常', '异常现象：[发生了什么]。\n我已附上相关材料。\n请先解释可能的原因，再核实是否真的存在安全问题。', '适合追查意外返回、权限差异或业务异常。']
    ]
  };
  return (examples[mode] || []).concat([['补充我的思路','我的问题或怀疑：[用自己的话描述]。\n请结合已有资料帮我核查，告诉我哪些事实支持或不支持这个判断。','适合补充你观察到的现象、业务背景或怀疑。']]).map(function (row) { return { title: row[0], text: row[1], hint: row[2] }; });
}
// v6 第 5.5 节稳定值：询问时机 auto/confirm-data-change/confirm-step；汇报 end/notable/step。
// 旧值 continuous/milestone、confirm、guided 与 summary/milestone 只做只读迁移。
var CHAT_LEGACY_INTERACTION={continuous:'auto',milestone:'auto',confirm:'confirm-step',guided:'confirm-step'};
var CHAT_LEGACY_REPORTING={summary:'end',milestone:'step'};
function chatReporting(value) { var r=(value&&value.reporting)||(value&&value.interaction==='milestone'?'step':'end'); return CHAT_LEGACY_REPORTING[r]||r; }
function cooperationValue(value) { return CHAT_LEGACY_INTERACTION[value]||value||'auto'; }
var CHAT_COOPERATION = {auto:'自行推进','confirm-data-change':'改动网站数据前问我','confirm-step':'每个检查步骤前问我'};
var CHAT_COOPERATION_HINT = {auto:'在已确认的范围和操作权限内继续；缺账号或关键信息时集中询问。','confirm-data-change':'读取和分析继续；提交、修改或删除业务数据前先确认当前操作及预计影响。','confirm-step':'先说明本步骤要检查什么，确认后执行该步骤内必要调用；不为每条请求重复弹窗。'};
var CHAT_REPORTING = {end:'任务结束时',notable:'发现问题或需要帮助时',step:'每完成一个检查步骤时'};
__SAKER_ICONS__
function InteractionControl(props) {
  return React.createElement('div',{style:{marginTop:12}},
    React.createElement('label',{className:'dsh-task-field'},React.createElement('span',null,'什么时候问我'),React.createElement('select',{'aria-label':'什么时候问我',value:cooperationValue(props.interaction),disabled:props.disabled,onChange:function(e){return props.onChange(e.target.value);}},
      ['auto','confirm-data-change','confirm-step'].map(function(value){return React.createElement('option',{key:value,value:value},CHAT_COOPERATION[value]);}))),
    React.createElement('p',{style:{fontSize:'var(--dsh-content-font-size-secondary,0.93em)'}},CHAT_COOPERATION_HINT[cooperationValue(props.interaction)]));
}
function FlowControls(props) {
  return React.createElement('div',null,
    React.createElement('label',{className:'dsh-task-field'},React.createElement('span',null,'并行任务上限'),React.createElement('input',{type:'number',min:0,max:16,step:1,'aria-label':'并行任务上限',value:props.workers??2,disabled:props.disabled,onChange:function(e){var n=Number(e.target.value);if(e.target.value!==''&&Number.isInteger(n)&&n>=0&&n<=16)props.onChange({workers:n});}})),
    React.createElement(InteractionControl,{interaction:props.interaction,disabled:props.disabled,onChange:function(value){return props.onChange({interaction:value});}}));
}
// 统一错误文案（v6 第 9.3 节）：接口错误含 code / 具体 message / 可恢复操作，
// 这里把 message 与 hint 一起给用户看，别只丢一句「操作失败」。
function chatError(value) {
  if (typeof value === 'string') return value;
  if (!value) return '操作失败，请重试';
  var message = value.error || value.message || '操作失败，请重试';
  return value.hint ? message + '（' + value.hint + '）' : message;
}
// 用户主动选用的任务文字。示例、个人模板与会话草稿分别保存，插入不发送。
var PROMPT_FAVORITES_KEY='saker.prompt.favorites';
function promptSubstitute(tpl, values, fields) {
  return String(tpl.text).replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, function (_m, key) {
    var raw = values[key];
    if (raw !== undefined && raw !== null && String(raw).trim() !== '') return String(raw);
    return (fields[key] && fields[key].default) || '';
  });
}
function promptMissing(tpl, values, fields) {
  return (tpl.required || []).filter(function (k) { return !(values[k] && String(values[k]).trim()); })
    .map(function (k) { return (fields[k] && fields[k].label) || k; });
}
function loadPromptFavorites() { try { return JSON.parse(window.localStorage.getItem(PROMPT_FAVORITES_KEY)) || []; } catch (error) { return []; } }
function savePromptFavorites(list) { try { window.localStorage.setItem(PROMPT_FAVORITES_KEY, JSON.stringify(list)); } catch (error) { /* localStorage 不可用则仅本次会话有效 */ } }
function promptVisibleRows(rows, scope, query, favorites) {
  var q=String(query||'').trim().toLowerCase(), favoriteIds=favorites||[];
  return rows.filter(function(row){
    if(scope==='mine'&&row.builtin)return false;
    if(q)return [row.id,row.title,row.group].concat(row.keywords||[]).join(' ').toLowerCase().indexOf(q)>=0;
    if(scope==='common')return row.common===true||favoriteIds.indexOf(row.id)>=0;
    return true;
  }).slice().sort(function(a,b){return (favoriteIds.indexOf(a.id)>=0?0:1)-(favoriteIds.indexOf(b.id)>=0?0:1);});
}
function ChatPromptEditor(props) {
  var lib=useState(null), query=useState(''), queryDraft=useState(''), scope=useState('common'), selectedId=useState('');
  var values=useState({}), text=useState(''), editMode=useState('fields');
  var saveState=useState(''), notice=useState(''), busy=useState(false), optional=useState(false);
  var importNotice=useState(''), importRef=useRef(null);
  var drafts=useState({}), favorites=useState(loadPromptFavorites()), conflict=useState(null), saveAsName=useState('');
  var draftRev=useRef(0), alive=useRef(true), pending=useRef(Promise.resolve()), openBtn=useRef(null), focusDone=useRef(false), composing=useRef(false);
  // 当前选中的模板：persist 的回调是异步的，闭包里的 selectedId[0] 是**发起那次渲染**的值，
  // 用它判断"存的还是不是当前模板"会误判（真机复现：切模板后新模板的保存被旧 revision 顶掉）。
  var selectedRef=useRef('');
  var dirty=useRef(false), debounce=useRef(0);
  var fields=lib[0]?lib[0].fields:{};
  var all=lib[0]?lib[0].builtin.concat(lib[0].user.templates):[];
  if(selectedId[0]==='__new_prompt__')all=all.concat([{id:'__new_prompt__',title:'空白模板',group:'自定义',text:'',required:[],optional:[],draftOnly:true}]);
  var selected=all.find(function(row){return row.id===selectedId[0];})||null;
  function persist(id, body) {
    if(!id)return pending.current;
    return pending.current.catch(function(){}).then(function(){return api('prompt.draft',{sessionId:props.sessionId,action:'save',templateId:id,expectedRevision:body.expectedRevision,mode:props.mode,editMode:body.editMode,fields:body.fields,text:body.text});}).then(function(result){
      if(!result.ok)throw Error(chatError(result));
      if(result.draft&&result.draft.conflict){if(alive.current)conflict[1](result.draft);return;}
      // 只有「这次存的还是当前选中的模板」才更新 draftRev：switchTo 会异步把上一个模板再存一次，
      // 无条件回写会把当前模板的 revision 覆盖成上一个模板的，之后对新模板的保存直接冲突、
      // 用户刚编辑的内容静默丢失（2026-10-17 真机复现）。
      // 内存里的草稿表也要跟着更新：它只在打开抽屉时加载一次，不回写的话
      // 「编辑 → 切模板 → 切回来」会恢复成保存前的旧值（2026-10-18 真机复现：
      // S01 的 检查重点 明明已落库，切回来却是空的）。
      drafts[1](function(previous){var next=Object.assign({},previous);next[id]=result.draft;return next;});
      if(alive.current){if(id===selectedRef.current)draftRev.current=result.draft.revision;saveState[1]('草稿已保存');}
    }).catch(function(error){if(alive.current)saveState[1]('草稿保存失败：'+error.message);});
  }
  // 500ms 防抖保存 + 关闭时提交最后一版（v6 第 3.3 节第 7 条）：编辑停下就落一次，
  // 关抽屉/切模板/插入都不丢稿。dirty 只由真实编辑置位，避免"打开就写一次"。
  function markDirty(){dirty.current=true;}
  function flushDraft(){
    if(!dirty.current||!selectedId[0])return pending.current;
    dirty.current=false;
    return persist(selectedId[0],{expectedRevision:draftRev.current,editMode:editMode[0],fields:values[0],text:text[0]});
  }
  useEffect(function(){
    if(!props.open||!dirty.current)return;
    if(debounce.current)clearTimeout(debounce.current);
    debounce.current=setTimeout(function(){debounce.current=0;flushDraft();},500);
    return function(){if(debounce.current){clearTimeout(debounce.current);debounce.current=0;}};
  });
  useEffect(function(){
    if(props.open)return;
    if(debounce.current){clearTimeout(debounce.current);debounce.current=0;}
    flushDraft();
  },[props.open]);
  function load(){alive.current=true;var active=true;
    return Promise.all([api('prompt.library',{sessionId:props.sessionId,scene:props.scene,action:'list'}),api('prompt.draft',{sessionId:props.sessionId,action:'list'})]).then(function(res){
      if(!res[0].ok||!res[1].ok)throw Error(chatError(!res[0].ok?res[0]:res[1]));
      if(!active)return;
      lib[1](res[0]);
      var map={};res[1].drafts.forEach(function(d){map[d.templateId]=d;});drafts[1](map);
      // 无草稿时保持空白编辑，没有默认选中项；已有草稿恢复**最近编辑**的那一条。
      // 按 revision 排是错的：那是每个模板各自的计数器，改过次数多的模板会压过刚编辑过的那条。
      var recent=res[1].drafts.slice().sort(function(a,b){
        var at=String(a.updatedAt||''),bt=String(b.updatedAt||'');
        if(at&&bt&&at!==bt)return bt<at?-1:1;
        return b.revision-a.revision;
      })[0];
      if(recent){selectedId[1](recent.templateId);selectedRef.current=recent.templateId;values[1](recent.fields||{});editMode[1](recent.editMode||'fields');text[1](recent.text||'');draftRev.current=recent.revision;saveState[1]('已恢复上次编辑');}
    }).catch(function(error){if(active)notice[1](error.message);});
  }
  useEffect(function(){var p=load();return function(){alive.current=false;};},[props.sessionId]);
  // 打开抽屉就把焦点放进搜索框：这样键盘 Esc 能直接关闭并回到入口按钮（v6 UI01/UI09/UI12）。
  useEffect(function(){
    if(!props.open){focusDone.current=false;return;}
    if(focusDone.current)return;focusDone.current=true;
    if(typeof document==='undefined')return;
    var search=document.querySelector('[aria-label="模板搜索"]');
    if(search&&search.focus)search.focus();
  },[props.open]);
  // 兜底：入口按钮那一步已经捕获过落点；这里只处理「挂载时就是打开状态」的情况
  // （测试夹具与宿主恢复面板时），避免 insert() 拿不到预捕获的 span。
  useEffect(function(){
    if(!props.open)return;
    if(props.insertion&&props.insertion.current)return;
    if(props.inputActions&&typeof props.inputActions.captureInsertion==='function'&&props.insertion)props.insertion.current=props.inputActions.captureInsertion();
  },[props.open]);
  function generated(tpl, vals){return promptSubstitute(tpl, vals, fields);}
  function switchTo(id) {
    if(id===selectedId[0])return;
    if(selected&&text[0].trim())persist(selected.id,{expectedRevision:draftRev.current,editMode:editMode[0],fields:values[0],text:text[0]});
    // 不在这里清冲突：冲突按模板保留，切走再切回来还能看到两份稿（v6 第 3.3 节第 7 条）。
    // 渲染时只显示属于当前模板的那一条，避免把别的模板的冲突挂在这一页上。
    var tpl=all.find(function(row){return row.id===id;});selectedId[1](id);selectedRef.current=id;notice[1]('');
    var saved=drafts[0][id];
    if(saved){values[1](saved.fields||{});editMode[1](saved.editMode||'fields');text[1](saved.text||'');draftRev.current=saved.revision;saveState[1]('已恢复该模板的稿');}
    else if(tpl){values[1]({});editMode[1]('fields');text[1](generated(tpl,{}));draftRev.current=0;saveState[1]('');}
    else{values[1]({});text[1]('');draftRev.current=0;}
  }
  function setField(key,value){var next=Object.assign({},values[0]);next[key]=value;values[1](next);if(editMode[0]==='fields'&&selected)text[1](generated(selected,next));markDirty();}
  function beginManual(){editMode[1]('manual');notice[1]('正文可以直接修改；改完可复制、插入或保存。');markDirty();}
  function useGenerated(){editMode[1]('fields');if(selected)text[1](generated(selected,values[0]));markDirty();}
  function newTemplate(){
    flushDraft();selectedId[1]('__new_prompt__');selectedRef.current='__new_prompt__';
    var saved=drafts[0].__new_prompt__;
    values[1]({});editMode[1]('manual');text[1](saved&&saved.text||'');draftRev.current=saved&&saved.revision||0;
    saveAsName[1]('');query[1]('');queryDraft[1]('');scope[1]('mine');saveState[1](saved?'已恢复未保存为模板的草稿':'未保存为模板');notice[1]('写下任务要求，填一个名称即可保存。');
  }
  function toggleFavorite(){if(!selected)return;var list=favorites[0].indexOf(selected.id)>=0?favorites[0].filter(function(x){return x!==selected.id;}):favorites[0].concat([selected.id]);favorites[1](list);savePromptFavorites(list);}
  // 导入/导出（v6 第 3.3 节第 11 条）：导入逐条报告结果，重 ID 由服务端导入为新副本；
  // 导出只含用户模板、标签与字段声明，不含账号凭据。
  function importFile(file){
    if(!file)return Promise.resolve();
    return file.text().then(function(raw){
      var doc;
      try{doc=JSON.parse(raw);}catch(error){throw Error('导入文件不是合法 JSON：'+error.message);}
      return api('prompt.library',{sessionId:props.sessionId,action:'import',document:doc});
    }).then(function(result){
      if(!result.ok)throw Error(chatError(result));
      var accepted=(result.accepted||[]).length, rejected=result.rejected||[];
      importNotice[1]('导入完成：接受 '+accepted+' 条'+(rejected.length?('，拒绝 '+rejected.length+' 条（'+rejected.map(function(row){return '第'+(row.index+1)+'条 '+row.reason;}).join('；')+'）'):''));
      return load();
    }).catch(function(error){importNotice[1]('导入失败：'+error.message);});
  }
  function exportTemplates(){
    return api('prompt.library',{sessionId:props.sessionId,action:'export'}).then(function(result){
      if(!result.ok)throw Error(chatError(result));
      var count=(result.document&&result.document.templates||[]).length;
      if(typeof download==='function')download('saker-prompt-templates.json',JSON.stringify(result.document,null,2),'application/json');
      notice[1]('已导出我的模板 '+count+' 条（不含账号凭据）');
    }).catch(function(error){notice[1]('导出失败：'+error.message);});
  }
  // 我的模板分页：每页 30 条只是加载数量，没有总数上限（v6 第 3.3 节第 10 条）。
  function loadMoreUser(){
    if(!lib[0]||!lib[0].user)return Promise.resolve();
    var loaded=lib[0].user.templates.length;
    return api('prompt.library',{sessionId:props.sessionId,action:'list',offset:loaded,limit:30}).then(function(result){
      if(!result.ok)throw Error(chatError(result));
      var user=result.user||{templates:[],total:loaded,more:0};
      lib[1](Object.assign({},lib[0],{user:Object.assign({},user,{templates:lib[0].user.templates.concat(user.templates||[])})}));
    }).catch(function(error){notice[1]('加载更多模板失败：'+error.message);});
  }
  function copy(){return Promise.resolve().then(function(){return navigator.clipboard.writeText(text[0]);}).then(function(){notice[1]('已复制全文');}).catch(function(){notice[1]('复制失败，请在正文中全选后复制。');});}
  function insert(){try{
    if(!props.inputActions||typeof props.inputActions.insertText!=='function')throw Error('输入框暂不可用，请复制后粘贴');
    // v6 第 3.3 节第 8 条：落点在**打开抽屉前**就捕获好（宿主 caretSpan 在编辑器失焦后返回文档末尾，
    // 抽屉一开原来的光标/选区就没了）。没有预捕获时退回现取，保证仍可用。
    var span=(props.insertion&&props.insertion.current)||props.inputActions.captureInsertion();
    if(!props.inputActions.insertText(text[0],span)){
      // 抽屉打开期间输入框被别处改过：宿主按版本拒绝。重取一次落点（此时=文档末尾）换行追加，
      // 并按方案原话说明，而不是把用户已经打好的内容丢回去让他重来。
      var fresh=typeof props.inputActions.captureInsertion==='function'?props.inputActions.captureInsertion():null;
      if(fresh&&(!span||fresh.draftRev!==span.draftRev)&&props.inputActions.insertText('\n'+text[0],fresh)){
        if(selected)persist(selected.id,{expectedRevision:draftRev.current,editMode:editMode[0],fields:values[0],text:text[0]});
        props.onClose();
        notice[1]('输入框已有新内容，已追加到末尾');
        if(props.onInserted)props.onInserted('输入框已有新内容，模板已追加到末尾');
        return;
      }
      throw Error('输入框正在变化，请稍后重试；编辑内容仍保留');
    }
    if(selected)persist(selected.id,{expectedRevision:draftRev.current,editMode:editMode[0],fields:values[0],text:text[0]});
    props.onClose();
    notice[1]('已插入聊天输入框，请检查后自行发送');
    if(props.onInserted)props.onInserted('已插入聊天输入框，请检查后自行发送');
  }catch(error){notice[1](error.message);}}
  /** 打开抽屉时捕获到的落点若为非空区间，说明输入框里选着一段文字（v6 第 3.3 节第 8 条）。 */
  function replacesSelection(){var s=props.insertion&&props.insertion.current;
    return !!(s&&typeof s.start==='number'&&typeof s.end==='number'&&s.end>s.start);}
  function templateToSave(id,title){
    var body=editMode[0]==='fields'?selected.text:text[0];
    var present=Array.from(new Set((String(body).match(/\{\{([a-zA-Z0-9_]+)\}\}/g)||[]).map(function(s){return s.slice(2,-2);})));
    var req=(selected.required||[]).filter(function(k){return present.indexOf(k)>=0;});
    var opt=(selected.optional||[]).filter(function(k){return present.indexOf(k)>=0;});
    return {id:id,title:title,group:'自定义',text:body,required:req,optional:opt,scene:selected.scene||['all'],keywords:selected.keywords||[]};
  }
  function acceptSavedTemplate(row){
    var existed=lib[0].user.templates.some(function(t){return t.id===row.id;});
    lib[1](Object.assign({},lib[0],{user:Object.assign({},lib[0].user,{total:lib[0].user.total+(existed?0:1),templates:[row].concat(lib[0].user.templates.filter(function(t){return t.id!==row.id;}))})}));
    selectedId[1](row.id);selectedRef.current=row.id;draftRev.current=drafts[0][row.id]&&drafts[0][row.id].revision||0;
    query[1]('');queryDraft[1]('');scope[1]('mine');saveAsName[1]('');saveState[1]('模板已保存');markDirty();
  }
  function saveAs(){if(!selected||!saveAsName[0].trim()||!text[0].trim())return;busy[1](true);var nextId='mine-'+Date.now().toString(36);
    return api('prompt.library',{sessionId:props.sessionId,action:'save-as',newId:nextId,template:templateToSave(nextId,saveAsName[0].trim())}).then(function(result){
      if(!result.ok)throw Error(chatError(result));acceptSavedTemplate(result.template);notice[1]('已保存到“我的”');
    }).catch(function(error){notice[1](error.message);}).finally(function(){busy[1](false);});}
  function saveUser(){if(!selected||selected.builtin||selected.draftOnly||!text[0].trim())return;busy[1](true);
    var record=templateToSave(selected.id,saveAsName[0].trim()||selected.title);record.expectedRevision=selected.revision;
    return api('prompt.library',{sessionId:props.sessionId,action:'upsert',template:record}).then(function(result){
      if(!result.ok)throw Error(chatError(result));acceptSavedTemplate(result.template);notice[1]('修改已保存');
    }).catch(function(error){notice[1](error.message);}).finally(function(){busy[1](false);});}
  function resolveConflict(mode){var c=conflict[0];if(!c)return;
    if(mode==='server'){values[1](c.server.fields||{});editMode[1](c.server.editMode||'fields');text[1](c.server.text||'');draftRev.current=c.server.revision;saveState[1]('已载入另一窗口版本');}
    else{draftRev.current=c.server.revision;persist(c.local.templateId||selected.id,{expectedRevision:c.server.revision,editMode:c.local.editMode||'fields',fields:c.local.fields||{},text:c.local.text||''});saveState[1]('已用本地版本另存');}
    conflict[1](null);}
  var shown=promptVisibleRows(all,scope[0],query[0],favorites[0]);
  var missing=selected&&editMode[0]==='fields'?promptMissing(selected,values[0],fields):[];
  var canInsert=!!selected&&text[0].trim()&&missing.length===0;
  // 还有没加载出来的用户模板时给「加载更多」；每页 30 条只是加载数量，没有总数上限。
  var userMore=(lib[0]&&lib[0].user&&Number.isInteger(lib[0].user.more))?lib[0].user.more:0;
  if(!props.open)return null;
 return React.createElement('div',{className:'dsh-prompt-overlay',onMouseDown:function(event){if(event.target===event.currentTarget)props.onClose();}},React.createElement('div',{className:'dsh-prompt-drawer',role:'dialog','aria-modal':'true','aria-label':'指令模板',onKeyDown:function(event){if(event.isComposing||event.keyCode===229)return;if(event.key==='Escape'){event.stopPropagation();props.onClose();}else if(event.key==='Tab'&&event.currentTarget.querySelectorAll){var items=Array.from(event.currentTarget.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),[tabindex="0"]')).filter(function(el){return el.getClientRects().length;});var first=items[0],last=items[items.length-1];if(items.length&&((event.shiftKey&&document.activeElement===first)||(!event.shiftKey&&document.activeElement===last))){event.preventDefault();(event.shiftKey?last:first).focus();}}}},
     React.createElement('div',{className:'dsh-prompt-head'},React.createElement('strong',null,'指令模板'),React.createElement('button',{type:'button',onClick:props.onClose,'aria-label':'关闭指令模板'},'关闭')),
     React.createElement('p',{className:'dsh-prompt-hint'},'选一条指令 → 补上空白 → 插入输入框。发送仍由你点。'),
    React.createElement('div',{className:'dsh-prompt-body'},
      React.createElement('div',{className:'dsh-prompt-list'},
        React.createElement('input',{type:'search','aria-label':'模板搜索',placeholder:'搜索：隐藏资产 / FOFA / 越权…',value:queryDraft[0],
          onCompositionStart:function(){composing.current=true;},
          onCompositionEnd:function(e){composing.current=false;queryDraft[1](e.target.value);query[1](e.target.value);},
          onChange:function(e){queryDraft[1](e.target.value);if(!composing.current)query[1](e.target.value);}}),
        React.createElement('div',{className:'dsh-prompt-scopes',role:'tablist'},[['common','常用'],['mine','我的'],['all','全部']].map(function(row){return React.createElement('button',{key:row[0],type:'button',role:'tab','aria-selected':scope[0]===row[0],className:scope[0]===row[0]?'is-active':'',onClick:function(){scope[1](row[0]);}},row[1]);})),
        React.createElement('div',{className:'dsh-prompt-io'},
          React.createElement('button',{type:'button',onClick:newTemplate},'新建'),
          React.createElement('button',{type:'button',onClick:function(){if(importRef.current)importRef.current.click();}},'导入'),
          React.createElement('input',{ref:importRef,type:'file',accept:'application/json,.json',style:{display:'none'},'aria-label':'导入模板文件',onChange:function(e){var file=e.target.files&&e.target.files[0];e.target.value='';importFile(file);}}),
          React.createElement('button',{type:'button',onClick:exportTemplates},'导出')),
        React.createElement('ul',{className:'dsh-prompt-items'},shown.map(function(row){return React.createElement('li',{key:row.id},React.createElement('button',{type:'button',className:row.id===selectedId[0]?'is-active':'',onClick:function(){switchTo(row.id);}},
          React.createElement('span',{className:'dsh-prompt-item-title'},row.title),React.createElement('span',{className:'dsh-prompt-item-hint'},(row.group||'')+(row.builtin?'':row.draftOnly?' · 草稿':' · 我的'+(row.updatedAt?(' · '+String(row.updatedAt).slice(0,16).replace('T',' ')):'')))));})),
        userMore>0&&(scope[0]!=='common'||query[0].trim())?React.createElement('button',{type:'button',className:'dsh-prompt-more',onClick:loadMoreUser},'加载更多（还有 '+userMore+' 条）'):null,
        showEmptySmall(shown.length,query[0])),
      React.createElement('div',{className:'dsh-prompt-main'},
        selected?React.createElement('div',{className:'dsh-prompt-titlebar'},React.createElement('strong',null,selected.title),React.createElement('button',{type:'button',className:favorites[0].indexOf(selected.id)>=0?'is-active':'',onClick:toggleFavorite},favorites[0].indexOf(selected.id)>=0?'已收藏':'收藏'),
          !selected.draftOnly?React.createElement('div',{className:'dsh-prompt-modes',role:'tablist'},React.createElement('button',{type:'button',role:'tab','aria-selected':editMode[0]==='fields',className:editMode[0]==='fields'?'is-active':'',title:editMode[0]==='manual'?'按示例和已填信息重新生成，替换当前正文':'填写空白后生成正文',onClick:useGenerated},editMode[0]==='manual'?'按示例重新生成':'填写空白'),React.createElement('button',{type:'button',role:'tab','aria-selected':editMode[0]==='manual',className:editMode[0]==='manual'?'is-active':'',onClick:beginManual},'直接编辑')):null):null,
        selected&&editMode[0]==='fields'?React.createElement('div',{className:'dsh-prompt-fields'},
          (selected.required||[]).map(function(key){return fieldControl(key,values[0][key],setField,fields,missing);}),
          (selected.optional||[]).length?React.createElement('details',{open:optional[0],onToggle:function(e){optional[1](e.target.open);}},React.createElement('summary',null,'更多信息（'+(selected.optional||[]).length+'）'),
            (selected.optional||[]).map(function(key){return fieldControl(key,values[0][key],setField,fields,missing);})):null):!selected?React.createElement('div',{className:'dsh-prompt-blank'},
              React.createElement('strong',null,'先选一条模板'),
              React.createElement('p',null,'从左侧挑一条常用的，或点“新建”自己写。'),
              React.createElement('ol',null,
                React.createElement('li',null,'把目标填进去，正文可以继续改。'),
                React.createElement('li',null,'点“插入输入框”只会填入文字，不会自动发送。'))):null,
        selected?React.createElement('label',{className:'dsh-prompt-full'},'指令正文（可直接修改）',React.createElement('textarea',{'aria-label':'指令正文',value:text[0],placeholder:'写清楚要做什么、已有证据或附件，以及哪些不能碰。',maxLength:16000,onChange:function(e){text[1](e.target.value);editMode[1]('manual');markDirty();}})):null,
        conflict[0]&&conflict[0].local&&conflict[0].local.templateId===selectedId[0]?React.createElement('div',{className:'dsh-prompt-conflict',role:'alert'},React.createElement('p',null,'其他窗口已修改这份草稿，两份都保留：'),React.createElement('button',{type:'button',onClick:function(){resolveConflict('server');}},'载入另一窗口版本'),React.createElement('button',{type:'button',onClick:function(){resolveConflict('local');}},'用本地版本另存')):null,
        importNotice[0]?React.createElement('p',{role:'status'},importNotice[0]):null,
        notice[0]?React.createElement('p',{role:'status'},notice[0]):null),
    ),
    React.createElement('div',{className:'dsh-prompt-foot'},
      React.createElement('span',{role:'status'},saveState[0]||(selected?'':'未选择模板')),
      React.createElement('label',{className:'dsh-prompt-saveas'},'名称',React.createElement('input',{'aria-label':'另存为名称',value:saveAsName[0],placeholder:selected&&!selected.builtin&&!selected.draftOnly?selected.title:'起个名称，存到“我的”',maxLength:60,onChange:function(e){saveAsName[1](e.target.value);}}),React.createElement('button',{type:'button',disabled:busy[0]||!selected||!saveAsName[0].trim()||!text[0].trim(),onClick:saveAs},'存为我的模板')),
      selected&&!selected.builtin&&!selected.draftOnly?React.createElement('button',{type:'button',disabled:busy[0]||!text[0].trim(),onClick:saveUser},'保存修改'):null,
      React.createElement('button',{type:'button',disabled:!selected||!text[0].trim(),onClick:copy},'复制'),
      React.createElement('button',{type:'button',className:'is-primary',disabled:!canInsert,title:missing.length?'先填写：'+missing.join('、'):'',onClick:insert},replacesSelection()?'替换选中文字':'插入输入框'))));
}
function showEmptySmall(count,query){return count?null:React.createElement('p',{className:'dsh-prompt-empty'},query?('没有匹配“'+query+'”的模板'):'这里还没有模板');}
function fieldControl(key,value,setField,fields,missing){var f=fields[key]||{label:key};var needs=missing.indexOf(f.label)>=0;var common={'aria-label':f.label,value:value||'',placeholder:f.placeholder||'',onChange:function(e){setField(key,e.target.value);}};
  // 用独立子节点，不要用 `+` 拼：f.help 为空时 `'标签' + null` 会渲染出字面量 “null”。
  return React.createElement('label',{key:key,className:'dsh-prompt-field'+(needs?' is-missing':'')},
    React.createElement('span',{className:'dsh-prompt-label'},f.label,needs?React.createElement('em',null,'必填'):null),
    f.help?React.createElement('small',null,f.help):null,
    f.type==='textarea'?React.createElement('textarea',common):React.createElement('input',common),
    needs?React.createElement('small',{className:'dsh-prompt-need'},'填写后才能插入') : null);}
// 用量行（v6 第 5.1 节）：本任务网站请求、模型用量与时间；明细展开查看缓存与主子会话。
// 未知用量不显示为零；这里只读计数，不额外调用模型。
function usageDuration(seconds) {
  if (seconds == null) return '未知';
  if (seconds < 60) return seconds + ' 秒';
  return Math.floor(seconds / 60) + ' 分 ' + (seconds % 60) + ' 秒';
}
function UsageRow(props) {
  var data = useState(null), error = useState(''), open = useState(false);
  var diag = useState(null), diagError = useState('');
  var request = useRef(0), diagRequest = useRef(0);
  function load() {
    var revision = ++request.current;
    if (!props.sessionId) return Promise.resolve();
    return api('usage.get', { sessionId: props.sessionId })
      .then(function (result) { if (!result.ok) throw Error(result.error || '读取用量失败'); if (revision !== request.current) return; data[1](result); error[1](''); })
      .catch(function (failure) { if (revision === request.current) error[1](failure.message); });
  }
  useEffect(function () { var active = true; load(); var timer = setInterval(function () { if (active) load(); }, 10000); return function () { active = false; request.current++; clearInterval(timer); }; }, [props.sessionId]);
  // 本次模型输入分项（v6 第 6.3 节）：只在用户展开明细时读一次，不参与轮询。
  function loadDiag() {
    var revision = ++diagRequest.current;
    return api('diagnostics.request', { sessionId: props.sessionId })
      .then(function (result) { if (!result.ok) throw Error(result.error || '读取模型输入分项失败'); if (revision !== diagRequest.current) return; diag[1](result); diagError[1](''); })
      .catch(function (failure) { if (revision === diagRequest.current) diagError[1](failure.message); });
  }
  var current = data[0];
  if (!current || !current.configured) return null;
  var ops = current.operations || { used: 0, budget: 0 }, un = current.unmetered || { used: 0, budget: 0 }, cost = current.cost || {};
  var receipts = current.receipts || { total: 0 };
  var local = current.localTools || { used: 0 };
  var model = '模型调用 ' + (cost.modelCalls ?? 0) + (cost.unknownUsageCalls ? '（' + cost.unknownUsageCalls + ' 次用量未知）' : '') + (cost.totalTokens != null ? ' · ' + cost.totalTokens + ' tokens' : '');
  var sessions = cost.sessions || [];
  return React.createElement('div', { className: 'dsh-usage-row', 'aria-label': '本任务用量' },
    // 工具调用与网站回执分开显示：工具调用数是预算计数，回执数才是真落库的目标请求；
    // 用宿主 shell 发出去的请求不进回执，这一列让差异看得见（第 8.2 节）。
    React.createElement('span', null, '工具调用 ' + ops.used + (ops.budget == null ? ' · 未设上限' : '/' + ops.budget) + (un.budget ? '（未计量 ' + un.used + '/' + un.budget + '）' : '') + ' · 网站回执 ' + receipts.total + ' · 本地工具 ' + local.used),
    React.createElement('span', null, model),
    React.createElement('span', null, '用时 ' + usageDuration(current.elapsedSeconds)),
    current.refused ? React.createElement('span', { role: 'status', title: current.refused.message || '' }, '上次生成未发出（' + (current.refused.code || '已拒绝') + '）') : null,
    React.createElement('button', { type: 'button', 'aria-expanded': open[0], onClick: function () { var next = !open[0]; open[1](next); if (next && !diag[0]) loadDiag(); } }, open[0] ? '收起明细' : '明细'),
    error[0] ? React.createElement('span', { role: 'alert' }, error[0]) : null,
    open[0] ? React.createElement('div', { className: 'dsh-usage-detail' },
      React.createElement('div', null, '输入 ' + (cost.inputTokens ?? '未知') + ' · 输出 ' + (cost.outputTokens ?? '未知') + ' · 缓存读 ' + (cost.cacheReadTokens ?? '未知')),
      sessions.length ? React.createElement('div', null, sessions.map(function (row) {
        return (row.role === 'main' ? '主任务' : '子任务 ' + String(row.sessionId).slice(0, 8)) + '：调用 ' + row.modelCalls + '，工具 ' + row.toolCalls + (row.totalTokens != null ? '，' + row.totalTokens + ' tokens' : '，用量未知');
      }).join('；')) : null,
      cost.unavailableSessions ? React.createElement('div', null, '有 ' + cost.unavailableSessions + ' 个会话的用量暂不可读') : null,
      // 高级诊断「本次模型输入」：分项列出固定说明、工具定义、任务事实、用户消息和历史。
      React.createElement('div', { className: 'dsh-usage-diagnostics', 'aria-label': '本次模型输入' },
        React.createElement('strong', null, '本次模型输入'),
        diag[0] ? React.createElement('div', { className: 'dsh-usage-diag-items' }, (diag[0].items || []).map(function (item) {
          return React.createElement('span', { key: item.name }, item.label + ' ' + item.bytes + ' 字节');
        })) : React.createElement('small', null, '正在读取…'),
        diag[0] ? React.createElement('small', null, '合计 ' + diag[0].total + ' 字节 · ' + (diag[0].note || '')) : null,
        diagError[0] ? React.createElement('small', { role: 'alert' }, diagError[0]) : null),
      React.createElement('small', null, '金额未知时不显示为零；缓存计入总数，历史压缩后重读按实际计费。')) : null);
}
// 知识库入口（v6 第 5.6 节）：只有一个布尔开关；用途说明固定；不加载整库。
// 测试内容（v6 第 4.3/5.5 节）：折叠区选择 17 项；默认全选由 AI 挑选相关项；全不选=只分析已添加内容。
// 添加测试资料（v6 第 5.1/7.1 节）：识别→解析→去重→保存；只保存原文并建立引用，
// 不立刻发送、不访问网站。
function MaterialsEntry(props) {
  var projectMode = props.scenario === 'project' || props.scenario === 'cases';
  var fallbackOpen = useState(false), text = useState(''), name = useState('');
  var busy = useState(false), notice = useState(''), error = useState('');
  var summary = useState(null);
  var lastMaterial = useState(null), viewing = useState(false), materialDetail = useState(null);
  var materialDetailError = useState(''), materialBusy = useState(false);
  var queued = useState([]);
  var preparation = useState([]);
  var panelPosition = useState(null);
  var fileRef = useRef(null), dirRef = useRef(null), root = useRef(null), trigger = useRef(null);
  // 面板由 ChatSetup 统一管（四入口互斥）；单独挂载时退回本地状态。
  var open = [props.open === undefined ? fallbackOpen[0] : props.open,
    function (next) { if (props.onOpenChange) props.onOpenChange(next); else fallbackOpen[1](next); }];
  function closeEntry() {
    viewing[1](false); materialDetail[1](null); materialDetailError[1]('');
    open[1](false);
    if (trigger.current && trigger.current.focus) trigger.current.focus();
  }
  useEffect(function () {
    if (!open[0] || typeof window === 'undefined') return;
    function place() {
      if (!trigger.current || !trigger.current.getBoundingClientRect) return;
      var rect = trigger.current.getBoundingClientRect();
      var width = Math.max(0, Math.min(420, window.innerWidth - 32));
      var above = Math.max(0, rect.top - 24), below = Math.max(0, window.innerHeight - rect.bottom - 24);
      var position = { position: 'fixed', width: width + 'px', left: Math.max(16, Math.min(rect.right - width, window.innerWidth - width - 16)) + 'px', right: 'auto' };
      if (Math.max(above, below) < 180) {
        position.top = '16px'; position.bottom = 'auto'; position.maxHeight = Math.max(80, window.innerHeight - 32) + 'px';
      } else if (above >= below) {
        position.bottom = (window.innerHeight - rect.top + 8) + 'px'; position.top = 'auto'; position.maxHeight = Math.min(540, above) + 'px';
      } else {
        position.top = (rect.bottom + 8) + 'px'; position.bottom = 'auto'; position.maxHeight = Math.min(540, below) + 'px';
      }
      panelPosition[1](position);
    }
    place(); window.addEventListener('resize', place);
    return function () { window.removeEventListener('resize', place); };
  }, [open[0]]);
  // Esc / 点面板外都能关，焦点回到入口按钮（v6 第 10.5 节 UI09/UI12）。
  useEffect(function () {
    if (!open[0]) return;
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    function onDown(event) { var el = root.current; if (el && el.contains && el.contains(event.target)) return; closeEntry(); }
    function onKey(event) { if (event.isComposing || event.keyCode === 229) return; if (event.key === 'Escape') { event.stopPropagation(); closeEntry(); } }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return function () { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open[0]]);
  // 导入进度与结果（v6 第 7.1 节）：识别→解析→去重→保存；完成显示各类计数与失败清单。
  var IMPORT_STEPS = ['识别', '解析', '去重', '保存'];
  function summarize(rows) {
    var requests = 0, files = 0, failed = 0, skipped = 0, identities = 0, entries = 0, broken = 0, errors = [];
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      if (!row.ok) {
        if (row.skipped) { skipped += 1; continue; }
        failed += 1; errors.push(row.name + '：' + (row.error || '导入失败')); continue;
      }
      if (['http', 'har', 'curl'].indexOf(String(row.format || '')) >= 0) requests += 1;
      else files += 1;
      // 身份线索只记「带了哪种身份头」，名称与秘密分开；归属未确定就是待关联（v6 第 7.1 节）。
      if (Array.isArray(row.identities)) identities += row.identities.length;
      // HAR/扫描导出的条目数与坏记录数（v6 第 10.3 节 E09）：一份 HAR 里有几条、坏了几条要说清。
      if (Number.isInteger(row.entries)) entries += row.entries;
      if (Number.isInteger(row.broken)) broken += row.broken;
    }
    return { requests: requests, files: files, failed: failed, skipped: skipped, identities: identities, entries: entries, broken: broken, errors: errors };
  }
  function saveLegacy() {
    if (!text[0].trim()) { error[1]('请先粘贴请求、响应或代码，或选择一个文件'); return Promise.resolve(); }
    busy[1](true); error[1](''); notice[1](''); summary[1](null);
    if (projectMode) {
      return api('project.import', { sessionId: props.sessionId, name: name[0] || '粘贴的测试要求', text: text[0] })
        .then(function (result) {
          if (!result.ok) throw Error(result.error || '保存项目文档失败');
          summary[1]({ requests: 0, files: 1, failed: 0, skipped: 0, identities: 0, entries: result.sections, broken: 0, errors: [] });
          preparation[1](result.preview ? [result.preview] : []);
          notice[1]('已导入项目文档：' + result.sections + ' 个段落' + (result.unread ? '，' + result.unread + ' 个区域不可读' : ''));
          lastMaterial[1]({ kind: 'project', name: name[0] || '粘贴的测试要求', sections: result.sections });
          text[1](''); name[1]('');
          if (props.onImported) props.onImported();
        })
        .catch(function (failure) { error[1](failure.message); summary[1]({ requests: 0, files: 0, failed: 1, skipped: 0, identities: 0, entries: 0, broken: 0, errors: [failure.message] }); })
        .finally(function () { busy[1](false); });
    }
    return api('materials.import', { sessionId: props.sessionId, name: name[0], text: text[0] })
      .then(function (result) {
        if (!result.ok) throw Error(result.error || '保存测试资料失败');
        var m = result.material;
        summary[1](summarize([{ ok: true, format: m.format, name: m.name || '粘贴内容', identities: m.identities,
          entries: m.summary && m.summary.entries, broken: m.summary && m.summary.broken }]));
        notice[1]((m.reused ? '相同内容已存在，已合并来源' : '已保存') + '：' + m.format + '，' + m.bytes + ' 字节');
        lastMaterial[1]({ id: m.id, name: m.name || '粘贴内容', format: m.format, bytes: m.bytes, reused: m.reused === true });
        text[1](''); name[1]('');
        if (props.onImported) props.onImported();
      })
      .catch(function (failure) { error[1](failure.message); summary[1]({ requests: 0, files: 0, failed: 1, errors: [failure.message] }); })
      .finally(function () { busy[1](false); });
  }
  function readFile(file) {
    return new Promise(function (resolve) {
      var reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result || '')); };
      reader.onerror = function () { resolve(''); };
      reader.readAsText(file);
    });
  }
  function readBinary(file) {
    return new Promise(function (resolve) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result instanceof ArrayBuffer ? reader.result : new ArrayBuffer(0)); };
      reader.onerror = function () { resolve(new ArrayBuffer(0)); };
      reader.readAsArrayBuffer(file);
    });
  }
  function toBase64(buffer) {
    var bytes = new Uint8Array(buffer), binary = '';
    for (var i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }
  function openMaterial(material) {
    var id = material && material.id;
    if (!id) { materialDetailError[1]('这条记录没有可读取的文件 ID'); viewing[1](true); return; }
    viewing[1](true); materialBusy[1](true); materialDetailError[1](''); materialDetail[1](null);
    return api('materials.detail', { sessionId: props.sessionId, kind: 'file', id: id, offset: 0, limit: 16384 })
      .then(function (result) {
        if (!result.ok) throw Error(result.error || '读取文件失败');
        if (!result.detail) throw Error('文件不存在或已移除');
        materialDetail[1](result.detail);
      })
      .catch(function (failure) { materialDetailError[1](failure.message); })
      .finally(function () { materialBusy[1](false); });
  }
  function readMoreMaterial() {
    var current = materialDetail[0];
    if (!current || current.nextOffset == null) return Promise.resolve();
    materialBusy[1](true); materialDetailError[1]('');
    return api('materials.detail', { sessionId: props.sessionId, kind: 'file', id: current.id,
      offset: current.nextOffset, limit: current.limit || 16384 })
      .then(function (result) {
        if (!result.ok) throw Error(result.error || '继续读取失败');
        if (!result.detail) throw Error('文件不存在或已移除');
        materialDetail[1](Object.assign({}, result.detail, {
          offset: current.offset,
          preview: String(current.preview || '') + String(result.detail.preview || ''),
        }));
      })
      .catch(function (failure) { materialDetailError[1](failure.message); })
      .finally(function () { materialBusy[1](false); });
  }
  function pickFilesLegacy(event) {
    var files = [...(event.target.files || [])].slice(0, 30);
    event.target.value = '';
    if (!files.length) return;
    busy[1](true); error[1](''); notice[1]('');
    summary[1](null);
    Promise.all(files.map(function (file) {
      return projectMode
        ? readBinary(file).then(function (body) { return { name: file.name, body: toBase64(body) }; })
        : readFile(file).then(function (body) { return { name: file.name, body: body }; });
    }))
      .then(function (rows) {
        var results = [];
        return rows.reduce(function (chain, row) {
          return chain.then(function () {
            if (!projectMode && !row.body.trim()) { results.push({ name: row.name, ok: false, skipped: true }); return; }
            var endpoint = projectMode ? 'project.import' : 'materials.import';
            var payload = projectMode
              ? { sessionId: props.sessionId, name: row.name, base64: row.body }
              : { sessionId: props.sessionId, name: row.name, text: row.body };
            return api(endpoint, payload)
              .then(function (result) {
                if (!result.ok) throw Error(result.error || '保存失败');
                if (projectMode) results.push({ name: row.name, ok: true, format: result.source && result.source.kind,
                  entries: result.sections, broken: result.unread, preview: result.preview });
                else results.push({ name: row.name, ok: true, format: result.material && result.material.format,
                  id: result.material && result.material.id, materialName: result.material && result.material.name,
                  bytes: result.material && result.material.bytes, reused: result.material && result.material.reused,
                  identities: result.material && result.material.identities,
                  entries: result.material && result.material.summary && result.material.summary.entries,
                  broken: result.material && result.material.summary && result.material.summary.broken });
              })
              .catch(function (failure) { results.push({ name: row.name, ok: false, error: failure.message }); });
          });
        }, Promise.resolve()).then(function () {
          var s = summarize(results);
          summary[1](s);
          if (projectMode) preparation[1](results.filter(function (row) { return row.ok && row.preview; }).map(function (row) { return row.preview; }));
          notice[1]((projectMode ? '已导入 ' : '已保存 ') + (s.requests + s.files) + '/' + rows.length + ' 个文件' + (s.skipped ? '（跳过 ' + s.skipped + ' 个空文件）' : ''));
          var saved = results.filter(function (row) { return row.ok && row.id; }).slice(-1)[0];
          if (saved) lastMaterial[1]({ id: saved.id, name: saved.materialName || saved.name, format: saved.format, bytes: saved.bytes, reused: saved.reused === true });
          if (props.onImported) props.onImported();
        });
      })
      .catch(function (failure) { error[1](failure.message); })
      .finally(function () { busy[1](false); });
  }
  function importQueued(entry, results, imported) {
    var file = entry.file;
    var read = projectMode
      ? readBinary(file).then(function (body) { return { name: file.name, body: toBase64(body) }; })
      : readFile(file).then(function (body) { return { name: file.name, body: body }; });
    return read.then(function (row) {
      if (!projectMode && !row.body.trim()) {
        results.push({ ok: false, skipped: true, name: row.name, error: '空文件已跳过' });
        return;
      }
      var endpoint = projectMode ? 'project.import' : 'materials.import';
      var payload = projectMode
        ? { sessionId: props.sessionId, name: row.name, base64: row.body }
        : { sessionId: props.sessionId, name: row.name, text: row.body };
      return api(endpoint, payload).then(function (result) {
        if (!result.ok) throw Error(result.error || '保存失败');
        if (projectMode) {
          results.push({ ok: true, name: row.name, format: result.source && result.source.kind, entries: result.sections, broken: result.unread });
          preparation[1](current => current.concat(result.preview ? [result.preview] : []));
        } else {
          results.push({ ok: true, name: row.name, format: result.material && result.material.format,
            id: result.material && result.material.id, materialName: result.material && result.material.name,
            bytes: result.material && result.material.bytes, reused: result.material && result.material.reused,
            identities: result.material && result.material.identities,
            entries: result.material && result.material.summary && result.material.summary.entries,
            broken: result.material && result.material.summary && result.material.summary.broken });
        }
        imported.add(entry.id);
      }).catch(function (failure) {
        results.push({ ok: false, name: row.name, error: failure.message });
      });
    });
  }
  function importPasted(results) {
    if (!text[0].trim()) return Promise.resolve();
    if (projectMode) {
      return api('project.import', { sessionId: props.sessionId, name: name[0] || '粘贴的测试要求', text: text[0] })
        .then(function (result) {
          if (!result.ok) throw Error(result.error || '保存项目文档失败');
          results.push({ ok: true, fromPaste: true, name: name[0] || '粘贴的测试要求', format: 'project', entries: result.sections, broken: 0 });
          preparation[1](result.preview ? [result.preview] : []);
          text[1](''); name[1]('');
        })
        .catch(function (failure) {
          results.push({ ok: false, fromPaste: true, name: name[0] || '粘贴内容', error: failure.message });
        });
    }
    return api('materials.import', { sessionId: props.sessionId, name: name[0], text: text[0] })
      .then(function (result) {
        if (!result.ok) throw Error(result.error || '保存测试资料失败');
        var m = result.material;
        results.push({ ok: true, fromPaste: true, format: m.format, name: m.name || '粘贴内容', identities: m.identities,
          id: m.id, materialName: m.name, bytes: m.bytes, reused: m.reused,
          entries: m.summary && m.summary.entries, broken: m.summary && m.summary.broken });
        text[1](''); name[1]('');
      })
      .catch(function (failure) {
        results.push({ ok: false, fromPaste: true, name: name[0] || '粘贴内容', error: failure.message });
      });
  }
  function save() {
    var entries = queued[0].slice();
    if (!entries.length && !text[0].trim()) {
      error[1]('请先粘贴请求、响应或代码，或先选择文件');
      return Promise.resolve();
    }
    busy[1](true); error[1](''); notice[1](''); summary[1](null);
    var results = [], imported = new Set();
    var chain = Promise.resolve();
    entries.forEach(function (entry) {
      chain = chain.then(function () { return importQueued(entry, results, imported); });
    });
    chain = chain.then(function () { return importPasted(results); });
    return chain.then(function () {
      var s = summarize(results);
      summary[1](s);
      if (s.failed || s.skipped) error[1]('有 ' + (s.failed + s.skipped) + ' 项未导入；成功项已保留，失败项可重试或移除。');
      notice[1]((projectMode ? '已导入 ' : '已保存 ') + (s.requests + s.files) + '/' + results.length + ' 项内容');
      var saved = results.filter(function (row) { return row.ok && row.id; }).slice(-1)[0];
      if (saved) lastMaterial[1]({ id: saved.id, name: saved.materialName || saved.name, format: saved.format, bytes: saved.bytes, reused: saved.reused === true });
      if (imported.size) queued[1](current => current.filter(entry => !imported.has(entry.id)));
      if (props.onImported) props.onImported();
    }).catch(function (failure) {
      error[1](failure.message);
    }).finally(function () { busy[1](false); });
  }
  function pickFiles(event) {
    var selected = [...(event.target.files || [])].slice(0, 30);
    event.target.value = '';
    if (!selected.length) return;
    error[1](''); notice[1](''); summary[1](null);
    var seen = new Set(queued[0].map(function (entry) { return entry.file.name + ':' + entry.file.size + ':' + entry.file.lastModified; }));
    var next = [];
    selected.forEach(function (file) {
      var key = file.name + ':' + file.size + ':' + file.lastModified;
      if (seen.has(key)) return;
      seen.add(key);
      next.push({ id: 'queued-' + Date.now() + '-' + Math.random().toString(36).slice(2), file: file });
    });
    queued[1](current => current.concat(next));
  }
  function prepareSource(preview, sourceRole, regions) {
    busy[1](true); error[1]('');
    return api('project.prepare', {
      sessionId: props.sessionId, sourceId: preview.sourceId, sourceRevision: preview.sourceRevision,
      sourceRole: sourceRole, regions: regions,
    }).then(function (result) {
      if (!result.ok) throw Error(result.error || '保存来源准备失败');
      preparation[1](preparation[0].map(function (item) {
        return item.sourceId === preview.sourceId && item.sourceRevision === preview.sourceRevision ? result.preview : item;
      }));
      notice[1]('来源准备已保存，开始测试时会固定这份选择');
      if (props.onImported) props.onImported();
    }).catch(function (failure) { error[1](failure.message); })
      .finally(function () { busy[1](false); });
  }
  function setSourceRole(preview, sourceRole) {
    return prepareSource(preview, sourceRole, preview.regions || []);
  }
  function setRegion(preview, sheet, patch) {
    var regions = (preview.regions || []).map(function (region) {
      return region.sheet === sheet.sheet && Number(region.sheetIndex) === Number(sheet.sheetIndex)
        ? Object.assign({}, region, patch) : region;
    });
    return prepareSource(preview, preview.sourceRole, regions);
  }
  return React.createElement('div', { className: 'dsh-materials-entry', ref: root },
    React.createElement('button', { ref: trigger, type: 'button', className: 'dsh-chat-toolbar-button', 'aria-expanded': open[0],
      title: projectMode ? '导入这次测试的要求文件。只在本机解析，不会立刻读取。' : '把请求、代码或文件交给 Saker 检查。只保存在本机，添加后才会读取。',
      onClick: function () { open[1](!open[0]); } }, projectMode ? '测试文档' : '附件'),
    open[0] ? React.createElement('div', { className: 'dsh-materials-import', style: panelPosition[0] },
      React.createElement('div', { className: 'dsh-chat-panel-head saker-panel-head' },
        React.createElement('div', { className: 'saker-panel-headtext' },
          React.createElement('strong', null, viewing[0] ? '附件内容' : (projectMode ? '导入测试文档' : '添加附件')),
          React.createElement('p', { className: 'saker-panel-subtitle' }, viewing[0]
            ? (lastMaterial[0] && lastMaterial[0].name ? lastMaterial[0].name : '本机保存的原文；读取不会发送给模型。')
            : (projectMode ? '选择这次测试的要求文件。只在本机解析。' : '文档、截图、请求都可以。只保存在本机。'))),
        React.createElement('button', { type: 'button', 'aria-label': projectMode ? '关闭添加测试文档' : '关闭添加文件', onClick: closeEntry }, '关闭')),
      viewing[0] ? React.createElement(React.Fragment, null,
        React.createElement('div', { className: 'dsh-materials-import-body dsh-materials-viewer' },
          materialBusy[0] && !materialDetail[0] ? React.createElement('p', { className: 'saker-panel-hint' }, '正在读取本机原文…') : null,
          materialDetailError[0] ? React.createElement('p', { role: 'alert' }, materialDetailError[0]) : null,
          materialDetail[0] ? React.createElement('div', null,
            React.createElement('div', { className: 'dsh-materials-viewer-meta' },
			React.createElement('strong', null, materialDetail[0].name || '文件'),
              React.createElement('small', null,
                (materialDetail[0].importSummary && materialDetail[0].importSummary.format ? materialDetail[0].importSummary.format + ' · ' : '')
                + (materialDetail[0].totalBytes != null ? materialDetail[0].totalBytes + ' 字节' : '大小未知')
                + (materialDetail[0].truncated ? ' · 已显示 ' + (materialDetail[0].offset || 0) + '–' + (materialDetail[0].nextOffset || 0) : ' · 已显示全部'))),
            materialDetail[0].missing
              ? React.createElement('p', { role: 'alert' }, '原始文件已不在本机，且没有保存正文；这里只保留索引信息。')
              : React.createElement('pre', { className: 'dsh-materials-viewer-text' }, materialDetail[0].preview || '（空文件）'),
            materialDetail[0].truncated ? React.createElement('button', { type: 'button', disabled: materialBusy[0], onClick: readMoreMaterial },
              materialBusy[0] ? '正在读取…' : '继续读取') : null,
            materialDetail[0].note ? React.createElement('small', null, materialDetail[0].note) : null) : null),
        React.createElement('div', { className: 'dsh-materials-import-foot dsh-materials-viewer-foot' },
          React.createElement('button', { type: 'button', onClick: function () { viewing[1](false); materialDetail[1](null); materialDetailError[1](''); } }, '返回添加'),
          React.createElement('button', { type: 'button', onClick: closeEntry }, '关闭')))
      : React.createElement(React.Fragment, null,
        React.createElement('div', { className: 'dsh-materials-import-body' },
          projectMode ? React.createElement('p', { className: 'saker-panel-hint' }, '支持 Word、Excel、文本或 Markdown。') : null,
          React.createElement('div', { className: 'dsh-materials-import-actions' },
            React.createElement('button', { type: 'button', disabled: busy[0], onClick: function () { if (fileRef.current) fileRef.current.click(); } }, '选择文件'),
            projectMode ? null : React.createElement('button', { type: 'button', disabled: busy[0], onClick: function () { if (dirRef.current) dirRef.current.click(); } }, '选择文件夹'),
            React.createElement('input', { ref: fileRef, type: 'file', multiple: true, accept: projectMode ? '.docx,.xlsx,.txt,.md,.json' : undefined, style: { display: 'none' }, onChange: pickFiles }),
            React.createElement('input', { ref: dirRef, type: 'file', webkitdirectory: '', multiple: true, style: { display: 'none' }, onChange: pickFiles })),
          queued[0].length ? React.createElement('div', { className: 'dsh-materials-queue', 'aria-label': '待导入文件' },
            React.createElement('small', null, '已选择 ' + queued[0].length + ' 个文件；确认后点击下面的导入按钮。'),
            queued[0].map(function (entry) {
              return React.createElement('div', { key: entry.id, className: 'dsh-materials-queue-row' },
                React.createElement('span', null, entry.file.name + ' · ' + entry.file.size + ' 字节'),
                React.createElement('button', { type: 'button', 'aria-label': '移除 ' + entry.file.name,
                  onClick: function () { queued[1](current => current.filter(item => item.id !== entry.id)); } }, '移除'));
            })) : null,
          React.createElement('details', { className: 'saker-panel-section' }, React.createElement('summary', null, projectMode ? '或者直接粘贴测试要求' : '或者直接粘贴请求 / 代码'),
            React.createElement('label', { className: 'dsh-materials-import-paste' }, projectMode ? '环境说明或测试要求' : '请求、响应或代码',
              React.createElement('textarea', { 'aria-label': projectMode ? '粘贴测试文档' : '粘贴测试资料', rows: 5, maxLength: 200000, value: text[0],
                placeholder: projectMode ? '填写项目地址、测试账号说明，以及需要检查的功能与要求。' : '例如：GET /api/orders HTTP/1.1 或 HAR JSON 片段', onChange: function (event) { text[1](event.target.value); } })),
            React.createElement('label', { className: 'dsh-materials-import-name' }, '名称（可选）',
              React.createElement('input', { 'aria-label': '测试资料名称', value: name[0], onChange: function (event) { name[1](event.target.value); } }))),
          projectMode && preparation[0].length ? React.createElement('details', { className: 'dsh-materials-preparation', open: true },
            React.createElement('summary', null, '导入预览与范围（' + preparation[0].length + '）'),
            preparation[0].map(function (preview) {
              return React.createElement('div', { key: preview.sourceId + '@' + preview.sourceRevision, style: { padding: '8px 0', borderTop: '1px solid color-mix(in srgb,currentColor 10%,transparent)' } },
                React.createElement('strong', null, preview.displayName || preview.sourceId),
                React.createElement('label', { className: 'dsh-materials-import-name' }, '用途 ',
                  React.createElement('select', { 'aria-label': '来源用途', value: preview.sourceRole, disabled: busy[0], onChange: function (event) { return setSourceRole(preview, event.target.value); } },
                    React.createElement('option', { value: 'requirements' }, '测试要求'),
                    React.createElement('option', { value: 'environment' }, '环境说明'))),
                (preview.sheets || []).map(function (sheet) {
                  return React.createElement('div', { key: preview.sourceId + ':' + sheet.sheet, style: { marginTop: 8, padding: 8, border: '1px solid color-mix(in srgb,currentColor 12%,transparent)', borderRadius: 6 } },
                    React.createElement('div', null, sheet.sheet + ' · ' + sheet.rows + ' 行 · 隐藏行 ' + sheet.hiddenRows + (sheet.hiddenColumns.length ? ' · 隐藏列 ' + sheet.hiddenColumns.join(',') : '')),
                    sheet.headerAmbiguous ? React.createElement('small', { role: 'status' }, '首行是否为表头不确定；默认保留为数据，需人工选择。') : null,
                    React.createElement('label', null, '表头 ',
                      React.createElement('select', { 'aria-label': sheet.sheet + '表头', value: (preview.regions || []).find(function (region) { return region.sheet === sheet.sheet; })?.headerMode || 'auto', disabled: busy[0], onChange: function (event) { return setRegion(preview, sheet, { headerMode: event.target.value, headerRow: event.target.value === 'header' ? sheet.firstNonEmptyRow : null }); } },
                        React.createElement('option', { value: 'auto' }, '自动识别'),
                        React.createElement('option', { value: 'header' }, '首行是表头'),
                        React.createElement('option', { value: 'none' }, '无表头，全部保留'))),
                    React.createElement('label', null, React.createElement('input', { type: 'checkbox',
                      checked: (preview.regions || []).find(function (region) { return region.sheet === sheet.sheet; })?.includeHidden === true,
                      disabled: busy[0], onChange: function (event) { return setRegion(preview, sheet, { includeHidden: event.target.checked }); } }), '纳入隐藏行和隐藏列')),
                    React.createElement('small', null, '首行：' + (sheet.firstValues || []).join(' / '));
                }),
                React.createElement('small', null, preview.note || ''));
            })) : null),
        React.createElement('div', { className: 'dsh-materials-import-foot' },
          React.createElement('button', { type: 'button', className: 'is-primary', disabled: busy[0] || (!queued[0].length && !text[0].trim()), onClick: save },
            busy[0] ? '正在导入…' : queued[0].length ? (text[0].trim() ? '添加文件与粘贴内容' : '添加所选文件') : text[0].trim() ? '添加到当前任务' : '先选择文件或粘贴内容'),
          // 成功条固定在滚动区外：失败仍保留输入，成功可直接查看同一份材料。
          notice[0] ? React.createElement('div', { className: 'dsh-materials-success', role: 'status' },
            React.createElement('span', null, notice[0]),
            lastMaterial[0] && lastMaterial[0].id ? React.createElement('button', { type: 'button', onClick: function () { return openMaterial(lastMaterial[0]); } }, '查看') : null) : null,
          React.createElement('div', { className: 'dsh-materials-progress' },
            busy[0] ? React.createElement('small', null, '正在识别并保存…') : null,
            summary[0] ? React.createElement('small', null, '已导入：请求 ' + summary[0].requests + '、文件 ' + summary[0].files
              + (summary[0].identities ? '、身份 ' + summary[0].identities + '（待关联）' : '')
              + (summary[0].entries ? '、条目 ' + summary[0].entries + (summary[0].broken ? '（其中 ' + summary[0].broken + ' 条坏记录）' : '') : '')
              + (summary[0].skipped ? '、跳过空文件 ' + summary[0].skipped : '') + '；失败 ' + summary[0].failed) : null,
            summary[0] && summary[0].errors.length ? React.createElement('details', { className: 'dsh-materials-errors' },
              React.createElement('summary', null, '查看错误 ' + summary[0].errors.length + ' 条'),
              React.createElement('ul', null, summary[0].errors.map(function (text, index) { return React.createElement('li', { key: index }, text); }))) : null),
          error[0] ? React.createElement('p', { role: 'alert' }, error[0]) : null))) : null);
}
// 停止状态（v6 第 5.2 节）：点击停止后先显示“正在停止…”，收到代理退出依据后才显示“已停止”。
// 给助手选择模型（v6 第 5.5 节）：可选模型来自宿主自己的授权偏好；未配置时给出配置入口，不悄悄换模型。
function WorkerModelSection(props) {
  var data = useState(null), error = useState('');
  useEffect(function () {
    var active = true;
    api('chat.models', { sessionId: props.sessionId })
      .then(function (result) { if (!result.ok) throw Error(result.error || '读取可选模型失败'); if (active) data[1](result); })
      .catch(function (failure) { if (active) error[1](failure.message); });
    return function () { active = false; };
  }, [props.sessionId]);
  var current = data[0];
  if (error[0]) return React.createElement('details', { className: 'dsh-worker-model' },
    React.createElement('summary', null, '并行任务用哪个模型（可选）'), React.createElement('p', { role: 'alert' }, error[0]));
  if (!current) return React.createElement('details', { className: 'dsh-worker-model' },
    React.createElement('summary', null, '并行任务用哪个模型（可选）'), React.createElement('p', null, '正在读取可选模型…'));
  var models = current.models || [], enabled = current.enabled === true && models.length > 0;
  var values = props.values || {};
  var labels = { workerModel: '协作模型', reviewModel: '独立复核', reportModel: '写报告时使用' };
  var customized = Object.keys(labels).some(function (key) { return !!values[key]; });
  function selectFor(key) {
    var value = values[key] || null;
    var currentKey = value ? value.provider + '::' + value.model : '';
    return React.createElement('label', null, labels[key] + ' ', React.createElement('select', {
      'aria-label': labels[key] + '模型',
      disabled: props.disabled || !enabled,
      value: currentKey,
      onChange: function (event) {
        var next = String(event.target.value);
        if (!next) return props.onChange(key, null);
        var at = next.indexOf('::');
        return props.onChange(key, { provider: next.slice(0, at), model: next.slice(at + 2) });
      }
    },
      React.createElement('option', { value: '' }, enabled ? '和当前会话一样' : '当前会话模型（未配置可选模型）'),
      models.map(function (row) {
        return React.createElement('option', { key: row.provider + '::' + row.model, value: row.provider + '::' + row.model }, row.provider + ' / ' + row.model);
      })));
  }
  return React.createElement('details', { className: 'dsh-worker-model' },
    React.createElement('summary', null, '并行任务用哪个模型（可选）'),
    React.createElement('p', null, customized ? '已自定义：只有你明确选择时才更换。' : '默认和当前会话一样；不用改也能用。'),
    selectFor('workerModel'),
    selectFor('reviewModel'),
    selectFor('reportModel'),
    React.createElement('small', null, enabled
      ? '并行任务用“协作模型”；复核和写报告各有自己的触发条件。用量都算在本任务里。'
      : '未配置可选模型：三项都会沿用当前会话模型。可在宿主「插件」页的“子代理模型选择设置”里开启允许的模型。'));
}
// 登录账号（v6 第 5.5 节）：列表只显示名称与状态；秘密单独保存，不回显、不进测试资料。
var ACCOUNT_STATUS_LABEL = { valid: '有效', unconfirmed: '待确认', expired: '已失效' };
function AccountsSection(props) {
  var data = useState(null), error = useState(''), busy = useState(false), notice = useState('');
  var name = useState(''), status = useState('unconfirmed'), secret = useState('');
  function load() {
    return api('account.list', { sessionId: props.sessionId })
      .then(function (result) { if (!result.ok) throw Error(result.error || '读取账号失败'); data[1](result); error[1](''); })
      .catch(function (failure) { error[1](failure.message); });
  }
  useEffect(function () { load(); }, [props.sessionId]);
  function call(endpoint, payload) {
    busy[1](true); error[1](''); notice[1]('');
    return api(endpoint, Object.assign({ sessionId: props.sessionId }, payload || {}))
      .then(function (result) { if (!result.ok) throw Error(result.error || '账号操作失败'); data[1]({ accounts: result.accounts, statuses: data[0] && data[0].statuses }); return result; })
      .catch(function (failure) { error[1](failure.message); })
      .finally(function () { busy[1](false); });
  }
  var accounts = (data[0] && data[0].accounts) || [];
  return React.createElement('details', { className: 'dsh-accounts' },
    React.createElement('summary', null, '登录账号（可选）' + (accounts.length ? ' · ' + accounts.length + ' 个' : '')),
    React.createElement('p', null, '秘密单独保存，不进测试资料、也不进提示词字段；待确认与已失效不会被当成有效，程序会拒绝用它们发请求。'
      + '有效账号另存的 Cookie/Authorization 会套到“身份名称相同、且请求自身没带认证头”的已存请求上；秘密不会写进回执。'),
    accounts.map(function (row) {
      return React.createElement('div', { key: row.id, className: 'dsh-account-row' },
        React.createElement('span', null, row.name + ' · ' + row.statusLabel + (row.hasSecret ? ' · 秘密已另存' : '')),
        React.createElement('button', { type: 'button', disabled: busy[0], onClick: function () { return call('account.remove', { id: row.id }); } }, '移除'));
    }),
    React.createElement('div', { className: 'dsh-account-add' },
      React.createElement('input', { 'aria-label': '账号名称', placeholder: '账号名称', value: name[0], onChange: function (event) { name[1](event.target.value); } }),
      React.createElement('select', { 'aria-label': '账号状态', value: status[0], onChange: function (event) { status[1](event.target.value); } },
        ['valid', 'unconfirmed', 'expired'].map(function (value) { return React.createElement('option', { key: value, value: value }, ACCOUNT_STATUS_LABEL[value]); })),
      React.createElement('input', { 'aria-label': '账号秘密', type: 'password', placeholder: '密码或 Cookie（只保存，不回显）', value: secret[0], onChange: function (event) { secret[1](event.target.value); } }),
      React.createElement('button', { type: 'button', disabled: busy[0] || !name[0].trim(), onClick: function () {
        return call('account.save', { name: name[0], status: status[0], secret: secret[0] }).then(function (result) {
          if (result) { name[1](''); secret[1](''); notice[1]('已保存账号'); }
        });
      } }, '添加账号')),
    notice[0] ? React.createElement('small', { role: 'status' }, notice[0]) : null,
    error[0] ? React.createElement('p', { role: 'alert' }, error[0]) : null);
}
function taskStatusLabel(current, policy) {
  if (policy?.pendingChange) return '等待你确认';
  // 任务状态词表（v6 第 8.2 节）：准备 / 运行 / 等待信息 / 暂停中 / 已暂停 / 已完成 / 失败。
  switch (current.phase) {
    case 'preparing': return '准备中';
    case 'running': return '本轮进行中';
    case 'idle': return '本轮已结束';
    case 'waiting-info': return '等待你确认';
    case 'pausing': return '正在停止…';
    case 'paused': return '已停止';
    case 'completed': return '本轮已完成';
    case 'failed': return '本轮失败';
    default: break;
  }
  if (!current.stopped) return '本轮进行中';
  if (current.reason === 'plan_complete') return '本轮已完成';
  if (current.reason === 'turn_ended') return '本轮已结束';
  if (policy && policy.cancelled === true && current.agentRunning) return '正在停止…';
  return '已停止';
}
function taskScopeDisplay(scope, fallback) {
  if (!scope) return fallback || '未指定';
  var include = scope.includePreview && scope.includePreview.length ? scope.includePreview.join('、') : '未指定';
  if (scope.moreInclude) include += ' 等 ' + (scope.includeCount || 0) + ' 项';
  var exclude = scope.excludePreview && scope.excludePreview.length ? scope.excludePreview.join('、') : '';
  if (scope.moreExclude) exclude += ' 等 ' + (scope.excludeCount || 0) + ' 项';
  return include + (exclude ? ' · 排除：' + exclude : '');
}
// 任务工作区（发现页/资料页）要能打开输入框上方的「添加测试资料」面板，但两者是宿主的不同 slot，
// 拿不到彼此的 props。模块级桥接只暴露一个「打开资料面板」动作，不引入新的全局状态。
var materialsPanelBridge = { open: null };
var curationSessionBridge = { sessionId: '' };
// 保存设置后的变更摘要用词（v6 第 4.2 节）：与后端 settingsDiff 的字段一一对应，不另造术语。
var SETTING_CHANGE_LABELS = { reporting: '什么时候汇报', explain: '解释原理', workers: '并行任务上限', workerModel: '并行任务模型',
  allowTargetNetwork: '允许访问网站', readOnly: '只读模式', excludedPaths: '排除路径',
  requestRatePerMinute: '扫描速率', requestConcurrency: '并发上限', direction: '测试方向', workflow: '测试安排',
  mode: '方向', interaction: '什么时候问我' };
function fileBase64(file) {
  return new Promise(function(resolve,reject){var reader=new FileReader();reader.onload=function(){var value=String(reader.result||'');resolve(value.slice(value.indexOf(',')+1))};reader.onerror=function(){reject(reader.error||Error('文件读取失败'))};reader.readAsDataURL(file)})
}
function CompetitionEntry(props) {
  var data=useState(null), details=useState(null), busy=useState(false), error=useState(''), view=useState('list'), selected=useState(''), draft=useState({title:'',prompt:'',url:'',connection:'',environment:'host',image:''}), command=useState(''), output=useState(''), executionId=useState(''), answer=useState(''), knowledgeQuery=useState(''), knowledgeRead=useState(''), pageOffset=useState(0), knowledgePage=useState(null), stdoutOffset=useState(0), stderrOffset=useState(0), runRequest=useState('');
  function load(offset){var nextOffset=offset===undefined?pageOffset[0]:offset;pageOffset[1](nextOffset);return api('competition.status',{sessionId:props.sessionId,offset:nextOffset}).then(function(value){if(!value.ok)throw Error(value.error||'读取比赛状态失败');data[1](value);error[1]('');}).catch(function(failure){error[1](failure.message)})}
  useEffect(function(){load()},[props.sessionId]);
  function act(endpoint,payload){busy[1](true);error[1]('');return api(endpoint,Object.assign({sessionId:props.sessionId},payload||{})).then(function(value){if(!value.ok)throw Error(value.error||'操作失败');return load().then(function(){return value})}).catch(function(failure){error[1](failure.message)}).finally(function(){busy[1](false)})}
  function create(){var d=draft[0];if(!d.prompt.trim()&&!d.title.trim()){error[1]('至少填写题名或题面');return}return act('competition.create',{title:d.title,prompt:d.prompt,instance:{url:d.url,connection:d.connection,revision:1},environment:{kind:d.environment,image:d.image,state:d.environment==='docker'?'requested':'host'}}).then(function(value){if(value&&value.challenge){draft[1]({title:'',prompt:'',url:'',connection:'',environment:'host',image:''});return detail(value.challenge.challengeId)}})}
  function detail(challengeId){selected[1](challengeId);view[1]('detail');output[1]('');executionId[1]('');return api('competition.detail',{sessionId:props.sessionId,challengeId:challengeId}).then(function(value){if(!value.ok)throw Error(value.error||'读取题目失败');details[1](value)}).catch(function(failure){error[1](failure.message)})}
  function addFiles(files){var challengeId=selected[0];if(!challengeId||!files.length)return;busy[1](true);var chain=Promise.resolve();Array.from(files).forEach(function(file){chain=chain.then(function(){return fileBase64(file)}).then(function(base64){return api('competition.attachment',{sessionId:props.sessionId,challengeId:challengeId,name:file.name,base64:base64})}).then(function(value){if(!value.ok)throw Error(value.error||('附加失败：'+file.name))})});return chain.then(load).then(function(){return detail(challengeId)}).catch(function(failure){error[1](failure.message)}).finally(function(){busy[1](false)})}
  function run(){if(!command[0].trim())return;var requestId=runRequest[0]||('competition-run-'+Date.now()+'-'+Math.random().toString(36).slice(2));runRequest[1](requestId);return act('competition.execution-run',{challengeId:selected[0],command:command[0],requestId:requestId}).then(function(value){if(value&&value.execution){executionId[1](value.execution.executionId);runRequest[1]('');return detail(selected[0]).then(function(){setTimeout(function(){readOutput(value.execution.executionId)},500)})}})}
  function readOutput(id,reset){var target=id||executionId[0],stdout=reset?0:stdoutOffset[0],stderr=reset?0:stderrOffset[0];return api('competition.execution-read',{sessionId:props.sessionId,challengeId:selected[0],executionId:target,stdoutOffset:stdout,stderrOffset:stderr,maxBytes:16384}).then(function(value){if(!value.ok)throw Error(value.error||'读取输出失败');executionId[1](value.executionId);stdoutOffset[1](value.nextStdoutOffset||stdout);stderrOffset[1](value.nextStderrOffset||stderr);var part=(value.stdout&&value.stdout.text||'')+(value.stderr&&value.stderr.text?'\n[stderr]\n'+value.stderr.text:'');output[1](reset?part:(output[0]?output[0]+'\n'+part:part));}).catch(function(failure){error[1](failure.message)})}
  function writeInput(){return act('competition.execution-write',{challengeId:selected[0],executionId:executionId[0],text:answer[0]}).then(function(){answer[1]('');return readOutput()})}
  function saveAnswer(status){if(!answer[0])return;return act('competition.answer-add',{challengeId:selected[0],value:answer[0],source:'用户从当前界面提交'}).then(function(value){if(!value||!value.answer)return;if(status==='accepted')return act('competition.answer-update',{challengeId:selected[0],answerId:value.answer.answerId,status:'accepted',confirmedBy:'user',confirmationNote:'用户在当前 Desktop 界面确认'}).then(function(updated){if(updated){answer[1]('');return detail(selected[0])}});answer[1]('');return detail(selected[0])})}
  function toggleKnowledge(){var scene=data[0]&&data[0].scene;return act('knowledge.toggle',{enabled:!(scene&&scene.knowledgeEnabled),expectedRevision:scene&&scene.sceneRevision})}
  function importKnowledge(files){if(!files.length)return;busy[1](true);var chain=Promise.resolve();Array.from(files).forEach(function(file){chain=chain.then(function(){return fileBase64(file)}).then(function(base64){return api('knowledge.import-base64',{sessionId:props.sessionId,name:file.name,base64:base64})}).then(function(value){if(!value.ok)throw Error(value.error||('导入失败：'+file.name))})});return chain.then(load).catch(function(failure){error[1](failure.message)}).finally(function(){busy[1](false)})}
  function searchKnowledge(){if(!knowledgeQuery[0].trim())return;return act('knowledge.search',{query:knowledgeQuery[0],limit:5}).then(function(value){if(value&&value.rows){knowledgeRead[1](value.rows.map(function(row){return row.title+' · '+(row.section||row.sourceLabel||'')+'\n'+row.excerpt}).join('\n\n'))}})}
  function readKnowledgeSource(source){var lines=[];function next(cursor){return api('knowledge.read',{sessionId:props.sessionId,sourceId:source.sourceId,revision:source.revision,cursor:cursor||undefined,maxBytes:8192}).then(function(value){if(!value.ok)throw Error(value.error||'读取资料失败');if(!lines.length)lines.push('# '+value.title);lines.push(value.text);if(value.nextCursor)return next(value.nextCursor);knowledgeRead[1](lines.join('\n'));});}return next().catch(function(failure){error[1](failure.message)})}
  function pageKnowledge(offset){return api('knowledge.list',{sessionId:props.sessionId,offset:offset,limit:20}).then(function(value){if(!value.ok)throw Error(value.error||'读取资料列表失败');knowledgePage[1](value)}).catch(function(failure){error[1](failure.message)})}
  var status=data[0], rows=status&&status.challenges&&status.challenges.rows||[], current=details[0]&&details[0].challenge||rows.find(function(row){return row.challengeId===selected[0]}), knowledgeListing=knowledgePage[0]||status&&status.knowledge||{}, sources=knowledgeListing.rows||[];
  var triggers=props.embedded?null:React.createElement(React.Fragment,null,
    React.createElement('button',{type:'button',className:'dsh-chat-toolbar-button',title:'添加题面、附件或比赛实例。',onClick:function(){props.onOpenChange(true);view[1]('create')}},'添加题目'),
    React.createElement('button',{type:'button',className:'dsh-chat-toolbar-button'+(status&&status.scene&&status.scene.knowledgeEnabled?' is-active':''),title:'导入并查看本题可按需读取的资料。',onClick:function(){props.onOpenChange(true);view[1]('knowledge')}},status&&status.scene&&status.scene.knowledgeEnabled?'本地资料：开':'本地资料：关'));
  if(!props.open)return React.createElement('span',{className:'dsh-chat-entry-group'},triggers);
  var inner;
  if(view[0]==='create'){
    inner=React.createElement('div',null,
      React.createElement('label',{className:'dsh-chat-field'},React.createElement('span',null,'题名'),React.createElement('input',{value:draft[0].title,onChange:function(event){draft[1](Object.assign({},draft[0],{title:event.target.value}))},placeholder:'可空，程序会从题面取建议名'})),
      React.createElement('label',{className:'dsh-chat-field'},React.createElement('span',null,'题面原文'),React.createElement('textarea',{rows:6,value:draft[0].prompt,onChange:function(event){draft[1](Object.assign({},draft[0],{prompt:event.target.value}))},placeholder:'粘贴题面；图片或附件创建后再添加'})),
      React.createElement('label',{className:'dsh-chat-field'},React.createElement('span',null,'实例地址（可空）'),React.createElement('input',{value:draft[0].url,onChange:function(event){draft[1](Object.assign({},draft[0],{url:event.target.value}))}})),
      React.createElement('label',{className:'dsh-chat-field'},React.createElement('span',null,'连接说明（可空）'),React.createElement('textarea',{rows:2,value:draft[0].connection,onChange:function(event){draft[1](Object.assign({},draft[0],{connection:event.target.value}))}})),
      React.createElement('label',{className:'dsh-chat-field'},React.createElement('span',null,'执行环境'),React.createElement('select',{value:draft[0].environment,onChange:function(event){draft[1](Object.assign({},draft[0],{environment:event.target.value}))}},React.createElement('option',{value:'host'},'本机'),React.createElement('option',{value:'docker'},'Docker Linux'))),
      draft[0].environment==='docker'?React.createElement('label',{className:'dsh-chat-field'},React.createElement('span',null,'镜像（不会自动拉取）'),React.createElement('input',{value:draft[0].image,onChange:function(event){draft[1](Object.assign({},draft[0],{image:event.target.value}))}})):null,
      React.createElement('div',{className:'dsh-chat-actions'},React.createElement('button',{type:'button',className:'is-primary',disabled:busy[0],onClick:create},'创建题目'),React.createElement('button',{type:'button',onClick:function(){view[1]('list')}},'返回列表')));
  } else if(view[0]==='knowledge'){
    inner=React.createElement('div',null,
      React.createElement('div',{className:'dsh-row'},React.createElement('label',null,'解题时查阅本地资料'),React.createElement('button',{type:'button',disabled:busy[0],onClick:toggleKnowledge},status&&status.scene&&status.scene.knowledgeEnabled?'已开启':'已关闭')),
      React.createElement('p',{className:'dsh-chat-setting-hint'},'查看、导入和本地搜索不调用模型；模型读取正文才进入上下文。关闭后下一次请求不再声明检索工具。'),
      React.createElement('label',{className:'dsh-chat-field'},React.createElement('span',null,'添加本地资料'),React.createElement('input',{type:'file',multiple:true,onChange:function(event){importKnowledge(event.target.files)}})),
      React.createElement('div',{className:'dsh-chat-fields'},React.createElement('input',{'aria-label':'搜索本地资料',value:knowledgeQuery[0],onChange:function(event){knowledgeQuery[1](event.target.value)},placeholder:'搜索资料标题或正文'}),React.createElement('button',{type:'button',disabled:busy[0],onClick:searchKnowledge},'搜索')),
      knowledgeRead[0]?React.createElement('pre',{className:'dsh-chat-result'},knowledgeRead[0]):null,
      React.createElement('div',{className:'dsh-chat-fields'},sources.map(function(source){return React.createElement('div',{className:'dsh-chat-setting-hint',key:source.sourceId+'@'+source.revision},React.createElement('button',{type:'button',onClick:function(){return readKnowledgeSource(source)}},'打开 '+(source.title||source.sourceId)),' · 修订'+source.revision+' · '+source.parseState+' ',React.createElement('button',{type:'button',onClick:function(){return act('knowledge.delete',{sourceId:source.sourceId}).then(function(){knowledgePage[1](null)});}},'移除索引'))})),
      React.createElement('div',{className:'dsh-chat-actions'},React.createElement('button',{type:'button',disabled:busy[0]||!knowledgeListing.offset,onClick:function(){return pageKnowledge(Math.max(0,(knowledgeListing.offset||0)-20))}},'上一页'),React.createElement('button',{type:'button',disabled:busy[0]||knowledgeListing.nextOffset==null,onClick:function(){return pageKnowledge(knowledgeListing.nextOffset)}},'下一页')),
      React.createElement('div',{className:'dsh-chat-actions'},React.createElement('button',{type:'button',onClick:function(){view[1]('list')}},'返回')));
  } else if(view[0]==='detail'&&current){
    inner=React.createElement('div',null,
      React.createElement('div',{className:'dsh-chat-panel-head'},React.createElement('strong',null,current.title),React.createElement('button',{type:'button',onClick:function(){view[1]('list')}},'题目列表')),
      current.prompt?React.createElement('pre',{className:'dsh-chat-result'},current.prompt):React.createElement('p',{className:'dsh-chat-setting-hint'},'尚未填写题面。'),
      React.createElement('p',{className:'dsh-chat-setting-hint'},'实例修订 '+(current.instance&&current.instance.revision||1)+' · '+current.environment.kind+(current.instance&&current.instance.url?' · '+current.instance.url:'')),
      (current.attachments||[]).length?React.createElement('details',{open:true},React.createElement('summary',null,'题目附件（'+current.attachments.length+'）'),current.attachments.map(function(item){return React.createElement('p',{key:item.id},item.name+' · '+(item.role||'input')+' · '+(item.bytes||0)+' bytes · '+(item.materialId||'') )})):React.createElement('p',{className:'dsh-chat-setting-hint'},'没有题目附件。'),
      React.createElement('div',{className:'dsh-chat-fields'},React.createElement('input',{type:'file',multiple:true,onChange:function(event){addFiles(event.target.files)}})),
      React.createElement('label',{className:'dsh-chat-field'},React.createElement('span',null,'命令'),React.createElement('textarea',{rows:3,value:command[0],onChange:function(event){command[1](event.target.value);runRequest[1]('');},placeholder:'在当前题目 work 目录执行；可继续写入 stdin'})),
      React.createElement('div',{className:'dsh-chat-actions'},React.createElement('button',{type:'button',className:'is-primary',disabled:busy[0],onClick:run},'运行'),React.createElement('button',{type:'button',disabled:!executionId[0],onClick:function(){readOutput()}},'继续读取'),React.createElement('button',{type:'button',disabled:!executionId[0],onClick:function(){stdoutOffset[1](0);stderrOffset[1](0);readOutput(executionId[0],true)}},'从头读取'),React.createElement('button',{type:'button',disabled:!executionId[0],onClick:function(){return act('competition.execution-stop',{challengeId:current.challengeId,executionId:executionId[0]}).then(function(value){if(value)return detail(current.challengeId)})}},'停止')),
      output[0]?React.createElement('pre',{className:'dsh-chat-result'},output[0]):null,
      React.createElement('label',{className:'dsh-chat-field'},React.createElement('span',null,'候选答案或 stdin'),React.createElement('textarea',{rows:2,value:answer[0],onChange:function(event){answer[1](event.target.value)},placeholder:'保留原始大小写和字符'})),
      React.createElement('div',{className:'dsh-chat-actions'},React.createElement('button',{type:'button',disabled:!answer[0]||busy[0],onClick:function(){saveAnswer('pending')}},'保存候选'),React.createElement('button',{type:'button',disabled:!answer[0]||busy[0],onClick:function(){saveAnswer('accepted')}},'人工确认通过'),React.createElement('button',{type:'button',disabled:!executionId[0]||!answer[0],onClick:writeInput},'写入 stdin')),
      details[0]&&(details[0].answers||[]).length?React.createElement('div',null,React.createElement('h3',null,'候选答案'),details[0].answers.map(function(item){return React.createElement('p',{key:item.answerId},React.createElement('code',null,item.value),' · '+item.status+' ',item.status==='pending'?React.createElement('button',{type:'button',onClick:function(){return act('competition.answer-update',{challengeId:current.challengeId,answerId:item.answerId,status:'accepted',confirmedBy:'user',confirmationNote:'用户在平台核对后确认'}).then(function(){return detail(current.challengeId)})}},'人工确认通过'):null)})):null,
    details[0]&&(details[0].executions||[]).length?React.createElement('details',null,React.createElement('summary',null,'执行记录'),details[0].executions.map(function(item){return React.createElement('p',{key:item.executionId},item.executionId+' · '+item.state+' · '+item.environment+' ',React.createElement('button',{type:'button',onClick:function(){stdoutOffset[1](0);stderrOffset[1](0);return readOutput(item.executionId,true)}},'继续此执行'))})):null);
  } else {
    inner=React.createElement('div',null,
      React.createElement('div',{className:'dsh-chat-panel-head'},React.createElement('strong',null,'题目'),React.createElement('span',null,status&&status.summary?status.summary.challenges+' 道题 · 已通过 '+status.summary.acceptedAnswers:'')),
      rows.length?React.createElement('div',null,rows.map(function(row){return React.createElement('button',{key:row.challengeId,type:'button',className:'dsh-chat-session-row',onClick:function(){detail(row.challengeId)}},React.createElement('strong',null,row.title),React.createElement('span',null,row.state))})):React.createElement('p',null,'还没有题目。'),
      React.createElement('div',{className:'dsh-chat-actions'},React.createElement('button',{type:'button',disabled:busy[0]||!status||status.challenges.offset<=0,onClick:function(){return load(Math.max(0,status.challenges.offset-50))}},'上一页'),React.createElement('button',{type:'button',disabled:busy[0]||!status||status.challenges.nextOffset==null,onClick:function(){return load(status.challenges.nextOffset)}},'下一页'),React.createElement('button',{type:'button',className:'is-primary',onClick:function(){view[1]('create')}},'添加题目')));
  }
  var body=React.createElement('div',{className:props.embedded?'dsh-task-workspace':'dsh-chat-more'},React.createElement('div',{className:'dsh-chat-panel-head'},React.createElement('strong',null,'比赛模式'),props.embedded?null:React.createElement('button',{type:'button',onClick:function(){props.onOpenChange(false)}},'关闭')),
      error[0]?React.createElement('p',{role:'alert'},error[0]):null,React.createElement('div',{className:'dsh-competition-body'},inner));
  return props.embedded?body:React.createElement(React.Fragment,null,React.createElement('span',{className:'dsh-chat-entry-group'},triggers),body);
}
function chatOverlayLayout(rect, viewportHeight, viewportWidth) {
  // Keep the close button below Desktop's draggable title bar. If the composer
  // is near the top, use the available viewport instead of forcing a tall panel above it.
  var safeTop=48, margin=12, gap=6;
  var spaceAbove=Math.floor(rect.top-safeTop-gap);
  var bottom=spaceAbove>=240?Math.max(margin,Math.floor(viewportHeight-rect.top+gap)):margin;
  return {maxHeight:Math.max(0,Math.min(720,viewportHeight-safeTop-bottom)),bottom:bottom,
    right:Math.max(margin,Math.floor(viewportWidth-rect.right)),
    width:Math.max(0,Math.min(560,Math.floor(rect.width),viewportWidth-margin*2))};
}
function messageTextBlocks(value, depth) {
  if(depth>4||value==null)return '';
  if(typeof value==='string')return value.slice(0,16384);
  if(Array.isArray(value))return value.map(function(item){return messageTextBlocks(item,depth+1);}).filter(Boolean).join('');
  if(typeof value!=='object')return '';
  if(Array.isArray(value.content))return messageTextBlocks(value.content,depth+1);
  if(value.message)return messageTextBlocks(value.message,depth+1);
  if(value.data)return messageTextBlocks(value.data,depth+1);
  if(value.type==='text'&&typeof value.text==='string')return value.text.slice(0,16384);
  return '';
}
function CurationAction(props) {
  var open=useState(false), curation=useState(null), draft=useState({title:'',body:'',conditions:'',sources:'',product:'',version:'',applicability:'unknown'});
  var selected=useState(''), sourceRef=useState(''), confirmed=useState(false), busy=useState(false), error=useState(''), notice=useState('');
  var availability=useState(null), availabilityError=useState(''), visibility=useState('project');
  var poll=useRef(0), draftTimer=useRef(0), requestRef=useRef('');
  var sessionId=String(props.sessionId||props.session?.id||props.session?.header?.id||curationSessionBridge.sessionId||'');
  useEffect(function(){
    if(!sessionId){availability[1](null);return;}
    var active=true;
    api('curation.available',{sessionId:sessionId}).then(function(value){
      if(!active)return;
      if(value&&value.ok){availability[1](value);availabilityError[1]('');}
      else availabilityError[1](chatError(value||{}));
    }).catch(function(failure){if(active)availabilityError[1](failure.message);});
    return function(){active=false;};
  },[sessionId]);
  function receive(value){
    curation[1](value);
    if(value&&value.draft)draft[1](Object.assign({},value.draft));
  }
  useEffect(function(){
    var state=curation[0]&&curation[0].state, requestId=curation[0]&&curation[0].requestId;
    if(!open[0]||!requestId||(state!=='queued'&&state!=='generating'))return;
    var timer=setInterval(function(){
      api('curation.get',{sessionId:sessionId,requestId:requestId}).then(function(value){
        if(!value.ok)throw Error(chatError(value));
        if(curation[0]&&curation[0].requestId===requestId)receive(value.curation);
      }).catch(function(failure){error[1](failure.message);});
    },1000);
    return function(){clearInterval(timer);};
  },[open[0],curation[0]&&curation[0].requestId,curation[0]&&curation[0].state]);
  function selectedTextForMessage(){
    if(typeof props.selectedText==='string'&&props.selectedText.trim())return props.selectedText.slice(0,16384);
    var fromProps=messageTextBlocks(props.message||props.node||props.item||props.assistantMessage||props.content,0);
    return fromProps||'';
  }
  function sourceText(){
    var text=selectedTextForMessage();
    if(text){var ref=String(props.sourceRef||('assistant-ui:'+String(props.message?.id||props.node?.id||props.id||Date.now())));selected[1](text);sourceRef[1](ref);return Promise.resolve({text:text,sourceRef:ref});}
    var messageId=String(props.messageId||props.message?.id||props.node?.messageId||'');
    if(messageId)return api('curation.message',{sessionId:sessionId,messageId:messageId}).then(function(value){
      if(!value.ok)throw Error(chatError(value));selected[1](value.text);sourceRef[1](value.sourceRef||('assistant:'+messageId));
      return {text:value.text,sourceRef:value.sourceRef||('assistant:'+messageId)};
    });
    return api('curation.latest',{sessionId:sessionId}).then(function(value){
      if(!value.ok)throw Error(chatError(value));selected[1](value.text);sourceRef[1](value.sourceRef||('assistant-ui:'+Date.now()));
      return {text:value.text,sourceRef:value.sourceRef||('assistant-ui:'+Date.now())};
    });
  }
  function begin(forceManual){
    if(!sessionId){error[1]('会话尚未就绪，请稍后再试。');return Promise.resolve();}
    open[1](true);busy[1](true);error[1]('');notice[1]('');
    requestRef.current='curation-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,9);
    return sourceText().then(function(latest){
      return (forceManual?Promise.resolve({ok:true,available:false,reason:'手动编辑'}):(availability[0]?Promise.resolve(availability[0]):api('curation.available',{sessionId:sessionId}))).then(function(value){
        if(!value.ok)throw Error(chatError(value));
        availability[1](value);availabilityError[1]('');
        if(!value.available){notice[1]=(value.reason||'独立整理当前离线')+'；已改为手动编辑。';
          return api('curation.manual',{sessionId:sessionId,requestId:requestRef.current,selectedText:latest.text,sourceRef:latest.sourceRef});}
        return api('curation.start',{sessionId:sessionId,requestId:requestRef.current,selectedText:latest.text,
          sourceRef:latest.sourceRef,model:value.model,route:value.route});
      });
    }).then(function(result){
      if(!result.ok)throw Error(chatError(result));
      receive(result.curation);
    }).catch(function(failure){error[1](failure.message);}).finally(function(){busy[1](false);});
  }
  function setDraftField(key,value){
    var next=Object.assign({},draft[0],{[key]:value});draft[1](next);notice[1]('');
    if(!curation[0]||curation[0].state!=='editing')return;
    clearTimeout(draftTimer.current);
    draftTimer.current=setTimeout(function(){
      api('curation.update',{sessionId:sessionId,requestId:curation[0].requestId,
        expectedEditRevision:curation[0].editRevision,draft:next}).then(function(result){
        if(!result.ok)throw Error(chatError(result));
        curation[1](result.curation);
      }).catch(function(failure){error[1]('草稿保存失败：'+failure.message);});
    },500);
  }
  function cancel(){if(!curation[0])return Promise.resolve();busy[1](true);return api('curation.cancel',{sessionId:sessionId,requestId:curation[0].requestId}).then(function(value){if(!value.ok)throw Error(chatError(value));receive(value.curation);}).catch(function(failure){error[1](failure.message);}).finally(function(){busy[1](false);});}
  function discard(){if(!curation[0])return Promise.resolve();busy[1](true);return api('curation.discard',{sessionId:sessionId,requestId:curation[0].requestId}).then(function(value){if(!value.ok)throw Error(chatError(value));receive(value.curation);notice[1]('已放弃本次整理；必要的费用与状态元数据保留用于核对。');}).catch(function(failure){error[1](failure.message);}).finally(function(){busy[1](false);});}
  function save(asNew){
    if(!curation[0]||curation[0].state!=='editing')return Promise.resolve();
    if(!confirmed[0]){error[1]('保存前请确认已经检查正文和来源。');return Promise.resolve();}
    busy[1](true);error[1]('');notice[1]('');
    return api('curation.save',{sessionId:sessionId,requestId:curation[0].requestId,userConfirmed:true,asNew:asNew===true,
      expectedEditRevision:curation[0].editRevision,visibility:visibility[0],
      title:draft[0].title,body:draft[0].body,conditions:draft[0].conditions,sources:draft[0].sources,
      product:draft[0].product,version:draft[0].version,applicability:draft[0].applicability}).then(function(value){
      if(!value.ok)throw Error(chatError(value));receive(value.curation);
      if(value.curation&&value.curation.requiresChoice){notice[1]=value.curation.message||'已有相近条目，请选择。';return;}
      notice[1]=value.curation&&value.curation.duplicate==='exact'?'内容已存在，已打开原条目。':'已保存为知识；索引状态会在知识库中显示。';
    }).catch(function(failure){error[1](failure.message);}).finally(function(){busy[1](false);});
  }
  var state=curation[0]&&curation[0].state;
  var label=!curation[0]?'整理为知识':state==='queued'?'排队中':state==='generating'?'生成中':state==='editing'?'检查整理稿':state==='saved'?'已保存':state==='failed'?'整理失败':'继续整理';
  return React.createElement(React.Fragment,null,
    React.createElement('span',{style:{display:'inline-flex',alignItems:'center',gap:'8px',flexWrap:'wrap'}},
      React.createElement('button',{type:'button',className:'dsh-curation-trigger',disabled:props.disabled===true,title:props.disabled===true?'没有可整理的回答或发现正文': '点击一次发起独立整理；只发送这条回答（选中文本时只发送选区）及必要证据，不超过 16KiB。',onClick:function(){return begin(false);}},label),
      !props.disabled&&availability[0]&&availability[0].model?React.createElement('small',{style:{fontSize: '12px',opacity:.72}},'模型：'+availability[0].model.provider+' / '+availability[0].model.model+' · '+(availability[0].routeLabel||'去向未知')):null,
      !props.disabled&&availabilityError[0]?React.createElement('small',{style:{fontSize: '12px',opacity:.72}},'模型信息读取失败'):null),
    open[0]?React.createElement('div',{className:'dsh-curation-overlay',onMouseDown:function(event){if(event.target===event.currentTarget)open[1](false);},onKeyDown:function(event){if(event.key==='Escape'){event.stopPropagation();open[1](false);}}},
      React.createElement('div',{className:'dsh-curation-dialog',role:'dialog','aria-modal':'true','aria-label':'整理为知识'},
        React.createElement('div',{className:'dsh-curation-head'},React.createElement('strong',null,'整理为知识'),React.createElement('button',{type:'button',onClick:function(){open[1](false);}},'关闭')),
        React.createElement('div',{className:'dsh-curation-body'},
    React.createElement('p',{className:'dsh-chat-setting-hint'},'一次独立生成：无工具、无并行任务、无自动续接。按下主按钮后立即发送这条回答及必要证据，完成后检查再保存。'),
          busy[0]&&!curation[0]?React.createElement('p',{role:'status'},'正在读取来源与模型信息，随后立即发起一次整理…'):null,
          curation[0]?React.createElement('div',{className:'dsh-curation-meta'},React.createElement('span',null,'模型：'+(curation[0].model&&curation[0].model.provider?curation[0].model.provider+' / '+curation[0].model.model:'手动编辑')),React.createElement('span',null,'状态：'+(state||'')),React.createElement('span',null,'wire：'+(curation[0].wireAttempts||0)),React.createElement('span',null,'费用：'+(curation[0].usage&&curation[0].usage.unknown?'未知':(curation[0].usage&&curation[0].usage.totalTokens!=null?curation[0].usage.totalTokens+' token':'—')))):null,
          selected[0]?React.createElement('details',null,React.createElement('summary',null,'查看将发送的正文（'+new TextEncoder().encode(selected[0]).length+' 字节）'),React.createElement('pre',{className:'dsh-curation-source'},selected[0])):null,
          (state==='queued'||state==='generating')?React.createElement('div',{className:'dsh-curation-progress',role:'status'},React.createElement('span',null,state==='queued'?'等待服务准入，尚未发出。':'已发出，等待独立整理结果…'),React.createElement('button',{type:'button',disabled:busy[0],onClick:cancel},'取消整理')):null,
          (state==='editing'||state==='failed'||state==='cancelled'||state==='saved')?React.createElement('div',{className:'dsh-curation-form'},
            React.createElement('label',null,'标题',React.createElement('input',{value:draft[0].title,disabled:state==='saved'||busy[0],onChange:function(event){setDraftField('title',event.target.value);}})),
            React.createElement('label',null,'可复用做法或结论',React.createElement('textarea',{rows:5,value:draft[0].body,disabled:state==='saved'||busy[0],onChange:function(event){setDraftField('body',event.target.value);}})),
            React.createElement('label',null,'适用条件与前提',React.createElement('textarea',{rows:2,value:draft[0].conditions,disabled:state==='saved'||busy[0],onChange:function(event){setDraftField('conditions',event.target.value);}})),
            React.createElement('label',null,'来源引用',React.createElement('textarea',{rows:2,value:draft[0].sources,disabled:state==='saved'||busy[0],onChange:function(event){setDraftField('sources',event.target.value);}})),
            React.createElement('div',{className:'dsh-curation-grid'},
              React.createElement('label',null,'产品（未知可空）',React.createElement('input',{value:draft[0].product,disabled:state==='saved'||busy[0],onChange:function(event){setDraftField('product',event.target.value);}})),
              React.createElement('label',null,'版本（未知可空）',React.createElement('input',{value:draft[0].version,disabled:state==='saved'||busy[0],onChange:function(event){setDraftField('version',event.target.value);}})),
              React.createElement('label',null,'适用性',React.createElement('select',{value:draft[0].applicability,disabled:state==='saved'||busy[0],onChange:function(event){setDraftField('applicability',event.target.value);}},React.createElement('option',{value:'exact'},'已确认适用'),React.createElement('option',{value:'partial'},'部分适用'),React.createElement('option',{value:'unknown'},'待验证经验')))),
            state!=='saved'?React.createElement('label',{className:'dsh-curation-confirm'},React.createElement('input',{type:'checkbox',checked:confirmed[0],onChange:function(event){confirmed[1](event.target.checked);}}),'我已检查内容、来源和适用条件'):null,
            state!=='saved'?React.createElement('label',{className:'dsh-curation-confirm'},React.createElement('input',{type:'checkbox',checked:visibility[0]==='global',onChange:function(event){visibility[1](event.target.checked?'global':'project');}}),'保存为所有会话可用（个人全局）'):null,
            React.createElement('div',{className:'dsh-curation-actions'},state!=='saved'?React.createElement('button',{type:'button',className:'is-primary',disabled:busy[0]||state!=='editing',onClick:function(){return save(false);}},'保存为知识'):null,
              curation[0]&&curation[0].requiresChoice?React.createElement('button',{type:'button',disabled:busy[0],onClick:function(){return save(true);}},'作为新条目保存'):null,
              state==='failed'||state==='cancelled'?React.createElement('button',{type:'button',disabled:busy[0],onClick:function(){return begin(true);}},'手动编辑'):null,
              state!=='saved'?React.createElement('button',{type:'button',disabled:busy[0],onClick:discard},'放弃'):null,
              React.createElement('button',{type:'button',disabled:busy[0],onClick:function(){open[1](false);}},'稍后继续'))):null,
          notice[0]?React.createElement('p',{role:'status'},notice[0]):null,
          error[0]?React.createElement('p',{role:'alert'},error[0]):null),
        React.createElement('div',{className:'dsh-curation-foot'},React.createElement('small',null,'独立整理不消耗主任务工具/模型额度，但会计入费用核对；超限正文请缩小选择。')))):null);
}
function ChatKnowledgeLibrary(props) {
  var listing=useState(null), query=useState(''), results=useState(null), reading=useState(null);
  var busy=useState(false), error=useState(''), notice=useState(''), status=useState(null);
  function load(offset){
    busy[1](true);error[1]('');
    return api('knowledge.list',{sessionId:props.sessionId,offset:offset||0,limit:30,query:query[0]}).then(function(value){
      if(!value.ok)throw Error(chatError(value));listing[1](value);
      return api('knowledge.status',{sessionId:props.sessionId});
    }).then(function(value){if(value&&value.ok)status[1](value);})
      .catch(function(failure){error[1](failure.message);}).finally(function(){busy[1](false);});
  }
  useEffect(function(){load(0);},[props.sessionId]);
  function search(){
    if(!query[0].trim()){notice[1]('输入关键词后再搜索。');return Promise.resolve();}
    busy[1](true);error[1]('');notice[1]('正在本地检索；仅用户主动搜索，不会发送给模型。');
    return api('knowledge.search',{sessionId:props.sessionId,query:query[0],limit:5}).then(function(value){
      if(!value.ok)throw Error(chatError(value));results[1](value);notice[1](value.rows&&value.rows.length?'找到 '+value.rows.length+' 个相关章节。':'没有匹配资料。');
    }).catch(function(failure){error[1](failure.message);}).finally(function(){busy[1](false);});
  }
  function read(row,cursor){
    busy[1](true);error[1]('');
    return api('knowledge.read',{sessionId:props.sessionId,ref:row.ref||undefined,sourceId:row.sourceId||undefined,cursor:cursor||undefined,maxBytes:8192}).then(function(value){
      if(!value.ok)throw Error(chatError(value));
      var nextRow=value.ref?Object.assign({},row,{ref:value.ref}):row;
      var key=nextRow.ref||nextRow.sourceId||nextRow.title;
      reading[1](function(previous){return {row:nextRow,text:previous&&previous.key===key?previous.text+value.text:value.text,key:key,nextCursor:value.nextCursor,complete:value.complete};});
    }).catch(function(failure){error[1](failure.message);}).finally(function(){busy[1](false);});
  }
  function importFile(file){
    if(!file)return Promise.resolve();busy[1](true);error[1]('');notice[1]('正在保存并建立本地索引：'+file.name);
    return fileBase64(file).then(function(base64){return api('knowledge.import-base64',{sessionId:props.sessionId,name:file.name,title:file.name,base64:base64});}).then(function(value){
      if(!value.ok)throw Error(chatError(value));
      notice[1]('已保存：'+(value.source&&value.source.title||file.name)+'（'+String(value.source&&value.source.indexState||'pending-index')+'）');
      return load(0);
    }).catch(function(failure){error[1](failure.message);}).finally(function(){busy[1](false);});
  }
  function remove(sourceId){
    if(!sourceId)return Promise.resolve();busy[1](true);error[1]('');
    return api('knowledge.delete',{sessionId:props.sessionId,sourceId:sourceId}).then(function(value){
      if(!value.ok)throw Error(chatError(value));notice[1]('已停止后续检索；已有历史引用仍按原修订保留。');return load(0);
    }).catch(function(failure){error[1](failure.message);}).finally(function(){busy[1](false);});
  }
  if(!props.open)return null;
  var rows=listing[0]&&listing[0].rows||[];
  return React.createElement('div',{className:'dsh-chat-more dsh-knowledge-library',role:'dialog','aria-modal':'false','aria-label':'知识库'},
    React.createElement('div',{className:'dsh-chat-panel-head saker-panel-head'},
      React.createElement('div',{className:'saker-panel-headtext'},React.createElement('strong',null,'知识库'),React.createElement('p',{className:'saker-panel-subtitle'},'管理本任务导入的文档；搜索和查看只在本机进行。')),
      React.createElement('button',{type:'button',onClick:props.onClose},'关闭')),
    React.createElement('div',{className:'dsh-chat-settings-body'},
      React.createElement('div',{className:'dsh-knowledge-layout'},
        React.createElement('div',{className:'dsh-knowledge-list'},
          React.createElement('div',{className:'dsh-chat-fields'},React.createElement('input',{'aria-label':'搜索知识库',value:query[0],placeholder:'搜索标题、章节或正文',onChange:function(event){query[1](event.target.value);},onKeyDown:function(event){if(event.key==='Enter')return search();}}),React.createElement('button',{type:'button',disabled:busy[0],onClick:search},'搜索')),
          React.createElement('div',{className:'dsh-chat-actions'},React.createElement('label',{className:'saker-ui-btn'},'导入文档',React.createElement('input',{type:'file',multiple:true,disabled:busy[0],style:{display:'none'},onChange:function(event){var files=Array.from(event.target.files||[]);event.target.value='';var chain=Promise.resolve();files.forEach(function(file){chain=chain.then(function(){return importFile(file);});});return chain;}}))),
          status[0]?React.createElement('small',{className:'saker-panel-hint'},(status[0].legacy&&status[0].legacy.available?'内置知识 '+status[0].legacy.documents+' 篇（只读） · ':'')+'已导入 '+status[0].documents+' 份文档'):null,
          results[0]?React.createElement('div',{className:'dsh-knowledge-results'},React.createElement('h4',null,'搜索结果'),
            results[0].rows.length?results[0].rows.map(function(row){return React.createElement('button',{type:'button',key:row.ref,onClick:function(){return read(row);}},React.createElement('strong',null,row.title),React.createElement('span',null,(row.section||'')+' · '+row.sourceLabel),React.createElement('small',null,row.excerpt));}):React.createElement('p',null,'没有找到匹配的文档。')):null,
          React.createElement('h4',null,'已导入文档'),
          rows.length?rows.map(function(row){return React.createElement('div',{className:'dsh-knowledge-row',key:row.sourceId},
            React.createElement('div',null,React.createElement('strong',null,row.title),React.createElement('small',null,(row.sourceLabel||'')+' · 修订 '+row.revision)),
            React.createElement('div',{className:'dsh-knowledge-row-actions'},React.createElement('button',{type:'button',disabled:busy[0],onClick:function(){return read({ref:null,sourceId:row.sourceId,title:row.title});}},'查看'),React.createElement('button',{type:'button',disabled:busy[0],onClick:function(){return remove(row.sourceId);}},'移出查询')));}):React.createElement('div',{className:'saker-panel-empty'},React.createElement('strong',null,'还没有文档'),React.createElement('span',null,'导入文档后，Saker 才能在本会话中按需查询。')),
          status[0]&&status[0].legacy&&status[0].legacy.available?React.createElement('p',{className:'saker-panel-hint'},'内置知识随 Saker 提供，搜索时自动参与；不会写入你的导入列表，也不会改动原库。'):null,
          React.createElement('div',{className:'dsh-chat-actions'},React.createElement('button',{type:'button',disabled:busy[0]||!listing[0]||listing[0].offset<=0,onClick:function(){return load(Math.max(0,(listing[0].offset||0)-30));}},'上一页'),React.createElement('button',{type:'button',disabled:busy[0]||!listing[0]||listing[0].nextOffset==null,onClick:function(){return load(listing[0].nextOffset);}},'下一页'))),
        React.createElement('div',{className:'dsh-knowledge-reader'},reading[0]?React.createElement('div',{className:'dsh-knowledge-read'},React.createElement('h4',null,reading[0].row.title||'文档正文'),React.createElement('pre',{className:'dsh-chat-result'},reading[0].text),reading[0].nextCursor?React.createElement('button',{type:'button',disabled:busy[0],onClick:function(){return read(reading[0].row,reading[0].nextCursor);}},'继续读取'):React.createElement('small',null,'已读完当前章节。')):React.createElement('div',{className:'saker-panel-empty'},React.createElement('strong',null,'选择一份文档'),React.createElement('span',null,'正文会在这里打开，不需要离开当前任务。')))) ,
      notice[0]?React.createElement('p',{role:'status'},notice[0]):null,
      error[0]?React.createElement('p',{role:'alert'},error[0]):null));
}
var WORKFLOW_NEW_NODES=[
  {id:'scope',title:'明确目标和范围',instruction:'用一句话写清要检查的对象、允许做的事情和已知材料。',tools:[],output:'本轮目标和范围。',completion:'artifact',evidencePolicy:'none',identityRef:''},
  {id:'execute',title:'执行并记录',instruction:'按目标做一次可验证的动作，保留请求、回执或文件依据。',tools:[],output:'可复查的执行结果和证据。',completion:'artifact',evidencePolicy:'none',identityRef:''}
];
function workflowClone(value){return JSON.parse(JSON.stringify(value||{}));}
function workflowNewId(prefix){return 'step-'+prefix+'-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,6);}
function ChatWorkflowStudio(props){
  var catalog=useState([]), selected=useState(null), detail=useState(null), query=useState('');
  var editor=useState(false), draft=useState(null), activeNode=useState(0), history=useState([]), future=useState([]);
  var replaceFrom=useState(''), replaceTo=useState('');
  var busy=useState(false), notice=useState(''), error=useState('');
  function load(preferred){
    busy[1](true);error[1]('');
    return api('workflow.catalog',{sessionId:props.sessionId}).then(function(result){
      if(!result.ok)throw Error(chatError(result));
      var list=Array.isArray(result.workflows)?result.workflows:[];
      catalog[1](list);selected[1](result.selected||null);
      var id=preferred||(result.selected&&result.selected.id)||(list[0]&&list[0].id);
      if(!id)return null;
      return api('workflow.detail',{sessionId:props.sessionId,id:id}).then(function(value){
        if(!value.ok)throw Error(chatError(value));
        detail[1](value.workflow||null);selected[1](value.selected||result.selected||null);
        return value.workflow||null;
      });
    }).catch(function(failure){error[1](failure.message);return null;}).finally(function(){busy[1](false);});
  }
  useEffect(function(){if(props.open)load();},[props.open,props.sessionId]);
  function choose(id){
    if(!id)return;
    busy[1](true);error[1]('');
    api('workflow.detail',{sessionId:props.sessionId,id:id}).then(function(result){
      if(!result.ok)throw Error(chatError(result));
      detail[1](result.workflow||null);selected[1](result.selected||null);
    }).catch(function(failure){error[1](failure.message);}).finally(function(){busy[1](false);});
  }
  function useSelected(){
    if(!detail[0])return;
    busy[1](true);error[1]('');notice[1]('');
    api('workflow.select',{sessionId:props.sessionId,id:detail[0].id}).then(function(result){
      if(!result.ok)throw Error(chatError(result));
      selected[1](result.selected||detail[0]);notice[1]('已选择，下一次发送会使用这个测试流程。');
      return load((result.selected&&result.selected.id)||detail[0].id);
    }).catch(function(failure){error[1](failure.message);}).finally(function(){busy[1](false);});
  }
  function beginEdit(source,scope){
    var base=source?workflowClone(source):{
      id:'',version:'1',title:'我的测试流程',description:'按你的工作顺序安排的测试步骤。',mode:'pentest',
      nodes:workflowClone(WORKFLOW_NEW_NODES)
    };
    if(!Array.isArray(base.nodes)||base.nodes.length<2){base.nodes=workflowClone(WORKFLOW_NEW_NODES);}
    base.nodes=base.nodes.map(function(item){item=workflowClone(item);delete item.next;return item;});
    if(!base.nodes[0].id)base.nodes[0].id='scope';
    if(!base.nodes[1].id)base.nodes[1].id='execute';
    draft[1](base);activeNode[1](0);history[1]([]);future[1]([]);editor[1](true);notice[1]('');
    notice[1]((scope==='personal'?'另存为我的流程':'只改这一轮；不会改动内置流程')+'。');
  }
  function commit(next){
    if(!draft[0])return;
    history[1](function(previous){return previous.concat([workflowClone(draft[0])]).slice(-40);});
    future[1]([]);draft[1](next);
  }
  function undo(){
    if(!history[0].length)return;
    var previous=history[0][history[0].length-1];
    future[1](function(items){return [workflowClone(draft[0])].concat(items).slice(0,40);});
    history[1](history[0].slice(0,-1));draft[1](previous);activeNode[1](Math.min(activeNode[0],Math.max(0,previous.nodes.length-1)));
  }
  function redo(){
    if(!future[0].length)return;
    var next=future[0][0];
    history[1](history[0].concat([workflowClone(draft[0])]).slice(-40));
    future[1](future[0].slice(1));draft[1](next);activeNode[1](Math.min(activeNode[0],Math.max(0,next.nodes.length-1)));
  }
  function patchDraft(patch){
    var next=workflowClone(draft[0]||{});Object.assign(next,patch);commit(next);
  }
  function patchNode(index,patch){
    var next=workflowClone(draft[0]||{});next.nodes=Array.isArray(next.nodes)?next.nodes.map(function(node,nodeIndex){
      return nodeIndex===index?Object.assign({},node,patch):node;
    }):[];commit(next);
  }
  function addNode(){
    var next=workflowClone(draft[0]||{});var nodes=Array.isArray(next.nodes)?next.nodes.slice():[];
    if(nodes.length>=12){error[1]('最多 12 个步骤。');return;}
    var item={id:workflowNewId('node'),title:'新步骤',instruction:'写清这一步要做什么、需要什么依据、怎样算完成。',tools:[],output:''};
    var at=Math.max(0,Math.min(nodes.length,Number(activeNode[0])+1));nodes.splice(at,0,item);next.nodes=nodes;commit(next);activeNode[1](at);
  }
  function removeNode(index){
    if(!draft[0]||draft[0].nodes.length<=2){error[1]('至少保留两个步骤。');return;}
    var next=workflowClone(draft[0]);next.nodes=draft[0].nodes.filter(function(_,nodeIndex){return nodeIndex!==index;});
    commit(next);activeNode[1](Math.max(0,Math.min(index,next.nodes.length-1)));
  }
  function moveNode(index,delta){
    var next=workflowClone(draft[0]);var target=index+delta;
    if(!next.nodes||target<0||target>=next.nodes.length)return;
    var moved=next.nodes[index];next.nodes[index]=next.nodes[target];next.nodes[target]=moved;
    commit(next);activeNode[1](target);
  }
  function replaceTools(){
    var from=String(replaceFrom[0]||'').trim(),to=String(replaceTo[0]||'').trim();
    if(!from||!to){error[1]('批量换工具需要填写原工具和新工具。');return;}
    var next=workflowClone(draft[0]||{}),changed=0;
    next.nodes=(next.nodes||[]).map(function(item){
      var tools=Array.isArray(item.tools)?item.tools.slice():[];
      tools=tools.map(function(name){if(name===from){changed++;return to;}return name;});
      return Object.assign({},item,{tools:tools});
    });
    if(!changed){error[1]('当前测试流程里没有 '+from+'；没有改动。');return;}
    commit(next);error[1]('');notice[1]('已将 '+changed+' 处 '+from+' 换成 '+to+'；下一轮按实际可用工具核对。');
  }
  function save(scope){
    if(!draft[0])return;
    if(!String(draft[0].title||'').trim()){error[1]('先给测试流程起个名字。');return;}
    busy[1](true);error[1]('');notice[1]('');
    var payload=workflowClone(draft[0]);
    api('workflow.save',{sessionId:props.sessionId,scope:scope,id:scope==='personal'?'':(payload.id||''),workflow:payload,select:true})
      .then(function(result){
        if(!result.ok)throw Error(chatError(result));
        selected[1](result.selected||null);notice[1](scope==='personal'?'已保存到我的流程，并用于这一轮。':'已用于这一轮，不会改动内置流程。');
        editor[1](false);return load(result.workflow&&result.workflow.id);
      }).catch(function(failure){error[1](failure.message);}).finally(function(){busy[1](false);});
  }
  var rows=(catalog[0]||[]).filter(function(item){
    var term=String(query[0]||'').trim().toLowerCase();
    return !term||[item.title,item.description,item.id].join(' ').toLowerCase().indexOf(term)>=0;
  });
  var shown=editor[0]?draft[0]:detail[0];
  var stageNodes=shown&&Array.isArray(shown.nodes)?shown.nodes:[];
  var node=stageNodes[activeNode[0]]||stageNodes[0]||null;
  function nodeField(label,value,onChange,multiline){
    return React.createElement('label',{className:'saker-field'},React.createElement('span',null,label),
      multiline?React.createElement('textarea',{rows:3,value:value||'',onChange:onChange}):React.createElement('input',{value:value||'',onChange:onChange}));
  }
  return React.createElement('div',{className:'dsh-chat-more saker-workflow-panel',role:'dialog','aria-modal':'false','aria-label':'测试流程选择与编辑'},
    React.createElement('div',{className:'dsh-chat-panel-head saker-panel-head'},
      React.createElement('div',{className:'saker-panel-headtext'},React.createElement('strong',null,'测试流程'),
        React.createElement('p',{className:'saker-panel-subtitle'},editor[0]?'调整步骤、顺序和工具；保存只影响这一轮，也可以另存为个人流程。':'选择一套测试步骤。不会自动发送，也不会扩大授权范围。')),
      React.createElement('button',{type:'button','aria-label':'关闭测试流程面板',onClick:props.onClose},'关闭')),
    React.createElement('div',{className:'saker-workflow-layout'},
      React.createElement('aside',{className:'saker-workflow-list'},
        React.createElement('input',{type:'search','aria-label':'搜索测试流程',placeholder:'搜索测试流程',value:query[0],onChange:function(event){query[1](event.target.value);}}),
        React.createElement('div',{className:'saker-workflow-list-head'},React.createElement('strong',null,'可用流程'),React.createElement('button',{type:'button',onClick:function(){beginEdit(null,'session');}},'新建')),
        rows.length?rows.map(function(item){return React.createElement('button',{type:'button',key:item.id,className:'saker-workflow-item'+(detail[0]&&detail[0].id===item.id?' is-active':''),onClick:function(){choose(item.id);}},
          React.createElement('span',null,React.createElement('strong',null,item.title),React.createElement('small',null,item.nodes+' 步 · '+(item.source==='builtin'?'内置':'我的流程'))),
          selected[0]&&selected[0].id===item.id?React.createElement('em',null,'使用中'):null);}):React.createElement('div',{className:'saker-panel-empty'},React.createElement('strong',null,'没有匹配的流程'),React.createElement('span',null,'可以新建一个。'))),
      React.createElement('section',{className:'saker-workflow-main'},
        editor[0]?React.createElement('div',{className:'saker-workflow-editor-head'},
          React.createElement('div',null,React.createElement('strong',null,draft[0]&&draft[0].title||'我的测试流程'),React.createElement('small',null,'编辑只影响这一轮；另存后才会进入我的流程。')),
          React.createElement('div',{className:'saker-workflow-actions'},
            React.createElement('button',{type:'button',disabled:!history[0].length,onClick:undo},'撤销'),
            React.createElement('button',{type:'button',disabled:!future[0].length,onClick:redo},'重做'),
            React.createElement('button',{type:'button',onClick:addNode},'添加步骤')))
          :null,
        shown?React.createElement('div',{className:'saker-workflow-stage-wrap'},
          React.createElement('div',{className:'saker-workflow-stage-head'},
            React.createElement('div',null,React.createElement('strong',null,shown.title),React.createElement('p',null,shown.description||'按顺序完成，每一步都留下依据。'))),
          React.createElement('div',{className:'saker-stage-rail','aria-label':'步骤图'},
            stageNodes.map(function(item,index){return React.createElement('button',{type:'button',key:item.id||index,className:'saker-stage'+(index===activeNode[0]?' is-active':'')+(index<(editor[0]?0:1)?' is-done':''),onClick:function(){activeNode[1](index);}},
              React.createElement('span',null,String(index+1)),React.createElement('strong',null,item.title||'未命名步骤'),React.createElement('small',null,(item.completion==='receipt'?(item.evidencePolicy==='reuse'?'可复用历史回执 · ':'需本次真实回执 · '):'需结构化证据 · ')+((item.tools||[]).length?item.tools.join(' · '):'不限定工具')));})),
          editor[0]?React.createElement('div',{className:'saker-workflow-editor-grid'},
            React.createElement('div',{className:'saker-workflow-fields'},
              nodeField('流程名称',draft[0].title,function(event){patchDraft({title:event.target.value});}),
              nodeField('一句话说明',draft[0].description,function(event){patchDraft({description:event.target.value});},true),
              node?React.createElement('div',{className:'saker-workflow-node-edit'},
                React.createElement('div',{className:'saker-workflow-node-actions'},React.createElement('strong',null,'步骤 '+(activeNode[0]+1)),React.createElement('span',null,
                  React.createElement('button',{type:'button',disabled:activeNode[0]<=0,onClick:function(){moveNode(activeNode[0],-1);}},'上移'),
                  React.createElement('button',{type:'button',disabled:activeNode[0]>=stageNodes.length-1,onClick:function(){moveNode(activeNode[0],1);}},'下移'),
                  React.createElement('button',{type:'button',disabled:stageNodes.length<=2,onClick:function(){removeNode(activeNode[0]);}},'删除'))),
                nodeField('步骤名称',node.title,function(event){patchNode(activeNode[0],{title:event.target.value});}),
                nodeField('这一步做什么',node.instruction,function(event){patchNode(activeNode[0],{instruction:event.target.value});},true),
                nodeField('用什么工具（逗号分隔，可留空）',(node.tools||[]).join(', '),function(event){patchNode(activeNode[0],{tools:event.target.value.split(',').map(function(value){return value.trim();}).filter(Boolean)});}),
                nodeField('完成后会留下什么',node.output,function(event){patchNode(activeNode[0],{output:event.target.value});},true),
                React.createElement('label',{className:'saker-field'},React.createElement('span',null,'推进时必须有什么'),
                  React.createElement('select',{value:node.completion||'artifact',onChange:function(event){var value=event.target.value;patchNode(activeNode[0],{completion:value,evidencePolicy:value==='receipt'?(node.evidencePolicy==='reuse'?'reuse':'fresh'):'none',identityRef:value==='receipt'?(node.identityRef||''):''});}},
                    React.createElement('option',{value:'artifact'},'结构化证据'),
                    React.createElement('option',{value:'receipt'},'真实执行回执'))),
                (node.completion==='receipt')?React.createElement('label',{className:'saker-field'},React.createElement('span',null,'回执来源'),
                  React.createElement('select',{value:node.evidencePolicy==='reuse'?'reuse':'fresh',onChange:function(event){patchNode(activeNode[0],{evidencePolicy:event.target.value});}},
                    React.createElement('option',{value:'fresh'},'必须本次新执行'),
                    React.createElement('option',{value:'reuse'},'允许复用历史证据'))):null,
                (node.completion==='receipt')?nodeField('必须是哪个账号（可留空）',node.identityRef||'',function(event){patchNode(activeNode[0],{identityRef:event.target.value});}):null):null),
            React.createElement('details',{className:'saker-workflow-step'},
              React.createElement('summary',null,'批量换工具'),
              React.createElement('p',null,'只替换测试流程中完全同名的工具；是否可用由下一轮实际 Host 工具表判断。'),
              React.createElement('div',{className:'saker-workflow-actions'},
                React.createElement('input',{'aria-label':'原工具',placeholder:'例如 redteam_execution',value:replaceFrom[0],onChange:function(event){replaceFrom[1](event.target.value);}}),
                React.createElement('input',{'aria-label':'替换为',placeholder:'例如 mcp_call',value:replaceTo[0],onChange:function(event){replaceTo[1](event.target.value);}}),
                React.createElement('button',{type:'button',onClick:replaceTools},'替换同类工具'))),
            React.createElement('div',{className:'saker-workflow-note'},React.createElement('strong',null,'会怎样生效'),React.createElement('p',null,'下一次发送时，模型会看到当前测试流程，先用 saker_workflow 取得当前步骤；保存不会发送消息。')))
            :React.createElement('div',{className:'saker-workflow-preview'},
              React.createElement('div',{className:'saker-workflow-preview-head'},React.createElement('div',null,React.createElement('strong',null,'这套流程会做哪些事'),React.createElement('p',null,'每一步都可以在执行时根据证据调整。')),React.createElement('button',{type:'button',className:'is-primary',onClick:useSelected},selected[0]&&selected[0].id===detail[0].id?'正在使用':'使用此流程')),
              stageNodes.map(function(item,index){return React.createElement('details',{key:item.id||index,className:'saker-workflow-step'},React.createElement('summary',null,String(index+1)+'. '+(item.title||'未命名步骤')),React.createElement('p',null,item.instruction),React.createElement('small',null,'完成条件：'+(item.output||'未填写')+' · '+(item.completion==='receipt'?(item.evidencePolicy==='reuse'?'可复用完整性有效的历史回执':'必须是本次运行后采集的真实回执'):'必须提交结构化证据')));}),
              React.createElement('div',{className:'saker-workflow-actions'},React.createElement('button',{type:'button',onClick:function(){beginEdit(detail[0],'session');}},'编辑本次'),React.createElement('button',{type:'button',onClick:function(){beginEdit(detail[0],'personal');}},'另存为我的流程'),React.createElement('button',{type:'button',onClick:function(){beginEdit(null,'session');}},'新建流程'))))
          :React.createElement('div',{className:'saker-panel-empty'},React.createElement('strong',null,busy[0]?'正在读取测试流程…':'还没有选择测试流程'),React.createElement('span',null,'可以从左侧选择，也可以新建一个。')),
        error[0]?React.createElement('p',{role:'alert'},error[0]):null,
        notice[0]?React.createElement('p',{role:'status'},notice[0]):null,
        editor[0]?React.createElement('div',{className:'saker-workflow-save'},React.createElement('button',{type:'button',className:'is-primary',onClick:function(){save('session');}},'只用这一轮'),React.createElement('button',{type:'button',onClick:function(){save('personal');}},'另存为我的流程'),React.createElement('button',{type:'button',onClick:function(){editor[1](false);error[1]('');}},'取消编辑')):null)));
}
function ChatComponentSummary(props) {
  var info = props.info || {};
  var facts = info.facts || [];
  var advisories = info.advisories || [];
  var evaluations = info.evaluations || [];
  var upstreams = info.upstreams || [];
  if (!facts.length && !advisories.length && !evaluations.length && !upstreams.length)
    return props.error ? React.createElement('p', { role: 'alert' }, '组件记录读取失败：' + props.error) : null;
  return React.createElement('div', { className: 'dsh-chat-component-summary' },
    React.createElement('p', { className: 'dsh-chat-task-detail-stats' },
      '组件 ' + facts.length + ' · 公告/更新 ' + advisories.length + ' · 评估 ' + evaluations.length + (upstreams.length ? ' · 上游 ' + upstreams.length : '')),
    React.createElement('details', { className: 'dsh-chat-component-details' },
      React.createElement('summary', null, '查看组件事实与最近评估'),
      React.createElement('div', { className: 'dsh-chat-component-list' },
        facts.slice(0, 5).map(function (item) {
          return React.createElement('p', { key: item.id },
            '事实：' + item.product + ' ' + (item.version || '版本未知') + (item.assetId ? ' · ' + item.assetId : ' · 未映射目标'));
        }),
        advisories.slice(0, 5).map(function (item) {
          return React.createElement('p', { key: item.id },
            (item.kind === 'security-change' ? '安全更新：' : '公告：') + item.id
              + (item.fixedVersion ? ' · 修复 ' + item.fixedVersion : ''));
        }),
        evaluations.slice(0, 5).map(function (item) {
          return React.createElement('p', { key: item.id },
            '评估：' + item.status + ' · ' + String(item.reason || '').slice(0, 140));
        }),
        upstreams.slice(0, 5).map(function (item) {
          return React.createElement('p', { key: item.id },
            '上游：' + (item.selected && item.selected.repositoryUrl || '待选择') + ' · ' + item.status);
        }))));
}
function ChatRoleSummary(props) {
  var info=props.info||{}, work=info.workItems||[], instances=info.instances||[], messages=info.messages||[];
  if(!work.length&&!instances.length)return props.error?React.createElement('p',{role:'alert'},'工作与角色读取失败：'+props.error):null;
  var labels={proposed:'待确认',queued:'排队',starting:'启动中',active:'进行中',waiting:'等待交接',blocked:'受阻',completed:'已完成',stopped:'已停止',released:'已释放','cleanup-failed':'释放未确认'};
  var releaseLabels={unreleased:'未释放',stopping:'停止处理中',released:'已释放','cleanup-failed':'释放未确认',unknown:'释放未知'};
  return React.createElement('div',{className:'dsh-chat-role-summary'},
    React.createElement('p',{className:'dsh-chat-task-detail-stats'},'具体工作 '+work.length+' · 角色实例 '+instances.length+' · 消息 '+messages.length),
    React.createElement('details',{className:'dsh-chat-component-details'},
      React.createElement('summary',null,'查看具体问题、分工与交接'),
      React.createElement('div',{className:'dsh-chat-component-list'},
        work.slice(0,6).map(function(item){return React.createElement('p',{key:item.workId},'问题：'+(item.title||item.question)+' · '+(labels[item.state]||item.state||'待确认')+(item.executionState&&item.executionState!==item.state?' · 执行'+item.executionState:'')+(item.releaseState&&item.releaseState!=='released'?' · '+(releaseLabels[item.releaseState]||item.releaseState):'')+(item.settlement?' · '+item.settlement.label:''));}),
        instances.slice(0,6).map(function(item){return React.createElement('p',{key:item.childId},'角色：'+(item.roleTitle||item.roleId)+' · '+(labels[item.state]||item.state||'')+(item.releaseState&&item.releaseState!=='released'?' · '+(releaseLabels[item.releaseState]||item.releaseState):'')+(item.releaseAttempt>1?' · 第'+item.releaseAttempt+'次释放':'')+(item.releaseError?' · '+String(item.releaseError).slice(0,80):'')+(item.settlement?' · '+item.settlement.label:'')+(item.logicalParent?' · 交接自 '+item.logicalParent:''));}),
        messages.slice(0,4).map(function(item){return React.createElement('p',{key:item.messageId},'交接：'+(item.kind||'message')+' · '+(item.state||'')+' · '+String(item.text||'').slice(0,100));}))));
}

// 只有真实任务或仍在收尾的代理才需要持续刷新。没有 task policy 时，
// 服务端用 phase='preparing' 表示“尚未开始”；它不能被当成活动轮询的信号，
// 否则空会话会每 3 秒发一次 chat.settings。
function chatNeedsPolling(live) {
  if (!live) return false;
  if (live.agentRunning === true || Number(live.active || 0) > 0) return true;
  return !!live.policy && ['preparing', 'running', 'pausing'].includes(live.phase);
}

function ChatSetup(props) {
  var state=useState(null), busy=useState(false), notice=useState(''), error=useState(''), panel=useState(null);
  // 「继续其他检查」只关掉本会话这一条提示，不改变任何任务状态（v6 第 5.2 节）。
  var attentionDismissed=useState(false);
  var readError=useState('');
  var request=useRef(0), mounted=useRef(true), saving=useRef(false), openButton=useRef(null), moreButton=useRef(null), moduleButton=useRef(null), collabButton=useRef(null), workflowButton=useRef(null), overlayRoot=useRef(null), retryTimer=useRef(0);
  // v6 第 3.3 节第 8 条：提示词抽屉的插入落点必须在**打开抽屉之前**捕获，否则宿主 caretSpan 已经
  // 因为编辑器失焦而退化成文档末尾，原来的光标/选区就丢了。
  var promptInsertion=useRef(null);
  var sendBurst=useRef([]);
  // 三个入口共用一份「当前打开哪个面板」：始终最多一个（v6 第 10.5 节 UI09/UI12）。
  function setPanelOnly(name, next){ panel[1](function(previous){ if(next) return name; return previous===name?null:previous; }); }
  function starterDraftText(){
    try{
      if(typeof document==='undefined')return '';
      var editor=document.querySelector('[data-composer-input="true"]');
      return editor?String(editor.innerText||'').replace(/\r\n/g,'\n'):'';
    }catch(_error){return '';}
  }
  var open=[panel[0]==='prompt', function(next){ setPanelOnly('prompt',next); }];
  var more=[panel[0]==='settings', function(next){ setPanelOnly('settings',next); }];
  var collab=[panel[0]==='collab', function(next){ setPanelOnly('collab',next); }];
  var knowledgeOpen=[panel[0]==='knowledge', function(next){ setPanelOnly('knowledge',next); }];
  var workflowOpen=[panel[0]==='workflow', function(next){ setPanelOnly('workflow',next); }];
  var moduleOpen=[panel[0]==='modules', function(next){ setPanelOnly('modules',next); }];
	var moduleList=useState(null), moduleError=useState(''), moduleText=useState(''), moduleCategory=useState(''), moduleStatus=useState(''), moduleSelected=useState(null), moduleBusy=useState(false);
	var moduleReq=useRef(0), moduleTimer=useRef(null), moduleComposing=useRef(false);
  var taskDetailsOpen=[panel[0]==='details', function(next){ setPanelOnly('details',next); }];
  var menuOpen=[panel[0]==='menu', function(next){ setPanelOnly('menu',next); }];
  var componentInfo=useState(null), componentError=useState(''), componentReq=useRef(0);
  var roleInfo=useState(null), roleError=useState(''), roleReq=useRef(0);
  var settingsSection=useState('scope');
  var settingsQuery=useState('');
  var collabDraft=useState(null);
  var workerDraft=useState('0'), customWorkers=useState('3'), draft=useState(null), workScenario=useState('free');
  // 宿主场景 chip 与 Saker 的场景上下文是两个插件；chip 选中后广播，
  // 让“测试文档/开始检查”立即按新场景渲染，不用等任务刷新。
  var hostScene=useState(typeof window!=='undefined'&&window.__sakerSelectedScene?String(window.__sakerSelectedScene):'');
  function draftStorageKey(kind){return 'saker.chat.draft.'+kind+'.'+props.sessionId;}
  function readDraftStorage(kind){try{var value=window.localStorage.getItem(draftStorageKey(kind));var parsed=value?JSON.parse(value):null;return parsed&&typeof parsed==='object'?parsed:null;}catch(_error){return null;}}
  function writeDraftStorage(kind,value){try{if(value&&Object.keys(value).length)window.localStorage.setItem(draftStorageKey(kind),JSON.stringify(value));else window.localStorage.removeItem(draftStorageKey(kind));}catch(_error){/* localStorage unavailable: keep the in-memory draft */}}
  var startQuestion=useState('');
  // 本轮预算（开始测试时用）：放在抽屉的「限制请求和用量」折叠里，任务页单独使用时由 TaskPanel 自己管。
  var budget=useState({calls:'',modelCalls:'',tokens:'',minutes:'',unmetered:''});
  var inlineAssetView=useState(false);
  function setBudget(patch){budget[1](function(previous){return Object.assign({},previous||{},patch);});}
  var decisionNote=useState('');
  function load(attempt){var revision=++request.current;return api('chat.settings',{sessionId:props.sessionId}).then(function(result){
    if(!result.ok)throw Error(chatError(result));
    if(!mounted.current||request.current!==revision||saving.current)return result;
    // Reading or polling must not turn displayed defaults into a user choice.
    // Explicit controls persist preferences through run('task.choose', ...).
    return result;
  }).then(function(result){
    if(!result.ok)throw Error(chatError(result));if(mounted.current&&request.current===revision&&!saving.current){state[1](result);readError[1]('');}
  }).catch(function(failure){if(!mounted.current||request.current!==revision)return;
    // 新打开的旧会话可能在宿主完成会话装载前到达这里。先快速重试，避免
    // 输入区短暂闪出一条吓人的 HTTP 400；连续失败才如实显示。
    var rawMessage=String(failure&&failure.message||'');
    var retrying=(Number(attempt)||0)<4&&/请选择当前可用的 ?Saker 会话/.test(rawMessage);
    if(retrying){clearTimeout(retryTimer.current);retryTimer.current=setTimeout(function(){if(mounted.current)load((Number(attempt)||0)+1);},400);return;}
    // 宿主要在会话装载完成后才认这个 id；不要把内部 HTTP 400 原样甩给新用户。
    readError[1](/请选择当前可用的 ?Saker 会话/.test(rawMessage)?'这个会话还没有开始安全任务。直接在输入框发送目标和授权范围即可开始；已有任务的设置可在任务开始后调整。':rawMessage);});}
  useEffect(function(){mounted.current=true;load(0);return function(){mounted.current=false;request.current++;clearTimeout(retryTimer.current);};},[props.sessionId, props.session]);
  // Only while work is actually running. Finished sessions refresh on a new
  // host session event, opening task details, or a manual action.
  useEffect(function(){var live=state[0],active=chatNeedsPolling(live);if(!active)return;var timer=setInterval(function(){load(0);},3000);return function(){clearInterval(timer);};},[props.sessionId,state[0]&&state[0].phase,state[0]&&state[0].agentRunning,state[0]&&state[0].active]);
  useEffect(function(){if(!open[0]&&!more[0]&&!collab[0]&&!knowledgeOpen[0]&&!workflowOpen[0]&&!taskDetailsOpen[0]&&!menuOpen[0])return;var root=overlayRoot.current;if(typeof window==='undefined'||!root||typeof root.getBoundingClientRect!=='function')return;function fit(){var rect=root.getBoundingClientRect(),viewport=window.innerHeight||document.documentElement.clientHeight||820,viewportWidth=window.innerWidth||document.documentElement.clientWidth||1280;var layout=chatOverlayLayout(rect,viewport,viewportWidth);if(workflowOpen[0]){layout.width=Math.min(1040,viewportWidth-32);layout.bottom=12;layout.right=12;layout.maxHeight=Math.max(0,Math.min(760,viewport-60));}else if(more[0]){layout.width=Math.min(980,viewportWidth-32);layout.bottom=12;layout.right=12;layout.maxHeight=Math.max(0,Math.min(720,viewport-48-12));}else if(taskDetailsOpen[0]){layout.width=Math.min(680,viewportWidth-32);layout.bottom=12;layout.maxHeight=Math.max(0,Math.min(680,viewport-60));}else if(menuOpen[0]){layout.width=Math.min(260,viewportWidth-24);layout.bottom=12;layout.maxHeight=Math.max(0,Math.min(360,viewport-60));}else if(knowledgeOpen[0])layout.width=Math.min(900,viewportWidth-32);else if(collab[0]){layout.width=Math.min(620,viewportWidth-24);layout.bottom=12;layout.maxHeight=Math.max(0,Math.min(560,viewport-60));}root.style.setProperty('--dsh-chat-overlay-max-height',layout.maxHeight+'px');root.style.setProperty('--dsh-chat-overlay-bottom',layout.bottom+'px');root.style.setProperty('--dsh-chat-overlay-right',layout.right+'px');root.style.setProperty('--dsh-chat-overlay-width',layout.width+'px');}fit();window.addEventListener('resize',fit);return function(){window.removeEventListener('resize',fit);if(root){root.style.removeProperty('--dsh-chat-overlay-max-height');root.style.removeProperty('--dsh-chat-overlay-bottom');root.style.removeProperty('--dsh-chat-overlay-right');root.style.removeProperty('--dsh-chat-overlay-width');}};},[open[0],more[0],collab[0],knowledgeOpen[0],workflowOpen[0],taskDetailsOpen[0],menuOpen[0]]);
  // Opening any overlay must not leave the inline task assets underneath it.
  useEffect(function(){if(more[0]&&inlineAssetView[0])inlineAssetView[1](false);},[more[0],inlineAssetView[0]]);
  // 设置草稿按会话保留；关闭只隐藏，明确“放弃”才清空。
  useEffect(function(){draft[1](readDraftStorage('settings'));collabDraft[1](readDraftStorage('collaboration'));budget[1]({calls:'',modelCalls:'',tokens:'',minutes:'',unmetered:''});},[props.sessionId]);
  function run(endpoint,payload,opts){saving.current=true;request.current++;busy[1](true);error[1]('');notice[1]('');
    return api(endpoint,Object.assign({sessionId:props.sessionId},payload||{})).then(function(result){if(!result.ok)throw Error(chatError(result));
      if(endpoint==='task.continue')decisionNote[1]('');
      if(endpoint==='task.new-round')return api('task.choose',Object.assign({sessionId:props.sessionId},payload.preferences)).then(function(value){if(!value.ok)throw Error(chatError(value));return payload.preferences?.scenario==='project'?api('task.scenario',{sessionId:props.sessionId,scenario:'project'}):value;}).then(function(value){if(!value.ok)throw Error(chatError(value));notice[1]('已有记录已保留。请填写新的测试内容。');});
      notice[1](({'task.continue':'已确认，正在继续','task.cancel':'已停止本轮','chat.defaults':'已保存为新会话默认'}[endpoint])||'设置已保存');})
      .catch(function(failure){error[1](failure.message);if(opts&&opts.propagate)throw failure;})
      .finally(function(){saving.current=false;busy[1](false);return load();});
  }
  function isComposerSendTarget(target){
    var cursor=target;
    while(cursor&&cursor!==document){
      if(cursor.getAttribute&&cursor.getAttribute('aria-label')==='发送消息')return true;
      cursor=cursor.parentElement;
    }
    return false;
  }
  function scheduleSendRefresh(){
    sendBurst.current.forEach(function(timer){clearTimeout(timer);});
    sendBurst.current=[0,600,1400,2800,5200,10000].map(function(delay){
      return setTimeout(function(){if(mounted.current)load(0);},delay);
    });
  }
  useEffect(function(){
    if(typeof document==='undefined'||typeof document.addEventListener!=='function')return;
    function onClick(event){if(isComposerSendTarget(event.target))scheduleSendRefresh();}
    function onKey(event){if(event.key==='Enter'&&!event.shiftKey&&event.target&&event.target.closest&&event.target.closest('[data-composer-input]'))scheduleSendRefresh();}
    document.addEventListener('click',onClick,true);
    document.addEventListener('keydown',onKey,true);
    return function(){
      document.removeEventListener('click',onClick,true);
      document.removeEventListener('keydown',onKey,true);
      sendBurst.current.forEach(function(timer){clearTimeout(timer);});
      sendBurst.current=[];
    };
  },[props.sessionId]);
  // A blank composer still has a real session: keep its scene and editable
  // preferences, while withholding execution state from a reused host draft.
  var current=state[0];
  if(props.blank&&current)current={options:current.options,choice:current.choice,scene:current.scene,hostWorkerLimit:current.hostWorkerLimit,defaults:current.defaults,settingsView:current.settingsView};
  var policy=current&&current.policy, options=current&&current.options||{}, overview=current&&current.overview, mode=policy?policy.mode:current&&current.choice||'regular';
  var settingsSnapshot=current&&current.settingsView, settingsEffective=settingsSnapshot&&settingsSnapshot.effective||{};
  var scene=current&&current.scene;
  var activeScenario=scene?.sceneId||scene?.scene?.id||hostScene[0]||workScenario[0];
  if(activeScenario==='pentest')activeScenario='free';
  if(activeScenario==='project')activeScenario='cases';
  useEffect(function(){
    if(typeof window==='undefined'||typeof window.addEventListener!=='function')return;
    function onScene(event){var next=event&&event.detail&&event.detail.scene;if(next)hostScene[1](String(next));}
    window.addEventListener('saker-scene-selected',onScene);
    return function(){window.removeEventListener('saker-scene-selected',onScene);};
  },[]);
  var competitionMode=activeScenario==='competition', projectMode=activeScenario==='cases';
  // 宿主输入框仍使用通用「构建内容」文案。Saker 会话里换成任务语言，
  // 让第一次打开的人知道可以直接贴目标、请求、题目或附件；不替换宿主组件。
  useEffect(function(){
    if(typeof document==='undefined'||typeof MutationObserver!=='function')return;
    var text=competitionMode?'粘贴题目、附件或实例地址':projectMode?'描述测试要求，或添加案例文件':'直接说目标，或粘贴请求、代码和附件';
    var host=['描述你想要构建的内容, / 调用指令, @ 文件或对话','发消息或创建任务, / 调用指令, @ 文件或对话','Describe what you want to build, / commands, @ files or sessions','Message or run a task, / commands, @ files or sessions'];
    function apply(){var inputs=document.querySelectorAll('[data-composer-card] [data-composer-input]');Array.prototype.forEach.call(inputs,function(input){
      var current=input.getAttribute('data-placeholder')||'';if(host.indexOf(current)<0)return;
      input.setAttribute('data-placeholder',text);if(host.indexOf(input.getAttribute('aria-label')||'')>=0)input.setAttribute('aria-label',text);
    });var holders=document.querySelectorAll('[data-composer-card] [data-composer-placeholder]');Array.prototype.forEach.call(holders,function(holder){
      if(host.indexOf(String(holder.textContent||'').trim())>=0)holder.textContent=text;
    });}
    apply();
    var observer=new MutationObserver(apply);observer.observe(document.body,{subtree:true,childList:true,characterData:true});
    return function(){observer.disconnect();};
  },[competitionMode,projectMode]);
  var interaction=settingsEffective.interaction||(policy?policy.interaction:options.interaction)||'auto', workers=Number.isInteger(settingsEffective.workers)?settingsEffective.workers:(policy?policy.workerLimit:options.workers??2), reporting=chatReporting(settingsEffective.interaction?settingsEffective:(policy||options)), cooperation=cooperationValue(interaction);
  var explainValue=settingsEffective.explain===true||(policy?policy.explain===true:options.explain===true);
  var takeoverTerminal=!policy||policy.cancelled||policy.planComplete||['cancelled','plan_complete','queue_complete','first_verified_rce','first_verified_high','time_budget_exhausted','tool_budget_exhausted'].indexOf(current&&current.reason)>=0||String(current&&current.reason||'').startsWith('model_budget:')||(current&&current.stopped&&['turn_ended','paused:needs-user'].indexOf(current.reason)<0);
  var hostWorkerLimit=current&&Number.isInteger(current.hostWorkerLimit)?current.hostWorkerLimit:16;
  if(workers>hostWorkerLimit)workers=hostWorkerLimit;
  var workerOptions=[0,1,2,4,8,16].filter(function(value){return value<=hostWorkerLimit;});
  var labels={regular:'常规测试',nday:'Nday发现','0day':'0Day挖掘'};
  function changeScenario(next){
    if(!next||next===activeScenario)return Promise.resolve();
    var previous=activeScenario;
    workScenario[1](next);
    return run('scene.select',{scene:next,expectedRevision:scene?.sceneRevision,hasDraft:false},{propagate:true})
      .catch(function(failure){workScenario[1](previous);throw failure;});
  }
  function close(){open[1](false);if(openButton.current)openButton.current.focus();}
  // 关闭提示词模板/设置并把焦点还给对应的入口按钮（v6 第 10.5 节 UI09/UI12）。
  function closePanels(){
    if(panel[0]==='prompt'){ panel[1](null); if(openButton.current&&openButton.current.focus)openButton.current.focus(); }
    else if(panel[0]==='workflow'){ panel[1](null); if(workflowButton.current&&workflowButton.current.focus)workflowButton.current.focus(); }
    else if(panel[0]==='modules'){ panel[1](null); if(moduleButton.current&&moduleButton.current.focus)moduleButton.current.focus(); }
    else if(panel[0]==='knowledge'){ panel[1](null); if(moreButton.current&&moreButton.current.focus)moreButton.current.focus(); }
    else if(panel[0]==='collab'){ panel[1](null); if(collabButton.current&&collabButton.current.focus)collabButton.current.focus(); }
    else if(panel[0]==='details'||panel[0]==='menu'){ panel[1](null); if(moreButton.current&&moreButton.current.focus)moreButton.current.focus(); }
    else if(panel[0]==='settings'){ panel[1](null); if(moreButton.current&&moreButton.current.focus)moreButton.current.focus(); }
  }
  useEffect(function(){
    if(panel[0]!=='prompt'&&panel[0]!=='settings'&&panel[0]!=='collab'&&panel[0]!=='knowledge'&&panel[0]!=='workflow'&&panel[0]!=='details'&&panel[0]!=='menu'&&panel[0]!=='modules')return;
    if(typeof document==='undefined'||typeof document.addEventListener!=='function')return;
    function onDown(event){ var root=overlayRoot.current; if(root&&root.contains&&root.contains(event.target))return; closePanels(); }
    function onKey(event){ if(event.isComposing||event.keyCode===229)return; if(event.key==='Escape'){ event.stopPropagation(); closePanels(); } }
    document.addEventListener('mousedown',onDown);
    document.addEventListener('keydown',onKey);
    return function(){ document.removeEventListener('mousedown',onDown); document.removeEventListener('keydown',onKey); };
  },[panel[0]]);
  // 任务工作区里的「添加测试资料」通过桥接打开同一个面板；卸载时清掉，避免指向已销毁组件。
  useEffect(function(){
    materialsPanelBridge.open=function(){ setPanelOnly('materials',true); };
    curationSessionBridge.sessionId=props.sessionId;
    return function(){ materialsPanelBridge.open=null; };
  },[props.sessionId]);
  useEffect(function(){ attentionDismissed[1](false); },[props.sessionId]);
  var draftValues=draft[0]||{};
  var liveWorkflow=policy?(policy.flow?.kind||'single'):options.workflow||'single';
  var draftDirection=draftValues.direction===undefined?mode:draftValues.direction;
  var draftInteraction=draftValues.interaction===undefined?interaction:draftValues.interaction;
  var draftReporting=draftValues.reporting===undefined?reporting:draftValues.reporting;
  var draftExplain=draftValues.explain===undefined?explainValue:draftValues.explain;
  var draftWorkflow=draftValues.workflow===undefined?liveWorkflow:draftValues.workflow;
  var draftWorkersRaw=draftValues.workers===undefined?workerDraft[0]:String(draftValues.workers);
  var liveWorkerModel=settingsEffective.workerModel??(policy?(policy.workerModel??null):(options.workerModel??null));
  var liveReviewModel=settingsEffective.reviewModel??(policy?(policy.reviewModel??null):(options.reviewModel??null));
  var liveReportModel=settingsEffective.reportModel??(policy?(policy.reportModel??null):(options.reportModel??null));
  var draftWorkerModel=draftValues.workerModel===undefined?liveWorkerModel:draftValues.workerModel;
  var draftReviewModel=draftValues.reviewModel===undefined?liveReviewModel:draftValues.reviewModel;
  var draftReportModel=draftValues.reportModel===undefined?liveReportModel:draftValues.reportModel;
  // 动作限制（v6 第 4.3/5.5 节）：允许访问网站 / 不改动网站数据。未开始时读选择，已开始读策略。
  var liveAllowTargetNetwork=settingsEffective.allowTargetNetwork===undefined?(policy?(policy.allowTargetNetwork!==false):(options.allowTargetNetwork!==false)):settingsEffective.allowTargetNetwork!==false;
  var liveReadOnly=settingsEffective.readOnly===undefined?(policy?(policy.readOnly===true):(options.readOnly===true)):settingsEffective.readOnly===true;
  var liveExcludedPaths=Array.isArray(settingsEffective.excludedPaths)?settingsEffective.excludedPaths:(policy?(Array.isArray(policy.excludedPaths)?policy.excludedPaths:[]):(Array.isArray(options.excludedPaths)?options.excludedPaths:[]));
  function limitText(value){return value===undefined||value===null?'':String(value);}
  var liveRequestRate=limitText(settingsEffective.requestRatePerMinute!==undefined?settingsEffective.requestRatePerMinute:(policy?policy.requestRatePerMinute:options.requestRatePerMinute));
  var liveRequestConcurrency=limitText(settingsEffective.requestConcurrency!==undefined?settingsEffective.requestConcurrency:(policy?policy.requestConcurrency:options.requestConcurrency));
  var draftAllowTargetNetwork=draftValues.allowTargetNetwork===undefined?liveAllowTargetNetwork:draftValues.allowTargetNetwork;
  var draftReadOnly=draftValues.readOnly===undefined?liveReadOnly:draftValues.readOnly;
  var draftExcludedPaths=draftValues.excludedPaths===undefined?liveExcludedPaths.join('\n'):draftValues.excludedPaths;
  var liveAllowedOrigins=settingsEffective.allowedOrigins||(policy?policy.allowedOrigins:options.allowedOrigins)||[];
  var draftAllowedOrigins=draftValues.allowedOrigins===undefined?liveAllowedOrigins.join('\n'):draftValues.allowedOrigins;
  var draftRequestRate=draftValues.requestRatePerMinute===undefined?liveRequestRate:draftValues.requestRatePerMinute;
  var draftRequestConcurrency=draftValues.requestConcurrency===undefined?liveRequestConcurrency:draftValues.requestConcurrency;
  var liveBudget=settingsEffective.budget||policy?.budget||options.budget||{};
  function budgetValue(key){return liveBudget[key]===undefined||liveBudget[key]===null?'':String(liveBudget[key]);}
  var draftToolCalls=draftValues.toolCalls===undefined?budgetValue('toolCalls'):draftValues.toolCalls;
  var draftModelCalls=draftValues.modelCalls===undefined?budgetValue('modelCalls'):draftValues.modelCalls;
  var draftTokens=draftValues.tokens===undefined?budgetValue('tokens'):draftValues.tokens;
  var draftMinutes=draftValues.minutes===undefined?budgetValue('minutes'):draftValues.minutes;
  var draftUnmetered=draftValues.unmeteredToolCalls===undefined?budgetValue('unmeteredToolCalls'):draftValues.unmeteredToolCalls;
  var liveModelConcurrency=settingsEffective.modelConcurrency===undefined||settingsEffective.modelConcurrency===null?'':String(settingsEffective.modelConcurrency);
  var draftModelConcurrency=draftValues.modelConcurrency===undefined?liveModelConcurrency:draftValues.modelConcurrency;
  var liveTarget=settingsEffective.target||(policy?(policy.target||''):(options?.target||''));
  var draftTarget=draftValues.target===undefined?liveTarget:draftValues.target;
  var liveKnowledge=settingsEffective.knowledge||{enabled:false,strategy:'web-first'};
  var draftKnowledgeEnabled=draftValues.knowledgeEnabled===undefined?liveKnowledge.enabled===true:draftValues.knowledgeEnabled;
  var draftKnowledgeStrategy=draftValues.knowledgeStrategy===undefined?(liveKnowledge.strategy||'web-first'):draftValues.knowledgeStrategy;
  var effectiveAllowTargetNetwork=draftAllowTargetNetwork;
  // 函数式更新：同一次渲染里连续改两项（例如先关网站访问再勾只读）不会互相覆盖。
  function patchDraft(patch){error[1]('');draft[1](function(previous){var next=Object.assign({},previous||{},patch);writeDraftStorage('settings',next);return next;});}
  function draftChanges(){var d=draft[0]||{},out={};
    if(d.direction!==undefined&&d.direction!==mode)out.direction=d.direction;
    if(d.interaction!==undefined&&d.interaction!==interaction)out.interaction=d.interaction;
    if(d.reporting!==undefined&&d.reporting!==reporting)out.reporting=d.reporting;
    if(d.explain!==undefined&&d.explain!==explainValue)out.explain=d.explain;
    if(d.workers!==undefined&&String(d.workers).trim()!==String(workers))out.workers=d.workers;
    if(d.workerModel!==undefined&&JSON.stringify(d.workerModel)!==JSON.stringify(liveWorkerModel))out.workerModel=d.workerModel;
    if(d.reviewModel!==undefined&&JSON.stringify(d.reviewModel)!==JSON.stringify(liveReviewModel))out.reviewModel=d.reviewModel;
    if(d.reportModel!==undefined&&JSON.stringify(d.reportModel)!==JSON.stringify(liveReportModel))out.reportModel=d.reportModel;
    if(d.allowTargetNetwork!==undefined&&d.allowTargetNetwork!==liveAllowTargetNetwork)out.allowTargetNetwork=d.allowTargetNetwork;
    if(d.readOnly!==undefined&&d.readOnly!==liveReadOnly)out.readOnly=d.readOnly;
    if(d.excludedPaths!==undefined&&String(d.excludedPaths).trim()!==liveExcludedPaths.join('\n').trim())out.excludedPaths=d.excludedPaths;
    if(d.allowedOrigins!==undefined&&String(d.allowedOrigins).trim()!==liveAllowedOrigins.join('\n').trim())out.allowedOrigins=d.allowedOrigins;
    if(d.requestRatePerMinute!==undefined&&String(d.requestRatePerMinute).trim()!==liveRequestRate)out.requestRatePerMinute=d.requestRatePerMinute;
    if(d.requestConcurrency!==undefined&&String(d.requestConcurrency).trim()!==liveRequestConcurrency)out.requestConcurrency=d.requestConcurrency;
    if(d.modelConcurrency!==undefined&&String(d.modelConcurrency).trim()!==liveModelConcurrency)out.modelConcurrency=d.modelConcurrency;
    if(d.minutes!==undefined&&String(d.minutes).trim()!==budgetValue('minutes'))out.minutes=d.minutes;
    if(d.toolCalls!==undefined&&String(d.toolCalls).trim()!==budgetValue('toolCalls'))out.toolCalls=d.toolCalls;
    if(d.modelCalls!==undefined&&String(d.modelCalls).trim()!==budgetValue('modelCalls'))out.modelCalls=d.modelCalls;
    if(d.tokens!==undefined&&String(d.tokens).trim()!==budgetValue('tokens'))out.tokens=d.tokens;
    if(d.unmeteredToolCalls!==undefined&&String(d.unmeteredToolCalls).trim()!==budgetValue('unmeteredToolCalls'))out.unmeteredToolCalls=d.unmeteredToolCalls;
    if(d.knowledgeEnabled!==undefined&&d.knowledgeEnabled!==(liveKnowledge.enabled===true))out.knowledgeEnabled=d.knowledgeEnabled;
    if(d.knowledgeStrategy!==undefined&&d.knowledgeStrategy!==(liveKnowledge.strategy||'web-first'))out.knowledgeStrategy=d.knowledgeStrategy;
    if(d.workflow!==undefined&&d.workflow!==liveWorkflow)out.workflow=d.workflow;
    if(d.target!==undefined&&String(d.target).trim()!==String(liveTarget).trim())out.target=String(d.target).trim();
    return out;}
  function cancelDraft(){draft[1](null);writeDraftStorage('settings',null);error[1]('');more[1](false);}
  function settingsRequestId(prefix){return prefix+'-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,10);}
  function settingsExpected(){var view=settingsSnapshot||current&&current.settingsView;if(!view)return null;
    return {settingsRevision:view.settingsRevision,sceneRevision:view.sceneRevision,roundId:view.roundId};}
  function settingsPatchFromChanges(changes){
    var patch={};
    // 比赛题场景只接受通用设置；设置草稿是跨场景保留的，切到比赛题后
    // 旧草稿里的 target/allowTargetNetwork 等字段必须丢掉，否则保存会 400。
    var siteOnly=['target','direction','allowTargetNetwork','readOnly','requestRatePerMinute','requestConcurrency','allowedOrigins','excludedPaths'];
    var allowSite=activeScenario!=='competition';
    ['interaction','reporting','explain','workers','workerModel','reviewModel','reportModel','target','direction','allowTargetNetwork','readOnly','requestRatePerMinute','requestConcurrency','modelConcurrency'].forEach(function(key){
      if(changes[key]===undefined)return;
      if(!allowSite&&siteOnly.indexOf(key)>=0)return;
      patch[key]=changes[key];
    });
    if(allowSite&&changes.allowedOrigins!==undefined)patch.allowedOrigins=String(changes.allowedOrigins).split(/[\r\n,]+/).map(function(value){return value.trim();}).filter(Boolean);
    if(allowSite&&changes.excludedPaths!==undefined)patch.excludedPaths=String(changes.excludedPaths).split(/[\r\n,]+/).map(function(value){return value.trim();}).filter(Boolean);
    var budget={};
    ['minutes','toolCalls','modelCalls','tokens','unmeteredToolCalls'].forEach(function(key){if(changes[key]!==undefined)budget[key]=String(changes[key]).trim()===''?null:changes[key];});
    if(Object.keys(budget).length)patch.budget=budget;
    if(changes.knowledgeEnabled!==undefined||changes.knowledgeStrategy!==undefined){patch.knowledge={};if(changes.knowledgeEnabled!==undefined)patch.knowledge.enabled=changes.knowledgeEnabled;if(changes.knowledgeStrategy!==undefined)patch.knowledge.strategy=changes.knowledgeStrategy;}
    return patch;
  }
  function submitSettings(prefix,patch,onSuccess){
    var expected=settingsExpected();
    if(!expected){error[1]('设置快照尚未载入，请刷新后重试。');return Promise.resolve();}
    if(!patch||!Object.keys(patch).length){notice[1]('没有需要保存的改动');return Promise.resolve();}
    busy[1](true);saving.current=true;error[1]('');notice[1]('');
    return api('task.settings',{sessionId:props.sessionId,requestId:settingsRequestId(prefix),expected:expected,patch:patch}).then(function(result){
      if(!result.ok)throw Error(chatError(result));
      if(typeof onSuccess==='function')onSuccess(result);
      notice[1](result.summary||(result.noChange?'没有需要保存的改动':'设置已保存'));
      saving.current=false;busy[1](false);
      return load();
    }).catch(function(failure){error[1](failure.message);notice[1]('未保存：请修正后重试，当前草稿仍在。');})
      .finally(function(){saving.current=false;busy[1](false);});
  }
  function saveDraft(){
    var changes=draftChanges();
    var patch=settingsPatchFromChanges(changes);
    // 空目标不应把“保存”变成 HTTP 400：没有地址时只能离线分析。
    // 先按离线保存，用户之后填了地址再勾选“允许访问这些地址”。
    // 比赛题场景没有网站目标字段，不能把离线默认值 target/allowTargetNetwork
    // 补进 patch：服务端按 competition 字段白名单校验会直接 400。
    if(activeScenario!=='competition'&&!String((patch.target !== undefined ? patch.target : liveTarget) || '').trim()
      && patch.allowTargetNetwork !== false){
      patch.target='';
      patch.allowTargetNetwork=false;
    }
    if(!Object.keys(patch).length){notice[1]('没有需要保存的改动');draft[1](null);writeDraftStorage('settings',null);more[1](false);return Promise.resolve();}
    return submitSettings('settings',patch,function(result){
      draft[1](null);writeDraftStorage('settings',null);
      if(!result.noChange)budget[1]({calls:'',modelCalls:'',tokens:'',minutes:'',unmetered:''});
      if(!String((patch.target !== undefined ? patch.target : liveTarget) || '').trim())notice[1]('未填地址，已按离线分析保存。');
      more[1](false);
    });
  }
  function openCollaboration(){
    var next=!collab[0];collab[1](next);
    if(next){
      setCollabDraft({workers:String(workers),workerModel:liveWorkerModel,reviewModel:liveReviewModel});
      more[1](false);open[1](false);inlineAssetView[1](false);
    }
  }
  function openSettings(){
    var next=!more[0];more[1](next);
    if(next){
      try{var saved=window.localStorage.getItem('saker.settings.section.'+props.sessionId);if(saved==='scope'||saved==='knowledge'||saved==='limits')settingsSection[1](saved);}catch(_error){}
      open[1](false);collab[1](false);inlineAssetView[1](false);
    }
  }
  function openWorkflow(){
    var next=!workflowOpen[0];workflowOpen[1](next);
    if(next){more[1](false);open[1](false);collab[1](false);inlineAssetView[1](false);}
  }
  function chooseSettingsSection(name){settingsSection[1](name);try{window.localStorage.setItem('saker.settings.section.'+props.sessionId,name);}catch(_error){}}
  var settingsSearchIndex=[
    ['范围','scope'],['范围与授权','scope'],['允许访问网站','scope'],['只看不改','scope'],['只读模式','scope'],['排除路径','scope'],['请求速率','scope'],['请求并发','scope'],['账号','scope'],['测试方向','scope'],
    ['知识库','knowledge'],['知识库查询','knowledge'],['知识查询策略','knowledge'],['导入文档','knowledge'],
    ['节奏','limits'],['用量与汇报','limits'],['时间上限','limits'],['工具调用','limits'],['模型调用','limits'],['模型 token','limits'],['本地模型并发','limits'],['未计量通道','limits'],['什么时候问我','limits'],['什么时候汇报','limits'],['解释原理','limits']
  ];
  function setCollabDraft(value){collabDraft[1](value);writeDraftStorage('collaboration',value);}
  function collabValues(){var d=collabDraft[0]||{};return {workers:d.workers===undefined?String(workers):String(d.workers),
    workerModel:d.workerModel===undefined?liveWorkerModel:d.workerModel,
    reviewModel:d.reviewModel===undefined?liveReviewModel:d.reviewModel};}
  function saveCollaboration(){
    var values=collabValues(),patch={};
    if(String(values.workers)!==String(workers))patch.workers=values.workers;
    if(JSON.stringify(values.workerModel)!==JSON.stringify(liveWorkerModel))patch.workerModel=values.workerModel;
    if(JSON.stringify(values.reviewModel)!==JSON.stringify(liveReviewModel))patch.reviewModel=values.reviewModel;
    return submitSettings('collaboration',patch,function(){setCollabDraft(null);collab[1](false);});
  }
  function stopWorker(childId){
    busy[1](true);error[1]('');notice[1]('正在停止并行任务…');
    return api('task.cleanup',{sessionId:props.sessionId,childId:childId}).then(function(result){
      if(!result.ok)throw Error(chatError(result));
      notice[1]('并行任务已停止；主任务未受影响。');return load();
    }).catch(function(failure){error[1](failure.message);})
      .finally(function(){busy[1](false);});
  }
  function trapModalTab(event){
    if(event.key!=='Tab'||!event.currentTarget.querySelectorAll)return;
    var items=Array.from(event.currentTarget.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]')).filter(function(el){return el.getClientRects().length;});
    if(!items.length)return;var first=items[0],last=items[items.length-1];
    if((event.shiftKey&&document.activeElement===first)||(!event.shiftKey&&document.activeElement===last)){event.preventDefault();(event.shiftKey?last:first).focus();}
  }
  var compactWorkflow=current&&current.workflowStatus;
  var compactRun=compactWorkflow&&compactWorkflow.run;
  var compactSelected=compactWorkflow&&compactWorkflow.selected;
  var compactMethodText=compactRun
    ? '测试流程 · '+String((compactSelected&&compactSelected.title)||'当前流程')+(compactRun.state==='running'?' · '+Math.min(compactRun.total,compactRun.currentIndex+1)+'/'+compactRun.total:compactRun.state==='blocked'?' · 受阻':' · 已结束')
    : '测试流程';
  var compactStatusText=props.blank?'未开始':(policy?taskStatusLabel(current,policy):(current&&current.agentRunning?'运行中':'直接处理'));
  // 已取消/暂停接续/超过截止时间的轮次不会再发模型请求；直接继续输入只会得到
  // TASK_MODEL_BUDGET。把下一步写进常驻状态本身，避免用户以为“发给模型没反应”。
  var compactBlocked=!!(policy&&!props.blank&&(policy.cancelled===true||policy.continuationPaused===true
    ||(policy.budget&&policy.budget.deadline!==undefined&&policy.budget.deadline!==null&&Date.now()>=policy.budget.deadline)));
  if(compactBlocked)compactStatusText+=' · 新建测试';
  var compactRequestCount=overview&&overview.counts?Number(overview.counts.receipts||0):0;
  var compactActive=!!current&&!current.stopped&&!current.idle&&(current.agentRunning===true||Number(current.active||0)>0||['running','pausing'].includes(current.phase));
  function loadComponents(){
    var revision=++componentReq.current;
    api('component.status',{sessionId:props.sessionId}).then(function(value){
      if(revision!==componentReq.current)return;
      if(!value||value.ok===false)throw Error((value&&value.error)||'读取组件记录失败');
      componentInfo[1](value);componentError[1]('');
    }).catch(function(failure){if(revision===componentReq.current){componentInfo[1](null);componentError[1](failure.message||String(failure));}});
  }
  function loadRoles(){
    var revision=++roleReq.current;
    api('role.status',{sessionId:props.sessionId}).then(function(value){
      if(revision!==roleReq.current)return;
      if(!value||value.ok===false)throw Error((value&&value.error)||'读取工作与角色失败');
      roleInfo[1](value);roleError[1]('');
    }).catch(function(failure){if(revision===roleReq.current){roleInfo[1](null);roleError[1](failure.message||String(failure));}});
  }
  function loadModules(text,categoryValue,statusValue){
    var revision=++moduleReq.current;
    moduleError[1]('');
    scopeContextFor(props.sessionId).then(function(scope){
      return api('workbench.query',{kind:'modules.list',context:Object.assign({sessionId:props.sessionId},scope),filter:{text:String(text||''),categoryId:String(categoryValue||''),status:String(statusValue||'')},page:{limit:20}});
    })
      .then(function(response){
        if(revision!==moduleReq.current)return;
        if(!response||response.ok===false)throw Error(chatError(response));
        moduleList[1](response.data||{items:[],page:{}});
      })
      .catch(function(failure){if(revision===moduleReq.current)moduleError[1](failure.message||String(failure));});
  }
  function openModules(){
    var next=!moduleOpen[0];
    moduleOpen[1](next);
    if(next){more[1](false);open[1](false);collab[1](false);workflowOpen[1](false);if(!moduleList[0])loadModules(moduleText[0],moduleCategory[0],moduleStatus[0]);}
    else{
      if(moduleTimer.current)clearTimeout(moduleTimer.current);
      moduleTimer.current=null;
      if(moduleButton.current&&moduleButton.current.focus)moduleButton.current.focus();
    }
  }
  function chooseModule(item){
    if(moduleBusy[0])return;
    moduleBusy[1](true);moduleError[1]('');
    wbCommand(null,'module.prefer',{sessionId:props.sessionId},{
      moduleSnapshotRef:item.moduleRef||{id:item.id,version:item.version,digest:item.digest,ownerKey:item.ownerKey},
      operation:'auto',sessionRef:props.sessionId,
    }).then(function(result){moduleSelected[1](item);notice[1]('已选“'+item.title+'”，下一次工作会带上；发送仍由你决定。');moduleOpen[1](false);})
      .catch(function(failure){moduleError[1](failure.message||String(failure));})
      .finally(function(){moduleBusy[1](false);});
  }
  function openTaskDetails(){var next=!taskDetailsOpen[0];taskDetailsOpen[1](next);if(next){more[1](false);open[1](false);collab[1](false);load(0);loadComponents();loadRoles();}}
  function openCompactMenu(){menuOpen[1](!menuOpen[0]);if(!menuOpen[0]){more[1](false);open[1](false);collab[1](false);}}
  function openPromptPanel(){var next=!open[0];if(next){promptInsertion.current=props.inputActions&&typeof props.inputActions.captureInsertion==='function'?props.inputActions.captureInsertion():null;open[1](true);more[1](false);inlineAssetView[1](false);menuOpen[1](false);}else open[1](false);}
  function startNewRound(){return run('task.new-round',{preferences:{mode:policy&&policy.scenario==='project'?'regular':policy&&policy.mode||mode,scenario:policy&&policy.scenario||activeScenario,workflow:'single',interaction:interaction,reporting:reporting,workers:workers,allowTargetNetwork:liveAllowTargetNetwork!==false,readOnly:liveReadOnly===true}});}
  // 案例/按清单检查只能通过 project.start 生成项目运行和检查项；
  // 普通 send 会走 web-default，导致 project_checks 永远为空。
  function startProjectCase(){
    if(busy[0])return Promise.resolve();
    var question=starterDraftText().trim()||'按导入的测试要求逐项核对';
    var target=String(settingsEffective&&settingsEffective.target||liveTarget||'').trim();
    // 只按文档/代码核对时没有网址：显式关闭网站访问，避免服务端要求范围而 400。
    var allowNetwork=target?liveAllowTargetNetwork!==false:false;
    busy[1](true);error[1]('');
    var policy={workflow:'single',interaction:interaction,question:question,budget:{workers:workers},
      allowTargetNetwork:allowNetwork,readOnly:liveReadOnly===true};
    if(target)policy.target=target;
    return api('project.start',{sessionId:props.sessionId,policy:policy})
      .then(function(value){if(!value.ok)throw Error(value.error||'开始按清单检查失败');notice[1]('已开始按清单检查');return load();})
      .catch(function(failure){error[1](failure.message||String(failure));})
      .finally(function(){busy[1](false);});
  }
  return React.createElement('section',{ref:overlayRoot,'aria-label':'聊天任务设置',className:'dsh-chat-setup'},
    React.createElement('div',{className:'dsh-chat-compact-bar',role:'toolbar','aria-label':'Saker 快捷操作'},
      React.createElement('button',{ref:workflowButton,type:'button',className:'dsh-chat-method-chip'+(workflowOpen[0]?' is-active':''),'aria-expanded':workflowOpen[0],title:(compactWorkflow&&compactSelected&&compactSelected.title||'测试流程')+'：查看或编辑当前测试流程',onClick:openWorkflow},
        React.createElement(ChatIcon,{name:'flow'}),React.createElement('span',null,compactMethodText),React.createElement('small',null,'▾')),
      React.createElement('button',{ref:moduleButton,type:'button',className:'dsh-chat-toolbar-button saker-ui-btn'+(moduleOpen[0]?' is-active':''),'aria-expanded':moduleOpen[0],title:'选择下一次工作使用的测试模块；只保存偏好，不会自动发送。',onClick:openModules},
        React.createElement(ChatIcon,{name:'module'}),React.createElement('span',null,moduleSelected[0]?moduleSelected[0].title:'测试模块')),
      projectMode?React.createElement('button',{type:'button',className:'dsh-chat-toolbar-button saker-ui-btn',disabled:busy[0],title:'读取已导入的测试文档，逐条生成检查项并开始第一项；不会重新扫描无关内容。',onClick:startProjectCase},
        React.createElement(ChatIcon,{name:'flag'}),React.createElement('span',null,'开始检查')):null,
      React.createElement('button',{type:'button',className:'dsh-chat-status-chip'+(taskDetailsOpen[0]?' is-active':''),title:compactBlocked?'本轮已停止，后续消息不会发出。点这里打开详情，再点“新建测试”。':(current&&current.currentAction?current.currentAction:'打开任务详情'),onClick:openTaskDetails},
        React.createElement('span',{className:'dsh-chat-status-dot'}),React.createElement('span',{className:'dsh-chat-status-text'},compactStatusText),compactRequestCount?React.createElement('small',{title:'仅统计宿主落库的结构化 HTTP 回执；shell/CLI 内部请求可能未计入'},'回执 '+compactRequestCount):null),
      compactActive?React.createElement('button',{type:'button',className:'dsh-chat-stop-button',disabled:busy[0],onClick:function(){return run('task.cancel');}},'停止'):null,
      React.createElement('button',{ref:openButton,type:'button',className:open[0]?'dsh-chat-toolbar-button saker-ui-btn is-active':'dsh-chat-toolbar-button saker-ui-btn','aria-expanded':open[0],title:'从指令模板里选一条，补上信息后插入输入框；不会自动发送。',onClick:openPromptPanel},React.createElement(ChatIcon,{name:'prompt'}),'指令模板'),
      React.createElement('span',{className:'dsh-chat-compact-optional'},competitionMode?React.createElement(CompetitionEntry,{key:props.sessionId+'-competition-entry',sessionId:props.sessionId,open:panel[0]==='competition',onOpenChange:function(next){setPanelOnly('competition',next);}})
        :React.createElement(MaterialsEntry,{key:props.sessionId+'-materials-entry',sessionId:props.sessionId,scenario:activeScenario,open:panel[0]==='materials',onOpenChange:function(next){setPanelOnly('materials',next);}})),
      React.createElement('button',{ref:moreButton,type:'button',className:'dsh-chat-toolbar-button dsh-chat-more-button'+(menuOpen[0]?' is-active':''),'aria-expanded':menuOpen[0],title:'更多：任务详情、协作和设置。',onClick:openCompactMenu},React.createElement(ChatIcon,{name:'more'}),'更多')),
    menuOpen[0]?React.createElement('div',{className:'dsh-chat-more dsh-chat-compact-menu',role:'dialog','aria-modal':'false','aria-label':'更多操作',onKeyDown:trapModalTab},
      React.createElement('div',{className:'dsh-chat-panel-head saker-panel-head'},React.createElement('strong',null,'快速操作'),React.createElement('button',{type:'button','aria-label':'关闭快速操作',onClick:closePanels},'关闭')),
      React.createElement('div',{className:'dsh-chat-compact-menu-body'},
        React.createElement('button',{type:'button',onClick:openTaskDetails},'任务详情'),
        React.createElement('button',{type:'button',onClick:function(){menuOpen[1](false);openCollaboration();}},workers>0?'并行任务 · '+workers+' 个':'并行任务'),
        React.createElement('button',{type:'button',onClick:function(){menuOpen[1](false);openSettings();}},'设置'),
        React.createElement('button',{type:'button',onClick:function(){menuOpen[1](false);openWorkflow();}},'测试流程'),
        React.createElement('button',{type:'button',onClick:function(){menuOpen[1](false);openPromptPanel();}},'指令模板'),
        policy&&(current.stopped||current.idle)&&!policy.blocker&&!policy.awaitingConfirmation&&!policy.parentSession?React.createElement('button',{type:'button',onClick:startNewRound},'新建测试'):null))
    :taskDetailsOpen[0]?React.createElement('div',{className:'dsh-chat-more dsh-chat-task-detail',role:'dialog','aria-modal':'false','aria-label':'任务详情',onKeyDown:trapModalTab},
      React.createElement('div',{className:'dsh-chat-panel-head saker-panel-head'},React.createElement('div',{className:'saker-panel-headtext'},React.createElement('strong',null,'任务详情'),React.createElement('p',{className:'saker-panel-subtitle'},compactMethodText+' · '+compactStatusText)),React.createElement('button',{type:'button','aria-label':'关闭任务详情',onClick:closePanels},'关闭')),
      React.createElement('div',{className:'dsh-chat-task-detail-body'},
        policy?React.createElement(React.Fragment,null,
          overview?React.createElement('p',{className:'dsh-chat-task-detail-scope'},'范围：'+taskScopeDisplay(overview.scope,policy.target)):null,
          overview?React.createElement('p',{className:'dsh-chat-task-detail-stats'},'资产 '+(overview.counts&&overview.counts.assets||0)+' · 请求/回执 '+(overview.counts&&overview.counts.receipts||0)+' · 并行任务 '+(overview.counts&&overview.counts.runningWorkers||0)):null,
          React.createElement(ChatComponentSummary,{info:componentInfo[0],error:componentError[0]}),
          React.createElement(ChatRoleSummary,{info:roleInfo[0],error:roleError[0]}),
          React.createElement('div',{className:'dsh-chat-actions'},React.createElement('button',{type:'button',disabled:busy[0],onClick:function(){inlineAssetView[1](false);chooseSettingsSection('scope');setPanelOnly('settings',true);}}, '编辑范围'),React.createElement('button',{type:'button',disabled:busy[0],onClick:function(){inlineAssetView[1](!inlineAssetView[0]);}},'查看资产'),
            policy.manualTakeover&&policy.manualTakeover.active?React.createElement('button',{type:'button',disabled:busy[0]||current.agentRunning,onClick:function(){return run('task.takeover-resume',{expectedPolicyRev:policy.policyRev});}},'继续测试'):null,
            !(policy.manualTakeover&&policy.manualTakeover.active)&&current.browserTakeover&&current.browserTakeover.open&&!takeoverTerminal?React.createElement('button',{type:'button',disabled:busy[0],onClick:function(){return run('task.takeover',{expectedPolicyRev:policy.policyRev});}},'我来操作'):null,
            current.reason==='turn_ended'&&current.stopped?React.createElement('button',{type:'button',disabled:busy[0]||current.agentRunning||(current.active||0)>0,onClick:function(){return run('task.continue-current');}},'继续当前任务'):null),
          inlineAssetView[0]?React.createElement(TaskAssetView,{sessionId:props.sessionId}):null,
          overview&&overview.pendingChange?React.createElement('div',{className:'dsh-chat-task-overview-pending'},React.createElement('span',null,'待确认的任务变更：'+(overview.pendingChange.summary||overview.pendingChange.fields.join('、'))),React.createElement('button',{type:'button',disabled:busy[0],onClick:function(){return run('task.pending-apply');}},'确认变更'),React.createElement('button',{type:'button',disabled:busy[0],onClick:function(){return run('task.pending-cancel');}},'取消')):null,
          React.createElement(UsageRow,{key:props.sessionId+'-usage',sessionId:props.sessionId}),
          React.createElement('div',{className:'dsh-chat-actions'},React.createElement('button',{type:'button',disabled:busy[0]||current.agentRunning||(current.active||0)>0,onClick:startNewRound},'新建测试'))):
          React.createElement('p',null,'还没有开始任务。直接发送要求，或先选择题目的处理方式。'),
        error[0]?React.createElement('p',{role:'alert'},error[0]):null))
    :moduleOpen[0]?React.createElement('div',{className:'dsh-chat-more dsh-chat-compact-menu saker-module-picker',role:'dialog','aria-modal':'false','aria-label':'选择测试模块',onKeyDown:trapModalTab},
      React.createElement('div',{className:'dsh-chat-panel-head saker-panel-head'},React.createElement('div',{className:'saker-panel-headtext'},React.createElement('strong',null,'测试模块'),React.createElement('p',{className:'saker-panel-subtitle'},'选一个下一次测试要用的模块；也可以不选，直接执行。')),React.createElement('button',{type:'button','aria-label':'关闭模块选择',onClick:function(){moduleOpen[1](false);if(moduleButton.current&&moduleButton.current.focus)moduleButton.current.focus();}},'关闭')),
      React.createElement('div',{className:'saker-module-search-row'},
			React.createElement('input',{className:'saker-module-search',type:'search',placeholder:'搜索名称、别名、工具或用途','aria-label':'搜索测试模块',value:moduleText[0],onChange:function(event){
				var value=event.target.value;moduleText[1](value);
				if(moduleComposing.current)return;
				if(moduleTimer.current)clearTimeout(moduleTimer.current);
				moduleTimer.current=setTimeout(function(){loadModules(value,moduleCategory[0],moduleStatus[0]);},180);
			},onCompositionStart:function(){moduleComposing.current=true;},onCompositionEnd:function(event){
				moduleComposing.current=false;
				if(moduleTimer.current)clearTimeout(moduleTimer.current);
				moduleTimer.current=setTimeout(function(){loadModules(event.target.value,moduleCategory[0],moduleStatus[0]);},180);
			}}),
        React.createElement('select',{'aria-label':'按分类筛选模块',value:moduleCategory[0],onChange:function(event){moduleCategory[1](event.target.value);loadModules(moduleText[0],event.target.value,moduleStatus[0]);}},
          React.createElement('option',{value:''},'全部分类'),((moduleList[0]&&moduleList[0].taxonomy&&moduleList[0].taxonomy.primaryCategories)||[]).map(function(category){return React.createElement('option',{key:category.id,value:category.id},category.title);})),
        React.createElement('select',{'aria-label':'按可用状态筛选模块',value:moduleStatus[0],onChange:function(event){moduleStatus[1](event.target.value);loadModules(moduleText[0],moduleCategory[0],event.target.value);}},
          React.createElement('option',{value:''},'全部状态'),React.createElement('option',{value:'available'},'可用'),React.createElement('option',{value:'partial'},'部分可用'),React.createElement('option',{value:'blocked'},'缺少依赖'))),
      React.createElement('div',{className:'saker-module-rows'},
        moduleError[0]?React.createElement('p',{role:'alert'},moduleError[0]):null,
        moduleBusy[0]?React.createElement('p',{className:'saker-panel-hint'},'正在保存选择…'):null,
        !moduleList[0]&&!moduleError[0]?React.createElement('p',{className:'saker-panel-hint'},'正在读取模块…'):null,
        moduleList[0]&&moduleList[0].items&&moduleList[0].items.length?moduleList[0].items.map(function(item){
          return React.createElement('button',{key:item.id+'@'+item.version,type:'button',className:'saker-module-row',onClick:function(){chooseModule(item);}},
            React.createElement('span',{className:'saker-wb-row'},React.createElement('strong',{style:{flex:1}},item.title),React.createElement('span',{className:'saker-wb-chip '+(item.runtimeStatus==='available'?'ok':item.runtimeStatus==='blocked'?'bad':'warn')},item.statusLabel||'未评估')),
            React.createElement('small',null,item.userSummary||item.outputSummary||''),
            React.createElement('small',null,(item.familyLabel||item.family||'自定义')+' · v'+item.version+(item.tools&&item.tools.length?' · '+item.tools.slice(0,3).join(' / '):'')));
        }):null,
        moduleList[0]&&moduleList[0].items&&!moduleList[0].items.length?React.createElement('p',{className:'saker-panel-hint'},'没有匹配的模块。'):null),
      React.createElement('p',{className:'saker-panel-hint'},moduleSelected[0]?'当前已选：'+moduleSelected[0].title+'。下一次测试准入时会带上。':'选择只影响下一次测试；不会自动发送，也不会新增费用。'))
    :workflowOpen[0]?React.createElement(ChatWorkflowStudio,{sessionId:props.sessionId,open:true,onClose:function(){workflowOpen[1](false);if(workflowButton.current&&workflowButton.current.focus)workflowButton.current.focus();}})
    :knowledgeOpen[0]?React.createElement(ChatKnowledgeLibrary,{sessionId:props.sessionId,open:true,onClose:function(){knowledgeOpen[1](false);if(moreButton.current&&moreButton.current.focus)moreButton.current.focus();}})
    :collab[0]?React.createElement('div',{className:'dsh-chat-more dsh-chat-collab',role:'dialog','aria-modal':'false','aria-label':'协作设置',onKeyDown:trapModalTab},
      React.createElement('div',{className:'dsh-chat-panel-head saker-panel-head'},
        React.createElement('div',{className:'saker-panel-headtext'},React.createElement('strong',null,'并行执行'),React.createElement('p',{className:'saker-panel-subtitle'},'需要同时处理多个独立检查时再开启；默认按顺序执行。')),
        React.createElement('button',{type:'button','aria-label':'关闭协作设置',onClick:closePanels},'关闭')),
      React.createElement('div',{className:'dsh-chat-settings-body'},
        React.createElement('div',{className:'dsh-collab-switch-row'},
          React.createElement('label',{className:'dsh-chat-explain saker-check'},React.createElement('input',{type:'checkbox','aria-label':'启用按需协作',checked:Number(collabValues().workers)>0,disabled:busy[0]||!current,onChange:function(event){setCollabDraft(Object.assign({},collabValues(),{workers:event.target.checked?(Number(collabValues().workers)||1):0}));}}),'允许同时处理独立任务'),
          React.createElement('label',{className:'dsh-collab-limit'},'并行任务数',React.createElement('input',{'aria-label':'最多同时运行的并行任务',type:'number',min:0,max:hostWorkerLimit,step:1,value:collabValues().workers,disabled:busy[0]||!current||Number(collabValues().workers)===0,onChange:function(event){setCollabDraft(Object.assign({},collabValues(),{workers:event.target.value}));}}),React.createElement('span',null,'个'))),
        React.createElement('p',{className:'saker-panel-hint'},Number(collabValues().workers)>0?'最多 '+hostWorkerLimit+' 个。只有任务确实能并行时才会拆分。':'当前按顺序执行；大多数测试任务保持这样即可。'),
        Number(collabValues().workers)>0?React.createElement(WorkerModelSection,{key:props.sessionId+'-collab-model',sessionId:props.sessionId,values:collabValues(),disabled:busy[0]||!current,onChange:function(key,value){var next=collabValues();next[key]=value;setCollabDraft(next);}}):null,
        React.createElement('div',{className:'dsh-chat-collab-workers'},
          React.createElement('div',{className:'dsh-collab-workers-head'},React.createElement('strong',null,'并行任务'),React.createElement('span',null,String(current&&current.active||0)+' 个')),
          (current&&Array.isArray(current.workerRows)&&current.workerRows.length)?current.workerRows.map(function(row){return React.createElement('div',{className:'dsh-chat-collab-worker',key:row.childId},
            React.createElement('span',null,String(row.site||row.question||row.childId).slice(0,160)),
            React.createElement('button',{type:'button',disabled:busy[0],onClick:function(){return stopWorker(row.childId);}},'停止'));}):React.createElement('p',{className:'dsh-collab-empty'},'现在没有并行任务。')),
        error[0]?React.createElement('p',{role:'alert'},error[0]):null),
      React.createElement('div',{className:'dsh-chat-settings-actions'},React.createElement('button',{type:'button',disabled:busy[0],onClick:function(){setCollabDraft(null);collab[1](false);}},'取消'),
        React.createElement('button',{type:'button',disabled:busy[0]||!current,onClick:saveCollaboration},'保存')))
    :more[0]?React.createElement('div',{className:'dsh-chat-more dsh-task-settings',role:'dialog','aria-modal':'false','aria-label':'测试设置',onKeyDown:trapModalTab},
      React.createElement('div',{className:'dsh-chat-panel-head saker-panel-head'},
        React.createElement('div',{className:'saker-panel-headtext'},React.createElement('strong',null,'设置'),React.createElement('p',{className:'saker-panel-subtitle'},current?'都可以先跳过。只影响这个会话的下一轮。':'任务开始后，这里可以调整范围、资料和运行节奏。')),
        React.createElement('button',{type:'button','aria-label':'关闭测试设置',onClick:closePanels},'关闭')),
      !current?React.createElement('p',{className:'saker-panel-hint'},'还没开始安全任务。先在输入框写清目标和授权范围并发送；任务开始后，这里的设置会启用。'):null,
      React.createElement('div',{className:'dsh-settings-layout'},
        React.createElement('div',{className:'dsh-settings-side'},
          React.createElement('div',{className:'dsh-settings-nav',role:'tablist','aria-label':'设置分类'},
            [['scope','测试范围','网址、账号与授权边界'],['knowledge','知识库','是否查询已导入文档'],['limits','运行限制','时间、用量和汇报']].map(function(tab){return React.createElement('button',{key:tab[0],type:'button',role:'tab','aria-selected':settingsSection[0]===tab[0],className:settingsSection[0]===tab[0]?'is-active':'',onClick:function(){chooseSettingsSection(tab[0]);}},React.createElement('strong',null,tab[1]),React.createElement('small',null,tab[2]));})),
          React.createElement('div',{className:'dsh-settings-search'},
            React.createElement('input',{type:'search','aria-label':'搜索设置项',placeholder:'查找设置项',value:settingsQuery[0],onChange:function(event){settingsQuery[1](event.target.value);}}),
            settingsQuery[0].trim()?React.createElement('div',{className:'dsh-settings-search-popover',role:'listbox','aria-label':'设置搜索结果'},settingsSearchIndex.filter(function(row){return row[0].toLowerCase().indexOf(settingsQuery[0].trim().toLowerCase())>=0;}).slice(0,8).map(function(row){return React.createElement('button',{key:row[0],type:'button',onClick:function(){chooseSettingsSection(row[1]);settingsQuery[1]('');}},row[0],React.createElement('span',null,row[1]==='scope'?'测试范围':row[1]==='knowledge'?'知识库':'运行限制'));})):null)),
        React.createElement('div',{className:'dsh-settings-content dsh-chat-settings-body dsh-settings-body'},
        settingsSection[0]==='scope'?React.createElement('div',{className:'dsh-settings-section saker-panel-section'},
          React.createElement('h4',null,'测试范围'),
          React.createElement('p',{className:'saker-panel-section-desc'},competitionMode?'这是比赛题的环境设置；看题和读取附件不会自动调用模型。':'只填已授权的网址或域名。不知道怎么写可以留空，Saker 会先询问。'),
          competitionMode?React.createElement('div',null,
            React.createElement('p',null,'比赛题目的附件、实例地址和解题环境都在单独面板中。'),
            React.createElement('button',{type:'button',className:'saker-ui-btn',onClick:function(){setPanelOnly('competition',true);}},'打开题目与环境')):
          React.createElement(React.Fragment,null,
            React.createElement('label',{className:'dsh-chat-target'},React.createElement('span',null,'网址或域名'),
              React.createElement('textarea',{'aria-label':'测试范围（网址、域名、IP/CIDR，选填）',rows:3,value:draftTarget,disabled:busy[0]||!!(policy&&policy.parentSession),placeholder:projectMode?'每行一个入口，例如 app.example.com/login':'例如 https://example.com 或 app.example.com。每行一个。',onChange:function(event){patchDraft({target:event.target.value});}})),
            React.createElement(AccountsSection,{key:props.sessionId+'-accounts',sessionId:props.sessionId}),
            React.createElement('label',{className:'dsh-chat-explain saker-check'},React.createElement('input',{type:'checkbox','aria-label':'允许访问网站',checked:effectiveAllowTargetNetwork,disabled:busy[0]||!!(policy&&policy.parentSession),onChange:function(event){patchDraft({allowTargetNetwork:event.target.checked});}}),'允许测试访问这些地址'),
            !String(draftTarget||'').trim()?React.createElement('small',{className:'saker-panel-hint'},effectiveAllowTargetNetwork?'还没填地址。要访问网站请先填地址；只做离线分析请取消勾选。':'未填地址，本轮只做离线分析。'):null,
            React.createElement('label',{className:'dsh-chat-explain saker-check'},React.createElement('input',{type:'checkbox','aria-label':'仅发送 GET/HEAD',checked:draftReadOnly,disabled:busy[0]||!!(policy&&policy.parentSession),onChange:function(event){patchDraft({readOnly:event.target.checked});}}),'只看，不改数据（仅 GET/HEAD）'),
            React.createElement('small',{className:'saker-panel-hint'},'不会提交、修改或删除网站数据。'),
            React.createElement('details',{className:'dsh-settings-advanced'},React.createElement('summary',null,'更多选项：登录、限速、排除路径'),
              React.createElement('label',{className:'dsh-chat-exclude'},React.createElement('span',null,'排除的地址或路径（选填）'),React.createElement('textarea',{'aria-label':'排除的地址或路径',rows:2,value:draftExcludedPaths,disabled:busy[0]||!!(policy&&policy.parentSession),onChange:function(event){patchDraft({excludedPaths:event.target.value});}})),
              projectMode?React.createElement('label',{className:'dsh-chat-exclude'},React.createElement('span',null,'其他允许访问的网站（选填）'),React.createElement('textarea',{'aria-label':'其他允许访问的网站',rows:2,value:draftAllowedOrigins,disabled:busy[0]||!!(policy&&policy.parentSession),onChange:function(event){patchDraft({allowedOrigins:event.target.value});}})):null,
              React.createElement('div',{className:'dsh-limit-row'},
                React.createElement('label',null,'请求速率（每分钟）',React.createElement('input',{'aria-label':'扫描速率（每分钟请求数）',type:'number',min:1,max:600,value:draftRequestRate,placeholder:'未设置',disabled:busy[0]||!!(policy&&policy.parentSession),onChange:function(event){patchDraft({requestRatePerMinute:event.target.value});}})),
                React.createElement('label',null,'请求并发',React.createElement('input',{'aria-label':'并发上限（同时进行）',type:'number',min:1,max:16,value:draftRequestConcurrency,placeholder:'未设置',disabled:busy[0]||!!(policy&&policy.parentSession),onChange:function(event){patchDraft({requestConcurrency:event.target.value});}}))),
              !projectMode?React.createElement('label',{className:'dsh-task-field'},React.createElement('span',null,'测试重点'),React.createElement('select',{'aria-label':'测试方向',value:draftDirection,disabled:busy[0]||!!(policy&&policy.parentSession),onChange:function(event){patchDraft({direction:event.target.value});}},['regular','nday','0day'].map(function(value){return React.createElement('option',{key:value,value:value},labels[value]);}))):null,
              React.createElement('small',{className:'saker-panel-hint'},'这些选项可以留空；保存不会扩大到已有授权之外的地址。')),
            React.createElement('p',{className:'dsh-settings-note'},'只会记录本轮真实发起的请求。'))):
        settingsSection[0]==='knowledge'?React.createElement('div',{className:'dsh-settings-section saker-panel-section'},
          React.createElement('h4',null,'知识库'),
          React.createElement('p',{className:'saker-panel-section-desc'},'允许本轮查询已导入的文档；关闭时只读取本次附件。'),
          React.createElement('label',{className:'dsh-chat-explain saker-check'},React.createElement('input',{type:'checkbox','aria-label':'启用知识查询',checked:draftKnowledgeEnabled,disabled:busy[0]||!current,onChange:function(event){patchDraft({knowledgeEnabled:event.target.checked});}}),'可以查询我导入的文档'),
          React.createElement('p',{className:'dsh-chat-setting-hint'},(liveKnowledge.enabled?'当前已开启。':'当前已关闭；关闭时只读取本次上传的附件。')),
          React.createElement('label',{className:'dsh-task-field'},React.createElement('span',null,'先查资料还是先联网'),
            React.createElement('select',{'aria-label':'知识查询策略',value:draftKnowledgeStrategy,disabled:busy[0]||!current||!draftKnowledgeEnabled,onChange:function(event){patchDraft({knowledgeStrategy:event.target.value});}},
              React.createElement('option',{value:'web-first'},'先联网，再查资料'),
              React.createElement('option',{value:'knowledge-first'},'先查资料，再联网'),
              React.createElement('option',{value:'knowledge-only'},'只查资料'))),
          React.createElement('div',{className:'saker-panel-actions'},React.createElement('button',{type:'button',className:'saker-ui-btn',onClick:function(){setPanelOnly('knowledge',true);}},'管理知识库')),
          React.createElement('small',{className:'saker-panel-hint'},'管理页只在本机浏览、搜索和导入，不会自动查询资料。')):null,
        settingsSection[0]==='limits'?React.createElement('div',{className:'dsh-settings-section saker-panel-section'},
          React.createElement('h4',null,'运行限制'),
          React.createElement('p',{className:'saker-panel-section-desc'},'不想管就留空。达到限制会自动停下。'),
          React.createElement('div',{className:'saker-grid2'},
            React.createElement('label',{className:'saker-field'},React.createElement('span',null,'最多运行（分钟）'),React.createElement('input',{'aria-label':'最多运行多久（分钟）',type:'number',min:1,max:10080,value:draftMinutes,placeholder:'不限制',disabled:busy[0]||!current,onChange:function(event){setBudget({minutes:event.target.value});patchDraft({minutes:event.target.value});}}),React.createElement('small',null,'已用 '+(liveBudget.used&&liveBudget.used.minutes||0)+' 分钟')),
            React.createElement('label',{className:'saker-field'},React.createElement('span',null,'最多调用工具（次）'),React.createElement('input',{'aria-label':'工具调用上限（次）',type:'number',min:1,max:10000,value:draftToolCalls,placeholder:'不限制',disabled:busy[0]||!current,onChange:function(event){setBudget({calls:event.target.value});patchDraft({toolCalls:event.target.value});}}),React.createElement('small',null,'已用 '+(liveBudget.used&&liveBudget.used.toolCalls||0)+' 次')),
            React.createElement('label',{className:'saker-field'},React.createElement('span',null,'最多请求模型（次）'),React.createElement('input',{'aria-label':'模型调用上限（次）',type:'number',min:1,max:10000,value:draftModelCalls,placeholder:'不限制',disabled:busy[0]||!current,onChange:function(event){setBudget({modelCalls:event.target.value});patchDraft({modelCalls:event.target.value});}}),React.createElement('small',null,'已用 '+(liveBudget.used&&liveBudget.used.modelCalls||0)+' 次')),
            React.createElement('label',{className:'saker-field'},React.createElement('span',null,'最多使用 token'),React.createElement('input',{'aria-label':'模型用量上限（token）',type:'number',min:1,max:1000000000000,value:draftTokens,placeholder:'不限制',disabled:busy[0]||!current,onChange:function(event){setBudget({tokens:event.target.value});patchDraft({tokens:event.target.value});}}),React.createElement('small',null,'已用 '+(liveBudget.usageUnknown?'未知':String(liveBudget.used&&liveBudget.used.tokens||0))))),
          React.createElement('small',{className:'saker-panel-hint'},'时间从本轮第一次执行开始算；清空不会重新计时。'),
          React.createElement('details',{className:'dsh-settings-advanced'},React.createElement('summary',null,'高级选项'),
            React.createElement('label',{className:'dsh-task-field'},React.createElement('span',null,'本地模型并发'),React.createElement('input',{'aria-label':'本地模型并发',type:'number',min:1,max:16,value:draftModelConcurrency,placeholder:'默认 1',disabled:busy[0]||!current,onChange:function(event){patchDraft({modelConcurrency:event.target.value});}})),
            competitionMode?null:React.createElement('label',{className:'dsh-task-field'},React.createElement('span',null,'未计量通道上限'),React.createElement('input',{'aria-label':'未计量扫描额度（次工具调用）',type:'number',min:0,max:1000,value:draftUnmetered,placeholder:'不增加限制',disabled:busy[0]||!current,onChange:function(event){setBudget({unmetered:event.target.value});patchDraft({unmeteredToolCalls:event.target.value});}})),
            current&&current.modelBudget?React.createElement('small',null,'模型请求：已计费 '+current.modelBudget.chargedCalls+' 次 · 已知 token '+current.modelBudget.knownTokens+' · 处理中预留 '+current.modelBudget.heldTokens):null,
            React.createElement('small',null,'工具调用和模型调用分开统计；未知用量不会显示为零。'))):null,
        settingsSection[0]==='limits'?React.createElement('details',{className:'dsh-settings-advanced'},React.createElement('summary',null,'什么时候问我、什么时候汇报'),
          React.createElement('label',{className:'dsh-task-field'},React.createElement('span',null,'什么时候问我'),React.createElement('select',{'aria-label':'聊天协作方式',value:draftInteraction,disabled:busy[0]||!!(policy&&policy.parentSession),onChange:function(event){patchDraft({interaction:event.target.value});}},['auto','confirm-data-change','confirm-step'].map(function(value){return React.createElement('option',{key:value,value:value},CHAT_COOPERATION[value]);}))),
          React.createElement('fieldset',{className:'dsh-chat-reporting'},React.createElement('legend',null,'什么时候汇报'),['end','notable','step'].map(function(value){return React.createElement('label',{key:value},React.createElement('input',{type:'radio',name:'settings-reporting-'+props.sessionId,'aria-label':CHAT_REPORTING[value],value:value,checked:draftReporting===value,disabled:busy[0]||!!(policy&&policy.parentSession),onChange:function(){return patchDraft({reporting:value});}}),CHAT_REPORTING[value]);})),
          React.createElement('label',{className:'dsh-chat-explain'},React.createElement('input',{type:'checkbox','aria-label':'解释测试原理',checked:draftExplain,disabled:busy[0]||!!(policy&&policy.parentSession),onChange:function(event){return patchDraft({explain:event.target.checked});}}),'解释为什么这样测')):null,
        projectMode?null:React.createElement('div',{className:'saker-panel-actions'},React.createElement('button',{type:'button',className:'saker-ui-btn',disabled:busy[0]||!current||!!(policy&&policy.parentSession),onClick:function(){return run('chat.defaults',{interaction:interaction,reporting:reporting,workers:workers,explain:explainValue,workerModel:draftWorkerModel,reviewModel:draftReviewModel,reportModel:draftReportModel});}},'保存为以后新会话的默认值'),React.createElement('small',{className:'saker-panel-hint'},'不含目标、账号和已用量。')),
        error[0]?React.createElement('p',{role:'alert'},error[0]):null)),
      React.createElement('div',{className:'dsh-chat-settings-actions'},
        React.createElement('button',{type:'button',disabled:busy[0],onClick:cancelDraft},'取消'),
        React.createElement('button',{type:'button',disabled:busy[0]||!current,onClick:saveDraft,title:'保存当前会话的设置'},'保存设置'),
        Object.keys(draftChanges()).length?React.createElement('small',{role:'status'},'尚未保存'):null)):null,
    policy&&policy.awaitingConfirmation?React.createElement('div',{className:'dsh-chat-checkpoint','aria-label':'聊天阶段确认'},React.createElement('strong',null,cooperation==='confirm-step'?'需要你确认这一步':'需要你确认下一步'),React.createElement('p',null,policy.awaitingConfirmation.note),
            current.reason!=='interaction_confirmation_required'?React.createElement('p',null,({'time_budget_exhausted':'原时间上限已到，不能继续本轮。','tool_budget_exhausted':'原操作额度已用完，不能继续本轮。','turn_ended':'本轮已结束；直接发送新的要求即可继续同一任务。'}[current.reason])||'本轮还有未处理的停止原因，请在任务详情查看。'):null,
      cooperation==='confirm-step'?React.createElement('label',{className:'dsh-chat-full-prompt'},'补充你的思路（可选）',React.createElement('textarea',{'aria-label':'补充你的思路',rows:2,maxLength:2000,value:decisionNote[0],placeholder:'补充观察事实、业务疑问或下一步方向',onChange:function(event){decisionNote[1](event.target.value);}})):null,
      React.createElement('button',{type:'button',disabled:busy[0]||current.agentRunning||current.reason!=='interaction_confirmation_required',onClick:function(){return run('task.continue',{note:decisionNote[0]});}},current.agentRunning?'正在收尾，请稍候':cooperation==='confirm-step'?'按当前思路继续':'确认并继续'),
      React.createElement('button',{type:'button',disabled:busy[0],onClick:function(){return run('task.cancel');}},'停止本轮'),React.createElement('small',null,'改变协作或汇报设置不会解除当前等待；原截止时间仍有效。')):null,
    !props.blank&&current&&activeScenario==='cases'&&taskDetailsOpen[0]?React.createElement(ProjectChatStatus,{sessionId:props.sessionId,status:current}):null,
    // 需要用户处理时只显示单条具体事项（v6 第 5.2 节）：说清哪一项受影响，并给出重新绑定/继续两条路。
    current&&Array.isArray(current.attention)&&current.attention.length&&!attentionDismissed[0]?React.createElement('div',{className:'dsh-chat-attention',role:'alert'},
      React.createElement('span',null,current.attention[0].message),
      React.createElement('button',{type:'button',onClick:function(){more[1](true);}},'重新绑定账号'),
      React.createElement('button',{type:'button',onClick:function(){attentionDismissed[1](true);}},'继续其他检查')):null,
    current?React.createElement(ChatPromptEditor,{key:props.sessionId+'-'+mode,sessionId:props.sessionId,mode:mode,scene:activeScenario,open:open[0],onClose:close,onInserted:function(message){notice[1](message);},inputActions:props.inputActions,insertion:promptInsertion}):null,
    error[0]||readError[0]?React.createElement('div',{role:'alert',className:'dsh-chat-error'},React.createElement('span',null,error[0]||readError[0]),
      readError[0]?React.createElement('button',{type:'button',onClick:function(){readError[1]('');load(0);}},'重试'):null):notice[0]?React.createElement('span',{role:'status'},notice[0]):null);
}
function ChatSetupEntry(props) {
  var live=props.session;
  var blank=props.blank===true||live?.blank===true;
  var sessionId=String(props.sessionId||live?.id||'');
  var preset=props.useProjection('agentPreset')||live?.agentPreset||live?.projectionValues?.agentPreset;
  return preset==='pentest'||preset==='ctf-solver'?React.createElement(ChatSetup,{key:sessionId+'-'+String(!!blank),sessionId:sessionId,session:live,blank:blank,inputActions:props.inputActions,preset:preset}):null;
}
function installCurationStyles() {
  var style=document.createElement('style');style.id='saker-curation-style';
  style.textContent=[
    '.dsh-curation-trigger{font:inherit;font-size:var(--dsh-content-font-size-secondary,0.93em);border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));border-radius:6px;padding:4px 8px;background:transparent;color:inherit;cursor:pointer}',
    '.dsh-curation-overlay{position:fixed;inset:48px 0 0;z-index:700;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;background:rgba(20,28,44,.28);-webkit-app-region:no-drag}',
    '.dsh-curation-dialog{display:flex;flex-direction:column;width:min(900px,calc(100vw - 32px));max-height:min(760px,calc(100vh - 64px));background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,inherit);border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));border-radius:12px;box-shadow:0 20px 70px rgba(0,0,0,.24);overflow:hidden;font-size:var(--dsh-content-font-size,1em);line-height:1.5}',
    '.dsh-curation-head{display:flex;align-items:center;justify-content:space-between;flex:0 0 52px;padding:0 16px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16))}',
    '.dsh-curation-head button,.dsh-curation-actions button{font:inherit;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));border-radius:6px;padding:5px 11px;background:transparent;color:inherit;cursor:pointer}',
    '.dsh-curation-body{flex:1;min-height:0;overflow:auto;padding:16px;overscroll-behavior:contain}',
    '.dsh-curation-meta{display:flex;flex-wrap:wrap;gap:4px 16px;margin:8px 0;color:var(--dsw-alias-label-secondary,inherit);font-size:var(--dsh-content-font-size-secondary,0.93em)}',
    '.dsh-curation-source{max-height:220px;overflow:auto;padding:8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));border-radius:6px;background:var(--dsw-alias-bg-l1,rgba(128,128,128,.04));white-space:pre-wrap;overflow-wrap:anywhere}',
    '.dsh-curation-progress{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px;border:1px solid var(--dsw-alias-state-business-primary,#4b74d9);border-radius:8px;background:var(--dsw-alias-state-business-primary-alpha,rgba(75,116,217,.08))}',
    '.dsh-curation-form{display:grid;gap:8px;margin-top:12px}.dsh-curation-form label{display:grid;gap:4px;color:var(--dsw-alias-label-secondary,inherit);font-size:var(--dsh-content-font-size-secondary,0.93em)}',
    '.dsh-curation-form input,.dsh-curation-form textarea,.dsh-curation-form select{width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));border-radius:6px;background:var(--dsw-alias-bg-base,transparent);color:inherit;font:inherit}',
    '.dsh-curation-form textarea{resize:vertical;line-height:1.5}.dsh-curation-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}',
    '.dsh-curation-confirm{display:flex!important;grid-template-columns:none!important;align-items:center;gap:8px!important}.dsh-curation-confirm input{width:auto}',
    '.dsh-curation-actions{position:sticky;bottom:-16px;z-index:3;display:flex;flex-wrap:wrap;gap:8px;margin:4px -16px -16px;padding:12px 16px;background:var(--dsw-alias-bg-base,#fff);border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16))}.dsh-curation-actions .is-primary{background:var(--dsw-alias-state-business-primary,#4b74d9);border-color:transparent;color:#fff}',
    '.dsh-curation-foot{flex:0 0 auto;padding:8px 16px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));color:var(--dsw-alias-label-secondary,inherit)}',
    '@media(max-width:760px){.dsh-curation-overlay{padding:8px}.dsh-curation-dialog{width:calc(100vw - 16px)}.dsh-curation-grid{grid-template-columns:1fr}.dsh-curation-body{padding:12px}.dsh-curation-head,.dsh-curation-foot{padding-inline:12px}}'
  ].join('');
  var previous=document.getElementById(style.id);if(previous)previous.remove();
  (document.head||document.documentElement).appendChild(style);
  return function(){style.remove();};
}
function installChatSetupStyles() {
  var style=document.createElement('style');style.id='saker-chat-setup-style';
  style.textContent=".dsh-chat-setup{box-sizing:border-box;width:min(var(--dsh-composer-card-max-width,100%),calc(100% - 2 * var(--dsh-composer-side-clearance,16px)));margin-inline:auto;container-type:inline-size;min-width:0;text-align:left;font-size:var(--dsh-content-font-size,1em);line-height:1.5;color:var(--dsw-alias-label-primary,inherit)}.dsh-chat-settings-row,.dsh-chat-actions,.dsh-chat-panel-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.dsh-chat-settings-row{padding:0;gap:8px;min-height:32px}.dsh-chat-chip{box-sizing:border-box;display:inline-flex;align-items:center;gap:4px;height:32px;padding:0 9px;border-radius:6px;background:var(--dsw-alias-bg-l1,rgba(128,128,128,.055));color:var(--dsw-alias-label-secondary,inherit);border:1px solid transparent}.dsh-chat-chip:hover{background:var(--dsw-alias-bg-hover,rgba(128,128,128,.10))}.dsh-chat-toolbar-spacer{flex:1;min-width:4px}.dsh-chat-setup button,.dsh-chat-setup select,.dsh-chat-setup input,.dsh-chat-setup textarea{font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));background:var(--dsw-alias-bg-base,transparent);border-radius:8px;padding:6px 9px;max-width:100%;box-sizing:border-box}.dsh-chat-setup .dsh-chat-chip select{border:0;padding:3px 0;background:transparent;max-width:150px;cursor:pointer}.dsh-chat-chip svg{flex-shrink:0;opacity:.7}.dsh-chat-setup button{cursor:pointer}.dsh-chat-setup .dsh-chat-toolbar-button{height:32px;display:inline-flex;align-items:center;gap:4px;border-color:transparent;background:transparent;padding:6px 8px}.dsh-chat-setup button:hover{background:var(--dsw-alias-bg-hover,rgba(128,128,128,.08))}.dsh-chat-setup .is-active{color:var(--dsw-alias-state-business-primary,#4b74d9);background:var(--dsw-alias-state-business-primary-alpha,rgba(75,116,217,.08))}.dsh-chat-setup button:disabled,.dsh-chat-setup select:disabled,.dsh-chat-setup input:disabled{opacity:.5;cursor:default}.dsh-chat-setup :focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4b74d9);outline-offset:2px}.dsh-chat-setup p{margin:8px 0}.dsh-chat-setting-hint,.dsh-chat-setup small{color:var(--dsw-alias-label-secondary,inherit);font-size:var(--dsh-content-font-size,1em);opacity:.8}.dsh-chat-setup small{display:block;margin:4px 0}.dsh-chat-more,.dsh-chat-checkpoint,.dsh-chat-prompt{padding:16px 16px;margin:4px 0 8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));border-radius:12px;background:var(--dsw-alias-bg-base,transparent)}.dsh-chat-prompt,.dsh-chat-more{max-height:min(390px,44vh);overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}.dsh-chat-prompt[hidden]{display:none}.dsh-chat-panel-head{justify-content:space-between;margin-bottom:8px}.dsh-chat-panel-head strong{font-size:var(--dsh-content-font-size,1em);font-weight:600}.dsh-chat-panel-head button{border-color:transparent;padding:3px 7px;color:var(--dsw-alias-label-secondary,inherit)}.dsh-chat-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(180px,100%),1fr));gap:8px;margin:12px 0}.dsh-chat-fields input{display:block;width:100%;margin-top:4px}.dsh-chat-full-prompt{display:block;margin:12px 0}.dsh-chat-full-prompt textarea{display:block;width:100%;resize:vertical;min-height:105px;max-height:230px;margin-top:4px;line-height:1.5}.dsh-chat-actions{margin-top:8px}.dsh-chat-actions button:first-child{background:var(--dsw-alias-state-business-primary,#4b74d9);color:#fff;border-color:transparent}.dsh-chat-checkpoint{border-left:3px solid var(--dsw-alias-state-business-primary,#4b74d9)}.dsh-chat-checkpoint button{margin-right:8px}.dsh-chat-reporting{border:0;padding:0;margin:12px 0}.dsh-chat-reporting legend{font-weight:500;margin-bottom:4px}.dsh-chat-reporting label{display:inline-flex;align-items:center;gap:4px;margin-right:16px}.dsh-chat-reporting input{padding:0;accent-color:var(--dsw-alias-state-business-primary,#4b74d9)}.dsh-chat-worker-custom{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:12px 0}.dsh-chat-worker-custom input{width:66px}.dsh-chat-setup [role=alert]{color:var(--dsw-alias-state-error-primary,#c84040)}.dsh-chat-setup *{animation:none!important;transition:none!important}@media(max-width:760px){.dsh-chat-toolbar-spacer{display:none}.dsh-chat-settings-row{gap:4px}.dsh-chat-more,.dsh-chat-prompt{padding:12px}.dsh-chat-fields{grid-template-columns:1fr 1fr}}@media(max-width:500px){.dsh-chat-fields{grid-template-columns:1fr}}.dsh-chat-task-status{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:8px;font-size:var(--dsh-content-font-size,1em);color:var(--dsw-alias-label-secondary,inherit)}.dsh-chat-task-status button{padding:2px 7px}.dsh-task-workspace{width:100%;max-width:var(--dsh-composer-card-max-width,1120px);margin-inline:auto;padding:16px 24px 24px;box-sizing:border-box;font-size:var(--dsh-content-font-size,1em)}.dsh-task-nav{display:flex;align-items:center;flex-wrap:wrap;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l1,#ddd);padding-bottom:12px;margin-bottom:16px}.dsh-task-nav button{font:inherit;cursor:pointer;background:transparent;color:var(--dsw-alias-label-secondary,inherit);border:0;border-radius:6px;padding:7px 16px}.dsh-task-nav button[aria-current=page]{background:var(--dsw-alias-bg-hover,rgba(75,116,217,.08));color:var(--dsw-alias-state-business-primary,#4b74d9);font-weight:600}.dsh-task-workspace :focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4b74d9);outline-offset:2px}.dsh-task-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}.dsh-task-panel h3{margin:0;font-size:16px}.dsh-task-panel p{margin:12px 0;line-height:1.5}.dsh-task-panel small{color:var(--dsw-alias-label-secondary,inherit)}.dsh-task-panel details,.dsh-task-fold{margin:12px 0;padding:12px 12px;border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:8px}.dsh-task-workspace summary{cursor:pointer;line-height:1.5}.dsh-task-scope{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:12px}.dsh-task-scope select,.dsh-task-panel input,.dsh-task-panel select{font:inherit;color:inherit;background:var(--dsw-alias-bg-base,transparent);border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:6px;padding:6px 8px;box-sizing:border-box;max-width:100%}@container(max-width:540px){.dsh-chat-toolbar-spacer{display:none}.dsh-chat-settings-row{gap:4px}.dsh-chat-chip{padding-inline:6px}}@media(max-width:760px){.dsh-task-workspace{padding:12px}}";
  style.textContent += '.dsh-chat-setup .dsh-rtr-btn.is-primary{background:var(--dsw-alias-state-business-primary,#4b74d9);color:#fff;border-color:transparent}.dsh-chat-setup .dsh-rtr-btn.is-primary:hover{filter:brightness(.95)}';
  style.textContent += '.dsh-chat-entry-group{display:flex;align-items:center;gap:4px;max-width:100%;margin-left:auto;flex-wrap:wrap}.dsh-chat-entry-group>button{white-space:nowrap}@media(max-width:720px){.dsh-chat-entry-group{margin-left:0;flex-basis:100%}}';
  style.textContent += '.dsh-chat-result{margin:8px 0;padding:9px 11px;max-height:240px;overflow:auto;background:var(--dsw-alias-bg-layer-2,#f4f5f7);border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 Consolas,"Microsoft YaHei",monospace}.dsh-chat-session-row{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;margin:4px 0;text-align:left}.dsh-chat-session-row strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-chat-session-row span{color:var(--dsw-alias-label-secondary,inherit);font-size:var(--dsh-content-font-size-secondary,0.93em)}';
  // v6 第 5.7 节令牌层：小控件 6px、抽屉 12px。上面旧组件样式里小控件散成 8px，
  // 这里按方案与设计稿统一覆盖；选择器特异性更高，不靠声明顺序碰运气。
  style.textContent += '.dsh-chat-setup .dsh-chat-chip,.dsh-chat-setup button,.dsh-chat-setup select,.dsh-chat-setup input,.dsh-chat-setup textarea{border-radius:6px}'
    + '.dsh-chat-setup .dsh-prompt-drawer,.dsh-chat-setup .dsh-chat-more{border-radius:12px}';
  // v6 第 5.7 节动效：覆盖层 120ms 淡入/展开；减少动态效果时关闭。
  // 上面 `.dsh-chat-setup *` 把动画一刀切关掉了，这里只给覆盖层开口子，其余仍无动画。
  style.textContent += '.dsh-chat-setup .dsh-chat-more,.dsh-chat-setup .dsh-chat-prompt,.dsh-chat-setup .dsh-prompt-drawer{animation:dsh-overlay-in 120ms ease-out!important}'
    + '@keyframes dsh-overlay-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}'
    + '@media(prefers-reduced-motion:reduce){.dsh-chat-setup .dsh-chat-more,.dsh-chat-setup .dsh-chat-prompt,.dsh-chat-setup .dsh-prompt-drawer{animation:none!important}}';
  style.textContent += '.dsh-chat-setup{position:relative}.dsh-chat-more,.dsh-chat-prompt{z-index:650;box-sizing:border-box;margin:0;max-height:var(--dsh-chat-overlay-max-height,min(70vh,520px));overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;background:var(--dsw-alias-bg-base,#fff);box-shadow:0 10px 32px rgba(0,0,0,.18)}.dsh-chat-more{position:fixed;right:var(--dsh-chat-overlay-right,16px);bottom:var(--dsh-chat-overlay-bottom,100px);width:min(520px,var(--dsh-chat-overlay-width,100%),calc(100vw - 24px))}.dsh-chat-prompt{position:absolute;bottom:calc(100% + 6px);left:0;right:0}'
    + '.saker-module-picker{display:flex;flex-direction:column;overflow:hidden}'
    + '.saker-module-picker>.dsh-chat-panel-head,.saker-module-picker>.saker-module-search-row,.saker-module-picker>.saker-panel-hint{flex:0 0 auto}'
    + '.saker-module-picker>.saker-module-rows{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}'
    + '.saker-module-search-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px}'
    + '.saker-module-search-row .saker-module-search{flex:1 1 100%;min-width:0}'
    + '.saker-module-search-row select{flex:1 1 110px;min-width:0;max-width:none}';
  // 设计稿（saker-ui-v6.html）：设置类抽屉 .drawer.narrow 宽 440px、右对齐；窄窗用 min(440px,100%) 防止溢出遮挡输入框。
  style.textContent += '.dsh-chat-more{max-width:calc(100vw - 24px)}';
  // 弹层高度同时受"可用高度"和"视口高度"限制：短视口/高缩放下不会把标题和关闭按钮顶出屏幕。
  style.textContent += '.dsh-chat-more{display:flex;flex-direction:column;overflow:hidden}.dsh-chat-more>.dsh-chat-panel-head{z-index:3;margin:-16px -16px 8px;padding:12px 16px;background:var(--dsw-alias-bg-base,#fff);border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16))}.dsh-chat-settings-body{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}.dsh-chat-settings-actions{display:flex;align-items:center;gap:8px;margin:12px -16px -16px;position:relative;z-index:2;background:var(--dsw-alias-bg-base,#fff);padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16))}.dsh-chat-settings-actions button:last-of-type{background:var(--dsw-alias-state-business-primary,#4b74d9);color:#fff;border-color:transparent}.dsh-chat-settings-actions small{color:var(--dsw-alias-label-secondary,inherit)}';
  style.textContent += '.dsh-chat-more:has(.dsh-settings-nav){width:min(980px,var(--dsh-chat-overlay-width,100%),calc(100vw - 32px));max-width:calc(100vw - 32px)}'
    + '.dsh-chat-collab{width:min(640px,var(--dsh-chat-overlay-width,100%),calc(100vw - 24px));max-height:min(560px,calc(100vh - 60px))}'
    + '.dsh-chat-collab .dsh-chat-settings-body{display:flex;flex-direction:column;gap:8px;padding-bottom:4px}'
    + '.dsh-chat-collab .dsh-chat-settings-body>p{margin:0}.dsh-chat-collab .dsh-worker-model{margin:4px 0}'
    + '.dsh-knowledge-library{width:min(900px,var(--dsh-chat-overlay-width,100%),calc(100vw - 32px))}'
    + '.dsh-settings-nav{display:flex;flex:0 0 auto;gap:8px;padding:0 0 8px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));margin-bottom:8px}'
    + '.dsh-settings-nav button{flex:1 1 0;min-width:0;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary,inherit);padding:7px 10px;font:inherit;cursor:pointer;border-radius:6px;white-space:nowrap}'
    + '.dsh-settings-nav button.is-active{background:var(--dsw-alias-bg-hover,rgba(75,116,217,.10));color:var(--dsw-alias-state-business-primary,#4b74d9);border-color:var(--dsw-alias-border-l1,rgba(128,128,128,.16))}'
    + '.dsh-settings-search{position:relative;flex:0 0 auto;margin-bottom:8px}.dsh-settings-search>input{width:100%;box-sizing:border-box;padding:4px 8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));border-radius:6px;background:transparent;color:inherit;font:inherit}'
    + '.dsh-settings-search-popover{position:absolute;top:100%;left:0;right:0;z-index:2;display:grid;gap:4px;margin-top:4px;padding:8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));border-radius:6px;background:var(--dsw-alias-bg-base,#fff);box-shadow:0 8px 24px rgba(0,0,0,.16)}'
    + '.dsh-settings-search-popover button{display:flex;justify-content:space-between;gap:12px;border:0;border-radius:6px;padding:4px 8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}.dsh-settings-search-popover button:hover{background:var(--dsw-alias-bg-hover,rgba(128,128,128,.08))}.dsh-settings-search-popover span{color:var(--dsw-alias-label-secondary,inherit);font-size:var(--dsh-content-font-size-secondary,0.93em)}'
    + '.dsh-settings-section{display:flex;flex-direction:column;gap:4px;min-height:0}'
    + '.dsh-settings-section h4{margin:4px 0 8px;font-size:var(--dsh-content-font-size,1em)}'
    + '.dsh-settings-advanced{margin:8px 0;padding:8px 12px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));border-radius:8px}'
    + '.dsh-settings-advanced summary{cursor:pointer;line-height:1.5}'
    + '.dsh-settings-legacy{display:none!important}'
    + '.dsh-chat-collab-workers{display:grid;gap:8px;margin:12px 0;padding:8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));border-radius:8px}'
    + '.dsh-chat-collab-worker{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.12))}.dsh-chat-collab-worker span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.dsh-collab-switch-row{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:2px 0 4px}.dsh-collab-switch-row .saker-check{flex:1 1 250px}'
    + '.dsh-collab-limit{display:inline-flex;align-items:center;gap:8px;font-size:var(--dsh-content-font-size-secondary,0.93em);color:var(--dsw-alias-label-secondary,inherit);white-space:nowrap}.dsh-collab-limit input{width:64px;height:32px;padding:0 8px}'
    + '.dsh-chat-collab .dsh-worker-model{margin:12px 0 4px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.14));border-radius:8px;background:var(--dsw-alias-bg-l1,rgba(128,128,128,.03))}'
    + '.dsh-chat-collab .dsh-worker-model summary{font-size:var(--dsh-content-font-size-secondary,0.93em);color:var(--dsw-alias-label-secondary,inherit)}'
    + '.dsh-chat-collab-workers{margin:4px 0 0;padding:8px 12px;max-height:168px;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}.dsh-collab-workers-head{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:var(--dsh-content-font-size-secondary,0.93em)}.dsh-collab-workers-head span{color:var(--dsw-alias-label-secondary,inherit)}.dsh-collab-empty{margin:4px 0 0!important;font-size:var(--dsh-content-font-size-secondary,0.93em);color:var(--dsw-alias-label-secondary,inherit)}'
    + '.dsh-knowledge-results,.dsh-knowledge-read{display:grid;gap:8px;margin:8px 0;padding:8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));border-radius:8px}.dsh-knowledge-results>button{display:grid;gap:4px;text-align:left;border:0;background:transparent;color:inherit;padding:8px;border-radius:6px;cursor:pointer}.dsh-knowledge-results>button:hover{background:var(--dsw-alias-bg-hover,rgba(128,128,128,.08))}.dsh-knowledge-results small,.dsh-knowledge-row small{display:block;color:var(--dsw-alias-label-secondary,inherit)}'
    + '.dsh-knowledge-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.12))}.dsh-knowledge-row>div{min-width:0;overflow-wrap:anywhere}'
    + '@media(max-width:760px){.dsh-settings-nav{overflow-x:auto;justify-content:flex-start}.dsh-settings-nav button{flex:0 0 auto}.dsh-chat-more:has(.dsh-settings-nav){width:calc(100vw - 24px)}}';
  style.textContent += '.dsh-chat-task-overview{margin-top:8px;padding:8px 0;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));color:var(--dsw-alias-label-secondary,inherit)}.dsh-chat-task-overview p{margin:0 0 8px;overflow-wrap:anywhere}.dsh-chat-task-overview-actions,.dsh-chat-task-overview-pending{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.dsh-chat-task-overview-pending{margin-top:8px;color:var(--dsw-alias-label-primary,inherit)}';
  style.textContent += '.dsh-chat-target{display:block;margin:12px 0}.dsh-chat-target span{display:block;font-size:var(--dsh-content-font-size-secondary,0.93em);color:var(--dsw-alias-label-secondary,inherit);margin-bottom:4px}.dsh-chat-target input,.dsh-chat-target textarea{display:block;width:100%;min-width:0}.dsh-chat-target textarea{min-height:78px;resize:vertical;line-height:1.5}';
  style.textContent += '.dsh-chat-setup .dsh-chat-field,.dsh-task-workspace .dsh-chat-field{display:flex;flex-direction:column;align-items:stretch;gap:4px;min-width:0;margin:12px 0}.dsh-chat-setup .dsh-chat-field>span,.dsh-task-workspace .dsh-chat-field>span{display:block;margin:0;font-size:var(--dsh-content-font-size-secondary,0.93em);line-height:1.5;color:var(--dsw-alias-label-secondary,inherit)}.dsh-chat-setup .dsh-chat-field>input,.dsh-chat-setup .dsh-chat-field>textarea,.dsh-chat-setup .dsh-chat-field>select,.dsh-task-workspace .dsh-chat-field>input,.dsh-task-workspace .dsh-chat-field>textarea,.dsh-task-workspace .dsh-chat-field>select{display:block;width:100%;min-width:0;margin:0;box-sizing:border-box}.dsh-chat-setup .dsh-chat-field>textarea,.dsh-task-workspace .dsh-chat-field>textarea{min-height:76px;resize:vertical;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}.dsh-chat-more>.dsh-competition-body{flex:1 1 auto;min-height:0;min-width:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}.dsh-task-workspace>.dsh-competition-body{min-width:0}';
  style.textContent += '.dsh-worker-model{display:block;margin:12px 0}.dsh-worker-model summary{cursor:pointer;line-height:1.5}.dsh-worker-model label{display:inline-flex;align-items:center;gap:8px;margin:8px 0}.dsh-worker-model p{margin:8px 0}';
  style.textContent += '.dsh-action-limits{display:block;margin:12px 0}.dsh-action-limits summary{cursor:pointer;line-height:1.5}.dsh-action-limits label{display:inline-flex;align-items:center;gap:8px;margin:8px 0}.dsh-action-limits p{margin:8px 0}';
  style.textContent += '.dsh-chat-exclude{display:block;margin:12px 0}.dsh-chat-exclude span{display:block;font-size:var(--dsh-content-font-size-secondary,0.93em);color:var(--dsw-alias-label-secondary,inherit);margin-bottom:4px}.dsh-chat-exclude textarea{display:block;width:100%;min-height:56px;resize:vertical;font:inherit;line-height:1.5}';
  style.textContent += '.dsh-limit-row{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:8px 0}.dsh-limit-row label{display:grid;gap:4px;font-size:var(--dsh-content-font-size-secondary,0.93em);color:var(--dsw-alias-label-secondary,inherit)}.dsh-limit-row input{font:inherit;color:inherit;width:100%;box-sizing:border-box}@media(max-width:520px){.dsh-limit-row{grid-template-columns:1fr}}';
  style.textContent += '.dsh-chat-compact-bar{display:flex;align-items:center;gap:4px;min-height:40px;max-height:48px;padding:4px 0;box-sizing:border-box;white-space:nowrap;min-width:0}'
    + '.dsh-chat-method-chip,.dsh-chat-status-chip,.dsh-chat-stop-button{display:inline-flex;align-items:center;gap:4px;height:32px;min-width:0;padding:0 8px;border:1px solid transparent;border-radius:6px;background:transparent;color:inherit;font:inherit;cursor:pointer}'
    // 这里的 max-width 必须带 .dsh-chat-setup 前缀：通用 `.dsh-chat-setup button{max-width:100%}`
    // 的特异性高于单类选择器，否则长方法名/长状态会把宽度上限冲掉，挤压相邻入口。
    + '.dsh-chat-setup .dsh-chat-method-chip{max-width:min(280px,34vw);background:var(--dsw-alias-bg-l1,rgba(128,128,128,.055))}.dsh-chat-setup .dsh-chat-method-chip>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}'
    + '.dsh-chat-method-chip>small,.dsh-chat-status-chip>small{margin:0;display:inline;font-size:var(--dsh-content-font-size-secondary,0.93em);opacity:.75;color:var(--dsw-alias-label-secondary,inherit)}'
    + '.dsh-chat-method-chip.is-active,.dsh-chat-status-chip.is-active{color:var(--dsw-alias-state-business-primary,#4b74d9);background:var(--dsw-alias-state-business-primary-alpha,rgba(75,116,217,.08))}'
    + '.dsh-chat-setup .dsh-chat-status-chip{max-width:220px;color:var(--dsw-alias-label-secondary,inherit)}.dsh-chat-setup .dsh-chat-status-chip>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.dsh-chat-setup .dsh-chat-status-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.dsh-chat-status-dot{display:inline-block;flex:0 0 6px;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#4b74d9)}'
    + '.dsh-chat-stop-button{color:var(--dsw-alias-state-error-primary,#c84040);border-color:var(--dsw-alias-state-error-primary,#c84040)}'
    + '.dsh-chat-compact-bar>.dsh-chat-toolbar-button{flex:0 0 auto}.dsh-chat-compact-bar>.dsh-chat-compact-optional{display:inline-flex;flex:0 0 auto}.dsh-chat-compact-bar>.dsh-chat-more-button{margin-left:auto}'
    + '.dsh-chat-compact-menu{width:min(260px,calc(100vw - 24px))}.dsh-chat-compact-menu-body{display:grid;gap:4px;padding:4px 0}.dsh-chat-compact-menu-body button{justify-content:flex-start;width:100%;text-align:left;border-color:transparent;background:transparent;height:36px;padding:0 10px}'
    + '.dsh-chat-task-detail{width:min(680px,calc(100vw - 32px))}.dsh-chat-task-detail-body{display:flex;flex:1 1 auto;flex-direction:column;gap:8px;min-height:0;overflow:auto;overscroll-behavior:contain;padding:4px 0 8px}'
    + '.dsh-chat-task-detail-scope{margin:0;overflow-wrap:anywhere;line-height:1.5}.dsh-chat-task-detail-stats{margin:0;color:var(--dsw-alias-label-secondary,inherit)}'
    + '.dsh-chat-component-summary,.dsh-chat-role-summary{display:flex;flex:0 0 auto;flex-direction:column;gap:8px;min-height:0}.dsh-chat-component-details{flex:0 0 auto;min-height:0}.dsh-chat-component-details summary{cursor:pointer;line-height:1.5}.dsh-chat-component-list{display:flex;flex-direction:column;gap:4px;max-height:220px;overflow:auto;margin-top:8px;padding-left:8px}.dsh-chat-component-list p{margin:0;line-height:1.5;overflow-wrap:anywhere}'
    + '@media(max-width:800px){.dsh-chat-compact-bar{flex-wrap:wrap;max-height:72px;white-space:normal;row-gap:4px}.dsh-chat-setup .dsh-chat-method-chip{max-width:min(240px,52vw)}.dsh-chat-setup .dsh-chat-status-chip{max-width:180px}}'
    + '@media(max-width:520px){.dsh-chat-compact-bar{max-height:72px}.dsh-chat-compact-bar>.dsh-chat-compact-optional{display:none}.dsh-chat-setup .dsh-chat-method-chip{max-width:calc(100% - 180px)}.dsh-chat-setup .dsh-chat-status-chip{max-width:150px}}';
  style.textContent += '.dsh-accounts{display:block;margin:12px 0}.dsh-accounts summary{cursor:pointer;line-height:1.5}.dsh-account-row{display:flex;align-items:center;gap:8px;margin:8px 0}.dsh-account-add{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}.dsh-account-add input,.dsh-account-add select{flex:1 1 140px;min-width:0}';
  // 独立的大编辑窗口，避开 Desktop 标题栏；列表、正文和底栏分别分配空间。
  style.textContent += '.dsh-prompt-overlay{position:fixed;inset:48px 0 0;z-index:660;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box;background:rgba(20,28,44,.24);-webkit-app-region:no-drag}.dsh-chat-setup .dsh-prompt-drawer{position:relative;box-sizing:border-box;width:min(1100px,100%);height:min(760px,100%);max-height:100%;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));border-radius:12px;box-shadow:0 20px 70px rgba(0,0,0,.22);overflow:hidden;font-size:var(--dsh-content-font-size,1em);line-height:1.5;color:var(--dsw-alias-label-primary,inherit)}'
    + '.dsh-chat-setup{container-type:normal}'
    + '.dsh-chat-attention{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:8px;padding:8px 12px;border:1px solid var(--dsw-alias-state-warning-primary,#b45309);border-radius:8px;background:var(--dsw-alias-bg-l1,rgba(180,83,9,.07));font-size:var(--dsh-content-font-size-secondary,0.93em)}'
    + '.dsh-chat-attention button{padding:2px 8px}'
    + '.dsh-chat-action{max-width:min(320px,50vw);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.dsh-execution-scope{margin:8px 0;padding:8px 12px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));border-radius:8px}'
    + '.dsh-execution-scope ul{margin:8px 0 0;padding-left:16px;font-size:var(--dsh-content-font-size-secondary,0.93em);line-height:1.5;color:var(--dsw-alias-label-secondary,inherit)}'
    + '.dsh-settings-note{margin:12px 0 0;padding:8px 12px;border-radius:6px;background:var(--dsw-alias-bg-l1,rgba(128,128,128,.055));font-size:var(--dsh-content-font-size-secondary,0.93em);line-height:1.5;color:var(--dsw-alias-label-secondary,inherit)}'
    + '.dsh-chat-more.saker-workflow-panel{width:min(1040px,calc(100vw - 32px))!important;max-height:var(--dsh-chat-overlay-max-height,760px)}.saker-workflow-panel{box-sizing:border-box;padding:16px;overflow:auto}'
    + '.saker-workflow-layout{display:grid;grid-template-columns:minmax(210px,260px) minmax(0,1fr);gap:16px;min-height:0}'
    + '.saker-workflow-list{display:flex;flex-direction:column;gap:8px;min-width:0;padding-right:12px;border-right:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16))}'
    + '.saker-workflow-list>input{font:inherit;height:34px;box-sizing:border-box;padding:8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));background:transparent;color:inherit}'
    + '.saker-workflow-list-head{display:flex;align-items:center;justify-content:space-between;gap:8px}.saker-workflow-list-head strong{font-size:var(--dsh-content-font-size,1em)}.saker-workflow-list-head button{padding:4px 8px}'
    + '.saker-workflow-item{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;width:100%;padding:12px;border:1px solid transparent;border-radius:6px;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}.saker-workflow-item:hover{background:var(--dsw-alias-bg-hover,rgba(128,128,128,.08))}.saker-workflow-item.is-active{border-color:var(--dsw-alias-state-business-primary,#4b74d9);background:var(--dsw-alias-state-business-primary-alpha,rgba(75,116,217,.08))}.saker-workflow-item>span{display:flex;flex-direction:column;gap:4px;min-width:0}.saker-workflow-item strong{font-size:var(--dsh-content-font-size,1em);font-weight:500}.saker-workflow-item small{font-size:var(--dsh-content-font-size-secondary,0.93em);color:var(--dsw-alias-label-secondary,inherit)}.saker-workflow-item em{flex:none;font-style:normal;font-size:var(--dsh-content-font-size-secondary,0.93em);color:var(--dsw-alias-state-business-primary,#4b74d9)}'
    + '.saker-workflow-main{min-width:0;display:flex;flex-direction:column;gap:12px}.saker-workflow-stage-wrap,.saker-workflow-preview{display:flex;flex-direction:column;gap:12px;min-width:0}.saker-workflow-stage-head,.saker-workflow-editor-head,.saker-workflow-preview-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.saker-workflow-stage-head strong,.saker-workflow-editor-head strong,.saker-workflow-preview-head strong{font-size:16px}.saker-workflow-stage-head p,.saker-workflow-editor-head small,.saker-workflow-preview-head p{margin:4px 0 0;color:var(--dsw-alias-label-secondary,inherit);line-height:1.5;font-size:var(--dsh-content-font-size-secondary,0.93em)}'
    + '.saker-stage-rail{display:flex;gap:12px;overflow:auto;padding:4px 0 8px}.saker-stage{position:relative;display:flex;flex-direction:column;align-items:flex-start;gap:4px;flex:0 0 142px;min-height:82px;padding:12px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));border-radius:6px;background:var(--dsw-alias-bg-base,transparent);color:inherit;font:inherit;text-align:left;cursor:pointer}.saker-stage:not(:last-child):after{content:"→";position:absolute;right:-12px;top:36px;color:var(--dsw-alias-label-tertiary,inherit);font-size:var(--dsh-content-font-size,1em)}.saker-stage.is-active{border-color:var(--dsw-alias-state-business-primary,#4b74d9);background:var(--dsw-alias-state-business-primary-alpha,rgba(75,116,217,.08))}.saker-stage>span{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:var(--dsw-alias-bg-hover,rgba(128,128,128,.12));font-size:var(--dsh-content-font-size-secondary,0.93em)}.saker-stage strong{font-size:var(--dsh-content-font-size-secondary,0.93em);font-weight:500;line-height:1.5}.saker-stage small{font-size:var(--dsh-content-font-size-secondary,0.93em);color:var(--dsw-alias-label-secondary,inherit);line-height:1.5;overflow-wrap:anywhere}'
    + '.saker-workflow-preview-head .is-primary,.saker-workflow-actions .is-primary,.saker-workflow-save .is-primary{background:var(--dsw-alias-state-business-primary,#4b74d9);color:#fff;border-color:transparent}'
    + '.saker-workflow-step{padding:12px 0;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.14))}.saker-workflow-step summary{cursor:pointer;font-weight:500}.saker-workflow-step p{margin:8px 0 4px;line-height:1.5}.saker-workflow-step small{color:var(--dsw-alias-label-secondary,inherit)}'
    + '.saker-workflow-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.saker-workflow-actions button,.saker-workflow-save button{height:32px;padding:0 8px}'
    + '.saker-workflow-editor-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(180px,240px);gap:16px;min-height:0}.saker-workflow-fields{display:flex;flex-direction:column;gap:8px;min-width:0}.saker-workflow-node-edit{display:flex;flex-direction:column;gap:8px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.14))}.saker-workflow-node-actions{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}.saker-workflow-node-actions span{display:flex;gap:4px}.saker-workflow-node-actions button{height:28px;padding:0 8px}'
    + '.saker-workflow-note{padding:12px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));border-radius:6px;background:var(--dsw-alias-bg-l1,rgba(128,128,128,.04));line-height:1.5}.saker-workflow-note p{margin:8px 0 0;color:var(--dsw-alias-label-secondary,inherit);font-size:var(--dsh-content-font-size-secondary,0.93em)}.saker-workflow-save{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16))}'
    + '@media(max-width:760px){.saker-workflow-layout,.saker-workflow-editor-grid{grid-template-columns:1fr}.saker-workflow-list{padding-right:0;padding-bottom:8px;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16))}.saker-stage{flex-basis:120px}.saker-workflow-preview-head,.saker-workflow-stage-head,.saker-workflow-editor-head{flex-direction:column}.saker-workflow-save{justify-content:flex-start}}'
    + '.dsh-chat-error{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0;color:var(--dsw-alias-state-error-primary,#c84040)}.dsh-chat-error button{font:inherit;padding:2px 8px}'
    + '@media(max-width:540px){.dsh-chat-toolbar-spacer{display:none}.dsh-chat-settings-row{gap:4px}.dsh-chat-chip{padding-inline:6px}}'
    + '.dsh-prompt-head{display:flex;flex:0 0 52px;align-items:center;justify-content:space-between;padding:0 16px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16))}.dsh-prompt-head button{font:inherit;padding:4px 12px;border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:6px;background:transparent;color:inherit;cursor:pointer}'
    + '.dsh-prompt-head strong{font-size:var(--dsh-content-font-size,1em)}'
    + '.dsh-prompt-hint{flex-shrink:0;margin:0;padding:8px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));color:var(--dsw-alias-label-secondary,inherit);font-size:var(--dsh-content-font-size-secondary,0.93em)}'
    + '.dsh-prompt-body{display:flex;flex:1;min-height:0}'
    + '.dsh-prompt-list{width:240px;flex-shrink:0;border-right:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));display:flex;flex-direction:column;min-height:0}'
    + '.dsh-prompt-list input[type=search]{margin:12px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));border-radius:6px;background:transparent;color:inherit;font:inherit}'
    + '.dsh-prompt-io{display:flex;gap:8px;padding:0 12px 8px}'
    + '.dsh-prompt-io button{flex:1;height:28px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));border-radius:6px;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:var(--dsh-content-font-size,1em)}'
    + '.dsh-prompt-more{margin:8px 12px;height:28px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));border-radius:6px;background:transparent;color:inherit;cursor:pointer;font:inherit;font-size:var(--dsh-content-font-size-secondary,0.93em)}'
    + '.dsh-prompt-scopes{display:flex;gap:4px;padding:0 12px 8px}'
    + '.dsh-prompt-scopes button{flex:1;border:0;border-radius:6px;padding:4px 0;background:transparent;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;font:inherit}'
    + '.dsh-prompt-scopes button.is-active{background:var(--dsw-alias-bg-hover,rgba(75,116,217,.10));color:var(--dsw-alias-state-business-primary,#4b74d9)}'
    + '.dsh-prompt-items{list-style:none;margin:0;padding:0 8px 8px;overflow:auto;flex:1}'
    + '.dsh-prompt-items button{display:flex;flex-direction:column;width:100%;text-align:left;border:0;border-radius:6px;padding:6px 8px;background:transparent;color:inherit;cursor:pointer;font:inherit}'
    + '.dsh-prompt-items button:hover{background:var(--dsw-alias-bg-hover,rgba(128,128,128,.08))}'
    + '.dsh-prompt-items button.is-active{background:var(--dsw-alias-state-business-primary-alpha,rgba(75,116,217,.12));color:var(--dsw-alias-state-business-primary,#4b74d9)}'
    + '.dsh-prompt-item-title{font-weight:500}'
    + '.dsh-prompt-item-hint{font-size:var(--dsh-content-font-size-secondary,0.93em);opacity:.7}'
    + '.dsh-prompt-empty{padding:8px 12px;color:var(--dsw-alias-label-secondary,inherit);font-size:var(--dsh-content-font-size-secondary,0.93em)}'
    + '.dsh-prompt-blank{display:flex;flex-direction:column;gap:8px;margin:auto 0;padding:16px 4px;color:var(--dsw-alias-label-secondary,inherit)}'
    + '.dsh-prompt-blank strong{color:var(--dsw-alias-label-primary,inherit);font-size:var(--dsh-content-font-size,1em)}'
    + '.dsh-prompt-blank p{margin:0;font-size:var(--dsh-content-font-size-secondary,0.93em);line-height:1.5}'
    + '.dsh-prompt-blank ol{margin:0;padding-left:16px;display:flex;flex-direction:column;gap:4px;font-size:var(--dsh-content-font-size-secondary,0.93em);line-height:1.5}'
    + '.dsh-prompt-main{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;padding:16px;overflow:auto}.dsh-prompt-main>p[role=status]{flex-shrink:0;margin:4px 0;font-size:var(--dsh-content-font-size-secondary,0.93em)}'
    + '.dsh-prompt-titlebar{display:flex;flex-shrink:0;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}.dsh-prompt-titlebar>button{font:inherit;border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:6px;padding:4px 8px;background:transparent;color:inherit;cursor:pointer}'
    + '.dsh-prompt-titlebar strong{font-size:16px;margin-right:auto}'
    + '.dsh-prompt-modes{display:inline-flex;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));border-radius:6px;overflow:hidden}'
    + '.dsh-prompt-modes button{border:0;padding:4px 10px;background:transparent;color:inherit;cursor:pointer;font:inherit}'
    + '.dsh-prompt-modes button.is-active{background:var(--dsw-alias-state-business-primary,#4b74d9);color:#fff}'
    + '.dsh-prompt-fields{display:grid;flex-shrink:0;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-bottom:12px}.dsh-prompt-fields>details{grid-column:1/-1}.dsh-prompt-fields>details[open]{display:grid;gap:8px}'
    + '.dsh-prompt-field{display:flex;flex-direction:column;gap:4px}'
    + '.dsh-prompt-field input,.dsh-prompt-field textarea,.dsh-prompt-full textarea{width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));border-radius:6px;background:transparent;color:inherit;font:inherit}'
    + '.dsh-prompt-field textarea{min-height:54px;resize:vertical}'
    + '.dsh-prompt-field.is-missing input,.dsh-prompt-field.is-missing textarea{border-style:dashed;border-color:var(--dsw-alias-border-l2,rgba(128,128,128,.34))}'
    + '.dsh-prompt-field.is-missing .dsh-prompt-label em{font-style:normal;margin-left:8px;color:var(--dsw-alias-label-secondary,inherit);font-size:var(--dsh-content-font-size-secondary,0.93em)}'
    + '.dsh-prompt-label{display:flex;align-items:center;gap:8px}.dsh-prompt-label em{font-style:normal;font-size:var(--dsh-content-font-size-secondary,0.93em);line-height:18px;padding:0 4px;border-radius:4px;color:var(--dsw-alias-state-warning-primary,#9a3412);background:rgba(180,83,9,.10)}'
    + '.dsh-prompt-need{color:var(--dsw-alias-label-secondary,inherit)}'
    + '.dsh-prompt-full{display:flex;flex:1 0 220px;flex-direction:column;gap:8px;margin-bottom:8px;color:var(--dsw-alias-label-secondary,inherit);font-size:var(--dsh-content-font-size-secondary,0.93em)}'
    + '.dsh-prompt-full textarea{flex:1;min-height:190px;resize:vertical;line-height:1.5;font-size:var(--dsh-content-font-size,1em);color:var(--dsw-alias-label-primary,inherit);padding:12px}'
    + '.dsh-prompt-conflict{margin:8px 0;padding:8px 12px;border:1px solid var(--dsw-alias-state-warning-primary,#b45309);border-radius:6px}'
    + '.dsh-prompt-conflict button{margin-right:8px}'
    + '.dsh-prompt-foot{display:flex;flex-shrink:0;align-items:center;gap:8px;min-height:64px;padding:8px 16px;box-sizing:border-box;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));flex-wrap:wrap}'
    + '.dsh-prompt-foot [role=status]{margin-right:auto;color:var(--dsw-alias-label-secondary,inherit);font-size:var(--dsh-content-font-size-secondary,0.93em);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.dsh-prompt-saveas{display:inline-flex;align-items:center;gap:4px}'
    + '.dsh-prompt-saveas input{width:180px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));border-radius:6px;background:transparent;color:inherit;font:inherit}'
    + '.dsh-prompt-foot button{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));border-radius:6px;padding:6px 12px;background:transparent;color:inherit;cursor:pointer;font:inherit;white-space:nowrap}'
    + '.dsh-prompt-foot button.is-primary{background:var(--dsw-alias-state-business-primary,#4b74d9);border-color:transparent;color:#fff}'
    + '.dsh-prompt-foot button:disabled{opacity:.5;cursor:default}'
    + '@media(max-width:760px){.dsh-prompt-list{width:200px}.dsh-prompt-foot [role=status]{display:block;max-width:100%;white-space:normal}.dsh-prompt-fields{grid-template-columns:1fr}}@media(max-width:600px){.dsh-prompt-overlay{padding:8px}.dsh-prompt-body{flex-direction:column}.dsh-prompt-list{width:auto;flex:0 0 190px;max-height:190px;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16))}.dsh-prompt-main{padding:12px}.dsh-prompt-foot{padding:8px 12px}.dsh-prompt-saveas input{width:140px}}';
  style.textContent += '.dsh-materials-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}'
    + '.dsh-materials-types{display:inline-flex;border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:8px;overflow:hidden}'
    + '.dsh-materials-types button{border:0;padding:6px 12px;background:transparent;color:inherit;cursor:pointer;font:inherit}'
    + '.dsh-materials-types button.is-active{background:var(--dsw-alias-state-business-primary,#4b74d9);color:#fff}'
    + '.dsh-materials-tools input[type=search]{flex:1;min-width:160px;padding:6px 9px;border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:6px;background:transparent;color:inherit;font:inherit}'
    + '.dsh-materials-tools button{border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:6px;padding:6px 12px;background:transparent;color:inherit;cursor:pointer;font:inherit}'
    + '.dsh-materials-tools label{display:inline-flex;align-items:center;gap:4px;font-size:var(--dsh-content-font-size-secondary,0.93em);color:var(--dsw-alias-label-secondary,inherit)}'
    + '.dsh-materials-tools select{font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:6px;padding:6px 8px;background:var(--dsw-alias-bg-base,transparent);max-width:140px}'
    + '.dsh-materials-tools button.is-primary{background:var(--dsw-alias-state-business-primary,#4b74d9);border-color:transparent;color:#fff}'
    + '.dsh-materials-tools button:disabled{opacity:.5;cursor:default}'
    + '.dsh-materials-table{width:100%;border-collapse:collapse;font-size:var(--dsh-content-font-size,1em)}'
    + '.dsh-materials-table th,.dsh-materials-table td{text-align:left;padding:8px 8px;border-bottom:1px solid var(--dsw-alias-border-l1,#eee);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.dsh-materials-table th{color:var(--dsw-alias-label-secondary,inherit);font-weight:500}'
    + '.dsh-materials-table td button{border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:6px;padding:3px 8px;background:transparent;color:inherit;cursor:pointer;font:inherit}'
    + '.dsh-materials-foot{display:flex;align-items:center;gap:12px;margin-top:12px;color:var(--dsw-alias-label-secondary,inherit);font-size:var(--dsh-content-font-size-secondary,0.93em)}'
    + '.dsh-materials-foot button{border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:6px;padding:4px 10px;background:transparent;color:inherit;cursor:pointer;font:inherit}'
    + '.dsh-materials-foot button:disabled{opacity:.5;cursor:default}'
    + '.dsh-materials-empty{padding:16px;border:1px dashed var(--dsw-alias-border-l1,#ddd);border-radius:8px;color:var(--dsw-alias-label-secondary,inherit)}';
  style.textContent += '.dsh-materials-new{display:flex;align-items:center;gap:8px;margin:0 0 8px;padding:6px 10px;border:1px solid var(--dsw-alias-state-business-primary,#4b74d9);border-radius:8px;background:var(--dsw-alias-state-business-primary-alpha,rgba(75,116,217,.08));font-size:var(--dsh-content-font-size-secondary,0.93em)}'
    + '.dsh-materials-new button{border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:6px;padding:2px 8px;background:transparent;color:inherit;cursor:pointer;font:inherit}';
  style.textContent += '.dsh-materials-workspace{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:0 0 12px;padding:9px 12px;border:1px dashed var(--dsw-alias-border-l1,rgba(128,128,128,.28));border-radius:8px;background:var(--dsw-alias-bg-l1,rgba(128,128,128,.035));font-size:var(--dsh-content-font-size-secondary,0.93em)}'
    + '.dsh-materials-workspace>div{display:grid;gap:4px;min-width:0}.dsh-materials-workspace strong{font-size:var(--dsh-content-font-size,1em);font-weight:600}.dsh-materials-workspace span{color:var(--dsw-alias-label-secondary,inherit);line-height:1.5}'
    + '.dsh-materials-workspace button{border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:6px;padding:5px 10px;background:transparent;color:inherit;cursor:pointer;font:inherit;white-space:nowrap}';
  style.textContent += '.dsh-materials-detail{margin:12px 0;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));border-radius:10px;background:var(--dsw-alias-bg-l1,rgba(128,128,128,.04))}'
    + '.dsh-materials-panes{display:grid;grid-template-columns:1fr 1fr;gap:12px}'
    + '@media(max-width:720px){.dsh-materials-panes{grid-template-columns:1fr}}'
    + '.dsh-materials-panes pre{max-height:220px;overflow:auto;margin:4px 0 0;padding:8px;border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:6px;background:var(--dsw-alias-bg-base,#fff);font-size:var(--dsh-content-font-size-secondary,0.93em);white-space:pre-wrap;word-break:break-all}'
    + '.dsh-materials-preview{max-height:220px;overflow:auto;margin:8px 0;padding:8px;border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:6px;font-size:var(--dsh-content-font-size-secondary,0.93em);white-space:pre-wrap}'
    + '.dsh-materials-detail small{display:block;color:var(--dsw-alias-label-secondary,inherit);margin-top:8px}'
    + '.dsh-materials-table td button+button{margin-left:8px}';
  style.textContent += '.dsh-execution-tools{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px}'
    + '.dsh-execution-usage{color:var(--dsw-alias-label-secondary,inherit);font-size:var(--dsh-content-font-size-secondary,0.93em)}'
    + '.dsh-execution-tools>button{margin-left:auto;border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:6px;padding:4px 12px;background:transparent;color:inherit;cursor:pointer;font:inherit}'
    + '.dsh-execution-tools>button:disabled{opacity:.5;cursor:default}';
  style.textContent += '.dsh-usage-row{display:flex;align-items:center;flex-wrap:wrap;gap:12px;min-height:24px;margin-top:4px;font-size:var(--dsh-content-font-size-secondary,0.93em);color:var(--dsw-alias-label-secondary,inherit)}'
    + '.dsh-usage-row button{border:0;background:transparent;color:inherit;cursor:pointer;font:inherit;text-decoration:underline;padding:0}'
    + '.dsh-usage-diagnostics{display:flex;flex-direction:column;gap:4px;margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16))}'
    + '.dsh-usage-diag-items{display:flex;flex-wrap:wrap;gap:8px}'
    + '.dsh-usage-diag-items span{white-space:nowrap}'
    + '.dsh-usage-detail{flex-basis:100%;margin-top:4px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));border-radius:8px;background:var(--dsw-alias-bg-l1,rgba(128,128,128,.04));line-height:1.5;color:var(--dsw-alias-label-primary,inherit)}'
    + '.dsh-usage-detail small{display:block;color:var(--dsw-alias-label-secondary,inherit);margin-top:4px}';
  style.textContent += '.dsh-chat-explain{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:12px 0}'
    + '.dsh-chat-explain input{padding:0;accent-color:var(--dsw-alias-state-business-primary,#4b74d9)}'
    + '.dsh-chat-explain small{flex-basis:100%;margin:0;color:var(--dsw-alias-label-secondary,inherit);font-size:var(--dsh-content-font-size-secondary,0.93em)}';
  style.textContent += '.dsh-test-content{margin:12px 0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));border-radius:8px}'
    + '.dsh-test-content summary{cursor:pointer;font-weight:500}'
    + '.dsh-test-content p{margin:8px 0;font-size:var(--dsh-content-font-size-secondary,0.93em);color:var(--dsw-alias-label-secondary,inherit)}'
    + '.dsh-test-content-actions{display:flex;gap:8px;margin:8px 0}'
    + '.dsh-test-content-actions button{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));border-radius:6px;padding:4px 10px;background:transparent;color:inherit;cursor:pointer;font:inherit}'
    + '.dsh-test-content-actions button:disabled{opacity:.5;cursor:default}'
    + '.dsh-test-content fieldset{border:0;padding:0;margin:8px 0}'
    + '.dsh-test-content legend{font-weight:600;font-size:var(--dsh-content-font-size-secondary,0.93em);color:var(--dsw-alias-label-secondary,inherit);margin-bottom:4px}'
    + '.dsh-test-content label{display:inline-flex;align-items:center;gap:4px;margin:4px 16px 4px 0;font-size:var(--dsh-content-font-size-secondary,0.93em)}'
    + '.dsh-test-content input{padding:0;accent-color:var(--dsw-alias-state-business-primary,#4b74d9)}';
  style.textContent += '.dsh-materials-entry{position:relative;display:inline-flex}'
    + '.dsh-materials-import{position:absolute;bottom:calc(100% + 6px);left:0;z-index:660;box-sizing:border-box;width:min(420px,calc(100vw - 32px));max-height:min(70vh,540px);overflow:hidden;display:flex;flex-direction:column;padding:12px 16px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));border-radius:10px;background:var(--dsw-alias-bg-base,#fff);box-shadow:0 10px 32px rgba(0,0,0,.18);font-size:var(--dsh-content-font-size-secondary,0.93em);line-height:1.5;color:var(--dsw-alias-label-primary,inherit)}'
    + '.dsh-materials-import>.dsh-chat-panel-head{flex:0 0 auto}'
    + '.dsh-materials-import-body{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;padding-right:4px}'
    + '.dsh-materials-import-foot{flex:0 0 auto;display:flex;flex-direction:column;align-items:stretch;gap:8px;margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16))}'
    + '.dsh-materials-import-foot button.is-primary{margin-top:0}'
    + '.dsh-materials-success{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));border-radius:6px;background:var(--dsw-alias-bg-l1,rgba(128,128,128,.04))}'
    + '.dsh-materials-success span{min-width:0;overflow-wrap:anywhere}'
    + '.dsh-materials-success button{flex:0 0 auto;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));border-radius:6px;padding:4px 10px;background:transparent;color:inherit;cursor:pointer;font:inherit}'
    + '.dsh-materials-viewer-meta{display:flex;flex-direction:column;gap:4px;margin-bottom:8px}'
    + '.dsh-materials-viewer-meta small{display:block;color:var(--dsw-alias-label-secondary,inherit)}'
    + '.dsh-materials-viewer-text{max-height:min(46vh,360px);overflow:auto;margin:8px 0;padding:8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.18));border-radius:6px;background:var(--dsw-alias-bg-base,#fff);white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-family:ui-monospace,Consolas,monospace}'
    + '.dsh-materials-viewer-foot{flex-direction:row;justify-content:flex-end;flex-wrap:wrap}'
    + '.dsh-materials-viewer-foot button{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));border-radius:6px;padding:5px 10px;background:transparent;color:inherit;cursor:pointer;font:inherit}'
    + '.dsh-materials-progress{display:flex;flex-direction:column;gap:4px;margin-top:8px}'
    + '.dsh-materials-steps{color:var(--dsw-alias-label-secondary,inherit);font-size:var(--dsh-content-font-size-secondary,0.93em)}'
    + '.dsh-materials-errors{margin-top:4px}'
    + '.dsh-materials-errors summary{cursor:pointer;font-size:var(--dsh-content-font-size-secondary,0.93em);color:var(--dsw-alias-label-secondary,inherit)}'
    + '.dsh-materials-errors ul{margin:4px 0 0;padding-left:16px;font-size:var(--dsh-content-font-size-secondary,0.93em);color:var(--dsw-alias-state-error-primary,#c84040)}'
    + '.dsh-materials-import-actions{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}'
    + '.dsh-materials-import-actions button{border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));border-radius:6px;padding:5px 10px;background:transparent;color:inherit;cursor:pointer;font:inherit}'
    + '.dsh-materials-import label{display:block;margin:8px 0}'
    + '.dsh-materials-import textarea,.dsh-materials-import input[type=text],.dsh-materials-import-name input{display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.2));border-radius:6px;background:transparent;color:inherit;font:inherit}'
    + '.dsh-materials-import textarea{min-height:90px;resize:vertical;font-family:ui-monospace,Consolas,monospace}'
    + '.dsh-materials-import button.is-primary{background:var(--dsw-alias-state-business-primary,#4b74d9);border-color:transparent;color:#fff}'
    + '.dsh-materials-import small{display:block;margin-top:8px;color:var(--dsw-alias-label-secondary,inherit)}'
    + '.dsh-materials-import [role=alert]{color:var(--dsw-alias-state-error-primary,#c84040)}';
  style.textContent += [
    '.dsh-task-workspace{max-width:none;margin:0;padding:12px 16px 16px;font-size:inherit;line-height:1.5}',
    '.dsh-task-nav{margin-bottom:12px;padding-bottom:8px;gap:4px}.dsh-task-nav button{padding:5px 11px;font-size:var(--dsh-content-font-size,1em)}',
    '.dsh-task-nav select{margin-left:auto;font:inherit;color:inherit;background:var(--dsw-alias-bg-base,transparent);border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:6px;padding:4px 7px;max-width:100%}',
    '.dsh-task-heading{margin-bottom:8px;gap:8px}.dsh-task-panel h3,.dsh-task-panel h4{font-size:var(--dsh-content-font-size,1em);margin:0;font-weight:600}.dsh-task-panel p{margin:4px 0;line-height:1.5}',
    '.dsh-task-summary{padding:8px 0;border:0;border-bottom:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:0}.dsh-task-eyebrow{font-size:var(--dsh-content-font-size-secondary,0.93em);color:var(--dsw-alias-label-secondary,inherit)}.dsh-task-summary h2{font-size:var(--dsh-content-font-size,1em);line-height:1.5;margin:4px 0;font-weight:600;overflow-wrap:anywhere}.dsh-task-summary p{color:var(--dsw-alias-label-secondary,inherit);overflow-wrap:anywhere}',
    '.dsh-task-next{padding:4px 0;margin:4px 0;background:transparent;border-radius:0}.dsh-task-next p{margin:4px 0}',
    '.dsh-task-metrics{display:flex;flex-wrap:wrap;gap:8px 24px;margin:8px 0 12px;padding:8px 0;border-top:1px solid var(--dsw-alias-border-l1,#ddd);border-bottom:1px solid var(--dsw-alias-border-l1,#ddd)}.dsh-task-metrics strong{font-size:var(--dsh-content-font-size-secondary,0.93em);font-weight:600;font-variant-numeric:tabular-nums}',
    '.dsh-task-recent-row{padding:8px 0;border-top:1px solid var(--dsw-alias-border-l1,#ddd);overflow-wrap:anywhere}.dsh-task-recent-row>div{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}.dsh-task-recent-row p{margin:4px 0;color:var(--dsw-alias-label-secondary,inherit)}',
    '.dsh-task-panel details,.dsh-task-fold{margin:8px 0;padding:8px 8px;border-radius:5px}.dsh-task-panel .dsh-rtr-btn{font-size:var(--dsh-content-font-size,1em);padding:4px 8px;border-radius:6px}',
    '.dsh-task-file-list{display:grid;gap:8px}.dsh-task-file,.dsh-task-empty{padding:8px 12px;border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:6px;overflow-wrap:anywhere}.dsh-task-empty{margin:12px 0;padding:12px}.dsh-task-file-head{display:flex;justify-content:space-between;align-items:center;gap:12px}.dsh-task-file-head small{display:block;margin-top:4px}.dsh-task-file code{user-select:text;font-size:var(--dsh-content-font-size-secondary,0.93em)}',
    '.dsh-finding-preview{padding:0 12px 8px;font-size:var(--dsh-content-font-size-secondary,0.93em);overflow-wrap:anywhere}.dsh-finding-preview p{margin:4px 0;line-height:1.5}.dsh-task-workspace .dsh-rtr-rowhead{flex-wrap:wrap;gap:8px;padding:8px 12px}.dsh-task-workspace .dsh-rtr-title{flex:1;min-width:140px;white-space:normal;font-size:var(--dsh-content-font-size-secondary,0.93em)}.dsh-task-actions{display:flex;gap:8px;margin-top:8px}',
    '.dsh-task-state-line{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.dsh-task-mode{font-size:var(--dsh-content-font-size-secondary,0.93em);color:var(--dsw-alias-label-secondary,#666)}.dsh-task-stop-reason{font-size:var(--dsh-content-font-size-secondary,0.93em);padding:4px 8px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,#f4f5f7);color:var(--dsw-alias-label-secondary,#666)}',
    '.dsh-task-scope-summary{font-size:var(--dsh-content-font-size-secondary,0.93em);line-height:1.5;margin:4px 0}.dsh-task-summary-actions{display:flex;gap:8px;flex-wrap:wrap;margin:4px 0}.dsh-task-pending-change{padding:8px 12px;border-left:3px solid var(--dsw-alias-state-business-primary,#4c6ef5);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4c6ef5) 8%,transparent)}.dsh-task-pending-change p{margin:4px 0 8px}',
    '.dsh-task-result{display:flex;align-items:baseline;gap:24px;margin:8px 0 8px;font-size:var(--dsh-content-font-size-secondary,0.93em)}.dsh-task-result strong{font-size:16px;font-weight:600;font-variant-numeric:tabular-nums;margin-right:4px}.dsh-task-pending{color:var(--dsw-alias-label-primary,inherit)}.dsh-task-metrics{color:var(--dsw-alias-label-secondary,#666);border-top:0;margin-top:0;padding-top:4px;gap:8px 16px}',
    '.dsh-task-project-table{width:100%;display:block;overflow-x:auto;border-collapse:collapse;font-size:var(--dsh-content-font-size,1em)}.dsh-task-project-table th,.dsh-task-project-table td{padding:8px;border-bottom:1px solid rgba(120,150,190,.18);text-align:left;white-space:normal;word-break:break-word;vertical-align:top}.dsh-task-project-table th{color:var(--dsw-alias-label-secondary,#666);font-weight:600}',
    '.dsh-task-brief{display:flex;flex-wrap:wrap;gap:4px 16px;margin:4px 0 4px;font-size:var(--dsh-content-font-size-secondary,0.93em);color:var(--dsw-alias-label-secondary,#666)}.dsh-task-brief span{overflow-wrap:anywhere}.dsh-task-gaps{margin:4px 0 4px;font-size:var(--dsh-content-font-size-secondary,0.93em)}.dsh-task-gaps p{margin:4px 0 0;color:var(--dsw-alias-label-secondary,#666);overflow-wrap:anywhere}.dsh-task-entries{margin:4px 0 4px;font-size:var(--dsh-content-font-size-secondary,0.93em)}.dsh-task-entries p{margin:4px 0 0;color:var(--dsw-alias-label-secondary,#666);overflow-wrap:anywhere}',
    '.dsh-task-panel .dsh-task-recent-row{margin:0;padding:8px 0;border:0;border-top:1px solid var(--dsw-alias-border-l1,#e7e8eb);border-radius:0}.dsh-task-recent-row>summary{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;cursor:pointer;list-style:none}.dsh-task-recent-row>summary::-webkit-details-marker{display:none}.dsh-task-recent-row>summary:focus-visible{outline:2px solid var(--dsw-alias-border-focus,#587cf6);outline-offset:3px}.dsh-task-finding-title{font-weight:600}.dsh-task-finding-title:before{content:"›";display:inline-block;margin-right:8px;color:var(--dsw-alias-label-secondary,#888)}.dsh-task-recent-row[open] .dsh-task-finding-title:before{transform:rotate(90deg)}.dsh-task-finding-target,.dsh-task-finding-note{grid-column:1/-1;color:var(--dsw-alias-label-secondary,#666);overflow-wrap:anywhere}.dsh-task-finding-note{color:var(--dsw-alias-label-primary,inherit)}.dsh-task-recent-row[open]>summary{margin-bottom:8px}.dsh-task-summary{padding-top:0px;border-bottom:0}',
    '.dsh-task-field{display:grid;grid-template-columns:118px minmax(0,600px);align-items:center;gap:8px;margin:8px 0}.dsh-task-field input,.dsh-task-field select{box-sizing:border-box;max-width:100%;min-width:0;font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:6px;background:var(--dsw-alias-bg-base,transparent);padding:5px 7px}.dsh-task-field input[type=number]{width:76px}.dsh-task-field select{width:fit-content}.dsh-task-mode-options{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}',
    '.dsh-chat-project-status{margin:8px 0;padding:8px 0;border-top:1px solid var(--dsw-alias-border-l1,#e3e5e8);border-bottom:1px solid var(--dsw-alias-border-l1,#e3e5e8);font-size:var(--dsh-content-font-size-secondary,0.93em)}.dsh-chat-project-status-row{display:flex;align-items:center;gap:8px 12px;flex-wrap:wrap}.dsh-chat-project-status-row strong{font-variant-numeric:tabular-nums}.dsh-chat-project-status-row .dsh-chat-project-current{color:var(--dsw-alias-label-secondary,#666);overflow-wrap:anywhere}',
    '.dsh-project-modal-backdrop{position:fixed;inset:0;z-index:1000;background:rgba(15,23,42,.38);display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}.dsh-project-modal{width:min(1100px,calc(100vw - 48px));max-height:70vh;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);border:1px solid var(--dsw-alias-border-l1,#d8dde6);border-radius:12px;box-shadow:0 18px 60px rgba(15,23,42,.28);overflow:hidden}.dsh-project-modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1,#e3e5e8);flex:0 0 auto}.dsh-project-modal-head strong{font-size:var(--dsh-content-font-size,1em)}.dsh-project-modal-body{overflow:auto;padding:0 16px 16px;min-height:0}.dsh-project-table{width:100%;min-width:900px;border-collapse:collapse;table-layout:fixed;font-size:var(--dsh-content-font-size-secondary,0.93em)}.dsh-project-table th,.dsh-project-table td{padding:8px;border-bottom:1px solid rgba(120,150,190,.18);text-align:left;white-space:normal;word-break:break-word;vertical-align:top}.dsh-project-table th{position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-secondary,#666);font-weight:600}.dsh-project-note{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere}.dsh-project-detail-link{margin-top:4px;padding:0;border:0;background:transparent;color:var(--dsw-alias-state-business-primary,#4b74d9);cursor:pointer;font:inherit;text-align:left}.dsh-project-detail{border:1px solid var(--dsw-alias-border-l1,#d8dde6);border-radius:8px;margin-top:12px;max-height:42vh;overflow:auto}.dsh-project-detail-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#e3e5e8);position:sticky;top:0;background:var(--dsw-alias-bg-base,#fff)}.dsh-project-detail-body{margin:0;padding:12px;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 Consolas,"Microsoft YaHei",monospace;max-height:36vh;overflow:auto}',
    '.dsh-research-view{display:flex;flex-direction:column;gap:12px;font-size:var(--dsh-content-font-size,1em)}.dsh-research-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.dsh-research-head strong{font-size:var(--dsh-content-font-size,1em);font-weight:600}.dsh-research-head p{margin:4px 0 0;font-size:var(--dsh-content-font-size-secondary,0.93em);line-height:1.5;color:var(--dsw-alias-label-secondary,#666)}'
      + '.dsh-research-empty{padding:16px;border:1px dashed var(--dsw-alias-border-l1,#d8dde6);border-radius:6px}.dsh-research-empty p{margin:0 0 12px;line-height:1.5;color:var(--dsw-alias-label-secondary,#666)}'
      + '.dsh-research-list{display:flex;flex-direction:column;gap:8px}.dsh-research-row{display:grid;grid-template-columns:auto minmax(0,1fr);gap:4px 8px;width:100%;padding:8px 12px;text-align:left;font:inherit;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:6px;cursor:pointer}.dsh-research-row:hover{background:var(--dsw-alias-bg-hover,rgba(75,116,217,.06))}.dsh-research-row.is-active{border-color:var(--dsw-alias-state-business-primary,#4b74d9);background:var(--dsw-alias-state-business-primary-alpha,rgba(75,116,217,.08))}'
      + '.dsh-research-state{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:6px;font-size:var(--dsh-content-font-size-secondary,0.93em);line-height:1.5;background:var(--dsw-alias-bg-l1,rgba(128,128,128,.08));color:var(--dsw-alias-label-secondary,#555);white-space:nowrap}.dsh-research-state[data-state=active]{color:var(--dsw-alias-state-business-primary,#4b74d9)}.dsh-research-state[data-state=refuted],.dsh-research-state[data-state=blocked]{color:var(--dsw-alias-state-error-primary,#c84040)}.dsh-research-state[data-state=supported]{color:var(--dsw-alias-state-success-primary,#2f9e44)}'
      + '.dsh-research-title{font-weight:600;line-height:1.5;overflow-wrap:anywhere}.dsh-research-meta{grid-column:1/-1;font-size:var(--dsh-content-font-size-secondary,0.93em);line-height:1.5;color:var(--dsw-alias-label-secondary,#666);overflow-wrap:anywhere}'
      + '.dsh-research-pager{display:flex;align-items:center;gap:8px;font-size:var(--dsh-content-font-size-secondary,0.93em);color:var(--dsw-alias-label-secondary,#666)}'
      + '.dsh-research-findings{display:flex;flex-direction:column;gap:8px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1,#e3e5e8)}.dsh-research-finding{display:flex;flex-direction:column;gap:4px;padding:8px 0}.dsh-research-finding-title{font-weight:600;line-height:1.5;overflow-wrap:anywhere}.dsh-research-finding-meta{font-size:var(--dsh-content-font-size-secondary,0.93em);line-height:1.5;color:var(--dsw-alias-label-secondary,#666);overflow-wrap:anywhere}'
      + '.dsh-research-detail{padding:8px 12px;border-left:3px solid var(--dsw-alias-state-business-primary,#4b74d9);background:var(--dsw-alias-bg-l1,rgba(128,128,128,.04));border-radius:6px}.dsh-research-detail h4{margin:0 0 4px;font-size:var(--dsh-content-font-size,1em);font-weight:600;overflow-wrap:anywhere}.dsh-research-detail p{margin:4px 0;line-height:1.5;overflow-wrap:anywhere}.dsh-research-detail-meta,.dsh-research-boundary{font-size:var(--dsh-content-font-size-secondary,0.93em);color:var(--dsw-alias-label-secondary,#666)}.dsh-research-warning{color:var(--dsw-alias-state-error-primary,#c84040)}'
      + '.dsh-research-observations{margin-top:8px}.dsh-research-observations summary{cursor:pointer;line-height:1.5}.dsh-research-observations pre{margin:8px 0 0;padding:8px;max-height:240px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 Consolas,"Microsoft YaHei",monospace;background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l1,#e3e5e8);border-radius:6px}',
    '@media(max-width:760px){.dsh-project-modal-backdrop{padding:12px}.dsh-project-modal{width:calc(100vw - 24px);max-height:80vh}.dsh-project-modal-head{padding:8px 12px}.dsh-project-modal-body{padding:0 12px 12px}}',
    '@media(max-width:600px){.dsh-task-workspace{padding:8px 12px}.dsh-task-file-head{align-items:flex-start;flex-wrap:wrap}.dsh-task-metrics{gap:4px 12px}.dsh-task-field{grid-template-columns:1fr;gap:4px}}'
  ].join('');
  // v6 第 5.7 节共享组件层：控件尺寸改由 shared/ui-kit/ui-kit.css 提供
  // （scripts/sync-ui-kit.mjs 注入到 SAKER_UI_KIT_CSS），这里不再重复写一套。
  style.textContent += SAKER_UI_KIT_CSS;
  // 2026-11-07 UX 重构：统一面板标题、分节、空状态与表单行。
  // 目标是让新用户先看到"现在能做什么"，而不是实现说明；控件尺寸继续走共享 UI kit。
  style.textContent += '.saker-panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:0 0 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));margin:0 0 12px}'
    + '.saker-panel-headtext{display:flex;flex-direction:column;gap:4px;min-width:0}.saker-panel-head strong{font-size:var(--dsh-content-font-size,1em);font-weight:600}'
    + '.saker-panel-subtitle{font-size:var(--dsh-content-font-size-secondary,0.93em);line-height:1.5;color:var(--dsw-alias-label-secondary,inherit);margin:0}'
    + '.saker-panel-section{margin:16px 0 0;padding:16px 0 0;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16))}'
    + '.saker-panel-section:first-of-type{margin-top:0;padding-top:0;border-top:0}'
    + '.saker-panel-section h4{font-size:var(--dsh-content-font-size,1em);font-weight:600;margin:0 0 4px}'
    + '.saker-panel-section-desc{font-size:var(--dsh-content-font-size-secondary,0.93em);line-height:1.5;color:var(--dsw-alias-label-secondary,inherit);margin:0 0 12px}'
    + '.saker-panel-hint{font-size:var(--dsh-content-font-size-secondary,0.93em);line-height:1.5;color:var(--dsw-alias-label-secondary,inherit);margin:4px 0 0}'
    + '.saker-panel-empty{display:flex;flex-direction:column;align-items:flex-start;gap:4px;padding:16px;border:1px dashed var(--dsw-alias-border-l1,rgba(128,128,128,.24));border-radius:6px;color:var(--dsw-alias-label-secondary,inherit);font-size:var(--dsh-content-font-size-secondary,0.93em);line-height:1.5}'
    + '.saker-panel-empty strong{font-size:var(--dsh-content-font-size,1em);font-weight:600;color:var(--dsw-alias-label-primary,inherit)}'
    + '.saker-panel-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin:16px 0 0}'
    + '.saker-panel-actions .is-primary{background:var(--dsw-alias-state-business-primary,#4b74d9);color:#fff;border-color:transparent}'
    + '.saker-check{display:flex;align-items:flex-start;gap:8px;font-size:var(--dsh-content-font-size,1em);line-height:1.5}'
    + '.saker-check input{margin:4px 0 0;flex:0 0 auto}'
    + '.saker-field{display:flex;flex-direction:column;gap:4px;margin:12px 0}'
    + '.saker-field>span{font-size:var(--dsh-content-font-size,1em);font-weight:500}.saker-field>small{font-size:var(--dsh-content-font-size-secondary,0.93em);line-height:1.5;color:var(--dsw-alias-label-secondary,inherit)}'
    + '.saker-field input,.saker-field select,.saker-field textarea{font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.24));border-radius:6px;background:var(--dsw-alias-bg-base,transparent);padding:6px 8px;box-sizing:border-box;max-width:100%}'
    + '.saker-field input,.saker-field select{height:32px;padding:0 8px}.saker-field textarea{min-height:64px;resize:vertical;line-height:1.5}'
    + '.saker-grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}'
    + '.dsh-settings-layout{display:grid;grid-template-columns:200px minmax(0,1fr);gap:24px;min-height:0;flex:1 1 auto;overflow:hidden}'
    + '.dsh-settings-side{display:flex;flex-direction:column;gap:12px;min-height:0;padding-right:16px;border-right:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16))}'
    + '.dsh-settings-nav{display:flex;flex-direction:column;gap:4px;padding:0;margin:0;border:0}'
    + '.dsh-settings-nav button{display:flex;flex-direction:column;align-items:flex-start;gap:4px;width:100%;height:auto;padding:8px 10px;border:0;border-radius:6px;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}'
    + '.dsh-settings-nav button small{font-size:var(--dsh-content-font-size-secondary,0.93em);line-height:1.5;color:var(--dsw-alias-label-secondary,inherit)}'
    + '.dsh-settings-nav button.is-active{background:var(--dsw-alias-bg-hover,rgba(75,116,217,.10));color:var(--dsw-alias-state-business-primary,#4b74d9)}'
    + '.dsh-settings-content{min-width:0;min-height:0;overflow:auto;padding-right:4px}'
    + '.dsh-knowledge-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.15fr);gap:16px;min-height:0}'
    + '.dsh-knowledge-list{min-width:0}.dsh-knowledge-reader{min-width:0;border-left:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16));padding-left:16px;overflow:auto}'
    + '.dsh-knowledge-row{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16))}'
    + '.dsh-knowledge-row>div{display:flex;flex-direction:column;gap:4px;min-width:0}.dsh-knowledge-row strong{font-size:var(--dsh-content-font-size,1em);font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.dsh-knowledge-row small{font-size:var(--dsh-content-font-size-secondary,0.93em);line-height:1.5;color:var(--dsw-alias-label-secondary,inherit)}.dsh-knowledge-row-actions{display:flex;gap:4px;flex:0 0 auto}'
    + '@media(max-width:720px){.dsh-settings-layout{grid-template-columns:1fr;gap:12px;overflow:visible}.dsh-settings-side{padding-right:0;padding-bottom:12px;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16))}.dsh-settings-nav{flex-direction:row;overflow:auto}.dsh-settings-nav button{width:auto;flex:0 0 auto;flex-direction:row;align-items:center}.dsh-settings-nav button small{display:none}.dsh-settings-content{overflow:visible}.dsh-knowledge-layout{grid-template-columns:1fr}.dsh-knowledge-reader{border-left:0;padding-left:0;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(128,128,128,.16))}}'
    + '@media(max-width:640px){.saker-grid2{grid-template-columns:1fr}}';
  // 2026-11-10 UX cleanup: the old full-screen ledger used a dark neon/3D globe
  // visual that read as a demo rather than a working tool. Keep the data view,
  // but render it with the host theme and ordinary cards.
  style.textContent += '.dsh-rtr-screen{background:var(--dsw-alias-bg-base,#fff)!important;color:var(--dsw-alias-label-primary,inherit)!important}'
    + '.dsh-rtr-screen::before{display:none!important}.dsh-rtr-screen::after{display:none!important}'
    + '.dsh-scr-header{background:var(--dsw-alias-bg-l1,rgba(128,128,128,.04))!important;border-color:var(--dsw-alias-border-l1,rgba(128,128,128,.18))!important;box-shadow:none!important;backdrop-filter:none!important}'
    + '.dsh-scr-title{background:none!important;-webkit-text-fill-color:currentColor!important;color:var(--dsw-alias-label-primary,inherit)!important;letter-spacing:0!important;font-size:20px!important}'
    + '.dsh-scr-title small{display:block;margin-top:4px;font-size:var(--dsh-content-font-size-secondary,0.93em);font-weight:400;letter-spacing:0;color:var(--dsw-alias-label-secondary,inherit)}'
    + '.dsh-scr-dot{background:#2f9e62!important;box-shadow:none!important;animation:none!important}'
    + '.dsh-scr-panel,.dsh-scr-num{background:var(--dsw-alias-bg-l1,rgba(128,128,128,.04))!important;border-color:var(--dsw-alias-border-l1,rgba(128,128,128,.18))!important;box-shadow:none!important;backdrop-filter:none!important}'
    + '.dsh-scr-globewrap{display:none!important}.dsh-scr-hero{gap:16px!important}'
    + '.dsh-scr-donut{box-shadow:none!important}'
    + '.dsh-scr-num:hover{transform:none!important;box-shadow:none!important}'
    + '.dsh-rtr-screen .dsh-rtr-btn{background:var(--dsw-alias-bg-base,#fff)!important;color:inherit!important;border-color:var(--dsw-alias-border-l1,rgba(128,128,128,.24))!important;box-shadow:none!important;backdrop-filter:none!important}'
    + '.dsh-rtr-screen .dsh-rtr-btn:hover{background:var(--dsw-alias-bg-hover,rgba(128,128,128,.08))!important}';
  // 0.9.13: typography follows the host text-size setting. The composer reads
  // the host body size explicitly instead of inheriting the shell chrome size.
  style.textContent += '.dsh-chat-setup,.dsh-task-workspace,.dsh-chat-more,.dsh-prompt-drawer,.dsh-curation-dialog,.dsh-settings-layout,.dsh-materials-view,.dsh-knowledge-layout{font-size:var(--dsh-content-font-size,inherit)}'
    + '.dsh-task-workspace{padding:12px 16px 16px}'
    + '.dsh-prompt-full textarea{font-size:var(--dsh-content-font-size,inherit);min-height:160px;padding:8px}';
  document.head.appendChild(style);return function(){style.remove();};
}

function WorkerFindings(props) {
  var result=useState(null), error=useState(''), expanded=useState(false);
  function load(){expanded[1](true); return api('workers.findings',{sessionId:props.sessionId,childId:props.childId,delivery:'all'}).then(function(value){if(!value.ok)throw Error(value.error);result[1](value);}).catch(function(e){error[1](e.message);});}
  return React.createElement('div',null,React.createElement(Btn,{onClick:load},'查看子任务成果'),error[0]?React.createElement('div',{role:'alert'},error[0]):null,
    expanded[0]&&result[0]?React.createElement('div',null,React.createElement('p',null,'成果 '+result[0].list.total+'；详细记录保留在子会话 '+props.childId),result[0].list.rows.map(function(f){return React.createElement('details',{key:f.id},React.createElement('summary',null,f.title+' · '+(STATUS_LABEL[f.status]||f.status)),React.createElement(Detail,{f:Object.assign({},f,{sessionId:props.childId}),mode:'pentest',sessionId:props.childId,meta:MODE_META.pentest,onEffectReview:load}));})):null);
}
function modelCallPurposeLabel(value) {
  return {'conversation':'对话','session-title':'会话标题','compaction':'上下文整理'}[value] || value || '模型调用';
}
function modelCallStateLabel(value) {
  return {reserved:'等待发送',dispatched:'发送中',settled:'已结算',unknown:'用量未知',cancelled:'未发送'}[value] || value;
}
function modelWireLabel(wire) {
  if (!wire) return '未观测到原生 fetch 发送';
  return '原生发送 '+wire.protocol+' · '+wire.bytes+' 字节'+(wire.maximumOutput!==null&&wire.maximumOutput!==undefined?' · 输出上限 '+wire.maximumOutput:'');
}
function ProjectPanel(props) {
  var project=useState(null), error=useState(''), busy=useState(false), checkOffset=useState(0), checkDetail=useState(null);
  var runLabels={preparing:'正在准备',running:'正在测试',waiting:'等待补充条件',paused:'已暂停',completed:'本次测试已结束',cancelled:'已停止',failed:'运行失败'};
  function load(offset){var nextOffset=offset===undefined?checkOffset[0]:offset;checkOffset[1](nextOffset);return api('project.status',{sessionId:props.sessionId,checkOffset:nextOffset,checkLimit:50}).then(function(value){if(!value.ok)throw Error(value.error||'读取项目状态失败');error[1]('');project[1](value);}).catch(function(e){error[1](e.message);});}
  useEffect(function(){load();},[props.sessionId,props.status]);
  function act(endpoint,payload){busy[1](true);error[1]('');var current=project[0];return api(endpoint,Object.assign({sessionId:props.sessionId,runId:current&&current.run?current.run.runId:undefined,expectedControlRev:current&&current.run?current.run.controlRev:undefined},payload||{})).then(function(value){if(!value.ok)throw Error(value.error||'操作失败');return load();}).catch(function(e){error[1](e.message);}).finally(function(){busy[1](false);});}
  function exportResult(){error[1]('');var current=project[0];return api('project.export',{sessionId:props.sessionId,runId:current&&current.run?current.run.runId:undefined}).then(function(value){if(!value.ok)throw Error(value.error||'导出失败');downloadArchive(value.filename,value.archive);}).catch(function(e){error[1](e.message);});}
  function showCheck(check){return api('project.check-detail',{sessionId:props.sessionId,runId:project[0]&&project[0].run?project[0].run.runId:undefined,checkId:check.checkId}).then(function(value){if(!value.ok)throw Error(value.error||'读取检查详情失败');checkDetail[1](value);}).catch(function(e){error[1](e.message);});}
  var status=project[0], run=status&&status.run;
  if(run&&run.sessionId&&String(run.sessionId)!==String(props.sessionId)){status=null;run=null;}
  var checks=(status&&status.checks)||[], counts=(status&&status.counts)||{}, sources=(status&&status.sources)||[];
  var decisionLabels={requirements:'已执行要求',reference:'参考信息',excluded:'明确排除', 'not-applicable':'不适用',pending:'待确认',unreadable:'无法解析'};
  var summary=['已执行 '+(counts.executed||0)+'/'+(counts.total||0),'待核对 '+(counts.unverified||0),'缺口 '+(counts.gaps||0),'发现问题 '+(counts.issue||0)];
  [['partial','部分完成'],['inProgress','正在检查'],['paused','已暂停'],['notStarted','未开始'],['notApplicable','不适用']].forEach(function(item){if(counts[item[0]])summary.push(item[1]+' '+counts[item[0]]);});
  return React.createElement('section',{'aria-label':'案例测试',className:'dsh-task-panel'},
    React.createElement('div',{className:'dsh-task-heading'},React.createElement('h3',null,'案例测试'),React.createElement(Btn,{disabled:busy[0],onClick:load},'刷新状态')),
    error[0]?React.createElement('div',{role:'alert'},error[0]):null,
    !status?React.createElement('p',{role:'status'},'正在读取项目状态…'):
    !status.configured?React.createElement('p',null,'还没有开始案例测试。'):
    React.createElement('div',null,
      React.createElement('p',{role:'status'},runLabels[run.state]||'状态未知',run.blocker&&run.blocker.reason?' · '+run.blocker.reason:''),
      React.createElement('p',{className:'dsh-task-result'},summary.join(' · ')),
      React.createElement(ProjectUnknownActions,{sessionId:props.sessionId,run:run,actions:status.unknownActions||[],onSaved:load}),
      React.createElement('div',{className:'dsh-task-metrics'},
        status.manualTakeover&&status.manualTakeover.active?React.createElement(Btn,{disabled:busy[0]||run.state==='cancelled',onClick:function(){return act('task.takeover-resume');}},'继续测试'):null,
        !(status.manualTakeover&&status.manualTakeover.active)&&status.browserTakeover&&status.browserTakeover.open&&['preparing','running','paused','waiting'].indexOf(run.state)>=0?React.createElement(Btn,{disabled:busy[0],onClick:function(){return act('task.takeover');}},'我来操作'):null,
        React.createElement(Btn,{disabled:busy[0]||['preparing','running'].indexOf(run.state)<0,onClick:function(){return act('project.pause');}},'暂停'),
        !(status.manualTakeover&&status.manualTakeover.active)?React.createElement(Btn,{disabled:busy[0]||['paused','waiting'].indexOf(run.state)<0,onClick:function(){return act('project.resume');}},'继续'):null,
        React.createElement(Btn,{disabled:busy[0]||['cancelled','completed','failed'].indexOf(run.state)>=0,onClick:function(){return act('project.stop');}},'停止'),
        React.createElement(Btn,{disabled:busy[0],onClick:exportResult},'导出结果'),
        props.onFindings?React.createElement(Btn,{onClick:props.onFindings},'查看发现问题'):null),
      checks.length?React.createElement('table',{className:'dsh-task-project-table'},
        React.createElement('thead',null,React.createElement('tr',null,React.createElement('th',null,'文档要求'),React.createElement('th',null,'执行'),React.createElement('th',null,'结论／确认'),React.createElement('th',null,'说明'),React.createElement('th',null,'操作'))),
        React.createElement('tbody',null,checks.map(function(check){
          return React.createElement('tr',{key:check.checkId},React.createElement('td',null,check.requirement),React.createElement('td',null,check.executionLabel||check.displayResult||'未执行'),React.createElement('td',null,(check.displayResult||'未得出结论')+(check.confirmationLabel?' · '+check.confirmationLabel:'')),React.createElement('td',null,check.displayNotes||''),React.createElement('td',null,React.createElement(Btn,{disabled:busy[0],onClick:function(){return showCheck(check)}},'详情'),' ',React.createElement(Btn,{disabled:busy[0],onClick:function(){return act('project.retest',{checkIds:[check.checkId]});}},'仅重测此项')));
        }))):React.createElement('p',null,'还没有整理出的检查项。'),
      checkDetail[0]?React.createElement('details',{open:true},React.createElement('summary',null,'检查详情 · '+(checkDetail[0].check&&checkDetail[0].check.requirement||'记录')),React.createElement('pre',{className:'dsh-chat-result'},JSON.stringify({check:checkDetail[0].check,evidence:checkDetail[0].evidence,actions:checkDetail[0].actions},null,2))):null,
      React.createElement('div',{className:'dsh-chat-actions'},React.createElement(Btn,{disabled:busy[0]||checkOffset[0]<=0,onClick:function(){return load(Math.max(0,checkOffset[0]-50))}},'上一页'),React.createElement(Btn,{disabled:busy[0]||!status.nextCheckOffset,onClick:function(){return load(status.nextCheckOffset)}},'下一页')),
      React.createElement('details',null,React.createElement('summary',null,'原表区域决定（'+((status.sourceDecisions||[]).length)+'）'),
        React.createElement('p',null,Object.keys(status.sourceDecisionCounts||{}).length
          ? Object.keys(status.sourceDecisionCounts).map(function(key){return (decisionLabels[key]||key)+' '+status.sourceDecisionCounts[key];}).join(' · ')
          : '暂无可显示决定。'),
        (status.sourceDecisions||[]).slice(0,50).map(function(item){return React.createElement('p',{key:item.sourceId+'@'+item.sourceRevision+':'+item.sectionId},(decisionLabels[item.decision]||item.decision)+' · '+item.sourceId+' · '+item.sectionId+(item.rationale?' · '+item.rationale:''));})),
      React.createElement('details',null,React.createElement('summary',null,'文档来源（'+sources.length+'）'),
        sources.length?sources.map(function(source){return React.createElement('p',{key:source.sourceId+'@'+source.sourceRevision},(source.displayName||source.sourceId)+' · '+source.sourceRevision+' · '+source.parseState);}):React.createElement('p',null,'没有已保存的来源。'))));
}
function ProjectChatStatus(props) {
  function checkNotesPreview(value) {
    var text=String(value||'')
      .replace(/```[\s\S]*?```/g,' [代码片段] ')
      .replace(/!\[[^\]]*\]\([^)]*\)/g,' [图片] ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g,'$1')
      .replace(/[#>*_`]/g,' ')
      .replace(/\s+/g,' ').trim();
    return text.length>240?text.slice(0,239)+'…':text;
  }
  var data=useState(null), error=useState(''), busy=useState(false), open=useState(false), selectedRun=useState('');
  var loading=useState(false), detail=useState(null);
  var request=useRef(0), mounted=useRef(true), lastLiveRun=useRef('');
  var runLabels={preparing:'正在准备',running:'正在测试',waiting:'等待补充条件',paused:'已暂停',completed:'本次测试已结束',cancelled:'已停止',failed:'运行失败'};
  function currentRunId(){var status=props.status;return status&&status.configured&&status.policy&&status.policy.scenario==='project'?String(status.policy.projectRunId||''):'';}
  var liveRunId=currentRunId();
  function load(runId,options){
    var revision=++request.current, requested=runId===undefined?'':String(runId||''), background=!!(options&&options.background);
    if(!background){loading[1](true);data[1](null);error[1]('');detail[1](null);}
    return api('project.status',{sessionId:props.sessionId,runId:requested||undefined}).then(function(value){
      if(!mounted.current||revision!==request.current)return;
      if(!value.ok)throw Error(value.error||'读取项目状态失败');
      if(value.run&&value.run.sessionId&&String(value.run.sessionId)!==String(props.sessionId))throw Error('读取到的测试记录不属于当前会话');
      error[1]('');data[1](value);
      var resolved=value.run?String(value.run.runId):'';
      if(resolved&&(!selectedRun[0]||!requested||requested===resolved))selectedRun[1](resolved);
    }).catch(function(e){if(mounted.current&&revision===request.current&&!background)error[1](e.message||String(e));})
      .finally(function(){if(mounted.current&&revision===request.current&&!background)loading[1](false);});
  }
  useEffect(function(){mounted.current=true;return function(){mounted.current=false;request.current++;};},[props.sessionId]);
  useEffect(function(){
    if(liveRunId&&liveRunId!==lastLiveRun.current){lastLiveRun.current=liveRunId;selectedRun[1](liveRunId);load(liveRunId);return;}
    if(!liveRunId)lastLiveRun.current='';
    load(selectedRun[0]||'');
  },[props.sessionId,liveRunId]);
  function retry(){error[1]('');return load(selectedRun[0]||liveRunId);}
  function act(endpoint,payload){busy[1](true);error[1]('');var current=data[0];return api(endpoint,Object.assign({sessionId:props.sessionId,runId:current&&current.run?current.run.runId:undefined,expectedControlRev:current&&current.run?current.run.controlRev:undefined},payload||{})).then(function(value){if(!value.ok)throw Error(value.error||'操作失败');return load((value.run&&value.run.runId)||selectedRun[0]||liveRunId,{background:true});}).catch(function(e){error[1](e.message);}).finally(function(){busy[1](false);});}
  function exportResult(){var current=data[0];var runId=selectedRun[0]||(current&&current.run?current.run.runId:undefined);return api('project.export',{sessionId:props.sessionId,runId:runId}).then(function(value){if(!value.ok)throw Error(value.error||'导出失败');downloadArchive(value.filename,value.archive);}).catch(function(e){error[1](e.message);});}
  var status=data[0], run=status&&status.run, checks=(status&&status.checks)||[], counts=(status&&status.counts)||{}, runs=(status&&status.runs)||[];
  var activeRunState=run&&run.state;
  useEffect(function(){
    var active=!!run&&String(run.runId)===String(selectedRun[0])&&String(run.runId)===String(liveRunId);
    if(!active||['preparing','running','waiting'].indexOf(activeRunState)<0||typeof setInterval!=='function')return;
    var timer=setInterval(function(){
      if(typeof document!=='undefined'&&document.visibilityState==='hidden')return;
      load(liveRunId,{background:true});
    },3000);
    return function(){clearInterval(timer);};
  },[props.sessionId,liveRunId,selectedRun[0],activeRunState]);
  if(!status&&error[0])return React.createElement('div',{className:'dsh-chat-project-status',role:'alert'},'读取测试结果失败：'+error[0],React.createElement(Btn,{disabled:busy[0],onClick:retry},'重试'));
  if(!status&&loading[0])return React.createElement('div',{className:'dsh-chat-project-status',role:'status'},'正在读取测试结果…');
  if(!status||!status.configured||!run)return null;
  if(run.sessionId&&String(run.sessionId)!==String(props.sessionId))return React.createElement('div',{className:'dsh-chat-project-status',role:'alert'},'读取到的测试记录不属于当前会话',React.createElement(Btn,{disabled:busy[0],onClick:retry},'重试'));
  var historical=!liveRunId, runMatchesSelection=String(run.runId)===String(selectedRun[0]);
  var selectedIsLive=!!liveRunId&&runMatchesSelection&&String(run.runId)===String(liveRunId);
  var stateLabel=runLabels[run.state]||'状态未知', headline=historical?'上次测试':selectedIsLive?stateLabel:'历史运行 · '+stateLabel;
  var currentCheck=checks.find(function(check){return check.executionState!=='ended';});
  var terminalEmpty=!(counts.total||0)&&['completed','cancelled','failed'].indexOf(run.state)>=0;
  function closeModal(){open[1](false);detail[1](null);}
  function checkDetail(check){
    var result=(check.displayResult||'未得出结论')+(check.confirmationLabel?' · '+check.confirmationLabel:'');
    return ['测试要求\n'+check.requirement,'执行情况\n'+(check.executionLabel||check.displayResult||'未执行'),'结论\n'+result,'结果说明\n'+(check.displayNotes||'无'),check.gaps?'缺口\n'+check.gaps:'','检查 ID：'+check.checkId].filter(Boolean).join('\n\n');
  }
  var columns=selectedIsLive?[30,12,16,34,8]:[30,12,16,42];
  return React.createElement('section',{'aria-label':'项目当前状态',className:'dsh-chat-project-status'},
    terminalEmpty?React.createElement('div',{className:'dsh-chat-project-status-row'},React.createElement('strong',null,headline),
      React.createElement('span',null,'没有保存的检查项'),
      React.createElement(Btn,{disabled:busy[0],onClick:exportResult},'导出结果')):
    React.createElement('div',{className:'dsh-chat-project-status-row'},React.createElement('strong',null,headline),
      React.createElement('span',null,'已执行 '+(counts.executed||0)+'/'+(counts.total||0)),
      React.createElement('span',null,'发现问题 '+(counts.issue||0)),
      counts.blocked?React.createElement('span',null,'缺少条件 '+counts.blocked):null,
      counts.partial?React.createElement('span',null,'部分完成 '+counts.partial):null,
      counts.unverified?React.createElement('span',null,'待核对 '+counts.unverified):null,
      selectedIsLive?(currentCheck?React.createElement('span',{className:'dsh-chat-project-current'},'当前：'+currentCheck.requirement):React.createElement('span',{className:'dsh-chat-project-current'},'当前没有待执行检查')):null,
      React.createElement(Btn,{disabled:busy[0],onClick:function(){detail[1](null);open[1](true);}},'查看检查表'),
      selectedIsLive&&status.manualTakeover&&status.manualTakeover.active?React.createElement(Btn,{disabled:busy[0],onClick:function(){return act('task.takeover-resume');}},'继续测试'):null,
      selectedIsLive&&!(status.manualTakeover&&status.manualTakeover.active)&&status.browserTakeover&&status.browserTakeover.open&&['preparing','running','paused','waiting'].indexOf(run.state)>=0?React.createElement(Btn,{disabled:busy[0],onClick:function(){return act('task.takeover');}},'我来操作'):null,
      selectedIsLive&&(run.state==='running'||run.state==='preparing')?React.createElement(Btn,{disabled:busy[0],onClick:function(){return act('project.pause');}},'暂停'):null,
      selectedIsLive&&!(status.manualTakeover&&status.manualTakeover.active)&&(run.state==='paused'||run.state==='waiting')?React.createElement(Btn,{disabled:busy[0],onClick:function(){return act('project.resume');}},'继续'):null,
      selectedIsLive&&['completed','cancelled','failed'].indexOf(run.state)<0?React.createElement(Btn,{disabled:busy[0],onClick:function(){return act('project.stop');}},'结束本次'):null,
      React.createElement(Btn,{disabled:busy[0],onClick:exportResult},'导出结果')),
    run.blocker&&run.blocker.reason?React.createElement('p',{className:'dsh-chat-project-current'},run.blocker.reason):null,
    runs.length>1?React.createElement('label',{className:'dsh-chat-project-current'},'历史运行 ',
      React.createElement('select',{'aria-label':'项目历史运行',value:selectedRun[0],disabled:busy[0]||loading[0],onChange:function(event){selectedRun[1](event.target.value);load(event.target.value);}},
        runs.map(function(item){return React.createElement('option',{key:item.runId,value:item.runId},(runLabels[item.state]||item.state)+' · '+new Date(item.updatedAt).toLocaleString());}))):null,
    selectedIsLive?React.createElement(ProjectUnknownActions,{sessionId:props.sessionId,run:run,actions:status.unknownActions||[],onSaved:function(){return load(selectedRun[0]||liveRunId,{background:true});}}):null,
    error[0]?React.createElement('div',{role:'alert'},error[0],React.createElement(Btn,{disabled:busy[0],onClick:retry},'重试')):null,
    open[0]?React.createElement('div',{className:'dsh-project-modal-backdrop',onMouseDown:function(event){if(event.target===event.currentTarget)closeModal();}},
      React.createElement('section',{className:'dsh-project-modal',role:'dialog','aria-modal':'true','aria-label':'案例检查表'},
        React.createElement('div',{className:'dsh-project-modal-head'},React.createElement('strong',null,'案例检查表'),React.createElement(Btn,{onClick:closeModal},'关闭检查表')),
        React.createElement('div',{className:'dsh-project-modal-body'},
          checks.length?React.createElement('table',{className:'dsh-project-table'},
            React.createElement('colgroup',null,columns.map(function(width,index){return React.createElement('col',{key:index,style:{width:width+'%'}});})),
            React.createElement('thead',null,React.createElement('tr',null,
              React.createElement('th',null,'测试要求'),
              React.createElement('th',null,'执行情况'),
              React.createElement('th',null,'结论'),
              React.createElement('th',null,'结果说明'),
              selectedIsLive?React.createElement('th',null,'操作'):null)),
            React.createElement('tbody',null,checks.map(function(check){
              var conclusion=(check.displayResult||'未得出结论')+(check.confirmationLabel?' · '+check.confirmationLabel:'');
              return React.createElement('tr',{key:check.checkId},
                React.createElement('td',null,check.requirement),
                React.createElement('td',null,check.executionLabel||check.displayResult||'未执行'),
                React.createElement('td',null,conclusion),
                React.createElement('td',null,
                  React.createElement('div',{className:'dsh-project-note'},checkNotesPreview(check.displayNotes)||'暂无说明'),
                  React.createElement('button',{type:'button',className:'dsh-project-detail-link',onClick:function(){detail[1](check);}},'详情')),
                selectedIsLive?React.createElement('td',null,React.createElement(Btn,{disabled:busy[0],onClick:function(){return act('project.retest',{checkIds:[check.checkId]});}},'仅重测此项')):null);
            }))
          ):React.createElement('p',null,'还没有整理出的检查项。'),
          detail[0]?React.createElement('div',{className:'dsh-project-detail'},
            React.createElement('div',{className:'dsh-project-detail-head'},React.createElement('strong',null,'检查详情'),React.createElement(Btn,{onClick:function(){detail[1](null);}},'关闭详情')),
            React.createElement('pre',{className:'dsh-project-detail-body'},checkDetail(detail[0]))):null))):null);
}
function ProjectUnknownActions(props) {
  var reason=useState(''), outcome=useState('still_unknown'), selected=useState(''), busy=useState(false), error=useState('');
  var actions=props.actions||[];
  if(!actions.length)return null;
  var current=actions.find(function(action){return action.actionId===selected[0];})||actions[0];
  function save(){busy[1](true);error[1]('');return api('project.action-reconcile',{sessionId:props.sessionId,runId:props.run.runId,expectedControlRev:props.run.controlRev,actionId:current.actionId,outcome:outcome[0],reason:reason[0]}).then(function(value){if(!value.ok)throw Error(value.error||'保存失败');reason[1]('');outcome[1]('still_unknown');return props.onSaved();}).catch(function(e){error[1](e.message);}).finally(function(){busy[1](false);});}
  return React.createElement('details',{className:'dsh-task-fold',open:true},React.createElement('summary',null,'有 '+actions.length+' 个操作需要人工核对'),
    React.createElement('p',null,'连接中断，无法确定原操作是否成功。请先在业务系统核对记录；核对前不会继续发送测试请求。'),
    React.createElement('label',{className:'dsh-task-field'},'原操作',React.createElement('select',{'aria-label':'需要核对的原操作',value:current.actionId,disabled:busy[0],onChange:function(e){selected[1](e.target.value);reason[1]('');outcome[1]('still_unknown');}},actions.map(function(action){return React.createElement('option',{key:action.actionId,value:action.actionId},(action.method||'浏览器操作')+' '+(action.targetUrl||action.actionId));}))),
    React.createElement('label',{className:'dsh-task-field'},'核对结果',React.createElement('select',{'aria-label':'核对结果',value:outcome[0],disabled:busy[0],onChange:function(e){outcome[1](e.target.value);}},React.createElement('option',{value:'still_unknown'},'尚不能确定，保持暂停'),React.createElement('option',{value:'occurred'},'已确认原操作成功'),React.createElement('option',{value:'not_occurred'},'已确认原操作未生效'))),
    React.createElement('label',{className:'dsh-task-field'},'核对依据',React.createElement('input',{'aria-label':'核对依据',value:reason[0],maxLength:2000,placeholder:'例如：已在订单列表找到该笔订单和流水号',disabled:busy[0],onChange:function(e){reason[1](e.target.value);}})),
    error[0]?React.createElement('div',{role:'alert'},error[0]):null,
    React.createElement(Btn,{disabled:busy[0]||!reason[0].trim(),onClick:save},'保存核对结果'),React.createElement('small',null,'保存后仍需点击“继续”；已成功的操作不要再次提交。'));
}
function TaskAssetView(props) {
  var rows=useState([]), total=useState(0), next=useState(null), query=useState(''), offset=useState(0), error=useState(''), loading=useState(false), source=useState('task');
  function load(page, requestedSource){
    var cursor=page===undefined?offset[0]:page;
    var activeSource=requestedSource||source[0];
    loading[1](true);error[1]('');
    return api('context.assets',{sessionId:props.sessionId,query:query[0],offset:cursor,limit:30,source:activeSource}).then(function(result){
      if(!result.ok)throw Error(result.error||'读取资产失败');
      rows[1](result.rows||[]);total[1](result.total||0);next[1](result.nextOffset);offset[1](cursor);
    }).catch(function(failure){error[1](failure.message);}).finally(function(){loading[1](false);});
  }
  useEffect(function(){load(0);},[props.sessionId]);
  return React.createElement('section',{'aria-label':'任务资产',style:{display:'flex',flexDirection:'column',gap:'8px'}},
    React.createElement('div',{style:{display:'flex',gap:'8px',alignItems:'center',flexWrap:'wrap'}},
      React.createElement(Btn,{disabled:loading[0]||source[0]==='task',onClick:function(){source[1]('task');return load(0,'task');}},'本任务'),
      React.createElement(Btn,{disabled:loading[0]||source[0]==='workspace',onClick:function(){source[1]('workspace');return load(0,'workspace');}},'工作区账本'),
      React.createElement('input',{'aria-label':'筛选任务资产',placeholder:'筛选域名、IP 或来源',value:query[0],onChange:function(e){query[1](e.target.value);},onKeyDown:function(e){if(e.key==='Enter')load(0);}}),
      React.createElement(Btn,{disabled:loading[0],onClick:function(){return load(0);}},'筛选'),
      React.createElement('span',null,'共 '+total[0]+' 项')),
    error[0]?React.createElement('p',{role:'alert'},error[0]):null,
      loading[0]?React.createElement('p',{role:'status'},'正在读取…'):rows[0].length?React.createElement('div',{role:'table'},
      rows[0].map(function(row){return React.createElement('div',{key:row.id,role:'row',style:{display:'grid',gridTemplateColumns:'minmax(0,1fr) auto',gap:'8px',padding:'6px 0',borderBottom:'1px solid color-mix(in srgb,currentColor 10%,transparent)'}},
        React.createElement('span',{style:{overflowWrap:'anywhere'}},row.url||row.host||row.ip||row.id),
        React.createElement('span',null,(row.inScope?'范围内':'范围外')+(row.reachable?' · 已验证可达':'')));})):React.createElement('p',null,source[0]==='task'?'当前任务还没有保存资产。':'工作区账本还没有资产。'),
    React.createElement('div',{style:{display:'flex',gap:'8px'}},
      React.createElement(Btn,{disabled:loading[0]||offset[0]===0,onClick:function(){return load(Math.max(0,offset[0]-30));}},'上一页'),
      React.createElement(Btn,{disabled:loading[0]||next[0]===null,onClick:function(){return load(next[0]);}},'下一页')));
}
function TaskPanel(props) {
  var status=useState(null), error=useState(''), busy=useState(false);
  var projectMode=props.scenario==='project'||props.scenario==='cases';
  var records=useState({rows:[],stats:null,loading:true,error:''}), request=useRef(0);
  var selected=useState('regular'), question=useState(''), target=useState(''), ownCalls=useState(''), ownModelCalls=useState(''), ownTokens=useState(''), ownMinutes=useState(''), workers=useState('2'), ownUnmetered=useState(''), resolution=useState('');
  var questionValue=props.questionDraft?props.questionDraft.value:question[0];
  function setQuestion(value){return props.questionDraft?props.questionDraft.set(value):question[1](value);}
  var assetView=useState(false);
  var extraMinutes=useState(''), newToolLimit=useState('');
  // 预算字段可以由设置抽屉托管（受控）；没传就用本组件自己的 state（任务页单独使用时）。
  var budgetDraft=props.budgetDraft;
  function budgetPair(key){
    if(budgetDraft)return [budgetDraft.value[key],function(value){var patch={};patch[key]=value;budgetDraft.set(patch);}];
    var setters={calls:ownCalls,modelCalls:ownModelCalls,tokens:ownTokens,minutes:ownMinutes,unmetered:ownUnmetered};
    return [setters[key][0],setters[key][1]];
  }
  var flow=useState('single'), interaction=useState('auto');
  function load(){var revision=++request.current;return api('task.status',{sessionId:props.sessionId}).then(function(value){if(!value.ok)throw Error(value.error||'读取任务失败');if(revision!==request.current)return;error[1]('');status[1](value);if(!value.configured){if(value.choice)selected[1](value.choice);if(value.options){flow[1](value.options.workflow);var nextWorkers=Number(value.options.workers);if(value.hostWorkerLimit&&nextWorkers>value.hostWorkerLimit)nextWorkers=value.hostWorkerLimit;workers[1](String(nextWorkers));interaction[1](value.options.interaction||'continuous');}}if(value.configured&&value.isPentest)return api('findings.list',{sessionId:props.sessionId,scope:'session',mode:'pentest',page:1,pageSize:5}).then(function(value){if(revision!==request.current)return;if(value.ok===false)throw Error(value.error||'读取最近记录失败');records[1]({rows:value.list?.rows||[],stats:value.stats||null,loading:false,error:''});}).catch(function(failure){if(revision===request.current)records[1]({rows:[],stats:null,loading:false,error:failure.message||String(failure)});});}).catch(function(e){if(revision===request.current)error[1](e.message);});}
  useEffect(function(){var active=true;status[1](null);error[1]('');records[1]({rows:[],stats:null,loading:true,error:''});load();var timer=setInterval(function(){if(active)load();},5000);return function(){active=false;request.current++;clearInterval(timer);};},[props.sessionId,props.blank]);
  function run(endpoint,payload){busy[1](true);error[1]('');return api(endpoint,Object.assign({sessionId:props.sessionId},payload||{})).then(function(value){if(!value.ok)throw Error(value.error||'操作失败');if(['task.choose','task.settings','task.interaction','task.workers','task.explain','task.limits','task.mode','task.budget'].includes(endpoint)){return load().then(function(){return value;});}status[1](value);return value;}).catch(function(e){error[1](e.message);}).finally(function(){busy[1](false);});}
  function choose(mode){selected[1](mode);flow[1]('single');return run('task.choose',{mode:mode,workflow:'single',workers:Number(workers[0]),interaction:interaction[0],startMode:'direct-test'});}
  function start(){var callsValue=String(budgetPair('calls')[0]||'').trim(),modelCallsValue=String(budgetPair('modelCalls')[0]||'').trim(),tokensValue=String(budgetPair('tokens')[0]||'').trim(),minutesValue=String(budgetPair('minutes')[0]||'').trim(),unmeteredValue=String(budgetPair('unmetered')[0]||'').trim();var budget={workers:Number(workers[0])};if(callsValue)budget.toolCalls=Number(callsValue);if(unmeteredValue)budget.unmeteredToolCalls=Number(unmeteredValue);if(modelCallsValue)budget.modelCalls=Number(modelCallsValue);if(tokensValue)budget.tokens=Number(tokensValue);if(minutesValue)budget.minutes=Number(minutesValue);var policy={workflow:'single',interaction:interaction[0],question:questionValue.trim(),budget:budget};var targetText=props.targetState?String(props.targetState[0]||''):target[0];if(targetText.trim())policy.target=targetText.trim();if(projectMode){busy[1](true);error[1]('');return api('project.start',{sessionId:props.sessionId,policy:policy}).then(function(value){if(!value.ok)throw Error(value.error||'开始案例测试失败');setQuestion('');return load();}).catch(function(failure){error[1](failure.message);}).finally(function(){busy[1](false);});}policy.mode=selected[0];return run('task.choose',{mode:selected[0],workflow:flow[0],workers:budget.workers,interaction:interaction[0],startMode:'direct-test'}).then(function(value){if(value)return run('task.start',{policy:policy}).then(function(started){if(started)setQuestion('');return started;});});}
  var current=status[0], labels={regular:'常规测试',nday:'Nday发现','0day':'0Day挖掘'}, workerLabels={starting:'正在启动',running:'正在工作',closing:'正在关闭','cleanup-failed':'关闭失败',released:'已释放'};
  var reasons={interaction_confirmation_required:'等待你确认是否继续',cancelled:'你已停止测试',turn_ended:'本轮已结束；直接发送新的要求即可继续同一任务',time_budget_exhausted:'已到设置的停止时间',tool_budget_exhausted:current?.policy?.used.toolCalls+' 次操作已用完',first_verified_high:'已确认一个高危漏洞',first_verified_rce:'已确认代码执行漏洞',queue_complete:'已检查所有候选漏洞',plan_complete:'已完成这次测试',observation_budget_exhausted:'初步检查次数已用完',model_budget_exhausted:'模型调用次数已用完'};
  var nextActions={interpret:'先解读已记录的对照差异','interpret-recorded-comparison':'先解读已记录的对照差异','record-observation-or-close':'记录观察或结束这个方向','independently-verify-impact':'独立验证影响','minimal-check-with-control':'带正常对照做最小检查','create-direction-on-observed-input':'用已观测的输入建立新方向','collect-new-entry-or-record-gap':'补充入口或记录缺项'};
  var hasTarget=Boolean(current?.policy?.target);
  var next=current?.next||null, counts=current?.counts||{};
  var briefEndpoint=next?.endpoint||next?.requests?.[0]?.endpoint||current?.gaps?.[0]?.endpoint||'';
  var briefIdentity=next?.authContext||next?.requests?.[0]?.authContext||'';
  var briefAction=nextActions[next?.action]||'';
  var stats=records[0].stats, pending=stats?.delivery?Math.max(0,stats.delivery.incomplete-(stats.byStatus?.['false-positive']||0)-(stats.byStatus?.fixed||0)):null;
  var taskQuestion=current?.policy?.question;
  if(taskQuestion==='有限观察已有目标，向用户建议具体研究问题')taskQuestion='';
  function input(label,state,type){return React.createElement('label',{className:'dsh-task-field'},React.createElement('span',null,label),React.createElement('input',{'aria-label':label,type:type||'text',value:state[0],onChange:function(e){state[1](e.target.value);},style:{width:type==='number'?76:'100%'}}));}
  if(current&&current.configured&&current.policy&&current.policy.scenario==='project')return React.createElement('div',{className:'dsh-task-project-settings'},React.createElement('p',null,'项目目标和来源已固定。检查结果、历史和导出入口在对话上方的项目状态行。'));
  return React.createElement('section',{'aria-label':'本轮测试任务',className:'dsh-task-panel'},
    React.createElement('div',{className:'dsh-task-heading'},React.createElement('h3',null,current&&current.configured?(current.idle?'本轮已结束':current.stopped?'测试已停止':'正在测试'):'新建测试'),React.createElement(Btn,{disabled:busy[0],onClick:load},'刷新状态')),error[0]?React.createElement('div',{role:'alert'},error[0]):null,
    current&&current.configured?React.createElement('div',null,
      React.createElement('article',{className:'dsh-task-summary','aria-label':'当前任务'},
        React.createElement('div',{className:'dsh-task-state-line'},React.createElement('span',{className:'dsh-task-mode'},labels[current.policy.mode]),(current.stopped||current.idle)?React.createElement('span',{className:'dsh-task-stop-reason'},reasons[current.reason]||'测试已暂停'):null),
        React.createElement('p',{className:'dsh-task-scope-summary'},'范围：'+taskScopeDisplay(current.scope,current.policy.target)
          +' · 重点：'+(labels[current.policy.mode]||current.policy.mode||'按任务判断')
          +' · 资产 '+(counts.assets||0)+' · 已发请求/回执 '+(counts.receipts||0)+' · 并行任务 '+(counts.runningWorkers||0)+' · 待你处理 '+(counts.needsUser||0)),
        React.createElement('div',{className:'dsh-task-summary-actions'},React.createElement(Btn,{onClick:function(){assetView[1](!assetView[0]);}},'查看资产')),
        current.pendingChange?React.createElement('div',{role:'status',className:'dsh-task-pending-change'},
          React.createElement('strong',null,'待确认的任务变更'),
          React.createElement('p',null,current.pendingChange.summary||current.pendingChange.fields.join('、')),
          React.createElement(Btn,{primary:true,disabled:busy[0],onClick:function(){return run('task.pending-apply').then(function(){return load();});}},'确认变更'),
          React.createElement(Btn,{disabled:busy[0],onClick:function(){return run('task.pending-cancel').then(function(){return load();});}},'取消')):null,
        assetView[0]?React.createElement(TaskAssetView,{sessionId:props.sessionId}):null,
        React.createElement('div',{className:'dsh-task-result','aria-label':'本会话测试结果'},hasTarget&&stats?.delivery?React.createElement(React.Fragment,null,React.createElement('span',null,React.createElement('strong',null,stats.delivery.ready),' 个已确认'),React.createElement('span',{className:pending?'dsh-task-pending':''},React.createElement('strong',null,pending),' 个待验证')):React.createElement('span',null,records[0].error?'结果读取失败':records[0].loading?'正在读取结果…':hasTarget?'暂无结果统计':'尚未指定目标，先在授权范围内给一个入口、请求或身份')),
        taskQuestion?React.createElement('p',null,'测试内容：'+taskQuestion):null,
        current.policy.target?React.createElement('details',{className:'dsh-task-full-scope'},React.createElement('summary',null,
          '完整范围（'+(current.scope?.includeCount||current.policy.target.split(/\r?\n/).length)+' 项）'),
          React.createElement('pre',{style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:240,overflow:'auto',margin:'8px 0 0'}},current.policy.target)):React.createElement('p',null,'目标：尚未指定'),
        React.createElement('div',{className:'dsh-task-brief','aria-label':'进度要点'},
          React.createElement('span',null,'入口：'+(briefEndpoint||'尚未记录')),
          React.createElement('span',null,'身份：'+(briefIdentity||'尚未记录')),
          React.createElement('span',null,'下一步：'+(briefAction||'等待已有材料')),
      React.createElement('span',null,'依据：资产 '+(counts.assets||0)+' · 请求 '+(counts.requests||0)+' · 测试流程 '+(counts.methods||0)+' · 检查记录 '+(counts.checks||0))),
        (next&&next.requests||[]).length?React.createElement('details',{className:'dsh-task-entries','aria-label':'可测入口'},
          React.createElement('summary',null,'可测入口（'+next.requests.length+'，另有 '+(next.moreRequests||0)+' 条）'),
          next.requests.map(function(row){return React.createElement('p',{key:row.requestId+'|'+row.requestRevision},
            (row.endpoint||'未记录地址')+' · 身份 '+(row.authContext||'未记录')+' · 输入 '+((row.inputs||[]).map(function(field){return field.name;}).join('、')||'未记录')+' · 证据 '+row.requestId+'@'+row.requestRevision);})):null,
        (current.gaps||[]).length?React.createElement('details',{className:'dsh-task-gaps'},React.createElement('summary',null,'缺项（'+current.gaps.length+'）'),
          current.gaps.map(function(gap){return React.createElement('p',{key:gap.id+'|'+gap.endpoint},gap.endpoint+' · '+gap.missing.join('、'));})):null),
      current.policy.flow&&current.policy.flow.kind!=='single'?React.createElement('div',{'aria-label':'流程进度'},React.createElement('p',null,({'regular-to-nday':'收集后自动接 Nday','regular-with-nday':'常规与 Nday 同时进行'}[current.policy.flow.kind])+' · 当前：'+({regular:'信息收集',nday:'Nday检查',parallel:'共同推进',done:'已完成'}[current.policy.flow.phase])),React.createElement('p',null,'常规：'+(current.policy.flow.completed.regular?'已完成':'进行中')+' · Nday：'+(current.policy.flow.completed.nday?'已完成':current.policy.flow.phase==='regular'?'等待收集':'进行中')),React.createElement('details',null,React.createElement('summary',null,'查看衔接记录'),current.policy.flow.history.map(function(row,i){return React.createElement('p',{key:i},new Date(row.at).toLocaleString()+' · '+row.note);}))) :null,
      current.policy.modelBudgetBlock?React.createElement('p',{role:'alert'},current.policy.modelBudgetBlock.message+(current.policy.modelBudgetBlock.priorWireAttempts>0?' 此前已有 '+current.policy.modelBudgetBlock.priorWireAttempts+' 次原生发送。':'')+' 保留已有资料后，可为下一轮设置新额度。'):null,
      React.createElement('details',{'aria-label':'调整本任务剩余额度'},
        React.createElement('summary',null,'调整剩余额度（用户操作，保留已用量）'),
        React.createElement('div',{className:'dsh-limit-row'},
          React.createElement('label',null,'增加时间（分钟）',React.createElement('input',{'aria-label':'增加任务时间分钟',type:'number',min:1,max:10080,value:extraMinutes[0],onChange:function(e){extraMinutes[1](e.target.value);}})),
          React.createElement('label',null,'工具调用总上限',React.createElement('input',{'aria-label':'工具调用总上限',type:'number',min:1,max:100000,value:newToolLimit[0],placeholder:current.policy.budget.toolCalls??'未设置',onChange:function(e){newToolLimit[1](e.target.value);}}))),
        React.createElement(Btn,{disabled:busy[0]||(!extraMinutes[0]&&!newToolLimit[0]),onClick:function(){var payload={};if(extraMinutes[0])payload.extendMinutes=Number(extraMinutes[0]);if(newToolLimit[0])payload.toolCalls=Number(newToolLimit[0]);return run('task.budget',payload).then(function(){extraMinutes[1]('');newToolLimit[1]('');return load();});}},'应用额度调整'),
        React.createElement('small',null,'提高额度不会清零已用量；累计事件仍保留。')),
      current.policy.awaitingConfirmation?React.createElement('div',null,React.createElement('p',null,current.policy.awaitingConfirmation.note),React.createElement(Btn,{primary:true,disabled:busy[0]||current.reason!=='interaction_confirmation_required',onClick:function(){return run('task.continue');}},'确认并继续')):null,
      React.createElement('div',{className:'dsh-task-metrics'},
        React.createElement('span',null,'已用操作 '+current.policy.used.toolCalls+(current.policy.budget.toolCalls===null?' · 未设上限':' / '+current.policy.budget.toolCalls)),
        current.policy.budget.unmeteredToolCalls!==null?React.createElement('span',null,'未计量通道 '+(current.policy.used.unmeteredToolCalls||0)+' / '+current.policy.budget.unmeteredToolCalls+'（实际请求数未知）'):React.createElement('span',null,'未计量通道 '+(current.policy.used.unmeteredToolCalls||0)+' · 未设额外上限'),
        React.createElement('span',null,'运行中的子代理 ',current.active||0),
        current.roundCost?.elapsedModelMs!=null?React.createElement('span',null,'模型运行 ',Math.ceil(current.roundCost.elapsedModelMs/1000)+' 秒'):null),
      React.createElement('section',{className:'dsh-task-recent','aria-label':'最近发现'},React.createElement('div',{className:'dsh-task-heading'},React.createElement('h4',null,'最近发现'),React.createElement(Btn,{onClick:props.onFindings},'全部记录')),
        records[0].error?React.createElement('p',{role:'alert'},records[0].error):records[0].loading?React.createElement('p',{role:'status'},'正在读取发现…'):records[0].rows.length?records[0].rows.map(function(f){return React.createElement('details',{key:f.id,className:'dsh-task-recent-row'},React.createElement('summary',null,React.createElement('span',{className:'dsh-task-finding-title'},f.title),React.createElement('span',{className:'dsh-rtr-st dsh-rtr-st-'+(f.delivery?.ready?'verified':f.status==='verified'?'pending':f.status)},statusTextFor(f,'pentest',STATUS_LABEL)),React.createElement('span',{className:'dsh-task-finding-target'},f.target||'地址未记录'),React.createElement('span',{className:'dsh-task-finding-note'},findingSummary(f))),React.createElement(Detail,{f:Object.assign({},f,{sessionId:props.sessionId}),mode:'pentest',sessionId:props.sessionId,meta:MODE_META.pentest,onEffectReview:load}));}):React.createElement('p',null,'还没有发现记录。')),
      React.createElement('details',{'aria-label':'运行用量与预算明细'},React.createElement('summary',null,'运行用量与预算明细'),
      current.modelBudget&&current.modelBudget.limits.modelCalls!==null?React.createElement('p',null,'共享模型调用 '+current.modelBudget.chargedCalls+'/'+current.modelBudget.limits.modelCalls+'；剩余 '+Math.max(0,current.modelBudget.limits.modelCalls-current.modelBudget.chargedCalls)+' 次。包含主代理、子代理和辅助调用。'):null,
      React.createElement('p',null,'从开始测试经过 '+Math.floor((current.elapsedSeconds||0)/60)+' 分 '+((current.elapsedSeconds||0)%60)+' 秒（含停止后的时间）。'),
      current.roundCost?React.createElement('p',null,'本轮会话生成记录 '+current.roundCost.modelCalls+'（含准入被拒绝的回合） · 工具调用 '+current.roundCost.toolCalls+' · 会话 token '+(current.roundCost.totalTokens===null?'未取得':current.roundCost.totalTokens)+'（含缓存读取 '+(current.roundCost.cacheReadTokens===null?'未知':current.roundCost.cacheReadTokens)+'）'):null,
      current.modelBudget?React.createElement('p',null,'已登记模型调用 '+current.modelBudget.chargedCalls+'/'+(current.modelBudget.limits.modelCalls??'未设上限')+'（含重试、压缩和标题）；已观测原生发送 '+current.modelBudget.wireAttempts+' 次，未观测 '+current.modelBudget.unobservedCalls+' 次。已取得 token '+current.modelBudget.knownTokens+'，未知 '+current.modelBudget.unknownCalls+'，尚未结算 '+current.modelBudget.unresolvedCalls+'。'+(current.modelBudget.limits.tokens!==null?'严格 token 上限 '+current.modelBudget.limits.tokens+'；预留 '+current.modelBudget.heldTokens+'。':'')):null,
      current.roundCost?React.createElement('p',null,'用量口径：会话事件调用 '+current.roundCost.modelCalls+'（其中尝试 '+current.roundCost.attemptCalls+'、辅助 '+(current.roundCost.auxiliaryCalls===null?'未分类':current.roundCost.auxiliaryCalls)+'），准入记账 '+(current.modelBudget?current.modelBudget.chargedCalls:'未取得')+'；未知用量 '+(current.roundCost.unknownUsageCalls||0)+'，缓存读取 '+(current.roundCost.cacheReadTokens===null?'未取得':current.roundCost.cacheReadTokens)+'。两组口径不互相补齐，差额保留为未解释记录。'):null,
      current.modelBudget&&current.modelBudget.calls.length?React.createElement('details',{'aria-label':'模型发送明细'},
        React.createElement('summary',null,'模型发送明细（最近 '+current.modelBudget.calls.length+' 次）'),
        React.createElement('p',null,'只覆盖原生 fetch 的 Messages、Chat Completions 和 Responses；SDK 私有传输不会在这里冒充已观测发送。'),
        current.modelBudget.calls.map(function(row){return React.createElement('p',{key:row.id},modelCallPurposeLabel(row.purpose)+' · '+modelCallStateLabel(row.state)+' · '+modelWireLabel(row.wire))})):null,
      current.roundCost?React.createElement('p',null,'本轮模型运行含收尾 '+(current.roundCost.elapsedModelMs===null?'未取得':Math.ceil(current.roundCost.elapsedModelMs/1000)+' 秒')+'；父子代理并发时间合并计算。'):null,
      current.cost?React.createElement('details',null,React.createElement('summary',null,'主代理与全部子代理累计成本'),
        React.createElement('p',null,'总 token '+(current.cost.totalTokens===null?'未取得':current.cost.totalTokens)+' · 模型调用 '+current.cost.modelCalls+' · 工具调用 '+current.cost.toolCalls),
        current.cost.sessions.map(function(row){return React.createElement('p',{key:row.sessionId},(row.role==='main'?'主代理':row.role==='knowledge-curation'?'知识整理（独立费用）':'子代理')+' '+row.sessionId+'：token '+(row.totalTokens===null?'未取得':row.totalTokens)+'，缓存读取 '+(row.cacheReadTokens===null?'未知':row.cacheReadTokens)+'，工具调用 '+row.toolCalls);}),
        React.createElement('p',null,'缺少用量的模型调用 '+current.cost.unknownUsageCalls+'；无法读取的会话 '+current.cost.unavailableSessions+'。不含后台标题生成，不估算金额。')):null),
      current.policy.blocker?React.createElement('div',{role:'alert'},React.createElement('p',null,current.policy.blocker.reason),React.createElement('p',null,'证据：'+current.policy.blocker.evidence),input('访问恢复情况',resolution),React.createElement(Btn,{disabled:busy[0]||!resolution[0].trim(),onClick:function(){return run('task.resume',{note:resolution[0]});}},'已处理阻碍，先复查正常访问')):null,
      (current.workers||[]).length?React.createElement('details',null,React.createElement('summary',null,'查看子代理任务（'+(current.workers||[]).length+'）'),
      (current.workers||[]).map(function(worker){var workerKind=worker.assistPurpose?({review:'独立复核',verify:'独立验证',analyze:'独立分析',investigate:'独立调查'}[worker.assistPurpose]||'独立工作'):(labels[worker.focus]||'站点研究');return React.createElement('details',{key:worker.childId},React.createElement('summary',null,(worker.question||worker.site)+' · '+workerKind+' · '+(workerLabels[worker.state]||worker.state)),React.createElement('p',null,worker.question),worker.report?React.createElement('p',null,worker.report.summary):null,worker.error?React.createElement('p',{role:'alert'},worker.error):null,React.createElement(WorkerFindings,{sessionId:props.sessionId,childId:worker.childId}),worker.state!=='released'?React.createElement(Btn,{disabled:busy[0],onClick:function(){return run('task.cleanup',{childId:worker.childId});}},'保存已有记录并关闭'):null);}),
      current.more?React.createElement('p',null,'另有 '+current.more+' 条历史子任务；详细证据保留在原会话'):null):null,
      (current.stopped||current.idle)&&!current.policy.awaitingConfirmation?(current.policy.blocker?null:React.createElement(React.Fragment,null,
        current.reason==='turn_ended'&&current.stopped?React.createElement(Btn,{primary:true,disabled:busy[0]||(current.active||0)>0,onClick:function(){return run('task.continue-current').then(load);}},'继续当前任务'):null,
        React.createElement(Btn,{primary:current.reason!=='turn_ended',disabled:busy[0]||(current.active||0)>0,onClick:function(){setQuestion('');return run('task.new-round');}},'新建测试'))):React.createElement(Btn,{disabled:busy[0],onClick:function(){return run('task.cancel');}},'停止本轮与子代理')):
    !current?React.createElement('p',{role:'status'},error[0]?'请刷新重试。':'正在读取本轮任务…'):!current.isPentest?React.createElement('p',null,'此会话没有渗透测试任务，可在“发现”中查看审计记录。',React.createElement(Btn,{onClick:props.onFindings},'查看发现')):React.createElement('div',null,
      // 抽屉已经托管方向、测试安排和助手人数时，任务面板不再重复第二套控件。
      projectMode?React.createElement('p',{role:'status'},'案例测试会读取已添加的 Word、Excel 或文本，按原文整理检查项并连续执行。'):
        budgetDraft?null:React.createElement('div',{className:'dsh-task-mode-options',role:'group','aria-label':'选择子模式'},['regular','nday','0day'].map(function(mode){return React.createElement(Btn,{key:mode,primary:selected[0]===mode,disabled:busy[0],onClick:function(){return choose(mode);}},labels[mode]);})),
      projectMode?null:budgetDraft?null:React.createElement('p',null,selected[0]==='regular'?'检查登录、权限和业务功能。':selected[0]==='nday'?'根据产品及版本，查找并验证已公开漏洞。':'分析代码和业务逻辑，查找并验证可疑问题。'),
      current&&current.previousRounds?React.createElement('p',null,'已保留 '+current.previousRounds+' 次测试的记录。'):null,
      budgetDraft?null:React.createElement(FlowControls,{mode:selected[0],workflow:'single',workers:Number(workers[0]),interaction:interaction[0],disabled:busy[0],onChange:function(patch){return run('task.choose',{mode:selected[0],workflow:'single',workers:patch.workers!==undefined?patch.workers:Number(workers[0]),interaction:patch.interaction||interaction[0],startMode:'direct-test'}).then(function(value){if(value&&value.options){flow[1]('single');workers[1](String(value.options.workers));interaction[1](value.options.interaction||'continuous');}});}}),
      React.createElement('label',{className:'dsh-task-field'},React.createElement('span',null,'用户要求、范围或已有材料'),
        React.createElement('textarea',{'aria-label':'用户要求、范围或已有材料',rows:3,value:questionValue,onChange:function(e){setQuestion(e.target.value);},style:{width:'100%'}})),
      budgetDraft?null:React.createElement('details',null,React.createElement('summary',null,'限制请求和用量'),
        React.createElement('small',null,'留空表示未设置，实际沿用宿主当前限制；未设置时不额外收紧。'),
        input('操作预算',budgetPair('calls'),'number'),input('模型调用上限（可选，含子代理和辅助调用）',budgetPair('modelCalls'),'number'),
        input('模型 token 上限（可选，含子代理和辅助调用）',budgetPair('tokens'),'number'),
        input('时间上限（分钟）',budgetPair('minutes'),'number'),input('未计量通道上限（可选，一次工具调用不等于一个目标请求）',budgetPair('unmetered'),'number')),
      React.createElement(Btn,{primary:true,disabled:busy[0]||!questionValue.trim(),onClick:start},projectMode?'开始案例测试':'开始测试')));
}

function ContextPanel(props) {
  var text = useState(''), error = useState(''), kind = useState('request'), id = useState(''), version = useState(''), offset = useState(0);
  function read(detail) {
    error[1]('');
    var payload = detail ? { sessionId: props.sessionId, kind: kind[0], id: id[0], version: version[0] || undefined } : { sessionId: props.sessionId, offset: offset[0] };
    return api(detail ? 'context.detail' : 'context.index', payload).then(function (result) {
      if (!result.ok) throw new Error(result.error || '读取共享记录失败');
      text[1](result.text);
    }).catch(function (failure) { error[1](failure.message || String(failure)); });
  }
  return React.createElement('details', { style: { padding: 16 }, 'aria-label': '共享资产与请求记录' },
    React.createElement('summary', null, '共享资产、请求与测试流程'),
    React.createElement('p', null, '查看本会话已有记录，按入口、身份和版本复用。'),
    React.createElement('label', null, '索引偏移 ', React.createElement('input', { type: 'number', min: 0, max: 2000, value: offset[0], onChange: function (event) { offset[1](Number(event.target.value)); } })),
    React.createElement(Btn, { onClick: function () { return read(false); } }, '读取索引'),
    React.createElement('select', { 'aria-label': '记录类型', value: kind[0], onChange: function (event) { kind[1](event.target.value); } },
    ['asset', 'request', 'method'].map(function (item) { return React.createElement('option', { key: item, value: item }, { asset: '资产', request: '请求', method: '测试流程' }[item]); })),
    React.createElement('input', { 'aria-label': '记录ID', value: id[0], onChange: function (event) { id[1](event.target.value); } }),
    React.createElement('input', { 'aria-label': '请求或测试流程版本', value: version[0], onChange: function (event) { version[1](event.target.value); } }),
    React.createElement(Btn, { onClick: function () { return read(true); } }, '读取详情'),
    error[0] ? React.createElement('div', { role: 'alert' }, error[0]) : null,
    text[0] ? React.createElement('pre', { style: { whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: 360 } }, text[0]) : null);
}

function ResearchPanel(props) {
  var index = useState(null), selected = useState(null), error = useState(''), busy = useState(false), offset = useState(0);
  function run(endpoint, payload) {
    busy[1](true); error[1]('');
    return api(endpoint, Object.assign({ sessionId: props.sessionId }, payload)).then(function (result) {
      if (!result.ok) throw new Error(result.error || '读取研究记录失败');
      return result;
    }).catch(function (failure) { error[1](failure.message || String(failure)); return null; }).finally(function () { busy[1](false); });
  }
  function load(next) { return run('research.index', { offset: next }).then(function (result) { if (result) { offset[1](next); index[1](result); } }); }
  function detail(id) { return run('research.detail', { id: id }).then(function (result) { if (result) selected[1](result); }); }
  var labels = { active: '研究中', stopped: '已停止', restricted: '受限／未覆盖', refuted: '出现反证', supported: '重复观察支持', blocked: '基线失效' };
  var classes = { 'known-vulnerability': '已知漏洞', 'new-variant': '新变体', 'suspected-unpublished': '疑似未公开', 'unconfirmed-anomaly': '未证实异常' };
  var reasons = { no_new_information: '连续没有新信息，已停止这个方向', hypothesis_budget_exhausted: '本假设的尝试次数已用完',
    falsifier_observed: '观察到反证，已结束这个方向', repeat_with_normal_control: '已保存两次带正常对照的支持观察' };
  var row = selected[0];
  return React.createElement('details', { style: { padding: 16 }, 'aria-label': '研究假设记录' },
    React.createElement('summary', null, '研究假设'),
    React.createElement(Btn, { disabled: busy[0], onClick: function () { return load(offset[0]); } }, '读取研究记录'),
    index[0] ? React.createElement('div', null,
      index[0].items.length ? index[0].items.map(function (item) { return React.createElement('div', { key: item.id, style: { display: 'flex', gap: 12, padding: '8px 0' } },
        React.createElement('span', { style: { flex: 1 } }, item.title + ' · ' + labels[item.state] + ' · ' + item.attempts + '/' + item.maxAttempts),
        React.createElement(Btn, { disabled: busy[0], onClick: function () { return detail(item.id); } }, '查看假设')); }) : React.createElement('p', null, '尚无研究记录'),
      React.createElement(Btn, { disabled: busy[0] || offset[0] === 0, onClick: function () { return load(Math.max(0, offset[0] - 20)); } }, '上一页'),
      React.createElement(Btn, { disabled: busy[0] || offset[0] + 20 >= index[0].total, onClick: function () { return load(offset[0] + 20); } }, '下一页')) : null,
    row ? React.createElement('div', null,
      React.createElement('h4', null, row.title),
      React.createElement('p', null, row.binding.endpoint + ' · ' + row.binding.authContext + ' · ' + row.binding.requestRevision),
      row.restriction ? React.createElement('p', null, '受限／未覆盖 · ' + row.restriction.code + ' · ' + (row.restriction.coverage === 'partial' ? '仅有部分观察' : '尚未执行') + '；结论未知。中断原因：' + row.reason) : null,
      React.createElement('p', null, classes[row.classification] + '；仍须独立核对影响与复现，缺少CVE不证明首次发现。'),
      [['serverPath', '处理路径'], ['boundary', '边界'], ['normalBehavior', '正常行为'], ['supportCriterion', '支持判据'], ['falsifier', '反证'], ['nextInformation', '下一步信息']].map(function (item) { return React.createElement('p', { key: item[0] }, item[1] + '：' + row[item[0]]); }),
      React.createElement('p', null, row.blockedReason ? '当前基线失效，请核对入口、身份和请求版本' : reasons[row.reason] || row.reason),
      React.createElement('details', null, React.createElement('summary', null, '正常对照、观察与公开解释'), React.createElement('pre', { style: { whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: 360 } }, JSON.stringify({ knownCheck: row.knownCheck, observations: row.observations }, null, 2)))) : null,
    error[0] ? React.createElement('div', { role: 'alert' }, error[0]) : null);
}

// 测试结果的主视图：用户先看到“正在验证什么”，而不是一串执行流水。
// 数据来自现有 research_hypotheses；每条绑定已存请求/身份，未确认前不当作漏洞。
function ResearchView(props) {
  var index = useState(null), selected = useState(null), error = useState(''), busy = useState(false), offset = useState(0);
  var results = useState(null), resultsError = useState('');
  var request = useRef(0), resultsRequest = useRef(0);
  var stateLabels = { active: '正在验证', stopped: '已停止', restricted: '缺条件/未覆盖', refuted: '出现反证', supported: '重复观察支持', blocked: '基线已失效' };
  var classLabels = { 'known-vulnerability': '已知漏洞', 'new-variant': '新变体', 'suspected-unpublished': '疑似未公开', 'unconfirmed-anomaly': '未证实异常' };
  var stopReasons = { no_new_information: '连续没有新信息，已停止这个方向', hypothesis_budget_exhausted: '本问题的尝试次数已用完',
    falsifier_observed: '观察到反证，已结束这个方向', repeat_with_normal_control: '已保存两次带正常对照的支持观察' };
  function load(next) {
    var revision = ++request.current;
    busy[1](true); error[1]('');
    return api('research.index', { sessionId: props.sessionId, offset: next }).then(function (result) {
      if (revision !== request.current) return;
      if (!result.ok) throw Error(result.error || '读取正在验证的问题失败');
      index[1](result); offset[1](next); selected[1](null);
    }).catch(function (failure) {
      if (revision === request.current) error[1](failure.message || String(failure));
    }).finally(function () { if (revision === request.current) busy[1](false); });
  }
  function detail(id) {
    var revision = ++request.current;
    busy[1](true); error[1]('');
    return api('research.detail', { sessionId: props.sessionId, id: id }).then(function (result) {
      if (revision !== request.current) return;
      if (!result.ok) throw Error(result.error || '读取问题详情失败');
      selected[1](result);
    }).catch(function (failure) {
      if (revision === request.current) error[1](failure.message || String(failure));
    }).finally(function () { if (revision === request.current) busy[1](false); });
  }
  function loadResults() {
    var revision = ++resultsRequest.current;
    return api('findings.list', { sessionId: props.sessionId, scope: 'session', mode: 'pentest', page: 1, pageSize: 5 }).then(function (result) {
      if (revision !== resultsRequest.current) return;
      if (result.ok === false) throw Error(result.error || '读取结果失败');
      results[1]({ rows: result.list && result.list.rows || [], stats: result.stats || null });
      resultsError[1]('');
    }).catch(function (failure) {
      if (revision === resultsRequest.current) resultsError[1](failure.message || String(failure));
    });
  }
  useEffect(function () {
    load(0);
    loadResults();
    return function () { request.current++; resultsRequest.current++; };
  }, [props.sessionId]);
  var current = index[0], row = selected[0];
  return React.createElement('div', { className: 'dsh-research-view', 'aria-label': '正在验证的问题' },
    React.createElement('div', { className: 'dsh-research-head' },
      React.createElement('div', null,
        React.createElement('strong', null, '正在验证的问题'),
        React.createElement('p', null, '每条问题都绑定已存请求和身份；未确认前不会当成漏洞。')),
      React.createElement(Btn, { disabled: busy[0], onClick: function () { return load(offset[0]); } }, '刷新')),
    error[0] ? React.createElement('p', { role: 'alert' }, error[0]) : null,
    resultsError[0] ? React.createElement('p', { role: 'alert' }, '结果读取失败：' + resultsError[0]) : null,
    !current ? React.createElement('p', { role: 'status' }, error[0] ? '读取失败，可重试。' : '正在读取问题…')
      : !current.total ? React.createElement('div', { className: 'dsh-research-empty' },
        React.createElement('p', null, '还没有具体问题。给目标和已有请求后，Saker 会把方向拆成可验证的问题；这里会显示每条问题绑定的请求、身份、正常对照和下一步。'),
        React.createElement(Btn, { onClick: function () { if (props.onShowExecution) props.onShowExecution(); } }, '查看执行记录'))
      : React.createElement('div', { className: 'dsh-research-list' },
        current.items.map(function (item) {
          var state = stateLabels[item.state] || item.state;
          return React.createElement('button', { key: item.id, type: 'button', className: 'dsh-research-row' + (row && row.id === item.id ? ' is-active' : ''),
            'aria-expanded': row && row.id === item.id, onClick: function () { return detail(item.id); } },
            React.createElement('span', { className: 'dsh-research-state', 'data-state': item.state }, state),
            React.createElement('span', { className: 'dsh-research-title' }, item.title),
            React.createElement('span', { className: 'dsh-research-meta' },
              (item.endpoint || '地址未记录') + ' · 身份 ' + (item.authContext || '未记录')
              + ' · 尝试 ' + item.attempts + '/' + item.maxAttempts
              + (item.noInformation ? ' · 连续无新信息 ' + item.noInformation + ' 次' : '')
              + (item.restriction ? ' · ' + (item.restriction.code || '缺条件') : '')));
        }),
        current.total > 20 ? React.createElement('div', { className: 'dsh-research-pager' },
          React.createElement(Btn, { disabled: busy[0] || offset[0] === 0, onClick: function () { return load(Math.max(0, offset[0] - 20)); } }, '上一页'),
          React.createElement('span', null, '第 ' + (Math.floor(offset[0] / 20) + 1) + ' 页 · 共 ' + current.total + ' 条'),
          React.createElement(Btn, { disabled: busy[0] || offset[0] + 20 >= current.total, onClick: function () { return load(offset[0] + 20); } }, '下一页')) : null),
    results[0] ? React.createElement('div', { className: 'dsh-research-findings' },
      React.createElement('div', { className: 'dsh-research-head' },
        React.createElement('div', null,
          React.createElement('strong', null, '已有结果'),
          React.createElement('p', null, results[0].stats && results[0].stats.delivery
            ? '已确认 ' + results[0].stats.delivery.ready + ' · 待验证 ' + Math.max(0, results[0].stats.delivery.incomplete - (results[0].stats.byStatus && results[0].stats.byStatus['false-positive'] || 0) - (results[0].stats.byStatus && results[0].stats.byStatus.fixed || 0))
            : '本会话的候选与已确认结果')),
        React.createElement(Btn, { onClick: function () { if (props.onShowFindings) props.onShowFindings(); } }, '查看全部发现')),
      results[0].rows.length ? results[0].rows.slice(0, 3).map(function (finding) {
        return React.createElement('div', { className: 'dsh-research-finding', key: finding.id },
          React.createElement('span', { className: 'dsh-research-finding-title' }, finding.title),
          React.createElement('span', { className: 'dsh-research-finding-meta' },
            (SEVERITY_LABEL[finding.severity] || finding.severity || '未定级') + ' · '
            + statusTextFor(finding, 'pentest', STATUS_LABEL) + ' · ' + (finding.target || '地址未记录')));
      }) : React.createElement('p', { className: 'dsh-research-meta' }, '还没有结果记录。未确认的问题不会出现在这里。')) : null,
    row ? React.createElement('div', { className: 'dsh-research-detail' },
      React.createElement('h4', null, row.title),
      React.createElement('p', { className: 'dsh-research-detail-meta' },
        (stateLabels[row.state === 'restricted' || row.current ? row.state : 'blocked'] || row.state) + ' · '
        + (classLabels[row.classification] || row.classification) + ' · ' + (row.binding.endpoint || '地址未记录')
        + ' · 身份 ' + (row.binding.authContext || '未记录') + ' · 请求版本 ' + (row.binding.requestRevision || '未记录')),
      row.restriction ? React.createElement('p', { className: 'dsh-research-warning' },
        '缺条件/未覆盖：' + (row.restriction.code || '未知') + '；结论未知。' + (row.reason ? '原因：' + (stopReasons[row.reason] || row.reason) : '')) : null,
      row.blockedReason ? React.createElement('p', { className: 'dsh-research-warning' }, '当前基线失效：' + row.blockedReason) : null,
      [['boundary', '边界'], ['normalBehavior', '正常应该怎样'], ['supportCriterion', '什么证据算支持'], ['falsifier', '什么证据算反证'], ['nextInformation', '下一步需要的信息'], ['serverPath', '处理路径']].map(function (item) {
        return row[item[0]] ? React.createElement('p', { key: item[0] }, React.createElement('strong', null, item[1] + '：'), row[item[0]]) : null;
      }),
      row.reason && !row.restriction ? React.createElement('p', null, React.createElement('strong', null, '停止原因：'), stopReasons[row.reason] || row.reason) : null,
      React.createElement('p', { className: 'dsh-research-boundary' }, '仍须独立核对影响与复现；缺少 CVE 不证明首次发现。'),
      row.observations && row.observations.length ? React.createElement('details', { className: 'dsh-research-observations' },
        React.createElement('summary', null, '正常对照、观察与公开解释（' + row.observations.length + '）'),
        React.createElement('pre', null, JSON.stringify({ knownCheck: row.knownCheck, observations: row.observations }, null, 2))) : null) : null);
}

function MethodPackagesPanel(props) {
  var index = useState(null), selected = useState(null), notes = useState(''), error = useState(''), offset = useState(0), busy = useState(false);
  function run(action, payload) {
    error[1](''); busy[1](true);
    return api('methods.action', Object.assign({ sessionId: props.sessionId, action: action }, payload || {})).then(function (result) {
    if (!result.ok) throw new Error(typeof result.error === 'string' ? result.error : result.error && result.error.message || '测试流程操作失败');
      return result;
    }).catch(function (failure) { error[1](failure.message || String(failure)); return null; }).finally(function () { busy[1](false); });
  }
  function load(next) { return run('list', { offset: next }).then(function (result) { if (result) { offset[1](next); index[1](result); } }); }
  function detail(digest) { return run('detail', { digest: digest }).then(function (result) { if (result) { selected[1](result); notes[1](''); } }); }
  function importFile(event, action) {
    var file = event.target.files && event.target.files[0]; event.target.value = '';
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { error[1]('文件不能超过2MB'); return; }
    return file.text().then(function (text) { return run(action, { digest: selected[0] && selected[0].digest, document: text }); }).then(function (result) {
      if (result) return load(offset[0]).then(function () { return detail(result.digest); });
    }).catch(function (failure) { error[1](failure.message); });
  }
  function review(decision) {
    if (!selected[0]) return;
    return run('review', { digest: selected[0].digest, document: JSON.stringify({ methodDigest: selected[0].digest, reviewer: 'Desktop local review', decision: decision, notes: notes[0] }) })
      .then(function (result) { if (result) return load(offset[0]).then(function () { return detail(result.digest); }); });
  }
  function activate(rollback) {
    if (!selected[0]) return;
    return run(rollback ? 'rollback' : 'activate', { digest: selected[0].digest, expectedDigest: selected[0].activeDigest })
      .then(function (result) { if (result) return load(offset[0]).then(function () { return detail(result.digest); }); });
  }
  var method = selected[0], doc = method && method.document;
  return React.createElement('details', { style: { padding: 16 }, 'aria-label': '精选流程包管理' },
    React.createElement('summary', null, '精选流程包'),
    React.createElement('div', { style: { display: 'flex', gap: 12, alignItems: 'center', marginTop: 12 } },
      React.createElement(Btn, { disabled: busy[0], onClick: function () { return load(offset[0]); } }, '读取流程目录'),
      React.createElement('label', null, '导入流程包 ', React.createElement('input', { type: 'file', accept: '.json,application/json', disabled: busy[0], 'aria-label': '导入流程包', onChange: function (event) { return importFile(event, 'stage'); } }))),
    index[0] ? React.createElement('div', null,
      index[0].items.length ? index[0].items.map(function (item) { return React.createElement('div', { key: item.digest, style: { display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--dsw-alias-border-l1,#e9e9ec)' } },
        React.createElement('span', { style: { flex: 1 } }, item.title + ' · ' + item.version + ' · ' + (item.active ? '已激活' : item.status === 'trusted' ? '审阅及测试通过' : item.status === 'rejected' ? '已否决' : '待审阅')),
        React.createElement(Btn, { disabled: busy[0], onClick: function () { return detail(item.digest); } }, '查看资料')); }) : React.createElement('p', null, '尚未导入精选流程'),
      React.createElement(Btn, { disabled: busy[0] || offset[0] === 0, onClick: function () { return load(Math.max(0, offset[0] - 20)); } }, '上一页'),
      React.createElement(Btn, { disabled: busy[0] || offset[0] + 20 >= index[0].total, onClick: function () { return load(offset[0] + 20); } }, '下一页')) : null,
    doc ? React.createElement('div', { style: { marginTop: 12 } },
      React.createElement('h4', null, doc.title + ' · ' + method.version),
      React.createElement('p', null, '产品：' + doc.products.join('、') + '；机制：' + doc.mechanism),
      React.createElement('p', null, '流程摘要：' + method.digest),
      React.createElement('details', null, React.createElement('summary', null, '请求、对照、代码、依赖与来源'), React.createElement('pre', { style: { whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: 360 } }, JSON.stringify(doc, null, 2))),
      React.createElement('details', null, React.createElement('summary', null, '审阅和测试记录'), React.createElement('pre', { style: { whiteSpace: 'pre-wrap', overflow: 'auto', maxHeight: 280 } }, JSON.stringify({ review: method.review, verification: method.verification }, null, 2))),
      React.createElement('textarea', { 'aria-label': '流程审阅意见', placeholder: '记录对流程、判据、代码及测试证据的审阅意见', value: notes[0], rows: 3, style: { width: '100%' }, onChange: function (event) { notes[1](event.target.value); } }),
      React.createElement(Btn, { disabled: busy[0] || !notes[0].trim(), onClick: function () { return review('approved'); } }, '审阅通过'),
      React.createElement(Btn, { disabled: busy[0] || !notes[0].trim(), onClick: function () { return review('rejected'); } }, '否决流程'),
      React.createElement('label', { style: { marginLeft: 12 } }, '导入正反例测试证据 ', React.createElement('input', { type: 'file', accept: '.json,application/json', disabled: busy[0], 'aria-label': '导入流程测试证据', onChange: function (event) { return importFile(event, 'verify'); } })),
      React.createElement('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
        React.createElement(Btn, { disabled: busy[0] || method.status !== 'trusted' || method.active, onClick: function () { return activate(false); } }, '激活此版本'),
        React.createElement(Btn, { disabled: busy[0] || method.status !== 'trusted' || method.active, onClick: function () { return activate(true); } }, '回退到此版本'))) : null,
    error[0] ? React.createElement('div', { role: 'alert' }, error[0]) : null,
    busy[0] ? React.createElement('span', { role: 'status' }, '正在处理…') : null);
}

function CheckedList(props) {
	var state = useState(null), setState = state[1];
	var error = useState(''), setError = error[1];
	function load() {
		setError('');
		return api('checks.list', { sessionId: props.sessionId }).then(function (result) {
			if (!result.ok) throw new Error(result.error || '读取失败');
			setState(result.rows);
		}).catch(function (failure) { setError(failure.message); });
	}
	function exportChecks() {
		return api('checks.export', { sessionId: props.sessionId }).then(function (result) {
			if (!result.ok) throw new Error(result.error || '导出失败');
			download(result.filename, result.text, 'text/tab-separated-values');
		}).catch(function (failure) { setError(failure.message); });
	}
	function exportBundle() {
		return api('delivery.bundle', { sessionId: props.sessionId }).then(function (result) {
			if (!result.ok) throw new Error(result.error || '报告包生成失败');
			downloadArchive(result.filename, result.archive);
		}).catch(function (failure) { setError(failure.message); });
	}
	return React.createElement('div', {className:'dsh-task-delivery'},
		React.createElement(Btn, { onClick: exportBundle }, '导出本会话完整报告包'),
		React.createElement('details', {className:'dsh-task-fold'},React.createElement('summary',null,'查看已检查的项目'),
		React.createElement(Btn, { onClick: load }, '读取检查记录'),
		React.createElement(Btn, { onClick: exportChecks }, '导出检查清单'),
		error[0] ? React.createElement('div', { role: 'alert' }, error[0]) : null,
		state[0] ? React.createElement('div', null,
			React.createElement('div', null, state[0].length ? '资产／检查项／状态' : '本会话暂无检查记录'),
			state[0].map(function (row, i) { return React.createElement('div', { key: i }, row.asset + '／' + row.check + '：' + row.status); })) : null));
}

function ModePage(props) {
	var mode = props.mode;
	var scope = props.scope === 'all' ? 'all' : 'session';
	var meta = MODE_META[mode] || MODE_META.pentest;
	var sessionId = props.sessionId;
	var stale = useRef(0);
	var data = useState({ rows: [], total: 0, page: 1, pages: 1, stats: null, counts: {}, meta: null, groups: null, ordinaryReports: [] });
	var setData = data[1];
	var loading = useState(true); var setLoading = loading[1];
	var notice = useState(""); var setNotice = notice[1];
	var exportMenu = useState(null); var setExportMenu = exportMenu[1];
	// 报告"先预览再导出"（v6 第 9.2 节）：导出不再直接下载，先在页面里看一遍。
	var reportPreview = useState(null); var setReportPreview = reportPreview[1];
	var page = useState(1); var setPage = page[1];
	var severity = useState(""); var setSeverity = severity[1];
	var status = useState(""); var setStatus = status[1];
	var delivery = useState('all'); var setDelivery = delivery[1];
	var emptyMessage = mode === 'pentest' && delivery[0] === 'ready' ? '暂无已确认漏洞。切换“全部记录”可查看待验证或已排除的问题。' : meta.empty;
	var q = useState(""); var setQ = q[1];
	var qDraft = useState(""); var setQDraft = qDraft[1];
	var grouped = useState(false); var setGrouped = grouped[1];
	var expanded = useState(""); var setExpanded = expanded[1];
	var selected = useState({}); var setSelected = selected[1];
	var confirmDel = useState(""); var setConfirmDel = confirmDel[1];
	var editingMeta = useState(false); var setEditingMeta = editingMeta[1];
	var range = useState("all"); var setRange = range[1];
	var customFrom = useState(""); var setCustomFrom = customFrom[1];
	var customTo = useState(""); var setCustomTo = customTo[1];
	// 「首次空页」（v6 第 5.3 节）：本会话、没有任何筛选、也没有任何记录时才提示怎么开始；
	// 有筛选或历史范围时空了要说"没有匹配"，不能把用户引到"添加资料"。必须放在全部筛选 state 之后。
	var firstEmpty = scope === 'session' && !severity[0] && !status[0] && delivery[0] === 'all' && !q[0] && range[0] === 'all';
	var rt = rangeIso(range[0], customFrom[0], customTo[0]);
	var metaDraft = useState({ targetLabel: "", version: "", scope: "" }); var setMetaDraft = metaDraft[1];
	// 人工复核标记向导：原生 confirm/prompt 会阻塞渲染进程（Agent 驱动整页卡死），改为组件内三步状态机
	var rv = useState(null); var setRv = rv[1];
	var rvStep = useState(1); var setRvStep = rvStep[1];
	var rvStatus = useState(""); var setRvStatus = rvStatus[1];
	var rvNote = useState(""); var setRvNote = rvNote[1];
	var rvSecond = useState("high"); var setRvSecond = rvSecond[1];
	var workerReview = useState(null); var setWorkerReview = workerReview[1];
	var workerReviewBusy = useState(false); var setWorkerReviewBusy = workerReviewBusy[1];

	var fetchList = useCallback(function (opts) {
		var o = opts || {};
		var token = ++stale.current;
		setLoading(true);
		api("findings.list", {
			scope: scope, sessionId: sessionId, mode: mode,
			// 发现页每页 50 条（v6 第 5.3 节）；分页仍由服务端切片。
			page: o.page !== undefined ? o.page : page[0], pageSize: 50,
			severity: o.severity !== undefined ? o.severity : severity[0],
			status: o.status !== undefined ? o.status : status[0],
			delivery: delivery[0],
			q: o.q !== undefined ? o.q : q[0],
			from: rangeIso(range[0], customFrom[0], customTo[0])[0], to: rangeIso(range[0], customFrom[0], customTo[0])[1]
		}).then(function (res) {
			if (token !== stale.current) return;
			var list = (res || {}).list || {};
			setData({
				rows: list.rows || [], total: list.total || 0, page: list.page || 1, pages: list.pages || 1,
				stats: res.stats, counts: res.counts || {}, meta: res.meta, groups: null,
				ordinaryReports: res.ordinaryReports || []
			});
			if ((o.page || page[0]) > (list.pages || 1)) setPage(list.pages || 1);
		}).catch(function (e) {
			if (token === stale.current) setNotice("读取失败：" + (e && e.message ? e.message : e));
		}).finally(function () {
			if (token === stale.current) setLoading(false);
		});
	}, [sessionId, mode, scope, page[0], severity[0], status[0], delivery[0], q[0], range[0], customFrom[0], customTo[0]]);

	var fetchGroups = useCallback(function () {
		var token = ++stale.current;
		setLoading(true);
		api("findings.groups", { scope: scope, sessionId: sessionId, mode: mode, severity: severity[0], status: status[0], delivery: delivery[0], q: q[0], from: rangeIso(range[0], customFrom[0], customTo[0])[0], to: rangeIso(range[0], customFrom[0], customTo[0])[1] })
				.then(function (res) {
					if (token !== stale.current) return;
					var groups = (res || {}).groups || [];
					setData({
						rows: [], total: groups.reduce(function (n, g) { return n + g.count; }, 0), page: 1, pages: 1,
						stats: res.stats || null, counts: {}, meta: res.meta, groups: groups,
						ordinaryReports: res.ordinaryReports || []
					});
				})
			.catch(function (e) { if (token === stale.current) setNotice("分组读取失败：" + (e && e.message ? e.message : e)); })
			.finally(function () { if (token === stale.current) setLoading(false); });
	}, [sessionId, mode, scope, severity[0], status[0], delivery[0], q[0], range[0], customFrom[0], customTo[0]]);

	useEffect(function () {
		setPage(1); setExpanded(""); setSelected({}); setConfirmDel("");
		if (grouped[0]) fetchGroups(); else fetchList({ page: 1 });
	}, [sessionId, mode, scope, severity[0], status[0], delivery[0], q[0], grouped[0], range[0], customFrom[0], customTo[0]]);

	useEffect(function () {
		if (!notice) return;
		var t = setTimeout(function () { setNotice(""); }, 4000);
		return function () { clearTimeout(t); };
	}, [notice]);

	// 搜索防抖：停键 300ms 才触发查询（不再每键一 POST 打全模式表）
	useEffect(function () {
		var t = setTimeout(function () { setQ(qDraft[0]); }, 300);
		return function () { clearTimeout(t); };
	}, [qDraft[0]]);

	var view = data[0] || {};
	function onEffectReview() { setNotice('验证结果已保存。符合条件的漏洞会出现在“已确认漏洞”中。'); if (props.onRefreshCounts) props.onRefreshCounts(); return grouped[0] ? fetchGroups() : fetchList({}); }
	var rows = view.rows || [];
	var stats = view.stats || { total: view.total || 0, bySeverity: {}, byStatus: {}, byType: [], byCwe: [], bySource: [], byTarget: [] };
	var sesMeta = view.meta || { targetLabel: "", version: "", scope: "" };
	var selectedIds = Object.keys(selected[0]).filter(function (k) { return selected[0][k]; });

	// 行唯一键：跨会话视图里 id 只在会话内唯一（每个会话都有一条 pentest-1）——sessionId+id 复合，防 React 重复 key 与勾选/展开串行。
	function uidOf(f) { return (f.sessionId || sessionId) + ":" + f.id; }
	function toggle(f) { var u = uidOf(f); setConfirmDel(""); setExpanded(expanded[0] === u ? "" : u); }
	// 复核依据的默认正文（与原来的 prompt 初值一致）
	function reviewNoteFor(status) {
		if (status === "verified") return "原会话不可达，人工复核通过。复核方式与观察到的现象：";
		var tail = status === "false-positive" ? "判伪"
			: status === "suspect" ? "定疑似"
			: status === "stuck" ? "记卡点"
			: status === "code-reviewed" ? "代码侧复核通过"
			: status === "detected" ? "记检出"
			: "标记";
		return "原会话不可达，人工复核" + tail + "。复核方式与观察到的现象：";
	}
	// 提交人工标记：校验仍在客户端拦一道（转 verified 须 ≥40 字依据 + 词表内二次评级），服务端另有一道。
	function reviewSubmit(status) {
		var note = String(rvNote[0] || "");
		if (status === "verified" && note.trim().length < 40) { setNotice("转为「已验证」需至少 40 字复核依据（当前 " + note.trim().length + " 字）"); return; }
		var second = "";
		if (status === "verified") {
			second = String(rvSecond[0] || "").trim();
			if (SECOND_RATING_LIST.indexOf(second) === -1) { setNotice("二次评级必须是 " + SECOND_RATING_LIST.join("/")); return; }
		}
		if (!rv[0]) return;
		var f = rv[0].f; var statusText = status === "verified" ? rv[0].posText : rv[0].negText;
		setRv(null); setRvStep(1);
		api("finding.mark", { sessionId: f.sessionId || sessionId, id: f.id, status: status, verifyNote: note, secondRating: second, secondRatingNote: note })
			.then(function (m) { setNotice(m && m.ok ? "已人工标记 #" + f.seq + " → " + statusText : "标记失败：" + ((m && m.error) || "未知")); if (props.onRefreshCounts) props.onRefreshCounts(); if (grouped[0]) fetchGroups(); else fetchList({}); })
			.catch(function (e) { setNotice("标记失败：" + (e && e.message ? e.message : e)); });
	}
		function onVerify(f) {
		api("finding.verify", { sessionId: f.sessionId || sessionId, mode: mode, id: f.id })
			.then(function (r) {
				if (r && r.ok) { setNotice("验证请求已发送到原会话（# " + f.seq + " " + f.title + "），复核后状态由会话回写"); return; }
				if (r && r.unreachable) {
					// 原会话已删/不可达：人工复核兜底。原先是 confirm→confirm→prompt→prompt 的串联原生弹窗，
					// 会阻塞渲染进程（对话框一弹，页面 JS 全部停摆，Agent 驱动整页卡死），故整条向导改为
					// 组件内三步弹层：步1 选标记项（verified / 模式词表内判伪或重置项 / 取消）——
					// 单一出口与原来的两段确认等价；步2 填复核依据（转 verified 需 ≥40 字，服务端强制）；
					// 步3 独立二次评级。确定项与判伪词均按模式词表取（binary=已定论/疑似、av=过检/被检出、其余=已验证/误报或已失效）。
					var okSet = statusLabelSetFor(meta.archetype, mode) || STATUS_LABEL;
					var opts = (STATUS_OPTIONS_OF[mode] || Object.keys(STATUS_LABEL)).filter(function (s) { return s !== "pending"; });
					var negativeOptions = opts.filter(function (s) { return s !== "verified"; }).map(function (s) { return { status: s, label: (okSet[s] || s) + "（" + s + "）" }; });
					var posText = (okSet.verified || "已验证") + "（verified）";
					setRv({ f: f, error: r.error || "", negativeOptions: negativeOptions, posText: posText });
					setRvStep(1); setRvStatus(""); setRvNote(""); setRvSecond("high");
					return;
				}
								setNotice("验证请求失败：" + ((r && r.error) || "未知错误"));
			})
			.catch(function (e) { setNotice("验证请求失败：" + (e && e.message ? e.message : e)); });
	}
	function onWorkerReview(f) {
		var uid = uidOf(f);
		setWorkerReview(null); setWorkerReviewBusy(true); setNotice("独立复核中：只读取现有证据，按当前任务范围和预算运行。");
		api("task.review", { sessionId: f.sessionId || sessionId })
			.then(function (r) {
				if (!r || r.ok === false) throw Error((r && r.error) || "独立复核未完成");
        setWorkerReview({ uid: uid, text: r.output || "独立复核已完成，但没有返回文本。" });
				setNotice("独立复核完成；结果已展开在当前候选下，不会自动改状态。");
			})
			.catch(function (e) { setNotice("独立复核失败：" + (e && e.message ? e.message : e)); })
			.finally(function () { setWorkerReviewBusy(false); });
	}
	var LIVE_BUSY = {}; // 实测 in-flight 防重（key=sessionId:id——流水线含搜索+探测，连点会并发跑多条并重复扣平台配额）
	function onLiveVerify(f) {
		// 一键实测：调 dsh-hunter 验证流水线（L0 指纹判定/L1 仅授权资产），结果回写 finding。
		if (mode !== "code-audit") { setNotice("实测仅支持代码审计模式 finding"); return; }
		var busyKey = (f.sessionId || sessionId) + ":" + f.id;
		if (LIVE_BUSY[busyKey]) { setNotice("实测进行中——请等待本轮完成（搜索+探测为秒级到分钟级）"); return; }
		LIVE_BUSY[busyKey] = true;
		setNotice("实测进行中：搜索资产 → 存活探测 → 指纹校验 →" + (f.auditMode === "dynamic" ? "影响面评估…" : "EXP 验证（L1 仅授权资产）…"));
		var send = function (tok) {
			return fetch("/dsh-hunter/verify.live", {
				method: "POST",
				headers: tok ? { "content-type": "application/json", "x-dsh-csrf": tok } : { "content-type": "application/json" },
				body: JSON.stringify({ sessionId: f.sessionId || sessionId, findingId: f.id, allMode: false })
			});
		};
		var parse = function (r) {
			return r.text().then(function (t) {
				try { return JSON.parse(t); } catch { throw new Error("HTTP " + r.status + (t ? "：" + String(t).slice(0, 80) : "")); }
			});
		};
		csrfOf("/dsh-hunter").then(function (hTok) {
			return send(hTok).then(function (r) {
				if (r.status === 403) {
					delete dshCsrf["/dsh-hunter"]; // token 失效（宿主重启轮换）——重取一次再发
					return csrfOf("/dsh-hunter").then(function (t2) { return send(t2); }).then(parse);
				}
				return parse(r);
			});
		}).then(function (r) {
			if (r && r.ok) {
				setNotice("实测完成（#" + f.seq + "）：" + r.summary
					+ (r.suggestions && r.suggestions.length ? "｜下一步：" + r.suggestions.join("；") : "")
					+ (r.notified ? "" : "（原会话不可达，未注入通知）"));
				if (grouped[0]) fetchGroups(); else fetchList({});
				return;
			}
			setNotice("实测失败：" + ((r && r.error) || "未知错误"));
		}).catch(function (e) { setNotice("实测失败：" + (e && e.message ? e.message : e)); })
			.finally(function () { LIVE_BUSY[busyKey] = false; });
	}
	function onDelete(f) {
		var u = uidOf(f);
		if (confirmDel[0] !== u) { setConfirmDel(u); return; }
		api("finding.delete", { sessionId: f.sessionId || sessionId, id: f.id })
			.then(function () { setConfirmDel(""); setNotice("已删除 #" + f.seq + "（统计已同步）"); if (props.onRefreshCounts) props.onRefreshCounts(); if (grouped[0]) fetchGroups(); else fetchList({}); })
			.catch(function (e) { setNotice("删除失败：" + (e && e.message ? e.message : e)); });
	}
	function fetchAllForExport() {
		var rtx = rangeIso(range[0], customFrom[0], customTo[0]);
		var acc = [];
		function pageOf(n) {
			return api("findings.list", { scope: scope, sessionId: sessionId, mode: mode, page: n, pageSize: 100, severity: severity[0], status: status[0], delivery: delivery[0], q: q[0], from: rtx[0], to: rtx[1] })
				.then(function (raw) {
					var l = ((raw || {}).list) || {};
					acc = acc.concat(l.rows || []);
					if (n < (l.pages || 1)) return pageOf(n + 1); // 翻页取全——导出不受单页 100 条截断
					return acc;
				});
		}
		return pageOf(1);
	}
	// 先预览再导出（v6 第 9.2 节）：把要下载的文本放进预览面板，用户看过再点下载。
	function previewReport(name, text, mime) { setReportPreview({ name: name, text: text, mime: mime || "text/markdown" }); }
	function exportAll() {
		fetchAllForExport().then(function (all) {
			previewReport(meta.allName + localDate() + ".md", mdTable(all, meta.tableTitle, mode));
			setNotice("已生成 " + all.length + " 条预览（当前筛选范围）");
		});
	}
	function exportSelected() {
		// 分组态从分组条目取行（分组视图 rows 为空——勾选导出不再永远提示先勾选）
		var pool = grouped[0] ? (view.groups || []).reduce(function (a, g) { return a.concat(g.items); }, []) : rows;
		var picked = pool.filter(function (f) { return selected[0][uidOf(f)]; });
		if (picked.length === 0) { setNotice("先勾选要导出的成果"); return; }
		var text = picked.map(function (f) { return mdReport(f, mode); }).join("\n---\n\n");
		previewReport(meta.reportName + localDate() + ".md", text);
		setNotice("已生成 " + picked.length + " 份报告预览（MD）");
	}
	function exportOne(f) {
		previewReport("finding-" + mode + "-" + f.seq + "-" + localDate() + ".md", mdReport(f, mode));
	}
	function exportOverview() {
		fetchAllForExport().then(function (all) {
			previewReport(mode + "-overview-" + localDate() + ".md", mdOverview(sesMeta, stats, all, mode));
			setNotice("总览报告已生成预览（MD）");
		});
	}
	function exportHtml() {
		fetchAllForExport().then(function (all) {
			previewReport(mode + "-report-" + localDate() + ".html", htmlReport(sesMeta, stats, all, mode), "text/html");
			setNotice("报告包已生成预览（HTML，可浏览器打印成 PDF）");
		});
	}
	function exportJson() {
		fetchAllForExport().then(function (all) {
			previewReport(mode + "-report-" + localDate() + ".json", jsonReport(sesMeta, stats, all, mode), "application/json");
			setNotice("结构化报告已生成预览（JSON）");
		});
	}
	function saveMeta() {
		api("meta.set", { sessionId: sessionId, targetLabel: metaDraft[0].targetLabel, version: metaDraft[0].version, scope: metaDraft[0].scope })
			.then(function () { setEditingMeta(false); setNotice("任务元数据已保存"); if (grouped[0]) fetchGroups(); else fetchList({}); })
			.catch(function (e) { setNotice("保存失败：" + (e && e.message ? e.message : e)); });
	}

	var rowEl = function (f) {
		var meta2 = meta;
		var uid = uidOf(f);
		var stLabelSet = statusLabelSetFor(meta2.archetype, mode);
		return React.createElement("div", { key: uid, className: "dsh-rtr-row" },
			React.createElement("div", { className: "dsh-rtr-rowhead", onClick: function () { toggle(f); } },
				React.createElement("input", {
					type: "checkbox", className: "dsh-rtr-check", checked: !!selected[0][uid],
					onClick: function (e) { e.stopPropagation(); },
					onChange: function (e) { var next = Object.assign({}, selected[0]); next[uid] = e.target.checked; setSelected(next); }
				}),
				React.createElement("span", { className: "dsh-rtr-seq" }, "#" + f.seq),
				React.createElement(Chip, { severity: f.severity, typeLabel: LABEL_BY_TYPE_MODES[mode] ? (f.type || "未标注") : null }),
				// 「复测中」优先于原状态显示（v6 第 5.3 节）：复核/复测消息已发出但还没有结论。
				f.verifying ? React.createElement("span", { className: "dsh-rtr-st dsh-rtr-st-retesting" }, "复测中")
					// 复测结论为「本次未复现」时按 v6 第 5.3 节的叫法显示，不混进原状态词。
					: f.retest && f.retest.latest && f.retest.latest.verdict === 'not-reproduced'
						? React.createElement("span", { className: "dsh-rtr-st" }, "本次未复现")
						: React.createElement("span", { className: "dsh-rtr-st dsh-rtr-st-" + (mode === "pentest" && f.status === "verified" && !f.delivery?.ready ? "pending" : f.status) }, statusTextFor(f, mode, stLabelSet)),
				mode === "code-audit" && f.auditMode ? React.createElement("span", { className: "dsh-rtr-am dsh-rtr-am-" + f.auditMode }, AUDIT_MODE_LABEL[f.auditMode] || f.auditMode) : null,
				React.createElement("span", { className: "dsh-rtr-title" }, f.title),
				mode !== 'pentest' ? React.createElement("span", { className: "dsh-rtr-summ" }, f.summary || "") : null,
				mode !== 'pentest' ? React.createElement("span", { className: "dsh-rtr-time" }, fmtTime(f.updatedAt)) : null,
				React.createElement("span", { className: "dsh-rtr-rowactions", onClick: function (e) { e.stopPropagation(); } },
					mode === 'pentest' ? React.createElement(Btn, { 'aria-expanded': expanded[0] === uid, onClick: function () { toggle(f); } }, expanded[0] === uid ? '收起证据' : '查看证据') : null,
					mode === "code-audit" ? React.createElement(Btn, { primary: true, onClick: function () { onLiveVerify(f); } }, "实测") : null,
					mode !== 'pentest' ? React.createElement(Btn, { onClick: function () { onVerify(f); } }, "验证") : null,
					mode !== 'pentest' ? React.createElement(Btn, { danger: true, onClick: function () { onDelete(f); } }, confirmDel[0] === uid ? "确认删除" : "删除") : null)),
			mode === 'pentest' ? React.createElement('div', {className:'dsh-finding-preview'},
				React.createElement('p',null,'目标：'+(f.target||'尚未记录')),
				f.summary ? React.createElement('p',null,f.summary) : null,
				React.createElement('p',null,findingSummary(f)),
				expanded[0]===uid?React.createElement('div',{className:'dsh-task-actions'},React.createElement(Btn,{onClick:function(){onVerify(f);}},'复核状态'),React.createElement(Btn,{danger:true,onClick:function(){onDelete(f);}},confirmDel[0]===uid?'确认删除':'删除记录')):null):null,
				expanded[0] === uid ? React.createElement(Detail, { f: f, mode: mode, meta: meta, onVerify: onVerify, onLiveVerify: onLiveVerify, onWorkerReview: onWorkerReview, workerReview: workerReview[0] && workerReview[0].uid === uid ? workerReview[0] : null, workerReviewBusy: workerReviewBusy[0], onExportOne: exportOne, onEffectReview: onEffectReview, onPreview: previewReport, onClose: function () { toggle(f); }, onOpenExecution: props.onOpenExecution }) : null);
	};

	var tlItem = function (f) {
		var stSet = statusLabelSetFor(meta.archetype, mode);
		var uid = uidOf(f);
		var open = expanded[0] === uid;
		return React.createElement("div", { key: uid, className: "dsh-rtr-tl-item" },
			React.createElement("div", { className: "dsh-rtr-tl-rail" },
				React.createElement("span", { className: "dsh-rtr-tl-dot" }),
				React.createElement("span", { className: "dsh-rtr-tl-line" })),
			React.createElement("div", { className: "dsh-rtr-tl-body" },
				React.createElement("div", { className: "dsh-rtr-tl-time" }, fmtTimelineAt(f.timelineAt)),
				React.createElement("div", { className: "dsh-rtr-tl-card" },
					React.createElement("div", { className: "dsh-rtr-rowhead", onClick: function () { toggle(f); } },
						React.createElement("input", {
							type: "checkbox", className: "dsh-rtr-check", checked: !!selected[0][uid],
							onClick: function (e) { e.stopPropagation(); },
							onChange: function (e) { var next = Object.assign({}, selected[0]); next[uid] = e.target.checked; setSelected(next); }
						}),
						React.createElement("span", { className: "dsh-rtr-seq" }, "#" + f.seq),
						React.createElement("span", { className: "dsh-rtr-typechip is-static" }, f.type || "未分类"),
						React.createElement(Chip, { severity: f.severity, typeLabel: LABEL_BY_TYPE_MODES[mode] ? (f.type || "未标注") : null }),
						React.createElement("span", { className: "dsh-rtr-st dsh-rtr-st-" + f.status }, stSet[f.status] || f.status),
						React.createElement("span", { className: "dsh-rtr-title" }, f.title),
						React.createElement("span", { className: "dsh-rtr-rowactions", onClick: function (e) { e.stopPropagation(); } },
							React.createElement(Btn, { onClick: function () { onVerify(f); } }, "验证"),
							React.createElement(Btn, { danger: true, onClick: function () { onDelete(f); } }, confirmDel[0] === uid ? "确认删除" : "删除"))),
					React.createElement("div", { className: "dsh-rtr-tl-meta", onClick: function () { toggle(f); } },
						React.createElement("span", null, "主机 ", React.createElement("b", null, f.target || "（未填）")),
						React.createElement("span", null, "证据 ", React.createElement("b", null, f.evidence || "（未填）")),
						React.createElement("span", { className: "dsh-rtr-tl-concl" }, f.summary || "")),
					open ? React.createElement(Detail, { f: f, mode: mode, meta: meta, onVerify: onVerify, onLiveVerify: onLiveVerify, onWorkerReview: onWorkerReview, workerReview: workerReview[0] && workerReview[0].uid === uid ? workerReview[0] : null, workerReviewBusy: workerReviewBusy[0], onExportOne: exportOne, onEffectReview: onEffectReview, onPreview: previewReport, onClose: function () { toggle(f); }, onOpenExecution: props.onOpenExecution }) : null)));
	};

	var cpItem = function (f) {
		var stSet = statusLabelSetFor(meta.archetype, mode);
		var uid = uidOf(f);
		var open = expanded[0] === uid;
		var hop = function (label, value) {
			return React.createElement("span", { className: "dsh-rtr-cp-hop", title: value || "" },
				React.createElement("i", null, label),
				React.createElement("b", null, (value || "（未填）").slice(0, 120)));
		};
		return React.createElement("div", { key: uid, className: "dsh-rtr-cp-item" },
			React.createElement("div", { className: "dsh-rtr-cp-card" },
				React.createElement("div", { className: "dsh-rtr-rowhead", onClick: function () { toggle(f); } },
					React.createElement("input", {
						type: "checkbox", className: "dsh-rtr-check", checked: !!selected[0][uid],
						onClick: function (e) { e.stopPropagation(); },
						onChange: function (e) { var next = Object.assign({}, selected[0]); next[uid] = e.target.checked; setSelected(next); }
					}),
					React.createElement("span", { className: "dsh-rtr-seq" }, "#" + f.seq),
					React.createElement("span", { className: "dsh-rtr-typechip is-static" }, f.type || "未分类"),
					React.createElement(Chip, { severity: f.severity, typeLabel: LABEL_BY_TYPE_MODES[mode] ? (f.type || "未标注") : null }),
					React.createElement("span", { className: "dsh-rtr-st dsh-rtr-st-" + f.status }, stSet[f.status] || f.status),
					React.createElement("span", { className: "dsh-rtr-title" }, f.title),
					React.createElement("span", { className: "dsh-rtr-rowactions", onClick: function (e) { e.stopPropagation(); } },
						React.createElement(Btn, { onClick: function () { onVerify(f); } }, "验证"),
						React.createElement(Btn, { danger: true, onClick: function () { onDelete(f); } }, confirmDel[0] === uid ? "确认删除" : "删除"))),
				React.createElement("div", { className: "dsh-rtr-cp-chain", onClick: function () { toggle(f); } },
					hop("入口", f.entry),
					hop("身份", f.identity),
					hop("权限", f.permission),
					hop("资源", f.resource || f.target),
					hop("影响", f.impact || f.summary)),
				open ? React.createElement(Detail, { f: f, mode: mode, meta: meta, onVerify: onVerify, onLiveVerify: onLiveVerify, onWorkerReview: onWorkerReview, workerReview: workerReview[0] && workerReview[0].uid === uid ? workerReview[0] : null, workerReviewBusy: workerReviewBusy[0], onExportOne: exportOne, onEffectReview: onEffectReview, onPreview: previewReport, onClose: function () { toggle(f); }, onOpenExecution: props.onOpenExecution }) : null));
	};

	var listBody;
	if (loading[0]) {
		listBody = React.createElement("div", { className: "dsh-rtr-skel" }, "读取成果数据…");
	} else if (meta.archetype === "cloudpath") {
		// 分组态：按路径类型分组渲染（此前 cloudpath 分支不消费 groups——点分组必现假空态）
		if (grouped[0]) {
			var cpGroups = view.groups || [];
			listBody = cpGroups.length === 0
				? React.createElement("div", { className: "dsh-rtr-empty" }, emptyMessage, React.createElement("br", null), rangeHint(range[0]))
				: cpGroups.map(function (g) {
					return React.createElement("div", { key: g.target },
						React.createElement("div", { className: "dsh-rtr-grouphead" }, g.target, React.createElement("span", { className: "dsh-rtr-count" }, g.count + " 条")),
						React.createElement("div", { className: "dsh-rtr-cp" }, g.items.map(cpItem)));
				});
		} else {
			var cpRows = rows.slice().sort(function (a, b) { return SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity); });
			listBody = cpRows.length === 0
				? React.createElement("div", { className: "dsh-rtr-empty" },
					emptyMessage, React.createElement("br", null),
					rangeHint(range[0]), React.createElement("br", null),
					"会话内模型会把攻击路径通过 redteam_finding_register 登记到这里（也可让模型补登记：\"把攻击路径登记到成果页\"）。")
				: React.createElement("div", { className: "dsh-rtr-cp" }, cpRows.map(cpItem));
		}
	} else if (meta.archetype === "timeline") {
		var chronoRows = rows.slice().sort(cmpTimeline);
		listBody = chronoRows.length === 0
			? React.createElement("div", { className: "dsh-rtr-empty" },
				emptyMessage, React.createElement("br", null),
				rangeHint(range[0]), React.createElement("br", null),
				"会话内模型会把攻击链节点通过 redteam_finding_register 登记到这里（也可让模型补登记：\"把攻击链节点登记到成果页\"）。")
			: React.createElement("div", { className: "dsh-rtr-tl" }, chronoRows.map(tlItem));
	} else if (grouped[0]) {
		var groups = view.groups || [];
		listBody = groups.length === 0
			? React.createElement("div", { className: "dsh-rtr-empty" }, emptyMessage, React.createElement("br", null), rangeHint(range[0]))
			: groups.map(function (g) {
				return React.createElement("div", { key: g.target },
					React.createElement("div", { className: "dsh-rtr-grouphead" }, g.target, React.createElement("span", { className: "dsh-rtr-count" }, g.count + " 项")),
					g.items.map(rowEl));
			});
	} else {
		listBody = rows.length === 0
			? (firstEmpty
				? React.createElement("div", { className: "dsh-rtr-empty" },
					"测试中发现的异常会保存在这里。",
					React.createElement("br", null),
          "添加网站请求或代码，Saker 就能从这些内容开始检查。",
					props.onAddMaterials ? React.createElement("div", { className: "dsh-rtr-empty-actions" },
						React.createElement("button", { type: "button", onClick: function () { props.onAddMaterials(); } }, "添加资料")) : null)
				: React.createElement("div", { className: "dsh-rtr-empty" },
					emptyMessage, React.createElement("br", null),
          "发现会在保存后显示。若对话中已有结论，可让 Saker 整理并保存发现与证据。"))
			: rows.map(rowEl);
	}

	return React.createElement(React.Fragment, null,
		mode === 'pentest' && sessionId && scope !== 'all' ? React.createElement(CheckedList, { key: sessionId, sessionId: sessionId }) : null,
		(notice[0] && String(notice[0]).trim()) ? React.createElement("div", { className: "dsh-rtr-notice" }, notice[0]) : null,
		// 报告预览（v6 第 9.2 节）：看过再下载，秘密已在生成时遮蔽。
		reportPreview[0] ? React.createElement("div", { className: "dsh-rtr-report-preview", role: "dialog", "aria-label": "报告预览" },
			React.createElement("div", { className: "dsh-rtr-preview-head" },
				React.createElement("strong", null, "报告预览"),
				React.createElement("span", { className: "dsh-rtr-preview-name" }, reportPreview[0].name),
				React.createElement("span", { className: "dsh-rtr-spacer" }),
				React.createElement(Btn, { primary: true, onClick: function () { download(reportPreview[0].name, reportPreview[0].text, reportPreview[0].mime); setNotice("已下载 " + reportPreview[0].name); } }, "下载"),
				React.createElement(Btn, { onClick: function () { setReportPreview(null); } }, "关闭")),
			React.createElement("pre", { className: "dsh-rtr-preview-body" }, reportPreview[0].text)) : null,
		// 人工复核向导弹层（原生对话框会阻塞渲染进程，故全部就地渲染）
		(rv[0] ? React.createElement("div", { style: { position: "fixed", left: "50%", top: "72px", transform: "translateX(-50%)", zIndex: 3000, width: "min(580px, 92vw)", maxHeight: "70vh", overflowY: "auto", background: "var(--dsw-alias-bg-base,#fff)", border: "1px solid var(--dsw-alias-border-l1,#d9d9de)", borderRadius: 6, boxShadow: "0 12px 40px rgba(0,0,0,.2)", padding: "14px 16px", whiteSpace: "normal" } },
			React.createElement("div", { style: { fontWeight: 700, marginBottom: 8 } }, "人工复核标记 #" + rv[0].f.seq + " " + rv[0].f.title),
			React.createElement("div", { style: { fontSize:'var(--dsh-content-font-size-secondary,0.93em)', color: "#b45309", marginBottom: 12, whiteSpace: "pre-wrap", maxHeight: 140, overflowY: "auto" } }, rv[0].error),
			rvStep[0] === 1 ? React.createElement("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
				React.createElement(Btn, { primary: true, onClick: function () { setRvStatus("verified"); setRvNote(reviewNoteFor("verified")); setRvStep(2); } }, "标记「" + rv[0].posText + "」"),
				(rv[0].negativeOptions || []).map(function (opt) {
					return React.createElement("span", { key: opt.status }, React.createElement(Btn, { onClick: function () { setRvStatus(opt.status); setRvNote(reviewNoteFor(opt.status)); setRvStep(2); } }, "标记「" + opt.label + "」"));
				}),
				React.createElement(Btn, { onClick: function () { setRv(null); setNotice("已取消标记——成果保持原状态"); } }, "取消")) : null,
			rvStep[0] === 2 ? React.createElement("div", null,
				React.createElement("div", { style: { fontSize:'var(--dsh-content-font-size-secondary,0.93em)', marginBottom: 4 } }, rvStatus[0] === "verified" ? "复核结论（写入验证记录，至少 40 字）：" : "复核结论（写入验证记录）："),
				React.createElement("textarea", { value: rvNote[0], onChange: function (e) { setRvNote(e.target.value); }, rows: 4, style: { width: "100%", fontSize:'var(--dsh-content-font-size-secondary,0.93em)', padding: 8, borderRadius: 6, border: "1px solid var(--dsw-alias-border-l1,#d9d9de)", boxSizing: "border-box", fontFamily: "inherit" } }),
				React.createElement("div", { style: { display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" } },
					React.createElement(Btn, { primary: true, onClick: function () { if (rvStatus[0] === "verified") { if (String(rvNote[0]).trim().length < 40) { setNotice("转为「已验证」需至少 40 字复核依据（当前 " + String(rvNote[0]).trim().length + " 字）"); return; } setRvStep(3); } else reviewSubmit(rvStatus[0]); } }, rvStatus[0] === "verified" ? "下一步：独立二次评级" : "提交标记"),
					React.createElement(Btn, { onClick: function () { setRvStep(1); } }, "上一步"),
					React.createElement("span", { style: { fontSize:'var(--dsh-content-font-size-secondary,0.93em)', color: "#6e6e73" } }, "当前 " + String(rvNote[0]).trim().length + " 字"))) : null,
			rvStep[0] === 3 ? React.createElement("div", null,
				React.createElement("div", { style: { fontSize:'var(--dsh-content-font-size-secondary,0.93em)', marginBottom: 4 } }, "独立二次评级（未能复现所声称的影响就选 info）："),
				React.createElement("select", { className: "dsh-rtr-select", value: rvSecond[0], onChange: function (e) { setRvSecond(e.target.value); } },
					SECOND_RATING_LIST.map(function (s) { return React.createElement("option", { key: s, value: s }, s); })),
				React.createElement("div", { style: { display: "flex", gap: 8, marginTop: 8 } },
					React.createElement(Btn, { primary: true, onClick: function () { reviewSubmit("verified"); } }, "提交标记"),
					React.createElement(Btn, { onClick: function () { setRvStep(2); } }, "上一步"))) : null) : null),
		scope !== 'all' ? React.createElement('details', { className: 'dsh-task-fold' }, React.createElement('summary', null, '范围与环境'), React.createElement(MetaBar, {
			meta: sesMeta, labels: meta.metaLabels, editing: editingMeta[0], draft: metaDraft[0],
			onEdit: function () { setMetaDraft({ targetLabel: sesMeta.targetLabel, version: sesMeta.version, scope: sesMeta.scope }); setEditingMeta(true); },
			onDraft: function (k, v) { var next = Object.assign({}, metaDraft[0]); next[k] = v; setMetaDraft(next); },
			onSave: saveMeta, onCancel: function () { setEditingMeta(false); }
		})) : null,
		React.createElement('details', { className: 'dsh-task-fold' }, React.createElement('summary', null, '发现统计'), React.createElement(StatsPanel, {
			stats: stats, mode: mode, archetype: meta.archetype, typeLabel: meta.typeLabel,
			severityFilter: severity[0], statusFilter: status[0],
			onSeverity: function (s) { setSeverity(s); },
			onStatus: function (s) { setStatus(s); },
			onTarget: function (t) { setQ(t); }
		})),
		scope !== 'all' && (view.ordinaryReports || []).length ? React.createElement('details', { className: 'dsh-task-fold' },
			React.createElement('summary', null, '普通结果（' + view.ordinaryReports.length + '）'),
			React.createElement('p', { style: { margin: '8px 0', fontSize:'var(--dsh-content-font-size-secondary,0.93em)', color: '#6e6e73' } }, '模型最终答复会进入完整报告包；未独立确认的业务结论不等同于有效漏洞。'),
			view.ordinaryReports.map(function (item) {
				return React.createElement('div', { key: item.id, style: { padding: '8px 0', borderTop: '1px solid color-mix(in srgb,currentColor 10%,transparent)' } },
					React.createElement('div', { style: { fontSize:'var(--dsh-content-font-size-secondary,0.93em)', marginBottom: 4 } },
						(item.complete === false ? '不完整 · ' : '完整 · ') + (item.inProgress ? '本轮执行中 · ' : ''),
						'原件 ' + Number(item.originalChars || item.text.length) + ' 字符',
						item.omittedRange ? ' · 缺少 ' + item.omittedRange.from + '-' + (item.omittedRange.to || '末尾') : ''),
					React.createElement('pre', { className: 'dsh-task-result', style: { whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto' } }, item.preview || item.text));
			})) : null,
		React.createElement("div", { className: "dsh-rtr-toolbar" },
			mode === 'pentest' ? React.createElement('select', { className: 'dsh-rtr-select', 'aria-label': '交付状态', value: delivery[0], onChange: function (e) { setDelivery(e.target.value); setPage(1); setExpanded(''); setSelected({}); } },
				React.createElement('option', { value: 'ready' }, '已确认漏洞'),
				React.createElement('option', { value: 'incomplete' }, '未确认记录'),
				React.createElement('option', { value: 'all' }, '全部记录')) : null,
			scope === 'all' ? React.createElement(RangePicker, { range: range[0], customFrom: customFrom[0], customTo: customTo[0], onChange: function (sel, cf, ct) { setRange(sel); setCustomFrom(cf); setCustomTo(ct); } }) : null,
			meta.archetype !== "assets" && mode !== "av-evasion" && mode !== "ctf-solver" && mode !== "binary-analysis" ? React.createElement("select", { className: "dsh-rtr-select", value: severity[0], onChange: function (e) { setSeverity(e.target.value); } },
				React.createElement("option", { value: "" }, meta.archetype === "ledger" ? "全部优先级" : "全部等级"),
				SEVERITY_ORDER.map(function (s) { return React.createElement("option", { key: s, value: s }, SEVERITY_LABEL[s]); })) : null,
			React.createElement("select", { className: "dsh-rtr-select", value: status[0], onChange: function (e) { setStatus(e.target.value); } },
				React.createElement("option", { value: "" }, "全部状态"),
				(STATUS_OPTIONS_OF[mode] || Object.keys(STATUS_LABEL)).map(function (s) { return React.createElement("option", { key: s, value: s }, statusLabelSetFor(meta.archetype, mode)[s] || STATUS_LABEL[s] || s); })),
			React.createElement("input", { className: "dsh-rtr-search", placeholder: "搜索名称/简介/地址/CWE", value: qDraft[0], onChange: function (e) { setQDraft(e.target.value); } }),
			meta.archetype !== "timeline" ? React.createElement(Btn, { onClick: function () { setGrouped(!grouped[0]); } }, grouped[0] ? "平铺视图" : meta.groupLabel) : null,
			React.createElement("span", { className: "dsh-rtr-spacer" }),
			React.createElement("span", { style: { position: "relative" } },
				React.createElement(Btn, { onClick: function (e) {
					var r = e.currentTarget.getBoundingClientRect();
					setExportMenu(exportMenu[0] ? null : { left: r.left, top: r.top, bottom: r.bottom });
				} }, exportMenu[0] ? "导出 ▴" : "导出 ▾"),
				exportMenu[0] ? React.createElement(PopMenu, { anchor: exportMenu[0], onClose: function () { setExportMenu(null); }, items: [
					{ label: "总览（MD）", title: "当前筛选范围导出 MD 总览", onClick: exportOverview },
					{ label: meta.archetype === "assets" ? "清单（表格）" : "全部（表格）", title: "翻页取全后导出表格", onClick: exportAll },
					{ label: "报告包（HTML）", title: "HTML 报告包，可浏览器打印成 PDF", onClick: exportHtml },
					{ label: "结构化报告（JSON）", title: "机器可读的元数据、统计与全量成果", onClick: exportJson }
				] }) : null),
			React.createElement(Btn, { primary: true, disabled: selectedIds.length === 0, onClick: exportSelected }, selectedIds.length > 0 ? (meta.archetype === "assets" ? "导出选中卡片（" : "导出选中报告（") + selectedIds.length + "）" : (meta.archetype === "assets" ? "导出选中卡片" : "导出选中报告"))),
		listBody,
		!grouped[0] && (view.pages > 1 || view.total > 10) ? React.createElement("div", { className: "dsh-rtr-pager" },
			React.createElement(Btn, { disabled: view.page <= 1, onClick: function () { setPage(view.page - 1); fetchList({ page: view.page - 1 }); } }, "上一页"),
			"第 " + view.page + " / " + view.pages + " 页 · 共 " + view.total + " 条",
			React.createElement(Btn, { disabled: view.page >= view.pages, onClick: function () { setPage(view.page + 1); fetchList({ page: view.page + 1 }); } }, "下一页")) : null);
}


//#region 任务台账大屏（跨会话作战视图：聚合各模式数据）

var SCR_MODE_LABEL = { pentest: "渗透测试", "code-audit": "代码审计" };
var SCR_MODE_VOCAB = ["pentest", "code-audit", "ctf-solver"];

function BigScreen(props) {
	var data = useState(null); var setData = data[1];
	var err = useState(""); var setErr = err[1];
	var clock = useState(""); var setClock = clock[1];
	var range = useState("today"); var setRange = range[1];
	var customFrom = useState(""); var setCustomFrom = customFrom[1];
	var customTo = useState(""); var setCustomTo = customTo[1];
	var scrPg = useState(0); var setScrPg = scrPg[1];
	var scrRef = useRef(null);
	var fsOn = useState(false); var setFsOn = fsOn[1];

	var load = useCallback(function () {
		var rt = rangeIso(range[0], customFrom[0], customTo[0]);
		api("ledger.overview", { scope: "all", from: rt[0], to: rt[1] })
			.then(function (res) { setErr(""); setData((res || {}).overview || null); })
			.catch(function (e) { setData(null); setErr(e && e.message ? e.message : String(e)); });
	}, [range[0], customFrom[0], customTo[0]]);
	useEffect(function () {
		load();
		var t1 = setInterval(load, 15000);
		var t2 = setInterval(function () {
			var d = new Date();
			setClock(d.toLocaleTimeString("zh-CN", { hour12: false }));
		}, 1000);
		return function () { clearInterval(t1); clearInterval(t2); };
	}, [load]);
	useEffect(function () {
		var sync = function () { setFsOn(document.fullscreenElement === scrRef.current); };
		document.addEventListener("fullscreenchange", sync);
		sync();
		return function () { document.removeEventListener("fullscreenchange", sync); };
	}, []);
	var toggleFs = function () {
		var el = scrRef.current;
		if (!el || !el.requestFullscreen) return;
		if (document.fullscreenElement === el) {
			var p = document.exitFullscreen(); if (p && p.catch) p.catch(function () {});
		} else {
			var q = el.requestFullscreen(); if (q && q.catch) q.catch(function () {});
		}
	};

	var ov = data[0];
	if (ov === null) {
		return React.createElement("div", { className: "dsh-rtr-screen", ref: scrRef },
			React.createElement("div", { className: "dsh-scr-inner" },
				React.createElement("div", { className: "dsh-scr-empty" }, err[0] ? "全局数据读取失败：" + err[0] + "（15 秒后自动重试）" : "正在接入全局数据…")));
	}
	var numCard = function (v, label, cls) { return React.createElement("div", { className: "dsh-scr-num " + (cls || "") }, React.createElement("b", null, v), React.createElement("span", null, label)); };
	var total = ov.total || 0;
	var maxMode = Math.max(1, ...SCR_MODE_VOCAB.map(function (m) { return (ov.byMode[m] || 0); }));
	var sevOrder = ["critical", "high", "medium", "low"];
	var sevColors = { critical: "#c2182f", high: "#ff4d4d", medium: "#ffb454", low: "#3a9dff" };
	// 风险口径：严重度统计只计漏洞型四模式（渗透/代审/应急/云）——binary/av 等产物型的默认 medium 不混入漏洞等级口径
	var SEV_SCOPE_MODES = { "pentest": 1, "code-audit": 1, "incident-response": 1, "cloud-security": 1 };
	var sevScoped = { critical: 0, high: 0, medium: 0, low: 0 };
	for (const f of (ov.recent || [])) if (SEV_SCOPE_MODES[f.mode] && sevScoped[f.severity] !== undefined) sevScoped[f.severity] += 1;
	var sevSource = (ov.recent || []).some(function (f) { return SEV_SCOPE_MODES[f.mode]; }) ? sevScoped : ov.bySeverity;
	var sevTotal = sevOrder.reduce(function (n, s) { return n + (sevSource[s] || 0); }, 0) || 1;
	var sevMax = Math.max.apply(null, sevOrder.map(function (s) { return sevSource[s] || 0; })) || 1;
	var acc = 0;
	var donutStops = sevOrder.map(function (s) {
		var from = acc / sevTotal * 100;
		acc += sevSource[s] || 0;
		return sevColors[s] + " " + from.toFixed(1) + "% " + (acc / sevTotal * 100).toFixed(1) + "%";
	}).join(",");
	var stRows = ov.recent || [];
	var PG_SIZE = 12;
	var pgMax = Math.max(0, Math.ceil(stRows.length / PG_SIZE) - 1);
	var pgCur = Math.min(scrPg[0], pgMax);
	var pgRows = stRows.slice(pgCur * PG_SIZE, pgCur * PG_SIZE + PG_SIZE);
	var modeOf = function (m) { return SCR_MODE_LABEL[m] || m; };
	var satSpecs = [
		{ key: "verified", color: "#36f1b0", r: 150, dur: 16, size: 10, spin: 10 },
		{ key: "pending", color: "#ffb454", r: 172, dur: 22, size: 12, spin: 12 },
		{ key: "risk", color: "#ff6b8a", r: 194, dur: 28, size: 14, spin: 14 }
	];
	var orbitParts = [];
	satSpecs.forEach(function (t, ti) {
		var n = Math.min(6, t.key === "risk" ? (sevSource.critical || 0) + (sevSource.high || 0) : (ov.byStatus[t.key] || 0));
		orbitParts.push(React.createElement("div", { key: "track-" + t.key, className: "dsh-scr-orbittrack", style: { "--r": t.r + "px" } }));
		for (var i = 0; i < n; i++) {
			orbitParts.push(React.createElement("div", {
				key: t.key + "-" + i, className: "dsh-scr-orbiter",
				style: { "--r": t.r + "px", color: t.color, animationDuration: t.dur + "s", animationDelay: (-(i / n) * t.dur - ti * 3).toFixed(2) + "s" }
			}, React.createElement("div", { className: "dsh-scr-planet", style: { width: t.size + "px", height: t.size + "px", margin: (t.size / -2) + "px 0 0 " + (t.size / -2) + "px", animationDuration: t.spin + "s" } })));
		}
	});
	var orbitStage = React.createElement("div", { className: "dsh-scr-orbitstage" }, orbitParts);
	var starPos = [[-30, 20, 3], [240, 60, 2], [-15, 150, 4], [215, 175, 3], [40, -30, 1.5], [160, -25, 4], [230, 110, 2]];
	var stars = starPos.map(function (s, i) {
		return React.createElement("div", { key: "star-" + i, className: "dsh-scr-star", style: { left: s[0] + "px", top: s[1] + "px", animationDuration: s[2] + "s" } });
	});
	return React.createElement("div", { className: "dsh-rtr-screen", ref: scrRef },
		React.createElement("div", { className: "dsh-scr-inner" },
			React.createElement("div", { className: "dsh-scr-header" },
				React.createElement("div", { className: "dsh-scr-hleft" },
					React.createElement(Btn, { onClick: toggleFs }, fsOn[0] ? "退出全屏" : "全屏"),
					React.createElement("div", { className: "dsh-scr-live" }, React.createElement("span", { className: "dsh-scr-dot" }), "跨会话汇总")),
				React.createElement("div", { className: "dsh-scr-title" }, "安全测试总览", React.createElement("small", null, "当前所有会话的成果与运行状态")),
				React.createElement("div", { className: "dsh-scr-clockwrap" },
					React.createElement("select", { className: "dsh-scr-range", value: range[0], onChange: function (e) { setRange(e.target.value); setScrPg(0); } },
						[["today", "今日"], ["3d", "近3天"], ["7d", "近7天"], ["30d", "近30天"], ["all", "全部"], ["custom", "自定义"]].map(function (r) { return React.createElement("option", { key: r[0], value: r[0] }, r[1]); })),
					range[0] === "custom" ? React.createElement("input", { type: "date", className: "dsh-scr-date", value: customFrom[0], onChange: function (e) { setCustomFrom(e.target.value); setScrPg(0); } }) : null,
					range[0] === "custom" ? React.createElement("input", { type: "date", className: "dsh-scr-date", value: customTo[0], onChange: function (e) { setCustomTo(e.target.value); setScrPg(0); } }) : null,
					React.createElement("span", { className: "dsh-scr-clock" }, clock[0] || "--:--:--"))),
			React.createElement("div", { className: "dsh-scr-hero" },
				React.createElement("div", { className: "dsh-scr-heronums" },
					numCard(total, "成果总数"),
					numCard(ov.byStatus.verified || 0, "已验证·有效", "is-good")),
					React.createElement("div", { className: "dsh-scr-globewrap" },
						stars,
						React.createElement("div", { className: "dsh-scr-globe" },
							React.createElement("div", { className: "dsh-scr-grat" }),
							React.createElement("div", { className: "dsh-scr-sweep" })),
						orbitStage,
						React.createElement("div", { className: "dsh-scr-herotag" }, (ov.sessions || 0) + " 个会话")),
				React.createElement("div", { className: "dsh-scr-heronums" },
					numCard(ov.byStatus.pending || 0, "进行中·待验证", "is-warn"),
					numCard((function () { // 严重+高危只计漏洞型模式（渗透/代审/应急/云）——ad 权限价值级/av 检出等不混入漏洞等级口径
						var FM = { "pentest": 1, "code-audit": 1, "incident-response": 1, "cloud-security": 1 };
						return (ov.recent || []).reduce(function (n, f) { return n + (FM[f.mode] && (f.severity === "critical" || f.severity === "high") ? 1 : 0); }, 0);
					})(), "严重+高危（漏洞型）", "is-bad"))),
			React.createElement("div", { className: "dsh-scr-grid" },
				React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 16 } },
					React.createElement("div", { className: "dsh-scr-panel" },
						React.createElement("h4", null, "模式成果分布"),
						SCR_MODE_VOCAB.map(function (m, i) {
							return React.createElement("div", { key: m, className: "dsh-scr-bar" },
								React.createElement("span", { className: "lbl" }, modeOf(m).slice(0, 6)),
								React.createElement("span", { className: "track" }, React.createElement("span", { className: "dsh-fill " + (i % 2 ? "is-alt" : ""), style: { display: "block", width: ((ov.byMode[m] || 0) / maxMode * 100) + "%", height: "100%", borderRadius: 4, background: (i === 2 || i === 3 || i === 4) ? "#ffb454" : "#3a9dff", boxShadow: (i === 2 || i === 3 || i === 4) ? "0 0 6px rgba(255,180,84,.5)" : "0 0 6px rgba(58,157,255,.55)" } })),
								React.createElement("span", { className: "val" }, ov.byMode[m] || 0));
						})),
					React.createElement("div", { className: "dsh-scr-panel" },
						React.createElement("h4", null, "状态分布"),
						["pending", "suspect", "verified", "detected", "stuck", "false-positive", "fixed"].map(function (s, i) {
							var names = { pending: "待验证·进行中", suspect: "疑似·未定论", verified: "已验证·有效", detected: "被检出", stuck: "卡点", "false-positive": "证伪·失效", fixed: "已交付·路由" };
							return React.createElement("div", { key: s, className: "dsh-scr-bar" },
								React.createElement("span", { className: "lbl" }, names[s].slice(0, 7)),
								React.createElement("span", { className: "track" }, React.createElement("span", { style: { display: "block", width: ((ov.byStatus[s] || 0) / Math.max(1, total) * 100) + "%", height: "100%", borderRadius: 4, background: i === 1 ? "#36f1b0" : i === 2 ? "#8fb4d9" : i === 3 ? "#3a9dff" : "#ffb454" } })),
								React.createElement("span", { className: "val" }, ov.byStatus[s] || 0));
						}))),
				React.createElement("div", { className: "dsh-scr-center" },
					React.createElement("div", { className: "dsh-scr-panel", style: { flex: 1 } },
						React.createElement("h4", null, "任务流水 · 最新登记"),
						stRows.length === 0
							? React.createElement("div", { className: "dsh-scr-empty" }, "该时间范围内暂无登记数据")
							: React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8, minHeight: 0, flex: 1 } },
								React.createElement("div", { className: "dsh-scr-tablewrap", style: { flex: 1, minHeight: 0 } }, React.createElement("table", { className: "dsh-scr-table" },
									React.createElement("thead", null, React.createElement("tr", null, React.createElement("th", null, "时间"), React.createElement("th", null, "模式"), React.createElement("th", null, "名称"), React.createElement("th", null, "类型"), React.createElement("th", null, "会话"), React.createElement("th", null, "状态"))),
									React.createElement("tbody", null, pgRows.map(function (f) {
										return React.createElement("tr", { key: f.sessionId + "-" + f.mode + "-" + f.id },
											React.createElement("td", null, fmtTime(f.updatedAt).slice(5)),
											React.createElement("td", null, modeOf(f.mode)),
											React.createElement("td", null, f.title),
											React.createElement("td", null, f.type || "-"),
											React.createElement("td", { title: f.sessionId }, f.sessionId ? String(f.sessionId).replace(/^session-/, "").slice(0, 8) : "-"),
											React.createElement("td", null, LABEL_BY_TYPE_MODES[f.mode] ? React.createElement("span", { className: "dsh-scr-sev" }, f.type || "未标注") : React.createElement("span", { className: "dsh-scr-sev dsh-scr-sev-" + f.severity }, SEVERITY_LABEL[f.severity] || f.severity)));
									}))),
								pgMax > 0 ? React.createElement("div", { className: "dsh-rtr-pager", style: { justifyContent: "center" } },
									React.createElement(Btn, { disabled: pgCur <= 0, onClick: function () { setScrPg(pgCur - 1); } }, "上一页"),
									"第 " + (pgCur + 1) + " / " + (pgMax + 1) + " 页 · 共 " + stRows.length + " 条",
									React.createElement(Btn, { disabled: pgCur >= pgMax, onClick: function () { setScrPg(pgCur + 1); } }, "下一页")) : null)))), 
				React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 16 } },
					React.createElement("div", { className: "dsh-scr-panel" },
						React.createElement("h4", null, "风险等级占比"),
						React.createElement("div", { className: "dsh-scr-b3d" },
							React.createElement("div", { className: "dsh-scr-b3stage" },
								React.createElement("div", { className: "dsh-scr-b3floor" }),
								sevOrder.map(function (s, si) {
									var v = Math.max(0.04, (sevSource[s] || 0) / sevMax);
									return React.createElement("div", { key: "b3-" + s, className: "dsh-scr-b3slot", style: { "--x": (si * 3.2 - 4.8) + "em", color: sevColors[s], "--v": v.toFixed(3) } },
										React.createElement("div", { className: "dsh-scr-b3bar" },
											React.createElement("i"), React.createElement("i"), React.createElement("i"), React.createElement("i")),
										React.createElement("div", { className: "dsh-scr-b3num" }, String(sevSource[s] || 0)));
								}))),
						React.createElement("div", { className: "dsh-scr-legend" }, sevOrder.map(function (s) {
							return React.createElement("span", { key: s }, React.createElement("i", { style: { background: sevColors[s] } }), SEVERITY_LABEL[s] + " " + (sevSource[s] || 0));
						}))),
					React.createElement("div", { className: "dsh-scr-panel", style: { flex: 1 } },
						React.createElement("h4", null, "证据等级分布"),
						["impact", "confirmed", "partial", "unknown"].map(function (e, i) {
							var names = { impact: "影响已证", confirmed: "已证实", partial: "部分证据", unknown: "未知" };
							var v = ov.byEvidence[e] || 0;
							return React.createElement("div", { key: e, className: "dsh-scr-bar" },
								React.createElement("span", { className: "lbl" }, names[e]),
								React.createElement("span", { className: "track" }, React.createElement("span", { style: { display: "block", width: (v / Math.max(1, total) * 100) + "%", height: "100%", borderRadius: 4, background: ["#36f1b0", "#7ce8ff", "#ffb454", "#8fb4d9"][i] } })),
								React.createElement("span", { className: "val" }, v));
						}))))));
}

function ComingSoon(props) {
	return React.createElement("div", { className: "dsh-rtr-empty" },
		React.createElement("b", null, props.label + "成果视图将在下一迭代提供"), React.createElement("br", null),
		"当前该模式会话内登记的数据已按「会话 × 模式」隔离保存，不会丢失；",
		React.createElement("br", null),
		"可先在会话中使用 redteam_finding_register 登记成果。");
}

function ProjectFilesPanel(props) {
  var state = useState({ loading: true, snapshot: null, error: '' }), copied = useState(''), revision = useRef(0);
  var workspace = '';
  try {
    var sessionSnapshot = props.sessionsStore.list.getSnapshot().byId[props.sessionId];
    workspace = sessionSnapshot.workingDirectory || sessionSnapshot.cwd || '';
  } catch (_) { /* session not ready */ }
  function load() {
    var request = ++revision.current;
    state[1](function (old) { return { loading: true, snapshot: old.snapshot, error: '' }; });
    if (!props.sessionId) {
      state[1]({ loading: false, snapshot: null, error: '暂时无法读取工作区，请刷新重试。' });
      return Promise.resolve();
    }
    return api('workbench.query', { kind: 'project.files', context: { sessionId: props.sessionId } }).then(function (result) {
      if (!result || result.ok === false) throw Error((result && result.error) || '读取文件失败');
      if (request === revision.current) state[1]({ loading: false, snapshot: result.data, error: '' });
    }).catch(function (failure) { if (request === revision.current) state[1]({ loading: false, snapshot: null, error: failure.message || String(failure) }); });
  }
  useEffect(function () { load(); return function () { revision.current++; }; }, [workspace, props.sessionId]);
  function copy(file) {
    if (!navigator.clipboard || !navigator.clipboard.writeText) { copied[1]('无法复制，请在文件详情中选择路径。'); return; }
    return navigator.clipboard.writeText(file.absPath).then(function () { copied[1](file.absPath); }).catch(function () { copied[1]('无法复制，请在文件详情中选择路径。'); });
  }
  var snapshot = state[0].snapshot, artifacts = snapshot?.artifacts || {}, groups = artifacts.reportGroups || [];
  var files = groups.flatMap(function (group) { return group.files || []; });
  var criteria = snapshot?.criteria || {}, tasks = snapshot?.tasks || [], buckets = snapshot?.flow?.buckets || [];
  return React.createElement('section', { className: 'dsh-task-panel', 'aria-label': '工作区文件' },
    React.createElement('div', { className: 'dsh-task-heading' }, React.createElement('h3', null, '报告与复现材料'), React.createElement(Btn, { disabled: state[0].loading, onClick: load }, '刷新文件')),
    React.createElement('p', null, '来自当前工作区，所有会话共享。文件存在不代表漏洞已确认，确认状态请查看“发现”。'),
    state[0].error ? React.createElement('p', { role: 'alert' }, state[0].error) : null,
    state[0].loading && !snapshot ? React.createElement('p', { role: 'status' }, '正在读取文件…') : null,
    snapshot ? (files.length ? React.createElement('div', { className: 'dsh-task-file-list' }, files.map(function (file) {
      return React.createElement('article', { key: file.absPath, className: 'dsh-task-file' },
        React.createElement('div', { className: 'dsh-task-file-head' }, React.createElement('div', null,
          React.createElement('strong', null, file.title || file.name), React.createElement('small', null, (file.kind === 'poc' ? '复现材料' : '报告') + ' · ' + Math.ceil((file.bytes || 0) / 1024) + ' KB' + (file.mtime ? ' · ' + fmtTime(file.mtime) : ''))),
          React.createElement(Btn, { onClick: function () { return copy(file); } }, copied[0] === file.absPath ? '已复制' : '复制路径')),
        file.target ? React.createElement('p', null, '目标：' + file.target) : null,
        React.createElement('details', null, React.createElement('summary', null, file.relPath), React.createElement('code', null, file.absPath)));
    })) : React.createElement('div', { className: 'dsh-task-empty' }, React.createElement('strong', null, '还没有报告或复现文件'), React.createElement('p', null, '在对话中要求整理报告后，保存到工作区的文件会显示在这里。发现和证据可先在“发现”页查看。'))) : null,
    copied[0] && !files.some(function (file) { return file.absPath === copied[0]; }) ? React.createElement('p', { role: 'status' }, copied[0]) : null,
    snapshot && (snapshot.goal || tasks.length || buckets.length) ? React.createElement('details', { className: 'dsh-task-fold' },
      React.createElement('summary', null, '工作区执行记录'),
      React.createElement('p', null, '以下是工作区保存的记录，可能来自其他会话，不代表本轮实时状态。'),
      snapshot.goal ? React.createElement('p', null, '目标：' + snapshot.goal) : null,
      criteria.total > 0 ? React.createElement('p', null, '已达到 ' + criteria.met + ' / ' + criteria.total + ' 项要求' + (criteria.failed ? '；未达到 ' + criteria.failed + ' 项' : '')) : React.createElement('p', null, '尚未记录完成要求，不能据此判断已完成。'),
      (criteria.openItems || []).map(function (item) { return React.createElement('p', { key: item.id }, '待完成：' + item.text); }),
      tasks.map(function (task) { return React.createElement('details', { key: task.id }, React.createElement('summary', null, (task.summary || '未命名任务') + ' · ' + ({ queued: '待执行', running: '执行中', succeeded: '已结束', failed: '执行失败', interrupted: '已中断', cancelled: '已取消' }[task.state] || '状态未知')),
        task.error || task.result ? React.createElement('p', null, task.error || task.result) : null,
        task.state === 'queued' && !task.ready ? React.createElement('p', null, '等待条件：' + (task.blockedReason || '尚未满足')) : null,
        task.conflicts?.length ? React.createElement('p', { role: 'alert' }, '记录存在不同结果，需要重新核对。') : null,
        React.createElement('small', null, '记录编号：' + task.id)); }),
      buckets.length ? React.createElement('details', null, React.createElement('summary', null, '已保存的 Nday 候选计划（' + buckets.length + '）'), buckets.map(function (bucket) {
        return React.createElement('article', { key: bucket.bucketId, className: 'dsh-task-file' }, React.createElement('strong', null, bucket.product || bucket.entryId || '待识别产品'),
          React.createElement('p', null, bucket.verificationStatus === 'verified' ? '代表目标已有验证记录；仍需逐个核对其他目标的条件。' : bucket.verificationStatus === 'refuted' ? '代表目标验证未成立。' : '尚未验证，不能认定适用。'),
          bucket.gateNote ? React.createElement('p', null, bucket.gateNote) : null,
          React.createElement('small', null, '关联资产：' + (bucket.assetIds || []).join('、')));
      })) : null) : null);
}

// 执行记录页（v6 第 5.3 节）：只列真实发生的调用、时间、结果与用量；请求原文留在测试资料页。
var EXECUTION_RESULT_LABEL = { all: '全部', returned: '已完成', failed: '失败', unknown: '结果未知' };
// 调用状态（v6 第 8.2 节）：比结果分类多一档「取消」，用于显示被用户/任务停止打断的那一次。
var EXECUTION_CALL_STATE_LABEL = { returned: '已完成', failed: '失败', cancelled: '取消', unknown: '结果未知' };
function executionWhen(value) { if (!value) return '—'; var d = new Date(value); return isNaN(d.getTime()) ? String(value) : d.toLocaleString(); }
function executionStatusText(row) {
  var callState = EXECUTION_CALL_STATE_LABEL[row.callState] || EXECUTION_RESULT_LABEL[row.result] || '';
  if (row.kind === 'http') {
    if (row.status != null) return 'HTTP ' + row.status + (row.result === 'failed' ? ' · 失败' : '');
    return callState || '—';
  }
  if (row.status == null) return callState || row.outcome || '—';
  var raw = String(row.status);
  var known = { ok: '成功', returned: '已完成', failed: '失败', error: '失败', cancelled: '已取消', unknown: '结果未知' };
  return known[raw] || raw;
}
function ExecutionPanel(props) {
  var result = useState('all'), page = useState(1);
  var data = useState(null), error = useState(''), loading = useState(false);
  var request = useRef(0);
  function load() {
    var revision = ++request.current; loading[1](true);
    return api('execution.list', { sessionId: props.sessionId, result: result[0], page: page[0], pageSize: 50 })
      .then(function (value) { if (!value.ok) throw Error(value.error || '读取执行记录失败'); if (revision !== request.current) return; data[1](value); error[1](''); })
      .catch(function (failure) { if (revision === request.current) error[1](failure.message); })
      .finally(function () { if (revision === request.current) loading[1](false); });
  }
  useEffect(function () { if (!props.sessionId) return; load(); return function () { request.current++; }; }, [props.sessionId, result[0], page[0]]);
  var current = data[0], counts = (current && current.counts) || { all: 0, returned: 0, failed: 0, unknown: 0 };
  return React.createElement('div', { className: 'dsh-execution' },
    React.createElement('div', { className: 'dsh-execution-tools' },
      React.createElement('div', { className: 'dsh-materials-types', role: 'tablist' }, ['all', 'returned', 'failed', 'unknown'].map(function (key) {
        return React.createElement('button', { key: key, type: 'button', role: 'tab', 'aria-selected': result[0] === key, className: result[0] === key ? 'is-active' : '',
          onClick: function () { page[1](1); result[1](key); } }, EXECUTION_RESULT_LABEL[key] + (current ? ' ' + (counts[key] || 0) : ' —'));
      })),
      current ? React.createElement('span', { className: 'dsh-execution-usage' }, '工具 ' + current.usage.toolCalls + ' 次 · 模型 ' + current.usage.modelCalls + ' 次' + (current.usage.unknownUsageCalls ? '（其中 ' + current.usage.unknownUsageCalls + ' 次用量未知）' : '')) : null,
      React.createElement('button', { type: 'button', disabled: !props.onOpenMaterials, onClick: function () { if (props.onOpenMaterials) props.onOpenMaterials(); } }, '查看原始请求')),
    React.createElement('details', { className: 'dsh-execution-scope' }, React.createElement('summary', null, '这里记录什么？'),
      React.createElement('ul', null,
        React.createElement('li', null, '网站请求以实际回执为准；工具内部发了多少请求，可能无法统计。'),
        React.createElement('li', null, '模型调用显示宿主返回的用量；未知就写“未知”，不会按 0 计算。'),
        React.createElement('li', null, '“已完成”只说明请求完成，不等于存在漏洞。'))),
    error[0] ? React.createElement('div', { role: 'alert' }, error[0], ' ',
      React.createElement('button', { type: 'button', disabled: loading[0], onClick: load }, '重试')) : null,
    loading[0] && !current ? React.createElement('p', { role: 'status' }, '正在读取执行记录…') : null,
    loading[0] && current ? React.createElement('p', { role: 'status' }, '正在更新执行记录…') : null,
    current && current.total === 0 ? React.createElement('p', { className: 'dsh-materials-empty' }, '还没有执行记录。正常调用、失败和检查未见异常都会保存在这里；异常结论在“发现”。') : null,
    current && current.total > 0 ? React.createElement('p', { className: 'saker-panel-hint' }, '这里只记录真实发生的操作。完成请求不等于发现漏洞。') : null,
    current && current.total > 0 ? React.createElement('table', { className: 'dsh-materials-table saker-ui-table' },
      React.createElement('thead', null, React.createElement('tr', null, ['时间', '做了什么', '对象', '状态', '账号', '用时', '依据'].map(function (label) { return React.createElement('th', { key: label }, label); }))),
      React.createElement('tbody', null, current.rows.map(function (row) {
        var action = row.kind === 'http' ? 'HTTP ' + (row.host || row.target || '')
          : row.kind === 'model' ? '模型回合' + (row.usage && row.usage.totalTokens != null ? ' · ' + Number(row.usage.totalTokens).toLocaleString() + ' tokens' : ' · 用量未知')
            : '工具 ' + (row.toolName || '未知');
        var target = row.kind === 'http' ? (row.host || row.target || '—') : '—';
        var ref = row.kind === 'http' ? (row.requestRef || row.id) : (row.callId || row.id);
        var refLabel = row.kind === 'http' ? '请求记录' : row.kind === 'model' ? '模型回合' : '工具调用';
        return React.createElement('tr', { key: row.id },
          React.createElement('td', null, executionWhen(row.at)),
          React.createElement('td', { title: action }, action),
          React.createElement('td', { title: row.target }, target),
          React.createElement('td', null, executionStatusText(row)),
          // 身份引用（v6 第 8.1 节）：只显示本任务请求记录里的身份名，秘密仍留在账号管理。
          React.createElement('td', { title: row.identity || '' }, row.identity || '—'),
          React.createElement('td', null, row.elapsedMs == null ? '—' : row.elapsedMs + ' ms'),
          React.createElement('td', { title: ref, className: 'dsh-execution-ref' }, refLabel));
      })) ) : null,
    current && current.total > 0 ? React.createElement('div', { className: 'dsh-materials-foot' },
      React.createElement('span', null, '共 ' + current.total + ' 条'),
      React.createElement('button', { type: 'button', disabled: page[0] <= 1, onClick: function () { page[1](Math.max(1, page[0] - 1)); } }, '上一页'),
      React.createElement('span', null, '第 ' + page[0] + ' 页'),
      React.createElement('button', { type: 'button', disabled: !current.more, onClick: function () { page[1](page[0] + 1); } }, '下一页')) : null,
    current && current.note ? React.createElement('small', null, current.note) : null);
}
// 测试资料页（v6 第 5.4 节）：只列当前会话的资产/请求/文件；不显示知识文章与账号；
// 引用到输入框只更新输入内容，不发送、不标记为已读取、不调用模型。
var MATERIALS_TYPE_LABEL = { all: '全部', asset: '网站与端口', request: '请求', file: '文件' };
function materialsColumns(kind) {
if (kind === 'asset') return ['主机/地址', '协议', '端口', '产品线索', '来源', '范围', '模型是否读过'];
if (kind === 'request') return ['HTTP 方法', '主机/路径', '账号', '响应', '状态', '模型是否读过'];
return ['名称', '来源', '线索', '状态', '模型是否读过'];
}
function materialsCells(row) {
  var m = row.meta || {};
// 「模型是否读过」只认模型真的读过原文那一次；本地浏览详情单独标「本地看过」，
// 引用到输入框仍显示「尚未读取」（v6 第 5.4 节：本地查看与模型收到分别保存）。
var readCell = row.modelRead ? '已读过' : (row.viewedAt ? '本地看过' : '尚未读取');
if (row.kind === 'asset') return [m.host || row.title, m.protocol || '—', m.port || '—', m.product || '—', m.source || '—', m.inScope ? '范围内' : (m.origin === 'inventory' ? '工作区账本' : '范围外'), readCell];
if (row.kind === 'request') return [m.method || '—', (m.host || '') + (m.path || ''), m.account || '—', m.status == null ? '—' : String(m.status), m.valid ? '正常' : '待确认', readCell];
  var detail = m.hints != null ? m.hints + ' 条' : '—';
  if (m.format) detail += ' · ' + String(m.format).toUpperCase();
  if (m.entries != null) detail += ' · ' + m.entries + ' 条目';
  // 坏记录要看得见（v6 第 10.3 节 E09）：解析不了的条目单独计数，不能只报"已索引"。
  if (m.broken) detail += ' · ' + m.broken + ' 条坏记录';
  if (m.bytes != null) detail += ' · ' + m.bytes + ' 字节';
return [row.title, m.source || '—', detail, m.broken ? '有坏记录' : (m.unresolved ? '存在未解析' : '已索引'), readCell];
}
function MaterialsPanel(props) {
  var type = useState('all'), query = useState(''), page = useState(1), read = useState('all'), includeWorkspace = useState(false);
  var data = useState(null), error = useState(''), loading = useState(false), notice = useState('');
  var detail = useState(null);
  // 「有 N 条新记录」（v6 第 5.7 节）：轮询发现新行时只提示数量，不跳页、不打断正在看的内容。
  var newCount = useState(0);
  var request = useRef(0);
  function load() {
    var revision = ++request.current; loading[1](true);
    return api('materials.list', { sessionId: props.sessionId, type: type[0], query: query[0], read: read[0], page: page[0], pageSize: 50, includeWorkspace: includeWorkspace[0] })
      .then(function (result) {
        if (!result.ok) throw Error(result.error || '读取测试资料失败');
        if (revision !== request.current) return;
        // 同一筛选下的增量比较：只统计真的新行，行本身靠 key 原地更新，不整页重绘。
        var previous = data[0];
        if (previous && previous.type === result.type && previous.read === result.read && page[0] === 1) {
          var fresh = Number(result.total || 0) - Number(previous.total || 0);
          newCount[1](fresh > 0 ? fresh : 0);
        } else newCount[1](0);
        data[1](result); error[1]('');
      })
      .catch(function (failure) { if (revision === request.current) error[1](failure.message); })
      .finally(function () { if (revision === request.current) loading[1](false); });
  }
  useEffect(function () { if (!props.sessionId) return; load(); return function () { request.current++; }; }, [props.sessionId, type[0], read[0], page[0], includeWorkspace[0]]);
  // 轻量轮询（v6 第 5.7 节）：只读本地列表接口，不调模型；发现新行时由上面的比较给出数量提示。
  useEffect(function () {
    if (!props.sessionId || typeof setInterval !== 'function') return;
    var timer = setInterval(function () { if (!loading[0]) load(); }, 8000);
    return function () { clearInterval(timer); };
  }, [props.sessionId, type[0], read[0], page[0], includeWorkspace[0]]);
  // 引用文案：可读名称 + 内部引用 + 必要定位信息。列表行与详情主操作共用一处，
  // 保证送进输入框的东西完全一致，且只含被选中的这一条（不含全库清单）。
  function referenceText(item) {
    var title = item.title || (item.kind === 'request' ? item.endpoint : item.kind === 'asset' ? item.url : item.name) || item.id;
    var bytes = item.kind === 'file' ? (item.meta && item.meta.bytes != null ? item.meta.bytes : item.totalBytes) : null;
    return '[' + (MATERIALS_TYPE_LABEL[item.kind] || item.kind) + '] ' + title + '（' + item.id + '）'
      + (bytes != null ? ' · ' + bytes + ' 字节' : '');
  }
  function reference(item) {
    try {
      if (!props.inputActions || typeof props.inputActions.insertText !== 'function') throw Error('输入框暂不可用，请复制后再粘贴');
      // 宿主插入 API 需要先取插入点（revision 保护的 span），再连同它一起插入；
      // 只调 insertText(text) 会读到 undefined 的 span 并抛错。引用只改输入框，不发送、不记为已读取。
      var span = typeof props.inputActions.captureInsertion === 'function' ? props.inputActions.captureInsertion() : undefined;
      if (!props.inputActions.insertText(referenceText(item), span)) throw Error('输入框正在变化，请稍后重试');
      notice[1]('已引用到输入框，发送前请补充要问的问题。');
    } catch (failure) { notice[1](failure.message); }
  }
  function openDetail(row) {
    error[1]('');
    return api('materials.detail', { sessionId: props.sessionId, kind: row.kind, id: row.id })
      .then(function (result) {
        if (!result.ok) throw Error(result.error || '读取资料详情失败');
        detail[1](result.detail);
        // 本地查看与模型读取分开记录（v6 第 5.4 节）：读取详情保持纯读，这里显式补一条本地状态；
        // 失败不打扰用户（本地标记丢了也不影响看内容）。
        return api('materials.viewed', { sessionId: props.sessionId, kind: row.kind, id: row.id })
          .then(function () { return load(); })
          .catch(function () {});
      })
      .catch(function (failure) { error[1](failure.message); });
  }
  // 大文件分段续读（v6 第 9.3 节）：按 nextOffset 取下一段并**追加**到已读内容，
  // 而不是只给前 6000 字节；一次一段，避免把整文件灌进上下文。
  function nextSegment() {
    var current = detail[0];
    if (!current || current.kind !== 'file' || current.nextOffset === null || current.nextOffset === undefined) return Promise.resolve();
    error[1]('');
    return api('materials.detail', { sessionId: props.sessionId, kind: 'file', id: current.id, offset: current.nextOffset, limit: current.limit })
      .then(function (result) {
        if (!result.ok) throw Error(result.error || '继续读取失败');
        var next = result.detail;
        detail[1](Object.assign({}, next, { preview: (current.preview || '') + (next.preview || ''), offset: current.offset, nextOffset: next.nextOffset }));
      })
      .catch(function (failure) { error[1](failure.message); });
  }
  // 从本任务移除（v6 第 5.4 节）：默认动作只移除**引用**，不删磁盘原文；
  // 仍被问题引用时由服务端拒绝，界面如实显示原因。
  function removeCurrent() {
    var currentDetail = detail[0];
    if (!currentDetail || currentDetail.kind !== 'file') return Promise.resolve();
    error[1]('');
    return api('materials.remove', { sessionId: props.sessionId, id: currentDetail.id })
      .then(function (result) {
        if (!result.ok) throw Error(result.error || '移除失败');
        detail[1](null); notice[1](result.note || '已从本任务移除');
        return load();
      })
      .catch(function (failure) { error[1](failure.message); });
  }
  var current = data[0], counts = (current && current.counts) || { all: 0, asset: 0, request: 0, file: 0 };
  return React.createElement('div', { className: 'dsh-materials' },
    React.createElement('div', { className: 'dsh-materials-tools' },
      React.createElement('div', { className: 'dsh-materials-types', role: 'tablist' }, ['all', 'asset', 'request', 'file'].map(function (key) {
        return React.createElement('button', { key: key, type: 'button', role: 'tab', 'aria-selected': type[0] === key, className: type[0] === key ? 'is-active' : '',
          onClick: function () { page[1](1); type[1](key); } }, MATERIALS_TYPE_LABEL[key] + ' ' + (counts[key] || 0));
      })),
      React.createElement('input', { type: 'search', 'aria-label': '搜索测试资料', placeholder: '搜索地址、账号或文件名', value: query[0], onChange: function (e) { query[1](e.target.value); }, onKeyDown: function (e) { if (e.key === 'Enter') { page[1](1); load(); } } }),
      React.createElement('button', { type: 'button', 'aria-label': '搜索测试资料', onClick: function () { page[1](1); load(); } }, '搜索'),
      // 读取状态筛选（v6 第 5.4 节）：用户明确筛选「AI 读过的内容」时展示实际使用记录；
      // 本地看过与模型收到分开，互不冒充。
      React.createElement('label', { className: 'dsh-materials-read' }, '读取状态',
        React.createElement('select', { 'aria-label': '读取状态筛选', value: read[0], onChange: function (event) { page[1](1); read[1](event.target.value); } },
          [['all', '全部'], ['model', '模型读过'], ['local', '本地看过'], ['unread', '都没读过']].map(function (option) {
            return React.createElement('option', { key: option[0], value: option[0] }, option[1]);
          }))),
      React.createElement('button', { type: 'button', className: 'is-primary', disabled: !props.onAddMaterials, title: props.onAddMaterials ? '' : '请用输入框左侧的附件按钮', onClick: function () { if (props.onAddMaterials) props.onAddMaterials(); } }, '添加文件')),
    current && current.workspace && current.workspace.count ? React.createElement('div', { className: 'dsh-materials-workspace', role: 'status' },
      React.createElement('div', null, React.createElement('strong', null, '工作区其他资产 ' + current.workspace.count),
        React.createElement('span', null, '来自工作区资产账本，不属于当前任务范围；展开只用于查找线索。')),
      React.createElement('button', { type: 'button', 'aria-expanded': includeWorkspace[0], onClick: function () { page[1](1); includeWorkspace[1](!includeWorkspace[0]); } }, includeWorkspace[0] ? '收起' : '展开查看')) : null,
    // 新记录只提示数量（v6 第 5.7 节）：不自动跳页、不打断正在看的内容。
    newCount[0] > 0 ? React.createElement('div', { className: 'dsh-materials-new', role: 'status' },
      React.createElement('span', null, '有 ' + newCount[0] + ' 条新资料'),
      React.createElement('button', { type: 'button', onClick: function () { newCount[1](0); return load(); } }, '刷新查看')) : null,
    error[0] ? React.createElement('p', { role: 'alert' }, error[0]) : null,
    loading[0] && !current ? React.createElement('p', { role: 'status' }, '正在读取测试资料…') : null,
    current && current.total === 0 ? React.createElement('div', { className: 'dsh-materials-empty' },
      // 只有真的没有任何资料时才说“添加…开始检查”；类型/搜索/读取状态筛掉全部时要说“没有匹配”。
      React.createElement('p', null, (query[0] || type[0] !== 'all' || read[0] !== 'all') ? '没有匹配的资料。' : '添加网站请求或代码，Saker 就能从这些内容开始检查。'),
      React.createElement('small', null, '支持原始 HTTP、HAR、curl 文本、JS、源码与扫描导出；保存原文，按需要读取。')) : null,
    current && current.total > 0 ? React.createElement('table', { className: 'dsh-materials-table saker-ui-table' },
      React.createElement('thead', null, React.createElement('tr', null,
        React.createElement('th', null, '类型'), materialsColumns(current.rows[0] ? current.rows[0].kind : 'asset').map(function (label) { return React.createElement('th', { key: label }, label); }), React.createElement('th', null, '操作'))),
      React.createElement('tbody', null, current.rows.map(function (row) {
        return React.createElement('tr', { key: row.kind + '-' + row.id }, React.createElement('td', null, MATERIALS_TYPE_LABEL[row.kind] || row.kind),
          materialsCells(row).map(function (cell, index) { return React.createElement('td', { key: index, title: String(cell) }, String(cell)); }),
          React.createElement('td', null,
            React.createElement('button', { type: 'button', onClick: function () { openDetail(row); } }, '查看'),
            React.createElement('button', { type: 'button', onClick: function () { reference(row); } }, '引用到输入框')));
      })) ) : null,
    detail[0] ? React.createElement('div', { className: 'dsh-materials-detail', 'aria-label': '资料详情' },
      React.createElement('div', { className: 'dsh-chat-panel-head' }, React.createElement('strong', null, detail[0].kind === 'request' ? '请求详情' : detail[0].kind === 'file' ? '文件详情' : '资产详情'),
        // 详情主操作是“引用到输入框”（v6 第 5.4 节）：只追加引用到输入框，不发送、不记为已读取。
        React.createElement('div', { className: 'dsh-chat-actions' },
          React.createElement('button', { type: 'button', onClick: function () { reference(detail[0]); } }, '引用到输入框'),
          React.createElement('button', { type: 'button', onClick: function () { detail[1](null); } }, '关闭'))),
      detail[0].kind === 'request' ? React.createElement('div', null,
        React.createElement('p', null, detail[0].endpoint + ' · 账号 ' + detail[0].authContext + (detail[0].valid ? ' · 正常对照' : '')),
        React.createElement('div', { className: 'dsh-materials-panes' },
          React.createElement('label', null, '请求原文', React.createElement('pre', null, detail[0].request || '（未保存）')),
          React.createElement('label', null, '响应原文', React.createElement('pre', null, detail[0].response || '（未保存）'))),
        detail[0].relatedChecks && detail[0].relatedChecks.length ? React.createElement('small', null, '关联入口检查 ' + detail[0].relatedChecks.length + ' 条') : null,
        detail[0].relatedFindings && detail[0].relatedFindings.length ? React.createElement('small', null, '关联问题 ' + detail[0].relatedFindings.length + ' 条：' + detail[0].relatedFindings.map(function (f) { return f.id; }).join('、')) : null) : null,
      detail[0].kind === 'asset' ? React.createElement('div', null,
        React.createElement('p', null, detail[0].url + ' · ' + (detail[0].inScope ? '范围内' : '范围外') + (detail[0].reachable ? ' · 可达' : '')),
        detail[0].relatedRequests && detail[0].relatedRequests.length ? React.createElement('ul', null, detail[0].relatedRequests.map(function (row) { return React.createElement('li', { key: row.id + row.revision }, row.endpoint + ' · ' + row.authContext); })) : React.createElement('small', null, '还没有关联请求')) : null,
      detail[0].kind === 'file' ? React.createElement('div', null,
        React.createElement('p', null, detail[0].name + ' · ' + detail[0].source),
        detail[0].missing ? React.createElement('small', null, '本地原文已不可读，仅保留索引记录。') : React.createElement('div', null,
          React.createElement('pre', { className: 'dsh-materials-preview' }, (detail[0].preview || '') + (detail[0].nextOffset !== null && detail[0].nextOffset !== undefined ? '\n…（下面还有内容）' : '')),
          detail[0].nextOffset !== null && detail[0].nextOffset !== undefined
            ? React.createElement('button', { type: 'button', onClick: nextSegment }, '继续读取（已读 ' + detail[0].nextOffset + ' / ' + (detail[0].totalBytes === null || detail[0].totalBytes === undefined ? '未知' : detail[0].totalBytes) + ' 字节）')
            : null),
        detail[0].relatedFindings && detail[0].relatedFindings.length ? React.createElement('small', null, '关联问题 ' + detail[0].relatedFindings.length + ' 条：' + detail[0].relatedFindings.map(function (f) { return f.id; }).join('、')) : null,
        detail[0].identities && detail[0].identities.length ? React.createElement('small', null, '身份待关联：这份原文带 ' + detail[0].identities.map(function (item) { return item.kind; }).join('、') + '，尚未关联到账号；秘密不在资料里。') : null,
        // 坏记录可定位（v6 第 10.5 节 UI05）：说清是第几条、为什么，而不是只报一个总数。
        detail[0].importSummary && detail[0].importSummary.broken ? React.createElement('small', { role: 'status' },
          '导入时 ' + detail[0].importSummary.entries + ' 条里有 ' + detail[0].importSummary.broken + ' 条坏记录：'
          + detail[0].importSummary.brokenEntries.map(function (item) { return '第 ' + item.index + ' 条（' + item.reason + '）'; }).join('、')
          + (detail[0].importSummary.broken > detail[0].importSummary.brokenEntries.length ? ' 等' : '')) : null,
        React.createElement('button', { type: 'button', onClick: removeCurrent, title: '只从本任务移除引用，不删磁盘原文' }, '从本任务移除')) : null,
      React.createElement('small', null, detail[0].note)) : null,
    current && current.total > 0 ? React.createElement('div', { className: 'dsh-materials-foot' },
      React.createElement('span', null, '共 ' + current.total + ' 条'),
      React.createElement('button', { type: 'button', disabled: page[0] <= 1, onClick: function () { page[1](Math.max(1, page[0] - 1)); } }, '上一页'),
      React.createElement('span', null, '第 ' + page[0] + ' 页'),
      React.createElement('button', { type: 'button', disabled: !current.more, onClick: function () { page[1](page[0] + 1); } }, '下一页')) : null,
    notice[0] ? React.createElement('p', { role: 'status' }, notice[0]) : null);
}
function ResultsView(props) {
	var sessionId = props.sessionId != null ? String(props.sessionId) : "";
	// 任务工作区里的「添加测试资料」走模块级桥接打开输入框上方的同一个面板（v6 第 5.3/5.4 节）。
	var openMaterialsPanel = props.onAddMaterials || function () { if (materialsPanelBridge.open) materialsPanelBridge.open(); };
	var mode = useState(props.defaultMode === 'code-audit' ? 'code-audit' : 'pentest');
	// 测试结果默认先回答“现在在验证什么”，执行流水、发现和资料按需切换。
	var area = useState(props.fixedArea || (props.defaultMode === 'code-audit' ? 'findings' : 'research'));
	var historyMode = useState('pentest');
	var counts = useState({}), countError = useState(''), countRequest = useRef(0);
	var history = area[0] === 'history';
	var refreshCounts = useCallback(function () {
		if (!sessionId || (area[0] !== 'findings' && area[0] !== 'history')) return;
		var revision = ++countRequest.current;
		return api(history ? 'counts.all' : 'counts.session', { sessionId: sessionId })
			.then(function (raw) { if (revision !== countRequest.current) return; if (raw.ok === false) throw Error(raw.error || '读取数量失败'); counts[1](raw.counts || {}); countError[1](''); })
			.catch(function (failure) { if (revision === countRequest.current) countError[1](failure.message); });
	}, [sessionId, area[0]]);
	useEffect(function () { refreshCounts(); return function () { countRequest.current++; }; }, [refreshCounts]);
	if (!sessionId) return React.createElement('div', { className: 'dsh-rtr-skel' }, '等待会话上下文…');
	return React.createElement('div', { className: 'dsh-task-workspace' },
		countError[0] ? React.createElement('p', { role: 'alert' }, countError[0]) : null,
		React.createElement('div', { className: 'dsh-task-nav dsh-task-result-nav', role: 'tablist', 'aria-label': '测试结果分类' },
			[['research', '正在验证'], ['execution', '执行记录'], ['findings', '发现'], ['materials', '附件']].map(function (entry) {
				return React.createElement(Btn, { key: entry[0], 'aria-current': area[0] === entry[0] ? 'page' : undefined,
					onClick: function () { area[1](entry[0]); } }, entry[1]);
			})),
		area[0] === 'materials' ? React.createElement(MaterialsPanel, { key: sessionId + '-materials', sessionId: sessionId, inputActions: props.inputActions, onAddMaterials: openMaterialsPanel }) : null,
		area[0] === 'research' ? React.createElement(ResearchView, { key: sessionId + '-research', sessionId: sessionId,
			onShowExecution: function () { area[1]('execution'); }, onShowFindings: function () { area[1]('findings'); } }) : null,
		area[0] === 'execution' ? React.createElement(ExecutionPanel, { key: sessionId + '-execution', sessionId: sessionId, onOpenMaterials: function () { area[1]('materials'); } }) : null,
		area[0] === 'findings' || history ? React.createElement('div', null,
			React.createElement('div', { className: 'dsh-task-scope' }, React.createElement('strong', null, history ? '所有会话的历史记录' : '本会话发现'),
				React.createElement('select', { className: 'saker-ui-select', 'aria-label': history ? '历史记录类型' : '发现类型', value: history ? historyMode[0] : mode[0],
					onChange: function (event) { (history ? historyMode : mode)[1](event.target.value); } },
					MODES.map(function (item) { return React.createElement('option', { key: item.id, value: item.id }, (item.id === 'pentest' ? '渗透测试' : '代码审计') + ' · ' + (counts[0][item.id] || 0)); }),
					history ? React.createElement('option', { value: '__ledger__' }, '历史统计') : null)),
			history && historyMode[0] === '__ledger__' ? React.createElement(BigScreen, { sessionId: sessionId })
				: React.createElement(ModePage, { key: sessionId + '-' + (history ? 'history-' + historyMode[0] : mode[0]),
					sessionId: sessionId, mode: history ? historyMode[0] : mode[0], scope: history ? 'all' : 'session',
					onRefreshCounts: refreshCounts, onAddMaterials: openMaterialsPanel,
					onOpenExecution: function () { area[1]('execution'); } })) : null);
}

var REDTEAM_MANAGER_UI_NAMESPACE = "redteam-manager-ui";

//#region Saker security workbench (main page + sidebar entry)
var h = React.createElement;
var SAKER_WB_NAV = [
	{ group: "测试", items: [
		{ id: "dashboard", label: "概览", icon: "dashboard" }, { id: "tasks", label: "测试任务", icon: "tasks" },
		{ id: "findings", label: "发现", icon: "findings" }, { id: "traffic", label: "请求", icon: "traffic" },
		{ id: "assets", label: "资产与文件", icon: "assets" }, { id: "conversation", label: "对话", icon: "conversation" },
	] },
	{ group: "资源", items: [
		{ id: "modules", label: "测试模块", icon: "modules" }, { id: "roles", label: "协作角色", icon: "roles" },
		{ id: "knowledge", label: "知识库", icon: "knowledge" }, { id: "capabilities", label: "工具清单", icon: "capabilities" },
	] },
	{ group: "运行", items: [{ id: "attention", label: "待办事项", icon: "attention" }, { id: "logs", label: "执行日志", icon: "logs" }] },
];
var SAKER_WB_TASK_TABS = [
	{ id: "overview", label: "概览" }, { id: "execution", label: "执行记录" }, { id: "exploration", label: "测试路径" },
	{ id: "findings", label: "发现" }, { id: "assets", label: "资产与文件" },
];
var SAKER_WB_CSS = __SAKER_WB_CSS__;
var SAKER_DESIGN_CSS = __SAKER_DESIGN_CSS__;
function installDesignSystemStyles() {
	if (typeof document === "undefined") return function () {};
	var id = "saker-design-system-css";
	var existing = document.getElementById(id);
	if (existing) return function () {};
	var tag = document.createElement("style");
	tag.id = id; tag.textContent = SAKER_DESIGN_CSS;
	document.head.appendChild(tag);
	return function () { try { tag.remove(); } catch (_) {} };
}
function installWorkbenchStyles() {
	if (typeof document === "undefined") return function () {};
	var id = "saker-workbench-css";
	var existing = document.getElementById(id);
	if (existing) return function () {};
	var tag = document.createElement("style");
	tag.id = id; tag.textContent = SAKER_WB_CSS;
	document.head.appendChild(tag);
	return function () { try { tag.remove(); } catch (_) {} };
}
function SakerFalcon(props) {
	return h("svg", { viewBox: "0 0 64 64", width: props.size || 22, height: props.size || 22, "aria-hidden": "true" },
		h("path", { fill: "currentColor", fillRule: "evenodd", d: "M7 35 18 18Q24 10 36 10h9l12 11-10 3-2 8-10-5-9 4-9 8Zm27-18 10 2-6 4Z" }),
		h("path", { fill: "currentColor", d: "m20 34 17-5-7 12-18 13 6-14-11 3Z" }));
}
function wbStateLabel(state) {
	return ({ active: "进行中", paused: "已暂停", stopped: "已停止", completed: "已结束", ready: "待开始" })[state] || state || "未知";
}
function wbStateTone(state) {
	return state === "active" ? "ok" : state === "paused" ? "warn" : state === "stopped" ? "bad" : "";
}
function attentionLabel(kind) {
	return ({ "root-blocker": "任务阻塞", cleanup: "清理待确认", command: "命令待确认" })[kind] || "待处理";
}
function wbVerificationLabel(state) {
	return ({ verified: "已验证", candidate: "待确认", "needs-recheck": "待复核", "not-reproduced": "未复现", fixed: "已处置" })[state] || state || "未知";
}
function wbTime(value) {
	if (!value) return "—";
	var n = typeof value === "number" ? value : Date.parse(value);
	if (!Number.isFinite(n)) return String(value).slice(0, 19);
	try { return new Date(n).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }); }
	catch (_) { return String(value).slice(0, 19); }
}
function wbReasonLabel(value) {
	var text = String(value || "");
	if (!text) return "无阻塞";
	if (text === "time_budget_exhausted") return "时限已到";
	if (text === "tool_budget_exhausted") return "工具次数已用完";
	if (text === "turn_ended") return "当前回合已结束，等待下一步";
	if (text === "plan_complete") return "当前测试流程已完成，仍有未测部分需单独查看";
	if (text === "queue_complete") return "队列已完成";
	if (text === "interaction_confirmation_required") return "等待你的确认";
	if (text === "cancelled") return "已取消";
	if (text.startsWith("paused:")) return "等待用户：" + text.slice(7);
	if (text.startsWith("model_budget:")) return "模型额度不足：" + text.slice(13);
	return text;
}
var scopeContextCache = {};
function scopeContextFor(sessionId) {
	var id = String(sessionId || "");
	if (!id) return Promise.resolve({});
	var cached = scopeContextCache[id];
	if (cached && Date.now() - cached.at < 30000) return Promise.resolve(cached.value);
	return api("workbench.query", { kind: "scope.resolve", context: { sessionId: id } })
		.then(function (response) {
			var data = response && response.data;
			var value = data ? {
				entrySessionId: id,
				projectKey: data.projectKey,
				workspaceKey: data.workspaceKey,
				scopeRevision: data.scopeRevision,
			} : {};
			scopeContextCache[id] = { at: Date.now(), value: value };
			return value;
		})
		.catch(function () { return {}; });
}
function wbStableJson(value) {
	if (value === null || value === undefined) return "null";
	if (typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return "[" + value.map(wbStableJson).join(",") + "]";
	return "{" + Object.keys(value).sort().map(function (key) {
		return JSON.stringify(key) + ":" + wbStableJson(value[key]);
	}).join(",") + "}";
}
function wbQueryKey(kind, context, filter, page) {
	return kind + "|" + wbStableJson(context || {}) + "|" + wbStableJson(filter || {}) + "|" + wbStableJson(page || {});
}
function wbIntentKey(kind, context, payload) {
	return kind + "|" + wbStableJson(context || {}) + "|" + wbStableJson(payload || {});
}
function wbNewCommandId() {
	return "cmd-" + ((typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2)));
}
function wbResponseError(response, fallback) {
	if (response && response.ok === false) {
		var failure = Error(response.error || fallback || "操作未完成");
		failure.code = response.code;
		failure.commandId = response.commandId;
		failure.status = response.status;
		failure.decided = true;
		if (["command-in-flight", "HOST_RESULT_UNKNOWN", "command-state-unknown"].indexOf(String(response.code || "")) >= 0) {
			failure.unknown = true;
			failure.decided = false;
		}
		return failure;
	}
	if (response && response.error && response.ok !== true) {
		var other = Error(typeof response.error === "string" ? response.error : (response.error.message || fallback || "操作未完成"));
		other.code = response.code;
		other.decided = true;
		return other;
	}
	return null;
}
function wbErrorText(error) {
	var message = String(error && error.message ? error.message : (error || ""));
	if (/failed to fetch|fetch failed|networkerror|load failed|network request failed/i.test(message))
		return "无法连接本机 Saker 接口（Host 或网络未就绪）；本次没有拿到结果。";
	if (/timeout|timed out|AbortError/i.test(message))
		return "请求超时：结果可能尚未返回，不要直接重复发送同一操作。";
	if (/commandId is already running|already running in another/i.test(message))
		return "同一命令仍在处理中；请先确认原命令结果，不要重复发送。";
	if (/HOST_RESULT_UNKNOWN|结果未知/i.test(message))
		return "上一次操作结果未知；请先确认原命令，确认未受理后再重试。";
	return message;
}
// 同一个“用户意图”只允许一个 commandId。传输失败时记录为结果未知；
// 重试先查询原 ID，服务端没有记录才用同一个 ID 重发，避免重复外部执行。
var wbCommandRecords = {};
var WB_COMMAND_STORAGE_PREFIX = "saker.command.v1.";
function wbCommandHash(value) {
	var text = String(value || ""), hash = 0x811c9dc5;
	for (var index = 0; index < text.length; index += 1) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0") + "-" + text.length.toString(16);
}
function wbCommandPayloadHasSecret(value, depth) {
	if (depth > 5 || value === null || value === undefined) return false;
	if (Array.isArray(value)) return value.some(function (item) { return wbCommandPayloadHasSecret(item, (depth || 0) + 1); });
	if (typeof value !== "object") return false;
	return Object.keys(value).some(function (key) {
		return /(?:token|secret|password|passwd|authorization|cookie|api[-_]?key|credential)/i.test(key)
			|| wbCommandPayloadHasSecret(value[key], (depth || 0) + 1);
	});
}
function wbLoadPersistedCommand(intent) {
	try {
		var raw = window.localStorage.getItem(WB_COMMAND_STORAGE_PREFIX + wbCommandHash(intent));
		var value = raw ? JSON.parse(raw) : null;
		if (!value || value.intent !== intent || !value.commandId || value.status !== "unknown") return null;
		// Persist only the non-secret recovery pointer. The current intent
		// supplies the context and payload again; the Host checks their hashes.
		return { commandId: value.commandId, status: "unknown", kind: value.kind, promise: null };
	} catch (_error) { return null; }
}
function wbPersistUnknownCommand(intent, commandId, kind, context, payload) {
	try {
		if (wbCommandPayloadHasSecret(context, 0) || wbCommandPayloadHasSecret(payload, 0)) return;
		window.localStorage.setItem(WB_COMMAND_STORAGE_PREFIX + wbCommandHash(intent), JSON.stringify({
			intent: intent, commandId: commandId, kind: kind, status: "unknown", savedAt: Date.now(),
		}));
	} catch (_error) { /* storage unavailable: keep in-memory unknown state */ }
}
function wbClearPersistedCommand(intent) {
	try { window.localStorage.removeItem(WB_COMMAND_STORAGE_PREFIX + wbCommandHash(intent)); } catch (_error) {}
}
function wbDispatchCommand(commandId, kind, context, payload) {
	return api("workbench.command", { commandId: commandId, kind: kind, context: context, payload: payload || {} })
		.then(function (response) {
			var failure = wbResponseError(response, "命令未完成");
			if (failure) throw failure;
			return response && Object.prototype.hasOwnProperty.call(response, "result") && response.result !== undefined ? response.result : response;
		});
}
function wbReconcileCommand(commandId, kind, context, payload) {
	return api("workbench.query", { kind: "command.status", context: Object.assign({}, context, { commandId: commandId }) })
		.then(function (response) {
			var failure = wbResponseError(response, "无法确认原命令");
			if (failure) throw failure;
			var data = response && response.data;
			if (!data || !data.status || data.status === "unknown") return { action: "dispatch" };
			if (data.status === "completed" || data.status === "accepted") return { action: "reuse", value: data.result };
			if (data.status === "rejected") {
				var rejected = Error(data.error || "原命令已被拒绝");
				rejected.code = "command-rejected";
				rejected.decided = true;
				rejected.commandId = commandId;
				throw rejected;
			}
			var pending = Error(data.error || "原命令仍在处理中；稍后再查询，不要重复发送");
			pending.unknown = true;
			pending.commandId = commandId;
			pending.intent = wbIntentKey(kind, context, payload);
			throw pending;
		})
		.catch(function (error) {
			if (error && (error.decided === true || error.unknown === true)) throw error;
			// 查询本身失败时无法证明命令未受理；只能复用同一个 ID 交给服务端去重。
			return { action: "dispatch" };
		});
}
function wbCommand(ctx, kind, context, payload) {
	var base = context || {};
	var intent = wbIntentKey(kind, base, payload);
	var existing = wbCommandRecords[intent] || wbLoadPersistedCommand(intent);
	if (existing && existing.status === "inflight" && existing.promise) return existing.promise;
	if (existing && existing.status === "done" && Date.now() - Number(existing.doneAt || 0) < 5000) return Promise.resolve(existing.value);
	if (existing && existing.status === "failed") { delete wbCommandRecords[intent]; existing = null; }
	var commandId = existing && existing.commandId ? existing.commandId : wbNewCommandId();
	var sessionId = String(base.entrySessionId || base.sessionId || "");
	var entry = existing || { intent: intent, commandId: commandId, status: "inflight", context: base, payload: payload || {}, promise: null };
	var wasUnknown = entry.status === "unknown";
	entry.status = "inflight"; entry.context = base; entry.payload = payload || {};
	wbCommandRecords[intent] = entry;
	var promise = (sessionId ? scopeContextFor(sessionId) : Promise.resolve({})).then(function (scope) {
		var full = Object.assign({}, base, scope);
		if (wasUnknown) {
			return wbReconcileCommand(commandId, kind, full, payload).then(function (outcome) {
				if (outcome.action === "reuse") return outcome.value;
				return wbDispatchCommand(commandId, kind, full, payload);
			});
		}
		return wbDispatchCommand(commandId, kind, full, payload);
	})
		.then(function (value) {
			entry.status = "done"; entry.value = value; entry.doneAt = Date.now();
			wbClearPersistedCommand(intent);
			return value;
		})
		.catch(function (error) {
			if (error && error.unknown === true) {
				entry.status = "unknown";
				error.commandId = error.commandId || commandId;
				error.intent = intent;
				wbPersistUnknownCommand(intent, commandId, kind, base, payload);
				throw error;
			}
			var reachedServer = error && (error.decided === true || error.status !== undefined || error.code === "command-rejected");
			if (reachedServer) {
				entry.status = "failed";
				if (wbCommandRecords[intent] === entry) delete wbCommandRecords[intent];
				wbClearPersistedCommand(intent);
			} else {
				entry.status = "unknown";
				error.unknown = true;
				error.commandId = commandId;
				error.intent = intent;
				wbPersistUnknownCommand(intent, commandId, kind, base, payload);
			}
			throw error;
		});
	entry.promise = promise;
	return promise;
}
function wbCommandPendingError(commandId, message) {
	var error = Error(message || "原命令结果仍未知");
	error.unknown = true;
	error.commandId = commandId;
	return error;
}
function useWorkbenchQuery(kind, context, tick, enabled, options) {
	var filter = (options && options.filter) || {};
	var page = (options && options.page) || { limit: 50 };
	var key = wbQueryKey(kind, context, filter, page);
	var state = useState({ key: key, loading: enabled !== false, data: null, error: "", meta: null, kind: kind, stale: false });
	var value = state[0], setValue = state[1];
	var requestSeq = useRef(0);
	useEffect(function () {
		if (enabled === false) {
			requestSeq.current += 1;
			setValue({ key: key, loading: false, data: null, error: "", meta: null, kind: kind, stale: false });
			return;
		}
		var current = ++requestSeq.current;
		setValue(function (previous) {
			var same = previous && previous.key === key;
			return { key: key, loading: true, data: same ? previous.data : null, error: "", meta: same ? previous.meta : null, kind: kind, stale: same && !!previous.data };
		});
		var base = context || {};
		var sessionId = String(base.entrySessionId || base.sessionId || "");
		(sessionId ? scopeContextFor(sessionId) : Promise.resolve({}))
			.then(function (scope) {
				return api("workbench.query", { kind: kind, context: Object.assign({}, base, scope), filter: filter, page: page });
			})
			.then(function (response) {
				if (current !== requestSeq.current) return;
				var failure = wbResponseError(response, "读取失败");
				if (failure) throw failure;
				setValue({ key: key, loading: false, data: response.data, error: "", meta: response, kind: kind, stale: false });
			})
			.catch(function (error) {
				if (current !== requestSeq.current) return;
				setValue(function (previous) {
					var same = previous && previous.key === key;
					return { key: key, loading: false, data: same ? previous.data : null, error: wbErrorText(error),
						meta: same ? previous.meta : null, kind: kind, stale: same && !!previous.data };
				});
			});
		return function () { if (requestSeq.current === current) requestSeq.current += 1; };
	}, [key, tick, enabled]);
	if (value.key !== key) return { key: key, loading: enabled !== false, data: null, error: "", meta: null, kind: kind, stale: false };
	return value;
}
function SakerWorkbenchIcon() {
	return h("span", { "data-saker-workbench-icon": "1", style: { display: "inline-flex", width: "32px", height: "32px", alignItems: "center", justifyContent: "center", color: "var(--dsw-alias-state-business-primary,#4b74d9)" } },
		h(SakerFalcon, { size: 22 }));
}
var SAKER_WB_NAV_V2 = [
	{ group: "测试", items: [
		{ id: "dashboard", label: "概览", icon: "dashboard" },
		{ id: "tasks", label: "测试任务", icon: "tasks" },
		{ id: "evidence", label: "发现与证据", icon: "findings" },
		{ id: "attention", label: "待办事项", icon: "attention" },
	] },
	{ group: "资源", items: [
		{ id: "resources", label: "配置与资料", icon: "modules" },
		{ id: "logs", label: "执行日志", icon: "logs" },
	] },
];
var SAKER_EVIDENCE_TABS_V2 = [
	{ id: "findings", label: "发现" },
	{ id: "traffic", label: "HTTP 记录" },
	{ id: "assets", label: "资产与文件" },
];
var SAKER_RESOURCE_TABS_V2 = [
	{ id: "modules", label: "测试模块" },
	{ id: "roles", label: "协作角色" },
	{ id: "knowledge", label: "知识库" },
	{ id: "capabilities", label: "工具清单" },
];
var SAKER_TASK_TABS_V2 = [
	{ id: "overview", label: "概览" },
	{ id: "execution", label: "执行记录" },
	{ id: "exploration", label: "测试路径" },
	{ id: "findings", label: "发现" },
	{ id: "assets", label: "资产与文件" },
];
function wbBusinessLabel(state) {
	return ({
		running: "运行中", "waiting-user": "待你处理", "turn-ended": "本回合结束",
		paused: "已暂停", ended: "已结束", stopped: "已停止", failed: "失败", ready: "待开始",
	})[state] || state || "未知";
}
function wbBusinessTone(state) {
	if (state === "running") return "ok";
	if (state === "waiting-user" || state === "paused") return "warn";
	if (state === "stopped" || state === "failed") return "bad";
	return "";
}
function wbDurationText(ms) {
	if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return "用时未知";
	var seconds = Math.max(0, Math.floor(Number(ms) / 1000));
	if (seconds < 60) return "不足 1 分钟";
	var minutes = Math.floor(seconds / 60);
	if (minutes < 60) return minutes + " 分钟";
	var hours = Math.floor(minutes / 60);
	return hours + " 小时 " + (minutes % 60) + " 分";
}
function wbAttentionKindLabel(kind) {
	return ({
		"root-blocker": "任务受阻", "scope-confirmation": "范围确认", "scope-change": "范围变更",
		cleanup: "释放未确认", command: "命令待确认",
	})[kind] || "待办事项";
}
function wbGraphKindLabel(kind) {
	return ({ root: "测试任务", work: "工作项", workflow: "测试流程", step: "步骤", attempt: "尝试",
		asset: "资产", request: "请求", endpoint: "接口", check: "检查项", receipt: "HTTP 回执", finding: "发现", material: "文件", file: "文件" })[kind] || kind || "节点";
}
function wbNodeStateLabel(state) {
	return ({ paused: "已暂停", running: "运行中", active: "进行中", waiting: "等待中", queued: "排队中",
		starting: "启动中", proposed: "已提出", stopped: "已停止", released: "已释放",
		"cleanup-failed": "释放未确认", failed: "失败", pending: "待开始",
		verified: "已验证", unverified: "未验证", candidate: "候选",
		done: "已完成", "needs-recheck": "待复核",
		settled: "已结算", reserved: "等待发送", dispatched: "传输中", cancelled: "未发送",
		current: "当前可用", historical: "历史可读", invalid: "完整性未通过",
		completed: "已完成", "not-hit": "未命中", blocked: "受阻",
		captured: "已采集", "not-tested": "未测", unknown: "未知" })[state] || state || "未知";
}
function wbExecutionKindLabel(kind) {
	return ({ http: "HTTP 请求", model: "模型回合", attempt: "工作尝试", role: "角色实例" })[kind] || kind || "—";
}
function wbEvidenceRefKindLabel(kind) {
	return ({ request: "请求", execution: "执行回执", receipt: "执行回执", http: "执行回执",
		file: "文件", material: "文件", asset: "资产", source: "来源", command: "命令" })[kind] || kind || "引用";
}
function wbEvidenceQualityLabel(quality) {
	return ({ current: "当前可用", historical: "历史可读", invalid: "完整性未通过",
		unknown: "未核", "not-applicable": "不适用" })[quality] || quality || "未核";
}
function wbSelectionKey(ref) {
	return ref ? [ref.kind, ref.rootId || "", ref.id || ""].join(":") : "";
}
function wbRootTitle(row) {
	return String((row && row.title) || (row && row.rootId) || "未命名任务");
}
function SakerWorkbenchNav(props) {
	var collapsed = props.collapsed;
	return h("nav", { className: "saker-wb-nav", "aria-label": "Saker 工作区导航" },
		h("div", { className: "saker-wb-brand" }, h(SakerFalcon, { size: 22 }),
			h("span", { className: "saker-wb-brand-name" }, "Saker"),
			h("button", { type: "button", className: "saker-wb-navtoggle",
				title: collapsed ? "展开导航" : "收起导航", "aria-label": collapsed ? "展开导航" : "收起导航",
				onClick: props.onToggle }, h(SakerNavIcon, { name: collapsed ? "expand" : "collapse", size: 14 }))),
		SAKER_WB_NAV_V2.map(function (group) {
			return h("div", { key: group.group, className: "saker-wb-navgroup" },
				h("div", { className: "saker-wb-group" }, group.group),
				group.items.map(function (item) {
					return h("button", { key: item.id, type: "button", title: item.label,
						"aria-label": item.label,
						className: "saker-wb-navbtn" + (props.page === item.id ? " active" : ""),
						"aria-current": props.page === item.id ? "page" : undefined,
						onClick: function () { props.onNavigate(item.id); } },
						h(SakerNavIcon, { name: item.icon, size: 16 }),
						h("span", { className: "saker-wb-navlabel" }, item.label));
				}));
		}),
		h("div", { className: "saker-wb-navfoot" },
			h("span", null, collapsed ? "本地" : "本地工作台"),
			collapsed ? null : h("small", null, "只读查询，不自动启动模型")));
}
function SakerDetailFrame(props) {
	return h("aside", { className: "saker-wb-inspector", "aria-label": props.label || "详情" },
		h("div", { className: "saker-wb-inspector-head" },
			h("div", { className: "saker-wb-inspector-title" },
				props.eyebrow ? h("div", { className: "saker-wb-eyebrow" }, props.eyebrow) : null,
				h("h2", { tabIndex: -1, ref: props.headingRef }, props.title || "详情")),
			h("div", { className: "saker-wb-row" },
				props.back ? h("button", { type: "button", className: "saker-wb-btn", onClick: props.back }, "返回上一条") : null,
				h("button", { type: "button", className: "saker-wb-btn", onClick: props.onClose }, "关闭"))),
		props.tabs ? h("div", { className: "saker-wb-inspect-tabs", role: "tablist", "aria-label": "详情分区" }, props.tabs) : null,
		h("div", { className: "saker-wb-inspector-body" }, props.children),
		props.footer ? h("div", { className: "saker-wb-inspector-foot" }, props.footer) : null);
}
function SakerTaskTableV2(props) {
	var rows = props.rows || [];
	var compact = props.compact === true;
	var columns = compact ? ["测试任务 / 范围", "状态", "结果 / 下一步"] : ["测试任务 / 范围", "状态", "结果 / 下一步", "资源释放", "更新时间"];
	var widths = compact ? ["54%", "18%", "28%"] : ["38%", "14%", "28%", "10%", "10%"];
	if (!rows.length) return h("div", { className: "saker-wb-empty" }, props.emptyText || "还没有测试任务。回到会话输入目标即可开始；这里不会自动启动模型。");
	return h("div", { className: "saker-wb-table-wrap" },
		h("table", { className: "saker-wb-table saker-wb-task-table" },
			h("colgroup", null, widths.map(function (width, index) {
				return h("col", { key: index, style: { width: width }, className: !compact && index >= 3 ? "saker-col-secondary" : "" });
			})),
			h("thead", null, h("tr", null, columns.map(function (label, index) {
				return h("th", { key: label, className: !compact && index >= 3 ? "saker-col-secondary" : "" }, label);
			}))),
			h("tbody", null, rows.map(function (row) {
				var key = "task:" + row.rootId;
				var next = row.attentionReason || (row.reason ? wbReasonLabel(row.reason) :
				row.cleanupState !== "clear" ? "并行任务待释放" :
					"验证 " + (row.outcomeSummary?.verified || 0) + " · 待确认 " + (row.outcomeSummary?.pending || 0));
				return h("tr", { key: row.rootId, tabIndex: 0, "data-saker-row": key,
					className: props.selectedRoot === row.rootId ? "selected" : "",
					onClick: function () { props.onOpen(row.rootId); },
					onKeyDown: function (event) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); props.onOpen(row.rootId); } } },
					h("td", null, h("div", { className: "saker-wb-cell-main" }, wbRootTitle(row)),
						h("div", { className: "saker-wb-cell-sub" },
							[row.targetSummary, row.taskKind, "会话 " + String(row.rootId).slice(-8)].filter(Boolean).join(" · "))),
					h("td", null, h("span", { className: "saker-wb-chip " + wbBusinessTone(row.businessState) }, wbBusinessLabel(row.businessState))),
					h("td", null, next),
					compact ? null : h("td", { className: "saker-col-secondary" }, row.cleanupState === "clear" ? "已核对" : row.cleanupState === "pending" ? "清理中" : "待确认"),
					compact ? null : h("td", { className: "saker-col-secondary" }, wbTime(row.updatedAt)));
			}))));
}
function SakerTaskListToolbar(props) {
	return h(SakerListToolbar, { text: props.text, onText: props.onText, placeholder: "搜索测试任务、目标或会话 ID",
		filters: h("select", { "aria-label": "按状态筛选测试任务", value: props.state,
			onChange: function (event) { props.onState(event.target.value); } },
			h("option", { value: "" }, "全部状态"),
			[["running", "运行中"], ["waiting-user", "待你处理"], ["turn-ended", "本回合结束"], ["paused", "已暂停"],
				["ended", "已结束"], ["stopped", "已停止"], ["failed", "失败"]].map(function (item) {
				return h("option", { key: item[0], value: item[0] }, item[1]);
			})),
		dirty: !!(props.text || props.state), onClear: props.onClear, loadedLabel: props.loadedLabel });
}
function SakerPageIntro(props) {
	return h("div", { className: "saker-wb-intro" },
		h("div", null,
			props.eyebrow ? h("div", { className: "saker-wb-eyebrow" }, props.eyebrow) : null,
			h("h1", { className: "saker-wb-page-title" }, props.title),
			props.subtitle ? h("p", { className: "saker-wb-page-sub" }, props.subtitle) : null),
		props.actions ? h("div", { className: "saker-wb-intro-actions" }, props.actions) : null);
}
function SakerDetailTabs(props) {
	return props.items.map(function (item) {
		return h("button", { key: item.id, type: "button", role: "tab",
			className: "saker-wb-inspect-tab" + (props.active === item.id ? " active" : ""),
			"aria-selected": props.active === item.id ? "true" : "false",
			onClick: function () { props.onChange(item.id); } }, item.label);
	});
}
function SakerWorkbenchPageLegacy(props) {
	var ctx = props.ctx;
	var viewState = useState("dashboard"), view = viewState[0], setView = viewState[1];
	var rootState = useState(""), rootId = rootState[0], setRootId = rootState[1];
	var tabState = useState("overview"), tab = tabState[0], setTab = tabState[1];
	var explorationNodeState = useState(null), explorationNode = explorationNodeState[0], setExplorationNode = explorationNodeState[1];
	var coverageModeState = useState(false), coverageMode = coverageModeState[0], setCoverageMode = coverageModeState[1];
	var tickState = useState(0), tick = tickState[0], setTick = tickState[1];
	var busyState = useState(""), busy = busyState[0], setBusy = busyState[1];
	var noticeState = useState(""), notice = noticeState[0], setNotice = noticeState[1];
	var selectedFindingState = useState(""), selectedFinding = selectedFindingState[0], setSelectedFinding = selectedFindingState[1];
	var selectedFindingRootState = useState(""), selectedFindingRoot = selectedFindingRootState[0], setSelectedFindingRoot = selectedFindingRootState[1];
	var taskFindingTextState = useState(""), taskFindingText = taskFindingTextState[0], setTaskFindingText = taskFindingTextState[1];
	var taskFindingVerifyState = useState(""), taskFindingVerify = taskFindingVerifyState[0], setTaskFindingVerify = taskFindingVerifyState[1];
	var confirmState = useState(null), confirmAction = confirmState[0], setConfirmAction = confirmState[1];
	var selectedGlobalExecutionState = useState(null), selectedGlobalExecution = selectedGlobalExecutionState[0], setSelectedGlobalExecution = selectedGlobalExecutionState[1];
	var selectedAssetState = useState(null), selectedAsset = selectedAssetState[0], setSelectedAsset = selectedAssetState[1];
	var unknownCommandState = useState(null), unknownCommand = unknownCommandState[0], setUnknownCommand = unknownCommandState[1];
	var listStatesHook = useState({}), listStates = listStatesHook[0], setListStates = listStatesHook[1];
	var navPrefState = useState(function () { try { return localStorage.getItem("saker.wb.nav") || ""; } catch (_error) { return ""; } });
	var navPref = navPrefState[0], setNavPref = navPrefState[1];
	var rootElState = useState(null), rootEl = rootElState[0], setRootEl = rootElState[1];
	var widthState = useState(0), containerWidth = widthState[0], setContainerWidth = widthState[1];
	useEffect(function () {
		if (!rootEl || typeof ResizeObserver === "undefined") return;
		var observer = new ResizeObserver(function (entries) {
			var width = entries && entries[0] ? entries[0].contentRect.width : 0;
			setContainerWidth(width);
		});
		observer.observe(rootEl);
		return function () { observer.disconnect(); };
	}, [rootEl]);
	var autoCollapsed = containerWidth > 0 && containerWidth < 980;
	var navCollapsed = navPref === "collapsed" || (navPref !== "expanded" && autoCollapsed);
	function toggleNav() {
		var next = navCollapsed ? "expanded" : "collapsed";
		setNavPref(next);
		try { localStorage.setItem("saker.wb.nav", next); } catch (_error) { /* 导航偏好失败不影响读取 */ }
	}
	function listStateFor(name) {
		return Object.assign({ text: "", status: "", severity: "", verification: "", kind: "", limit: 50, cursor: "", stack: [] }, listStates[name] || {});
	}
	function patchList(name, patch) {
		setListStates(function (previous) {
			var next = Object.assign({}, previous);
			next[name] = Object.assign({}, next[name] || {}, patch);
			return next;
		});
	}
	function resetList(name, patch) { patchList(name, Object.assign({ cursor: "", stack: [] }, patch || {})); }
	function pageOf(state) { return state && state.meta && state.meta.page ? state.meta.page : null; }
	function setPage(name, direction, state) {
		var current = listStateFor(name);
		var page = pageOf(state);
		if (!page) return;
		if (direction === "next" && page.nextCursor) {
			patchList(name, { stack: current.stack.concat([current.cursor]), cursor: page.nextCursor });
			return;
		}
		if (direction === "prev" && current.stack.length) {
			patchList(name, { stack: current.stack.slice(0, -1), cursor: current.stack[current.stack.length - 1] || "" });
		}
	}
	var roots = useWorkbenchQuery("roots.list", {}, tick, true, { filter: {}, page: { limit: 100 } });
	var rootRows = (roots.data || []);
	var queryKind = view === "dashboard" ? "dashboard.summary" : view === "tasks" ? "roots.list" :
		view === "findings" ? "findings.list" : view === "traffic" ? "traffic.list" : view === "assets" ? "assets.list" :
		view === "roles" ? "roles.list" : view === "capabilities" ? "capabilities.list" :
		view === "attention" ? "attention.list" : "logs.list";
	var scopedViews = ["findings", "traffic", "assets", "logs", "capabilities", "modules", "roles", "knowledge"];
	var globalContext = { rootId: scopedViews.indexOf(view) >= 0 ? rootId : "" };
	var globalList = listStateFor("global." + view);
	var globalFilter = { text: globalList.text };
	if (view === "tasks") globalFilter.state = globalList.status;
	if (view === "findings") { globalFilter.verification = globalList.verification; globalFilter.severity = globalList.severity; }
	if (view === "traffic") globalFilter.status = globalList.status;
	if (view === "capabilities") globalFilter.kind = globalList.kind;
	var global = useWorkbenchQuery(queryKind, globalContext, tick,
		view !== "task" && view !== "modules" && view !== "knowledge",
		{ filter: globalFilter, page: { limit: globalList.limit, cursor: globalList.cursor } });
	var dashboardAttention = useWorkbenchQuery("attention.list", {}, tick, view === "dashboard",
		{ filter: {}, page: { limit: 4 } });
	var detail = useWorkbenchQuery("roots.detail", { rootId: rootId }, tick, view === "task" && !!rootId);
	var taskExecutionList = listStateFor("task.execution");
	var execution = useWorkbenchQuery("execution.records", { rootId: rootId }, tick, view === "task" && tab === "execution",
		{ filter: { text: taskExecutionList.text, kind: taskExecutionList.kind }, page: { limit: taskExecutionList.limit, cursor: taskExecutionList.cursor } });
	var executionSelected = useState(null), selectedExecution = executionSelected[0], setSelectedExecution = executionSelected[1];
	var executionDetail = useWorkbenchQuery("execution.detail",
		{ rootId: rootId, executionId: selectedExecution ? selectedExecution.id : "", executionKind: selectedExecution ? selectedExecution.kind : "" },
		tick, !!selectedExecution);
	var exploration = useWorkbenchQuery("exploration.graph", { rootId: rootId }, tick, view === "task" && tab === "exploration");
	var taskAssetsList = listStateFor("task.assets");
	var taskAssets = useWorkbenchQuery("assets.list", { rootId: rootId }, tick, view === "task" && tab === "assets",
		{ filter: { text: taskAssetsList.text }, page: { limit: taskAssetsList.limit, cursor: taskAssetsList.cursor } });
	var coverage = useWorkbenchQuery("assets.coverage", { rootId: rootId }, tick, view === "task" && tab === "assets" && coverageMode);
	var findingDetailState = useWorkbenchQuery("findings.detail", { rootId: selectedFindingRoot || rootId, findingId: selectedFinding }, tick, !!selectedFinding);
	var globalExecutionDetail = useWorkbenchQuery("execution.detail",
		{ rootId: selectedGlobalExecution ? selectedGlobalExecution.rootId : "", executionId: selectedGlobalExecution ? selectedGlobalExecution.id : "",
			executionKind: selectedGlobalExecution ? selectedGlobalExecution.kind : "" },
		tick, !!selectedGlobalExecution);
	function refresh() { setTick(function (value) { return value + 1; }); }
	function openRoot(id) { setRootId(id); setTab("overview"); setView("task"); setSelectedFinding(""); setSelectedFindingRoot(""); setSelectedGlobalExecution(null); setNotice(""); }
	function openConversation() {
		if (!rootId) { setNotice("先在任务列表选择一个任务，再返回原会话；这里不会按第一条任务猜测。"); return; }
		openConversationFor(rootId);
	}
	function openConversationFor(id) {
		if (id && ctx.uiWorkspace && typeof ctx.uiWorkspace.openSession === "function") {
			try { ctx.uiWorkspace.openSession(id); return; } catch (error) { setNotice("无法返回原会话：" + (error.message || error)); return; }
		}
		setNotice("当前 Host 没有可用的会话打开接口；请从左侧原生会话列表打开该任务。");
	}
	function run(kind, payload, after, contextOverride) {
		if (busy) return;
		setBusy(kind); setNotice("");
		var effectiveRootId = (contextOverride && contextOverride.rootId) || rootId;
		var commandContext = Object.assign({ rootId: effectiveRootId, sessionId: effectiveRootId, generation: detail.data?.root?.generation || 0 }, contextOverride || {});
		wbCommand(ctx, kind, commandContext, payload)
			.then(function (result) { setBusy(""); if (after) after(result); refresh(); })
			.catch(function (error) {
				setBusy("");
				if (error && error.unknown) {
					setUnknownCommand({ commandId: error.commandId || "", intent: error.intent || "", kind: kind, context: commandContext, payload: payload || {}, after: after });
					setNotice("结果未知：命令 " + (error.commandId || "未记录") + " 已保留。先确认原命令结果，不要重复发起。");
					return;
				}
				setNotice(wbErrorText(error));
			});
	}
	function runForOwner(owner, kind, payload) {
		var row = rootRows.find(function (item) { return item.rootId === owner; });
		if (!owner || !row) {
			setNotice("无法确认这条记录所属任务；请先打开所属任务再执行动作，工作台不会猜测 root。");
			return;
		}
		run(kind, payload, null, { rootId: owner, sessionId: owner, generation: row.generation || 0 });
	}
	function reconcileUnknown() {
		if (!unknownCommand || busy) return;
		setBusy("command.reconcile"); setNotice("正在查询原命令 " + (unknownCommand.commandId || "") + "…");
		wbReconcileCommand(unknownCommand.commandId, unknownCommand.kind, unknownCommand.context, unknownCommand.payload)
			.then(function (outcome) {
				if (outcome.action === "reuse") {
					setUnknownCommand(null); setBusy(""); setNotice("原命令已完成；没有重复执行。");
					if (unknownCommand.after) unknownCommand.after(outcome.value);
					refresh();
					return null;
				}
				return wbDispatchCommand(unknownCommand.commandId, unknownCommand.kind, unknownCommand.context, unknownCommand.payload)
					.then(function (value) {
						setUnknownCommand(null); setBusy(""); setNotice("原命令确认未被受理，已用同一命令 ID 继续执行。");
						if (unknownCommand.after) unknownCommand.after(value);
						refresh();
					});
			})
			.catch(function (error) { setBusy(""); setNotice(wbErrorText(error)); });
	}
	var nav = h("nav", { className: "saker-wb-nav", "aria-label": "Saker 工作台导航" },
		h("div", { className: "saker-wb-brand" }, h(SakerFalcon, { size: 22 }), h("span", { className: "saker-wb-brand-name" }, "Saker"),
			h("button", { type: "button", className: "saker-wb-navtoggle", title: navCollapsed ? "展开导航" : "收起导航",
				"aria-label": navCollapsed ? "展开导航" : "收起导航", onClick: toggleNav }, h(SakerNavIcon, { name: navCollapsed ? "expand" : "collapse", size: 14 }))),
		SAKER_WB_NAV.map(function (group) {
			return h("div", { key: group.group },
				h("div", { className: "saker-wb-group" }, group.group),
				group.items.map(function (item) {
					return h("button", { key: item.id, type: "button",
						className: "saker-wb-navbtn" + (view === item.id ? " active" : ""),
						title: item.label,
						onClick: function () {
							if (item.id === "conversation") { openConversation(); return; }
							setView(item.id); setSelectedFinding(""); setSelectedFindingRoot(""); setSelectedGlobalExecution(null); setNotice("");
						} },
						h(SakerNavIcon, { name: item.icon || item.id, size: 15 }), h("span", { className: "saker-wb-navlabel" }, item.label));
				}));
		}));
	if (view === "task") {
		var task = detail.data || {};
		var root = task.root || {};
		var actions = h("div", { className: "saker-wb-row" },
		h("button", { className: "saker-wb-btn", onClick: function () { setView("tasks"); setRootId(""); } }, "返回测试任务"),
			h("button", { className: "saker-wb-btn", onClick: openConversation }, "返回会话"),
			root.canActions?.pause ? h("button", { className: "saker-wb-btn", disabled: !!busy, onClick: function () { run("root.pause", { reason: "工作台暂停" }); } }, "暂停") : null,
			root.canActions?.resume ? h("button", { className: "saker-wb-btn", disabled: !!busy, onClick: function () { run("root.resume", { reason: "工作台恢复" }); } }, "继续") : null,
			root.canActions?.continue ? h("button", { className: "saker-wb-btn primary", disabled: !!busy, onClick: function () { run("root.continue", { reason: "工作台明确继续" }); } }, "明确继续") : null,
			root.canActions?.stop ? h("button", { className: "saker-wb-btn danger", disabled: !!busy, onClick: function () { setConfirmAction({ kind: "root.stop" }); } }, "停止本轮") : null);
		var head = h("header", { className: "saker-wb-head" },
			h("div", { style: { minWidth: 0 } },
				h("div", { className: "saker-wb-title" }, root.title || "任务"),
				h("div", { className: "saker-wb-sub" }, (root.targetSummary && root.targetSummary !== root.title ? root.targetSummary + " · " : "") +
					wbStateLabel(root.controlState) + " · 第 " + (root.generation || 1) + " 代")),
			h("div", { className: "saker-wb-spacer" }), actions);
		var body;
		if (tab === "overview") {
			var counts = task.overview?.counts || {};
			body = h("div", null,
				h("div", { className: "saker-wb-kpis" },
					h("div", { className: "saker-wb-kpi" }, h("b", null, counts.assets || 0), h("span", null, "资产")),
					h("div", { className: "saker-wb-kpi" }, h("b", null, counts.requests || 0), h("span", null, "请求")),
					h("div", { className: "saker-wb-kpi" }, h("b", null, (task.findings || []).filter(function (row) { return row.verificationState === "verified"; }).length), h("span", null, "已验证发现")),
					h("div", { className: "saker-wb-kpi" }, h("b", null, counts.needsUser || 0), h("span", null, "待处理前提"))),
				h("div", { className: "saker-wb-card" }, h("h3", null, "当前状态"), h("div", null, wbReasonLabel(task.status?.reason)),
					h("div", { className: "saker-wb-sub" }, "工具 " + (task.cost?.toolCalls ?? task.policy?.used?.toolCalls ?? 0) + " 次 · 模型 " + (task.cost?.modelCalls ?? task.policy?.used?.modelCalls ?? 0) + " 次 · 时限 " + (task.policy?.budget?.minutes ?? "不限") + " 分钟")),
				(task.overview?.gaps || []).length ? h("div", { className: "saker-wb-card" }, h("h3", null, "具体缺口"),
					h("ul", null, task.overview.gaps.map(function (gap, index) { return h("li", { key: index }, gap.endpoint + "： " + gap.missing.join("、")); }))) : null,
				h("div", { className: "saker-wb-card" }, h("h3", null, "工作与角色"),
					h("div", null, "工作项 " + (task.roles?.workItems?.length || 0) + " · 角色 " + (task.roles?.roles?.length || 0) + " · 正在运行 " + (task.roles?.instances || []).filter(function (row) { return ["active", "starting", "waiting"].includes(row.state) && !row.settlement; }).length
						+ ((task.roles?.settlementPending || 0) ? " · 待对账 " + task.roles.settlementPending : "")),
		h("div", { className: "saker-wb-sub" }, "最多可同时运行 2 个并行任务；主任务不计入名额。全部模型和工具仍计入本任务。"),
					(task.roles?.workItems || []).slice(0, 6).map(function (work) {
						return h("div", { key: work.workId, className: "saker-wb-row", style: { padding: "4px 0" } },
							h("span", { className: "saker-wb-chip" }, work.state || "proposed"),
							h("span", { className: "saker-wb-cell-main" }, work.title || work.question || work.workId),
							work.settlement ? h("span", { className: "saker-wb-chip warn" }, work.settlement.label) : null);
					}),
					(task.roles?.instances || []).filter(function (row) { return ["active", "starting", "waiting", "queued"].includes(row.state); }).slice(0, 4).map(function (row) {
						return h("div", { key: row.childId, className: "saker-wb-row", style: { padding: "4px 0" } },
							h("span", { className: "saker-wb-chip " + (row.state === "queued" || row.settlement ? "warn" : "ok") }, row.state),
							h("span", { className: "saker-wb-cell-main" }, row.roleTitle || row.roleId),
							h("span", { className: "saker-wb-sub" }, row.settlement ? row.settlement.label : row.logicalParent ? "逻辑父级 " + row.logicalParent : "根直接派工"),
							row.state === "queued" ? h("button", { className: "saker-wb-btn", disabled: !!busy,
								onClick: function () { run("role.resume", { reason: "工作台恢复排队角色" }); } }, "恢复排队") : null);
					})));
		} else if (tab === "execution") {
			var execPage = execution.meta && execution.meta.page;
			body = h("div", null,
				h(SakerListToolbar, { text: taskExecutionList.text, onText: function (value) { resetList("task.execution", { text: value }); },
					placeholder: "搜索执行 id、摘要、身份或状态",
					filters: h("select", { "aria-label": "按执行类型筛选", value: taskExecutionList.kind,
						onChange: function (event) { resetList("task.execution", { kind: event.target.value }); } },
						h("option", { value: "" }, "全部类型"), h("option", { value: "http" }, "HTTP"), h("option", { value: "model" }, "模型"),
						h("option", { value: "attempt" }, "尝试"), h("option", { value: "role" }, "角色")),
					dirty: !!(taskExecutionList.text || taskExecutionList.kind),
					onClear: function () { resetList("task.execution", { text: "", kind: "" }); },
					loadedLabel: execution.loading ? "读取中…" : "当前 " + (execution.data || []).length + " 条" + (execPage ? " · 共 " + execPage.total + " 条" : "") }),
				h(SakerQueryError, { state: execution, label: "执行记录", scope: "当前任务", onRetry: refresh }),
				h("div", { className: "saker-wb-table-wrap" }, h("table", { className: "saker-wb-table" },
					h("thead", null, h("tr", null, ["时间", "类型", "做了什么", "状态", "账号/来源"].map(function (label, index) {
						return h("th", { key: label, className: index === 4 ? "saker-col-secondary" : "" }, label);
					}))),
					h("tbody", null, (execution.data || []).map(function (row) {
						return h("tr", { key: row.kind + "/" + row.id, tabIndex: 0,
							onClick: function () { setSelectedExecution({ id: row.id, kind: row.kind }); },
							onKeyDown: function (event) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedExecution({ id: row.id, kind: row.kind }); } } },
							h("td", null, wbTime(row.at)), h("td", null, row.kind),
							h("td", null, h("div", { className: "saker-wb-cell-main" }, row.summary), h("div", { className: "saker-wb-cell-sub" }, row.id)),
							h("td", null, h("span", { className: "saker-wb-chip " + (row.state === "completed" || row.state === "captured" ? "ok" : row.state === "cleanup-failed" ? "bad" : "") }, row.state || "—")),
							h("td", { className: "saker-col-secondary" }, row.identity || row.source || "—"));
					})),
					(execution.data || []).length ? null : h("tbody", null, h("tr", null, h("td", { colSpan: 5 }, "没有匹配的执行记录。"))))),
				h(SakerPager, { page: execPage, loaded: (execution.data || []).length,
					hasPrev: taskExecutionList.stack.length > 0,
					onPrev: function () { setPage("task.execution", "prev", execution); },
					onNext: function () { setPage("task.execution", "next", execution); } }),
				h(SakerExecutionDetail, { selected: selectedExecution, state: executionDetail, onClose: function () { setSelectedExecution(null); },
					onRetry: refresh, onConversation: openConversation, onBack: function () { setTab("overview"); } }));
		} else if (tab === "exploration") {
			var graph = (exploration.data || [])[0] || { nodes: [], edges: [] };
			var openExplorationNode = function (node) {
				if (!node) return;
				if (node.kind === "finding") { setSelectedFinding(node.id); setSelectedFindingRoot(rootId); setTab("findings"); return; }
				if (node.kind === "receipt") { setSelectedExecution({ id: node.id, kind: "http" }); setTab("execution"); return; }
				if (node.kind === "attempt") { setSelectedExecution({ id: node.id, kind: "attempt" }); setTab("execution"); return; }
				if (node.kind === "asset" || node.kind === "endpoint" || node.kind === "check") { setTab("assets"); return; }
				setTab("overview");
			};
			body = h("div", null, exploration.error ? h("div", { className: "saker-wb-error" }, exploration.error) : null,
				h(SakerGraph, { graph: graph, onSelect: function (node) { setExplorationNode(node); }, onOpenNode: openExplorationNode }),
				explorationNode ? h("div", { className: "saker-wb-card", style: { marginTop: "12px" } },
					h("div", { className: "saker-wb-row" }, h("h3", { style: { flex: 1 } }, (explorationNode.title || explorationNode.id)),
						h("span", { className: "saker-wb-chip" }, explorationNode.kind),
						h("button", { className: "saker-wb-btn", onClick: function () { setExplorationNode(null); } }, "关闭")),
					h("div", { className: "saker-wb-sub" }, "id：" + explorationNode.id + " · 状态：" + (explorationNode.state || "—") + (explorationNode.revision ? " · revision：" + explorationNode.revision : "")),
					explorationNode.sourceRefs ? h("pre", { style: { whiteSpace: "pre-wrap", margin: "8px 0 0" } }, JSON.stringify(explorationNode.sourceRefs, null, 2)) : null,
					h("div", { className: "saker-wb-row", style: { marginTop: "8px" } },
						h("button", { className: "saker-wb-btn primary", onClick: function () { openExplorationNode(explorationNode); } }, "打开对应原件"))) : null,
				h("div", { className: "saker-wb-card", style: { marginTop: "12px" } }, h("h3", null, "节点来源"),
					h("div", { className: "saker-wb-scroll" }, (graph.nodes || []).map(function (node) {
						return h("button", { key: node.id, type: "button", className: "saker-wb-row", style: { padding: "4px 0", border: 0, background: "transparent", color: "inherit", cursor: "pointer", width: "100%", textAlign: "left" },
							onClick: function () { setExplorationNode(node); } },
							h("span", { className: "saker-wb-chip" }, node.kind), h("span", { className: "saker-wb-cell-main" }, node.title || node.id),
							h("span", { className: "saker-wb-sub" }, node.state || ""));
					}))));
		} else if (tab === "findings") {
			var taskFindingsAll = task.findings || [];
			var taskFindings = taskFindingsAll.filter(function (row) {
				if (taskFindingVerify && row.verificationState !== taskFindingVerify) return false;
				if (!taskFindingText.trim()) return true;
				var needle = taskFindingText.toLowerCase();
				return [row.title, row.summary, row.target, row.findingId, row.severity]
					.some(function (value) { return String(value || "").toLowerCase().includes(needle); });
			});
			body = h("div", null,
				h(SakerListToolbar, { text: taskFindingText, onText: setTaskFindingText, placeholder: "搜索发现标题、摘要或目标",
					filters: h("select", { "aria-label": "按验证状态筛选发现", value: taskFindingVerify,
						onChange: function (event) { setTaskFindingVerify(event.target.value); } },
						h("option", { value: "" }, "全部状态"), h("option", { value: "verified" }, "已验证"), h("option", { value: "candidate" }, "待确认"),
						h("option", { value: "needs-recheck" }, "待复核"), h("option", { value: "not-reproduced" }, "未复现"), h("option", { value: "fixed" }, "已处置")),
					dirty: !!(taskFindingText || taskFindingVerify), onClear: function () { setTaskFindingText(""); setTaskFindingVerify(""); },
					loadedLabel: "显示 " + taskFindings.length + " / 共 " + taskFindingsAll.length + " 条" }),
				h(SakerFindingsTable, { rows: taskFindings, showRoot: false, onSelect: function (id) { setSelectedFinding(id); setSelectedFindingRoot(rootId); } }),
				h(SakerFindingDetail, { selected: selectedFinding, state: findingDetailState, onClose: function () { setSelectedFinding(""); setSelectedFindingRoot(""); }, onRetry: refresh,
					onRetest: function () { run("work.retest", { findingRef: { id: selectedFinding }, reason: "从发现详情发起复测" }); },
					onOpenConversation: openConversation,
					onOpenEvidence: function (ref) { setTab("execution"); setSelectedExecution({ id: ref.id, kind: ref.kind === "request" ? "http" : "" }); } }));
		} else {
			var assets = taskAssets.data || [];
			var cover = (coverage.data || [])[0] || { nodes: [], edges: [], checkDimensions: { total: 0, notHit: 0, blocked: 0, notTested: 0 }, knownDenominator: 0 };
			var dims = cover.checkDimensions || {};
			body = h("div", null,
				h("div", { className: "saker-wb-row", style: { marginBottom: "8px" } },
					h("button", { className: "saker-wb-btn" + (coverageMode ? "" : " primary"), onClick: function () { setCoverageMode(false); } }, "列表"),
					h("button", { className: "saker-wb-btn" + (coverageMode ? " primary" : ""), onClick: function () { setCoverageMode(true); } }, "覆盖图")),
				coverageMode ? h("div", null,
					h("div", { className: "saker-wb-kpis" },
						h("div", { className: "saker-wb-kpi" }, h("b", null, cover.knownDenominator || 0), h("span", null, "检查分母")),
						h("div", { className: "saker-wb-kpi" }, h("b", null, dims.notHit || 0), h("span", null, "已测未命中")),
						h("div", { className: "saker-wb-kpi" }, h("b", null, dims.notTested || 0), h("span", null, "未测")),
						h("div", { className: "saker-wb-kpi" }, h("b", null, dims.blocked || 0), h("span", null, "受阻"))),
					coverage.error ? h("div", { className: "saker-wb-error" }, coverage.error) : null,
					h(SakerGraph, { graph: cover, emptyText: "当前任务还没有资产、请求或检查记录；先执行请求或导入资产，覆盖图才会出现节点。",
						onSelect: function (node) { setSelectedAsset(node); },
						onOpenNode: function (node) {
							if (node.kind === "receipt" || node.kind === "endpoint") { resetList("task.execution", { text: node.id }); setTab("execution"); return; }
							if (node.kind === "finding") { setSelectedFinding(node.id); setSelectedFindingRoot(rootId); setTab("findings"); return; }
							setSelectedAsset(node);
						} }),
					h("div", { className: "saker-wb-card", style: { marginTop: "12px" } }, h("h3", null, "覆盖说明"),
						h("p", null, "资产 → 已绑定请求 → 检查项；未测 " + (dims.notTested || 0) + " 项，受阻 " + (dims.blocked || 0) + " 项。节点来自当前任务的资产、材料和真实检查记录。"),
						h("div", { className: "saker-wb-sub" }, "已知分母：" + (cover.knownDenominator || 0) + " · 已测未命中：" + (dims.notHit || 0) + " · 未测：" + (dims.notTested || 0) + " · 受阻：" + (dims.blocked || 0))))
					: h("div", null, h("div", { className: "saker-wb-kpis" },
						h("div", { className: "saker-wb-kpi" }, h("b", null, assets.filter(function (row) { return row.kind === "asset"; }).length), h("span", null, "资产")),
						h("div", { className: "saker-wb-kpi" }, h("b", null, assets.filter(function (row) { return row.kind === "request"; }).length), h("span", null, "请求")),
						h("div", { className: "saker-wb-kpi" }, h("b", null, assets.filter(function (row) { return row.kind === "material"; }).length), h("span", null, "材料")),
						h("div", { className: "saker-wb-kpi" }, h("b", null, assets.find(function (row) { return row.kind === "check"; })?.total || 0), h("span", null, "检查项"))),
						h(SakerListToolbar, { text: taskAssetsList.text, onText: function (value) { resetList("task.assets", { text: value }); },
							placeholder: "搜索资产、请求、材料或检查",
							dirty: !!taskAssetsList.text, onClear: function () { resetList("task.assets", { text: "" }); },
							loadedLabel: taskAssets.loading ? "读取中…" : "当前 " + assets.length + " 条" + (taskAssets.meta && taskAssets.meta.page ? " · 共 " + taskAssets.meta.page.total + " 条" : "") }),
		h(SakerQueryError, { state: taskAssets, label: "资产与文件", scope: "当前测试任务", onRetry: refresh }),
						h("div", { className: "saker-wb-table-wrap" }, h(SakerAssetsTable, { rows: assets, onSelect: function (row) { setSelectedAsset(row); } })),
						h(SakerPager, { page: taskAssets.meta && taskAssets.meta.page, loaded: assets.length, hasPrev: taskAssetsList.stack.length > 0,
							onPrev: function () { setPage("task.assets", "prev", taskAssets); }, onNext: function () { setPage("task.assets", "next", taskAssets); } })));
			if (selectedAsset && (coverageMode || assets)) {
				body = h("div", null, body, h(SakerAssetDetail, { row: selectedAsset, onClose: function () { setSelectedAsset(null); },
					onOpenRequest: function (request) { resetList("task.execution", { text: request.endpoint || request.id }); setTab("execution"); },
					onOpenTask: null }));
			}
		}
		return h("div", { className: "saker-wb" + (navCollapsed ? " is-nav-collapsed" : ""), ref: setRootEl }, nav, h("main", { className: "saker-wb-main" }, head,
			h("div", { className: "saker-wb-content" },
				notice ? h("div", { className: "saker-wb-notice" }, h("span", null, notice), h("button", { className: "saker-wb-btn", onClick: function () { setNotice(""); } }, "关闭")) : null,
				unknownCommand ? h("div", { className: "saker-wb-notice warn", role: "status" },
					h("span", null, "有一条命令结果未知（" + unknownCommand.commandId + "）。确认前不会重新发送。"),
					h("button", { className: "saker-wb-btn", disabled: busy === "command.reconcile", onClick: reconcileUnknown }, busy === "command.reconcile" ? "查询中…" : "确认原命令")) : null,
				h("div", { className: "saker-wb-tabs" }, SAKER_WB_TASK_TABS.map(function (item) {
					return h("button", { key: item.id, className: "saker-wb-tab" + (tab === item.id ? " active" : ""), onClick: function () { setTab(item.id); } }, item.label);
				})),
				confirmAction ? h("div", { className: "saker-wb-notice" }, h("span", null, "停止本轮会撤销本代新执行许可，并保留在途事实与未完成项。确认停止？"),
					h("button", { className: "saker-wb-btn danger", onClick: function () { setConfirmAction(null); run("scope.stop", { scopeKind: "root", reason: "工作台确认停止" }); } }, "确认停止"),
					h("button", { className: "saker-wb-btn", onClick: function () { setConfirmAction(null); } }, "取消")) : null,
				body)));
	}
	var title = ({ dashboard: "概览", tasks: "测试任务", findings: "发现", traffic: "HTTP 记录", assets: "资产与文件",
		modules: "测试模块", roles: "协作角色", knowledge: "知识库", capabilities: "工具清单", attention: "待办事项", logs: "执行日志" })[view] || "Saker";
	var subtitle = ({ dashboard: "全部测试任务、发现和待办事项", tasks: "全部测试任务与会话", findings: "当前范围的全部发现",
		traffic: "真实 HTTP 回执与请求原文", assets: "资产、请求和文件", modules: "测试模块与我的流程",
		roles: "角色版本、实例与分工", knowledge: "项目文档正文", capabilities: "当前 Host 暴露的工具",
		attention: "需要你决定或补齐的事项", logs: "结构化运行事件" })[view] || "";
	var scopedView = scopedViews.indexOf(view) >= 0;
	var scopeRow = rootRows.find(function (row) { return row.rootId === rootId; });
	var scopeLabel = !rootId ? (view === "modules" ? "个人与内置" : "全部测试任务（按项目聚合）") : ((scopeRow && scopeRow.title) || rootId);
	var content = null;
	if (view === "dashboard") {
		var summary = global.data || {};
		content = h("div", null, h("div", { className: "saker-wb-kpis" },
			h("div", { className: "saker-wb-kpi" }, h("b", null, summary.roots || 0), h("span", null, "业务任务")),
			h("div", { className: "saker-wb-kpi" }, h("b", null, summary.activeRoots || 0), h("span", null, "进行中")),
			h("div", { className: "saker-wb-kpi" }, h("b", null, summary.verified || 0), h("span", null, "已验证发现")),
			h("div", { className: "saker-wb-kpi" }, h("b", null, summary.pending || 0), h("span", null, "待确认/待复核"))),
			h("div", { className: "saker-dash-grid" },
				h("div", { className: "saker-wb-card" },
					h("div", { className: "saker-card-head" }, h("h3", null, "最近任务"),
						h("button", { className: "saker-wb-btn", onClick: function () { setView("tasks"); } }, "查看全部")),
					h(SakerRootsTable, { rows: summary.recentRoots || [], onOpen: openRoot })),
				h("div", { className: "saker-dash-side" },
					h("div", { className: "saker-wb-card" },
						h("div", { className: "saker-card-head" }, h("h3", null, "需要你处理"),
							h("button", { className: "saker-wb-btn", onClick: function () { setView("attention"); } }, "全部 " + (summary.attention || 0))),
						(dashboardAttention.data || []).length
							? h("div", { className: "saker-dash-list" }, (dashboardAttention.data || []).slice(0, 4).map(function (row) {
								return h("button", { key: row.id, type: "button", className: "saker-dash-row",
									onClick: function () { if (row.rootId) openRoot(row.rootId); else setView("attention"); } },
									h("span", { className: "saker-dash-kicker" }, attentionLabel(row.kind)),
									h("span", { className: "saker-dash-row-main" }, row.title || row.reason || row.id),
									h("span", { className: "saker-wb-sub" }, row.reason || row.next || ""));
							}))
							: h("div", { className: "saker-dash-empty" }, dashboardAttention.loading ? "读取中…" : "没有需要你处理的事项。"),
						(summary.attention || 0) > 4 ? h("button", { className: "saker-dash-all", type: "button",
							onClick: function () { setView("attention"); } }, "还有 " + ((summary.attention || 0) - 4) + " 项") : null))));
	} else if (view === "tasks") content = h("div", null,
		h(SakerListToolbar, { text: globalList.text, onText: function (value) { resetList("global.tasks", { text: value }); }, placeholder: "搜索任务名、目标或会话 ID",
			filters: h("select", { "aria-label": "按控制状态筛选任务", value: globalList.status,
				onChange: function (event) { resetList("global.tasks", { status: event.target.value }); } },
				h("option", { value: "" }, "全部状态"), h("option", { value: "active" }, "进行中"), h("option", { value: "paused" }, "已暂停"),
				h("option", { value: "stopped" }, "已停止"), h("option", { value: "completed" }, "已结束")),
			dirty: !!(globalList.text || globalList.status), onClear: function () { resetList("global.tasks", { text: "", status: "" }); },
			loadedLabel: global.loading ? "读取中…" : "当前 " + (global.data || []).length + " 条" + (global.meta && global.meta.page ? " · 共 " + global.meta.page.total + " 条" : "") }),
	h(SakerQueryError, { state: global, label: "测试任务", scope: "全部测试任务", onRetry: refresh }),
		h("div", { className: "saker-wb-table-wrap" }, h(SakerRootsTable, { rows: global.data || [], onOpen: openRoot,
			emptyText: globalList.text || globalList.status ? "没有匹配的任务。清除搜索或换一个状态。" : "" })),
		h(SakerPager, { page: global.meta && global.meta.page, loaded: (global.data || []).length, hasPrev: globalList.stack.length > 0,
			onPrev: function () { setPage("global.tasks", "prev", global); }, onNext: function () { setPage("global.tasks", "next", global); } }));
	else if (view === "findings") content = h("div", null,
		h(SakerListToolbar, { text: globalList.text, onText: function (value) { resetList("global.findings", { text: value }); }, placeholder: "搜索发现标题、摘要或目标",
			filters: h("span", { className: "saker-wb-row" },
				h("select", { "aria-label": "按验证状态筛选发现", value: globalList.verification, onChange: function (event) { resetList("global.findings", { verification: event.target.value }); } },
					h("option", { value: "" }, "全部状态"), h("option", { value: "verified" }, "已验证"), h("option", { value: "candidate" }, "待确认"),
					h("option", { value: "needs-recheck" }, "待复核"), h("option", { value: "not-reproduced" }, "未复现"), h("option", { value: "fixed" }, "已处置")),
				h("select", { "aria-label": "按严重度筛选发现", value: globalList.severity, onChange: function (event) { resetList("global.findings", { severity: event.target.value }); } },
					h("option", { value: "" }, "全部严重度"), h("option", { value: "critical" }, "严重"), h("option", { value: "high" }, "高危"),
					h("option", { value: "medium" }, "中危"), h("option", { value: "low" }, "低危"))),
			dirty: !!(globalList.text || globalList.verification || globalList.severity),
			onClear: function () { resetList("global.findings", { text: "", verification: "", severity: "" }); },
			loadedLabel: global.loading ? "读取中…" : "当前 " + (global.data || []).length + " 条" + (global.meta && global.meta.page ? " · 共 " + global.meta.page.total + " 条" : "") }),
		h(SakerQueryError, { state: global, label: "发现", scope: scopeLabel, onRetry: refresh }),
		h("div", { className: "saker-wb-table-wrap" }, h(SakerFindingsTable, { rows: global.data || [], showRoot: true,
			onSelect: function (id, sessionId) { setSelectedFinding(id); setSelectedFindingRoot(sessionId || ""); } })),
		h(SakerPager, { page: global.meta && global.meta.page, loaded: (global.data || []).length, hasPrev: globalList.stack.length > 0,
			onPrev: function () { setPage("global.findings", "prev", global); }, onNext: function () { setPage("global.findings", "next", global); } }),
		h(SakerFindingDetail, { selected: selectedFinding, state: findingDetailState, onClose: function () { setSelectedFinding(""); setSelectedFindingRoot(""); }, onRetry: refresh,
			onRetest: function () { run("work.retest", { findingRef: { id: selectedFinding }, reason: "从发现详情发起复测" }); },
			onOpenConversation: function () { openConversationFor(findingDetailState.data?.sessionId || selectedFindingRoot); },
			onOpenEvidence: function (ref) { var owner = findingDetailState.data?.sessionId || selectedFindingRoot; if (owner) { setRootId(owner); setView("task"); setTab("execution"); setSelectedExecution({ id: ref.id, kind: ref.kind === "request" ? "http" : "" }); } } }));
	else if (view === "traffic") content = h("div", null,
		h(SakerListToolbar, { text: globalList.text, onText: function (value) { resetList("global.traffic", { text: value }); }, placeholder: "搜索请求、ID、账号或状态",
			filters: h("select", { "aria-label": "按 HTTP 状态筛选流量", value: globalList.status, onChange: function (event) { resetList("global.traffic", { status: event.target.value }); } },
				h("option", { value: "" }, "全部状态码"), ["200", "201", "204", "301", "302", "400", "401", "403", "404", "500"].map(function (code) { return h("option", { key: code, value: code }, code); })),
			dirty: !!(globalList.text || globalList.status), onClear: function () { resetList("global.traffic", { text: "", status: "" }); },
			loadedLabel: global.loading ? "读取中…" : "当前 " + (global.data || []).length + " 条" + (global.meta && global.meta.page ? " · 共 " + global.meta.page.total + " 条" : "") }),
		h(SakerQueryError, { state: global, label: "流量", scope: scopeLabel, onRetry: refresh }),
		h("div", { className: "saker-wb-table-wrap" }, h(SakerTrafficTable, { rows: global.data || [],
			onSelect: function (row) { setSelectedGlobalExecution({ rootId: row.rootId, id: row.id, kind: "http" }); } })),
		h(SakerPager, { page: global.meta && global.meta.page, loaded: (global.data || []).length, hasPrev: globalList.stack.length > 0,
			onPrev: function () { setPage("global.traffic", "prev", global); }, onNext: function () { setPage("global.traffic", "next", global); } }),
		h(SakerExecutionDetail, { selected: selectedGlobalExecution, state: globalExecutionDetail, onClose: function () { setSelectedGlobalExecution(null); }, onRetry: refresh,
			onConversation: function () { if (selectedGlobalExecution) openConversationFor(selectedGlobalExecution.rootId); } }));
	else if (view === "assets") content = h("div", null,
		h(SakerListToolbar, { text: globalList.text, onText: function (value) { resetList("global.assets", { text: value }); }, placeholder: "搜索资产、请求 ID 或账号",
			dirty: !!globalList.text, onClear: function () { resetList("global.assets", { text: "" }); },
			loadedLabel: global.loading ? "读取中…" : "当前 " + (global.data || []).length + " 条" + (global.meta && global.meta.page ? " · 共 " + global.meta.page.total + " 条" : "") }),
		h(SakerQueryError, { state: global, label: "资产与文件", scope: scopeLabel, onRetry: refresh }),
		h("div", { className: "saker-wb-table-wrap" }, h(SakerAssetsTable, { rows: global.data || [], showRoot: true, onSelect: function (row) { setSelectedAsset(row); } })),
		h(SakerPager, { page: global.meta && global.meta.page, loaded: (global.data || []).length, hasPrev: globalList.stack.length > 0,
			onPrev: function () { setPage("global.assets", "prev", global); }, onNext: function () { setPage("global.assets", "next", global); } }),
		h(SakerAssetDetail, { row: selectedAsset, onClose: function () { setSelectedAsset(null); },
			onOpenTask: selectedAsset && selectedAsset.rootId ? function () { setRootId(selectedAsset.rootId); setView("task"); setTab("assets"); setSelectedAsset(null); } : null,
			onOpenRequest: function (request) { if (selectedAsset && selectedAsset.rootId) { setRootId(selectedAsset.rootId); setView("task"); setTab("execution"); resetList("task.execution", { text: request.endpoint || request.id }); } } }));
	else if (view === "modules") content = h(SakerModulesPage, { rootId: rootId, tick: tick, run: run });
	else if (view === "roles") content = h(SakerRolesPage, { rows: global.data || [], run: run, rootId: rootId, tick: tick });
	else if (view === "knowledge") content = h(SakerKnowledgePage, { rootId: rootId, tick: tick });
	else if (view === "capabilities") content = h("div", null,
		h(SakerListToolbar, { text: globalList.text, onText: function (value) { resetList("global.capabilities", { text: value }); }, placeholder: "搜索工具名、用途或来源",
			dirty: !!globalList.text, onClear: function () { resetList("global.capabilities", { text: "" }); },
			loadedLabel: global.loading ? "读取中…" : "当前 " + (global.data || []).length + " 条" }),
		h(SakerQueryError, { state: global, label: "可用工具", scope: scopeLabel, onRetry: refresh }),
		!rootId ? h("div", { className: "saker-wb-empty" }, "先在范围里选择一个任务，才能读取该 Host 会话实际暴露的工具。") : null,
		rootId ? h("div", { className: "saker-wb-table-wrap" }, h(SakerCapabilitiesTable, { rows: global.data || [] })) : null);
	else if (view === "attention") content = h("div", null,
		h(SakerListToolbar, { text: globalList.text, onText: function (value) { resetList("global.attention", { text: value }); }, placeholder: "搜索待处理原因或任务",
			dirty: !!globalList.text, onClear: function () { resetList("global.attention", { text: "" }); },
			loadedLabel: global.loading ? "读取中…" : "当前 " + (global.data || []).length + " 条" + (global.meta && global.meta.page ? " · 共 " + global.meta.page.total + " 条" : "") }),
	h(SakerQueryError, { state: global, label: "待办事项", scope: "全部测试任务", onRetry: refresh }),
		h(SakerAttentionList, { rows: global.data || [], onOpen: openRoot }),
		h(SakerPager, { page: global.meta && global.meta.page, loaded: (global.data || []).length, hasPrev: globalList.stack.length > 0,
			onPrev: function () { setPage("global.attention", "prev", global); }, onNext: function () { setPage("global.attention", "next", global); } }));
	else if (view === "logs") content = h("div", null,
		h(SakerListToolbar, { text: globalList.text, onText: function (value) { resetList("global.logs", { text: value }); }, placeholder: "搜索事件类型或内容",
			dirty: !!globalList.text, onClear: function () { resetList("global.logs", { text: "" }); },
			loadedLabel: global.loading ? "读取中…" : "当前 " + (global.data || []).length + " 条" + (global.meta && global.meta.page ? " · 共 " + global.meta.page.total + " 条" : "") }),
		h(SakerQueryError, { state: global, label: "执行日志", scope: scopeLabel, onRetry: refresh }),
		!rootId ? h("div", { className: "saker-wb-empty" }, "先在范围里选择一个任务，再查看它的结构事件记录。") : null,
		h(SakerLogsList, { rows: global.data || [] }),
		h(SakerPager, { page: global.meta && global.meta.page, loaded: (global.data || []).length, hasPrev: globalList.stack.length > 0,
			onPrev: function () { setPage("global.logs", "prev", global); }, onNext: function () { setPage("global.logs", "next", global); } }));
	var scopeChoices = rootRows.slice();
	if (rootId && !scopeChoices.some(function (row) { return row.rootId === rootId; })) scopeChoices.unshift({ rootId: rootId, title: rootId });
	var scopePicker = scopedView ? h("label", { className: "saker-wb-scope" }, h("span", null, "范围"),
		h("select", { value: rootId, onChange: function (event) { setRootId(event.target.value); resetList("global." + view); setSelectedFinding(""); setSelectedFindingRoot(""); setSelectedGlobalExecution(null); setSelectedAsset(null); } },
	h("option", { value: "" }, view === "modules" ? "个人与内置" : view === "capabilities" || view === "logs" ? "请选择任务" : "全部测试任务（按项目聚合）"),
			scopeChoices.map(function (row) { return h("option", { key: row.rootId, value: row.rootId }, (row.title || row.rootId).slice(0, 32)); }))) : null;
	var globalHeader = h("header", { className: "saker-wb-head" },
		h("div", { className: "saker-wb-headtext" }, h("div", { className: "saker-wb-title" }, title),
			subtitle ? h("div", { className: "saker-wb-sub" }, subtitle) : null),
		scopePicker,
		h("div", { className: "saker-wb-spacer" }),
		h("button", { className: "saker-wb-btn", onClick: refresh }, global.loading ? "刷新中…" : "刷新"));
	var globalContent = h("div", { className: "saker-wb-content" },
		notice ? h("div", { className: "saker-wb-notice" }, h("span", null, notice), h("button", { className: "saker-wb-btn", onClick: function () { setNotice(""); } }, "关闭")) : null,
		unknownCommand ? h("div", { className: "saker-wb-notice warn", role: "status" },
			h("span", null, "有一条命令结果未知（" + unknownCommand.commandId + "）。确认前不会重新发送。"),
			h("button", { className: "saker-wb-btn", disabled: busy === "command.reconcile", onClick: reconcileUnknown }, busy === "command.reconcile" ? "查询中…" : "确认原命令")) : null,
		global.loading && !global.data && view !== "modules" && view !== "knowledge" ? h("div", { className: "saker-wb-empty" }, "读取中…") : content);
	var globalBody = h("div", { className: "saker-wb" + (navCollapsed ? " is-nav-collapsed" : ""), ref: setRootEl }, nav,
		h("main", { className: "saker-wb-main" }, globalHeader, globalContent));
	return globalBody;
}
// 一个坏记录不能让整个 Saker 白屏；错误边界只替换当前页，保留导航、重试和返回。
class SakerRenderBoundary extends React.Component {
	constructor(props) {
		super(props);
		this.state = { error: null };
		this.retry = this.retry.bind(this);
		this.back = this.back.bind(this);
	}
	static getDerivedStateFromError(error) {
		return { error: error };
	}
	componentDidCatch(error, info) {
		try { console.error("Saker page render failed", error, info); } catch (_error) { /* 宿主可能没有 console */ }
	}
	retry() {
		this.setState({ error: null });
		if (this.props.onRetry) this.props.onRetry();
	}
	back() {
		this.setState({ error: null });
		if (this.props.onBack) this.props.onBack();
	}
	render() {
		if (this.state.error) {
			return h("section", { className: "saker-wb-page", role: "alert" },
				h("div", { className: "saker-wb-error" },
					h("strong", null, "当前页加载失败"),
					h("p", null, String(this.state.error && this.state.error.message || this.state.error)),
			h("p", null, "页面数据没有因此重跑；可以重试当前页或返回测试任务。"),
					h("div", { className: "saker-wb-row" },
						h("button", { type: "button", className: "saker-wb-btn", onClick: this.retry }, "重试"),
			h("button", { type: "button", className: "saker-wb-btn", onClick: this.back }, "返回测试任务"))));
		}
		return this.props.children;
	}
}
function SakerBoundaryContent(props) {
	return props.build();
}
function SakerWorkbenchPage(props) {
	var ctx = props.ctx;
	var pageState = useState("dashboard"), page = pageState[0], setPage = pageState[1];
	var rootState = useState(""), rootId = rootState[0], setRootId = rootState[1];
	var scopeTextState = useState(""), scopeText = scopeTextState[0], setScopeText = scopeTextState[1];
	var taskTabState = useState("overview"), taskTab = taskTabState[0], setTaskTab = taskTabState[1];
	var evidenceTabState = useState("findings"), evidenceTab = evidenceTabState[0], setEvidenceTab = evidenceTabState[1];
	var resourceTabState = useState("modules"), resourceTab = resourceTabState[0], setResourceTab = resourceTabState[1];
	var selectedStackState = useState([]), selectedStack = selectedStackState[0], setSelectedStack = selectedStackState[1];
	var detailTabState = useState("summary"), detailTab = detailTabState[0], setDetailTab = detailTabState[1];
	var materialOffsetState = useState(0), materialOffset = materialOffsetState[0], setMaterialOffset = materialOffsetState[1];
	var explorationNodeState = useState(null), explorationNode = explorationNodeState[0], setExplorationNode = explorationNodeState[1];
	var coverageModeState = useState(false), coverageMode = coverageModeState[0], setCoverageMode = coverageModeState[1];
	var tickState = useState(0), tick = tickState[0], setTick = tickState[1];
	var busyState = useState(""), busy = busyState[0], setBusy = busyState[1];
	var noticeState = useState(""), notice = noticeState[0], setNotice = noticeState[1];
	var unknownCommandState = useState(null), unknownCommand = unknownCommandState[0], setUnknownCommand = unknownCommandState[1];
	var confirmState = useState(false), confirmStop = confirmState[0], setConfirmStop = confirmState[1];
	var handoffState = useState(null), handoff = handoffState[0], setHandoff = handoffState[1];
	var listStatesHook = useState({}), listStates = listStatesHook[0], setListStates = listStatesHook[1];
	var navPrefState = useState(function () { try { return localStorage.getItem("saker.wb.nav") || ""; } catch (_error) { return ""; } });
	var navPref = navPrefState[0], setNavPref = navPrefState[1];
	var rootElState = useState(null), rootEl = rootElState[0], setRootEl = rootElState[1];
	var widthState = useState(0), containerWidth = widthState[0], setContainerWidth = widthState[1];
	var rootRows = [];
	var contentRef = useRef(null);
	var detailHeadingRef = useRef(null);
	var scopeComposing = useRef(false);
	var scopeDraftState = useState(null), scopeDraft = scopeDraftState[0], setScopeDraft = scopeDraftState[1];
	var returnFocusRef = useRef("");
	var returnScrollRef = useRef(0);
	var handoffSeqRef = useRef(0);
	var focusRequestState = useState(""), focusRequest = focusRequestState[0], setFocusRequest = focusRequestState[1];
	var selectionObservedRef = useRef(false);
	var taskOriginRef = useRef(null);

	useEffect(function () {
		if (!rootEl || typeof ResizeObserver === "undefined") return;
		var observer = new ResizeObserver(function (entries) {
			setContainerWidth(entries && entries[0] ? entries[0].contentRect.width : 0);
		});
		observer.observe(rootEl);
		return function () { observer.disconnect(); };
	}, [rootEl]);

	var topNavMode = containerWidth > 0 && containerWidth < 900;
	var navCollapsed = navPref === "collapsed";
	var detailOnly = topNavMode || (containerWidth > 0 && containerWidth - (navCollapsed ? 52 : 168) - 72 < 832);
	var compactRows = containerWidth > 0 && containerWidth < 700;
	var selectedRef = selectedStack.length ? selectedStack[selectedStack.length - 1] : null;
	var selectionKey = wbSelectionKey(selectedRef);

	function listStateFor(name) {
		return Object.assign({ text: "", state: "", status: "", severity: "", verification: "", kind: "", limit: 50, cursor: "", stack: [] }, listStates[name] || {});
	}
	function patchList(name, patch) {
		setListStates(function (previous) {
			var next = Object.assign({}, previous);
			next[name] = Object.assign({}, next[name] || {}, patch);
			return next;
		});
	}
	function resetList(name, patch) { patchList(name, Object.assign({ cursor: "", stack: [] }, patch || {})); }
	function pageOf(state) { return state && state.meta && state.meta.page ? state.meta.page : null; }
	function setPageCursor(name, direction, state) {
		var current = listStateFor(name), pageInfo = pageOf(state);
		if (!pageInfo) return;
		if (direction === "next" && pageInfo.nextCursor) {
			patchList(name, { stack: current.stack.concat([current.cursor]), cursor: pageInfo.nextCursor });
			return;
		}
		if (direction === "prev" && current.stack.length) {
			patchList(name, { stack: current.stack.slice(0, -1), cursor: current.stack[current.stack.length - 1] || "" });
		}
	}
	function toggleNav() {
		var next = navCollapsed ? "expanded" : "collapsed";
		setNavPref(next);
		try { localStorage.setItem("saker.wb.nav", next); } catch (_error) {}
	}
	function refresh() { setTick(function (value) { return value + 1; }); }
	function focusRow(key) {
		if (!key || !contentRef.current) return;
		var rows = contentRef.current.querySelectorAll("[data-saker-row]");
		for (var index = 0; index < rows.length; index += 1) {
			if (rows[index].getAttribute("data-saker-row") === key) {
				try { rows[index].focus({ preventScroll: true }); } catch (_error) { try { rows[index].focus(); } catch (__error) {} }
				return;
			}
		}
	}
	useEffect(function () {
		var timer = setTimeout(function () {
			if (selectedRef) {
				selectionObservedRef.current = true;
				if (detailHeadingRef.current) {
					try { detailHeadingRef.current.focus({ preventScroll: true }); } catch (_error) { try { detailHeadingRef.current.focus(); } catch (__error) {} }
				}
				return;
			}
			if (selectionObservedRef.current) {
				selectionObservedRef.current = false;
				focusRow(returnFocusRef.current);
			}
		}, 0);
		return function () { clearTimeout(timer); };
	}, [selectionKey]);
	useEffect(function () {
		if (!focusRequest) return;
		var timer = setTimeout(function () {
			if (contentRef.current) contentRef.current.scrollTop = returnScrollRef.current || 0;
			focusRow(focusRequest);
			setFocusRequest("");
		}, 0);
		return function () { clearTimeout(timer); };
	}, [page, focusRequest]);
	useEffect(function () {
		function onKeyDown(event) {
			if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
			if (handoff) {
				event.preventDefault();
				closeHandoff();
				return;
			}
			if (confirmStop) { event.preventDefault(); setConfirmStop(false); return; }
			if (selectedStack.length) { event.preventDefault(); closeDetail(); return; }
			if (explorationNode) { event.preventDefault(); setExplorationNode(null); }
		}
		document.addEventListener("keydown", onKeyDown);
		return function () { document.removeEventListener("keydown", onKeyDown); };
	}, [!!handoff, confirmStop, selectedStack.length, !!explorationNode]);

	function openRoot(id, tab) {
		if (!id) return;
		var originHasDetail = page === "evidence" && selectedStack.length > 0;
		taskOriginRef.current = {
			page: page,
			rootId: rootId,
			scrollTop: contentRef.current ? contentRef.current.scrollTop : 0,
			evidenceTab: evidenceTab,
			resourceTab: resourceTab,
			selectedStack: selectedStack.slice(),
			detailTab: detailTab,
			listStates: Object.assign({}, listStates),
			focusKey: originHasDetail ? returnFocusRef.current : "task:" + id,
		};
		returnScrollRef.current = taskOriginRef.current.scrollTop;
		if (!originHasDetail) returnFocusRef.current = "task:" + id;
		setRootId(id);
		setTaskTab(tab || "overview");
		setPage("task");
		setSelectedStack([]);
		setExplorationNode(null);
		setNotice("");
		setConfirmStop(false);
		return id;
	}
	function backFromTask() {
		var origin = taskOriginRef.current;
		setPage(origin && origin.page ? origin.page : "tasks");
		if (origin) {
			setRootId(origin.rootId || "");
			setEvidenceTab(origin.evidenceTab || "findings");
			setResourceTab(origin.resourceTab || "modules");
			setSelectedStack(origin.selectedStack || []);
			setDetailTab(origin.detailTab || "summary");
			setListStates(origin.listStates || {});
			returnScrollRef.current = origin.scrollTop || 0;
			setFocusRequest((origin.selectedStack || []).length
				? "__restore-scroll__"
				: (origin.focusKey || returnFocusRef.current));
		}
		setTaskTab("overview");
		setExplorationNode(null);
	}
	function openConversationFor(id) {
		if (id && ctx.uiWorkspace && typeof ctx.uiWorkspace.openSession === "function") {
			try { ctx.uiWorkspace.openSession(id); return; } catch (error) { setNotice("无法返回原会话：" + (error.message || error)); return; }
		}
		setNotice("当前 Host 没有可用的会话打开接口；请从左侧原生会话列表打开该任务。");
	}
	function openConversation() {
		if (!rootId) { setNotice("先在任务列表选择一个任务，再返回原会话；这里不会按第一条任务猜测。"); return; }
		openConversationFor(rootId);
	}
	function pushRef(ref) {
		var key = wbSelectionKey(ref);
		if (!selectedStack.length) returnFocusRef.current = key;
		if (ref.kind === "material") setMaterialOffset(0);
		setSelectedStack(function (previous) { return previous.concat([Object.assign({}, ref)]); });
		setDetailTab("summary");
	}
	function closeDetail() {
		setSelectedStack(function (previous) { return previous.slice(0, -1); });
		setDetailTab("summary");
	}
	function showVisibleNotice(message) {
		setNotice(message);
		try { if (contentRef.current && contentRef.current.scrollTo) contentRef.current.scrollTo({ top: 0, behavior: "smooth" }); } catch (_error) { /* 老宿主不支持平滑滚动 */ }
	}
	function openReviewItem(item) {
		if (!item) return;
		if (item.kind === "command") {
			api("workbench.query", { kind: "command.status",
				context: { rootId: item.rootId || rootId, generation: 0, sessionId: "", commandId: item.commandId || item.id } })
				.then(function (response) {
					var failure = wbResponseError(response, "查询操作进度失败");
					if (failure) throw failure;
					var status = response.data || {};
					showVisibleNotice("操作 " + (item.commandId || item.id) + "：" + (status.status || "未知")
						+ (status.error ? " · " + status.error : "") + "。不会重新发送这条操作。");
				})
				.catch(function (error) { showVisibleNotice(wbErrorText(error)); });
			return;
		}
		if (item.kind === "http") {
			pushRef({ kind: "http", id: item.id, rootId: item.rootId || rootId, summary: item.title || item.id });
			return;
		}
		if (item.kind === "finding") {
			pushRef({ kind: "finding", id: item.id, rootId: item.rootId || rootId, summary: item.title || item.id });
			setDetailTab("evidence");
		}
	}
	function openTaskFromEvidence(owner, tab) {
		tab = tab || "findings";
		if (!owner) {
			showVisibleNotice("这条记录没有可确认的所属任务；请在证据详情继续核对依据。");
			return;
		}
		if (page === "task" && owner === rootId) {
			setTaskTab(tab);
			setSelectedStack([]);
			return;
		}
		if (rootRows.some(function (row) { return row.rootId === owner; })) {
			openRoot(owner, tab);
			return;
		}
		// 全局发现可能来自旧会话、子会话或只做过资料核对的会话；它们没有 task_policy 根。
		// 先按 rootId 精确查一次，确认是任务再跳，不能把空任务页当成“可打开”。
		api("workbench.query", { kind: "roots.list", context: {}, filter: { text: owner }, page: { limit: 20 } })
			.then(function (value) {
				if (!value || value.ok === false) throw Error(wbErrorText(value));
				var hit = (value.data || []).find(function (row) { return row.rootId === owner; });
				if (!hit) {
					showVisibleNotice("这条发现所属的会话不是独立任务，无法打开任务概要；可继续在证据详情查看依据，或从左侧原生会话进入。");
					return;
				}
				openRoot(owner, tab);
			})
			.catch(function (error) { showVisibleNotice("无法确认这条记录所属任务：" + wbErrorText(error)); });
	}
	function onNavigate(id) {
		if (id === "conversation") { openConversation(); return; }
		setPage(id);
		setSelectedStack([]);
		setExplorationNode(null);
		setNotice("");
		setConfirmStop(false);
		if (id !== "task") setHandoff(null);
	}
	function run(kind, payload, after, contextOverride) {
		if (busy) return;
		setBusy(kind); setNotice("");
		var effectiveRootId = (contextOverride && contextOverride.rootId) || rootId;
		var commandContext = Object.assign({ rootId: effectiveRootId, sessionId: effectiveRootId,
			generation: taskDetail.data?.root?.generation || 0 }, contextOverride || {});
		wbCommand(ctx, kind, commandContext, payload)
			.then(function (result) { setBusy(""); if (after) after(result); refresh(); })
			.catch(function (error) {
				setBusy("");
				if (error && error.unknown) {
					setUnknownCommand({ commandId: error.commandId || "", intent: error.intent || "", kind: kind,
						context: commandContext, payload: payload || {}, after: after });
					setNotice("结果未知：命令 " + (error.commandId || "未记录") + " 已保留。先确认原命令结果，不要重复发起。");
					return;
				}
				setNotice(wbErrorText(error));
			});
	}
	function reconcileUnknown() {
		if (!unknownCommand || busy) return;
		setBusy("command.reconcile");
		wbReconcileCommand(unknownCommand.commandId, unknownCommand.kind, unknownCommand.context, unknownCommand.payload)
			.then(function (outcome) {
				if (outcome.action === "reuse") {
					setUnknownCommand(null); setBusy(""); setNotice("原命令已完成；没有重复执行。"); refresh(); return null;
				}
				return wbDispatchCommand(unknownCommand.commandId, unknownCommand.kind, unknownCommand.context, unknownCommand.payload)
					.then(function (value) {
						setUnknownCommand(null); setBusy(""); setNotice("原命令确认未被受理，已用同一命令 ID 继续执行。");
						if (unknownCommand.after) unknownCommand.after(value);
						refresh();
					});
			})
			.catch(function (error) { setBusy(""); setNotice(wbErrorText(error)); });
	}
	function openHandoff() {
		if (!rootId || (handoff && handoff.loading)) return;
		var seq = ++handoffSeqRef.current;
		var owner = rootId;
		returnFocusRef.current = "action:export";
		setHandoff({ loading: true, data: null, error: "", rootId: owner });
		api("delivery.bundle", { sessionId: owner, preview: true })
			.then(function (value) {
				if (seq !== handoffSeqRef.current) return;
				if (!value || value.ok === false) throw Error((value && value.error) || "报告预览读取失败");
				setHandoff({ loading: false, data: value, error: "", rootId: owner });
			})
			.catch(function (error) {
				if (seq !== handoffSeqRef.current) return;
				setHandoff({ loading: false, data: null, error: wbErrorText(error), rootId: owner });
			});
	}
	function closeHandoff() {
		handoffSeqRef.current += 1;
		setHandoff(null);
		setTimeout(function () {
			var trigger = contentRef.current && contentRef.current.querySelector('[data-saker-action="export"]');
			if (trigger) trigger.focus({ preventScroll: true });
		}, 0);
	}
	function downloadHandoff() {
		if (!handoff || !handoff.data || !handoff.data.snapshot || busy) return;
		var owner = handoff.rootId || rootId;
		setBusy("delivery.download");
		api("delivery.bundle", { sessionId: owner, expectedSnapshot: handoff.data.snapshot })
			.then(function (value) {
				if (!value || value.ok === false) throw Error((value && value.error) || "报告包生成失败");
				downloadArchive(value.filename || "saker-delivery.zip", value.archive);
				setBusy("");
			})
			.catch(function (error) { setBusy(""); setNotice(wbErrorText(error)); });
	}

	var roots = useWorkbenchQuery("roots.list", {}, tick, true, { filter: {}, page: { limit: 100 } });
	rootRows = roots.data || [];
	var scopeQuery = useWorkbenchQuery("roots.list", {}, tick, !!scopeText.trim(),
		{ filter: { text: scopeText }, page: { limit: 50 } });
	var taskList = listStateFor("tasks");
	var taskQuery = useWorkbenchQuery("roots.list", {}, tick, true, {
		filter: { text: taskList.text, business: taskList.state },
		page: { limit: taskList.limit, cursor: taskList.cursor },
	});
	var dashboard = useWorkbenchQuery("dashboard.summary", {}, tick, page === "dashboard");
	var attentionList = listStateFor("attention");
	var attentionQuery = useWorkbenchQuery("attention.list", {}, tick, page === "dashboard" || page === "attention",
		{ filter: page === "attention" ? { text: attentionList.text } : {},
			page: { limit: page === "dashboard" ? 3 : 50, cursor: page === "attention" ? attentionList.cursor : "" } });
	var evidenceList = listStateFor("evidence." + evidenceTab);
	var evidenceKind = evidenceTab === "findings" ? "findings.list" : evidenceTab === "traffic" ? "traffic.list" : "assets.list";
	var evidenceFilter = { text: evidenceList.text };
	if (evidenceTab === "findings") { evidenceFilter.verification = evidenceList.verification; evidenceFilter.severity = evidenceList.severity; }
	if (evidenceTab === "traffic") evidenceFilter.status = evidenceList.status;
	var evidenceQuery = useWorkbenchQuery(evidenceKind, { rootId: rootId }, tick, page === "evidence",
		{ filter: evidenceFilter, page: { limit: evidenceList.limit, cursor: evidenceList.cursor } });
	var resourceList = listStateFor("resources." + resourceTab);
	var rolesQuery = useWorkbenchQuery("roles.list", { rootId: rootId }, tick,
		page === "resources" && resourceTab === "roles", { filter: { text: resourceList.text }, page: { limit: 100 } });
	var capabilitiesQuery = useWorkbenchQuery("capabilities.list", { rootId: rootId }, tick,
		page === "resources" && resourceTab === "capabilities", { filter: { text: resourceList.text }, page: { limit: 100 } });
	var logsList = listStateFor("logs");
	var logsQuery = useWorkbenchQuery("logs.list", { rootId: rootId }, tick, page === "logs",
		{ filter: { text: logsList.text }, page: { limit: logsList.limit, cursor: logsList.cursor } });
	var taskDetail = useWorkbenchQuery("roots.detail", { rootId: rootId, detailMode: "summary" }, tick, page === "task" && !!rootId);
	var reviewQuery = useWorkbenchQuery("review.summary", { rootId: rootId }, tick,
		page === "task" && taskTab === "overview" && !!rootId);
	var executionViewState = useState("records"), executionView = executionViewState[0], setExecutionView = executionViewState[1];
	var usageCursorState = useState(""), usageCursor = usageCursorState[0], setUsageCursor = usageCursorState[1];
	var usageQuery = useWorkbenchQuery("usage.round", { rootId: rootId }, tick,
		page === "task" && taskTab === "execution" && executionView === "usage" && !!rootId,
		{ page: { limit: 20, cursor: usageCursor } });
	var taskFindingsList = listStateFor("task.findings");
	var taskFindingsQuery = useWorkbenchQuery("findings.list", { rootId: rootId }, tick,
		page === "task" && taskTab === "findings" && !!rootId,
		{ filter: { text: taskFindingsList.text, verification: taskFindingsList.verification },
			page: { limit: taskFindingsList.limit, cursor: taskFindingsList.cursor } });
	var taskExecutionList = listStateFor("task.execution");
	var taskExecution = useWorkbenchQuery("execution.records", { rootId: rootId }, tick,
		page === "task" && taskTab === "execution",
		{ filter: { text: taskExecutionList.text, kind: taskExecutionList.kind },
			page: { limit: taskExecutionList.limit, cursor: taskExecutionList.cursor } });
	var taskAssetsList = listStateFor("task.assets");
	var taskAssets = useWorkbenchQuery("assets.list", { rootId: rootId }, tick,
		page === "task" && taskTab === "assets" && !coverageMode,
		{ filter: { text: taskAssetsList.text }, page: { limit: taskAssetsList.limit, cursor: taskAssetsList.cursor } });
	var coverage = useWorkbenchQuery("assets.coverage", { rootId: rootId }, tick,
		page === "task" && taskTab === "assets" && coverageMode);
	var exploration = useWorkbenchQuery("exploration.graph", { rootId: rootId }, tick,
		page === "task" && taskTab === "exploration");
	var findingDetail = useWorkbenchQuery("findings.detail",
		{ rootId: selectedRef && selectedRef.kind === "finding" ? (selectedRef.rootId || rootId) : "",
			findingId: selectedRef && selectedRef.kind === "finding" ? selectedRef.id : "" },
		tick, !!(selectedRef && selectedRef.kind === "finding"));
	var executionDetail = useWorkbenchQuery("execution.detail",
		{ rootId: selectedRef && ["http", "model", "attempt", "role"].indexOf(selectedRef.kind) >= 0 ? (selectedRef.rootId || rootId) : "",
			executionId: selectedRef && ["http", "model", "attempt", "role"].indexOf(selectedRef.kind) >= 0 ? selectedRef.id : "",
			executionKind: selectedRef ? selectedRef.kind : "" },
		tick, !!(selectedRef && ["http", "model", "attempt", "role"].indexOf(selectedRef.kind) >= 0));
	var materialDetail = useWorkbenchQuery("evidence.material",
		{ rootId: selectedRef && selectedRef.kind === "material" ? (selectedRef.rootId || rootId) : "",
			materialKind: selectedRef && selectedRef.kind === "material" ? (selectedRef.materialKind || "file") : "file",
			materialId: selectedRef && selectedRef.kind === "material" ? selectedRef.id : "",
			offset: materialOffset, limit: 8192 },
		tick, !!(selectedRef && selectedRef.kind === "material"));

	var task = taskDetail.data || {};
	var taskRoot = task.root || {};
	function currentScopeLabel() {
		if (!rootId) return "全部测试任务";
		var row = rootRows.find(function (item) { return item.rootId === rootId; });
		return (row && wbRootTitle(row)) || rootId;
	}
	function renderScopePicker(extraClass) {
		var choices = (scopeText.trim() ? (scopeQuery.data || []) : rootRows).slice();
		if (rootId && !choices.some(function (row) { return row.rootId === rootId; })) choices.unshift({ rootId: rootId, title: rootId });
		return h("div", { className: "saker-wb-scope" + (extraClass ? " " + extraClass : ""), role: "group", "aria-label": "范围选择" },
			h("span", null, "范围"),
			h("input", { type: "search", value: scopeComposing.current ? (scopeDraft == null ? scopeText : scopeDraft) : scopeText,
				placeholder: "搜索测试任务", "aria-label": "搜索测试任务",
				onChange: function (event) {
					var value = event.target.value;
					if (scopeComposing.current || (event.nativeEvent && event.nativeEvent.isComposing)) { setScopeDraft(value); return; }
					setScopeDraft(null);
					setScopeText(value);
				},
				onCompositionStart: function () { scopeComposing.current = true; setScopeDraft(scopeText); },
				onCompositionEnd: function (event) { scopeComposing.current = false; setScopeDraft(null); setScopeText(event.target.value); } }),
			h("select", { value: rootId, "aria-label": "选择测试任务",
				onChange: function (event) {
					setRootId(event.target.value);
					setSelectedStack([]);
					if (page === "evidence") resetList("evidence." + evidenceTab);
					if (page === "logs") resetList("logs");
				} },
			h("option", { value: "" }, "全部测试任务（按项目汇总）"),
				choices.map(function (row) { return h("option", { key: row.rootId, value: row.rootId }, wbRootTitle(row).slice(0, 42)); })),
			scopeText ? h("button", { type: "button", className: "saker-wb-btn", onClick: function () { setScopeText(""); } }, "清除搜索") : null);
	}
	function renderPager(name, state, hasPrev) {
		return h(SakerPager, { page: state && state.meta && state.meta.page,
			loaded: (state && state.data || []).length, hasPrev: hasPrev,
			onPrev: function () { setPageCursor(name, "prev", state); },
			onNext: function () { setPageCursor(name, "next", state); } });
	}
	function renderInspector() {
		if (!selectedRef) return null;
		if (selectedRef.kind === "finding") {
			return h(SakerFindingInspector, { selected: selectedRef, state: findingDetail,
				tab: detailTab, onTab: setDetailTab, headingRef: detailHeadingRef,
				onClose: closeDetail, back: selectedStack.length > 1 ? closeDetail : null,
				onRetry: refresh, onRetest: function () {
					var owner = findingDetail.data?.sessionId || selectedRef.rootId || rootId;
					runForOwner(owner, "work.retest", { findingRef: { id: selectedRef.id }, reason: "从发现详情发起复测" });
				},
				onConversation: function () { openConversationFor(findingDetail.data?.sessionId || selectedRef.rootId || rootId); },
				onOpenTask: function () { openTaskFromEvidence(findingDetail.data?.sessionId || selectedRef.rootId || rootId); },
				onOpenMaterial: function (material) { pushRef({ kind: "material", id: material.materialId || material.id,
					rootId: material.rootId || findingDetail.data?.sessionId || selectedRef.rootId || rootId,
					materialKind: material.kind === "material" ? "file" : (material.kind || "file"),
					summary: material.label || material.id }); },
				onOpenRequest: function (ref) { pushRef({ kind: "material",
					id: String(ref.id || "") + (ref.revision ? ":" + ref.revision : ""),
					rootId: ref.ownerSessionId || findingDetail.data?.sessionId || selectedRef.rootId || rootId,
					materialKind: "request", requestKind: "request",
					summary: "请求 " + String(ref.id || "") + (ref.revision ? ":" + ref.revision : "") }); },
				onOpenEvidence: function (receipt) { pushRef({ kind: "http", id: receipt.id, rootId: receipt.rootId || findingDetail.data?.sessionId || selectedRef.rootId || rootId,
					summary: (findingDetail.data?.title || "执行回执") + " · " + receipt.id }); } });
		}
		if (["http", "model", "attempt", "role"].indexOf(selectedRef.kind) >= 0) {
			return h(SakerExecutionInspector, { selected: selectedRef, state: executionDetail,
				tab: detailTab, onTab: setDetailTab, headingRef: detailHeadingRef,
				onClose: closeDetail, back: selectedStack.length > 1 ? closeDetail : null,
				onRetry: refresh, onConversation: function () { openConversationFor(selectedRef.rootId || rootId); },
				onOpenTask: function () { openTaskFromEvidence(selectedRef.rootId || rootId, "execution"); } });
		}
		if (selectedRef.kind === "graph") {
			return h(SakerGraphInspector, { selected: selectedRef, headingRef: detailHeadingRef,
				onClose: closeDetail, back: selectedStack.length > 1 ? closeDetail : null,
				onOpenNode: function (node) { openExplorationNode(node); } });
		}
		if (selectedRef.kind === "material") {
			return h(SakerMaterialInspector, { selected: selectedRef, state: materialDetail,
				tab: detailTab, onTab: setDetailTab,
				headingRef: detailHeadingRef, onClose: closeDetail, back: selectedStack.length > 1 ? closeDetail : null,
				onRetry: refresh, onLoadMore: function (offset) { setMaterialOffset(offset || 0); },
				onOpenTask: function () { openTaskFromEvidence(selectedRef.rootId || rootId, "assets"); } });
		}
		return h(SakerAssetInspector, { selected: selectedRef, row: selectedRef.row,
			tab: detailTab, onTab: setDetailTab, headingRef: detailHeadingRef,
			onClose: closeDetail, back: selectedStack.length > 1 ? closeDetail : null,
			onOpenTask: function () { openTaskFromEvidence(selectedRef.rootId || rootId, "assets"); },
			onOpenReceipt: function (receipt) { pushRef({ kind: "http", id: receipt.id,
				rootId: selectedRef.rootId || rootId, summary: receipt.id }); },
			onFindRequest: function (request) {
				var owner = selectedRef.rootId || rootId;
				if (!owner) return;
				openRoot(owner, "execution");
				resetList("task.execution", { text: request.endpoint || request.id || "" });
			} });
	}
	function renderWorkgrid(list, inspector, hint) {
		if (!inspector) return h("div", { className: "saker-wb-workgrid" }, h("section", { className: "saker-wb-listpane" }, list));
		return h("div", { className: "saker-wb-workgrid has-detail" + (detailOnly ? " is-detail-only" : "") },
			h("section", { className: "saker-wb-listpane" }, list),
			h("div", { className: "saker-wb-detailpane" },
				detailOnly ? h("button", { type: "button", className: "saker-wb-btn saker-wb-detailback", onClick: closeDetail }, "← 返回列表") : null,
				inspector),
			hint ? h("div", { className: "saker-wb-mocknote" }, hint) : null);
	}
	function openFinding(id, owner) { pushRef({ kind: "finding", id: id, rootId: owner || rootId }); }
	function openTraffic(row) { pushRef({ kind: "http", id: row.id, rootId: row.rootId, summary: row.method + " " + row.url }); }
	function openAsset(row) {
		if (row.kind === "material" || row.kind === "file") {
			pushRef({ kind: "material", id: row.id, rootId: row.rootId || rootId, row: row, materialKind: "file",
				summary: row.name || row.title || row.id });
			return;
		}
		pushRef({ kind: "asset", id: row.id, rootId: row.rootId || rootId, row: row,
			summary: row.url || row.endpoint || row.name || row.id });
	}
	function openExecutionRow(row) { pushRef({ kind: row.kind === "http" ? "http" : row.kind, id: row.id, rootId: rootId, summary: row.summary }); }
	function openExplorationNode(node) {
		if (!node) return;
		// 从测试路径打开关联记录时保持该页，详情结束后仍回到原图上下文。
		if (node.kind === "finding") { openFinding(node.id, rootId); return; }
		if (node.kind === "request") {
			pushRef({ kind: "material", id: String(node.requestId || node.id) + (node.revision ? ":" + node.revision : ""),
				rootId: node.ownerSessionId || rootId, materialKind: "request", summary: node.title || node.id });
			return;
		}
		if (node.kind === "receipt" || node.kind === "http") { pushRef({ kind: "http", id: node.id, rootId: rootId, summary: node.title }); return; }
		if (node.kind === "attempt") { pushRef({ kind: "attempt", id: node.id, rootId: rootId, summary: node.title }); return; }
		if (node.kind === "asset" || node.kind === "endpoint" || node.kind === "check") {
			pushRef({ kind: "asset", id: node.id, rootId: rootId, row: node, summary: node.title });
			return;
		}
		pushRef({ kind: "graph", id: node.id, rootId: rootId, node: node, summary: node.title || node.id });
	}

	var nav = h(SakerWorkbenchNav, { page: page === "task" ? "tasks" : page, collapsed: navCollapsed,
		onToggle: toggleNav, onNavigate: onNavigate });
	var pageLabel = ({ dashboard: "概览", tasks: "测试任务", task: "测试任务", evidence: "发现与证据", resources: "配置与资料",
		attention: "待办事项", logs: "执行日志" })[page] || "概览";
	function buildPageContent() {
	var inspector = renderInspector();
	var pageContent = null;

	if (handoff) {
		pageContent = h(SakerHandoffPanel, { state: handoff, task: task, headingRef: detailHeadingRef,
			onClose: closeHandoff, onRetry: openHandoff,
			onDownload: downloadHandoff, downloading: busy === "delivery.download",
			onOpenFindings: function () { closeHandoff(); setPage("task"); setTaskTab("findings"); setSelectedStack([]); },
			onOpenAssets: function () { closeHandoff(); setPage("task"); setTaskTab("assets"); setSelectedStack([]); } });
	} else if (page === "dashboard") {
		if (dashboard.loading && !dashboard.data) {
			pageContent = h("div", { className: "saker-wb-page" },
				h(SakerPageIntro, { eyebrow: "Saker / 测试", title: "测试概览", subtitle: "汇总全部测试任务、发现和待办事项；统计口径为全部测试任务。" }),
				h(SakerInspectorLoading, { label: "读取测试任务、待办与发现统计…" }));
		} else {
			var summary = dashboard.data || {};
			var attentionRows = attentionQuery.data || [];
			pageContent = h("div", { className: "saker-wb-page" },
			h(SakerPageIntro, { eyebrow: "Saker / 测试", title: "测试概览",
				subtitle: "汇总全部测试任务、发现和待办事项；统计口径为全部测试任务。",
				actions: h("div", { className: "saker-wb-row" },
					h("button", { type: "button", className: "saker-wb-btn", onClick: function () { onNavigate("tasks"); } }, "查看全部任务"),
					h("button", { type: "button", className: "saker-wb-btn primary", onClick: function () { onNavigate("evidence"); } }, "查看发现与证据")) }),
			h("div", { className: "saker-wb-facts" },
				[{ label: "测试任务", value: summary.roots || 0, onClick: function () { onNavigate("tasks"); } },
					{ label: "运行中", value: summary.runningRoots ?? summary.activeRoots ?? 0, title: "只统计业务状态为运行中的任务；已结束、暂停和已停止不在这里",
						onClick: function () { resetList("tasks", { state: "running" }); onNavigate("tasks"); } },
					{ label: "待复核发现", value: summary.pending || 0, onClick: function () { resetList("evidence.findings", { verification: "needs-recheck" }); setEvidenceTab("findings"); onNavigate("evidence"); } },
					{ label: "待办事项", value: summary.attention || 0, onClick: function () { onNavigate("attention"); } }].map(function (item) {
					return h("button", { key: item.label, type: "button", className: "saker-wb-fact clickable", title: item.title || ("查看" + item.label), onClick: item.onClick },
						h("strong", null, item.value), h("span", null, item.label));
				})),
			h("div", { className: "saker-wb-dash-next" },
				h("section", { className: "saker-wb-band" },
					h("div", { className: "saker-wb-bandhead" },
						h("h2", null, "待办事项"), h("span", { className: "saker-wb-chip warn" }, (summary.attention || 0) + " 项")),
					attentionRows.length ? h("div", { className: "saker-wb-actions" }, attentionRows.slice(0, 3).map(function (row) {
						return h("div", { key: row.id, className: "saker-wb-actionrow" },
							h("div", null, h("strong", null, row.title || row.reason),
								h("p", null, wbAttentionKindLabel(row.kind) + " · " + row.reason),
								row.evidence ? h("p", { className: "saker-wb-sub" }, "依据：" + row.evidence) : null,
								h("p", { className: "saker-wb-sub" }, "下一步：" + (row.next || "打开任务核对具体缺项"))),
							h("button", { type: "button", className: "saker-wb-btn",
								onClick: function () { if (row.rootId) openRoot(row.rootId, row.kind === "cleanup" ? "overview" : "overview"); else onNavigate("attention"); } }, "查看任务"));
					})) : h("div", { className: "saker-wb-empty" }, attentionQuery.loading ? "读取中…" : "没有待办事项。"),
					(summary.attention || 0) > 3 ? h("div", { className: "saker-wb-bandfoot" },
						h("button", { type: "button", className: "saker-wb-btn", onClick: function () { onNavigate("attention"); } }, "查看其余 " + ((summary.attention || 0) - 3) + " 项")) : null),
				h("section", { className: "saker-wb-band" },
					h("div", { className: "saker-wb-bandhead" }, h("h2", null, "最近测试任务"), h("small", null, "按更新时间")),
					h(SakerTaskTableV2, { rows: summary.recentRoots || [], onOpen: openRoot, compact: true }),
					h("div", { className: "saker-wb-bandfoot" },
						h("small", null, "显示 " + Math.min(5, (summary.recentRoots || []).length) + " / " + (summary.roots || 0) + " 条"),
						h("button", { type: "button", className: "saker-wb-btn", onClick: function () { onNavigate("tasks"); } }, "查看全部")))));
		}
	} else if (page === "tasks") {
		pageContent = h("div", { className: "saker-wb-page" },
			h(SakerPageIntro, { eyebrow: "Saker / 测试任务", title: "测试任务", subtitle: "搜索测试任务、范围或会话 ID；打开任务会保留当前筛选。" }),
			h("section", { className: "saker-wb-band saker-wb-listing" },
				h(SakerTaskListToolbar, { text: taskList.text, state: taskList.state,
					onText: function (value) { resetList("tasks", { text: value }); },
					onState: function (value) { resetList("tasks", { state: value }); },
					onClear: function () { resetList("tasks", { text: "", state: "" }); },
					loadedLabel: taskQuery.loading ? "读取中…" : "当前 " + (taskQuery.data || []).length + " 条" +
						(taskQuery.meta && taskQuery.meta.page ? " · 共 " + taskQuery.meta.page.total + " 条" : "") }),
				h(SakerQueryError, { state: taskQuery, label: "测试任务", scope: "全部测试任务", onRetry: refresh }),
				h(SakerTaskTableV2, { rows: taskQuery.data || [], onOpen: openRoot,
					emptyText: taskList.text || taskList.state ? "没有匹配的测试任务。清除搜索或更换状态。" : "" }),
				renderPager("tasks", taskQuery, taskList.stack.length > 0)));
	} else if (page === "evidence") {
		var records = evidenceQuery.data || [];
		var table = null;
		if (evidenceTab === "findings") {
			table = h(SakerFindingsTable, { rows: records, showRoot: true, compact: compactRows, selectedKey: selectedRef && selectedRef.kind === "finding" ? selectionKey : "",
				rootLabel: function (id) {
					var owner = rootRows.find(function (row) { return row.rootId === id; });
					return owner ? (owner.title || "会话 " + String(id).slice(-8)) : "会话 " + String(id).slice(-8);
				},
				onSelect: openFinding });
		} else if (evidenceTab === "traffic") {
			table = h(SakerTrafficTable, { rows: records, selectedKey: selectedRef && selectedRef.kind === "http" ? selectionKey : "", onSelect: openTraffic });
		} else {
			table = h(SakerAssetsTable, { rows: records, showRoot: true,
				rootLabel: function (id) {
					var owner = rootRows.find(function (row) { return row.rootId === id; });
					return owner ? wbRootTitle(owner) : "会话 " + String(id || "").slice(-8);
				},
				selectedKey: selectedRef && selectedRef.kind === "asset" ? selectionKey : "", onSelect: openAsset });
		}
		var evidenceToolbar = h(SakerListToolbar, { text: evidenceList.text,
			onText: function (value) { resetList("evidence." + evidenceTab, { text: value }); },
			placeholder: evidenceTab === "findings" ? "搜索发现标题、摘要、目标或任务 ID" :
				evidenceTab === "traffic" ? "搜索 HTTP 请求、ID、账号或状态" : "搜索资产、请求、文件或检查项",
			filters: evidenceTab === "findings" ? h("span", { className: "saker-wb-row" },
				h("select", { value: evidenceList.verification, "aria-label": "按验证状态筛选发现",
					onChange: function (event) { resetList("evidence.findings", { verification: event.target.value }); } },
					h("option", { value: "" }, "全部验证状态"), h("option", { value: "verified" }, "已验证"),
					h("option", { value: "candidate" }, "待确认"), h("option", { value: "needs-recheck" }, "待复核"),
					h("option", { value: "not-reproduced" }, "未复现"), h("option", { value: "fixed" }, "已处置")),
				h("select", { value: evidenceList.severity, "aria-label": "按严重度筛选发现",
					onChange: function (event) { resetList("evidence.findings", { severity: event.target.value }); } },
					h("option", { value: "" }, "全部严重度"), h("option", { value: "critical" }, "严重"),
					h("option", { value: "high" }, "高危"), h("option", { value: "medium" }, "中危"), h("option", { value: "low" }, "低危")))
				: evidenceTab === "traffic" ? h("select", { value: evidenceList.status, "aria-label": "按 HTTP 状态筛选流量",
					onChange: function (event) { resetList("evidence.traffic", { status: event.target.value }); } },
					h("option", { value: "" }, "全部状态码"), ["200", "201", "204", "301", "302", "400", "401", "403", "404", "500"].map(function (code) {
						return h("option", { key: code, value: code }, code);
					})) : null,
			dirty: !!(evidenceList.text || evidenceList.verification || evidenceList.severity || evidenceList.status),
			onClear: function () { resetList("evidence." + evidenceTab, { text: "", verification: "", severity: "", status: "" }); },
			loadedLabel: evidenceQuery.loading ? "读取中…" : "当前 " + records.length + " 条" +
				(evidenceQuery.meta && evidenceQuery.meta.page ? " · 共 " + evidenceQuery.meta.page.total + " 条" : "") });
		var list = h("div", null,
			h("div", { className: "saker-wb-tabbar", role: "tablist", "aria-label": "发现与证据分类" },
				SAKER_EVIDENCE_TABS_V2.map(function (tab) {
					return h("button", { key: tab.id, type: "button", role: "tab", "aria-selected": evidenceTab === tab.id ? "true" : "false",
						className: "saker-wb-tab" + (evidenceTab === tab.id ? " active" : ""),
						onClick: function () { setEvidenceTab(tab.id); setSelectedStack([]); } }, tab.label);
				})),
			evidenceToolbar,
			h("div", { className: "saker-wb-row saker-wb-scopebar" }, renderScopePicker()),
			h(SakerQueryError, { state: evidenceQuery, label: "发现与证据", scope: rootId ? (rootRows.find(function (row) { return row.rootId === rootId; })?.title || rootId) : "全部测试任务", onRetry: refresh }),
			table,
			renderPager("evidence." + evidenceTab, evidenceQuery, evidenceList.stack.length > 0),
			h("div", { className: "saker-wb-mocknote" }, "记录与原件均为只读；选中后会立即打开详情，不会重新执行请求。"));
		pageContent = h("div", { className: "saker-wb-page" },
			h(SakerPageIntro, { eyebrow: "Saker / 发现与证据", title: "发现与证据",
				subtitle: "范围：" + currentScopeLabel() + " · 当前 " + records.length + " 条" +
					(evidenceQuery.meta && evidenceQuery.meta.page ? " / 共 " + evidenceQuery.meta.page.total + " 条" : "") +
					"；关闭详情会回到原来的列表位置。" }),
			renderWorkgrid(list, inspector, "左侧列表与右侧详情使用同一范围、同一筛选。"));
	} else if (page === "resources") {
		var resourceBody = null;
		if (resourceTab === "modules") resourceBody = h(SakerModulesPage, { rootId: rootId, tick: tick, run: run });
		else if (resourceTab === "roles") resourceBody = h(SakerRolesPage, { rows: rolesQuery.data || [], run: run, rootId: rootId, tick: tick });
		else if (resourceTab === "knowledge") resourceBody = h(SakerKnowledgePage, { rootId: rootId, tick: tick });
		else resourceBody = h("div", null,
			h(SakerListToolbar, { text: resourceList.text, onText: function (value) { resetList("resources.capabilities", { text: value }); },
				placeholder: "搜索工具名、用途或来源", dirty: !!resourceList.text,
				onClear: function () { resetList("resources.capabilities", { text: "" }); },
				loadedLabel: capabilitiesQuery.loading ? "读取中…" : "当前 " + (capabilitiesQuery.data || []).length + " 条" }),
			h(SakerQueryError, { state: capabilitiesQuery, label: "工具清单", scope: rootId || "未选择任务", onRetry: refresh }),
			!rootId ? h("div", { className: "saker-wb-empty" }, "先选择一个测试任务，才能读取该会话实际可用的工具。") : null,
			rootId ? h(SakerCapabilitiesTable, { rows: capabilitiesQuery.data || [] }) : null);
		pageContent = h("div", { className: "saker-wb-page" },
			h(SakerPageIntro, { eyebrow: "Saker / 配置与资料", title: "配置与资料",
				subtitle: "范围：" + (rootId ? currentScopeLabel() : "个人与内置") + "；测试模块、协作角色、知识库和工具清单使用现有定义与权限。",
				actions: renderScopePicker() }),
			h("div", { className: "saker-wb-tabbar", role: "tablist", "aria-label": "配置与资料分区" },
				SAKER_RESOURCE_TABS_V2.map(function (tab) {
					return h("button", { key: tab.id, type: "button", role: "tab", "aria-selected": resourceTab === tab.id ? "true" : "false",
						className: "saker-wb-tab" + (resourceTab === tab.id ? " active" : ""),
						onClick: function () { setResourceTab(tab.id); resetList("resources." + tab.id); } }, tab.label);
				})),
			resourceBody);
	} else if (page === "attention") {
		pageContent = h("div", { className: "saker-wb-page" },
			h(SakerPageIntro, { eyebrow: "Saker / 待办事项", title: "待办事项", subtitle: "只列仍需你决定或补齐的事项；普通回合结束和已完成任务不会出现在这里。" }),
			h("section", { className: "saker-wb-band" },
				h(SakerListToolbar, { text: attentionList.text, onText: function (value) { resetList("attention", { text: value }); },
					placeholder: "搜索待办原因或测试任务", dirty: !!attentionList.text,
					onClear: function () { resetList("attention", { text: "" }); },
					loadedLabel: attentionQuery.loading ? "读取中…" : "当前 " + (attentionQuery.data || []).length + " 条" +
						(attentionQuery.meta && attentionQuery.meta.page ? " · 共 " + attentionQuery.meta.page.total + " 条" : "") }),
				h(SakerQueryError, { state: attentionQuery, label: "待办事项", scope: "全部测试任务", onRetry: refresh }),
				attentionQuery.loading && !attentionQuery.data ? h(SakerInspectorLoading, { label: "读取待办事项…" }) :
					h(SakerAttentionList, { rows: attentionQuery.data || [], onOpen: openRoot }),
				renderPager("attention", attentionQuery, attentionList.stack.length > 0)));
	} else if (page === "logs") {
		pageContent = h("div", { className: "saker-wb-page" },
			h(SakerPageIntro, { eyebrow: "Saker / 执行日志", title: "执行日志", subtitle: "范围：" + currentScopeLabel() + "；事件摘要使用可读文本，内部码与原文留在高级区。", actions: renderScopePicker() }),
			h("section", { className: "saker-wb-band" },
				h(SakerListToolbar, { text: logsList.text, onText: function (value) { resetList("logs", { text: value }); },
					placeholder: "搜索事件类型或内容", dirty: !!logsList.text,
					onClear: function () { resetList("logs", { text: "" }); },
					loadedLabel: logsQuery.loading ? "读取中…" : "当前 " + (logsQuery.data || []).length + " 条" }),
				h(SakerQueryError, { state: logsQuery, label: "执行日志", scope: rootId || "未选择任务", onRetry: refresh }),
				!rootId ? h("div", { className: "saker-wb-empty" }, "先选择一个测试任务，再查看它的执行日志。") : null,
				rootId ? h(SakerLogsList, { rows: logsQuery.data || [] }) : null));
	} else if (page === "task") {
		if (!rootId) {
			pageContent = h("div", { className: "saker-wb-page" }, h("div", { className: "saker-wb-empty" }, "从任务列表选择一个任务。"));
		} else {
			var currentTask = taskDetail.data ? task : {};
			var currentRoot = currentTask.root || {};
			var counts = currentTask.overview?.counts || {};
			var taskFindings = taskFindingsQuery.data || [];
			var taskFindingsTotal = taskFindingsQuery.meta && taskFindingsQuery.meta.page ? taskFindingsQuery.meta.page.total : taskFindings.length;
	var taskBackLabel = taskOriginRef.current?.page === "evidence" ? "返回发现与证据"
		: taskOriginRef.current?.page === "dashboard" ? "返回概览" : "返回测试任务";
			var taskHead = h("header", { className: "saker-wb-task-head" },
				h("div", { className: "saker-wb-task-headmain" },
					h("div", { className: "saker-wb-row" },
						h("button", { type: "button", className: "saker-wb-btn", onClick: backFromTask }, taskBackLabel),
						h("span", { className: "saker-wb-chip " + wbBusinessTone(currentRoot.businessState) }, wbBusinessLabel(currentRoot.businessState)),
						h("span", { className: "saker-wb-sub" }, "更新 " + wbTime(currentRoot.updatedAt) +
							" · " + wbDurationText(currentRoot.duration?.elapsedMs) +
							" · 第 " + (currentRoot.generation || 1) + " 代")),
					h("h1", { className: "saker-wb-task-title" }, wbRootTitle(currentRoot)),
					h("p", { className: "saker-wb-page-sub" }, [currentRoot.targetSummary, currentRoot.taskKind, "会话 " + String(rootId).slice(-8)]
						.filter(Boolean).join(" · "))),
				h("div", { className: "saker-wb-task-actions" },
					h("button", { type: "button", className: "saker-wb-btn", onClick: openConversation }, "打开会话"),
			h("button", { type: "button", className: "saker-wb-btn primary", "data-saker-action": "export", onClick: openHandoff }, "导出报告"),
					currentRoot.canActions?.pause ? h("button", { type: "button", className: "saker-wb-btn", disabled: !!busy,
						onClick: function () { run("root.pause", { reason: "工作台暂停" }); } }, "暂停") : null,
					currentRoot.canActions?.resume ? h("button", { type: "button", className: "saker-wb-btn", disabled: !!busy,
						onClick: function () { run("root.resume", { reason: "工作台恢复" }); } }, "继续") : null,
					currentRoot.canActions?.stop ? h("button", { type: "button", className: "saker-wb-btn danger", disabled: !!busy,
						onClick: function () { setConfirmStop(true); } }, "停止本轮") : null));
			var body = null;
		if (taskDetail.loading && !taskDetail.data) body = h("div", { className: "saker-wb-empty" }, "读取测试任务概览…");
			else if (taskDetail.error && !taskDetail.data) body = h(SakerQueryError, { state: taskDetail, label: "测试任务", scope: rootId, onRetry: refresh });
			else if (taskTab === "overview") {
				var gaps = currentTask.overview?.gaps || [];
				var settlement = currentTask.roles?.settlementPending || 0;
				var nextTitle = currentRoot.attention?.reason || (gaps.length ? "仍缺 " + gaps.length + " 项证据或范围条件" :
					settlement ? "有 " + settlement + " 个并行任务待释放" :
					currentRoot.businessState === "turn-ended" ? "本回合已结束，等待下一步" : "按当前范围继续核实");
				var reviewData = reviewQuery.data || {};
				var reviewGroups = reviewData.items || [];
				var reviewBand = h("section", { className: "saker-wb-band", style: { gridColumn: "1 / -1" }, "data-saker-review-summary": "1" },
					h("div", { className: "saker-wb-bandhead" }, h("h2", null, "隔天复核摘要"),
						h("span", { className: "saker-wb-chip" + (reviewData.state === "paused" ? " warn" : "") },
							reviewData.reasonLabel || (reviewQuery.loading ? "读取中…" : "状态未知")),
						reviewQuery.loading && reviewQuery.data ? h("span", { className: "saker-wb-sub" }, "正在更新…") : null,
						h("button", { type: "button", className: "saker-wb-btn", onClick: refresh }, "刷新")),
					reviewQuery.error && !reviewQuery.data
						? h(SakerQueryError, { state: reviewQuery, label: "复核摘要", scope: rootId, onRetry: refresh })
						: (!reviewGroups.length
							? h("p", { className: "saker-wb-sub" }, reviewData.emptyLabel || "暂无已核对记录")
							: h("div", { style: { display: "grid", gap: "8px" } }, reviewGroups.map(function (group) {
								return h("div", { key: group[0].group },
									h("h3", { style: { margin: "4px 0" } }, group[0].groupLabel),
									h("div", { className: "saker-wb-linklist" }, group.map(function (item) {
										return h("div", { key: item.group + ":" + item.kind + ":" + item.id, className: "saker-wb-linkrow" },
											h("span", { className: "saker-wb-cell-main" },
												h("span", null, item.title || item.id),
												h("span", { className: "saker-wb-sub" }, " · " + (item.hint || item.groupLabel))),
											h("button", { type: "button", className: "saker-wb-btn",
												onClick: function () { openReviewItem(item); } },
												item.kind === "command" ? "查看操作记录" : item.kind === "http" ? "查看回执" : (item.evidenceHint || "看依据")));
									})));
							}))),
					reviewData.reasonDetail ? h("p", { className: "saker-wb-sub" }, "状态代码：" + reviewData.reasonDetail) : null,
					h("p", { className: "saker-wb-sub" }, "只读当前任务记录；打开、刷新或跳转不会调用模型、重放请求或写入复核。"));
				body = h("div", { className: "saker-wb-taskgrid" }, reviewBand,
					h("section", { className: "saker-wb-band" },
						h("div", { className: "saker-wb-bandhead" }, h("h2", null, "下一步"), h("span", { className: "saker-wb-chip " + wbBusinessTone(currentRoot.businessState) }, wbBusinessLabel(currentRoot.businessState))),
						h("div", { className: "saker-wb-actions" },
							h("div", { className: "saker-wb-actionrow" },
								h("div", null, h("strong", null, nextTitle),
									h("p", null, wbReasonLabel(currentTask.status?.reason) +
										(gaps.length ? "；具体缺口见资产与文件。" : "。"))),
								h("button", { type: "button", className: "saker-wb-btn", onClick: function () { setTaskTab("assets"); } }, "查看资产与文件"))),
						gaps.length ? h("div", { className: "saker-wb-gap-list" }, gaps.slice(0, 4).map(function (gap, index) {
							return h("p", { key: index }, (gap.endpoint || "范围") + "： " + (gap.missing || []).join("、"));
						})) : null),
					h("section", { className: "saker-wb-band" },
			h("div", { className: "saker-wb-bandhead" }, h("h2", null, "本轮汇总")),
						h("dl", { className: "saker-wb-metadl" },
							h("dt", null, "业务状态"), h("dd", null, wbBusinessLabel(currentRoot.businessState)),
							h("dt", null, "结果"), h("dd", null, "验证 " + (currentRoot.outcomeSummary?.verified || 0) + " · 待确认 " + (currentRoot.outcomeSummary?.pending || 0)),
							h("dt", null, "范围"), h("dd", null, currentRoot.targetSummary || "未记录"),
							h("dt", null, "用时"), h("dd", null, wbDurationText(currentRoot.duration?.elapsedMs) +
								(currentRoot.duration?.cappedBy === "deadline" ? "（已到时间上限）" : "")),
							h("dt", null, "用量"), h("dd", null, "工具 " + (currentTask.cost?.toolCalls ?? currentTask.policy?.used?.toolCalls ?? 0) +
								" 次 · 模型 " + (currentTask.cost?.modelCalls ?? currentTask.policy?.used?.modelCalls ?? 0) + " 次" +
								(currentTask.cost?.totalTokens != null ? " · 合计 " + currentTask.cost.totalTokens + " tokens" : "") +
								(currentTask.cost?.cacheReadTokens != null ? " · 缓存读 " + currentTask.cost.cacheReadTokens : "") +
								(currentTask.cost?.cacheWriteTokens != null ? " · 缓存写 " + currentTask.cost.cacheWriteTokens : "") +
								(currentTask.cost?.unknownUsageCalls ? " · 未知用量 " + currentTask.cost.unknownUsageCalls + " 次" : "")),
							h("dt", null, "身份"), h("dd", null, "由每次请求记录；概览不会猜测账号")),
						h("div", { className: "saker-wb-bandfoot" },
							h("small", null, "普通回合结束不会自动进入待办事项。"))));
			} else if (taskTab === "execution") {
				var execRows = taskExecution.data || [];
				var execModeBar = h("div", { className: "saker-wb-actions", role: "group", "aria-label": "执行视图" },
					h("button", { type: "button", className: "saker-wb-btn" + (executionView === "records" ? " primary" : ""),
						"aria-pressed": executionView === "records" ? "true" : "false",
						onClick: function () { setExecutionView("records"); setUsageCursor(""); } }, "执行记录"),
					h("button", { type: "button", className: "saker-wb-btn" + (executionView === "usage" ? " primary" : ""),
						"aria-pressed": executionView === "usage" ? "true" : "false",
						onClick: function () { setExecutionView("usage"); } }, "模型用量"));
				if (executionView === "usage") {
					var usageData = usageQuery.data || {};
					var usage = usageData.usage || {};
					var usageRows = usageData.rows || [];
					var fmtUsage = function (value) { return value === null || value === undefined ? "未知" : String(value); };
					var usagePanel = h("div", null, execModeBar,
						h(SakerQueryError, { state: usageQuery, label: "模型用量", scope: "当前任务本轮", onRetry: refresh }),
						usageData.unavailable
							? h("div", { className: "saker-wb-empty" }, usageData.reason || "暂无可观察用量")
							: h("div", null,
								h("div", { className: "saker-wb-kpis" },
									h("div", { className: "saker-wb-kpi" }, h("b", null, fmtUsage(usage.knownTokens)), h("span", null, "已知合计 tokens")),
									h("div", { className: "saker-wb-kpi" }, h("b", null, fmtUsage(usage.observedWireAttempts)), h("span", null, "传输尝试")),
									h("div", { className: "saker-wb-kpi" }, h("b", null, fmtUsage(usage.settledUsageCount)), h("span", null, "已结算")),
									h("div", { className: "saker-wb-kpi" }, h("b", null, fmtUsage(usage.unknownUsageCount)), h("span", null, "未知用量")),
									h("div", { className: "saker-wb-kpi" }, h("b", null, fmtUsage(usage.inFlightCount)), h("span", null, "处理中")),
									h("div", { className: "saker-wb-kpi" }, h("b", null, fmtUsage(usage.unobservedDispatchCount)), h("span", null, "未观测发送")),
									h("div", { className: "saker-wb-kpi" }, h("b", null, fmtUsage(usage.cancelledBeforeDispatch)), h("span", null, "发出前撤销")),
									h("div", { className: "saker-wb-kpi" }, h("b", null, fmtUsage(usage.excludedFromBudgetCount)), h("span", null, "不计预算只读"))),
								h("p", { className: "saker-wb-sub" }, "输入 " + fmtUsage(usage.inputTokens) + " · 输出 " + fmtUsage(usage.outputTokens)
									+ " · 缓存读 " + fmtUsage(usage.cacheReadTokens) + " · 缓存写 " + fmtUsage(usage.cacheWriteTokens)
									+ (usage.partial ? "；存在未知或处理中的调用，已知合计不是最终费用。" : "；已结算样本完整。")
									+ " 现金费用：未知。"),
								usageData.budget
									? h("p", { className: "saker-wb-sub" }, "本轮预算口径：已计调用 " + fmtUsage(usageData.budget.chargedCalls)
										+ " · 已知 " + fmtUsage(usageData.budget.knownTokens) + " · 预留 " + fmtUsage(usageData.budget.heldTokens)
										+ " · 未知 " + fmtUsage(usageData.budget.unknownCalls) + " · 未完成 " + fmtUsage(usageData.budget.unresolvedCalls))
									: h("p", { className: "saker-wb-sub" }, usageData.currentRound ? "该轮预算未保存。" : "历史轮次只显示同账本根的已保存调用。"),
								usageData.taskAuxiliary
									? h("p", { className: "saker-wb-sub" }, "任务辅助用量：" + usageData.taskAuxiliary.label
										+ " · 传输 " + usageData.taskAuxiliary.wireAttempts + " 次 · 已知 tokens " + fmtUsage(usageData.taskAuxiliary.knownTokens)
										+ (usageData.taskAuxiliary.unknownCurations ? " · 未知 " + usageData.taskAuxiliary.unknownCurations + " 条" : "")
										+ "（不计入本轮合计）")
									: null,
								h("div", { className: "saker-wb-table-wrap" }, h("table", { className: "saker-wb-table" },
									h("thead", null, h("tr", null, ["时间", "调用 ID", "用途", "模型", "状态", "传输", "已知 tokens"].map(function (label) {
										return h("th", { key: label }, label);
									}))),
									h("tbody", null, usageRows.map(function (row) {
										return h("tr", { key: row.id },
											h("td", null, row.at ? wbTime(new Date(Number(row.at)).toISOString()) : "—"),
											h("td", null, row.id),
											h("td", null, row.purpose || "—"),
											h("td", null, (row.provider ? row.provider + " / " : "") + (row.model || "—")),
											h("td", null, h("span", { className: "saker-wb-chip " + (row.state === "settled" ? "ok" : row.usageUnknown ? "warn" : "") },
												wbNodeStateLabel(row.state))),
											h("td", null, row.wire ? "已观察" : "未观察"),
											h("td", null, row.usage ? String(row.usage.totalTokens) : "未知"));
									})),
									usageRows.length ? null : h("tbody", null, h("tr", null, h("td", { colSpan: 7 }, "这一页没有调用记录。"))))),
								h("div", { className: "saker-wb-actions" },
									usageCursor ? h("button", { type: "button", className: "saker-wb-btn",
										onClick: function () { setUsageCursor(""); } }, "第一页") : null,
									usageQuery.meta && usageQuery.meta.page && usageQuery.meta.page.nextCursor
										? h("button", { type: "button", className: "saker-wb-btn",
											onClick: function () { setUsageCursor(usageQuery.meta.page.nextCursor); } }, "下一页") : null)),
						h("p", { className: "saker-wb-sub" }, "只读已保存账本；未知不显示为 0，现金费用统一未知；打开明细不会新增账本事件。"));
					body = renderWorkgrid(usagePanel, null, "模型用量按账本归属和轮次查询，不启动模型。");
				} else {
				var executionTable = h("div", null, execModeBar,
					h(SakerListToolbar, { text: taskExecutionList.text, onText: function (value) { resetList("task.execution", { text: value }); },
						placeholder: "搜索执行 ID、摘要、身份或状态",
						filters: h("select", { value: taskExecutionList.kind, "aria-label": "按执行类型筛选",
							onChange: function (event) { resetList("task.execution", { kind: event.target.value }); } },
							h("option", { value: "" }, "全部类型"), h("option", { value: "http" }, "HTTP"),
							h("option", { value: "model" }, "模型"), h("option", { value: "attempt" }, "尝试"), h("option", { value: "role" }, "角色")),
						dirty: !!(taskExecutionList.text || taskExecutionList.kind),
						onClear: function () { resetList("task.execution", { text: "", kind: "" }); },
						loadedLabel: taskExecution.loading ? "读取中…" : "当前 " + execRows.length + " 条" }),
					h(SakerQueryError, { state: taskExecution, label: "执行记录", scope: "当前测试任务", onRetry: refresh }),
					h("div", { className: "saker-wb-table-wrap" }, h("table", { className: "saker-wb-table saker-wb-exec-table" },
						h("thead", null, h("tr", null, ["时间", "类型", "做了什么", "状态", "账号/来源"].map(function (label) {
							return h("th", { key: label }, label);
						}))),
						h("tbody", null, execRows.map(function (row) {
							var key = row.kind + ":" + rootId + ":" + row.id;
							return h("tr", { key: row.kind + "/" + row.id, tabIndex: 0, "data-saker-row": key,
								className: selectionKey === key ? "selected" : "",
								onClick: function () { openExecutionRow(row); },
								onKeyDown: function (event) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openExecutionRow(row); } } },
								h("td", null, wbTime(row.at)), h("td", null, wbExecutionKindLabel(row.kind)),
								h("td", null, h("div", { className: "saker-wb-cell-main" }, row.summary), h("div", { className: "saker-wb-cell-sub" }, row.id)),
								h("td", null, h("span", { className: "saker-wb-chip " + (row.state === "completed" || row.state === "captured" ? "ok" : row.state === "cleanup-failed" ? "bad" : "") }, wbNodeStateLabel(row.state))),
								h("td", null, row.identity || row.source || "—"));
						})),
						execRows.length ? null : h("tbody", null, h("tr", null, h("td", { colSpan: 5 }, "没有匹配的执行记录。"))))),
					renderPager("task.execution", taskExecution, taskExecutionList.stack.length > 0));
				body = renderWorkgrid(executionTable, inspector, "执行详情在右侧打开，不会追加到列表末尾。");
				}
			} else if (taskTab === "exploration") {
				var graph = (exploration.data || [])[0] || { nodes: [], edges: [] };
				var graphList = h("div", null,
					exploration.error ? h("div", { className: "saker-wb-error" }, exploration.error) : null,
					h(SakerGraph, { graph: graph, onSelect: function (node) {
						pushRef({ kind: "graph", id: node.id, rootId: rootId, node: node, summary: node.title || node.id });
					},
						onOpenNode: openExplorationNode }),
					h("section", { className: "saker-wb-band saker-wb-graph-links" },
						h("div", { className: "saker-wb-bandhead" }, h("h2", null, "测试路径节点"), h("small", null, "列表入口不依赖图缩放")),
						h("div", { className: "saker-wb-scroll" }, (graph.nodes || []).map(function (node) {
							return h("button", { key: node.id, type: "button", className: "saker-wb-linkrow",
								onClick: function () {
									pushRef({ kind: "graph", id: node.id, rootId: rootId, node: node, summary: node.title || node.id });
								} },
								h("span", { className: "saker-wb-chip" }, wbGraphKindLabel(node.kind)),
								h("span", { className: "saker-wb-cell-main" }, node.title || node.id),
								h("span", { className: "saker-wb-sub" }, wbNodeStateLabel(node.state)));
						}))));
				body = renderWorkgrid(graphList, inspector, "路径图只画真实引用；选中节点后只打开一个详情。");
			} else if (taskTab === "findings") {
				var findingList = h("div", null,
					h(SakerListToolbar, { text: taskFindingsList.text, onText: function (value) { resetList("task.findings", { text: value }); },
						placeholder: "搜索发现标题、摘要或目标",
						filters: h("select", { value: taskFindingsList.verification, "aria-label": "按验证状态筛选发现",
							onChange: function (event) { resetList("task.findings", { verification: event.target.value }); } },
							h("option", { value: "" }, "全部状态"), h("option", { value: "verified" }, "已验证"),
							h("option", { value: "candidate" }, "待确认"), h("option", { value: "needs-recheck" }, "待复核"),
							h("option", { value: "not-reproduced" }, "未复现"), h("option", { value: "fixed" }, "已处置")),
						dirty: !!(taskFindingsList.text || taskFindingsList.verification),
						onClear: function () { resetList("task.findings", { text: "", verification: "" }); },
						loadedLabel: taskFindingsQuery.loading ? "读取中…" : "当前 " + taskFindings.length + " 条 · 共 " + taskFindingsTotal + " 条" }),
					h(SakerQueryError, { state: taskFindingsQuery, label: "发现", scope: currentRoot.title || rootId, onRetry: refresh }),
					h(SakerFindingsTable, { rows: taskFindings, showRoot: false, compact: compactRows, rootId: rootId,
						selectedKey: selectedRef && selectedRef.kind === "finding" ? selectionKey : "",
						onSelect: function (id) { openFinding(id, rootId); } }),
					renderPager("task.findings", taskFindingsQuery, taskFindingsList.stack.length > 0),
					h("div", { className: "saker-wb-mocknote" }, "发现只来自已记录成果；未测缺口不是发现。"));
				body = renderWorkgrid(findingList, inspector, "详情在可见区域打开，返回保留当前列表位置。");
			} else {
				var assets = taskAssets.data || [];
				var cover = (coverage.data || [])[0] || { nodes: [], edges: [], checkDimensions: { total: 0, notHit: 0, blocked: 0, notTested: 0 }, knownDenominator: 0 };
				var dims = cover.checkDimensions || {};
				var assetsList = h("div", null,
					h("div", { className: "saker-wb-tabbar", role: "tablist", "aria-label": "资产视图" },
						h("button", { type: "button", role: "tab", "aria-selected": !coverageMode ? "true" : "false",
							className: "saker-wb-tab" + (!coverageMode ? " active" : ""), onClick: function () { setCoverageMode(false); } }, "列表"),
						h("button", { type: "button", role: "tab", "aria-selected": coverageMode ? "true" : "false",
							className: "saker-wb-tab" + (coverageMode ? " active" : ""), onClick: function () { setCoverageMode(true); } }, "覆盖")),
					coverageMode ? h("div", null,
						h("div", { className: "saker-wb-facts compact" },
							[["已知分母", cover.knownDenominator || 0], ["已测未命中", dims.notHit || 0],
								["未测", dims.notTested || 0], ["受阻", dims.blocked || 0]].map(function (item) {
								return h("div", { key: item[0], className: "saker-wb-fact" }, h("strong", null, item[1]), h("span", null, item[0]));
							})),
						h(SakerGraph, { graph: cover, emptyText: "当前任务还没有资产、请求或检查记录；先执行请求或导入资产，覆盖才会出现节点。",
							onSelect: function (node) {
								pushRef({ kind: "graph", id: node.id, rootId: rootId, node: node, summary: node.title || node.id });
							},
							onOpenNode: openExplorationNode }),
						h("div", { className: "saker-wb-mocknote" }, "分母未知时写“覆盖分母未知”，不显示看似正确的百分比。"))
						: h("div", null,
							h(SakerListToolbar, { text: taskAssetsList.text, onText: function (value) { resetList("task.assets", { text: value }); },
							placeholder: "搜索资产、请求、文件或检查", dirty: !!taskAssetsList.text,
								onClear: function () { resetList("task.assets", { text: "" }); },
								loadedLabel: taskAssets.loading ? "读取中…" : "当前 " + assets.length + " 条" }),
					h(SakerQueryError, { state: taskAssets, label: "资产与文件", scope: "当前测试任务", onRetry: refresh }),
							h(SakerAssetsTable, { rows: assets, showRoot: false, rootId: rootId,
								selectedKey: selectedRef && selectedRef.kind === "asset" ? selectionKey : "", onSelect: openAsset }),
							renderPager("task.assets", taskAssets, taskAssetsList.stack.length > 0)));
				body = renderWorkgrid(assetsList, inspector, "文件不等于覆盖完成；没有分母时不会计算百分比。");
			}
			pageContent = h("div", { className: "saker-wb-page saker-wb-taskpage" }, taskHead,
				h("div", { className: "saker-wb-tabbar", role: "tablist", "aria-label": "测试任务分区" },
					SAKER_TASK_TABS_V2.map(function (tabItem) {
						return h("button", { key: tabItem.id, type: "button", role: "tab", "aria-selected": taskTab === tabItem.id ? "true" : "false",
							className: "saker-wb-tab" + (taskTab === tabItem.id ? " active" : ""),
							onClick: function () { setTaskTab(tabItem.id); setSelectedStack([]); setExplorationNode(null); } }, tabItem.label);
					})),
				confirmStop ? h("div", { className: "saker-wb-notice warn" },
					h("span", null, "停止本轮会撤销本代新执行许可，并保留在途事实与未完成项。确认停止？"),
					h("button", { type: "button", className: "saker-wb-btn danger", disabled: !!busy,
						onClick: function () { setConfirmStop(false); run("scope.stop", { scopeKind: "root", reason: "工作台确认停止" }); } }, "确认停止"),
					h("button", { type: "button", className: "saker-wb-btn", onClick: function () { setConfirmStop(false); } }, "取消")) : null,
				body);
		}
	}
	return pageContent;
	}

	var mobileNav = h("select", { className: "saker-wb-mobile-nav", "aria-label": "切换工作台页面",
		value: page === "task" ? "tasks" : page,
		onChange: function (event) { onNavigate(event.target.value); } },
		SAKER_WB_NAV_V2.map(function (group) {
			return h("optgroup", { key: group.group, label: group.group },
				group.items.map(function (item) { return h("option", { key: item.id, value: item.id }, item.label); }));
		}));
	var header = h("header", { className: "saker-wb-context" },
		h("div", { className: "saker-wb-crumb" }, h("strong", null, "Saker"), h("span", null, "/ " + pageLabel +
			(page === "task" && rootId ? " / " + String(rootId).slice(-8) : ""))),
		mobileNav,
		h("span", { className: "saker-wb-spacer" }),
		h("span", { className: "saker-wb-context-note" }, "只读工作台 · 不自动启动模型"),
		h("button", { type: "button", className: "saker-wb-btn", onClick: refresh },
			(taskDetail.loading || evidenceQuery.loading || taskQuery.loading || dashboard.loading) ? "刷新中…" : "刷新"));
	return h("div", { className: "saker-wb saker-wb-v2" + (navCollapsed ? " is-nav-collapsed" : "") + (topNavMode ? " is-topnav" : ""), ref: setRootEl },
		nav,
		h("main", { className: "saker-wb-main" }, header,
			h("div", { className: "saker-wb-scroll", ref: contentRef },
				notice ? h("div", { className: "saker-wb-notice" }, h("span", null, notice),
					h("button", { type: "button", className: "saker-wb-btn", onClick: function () { setNotice(""); } }, "关闭")) : null,
				unknownCommand ? h("div", { className: "saker-wb-notice warn", role: "status" },
					h("span", null, "有一条命令结果未知（" + unknownCommand.commandId + "）。确认前不会重新发送。"),
					h("button", { type: "button", className: "saker-wb-btn", disabled: busy === "command.reconcile",
						onClick: reconcileUnknown }, busy === "command.reconcile" ? "查询中…" : "确认原命令")) : null,
				h(SakerRenderBoundary, {
					key: page + ":" + rootId + ":" + taskTab + ":" + detailTab + ":" + selectedStack.length,
					onRetry: refresh,
					onBack: function () { setPage("tasks"); setRootId(""); setTaskTab("overview"); setSelectedStack([]); },
				}, h(SakerBoundaryContent, { build: buildPageContent })))));
}
function SakerInspectorLoading(props) {
	return h("div", { className: "saker-wb-skeleton", "aria-live": "polite" },
		h("span", { className: "saker-wb-skeleton-line wide" }), h("span", { className: "saker-wb-skeleton-line" }),
		h("span", { className: "saker-wb-skeleton-line short" }),
		h("div", { className: "saker-wb-sub" }, props.label || "读取详情…"));
}
function SakerInspectorError(props) {
	return h("div", { className: "saker-wb-error", role: "alert" },
		props.message,
		props.stale ? h("div", { className: "saker-wb-sub" }, "下方保留的是同一记录上一次成功读取的数据，不是本次结果。") : null,
		props.onRetry ? h("div", { style: { marginTop: "8px" } },
			h("button", { type: "button", className: "saker-wb-btn", onClick: props.onRetry }, "重试")) : null);
}
function SakerFindingInspector(props) {
	var state = props.state || {};
	var data = state.data || {};
	var refs = data.verificationBasis || data.evidenceRefs || [];
	var resolvedRefs = data.evidenceReferences || [];
	var receipts = data.receipts || [];
	var retests = data.retests || [];
	var hasData = !!state.data;
	var tab = props.tab || "summary";
	var owner = data.sessionId || props.selected.rootId || "";
	var findingId = data.findingId || data.id || (props.selected && props.selected.id) || "";
	var reviewOpenState = useState(false), reviewOpen = reviewOpenState[0], setReviewOpen = reviewOpenState[1];
	var reviewDecisionState = useState("insufficient"), reviewDecision = reviewDecisionState[0], setReviewDecision = reviewDecisionState[1];
	var reviewNoteState = useState(""), reviewNote = reviewNoteState[0], setReviewNote = reviewNoteState[1];
	var reviewRefsState = useState([]), reviewRefs = reviewRefsState[0], setReviewRefs = reviewRefsState[1];
	var reviewBusyState = useState(false), reviewBusy = reviewBusyState[0], setReviewBusy = reviewBusyState[1];
	var reviewNoticeState = useState(""), reviewNotice = reviewNoticeState[0], setReviewNotice = reviewNoticeState[1];
	var reviewRequest = useRef("");
	var historyExtraState = useState([]), historyExtra = historyExtraState[0], setHistoryExtra = historyExtraState[1];
	var historyCursorState = useState(data.reviewHistoryCursor || null), historyCursor = historyCursorState[0], setHistoryCursor = historyCursorState[1];
	var historyTotalState = useState(Number(data.reviewTotal) || 0), historyTotal = historyTotalState[0], setHistoryTotal = historyTotalState[1];
	var historyLoadingState = useState(false), historyLoading = historyLoadingState[0], setHistoryLoading = historyLoadingState[1];
	var historySeq = useRef(0);
	var historyCurrentRef = useRef({ owner: "", id: "" });
	historyCurrentRef.current = { owner: owner, id: findingId };
	useEffect(function () {
		historySeq.current += 1;
		setHistoryExtra([]);
		setHistoryCursor(data.reviewHistoryCursor || null);
		setHistoryTotal(Number(data.reviewTotal) || 0);
		setHistoryLoading(false);
	}, [owner, findingId, data.reviewHistoryCursor, data.reviewTotal]);
	function reviewRefKey(ref) { return String(ref.kind || "") + "|" + String(ref.id || "") + "|" + String(ref.revision || ""); }
	function reviewSelectable(ref) { return !!ref.openRef && ["exact", "unique-legacy"].indexOf(String(ref.location || "")) >= 0; }
	function reviewSelectableRefs() { return resolvedRefs.filter(reviewSelectable); }
	function toggleReviewRef(ref) {
		var key = reviewRefKey(ref);
		setReviewRefs(reviewRefs.indexOf(key) >= 0 ? reviewRefs.filter(function (item) { return item !== key; }) : reviewRefs.concat([key]));
	}
	function saveEvidenceReview() {
		if (reviewBusy) return;
		var note = String(reviewNote || "").trim();
		if (!note) { setReviewNotice("请写明这次复核看到什么、还缺什么。"); return; }
		var chosen = reviewSelectableRefs().filter(function (ref) { return reviewRefs.indexOf(reviewRefKey(ref)) >= 0; })
			.map(function (ref) { return { kind: ref.kind, id: ref.id, revision: ref.revision || "" }; });
		if (reviewDecision === "supported" && !chosen.length) {
			setReviewNotice("标记“依据足以支持”至少选择一个可打开的原件。");
			return;
		}
		var requestId = reviewRequest.current || ((typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : "review-" + Date.now() + "-" + Math.random().toString(36).slice(2));
		reviewRequest.current = requestId;
		setReviewBusy(true); setReviewNotice("");
		api("finding.evidence-review.save", {
			sessionId: owner, rootId: owner, findingId: findingId,
			expectedFindingRevision: data.findingRevision || "",
			expectedBasisDigest: data.basisDigest || "",
			expectedHeadSeq: data.reviewHead ? Number(data.reviewHead.reviewSeq) || 0 : 0,
			requestId: requestId, decision: reviewDecision, note: note, refs: chosen,
		}).then(function (response) {
			var failure = wbResponseError(response, "依据复核保存失败");
			if (failure) throw failure;
			reviewRequest.current = "";
			setReviewBusy(false);
			setReviewNotice(response.idempotent ? "已取回同一请求的复核结果。" : "依据复核已保存。");
			setReviewOpen(false); setReviewNote(""); setReviewRefs([]);
			if (props.onRetry) props.onRetry();
		}).catch(function (error) {
			setReviewBusy(false);
			setReviewNotice(wbErrorText(error));
			if (props.onRetry) props.onRetry();
		});
	}
	function loadMoreHistory() {
		if (!historyCursor || historyLoading) return;
		var ownerAt = owner, idAt = findingId;
		var seq = ++historySeq.current;
		setHistoryLoading(true);
		api("workbench.query", { kind: "findings.review-history",
			context: { rootId: ownerAt, findingId: idAt }, page: { cursor: historyCursor, limit: 20 } })
			.then(function (response) {
				if (seq !== historySeq.current) return;
				var current = historyCurrentRef.current;
				if (current.owner !== ownerAt || current.id !== idAt) return;
				var failure = wbResponseError(response, "读取更早复核记录失败");
				if (failure) throw failure;
				setHistoryExtra(function (previous) { return previous.concat(response.data || []); });
				setHistoryCursor(response.page && response.page.nextCursor ? response.page.nextCursor : null);
				setHistoryLoading(false);
			})
			.catch(function (error) {
				if (seq !== historySeq.current) return;
				setHistoryLoading(false);
				setReviewNotice(wbErrorText(error));
			});
	}
	function body() {
		if (state.error && !hasData) return h(SakerInspectorError, { message: "读取发现详情失败：" + state.error, onRetry: props.onRetry });
		if (!hasData && state.loading) return h(SakerInspectorLoading, { label: "读取发现详情…" });
		if (!hasData) return h("div", { className: "saker-wb-empty" }, "这条发现的详情不可用。");
		var chips = h("div", { className: "saker-wb-chiprow" },
			h("span", { className: "saker-wb-chip " + (data.verificationState === "verified" ? "ok" : data.verificationState === "candidate" || data.verificationState === "needs-recheck" ? "warn" : "") },
				wbVerificationLabel(data.verificationState)),
			h("span", { className: "saker-wb-chip " + (data.severity === "critical" || data.severity === "high" ? "bad" : "") }, SEVERITY_LABEL[data.severity] || data.severity || "未评级"),
			data.reviewHead ? h("span", { className: "saker-wb-chip " + (data.reviewHead.current ? "ok" : "warn") }, data.reviewHead.decisionLabel || "已记录依据复核")
				: h("span", { className: "saker-wb-chip" }, "未记录依据复核"),
			h("span", { className: "saker-wb-sub" }, "依据 " + (resolvedRefs.length || refs.length) + " 条 · 复测 " + retests.length + " 次"));
		if (tab === "evidence") {
			return h("div", null, chips,
				h("p", null, "以下记录均已存在；打开不会重新执行请求。"),
				h("h3", null, "依据引用"),
				(resolvedRefs.length || refs.length) ? h("div", { className: "saker-wb-linklist" }, (resolvedRefs.length ? resolvedRefs : refs).map(function (ref, index) {
					var openType = (ref.openRef && ref.openRef.type) || (ref.openKind === "http" ? "execution" : ref.openKind === "material" ? "material" : "");
					var openId = (ref.openRef && ref.openRef.id) || ref.executionId || ref.materialId || ref.id;
					var canOpenReceipt = openType === "execution";
					var canOpenMaterial = openType === "material";
					var canOpenRequest = openType === "request";
					return h("div", { key: String(ref.kind || "ref") + ":" + String(ref.id || "") + ":" + String(ref.revision || index), className: "saker-wb-linkrow" },
						h("span", { className: "saker-wb-chip " + (canOpenReceipt || canOpenMaterial || canOpenRequest ? "ok" : ref.location === "ambiguous" ? "warn" : "bad") },
							wbEvidenceRefKindLabel(ref.kind)),
						h("span", { className: "saker-wb-cell-main" },
							h("span", null, ref.label || ref.id || "—"),
							h("span", { className: "saker-wb-sub" }, " · " + (ref.reason || ref.reasonCode || (canOpenRequest ? "可打开请求原件" : canOpenReceipt ? "可读取回执" : canOpenMaterial ? "可读取文件" : "原件不可用")))),
						canOpenRequest && props.onOpenRequest ? h("button", { type: "button", className: "saker-wb-btn",
							onClick: function () { props.onOpenRequest({ kind: "request", ownerSessionId: ref.openRef.ownerSessionId, id: ref.openRef.id, revision: ref.openRef.revision || "" }); } }, "打开请求")
							: canOpenReceipt && props.onOpenEvidence ? h("button", { type: "button", className: "saker-wb-btn",
							onClick: function () { props.onOpenEvidence({ id: openId, rootId: (ref.openRef && ref.openRef.ownerSessionId) || data.sessionId || props.selected.rootId }); } }, "查看回执")
							: canOpenMaterial && props.onOpenMaterial ? h("button", { type: "button", className: "saker-wb-btn",
								onClick: function () { props.onOpenMaterial({ id: openId, materialId: openId, rootId: (ref.openRef && ref.openRef.ownerSessionId) || data.sessionId, kind: "file", label: ref.label }); } }, "打开文件")
								: null);
				})) : h("div", { className: "saker-wb-empty" }, "没有可读依据引用。"),
				h("h3", null, "HTTP 回执" + (Number(data.receiptTotal) > receipts.length ? "（显示 " + receipts.length + " / " + data.receiptTotal + "）" : "")),
				receipts.length ? h("div", { className: "saker-wb-linklist" }, receipts.map(function (receipt) {
					return h("div", { key: receipt.id, className: "saker-wb-linkrow" },
						h("span", { className: "saker-wb-chip " + (receipt.current && receipt.integrityValid ? "ok" : "warn") },
							receipt.status != null ? "HTTP " + receipt.status : "回执"),
						h("span", { className: "saker-wb-cell-main" }, receipt.id + (receipt.current === false ? " · 已失效" : "")),
						props.onOpenEvidence ? h("button", { type: "button", className: "saker-wb-btn",
							onClick: function () { props.onOpenEvidence(receipt); } }, "查看回执") : null);
				})) : h("p", { className: "saker-wb-sub" }, "没有返回可直接打开的回执；这不等于原件已阅读。"));
		}
		if (tab === "history") {
			var selectable = reviewSelectableRefs();
			var reviewHistory = (Array.isArray(data.reviewHistory) ? data.reviewHistory : []).slice();
			var seenReviewSeq = new Set(reviewHistory.map(function (item) { return String(item.reviewSeq); }));
			historyExtra.forEach(function (item) {
				if (seenReviewSeq.has(String(item.reviewSeq))) return;
				seenReviewSeq.add(String(item.reviewSeq));
				reviewHistory.push(item);
			});
			return h("div", null, chips,
				h("h3", null, "依据复核"),
				h("p", { className: "saker-wb-sub" },
					data.reviewHead ? (data.reviewHead.decisionLabel + " · " + wbTime(data.reviewHead.createdAt)
						+ (data.reviewHead.current ? " · 当前依据仍匹配" : " · 原判断保留，当前依据不可复核"))
						: (data.headNote || "尚未记录人工依据复核。打开详情或切换页签不会代替你作出判断。")),
				data.reviewHead && data.reviewHead.note ? h("div", { className: "saker-wb-callout" }, data.reviewHead.note) : null,
				reviewNotice ? h("div", { className: "saker-wb-callout", role: "status" }, reviewNotice) : null,
				h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap", margin: "8px 0" } },
					h("button", { type: "button", className: "saker-wb-btn", onClick: function () { setReviewOpen(!reviewOpen); } },
						reviewOpen ? "收起复核表单" : (data.reviewHead ? "更正或补充依据复核" : "记录依据复核")),
					props.onRetry ? h("button", { type: "button", className: "saker-wb-btn", disabled: reviewBusy, onClick: props.onRetry }, "刷新原件状态") : null),
				reviewOpen ? h("div", { style: { display: "grid", gap: "8px", padding: "12px", border: "1px solid var(--dsw-alias-border-l1,#d8dce6)", borderRadius: "10px", margin: "8px 0" } },
					h("label", { className: "saker-wb-sub" }, "结论",
						h("select", { value: reviewDecision, onChange: function (event) { setReviewDecision(event.target.value); }, style: { display: "block", width: "100%" } },
							h("option", { value: "supported" }, "依据足以支持"),
							h("option", { value: "insufficient" }, "依据不足"),
							h("option", { value: "superseded" }, "已更正先前判断"))),
					h("label", { className: "saker-wb-sub" }, "复核说明（1–2000 字）",
						h("textarea", { value: reviewNote, maxLength: 2000, rows: 3, style: { display: "block", width: "100%" },
							placeholder: "写明看到的原件、适用范围和还缺什么；正文里的“已验证”不会替你复核。",
							onChange: function (event) { setReviewNote(event.target.value); } })),
					selectable.length ? h("div", null,
						h("div", { className: "saker-wb-sub" }, "这次实际核对的原件（" + selectable.length + " 条可打开）"),
						selectable.map(function (ref) {
							var key = reviewRefKey(ref);
							return h("label", { key: key, className: "saker-wb-sub", style: { display: "block" } },
								h("input", { type: "checkbox", checked: reviewRefs.indexOf(key) >= 0, onChange: function () { toggleReviewRef(ref); } }),
								" " + (ref.kind || "ref") + " " + (ref.id || "") + (ref.revision ? ":" + ref.revision : "") + " · " + (ref.quality || "unknown"));
						}))
						: h("p", { className: "saker-wb-sub" }, "当前没有可打开的原件；只能记录“依据不足”。"),
					h("div", { style: { display: "flex", gap: "8px" } },
						h("button", { type: "button", className: "saker-wb-btn", disabled: reviewBusy, onClick: saveEvidenceReview },
							reviewBusy ? "保存中…" : "保存复核"),
						h("button", { type: "button", className: "saker-wb-btn", disabled: reviewBusy,
							onClick: function () { setReviewOpen(false); } }, "取消"))) : null,
				reviewHistory.length ? h("div", { className: "saker-wb-linklist" }, reviewHistory.map(function (item, index) {
					return h("div", { key: String(item.reviewSeq || index), className: "saker-wb-history" },
						h("small", null, (item.decisionLabel || item.decision) + " · " + wbTime(item.createdAt)
							+ (item.superseded ? " · 已更正" : "") + (item.current === false && !item.superseded ? " · 依据已变化" : "")),
						h("p", null, item.note || "无说明"));
				})) : h("div", { className: "saker-wb-empty" }, "暂无已保存的复核记录。"),
				historyCursor ? h("div", { style: { margin: "8px 0" } },
					h("button", { type: "button", className: "saker-wb-btn", disabled: historyLoading, onClick: loadMoreHistory },
						historyLoading ? "读取更早记录…" : "加载更早的复核记录")) : null,
				historyTotal > reviewHistory.length
					? h("p", { className: "saker-wb-sub" }, "已显示 " + reviewHistory.length + " / " + historyTotal + " 条；可继续加载更早记录。") : null,
				h("h3", null, "复测记录"),
				retests.length ? h("div", { className: "saker-wb-linklist" }, retests.map(function (item, index) {
					return h("div", { key: String(item.id || index), className: "saker-wb-history" },
						h("small", null, item.at ? wbTime(item.at) : "时间未知"),
						h("p", null, item.note || item.result || "无说明"));
				})) : h("div", { className: "saker-wb-empty" }, "还没有复测记录。"),
				h("div", { className: "saker-wb-callout" }, "复测需要明确发起；打开详情或切换页签不会发送目标请求。"));
		}
		return h("div", null, chips,
			h("p", { className: "saker-wb-summary" }, data.summary || data.description || "没有可读摘要。"),
			h("dl", { className: "saker-wb-metadl" },
				h("dt", null, "任务"), h("dd", null, owner || "未记录"),
				h("dt", null, "目标"), h("dd", null, data.target || "未知"),
				h("dt", null, "验证状态"), h("dd", null, wbVerificationLabel(data.verificationState)),
				h("dt", null, "范围"), h("dd", null, "当前发现所属任务；未记录的版本和环境保持未知"),
				h("dt", null, "更新时间"), h("dd", null, wbTime(data.updatedAt))),
			data.description ? h("section", { className: "saker-wb-detailsec" }, h("h3", null, "结论与影响"),
				h("p", null, data.description), data.impact ? h("p", null, data.impact) : null) : null,
			data.poc ? h("section", { className: "saker-wb-detailsec" }, h("h3", null, "复现过程"), h("pre", null, data.poc)) : null,
			data.requestPacket || data.responsePacket ? h("section", { className: "saker-wb-detailsec" },
				h("h3", null, "已保存原文（历史快照，只读）"),
				h("p", { className: "saker-wb-sub" }, "这是发现记录中旧版保存的请求/响应正文，秘密字段已遮蔽；与可验证回执分开，不会重放请求。"),
				data.requestPacket ? h("details", null, h("summary", null, "请求原文"), h("pre", { className: "saker-wb-original" }, data.requestPacket)) : null,
				data.responsePacket ? h("details", null, h("summary", null, "响应原文"), h("pre", { className: "saker-wb-original" }, data.responsePacket)) : null) : null,
			state.error ? h(SakerInspectorError, { message: "本次刷新失败：" + state.error, stale: true, onRetry: props.onRetry }) : null);
	}
	return h(SakerDetailFrame, {
		label: "发现详情",
		eyebrow: (props.selected.id || "发现") + " · 发现",
		title: data.title || "发现详情",
		headingRef: props.headingRef,
		onClose: props.onClose,
		back: props.back,
		tabs: h(SakerDetailTabs, { active: tab, onChange: props.onTab, items: [
				{ id: "summary", label: "摘要" }, { id: "evidence", label: "依据" }, { id: "history", label: "验证记录" }] }),
		footer: h("div", { className: "saker-wb-row" },
			props.onConversation ? h("button", { type: "button", className: "saker-wb-btn", onClick: props.onConversation }, "返回原会话") : null,
			props.onOpenTask ? h("button", { type: "button", className: "saker-wb-btn", onClick: props.onOpenTask }, "打开任务") : null,
		props.onRetest ? h("button", { type: "button", className: "saker-wb-btn", disabled: props.retestBusy, onClick: props.onRetest }, "发起复测") : null,
			receipts[0] && props.onOpenEvidence ? h("button", { type: "button", className: "saker-wb-btn primary",
				onClick: function () { props.onOpenEvidence(receipts[0]); } }, "查看首个回执") : null),
	}, body());
}
function SakerExecutionInspector(props) {
	var state = props.state || {};
	var data = state.data || {};
	var hasData = !!state.data;
	var tab = props.tab || "summary";
	var title = props.selected.summary || (data.request ? String(data.request).split(/\r?\n/)[0] : "") ||
		(props.selected.kind === "http" ? "执行回执" : props.selected.kind === "model" ? "模型回合" :
			props.selected.kind === "attempt" ? "工作尝试" : "角色实例");
	function body() {
		if (!hasData && state.loading) return h(SakerInspectorLoading, { label: "读取执行详情…" });
		if (state.error && !hasData) return h(SakerInspectorError, { message: "读取执行详情失败：" + state.error, onRetry: props.onRetry });
		if (!hasData) return h("div", { className: "saker-wb-empty" }, "这条执行记录不可用或已被移除。");
		var summary = h("div", null,
			h("div", { className: "saker-wb-chiprow" },
				h("span", { className: "saker-wb-chip" }, wbExecutionKindLabel(data.kind || props.selected.kind)),
				h("span", { className: "saker-wb-chip " + (data.error ? "bad" : data.status == null ? "" : data.status >= 200 && data.status < 400 ? "ok" : "warn") },
					data.status != null ? "HTTP " + data.status : (data.status === undefined ? wbNodeStateLabel(data.state) : "—")),
				data.identity ? h("span", { className: "saker-wb-chip" }, "身份 " + data.identity) : null),
			h("dl", { className: "saker-wb-metadl" },
				h("dt", null, "记录 ID"), h("dd", null, data.id || props.selected.id),
				h("dt", null, "时间"), h("dd", null, data.at ? wbTime(data.at) : "未知"),
				h("dt", null, "来源"), h("dd", null, data.source || props.selected.source || "未记录"),
				h("dt", null, "结果"), h("dd", null, data.error ? "读取失败" : wbNodeStateLabel(data.outcome || data.state || "未记录")),
				h("dt", null, "请求大小"), h("dd", null, data.bytes != null ? data.bytes + " 字节（已截取 " + (data.capturedBytes || 0) + "）" : "未记录"),
				h("dt", null, "身份"), h("dd", null, data.identity || "记录未提供；不按默认账号猜测"),
				h("dt", null, "完整性"), h("dd", null, data.requestSha256 || data.responseSha256 ? "已有请求/响应摘要" : "未记录摘要")),
			data.error ? h("div", { className: "saker-wb-error" }, data.error) : null,
			data.record ? h("section", { className: "saker-wb-detailsec" }, h("h3", null, "结构化记录"), h("pre", null, data.record)) : null);
		if (tab === "request") {
			return h("div", null,
				h("p", null, "只读原文，秘密字段已由后端遮蔽。"),
				data.request ? h("pre", { className: "saker-wb-original" }, data.request) : h("div", { className: "saker-wb-empty" }, "这条记录没有可读请求原文。"));
		}
		if (tab === "response") {
			return h("div", null,
				h("p", null, "响应预览不会重放请求；二进制或空正文按记录显示。"),
				data.responseHead ? h("h3", null, "响应头") : null,
				data.responseHead ? h("pre", { className: "saker-wb-original" }, data.responseHead) : null,
				data.responseBody ? h("h3", null, "响应正文") : null,
				data.responseBody ? h("pre", { className: "saker-wb-original" }, data.responseBody) : null,
				!data.responseHead && !data.responseBody ? h("div", { className: "saker-wb-empty" }, "这条记录没有可读响应原文。") : null,
				data.responseBodyEncoding ? h("small", { className: "saker-wb-sub" }, "正文编码：" + data.responseBodyEncoding) : null);
		}
		if (tab === "source") {
			return h("div", null,
				h("p", null, "来源与引用只描述记录归属；不会把浏览记录当成已阅读原文。"),
				h("dl", { className: "saker-wb-metadl" },
					h("dt", null, "范围"), h("dd", null, props.selected.rootId || "未记录"),
					h("dt", null, "来源"), h("dd", null, data.source || "未记录"),
					h("dt", null, "请求摘要"), h("dd", null, data.requestSha256 || "未知"),
					h("dt", null, "响应摘要"), h("dd", null, data.responseSha256 || "未知"),
					h("dt", null, "引用"), h("dd", null, (data.refs || []).map(function (ref) { return ref.kind + ":" + ref.id; }).join("、") || "未知")),
				state.error ? h(SakerInspectorError, { message: "本次刷新失败：" + state.error, stale: true, onRetry: props.onRetry }) : null);
		}
		return summary;
	}
	return h(SakerDetailFrame, {
		label: "执行详情",
		eyebrow: (props.selected.id || "执行") + " · 只读记录",
		title: title,
		headingRef: props.headingRef,
		onClose: props.onClose,
		back: props.back,
		tabs: h(SakerDetailTabs, { active: tab, onChange: props.onTab, items: [
			{ id: "summary", label: "摘要" }, { id: "request", label: "请求" },
			{ id: "response", label: "响应" }, { id: "source", label: "来源" }] }),
		footer: h("div", { className: "saker-wb-row" },
			props.onConversation ? h("button", { type: "button", className: "saker-wb-btn", onClick: props.onConversation }, "返回原会话") : null,
			props.onOpenTask ? h("button", { type: "button", className: "saker-wb-btn", onClick: props.onOpenTask }, "打开任务") : null),
	}, body());
}
function SakerMaterialInspector(props) {
	var state = props.state || {};
	var data = state.data || {};
	var hasData = !!state.data;
	var tab = props.tab || "summary";
	var isRequest = String(data.kind || props.selected.materialKind || "") === "request";
	var title = isRequest ? (data.endpoint || props.selected.summary || props.selected.id)
		: (data.name || props.selected.summary || props.selected.id);
	function body() {
		if (!hasData && state.loading) return h(SakerInspectorLoading, { label: isRequest ? "读取请求原件…" : "读取本地文件…" });
		if (state.error && !hasData) return h(SakerInspectorError, { message: (isRequest ? "读取请求原件失败：" : "读取文件失败：") + state.error, onRetry: props.onRetry });
		if (!hasData) return h("div", { className: "saker-wb-empty" }, isRequest ? "这条请求原件不可用或已移除。" : "这条文件引用不可用或已移除。");
		if (isRequest) {
			if (tab === "original") {
				return h("div", null,
					data.historical ? h("div", { className: "saker-wb-callout" }, "这是历史版本原件；保存时的字节仍可读，须核对当前身份和基线后使用。") : null,
					h("h4", null, "请求原文"), h("pre", { className: "saker-wb-original" }, data.request || "没有可读请求原文。"),
					h("h4", null, "响应原文"), h("pre", { className: "saker-wb-original" }, data.response || "没有可读响应原文。"),
					h("div", { className: "saker-wb-callout" }, "原文已按保存时的字节读取并遮蔽密钥；打开不会发送请求。"));
			}
			if (tab === "source") {
				return h("div", null,
					h("dl", { className: "saker-wb-metadl" },
						h("dt", null, "任务"), h("dd", null, data.ownerSessionId || props.selected.rootId || "未记录"),
						h("dt", null, "请求 ID"), h("dd", null, String(data.id || props.selected.id)),
						h("dt", null, "版本"), h("dd", null, data.revision || "未记录"),
						h("dt", null, "历史版本"), h("dd", null, data.historical ? "是，按归档记录读取" : "否，当前任务上下文"),
						h("dt", null, "端点"), h("dd", null, data.endpoint || "未记录"),
						h("dt", null, "账号"), h("dd", null, data.authContext || "未记录"),
						h("dt", null, "请求已确认"), h("dd", null, data.valid === true ? "是" : "未记录"),
						h("dt", null, "内容指纹"), h("dd", null, data.requestDigest || "未记录"),
						h("dt", null, "关联检查"), h("dd", null, String((data.relatedChecks || []).length) + " 项")),
					h("div", { className: "saker-wb-callout" }, "请求原件只读；关联检查只表示保存时的上下文，不证明影响成立。"));
			}
			return h("div", null,
				h("div", { className: "saker-wb-chiprow" },
					h("span", { className: "saker-wb-chip" }, "请求"),
					h("span", { className: "saker-wb-chip " + (data.historical ? "warn" : "ok") }, data.historical ? "历史版本" : "当前版本"),
					h("span", { className: "saker-wb-chip " + (data.valid === true ? "ok" : "") }, data.valid === true ? "已确认原件" : "未记录确认")),
				h("dl", { className: "saker-wb-metadl" },
					h("dt", null, "端点"), h("dd", null, data.endpoint || "未记录"),
					h("dt", null, "账号"), h("dd", null, data.authContext || "未记录"),
					h("dt", null, "版本"), h("dd", null, data.revision || "未记录"),
					h("dt", null, "关联检查"), h("dd", null, String((data.relatedChecks || []).length) + " 项"),
					h("dt", null, "内容指纹"), h("dd", null, data.requestDigest || "未记录")),
				state.error ? h(SakerInspectorError, { message: "本次刷新失败：" + state.error, stale: true, onRetry: props.onRetry }) : null);
		}
		if (tab === "original") {
			return h("div", null,
				data.missing ? h("div", { className: "saker-wb-error" }, "索引仍在，但本地文件缺失或不可读；不会伪造原文。") : null,
				data.preview ? h("pre", { className: "saker-wb-original" }, data.preview) : h("div", { className: "saker-wb-empty" }, "没有可读正文。"),
				data.truncated && data.nextOffset !== null && data.nextOffset !== undefined
					? h("div", { className: "saker-wb-bandfoot" },
						h("span", { className: "saker-wb-sub" }, "已展示到第 " + data.offset + " 字节"),
						h("button", { type: "button", className: "saker-wb-btn", onClick: function () { props.onLoadMore(data.nextOffset); } }, "读取下一段"))
					: null);
		}
		if (tab === "source") {
			return h("div", null,
				h("dl", { className: "saker-wb-metadl" },
					h("dt", null, "任务"), h("dd", null, props.selected.rootId || "未记录"),
					h("dt", null, "文件 ID"), h("dd", null, data.id || props.selected.id),
					h("dt", null, "来源"), h("dd", null, data.source || "未记录"),
					h("dt", null, "站点"), h("dd", null, data.site || "未记录"),
					h("dt", null, "摘要"), h("dd", null, data.digest || "未记录"),
					h("dt", null, "大小"), h("dd", null, data.totalBytes != null ? data.totalBytes + " 字节" : "未知")),
				h("div", { className: "saker-wb-callout" }, "打开文件只会读取原文，不写入模型上下文，也不会重新导入。"));
		}
		return h("div", null,
			h("div", { className: "saker-wb-chiprow" },
				h("span", { className: "saker-wb-chip" }, wbGraphKindLabel(data.kind || "file")),
				h("span", { className: "saker-wb-chip " + (data.missing ? "bad" : "ok") }, data.missing ? "文件缺失" : "已索引")),
			h("dl", { className: "saker-wb-metadl" },
				h("dt", null, "名称"), h("dd", null, data.name || title),
				h("dt", null, "来源"), h("dd", null, data.source || "未记录"),
				h("dt", null, "大小"), h("dd", null, data.totalBytes != null ? data.totalBytes + " 字节" : "未知"),
				h("dt", null, "导入格式"), h("dd", null, data.importSummary?.format || "未记录")),
			data.importSummary ? h("section", { className: "saker-wb-detailsec" }, h("h3", null, "导入摘要"),
				h("p", null, "条目 " + (data.importSummary.entries ?? "未知") + " · 坏记录 " + (data.importSummary.broken ?? 0))) : null,
			state.error ? h(SakerInspectorError, { message: "本次刷新失败：" + state.error, stale: true, onRetry: props.onRetry }) : null);
	}
	return h(SakerDetailFrame, {
		label: isRequest ? "请求详情" : "文件详情",
		eyebrow: (data.id || props.selected.id) + (isRequest ? " · 本地请求" : " · 本地文件"),
		title: title,
		headingRef: props.headingRef,
		onClose: props.onClose,
		back: props.back,
		tabs: h(SakerDetailTabs, { active: tab, onChange: props.onTab, items: [
			{ id: "summary", label: "摘要" }, { id: "original", label: "原文" }, { id: "source", label: "来源" }] }),
		footer: props.onOpenTask ? h("button", { type: "button", className: "saker-wb-btn", onClick: props.onOpenTask }, "打开任务") : null,
	}, body());
}
function SakerAssetInspector(props) {
	var row = props.row || {};
	var tab = props.tab || "summary";
	var title = row.url || row.endpoint || row.name || row.id || "资产与文件";
	var requests = row.relatedRequests || [];
	var checks = row.relatedChecks || [];
	var receipts = row.relatedReceipts || [];
	function body() {
		if (tab === "source") {
			return h("div", null,
				h("p", null, "来源来自当前任务的资产、请求或文件记录；没有返回的字段保持未知。"),
				h("dl", { className: "saker-wb-metadl" },
					h("dt", null, "任务"), h("dd", null, props.selected.rootId || "未记录"),
					h("dt", null, "类型"), h("dd", null, row.kind || "文件"),
					h("dt", null, "标识"), h("dd", null, row.id || "未知"),
					h("dt", null, "范围"), h("dd", null, row.inScope === true ? "范围内" : row.inScope === false ? "范围外" : "未记录"),
					h("dt", null, "账号"), h("dd", null, row.authContext || "未记录"),
					h("dt", null, "格式"), h("dd", null, row.format || "未记录")));
		}
		return h("div", null,
			h("div", { className: "saker-wb-chiprow" },
				h("span", { className: "saker-wb-chip" }, row.kind || "文件"),
				h("span", { className: "saker-wb-chip " + (row.inScope === false ? "warn" : "ok") },
					row.inScope === true ? "范围内" : row.inScope === false ? "范围外" : "未记录范围")),
			h("dl", { className: "saker-wb-metadl" },
				h("dt", null, "对象"), h("dd", null, title),
				h("dt", null, "标识"), h("dd", null, row.id || "未知"),
				h("dt", null, "状态"), h("dd", null, row.reachable === true ? "已观察可达" : row.valid === true ? "请求已确认" : "未记录"),
				h("dt", null, "账号"), h("dd", null, row.authContext || "未记录"),
				h("dt", null, "大小"), h("dd", null, row.bytes != null ? row.bytes + " 字节" : "未记录")),
			requests.length ? h("section", { className: "saker-wb-detailsec" }, h("h3", null, "关联 HTTP 请求"),
				requests.map(function (request) {
					return h("div", { key: request.id, className: "saker-wb-linkrow" },
						h("span", { className: "saker-wb-cell-main" }, request.endpoint || request.id),
						props.onFindRequest ? h("button", { type: "button", className: "saker-wb-btn",
							onClick: function () { props.onFindRequest(request); } }, "在执行记录中查找") : null);
				})) : null,
			checks.length ? h("section", { className: "saker-wb-detailsec" }, h("h3", null, "检查项"),
				checks.map(function (check) {
					return h("div", { key: check.id, className: "saker-wb-linkrow" },
						h("span", { className: "saker-wb-chip " + (check.status === "not-hit" ? "ok" : check.status === "blocked" ? "bad" : "warn") }, wbNodeStateLabel(check.status)),
						h("span", { className: "saker-wb-cell-main" }, check.title || check.id),
						h("span", { className: "saker-wb-sub" }, check.endpoint || ""));
				})) : null,
			receipts.length ? h("section", { className: "saker-wb-detailsec" }, h("h3", null, "HTTP 回执"),
				h("div", { className: "saker-wb-linklist" }, receipts.map(function (receipt) {
					return h("div", { key: receipt.id, className: "saker-wb-linkrow" },
						h("span", { className: "saker-wb-chip " + (receipt.status >= 200 && receipt.status < 400 ? "ok" : "warn") },
							receipt.status != null ? "HTTP " + receipt.status : "回执"),
						h("span", { className: "saker-wb-cell-main" }, receipt.id),
						props.onOpenReceipt ? h("button", { type: "button", className: "saker-wb-btn",
							onClick: function () { props.onOpenReceipt(receipt, row); } }, "查看回执") : null);
				}))) : null,
			!requests.length && !checks.length && !receipts.length ? h("div", { className: "saker-wb-empty" }, "这条记录没有可直接打开的关联请求；不会生成伪造入口。") : null);
	}
	return h(SakerDetailFrame, {
		label: "资产与文件详情",
		eyebrow: wbGraphKindLabel(row.kind) + " · 只读记录",
		title: title,
		headingRef: props.headingRef,
		onClose: props.onClose,
		back: props.back,
		tabs: h(SakerDetailTabs, { active: tab, onChange: props.onTab, items: [
			{ id: "summary", label: "摘要" }, { id: "source", label: "来源" }] }),
		footer: props.onOpenTask ? h("div", { className: "saker-wb-row" },
			h("button", { type: "button", className: "saker-wb-btn", onClick: props.onOpenTask }, "查看任务资产")) : null,
	}, body());
}
function SakerGraphInspector(props) {
	var node = props.selected.node || {};
	return h(SakerDetailFrame, {
		label: "测试路径节点详情",
		eyebrow: (props.selected.id || "节点") + " · 测试路径",
		title: node.title || node.id || "测试路径节点",
		headingRef: props.headingRef,
		onClose: props.onClose,
		back: props.back,
		tabs: h("div", { className: "saker-wb-chiprow" }, h("span", { className: "saker-wb-chip" }, wbGraphKindLabel(node.kind))),
		footer: props.onOpenNode ? h("button", { type: "button", className: "saker-wb-btn primary",
			onClick: function () { props.onOpenNode(node); } }, "查看对应记录") : null,
	}, h("div", null,
		h("dl", { className: "saker-wb-metadl" },
			h("dt", null, "标识"), h("dd", null, node.id || props.selected.id),
			h("dt", null, "类型"), h("dd", null, wbGraphKindLabel(node.kind)),
			h("dt", null, "状态"), h("dd", null, wbNodeStateLabel(node.state)),
			h("dt", null, "来源"), h("dd", null, (node.sourceRefs || []).map(function (ref) { return ref.kind + ":" + ref.id; }).join("、") || "未记录")),
		node.sourceRefs ? h("section", { className: "saker-wb-detailsec" }, h("h3", null, "来源引用"),
			h("pre", null, JSON.stringify(node.sourceRefs, null, 2))) : null,
		h("div", { className: "saker-wb-callout" }, "只有真实引用会画成边；孤立项保持单列。")));
}
function SakerHandoffPanel(props) {
	var state = props.state || {};
	var data = state.data || {};
	var root = props.task?.root || {};
	var overview = props.task?.overview || {};
	var gaps = overview.gaps || [];
	return h("section", { className: "saker-wb-page saker-wb-handoff" },
		h("div", { className: "saker-wb-intro" },
			h("div", null, h("div", { className: "saker-wb-eyebrow" }, "测试任务 / 导出报告"),
				h("h1", { className: "saker-wb-page-title", tabIndex: -1, ref: props.headingRef }, "导出报告"),
				h("p", { className: "saker-wb-page-sub" }, "预览报告包内容；预览和取消都不会重新执行任何测试动作。")),
			h("div", { className: "saker-wb-row" },
				props.onOpenFindings ? h("button", { type: "button", className: "saker-wb-btn", onClick: props.onOpenFindings }, "查看任务发现") : null,
				props.onOpenAssets ? h("button", { type: "button", className: "saker-wb-btn", onClick: props.onOpenAssets }, "查看资产与文件") : null,
				h("button", { type: "button", className: "saker-wb-btn", onClick: props.onClose }, "关闭"),
				h("button", { type: "button", className: "saker-wb-btn primary", disabled: !data.snapshot || props.state.loading || props.downloading,
				onClick: props.onDownload }, props.downloading ? "生成中…" : "下载报告包"))),
			state.loading ? h(SakerInspectorLoading, { label: "正在生成报告预览…" }) : null,
		state.error ? h(SakerInspectorError, { message: "报告预览读取失败：" + state.error, onRetry: props.onRetry }) : null,
		data.preview || data.files ? h("div", { className: "saker-wb-taskgrid" },
			h("section", { className: "saker-wb-band" },
				h("div", { className: "saker-wb-bandhead" }, h("h2", null, "范围与身份"), h("span", { className: "saker-wb-chip" }, wbBusinessLabel(root.businessState))),
				h("dl", { className: "saker-wb-metadl" },
					h("dt", null, "任务"), h("dd", null, wbRootTitle(root)),
					h("dt", null, "范围"), h("dd", null, data.scope || root.targetSummary || root.title || "未记录"),
					h("dt", null, "身份"), h("dd", null, (data.identities || []).length ? (data.identities || []).join("、") +
						(data.identityUnknown ? " · 另有 " + data.identityUnknown + " 条未记录身份" : "") : "未记录身份"),
					h("dt", null, "结论"), h("dd", null, "有效 " + (data.confirmedFindings || 0) + " 条"),
					h("dt", null, "引用质量"), h("dd", null, Object.keys(data.qualityCounts || {}).length
						? Object.keys(data.qualityCounts).map(function (key) { return wbEvidenceQualityLabel(key) + " " + data.qualityCounts[key]; }).join(" · ")
						: "没有可解析引用"),
					h("dt", null, "人工复核"), h("dd", null, data.userEvidenceReviews && data.userEvidenceReviews.total
						? "当前判断 " + (data.userEvidenceReviews.current || 0) + " 条 · 待刷新 " + (data.userEvidenceReviews.stale || 0)
							+ " 条 · 共 " + (data.userEvidenceReviews.records || 0) + " 次记录"
						: "未记录人工依据复核"),
					h("dt", null, "证据缺口"), h("dd", null, (data.gaps || gaps).length ? (data.gaps || gaps).map(function (gap) { return gap.endpoint + "：" + (gap.missing || []).join("、"); }).join("；") : "当前查询未返回具体缺口"),
					h("dt", null, "未覆盖"), h("dd", null, "未记录的版本、环境和检查范围保持未知")),
				h("div", { className: "saker-wb-callout" }, "下载是独立动作；关闭预览不会改变任务或会话。")),
			h("section", { className: "saker-wb-band" },
				h("div", { className: "saker-wb-bandhead" }, h("h2", null, "报告包内容"), h("small", null, (data.files || []).length + " 个文件")),
				data.incompleteRecords ? h("div", { className: "saker-wb-notice warn" }, "另有 " + data.incompleteRecords + " 条记录证据或复核未齐，未计入有效成果。") : null,
				h("div", { className: "saker-wb-filelist" }, (data.files || []).map(function (file) {
					return h("div", { key: file, className: "saker-wb-file" }, file);
				})),
				h("div", { className: "saker-wb-bandfoot" }, h("small", null,
					"检查 " + (data.checkedCount || 0) + " 项 · 普通结果 " + (data.ordinaryReports || 0) + " 份")),
				h("details", { className: "saker-wb-advanced" }, h("summary", null, "查看报告说明"),
					data.previewTruncated ? h("div", { className: "saker-wb-sub" }, "预览只展示前 120,000 字符；下载包仍是完整内容。") : null,
					h("pre", { className: "saker-wb-original" }, data.preview || "报告包中没有 findings.md 文本预览。")))) : null,
		!state.loading && !state.error ? h("div", { className: "saker-wb-mocknote" }, "预览完成；下载会保存同一份 ZIP，不会重新生成，也不会执行测试。") : null);
}
function SakerRootsTable(props) {
	var rows = props.rows || [];
	if (!rows.length) return h("div", { className: "saker-wb-empty" }, props.emptyText || "还没有任务。回到原生会话输入目标即可开始；工作台不会自动启动模型。");
	return h("table", { className: "saker-wb-table" },
		h("thead", null, h("tr", null, ["任务", "控制状态", "结果", "清理", "最后活动"].map(function (label, index) {
			return h("th", { key: label, className: index >= 3 ? "saker-col-secondary" : "" }, label);
		}))),
		h("tbody", null, rows.map(function (row) {
			return h("tr", { key: row.rootId, tabIndex: 0, onClick: function () { props.onOpen && props.onOpen(row.rootId); },
				onKeyDown: function (event) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); props.onOpen && props.onOpen(row.rootId); } } },
				h("td", null, h("div", { className: "saker-wb-cell-main" },
					/按当前会话|^$/.test(String(row.title || "")) && row.targetSummary ? row.targetSummary : row.title),
					h("div", { className: "saker-wb-cell-sub" }, [row.taskKind || "", row.targetSummary && row.targetSummary !== row.title ? row.targetSummary : "",
						row.rootId ? "会话 " + row.rootId.slice(-8) : ""].filter(Boolean).join(" · "))),
				h("td", null, h("span", { className: "saker-wb-chip " + wbStateTone(row.controlState) }, wbStateLabel(row.controlState))),
				h("td", null, "验证 " + (row.outcomeSummary?.verified || 0) + " · 待确认 " + (row.outcomeSummary?.pending || 0)),
				h("td", { className: "saker-col-secondary" }, row.cleanupState === "clear" ? "已核对" : row.cleanupState === "pending" ? "清理中" : "待确认"),
				h("td", { className: "saker-col-secondary" }, wbTime(row.updatedAt)));
		})));
}
function SakerFindingDetail(props) {
	if (!props.selected) return null;
	var state = props.state || {};
	var data = state.data || {};
	var refs = data.verificationBasis || data.evidenceRefs || [];
	var retests = data.retests || [];
	var receipts = data.receipts || [];
	return h("div", { className: "saker-wb-card", style: { marginTop: "12px" } },
		h("div", { className: "saker-wb-row", style: { alignItems: "flex-start" } },
			h("div", { style: { flex: 1, minWidth: 0 } }, h("h3", { style: { margin: 0 } }, "发现详情"),
				h("div", { className: "saker-wb-sub" }, (data.findingId || props.selected) + " · " + (data.target || "无目标"))),
			h("button", { className: "saker-wb-btn", onClick: props.onClose }, "关闭")),
		state.loading ? "读取中…" : h("div", null,
			state.error ? h("div", { className: "saker-wb-error", role: "alert" },
				"读取发现详情失败（" + (props.selected || "当前发现") + "）：" + state.error,
				state.data ? h("div", { className: "saker-wb-sub", style: { marginTop: "4px" } }, "下方仍是同一发现的上一份成功数据；失败没有替换它。") : null,
				h("button", { className: "saker-wb-btn", style: { marginTop: "8px" }, onClick: props.onRetry }, "重试")) : null,
			state.data ? h("div", null,
				h("div", { className: "saker-wb-row", style: { flexWrap: "wrap", margin: "8px 0" } },
					h("span", { className: "saker-wb-chip " + (data.verificationState === "verified" ? "ok" : "warn") }, wbVerificationLabel(data.verificationState)),
					h("span", { className: "saker-wb-chip " + (data.severity === "critical" || data.severity === "high" ? "bad" : "") }, data.severity || "未评级"),
					h("span", { className: "saker-wb-sub" }, "依据 " + refs.length + " 条 · 复测 " + retests.length + " 次")),
				h("p", { style: { margin: "4px 0" } }, data.summary || ""),
				h("div", { className: "saker-wb-row", style: { flexWrap: "wrap", margin: "8px 0" } },
					props.onOpenConversation ? h("button", { className: "saker-wb-btn", onClick: props.onOpenConversation }, "返回原会话") : null,
			h("button", { className: "saker-wb-btn", onClick: props.onRetest }, "发起复测"),
					props.onOpenEvidence && receipts[0] ? h("button", { className: "saker-wb-btn", onClick: function () { props.onOpenEvidence({ id: receipts[0].id, kind: "request" }); } }, "打开首条原件") : null),
				data.description ? h("div", null, h("h4", null, "结论与影响"), h("p", null, data.description), data.impact ? h("p", null, data.impact) : null) : null,
				data.poc ? h("div", null, h("h4", null, "复现过程"), h("pre", null, data.poc)) : null,
				data.evidence ? h("div", null, h("h4", null, "证据说明"), h("p", null, data.evidence)) : null,
				data.requestPacket || data.responsePacket ? h("div", null, h("h4", null, "请求 / 响应原文（秘密已遮蔽）"),
					data.requestPacket ? h("pre", null, data.requestPacket) : null,
					data.responsePacket ? h("pre", null, data.responsePacket) : null) : null,
				h("h4", null, "依据引用"), refs.length ? h("div", { style: { display: "grid", gap: "8px" } }, refs.map(function (ref, index) {
					var match = receipts.find(function (receipt) { return String(receipt.requestId) === String(ref.id); });
					return h("div", { key: String(ref.id || index), className: "saker-wb-row" },
						h("span", { className: "saker-wb-chip" }, ref.kind || "ref"),
						h("span", { style: { flex: 1, minWidth: 0, overflowWrap: "anywhere" } }, ref.id || "—"),
						props.onOpenEvidence && match ? h("button", { className: "saker-wb-btn", onClick: function () { props.onOpenEvidence({ id: match.id, kind: "request" }); } }, "打开回执") : null);
				})) : h("p", { className: "saker-wb-sub" }, "没有可读依据引用。"),
				receipts.length ? h("div", null, h("h4", null, "执行回执"), h("div", { style: { display: "grid", gap: "8px" } }, receipts.map(function (receipt) {
					return h("div", { key: receipt.id, className: "saker-wb-row" },
						h("span", { className: "saker-wb-chip " + (receipt.current && receipt.integrityValid ? "ok" : "warn") }, receipt.status != null ? "HTTP " + receipt.status : "回执"),
						h("span", { style: { flex: 1, minWidth: 0, overflowWrap: "anywhere" } }, receipt.id + (receipt.current === false ? " · 已失效" : "")),
						props.onOpenEvidence ? h("button", { className: "saker-wb-btn", onClick: function () { props.onOpenEvidence({ id: receipt.id, kind: "request" }); } }, "查看") : null);
				}))) : null,
				h("h4", null, "复测历史"), retests.length ? h("div", { style: { display: "grid", gap: "8px" } }, retests.map(function (item, index) {
					return h("div", { key: String(item.id || index), className: "saker-wb-card", style: { margin: 0 } },
						h("div", { className: "saker-wb-sub" }, item.at ? wbTime(item.at) : "时间未知"),
						h("p", { style: { margin: "4px 0" } }, item.note || item.result || "无说明"));
				})) : h("p", { className: "saker-wb-sub" }, "还没有复测记录。")) : null));
}
function SakerListToolbar(props) {
	var dirty = !!(props.text || props.dirty);
	var composing = useRef(false);
	var draftState = useState(null), draft = draftState[0], setDraft = draftState[1];
	var shown = composing.current ? (draft == null ? (props.text || "") : draft) : (props.text || "");
	return h("div", { className: "saker-wb-toolbar" },
		h("input", { className: "saker-wb-search", type: "search", value: shown, placeholder: props.placeholder || "搜索",
			"aria-label": props.placeholder || "搜索",
			onChange: function (event) {
				var value = event.target.value;
				if (composing.current || (event.nativeEvent && event.nativeEvent.isComposing)) { setDraft(value); return; }
				setDraft(null);
				props.onText(value);
			},
			onCompositionStart: function () { composing.current = true; setDraft(props.text || ""); },
			onCompositionEnd: function (event) { composing.current = false; setDraft(null); props.onText(event.target.value); } }),
		props.filters || null,
		dirty ? h("button", { className: "saker-wb-btn", onClick: props.onClear || function () { props.onText(""); } }, "清除") : null,
		h("span", { className: "saker-wb-spacer" }),
		h("span", { className: "saker-wb-sub", "aria-live": "polite" }, props.loadedLabel || ""));
}
function SakerPager(props) {
	var page = props.page;
	if (!page) return null;
	var total = Number(page.total) || 0;
	var loaded = Number(props.loaded) || 0;
	return h("div", { className: "saker-wb-pager" },
		h("button", { className: "saker-wb-btn", disabled: !props.hasPrev, onClick: props.onPrev }, "上一页"),
		h("span", null, "当前 " + loaded + " 条 · 共 " + total + " 条" + (page.hasMore ? " · 还有下一页" : "")),
		h("button", { className: "saker-wb-btn", disabled: !page.nextCursor, onClick: props.onNext }, "下一页"));
}
function SakerQueryError(props) {
	if (!props.state || !props.state.error) return null;
	var scope = props.scope || "全部任务";
	return h("div", { className: "saker-wb-error", role: "alert" },
		h("div", null, "读取“" + (props.label || "数据") + "”失败（范围：" + scope + "）：" + props.state.error),
		props.state.data ? h("div", { className: "saker-wb-sub", style: { marginTop: "4px" } },
			"下方内容是该范围上一次成功读取的数据，不是本次结果；失败没有替换它。") : null,
		props.onRetry ? h("div", { style: { marginTop: "8px" } }, h("button", { className: "saker-wb-btn", onClick: props.onRetry }, "重试")) : null);
}
function SakerExecutionDetail(props) {
	if (!props.selected) return null;
	var state = props.state || {};
	var data = state.data || {};
	return h("div", { className: "saker-wb-card saker-wb-detail-card" },
		h("div", { className: "saker-wb-row" }, h("h3", { style: { flex: 1, marginTop: 0 } }, props.title || "执行详情"),
			h("span", { className: "saker-wb-chip" }, props.selected.kind || data.kind || "http"),
			h("button", { className: "saker-wb-btn", onClick: props.onClose }, "关闭")),
		state.loading ? h("div", { className: "saker-wb-sub" }, "读取中…") :
			state.error ? h("div", { className: "saker-wb-error", role: "alert" }, "读取执行详情失败：" + state.error,
				h("button", { className: "saker-wb-btn", style: { marginLeft: "8px" }, onClick: props.onRetry }, "重试")) :
				state.data ? h("div", null,
					h("div", { className: "saker-wb-sub" }, "id：" + (data.id || props.selected.id) + " · 状态：" +
						(data.status ?? data.outcome ?? data.state ?? "—") + (data.identity ? " · 身份：" + data.identity : "")),
					data.request ? h("h4", null, "请求原文") : null,
					data.request ? h("pre", null, data.request) : null,
					data.responseHead ? h("h4", null, "响应头") : null,
					data.responseHead ? h("pre", null, data.responseHead) : null,
					data.responseBody ? h("h4", null, "响应正文") : null,
					data.responseBody ? h("pre", null, data.responseBody) : null,
					data.error ? h("div", { className: "saker-wb-error" }, data.error) : null,
					data.record ? h("pre", null, data.record) : null,
					h("div", { className: "saker-wb-row", style: { marginTop: "8px" } },
						props.onConversation ? h("button", { className: "saker-wb-btn", onClick: props.onConversation }, "返回原会话") : null,
		props.onBack ? h("button", { className: "saker-wb-btn", onClick: props.onBack }, "返回测试任务") : null)) : null);
}
function SakerAssetDetail(props) {
	if (!props.row) return null;
	var row = props.row;
	var requests = row.relatedRequests || [];
	var checks = row.relatedChecks || [];
	return h("div", { className: "saker-wb-card saker-wb-detail-card" },
		h("div", { className: "saker-wb-row" }, h("h3", { style: { flex: 1, marginTop: 0 } }, row.url || row.endpoint || row.name || row.id),
			h("span", { className: "saker-wb-chip" }, row.kind || "material")),
		h("div", { className: "saker-wb-sub" }, "id：" + (row.id || "—") + " · " + (row.inScope === true ? "范围内" : row.inScope === false ? "范围外" : "") +
			(row.reachable === true ? " · 可达" : "") + (row.authContext ? " · 账号 " + row.authContext : "")),
		requests.length ? h("div", null, h("h4", null, "关联 HTTP 请求"),
			requests.map(function (request) {
				return h("div", { key: request.id, className: "saker-wb-row" },
					h("span", { className: "saker-wb-cell-main" }, request.endpoint || request.id),
					props.onOpenRequest ? h("button", { className: "saker-wb-btn", onClick: function () { props.onOpenRequest(request, row); } }, "查看回执") : null);
			})) : null,
		checks.length ? h("div", null, h("h4", null, "检查项"),
			checks.map(function (check) {
				return h("div", { key: check.id, className: "saker-wb-row" },
					h("span", { className: "saker-wb-chip " + (check.status === "not-hit" ? "ok" : check.status === "blocked" ? "bad" : "warn") }, check.status || "未测"),
					h("span", { className: "saker-wb-cell-main" }, check.title || check.id),
					h("span", { className: "saker-wb-sub" }, check.endpoint || ""));
			})) : null,
		!requests.length && !checks.length ? h("p", { className: "saker-wb-sub" }, "这条记录没有可直接打开的请求回执；检查项和请求会随真实执行出现。") : null,
		h("div", { className: "saker-wb-row", style: { marginTop: "8px" } },
			props.onOpenTask ? h("button", { className: "saker-wb-btn", onClick: props.onOpenTask }, "查看任务资产") : null,
			h("button", { className: "saker-wb-btn", onClick: props.onClose }, "关闭")));
}
function SakerKnowledgePage(props) {
	var sessionId = props.rootId || "";
	var textState = useState(""), text = textState[0], setText = textState[1];
	var offsetState = useState(0), offset = offsetState[0], setOffset = offsetState[1];
	var rowsState = useState([]), rows = rowsState[0], setRows = rowsState[1];
	var loadingState = useState(false), loading = loadingState[0], setLoading = loadingState[1];
	var errorState = useState(""), error = errorState[0], setError = errorState[1];
	var nextState = useState(null), nextOffset = nextState[0], setNextOffset = nextState[1];
	var selectedState = useState(null), selected = selectedState[0], setSelected = selectedState[1];
	var detailState = useState(null), detail = detailState[0], setDetail = detailState[1];
	var requestSeq = useRef(0);
	var debouncedState = useState(""), debounced = debouncedState[0], setDebounced = debouncedState[1];
	useEffect(function () {
		var timer = setTimeout(function () { setDebounced(text.trim()); setOffset(0); }, 220);
		return function () { clearTimeout(timer); };
	}, [text]);
	useEffect(function () {
		if (!sessionId) { setRows([]); setNextOffset(null); setLoading(false); setError(""); return; }
		var current = ++requestSeq.current;
		setLoading(true); setError("");
		api("knowledge.list", { sessionId: sessionId, query: debounced, limit: 30, offset: offset })
			.then(function (value) {
				if (current !== requestSeq.current) return;
				if (!value || value.ok === false) throw Error((value && value.error) || "读取知识库失败");
				setRows(value.rows || []); setNextOffset(value.nextOffset ?? null);
			})
			.catch(function (failure) { if (current === requestSeq.current) setError(wbErrorText(failure)); })
			.finally(function () { if (current === requestSeq.current) setLoading(false); });
	}, [sessionId, debounced, offset, props.tick]);
	useEffect(function () { setSelected(null); setDetail(null); setOffset(0); }, [sessionId]);
	function openEntry(row) {
		setSelected(row); setDetail(null);
		api("knowledge.read", { sessionId: sessionId, sourceId: row.sourceId, maxBytes: 8192 })
			.then(function (value) {
				if (!value || value.ok === false) throw Error((value && value.error) || "读取资料失败");
				setDetail(value);
			})
			.catch(function (failure) { setDetail({ error: wbErrorText(failure) }); });
	}
	if (!sessionId) return h("div", { className: "saker-wb-empty" }, "先选择一个测试任务，再查看该项目导入的文档；正文只会在你打开时读取。");
	var content = detail && detail.error ? h("div", { className: "saker-wb-error" }, detail.error) :
		detail ? h("div", null, h("div", { className: "saker-wb-sub" }, (selected.title || selected.sourceLabel) + " · " + (selected.location || "")),
			selected.review ? h("div", { className: "saker-wb-callout" },
				"来源：" + (selected.review.sourceStateLabel || "来源待核")
				+ (selected.review.verification ? " · " + selected.review.verification : "")
				+ (selected.review.conditions ? " · 适用条件：" + selected.review.conditions : "")
				+ (selected.review.sources ? " · 引用：" + selected.review.sources : "")) : null,
			h("pre", null, detail.text || detail.section || detail.content || JSON.stringify(detail, null, 2).slice(0, 8000))) :
			h("div", { className: "saker-wb-sub" }, "选一条资料，读取它的真实章节；列表不会预加载全文。");
  return h("div", { className: "saker-wb-split saker-knowledge" },
		h("div", { className: "saker-wb-main" },
			h(SakerListToolbar, { text: text, onText: setText, placeholder: "搜索标题、位置或来源",
				loadedLabel: loading ? "读取中…" : "显示 " + rows.length + " 条" + (nextOffset !== null ? " · 还有更多" : "") }),
			error ? h("div", { className: "saker-wb-error", role: "alert" }, "读取知识库失败：" + error) : null,
			loading && !rows.length ? h("div", { className: "saker-wb-empty" }, "读取中…") : null,
			!loading && !rows.length ? h("div", { className: "saker-wb-empty" }, text ? "没有匹配的文档。清空搜索或更换关键词。" : "这个项目还没有导入文档；可在会话中导入后回到这里查看。") : null,
			h("div", { className: "saker-wb-cards" }, rows.map(function (row) {
				return h("button", { key: row.docId, type: "button", className: "saker-wb-card saker-wb-cardbtn" + (selected && selected.docId === row.docId ? " active" : ""),
					onClick: function () { openEntry(row); } },
					h("div", { className: "saker-wb-row" }, h("b", { style: { flex: 1 } }, row.title || row.sourceLabel || row.sourceId),
						row.review && row.review.sourceState && row.review.sourceState !== "source-indexed"
							? h("span", { className: "saker-wb-chip " + (row.review.sourceState === "source-unverified" ? "warn" : "") }, row.review.sourceStateLabel)
							: null,
						h("span", { className: "saker-wb-chip" }, row.applicability || "unknown")),
					h("div", { className: "saker-wb-sub" }, (row.location || "—") + " · " + (row.sourceKind || row.status || "") +
						(row.updatedAt ? " · " + wbTime(row.updatedAt) : "")));
			})),
			h(SakerPager, { page: nextOffset !== null ? { total: offset + rows.length + 1, hasMore: true, nextCursor: "next" } : { total: offset + rows.length, hasMore: false },
				loaded: rows.length, hasPrev: offset > 0, onPrev: function () { setOffset(Math.max(0, offset - 30)); }, onNext: function () { if (nextOffset !== null) setOffset(nextOffset); } })),
		h("aside", { className: "saker-wb-detail" },
			h("div", { className: "saker-wb-row" }, h("h3", { style: { flex: 1, margin: 0 } }, selected ? (selected.title || "文档正文") : "文档正文"),
				selected ? h("button", { className: "saker-wb-btn", onClick: function () { setSelected(null); setDetail(null); } }, "关闭") : null),
			content));
}
function SakerFindingsTable(props) {
	var rows = props.rows || [];
	if (!rows.length) return h("div", { className: "saker-wb-empty" }, "当前范围没有发现。未测缺口不是发现。");
	var showRoot = props.showRoot !== false;
	// 日常 1280 同时打开宿主栏和 Saker 文字栏时，主区只有约 780px。
	// 任务列原来放整段会话 UUID，会挤到目标列只剩半行；这里把可读任务名并入次行，
	// 完整 ID 和长目标仍可在详情里看，主表优先保证标题、状态、严重度和目标。
	var compact = props.compact === true;
	var columns = compact ? ["发现", "验证状态", "严重度"] : ["发现", "验证状态", "严重度", "目标", "更新时间"];
	var widths = compact ? ["58%", "20%", "22%"] : ["37%", "14%", "10%", "29%", "10%"];
	return h("table", { className: "saker-wb-table" },
		h("colgroup", null, widths.map(function (width, index) {
			return h("col", { key: index, style: { width: width }, className: !compact && index >= 3 ? "saker-col-secondary" : "" });
		})),
		h("thead", null, h("tr", null, columns.map(function (label, index) {
			return h("th", { key: label, className: !compact && index === columns.length - 1 ? "saker-col-secondary" : "" }, label);
		}))),
		h("tbody", null, rows.map(function (row) {
			var findingId = row.findingId || row.id;
			var ownerId = row.sessionId || row.rootId || props.rootId || "";
			var ownerLabel = props.rootLabel ? props.rootLabel(ownerId) : "";
			var subline = compact
				? [row.target ? "目标 " + row.target : "", showRoot && ownerLabel ? "任务 " + ownerLabel : "", row.summary || ""].filter(Boolean).join(" · ")
				: (showRoot && ownerLabel ? "任务 " + ownerLabel + " · " : "") + (row.summary || row.findingId);
			var selectionKey = "finding:" + String(row.sessionId || row.rootId || props.rootId || "") + ":" + findingId;
			return h("tr", { key: String(row.sessionId || row.rootId || "") + "/" + findingId, tabIndex: 0,
				"data-saker-row": selectionKey, className: props.selectedKey === selectionKey ? "selected" : "",
				onClick: function () { props.onSelect && props.onSelect(findingId, row.sessionId || row.rootId); },
				onKeyDown: function (event) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); props.onSelect && props.onSelect(findingId, row.sessionId || row.rootId); } } },
				h("td", null, h("div", { className: "saker-wb-cell-main" }, row.title),
					h("div", { className: "saker-wb-cell-sub" + (compact ? " saker-wb-clamp-2" : "") }, subline)),
				h("td", null, h("span", { className: "saker-wb-chip " + (row.verificationState === "verified" ? "ok" : row.verificationState === "candidate" ? "warn" : "") }, wbVerificationLabel(row.verificationState))),
				h("td", null, ({ critical: "严重", high: "高危", medium: "中危", low: "低危" })[row.severity] || row.severity || "未定级"),
				compact ? null : h("td", { className: "saker-wb-clamp-2" }, row.target || "—"),
				compact ? null : h("td", { className: "saker-col-secondary" }, wbTime(row.updatedAt)));
		})));
}
function SakerTrafficTable(props) {
	var rows = props.rows || [];
	if (!rows.length) return h("div", { className: "saker-wb-empty" }, "还没有可观测回执。回执数不是全部网络请求数。");
	return h("table", { className: "saker-wb-table" },
		h("colgroup", null, ["12%", "36%", "8%", "12%", "18%", "14%"].map(function (width, index) {
			return h("col", { key: index, style: { width: width }, className: index >= 4 ? "saker-col-secondary" : "" });
		})),
		h("thead", null, h("tr", null, ["时间", "请求", "状态", "账号", "来源", "有效性"].map(function (label, index) {
			return h("th", { key: label, className: index >= 4 ? "saker-col-secondary" : "" }, label);
		}))),
		h("tbody", null, rows.map(function (row) {
			var selectionKey = "http:" + row.rootId + ":" + row.id;
			return h("tr", { key: row.rootId + "/" + row.id, tabIndex: 0,
				"data-saker-row": selectionKey, className: props.selectedKey === selectionKey ? "selected" : "",
				onClick: function () { props.onSelect && props.onSelect(row); },
				onKeyDown: function (event) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); props.onSelect && props.onSelect(row); } } },
				h("td", null, wbTime(row.at)), h("td", null, h("div", { className: "saker-wb-cell-main" }, (row.method || "—") + " " + (row.url || "")), h("div", { className: "saker-wb-cell-sub" }, row.id)),
				h("td", null, row.status || "—"), h("td", null, row.identity || "—"),
				h("td", { className: "saker-col-secondary" }, row.source || "—"),
				h("td", null, h("span", { className: "saker-wb-chip " + (row.integrityValid ? "ok" : "bad") }, row.integrityValid ? "完整" : "失效")));
		})));
}
function SakerAssetsTable(props) {
	var rows = props.rows || [];
	if (!rows.length) return h("div", { className: "saker-wb-empty" }, "当前范围没有资产或文件记录。");
	var showRoot = props.showRoot === true;
	var labels = (showRoot ? ["测试任务", "类型", "对象", "条件", "来源/版本"] : ["类型", "对象", "条件", "来源/版本"]);
	var widths = showRoot ? ["15%", "8%", "30%", "20%", "27%"] : ["10%", "34%", "24%", "32%"];
	return h("table", { className: "saker-wb-table" },
		h("colgroup", null, widths.map(function (width, index) {
			return h("col", { key: index, style: { width: width }, className: index >= widths.length - 1 ? "saker-col-secondary" : "" });
		})),
		h("thead", null, h("tr", null, labels.map(function (label, index) {
			return h("th", { key: label, className: index >= labels.length - 1 ? "saker-col-secondary" : "" }, label);
		}))),
		h("tbody", null, rows.map(function (row, index) {
			var selectionKey = (row.kind === "material" ? "material:" : "asset:") + String(row.rootId || props.rootId || "") + ":" + String(row.id || index);
			return h("tr", { key: String(row.rootId || "") + "/" + row.kind + (row.id || index), tabIndex: 0,
				"data-saker-row": selectionKey, className: props.selectedKey === selectionKey ? "selected" : "",
				onClick: function () { props.onSelect && props.onSelect(row); },
				onKeyDown: function (event) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); props.onSelect && props.onSelect(row); } } },
				showRoot ? h("td", null, h("div", { className: "saker-wb-cell-sub" }, props.rootLabel ? props.rootLabel(row.rootId) : (row.rootId || "—"))) : null,
				h("td", null, h("span", { className: "saker-wb-chip" }, wbGraphKindLabel(row.kind))),
				h("td", null, h("div", { className: "saker-wb-cell-main" }, row.url || row.endpoint || row.name || row.id),
					h("div", { className: "saker-wb-cell-sub" }, row.id)),
				h("td", null, row.kind === "asset" ? (row.inScope ? "范围内" : "范围外") + (row.reachable ? " · 可达" : "") :
					row.kind === "request" ? (row.valid ? "已确认" : "待确认") + " · 账号 " + (row.authContext || "—") : "—"),
				h("td", { className: "saker-col-secondary" }, row.revision || row.format || "—"));
		})));
}
function SakerModulesPage(props) {
	var rootId = props.rootId || "";
	var textState = useState(""), text = textState[0], setText = textState[1];
	var debouncedState = useState(""), debounced = debouncedState[0], setDebounced = debouncedState[1];
	var categoryState = useState(""), category = categoryState[0], setCategory = categoryState[1];
	var subcategoryState = useState(""), subcategory = subcategoryState[0], setSubcategory = subcategoryState[1];
	var sourceState = useState(""), source = sourceState[0], setSource = sourceState[1];
	var statusState = useState(""), status = statusState[0], setStatus = statusState[1];
	var modeState = useState("all"), mode = modeState[0], setMode = modeState[1];
	var limitState = useState(20), limit = limitState[0], setLimit = limitState[1];
	var cursorState = useState(""), cursor = cursorState[0], setCursor = cursorState[1];
	var stackState = useState([]), stack = stackState[0], setStack = stackState[1];
	var resultState = useState(null), result = resultState[0], setResult = resultState[1];
	var loadingState = useState(false), loading = loadingState[0], setLoading = loadingState[1];
	var errorState = useState(""), error = errorState[0], setError = errorState[1];
	var selectedState = useState(""), selected = selectedState[0], setSelected = selectedState[1];
	var detailState = useState(null), detail = detailState[0], setDetail = detailState[1];
	var detailRootState = useState(""), detailRoot = detailRootState[0], setDetailRoot = detailRootState[1];
	var detailLoadingState = useState(false), detailLoading = detailLoadingState[0], setDetailLoading = detailLoadingState[1];
	var detailSeq = useRef(0);
	var copyState = useState(null), copyDraft = copyState[0], setCopyDraft = copyState[1];
	var favState = useState(function () {
		try { return JSON.parse(localStorage.getItem("saker.module.favorites") || "[]"); } catch (errorValue) { return []; }
	}), favorites = favState[0], setFavorites = favState[1];
	var recentState = useState(function () {
		try { return JSON.parse(localStorage.getItem("saker.module.recent") || "[]"); } catch (errorValue) { return []; }
	}), recent = recentState[0], setRecent = recentState[1];
	useEffect(function () {
		var timer = setTimeout(function () { setDebounced(text.trim()); }, 200);
		return function () { clearTimeout(timer); };
	}, [text]);
	useEffect(function () {
		setSelected(""); setDetail(null); setDetailRoot(""); setCopyDraft(null); setCursor(""); setStack([]); setSubcategory("");
	}, [rootId]);
	useEffect(function () {
		var live = true;
		setLoading(true); setError("");
		api("workbench.query", { kind: "modules.list", context: { rootId: rootId },
			filter: { text: debounced, categoryId: category, subcategoryId: subcategory, source: source, status: status },
			page: { limit: mode === "all" ? limit : 100, cursor: mode === "all" ? cursor : "" } })
			.then(function (response) { if (live) { setResult({ rootId: rootId, response: response }); setLoading(false); } })
			.catch(function (errorValue) { if (live) { setError(wbErrorText(errorValue)); setLoading(false); } });
		return function () { live = false; };
	}, [rootId, debounced, category, subcategory, source, status, limit, cursor, mode, props.tick]);
	var initial = result && result.rootId === rootId ? result.response.data : null;
	var shownDetail = detail && detailRoot === rootId ? detail : null;
	var taxonomy = (initial && initial.taxonomy) || (props.meta && props.meta.taxonomy) || { primaryCategories: [] };
	var items = (initial && initial.items) || (Array.isArray(props.rows) ? props.rows : (props.rows && props.rows.items)) || [];
	var facet = (initial && initial.facetCounts && initial.facetCounts.categories) || {};
	var subFacet = (initial && initial.facetCounts && initial.facetCounts.subcategories) || {};
	var pageInfo = (initial && initial.page) || { hasMore: false, nextCursor: null, total: items.length };
	var cats = [{ id: "", title: "全部分类", count: pageInfo.total || items.length }].concat((taxonomy.primaryCategories || []).map(function (item) {
		return { id: item.id, title: item.title, count: facet[item.id] || 0 };
	}));
	function favoriteKey(item) { return String(item.id || "") + "@" + String(item.version || ""); }
	function isFavorite(item) {
		var key = favoriteKey(item);
		return favorites.some(function (entry) { return typeof entry === "string" ? entry === item.id : entry && entry.key === key; });
	}
	function isRecent(item) { return recent.some(function (entry) { return entry && entry.key === favoriteKey(item); }); }
	function rememberRecent(item) {
		var key = favoriteKey(item);
		var next = [{ key: key, id: item.id, version: item.version, title: item.title, at: Date.now() }]
			.concat(recent.filter(function (entry) { return entry && entry.key !== key; })).slice(0, 24);
		setRecent(next);
		try { localStorage.setItem("saker.module.recent", JSON.stringify(next)); } catch (errorValue) { /* 最近使用失败不影响模块库 */ }
	}
	function openModule(item) {
		var seq = ++detailSeq.current;
		setSelected(item.id); setCopyDraft(null);
		setDetailLoading(true); setDetail(null); setDetailRoot(rootId); rememberRecent(item);
		api("workbench.query", { kind: "modules.detail", context: { rootId: rootId,
			moduleRef: item.moduleRef || { id: item.id, version: item.version, ownerKey: item.ownerKey } } })
			.then(function (response) {
				if (seq !== detailSeq.current) return;
				setDetail(response.data); setDetailLoading(false);
			})
			.catch(function (errorValue) {
				if (seq !== detailSeq.current) return;
				setDetail({ title: item.title, error: wbErrorText(errorValue) }); setDetailLoading(false);
			});
	}
	function toggleFavorite(item) {
		var key = favoriteKey(item);
		var exists = isFavorite(item);
		var next = exists ? favorites.filter(function (entry) { return (typeof entry === "string" ? entry !== item.id : entry && entry.key !== key); })
			: favorites.concat([{ key: key, id: item.id, version: item.version, title: item.title, family: item.family || item.familyLabel || "" }]);
		setFavorites(next);
		try { localStorage.setItem("saker.module.favorites", JSON.stringify(next)); } catch (errorValue) { /* 本地偏好失败不影响模块库 */ }
	}
	var catsView = h("div", { className: "saker-mod-cats" },
		cats.map(function (item) {
			return h("button", { key: item.id || "all", type: "button", className: "saker-mod-cat" + (category === item.id ? " active" : ""),
				onClick: function () { setCategory(item.id); setSubcategory(""); setCursor(""); setStack([]); } },
				h("span", { style: { color: "inherit" } }, item.title), h("span", null, String(item.count || 0)));
		}),
		(category ? ((taxonomy.primaryCategories || []).find(function (entry) { return entry.id === category; })?.subcategories || []) : []).length
			? h("div", { className: "saker-mod-subcats" },
				[["", "全部子类"]].concat(((taxonomy.primaryCategories || []).find(function (entry) { return entry.id === category; })?.subcategories || [])).map(function (sub) {
					var subId = sub.id || "";
					return h("button", { key: subId || "all-sub", type: "button", className: "saker-mod-subcat" + (subcategory === subId ? " active" : ""),
						onClick: function () { setSubcategory(subId); setCursor(""); setStack([]); } },
						sub.title || "全部子类", h("span", null, String(subId ? (subFacet[category + "/" + subId] || 0) : (facet[category] || 0))));
				})) : null);
	var search = h("div", { className: "saker-mod-search" },
		h("input", { value: text, placeholder: "搜索名称、别名、工具或用途", "aria-label": "搜索测试模块",
			onChange: function (event) { setText(event.target.value); setCursor(""); setStack([]); } }),
		h("select", { "aria-label": "模块视图", value: mode, onChange: function (event) { setMode(event.target.value); setCursor(""); setStack([]); } },
			h("option", { value: "all" }, "全部模块"), h("option", { value: "favorites" }, "收藏"), h("option", { value: "recent" }, "最近使用")),
		h("select", { "aria-label": "按来源筛选模块", value: source, onChange: function (event) { setSource(event.target.value); setCursor(""); setStack([]); } },
			h("option", { value: "" }, "全部来源"), h("option", { value: "builtin" }, "内置"), h("option", { value: "personal" }, "个人"), h("option", { value: "custom" }, "本任务草稿")),
		h("select", { "aria-label": "按可用状态筛选模块", value: status, onChange: function (event) { setStatus(event.target.value); setCursor(""); setStack([]); } },
			h("option", { value: "" }, "全部状态"), h("option", { value: "available" }, "可用"), h("option", { value: "partial" }, "部分可用"), h("option", { value: "blocked" }, "缺少依赖")),
		h("select", { "aria-label": "每页模块数", value: limit, onChange: function (event) { setLimit(Number(event.target.value)); setCursor(""); setStack([]); } },
			h("option", { value: 20 }, "20 / 页"), h("option", { value: 50 }, "50 / 页"), h("option", { value: 100 }, "100 / 页")),
		text || source || status || category ? h("button", { className: "saker-wb-btn", onClick: function () {
			setText(""); setSource(""); setStatus(""); setCategory(""); setSubcategory("");
		} }, "清除") : null);
	var visibleItems = items;
	if (mode === "favorites") visibleItems = items.filter(isFavorite);
	if (mode === "recent") {
		var order = new Map(recent.map(function (entry, index) { return [entry.key, index]; }));
		visibleItems = items.filter(isRecent).sort(function (a, b) {
			return (order.get(favoriteKey(a)) ?? 999) - (order.get(favoriteKey(b)) ?? 999);
		});
	}
	var list = h("div", { className: "saker-mod-list" }, search,
		loading ? h("div", { className: "saker-wb-empty" }, "读取中…") : null,
		error ? h(SakerQueryError, { state: { error: error, data: initial }, label: "测试模块", scope: rootId ? "当前测试任务" : "个人与内置", onRetry: function () { setCursor(""); setStack([]); } }) : null,
		!loading && !error && !visibleItems.length ? h("div", { className: "saker-wb-empty" },
			mode === "favorites" ? "还没有收藏模块。在模块卡片右上角点星号收藏。" :
				mode === "recent" ? "还没有最近使用的模块。" :
					debounced || category ? "没有匹配的模块。清除搜索或换一个分类。" : "模块库为空。") : null,
		h("div", { className: "saker-mod-grid" }, visibleItems.map(function (item) {
			return h("div", { key: item.id + "@" + item.version, className: "saker-mod-item" + (selected === item.id ? " active" : ""),
				role: "button", tabIndex: 0, onClick: function () { openModule(item); },
				onKeyDown: function (event) {
					if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openModule(item); return; }
					if (["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(event.key)) {
						event.preventDefault();
						var nodes = Array.prototype.slice.call(event.currentTarget.parentElement.querySelectorAll(".saker-mod-item"));
						var index = nodes.indexOf(event.currentTarget);
						var next = ["ArrowDown", "ArrowRight"].includes(event.key) ? index + 1 : index - 1;
						if (nodes[next] && nodes[next].focus) nodes[next].focus();
					}
				} },
				h("div", { className: "saker-mod-item-main" },
					h("div", { className: "saker-wb-row" }, h("div", { className: "saker-mod-item-title", style: { flex: 1 } }, item.title),
						h("span", { className: "saker-wb-chip " + (item.runtimeStatus === "available" ? "ok" : item.runtimeStatus === "blocked" ? "bad" : "warn") }, item.statusLabel || (item.runtimeStatus === "available" ? "可用" : item.runtimeStatus === "blocked" ? "缺少依赖" : "部分可用"))),
					h("div", { className: "saker-mod-item-sub" }, item.userSummary || item.outputSummary || item.familyLabel || ""),
					h("div", { className: "saker-wb-sub", style: { marginTop: "4px" } }, (item.familyLabel || item.family || "自定义") + " · v" + item.version + (item.tools && item.tools.length ? " · " + item.tools.slice(0, 4).join(" / ") : "") + (item.archived ? " · 已归档" : ""))),
				h("button", { type: "button", className: "saker-mod-fav" + (isFavorite(item) ? " on" : ""),
					"aria-label": isFavorite(item) ? "取消收藏" : "收藏模块",
					onClick: function (event) { event.stopPropagation(); toggleFavorite(item); } }, isFavorite(item) ? "★" : "☆"));
		})),
		h("div", { className: "saker-mod-pager" },
			h("button", { className: "saker-wb-btn", disabled: !stack.length || mode !== "all", onClick: function () {
				var previous = stack[stack.length - 1] || "";
				setStack(stack.slice(0, -1)); setCursor(previous);
			} }, "上一页"),
			h("span", null, "显示 " + visibleItems.length + " 项 · 共 " + String(pageInfo.total || items.length) + " 项"),
			h("button", { className: "saker-wb-btn", disabled: !pageInfo.nextCursor || mode !== "all", onClick: function () {
				setStack(stack.concat([cursor])); setCursor(pageInfo.nextCursor);
			} }, "下一页")));
	var detailView = h("div", { className: "saker-mod-detail" },
		h("div", { className: "saker-wb-row", style: { marginBottom: "8px" } },
			h("h3", { style: { flex: 1, margin: 0 } }, (shownDetail && shownDetail.title) || "模块详情"),
			h("button", { className: "saker-wb-btn", onClick: function () { setSelected(""); setDetail(null); setCopyDraft(null); } }, "关闭")),
		detailLoading ? h("div", { className: "saker-wb-sub" }, "读取中…") :
			!shownDetail ? h("div", { className: "saker-wb-sub" }, "选一个模块，查看它的适用问题、专家做法、输入输出和退出判据。") :
				shownDetail.error ? h("div", { className: "saker-wb-error" }, shownDetail.error) :
					h("div", null,
						h("div", { className: "saker-wb-row" },
							h("div", { className: "saker-wb-sub", style: { flex: 1 } }, (shownDetail.familyLabel || shownDetail.family) + " · v" + shownDetail.version + " · " + (shownDetail.source || "builtin")),
							h("span", { className: "saker-wb-chip " + (shownDetail.runtimeStatus === "available" ? "ok" : shownDetail.runtimeStatus === "blocked" ? "bad" : "warn") }, shownDetail.statusLabel || shownDetail.runtimeStatus || "未评估")),
						h("p", null, shownDetail.userSummary || shownDetail.outputSummary || "没有摘要；展开高级说明查看定义。"),
						h("div", { className: "saker-wb-row", style: { margin: "8px 0", flexWrap: "wrap" } },
							h("button", { type: "button", className: "saker-wb-btn primary", disabled: detailLoading || !props.rootId || shownDetail.runtimeStatus === "blocked",
								onClick: function () { props.run("module.prefer", { moduleSnapshotRef: detail.moduleRef || { id: detail.id, version: detail.version, digest: detail.digest, ownerKey: detail.ownerKey }, operation: "auto", sessionRef: props.rootId }, null, { rootId: props.rootId, sessionId: props.rootId }); } }, "优先用于下一项"),
							h("button", { type: "button", className: "saker-wb-btn", disabled: detailLoading, onClick: function () {
								setCopyDraft({ id: String(detail.id || "module").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) + "-copy-" + Date.now().toString(36).slice(-4),
									title: (detail.title || detail.id) + "（副本）" });
							} }, "复制修改"),
							h("button", { type: "button", className: "saker-wb-btn", disabled: detailLoading, onClick: function () {
								props.run("module.save", { moduleSnapshotRef: detail.moduleRef || { id: detail.id, version: detail.version, digest: detail.digest, ownerKey: detail.ownerKey } }, null, { rootId: props.rootId, sessionId: props.rootId });
							} }, "另存为个人模块"),
							h("span", { className: "saker-wb-sub" }, props.rootId ? "只影响下一次测试，不会发送目标请求。" : "先打开测试任务才能设置偏好；复制和另存为不需要任务。")),
						copyDraft ? h("div", { className: "saker-wb-card", style: { margin: "8px 0" } },
							h("h4", { style: { marginTop: 0 } }, "复制为我的模块"),
							h("label", { className: "saker-wb-field" }, "新模块 ID", h("input", { value: copyDraft.id,
								onChange: function (event) { setCopyDraft(Object.assign({}, copyDraft, { id: event.target.value })); } })),
							h("label", { className: "saker-wb-field" }, "名称", h("input", { value: copyDraft.title,
								onChange: function (event) { setCopyDraft(Object.assign({}, copyDraft, { title: event.target.value })); } })),
							h("div", { className: "saker-wb-row" },
								h("button", { className: "saker-wb-btn primary", disabled: !copyDraft.id || !copyDraft.title,
									onClick: function () {
										props.run("module.define", {
											id: copyDraft.id, title: copyDraft.title, destination: "personal",
											purpose: detail.purpose || detail.userSummary || detail.title,
											instructions: detail.instructions || detail.purpose || detail.title,
											inputs: detail.inputs || [], outputs: detail.outputs || [], operations: detail.operations || ["auto"],
											deliverable: detail.deliverable || detail.outputSummary || "",
											categoryId: detail.categoryId || "", subcategoryId: detail.subcategoryId || "",
											family: detail.family || "custom", userSummary: detail.userSummary || "",
											outputSummary: detail.outputSummary || "", searchAliases: detail.searchAliases || [],
										}, function () { setCopyDraft(null); });
									} }, "保存为我的模块"),
								h("button", { className: "saker-wb-btn", onClick: function () { setCopyDraft(null); } }, "取消"))) : null,
						h("h4", null, "依赖检查"), detail.capabilities && detail.capabilities.length ? h("div", { style: { display: "grid", gap: "8px" } }, detail.capabilities.map(function (cap) {
							return h("div", { key: cap.key, className: "saker-wb-row" },
								h("span", { className: "saker-wb-chip " + (cap.status === "verified" ? "ok" : cap.status === "missing" ? "bad" : "warn") }, cap.status === "verified" ? "已验证" : cap.status === "present" ? "仅二进制" : "缺失"),
								h("span", { style: { flex: 1 } }, cap.label || cap.key), cap.tool ? h("span", { className: "saker-wb-sub" }, cap.tool) : null);
						})) : h("p", { className: "saker-wb-sub" }, "没有依赖记录。"),
						detail.missingPrerequisites && detail.missingPrerequisites.length ? h("div", { className: "saker-wb-notice" }, h("span", null, "缺项：" + detail.missingPrerequisites.map(function (item) { return item.message; }).join("；"))) : null,
						h("details", { className: "saker-wb-advanced" }, h("summary", null, "高级：完整说明与输入输出"),
							h("h4", null, "适用问题与做法"), h("pre", null, detail.purpose || ""),
							h("h4", null, "执行说明"), h("pre", null, detail.instructions || ""),
							h("h4", null, "输入 / 产物"), h("pre", null, JSON.stringify({ inputs: detail.inputs || [], outputs: detail.outputs || [], operations: detail.operations || [] }, null, 2)),
							h("h4", null, "交付"), h("pre", null, detail.deliverable || ""))));
	var libraryTabState = useState("modules"), libraryTab = libraryTabState[0], setLibraryTab = libraryTabState[1];
	return h("div", { className: "saker-modlib" },
		h("div", { className: "saker-wb-tabs", role: "tablist" },
			h("button", { type: "button", className: "saker-wb-tab" + (libraryTab === "modules" ? " active" : ""), onClick: function () { setLibraryTab("modules"); } }, "模块库"),
			h("button", { type: "button", className: "saker-wb-tab" + (libraryTab === "methods" ? " active" : ""), onClick: function () { setLibraryTab("methods"); } }, "我的流程")),
		libraryTab === "methods" ? h(SakerMethodCombos, { rootId: rootId, tick: props.tick, run: props.run })
			: h("div", { className: "saker-mod" }, catsView, list, selected ? detailView : null));
}
function SakerMethodsList(props) {
	var rows = props.rows || [];
	if (!rows.length) return h("div", { className: "saker-wb-empty" }, "没有可用的测试流程。");
	return h("div", { style: { display: "grid", gap: "8px" } }, rows.map(function (row) {
		return h("div", { className: "saker-wb-card", key: row.methodId },
			h("div", { className: "saker-wb-row" }, h("h3", { style: { margin: 0, flex: 1 } }, row.title),
				h("span", { className: "saker-wb-chip" + (row.selected ? " ok" : "") }, row.selected ? "当前" : row.scope)),
			h("div", { className: "saker-wb-sub" }, row.description || "无说明"),
			h("div", { className: "saker-wb-sub", style: { marginTop: "4px" } }, row.nodeCount + " 个动作 · 版本 " + row.version),
			h("div", { style: { marginTop: "8px" } }, h("button", { className: "saker-wb-btn", disabled: !props.rootId,
				onClick: function () { props.run("method.select", { methodRef: { id: row.methodId } }); } }, "用于下一次测试")));
	}));
}
function SakerMethodCombos(props) {
	var textState = useState(""), text = textState[0], setText = textState[1];
	var cursorState = useState(""), cursor = cursorState[0], setCursor = cursorState[1];
	var stackState = useState([]), stack = stackState[0], setStack = stackState[1];
	var query = useWorkbenchQuery("methods.list", { rootId: props.rootId || "" }, props.tick || 0, true,
		{ filter: { text: text }, page: { limit: 50, cursor: cursor } });
	var rows = query.data || [];
	return h("div", { className: "saker-combos" },
		h(SakerListToolbar, { text: text, onText: function (value) { setText(value); setCursor(""); setStack([]); }, placeholder: "搜索我的测试流程",
			loadedLabel: query.loading ? "读取中…" : "显示 " + rows.length + " 个流程" }),
		h(SakerQueryError, { state: query, label: "我的测试流程", scope: props.rootId ? "当前测试任务" : "个人与内置", onRetry: function () { setCursor(""); setStack([]); } }),
		!query.loading && !rows.length ? h("div", { className: "saker-wb-empty" }, "还没有保存的测试流程。进入任务后，在流程编辑器里另存为个人流程即可。") : null,
		h("div", { className: "saker-wb-cards" }, rows.map(function (row) {
			return h("div", { key: row.methodId + "@" + row.version, className: "saker-wb-card" },
				h("div", { className: "saker-wb-row" }, h("b", { style: { flex: 1 } }, row.title),
					h("span", { className: "saker-wb-chip" + (row.selected ? " ok" : "") }, row.selected ? "当前" : (row.scope === "personal" ? "个人" : row.scope === "session" ? "本任务" : "内置"))),
				h("div", { className: "saker-wb-sub" }, row.description || "无说明"),
				h("div", { className: "saker-wb-sub", style: { marginTop: "4px" } }, row.nodeCount + " 个动作 · v" + row.version),
				h("div", { style: { marginTop: "8px" } }, h("button", { className: "saker-wb-btn", disabled: !props.rootId || !props.run,
					onClick: function () { props.run("method.select", { methodRef: { id: row.methodId } }); } }, "用于下一次测试")));
		})),
		h(SakerPager, { page: query.meta && query.meta.page, loaded: rows.length, hasPrev: stack.length > 0,
			onPrev: function () { if (!stack.length) return; setStack(stack.slice(0, -1)); setCursor(stack[stack.length - 1] || ""); },
			onNext: function () { var page = query.meta && query.meta.page; if (page && page.nextCursor) { setStack(stack.concat([cursor])); setCursor(page.nextCursor); } } }));
}
function SakerRolesPage(props) {
	var rows = props.rows || [];
	var textState = useState(""), text = textState[0], setText = textState[1];
	var createState = useState(false), createOpen = createState[0], setCreateOpen = createState[1];
	var form = useState({ title: "", objective: "", responsibilities: "", deliverable: "", roleId: "" });
	var draft = form[0], setDraft = form[1];
	var selectedState = useState(null), selected = selectedState[0], setSelected = selectedState[1];
	var detailState = useState(null), detail = detailState[0], setDetail = detailState[1];
	var detailErrorState = useState(""), detailError = detailErrorState[0], setDetailError = detailErrorState[1];
	var versionState = useState(0), version = versionState[0], setVersion = versionState[1];
	var workState = useState([]), workRows = workState[0], setWorkRows = workState[1];
	var workPickState = useState(""), workPick = workPickState[0], setWorkPick = workPickState[1];
	var detailSeq = useRef(0);
	useEffect(function () { setSelected(null); setDetail(null); setVersion(0); }, [props.rootId]);
	useEffect(function () {
		if (!selected) { setDetail(null); return; }
		var seq = ++detailSeq.current;
		setDetailError("");
		api("workbench.query", { kind: "roles.detail", context: { rootId: props.rootId || "", roleId: selected.roleId, version: version || selected.version } })
			.then(function (response) {
				if (seq !== detailSeq.current) return;
				if (!response || response.ok === false) throw Error((response && response.error) || "读取角色失败");
				setDetail(response.data);
			})
			.catch(function (failure) { if (seq === detailSeq.current) setDetailError(wbErrorText(failure)); });
	}, [selected && selected.roleId, version, props.rootId, props.tick]);
	useEffect(function () {
		if (!props.rootId) { setWorkRows([]); return; }
		var live = true;
		api("workbench.query", { kind: "work.list", context: { rootId: props.rootId }, page: { limit: 100 } })
			.then(function (response) { if (live && response && response.ok !== false) setWorkRows(response.data || []); })
			.catch(function () { if (live) setWorkRows([]); });
		return function () { live = false; };
	}, [props.rootId, props.tick]);
	function field(key, label, textarea) {
		return h("label", { key: key }, label, h(textarea ? "textarea" : "input", { value: draft[key],
			onChange: function (event) { setDraft(Object.assign({}, draft, { [key]: event.target.value })); } }));
	}
	function beginCreate(source) {
		setCreateOpen(true);
		setDraft(source ? {
			roleId: source.roleId, title: (source.title || "") + "（新版本）", objective: source.objective || "",
			responsibilities: source.responsibilities || "", deliverable: source.deliverable || "",
		} : { title: "", objective: "", responsibilities: "", deliverable: "", roleId: "" });
	}
	var visible = rows.filter(function (row) {
		if (!text.trim()) return true;
		var needle = text.toLowerCase();
		return [row.title, row.objective, row.responsibilities, row.deliverable, row.roleId, row.scope]
			.some(function (value) { return String(value || "").toLowerCase().includes(needle); });
	});
	var formView = createOpen ? h("div", { className: "saker-wb-card" },
		h("h3", null, draft.roleId ? "创建新版本" : (props.rootId ? "创建本轮临时角色" : "创建个人角色")),
		h("div", { className: "saker-wb-form" }, field("title", "名称"), field("objective", "要解决的问题", true),
			field("responsibilities", "职责与边界", true), field("deliverable", "交付标准", true),
			h("div", { className: "saker-wb-row" },
				h("button", { className: "saker-wb-btn primary", disabled: !draft.title || !draft.objective,
					onClick: function () {
						var body = Object.assign({}, draft);
						if (!body.roleId) delete body.roleId;
						props.run("role.define", body, function () {
							setDraft({ title: "", objective: "", responsibilities: "", deliverable: "", roleId: "" }); setCreateOpen(false);
						});
					} }, draft.roleId ? "保存新版本" : (props.rootId ? "保存为本轮角色" : "保存到个人角色库")),
				h("button", { className: "saker-wb-btn", onClick: function () { setCreateOpen(false); } }, "取消"))),
		!props.rootId ? h("div", { className: "saker-wb-sub", style: { marginTop: "4px" } }, "当前没有进入任务：保存后会进入个人角色库；定义本身不会启动实例。") : null) : null;
	var detailView = selected ? h("div", { className: "saker-wb-card saker-wb-detail-card" },
		h("div", { className: "saker-wb-row" }, h("h3", { style: { flex: 1, marginTop: 0 } }, selected.title),
			h("button", { className: "saker-wb-btn", onClick: function () { setSelected(null); } }, "关闭")),
		detailError ? h("div", { className: "saker-wb-error" }, detailError) :
			!detail ? h("div", { className: "saker-wb-sub" }, "读取中…") :
				h("div", null,
					h("div", { className: "saker-wb-sub" }, "v" + detail.version + " · " + (detail.scope === "global" ? "个人" : "本任务") + " · " + (detail.roleId || "")),
					h("p", null, detail.objective || ""),
					h("h4", null, "职责与边界"), h("p", null, detail.responsibilities || "—"),
					h("h4", null, "交付标准"), h("p", null, detail.deliverable || "—"),
					h("h4", null, "版本"),
					h("div", { className: "saker-wb-row", style: { flexWrap: "wrap" } },
						(selected.versions || []).map(function (item) {
							return h("button", { key: item.version, className: "saker-wb-btn" + (Number(version || selected.version) === Number(item.version) ? " primary" : ""),
								onClick: function () { setVersion(item.version); } }, "v" + item.version + (item.scope === "global" ? " · 个人" : ""));
						})),
					h("h4", null, "当前实例"),
					(selected.instances || []).length ? (selected.instances || []).map(function (instance) {
						return h("div", { key: instance.childId, className: "saker-wb-row" },
							h("span", { className: "saker-wb-chip " + (instance.settlement ? "warn" : "") }, wbNodeStateLabel(instance.state)),
							h("span", { className: "saker-wb-cell-main" }, instance.workId || instance.childId),
							h("span", { className: "saker-wb-sub" }, instance.settlement ? instance.settlement.label : instance.updatedAt ? wbTime(instance.updatedAt) : ""));
					}) : h("p", { className: "saker-wb-sub" }, "这个版本还没有派过实例。定义不等于启动实例。"),
					h("div", { className: "saker-wb-row", style: { marginTop: "8px", flexWrap: "wrap" } },
						h("button", { className: "saker-wb-btn", onClick: function () { beginCreate(detail); } }, "复制为新版本"),
						h("button", { className: "saker-wb-btn", onClick: function () {
							props.run("role.save", { roleRef: { id: detail.roleId, version: detail.version }, alias: detail.title }, null,
								{ rootId: props.rootId || "" });
						} }, "保存到个人角色库")),
					props.rootId && workRows.length ? h("div", { className: "saker-wb-card", style: { marginTop: "8px" } },
						h("h4", { style: { marginTop: 0 } }, "派给具体工作"),
						h("select", { "aria-label": "选择工作项", value: workPick, onChange: function (event) { setWorkPick(event.target.value); } },
							h("option", { value: "" }, "选择一项工作"),
							workRows.map(function (work) { return h("option", { key: work.workId, value: work.workId }, work.title || work.question || work.workId); })),
						h("div", { style: { marginTop: "8px" } },
							h("button", { className: "saker-wb-btn primary", disabled: !workPick,
								onClick: function () {
									props.run("work.assign", { roleSnapshotRef: { id: detail.roleId, version: detail.version }, workRef: { id: workPick } }, null,
										{ rootId: props.rootId });
								} }, "派工"))) : null)) : null;
	return h("div", { className: "saker-roles" },
		h("div", { className: "saker-wb-toolbar" },
			h("input", { className: "saker-wb-search", type: "search", value: text, placeholder: "搜索角色名称、职责或 ID",
				"aria-label": "搜索角色", onChange: function (event) { setText(event.target.value); } }),
			h("button", { className: "saker-wb-btn primary", onClick: function () { beginCreate(null); } }, "新建角色"),
			h("span", { className: "saker-wb-spacer" }),
			h("span", { className: "saker-wb-sub" }, "显示 " + visible.length + " / 共 " + rows.length + " 个角色")),
		formView,
		!rows.length ? h("div", { className: "saker-wb-empty" }, "还没有保存的角色。定义角色只是写清职责，不会启动实例。") : null,
		!visible.length && rows.length ? h("div", { className: "saker-wb-empty" }, "没有匹配的角色。清除搜索后再试。") : null,
		h("div", { className: "saker-roles-layout" },
			h("div", { className: "saker-wb-cards saker-roles-cards" }, visible.map(function (row) {
				return h("button", { key: row.roleId + "@" + row.version, type: "button",
					className: "saker-wb-card saker-wb-cardbtn" + (selected && selected.roleId === row.roleId ? " active" : ""),
					onClick: function () { setSelected(row); setVersion(row.version); setWorkPick(""); } },
					h("div", { className: "saker-wb-row" }, h("b", { style: { flex: 1 } }, row.title),
						h("span", { className: "saker-wb-chip" }, "v" + row.version + " · " + (row.scope === "global" ? "个人" : "本任务" + (row.ownerSession ? " " + String(row.ownerSession).slice(-8) : "")))),
					h("div", { className: "saker-wb-sub" }, row.objective || "无说明"),
					h("div", { className: "saker-wb-sub", style: { marginTop: "4px" } }, "版本 " + (row.versions || []).length + " · 实例 " + (row.instances || []).length));
			})),
			selected ? h("aside", { className: "saker-roles-detailpane" }, detailView) : null));
}
function SakerCapabilitiesTable(props) {
	var rows = props.rows || [];
	if (!rows.length) return h("div", { className: "saker-wb-empty" }, "当前 Host 未暴露工具，或会话尚未加载。");
	return h("table", { className: "saker-wb-table" },
		h("thead", null, h("tr", null, ["工具", "用途", "来源", "当前状态"].map(function (label, index) {
			return h("th", { key: label, className: index === 2 ? "saker-col-secondary" : "" }, label);
		}))),
		h("tbody", null, rows.map(function (row) {
			return h("tr", { key: row.id }, h("td", null, row.name), h("td", null, h("div", { className: "saker-wb-cell-sub" }, row.purpose || "—")),
				h("td", { className: "saker-col-secondary" }, row.source), h("td", null, h("span", { className: "saker-wb-chip" }, row.status)));
		})));
}
function SakerAttentionList(props) {
	var rows = props.rows || [];
	if (!rows.length) return h("div", { className: "saker-wb-empty" }, "没有待办事项。");
	return h("div", { style: { display: "grid", gap: "8px" } }, rows.map(function (row) {
		return h("div", { className: "saker-wb-card", key: row.id, role: "button", tabIndex: 0,
			onClick: function () { row.rootId && props.onOpen && props.onOpen(row.rootId); },
			onKeyDown: function (event) { if ((event.key === "Enter" || event.key === " ") && row.rootId) { event.preventDefault(); props.onOpen && props.onOpen(row.rootId); } } },
			h("div", { className: "saker-wb-row" }, h("span", { className: "saker-wb-chip warn" }, wbAttentionKindLabel(row.kind)), h("b", null, row.title || row.kind)),
			h("div", null, row.reason), row.evidence ? h("div", { className: "saker-wb-sub" }, "依据：" + row.evidence) : null,
			h("div", { className: "saker-wb-sub" }, "下一步：" + row.next));
	}));
}
function SakerLogsList(props) {
	var rows = props.rows || [];
	if (!rows.length) return h("div", { className: "saker-wb-empty" }, "当前范围没有执行日志；先选择一个测试任务查看。");
	return h("div", { style: { display: "grid", gap: "4px" } }, rows.map(function (row, index) {
		return h("div", { key: index, className: "saker-wb-card", style: { padding: "8px" } },
			h("div", { className: "saker-wb-row" }, h("span", { className: "saker-wb-chip" }, row.kind), h("span", { className: "saker-wb-sub" }, wbTime(row.at))),
			h("div", { className: "saker-wb-cell-sub" }, String(row.record || "").slice(0, 300)));
	}));
}
function SakerGraph(props) {
	var graph = props.graph || { nodes: [], edges: [] };
	var allNodes = graph.nodes || [];
	var allEdges = graph.edges || [];
	var limitState = useState(300), limit = limitState[0], setLimit = limitState[1];
	var scaleState = useState(1), scale = scaleState[0], setScale = scaleState[1];
	var panState = useState({ x: 0, y: 0 }), pan = panState[0], setPan = panState[1];
	var dragState = useState(null), drag = dragState[0], setDrag = dragState[1];
	var searchState = useState(""), search = searchState[0], setSearch = searchState[1];
	var selectedState = useState(null), selected = selectedState[0], setSelected = selectedState[1];
	var neighborhoodState = useState(false), neighborhood = neighborhoodState[0], setNeighborhood = neighborhoodState[1];
	var focusState = useState(""), focusId = focusState[0], setFocusId = focusState[1];
	var sizeState = useState({ width: 0, height: 560 }), canvasSize = sizeState[0], setCanvasSize = sizeState[1];
	var canvasRef = useRef(null);
	var composingSearch = useRef(false);
	var useGraphEffect = typeof useEffect === "function" ? useEffect : function () {};
	var neighborhoodIds = null;
	if (neighborhood && selected) {
		neighborhoodIds = {};
		neighborhoodIds[selected.id] = true;
		allEdges.forEach(function (edge) {
			if (edge.from === selected.id) neighborhoodIds[edge.to] = true;
			if (edge.to === selected.id) neighborhoodIds[edge.from] = true;
		});
	}
	var nodes = neighborhoodIds ? allNodes.filter(function (node) { return neighborhoodIds[node.id]; }) : allNodes.slice(0, limit);
	var visibleIds = {};
	nodes.forEach(function (node) { visibleIds[node.id] = true; });
	var edges = allEdges.filter(function (edge) { return visibleIds[edge.from] && visibleIds[edge.to]; });
	var kindOrder = ["root", "work", "workflow", "step", "attempt", "asset", "endpoint", "check", "receipt", "finding", "material"];
	var groups = {};
	kindOrder.forEach(function (kind) { groups[kind] = []; });
	nodes.forEach(function (node) { if (!groups[node.kind]) groups[node.kind] = []; groups[node.kind].push(node); });
	var nodeWidth = 220, nodeHeight = 58, columnWidth = 250, rowHeight = 76;
	var pos = {}, column = 0, tallest = 0;
	var rowsPerColumn = Math.max(8, Math.min(20, Math.ceil(Math.sqrt(Math.max(1, nodes.length)))));
	Object.keys(groups).forEach(function (kind) {
		var list = groups[kind];
		if (!list.length) return;
		list.forEach(function (node, index) {
			var row = index % rowsPerColumn, groupColumn = Math.floor(index / rowsPerColumn);
			pos[node.id] = { x: (column + groupColumn) * columnWidth + 16, y: row * rowHeight + 18, kind: kind };
		});
		tallest = Math.max(tallest, Math.min(list.length, rowsPerColumn) * rowHeight + 24);
		column += Math.max(1, Math.ceil(list.length / rowsPerColumn));
	});
	var width = Math.max(460, column * columnWidth + 24);
	var height = Math.max(220, tallest + 16);
	var needle = search.trim().toLowerCase();
	var matches = needle ? allNodes.filter(function (node) { return [node.title, node.kind, node.state, node.id].some(function (value) { return String(value || "").toLowerCase().includes(needle); }); }) : [];
	var edgeKinds = [];
	edges.forEach(function (edge) { if (edgeKinds.indexOf(edge.kind) < 0) edgeKinds.push(edge.kind || "related"); });
	var kindColors = { root: "#4176e6", work: "#7a5af8", workflow: "#0f8b8d", step: "#2f8a58", attempt: "#a05a2c",
		asset: "#276fbf", endpoint: "#6a6f7a", check: "#b58a00", receipt: "#2f7d8a", finding: "#c62828", material: "#7b5ea7" };
	function viewport() {
		return { width: Number(canvasSize.width) || 900, height: Number(canvasSize.height) || 560 };
	}
	function clampPan(x, y, nextScale) {
		var box = viewport();
		return {
			x: Math.min(80, Math.max(Math.min(0, box.width - width * nextScale - 80), x)),
			y: Math.min(80, Math.max(Math.min(0, box.height - height * nextScale - 80), y)),
		};
	}
	function focusNode(node, nextScale) {
		var point = pos[node && node.id];
		if (!point) return;
		var appliedScale = Number(nextScale) || Math.max(1, scale), box = viewport();
		setScale(appliedScale);
		setPan(clampPan(box.width / 2 - (point.x + nodeWidth / 2) * appliedScale,
			box.height / 2 - (point.y + nodeHeight / 2) * appliedScale, appliedScale));
	}
	function fitGraph() {
		var box = viewport();
		var fitted = Math.min((box.width - 32) / Math.max(1, width), (box.height - 32) / Math.max(1, height), 1.25);
		fitted = Math.max(0.12, Number(fitted.toFixed(3)));
		setScale(fitted);
		setPan(clampPan((box.width - width * fitted) / 2, (box.height - height * fitted) / 2, fitted));
	}
	function locateMatch(node) {
		if (!node) return;
		var index = Math.max(0, allNodes.findIndex(function (item) { return item.id === node.id; }));
		if (index >= limit || neighborhood) {
			setNeighborhood(false);
			setLimit(Math.max(limit, index + 1));
		}
		setFocusId(node.id);
	}
	useGraphEffect(function () {
		var element = canvasRef.current;
		if (!element || typeof ResizeObserver === "undefined") return;
		var observer = new ResizeObserver(function (entries) {
			var rect = entries && entries[0] ? entries[0].contentRect : null;
			if (!rect) return;
			setCanvasSize({ width: Math.max(1, rect.width), height: Math.max(240, Math.min(560, rect.height)) });
		});
		observer.observe(element);
		return function () { try { observer.disconnect(); } catch (_error) {} };
	}, []);
	useGraphEffect(function () {
		if (!focusId) return;
		var target = allNodes.find(function (node) { return node.id === focusId; });
		if (!target || !pos[focusId]) return;
		setSelected(target);
		props.onSelect && props.onSelect(target);
		focusNode(target, Math.max(1, scale));
		setFocusId("");
	}, [focusId, limit, neighborhood, scale]);
	if (!allNodes.length) return h("div", { className: "saker-wb-empty" }, props.emptyText || "还没有可绘制的真实引用。路径图不会替代测试流程或任务结构。");
	function applySearch(next) {
		var needleValue = String(next || "").trim().toLowerCase();
		setSearch(next);
		if (needleValue) {
			var match = allNodes.find(function (node) {
				return [node.title, node.kind, node.state, node.id].some(function (value) {
					return String(value || "").toLowerCase().includes(needleValue);
				});
			});
			locateMatch(match);
		}
	}
	return h("div", { className: "saker-graph" },
		h("div", { className: "saker-graph-toolbar" },
			h("input", { className: "saker-wb-search", type: "search", value: search, placeholder: "在图里搜索节点",
				"aria-label": "搜索图节点",
				onChange: function (event) {
					if (composingSearch.current || (event.nativeEvent && event.nativeEvent.isComposing)) { setSearch(event.target.value); return; }
					applySearch(event.target.value);
				},
				onCompositionStart: function () { composingSearch.current = true; },
				onCompositionEnd: function (event) { composingSearch.current = false; applySearch(event.target.value); } }),
			h("button", { className: "saker-wb-btn", onClick: function () { setScale(function (value) { return Math.min(2.2, Number((value + 0.15).toFixed(2))); }); } }, "放大"),
			h("button", { className: "saker-wb-btn", onClick: function () { setScale(function (value) { return Math.max(0.45, Number((value - 0.15).toFixed(2))); }); } }, "缩小"),
			h("button", { className: "saker-wb-btn", onClick: fitGraph }, "适合视图"),
			selected ? h("button", { className: "saker-wb-btn", onClick: function () { setNeighborhood(!neighborhood); } }, neighborhood ? "显示全图" : "仅看选中邻域") : null,
			matches.length ? h("button", { className: "saker-wb-btn", onClick: function () { locateMatch(matches[0]); } }, "定位首个命中") : null,
			h("span", { className: "saker-wb-sub" }, "缩放 " + Math.round(scale * 100) + "% · 拖动平移" + (needle ? " · 命中 " + matches.length : ""))),
		h("div", { className: "saker-graph-legend", "aria-label": "图例" },
			Object.keys(groups).filter(function (kind) { return groups[kind].length; }).map(function (kind) {
				return h("span", { key: kind, className: "saker-graph-legend-item" },
					h("i", { style: { background: kindColors[kind] || "#6a6f7a" } }), wbGraphKindLabel(kind) + " " + groups[kind].length);
			}),
			edgeKinds.length ? h("span", { className: "saker-graph-legend-item" }, "关系：" + edgeKinds.join(" / ")) : null),
		h("div", { className: "saker-graph-canvas", tabIndex: 0, ref: canvasRef,
			onMouseDown: function (event) { if (event.button === 0 && !event.target.closest("g")) setDrag({ x: event.clientX, y: event.clientY, px: pan.x, py: pan.y }); },
			onMouseMove: function (event) { if (!drag) return; setPan({ x: drag.px + event.clientX - drag.x, y: drag.py + event.clientY - drag.y }); },
			onMouseUp: function () { setDrag(null); }, onMouseLeave: function () { setDrag(null); } },
			h("svg", { viewBox: "0 0 " + width + " " + height, width: width, height: height, role: "img", "aria-label": "关系图",
				style: { minWidth: width, minHeight: height, transform: "translate(" + pan.x + "px," + pan.y + "px) scale(" + scale + ")", transformOrigin: "0 0" } },
				h("defs", null, h("marker", { id: "saker-graph-arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse" },
					h("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "var(--dsh-border,rgba(127,127,127,.75))" }))),
				edges.map(function (edge, index) {
					var a = pos[edge.from], b = pos[edge.to];
					if (!a || !b) return null;
					var x1 = a.x + nodeWidth, y1 = a.y + nodeHeight / 2, x2 = b.x, y2 = b.y + nodeHeight / 2;
					return h("g", { key: "e" + index },
						h("line", { x1: x1, y1: y1, x2: x2, y2: y2, "marker-end": "url(#saker-graph-arrow)" },
							h("title", null, edge.kind || "related")),
						edges.length <= 4 && scale >= 1.1 ? h("text", { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 4, className: "saker-graph-edge-label" }, edge.kind || "related") : null);
				}),
				nodes.map(function (node) {
					var p = pos[node.id];
					var hit = needle && matches.some(function (item) { return item.id === node.id; });
					return h("g", { key: node.id, transform: "translate(" + p.x + "," + p.y + ")", role: "button", tabIndex: 0,
						className: "saker-graph-node" + (hit ? " is-hit" : "") + (selected && selected.id === node.id ? " is-selected" : ""),
						onClick: function () { setSelected(node); props.onSelect && props.onSelect(node); },
						onKeyDown: function (event) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected(node); props.onSelect && props.onSelect(node); } } },
						h("rect", { width: nodeWidth, height: nodeHeight, rx: 6, fill: "var(--dsh-bg-primary,Canvas)", stroke: kindColors[node.kind] || "var(--dsh-border,rgba(127,127,127,.45))", strokeWidth: hit || (selected && selected.id === node.id) ? 2 : 1 }),
						h("rect", { width: 4, height: nodeHeight, rx: 2, fill: kindColors[node.kind] || "#6a6f7a" }),
						h("foreignObject", { x: 9, y: 4, width: nodeWidth - 18, height: 20 },
							h("div", { xmlns: "http://www.w3.org/1999/xhtml", className: "saker-graph-node-title", title: String(node.title || node.id) },
								String(node.title || node.id))),
						h("text", { x: 10, y: nodeHeight - 12, className: "saker-graph-node-sub" },
							String(node.subtitle || [wbGraphKindLabel(node.kind), wbNodeStateLabel(node.state)].filter(Boolean).join(" · ")).slice(0, 44)));
				})),
			!nodes.length ? h("div", { className: "saker-wb-empty" }, "当前过滤没有节点。") : null),
		allNodes.length > limit ? h("div", { className: "saker-wb-notice" },
			h("span", null, "共 " + allNodes.length + " 个节点，当前显示前 " + limit + " 个；没有静默丢弃。"),
			h("button", { className: "saker-wb-btn", onClick: function () { setLimit(allNodes.length); } }, "展开全部")) : null,
		matches.length ? h("div", { className: "saker-wb-notice" },
			h("span", null, "共命中 " + matches.length + " 个节点。搜索范围包含尚未显示、尚未展开的全部图数据。"),
			h("button", { className: "saker-wb-btn", onClick: function () { locateMatch(matches[0]); } }, "定位并展开")) : null,
		selected ? h("div", { className: "saker-graph-detail" },
			h("div", { className: "saker-wb-row" }, h("b", { style: { flex: 1 } }, selected.title || selected.id),
				h("span", { className: "saker-wb-chip" }, selected.kind),
				h("button", { className: "saker-wb-btn", onClick: function () { setSelected(null); } }, "关闭")),
			h("div", { className: "saker-wb-sub" }, "id：" + selected.id + " · 状态：" + (selected.state || "—")),
			props.onOpenNode ? h("div", { style: { marginTop: "8px" } }, h("button", { className: "saker-wb-btn", onClick: function () { props.onOpenNode(selected); } }, "打开对应原件")) : null) : null);
}
//#endregion

function injectVisibleConversationView(ctx, field, register) {
	var settings = ctx.configForms && ctx.configForms.get
		? ctx.configForms.get(REDTEAM_MANAGER_UI_NAMESPACE)
		: ctx.settingsScope.bind({ namespace: REDTEAM_MANAGER_UI_NAMESPACE });
	ctx.slots.inject("conversation.view", function () {
		var disposeView;
		function isVisible() {
			var snapshot = settings.getSnapshot();
			return snapshot.status !== "ready" || !snapshot.value || snapshot.value[field] !== false;
		}
		function reconcile() {
			if (isVisible()) {
				if (!disposeView) disposeView = register();
				return;
			}
			if (disposeView) {
				disposeView();
				disposeView = undefined;
			}
		}
		var unsubscribe = settings.subscribe(reconcile);
		reconcile();
		return function () {
			unsubscribe();
			if (disposeView) {
				disposeView();
				disposeView = undefined;
			}
		};
	});
}

function apply(ctx) {
	ctx.effect(function () { return installStyles(); }, "dsh-redteam-results: styles");
	ctx.effect(function () { return installWorkbenchStyles(); }, "dsh-redteam-results: workbench styles");
	ctx.slots.inject("main", function () {
		return ctx.slots.register({ name: "main", key: "saker-workbench", label: function () { return "Saker 安全工作台"; } }, function (props) {
			return h(SakerWorkbenchPage, Object.assign({}, props, { ctx: ctx }));
		});
	});
	ctx.slots.inject("sidebar.panellist", function () {
		return ctx.slots.register({ name: "sidebar.panellist", id: "saker-workbench", order: 12, label: function () { return "Saker"; } }, SakerWorkbenchIcon);
	});
	ctx.effect(function () { return installChatSetupStyles(); }, "dsh-redteam-results: chat setup styles");
	ctx.effect(function () { return installCurationStyles(); }, "dsh-redteam-results: curation styles");
	ctx.effect(function () { return installDesignSystemStyles(); }, "dsh-redteam-results: design system overrides");
	ctx.slots.inject('conversation.input.dock',function(){return ctx.slots.register({name:'conversation.input.dock',id:'saker-chat-setup',order:-20},ChatSetupEntry);});
	ctx.slots.inject('conversation.chat.assistant-actions',function(){return ctx.slots.register({name:'conversation.chat.assistant-actions',id:'saker-curation-action',order:80},CurationAction);});
	ctx.inject(['sessions'], function (scope) {
		injectVisibleConversationView(ctx, "showRedteamResults", function () {
			return ctx.slots.register({ name: "conversation.view", id: "saker-results", order: 55,
				label: function () { return "测试结果"; } }, function (props) {
				var preset = props.useProjection('agentPreset');
				if (preset === 'ctf-solver') return React.createElement(CompetitionEntry, {
					key: props.sessionId, sessionId: props.sessionId, open: true, embedded: true, onOpenChange: function () {},
				});
				return React.createElement(ResultsView, Object.assign({}, props, { key: props.sessionId,
					sessionsStore: scope.sessions, connection: ctx.connection,
					defaultMode: preset === 'code-audit' ? 'code-audit' : 'pentest' }));
			});
		});
	});
}

module.exports = { name: "dsh-redteam-results-client", inject: ["slots", "configForms", "connection", "uiWorkspace", "sessions"], apply: apply, ChatSetup: ChatSetup };
return module.exports; } });
