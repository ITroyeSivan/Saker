// Standalone tests: registration check + rate/wordlist rejection paths (no binaries needed).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { spawnSync } from "node:child_process";
import { checkRegistered, configuredToolPaths, hasBin, registerableDefs, resolveToolBin, resolveToolInvocation, RATE_DEFAULTS, runScan, governPreview, spillOutput, breakerCheck, breakerRecord, runGoverned, persistScanRecords, ffufParse } from "../lib/index.js";
import { TOOL_DEFS, buildArgs, tiersLine } from "../lib/registry.js";

const F = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "fixture");
let failed = 0;
const expect = (n, c, d) => { if (c) console.log(`ok   ${n}`); else { failed++; console.log(`FAIL ${n} ${d ?? ""}`); } };

// checkRegistered
let r = checkRegistered(fs, F, "http://127.0.0.1:8081/x");
expect("已登记目标通过", r.ok);
r = checkRegistered(fs, F, "http://10.0.0.9/");
expect("未登记目标拒绝", !r.ok && r.hint.includes("防盲打"));
r = checkRegistered(fs, { readFileSync: () => { throw new Error("x"); } }, "http://a/");
expect("无 assets.md 拒绝并提示先过 Gate P1", !r.ok && r.hint.includes("Gate P1"));

// rate defaults sanity
expect("保守默认值齐备", RATE_DEFAULTS.nuclei === 15 && RATE_DEFAULTS.httpx === 25 && RATE_DEFAULTS.ffuf === 50);

// nuclei 模板库：必须挑**真含模板**的目录，并且用 -t 显式指过去。
// 背景（2026-09-19 实测）：旧代码只 existsSync 检查候选目录就放行，而本机
// ~/.config/nuclei/templates 是个符号链接（真有 13742 个模板），Windows 版 nuclei
// 却不认这个路径 → 空模板集启动 → 联网初始化 → 卡 8 分 52 秒（超时上限 15 分钟）。
{
	const { pickNucleiTemplateDir } = await import("../lib/index.js");
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "nuclei-tpl-"));
	// 只存在但没有任何 yaml → 不算数
	const empty = path.join(home, ".config", "nuclei", "templates");
	fs.mkdirSync(empty, { recursive: true });
	fs.writeFileSync(path.join(empty, "README.txt"), "not a template");
	expect("模板目录只有非 yaml 文件时不算有效", pickNucleiTemplateDir(fs, home) === "", pickNucleiTemplateDir(fs, home));
	// 有 yaml 才算
	fs.writeFileSync(path.join(empty, "cve-2021-44228.yaml"), "id: test");
	// 返回的是 realpath（nuclei 不跟符号链接，必须给它真实目录）
	expect("有 .yaml 的候选目录被选中", pickNucleiTemplateDir(fs, home) === fs.realpathSync(empty), pickNucleiTemplateDir(fs, home));
	// Windows 默认位置优先级更高
	const win = path.join(home, "nuclei-templates");
	fs.mkdirSync(win, { recursive: true });
	fs.writeFileSync(path.join(win, "x.yml"), "id: x");
	expect("nuclei-templates 优先于 .config", pickNucleiTemplateDir(fs, home) === fs.realpathSync(win), pickNucleiTemplateDir(fs, home));
	// 深层模板也算（限制深度内）
	const deep = path.join(win, "http", "cves", "2021");
	fs.mkdirSync(deep, { recursive: true });
	fs.writeFileSync(path.join(deep, "deep.yaml"), "id: deep");
	expect("深层 .yaml 也能被找到", pickNucleiTemplateDir(fs, home) === fs.realpathSync(win));
	fs.rmSync(home, { recursive: true, force: true });
}

// 缺字典拒绝（execute 层逻辑经由直接调用 runScan 不可达——此处验证 runScan 的未登记拦截独立于字典）
r = await runScan({ bin: "definitely-missing-bin-xyz", args: [], workspace: F, tool: "nuclei", rate: undefined, defaultRate: 15, active: false, target: "x" });
expect("缺二进制走三级兜底提示", !r.ok && r.error.includes("三级兜底"));

