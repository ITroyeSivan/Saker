// dsh-auto-advance 离线单测：决策纯函数（工具过滤/无台账/轮数上限/冷却/文案）
// + 装配接线（事件→followup）/三护栏/真人重置/意图点名/非专业模式静默。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isAdvanceTool, isProgressTool, isAdvanceableTurnEnd, readOpenIntents, intentHintOf, decideAdvance, isBoundedDiscoveryTask, MODE_IDS, MODE_VOICE, Config } from "../lib/index.js";

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log(`ok   ${label}`); } else { fail++; console.log(`FAIL ${label}`); } };

ok("有界发现任务：中文“至少一个可复现证据”", isBoundedDiscoveryTask("请发现并验证漏洞，至少给出一个可复现证据") === true);
ok("有界发现任务：英文 at least one vulnerability", isBoundedDiscoveryTask("find and verify at least one vulnerability on the target") === true);
ok("有界发现任务：组合措辞“只选一个/立即收口/不扩展全量”不漏判", isBoundedDiscoveryTask("这是有界发现 + 状态语义复验。请只选一个证据不足的风险，完成状态回写后立即收口，不要扩展全量扫描") === true);
ok("有界发现任务：只发现首个+停止扩展中文表述", isBoundedDiscoveryTask("先找一个真实漏洞，验证后停止扩大测试") === true);
ok("完整评估任务不被误判为有界发现", isBoundedDiscoveryTask("请完成全量渗透测试、覆盖矩阵和最终报告") === false);
ok("完整评估后立即收口仍按全量处理", isBoundedDiscoveryTask("请完成全量渗透测试、覆盖矩阵和最终报告，完成后立即收口") === false);
ok("全量发现并验证所有漏洞不被发现词误判", isBoundedDiscoveryTask("请全面发现并验证所有漏洞后交付完整报告") === false);
ok("明确至少一个时，即使提全面也按有界交付", isBoundedDiscoveryTask("先全面侦察，但至少给出一个可复现漏洞证据后收口") === true);

/** 推一格时钟：注入是**延后一拍**执行的（必须在 Session.append 发布临界区之外，
 *  见 lib/index.js 的说明），不推的话同步断言看到的是「还没投递」的旧状态。 */
const tick = () => new Promise((r) => setTimeout(r, 0));

const LEDGER = { total: 3, openIds: ["i1", "i2", "i3"], summaries: ["i1:追注入点", "i2:横向试探", "i3:提权验证"] };
const BASE = { toolName: "subagent", ledger: LEDGER, usedTurns: 0, maxAutoTurns: 5, cooldownMs: 30000, lastNudgeAt: 0, now: 100000 };

// 1. 工具面
ok("subagent 前缀命中", isAdvanceTool("subagent") && isAdvanceTool("subagent_fork") && isAdvanceTool("subagent_claude_code") && isAdvanceTool("subagent_codex"));
ok("非执行体不命中", !isAdvanceTool("bash") && !isAdvanceTool("fetch") && !isAdvanceTool("subagentX") === false && !isAdvanceTool(""));

// 2. 决策纯函数
{
	let d = decideAdvance({ ...BASE, toolName: "bash" });
	ok("非执行体不推进", d.nudge === false && d.reason === "tool");
	d = decideAdvance({ ...BASE, toolName: "subagent", ledger: null });
	ok("无台账不推进", d.nudge === false && d.reason === "no-open-intents");
	d = decideAdvance({ ...BASE, toolName: "subagent", ledger: { total: 3, openIds: [], summaries: [] } });
	ok("无 open 意图不推进", d.nudge === false && d.reason === "no-open-intents");
	d = decideAdvance({ ...BASE, toolName: "subagent", usedTurns: 5 });
	ok("轮数上限封顶", d.nudge === false && d.reason === "turn-cap");
	d = decideAdvance({ ...BASE, toolName: "subagent", lastNudgeAt: 90000, now: 100000 });
	ok("冷却窗内不推进", d.nudge === false && d.reason === "cooldown");
	d = decideAdvance({ ...BASE, toolName: "subagent", lastNudgeAt: 90000, now: 130000 });
	ok("冷却窗外推进", d.nudge === true);
	d = decideAdvance(BASE);
	ok("常规推进", d.nudge === true && d.text.includes("[auto-advance]") && d.text.includes("3/3 未收口") && d.text.includes("i1,i2,i3"));
	ok("文案含收口指路与轮次", d.text.includes("intent_done") && d.text.includes("第 1/5 轮") && d.text.includes("人工输入随时接管"));
	ok("文案含不硬造方向", d.text.includes("不硬造方向"));
	d = decideAdvance({ ...BASE, hint: ["i1", "i2"] });
	ok("意图点名进文案", d.text.includes("本次执行疑似对应 i1, i2"));
}

