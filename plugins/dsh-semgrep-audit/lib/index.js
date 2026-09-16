
// ── 平台数据根（$DSH_HOME）────────────────────────────────────────────
// 宿主按 $DSH_HOME 装配 profiles/会话/存储；插件一律跟随，避免「一半落 A 一半落 B」。
// 未设置时等价于 ~/.dsh，故对既有用户是零行为变更。
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
// dsh-semgrep-audit — code-audit 扫描对账闭环的运行时化（D5 收口）：本机 semgrep
// 封装为模型工具，纪律内置（同 scanner-tools 范式）：
//   1) 检测制：本机未装 semgrep 拒绝执行——三级兜底提示（MCP/安装请求批准制），绝不自动装；
//   2) 规则集随预设：本地三层规则集（java 402 自建/php 1/oss 1096）自动定位，离线主通道；
//   3) 产物落证据：JSON 写 <workspace>/artifacts/scans/semgrep-<ts>.json 并回 evidence-index.md；
//   4) 命中进对账：命中自动双写 scan-reconcile.md（人读）+ scan-reconcile.csv（机读，
//      表头对齐 audit-playbook A3 契约）待处置行——命中 ≠ 漏洞，复核后经
//      redteam_finding_register(sourceOrigin=scan-confirmed/scan-false-positive) 升格；
//   5) 只读：静态扫描不写目标仓、不联网（--metrics=off），产物只落工作区。
// 挂载：preset 平面（code-audit 的 agent.cordis.yml 一行）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { defineTool } from "@deepseek-ai/dsh-tools";

const BIN_HINT = "本机未装 semgrep——三级兜底：①已连接 MCP（如 kali MCP 的 semgrep_scan，只替引擎不替规则集，命中面收窄如实标注）；②征得用户批准后安装（pip install semgrep——安装请求制，本工具绝不自动装）；③规则降级章通用模式+脚本。";
const IS_WIN = process.platform === "win32";
const WIN_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** PATH 直扫 + Windows App Paths 兜底；不依赖宿主是否继承 PATHEXT。 */
export function hasBin(bin) {
	const name = String(bin ?? "");
	if (!name) return false;
	if (name.includes("/") || name.includes("\\")) {
		try { return fs.existsSync(name); } catch { return false; }
	}
	try {
		const dirs = String(process.env.PATH || process.env.Path || "").split(path.delimiter).filter(Boolean);
		const exts = IS_WIN
			? String(process.env.PATHEXT || WIN_PATHEXT).split(";").filter(Boolean).map((e) => e.toLowerCase())
			: [""];
		for (const dir of dirs) {
			for (const ext of exts) {
				try { if (fs.existsSync(path.join(dir, name + ext))) return true; } catch { /* skip unreadable dir */ }
			}
		}
	} catch { /* fall through */ }
	try {
		return IS_WIN
			? spawnSync("where", [name], { stdio: "ignore", env: { ...process.env, PATHEXT: process.env.PATHEXT || WIN_PATHEXT } }).status === 0
			: spawnSync("/bin/sh", ["-c", `command -v -- ${name} >/dev/null 2>&1`]).status === 0;
	} catch { return false; }
}

/** 定位 code-audit refs/（三层规则集随预设分发）。候选按序探测，供测试注入。 */
export function findRefsDir(candidates) {
	const list = candidates ?? (() => {
		const out = [];
		try {
			const req = createRequire(import.meta.url);
			out.push(path.join(path.dirname(req.resolve("dsh-saker/package.json")), "preset", "code-audit", "refs"));
		} catch { /* source tree without installed root package */ }
		out.push(path.resolve(import.meta.dirname, "../../../preset/code-audit/refs"));
		const profile = process.env.DSH_PROFILE || "web";
		out.push(path.join(DSH_HOME, "profiles", profile, "node_modules", "dsh-saker", "preset", "code-audit", "refs"));
		return out;
	})();
	for (const dir of list) {
		try {
			if (fs.existsSync(path.join(dir, "lang", "java-audit", "semgrep-rules")) || fs.existsSync(path.join(dir, "semgrep-oss"))) return dir;
		} catch { /* 探测失败换下一个 */ }
	}
	return "";
}

