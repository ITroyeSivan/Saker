import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = path.resolve(repo, "../_ref/tmp");
fs.mkdirSync(tempRoot, { recursive: true });
const home = fs.mkdtempSync(path.join(tempRoot, "saker-task-dependencies-"));
const entryIndex = process.argv.indexOf("--entry");
const entry = entryIndex >= 0 ? path.resolve(process.argv[entryIndex + 1]) : path.join(repo, "plugins/dsh-stage-gate/lib/index.js");
const stage = await import(pathToFileURL(entry).href);
const { taskReadiness } = await import("../plugins/dsh-stage-gate/lib/task-dependencies.mjs");
const { projectSnapshot } = await import("../plugins/dsh-stage-gate/lib/project-snapshot.mjs");
const selected = process.argv[process.argv.indexOf("--probe") + 1];
const results = [];
let server;
let workspaceCount = 0;
function workspace() {
	const root = path.join(home, `case-${++workspaceCount}`);
	fs.mkdirSync(root);
	stage.setGoal(root, "依赖调度本地验收", "g1 请求只在前置满足后执行");
	return root;
}
function add(ws, options = {}) { return stage.registerIntent(ws, { summary: "local task", anchorKind: "boot", owner: "worker", ...options }); }
function state(ws) { return stage.readOperationState(fs, ws); }
function save(ws, value) { fs.writeFileSync(path.join(ws, "operation-state.json"), JSON.stringify(value)); }
function end(ws, id, args = {}) {
	const started = stage.taskTransition(ws, { id, action: "start" });
	return stage.taskTransition(ws, { id, action: "succeed", leaseId: started.task.leaseId, ...args });
}
async function test(name, fn) {
	if (process.argv.includes("--probe") && selected !== name) return;
	try { await fn(); results.push({ name, ok: true }); console.log(`ok ${name}`); }
	catch (error) { results.push({ name, ok: false, error: error.message }); console.log(`FAIL ${name}: ${error.message}`); }
}

