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

// ⚠ DSH_HOME 必须在**任何** dshHome() 调用之前设好（模块内 bundleRefs/pattRef 是懒缓存）。
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "kh-home-"));
process.env.DSH_HOME = HOME;

const { dispatch, stats, searchAll, ensureKnowledgeIndex, closeKnowledgeIndex, apply } = await import("../lib/index.js");

let pass = 0, fail = 0;
const ok = (label, cond, extra) => {
	if (cond) { pass++; console.log(`ok   ${label}`); }
	else { fail++; console.log(`FAIL ${label}${extra !== undefined ? " —— " + String(extra) : ""}`); }
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
	ok("命中行号正确（1-based，指向含关键词那行）", hits.some((h) => h.path.includes("sqli.md") && h.line === 2), JSON.stringify(hits.map((h) => [h.path, h.line])));
	ok("命中带预览行", hits.every((h) => typeof h.preview === "string" && h.preview.length > 0));

	// import 层不受 mode 限制（通用内容）
	const imp = searchAll("Kerberoasting", "pentest");
	ok("import 层可检索（跨 mode 通用）", imp.some((h) => h.source === "import" && h.path.includes("ad.md")), JSON.stringify(imp));

	// 别名展开：中文词 → 英文术语
	const alias = searchAll("盲注", "pentest");
	ok("中文别名能命中英文术语（布尔盲注）", alias.some((h) => h.path.includes("sqli.md")));

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
		ok(`${src} 层写被拒（只读）`, r && r.ok === false && /只读/.test(String(r.error)), JSON.stringify(r));
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

	const d = await dispatch("remove", { source: "user", mode: "pentest", path: "sub/dir/note.md" });
	ok("remove 删掉文件", d && d.ok === true && !fs.existsSync(path.join(USER_PENTEST, "sub", "dir", "note.md")), JSON.stringify(d));

	// 目录递归删除
	const d2 = await dispatch("remove", { source: "user", mode: "pentest", path: "sub" });
	ok("remove 递归删目录", d2 && d2.ok === true && !fs.existsSync(path.join(USER_PENTEST, "sub")), JSON.stringify(d2));
	ok("兄弟目录未被误删（删的是子目录不是父）", fs.existsSync(path.join(USER_PENTEST, "web", "sqli.md")));
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
	ok("import_git 不覆盖同名目录", g4 && g4.ok === false && /已存在/.test(String(g4.error)), JSON.stringify(g4).slice(0, 140));
}

// ── 9. 未知端点 ────────────────────────────────────────────────────────────
{
	const r = await dispatch("nope", {});
	ok("未知端点返回 fail 而非抛错", r && r.ok === false && /unknown endpoint/.test(String(r.error)), JSON.stringify(r));
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
}

closeKnowledgeIndex();
fs.rmSync(HOME, { recursive: true, force: true });
console.log(fail === 0 ? `\nall ${pass} tests passed` : `\n${fail} FAILED, ${pass} passed`);
process.exit(fail ? 1 : 0);
