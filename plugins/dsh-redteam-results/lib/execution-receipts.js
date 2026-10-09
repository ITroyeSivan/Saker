// Host-captured HTTP executions. A successful exchange is not proof of impact.
import http from 'node:http';
import https from 'node:https';
import { createHash, randomUUID } from 'node:crypto';
import { readTaskContext } from './task-context.js';
import { researchDetail, researchNext } from './research.js';
import { taskExecutionGuard, readTaskPolicy, pauseTaskPolicy, acceptBaselineRecheck } from './task-policy.js';

export const EXECUTION_RECEIPT_SCHEMA = `CREATE TABLE IF NOT EXISTS execution_receipts (
 session_id TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL,
 PRIMARY KEY(session_id,id)
);`;
const digest = value => createHash('sha256').update(value).digest('hex');
const basis = row => digest(JSON.stringify([row.id, row.revision, row.endpoint, row.authContext, row.request]));
export const executionMethodBasis = method => {
  const { reviewed, reviewedAt, reviewer, reviewNotes, ...content } = method;
  return digest(JSON.stringify(Object.fromEntries(Object.entries(content).sort(([a], [b]) => a.localeCompare(b)))));
};
function requestRow(store, sessionId, id, revision) {
  const context = readTaskContext(store, sessionId);
  const rows = context?.requests.filter(row => row.id === id && row.revision === revision) || [];
  if (rows.length !== 1) throw new Error('one current recorded request revision required');
  const row = rows[0], endpoint = new URL(row.endpoint);
  if (!context.assets.some(asset => asset.inScope === true && asset.reachable === true && new URL(asset.url).origin === endpoint.origin)) throw new Error('recorded request has no reachable authorized asset');
  return row;
}
function parseRequest(row) {
  const packet = row.request;
  if (typeof packet !== 'string' || Buffer.byteLength(packet) > 65536) throw new Error('bounded recorded HTTP request required');
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
export function preflightRecordedRequest(store, sessionId, input, { requireMethod = true } = {}) {
  const row = requestRow(store, sessionId, input.requestId, input.requestRevision), parsed = parseRequest(row);
  const policy = readTaskPolicy(store, sessionId);
  if (policy?.target && new URL(policy.target).origin !== parsed.endpoint.origin) throw new Error('request is outside the current task site');
  const method = readTaskContext(store, sessionId)?.methods.find(item => item.id === input.methodId && item.version === input.methodVersion && item.reviewed === true);
  if (!method && (requireMethod || input.methodId !== undefined || input.methodVersion !== undefined)) throw new Error('current reviewed method identity and version required');
  return { row, parsed, method };
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
  const recheck = input.purpose === 'baseline' && task?.needsBaselineRecheck === true;
  if (input.purpose !== undefined && !recheck) throw new Error('baseline recheck is only available after user resolution');
  if (recheck && (!['GET', 'HEAD'].includes(parsed.method) || row.valid !== true || !/^HTTP\/\S+\s+2\d\d\b/i.test(row.response || ''))) throw new Error('recorded normal GET/HEAD baseline required');
  const direction = recheck ? { id: 'baseline-recheck', binding: { endpoint: row.endpoint, authContext: row.authContext } } : researchDetail(store, sessionId, input.hypothesisId);
  if (!recheck && (!direction.current || !['active', 'supported'].includes(direction.state) || researchNext(store, sessionId).id !== direction.id)) throw new Error('execution requires the current active direction');
  if (task?.target && new URL(task.target).origin !== parsed.endpoint.origin) throw new Error('request is outside the current task site');
  if (row.endpoint !== direction.binding.endpoint || (row.authContext !== direction.binding.authContext
    && !recordedJobDenial(store, sessionId, input, jobStep, direction, row, parsed))) throw new Error('recorded request must match direction endpoint and identity');
  let selectedMethod;
  if (input.methodId !== undefined || input.methodVersion !== undefined) {
    selectedMethod = readTaskContext(store, sessionId)?.methods.find(method => method.id === input.methodId && method.version === input.methodVersion && method.reviewed === true);
    if (!selectedMethod) throw new Error('current reviewed method identity and version required');
  }
  const denied = taskExecutionGuard(store, sessionId, 'recorded-http-execution', Date.now(), { baselineRecheck: recheck, ...(jobStep ? { onReserve: () => {
    store.db.prepare('INSERT INTO effect_job_steps (session_id,job_id,step_key,state) VALUES (?,?,?,?)').run(sessionId, jobStep.jobId, jobStep.stepKey, 'inflight');
  } } : {}) });
  if (denied) throw new Error(denied);
  const startedAt = new Date().toISOString(), started = performance.now();
  const result = await exchange(parsed, timeoutMs, maxBytes, signal);
  const record = { id: 'execution-' + randomUUID(), source: 'host-http-execution', hypothesisId: direction.id,
    requestId: row.id, requestRevision: row.revision, endpoint: row.endpoint, authContext: row.authContext,
    ...(selectedMethod ? { methodId: selectedMethod.id, methodVersion: selectedMethod.version, methodBasis: executionMethodBasis(selectedMethod) } : {}),
    requestBasis: basis(row), startedAt, completedAt: new Date().toISOString(), elapsedMs: Math.ceil(performance.now() - started),
    requestAttempts: 1, redirectFollowed: false, request: parsed.wireRequest, requestSha256: digest(parsed.wireRequest), ...result,
    impactVerified: false, evidenceLimit: 'Host captured execution only; recorded identity labels and impact still require independent verification.' };
  store.db.exec('BEGIN IMMEDIATE');
  try {
    store.db.prepare('INSERT INTO execution_receipts (session_id,id,record) VALUES (?,?,?)').run(sessionId, record.id, JSON.stringify(record));
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
    if (task?.parentSession && ['ip-blocked', 'normal-access-failed'].includes(code)) pauseTaskPolicy(store, task.parentSession, blocker, 'host-captured-child-http');
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
    current = basis(requestRow(store, sessionId, result.requestId, result.requestRevision)) === result.requestBasis;
    if (!current) currentReason = 'receipt request revision changed';
  } catch (error) { currentReason = error.message; /* Historical bytes remain readable, never silently repaired. */ }
  return { ...result, current, integrityValid, currentReason };
}
export function executionReceiptSummary(record) {
  const { request, responseHead, responseBodyBase64, requestBasis, ...summary } = record;
  return { ...summary, detail: 'redteam_execution action=detail id=' + record.id };
}
