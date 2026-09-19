import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setGoal, registerIntent, readOperationState, updateProgress, taskToolAliases, autoTaskForTool, runTrackedTask, taskClaim, apply as applyStageGate } from "../plugins/dsh-stage-gate/lib/index.js";
import { openStore, beginTrace, getTrace, recoverStaleRunning } from "../plugins/dsh-trace-vault/lib/store.js";
import { openStore as openAttackAtlas } from "../plugins/dsh-attack-atlas/lib/store.js";
import { openStore as openCampaignMemory } from "../plugins/dsh-campaign-memory/lib/store.js";
import { openHunterStore } from "../plugins/dsh-hunter/lib/store.js";
import { openStore as openRedteamResults } from "../plugins/dsh-redteam-results/lib/store.js";
import { openStore as openWebshellManager } from "../plugins/dsh-webshell-mgr/lib/store.js";
import { apply as applyScannerTools } from "../plugins/dsh-scanner-tools/lib/index.js";
import { apply as applySemgrepAudit } from "../plugins/dsh-semgrep-audit/lib/index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STUB = pathToFileURL(join(ROOT, "scripts", "test-stub-register.mjs")).href;
const TASK_WORKER = join(ROOT, "scripts", "test-task-recovery-worker.mjs");
const TRACE_WORKER = join(ROOT, "scripts", "test-trace-write-worker.mjs");
const STORE_OPEN_WORKER = join(ROOT, "scripts", "test-store-open-worker.mjs");
const TASK_CLAIM_WORKER = join(ROOT, "scripts", "test-task-claim-worker.mjs");
const HOME = mkdtempSync(join(tmpdir(), "saker-task-recovery-"));
const WS = join(HOME, "workspace");
mkdirSync(WS, { recursive: true });

let pass = 0;
let fail = 0;
const ok = (name, condition, detail = "") => {
	if (condition) {
		pass += 1;
		console.log(`ok   ${name}`);
	} else {
		fail += 1;
		console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
	}
};

function runNode(script, args, cwd = ROOT) {
	return new Promise((resolveResult) => {
		const child = spawn(process.execPath, ["--import", STUB, script, ...args], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (chunk) => { out += String(chunk); });
		child.stderr.on("data", (chunk) => { err += String(chunk); });
		child.on("close", (code) => resolveResult({ code, out, err }));
	});
}

