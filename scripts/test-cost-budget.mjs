#!/usr/bin/env node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = mkdtempSync(join(tmpdir(), "saker-cost-budget-"));
const longFile = join(sandbox, "long.json");
const largeFile = join(sandbox, "large.json");
const script = join(ROOT, "scripts", "report-cost-budget.mjs");
const run = (extra = []) => spawnSync(process.execPath, [script, "--long-session", longFile, "--large-result", largeFile, ...extra], { cwd: ROOT, encoding: "utf8" });
let pass = 0, fail = 0;
const ok = (label, cond, detail = "") => {
	if (cond) { pass += 1; console.log(`ok   ${label}`); }
	else { fail += 1; console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
};

try {
	writeFileSync(longFile, JSON.stringify({
		toolCountStable: true,
		toolBytesStable: true,
		first: { tools: 90, toolsBytes: 80_000, requestBytes: 120_000 },
		last: { requestBytes: 130_000 },
		maxRequestBytes: 130_000,
	}), "utf8");
	writeFileSync(largeFile, JSON.stringify({ longestToolResultChars: 30_000, pruned: true, underThreshold: true }), "utf8");
	let r = run();
	ok("预算内通过", r.status === 0, `${r.status}: ${r.stderr || r.stdout}`);
	r = run(["--max-tool-bytes", "70000"]);
	ok("工具定义超预算时失败", r.status !== 0 && r.stderr.includes("工具定义"), `${r.status}: ${r.stderr}`);
	r = run(["--max-request-growth-bytes", "9000"]);
	ok("请求增长超预算时失败", r.status !== 0 && r.stderr.includes("请求增长"), `${r.status}: ${r.stderr}`);
	writeFileSync(largeFile, JSON.stringify({ longestToolResultChars: 45_000, pruned: false, underThreshold: false }), "utf8");
	r = run();
	ok("大结果未裁剪时失败", r.status !== 0 && r.stderr.includes("大工具结果"), `${r.status}: ${r.stderr}`);
} finally {
	rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
