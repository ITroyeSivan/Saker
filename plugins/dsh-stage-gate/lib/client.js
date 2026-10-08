window.__ModuleLoader__.load({ id: "@dsh-external/dsh-stage-gate", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
// dsh-stage-gate client — 会话标签页「项目工作台」：只读展示本项目（工作区）的
// 任务目标、完成标准、作业方向、任务状态、成果路径与待处理事项。
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
function api(connection, endpoint, payload) {
	if (!connection || !connection.rpc || typeof connection.rpc.call !== "function") return Promise.reject(new Error("项目工作台连接尚未就绪"));
	return connection.rpc.call(ROUTE, endpoint, payload || {}).then(function (result) {
		if (result && result.ok) return result.value;
		var error = result && result.error;
		return { ok: false, error: typeof error === "string" ? error : error && error.message || "项目工作台连接失败" };
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

S.flow = { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", margin: "4px 0 8px" };
S.flowNode = { padding: "4px 8px", border: "1px solid var(--dsw-alias-border-l1, #e4e4e7)", borderRadius: 6, fontSize: 11.5, lineHeight: "18px" };
S.flowArrow = { color: "#9a9aa0", fontSize: 12 };
S.graphGrid = { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 10, alignItems: "start" };
S.graphCard = { border: "1px solid var(--dsw-alias-border-l1, #e4e4e7)", borderRadius: 8, padding: "8px 10px", background: "var(--dsw-alias-bg-layer-1, transparent)" };
S.graphSummary = { cursor: "pointer", fontWeight: 600, lineHeight: 1.5 };
S.graphBody = { marginTop: 7, paddingTop: 7, borderTop: "1px solid var(--dsw-alias-border-l1, #f0f0f2)" };
S.graphSubTitle = { fontSize: 11.5, fontWeight: 600, margin: "6px 0 2px" };
S.badge = { display: "inline-block", padding: "1px 6px", borderRadius: 999, border: "1px solid currentColor", fontSize: 10.5, marginRight: 6 };

function stateColor(state) {
	if (state === "succeeded") return S.ok;
	if (state === "failed" || state === "cancelled") return S.bad;
	if (state === "interrupted") return S.warn;
	return {};
}
function taskStateLabel(state) {
	var labels = { queued: "排队", running: "进行中", succeeded: "已完成", failed: "失败", interrupted: "中断", cancelled: "已取消", open: "待处理", pending: "待处理" };
	return labels[state] || state || "—";
}
function fmt(iso) { return iso ? String(iso).replace("T", " ").slice(0, 19) : ""; }

function lastTurnFailed(binding) {
	var entries = [];
	try { entries = binding && binding.eventSource && binding.eventSource.getSnapshot().entries || []; } catch { entries = []; }
	for (var i = entries.length - 1; i >= 0; i--) {
		var event = entries[i] && (entries[i].type === "event" ? entries[i].event : entries[i].event);
		if (event && event.type === "turn/end") return String(event.data && event.data.reason && event.data.reason.kind || "") === "error";
	}
	return false;
}

function progressTitleLabel({ running, error, failedTurn, pending, snapshot }) {
	if (running) {
		var flow = snapshot && snapshot.flow;
		var stage = flow && flow.current && snapshot.flowLabel ? flow.current + " " + snapshot.flowLabel : "";
		return "进行中" + (stage ? " · " + stage : "");
	}
	var gateLine = String(snapshot && snapshot.artifacts && snapshot.artifacts.gateLine || "");
	if (error || failedTurn || /\|\s*(?:FAIL|失败)\s*\|/i.test(gateLine)) return "失败";
	if (pending) return "等待用户";
	var reports = snapshot && snapshot.artifacts && snapshot.artifacts.reports;
	var counts = snapshot && snapshot.counts;
	if (snapshot && snapshot.goalRegistered && Array.isArray(reports) && reports.length > 0
		&& Number(counts && counts.openCriteria || 0) === 0 && Number(counts && counts.openIntents || 0) === 0) return "有结果";
	return snapshot && snapshot.goalRegistered ? "等待用户" : "";
}

function productTitleOf() {
	var title = String(document.title || "DSH");
	var split = title.lastIndexOf(" — ");
	return split >= 0 ? title.slice(split + 3) : title;
}

function ProgressDocumentTitle(props) {
	var sessionsStore = props.sessionsStore;
	var sessionKey = props.useSessions(function (state) {
		var session = Object.values(state && state.byId || {}).find(function (item) { return Number(item && item.retainedBy && item.retainedBy.mainView || 0) > 0; });
		return session ? JSON.stringify({ id: session.id, title: session.title || session.displayTitle || "DSH", cwd: session.cwd || "", running: !!session.running }) : "";
	});
	var session = null;
	try { session = sessionKey ? JSON.parse(sessionKey) : null; } catch { session = null; }
	var showSessionTitle = props.usePanelInfo(function (info) { return !info || info.activePanelId === null; });
	var pending = props.useSessionStatus(function (statuses) {
		var status = session && statuses && statuses.get(String(session.id));
		return !!(status && status.pendingInteraction);
	});
	useEffect(function () {
		var live = true;
		var latestSnapshot = null;
		var binding = session && sessionsStore && sessionsStore.binding(String(session.id));
		var sessionFace = binding && binding.session;
		function applyTitle() {
			if (!live) return;
			var product = productTitleOf();
			if (!showSessionTitle || !session) { document.title = product; return; }
			var state = {};
			try { state = sessionFace && sessionFace.getSnapshot ? sessionFace.getSnapshot() : {}; } catch { state = {}; }
			var label = progressTitleLabel({
				running: !!(session.running || state.running),
				error: !!(state.lastAgentError || state.promptError),
				failedTurn: lastTurnFailed(binding),
				pending: pending,
				snapshot: latestSnapshot,
			});
			document.title = (label ? "【" + label + "】" : "") + session.title + " — " + product;
		}
		function refreshSnapshot() {
			if (!session || !session.cwd) { applyTitle(); return; }
			api(props.connection, "status", { workspace: session.cwd }).then(function (result) {
				if (!live) return;
				latestSnapshot = result && result.ok ? result.snapshot : null;
				applyTitle();
			}).catch(function () { if (live) applyTitle(); });
		}
		applyTitle();
		refreshSnapshot();
		var off = null;
		try { if (sessionFace && typeof sessionFace.subscribe === "function") off = sessionFace.subscribe(applyTitle); } catch { off = null; }
		var offEvents = null;
		try { if (binding && binding.eventSource && typeof binding.eventSource.subscribe === "function") offEvents = binding.eventSource.subscribe(applyTitle); } catch { offEvents = null; }
		var initiallyRunning = !!(session && session.running);
		try { initiallyRunning = initiallyRunning || !!(sessionFace && sessionFace.getSnapshot && sessionFace.getSnapshot().running); } catch { /* use list status */ }
		var timer = initiallyRunning ? setInterval(refreshSnapshot, 4000) : null;
		return function () {
			live = false;
			if (timer) clearInterval(timer);
			if (typeof off === "function") off();
			if (typeof offEvents === "function") offEvents();
		};
	}, [sessionKey, showSessionTitle, pending, sessionsStore]);
	return null;
}

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
	var copiedState = useState("");
	var copied = copiedState[0], setCopied = copiedState[1];
	function copyArtifactPath(path) {
		var text = String(path || "");
		function fallbackCopy() {
			try {
				var area = document.createElement("textarea");
				area.value = text;
				area.style.position = "fixed";
				area.style.opacity = "0";
				document.body.appendChild(area);
				area.select();
				document.execCommand("copy");
				area.remove();
				setCopied(text);
			} catch { setCopied(""); }
		}
		try {
			if (navigator.clipboard && navigator.clipboard.writeText) {
				navigator.clipboard.writeText(text).then(function () { setCopied(text); }).catch(fallbackCopy);
			} else fallbackCopy();
		} catch { fallbackCopy(); }
	}

	function load() {
		if (!workspace) { setState({ status: "error", data: null, error: "拿不到当前会话的工作区路径" }); return; }
		setState({ status: "loading", data: data, error: "" });
		api(props.connection, "status", { workspace: workspace }).then(function (res) {
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
	// 台账存在但 goal 为空：模型跳过了 operation_goal。此时 0/0 不是"全部完成"，
	// 而是"没立过标准"，必须显式说明，不能显示成健康状态。
	var goalMissing = snapData.hasLedger === true && snapData.goalRegistered === false;
	var intents = snapData.intents || { total: 0, open: 0, openItems: [] };
	var counts = snapData.counts || {};
	var artifacts = snapData.artifacts || { reports: [] };
	var attention = snapData.attention || [];
	var tasks = snapData.tasks || [];
	var taskTree = snapData.taskTree || [];
	var graph = snapData.graph || { groups: [], ungrouped: [], groupCount: 0, taskCount: 0 };
	var flow = snapData.flow || { stages: [], buckets: [], current: "S0", assets: 0, running: 0, queued: 0, blocked: 0 };
	var flowLabel = snapData.flowLabel || flow.current;
	var reportGroups = (artifacts && artifacts.reportGroups) || [];

	var taskRows = tasks.map(function (task) {
		var conflict = (task.conflicts || []).length;
		return React.createElement("tr", { key: "t-" + task.id },
			React.createElement("td", { style: S.td }, React.createElement("code", { style: S.code }, task.id)),
			React.createElement("td", { style: S.td }, task.summary || ""),
			React.createElement("td", { style: Object.assign({}, S.td, stateColor(task.state)) }, taskStateLabel(task.state) + (conflict ? " ⚠结果不一致" : "")),
			React.createElement("td", { style: S.td }, (task.owner || "—") + (task.maxAttempts > 1 ? " · " + task.attempts + "/" + task.maxAttempts : "")),
			React.createElement("td", { style: S.td }, task.error || task.result || "—"));
	});
	function flowNodeStyle(stage) {
		if (stage.state === "done") return Object.assign({}, S.flowNode, { background: "#eaf7ee", borderColor: "#b7e4c7", color: "#1a7f37" });
		if (stage.state === "current") return Object.assign({}, S.flowNode, { background: "#e8f1ff", borderColor: "#b6d4fe", color: "#1d4ed8", fontWeight: 600 });
		return S.flowNode;
	}
	function bucketColor(status) {
		if (status === "running") return S.ok;
		if (status === "failed" || status === "interrupted" || status === "cancelled") return S.bad;
		if (status === "succeeded") return S.ok;
		return S.muted;
	}
	function gateStyle(status) {
		if (status === "verified") return S.ok;
		if (status === "refuted") return S.bad;
		return S.warn;
	}
	function gateLabel(status) {
		if (status === "verified") return "代表资产已验证，可铺开同组";
		if (status === "refuted") return "代表资产已证伪，转下一组";
		return "先验证代表资产";
	}
	function taskTreeNode(task, depth) {
		return React.createElement("li", { key: "tree-" + task.id, style: { margin: "2px 0 2px " + (depth * 14) + "px" } },
			React.createElement("code", { style: S.code }, task.id),
			" " + (task.summary || ""),
			" ",
			React.createElement("span", { style: Object.assign({}, stateColor(task.state), { fontSize: 11.5 }) }, taskStateLabel(task.state || task.status || "")),
			task.bucketId ? React.createElement("span", { style: S.muted }, " · " + task.bucketId) : null,
			task.owner ? React.createElement("span", { style: S.muted }, " · " + task.owner) : null,
			task.state === "queued" ? React.createElement("div", { style: task.ready ? S.muted : S.warn }, task.ready ? "前置条件满足，可以领取" : "等待：" + (task.blockedReason || "前置条件尚未满足")) : null,
			(task.children || []).length
				? React.createElement("ul", { style: { margin: "2px 0 0", paddingLeft: 14 } }, (task.children || []).map(function (child) { return taskTreeNode(child, depth + 1); }))
				: null);
	}
	function taskNodeLine(task) {
		var conflict = (task.conflicts || []).length;
		return React.createElement("div", { key: "graph-task-" + task.id, style: { margin: "3px 0" } },
			React.createElement("code", { style: S.code }, task.id),
			" " + (task.summary || ""),
			" ",
			React.createElement("span", { style: Object.assign({}, stateColor(task.state), { fontSize: 11.5 }) }, taskStateLabel(task.state || task.status || "")),
			conflict ? React.createElement("span", { style: S.bad }, " · 结果不一致") : null,
			task.owner ? React.createElement("span", { style: S.muted }, " · " + task.owner) : null,
			(task.targetIds || []).length ? React.createElement("div", { style: S.muted }, "资产：" + (task.targetIds || []).join(", ")) : null,
			task.state === "queued" ? React.createElement("div", { style: task.ready ? S.muted : S.warn }, task.ready ? "前置条件满足，可以领取" : "等待：" + (task.blockedReason || "前置条件尚未满足")) : null,
			(task.error || task.result) ? React.createElement("div", { style: S.muted }, task.error || task.result) : null);
	}
	function graphCard(group) {
		var color = stateColor(group.status);
		return React.createElement("details", { key: "graph-group-" + group.id, style: S.graphCard },
			React.createElement("summary", { style: S.graphSummary },
				React.createElement("span", { style: Object.assign({}, S.badge, color) }, taskStateLabel(group.status)),
				group.title || group.id,
				React.createElement("span", { style: S.muted }, " · " + (group.assetIds || []).length + " 个资产 · 优先分 " + (group.reuseScore || 0))),
			React.createElement("div", { style: S.graphBody },
				group.entryId ? React.createElement("div", { style: S.muted }, "清单条目：" + group.entryId) : null,
				React.createElement("div", { style: S.muted }, "负责人：" + (group.owner || "未指派")),
				React.createElement("div", { style: Object.assign({}, S.muted, gateStyle(group.verificationStatus)) }, "代表资产：" + (group.representativeAssetId || "未指定") + " · " + gateLabel(group.verificationStatus)),
				(group.assetIds || []).length ? React.createElement("div", { style: S.muted }, "资产 ID：" + (group.assetIds || []).slice(0, 12).join(", ") + ((group.assetIds || []).length > 12 ? " 等" : "")) : null,
				group.gateEvidence ? React.createElement("div", { style: S.muted }, "验证证据：" + group.gateEvidence) : null,
				(group.tasks || []).length
					? React.createElement("div", null,
						React.createElement("div", { style: S.graphSubTitle }, "关联任务"),
						(group.tasks || []).map(taskNodeLine))
					: React.createElement("div", { style: S.muted }, "还没有关联任务")));
	}
	function ungroupedCard() {
		return React.createElement("details", { key: "graph-ungrouped", style: S.graphCard },
			React.createElement("summary", { style: S.graphSummary },
				React.createElement("span", { style: Object.assign({}, S.badge, S.muted) }, "未分组"),
				"未归入资产组的工作方向",
				React.createElement("span", { style: S.muted }, " · " + (graph.ungrouped || []).length + " 项")),
			React.createElement("div", { style: S.graphBody }, (graph.ungrouped || []).map(taskNodeLine)));
	}

	return React.createElement("div", { style: S.wrap },
		React.createElement("div", { style: S.head },
			React.createElement("h3", { style: S.title }, "项目工作台"),
			React.createElement("span", { style: S.muted }, snapData.name || "", snapData.generatedAt ? " · " + fmt(snapData.generatedAt) : ""),
			React.createElement("span", { style: { flex: 1 } }),
			React.createElement("button", { type: "button", style: S.btn, onClick: load }, status === "loading" ? "刷新中…" : "刷新")),
		React.createElement("div", { style: S.muted },
			"只读展示本项目的任务目标、完成标准、工作方向和任务、成果路径；",
			"漏洞台账在「redteam 成果」，跨会话记忆在「战役记忆」，覆盖矩阵在「AttackAtlas」。"),
		snapData.hasLedger === false
			? React.createElement("div", { style: Object.assign({}, S.muted, S.warn) }, "本工作区还没有 operation-state.json（尚未登记任务目标）——先让模型登记目标和完成标准。")
			: null,
		React.createElement("div", { style: S.metrics },
			React.createElement("div", { style: S.metric }, React.createElement("span", { style: S.metricNum }, String(attention.length)), React.createElement("span", { style: S.muted }, "需处理")),
			React.createElement("div", { style: S.metric }, React.createElement("span", { style: goalMissing ? Object.assign({}, S.metricNum, S.warn) : S.metricNum }, goalMissing ? "未登记" : criteria.met + "/" + criteria.total), React.createElement("span", { style: S.muted }, goalMissing ? "任务目标" : "完成标准")),
			React.createElement("div", { style: S.metric }, React.createElement("span", { style: S.metricNum }, String(intents.open)), React.createElement("span", { style: S.muted }, "未完成方向")),
			React.createElement("div", { style: S.metric }, React.createElement("span", { style: S.metricNum }, String(tasks.length)), React.createElement("span", { style: S.muted }, "任务")),
			React.createElement("div", { style: S.metric }, React.createElement("span", { style: S.metricNum }, String(counts.conflicts || 0)), React.createElement("span", { style: S.muted }, "结果冲突")),
			React.createElement("div", { style: S.metric }, React.createElement("span", { style: S.metricNum }, String((artifacts.reports || []).length)), React.createElement("span", { style: S.muted }, "报告产物"))),
		React.createElement("div", { style: S.section },
			React.createElement("h4", { style: S.sectionTitle }, "作业地图"),
			(graph.groups || []).length || (graph.ungrouped || []).length
				? React.createElement("div", { style: S.graphGrid }, [
					...(graph.groups || []).map(graphCard),
					(graph.ungrouped || []).length ? ungroupedCard() : null,
				].filter(Boolean))
				: React.createElement("div", { style: S.muted }, "还没有可展示的资产组或工作方向——先整理资产清单，再生成优先攻击清单。")),
		React.createElement("div", { style: S.section },
			React.createElement("h4", { style: S.sectionTitle }, "作业进度"),
			React.createElement("div", { style: S.flow },
				flow.stages.map(function (stage, index) {
					return React.createElement("span", { key: "flow-" + stage.id, style: { display: "inline-flex", alignItems: "center", gap: 6 } },
						React.createElement("span", { style: flowNodeStyle(stage) }, "第 " + (index + 1) + " 步 " + stage.label),
						index < flow.stages.length - 1 ? React.createElement("span", { style: S.flowArrow }, "→") : null);
				})),
			React.createElement("div", { style: S.muted },
				"当前：" + flowLabel + " · 资产 " + (flow.assets || 0) + " 个 · 资产组 " + (flow.buckets || []).length +
				" 组 · 进行中 " + (flow.running || 0) + " / 排队 " + (flow.queued || 0) + " / 受阻 " + (flow.blocked || 0)),
			(flow.buckets || []).length
				? React.createElement("table", { style: S.table },
					React.createElement("thead", null, React.createElement("tr", null,
						React.createElement("th", { style: S.th }, "资产组"),
						React.createElement("th", { style: S.th }, "产品"),
						React.createElement("th", { style: S.th }, "资产"),
						React.createElement("th", { style: S.th }, "代表资产"),
						React.createElement("th", { style: S.th }, "优先分"),
						React.createElement("th", { style: S.th }, "状态"),
						React.createElement("th", { style: S.th }, "负责人"))),
					React.createElement("tbody", null, (flow.buckets || []).slice(0, 20).map(function (bucket) {
						return React.createElement("tr", { key: "bucket-" + bucket.bucketId },
							React.createElement("td", { style: S.td }, React.createElement("code", { style: S.code }, bucket.entryId || bucket.bucketId)),
							React.createElement("td", { style: S.td }, bucket.product || "—"),
							React.createElement("td", { style: S.td }, String((bucket.assetIds || []).length)),
							React.createElement("td", { style: Object.assign({}, S.td, gateStyle(bucket.verificationStatus)) }, bucket.representativeAssetId || "—"),
							React.createElement("td", { style: S.td }, String(bucket.reuseScore || 0)),
							React.createElement("td", { style: Object.assign({}, S.td, bucketColor(bucket.status)) }, taskStateLabel(bucket.status)),
							React.createElement("td", { style: S.td }, bucket.owner || "—"));
					})))
				: React.createElement("div", { style: S.muted }, "还没有优先攻击清单（先整理资产清单，再生成攻击清单）")),
		reportGroups.length
			? React.createElement("div", { style: S.section },
				React.createElement("h4", { style: S.sectionTitle }, "成果导航"),
				reportGroups.map(function (group) {
					return React.createElement("div", { key: "artifact-group-" + group.target, style: { marginBottom: 8 } },
						React.createElement("div", { style: { fontWeight: 600, fontSize: 12.5, marginBottom: 3 } }, group.target, React.createElement("span", { style: S.muted }, " · " + group.files.length + " 项")),
						React.createElement("ul", { style: { margin: 0, paddingLeft: 18 } }, group.files.map(function (file) {
							return React.createElement("li", { key: file.absPath, style: { margin: "2px 0" } },
								React.createElement("code", { style: S.code }, file.relPath),
								file.title ? React.createElement("span", null, " " + file.title) : null,
								React.createElement("span", { style: S.muted }, " · " + (file.kind === "poc" ? "POC" : "报告")),
								React.createElement("button", {
									type: "button",
									onClick: function () { copyArtifactPath(file.absPath); },
									style: Object.assign({}, S.btn, { marginLeft: 6, padding: "1px 7px", fontSize: 11 }),
									title: file.absPath,
								}, copied === file.absPath ? "已复制" : "复制路径"));
						})));
				}))
			: null,
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
			React.createElement("h4", { style: S.sectionTitle }, "任务目标与完成标准"),
			React.createElement("div", null, snapData.goal || React.createElement("span", { style: S.muted }, "（未登记目标）")),
			goalMissing
				? React.createElement("div", { style: Object.assign({}, S.muted, S.warn) }, "任务目标还没登记，因此没有完成标准 —— 「0/0」不代表已经做完，请先让模型登记任务目标。")
				: criteria.openItems.length
				? React.createElement("table", { style: S.table },
					React.createElement("thead", null, React.createElement("tr", null,
						React.createElement("th", { style: S.th }, "ID"),
						React.createElement("th", { style: S.th }, "未完成标准"))),
					React.createElement("tbody", null, criteria.openItems.map(function (item) {
						return React.createElement("tr", { key: "c-" + item.id },
							React.createElement("td", { style: S.td }, React.createElement("code", { style: S.code }, item.id)),
							React.createElement("td", { style: S.td }, item.text));
					})))
				: React.createElement("div", { style: Object.assign({}, S.muted, S.ok) }, "完成标准已全部满足")),
		React.createElement("div", { style: S.section },
			React.createElement("h4", { style: S.sectionTitle }, "工作方向与任务"),
			taskTree.length
				? React.createElement("ul", { style: { margin: "4px 0 8px", paddingLeft: 18 } }, taskTree.map(function (task) { return taskTreeNode(task, 0); }))
				: null,
			taskRows.length
				? React.createElement("table", { style: S.table },
					React.createElement("thead", null, React.createElement("tr", null,
						React.createElement("th", { style: S.th }, "ID"),
						React.createElement("th", { style: S.th }, "方向"),
						React.createElement("th", { style: S.th }, "执行状态"),
						React.createElement("th", { style: S.th }, "负责人"),
						React.createElement("th", { style: S.th }, "结果 / 错误"))),
					React.createElement("tbody", null, taskRows))
				: React.createElement("div", { style: S.muted }, "（还没有登记工作方向或任务）")),
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
				return React.createElement(ProjectWorkbench, Object.assign({}, props, { sessionsStore: sessionsStore, connection: ctx.connection }));
			});
		});
		ctx.slots.inject("shell.overlay", function () {
			return ctx.slots.register({ name: "shell.overlay", id: "stage-gate.progress-title", order: 92 }, function (props) {
				return React.createElement(ProgressDocumentTitle, Object.assign({}, props, { sessionsStore: sessionsStore, connection: ctx.connection }));
			});
		});
		return function () {};
	});
}

module.exports = { name: "dsh-stage-gate-client", inject: ["slots", "connection"], apply: apply, api: api, progressTitleLabel: progressTitleLabel, lastTurnFailed: lastTurnFailed };
return module.exports; } });
