
// ── 平台数据根（$DSH_HOME）────────────────────────────────────────────
// 宿主按 $DSH_HOME 装配 profiles/会话/存储；插件一律跟随，避免「一半落 A 一半落 B」。
// 未设置时等价于 ~/.dsh，故对既有用户是零行为变更。
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
// dsh-hunter「hunter狩猎」宿主插件：
//   1) Web 通道：/dsh-hunter 前缀路由（同源信任栅栏）——设置/查询/导出/实测/历史 RPC；
//   2) 存储：独立 SQLite ~/.dsh/hunter/hunter.db（API key + 实测历史 + 授权白名单）；
//   3) 实测流水线：读 redteam-results 同一 results.db 取 finding → 指纹搜索 → 存活探测 →
//      L0/L1 分级验证 → 回写 retestNote/evidence/status + 历史 + 会话 followup 通知。
//
// 授权边界：互联网资产仅 L0（GET 首页+指纹）；L1 最小影响验证
// 仅对用户标记授权的资产；L2 完整 EXP 不做。

import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import { isIP } from "node:net";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { parseScope, scopeSafeAsset, upsertAssets } from "dsh-saker/asset-inventory";
import { openHunterStore, configView, getKey, nowIso } from "./store.js";
import { buildQueries, searchFofaPage, searchHunterPage, searchQuakePage, mergeAssets, fofaGuard, LIMITS, daysAgoStamp, nowStamp } from "./adapters.js";
import { parseFingerprint, fingerprintQuery, fingerprintLadder, searchWithRelax, verifyPipeline, SEARCH_BUDGET } from "./verify.js";
import { openStore as openResultsStore, getFinding, updateFinding } from "@dsh-external/dsh-redteam-results/store";

/**
 * Resolve a tool's `workspace` argument to an absolute path, with **relative paths
 * resolved against the SESSION workspace**.
 *
 * Why (2026-09-25, real model session): `path.resolve(arg)` resolves a relative value
 * against the HOST PROCESS cwd — the dsh source checkout / install directory, not the
 * model's working directory. A relative `workspace` would put the asset ledger outside
 * the session workspace, where the workbench, the report gate, and the write boundary
 * never look. Absolute paths are unchanged.
 */
function resolveWorkspaceArg(workspace, exec) {
	const raw = String(workspace ?? "").trim();
	const base = exec?.agent?.session?.header?.cwd;
	if (raw === "") return path.resolve(base ?? ".");
	return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(base ?? ".", raw);
}

const name = "dsh-hunter";
const inject = ["webServer", "webRuntime", "tools"];

const ROUTE_PATH = "/dsh-hunter";
/** 进程级 CSRF token：GET <route>/csrf 由同源页取走（跨源响应不可读），POST 须回带 x-dsh-csrf 头。 */
const CSRF_TOKEN = crypto.randomBytes(24).toString("hex");
export function checkCsrf(req, token) {
	return String(req?.headers?.["x-dsh-csrf"] ?? "") === String(token ?? "");
}
const DB_PATH = path.join(DSH_HOME, "hunter", "hunter.db");
const RESULTS_DB_PATH = path.join(DSH_HOME, "redteam-results", "results.db");

function stamp() {
	return new Date().toISOString().replace(/[-:.]/g, "").slice(0, 17) + "-" + crypto.randomBytes(4).toString("hex");
}

function appendEvidence(workspace, how, file) {
	const evidenceFile = path.join(workspace, "evidence-index.md");
	let head = "";
	try {
		head = fs.readFileSync(evidenceFile, "utf8");
	} catch {
		head = "# 证据索引\n\n| 编号 | 时间 | 证据 | 产生方式 | 交接/消费 |\n|---|---|---|---|---|\n";
	}
	const id = `recon-${stamp()}`;
	fs.writeFileSync(evidenceFile, head + `| ${id} | ${new Date().toISOString()} | ${file} | ${how} | 资产清单 |\n`);
	return id;
}