// 2b. 模式语态注入
{
	ok("三模式语态全覆盖", Object.keys(MODE_VOICE).length === 3 && MODE_IDS.every((m) => MODE_VOICE[m]?.done && MODE_VOICE[m]?.next));
	const pt = decideAdvance({ ...BASE, voice: MODE_VOICE.pentest });
	ok("渗透推进语态：产出=漏洞证据/下一步=攻击面方向", pt.text.includes("漏洞发现或验证证据") && pt.text.includes("（下一攻击面或入口方向）"));
	ok("机制原子不随语态变", pt.text.includes("operation_progress") && pt.text.includes("operation_intent") && pt.text.includes("第 1/5 轮") && pt.text.includes("不硬造方向") && pt.text.includes("人工输入随时接管"));
	const au = decideAdvance({ ...BASE, voice: MODE_VOICE["code-audit"] });
	ok("代审推进语态：产出=finding 复现链/下一步=sink 面", au.text.includes("双链命中对账") && au.text.includes("下一模块或 sink 面"));
	const plain = decideAdvance(BASE);
	ok("无 voice 退通用文案（向后兼容）", plain.text.includes("intent_done 附产出指位 / intent_blocked 附原因") && plain.text.includes("派下一步或收工"));
}

// 2c. P1-1 轮次边界触发（纯函数面）
{
	const TE = { ...BASE, trigger: "turn-end", toolName: undefined };
	let d = decideAdvance(TE);
	ok("轮次边界触发：无工具名也可推进", d.nudge === true && d.text.includes("本轮已结束"));
	ok("轮次边界文案点明是内联执行场景", d.text.includes("内联执行场景") && d.text.includes("别停在半路"));
	d = decideAdvance({ ...BASE, trigger: "turn-end", toolName: "subagent" });
	ok("轮次边界触发不受工具名影响", d.nudge === true);
	d = decideAdvance({ ...BASE, trigger: "turn-end", ledger: null });
	ok("轮次边界同样受 opt-in 约束（无台账不推进）", d.nudge === false && d.reason === "no-open-intents");
	d = decideAdvance({ ...BASE, trigger: "turn-end", usedTurns: 5 });
	ok("轮次边界同样受轮数上限约束", d.nudge === false && d.reason === "turn-cap");
	d = decideAdvance({ ...BASE, trigger: "turn-end", lastNudgeAt: 90000, now: 100000 });
	ok("轮次边界同样受冷却约束", d.nudge === false && d.reason === "cooldown");
	d = decideAdvance({ ...BASE, toolName: "bash", trigger: undefined });
	ok("默认触发面仍是执行体（trigger 缺省向后兼容）", d.nudge === false && d.reason === "tool");
	ok("isAdvanceableTurnEnd 只认 completed", isAdvanceableTurnEnd({ kind: "completed" }) === true && isAdvanceableTurnEnd("completed") === true && isAdvanceableTurnEnd({ kind: "aborted", reason: "user" }) === false && isAdvanceableTurnEnd({ kind: "error" }) === false && isAdvanceableTurnEnd(undefined) === false);
	ok("isProgressTool：收口/派单/执行体算推进，开工登记类不算", isProgressTool("operation_progress") && isProgressTool("operation_intent") && isProgressTool("subagent_codex") && !isProgressTool("operation_goal") && !isProgressTool("operation_scope") && !isProgressTool("bash"));
}

