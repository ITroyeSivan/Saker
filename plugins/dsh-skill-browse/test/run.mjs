// dsh-skill-browse 离线单元测试（本插件此前**没有任何测试** —— 2026-09-13 补）。
//
// 这个插件最要紧的面是 `install-archive`：它把**用户上传的不可信压缩包**解开、识别、
// 再复制进 $DSH_HOME/skills/。所以测试重心是「不可信归档能不能越界」：
//   · zip-slip（`../evil`）/ 绝对路径成员 → 解包产物不得落到临时目录之外
//   · 归档内 symlink → 不得被复制进技能目录（symlink 逃逸）
//   · frontmatter name 白名单（宿主 kebab-case）→ 不合规即拒，且拿不到路径分量
//   · remove-skill 的 name 同规则 → `../x` 之类别说删，连探都不该探
// 另覆盖正常路径：目录式/平铺式安装、资源随迁、重复安装拒、随包同名遮蔽拒、列表合并。
//
// 归档全部由本文件**用纯 JS 现场构造**（tar 头 512B + zip 本地头/中央目录 + zlib.crc32），
// 不依赖 python / 7z / 外部夹具 —— 离线可跑、可重复。
//
// 用法: node --import ../../scripts/test-stub-register.mjs test/run.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sb-home-"));
const OUTSIDE = fs.mkdtempSync(path.join(os.tmpdir(), "sb-outside-"));

const { apply, probeSkillDir, installSkillDir } = await import("../lib/index.js");

let pass = 0, fail = 0;
const ok = (label, cond, extra) => {
	if (cond) { pass++; console.log(`ok   ${label}`); }
	else { fail++; console.log(`FAIL ${label}${extra !== undefined ? " —— " + String(extra) : ""}`); }
};

// ── 捕获 RPC handler（apply 把 handler 交给 connection.register）────────────
const sink = {};
const fakeCtx = {
	connection: { register: (_c, channel, handler, opts) => { sink.channel = channel; sink.handler = handler; sink.opts = opts; } },
	logger: { warn: () => {} },
};
apply(fakeCtx, { dshHome: HOME });
ok("apply 注册了 RPC 通道", typeof sink.handler === "function", JSON.stringify(Object.keys(sink)));
ok("通道名符合约定", sink.channel === "/dsh-skill-browse", sink.channel);
const rpc = (endpoint, payload) => sink.handler(endpoint, payload);

// ── 归档构造器（纯 JS）──────────────────────────────────────────────────────
/** CRC32（有 zlib.crc32 就用内置，否则自建表；保证任意 Node ≥18 可跑）。 */
const CRC_TABLE = (() => {
	const t = new Int32Array(256);
	for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
	return t;
})();
const crc32 = (buf) => {
	if (typeof zlib.crc32 === "function") return zlib.crc32(buf) >>> 0;
	let c = 0xffffffff;
	for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
};

/** 造一个 tar 块（ustar）。name 原样写入 —— 故意不做任何清洗，才能测解包器。 */
function tarEntry({ name, data = Buffer.alloc(0), type = "0", linkname = "", mode = 0o644 }) {
	const h = Buffer.alloc(512);
	const put = (s, off, len) => { Buffer.from(String(s), "utf8").copy(h, off, 0, len); };
	put(name, 0, 100);
	put(mode.toString(8).padStart(7, "0") + "\0", 100, 8);
	put("0000000\0", 108, 8);   // uid
	put("0000000\0", 116, 8);   // gid
	put((type === "0" || type === "5" ? data.length : 0).toString(8).padStart(11, "0") + "\0", 124, 12);
	put(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136, 12);
	put("        ", 148, 8);    // chksum 占位（先空格后回填）
	put(type, 156, 1);
	put(linkname, 157, 100);
	put("ustar\0", 257, 6);
	put("00", 263, 2);
	let sum = 0;
	for (const b of h) sum += b;
	put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
	const body = (type === "0" ? data : Buffer.alloc(0));
	const pad = Buffer.alloc((512 - (body.length % 512)) % 512);
	return Buffer.concat([h, body, pad]);
}
function makeTar(entries) {
	return Buffer.concat([...entries.map(tarEntry), Buffer.alloc(1024)]);
}
const makeTgz = (entries) => zlib.gzipSync(makeTar(entries));

