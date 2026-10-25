// Persistent task limits evaluated by the official desktop's monotonic tool guard.
// Counts tool executions, including shell calls; it does not count HTTP requests
// launched inside a command. Such requests still need their separate tool limits.
import { allFindings } from './store.js';
import { findingDeliveryState } from './delivery.js';
import { readTaskContext } from './task-context.js';
import { parseRowRecord } from './row-record.js';
import { readChecks } from './checked.js';
import { normalizeTaskFlow, advanceTaskFlow, taskFlowPrompt } from './task-flow.js';
import { normalizeInteraction, interactionPrompt, reportingFor, requiresCheckpoint, MAX_SITE_WORKERS } from './interaction.js';
import { chatDefaults } from './chat-setup.js';
import { normalizeModelChoice } from './model-choice.js';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { taskTransaction, writeTaskPolicy, childAllowedTools, ownedPurposeTasks } from './task-policy-record.js';
import { normalizeRequestRate, normalizeRequestConcurrency } from './request-pacing.js';
import { researchNext } from './research.js';
import { normalizeTaskScope, taskScopeAllowsUrl, taskScopeIncludesUrl, taskScopeAllowsAsset, taskScopeExcluded, taskScopeSummary, taskScopePromptText, taskTermInPolicy } from './task-scope.js';

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");

const modes = new Set(['nday', 'regular', '0day']);
const stops = new Set(['first-high', 'first-rce', 'queue', 'budget']);
const startModes = new Set(['materials-first', 'auto-recon', 'direct-test']);
const localTools = new Set(['redteam_task', 'redteam_context', 'redteam_checks', 'redteam_delivery',
  'redteam_method', 'redteam_research', 'redteam_execution',
  'redteam_finding_register', 'redteam_finding_update', 'redteam_finding_delete', 'redteam_chain_reconcile',
  'read', 'write', 'edit', 'glob', 'grep', 'run_code', 'skill', 'tool_pack',
  'mcp_search', 'exercise_submit',
  'project_document', 'project_check']);
const projectMetadataTools = new Set(['working_directory', 'get_goal', 'todo_write', 'read_image']);
// 批次 A：方法编排与抽象工作台已退出运行。任何一次调用都直接拒绝并计数，
// 不再当作"本地登记"放行——否则停用后模型仍能通过它们继续推进目标操作。
const retiredTools = new Set(['saker_method', 'execution_modules',
  'operation_goal', 'operation_scope', 'operation_intent', 'operation_task',
  'operation_progress', 'operation_constraints', 'operation_conclude',
  'stage_gate', 'gates_list', 'attack_atlas', 'campaign_memory', 'webshell_mgr',
  'project_workspace', 'outcome_overview']);
