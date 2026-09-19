// dsh-ctf-observer / board — CTF 协作看板（BreachWeave 的 Idea Board + Planner Snapshot 落地）。
//
// BreachWeave 的共享协作状态是四件套：Challenge Memory / Idea Board / Planner Snapshot /
// Observer Notes。其中 Memory 与 Idea 已由 campaign-memory 承担（SQLite，跨会话）；
// 本文件补上**会话内**的两件：**Planner Snapshot**（题目与派单的当前快照）与
// **Observer Notes**（纠偏记录）。两者都是"高频变、会话内用"的短周期状态，
// 放工作区文件比入库更合适（不污染跨会话记忆）。
//
// 三个角色各自的读写面：
//   Manager（模型主动调）  ctf_state 读快照 / ctf_dispatch 派单 / ctf_steer 下指令
//   Solver（模型主循环）   读 dispatch 与 steer，决定下一步
//   Observer（本插件自动） 读快照算纠偏 → 注入 followup + 写 observer notes
//
// 存储：<workspace>/ctf-board.json —— 整文件读改写，**所有写路径都走 withLock**
// （多路并行时后写者不得覆盖先写者，这是 stage-gate 那边踩过的同一个坑）。

import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, statSync } from "node:fs";
import { join, dirname } from "node:path";

export const BOARD_FILE = "ctf-board.json";

const EMPTY = () => ({
	version: 1,
	challenges: [],   // { id, name, status: open|solved|blocked|dropped, flag, note, at }
	dispatches: [],   // { id, challengeId, path, owner, status: running|done|stale, note, at, at2 }
	steers: [],       // { id, challengeId, text, at, consumed }
	notes: [],        // { id, kind, text, at }   ← Observer Notes
	updatedAt: "",
});

const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const clean = (s, n) => String(s ?? "").trim().slice(0, n);

/** 同步睡眠：等锁时不要空转。
 *  原实现是 `for(;;)` 里直接重试，抢不到锁就**满速空转**（最长一直转到 waitMs 超时），
 *  多进程并发时把 CPU 打满、还持续压 IO。Atomics.wait 在 Node 主线程可用。 */
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms) => { try { Atomics.wait(SLEEP_BUF, 0, 0, ms); } catch { /* 不可用时退化为忙等（不致命） */ } };

/**
 * 生成 id：**取「现有最大序号 + 1」，不要用 `list.length + 1`**。
 * 用长度推导时，一旦容器被裁剪（steers 留 100 / notes 留 50），长度会长期停在阈值上，
 * 之后每一条新记录的 id 都与已存在的重复（`s101` 会出现第二次）——
 * id 是「删除/引用/去重」的目标，重复 id 会让这些操作打错对象。
 */
function nextId(list, prefix) {
	let max = 0;
	for (const x of list) {
		const m = /(\d+)$/.exec(String(x && x.id ? x.id : ""));
		if (m) { const n = Number(m[1]); if (n > max) max = n; }
	}
	return `${prefix}${max + 1}`;
}

/** 原子写：同目录临时文件 + rename（并发读时不会拿到残缺 JSON）。 */
function writeAtomic(file, data) {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
	writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
	renameSync(tmp, file);
}

export function readBoard(workspace) {
	try {
		const b = JSON.parse(readFileSync(join(workspace, BOARD_FILE), "utf8"));
		if (b && typeof b === "object" && !Array.isArray(b)) {
			const base = EMPTY();
			// 逐字段归一：**缺**要补，**类型错**要修。
			// 只补缺字段是不够的 —— 手改/半截写/外部工具写坏时可能把 challenges 写成字符串，
			// 之后 `.filter()` 直接抛，而这是每条工具调用都会走的热路径。
			// 宁可把坏字段当空数组（数据已不可用），也不能让看板整块不可用。
			for (const k of Object.keys(base)) {
				if (!Array.isArray(b[k])) b[k] = base[k];
			}
			return b;
		}
	} catch { /* 缺失或损坏都按空看板处理 */ }
	return EMPTY();
}

