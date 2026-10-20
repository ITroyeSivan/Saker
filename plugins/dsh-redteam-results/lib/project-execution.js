// W04：项目场景的 HTTP 派发适配。复用公共范围、身份、节流和原文保存，
// 但不套实战的研究方向、同端点路径与方法版本前置。
import http from 'node:http';
import https from 'node:https';
import { createHash, randomUUID } from 'node:crypto';
import { readTaskPolicy, effectivePolicy, targetTrafficDenial, excludedPathDenial, taskExecutionGuard } from './task-policy.js';
import { resolveTaskIdentity, identityDenial, identityRequestHeaders } from './identity-binding.js';
import { acquireTargetSlot } from './request-pacing.js';
import { beginProjectAction, finishProjectAction, readProjectRun, readProjectCheck } from './project-store.js';

const digest = value => createHash('sha256').update(value).digest('hex');

function parseTarget(input) {
  let url;
  try { url = new URL(String(input?.url || '')); } catch { throw new Error('项目请求需要有效的 HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('项目请求只接受 HTTP(S) URL');
  if (url.username || url.password) throw new Error('项目请求 URL 不能内嵌凭据');
  return url;
}

function wireRequest(method, url, headers, body) {
  const lines = [method + ' ' + (url.pathname + url.search || '/') + ' HTTP/1.1', 'Host: ' + url.host];
  for (const [name, value] of Object.entries(headers || {})) lines.push(name + ': ' + value);
  return lines.join('\r\n') + '\r\n\r\n' + (body || '');
}

function dispatch(url, method, headers, body, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const startedAt = Date.now();
    const request = transport.request({
      protocol: url.protocol, hostname: url.hostname, port: url.port || undefined,
      path: url.pathname + url.search, method, headers, timeout: timeoutMs,
    }, response => {
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; if (bytes <= 65536) chunks.push(chunk); });
      response.on('end', () => resolve({
        outcome: 'response', status: response.statusCode,
        headers: { ...response.headers },
        responseHead: 'HTTP/' + response.httpVersion + ' ' + response.statusCode + ' ' + (response.statusMessage || '') + '\r\n'
          + Object.entries(response.headers).map(([name, value]) => name + ': ' + (Array.isArray(value) ? value.join(', ') : value)).join('\r\n') + '\r\n\r\n',
        body: Buffer.concat(chunks), elapsedMs: Date.now() - startedAt, truncated: bytes > 65536,
      }));
    });
    const onAbort = () => request.destroy(new Error('项目动作已取消'));
    if (signal) { if (signal.aborted) { onAbort(); return; } signal.addEventListener('abort', onAbort, { once: true }); }
    request.once('close', () => signal?.removeEventListener('abort', onAbort));
    request.on('timeout', () => request.destroy(new Error('项目请求超时')));
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

export async function executeProjectHttp(store, sessionId, runId, checkId, input = {}, signal) {
  if (signal?.aborted) throw new Error('项目动作已取消');
  const run = readProjectRun(store, sessionId, runId);
  if (!run) throw new Error('project run not found');
  if (run.state !== 'running') throw Object.assign(new Error('项目运行当前不可派发新动作'), { code: 'project-state-conflict' });
  const check = readProjectCheck(store, sessionId, runId, checkId);
  if (!check) throw new Error('project check not found');
  const policy = readTaskPolicy(store, sessionId);
  if (!policy) throw new Error('project task policy missing');
  const limits = effectivePolicy(store, policy);
  const url = parseTarget(input);
  const method = String(input.method || 'GET').toUpperCase();
  const denial = targetTrafficDenial(limits, { method }) || excludedPathDenial(limits, { url: url.href });
  if (denial) throw new Error(denial);
  if (limits.target) {
    let allowed;
    try { allowed = new URL(limits.target).origin; } catch { allowed = ''; }
    if (allowed && allowed !== url.origin) throw new Error('request is outside the current task site');
  }
  const authContext = String(input.authContext || '');
  const identity = resolveTaskIdentity(store, sessionId, authContext);
  const identityReason = identityDenial(identity);
  if (identityReason) throw new Error(identityReason);
  const headers = { ...(input.headers || {}) };
  const identityHeaders = identityRequestHeaders({ headers }, identity);
  const outgoingHeaders = identityHeaders ? identityHeaders.headers : headers;
  const body = input.body === undefined || input.body === null ? '' : String(input.body);
  let begun;
  const admission = taskExecutionGuard(store, sessionId, 'recorded-project-execution', Date.now(), {
    args: { method, url: url.href },
    onReserve: () => { begun = beginProjectAction(store, sessionId, runId, checkId, { identityRef: authContext, controlRev: input.controlRev }); },
  });
  if (admission) throw new Error(admission);
  const release = await acquireTargetSlot(sessionId, limits, signal);
  let result;
  try {
    result = await dispatch(url, method, outgoingHeaders, body, input.timeoutMs ?? 10000, signal);
  } catch (error) {
    const sideEffectUnknown = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    await finishProjectAction(store, sessionId, runId, begun.action.actionId, {
      executionState: sideEffectUnknown ? 'unknown' : 'failed', error: String(error?.message || error), sideEffectUnknown,
    });
    throw error;
  } finally {
    release();
  }
  const requestWire = wireRequest(method, url, headers, body);
  const record = {
    id: 'execution-' + randomUUID(),
    source: 'host-project-http-execution',
    projectRunId: runId, projectCheckId: checkId, actionId: begun.action.actionId,
    endpoint: url.origin, authContext, method, url: url.href,
    request: requestWire, requestSha256: digest(requestWire),
    responseHead: result.responseHead, responseBodyBase64: result.body.toString('base64'),
    responseSha256: digest(Buffer.concat([Buffer.from(result.responseHead), result.body])),
    status: result.status, outcome: result.outcome, capturedBytes: result.body.length, responseBytes: result.body.length,
    complete: !result.truncated, startedAt: begun.action.startedAt, completedAt: new Date().toISOString(),
    elapsedMs: result.elapsedMs, requestAttempts: 1,
    requestBasis: digest(JSON.stringify(['project', runId, checkId, requestWire])),
  };
  store.db.prepare('INSERT INTO execution_receipts (session_id,id,record) VALUES (?,?,?)').run(sessionId, record.id, JSON.stringify(record));
  await finishProjectAction(store, sessionId, runId, begun.action.actionId, { executionState: 'completed', requestRef: record.id });
  const contentType = String(result.headers?.['content-type'] || '');
  const textual = !contentType || /(?:text\/|json|xml|javascript|x-www-form-urlencoded|svg)/i.test(contentType);
  const bodyText = textual ? result.body.toString('utf8') : '[二进制响应 ' + result.body.length + ' 字节]';
  const bodyPreview = bodyText.slice(0, 2000);
  const businessHeaders = ['content-type', 'location', 'content-language']
    .filter(name => result.headers?.[name] !== undefined)
    .map(name => name + ': ' + result.headers[name]);
  return {
    ok: true, actionId: begun.action.actionId, checkId, executionId: record.id,
    status: record.status,
    summary: method + ' ' + url.href + ' → ' + record.status
      + (businessHeaders.length ? '\n' + businessHeaders.join('\n') : '')
      + '\n响应正文' + (result.truncated ? '（前 65536 字节）' : '') + '：' + bodyPreview
      + (bodyText.length > bodyPreview.length ? '\n…正文已截断，共捕获 ' + result.body.length + ' 字节' : '')
      + '\nexecutionId=' + record.id,
    evidenceRefs: [record.id],
  };
}
