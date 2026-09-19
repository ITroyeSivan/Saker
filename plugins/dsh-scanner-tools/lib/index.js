// dsh-scanner-tools — 本机扫描器封装为模型工具（nuclei/httpx/ffuf/nmap/subfinder/whatweb），
// 纪律内置：
//   1) 速率纪律参数化：保守默认（nuclei -rl 15 / httpx -rl 25 / ffuf -rate 50 / nmap --max-rate 1000 /
//      whatweb -a 1 / hydra -t 4），显式提速会记录在扫描审计里（默认值与 pentest-playbook 速率纪律一致）；
//   2) 产物落证据：JSON/JSONL 写 <workspace>/artifacts/scans/；注册表工具全文输出写
//      artifacts/tool-output/（超限返回封顶预览 + 落盘路径供按需读取）；均回 evidence-index.md 一行；
//   3) 命中进对账：nuclei 命中自动写 scan-reconcile.md 待处置行（命中 ≠ 漏洞，复核后终态）；
//   4) 防盲打：主动扫描（nuclei/ffuf/nmap）要求目标已登记 assets.md / cloud-assets.md；轻探测
//      （httpx/whatweb/被动枚举 subfinder）允许未登记但产出登记建议；
//   5) 输出治理：返回模型的预览封顶（头尾拼接+全文指针），全文永落盘不丢；每工具连续失败
//      3 次熔断 60s（防死磕——提示改走阶梯下级通道）；
//   6) 工具调用阶梯（六节点）：本机 → MCP → 已装替代 → MCP 备选 → 询问安装 → 不批准走脚本编写
//      （registry.js 每个 def.tiers 落到工具描述与缺装提示；绝不自动安装）。
// 挂载：preset 平面（pentest / attack-defense / cloud-security / ctf-solver 各自 agent.cordis.yml 一行）。

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { TOOL_DEFS, buildArgs, tiersLine } from "./registry.js";

function sessionIdOf(exec) {
	return String(exec?.agent?.session?.id ?? exec?.agent?.id ?? "");
}

/**
 * Optional bridge to stage-gate: a long-running scanner inherits any queued
 * intent whose owner matches the tool name, then closes it with the tool's
 * real result. The dynamic import keeps scanner-tools runnable outside Saker.
 */
async function runWithTaskTracking(workspace, toolName, exec, run) {
	let api;
	try { api = await import("@dsh-external/dsh-stage-gate"); } catch { return { value: await run(), taskId: "" }; }
	if (typeof api?.runTrackedTask !== "function") return { value: await run(), taskId: "" };
	return api.runTrackedTask(workspace, { sessionId: sessionIdOf(exec), toolName }, run);
}

function withTaskId(result) {
	return result.taskId ? { ...result.value, task_id: result.taskId } : result.value;
}

/**
 * 落盘文件名的时间戳（含毫秒 + 4 位随机后缀）。
 *
 * **为什么不能用秒级**：原先用 `toISOString().slice(0,14)`（YYYYMMDDHHmmss）拼
 * `tool-output/<tool>-<ts>.txt` 与 `scans/<tool>-<ts>.json` —— 同一秒内有两次调用
 * （多路 Solver 并行、或同一轮里连发两个扫描）就会**撞同一个文件名，后者静默覆盖前者**：
 * 证据原件没了、对账指向的却是后写的那份，而日志里一点异常都没有。
 * 加毫秒把窗口从 1s 缩到 1ms，再加 4 位随机后缀兜住「同毫秒并发」。
 * 格式仍可读可排序：`nmap-20260914T001234567-a1b2.txt`。
 */
function stamp() {
	return new Date().toISOString().replace(/[-:.]/g, "").slice(0, 17) + "-" + randomBytes(6).toString("hex");
}

