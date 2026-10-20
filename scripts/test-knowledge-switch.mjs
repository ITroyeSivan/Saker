import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { knowledgeEnabled, knowledgeSwitchView, setKnowledgeEnabled, migrateKnowledgeSwitch, normalizeKnowledgeEnabled } from '../plugins/dsh-redteam-results/lib/knowledge-switch.js';
import { recordKnowledgeUsage, listKnowledgeUsage, markKnowledgeUsageSent } from '../plugins/dsh-redteam-results/lib/knowledge-usage.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-knowledge-switch-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
const ctx = { sessions: { get: id => id === 'sess' ? { id, header: { agentPreset: 'pentest' } } : null } };
const results = await import('../plugins/dsh-redteam-results/lib/index.js');
let failed = 0;
const test = (name, work) => { try { work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };
try {
  test('a task defaults to knowledge on and only one boolean source is stored', () => {
    assert.equal(knowledgeEnabled(store, 'sess'), true);
    assert.equal(knowledgeSwitchView(store, 'sess').source, 'default');
    setKnowledgeEnabled(store, 'sess', false);
    assert.equal(knowledgeEnabled(store, 'sess'), false);
    assert.equal(knowledgeSwitchView(store, 'sess').enabled, false);
    setKnowledgeEnabled(store, 'sess', true);
    assert.equal(knowledgeEnabled(store, 'sess'), true);
    // 只有一行记录：同一个任务只有一个持久来源。
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM task_knowledge WHERE session_id=?').get('sess').n, 1);
  });
  test('legacy modes migrate once: auto/on-demand -> true, off -> false, unknown -> true', () => {
    assert.deepEqual(normalizeKnowledgeEnabled('auto'), { enabled: true, migrated: true });
    assert.deepEqual(normalizeKnowledgeEnabled('on-demand'), { enabled: true, migrated: true });
    assert.deepEqual(normalizeKnowledgeEnabled('off'), { enabled: false, migrated: true });
    assert.deepEqual(normalizeKnowledgeEnabled('mystery'), { enabled: true, migrated: true });
    assert.deepEqual(normalizeKnowledgeEnabled(true), { enabled: true, migrated: false });
    assert.equal(migrateKnowledgeSwitch(store, 'old-off', 'off').enabled, false);
    assert.equal(migrateKnowledgeSwitch(store, 'old-auto', 'auto').enabled, true);
    assert.equal(knowledgeSwitchView(store, 'old-off').source, 'migration');
    // 已有记录不被迁移覆盖。
    setKnowledgeEnabled(store, 'kept', false);
    assert.equal(migrateKnowledgeSwitch(store, 'kept', 'auto').enabled, false);
  });
  test('the switch cannot be changed without an explicit user or migration source', () => {
    assert.throws(() => setKnowledgeEnabled(store, 'sess', false, 'model'), /用户操作或迁移来源/);
  });
  test('knowledge usage distinguishes prepared from sent with position, reason and bytes', () => {
    recordKnowledgeUsage(store, 'sess', { trigger: 'knowledge_search', query: '布尔盲注', docPath: 'sqli.md', reason: '按需检索',
      contentBytes: 512, deliveryId: 'kh-search', state: 'reserved', requestId: 'req-1' });
    recordKnowledgeUsage(store, 'sess', { trigger: 'knowledge_read', docPath: 'sqli.md', chunkId: '12', reason: '按需精读', contentBytes: 2048,
      title: 'SQL 注入速查', excerpt: '布尔盲注：and 1=1 / and 1=2 比对响应长度。',
      deliveryId: 'kh-read', state: 'reserved', requestId: 'req-1' });
    assert.equal(knowledgeSwitchView(store, 'sess').usedCount, 0, '预留不等于已发送');
    assert.equal(knowledgeSwitchView(store, 'sess').pendingCount, 2);
    markKnowledgeUsageSent(store, 'req-1');
    assert.equal(knowledgeSwitchView(store, 'sess').sentCount, 2);
    assert.equal(knowledgeSwitchView(store, 'sess').usedCount, 2);
    const list = listKnowledgeUsage(store, 'sess', {});
    assert.equal(list.total, 2);
    assert.equal(list.items[0].contentBytes, 2048, 'most recent first');
    assert(list.items.every(item => item.contentBytes > 0 && item.reason));
    assert.equal(list.items[0].deliveryState, 'sent');
    // 片段原文（v6 第 6.3 节）：条目列表要能直接看模型实际收到的那一段。
    assert.equal(list.items[0].title, 'SQL 注入速查');
    assert.match(list.items[0].excerpt, /布尔盲注/);
    // 同一毫秒内也要按插入顺序倒序，不能靠随机 UUID 决定“最近优先”。
    const sameAt = Date.now() + 1000;
    recordKnowledgeUsage(store, 'same-ms', { at: sameAt, trigger: 'knowledge_search', contentBytes: 11, reason: '先插入' });
    recordKnowledgeUsage(store, 'same-ms', { at: sameAt, trigger: 'knowledge_read', contentBytes: 22, reason: '后插入' });
    const sameMs = listKnowledgeUsage(store, 'same-ms', {});
    assert.equal(sameMs.items[0].contentBytes, 22, '同毫秒按插入顺序最近优先');
    assert.equal(sameMs.items[1].contentBytes, 11);
    // 片段过长按字符裁断，不抛错（记录的是实际送出的那一段）。
    recordKnowledgeUsage(store, 'clip', { trigger: 'knowledge_read', contentBytes: 10, excerpt: 'x'.repeat(900) });
    assert.equal(listKnowledgeUsage(store, 'clip', {}).items[0].excerpt.length, 801);
    // 自动补充的事实记账行（contentBytes=0）用于去重，不算「查阅的漏洞资料」，不进列表。
    recordKnowledgeUsage(store, 'sess', { trigger: 'auto-provide', query: 'CVE-2026-0001', reason: '自动补充', contentBytes: 0 });
    assert.equal(listKnowledgeUsage(store, 'sess', {}).total, 2, '0 字节的事实记账行不进已用条目列表');
    // 新的 prepared 记录只显示“待发送”，不增加 usedCount。
    recordKnowledgeUsage(store, 'sess', { trigger: 'auto-provide', query: 'CVE-2026-0002', reason: '自动补充', contentBytes: 99, deliveryId: 'kh-pending' });
    assert.equal(knowledgeSwitchView(store, 'sess').usedCount, 2, 'prepared 不冒充已发送');
    assert.equal(knowledgeSwitchView(store, 'sess').pendingCount, 1);
    // 坏记录隔离
    store.db.prepare('INSERT INTO knowledge_usage(session_id,id,at,record) VALUES(?,?,?,?)').run('sess', 'bad', 1, '{');
    assert.equal(listKnowledgeUsage(store, 'sess', {}).items.filter(row => row.id === 'bad').length, 0);
    assert.equal(listKnowledgeUsage(store, 'empty', {}).total, 0);
    assert.throws(() => listKnowledgeUsage(store, 'sess', { page: 0 }), /页号/);
    // v6 第 6.2 节：没有 token 计量器时必须明确标成字节控制，不能让人把字节当 token。
    const note = listKnowledgeUsage(store, 'sess', {}).note;
    assert(note.includes('字节控制'), '已用条目必须写明按字节控制');
    assert(note.includes('没有可用的 token 计量器'), '必须写明没有 token 计量器，不冒充精确 token');
  });
  try {
    const status = await results.dispatch(ctx, store, 'knowledge.status', { sessionId: 'sess' });
    assert.equal(status.ok, true); assert.equal(status.knowledge.enabled, true);
    // 「本次查阅了 N 条漏洞资料」只在条目确实送入模型后显示（v6 第 6.3 节）。
    assert(status.knowledge.usedCount >= 2, 'usedCount 来自 knowledge_usage 实际记录');
    assert.equal(knowledgeSwitchView(store, 'no-usage').usedCount, 0);
    const off = await results.dispatch(ctx, store, 'knowledge.toggle', { sessionId: 'sess', enabled: false });
    assert.equal(off.knowledge.enabled, false);
    assert.equal(knowledgeEnabled(store, 'sess'), false);
    await assert.rejects(results.dispatch(ctx, store, 'knowledge.status', { sessionId: 'unknown' }), /渗透会话|会话读取服务/);
    const usage = await results.dispatch(ctx, store, 'knowledge.usage', { sessionId: 'sess' });
    assert.equal(usage.ok, true); assert(usage.total >= 1); assert(usage.items[0].trigger);
    console.log('ok   RPC exposes status and toggle for the current pentest session only');
  } catch (error) { failed++; console.log('FAIL RPC knowledge switch: ' + (error.stack || error.message)); }
} finally { store.close(); fs.rmSync(home, { recursive: true, force: true }); }
console.log(`${failed ? failed + ' failed' : 'all passed'}`); if (failed) process.exitCode = 1;
