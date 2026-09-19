// dsh-auto-advance — 自动推进器（八专业模式）。
//
// 把「模型停下等用户输入」的断点焊上，触发面两条：
//   ① 执行体返回（tool/result，subagent 家族）——原触发面；
//   ② 轮次边界（turn/end，正常跑完且本轮无推进动作）——模型全程内联执行时的唯一机会（P1-1 补）。
// 两条路共用同一决策与护栏。若意图台账有未收口方向，主动 followup 注入一条推进提醒——按台账收口本次执行
// 对应的意图（done 附产出指位 / blocked 附原因），再依锚派下一步（operation_intent）
// 或收工。事件驱动闭环的最后一环。
//
// 三护栏（自主不失控）：
//   1) 轮数上限——连续自动推进 maxAutoTurns 轮封顶，真人消息（含其他插件注入）重置计数；
//   2) opt-in——仅意图台账存在且有 open 意图时激活（与 scope 同纪律：登记即激活）；
//   3) 注入自带台账态势——收口什么/还剩什么/第几轮，人工可审计、随时接管。
// 另有冷却窗（默认 30s）：并行执行体齐返回只并作一次推进，不刷屏。
//
// 不改写不拦截，只注入；非八专业模式/无台账会话零干扰。
// 推进语态按模式注入（MODE_VOICE）：收口产出与下一步方向用本模式自己的语义，
// 台账机制原子（operation_progress/operation_intent/轮次护栏）全模式统一。

import fs from "node:fs";
import path from "node:path";
import z from "@deepseek-ai/schemastery";

const name = "dsh-auto-advance";
const inject = ["agentPresets"];

export const MODE_IDS = ["pentest", "code-audit", "ctf-solver"];

const Config = z.object({
	enable: z.boolean().default(true),
	maxAutoTurns: z.natural().default(5),
	cooldownMs: z.natural().default(30000),
	kickoff: z.boolean().default(true),
	advanceOnTurnEnd: z.boolean().default(true)
});

/** 执行体工具面：subagent 家族（原生 subagent/subagent_fork + 产品 CLI 派生工具）。 */
export function isAdvanceTool(toolName) {
	return /^subagent/.test(String(toolName ?? ""));
}

/** 推进动作工具面：真正推进台账的动作（收口 operation_progress / 派单 operation_intent / 派执行体）。
 *  轮次边界触发靠它判定"本轮模型已经推进过了"——已推进就不再催，这是防刷屏的第一道闸。
 *  刻意不含 operation_goal/scope/constraints：那三个是开工登记，不是推进。 */
export function isProgressTool(toolName) {
	return isAdvanceTool(toolName) || /^operation_(progress|intent)$/.test(String(toolName ?? ""));
}

/** 轮次边界是否值得推进：只有正常跑完的轮次才催。
 *  用户取消（aborted）说明人已接管，报错（error）/超限（max-tokens）/阻塞（blocked）先解决当下问题，
 *  都不该追进度。宿主侧 reason 是 {kind} 对象，这里兼容字符串形式。 */
export function isAdvanceableTurnEnd(reason) {
	const kind = typeof reason === "string" ? reason : String(reason?.kind ?? "");
	return kind === "completed";
}

/** 台账读取：open 意图清单（无文件/无意图返回 null）。 */
export function readOpenIntents(cwd) {
	try {
		const st = JSON.parse(fs.readFileSync(path.join(cwd, "operation-state.json"), "utf8"));
		if (!st || !Array.isArray(st.intents)) return null;
		const open = st.intents.filter((i) => i && i.status === "open");
		return { total: st.intents.length, openIds: open.map((i) => i.id), summaries: open.map((i) => `${i.id}:${String(i.summary ?? "").slice(0, 60)}`) };
	} catch { return null; }
}

