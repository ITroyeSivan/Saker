// dsh-knowledge-hub 离线单元测试（本插件此前**没有任何测试** —— 2026-09-13 补）。
//
// 覆盖的是「模型真的会依赖」的行为面：
//   · 分层检索（user / import 两层可造；bundle / patt 随包，测试环境下不装即跳过）
//   · 路径越界防护（browse / read / write / remove 四个端点，`../` 与绝对路径都要挡住）
//   · 写入层只读栅栏（bundle / patt 不可写）
//   · 写→读 往返与 remove（含「不许删根」）
//   · Exploit-DB 字段化索引（真造一份 files_exploits.csv，验 EDB-ID / CVE / 平台命中）
//   · 导入闸门（import_git 拒非 http(s) 与不安全名；import_local 拒不存在/非目录/自我导入）
//
// 为什么这些值得测：本插件的输入全部来自**模型与网络**（检索词、相对路径、导入地址），
// 越界与只读栅栏一旦失守，是「模型能删/写工作区之外的任意文件」这类事故。
//
// 用法: node --import ../../scripts/test-stub-register.mjs test/run.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// ⚠ DSH_HOME 必须在**任何** dshHome() 调用之前设好（模块内 bundleRefs/pattRef 是懒缓存）。
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "kh-home-"));
process.env.DSH_HOME = HOME;
// Unit fixtures own the user/import layers; keep the real repository bundle out
// so assertions stay deterministic and do not depend on shipped refs.
process.env.SAKER_DISABLE_BUNDLE = "1";

const { dispatch, stats, searchAll, ensureKnowledgeIndex, closeKnowledgeIndex, apply, autoSyncKnowledgePacks, getSyncMode, setSyncMode, translateQuery, queryConcepts, coverageBonusOf } = await import("../lib/index.js");
const { syncPack } = await import("../lib/packs.js");

let pass = 0, fail = 0;
const ok = (label, cond, extra) => {
	if (cond) { pass++; console.log(`ok   ${label}`); }
	else { fail++; console.log(`FAIL ${label}${extra !== undefined ? " —— " + String(extra) : ""}`); }
};
/** RPC 失败是结构化对象 `{code,message,details}`；这里统一取文本，兼容旧字符串形状。 */
const errOf = (r) => {
	const e = r && r.error;
	if (!e) return "";
	return typeof e === "string" ? e : String(e.message || "");
};

const REFS = path.join(HOME, "refs");
const USER_PENTEST = path.join(REFS, "pentest");
const IMPORTS = path.join(REFS, "imports");

function write(p, text) {
	fs.mkdirSync(path.dirname(p), { recursive: true });
	fs.writeFileSync(p, text, "utf8");
}

// ── 场景数据 ────────────────────────────────────────────────────────────────
write(path.join(USER_PENTEST, "web", "sqli.md"), [
	"# SQL 注入速查",
	"布尔盲注：`and 1=1` / `and 1=2` 比对响应长度。",
	"时间盲注：`sleep(5)` 观察响应时延。",
	"报错注入：extractvalue / updatexml。",
].join("\n"));
write(path.join(USER_PENTEST, "web", "xss.md"), "# XSS\n存储型与反射型区别在于是否落库。\n");
write(path.join(IMPORTS, "team-notes", "win", "ad.md"), "# 域渗透\nKerberoasting 需要 SPN 账号。\n");

// ── 1. stats：分层计数 ─────────────────────────────────────────────────────
{
	const s = stats();
	ok("stats.user 计入 user 层文件数", s.user >= 2, JSON.stringify(s));
	ok("stats.imports 计入 import 层文件数", s.imports >= 1, JSON.stringify(s));
	ok("stats 形状含各层字段", ["user", "imports", "patt", "bundleMd", "bundleRules", "total"].every((k) => k in s), Object.keys(s).join(","));
}

// ── 2. 分层检索 ────────────────────────────────────────────────────────────
{
	const hits = searchAll("布尔盲注", "pentest");
	ok("检索命中 user 层", hits.some((h) => h.source === "user" && h.path.includes("sqli.md")));
	ok("正常命中不标低置信", hits[0] && hits[0].lowConfidence === false);
	ok("命中行号正确（1-based，指向含关键词那行）", hits.some((h) => h.path.includes("sqli.md") && h.line === 2), JSON.stringify(hits.map((h) => [h.path, h.line])));
	ok("命中带预览行", hits.every((h) => typeof h.preview === "string" && h.preview.length > 0));

	// import 层不受 mode 限制（通用内容）
	const imp = searchAll("Kerberoasting", "pentest");
	ok("import 层可检索（跨 mode 通用）", imp.some((h) => h.source === "import" && h.path.includes("ad.md")), JSON.stringify(imp));

	// 别名展开：中文词 → 英文术语
	const alias = searchAll("盲注", "pentest");
	ok("中文别名能命中英文术语（布尔盲注）", alias.some((h) => h.path.includes("sqli.md")));

	// 来源限定搜索：知识库页面的“筛选当前来源”要求跨已折叠目录找文件，
	// 不能先把其它来源的高分结果取满再过滤，否则单一来源会看起来“没有结果”。
	const userOnly = searchAll("Kerberoasting", "pentest", 8, "user");
	ok("来源限定搜索排除其它来源", userOnly.every((h) => h.source === "user"));
	const importOnly = searchAll("Kerberoasting", "pentest", 8, "import");
	ok("来源限定搜索保留目标来源", importOnly.some((h) => h.source === "import" && h.path.includes("ad.md")), JSON.stringify(importOnly));

	// 空查询不炸（返回数组即可）
	ok("空查询返回数组不抛", Array.isArray(searchAll("", "pentest")));
}

