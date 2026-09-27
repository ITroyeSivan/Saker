import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { classifyMemoryBackend } from "./post.js";

const COMMANDS = new Set([
  "version",
  "config",
  "probe",
  "gen",
  "connect",
  "exec",
  "upload",
  "download",
  "save",
  "list",
  "note",
  "remove",
  "log",
  "profile",
  "custom",
]);
const APPROVAL_REQUIRED = new Set(["probe", "gen", "connect", "exec", "upload", "download", "save", "remove", "profile", "custom"]);
const SENSITIVE_FLAG_RE = /^--?(pass|password|key|token|secret|godzilla-pass|godzilla-key|behinder-pass|behinder-key)$/i;

function clean(value, max = 1000) {
  return String(value ?? "").trim().slice(0, max);
}

function quoteWinArg(value) {
  const text = String(value ?? "");
  if (!/[\s"&|<>^]/.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/, "$1$1")}"`;
}

function resolveCli(cli) {
  const value = clean(cli, 1000) || "memparty";
  if (path.isAbsolute(value) || value.includes("/") || value.includes("\\")) return value;
  const lookup = process.platform === "win32"
    ? spawnSync("where.exe", [value], { encoding: "utf8", windowsHide: true })
    : spawnSync("which", [value], { encoding: "utf8" });
  const found = String(lookup.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
  return found || value;
}

export function commandRisk(command) {
  const value = clean(command, 40).toLowerCase();
  if (value === "gen" || value === "custom") return "payload-generation";
  if (value === "probe") return "target-probe";
  if (["connect", "exec", "upload", "download", "save", "remove", "profile"].includes(value)) return "access-action";
  return "read-only";
}

/**
 * 不可逆 / 破坏性动作的模式表。
 *
 * 为什么要有这一层：审批原来只按**子命令**分档（`exec` 一律是 access-action），
 * 于是 `exec whoami` 与 `exec rm -rf /` 拿到的是同一句批准短语。这与预设 persona 的
 * 硬规则（「删除类操作严禁执行」、命令执行默认只跑 whoami 与只读命令）不一致：
 * 规则写在提示词里，执行器却照批不误。
 *
 * 这里把判据下沉到**参数内容**，并且对破坏性动作**直接拒绝**而不是"批准后可执行"——
 * 需要删除时，正确做法是把它写成清理计划呈报用户，不是让 CLI 代跑。
 * 代价是保守：参数里出现这些词就拦，宁可误拦一次也不放行一次。
 */
const DESTRUCTIVE_PATTERNS = [
  { re: /(^|[\s;&|])(rm|rmdir|unlink)([\s;&|]|$)/i, label: "删除文件/目录" },
  { re: /(^|[\s;&|])(del|erase)([\s;&|]|$)/i, label: "删除文件" },
  { re: /(^|[\s;&|])format([\s;&|]|$)/i, label: "格式化磁盘" },
  { re: /(^|[\s;&|])mkfs(\.[a-z0-9]+)?([\s;&|]|$)/i, label: "抹除文件系统" },
  { re: /(^|[\s;&|])(shutdown|reboot|halt|poweroff)([\s;&|]|$)/i, label: "关机/重启" },
  { re: /(^|[\s;&|])(taskkill|killall|pkill)([\s;&|]|$)/i, label: "批量结束进程" },
  { re: /(^|[\s;&|])diskpart([\s;&|]|$)/i, label: "磁盘分区操作" },
  { re: /(^|[\s;&|])reg\s+delete([\s;&|]|$)/i, label: "删除注册表项" },
  { re: /(^|[\s;&|])iptables\s+-F([\s;&|]|$)/i, label: "清空防火墙规则" },
  { re: /(^|[\s;&|])vssadmin\s+delete/i, label: "删除卷影副本" },
  { re: /(^|[\s;&|])cipher\s+\/w/i, label: "擦除空闲空间" },
  { re: /(^|[\s;&|])drop\s+(table|database)/i, label: "删表/删库" },
  { re: /(^|[\s;&|])truncate\s+table/i, label: "清空表" },
  { re: /(^|[\s;&|])delete\s+from/i, label: "批量删数据" },
  { re: /(^|[\s;&|])update\s+[\w."]+\s+set/i, label: "批量改数据" },
  { re: /(^|[\s;&|])net\s+user\s+\S+\s+\/delete/i, label: "删除账号" },
];

/**
 * 只读命令白名单：与 persona「命令执行默认只跑 whoami 与只读命令」对齐。
 * 按**词边界搜索**而不是行首匹配——实际调用形如 `exec --cmd "whoami"`，
 * 命令前面一定带参数名，锚在行首会永远判不出来。
 * 破坏性判据在它之前执行，所以 `whoami && rm -rf /` 这类组合先被拦下，不会落到这里。
 */
const READONLY_EXEC_PATTERN =
  /(^|[\s;&|"'])(whoami|id|pwd|hostname|uname|ver|echo|ls|dir|ipconfig|ifconfig|netstat|ps|tasklist|type|cat|head|tail|findstr|grep|env)([\s;&|"']|$)/i;

/**
 * 按**参数内容**给一次动作分档。返回 tier 之外还给出 blocked 与理由，
 * 让计划阶段就能拦下不可逆动作，而不是执行完再补救。
 * @param {string} command - memparty 子命令。
 * @param {string[]} args - 该子命令的参数。
 * @returns {{ tier: string, blocked: boolean, reason: string, evidence: string }}
 */
export function classifyActionImpact(command, args = []) {
  const name = clean(command, 40).toLowerCase();
  const text = (Array.isArray(args) ? args : []).map((v) => String(v ?? "")).join(" ");
  const evidence = clean(text, 300);

  const destructive = DESTRUCTIVE_PATTERNS.find((p) => p.re.test(text));
  if (destructive !== undefined) {
    return {
      tier: "destructive",
      blocked: true,
      reason: `参数命中破坏性动作（${destructive.label}）；删除/抹除类操作严禁由执行器代跑，请改成清理计划呈报用户`,
      evidence,
    };
  }

  // MCP 通道的工具名是 `exec_command` 这类，按语义一起归到 exec 判据。
  if (name === "exec" || /exec|command|cmd/.test(name)) {
    if (READONLY_EXEC_PATTERN.test(text)) {
      return { tier: "read-only-exec", blocked: false, reason: "只读命令（whoami/echo/ls 一类），符合最小影响验证口径", evidence };
    }
    return {
      tier: "state-changing-exec",
      blocked: false,
      reason: "命令不在只读白名单内：批准前请确认它不写入、不删除、不改配置；写操作应改走清理计划",
      evidence,
    };
  }

  const tiers = {
    version: "read-only",
    config: "read-only",
    list: "read-only",
    note: "read-only",
    log: "read-only",
    probe: "target-probe",
    connect: "session",
    gen: "payload-generation",
    custom: "payload-generation",
    download: "read",
    upload: "write",
    save: "write",
    profile: "state-changing",
    remove: "cleanup",
  };
  const tier = tiers[name] || "unknown";
  const reasons = {
    "read-only": "只读/诊断动作",
    "target-probe": "对目标发包探测（不改状态，但会留痕）",
    session: "建立会话（进入交互面）",
    "payload-generation": "生成载荷（只生成，不投递；投递是另一条要单独批准的动作）",
    read: "从目标读取内容（可能带出数据）",
    write: "向目标写入内容：必须预先记录落地路径与清理步骤",
    "state-changing": "改变后端/目标状态",
    cleanup: "清理动作：可能删除目标上的组件，批准前需确认它属于既定清理步骤",
    unknown: "未分类动作，按最高风险对待",
  };
  return { tier, blocked: false, reason: reasons[tier] || reasons.unknown, evidence };
}

export function redactArgv(argv) {
  const out = [];
  let redactNext = false;
  for (const value of Array.isArray(argv) ? argv : []) {
    if (redactNext) {
      out.push("<redacted>");
      redactNext = false;
      continue;
    }
    out.push(value);
    if (SENSITIVE_FLAG_RE.test(String(value))) redactNext = true;
  }
  return out;
}

export function redactObject(value, depth = 0) {
  if (depth > 8) return "<max-depth>";
  if (Array.isArray(value)) return value.map((item) => redactObject(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = /pass|password|key|token|secret/i.test(key) ? "<redacted>" : redactObject(item, depth + 1);
  }
  return out;
}

function mcpToolRisk(tool) {
  const value = clean(tool, 120).toLowerCase();
  if (/generate_memshell|custom/.test(value)) return "payload-generation";
  if (/probe|generate_probe/.test(value)) return "target-probe";
  if (/connect|exec|command|upload|download|save|remove|profile/.test(value)) return "access-action";
  return "read-only";
}

export function buildMemshellMcpPlan(config, input = {}) {
  const backend = classifyMemoryBackend(config);
  if (!backend.ready) return { ok: false, error: backend.reason };
  const server = clean(config.mcpServer || "memshell-party", 120);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(server)) return { ok: false, error: `MCP server 名不合法：${server}` };
  const tool = clean(input.mcpTool, 120);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(tool)) return { ok: false, error: `MCP tool 名不合法：${tool || "（空）"}` };
  const args = input.mcpArgs && typeof input.mcpArgs === "object" ? input.mcpArgs : {};
  const risk = mcpToolRisk(tool);
  // MCP 通道同样按参数内容分档：直连 memparty MCP 工具也走这条判据。
  const flattened = Object.values(args).flatMap((value) => Array.isArray(value) ? value : [value]);
  const impact = classifyActionImpact(tool, flattened);
  if (impact.blocked) return { ok: false, error: `memshell_cli 拒绝该 MCP 计划：${impact.reason}` };
  // MCP 工具名不是 CLI 子命令时 classifyActionImpact 给不出档位，用工具名风险档兜底。
  const impactTier = impact.tier === "unknown" ? risk : impact.tier;
  const approvalRequired = risk !== "read-only";
  const planId = `mp-${randomBytes(6).toString("hex")}`;
  const approvalPhrase = approvalRequired ? `APPROVE-${planId}` : "";
  const approvalToken = randomBytes(12).toString("hex");
  return {
    ok: true,
    plan: {
      schema: "saker.memshell-mcp-plan/1",
      planId,
      createdAt: new Date().toISOString(),
      transport: "mcp",
      server,
      tool,
      name: `mcp__${server}__${tool}`,
      args,
      argsPreview: redactObject(args),
      risk,
      approvalRequired,
      approvalPhrase,
      approvalToken,
      backendHost: backend.host,
      payloadReview: {
        risk,
        impact: impactTier,
        blocked: false,
        summary: approvalRequired
          ? `风险档 ${risk} / 影响档 ${impact.tier}；参数中的口令/密钥已从展示与审计中脱敏。`
          : "只读/诊断 MCP 调用。",
        limits: impact.reason,
      },
      status: "planned",
    },
  };
}

export function defaultCliRunner(cli, argv, options = {}) {
  const timeout = Number(options.timeoutMs) || 120_000;
  const exec = resolveCli(cli);
  const direct = spawnSync(exec, argv, {
    encoding: "utf8",
    timeout,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (!direct.error || process.platform !== "win32" || !/\.(cmd|bat)$/i.test(exec)) return direct;
  const line = [exec, ...argv].map(quoteWinArg).join(" ");
  return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", line], {
    encoding: "utf8",
    timeout,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
}

export function buildMemshellCliPlan(config, input = {}) {
  const backend = classifyMemoryBackend(config);
  if (!backend.ready) return { ok: false, error: backend.reason };
  const command = clean(input.command, 40).toLowerCase();
  if (!COMMANDS.has(command)) return { ok: false, error: `不支持的 memparty 子命令：${command || "（空）"}` };
  const args = Array.isArray(input.args) ? input.args.map((value) => clean(value, 2000)).filter(Boolean) : [];
  if (args.length > 80) return { ok: false, error: "参数过多（上限 80 项）" };
  if (args.some((value) => value === "--api" || value.startsWith("--api=") || /MEMPARTY_API_URL/i.test(value))) {
    return { ok: false, error: "不允许覆盖 --api / MEMPARTY_API_URL；执行器固定使用自建 backend" };
  }
  // 参数级判据：破坏性动作在**计划阶段**就拒绝，不进审批队列。
  const impact = classifyActionImpact(command, args);
  if (impact.blocked) return { ok: false, error: `memshell_cli 拒绝该计划：${impact.reason}` };
  const argv = ["--api", clean(config.backendUrl, 1000).replace(/\/+$/, ""), command, ...args];
  const planId = `ms-${randomBytes(6).toString("hex")}`;
  const risk = commandRisk(command);
  const approvalRequired = APPROVAL_REQUIRED.has(command);
  const approvalPhrase = approvalRequired ? `APPROVE-${planId}` : "";
  const argvPreview = redactArgv(argv);
  return {
    ok: true,
    plan: {
      schema: "saker.memshell-cli-plan/1",
      planId,
      createdAt: new Date().toISOString(),
      cli: clean(config.cliPath, 1000) || "memparty",
      backendHost: backend.host,
      command,
      args,
      argv,
      argvPreview,
      commandLine: [clean(config.cliPath, 1000) || "memparty", ...argvPreview].join(" "),
      risk,
      approvalRequired,
      approvalPhrase,
      payloadReview: {
        risk,
        impact: impact.tier,
        blocked: false,
        summary: approvalRequired
          ? `风险档 ${risk} / 影响档 ${impact.tier}；批准短语绑定本次 planId，命令中的口令/密钥已从展示与审计中脱敏。`
          : "只读/诊断命令，不生成或投放载荷。",
        limits: impact.reason,
      },
      status: "planned",
    },
  };
}

export function executeMemshellCliPlan(plan, options = {}) {
  if (!plan || plan.schema !== "saker.memshell-cli-plan/1") return { ok: false, error: "无效的 memshell CLI 计划" };
  if (!Array.isArray(plan.argv) || plan.argv.length < 3) return { ok: false, error: "计划缺少可执行参数" };
  const runner = options.runner || defaultCliRunner;
  const startedAt = new Date().toISOString();
  const result = runner(plan.cli || "memparty", plan.argv, { timeoutMs: options.timeoutMs });
  const stdout = String(result?.stdout || "").slice(0, 500_000);
  const stderr = String(result?.stderr || "").slice(0, 200_000);
  return {
    ok: !result?.error && result?.status === 0,
    planId: plan.planId,
    command: plan.command,
    commandLine: plan.commandLine,
    exitCode: typeof result?.status === "number" ? result.status : null,
    signal: result?.signal || "",
    timedOut: result?.error?.code === "ETIMEDOUT",
    error: result?.error ? String(result.error.message || result.error) : "",
    stdout,
    stderr,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