// ── 注册表参数模型 ──
let b = buildArgs(TOOL_DEFS.nmap, { target: "10.0.0.5" });
expect("nmap 默认参齐（-Pn -sT -sV --max-rate 1000）且无留痕", b.argv.join(" ").includes("-Pn -sT -sV") && b.argv.join(" ").includes("--max-rate 1000") && b.argv[b.argv.length - 1] === "10.0.0.5" && b.audit.length === 0);
b = buildArgs(TOOL_DEFS.nmap, { target: "10.0.0.5", ports: "80,443", rate: 5000 });
expect("flags/combined 生效+显式覆盖留痕", b.argv.includes("-p") && b.argv.includes("80,443") && b.audit.some((x) => x.includes("--max-rate 5000")));
let threw = false;
try { buildArgs(TOOL_DEFS.nmap, { target: "x", nope: 1 }); } catch { threw = true; }
expect("未知参数拒绝", threw);
threw = false;
try { buildArgs(TOOL_DEFS.nmap, { target: "a;rm" }); } catch { threw = true; }
expect("目标 shell 元字符拒绝", threw);
threw = false;
try { buildArgs(TOOL_DEFS.whatweb, { target: "https://a", aggression: 4 }); } catch { threw = true; }
expect("aggression 上限 3 护栏", threw);
b = buildArgs(TOOL_DEFS.subfinder, { domain: "example.com" });
expect("subfinder -d 域参数+默认参", b.argv.includes("-d") && b.argv.includes("example.com") && b.argv.includes("-silent"));
	b = buildArgs(TOOL_DEFS.katana, { target: "https://example.com" });
	expect("katana 使用官方 -u 入参 + 默认深度/限速/JSONL", b.argv.includes("-u") && b.argv.includes("https://example.com") && b.argv.includes("-d") && b.argv.includes("3") && b.argv.includes("-rl") && b.argv.includes("20") && b.argv.includes("-jsonl") && b.argv[b.argv.length - 1] === "https://example.com");
 threw = false;
 try { buildArgs(TOOL_DEFS.katana, { target: "https://example.com", depth: 99 }); } catch { threw = true; }
 expect("katana 深度硬上限 5", threw);
 b = buildArgs(TOOL_DEFS.afrog, { target: "https://example.com" });
 expect("afrog 默认高危+保守限速/并发", b.argv.includes("-t") && b.argv.includes("https://example.com") && b.argv.includes("-S") && b.argv.includes("high,critical") && b.argv.includes("-rl") && b.argv.includes("20") && b.argv.includes("-c") && b.argv.includes("5") && b.argv.includes("-doh"));
 threw = false;
 try { buildArgs(TOOL_DEFS.afrog, { target: "https://example.com", rate: 999 }); } catch { threw = true; }
	// 回归背景：dirsearch 不加 -q 时会往输出里刷几万个进度条片段（实测一次真实会话
	// 落盘 807KB，命中行被埋在 37KB 处），而模型侧只拿开头 6000 字预览 ——
	// 结果是「扫到了 /.git/config 但模型看不见」，直接漏掉一个高危面。
	b = buildArgs(TOOL_DEFS.dirsearch, { url: "https://example.com" });
	expect("dirsearch 默认静默（-q --no-color），否则进度条会淹掉命中",
		b.argv.includes("-q") && b.argv.includes("--no-color")
		&& b.argv.includes("-u") && b.argv.includes("https://example.com"));
 expect("afrog 速率硬上限 100", threw);
 b = buildArgs(TOOL_DEFS.fscan, { target: "10.0.0.0/24", ports: "80,443" });
 expect("fscan 默认关闭 POC/爆破/Redis 利用", b.argv.includes("-h") && b.argv.includes("10.0.0.0/24") && b.argv.includes("-p") && b.argv.includes("80,443") && b.argv.includes("-nopoc") && b.argv.includes("-nobr") && b.argv.includes("-noredis") && b.argv.includes("-np"));
 threw = false;
 try { buildArgs(TOOL_DEFS.fscan, { target: "10.0.0.0/24", threads: 999 }); } catch { threw = true; }
 expect("fscan 线程硬上限 50", threw);