// ── 3. 路径越界防护（四个端点 × 多种越界写法）──────────────────────────────
{
	const escapes = ["../pentest-sibling", "../../refs", "a/../../x", "/etc/passwd", "..\\..\\win.ini", "a\0b"];
	let leaked = [];
	for (const rel of escapes) {
		for (const ep of ["browse", "read", "remove"]) {
			const r = await dispatch(ep, { source: "user", mode: "pentest", path: rel, dir: rel });
			// 允许的两种结果：明确拒绝，或（对合法但不存在者）返回空——**绝不允许**返回越界内容
			const blob = JSON.stringify(r);
			if (/root:|\[boot loader\]|pentest-sibling/.test(blob)) leaked.push(`${ep}:${rel}`);
		}
	}
	ok("browse/read/remove 均挡住越界路径", leaked.length === 0, leaked.join(","));

	// 明确：read 越界必须 fail
	const r1 = await dispatch("read", { source: "user", mode: "pentest", path: "../../x" });
	ok("read 越界返回 fail", r1 && r1.ok === false, JSON.stringify(r1));

	// 明确：remove 不许删根
	const r2 = await dispatch("remove", { source: "user", mode: "pentest", path: "" });
	ok("remove 空路径（=根）被拒", r2 && r2.ok === false, JSON.stringify(r2));
	const r3 = await dispatch("remove", { source: "imports", mode: "pentest", path: "." });
	ok("remove '.'（=根）被拒", r3 && r3.ok === false, JSON.stringify(r3));
	ok("根目录仍在（越界删除未生效）", fs.existsSync(USER_PENTEST) && fs.existsSync(path.join(IMPORTS, "team-notes")));
}

// ── 4. 只读层栅栏：bundle / patt 不可写 ─────────────────────────────────────
{
	for (const src of ["bundle", "patt"]) {
		const r = await dispatch("write", { source: src, mode: "pentest", path: "hack.md", content: "x" });
		ok(`${src} 层写被拒（只读）`, r && r.ok === false && /只读/.test(errOf(r)), JSON.stringify(r));
	}
	// 未知来源
	const r = await dispatch("write", { source: "nowhere", mode: "pentest", path: "a.md", content: "x" });
	ok("未知来源写被拒", r && r.ok === false);
}

// ── 5. 写→读 往返 + remove ─────────────────────────────────────────────────
{
	const w = await dispatch("write", { source: "user", mode: "pentest", path: "sub/dir/note.md", content: "# 笔记\n内容行\n" });
	ok("user 层写成功（自动建父目录）", w && w.ok === true, JSON.stringify(w));
	ok("写后文件真的在盘上", fs.existsSync(path.join(USER_PENTEST, "sub", "dir", "note.md")));

	const r = await dispatch("read", { source: "user", mode: "pentest", path: "sub/dir/note.md" });
	ok("读回内容一致", r && r.ok === true && r.value.content.includes("内容行"), JSON.stringify(r).slice(0, 160));

	// 写后可被检索到（索引是实时的，不该有缓存盲区）
	const hits = searchAll("内容行", "pentest");
	ok("新写入的文件立刻可检索", hits.some((h) => h.path.includes("note.md")), JSON.stringify(hits.map((h) => h.path)));

	// 覆盖写已有文件前必须留备份：用户改自己写的条目，保存一下不该永久覆盖上一版。
	// （同一类问题 2026-09-19 已在 webshell-mgr 上真实踩过一次数据丢失。）
	const w2 = await dispatch("write", { source: "user", mode: "pentest", path: "sub/dir/note.md", content: "# 笔记\n第二版\n" });
	ok("覆盖写返回备份路径且备份内容是上一版",
		w2 && w2.ok === true && typeof w2.value?.backup === "string" && fs.existsSync(w2.value.backup)
		&& fs.readFileSync(w2.value.backup, "utf8").includes("内容行"), JSON.stringify(w2?.value));
	ok("覆盖后新内容生效", fs.readFileSync(path.join(USER_PENTEST, "sub", "dir", "note.md"), "utf8").includes("第二版"));
	ok("首次创建（原本不存在）不产生备份",
		w && w.ok === true && (w.value?.backup === "" || w.value?.backup === undefined), JSON.stringify(w?.value));
	// 备份目录不能出现在目录浏览里
	const browseAfterWrite = await dispatch("browse", { source: "user", mode: "pentest", dir: "" });
	const dirNamesAfterWrite = (browseAfterWrite.value?.dirs || []).map((x) => (typeof x === "string" ? x : x.name));
	ok("备份目录不出现在浏览列表里", !dirNamesAfterWrite.includes(".backups"), JSON.stringify(dirNamesAfterWrite));

	const d = await dispatch("remove", { source: "user", mode: "pentest", path: "sub/dir/note.md" });
	ok("remove 删掉文件", d && d.ok === true && !fs.existsSync(path.join(USER_PENTEST, "sub", "dir", "note.md")), JSON.stringify(d));

	// 目录递归删除
	const d2 = await dispatch("remove", { source: "user", mode: "pentest", path: "sub" });
	ok("remove 递归删目录", d2 && d2.ok === true && !fs.existsSync(path.join(USER_PENTEST, "sub")), JSON.stringify(d2));
	ok("兄弟目录未被误删（删的是子目录不是父）", fs.existsSync(path.join(USER_PENTEST, "web", "sqli.md")));

	// 删除不是真删：先移进同层 .trash/（同卷 rename，原子且可人工找回）。
	// 背景：这条路径删的是用户自己写的知识条目/导入包，直接 rm 就永久没了。
	ok("删除会先移进同层 .trash/（可找回）",
		d && d.ok === true && typeof d.value?.trash === "string" && fs.existsSync(d.value.trash)
		// 删之前刚被覆盖成"第二版"，所以回收站里应是那一版
		&& fs.readFileSync(d.value.trash, "utf8").includes("第二版"), JSON.stringify(d?.value));
	ok("递归删除的目录也进 .trash/（整棵子树被搬走而不是 rm）",
		d2 && d2.ok === true && fs.existsSync(d2.value.trash) && fs.statSync(d2.value.trash).isDirectory(),
		JSON.stringify(d2?.value));
	// 点开头的 .trash 必须从浏览列表里消失，否则用户会看到自己删掉的东西又冒出来
	const browseAfter = await dispatch("browse", { source: "user", mode: "pentest", dir: "" });
	const dirNames = (browseAfter.value?.dirs || []).map((x) => (typeof x === "string" ? x : x.name));
	ok("回收站不出现在目录浏览里（点开头被跳过）", !dirNames.includes(".trash"), JSON.stringify(dirNames));
}

