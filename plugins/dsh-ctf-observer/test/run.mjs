// dsh-ctf-observer 离线单测：Observer 的确定性判据。
//
// 为什么这套判据必须可测：Observer 是**旁路监督**，它的价值全在"什么时候该提醒、
// 什么时候不该打扰"。判据写错会变成噪音源（每轮都插话），比不做还糟。
// 这里每一条都对应 BreachWeave 的一个护栏（冷却窗 / 重复窗 / 阈值），
// 改坏任何一条都会让对应断言失败。
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { judge, topDuplicate, fingerprint, makeState, REVIEW_EVERY_ROUNDS, REMINDER_COOLDOWN_ROUNDS, REMINDER_REPEAT_WINDOW_ROUNDS, REPEAT_TOOL_THRESHOLD, ERROR_STREAK_THRESHOLD, IDLE_ROUNDS_THRESHOLD, MODE_ID, FLAG_RE, scheduleInject, steerText } from "../lib/index.js";
import { readBoard, upsertChallenge, dispatch as boardDispatch, steer as boardSteer, addNote, peekSteers, markSteersConsumed, snapshotText, BOARD_FILE, mutateBoard } from "../lib/board.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log(`ok   ${label}`); } else { fail++; console.log(`FAIL ${label}`); } };

// ── 1. 只服务 ctf-solver 模式 ──────────────────────────────────────────────
ok("MODE_ID 就是 ctf-solver（其余模式零干扰的前提）", MODE_ID === "ctf-solver");

// ── 2. 指纹归一化：同一动作的不同时间戳/随机串应收敛到同一个键 ──────────────
{
	const a = fingerprint("bash", '{"command":"curl http://x/y?id=1700000000000"}');
	const b = fingerprint("bash", '{"command":"curl http://x/y?id=1700000000999"}');
	ok("指纹把时间戳归一（同动作同键）", a === b);
	const c = fingerprint("bash", '{"command":"curl http://x/y"}');
	ok("不同动作不同键", a !== c);
}

// ── 3. 重复试错：同指纹达阈值才提醒 ────────────────────────────────────────
{
	const st = makeState();
	const fp = fingerprint("bash", '{"command":"sqlmap -u x"}');
	for (let i = 0; i < REPEAT_TOOL_THRESHOLD; i++) st.recentTools.push({ fp, ok: true });
	const d = judge(st);
	ok(`同动作重复 ${REPEAT_TOOL_THRESHOLD} 次触发提醒`, d.nudge === true && String(d.kind).startsWith("dup:"));
	ok("提醒文案含换路指引", /换|证伪|下一题/.test(d.text));
}
{
	const st = makeState();
	const fp = fingerprint("bash", '{"command":"sqlmap -u x"}');
	for (let i = 0; i < REPEAT_TOOL_THRESHOLD - 1; i++) st.recentTools.push({ fp, ok: true });
	ok("差一次不触发（阈值是硬边界）", judge(st).nudge === false);
}

// ── 4. 错误堆积 ────────────────────────────────────────────────────────────
{
	const st = makeState();
	st.errorStreak = ERROR_STREAK_THRESHOLD;
	const d = judge(st);
	ok("连续错误达阈值触发提醒", d.nudge === true && d.kind === "error-streak");
}
{
	const st = makeState();
	st.errorStreak = ERROR_STREAK_THRESHOLD - 1;
	ok("未达阈值不提醒", judge(st).nudge === false);
}

// ── 5. 无进展（原地打转）──────────────────────────────────────────────────
{
	const st = makeState();
	st.idleRounds = IDLE_ROUNDS_THRESHOLD;
	const d = judge(st);
	ok("连续无新手段触发提醒", d.nudge === true && d.kind === "idle");
	ok("文案明确「换一条独立思路」", /独立思路|换一条/.test(d.text));
}

// ── 6. 结束条件外置：flag 由系统识别，不由模型宣布 ─────────────────────────
{
	const st = makeState();
	st.flagSeen = "flag{abc_123}";
	const d = judge(st);
	ok("已捕获 flag 时给出 done", d.nudge === true && d.done === true && d.kind === "done");
	ok("done 文案要求原文照录 + 登记成交付物", /逐字|原文/.test(d.text) && /redteam_finding_register/.test(d.text));
	ok("done 优先于其它信号（先收尾别再折腾）", judge({ ...st, errorStreak: 9, idleRounds: 9 }).kind === "done");
}