threw = false;
try { buildArgs(TOOL_DEFS.subfinder, {}); } catch { threw = true; }
expect("subfinder 缺域拒绝", threw);
b = buildArgs(TOOL_DEFS.nmap, { target: "10.0.0.5", extra: "-v --open" });
expect("extra 逃生门拆词+留痕", b.argv.includes("-v") && b.audit.some((x) => x.startsWith("extra:")));

// ── 六节点工具调用阶梯 ──
const tl = tiersLine(TOOL_DEFS.nmap);
expect("六节点阶梯文案（本机→MCP→替代→MCP 备选→问装→脚本）", tl.includes("1. 本机 nmap") && tl.includes("已装可代替工具") && tl.includes("询问用户是否安装") && tl.includes("6. 不批准则脚本编写") && tl.split("\n").length === 7);
expect("三工具 def 阶梯齐备", ["nmap", "subfinder", "whatweb"].every((k) => TOOL_DEFS[k].tiers.length === 6 && TOOL_DEFS[k].tiers[5].includes("脚本")));

// ── 输出治理：预览封顶 + 全文落盘 ──
const short = governPreview("x".repeat(100));
expect("短输出原样不截断", !short.truncated && short.preview.length === 100);
const long = governPreview("y".repeat(12000));
expect("长输出封顶（头尾+省略量+总字节）", long.truncated && long.preview.includes("中间省略") && long.bytes === 12000 && long.preview.length < 7000);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scan-gov-"));
const rel = spillOutput(fs, tmp, "nmap", "hello");
expect("全文落盘+相对路径回读指针", fs.readFileSync(path.join(tmp, rel), "utf8") === "hello" && rel.startsWith("artifacts/tool-output/"));

// ── 熔断 ──
const t0 = 1_000_000;
breakerRecord("bt", false, t0);
breakerRecord("bt", false, t0 + 1);
expect("两次失败未熔断", breakerCheck("bt", t0 + 2) === 0);
breakerRecord("bt", false, t0 + 2);
expect("三次失败进 60s 冷却", breakerCheck("bt", t0 + 3) > 0 && breakerCheck("bt", t0 + 3) <= 60);
expect("冷却到期放行", breakerCheck("bt", t0 + 61_000) === 0);
breakerRecord("bt", true, t0 + 4);
expect("成功清零计数", breakerCheck("bt", t0 + 5) === 0);

// ── runGoverned 守卫与阶梯（不触真实二进制）──
const g = await runGoverned({ def: TOOL_DEFS.nmap, params: { target: "10.99.99.99", workspace: F }, workspace: F });
expect("nmap 防盲打：未登记目标拒绝（spawn 前）", !g.ok && g.error.includes("防盲打"));
const g2 = await runGoverned({ def: { ...TOOL_DEFS.nmap, bin: "definitely-missing-bin-xyz" }, params: { target: "127.0.0.1", workspace: F }, workspace: F });
expect("缺二进制返回六节点阶梯提示（绝不自动安装）", !g2.ok && g2.error.includes("绝不自动安装") && g2.error.includes("脚本"));