// 会发出**无法逐条计量**的目标流量的本地扫描工具：一次工具调用 ≠ 一个目标请求。
// 它们的实际请求数取决于目标与模板，程序不能假装知道；所以要求任务**显式允许**次数，否则拒绝。
const unmeteredTrafficTools = new Set(['nuclei_scan', 'httpx_probe', 'ffuf_fuzz']);
// 宿主 shell 与 MCP 工具：本身不是本地工具，但参数里出现"授权范围内的 URL"时它就在发目标流量。
// 一次工具调用不等于一个目标请求，所以和扫描器一样需要显式未计量额度。
// 这是约束与提示，不是沙箱（编码/间接调用仍可能绕过）；要留证据仍应走可计量执行入口。
const URL_IN_COMMAND = /https?:\/\/[^\s"'`()<>|[\]{}]+/gi;
const SHELL_COMMAND_KEYS = new Set(['command', 'cmd', 'script', 'code', 'shell', 'input']);
const URL_ARGUMENT_KEYS = new Set(['url', 'uri', 'endpoint', 'target', 'base-url', 'baseUrl', 'baseURL',
  'targetUrl', 'target_url', 'requestUrl', 'request_url', 'host', 'hostname']);
const SHELL_NETWORK_COMMAND = /(?:^|[;&|\r\n]\s*)(?:curl(?:\.exe)?|wget(?:\.exe)?|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|http(?:\.exe)?|https(?:\.exe)?|nuclei|httpx|ffuf|nmap)\b[^\r\n;&|]*/gim;
const offlineMcpTools = new Set(['base64_encode', 'base64_decode', 'url_encode', 'url_decode']);
function offlineToolCall(name, args) {
  if (name !== 'mcp_call') return false;
  try {
    const doc = typeof args === 'string' ? JSON.parse(args) : args;
    const server = String(doc?.server || '').toLowerCase();
    if (['burp', 'yakit'].includes(server) && offlineMcpTools.has(doc?.tool)) return true;
    // Yakit's live schema uses encode/decode, not Burp's base64_encode names.
    // Do not grant exec_codec: it also supports scripts and custom plugins.
    const payload = doc?.args;
    return server === 'yakit' && ['encode', 'decode'].includes(doc?.tool)
      && payload && typeof payload.text === 'string' && typeof payload.type === 'string'
      && Object.keys(payload).every(key => ['text', 'type'].includes(key))
      && ['base64', 'b64', 'base64url', 'base32', 'hex', 'doubleurl', 'quote', 'ascii', 'html', 'htmlentity', 'htmlhex', 'url', 'unicode'].includes(payload.type);
  } catch { return false; }
}

function urlsInText(value) {
  const out = [];
  for (const match of String(value || '').matchAll(URL_IN_COMMAND)) {
    const raw = match[0].replace(/[),.;]+$/, '');
    try {
      const parsed = new URL(raw);
      if (['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password) out.push(parsed.href);
    } catch { /* not a complete URL */ }
  }
  return out;
}

/**
 * Shell text is not a URL container. Only inspect explicit network-command
 * segments, and ignore comments, so a GitHub reference in `echo` or `# ...`
 * is not misreported as target traffic.
 */
function urlsInShellText(value) {
  const text = String(value || '')
    .split(/\r?\n/)
    .map(line => line.replace(/(^|[^:])\/\/.*$/, '$1').replace(/#.*$/, ''))
    .join('\n');
  const out = [];
  for (const command of text.matchAll(SHELL_NETWORK_COMMAND)) out.push(...urlsInText(command[0]));
  return out;
}

/** Extract target URLs from structured tool args, raw HTTP messages and host/port pairs. */
function candidateUrlsFromArgs(args) {
  const found = [], seen = new Set();
  const add = values => {
    for (const value of values) if (!seen.has(value)) { seen.add(value); found.push(value); }
  };
  const visit = (value, inherited = {}, key = '') => {
    if (typeof value === 'string') {
      const requestLine = value.match(/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)\s+HTTP\/\d(?:\.\d)?/im);
      const host = value.match(/^Host:\s*([^\s\r\n]+)/im);
      if (requestLine && host) {
        const target = requestLine[1];
        add([/^https?:\/\//i.test(target) ? target
          : (inherited.scheme || 'http') + '://' + host[1] + (target.startsWith('/') ? target : '/' + target)]);
        return;
      }
      if (SHELL_COMMAND_KEYS.has(key)) { add(urlsInShellText(value)); return; }
      if (URL_ARGUMENT_KEYS.has(key) || /(?:^|[_-])(?:url|uri|endpoint|target)$/i.test(key)) {
        const direct = urlsInText(value);
        if (direct.length) { add(direct); return; }
        if (key.toLowerCase().includes('host')) {
          try {
            const endpoint = new URL((inherited.scheme || 'https') + '://' + value.trim());
            add([endpoint.href]);
          } catch { /* invalid host is rejected when the concrete adapter parses it */ }
        }
      }
      return;
    }
    if (Array.isArray(value)) { value.forEach(item => visit(item, inherited, key)); return; }
    if (!value || typeof value !== 'object') return;
    const host = value.host ?? value.hostname ?? value.Host;
    const tls = value.https ?? value.isHttps ?? value.secure;
    const scheme = value.scheme === 'http' || value.scheme === 'https' ? value.scheme
      : typeof tls === 'boolean' ? (tls ? 'https' : 'http')
        : inherited.scheme || (typeof host === 'string' && host.trim() ? 'https' : undefined);
    if (typeof host === 'string' && host.trim()) {
      const port = value.port ?? value.Port;
      const pathValue = value.path ?? value.pathname ?? value.urlPath ?? '/';
      const pathPart = String(pathValue || '/');
      try {
        const endpoint = new URL(scheme + '://' + host.trim());
        if (port !== undefined && port !== null && String(port).trim()) endpoint.port = String(port).trim();
        endpoint.pathname = pathPart.startsWith('/') ? pathPart : '/' + pathPart;
        add([endpoint.href]);
      } catch { /* concrete adapter reports an invalid endpoint */ }
    }
    for (const [childKey, item] of Object.entries(value)) {
      if (['host', 'hostname', 'Host'].includes(childKey)) continue;
      visit(item, { scheme }, childKey);
    }
  };
  let doc = args;
  if (typeof doc === 'string') { try { doc = JSON.parse(doc); } catch { /* shell/raw HTTP */ } }
  visit(doc, {}, '');
  return found;
}
// 关闭“允许访问网站”后仍放行的非目标工具（第 4.3 节：知识和离线阅读仍按各自开关工作）：
// 知识库检索/精读（本地索引）、Nday 资料与分析、资产平台查询（查 FOFA/公告，不访问被测站点）。
// 其余非本地工具（MCP、扫描器、shell、浏览器、memshell/oob 等）一律拒绝——宁可多拦，也不让“不再访问网站”形同虚设。
const networkFreeTools = new Set(['zday_pattern', 'attack_plan', 'asset_search', 'asset_search_batch',
  'asset_candidate_search_batch', 'hunter', 'web_search',
  ]);
const referenceFetchTools = new Set(['web_fetch', 'web-access']);
const opaqueTrafficTools = new Set(['pwsh', 'powershell', 'powershell.exe', 'cmd', 'cmd.exe', 'bash', 'sh',
  'shell', 'run_shell', 'exec_command', 'mcp_call']);
// redteam_execution 里真正会发出目标流量的动作；detail/job-detail/verify-effect 等只读动作不受网络限制。
const targetTrafficExecutionActions = new Set(['direct', 'run', 'run-pair', 'run-effect', 'browser-run']);
const projectBrowserTargetActions = new Set(['open', 'act']);
// **一次调用 = 一个可审计请求**的受控入口：不按"未计量"处理（它们本身就逐条可数）。
// `exercise_request` 是本地效果基准的受控工具，靶场自己记录每一条请求；把它当成未计量扫描器
// 会把基准的引用契约整体判死（2026-10-18 实测：h1 的 7 次 exercise_request 全被拒，requests=0）。
// 它们仍属于"目标流量工具"：关闭"允许访问网站"时照样被拦。
const meteredRequestTools = new Set(['exercise_request', 'recorded-http-execution', 'recorded-project-execution',
  'saker_browser', 'web_fetch', 'web-access']);
// 会改动业务数据的 HTTP 方法；“不改动网站数据”只放行 GET/HEAD 这类读取请求。
const writeHttpMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
function executionActionOf(args) {
  try { const doc = typeof args === 'string' ? JSON.parse(args) : args; return typeof doc?.action === 'string' ? doc.action : undefined; }
  catch { return undefined; }
}
/**
 * 这次调用会不会发出**目标站点**流量。用于“允许访问网站”关闭时的强制拦截。
 * 判定保守：识别不了的第三方工具（MCP 等）按“会发流量”处理，而不是默认放行。
 * @returns 会发目标流量时为 true。
 */
export function isTargetTrafficTool(store, sessionId, name, args, policy) {
  if (offlineToolCall(name, args)) return false;
  if (referenceFetchTools.has(name)) {
    return candidateUrlsFromArgs(args).some(raw => taskScopeIncludesUrl(policy, raw) || taskScopeExcluded(policy, raw));
  }
  if (networkFreeTools.has(name)) return false;
  if (name === 'saker_browser') return projectBrowserTargetActions.has(String(args?.action || '').trim());
  if (name === 'exercise_request') return true;
  if (meteredRequestTools.has(name)) return false;
  if (unmeteredTrafficTools.has(name)) return true;
  if (name === 'redteam_execution') return targetTrafficExecutionActions.has(executionActionOf(args));
  const explicitUrls = candidateUrlsFromArgs(args);
  if (explicitUrls.length) return true;
  // A shell may run local commands. Only its explicit network-command segments
  // count as target traffic; opaque MCP calls remain conservative.
  if (opaqueTrafficTools.has(name)) return name === 'mcp_call';
  return !localTools.has(name) && !networkFreeTools.has(name);
}
/**
 * 动作限制的拒绝理由（第 4.3/5.5 节）：是否访问网站、是否禁止改动业务数据。
 * 强制范围控制由程序执行，不依赖模型自觉。
 * @param policy - 任务策略。
 * @param options.method - 已知的 HTTP 方法（能判断写入时才传）。
 * @returns 拒绝理由；允许时返回 undefined。
 */
export function targetTrafficDenial(policy, { method } = {}) {
  if (policy?.allowTargetNetwork === false)
    return 'target_network_disabled：本任务已关闭“允许访问网站”，不再新发任何目标网络操作（MCP、扫描器、shell、浏览器、已存请求等）。'
      + '只分析已添加的内容；要访问网站，请在测试设置里明确打开“允许访问网站”。';
  if (policy?.allowTargetNetwork !== false && !taskScopeSummary(policy).include.length)
    return 'target_scope_missing：当前任务还没有明确的测试范围。请先填写网址、域名、IP/CIDR 或资产清单；'
      + '只做离线分析时可关闭“允许访问网站”。';
  if (policy?.readOnly === true && typeof method === 'string' && writeHttpMethods.has(method.toUpperCase()))
    return 'read_only_target：本任务设置为“不改动网站数据”，只允许 GET/HEAD 这类读取请求；' + method.toUpperCase()
      + ' 会改动业务数据，需先在测试设置里关闭“不改动网站数据”。';
  return undefined;
}
/** 当前任务的授权范围由用户输入和显式关联站点决定，模型保存的 inScope 不扩权。 */
function urlIsInTaskScope(policy, value) {
  return taskScopeIncludesUrl(policy, value);
}
/**
 * 这次调用的参数里是否出现**授权范围内**的 URL。
 *
 * 2026-10-18 完整任务实测：模型用 Yakit MCP 的 batch_do_http_request（args 里带 base-url + 一批 paths）
 * 向目标发了 68 次请求，只留下 3 条执行回执。旧实现只检查宿主 shell，MCP 通道因此既不占未计量额度、
 * 也不被范围/停止/预算统一约束。这里改成对**所有非本地工具**检查参数里的授权范围 URL：
 * 扫描器、shell、MCP、浏览器一视同仁；可计量的 redteam_execution 仍走它自己的适配器。
 */
function argsHitAuthorizedScope(store, sessionId, name, args, policy) {
  if (localTools.has(name) || networkFreeTools.has(name)) return false;
  // redteam_execution 是**可计量**入口：真正发请求由执行适配器做范围/只读/预算判定，不按未计量处理。
  if (name === 'redteam_execution') return false;
  // 一次调用 = 一个可审计请求的受控入口也不按未计量处理。
  if (meteredRequestTools.has(name)) return false;
  const urls = candidateUrlsFromArgs(args);
  if (!urls.length) return false;
  return urls.some(raw => urlIsInTaskScope(policy, raw));
}
// 主动采集工具 → 它需要的测试内容。关闭该项后不得新发这类采集动作；
// 读取已有资料、历史回执和报告不受影响。
function integer(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(label + ' must be an integer between ' + min + ' and ' + max);
  return value;
}
function boundedText(value, label, max = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(label + ' must be bounded nonempty text');
  return value.trim();
}
function normalizeAllowedOrigins(value) {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value) && value.length === 0) return [];
  const normalized = normalizeTaskScope({ scope: value })
  assertScopeErrors(normalized)
  if (!normalized.scope.include.length) throw new Error('关联站点需要网址、域名、通配子域、IP 或 CIDR')
  return normalized.scope.include
}
function assertScopeErrors(normalized) {
  if (!normalized?.errors?.length) return normalized
  const details = normalized.errors.slice(0, 5).map(row => `${row.value || '(空)'}：${row.reason}`).join('；')
  throw new Error('测试范围包含无法解析的条目：' + details + (normalized.errors.length > 5 ? `；另有 ${normalized.errors.length - 5} 条` : ''))
}
/**
 * 排除的地址或路径（第 4.3/5.5 节）。条目按路径前缀匹配（带边界），也接受完整 URL。
 * 只影响新的目标请求；读取已存资料、历史回执和整理报告不受影响。
 * @param value - 字符串（每行一条）或字符串数组。
 * @returns 规范化后的条目数组，最多 100 条。
 */
export function normalizeExcludedPaths(value) {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : String(value).split(/\r\n|\r|\n/);
  const out = [];
  for (const raw of list) {
    let text = String(raw ?? '').trim();
    if (!text) continue;
    if (text.length > 300) throw new Error('排除的地址或路径过长');
    if (text.startsWith('/')) {
      out.push(text);
      continue;
    }
    // In the exclusions field a single bare word is a path, not a host rule.
    // Host/IP/CIDR exclusions are explicit via a dot, wildcard, scheme or slash.
    if (!text.includes('.') && !text.includes('://') && !text.includes('/') && !text.includes('*')) {
      out.push('/' + text);
      continue;
    }
    const normalized = normalizeTaskScope({ excluded: [text] });
    if (normalized.errors.length || !normalized.terms.exclude.length)
      throw new Error('排除项无法解析：' + text)
    out.push(normalized.terms.exclude[0].raw);
  }
  return [...new Set(out)].slice(0, 100);
}
function pathPrefixMatches(pathname, entry) {
  const base = entry.endsWith('/') ? entry.slice(0, -1) : entry;
  if (!base || base === '') return false;
  return pathname === base || pathname.startsWith(base + '/');
}
/**
 * 这条请求是否命中排除路径。强制在发请求前判定，不依赖模型自觉。
 * @param policy - 任务策略。
 * @param options.url - 完整请求 URL（字符串或 URL）。
 * @returns 拒绝理由；未命中时返回 undefined。
 */
export function excludedPathDenial(policy, { url } = {}) {
  let target;
  try { target = url instanceof URL ? url : new URL(String(url)); } catch { return undefined; }
  if (!taskScopeExcluded(policy, target)) return undefined;
  return 'excluded_path：' + target.pathname + ' 命中本任务排除的地址、网段或路径'
    + '；读取已存资料和整理报告不受影响，但不会向该路径发请求。要检查它请先在测试设置里移除排除项。';
}

/**
 * 沿任务树取「最紧」的动作限制（v6 第 8.3 节：缩范围沿任务树传播）。
 *
 * 子任务开始时继承主任务的动作限制，但主任务**中途收紧**（关掉网站访问、改成只读、加排除路径、
 * 降速率或并发）必须对已经在跑的子代理立即生效 —— 否则用户关掉开关之后，已启动的子代理还在
 * 继续打目标。这里只收紧、不放宽：子任务自己更严的保留，父任务更严的覆盖上来。
 *
 * @returns 合并后的策略（不改动原对象）；没有父任务时原样返回。
 */
export function effectivePolicy(store, policy, depth = 0) {
  if (!policy || !policy.parentSession || depth >= 4) return policy;
  let parent = null;
  try { parent = readTaskPolicy(store, policy.parentSession); } catch { parent = null; }
  if (!parent) return policy;
  const outer = effectivePolicy(store, parent, depth + 1);
  const merged = { ...policy };
  const outerScope = taskScopeSummary(outer).include;
  const mergedExcluded = [...(policy.scope?.exclude || []), ...normalizeExcludedPaths(policy.excludedPaths),
    ...(outer.scope?.exclude || []), ...normalizeExcludedPaths(outer.excludedPaths)];
  if (outerScope.length) {
    const childScope = normalizeTaskScope({
      target: policy.target,
      scope: policy.scope?.include,
      allowedOrigins: policy.allowedOrigins,
    });
    const outerScopeData = normalizeTaskScope({ scope: outerScope });
    const intersection = []
    for (const term of childScope.terms.include) if (taskTermInPolicy(outer, term.raw)) intersection.push(term.raw)
    for (const term of outerScopeData.terms.include) if (taskTermInPolicy(childScope, term.raw)) intersection.push(term.raw)
    const narrowed = normalizeTaskScope({ scope: intersection, excluded: mergedExcluded });
    merged.target = narrowed.target;
    merged.primaryTarget = narrowed.primaryTarget;
    merged.scope = narrowed.scope;
    merged.scopeTerms = narrowed.terms;
    merged.entrypoints = narrowed.entrypoints;
    merged.allowedOrigins = narrowed.scope.include;
  }
  if (outer.allowTargetNetwork === false) merged.allowTargetNetwork = false;
  if (outer.readOnly === true) merged.readOnly = true;
  merged.excludedPaths = normalizeExcludedPaths(mergedExcluded);
  if (!merged.scope) merged.scope = { include: [], exclude: merged.excludedPaths }
  else merged.scope = { ...merged.scope, exclude: normalizeExcludedPaths(mergedExcluded) }
  const rates = [policy.requestRatePerMinute, outer.requestRatePerMinute].filter((value) => Number.isInteger(value) && value > 0);
  if (rates.length) merged.requestRatePerMinute = Math.min(...rates);
  const concurrency = [policy.requestConcurrency, outer.requestConcurrency].filter((value) => Number.isInteger(value) && value > 0);
  if (concurrency.length) merged.requestConcurrency = Math.min(...concurrency);
  return merged;
}
export function normalizeStartMode(value) {
  if (value === undefined || value === null || value === '') return 'materials-first';
  if (!startModes.has(value)) throw new Error('invalid task start mode');
  return value;
}
function taskStartMode(policy) {
  return startModes.has(policy?.startMode) ? policy.startMode : 'materials-first';
}
export function pauseTaskPolicy(store, sessionId, input, source = 'submitted-interruption-report') {
  const policy = readTaskPolicy(store, sessionId);
  if (!policy) throw new Error('task policy missing');
  if (!['ip-blocked', 'login-expired', 'normal-access-failed', 'service-unavailable', 'safety-policy', 'tool-policy', 'needs-user'].includes(input?.code)) throw new Error('invalid blocker');
  const blocker = { code: input.code, reason: boundedText(input.reason, 'reason'),
    evidence: boundedText(input.evidence, 'evidence'), source, recordedAt: Date.now(), conclusion: 'unknown; stop affected requests' };
  return write(store, sessionId, { ...policy, blocker });
}
export function resumeTaskPolicy(store, sessionId, note, source) {
  if (source !== 'desktop-user') throw new Error('resume requires the user to resolve the blocker');
  const policy = readTaskPolicy(store, sessionId);
  if (!policy?.blocker) throw new Error('task is not paused');
  const history = [...(policy.blockerHistory || []), { ...policy.blocker, resolvedAt: Date.now(), resolution: boundedText(note, 'resolution') }].slice(-20);
  const { blocker, ...rest } = policy;
  return write(store, sessionId, { ...rest, blockerHistory: history, needsBaselineRecheck: true });
}
export function acceptBaselineRecheck(store, sessionId, receiptId) {
  const policy = readTaskPolicy(store, sessionId);
  if (!policy?.needsBaselineRecheck) return;
  const row = store.db.prepare('SELECT record FROM execution_receipts WHERE session_id=? AND id=?').get(sessionId, receiptId);
  const receipt = parseRowRecord(row, { table: 'execution_receipts', id: sessionId });
  if (!receipt || receipt.source !== 'host-http-execution' || receipt.outcome !== 'response' || receipt.status < 200 || receipt.status >= 300)
    throw new Error('successful host baseline recheck required');
  return write(store, sessionId, { ...policy, needsBaselineRecheck: false, baselineRechecked: { receiptId, at: Date.now(), limit: 'HTTP baseline restored; business permission still requires verification' } });
}
export function readTaskPolicy(store, sessionId) {
  const row = store.db.prepare('SELECT record FROM task_policy WHERE session_id=?').get(sessionId);
  if (!row) return null;
  const policy = parseRowRecord(row, { table: 'task_policy', id: sessionId });
  if (!startModes.has(policy.startMode)) policy.startMode = 'materials-first';
  if (policy.budget?.unmeteredToolCalls === 0 && policy.budget.unmeteredExplicit !== true)
    policy.budget.unmeteredToolCalls = null;
  return policy;
}

/**
 * 是否还有未释放的子代理。
 * 坏行会带表名与会话抛出（`CorruptRecordError`），**不会**被当成"已释放"——
 * 那会直接放宽名额约束。三处准入/归档判断共用这一条。
 */
export function hasUnreleasedWorker(store, sessionId) {
  return ownedPurposeTasks(store, sessionId).some(row => row.activationState !== 'released')
    || store.db.prepare('SELECT record FROM site_workers WHERE parent_session=?').all(sessionId)
    .some(row => parseRowRecord(row, { table: 'site_workers', key: 'parent_session', id: sessionId }).state !== 'released');
}

/** 子代理是否已报告结束。没有行按"未报告"处理，坏行照旧抛出。 */
export function workerReportedFinished(store, sessionId) {
  const row = store.db.prepare('SELECT record FROM site_workers WHERE child_id=?').get(sessionId);
  return row ? Boolean(parseRowRecord(row, { table: 'site_workers', key: 'child_id', id: sessionId }).report) : false;
}
export function chosenTaskOptions(store, sessionId) {
  const row = store.db.prepare('SELECT record FROM task_flow_choice WHERE session_id=?').get(sessionId);
  const defaults = chatDefaults(store);
  return row ? parseRowRecord(row, { table: 'task_flow_choice', id: sessionId })
    : defaults ? { ...defaults, workflow: 'single' } : null;
}
/** v6 5.5「给助手选择模型」：站点子代理的 provider/model 覆盖；未选则沿用当前会话模型。 */
export function normalizeWorkerModel(value) {
  return normalizeModelChoice(value, '助手模型');
}
export function chooseTaskMode(store, sessionId, mode, options) {
  if (!modes.has(mode)) throw new Error('invalid task mode');
  if (readTaskPolicy(store, sessionId)) throw new Error('任务已开始，不能切换流程或重置预算');
  const previous = chosenTaskOptions(store, sessionId);
  const interaction = normalizeInteraction(options?.interaction ?? previous?.interaction);
  const replacesScope = options && (options.target !== undefined || options.scope !== undefined)
  const scopeData = normalizeTaskScope({
    target: replacesScope ? options?.target : previous?.target,
    scope: replacesScope ? (options?.scope?.include ?? options?.scope) : previous?.scope?.include,
    allowedOrigins: options?.allowedOrigins ?? previous?.allowedOrigins,
    excluded: options?.excludedPaths ?? previous?.scope?.exclude,
    requestText: options?.target ?? previous?.requestText,
  });
  assertScopeErrors(scopeData)
  const choice = { workflow: 'single',
    scenario: previous?.scenario || 'pentest',
    startMode: normalizeStartMode(options?.startMode ?? previous?.startMode),
    interaction,
    reporting: reportingFor({ interaction, reporting: options?.reporting ?? previous?.reporting }),
    explain: options?.explain === undefined ? (previous?.explain ?? false) : options.explain === true,
    workerModel: normalizeModelChoice(options?.workerModel === undefined ? previous?.workerModel : options.workerModel, '查找问题模型'),
    reviewModel: normalizeModelChoice(options?.reviewModel === undefined ? previous?.reviewModel : options.reviewModel, '复核结果模型'),
    reportModel: normalizeModelChoice(options?.reportModel === undefined ? previous?.reportModel : options.reportModel, '整理报告模型'),
    // 第 4.3/5.5 节动作限制：未开始的任务先记在选择里，开始时落进策略。
    allowTargetNetwork: options?.allowTargetNetwork === undefined ? (previous?.allowTargetNetwork ?? true) : options.allowTargetNetwork !== false,
    readOnly: options?.readOnly === undefined ? (previous?.readOnly ?? false) : options.readOnly === true,
    excludedPaths: options?.excludedPaths === undefined ? normalizeExcludedPaths(previous?.excludedPaths) : normalizeExcludedPaths(options.excludedPaths),
    target: replacesScope ? scopeData.target : (previous?.target || ''),
    primaryTarget: replacesScope ? scopeData.primaryTarget : (previous?.primaryTarget || ''),
    scope: replacesScope ? scopeData.scope : (previous?.scope || { include: [], exclude: [] }),
    scopeTerms: replacesScope ? scopeData.terms : (previous?.scopeTerms || { include: [], exclude: [] }),
    entrypoints: replacesScope ? scopeData.entrypoints : (previous?.entrypoints || []),
    allowedOrigins: normalizeAllowedOrigins(options?.allowedOrigins ?? previous?.allowedOrigins),
    requestRatePerMinute: options?.requestRatePerMinute === undefined ? normalizeRequestRate(previous?.requestRatePerMinute) : normalizeRequestRate(options.requestRatePerMinute),
    requestConcurrency: options?.requestConcurrency === undefined ? normalizeRequestConcurrency(previous?.requestConcurrency) : normalizeRequestConcurrency(options.requestConcurrency),
    // v6 第 5.5 / 8.3 节：初始「自动」上限是 2（保守配置，不是性能结论）。
    workers: integer(options?.workers ?? previous?.workers ?? 2, 'workers', 0, MAX_SITE_WORKERS) };
  normalizeTaskFlow('single', mode);
  store.db.exec('BEGIN IMMEDIATE');
  try {
  store.db.prepare('INSERT INTO task_choice (session_id,mode) VALUES (?,?) ON CONFLICT(session_id) DO UPDATE SET mode=excluded.mode').run(sessionId, mode);
  store.db.prepare('INSERT INTO task_flow_choice(session_id,record) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET record=excluded.record').run(sessionId, JSON.stringify(choice));
  store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  return mode;
}
export function chosenTaskMode(store, sessionId) {
  return store.db.prepare('SELECT mode FROM task_choice WHERE session_id=?').get(sessionId)?.mode || null;
}
export function archiveTaskRound(store, sessionId, source, now = Date.now()) {
  if (!['desktop-user', 'parent-round-continuation'].includes(source)) throw new Error('new round requires an explicit Desktop action');
  const current = readTaskPolicy(store, sessionId);
  if (!current) throw new Error('no previous round');
  if (current.awaitingConfirmation && !current.cancelled) throw new Error('阶段确认不是任务结束；先确认继续或停止本轮');
  if (current.blocker || (source === 'desktop-user' && current.parentSession)) throw new Error('受阻任务或子任务不能自行开启新一轮');
  if (source === 'desktop-user' && (!taskPolicyStatus(store, sessionId, now).stopped || current.blocker))
    throw new Error('先结束当前任务；访问阻碍必须先处理，不能通过新一轮绕过');
  if (hasUnreleasedWorker(store, sessionId)) throw new Error('先确认全部子代理已释放');
  store.db.exec('BEGIN IMMEDIATE');
  try {
    store.db.prepare('INSERT INTO task_rounds(session_id,started_at,record) VALUES(?,?,?)').run(sessionId, current.startedAt, JSON.stringify({ ...current, endedAt: now, source }));
    for (const row of store.db.prepare('SELECT id,record FROM research_hypotheses WHERE session_id=?').all(sessionId)) {
      const record = parseRowRecord(row, { table: 'research_hypotheses', id: sessionId });
      if (!['active', 'supported'].includes(record.state)) continue;
      record.state = 'stopped'; record.reason = 'previous round archived; evidence and pending leads retained';
      store.db.prepare('UPDATE research_hypotheses SET record=? WHERE session_id=? AND id=?').run(JSON.stringify(record), sessionId, row.id);
    }
    store.db.prepare('DELETE FROM task_policy WHERE session_id=?').run(sessionId);
    store.db.prepare('DELETE FROM task_choice WHERE session_id=?').run(sessionId);
    store.db.prepare('DELETE FROM task_flow_choice WHERE session_id=?').run(sessionId);
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  return { archived: true, previousStartedAt: current.startedAt };
}
function write(store, sessionId, record) {
  return writeTaskPolicy(store, sessionId, record);
}
export function startTaskPolicy(store, sessionId, input, now = Date.now()) {
  return taskTransaction(store, () => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('policy must be an object');
  const scenario = input.scenario === undefined ? 'pentest' : input.scenario;
  if (!['pentest', 'project'].includes(scenario)) throw new Error('invalid task scenario');
  const isProject = scenario === 'project';
  const mode = isProject ? 'project' : (input.mode === 'campaign' ? 'nday' : input.mode);
  const stop = input.stop || 'budget';
  if (!stops.has(stop)) throw new Error('invalid stop policy');
  if (!isProject && !modes.has(mode)) throw new Error('invalid task mode');
  const chosen = isProject ? null : chosenTaskMode(store, sessionId);
  const parentId = store.db.prepare('SELECT parent_session FROM site_workers WHERE child_id=?').get(sessionId)?.parent_session
    ?? (input.purposeTask === true ? input.parentSession : undefined);
  if (parentId && !readTaskPolicy(store, parentId)) throw new Error('parent task policy missing');
  const choice = parentId || isProject ? null : chosenTaskOptions(store, sessionId);
  const interaction = normalizeInteraction(input.interaction ?? choice?.interaction ?? (parentId ? readTaskPolicy(store, parentId)?.interaction : undefined));
  if (choice && interaction !== normalizeInteraction(choice.interaction)) throw new Error('interaction differs from the selected Desktop preference');
  const reporting = reportingFor({ interaction, reporting: input.reporting ?? choice?.reporting ?? (parentId ? reportingFor(readTaskPolicy(store, parentId)) : undefined) });
  if (choice && reporting !== reportingFor(choice)) throw Error('reporting differs from the selected Desktop preference');
  const explain = input.explain === undefined ? (choice?.explain ?? (parentId ? readTaskPolicy(store, parentId)?.explain : false) ?? false) : input.explain === true;
  const flow = isProject
    ? { kind: 'project', phase: 'running', completed: { regular: false, nday: false }, history: [] }
    : normalizeTaskFlow('single', mode);
  if (chosen && chosen !== mode) throw new Error('mode differs from the selected Desktop workflow');
  if (readTaskPolicy(store, sessionId)) throw new Error('task already started; budgets cannot be reset in this session');
  const inheritedStartMode = parentId ? taskStartMode(readTaskPolicy(store, parentId)) : null;
  // Compatibility field only. New tasks no longer choose a legacy start mode.
  const startMode = parentId ? inheritedStartMode : 'direct-test';
  const toolCalls = input.budget?.toolCalls === undefined || input.budget?.toolCalls === null || input.budget?.toolCalls === ''
    ? null
    : integer(input.budget?.toolCalls, 'budget.toolCalls', 1, 10000);
  const discoveryCalls = 0;
  // Optional hard cap for opaque traffic channels. null means "no extra framework cap";
  // tool calls and actual host limits still apply. A value (including 0) is an explicit user cap.
  const parentLimit = parentId ? readTaskPolicy(store, parentId).budget.unmeteredToolCalls ?? null : null;
  const rawUnmetered = input.budget?.unmeteredToolCalls;
  const unmeteredToolCalls = rawUnmetered === undefined || rawUnmetered === null || rawUnmetered === ''
    ? parentLimit
    : integer(rawUnmetered, 'budget.unmeteredToolCalls', 0, 1000);
  if (parentId && Number.isInteger(unmeteredToolCalls) && Number.isInteger(parentLimit) && unmeteredToolCalls > parentLimit)
    throw new Error('子代理不能提高主任务的未计量流量额度');
  const minutes = input.budget?.minutes === undefined ? null : integer(input.budget.minutes, 'budget.minutes', 1, 10080);
  const modelLimits=Object.fromEntries(['modelCalls','tokens'].filter(key=>input.budget?.[key]!==undefined)
    .map(key=>[key,integer(input.budget[key],'budget.'+key,1,key==='modelCalls'?10000:1000000000000)]));
  if(parentId && Object.entries(modelLimits).some(([key,value])=>value!==readTaskPolicy(store,parentId)?.budget[key]))
    throw Error('子代理不能更改主任务共享模型额度');
  const question = input.question === undefined ? '' : boundedText(input.question, 'question', 64000);
  const workerLimit = integer(input.budget?.workers ?? choice?.workers ?? 2, 'budget.workers', 0, MAX_SITE_WORKERS);
  if (parentId && workerLimit !== 0) throw Error('子代理不能再派子代理');
  if (choice && workerLimit > choice.workers) throw new Error('不能提高桌面已选择的子代理上限');
  const recordedParent = store.db.prepare('SELECT parent_session FROM site_workers WHERE child_id=?').get(sessionId)?.parent_session;
  if (input.parentSession && input.parentSession !== recordedParent && input.purposeTask !== true) throw new Error('unowned worker parent');
  const parentSession = input.purposeTask === true ? input.parentSession : recordedParent;
  const fileOnly = !!parentSession && input.fileOnly === true;
  if (parentSession && flow.kind !== 'single') throw new Error('子代理不能开启独立衔接流程');
  // 动作限制沿用桌面选择；子代理、基线复查与恢复任务都遵守主任务的同一份限制。
  const parentPolicy = parentSession ? readTaskPolicy(store, parentSession) : null;
  const projectChoice = isProject ? chosenTaskOptions(store, sessionId) : null;
  const explicitAllowedOrigins = fileOnly ? []
    : parentSession ? normalizeAllowedOrigins(parentPolicy?.allowedOrigins)
    : normalizeAllowedOrigins(input.allowedOrigins ?? projectChoice?.allowedOrigins ?? choice?.allowedOrigins);
  const configuredExcluded = parentSession ? parentPolicy?.excludedPaths
    : isProject ? [...normalizeExcludedPaths(input.excludedPaths), ...normalizeExcludedPaths(projectChoice?.excludedPaths)]
      : input.excludedPaths !== undefined ? normalizeExcludedPaths(input.excludedPaths) : choice?.excludedPaths;
  const scopeData = normalizeTaskScope(parentSession ? {
    target: fileOnly ? '' : input.target ?? parentPolicy?.primaryTarget ?? parentPolicy?.target,
    scope: fileOnly ? [] : input.scope?.include ?? input.scope,
    allowedOrigins: explicitAllowedOrigins,
    excluded: fileOnly ? [] : [...(parentPolicy?.scope?.exclude || []), ...normalizeExcludedPaths(parentPolicy?.excludedPaths)],
    requestText: parentPolicy?.requestText,
  } : {
    target: input.target ?? projectChoice?.target ?? choice?.target,
    scope: input.scope?.include ?? input.scope ?? projectChoice?.scope?.include ?? choice?.scope?.include,
    allowedOrigins: explicitAllowedOrigins,
    excluded: [...normalizeExcludedPaths(configuredExcluded), ...(input.scope?.exclude || [])],
    requestText: input.userRequest ?? input.requestText ?? projectChoice?.requestText ?? choice?.requestText ?? question,
  });
  assertScopeErrors(scopeData)
  const target = scopeData.target;
  if (!fileOnly && (input.target !== undefined || input.allowedOrigins !== undefined) && !scopeData.scope.include.length)
    throw new Error('target 需要至少一个有效的网址、域名、通配子域、IP 或 CIDR；请检查输入是否被错误拼接');
  if (parentPolicy && scopeData.terms.include.some(term => !taskTermInPolicy(parentPolicy, term.raw)))
    throw new Error('child task scope cannot expand the parent task scope')
  const allowTargetNetwork = fileOnly ? false
    : parentSession ? parentPolicy?.allowTargetNetwork !== false
    : isProject ? input.allowTargetNetwork !== false && projectChoice?.allowTargetNetwork !== false : (choice?.allowTargetNetwork ?? true);
  const readOnly = parentSession ? parentPolicy?.readOnly === true
    : isProject ? input.readOnly === true || projectChoice?.readOnly === true : (choice?.readOnly ?? false);
  const excludedPaths = normalizeExcludedPaths(configuredExcluded);
  const requestRatePerMinute = parentSession ? normalizeRequestRate(parentPolicy?.requestRatePerMinute)
    : isProject ? normalizeRequestRate(input.requestRatePerMinute ?? projectChoice?.requestRatePerMinute) : normalizeRequestRate(choice?.requestRatePerMinute);
  const requestConcurrency = parentSession ? normalizeRequestConcurrency(parentPolicy?.requestConcurrency)
    : isProject ? normalizeRequestConcurrency(input.requestConcurrency ?? projectChoice?.requestConcurrency) : normalizeRequestConcurrency(choice?.requestConcurrency);
  return write(store, sessionId, { scenario, mode, flow, startMode, interaction, reporting, explain: explain === true, stop, question,
    requestText: input.userRequest ?? input.requestText ?? question, target, primaryTarget: scopeData.primaryTarget,
    scope: scopeData.scope, scopeTerms: scopeData.terms, entrypoints: scopeData.entrypoints, workerLimit,
    workerModel: choice?.workerModel ?? null, reviewModel: choice?.reviewModel ?? null, reportModel: choice?.reportModel ?? null,
    allowTargetNetwork, readOnly, excludedPaths, requestRatePerMinute, requestConcurrency,
    allowedOrigins: explicitAllowedOrigins,
    ...(parentSession ? { parentSession } : {}),
    ...(fileOnly ? { fileOnly: true } : {}),
    ...(parentSession ? { parentRound: readTaskPolicy(store, parentSession)?.startedAt } : {}),
    ...(input.purposeTask === true ? { purposeTask: true } : {}),
    budget: { toolCalls, discoveryCalls, unmeteredToolCalls,
      unmeteredExplicit: rawUnmetered !== undefined && rawUnmetered !== null && rawUnmetered !== '',
      deadline: minutes === null ? null : now + minutes * 60000, ...modelLimits },
    used: { toolCalls: 0, discoveryCalls: 0, unmeteredToolCalls: 0 }, startedAt: now, cancelled: false, planComplete: false, queueComplete: false });
  });
}
export function updateTaskProgress(store, sessionId, input) {
  store.db.exec('BEGIN IMMEDIATE');
  try {
  const current = readTaskPolicy(store, sessionId);
  if (!current) throw new Error('task policy missing');
  if (current.scenario === 'project' && (input.planComplete === true || input.queueComplete === true))
    throw new Error('项目收尾由来源整理和检查状态判定，不能由模型直接标记完成');
  if (current.awaitingConfirmation && !input.cancelled) throw new Error('等待桌面确认，不能自行完成下一阶段');
  for (const key of Object.keys(input)) {
    if (key === 'note') continue;
    if (!['cancelled', 'planComplete', 'queueComplete', 'regularComplete', 'ndayComplete'].includes(key) || typeof input[key] !== 'boolean') throw new Error('progress accepts only boolean completion/cancellation fields and a note');
    if (current[key] && !input[key]) throw new Error('finished task state cannot be reopened');
  }
  const now = Date.now();
  if (current.flow?.kind !== 'single' && current.flow && !input.cancelled) {
    if (taskPolicyStatus(store, sessionId, now).stopped) throw new Error('任务已停止，不能借模式衔接恢复');
    if (current.needsBaselineRecheck) throw new Error('先复查正常访问，再继续模式衔接');
    if (current.flow.kind === 'regular-to-nday' && current.flow.phase === 'regular' && (input.regularComplete || input.planComplete || input.queueComplete)
      && hasUnreleasedWorker(store, sessionId))
      throw new Error('先释放全部站点子代理，再自动接 Nday；预算与资料保留');
  }
  const next = advanceTaskFlow(current, input, now);
  if (next.cancelled) delete next.awaitingConfirmation;
  if (!current.parentSession && requiresCheckpoint(current.interaction) && !next.planComplete && !next.cancelled
    && (input.regularComplete || input.ndayComplete || input.planComplete || input.queueComplete))
    next.awaitingConfirmation = { at: now, note: input.note || '本阶段已完成，请确认下一阶段', phase: next.flow.phase };
  const saved = write(store, sessionId, { ...next,
    ...(!current.finishedAt && (next.cancelled || next.planComplete || next.queueComplete) ? { finishedAt: now } : {}) });
  store.db.exec('COMMIT'); return saved;
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}
export function checkpointTask(store, sessionId, note) {
  const state = taskPolicyStatus(store, sessionId);
  if (!state.configured || state.stopped || state.policy.parentSession) throw new Error('only an active main task can checkpoint');
  const summary = boundedText(note, 'checkpoint note', 1000);
  if (!requiresCheckpoint(state.policy.interaction)) return state.policy;
  if (hasUnreleasedWorker(store, sessionId))
    throw new Error('阶段确认前先释放全部子代理');
  return write(store, sessionId, { ...state.policy, awaitingConfirmation: { at: Date.now(), note: summary, phase: state.policy.flow.phase } });
}
export function setTaskInteraction(store, sessionId, interaction, source, reporting) {
  if (source !== 'desktop-user') throw new Error('interaction preference requires Desktop user action');
  const policy = readTaskPolicy(store, sessionId);
  if (!policy || policy.parentSession) throw new Error('only a main task can change interaction frequency');
  const next = normalizeInteraction(interaction);
  return write(store, sessionId, { ...policy, interaction: next, reporting: reporting === undefined || reporting === null || reporting === '' ? reportingFor(policy) : reportingFor({ interaction: next, reporting }) });
}
/** 解释测试原理：只影响讲解，不改变范围、预算或确认时机。 */
export function setTaskExplain(store, sessionId, explain, source) {
  if (source !== 'desktop-user') throw new Error('explain preference requires Desktop user action');
  const policy = readTaskPolicy(store, sessionId);
  if (!policy || policy.parentSession) throw new Error('only a main task can change explain preference');
  return write(store, sessionId, { ...policy, explain: explain === true });
}
/**
 * 动作限制（第 4.3/5.5 节）：是否访问网站、是否禁止改动业务数据。
 * 只改本任务的动作范围，不授予或放宽任何权限；强制拦截在 taskExecutionGuard 与执行适配器里。
 * `test-content-empty` 是“全不选”时的联动来源：选项列表为空必须同时关闭网站访问。
 */
export function setTaskActionLimits(store, sessionId, input, source) {
  if (source !== 'desktop-user' && source !== 'test-content-empty') throw new Error('action limits require Desktop user action');
  const policy = readTaskPolicy(store, sessionId);
  if (policy?.parentSession) throw new Error('only a main task can change action limits');
  if (policy) {
    const next = { ...policy };
    if (input?.target !== undefined || input?.scope !== undefined || input?.allowedOrigins !== undefined || input?.excludedPaths !== undefined) {
      if (source !== 'desktop-user') throw new Error('测试范围只能由用户在测试设置中修改');
      const normalized = normalizeTaskScope({
        target: input?.target === undefined ? policy.target : input.target,
        scope: input?.scope !== undefined ? input.scope : input?.target !== undefined ? undefined : policy.scope?.include,
        allowedOrigins: input?.allowedOrigins !== undefined ? input.allowedOrigins
          : input?.target !== undefined ? undefined : policy.allowedOrigins,
        excluded: input?.excludedPaths === undefined ? policy.scope?.exclude : input.excludedPaths,
        requestText: input?.target === undefined ? policy.requestText : input.target,
      });
      assertScopeErrors(normalized)
      const allowTargetNetwork = input?.allowTargetNetwork === undefined
        ? policy.allowTargetNetwork !== false
        : input.allowTargetNetwork === true;
      if (!normalized.scope.include.length && allowTargetNetwork)
        throw new Error('测试范围不能为空；只做离线分析时请同时关闭“允许访问网站”');
      next.target = normalized.target;
      next.primaryTarget = normalized.primaryTarget;
      next.scope = normalized.scope;
      next.scopeTerms = normalized.terms;
      next.entrypoints = normalized.entrypoints;
      next.allowedOrigins = input?.allowedOrigins !== undefined
        ? normalizeAllowedOrigins(input.allowedOrigins)
        : input?.target !== undefined ? [] : normalizeAllowedOrigins(policy.allowedOrigins);
    }
    if (input?.allowTargetNetwork !== undefined) next.allowTargetNetwork = input.allowTargetNetwork === true;
    if (input?.readOnly !== undefined) next.readOnly = input.readOnly === true;
    if (input?.excludedPaths !== undefined) next.excludedPaths = normalizeExcludedPaths(input.excludedPaths);
    if (input?.requestRatePerMinute !== undefined) next.requestRatePerMinute = normalizeRequestRate(input.requestRatePerMinute);
    if (input?.requestConcurrency !== undefined) next.requestConcurrency = normalizeRequestConcurrency(input.requestConcurrency);
    return write(store, sessionId, next);
  }
  // 尚未开始：先记在任务选择里，开始时由 startTaskPolicy 落进策略（chooseTaskMode 会保留这两个字段）。
  const previous = chosenTaskOptions(store, sessionId) || {};
  const normalized = normalizeTaskScope({
    target: input?.target ?? previous.target,
    scope: input?.scope?.include ?? input?.scope
      ?? (input?.target !== undefined ? undefined : previous.scope?.include),
    allowedOrigins: input?.allowedOrigins !== undefined ? input.allowedOrigins
      : input?.target !== undefined ? undefined : previous.allowedOrigins,
    excluded: input?.excludedPaths ?? previous.scope?.exclude,
    requestText: input?.target ?? previous.requestText,
  });
  assertScopeErrors(normalized)
  const replacesScope = input?.target !== undefined || input?.scope !== undefined || input?.allowedOrigins !== undefined
  const choice = { workflow: 'single', ...previous,
    target: replacesScope ? normalized.target : (previous.target || ''),
    primaryTarget: replacesScope ? normalized.primaryTarget : (previous.primaryTarget || ''),
    scope: replacesScope ? normalized.scope : (previous.scope || { include: [], exclude: [] }),
    scopeTerms: replacesScope ? normalized.terms : (previous.scopeTerms || { include: [], exclude: [] }),
    entrypoints: replacesScope ? normalized.entrypoints : (previous.entrypoints || []),
    allowedOrigins: normalizeAllowedOrigins(input?.allowedOrigins !== undefined ? input.allowedOrigins
      : input?.target !== undefined ? [] : previous.allowedOrigins),
    allowTargetNetwork: input?.allowTargetNetwork === undefined ? (previous.allowTargetNetwork ?? true) : input.allowTargetNetwork === true,
    readOnly: input?.readOnly === undefined ? (previous.readOnly ?? false) : input.readOnly === true,
    excludedPaths: input?.excludedPaths === undefined ? normalizeExcludedPaths(previous.excludedPaths) : normalizeExcludedPaths(input.excludedPaths),
    requestRatePerMinute: input?.requestRatePerMinute === undefined ? normalizeRequestRate(previous.requestRatePerMinute) : normalizeRequestRate(input.requestRatePerMinute),
    requestConcurrency: input?.requestConcurrency === undefined ? normalizeRequestConcurrency(previous.requestConcurrency) : normalizeRequestConcurrency(input.requestConcurrency) };
  store.db.prepare('INSERT INTO task_flow_choice(session_id,record) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET record=excluded.record')
    .run(sessionId, JSON.stringify(choice));
  return choice;
}
export function setTaskWorkers(store, sessionId, workers, source) {
  if (source !== 'desktop-user') throw Error('worker preference requires Desktop user action');
  const policy = readTaskPolicy(store, sessionId);
  if (!policy || policy.parentSession) throw Error('only a main task can change worker limits');
  const limit = integer(workers, 'workers', 0, MAX_SITE_WORKERS);
  const active = ownedPurposeTasks(store, sessionId).filter(row => row.activationState !== 'released').length
    + store.db.prepare('SELECT record FROM site_workers WHERE parent_session=?').all(sessionId)
      .filter(row => parseRowRecord(row, { table: 'site_workers', key: 'parent_session', id: sessionId }).state !== 'released').length;
  if (limit < active) throw Error('当前有'+active+'个子代理占用名额，请在任务详情中先关闭，再降低上限');
  return write(store, sessionId, { ...policy, workerLimit: limit, budget: { ...policy.budget, workers: limit } });
}

/** Change the user's current focus without replacing the task, evidence, or cumulative budget. */
export function setTaskMode(store, sessionId, mode, source) {
  if (source !== 'desktop-user') throw new Error('测试方向变更需要用户确认')
  if (!modes.has(mode)) throw new Error('invalid task mode')
  const policy = readTaskPolicy(store, sessionId)
  if (!policy || policy.parentSession) throw new Error('only a main task can change focus')
  if (policy.scenario === 'project') throw new Error('按文档测试不使用研究重点模式')
  if (policy.mode === mode) return policy
  // A focus-only change must not silently discard a scope/time proposal the
  // user still has to approve.
  return write(store, sessionId, { ...policy, mode, flow: normalizeTaskFlow('single', mode) }, 'task-focus-updated',
    { source: 'desktop-user' })
}

/** User-approved budget extension. Used and cumulative counters are never reset. */
export function setTaskBudget(store, sessionId, input, source) {
  if (source !== 'desktop-user') throw new Error('budget changes require Desktop user action')
  const policy = readTaskPolicy(store, sessionId)
  if (!policy || policy.parentSession) throw new Error('only a main task can change budget')
  const next = { ...policy, budget: { ...policy.budget } }
  if (input?.toolCalls !== undefined) {
    if (input.toolCalls === null || input.toolCalls === '') next.budget.toolCalls = null
    else {
      const value = integer(input.toolCalls, 'toolCalls', 1, 100000)
      if (value < (policy.used?.toolCalls ?? 0)) throw new Error('工具调用上限不能低于已使用数量')
      next.budget.toolCalls = value
    }
  }
  if (input?.unmeteredToolCalls !== undefined) {
    if (input.unmeteredToolCalls === null || input.unmeteredToolCalls === '') next.budget.unmeteredToolCalls = null
    else {
      const value = integer(input.unmeteredToolCalls, 'unmeteredToolCalls', 0, 1000)
      if (value < (policy.used?.unmeteredToolCalls ?? 0)) throw new Error('未计量通道上限不能低于已使用数量')
      next.budget.unmeteredToolCalls = value
    }
    next.budget.unmeteredExplicit = true
  }
  if (input?.extendMinutes !== undefined) {
    const minutes = integer(input.extendMinutes, 'extendMinutes', 1, 10080)
    next.budget.deadline = Math.max(Date.now(), policy.budget.deadline ?? 0) + minutes * 60000
  }
  if (input?.minutes !== undefined) {
    const minutes = integer(input.minutes, 'minutes', 1, 10080)
    next.budget.deadline = (policy.startedAt ?? Date.now()) + minutes * 60000
  }
  if (input?.modelCalls !== undefined) next.budget.modelCalls = integer(input.modelCalls, 'modelCalls', 1, 10000)
  if (input?.tokens !== undefined) next.budget.tokens = integer(input.tokens, 'tokens', 1, 1000000000000)
  return write(store, sessionId, next, 'task-budget-updated', { source: 'desktop-user' })
}

function savePendingChange(store, sessionId, policy, patch, labels) {
  const previous = policy.pendingChange
  const change = {
    at: Date.now(),
    source: 'chat-request',
    patch: { ...(previous?.patch || {}), ...patch },
    fields: [...new Set([...(previous?.fields || []), ...Object.keys(patch)])],
    summary: [...new Set([...(previous?.summary ? previous.summary.split('；') : []), ...labels])].join('；'),
  }
  return write(store, sessionId, { ...policy, pendingChange: change }, 'task-change-requested',
    { pendingChange: change })
}

export function applyPendingTaskChange(store, sessionId, source = 'desktop-user') {
  return taskTransaction(store, () => {
    if (source !== 'desktop-user') throw new Error('pending scope changes require the user')
    const policy = readTaskPolicy(store, sessionId)
    if (!policy?.pendingChange?.patch) throw new Error('没有待确认的任务变更')
    const patch = policy.pendingChange.patch
    const { pendingChange: ignored, ...rest } = policy
    write(store, sessionId, rest, 'task-change-started', { source: 'desktop-user' })
    if (patch.mode) setTaskMode(store, sessionId, patch.mode, 'desktop-user')
    if (patch.target !== undefined || patch.scope !== undefined || patch.allowedOrigins !== undefined)
      setTaskActionLimits(store, sessionId, patch, 'desktop-user')
    if (patch.allowTargetNetwork !== undefined || patch.readOnly !== undefined || patch.excludedPaths !== undefined
      || patch.requestRatePerMinute !== undefined || patch.requestConcurrency !== undefined || patch.workers !== undefined)
      updateTaskFromChat(store, sessionId, patch, 'desktop-user')
    if (patch.toolCalls !== undefined || patch.minutes !== undefined || patch.extendMinutes !== undefined
      || patch.unmeteredToolCalls !== undefined || patch.modelCalls !== undefined || patch.tokens !== undefined)
      setTaskBudget(store, sessionId, patch, 'desktop-user')
    const current = readTaskPolicy(store, sessionId)
    const { pendingChange: stillPending, ...clean } = current
    // Confirmation is an explicit user continuation. It lifts only the ordinary
    // end-of-turn pause; every hard stop/blocker remains in the record untouched.
    if (taskPolicyStatus(store, sessionId).reason === 'turn_ended') {
      delete clean.turnEndedAt
      delete clean.finishedAt
    }
    return write(store, sessionId, clean, 'task-change-applied', { source: 'desktop-user', fields: Object.keys(patch) })
  })
}

export function cancelPendingTaskChange(store, sessionId, source = 'desktop-user') {
  if (source !== 'desktop-user') throw new Error('pending scope changes require the user')
  const policy = readTaskPolicy(store, sessionId)
  if (!policy?.pendingChange) return policy
  const { pendingChange: ignored, ...next } = policy
  return write(store, sessionId, next, 'task-change-cancelled', { source: 'desktop-user' })
}

/** 聊天里可以改的设置字段（v6 第 4.2 节）；其余字段一律拒绝并说明缺项。 */
const CHAT_UPDATE_FIELDS = ['interaction', 'reporting', 'explain', 'workers', 'allowTargetNetwork', 'readOnly',
  'excludedPaths', 'requestRatePerMinute', 'requestConcurrency', 'toolCalls', 'minutes',
  'unmeteredToolCalls', 'extendMinutes', 'workerModel', 'reviewModel', 'reportModel',
  'mode', 'target', 'scope', 'allowedOrigins', 'scopeOperation', 'scopeMode'];
const CHAT_UPDATE_LABELS = {
  interaction: '什么时候问我', reporting: '什么时候汇报', explain: '解释原理', workerLimit: '助手上限',
  allowTargetNetwork: '允许访问网站', readOnly: '不改动网站数据', excludedPaths: '排除路径',
  requestRatePerMinute: '扫描速率', requestConcurrency: '并发上限', toolCalls: '工具调用上限', minutes: '时间上限',
  workerModel: '查找问题模型', reviewModel: '复核结果模型', reportModel: '整理报告模型',
  target: '测试范围', mode: '测试重点', unmeteredToolCalls: '未计量通道上限', extendMinutes: '时间上限',
  scopeOperation: '范围操作', scopeMode: '范围操作',
};
const CHAT_INTERACTION_TEXT = { auto: '自行推进', 'confirm-data-change': '改动网站数据前问我', 'confirm-step': '每个检查步骤前问我' };
const CHAT_REPORTING_TEXT = { end: '任务结束时', notable: '发现问题或需要帮助时', step: '每完成一个检查步骤时' };

function chatSettingText(field, value) {
  if (field === 'interaction') return CHAT_INTERACTION_TEXT[value] || String(value ?? '');
  if (field === 'reporting') return CHAT_REPORTING_TEXT[value] || String(value ?? '');
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (Array.isArray(value)) return value.length ? value.join('、') : '无';
  return value === null || value === undefined ? '未设置' : String(value);
}

/**
 * Apply safe tightening immediately. A requested expansion is saved as one pending diff;
 * only the Desktop user endpoint may confirm it. This keeps chat-driven changes useful
 * without letting a model or retrieved document grant itself more scope.
 */
export function updateTaskFromChat(store, sessionId, input, source = 'model-chat') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('update 需要 JSON 对象');
  const policy = readTaskPolicy(store, sessionId);
  if (!policy) throw new Error('任务尚未开始；先用 action=start 建立任务');
  if (policy.parentSession) throw new Error('子任务不能改主任务设置');
  const unknown = Object.keys(input).filter((key) => !CHAT_UPDATE_FIELDS.includes(key));
  if (unknown.length) throw new Error(`update 不接受字段 ${unknown.join('、')}；可改：${CHAT_UPDATE_FIELDS.join('、')}`);
  if (!Object.keys(input).length) throw new Error(`update 没有给任何字段；可改：${CHAT_UPDATE_FIELDS.join('、')}`);

  const { pendingChange: previousPending, ...basePolicy } = policy;
  const next = { ...basePolicy, budget: { ...policy.budget }, ...(previousPending ? { pendingChange: previousPending } : {}) };
  const changed = [];
  const pendingPatch = {};
  const pendingLabels = [];
  const mark = (field) => { if (!changed.includes(field)) changed.push(field); };
  const propose = (field, value, label) => { pendingPatch[field] = value; if (!pendingLabels.includes(label)) pendingLabels.push(label); };
  const desktop = source === 'desktop-user';

  if (input.target !== undefined || input.scope !== undefined || input.allowedOrigins !== undefined
    || input.scopeOperation !== undefined || input.scopeMode !== undefined) {
    const scopeOperation = input.scopeOperation ?? input.scopeMode ?? 'replace';
    if (!['replace', 'append', 'remove', 'clear'].includes(scopeOperation))
      throw new Error('scopeOperation 只能是 replace、append、remove 或 clear');
    const requested = normalizeTaskScope({
      target: input.target,
      scope: input.scope,
      allowedOrigins: input.allowedOrigins,
    });
    assertScopeErrors(requested);
    let targetInput = input.target;
    let scopeInput = input.scope;
    if (scopeOperation === 'clear') {
      targetInput = '';
      scopeInput = [];
    } else if (scopeOperation === 'append') {
      targetInput = [policy.target, input.target].filter(value => String(value ?? '').trim()).join('\n');
      scopeInput = undefined;
    } else if (scopeOperation === 'remove') {
      const current = normalizeTaskScope({ target: policy.target, scope: policy.scope?.include, allowedOrigins: policy.allowedOrigins });
      const remove = new Set(requested.scope.include.map(value => value.toLowerCase()));
      targetInput = current.scope.include.filter(value => !remove.has(value.toLowerCase())).join('\n');
      scopeInput = undefined;
    }
    const normalized = normalizeTaskScope({
      target: targetInput === undefined ? policy.target : targetInput,
      scope: scopeInput !== undefined ? scopeInput : targetInput !== undefined ? undefined : policy.scope?.include,
      allowedOrigins: scopeOperation === 'replace' && input.allowedOrigins !== undefined ? input.allowedOrigins : undefined,
      excluded: [...(policy.scope?.exclude || []), ...normalizeExcludedPaths(policy.excludedPaths)],
      requestText: targetInput ?? policy.requestText,
    });
    assertScopeErrors(normalized)
    const allowTargetNetwork = input.allowTargetNetwork === undefined
      ? policy.allowTargetNetwork !== false
      : input.allowTargetNetwork === true
    if (!normalized.scope.include.length && allowTargetNetwork)
      throw new Error('测试范围不能为空；只做离线分析时请同时关闭“允许访问网站”');
    if (desktop) {
      next.target = normalized.target;
      next.primaryTarget = normalized.primaryTarget;
      next.scope = normalized.scope;
      next.scopeTerms = normalized.terms;
      next.entrypoints = normalized.entrypoints;
      next.allowedOrigins = normalized.scope.include;
      mark('target');
    } else {
      propose('target', normalized.target, '测试范围');
    }
  }
  if (input.mode !== undefined) {
    if (!modes.has(input.mode)) throw new Error('invalid task mode');
    if (policy.scenario === 'project') throw new Error('按文档测试不使用研究重点模式');
    if (desktop) { next.mode = input.mode; next.flow = normalizeTaskFlow('single', input.mode); mark('mode'); }
    else propose('mode', input.mode, '测试重点');
  }
  if (input.workflow !== undefined || input.startMode !== undefined)
    throw new Error('测试安排是旧流程字段；用 mode 调整研究重点，不需要重建任务或切换固定流程');

  if (input.interaction !== undefined) {
    const value = normalizeInteraction(input.interaction);
    if (value !== policy.interaction) { next.interaction = value; mark('interaction'); }
    if (input.reporting === undefined) {
      const reporting = reportingFor({ interaction: value, reporting: policy.reporting });
      if (reporting !== policy.reporting) { next.reporting = reporting; mark('reporting'); }
    }
  }
  if (input.reporting !== undefined) {
    const reporting = reportingFor({ interaction: next.interaction, reporting: input.reporting });
    if (reporting !== policy.reporting) { next.reporting = reporting; mark('reporting'); }
  }
  if (input.explain !== undefined) {
    const value = input.explain === true;
    if (value !== policy.explain) { next.explain = value; mark('explain'); }
  }
  if (input.workers !== undefined) {
    const value = integer(input.workers, 'workers', 0, MAX_SITE_WORKERS);
    if (value > policy.workerLimit) desktop
      ? (next.workerLimit = value, next.budget.workers = value, mark('workerLimit'))
      : propose('workers', value, '助手上限');
    else if (value !== policy.workerLimit) { next.workerLimit = value; next.budget.workers = value; mark('workerLimit'); }
  }
  if (input.allowTargetNetwork !== undefined) {
    if (input.allowTargetNetwork !== false) desktop
      ? (next.allowTargetNetwork = true, mark('allowTargetNetwork'))
      : propose('allowTargetNetwork', true, '允许访问网站');
    else if (policy.allowTargetNetwork !== false) { next.allowTargetNetwork = false; mark('allowTargetNetwork'); }
  }
  if (input.readOnly !== undefined) {
    if (input.readOnly !== true) desktop
      ? (next.readOnly = false, mark('readOnly'))
      : propose('readOnly', false, '不改动网站数据');
    else if (policy.readOnly !== true) { next.readOnly = true; mark('readOnly'); }
  }
  if (input.excludedPaths !== undefined) {
    const wanted = normalizeExcludedPaths(input.excludedPaths);
    const current = normalizeExcludedPaths(policy.excludedPaths);
    const removed = current.filter((entry) => !wanted.includes(entry));
    if (removed.length) desktop
      ? (next.excludedPaths = wanted, mark('excludedPaths'))
      : propose('excludedPaths', wanted, '排除路径');
    else if (JSON.stringify(wanted) !== JSON.stringify(current)) { next.excludedPaths = wanted; mark('excludedPaths'); }
  }
  if (input.requestRatePerMinute !== undefined) {
    const value = normalizeRequestRate(input.requestRatePerMinute);
    const current = normalizeRequestRate(policy.requestRatePerMinute);
    if (value === null || (current !== null && value > current)) desktop
      ? (next.requestRatePerMinute = value, mark('requestRatePerMinute'))
      : propose('requestRatePerMinute', input.requestRatePerMinute, '扫描速率');
    else if (value !== current) { next.requestRatePerMinute = value; mark('requestRatePerMinute'); }
  }
  for (const [field, label] of [['workerModel', '查找问题模型'], ['reviewModel', '复核结果模型'], ['reportModel', '整理报告模型']]) {
    if (input[field] === undefined) continue;
    const value = normalizeModelChoice(input[field], label);
    if (JSON.stringify(value) !== JSON.stringify(policy[field] ?? null)) { next[field] = value; mark(field); }
  }
  if (input.requestConcurrency !== undefined) {
    const value = normalizeRequestConcurrency(input.requestConcurrency);
    const current = normalizeRequestConcurrency(policy.requestConcurrency);
    if (value === null || (current !== null && value > current)) desktop
      ? (next.requestConcurrency = value, mark('requestConcurrency'))
      : propose('requestConcurrency', input.requestConcurrency, '并发上限');
    else if (value !== current) { next.requestConcurrency = value; mark('requestConcurrency'); }
  }
  if (input.toolCalls !== undefined) {
    const value = input.toolCalls === null || input.toolCalls === '' ? null : integer(input.toolCalls, 'toolCalls', 1, 100000);
    if (value === null || (policy.budget.toolCalls !== null && value > policy.budget.toolCalls)) desktop
      ? (next.budget.toolCalls = value, mark('toolCalls'))
      : propose('toolCalls', value, '工具调用上限');
    else if (value !== policy.budget.toolCalls) { next.budget.toolCalls = value; mark('toolCalls'); }
  }
  if (input.minutes !== undefined) {
    const value = integer(input.minutes, 'minutes', 1, 10080);
    if (desktop) {
      next.budget.deadline = (policy.startedAt ?? Date.now()) + value * 60000;
      mark('minutes');
    } else propose('minutes', value, '时间上限');
  }
  if (input.unmeteredToolCalls !== undefined) {
    const value = input.unmeteredToolCalls === null || input.unmeteredToolCalls === ''
      ? null : integer(input.unmeteredToolCalls, 'unmeteredToolCalls', 0, 1000);
    desktop ? (next.budget.unmeteredToolCalls = value, mark('unmeteredToolCalls'))
      : propose('unmeteredToolCalls', value, '未计量通道上限');
    if (desktop) next.budget.unmeteredExplicit = true;
  }
  if (input.extendMinutes !== undefined) {
    const value = integer(input.extendMinutes, 'extendMinutes', 1, 10080);
    desktop ? (next.budget.deadline = Math.max(Date.now(), policy.budget.deadline ?? 0) + value * 60000, mark('extendMinutes'))
      : propose('extendMinutes', value, '时间上限');
  }
  if (Object.keys(pendingPatch).length) {
    if (!changed.length && !pendingLabels.length) return { changed: [], summary: '没有需要修改的设置' };
    const saved = savePendingChange(store, sessionId, next, pendingPatch, pendingLabels);
    const parts = [];
    if (changed.length) parts.push('已立即收紧：' + changed.map(field => CHAT_UPDATE_LABELS[field] || field).join('、'));
    parts.push('待你确认：' + saved.pendingChange.summary);
    return { changed, pendingChange: saved.pendingChange, summary: parts.join('；') };
  }
  if (!changed.length && !previousPending) return { changed: [], summary: '没有需要修改的设置' };
  const written = writeTaskPolicy(store, sessionId, next, 'policy-updated', { source: desktop ? 'desktop-user' : 'chat-update' });
  const summary = changed.map((field) => {
    const value = field === 'toolCalls' ? written.budget.toolCalls
      : field === 'extendMinutes' ? (written.budget.deadline === null ? '未设置' : new Date(written.budget.deadline).toISOString().slice(0, 16).replace('T', ' '))
      : field === 'unmeteredToolCalls' ? written.budget.unmeteredToolCalls
      : field === 'target' ? written.target
      : written[field];
    return CHAT_UPDATE_LABELS[field] + ' → ' + chatSettingText(field, value);
  }).join('；');
  return { changed, summary };
}
export function confirmTaskCheckpoint(store, sessionId, source) {
  if (source !== 'desktop-user') throw new Error('checkpoint requires Desktop user confirmation');
  const policy = readTaskPolicy(store, sessionId);
  if (!policy?.awaitingConfirmation || policy.parentSession) throw new Error('no main task checkpoint awaiting confirmation');
  if (taskPolicyStatus(store, sessionId).reason !== 'interaction_confirmation_required') throw new Error('task stopped for another reason');
  const { awaitingConfirmation, ...next } = policy;
  return write(store, sessionId, next);
}
export function researchReady(context) {
  // Input gate is also enforced by zday_pattern against the selected baseline.
  return !!context?.requests?.some(request => ['backend', 'api', 'web'].includes(request.kind) && request.valid === true
    && request.request?.trim() && /^HTTP\/\S+\s+2\d\d\b/i.test(request.response || '')
    && request.inputs?.some(input => input.name?.trim() && ['query', 'body', 'path', 'header'].includes(input.location) && input.evidenceIds?.includes(request.id))
    && context.assets?.some(asset => { try { return asset.inScope === true && asset.reachable === true && new URL(asset.url).origin === new URL(request.endpoint).origin; } catch { return false; } }));
}
export function taskPolicyStatus(store, sessionId, now = Date.now()) {
  const policy = readTaskPolicy(store, sessionId);
  if (!policy) return { configured: false, phase: 'preparing', choice: chosenTaskMode(store, sessionId), options: chosenTaskOptions(store, sessionId), stopped: false, reason: 'task_policy_missing' };
  const findings = allFindings(store, sessionId, 'pentest').filter(finding => {
    const state = findingDeliveryState(finding);
    return state.ready && state.reproductionVerified;
  });
  let reason = '';
  if (policy.blocker) reason = 'paused:' + policy.blocker.code;
  else if (policy.modelBudgetBlock) reason = 'model_budget:' + policy.modelBudgetBlock.code;
  else if (policy.cancelled) reason = 'cancelled';
  else if (policy.flow?.phase === 'done') reason = 'plan_complete';
  else if (policy.stop === 'queue' && policy.queueComplete) reason = 'queue_complete';
  else if (policy.stop === 'budget' && policy.planComplete) reason = 'plan_complete';
  else if (policy.budget.deadline !== null && now >= policy.budget.deadline) reason = 'time_budget_exhausted';
  else if (policy.budget.toolCalls !== null && policy.budget.toolCalls !== undefined && policy.used.toolCalls >= policy.budget.toolCalls) reason = 'tool_budget_exhausted';
  else if (policy.turnEndedAt) reason = 'turn_ended';
  else if (policy.stop === 'first-rce' && findings.some(finding => finding.proofKind === 'execution')) reason = 'first_verified_rce';
  else if (policy.stop === 'first-high' && findings.some(finding => ['high', 'critical'].includes(finding.secondRating))) reason = 'first_verified_high';
  else if (policy.awaitingConfirmation) reason = 'interaction_confirmation_required';
  const ready = policy.mode === '0day' ? researchReady(readTaskContext(store, sessionId)) : false;
  if (!reason && policy.parentSession) {
    const parent = taskPolicyStatus(store, policy.parentSession, now);
    if (!parent.configured || parent.stopped) reason = 'parent_task_stopped:' + parent.reason;
  }
  // 任务状态词表（v6 第 8.2 节）：准备 / 运行 / 等待信息 / 暂停中 / 已暂停 / 已完成 / 失败。
  // 这里只算不依赖代理运行时的部分；「暂停中 vs 已暂停」由调用方按代理是否仍在收尾细分。
  const phase = !reason ? 'running'
    : ['plan_complete', 'queue_complete', 'first_verified_rce', 'first_verified_high'].includes(reason) ? 'completed'
    : reason.startsWith('model_budget:') ? 'failed'
    : reason === 'cancelled' ? 'paused'
    : (reason === 'interaction_confirmation_required' || reason.startsWith('paused:')) ? 'waiting-info'
    : 'paused';
  return { configured: true, phase, stopped: !!reason, reason, policy, researchReady: ready,
    observationExhausted: policy.mode === '0day' && !ready && policy.used.discoveryCalls >= policy.budget.discoveryCalls,
    reviewedReproducedFindings: findings.length };
}
export function takeTaskContinuation(store, sessionId) {
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const state = taskPolicyStatus(store, sessionId);
    if (!state.configured || state.stopped || state.policy.parentSession || state.policy.needsBaselineRecheck
      || !state.policy.flow?.needsContinuation
      || hasUnreleasedWorker(store, sessionId)) {
      store.db.exec('COMMIT'); return null;
    }
    const next = { ...state.policy, flow: { ...state.policy.flow, needsContinuation: false } };
    write(store, sessionId, next); store.db.exec('COMMIT');
    return { id: 'saker-flow-'+sessionId+'-'+next.startedAt+'-'+next.flow.history.length,
      role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '[Saker 自动衔接，来自已选流程] '+interactionPrompt(next.interaction,false,reportingFor(next))+taskFlowPrompt(next)+'继续尚未完成的步骤，不重建任务、不重置预算。' }] };
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}
/**
 * 回合已经停止、没有待续流程或未释放子代理时，收口本轮目标操作。
 * 这不是“完成”：只把 turnEndedAt 写进同一份任务记录，资料、预算、未完成项都保留；
 * 用户下一次消息可继续，不必等时间上限，也不会把“模型停止输出”伪装成 plan_complete。
 */
