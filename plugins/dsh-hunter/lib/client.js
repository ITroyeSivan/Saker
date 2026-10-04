window.__ModuleLoader__.load({ id: "@dsh-external/dsh-hunter", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
// dsh-hunter client — 会话标签页「hunter 狩猎」（与 redteam 成果并排）：
// 三平台资产搜索（统一 DSL / 高级原生）、设置面板（API key）、分页、导出、授权标记、实测历史。
"use strict";
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
function api(endpoint, payload) {
	return csrfOf("/dsh-hunter").then(function (tok) {
		return postJson(tok, endpoint, payload).then(function (r) {
			if (r.status === 403) {
				delete dshCsrf["/dsh-hunter"]; // token 失效（宿主重启轮换）——重取一次再发
				return csrfOf("/dsh-hunter").then(function (tok2) { return postJson(tok2, endpoint, payload); }).then(function (r2) { return r2.json(); });
			}
			return r.json();
		});
	});
}

var PLATFORM_META = [
	{ id: "fofa", label: "FOFA", site: "fofa.info" },
	{ id: "hunter", label: "Hunter 奇安信", site: "hunter.qianxin.com" },
	{ id: "quake", label: "Quake 360", site: "quake.360.net" }
];
var PAGE_SIZES = [20, 50, 100];
var NDAY_FREE_SOURCES = [
	{ id: "cisa-kev", label: "CISA KEV" },
	{ id: "cve-official", label: "CVE 官方滚动增量" },
	{ id: "cve-official-git", label: "CVE 全量基线 / Git 差异" },
	{ id: "github-research-files", label: "研究项目文件差异" },
	{ id: "nuclei-files", label: "Nuclei 模板文件差异" },
	{ id: "afrog-files", label: "Afrog 公开 PoC 文件差异" },
	{ id: "nvd", label: "NVD" },
	{ id: "osv", label: "OSV" },
	{ id: "github-advisories", label: "GitHub Advisories" },
	{ id: "nuclei", label: "nuclei 模板更新" },
	{ id: "wechat", label: "微信公众号（需检索词）" }
];

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
		tok.textContent = "body{--rt-sev-critical:#c2182f;--rt-sev-high:#ff4d4d;--rt-sev-medium:#d9b00c;--rt-sev-low:#3b7dd8;--rt-sev-critical-bright:#ff8fa0;--rt-sev-high-bright:#ff6b8a;--rt-sev-medium-bright:#ffd43b;--rt-sev-low-bright:#4dabf7;--rt-ok:#2f9e44;--rt-dead:#c92a2a;--rt-ok-bright:#36f1b0;--rt-dead-bright:#ff8787;--rt-accent:var(--dsw-alias-state-business-primary,#4c6ef5);--rt-surface-card:var(--dsw-alias-bg-base,#fff);--rt-surface-tint:color-mix(in srgb,var(--dsw-alias-label-primary,#1a1a1a) 4%,var(--dsw-alias-bg-base,#fff));--rt-border:var(--dsw-alias-border-l1,#e9e9ec);--rt-mono:ui-monospace,\"SF Mono\",SFMono-Regular,Menlo,Consolas,monospace;--rt-navy-bg:rgba(8,24,46,.96);--rt-navy-bg-soft:rgba(12,32,62,.6);--rt-navy-line:rgba(58,157,255,.45);--rt-navy-line-soft:rgba(58,157,255,.28);--rt-navy-text:#e8f3ff;--rt-navy-text-2:#cfe6ff;--rt-navy-body:#b9d2ee;--rt-navy-dim:#7d97b8;--rt-navy-dim-2:#8fb4d9;--rt-navy-accent:#38d4ff;--rt-navy-accent-2:#3a9dff}";
		document.head.appendChild(tok);
	}
	var css = [
		".dsh-hnt-root{height:100%;display:flex;flex-direction:column;min-height:0;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);font-size:13px}",
		".dsh-hnt-head{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l2,#e4e4e7);flex-wrap:wrap}",
		".dsh-hnt-title{font-size:15px;font-weight:600}",
		".dsh-hnt-sub{font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8a8f)}",
		".dsh-hnt-spacer{flex:1}",
		".dsh-hnt-body{flex:1;min-height:0;overflow:auto;padding:14px 16px;display:flex;flex-direction:column;gap:12px}",
		".dsh-hnt-btn{border:1px solid var(--dsw-alias-border-l1,#e9e9ec);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);border-radius:7px;padding:6px 12px;font-size:12.5px;cursor:pointer}",
		".dsh-hnt-btn:hover{background:var(--dsw-alias-interactive-bg-hover,#f4f4f5)}",
		".dsh-hnt-btn.is-primary{background:var(--rt-accent,#4c6ef5);border-color:var(--rt-accent,#4c6ef5);color:#fff}",
		".dsh-hnt-btn.is-danger{color:var(--rt-sev-critical,#c92a2a);border-color:color-mix(in srgb,var(--rt-sev-critical,#c92a2a) 35%,transparent)}",
		".dsh-hnt-btn.is-small{padding:3px 8px;font-size:12px}",
		".dsh-hnt-btn:disabled{opacity:.45;cursor:not-allowed}",
		".dsh-hnt-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
		".dsh-hnt-input{flex:1;min-width:260px;border:1px solid var(--rt-border,#e9e9ec);border-radius:7px;padding:7px 10px;font-size:13px;background:var(--rt-surface-card,#fff);color:var(--dsw-alias-label-primary,#1a1a1a);font-family:var(--rt-mono,monospace)}",
		".dsh-hnt-panel{border:1px solid var(--rt-border,#e9e9ec);border-radius:8px;padding:12px;margin:10px 0;background:var(--rt-surface-card,#fff)}",
		".dsh-hnt-panel h4{margin:0 0 10px;font-size:13px}",
		".dsh-hnt-field{display:flex;align-items:center;gap:10px;margin:7px 0;font-size:12px;color:var(--dsw-alias-label-secondary,#555)}",
		".dsh-hnt-field .dsh-hnt-input{min-width:180px}",
		".dsh-hnt-check{display:inline-flex;align-items:center;gap:6px;margin:4px 12px 4px 0;font-size:12px;color:var(--dsw-alias-label-secondary,#555)}",
		".dsh-hnt-sources{margin:8px 0;padding:8px 10px;border-radius:7px;background:var(--rt-surface-tint,rgba(0,0,0,.03))}",
		".dsh-hnt-select{border:1px solid var(--dsw-alias-border-l1,#e9e9ec);border-radius:7px;padding:6px 8px;font-size:12.5px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1a1a1a)}",
		".dsh-hnt-notice{border-radius:8px;padding:9px 12px;font-size:12.5px}",
		".dsh-hnt-notice.is-info{background:color-mix(in srgb,var(--rt-accent,#4c6ef5) 10%,transparent);border:1px solid color-mix(in srgb,var(--rt-accent,#4c6ef5) 35%,transparent)}",
		".dsh-hnt-notice.is-error{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#c92a2a) 10%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#c92a2a) 35%,transparent);color:var(--dsw-alias-state-error-primary,#c92a2a)}",
		".dsh-hnt-notice.is-success{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2b8a3e) 10%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-success-primary,#2b8a3e) 35%,transparent);color:var(--dsw-alias-state-success-primary,#2b8a3e)}",
		".dsh-hnt-table{width:100%;border-collapse:collapse;font-size:12.5px}",
		".dsh-hnt-table th,.dsh-hnt-table td{border-bottom:1px solid var(--dsw-alias-border-l2,#e4e4e7);padding:7px 8px;text-align:left;vertical-align:top}",
		".dsh-hnt-table th{position:sticky;top:0;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-secondary,#5b5b60);font-weight:600;font-size:12px;white-space:nowrap}",
		".dsh-hnt-table td{word-break:break-all}",
		".dsh-hnt-mono{font-family:var(--rt-mono,monospace);font-size:12px}",
		".dsh-hnt-table tbody tr:hover td{background:var(--rt-surface-tint,#f7f7f8)}",
		".dsh-hnt-pill.is-fofa{color:#3b5bdb;border-color:rgba(59,91,219,.4);background:rgba(59,91,219,.08)}",
		".dsh-hnt-pill.is-hunter{color:#d9480f;border-color:rgba(217,72,15,.4);background:rgba(217,72,15,.08)}",
		".dsh-hnt-pill.is-quake{color:#2b8a3e;border-color:rgba(43,138,62,.4);background:rgba(43,138,62,.08)}",
		".dsh-hnt-plats{display:grid;grid-template-columns:repeat(3,minmax(140px,1fr));gap:10px;width:100%;max-width:620px}",
		".dsh-hnt-plat{display:flex;flex-direction:column;gap:3px;align-items:center;border:1px solid var(--rt-border,#e9e9ec);border-radius:10px;background:var(--rt-surface-card,#fff);padding:14px 10px;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-primary,#1a1a1a);transition:border-color .15s,box-shadow .15s}",
		".dsh-hnt-plat:hover{border-color:var(--rt-accent,#4c6ef5);box-shadow:0 4px 14px rgba(9,20,40,.08)}",
		".dsh-hnt-plat-name{font-weight:600;font-size:13px}",
		".dsh-hnt-plat-site{font-family:var(--rt-mono,monospace);font-size:10.5px;color:var(--dsw-alias-label-tertiary,#8a8a8f)}",
		".dsh-hnt-plat-state{font-size:11px;color:var(--rt-sev-medium,#d9b00c)}",
		".dsh-hnt-plat-state.is-ok{color:var(--rt-ok,#2f9e44)}",
		".dsh-hnt-qchip{display:inline-block;max-width:31%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:top}",
		".dsh-hnt-pill{display:inline-block;border:1px solid var(--dsw-alias-border-l1,#e9e9ec);border-radius:10px;padding:1px 8px;font-size:11px;color:var(--dsw-alias-label-secondary,#5b5b60);margin-right:4px}",
		".dsh-hnt-skel{border:1px dashed var(--dsw-alias-border-l1,#e9e9ec);border-radius:10px;padding:36px 20px;text-align:center;color:var(--dsw-alias-label-tertiary,#8a8a8f);display:flex;flex-direction:column;gap:8px;align-items:center}",
		".dsh-hnt-pager{display:flex;gap:8px;align-items:center;justify-content:flex-end;flex-wrap:wrap}",
		".dsh-hnt-modal-mask{position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;z-index:200}",
		".dsh-hnt-modal{width:520px;max-width:92vw;max-height:82vh;overflow:auto;background:var(--dsw-alias-bg-base,#fff);border-radius:12px;padding:18px;display:flex;flex-direction:column;gap:12px;box-shadow:0 12px 40px rgba(0,0,0,.25)}",
		".dsh-hnt-modal h3{margin:0;font-size:15px}",
		".dsh-hnt-field{display:flex;flex-direction:column;gap:4px;font-size:12px}",
		".dsh-hnt-field label{color:var(--dsw-alias-label-secondary,#5b5b60);font-weight:600}",
		".dsh-hnt-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l2,#e4e4e7);margin-bottom:4px}",
		".dsh-hnt-tab{border:none;background:none;padding:7px 12px;font-size:13px;cursor:pointer;color:var(--dsw-alias-label-secondary,#5b5b60);border-bottom:2px solid transparent}",
		".dsh-hnt-tab.is-active{color:var(--dsw-alias-label-primary,#1a1a1a);font-weight:600;border-bottom-color:var(--rt-accent,#4c6ef5)}",
		".dsh-hnt-scope-pop{position:absolute;bottom:calc(100% + 7px);left:0;z-index:620;width:min(560px,92vw);max-height:62vh;overflow:auto;background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l1,#e9e9ec);border-radius:10px;padding:10px;box-shadow:0 12px 36px rgba(0,0,0,.18)}",
		".dsh-hnt-scope-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:8px;align-items:center;padding:6px 4px;border-bottom:1px solid var(--dsw-alias-border-l2,#f0f0f2)}",
		".dsh-hnt-scope-row:last-child{border-bottom:none}",
		".dsh-hnt-scope-value{font-family:var(--rt-mono,monospace);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
		"@media (max-width:720px){.dsh-hnt-head{flex-direction:column;align-items:flex-start}.dsh-hnt-input{min-width:100%}}"
	].join("\n");
	var style = document.createElement("style");
	style.id = "dsh-hnt-style";
	style.textContent = css;
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
		React.createElement("div", { style: { fontSize: 15, fontWeight: 700, marginBottom: 2 } }, "资产平台 API"),
		React.createElement("div", { className: "dsh-hnt-sub", style: { lineHeight: 1.7, marginBottom: 12 } },
			"资产搜索：FOFA 是唯一必配 key；Hunter/Quake 可选。CISA KEV、NVD、OSV、GitHub Advisories 与公众号免费源无需在这里配置。key 只存本机 hunter.db，页面和模型侧都不回显完整值；当前平台 key 已配置 " + configured + "/3。"),
		error ? React.createElement("div", { className: "dsh-hnt-notice is-error" }, error) : null,
		React.createElement(PlatformKeyEditor, { config: config, onSaved: function (next) { setConfig(next); setError(""); } }),
		React.createElement("div", { className: "dsh-hnt-row", style: { marginTop: 10 } },
			React.createElement(Btn, { onClick: reload }, "刷新")));
}