// ── 扩面七工具：默认参/护栏/开关/守卫 ──
expect("十三工具 def 齐备且各带六节点阶梯", ["katana", "afrog", "fscan", "nmap", "masscan", "subfinder", "gau", "whatweb", "wafw00f", "dirsearch", "sqlmap", "nikto", "hydra"].every((k) => TOOL_DEFS[k].tiers.length === 6 && !!TOOL_DEFS[k].name && !!TOOL_DEFS[k].bin));
b = buildArgs(TOOL_DEFS.masscan, { target: "10.0.0.0/24", ports: "80,443" });
expect("masscan 默认 --rate 1000 + ports 必填入参", b.argv.join(" ").includes("--rate 1000") && b.argv.includes("-p") && b.argv.includes("80,443"));
threw = false;
try { buildArgs(TOOL_DEFS.masscan, { target: "x" }); } catch { threw = true; }
expect("masscan 缺 ports 拒绝", threw);
threw = false;
try { buildArgs(TOOL_DEFS.masscan, { target: "x", ports: "80", rate: 99999 }); } catch { threw = true; }
expect("masscan rate 硬上限 5000", threw);
b = buildArgs(TOOL_DEFS.sqlmap, { url: "http://a/?id=1" });
expect("sqlmap 保守默认（--batch level1 risk1 threads1）", b.argv.join(" ") === "--batch --level 1 --risk 1 --threads 1 -u http://a/?id=1");
b = buildArgs(TOOL_DEFS.sqlmap, { url: "http://a/?id=1", dbs: true, banner: true, risk: 2 });
expect("sqlmap 布尔开关入参 + risk 显式留痕", b.argv.includes("--dbs") && b.argv.includes("--banner") && b.audit.some((x) => x.includes("--risk 2")));
expect("sqlmap 危险开关不在白名单（--dump/--os-shell 仅经 extra 留痕）", !Object.values(TOOL_DEFS.sqlmap.args.switches).some((f) => /dump|os-shell|sql-shell/.test(f)));
b = buildArgs(TOOL_DEFS.hydra, { target: "10.0.0.5 ssh", passFile: "/tmp/p.txt" });
expect("hydra -f 首中即停 + -t 4 默认 + 组合位置参数在尾", b.argv.join(" ").includes("-f") && b.argv.join(" ").includes("-t 4") && b.argv[b.argv.length - 1] === "10.0.0.5 ssh");
b = buildArgs(TOOL_DEFS.dirsearch, { url: "http://a" });
expect("dirsearch -t 10 默认 + -u 入参", b.argv.join(" ").includes("-t 10") && b.argv.includes("-u"));
const guardIds = Object.values(TOOL_DEFS).filter((d) => d.guard.active).map((d) => d.id);
expect("主动扫描六件套防盲打；被动三件免登记", ["nmap", "masscan", "dirsearch", "sqlmap", "nikto", "hydra"].every((k) => guardIds.includes(k)) && !guardIds.includes("subfinder") && !guardIds.includes("gau") && !guardIds.includes("wafw00f"));
const g3 = await runGoverned({ def: TOOL_DEFS.dirsearch, params: { url: "http://10.99.99.99", workspace: F }, workspace: F });
expect("dirsearch targetParam=url 防盲打拒绝", !g3.ok && g3.error.includes("防盲打"));
const g4 = await runGoverned({ def: TOOL_DEFS.sqlmap, params: { url: "http://10.99.99.99/?id=1", workspace: F }, workspace: F });
expect("sqlmap targetParam=url 防盲打拒绝", !g4.ok && g4.error.includes("防盲打"));