/** 规则层 → --config 路径（相对 refs/）。custom 层由 rulesPath 直供。 */
export const RULE_LAYERS = {
	"builtin-java": ["lang/java-audit/semgrep-rules"],
	"builtin-php": ["lang/php-audit/semgrep-rules"],
	oss: ["semgrep-oss"]
};

export function buildArgs(layer, target, rulesPath, refsDir) {
	// --config 路径统一正斜杠：Windows 的 path.join 产反斜杠，同一份代码要在 POSIX/Windows
	// 两端都成立，且该值会进证据与命令回显（跨平台可读性）。semgrep 两端均接受正斜杠。
	const configs = layer === "custom"
		? [String(rulesPath ?? "")]
		: (RULE_LAYERS[layer] ?? []).map((rel) => path.join(refsDir, rel).replace(/\\/g, "/"));
	const args = ["scan", "--json", "--metrics=off", "--quiet"];
	for (const c of configs) args.push("--config", c);
	args.push(String(target));
	return { args, configs };
}

/** 解析 semgrep --json 输出：摘要 + 对账行（rule+path+line 去重，展示截断）。纯函数。 */
export function parseSemgrepJson(raw, cap = 200) {
	let j;
	try { j = JSON.parse(raw); } catch { return { ok: false, error: "semgrep 输出非 JSON（引擎异常或缺装降级输出）" }; }
	const results = Array.isArray(j.results) ? j.results : [];
	const bySeverity = {};
	const byRule = {};
	const seen = new Set();
	const hits = [];
	for (const r of results) {
		const rule = String(r.check_id ?? "?");
		const sev = String(r.extra?.severity ?? "?");
		const file = String(r.path ?? "?");
		const line = r.start?.line ?? 0;
		const k = `${rule}|${file}|${line}`;
		bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;
		byRule[rule] = (byRule[rule] ?? 0) + 1;
		if (seen.has(k)) continue;
		seen.add(k);
		if (hits.length < cap) hits.push({ rule, file, line, severity: sev, message: String(r.extra?.message ?? "").slice(0, 160) });
	}
	const topRules = Object.entries(byRule).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([rule, n]) => `${rule}×${n}`).join("、");
	return {
		ok: true,
		total: results.length,
		unique: seen.size,
		bySeverity, hits,
		errors: Array.isArray(j.errors) ? j.errors.length : 0,
		summaryText: `semgrep 命中 ${results.length} 条（去重 ${seen.size}${hits.length < seen.size ? `，展示前 ${hits.length}` : ""}）${topRules ? "；Top 规则：" + topRules : ""}——已写对账待处置（命中≠漏洞，复核后经 redteam_finding_register 升格 scan-confirmed/scan-false-positive）`
	};
}

function ensureDirs(workspace) {
	fs.mkdirSync(path.join(workspace, "artifacts", "scans"), { recursive: true });
}

/**
 * 跨进程排他锁（"wx" 创建即独占；带超时回收，防进程崩溃留死锁）。
 *
 * 为什么必须有：`appendEvidence` 与 `appendReconcile` 都是**整文件读-改-写** ——
 * 两个 Solver 同时收尾（code-audit 的多路并行是常态）时，
 * 后来者读到的是**对方写入前**的版本，于是**先写的那条证据/命中行被整段覆盖丢失**，
 * 且不报任何错（文件看起来完好，只是少了几行）。
 * 本项目其它插件（stage-gate / campaign-memory）已用同一套锁解决同类问题，这里对齐。
 *
 * @param {object} fsys - fs 实现（可注入，测试用真实 fs）
 * @param {string} lockPath - 锁文件路径
 * @param {() => any} fn - 持锁执行体
 */
