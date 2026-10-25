// W04：项目场景的 HTTP 派发适配。复用公共范围、身份、节流和原文保存，
// 但不套实战的研究方向、同端点路径与方法版本前置。
import http from 'node:http';
import https from 'node:https';
import { createHash, randomUUID } from 'node:crypto';
import { readTaskPolicy, effectivePolicy, targetTrafficDenial, excludedPathDenial, taskExecutionGuard } from './task-policy.js';
import { resolveTaskIdentity, identityDenial, identityRequestHeaders, taskIdentityRevision as identityRevision } from './identity-binding.js';
import { acquireTargetSlot } from './request-pacing.js';
import { beginProjectAction, markProjectActionDispatched, finishProjectAction, readProjectRun, readProjectCheck } from './project-store.js';
import { redactHeaders, redactText } from './redaction.js';
import { readTaskContext } from './task-context.js';
import { responseBodyText } from './response-body.js';
import { taskScopeIncludesUrl } from './task-scope.js';

const digest = value => createHash('sha256').update(value).digest('hex');

function parseTarget(input) {
  let url;
  try { url = new URL(String(input?.url || '')); } catch { throw new Error('项目请求需要有效的 HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('项目请求只接受 HTTP(S) URL');
  if (url.username || url.password) throw new Error('项目请求 URL 不能内嵌凭据');
  return url;
}

function targetScopeDenial(store, sessionId, limits, url) {
  return !taskScopeIncludesUrl(limits, url)
    ? 'request is outside the current task site or user-allowed associated sites' : undefined;
}

function associatedIdentityDenial(store, sessionId, limits, url, authContext) {
  if (!authContext) return undefined;
  let primary = '';
  try { primary = new URL(limits.primaryTarget).origin; } catch { primary = ''; }
  if (primary && url.origin === primary) return undefined;
  const asset = (readTaskContext(store, sessionId)?.assets || []).find(item => {
    try { return item.inScope === true && item.reachable === true && new URL(item.url).origin === url.origin; } catch { return false; }
  });
  const bound = String(asset?.authContext || asset?.identityRef || '');
  return bound && bound === authContext ? undefined : 'associated API identity is not explicitly bound to this authContext';
}

function requestFingerprint(limits, method, url, authContext, identity, body) {
  return digest(JSON.stringify({
    target: String(limits?.target || ''),
    allowTargetNetwork: limits?.allowTargetNetwork !== false,
    readOnly: limits?.readOnly === true,
    excludedPaths: [...(limits?.excludedPaths || [])].map(String).sort(),
    requestRatePerMinute: limits?.requestRatePerMinute ?? null,
    requestConcurrency: limits?.requestConcurrency ?? null,
    method, url: url.href, authContext: String(authContext || ''),
    identityRevision: identityRevision(identity),
    bodySha256: digest(String(body || '')),
  }));
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
    const chunks = [];
    let receivedBytes = 0;
    let retainedBytes = 0;
    let settled = false;
    let responseStarted = false;
    let requestsWritten = false;
    let response = null;
    let request = null;
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const settle = callback => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const finishResolve = value => settle(() => resolve(value));
    const finishReject = (code, message, extra = {}) => settle(() => {
      try { response?.destroy(); } catch { /* 已结束 */ }
      try { request?.destroy(); } catch { /* 已结束 */ }
      reject(Object.assign(new Error(redactText(message)), {
        code, receivedBytes, retainedBytes, requestsWritten, responseStarted, ...extra,
      }));
    });
    const onAbort = () => finishReject('cancelled', '项目动作已取消', { requestsWritten, responseStarted });
    request = transport.request({
      protocol: url.protocol, hostname: url.hostname, port: url.port || undefined,
      path: url.pathname + url.search, method, headers, timeout: timeoutMs,
    }, incoming => {
      responseStarted = true;
      response = incoming;
      incoming.on('data', chunk => {
        receivedBytes += chunk.length;
        const remaining = Math.max(0, 65536 - retainedBytes);
        if (remaining > 0) {
          const part = chunk.subarray(0, remaining);
          chunks.push(part);
          retainedBytes += part.length;
        }
      });
      incoming.once('end', () => finishResolve({
        outcome: 'response', status: incoming.statusCode,
        headers: { ...incoming.headers },
        responseHead: 'HTTP/' + incoming.httpVersion + ' ' + incoming.statusCode + ' ' + (incoming.statusMessage || '') + '\r\n'
          + Object.entries(incoming.headers).map(([name, value]) => name + ': ' + (Array.isArray(value) ? value.join(', ') : value)).join('\r\n') + '\r\n\r\n',
        body: Buffer.concat(chunks), elapsedMs: Date.now() - startedAt,
        receivedBytes, retainedBytes, truncated: receivedBytes > retainedBytes,
      }));
      incoming.once('aborted', () => finishReject('response-aborted', '响应在完整结束前被中止', { requestsWritten: true, responseStarted: true }));
      incoming.once('error', error => finishReject('response-error', error.code || error.message || '响应流错误', { requestsWritten: true, responseStarted: true }));
      incoming.once('close', () => {
        if (!incoming.complete) finishReject('response-closed', '响应流在完整结束前关闭', { requestsWritten: true, responseStarted: true });
      });
    });
    if (signal) { if (signal.aborted) { onAbort(); return; } signal.addEventListener('abort', onAbort, { once: true }); }
    request.once('finish', () => { requestsWritten = true; });
    request.once('close', () => {
      if (!responseStarted && !settled) finishReject('request-closed', '请求连接在收到响应前关闭', { requestsWritten });
    });
    request.on('timeout', () => finishReject('timeout', '项目请求超时', { requestsWritten, responseStarted }));
    request.on('error', error => finishReject(responseStarted ? 'response-error' : 'request-error',
      error.code || error.message || '项目请求失败', { requestsWritten, responseStarted }));
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
  const denial = targetTrafficDenial(limits, { method }) || excludedPathDenial(limits, { url: url.href })
    || targetScopeDenial(store, sessionId, limits, url);
  if (denial) throw new Error(denial);
  const authContext = String(input.authContext || '');
  const associatedDenial = associatedIdentityDenial(store, sessionId, limits, url, authContext);
  if (associatedDenial) throw new Error(associatedDenial);
  const identity = resolveTaskIdentity(store, sessionId, authContext);
  const identityReason = identityDenial(identity);
  if (identityReason) throw new Error(identityReason);
  const headers = { ...(input.headers || {}) };
  const identityHeaders = identityRequestHeaders({ headers }, identity);
  const outgoingHeaders = identityHeaders ? identityHeaders.headers : headers;
  const body = input.body === undefined || input.body === null ? '' : String(input.body);
  let dispatchHeaders = outgoingHeaders;
  const initialFingerprint = requestFingerprint(limits, method, url, authContext, identity, body);
  const begun = beginProjectAction(store, sessionId, runId, checkId, {
    identityRef: authContext, identityRevision: identityRevision(identity),
    controlRev: input.controlRev, policyRevision: policy.policyRev,
    scopeFingerprint: initialFingerprint, method, targetUrl: url.href,
    executionState: 'queued',
  });
  let release;
  try {
    release = await acquireTargetSlot(sessionId, limits, signal);
  } catch (error) {
    await finishProjectAction(store, sessionId, runId, begun.action.actionId, {
      executionState: 'failed', error: 'cancelled-before-dispatch: ' + String(error?.message || error),
    });
    throw error;
  }
  let result;
  let dispatched = false;
  try {
    signal?.throwIfAborted?.();
    const currentRun = readProjectRun(store, sessionId, runId);
    if (!currentRun || currentRun.state !== 'running') {
      throw Object.assign(new Error('项目运行当前不可派发新动作'), { code: 'project-state-conflict' });
    }
    if (input.controlRev !== undefined && currentRun.controlRev !== input.controlRev) {
      throw Object.assign(new Error('项目运行状态已变化，请刷新后重试'), { code: 'project-state-conflict' });
    }
    const currentPolicy = readTaskPolicy(store, sessionId);
    const currentLimits = effectivePolicy(store, currentPolicy);
    const lateDenial = targetTrafficDenial(currentLimits, { method }) || excludedPathDenial(currentLimits, { url: url.href });
    if (lateDenial) throw new Error(lateDenial);
    const currentScopeDenial = targetScopeDenial(store, sessionId, currentLimits, url);
    if (currentScopeDenial) throw new Error(currentScopeDenial);
    const currentIdentity = resolveTaskIdentity(store, sessionId, authContext);
    const currentIdentityReason = identityDenial(currentIdentity);
    if (currentIdentityReason) throw new Error(currentIdentityReason);
    const currentAssociatedDenial = associatedIdentityDenial(store, sessionId, currentLimits, url, authContext);
    if (currentAssociatedDenial) throw new Error(currentAssociatedDenial);
    const currentIdentityHeaders = identityRequestHeaders({ headers }, currentIdentity);
    dispatchHeaders = currentIdentityHeaders ? currentIdentityHeaders.headers : headers;
    const currentFingerprint = requestFingerprint(currentLimits, method, url, authContext, currentIdentity, body);
    const admission = taskExecutionGuard(store, sessionId, 'recorded-project-execution', Date.now(), {
      args: { method, url: url.href },
      onReserve: () => {
        markProjectActionDispatched(store, sessionId, runId, begun.action.actionId, {
          identityRef: authContext, identityRevision: identityRevision(currentIdentity),
          controlRev: currentRun.controlRev, policyRevision: currentPolicy.policyRev,
          scopeFingerprint: currentFingerprint,
        });
        dispatched = true;
      },
    });
    if (admission) throw new Error(admission);
    const dispatchPolicy = readTaskPolicy(store, sessionId);
    const dispatchLimits = dispatchPolicy ? effectivePolicy(store, dispatchPolicy) : dispatchPolicy;
    const dispatchDenial = targetTrafficDenial(dispatchLimits, { method })
      || excludedPathDenial(dispatchLimits, { url: url.href })
      || targetScopeDenial(store, sessionId, dispatchLimits, url);
    if (dispatchDenial) throw new Error(dispatchDenial);
    result = await dispatch(url, method, dispatchHeaders, body, input.timeoutMs ?? 10000, signal);
  } catch (error) {
    const sideEffectUnknown = dispatched && !['GET', 'HEAD', 'OPTIONS'].includes(method);
    await finishProjectAction(store, sessionId, runId, begun.action.actionId, {
      executionState: sideEffectUnknown ? 'unknown' : 'failed', error: redactText(error?.message || error), sideEffectUnknown,
      receivedBytes: Number(error?.receivedBytes) || 0, retainedBytes: Number(error?.retainedBytes) || 0,
      bodyUnavailable: error?.responseStarted === true,
    });
    throw Object.assign(new Error(redactText(error?.message || error)), { code: error?.code });
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
    status: result.status, outcome: result.outcome, capturedBytes: result.retainedBytes, responseBytes: result.receivedBytes,
    responseTruncated: result.truncated === true, bodyUnavailable: false,
    complete: !result.truncated, startedAt: begun.action.startedAt, completedAt: new Date().toISOString(),
    elapsedMs: result.elapsedMs, requestAttempts: 1,
    requestBasis: digest(JSON.stringify(['project', runId, checkId, requestWire])),
  };
  const decoded = responseBodyText(record);
  if (!decoded.available) { record.bodyUnavailable = true; record.complete = false; record.bodyReadError = decoded.text; }
  store.db.prepare('INSERT INTO execution_receipts (session_id,id,record) VALUES (?,?,?)').run(sessionId, record.id, JSON.stringify(record));
  await finishProjectAction(store, sessionId, runId, begun.action.actionId, {
    executionState: 'completed', requestRef: record.id,
    receivedBytes: record.responseBytes, retainedBytes: record.capturedBytes,
    bodyUnavailable: record.bodyUnavailable,
  });
  const bodyText = redactText(decoded.text);
  const bodyPreview = bodyText.slice(0, 2000);
  const businessHeaders = ['content-type', 'location', 'content-language']
    .filter(name => result.headers?.[name] !== undefined)
    .map(name => name + ': ' + redactText(Array.isArray(result.headers[name]) ? result.headers[name].join(', ') : result.headers[name]));
  const responseHeaders = redactHeaders(result.headers);
  return {
    ok: true, actionId: begun.action.actionId, checkId, executionId: record.id,
    status: record.status,
    summary: method + ' ' + url.href + ' → ' + record.status
      + (businessHeaders.length ? '\n' + businessHeaders.join('\n') : '')
      + '\n响应正文' + (result.truncated ? '（保留前 ' + result.retainedBytes + ' 字节）' : '') + '：' + bodyPreview
      + (bodyText.length > bodyPreview.length || result.truncated
        ? '\n…正文已截断，实际接收 ' + result.receivedBytes + ' 字节，保留 ' + result.retainedBytes + ' 字节' : '')
      + '\nexecutionId=' + record.id,
    evidenceRefs: [record.id],
    responseHeaders,
  };
}
