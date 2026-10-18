// 逐调用模型账本明细（benchmark 0.0.8）：只保留用途/状态/发线标记与用量，不复制请求摘要。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '@dsh-external/dsh-redteam-results';
import { ledgerFacts } from '../benchmarks/task-effects/run-facts.mjs';

const home = mkdtempSync(join(tmpdir(), 'saker-ledger-facts-'));
let failed = 0;
try {
  const store = openStore(join(home, 'redteam-results', 'results.db'));
  const sessionId = 'ledger-session';
  store.db.prepare('INSERT INTO task_model_calls(id,root_session,round_at,session_id,state,record) VALUES(?,?,?,?,?,?)').run(
    'call-1', sessionId, Date.now(), sessionId, 'settled',
    JSON.stringify({ id: 'call-1', purpose: 'conversation', state: 'settled',
      wire: { sha256: 'secret-request-digest' },
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0, totalTokens: 60 } }));
  store.close();
  const facts = ledgerFacts(home, sessionId);
  assert.equal(facts.available, true);
  assert.equal(facts.calls, 1);
  assert.equal(facts.callsDetail.length, 1);
  assert.equal(facts.callsDetail[0].purpose, 'conversation');
  assert.equal(facts.callsDetail[0].wire, true);
  assert.deepEqual(facts.callsDetail[0].usage, { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0, totalTokens: 60 });
  assert(!JSON.stringify(facts.callsDetail).includes('secret-request-digest'), '逐调用明细不得复制请求摘要/原文');
  console.log('ok   ledger detail keeps usage and drops raw request digest');
} catch (error) {
  failed += 1;
  console.log('FAIL ' + (error.stack || error.message));
} finally {
  rmSync(home, { recursive: true, force: true });
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exitCode = failed ? 1 : 0;
