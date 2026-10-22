import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { breakdownFromEvents, maskSensitive, maskedRecord, renderBreakdown, BUCKET_LABELS, diagnosticsDelta } from '../plugins/dsh-redteam-results/lib/request-diagnostics.js';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';

let failed = 0;
const test = (name, work) => { try { work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };

const events = [
  { type: 'system/message', data: { role: 'system', content: [{ type: 'text', text: '宿主原有要求' }] } },
  { type: 'user/message', data: { role: 'user', source: { kind: 'runtime-context', sections: [
    { name: 'sandbox:policy', text: 'Current DSH file policy: danger-full-access.' },
    { name: 'saker-pentest-task-state', text: 'Saker task state\n目标 https://app.example.test' },
  ] }, content: [{ type: 'text', text: 'runtime' }] } },
  { type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '请检查订单接口' }] } },
  { type: 'assistant/message', data: { role: 'assistant', content: [{ type: 'text', text: '好的。' }] } },
  { type: 'tool/result', data: { message: { role: 'tool', content: [{ type: 'text', text: 'GET /api/orders 200' }] } } },
  { type: 'request/header', data: { header: { tools: [{ function: { name: 'redteam_context' } }, { function: { name: 'asset_search' } }] } } },
];

test('分项把事件拆成固定说明/工具定义/任务事实/用户消息/历史', () => {
  const breakdown = breakdownFromEvents(events);
  const byName = Object.fromEntries(breakdown.items.map(item => [item.name, item]));
  assert.equal(breakdown.items.length, 5, '五个分项都在');
  assert(byName.fixed.bytes > 0, '固定说明含宿主 system 与沙箱等运行时 section');
  assert(byName.tools.bytes > 0, '工具定义来自 request/header');
  assert(byName.taskFacts.bytes > 0, '任务事实来自 saker-pentest-task-state');
  assert(byName.user.bytes > 0, '用户消息单独归到用户消息');
  assert(byName.history.bytes > 0, '助手与工具结果归到历史');
  assert.equal(breakdown.total, breakdown.items.reduce((sum, item) => sum + item.bytes, 0), '合计等于分项之和');
  assert.equal(breakdown.toolsSeen, true, '标出是否读到工具定义');
});

test('分项在只有部分事件时也如实返回 0，不猜', () => {
  const breakdown = breakdownFromEvents([{ type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } }]);
  const byName = Object.fromEntries(breakdown.items.map(item => [item.name, item]));
  assert.equal(byName.tools.bytes, 0);
  assert.equal(byName.user.bytes, 2);
  assert.match(renderBreakdown(breakdown), /用户消息 2 字节/);
});

test('敏感字段遮蔽：请求头、Cookie、密钥赋值与私钥都不回显', () => {
  const masked = maskSensitive([
    'Authorization: Bearer SECRET-TOKEN-123',
    'Cookie: session=abc',
    'password = "hunter2"',
    '-----BEGIN RSA PRIVATE KEY-----MIIabc-----END RSA PRIVATE KEY-----',
  ].join('\n'));
  assert(!masked.includes('SECRET-TOKEN-123'), 'Authorization 不回显');
  assert(!masked.includes('session=abc'), 'Cookie 不回显');
  assert(!masked.includes('hunter2'), 'password 不回显');
  assert(!masked.includes('MIIabc'), '私钥不回显');
  assert(masked.includes('已遮蔽'), '标出已遮蔽');
});

test('私有记录逐事件保留类型与截断文本，并且已遮蔽', () => {
  const record = maskedRecord([{ type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Authorization: Bearer TOPSECRET ' + 'x'.repeat(600) }] } }], { maxChars: 40 });
  assert.equal(record.length, 1);
  assert.equal(record[0].type, 'user/message');
  assert(record[0].text.length <= 40, '文本按上限截断');
  assert(!record[0].text.includes('TOPSECRET'), '私有记录同样遮蔽');
});

test('RPC diagnostics.request 分项返回，并把已遮蔽的原始记录写进私有目录', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-diag-'));
  process.env.DSH_HOME = home;
  const store = openStore(path.join(home, 'redteam-results', 'results.db'));
  try {
    const session = { id: 'diag-1', header: { agentPreset: 'pentest' }, surface: { nodes: [0, 1, 2, 3, 4, 5] }, eventAt: seq => events[seq], snapshotEvents: () => events };
    const ctx = { sessions: { get: id => id === 'diag-1' ? session : null } };
    const results = await import('../plugins/dsh-redteam-results/lib/index.js');
    const view = await results.dispatch(ctx, store, 'diagnostics.request', { sessionId: 'diag-1' });
    assert.equal(view.ok, true);
    assert.equal(view.items.length, 5);
    assert(view.total > 0);
    assert(view.items.find(item => item.name === 'tools').bytes > 0, '完整事件日志里能读到工具定义');
    assert(view.rawPath && fs.existsSync(view.rawPath), '私有目录里有原始记录');
    const raw = fs.readFileSync(view.rawPath, 'utf8');
    assert(raw.includes('saker-diagnostics') === false, '文件内容是记录本身');
    assert(JSON.parse(raw).breakdown.total === view.total, '私有记录与返回值一致');
    await assert.rejects(results.dispatch(ctx, store, 'diagnostics.request', { sessionId: 'nope' }), /渗透会话/);
  } finally { store.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('上下文增长给出逐项差，没有基线时不编造', () => {
  const previous = { items: [{ name: 'history', label: '历史', bytes: 100 }], total: 100 };
  const current = { items: [{ name: 'history', label: '历史', bytes: 260 }], total: 260 };
  const delta = diagnosticsDelta(previous, current);
  assert.equal(delta.total, 160, '总差');
  assert.equal(delta.items.find(item => item.name === 'history').bytes, 160, '逐项差');
  assert.equal(diagnosticsDelta(null, current), null, '没有基线不编造');
});

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
if (failed) process.exitCode = 1;