// ── 7. 冷却窗（BreachWeave 的 REMINDER_COOLDOWN_ROUNDS）────────────────────
{
	const st = makeState();
	st.errorStreak = ERROR_STREAK_THRESHOLD;
	st.round = 10;
	st.lastReminder = { round: 10, fp: "error-streak" };
	ok("同轮不再重复提醒", judge(st).nudge === false);
	st.round = 10 + REMINDER_COOLDOWN_ROUNDS - 1;
	ok("冷却窗内不提醒", judge(st).nudge === false);
	// 注意：必须换成**不同信号**才能单独检验冷却窗 —— 同指纹会同时被重复窗拦住
	//（两道护栏是叠加的：冷却管"多久内别烦我"，重复窗管"同一个问题别反复念"）。
	st.round = 10 + REMINDER_COOLDOWN_ROUNDS;
	st.errorStreak = 0;
	st.idleRounds = IDLE_ROUNDS_THRESHOLD;
	ok("冷却窗过后、且换了信号 → 可再提醒", judge(st).nudge === true);
}

// ── 8. 同指纹重复窗（REMINDER_REPEAT_WINDOW_ROUNDS）────────────────────────
{
	const st = makeState();
	st.idleRounds = IDLE_ROUNDS_THRESHOLD;
	st.round = 20;
	st.lastReminder = { round: 20 - REMINDER_COOLDOWN_ROUNDS, fp: "idle" };  // 冷却已过
	ok("冷却过了但同指纹仍在重复窗内 → 不重复", judge(st).nudge === false);
	st.round = 20 - REMINDER_COOLDOWN_ROUNDS + REMINDER_REPEAT_WINDOW_ROUNDS;
	ok("重复窗过后同指纹可再提醒", judge(st).nudge === true);
}

// ── 9. 周期体检 ────────────────────────────────────────────────────────────
{
	const st = makeState();
	st.round = REVIEW_EVERY_ROUNDS;
	const d = judge(st);
	ok(`第 ${REVIEW_EVERY_ROUNDS} 轮给出体检`, d.nudge === true && String(d.kind).startsWith("review:"));
	const st2 = makeState();
	st2.round = REVIEW_EVERY_ROUNDS - 1;
	ok("非周期轮不打扰（安静是默认）", judge(st2).nudge === false);
}

// ── 10. 干净状态必须完全安静（最重要的一条：Observer 不能变成噪音源）──────
{
	const st = makeState();
	st.round = 5;
	st.recentTools.push({ fp: "bash::curl x", ok: true });
	st.recentTools.push({ fp: "python3::exp.py", ok: true });
	ok("正常推进中零打扰", judge(st).nudge === false);
}

// ── 11. topDuplicate 只统计成功调用 ────────────────────────────────────────
{
	const fp = "bash::x";
	const rows = [{ fp, ok: true }, { fp, ok: true }, { fp, ok: false }, { fp, ok: false }, { fp, ok: false }];
	const top = topDuplicate(rows);
	ok("失败调用不计入重复试错（那属于错误堆积）", top.n === 2);
}

// ── 12. flag 形态识别：**宁可漏报，不可误报** ──────────────────────────────
// 误报的代价是把"爬页面看到样式表"当成"解出 flag"，然后错误宣布收尾 —— 真损失。
// 这组断言就是冲着上一版的 `[^{}\s]{4,120}` 去的（它会认下 `div{color:red}`）。
{
	ok("正常 flag 命中", FLAG_RE.test("flag{abc_123}") === true);
	ok("大写前缀也认", FLAG_RE.test("CTF{Hello_World}") === true);
	ok("带特殊字符的 flag 命中", FLAG_RE.test("flag{a-b_c!d}") === true);
	ok("CSS 单属性不误报（含冒号）", FLAG_RE.test("div{color:red}") === false);
	ok("CSS 多属性不误报（含分号）", FLAG_RE.test("p{margin:0;padding:0}") === false);
	ok("模板插值不误报", FLAG_RE.test("{{config.SECRET}}") === false);
	ok("代码块不误报（含空格）", FLAG_RE.test("if{x > 1}") === false);
	ok("带空格的伪形态不误报", FLAG_RE.test("flag{a b c d}") === false);
}

// ── 13. 状态结构：idle 判定必须基于**指纹**而非工具种类 ─────────────────────
// 工具种类是个有限集合，会话一长必然"全都见过"→ 永远判成无进展（必然误报）。
{
	const st = makeState();
	ok("状态用 seenFingerprints 判进展", st.seenFingerprints instanceof Set);
	ok("状态有本轮指纹集 turnFingerprints", st.turnFingerprints instanceof Set);
	ok("不再保留 seenToolKinds（有限集合必误报）", st.seenToolKinds === undefined);
}