// ── 攻防三件套：impacket / netexec / crackmapexec ──
expect("十六工具 def 齐备（含 katana/afrog/fscan 与攻防三件套）", ["katana", "afrog", "fscan", "impacket", "netexec", "crackmapexec"].every((k) => TOOL_DEFS[k].tiers.length === 6 && !!TOOL_DEFS[k].name));
expect("impacket 双安装名候选（{module} 占位）", JSON.stringify(TOOL_DEFS.impacket.bins) === JSON.stringify(["impacket-{module}", "{module}.py"]));
expect("netexec/crackmapexec 双别名候选", JSON.stringify(TOOL_DEFS.netexec.bins) === JSON.stringify(["netexec", "nxc"]) && JSON.stringify(TOOL_DEFS.crackmapexec.bins) === JSON.stringify(["crackmapexec", "cme"]));
expect("netexec 与 crackmapexec 互为替代（阶梯第 3 级）", TOOL_DEFS.netexec.tiers[2].includes("crackmapexec") && TOOL_DEFS.crackmapexec.tiers[2].includes("netexec"));
b = buildArgs(TOOL_DEFS.netexec, { protocol: "smb", target: "10.0.0.0/24", user: "a", passPol: true, threads: 30 });
expect("netexec 协议打头+目标在尾+开关+threads 留痕", b.argv[0] === "smb" && b.argv[b.argv.length - 1] === "10.0.0.0/24" && b.argv.includes("--pass-pol") && b.argv.includes("-t") && b.audit.some((x) => x.includes("-t 30")));
b = buildArgs(TOOL_DEFS.crackmapexec, { protocol: "winrm", target: "10.0.0.5", hashes: ":abc123" });
expect("crackmapexec 同语法（--hashes 入参）", b.argv[0] === "winrm" && b.argv.includes("--hashes") && b.argv.includes(":abc123"));
threw = false;
try { buildArgs(TOOL_DEFS.netexec, { target: "10.0.0.5" }); } catch { threw = true; }
expect("netexec 缺 protocol 拒绝", threw);
b = buildArgs(TOOL_DEFS.impacket, { module: "secretsdump", target: "DOM/a@10.0.0.5", hashes: ":nt" });
expect("impacket 模块参数+hashes 入参", b.argv.includes("-hashes") && b.argv[b.argv.length - 1] === "DOM/a@10.0.0.5" && !b.argv.includes("secretsdump"));
const guardIds2 = Object.values(TOOL_DEFS).filter((d) => d.guard.active).map((d) => d.id);
expect("攻防三件套全部防盲打须登记", ["impacket", "netexec", "crackmapexec"].every((k) => guardIds2.includes(k)));
const g5 = await runGoverned({ def: TOOL_DEFS.netexec, params: { protocol: "smb", target: "10.99.99.0/24", workspace: F }, workspace: F });
expect("netexec 防盲打：未登记网段拒绝（spawn 前）", !g5.ok && g5.error.includes("防盲打"));
const g6 = await runGoverned({ def: TOOL_DEFS.impacket, params: { module: "secretsdump", target: "x@10.99.99.99", workspace: F }, workspace: F });
expect("impacket 防盲打：未登记目标拒绝", !g6.ok && g6.error.includes("防盲打"));

// ── 可选工具面：能力强覆盖，但未安装时零 schema 成本 ──
const optionalIds = ["prowler", "trivy", "checkov", "kube-hunter", "arjun", "dalfox", "volatility3", "binwalk"];
expect("八个可选方向 def 齐备（云原生/API/DFIR）", optionalIds.every((id) => TOOL_DEFS[id]?.optional === true && TOOL_DEFS[id].tiers.length === 6));
expect("未安装时可选工具不注册", registerableDefs(TOOL_DEFS, () => false).every((d) => !d.optional));
expect("安装后可选工具自动进入注册面", optionalIds.every((id) => registerableDefs(TOOL_DEFS, (bin) => bin === TOOL_DEFS[id].bin).some((d) => d.id === id)));
b = buildArgs(TOOL_DEFS.trivy, { scan_type: "fs", target: "deps" });
expect("trivy 子命令在目标前且默认只读 JSON", b.argv[0] === "fs" && b.argv.includes("--format") && b.argv.includes("json") && b.argv[b.argv.length - 1] === "deps");
b = buildArgs(TOOL_DEFS["kube-hunter"], { target: "10.0.0.5" });
expect("kube-hunter 远程目标参数与 JSON 报告", b.argv.includes("--remote") && b.argv.includes("10.0.0.5") && b.argv.includes("--report") && b.argv.includes("json"));
b = buildArgs(TOOL_DEFS.binwalk, { file: "firmware.bin" });
expect("binwalk 默认只识别、不自动提取", b.argv.includes("--term") && b.argv[b.argv.length - 1] === "firmware.bin" && !b.argv.includes("-e"));

// ── 二进制探测：PATH 直扫、绝对路径、Windows 缺 PATHEXT ──
{
	const savedPathext = process.env.PATHEXT;
	delete process.env.PATHEXT;
	expect("hasBin：PATH 中的 node 可命中（Windows 无 PATHEXT 也成立）", hasBin("node") === true);
	expect("hasBin：绝对路径可命中", hasBin(process.execPath) === true);
	expect("hasBin：不存在的工具返回 false", hasBin("definitely-missing-bin-xyz") === false);
	if (savedPathext === undefined) delete process.env.PATHEXT;
	else process.env.PATHEXT = savedPathext;
}