const RATE_DEFAULTS = { nuclei: 15, httpx: 25, ffuf: 50 }; // 保守默认；显式覆盖会留痕
const BIN_HINT = "三级兜底：本机未装该工具——先查已连接 MCP（如 kali MCP），仍无则按 pentest-playbook 安装请求流程征得用户批准后安装；本工具绝不自动安装。";
const IS_WIN = process.platform === "win32";
const WIN_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** PATH 直扫 + Windows App Paths 兜底；不依赖宿主是否继承 PATHEXT。 */
export function hasBin(bin) {
	const name = String(bin ?? "");
	if (!name) return false;
	if (name.includes("/") || name.includes("\\")) {
		try {
			if (!fs.existsSync(name)) return false;
			return IS_WIN ? true : fs.statSync(name).isFile();
		} catch { return false; }
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

/**
 * sec-config owns the operator's tool catalog. scanner-tools reads that same
 * namespace instead of maintaining a second path list: entries win when
 * present (the v2 catalog representation), legacy tools remain as a fallback,
 * and hidden tools are deliberately unavailable.
 */
export function configuredToolPaths(section) {
	const out = {};
	if (!section || typeof section !== "object") return out;
	const hidden = new Set(Array.isArray(section.hiddenTools)
		? section.hiddenTools.map((key) => String(key).toLowerCase())
		: []);
	const add = (key, value) => {
		const k = String(key || "").toLowerCase();
		const p = typeof value === "string" ? value.trim() : "";
		if (!k || !p || hidden.has(k) || out[k] !== undefined) return;
		out[k] = p;
	};
	if (Array.isArray(section.entries) && section.entries.length > 0) {
		for (const entry of section.entries) {
			if (entry && typeof entry === "object") add(entry.key, entry.path);
		}
		return out;
	}
	if (section.tools && typeof section.tools === "object") {
		for (const [key, value] of Object.entries(section.tools)) add(key, value);
	}
	return out;
}

function executablePathCandidates(value) {
	const raw = String(value || "");
	if (!IS_WIN || /\.[A-Za-z0-9]+$/.test(raw)) return [raw];
	return [raw, `${raw}.exe`, `${raw}.cmd`, `${raw}.bat`, `${raw}.com`];
}

function firstExistingFile(paths) {
	for (const candidate of paths) {
		try {
			if (fs.statSync(candidate).isFile()) return candidate;
		} catch { /* try next candidate */ }
	}
	return null;
}

const ROOT_SEARCH_SKIP = new Set([".git", ".hg", ".svn", "node_modules", ".venv", "venv", "__pycache__"]);
const rootIndexCache = new Map(); // root → { at, index: Map<basename, { file, score }> }
const ROOT_SEARCH_TTL_MS = 60_000;

function buildRootIndex(root) {
	const index = new Map();
	const noisy = new Set(["responder", "multirelay", "thirdparty", "third_party", "vendor", "docs", "doc", "test", "tests", "build", "dist", ".github"]);
	const stack = [{ dir: root, depth: 0 }];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current || current.depth > 6) continue;
		let entries;
		try { entries = fs.readdirSync(current.dir, { withFileTypes: true }); } catch { continue; }
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (!ROOT_SEARCH_SKIP.has(entry.name)) stack.push({ dir: path.join(current.dir, entry.name), depth: current.depth + 1 });
				continue;
			}
			if (entry.isFile()) {
				const file = path.join(current.dir, entry.name);
				const parts = path.relative(root, file).split(/[\\/]/).filter(Boolean).map((part) => part.toLowerCase());
				let score = parts.length * 10;
				if (parts.includes("examples")) score -= 4;
				for (const part of parts) if (noisy.has(part)) score += 40;
				const key = entry.name.toLowerCase();
				const previous = index.get(key);
				if (previous === undefined || score < previous.score) {
					index.set(key, { file, score });
				}
			}
		}
	}
	return index;
}

function getRootIndex(root) {
	const now = Date.now();
	const cached = rootIndexCache.get(root);
	if (cached && now - cached.at < ROOT_SEARCH_TTL_MS) return cached.index;
	const index = buildRootIndex(root);
	rootIndexCache.set(root, { at: now, index });
	return index;
}

function findToolFileInRoots(candidate, roots) {
	const wanted = new Set(executablePathCandidates(candidate).map((item) => path.basename(item).toLowerCase()));
	let best = null;
	let bestScore = Number.POSITIVE_INFINITY;
	for (const root of roots) {
		if (typeof root !== "string" || !root.trim()) continue;
		try { if (!fs.statSync(root).isDirectory()) continue; } catch { continue; }
		const index = getRootIndex(root);
		for (const name of wanted) {
			const hit = index.get(name);
			if (hit && hit.score < bestScore) {
				best = hit.file;
				bestScore = hit.score;
			}
		}
	}
	return best;
}

function configuredPathForTool(configured, def) {
	if (!configured || typeof configured !== "object") return "";
	const keys = [def?.id, def?.bin, ...(Array.isArray(def?.bins) ? def.bins : [])]
		.map((key) => String(key || "").toLowerCase());
	return keys.map((key) => configured[key]).find((value) => typeof value === "string" && value) || "";
}

/**
 * Resolve one registry candidate against the configured path first, then PATH.
 * A configured file wins as-is; a configured directory is treated as a tool
 * root and candidates are searched below it with Windows executable suffixes.
 * This is the missing bridge between the settings page and actual execution:
 * without it a tool configured only in sec-config is reported missing unless
 * the operator also edits PATH.
 */
function stripScriptExtension(value) {
	return path.basename(String(value || "")).replace(/\.[^.]+$/, "").toLowerCase();
}

/**
 * Resolve one configured path to the actual file for a candidate. A file
 * whose logical name matches the candidate wins; for a single-command tool an
 * operator-renamed binary remains accepted. For multi-name suites (for
 * example netexec/nxc) a mismatched file is treated as a directory anchor and
 * the sibling candidate is searched first, preventing the wrong module from
 * being executed merely because it was the entry selected in sec-config.
 */
export function resolveToolBin(candidate, configuredPath = "", options = {}) {
	const name = String(candidate || "");
	const configured = String(configuredPath || "").trim();
	const acceptAnyFile = options.acceptAnyFile !== false;
	const roots = Array.isArray(options.roots) ? options.roots : [];
	if (configured) {
		if (configured.includes("/") || configured.includes("\\")) {
			const exact = firstExistingFile(executablePathCandidates(configured));
			if (exact) {
				const sameName = stripScriptExtension(exact) === stripScriptExtension(name);
				if (sameName || acceptAnyFile) return exact;
				const sibling = firstExistingFile(executablePathCandidates(path.join(path.dirname(exact), name)));
				if (sibling) return sibling;
			}
			let stat = null;
			try { stat = fs.statSync(configured); } catch { stat = null; }
			if (stat && stat.isDirectory()) {
				const found = firstExistingFile(executablePathCandidates(path.join(configured, name)));
				if (found) return found;
			}
		} else if (hasBin(configured)) {
			return configured;
		}
	}
	const fromRoots = roots.length > 0 ? findToolFileInRoots(name, roots) : null;
	if (fromRoots) return fromRoots;
	return hasBin(name) ? name : null;
}