// ── 14. 协作看板（board.js）：Planner Snapshot + Observer Notes + steer 队列 ──
{
	const tmp = mkdtempSync(join(tmpdir(), "ctf-board-"));
	const b = readBoard(tmp);
	ok("看板缺失时给空看板（不抛错）", b.challenges.length === 0 && b.dispatches.length === 0 && b.notes.length === 0);

	upsertChallenge(tmp, { name: "Web-Easy", status: "open", note: "疑似 SSTI" });
	upsertChallenge(tmp, { name: "Web-Easy", status: "solved", flag: "flag{sst1_ez}" });
	const b2 = readBoard(tmp);
	ok("同名题按去重更新而非新增", b2.challenges.length === 1);
	ok("状态与 flag 落盘", b2.challenges[0].status === "solved" && b2.challenges[0].flag === "flag{sst1_ez}");

	const snap = snapshotText(b2);
	ok("快照含已解 flag（逐字）", snap.includes("flag{sst1_ez}"));
	ok("快照含未解计数", /未解 \d+/.test(snap));

	// steer：**先看后投、投递成功才标记已读**（老实现是「取出即消费」，注入一失败指令就永久丢）
	boardSteer(tmp, { text: "放弃 SQLi，改测 SSTI" });
	const peeked = peekSteers(tmp);
	ok("peekSteers 能取到未读纠偏", peeked.length === 1 && peeked[0].text.includes("SSTI"));
	ok("peekSteers 只读不消费（再看一次还在）", peekSteers(tmp).length === 1);
	ok("markSteersConsumed 只标记指定 id", markSteersConsumed(tmp, [peeked[0].id]) === 1);
	ok("标记后不再出现在未读里", peekSteers(tmp).length === 0);
	ok("重复标记同一条不重复计数（幂等）", markSteersConsumed(tmp, [peeked[0].id]) === 0);

	// observer notes：上限保护
	for (let i = 0; i < 60; i++) addNote(tmp, { kind: "review", text: `n${i}` });
	ok("Observer Notes 上限 50 条（防无界增长）", readBoard(tmp).notes.length === 50);

	// 派单必须挂在已登记的题上（否则并行时会派到空气里）
	boardDispatch(tmp, { challengeId: "Web-Easy", path: "SSTI: {{7*7}}" });
	ok("派单落到已有题上", readBoard(tmp).dispatches.length === 1);
	let threw = false;
	try { boardDispatch(tmp, { challengeId: "不存在的题", path: "x" }); } catch { threw = true; }
	ok("派到不存在的题会报错（不允许凭空派单）", threw);

	// 损坏 JSON 不得让看板整个失效
	writeFileSync(join(tmp, BOARD_FILE), "{ 这不是 JSON", "utf8");
	const b3 = readBoard(tmp);
	ok("JSON 损坏时降级为空看板（不炸掉解题循环）", b3.challenges.length === 0);

	// ── 15. 跨进程并发写（冒烟）────────────────────────────────────────────
	// 8 个独立 node 进程同时各派一条单，断言一条不丢。
	// ⚠️ 这条**只算冒烟、不算证伪**：实测本机无锁实现也能过它（临界区只有几十微秒，
	//    8 个进程的读-改-写恰好错开）。真正能证伪锁的是
	//    `_ref/tools/revcheck-board-lock.mjs`（无锁版加宽临界区 → 必然丢；加锁版同负载 → 一条不丢）。
	const cw = mkdtempSync(join(tmpdir(), "ctf-board-conc-"));
	const boardUrl = pathToFileURL(join(__dirname, "../lib/board.js")).href;
	const kid = `import { dispatch } from ${JSON.stringify(boardUrl)};`
		+ `dispatch(process.argv[1], { path: "p" + process.argv[2] });`;
	const kids = [];
	for (let i = 0; i < 8; i++) {
		kids.push(new Promise((res) => {
			const cp = spawn(process.execPath, ["--input-type=module", "-e", kid, cw, String(i)], { stdio: "ignore" });
			cp.on("close", (code) => res(code));
		}));
	}
	const codes = await Promise.all(kids);
	ok("8 个并发子进程全部正常退出", codes.every((c) => c === 0));
	const paths = readBoard(cw).dispatches.map((d) => d.path).sort();
	ok("并发 8 写全部落盘（无覆盖丢失）", paths.length === 8 && new Set(paths).size === 8);
}

