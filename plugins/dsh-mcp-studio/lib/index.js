// src/index.ts
import "@deepseek-ai/schemastery";
import * as mcpClient from "@deepseek-ai/dsh-mcp-client";

// src/types.ts
import z from "@deepseek-ai/schemastery";
var ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
var DEFAULT_TOOL_CALL_TIMEOUT_MS = 6e4;
var DEFAULT_PROXY_THRESHOLD = 10;
var ServerEntrySchema = z.object({
  id: z.string().required().pattern(ID_PATTERN),
  enabled: z.boolean().default(true),
  name: z.string().default(""),
  transport: z.union([z.const("stdio"), z.const("streamable-http")]).default("stdio"),
  command: z.string().default(""),
  argsLine: z.string().default(""),
  env: z.dict(z.string()),
  cwd: z.string().default(""),
  url: z.string().default(""),
  headers: z.dict(z.string()),
  toolCallTimeoutMs: z.number().step(1e3).min(1e3).max(36e5).default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
  failOnStartupError: z.boolean().default(false),
  exposure: z.union([z.const("auto"), z.const("direct"), z.const("proxy"), z.const("hybrid")]).default("auto"),
  proxyThreshold: z.number().step(1).min(1).max(200).default(DEFAULT_PROXY_THRESHOLD),
  directTools: z.array(z.string()).default([])
});
var Config = z.object({
  servers: z.array(ServerEntrySchema).default([])
});
function splitArgs(line) {
  const tokens = [];
  let current = "";
  let quote;
  let started = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote === void 0) {
      if (char === " " || char === "	") {
        if (started) {
          tokens.push(current);
          current = "";
          started = false;
        }
        continue;
      }
      if (char === "\\" && index + 1 < line.length) {
        current += line[++index];
        started = true;
        continue;
      }
      if (char === "'" || char === '"') {
        quote = char;
        started = true;
        continue;
      }
      current += char;
      started = true;
    } else if (quote === "'") {
      if (char === "'") quote = void 0;
      else current += char;
    } else {
      if (char === "\\" && index + 1 < line.length) {
        current += line[++index];
      } else if (char === '"') {
        quote = void 0;
      } else {
        current += char;
      }
    }
  }
  if (started) tokens.push(current);
  return tokens;
}
function toMcpClientConfig(server) {
  const base = {
    serverName: server.name,
    toolCallTimeoutMs: server.toolCallTimeoutMs,
    failOnStartupError: server.failOnStartupError
  };
  if (server.transport === "stdio") {
    return {
      ...base,
      transport: "stdio",
      command: server.command,
      args: splitArgs(server.argsLine),
      env: server.env,
      cwd: server.cwd
    };
  }
  return {
    ...base,
    transport: "streamable-http",
    url: server.url,
    headers: server.headers
  };
}
function validateSection(value) {
  const names = /* @__PURE__ */ new Set();
  for (const server of value.servers) {
    if (!server.enabled) continue;
    if (names.has(server.name)) {
      throw new Error(`mcp-studio: two enabled servers share the name "${server.name}" \u2014 server names must be unique`);
    }
    if (server.name.trim() === "") {
      throw new Error(`mcp-studio: an enabled server has no name`);
    }
    names.add(server.name);
    if (server.transport === "stdio" && server.command.trim() === "") {
      throw new Error(`mcp-studio: stdio server "${server.name}" has no command`);
    }
    if (server.transport === "streamable-http") {
      if (server.url.trim() === "") throw new Error(`mcp-studio: server "${server.name}" has no url`);
      let parsed;
      try {
        parsed = new URL(server.url);
      } catch {
        throw new Error(`mcp-studio: server "${server.name}" url "${server.url}" is not a valid URL`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`mcp-studio: server "${server.name}" url must use http or https`);
      }
    }
    const promoted = /* @__PURE__ */ new Set();
    for (const raw of server.directTools ?? []) {
      const name2 = raw.trim();
      if (name2 === "") throw new Error(`mcp-studio: server "${server.name}" has a blank entry in directTools`);
      if (promoted.has(name2)) throw new Error(`mcp-studio: server "${server.name}" lists "${name2}" twice in directTools`);
      promoted.add(name2);
    }
  }
}

// src/settings-rpc.ts
var STUDIO_CHANNEL = "/dsh-mcp-studio";
var WRITABLE_FIELDS = /* @__PURE__ */ new Set(["servers"]);
function ok(value) {
  return { ok: true, value };
}
function failure(error, ns) {
  return {
    ok: false,
    error: {
      code: "settings-rejected",
      message: error instanceof Error ? error.message : String(error),
      details: { ns }
    }
  };
}
function badRequest(message) {
  return { ok: false, error: { code: "bad-request", message, details: { issues: [] } } };
}
function asObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("payload must be an object");
  return value;
}
function descriptor(settings, ns) {
  const view = settings.describe({ redactSecrets: true }).find((candidate) => candidate.ns === ns);
  if (view === void 0) throw new Error(`settings namespace "${ns}" is unavailable`);
  return {
    status: "ready",
    value: view.value,
    ...view.base === void 0 ? {} : { base: view.base },
    ...view.user === void 0 ? {} : { user: view.user },
    revision: view.revision,
    writable: settings.writable,
    mode: "host",
    ...view.applies === void 0 ? {} : { applies: view.applies }
  };
}
function createExecutionRing(max = 200) {
  const records = [];
  return {
    max,
    push: (record) => {
      records.push(record);
      if (records.length > max) records.splice(0, records.length - max);
    },
    recent: (limit) => records.slice(-limit).reverse(),
    clear: () => {
      records.splice(0, records.length);
    }
  };
}
function asToolsViewHandle(view) {
  if (typeof view !== "object" || view === null) return void 0;
  const visible = view.visible;
  if (!(visible instanceof Map)) return void 0;
  return view;
}
function createStatusHandler(section, viewOf, tracker, executions, proxy) {
  return async () => {
    const current = section();
    const view = asToolsViewHandle(viewOf());
    const servers = [];
    let connected = 0;
    let totalTools = 0;
    for (const server of current.servers) {
      const prefix = `mcp__${server.name}__`;
      const tools = [];
      const effective = server.enabled && proxy !== void 0 ? proxy.exposureOf(server) : "direct";
      let proxiedState;
      let proxiedError;
      if (server.enabled && effective === "proxy" && proxy !== void 0) {
        for (const tool of proxy.view.catalog(server.name)) tools.push({ name: tool.name, description: tool.description });
        tools.sort((left, right) => left.name.localeCompare(right.name));
        proxiedState = proxy.view.state(server.name);
        proxiedError = proxiedState?.error;
      } else if (view !== void 0 && server.enabled) {
        for (const [name2, definition] of view.visible) {
          if (!name2.startsWith(prefix)) continue;
          tools.push({ name: name2.slice(prefix.length), description: typeof definition.description === "string" ? definition.description : "" });
        }
        tools.sort((left, right) => left.name.localeCompare(right.name));
      }
      const note = tracker.states.get(server.id);
      let state;
      let error;
      if (!server.enabled) state = "disabled";
      else if (effective === "proxy") {
        if (proxiedState === void 0) state = "unreachable";
        else if (proxiedState.state === "ready") state = "connected";
        else if (proxiedState.state === "connecting") state = "mounting";
        else state = "error";
        error = proxiedError;
      } else if (tools.length > 0) state = "connected";
      else if (note?.state === "error") {
        state = "error";
        error = note.error;
      } else if (note?.state === "mounting") state = "mounting";
      else state = "unreachable";
      if (state === "connected") connected += 1;
      totalTools += tools.length;
      servers.push({
        id: server.id,
        name: server.name,
        transport: server.transport,
        state,
        ...error === void 0 ? {} : { error },
        toolCount: tools.length,
        tools,
        exposure: effective
      });
    }
    const enabled = servers.filter((server) => server.state !== "disabled").length;
    return ok({
      servers,
      summary: { total: servers.length, enabled, connected, tools: totalTools },
      ...executions === void 0 ? {} : { executions: executions.recent(executions.max), execCapacity: executions.max }
    });
  };
}
function registerStudioRpc(ctx, connection, settings, ns, status, diagnose, clearExecutions, debug) {
  connection.register(ctx, STUDIO_CHANNEL, async (endpoint, rawPayload) => {
    if (endpoint === "status") return status();
    if (endpoint === "debug") {
      if (debug === void 0) return badRequest("debug unavailable");
      return ok(debug());
    }
    if (endpoint === "executions/clear") {
      if (clearExecutions === void 0) return badRequest("execution log unavailable");
      clearExecutions();
      return ok({ cleared: true });
    }
    if (endpoint === "diagnose") {
      if (diagnose === void 0) return badRequest("diagnose unavailable");
      const id = typeof rawPayload?.id === "string" ? rawPayload.id : "";
      return diagnose(id);
    }
    try {
      if (endpoint === "settings/get") return ok(descriptor(settings, ns));
      if (endpoint === "settings/mutate") {
        if (!settings.writable) throw new Error("DSH settings are read-only");
        const payload = asObject(rawPayload);
        const rawOps = payload.ops;
        if (!Array.isArray(rawOps) || rawOps.length === 0 || rawOps.length > 4) throw new Error("ops must contain 1..4 settings edits");
        const ops = rawOps.map((raw) => {
          const op = asObject(raw);
          const path = op.path;
          if (!Array.isArray(path) || path.length !== 1 || !WRITABLE_FIELDS.has(String(path[0]))) {
            throw new Error(`unsupported mcp-studio settings path: ${JSON.stringify(path)}`);
          }
          if (op.op === "unset") return { op: "unset", path: [String(path[0])] };
          if (op.op !== "set") throw new Error(`unsupported settings operation: ${String(op.op)}`);
          return { op: "set", path: [String(path[0])], value: op.value };
        });
        const revision = payload.expectedRevision === void 0 ? void 0 : Number(payload.expectedRevision);
        await settings.mutate(ns, ops, revision);
        return ok(descriptor(settings, ns));
      }
      return badRequest(`unknown endpoint: ${endpoint}`);
    } catch (error) {
      return failure(error, ns);
    }
  }, { authority: "loopback" });
}