/** 从执行体调用参数中提取意图 id 提示（模型派单 prompt 里写了 i1/i2 时点名，没写则空）。 */
export function intentHintOf(argsRaw, ledger) {
	const ids = new Set();
	for (const m of String(argsRaw ?? "").matchAll(/\bi([0-9]{1,3})\b/g)) ids.add(`i${Number(m[1])}`);
	const known = new Set((ledger?.openIds ?? []).concat(ledger ? [] : []));
	// 提示 id 限定在台账 open 意图内（点名已收口的没有意义）
	return [...ids].filter((id) => (ledger?.openIds ?? []).includes(id)).slice(0, 5);
}

/** 各模式推进语态：收口时"产出"在本模式指什么、下一步在本模式是什么方向——
 *  台账机制原子（operation_progress 收口/operation_intent 派单/轮次护栏）全模式统一，语态按模式注入。 */
export const MODE_VOICE = {
	pentest: { done: "漏洞发现或验证证据（finding id 或证据落盘路径）", next: "下一攻击面或入口方向" },
	"code-audit": { done: "finding（附 sink 指位与复现链，双链命中对账）", next: "下一模块或 sink 面" },
	"ctf-solver": { done: "flag（原文）或可复现的解题路径（脚本/命令落盘）", next: "下一道题，或该题的下一条独立思路" }
};

/** 推进决策（纯函数，供测试）：返回 {nudge:false,reason} 或 {nudge:true,text}。
 *  voice={done,next} 为模式语态（MODE_VOICE），缺省时退通用文案。 */
export function decideAdvance({ toolName, trigger = "executor", ledger, usedTurns, maxAutoTurns, cooldownMs, lastNudgeAt, now, hint = [], voice = {} }) {
	// 触发面两条：executor=执行体返回（仅 subagent 家族）；turn-end=轮次边界（内联执行也覆盖）。
	if (trigger === "executor" ? !isAdvanceTool(toolName) : trigger !== "turn-end") return { nudge: false, reason: "tool" };
	if (ledger === null || ledger.openIds.length === 0) return { nudge: false, reason: "no-open-intents" };
	if (usedTurns >= maxAutoTurns) return { nudge: false, reason: "turn-cap" };
	if (now - lastNudgeAt < cooldownMs) return { nudge: false, reason: "cooldown" };
	const openList = ledger.summaries.slice(0, 5).map((s) => s.split(":")[0]).join(",");
	const more = ledger.openIds.length > 5 ? " 等" : "";
	const hintLine = hint.length > 0 ? `本次执行疑似对应 ${hint.join(", ")}（以派单 prompt 提及为准）。` : "";
	const header = trigger === "turn-end"
		? "本轮已结束，且本轮没有推进动作（内联执行场景）——别停在半路。"
		: `执行体已返回（${toolName}）。`;
	return {
		nudge: true,
		text: `[auto-advance] ${header}台账：意图 ${ledger.openIds.length}/${ledger.total} 未收口（${openList}${more}）——${hintLine}先 operation_progress 收口本次执行对应的意图（intent_done 附产出指位${voice.done ? `：${voice.done}` : ""} / intent_blocked 附原因），再依锚 operation_intent 派下一步${voice.next ? `（${voice.next}）` : ""}或收工（无下一步即静默收尾，不硬造方向）。本条为自动推进（第 ${usedTurns + 1}/${maxAutoTurns} 轮），人工输入随时接管。`
	};
}

function isHumanUser(message) {
	return message?.source?.kind === "user";
}
function textOf(message) {
	const content = message?.content ?? message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter((b) => b?.type === "text").map((b) => b.text).join(" ");
}

