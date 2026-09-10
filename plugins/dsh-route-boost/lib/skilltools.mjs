// dsh-route-boost skilltools —— 技能依赖声明扫描 + 装配期工具面检测。
// SKILL.md frontmatter 约定：tools: nmap, nuclei, httpx（逗号/空白分隔的命令名）。
// 扫描与检测均带 TTL 缓存：command -v 毫秒级，装配期同步调用不阻塞；
// 结果供信封 tools 行消费——缺件在开战前显形，按三级兜底（已装同类 → MCP → 批准后安装）补位。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// 数据源解析：preset/<mode>/skills 与 shared/skills 都在「已安装的 dsh-saker
// 根包」里。本插件是独立 bundle，装进 profile node_modules 后相对自身路径
// 找不到 preset/shared——用 createRequire 沿 node_modules 向上解析
// `dsh-saker/package.json`（profile 的 dsh-saker 是顶层依赖）。
// 解析失败（只手工装了本插件没装 dsh-saker）时回退源码仓库布局。
const require2 = createRequire(import.meta.url);
function sakerRoot() {
	try {
		return path.dirname(require2.resolve("dsh-saker/package.json"));
	} catch {
		// 源码仓库布局：<repo>/plugins/<name>/lib/skilltools.mjs
		// lib/ 上跳三级 = repo 根（lib → <name> → plugins → <repo>）；原先写了四级，
		// 落到仓库的父目录，导致回退路径下扫不到 preset/ 技能目录。
		return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
	}
}
let _rootCache = "";
function sakerRootOf() {
	if (!_rootCache) _rootCache = sakerRoot();
	return _rootCache;
}
// 扫描技能目录：preset/<mode>/skills
const presetRootOf = () => path.join(sakerRootOf(), "preset");
const SCAN_TTL = 60_000;
const CHECK_TTL = 600_000;
const TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const scanCache = new Map(); // presetId → { at, deps: Set<string> }
const checkCache = new Map(); // tool → { at, ok: boolean }

/** 扫描模式技能目录全部 SKILL.md 的 tools: 声明（去重集合）。 */
export function scanSkillDeps(presetId, now = Date.now()) {
	const hit = scanCache.get(presetId);
	if (hit && now - hit.at < SCAN_TTL) return hit.deps;
	const deps = new Set();
	const root = path.join(presetRootOf(), presetId, "skills");
	try {
		for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
			if (!dir.isDirectory()) continue;
			try {
				const text = fs.readFileSync(path.join(root, dir.name, "SKILL.md"), "utf8");
				const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
				if (!fm) continue;
				const tm = /^tools:\s*(.+)$/m.exec(fm[1]);
				if (tm) for (const t of tm[1].split(/[,，、\s]+/)) {
					const n = t.trim();
					if (TOOL_NAME_RE.test(n)) deps.add(n);
				}
			} catch { /* 单文件读取失败忽略 */ }
		}
	} catch { /* 模式无技能目录 */ }
	scanCache.set(presetId, { at: now, deps });
	return deps;
}

/**
 * 从 sec-config 命名空间解析「已配置工具名」集合（小写键）。
 *
 * 为什么需要它：技能依赖检查原本只做 `command -v`，但本平台的工具大多**不在 PATH**
 * （用户把工具放在 E:\工作\Web Security\Tools\...，由 sec-config 的 entries/roots
 * 管理，运行时经 DSH_TOOL_* 注入 shell）。只查 PATH 会把已配好的工具一律判为缺失，
 * 于是信封里出现「0/13 就绪」与同一份 runtime context 里的 sec-config manifest
 * 「tools: ... dirsearch ... sqlmap」自相矛盾，直接误导模型放弃既有工具。
 *
 * 真源与 sec-config 一致：entries[].key 优先，回退 legacy tools 的非空键；
 * hiddenTools 里的键视为不可用（用户显式隐藏＝不想让模型用它）。
 */
export function configuredTools(section) {
	const out = new Set();
	if (!section || typeof section !== "object") return out;
	const hidden = new Set(Array.isArray(section.hiddenTools) ? section.hiddenTools.map((k) => String(k).toLowerCase()) : []);
	const push = (key) => {
		const k = String(key || "").toLowerCase();
		if (k && !hidden.has(k)) out.add(k);
	};
	if (Array.isArray(section.entries)) {
		for (const e of section.entries) {
			if (e && typeof e.path === "string" && e.path) push(e.key);
		}
	}
	if (section.tools && typeof section.tools === "object") {
		for (const [k, v] of Object.entries(section.tools)) {
			if (typeof v === "string" && v) push(k);
		}
	}
	return out;
}

/** 工具是否可用：先认 sec-config 的显式配置（路径已由 DSH_TOOL_* 注入），再回退 PATH。
 *
 *  跨平台探测：Windows 上不存在 /bin/sh，原先一律 `spawnSync("/bin/sh", ...)` 会直接 ENOENT，
 *  status 为 null → 一律判为"缺件"。后果是 Windows 部署里**每个工具都被报成未安装**
 *  （node/git 这类显然在装的也一样），把模型推向无谓的三级兜底。按平台分支探测。 */
