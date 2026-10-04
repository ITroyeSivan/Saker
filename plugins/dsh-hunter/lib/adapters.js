// dsh-hunter adapters：三平台资产搜索适配层（纯函数，供宿主 RPC 与实测流水线共用）。
//
// 统一 DSL：`title:"x" body:"y" app:"n" port:8080 protocol:"http"` —— 字段:值，
// 含空格/特殊字符的值用双引号包裹；空格分隔=AND。高级模式=各平台原生语法直贴。
//
// 限额（页面与导出共用）：
//   FOFA   search/next 连续翻页 size≤1000；免费导出上限 10000 条/查询。
//   Hunter page_size≤100；积分制（1 积分/条），单次请求消耗积分。
//   Quake  单页≤100；积分制。
//
// 归一化：统一字段 host/ip/port/domain/protocol/title/server/isp/time/platform，
// 跨平台按 ip:port 去重合并（冲突字段取时间新者）。

import { parseQueryExpression, queryTerms, compileQueryExpression } from 'dsh-saker/query-expression';

const LIMITS = {
	fofa: { pageSize: 100, nextSize: 1000, freeExport: 10000 },
	hunter: { pageSize: 100, creditPerRow: 1 },
	quake: { pageSize: 100, creditPerRow: 1 }
};

const DSL_FIELDS = [
	"title", "body", "header", "app", "server", "port", "protocol", "domain", "ip", "host", "icp", "org", "asn", "city", "region", "cert", "icon_hash",
	// FOFA 高级指纹字段。其他平台没有等价语法时由调用层拒绝该平台，不能退化成范围内全量查询。
	"fid", "product", "product.version", "category", "header_hash", "banner_hash", "banner_fid",
	"banner", "jarm", "base_protocol", "status_code",
	"cert.issuer.org", "cert.issuer.cn", "cert.subject.org", "cert.subject.cn", "cert.domain", "cert.sn",
	"tls.ja3s", "tls.version",
];
const FOFA_ONLY_FIELDS = new Set([
	"host", "icp", "org", "asn", "city", "region", "icon_hash", "fid", "product", "product.version", "category", "header_hash", "banner_hash", "banner_fid",
	"banner", "jarm", "base_protocol", "status_code",
	"cert.issuer.org", "cert.issuer.cn", "cert.subject.org", "cert.subject.cn", "cert.domain", "cert.sn",
	"tls.ja3s", "tls.version",
]);

/** 统一 DSL 解析：返回字段映射；非法输入抛错（查询语法安全）。 */
export function parseDsl(input) {
	// Metadata view only. Compilation uses the complete tree, including repeated fields.
	return new Map(queryTerms(parseQueryExpression(input)).map(term => [term.field, term.value]));
}

/** 统一 DSL 字段映射 → 各平台原生语法。 */
function toFofaQuery(fields) {
	const parts = [];
	for (const [k, v] of fields) {
		const raw = String(v);
		const value = raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		const exact = ["domain", "host", "icp", "asn"].includes(k) || (k === "ip" && !raw.includes("/"));
		parts.push(`${k}${exact ? "==" : "="}"${value}"`);
	}
	return parts.join(" && ");
}

