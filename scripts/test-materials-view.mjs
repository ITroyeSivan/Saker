import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { saveTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js';
import { materialsList, materialsDetail, searchMaterials, readMaterialExcerpt, removeMaterial } from '../plugins/dsh-redteam-results/lib/materials-view.js';
import { recordMaterialRead, recordMaterialView, materialReadKey } from '../plugins/dsh-redteam-results/lib/material-reads.js';
import { registerFinding, updateFinding } from '../plugins/dsh-redteam-results/lib/store.js';
import { detectFormat, summarizeHar, summarizeScan, summarizeAssets, importPastedMaterial } from '../plugins/dsh-redteam-results/lib/materials-import.js';
import { businessMaterialView } from '../plugins/dsh-redteam-results/lib/business-materials.js';
import { startTaskPolicy } from '../plugins/dsh-redteam-results/lib/task-policy.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-materials-'));
process.env.DSH_HOME = home;
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
let failed = 0;
const test = (name, work) => { try { work(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } };
try {
  const endpoint = 'https://app.example.test';
  saveTaskContext(store, 'mat', { assets: [
    { id: 'a1', url: endpoint, inScope: true, reachable: true, source: 'manual' },
    { id: 'a2', url: 'https://api.example.test:8443', inScope: false, reachable: true, product: 'nginx' }],
    requests: [
      { id: 'r1', revision: 'v1', endpoint: endpoint + '/api/orders', authContext: 'user-a', kind: 'api', valid: true,
        request: 'GET /api/orders HTTP/1.1\r\nHost: app.example.test\r\n\r\n', response: 'HTTP/1.1 200 OK\r\n\r\n[]' },
      { id: 'r2', revision: 'v2', endpoint: endpoint + '/api/admin', authContext: 'user-b', kind: 'api', valid: false,
        request: 'POST /api/admin HTTP/1.1\r\nHost: app.example.test\r\n\r\n', response: 'HTTP/1.1 403 Forbidden\r\n\r\n' }] });
  store.db.prepare('INSERT INTO business_materials(session_id,id,source_url,digest,record) VALUES(?,?,?,?,?)')
    .run('mat', 'material-1', endpoint + '/static/app.js', 'a'.repeat(64), JSON.stringify({ id: 'material-1', file: 'C:/tmp/app.js', sourceUrl: endpoint + '/static/app.js', site: 'https://app.example.test', digest: 'a'.repeat(64), hints: [{ kind: 'route', value: '/api/orders' }], coverage: { capped: true } }));
  // 坏行隔离：损坏的 JSON 不进入列表，也不抛错。
  store.db.prepare('INSERT INTO business_materials(session_id,id,source_url,digest,record) VALUES(?,?,?,?,?)')
    .run('mat', 'material-bad', endpoint + '/broken.js', 'b'.repeat(64), '{');

  test('materials list unifies assets, requests and indexed files with counts', () => {
    const all = materialsList(store, 'mat', {});
    assert.deepEqual(all.counts, { all: 5, asset: 2, request: 2, file: 1 });
    assert.equal(all.total, 5, 'the corrupt material row is isolated, not listed');
    const kinds = all.rows.map(r => r.kind);
    assert(kinds.includes('asset') && kinds.includes('request') && kinds.includes('file'));
  });
  test('type filters return only the requested kind and keep the counts stable', () => {
    assert.deepEqual(materialsList(store, 'mat', { type: 'asset' }).rows.map(r => r.kind), ['asset', 'asset']);
    assert.deepEqual(materialsList(store, 'mat', { type: 'request' }).rows.map(r => r.kind), ['request', 'request']);
    assert.deepEqual(materialsList(store, 'mat', { type: 'file' }).rows.map(r => r.kind), ['file']);
    assert.equal(materialsList(store, 'mat', { type: 'file' }).counts.all, 5);
    assert.throws(() => materialsList(store, 'mat', { type: 'knowledge' }), /资料类型/);
  });
  test('workspace asset-inventory assets appear in the task materials list without duplicating task assets', () => {
    // 扫描/测绘把资产写进工作区账本；资料列表要把"已收集"的资产列出来（第 7.2 节 / 12.2 C03）。
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-materials-inv-'));
    try {
      fs.writeFileSync(path.join(workspace, 'asset-inventory.json'), JSON.stringify({
        schema: 'saker.asset-inventory/1', updatedAt: new Date().toISOString(),
        assets: [
          // 与任务里已有的 a1 同一个 URL：以任务记录为准，不重复。
          { id: 'inv-dup', target: endpoint, host: 'app.example.test', protocol: 'https', port: 443, tech: ['nginx'], sources: ['httpx'] },
          // 任务资料里还没有：要出现在列表里。
          { id: 'inv-new', target: 'https://scan.example.test:9443/admin', host: 'scan.example.test', protocol: 'https', port: 9443, tech: ['Tomcat'], sources: ['nuclei'], authorized: true },
        ],
      }));
      const withInv = materialsList(store, 'mat', { workspace });
      assert.equal(withInv.counts.asset, 3, '两个任务资产 + 一个新账本资产，重复的账本资产被去重');
      assert.equal(withInv.counts.all, 6);
      const added = withInv.rows.find(r => r.id === 'inventory:inv-new');
      assert(added, '工作区账本里的新资产出现在列表');
      assert.equal(added.meta.origin, 'inventory'); assert.equal(added.meta.port, '9443');
      assert.equal(added.meta.product, 'Tomcat'); assert.equal(added.meta.authorized, true);
      assert(!withInv.rows.some(r => r.id === 'inventory:inv-dup'), '任务里已有的资产不重复列出');
      // 不传 workspace 时行为不变（不读盘）。
      assert.equal(materialsList(store, 'mat', {}).counts.all, 5);
      // 账本损坏时静默为空，不拖垮列表。
      fs.writeFileSync(path.join(workspace, 'asset-inventory.json'), '{broken');
      assert.equal(materialsList(store, 'mat', { workspace }).counts.all, 5);
    } finally { fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }); }
  });
  test('requests carry method, host, path, account and response status without copying conclusions', () => {
    const rows = materialsList(store, 'mat', { type: 'request' }).rows;
    const admin = rows.find(r => r.meta.path === '/api/admin');
    assert.equal(admin.meta.method, 'POST'); assert.equal(admin.meta.host, 'app.example.test');
    assert.equal(admin.meta.account, 'user-b'); assert.equal(admin.meta.status, 403); assert.equal(admin.meta.valid, false);
    assert(!('response' in admin) && !('request' in admin.meta), 'list rows expose references, not copied originals');
  });
  test('assets expose host/protocol/port/source/in-scope and files expose name plus source', () => {
    const assets = materialsList(store, 'mat', { type: 'asset' }).rows;
    const api = assets.find(r => r.meta.host === 'api.example.test');
    assert.equal(api.meta.protocol, 'https'); assert.equal(api.meta.port, '8443'); assert.equal(api.meta.inScope, false);
    const file = materialsList(store, 'mat', { type: 'file' }).rows[0];
    assert.equal(file.title, 'app.js'); assert.equal(file.meta.source, endpoint + '/static/app.js'); assert.equal(file.meta.unresolved, true);
  });
  test('imported material shows its readable name instead of the internal pasted-<uuid> file', () => {
    // 单独会话：不打扰共享夹具的条数与分页断言。
    const row = importPastedMaterial(store, 'mat-name', { name: 'practice-assets.csv', text: 'target,port\nshop.example.test,443\n' });
    const listed = materialsList(store, 'mat-name', { type: 'file' }).rows.find(item => item.id === row.id);
    assert.equal(listed.title, 'practice-assets.csv');
    assert.equal(listed.meta.name, 'practice-assets.csv');
    const detail = materialsDetail(store, 'mat-name', { kind: 'file', id: row.id });
    assert.equal(detail.name, 'practice-assets.csv');
    assert.ok(!String(listed.title).startsWith('pasted-'), '列表不应显示内部文件名');
  });
  test('search and pagination slice server-side and report more', () => {
    assert.equal(materialsList(store, 'mat', { query: 'admin' }).total, 1);
    assert.equal(materialsList(store, 'mat', { query: 'example.test' }).total, 5);
    const page = materialsList(store, 'mat', { page: 2, pageSize: 2 });
    assert.equal(page.rows.length, 2); assert.equal(page.more, 1);
    assert.equal(materialsList(store, 'mat', { page: 1, pageSize: 3 }).more, 2);
  });
  test('request detail returns masked originals, identity and related checks without contacting the target', () => {
    saveTaskContext(store, 'mat', { assets: [{ id: 'a1', url: endpoint, inScope: true, reachable: true }],
      requests: [{ id: 'r1', revision: 'v2', endpoint: endpoint + '/api/orders', authContext: 'user-a', kind: 'api', valid: true,
        request: 'GET /api/orders HTTP/1.1\r\nHost: app.example.test\r\nAuthorization: Bearer SUPERSECRET\r\nCookie: session=abc\r\n\r\n',
        response: 'HTTP/1.1 200 OK\r\nSet-Cookie: session=def\r\n\r\n[]', inputs: [{ name: 'id', location: 'query', evidenceIds: ['r1'] }] }],
      checks: [] });
    const detail = materialsDetail(store, 'mat', { kind: 'request', id: 'r1:v2' });
    assert.equal(detail.endpoint, endpoint + '/api/orders');
    assert.equal(detail.authContext, 'user-a');
    assert(detail.request.includes('[已遮蔽]') && !detail.request.includes('SUPERSECRET'), 'authorization is masked');
    assert(!detail.response.includes('session=def'), 'set-cookie is masked');
    assert.deepEqual(detail.inputs, [{ name: 'id', location: 'query' }]);
  });
  test('asset detail lists related requests; file detail previews local bytes and flags a missing original', () => {
    const asset = materialsDetail(store, 'mat', { kind: 'asset', id: 'a1' });
    assert.equal(asset.inScope, true);
    assert(asset.relatedRequests.some(row => row.endpoint === endpoint + '/api/orders'));
    const file = path.join(home, 'preview.js');
    fs.writeFileSync(file, 'console.log("token=abc");\n');
    store.db.prepare('INSERT OR REPLACE INTO business_materials(session_id,id,source_url,digest,record) VALUES(?,?,?,?,?)')
      .run('mat', 'material-preview', endpoint + '/preview.js', 'c'.repeat(64), JSON.stringify({ id: 'material-preview', file, sourceUrl: endpoint + '/preview.js', hints: [], coverage: {} }));
    const detail = materialsDetail(store, 'mat', { kind: 'file', id: 'material-preview' });
    assert.equal(detail.name, 'preview.js'); assert.equal(detail.missing, false);
    assert(detail.preview.includes('console.log'));
    assert.throws(() => materialsDetail(store, 'mat', { kind: 'file', id: 'nope' }), /文件不存在/);
    assert.throws(() => materialsDetail(store, 'mat', { kind: 'knowledge', id: 'x' }), /资料类型/);
  });
  test('大文件按 offset 分段续读：拼回原文、末段 nextOffset 为 null、单段有上下限', () => {
    const file = path.join(home, 'big-segment.txt');
    const body = 'A'.repeat(15000) + 'B'.repeat(5000);
    fs.writeFileSync(file, body);
    store.db.prepare('INSERT OR REPLACE INTO business_materials(session_id,id,source_url,digest,record) VALUES(?,?,?,?,?)')
      .run('mat', 'material-big', endpoint + '/big.txt', 'd'.repeat(64),
        JSON.stringify({ id: 'material-big', file, sourceUrl: endpoint + '/big.txt', hints: [], coverage: {} }));
    const read = (offset, limit) => materialsDetail(store, 'mat', { kind: 'file', id: 'material-big', offset, limit });
    const first = read(undefined, undefined);
    assert.equal(first.offset, 0); assert.equal(first.limit, 6000);
    assert.equal(first.totalBytes, 20000); assert.equal(first.nextOffset, 6000);
    assert.equal(first.preview.length, 6000); assert.equal(first.truncated, true);
    const second = read(first.nextOffset, first.limit);
    const third = read(second.nextOffset, second.limit);
    const last = read(third.nextOffset, third.limit);
    assert.equal(second.offset, 6000); assert.equal(third.offset, 12000); assert.equal(last.offset, 18000);
    assert.equal(last.preview.length, 2000, '最后一段只到文件末尾');
    assert.equal(last.nextOffset, null, '读完就没有下一段');
    assert.equal(last.truncated, false);
    assert.equal(first.preview + second.preview + third.preview + last.preview, body, '分段拼起来就是原文');
    assert.equal(read(0, 999999).limit, 16384, '单段上限 16KB');
    assert.equal(read(0, 1).limit, 512, '单段下限 512B');
  });
  test('pasted materials are classified by shape, not guessed', () => {
    assert.equal(detectFormat('GET /api HTTP/1.1\r\nHost: a.test\r\n\r\n'), 'http');
    assert.equal(detectFormat('curl -X POST https://a.test -d x=1'), 'curl');
    assert.equal(detectFormat('{"log":{"entries":[]}}'), 'har');
    assert.equal(detectFormat('const x = () => 1'), 'text');
    assert.equal(detectFormat('   '), 'empty');
    const har = summarizeHar(JSON.stringify({ log: { entries: [{ request: { url: 'https://a.test/1' } }, { request: {} }] } }));
    assert.equal(har.entries, 2); assert.equal(har.broken, 1); assert.deepEqual(har.hosts, ['a.test']);
    assert.equal(summarizeHar('{').invalid, true);
  });
  test('扫描导出与资产 CSV/JSON 被识别为各自的类型，并给出条目摘要', () => {
    const nmap = '<?xml version="1.0"?><nmaprun><host><address addr="10.0.0.1"/></host><host><address addr="10.0.0.2"/></host></nmaprun>';
    assert.equal(detectFormat(nmap), 'scan');
    const nmapSummary = summarizeScan(nmap);
    assert.equal(nmapSummary.kind, 'nmap-xml'); assert.equal(nmapSummary.entries, 2); assert.deepEqual(nmapSummary.hosts, ['10.0.0.1', '10.0.0.2']);
    const nuclei = '{"template-id":"cve-2021-1","matched-at":"https://a.test/x"}\n{"template-id":"cve-2021-2","matched-at":"https://b.test/y"}\n';
    assert.equal(detectFormat(nuclei), 'scan');
    assert.equal(summarizeScan(nuclei).entries, 2);
    const ffuf = JSON.stringify({ results: [{ url: 'https://a.test/admin', status: 200 }] });
    assert.equal(detectFormat(ffuf), 'scan');
    assert.equal(summarizeScan(ffuf).entries, 1);
    const csv = 'ip,port,domain\n10.0.0.1,80,a.test\n10.0.0.2,443,b.test\n';
    assert.equal(detectFormat(csv), 'assets');
    assert.equal(summarizeAssets(csv).entries, 2);
    const assetJson = JSON.stringify([{ ip: '10.0.0.1', port: 80 }, { host: 'b.test', port: 443 }]);
    assert.equal(detectFormat(assetJson), 'assets');
    assert.equal(summarizeAssets(assetJson).entries, 2);
    // 普通文本 CSV（无资产表头）不应被当成资产
    assert.equal(detectFormat('name,note\nalice,hi\n'), 'text');
    // 导入扫描导出时摘要带上类型
    const imported = importPastedMaterial(store, 'mat', { name: 'nuclei.jsonl', text: nuclei }, { home });
    assert.equal(imported.format, 'scan');
    assert.equal(imported.summary.entries, 2);
    const row = materialsList(store, 'mat', { type: 'file' }).rows.find(item => item.id === imported.id);
    assert.equal(row.meta.format, 'scan', 'the list exposes the detected format');
    assert.equal(row.meta.entries, 2, 'the list exposes the parsed entry count');
  });
  test('pasted import saves the original once, dedupes identical content and rejects empty or oversized input', () => {
    const first = importPastedMaterial(store, 'mat', { name: 'orders.http', text: 'GET /api/orders HTTP/1.1\r\nHost: app.example.test\r\n\r\n' }, { home });
    assert.equal(first.reused, false); assert.equal(first.format, 'http');
    assert(fs.existsSync(path.join(home, 'redteam-results', 'materials', 'mat', first.id + '.txt')), 'the original is written to disk');
    const again = importPastedMaterial(store, 'mat', { name: 'copy.http', text: 'GET /api/orders HTTP/1.1\r\nHost: app.example.test\r\n\r\n' }, { home });
    assert.equal(again.reused, true); assert.equal(again.id, first.id, 'identical content merges instead of duplicating');
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM business_materials WHERE session_id=? AND digest=?').get('mat', first.digest).n, 1);
    assert.throws(() => importPastedMaterial(store, 'mat', { text: '   ' }, { home }), /请先粘贴/);
    assert.throws(() => importPastedMaterial(store, 'mat', { text: 'x'.repeat(1024 * 1024 + 10) }, { home }), /超过 1MB/);
    // 导入后出现在资料列表里
    assert(materialsList(store, 'mat', { type: 'file' }).rows.some(row => row.id === first.id));
  });
  test('磁盘或数据库写入失败时不留半登记状态（故障注入）', () => {
    // 1) 目标目录位置被一个文件占住：mkdir 失败，必须直接报错且不写任何行。
    const blocked = path.join(home, 'redteam-results', 'materials', 'blocked-session');
    fs.mkdirSync(path.dirname(blocked), { recursive: true });
    fs.writeFileSync(blocked, 'not a directory');
    const before = store.db.prepare('SELECT count(*) AS n FROM business_materials WHERE session_id=?').get('blocked-session').n;
    assert.throws(() => importPastedMaterial(store, 'blocked-session', { text: 'GET /x HTTP/1.1\r\nHost: a.test\r\n\r\n' }, { home }), /ENOTDIR|EEXIST|not a directory/i);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM business_materials WHERE session_id=?').get('blocked-session').n, before, 'no row is registered when the write fails');
    // 2) 登记被数据库拒绝：刚写的原文必须被清掉，不留"有文件没记录"。
    const sid = 'db-fail';
    const dir = path.join(home, 'redteam-results', 'materials', sid);
    store.db.exec("CREATE TRIGGER reject_material_insert BEFORE INSERT ON business_materials WHEN NEW.session_id='" + sid + "' BEGIN SELECT RAISE(ABORT,'injected insert failure'); END");
    try {
      assert.throws(() => importPastedMaterial(store, sid, { text: 'GET /y HTTP/1.1\r\nHost: b.test\r\n\r\n' }, { home }), /injected insert failure/);
    } finally { store.db.exec('DROP TRIGGER reject_material_insert'); }
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM business_materials WHERE session_id=?').get(sid).n, 0, 'no half-registered row');
    const leftovers = fs.existsSync(dir) ? fs.readdirSync(dir).filter(name => name.endsWith('.txt')) : [];
    assert.deepEqual(leftovers, [], 'the orphaned original is removed when registration fails');
  });
  test('模型搜索测试资料：每页最多 5 条短结果、带来源/身份/时间与下一页游标，并按 3000 字节封顶', () => {
    const sid = 'search';
    const insert = (id, record) => store.db.prepare('INSERT INTO business_materials(session_id,id,source_url,digest,record) VALUES(?,?,?,?,?)')
      .run(sid, id, record.sourceUrl, 'c'.repeat(64), JSON.stringify(record));
    for (let i = 0; i < 8; i += 1) {
      insert('orders-' + i, { id: 'orders-' + i, file: 'C:/tmp/orders-' + i + '.js', name: 'orders-' + i + '.js',
        sourceUrl: 'https://app.example.test/static/orders-' + i + '.js', site: endpoint, indexedAt: 1700000000000 + i,
        hints: [], coverage: {} });
    }
    const page1 = searchMaterials(store, sid, { query: 'orders' });
    assert.equal(page1.pageSize, 5, '每页最多 5 条');
    assert.equal(page1.results.length, 5, '第一页给满 5 条');
    assert.equal(page1.total, 8);
    assert.equal(page1.nextOffset, 5, '给出下一页游标');
    assert(Buffer.byteLength(page1.text) <= 3000, '输出按 3000 UTF-8 字节封顶');
    // v6 第 5.4.1 节：没有可靠 tokenizer 时用的是 UTF-8 字节上限，必须标出来，不能让人当成精确 token。
    assert.equal(page1.unit, 'bytes-approx', '搜索结果是字节近似口径，要标明');
    for (const row of page1.results) {
      assert.deepEqual(Object.keys(row).sort(), ['id', 'identity', 'kind', 'name', 'source', 'time'], '短结果字段固定');
      assert.equal(row.kind, 'file');
      assert.match(row.source, /app\.example\.test/);
      assert.match(row.time, /^20\d\d-/, '已索引文件带导入时间');
    }
    const page2 = searchMaterials(store, sid, { query: 'orders', offset: page1.nextOffset });
    assert.equal(page2.results.length, 3, '第二页给剩下的 3 条');
    assert.equal(page2.nextOffset, null, '没有更多时游标为空');
    assert.throws(() => searchMaterials(store, sid, { query: '   ' }), /需要关键词/);
    assert.throws(() => searchMaterials(store, sid, { query: 'orders', offset: -1 }), /游标无效/);
    // 超长条目：宁可少给几条，也不越过 3000 字节。
    for (let i = 0; i < 5; i += 1) {
      insert('long-' + i + '-' + 'x'.repeat(400), { id: 'long-' + i + '-' + 'x'.repeat(400), file: 'C:/tmp/long.js',
        name: 'long-orders-' + i + '-' + 'y'.repeat(120) + '.js', sourceUrl: 'https://app.example.test/' + 'z'.repeat(120),
        site: endpoint, indexedAt: 1700000000000, hints: [], coverage: {} });
    }
    const long = searchMaterials(store, sid, { query: 'long-orders' });
    assert(Buffer.byteLength(long.text) <= 3000, '超长条目也要封顶');
    assert.equal(long.truncated, true, '被截断时明确标注');
    // 粘贴导入的材料记录没有 indexedAt：时间要退回原文件的写入时间，不能永远为空。
    importPastedMaterial(store, sid, { name: 'orders-pasted.txt', text: 'GET /orders HTTP/1.1\r\nHost: app.example.test\r\n\r\n' }, { home });
    const pasted = searchMaterials(store, sid, { query: 'orders-pasted' });
    assert.equal(pasted.results.length, 1, '能搜到刚粘贴的材料');
    assert.match(pasted.results[0].time, /^20\d\d-/, '粘贴材料的时间退回原文件写入时间');
  });
  test('新一批材料的变化通知按 480 UTF-8 字节封顶，保留总数并给出游标', () => {
    const sid = 'notice';
    startTaskPolicy(store, sid, { mode: 'regular', question: '检查账号权限与角色', budget: { toolCalls: 20 } });
    for (let i = 0; i < 6; i += 1) {
      store.db.prepare('INSERT INTO business_materials(session_id,id,source_url,digest,record) VALUES(?,?,?,?,?)')
        .run(sid, 'notice-' + i, endpoint + '/n' + i + '.js', 'd'.repeat(64), JSON.stringify({
          id: 'notice-' + i, file: 'C:/tmp/n' + i + '.js', name: 'n' + i + '.js', sourceUrl: endpoint + '/n' + i + '.js',
          site: endpoint, indexedAt: 1700000000000, coverage: {},
          hints: Array.from({ length: 6 }, (_, k) => ({ value: 'role permission auth token login 线索-' + i + '-' + k })),
        }));
    }
    const view = businessMaterialView(store, sid, { changedIds: Array.from({ length: 6 }, (_, i) => 'notice-' + i), indexed: 6 });
    const bytes = Buffer.byteLength(view.text, 'utf8');
    assert(bytes <= 480, '变化通知必须 ≤480 UTF-8 字节，实际 ' + bytes);
    assert.equal(view.hints, 36, '线索总数是关键字段，必须保留');
    assert.equal(view.files, 6, '文件总数是关键字段，必须保留');
    assert.match(view.next, /search=/, '超出时给游标而不是堆正文');
    // 「并标近似」是方案原话：口径说明不能被收缩逻辑先丢掉。
    assert.equal(view.unit, 'bytes-approx', '变化通知必须标出 480 是字节近似口径');
  });
  test('模型读原文：默认 ≤6000 字节、代码 ≤80 行、HTTP 分头/体并标截断位置', () => {
    const sid = 'excerpt';
    const code = Array.from({ length: 200 }, (_, i) => 'const line' + i + ' = ' + i + ';').join('\n');
    const codeMaterial = importPastedMaterial(store, sid, { name: 'big.js', text: code }, { home });
    const first = readMaterialExcerpt(store, sid, { id: codeMaterial.id });
    assert.equal(first.kind, 'code', '按扩展名识别为代码');
    assert(first.lines <= 80, '代码每段最多 80 行，实际 ' + first.lines);
    assert(first.nextOffset > 0, '有后续内容时给 nextOffset');
    const second = readMaterialExcerpt(store, sid, { id: codeMaterial.id, offset: first.nextOffset });
    assert(second.lines > 0, '用 nextOffset 能续读到下一段');
    assert.notEqual(second.content, first.content, '续读的是不同段落');
    // 行短、字节先到：每行足够长时 80 行还没到就先撞 6000 字节；此时 note 必须承认还有后续。
    const wide = Array.from({ length: 200 }, (_, i) => 'const wide' + i + ' = "' + 'x'.repeat(160) + '";').join('\n');
    const wideMaterial = importPastedMaterial(store, sid, { name: 'wide.js', text: wide }, { home });
    const wideFirst = readMaterialExcerpt(store, sid, { id: wideMaterial.id });
    assert.equal(wideFirst.kind, 'code');
    assert(wideFirst.lines < 80, '字节先到时行数会小于 80，实际 ' + wideFirst.lines);
    assert(wideFirst.nextOffset > 0, '字节截断也要给续读位置');
    assert.match(wideFirst.note, /续读/, '有后续时 note 不能说"没有更多内容"');
    assert.doesNotMatch(wideFirst.note, /没有更多内容/, 'note 不能与 nextOffset 自相矛盾');
    // HTTP：头与体分开给，并标出截断落在哪一段。
    const httpMaterial = importPastedMaterial(store, sid, { name: 'req.txt', text: 'GET /a HTTP/1.1\r\nHost: app.example.test\r\n\r\nBODY-BYTES' }, { home });
    const http = readMaterialExcerpt(store, sid, { id: httpMaterial.id });
    assert.equal(http.kind, 'http');
    assert.match(http.head, /^GET \/a HTTP\/1\.1/);
    assert.equal(http.body, 'BODY-BYTES');
    assert.equal(http.headTruncated, false);
    assert.equal(http.bodyTruncated, false);
    // 头本身就超过 6000 字节：只有头被截断，体还没轮到，headTruncated 必须为 true。
    const bigHead = 'GET /huge HTTP/1.1\r\nHost: app.example.test\r\nX-Pad: ' + 'p'.repeat(7000) + '\r\n\r\nBODY';
    const bigHeadMaterial = importPastedMaterial(store, sid, { name: 'huge.txt', text: bigHead }, { home });
    const bigHeadRead = readMaterialExcerpt(store, sid, { id: bigHeadMaterial.id });
    assert.equal(bigHeadRead.kind, 'http');
    assert.equal(bigHeadRead.headTruncated, true, '头被截断要标出来');
    assert.equal(bigHeadRead.bodyTruncated, false, '体还没轮到就不算体截断');
    assert.equal(bigHeadRead.body, '', '头没读完就没有体');
    assert(bigHeadRead.nextOffset > 0, '头截断也要给续读位置');
    // 原始文件不在本机时如实说缺，不假装读到内容。
    const gone = importPastedMaterial(store, sid, { name: 'gone.js', text: 'const a = 1;' }, { home });
    const goneRow = store.db.prepare('SELECT record FROM business_materials WHERE session_id=? AND id=?').get(sid, gone.id);
    fs.rmSync(JSON.parse(goneRow.record).file, { force: true });
    assert.equal(readMaterialExcerpt(store, sid, { id: gone.id }).missing, true);
    assert.throws(() => readMaterialExcerpt(store, sid, { id: 'nope' }), /材料不存在/);
    assert.throws(() => readMaterialExcerpt(store, sid, { id: codeMaterial.id, offset: -1 }), /读取偏移无效/);
    assert.throws(() => readMaterialExcerpt(store, sid, {}), /需要 material id/);
  });
  test('模型读过原文后列表标出「已收到对应片段」，没读过就是「尚未读取」', () => {
    const sid = 'read-flag';
    const material = importPastedMaterial(store, sid, { name: 'flag.txt', text: 'hello world' }, { home });
    const before = materialsList(store, sid, {}).rows.find(row => row.id === material.id);
    assert.equal(before.modelRead, false, '没读过就是尚未读取');
    assert.equal(before.readAt, null);
    recordMaterialRead(store, sid, { materialId: materialReadKey('file', material.id), bytes: 11 });
    const after = materialsList(store, sid, {}).rows.find(row => row.id === material.id);
    assert.equal(after.modelRead, true, '读过之后标为已收到对应片段');
    assert.match(after.readAt, /^20\d\d-/, '带读取时间');
  });
  test('本地查看与模型收到分开保存，并能按读取状态筛选（v6 第 5.4 节）', () => {
    const sid = 'read-vs-view';
    const a = importPastedMaterial(store, sid, { name: 'local.txt', text: 'only locally viewed' }, { home });
    const b = importPastedMaterial(store, sid, { name: 'model.txt', text: 'model read this one' }, { home });
    const c = importPastedMaterial(store, sid, { name: 'untouched.txt', text: 'nobody touched this' }, { home });
    recordMaterialView(store, sid, { materialId: materialReadKey('file', a.id) });
    recordMaterialRead(store, sid, { materialId: materialReadKey('file', b.id), bytes: 19 });
    const rows = materialsList(store, sid, { pageSize: 50 }).rows;
    const rowA = rows.find(row => row.id === a.id), rowB = rows.find(row => row.id === b.id), rowC = rows.find(row => row.id === c.id);
    assert.equal(Boolean(rowA.viewedAt), true, '本地看过带查看时间');
    assert.equal(rowA.modelRead, false, '本地查看不冒充模型读过');
    assert.equal(rowB.modelRead, true, '模型读过仍单独记');
    assert.equal(rowB.viewedAt, null, '模型读取不冒充本地看过');
    assert.equal(rowC.modelRead, false);
    assert.equal(rowC.viewedAt, null);
    assert.deepEqual(materialsList(store, sid, { read: 'model', pageSize: 50 }).rows.map(row => row.id), [b.id], '只看 AI 读过');
    assert.deepEqual(materialsList(store, sid, { read: 'local', pageSize: 50 }).rows.map(row => row.id), [a.id], '只看本地看过');
    const unread = materialsList(store, sid, { read: 'unread', pageSize: 50 });
    assert.deepEqual(unread.rows.map(row => row.id), [c.id], '只看都没读过');
    assert.equal(unread.read, 'unread', '返回里带当前筛选');
    assert.throws(() => materialsList(store, sid, { read: 'bogus' }), /读取筛选/);
  });
  test('导入带 Cookie/Authorization 的原文只记身份线索，不保存秘密，归属未定就是待关联', () => {
    const sid = 'identity';
    const material = importPastedMaterial(store, sid, { name: 'with-identity.txt',
      text: 'GET /api/me HTTP/1.1\r\nHost: app.example.test\r\nCookie: sid=SECRET-COOKIE-VALUE\r\nAuthorization: Bearer SECRET-TOKEN\r\n\r\n' }, { home });
    assert(material.identities.some(item => item.kind === 'cookie'), '识别出 Cookie 身份线索');
    assert(material.identities.some(item => item.kind === 'authorization'), '识别出 Authorization 身份线索');
    assert(material.identities.every(item => item.linked === false), '归属未确定就是待关联');
    const stored = store.db.prepare('SELECT record FROM business_materials WHERE session_id=? AND id=?').get(sid, material.id).record;
    assert(!stored.includes('SECRET-COOKIE-VALUE') && !stored.includes('SECRET-TOKEN'), '资料记录里不能保存秘密本身');
    const row = materialsList(store, sid, {}).rows.find(item => item.id === material.id);
    assert.equal(row.meta.identities, 2, '列表行带身份线索数');
    const detail = materialsDetail(store, sid, { kind: 'file', id: material.id });
    assert.equal(detail.identities.length, 2, '详情给出身份线索，界面据此显示待关联');
  });
  test('问题引用原文后详情显示关联问题；移除只移除引用，仍被引用时拒绝', () => {
    const sid = 'assoc';
    const material = importPastedMaterial(store, sid, { name: 'assoc.js', text: 'const a = 1;' }, { home });
    const finding = registerFinding(store, sid, 'pentest', { title: '关联问题用例', target: 'https://app.example.test', summary: 'x',
      evidenceRefs: [{ kind: 'file', id: material.id }] });
    const detail = materialsDetail(store, sid, { kind: 'file', id: material.id });
    assert.equal(detail.relatedFindings.length, 1, '详情要列出关联问题');
    assert.equal(detail.relatedFindings[0].id, finding.id);
    assert.throws(() => removeMaterial(store, sid, { id: material.id }), /仍被 1 个问题引用/, '被问题引用的原文不能直接移除');
    // 去掉引用后可以移除；磁盘原文仍在（只移除引用，磁盘清理另做引用检查）。
    updateFinding(store, sid, 'pentest', finding.id, { evidenceRefs: [] });
    const file = JSON.parse(store.db.prepare('SELECT record FROM business_materials WHERE session_id=? AND id=?').get(sid, material.id).record).file;
    assert.equal(removeMaterial(store, sid, { id: material.id }).removed, true);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM business_materials WHERE session_id=? AND id=?').get(sid, material.id).n, 0, '引用已移除');
    assert(fs.existsSync(file), '磁盘原文仍在');
    assert.throws(() => removeMaterial(store, sid, { id: material.id }), /不在当前任务/, '重复移除要如实报错');
  });
  test('HAR 的条目数与坏记录数进入列表元数据（v6 第 10.3 节 E09）', () => {
    const sid = 'e09-view';
    const text = fs.readFileSync(new URL('../benchmarks/material-tasks/e09-har-mixed-accounts.har.json', import.meta.url), 'utf8');
    const material = importPastedMaterial(store, sid, { name: 'mixed-accounts.har.json', text }, { home });
    const row = materialsList(store, sid, {}).rows.find(item => item.id === material.id);
    assert(row, '导入的 HAR 必须出现在资料列表里');
    assert.equal(row.meta.format, 'har');
    assert.equal(row.meta.entries, 6, '条目数要透出，界面才知道这份 HAR 有几条');
    assert.equal(row.meta.broken, 1, '坏记录数要透出，不能只报“已索引”');
    assert.deepEqual(row.meta.hosts, ['portal.example.test']);
    // 详情要能定位坏记录（v6 第 10.5 节 UI05）：第 4 条缺 request.url。
    const detail = materialsDetail(store, sid, { kind: 'file', id: material.id });
    assert.equal(detail.importSummary.broken, 1);
    assert.equal(detail.importSummary.entries, 6);
    assert.equal(detail.importSummary.brokenEntries.length, 1);
    assert.equal(detail.importSummary.brokenEntries[0].index, 4);
    assert.match(detail.importSummary.brokenEntries[0].reason, /request\.url|缺少/);
    // 升级前导入的旧记录可能只有坏记录总数，没有 brokenEntries；
    // 详情仍要从本地原文重算“第几条、为什么”，不能让历史资料退回只有总数。
    const stale = JSON.parse(store.db.prepare('SELECT record FROM business_materials WHERE session_id=? AND id=?').get(sid, material.id).record);
    delete stale.summary.brokenEntries;
    store.db.prepare('UPDATE business_materials SET record=? WHERE session_id=? AND id=?').run(JSON.stringify(stale), sid, material.id);
    const staleDetail = materialsDetail(store, sid, { kind: 'file', id: material.id });
    assert.equal(staleDetail.importSummary.brokenEntries.length, 1, '旧记录也要能定位坏记录');
    assert.equal(staleDetail.importSummary.brokenEntries[0].index, 4);
    assert.match(staleDetail.importSummary.brokenEntries[0].reason, /request\.url|缺少/);
    // 客户端按这两个字段渲染“N 条坏记录 / 有坏记录”（见 lib/client.js materialsCells）。
    const clientSource = fs.readFileSync(new URL('../plugins/dsh-redteam-results/lib/client.js', import.meta.url), 'utf8');
    assert(clientSource.includes("m.broken + ' 条坏记录'"), '列表要显示坏记录数');
    assert(clientSource.includes("m.broken ? '有坏记录'"), '状态列要显示有坏记录');
  });
} finally { store.close(); fs.rmSync(home, { recursive: true, force: true }); }
console.log(`${failed ? failed + ' failed' : 'all passed'}`); if (failed) process.exitCode = 1;