// src/transport.ts
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
var DEFAULT_REQUEST_TIMEOUT_MS = 1e4;
var PACKAGE_RUNNER_HOSTS = {
  npx: "registry.npmjs.org",
  npm: "registry.npmjs.org",
  pnpm: "registry.npmjs.org",
  bunx: "registry.npmjs.org",
  yarn: "registry.yarnpkg.com",
  uvx: "pypi.org",
  pipx: "pypi.org"
};
var EGRESS_MODES = ["allow", "allowlist", "frozen"];
function runnerRegistryHost(command) {
  const base = String(command ?? "").trim().split(/[\\/]/).pop()?.toLowerCase().replace(/\.(cmd|exe|ps1|bat)$/, "") ?? "";
  return PACKAGE_RUNNER_HOSTS[base] ?? "";
}
function egressHome() {
  const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
  return DSH_HOME;
}
function readEgressPolicy() {
  try {
    const raw = JSON.parse(readFileSync(join(egressHome(), "saker-egress", "policy.json"), "utf8"));
    const mode = EGRESS_MODES.includes(String(raw.mode)) ? String(raw.mode) : "allow";
    const allowHosts = Array.isArray(raw.allowHosts) ? raw.allowHosts.map((host) => String(host).trim().toLowerCase()).filter(Boolean) : [];
    return { mode, allowHosts };
  } catch {
    return { mode: "allow", allowHosts: [] };
  }
}
function hostAllowed(host, allowHosts) {
  for (const rule of allowHosts) {
    if (rule === host) return true;
    if (/^[0-9a-f:.]+$/.test(rule)) continue;
    if (host.endsWith(`.${rule}`)) return true;
  }
  return false;
}
function appendEgressAudit(entry) {
  try {
    const file = join(egressHome(), "saker-egress", "audit.jsonl");
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), plugin: "dsh-mcp-studio", kind: "infra", ...entry })}
`, "utf8");
  } catch {
  }
}
function evaluateRunnerEgress(server) {
  const host = runnerRegistryHost(server.command);
  if (host === "") return { decision: "allow", reason: "no-registry-fetch", mode: "allow", host: "" };
  const policy = readEgressPolicy();
  let decision = "allow";
  let reason = "allow-all";
  if (policy.mode === "frozen") {
    decision = "deny";
    reason = "infra_frozen";
  } else if (policy.mode === "allowlist") {
    decision = hostAllowed(host, policy.allowHosts) ? "allow" : "deny";
    reason = decision === "allow" ? "allowlisted" : "not_allowed";
  }
  appendEgressAudit({ host, decision, reason, mode: policy.mode, note: `${server.name} ${server.command}` });
  return { decision, reason, mode: policy.mode, host };
}
function blockedChannel(reason) {
  return {
    get alive() {
      return false;
    },
    get closedReason() {
      return reason;
    },
    request() {
      return Promise.reject(new Error(reason));
    },
    notify() {
      throw new Error(reason);
    },
    close() {
    }
  };
}
function stdioChannel(server) {
  const gate = evaluateRunnerEgress(server);
  if (gate.decision === "deny") {
    return blockedChannel(
      `\u7EDF\u4E00\u51FA\u7AD9\u7B56\u7565\u62E6\u622A\uFF08${gate.reason} / mode=${gate.mode}\uFF09\uFF1A${server.command} \u9700\u8981\u8BBF\u95EE ${gate.host} \u62C9\u5305\u3002\u6539\u6863\u4F4D\uFF1A\u8BBE\u7F6E \u2192 \u5B89\u5168\u914D\u7F6E \u2192 \u51FA\u7AD9\u7B56\u7565\u3002`
    );
  }
  const child = spawn(server.command, splitArgs(server.argsLine), {
    cwd: server.cwd === "" ? void 0 : server.cwd,
    env: { ...process.env, ...server.env },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const pending = /* @__PURE__ */ new Map();
  let buffer = "";
  let nextId = 1;
  let alive = true;
  let closedReason;
  const failAll = (reason) => {
    if (!alive) return;
    alive = false;
    closedReason = reason;
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
      pending.delete(id);
    }
  };
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const frame = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (frame === "") continue;
      let message;
      try {
        message = JSON.parse(frame);
      } catch {
        continue;
      }
      const id = typeof message.id === "number" ? message.id : void 0;
      if (id === void 0) continue;
      const entry = pending.get(id);
      if (entry === void 0) continue;
      pending.delete(id);
      clearTimeout(entry.timer);
      if (message.error !== void 0) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", () => {
  });
  child.on("error", (error) => failAll(`child process error: ${error.message}`));
  child.on("exit", (code, signal) => failAll(`server exited (code ${String(code)}, signal ${String(signal)})`));
  child.stdin?.on("error", (error) => failAll(`stdio write failed: ${error.message}`));
  child.stdin?.on("close", () => failAll("stdio input closed"));
  const write = (payload) => {
    if (!alive) throw new Error(closedReason ?? "channel closed");
    const stdin = child.stdin;
    if (stdin === null || stdin.destroyed || !stdin.writable) throw new Error("stdio input is not writable");
    stdin.write(`${JSON.stringify(payload)}
