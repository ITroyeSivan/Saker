import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = path.resolve(repo, "../_ref/tmp");
const fixture = fs.mkdtempSync(path.join(tempRoot, "saker-dependency-revcheck-"));
const sourceDir = path.join(repo, "plugins/dsh-stage-gate/lib");
const source = fs.readFileSync(path.join(sourceDir, "index.js"), "utf8");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const variants = [
	{ name: "start gate", probe: "blocked-run", from: '\t\t\tif (!readiness.ready) throw new TaskBlockedError(`${taskId}：${readiness.blockedReason}`);', to: "" },
	{ name: "wrapper fail closed", probe: "blocked-run", from: '\t\tif (error?.code === "TASK_NOT_READY") throw error;', to: "" },
	{ name: "claim readiness", probe: "claim", from: '\t\t\t\tif (!taskReadiness(cur, intent, workspace).ready) return false;', to: "" },
	{ name: "stable key", probe: "idempotency", from: 'const existing = key && intents.find', to: 'const existing = false && intents.find' },
	{ name: "lease fencing", probe: "lease", from: 'if (guarded && current.leaseId &&', to: 'if (false && current.leaseId &&' },
	{ name: "artifact hash", probe: "artifact", file: "task-dependencies.mjs", from: 'return hash === reference.sha256 ? "" : "产物已改变，sha256 不一致";', to: 'return "";' },
];
const result = [];
try {
	fs.writeFileSync(path.join(fixture, "package.json"), '{"type":"module"}');
	for (const variant of variants) {
		const dir = path.join(fixture, `v${result.length}`);
		fs.cpSync(sourceDir, dir, { recursive: true });
		const target = path.join(dir, variant.file || "index.js");
		const text = fs.readFileSync(target, "utf8");
		assert.equal(text.split(variant.from).length - 1, 1, `${variant.name}: mutation anchor must occur once`);
		fs.writeFileSync(target, text.replace(variant.from, variant.to));
		const run = spawnSync(process.execPath, ["--import", pathToFileURL(path.join(repo, "scripts/test-stub-register.mjs")).href, path.join(repo, "scripts/test-task-dependencies.mjs"), "--entry", path.join(dir, "index.js"), "--probe", variant.probe], { cwd: repo, env: process.env, encoding: "utf8", windowsHide: true });
		assert.equal(run.status, 1, `${variant.name}: mutant must fail the behavior test; ${run.stderr}`);
		assert.ok(run.stdout.includes(`FAIL ${variant.probe}:`), `${variant.name}: targeted assertion did not run; ${run.stdout}; ${run.stderr}`);
		result.push({ name: variant.name, caughtBy: variant.probe, caught: true });
		console.log(`ok caught ${variant.name} by ${variant.probe}`);
	}
	assert.equal(hash(fs.readFileSync(path.join(sourceDir, "index.js"))), hash(source), "production source changed during mutation checks");
} finally {
	const rel = path.relative(tempRoot, fixture); assert.ok(rel && !rel.startsWith("..") && !path.isAbsolute(rel));
	fs.rmSync(fixture, { recursive: true, force: true });
}
console.log(JSON.stringify({ mutations: result, productionUnchanged: true }));
