import { randomUUID } from 'node:crypto';
import { registerFinding, updateFinding } from '../../plugins/dsh-redteam-results/lib/store.js';
import { beginProjectAction, finishProjectAction, recordProjectCheck } from '../../plugins/dsh-redteam-results/lib/project-store.js';

export function observeProjectCheck(store, sessionId, runId, checkId, input = {}) {
  const begun = beginProjectAction(store, sessionId, runId, checkId, {
    executionState: 'queued', identityRef: input.authContext || 'fixture',
  });
  const id = 'execution-' + randomUUID();
  const method = String(input.method || 'GET').toUpperCase();
  const url = String(input.url || 'http://127.0.0.1/fixture');
  const body = Buffer.from(String(input.body ?? '{"ok":true}'));
  const row = {
    id, source: 'host-project-http-execution',
    projectRunId: runId, projectCheckId: checkId, actionId: begun.action.actionId,
    endpoint: new URL(url).origin, authContext: String(input.authContext || 'fixture'),
    method, url,
    request: method + ' ' + new URL(url).pathname + ' HTTP/1.1\r\nHost: ' + new URL(url).host + '\r\n\r\n',
    requestSha256: randomUUID().replaceAll('-', ''),
    responseHead: 'HTTP/1.1 ' + (input.status || 200) + ' OK\r\nContent-Type: application/json\r\n\r\n',
    responseBodyBase64: body.toString('base64'),
    responseSha256: randomUUID().replaceAll('-', ''),
    status: input.status || 200, outcome: 'response',
    capturedBytes: body.length, responseBytes: body.length, complete: true,
    startedAt: begun.action.startedAt, completedAt: new Date().toISOString(),
    elapsedMs: 1, requestAttempts: 1,
  };
  store.db.prepare('INSERT INTO execution_receipts (session_id,id,record) VALUES (?,?,?)')
    .run(sessionId, id, JSON.stringify(row));
  finishProjectAction(store, sessionId, runId, begun.action.actionId, {
    executionState: 'completed', requestRef: id,
  });
  return { actionId: begun.action.actionId, executionId: id };
}

export function recordObservedProjectCheck(store, sessionId, runId, checkId, patch = {}, observation = {}) {
  const observed = observeProjectCheck(store, sessionId, runId, checkId, observation);
  const check = recordProjectCheck(store, sessionId, runId, checkId, patch);
  return { ...observed, check };
}

export function registerVerifiedProjectFinding(store, sessionId, input = {}) {
  const finding = registerFinding(store, sessionId, 'pentest', {
    title: input.title || '项目复核 finding',
    severity: input.severity || 'medium',
    target: input.target || 'http://127.0.0.1/fixture',
    evidenceLevel: 'confirmed',
    evidence: 'SYNTHETIC_PROJECT_EVIDENCE',
    impact: 'SYNTHETIC_PROJECT_IMPACT',
  });
  return updateFinding(store, sessionId, 'pentest', finding.id, {
    status: 'verified',
    secondRating: input.secondRating || 'medium',
    secondRatingNote: input.secondRatingNote
      || '独立复核重新读取合成对象并通过另一条受控观测核对证据，结果与首次结论一致且可以重复执行。',
    verifyNote: input.verifyNote || '独立复核完成',
  });
}
