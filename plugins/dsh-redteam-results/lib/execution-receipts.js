// Host-captured HTTP executions. A successful exchange is not proof of impact.
import http from 'node:http';
import https from 'node:https';
import { createHash, randomUUID } from 'node:crypto';
import { readTaskContext, saveTaskContext } from './task-context.js';
import { researchDetail, researchNext } from './research.js';
import { taskExecutionGuard, readTaskPolicy, pauseTaskPolicy, acceptBaselineRecheck, targetTrafficDenial, excludedPathDenial, effectivePolicy } from './task-policy.js';
import { writeTaskPolicy, taskEvent } from './task-policy-record.js';
import { moduleGateFor, rootModuleSelection } from './execution-modules.js';
import { sameEndpointPath } from './endpoint-binding.js';
import { acquireTargetSlot } from './request-pacing.js';
import { resolveTaskIdentity, identityDenial, identityRequestHeaders } from './identity-binding.js';
import { taskScopeIncludesUrl } from './task-scope.js';

export const EXECUTION_RECEIPT_SCHEMA = `CREATE TABLE IF NOT EXISTS execution_receipts (
 session_id TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL,
 PRIMARY KEY(session_id,id)
);`;
const digest = value => createHash('sha256').update(value).digest('hex');
// A receipt is current when it still belongs to the same request revision,
// identity and integrity-checked response. Age alone never invalidates it:
// temporary tokens or changed business state must be rejected by the specific
// request/identity/environment checks, not by a blanket timeout.
export function requireFreshExecutions(receipts, referenceTime = Date.now()) {
  if (!Number.isFinite(referenceTime)) throw new Error('invalid verification timestamp');
  for (const receipt of receipts) {
    const completed = Date.parse(receipt.completedAt);
    if (!Number.isFinite(completed) || completed > referenceTime + 60000)
      throw new Error('执行证据时间无效，请核对原始回执。');
    if (receipt.current === false || receipt.integrityValid === false)
      throw new Error('执行证据与当前请求、身份或目标实例不匹配，请在当前条件下重新采集完整对照。');
    if (receipt.complete === false)
      throw new Error('执行证据不完整，请重新采集完整响应。');
  }
}
// 回执绑定用**规范化报文**（wire）计算：宿主回填会把行里的原文规范成同一形式
// （J11c 实测：回填后旧回执曾整体变 stale，受控对照无法评估）。仍保留原文口径
// 作为兼容比对，见 readExecutionReceipt。
const basis = (row, wire = row.request) => digest(JSON.stringify([row.id, row.revision, row.endpoint, row.authContext, wire]));
export const executionMethodBasis = method => {
  const { reviewed, reviewedAt, reviewer, reviewNotes, ...content } = method;
  return digest(JSON.stringify(Object.fromEntries(Object.entries(content).sort(([a], [b]) => a.localeCompare(b)))));
};
/**
 * 已准入、未派发：释放本次预留。只减 toolCalls，不动其它计数、不删历史回执、不清预算。
 * 用于"准入通过后、网络 I/O 前"模块被关闭的竞态窗口。
 */