function withLock(fsys, lockPath, fn, { waitMs = 5000, staleMs = 15000 } = {}) {
	const deadline = Date.now() + waitMs;
	for (;;) {
		try {
			fsys.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
			break;
		} catch {
			// 持锁者可能已崩溃：超过 staleMs 的锁直接回收
			try {
				const mtime = fsys.statSync(lockPath).mtimeMs;
				if (Date.now() - mtime > staleMs) {
					try { fsys.unlinkSync(lockPath); } catch { /* 已被别人回收 */ }
					continue;
				}
			} catch { /* 锁刚被释放，立刻重试 */ }
			if (Date.now() > deadline) throw new Error(`证据文件锁等待超时（${path.basename(lockPath)}，另一写入者未释放）`);
		}
	}
	try {
		return fn();
	} finally {
		try { fsys.unlinkSync(lockPath); } catch { /* 已被回收 */ }
	}
}

/**
 * 「分配 id + 追加证据行」的**原子**版本。
 *
 * 拆开调用会漏：`nextEvidenceId()` 读文件算下一个号，`appendEvidence()` 再写 ——
 * 两个并发调用会**读到同一份旧索引、拿到同一个 E 号**，后写的那条还顺手抹掉先写的。
 * 所以把两步放进同一把锁（锁文件就挂在证据索引上）。
 */
function appendEvidenceLocked(fsMod, workspace, cmd, file) {
	const p = path.join(workspace, "evidence-index.md");
	return withLock(fsMod, p + ".lock", () => {
		let head = "";
		try { head = fsMod.readFileSync(p, "utf8"); } catch {
			head = "# 证据索引\n\n| 编号 | 时间 | 证据 | 产生方式 | 交接/消费 |\n|---|---|---|---|---|\n";
		}
		let n = 0;
		for (const m of head.matchAll(/\| E(\d+) \|/g)) n = Math.max(n, Number(m[1]));
		const evidenceId = `E${n + 1}`;
		fsMod.writeFileSync(p, head + `| ${evidenceId} | ${new Date().toISOString()} | ${file} | ${cmd} | 扫描产物 |\n`);
		return evidenceId;
	});
}

/**
 * 对账双写：md（人读，同 scanner-tools 格式）+ csv（机读，表头对齐 audit-playbook A3 契约）。
 *
 * **加锁的原因**：两个文件都是「读全文 → 拼新内容 → 写回全文」。
 * 多路 Solver 并发收尾时，后写者会用**自己读到的旧内容**覆盖先写者的追加，
 * 表现为「命中行莫名少了几条」——不报错、文件完好，最难查的那类数据丢失。
 * 锁挂在 md 上，csv 与它同锁（两者总是成对写）。
 */