// ── sec-config 配置路径直连执行：设置页配置的工具不得再要求用户改 PATH ──
{
	const configured = { nmap: process.execPath };
	const paths = configuredToolPaths({ entries: [{ key: "nmap", path: process.execPath }] });
	expect("sec-config entries 解析为实际路径映射", paths.nmap === process.execPath);
	expect("配置的绝对可执行文件优先于 PATH", resolveToolBin("definitely-not-on-path", process.execPath) === process.execPath);
	const wrong = await runGoverned({
		def: { ...TOOL_DEFS.nmap, bin: "definitely-not-on-path" },
		params: { target: "127.0.0.1" },
		workspace: F,
		configured: { "definitely-not-on-path": path.join(F, "missing-tool.exe") },
	});
	expect("配置路径失效时仍给可操作提示", !wrong.ok && wrong.error.includes("已配置路径不可执行"));

	const nodeDef = {
		id: "configured-node",
		bin: "configured-node",
		name: "configured_node",
		kind: "test",
		summary: "test",
		positional: null,
		params: {},
		tiers: ["test"],
		args: { flags: {}, combined: {}, switches: {} },
		defaults: ["-e", "console.log('CONFIGURED_OK')"],
		limits: { timeoutMs: 10_000, previewChars: 6000 },
		guard: { active: false },
	};
	const runWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "scan-exec-"));
	const direct = await runGoverned({
		def: nodeDef,
		params: {},
		workspace: runWorkspace,
		configured: { "configured-node": process.execPath },
	});
	expect("配置的绝对路径无需 PATH 即可真实执行", direct.ok && direct.preview.includes("CONFIGURED_OK"), direct.error ?? "");

	const suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-suite-"));
	const entry = path.join(suiteDir, "CheckLDAPStatus.py");
	const sibling = path.join(suiteDir, "secretsdump.py");
	fs.writeFileSync(entry, "print('entry')\n");
	fs.writeFileSync(sibling, "print('sibling')\n");
	const suiteInvocation = resolveToolInvocation("secretsdump.py", entry, {
		acceptAnyFile: false,
		configured: { python: process.execPath },
	});
	expect("多入口套件不会被配置入口文件冒充（impacket 同目录候选优先）",
		suiteInvocation?.file === sibling && suiteInvocation.prefix.includes(sibling));
	const pyInvocation = resolveToolInvocation("py-tool", entry, { configured: { python: process.execPath } });
	expect("Python 脚本自动通过解释器启动，不把 .py 当本机二进制",
		pyInvocation !== null && pyInvocation.file === entry && pyInvocation.prefix.includes(entry) && pyInvocation.bin !== entry);
	const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-root-"));
	const nested = path.join(rootDir, "05-内网与域渗透", "4-横向移动与远程执行", "impacket", "examples");
	fs.mkdirSync(nested, { recursive: true });
	const nestedSecretsdump = path.join(nested, "secretsdump.py");
	fs.writeFileSync(nestedSecretsdump, "print('nested')\n");
	const rootInvocation = resolveToolInvocation("secretsdump.py", path.join(rootDir, "moved", "CheckLDAPStatus.py"), {
		acceptAnyFile: false,
		configured: { python: process.execPath },
		roots: [rootDir],
	});
	expect("配置入口失效时从工具根目录找回正确套件脚本",
		rootInvocation?.file === nestedSecretsdump && rootInvocation.prefix.includes(nestedSecretsdump));
	const asyncWs = fs.mkdtempSync(path.join(os.tmpdir(), "scan-async-"));
	const ffufOut = path.join(asyncWs, "ffuf.json");
	fs.writeFileSync(ffufOut, JSON.stringify({ results: [
		{ status: 200, length: 45, url: "http://127.0.0.1/health" },
		{ status: 403, length: 68, url: "http://127.0.0.1/admin" },
	] }));
	const ffufParsed = ffufParse("", { status: 0, outFile: ffufOut });
	expect("ffuf 命中从 -o JSON 回传到模型输出", ffufParsed.__hits.length === 2 && ffufParsed.__summaryText.includes("/health") && ffufParsed.__summaryText.includes("403"), ffufParsed.__summaryText);
	let timerTicked = false;
	const timer = setTimeout(() => { timerTicked = true; }, 20);
	const asyncRun = await runScan({
		bin: "node",
		args: ["-e", "setTimeout(() => process.stdout.write('ASYNC_OK'), 120)", "--"],
		workspace: asyncWs,
		tool: "ffuf",
		rate: undefined,
		defaultRate: 1,
		active: false,
		target: "http://127.0.0.1/",
		parse: (raw) => ({ __summaryText: raw }),
	});
	clearTimeout(timer);
	expect("长扫描不阻塞宿主事件循环（同步 spawn 会冻结 UI）", asyncRun.ok && timerTicked && asyncRun.stdout.includes("ASYNC_OK"), asyncRun.error ?? "");
	fs.rmSync(suiteDir, { recursive: true, force: true });
	fs.rmSync(rootDir, { recursive: true, force: true });
	fs.rmSync(runWorkspace, { recursive: true, force: true });
	fs.rmSync(asyncWs, { recursive: true, force: true });
}