function resolvePythonLauncher(configured) {
	const map = configured && typeof configured === "object" ? configured : {};
	const candidates = [map.python, map.python3, process.env.PYTHON, process.env.PYTHON3]
		.filter((value) => typeof value === "string" && value.trim());
	for (const candidate of candidates) {
		const resolved = resolveToolBin("python", candidate);
		if (resolved) return { bin: resolved, prefix: [] };
	}
	if (IS_WIN && hasBin("py")) return { bin: "py", prefix: ["-3"] };
	for (const name of (IS_WIN ? ["python", "python3"] : ["python3", "python"])) {
		if (hasBin(name)) return { bin: name, prefix: [] };
	}
	return null;
}

/**
 * Convert a resolved file into a spawn invocation. Python scripts are a
 * first-class case because the security catalog intentionally contains
 * repositories such as sqlmap and impacket whose executable entry is a .py
 * file; treating that file as a native binary silently fails on Windows.
 */
export function resolveToolInvocation(candidate, configuredPath = "", options = {}) {
	const file = resolveToolBin(candidate, configuredPath, options);
	if (!file) return null;
	const ext = path.extname(file).toLowerCase();
	if (ext === ".py" || ext === ".pyw") {
		const launcher = resolvePythonLauncher(options.configured);
		if (!launcher) return { bin: file, prefix: [], file, error: "检测到 Python 脚本，但找不到可用的 Python 解释器（请在安全配置中配置 python，或把 Python 加入 PATH）" };
		return { bin: launcher.bin, prefix: [...launcher.prefix, file], file };
	}
	if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
		return { bin: process.execPath, prefix: [file], file };
	}
	return { bin: file, prefix: [], file };
}

/**
 * Return the definitions that should enter the model tool surface. Optional
 * advanced tools are skipped until at least one known binary name exists, so
 * broad capability coverage does not become an always-on schema tax.
 */
export function registerableDefs(defs, probe = hasBin) {
	return Object.values(defs).filter((def) => {
		if (!def.optional) return true;
		const candidates = def.bins ?? [def.bin];
		return candidates.some((candidate) => !String(candidate).includes("{module}") && probe(candidate, def));
	});
}

/** target host must appear in the baseline file (active scans only). Returns {ok, hint, baseline}.
 *  基线文件按预设双候选探测：assets.md（pentest/攻防）或 cloud-assets.md（cloud-security C1）——
 *  任一存在即按其校验；两个都无才拒绝。 */
export function checkRegistered(fsMod, workspace, target) {
	const baselines = ["cloud-assets.md", "assets.md"]; // cloud 前置：云会话的基线是 cloud-assets.md
	let text = "", used = "";
	for (const f of baselines) {
		try { text = fsMod.readFileSync(path.join(workspace, f), "utf8"); } catch { text = ""; }
		if (text) { used = f; break; }
	}
	if (!text) return { ok: false, hint: "工作区无 assets.md / cloud-assets.md 资产基线——先完成测绘阶段（pentest Gate P1 / cloud Gate C1）再主动扫描" };
	const host = String(target).replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
	return text.includes(host)
		? { ok: true, hint: "" }
		: { ok: false, hint: `目标 ${host} 未登记在 ${used}——防盲打：先登记资产（测绘组回填基线文件）再主动扫描` };
}

function ensureDirs(workspace) {
	fs.mkdirSync(path.join(workspace, "artifacts", "scans"), { recursive: true });
}

//#region 输出治理：返回模型的预览封顶 + 全文永落盘可回读 + 每工具连续失败熔断

const PREVIEW_HEAD = 3600, PREVIEW_TAIL = 2000;

/** 预览封顶（纯函数）：短输出原样返回；长输出头尾拼接 + 中间省略量标注。 */
export function governPreview(raw) {
	const s = String(raw ?? "");
	if (s.length <= PREVIEW_HEAD + PREVIEW_TAIL + 200) return { preview: s, truncated: false, bytes: s.length };
	const mid = s.length - PREVIEW_HEAD - PREVIEW_TAIL;
	return { preview: s.slice(0, PREVIEW_HEAD) + `\n…（中间省略 ${mid} 字符——全文已落盘，按需读取）…\n` + s.slice(-PREVIEW_TAIL), truncated: true, bytes: s.length };
}

/** 全文落盘（证据原件）：artifacts/tool-output/<tool>-<ts>.txt，返回工作区相对路径。 */
export function spillOutput(fsMod, workspace, tool, raw) {
	const dir = path.join(workspace, "artifacts", "tool-output");
	fsMod.mkdirSync(dir, { recursive: true });
	const ts = stamp();
	const file = path.join(dir, `${tool}-${ts}.txt`);
	fsMod.writeFileSync(file, String(raw ?? ""));
	// 回读指针统一正斜杠：该值会写进证据并交给模型跨平台读取，Windows 反斜杠会污染记录。
	return path.relative(workspace, file).replace(/\\/g, "/");
}

const BREAKER_THRESHOLD = 3, BREAKER_COOLDOWN_MS = 60_000;
const breakerMap = new Map(); // tool → { fails, until }（进程级；重启自然重置）

/** 熔断查询：冷却中返回剩余秒数，放行返回 0。 */
export function breakerCheck(tool, nowMs = Date.now()) {
	const b = breakerMap.get(tool);
	return b && b.until > nowMs ? Math.ceil((b.until - nowMs) / 1000) : 0;
}