/**
 * 加锁执行一次「读 → 改 → 原子写」。
 * 锁用 `wx`（存在即失败）+ 超时回收，多路并行时不互相覆盖（同 stage-gate 的做法）。
 */
export function mutateBoard(workspace, mutator, { waitMs = 3000, staleMs = 10000 } = {}) {
	const file = join(workspace, BOARD_FILE);
	const lock = `${file}.lock`;
	mkdirSync(workspace, { recursive: true });
	const deadline = Date.now() + waitMs;
	const mine = String(process.pid);
	for (;;) {
		try {
			writeFileSync(lock, mine, { flag: "wx" });
			break;
		} catch {
			// 抢锁失败：看一眼持锁者是否已死（mtime 超过 staleMs 视为僵死锁，回收）
			try {
				const age = Date.now() - statSync(lock).mtimeMs;
				if (age > staleMs) { try { unlinkSync(lock); } catch { /* 别人抢先回收 */ } continue; }
			} catch { /* 锁刚被释放，立刻重试 */ continue; }
			if (Date.now() > deadline) throw new Error("ctf-board.json 锁等待超时");
			sleepSync(5);   // 让出 CPU 再抢，别空转（5ms × 3s 上限约 600 次重试）
		}
	}
	try {
		const cur = readBoard(workspace);
		const next = mutator(cur);
		// mutator 返回 null/undefined = 「什么都没改」：**不写盘**（读路径常走这里，见 peekSteers）
		if (next === null || next === undefined) return cur;
		next.updatedAt = now();
		writeAtomic(file, next);
		return next;
	} finally {
		// 只删**自己的**锁：若我们被别的进程当成僵死锁回收过，锁里已经是别人的 pid，
		// 这时再删就会把别人的互斥解开（原实现无条件删，存在这个隐患）。
		try { if (readFileSync(lock, "utf8") === mine) unlinkSync(lock); } catch { /* ignore */ }
	}
}

/** 题目：登记/更新（按 name 去重）。 */
export function upsertChallenge(workspace, { name, status = "open", flag = "", note = "" }) {
	return mutateBoard(workspace, (b) => {
		const n = clean(name, 80);
		if (!n) throw new Error("题目名必填");
		let c = b.challenges.find((x) => x.name === n);
		if (!c) {
			c = { id: nextId(b.challenges, "c"), name: n, status: "open", flag: "", note: "", at: now() };
			b.challenges.push(c);
		}
		if (status) c.status = clean(status, 20);
		if (flag) c.flag = clean(flag, 200);      // flag 原样存（逐字）
		if (note) c.note = clean(note, 300);
		c.at = now();
		return b;
	});
}

/** 派单：登记"谁在打哪条路" —— 避免两条路撞车（BreachWeave 的 Solver 分配）。 */
export function dispatch(workspace, { challengeId, path, owner = "", note = "" }) {
	return mutateBoard(workspace, (b) => {
		const cid = clean(challengeId, 40);
		if (cid && !b.challenges.some((c) => c.id === cid || c.name === cid)) throw new Error(`题目不存在：${cid}（先 ctf_state 登记）`);
		const p = clean(path, 200);
		if (!p) throw new Error("path（攻击路线）必填");
		const d = { id: nextId(b.dispatches, "d"), challengeId: cid, path: p, owner: clean(owner, 40), status: "running", note: clean(note, 200), at: now() };
		b.dispatches.push(d);
		if (b.dispatches.length > 200) b.dispatches = b.dispatches.slice(-200);   // 上限保护（与 notes/steers 口径一致）
		return b;
	});
}

const DISPATCH_STATUS = new Set(["running", "done", "stale"]);
export const DISPATCH_STALE_MS = 2 * 60 * 60 * 1000;