function releaseExecutionReservation(store, sessionId) {
  const child = readTaskPolicy(store, sessionId);
  for (const id of [sessionId, child?.parentSession].filter(Boolean)) {
    const policy = readTaskPolicy(store, id);
    if (!policy) continue;
    writeTaskPolicy(store, id, { ...policy, used: { ...policy.used, toolCalls: Math.max(0, (policy.used?.toolCalls ?? 0) - 1) } });
  }
}
function requestRow(store, sessionId, id, revision) {
  const context = readTaskContext(store, sessionId);
  const rows = context?.requests.filter(row => row.id === id && row.revision === revision) || [];
  if (rows.length !== 1) throw new Error('one current recorded request revision required');
  const row = rows[0], endpoint = new URL(row.endpoint);
  const policy = readTaskPolicy(store, sessionId);
  const limits = policy ? effectivePolicy(store, policy) : null;
  // Historical inScope flags are display facts, never a grant. Every read and
  // dispatch is checked against the latest user scope, including parent rules.
  if (!limits || !taskScopeIncludesUrl(limits, endpoint))
    throw new Error('recorded request is outside the current task scope；请在当前用户授权范围或明确关联站点内保存请求。');
  if (!context.assets.some(asset => new URL(asset.url).origin === endpoint.origin))
    throw new Error('recorded request has no matching asset：请在 redteam_context 保存该入口资产；reachable 可由实际执行回执补充。');
  return row;
}
function parseRequest(row) {
  const packet = row.request;
  if (typeof packet !== 'string' || Buffer.byteLength(packet) > 65536)
    throw new Error('bounded recorded HTTP request required：request 必须是完整 HTTP/1.1 报文文本（≤64KB）；'
      + '也可以只给 method+endpoint+headers/body，保存上下文时会自动拼成报文。');
  const split = packet.indexOf('\r\n\r\n');
  if (split < 0) throw new Error('recorded request needs CRLF header boundary');
  const lines = packet.slice(0, split).split('\r\n');
  const first = lines.shift().match(/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) (\S+) HTTP\/1\.1$/);
  if (!first) throw new Error('unsupported recorded request line');
  const endpoint = new URL(row.endpoint), target = new URL(first[2], endpoint);
  if (target.origin !== endpoint.origin || target.pathname !== endpoint.pathname || target.hash || target.username || target.password) throw new Error('recorded request crosses selected endpoint');
  const headers = {}, seen = new Set();
  for (const line of lines) {
    const match = line.match(/^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\r\n]*)$/);
    if (!match || /[^\x20-\x7e\t]/.test(match[2])) throw new Error('invalid or non-ASCII recorded header');
    const name = match[1].toLowerCase();
    if (seen.has(name)) throw new Error('duplicate recorded header not supported');
    if (['transfer-encoding', 'upgrade', 'expect', 'trailer'].includes(name)) throw new Error('unsupported recorded transport header');
    http.validateHeaderValue(name, match[2]);
    seen.add(name); headers[name] = match[2];
  }
  if (headers.host?.toLowerCase() !== endpoint.host.toLowerCase()) throw new Error('recorded Host must match authorized endpoint');
  const body = Buffer.from(packet.slice(split + 4));
  if (headers['content-length'] !== undefined && headers['content-length'] !== String(body.length)) throw new Error('recorded content length differs from body bytes');
  if (['GET', 'HEAD'].includes(first[1]) && body.length) throw new Error('GET/HEAD body not supported');
  headers.connection = 'close';
  headers['content-length'] = String(body.length);
  const wireRequest = first[1] + ' ' + target.pathname + target.search + ' HTTP/1.1\r\n'
    + Object.entries(headers).map(([name, value]) => name + ': ' + value).join('\r\n') + '\r\n\r\n' + body.toString();
  return { endpoint, target, method: first[1], headers, body, wireRequest };
}
export function preflightRecordedRequest(store, sessionId, input, { requireMethod = false } = {}) {
  const row = requestRow(store, sessionId, input.requestId, input.requestRevision), parsed = parseRequest(row);
  const policy = readTaskPolicy(store, sessionId);
  const limits = policy ? effectivePolicy(store, policy) : null;
  if (!limits || !taskScopeIncludesUrl(limits, parsed.endpoint)) throw new Error('request is outside the current task scope');
  const pathDenial = excludedPathDenial(limits, { url: parsed.target });
  if (pathDenial) throw new Error(pathDenial);
  const method = readTaskContext(store, sessionId)?.methods.find(item => item.id === input.methodId && item.version === input.methodVersion && item.reviewed === true);
  if (!method && (requireMethod || input.methodId !== undefined || input.methodVersion !== undefined))
    throw new Error('current reviewed method identity and version required：methodId/methodVersion 必须同时指向当前任务上下文 methods[] 里 reviewed:true 的行；'
      + '普通正常/异常对照（run-pair）不要带这两个字段——只有 run-effect / verify-effect 必须绑定已审阅配方。');
  // 内容闸：调用方给出测试内容键时只核对当前任务是否启用；不再绑定方法分类。
  const requirement = { status: 'content', modules: Array.isArray(input.contentKeys) ? input.contentKeys : [] };
  const denial = moduleGateFor(store, sessionId, requirement.modules)();
  if (denial) throw new Error(denial);
  return { row, parsed, method, requirement };
}
function recordedJobDenial(store, sessionId, input, jobStep, direction, row, parsed) {
  if (!jobStep || !/^denied\.[01]$/.test(jobStep.stepKey) || parsed.headers.authorization || parsed.headers.cookie) return false;
  const found = store.db.prepare('SELECT record FROM effect_jobs WHERE session_id=? AND id=?').get(sessionId, jobStep.jobId);
  if (!found) return false;
  const job = JSON.parse(found.record), denied = job.input.roles.denied, owner = job.input.roles.owner;
  return job.state === 'running' && job.directions.anonymous === direction.id
    && denied.requestId === row.id && denied.requestRevision === row.revision
    && owner.requestId === direction.binding.requestId && owner.requestRevision === direction.binding.requestRevision
    && job.input.methodId === input.methodId && job.input.methodVersion === input.methodVersion;
}
function exchange(parsed, timeoutMs, maxBytes, signal) {
  return new Promise(resolve => {
    const chunks = []; let bytes = 0, captured = 0, settled = false, timer, onAbort, responseHead = '', status = null, requestsWritten = 0;
    const finish = (outcome, error = '') => {
      if (settled) return; settled = true; clearTimeout(timer); if (onAbort) signal?.removeEventListener('abort', onAbort);
      const body = Buffer.concat(chunks);
      resolve({ outcome, error, status, requestsWritten, responseHead, responseBodyBase64: body.toString('base64'),
        responseBytes: bytes, capturedBytes: body.length, responseSha256: digest(Buffer.concat([Buffer.from(responseHead), body])) });
    };
    const transport = parsed.endpoint.protocol === 'https:' ? https : http;
    const req = transport.request(parsed.target, { method: parsed.method, headers: parsed.headers, agent: false }, res => {
      status = res.statusCode;
      responseHead = 'HTTP/' + res.httpVersion + ' ' + status + ' ' + res.statusMessage + '\r\n'
        + Array.from({ length: res.rawHeaders.length / 2 }, (_, i) => res.rawHeaders[i * 2] + ': ' + res.rawHeaders[i * 2 + 1]).join('\r\n') + '\r\n\r\n';
      res.on('data', chunk => {
        bytes += chunk.length;
        const remaining = Math.max(0, maxBytes - captured);
        if (remaining) { const part = chunk.subarray(0, remaining); chunks.push(part); captured += part.length; }
        if (bytes > maxBytes) { finish('response-limit', 'response exceeded capture limit'); res.destroy(); req.destroy(); }
      });
      res.on('end', () => finish(status >= 300 && status < 400 ? 'redirect-not-followed' : 'response'));
      res.on('error', error => finish('transport-error', error.code || 'response-error'));
      res.on('aborted', () => finish('transport-error', 'response-aborted'));
    });
    req.on('error', error => finish('transport-error', error.code || 'request-error'));
    req.on('finish', () => { requestsWritten = 1; });
    timer = setTimeout(() => { finish('timeout', 'execution deadline exceeded'); req.destroy(); }, timeoutMs);
    onAbort = () => { finish('interrupted', 'task cancelled during execution; outcome unknown'); req.destroy(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    req.end(parsed.body);
  });
}
export async function executeRecordedRequest(store, sessionId, input, jobStep, signal) {
  signal?.throwIfAborted();
  const timeoutMs = input.timeoutMs ?? 5000, maxBytes = input.maxBytes ?? 65536;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000 || !Number.isInteger(maxBytes) || maxBytes < 64 || maxBytes > 65536) throw new Error('invalid bounded execution limits');
  const row = requestRow(store, sessionId, input.requestId, input.requestRevision);
  const parsed = parseRequest(row);
  const task = readTaskPolicy(store, sessionId);
  // 缩范围沿任务树传播（v6 第 8.3 节）：子代理发请求前读的是「子任务 ∩ 父任务」的最紧限制，
  // 主任务中途关掉网站访问或加排除路径，已经在跑的子代理同样立即生效。
  const limits = task ? effectivePolicy(store, task) : task;
  // 动作限制的适配器侧强制（第 4.3 节）：是否访问网站、是否禁止改动业务数据。
  // 放在发请求之前，与工具闸互为双保险；拒绝时不占用预算、不发出任何请求。
  const limitDenial = targetTrafficDenial(limits, { method: parsed.method });
  if (limitDenial) throw new Error(limitDenial);
  // 排除路径同样在发请求前强制：命中就不派发、不占预算。
  const pathDenial = excludedPathDenial(limits, { url: parsed.target });
  if (pathDenial) throw new Error(pathDenial);
  // 身份需求（第 5.5/8.1 节）：已失效/待确认的账号不会被当成有效；
  // 有效账号另存的秘密只在请求自己没带 Cookie/Authorization 时套上去，秘密不进回执。
  const identity = resolveTaskIdentity(store, sessionId, row.authContext);
  const identityReason = identityDenial(identity);
  if (identityReason) throw new Error(identityReason);
  const identityHeaders = identityRequestHeaders(parsed, identity);
  const identitySecretApplied = identityHeaders ? identityHeaders.kind : null;
  // 派发用带上秘密的头；回执仍记请求原文，秘密不进回执。
  const outgoing = identityHeaders ? { ...parsed, headers: identityHeaders.headers } : parsed;
  const recheck = input.purpose === 'baseline' && task?.needsBaselineRecheck === true;
  const firstContact = input.purpose === 'first-contact';
  const exploration = firstContact || (!recheck && (typeof input.hypothesisId !== 'string' || !input.hypothesisId.trim()));
  if (input.purpose !== undefined && !recheck && !firstContact) throw new Error('baseline recheck is only available after user resolution');
  if (recheck && (!['GET', 'HEAD'].includes(parsed.method) || row.valid !== true || !/^HTTP\/\S+\s+2\d\d\b/i.test(row.response || ''))) throw new Error('recorded normal GET/HEAD baseline required');
  if (firstContact) {
    // 首次接触（用例 J7 实测的死锁）：run 要 hypothesis、research create 要 valid 基线，而基线又只能靠 run 拿到。
    // 任务里还**一个 valid 基线都没有**时，允许对"已存 + inScope+reachable"的 GET/HEAD 发一次真实请求，拿回执后再标 valid。
    if (jobStep) throw new Error('first contact cannot run inside an effect job');
  }
  const direction = recheck ? { id: 'baseline-recheck', binding: { endpoint: row.endpoint, authContext: row.authContext } }
    : exploration ? { id: 'exploration', binding: { endpoint: row.endpoint, authContext: row.authContext } }
      : researchDetail(store, sessionId, input.hypothesisId);
  if (!recheck && !exploration && (!direction.current || !['active', 'supported'].includes(direction.state) || researchNext(store, sessionId).id !== direction.id))
    throw new Error('execution requires the current active direction'
      + (direction.blockedReason ? '：' + direction.blockedReason + '（方向被阻断时不要改写基线掩盖它；按提示处理或新建研究方向）' : ''));
  if (!task || !taskScopeIncludesUrl(limits, parsed.endpoint)) throw new Error('request is outside the current task scope');
  if (!sameEndpointPath(row.endpoint, direction.binding.endpoint) || (row.authContext !== direction.binding.authContext
    && !recordedJobDenial(store, sessionId, input, jobStep, direction, row, parsed)))
    throw new Error('recorded request must stay on the same endpoint path and identity（查询参数可变；路径、来源与身份不能变）：'
      + '方向基线 ' + direction.binding.endpoint + '，本次请求 ' + row.endpoint + '，身份 ' + row.authContext + ' vs ' + direction.binding.authContext);
  let selectedMethod;
  if (input.methodId !== undefined || input.methodVersion !== undefined) {
    selectedMethod = readTaskContext(store, sessionId)?.methods.find(method => method.id === input.methodId && method.version === input.methodVersion && method.reviewed === true);
    if (!selectedMethod) throw new Error('current reviewed method identity and version required');
  }
  // 内容闸：全不选时任何新的目标操作都被拒绝，包括用户处理阻碍后的 baseline 复查；
  // 已存资料、历史回执的读取不受影响。调用方给出 contentKeys 时只核对是否启用该项。
  const requiredContent = Array.isArray(input.contentKeys) ? input.contentKeys : [];
  const requirement = { status: 'content', modules: requiredContent };
  const moduleCheck = moduleGateFor(store, sessionId, requiredContent);
  const denied = taskExecutionGuard(store, sessionId, 'recorded-http-execution', Date.now(), { baselineRecheck: recheck, ...(jobStep ? { onReserve: () => {
    store.db.prepare('INSERT INTO effect_job_steps (session_id,job_id,step_key,state) VALUES (?,?,?,?)').run(sessionId, jobStep.jobId, jobStep.stepKey, 'inflight');
  } } : {}), moduleCheck });
  if (denied) throw new Error(denied);
  // 网络 I/O 前的最终核对（此刻不持有任何事务）。已准入、未派发：拒绝时释放本次预留，绝不发出请求。
  const late = moduleCheck();
  if (late) { releaseExecutionReservation(store, sessionId); throw new Error(late + '（已准入、未派发；没有发出请求）'); }
  const modulePolicy = recheck ? null : (() => { const { selection } = rootModuleSelection(store, sessionId);
    return { modulesRev: selection.rev, policyRev: selection.policyRev, active: selection.active }; })();
  const startedAt = new Date().toISOString(), started = performance.now();
  // 请求节流（PLAN 5.5）：先在每会话闸门里排队，拿到名额才真的发请求；释放放在 finally。
  const releaseSlot = await acquireTargetSlot(sessionId, limits, signal);
  let result;
  try {
    // Scope can change while this request waits for a pacing slot. Re-read the
    // latest parent/child policy immediately before I/O; a denial releases the
    // reservation and never reaches the wire.
    const latestTask = readTaskPolicy(store, sessionId);
    const latestLimits = latestTask ? effectivePolicy(store, latestTask) : latestTask;
    const lateDenial = targetTrafficDenial(latestLimits, { method: parsed.method })
      || excludedPathDenial(latestLimits, { url: parsed.target })
      || (!latestLimits || !taskScopeIncludesUrl(latestLimits, parsed.endpoint)
        ? 'request is outside the current task scope（已准入、未派发；没有发出请求）' : undefined);
    if (lateDenial) {
      releaseExecutionReservation(store, sessionId);
      throw new Error(lateDenial);
    }
    result = await exchange(outgoing, timeoutMs, maxBytes, signal);
  }
  finally { releaseSlot(); }
  const record = { id: 'execution-' + randomUUID(), source: 'host-http-execution', hypothesisId: direction.id,
    requestId: row.id, requestRevision: row.revision, endpoint: row.endpoint, authContext: row.authContext,
    ...(typeof input.callId === 'string' && input.callId ? { callId: input.callId } : {}),
    ...(identity?.matched ? { identity: { name: identity.name, status: identity.status } } : {}),
    ...(identitySecretApplied ? { identitySecretApplied } : {}),
    ...(selectedMethod ? { methodId: selectedMethod.id, methodVersion: selectedMethod.version, methodBasis: executionMethodBasis(selectedMethod) } : {}),
    ...(requirement.modules.length ? { contentRequirement: requirement.modules } : {}),
    ...(modulePolicy ? { modulePolicy } : {}),
    requestBasis: basis(row, parsed.wireRequest), startedAt, completedAt: new Date().toISOString(), elapsedMs: Math.ceil(performance.now() - started),
    requestAttempts: 1, redirectFollowed: false, request: parsed.wireRequest, requestSha256: digest(parsed.wireRequest), ...result,
    impactVerified: false, evidenceLimit: 'Host captured execution only; recorded identity labels and impact still require independent verification.' };
  store.db.exec('BEGIN IMMEDIATE');
  try {
    store.db.prepare('INSERT INTO execution_receipts (session_id,id,record) VALUES (?,?,?)').run(sessionId, record.id, JSON.stringify(record));
    // 同事务写一条带 executionId 的任务事件（v6 第 9.3 节）：事件流能直接指回这次执行回执，
    // 而不是只看到"任务状态变了"却找不到对应执行。
    taskEvent(store, sessionId, readTaskPolicy(store, sessionId)?.policyRev ?? 0, 'execution-recorded',
      { executionId: record.id, workId: sessionId, endpoint: record.endpoint, status: record.status, outcome: record.outcome });
    if (jobStep) store.db.prepare('UPDATE effect_job_steps SET state=?,receipt_id=? WHERE session_id=? AND job_id=? AND step_key=?').run('captured', record.id, sessionId, jobStep.jobId, jobStep.stepKey);
    store.db.exec('COMMIT');
  } catch (error) { store.db.exec('ROLLBACK'); throw error; }
  const body = Buffer.from(record.responseBodyBase64, 'base64').toString('utf8').slice(0, 8192);
  const explicitIpBlock = [403, 429, 503].includes(record.status)
    && /(?:\bip(?: address)?\b[^\n]{0,100}\b(?:blocked|banned|denied)|\b(?:blocked|banned)\b[^\n]{0,100}\bip(?: address)?\b|IP[^\n]{0,60}(?:封禁|封锁|被封))/i.test(body);
  const normalControl = recheck || (jobStep && /^(?:owner|normal)\.[01]$/.test(jobStep.stepKey));
  let code = explicitIpBlock ? 'ip-blocked' : record.status === 429 ? 'normal-access-failed'
    : normalControl && [401, 403].includes(record.status) ? 'login-expired'
      : normalControl && (record.outcome === 'timeout' || record.outcome === 'transport-error' || record.status >= 500) ? 'service-unavailable' : '';
  if (code) {
    const blocker = { code, reason: explicitIpBlock ? '目标明确返回IP访问阻断；停止请求，不自动绕行' : '访问限流或正常对照失效；停止并核对访问状态',
      evidence: sessionId + ':' + record.id + '; HTTP=' + record.status + '; outcome=' + record.outcome };
    pauseTaskPolicy(store, sessionId, blocker, 'host-captured-http');
    // 父停止、缩范围、身份失效和额度变化沿任务树传播（v6 第 8.3 节）。
    // login-expired 也要上抛：账号失效会让依赖该身份的子任务全部停摆，父任务必须知道。
    if (task?.parentSession && ['ip-blocked', 'normal-access-failed', 'login-expired'].includes(code)) pauseTaskPolicy(store, task.parentSession, blocker, 'host-captured-child-http');
  }
  if (recheck && !code && record.outcome === 'response' && record.status >= 200 && record.status < 300) {
    const previousType = /^content-type:\s*([^;\r\n]+)/im.exec(row.response)?.[1]?.toLowerCase();
    const currentType = /^content-type:\s*([^;\r\n]+)/im.exec(record.responseHead)?.[1]?.toLowerCase();
    if (previousType && currentType !== previousType) {
      code = 'normal-access-failed';
      pauseTaskPolicy(store, sessionId, { code, reason: '正常响应类型发生变化，不能确认访问已恢复', evidence: sessionId + ':' + record.id }, 'host-captured-http');
    }
    else acceptBaselineRecheck(store, sessionId, record.id);
  }
  return { ...executionReceiptSummary(record), ...(code ? { taskPaused: true, blocker: code } : {}) };
}

/**
 * Direct exploratory request. The adapter first stores the entry as a real task asset/request,
 * then reuses the same scope, identity, pacing, read-only and guard path as recorded executions.
 */
export async function executeDirectRequest(store, sessionId, input, signal) {
  const method = String(input?.method || 'GET').toUpperCase()
  if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method)) throw new Error('unsupported direct request method')
  let endpoint
  try { endpoint = new URL(String(input?.url || '')) } catch { throw new Error('direct request requires a complete HTTP(S) URL') }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) throw new Error('direct request requires a plain HTTP(S) URL')
  endpoint.hash = ''
  const policy = readTaskPolicy(store, sessionId)
  if (!policy) throw new Error('start a task before sending a direct request')
  const limits = effectivePolicy(store, policy)
  if (!taskScopeIncludesUrl(limits, endpoint)) throw new Error('direct request is outside the current task scope')
  const directExclusion = excludedPathDenial(limits, { url: endpoint })
  if (directExclusion) throw new Error(directExclusion)
  const headers = {}
  const supplied = input?.headers && typeof input.headers === 'object' && !Array.isArray(input.headers) ? input.headers : {}
  for (const [name, value] of Object.entries(supplied)) {
    if (!/^[A-Za-z0-9-]+$/.test(name)) throw new Error('invalid direct request header name')
    headers[name] = String(value).replace(/[\r\n]+/g, ' ')
  }
  const body = input?.body === undefined ? '' : String(input.body)
  if (body && ['GET', 'HEAD'].includes(method)) throw new Error('GET/HEAD direct requests cannot include a body')
  const current = readTaskContext(store, sessionId) || { assets: [], checks: [], requests: [], methods: [], maxSupplementAttempts: 2 }
  const assetId = 'asset-direct-' + digest(endpoint.origin).slice(0, 16)
  const requestId = 'request-direct-' + randomUUID()
  const requestRevision = 'r-' + digest(JSON.stringify([method, endpoint.href, headers, body, Date.now(), randomUUID()])).slice(0, 16)
  const asset = current.assets.find(row => row.id === assetId) || {
    id: assetId,
    url: endpoint.origin,
    reachable: false,
    source: String(input?.source || 'direct exploratory request'),
    firstSeen: new Date().toISOString(),
  }
  const request = {
    id: requestId,
    revision: requestRevision,
    endpoint: endpoint.href,
    authContext: String(input?.identityRef || input?.authContext || 'default'),
    method,
    headers,
    body,
    source: String(input?.source || 'direct exploratory request'),
  }
  saveTaskContext(store, sessionId, {
    ...current,
    assets: [...current.assets.filter(row => row.id !== assetId), asset],
    requests: [...current.requests.filter(row => !(row.id === requestId && row.revision === requestRevision)), request],
  })
  const receipt = await executeRecordedRequest(store, sessionId, {
    requestId,
    requestRevision,
    timeoutMs: input?.timeoutMs,
    maxBytes: input?.maxBytes,
    callId: input?.callId,
  }, undefined, signal)
  const after = readTaskContext(store, sessionId) || current
  const observed = ['response', 'redirect-not-followed'].includes(receipt.outcome)
  saveTaskContext(store, sessionId, {
    ...after,
    assets: after.assets.map(row => row.id === assetId ? { ...row, reachable: row.reachable === true || observed } : row),
    requests: after.requests.map(row => row.id === requestId && row.revision === requestRevision && observed
      ? { ...row, valid: true, responseReceiptId: receipt.id }
      : row),
  })
  return {
    ...receipt,
    requestId,
    requestRevision,
    taskRecorded: true,
    evidenceLimit: 'Request and response were captured automatically. Status/body alone do not prove vulnerability impact.',
  }
}
export function readExecutionReceipt(store, sessionId, id) {
  const record = store.db.prepare('SELECT record FROM execution_receipts WHERE session_id=? AND id=?').get(sessionId, id);
  if (!record) throw new Error('execution receipt not found in current session');
  const result = JSON.parse(record.record);
  let current = false, integrityValid = false, currentReason = '';
  try {
    // Validate saved bytes before exposing them as evidence. A digest detects
    // damaged/replaced content; it does not authenticate a rewritten database.
    if (typeof result.request !== 'string' || typeof result.responseHead !== 'string'
      || typeof result.responseBodyBase64 !== 'string') throw new Error('receipt original bytes missing');
    const body = Buffer.from(result.responseBodyBase64, 'base64');
    if (body.toString('base64') !== result.responseBodyBase64
      || digest(result.request) !== result.requestSha256
      || digest(Buffer.concat([Buffer.from(result.responseHead), body])) !== result.responseSha256)
      throw new Error('receipt original bytes failed integrity validation');
    const status = /^HTTP\/\S+ (\d{3})\b/.exec(result.responseHead);
    if ((status ? Number(status[1]) : null) !== result.status
      || result.capturedBytes !== body.length || !Number.isSafeInteger(result.responseBytes)
      || result.responseBytes < body.length) throw new Error('receipt metadata differs from captured bytes');
    integrityValid = true;
    if (result.source === 'host-project-http-execution') {
      // 项目回执不绑定实战研究方向；按自身 run/check 与请求原文核对是否仍匹配。
      current = digest(JSON.stringify(['project', result.projectRunId, result.projectCheckId, result.request])) === result.requestBasis;
      if (!current) currentReason = 'project receipt basis changed';
    } else {
      const currentRow = requestRow(store, sessionId, result.requestId, result.requestRevision);
      let canonical = '';
      try { canonical = parseRequest(currentRow).wireRequest; } catch { canonical = ''; }
      // 新口径：按规范化报文比对（格式差异不算改动，内容/路径/身份变了仍会失效）；
      // 旧口径：行原文直接比对，兼容本改动之前写入的回执。
      current = (canonical !== '' && basis(currentRow, canonical) === result.requestBasis) || basis(currentRow) === result.requestBasis;
      if (!current) currentReason = 'receipt request revision changed';
    }
  } catch (error) { currentReason = error.message; /* Historical bytes remain readable, never silently repaired. */ }
  return { ...result, current, integrityValid, currentReason };
}
export function executionReceiptSummary(record) {
  const { request, responseHead, responseBodyBase64, requestBasis, ...summary } = record;
  return { ...summary,
    ...(record.identitySecretApplied ? { note: '本次派发按身份“' + (record.identity?.name || '') + '”另存的秘密补了 '
      + record.identitySecretApplied + ' 认证头；回执里的请求原文不含秘密。' } : {}),
    detail: 'redteam_execution action=detail id=' + record.id };
}