/** 熔断记账：成功清零；连续失败达阈值进入冷却（防死磕同一工具——提示改走阶梯下级通道）。 */
export function breakerRecord(tool, ok, nowMs = Date.now()) {
	const b = breakerMap.get(tool) ?? { fails: 0, until: 0 };
	if (ok) { b.fails = 0; b.until = 0; }
	else { b.fails += 1; if (b.fails >= BREAKER_THRESHOLD) { b.until = nowMs + BREAKER_COOLDOWN_MS; b.fails = 0; } }
	breakerMap.set(tool, b);
}

//#endregion

function appendEvidence(workspace, evidenceId, cmd, file) {
	const p = path.join(workspace, "evidence-index.md");
	let head = "";
	try { head = fs.readFileSync(p, "utf8"); } catch {
		head = "# 证据索引\n\n| 编号 | 时间 | 证据 | 产生方式 | 交接/消费 |\n|---|---|---|---|---|\n";
	}
	fs.writeFileSync(p, head + `| ${evidenceId} | ${new Date().toISOString()} | ${file} | ${cmd} | 扫描产物 |\n`);
}

function appendReconcile(workspace, rows) {
	if (!rows || rows.length === 0) return 0;
	const p = path.join(workspace, "scan-reconcile.md");
	let head = "";
	try { head = fs.readFileSync(p, "utf8"); } catch {
		head = "# 扫描命中对账（scan-reconcile）\n\n| 来源 | 命中 | 终态 |\n|---|---|---|\n";
	}
	const lines = rows.map((r) => `| ${r.source} | ${r.hit} | 待处置（命中≠漏洞，须复核+对照三件套） |`).join("\n");
	fs.writeFileSync(p, head + lines + "\n");
	return rows.length;
}

function nextEvidenceId(workspace) {
	let n = 0;
	try {
		const text = fs.readFileSync(path.join(workspace, "evidence-index.md"), "utf8");
		for (const m of text.matchAll(/\| E(\d+) \|/g)) n = Math.max(n, Number(m[1]));
	} catch { /* 尚无索引 */ }
	return `E${n + 1}`;
}

function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Cross-process lock for the two human-readable scan ledgers. */
function withLedgerLock(workspace, fn) {
	const lockDir = path.join(workspace, "artifacts", ".scan-ledger-locks");
	fs.mkdirSync(lockDir, { recursive: true });
	const lockFile = path.join(lockDir, "persist.lock");
	const started = Date.now();
	for (;;) {
		let fd;
		try {
			fd = fs.openSync(lockFile, "wx");
			try { return fn(); }
			finally {
				try { fs.closeSync(fd); } catch { /* already closed */ }
				try { fs.unlinkSync(lockFile); } catch { /* already released */ }
			}
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
			// Break a stale lock left by a crashed process, but never steal a fresh one.
			try {
				if (Date.now() - fs.statSync(lockFile).mtimeMs > 60_000) fs.unlinkSync(lockFile);
			} catch { /* raced with release */ }
			if (Date.now() - started > 10_000) throw new Error("扫描台账锁等待超时");
			sleepSync(20);
		}
	}
}

/** Serialize evidence-id allocation and both ledger appends under one cross-process lock. */
export function persistScanRecords(workspace, { command, file, rows = [] }) {
	return withLedgerLock(workspace, () => {
		const evidenceId = nextEvidenceId(workspace);
		appendEvidence(workspace, evidenceId, command, file);
		appendReconcile(workspace, rows);
		return evidenceId;
	});
}

function cappedCollector(limit) {
	const chunks = [];
	let size = 0;
	let total = 0;
	let overflow = false;
	return {
		push(chunk) {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			total += bytes.length;
			if (size < limit) {
				const room = limit - size;
				const kept = bytes.length > room ? bytes.subarray(0, room) : bytes;
				if (kept.length > 0) {
					chunks.push(kept);
					size += kept.length;
				}
			}
			if (total > limit) overflow = true;
		},
		value() { return Buffer.concat(chunks, size); },
		overflowed() { return overflow; },
	};
}

/**
 * Run one external tool without blocking the host event loop. The previous
 * spawnSync implementation froze the entire dsh host for the lifetime of a
 * scan (up to 15 minutes for nuclei), which also froze the UI and every other
 * session sharing the process.
 */