const IS_WIN = process.platform === "win32";
const WIN_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** PATH 直扫（Node 侧，不 spawn、不依赖宿主是否继承了 PATHEXT）。
 *
 *  为什么不能只信 `where`：`where <name>` 补扩展名靠的是环境变量 PATHEXT，而宿主进程
 *  的 env 里 PATHEXT 可能是 **undefined** —— 实测 dsh 插件进程就是如此。后果是
 *  `where node` → status 1、`where node.exe` → status 0：所有不带扩展名的探测一律判
 *  「未安装」，把每个工具都报成缺件，把模型推向无谓的三级兜底。（同一个坑原先在
 *  Windows 上以 /bin/sh ENOENT 的形式出现过，改成 where 只是换了个触发条件。）
 *  直扫 PATH + 扩展名候选与 where 的语义一致，且省掉一次进程 spawn。 */
function probeByPathScan(name) {
	try {
		const dirs = String(process.env.PATH || process.env.Path || "").split(path.delimiter).filter(Boolean);
		const exts = IS_WIN
			? String(process.env.PATHEXT || WIN_PATHEXT).split(";").filter(Boolean).map((e) => e.toLowerCase())
			: [""];
		for (const dir of dirs) {
			for (const ext of exts) {
				try { if (fs.existsSync(path.join(dir, name + ext))) return true; } catch { /* 目录不可读则跳过 */ }
			}
		}
	} catch { /* PATH 不可解析按未命中 */ }
	return false;
}
function probeOnPath(name) {
	if (probeByPathScan(name)) return true;
	try {
		if (IS_WIN) {
			// 兜底：where 还能看到 App Paths 注册项（不在 PATH 里的安装）。显式补 PATHEXT，
			// 免得宿主没继承时这里同样补不出扩展名。
			return spawnSync("where", [name], {
				stdio: "ignore",
				env: { ...process.env, PATHEXT: process.env.PATHEXT || WIN_PATHEXT },
			}).status === 0;
		}
		return spawnSync("/bin/sh", ["-c", `command -v -- ${name} >/dev/null 2>&1`]).status === 0;
	} catch {
		return false; // 探测失败按缺件处理
	}
}

export function checkTool(name, now = Date.now(), configured) {
	if (!TOOL_NAME_RE.test(name)) return false;
	if (configured instanceof Set && configured.has(name.toLowerCase())) return true;
	const hit = checkCache.get(name);
	if (hit && now - hit.at < CHECK_TTL) return hit.ok;
	const ok = probeOnPath(name);
	checkCache.set(name, { at: now, ok });
	return ok;
}

/** 装配期工具面：模式技能依赖的就绪概况；无声明依赖的模式返回 undefined（不占信封）。
 *  `configured` = sec-config 已配置工具键集合（见 configuredTools）。 */
export function toolsStatus(presetId, now = Date.now(), configured) {
	const deps = [...scanSkillDeps(presetId, now)].sort();
	if (deps.length === 0) return undefined;
	const missing = deps.filter((n) => !checkTool(n, now, configured));
	return { total: deps.length, ok: deps.length - missing.length, missing };
}

/**
 * 当前模式可引用的技能名集合（preset/<mode>/skills/* 与 shared/skills/* 的
 * 并集，去重保序）。`presetId` 缺省时退到 shared；返回的每个名字是 SKILL.md
 * frontmatter 的 `name:` 字段（与 `@skill:<name>` 引用键一致）。在
 * envelope 的 `skills:` 行投递，让模型在 prompt 装配期就知道当前可用的
 * 技能指针。
 */
const BUNDLE_ROOT = sakerRootOf();
const skillNameCache = new Map(); // presetId|"shared" → { at, names: string[] }
const SKILL_NAME_TTL = 60_000;
const FRONTMATTER_NAME_RE = /^name:\s*([A-Za-z0-9][A-Za-z0-9._-]{0,63})\s*$/m;

function readSkillNamesFromDir(dir) {
	const names = [];
	let entries;
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return names; }
	for (const e of entries) {
		if (!e.isDirectory()) continue;
		const md = path.join(dir, e.name, "SKILL.md");
		try {
			const text = fs.readFileSync(md, "utf8");
			const m = FRONTMATTER_NAME_RE.exec(text);
			if (m) names.push(m[1]);
		} catch { /* 单文件读不到忽略 */ }
	}
	return names;
}

export function listSkillNames(presetId, now = Date.now()) {
	const cacheKey = presetId || "shared";
	const hit = skillNameCache.get(cacheKey);
	if (hit && now - hit.at < SKILL_NAME_TTL) return hit.names.slice();
	const names = [];
	const seen = new Set();
	const addAll = (dir) => {
		for (const n of readSkillNamesFromDir(dir)) {
			if (!seen.has(n)) { seen.add(n); names.push(n); }
		}
	};
	// shared/skills 对所有模式可见；security 预设的 skill-filesystem customSkillDirs
	// 会把「本模式 + 兄弟模式」的 skills 一并挂进会话目录——因此这里扫全部
	// preset/*/skills（不仅 presetId 自己），与真实会话目录一致。
	addAll(path.join(BUNDLE_ROOT, "shared", "skills"));
	if (presetId) {
		let entries;
		try { entries = fs.readdirSync(path.join(BUNDLE_ROOT, "preset"), { withFileTypes: true }); } catch { entries = [] }
		for (const p of entries) {
			if (!p.isDirectory()) continue
			addAll(path.join(BUNDLE_ROOT, "preset", p.name, "skills"));
		}
	}
	skillNameCache.set(cacheKey, { at: now, names: names.slice() });
	return names;
}
