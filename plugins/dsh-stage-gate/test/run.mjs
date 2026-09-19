// Standalone tests for dsh-stage-gate pure validators (no DSH runtime needed).
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { runGate, listGates, tableRows, setGoal, updateProgress, setScope, markTested, coverageCheck, syncOperationState, registerIntent, intentSummary, taskTransition, validateAnchor, setConstraints, constraintSummary, deriveScopeDraft, DECOMPOSITION, conclusionVerdict, apply, isSubagentTool, summarizeToolResult, subagentOwnerAlias, startSubagentTask, finishSubagentTask, taskToolAliases, readOperationState as ros } from "../lib/index.js";
import { projectSnapshot } from "../lib/project-snapshot.mjs";
import { CSRF_TOKEN, ROUTE_PATH, checkCsrf, dispatchProject, isTrustedRequest } from "../lib/project-channel.mjs";

const F = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "fixture");
let failed = 0;
function expect(name, cond, detail) {
	if (cond) console.log(`ok   ${name}`);
	else { failed++; console.log(`FAIL ${name} ${detail ?? ""}`); }
}

// tableRows: separator excluded, cells counted
const t = tableRows("| a | b |\n|---|---|\n| c |  |\nplain");
expect("tableRows counts 2 rows", t.length === 2, JSON.stringify(t));
expect("tableRows counts non-empty cells", t[1].nonEmpty === 1, JSON.stringify(t));

// 表格门失败信息必须自带可执行修法：列数要求 + 行号 + 实际格数
// （回归背景：ctf-solver/board 只报「未填满行」，模型被迫去翻 node_modules 源码反推需求）
{
	const tmp = fs.mkdtempSync(path.join(path.dirname(F), "tbl-msg-"));
	fs.writeFileSync(path.join(tmp, "challenge-board.md"), "| 题名 | 内容 |\n|---|---|\n| warmup | base64 编码 |\n");
	fs.writeFileSync(path.join(tmp, "evidence-index.md"), "## tool-plane\nMCP\n\n| 平面 | 结果 |\n|---|---|\n| CLI | ok |\n");
	const v = runGate(fs, { mode: "ctf-solver", stage: "board", workspace: tmp });
	const detail = v.missing.join(" | ");
	expect("table detail states the per-row cell requirement", detail.includes("每行 ≥3 个非空单元格"), detail);
	expect("table detail names the short rows with counts", detail.includes("L1(2格)") && detail.includes("L3(2格)"), detail);
	expect("table detail flags all-short case", detail.includes("全部行不达标"), detail);
	// 达标时不再报失败
	fs.writeFileSync(path.join(tmp, "challenge-board.md"), "| 题名 | 模块 | 线索 |\n|---|---|---|\n| warmup | web | base64 |\n");
	const ok = runGate(fs, { mode: "ctf-solver", stage: "board", workspace: tmp });
	expect("table detail passes when every row has enough cells", ok.pass === true, JSON.stringify(ok.missing));
	// 完全没表格时给出可照抄的样式
	fs.writeFileSync(path.join(tmp, "challenge-board.md"), "无表格正文\n");
	const noTable = runGate(fs, { mode: "ctf-solver", stage: "board", workspace: tmp });
	const noTableDetail = noTable.missing.join(" | ");
	expect("table detail shows a copyable row shape when no table found", noTableDetail.includes("以 | 开头"), noTableDetail);
	fs.rmSync(tmp, { recursive: true, force: true });
}

// pentest P1 pass
let v = runGate(fs, { mode: "pentest", stage: "P1", workspace: F });
expect("pentest/P1 pass", v.pass === true, JSON.stringify(v.missing));

// pentest P1 fail on empty workspace
v = runGate(fs, { mode: "pentest", stage: "P1", workspace: path.join(F, "nowhere") });
expect("pentest/P1 fails on missing workspace", v.pass === false);

