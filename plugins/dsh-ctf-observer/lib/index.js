// dsh-ctf-observer — CTF 模式的 **Observer sidecar**（照搬 BreachWeave 的旁路监督角色）。
//
// BreachWeave 的三角色里，Observer 的职责是「不替你解题，只在旁路持续观察：
// 检测异常/重复/跑偏 → 生成修正建议 → 回推 steer/follow-up」。本插件是它在 dsh 里的落地：
//
//   触发   session/event 的轮次边界（turn/end）—— 与 BreachWeave 的「监督只在轮次边界出方案」一致
//   判据   **确定性规则**（不调模型）：重复试错 / 无进展 / 错误堆积 / flag 已捕获
//   注入   agent.followup（等价 BreachWeave 的 sendUserMessage(..., {deliverAs:"steer"})）
//   护栏   冷却窗口 + 指纹去重（照 BreachWeave 的 REMINDER_COOLDOWN / REPEAT_WINDOW）
//   结束   **条件外置**：flag 由系统识别并宣布可收尾，不交给模型主观判断
//
// 纪律：
//   - 只在 ctf-solver 模式生效（其余模式零干扰）。
//   - 只注入、不拦截、不改写任何工具调用。
//   - 自己注入的消息记进 myIds，避免被当成人类输入而重置计数（自我循环）。
//   - 判据是**确定性**的：可以写会失败的测试（同一条状态序列必须给出同一条结论）。

const ROUTE_PATH = "/dsh-ctf-observer";

/** BreachWeave 的节奏常量（同名同义，便于对照）。 */
const REVIEW_EVERY_ROUNDS = 6;        // 每 6 轮做一次周期体检
const REMINDER_COOLDOWN_ROUNDS = 6;   // 两次提醒的最小间隔
const REMINDER_REPEAT_WINDOW_ROUNDS = 12; // 该窗口内同指纹不重复提醒

/** 确定性判据阈值。 */
// 重复试错阈值**刻意放在宿主内置提醒之后**。
// 宿主自带 `@deepseek-ai/dsh-repeat-tool-reminder`（阈值 [3,5,8]，后两档还报 canonical arguments），
// 它按「工具名 + 参数」在 3/5/8 三档提醒。原来这里设 4 —— 夹在人家 3 和 5 之间，
// 实测一轮里模型先收到内置的「ctf_state × 3」，紧接着又收到本插件的「同一动作已重复 4 次」，
// 纯属重复噪音。放到 9 档的定位是「内置升级链都说完还没用」时的追加升级，才有信息量。
const REPEAT_TOOL_THRESHOLD = 9;
const ERROR_STREAK_THRESHOLD = 3;     // 连续 ≥3 个工具错误 = 先解决当下问题
const IDLE_ROUNDS_THRESHOLD = 4;      // 连续 ≥4 轮无新工具 = 大概率在原地打转

/** flag 形态：平台常见前缀 + 花括号内容。
 *
 *  字符集**刻意不含 `:` `;` `,` 和空格** —— 否则会误伤 CSS（`div{color:red}`）与
 *  代码片段，把"爬页面看到样式表"当成"解出 flag"，进而错误宣布收尾。
 *  宁可漏报（交给人判断），也不要误报（自动收尾是真损失）。 */