// 3. 台账读取与意图提示（真实文件）
{
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aa-"));
	fs.writeFileSync(path.join(tmp, "operation-state.json"), JSON.stringify({ criteria: [{ id: "g1", status: "met" }], intents: [{ id: "i1", summary: "追注入", status: "open" }, { id: "i2", summary: "横向", status: "done" }] }));
	const ledger = readOpenIntents(tmp);
	ok("readOpenIntents 只列 open", ledger.openIds.join() === "i1" && ledger.total === 2);
	ok("readOpenIntents 无文件返回 null", readOpenIntents(path.join(tmp, "nope")) === null);
	fs.writeFileSync(path.join(tmp, "operation-state.json"), JSON.stringify({ criteria: [] }));
	ok("无 intents 键返回 null", readOpenIntents(tmp) === null);
	const hint = intentHintOf('{"prompt":"执行 i1 的注入点验证（意图 i1）+ 参考 i9"}', { openIds: ["i1"], summaries: ["i1:x"] });
	ok("意图提示限定 open 集", hint.join() === "i1");
	ok("无提及返回空", intentHintOf("{}", ledger).length === 0);
	fs.rmSync(tmp, { recursive: true, force: true });
}

// 4. 装配接线：fake ctx 全链路（事件→followup）+ 三护栏 + 真人重置
{
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aa-wire-"));
	fs.writeFileSync(path.join(tmp, "operation-state.json"), JSON.stringify({ criteria: [{ id: "g1", status: "met" }], intents: [{ id: "i1", summary: "追注入", status: "open" }] }));
	const mod = await import("../lib/index.js");
	const handlers = {};
	const followups = [];
	const fakeAgent = {
		ctx: {}, session: { id: "sx", header: { cwd: tmp, agentPreset: "pentest" } },
		followup: (m) => followups.push(m)
	};
	const agentsMap = new Map([["sx", fakeAgent]]);
	const fakeCtx = {
		on: (ev, fn) => { handlers[ev] = fn; },
		get: (svc) => (svc === "agents" ? { get: (id) => (id === "sx" ? fakeAgent : undefined) } : undefined),
		agentPresets: { composedPreset: () => "pentest" }
	};
	let threw = null;
	try { await mod.apply(fakeCtx, { cooldownMs: 200 }); } catch (e) { threw = e; }
	ok("apply 不抛", threw === null);
	ok("session/event 已接线", typeof handlers["session/event"] === "function");
	const call = async (name, callId, args = "{}") => { handlers["session/event"]({ id: "sx" }, { type: "tool/call", data: { name, callId, arguments: args } }); await tick(); };
	// 注入是**延后一拍**执行的（必须在 Session.append 临界区之外，见 lib/index.js 的说明），
	// 所以每条 result 之后都要把时钟推一格，否则断言看到的是「还没投递」。
	const tick = () => new Promise((r) => setTimeout(r, 0));
	const result = async (callId) => {
		handlers["session/event"]({ id: "sx" }, { type: "tool/result", data: { message: { source: { kind: "tool", callId }, content: [{ type: "text", text: "done" }] } } });
		await tick();
		await tick();
	};
	await call("subagent_claude_code", "c1", '{"prompt":"执行 i1 验证"}');
	await result("c1");
	ok("执行体返回注入推进", followups.length === 1 && followups[0].content[0].text.includes("[auto-advance]") && followups[0].content[0].text.includes("i1"));
	ok("followup 形态（role/source/id）", followups[0].role === "user" && followups[0].source.kind === "user" && typeof followups[0].id === "string");
	// 冷却窗：立即第二次返回不注入
	await call("subagent", "c2");
	await result("c2");
	ok("冷却窗抑制第二连发", followups.length === 1);
	// 非执行体不注入
	await call("bash", "c3");
	await result("c3");
	ok("非执行体返回不注入", followups.length === 1);
	// 真人消息重置计数；再推一轮成功
	handlers["agent/inbox/inserted"]({ agent: { id: "a", session: { id: "sx" } }, message: { id: "human-1", source: { kind: "user" }, content: "继续" } });
	await tick();
	await call("subagent", "c4");
	await result("c4");
	ok("真人重置后冷却仍生效（同窗）", followups.length === 1);
	// 冷却窗外：推进成功
	await new Promise((r) => setTimeout(r, 250));
	const t0 = Date.now();
	handlers["session/event"]({ id: "sx" }, { type: "user/message", data: { id: "human-2", source: { kind: "user" }, content: "好" } });
	await tick();
	await call("subagent", "c5");
	await result("c5");
	ok("冷却窗外第二次推进", followups.length === 2);
	// 自注入不重置（伪造我的 id）
	handlers["agent/inbox/inserted"]({ agent: { id: "a", session: { id: "sx" } }, message: { id: followups[1].id, source: { kind: "user" }, content: "自动" } });
	await tick();
	ok("config 默认值", Config({}).enable === true && Config({}).maxAutoTurns === 5 && Config({}).cooldownMs === 30000);
	fs.rmSync(tmp, { recursive: true, force: true });
}

