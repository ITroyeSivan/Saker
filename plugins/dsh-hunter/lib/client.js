window.__ModuleLoader__.load({ id: "@dsh-external/dsh-hunter", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
// dsh-hunter client — 会话标签页「hunter 狩猎」（与 redteam 成果并排）：
// 三平台资产搜索（统一 DSL / 高级原生）、设置面板（API key）、分页、导出、授权标记、实测历史。
"use strict";
/* SAKER-UI-KIT:BEGIN */
var SAKER_UI_KIT_CSS = "/* 5.7 共享组件层：Button / Input / Select / Badge / DataTable / Drawer / InlineNotice / EmptyState\n   单一来源：shared/ui-kit/ui-kit.css（令牌见 shared/ui-kit/ui-kit.json）。\n   由 scripts/sync-ui-kit.mjs 注入到各产品插件；插件里的同类尺寸规则应删除，避免双写。 */\n.saker-ui-btn{height:32px;display:inline-flex;align-items:center;justify-content:center;border-radius:6px}\n.saker-ui-input{height:36px;border-radius:6px}\n.saker-ui-select{height:32px;border-radius:6px}\n.saker-ui-table td{height:38px}\n.saker-ui-badge{border-radius:6px;font-size:12px;line-height:1.5}\n.saker-ui-drawer{border-radius:12px}\n.saker-ui-notice{border-radius:6px;font-size:13px;line-height:1.5}\n.saker-ui-empty{border-radius:6px;font-size:13px;line-height:1.5}\n/* 现有插件类别名：与 canonical 类共用同一套尺寸 */\n.dsh-chat-panel-head button,.dsh-chat-actions button,.dsh-chat-task-status button,.dsh-task-nav button,.dsh-task-actions button{height:32px;display:inline-flex;align-items:center;justify-content:center}\n.dsh-prompt-io button,.dsh-prompt-more,.dsh-prompt-scopes button,.dsh-prompt-modes button,.dsh-prompt-foot button{height:32px;display:inline-flex;align-items:center;justify-content:center}\n.dsh-materials-tools button,.dsh-materials-types button,.dsh-materials-foot button,.dsh-materials-table td button{height:32px;display:inline-flex;align-items:center;justify-content:center}\n.dsh-materials-new button,.dsh-materials-import-actions button,.dsh-execution-tools>button,.dsh-test-content-actions button,.dsh-rtr-btn{height:32px;display:inline-flex;align-items:center;justify-content:center}\n.dsh-task-nav select,.dsh-materials-tools select,.dsh-rtr-select{height:32px}\n.dsh-prompt-saveas input,.dsh-prompt-list input[type=search],.dsh-prompt-field input{height:36px}\n.dsh-materials-tools input[type=search],.dsh-materials-import input,.dsh-task-field input,.dsh-rtr-search{height:36px}\n.dsh-materials-table td{height:38px}\n.dsh-chat-setup svg,.dsh-task-workspace svg{width:16px;height:16px}\n.dsh-hnt-btn,.dsh-hnt-tab{height:32px}\n.dsh-hnt-input{height:36px}\n.dsh-hnt-select{height:32px}\n.dsh-mcs-btn,.dsh-mcs-iconbtn,.dsh-mcs-toolscount--btn{height:32px}\n.dsh-mcs-field input,.dsh-mcs-pairrow input,.dsh-mcs-search{height:36px}\n.dsh-mcs-field select,.dsh-mcs-seg button{height:32px}\n.dsh-sp-chip.is-btn{height:32px}\n.dsh-mg-chip{height:32px}\n/* 内联 style 插件（sec-config / skill-browse）：根容器打 data-saker-ui，\n   控件尺寸由共享层统一给，插件自己的 helper 不再写 height。 */\n[data-saker-ui] button{height:32px}\n[data-saker-ui] input:not([type=checkbox]):not([type=radio]):not([type=file]){height:36px}";
/* SAKER-UI-KIT:END */
var React = require("react");
var useState = React.useState, useEffect = React.useEffect, useRef = React.useRef;

var dshCsrf = {};
/** CSRF token 懒加载（同源 GET /csrf，跨源页面读不到）；POST 回带 x-dsh-csrf 头。 */
function csrfOf(base) {
	if (!dshCsrf[base]) dshCsrf[base] = fetch(base + "/csrf").then(function (r) { return r.json(); }).then(function (r) { return r && r.token ? r.token : ""; }).catch(function () { return ""; });
	return dshCsrf[base];
}
function postJson(tok, endpoint, payload) {
	return fetch("/dsh-hunter/" + endpoint, {
		method: "POST",
		headers: tok ? { "content-type": "application/json", "x-dsh-csrf": tok } : { "content-type": "application/json" },
		body: JSON.stringify(payload || {})
	});
}
function readApiResponse(response) {
	return response.text().then(function (text) {
		if (!text.trim()) throw new Error("资产搜索服务未就绪（HTTP " + response.status + "），请检查插件启用状态后重试。");
		var value;
		try { value = JSON.parse(text); } catch (_) { throw new Error("资产搜索服务返回异常（HTTP " + response.status + "），请检查插件运行状态。"); }
		return value;
	});
}
function api(endpoint, payload) {
	return csrfOf("/dsh-hunter").then(function (tok) {
		return postJson(tok, endpoint, payload).then(function (r) {
			if (r.status === 403) {
				delete dshCsrf["/dsh-hunter"]; // token 失效（宿主重启轮换）——重取一次再发
				return csrfOf("/dsh-hunter").then(function (tok2) { return postJson(tok2, endpoint, payload); }).then(readApiResponse);
			}
			return readApiResponse(r);
		});
	});
}

var PLATFORM_META = [
	{ id: "fofa", label: "FOFA", site: "fofa.info" },
	{ id: "hunter", label: "Hunter 奇安信", site: "hunter.qianxin.com" },
	{ id: "quake", label: "Quake 360", site: "quake.360.net" }
];
var PAGE_SIZES = [20, 50, 100];
function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function fmtTime(iso) {
	if (!iso) return "";
	var date = new Date(iso);
	return Number.isNaN(date.getTime()) ? String(iso) : date.toLocaleString("zh-CN", { hour12: false });
}

function Btn(props) {
	return React.createElement("button", {
		type: "button",
		className: "dsh-hnt-btn" + (props.primary ? " is-primary" : "") + (props.danger ? " is-danger" : "") + (props.small ? " is-small" : ""),
		disabled: !!props.disabled,
		title: props.title || "",
		onClick: props.onClick
	}, props.children);
}

function installStyles() {
	if (document.getElementById("dsh-hnt-style")) return function () {};
	// 红队四插件共享设计令牌（幂等注入，同 id 先到先得；与 results/pulse/webshell 同一份内容）
	if (!document.getElementById("dsh-rt-tokens")) {
		var tok = document.createElement("style");
		tok.id = "dsh-rt-tokens";
		tok.textContent = ".dsh-hnt-root{--rt-sev-critical:#c2182f;--rt-sev-high:#ff4d4d;--rt-sev-medium:#d9b00c;--rt-sev-low:#3b7dd8;--rt-sev-critical-bright:#ff8fa0;--rt-sev-high-bright:#ff6b8a;--rt-sev-medium-bright:#ffd43b;--rt-sev-low-bright:#4dabf7;--rt-ok:#2f9e44;--rt-dead:#c92a2a;--rt-ok-bright:#36f1b0;--rt-dead-bright:#ff8787;--rt-accent:var(--dsw-alias-state-business-primary,#4c6ef5);--rt-surface-card:var(--dsw-alias-bg-base,#fff);--rt-surface-tint:color-mix(in srgb,var(--dsw-alias-label-primary,#1a1a1a) 4%,var(--dsw-alias-bg-base,#fff));--rt-border:var(--dsw-alias-border-l1,#e9e9ec);--rt-mono:ui-monospace,\"SF Mono\",SFMono-Regular,Menlo,Consolas,monospace;--rt-navy-bg:rgba(8,24,46,.96);--rt-navy-bg-soft:rgba(12,32,62,.6);--rt-navy-line:rgba(58,157,255,.45);--rt-navy-line-soft:rgba(58,157,255,.28);--rt-navy-text:#e8f3ff;--rt-navy-text-2:#cfe6ff;--rt-navy-body:#b9d2ee;--rt-navy-dim:#7d97b8;--rt-navy-dim-2:#8fb4d9;--rt-navy-accent:#38d4ff;--rt-navy-accent-2:#3a9dff}";
		document.head.appendChild(tok);
	}
	var css = [
		".dsh-hnt-root{height:100%;display:flex;flex-direction:column;min-height:0;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);font-size:13px}",
		".dsh-hnt-head{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,#e4e4e7);flex-wrap:wrap}",
		".dsh-hnt-title{font-size:16px;font-weight:600}",
		".dsh-hnt-sub{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8f)}",
		".dsh-hnt-spacer{flex:1}",
		".dsh-hnt-body{flex:1;min-height:0;overflow:auto;padding:16px 16px;display:flex;flex-direction:column;gap:12px}",
		".dsh-hnt-btn{border:1px solid var(--dsw-alias-border-l1,#e9e9ec);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);border-radius:6px;padding:6px 12px;font-size:13px;cursor:pointer}",
		".dsh-hnt-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#f4f4f5)}",
		".dsh-hnt-btn.is-primary{background:var(--rt-accent,#4c6ef5);border-color:var(--rt-accent,#4c6ef5);color:#fff}",
		".dsh-hnt-btn.is-danger{color:var(--rt-sev-critical,#c92a2a);border-color:color-mix(in srgb,var(--rt-sev-critical,#c92a2a) 35%,transparent)}",
		".dsh-hnt-btn.is-small{padding:3px 8px;font-size:12px}",
		".dsh-hnt-btn:disabled{opacity:.45;cursor:not-allowed}",
		".dsh-hnt-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
		".dsh-hnt-input{flex:1;min-width:260px;border:1px solid var(--rt-border,#e9e9ec);border-radius:6px;padding:7px 10px;font-size:13px;background:var(--rt-surface-card,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);font-family:var(--rt-mono,monospace)}",
		".dsh-hnt-panel{border:1px solid var(--rt-border,#e9e9ec);border-radius:8px;padding:12px;margin:12px 0;background:var(--rt-surface-card,#fff)}",
		".dsh-hnt-panel h4{margin:0 0 12px;font-size:13px}",
		".dsh-hnt-field{display:flex;align-items:center;gap:12px;margin:8px 0;font-size:12px;color:var(--dsw-alias-label-secondary,#555)}",
		".dsh-hnt-field .dsh-hnt-input{min-width:180px}",
		".dsh-hnt-check{display:inline-flex;align-items:center;gap:8px;margin:4px 12px 4px 0;font-size:12px;color:var(--dsw-alias-label-secondary,#555)}",
		".dsh-hnt-sources{margin:8px 0;padding:8px 12px;border-radius:7px;background:var(--rt-surface-tint,rgba(0,0,0,.03))}",
		".dsh-hnt-select{border:1px solid var(--dsw-alias-border-l1,#e9e9ec);border-radius:6px;padding:6px 8px;font-size:13px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1a1a1a)}",
		".dsh-hnt-notice{border-radius:8px;padding:8px 12px;font-size:13px}",
		".dsh-hnt-notice.is-info{background:color-mix(in srgb,var(--rt-accent,#4c6ef5) 10%,transparent);border:1px solid color-mix(in srgb,var(--rt-accent,#4c6ef5) 35%,transparent)}",
		".dsh-hnt-notice.is-error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c92a2a) 10%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#c92a2a) 35%,transparent);color:var(--dsw-alias-state-error-primary,#c92a2a)}",
		".dsh-hnt-notice.is-success{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2b8a3e) 10%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-success-primary,#2b8a3e) 35%,transparent);color:var(--dsw-alias-state-success-primary,#2b8a3e)}",
		".dsh-hnt-table{width:100%;border-collapse:collapse;font-size:13px}",
		".dsh-hnt-table th,.dsh-hnt-table td{border-bottom:1px solid var(--dsw-alias-border-l2,#e4e4e7);padding:8px 8px;text-align:left;vertical-align:top}",
		".dsh-hnt-table th{position:sticky;top:0;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-secondary,#5b5b60);font-weight:600;font-size:12px;white-space:nowrap}",
		".dsh-hnt-table td{word-break:break-all}",
		".dsh-hnt-mono{font-family:var(--rt-mono,monospace);font-size:12px}",
		".dsh-hnt-table tbody tr:hover td{background:var(--rt-surface-tint,#f7f7f8)}",
		".dsh-hnt-pill.is-fofa{color:#3b5bdb;border-color:rgba(59,91,219,.4);background:rgba(59,91,219,.08)}",
		".dsh-hnt-pill.is-hunter{color:#d9480f;border-color:rgba(217,72,15,.4);background:rgba(217,72,15,.08)}",
		".dsh-hnt-pill.is-quake{color:#2b8a3e;border-color:rgba(43,138,62,.4);background:rgba(43,138,62,.08)}",
		".dsh-hnt-plats{display:grid;grid-template-columns:repeat(3,minmax(140px,1fr));gap:12px;width:100%;max-width:620px}",
		".dsh-hnt-plat{display:flex;flex-direction:column;gap:4px;align-items:center;border:1px solid var(--rt-border,#e9e9ec);border-radius:10px;background:var(--rt-surface-card,#fff);padding:16px 12px;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-primary,#1a1a1a);transition:border-color .15s,box-shadow .15s}",
		".dsh-hnt-plat:hover{border-color:var(--rt-accent,#4c6ef5)}",
		".dsh-hnt-plat-name{font-weight:600;font-size:13px}",
		".dsh-hnt-plat-site{font-family:var(--rt-mono,monospace);font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8f)}",
		".dsh-hnt-plat-state{font-size:12px;color:var(--rt-sev-medium,#d9b00c)}",
		".dsh-hnt-plat-state.is-ok{color:var(--rt-ok,#2f9e44)}",
		".dsh-hnt-qchip{display:inline-block;max-width:31%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:top}",
		".dsh-hnt-pill{display:inline-block;border:1px solid var(--dsw-alias-border-l1,#e9e9ec);border-radius:6px;padding:1px 8px;font-size:12px;color:var(--dsw-alias-label-secondary,#5b5b60);margin-right:4px}",
		".dsh-hnt-skel{border:1px dashed var(--dsw-alias-border-l1,#e9e9ec);border-radius:10px;padding:24px 24px;text-align:center;color:var(--dsw-alias-label-tertiary,#8a8a8f);display:flex;flex-direction:column;gap:8px;align-items:center}",
		".dsh-hnt-pager{display:flex;gap:8px;align-items:center;justify-content:flex-end;flex-wrap:wrap}",
		".dsh-hnt-modal-mask{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:200}",
		".dsh-hnt-modal{width:520px;max-width:92vw;max-height:82vh;overflow:auto;background:var(--dsw-alias-bg-base,#fff);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:12px;box-shadow:0 12px 40px rgba(0,0,0,.25)}",
		".dsh-hnt-modal h3{margin:0;font-size:16px}",
		".dsh-hnt-field{display:flex;flex-direction:column;gap:4px;font-size:12px}",
		".dsh-hnt-field label{color:var(--dsw-alias-label-secondary,#5b5b60);font-weight:600}",
		".dsh-hnt-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l2,#e4e4e7);margin-bottom:4px}",
		".dsh-hnt-tab{border:none;background:none;padding:7px 12px;font-size:13px;cursor:pointer;color:var(--dsw-alias-label-secondary,#5b5b60);border-bottom:2px solid transparent}",
		".dsh-hnt-tab.is-active{color:var(--dsw-alias-label-primary,#1a1a1a);font-weight:600;border-bottom-color:var(--rt-accent,#4c6ef5)}",
		".dsh-hnt-scope-pop{position:absolute;bottom:calc(100% + 7px);left:0;z-index:620;width:min(560px,92vw);max-height:62vh;overflow:auto;background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l1,#e9e9ec);border-radius:12px;padding:12px;box-shadow:0 12px 36px rgba(0,0,0,.18)}",
		".dsh-hnt-scope-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:8px;align-items:center;padding:8px 4px;border-bottom:1px solid var(--dsw-alias-border-l2,#f0f0f2)}",
		".dsh-hnt-scope-row:last-child{border-bottom:none}",
		".dsh-hnt-scope-value{font-family:var(--rt-mono,monospace);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
		"@media (max-width:720px){.dsh-hnt-head{flex-direction:column;align-items:flex-start}.dsh-hnt-input{min-width:100%}}"
	].join("\n");
	var style = document.createElement("style");
	style.id = "dsh-hnt-style";
	style.textContent = css;
	style.textContent += SAKER_UI_KIT_CSS;
	document.head.appendChild(style);
	return function () { style.remove(); };
}

function PlatformKeyEditor(props) {
	var [draft, setDraft] = useState({});
	var [testing, setTesting] = useState({});
	var [result, setResult] = useState({});
	function save(platform, override) {
		var key = override !== undefined ? override : (draft[platform] || "");
		api("config.set", { platform: platform, key: key }).then(function (r) {
			if (r.ok) {
				setDraft(function (p) { var n = Object.assign({}, p); n[platform] = ""; return n; });
				setResult(function (p) { var n = Object.assign({}, p); n[platform] = { ok: true, msg: key ? "已保存" : "已清除" }; return n; });
				if (props.onSaved) props.onSaved(r.config);
			}
			else setResult(function (p) { var n = Object.assign({}, p); n[platform] = { ok: false, msg: r.error }; return n; });
		});
	}
	function test(platform) {
		setTesting(function (p) { var n = Object.assign({}, p); n[platform] = true; return n; });
		var payload = { platform: platform };
		if (draft[platform]) payload.key = draft[platform];
		api("config.test", payload).then(function (r) {
			setTesting(function (p) { var n = Object.assign({}, p); n[platform] = false; return n; });
			setResult(function (p) { var n = Object.assign({}, p); n[platform] = { ok: r.ok, msg: r.ok ? r.info : r.error }; return n; });
		});
	}
	return React.createElement("div", null, PLATFORM_META.map(function (m) {
		var cfg = (props.config || {})[m.id] || { configured: false, tail: "" };
		return React.createElement("div", { key: m.id, className: "dsh-hnt-field" },
			React.createElement("label", null, m.label + "（" + m.site + "）" + (cfg.configured ? " · 已配置 " + cfg.tail : " · 未配置")),
			React.createElement("div", { className: "dsh-hnt-row" },
				React.createElement("input", { className: "dsh-hnt-input", type: "password", placeholder: cfg.configured ? "留空保持不变，输入新值覆盖" : "粘贴 API key", value: draft[m.id] || "", onChange: function (e) { setDraft(function (p) { var n = Object.assign({}, p); n[m.id] = e.target.value; return n; }); } }),
				React.createElement(Btn, { disabled: !!testing[m.id], onClick: function () { test(m.id); } }, testing[m.id] ? "校验中…" : "校验"),
				React.createElement(Btn, { primary: true, onClick: function () { save(m.id); } }, "保存"),
				React.createElement(Btn, { danger: true, disabled: !cfg.configured, onClick: function () { setDraft(function (p) { var n = Object.assign({}, p); n[m.id] = ""; return n; }); save(m.id, ""); } }, "清除")),
			result[m.id] ? React.createElement("div", { className: "dsh-hnt-notice " + (result[m.id].ok ? "is-success" : "is-error") }, result[m.id].msg) : null);
	}));
}

function SettingsModal(props) {
	return React.createElement("div", { className: "dsh-hnt-modal-mask", onClick: function () { props.onClose(); } },
		React.createElement("div", { className: "dsh-hnt-modal", onClick: function (e) { e.stopPropagation(); } },
			React.createElement("h3", null, "API 设置"),
			React.createElement("div", { className: "dsh-hnt-sub" }, "配置后「hunter 狩猎」与代码审计「实测」即可搜索资产；key 只在本机存储、仅回显末 4 位。"),
			React.createElement(PlatformKeyEditor, { config: props.config, onSaved: props.onSaved }),
			React.createElement("div", { className: "dsh-hnt-row", style: { justifyContent: "flex-end" } },
				React.createElement(Btn, { onClick: function () { props.onClose(); } }, "关闭"))));
}

function AssetPlatformsSettings() {
	var [config, setConfig] = useState(null);
	var [error, setError] = useState("");
	function reload() {
		api("config.get").then(function (r) { setConfig(r.config || {}); setError(""); })
			.catch(function (e) { setConfig({}); setError(String((e && e.message) || e)); });
	}
	useEffect(function () { reload(); }, []);
	var configured = config ? Object.values(config).filter(function (c) { return c.configured; }).length : 0;
	return React.createElement("div", { style: { maxWidth: 760 } },
		React.createElement("div", { style: { fontSize: 16, fontWeight: 700, marginBottom: 4 } }, "资产平台 API"),
		React.createElement("div", { className: "dsh-hnt-sub", style: { lineHeight:1.5, marginBottom: 12 } },
			"资产搜索：FOFA 是唯一必配 key；Hunter/Quake 可选。CISA KEV、NVD、OSV、GitHub Advisories 与公众号免费源无需在这里配置。key 只存本机 hunter.db，页面和模型侧都不回显完整值；当前平台 key 已配置 " + configured + "/3。"),
		error ? React.createElement("div", { className: "dsh-hnt-notice is-error" }, error) : null,
		React.createElement(PlatformKeyEditor, { config: config, onSaved: function (next) { setConfig(next); setError(""); } }),
		React.createElement("div", { className: "dsh-hnt-row", style: { marginTop: 12 } },
			React.createElement(Btn, { onClick: reload }, "刷新")));
}

var SEARCH_STATUS_LABEL = {
	ok: "成功",
	"no-hits": "无命中",
	"no-key": "未配置密钥",
	"field-forbidden": "字段无权限",
	"quota-exhausted": "额度用尽",
	syntax: "语法错误",
	network: "网络失败",
	auth: "密钥或账号无效",
	"rate-limited": "被限流",
	unknown: "出错"
};
var SEARCH_PURPOSES = [
	{ id: "entry", label: "补范围内入口", hint: "明确域名/地址范围、已有资产", placeholder: 'domain="example.test" port:8080' },
	{ id: "admin", label: "找后台/登录口", hint: "已知产品和具体页面/响应头/图标/FID 特征", placeholder: 'title:"管理后台" body:"login"' },
	{ id: "nday", label: "查公开漏洞部署", hint: "有来源的受影响产品与可查询特征", placeholder: 'app:"Apache" version:"2.4"' },
	{ id: "similar", label: "查同类授权资产", hint: "已核实入口提取的特征组合", placeholder: 'icon_hash="116323821"' }
];

function SearchTab(props) {
	var [query, setQuery] = useState("");
	var [mode, setMode] = useState("dsl");
	var [size, setSize] = useState(50);
	// v6 第 7.3 节：编辑器显示目的、表达式、范围、每页 50 条与本次最多 200 条的初值；
	// 用户可改上限，实际仍受平台配额限制；首轮只取一页，需要更多时用游标继续。
	var [purpose, setPurpose] = useState("entry");
	var [scope, setScope] = useState("");
	var [cap, setCap] = useState(200);
	var [fetched, setFetched] = useState(0);
	var [cursor, setCursor] = useState("");
	var [statuses, setStatuses] = useState([]);
	var [loading, setLoading] = useState(false);
	var [notice, setNotice] = useState(null);
	var [assets, setAssets] = useState([]);
	var [platformErrors, setPlatformErrors] = useState([]);
	var [queries, setQueries] = useState(null);
	// v6 第 7.3 节：queryEffective = 真正发到平台的表达式（含范围拼接），与编译后的 queries 分开显示。
	var [effectiveQueries, setEffectiveQueries] = useState([]);
	var [page, setPage] = useState(1);
	var [pageSize, setPageSize] = useState(20);
	var [authorized, setAuthorized] = useState([]);

	function refreshAuthorized() {
		api("authorized.list").then(function (r) { if (r.ok) setAuthorized(r.authorized || []); });
	}
	useEffect(function () { refreshAuthorized(); }, []);

	function doSearch(p, next) {
		var q = p ?? query;
		if (!q.trim()) { setNotice({ kind: "error", text: "请输入查询" }); return; }
		var continuing = typeof next === "string" && next !== "";
		if (!continuing && fetched >= cap) {
			setNotice({ kind: "error", text: "本次已获取 " + fetched + " 条，达到上限 " + cap + "；调大上限或改查询再继续。" });
			return;
		}
		var budget = Math.max(1, Math.min(size, cap - fetched));
		setLoading(true);
		setNotice(null);
		api("search", { query: q, mode: mode, size: budget, scope: scope, next: continuing ? next : "" }).then(function (r) {
			setLoading(false);
			setStatuses(r.platformStatuses || []);
			if (!r.ok) { setNotice({ kind: "error", text: r.error }); return; }
			var incoming = r.assets || [];
			// 续页只追加：按 ip:port 去重，不同协议/端口/路径的条目保留（后端已带来源字段）。
			setAssets(function (previous) {
				var merged = continuing ? previous.slice() : [];
				var seen = {};
				merged.forEach(function (a) { seen[(a.ip || (a.host || "").split(":")[0]) + ":" + a.port] = true; });
				incoming.forEach(function (a) {
					var key = (a.ip || (a.host || "").split(":")[0]) + ":" + a.port;
					if (!seen[key]) { seen[key] = true; merged.push(a); }
				});
				return merged;
			});
			setFetched(function (n) { return n + incoming.length; });
			setPlatformErrors(r.platformErrors || []);
			setQueries(r.queries || null);
			setEffectiveQueries(r.queryEffective || []);
			var fofa = (r.platformStatuses || []).filter(function (s) { return s.platform === "fofa"; })[0];
			setCursor(fofa && fofa.nextCursor ? fofa.nextCursor : "");
			setPage(1);
			setNotice({ kind: "info", text: (continuing ? "续页返回 " : "命中 ") + incoming.length + " 条（已按 ip:port 去重合并）" + ((r.platformErrors || []).length ? "；部分平台：" + r.platformErrors.map(function (e) { return e.platform + "=" + (SEARCH_STATUS_LABEL[e.status] || e.status || "出错"); }).join("／") : "") });
		}).catch(function (e) { setLoading(false); setNotice({ kind: "error", text: String(e && e.message ? e.message : e) }); });
	}
	function doExport(format) {
		api("export", { query: query, mode: mode, size: size, format: format }).then(function (r) {
			if (!r.ok) { setNotice({ kind: "error", text: r.error }); return; }
			var blob = new Blob([r.text], { type: (format === "json" ? "application/json" : "text/csv") + ";charset=utf-8" });
			var url = URL.createObjectURL(blob);
			var a = document.createElement("a");
			a.href = url; a.download = "hunter-export-" + new Date().toISOString().slice(0, 10) + "." + format;
			document.body.appendChild(a); a.click(); a.remove();
			setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
			setNotice({ kind: "success", text: "已导出 " + format.toUpperCase() + "（受平台免费额度上限约束）" });
		});
	}
	function markAuthorized(asset, remove) {
		var key = (asset.ip || (asset.host || "").split(":")[0]) + ":" + asset.port;
		api(remove ? "authorized.remove" : "authorized.add", remove ? { key: key } : { ip: asset.ip || (asset.host || "").split(":")[0], port: asset.port, note: asset.title || "" }).then(function (r) {
			if (r.ok) { setAuthorized(r.authorized || []); setNotice({ kind: "success", text: remove ? "已取消授权标记" : "已标记授权（L1 验证只对这些资产执行）" }); }
		});
	}

	var noKey = props.config && !Object.values(props.config).some(function (c) { return c.configured; });
	var anyConfigured = !!(props.config && Object.values(props.config).some(function (c) { return c.configured; }));
	var activePurpose = SEARCH_PURPOSES.filter(function (item) { return item.id === purpose; })[0] || SEARCH_PURPOSES[0];
	var platformTotals = statuses.filter(function (s) { return s.total !== null && s.total !== undefined; });
	var totalPages = Math.max(1, Math.ceil(assets.length / pageSize));
	var pageRows = assets.slice((page - 1) * pageSize, page * pageSize);

	if (noKey) {
		return React.createElement("div", { className: "dsh-hnt-body" },
			React.createElement("div", { className: "dsh-hnt-row" },
				React.createElement("input", { className: "dsh-hnt-input", placeholder: "统一 DSL 查询，如 title:\"login\" body:\"xxl-job\" port:8080", value: query, disabled: true, onChange: function () {} }),
				React.createElement(Btn, { disabled: true }, "搜索")),
			React.createElement("div", { className: "dsh-hnt-skel" },
				React.createElement("div", null, "数据骨架已就绪——配置任一平台 API 后开始狩猎"),
				React.createElement("div", { className: "dsh-hnt-plats" }, PLATFORM_META.map(function (m) {
					var cfg = (props.config || {})[m.id] || { configured: false, tail: "" };
					return React.createElement("button", { key: m.id, type: "button", className: "dsh-hnt-plat", title: "点击配置 " + m.label + " API", onClick: function () { props.onOpenSettings(); } },
						React.createElement("span", { className: "dsh-hnt-plat-name" }, m.label),
						React.createElement("span", { className: "dsh-hnt-plat-site" }, m.site),
						React.createElement("span", { className: "dsh-hnt-plat-state" + (cfg.configured ? " is-ok" : "") }, cfg.configured ? "已配置 · " + cfg.tail : "未配置"));
				})),
				React.createElement("div", { className: "dsh-hnt-sub" }, "多平台配置后，统一 DSL 查询自动转换为各平台语法"),
				React.createElement(Btn, { primary: true, onClick: function () { props.onOpenSettings(); } }, "配置 API")));
	}

	return React.createElement("div", { className: "dsh-hnt-body" },
		React.createElement("div", { className: "dsh-hnt-row" },
			React.createElement("select", { className: "dsh-hnt-select", "aria-label": "查询目的", value: purpose, onChange: function (e) { setPurpose(e.target.value); } },
				SEARCH_PURPOSES.map(function (item) { return React.createElement("option", { key: item.id, value: item.id }, item.label); })),
			React.createElement("span", { className: "dsh-hnt-sub" }, activePurpose.hint),
			React.createElement("input", { className: "dsh-hnt-input", "aria-label": "授权范围", placeholder: "范围（可选）：例如 domain=\"example.test\"；附加时按括号组合，不改原 AND/OR 语义", value: scope, onChange: function (e) { setScope(e.target.value); } }),
			React.createElement("select", { className: "dsh-hnt-select", "aria-label": "每页条数", value: size, onChange: function (e) { setSize(Number(e.target.value)); } },
				[50, 20, 100, 200].map(function (n) { return React.createElement("option", { key: n, value: n }, "每页 " + n + " 条"); })),
			React.createElement("select", { className: "dsh-hnt-select", "aria-label": "本次最多获取", value: cap, onChange: function (e) { setCap(Number(e.target.value)); } },
				[200, 100, 400, 1000].map(function (n) { return React.createElement("option", { key: n, value: n }, "本次最多 " + n + " 条"); }))),
		React.createElement("div", { className: "dsh-hnt-row" },
			React.createElement("input", { className: "dsh-hnt-input", placeholder: mode === "dsl" ? "统一 DSL，例如 " + activePurpose.placeholder + "（空格=AND）" : "平台原生语法（将原样发送到各平台）", value: query, onChange: function (e) { setQuery(e.target.value); }, onKeyDown: function (e) { if (e.key === "Enter") doSearch(); } }),
			React.createElement("select", { className: "dsh-hnt-select", value: mode, onChange: function (e) { setMode(e.target.value); } },
				React.createElement("option", { value: "dsl" }, "统一 DSL"),
				React.createElement("option", { value: "native" }, "高级·平台原生")),
			React.createElement(Btn, { primary: true, disabled: loading, onClick: function () { doSearch(); } }, loading ? "搜索中…" : "搜索"),
			React.createElement(Btn, { disabled: loading || assets.length === 0, onClick: function () { doExport("csv"); } }, "导出 CSV"),
			React.createElement(Btn, { disabled: loading || assets.length === 0, onClick: function () { doExport("json"); } }, "导出 JSON"),
			cursor && fetched < cap ? React.createElement(Btn, { small: true, disabled: loading, onClick: function () { doSearch(undefined, cursor); } }, "继续翻页（FOFA）") : null),
		React.createElement("div", { className: "dsh-hnt-row" },
			React.createElement("span", { className: "dsh-hnt-sub" }, "已获取 " + fetched + " / 上限 " + cap + " 条"),
			React.createElement("span", { className: "dsh-hnt-sub" }, platformTotals.length
				? "平台报告总数：" + platformTotals.map(function (s) { return s.platform.toUpperCase() + " " + s.total; }).join("／")
				: "平台报告总数：未知"),
			statuses.map(function (s) {
				return React.createElement("span", { key: s.platform, className: "dsh-hnt-pill is-" + s.platform, title: s.error || "" },
					s.platform.toUpperCase() + " " + (SEARCH_STATUS_LABEL[s.status] || s.status) + (s.rows ? " · " + s.rows + " 条" : ""));
			})),
		queries ? React.createElement("div", { className: "dsh-hnt-row" },
			["fofa", "hunter", "quake"].map(function (p) {
				return React.createElement("span", { key: p, className: "dsh-hnt-pill is-" + p + " dsh-hnt-qchip dsh-hnt-mono", title: p.toUpperCase() + " 语法：" + queries[p] }, p.toUpperCase() + " " + queries[p]);
			})) : null,
		// 附加范围后，实际发到平台的表达式与编译稿不同；只有真的填了范围才显示，避免和上面重复。
		queries && scope.trim() && effectiveQueries.filter(function (q) { return q.query; }).length ? React.createElement("div", { className: "dsh-hnt-row" },
			React.createElement("span", { className: "dsh-hnt-sub" }, "实际发送（含范围）"),
			effectiveQueries.filter(function (q) { return q.query; }).map(function (q) {
				return React.createElement("span", { key: "eff-" + q.platform, className: "dsh-hnt-pill dsh-hnt-qchip dsh-hnt-mono", title: q.platform.toUpperCase() + " 实际发送：" + q.query }, q.platform.toUpperCase() + " " + q.query);
			})) : null,
		notice ? React.createElement("div", { className: "dsh-hnt-notice is-" + notice.kind }, notice.text) : null,
		assets.length === 0 && !loading ? React.createElement("div", { className: "dsh-hnt-skel" }, React.createElement("div", null,
			anyConfigured ? "查询后结果展示在这里——首轮只取一页，需要更多用「继续翻页（FOFA）」，不谎报全量" : "查询后结果展示在这里——配置任一平台 API 后开始")) : null,
		assets.length > 0 ? React.createElement("table", { className: "dsh-hnt-table" },
			React.createElement("thead", null, React.createElement("tr", null,
				["host", "ip", "port", "协议", "标题", "server", "来源", "更新时间", "操作"].map(function (h) { return React.createElement("th", { key: h }, h); }))),
			React.createElement("tbody", null, pageRows.map(function (a) {
				var key = (a.ip || (a.host || "").split(":")[0]) + ":" + a.port;
				var isAuth = authorized.some(function (x) { return x.key === key; });
				return React.createElement("tr", { key: key },
					React.createElement("td", { className: "dsh-hnt-mono" }, a.host || "—"),
					React.createElement("td", { className: "dsh-hnt-mono" }, a.ip || "—"),
					React.createElement("td", { className: "dsh-hnt-mono" }, a.port || "—"),
					React.createElement("td", null, a.protocol || "—"),
					React.createElement("td", null, (a.title || "").slice(0, 60) || "—"),
					React.createElement("td", null, (a.server || "").slice(0, 40) || "—"),
					React.createElement("td", null, (a.platforms || [a.platform]).map(function (p) { return React.createElement("span", { key: p, className: "dsh-hnt-pill is-" + p }, p); })),
					React.createElement("td", { className: "dsh-hnt-mono" }, fmtTime(a.time) || "—"),
					React.createElement("td", null,
						React.createElement(Btn, { small: true, primary: !isAuth, danger: isAuth, onClick: function () { markAuthorized(a, isAuth); } }, isAuth ? "取消授权" : "标记授权")));
			}))) : null,
		assets.length > 0 ? React.createElement("div", { className: "dsh-hnt-pager" },
			React.createElement("select", { className: "dsh-hnt-select", value: pageSize, onChange: function (e) { setPageSize(Number(e.target.value)); setPage(1); } },
				PAGE_SIZES.map(function (n) { return React.createElement("option", { key: n, value: n }, "每页 " + n); })),
			React.createElement(Btn, { small: true, disabled: page <= 1, onClick: function () { setPage(page - 1); } }, "上一页"),
			React.createElement("span", { className: "dsh-hnt-sub" }, page + " / " + totalPages + "（共 " + assets.length + " 条）"),
			React.createElement(Btn, { small: true, disabled: page >= totalPages, onClick: function () { setPage(page + 1); } }, "下一页")) : null);
}

function HistoryTab(props) {
	var [history, setHistory] = useState([]);
	useEffect(function () {
		api("history.list", { limit: 50 }).then(function (r) { if (r.ok) setHistory(r.history || []); });
	}, []);
	return React.createElement("div", { className: "dsh-hnt-body" },
		history.length === 0 ? React.createElement("div", { className: "dsh-hnt-skel" }, React.createElement("div", null, "暂无实测记录——从「redteam 成果」页 code-audit finding 点「实测」后这里可审计每次验证")) : null,
		React.createElement("table", { className: "dsh-hnt-table" },
			React.createElement("thead", null, React.createElement("tr", null,
				["时间", "finding", "查询", "平台", "结论", "细节"].map(function (h) { return React.createElement("th", { key: h }, h); }))),
			React.createElement("tbody", null, history.map(function (h) {
				var d = {};
				try { d = JSON.parse(h.details || "{}"); } catch { /* 旧记录 */ }
				return React.createElement("tr", { key: h.id },
					React.createElement("td", { className: "dsh-hnt-mono" }, fmtTime(h.created_at)),
					React.createElement("td", { className: "dsh-hnt-mono" }, h.finding_id),
					React.createElement("td", { className: "dsh-hnt-mono" }, h.query),
					React.createElement("td", null, h.platforms),
					React.createElement("td", null, React.createElement("span", { className: "dsh-hnt-pill" }, h.verdict)),
					React.createElement("td", null, (d.summary || "").slice(0, 160)));
			}))));
}

function AuthorizedTab(props) {
	var [authorized, setAuthorized] = useState([]);
	function load() { api("authorized.list").then(function (r) { if (r.ok) setAuthorized(r.authorized || []); }); }
	useEffect(load, []);
	return React.createElement("div", { className: "dsh-hnt-body" },
		React.createElement("div", { className: "dsh-hnt-sub" }, "授权白名单：实测流水线的 L1 最小影响验证只对这些资产执行"),
		authorized.length === 0 ? React.createElement("div", { className: "dsh-hnt-skel" }, React.createElement("div", null, "暂无授权资产——在搜索结果的资产行点「标记授权」")) : null,
		React.createElement("table", { className: "dsh-hnt-table" },
			React.createElement("thead", null, React.createElement("tr", null, ["资产", "备注", "标记时间", "操作"].map(function (h) { return React.createElement("th", { key: h }, h); }))),
			React.createElement("tbody", null, authorized.map(function (a) {
				return React.createElement("tr", { key: a.key },
					React.createElement("td", { className: "dsh-hnt-mono" }, a.key),
					React.createElement("td", null, a.note || "—"),
					React.createElement("td", { className: "dsh-hnt-mono" }, fmtTime(a.created_at)),
					React.createElement("td", null, React.createElement(Btn, { small: true, danger: true, onClick: function () { api("authorized.remove", { key: a.key }).then(load); } }, "移除")));
			}))));
}

function HunterView() {
	var [config, setConfig] = useState(null);
	var [showSettings, setShowSettings] = useState(false);
	var [tab, setTab] = useState("search");
	function loadConfig() {
		api("config.get").then(function (r) { setConfig(r.config || {}); }).catch(function () { setConfig({}); });
	}
	useEffect(function () { loadConfig(); }, []);
	var configuredCount = config ? Object.values(config).filter(function (c) { return c.configured; }).length : 0;
	return React.createElement("div", { className: "dsh-hnt-root" },
		React.createElement("div", { className: "dsh-hnt-head" },
			React.createElement("span", { className: "dsh-hnt-title" }, "hunter 狩猎"),
			React.createElement("span", { className: "dsh-hnt-sub" }, configuredCount + "/3 平台已配置"),
			React.createElement("span", { className: "dsh-hnt-sub" }, "FOFA · Hunter · Quake 资产聚合"),
			React.createElement("span", { className: "dsh-hnt-spacer" }),
			React.createElement("div", { className: "dsh-hnt-tabs" },
				React.createElement("button", { className: "dsh-hnt-tab" + (tab === "search" ? " is-active" : ""), onClick: function () { setTab("search"); } }, "搜索"),
				React.createElement("button", { className: "dsh-hnt-tab" + (tab === "history" ? " is-active" : ""), onClick: function () { setTab("history"); } }, "实测历史"),
				React.createElement("button", { className: "dsh-hnt-tab" + (tab === "authorized" ? " is-active" : ""), onClick: function () { setTab("authorized"); } }, "授权资产")),
			React.createElement(Btn, { primary: true, onClick: function () { setShowSettings(true); } }, "设置")),
		tab === "search" ? React.createElement(SearchTab, { config: config, onOpenSettings: function () { setShowSettings(true); } })
			: tab === "history" ? React.createElement(HistoryTab, null)
				: React.createElement(AuthorizedTab, null),
		showSettings ? React.createElement(SettingsModal, { config: config, onClose: function () { setShowSettings(false); loadConfig(); }, onSaved: setConfig }) : null);
}

function apply(ctx) {
	ctx.effect(function () { return installStyles(); }, "dsh-hunter: styles");
	// v6 第 7.3 节：查询编辑器原来没有宿主入口（HunterView 定义了但没人挂）。
	// 挂到宿主设置页的「资产搜索」分区（与「资产平台 API」相邻）——设置页是宿主已有导航，
	// 不新建第二套导航；也不能占用 conversation.view（product-pruning 门禁明确禁止把 hunter
	// 再做成一个聊天页签）。
	ctx.slots.inject("settings.section", function () {
		return ctx.slots.register({
			name: "settings.section",
			id: "hunter-search",
			order: 138,
			label: function () { return "资产搜索"; }
		}, function () { return React.createElement(HunterView, null); });
	});
	ctx.slots.inject("settings.section", function () {
		return ctx.slots.register({
			name: "settings.section",
			id: "hunter-api-platforms",
			order: 137,
			label: function () { return "资产平台 API"; }
		}, function () { return React.createElement(AssetPlatformsSettings, null); });
	});
}

module.exports = { name: "dsh-hunter-client", inject: ["slots", "configForms", "sessions", "conversation"], apply: apply };
return module.exports; } });