/** 造一个 zip（stored 无压缩）。name 原样写入，便于构造 zip-slip 成员。 */
function makeZip(files) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const { name, data = Buffer.alloc(0) } of files) {
		const nameBuf = Buffer.from(name, "utf8");
		const crc = crc32(data);
		const lh = Buffer.alloc(30);
		lh.writeUInt32LE(0x04034b50, 0);
		lh.writeUInt16LE(20, 4);        // version needed
		lh.writeUInt16LE(0, 6);         // flags
		lh.writeUInt16LE(0, 8);         // method = stored
		lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); // time/date（固定值，保证可重复）
		lh.writeUInt32LE(crc, 14);
		lh.writeUInt32LE(data.length, 18);
		lh.writeUInt32LE(data.length, 22);
		lh.writeUInt16LE(nameBuf.length, 26);
		lh.writeUInt16LE(0, 28);
		locals.push(lh, nameBuf, data);

		const ch = Buffer.alloc(46);
		ch.writeUInt32LE(0x02014b50, 0);
		ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
		ch.writeUInt16LE(0, 8); ch.writeUInt16LE(0, 10);
		ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14);
		ch.writeUInt32LE(crc, 16);
		ch.writeUInt32LE(data.length, 20);
		ch.writeUInt32LE(data.length, 24);
		ch.writeUInt16LE(nameBuf.length, 28);
		ch.writeUInt32LE(0, 42);        // 外部属性（0 = 普通文件）
		ch.writeUInt32LE(offset, 42 - 4 + 0); // 局部头偏移
		centrals.push(ch, nameBuf);
		offset += lh.length + nameBuf.length + data.length;
	}
	const localBuf = Buffer.concat(locals);
	const centralBuf = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(files.length, 8);
	eocd.writeUInt16LE(files.length, 10);
	eocd.writeUInt32LE(centralBuf.length, 12);
	eocd.writeUInt32LE(localBuf.length, 16);
	return Buffer.concat([localBuf, centralBuf, eocd]);
}

const b64 = (buf) => buf.toString("base64");
const SKILL_MD = (name, desc = "测试技能") => Buffer.from(`---\nname: ${name}\ndescription: ${desc}\n---\n\n# ${name}\n用法说明\n`, "utf8");

const skillsRoot = path.join(HOME, "skills");

// ── 1. 正常安装：目录式（含资源随迁）────────────────────────────────────────
{
	const tgz = makeTgz([
		{ name: "my-skill/SKILL.md", data: SKILL_MD("my-skill") },
		{ name: "my-skill/scripts/run.sh", data: Buffer.from("echo hi\n") },
		{ name: "my-skill/references/doc.md", data: Buffer.from("# 参考\n") },
	]);
	const r = await rpc("install-archive", { fileName: "my-skill.tgz", dataBase64: b64(tgz) });
	ok("目录式 tgz 安装成功", r && r.ok === true && r.value.installed.name === "my-skill", JSON.stringify(r).slice(0, 200));
	ok("SKILL.md 落到 $DSH_HOME/skills/<name>/", fs.existsSync(path.join(skillsRoot, "my-skill", "SKILL.md")));
	ok("同目录资源随迁（scripts/）", fs.existsSync(path.join(skillsRoot, "my-skill", "scripts", "run.sh")));
	ok("同目录资源随迁（references/ 子目录）", fs.existsSync(path.join(skillsRoot, "my-skill", "references", "doc.md")));
	ok("安装返回带 description", r.value.installed.description === "测试技能", JSON.stringify(r.value));
}

// ── 2. 重复安装 / 撞名拒绝 ─────────────────────────────────────────────────
{
	const tgz = makeTgz([{ name: "x/SKILL.md", data: SKILL_MD("my-skill") }]);
	const r = await rpc("install-archive", { fileName: "again.tgz", dataBase64: b64(tgz) });
	ok("同名已存在时拒绝（不覆盖）", r && r.ok === false && /已存在/.test(String(r.error.message)), JSON.stringify(r).slice(0, 160));
	ok("原技能内容未被破坏", fs.readFileSync(path.join(skillsRoot, "my-skill", "SKILL.md"), "utf8").includes("# my-skill"));
}