/** 更新一条派单的终态。running 可按需恢复；done/stale 用于避免旧路线永久占位。 */
export function updateDispatch(workspace, { id, status, note = "" }) {
	return mutateBoard(workspace, (b) => {
		const did = clean(id, 40);
		if (!did) throw new Error("派单 id 必填");
		const d = b.dispatches.find((x) => x.id === did);
		if (!d) throw new Error(`派单不存在：${did}`);
		const nextStatus = clean(status, 20);
		if (!DISPATCH_STATUS.has(nextStatus)) throw new Error("status 须为 running / done / stale");
		d.status = nextStatus;
		if (note) d.note = clean(note, 200);
		d.at2 = now();
		return b;
	});
}

/** 纠偏：给某个方向下指令（BreachWeave 的 steer）。写入后由 Solver 在下一轮读到。 */
export function steer(workspace, { challengeId, text }) {
	return mutateBoard(workspace, (b) => {
		const t = clean(text, 300);
		if (!t) throw new Error("纠偏内容必填");
		b.steers.push({ id: nextId(b.steers, "s"), challengeId: clean(challengeId, 40), text: t, at: now(), consumed: false });
		if (b.steers.length > 100) b.steers = b.steers.slice(-100);   // 上限保护
		return b;
	});
}

/** 只看未读纠偏，**不动盘**（纯读路径）。
 *  为什么单独出来：老实现是「取出即消费」，一旦注入失败这条指令就永久丢了；
 *  而且 review() 每轮都调它，无条件写会让**每个轮次边界都重写整份看板并抢一次锁**。 */
export function peekSteers(workspace) {
	return readBoard(workspace).steers.filter((s) => !s.consumed);
}

/** 把指定 id 的纠偏标记为已读（**投递成功之后**才调）。 */
export function markSteersConsumed(workspace, ids) {
	const set = new Set((ids ?? []).map(String));
	if (set.size === 0) return 0;
	let n = 0;
	mutateBoard(workspace, (b) => {
		for (const s of b.steers) if (!s.consumed && set.has(String(s.id))) { s.consumed = true; n++; }
		if (n === 0) return null;                 // 没有可改的就不写盘
		if (b.steers.length > 100) b.steers = b.steers.slice(-100);
		return b;
	});
	return n;
}

/** Observer 自己的记录（BreachWeave 的 Observer Notes）。 */
export function addNote(workspace, { kind, text }) {
	return mutateBoard(workspace, (b) => {
		b.notes.push({ id: nextId(b.notes, "n"), kind: clean(kind, 30), text: clean(text, 300), at: now() });
		if (b.notes.length > 50) b.notes = b.notes.slice(-50);   // 上限保护
		return b;
	});
}

/** 生成给模型看的快照文本（ctf_state 的渲染面）。 */
export function snapshotText(b) {
	const lines = [];
	const open = b.challenges.filter((c) => c.status === "open").length;
	const solved = b.challenges.filter((c) => c.status === "solved");
	lines.push(`题目 ${b.challenges.length}（未解 ${open} / 已解 ${solved.length}）`);
	if (solved.length) lines.push(`已解 flag：${solved.map((c) => `${c.name}=${c.flag || "(未记录)"}`).join("；")}`);
	const nowMs = Date.now();
	const stale = b.dispatches.filter((d) => d.status === "running" && nowMs - Date.parse(d.at || 0) > DISPATCH_STALE_MS);
	const running = b.dispatches.filter((d) => d.status === "running" && !stale.includes(d));
	if (running.length) lines.push(`进行中路线 ${running.length}：` + running.map((d) => `${d.challengeId || "?"}:${d.path}${d.owner ? "@" + d.owner : ""}`).join("；"));
	if (stale.length) lines.push(`超时路线 ${stale.length}：` + stale.map((d) => `${d.id}:${d.path}`).join("；") + "（用 ctf_dispatch 更新为 stale/done，或重新派单）");
	const unread = b.steers.filter((s) => !s.consumed);
	if (unread.length) lines.push(`未读纠偏 ${unread.length}：` + unread.map((s) => s.text).join("；"));
	if (b.notes.length) lines.push(`最近 observer 记录：` + b.notes.slice(-3).map((n) => `[${n.kind}] ${n.text}`).join("；"));
	return lines.join("\n");
}

export { EMPTY as emptyBoard, writeAtomic };