// 5. 开工提醒（v0.2.0）：专业模式首条人类消息+无台账→一次性三登记提醒
{
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aa-kick-"));
	const mod = await import("../lib/index.js");
	const handlers = {};
	const followups = [];
	const fakeAgent = { ctx: {}, session: { id: "sk", header: { cwd: tmp, agentPreset: "pentest" } }, followup: (m) => followups.push(m) };
	const fakeCtx = {
		on: (ev, fn) => { handlers[ev] = fn; },
		get: () => ({ get: (id) => (id === "sk" ? fakeAgent : undefined) }),
		agentPresets: { composedPreset: () => "pentest" }
	};
	await mod.apply(fakeCtx, {});
	const human = async (id) => { handlers["agent/inbox/inserted"]({ agent: fakeAgent, message: { id, source: { kind: "user" }, content: "测一下这个站" } }); await tick(); };
	await human("h1");
	ok("无台账时注入开工提醒", followups.length === 1 && followups[0].content[0].text.includes("开工三登记") && followups[0].content[0].text.includes("operation_constraints"));
	await human("h2");
	ok("每会话只提醒一次", followups.length === 1);
	// 明确“只回复/不要调用工具”不能再追加一轮，避免直接违背用户指令。
	const noToolFollowups = [];
	const noToolAgent = { ctx: {}, session: { id: "sk-no-tool", header: { cwd: tmp, agentPreset: "pentest" } }, followup: (m) => noToolFollowups.push(m) };
	const noToolCtx = {
		on: (ev, fn) => { handlers[ev] = fn; },
		get: () => ({ get: (id) => (id === "sk-no-tool" ? noToolAgent : undefined) }),
		agentPresets: { composedPreset: () => "pentest" }
	};
	await mod.apply(noToolCtx, {});
	handlers["agent/inbox/inserted"]({ agent: noToolAgent, message: { id: "h-no-tool", source: { kind: "user" }, content: "只回复 OK。不要调用任何工具。" } });
	await tick();
	ok("用户要求单句回复且禁工具时不注入 kickoff", noToolFollowups.length === 0);
	const englishFollowups = [];
	const englishAgent = { ctx: {}, session: { id: "sk-en", header: { cwd: tmp, agentPreset: "pentest" } }, followup: (m) => englishFollowups.push(m) };
	const englishCtx = {
		on: (ev, fn) => { handlers[ev] = fn; },
		get: () => ({ get: (id) => (id === "sk-en" ? englishAgent : undefined) }),
		agentPresets: { composedPreset: () => "pentest" }
	};
	await mod.apply(englishCtx, {});
	handlers["agent/inbox/inserted"]({ agent: englishAgent, message: { id: "h-en", source: { kind: "user" }, content: "Only reply OK. Do not call any tools." } });
	await tick();
	ok("英文单句回复/禁工具同样跳过", englishFollowups.length === 0);
	// 已有台账：不提醒
	const followups2 = [];
	const fakeAgent2 = { ctx: {}, session: { id: "sk2", header: { cwd: tmp, agentPreset: "pentest" } }, followup: (m) => followups2.push(m) };
	const fakeCtx2 = { on: (ev, fn) => { handlers[ev] = fn; }, get: () => ({ get: (id) => (id === "sk2" ? fakeAgent2 : undefined) }), agentPresets: { composedPreset: () => "pentest" } };
	fs.writeFileSync(path.join(tmp, "operation-state.json"), JSON.stringify({ criteria: [{ id: "g1", status: "met" }] }));
	await mod.apply(fakeCtx2, {});
	handlers["agent/inbox/inserted"]({ agent: fakeAgent2, message: { id: "h3", source: { kind: "user" }, content: "继续" } });
	await tick();
	ok("已有台账不提醒", followups2.length === 0);
	// kickoff 关闭
	const followups3 = [];
	const fakeCtx3 = { on: (ev, fn) => { handlers[ev] = fn; }, get: () => ({ get: () => undefined }), agentPresets: { composedPreset: () => "pentest" } };
	const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "aa-kick2-"));
	const fakeAgent3 = { ctx: {}, session: { id: "sk3", header: { cwd: tmp2 } }, followup: (m) => followups3.push(m) };
	fakeCtx3.get = () => ({ get: (id) => (id === "sk3" ? fakeAgent3 : undefined) });
	await mod.apply(fakeCtx3, { kickoff: false });
	handlers["agent/inbox/inserted"]({ agent: fakeAgent3, message: { id: "h4", source: { kind: "user" }, content: "x" } });
	await tick();
	ok("kickoff=false 关闭", followups3.length === 0);
	fs.rmSync(tmp, { recursive: true, force: true });
	fs.rmSync(tmp2, { recursive: true, force: true });
}