`);
  };
  return {
    get alive() {
      return alive;
    },
    get closedReason() {
      return closedReason;
    },
    request(method, params, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
      return new Promise((resolve, reject) => {
        if (!alive) {
          reject(new Error(closedReason ?? "channel closed"));
          return;
        }
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`request "${method}" timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
          write({ jsonrpc: "2.0", id, method, ...params === void 0 ? {} : { params } });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    notify(method, params) {
      try {
        write({ jsonrpc: "2.0", method, ...params === void 0 ? {} : { params } });
      } catch {
      }
    },
    close() {
      failAll("channel closed by caller");
      try {
        child.kill();
      } catch {
      }
    }
  };
}
function httpChannel(server) {
  const url = new URL(server.url);
  let sessionId = String(
    Object.entries(server.headers ?? {}).find(([key]) => key.toLowerCase() === "mcp-session-id")?.[1] ?? ""
  ).trim();
  let nextId = 1;
  let alive = true;
  let closedReason;
  const post = async (message, timeoutMs) => {
    const isNotification = typeof message.method === "string" && message.id === void 0;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...sessionId ? { "mcp-session-id": sessionId } : {},
        ...server.headers
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!sessionId) {
      const issued = response.headers.get("mcp-session-id")?.trim();
      if (issued) sessionId = issued;
    }
    if (isNotification) return [];
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    if (text.trim() === "") throw new Error(`empty response body from ${server.url}`);
    const out = [];
    if (contentType.includes("text/event-stream")) {
      for (const frame of text.split("\n")) {
        if (!frame.startsWith("data:")) continue;
        const payload = frame.slice(5).trim();
        if (payload === "") continue;
        try {
          out.push(JSON.parse(payload));
        } catch {
        }
      }
    } else {
      out.push(JSON.parse(text));
    }
    return out;
  };
  return {
    get alive() {
      return alive;
    },
    get closedReason() {
      return closedReason;
    },
    async request(method, params, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
      if (!alive) throw new Error(closedReason ?? "channel closed");
      const id = nextId++;
      let responses;
      try {
        responses = await post({ jsonrpc: "2.0", id, method, ...params === void 0 ? {} : { params } }, timeoutMs);
      } catch (error) {
        if (error instanceof Error && !/^HTTP 4\d\d/.test(error.message)) {
          alive = false;
          closedReason = error.message;
        }
        throw error instanceof Error ? error : new Error(String(error));
      }
      const match = responses.find((candidate) => candidate.id === id);
      if (match === void 0) throw new Error(`no response for "${method}" (id ${id})`);
      if (match.error !== void 0) throw new Error(JSON.stringify(match.error));
      return match.result;
    },
    notify(method, params) {
      if (!alive) return;
      void post({ jsonrpc: "2.0", method, ...params === void 0 ? {} : { params } }, DEFAULT_REQUEST_TIMEOUT_MS).catch(() => {
      });
    },
    close() {
      alive = false;
      closedReason = "channel closed by caller";
    }
  };
}
function openChannel(server) {
  return server.transport === "streamable-http" ? httpChannel(server) : stdioChannel(server);
}
async function handshake(channel, clientName = "dsh-mcp-studio", timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  const result = await channel.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: clientName, version: "0.1.0" }
  }, timeoutMs);
  channel.notify("notifications/initialized");
  const info = result ?? {};
  const serverInfo = info.serverInfo ?? {};
  return {
    ...typeof info.protocolVersion === "string" ? { protocolVersion: info.protocolVersion } : {},
    ...typeof serverInfo.name === "string" ? { serverName: serverInfo.name } : {},
    ...typeof serverInfo.version === "string" ? { serverVersion: serverInfo.version } : {}
  };
}
async function listTools(channel, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  const result = await channel.request("tools/list", {}, timeoutMs);
  const tools = result?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.filter((tool) => typeof tool === "object" && tool !== null).map((tool) => ({
    name: typeof tool.name === "string" ? tool.name : "",
    description: typeof tool.description === "string" ? tool.description : "",
    inputSchema: tool.inputSchema ?? {}
  })).filter((tool) => tool.name !== "");
}

