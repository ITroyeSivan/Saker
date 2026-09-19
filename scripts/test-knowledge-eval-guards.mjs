#!/usr/bin/env node
// 知识评测门禁的反向验证：样本删到 1 正 1 负时，指标即使漂亮也必须失败。
// 这是防止“少样本 100% Top-1”假绿的回归锁，不依赖真实知识库质量。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || "", ".dsh");
const sandbox = mkdtempSync(join(tmpdir(), "saker-knowledge-guard-"));
const cases = join(sandbox, "small.json");
writeFileSync(cases, JSON.stringify({
	version: 1,
	cases: [{ id: "small-positive", mode: "pentest", query: "OWASP", expect: ["owasp"] }],
	negativeCases: [{ id: "small-negative", mode: "pentest", query: "unrelated nonexistent topic" }],
}) + "\n", "utf8");

let pass = 0;
let fail = 0;
const ok = (label, condition, detail = "") => {
	if (condition) { pass += 1; console.log(`ok   ${label}`); }
	else { fail += 1; console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
};

try {
	const result = spawnSync(process.execPath, [
		"--import", pathToFileURL(join(ROOT, "scripts", "test-stub-register.mjs")).href,
		join(ROOT, "scripts", "eval-knowledge-retrieval.mjs"),
		"--cases", cases,
		"--min-cases", "50",
		"--min-negative-cases", "5",
		"--max-avg-ms", "0.0001",
	], {
		cwd: ROOT,
		encoding: "utf8",
		env: { ...process.env, DSH_HOME: home },
	});
	const output = `${result.stdout || ""}${result.stderr || ""}`;
	ok("1 正 1 负的漂亮指标不能被当作通过", result.status !== 0, `exit=${result.status}`);
	ok("失败原因明确指出正样例样本不足", result.status !== 0 && output.includes("正样例 1 < 50"), output.slice(-500));
	ok("失败原因明确指出负样例样本不足", result.status !== 0 && output.includes("负样例 1 < 5"), output.slice(-500));
	ok("延迟预算也会让回归失败", result.status !== 0 && output.includes("平均延迟"), output.slice(-500));
} finally {
	rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