// pentest P1 fail when evidence-index lacks tool-plane/MCP markers
{
	const tmp = fs.mkdtempSync(path.join(path.dirname(F), "p1-nomcp-"));
	for (const name of fs.readdirSync(F)) {
		if (fs.statSync(path.join(F, name)).isFile()) fs.copyFileSync(path.join(F, name), path.join(tmp, name));
	}
	const ev = path.join(tmp, "evidence-index.md");
	fs.writeFileSync(ev, fs.readFileSync(ev, "utf8").replace(/## tool-plane[\s\S]*$/, ""));
	v = runGate(fs, { mode: "pentest", stage: "P1", workspace: tmp });
	expect("pentest/P1 fails without tool-plane/MCP markers", v.pass === false);
	v = runGate(fs, { mode: "attack-defense", stage: "recon", workspace: tmp });
	expect("ad/recon fails without tool-plane/MCP markers", v.pass === false);
	v = runGate(fs, { mode: "code-audit", stage: "A1", workspace: tmp });
	expect("audit/A1 fails without tool-plane/MCP markers", v.pass === false);
	for (const [mode, stage] of [["incident-response", "I1"], ["cloud-security", "C1"], ["binary-analysis", "B0"], ["ctf-solver", "board"]]) {
		v = runGate(fs, { mode, stage, workspace: tmp });
		expect(`${mode}/${stage} fails without tool-plane/MCP markers`, v.pass === false);
	}
	fs.rmSync(tmp, { recursive: true, force: true });
}

// pentest P2 requires file
let threw = false;
try { runGate(fs, { mode: "pentest", stage: "P2", workspace: F }); } catch { threw = true; }
expect("P2 without file throws", threw);

// pentest P2 markers check against a report file
const report = path.join(F, "report-tmp.md");
fs.writeFileSync(report, "# 测试过程\n基线…差分…marker…复核记录…\n");
v = runGate(fs, { mode: "pentest", stage: "P2", workspace: F, file: report });
expect("P2 pass with markers file", v.pass === true, JSON.stringify(v.missing));
expect("P2 lists manual items", v.manual.length >= 1);

// P2 relative file resolves against the workspace (baseline-self-test)
const relReport = path.join(F, "reports", "rel-report.md");
fs.mkdirSync(path.join(F, "reports"), { recursive: true });
fs.writeFileSync(relReport, "# 测试过程\n基线…差分…marker…复核…\n");
v = runGate(fs, { mode: "pentest", stage: "P2", workspace: F, file: "reports/rel-report.md" });
expect("P2 relative file resolves against workspace", v.pass === true, JSON.stringify(v.missing));
fs.rmSync(relReport, { force: true });

// pentest P3 pass (3 rows, 3 cells + 复核汇总账)
v = runGate(fs, { mode: "pentest", stage: "P3", workspace: F });
expect("pentest/P3 pass", v.pass === true, JSON.stringify(v.missing));

// pentest P3 缺复核汇总账 = 不过（报告门双签前置）
{
	const ws2 = fs.mkdtempSync(path.join(os.tmpdir(), "p3-no-review-"));
	for (const name of fs.readdirSync(F)) {
		if (fs.statSync(path.join(F, name)).isFile() && name !== "review-log.md") fs.copyFileSync(path.join(F, name), path.join(ws2, name));
	}
	const v2 = runGate(fs, { mode: "pentest", stage: "P3", workspace: ws2 });
	expect("P3 missing review-log fails", v2.pass === false && v2.missing.some((m) => m.includes("review-log")), JSON.stringify(v2.missing));
	fs.rmSync(ws2, { recursive: true, force: true });
}

// code-audit A1 fail (no surface-map.md)
v = runGate(fs, { mode: "code-audit", stage: "A1", workspace: F });
expect("audit/A1 fails without surface-map", v.pass === false);

// binary B0 provenance pass
v = runGate(fs, { mode: "binary-analysis", stage: "B0", workspace: F });
expect("binary/B0 provenance pass", v.pass === true, JSON.stringify(v.missing));

// binary B1 requires file + markers + hex
const verify = path.join(F, "unpack-verify-tmp.md");
fs.writeFileSync(verify, "# 三验\ndex 校验通过；IAT 重建有效；可运行性 OK\n产物 sha256: a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2\n");
v = runGate(fs, { mode: "binary-analysis", stage: "B1", workspace: F, file: verify });
expect("binary/B1 pass", v.pass === true, JSON.stringify(v.missing));

// attack-defense persistence fail (no registry)
v = runGate(fs, { mode: "attack-defense", stage: "persistence", workspace: F });
expect("ad/persistence fails without registry", v.pass === false);

// attack-defense report: 操作痕迹台账门禁（缺→不过；全→过）
const adws = fs.mkdtempSync(path.join(path.dirname(F), "ad-report-"));
const adreport = path.join(adws, "report.md");
fs.writeFileSync(adreport, "# 报告\n漏洞名称…ATT&CK…detection gap…持久化清单…路径台账…阶段终态…\n");
v = runGate(fs, { mode: "attack-defense", stage: "report", workspace: adws, file: adreport });
expect("ad/report fails without op-traces", v.pass === false);
fs.writeFileSync(path.join(adws, "op-traces.md"), "# 操作痕迹台账\n| 时间 | shell 地址 | ssh 密钥 | 创建的用户 | 位置 |\n|---|---|---|---|---|\n| 2026-01-01 | 无 | 无 | 无 | 无 |\n");
v = runGate(fs, { mode: "attack-defense", stage: "report", workspace: adws, file: adreport });
expect("ad/report passes with op-traces", v.pass === true, JSON.stringify(v.missing));
fs.rmSync(adws, { recursive: true, force: true });

// av V1 fail (no plan)
v = runGate(fs, { mode: "av-evasion", stage: "V1", workspace: F });
expect("av/V1 fails without plan", v.pass === false);

// av V1 pass with the three declarations (攻击视角重订口径)
const plan = path.join(F, "experiment-plan-tmp.md");
fs.writeFileSync(plan, "# 实验计划\n测试环境：本地默认（授权目标按任务）。\n产物去向：实验室目录或任务工作区。\n持久化预案：不涉及；涉及则登记 persistence-registry（含手动排除步骤）。\n");
v = runGate(fs, { mode: "av-evasion", stage: "V1", workspace: F, file: path.join(F, "experiment-plan.md") });
expect("av/V1 fails while plan only exists under another name", v.pass === false);
fs.copyFileSync(plan, path.join(F, "experiment-plan.md"));
v = runGate(fs, { mode: "av-evasion", stage: "V1", workspace: F });
expect("av/V1 pass with new-declaration markers", v.pass === true, JSON.stringify(v.missing));
expect("av/V1 manual carries registry-system wording", v.manual.length >= 1 && v.manual[0].includes("登记制"));
fs.rmSync(plan, { force: true });
fs.rmSync(path.join(F, "experiment-plan.md"), { force: true });

// incident-response I1 fail (no evidence-preservation.md)
v = runGate(fs, { mode: "incident-response", stage: "I1", workspace: F });
expect("ir/I1 fails without preservation list", v.pass === false);

// incident-response I2 pass with a timeline table (3 rows, 4 cells, required markers)
const timeline = path.join(F, "attack-timeline-tmp.md");
fs.writeFileSync(timeline, "| 时间节点 | 可疑IP | 事件 | 证据 |\n|---|---|---|---|\n| 2026-08-01 02:11 | 203.0.113.5 | SSH 爆破成功登录 | E1 |\n| 2026-08-01 02:17 | 203.0.113.5 | 恶意样本落盘 /tmp/.x | E2 |\n| 2026-08-01 02:20 | 203.0.113.5 | crontab 持久化 | E3 |\n");
fs.copyFileSync(timeline, path.join(F, "attack-timeline.md"));
v = runGate(fs, { mode: "incident-response", stage: "I2", workspace: F });
expect("ir/I2 pass with timeline table", v.pass === true, JSON.stringify(v.missing));
fs.rmSync(timeline, { force: true });
fs.rmSync(path.join(F, "attack-timeline.md"), { force: true });

// incident-response I5 requires file
threw = false;
try { runGate(fs, { mode: "incident-response", stage: "I5", workspace: F }); } catch { threw = true; }
expect("ir/I5 without file throws", threw);

// cloud-security C1 fail (no cloud-assets.md)
v = runGate(fs, { mode: "cloud-security", stage: "C1", workspace: F });
expect("cloud/C1 fails without cloud-assets.md", v.pass === false);

// cloud-security C2 pass with an attack-paths table (1 row, 6 cells, required markers)
const paths = path.join(F, "attack-paths-tmp.md");
fs.writeFileSync(paths, "| 入口 | 身份 | 权限 | 资源 | 影响 | 证据 |\n|---|---|---|---|---|---|\n| 泄露的 AK/SK | 阿里云 RAM 用户 | AdministratorAccess | OSS 桶 prod-backup | 列出并下载全部对象 | E1 |\n");
fs.copyFileSync(paths, path.join(F, "attack-paths.md"));
v = runGate(fs, { mode: "cloud-security", stage: "C2", workspace: F });
expect("cloud/C2 pass with attack-paths table", v.pass === true, JSON.stringify(v.missing));
fs.rmSync(paths, { force: true });
fs.rmSync(path.join(F, "attack-paths.md"), { force: true });

// cloud-security C7 requires file
threw = false;
try { runGate(fs, { mode: "cloud-security", stage: "C7", workspace: F }); } catch { threw = true; }
expect("cloud/C7 without file throws", threw);

// ctf-solver board fail (no challenge-board.md)
v = runGate(fs, { mode: "ctf-solver", stage: "board", workspace: F });
expect("ctf/board fails without challenge-board.md", v.pass === false);

// ctf-solver flag pass with a ledger table (1 row, 4 cells, required markers)
const ledger = path.join(F, "flag-ledger-tmp.md");
fs.writeFileSync(ledger, "| 题名 | 模块 | flag | 验证证据 | 状态 |\n|---|---|---|---|---|\n| warmup | web | flag{test} | 平台回显 Accepted | 已解 |\n");
fs.copyFileSync(ledger, path.join(F, "flag-ledger.md"));
v = runGate(fs, { mode: "ctf-solver", stage: "flag", workspace: F });
expect("ctf/flag pass with ledger table", v.pass === true, JSON.stringify(v.missing));
fs.rmSync(ledger, { force: true });
fs.rmSync(path.join(F, "flag-ledger.md"), { force: true });

// unknown gate throws with valid list
threw = false;
try { runGate(fs, { mode: "pentest", stage: "P9", workspace: F }); } catch (e) { threw = e.message.includes("P1"); }
expect("unknown gate throws listing valid stages", threw);

// gates_list covers eight gated modes
const list = listGates();
expect("gates_list covers 8 modes", Object.keys(list).length === 8);
expect("gates_list single mode", Object.keys(listGates("pentest")).length === 1);

// cleanup tmp files (gate-log handled below)
fs.rmSync(report, { force: true });
fs.rmSync(verify, { force: true });
fs.rmSync(path.join(F, "gate-log.md"), { force: true });

// ── operation-state：目标契约 / 进度收口 / 门禁自动同步 ──────────────────────
import os from "node:os";
{
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opstate-"));
	const ws = path.join(tmp, "ws");
	// 登记：准则解析与 id 分配
	let st = setGoal(ws, "对 demo 靶站完成授权渗透并出报告", "P1 基线资产登记完成\nSQL 注入拿到 whoami 证据\n覆盖矩阵每格有终态");
	const parsed = ros(fs, ws);
	expect("operation_goal writes criteria with ids", parsed.criteria.length === 3 && parsed.criteria[0].id === "g1" && parsed.criteria.every((c) => c.status === "open"), JSON.stringify(parsed.criteria));
	expect("operation_goal keeps goal text", parsed.goal === "对 demo 靶站完成授权渗透并出报告");
	// 校验失败路径
	let threw = false;
	try { setGoal(path.join(tmp, "ws2"), "", "x"); } catch { threw = true; }
	expect("operation_goal rejects empty goal", threw);
	threw = false;
	try { setGoal(path.join(tmp, "ws3"), "g", "  \n"); } catch { threw = true; }
	expect("operation_goal rejects empty criteria", threw);
	// 进度：met/unknown/all-met
	let s = updateProgress(ws, { met: "g1 g2" });
	expect("operation_progress met two", s.met === 2 && s.open === 1 && s.openIds.join() === "g3", JSON.stringify(s));
	threw = false;
	try { updateProgress(ws, { met: "g9" }); } catch { threw = true; }
	expect("operation_progress rejects unknown id", threw);
	s = updateProgress(ws, { met: "g3", pending: "复测 g2\n导出报告" });
	expect("operation_progress all-met verdict", s.verdict === "all-met" && s.pending.length === 2, JSON.stringify(s));
	s = updateProgress(ws, { failed: "g3" });
	expect("operation_progress failed is closed and counted separately", s.verdict === "all-met" && s.open === 0 && s.failed === 1 && s.met === 2, JSON.stringify(s));
	// 门禁自动同步：无契约时落骨架，已有契约保留 criteria
	syncOperationState(ws, { mode: "pentest", stage: "P1", pass: true });
	st = ros(fs, ws);
	expect("stage_gate sync records gate without touching criteria", st.gates.P1.pass === true && st.criteria.length === 3 && st.goal.length > 0, JSON.stringify({ g: st.gates, c: st.criteria.length }));
	const ws4 = path.join(tmp, "ws4");
	syncOperationState(ws4, { mode: "pentest", stage: "P1", pass: false });
	const skel = ros(fs, ws4);
	expect("stage_gate sync creates skeleton state", skel !== null && Array.isArray(skel.criteria) && skel.criteria.length === 0 && skel.gates.P1.pass === false);
	fs.rmSync(tmp, { recursive: true, force: true });
}

// ── 覆盖度台账（v1.1.0）：scope 登记 / tested 标记 / 报告门算术对账 ─────────────
{
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scope-"));
	const ws = path.join(tmp, "ws");
	fs.mkdirSync(ws, { recursive: true });
	setGoal(ws, "目标", "g1 准则");
	// scope 登记：自动 id / 显式 id / 重复 id 拒绝 / 先登记契约才可 scope
	let s = setScope(ws, "10.0.0.5 Web 前台\nweb-api: API 网关\ndb: 数据库面");
	const parsed = ros(fs, ws);
	expect("operation_scope auto+explicit ids", parsed.scope.length === 3 && parsed.scope[0].id === "s1" && parsed.scope[1].id === "web-api" && parsed.scope[2].id === "db", JSON.stringify(parsed.scope));
	expect("operation_scope summary starts untested", s.scope === 3 && s.tested === 0 && s.untested === 3);
	let threw = false;
	try { setScope(ws, "a: x\na: y"); } catch { threw = true; }
	expect("operation_scope rejects duplicate ids", threw);
	threw = false;
	try { setScope(path.join(tmp, "bare"), "x"); } catch { threw = true; }
	expect("operation_scope requires prior operation_goal", threw);
	// tested 标记：evidence 必填 / 未知 id 拒 / 幂等刷新 / 越界行剔除
	threw = false;
	try { markTested(ws, "s1", ""); } catch { threw = true; }
	expect("markTested requires evidence", threw);
	threw = false;
	try { markTested(ws, "g1", "ev-1"); } catch { threw = true; }
	expect("markTested rejects non-scope id", threw);
	s = markTested(ws, "s1 web-api", "evidence-index #12 与矩阵行 3");
	expect("markTested counts numerator", s.tested === 2 && s.untestedIds.join() === "db", JSON.stringify(s));
	s = markTested(ws, "s1", "evidence-index #13（刷新）");
	expect("markTested idempotent refresh", s.tested === 2 && ros(fs, ws).tested.find((t) => t.id === "s1").evidence.includes("#13"));
	setScope(ws, "web-api: API 网关");
	expect("re-scope drops out-of-scope tested rows", ros(fs, ws).tested.length === 1 && ros(fs, ws).tested[0].id === "web-api");
	// 对账：scope 未登记 → null（零影响）；scope 重建完整场景
	setScope(ws, "10.0.0.5 Web 前台\nweb-api: API 网关\ndb: 数据库面");
	markTested(ws, "s1 web-api", "evidence-index #12");
	const matrix = path.join(ws, "coverage-matrix.md");
	fs.writeFileSync(matrix, "| 资产 | 终态 |\n|---|---|\n| 10.0.0.5 | RCE |\n| api | 未测 |\n\n覆盖：2/3（db 未测列入未覆盖清单）\n");
	let c = coverageCheck(fs, ws, matrix);
	expect("coverageCheck passes honest partial", c.ok === true && c.detail.includes("2/3"), JSON.stringify(c));
	fs.writeFileSync(matrix, "| 资产 | 终态 |\n|---|---|\n| a | b |\n\n覆盖：3/3\n");
	c = coverageCheck(fs, ws, matrix);
	expect("coverageCheck fails inflated declaration", c.ok === false && c.detail.includes("2 / 共 3"), JSON.stringify(c));
	fs.writeFileSync(matrix, "| 资产 | 终态 |\n|---|---|\n| a | b |\n（无覆盖声明）\n");
	c = coverageCheck(fs, ws, matrix);
	expect("coverageCheck fails missing declaration", c.ok === false && c.detail.includes("须声明"), JSON.stringify(c));
	fs.writeFileSync(matrix, "coverage: 2/3\n");
	c = coverageCheck(fs, ws, matrix);
	expect("coverageCheck accepts english form", c.ok === true);
	c = coverageCheck(fs, ws, path.join(ws, "ghost.md"));
	expect("coverageCheck fails unreadable report", c.ok === false && c.detail.includes("不可读"));
	const bareWs = path.join(tmp, "bare2");
	fs.mkdirSync(bareWs, { recursive: true });
	expect("coverageCheck null without scope", coverageCheck(fs, bareWs, matrix) === null);
	// runGate 集成：报告门（pentest/P3 固定文件 coverage-matrix.md）追加对账检查
	//   构造一个 P3 其余检查全过的最小工作区代价高；此处验证对账行出现在 checks 且能翻 fail
	const gateWs = fs.mkdtempSync(path.join(os.tmpdir(), "p3-"));
	for (const name of fs.readdirSync(F)) {
		if (fs.statSync(path.join(F, name)).isFile()) fs.copyFileSync(path.join(F, name), path.join(gateWs, name));
	}
	setGoal(gateWs, "目标", "g1 准则");
	setScope(gateWs, "10.0.0.5 Web 前台\nweb-api: API 网关\ndb: 数据库面");
	markTested(gateWs, "s1", "evidence-index #1");
	const v3 = runGate(fs, { mode: "pentest", stage: "P3", workspace: gateWs });
	const covRow = v3.checks.find((r) => r.id === "coverage:report");
	expect("P3 gate carries coverage check row", covRow !== undefined && covRow.ok === false && covRow.detail.includes("已测 1") && covRow.detail.includes("须声明"), JSON.stringify(covRow));
	// 非报告门不挂对账
	const v1gate = runGate(fs, { mode: "pentest", stage: "P1", workspace: gateWs });
	expect("non-report gate carries no coverage row", v1gate.checks.every((r) => r.id !== "coverage:report"));
	fs.rmSync(tmp, { recursive: true, force: true });
	fs.rmSync(gateWs, { recursive: true, force: true });
}


// ── 意图台账（v1.2.0）：锚点校验 / 登记 / 收口 / 跨库解析器降级 ─────────────
{
	const tmp = fs.mkdtempSync(path.join(path.dirname(F), "intent-"));
	const ws = tmp;
	setGoal(ws, "目标", "g1 准则");
	setScope(ws, "10.0.0.5 Web 前台\ndb: 数据库面");
	// 锚校验（纯函数）
	expect("boot 豁免通过", validateAnchor(ros(fs, ws), { kind: "boot" }) === "");
	expect("criterion 锚命中", validateAnchor(ros(fs, ws), { kind: "criterion", ref: "g1" }) === "");
	expect("criterion 锚不存在拒", validateAnchor(ros(fs, ws), { kind: "criterion", ref: "g9" }).includes("不存在"));
	expect("scope 锚命中", validateAnchor(ros(fs, ws), { kind: "scope", ref: "db" }) === "");
	expect("非 boot 锚缺 ref 拒", validateAnchor(ros(fs, ws), { kind: "scope" }).includes("必填"));
	expect("anchor_kind 非法拒", validateAnchor(ros(fs, ws), { kind: "magic", ref: "x" }).includes("非法"));
	// finding 锚：解析器注入命中/未命中；无解析器走格式降级
	const resolvers = { findingExists: (sid, id) => id === "pentest-3" };
	expect("finding 锚解析器命中", validateAnchor(null, { kind: "finding", ref: "pentest-3" }, resolvers, "s1", "pentest") === "");
	expect("finding 锚解析器未命中拒", validateAnchor(null, { kind: "finding", ref: "pentest-9" }, resolvers, "s1", "pentest").includes("不存在"));
	expect("finding 锚格式降级通过", validateAnchor(null, { kind: "finding", ref: "audit-12" }) === "");
	expect("finding 锚格式降级拒坏格式", validateAnchor(null, { kind: "finding", ref: "不是id" }).includes("格式"));
	// chain 锚：解析器注入
	const chainResolvers = { chainExists: (sid, mode, id) => id === "n1" };
	expect("chain 锚解析器命中", validateAnchor(null, { kind: "chain", ref: "n1" }, chainResolvers, "s1", "attack-defense") === "");
	expect("chain 锚解析器未命中拒", validateAnchor(null, { kind: "chain", ref: "n9" }, chainResolvers, "s1", "attack-defense").includes("链路节点不存在"));
	// 登记：正常/重复收口编号
	let s = registerIntent(ws, { summary: "追注入点到凭据", anchorKind: "finding", anchorRef: "pentest-3" }, resolvers);
	expect("registerIntent 登记并计数", s.total === 1 && s.open === 1);
	s = registerIntent(ws, { summary: "开局资产盘点", anchorKind: "boot" });
	expect("第二条 boot 登记", s.total === 2 && s.open === 2);
	const st = ros(fs, ws);
	expect("intents 落盘带锚", st.intents[0].anchor.kind === "finding" && st.intents[0].id === "i1");
	let threw = false;
	try { registerIntent(ws, { summary: "坏锚", anchorKind: "criterion", anchorRef: "g9" }); } catch { threw = true; }
	expect("registerIntent 坏锚拒绝", threw);
	threw = false;
	try { registerIntent(ws, { summary: "", anchorKind: "boot" }); } catch { threw = true; }
	expect("registerIntent 空 summary 拒", threw);
	threw = false;
	try { registerIntent(path.join(tmp, "bare-ws"), { summary: "x", anchorKind: "boot" }); } catch { threw = true; }
	expect("registerIntent 无契约拒", threw);
	// 收口：intent_done / blocked 须 note / 未知 id 拒 / 摘要联动
	let p = updateProgress(ws, { intent_done: "i1" });
	expect("intent_done 收口", p.intents.total === 2 && p.intents.open === 1 && p.intents.openIds.join() === "i2");
	threw = false;
	try { updateProgress(ws, { intent_blocked: "i2" }); } catch { threw = true; }
	expect("blocked 无 note 拒", threw);
	p = updateProgress(ws, { intent_blocked: "i2", note: "WAF 全拦+无旁路（证据 ev-7）" });
	expect("blocked 带 note 收口", p.intents.open === 0);
	threw = false;
	try { updateProgress(ws, { intent_done: "i9" }); } catch { threw = true; }
	expect("未知意图 id 拒", threw);
	expect("intentSummary 全收口", intentSummary(ros(fs, ws)).open === 0);

	// 执行层：owner/max_attempts 建 task；start → progress → fail → retry → start → succeed
	registerIntent(ws, { summary: "全端口扫描", anchorKind: "boot", owner: "nmap", maxAttempts: 3 });
	let task = taskTransition(ws, { id: "i3", action: "start" }).task;
	expect("task start 置 running 且 attempts=1", task.state === "running" && task.attempts === 1);
	task = taskTransition(ws, { id: "i3", action: "progress", progress: 40 }).task;
	expect("task progress 落进度", task.progress === 40);
	task = taskTransition(ws, { id: "i3", action: "fail", error: "timeout" }).task;
	expect("task fail 落错误", task.state === "failed" && task.error === "timeout");
	task = taskTransition(ws, { id: "i3", action: "retry" }).task;
	expect("task retry 回 queued 且保留 attempts", task.state === "queued" && task.attempts === 1);
	task = taskTransition(ws, { id: "i3", action: "start" }).task;
	expect("task 第二次 start attempts=2", task.state === "running" && task.attempts === 2);
	task = taskTransition(ws, { id: "i3", action: "succeed", result: "open 22/80", artifacts: ["out/nmap.txt"] }).task;
	expect("task succeed 带结果与产物", task.state === "succeeded" && task.progress === 100 && task.artifacts[0] === "out/nmap.txt");
	threw = false;
	try { taskTransition(ws, { id: "i3", action: "start" }); } catch { threw = true; }
	expect("task 终态不可直接 restart", threw);
	expect("taskSummary 计入终态", intentSummary(ros(fs, ws)).tasks.succeeded >= 1);
	// 过期 heartbeat：下一次状态写入时自动转 interrupted
	registerIntent(ws, { summary: "长时间后台验证", anchorKind: "boot", owner: "worker", maxAttempts: 2 });
	taskTransition(ws, { id: "i4", action: "start" });
	const stale = ros(fs, ws);
	stale.intents.find((i) => i.id === "i4").task.heartbeatAt = "2000-01-01T00:00:00.000Z";
	fs.writeFileSync(path.join(ws, "operation-state.json"), JSON.stringify(stale, null, 2) + "\n");
	updateProgress(ws, { note: "heartbeat recovery probe" });
	expect("过期 running task 自动转 interrupted", ros(fs, ws).intents.find((i) => i.id === "i4").task.state === "interrupted");
	fs.rmSync(tmp, { recursive: true, force: true });
}


// ── 派生器模式分支（v1.4.0）：每模式正例+误伤例 ────────────────────────────
{
	expect("audit 提取文件与路由", JSON.stringify(deriveScopeDraft(["审计 src/app/router.js 与 /api/user 路由"], "code-audit")) === JSON.stringify(["/api/user", "src/app/router.js"]));
	expect("audit 误伤：版本号不提取", deriveScopeDraft(["Spring Boot 3.2.1 与 Node v22.19.0"], "code-audit").length === 0);
	expect("binary 提取哈希与样本名", JSON.stringify(deriveScopeDraft(["样本 d41d8cd98f00b204e9800998ecf8427e 与 backdoor.exe"], "binary-analysis")) === JSON.stringify(["backdoor.exe", "d41d8cd98f00b204e9800998ecf8427e"]));
	expect("binary 误伤：短十六进制串不提取", deriveScopeDraft(["颜色 #ff0000 与 id abc123"], "binary-analysis").length === 0);
	expect("cloud 提取账号/区域/ARN", (() => { const d = deriveScopeDraft(["账号 123456789012 us-east-1", "arn:aws:iam::111122223333:role/svc"], "cloud-security"); return d.includes("account:123456789012") && d.includes("us-east-1") && d.some((x) => x.startsWith("arn:")); })());
	expect("cloud 误伤：普通长数字不单独提取", !deriveScopeDraft(["订单号 12345678901234567 无账号词"], "cloud-security").some((x) => x.startsWith("account:")));
	expect("ad 提取 CIDR 且去裸 IP", JSON.stringify(deriveScopeDraft(["网段 192.168.10.0/24 与 10.0.0.5"], "attack-defense")) === JSON.stringify(["10.0.0.5", "192.168.10.0/24"]));
	expect("av/ctf/redteam 登记制不派生", deriveScopeDraft(["载荷 x 引擎 360", "题 web1", "路由任务"], "av-evasion").length === 0 && deriveScopeDraft(["题 web1"], "ctf-solver").length === 0 && deriveScopeDraft(["任务"], "redteam").length === 0);
	expect("无模式走统一提取器", JSON.stringify(deriveScopeDraft(["对 https://a.example.com 与 1.2.3.4"])) === JSON.stringify(["1.2.3.4", "a.example.com"]));
}

// ── 模式化拆分（v1.4.0）：DECOMPOSITION 映射 + 三工具 render 注入 ──────────
{
	// 映射完整性
	expect("DECOMPOSITION 九模式齐全", Object.keys(DECOMPOSITION).length === 9 && ["pentest", "code-audit", "binary-analysis", "attack-defense", "av-evasion", "incident-response", "cloud-security", "ctf-solver", "redteam"].every((m) => DECOMPOSITION[m]?.theory && DECOMPOSITION[m]?.criteriaGuide));
	expect("每模式五字段完整", Object.values(DECOMPOSITION).every((d) => d.theory && d.criteriaGuide && d.scopeSemantics && d.constraintHints && d.example));
	// 装配层：operation_goal render 按模式注入理论（fake ctx 捕获工具定义）
	const registered = [];
	const fakeCtx = { tools: { register: (tool) => registered.push(tool) }, agentPresets: { composedPreset: (c) => c?.preset } };
	const mod = await import("../lib/index.js");
	mod.apply(fakeCtx, {});
	const goal = registered.find((x) => x?.name === "operation_goal");
	const scope = registered.find((x) => x?.name === "operation_scope");
	const cons = registered.find((x) => x?.name === "operation_constraints");
	const tmp = fs.mkdtempSync(path.join(path.dirname(F), "dec-"));
	const g1 = await goal.execute({ workspace: tmp, goal: "测 https://a.example.com", criteria: "g1 x" }, { agent: { ctx: { preset: "pentest" }, session: { id: "s1", header: {} } } });
	const goalText = goal.output.render(null, g1)[0].text;
	expect("goal render 含 pentest 理论", goalText.includes("pentest 拆分理论") && goalText.includes("作战流程×资产×漏洞类矩阵") && goalText.includes("准则按"));
	const g2 = await goal.execute({ workspace: tmp, goal: "审计 x 服务", criteria: "g1 x" }, { agent: { ctx: { preset: "code-audit" }, session: { id: "s1", header: {} } } });
	expect("goal render 含 audit 理论", goal.output.render(null, g2)[0].text.includes("模块×sink"));
	const g3 = await goal.execute({ workspace: tmp, goal: "x", criteria: "g1 x" }, { agent: { ctx: { preset: "plain" }, session: { id: "s1", header: {} } } });
	expect("未知模式不带理论段", !goal.output.render(null, g3)[0].text.includes("拆分理论"));
	const s1 = await scope.execute({ workspace: tmp, items: "a\nb" }, { agent: { ctx: { preset: "cloud-security" }, session: { id: "s1", header: {} } } });
	expect("scope render 含分母语义", scope.output.render(null, s1)[0].text.includes("cloud-security 分母语义") && scope.output.render(null, s1)[0].text.includes("账号/区域/服务面"));
	const c1 = await cons.execute({ workspace: tmp, items: "deny: x" }, { agent: { ctx: { preset: "ctf-solver" }, session: { id: "s1", header: {} } } });
	expect("constraints render 含约束面提示", cons.output.render(null, c1)[0].text.includes("ctf-solver 约束面提示") && cons.output.render(null, c1)[0].text.includes("不猜不撞"));

	// ── operation_intent：execute **必须返回可序列化对象**（实跑抓到的真 bug）────────
	// 曾经写成 `execute(args, exec) { (async () => { … return {…} })() }` 的 fire-and-forget：
	// 外层没有 return → execute 返回 undefined → 真 defineTool 的
	// `validateJsonSchemaValue(output.schema, undefined)` 判违反必填 ok：
	//   Error: tool "operation_intent" returned invalid output: value is not lossless JSON
	// 后果：**意图其实已异步登记成功，但模型收到的是「调用失败」**（真实会话里连续两次都报）。
	const intent = registered.find((x) => x?.name === "operation_intent");
	expect("operation_intent 已注册", !!intent);
	const i1 = await intent.execute(
		{ workspace: tmp, summary: "追一条线索", anchor_kind: "boot" },
		{ agent: { ctx: { preset: "pentest" }, session: { id: "s1", header: {} } } },
	);
	expect("operation_intent.execute 返回了值（不是 undefined）", i1 !== undefined && i1 !== null);
	expect("返回值是 JSON 可序列化的普通对象", typeof i1 === "object" && JSON.stringify(i1) !== undefined);
	expect("返回值带 ok 字段（输出 schema 的必填项）", typeof i1.ok === "boolean");
	expect("成功时回带 id/anchor/open/total", i1.ok && typeof i1.id === "string" && typeof i1.anchor === "string" && Number.isInteger(i1.open) && Number.isInteger(i1.total));
	// 反向锚：若哪天又改回 fire-and-forget，第一条就会亮红
	expect("没有 fire-and-forget 的 execute（(async () => {…})() 且顶层无 return）",
		!/execute\(args, exec\) \{\s*\n\s*\(async \(\) => \{/.test(fs.readFileSync(new URL("../lib/index.js", import.meta.url), "utf8")));

	fs.rmSync(tmp, { recursive: true, force: true });
}

// ── 约束层 + scope 保守派生（v1.3.0）─────────────────────────────────────
{
	const tmp = fs.mkdtempSync(path.join(path.dirname(F), "cons-"));
	const ws = tmp;
	setGoal(ws, "对 demo 站授权渗透", "g1 准则");
	// 约束登记：格式/匹配词/非法行/重登记替换
	let s = setConstraints(ws, "deny: 不碰支付接口 :: pay,payment,refund\nallow: 仅测 x.example.com 子域\ndeny: 禁止爆破（提示层）");
	expect("约束登记计数", s.total === 3 && s.deny === 2 && s.allow === 1 && s.denyGuarded === 1, JSON.stringify(s));
	const st = ros(fs, ws);
	expect("约束落盘带匹配词", st.constraints[0].id === "c1" && st.constraints[0].keywords.join() === "pay,payment,refund" && st.constraints[2].keywords.length === 0);
	expect("摘要行渲染", constraintSummary(st).lines[0].includes("禁：不碰支付接口") && constraintSummary(st).lines[0].includes("pay"));
	let threw = false;
	try { setConstraints(ws, "随便一行"); } catch { threw = true; }
	expect("非法行拒绝（须 deny:/allow: 开头）", threw);
	threw = false;
	try { setConstraints(path.join(tmp, "bare"), "deny: x"); } catch { threw = true; }
	expect("无契约拒绝", threw);
	s = setConstraints(ws, "deny: 新约束 :: newkw");
	expect("重登记整表替换", s.total === 1 && ros(fs, ws).constraints[0].text === "新约束");
	// scope 保守派生：URL/裸域/IP；不放大到根域；排除版本号
	const draft = deriveScopeDraft(["对 https://app.demo.example.com/login 与 10.0.0.5 授权测试", "覆盖 api.example.com 全部路由（v1.2.3 不算）"]);
	expect("URL 主机提取", draft.includes("app.demo.example.com"));
	expect("IPv4 提取", draft.includes("10.0.0.5"));
	expect("裸域名全名提取（不缩根域）", draft.includes("api.example.com") && !draft.includes("example.com"));
	expect("版本号不提取", !draft.includes("1.2.3"));
	expect("空输入空草稿", deriveScopeDraft("").length === 0);
	expect("无点串不提取", deriveScopeDraft("看看 abc 和 def").length === 0);
	// operation_goal 集成：返回 scopeDraft；已有 scope 不再派生
	const fresh = fs.mkdtempSync(path.join(path.dirname(F), "draft-"));
	const g1 = setGoal(fresh, "测 https://a.example.com", "g1 x");
	const parsed = ros(fs, fresh);
	fs.rmSync(fresh, { recursive: true, force: true });
	fs.rmSync(tmp, { recursive: true, force: true });
}

// ── 行为级体检的回归锁（独立文件 test/behavior-locks.mjs 也能单跑）──────────
// 锁的都是「实战才暴露、静态看不出来」的形态：
//   ① 定时器回调抛异常会**打挂整个宿主进程**（不是坏一个面板）
//   ② SQLite 库文件损坏时应备份+重建，而不是抛（磁盘满/强杀/网盘回写都会造成）
//   ③ 库句柄必须释放（悬着会锁住文件，Windows 上 rename 必 EBUSY）
//   ④ 释放钩子必须在 apply() 内（放模块顶层会 ReferenceError: ctx is not defined）
{
	const P = path.resolve(path.dirname(F), "../..");
	// ① mcp-studio 看门狗
	{
		const src = fs.readFileSync(`${P}/dsh-mcp-studio/lib/index.js`, "utf8");
		expect("mcp-studio: watchdog 回调有异常隔离（定时器抛错会打挂宿主）",
			/const watchdogTick = \(\) => \{[\s\S]{0,200}?try \{[\s\S]{0,80}?tickOnce\(\)/.test(src));
		expect("mcp-studio: watchdog 失败有可见出口", src.includes("mcp-studio: watchdog tick failed"));
		expect("mcp-studio: 读 servers 走永不抛的 serversOf()", src.includes("const serversOf = () => {"));
		expect("mcp-studio: 没有未保护的 current().servers 迭代", !/for \(const server of current\(\)\.servers\)/.test(src));
	}
	// ②③④ 四个 SQLite 插件
	for (const p of ["dsh-campaign-memory", "dsh-attack-atlas", "dsh-redteam-results", "dsh-trace-vault"]) {
		const store = fs.readFileSync(`${P}/${p}/lib/store.js`, "utf8");
		expect(`${p}: 库损坏时自愈（备份+重建而非抛）`, store.includes("healCorruptDb"));
		const firstOpenAt = store.indexOf("new DatabaseSync(dbPath)");
		const notDbAt = store.search(/not a database\|SQLITE_NOTADB/i);
		const healAt = store.indexOf("healCorruptDb(dbPath, true)");
		expect(`${p}: 先尝试开库，只有 NOTADB 才自愈`, firstOpenAt >= 0 && notDbAt > firstOpenAt && healAt > notDbAt && !/\n\s*healCorruptDb\(dbPath\);\s*\/\/.*开库前/.test(store));
		expect(`${p}: 并发首开前先设 busy_timeout`, store.indexOf("PRAGMA busy_timeout") >= 0 && store.indexOf("PRAGMA busy_timeout") < store.indexOf("PRAGMA journal_mode"));
		expect(`${p}: 自愈清掉 -wal/-shm 残留`, store.includes('"-wal", "-shm"'));
		expect(`${p}: 备份名冲突不覆盖`, store.includes("while (fs.existsSync(bak))"));
		expect(`${p}: 备份失败如实抛出（不装作自愈成功）`, /catch \(e\) \{[\s\S]{0,320}?throw e;/.test(store));
		const idx = fs.readFileSync(`${P}/${p}/lib/index.js`, "utf8");
		// 两种正确写法都认：模块级 closeStore() 或 store 单例上的 .close()
		expect(`${p}: 有库句柄释放钩子`,
			/ctx\.effect\(\(\) => \(\) => \{[\s\S]{0,140}?(store\?\.close\?\.\(\)|closeStore\(\))/.test(idx) && idx.includes(': store handle"'));
		// 钩子必须在 apply 内（放模块顶层会 ReferenceError: ctx is not defined）
		expect(`${p}: 释放钩子在 apply() 内`, idx.search(/^function apply\(/m) < idx.indexOf(': store handle"'));
	}
	// 全仓：没有第二个 fire-and-forget 的 execute
	{
		const dirs = ["dsh-attack-atlas", "dsh-auto-advance", "dsh-campaign-memory", "dsh-ctf-observer", "dsh-hunter",
			"dsh-knowledge-hub", "dsh-method-stack", "dsh-product-subagents", "dsh-redteam-results", "dsh-refusal-guard",
			"dsh-route-boost", "dsh-scanner-tools", "dsh-sec-config", "dsh-sec-enforce", "dsh-semgrep-audit",
			"dsh-session-pulse", "dsh-skill-browse", "dsh-trace-vault", "dsh-webshell-mgr"];
		const bad = dirs.filter((d) => {
			const f = `${P}/${d}/lib/index.js`;
			if (!fs.existsSync(f)) return false;
			return /execute\s*\([^)]*\)\s*\{\s*\n?\s*\(async \(\) => \{/.test(fs.readFileSync(f, "utf8"));
		});
		expect("全仓无第二个 fire-and-forget 的 execute", bad.length === 0);
	}
}

// ── 结束条件判定（P1-2「结束条件外置」）───────────────────────────────────
// 判据设计要点，逐条锁住：
//   · 只拦「没结论」，不拦「失败」—— failed 是有效终态（如实收口），卡它等于逼模型造假
//   · done / blocked / dropped 都是意图终态，只有 open 拦
//   · 无台账的会话不该被闸门管（普通对话没有 operation_goal）
{
	const mk = (criteria, intents) => ({ version: 1, goal: "g", criteria, intents });

	// 1. 无台账 → 放行
	let v = conclusionVerdict(null);
	expect("conclusion: 无台账放行", v.canConclude === true && v.blockers.length === 0, JSON.stringify(v));

	// 2. 全 met → 放行
	v = conclusionVerdict(mk([{ id: "g1", text: "a", status: "met" }], []));
	expect("conclusion: 全 met 放行", v.canConclude === true, JSON.stringify(v));

	// 3. ★ open 准则 → 拦（这是整个机制的核心）
	v = conclusionVerdict(mk([{ id: "g1", text: "a", status: "met" }, { id: "g2", text: "b", status: "open" }], []));
	expect("conclusion: open 准则拦下", v.canConclude === false, JSON.stringify(v));
	expect("conclusion: 拦下时点名是哪条", v.blockers.some((b) => b.kind === "criterion" && b.id === "g2"), JSON.stringify(v.blockers));
	expect("conclusion: reason 给出可执行的下一步", /operation_progress/.test(v.reason), v.reason);

	// 4. ★ failed 也放行（不逼模型造假）—— 反向锁：若改成只认 met，这条必红
	v = conclusionVerdict(mk([{ id: "g1", text: "a", status: "failed" }], []));
	expect("conclusion: failed 视为已收口（不逼造假）", v.canConclude === true, JSON.stringify(v));

	// 5. open 意图 → 拦
	v = conclusionVerdict(mk([{ id: "g1", text: "a", status: "met" }],
		[{ id: "i1", summary: "查这个线索", status: "open" }]));
	expect("conclusion: open 意图拦下", v.canConclude === false, JSON.stringify(v));
	expect("conclusion: 意图 blocker 带摘要", v.blockers.some((b) => b.kind === "intent" && b.id === "i1" && b.text.includes("线索")), JSON.stringify(v.blockers));

	// 6. 意图三种终态都放行
	for (const stx of ["done", "blocked", "dropped"]) {
		v = conclusionVerdict(mk([{ id: "g1", text: "a", status: "met" }], [{ id: "i1", summary: "x", status: stx }]));
		expect(`conclusion: 意图 ${stx} 放行`, v.canConclude === true, JSON.stringify(v));
	}

	// 7. 准则与意图都拦 → blockers 两类都在，计数正确
	v = conclusionVerdict(mk(
		[{ id: "g1", text: "a", status: "open" }, { id: "g2", text: "b", status: "open" }],
		[{ id: "i1", summary: "x", status: "open" }]));
	expect("conclusion: 两类 blocker 都在", v.blockers.length === 3, JSON.stringify(v.blockers));
	expect("conclusion: 计数正确", v.criteria.open === 2 && v.intents.open === 1, JSON.stringify(v));

	// 8. 坏数据不抛（缺 status / 非数组 / 缺字段）
	for (const bad of [mk([], []), mk([{ id: "g1" }], []), { criteria: [], intentSummary: 1 }, { criteria: "x" }, {}]) {
		let threw = false;
		try { v = conclusionVerdict(bad); } catch { threw = true; }
		expect(`conclusion: 坏数据不抛（${JSON.stringify(bad).slice(0, 28)}）`, threw === false && typeof v.canConclude === "boolean");
	}
	// 9. 空准则但有台账 → 放行（异常但可收尾，reason 说明）
	v = conclusionVerdict(mk([], []));
	expect("conclusion: 无准则放行且 reason 说明", v.canConclude === true && /无准则/.test(v.reason), v.reason);

	// 10. **行为级**：真调 operation_conclude，断言「系统放行才 concludeTurn」。
	// 为什么要真调而不是 grep 源码：源码里有 `exec?.concludeTurn?.()` 这行文本，
	// 并不等于**在正确分支上真的会执行**（把 if (canConclude) 改成 if (false)，
	// 文本检查照样通过 —— 第一版反向验证就抓到了这个假锁）。
	{
		const tools = [];
		apply({ tools: { register: (t) => tools.push(t) } });
		const tool = tools.find((t) => t.name === "operation_conclude");
		expect("conclusion: operation_conclude 已注册", !!tool);

		const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sg-conclude-"));
		const writeState = (st) => fs.writeFileSync(path.join(ws, "operation-state.json"), JSON.stringify(st), "utf8");
		const call = async () => {
			let concluded = 0;
			const out = await tool.execute({ workspace: ws }, { concludeTurn: () => { concluded++; } });
			return { out, concluded };
		};

		// 10a 全收口 → 放行 + 真的 concludeTurn
		writeState(mk([{ id: "g1", text: "a", status: "met" }], [{ id: "i1", summary: "x", status: "done" }]));
		let r = await call();
		expect("conclusion(行为): 全收口放行", r.out.ok === true && r.out.canConclude === true, JSON.stringify(r.out).slice(0, 120));
		expect("conclusion(行为): 放行时调了一次 concludeTurn（宿主级收尾）", r.concluded === 1, `concluded=${r.concluded}`);

		// 10b 有 open 准则 → 驳回 + **不调** concludeTurn
		writeState(mk([{ id: "g1", text: "a", status: "open" }], []));
		r = await call();
		expect("conclusion(行为): open 准则被驳回", r.out.ok === true && r.out.canConclude === false, JSON.stringify(r.out).slice(0, 120));
		expect("conclusion(行为): 驳回时**没有** concludeTurn（否则闸门失效）", r.concluded === 0, `concluded=${r.concluded}`);
		expect("conclusion(行为): 驳回返回可执行的 blocker 清单",
			Array.isArray(r.out.blockers) && r.out.blockers.some((b) => b.id === "g1"), JSON.stringify(r.out.blockers));

		// 10c 无台账 → 放行（普通会话不受闸门管辖）
		fs.rmSync(path.join(ws, "operation-state.json"), { force: true });
		r = await call();
		expect("conclusion(行为): 无台账放行且收尾", r.out.canConclude === true && r.concluded === 1, JSON.stringify(r.out).slice(0, 120));

		// 10d 老宿主没有 concludeTurn API → 不抛错（降级为普通结果）
		writeState(mk([{ id: "g1", text: "a", status: "met" }], []));
		let threw = false;
		let out2;
		try { out2 = await tool.execute({ workspace: ws }, {}); } catch { threw = true; }
		expect("conclusion(行为): 宿主无 concludeTurn 时安全降级", threw === false && out2.ok === true && out2.canConclude === true);

		// 10e 缺 workspace 参数 → 可读的错误，不是 TypeError
		let e2;
		try { await tool.execute({}, {}); e2 = null; } catch (e) { e2 = e; }
		expect("conclusion(行为): 缺参给出可读错误", e2 === null || !(e2 instanceof TypeError), String(e2 && e2.message).slice(0, 80));

		fs.rmSync(ws, { recursive: true, force: true });
	}
}

// ── 子代理结果回收（P1-9）：生命周期 start/end 把成败与摘要写回台账任务 ────────
{
	const ws = fs.mkdtempSync(path.join(path.dirname(F), "recycle-"));
	try {
		setGoal(ws, "子代理回收探针", "子代理复核完成");
		expect("isSubagentTool 认原生与产品行",
			isSubagentTool("subagent") && isSubagentTool("subagent_fork") && isSubagentTool("subagent_claude_code")
			&& isSubagentTool("subagent_codex") && !isSubagentTool("bash") && !isSubagentTool("subagentx"));
		expect("subagentOwnerAlias 把 provider 映射成 owner 别名",
			subagentOwnerAlias("claude-code") === "subagent_claude_code" && subagentOwnerAlias("") === "subagent");
		expect("事件 provider 别名也认通用 owner=subagent（模型登记时就是这么写的）",
			taskToolAliases("subagent_dsh").includes("subagent") && taskToolAliases("subagent_codex").includes("codex"));
		expect("summarizeToolResult 取 content 文本并压平空白",
			summarizeToolResult({ content: [{ type: "text", text: " 复核 结论\n一致 " }] }) === "复核 结论 一致");
		expect("summarizeToolResult 取 value 且封顶",
			summarizeToolResult({ value: "x".repeat(900) }, 100).length === 100);

		// start → running（attempts=1）：顺手挡住"还在跑就被别人 claim"
		registerIntent(ws, { summary: "交叉复核 SQLi", anchorKind: "criterion", anchorRef: "g1", owner: "subagent_claude_code", sessionId: "s1", maxAttempts: 2 });
		const started = startSubagentTask(ws, { sessionId: "s1", provider: "claude-code" });
		expect("subagent/start → 任务转 running 且 attempts=1",
			started?.task?.state === "running" && started.task.attempts === 1);

		// end(completed) → succeeded + 子代理最后一条输出入账
		const done = finishSubagentTask(ws, { sessionId: "s1", provider: "claude-code", stopReason: "completed", summary: "复核一致：SQLi 已复现" });
		expect("subagent/end(completed) → succeeded 且摘要入账",
			done?.task?.state === "succeeded" && done.task.result.includes("复核一致"));

		// end(error) → failed
		registerIntent(ws, { summary: "复核命令执行", anchorKind: "criterion", anchorRef: "g1", owner: "subagent_codex", sessionId: "s1", maxAttempts: 2 });
		startSubagentTask(ws, { sessionId: "s1", provider: "codex" });
		const bad = finishSubagentTask(ws, { sessionId: "s1", provider: "codex", stopReason: "error", summary: "CLI 退出码 1" });
		expect("subagent/end(error) → failed 且错误入账", bad?.task?.state === "failed" && bad.task.error.includes("退出码 1"));

		// end(aborted) → interrupted（可 retry，不是假成功）
		registerIntent(ws, { summary: "复核被中断", anchorKind: "criterion", anchorRef: "g1", owner: "subagent_acp", sessionId: "s1", maxAttempts: 2 });
		startSubagentTask(ws, { sessionId: "s1", provider: "acp" });
		const aborted = finishSubagentTask(ws, { sessionId: "s1", provider: "acp", stopReason: "aborted" });
		expect("subagent/end(aborted) → interrupted", aborted?.task?.state === "interrupted");

		// 多候选 / provider 不同 / session 不匹配 → 不动账
		registerIntent(ws, { summary: "复核 A", anchorKind: "criterion", anchorRef: "g1", owner: "subagent", sessionId: "s1", maxAttempts: 1 });
		registerIntent(ws, { summary: "复核 B", anchorKind: "criterion", anchorRef: "g1", owner: "subagent", sessionId: "s1", maxAttempts: 1 });
		const before = JSON.stringify(ros(fs, ws).intents.map((i) => i.task));
		expect("多候选不动账（宁可不写也不猜归属）",
			startSubagentTask(ws, { sessionId: "s1", provider: "" }) === null
			&& JSON.stringify(ros(fs, ws).intents.map((i) => i.task)) === before);
		expect("provider 不匹配不动账",
			startSubagentTask(ws, { sessionId: "s1", provider: "codex" }) === null);
		expect("session 不匹配不动账",
			startSubagentTask(ws, { sessionId: "s9", provider: "" }) === null);
		expect("已收口任务不会被二次收口", finishSubagentTask(ws, { sessionId: "s1", provider: "claude-code", stopReason: "completed" }) === null);

		const emptyWs = fs.mkdtempSync(path.join(path.dirname(F), "recycle-empty-"));
		try {
			expect("无台账不抛错",
				startSubagentTask(emptyWs, { sessionId: "s1", provider: "" }) === null
				&& finishSubagentTask(emptyWs, { sessionId: "s1", provider: "", stopReason: "error" }) === null);
		} finally {
			fs.rmSync(emptyWs, { recursive: true, force: true });
		}
	} finally {
		fs.rmSync(ws, { recursive: true, force: true });
	}
}

// ── 项目工作台（只读快照 + web 通道栅栏）────────────────────────────────────
{
	const ws = fs.mkdtempSync(path.join(path.dirname(F), "workbench-"));
	try {
		fs.writeFileSync(path.join(ws, "operation-state.json"), JSON.stringify({
			goal: "项目工作台探针",
			criteria: [
				{ id: "g1", text: "已完成项", status: "met" },
				{ id: "g2", text: "待收口项", status: "open" },
			],
			intents: [
				{ id: "i1", summary: "已收口方向", status: "done", task: { state: "succeeded", owner: "nmap", attempts: 1, maxAttempts: 1, result: "open 22/80" } },
				{ id: "i2", summary: "中断方向", status: "open", task: { state: "interrupted", owner: "worker", attempts: 1, maxAttempts: 2, error: "heartbeat expired" } },
				{
					id: "i3",
					summary: "有冲突的方向",
					status: "open",
					task: {
						state: "succeeded",
						owner: "subagent",
						attempts: 1,
						maxAttempts: 2,
						result: "模型说完成",
						conflicts: [{ at: "2026-09-18T00:00:00.000Z", from: "succeeded", to: "failed", detail: "子代理随后报失败" }],
					},
				},
			],
		}, null, 2), "utf8");
		fs.writeFileSync(path.join(ws, "gate-log.md"), "PASS before\nFAIL 阶段门禁样例\n", "utf8");
		fs.writeFileSync(path.join(ws, "evidence-index.md"), "| E1 | a | b | c | d |\n| E2 | a | b | c | d |\n", "utf8");
		fs.writeFileSync(path.join(ws, "scan-reconcile.md"), "| scanner | hit | 待处置 |\n", "utf8");
		fs.mkdirSync(path.join(ws, "reports"), { recursive: true });
		fs.writeFileSync(path.join(ws, "reports", "01-漏洞.md"), "# r\n", "utf8");
		fs.writeFileSync(path.join(ws, "reports", "exp.py"), "print('x')\n", "utf8");
		fs.writeFileSync(path.join(ws, "reports", "ignore.zip"), "x", "utf8");

		const snap = projectSnapshot(ws);
		expect("工作台快照：目标/台账标记正确", snap.hasLedger === true && snap.goal === "项目工作台探针" && snap.name === path.basename(ws));
		expect("工作台快照：准则统计（met/total/open）", snap.criteria.total === 2 && snap.criteria.met === 1 && snap.criteria.open === 1);
		expect("工作台快照：意图与任务计数", snap.intents.total === 3 && snap.intents.open === 2 && snap.tasks.length === 3);
		expect("工作台快照：冲突任务进计数与 attention",
			snap.counts.conflicts === 1
			&& snap.attention.some((a) => a.kind === "任务结果冲突" && a.text.includes("子代理随后报失败")));
		expect("工作台快照：中断任务进 attention",
			snap.attention.some((a) => a.kind === "中断任务" && a.text.includes("heartbeat expired")));
		expect("工作台快照：产物索引（证据行/待处置/门禁/报告）",
			snap.artifacts.evidenceRows === 2 && snap.artifacts.pendingScanRows === 1
			&& /FAIL 阶段门禁样例/.test(snap.artifacts.gateLine)
			&& snap.artifacts.reports.length === 2
			&& snap.artifacts.reports.some((r) => r.name === "01-漏洞.md")
			&& !snap.artifacts.reports.some((r) => r.name === "ignore.zip"));
		expect("工作台快照：门禁 FAIL 进 attention",
			snap.attention.some((a) => a.kind === "阶段门禁" && /FAIL/.test(a.text)));
		expect("工作台快照：已登记目标时不报「目标契约」缺失",
			snap.goalRegistered === true && !snap.attention.some((a) => a.kind === "目标契约"));

		// 回归背景：真实端到端跑完发现模型可以跳过 operation_goal，
		// 此时台账存在但 goal 为空 —— 工作台原来显示「0/0 准则已全部收口」，
		// 把"根本没立标准"显示成了"全部做完"。现在必须显式区分。
		const noGoal = fs.mkdtempSync(path.join(path.dirname(F), "workbench-nogoal-"));
		try {
			fs.writeFileSync(path.join(noGoal, "operation-state.json"), JSON.stringify({
				version: 1, mode: "pentest", goal: "", criteria: [], intents: [], gates: {},
			}));
			const snapNoGoal = projectSnapshot(noGoal);
			expect("工作台快照：台账在但没登记目标 -> goalRegistered=false",
				snapNoGoal.hasLedger === true && snapNoGoal.goalRegistered === false);
			expect("工作台快照：没登记目标进 attention（不能显示成健康 0/0）",
				snapNoGoal.attention.some((a) => a.kind === "目标契约" && /0\/0/.test(a.text)));
		} finally {
			fs.rmSync(noGoal, { recursive: true, force: true });
		}

		const bare = fs.mkdtempSync(path.join(path.dirname(F), "workbench-bare-"));
		try {
			const empty = projectSnapshot(bare);
			expect("无台账工作区：结构完整且不抛错",
				empty.hasLedger === false && empty.criteria.total === 0 && empty.tasks.length === 0
				&& empty.attention.some((a) => a.kind === "阶段门禁"));
		} finally {
			fs.rmSync(bare, { recursive: true, force: true });
		}

		// 端点：只读 + 入参校验
		expect("dispatchProject：status 返回快照", (() => {
			const r = dispatchProject("status", { workspace: ws });
			return r.ok === true && r.snapshot.goal === "项目工作台探针";
		})());
		expect("dispatchProject：未知端点/缺工作区/相对路径/不存在目录都被拒",
			dispatchProject("nope", { workspace: ws }).ok === false
			&& dispatchProject("status", {}).ok === false
			&& dispatchProject("status", { workspace: "relative/path" }).ok === false
			&& dispatchProject("status", { workspace: path.join(ws, "missing-dir") }).ok === false);

		// 同源栅栏：Host 回环 + Origin 同源才放行；跨端口/外站都拒
		const req = (host, origin) => ({ headers: origin === undefined ? { host } : { host, origin } });
		expect("栅栏：回环 Host + 同源 Origin 放行",
			isTrustedRequest(req("127.0.0.1:3090", "http://127.0.0.1:3090"), []) === true
			&& isTrustedRequest(req("localhost:3090"), []) === true);
		expect("栅栏：跨端口/外站/无 Origin 但外站 Host 都拒",
			isTrustedRequest(req("127.0.0.1:3090", "http://127.0.0.1:9999"), []) === false
			&& isTrustedRequest(req("evil.example", "http://evil.example"), []) === false
			&& isTrustedRequest(req("evil.example"), []) === false);
		expect("栅栏：受信主机列表可按 hostname 放行",
			isTrustedRequest(req("box.internal:3090", "http://box.internal:3090"), ["box.internal"]) === true);
		expect("CSRF：缺头/错头拒绝，正确 token 放行",
			checkCsrf({ headers: {} }, CSRF_TOKEN) === false
			&& checkCsrf({ headers: { "x-dsh-csrf": "nope" } }, CSRF_TOKEN) === false
			&& checkCsrf({ headers: { "x-dsh-csrf": CSRF_TOKEN } }, CSRF_TOKEN) === true);
		expect("路由前缀常量与客户端一致", ROUTE_PATH === "/dsh-stage-gate-project");
	} finally {
		fs.rmSync(ws, { recursive: true, force: true });
	}
}

// ── 任务结果冲突（P1-9 冲突处理）：终态只记冲突、绝不覆盖，同结果幂等 ──────────
{
	const ws = fs.mkdtempSync(path.join(path.dirname(F), "conflict-"));
	try {
		setGoal(ws, "冲突探针", "复核完成");
		registerIntent(ws, { summary: "冲突复核", anchorKind: "criterion", anchorRef: "g1", owner: "subagent", sessionId: "s1", maxAttempts: 3 });
		taskTransition(ws, { id: "i1", action: "start" });
		const first = taskTransition(ws, { id: "i1", action: "succeed", result: "复核通过" });
		expect("首次 succeeded 不带冲突", first.task.state === "succeeded" && (first.task.conflicts || []).length === 0 && first.conflict === undefined);

		// 幂等重放：同结果再来一次不改账
		const stampBefore = ros(fs, ws).intents[0].task.updatedAt;
		const replay = taskTransition(ws, { id: "i1", action: "succeed", result: "复核通过" });
		expect("同结果重复上报=幂等（不置冲突、不动 updatedAt）",
			replay.task.state === "succeeded" && (replay.task.conflicts || []).length === 0
			&& ros(fs, ws).intents[0].task.updatedAt === stampBefore);

		// 不同结果：记冲突，状态不变
		const clash = taskTransition(ws, { id: "i1", action: "fail", error: "子代理随后报 CLI 退出码 1" });
		expect("终态后收到不同结果 → 记冲突且不覆盖终态",
			clash.conflict === true && clash.task.state === "succeeded"
			&& (clash.task.conflicts || []).length === 1
			&& clash.task.conflicts[0].from === "succeeded" && clash.task.conflicts[0].to === "failed"
			&& clash.task.conflicts[0].detail.includes("退出码 1"));

		// 冲突记录有上限（最近 5 条）
		for (let i = 0; i < 7; i += 1) taskTransition(ws, { id: "i1", action: "fail", error: `第 ${i} 次矛盾` });
		const capped = ros(fs, ws).intents[0].task.conflicts;
		expect("冲突记录封顶 5 条（只留最近）", capped.length === 5 && capped.at(-1).detail.includes("第 6 次矛盾"));

		// 精确按 taskId 回收：模型已收口 + 子代理随后失败 → 同样只记冲突
		registerIntent(ws, { summary: "精确回收冲突", anchorKind: "criterion", anchorRef: "g1", owner: "subagent_spawn", sessionId: "s1", maxAttempts: 2 });
		startSubagentTask(ws, { sessionId: "s1", provider: "spawn" });
		taskTransition(ws, { id: "i2", action: "succeed", result: "模型说完成了" });
		const late = finishSubagentTask(ws, { sessionId: "s1", provider: "spawn", stopReason: "error", summary: "子代理其实失败了", taskId: "i2" });
		expect("精确 taskId 回收：已收口任务收到相反结果 → 记冲突不抛错",
			late?.conflict === true && late.task.state === "succeeded" && late.task.conflicts.length === 1);
		const lateAbort = finishSubagentTask(ws, { sessionId: "s1", provider: "spawn", stopReason: "aborted", summary: "被中断", taskId: "i2" });
		expect("精确 taskId 回收：终止原因 aborted 也记冲突（不覆盖）",
			lateAbort?.conflict === true && lateAbort.task.state === "succeeded" && lateAbort.task.conflicts.length === 2);
	} finally {
		fs.rmSync(ws, { recursive: true, force: true });
	}
}

// ── 子代理回收的**接线**：按 agent 作用域挂 subagent/start + subagent/end ──────
//
// 真宿主实测（2026-09-18）：这两个是**作用域事件**，监听器只拿得到 info、拿不到 parent。
// 所以 apply 里必须挂 agent/created → 用 agent.ctx.on 注册，把 agent 闭包进去；
// 直接写 ctx.on("subagent/start", (info, parent) => …) 会永远拿到 undefined。
{
	const ws = fs.mkdtempSync(path.join(path.dirname(F), "recycle-wire-"));
	try {
		setGoal(ws, "接线探针", "复核完成");
		const handlers = {};
		const tools = [];
		apply({
			tools: { register: (t) => tools.push(t) },
			agentPresets: { composedPreset: () => "pentest" },
			on: (event, fn) => { handlers[event] = fn; },
		});
		expect("apply 挂了 agent 生命周期钩子（agent/created、agent/disposed）",
			typeof handlers["agent/created"] === "function" && typeof handlers["agent/disposed"] === "function"
			&& typeof handlers["agent/inbox/inserted"] === "function");
		expect("apply 仍注册原有工具", tools.length >= 9);
		expect("apply 不再直接监听作用域事件（subagent/start 由 agent 作用域挂）",
			handlers["subagent/start"] === undefined && handlers["subagent/end"] === undefined);

		const agentHandlers = {};
		let disposed = 0;
		const agent = {
			id: "a1",
			session: { id: "s1", header: { cwd: ws } },
			ctx: { on: (event, fn) => { agentHandlers[event] = fn; return () => { disposed += 1; }; } },
		};
		handlers["agent/created"]({ agent });
		expect("agent 作用域挂上 subagent/start 与 subagent/end",
			typeof agentHandlers["subagent/start"] === "function" && typeof agentHandlers["subagent/end"] === "function");
		// 幂等：同一 agent 再来一次不得重复挂
		const beforeCount = disposed;
		handlers["agent/inbox/inserted"]({ agent });
		expect("同一 agent 幂等（不重复挂监听）", disposed === beforeCount);

		registerIntent(ws, { summary: "接线复核", anchorKind: "criterion", anchorRef: "g1", owner: "subagent", sessionId: "s1", maxAttempts: 2 });
		agentHandlers["subagent/start"]({ provider: "spawn", runId: "r1", id: "child-1" });
		expect("接线：真实事件形状把任务转 running",
			ros(fs, ws).intents.at(-1).task.state === "running");
		agentHandlers["subagent/end"]({
			provider: "spawn",
			stopReason: "completed",
			lastAssistantMessage: [{ type: "text", text: "复核完成：一致" }],
		});
		const task = ros(fs, ws).intents.at(-1).task;
		expect("接线：end 用最后一条子代理输出收口",
			task.state === "succeeded" && task.result.includes("复核完成"));

		// 别的会话：即使 provider 命中也不得动账
		const otherHandlers = {};
		const other = {
			id: "a2",
			session: { id: "s2", header: { cwd: ws } },
			ctx: { on: (event, fn) => { otherHandlers[event] = fn; return () => {}; } },
		};
		handlers["agent/created"]({ agent: other });
		const before = JSON.stringify(ros(fs, ws).intents.map((i) => i.task));
		otherHandlers["subagent/start"]({ provider: "spawn" });
		otherHandlers["subagent/end"]({ provider: "spawn", stopReason: "error" });
		expect("接线：别的会话不动本会话的任务",
			JSON.stringify(ros(fs, ws).intents.map((i) => i.task)) === before);

		// runId 精确绑定：模型先收口、子代理随后失败 → 按 runId 找到同一条任务并记冲突
		registerIntent(ws, { summary: "并发复核（runId 绑定）", anchorKind: "criterion", anchorRef: "g1", owner: "subagent", sessionId: "s1", maxAttempts: 2 });
		agentHandlers["subagent/start"]({ provider: "spawn", runId: "r2", id: "child-2" });
		taskTransition(ws, { id: "i2", action: "succeed", result: "模型先宣布完成" });
		agentHandlers["subagent/end"]({
			provider: "spawn",
			runId: "r2",
			stopReason: "error",
			lastAssistantMessage: [{ type: "text", text: "子代理实际失败了" }],
		});
		const conflictTask = ros(fs, ws).intents.find((i) => i.id === "i2").task;
		expect("接线：runId 精确绑定把矛盾记成冲突（终态不被覆盖）",
			conflictTask.state === "succeeded" && (conflictTask.conflicts || []).length === 1
			&& conflictTask.conflicts[0].detail.includes("子代理实际失败"));

		handlers["agent/disposed"]({ agent });
		expect("agent 销毁时释放作用域监听", disposed >= 2);
	} finally {
		fs.rmSync(ws, { recursive: true, force: true });
	}
}

process.exit(failed ? 1 : 0);