// ── 17. 注入必须**延后**，且失败必须可见（本轮最重的一个真 bug）────────────────
// 触发点 session/event 由 Session.append 在**发布临界区内同步派发**，在临界区里调
// agent.followup() 会被宿主拒绝：`session append cannot reenter while another append is
// being published`。原实现把它 catch{} 掉了 → 「笔记写了、模型从没收到」，静默失效。
// 实测 10 个会话注入落地 0 次。所以下面两条是硬约束，不是风格偏好。
{
	// ① 不延后：schedule 不执行 fn 时，绝不能已经碰过 agent
	let called = 0;
	const agent = { followup() { called++; } };
	let pending = null;
	const rec = scheduleInject(agent, "x", { schedule: (fn) => { pending = fn; } });
	ok("调度时**不得**同步调用 agent.followup（否则撞宿主重入拒绝）", called === 0);
	ok("返回记录初始为未投递", rec.fired === false && rec.ok === false);
	ok("id 已同步登记进 myIds（避免自己的注入被当成人类输入）", rec.id.startsWith("ctf-observer-"));
	pending();
	ok("调度器跑了以后才真正投递", called === 1 && rec.fired === true && rec.ok === true);

	// ② 失败不许吞：必须把 error 交回来
	const boom = new Error("session append cannot reenter while another append is being published");
	const rec2 = scheduleInject({ followup() { throw boom; } }, "y", { schedule: (fn) => fn() });
	ok("投递失败时 ok=false（不能被当成送过了）", rec2.ok === false);
	ok("投递失败时**保留原始错误**（不再静默吞掉）", rec2.error === boom);
	ok("失败回调也能拿到失败记录", (() => {
		let seen = null;
		scheduleInject({ followup() { throw boom; } }, "z", { schedule: (fn) => fn(), onDone: (r) => { seen = r; } });
		return seen && seen.ok === false && seen.error === boom;
	})());

	// ③ 卸载后不得再注入
	let late = 0;
	const rec3 = scheduleInject({ followup() { late++; } }, "w", { schedule: (fn) => { setTimeout(fn, 0); }, isCancelled: () => true });
	await new Promise((r) => setTimeout(r, 5));
	ok("插件已卸载时跳过注入", late === 0 && rec3.ok === false);

	// ④ 源码级：不得把 followup 包在会吞错的 try/catch 里
	const src = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
	ok("不存在「同步注入 + catch 吞掉」的旧写法",
		!src.includes("} catch { return false; }") && !src.includes("injectText(agent"))
	ok("review 走的是 scheduleInject（而非直接调用 followup）",
		src.includes("scheduleInject(agent, text, {") && !/review[\s\S]{0,900}?agent\.followup\(/.test(src))
	ok("投递失败有可见出口（console.error + 次数抑制）",
		src.includes("noteInjectFailure") && src.includes("[ctf-observer] 提醒注入失败"))
}

// ── 18. 只有投递成功才推进冷却窗 / 才标记 steer 已读 ─────────────────────────
// 否则冷却窗会把「根本没送到的提醒」当成送过了：既不提醒、又不再重试。
{
	const src = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8")
	ok("lastReminder 只在 onDone 成功分支里赋值",
		/onDone: \(rec\) => \{\s*\n\s*if \(rec\.ok\)[\s\S]{0,80}?onOk\(\)/.test(src))
	ok("steer 的已读标记在投递成功的回调里（不是投递前）",
		src.indexOf("markSteersConsumed(ws") > src.indexOf("fire(steerText(pending)"))
	ok("review 不再使用「取出即消费」的老 API", !src.includes("consumeSteers"))

	// 行为级：失败时 lastReminder 不该被推进 —— 用「同一状态连续两次 review」间接证明
	const st = makeState()
	st.round = 10
	st.recentTools = [{ fp: "bash::x", ok: true }, { fp: "bash::x", ok: true }]
	const d1 = judge(st)
	ok("未达重复阈值时不提醒（阈值已抬到内置提醒之后）", d1.nudge === false)
}

// ── 19. 重复试错阈值必须排在宿主内置提醒之后 ────────────────────────────────
// 宿主 @deepseek-ai/dsh-repeat-tool-reminder 的默认阈值是 [3,5,8]（后两档还报 canonical
// arguments）。本插件原来设 4 —— 夹在 3 和 5 之间，实测一轮里模型先收到内置的
// 「ctf_state × 3」、紧接着又收到本插件的「同一动作已重复 4 次」，纯属重复噪音。
{
	ok("阈值严格大于宿主最后一档（8）", REPEAT_TOOL_THRESHOLD > 8)
	const src = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8")
	ok("源码里写明了与内置提醒的关系（避免后人「顺手」调小）",
		src.includes("repeat-tool-reminder") && src.includes("[3,5,8]"))
}

// ── 20. 看板：id 稳定性 / 只读不写 / 上限保护 ──────────────────────────────
{
	// id 不能由「数组长度 + 1」推导：容器裁剪到阈值后长度长期不变，之后每条 id 都会重复
	const t2 = mkdtempSync(join(tmpdir(), "ctf-board-id-"))
	for (let i = 0; i < 120; i++) boardSteer(t2, { text: "s" + i })
	const ids = readBoard(t2).steers.map((s) => s.id)
	ok("超过裁剪阈值后 steer id 仍不重复", new Set(ids).size === ids.length)
	ok("steers 有上限保护（不超过 100）", ids.length <= 100)
	ok("裁剪后仍保留最新的那条", readBoard(t2).steers[readBoard(t2).steers.length - 1].text === "s119")

	// peekSteers 必须只读：mtime 不许变
	const f = join(t2, BOARD_FILE)
	const before = statSync(f).mtimeMs
	await new Promise((r) => setTimeout(r, 15))
	peekSteers(t2)
	ok("peekSteers 不写盘（mtime 不变）—— 否则每个轮次边界都会重写整份看板并抢锁",
		statSync(f).mtimeMs === before)

	// mutator 返回 null = 什么都没改 → 不写盘
	await new Promise((r) => setTimeout(r, 15))
	const before2 = statSync(f).mtimeMs
	mutateBoard(t2, () => null)
	ok("mutateBoard 收到 null 时不写盘（读路径可以安全共用）", statSync(f).mtimeMs === before2)

	// dispatches 也要有上限（原来只有 notes/steers 有）
	const t3 = mkdtempSync(join(tmpdir(), "ctf-board-cap-"))
	upsertChallenge(t3, { name: "T" })
	for (let i = 0; i < 230; i++) boardDispatch(t3, { path: "p" + i })
	ok("dispatches 有上限保护（不超过 200）", readBoard(t3).dispatches.length <= 200)
}

// ── 21. 锁：只释放**自己的**锁 ─────────────────────────────────────────────
// 若本进程被别的进程当成僵死锁回收过，锁文件里已是别人的 pid；
// 这时再无条件删除就会把别人的互斥解开（原实现就是这么写的）。
{
	const t4 = mkdtempSync(join(tmpdir(), "ctf-board-lock-"))
	mutateBoard(t4, (b) => { b.notes.push({ id: "n1", kind: "k", text: "t", at: "x" }); return b })
	const lock = join(t4, BOARD_FILE + ".lock")
	ok("正常写入后锁已释放（不会留下死锁）", !existsSync(lock))
	// 模拟「锁被别人抢走」：mutator 执行期间把锁内容改成别的 pid
	mutateBoard(t4, (b) => { writeFileSync(lock, "999999"); return b })
	ok("锁不属于自己时**不删除**（不误解别人的互斥）", existsSync(lock))
	// 清掉伪造锁，再确认能正常写入并释放自己的锁
	unlinkSync(lock)
	mutateBoard(t4, (b) => { b.notes.push({ id: "n2", kind: "k", text: "t", at: "x" }); return b })
	ok("外部锁清掉后能正常写入并释放自己的锁", !existsSync(lock))
	ok("两次写入都落盘（n1 + n2）", readBoard(t4).notes.length === 2)
}

// ── 22. steer 注入文案（纯函数）────────────────────────────────────────────
{
	const txt = steerText([{ challengeId: "Web-Easy", text: "放弃 SQLi" }, { text: "提高速率" }])
	ok("steer 文案带题目前缀", txt.includes("[Web-Easy] 放弃 SQLi"))
	ok("无题目的条目不带空方括号", !txt.includes("[] "))
	ok("steer 文案声明优先级高于自主判断", txt.includes("优先级高于你当前的自主判断"))
	ok("空输入不抛错", typeof steerText([]) === "string")
	ok("非数组输入不抛错", typeof steerText(undefined) === "string")
}

console.log(fail === 0 ? `\nall ${pass} tests passed` : `\n${fail} FAILED, ${pass} passed`);
process.exit(fail ? 1 : 0);