function SourceLibrary() {
	var [query, setQuery] = useState("");
	var [result, setResult] = useState(null);
	var [content, setContent] = useState(null);
	var [notice, setNotice] = useState("");
	var [busy, setBusy] = useState(false);
	var request = useRef(0);
	function load(endpoint, payload, receive) {
		var sequence = ++request.current; setBusy(true); setNotice("");
		api(endpoint, payload).then(function (value) {
			if (sequence !== request.current) return;
			setBusy(false);
			if (!value.ok) { setNotice(String((value.error && value.error.message) || value.error || "读取失败")); return; }
			receive(value);
		}).catch(function (error) { if (sequence === request.current) { setBusy(false); setNotice(String(error.message || error)); } });
	}
	function search(cursor) {
		setContent(null);
		load("nday.sources.query", { query: query, limit: 20, cursor: cursor || null }, setResult);
	}
	function original(row, offset) {
		if (!offset) setContent(null);
		load("nday.sources.content", { source: row.source, id: row.id, revision: row.revision, offset: offset || 0 }, function (value) { setContent(Object.assign({}, value.content, { title: row.title })); });
	}
	function displayTitle(row) {
		if (String(row.id).indexOf("file:") === 0) return String(row.title || "来源资料").split("/").pop().replace(/\.(?:yaml|yml|md|txt|json)$/i, "");
		return row.title && row.title !== row.id ? row.id + " · " + row.title : row.id;
	}
	return React.createElement("details", { className: "dsh-hnt-panel", "aria-label": "本地来源资料" },
		React.createElement("summary", null, "本地资料检索"),
		React.createElement("div", { className: "dsh-hnt-row", style: { marginTop: 10 } },
			React.createElement("input", { className: "dsh-hnt-input", "aria-label": "本地资料关键词", placeholder: "产品、组件或 CVE 编号", value: query, disabled: busy, maxLength: 300,
				onChange: function (event) { setQuery(event.target.value); setResult(null); setContent(null); },
				onKeyDown: function (event) { if (event.key === "Enter" && !busy) search(null); } }),
			React.createElement(Btn, { disabled: busy, onClick: function () { search(null); } }, busy ? "读取中…" : "检索本地资料")),
		notice ? React.createElement("div", { role: "alert", className: "dsh-hnt-notice is-error" }, notice) : null,
		result ? React.createElement("div", null,
			React.createElement("div", { className: "dsh-hnt-sub" }, "找到 " + result.total + " 条，当前显示 " + result.rows.length + " 条"),
			React.createElement("div", { style: { maxHeight: 360, overflowY: "auto", marginBottom: 8 } }, result.rows.map(function (row) {
				var known = NDAY_FREE_SOURCES.find(function (source) { return source.id === row.source; });
				return React.createElement("div", { key: row.dedupKey, style: { marginTop: 10 } },
				React.createElement("div", null, displayTitle(row)),
				React.createElement("div", { className: "dsh-hnt-sub" }, (known ? known.label : row.source) + " · " + (row.published ? row.published.slice(0, 10) : "披露时间未知") + (row.requiresSourceReview ? " · 需要回源复核" : "")),
				React.createElement(Btn, { disabled: busy, onClick: function () { original(row, 0); } }, "查看来源原文")); })),
			result.nextCursor ? React.createElement(Btn, { disabled: busy, onClick: function () { search(result.nextCursor); } }, "下一页资料") : null) : null,
		content ? React.createElement("div", { "aria-label": "来源原文", style: { marginTop: 12 } },
			React.createElement("div", { className: "dsh-hnt-sub" }, displayTitle(content) + (content.representation === "serialized-api-json" ? " · 公告 JSON" : "") + " · 原文片段 " + content.offset + "–" + (content.offset + content.text.length)),
			React.createElement("pre", { style: { whiteSpace: "pre-wrap", maxHeight: 300, overflow: "auto" } }, content.text),
			content.nextOffset !== null ? React.createElement(Btn, { disabled: busy, onClick: function () { original(content, content.nextOffset); } }, "继续读取原文") : null) : null);
}