// 有界发现任务：用户把交付收敛到“至少一个/找到并验证漏洞”时，不应在轮次
// 边界继续催全量覆盖。典型实战说法是“输入目标，发现漏洞”“至少给一个
// 可复现证据”，而不是要求完整资产/全矩阵收口。
const FULL_SCOPE_RE = /全量|全面|完整(?:评估|覆盖|报告|测试)|覆盖矩阵|所有(?:资产|入口|漏洞|面)|全部(?:资产|入口|漏洞|面)|\b(?:full|complete)\s+(?:assessment|coverage|test|report)\b/i;
const EXPLICIT_BOUNDED_RE = /有界(?:发现|任务|验证|排查)|(至少|最少).{0,6}(一个|1\s*个|一项|1\s*项)|只(?:选|要|需|需先|找|发现|验证|检查|测)\s*(?:一个|1\s*个|一项|1\s*项|首个)|先\s*(?:找|测|验证|发现).{0,8}(?:一个|首个)|不要\s*(?:扩展|继续扩大).{0,12}(?:全量|扫描|覆盖|测试)|不\s*(?:扩展|扩大).{0,12}(?:全量|扫描|覆盖|测试)|\bat\s+least\s+(one|1)\b|\bbounded\s+(?:discovery|task|probe)\b/i;
const BOUNDED_DISCOVERY_RE = /发现(?:并|和)?验证|找到.{0,12}(?:漏洞|缺陷)|快速(?:发现|排查|验证).{0,12}(?:漏洞|缺陷)|\bfind\s+(?:and\s+)?(?:verify\s+)?(?:a\s+)?vulnerabilit/i;
export function isBoundedDiscoveryTask(message) {
	const text = textOf(message).trim();
	if (text.length === 0) return false;
	// 完整评估里的“完成后立即收口”“发现并验证所有漏洞”不能因为收口词被误判成有界；
	// 只有出现“至少一个/只找一个/有界发现”等明确交付上限时才压过全量语义。
	if (FULL_SCOPE_RE.test(text) && !EXPLICIT_BOUNDED_RE.test(text)) return false;
	return EXPLICIT_BOUNDED_RE.test(text) || BOUNDED_DISCOVERY_RE.test(text);
}