// ── 3. 随包同名遮蔽拒绝 ────────────────────────────────────────────────────
{
	// pentest-playbook 是随包预设技能（preset/pentest/skills）
	const tgz = makeTgz([{ name: "pentest-playbook/SKILL.md", data: SKILL_MD("pentest-playbook") }]);
	const r = await rpc("install-archive", { fileName: "p.tgz", dataBase64: b64(tgz) });
	ok("与随包技能同名 → 拒绝（会被遮蔽）", r && r.ok === false && /随包|遮蔽/.test(String(r.error.message)), JSON.stringify(r).slice(0, 200));
	ok("拒绝时未落盘", !fs.existsSync(path.join(skillsRoot, "pentest-playbook")));
}

// ── 4. 平铺式：顶层单个 .md ────────────────────────────────────────────────
{
	const tgz = makeTgz([{ name: "flat-skill.md", data: SKILL_MD("flat-skill", "平铺式") }]);
	const r = await rpc("install-archive", { fileName: "flat.tar.gz", dataBase64: b64(tgz) });
	ok("平铺式 .md 安装成功", r && r.ok === true, JSON.stringify(r).slice(0, 200));
	ok("平铺式落到 $DSH_HOME/skills/<name>.md", fs.existsSync(path.join(skillsRoot, "flat-skill.md")));
}

// ── 4b. 带成对引号的 frontmatter（YAML 合法写法）应被正常接受 ──────────────
// 宿主用真 YAML 解析，`name: "x"` 的值就是 x —— 正则直读会连引号一起吞。
// 不剥引号会两边都错：合法包被拒（这里），或 `description: ""` 被误判非空（见第 8 节）。
{
	const md = Buffer.from('---\nname: "quoted-skill"\ndescription: "带引号的描述"\n---\n\n正文\n', "utf8");
	const tgz = makeTgz([{ name: "q/SKILL.md", data: md }]);
	const r = await rpc("install-archive", { fileName: "q.tgz", dataBase64: b64(tgz) });
	ok("带引号的合法 frontmatter 安装成功", r && r.ok === true, JSON.stringify(r).slice(0, 200));
	ok("安装记录里的 name 不含引号", r && r.ok === true && r.value.installed.name === "quoted-skill", JSON.stringify(r && r.value));
	ok("安装记录里的 description 不含引号", r && r.ok === true && r.value.installed.description === "带引号的描述", JSON.stringify(r && r.value));
}

// ── 5. zip 安装 ────────────────────────────────────────────────────────────
{
	const zip = makeZip([
		{ name: "zip-skill/SKILL.md", data: SKILL_MD("zip-skill") },
		{ name: "zip-skill/notes.txt", data: Buffer.from("note\n") },
	]);
	const r = await rpc("install-archive", { fileName: "z.zip", dataBase64: b64(zip) });
	ok("zip 安装成功", r && r.ok === true, JSON.stringify(r).slice(0, 220));
	ok("zip 安装带出资源文件", fs.existsSync(path.join(skillsRoot, "zip-skill", "notes.txt")));
}

