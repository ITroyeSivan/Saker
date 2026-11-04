import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { startTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { captureTaskCost, listOrdinaryReports } from '../plugins/dsh-redteam-results/lib/task-cost.js';
import { buildDeliveryFiles } from '../plugins/dsh-redteam-results/lib/bundle.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-ordinary-reports-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
let failed = 0;
const test = async (name, work) => {
  try { await work(); console.log('ok   ' + name); }
  catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); }
};

const sid = 'reports-fixture';
const session = { id: sid };
let seq = 1;
const at = value => Date.now() + value;
const emit = (type, data, offset = 0) => captureTaskCost(store, session, { type, seq: seq++, time: at(offset), data });

try {
  await test('only the final returned assistant message per completed turn becomes a report', () => {
    startTaskPolicy(store, sid, { mode: 'regular', question: '结果报告测试', budget: { minutes: 10 } });
    emit('turn/start', { turn: 1 });
    emit('assistant/message', { turn: 1, step: 1, message: { id: 'm1', content: [
      { type: 'reasoning', text: 'HIDDEN_REASONING' }, { type: 'text', text: '先读取资料。' },
    ] } }, 1);
    emit('assistant/message', { turn: 1, step: 1, interrupted: true,
      message: { id: 'm1-failed', content: [{ type: 'text', text: '这次生成被中断，不应作为报告。' }] } }, 1);
    emit('assistant/message', { turn: 1, step: 2, message: { id: 'm2', content: [
      { type: 'reasoning', text: 'HIDDEN_REASONING' }, { type: 'text', text: '同回合最终结论。' },
    ] } }, 2);
    emit('assistant/message', { turn: 1, step: 2, interrupted: true,
      message: { id: 'm2-failed-last', content: [{ type: 'text', text: '最终生成的中断片段，不应覆盖上一条正常结论。' }] } }, 2);
    emit('turn/end', { turn: 1 }, 3);
    emit('turn/start', { turn: 2 });
    emit('assistant/message', { turn: 2, step: 1, message: { id: 'm3', content: [{ type: 'text', text: '同回合最终结论。' }] } }, 4);
    emit('turn/end', { turn: 2 }, 5);
    emit('turn/start', { turn: 3 });
    emit('assistant/message', { turn: 3, step: 1, message: { id: 'm4', content: [{ type: 'text', text: '尚未结束的过程说明。' }] } }, 6);
    const reports = listOrdinaryReports(store, sid, { limit: 20 });
    assert.deepEqual(reports.map(item => item.text), ['同回合最终结论。', '同回合最终结论。']);
    assert.deepEqual(reports.map(item => item.turn), [2, 1]);
    assert(!JSON.stringify(reports).includes('HIDDEN_REASONING'));
    assert(!reports.some(item => item.inProgress));
  });

  await test('large reports expose the omitted range and the delivery bundle says they are incomplete', () => {
    emit('turn/start', { turn: 4 });
    emit('assistant/message', { turn: 4, step: 1, message: { id: 'large', content: [
      { type: 'text', text: 'A'.repeat(200001) },
    ] } }, 7);
    emit('turn/end', { turn: 4 }, 8);
    const report = listOrdinaryReports(store, sid, { limit: 1 })[0];
    assert.equal(report.truncated, true);
    assert.equal(report.complete, false);
    assert.equal(report.originalChars, 200001);
    assert.deepEqual(report.omittedRange, { from: 200001, to: 200001 });
    const bundle = buildDeliveryFiles([], [], [report]);
    assert.match(bundle.files['delivery/reports/index.md'], /不完整/);
    const body = Object.values(bundle.files).find((value, index, all) => Object.keys(bundle.files)[index]?.startsWith('delivery/reports/01-'));
    assert.match(body, /原件不完整，内容已截断：已保存前 200000 个字符/);
    assert.match(bundle.files['delivery/findings.md'], /普通结果见 reports\//);
  });
} finally {
  store.close();
}
if (failed) process.exitCode = 1;
