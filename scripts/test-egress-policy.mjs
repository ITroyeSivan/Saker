#!/usr/bin/env node
// 统一出站策略回归：判定表、白名单边界、策略文件读写、审计留痕与轮转。
// 关键不变量：目标流量不归它管、回环不算出站、冻结档必须真拦、缺文件要按默认放行但标注原因。
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AUDIT_MAX_BYTES,
	appendAudit,
	auditPath,
	checkEgress,
	defaultPolicy,
	describeSource,
	evaluateEgress,
	hostAllowed,
	hostOf,
	policyPath,
	readAudit,
	readPolicy,
	writePolicy,
} from "../lib/egress.js";

let pass = 0;
let fail = 0;
const ok = (label, condition, detail = "") => {
	if (condition) { pass += 1; console.log(`ok   ${label}`); }
	else { fail += 1; console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
};

const home = mkdtempSync(join(tmpdir(), "saker-egress-"));
try {
	// 1. 缺策略文件：默认放行，但要能区分"没配"与"配了 allow"
	const missing = readPolicy(home);
	ok("无策略文件→默认放行且标注 policy-missing",
		missing.policy.mode === "allow" && missing.source === "policy-missing",
		JSON.stringify(missing));

	// 2. 判定表
	const frozen = { ...defaultPolicy(), mode: "frozen" };
	ok("冻结档：目标流量不受管（仍放行，reason=target-traffic）",
		evaluateEgress({ kind: "target", host: "evil.example", policy: frozen }).decision === "allow"
		&& evaluateEgress({ kind: "target", host: "evil.example", policy: frozen }).reason === "target-traffic");
	ok("冻结档：回环（本机代理/服务）不算出站",
		["127.0.0.1", "localhost", "::1", "api.localhost"].every((h) =>
			evaluateEgress({ kind: "infra", host: h, policy: frozen }).decision === "allow"));
	ok("冻结档：基础设施出站被拦",
		evaluateEgress({ kind: "infra", host: "github.com", policy: frozen }).decision === "deny"
		&& evaluateEgress({ kind: "infra", host: "github.com", policy: frozen }).reason === "infra_frozen");

	const allowlisted = { ...defaultPolicy(), mode: "allowlist", allowHosts: ["github.com", "10.0.0.5"] };
	ok("白名单档：域名后缀命中（api.github.com）",
		evaluateEgress({ kind: "infra", host: "api.github.com", policy: allowlisted }).reason === "allowlisted");
	ok("白名单档：后缀必须按标签边界（github.com.evil.com 不算）",
		evaluateEgress({ kind: "infra", host: "github.com.evil.com", policy: allowlisted }).decision === "deny");
	ok("白名单档：IP 只精确匹配（110.0.0.5 不算）",
		evaluateEgress({ kind: "infra", host: "10.0.0.5", policy: allowlisted }).decision === "allow"
		&& evaluateEgress({ kind: "infra", host: "110.0.0.5", policy: allowlisted }).decision === "deny");
	ok("白名单档：未列出的主机被拦（not_allowed）",
		evaluateEgress({ kind: "infra", host: "registry.npmjs.org", policy: allowlisted }).reason === "not_allowed");
	ok("放行档：基础设施也放行",
		evaluateEgress({ kind: "infra", host: "anything.example", policy: defaultPolicy() }).reason === "allow-all");
	ok("冻结档：本地路径/本地仓库不放拦（不是出站）",
		evaluateEgress({ kind: "infra", local: true, policy: frozen }).reason === "local-source"
		&& describeSource("E:\\\\tmp\\\\origin.git").local === true
		&& describeSource("/tmp/origin.git").local === true
		&& describeSource("file:///tmp/origin.git").local === true);
	ok("冻结档：scp 语法（git@host:path）按网络目的地拦",
		describeSource("git@github.com:org/repo.git").host === "github.com"
		&& evaluateEgress({ kind: "infra", host: "github.com", policy: frozen }).decision === "deny");
	ok("describeSource：ssh:// 取主机；无法解析的字符串从严（非本地）",
		describeSource("ssh://git@github.com/org/repo.git").host === "github.com"
		&& describeSource("weird-thing").local === false);

	// 3. 策略文件读写（原子 + 归一化）
	const written = writePolicy(home, { mode: "allowlist", allowHosts: [" GitHub.com. ", "github.com", "10.0.0.5"] });
	ok("写策略：去重 + 归一化（大小写/尾点/空格）",
		written.allowHosts.join(",") === "10.0.0.5,github.com", JSON.stringify(written.allowHosts));
	ok("写策略：落盘可回读，且带 updatedAt",
		existsSync(policyPath(home)) && readPolicy(home).policy.mode === "allowlist" && written.updatedAt !== "");
	let rejected = false;
	try { writePolicy(home, { mode: "nonsense" }); } catch { rejected = true; }
	ok("写策略：未知档位直接拒绝（不静默降级）", rejected);
	writeFileSync(policyPath(home), "{ broken json", "utf8");
	ok("策略文件损坏→回默认档并标注 policy-invalid",
		readPolicy(home).policy.mode === "allow" && readPolicy(home).source === "policy-invalid");

	// 4. URL 取 host
	ok("hostOf 解析 URL；非法输入给空串", hostOf("https://GitHub.com/a/b") === "github.com" && hostOf("not a url") === "");
	ok("hostAllowed 对空规则/空主机返回 false", hostAllowed("", ["github.com"]) === false && hostAllowed("github.com", ["", "  "]) === false);

	// 5. 审计：留痕、归一化、只读最近 N 条
	rmSync(policyPath(home), { force: true });
	const first = checkEgress(home, { plugin: "dsh-knowledge-hub", kind: "infra", host: "GitHub.com", note: "sync" });
	ok("checkEgress 一步完成判定+留痕（默认档放行）",
		first.decision === "allow" && first.policySource === "policy-missing" && readAudit(home, 10).length === 1);
	writePolicy(home, { mode: "frozen" });
	const second = checkEgress(home, { plugin: "dsh-knowledge-hub", kind: "infra", host: "github.com" });
	ok("冻结后同一主机立刻变拦截（字段真被读取，不是写死）",
		second.decision === "deny" && second.reason === "infra_frozen");
	const rows = readAudit(home, 10);
	ok("审计行含 plugin/kind/host/decision/reason/mode 且主机已归一化",
		rows.length === 2 && rows[1].plugin === "dsh-knowledge-hub" && rows[1].host === "github.com"
		&& rows[1].decision === "deny" && rows[1].mode === "frozen");
	appendAudit(home, { plugin: "x", kind: "target", host: "target.example", decision: "allow", reason: "target-traffic" });
	ok("readAudit 只回最近 N 条", readAudit(home, 1).length === 1 && readAudit(home, 1)[0].host === "target.example");

	// 6. 轮转：超过阈值后归档成 .1，当前文件回落
	rmSync(auditPath(home), { force: true });
	rmSync(`${auditPath(home)}.1`, { force: true });
	const filler = JSON.stringify({ at: "x", plugin: "filler", host: "h", decision: "allow", reason: "allow-all", mode: "allow", note: "y".repeat(120) }) + "\n";
	let batch = "";
	while (batch.length < AUDIT_MAX_BYTES + 4096) batch += filler;
	mkdirSync(join(home, "saker-egress"), { recursive: true });
	writeFileSync(auditPath(home), batch, "utf8");
	appendAudit(home, { plugin: "after-rotate", kind: "infra", host: "github.com", decision: "deny", reason: "infra_frozen", mode: "frozen" });
	ok("审计超限轮转成 .1 并重新开始记",
		existsSync(`${auditPath(home)}.1`) && statSync(auditPath(home)).size < 4096
		&& readFileSync(auditPath(home), "utf8").includes("after-rotate"));
} finally {
	rmSync(home, { recursive: true, force: true });
}

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