try {
	let requests = 0;
	server = createServer((req, res) => { requests++; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ fixture: true, method: req.method, marker: "local-dependency-control" })); });
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const endpoint = `http://127.0.0.1:${server.address().port}/fixture`;
	await test("blocked-run", async () => {
		const ws = workspace(); add(ws, { owner: "prepare" }); add(ws, { owner: "httpx_probe", dependsOn: ["i1"] });
		const before = requests;
		await assert.rejects(stage.runTrackedTask(ws, { toolName: "httpx_probe" }, async () => ({ ok: (await fetch(endpoint)).ok })), /等待前置/);
		assert.equal(requests - before, 0, "blocked task emitted a real HTTP request");
		assert.equal(state(ws).intents[1].task.attempts, 0);
	});
	await test("claim", () => {
		const ws = workspace(); add(ws, { owner: "prepare" }); add(ws, { dependsOn: ["i1"] });
		assert.throws(() => stage.taskClaim(ws, { owner: "worker" }), /没有可领取/);
		end(ws, "i1"); assert.equal(stage.taskClaim(ws, { owner: "worker" }).id, "i2");
	});
	await test("artifact", () => {
		const ws = workspace(); const body = "independent local preparation artifact";
		const sha256 = createHash("sha256").update(body).digest("hex");
		add(ws); add(ws, { dependsOn: ["i1"], requiredArtifacts: [{ taskId: "i1", path: "identity.json", sha256 }] });
		end(ws, "i1", { artifacts: ["identity.json"] });
		assert.throws(() => stage.taskTransition(ws, { id: "i2", action: "start" }), /产物不存在/);
		fs.writeFileSync(path.join(ws, "identity.json"), "wrong identity");
		assert.throws(() => stage.taskTransition(ws, { id: "i2", action: "start" }), /sha256 不一致/);
		fs.writeFileSync(path.join(ws, "identity.json"), body);
		assert.equal(stage.taskTransition(ws, { id: "i2", action: "start" }).task.state, "running");
	});
	await test("idempotency", () => {
		const ws = workspace(); const a = add(ws, { taskKey: "stable" });
		const b = add(ws, { taskKey: "stable" }); assert.equal(b.id, a.id); assert.equal(b.reused, true); assert.equal(state(ws).intents.length, 1);
		assert.throws(() => add(ws, { taskKey: "stable", summary: "changed" }), /定义不同/);
		stage.taskClaim(ws, { owner: "worker" }); assert.equal(add(ws, { taskKey: "stable" }).id, a.id);
	});
	await test("lease", () => {
		const ws = workspace(); add(ws, { taskKey: "leased", maxAttempts: 2 });
		const first = stage.taskClaim(ws);
		stage.taskTransition(ws, { id: "i1", action: "interrupt", leaseId: first.task.leaseId });
		stage.taskTransition(ws, { id: "i1", action: "retry" });
		const second = stage.taskClaim(ws); assert.notEqual(second.task.leaseId, first.task.leaseId);
		assert.throws(() => stage.taskTransition(ws, { id: "i1", action: "succeed", leaseId: first.task.leaseId }), /租约不匹配/);
		assert.equal(state(ws).intents[0].task.state, "running");
		stage.taskTransition(ws, { id: "i1", action: "succeed", leaseId: second.task.leaseId });
	});
	await test("invalid-scope-and-cycle", () => {
		const ws = workspace(); add(ws, { sessionId: "s1", bucketId: "a", targetIds: ["a"] });
		assert.throws(() => add(ws, { dependsOn: ["i404"] }), /不存在/);
		assert.throws(() => add(ws, { dependsOn: ["i1"], sessionId: "s2" }), /其他会话/);
		assert.throws(() => add(ws, { dependsOn: ["i1"], bucketId: "b" }), /其他资产组/);
		assert.throws(() => add(ws, { dependsOn: ["i1"], targetIds: ["b"] }), /不相交/);
		assert.throws(() => add(ws, { dependsOn: ["i1"], requiredArtifacts: [{ taskId: "i1", path: "../secret", sha256: "a".repeat(64) }] }), /相对路径/);
		add(ws, { dependsOn: ["i1"] }); const st = state(ws); st.intents[0].dependsOn = ["i2"]; save(ws, st);
		assert.throws(() => stage.taskTransition(ws, { id: "i2", action: "start" }), /成环/);
	});
	await test("exhausted-does-not-starve", () => {
		const ws = workspace(); add(ws); add(ws); const st = state(ws); st.intents[0].task.attempts = 1; save(ws, st);
		assert.equal(stage.taskClaim(ws).id, "i2");
	});
	await test("ambiguous-does-not-run", async () => {
		const ws = workspace(); add(ws, { taskKey: "one", owner: "httpx_probe" }); add(ws, { taskKey: "two", owner: "httpx_probe" });
		const before = requests;
		await assert.rejects(stage.runTrackedTask(ws, { toolName: "httpx_probe" }, async () => ({ ok: (await fetch(endpoint)).ok })), /多个受依赖约束/);
		assert.equal(requests, before);
	});
	await test("native-subagent-guard", () => {
		const ws = workspace(); add(ws, { owner: "prepare" }); add(ws, { owner: "subagent", dependsOn: ["i1"] });
		const guard = stage.buildTaskReadinessGuard();
		const exec = { name: "subagent", agent: { session: { id: "local", header: { cwd: ws } } } };
		assert.match(guard(exec).reason, /等待前置/);
		end(ws, "i1"); assert.equal(guard(exec), undefined);
	});
	await test("real-three-step-chain", async () => {
		const ws = workspace(); add(ws, { owner: "prepare" }); add(ws, { owner: "httpx_probe", dependsOn: ["i1"] }); add(ws, { owner: "verify", dependsOn: ["i2"] });
		end(ws, "i1"); const before = requests;
		await stage.runTrackedTask(ws, { toolName: "httpx_probe" }, async () => ({ ok: (await fetch(endpoint)).ok, summary: "real local fixture response" }));
		assert.equal(requests - before, 1); assert.equal(state(ws).intents[1].task.state, "succeeded");
		assert.equal(stage.taskClaim(ws, { owner: "verify" }).id, "i3");
	});
	await test("tool-and-desktop-contract", async () => {
		const ws = workspace(); const tools = [];
		stage.apply({ tools: { register: (tool) => tools.push(tool) } });
		const intent = tools.find((tool) => tool.name === "operation_intent");
		const task = tools.find((tool) => tool.name === "operation_task");
		const exec = { agent: { session: { id: "fixture-session" } } };
		assert.equal((await intent.execute({ workspace: ws, summary: "prepare", anchor_kind: "boot", owner: "prepare", task_key: "prepare" }, exec)).id, "i1");
		assert.equal((await intent.execute({ workspace: ws, summary: "execute", anchor_kind: "boot", owner: "probe", depends_on: ["i1"] }, exec)).id, "i2");
		const ready = await task.execute({ workspace: ws, action: "ready" }, exec);
		assert.equal(ready.readyTasks.find((item) => item.id === "i2").ready, false);
		assert.match(projectSnapshot(ws).taskTree[1].blockedReason, /等待前置/);
		assert.equal(projectSnapshot(ws).counts.waiting, 1);
		assert.equal((await task.execute({ workspace: ws, action: "start", id: "i1" }, { agent: { session: { id: "other" } } })).ok, false);
		const start = await task.execute({ workspace: ws, action: "start", id: "i1" }, exec);
		assert.equal((await task.execute({ workspace: ws, action: "succeed", id: "i1", lease_id: start.task.leaseId }, exec)).ok, true);
		assert.equal(projectSnapshot(ws).counts.waiting, 0);
		assert.equal(projectSnapshot(ws).counts.ready, 1);
	});
} finally {
	if (server) await new Promise((resolve) => server.close(resolve));
	const rel = path.relative(tempRoot, home);
	assert.ok(rel && !rel.startsWith("..") && !path.isAbsolute(rel));
	fs.rmSync(home, { recursive: true, force: true });
}
assert.ok(results.length > 0, "no targeted assertions ran");
console.log(JSON.stringify({ kind: "queue-and-real-local-http-integrity", modelCalls: 0, results }));
process.exitCode = results.some((result) => !result.ok) ? 1 : 0;
