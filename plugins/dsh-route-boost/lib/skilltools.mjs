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
		// 源码仓库布局：<repo>/plugins/<name>/lib/skilltools.mjs → 四级上跳 = repo 根
		return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
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

/** command -v 探测（/bin/sh 内建；名非法直接判缺）。 */
export function checkTool(name, now = Date.now()) {
	if (!TOOL_NAME_RE.test(name)) return false;
	const hit = checkCache.get(name);
	if (hit && now - hit.at < CHECK_TTL) return hit.ok;
	let ok = false;
	try {
		ok = spawnSync("/bin/sh", ["-c", `command -v -- ${name} >/dev/null 2>&1`]).status === 0;
	} catch { /* 探测失败按缺件处理 */ }
	checkCache.set(name, { at: now, ok });
	return ok;
}

/** 装配期工具面：模式技能依赖的就绪概况；无声明依赖的模式返回 undefined（不占信封）。 */
export function toolsStatus(presetId, now = Date.now()) {
	const deps = [...scanSkillDeps(presetId, now)].sort();
	if (deps.length === 0) return undefined;
	const missing = deps.filter((n) => !checkTool(n, now));
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
