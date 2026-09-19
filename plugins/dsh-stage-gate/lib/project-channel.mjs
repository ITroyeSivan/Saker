// 项目工作台 web 通道（**只读**）：同源信任栅栏 + CSRF，端点 `status`。
//
// 为什么要有栅栏：这条路由由插件自己注册到宿主 webServer（不经过 connection.rpc），
// 任何能访问宿主端口的页面都可能打它。只放行「Host 是回环或受信主机 + Origin 与 Host 同源」，
// 并要求 CSRF 头；端点只读工作区文件，不接受任何写操作。
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { projectSnapshot } from "./project-snapshot.mjs";

export const ROUTE_PATH = "/dsh-stage-gate-project";
export const CSRF_TOKEN = randomBytes(24).toString("hex");
const MAX_BODY = 256 * 1024;

function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]" || hostname === "::1") return true;
	const parts = String(hostname).split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

/** 同源栅栏：Host 回环/受信，且 Origin（若带）与 Host 完全一致（含端口）。 */
export function isTrustedRequest(req, trustedHosts) {
	const host = typeof req?.headers?.host === "string" ? req.headers.host : "";
	if (host === "") return false;
	let hostUrl;
	try { hostUrl = new URL(`http://${host}`); } catch { return false; }
	const okHost = isLoopbackHostname(hostUrl.hostname) || (trustedHosts ?? []).some((t) => {
		try { return new URL(`http://${t}`).hostname === hostUrl.hostname; } catch { return false; }
	});
	if (!okHost) return false;
	const origin = req?.headers?.origin;
	if (typeof origin === "string" && origin !== "null") {
		try {
			if (new URL(origin).host !== hostUrl.host) return false;
		} catch { return false; }
	}
	return true;
}

export function checkCsrf(req, token = CSRF_TOKEN) {
	return String(req?.headers?.["x-dsh-csrf"] ?? "") === String(token ?? "");
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY) { reject(new Error("body too large")); req.destroy(); return; }
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/**
 * 端点分发（纯逻辑，供路由与测试复用）。
 * `status`：返回指定工作区的项目工作台快照。只读，不做任何写盘。
 */
export function dispatchProject(endpoint, payload) {
	const name = String(endpoint ?? "").trim();
	if (name !== "status") return { ok: false, error: `未知端点：${name || "(空)"}` };
	const workspace = String(payload?.workspace ?? "").trim();
	if (workspace === "") return { ok: false, error: "workspace 必填" };
	if (!isAbsolute(workspace)) return { ok: false, error: "workspace 必须是绝对路径" };
	try {
		if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
			return { ok: false, error: `工作区不存在或不是目录：${workspace}` };
		}
	} catch (error) {
		return { ok: false, error: error?.message ?? String(error) };
	}
	return { ok: true, snapshot: projectSnapshot(workspace) };
}

/** 生成 webServer 路由处理器。 */
export function createProjectHandler({ trustedHosts = () => [], token = CSRF_TOKEN } = {}) {
	return async (req, res) => {
		const send = (code, body) => {
			const text = JSON.stringify(body);
			res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
			res.end(text);
		};
		if (!isTrustedRequest(req, trustedHosts())) { res.writeHead(403); res.end("forbidden"); return; }
		let path = "";
		try { path = new URL(req.url ?? "/", "http://x").pathname; } catch { path = ""; }
		if (req.method === "GET" && path === `${ROUTE_PATH}/csrf`) { send(200, { token }); return; }
		if (req.method !== "POST") { res.writeHead(405); res.end("method not allowed"); return; }
		if (!checkCsrf(req, token)) { res.writeHead(403); res.end("csrf token missing or invalid"); return; }
		let endpoint = "";
		try { endpoint = decodeURIComponent(path.slice(ROUTE_PATH.length)).replace(/^\/+/, ""); } catch { endpoint = ""; }
		if (endpoint === "") { res.writeHead(404); res.end("not found"); return; }
		try {
			const raw = await readBody(req);
			const payload = raw === "" ? {} : JSON.parse(raw);
			send(200, dispatchProject(endpoint, payload));
		} catch (error) {
			send(400, { ok: false, error: error?.message ?? String(error) });
		}
	};
}
