#!/usr/bin/env node
// One-command release gate for the Saker source tree.
//
// It does not install or modify profiles. It proves the current source revision
// passes the regression suite, documentation version checks, and byte-level
// parity with both the real and isolated dsh profiles.
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE = resolve(ROOT, "..");
const NODE = process.execPath;

const checks = [
	{ name: "全量回归与预算门禁", cwd: ROOT, args: ["scripts/run-all-tests.mjs"] },
	{ name: "文档插件清单与版本", cwd: ROOT, args: ["scripts/check-doc-plugins.mjs"] },
	{ name: "安装失败回滚", cwd: ROOT, args: ["scripts/test-install-rollback.mjs"] },
	{ name: "DSH_HOME 与前端纪律", cwd: ROOT, args: ["scripts/test-dsh-home.mjs"] },
	{ name: "真实 profile 字节同步", cwd: WORKSPACE, args: ["_ref/tools/verify-installed-sync.mjs", "--home", "real"] },
	{ name: "隔离 profile 字节同步", cwd: WORKSPACE, args: ["_ref/tools/verify-installed-sync.mjs"] },
];
const hasKnowledge = process.argv.includes("--knowledge");
const hasObservability = process.argv.includes("--observability");
const hasTaskBaseline = process.argv.includes("--task-baseline");
const hasContext = process.argv.includes("--context");
if (hasKnowledge) {
	checks.push({
		name: "知识检索 Top-1/Top-5 回归",
		cwd: ROOT,
		args: ["--import", "./scripts/test-stub-register.mjs", "scripts/eval-knowledge-retrieval.mjs", "--limit", "5"],
	});
}
if (hasObservability) {
	const args = ["scripts/report-observability.mjs"];
	if (process.env.DSH_HOME) args.push("--home", process.env.DSH_HOME);
	checks.push({
		name: "本地可观测性快照",
		cwd: ROOT,
		args,
	});
	// 长期记忆效果报告：只读、不因库为空而失败（空库也要能出"还没有记忆"的结论）。
	const memoryArgs = ["scripts/report-memory-effect.mjs"];
	if (process.env.DSH_HOME) memoryArgs.push("--home", process.env.DSH_HOME);
	checks.push({
		name: "长期记忆效果快照",
		cwd: ROOT,
		args: memoryArgs,
	});
	// 已装形态的出站策略：源码树里能解析不等于装进 profile 还能解析；
	// 解析不到时消费者按设计放行（fail-open），必须有门禁盯住。
	checks.push({
		name: "统一出站策略（已装形态）",
		cwd: WORKSPACE,
		args: ["_ref/tools/verify-egress-installed.mjs"],
	});
	checks.push({
		name: "模型字段级脱敏（已装形态）",
		cwd: WORKSPACE,
		args: ["_ref/tools/verify-redaction-installed.mjs", "--home", "real"],
	});
}
if (hasTaskBaseline) {
	checks.push({
		name: "任务成功率与恢复基线",
		cwd: ROOT,
		args: ["--import", "./scripts/test-stub-register.mjs", "scripts/eval-task-baseline.mjs"],
	});
	checks.push({
		name: "真实宿主重启后的过期任务恢复",
		cwd: WORKSPACE,
		args: ["_ref/tools/run-host-task-recovery-audit.mjs"],
	});
	// 子代理结果回收：真跑一次 subagent，验证 start/end 生命周期把成败与输出写回台账
	checks.push({
		name: "子代理结果回收（真宿主）",
		cwd: WORKSPACE,
		args: ["_ref/tools/probe-subagent-recycle.mjs"],
	});
}
if (hasContext) {
	checks.push({
		name: "30 轮真实宿主工具面",
		cwd: WORKSPACE,
		args: ["_ref/tools/run-long-session-mock-audit.mjs"],
	});
	checks.push({
		name: "大工具结果压力门裁剪",
		cwd: WORKSPACE,
		args: ["_ref/tools/run-large-result-prune-audit.mjs"],
	});
	checks.push({
		name: "模型成本预算",
		cwd: ROOT,
		args: [
			"scripts/report-cost-budget.mjs",
			"--long-session", join(WORKSPACE, "_ref", "long-session-mock-30", "summary.json"),
			"--large-result", join(WORKSPACE, "_ref", "large-result-audit", "summary.json"),
		],
	});
	checks.push({
		name: "dsh 浏览器 MCP（真导航+快照）",
		cwd: WORKSPACE,
		args: ["_ref/tools/test-playwright-mcp.mjs"],
	});
	// 真实宿主里的装配期注入：有候选→出现提示行，干净工作区→整块不出现（两侧都要验）
	checks.push({
		name: "记忆候选注入（真宿主）",
		cwd: WORKSPACE,
		args: ["_ref/tools/probe-memory-candidates-inject.mjs"],
	});
	// 指标入历史 + 趋势（放在 context 组最后：上面几个审计刚写好各自的 summary.json）
	const gateHome = process.env.DSH_HOME ? resolve(process.env.DSH_HOME) : join(homedir(), ".dsh");
	checks.push({
		name: "指标入历史",
		cwd: ROOT,
		args: [
			"scripts/record-metrics.mjs",
			"--home", gateHome,
			"--label", "release-gate",
			"--long-session", join(WORKSPACE, "_ref", "long-session-mock-30", "summary.json"),
			"--large-result", join(WORKSPACE, "_ref", "large-result-audit", "summary.json"),
		],
	});
	checks.push({
		name: "指标趋势快照",
		cwd: ROOT,
		args: ["scripts/report-metrics-trend.mjs", "--home", gateHome, "--limit", "5"],
	});
}

// 防止“删掉一项后 19/19 也算通过”：按启用的 flag 推导应有门禁数。
const expectedChecks = 6
	+ (hasKnowledge ? 1 : 0)
	+ (hasObservability ? 4 : 0)
	+ (hasTaskBaseline ? 3 : 0)
	+ (hasContext ? 7 : 0);
if (checks.length !== expectedChecks) {
	console.error(`release-gate 结构错误：应执行 ${expectedChecks} 项，实际 ${checks.length} 项——有门禁被删或接线漏了。`);
	process.exit(2);
}

let failed = 0;
for (const check of checks) {
	console.log(`\n=== ${check.name} ===`);
	const result = spawnSync(NODE, check.args, { cwd: check.cwd, encoding: "utf8" });
	const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
	if (output) console.log(output);
	if (result.status !== 0) {
		failed += 1;
		console.error(`FAIL ${check.name} (exit ${result.status ?? "spawn-error"})`);
	}
}

console.log(`\nrelease-gate: ${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);
