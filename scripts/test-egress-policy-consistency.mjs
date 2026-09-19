#!/usr/bin/env node
// 跨插件出站判定一致性：根包实现（dsh-saker/lib/egress.js）与
// mcp-studio 的同步实现（src/transport.ts）必须对同一策略、同一目的地给出同一结论。
//
// 为什么要这条：mcp-studio 的 spawn 点是同步的，没法 await 动态 import 根包，
// 于是它同步读同一份策略文件、自己判一次。两处实现漂移 = 冻结档下某一边仍然出网，
// 而单看任何一边的测试都是绿的。这里用行为对比（不是文本比对）把两边锁在一起。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { evaluateEgress, defaultPolicy } from "../lib/egress.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_DIR = join(ROOT, "plugins", "dsh-mcp-studio");

let pass = 0;
let fail = 0;
const ok = (label, condition, detail = "") => {
	if (condition) { pass += 1; console.log(`ok   ${label}`); }
	else { fail += 1; console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
};

/** 命令 → 根包判定用的 host（与 mcp-studio 的 runner 表同源）。 */
const CASES = [
	{ command: "npx", host: "registry.npmjs.org" },
	{ command: "uvx", host: "pypi.org" },
];
const POLICIES = [
	{ label: "allow", mode: "allow", allowHosts: [] },
	{ label: "frozen", mode: "frozen", allowHosts: [] },
	{ label: "allowlist(npm)", mode: "allowlist", allowHosts: ["registry.npmjs.org"] },
	{ label: "allowlist(pypi)", mode: "allowlist", allowHosts: ["pypi.org"] },
];

const home = mkdtempSync(join(tmpdir(), "saker-egress-consistency-"));
try {
	mkdirSync(join(home, "saker-egress"), { recursive: true });
	const childScript = [
		"import { evaluateRunnerEgress } from './src/transport.ts'",
		"const out = {}",
		"for (const command of ['npx', 'uvx', 'node']) out[command] = evaluateRunnerEgress({ name: 'probe', command, argsLine: '', env: [], cwd: '' })",
		"process.stdout.write(JSON.stringify(out))",
	].join("\n");

	for (const policy of POLICIES) {
		const file = join(home, "saker-egress", "policy.json");
		writeFileSync(file, JSON.stringify({ version: 1, mode: policy.mode, allowHosts: policy.allowHosts }), "utf8");
		const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript], {
			cwd: PLUGIN_DIR,
			env: { ...process.env, DSH_HOME: home },
			encoding: "utf8",
		});
		if (child.status !== 0) {
			ok(`策略 ${policy.label}：mcp-studio 判定进程可运行`, false, `${child.status} ${(child.stderr || "").slice(-300)}`);
			continue;
		}
		const mcp = JSON.parse(child.stdout);
		for (const item of CASES) {
			const rootVerdict = evaluateEgress({
				kind: "infra",
				host: item.host,
				policy: { ...defaultPolicy(), mode: policy.mode, allowHosts: policy.allowHosts },
			});
			const childVerdict = mcp[item.command];
			ok(`策略 ${policy.label} · ${item.command}：两边结论一致（${rootVerdict.decision}）`,
				rootVerdict.decision === childVerdict.decision && rootVerdict.reason === childVerdict.reason,
				`root=${JSON.stringify(rootVerdict)} mcp=${JSON.stringify(childVerdict)}`);
		}
	}

	// 非包运行器：mcp-studio 必须放行（本地可执行文件不产生拉包流量）
	writeFileSync(join(home, "saker-egress", "policy.json"), JSON.stringify({ version: 1, mode: "frozen", allowHosts: [] }), "utf8");
	const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childScript], {
		cwd: PLUGIN_DIR,
		env: { ...process.env, DSH_HOME: home },
		encoding: "utf8",
	});
	const mcp = JSON.parse(child.stdout || "{}");
	ok("冻结档 · node（非包运行器）：不放拦", mcp.node?.decision === "allow" && mcp.node?.reason === "no-registry-fetch", JSON.stringify(mcp.node));
} finally {
	rmSync(home, { recursive: true, force: true });
}

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