function NdayPolicySettings() {
	var [data, setData] = useState(null);
	var [notice, setNotice] = useState(null);
	var [busy, setBusy] = useState(false);
	var alive = useRef(true);
	function errorText(error) { return String((error && error.message) || error || "操作失败"); }
	function reload() {
		return api("nday.config.get").then(function (r) {
			if (!alive.current) return;
			if (!r.ok) throw new Error(errorText(r.error));
			setData(r);
		}).catch(function (e) { if (alive.current) setNotice({ kind: "error", text: errorText(e) }); });
	}
	function refreshStatus() {
		return api("nday.collector.status").then(function (r) {
			if (!alive.current) return;
			if (!r.ok) throw new Error(errorText(r.error));
			setData(function (prev) { return Object.assign({}, prev, { status: r.status, job: r.job }); });
		}).catch(function (e) { if (alive.current) setNotice({ kind: "error", text: errorText(e) }); });
	}
	useEffect(function () { alive.current = true; reload(); return function () { alive.current = false; }; }, []);
	var running = !!(data && ((data.job && data.job.running) || (data.status && data.status.running)));
	useEffect(function () {
		if (!running) return;
		var cancelled = false, timer;
		function poll() { timer = setTimeout(function () { refreshStatus().finally(function () { if (!cancelled) poll(); }); }, 2500); }
		poll(); return function () { cancelled = true; clearTimeout(timer); };
	}, [running]);
	function patch(section, key, value) {
		setData(function (prev) { var next = Object.assign({}, prev); next[section] = Object.assign({}, prev[section]); next[section][key] = value; return next; });
	}
	function toggleSource(id) {
		var selected = (data.collector.sources || []).slice();
		var index = selected.indexOf(id);
		if (index < 0) selected.push(id); else selected.splice(index, 1);
		patch("collector", "sources", selected);
	}
	function save() {
		setBusy(true); setNotice(null);
		return api("nday.config.set", { policy: data.policy, collector: data.collector }).then(function (r) {
			if (!r.ok) throw new Error(errorText(r.error));
			if (alive.current) { setData(function (prev) { return Object.assign({}, prev, { policy: r.policy, collector: r.collector }); }); setNotice({ kind: "success", text: "已保存" }); }
		}).catch(function (e) { if (alive.current) setNotice({ kind: "error", text: errorText(e) }); }).finally(function () { if (alive.current) setBusy(false); });
	}
	function update(source) {
		setBusy(true); setNotice(null);
		return api("nday.collector.start", { collector: data.collector, source: source || null }).then(function (r) {
			if (!r.ok) throw new Error(errorText(r.error));
			if (alive.current) { setData(function (prev) { return Object.assign({}, prev, { job: r.job }); }); setNotice({ kind: "success", text: "更新已启动，可以离开此页。部分完成时再次点击更新即可续传。" }); }
		}).catch(function (e) { if (alive.current) setNotice({ kind: "error", text: errorText(e) }); }).finally(function () { if (alive.current) setBusy(false); });
	}
	if (!data) return React.createElement("div", { role: "status" }, notice ? notice.text : "加载情报源…", React.createElement(Btn, { onClick: reload }, "重试"));
	var collector = data.collector || {}, policy = data.policy || {}, status = data.status || {};
	var disabled = busy || running;
	var states = { complete: "本轮完成", partial: "部分完成，点击更新可续传", "partial-failed": "中途失败，点击更新可重试", failed: "更新失败", backoff: "等待重试，可手动更新", limited: "仅有线索" };
	var purposes = {
		"cisa-kev": "已被在野利用的漏洞清单", "cve-official": "CVE 官方近期变更", "cve-official-git": "CVE 官方完整库，首次需要 Git 和较大下载",
		"nvd": "版本影响与产品条件", "osv": "开源依赖漏洞，首次全库下载约数 GB，可续传",
		"github-advisories": "开源软件安全公告", "nuclei": "模板更新线索，不包含模板正文",
		"nuclei-files": "Nuclei 模板正文，需要 Git", "afrog-files": "Afrog 公开 PoC 正文，需要 Git",
		"github-research-files": "Awesome-POC 研究材料，需要 Git", "wechat": "公众号公开检索，需要填写检索词，不能全量同步"
	};
	function numberInput(section, key, label, min, max) {
		return React.createElement("label", { className: "dsh-hnt-field" }, label,
			React.createElement("input", { className: "dsh-hnt-input", type: "number", disabled: disabled, min: min, max: max, value: data[section][key], onChange: function (e) { patch(section, key, Number(e.target.value)); } }));
	}
	return React.createElement("div", { style: { maxWidth: 860 } },
		React.createElement("h3", null, "漏洞情报更新"),
		React.createElement("p", null, "把公开漏洞公告和 PoC 资料更新到本机，供 Nday 匹配检索。勾选来源后点更新即可，不需要先保存；这一步不扫描目标。"),
		notice ? React.createElement("div", { role: "status", className: "dsh-hnt-notice is-" + notice.kind }, notice.text) : null,
		data.job && data.job.error ? React.createElement("div", { role: "alert" }, "更新未完成：" + data.job.error) : null,
		data.job && !data.job.running && data.job.summary ? React.createElement("div", { role: "status" }, "本轮结束：完成 " + data.job.summary.completeSources + " 个源，部分 " + data.job.summary.partialSources + " 个，失败 " + data.job.summary.failedSources + " 个。详见下方各源。") : null,
		status.interrupted ? React.createElement("div", { role: "status" }, "上轮更新被中断，点击更新可继续已有进度。") : null,
		React.createElement("div", { className: "dsh-hnt-row" },
			React.createElement(Btn, { primary: true, disabled: disabled || !(collector.sources || []).length, onClick: function () { return update(); } }, running ? "正在更新…" : "更新已选源"),
			React.createElement(Btn, { disabled: busy, onClick: refreshStatus }, "刷新进度")),
		React.createElement("p", { role: "status", className: "dsh-hnt-sub" }, running ? "后台更新中；关闭宿主会中断，已提交的进度保留。" : "上次运行：" + (status.lastRunAt ? fmtTime(status.lastRunAt) : "尚未更新")),
		NDAY_FREE_SOURCES.map(function (source) {
			var checked = (collector.sources || []).indexOf(source.id) >= 0;
			var row = (status.sources || []).find(function (r) { return r.source === source.id; });
			var checkpoint = (status.checkpoints || {})[source.id] || {};
			var current = row || checkpoint;
			var active = running && data.job && data.job.sources.indexOf(source.id) >= 0;
			return React.createElement("div", { key: source.id, className: "dsh-hnt-panel" },
				React.createElement("div", { className: "dsh-hnt-row" },
					React.createElement("label", { className: "dsh-hnt-check" }, React.createElement("input", { type: "checkbox", disabled: disabled, checked: checked, onChange: function () { toggleSource(source.id); } }), source.label),
					React.createElement(Btn, { disabled: disabled || !checked, onClick: function () { return update(source.id); } }, "更新此源")),
				React.createElement("div", { className: "dsh-hnt-sub" }, purposes[source.id]),
				React.createElement("div", { role: "status" }, (active ? "本轮已排队 · " : "") + (states[current.status] || "尚未更新") + (row && row.count != null ? " · 本轮读取 " + row.count + " 条" : "")),
				current.downloadTotalBytes ? React.createElement("div", null, "已下载 " + (current.downloadBytes / 1048576).toFixed(1) + " / " + (current.downloadTotalBytes / 1048576).toFixed(1) + " MB") : null,
				current.error ? React.createElement("div", { role: "alert" }, "原因：" + errorText(current.error)) : null,
				current.limitation ? React.createElement("div", null, current.limitation) : null,
				current.contentGaps ? React.createElement("div", null, "原文缺口：" + current.contentGaps) : null);
		}),
		(collector.sources || []).indexOf("wechat") >= 0 ? React.createElement("label", { className: "dsh-hnt-field" }, "公众号检索词", React.createElement("input", { disabled: disabled, className: "dsh-hnt-input", value: collector.wechatQuery || "", placeholder: "例如：泛微 漏洞", onChange: function (e) { patch("collector", "wechatQuery", e.target.value); } })) : null,
		React.createElement("div", { className: "dsh-hnt-panel" },
			React.createElement("label", { className: "dsh-hnt-check" }, React.createElement("input", { type: "checkbox", disabled: disabled, checked: collector.enabled === true, onChange: function (e) { patch("collector", "enabled", e.target.checked); } }), "宿主运行时自动更新"),
			numberInput("collector", "intervalHours", "自动更新间隔（小时）", 1, 168),
			React.createElement(Btn, { disabled: disabled, onClick: save }, "保存设置")),
		React.createElement("details", { className: "dsh-hnt-panel" },
			React.createElement("summary", null, "高级设置（通常无需修改）"),
			React.createElement("p", null, "每轮达到页数上限会保留进度，下次更新继续。影响候选排序的参数不改变来源内容。"),
			numberInput("collector", "lastDays", "首次补查最近多少天", 1, 365),
			numberInput("collector", "limit", "每页条数", 1, 100),
			numberInput("collector", "maxPagesPerRun", "每源每轮最多页数", 1, 100),
			numberInput("policy", "recentDays", "优先考虑近期披露（天）", 1, 3650),
			numberInput("policy", "maxCandidates", "每轮候选上限", 1, 200),
			numberInput("policy", "queriesPerNday", "每条情报最多资产查询数", 1, 10),
			React.createElement(Btn, { disabled: disabled, onClick: save }, "保存高级设置")),
		React.createElement(SourceLibrary),
		React.createElement("p", { className: "dsh-hnt-sub" }, "同步完成只说明本轮数据已获取。公告、产品命中和 PoC 文件都不等于目标存在漏洞。CNVD、CNNVD 当前需要人工补查。"));
}

