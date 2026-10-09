// Optional native Desktop verification bundle; never a production preset/tool.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { openStore, registerFinding, updateFinding, getFinding } from '@dsh-external/dsh-redteam-results/store';
import { saveTaskContext } from '@dsh-external/dsh-redteam-results/task-context';

const installed = new URL('./', import.meta.resolve('@dsh-external/dsh-redteam-results'));
const { startTaskPolicy } = await import(new URL('task-policy.js', installed));
const { runEffectJob } = await import(new URL('effect-jobs.js', installed));
const { readExecutionReceipt } = await import(new URL('execution-receipts.js', installed));
const { readEffectVerification } = await import(new URL('effect-verifications.js', installed));
export const name = 'saker-evidence-integrity-probe';
export const inject = ['agents', 'agentPresets', 'connection', 'webServer'];

async function exercise(sessionId, directory) {
  const store = openStore(join(directory, 'isolated-results.db'));
  let requests = 0;
  const markers = { owner: randomUUID(), subject: randomUUID() };
  const server = http.createServer((req, res) => {
    requests++;
    const object = new URL(req.url, 'http://fixture.invalid').searchParams.get('id');
    const identity = req.headers.authorization?.replace('Fixture ', '');
    res.setHeader('content-type', 'application/json');
    if (!identity) { res.writeHead(403); res.end('{"denied":true}'); return; }
    res.end(JSON.stringify({ id: 'private-' + object, ownerId: object, viewerId: identity,
      visibility: 'private', readers: [object], secret: markers[object] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const endpoint = 'http://127.0.0.1:' + server.address().port + '/api/object';
    const method = { id: 'private-read', version: 'v1', reviewed: true, endpoint,
      effectSpec: { kind: 'private-json-read/v1', resourceIdPath: '/id', ownerIdPath: '/ownerId',
        viewerIdPath: '/viewerId', visibilityPath: '/visibility', readersPath: '/readers', markerPath: '/secret' } };
    const row = (id, identity, object, valid = true) => ({ id, revision: 'v1', endpoint, authContext: identity || 'anonymous', kind: 'api', valid,
      request: `GET /api/object?id=${object} HTTP/1.1\r\nHost: ${new URL(endpoint).host}${identity ? '\r\nAuthorization: Fixture ' + identity : ''}\r\n\r\n`,
      response: 'HTTP/1.1 200 OK\r\n\r\nfixture baseline', inputs: [{ name: 'id', location: 'query', evidenceIds: [id] }] });
    startTaskPolicy(store, sessionId, { mode: 'regular', target: endpoint, budget: { toolCalls: 8, workers: 0 } });
    saveTaskContext(store, sessionId, { assets: [{ id: 'fixture', url: endpoint, inScope: true, reachable: true }], methods: [method], requests: [
      row('owner', 'owner', 'owner'), row('normal', 'subject', 'subject'), row('probe', 'subject', 'owner', false), row('denied', '', 'owner', false)] });
    const job = await runEffectJob(store, sessionId, { methodId: method.id, methodVersion: method.version,
      roles: Object.fromEntries(['owner', 'normal', 'probe', 'denied'].map(role => [role, { requestId: role, requestRevision: 'v1' }])) });
    assert.equal(job.impactVerified, true, job.reason); assert.equal(requests, 8);
    const effect = readEffectVerification(store, sessionId, job.effectId), probe = readExecutionReceipt(store, sessionId, effect.probeReceiptId);
    const reproduction = { kind: 'method', methodId: method.id, methodVersion: method.version, endpoint, mechanism: 'private-json-read/v1',
      prerequisites: ['Reviewed private-owner ACL'], dependencies: [], parameters: ['Two test accounts'],
      steps: ['Compare owner, subject, cross-object and anonymous responses in two rounds'], successCriterion: 'Excluded subject reads private marker',
      reviewSteps: 'Deterministic verifier of original host receipts', recovery: 'Read-only localhost fixture',
      verification: { status: 'verified', evidenceIds: effect.receiptIds, controlReceiptId: effect.controlReceiptId,
        probeReceiptId: effect.probeReceiptId, effectReceiptId: effect.id } };
    const pending = registerFinding(store, sessionId, 'pentest', { title: 'Owned fixture evidence integrity', severity: 'high', proofKind: 'access',
      evidenceLevel: 'impact', identity: 'subject', target: endpoint, impact: 'Excluded subject read owner private marker', evidence: effect.id,
      requestPkt: probe.request, responsePkt: probe.responseHead + Buffer.from(probe.responseBodyBase64, 'base64').toString(), reproduction: JSON.stringify(reproduction) });
    const finding = updateFinding(store, sessionId, 'pentest', pending.id, { status: 'verified', secondRating: 'high',
      secondRatingNote: 'Host-captured owner, subject and anonymous controls in two distinct rounds validate the reviewed private object read contract.' });
    assert.equal(finding.delivery.ready, true);
    const id = effect.receiptIds[0], saved = store.db.prepare('SELECT record FROM execution_receipts WHERE session_id=? AND id=?').get(sessionId, id).record;
    const mutations = [
      ['request', row => { row.request += 'damaged'; }],
      ['response-head', row => { row.responseHead += 'damaged'; }],
      ['response-body', row => { row.responseBodyBase64 = Buffer.from('damaged').toString('base64'); }],
      ['base64', row => { row.responseBodyBase64 += '!'; }],
      ['status', row => { row.status = 403; }],
      ['length', row => { row.capturedBytes++; }],
      ['missing-hash', row => { delete row.responseSha256; }],
    ], results = [];
    try {
      for (const [kind, mutate] of mutations) {
        const changed = JSON.parse(saved); mutate(changed);
        store.db.prepare('UPDATE execution_receipts SET record=? WHERE session_id=? AND id=?').run(JSON.stringify(changed), sessionId, id);
        const receipt = readExecutionReceipt(store, sessionId, id), verdict = readEffectVerification(store, sessionId, effect.id);
        const ready = getFinding(store, sessionId, finding.id).delivery.ready;
        assert.equal(receipt.integrityValid, false); assert.equal(receipt.current, false);
        assert.equal(verdict.current, false); assert.equal(ready, false); assert.equal(requests, 8);
        results.push({ kind, integrityValid: receipt.integrityValid, current: verdict.current, ready, reason: receipt.currentReason });
      }
    } finally { store.db.prepare('UPDATE execution_receipts SET record=? WHERE session_id=? AND id=?').run(saved, sessionId, id); }
    assert.equal(getFinding(store, sessionId, finding.id).delivery.ready, true);
    return { ok: true, actualRequests: requests, initiallyReady: true, mutations: results, restoredReady: true,
      storage: 'owned isolated temporary database', limit: 'Detects damaged bytes and inconsistent metadata; does not authenticate fully rewritten database rows or establish live freshness.' };
  } finally { store.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

export function apply(ctx) {
  let handle, run;
  ctx.connection.register(ctx, '/saker-evidence-integrity-probe', async (endpoint, payload = {}) => {
    try {
      if (endpoint === 'start') {
        if (handle) throw new Error('one owned verification agent');
        const directory = mkdtempSync(join(tmpdir(), 'saker-integrity-desktop-')), cwd = join(directory, 'agent'); mkdirSync(cwd);
        run = { directory, result: null };
        handle = await ctx.agents.create({ sessionId: 'session-' + randomUUID(), meta: { cwd, agentPreset: 'standard' },
          agentOptions: { provider: payload.provider, model: payload.model, maxTokens: 1024 },
          setup: async (agentCtx, agent) => {
            await ctx.agentPresets.mount(agentCtx, 'standard');
            agentCtx.tools.restrict({ allow: [] });
            agentCtx.tools.guard(exec => exec.name === 'saker_evidence_integrity_probe' && exec.agent?.id === agent.id ? undefined : 'only owned verification tool');
            agentCtx.tools.register(defineTool({ name: 'saker_evidence_integrity_probe', description: '在隔离本地练习环境执行已安装证据完整性验证；不访问外部目标或日常数据库。', parameters: {},
              output: { schema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean', required: true } } },
                render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
              async execute() {
                if (run.result) return run.result;
                try { run.result = await exercise(agent.id, directory); }
                catch (error) { run.result = { ok: false, error: error.stack }; }
                writeFileSync(join(directory, 'result.json'), JSON.stringify(run.result, null, 2));
                return run.result;
              } }));
          } });
        run.sessionId = handle.agent.id;
        handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: '调用 saker_evidence_integrity_probe 一次，依据实际返回总结：正文损坏是否撤销确认、是否额外发送HTTP、历史是否保留。不得使用其他工具。' }], source: { kind: 'user' } }));
        return { ok: true, sessionId: run.sessionId, directory };
      }
      if (endpoint === 'status') return { ok: true, run, status: handle?.agent.status };
      throw new Error('unknown endpoint');
    } catch (error) { return { ok: false, error: error.message }; }
  }, { authority: 'loopback' });
  ctx.effect(() => async () => { if (handle) { handle.agent.cancel(); await handle.agent.whenIdle(); await handle.dispose(); } }, 'owned native evidence verification');
}
