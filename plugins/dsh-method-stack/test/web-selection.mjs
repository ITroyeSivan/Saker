import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../../dsh-redteam-results/lib/store.js';
import { chooseTaskMode, startTaskPolicy, updateTaskProgress, archiveTaskRound } from '../../dsh-redteam-results/lib/task-policy.js';
import { webCatalog, webSelection, saveWebSelection } from '../lib/web-selection.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-web-selection-'));
const previousHome = process.env.DSH_HOME;
process.env.DSH_HOME = home;
let db;
let store;
try {
  store = openStore(path.join(home, 'redteam-results', 'results.db')); db = store.db;
  const choose = (id, mode) => chooseTaskMode(store, id, mode);
  const save = (id, active) => { const state = webSelection(home, id, catalog); return saveWebSelection(home, id, state.mode, active, state.rev, catalog, undefined, state.policyRev); };
  const mod = await import('../lib/index.js?web-selection=' + Date.now());
  let rpc, prompt, tool;
  mod.apply({ tools: { register(value) { tool = value; } },
    sessions: { get(id) { return id === 'missing' ? null : { id, header: { agentPreset: 'pentest' } }; } },
    connection: { rpc: { handle() {} }, register(_ctx, _channel, fn) { rpc = fn; } },
    systemPrompt: { context(value) { prompt = value; }, section() {} },
    agentPresets: { composedPreset() { return 'pentest'; } } });
  const catalog = mod.fullCatalog(), keys = webCatalog(catalog).flatMap(g => g.methods.map(m => m.id));
  const agent = id => ({ ctx: {}, session: { id } });
  const first = await rpc('session-list', { sessionId: 'a' });
  assert.equal(first.ok, true); assert.equal(keys.length, 17); assert.deepEqual(new Set(first.value.active), new Set(keys));
  assert(!first.value.groups.some(g => ['intranet', 'evidence', 'report'].includes(g.group)));
  assert(first.value.groups.find(g => g.group === 'recon').methods.some(m => m.id === 'subdomain'));
  assert(first.value.groups.find(g => g.group === 'recon').methods.some(m => m.id === 'port-service'));
  console.log('ok 测试内容默认开放17项，包含网站与子域名、端口与服务');
  const text = prompt.text({ agent: agent('a') });
  assert(text.includes('knowledge_search')); assert(text.includes('knowledge_read')); assert(text.includes('不要依次全读'));
  assert(!text.includes('exploit/sqli'));
  console.log('ok 全选只注入目录与检索指引，不注入正文');
  assert.equal((await rpc('session-list', { sessionId: 'missing' })).ok, false);
  const saved = await rpc('session-set', { sessionId: 'a', mode: 'regular', rev: 1, policyRev: first.value.policyRev, active: ['sqli'] });
  assert.equal(saved.ok, true); assert.equal(saved.value.rev, 2);
  const read = await tool.execute({ action: 'read', key: 'sqli' }, { agent: agent('a') });
  assert.equal(read.ok, true); assert(read.prompt.length > 0);
  assert.equal((await tool.execute({ action: 'read', key: 'xss' }, { agent: agent('a') })).ok, false);
  assert.equal(webSelection(home, 'b', catalog).active.length, 17);
  console.log('ok 筛选真实限制可读模块，其他会话保持独立');
  assert.throws(() => saveWebSelection(home, 'a', 'regular', [], 1, catalog), /其他窗口/);
  assert.throws(() => save('a', ['not-a-real-check']), /测试内容/);
  console.log('ok 拒绝陈旧覆盖与目录外项目');
  choose('a', '0day'); assert.deepEqual(webSelection(home, 'a', catalog).active, ['sqli']);
  save('a', []);
  assert(prompt.text({ agent: agent('a') }).includes('关闭所有'));
  choose('a', 'regular'); assert.deepEqual(webSelection(home, 'a', catalog).active, []);
  console.log('ok 三种模式共用任务选择，明确空选择不会恢复全选');
  choose('a', 'nday'); assert(prompt.text({ agent: agent('a') }).includes('关闭所有'));
  assert.equal((await tool.execute({ action: 'read', key: 'sqli' }, { agent: agent('a') })).ok, false);
  assert(!Object.hasOwn(webSelection(home, 'a', catalog), '_ownerPolicy'));
  assert.throws(() => saveWebSelection(home, 'a', 'regular', [], webSelection(home, 'a', catalog).rev, catalog), /方向/);
  console.log('ok Nday沿用模块限制，模式切换中的旧提交被拒绝');
  choose('a', 'regular');
  save('a', ['sqli']);
  startTaskPolicy(store, 'a', { mode: 'regular', budget: { toolCalls: 10 } });
  db.prepare('INSERT INTO task_policy(session_id,record,updated_at) VALUES (?,?,?)').run('child', JSON.stringify({ mode: 'regular', parentSession: 'a' }), 'now');
  assert.deepEqual(webSelection(home, 'child', catalog).active, ['sqli']);
  assert.throws(() => saveWebSelection(home, 'child', 'regular', [], 2, catalog), /主任务/);
  console.log('ok 子任务读取主任务选择，不能自行扩大模块');
  const settings = await rpc('set-active', { presetId: 'pentest', active: ['xss'] });
  assert.equal(settings.ok, true); assert.deepEqual((await rpc('session-list', { sessionId: 'new' })).value.active, ['xss']);
  assert.deepEqual(webSelection(home, 'b', catalog).active, keys);
  console.log('ok 设置默认值仅影响新会话，已保存的选择不被覆盖');
  assert.deepEqual((await import('../lib/web-selection.js?cold=1')).webSelection(home, 'a', catalog).active, ['sqli']);
  console.log('ok 冷读取恢复准确选择');
  save('task-backed', ['subdomain']);
  startTaskPolicy(store, 'task-backed', { mode: 'regular', budget: { toolCalls: 10 } });
  const migrated = webSelection(home, 'task-backed', catalog);
  assert.equal(migrated.backing, 'task'); assert.deepEqual(migrated.active, ['subdomain']);
  const backed = JSON.parse(db.prepare('SELECT record FROM task_policy WHERE session_id=?').get('task-backed').record);
  assert.deepEqual(backed.modules, ['subdomain']);
  const updated = saveWebSelection(home, 'task-backed', 'regular', ['port-service'], migrated.rev, catalog, undefined, migrated.policyRev);
  assert.equal(updated.backing, 'task'); assert.equal(updated.rev, migrated.rev + 1); assert.deepEqual(updated.active, ['port-service']);
  assert.throws(() => saveWebSelection(home, 'task-backed', 'regular', ['sqli'], migrated.rev, catalog), /其他窗口/);
  updateTaskProgress(store, 'task-backed', { cancelled: true });
  archiveTaskRound(store, 'task-backed', 'desktop-user');
  assert.deepEqual(webSelection(home, 'task-backed', catalog).active, ['port-service']);
  console.log('ok 已开始任务把模块选择迁移到任务记录并拒绝旧修订覆盖');
} finally {
  store?.close();
  if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  if (!path.resolve(home).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error('temp boundary mismatch');
  fs.rmSync(home, { recursive: true, force: true });
}