function SearchTab(props) {
	var [query, setQuery] = useState("");
	var [mode, setMode] = useState("dsl");
	var [size, setSize] = useState(50);
	var [loading, setLoading] = useState(false);
	var [notice, setNotice] = useState(null);
	var [assets, setAssets] = useState([]);
	var [platformErrors, setPlatformErrors] = useState([]);
	var [queries, setQueries] = useState(null);
	var [page, setPage] = useState(1);
	var [pageSize, setPageSize] = useState(20);
	var [authorized, setAuthorized] = useState([]);

	function refreshAuthorized() {
		api("authorized.list").then(function (r) { if (r.ok) setAuthorized(r.authorized || []); });
	}
	useEffect(function () { refreshAuthorized(); }, []);

	function doSearch(p) {
		var q = p ?? query;
		if (!q.trim()) { setNotice({ kind: "error", text: "请输入查询" }); return; }
		setLoading(true);
		setNotice(null);
		api("search", { query: q, mode: mode, size: size }).then(function (r) {
			setLoading(false);
			if (!r.ok) { setNotice({ kind: "error", text: r.error }); return; }
			setAssets(r.assets || []);
			setPlatformErrors(r.platformErrors || []);
			setQueries(r.queries || null);
			setPage(1);
			setNotice({ kind: "info", text: "命中 " + r.assets.length + " 条（已按 ip:port 去重合并）" + (r.platformErrors.length ? "；部分平台出错：" + r.platformErrors.map(function (e) { return e.platform; }).join("/") : "") });
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
			React.createElement("input", { className: "dsh-hnt-input", placeholder: mode === "dsl" ? "统一 DSL：title:\"login\" body:\"xxl-job\" app:\"Nginx\" port:8080（空格=AND）" : "平台原生语法（将原样发送到各平台）", value: query, onChange: function (e) { setQuery(e.target.value); }, onKeyDown: function (e) { if (e.key === "Enter") doSearch(); } }),
			React.createElement("select", { className: "dsh-hnt-select", value: mode, onChange: function (e) { setMode(e.target.value); } },
				React.createElement("option", { value: "dsl" }, "统一 DSL"),
				React.createElement("option", { value: "native" }, "高级·平台原生")),
			React.createElement("select", { className: "dsh-hnt-select", value: size, onChange: function (e) { setSize(Number(e.target.value)); } },
				[20, 50, 100, 200].map(function (n) { return React.createElement("option", { key: n, value: n }, n + " 条"); })),
			React.createElement(Btn, { primary: true, disabled: loading, onClick: function () { doSearch(); } }, loading ? "搜索中…" : "搜索"),
			React.createElement(Btn, { disabled: loading || assets.length === 0, onClick: function () { doExport("csv"); } }, "导出 CSV"),
			React.createElement(Btn, { disabled: loading || assets.length === 0, onClick: function () { doExport("json"); } }, "导出 JSON")),
		queries ? React.createElement("div", { className: "dsh-hnt-row" },
			["fofa", "hunter", "quake"].map(function (p) {
				return React.createElement("span", { key: p, className: "dsh-hnt-pill is-" + p + " dsh-hnt-qchip dsh-hnt-mono", title: p.toUpperCase() + " 语法：" + queries[p] }, p.toUpperCase() + " " + queries[p]);
			})) : null,
		notice ? React.createElement("div", { className: "dsh-hnt-notice is-" + notice.kind }, notice.text) : null,
		assets.length === 0 && !loading ? React.createElement("div", { className: "dsh-hnt-skel" }, React.createElement("div", null, "查询后结果展示在这里——未配置平台时此处为数据骨架")) : null,
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

var REDTEAM_MANAGER_UI_NAMESPACE = "redteam-manager-ui";

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
	ctx.effect(function () { return installStyles(); }, "dsh-hunter: styles");
	ctx.slots.inject("settings.section", function () {
		return ctx.slots.register({
			name: "settings.section",
			id: "hunter-api-platforms",
			order: 137,
			label: function () { return "资产平台 API"; }
		}, function () { return React.createElement(AssetPlatformsSettings, null); });
	});
	ctx.slots.inject("settings.section", function () {
		return ctx.slots.register({
			name: "settings.section",
			id: "hunter-nday-policy",
			order: 139,
			label: function () { return "漏洞情报更新"; }
		}, function () { return React.createElement(NdayPolicySettings, null); });
	});
	injectVisibleConversationView(ctx, "showHunter", function () {
		return ctx.slots.register({
			name: "conversation.view",
			id: "hunter",
			order: 60,
			label: function () { return "hunter 狩猎"; }
		}, function (props) {
			return React.createElement(HunterView, props);
		});
	});
}

module.exports = { name: "dsh-hunter-client", inject: ["slots", "configForms", "sessions", "conversation"], apply: apply };
return module.exports; } });
