// Shared local invocation resolution for execution and startup checks.
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
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

export function configuredPathForTool(configured, def) {
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

