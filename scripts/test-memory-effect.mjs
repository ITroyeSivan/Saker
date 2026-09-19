#!/usr/bin/env node
// Memory effectiveness report regression: 关联分组必须由真实数据算出来，
// 样本量门槛必须真的拦（把门槛调高就必须变成"样本不足"），报告必须只读不改账。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
let fail = 0;
const ok = (label, condition, detail = "") => {
	if (condition) {
		pass += 1;
		console.log(`ok   ${label}`);
	} else {
		fail += 1;
		console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
	}
};

const sandbox = mkdtempSync(join(tmpdir(), "saker-memory-effect-"));
const home = join(sandbox, "home");
const mkWorkspace = (name, intents) => {
	const dir = join(sandbox, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "operation-state.json"), JSON.stringify({ goal: name, criteria: [], intents }, null, 2));
	return dir;
};
/** 一条意图：status 是台账终态（open/done/blocked/dropped），state 是任务状态。 */
const intent = (id, status, state) => ({
	id,
	summary: `${id} ${status}`,
	status,
	...(state ? { task: { state } } : {}),
});

try {
	// 三个"有被读取过记忆"的项目 + 三个"完全没读过记忆"的项目
	const wsRead = [
		mkWorkspace("proj-read-1", [intent("i1", "done", "succeeded"), intent("i2", "open")]),
		mkWorkspace("proj-read-2", [intent("i1", "done", "succeeded"), intent("i2", "blocked", "failed")]),
		mkWorkspace("proj-read-3", [intent("i1", "done", "succeeded")]),
	];
	const wsCold = [
		mkWorkspace("proj-cold-1", [intent("i1", "blocked", "failed")]),
		mkWorkspace("proj-cold-2", [intent("i1", "blocked", "failed")]),
		mkWorkspace("proj-cold-3", [intent("i1", "blocked", "failed")]),
	];

	mkdirSync(join(home, "campaign-memory"), { recursive: true });
	const { openStore, writeMemory, getMemory, feedbackMemory } = await import("../plugins/dsh-campaign-memory/lib/store.js");
	const store = openStore(join(home, "campaign-memory", "memory.db"));
	const keyOf = (dir) => `${basename(dir).slice(0, 60)}@${createHash("sha256").update(dir).digest("hex").slice(0, 8)}`;
	const written = [];
	try {
		for (const dir of [...wsRead, ...wsCold]) {
			const row = writeMemory(store, {
				mode: "pentest",
				kind: "tactic",
				title: `记忆 ${basename(dir)}`,
				content: `打通路径 ${basename(dir)}`,
				workspace: basename(dir),
				workspace_key: keyOf(dir),
			});
			written.push({ dir, id: row.id });
		}
		// 只读其中三条：另外三条保持"写入但从未被读取"
		for (const item of written.slice(0, 3)) getMemory(store, item.id);
		feedbackMemory(store, { id: written[0].id, verdict: "helpful" });
		const misleading = writeMemory(store, {
			mode: "pentest", kind: "fingerprint", title: "误导记忆",
			content: "这条被判定为误导，但还没到退役阈值", workspace: basename(wsRead[0]), workspace_key: keyOf(wsRead[0]),
		});
		feedbackMemory(store, { id: misleading.id, verdict: "misleading" });
		const obsolete = writeMemory(store, {
			mode: "pentest", kind: "lesson", title: "退役记忆",
			content: "这条已经被判定作废", workspace: basename(wsCold[0]), workspace_key: keyOf(wsCold[0]),
		});
		feedbackMemory(store, { id: obsolete.id, verdict: "obsolete" });
	} finally {
		store.close();
	}

	const storeModule = await import("../plugins/dsh-campaign-memory/lib/store.js");
	const readUsage = () => {
		const open = storeModule.openStore;
		const s = open(join(home, "campaign-memory", "memory.db"));
		try {
			return s.db.prepare("SELECT id, usage_count, feedback_score FROM memories ORDER BY id").all()
				.map((r) => `${r.id}:${r.usage_count}:${r.feedback_score}`).join("|");
		} finally {
			s.close();
		}
	};
	const before = readUsage();

	const jsonOut = join(sandbox, "effect.json");
	const run = (extra = []) => spawnSync(process.execPath, [
		join(ROOT, "scripts", "report-memory-effect.mjs"),
		"--home", home,
		...[...wsRead, ...wsCold].flatMap((dir) => ["--workspace", dir]),
		"--json", jsonOut,
		...extra,
	], { cwd: ROOT, encoding: "utf8" });

	const first = run();
	const out = `${first.stdout || ""}${first.stderr || ""}`;
	ok("报告脚本退出码为 0", first.status === 0, out.trim());
	ok("报告 JSON 落盘", existsSync(jsonOut));
	const report = JSON.parse(readFileSync(jsonOut, "utf8"));

	ok("写入计数 = 8（含误导/退役各 1）", report.funnel.written === 8, `written=${report.funnel.written}`);
	ok("读取计数只认 usage_count > 0 = 3", report.funnel.read === 3, `read=${report.funnel.read}`);
	ok("反馈分桶 helpful/misleading/obsolete = 1/1/1",
		report.funnel.helpful === 1 && report.funnel.misleading === 1 && report.funnel.obsolete === 1,
		JSON.stringify(report.funnel));
	ok("召回窗口排除退役记忆 = 7", report.funnel.injectionWindow === 7, `window=${report.funnel.injectionWindow}`);
	ok("按类别分桶带上读取与反馈", report.byKind.tactic?.total === 6 && report.byKind.tactic?.read === 3,
		JSON.stringify(report.byKind));
	ok("六个项目都进入报告", report.workspaces.length === 6, `n=${report.workspaces.length}`);
	ok("样本达标时判为可比较", report.association.verdict === "可比较", report.association.verdict);
	ok("有读取组：意图 4/5、任务 3 成功 1 失败",
		report.association.groups.withRead.intents.settled === 4
		&& report.association.groups.withRead.intents.total === 5
		&& report.association.groups.withRead.tasks.succeeded === 3
		&& report.association.groups.withRead.tasks.failed === 1,
		JSON.stringify(report.association.groups.withRead));
	ok("无读取组：意图 3/3、任务 0 成功 3 失败",
		report.association.groups.withoutRead.intents.settled === 3
		&& report.association.groups.withoutRead.intents.total === 3
		&& report.association.groups.withoutRead.tasks.succeeded === 0
		&& report.association.groups.withoutRead.tasks.failed === 3,
		JSON.stringify(report.association.groups.withoutRead));

	// 反向验证一：门槛调高就必须变成"样本不足"，说明结论不是写死的
	const strict = run(["--min-sample", "4"]);
	const strictReport = JSON.parse(readFileSync(jsonOut, "utf8"));
	ok("门槛提到 4 → 判为样本不足（可证伪）",
		strict.status === 0 && /样本不足/.test(strictReport.association.verdict),
		strictReport.association.verdict);

	// 反向验证二：报告不得改账（usage_count / feedback_score 必须原样）
	ok("报告是只读的：跑完 usage/feedback 不变", readUsage() === before);

	// 反向验证三：工作区路径换成无关目录 → 记忆数为 0（键位匹配不是形同虚设）
	const stranger = mkWorkspace("unrelated-project", [intent("i1", "done", "succeeded")]);
	const strangerRun = spawnSync(process.execPath, [
		join(ROOT, "scripts", "report-memory-effect.mjs"),
		"--home", home, "--workspace", stranger, "--json", jsonOut,
	], { cwd: ROOT, encoding: "utf8" });
	const strangerReport = JSON.parse(readFileSync(jsonOut, "utf8"));
	ok("无关工作区匹配到 0 条记忆（键位隔离生效）",
		strangerRun.status === 0 && strangerReport.workspaces[0].memory.total === 0,
		JSON.stringify(strangerReport.workspaces[0]?.memory));
} finally {
	rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