export function finishTaskOnTurnEnd(store, sessionId, now = Date.now()) {
  const state = taskPolicyStatus(store, sessionId, now);
  if (!state.configured || state.stopped || state.policy.parentSession) return null;
  // 多阶段流程由 takeTaskContinuation 负责；回合结束兜底只收口单阶段小任务。
  if (state.policy.flow?.kind !== 'single') return null;
  if (state.policy.flow?.needsContinuation || state.policy.needsBaselineRecheck
    || state.policy.awaitingConfirmation || state.policy.blocker) return null;
  if (hasUnreleasedWorker(store, sessionId)) return null;
  const next = write(store, sessionId, { ...state.policy, turnEndedAt: now, finishedAt: now });
  return { ...state, stopped: true, reason: 'turn_ended', policy: next };
}

/** True only for an explicit human request to keep the existing task running. */
export function isExplicitTaskContinuation(message) {
  if (!message || message.source?.kind !== 'user' || /^saker-/i.test(String(message.id || ''))) return false;
  const text = (Array.isArray(message.content) ? message.content : [message.content])
    .filter(block => block?.type === 'text' || typeof block === 'string')
    .map(block => typeof block === 'string' ? block : block.text)
    .join('\n').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 300) return false;
  if (/(?:怎么|如何|为什么|是否|能否|可不可以).{0,12}继续|(?:status|状态|进展|计划|方案)/i.test(text)) return false;
  // Negation, pausing and conditional language must stay stopped. Keep this
  // deliberately conservative; uncertain long sentences can use the explicit
  // Desktop button instead of being guessed as an execution command.
  if (/(?:不要|别|无需|不必|先不|暂缓|暂停|等一下|稍后|前先|do\s+not|don't|dont|stop|wait|before|not\s+now)/i.test(text))
    return false;
  return /^(?:请|麻烦)?(?:继续|接着(?:做|测试)?)(?:当前)?(?:任务|测试|执行|做)?(?:吧)?[。.!！]?$/.test(text)
    || /^(?:please\s+)?(?:continue|resume)\s+(?:the\s+)?(?:current\s+)?(?:task|testing|work|run)(?:\s+please)?[.!]?$/i.test(text);
}

/**
 * Lift only the ordinary end-of-turn pause. All terminal and blocked states
 * (cancel, hard limits, unknown write, takeover, confirmation, blocker) remain.
 */
export function resumeTurnEndedTask(store, sessionId, source = 'user-message') {
  return taskTransaction(store, () => {
    const state = taskPolicyStatus(store, sessionId);
    if (!state.configured || state.reason !== 'turn_ended') return null;
    const { turnEndedAt, finishedAt, ...next } = state.policy;
    const written = write(store, sessionId, next, 'task-continued', { source, workId: sessionId });
    return { ...written, continued: true, source };
  });
}
// 工具契约最短路径（J2–J9 实测：模型宁可在文件系统里翻契约也不猜）。这是工具调用契约，
// 不是固定渗透方法流程；保留它以避免模型为找契约烧预算。模型仍自行决定研究步骤。
const EVIDENCE_PATH_HINT = '证据链最短路径（不要再为找契约翻 README、插件源码或文件系统；按本条直接推进）：①redteam_context 存资产{id,url,reachable:true}（与任务目标同 origin 时 inScope 自动带上）'
  + '与请求{id,endpoint(完整URL，**参数值写进 URL**，如 .../search?q=apple),authContext,revision,method,headers,body}（报文由结构化字段自动拼；inputs 只标注参数位置，不携带值）；'
  + '②redteam_execution direct 可直接按用户给的范围执行并自动保存资产/请求/响应；已存请求也可用 run 或 purpose=exploration 直接执行，不要求先建研究方向；'
  + '③把该请求改成 {valid:true,kind:"api",inputs:[{name,location,evidenceIds:[请求id]}],responseReceiptId:回执id} 存回'
  + '（原文由宿主按回执回填，不要手抄）；④redteam_research create 建方向；'
  + '⑤run-pair 用 document={hypothesisId,normal:{requestId,requestRevision},probe:{requestId,requestRevision}} 做正常/受控对照'
  + '（两条都必须是该方向同端点、同身份的已存 GET/HEAD，查询参数可变；normal 用已确认的 valid 基线；**不需要方法包**，带 methodId/methodVersion 时才校验已审阅方法）；'
  + '对照跑完先用 redteam_research assess 说明业务含义再继续；基线的 request/response 不要改写（换 responseReceiptId 会改变绑定，后续执行/对照会被拒绝），新证据放进探针请求；'
  + '⑥verify-effect 走已审阅配方；'
  + '⑦落结论前逐类清点对照（正常、所有者、越权、拒绝等），哪一类不足就补足或把结论降级为不可确认——提交后再补不算数；'
  + '良性对照必须是**不含载荷/攻击输入**的正常请求（例如普通查询），用带载荷的请求充当正常对照不算；'
  + '题面或材料里已经给出的 normalRequests 就是良性对照，必须原样发出（逐字不改）并计入证据，不能只发载荷请求；'
  + 'normalRequests 的 URL、方法、请求头和正文都不要改写，含空参数就保留为空，不得为了填参数自造普通占位值；'
  + '题面要求每类至少两轮时，normalRequests 里对应的正常请求也要各发两轮，不能只发一次凑数；'
  + '提交前按题面要求逐类清点回执 id，任何一类少一条都先补发，不能先提交再补。'
  + '注意：保存快照是整包替换，改资产时要一并带上已有请求。';
// 受控工具面（效果基准 / 宿主限制）只暴露 exercise_request + exercise_submit：
// 此时绝不能继续引用被隐藏的 Saker 工具，否则模型会为不存在的工具多走步骤。
const CONTROLLED_INTERFACE_HINT = '本轮工具面只有 exercise_request 和 exercise_submit；按题面要求收集回执，提交前逐类清点。';
// 复测（v6 第 9.2 节）的工具契约：结论只有三种，且必须新建版本记录、引用本次回执，不覆盖原发现。
// 2026-10-18 完整任务实测：提示里没有这一行时，模型把预算花在路径猜测上，一条复测记录都没写。
const RETEST_HINT = '复测已有发现时：先用可计量入口重新核对（拿到 execution 回执），再用 redteam_finding_update 带'
  + ' retestVerdict=仍可复现/本次未复现/无法确认 与 retestExecutionId 记录新版本；「本次未复现」还要给'
  + ' retestControlExecutionId（同一次复测的正常功能对照，必须同源、同身份且返回 2xx）；不要改写或删除原发现，'
  + '登录失效、限流和服务端错误只能记“无法确认”。';
function taskPromptBase(state, includeUsage = true, controlledInterface = false) {
  if (!state.configured) {
    const selectedTarget = String(state.options?.target || '');
    const targetText = selectedTarget.slice(0, 4000)
      + (selectedTarget.length > 4000 ? '\n[完整目标与范围已保存在桌面任务选择中；此处只显示前 4000 字。]' : '');
    return (state.choice ? '用户选择了/pentest-'+state.choice+'。用户决定目标、范围和重点，模型选择方法与顺序；选择菜单没有开始测试。' : '渗透测试：用户可给网址、域名、IP/CIDR、资产清单、代码、请求或文档；已有材料直接推进，不要求先做全量测绘。')
      + (state.options?'沿用桌面选择workflow='+state.options.workflow+'，子代理上限='+state.options.workers+'，不能自行增加。':'')
      + (selectedTarget ? '；用户在桌面设置中给出的目标与范围（保留完整路径）：'+targetText : '')
      + interactionPrompt(state.options?.interaction,false,reportingFor(state.options));
  }
  const policy=state.policy;
  if (policy.scenario === 'project') {
    const projectUsage = includeUsage && policy.budget.toolCalls !== null && policy.budget.toolCalls !== undefined
      ? '操作=' + policy.used.toolCalls + '/' + policy.budget.toolCalls + '；'
      : '操作按实际调用统计（未设上限）；';
    return '按文档连续测试：先用 project_document list/read 读取用户提供的测试要求，用 project_check define/next 保存并领取检查、record 保存实际结果和缺口；继续独立项；'
      + '目标测试优先用 saker_browser 的受管 Chrome for Testing（CDP）；原始 HTTP 用 project_request，'
      + '不要用 shell curl 直接发目标请求——curl 不会自动带 Cookie/Origin/Referer/User-Agent 等浏览器请求头，容易误判结果；'
      + (policy.projectRunId ? '当前运行=' + policy.projectRunId + '；历史检查编号不沿用，当前项用 project_check next 获取。' : '')
      + '本轮问题：' + (policy.question || '按用户文档') + '；站点：' + (policy.target || '按已给授权范围，不能自行扩大') + '；' + projectUsage
      + '停止规则=' + policy.stop + '。' + (includeUsage ? '' : '需要精确用量时调用 redteam_task action=status；宿主守卫按最新预算拦截。')
      + (state.stopped ? '目标操作已停止：' + state.reason + '。只整理证据与交付。' : '使用实际观察结果；没有执行到的项写清未完成，不能写成通过。')
      + (controlledInterface ? CONTROLLED_INTERFACE_HINT : '');
  }
  // 易变计数不放进常驻快照：宿主每次发现快照文本变化都会追加新的 runtime-context
  // 消息，缓存会在每个工具调用后失效。精确用量改由 redteam_task status 按需查询，
  // 真正的执行守卫仍按最新预算强制拦截。
  const usage = includeUsage
    ? '操作='+policy.used.toolCalls+(policy.budget.toolCalls===null?'/未设上限':'/'+policy.budget.toolCalls)
      +'；未计量通道='+(policy.used.unmeteredToolCalls??0)+(Number.isInteger(policy.budget.unmeteredToolCalls)?'/'+policy.budget.unmeteredToolCalls:'/未设额外上限')
      +'（实际请求数未知，一次工具调用不等于一个目标请求）；'
    : '';
  const usageHint = includeUsage ? '' : '需要精确用量时调用 redteam_task action=status；宿主守卫按最新预算拦截。';
    const scopeText = taskScopePromptText(policy);
    const fullRequest = String(policy.requestText || '');
    const requestText = fullRequest.slice(0, 4000) + (fullRequest.length > 4000 ? '\n[完整用户原文已保存在任务记录；此处只显示前 4000 字，避免每轮重复占满上下文。]' : '');
    return interactionPrompt(policy.interaction, !!policy.parentSession,reportingFor(policy))+taskFlowPrompt(policy)+'用户要求：'+requestText+'；范围：'+scopeText+'；重点='+policy.mode+'；'+usage+'方法、顺序、工具和分工由模型按用户目标决定；直接使用 shell/MCP 的请求若宿主未捕获，不会产生宿主执行回执，要留可复查证据优先用 redteam_execution direct/run；停止规则='+policy.stop+'。'+usageHint+'不要重置预算。可在范围内改变优先级、工具和助手对象；准备结束本轮时先cleanup释放全部子代理，再redteam_task progress {planComplete:true}（只等待用户资料或未完成时不要标记）；子代理不能再派代理。'+(state.stopped?'目标操作已停止：'+state.reason+'。'+(policy.awaitingConfirmation?'等待桌面确认并继续；不能自行解除。':policy.blocker?policy.blocker.reason+'；先向用户汇报，不能自动绕行或自行解除。':'只整理证据与交付。'):policy.needsBaselineRecheck?'用户已处理阻碍，先用redteam_execution run purpose=baseline复查已存正常GET/HEAD请求，然后继续原问题。':'使用实际正常对照和影响证据；回执不等于漏洞。')+(controlledInterface ? CONTROLLED_INTERFACE_HINT : '');
}
function taskPromptWithUsage(state, includeUsage, controlledInterface = false, selection = null) {
  const base = taskPromptBase(state, includeUsage, controlledInterface);
  const explain = state?.configured ? state.policy?.explain : state?.options?.explain;
  const policy = state?.configured ? state.policy : state?.options;
    const scopeSummary = policy ? taskScopeSummary(policy) : null;
    const limits = (policy?.allowTargetNetwork === false
    ? '；动作限制：本任务已关闭“允许访问网站”，程序会拒绝一切目标网络操作（MCP、扫描器、shell、浏览器、已存请求与基线复查）；只分析已添加内容，需要访问网站由用户在测试设置里明确打开。'
    : '')
    + (policy?.readOnly === true
      ? '；动作限制：本任务设置为“不改动网站数据”，只能发 GET/HEAD 这类读取请求；提交、修改或删除业务数据会被程序拒绝，需用户先在测试设置里放开。'
      : '')
    + (scopeSummary?.excludeCount
      ? '；动作限制：已排除 ' + scopeSummary.excludeCount + ' 项地址/网段/路径（摘要见范围）；程序会完整执行排除规则，需要检查时先让用户移除排除项。'
      : '')
    + (Number.isInteger(policy?.requestRatePerMinute) || Number.isInteger(policy?.requestConcurrency)
      ? '；请求节流：'
        + (Number.isInteger(policy.requestRatePerMinute) ? '每分钟最多 ' + policy.requestRatePerMinute + ' 个目标请求' : '')
        + (Number.isInteger(policy.requestRatePerMinute) && Number.isInteger(policy.requestConcurrency) ? '，' : '')
        + (Number.isInteger(policy.requestConcurrency) ? '同时最多 ' + policy.requestConcurrency + ' 个在途' : '')
        + '；程序按这个闸门派发，排队超时会拒绝而不是硬发。'
      : '');
  return base + limits
    + (explain === true ? '；解释测试原理：在结果后解释关键判断，适合学习，不改变结论标准。' : '');
}
export function taskPrompt(state) {
  return taskPromptWithUsage(state, true, false);
}
/** 常驻 runtime-context 快照使用的稳定投影：保留目标/范围/限制，不携带每次变化的用量计数。 */
export function taskPromptStable(state, options = {}) {
  return taskPromptWithUsage(state, false, options.controlledInterface === true, options.selection ?? null);
}
export function taskOverview(store, sessionId) {
  const state = taskPolicyStatus(store, sessionId);
  const context = readTaskContext(store, sessionId);
  const checks = readChecks(store, sessionId);
  const next = state.configured && !state.stopped ? researchNext(store, sessionId) : null;
  const gaps = (context?.checks || []).flatMap(check => {
    const missing = [];
    if (!check.productConfirmed) missing.push('产品待确认');
    if (!check.requestValid) missing.push('请求或身份待确认');
    if (!check.methodReviewed) missing.push('方法待审阅');
    for (const condition of check.conditions || []) if (condition.state === 'unknown') missing.push(condition.name + '未知');
    return missing.length ? [{ id: check.entryId, endpoint: check.endpoint, missing }] : [];
  });
  const receipts = Number(store.db.prepare('SELECT COUNT(*) AS n FROM execution_receipts WHERE session_id=?').get(sessionId)?.n ?? 0);
  const runningWorkers = store.db.prepare('SELECT record FROM site_workers WHERE parent_session=?').all(sessionId)
    .map(row => parseRowRecord(row, { table: 'site_workers', key: 'parent_session', id: sessionId }))
    .filter(row => ['starting', 'running'].includes(row.state)).length;
  const currentPolicy = state.policy ? effectivePolicy(store, state.policy) : null;
  const currentAssets = (context?.assets || []).filter(asset => currentPolicy && taskScopeAllowsAsset(currentPolicy, asset));
  const assetKeys = new Set(currentAssets.map(asset => {
    try {
      const url = new URL(asset.url);
      url.hash = '';
      return url.href;
    } catch { return String(asset.host || asset.ip || asset.id) }
  }));
  return { ...state, next, counts: { assets: assetKeys.size, requests: context?.requests.length || 0,
    methods: context?.methods.length || 0, checks: checks.length, blocked: checks.filter(row => row.status === 'blocked').length,
    notTested: checks.filter(row => row.status === 'not-tested').length, receipts, runningWorkers,
    needsUser: gaps.length + (state.policy?.pendingChange ? 1 : 0) },
  scope: taskScopeSummary(state.policy || {}), pendingChange: state.policy?.pendingChange || null,
  gaps: gaps.slice(0, 20), moreGaps: Math.max(0, gaps.length - 20) };
}
export function taskExecutionGuard(store, sessionId, name, now = Date.now(), { onReserve, baselineRecheck = false, args, reserve = true } = {}) {
  // Visibility restrictions cannot hide agent-scoped tools. Enforce ownership on every dispatch,
  // including PTC's eventual call, before the local-tool fast path. [] means no tools.
  const allowed = childAllowedTools(store, sessionId);
  const permissionName = name === 'recorded-project-execution' ? 'project_request'
    : ['recorded-http-execution', 'recorded-browser-execution', 'redteam_execution', 'saker_browser'].includes(name) ? 'redteam_execution' : name;
  if (allowed !== undefined && (!Array.isArray(allowed) || !allowed.includes(permissionName)))
    return 'worker_tool_not_allowed：当前助手未获准使用 ' + name;
  const earlyPolicy = readTaskPolicy(store, sessionId);
  // A reference fetch is passive unless its concrete URL belongs to the active
  // target scope or an exclusion. If it does, it must pass the same network,
  // stopped-state, scope and exclusion checks as any other target access.
  if (referenceFetchTools.has(name)) {
    const targetsTask = candidateUrlsFromArgs(args)
      .some(raw => taskScopeIncludesUrl(earlyPolicy, raw) || taskScopeExcluded(earlyPolicy, raw));
    if (!targetsTask) return undefined;
  } else if (networkFreeTools.has(name)) {
    // Passive asset-platform queries use their own host/platform permissions and
    // remain available without an active target task or target budget.
    return undefined;
  }
  const isProject = readTaskPolicy(store, sessionId)?.scenario === 'project';
  // 外层只预检；实际派发适配器在建立动作的同一事务领取一次额度。
  if (isProject && (name === 'project_request'
    || (name === 'saker_browser' && projectBrowserTargetActions.has(String(args?.action || '').trim())))) {
    const policy = readTaskPolicy(store, sessionId)
    const action = String(args?.action || '').trim()
    const networkDenial = targetTrafficDenial(policy ? effectivePolicy(store, policy) : policy,
      { method: action === 'open' ? 'GET' : args?.method })
    if (networkDenial) return networkDenial
    return taskExecutionGuard(store, sessionId, 'recorded-project-execution', now, { args, reserve: false });
  }
  // 本地/规划类工具（status/context/research/读写/检索）不占**目标**预算，但也要如实计数：
  // 否则界面会显示"工具调用 0/16"而模型其实已经用了十几次——"分别计量"不等于"不计量"（第 8.2 节）。
  if (localTools.has(name) || (name === 'saker_browser' && !projectBrowserTargetActions.has(String(args?.action || '').trim()))
    || (isProject && projectMetadataTools.has(name)) || offlineToolCall(name, args)) {
    store.db.exec('BEGIN IMMEDIATE');
    try {
      const policy = readTaskPolicy(store, sessionId);
      if (policy?.startedAt) {
        policy.used = { ...policy.used, localToolCalls: (policy.used?.localToolCalls ?? 0) + 1 };
        write(store, sessionId, policy);
      }
      store.db.exec('COMMIT');
    } catch { store.db.exec('ROLLBACK'); }
    return undefined;
  }
  if (retiredTools.has(name)) return 'retired_tool：' + name + ' 已退出运行（方法编排 / 抽象工作台已停用）；改用聊天、测试内容选择、redteam_task / redteam_context / redteam_execution 等当前入口。';
  if (/^(?:subagent(?:_|$)|workflow$|send_message$)/.test(name)) return 'managed_delegation_required：需要独立问题时使用 redteam_task delegate/send；保留父子预算、范围、取消归属和清理。';
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const state = taskPolicyStatus(store, sessionId, now);
    const before = state.policy;
    // 缩范围沿任务树传播（v6 第 8.3 节）：子代理按「子任务 ∩ 父任务」的最紧限制判定，
    // 用户在主任务里关掉网站访问/改成只读后，已经在跑的子代理立刻同样被拦。
    const effective = state.configured ? effectivePolicy(store, state.policy) : state.policy;
    let reason;
      if (!state.configured) reason = 'task_policy_missing：先调用redteam_task设置模式和任务预算，再执行目标操作。';
      else if (state.policy.parentSession && workerReportedFinished(store, sessionId))
        reason = 'worker_reported_finished：子任务已报告结束；只能整理最终回复，不能继续目标操作。';
    else if (state.stopped) reason = '任务已停止：' + state.reason + '；仅继续证据整理与交付，不能重置预算或继续目标操作。';
    else if (isProject && store.db.prepare("SELECT 1 FROM project_actions a JOIN project_runs r ON r.session_id=a.session_id AND r.run_id=a.run_id WHERE a.session_id=? AND r.state IN ('preparing','running','waiting','paused') AND json_extract(a.record,'$.sideEffectUnknown')=1 LIMIT 1").get(sessionId))
      reason = 'project_write_outcome_unknown：原写入结果未知，请先核对原动作，不能继续目标操作。';
    else if (!isProject && state.policy.needsBaselineRecheck && !baselineRecheck) reason = 'baseline_recheck_required：用户已处理阻碍，先用redteam_execution run purpose=baseline复查已存正常GET/HEAD请求，不能直接重试探针。';
    // 动作限制：关闭“允许访问网站”后不再新发任何目标流量（含基线复查、额外助手与恢复任务）。
    // 已存资料、历史回执与报告的读取不受影响。
    const targetTraffic = state.configured && !state.stopped && isTargetTrafficTool(store, sessionId, name, args, effective)
    if (!reason && targetTraffic)
      reason = targetTrafficDenial(effective);
    // 未计量目标流量：已知扫描器，或命令里出现授权范围内 URL 的宿主 shell。
    // 一次工具调用不等于一个目标请求；没有显式额度就不发。
    const unmetered = unmeteredTrafficTools.has(name) || argsHitAuthorizedScope(store, sessionId, name, args, effective);
    if (!reason && state.configured && !state.stopped && !baselineRecheck && unmetered) {
      const allowance = state.policy.budget.unmeteredToolCalls;
      const parent = state.policy.parentSession ? readTaskPolicy(store, state.policy.parentSession) : null;
      if (Number.isInteger(allowance) && (state.policy.used.unmeteredToolCalls ?? 0) >= allowance) reason = 'unmetered_traffic_budget_exhausted：未计量目标流量的显式额度（'
        + allowance + ' 次工具调用）已用完；实际请求数未知，不能按零继续。';
      else if (parent && Number.isInteger(parent.budget.unmeteredToolCalls)
        && (parent.used.unmeteredToolCalls ?? 0) >= parent.budget.unmeteredToolCalls)
        reason = 'unmetered_traffic_budget_exhausted：主任务共享未计量流量额度已用完。';
    }
    if (!reason && targetTraffic && state.configured) {
      const urls = candidateUrlsFromArgs(args);
      for (const raw of urls) {
        let url;
        try { url = new URL(raw); } catch { reason = 'target_scope_unknown：请求地址无法确认'; break; }
        if (!urlIsInTaskScope(effective, url)) { reason = 'target_outside_scope：请求地址不在当前任务授权范围：' + url.origin; break; }
        reason = excludedPathDenial(effective, { url }) || undefined;
        if (reason) break;
      }
      // A scan, browser script or opaque shell can issue more requests than its arguments
      // expose. A call allowance is not proof of read-only behavior or request throttling.
      if (!reason && effective.readOnly === true)
        reason = 'read_only_unverified：此通道无法保证只读，请改用可逐条核对方法的 redteam_execution 请求。';
      if (!reason && (effective.requestRatePerMinute != null || effective.requestConcurrency != null))
        reason = 'request_limits_unverified：此通道无法逐条执行已设置的速率或并发限制，请改用 redteam_execution 请求。';
      if (!reason && !urls.length && effective.excludedPaths?.length)
        reason = 'excluded_paths_unverified：此通道的实际地址未知，无法执行排除路径，请改用 redteam_execution 请求。';
    }
    if (!reason && reserve && state.configured && !state.stopped) {
      const policy = state.policy;
      if (policy.flow?.needsContinuation) policy.flow.needsContinuation = false;
      policy.used.toolCalls++;
      if (unmetered) policy.used.unmeteredToolCalls = (policy.used.unmeteredToolCalls ?? 0) + 1;
      write(store, sessionId, policy);
      if (policy.parentSession) {
        const parent = readTaskPolicy(store, policy.parentSession);
        parent.used.toolCalls++;
        if (unmetered) parent.used.unmeteredToolCalls = (parent.used.unmeteredToolCalls ?? 0) + 1;
        write(store, policy.parentSession, parent);
      }
      if (onReserve) onReserve();
    }
    store.db.exec('COMMIT');
    return reason;
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
}