// ── 6. browse 列表（dirs/files 是对象数组：{name, rel, [fileCount|size]}）─────
{
	const names = (arr) => (arr || []).map((x) => (typeof x === "string" ? x : x.name));
	const r = await dispatch("browse", { source: "user", mode: "pentest" });
	ok("browse 列出一级目录", r && r.ok === true && names(r.value.dirs).includes("web"), JSON.stringify(r.value).slice(0, 200));
	ok("browse 目录项带 rel 与 fileCount", r && r.value.dirs.every((d) => typeof d.rel === "string" && typeof d.fileCount === "number"), JSON.stringify(r.value.dirs));
	const r2 = await dispatch("browse", { source: "user", mode: "pentest", dir: "web" });
	ok("browse 钻入子目录列出文件", r2 && r2.ok === true && names(r2.value.files).includes("sqli.md"), JSON.stringify(r2.value).slice(0, 200));
	ok("browse 文件项带 size", r2 && r2.value.files.every((f) => typeof f.size === "number"), JSON.stringify(r2.value.files));
	const r3 = await dispatch("browse", { source: "import", dir: "" });
	ok("browse import 顶层列导入包", r3 && r3.ok === true && names(r3.value.dirs).includes("team-notes"), JSON.stringify(r3.value).slice(0, 200));
}

