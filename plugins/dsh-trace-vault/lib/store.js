// dsh-trace-vault store — 过程库 SQLite 数据层（node:sqlite DatabaseSync）。
//
// 单库 ~/.dsh/trace-vault/traces.db：traces 表按「一次工具调用」一行存过程证据
// （调用参数 + 结果文本 + 出局分类），callId 配对由 index.js 的事件层完成后落库。
// 定位是索引不是归档：args/result 落库即截断（ARGS_CAP/RESULT_CAP），全文在会话
// transcript 里；这里存的是「哪个调用、什么参数、回了什么片段」——供跨 compaction
// 检索与失败归因统计。与 campaign-memory 的分工：记忆库存成果（结构化打法），
// 过程库存原始调用流（未成形的观察）。
//
// 检索用 LIKE（子串语义、跨机器行为一致）：本库量级为单工作站数千行级，
// 量上来后再升级 FTS5 trigram（外部内容表 + 触发器同步），接口不变。

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

/** 调用参数落库上限（字符）。 */
export const ARGS_CAP = 8 * 1024;
/** 结果文本落库上限（字符）。超出截断并带标记。 */
export const RESULT_CAP = 32 * 1024;
/** 出局分类：ok 正常 / blocked 被拦（WAF/403/429/限速/验证码/拒绝）/ error 工具报错。 */
export const OUTCOMES = ["ok", "blocked", "error", "running", "interrupted"];

const BLOCKED_RE = /\b(403|forbidden|waf|blocked|rate.?limit|429|too many requests|captcha|denied)\b/i;

/**
 * 纯本地工具：它们的输出**不是**"目标把我们拦了"的证据。
 *
 * 为什么需要：旧版对整个结果文本跑 `BLOCKED_RE`，于是
 *   - `skill` 加载渗透手册（手册正文里全是 403/WAF/rate-limit 这些词）→ 记 blocked；
 *   - `read` 读靶标源码（源码里有 403 分支）→ 记 blocked；
 *   - `grep` 搜日志（命中行里带 403）→ 记 blocked。
 * 实测一次真实会话 10 条 blocked 里，**没有一条**是目标真的拦了我们，
 * 直接把这个会话的 `toolFailureRate` 抬到 17%。
 *
 * 口径：只有**面向目标**的工具（扫描器/HTTP/代理/浏览器）的输出文本才配当
 * "被拦"信号；本地读写与台账类工具一律按 isError 判 ok/error。
 */