let store;
function theStore() {
	if (store === undefined) store = openHunterStore(DB_PATH);
	return store;
}
export function closeSharedStore() {
	if (store !== undefined) {
		store.close();
		store = undefined;
	}
}
let resultsStore;
function theResultsStore() {
	if (resultsStore === undefined) resultsStore = openResultsStore(RESULTS_DB_PATH);
	return resultsStore;
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

function hostOf(headers) {
	const h = headers?.host;
	return typeof h === "string" ? h : "";
}

function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** 同源信任栅栏：Host 是本机/受信授权，且 Origin（浏览器跨站标记）与 Host 同源。 */
function isTrustedRequest(req, trustedHosts) {
	const host = hostOf(req.headers);
	if (host === "") return false;
	let hostUrl;
	try { hostUrl = new URL(`http://${host}`); } catch { return false; }
	const okHost = isLoopbackHostname(hostUrl.hostname) || (trustedHosts ?? []).some((t) => {
		try { return new URL(`http://${t}`).hostname === hostUrl.hostname; } catch { return false; }
	});
	if (!okHost) return false;
	const origin = req.headers?.origin;
	if (typeof origin === "string" && origin !== "null") {
		try {
			const originUrl = new URL(origin);
			if (originUrl.host !== hostUrl.host) return false; // 含端口：本机他端口页面的 Origin 不放行
		} catch { return false; }
	}
	return true;
}

const SEARCH_PLATFORMS = ["fofa", "hunter", "quake"];
const MAX_SCOPED_QUERY_CHARS = 3500;
const FOFA_MIN_REQUEST_INTERVAL_MS = 1100;
let fofaLastRequestAt = 0;
let fofaRequestTail = Promise.resolve();

function selectedPlatforms(platform) {
	if (platform === undefined || platform === null || platform === "" || platform === "all") return SEARCH_PLATFORMS;
	if (SEARCH_PLATFORMS.includes(platform)) return [platform];
	throw new Error("platform 必须是 fofa/hunter/quake/all");
}

function validateScopeTerms(scope) {
	const terms = parseScope(scope);
	if (terms.length === 0) throw new Error("scope 不含可识别的域名、IP 或 IPv4 CIDR");
	for (const raw of terms) {
		const wildcard = raw.startsWith("*.");
		const term = wildcard ? raw.slice(2) : raw;
		if (wildcard && (term.includes("/") || isIP(term))) throw new Error(`通配符 scope 只支持域名：${raw}`);
		if (isIP(term)) continue;
		if (term.includes("/")) {
			const [network, prefix, extra] = term.split("/");
			if (extra !== undefined || isIP(network) !== 4 || !/^\d{1,2}$/.test(prefix) || Number(prefix) > 32) {
				throw new Error(`scope 项无效：${term}`);
			}
			continue;
		}
		if (term.length > 253 || !term.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) {
			throw new Error(`scope 项无效：${term}`);
		}
	}
	return terms;
}

function scopeClause(term, platform) {
	const value = term.startsWith("*.") ? term.slice(2) : term;
	const isIp = value.includes("/") || isIP(value) !== 0;
	const field = isIp ? "ip" : "domain";
	return platform === "quake" ? `${field}:"${value}"` : `${field}="${value}"`;
}

function joinScopedQuery(query, terms, platform) {
	if (terms.length === 0) return query;
	const or = platform === "quake" ? " OR " : " || ";
	const and = platform === "quake" ? " AND " : " && ";
	return `(${query})${and}(${terms.map((term) => scopeClause(term, platform)).join(or)})`;
}

function scopeTermGroups(query, terms, platform) {
	if (terms.length === 0) return [[]];
	const groups = [];
	let current = [];
	for (const term of terms) {
		const candidate = [...current, term];
		if (current.length > 0 && (candidate.length > 40 || joinScopedQuery(query, candidate, platform).length > MAX_SCOPED_QUERY_CHARS)) {
			groups.push(current);
			current = [term];
		} else current = candidate;
		if (joinScopedQuery(query, current, platform).length > MAX_SCOPED_QUERY_CHARS) {
			throw new Error("查询与一个授权范围项组合后超过 3500 字符；请缩短查询或拆分范围");
		}
	}
	if (current.length) groups.push(current);
	return groups;
}

async function searchFofaRateLimited(key, query, size) {
	let release;
	const previous = fofaRequestTail;
	fofaRequestTail = new Promise((resolve) => { release = resolve; });
	await previous;
	try {
		const waitMs = Math.max(0, FOFA_MIN_REQUEST_INTERVAL_MS - (Date.now() - fofaLastRequestAt));
		if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
		fofaLastRequestAt = Date.now();
		return await searchFofaPage(key, fofaGuard(query), size);
	} finally {
		release();
	}
}

/** 各平台 key 已配置清单 + 并发搜索；scope 作为一个 OR 组加入查询，缩减比赛资产清单的 API 次数。 */
async function runSearch(p, st) {
	const query = String(p.query ?? "").trim();
	if (!query) throw new Error("查询为空");
	const mode = p.mode === "native" ? "native" : "dsl";
	const queries = buildQueries(query, mode);
	const platforms = selectedPlatforms(p.platform);
	if (mode === "native" && platforms.length !== 1) {
		throw new Error("native 查询必须明确指定一个 platform，避免同一原生语法被误发到其他平台");
	}
	const size = Math.min(Number(p.size) || SEARCH_BUDGET, 500);
	const scopeTerms = p.scope ? validateScopeTerms(p.scope) : [];
	const supportedPlatforms = platforms.filter((platform) => String(queries[platform] ?? "").trim());
	const unsupported = platforms.filter((platform) => !String(queries[platform] ?? "").trim())
		.map((platform) => ({ platform, scopeTerms: [], query: "", rows: [], error: `该 DSL 查询包含 ${platform} 不支持的字段；平台未收到请求` }));
	const termsByPlatform = new Map(supportedPlatforms.map((platform) => [platform, scopeTermGroups(queries[platform], scopeTerms, platform)]));
	const maxGroups = Math.max(0, ...[...termsByPlatform.values()].map((groups) => groups.length));
	if (maxGroups > size) throw new Error(`授权范围拆成 ${maxGroups} 组，超过本次 ${size} 条结果预算；请分批提交 scope 或提高 size`);
	const jobs = [];
	const push = (platform, terms, budget, query, fn) => {
		const key = getKey(st, platform);
		if (!key) return;
		jobs.push(fn(key, query, budget).then((result) => ({ platform, scopeTerms: terms, query, rows: result.rows, total: result.total }))
			.catch((e) => ({ platform, scopeTerms: terms, query, rows: [], error: String(e?.message ?? e) })));
	};
	for (const platform of supportedPlatforms) {
		const groups = termsByPlatform.get(platform);
		const budgets = groups.map((_, index) => Math.floor(size / groups.length) + (index < size % groups.length ? 1 : 0));
		for (const [index, terms] of groups.entries()) {
			const budget = budgets[index] ?? size;
			const q = joinScopedQuery(queries[platform], terms, platform);
			if (platform === "fofa") push(platform, terms, budget, q, searchFofaRateLimited);
			else if (platform === "hunter") push(platform, terms, budget, q, (key, queryText, resultSize) => searchHunterPage(key, queryText, 1, Math.min(resultSize, LIMITS.hunter.pageSize)).then((r) => ({ rows: r.rows.slice(0, resultSize), total: r.total })));
			else push(platform, terms, budget, q, (key, queryText, resultSize) => searchQuakePage(key, queryText, 0, Math.min(resultSize, LIMITS.quake.pageSize)).then((r) => ({ rows: r.rows.slice(0, resultSize), total: r.total })));
		}
	}
	if (jobs.length === 0) {
		if (unsupported.length) throw new Error(`没有所选平台能执行这组字段；${unsupported.map((item) => `${item.platform}: ${item.error}`).join("；")}`);
		throw new Error("未配置任何可执行该查询的平台 API——先配置对应 FOFA/Hunter/Quake key");
	}
	const results = [...unsupported, ...await Promise.all(jobs)];
	const errors = results.filter((r) => r.error);
	const successful = results.filter((r) => !r.error);
	if (successful.length === 0) {
		throw new Error(`所有已配置平台搜索失败：${errors.map((r) => `${r.platform}=${r.error}`).join("；")}`);
	}
	const providerRows = results.filter((r) => !r.error).map((r) => normalizeRows(r.platform, r.rows));
	const scopedRows = providerRows.map((rows) => scopeTerms.length ? scopeFilteredAssets(rows, p.scope) : { inScope: rows, outOfScope: [] });
	const scopedAssets = scopedRows.flatMap((group) => group.inScope);
	const outOfScopeCount = scopedRows.reduce((sum, group) => sum + group.outOfScope.length, 0);
	const assets = mergeAssets(...scopedRows.map((group) => group.inScope));
	return {
		queries,
		effectiveQueries: results.map((r) => ({ platform: r.platform, scopeTerms: r.scopeTerms, query: r.query || "", error: r.error || "" })),
		assets,
		scopedAssets,
		outOfScopeCount,
		platformErrors: errors.map((r) => ({ platform: r.platform, scopeTerms: r.scopeTerms, error: r.error })),
		configuredPlatforms: platforms.filter((platform) => Boolean(getKey(st, platform))),
		successfulPlatforms: [...new Set(successful.map((r) => r.platform))]
	};
}

function normalizeRows(platform, rows) {
	// adapters 的归一化内联在 search 函数里；这里按平台映射输出统一行。
	return rows.map((r) => {
		if (platform === "fofa") {
			return { host: String(r[0] ?? ""), title: String(r[1] ?? ""), ip: String(r[2] ?? ""), domain: String(r[3] ?? ""), port: String(r[4] ?? ""), protocol: String(r[5] ?? ""), server: String(r[6] ?? ""), platform };
		}
		if (platform === "hunter") {
			return { host: String(r.url ?? ""), title: String(r.web_title ?? ""), ip: String(r.ip ?? ""), domain: String(r.domain ?? ""), port: String(r.port ?? ""), protocol: String(r.protocol ?? ""), server: String(r.web_server ?? ""), isp: String(r.isp ?? ""), time: String(r.updated_at ?? ""), platform };
		}
		return { host: "", title: String(r.service?.[0]?.http?.title ?? ""), ip: String(r.ip ?? ""), domain: String(r.domain ?? ""), port: String(r.port ?? ""), protocol: String(r.service?.[0]?.name ?? ""), server: String(r.service?.[0]?.http?.server ?? ""), isp: String(r.isp ?? ""), time: String(r.time ?? ""), platform };
	});
}

/** 实测：读 finding → 指纹 → 搜索 → 流水线 → 回写 + 历史 + followup。 */
/** 实测防重：sessionId:findingId → 最近执行时间（10 分钟窗口——流水线含搜索+最多 50 资产探测，防连点并发重复扣平台配额）。 */
const LIVE_VERIFY_SENT = new Map();
const LIVE_VERIFY_WINDOW_MS = 10 * 60 * 1000;

/** Build the finding patch from one live-verification result. Kept pure for regression tests. */
export function buildFindingPatch(finding, result) {
	const note = `[实测] ${nowIso().slice(0, 19)} ${result.summary}`;
	const patch = {
		retestNote: note,
		evidence: [finding.evidence, `实测:${result.verdict} (L0=${result.detail?.l0Hits ?? 0}/L1=${result.detail?.l1Passed ?? 0})`].filter(Boolean).join("；"),
	};
	if (result.verdict === "l1-passed") {
		patch.status = "verified";
		patch.auditMode = "dynamic";
		// Hunter 的 L1 是独立动态通道复核，仍须满足成果库的成对校验：
		// 评级沿用首次等级（未观察到降/升级），依据写清动态复现方式。
		patch.secondRating = finding.severity;
		patch.secondRatingNote = `独立 L1 实测复核：${result.summary || "授权资产最小影响验证通过"}；动态通道重新触发成功，现象与首次结论一致。`;
	}
	return patch;
}

function assetSearchText(result) {
	if (!result.ok) return `asset_search 失败：${result.error}`;
	const lines = [
		`资产搜索完成：范围内 ${result.inScope} 条 / 范围外 ${result.outOfScope} 条。`,
		`- 查询：${result.query}`,
		`- 平台：${(result.platforms || []).join(", ") || "无"}`,
		`- 账本：${result.inventoryFile}（累计 ${result.inventoryTotal} 条）`,
		`- 范围内结果：${result.rawFile}`,
	];
	if (result.platformErrors?.length) {
		lines.push(`- 平台告警：${result.platformErrors.map((item) => `${item.platform}:${item.error}`).join("；")}`);
	}
	lines.push("", "前 10 条范围内资产：");
	for (const asset of result.assets.slice(0, 10)) {
		lines.push(`- ${asset.target || asset.host} ${asset.title ? `「${asset.title}」` : ""} ${asset.ip || ""}:${asset.port || ""} [${(asset.tech || []).join(", ")}]`);
	}
	if (result.assets.length === 0) lines.push("- （无）");
	return lines.join("\n");
}

function scopeFilteredAssets(assets, scope) {
	const inScope = [];
	const outOfScope = [];
	for (const asset of assets) {
		const safeAsset = scopeSafeAsset(asset, scope);
		if (safeAsset) inScope.push(safeAsset);
		else outOfScope.push(asset);
	}
	return { inScope, outOfScope };
}

async function runVerify(ctx, p) {
	const sessionId = String(p.sessionId ?? "");
	const findingId = String(p.findingId ?? "");
	if (!sessionId || !findingId) throw new Error("sessionId/findingId required");
	const rst = theResultsStore();
	const finding = getFinding(rst, sessionId, findingId);
	if (!finding) throw new Error("finding 不存在");
	if (finding.mode !== "code-audit") throw new Error("实测仅支持 code-audit 模式 finding");
	const vkey = `${sessionId}:${findingId}`;
	const lastRun = LIVE_VERIFY_SENT.get(vkey) ?? 0;
	if (Date.now() - lastRun < LIVE_VERIFY_WINDOW_MS) throw new Error("实测已在此前 10 分钟内执行——请稍后再试（重复执行会重复消耗平台配额）");
	LIVE_VERIFY_SENT.set(vkey, Date.now());

	const fp = parseFingerprint(finding.poc);
	const query = fingerprintQuery(fp);
	if (query === null) throw new Error("finding.poc 缺「指纹:」节——无法生成特征查询（audit-playbook 约定：指纹:framework=xxx,title=\"特征\"）");

	const st = theStore();
	const platforms = ["fofa", "hunter", "quake"].filter((pl) => getKey(st, pl));
	if (platforms.length === 0) throw new Error("未配置任何平台 API——先到「hunter 狩猎」页右上角设置配置");

	const allMode = p.allMode === true;
	const dynamic = finding.auditMode === "dynamic";

	// 互联网侧寻源：主特征查询零命中时按阶梯放宽（单一特征→框架名）自动续搜，衔接后续 L0/L1。
	const searchOnce = async (dsl) => {
		const queries = buildQueries(dsl, "dsl");
		const jobs = platforms.map((pl) => {
			const key = getKey(st, pl);
			if (pl === "fofa") return searchFofaPage(key, fofaGuard(queries.fofa), SEARCH_BUDGET).then((r) => r.rows.map(normalizeFofaRow));
			if (pl === "hunter") return searchHunterPage(key, queries.hunter, 1, SEARCH_BUDGET).then((r) => r.rows.map(normalizeHunterRow));
			return searchQuakePage(key, queries.quake, 0, SEARCH_BUDGET).then((r) => r.rows.map(normalizeQuakeRow));
		});
		const settled = await Promise.all(jobs.map((j) => j.catch((e) => ({ error: String(e?.message ?? e), rows: [] }))));
		const ok = settled.filter((r) => !r.error);
		const errs = settled.filter((r) => r.error);
		if (ok.length === 0) throw new Error("全部平台搜索失败: " + errs[0]?.error);
		return mergeAssets(...ok.map((r) => r.rows));
	};
	let relaxHit = null;
	const searchFn = async () => {
		const r = await searchWithRelax(searchOnce, fingerprintLadder(fp));
		relaxHit = r.hit;
		return r.assets;
	};

	let result;
	if (dynamic) {
		// 动态审计=影响面评估：搜→探测→统计，不执行 L1。
		result = await verifyPipeline(searchFn, async () => new Set(), {
			budget: SEARCH_BUDGET, allMode: true, stopOnFirstL0: false, fingerprint: fp,
			onProgress: () => {}
		});
		result.verdict = result.verdict === "l0-confirmed" ? "impact-mapped" : result.verdict;
		result.summary = result.detail?.l0Hits > 0
			? `影响面评估：${result.detail.searched} 个候选资产中 ${result.detail.l0Hits} 个存活且框架指纹一致（动态审计 EXP 已在本地复现，不重复验证）`
			: result.summary;
	} else {
		result = await verifyPipeline(searchFn, async () => new Set(st.listAuthorized.all().map((a) => a.key)), {
			budget: SEARCH_BUDGET, allMode, stopOnFirstL0: false, fingerprint: fp,
			onProgress: () => {}
		});
	}

	// 放宽寻源信息并入结论（summary/detail），历史登记实际命中的查询串。
	if (relaxHit) result.summary += `（主特征零命中，放宽至「${relaxHit.label}」后从互联网侧命中资产）`;
	if (result.detail && typeof result.detail === "object") result.detail.relax = relaxHit ? { level: relaxHit.level, label: relaxHit.label, query: relaxHit.query } : null;

	// 回写 finding（数据变更）
	const patch = buildFindingPatch(finding, result);
	updateFinding(rst, sessionId, finding.mode, findingId, patch);

	// 历史
	st.insertHistory.run(nowIso(), findingId, finding.mode, relaxHit ? relaxHit.query : query, platforms.join(","), result.verdict, JSON.stringify({ summary: result.summary, detail: result.detail }));

	// 会话通知（原会话可达时 followup）
	let notified = false;
	try {
		const agents = ctx.get("agents");
		const agent = agents?.get?.(sessionId);
		if (agent && typeof agent.followup === "function") {
			// 注入安全：本调用在 RPC 端点处理器内（页面触发实测流水线），不在 Session.append 临界区里。
			agent.followup({
				id: `hunter-${Date.now()}-${finding.seq}`,
				role: "user",
				content: [{ type: "text", text: `[hunter 实测] finding #${finding.seq}「${finding.title}」：${result.summary}\n细节：${JSON.stringify(result.detail)}\n建议：${result.suggestions.join("；")}` }],
				source: { kind: "user" }
			});
			notified = true;
		}
	} catch { /* 会话不可达 → 仅页面通知 */ }

	return { ok: true, verdict: result.verdict, summary: result.summary, detail: result.detail, suggestions: result.suggestions, notified, query };
}

const normalizeFofaRow = (r) => ({ host: String(r[0] ?? ""), title: String(r[1] ?? ""), ip: String(r[2] ?? ""), domain: String(r[3] ?? ""), port: String(r[4] ?? ""), protocol: String(r[5] ?? ""), server: String(r[6] ?? ""), isp: String(r[7] ?? ""), time: String(r[10] ?? ""), platform: "fofa" });
const normalizeHunterRow = (r) => ({ host: String(r.url ?? ""), title: String(r.web_title ?? ""), ip: String(r.ip ?? ""), domain: String(r.domain ?? ""), port: String(r.port ?? ""), protocol: String(r.protocol ?? ""), server: String(r.web_server ?? ""), isp: String(r.isp ?? ""), time: String(r.updated_at ?? ""), platform: "hunter" });
const normalizeQuakeRow = (r) => ({ host: String(r.service?.[0]?.http?.host ?? ""), title: String(r.service?.[0]?.http?.title ?? ""), ip: String(r.ip ?? ""), domain: String(r.domain ?? ""), port: String(r.port ?? ""), protocol: String(r.service?.[0]?.name ?? ""), server: String(r.service?.[0]?.http?.server ?? ""), isp: String(r.isp ?? ""), time: String(r.time ?? ""), platform: "quake" });

/** 平台 key 校验：一页小请求验 key 与额度。 */
async function testKey(platform, key) {
	try {
		if (platform === "fofa") {
			const res = await fetch(`https://fofa.info/api/v1/info/my?key=${encodeURIComponent(key)}`, { signal: AbortSignal.timeout(8000) });
			const data = await res.json();
			if (data.error) return { ok: false, error: `FOFA: ${data.errmsg}` };
			return { ok: true, info: `FOFA 已连接${data.remain_api_query ? `，剩余查询 ${data.remain_api_query}` : ""}` };
		}
		if (platform === "hunter") {
			const r = await searchHunterPage(key, `web.title="a"`, 1, 1, { startTime: daysAgoStamp(1), endTime: nowStamp() });
			return { ok: true, info: `Hunter 已连接（样例查询命中 ${r.total} 条）` };
		}
		const r = await searchQuakePage(key, `title:"a"`, 0, 1);
		return { ok: true, info: `Quake 已连接（样例查询命中 ${r.total} 条）` };
	} catch (e) {
		return { ok: false, error: String(e?.message ?? e) };
	}
}

export async function dispatch(ctx, st, endpoint, payload) {
	const p = payload ?? {};
	if (endpoint === "config.get") return { config: configView(st), platforms: ["fofa", "hunter", "quake"] };
	if (endpoint === "config.set") {
		const platform = String(p.platform ?? "");
		if (!["fofa", "hunter", "quake"].includes(platform)) throw new Error("platform 必须是 fofa/hunter/quake");
		const key = String(p.key ?? "").trim();
		if (key) {
			const test = await testKey(platform, key);
			if (!test.ok) throw new Error(`校验失败：${test.error}`);
		}
		st.setKey.run(platform, key, nowIso());
		return { ok: true, config: configView(st) };
	}
	if (endpoint === "config.test") {
		const platform = String(p.platform ?? "");
		const key = p.key !== undefined ? String(p.key) : getKey(st, platform);
		if (!key) throw new Error("该平台未配置 key");
		const r = await testKey(platform, key);
		return r.ok ? { ok: true, info: r.info } : { ok: false, error: r.error };
	}
	if (endpoint === "search") {
		const { queries, assets, platformErrors } = await runSearch(p, st);
		return { ok: true, queries, assets, platformErrors, limits: LIMITS };
	}
	if (endpoint === "export") {
		const { assets, platformErrors } = await runSearch(p, st);
		const format = p.format === "json" ? "json" : "csv";
		if (format === "json") return { ok: true, format, text: JSON.stringify(assets, null, 2) };
		const head = ["host", "ip", "port", "protocol", "title", "server", "domain", "isp", "time", "platforms"];
		const lines = [head.join(","), ...assets.map((a) => head.map((h) => `"${String(a[h] ?? (h === "platforms" ? (a.platforms ?? [a.platform]).join("|") : "")).replace(/"/g, '""')}"`).join(","))];
		return { ok: true, format, text: lines.join("\n"), platformErrors };
	}
	if (endpoint === "verify.live") return runVerify(ctx, p);
	if (endpoint === "history.list") return { ok: true, history: st.listHistory.all(Number(p.limit) || 50) };
	if (endpoint === "authorized.list") return { ok: true, authorized: st.listAuthorized.all() };
	if (endpoint === "authorized.add") {
		const key = `${String(p.ip ?? "").trim()}:${String(p.port ?? "").trim()}`;
		if (!p.ip || !p.port) throw new Error("ip/port required");
		st.authorize.run(key, String(p.note ?? ""), nowIso());
		return { ok: true, authorized: st.listAuthorized.all() };
	}
	if (endpoint === "authorized.remove") {
		st.unauthorize.run(String(p.key ?? ""));
		return { ok: true, authorized: st.listAuthorized.all() };
	}
	throw new Error(`unknown endpoint ${endpoint}`);
}

function apply(ctx) {
	const trustedHosts = () => {
		try { return ctx.webRuntime?.trustedHosts ?? []; } catch { return []; }
	};
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: ROUTE_PATH,
		handler: async (req, res) => {
			const send = (code, body) => {
				const text = typeof body === "string" ? body : JSON.stringify(body);
				res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
				res.end(text);
			};
			if (!isTrustedRequest(req, trustedHosts())) { res.writeHead(403); res.end("forbidden"); return; }
			let csrfPath = "";
			try { csrfPath = new URL(req.url ?? "/", "http://x").pathname; } catch { csrfPath = ""; }
			if (req.method === "GET" && csrfPath === ROUTE_PATH + "/csrf") { send(200, { token: CSRF_TOKEN }); return; }
			if (req.method !== "POST") { res.writeHead(405); res.end("method not allowed"); return; }
			if (!checkCsrf(req, CSRF_TOKEN)) { res.writeHead(403); res.end("csrf token missing or invalid"); return; }
			let endpoint = "";
			try { endpoint = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname.slice(ROUTE_PATH.length)).replace(/^\/+/, ""); } catch { endpoint = ""; }
			if (endpoint === "") { res.writeHead(404); res.end("not found"); return; }
			try {
				const raw = await readBody(req);
				const payload = raw === "" ? {} : JSON.parse(raw);
				const result = await dispatch(ctx, theStore(), endpoint, payload);
				send(200, result);
			} catch (e) {
				send(400, { ok: false, error: e?.message ?? String(e) });
			}
		}
	}), "dsh-hunter: web route");

	ctx.tools.register(defineTool({
		name: "asset_search",
		description: "Query configured FOFA / 奇安信 Hunter / 360 Quake platforms with one DSL, filter results to an explicit authorized scope, and merge them into the workspace asset-inventory.json. This is passive public-index search: it sends no traffic to the targets. If no platform key is configured it fails with the fallback recon ladder instead of pretending success.",
		parameters: {
			query: { type: "string", required: true, description: "Unified DSL query, e.g. domain=\"example.com\" && title=\"OA\"" },
			scope: { type: "string", required: true, description: "Authorized scope: comma/newline separated exact domains, IPs or IPv4 CIDRs. A bare domain matches only itself; *.example.com matches explicitly authorized subdomains, not the apex. Out-of-scope results are counted but not written." },
			workspace: { type: "string", required: true, description: "Task workspace root (asset-inventory.json / assets.md / artifacts land here)" },
			mode: { type: "string", enum: ["dsl", "native"], description: "dsl converts unified fields; native sends the query to each platform as-is" },
			platform: { type: "string", enum: ["all", "fofa", "hunter", "quake"], description: "Search all configured platforms or only one; default all" },
			size: { type: "integer", description: "Per-platform result budget (default platform search budget, max 500)" },
		},
		output: {
			schema: { type: "object", additionalProperties: true },
			render: (_args, value) => [{ type: "text", text: assetSearchText(value) }],
		},
		async execute(args, exec) {
			if (!String(args.workspace || "").trim()) return { ok: false, error: "workspace 不能为空" };
			const workspace = resolveWorkspaceArg(args.workspace, exec);
			if (!String(args.scope || "").trim()) return { ok: false, error: "scope 不能为空——资产检索必须限定授权范围" };
			const st = theStore();
			let requestedPlatforms;
			try { requestedPlatforms = selectedPlatforms(args.platform); } catch (error) { return { ok: false, error: error.message } }
			const configuredPlatforms = requestedPlatforms.filter((platform) => getKey(st, platform));
			if (configuredPlatforms.length === 0) {
				return {
					ok: false,
					degraded: true,
					error: "未配置 FOFA / Hunter / Quake API key；不能把空结果当成搜索成功。",
					next: [
						"降级：subfinder_enum 做被动子域枚举",
						"降级：httpx_probe 对已知域名做存活与指纹",
						"内网/网段：fscan_portscan 或 nmap_portscan",
						"已有 TScanPlus/fscan/nmap 导出时：用 asset_ingest 导入",
					],
				};
			}
			try {
				const result = await runSearch({
					query: args.query,
					scope: args.scope,
					mode: args.mode === "native" ? "native" : "dsl",
					platform: args.platform,
					size: args.size,
				}, st);
				const filtered = scopeFilteredAssets(result.assets, args.scope);
				const rawFile = path.join("artifacts", "recon", `asset-search-${stamp()}.json`);
				const rawAbs = path.join(workspace, rawFile);
				fs.mkdirSync(path.dirname(rawAbs), { recursive: true });
				fs.writeFileSync(rawAbs, JSON.stringify({
					query: args.query,
					scope: args.scope,
					queries: result.queries,
					effectiveQueries: result.effectiveQueries,
					assets: filtered.inScope,
					outOfScopeCount: filtered.outOfScope.length + result.outOfScopeCount,
					platformErrors: result.platformErrors,
				}, null, 2) + "\n", "utf8");
				const normalized = filtered.inScope.map((asset) => ({
					...asset,
					sources: asset.platforms || [asset.platform],
					rawFiles: [rawFile.replace(/\\/g, "/")],
				}));
				const written = upsertAssets(workspace, normalized, { source: "asset_search" });
				appendEvidence(workspace, `asset_search ${configuredPlatforms.join("+")} inScope=${filtered.inScope.length}`, rawFile.replace(/\\/g, "/"));
				return {
					ok: true,
					query: args.query,
					platforms: configuredPlatforms,
					successfulPlatforms: result.successfulPlatforms,
					effectiveQueries: result.effectiveQueries,
					platformErrors: result.platformErrors || [],
					inScope: filtered.inScope.length,
					outOfScope: filtered.outOfScope.length + result.outOfScopeCount,
					assets: filtered.inScope,
					rawFile: rawFile.replace(/\\/g, "/"),
					inventoryFile: path.relative(workspace, written.file).replace(/\\/g, "/"),
					inventoryTotal: written.inventory.assets.length,
					added: written.added,
					merged: written.merged,
				};
			} catch (error) {
				return { ok: false, error: String(error?.message || error) };
			}
		},
	}));

	ctx.tools.register(defineTool({
		name: "asset_search_batch",
		description: "Execute a bounded batch of platform-specific fingerprint queries inside one explicit authorized scope. It obeys provider rate limits, merges results into asset-inventory.json, and returns the per-query candidate map. Public-index search sends no traffic to targets.",
		parameters: {
			queries: {
				type: "array",
				required: true,
				description: "Query groups; each query is the shared DSL form, such as app:\"TongWeb\" or icon_hash:\"1234\".",
				items: {
					type: "object",
					properties: {
						id: { type: "string", required: true },
						query: { type: "string", required: true },
						basis: { type: "string" },
						entryIds: { type: "array", items: { type: "string" } },
					},
					additionalProperties: false,
				},
			},
			scope: { type: "string", required: true, description: "Authorized domains, IPs or IPv4 CIDRs. A bare domain is exact; *.example.com matches explicitly authorized subdomains, not the apex. The provider query is constrained and results are filtered again." },
			workspace: { type: "string", required: true, description: "Task workspace root" },
			platform: { type: "string", enum: ["all", "fofa", "hunter", "quake"], description: "Configured provider selection; default all" },
			size: { type: "integer", description: "Maximum rows per query and provider (default 50, cap 500)" },
			concurrency: { type: "integer", description: "Concurrent query groups for providers without a stricter rate limit (default 4, cap 5)" },
		},
		output: {
			schema: { type: "object", additionalProperties: true },
			render: (_args, value) => [{ type: "text", text: value?.text ?? (value?.ok ? "批量资产搜索完成" : `批量资产搜索失败：${value?.error ?? "unknown"}`) }],
		},
		async execute(args, exec) {
			if (!String(args.workspace || "").trim()) return { ok: false, error: "workspace 不能为空" };
			if (!String(args.scope || "").trim()) return { ok: false, error: "scope 不能为空——批量资产检索必须限定授权范围" };
			if (!Array.isArray(args.queries) || args.queries.length === 0) return { ok: false, error: "queries 必须是非空数组" };
			if (args.queries.length > 100) return { ok: false, error: "单批最多 100 个查询组；请分批继续" };
			let platforms;
			let scopeTerms;
			try {
				platforms = selectedPlatforms(args.platform);
				scopeTerms = validateScopeTerms(args.scope);
			} catch (error) { return { ok: false, error: String(error?.message || error) } }
			const workspace = resolveWorkspaceArg(args.workspace, exec);
			const st = theStore();
			const configuredPlatforms = platforms.filter((platform) => getKey(st, platform));
			if (configuredPlatforms.length === 0) return { ok: false, degraded: true, error: `未配置所选平台 API key（${platforms.join("/")}）；未执行搜索` };
			const seenIds = new Set();
			const queries = [];
			for (const [index, item] of args.queries.entries()) {
				const id = String(item?.id ?? `q${index + 1}`).trim();
				const query = String(item?.query ?? "").trim();
				if (!id || !query) return { ok: false, error: `queries[${index}] 必须包含非空 id 和 query` };
				if (seenIds.has(id)) return { ok: false, error: `查询 id 重复：${id}` };
				if (query.length > 1200) return { ok: false, error: `查询 ${id} 超过 1200 字符` };
				seenIds.add(id);
				const basis = String(item?.basis ?? "").trim().slice(0, 80);
				const entryIds = Array.isArray(item?.entryIds)
					? [...new Set(item.entryIds.map((value) => String(value ?? "").trim()).filter(Boolean))].slice(0, 100)
					: [];
				queries.push({ id, query, basis, entryIds });
			}
			const size = Math.min(Number(args.size) || 50, 500);
			const concurrency = Math.max(1, Math.min(5, Math.floor(Number(args.concurrency) || 4)));
			let estimatedRequests = 0;
			try {
				for (const item of queries) {
					const converted = buildQueries(item.query, "dsl");
					for (const platform of configuredPlatforms) {
						if (String(converted[platform] ?? "").trim()) estimatedRequests += scopeTermGroups(converted[platform], scopeTerms, platform).length;
					}
				}
			} catch (error) { return { ok: false, error: String(error?.message || error) } }
			if (estimatedRequests > 200) return { ok: false, error: `本批预计发送 ${estimatedRequests} 次平台 API 请求，超过单批上限 200；减少查询组或拆分授权范围` };

			const queryResults = Array(queries.length);
			let nextIndex = 0;
			const workerCount = Math.min(concurrency, queries.length);
			await Promise.all(Array.from({ length: workerCount }, async () => {
				while (nextIndex < queries.length) {
					const index = nextIndex++;
					const item = queries[index];
					try {
						const result = await runSearch({ query: item.query, scope: args.scope, mode: "dsl", platform: args.platform, size }, st);
						const filtered = scopeFilteredAssets(result.scopedAssets, args.scope);
						queryResults[index] = {
							id: item.id, query: item.query, basis: item.basis, entryIds: item.entryIds, ok: true,
							platforms: result.successfulPlatforms,
							effectiveQueries: result.effectiveQueries,
							assets: filtered.inScope,
							outOfScopeCount: filtered.outOfScope.length + result.outOfScopeCount,
							platformErrors: result.platformErrors || [],
						};
					} catch (error) {
						queryResults[index] = { id: item.id, query: item.query, basis: item.basis, entryIds: item.entryIds, ok: false, error: String(error?.message || error), assets: [] };
					}
				}
			}));
			const successfulQueries = queryResults.filter((result) => result?.ok);
			if (successfulQueries.length === 0) {
				return { ok: false, error: `全部 ${queries.length} 个查询组失败；没有把失败伪报成零资产`, queryResults };
			}
			const allAssets = successfulQueries.flatMap((result) => result.assets);
			const merged = mergeAssets(allAssets);
			const rawFile = path.join("artifacts", "recon", `asset-search-batch-${stamp()}.json`);
			const rawAbs = path.join(workspace, rawFile);
			fs.mkdirSync(path.dirname(rawAbs), { recursive: true });
			fs.writeFileSync(rawAbs, JSON.stringify({
				generatedAt: new Date().toISOString(), scope: args.scope, platform: args.platform || "all",
				estimatedRequests, queryResults,
			}, null, 2) + "\n", "utf8");
			const normalized = merged.map((asset) => ({
				...asset,
				sources: asset.platforms || [asset.platform],
				rawFiles: [rawFile.replace(/\\/g, "/")],
			}));
			const written = upsertAssets(workspace, normalized, { source: "asset_search_batch" });
			appendEvidence(workspace, `asset_search_batch ${successfulQueries.length}/${queries.length} queries inScope=${merged.length}`, rawFile.replace(/\\/g, "/"));
			const errors = queryResults.filter((result) => !result.ok).length
				+ queryResults.filter((result) => result.ok && result.platformErrors?.length).length;
			const text = [
				`asset_search_batch：${successfulQueries.length}/${queries.length} 个查询组成功，授权范围内 ${merged.length} 个去重资产，约 ${estimatedRequests} 次平台 API 请求。`,
				...(errors ? [`部分平台或查询失败 ${errors} 项；详见批次结果文件。`] : []),
				`结果：${rawFile.replace(/\\/g, "/")}`,
				`资产账本：${path.relative(workspace, written.file).replace(/\\/g, "/")}`,
			].join("\n");
			return {
				ok: true, partial: successfulQueries.length < queries.length || errors > 0,
				queryCount: queries.length, successfulQueries: successfulQueries.length,
				estimatedRequests, configuredPlatforms, assetCount: merged.length,
				queryResults, rawFile: rawFile.replace(/\\/g, "/"),
				inventoryFile: path.relative(workspace, written.file).replace(/\\/g, "/"),
				inventoryTotal: written.inventory.assets.length, text,
			};
		},
	}));
}

export { apply, inject, name, ROUTE_PATH, DB_PATH, openHunterStore, LIMITS, isTrustedRequest };