function toHunterQuery(fields) {
	if ([...fields.keys()].some((key) => FOFA_ONLY_FIELDS.has(key))) return "";
	const parts = [];
	for (const [k, v] of fields) {
		const sv = String(v).replace(/"/g, '\\"');
		if (["product", "product.version", "category", "header_hash", "banner_hash", "banner_fid", "icon_hash", "fid"].includes(k)) continue;
		if (k === "title") parts.push(`web.title="${sv}"`);
		else if (k === "body") parts.push(`web.body="${sv}"`);
		else if (k === "header") parts.push(`web.header="${sv}"`);
		else if (k === "app") parts.push(`app.name="${sv}"`);
		else if (k === "server") parts.push(`web.server="${sv}"`);
		else if (k === "port") parts.push(`ip.port="${sv}"`);
		else if (k === "protocol") parts.push(`protocol="${sv}"`);
		else if (k === "domain") parts.push(`domain="${sv}"`);
		else if (k === "ip") parts.push(`ip="${sv}"`);
		else if (k === "cert") parts.push(`cert="${sv}"`);
		// icon_hash Hunter 无等价字段 → 跳过（转换器允许字段缺失）
	}
	return parts.join(" && ");
}

function toQuakeQuery(fields) {
	if ([...fields.keys()].some((key) => FOFA_ONLY_FIELDS.has(key))) return "";
	const parts = [];
	for (const [k, v] of fields) {
		const sv = String(v).replace(/"/g, '\\"');
		if (["product", "product.version", "category", "header_hash", "banner_hash", "banner_fid", "fid"].includes(k)) continue;
		if (k === "title") parts.push(`title:"${sv}"`);
		else if (k === "body") parts.push(`body:"${sv}"`);
		else if (k === "header") parts.push(`header:"${sv}"`);
		else if (k === "app") parts.push(`app:"${sv}"`);
		else if (k === "server") parts.push(`server:"${sv}"`);
		else if (k === "port") parts.push(`port:"${sv}"`);
		else if (k === "protocol") parts.push(`protocol:"${sv}"`);
		else if (k === "domain") parts.push(`domain:"${sv}"`);
		else if (k === "ip") parts.push(`ip:"${sv}"`);
		else if (k === "cert") parts.push(`cert:"${sv}"`);
		else if (k === "icon_hash") parts.push(`icon_hash:"${sv}"`);
	}
	return parts.join(" AND ");
}

/** 查询描述 → 各平台查询串（native=平台原生语法直贴）。 */
export function buildQueries(query, mode = "dsl") {
	if (mode === "native") return { fofa: String(query), hunter: String(query), quake: String(query) };
	const tree = parseQueryExpression(query);
	return Object.fromEntries(['fofa', 'hunter', 'quake'].map(provider => [provider, compileQueryExpression(tree, provider)]));
}

function b64(s) {
	return Buffer.from(s, "utf8").toString("base64");
}

async function fetchJson(url, opts = {}, timeoutMs = 15000) {
	const ac = new AbortController();
	const t = setTimeout(() => ac.abort(), timeoutMs);
	try {
		const res = await fetch(url, { ...opts, signal: ac.signal, redirect: "follow" });
		const text = await res.text();
		let data;
		try { data = JSON.parse(text); } catch { data = { raw: text }; }
		if (!res.ok) {
			const msg = data?.errmsg || data?.message || data?.error || text.slice(0, 160);
			throw new Error(`${res.status}: ${msg}`);
		}
		return data;
	} finally {
		clearTimeout(t);
	}
}

/** FOFA search/next 一页（cursor 翻页）。 */
export async function searchFofaPage(key, query, size, nextCursor) {
	const url = "https://fofa.info/api/v1/search/next?key=" + encodeURIComponent(key)
		+ "&size=" + Math.min(Number(size) || LIMITS.fofa.nextSize, LIMITS.fofa.nextSize)
		// Stay within fields documented for all API tiers. lastupdatetime is
		// Professional-only and can reject otherwise valid Personal queries.
		+ "&fields=host,title,ip,domain,port,protocol,server,icp,asn,org,city,region,cert.subject.org,cert.subject.cn"
		+ "&qbase64=" + encodeURIComponent(b64(query))
		+ (nextCursor ? "&next=" + encodeURIComponent(nextCursor) : "");
	const data = await fetchJson(url);
	if (data.error) throw new Error("FOFA: " + data.errmsg);
	const rows = Array.isArray(data.results) ? data.results : [];
	return { rows, next: data.next ?? "", total: typeof data.size === "number" ? data.size : rows.length };
}

/** Hunter openApi/search 一页（GET 查询参数协议：api-key/search[Base64]/page/page_size/时间窗/is_web）。 */
export async function searchHunterPage(key, query, page, pageSize, extra = {}) {
	const params = new URLSearchParams({
		"api-key": String(key),
		search: b64(String(query)),
		page: String(Number(page) || 1),
		page_size: String(Math.min(Number(pageSize) || LIMITS.hunter.pageSize, LIMITS.hunter.pageSize)),
		start_time: extra.startTime || daysAgoStamp(30),
		end_time: extra.endTime || nowStamp(),
		is_web: String(extra.isWeb !== undefined ? Number(extra.isWeb) : 1)
	});
	const data = await fetchJson(`https://hunter.qianxin.com/openApi/search?${params}`);
	if (data.code !== 200) throw new Error("Hunter: " + (data.message || JSON.stringify(data)));
	const list = Array.isArray(data.data?.arr) ? data.data.arr : [];
	return { rows: list, total: typeof data.data?.total === "number" ? data.data.total : list.length };
}

export function nowStamp() {
	const d = new Date();
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** N 天前的时间戳（Hunter 免费档：时间窗须落在近 30 天内，超窗扣权益积分）。 */
export function daysAgoStamp(days) {
	const d = new Date(Date.now() - days * 86400000);
	const p = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Quake v3 search/quake_service 一页。 */
export async function searchQuakePage(token, query, start, size) {
	const body = { query: String(query), start: Number(start) || 0, size: Math.min(Number(size) || LIMITS.quake.pageSize, LIMITS.quake.pageSize), latest: true, ignore_cache: false };
	const data = await fetchJson("https://quake.360.net/api/v3/search/quake_service", {
		method: "POST",
		headers: { "content-type": "application/json", "X-QuakeToken": String(token) },
		body: JSON.stringify(body)
	});
	if (data.code !== 0) throw new Error("Quake: " + (data.message || JSON.stringify(data)));
	const list = Array.isArray(data.data) ? data.data : [];
	return { rows: list, total: typeof data.meta?.pagination?.total === "number" ? data.meta.pagination.total : list.length };
}

// —— 归一化 ——

function normFofa(r) {
	return {
		host: String(r[0] ?? ""), title: String(r[1] ?? ""), ip: String(r[2] ?? ""),
		domain: String(r[3] ?? ""), port: String(r[4] ?? ""), protocol: String(r[5] ?? ""),
		server: String(r[6] ?? ""), isp: String(r[7] ?? ""), country: String(r[8] ?? ""),
		time: String(r[10] ?? ""), platform: "fofa"
	};
}

function normHunter(r) {
	return {
		host: String(r.url ?? ""), title: String(r.web_title ?? ""), ip: String(r.ip ?? ""),
		domain: String(r.domain ?? ""), port: String(r.port ?? ""), protocol: String(r.protocol ?? ""),
		server: String(r.web_server ?? ""), isp: String(r.isp ?? ""), country: String(r.country ?? ""),
		time: String(r.updated_at ?? ""), platform: "hunter"
	};
}

function normQuake(r) {
	const srv = Array.isArray(r.service) ? r.service[0] ?? {} : (r.service ?? {});
	const http = srv.http ?? {};
	return {
		host: String(http.host ?? ""), title: String(http.title ?? ""), ip: String(r.ip ?? ""),
		domain: String(r.domain ?? ""), port: String(r.port ?? ""), protocol: String(srv.name ?? ""),
		server: String(http.server ?? ""), isp: String(r.isp ?? ""), country: String(r.country ?? ""),
		time: String(r.time ?? ""), platform: "quake"
	};
}

function assetKey(a) {
	const ip = a.ip || (a.host || "").split(":")[0] || "";
	const port = a.port || "";
	return `${ip}:${port}`;
}

function newer(a, b) {
	return String(b.time ?? "") > String(a.time ?? "") ? b : a;
}

/** 多平台归一化结果按 ip:port 去重合并（冲突取时间新者；来源平台列表合并）。 */
export function mergeAssets(...rowsLists) {
	const map = new Map();
	for (const list of rowsLists) {
		for (const a of list) {
			const k = assetKey(a);
			const prev = map.get(k);
			if (prev === undefined) map.set(k, { ...a, platforms: [a.platform] });
			else {
				const merged = { ...newer(prev, a), platforms: Array.from(new Set([...prev.platforms, a.platform])) };
				map.set(k, merged);
			}
		}
	}
	return [...map.values()];
}

/** 蜜罐/欺诈过滤（FOFA 侧在查询拼装时附加）。 */
export function fofaGuard(query) {
	return `(${query}) && (is_honeypot=false && is_fraud=false)`;
}

export { LIMITS, DSL_FIELDS };
