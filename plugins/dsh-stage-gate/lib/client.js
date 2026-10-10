window.__ModuleLoader__.load({ id: "@dsh-external/dsh-stage-gate", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
// 会话标题反映实际执行状态；项目文件在进度与发现中按需展示。
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

function apply(ctx) {
	ctx.inject(["sessions"], function (scope) {
		var sessionsStore = scope.sessions;
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