function runProcess(bin, args, { timeoutMs, maxBuffer }) {
	return new Promise((resolve) => {
		let settled = false;
		let timedOut = false;
		const stdout = cappedCollector(maxBuffer);
		const stderr = cappedCollector(maxBuffer);
		let child;
		try {
			child = spawn(bin, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			resolve({ status: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error });
			return;
		}
		const timer = setTimeout(() => {
			timedOut = true;
			try { child.kill(); } catch { /* process may already be gone */ }
		}, timeoutMs);
		const finish = (result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		child.stdout?.on("data", (chunk) => {
			stdout.push(chunk);
			if (stdout.overflowed()) {
				try { child.kill(); } catch { /* already gone */ }
			}
		});
		child.stderr?.on("data", (chunk) => {
			stderr.push(chunk);
			if (stderr.overflowed()) {
				try { child.kill(); } catch { /* already gone */ }
			}
		});
		child.on("error", (error) => finish({ status: null, stdout: stdout.value(), stderr: stderr.value(), error }));
		child.on("close", (status) => {
			const error = timedOut
				? Object.assign(new Error("ETIMEDOUT: tool exceeded its time limit"), { code: "ETIMEDOUT" })
				: stdout.overflowed() || stderr.overflowed()
					? Object.assign(new Error("ENOBUFS: tool output exceeded the capture limit"), { code: "ENOBUFS" })
					: undefined;
			finish({ status, stdout: stdout.value(), stderr: stderr.value(), error });
		});
	});
}

/**
 * 目录里（限深度）是否真有 nuclei 模板文件。
 * 限深度是为了不把 13000+ 模板全遍历一遍——命中第一个就返回。
 */
function dirHasTemplateYaml(fsys, dir, maxDepth = 3) {
	let entries;
	try { entries = fsys.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
	for (const e of entries) {
		if (e.isFile() && /\.ya?ml$/i.test(e.name)) return true;
		if (e.isDirectory() && maxDepth > 0) {
			if (dirHasTemplateYaml(fsys, path.join(dir, e.name), maxDepth - 1)) return true;
		}
	}
	return false;
}

/**
 * 挑一个**确实含模板**的 nuclei 模板目录（挑不到返回空串）。
 *
 * 顺序：Windows 默认位置优先，其次 .config（Linux 惯例，本机是个符号链接），
 * 最后 macOS 位置。只"存在"不算数——必须是目录里真能找到 .yaml，
 * 否则就是本机踩过的那个坑：目录在、nuclei 却不认，空模板集启动后联网卡十几分钟。
 */
export function pickNucleiTemplateDir(fsys, home) {
	const candidates = [
		path.join(home, "nuclei-templates"),
		path.join(home, ".config", "nuclei", "templates"),
		path.join(home, "Library", "Application Support", "nuclei", "templates")
	];
	for (const d of candidates) {
		if (!d) continue;
		try { if (!fsys.existsSync(d)) continue; } catch { continue; }
		if (!dirHasTemplateYaml(fsys, d)) continue;
		// 必须回**真实路径**：nuclei 不跟符号链接。
		// 实测 `-t <符号链接>` 直接报 `no templates provided for scan`；
		// 换成它指向的真实目录，同一个靶标 8.8 秒跑完。
		try { return fsys.realpathSync(d); } catch { return d; }
	}
	return "";
}

/** Run one scanner with rate discipline + evidence + reconcile. Pure-ish core (fs injectable in tests). */
export async function runScan({ bin, args, workspace, tool, rate, defaultRate, active, target, parse, outFile: outFileOverride, configured = {}, roots = [] }) {
	const cooldown = breakerCheck(tool);
	if (cooldown > 0) return { ok: false, error: `熔断中：${tool} 连续失败 3 次进入 60s 冷却（剩 ${cooldown}s）——改走工具调用阶梯下级通道（MCP/替代/脚本）或稍后重试`, bin };
	const configuredPath = configuredPathForTool(configured, { id: tool, bin });
	const invocation = resolveToolInvocation(bin, configuredPath, { configured, roots });
	if (!invocation || invocation.error) {
		const pathHint = configuredPath ? `已配置路径不可执行：${configuredPath}；` : "";
		return { ok: false, error: `${invocation?.error ? invocation.error + "；" : ""}${pathHint}${BIN_HINT}`, bin };
	}
	const resolvedBin = invocation.file;
	if (active) {
		const reg = checkRegistered(fs, workspace, target);
		if (!reg.ok) return { ok: false, error: reg.hint, bin };
	}
	ensureDirs(workspace);
	const home = process.env.HOME || process.env.USERPROFILE || "";
	const isNuclei = path.basename(resolvedBin).toLowerCase().startsWith("nuclei");
	// nuclei 模板库：**必须显式 -t 指过去**，不能只"检查一下存在性就放行"。
	//
	// 踩过的坑（2026-09-19 实测）：候选表里混了 macOS/Linux 路径，
	// 本机 `~/.config/nuclei/templates` 是个指向 E 盘的**符号链接**且真有 13742 个模板，
	// existsSync 通过 → 闸放行；但 **Windows 版 nuclei 只认 `%USERPROFILE%\nuclei-templates`**，
	// 它不认这个路径 → 空模板集启动 → 联网初始化 → 实测卡 8 分 52 秒（超时上限 15 分钟）。
	// 护网现场每次调用白等十几分钟，还占着 CPU。
	// 修法：自己挑一个**确实含模板**的目录，再用 `-t` 明确告诉它。
	const nucleiTemplateDir = isNuclei ? pickNucleiTemplateDir(fs, home) : "";
	if (isNuclei && !nucleiTemplateDir) {
		return { ok: false, error: "nuclei 模板库不存在（候选目录里没有 .yaml 模板）——首次使用需一次性下载（nuclei -update-templates，数据非工具安装）。按用户基准需批准：请在 DSH 会话外自行执行，或明确批准后由模型执行。", bin };
	}
	const ts = stamp();
	const outFile = outFileOverride ?? path.join(workspace, "artifacts", "scans", `${tool}-${ts}.json`);
	const full = [...args];
	if (nucleiTemplateDir) full.push("-t", nucleiTemplateDir);
	if (rate && rate !== defaultRate) full.push(...(tool === "nuclei" ? ["-rl", String(rate)] : tool === "httpx" ? ["-rl", String(rate)] : ["-rate", String(rate)]));
	else full.push(...(tool === "ffuf" ? ["-rate", String(defaultRate)] : ["-rl", String(defaultRate)]));
	const spawnArgs = [...invocation.prefix, ...full];
	const cmdStr = `${invocation.bin} ${spawnArgs.join(" ")}`;
	const timeoutMs = path.basename(resolvedBin).toLowerCase().startsWith("nuclei") ? 900_000 : 300_000;
	const proc = await runProcess(invocation.bin, spawnArgs, { timeoutMs, maxBuffer: 64 * 1024 * 1024 });
	if (proc.error) { breakerRecord(tool, false); return { ok: false, error: `执行失败：${proc.error.message}${proc.error.code === "ETIMEDOUT" ? `（超时 ${timeoutMs / 1000}s${path.basename(resolvedBin).toLowerCase().startsWith("nuclei") ? "——模板库缺失时首次会尝试拉取导致超时" : ""}）` : ""}`, bin }; }
	breakerRecord(tool, proc.status === 0);

	const raw = proc.stdout ? proc.stdout.toString() : "";
	const parsed = parse ? parse(raw, { ...proc, outFile }) : { raw: raw };
	// 落盘所有权：工具已自行写出结果文件（如 ffuf -o）时不得再覆盖——否则证据原件被 stdout 顶掉，
	// 扫描命中的结构化数组消失而工具仍报成功。缺文件时兜底回写 stdout，保证证据指针不悬空。
	if (parsed.__skipWrite) {
		if (!fs.existsSync(outFile)) fs.writeFileSync(outFile, JSON.stringify({ raw: raw }, null, 2));
	} else if (parsed.__writeRaw !== null && parsed.__writeRaw !== undefined) {
		fs.writeFileSync(outFile, parsed.__writeRaw);
	} else {
		fs.writeFileSync(outFile, JSON.stringify({ raw: raw }, null, 2)); // 全文落盘不截断（模型侧预览另由注册表工具治理）
	}
	const rows = parsed.__hits || [];
	const evidenceId = persistScanRecords(workspace, {
		command: cmdStr + (rate && rate !== defaultRate ? `（速率显式覆盖：默认 ${defaultRate} → ${rate}，留痕）` : `（保守默认速率 ${defaultRate}）`),
		file: path.relative(workspace, outFile).replace(/\\/g, "/"),
		rows,
	});
	const reconciled = rows.length;
	return { ok: proc.status === 0, evidenceId, file: path.relative(workspace, outFile).replace(/\\/g, "/"), summary: parsed.__summary ?? {}, hits: (parsed.__hits || []).length, reconciled, stdout: parsed.__summaryText ?? "" };
}

//#region 注册表工具执行器：声明式 def → 构参 → 治理执行（预览封顶 + 全文落盘 + 熔断 + 阶梯提示）

/** 按注册表 def 执行一个工具。输出治理：全文永落盘（证据原件 + 回读指针），返回模型的是封顶预览。 */
export async function runGoverned({ def, params, workspace, fsMod = fs, configured = {}, roots = [] }) {
	const ws = path.resolve(workspace);
	const cooldown = breakerCheck(def.id);
	if (cooldown > 0) return { ok: false, error: `熔断中：${def.id} 连续失败 3 次进入 60s 冷却（剩 ${cooldown}s）——改走工具调用阶梯下级通道（MCP/替代/脚本）或稍后重试` };
	if (def.guard?.active) {
		const tp = def.guard.targetParam ?? "target";
		const reg = checkRegistered(fsMod, ws, params[tp] ?? params.target ?? params.domain ?? "");
		if (!reg.ok) return { ok: false, error: reg.hint, bin: def.bin };
	}
	// 二进制候选解析：def.bins 按序探测（支持 {module} 占位——impacket 的 impacket-<m>/<m>.py 双安装名）
	const binCandidates = (def.bins ?? [def.bin]).map((c) => c.replace("{module}", String(params.module ?? def.bin)));
	const configuredPath = configuredPathForTool(configured, def);
	let bin = null;
	for (const cand of binCandidates) {
		const resolved = resolveToolInvocation(cand, configuredPath, {
			configured,
			roots,
			acceptAnyFile: (def.bins ?? [def.bin]).length === 1,
		});
		if (resolved && !resolved.error) { bin = resolved; break; }
		if (resolved?.error) return { ok: false, error: resolved.error, bin: def.bin, tiers: tiersLine(def) };
	}
	if (!bin) {
		const pathHint = configuredPath ? `已配置路径不可执行：${configuredPath}；\n` : "";
		return { ok: false, error: `${pathHint}${BIN_HINT}\n${tiersLine(def)}`, bin: def.bin, tiers: tiersLine(def) };
	}
	let built;
	try { built = buildArgs(def, params); } catch (e) { return { ok: false, error: `参数拒绝：${e.message}` }; }
	const spawnArgs = [...bin.prefix, ...built.argv];
	const cmdStr = `${bin.bin} ${spawnArgs.join(" ")}`;
	const proc = await runProcess(bin.bin, spawnArgs, { timeoutMs: def.limits.timeoutMs, maxBuffer: 32 * 1024 * 1024 });
	if (proc.error) {
		breakerRecord(def.id, false);
		return { ok: false, error: `执行失败：${proc.error.message}${proc.error.code === "ETIMEDOUT" ? `（超时 ${def.limits.timeoutMs / 1000}s）` : ""}\n${tiersLine(def)}`, tiers: tiersLine(def) };
	}
	breakerRecord(def.id, proc.status === 0);
	const raw = (proc.stdout ? proc.stdout.toString() : "") + (proc.stderr && proc.stderr.toString().trim() ? `\n[stderr]\n${proc.stderr.toString()}` : "");
	const gov = governPreview(raw);
	const persisted = spillOutput(fsMod, ws, def.id, raw);
	const evidenceId = nextEvidenceId(ws);
	appendEvidence(ws, evidenceId, cmdStr + (built.audit.length ? `（${built.audit.join("；")}）` : "（保守默认参数）"), persisted);
	return {
		ok: proc.status === 0, evidenceId, persisted, bytes: gov.bytes, truncated: gov.truncated,
		preview: gov.preview,
		summaryText: `${def.id} 完成（exit ${proc.status}，输出 ${gov.bytes} 字符${gov.truncated ? "，预览已封顶" : ""}；全文 ${persisted}；证据 ${evidenceId}）`,
		tiers: tiersLine(def)
	};
}

//#endregion

//#region parsers

const nucleiParse = (raw) => {
	const hits = [];
	const out = [];
	for (const line of raw.split("\n")) {
		if (!line.trim().startsWith("{")) continue;
		try {
			const j = JSON.parse(line);
			hits.push({ source: "nuclei", hit: `${j.templateID ?? j["template-id"]} @ ${j.host ?? j.url} [${j.info?.severity ?? "?"}]` });
			out.push(j);
		} catch { /* 非 JSONL 行忽略 */ }
	}
	return { __writeRaw: JSON.stringify(out, null, 2), __hits: hits, __summary: { total: out.length }, __summaryText: `nuclei 命中 ${out.length} 条（已写对账待处置）` };
};

const httpxParse = (raw) => {
	const out = [];
	for (const line of raw.split("\n")) {
		if (!line.trim().startsWith("{")) continue;
		try { out.push(JSON.parse(line)); } catch { /* 忽略 */ }
	}
	return { __writeRaw: JSON.stringify(out, null, 2), __hits: [], __summary: { alive: out.length }, __summaryText: `存活 ${out.length}；探测未登记资产属测绘行为，结果请回填资产基线（assets.md / cloud-assets.md）` };
};

export const ffufParse = (_raw, proc = {}) => {
	// ffuf -o 已直接写 JSON；从该文件抽回命中，避免模型只拿到 evidenceId
	// 却看不到任何路径，反而要额外读一次产物。
	let results = [];
	try {
		const parsed = JSON.parse(fs.readFileSync(proc.outFile, "utf8"));
		results = Array.isArray(parsed?.results) ? parsed.results : [];
	} catch { /* 文件缺失/不是 JSON 时保持空结果，落盘兜底仍保留 */ }
	const hits = results.map((row) => ({
		source: "ffuf",
		hit: `${String(row.status ?? "?")} ${String(row.length ?? "?")}B ${String(row.url ?? row.input?.FUZZ ?? "?")}`,
	}));
	const preview = hits.slice(0, 8).map((item) => item.hit).join("；");
	return {
		__skipWrite: true,
		__writeRaw: null,
		__hits: hits,
		__summary: { total: results.length },
		__summaryText: results.length
			? `ffuf 命中 ${results.length} 条：${preview}${results.length > 8 ? "；…" : ""}`
			: `ffuf 完成（exit ${proc.status}），0 命中`,
	};
};

//#endregion

const name = "scanner-tools";
const inject = ["tools", "settings"];

function liveConfiguredToolPaths(ctx) {
	try {
		return configuredToolPaths(ctx.settings.get("sec-config"));
	} catch {
		return {};
	}
}

function liveConfiguredToolRoots(ctx) {
	try {
		const section = ctx.settings.get("sec-config");
		return Array.isArray(section?.roots) ? section.roots : [];
	} catch {
		return [];
	}
}

function apply(ctx) {
	// Optional tools are registered at plugin load, so their availability probe
	// must consider the sec-config path map as well as PATH. The same live map
	// is read again at execution time for all tools, which lets an operator fix
	// a path without restarting the host.
	const initialConfigured = liveConfiguredToolPaths(ctx);
	ctx.tools.register(defineTool({
		name: "nuclei_scan",
		description: "Template-based vuln scan (local nuclei). Conservative rate by default (-rl 15); explicit `rate` override is audit-logged. Requires the target registered in the workspace assets.md (防盲打). Hits append to scan-reconcile.md as 待处置 (hit ≠ vuln — verify with 对照三件套 before reporting).",
		parameters: {
			target: { type: "string", required: true, description: "Target URL/host (must be registered in assets.md)" },
			workspace: { type: "string", required: true, description: "Task workspace root" },
			severity: { type: "string", description: "e.g. medium,high,critical (default high,critical)" },
			rate: { type: "integer", description: "requests/sec override (default 15; override is audit-logged)" }
		},
		output: { schema: { type: "object", additionalProperties: true }, render: (_a, v) => [{ type: "text", text: v.ok ? `nuclei: ${v.__summaryText ?? ""}${v.stdout ? " — " + v.stdout : ""}（证据 ${v.evidenceId}）` : `nuclei 拒绝/失败：${v.error}` }] },
		async execute(args, exec) {
			const severity = args.severity ?? "high,critical";
			const args2 = ["-u", args.target, "-severity", severity, "-jsonl", "-silent", "-nc"];
			const workspace = path.resolve(args.workspace);
			const tracked = await runWithTaskTracking(workspace, "nuclei_scan", exec, () =>
				runScan({ bin: "nuclei", args: args2, workspace, tool: "nuclei", rate: args.rate, defaultRate: RATE_DEFAULTS.nuclei, active: true, target: args.target, parse: nucleiParse, configured: liveConfiguredToolPaths(ctx), roots: liveConfiguredToolRoots(ctx) })
			);
			return withTaskId(tracked);
		}
	}));
	ctx.tools.register(defineTool({
		name: "httpx_probe",
		description: "Alive/tech-fingerprint probe (local httpx). Light recon: unregistered targets allowed, but backfill assets.md with the results. Conservative rate by default (-rl 25).",
		parameters: {
			targets: { type: "string", required: true, description: "One URL/host, or comma-separated list" },
			workspace: { type: "string", required: true, description: "Task workspace root" },
			rate: { type: "integer", description: "requests/sec override (default 25; audit-logged)" }
		},
		output: { schema: { type: "object", additionalProperties: true }, render: (_a, v) => [{ type: "text", text: v.ok ? `httpx: ${v.stdout ?? ""}（证据 ${v.evidenceId}）` : `httpx 失败：${v.error}` }] },
		async execute(args, exec) {
			const args2 = ["-u", args.targets, "-json", "-silent", "-title", "-tech-detect", "-status-code"];
			const workspace = path.resolve(args.workspace);
			const tracked = await runWithTaskTracking(workspace, "httpx_probe", exec, () =>
				runScan({ bin: "httpx", args: args2, workspace, tool: "httpx", rate: args.rate, defaultRate: RATE_DEFAULTS.httpx, active: false, target: args.targets, parse: httpxParse, configured: liveConfiguredToolPaths(ctx), roots: liveConfiguredToolRoots(ctx) })
			);
			return withTaskId(tracked);
		}
	}));
	ctx.tools.register(defineTool({
		name: "ffuf_fuzz",
		description: "Dir/param fuzz (local ffuf). Conservative rate by default (-rate 50). Requires target registered in assets.md (防盲打). Use mode=dir for path fuzzing, mode=param for parameter discovery.",
		parameters: {
			url: { type: "string", required: true, description: "URL containing FUZZ keyword, e.g. https://host/FUZZ" },
			workspace: { type: "string", required: true, description: "Task workspace root" },
			mode: { type: "string", enum: ["dir", "param"], required: true, description: "dir = path fuzz; param = parameter discovery (?FUZZ=1)" },
			wordlist: { type: "string", description: "Path to wordlist (default: common.txt via -w common if available)" },
			rate: { type: "integer", description: "requests/sec override (default 50; audit-logged)" }
		},
		output: { schema: { type: "object", additionalProperties: true }, render: (_a, v) => [{ type: "text", text: v.ok ? `ffuf: ${v.stdout ?? ""}（证据 ${v.evidenceId}）` : `ffuf 拒绝/失败：${v.error}` }] },
		async execute(args, exec) {
			const wl = args.wordlist ?? "common.txt";
			const workspace = path.resolve(args.workspace);
			const tracked = await runWithTaskTracking(workspace, "ffuf_fuzz", exec, () => {
				if (!fs.existsSync(path.resolve(wl))) return { ok: false, error: `字典不存在：${wl}——请给 wordlist 参数（绝对路径或 SecLists）；本工具不代装字典。` };
			const u = args.mode === "param" ? (args.url.includes("FUZZ=") ? args.url : args.url + (args.url.includes("?") ? "&" : "?") + "FUZZ=1") : args.url;
				ensureDirs(workspace);
			const ts = stamp();
				const outFile = path.join(workspace, "artifacts", "scans", `ffuf-${ts}.json`);
			const args2 = ["-u", u, "-w", wl, "-mc", "200,204,301,302,307,401,403", "-o", outFile, "-of", "json", "-s"];
				return runScan({ bin: "ffuf", args: args2, workspace, tool: "ffuf", rate: args.rate, defaultRate: RATE_DEFAULTS.ffuf, active: true, target: args.url, parse: ffufParse, outFile, configured: liveConfiguredToolPaths(ctx), roots: liveConfiguredToolRoots(ctx) });
			});
			return withTaskId(tracked);
		}
	}));
	// 注册表工具统一注册：def 带全部工具面元数据（名称/摘要/参数 schema/阶梯/守卫），新增工具只改 registry.js
	const configuredProbe = (candidate, def) => resolveToolBin(
		candidate,
		configuredPathForTool(initialConfigured, def),
		{ roots: liveConfiguredToolRoots(ctx) },
	) !== null;
	for (const def of registerableDefs(TOOL_DEFS, configuredProbe)) {
		ctx.tools.register(defineTool({
			name: def.name,
			// 六段降级阶梯只在“本机缺工具”时才有决策价值；runGoverned 的缺装错误已原样返回 tiersLine，
			// 常驻 schema 会为每个工具重复 ~500B（13 个合计 7.2K），纯属重复上下文。
			description: `${def.summary} 全文自动落盘到 artifacts/tool-output/，模型侧只收封顶预览。本机缺工具或目标未登记时，错误结果会返回降级阶梯与修复提示。`,
			parameters: Object.assign({
				workspace: { type: "string", required: true, description: "Task workspace root" },
				extra: { type: "string", description: "Explicit extra args (audit-logged escape hatch; shell metacharacters rejected)" }
			}, def.params),
			output: { schema: { type: "object", additionalProperties: true }, render: (_a, v) => [{ type: "text", text: v.ok ? `${v.summaryText}\n${v.preview}` : `${def.id} 拒绝/失败：${v.error}` }] },
			async execute(args, exec) {
				const workspace = path.resolve(args.workspace);
				const tracked = await runWithTaskTracking(workspace, def.name, exec, () =>
					runGoverned({ def, params: args, workspace, configured: liveConfiguredToolPaths(ctx), roots: liveConfiguredToolRoots(ctx) })
				);
				return withTaskId(tracked);
			}
		}));
	}
}

export { apply, inject, name, RATE_DEFAULTS };
