#!/usr/bin/env node
// 报告草稿生成器：把**结构化成果**（redteam-results 台账）落成工作区里的
// `reports/<序号>-<标题>.md` 六字段报告草稿，交给模型复核/补全。
//
// 为什么要有它：报告的六个字段（名称/描述/等级/地址/测试过程/修复建议）在台账里
// 本来就是结构化的，模型再从零手写一遍只会带来两种退化——字段漏项、等级与台账不一致。
// 这里把能确定的部分**确定性**落盘，编不出来的部分**如实标 `（待补：…）`，
// 绝不用占位文字去骗 stage_gate 的 marker 检查**（测试里专门锁了这条：
// 证据不足的草稿必须仍然过不了 P2 门禁）。
//
// 会话来源：工作区 `operation-state.json` 里意图带的 sessionId（stage-gate 的公开交换面），
// 或用 `--session` 显式指定。never overwrite：已有的 `NN-*.md` 一律跳过。
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { draftFileName, renderDraft } from "../lib/report-drafts.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const index = argv.indexOf(`--${name}`);
	return index >= 0 ? argv[index + 1] : fallback;
};
const argList = (name) => {
	const out = [];
	for (let i = 0; i < argv.length; i += 1) if (argv[i] === `--${name}` && argv[i + 1]) out.push(argv[i + 1]);
	return out;
};

const HOME = resolve(arg("home", process.env.DSH_HOME || join(homedir(), ".dsh")));
const WORKSPACE = resolve(arg("workspace", process.cwd()));
const DRY = argv.includes("--dry");
const INCLUDE_FALSE_POSITIVE = argv.includes("--all");
const REPORT_DIR = join(WORKSPACE, "reports");
const STATE_FILE = join(WORKSPACE, "operation-state.json");

function readJson(file) {
	try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

/** 工作区 → 会话 id：优先显式参数，其次读台账里意图带的 sessionId。 */
export function resolveSessions(workspace, explicit = []) {
	const ids = new Set(explicit.map((x) => String(x).trim()).filter(Boolean));
	const state = readJson(join(workspace, "operation-state.json"));
	for (const intent of Array.isArray(state?.intents) ? state.intents : []) {
		const id = String(intent?.sessionId ?? "").trim();
		if (id) ids.add(id);
	}
	return [...ids];
}

const summary = {
	generatedAt: new Date().toISOString(),
	workspace: WORKSPACE,
	home: HOME,
	dryRun: DRY,
	sessions: [],
	created: [],
	skippedExisting: [],
	skippedFalsePositive: [],
	error: "",
};

const sessions = resolveSessions(WORKSPACE, argList("session"));
summary.sessions = sessions;
const storePath = join(HOME, "redteam-results", "results.db");

if ((argv.includes("--help") || argv.includes("-h"))) {
	console.log("用法: node scripts/generate-report-drafts.mjs --workspace <dir> [--home <DSH_HOME>] [--session <id>]... [--dry] [--all]");
	process.exit(0);
}

if (sessions.length === 0) {
	summary.error = "没有可用会话：工作区台账里没有 sessionId，也没给 --session";
} else if (!existsSync(storePath)) {
	summary.error = `成果库不存在：${storePath}`;
} else {
	const { openStore, allFindings } = await import("../plugins/dsh-redteam-results/lib/store.js");
	const store = openStore(storePath);
	try {
		const existing = existsSync(REPORT_DIR) ? readdirSync(REPORT_DIR) : [];
		if (!DRY) mkdirSync(REPORT_DIR, { recursive: true });
		for (const sessionId of sessions) {
			for (const mode of ["pentest", "code-audit", "ctf-solver", "binary-analysis", "attack-defense", "av-evasion", "incident-response", "cloud-security"]) {
				let findings = [];
				try { findings = allFindings(store, sessionId, mode); } catch { findings = []; }
				for (const finding of findings) {
					const name = draftFileName(finding);
					const full = join(REPORT_DIR, name);
					const already = existing.some((file) => file.startsWith(`${String(finding.seq).padStart(2, "0")}-`)) || existsSync(full);
					if (already) { summary.skippedExisting.push({ sessionId, mode, id: finding.id, file: name }); continue; }
					if (finding.status === "false-positive" && !INCLUDE_FALSE_POSITIVE) {
						summary.skippedFalsePositive.push({ sessionId, mode, id: finding.id, title: finding.title });
						continue;
					}
					if (!DRY) writeFileSync(full, `${renderDraft(finding)}\n`, "utf8");
					existing.push(name);
					summary.created.push({ sessionId, mode, id: finding.id, file: name, status: finding.status, severity: finding.severity });
				}
			}
		}
	} finally {
		store.close();
	}
}

console.log(`工作区：${basename(WORKSPACE)} · 会话 ${sessions.length} 个 · 成果库：${storePath}`);
if (summary.error) console.log(`注意：${summary.error}`);
for (const item of summary.created) console.log(`  新建  ${item.file}  [${item.severity} / ${item.status}]`);
for (const item of summary.skippedExisting) console.log(`  跳过  ${item.file}（已存在，不覆盖）`);
for (const item of summary.skippedFalsePositive) console.log(`  跳过  #${item.id} ${item.title}（误报，--all 可强制）`);
console.log(summary.dryRun ? `dry-run：未写盘（将新建 ${summary.created.length} 份）` : `完成：新建 ${summary.created.length} 份，跳过已存在 ${summary.skippedExisting.length} 份`);