// 4b. kickoff 模式化（v0.3.0）：文案含本模式拆分理论
{
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aa-kickm-"));
	const mod = await import("../lib/index.js");
	const handlers = {};
	for (const mode of ["pentest", "code-audit"]) {
		const followups = [];
		const fakeAgent = { ctx: {}, session: { id: "sk-" + mode, header: { cwd: tmp, agentPreset: mode } }, followup: (m) => followups.push(m) };
		const fakeCtx = { on: (ev, fn) => { handlers[ev] = fn; }, get: () => ({ get: (id) => (id === "sk-" + mode ? fakeAgent : undefined) }), agentPresets: { composedPreset: () => mode } };
		await mod.apply(fakeCtx, {});
		// 注意：内容不能太短——插件有"试水消息不打搅"规则（<6 字跳过 kickoff），
		// 早期用例发 "x" 会被判为试水而静默跳过，导致断言假失败。
		handlers["agent/inbox/inserted"]({ agent: fakeAgent, message: { id: "h-" + mode, source: { kind: "user" }, content: "对这个目标做一次完整的渗透测试" } });
		await tick();
		if (mode === "pentest") {
			ok("kickoff 含 pentest 拆分理论", followups.length === 1 && followups[0].content[0].text.includes("作战流程×资产×漏洞类矩阵") && followups[0].content[0].text.includes("准则按"));
			ok("kickoff 含分母语义", followups[0].content[0].text.includes("入口资产面"));
		}
		if (mode === "code-audit") ok("kickoff 含 audit 理论", followups.length === 1 && followups[0].content[0].text.includes("模块×sink"));
	}
	fs.rmSync(tmp, { recursive: true, force: true });
}