// src/diagnose.ts
async function diagnoseServer(server) {
  const started = Date.now();
  const channel = openChannel(server);
  try {
    const info = await handshake(channel, "dsh-mcp-studio-diag", DEFAULT_REQUEST_TIMEOUT_MS);
    const tools = await listTools(channel, DEFAULT_REQUEST_TIMEOUT_MS);
    return {
      ok: true,
      elapsedMs: Date.now() - started,
      ...info,
      toolCount: tools.length
    };
  } catch (error) {
    return {
      ok: false,
      elapsedMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    channel.close();
  }
}

// src/proxy.ts
import { defineTool } from "@deepseek-ai/dsh-tools";
var META_TOOL_SEARCH = "mcp_search";
var META_TOOL_CALL = "mcp_call";
var CATALOG_TTL_MS = 5 * 6e4;
var SEARCH_DEFAULT_LIMIT = 8;
var SEARCH_MAX_LIMIT = 30;
var HIT_DESCRIPTION_CHARS = 140;
var RETRY_BACKOFF_MS = 1e4;
var TOOL_DESCRIPTION_HINTS = /* @__PURE__ */ new Map([
  [
    "yakit.query_http_flow",
    'sourceType:"all" is required for MCP request flows (mitm misses them); includePath/excludePath are arrays, not strings.'
  ]
]);
function applyToolHint(server, name2, description) {
  const hint = TOOL_DESCRIPTION_HINTS.get(`${server.toLowerCase()}.${name2.toLowerCase()}`);
  if (hint === void 0) return description;
  return description.trim() === "" ? hint : `${hint} ${description}`;
}
function decideExposure(server, toolCount) {
  if (server.exposure === "direct") return "direct";
  if (server.exposure === "proxy" || server.exposure === "hybrid") return "proxy";
  if (toolCount === void 0) return "pending";
  return toolCount >= server.proxyThreshold ? "proxy" : "direct";
}
var SEARCH_ALIASES = /* @__PURE__ */ new Map([
  ["\u67E5\u8BE2", ["query", "search"]],
  ["\u6D41\u91CF", ["flow", "traffic"]],
  ["\u6293\u5305", ["mitm", "capture", "proxy"]],
  ["\u5386\u53F2", ["history"]],
  ["\u8BF7\u6C42", ["request"]],
  ["\u54CD\u5E94", ["response"]],
  ["\u626B\u63CF", ["scan"]],
  ["\u7AEF\u53E3", ["port"]],
  ["\u6F0F\u6D1E", ["vuln", "risk"]],
  ["\u7F16\u7801", ["encode"]],
  ["\u89E3\u7801", ["decode"]],
  ["\u6D4F\u89C8\u5668", ["browser"]],
  ["\u4EE3\u7406", ["proxy"]],
  ["\u6587\u4EF6", ["file"]],
  ["\u547D\u4EE4", ["command", "exec"]],
  ["\u8FDB\u7A0B", ["process"]],
  ["\u5185\u5B58", ["memory"]]
]);
function tokenize(query) {
  const raw = String(query ?? "").toLowerCase().split(/[\s,;|/]+/).map((token) => token.trim()).filter((token) => token !== "");
  const expanded = [];
  const seen = /* @__PURE__ */ new Set();
  for (const token of raw) {
    for (const candidate of [token, ...SEARCH_ALIASES.get(token) ?? []]) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      expanded.push(candidate);
    }
  }
  return expanded;
}
function scoreTool(meta, tokens) {
  if (tokens.length === 0) return 1;
  const name2 = meta.name.toLowerCase();
  const description = meta.description.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (name2 === token) return 1e3;
    if (name2.startsWith(token)) score += 60;
    else if (name2.includes(token)) score += 40;
    if (description.includes(token)) score += 8;
  }
  return score;
}
function rankTools(metas, options = {}) {
  const tokens = tokenize(options.query);
  const serverFilter = String(options.server ?? "").trim().toLowerCase();
  const rawLimit = Number(options.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), SEARCH_MAX_LIMIT) : SEARCH_DEFAULT_LIMIT;
  const pool = serverFilter === "" ? metas : metas.filter((meta) => meta.server.toLowerCase() === serverFilter);
  return pool.map((meta) => ({ meta, score: scoreTool(meta, tokens) })).filter((entry) => entry.score > 0).sort((left, right) => right.score - left.score || left.meta.server.localeCompare(right.meta.server) || left.meta.name.localeCompare(right.meta.name)).slice(0, limit).map((entry) => entry.meta);
}
function paramHint(inputSchema) {
  const schema = inputSchema ?? {};
  const properties = typeof schema.properties === "object" && schema.properties !== null ? Object.keys(schema.properties) : [];
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const parts = properties.map((key) => required.has(key) ? key : `${key}?`);
  if (schema.additionalProperties === true) parts.push("\u2026");
  return parts.join(", ");
}
function toolLine(meta) {
  const hint = paramHint(meta.inputSchema);
  const description = meta.description.replace(/\s+/g, " ").trim().slice(0, HIT_DESCRIPTION_CHARS);
  return `- ${meta.server}.${meta.name}(${hint})${description === "" ? "" : ` \u2014 ${description}`}`;
}
function renderSearchText(matches, context) {
  const query = String(context.query ?? "").trim();
  if (matches.length === 0) {
    return query === "" ? "\u5F53\u524D\u6CA1\u6709\u542F\u7528\u4EFB\u4F55\u88AB\u4EE3\u7406\u7684 MCP \u5DE5\u5177\uFF08\u7F16\u76EE 0 \u6761\uFF09\u3002" : `\u6CA1\u6709\u5339\u914D\u300C${query}\u300D\u7684 MCP \u5DE5\u5177\uFF08\u672C\u8F6E\u7F16\u76EE ${context.total} \u6761\uFF09\u3002\u6362\u4E2A\u5173\u952E\u8BCD\uFF0C\u6216\u4E0D\u5E26\u5173\u952E\u8BCD\u5217\u51FA\u5168\u90E8\u3002`;
  }
  return [
    `\u547D\u4E2D ${matches.length} \u6761\uFF08\u7F16\u76EE\u5171 ${context.total} \u6761\uFF09\uFF1A`,
    ...matches.map(toolLine),
    "",
    `\u8C03\u7528\uFF1A${META_TOOL_CALL}(server=..., tool=..., args={...})\uFF1Bargs \u662F\u6309\u4E0A\u9762\u62EC\u53F7\u91CC\u7684\u53C2\u6570\u540D\u7EC4\u6210\u7684\u5BF9\u8C61\u3002`
  ].join("\n");
}
function summarizeCatalog(metas) {
  const counts = /* @__PURE__ */ new Map();
  for (const meta of metas) counts.set(meta.server, (counts.get(meta.server) ?? 0) + 1);
  return [...counts.entries()].map(([server, tools]) => ({ server, tools })).sort((left, right) => left.server.localeCompare(right.server));
}
var SCALAR_TYPES = /* @__PURE__ */ new Set(["string", "number", "integer", "boolean"]);
function toParameterDeclaration(property) {
  const node = property ?? {};
  const description = typeof node.description === "string" ? node.description.replace(/\s+/g, " ").trim() : "";
  const withDescription = (declaration2) => description === "" ? declaration2 : { ...declaration2, description };
  if (node.type === "array") return withDescription({ type: "array" });
  if (node.type === "object") return withDescription({ type: "object", additionalProperties: true });
  if (typeof node.type !== "string" || !SCALAR_TYPES.has(node.type)) {
    const note = "\uFF08\u539F schema \u4E3A\u590D\u6742/\u8054\u5408\u7C7B\u578B\uFF0C\u6309 JSON \u503C\u4F20\u5165\uFF09";
    return { type: "json", description: description === "" ? note : `${description}${note}` };
  }
  const declaration = { type: node.type };
  if (Array.isArray(node.enum)) declaration.enum = node.enum;
  return withDescription(declaration);
}
function toToolParameters(inputSchema) {
  const schema = inputSchema ?? {};
  const properties = typeof schema.properties === "object" && schema.properties !== null ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const parameters = {};
  for (const [key, property] of Object.entries(properties)) {
    parameters[key] = { ...toParameterDeclaration(property), ...required.has(key) ? { required: true } : {} };
  }
  return parameters;
}
var ProxyRegistry = class {
  mounts = /* @__PURE__ */ new Map();
  /**
   * Last successfully listed tool count per server name, keyed by the row's connection
   * fingerprint. Sticky on purpose. `auto` decides from this number, and the moment it
   * decides "small, mount directly" the server leaves the proxy set — so a count read off
   * the live mount alone forgets itself the instant it is used. That produced a live-only
   * oscillation: pending → proxy (list 3) → direct → pending (count gone) → proxy → … with
   * the direct mount torn down on every lap and the server's tools never staying visible.
   * A learning that survives the mount is what makes the decision a one-way door; editing
   * the row (its fingerprint changes) or calling dropServer() is what opens it again.
   */
  learned = /* @__PURE__ */ new Map();
  section;
  log;
  constructor(section, log = () => {
  }) {
    this.section = section;
    this.log = log;
  }
  /**
   * What makes two versions of a row "the same server" for the purposes of a learned count.
   * Deliberately excludes exposure/proxyThreshold/directTools: toggling a row between `auto`
   * and `proxy` must not throw away what we already learned about its catalog size.
   */
  fingerprintOf(server) {
    return JSON.stringify([
      server.name,
      server.transport,
      server.command,
      server.argsLine,
      server.url,
      server.cwd,
      server.env
    ]);
  }
  /** All catalogs, concatenated. */
  catalog() {
    const out = [];
    for (const mount of this.mounts.values()) out.push(...mount.note.tools);
    return out;
  }
  /** One server's catalog (`[]` when unlisted). */
  catalogFor(serverName) {
    const mount = this.mountByName(serverName);
    return mount === void 0 ? [] : mount.note.tools;
  }
  /**
   * A server's catalog size, or `undefined` while it has never answered.
   * The distinction matters: `auto` must not treat "connect not attempted" as "zero tools"
   * and permanently fall back to a direct mount without ever looking.
   *
   * A live reading wins, but a learned one is used when the server is no longer mounted by
   * the proxy — which is the normal state of every `auto` row that resolved to `direct`.
   */
  listedCount(serverName) {
    const mount = this.mountByName(serverName);
    if (mount !== void 0 && mount.note.state === "ready") return mount.note.tools.length;
    const row = this.section().servers.find((server) => server.name === serverName);
    if (row === void 0) return void 0;
    const learned = this.learned.get(serverName);
    if (learned === void 0 || learned.fingerprint !== this.fingerprintOf(row)) return void 0;
    return learned.count;
  }
  /** Per-server catalog state, for the status page. */
  stateOf(serverName) {
    const mount = this.mountByName(serverName);
    if (mount === void 0) return void 0;
    return { state: mount.note.state, ...mount.note.error === void 0 ? {} : { error: mount.note.error } };
  }
  /** Whether a server has a usable catalog — the proxied equivalent of "its tools are visible". */
  hasCatalog(serverName) {
    const mount = this.mountByName(serverName);
    return mount !== void 0 && mount.note.state === "ready" && mount.note.tools.length > 0;
  }
  /** Per-server state for the status page and `debug`. */
  snapshot() {
    return [...this.mounts.values()].map((mount) => ({
      id: mount.id,
      name: mount.name,
      state: mount.note.state,
      tools: mount.note.tools.length,
      ...mount.note.error === void 0 ? {} : { error: mount.note.error }
    }));
  }
  mountByName(serverName) {
    for (const mount of this.mounts.values()) if (mount.name === serverName) return mount;
    return void 0;
  }
  serverOf(id) {
    return this.section().servers.find((server) => server.id === id);
  }
  closeMount(id) {
    const mount = this.mounts.get(id);
    if (mount === void 0) return;
    try {
      mount.channel.close();
    } catch {
    }
    this.mounts.delete(id);
  }
  /** Close everything (plugin unload). */
  closeAll() {
    for (const id of [...this.mounts.keys()]) this.closeMount(id);
  }
  /**
   * Reconcile mounts against `list` (the rows whose exposure may be proxied).
   * A row that leaves `list` or changes its name is torn down; a new row gets a channel.
   *
   * Only rows present in `list` are examined for staleness — a row that left because `auto`
   * resolved it to `direct` must keep its learned count, or the decision it just made would
   * be erased on the next reconcile.
   */
  syncServers(list) {
    const wanted = /* @__PURE__ */ new Map();
    for (const server of list) if (server.enabled) wanted.set(server.id, server);
    for (const [id, mount] of [...this.mounts]) {
      const server = wanted.get(id);
      if (server !== void 0 && server.name === mount.name && this.fingerprintOf(server) === mount.fingerprint) continue;
      this.closeMount(id);
    }
    for (const [id, server] of wanted) {
      const learned = this.learned.get(server.name);
      if (learned !== void 0 && learned.fingerprint !== this.fingerprintOf(server)) {
        this.learned.delete(server.name);
      }
      if (this.mounts.has(id)) continue;
      const fingerprint = this.fingerprintOf(server);
      this.mounts.set(id, {
        id,
        name: server.name,
        fingerprint,
        channel: openChannel(server),
        handshaken: false,
        note: { state: "connecting", tools: [], listedAt: 0, nextRetryAt: 0 }
      });
    }
  }
  /** Forget one mount by server name (used when `auto` resolves to a direct mount instead). */
  dropServer(serverName) {
    const mount = this.mountByName(serverName);
    if (mount !== void 0) this.closeMount(mount.id);
    this.learned.delete(serverName);
  }
  /**
   * Make sure a server's catalog is loaded and fresh. Never throws: failures land in the
   * server's note so `mcp_search` can report them instead of the caller seeing a crash.
   */
  async ensure(serverName, options = {}) {
    const mount = this.mountByName(serverName);
    if (mount === void 0) return void 0;
    const server = this.serverOf(mount.id);
    if (server === void 0) return void 0;
    const fresh = mount.channel.alive && mount.note.state === "ready" && Date.now() - mount.note.listedAt < CATALOG_TTL_MS;
    if (fresh && options.force !== true) return mount.note;
    if (mount.note.state === "error" && Date.now() < mount.note.nextRetryAt) return mount.note;
    const timeoutMs = Math.max(server.toolCallTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    try {
      if (!mount.channel.alive) {
        try {
          mount.channel.close();
        } catch {
        }
        mount.channel = openChannel(server);
        mount.handshaken = false;
      }
      if (!mount.handshaken) {
        await handshake(mount.channel, "dsh-mcp-studio-proxy", timeoutMs);
        mount.handshaken = true;
      }
      const raw = await listTools(mount.channel, timeoutMs);
      mount.note = {
        state: "ready",
        tools: raw.map((tool) => ({
          server: server.name,
          name: tool.name,
          description: applyToolHint(server.name, tool.name, tool.description),
          inputSchema: tool.inputSchema
        })),
        listedAt: Date.now(),
        nextRetryAt: 0
      };
      this.learned.set(server.name, { count: mount.note.tools.length, fingerprint: this.fingerprintOf(server) });
      return mount.note;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      mount.note = { state: "error", error: message, tools: [], listedAt: Date.now(), nextRetryAt: Date.now() + RETRY_BACKOFF_MS };
      this.log('mcp-studio: proxy list for "%s" failed: %s', server.name, message);
      return mount.note;
    }
  }
  /** Load every proxied server's catalog (mount-time warm-up). */
  async ensureAll() {
    for (const mount of [...this.mounts.values()]) await this.ensure(mount.name);
  }
  /** Search across all catalogs, refreshing missing or stale ones first. */
  async search(options = {}) {
    const serverName = String(options.server ?? "").trim();
    if (serverName !== "" && this.mountByName(serverName) !== void 0) await this.ensure(serverName);
    else await this.ensureAll();
    const catalog = this.catalog();
    return {
      matches: rankTools(catalog, options),
      total: catalog.length,
      errors: this.snapshot().filter((entry) => entry.state === "error").map((entry) => ({ name: entry.name, error: entry.error ?? "unknown error" }))
    };
  }
  /** Forward one `tools/call`. */
  async call(serverName, tool, args) {
    const name2 = String(serverName ?? "").trim();
    if (name2 === "") return { ok: false, text: "", error: `${META_TOOL_CALL} \u9700\u8981 server \u53C2\u6570\uFF08\u7528 ${META_TOOL_SEARCH} \u67E5\u540D\u5B57\uFF09` };
    const toolName = String(tool ?? "").trim();
    if (toolName === "") return { ok: false, text: "", error: `${META_TOOL_CALL} \u9700\u8981 tool \u53C2\u6570` };
    const mount = this.mountByName(name2);
    if (mount === void 0) {
      const known = [...this.mounts.values()].map((candidate) => candidate.name);
      return {
        ok: false,
        text: "",
        error: known.length === 0 ? "\u6CA1\u6709\u53EF\u8C03\u7528\u7684\u88AB\u4EE3\u7406 MCP server\u3002" : `\u672A\u77E5 server\u300C${name2}\u300D\uFF1B\u5F53\u524D\u88AB\u4EE3\u7406\u7684 server\uFF1A${known.join(", ")}`
      };
    }
    const server = this.serverOf(mount.id);
    if (server === void 0) return { ok: false, text: "", error: `server\u300C${name2}\u300D\u7684\u914D\u7F6E\u884C\u5DF2\u4E0D\u5B58\u5728` };
    const note = await this.ensure(name2);
    if (note === void 0 || note.state !== "ready") {
      return { ok: false, text: "", error: `server\u300C${name2}\u300D\u4E0D\u53EF\u7528\uFF1A${note?.error ?? "\u76EE\u5F55\u672A\u5C31\u7EEA"}` };
    }
    if (!note.tools.some((candidate) => candidate.name === toolName)) {
      const near = note.tools.map((candidate) => candidate.name).filter((candidate) => candidate.includes(toolName)).slice(0, 5);
      return {
        ok: false,
        text: "",
        error: `server\u300C${name2}\u300D\u6CA1\u6709\u5DE5\u5177\u300C${toolName}\u300D${near.length === 0 ? "" : `\uFF1B\u540D\u5B57\u63A5\u8FD1\u7684\u6709\uFF1A${near.join(", ")}`}\uFF08\u5148\u7528 ${META_TOOL_SEARCH} \u786E\u8BA4\u540D\u5B57\uFF09`
      };
    }
    try {
      const result = await mount.channel.request("tools/call", { name: toolName, arguments: args ?? {} }, server.toolCallTimeoutMs);
      const payload = result ?? {};
      const text = (payload.content ?? []).filter((block) => typeof block?.text === "string").map((block) => String(block.text)).join("\n");
      if (payload.isError === true) return { ok: false, text, error: text === "" ? `\u5DE5\u5177\u300C${toolName}\u300D\u8FD4\u56DE\u9519\u8BEF` : text };
      return { ok: true, text: text === "" ? "(\u8BE5\u5DE5\u5177\u6CA1\u6709\u8FD4\u56DE\u6587\u672C\u5185\u5BB9)" : text, structured: payload.structuredContent ?? null };
    } catch (error) {
      return { ok: false, text: "", error: error instanceof Error ? error.message : String(error) };
    }
  }
  /**
   * Register `mcp_search` + `mcp_call` against the host tool registry.
   * @returns one disposer per registration, so a reconcile that leaves no proxied server
   *   can withdraw the pair rather than leaving two dead tools in the prompt.
   */
  registerMetaTools(ctx) {
    const disposers = [];
    const keep = (disposable) => {
      if (typeof disposable === "function") disposers.push(disposable);
    };
    keep(ctx.tools.register(defineTool({
      name: META_TOOL_SEARCH,
      description: `\u68C0\u7D22\u5DF2\u63A5\u5165\u7684 MCP server \u5DE5\u5177\u76EE\u5F55\uFF08\u5173\u952E\u8BCD\u5339\u914D\u5DE5\u5177\u540D\u4E0E\u63CF\u8FF0\uFF0C\u8FD4\u56DE\u5DE5\u5177\u540D\u3001\u53C2\u6570\u540D\u4E0E\u4E00\u53E5\u8BDD\u8BF4\u660E\uFF09\u3002\u88AB\u4EE3\u7406\uFF08proxy/hybrid/auto\uFF09\u7684 server \u4E0D\u4F1A\u628A\u6BCF\u4E2A\u5DE5\u5177\u5355\u72EC\u66B4\u9732\u7ED9\u6A21\u578B\uFF0C\u6240\u4EE5\u8C03\u7528\u524D\u5148\u7528\u672C\u5DE5\u5177\u627E\u540D\u5B57\u3002\u4E0D\u5E26 query \u5217\u51FA\u5168\u90E8\uFF08\u53D7 limit \u9650\u5236\uFF09\uFF1B\u53EA\u7ED9 server \u5219\u5217\u51FA\u8BE5 server \u7684\u5168\u90E8\u5DE5\u5177\u3002\u67E5\u5230\u540E\u7528 ${META_TOOL_CALL} \u8C03\u7528\u3002`,
      parameters: {
        query: { type: "string", description: "\u5173\u952E\u8BCD\uFF08\u7A7A\u683C\u5206\u9694\u591A\u4E2A\uFF0C\u5982\uFF1Ascan url\uFF09\uFF1B\u7559\u7A7A\u5217\u51FA\u5168\u90E8" },
        server: { type: "string", description: "\u9650\u5B9A\u67D0\u4E2A server\uFF08\u914D\u7F6E\u91CC\u7684 name\uFF09" },
        limit: { type: "number", description: `\u8FD4\u56DE\u6761\u6570\uFF08\u9ED8\u8BA4 ${SEARCH_DEFAULT_LIMIT}\uFF0C\u4E0A\u9650 ${SEARCH_MAX_LIMIT}\uFF09` }
      },
      output: {
        schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true } } },
        render: (_args, value) => [{ type: "text", text: typeof value.text === "string" ? String(value.text) : "" }]
      },
      execute: async (args) => {
        const result = await this.search({ query: args.query, server: args.server, limit: args.limit });
        const base = renderSearchText(result.matches, { query: args.query, total: result.total });
        const suffix = result.errors.length === 0 ? "" : `

\u4EE5\u4E0B server \u6682\u65F6\u53D6\u4E0D\u5230\u76EE\u5F55\uFF08\u4E0D\u5F71\u54CD\u5176\u5B83 server\uFF09\uFF1A
${result.errors.map((entry) => `- ${entry.name}\uFF1A${entry.error}`).join("\n")}`;
        return { ok: true, count: result.matches.length, total: result.total, text: base + suffix };
      }
    })));
    keep(ctx.tools.register(defineTool({
      name: META_TOOL_CALL,
      description: `\u8C03\u7528\u88AB\u4EE3\u7406\u7684 MCP server \u4E0A\u7684\u67D0\u4E2A\u5DE5\u5177\uFF08server/tool \u7528 ${META_TOOL_SEARCH} \u67E5\u5230\u7684\u540D\u5B57\uFF1Bargs \u662F\u6309\u8BE5\u5DE5\u5177\u53C2\u6570\u540D\u7EC4\u6210\u7684\u5BF9\u8C61\uFF09\u3002\u5DE5\u5177\u540D\u5199\u9519\u4F1A\u5728\u672C\u5730\u5C31\u88AB\u62E6\u4E0B\u5E76\u7ED9\u51FA\u76F8\u8FD1\u540D\u5B57\uFF0C\u4E0D\u4F1A\u6253\u5230 server\u3002\u8FD4\u56DE\u503C\u539F\u6837\u5E26\u56DE\u3002`,
      parameters: {
        server: { type: "string", required: true, description: "server \u540D\uFF08\u914D\u7F6E\u91CC\u7684 name\uFF09" },
        tool: { type: "string", required: true, description: "\u5DE5\u5177\u540D\uFF08server \u4FA7\u539F\u59CB\u540D\uFF0C\u4E0D\u542B mcp__ \u524D\u7F00\uFF09" },
        args: { type: "json", description: '\u8BE5\u5DE5\u5177\u7684\u8C03\u7528\u53C2\u6570\u5BF9\u8C61\uFF0C\u5982 {"url":"http://x"}' }
      },
      output: {
        schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true } } },
        render: (_args, value) => [{
          type: "text",
          text: typeof value.text === "string" && String(value.text) !== "" ? String(value.text) : String(value.error ?? "")
        }]
      },
      execute: async (args) => {
        const result = await this.call(args.server, args.tool, args.args);
        if (result.ok) {
          return {
            ok: true,
            text: result.text,
            ...result.structured === void 0 || result.structured === null ? {} : { structured: result.structured }
          };
        }
        return { ok: false, error: result.error ?? "call failed", text: result.error ?? "call failed" };
      }
    })));
    return disposers;
  }
  /**
   * Register the `directTools` of a hybrid server as real `mcp__<server>__<tool>` entries.
   * @returns the registered names, the names with no metadata (server does not advertise
   *   them), and a disposer per registration so a reconfigure can undo it.
   */
  registerPromotedTools(ctx, server) {
    const catalog = this.catalogFor(server.name);
    const registered = [];
    const missing = [];
    const disposers = [];
    for (const rawName of server.directTools) {
      const meta = catalog.find((candidate) => candidate.name === rawName);
      if (meta === void 0) {
        missing.push(rawName);
        continue;
      }
      const publicName = `mcp__${server.name}__${rawName}`;
      const description = meta.description.trim() === "" ? `MCP \u5DE5\u5177 ${server.name}.${rawName}\uFF08server \u672A\u63D0\u4F9B\u63CF\u8FF0\uFF09\u3002` : meta.description;
      const dispose = ctx.tools.register(defineTool({
        name: publicName,
        description,
        parameters: toToolParameters(meta.inputSchema),
        output: {
          schema: { type: "object", additionalProperties: true, properties: { ok: { type: "boolean", required: true } } },
          render: (_args, value) => [{
            type: "text",
            text: typeof value.text === "string" && String(value.text) !== "" ? String(value.text) : String(value.error ?? "")
          }]
        },
        execute: async (args) => {
          const result = await this.call(server.name, rawName, args);
          if (result.ok) {
            return {
              ok: true,
              text: result.text,
              ...result.structured === void 0 || result.structured === null ? {} : { structured: result.structured }
            };
          }
          return { ok: false, error: result.error ?? "call failed", text: result.error ?? "call failed" };
        }
      }));
      if (typeof dispose === "function") disposers.push(dispose);
      registered.push(publicName);
    }
    return { registered, missing, disposers };
  }
};