const FLAG_RE = /\b[a-zA-Z][a-zA-Z0-9_]{1,15}\{[A-Za-z0-9_\-!@#$%^&*+=]{4,120}\}/;

const MODE_ID = "ctf-solver";

// BreachWeave 的 Manager 面：单会话里由模型自己当调度者（自派单 + 自纠偏 + 读快照）。
// Observer 面：nudge 同时落 Observer Notes；steer 由本插件在轮次边界投递并消费。
import { defineTool } from "@deepseek-ai/dsh-tools";
import { readBoard, upsertChallenge, dispatch as boardDispatch, steer as boardSteer, addNote, peekSteers, markSteersConsumed, snapshotText, BOARD_FILE } from "./board.js";

const inject = ["agentPresets", "tools"];

/**
 * 安排一次注入 —— **必须延后到下一个宏任务**，这是本插件最关键的一处修正。
 *
 * 本插件的触发点是 `session/event`，而该事件由 `Session.append` 在**发布临界区内同步派发**
 * （宿主栈：`Session.append` → `invokeContainedSessionObservers` → observer → …）。
 * 在临界区内直接调 `agent.followup()` 会被宿主拒绝：
 *
 *     Error: session append cannot reenter while another append is being published
 *       at Session.append (packages/core/session/src/index.ts:723)
 *       at ReactLoopInbox.splice ← ReactLoopAgent.send ← ReactLoopAgent.followup
 *
 * 原实现把这个异常 `catch { return false }` 掉了 —— 结果就是**「笔记写了、模型从没收到」**：
 * 看板上有纠偏记录、冷却窗也被推进了，但模型一个字都没看到，而且完全无声。
 * 实测 10 个会话里注入落地 0 次（同一插件的 `agent/inbox/inserted` 路径落地 6 次，
 * 因为那个事件在临界区之外）。延后一个宏任务即离开临界区。
 *
 * @returns {{id:string,text:string,fired:boolean,ok:boolean,error:Error|null}}
 *   **只有 `ok === true` 才算投递成功** —— 调用方据此决定要不要推进冷却窗 / 标记 steer 已读。
 *   否则冷却窗会把「根本没送到的提醒」当成送过了，于是既没提醒、又不再重试。
 */
export function scheduleInject(agent, text, opts = {}) {
	const schedule = opts.schedule || ((fn) => setTimeout(fn, 0));
	const id = opts.id || `ctf-observer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	if (opts.myIds) opts.myIds.add(id);       // 同步登记：自己注入的消息不算"人类接管"
	const rec = { id, text: String(text), fired: false, ok: false, error: null };
	schedule(() => {
		rec.fired = true;
		if (opts.isCancelled && opts.isCancelled()) { rec.error = new Error("插件已卸载，跳过注入"); return; }
		try {
			// 注入安全：本函数就是「延后注入」的投递体，由 schedule 调用（默认真身是 setTimeout(fn,0)）。
			agent.followup({ id, role: "user", content: [{ type: "text", text: rec.text }], source: { kind: "user" } });
			rec.ok = true;
		} catch (e) {
			rec.error = e;                     // 交回调用方处理，**不吞**
		}
		if (opts.onDone) { try { opts.onDone(rec); } catch { /* 回调异常不外溢 */ } }
	});
	return rec;
}

/** steer 注入的文案（纯函数，供测试）。 */
export function steerText(pending) {
	const list = Array.isArray(pending) ? pending : [];
	return "[observer] **收到外部纠偏指令（steer）**，本消息优先级高于你当前的自主判断：\n"
		+ list.map((s) => `· ${s.challengeId ? `[${s.challengeId}] ` : ""}${s.text}`).join("\n")
		+ "\n按指令调整方向，不要继续原路线自转。";
}

/** 工具结果的成败与文本（事件形状见 auto-advance 的同位处理）。 */
function readToolResult(event) {
	const message = event?.data?.message ?? {};
	const blocks = Array.isArray(message.content) ? message.content : [];
	const text = blocks.map((b) => (typeof b?.text === "string" ? b.text : "")).join("\n");
	const callId = typeof message.source?.callId === "string" && message.source?.kind === "tool"
		? message.source.callId
		: blocks.find((b) => typeof b?.toolCallId === "string")?.toolCallId;
	const isError = message.isError === true || message.source?.isError === true || /^\s*(error|Error|ERROR)/.test(text);
	return { callId, text, isError };
}

/** 参数指纹：去掉易变部分（时间戳/随机名），让"同一动作"能收敛到同一个键。 */
function fingerprint(toolName, argsRaw) {
	const normalized = String(argsRaw ?? "")
		.replace(/\d{10,13}/g, "<ts>")           // 时间戳
		.replace(/[0-9a-f]{8,}/gi, "<hex>")      // 随机串/哈希
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 200);
	return `${toolName}::${normalized}`;
}

/**
 * 监督判定（纯函数，供测试）：给一段会话状态，返回是否该提醒、提醒什么。
 *
 * @param {object} st  { round, recentTools:[{fp,ok}], newToolKinds:[], lastReminder, flagSeen, idleRounds }
 * @param {object} opt { now }
 * @returns {{nudge:boolean, kind?:string, text?:string, done?:boolean}}
 */
export function judge(st, opt = {}) {
	if (st.flagSeen) {
		// 结束条件外置：flag 已由系统识别 —— 直接宣布可收尾，不再等模型自己判断。
		return {
			nudge: true,
			kind: "done",
			done: true,
			text: `[observer] **结束条件已满足（系统判定）**：本轮工具输出中捕获到 flag 形态的字符串 —— ${st.flagSeen}\n`
				+ "按 CTF 口径收尾：① 把 flag **原文逐字**复述一遍（不要改写/截断）；② 调 redteam_finding_register 登记（title=题名、severity=info、summary=flag 原文与解题路径、type=CTF）；③ 停止在该题上继续耗时。",
		};
	}

	// 冷却窗：距上次提醒不足 REMINDER_COOLDOWN_ROUNDS 轮就不再打扰（照 BreachWeave 的冷却护栏）
	if (st.lastReminder && st.round - st.lastReminder.round < REMINDER_COOLDOWN_ROUNDS) {
		return { nudge: false };
	}

	// ① 无进展：连续多轮没有出现新的工具种类（在原地打转）
	if (st.idleRounds >= IDLE_ROUNDS_THRESHOLD) {
		return matchFingerprint(st, "idle", `[observer] 已连续 ${st.idleRounds} 轮没有出现新的工具/手段——大概率在原地打转。\n按 CTF 口径：**换一条独立思路**（换漏洞类 / 换入口 / 换假设），或先把会的题做完（总分最大化优先）。同一条路反复微调参数不算换路。`);
	}

	// ② 错误堆积：连续多个工具错误
	if (st.errorStreak >= ERROR_STREAK_THRESHOLD) {
		return matchFingerprint(st, "error-streak", `[observer] 最近连续 ${st.errorStreak} 个工具调用报错——先解决当下这个错误（读报错原文、确认环境/权限/参数），不要再叠加新尝试。`);
	}

	// ③ 重复试错：同一动作反复出现
	const dup = topDuplicate(st.recentTools);
	if (dup && dup.n >= REPEAT_TOOL_THRESHOLD) {
		return matchFingerprint(st, `dup:${dup.fp}`, `[observer] 同一动作（${dup.fp.split("::")[0]}）最近已重复 ${dup.n} 次——重复执行同一 payload/命令通常不会改变结果。\n按 CTF 口径：改判据（换编码/换绕过/换注入点），或把这条思路登记为已证伪、换下一题。`);
	}

	// ④ 周期体检（每 N 轮一次）
	if (st.round > 0 && st.round % REVIEW_EVERY_ROUNDS === 0) {
		return matchFingerprint(st, `review:${st.round}`, `[observer] 第 ${st.round} 轮体检：当前没有检测到重复试错或错误堆积。保持节奏——若手上有未收口的方向，先确认哪条最接近 flag；若都卡住，按「3 条独立路径失败即换题」处置。`);
	}

	return { nudge: false };
}

/** 冷却窗 + 同指纹重复窗（照 BreachWeave 的两道护栏）。 */
function matchFingerprint(st, fp, text) {
	const last = st.lastReminder;
	if (last && last.fp === fp && st.round - last.round < REMINDER_REPEAT_WINDOW_ROUNDS) {
		return { nudge: false };
	}
	return { nudge: true, kind: fp, text };
}

/** 出现次数最多的重复指纹。 */
export function topDuplicate(recentTools) {
	const counts = new Map();
	for (const t of recentTools ?? []) {
		if (!t || !t.ok) continue;           // 只统计"成功但反复做"的，失败已在错误堆积里管
		counts.set(t.fp, (counts.get(t.fp) ?? 0) + 1);
	}
	let best = null;
	for (const [fp, n] of counts) if (!best || n > best.n) best = { fp, n };
	return best;
}

/** 轮次内累计状态（每会话一份；会话销毁时清理）。 */
function makeState() {
	return {
		round: 0,
		recentTools: [],        // 最近 REVIEW_WINDOW 个 {fp, ok}
		// 用**指纹**（工具+参数）而非工具名判进展：工具种类是个有限集合（十几种），
		// 会话一长就"所有工具都见过"→ 永远判成无进展 —— 那是必然会发生的误报。
		// 指纹空间大得多；两个 Set 都配上限保护，防无界增长。
		seenFingerprints: new Set(),
		turnFingerprints: new Set(),
		idleRounds: 0,
		errorStreak: 0,
		lastReminder: null,
		flagSeen: null,
		inflight: new Map(),   // callId -> {fp}
		used: 0,
	};
}

const WINDOW = 40;

function apply(ctx) {
	const states = new Map();
	const myIds = new Set();
	let disposed = false;
	// 注入失败**必须可见**：原实现静默吞掉，让整条通道失效了一整轮都没人发现。
	// 前两次大声说，之后只累计（避免长会话刷屏）。
	let injectFailures = 0;
	const noteInjectFailure = (rec) => {
		injectFailures += 1;
		if (injectFailures <= 2) {
			const msg = rec && rec.error ? (rec.error.message || String(rec.error)) : "unknown";
			console.error(`[ctf-observer] 提醒注入失败（第 ${injectFailures} 次）：${msg}`);
		}
	};
	console.log("[ctf-observer] apply begin (ctf-solver observer sidecar)");

	const agentOf = (sid) => {
		try { return ctx.get?.("agents")?.get?.(sid); } catch { return undefined; }
	};

	const modeOf = (agent) => {
		try { return String(ctx.agentPresets?.composedPreset?.(agent?.ctx) ?? ""); } catch { return ""; }
	};

	/** 协作看板落在**会话工作目录**（不是插件目录）：一题一目录时看板与该题产物同处。 */
	const wsOf = (agent) => {
		const cwd = agent?.session?.header?.cwd;
		return typeof cwd === "string" && cwd ? cwd : "";
	};

	const stOf = (sid) => {
		let st = states.get(sid);
		if (!st) { st = makeState(); states.set(sid, st); }
		return st;
	};

/** 轮次边界或异常出现时调用：判定 + 注入（只注入，不拦截）。 */
	const review = (sid) => {
		const agent = agentOf(sid);
		if (!agent || typeof agent.followup !== "function") return;
		if (modeOf(agent) !== MODE_ID) return;
		const ws = wsOf(agent);

		/** 投递成功后才是「真的提醒过了」：失败时**不动** lastReminder / 不消费 steer，下一轮边界自然重试。 */
		const fire = (text, onOk) => scheduleInject(agent, text, {
			myIds,
			isCancelled: () => disposed,
			onDone: (rec) => {
				if (rec.ok) { try { onOk(); } catch { /* 记账失败不影响已投递的事实 */ } }
				else if (!disposed) noteInjectFailure(rec);
			},
		});

		// ① steer 通道优先：先**只看不消费**，投递成功才标记已读（失败则留到下一轮重投）。
		//    老实现是「取出即消费」，注入一失败这条指令就永久丢了。
		if (ws) {
			let pending = [];
			try { pending = peekSteers(ws); } catch { pending = []; }
			if (pending.length) {
				fire(steerText(pending), () => {
					try { markSteersConsumed(ws, pending.map((s) => s.id)); } catch { /* ignore */ }
					const st0 = stOf(sid);
					st0.lastReminder = { round: st0.round, fp: "steer" };   // 投递 steer 后重置冷却，避免立刻叠加体检
				});
				return;
			}
		}

		const st = stOf(sid);
		const decision = judge(st);
		if (!decision.nudge) return;
		fire(decision.text, () => {
			st.used += 1;
			st.lastReminder = { round: st.round, fp: decision.kind ?? "generic" };
			// ② Observer Notes：与**已投递**的注入同源落一条记录（BreachWeave 的 Observer Notes 落地）。
			if (ws) { try { addNote(ws, { kind: decision.kind ?? "generic", text: decision.text }); } catch { /* ignore */ } }
		});
	};

	//#region Manager 面（模型工具）：自派单 / 自纠偏 / 读快照 —— BreachWeave 的 Planner·Manager 落地
	/** 工具的准入：只在 ctf-solver 模式、且有工作目录时可用（其余模式零干扰）。 */
	const toolWs = (exec) => (modeOf(exec?.agent) === MODE_ID ? wsOf(exec.agent) : "");

	ctx.tools.register(defineTool({
		name: "ctf_state",
		description: "读取当前 CTF 协作看板快照（题目清单 / 已解 flag / 进行中路线 / 未读纠偏 / 最近 observer 记录）。多路并行探索时，**每次开一条新路之前先读一次**——避免两条路撞车、避免重复劳动；收尾时也读一次确认 flag 都已登记。看板落在会话工作目录的 ctf-board.json。",
		parameters: {},
		output: {
			schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true } } },
			render: (_a, v) => [{ type: "text", text: v.ok ? v.text : `读取失败：${v.error}` }],
		},
		execute(_args, exec) {
			const ws = toolWs(exec);
			if (!ws) return Promise.resolve({ ok: false, error: "仅 CTF 模式会话内可用" });
			try { return Promise.resolve({ ok: true, text: snapshotText(readBoard(ws)) }); }
			catch (e) { return Promise.resolve({ ok: false, error: e?.message ?? String(e) }); }
		},
	}));

	ctx.tools.register(defineTool({
		name: "ctf_challenge",
		description: "登记或更新一道 CTF 题目（按题名去重，同名即更新）。开题时登记 status=open 与题面要点；解出后 status=solved 并把 flag **原文逐字**填入 flag 字段（不要改写/截断）；卡住时 status=blocked 并记失败原因。看板是并行探索的共享状态——登记过的题不会被另一条路重复开工。",
		parameters: {
			name: { type: "string", required: true, description: "题名（作为去重键，同名即更新）" },
			status: { type: "string", enum: ["open", "solved", "blocked", "dropped"], description: "状态（默认 open）" },
			flag: { type: "string", description: "解出的 flag 原文（逐字，不截断）" },
			note: { type: "string", description: "题面要点 / 卡点 / 解题路径备注" },
		},
		output: {
			schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true } } },
			render: (_a, v) => [{ type: "text", text: v.ok ? `看板已更新：${v.name} → ${v.status}` : `登记失败：${v.error}` }],
		},
		execute(args, exec) {
			const ws = toolWs(exec);
			if (!ws) return Promise.resolve({ ok: false, error: "仅 CTF 模式会话内可用" });
			try {
				const b = upsertChallenge(ws, args);
				const c = b.challenges.find((x) => x.name === String(args.name ?? "").trim().slice(0, 80));
				return Promise.resolve({ ok: true, name: c?.name ?? args.name, status: c?.status ?? args.status });
			} catch (e) { return Promise.resolve({ ok: false, error: e?.message ?? String(e) }); }
		},
	}));

	ctx.tools.register(defineTool({
		name: "ctf_dispatch",
		description: "派一条攻击路线（登记「谁在打哪条路」）。多路并行探索时必须先派单再动手：看板上的 dispatches 是防撞车的唯一依据——同一题的两条路若怀疑重叠，先 ctf_state 看一眼。path 写清具体路线（如「LFI 读 /proc/self/environ 找源码」），不要只写「试试文件包含」。",
		parameters: {
			path: { type: "string", required: true, description: "攻击路线（具体到手段与目标点）" },
			challengeId: { type: "string", description: "题目标识（题名或 cN id；可省略=跨题通用手段）" },
			owner: { type: "string", description: "执行者标注（如 solver-1 / 子代理名）" },
			note: { type: "string", description: "备注" },
		},
		output: {
			schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true } } },
			render: (_a, v) => [{ type: "text", text: v.ok ? `已派单：${v.id} → ${v.path}` : `派单失败：${v.error}` }],
		},
		execute(args, exec) {
			const ws = toolWs(exec);
			if (!ws) return Promise.resolve({ ok: false, error: "仅 CTF 模式会话内可用" });
			try {
				const b = boardDispatch(ws, args);
				const d = b.dispatches[b.dispatches.length - 1];
				return Promise.resolve({ ok: true, id: d.id, path: d.path });
			} catch (e) { return Promise.resolve({ ok: false, error: e?.message ?? String(e) }); }
		},
	}));

	ctx.tools.register(defineTool({
		name: "ctf_steer",
		description: "给当前方向下一条纠偏指令（写入 steers 队列，由 observer 在下个轮次边界投递给解题循环，优先级高于自主判断）。用于：发现自己跑偏要强制换路、决定放弃某思路、或要把某条约束固定下来（如「不要再碰 WAF 拦的那个 payload」）。短句直给结论，不要写长篇分析。",
		parameters: {
			text: { type: "string", required: true, description: "纠偏内容（一句话结论，如：放弃 SQLi，改测 SSTI）" },
			challengeId: { type: "string", description: "针对哪道题（可省略=全局）" },
		},
		output: {
			schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true } } },
			render: (_a, v) => [{ type: "text", text: v.ok ? "纠偏已入队，将在下个轮次边界投递给解题循环" : `入队失败：${v.error}` }],
		},
		execute(args, exec) {
			const ws = toolWs(exec);
			if (!ws) return Promise.resolve({ ok: false, error: "仅 CTF 模式会话内可用" });
			try { boardSteer(ws, args); return Promise.resolve({ ok: true }); }
			catch (e) { return Promise.resolve({ ok: false, error: e?.message ?? String(e) }); }
		},
	}));
	//#endregion

	ctx.on("session/event", (subject, event) => {
		const sid = String(subject?.id ?? subject?.header?.id ?? "");
		if (!sid) return;

		// 人类新输入 = 人已接管 → 重置计数（避免打断用户节奏）
		if (event?.type === "user/message" && !myIds.has(event?.data?.id) && event?.data?.source?.kind !== "tool") {
			states.delete(sid);
			return;
		}

		const st = stOf(sid);

		if (event?.type === "tool/call") {
			const callId = event.data?.callId;
			if (typeof callId === "string") {
				st.inflight.set(callId, { fp: fingerprint(event.data?.name, event.data?.arguments) });
			}
			return;
		}

		if (event?.type === "tool/result") {
			const r = readToolResult(event);
			const inflight = typeof r.callId === "string" ? st.inflight.get(r.callId) : undefined;
			if (typeof r.callId === "string") st.inflight.delete(r.callId);
			const fp = inflight?.fp ?? "unknown::";
			const ok = !r.isError;

			st.errorStreak = ok ? 0 : st.errorStreak + 1;
			st.recentTools.push({ fp, ok });
			if (st.recentTools.length > WINDOW) st.recentTools.shift();
			st.turnFingerprints.add(fp);   // 本轮见过的指纹（turn/end 时判"有没有新东西"）

			// 结束条件外置：系统侧识别 flag（不由模型宣布）
			if (!st.flagSeen) {
				const m = FLAG_RE.exec(r.text ?? "");
				if (m) st.flagSeen = m[0];
			}
			// 错误堆积 / 重复试错属于"即时"信号，不等轮次边界
			if (st.errorStreak >= ERROR_STREAK_THRESHOLD || topDuplicate(st.recentTools)?.n >= REPEAT_TOOL_THRESHOLD || st.flagSeen) {
				review(sid);
			}
			return;
		}

		if (event?.type === "turn/end") {
			st.round += 1;
			// 空闲轮判定：本轮有没有出现**没见过的新指纹**（工具+参数的新组合 = 实质推进）
			const novel = [...st.turnFingerprints].filter((f) => !st.seenFingerprints.has(f));
			st.idleRounds = novel.length === 0 ? st.idleRounds + 1 : 0;
			for (const f of st.turnFingerprints) st.seenFingerprints.add(f);
			if (st.seenFingerprints.size > 1000) {          // 上限保护：只留最近 500 个
				const keep = [...st.seenFingerprints].slice(-500);
				st.seenFingerprints.clear();
				for (const f of keep) st.seenFingerprints.add(f);
			}
			st.turnFingerprints = new Set();
			review(sid);
		}
	});

	ctx.on("agent/disposed", (payload) => {
		const agent = payload?.agent ?? payload;
		const sid = agent?.session?.id ?? agent?.id;
		if (sid) states.delete(String(sid));
	});

	ctx.effect(() => () => { disposed = true; states.clear(); myIds.clear(); }, "dsh-ctf-observer: state");
}

const name = "dsh-ctf-observer";

export { ROUTE_PATH, MODE_ID, REVIEW_EVERY_ROUNDS, REMINDER_COOLDOWN_ROUNDS, REMINDER_REPEAT_WINDOW_ROUNDS, REPEAT_TOOL_THRESHOLD, ERROR_STREAK_THRESHOLD, IDLE_ROUNDS_THRESHOLD, FLAG_RE, fingerprint, makeState, apply, inject, name };