// 4c. P1-1 接线：轮次边界触发 + 已推进不催 + 非正常收尾不催 + 护栏未削弱
{
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aa-te-"));
	fs.writeFileSync(path.join(tmp, "operation-state.json"), JSON.stringify({ criteria: [], intents: [{ id: "i1", summary: "追注入", status: "open" }] }));
	const mod = await import("../lib/index.js");
	const handlers = {};
	const followups = [];
	const fakeAgent = { ctx: {}, session: { id: "st", header: { cwd: tmp, agentPreset: "pentest" } }, followup: (m) => followups.push(m) };
	const fakeCtx = {
		on: (ev, fn) => { handlers[ev] = fn; },
		get: () => ({ get: (id) => (id === "st" ? fakeAgent : undefined) }),
		agentPresets: { composedPreset: () => "pentest" }
	};
	await mod.apply(fakeCtx, { cooldownMs: 0 }); // 本块专测触发面，冷却归零
	const ev = async (type, data) => { handlers["session/event"]({ id: "st" }, { type, data }); await tick(); };
	await ev("turn/start", { turn: 1 });
	await ev("turn/end", { turn: 1, reason: { kind: "completed" } });
	ok("轮次边界触发：内联执行（不派子代理）也催", followups.length === 1 && followups[0].content[0].text.includes("本轮已结束") && followups[0].content[0].text.includes("i1"));
	// 本轮已推进 → 不催
	await ev("turn/start", { turn: 2 });
	await ev("tool/call", { name: "operation_progress", callId: "p1", arguments: "{}" });
	await ev("turn/end", { turn: 2, reason: { kind: "completed" } });
	ok("本轮已推进（operation_progress）则不再催", followups.length === 1);
	// 执行体返回过的轮次也不重复催（同一轮两条触发面只响一次）
	await ev("turn/start", { turn: 3 });
	await ev("tool/call", { name: "subagent", callId: "s1", arguments: '{"prompt":"i1"}' });
	await ev("tool/result", { message: { source: { kind: "tool", callId: "s1" }, content: [{ type: "text", text: "done" }] } });
	ok("执行体返回时先催一次", followups.length === 2);
	await ev("turn/end", { turn: 3, reason: { kind: "completed" } });
	ok("同一轮内已因执行体返回催过，轮次边界不重复催", followups.length === 2);
	// 非正常收尾不催
	await ev("turn/start", { turn: 4 });
	await ev("turn/end", { turn: 4, reason: { kind: "aborted", reason: "user" } });
	ok("用户取消的轮次不催（人已接管）", followups.length === 2);
	await ev("turn/start", { turn: 5 });
	await ev("turn/end", { turn: 5, reason: { kind: "error", error: { message: "boom" } } });
	ok("报错的轮次不催（先解决当下问题）", followups.length === 2);
	await ev("turn/start", { turn: 6 });
	await ev("turn/end", { turn: 6, reason: { kind: "max-tokens" } });
	ok("超限的轮次不催", followups.length === 2);
	// 护栏未削弱：轮数上限仍然封顶（used 已是 2）
	// 注入延后一拍 → 每一步都要推时钟，否则 followups 还没涨就被断言（上限守卫会假红）
	for (let t = 7; t <= 12; t++) {
		await ev("turn/start", { turn: t });
		await ev("turn/end", { turn: t, reason: { kind: "completed" } });
	}
	ok("轮数上限护栏未被削弱（maxAutoTurns=5 封顶）", followups.length === 5);
	// 真人消息重置计数后再推一轮
	handlers["agent/inbox/inserted"]({ agent: { id: "a", session: { id: "st" } }, message: { id: "h-te", source: { kind: "user" }, content: "继续" } });
	await tick();
	await ev("turn/start", { turn: 13 });
	await ev("turn/end", { turn: 13, reason: { kind: "completed" } });
	ok("真人接管后计数重置、可继续推进", followups.length === 6);
	// 开关
	const f2 = [];
	const agent2 = { ctx: {}, session: { id: "st2", header: { cwd: tmp, agentPreset: "pentest" } }, followup: (m) => f2.push(m) };
	const ctx2 = { on: (ev2, fn) => { handlers[ev2] = fn; }, get: () => ({ get: (id) => (id === "st2" ? agent2 : undefined) }), agentPresets: { composedPreset: () => "pentest" } };
	await mod.apply(ctx2, { cooldownMs: 0, advanceOnTurnEnd: false });
	handlers["session/event"]({ id: "st2" }, { type: "turn/start", data: {} });
	await tick();
	handlers["session/event"]({ id: "st2" }, { type: "turn/end", data: { reason: { kind: "completed" } } });
	await tick();
	ok("advanceOnTurnEnd=false 关闭轮次边界触发", f2.length === 0);
	ok("Config 默认开启轮次边界触发", Config({}).advanceOnTurnEnd === true);
	// 无台账：轮次边界零干扰
	const f3 = [];
	const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), "aa-te3-"));
	const agent3 = { ctx: {}, session: { id: "st3", header: { cwd: tmp3, agentPreset: "pentest" } }, followup: (m) => f3.push(m) };
	const ctx3 = { on: (ev3, fn) => { handlers[ev3] = fn; }, get: () => ({ get: (id) => (id === "st3" ? agent3 : undefined) }), agentPresets: { composedPreset: () => "pentest" } };
	await mod.apply(ctx3, { cooldownMs: 0, kickoff: false });
	handlers["session/event"]({ id: "st3" }, { type: "turn/start", data: {} });
	await tick();
	handlers["session/event"]({ id: "st3" }, { type: "turn/end", data: { reason: { kind: "completed" } } });
	await tick();
	ok("无台账会话轮次边界零干扰", f3.length === 0);
	fs.rmSync(tmp, { recursive: true, force: true });
	fs.rmSync(tmp3, { recursive: true, force: true });
}