export function appendReconcile(fsMod, workspace, rows) {
	if (!rows || rows.length === 0) return 0;
	const mdPath = path.join(workspace, "scan-reconcile.md");
	return withLock(fsMod, mdPath + ".lock", () => {
		let head = "";
		try { head = fsMod.readFileSync(mdPath, "utf8"); } catch {
			head = "# 扫描命中对账（scan-reconcile）\n\n| 来源 | 命中 | 终态 |\n|---|---|---|\n";
		}
		fsMod.writeFileSync(mdPath, head + rows.map((r) => `| semgrep | ${r.rule} @ ${r.file}:${r.line} [${r.severity}] | 待处置（命中≠漏洞，须复核+补真实调用链） |`).join("\n") + "\n");
		const csvPath = path.join(workspace, "scan-reconcile.csv");
		let csv = "";
		try { csv = fsMod.readFileSync(csvPath, "utf8"); } catch { csv = "scanner,rule,file,line,verdict,reason\n"; }
		const esc = (s) => /[",\n]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s);
		fsMod.writeFileSync(csvPath, csv + rows.map((r) => ["semgrep", r.rule, r.file, r.line, "待处置", "命中≠漏洞，复核后经 register 升格"].map(esc).join(",")).join("\n") + "\n");
		return rows.length;
	});
}

/** 运行核心（spawn/fs/二进制检测均可注入供测试）。 */
export function runSemgrep({ workspace, target, layer = "builtin-java", rulesPath, extraArgs, spawnFn, fsMod, refsCandidates, cap, hasBinFn }) {
	const fsx = fsMod ?? fs;
	if (!(hasBinFn ?? hasBin)("semgrep")) return { ok: false, error: BIN_HINT };
	const refsDir = findRefsDir(refsCandidates);
	if (layer !== "custom" && !refsDir) return { ok: false, error: "未定位到 code-audit refs/（三层规则集随预设分发）——请用 layer=custom + rules_path 指定规则路径，或检查预设部署布局" };
	if (layer === "custom" && !rulesPath) return { ok: false, error: "layer=custom 必填 rules_path（规则文件或目录）" };
	const { args, configs } = buildArgs(layer, target, rulesPath, refsDir);
	if (layer === "custom" && !fsx.existsSync(String(rulesPath))) return { ok: false, error: `规则路径不存在：${rulesPath}` };
	if (!fsx.existsSync(String(target))) return { ok: false, error: `扫描目标不存在：${target}` };
	const full = [...args, ...(extraArgs ?? [])];
	const cmdStr = `semgrep ${full.join(" ")}`;
	ensureDirs(workspace);
	const ts = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
	const outFile = path.join(workspace, "artifacts", "scans", `semgrep-${ts}.json`);
	const proc = (spawnFn ?? ((bin, a) => spawnSync(bin, a, { timeout: 600_000, maxBuffer: 64 * 1024 * 1024 })))("semgrep", full);
	if (proc.error) return { ok: false, error: `执行失败：${proc.error.message}` };
	const parsed = parseSemgrepJson(proc.stdout ? proc.stdout.toString() : "", cap);
	if (!parsed.ok) return { ok: false, error: parsed.error };
	fsx.writeFileSync(outFile, proc.stdout.toString());
	// 分配 id 与写行必须原子（见 appendEvidenceLocked 的说明）
	const evidenceId = appendEvidenceLocked(fsx, workspace, `${cmdStr}（规则层 ${layer}：${configs.join("、")}）`, path.relative(workspace, outFile));
	const reconciled = appendReconcile(fsx, workspace, parsed.hits);
	return { ok: true, evidenceId, file: path.relative(workspace, outFile), layer, total: parsed.total, unique: parsed.unique, bySeverity: parsed.bySeverity, reconciled, summaryText: parsed.summaryText };
}

const name = "semgrep-audit";
const inject = ["tools"];

function apply(ctx) {
	ctx.tools.register(defineTool({
		name: "semgrep_scan",
		description: "Local semgrep scan with the preset's offline rule sets (code-audit 三层规则集自动定位；离线主通道). Hits dual-write scan-reconcile.md/.csv as 待处置 — hit ≠ vuln: 复核+补真实调用链后经 redteam_finding_register(sourceOrigin=scan-confirmed/scan-false-positive) 升格, A3 数量守恒. Local binary only — never auto-installs.",
		parameters: {
			target: { type: "string", required: true, description: "扫描目标（仓库/目录根，绝对或相对工作区）" },
			workspace: { type: "string", required: true, description: "任务工作区根（产物与对账落此）" },
			layer: { type: "string", enum: ["builtin-java", "builtin-php", "oss", "custom"], required: true, description: "规则层：builtin-java=402 条自建/builtin-php=php 规则/oss=1096 条开源规则集/custom=自定路径" },
			rules_path: { type: "string", description: "layer=custom 时的规则文件/目录路径（必填）" }
		},
		output: {
			schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true } } },
			render: (_a, v) => [{ type: "text", text: v.ok ? `semgrep：${v.summaryText ?? ""}（证据 ${v.evidenceId}）` : `semgrep 拒绝/失败：${v.error}` }]
		},
		execute(args) {
			return Promise.resolve(runSemgrep({ workspace: path.resolve(args.workspace), target: path.resolve(args.target), layer: args.layer, rulesPath: args.rules_path }));
		}
	}));
}

export { apply, inject, name };