// ── 7. Exploit-DB 字段化索引 ───────────────────────────────────────────────
// ⚠ 本节同时是**缓存新鲜度的回归锁**，且**顺序不可调换**：
//   前面第 2 节的 searchAll 已经在「CSV 尚不存在」时触发过 loadEdbIndex（负结果），
//   本节再把 CSV 落盘 —— 正是在测「手动放入索引后能否立刻读到」。
//   旧实现是纯 TTL 缓存（`at` 时间窗），负结果会被缓存满 120s：文件已就位却报 rows:0、
//   检索也命中不到（2026-09-13 实测抓到）。现改为按文件版本（mtime+size）作键。
//   若把本节数据挪到第 2 节之前，这条锁就失效了 —— 别挪。
{
	// 现代 16 列 files_exploits.csv 表头
	const header = "id,file,description,date_published,author,type,platform,port,date_added,date_updated,verified,codes,tags,aliases,screenshot_url,source_url";
	const rows = [
		"50000,exploits/linux/local/50000.c,Linux Kernel 5.8 privilege escalation,2020-10-01,alice,local,linux,,2020-10-02,2021-01-01,1,CVE-2020-1234;OSV-2020-1,kernel,,\"http://x/a\",",
		"51111,exploits/multiple/webapps/51111.py,WordPress plugin SQL injection,2021-03-03,bob,webapps,php,,2021-03-04,2021-03-04,0,CVE-2021-9999,sqli,,\"http://x/b\",",
		// 引号内含逗号的描述，验证 CSV 行解析
		"52222,exploits/linux/remote/52222.py,\"Log4Shell, remote code execution\",2021-12-10,carol,remote,java,8080,2021-12-11,2021-12-12,1,CVE-2021-44228,log4j,,\"http://x/c\",",
	];
	write(path.join(IMPORTS, "exploitdb", "files_exploits.csv"), [header, ...rows].join("\n") + "\n");

	// edb-status 报告已就绪
	const st = await dispatch("edb-status", {});
	ok("edb-status 报 present 且行数=3", st && st.ok === true && st.value.present === true && st.value.rows === 3, JSON.stringify(st.value).slice(0, 200));

	// 按 EDB-ID 命中
	const byId = searchAll("EDB-51111", "pentest").filter((h) => h.edb);
	ok("按 EDB-ID 精确命中", byId.some((h) => h.edbId === "51111"), JSON.stringify(byId));

	// 按纯数字 id 命中
	const byNum = searchAll("51111", "pentest").filter((h) => h.edb);
	ok("按纯数字 id 命中", byNum.some((h) => h.edbId === "51111"), JSON.stringify(byNum));

	// 按 CVE 命中（含 CVE 归一化：cve 2021 44228 → cve-2021-44228）
	const byCve = searchAll("CVE-2021-44228", "pentest").filter((h) => h.edb);
	ok("按 CVE 命中", byCve.some((h) => h.edbId === "52222"), JSON.stringify(byCve));
	const byCveLoose = searchAll("cve-2021-44228", "pentest").filter((h) => h.edb);
	ok("CVE 大小写不敏感", byCveLoose.some((h) => h.edbId === "52222"));

	// 引号内逗号：描述被完整解析（未把 csv 列错位）
	const byDesc = searchAll("remote code execution", "pentest").filter((h) => h.edb);
	ok("CSV 引号字段解析正确（引号内逗号不切列）", byDesc.some((h) => h.edbId === "52222"), JSON.stringify(byDesc));
	const yearFalsePositive = searchAll("2026 世界杯 赛程", "pentest", 8).filter((h) => h.edb && h.edbId === "2026");
	ok("普通年份不会被当成 EDB 精确 ID", yearFalsePositive.length === 0, JSON.stringify(yearFalsePositive));
	const noisy = searchAll("Kerberoasting banana smoothie", "pentest", 3);
	ok("低覆盖自然语言查询会标低置信", noisy[0] && noisy[0].lowConfidence === true, JSON.stringify(noisy[0]));

	// 未验证标记：verified=0 的行预览带「(未验证)」
	ok("未验证条目带 (未验证) 标记", byId.some((h) => /未验证/.test(h.preview)), JSON.stringify(byId));
	// 已验证的不带
	ok("已验证条目不带 (未验证)", searchAll("EDB-50000", "pentest").filter((h) => h.edb).every((h) => !/未验证/.test(h.preview)));

	// 命中行给出可读路径（exploitdb/<file>）
	ok("EDB 命中带 exploitdb/ 相对路径", byDesc.some((h) => /^exploitdb\/exploits\//.test(h.path)), JSON.stringify(byDesc.map((h) => h.path)));
}

// ── 8. 导入闸门 ────────────────────────────────────────────────────────────
{
	const g1 = await dispatch("import_git", { url: "file:///etc/passwd", name: "x" });
	ok("import_git 拒非 http(s)", g1 && g1.ok === false, JSON.stringify(g1));
	const g2 = await dispatch("import_git", { url: "https://example.invalid/repo.git", name: "" });
	ok("import_git 拒空名", g2 && g2.ok === false, JSON.stringify(g2));
	// 名字里的路径分隔符被清洗成 _，不会逃出 imports 根
	const g3 = await dispatch("import_git", { url: "https://example.invalid/repo.git", name: "../../evil" });
	ok("import_git 名字被清洗（无路径分隔符逃逸）", g3 && g3.ok === false, JSON.stringify(g3).slice(0, 120));

	const l1 = await dispatch("import_local", { path: path.join(HOME, "no-such-dir"), name: "y" });
	ok("import_local 拒不存在路径", l1 && l1.ok === false, JSON.stringify(l1));
	const l2 = await dispatch("import_local", { path: path.join(USER_PENTEST, "web", "sqli.md"), name: "z" });
	ok("import_local 拒非目录", l2 && l2.ok === false, JSON.stringify(l2));
	// 自我导入：源就是 imports 根 → 必须拒（否则递归复制自己）
	const l3 = await dispatch("import_local", { path: IMPORTS, name: "self" });
	ok("import_local 拒把 imports 根导入自身", l3 && l3.ok === false, JSON.stringify(l3));
	// 子目录互导：源在 imports 内、目标也在 imports 内 → 允许（非递归）
	const srcPkg = path.join(IMPORTS, "team-notes");
	const l4 = await dispatch("import_local", { path: srcPkg, name: "team-notes-copy" });
	ok("import_local 允许 imports 内包互拷", l4 && l4.ok === true, JSON.stringify(l4).slice(0, 200));
	ok("互拷后副本可检索", searchAll("Kerberoasting", "pentest").some((h) => h.path.includes("team-notes-copy")));

	// 真目录交给 import_git 时报「已存在」而不是静默覆盖
	const g4 = await dispatch("import_git", { url: "https://example.invalid/repo.git", name: "team-notes" });
	ok("import_git 不覆盖同名目录", g4 && g4.ok === false && /已存在/.test(errOf(g4)), JSON.stringify(g4).slice(0, 140));
}

// ── 9. 未知端点 ────────────────────────────────────────────────────────────
{
	const r = await dispatch("nope", {});
	ok("未知端点返回 fail 而非抛错", r && r.ok === false && /unknown endpoint/.test(errOf(r)), JSON.stringify(r));
	// 连接层契约：失败必须是结构化错误对象，回字符串会被 parseConnectionResponse 判成
	// invalid server-response result 并 reject，客户端界面直接卡死（实测详情区白板）。
	ok("失败返回结构化错误（连接层契约）",
		r && r.ok === false && typeof r.error === "object" && typeof r.error.code === "string"
		&& typeof r.error.message === "string" && typeof r.error.details === "object", JSON.stringify(r));
}

// ── 10. 检索上限与去重（防一次调用把上下文灌满）─────────────────────────────
{
	// 造 30 个都含同一个词的文件，确认命中条数有上限
	for (let i = 0; i < 30; i++) write(path.join(USER_PENTEST, "bulk", `f${i}.md`), `# ${i}\nZEBRA_MARKER 出现在这里\n`);
	const hits = searchAll("ZEBRA_MARKER", "pentest");
	ok("单次检索命中条数有上限（不无界膨胀）", hits.length <= 80, `实得 ${hits.length}`);
	const key = hits.map((h) => `${h.source}/${h.mode}/${h.path}:${h.line}`);
	ok("命中无重复条目", new Set(key).size === key.length, `${key.length} vs ${new Set(key).size}`);
}

// ── 11. 知识包目录与 FTS 状态 ───────────────────────────────────────────────
{
	const packs = await dispatch("packs-status", {});
	const ids = (packs.value && packs.value.packs || []).map((p) => p.id);
	ok("内置知识包目录可加载（≥15 个）", packs.ok && ids.length >= 15, JSON.stringify(packs).slice(0, 180));
	ok("知识包 id 不重复", new Set(ids).size === ids.length, ids.join(","));
	ok("知识包带许可证和适用方向", packs.value.packs.every((p) => p.license && Array.isArray(p.domains)), JSON.stringify(packs.value.packs[0]));

	const status = await dispatch("index-status", {});
	ok("FTS 索引状态为就绪", status.ok && status.value.ready === true && status.value.docs > 0, JSON.stringify(status).slice(0, 220));
	ok("FTS 索引包含 chunks", status.value.chunks > 0, JSON.stringify(status.value));

	const searched = await dispatch("search", { query: "布尔盲注", mode: "pentest" });
	const hit = searched.value && searched.value.hits && searched.value.hits[0];
	ok("RPC 检索返回 chunkId", searched.ok && hit && /^\d+$/.test(String(hit.chunkId)), JSON.stringify(searched).slice(0, 240));
	ok("RPC 检索带索引状态", searched.value && searched.value.index && searched.value.index.ready === true);
	const chunk = hit ? ensureKnowledgeIndex().getChunk(hit.chunkId) : null;
	ok("chunkId 可反查到原文片段", !!chunk && chunk.path.includes("sqli.md") && chunk.body.includes("布尔盲注"), JSON.stringify(chunk));

	fs.mkdirSync(path.join(IMPORTS, "irm"), { recursive: true });
	fs.writeFileSync(path.join(IMPORTS, "irm", "IRM-Ransomware.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x00]));
	ensureKnowledgeIndex().invalidate();
	const pdfHits = searchAll("Ransomware", "pentest");
	ok("PDF 可按标题/路径检索", pdfHits.some((h) => h.path === "irm/IRM-Ransomware.pdf"), JSON.stringify(pdfHits.map((h) => h.path)));
	const pdfRead = await dispatch("read", { source: "import", mode: "pentest", path: "irm/IRM-Ransomware.pdf" });
	ok("PDF 读取返回元数据提示而非二进制乱码", pdfRead.ok && /PDF document/.test(pdfRead.value.content) && !pdfRead.value.content.includes("\u0000"), JSON.stringify(pdfRead).slice(0, 200));
}

// ── 12. 模型工具输出契约：render 必须真的带检索片段/原文 ───────────────────
{
	process.env.DSH_KNOWLEDGE_AUTOSYNC = "0";
	const tools = new Map();
	const fakeCtx = {
		effect() {},
		inject(_names, cb) { cb(); },
		connection: { register() {} },
		tools: { register(def) { tools.set(def.name, def); } },
		systemPrompt: { context() {} },
	};
	apply(fakeCtx, {});
	const searchTool = tools.get("knowledge_search");
	const readTool = tools.get("knowledge_read");
	ok("apply 注册 knowledge_search/read/list", !!searchTool && !!readTool);

	const searchValue = await searchTool.execute({ query: "布尔盲注", mode: "pentest", limit: 2 });
	const searchText = searchTool.output.render({ query: "布尔盲注" }, searchValue)[0].text;
	ok("knowledge_search render 带命中路径与片段", /sqli\.md/.test(searchText) && /盲注/.test(searchText), searchText.slice(0, 240));
	ok("knowledge_search 被预算截断到 limit", searchValue.value.hits.length <= 2, JSON.stringify(searchValue.value.hits.map((h) => h.path)));

	const hitId = searchValue.value.hits[0] && searchValue.value.hits[0].chunkId;
	const readValue = await readTool.execute({ hitId, limit: 20 });
	const readText = readTool.output.render({ hitId }, readValue)[0].text;
	ok("knowledge_read render 返回真实原文", /布尔盲注/.test(readText) && /行 \d+-\d+/.test(readText), readText.slice(0, 220));
	ok("knowledge_read 返回磁盘绝对路径，模型无需再 glob 反查",
		readValue.ok && typeof readValue.value.absPath === "string" && fs.existsSync(readValue.value.absPath)
		&& readText.includes(readValue.value.absPath),
		JSON.stringify({ root: readValue.value.root, absPath: readValue.value.absPath }));
}

// ── 12b. 统一出站策略：冻结档必须在 git 之前拦下；本地路径不算出站 ──────────
{
	const { gateInfraEgress } = await import("../lib/packs.js");
	const egressDir = path.join(HOME, "saker-egress");
	const policyFile = path.join(egressDir, "policy.json");
	const auditFile = path.join(egressDir, "audit.jsonl");
	const writePolicy = (value) => {
		fs.mkdirSync(egressDir, { recursive: true });
		fs.writeFileSync(policyFile, JSON.stringify(value), "utf8");
	};
	const readAudit = () => (
		fs.existsSync(auditFile)
			? fs.readFileSync(auditFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
			: []
	);

	fs.rmSync(egressDir, { recursive: true, force: true });
	const missing = await gateInfraEgress({ source: "https://github.com/org/repo.git" });
	ok("无策略文件→放行且标注 policy-missing",
		missing.decision === "allow" && missing.policySource === "policy-missing", JSON.stringify(missing));

	writePolicy({ version: 1, mode: "frozen", allowHosts: [] });
	const frozen = await gateInfraEgress({ source: "https://github.com/org/repo.git" });
	ok("冻结档→基础设施出站判定为拦截（infra_frozen）",
		frozen.decision === "deny" && frozen.reason === "infra_frozen", JSON.stringify(frozen));
	const local = await gateInfraEgress({ source: path.join(HOME, "local-origin.git") });
	ok("冻结档→本地路径不算出站（local-source）",
		local.decision === "allow" && local.reason === "local-source", JSON.stringify(local));

	// 真调一次 syncPack：冻结档下 git 一次都不该跑
	const calls = [];
	const fakeGit = async (args) => { calls.push(args.join(" ")); return { ok: true, code: 0, stdout: "", stderr: "" }; };
	const blocked = await syncPack({ id: "frozen-pack", repo: "https://github.com/org/repo.git", branch: "", sparse: [] }, { git: fakeGit });
	ok("冻结档：syncPack 返回 blocked 且 git 未被调用",
		blocked.ok === false && blocked.mode === "blocked" && calls.length === 0 && /统一出站策略拦截/.test(blocked.error),
		`${JSON.stringify(blocked)} calls=${calls.length}`);

	// 白名单命中 → 回到旧路径（git 真被调用）
	writePolicy({ version: 1, mode: "allowlist", allowHosts: ["github.com"] });
	const allowed = await syncPack({ id: "allow-pack", repo: "https://github.com/org/repo.git", branch: "", sparse: [] }, { git: fakeGit });
	ok("白名单命中→不被拦（git 真被调用）",
		calls.length > 0 && allowed.mode !== "blocked", `${JSON.stringify(allowed)} calls=${calls.length}`);

	const rows = readAudit();
	ok("审计留痕：deny 与 allow 都记了，且带 host",
		rows.some((r) => r.decision === "deny" && r.host === "github.com") && rows.some((r) => r.decision === "allow"),
		`${rows.length} rows`);
	fs.rmSync(egressDir, { recursive: true, force: true });
}

// ── 13. 分叉的托管知识包必须自动重克隆，并保留旧目录备份 ────────────────────
{
	const git = (cwd, args) => execFileSync("git", args, {
		cwd,
		stdio: "ignore",
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
	const origin = path.join(HOME, "diverged-origin.git");
	const seed = path.join(HOME, "diverged-seed");
	const packId = "diverged-pack";
	const pack = { id: packId, repo: origin, branch: "master", sparse: [] };

	execFileSync("git", ["init", "--bare", "--initial-branch=master", origin], { stdio: "ignore" });
	execFileSync("git", ["clone", origin, seed], { stdio: "ignore" });
	git(seed, ["config", "user.email", "saker-test@example.invalid"]);
	git(seed, ["config", "user.name", "Saker Test"]);
	write(path.join(seed, "upstream.md"), "v1\n");
	git(seed, ["add", "."]);
	git(seed, ["commit", "-m", "v1"]);
	git(seed, ["push", "-u", "origin", "master"]);

	const first = await syncPack(pack);
	ok("分叉测试：首次 clone 成功", first.ok && first.mode === "clone", JSON.stringify(first));
	ok("分叉测试：托管 clone 启用 core.longpaths", execFileSync("git", ["config", "--get", "core.longpaths"], { cwd: path.join(IMPORTS, packId), encoding: "utf8" }).trim() === "true");
	git(path.join(IMPORTS, packId), ["config", "user.email", "saker-test@example.invalid"]);
	git(path.join(IMPORTS, packId), ["config", "user.name", "Saker Test"]);

	// 本地制造与上游分叉的提交
	write(path.join(IMPORTS, packId, "local-only.md"), "local\n");
	git(path.join(IMPORTS, packId), ["add", "."]);
	git(path.join(IMPORTS, packId), ["commit", "-m", "local divergence"]);

	// 上游继续前进；旧的 ff-only 实现会在这里永久失败
	write(path.join(seed, "upstream.md"), "v2\n");
	git(seed, ["add", "."]);
	git(seed, ["commit", "-m", "v2"]);
	git(seed, ["push"]);

	const recovered = await syncPack(pack);
	ok("分叉测试：pull 失败后自动重克隆成功", recovered.ok && recovered.mode === "recover" && recovered.recovered === true, JSON.stringify(recovered));
	ok("分叉测试：新工作副本已对齐上游", fs.readFileSync(path.join(IMPORTS, packId, "upstream.md"), "utf8").trim() === "v2");
	ok("分叉测试：本地分叉文件不在新工作副本", !fs.existsSync(path.join(IMPORTS, packId, "local-only.md")));
	ok("分叉测试：旧目录已备份且保留本地文件", recovered.backup && fs.existsSync(path.join(recovered.backup, "local-only.md")), recovered.backup || "no backup");
	const backupName = recovered.backup ? path.basename(recovered.backup) : "";
	ok("分叉测试：备份使用隐藏目录名", backupName.startsWith("."), backupName);
	const importBrowse = await dispatch("browse", { source: "import", dir: "" });
	const importNames = (importBrowse.value?.dirs || []).map((item) => item.name);
	ok("分叉测试：备份目录不出现在导入层浏览列表", !importNames.includes(backupName), JSON.stringify(importNames));
}

// ── 残骸回收：孤儿临时 clone 与多余的分叉备份 ─────────────────────────────
// 背景：真 home 里堆了 4 份 `.hacktricks.recover-*`（其中 3 份是完整 1035 文件仓库）
// 加 1 份旧 `.diverged-*`，合计 42MB —— 恢复逻辑只管建、没人回收。
{
	const { prunePackDebris } = await import("../lib/packs.js");
	const junk = fs.mkdtempSync(path.join(os.tmpdir(), "packs-debris-"));
	const mk = (name, ageMs) => {
		const dir = path.join(junk, name);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "x.md"), "x");
		const stamp = new Date(Date.now() - ageMs);
		fs.utimesSync(dir, stamp, stamp);
		return dir;
	};
	const orphanA = mk(".alpha.recover-111-2-aaaaaa", 10 * 60_000);
	const orphanB = mk(".alpha.recover-222-2-bbbbbb", 10 * 60_000);
	const oldDiverged = mk(".alpha.diverged-111-2-cccccc", 20 * 60_000);
	const newDiverged = mk(".alpha.diverged-222-2-dddddd", 10 * 60_000);
	const referenced = mk(".beta.diverged-333-2-eeeeee", 30 * 60_000);
	const freshTemp = mk(".alpha.recover-333-2-ffffff", 1_000);

	// 默认档：只清纯临时 clone，**一份分叉备份都不动**（里面可能有用户的本地修改）
	const safe = prunePackDebris(junk, { packs: { beta: { backup: referenced } } }, { minAgeMs: 60_000 });
	ok("残骸回收（默认档）：只清孤儿临时 clone", !fs.existsSync(orphanA) && !fs.existsSync(orphanB), JSON.stringify(safe.removed));
	ok("残骸回收（默认档）：分叉备份一份都不删", fs.existsSync(oldDiverged) && fs.existsSync(newDiverged) && fs.existsSync(referenced));
	ok("残骸回收：刚生成的临时目录不动（可能正在同步）", fs.existsSync(freshTemp));

	// 显式档：才回收多余的分叉备份（state 引用的与每个 pack 最新一份仍保留）
	const result = prunePackDebris(junk, { packs: { beta: { backup: referenced } } }, { minAgeMs: 60_000, includeBackups: true });
	ok("残骸回收：孤儿临时 clone 被清掉", !fs.existsSync(orphanA) && !fs.existsSync(orphanB), JSON.stringify(result.removed));
	ok("残骸回收：只留每个 pack 最新的一份分叉备份", !fs.existsSync(oldDiverged) && fs.existsSync(newDiverged));
	ok("残骸回收：state 引用着的备份不动", fs.existsSync(referenced));
	ok("残骸回收：刚生成的临时目录不动（可能正在同步）", fs.existsSync(freshTemp));
	// 此时孤儿临时目录已被默认档清掉，剩下的 3 个都是备份：2 个保留 + 1 个多余被删
	ok("残骸回收：清理结果可对账", result.removed.length === 1 && result.kept.length === 3, JSON.stringify(result));
	const again = prunePackDebris(junk, { packs: { beta: { backup: referenced } } }, { minAgeMs: 60_000, includeBackups: true });
	ok("残骸回收幂等（第二次零删除）", again.removed.length === 0, JSON.stringify(again));
	fs.rmSync(junk, { recursive: true, force: true });
}

// ── 接线：syncPacks 必须真的调用回收（否则上面全绿、宿主里永远不回收）────────
{
	const { syncPacks, loadCatalog } = await import("../lib/packs.js");
	const imports = path.join(HOME, "refs", "imports");
	fs.mkdirSync(imports, { recursive: true });
	const orphan = path.join(imports, ".wiring-pack.recover-111-2-aaaaaa");
	fs.mkdirSync(orphan, { recursive: true });
	fs.writeFileSync(path.join(orphan, "x.md"), "x");
	const stamp = new Date(Date.now() - 10 * 60_000);
	fs.utimesSync(orphan, stamp, stamp);

	// 把所有 pack 标成"刚同步过" => 这一轮一个都不选（完全不联网），但回收仍要发生
	const statePath = path.join(HOME, "refs", "knowledge-packs-state.json");
	let state = { version: 1, packs: {}, syncMode: "auto" };
	try { state = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { /* 首次运行时状态文件还没落盘 */ }
	const nowIso = new Date().toISOString();
	state.packs = state.packs || {};
	for (const pack of loadCatalog().packs) {
		state.packs[pack.id] = { ...(state.packs[pack.id] || {}), status: "ok", lastSyncAt: nowIso, lastAttemptAt: nowIso };
	}
	state.syncMode = "auto";
	fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

	const summary = await syncPacks({});
	ok("syncPacks 离线跑通（0 个待同步）", summary.requested === 0, JSON.stringify({ requested: summary.requested }));
	ok("syncPacks 真的回收了残骸（接线没断）", summary.debris?.removed?.length === 1 && !fs.existsSync(orphan), JSON.stringify(summary.debris));
}

// ── 14. 同步模式：auto 自动、manual 手动、frozen 切断主动联网 ────────────────
{
	delete process.env.DSH_KNOWLEDGE_AUTOSYNC;
	ok("同步模式默认 auto", getSyncMode() === "auto");
	setSyncMode("manual");
	ok("可持久化为 manual", getSyncMode() === "manual");
	const manualAuto = await autoSyncKnowledgePacks(false);
	ok("manual 下自动同步跳过", manualAuto.skipped === true && /manual/.test(manualAuto.reason), JSON.stringify(manualAuto));
	setSyncMode("frozen");
	const frozen = await dispatch("packs-sync", { force: true });
	ok("frozen 下即使 force 也跳过同步", frozen.ok === true && frozen.value.skipped === true && /冻结/.test(frozen.value.reason), JSON.stringify(frozen));
	const status = await dispatch("packs-status", {});
	ok("packs-status 返回当前同步模式", status.ok === true && status.value.syncMode === "frozen", JSON.stringify(status).slice(0, 180));
	await dispatch("packs-mode", { mode: "auto" });
	ok("RPC 可恢复 auto", getSyncMode() === "auto");
}

// ── 混合语种检索（2026-09-18）：术语替换 + 覆盖度 rerank 的纯函数 ────────────────
{
	const translated = translateQuery("Sigma 检测规则 可疑 powershell 编码命令");
	ok("中文术语被替换成英文说法（整句检索用）",
		translated.includes("detection rule") && translated.includes("encoded command") && translated.includes("powershell"),
		translated);
	ok("纯英文查询不做替换（原样返回）",
		translateQuery("sigma rule powershell encoded command") === "sigma rule powershell encoded command");
	ok("空查询安全返回空串", translateQuery("") === "" && translateQuery("   ") === "");

	const concepts = queryConcepts("Sigma 检测规则 可疑 powershell 编码命令");
	ok("概念集含拉丁实词与翻译词",
		concepts.includes("powershell") && concepts.includes("encoded") && concepts.includes("detection"),
		concepts.join(","));
	ok("概念集去重且有上限（≤10）", concepts.length <= 10 && new Set(concepts).size === concepts.length);
	ok("纯中文查询也能产出英文概念", queryConcepts("计划任务持久化").includes("scheduled"));

	const hitOf = (hay) => ({ path: hay, title: "", heading: "", preview: "" });
	ok("覆盖度加成：命中越多分越高，封顶 12",
		coverageBonusOf(hitOf("powershell_base64_encoded_rule.yml"), ["powershell", "encoded", "base64", "rule"]) === 12
		&& coverageBonusOf(hitOf("powershell_base64_encoded_cmd.yml"), ["powershell", "encoded"]) === 6
		&& coverageBonusOf(hitOf("powershell_base64_encoded_cmd.yml"), ["powershell", "encoded", "base64"]) === 9
		&& coverageBonusOf(hitOf("unrelated.md"), ["powershell"]) === 0);
	ok("没有概念时加成为 0", coverageBonusOf(hitOf("anything"), []) === 0);
}

// ── status() 计数缓存（2026-09-18 性能修复）──────────────────────────────────
// ensureKnowledgeIndex() 每次检索都会问一次 status()，旧实现每次都 COUNT(*) 整表
// （8.4 万 chunk ≈140ms）——等于每次知识检索都在做全表计数。这里锁住"缓存 + 失效重算"。
{
	const idx = ensureKnowledgeIndex();
	if (!idx) {
		ok("status 计数缓存（测试环境无索引，跳过）", true);
	} else {
		const first = idx.status();
		const cached = idx.counts;
		const second = idx.status();
		ok("status() 复用计数缓存，不再每次全表 COUNT",
			cached !== null && cached === idx.counts && second.docs === first.docs);
		idx.invalidate();
		ok("invalidate() 清掉计数缓存（重建后才会重新计数）", idx.counts === null && idx.dirty === true);
		idx.markClean();
		const refreshed = idx.status();
		ok("失效后 status() 重新计数并回填", idx.counts !== null && Number(refreshed.chunks) >= 0);
	}
}

// ── 外部知识变更的持久化指纹 ───────────────────────────────────────────────
// 索引库可能由另一个进程构建；宿主重启时内存 dirty 标志是 false，必须用持久化
// 指纹比较发现「索引后新增/修改了知识文件」，否则会悄悄继续搜旧库。
{
	const idx = ensureKnowledgeIndex();
	if (!idx) {
		ok("索引源指纹（测试环境无索引，跳过）", true);
	} else {
		idx.rebuild({ force: true });
		const before = idx.status({ refreshFingerprint: true });
		const lateFile = path.join(USER_PENTEST, "late-index.md");
		write(lateFile, "# late\n\n新入库的知识\n");
		const after = idx.status({ refreshFingerprint: true });
		ok("新增源文件后 status 标记 dirty", before.dirty === false && after.dirty === true);
		fs.rmSync(lateFile, { force: true });
		idx.rebuild({ force: true });
		ok("重建后指纹回到 clean", idx.status({ refreshFingerprint: true }).dirty === false);
	}
}

// ── 提示词清单缓存（2026-09-18 性能修复）────────────────────────────────────
// 这条 manifest 每个回合都会被装配一次；旧实现每次全量遍历知识目录（真实库实测 ~33ms/回合）。
// 用"patch readdirSync 计数"做行为断言，不用计时断言（避免机器负载导致的 flaky）。
{
	const { knowledgeManifest } = await import("../lib/index.js");
	const original = fs.readdirSync;
	let calls = 0;
	fs.readdirSync = (...args) => { calls += 1; return original(...args); };
	try {
		const first = knowledgeManifest();
		const afterFirst = calls;
		const second = knowledgeManifest();
		ok("manifest 第二次命中缓存：不再遍历知识目录",
			afterFirst > 0 && calls === afterFirst && second === first, `calls=${calls}/${afterFirst}`);
		ok("manifest 形状正确（标记块或空串）",
			first === "" || first.startsWith("<dsh-knowledge-hub>"), first.slice(0, 60));
		const rebuilt = knowledgeManifest(Date.now() + 10 * 60 * 1000);
		ok("超过 TTL 会重建（不是永久缓存）", calls > afterFirst && rebuilt === first);
	} finally {
		fs.readdirSync = original;
	}
}

// ── 知识库目录交互契约（2026-09-19 实机复验）──────────────────────────────
// 打开文章时旧实现直接卸载 TreeSection，返回目录后展开状态和滚动位置全丢，
// 实战查资料只能在 66 个分类里反复翻。目录必须保持挂载（只在打开文章时隐藏），
// 并提供来源内筛选作为快速定位入口。
{
	const client = fs.readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
	ok("来源目录提供分类/文件筛选", client.includes("筛选当前来源的分类或文件"));
	ok("打开文章时目录保持挂载（返回后保留展开与滚动状态）",
		client.includes("display: activeFile ? 'none' : 'block'")
		// 只禁止"把列表本身条件渲染成 null"这一种写法（会卸载、丢展开与滚动）；
		// 列表下方的提示行用 `activeFile ? null : …` 是正常的，不能一起禁掉。
		&& !/activeFile \? null : React\.createElement\('div', \{ style: \{ display: activeFile \? 'none'/.test(client));
	// 未打开文件时不再留空的右半栏：旧布局 `280px minmax(0,1fr)` 把检索结果挤在
	// 280px 里，路径被截断成 `exploitdb/…/5118…`，护网时扫一眼分不清命中。
	ok("未打开文件时列表占满整宽（不再被空态右栏挤成 280px）",
		client.includes("gridTemplateColumns: 'minmax(0,1fr)'")
		&& !client.includes("'280px minmax(0,1fr)'"));
	// 回归背景：onDeleted 里误用了 setNotice —— 那是 PackCard/EdbCard 内部的 state，
	// Page 组件根本没有它。结果是删除其实成功了，但处理函数抛 ReferenceError，
	// 「已删除（可找回）」提示永远不出现。这里锁住：Page 组件内不得出现 setNotice。
	{
		const start = client.indexOf("function Page(props)");
		const end = client.indexOf("function apply(ctx)");
		const pageSrc = client.slice(start, end > start ? end : undefined);
		ok("Page 组件不使用它没声明的 setNotice（避免 ReferenceError 吞掉提示）",
			start > 0 && !/\bsetNotice\s*\(/.test(pageSrc), (pageSrc.match(/\bsetNotice\s*\([^)]*/) || [""])[0]);
		ok("删除后的提示走 Page 自己的 pageNotice", pageSrc.includes("setPageNotice("));
	}
	// 设了 busy 的 RPC 链必须有拒绝兜底：否则 RPC 一 reject（宿主重启 / 连接层协议错）
	// busy 永远为 true，界面卡在"保存中…"且不显示原因 —— 这正是本轮修的那个白板形态。
	ok("读/存/删/检索四条链都有拒绝兜底（不会卡在保存中）",
		(client.match(/setBusy\(false\); setMsg\(\{ ok: false, text: '[^']*失败：/g) || []).length >= 3
		&& client.includes("setSearchBusy(false); setHits([]); setSearchErr('检索失败："));
}

closeKnowledgeIndex();
fs.rmSync(HOME, { recursive: true, force: true });
console.log(fail === 0 ? `\nall ${pass} tests passed` : `\n${fail} FAILED, ${pass} passed`);
process.exit(fail ? 1 : 0);