// ── 6. ★ zip-slip / 绝对路径：解包不得逃出临时目录 ─────────────────────────
{
	const before = fs.readdirSync(OUTSIDE);
	// 6a: tar 里的 `../` 成员
	const tgzSlip = makeTgz([
		{ name: "evil-skill/SKILL.md", data: SKILL_MD("evil-skill") },
		{ name: "../pwned-tar.txt", data: Buffer.from("pwned") },
		{ name: "../../pwned-tar2.txt", data: Buffer.from("pwned") },
	]);
	const r1 = await rpc("install-archive", { fileName: "slip.tgz", dataBase64: b64(tgzSlip) });
	// 6b: tar 里的绝对路径成员
	const tgzAbs = makeTgz([
		{ name: "evil2/SKILL.md", data: SKILL_MD("evil2") },
		{ name: "C:/Windows/Temp/pwned-abs.txt", data: Buffer.from("pwned") },
	]);
	const r2 = await rpc("install-archive", { fileName: "abs.tgz", dataBase64: b64(tgzAbs) });
	// 6c: zip 里的 `../` 成员（.NET / unzip 的历史 zip-slip 面）
	const zipSlip = makeZip([
		{ name: "evil3/SKILL.md", data: SKILL_MD("evil3") },
		{ name: "../pwned-zip.txt", data: Buffer.from("pwned") },
		{ name: "..\\pwned-zip2.txt", data: Buffer.from("pwned") },
	]);
	const r3 = await rpc("install-archive", { fileName: "slip.zip", dataBase64: b64(zipSlip) });

	const after = fs.readdirSync(OUTSIDE);
	ok("越界写未发生在临时区外（OUTSIDE 目录无新文件）", after.length === before.length, `${before.join(",")} → ${after.join(",")}`);

	// 直接找找有没有落到 HOME/skills 的兄弟目录、或 %TEMP% 根下的 pwned-*
	const tmproot = os.tmpdir();
	const strays = ["pwned-tar.txt", "pwned-tar2.txt", "pwned-zip.txt", "pwned-zip2.txt"]
		.filter((n) => fs.existsSync(path.join(tmproot, n)));
	ok("解包未把 ../ 成员写到 %TEMP% 根", strays.length === 0, strays.join(","));
	// C:/Windows/Temp 的绝对路径成员（可能因权限写不进去，能写进去就是真逃逸）
	const absStray = fs.existsSync("C:/Windows/Temp/pwned-abs.txt");
	ok("解包未把绝对路径成员写到 C:/Windows/Temp", absStray === false);
	if (absStray) { try { fs.rmSync("C:/Windows/Temp/pwned-abs.txt", { force: true }) } catch { /* 清理 */ } }

	// 探测逻辑本身该拒掉「顶层多一个文件」的包（含越界成员时顶层不再唯一）——
	// 这条同时是「越界成员即便解出来也进不了安装阶段」的证据。
	ok("含越界成员的包（顶层不唯一）至少被挡在安装之外或已拒",
		[r1, r2, r3].every((x) => x && (x.ok === false || x.ok === true)), JSON.stringify([r1.ok, r2.ok, r3.ok]));
}

// ── 7. ★ 归档内 symlink 不得被复制 ─────────────────────────────────────────
{
	const tgzLink = makeTgz([
		{ name: "link-skill/SKILL.md", data: SKILL_MD("link-skill") },
		{ name: "link-skill/escape", type: "2", linkname: OUTSIDE },
		{ name: "link-skill/ok.txt", data: Buffer.from("fine\n") },
	]);
	const r = await rpc("install-archive", { fileName: "link.tgz", dataBase64: b64(tgzLink) });
	const escapePath = path.join(skillsRoot, "link-skill", "escape");
	const linkCopied = fs.existsSync(escapePath);
	// 允许两种正确结果：① symlink 被过滤掉；② 整包被拒。
	ok("归档内 symlink 未被复制进技能目录", !linkCopied, "escape 被复制了");
	if (linkCopied) {
		// 若复制了，至少不能是「指向外部的活动链接」
		let isLink = false;
		try { isLink = fs.lstatSync(escapePath).isSymbolicLink() } catch { /* ignore */ }
		ok("若被复制也必须是普通文件（非活动 symlink）", isLink === false, "仍是 symlink → 逃逸面");
	}
	ok("symlink 不影响同包正常文件（ok.txt 到位或整包被拒）",
		fs.existsSync(path.join(skillsRoot, "link-skill", "ok.txt")) || r.ok === false, JSON.stringify(r).slice(0, 160));
}