async function apply(ctx, config) {
	const cfg = { enable: true, maxAutoTurns: 5, cooldownMs: 30000, kickoff: true, advanceOnTurnEnd: true, ...config };
	if (!cfg.enable) return;
	let decompositionMap = null;
	// 模式化拆分理论：兄弟插件 dsh-stage-gate 的 DECOMPOSITION（不可达降级通用文案）
	try {
		({ DECOMPOSITION: decompositionMap } = await import("../../dsh-stage-gate/lib/index.js"));
	} catch { /* 手工局部安装降级 */ }
	const inflight = new Map(); // `${sid}:${callId}` → toolName（只记执行体）
	const inflightArgs = new Map(); // 同键 → 调用参数原文（意图提示用，同生命周期）
	const state = new Map(); // sid → { used, lastAt }
	const turnProgressed = new Map(); // sid → 本轮是否已出现推进动作（turn/end 触发判据）
	const myIds = new Set(); // 本插件注入的 followup id（真人判定排除自身）
	const kickoffDone = new Set(); // sid → 开工提醒已发（每会话一次）

	const agentsOf = () => {
		try { return ctx.get("agents"); } catch { return undefined; }
	};
	const agentOf = (sid) => agentsOf()?.get?.(sid);

/** 真人接管重置：只清轮次计数（连续自主上限），冷却窗保留（防连发与谁说话无关）。 */
	const reset = (sid) => {
		const st = state.get(sid);
		if (st) state.set(sid, { used: 0, lastAt: st.lastAt });
	};

	/** 模式化拆分理论（DECOMPOSITION 已在 apply 顶部导入；不可达降级通用文案）。 */
	const theoryOf = (mode) => {
		if (decompositionMap && decompositionMap[mode]) return decompositionMap[mode];
		return null;
	};

	// 极短/常见试水消息不算深度任务——跳过开工提醒，避免用户敲一句"test"就被
	// 灌入大段三登记。规则：trim 后 < 6 字符，或命中下方白名单（test/hi/中文招呼
	// 等）。命中规则后仍按"每会话一次"纪律把 sid 标为已处理，不再补灌。
	const TRIVIAL_KICKOFF_RE = /^(test|hi|hello|hey|ping|你好|您好|测试|试试|测试一下|ok|好的|收到|嗯|啊|哦|啊哈|👋|🙂|thx|thanks|ty)$/i;
	// 用户明确只要一句回复或禁止工具时，不能再靠 followup 追加一轮——那会直接违背指令。
	// 这两条必须在投递前判断；正文里的“可忽略”对模型约束不够强。
	const SINGLE_REPLY_RE = /(^|[，。；;\s])(请|麻烦)?(只|仅|只需|只需要|只用)\s*(回复|回答|输出|返回|用一句话|一句话)/i;
	const NO_TOOL_RE = /(不要|别|请勿|无需|不需要|禁止)\s*(调用|使用|执行|运行|发起)\s*(任何)?\s*(工具|命令|tool)/i;
	const NO_TOOL_EN_RE = /\b(do not|don't|never|without)\s+(call|use|run|invoke)\s+(any\s+)?tools?\b|\bonly\s+(reply|respond|answer|output)\b/i;
	const boundedTasks = new Set();
	function shouldSkipKickoff(message) {
		const text = textOf(message).trim();
		if (!text) return true;
		if (text.length < 6) return true;
		return TRIVIAL_KICKOFF_RE.test(text)
			|| SINGLE_REPLY_RE.test(text)
			|| NO_TOOL_RE.test(text)
			|| NO_TOOL_EN_RE.test(text)
			|| isBoundedDiscoveryTask(message);
	}

	/** 开工提醒文案：模式化（本模式拆分理论+准则结构+分母语义）优先，降级通用三登记。 */
	const kickoffText = (mode) => {
		const d = theoryOf(mode);
		if (d) {
			return `[auto-advance] 开工提醒（${mode}）：仅当这是需要持续推进的深度任务时才做开工三登记——① operation_goal（目标+可判定准则；本模式拆分理论：${d.theory}——准则结构：${d.criteriaGuide}）→ ② operation_constraints（用户口头约束 deny/allow 结构化，防压缩丢失+可拦${d.constraintHints ? `；本模式约束面：${d.constraintHints}` : ""}）→ ③ operation_scope（范围分母${d.scopeSemantics ? `：${d.scopeSemantics}` : ""}，报告门对账依据）。登记后对账/推进/门禁体系激活；如果这是简单问答、只要求一句回复或明确禁止工具，就忽略本提醒并立即结束，不得调用工具。`;
		}
		return "[auto-advance] 开工提醒：仅当这是需要持续推进的深度任务时才做开工三登记——operation_goal（目标+可判定准则）→ operation_constraints（用户口头约束 deny/allow 结构化，防压缩丢失+可拦）→ operation_scope（范围分母，报告门对账依据）。登记后对账/推进/门禁体系激活；如果这是简单问答、只要求一句回复或明确禁止工具，就忽略本提醒并立即结束，不得调用工具。";
	};

	/**
	 * 注入失败**必须可见**。
	 *
	 * 原实现把异常写成 `catch { /* 注入失败不重试 *\/ }`，而这里吞掉的其实是宿主的**重入拒绝**：
	 *   `Error: session append cannot reenter while another append is being published`
	 * 原因：`session/event` 由 `Session.append` 在**发布临界区内同步派发**，在该临界区内调
	 * `agent.followup()` → `ReactLoopInbox.splice` → `Session.append` 会被直接拒绝。
	 * 后果是「轮次边界催办」这条路径**从未落地过**：实测 10 个会话里注入了 0 次，
	 * 而走 `agent/inbox/inserted`（临界区之外）的开工提醒落地 6 次。
	 * 静默吞掉这个错误，让一个写入文档的特性整整一轮都没人发现它没工作。
	 */
	let injectFailures = 0;
	const noteInjectFailure = (e) => {
		injectFailures += 1;
		if (injectFailures <= 2) {
			const msg = e && e.message ? e.message : String(e);
			console.error(`[auto-advance] 推进提醒注入失败（第 ${injectFailures} 次）：${msg}`);
		}
	};

	/** 真正投递（返回是否成功）。 */
	const deliver = (agent, id, text) => {
		try {
			// 注入安全：本函数是投递体，只从 setTimeout(…,0) 里调用（见 tryNudge）；
			// 开工提醒那条在 agent/inbox/inserted 里同步调，该事件本来就在 Session.append 临界区之外。
			agent.followup({ id, role: "user", content: [{ type: "text", text }], source: { kind: "user" } });
			return true;
		} catch (e) { noteInjectFailure(e); return false; }
	};

	/** 三重门槛 + 决策 + followup 注入（执行体返回与轮次边界共用同一路径，避免两条路各自漂移）。
	 *
	 *  注入**延后到下一个宏任务**：本函数只从 `session/event` 调用，而那个事件在
	 *  `Session.append` 的发布临界区内 —— 同步注入必被宿主以重入拒绝（见上）。
	 *  延后一拍即离开临界区；`agent/inbox/inserted` 那条路（开工提醒）在临界区之外，不动它。 */
	const tryNudge = (sid, { trigger, toolName, argsRaw = "" }) => {
		const agent = agentOf(sid);
		if (!agent || typeof agent.followup !== "function") return;
		// 有界发现任务不做自动续跑；模型完成当前轮后自然交付即可。
		if (boundedTasks.has(sid)) return;
		let mode = "";
		try { mode = String(ctx.agentPresets?.composedPreset?.(agent.ctx) ?? ""); } catch { /* 组合未就绪 */ }
		if (!MODE_IDS.includes(mode)) return;
		const cwd = agent.session?.header?.cwd;
		if (typeof cwd !== "string" || !cwd) return;
		const ledger = readOpenIntents(cwd);
		const hint = intentHintOf(argsRaw, ledger);
		const st = state.get(sid) ?? { used: 0, lastAt: 0 };
		const decision = decideAdvance({ toolName, trigger, ledger, usedTurns: st.used, maxAutoTurns: cfg.maxAutoTurns, cooldownMs: cfg.cooldownMs, lastNudgeAt: st.lastAt, now: Date.now(), hint, voice: MODE_VOICE[mode] ?? {} });
		if (!decision.nudge) return;
		const id = `auto-advance-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		myIds.add(id);
		// 冷却窗按「**尝试**」同步推进：它是速率闸，管的是"多久内别再试"。
		// 若也放到延后回调里，投递失败就会每个轮次边界都重试、完全没有节流。
		state.set(sid, { used: st.used, lastAt: Date.now() });
		setTimeout(() => {
			const ok = deliver(agent, id, decision.text);
			if (!ok) return;   // 失败：不耗推进预算（冷却已推进，重试仍有节流）
			const cur = state.get(sid) ?? { used: 0, lastAt: Date.now() };
			state.set(sid, { used: cur.used + 1, lastAt: cur.lastAt });
		}, 0);
	};

	ctx.on("agent/inbox/inserted", (info) => {
		const message = info?.message;
		if (!isHumanUser(message) || myIds.has(message?.id)) return;
		const sid = info?.agent?.session?.id ?? info?.agent?.id;
		reset(sid);
		if (isBoundedDiscoveryTask(message)) boundedTasks.add(sid);
		else boundedTasks.delete(sid);
		// 开工提醒（第 0 轮推进）：专业模式会话首条人类消息后，工作区无台账则一次性提醒
		// 开工三登记——不硬拦（快任务可忽略），出口对账兜底。
		if (cfg.kickoff && sid && !kickoffDone.has(sid)) {
			kickoffDone.add(sid);
			if (shouldSkipKickoff(message)) return;   // 试水消息不打搅（仍按每会话一次纪律，不再补灌）
			const agent = info?.agent;
			const cwd = agent?.session?.header?.cwd;
			if (typeof cwd === "string" && cwd && !fs.existsSync(path.join(cwd, "operation-state.json")) && typeof agent.followup === "function") {
				let mode = "";
				try { mode = String(ctx.agentPresets?.composedPreset?.(agent?.ctx) ?? ""); } catch { /* 组合未就绪 */ }
				if (MODE_IDS.includes(mode)) {
					const id = `auto-kickoff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
					myIds.add(id);
					// 与 tryNudge 统一走 deliver：失败可见（不再静默吞错）。
					// 本路径在 agent/inbox/inserted 里触发，位于 Session.append 临界区**之外**，
					// 所以可以同步投递 —— 这也是它能落地而 tryNudge 不能的原因。
					deliver(agent, id, kickoffText(mode));
				}
			}
		}
	});
	ctx.on("session/event", (subject, event) => {
		if (event?.type === "user/message" && isHumanUser(event.data) && !myIds.has(event.data?.id)) {
			const sid = subject?.id ?? subject?.header?.id;
			reset(sid);
			if (isBoundedDiscoveryTask(event.data)) boundedTasks.add(sid);
			else boundedTasks.delete(sid);
			return;
		}
		const sid = String(subject?.id ?? subject?.header?.id ?? "");
		if (!sid) return;
		// 轮次推进动作计数：每轮开头清零，出现推进动作即置位。
		if (event?.type === "turn/start") { turnProgressed.set(sid, false); return; }
		if (event?.type === "tool/call") {
			const toolName = event.data?.name;
			if (isProgressTool(toolName)) turnProgressed.set(sid, true);
			if (!isAdvanceTool(toolName)) return;
			if (inflight.size > 1024) { inflight.clear(); inflightArgs.clear(); }
			const key = `${sid}:${event.data.callId}`;
			inflight.set(key, toolName);
			inflightArgs.set(key, String(event.data.arguments ?? ""));
			return;
		}
		// 轮次边界触发（P1-1）：模型全程内联执行、不派子代理时，"执行体返回"永远不发生，
		// 契约未收口也没人催。这里补上：正常跑完的轮次若本轮无推进动作、台账仍有 open 意图，就催一次。
		// 已推进过则不催（否则刚收口完就被催第二次）；轮数上限与冷却两护栏照旧生效。
		if (event?.type === "turn/end") {
			const progressed = turnProgressed.get(sid) === true;
			turnProgressed.set(sid, false);
			if (!cfg.advanceOnTurnEnd || progressed) return;
			if (!isAdvanceableTurnEnd(event.data?.reason)) return;
			tryNudge(sid, { trigger: "turn-end" });
			return;
		}
		if (event?.type !== "tool/result") return;
		const message = event.data?.message ?? {};
		const callId = typeof message.source?.callId === "string" && message.source?.kind === "tool" ? message.source.callId : (Array.isArray(message.content) ? message.content.find((b) => typeof b?.toolCallId === "string")?.toolCallId : undefined);
		if (typeof callId !== "string") return;
		const key = `${sid}:${callId}`;
		const toolName = inflight.get(key);
		if (toolName === undefined) return;
		const argsRaw = inflightArgs.get(key) ?? "";
		inflight.delete(key);
		inflightArgs.delete(key);
		tryNudge(sid, { trigger: "executor", toolName, argsRaw });
	});
	// 载荷是 {agent}（见宿主 agent/src/index.ts emitDisposed：emit('agent/disposed', { agent })）。
	// 早先写成 (agent) => agent?.session?.id 取到的是 undefined，会话销毁时三个 Map 一个都没清掉——
	// 长会话反复开新会话会把计数与状态一直攒着。两种形状都收，免得宿主换法再踩一次。
	const disposedAgent = (payload) => payload?.agent ?? payload;
	ctx.on("agent/disposed", (payload) => {
		const agent = disposedAgent(payload);
		const sid = agent?.session?.id ?? agent?.id;
		if (sid === undefined) return;
		state.delete(sid);
		turnProgressed.delete(sid);
		kickoffDone.delete(sid);
		boundedTasks.delete(sid);
	});
}

export { Config, apply, inject, name };