const LOCAL_TOOL_PREFIXES = ["redteam_", "campaign_memory_", "knowledge_", "operation_", "stage_", "todo", "gate"];
const LOCAL_TOOLS = new Set([
	"skill", "read", "write", "edit", "grep", "glob", "ls", "list", "list_agents",
	"subagent", "tool_pack", "gates_list", "webfetch", "web_search", "present",
]);
export function isLocalTool(tool) {
	const name = String(tool ?? "").trim().toLowerCase();
	if (!name) return false;
	if (LOCAL_TOOLS.has(name)) return true;
	return LOCAL_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** 出局分类（纯函数）：工具报错优先；文本命中拦截特征归 blocked（blocked 之于
 *  规划者是「换路径/降速」信号，不是死路）；其余 ok。isError 未知时按文本判定。
 *  `tool` 传进来时，纯本地工具不做文本判定（见 isLocalTool）。 */
export function classifyOutcome(isError, text, tool = "") {
	if (isError === true) return "error";
	if (isLocalTool(tool)) return "ok";
	return BLOCKED_RE.test(String(text ?? "")) ? "blocked" : "ok";
}

/** 从 tool/result 的 message.content 块提取文本并截断。真实管线为嵌套结构
 *  （[{type:"tool-result", content:[{type:"text",...}], isError}]），合成/回放事件
 *  可能为平铺 text 块——两种形态都取。 */
export function resultTextOf(content, cap = RESULT_CAP) {
	const texts = [];
	const walk = (blocks) => {
	if (typeof blocks === "string") { texts.push(blocks); return; }
	if (!Array.isArray(blocks)) return;
	for (const b of blocks) {
	if (!b || typeof b !== "object") continue;
	if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
	else if (Array.isArray(b.content) || typeof b.content === "string") walk(b.content); // tool-result 嵌套
	}
	};
	walk(content);
	return capText(texts.join("\n"), cap);
	}

/** 调用参数归一：JSON 字符串美化后截断；非 JSON 原样截断。 */
export function argsTextOf(raw, cap = ARGS_CAP) {
	const s = String(raw ?? "");
	let pretty = s;
	try {
	const parsed = JSON.parse(s);
	if (parsed && typeof parsed === "object") pretty = JSON.stringify(parsed, null, 1);
	} catch { /* 非 JSON 原样 */ }
	return capText(pretty, cap);
	}

function capText(s, cap) {
	const text = String(s ?? "");
	if (text.length <= cap) return text;
	return `${text.slice(0, cap)}\n…[trace-vault 截断：原 ${text.length} 字符，仅存前 ${cap}]`;
	}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS traces (
	id         TEXT PRIMARY KEY,
	session_id TEXT NOT NULL,
	mode       TEXT NOT NULL,
	tool       TEXT NOT NULL,
	args       TEXT NOT NULL DEFAULT '',
	result     TEXT NOT NULL DEFAULT '',
	is_error   INTEGER NOT NULL DEFAULT 0,
	outcome    TEXT NOT NULL DEFAULT 'ok',
	dur_ms     INTEGER,
	last_seen  TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS traces_session ON traces(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS traces_tool ON traces(tool);
CREATE INDEX IF NOT EXISTS traces_created ON traces(created_at DESC);
`;

function now() {
	return new Date().toISOString().replace("T", " ").slice(0, 19);
	}

export function openStore(dbPath, { retentionDays = 14, maxRows = 50000 } = {}) {
	if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	// 库文件坏了（不是 SQLite 格式）时的自愈：备份原文件再重建空库。
	// 为什么不能直接抛："file is not a database" 会让插件的**全部功能**不可用，
	// 而磁盘满/强杀/网盘回写/误改名都会造成这个问题。数据已经读不出来，
	// 能做的是**保住原文件**（改名备份，不删）并让插件继续可用；
	// 备份路径打到 stderr（只此一次），用户能据此找回或求助。
	function healCorruptDb(dbPath, force = false) {
		if (dbPath === ':memory:') return;
		let head = '';
		try { head = fs.readFileSync(dbPath).subarray(0, 16).toString("latin1"); } catch { return; }
		if (!force && head.startsWith("SQLite format 3")) return;   // 正常的库头
		let bak = dbPath + ".corrupt-" + Date.now();
		let n = 1;
		while (fs.existsSync(bak)) bak = dbPath + ".corrupt-" + Date.now() + "-" + n++;   // 绝不覆盖已有备份
		try {
			fs.renameSync(dbPath, bak);
			// WAL/SHM 属于**已损坏的那个库**：留着会被回放到新库上，导致新库也打不开。
			// 它们只是未落盘的增量，主库已备份，这里一并清掉（清不掉不影响主流程）。
			for (const ext of ["-wal", "-shm"]) {
				try { fs.rmSync(dbPath + ext, { force: true }); } catch { /* 被占用：留给下次启动 */ }
			}
			console.error("[存储] 数据库文件不是 SQLite 格式，已备份为 " + bak + " 并重建空库（原数据可从此文件找回）");
		} catch (e) {
			// EBUSY 最常见：同进程内旧句柄还没释放（本插件缓存了 store）。
			// 这时**不硬来**：原样让调用方抛，用户看到的是真实原因（文件被占用），
			// 比"备份失败但装作没事"更诚实。
			console.error("[存储] 数据库文件损坏且无法备份：" + (e && e.message ? e.message : e) + "（文件被占用时请关闭其它 dsh 实例后重启）");
			throw e;
		}
	}

	function openDatabase() {
		const deadline = Date.now() + 5000;
		let waitMs = 10;
		for (;;) {
			let db;
			try {
				db = new DatabaseSync(dbPath);
				// node:sqlite 在构造时不读文件头，坏库错误要到首条 SQL 才出现。
				db.exec("PRAGMA busy_timeout = 5000");
				db.exec("PRAGMA journal_mode = WAL");
				return db;
			} catch (error) {
				try { db?.close(); } catch { /* 打开失败时可能没有可关闭的句柄 */ }
				const message = String(error?.message ?? error);
				// journal_mode 首次切换在多进程首开时可能仍报 LOCKED；短退避后重试，不误判坏库。
				if (/database is locked|database is busy|SQLITE_BUSY|SQLITE_LOCKED/i.test(message) && Date.now() < deadline) {
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
					waitMs = Math.min(250, waitMs * 2);
					continue;
				}
				// 只有 SQLite 明确判为 NOTADB 时才备份重建；普通 BUSY/LOCKED 必须原样抛出。
				if (!/not a database|SQLITE_NOTADB/i.test(message)) throw error;
				healCorruptDb(dbPath, true);
				db = new DatabaseSync(dbPath);
				db.exec("PRAGMA busy_timeout = 5000");
				db.exec("PRAGMA journal_mode = WAL");
				return db;
			}
		}
	}

	const db = openDatabase(); // busy_timeout/WAL 已就绪；首开会与其他实例竞争
	db.exec(SCHEMA);
	try { db.exec("ALTER TABLE traces ADD COLUMN last_seen TEXT NOT NULL DEFAULT ''"); } catch { /* 旧库已迁移 */ }
	const st = { db, retentionDays, maxRows, insertCount: 0, close() { db.close(); } };
	purgeOld(st);
	capRows(st);
	return st;
	}

/** 落一条完整调用（callId 已配对）。id 冲突时覆盖（同 callId 重放以最新为准）。 */
export function insertTrace(st, { id, sessionId, mode, tool, args = "", result = "", isError = false, outcome, durMs, createdAt = "", lastSeen = "" }) {
	const cls = outcome ?? classifyOutcome(isError, result, tool);
	const at = String(createdAt || now());
	st.db
	.prepare(
	`INSERT OR REPLACE INTO traces (id, session_id, mode, tool, args, result, is_error, outcome, dur_ms, last_seen, created_at)
	 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)
	.run(String(id), String(sessionId ?? ""), String(mode ?? ""), String(tool ?? ""), String(args ?? ""), String(result ?? ""), isError ? 1 : 0, cls, Number.isFinite(durMs) ? Math.max(0, Math.round(durMs)) : null, String(lastSeen || at), at);
	st.insertCount += 1;
	if (st.insertCount % 200 === 0) { purgeOld(st); capRows(st); }
	return { id: String(id), outcome: cls };
}

/** Start a tool call as a durable running row. */
export function beginTrace(st, { id, sessionId, mode, tool, args = "" }) {
	const at = now();
	return insertTrace(st, {
		id,
		sessionId,
		mode,
		tool,
		args,
		result: "",
		isError: false,
		outcome: "running",
		createdAt: at,
		lastSeen: at,
	});
}

/** Finish a running trace while preserving its original start time. */
export function finishTrace(st, { id, result = "", isError = false, outcome, durMs, tool, args } = {}) {
	const row = st.db.prepare("SELECT id, session_id, mode, tool, args, created_at FROM traces WHERE id = ?").get(String(id ?? ""));
	if (!row) {
		return insertTrace(st, { id, result, isError, outcome, durMs, tool: tool ?? "", args: args ?? "" });
	}
	const cls = outcome ?? classifyOutcome(isError, result);
	const at = now();
	const duration = Number(durMs);
	const start = Date.parse(String(row.created_at || "").replace(" ", "T"));
	const computed = Number.isFinite(duration)
		? duration
		: Number.isFinite(start) ? Date.now() - start : undefined;
	st.db.prepare(
		"UPDATE traces SET result = ?, is_error = ?, outcome = ?, dur_ms = ?, last_seen = ? WHERE id = ?"
	).run(String(result ?? ""), isError ? 1 : 0, cls, Number.isFinite(computed) ? Math.max(0, Math.round(computed)) : null, at, String(id));
	return { id: String(id), outcome: cls, sessionId: row.session_id, mode: row.mode, tool: row.tool };
}

/** Refresh heartbeat for currently running traces. */
export function heartbeatRunning(st, ids = []) {
	const list = Array.isArray(ids) ? ids.map(String).filter(Boolean) : [];
	if (list.length === 0) return 0;
	const at = now();
	let changed = 0;
	const update = st.db.prepare("UPDATE traces SET last_seen = ? WHERE id = ? AND outcome = 'running'");
	for (const id of list) changed += Number(update.run(at, id).changes) || 0;
	return changed;
}

/** Mark stale running rows as interrupted. Called on startup and periodically. */
export function recoverStaleRunning(st, { staleMs = 120000 } = {}) {
	const cutoff = new Date(Date.now() - Math.max(0, Number(staleMs) || 0)).toISOString().replace("T", " ").slice(0, 19);
	const at = now();
	const info = st.db.prepare(
		"UPDATE traces SET outcome = 'interrupted', result = CASE WHEN result = '' THEN '[进程中断：工具调用未返回结果]' ELSE result END, last_seen = ? WHERE outcome = 'running' AND (last_seen = '' OR last_seen < ?)"
	).run(at, cutoff);
	return Number(info.changes) || 0;
}

/** LIKE 转义：q 中的 % _ \ 按字面匹配。 */
export function escapeLike(q) {
	return String(q ?? "").replace(/[\\%_]/g, (c) => `\\${c}`);
	}

/** 关键词检索（子串命中 args/result），新行在前。返回轻量行（不含全文）。 */
export function searchTraces(st, { q = "", tool = "", sessionId = "", mode = "", limit = 10, offset = 0 } = {}) {
	const lim = Math.min(Math.max(Number(limit) || 10, 1), 50);
	const off = Math.max(Number(offset) || 0, 0);
	const where = [];
	const params = [];
	if (q) { where.push("(args LIKE ? ESCAPE '\\' OR result LIKE ? ESCAPE '\\')"); const p = `%${escapeLike(q)}%`; params.push(p, p); }
	if (tool) { where.push("tool = ?"); params.push(String(tool)); }
	if (sessionId) { where.push("session_id = ?"); params.push(String(sessionId)); }
	if (mode) { where.push("mode = ?"); params.push(String(mode)); }
	const sql = `SELECT id, session_id, mode, tool, is_error, outcome, dur_ms, created_at, length(args) AS args_len, length(result) AS result_len
	FROM traces ${where.length ? "WHERE " + where.join(" AND ") : ""}
	ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;
	return st.db.prepare(sql).all(...params, lim, off).map(rowOf);
	}

/** 按 id 取完整行（含 args/result 全文——落库上限内）。 */
export function getTrace(st, id) {
	const row = st.db.prepare("SELECT * FROM traces WHERE id = ?").get(String(id ?? ""));
	return row ? rowOf(row) : undefined;
	}

/** 最近调用（新行在前），可按会话/工具过滤。 */
export function listRecent(st, { sessionId = "", tool = "", limit = 20 } = {}) {
	const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
	const where = [];
	const params = [];
	if (sessionId) { where.push("session_id = ?"); params.push(String(sessionId)); }
	if (tool) { where.push("tool = ?"); params.push(String(tool)); }
	const sql = `SELECT id, session_id, mode, tool, is_error, outcome, dur_ms, created_at, length(args) AS args_len, length(result) AS result_len
	FROM traces ${where.length ? "WHERE " + where.join(" AND ") : ""}
	ORDER BY created_at DESC, id DESC LIMIT ?`;
	return st.db.prepare(sql).all(...params, lim).map(rowOf);
	}

/** 出局统计（失败归因的聚合面：blocked 计数是「换路径」信号）。since 传 ISO 时刻
 *  （如 30 分钟前）只统计其后；省略=全部。 */
export function statsTraces(st, { sessionId = "", since = "" } = {}) {
	const where = [];
	const params = [];
	if (sessionId) { where.push("session_id = ?"); params.push(String(sessionId)); }
	if (since) { where.push("created_at >= ?"); params.push(String(since)); }
	const cond = where.length ? "WHERE " + where.join(" AND ") : "";
	const rows = st.db.prepare(`SELECT outcome, COUNT(*) AS n FROM traces ${cond} GROUP BY outcome`).all(...params);
	const out = { total: 0, ok: 0, blocked: 0, error: 0, running: 0, interrupted: 0 };
	for (const r of rows) { out.total += r.n; if (OUTCOMES.includes(r.outcome)) out[r.outcome] = r.n; }
	return out;
	}

/** 会话画像（评估指标最小集）：调用成败分布/成功率/自救信号/人工介入数。
 *  自救信号（SRR 雏形）= 出现过 blocked 之后再出现 ok（时间序按 created_at+rowid）；
 *  人工介入 = tool='(intervention)' 行（真人用户消息，插件注入已排除）。 */
export function sessionStats(st, { sessionId = "" } = {}) {
	const rows = sessionId
	? st.db.prepare("SELECT tool, outcome FROM traces WHERE session_id = ? ORDER BY created_at, rowid").all(String(sessionId))
	: st.db.prepare("SELECT tool, outcome FROM traces ORDER BY created_at, rowid").all();
	let ok = 0, blocked = 0, error = 0, running = 0, interrupted = 0, interventions = 0, sawBlocked = false, selfRecovered = false;
	const blockedTools = new Map();
	for (const r of rows) {
	if (r.tool === "(intervention)") { interventions++; continue; }
	if (r.outcome === "ok") { ok++; if (sawBlocked) selfRecovered = true; }
	else if (r.outcome === "blocked") { blocked++; sawBlocked = true; blockedTools.set(r.tool, (blockedTools.get(r.tool) ?? 0) + 1); }
	else if (r.outcome === "error") { error++; }
	else if (r.outcome === "interrupted") { interrupted++; }
	else if (r.outcome === "running") { running++; }
	}
	const calls = ok + blocked + error + interrupted;
	return {
	sessionId: String(sessionId || ""),
	calls, ok, blocked, error, interrupted, running, interventions,
	successRate: calls > 0 ? Math.round((ok / calls) * 1000) / 10 : null,
	selfRecovered,
	blockedTools: [...blockedTools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t, n]) => `${t}×${n}`)
	};
	}

/** 跨会话评估指标：首次有效动作时间 + 工具失败率。
 *  - “有效动作”= 第一次 outcome=ok 的真实工具调用（排除 (intervention)）。
 *  - 起点取该会话最早一行（通常是真人消息），因此衡量“从会话开始到第一次成功工具结果”。
 *  - 时间戳精确到秒，差异可能为 0；没测到写 null，不写 0。 */
export function sessionMetrics(st, { limit = 100 } = {}) {
	const rows = st.db.prepare(
		"SELECT session_id, tool, outcome, created_at FROM traces ORDER BY session_id, created_at, rowid"
	).all();
	const bySession = new Map();
	for (const row of rows) {
		const id = String(row.session_id || "");
		const item = bySession.get(id) || {
			sessionId: id, startedAt: String(row.created_at || ""), calls: 0, ok: 0, blocked: 0,
			error: 0, interrupted: 0, interventions: 0, firstEffectiveActionMs: null,
		};
		if (row.tool === "(intervention)") {
			item.interventions += 1;
			bySession.set(id, item);
			continue;
		}
		if (row.outcome === "ok") {
			item.ok += 1;
			if (item.firstEffectiveActionMs === null) {
				const start = Date.parse(String(item.startedAt).replace(" ", "T"));
				const at = Date.parse(String(row.created_at || "").replace(" ", "T"));
				if (Number.isFinite(start) && Number.isFinite(at)) item.firstEffectiveActionMs = Math.max(0, at - start);
			}
		} else if (row.outcome === "blocked") item.blocked += 1;
		else if (row.outcome === "error") item.error += 1;
		else if (row.outcome === "interrupted") item.interrupted += 1;
		item.calls = item.ok + item.blocked + item.error + item.interrupted;
		bySession.set(id, item);
	}
	const allSessions = [...bySession.values()]
		.map((item) => ({
			...item,
			successRate: item.calls > 0 ? Math.round((item.ok / item.calls) * 1000) / 10 : null,
			// 口径：blocked = 目标把我们拦了（403/WAF/限速），那是**情报**不是工具故障；
			// 把它算进 toolFailureRate 会让"扫到一个 403"看起来像"工具坏了"。
			// 工具失败只看 error + interrupted。
			toolFailureRate: item.calls > 0
				? Math.round(((item.error + item.interrupted) / item.calls) * 1000) / 10
				: null,
			blockedRate: item.calls > 0 ? Math.round((item.blocked / item.calls) * 1000) / 10 : null,
		}))
		.sort((a, b) => b.calls - a.calls || a.sessionId.localeCompare(b.sessionId));
	const sessions = allSessions.slice(0, Math.max(1, Number(limit) || 100));
	const withFirst = allSessions.map((item) => item.firstEffectiveActionMs).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
	const median = withFirst.length === 0
		? null
		: withFirst.length % 2 === 1
			? withFirst[Math.floor(withFirst.length / 2)]
			: Math.round((withFirst[withFirst.length / 2 - 1] + withFirst[withFirst.length / 2]) / 2);
	const calls = allSessions.reduce((sum, item) => sum + item.calls, 0);
	const failures = allSessions.reduce((sum, item) => sum + item.error + item.interrupted, 0);
	const blockedCalls = allSessions.reduce((sum, item) => sum + item.blocked, 0);
	return {
		sessions: allSessions.length,
		firstEffectiveActionMs: median,
		firstEffectiveActionSamples: withFirst.length,
		toolFailureRate: calls > 0 ? Math.round((failures / calls) * 1000) / 10 : null,
		blockedRate: calls > 0 ? Math.round((blockedCalls / calls) * 1000) / 10 : null,
		errorRate: calls > 0
			? Math.round((allSessions.reduce((sum, item) => sum + item.error, 0) / calls) * 1000) / 10
			: null,
		rows: sessions,
	};
	}

/** 按保留天数清理（开库与每 200 次写入触发）。返回删除行数。 */
export function purgeOld(st) {
	const days = Number(st.retentionDays);
	if (!Number.isFinite(days) || days <= 0) return 0;
	const info = st.db.prepare("DELETE FROM traces WHERE created_at < datetime('now', ?)").run(`-${Math.round(days)} days`);
	return Number(info.changes) || 0;
	}

/** 总量上限：超限按 created_at 最旧淘汰。返回删除行数。 */
export function capRows(st) {
	const max = Number(st.maxRows);
	if (!Number.isFinite(max) || max <= 0) return 0;
	const n = st.db.prepare("SELECT COUNT(*) AS n FROM traces").get().n;
	if (n <= max) return 0;
	const info = st.db.prepare(
	`DELETE FROM traces WHERE id IN (SELECT id FROM traces ORDER BY created_at ASC, id ASC LIMIT ?)`
	).run(n - max);
	return Number(info.changes) || 0;
	}

function rowOf(row) {
	return {
	id: row.id,
	sessionId: row.session_id,
	mode: row.mode,
	tool: row.tool,
	args: row.args ?? "",
	result: row.result ?? "",
	isError: row.is_error === 1,
	outcome: row.outcome,
	durMs: row.dur_ms,
	createdAt: row.created_at,
	argsLen: row.args_len ?? undefined,
	resultLen: row.result_len ?? undefined
	};
	}