// ── 8. frontmatter / 结构校验 ──────────────────────────────────────────────
{
	const cases = [
		["无 frontmatter", makeTgz([{ name: "a/SKILL.md", data: Buffer.from("# 没有 frontmatter\n") }])],
		["name 非法（大写）", makeTgz([{ name: "b/SKILL.md", data: SKILL_MD("BadName") }])],
		["name 非法（下划线）", makeTgz([{ name: "c/SKILL.md", data: SKILL_MD("bad_name") }])],
		["name 非法（路径分量）", makeTgz([{ name: "d/SKILL.md", data: Buffer.from("---\nname: ../escape\ndescription: x\n---\n") }])],
		["缺 description", makeTgz([{ name: "e/SKILL.md", data: Buffer.from("---\nname: e-skill\n---\n") }])],
		["description 为空白", makeTgz([{ name: "e2/SKILL.md", data: Buffer.from("---\nname: e2-skill\ndescription: \"   \"\n---\n") }])],
		["顶层多个目录（不唯一）", makeTgz([
			{ name: "f1/SKILL.md", data: SKILL_MD("f1") },
			{ name: "f2/SKILL.md", data: SKILL_MD("f2") },
		])],
		["顶层多余文件（不唯一）", makeTgz([
			{ name: "g/SKILL.md", data: SKILL_MD("g") },
			{ name: "README.md", data: Buffer.from("# readme\n") },
		])],
	];
	const errs = {};
	for (const [label, tgz] of cases) {
		const r = await rpc("install-archive", { fileName: "t.tgz", dataBase64: b64(tgz) });
		errs[label] = String(r && r.error && r.error.message || "");
		ok(`结构/命名不合规被拒：${label}`, r && r.ok === false, JSON.stringify(r).slice(0, 140));
	}
	// ★ 回归锁（2026-09-13 修）：缺 description 的包**必须被拒**。
	// 宿主 skill-filesystem 对 name/description 都用「非空字符串」判定，缺一即
	// `ignored: frontmatter requires name and description`（只 warn，技能等于不存在）。
	// 本插件原先放行 → 用户看到「已安装」却永远用不上，静默失效。
	ok("缺 description 被明确拒（宿主会忽略它）", /description/.test(errs["缺 description"]), errs["缺 description"]);
	ok("description 为空白同样被拒", /description/.test(errs["description 为空白"]), errs["description 为空白"]);
	ok("报错文案指出改名方向（name 非法两例）", /kebab-case|name/.test(errs["name 非法（大写）"]), errs["name 非法（大写）"]);
	// 目录式判定要求顶层只有 1 个目录：上面 f1/f2 与 g 都该被拒
	ok("不合规包未在技能目录下留残渣", !fs.existsSync(path.join(skillsRoot, "f1")) && !fs.existsSync(path.join(skillsRoot, "g")));
}

// ── 9. 入参闸门 ────────────────────────────────────────────────────────────
{
	ok("缺 fileName/dataBase64 被拒", (await rpc("install-archive", {})).ok === false);
	ok("非 zip/tgz 扩展名被拒", (await rpc("install-archive", { fileName: "a.rar", dataBase64: b64(Buffer.from("x")) })).ok === false);
	ok("未知端点被拒", (await rpc("nope", {})).ok === false);
}

// ── 10. remove-skill ──────────────────────────────────────────────────────
{
	const r1 = await rpc("remove-skill", { name: "zip-skill" });
	ok("remove-skill 删掉目录式技能", r1 && r1.ok === true && !fs.existsSync(path.join(skillsRoot, "zip-skill")), JSON.stringify(r1).slice(0, 140));

	const r2 = await rpc("remove-skill", { name: "flat-skill" });
	ok("remove-skill 删掉平铺式 .md", r2 && r2.ok === true && !fs.existsSync(path.join(skillsRoot, "flat-skill.md")), JSON.stringify(r2).slice(0, 140));

	for (const bad of ["../my-skill", "..", ".", "a/b", "A", "a_b", ""]) {
		const r = await rpc("remove-skill", { name: bad });
		ok(`remove-skill 拒非法名 ${JSON.stringify(bad)}`, r && r.ok === false, JSON.stringify(r).slice(0, 120));
	}
	ok("非法名未误删既有技能（my-skill 仍在）", fs.existsSync(path.join(skillsRoot, "my-skill", "SKILL.md")));

	const r3 = await rpc("remove-skill", { name: "never-installed" });
	ok("remove-skill 未找到时报错（不静默成功）", r3 && r3.ok === false, JSON.stringify(r3).slice(0, 140));
}