try {
	setGoal(WS, "大量安全测试任务恢复", "g1 验证所有任务可收口");
	for (let i = 0; i < 16; i += 1) registerIntent(WS, { summary: `并发任务 ${i}`, anchorKind: "boot", owner: `worker-${i}`, maxAttempts: 2 });
	const starts = await Promise.all(Array.from({ length: 16 }, (_, i) => runNode(TASK_WORKER, [WS, `i${i + 1}`, "start", `worker-${i}`])));
	ok("16 个任务可并发 start", starts.every((r) => r.code === 0 && JSON.parse(r.out).state === "running"), JSON.stringify(starts.filter((r) => r.code !== 0)));
	const afterStart = readOperationState({ readFileSync, writeFileSync }, WS);
	ok("并发 start 后 16 个任务均为 running", afterStart.intents.filter((i) => i.task?.state === "running").length === 16);

	const progresses = await Promise.all(Array.from({ length: 16 }, (_, i) => runNode(TASK_WORKER, [WS, `i${i + 1}`, "progress"])));
	ok("16 个任务可并发 progress", progresses.every((r) => r.code === 0), JSON.stringify(progresses.filter((r) => r.code !== 0)));
	const succeeds = await Promise.all(Array.from({ length: 16 }, (_, i) => runNode(TASK_WORKER, [WS, `i${i + 1}`, "succeed"])));
	ok("16 个任务可并发 succeed", succeeds.every((r) => r.code === 0 && JSON.parse(r.out).state === "succeeded"), JSON.stringify(succeeds.filter((r) => r.code !== 0)));

	registerIntent(WS, { summary: "中断恢复", anchorKind: "boot", owner: "worker-stale", maxAttempts: 2 });
	await runNode(TASK_WORKER, [WS, "i17", "start"]);
	const state = readOperationState({ readFileSync, writeFileSync }, WS);
	state.intents.find((i) => i.id === "i17").task.heartbeatAt = "2000-01-01T00:00:00.000Z";
	writeFileSync(join(WS, "operation-state.json"), JSON.stringify(state, null, 2) + "\n");
	updateProgress(WS, { note: "recover stale" });
	ok("过期 running 任务转为 interrupted", readOperationState({ readFileSync, writeFileSync }, WS).intents.find((i) => i.id === "i17").task.state === "interrupted");

	const dbPath = join(HOME, "traces.db");
	const writes = await Promise.all(Array.from({ length: 8 }, (_, i) => runNode(TRACE_WORKER, [dbPath, `w${i}`, "50"])));
	ok("8 个子进程并发写 trace-vault 不报错", writes.every((r) => r.code === 0), JSON.stringify(writes.filter((r) => r.code !== 0)));
	const st = openStore(dbPath);
	const count = st.db.prepare("SELECT COUNT(*) AS n FROM traces").get().n;
	ok("并发写入无丢行（8×50）", count === 400, String(count));
	beginTrace(st, { id: "stale:1", sessionId: "stale", mode: "pentest", tool: "nmap", args: "{}" });
	st.db.prepare("UPDATE traces SET last_seen = '2000-01-01 00:00:00' WHERE id = ?").run("stale:1");
	ok("trace-vault 过期 running 转 interrupted", recoverStaleRunning(st, { staleMs: 1000 }) === 1 && getTrace(st, "stale:1").outcome === "interrupted");
	st.close();

	const trackedWs = join(HOME, "tracked-workspace");
	mkdirSync(trackedWs, { recursive: true });
	setGoal(trackedWs, "长任务自动恢复", "g1 扫描完成");
	registerIntent(trackedWs, { summary: "nuclei 扫描", anchorKind: "boot", owner: "nuclei_scan", maxAttempts: 2 });
	const auto = autoTaskForTool(readOperationState({ readFileSync, writeFileSync }, trackedWs), { sessionId: "s-auto", toolName: "nuclei_scan" });
	ok("工具 owner 可自动绑定 queued task", auto?.id === "i1", JSON.stringify(auto));
	const successTrack = await runTrackedTask(trackedWs, { sessionId: "s-auto", toolName: "nuclei_scan" }, async () => ({ ok: true, summaryText: "scan done", file: "artifacts/scans/nuclei.json" }));
	const successState = readOperationState({ readFileSync, writeFileSync }, trackedWs).intents.find((i) => i.id === "i1").task;
	ok("长任务执行体自动 running→succeeded", successTrack.taskId === "i1" && successState.state === "succeeded" && successState.artifacts[0] === "artifacts/scans/nuclei.json", JSON.stringify(successState));
	ok("工具名别名覆盖 _scan/_probe/_fuzz", taskToolAliases("httpx_probe").includes("httpx") && taskToolAliases("ffuf_fuzz").includes("ffuf"));

	const ambiguousWs = join(HOME, "ambiguous-workspace");
	mkdirSync(ambiguousWs, { recursive: true });
	setGoal(ambiguousWs, "防误绑", "g1 任务名称歧义必须拒绝");
	registerIntent(ambiguousWs, { summary: "nuclei 任务 A", anchorKind: "boot", owner: "nuclei_scan", maxAttempts: 2 });
	registerIntent(ambiguousWs, { summary: "nuclei 任务 B", anchorKind: "boot", owner: "nuclei_scan", maxAttempts: 2 });
	const ambiguous = autoTaskForTool(readOperationState({ readFileSync, writeFileSync }, ambiguousWs), { toolName: "nuclei_scan" });
	ok("同 owner 多候选不做猜测绑定", ambiguous === null);
	registerIntent(ambiguousWs, { summary: "session-bound", anchorKind: "boot", owner: "semgrep", maxAttempts: 2, sessionId: "s-other" });
	const wrongSession = autoTaskForTool(readOperationState({ readFileSync, writeFileSync }, ambiguousWs), { sessionId: "s-mine", toolName: "semgrep_scan" });
	ok("session 不匹配不抢任务", wrongSession === null);

	const claimWs = join(HOME, "claim-workspace");
	mkdirSync(claimWs, { recursive: true });
	setGoal(claimWs, "多子代理原子领取", "g1 每个 queued 任务只被领取一次");
	for (let i = 0; i < 8; i += 1) registerIntent(claimWs, { summary: `claim-${i}`, anchorKind: "boot", owner: "sibling", maxAttempts: 2 });
	const claims = await Promise.all(Array.from({ length: 8 }, () => runNode(TASK_CLAIM_WORKER, [claimWs, "sibling"])));
	const claimedIds = claims.map((result) => JSON.parse(result.out).id).filter(Boolean);
	ok("8 个子进程原子 claim 不重复", claims.every((result) => result.code === 0) && new Set(claimedIds).size === 8, JSON.stringify(claims));
	registerIntent(claimWs, { summary: "tool-claim", anchorKind: "boot", owner: "sibling", maxAttempts: 2 });
	const stageTools = [];
	applyStageGate({ tools: { register: (tool) => stageTools.push(tool) } });
	const operationTask = stageTools.find((tool) => tool.name === "operation_task");
	const claimToolOut = await operationTask.execute({ workspace: claimWs, action: "claim", owner: "sibling" }, {});
	ok("operation_task claim 工具边界可用", claimToolOut.ok === true && claimToolOut.task?.state === "running");

	const ownerBoundaryWs = join(HOME, "owner-boundary-workspace");
	mkdirSync(ownerBoundaryWs, { recursive: true });
	setGoal(ownerBoundaryWs, "owner 边界", "g1 短 owner 不得误领");
	registerIntent(ownerBoundaryWs, { summary: "short-owner", anchorKind: "boot", owner: "s", maxAttempts: 2 });
	let boundaryRejected = false;
	try { taskClaim(ownerBoundaryWs, { owner: "sibling" }); } catch { boundaryRejected = true; }
	ok("claim owner 使用边界匹配，短字符串不误领", boundaryRejected);

	registerIntent(trackedWs, { summary: "semgrep 扫描", anchorKind: "boot", owner: "semgrep", maxAttempts: 2 });
	const failTrack = await runTrackedTask(trackedWs, { sessionId: "s-auto", toolName: "semgrep_scan" }, async () => ({ ok: false, error: "binary missing" }));
	const failState = readOperationState({ readFileSync, writeFileSync }, trackedWs).intents.find((i) => i.id === "i2").task;
	ok("长任务失败自动落 failed 与错误", failTrack.taskId === "i2" && failState.state === "failed" && failState.error === "binary missing", JSON.stringify(failState));

	const scannerTools = [];
	applyScannerTools({ tools: { register: (tool) => scannerTools.push(tool) } });
	registerIntent(trackedWs, { summary: "ffuf 字典缺失路径", anchorKind: "boot", owner: "ffuf_fuzz", maxAttempts: 2 });
	const ffuf = scannerTools.find((tool) => tool.name === "ffuf_fuzz");
	const ffufOut = await ffuf.execute(
		{ url: "http://127.0.0.1/FUZZ", workspace: trackedWs, mode: "dir", wordlist: join(trackedWs, "missing-wordlist.txt") },
		{ agent: { session: { id: "s-auto" } } },
	);
	const ffufTask = readOperationState({ readFileSync, writeFileSync }, trackedWs).intents.find((i) => i.id === "i3").task;
	ok("scanner-tools 工具边界自动绑定并收口 failed", ffufOut.ok === false && ffufOut.task_id === "i3" && ffufTask.state === "failed", JSON.stringify({ ffufOut, ffufTask }));

	const semgrepTools = [];
	applySemgrepAudit({ tools: { register: (tool) => semgrepTools.push(tool) } });
	registerIntent(trackedWs, { summary: "semgrep 缺失目标路径", anchorKind: "boot", owner: "semgrep_scan", maxAttempts: 2 });
	const semgrep = semgrepTools.find((tool) => tool.name === "semgrep_scan");
	const semgrepOut = await semgrep.execute(
		{ target: join(trackedWs, "missing-target"), workspace: trackedWs, layer: "custom", rules_path: join(trackedWs, "rules.yml") },
		{ agent: { session: { id: "s-auto" } } },
	);
	const semgrepTask = readOperationState({ readFileSync, writeFileSync }, trackedWs).intents.find((i) => i.id === "i4").task;
	ok("semgrep 工具边界自动绑定并收口 failed", semgrepOut.ok === false && semgrepOut.task_id === "i4" && semgrepTask.state === "failed");

	const storeDir = join(HOME, "store-concurrency");
	mkdirSync(storeDir, { recursive: true });
	const opens = await Promise.all(Array.from({ length: 8 }, () => runNode(STORE_OPEN_WORKER, [storeDir])));
	ok("8 个进程并发首次打开六类 SQLite store 不报错", opens.every((r) => r.code === 0), JSON.stringify(opens.filter((r) => r.code !== 0)));
	const integrity = [
		["attack-atlas", openAttackAtlas],
		["campaign-memory", openCampaignMemory],
		["hunter", openHunterStore],
		["redteam-results", openRedteamResults],
		["webshell-mgr", openWebshellManager],
	].map(([name, open]) => {
		const opened = open(join(storeDir, `${name}.db`));
		try {
			return opened.db.prepare("PRAGMA integrity_check").get().integrity_check === "ok";
		} finally {
			opened.close();
		}
	});
	ok("并发首开后五类 SQLite store 完整性检查通过", integrity.every(Boolean), JSON.stringify(integrity));
} finally {
	rmSync(HOME, { recursive: true, force: true });
}

console.log(`\ntask-recovery: ${pass} ok / ${fail} fail`);
process.exit(fail ? 1 : 0);