// ── 证据台账并发：多进程同时收尾不得丢行或复用编号 ──
{
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), "scan-ledger-"));
	fs.mkdirSync(path.join(ws, "artifacts", "scans"), { recursive: true });
	const child = path.join(F, "..", "_child-ledger.mjs");
	const runs = Array.from({ length: 8 }, () => spawnSync(process.execPath, ["--import", "../../scripts/test-stub-register.mjs", child, ws], {
		cwd: path.join(F, "..", ".."), encoding: "utf8",
	}));
	expect("并发子进程全部成功", runs.every((r) => r.status === 0), runs.map((r) => r.stderr).join("\n"));
	const ids = runs.map((r) => r.stdout.trim()).filter(Boolean);
	expect("并发收尾生成 8 个唯一证据编号", new Set(ids).size === 8 && ids.every((id) => /^E\d+$/.test(id)), ids.join(","));
	const evidence = fs.readFileSync(path.join(ws, "evidence-index.md"), "utf8");
	const reconcile = fs.readFileSync(path.join(ws, "scan-reconcile.md"), "utf8");
	expect("并发收尾证据行一条不丢", (evidence.match(/\| E\d+ \|/g) || []).length === 8);
	expect("并发收尾对账行一条不丢", (reconcile.match(/\| concurrency \|/g) || []).length === 8);
	fs.rmSync(ws, { recursive: true, force: true });
}

// ── 同秒并发不覆盖产物（2026-09-13 夜：秒级时间戳曾在同一秒内互相覆盖）──
// 背景：落盘名原为 `<tool>-YYYYMMDDHHmmss.txt`（精确到秒）。多路 Solver 并行、
// 或同一轮里连发两个扫描时，**同一秒的两次调用会撞同名 → 后者静默覆盖前者**，
// 证据原件丢失且日志无异常。改为「毫秒 + 4 位随机后缀」后不应再撞。
{
	const t = fs.mkdtempSync(path.join(os.tmpdir(), "scan-stamp-"));
	const seen = new Set();
	for (let i = 0; i < 200; i++) {
		const rel = spillOutput(fs, t, "nmap", "payload-" + i);
		if (seen.has(rel)) { expect(`第 ${i} 次落盘撞名`, false, rel); break; }
		seen.add(rel);
	}
	expect("同秒内 200 次落盘全部唯一（不互相覆盖）", seen.size === 200);

	// 内容仍可逐一读回（证明没有被覆盖成最后一份）
	const dir = path.join(t, "artifacts", "tool-output");
	const files = fs.readdirSync(dir);
	expect("200 个产物文件都真实存在", files.length === 200);
	const contents = new Set(files.map((f) => fs.readFileSync(path.join(dir, f), "utf8")));
	expect("每个文件内容各不相同（无覆盖残留）", contents.size === 200);
	fs.rmSync(t, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