// 4d. agent/disposed 载荷形状：会话销毁真的清掉状态（早先取错载荷 → Map 只增不减）
{
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aa-dis-"));
	fs.writeFileSync(path.join(tmp, "operation-state.json"), JSON.stringify({ criteria: [], intents: [{ id: "i1", summary: "追注入", status: "open" }] }));
	const mod = await import("../lib/index.js");
	const handlers = {};
	const followups = [];
	const agent = { ctx: {}, session: { id: "sd", header: { cwd: tmp, agentPreset: "pentest" } }, followup: (m) => followups.push(m) };
	const ctx = { on: (ev, fn) => { handlers[ev] = fn; }, get: () => ({ get: (id) => (id === "sd" ? agent : undefined) }), agentPresets: { composedPreset: () => "pentest" } };
	await mod.apply(ctx, { cooldownMs: 0, kickoff: false });
	const ev = async (type, data) => { handlers["session/event"]({ id: "sd" }, { type, data }); await tick(); };
	for (let t = 1; t <= 5; t++) {
		await ev("turn/start", { turn: t });
		await ev("turn/end", { turn: t, reason: { kind: "completed" } });
	}
	ok("会话内轮数上限封顶（基线 5）", followups.length === 5);
	await ev("turn/start", { turn: 6 });
	await ev("turn/end", { turn: 6, reason: { kind: "completed" } });
	ok("到达上限后不再催（基线）", followups.length === 5);
	handlers["agent/disposed"]({ agent });
	await tick();
	ok("销毁回调未抛错", true);
	await ev("turn/start", { turn: 1 });
	await ev("turn/end", { turn: 1, reason: { kind: "completed" } });
	ok("agent/disposed 载荷 {agent} 被解包→状态清空、同 sid 可重新计数", followups.length === 6);
	fs.rmSync(tmp, { recursive: true, force: true });
}

// 5. 模式清单：三模式（pentest / code-audit / ctf-solver）；redteam 仍是已归档模式，继续排除
ok("三模式清单", MODE_IDS.length === 3 && MODE_IDS.includes("pentest") && MODE_IDS.includes("code-audit") && MODE_IDS.includes("ctf-solver") && !MODE_IDS.includes("redteam"));

// ── 注入契约（源码级）────────────────────────────────────────────────────
// 缺陷不在决策逻辑，而在「注入发生在 Session.append 的发布临界区内」这一**宿主约束**：
// 该事件由 Session.append 在发布临界区内同步派发，在临界区里再触发 append 会被拒绝
// （Error: session append cannot reenter while another append is being published）。
// 原来把这个异常 catch{} 掉了 —— 于是「轮次边界催办」从未生效（实测 10 个会话注入落地 0 次，
// 而走 agent/inbox/inserted 的开工提醒落地 6 次）。所以下面几条是硬约束。
{
	const raw = fs.readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
	// 断言前**剥掉注释**：注释里经常会引用「旧写法长什么样」来做说明，
	// 直接拿原文匹配会把这些引用当成残留代码（踩过两次：setTimeout 与 catch 各一次）。
	const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
	ok("tryNudge 的注入被 setTimeout 延后（离开 Session.append 临界区）",
		/setTimeout\(\(\) => \{\r?\n\s*const ok = deliver\(/.test(src));
	ok("投递失败走可见出口（不再静默吞错）",
		src.includes("noteInjectFailure") && src.includes("[auto-advance] 推进提醒注入失败"));
	ok("不再有 catch { /* 注入失败不重试 */ } 的旧写法",
		!/catch \{ \/\* 注入失败不重试/.test(src));
	ok("冷却窗按尝试推进、预算只按成功投递计数（失败不白耗预算，但重试仍被节流）",
		src.includes("state.set(sid, { used: st.used, lastAt: Date.now() })")
			&& src.includes("if (!ok) return;")
			&& src.includes("used: cur.used + 1, lastAt: cur.lastAt"));
	ok("开工提醒与催办共用同一个 deliver（两条路不再各自漂移）",
		/deliver\(agent, id, kickoffText\(mode\)\)/.test(src));
	ok("readOpenIntents 只认 operation-state 的 intents 字段（criteria 不是意图）",
		src.includes("Array.isArray(st.intents)"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
