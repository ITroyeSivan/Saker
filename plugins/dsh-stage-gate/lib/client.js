window.__ModuleLoader__.load({ id: "@dsh-external/dsh-stage-gate", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
// dsh-stage-gate client — 会话标签页「项目工作台」：只读展示本项目（工作区）的
// 目标契约、准则/意图/任务状态、产物索引与待处理事项。
//
// 定位（避免和别的标签页重复）：
//   · 本页 = 项目契约与执行状态（operation-state.json + 工作区产物文件）；
//   · 「redteam 成果」= finding 台账（结果数据与报告导出）；
//   · 「战役记忆」= 跨会话记忆；「AttackAtlas」= 覆盖矩阵/攻击链。
// 数据只读，不做任何写操作；宿主重启后 CSRF token 轮换会自动重取一次。
"use strict";
var React = require("react");
var useState = React.useState, useEffect = React.useEffect;

var ROUTE = "/dsh-stage-gate-project";
var csrfCache = {};
function csrfOf(base) {
	if (!csrfCache[base]) csrfCache[base] = fetch(base + "/csrf").then(function (r) { return r.json(); }).then(function (r) { return r && r.token ? r.token : ""; }).catch(function () { return ""; });
	return csrfCache[base];
}
function postJson(tok, endpoint, payload) {
	return fetch(ROUTE + "/" + endpoint, {
		method: "POST",
		headers: tok ? { "content-type": "application/json", "x-dsh-csrf": tok } : { "content-type": "application/json" },
		body: JSON.stringify(payload || {})
	});
}
function api(endpoint, payload) {
	return csrfOf(ROUTE).then(function (tok) {
		return postJson(tok, endpoint, payload).then(function (r) {
			if (r.status === 403) {
				delete csrfCache[ROUTE];
				return csrfOf(ROUTE).then(function (tok2) { return postJson(tok2, endpoint, payload); }).then(function (r2) { return r2.json(); });
			}
			return r.json();
		});
	});
}

var S = {
	wrap: { padding: "14px 18px", fontSize: 13, lineHeight: 1.6, overflow: "auto", height: "100%", boxSizing: "border-box" },
	head: { display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 10 },
	title: { fontSize: 15, fontWeight: 600, margin: 0 },
	muted: { fontSize: 11.5, color: "var(--dsw-alias-label-tertiary, #6e6e73)" },
	metrics: { display: "flex", gap: 14, flexWrap: "wrap", margin: "8px 0 14px" },
	metric: { minWidth: 78, padding: "8px 10px", border: "1px solid var(--dsw-alias-border-l1, #e4e4e7)", borderRadius: 8 },
	metricNum: { display: "block", fontSize: 18, fontWeight: 600 },
	section: { borderTop: "2px solid var(--dsw-alias-border-l1, #e4e4e7)", paddingTop: 10, marginTop: 14 },
	sectionTitle: { fontSize: 13, fontWeight: 600, margin: "0 0 6px" },
	table: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
	th: { textAlign: "left", color: "var(--dsw-alias-label-tertiary, #6e6e73)", fontWeight: 500, borderBottom: "1px solid var(--dsw-alias-border-l1, #e4e4e7)", padding: "5px 6px" },
	td: { borderBottom: "1px solid var(--dsw-alias-border-l1, #f0f0f2)", padding: "5px 6px", verticalAlign: "top" },
	code: { fontFamily: "ui-monospace, Consolas, monospace", fontSize: 11.5, background: "var(--dsw-alias-bg-layer-2, #f4f4f5)", padding: "1px 4px", borderRadius: 4 },
	warn: { color: "#9a6700" }, bad: { color: "#d1242f" }, ok: { color: "#1a7f37" },
	btn: { padding: "4px 10px", borderRadius: 6, border: "1px solid var(--dsw-alias-border-l1, #d9d9de)", background: "transparent", cursor: "pointer", fontSize: 12 }
};

function stateColor(state) {
	if (state === "succeeded") return S.ok;
	if (state === "failed" || state === "cancelled") return S.bad;
	if (state === "interrupted") return S.warn;
	return {};
}
function fmt(iso) { return iso ? String(iso).replace("T", " ").slice(0, 19) : ""; }

function ProjectWorkbench(props) {
	var sessionsStore = props.sessionsStore;
	var workspace = "";
	try {
		var snap = sessionsStore && sessionsStore.list.getSnapshot();
		var session = snap && (props.sessionId ? snap.byId[String(props.sessionId)] : snap.byId[snap.current]);
		workspace = session && session.cwd ? String(session.cwd) : "";
	} catch { workspace = ""; }

	var state = useState({ status: "loading", data: null, error: "" });
	var status = state[0].status, data = state[0].data, error = state[0].error;
	var setState = state[1];

	function load() {
		if (!workspace) { setState({ status: "error", data: null, error: "拿不到当前会话的工作区路径" }); return; }
		setState({ status: "loading", data: data, error: "" });
		api("status", { workspace: workspace }).then(function (res) {
			if (res && res.ok && res.snapshot) setState({ status: "ready", data: res.snapshot, error: "" });
			else setState({ status: "error", data: null, error: (res && res.error) || "读取失败" });
		}).catch(function (e) {
			setState({ status: "error", data: null, error: String((e && e.message) || e) });
		});
	}
	useEffect(function () { load(); }, [workspace]);
	useEffect(function () {
		if (!sessionsStore || !sessionsStore.list || !sessionsStore.list.subscribe) return;
		try { return sessionsStore.list.subscribe(function () { load(); }); } catch { return; }
	}, [workspace]);

	if (status === "loading" && !data) return React.createElement("div", { style: S.wrap }, "加载中…");
	if (status === "error" && !data) return React.createElement("div", { style: S.wrap }, React.createElement("div", { style: Object.assign({}, S.muted, S.bad) }, "项目工作台读取失败：" + error));

	var snapData = data || {};
	var criteria = snapData.criteria || { total: 0, met: 0, failed: 0, open: 0, openItems: [] };
	// 台账存在但 goal 为空：模型跳过了 operation_goal。此时 0/0 不是"全部收口"，
	// 而是"没立过标准"，必须显式说明，不能显示成健康状态。
	var goalMissing = snapData.hasLedger === true && snapData.goalRegistered === false;
	var intents = snapData.intents || { total: 0, open: 0, openItems: [] };
	var counts = snapData.counts || {};
	var artifacts = snapData.artifacts || { reports: [] };
	var attention = snapData.attention || [];
	var tasks = snapData.tasks || [];

	var taskRows = tasks.map(function (task) {
		var conflict = (task.conflicts || []).length;
		return React.createElement("tr", { key: "t-" + task.id },
			React.createElement("td", { style: S.td }, React.createElement("code", { style: S.code }, task.id)),
			React.createElement("td", { style: S.td }, task.summary || ""),
			React.createElement("td", { style: Object.assign({}, S.td, stateColor(task.state)) }, task.state + (conflict ? " ⚠冲突" : "")),
			React.createElement("td", { style: S.td }, (task.owner || "—") + (task.maxAttempts > 1 ? " · " + task.attempts + "/" + task.maxAttempts : "")),
			React.createElement("td", { style: S.td }, task.error || task.result || "—"));
	});

	return React.createElement("div", { style: S.wrap },
		React.createElement("div", { style: S.head },
			React.createElement("h3", { style: S.title }, "项目工作台"),
			React.createElement("span", { style: S.muted }, snapData.name || "", snapData.generatedAt ? " · " + fmt(snapData.generatedAt) : ""),
			React.createElement("span", { style: { flex: 1 } }),
			React.createElement("button", { type: "button", style: S.btn, onClick: load }, status === "loading" ? "刷新中…" : "刷新")),
		React.createElement("div", { style: S.muted },
			"只读展示本项目（工作区）的目标契约、准则/意图/任务与产物索引；",
			"finding 台账在「redteam 成果」，跨会话记忆在「战役记忆」，覆盖矩阵在「AttackAtlas」。"),
		snapData.hasLedger === false
			? React.createElement("div", { style: Object.assign({}, S.muted, S.warn) }, "本工作区还没有 operation-state.json（尚未登记目标契约）——先让模型调 operation_goal 登记。")
			: null,
		React.createElement("div", { style: S.metrics },
			React.createElement("div", { style: S.metric }, React.createElement("span", { style: S.metricNum }, String(attention.length)), React.createElement("span", { style: S.muted }, "需处理")),
			React.createElement("div", { style: S.metric }, React.createElement("span", { style: goalMissing ? Object.assign({}, S.metricNum, S.warn) : S.metricNum }, goalMissing ? "未登记" : criteria.met + "/" + criteria.total), React.createElement("span", { style: S.muted }, goalMissing ? "目标契约" : "准则已收口")),
			React.createElement("div", { style: S.metric }, React.createElement("span", { style: S.metricNum }, String(intents.open)), React.createElement("span", { style: S.muted }, "未收口意图")),
			React.createElement("div", { style: S.metric }, React.createElement("span", { style: S.metricNum }, String(tasks.length)), React.createElement("span", { style: S.muted }, "任务")),
			React.createElement("div", { style: S.metric }, React.createElement("span", { style: S.metricNum }, String(counts.conflicts || 0)), React.createElement("span", { style: S.muted }, "结果冲突")),
			React.createElement("div", { style: S.metric }, React.createElement("span", { style: S.metricNum }, String((artifacts.reports || []).length)), React.createElement("span", { style: S.muted }, "报告产物"))),
		React.createElement("div", { style: S.section },
			React.createElement("h4", { style: S.sectionTitle }, "需要处理"),
			attention.length
				? React.createElement("ul", { style: { margin: "4px 0 0", paddingLeft: 18 } },
					attention.map(function (item, index) {
						var style = item.kind === "任务结果冲突" || item.kind === "中断任务" ? S.bad : {};
						return React.createElement("li", { key: "a-" + index, style: style }, React.createElement("b", null, item.kind), "：" + (item.text || ""));
					}))
				: React.createElement("div", { style: Object.assign({}, S.muted, S.ok) }, "当前无待处理项")),
		React.createElement("div", { style: S.section },
			React.createElement("h4", { style: S.sectionTitle }, "目标与准则"),
			React.createElement("div", null, snapData.goal || React.createElement("span", { style: S.muted }, "（未登记目标）")),
			goalMissing
				? React.createElement("div", { style: Object.assign({}, S.muted, S.warn) }, "目标契约未登记，因此没有准则可收口 —— 「0/0」不代表已完成，请先让模型调 operation_goal。")
				: criteria.openItems.length
				? React.createElement("table", { style: S.table },
					React.createElement("thead", null, React.createElement("tr", null,
						React.createElement("th", { style: S.th }, "ID"),
						React.createElement("th", { style: S.th }, "未收口准则"))),
					React.createElement("tbody", null, criteria.openItems.map(function (item) {
						return React.createElement("tr", { key: "c-" + item.id },
							React.createElement("td", { style: S.td }, React.createElement("code", { style: S.code }, item.id)),
							React.createElement("td", { style: S.td }, item.text));
					})))
				: React.createElement("div", { style: Object.assign({}, S.muted, S.ok) }, "准则已全部收口")),
		React.createElement("div", { style: S.section },
			React.createElement("h4", { style: S.sectionTitle }, "意图与任务"),
			taskRows.length
				? React.createElement("table", { style: S.table },
					React.createElement("thead", null, React.createElement("tr", null,
						React.createElement("th", { style: S.th }, "ID"),
						React.createElement("th", { style: S.th }, "方向"),
						React.createElement("th", { style: S.th }, "执行状态"),
						React.createElement("th", { style: S.th }, "owner"),
						React.createElement("th", { style: S.th }, "结果 / 错误"))),
					React.createElement("tbody", null, taskRows))
				: React.createElement("div", { style: S.muted }, "（还没有登记意图/任务）")),
		React.createElement("div", { style: S.section },
			React.createElement("h4", { style: S.sectionTitle }, "产物索引"),
			React.createElement("ul", { style: { margin: "4px 0 0", paddingLeft: 18 } },
				React.createElement("li", null, "证据行：", React.createElement("code", { style: S.code }, String(artifacts.evidenceRows || 0)), "（evidence-index.md）"),
				React.createElement("li", null, "扫描待处置：", React.createElement("code", { style: S.code }, String(artifacts.pendingScanRows || 0)), "（scan-reconcile.md）"),
				React.createElement("li", null, "阶段门禁：", artifacts.gateLine ? React.createElement("span", null, artifacts.gateLine) : React.createElement("span", { style: S.muted }, "暂无 gate-log 记录"))),
			(artifacts.reports || []).length
				? React.createElement("ul", { style: { margin: "6px 0 0", paddingLeft: 18 } },
					(artifacts.reports || []).slice(0, 12).map(function (file) {
						return React.createElement("li", { key: file.name }, React.createElement("code", { style: S.code }, file.name), " ", React.createElement("span", { style: S.muted }, Math.round((file.bytes || 0) / 1024) + " KB"));
					}))
				: React.createElement("div", { style: S.muted }, "（reports/ 下暂无产物）")));
}

function apply(ctx) {
	ctx.inject(["sessions"], function (scope) {
		var sessionsStore = scope.sessions;
		// 必须先 slots.inject("conversation.view") 声明贡献，再 register；
		// 直接 register 不挂到该 slot 的定义生命周期上（实测标签页根本不出现）。
		ctx.slots.inject("conversation.view", function () {
			return ctx.slots.register({
				name: "conversation.view",
				id: "stage-gate-project",
				order: 58,
				label: function () { return "项目工作台"; }
			}, function (props) {
				return React.createElement(ProjectWorkbench, Object.assign({}, props, { sessionsStore: sessionsStore }));
			});
		});
		return function () {};
	});
}

module.exports = { name: "dsh-stage-gate-client", inject: ["slots"], apply: apply };
return module.exports; } });