// src/index.ts
var name = "dsh-mcp-studio";
var inject = ["tools", "settings"];
var STUDIO_SETTINGS_NAMESPACE = "mcp-studio";
function signatureOf(server) {
  return JSON.stringify(toMcpClientConfig(server));
}
async function apply(ctx, config) {
  let current = () => config;
  let alive = true;
  const mounts = /* @__PURE__ */ new Map();
  const tracker = { states: /* @__PURE__ */ new Map() };
  const proxy = new ProxyRegistry(
    () => current(),
    (format, ...args) => ctx.logger.info(format, ...args)
  );
  const decide = (server) => decideExposure(server, proxy.listedCount(server.name));
  const promotions = /* @__PURE__ */ new Map();
  let metaTools;
  let settlePromise;
  const settleProxy = () => {
    if (!alive) return Promise.resolve();
    if (settlePromise !== void 0) return settlePromise;
    settlePromise = (async () => {
      try {
        await proxy.ensureAll();
        if (alive) reconcile();
      } finally {
        settlePromise = void 0;
      }
    })();
    return settlePromise;
  };
  const serversOf = () => {
    try {
      const list = current()?.servers;
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };
  const reconcile = () => {
    if (!alive) return;
    const enabled = serversOf().filter((server) => server.enabled);
    proxy.syncServers(enabled.filter((server) => decide(server) !== "direct"));
    const wanted = /* @__PURE__ */ new Map();
    for (const server of enabled) {
      if (decide(server) === "direct") wanted.set(server.id, server);
    }
    for (const [id, mount] of [...mounts]) {
      const server = wanted.get(id);
      if (server === void 0 || signatureOf(server) !== mount.signature) {
        mount.dispose();
        mounts.delete(id);
        tracker.states.delete(id);
      }
    }
    for (const [id, server] of wanted) {
      if (mounts.has(id)) continue;
      const clientConfig = toMcpClientConfig(server);
      tracker.states.set(id, { state: "mounting" });
      let fiber;
      try {
        fiber = ctx.plugin(mcpClient, clientConfig);
      } catch (error) {
        ctx.logger.warn('mcp-studio: could not mount server "%s": %s', server.name, String(error));
        tracker.states.set(id, { state: "error", error: String(error) });
        continue;
      }
      const ready = Promise.resolve(fiber);
      mounts.set(id, { dispose: () => fiber.dispose(), signature: JSON.stringify(clientConfig), ready });
      ready.then(
        () => {
          if (tracker.states.get(id)?.state === "mounting") tracker.states.set(id, { state: "mounted" });
        },
        (error) => {
          tracker.states.set(id, { state: "error", error: error instanceof Error ? error.message : String(error) });
          ctx.logger.warn('mcp-studio: server "%s" failed to start: %s', server.name, String(error instanceof Error ? error.message : error));
        }
      );
    }
    for (const server of serversOf()) {
      if (!mounts.has(server.id)) tracker.states.delete(server.id);
    }
    const wantedPromotions = /* @__PURE__ */ new Set();
    for (const server of enabled) {
      if (server.exposure !== "hybrid" || decide(server) !== "proxy") continue;
      const signature = JSON.stringify([server.name, server.directTools]);
      const existing = promotions.get(server.id);
      if (existing !== void 0 && existing.signature === signature) {
        wantedPromotions.add(server.id);
        continue;
      }
      if (existing !== void 0) {
        for (const dispose of existing.disposers) {
          try {
            dispose();
          } catch {
          }
        }
        promotions.delete(server.id);
      }
      if (proxy.listedCount(server.name) === void 0) continue;
      let result;
      try {
        result = proxy.registerPromotedTools(ctx, server);
      } catch (error) {
        ctx.logger.warn('mcp-studio: promoting tools for "%s" failed: %s', server.name, String(error));
        continue;
      }
      if (result.missing.length > 0) {
        ctx.logger.warn('mcp-studio: "%s" does not advertise directTools: %s', server.name, result.missing.join(", "));
      }
      promotions.set(server.id, { signature, disposers: result.disposers, names: result.registered });
      wantedPromotions.add(server.id);
    }
    for (const [id, promotion] of [...promotions]) {
      if (wantedPromotions.has(id)) continue;
      for (const dispose of promotion.disposers) {
        try {
          dispose();
        } catch {
        }
      }
      promotions.delete(id);
    }
    const anyProxied = enabled.some((server) => decide(server) === "proxy");
    if (anyProxied && metaTools === void 0) {
      try {
        metaTools = proxy.registerMetaTools(ctx);
      } catch (error) {
        ctx.logger.warn("mcp-studio: registering proxy meta-tools failed: %s", String(error));
      }
    } else if (!anyProxied && metaTools !== void 0) {
      for (const dispose of metaTools) {
        try {
          dispose();
        } catch {
        }
      }
      metaTools = void 0;
    }
    if (enabled.some((server) => decide(server) === "pending")) void settleProxy();
  };
  const retryBackoff = /* @__PURE__ */ new Map();
  const WATCHDOG_MS = 15e3;
  const watchdogTick = () => {
    if (!alive) return;
    try {
      tickOnce();
    } catch (error) {
      ctx.logger?.warn?.(`mcp-studio: watchdog tick failed: ${error?.message ?? error}`);
    }
  };
  const tickOnce = () => {
    for (const id of [...retryBackoff.keys()]) {
      if (!serversOf().some((server) => server.id === id && server.enabled)) retryBackoff.delete(id);
    }
    let view;
    try {
      view = ctx.get("tools")?.view(void 0);
    } catch {
      view = void 0;
    }
    const visible = typeof view === "object" && view !== null && view.visible instanceof Map ? view.visible : void 0;
    const now = Date.now();
    let forced = false;
    for (const server of serversOf()) {
      if (!server.enabled) continue;
      const prefix = `mcp__${server.name}__`;
      let count = 0;
      if (visible !== void 0) {
        for (const toolName of visible.keys()) if (toolName.startsWith(prefix)) count += 1;
      }
      if (decide(server) !== "direct") {
        if (proxy.hasCatalog(server.name)) {
          retryBackoff.delete(server.id);
          continue;
        }
        const state2 = retryBackoff.get(server.id) ?? { attempts: 0, nextAt: 0 };
        if (now < state2.nextAt) continue;
        state2.attempts += 1;
        state2.nextAt = now + Math.min(WATCHDOG_MS * 2 ** (state2.attempts - 1), 3e5);
        retryBackoff.set(server.id, state2);
        ctx.logger.info('mcp-studio: proxy catalog for "%s" unavailable \u2014 re-list attempt %d (retry in %dms)', server.name, state2.attempts, state2.nextAt - now);
        void proxy.ensure(server.name, { force: true }).then(() => {
          if (alive) reconcile();
        });
        continue;
      }
      if (!mounts.has(server.id)) continue;
      if (count > 0) {
        retryBackoff.delete(server.id);
        continue;
      }
      const state = retryBackoff.get(server.id) ?? { attempts: 0, nextAt: 0 };
      if (now < state.nextAt) continue;
      state.attempts += 1;
      state.nextAt = now + Math.min(WATCHDOG_MS * 2 ** (state.attempts - 1), 3e5);
      retryBackoff.set(server.id, state);
      ctx.logger.info('mcp-studio: "%s" mounted but no visible tools \u2014 remount attempt %d (retry in %dms)', server.name, state.attempts, state.nextAt - now);
      try {
        mounts.get(server.id)?.dispose();
      } catch {
      }
      mounts.delete(server.id);
      tracker.states.delete(server.id);
      forced = true;
    }
    if (forced) reconcile();
  };
  const watchdog = setInterval(watchdogTick, WATCHDOG_MS);
  ctx.effect(() => () => clearInterval(watchdog), "mcp-studio: watchdog");
  ctx.effect(() => () => {
    alive = false;
    for (const mount of mounts.values()) {
      try {
        mount.dispose();
      } catch (error) {
        ctx.logger.warn("mcp-studio: mount disposal failed: %s", String(error));
      }
    }
    mounts.clear();
    tracker.states.clear();
    for (const promotion of promotions.values()) {
      for (const dispose of promotion.disposers) {
        try {
          dispose();
        } catch {
        }
      }
    }
    promotions.clear();
    if (metaTools !== void 0) {
      for (const dispose of metaTools) {
        try {
          dispose();
        } catch {
        }
      }
      metaTools = void 0;
    }
    proxy.closeAll();
  }, "mcp-studio: lifecycle");
  try {
    const scope = ctx.settings.register(STUDIO_SETTINGS_NAMESPACE, Config, {
      base: config,
      validate: validateSection
    });
    current = () => scope.get();
    scope.watch(() => {
      reconcile();
    });
  } catch (error) {
    ctx.logger.warn("mcp-studio: settings provider unavailable, keeping patch baseline: %s", String(error));
  }
  const executions = createExecutionRing(200);
  const inflight = /* @__PURE__ */ new Map();
  ctx.effect(() => {
    const sweeper = setInterval(() => {
      const cutoff = Date.now() - 10 * 6e4;
      for (const [key, entry] of [...inflight]) {
        if (entry.at < cutoff) inflight.delete(key);
      }
    }, 6e4);
    return () => {
      clearInterval(sweeper);
    };
  }, "mcp-studio: inflight sweep");
  ctx.on("session/event", ((session, event) => {
    if (event.type === "tool/call") {
      const name2 = typeof event.data.name === "string" ? event.data.name : "";
      if (!name2.startsWith("mcp__")) return;
      const callId = typeof event.data.callId === "string" ? event.data.callId : "";
      const sessionId = String(session.id ?? "");
      inflight.set(`${sessionId}:${event.time}:${callId}`, {
        server: name2.split("__")[1] ?? "",
        tool: name2,
        at: event.time
      });
      return;
    }
    if (event.type === "tool/result") {
      const message = event.data.message ?? {};
      const callId = typeof message.source?.callId === "string" && message.source?.kind === "tool" ? message.source.callId : (message.content ?? []).find((block) => typeof block?.toolCallId === "string")?.toolCallId;
      if (typeof callId !== "string") return;
      const sessionId = String(session.id ?? "");
      for (const [key, entry] of [...inflight]) {
        if (!key.startsWith(`${sessionId}:`) || !key.endsWith(`:${callId}`)) continue;
        inflight.delete(key);
        const isError = (message.content ?? []).some((block) => block?.isError === true) || event.data.error !== void 0;
        const errorInfo = event.data.error;
        executions.push({
          at: entry.at,
          server: entry.server,
          tool: entry.tool,
          durationMs: Math.max(0, event.time - entry.at),
          ok: !isError,
          ...isError && errorInfo !== void 0 ? { error: JSON.stringify(errorInfo).slice(0, 300) } : {}
        });
      }
    }
  }));
  ctx.inject(["connection", "settings", "webServer"], (web) => {
    const scope = web;
    const { connection, settings } = web;
    const proxyView = {
      catalog: (serverName) => proxy.catalogFor(serverName).map((meta) => ({ name: meta.name, description: meta.description })),
      state: (serverName) => proxy.stateOf(serverName)
    };
    const status = createStatusHandler(
      () => current(),
      () => ctx.get("tools")?.view(void 0),
      tracker,
      executions,
      { view: proxyView, exposureOf: (server) => decide(server) === "proxy" ? "proxy" : "direct" }
    );
    const diagnose = async (id) => {
      const server = current().servers.find((row) => row.id === id);
      if (server === void 0) {
        return { ok: false, error: { code: "bad-request", message: `unknown server row "${id}"`, details: {} } };
      }
      const report = await diagnoseServer(server);
      return { ok: true, value: report };
    };
    const debug = () => {
      const toolsSvc = ctx.get("tools");
      let view;
      try {
        view = toolsSvc?.view?.(void 0);
      } catch {
        view = "threw";
      }
      const names = view !== "threw" && typeof view === "object" && view !== null && view.visible instanceof Map ? [...view.visible.keys()] : null;
      return {
        hasToolsService: Boolean(toolsSvc),
        hasViewMethod: typeof toolsSvc?.view === "function",
        viewKind: view === void 0 ? "undefined" : view === "threw" ? "threw" : typeof view,
        globalViewSize: names === null ? null : names.length,
        mcpPrefixed: names === null ? null : names.filter((name2) => name2.startsWith("mcp__")).slice(0, 12),
        sampleNames: names === null ? null : names.slice(0, 12),
        // Tool-surface accounting: this is the number the proxy mode is meant to bring down.
        metaTools: names === null ? null : names.filter((name2) => name2 === META_TOOL_SEARCH || name2 === META_TOOL_CALL),
        promoted: [...promotions.entries()].map(([id, promotion]) => ({ id, tools: promotion.names })),
        proxy: { mounts: proxy.snapshot(), catalog: summarizeCatalog(proxy.catalog()) },
        notes: [...tracker.states.entries()].map(([id, note]) => ({ id, ...note })),
        // Self-healing retry ledger: attempts=0 (absent) means the server's tools are visible,
        // so the watchdog leaves it alone.
        retry: [...retryBackoff.entries()].map(([id, state]) => ({ id, attempts: state.attempts, nextInMs: Math.max(0, state.nextAt - Date.now()) })),
        mountedIds: [...mounts.keys()],
        servers: current().servers.map((server) => ({
          id: server.id,
          name: server.name,
          enabled: server.enabled,
          transport: server.transport,
          exposure: server.exposure,
          effective: decide(server),
          proxyThreshold: server.proxyThreshold,
          directTools: server.directTools
        }))
      };
    };
    registerStudioRpc(scope, connection, settings, STUDIO_SETTINGS_NAMESPACE, status, diagnose, () => executions.clear(), debug);
  });
  reconcile();
  const STARTUP_MOUNT_SETTLE_MS = 5e3;
  const startupDeadline = Date.now() + STARTUP_MOUNT_SETTLE_MS;
  const remaining = () => Math.max(0, startupDeadline - Date.now());
  const timeout = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await Promise.race([settleProxy(), timeout(remaining())]);
  const directReadiness = [...mounts.values()].map((mount) => mount.ready);
  if (directReadiness.length > 0) await Promise.race([Promise.allSettled(directReadiness), timeout(remaining())]);
  if (Date.now() >= startupDeadline && mounts.size > 0) {
    ctx.logger.info("mcp-studio: MCP startup still settling after %dms; first request may see a partial tool surface", STARTUP_MOUNT_SETTLE_MS);
  }
}
export {
  STUDIO_SETTINGS_NAMESPACE,
  apply,
  inject,
  name
};