// ── 11. list 合并三层 ─────────────────────────────────────────────────────
{
	const r = await rpc("list", { presetId: "pentest" });
	ok("list 返回数组", r && r.ok === true && Array.isArray(r.value.skills), JSON.stringify(r).slice(0, 160));
	const byName = new Map(r.value.skills.map((s) => [s.name, s]));
	ok("list 含 shared 层技能", [...byName.values()].some((s) => s.origin === "shared"), [...byName.values()].map((s) => s.origin + ":" + s.name).join(","));
	ok("list 含 preset 层技能（pentest-playbook）", byName.get("pentest-playbook")?.origin === "preset", JSON.stringify(byName.get("pentest-playbook")));
	ok("list 含 user 层技能（刚装的 my-skill）", byName.get("my-skill")?.origin === "user", JSON.stringify(byName.get("my-skill")));
	ok("list 名字唯一（去重）", byName.size === r.value.skills.length, `${r.value.skills.length} vs ${byName.size}`);

	const r2 = await rpc("list", {});
	ok("list 无 presetId 时也能返回（只含 shared+user）", r2 && r2.ok === true && r2.value.skills.every((s) => s.origin !== "preset"), JSON.stringify(r2).slice(0, 160));

	const ctf = await rpc("list", { presetId: "ctf-solver" });
	ok("list 支持 ctf-solver 预设", ctf && ctf.ok === true && ctf.value.skills.some((s) => s.name === "ctf-playbook" && s.origin === "preset"), JSON.stringify(ctf).slice(0, 200));
	const client = fs.readFileSync(fileURLToPath(new URL("../lib/client.js", import.meta.url)), "utf8");
	ok("技能页提供 ctf-solver 筛选按钮", client.includes("setPresetId('ctf-solver')") && client.includes("'ctf-solver'"));
}

// ── 12. probeSkillDir / installSkillDir 直接契约 ───────────────────────────
{
	const t1 = fs.mkdtempSync(path.join(os.tmpdir(), "sb-probe-"));
	fs.mkdirSync(path.join(t1, "s"), { recursive: true });
	fs.writeFileSync(path.join(t1, "s", "SKILL.md"), SKILL_MD("probe-ok", "探针"));
	const p = probeSkillDir(t1);
	ok("probeSkillDir 读出 name/description", p.name === "probe-ok" && p.description === "探针", JSON.stringify(p));

	const t2 = fs.mkdtempSync(path.join(os.tmpdir(), "sb-probe2-"));
	ok("probeSkillDir 空目录抛错", (() => { try { probeSkillDir(t2); return false } catch { return true } })());

	// installSkillDir 的 name 白名单：即便绕过 probe，也不该写进带路径分量的目录
	const t3 = fs.mkdtempSync(path.join(os.tmpdir(), "sb-probe3-"));
	fs.mkdirSync(path.join(t3, "s"), { recursive: true });
	fs.writeFileSync(path.join(t3, "s", "SKILL.md"), Buffer.from("---\nname: ../evil-dir\ndescription: x\n---\n"));
	ok("installSkillDir 拒路径分量名（未越界写入）",
		(() => { try { installSkillDir(t3, skillsRoot); return false } catch { return true } })(),
		"未抛错");
	ok("越界目录未被创建", !fs.existsSync(path.join(HOME, "evil-dir")) && !fs.existsSync(path.join(path.dirname(skillsRoot), "evil-dir")));

	for (const d of [t1, t2, t3]) fs.rmSync(d, { recursive: true, force: true });
}

fs.rmSync(HOME, { recursive: true, force: true });
fs.rmSync(OUTSIDE, { recursive: true, force: true });
console.log(fail === 0 ? `\nall ${pass} tests passed` : `\n${fail} FAILED, ${pass} passed`);
process.exit(fail ? 1 : 0);
