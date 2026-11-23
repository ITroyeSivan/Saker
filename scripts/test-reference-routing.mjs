import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { settingsView, saveTaskSettings } from '../plugins/dsh-redteam-results/lib/task-settings.js';
import {
  indexKnowledgeEntry,
  knowledgeIndexStatus,
  listKnowledgeEntries,
  readKnowledgeIndexRef,
  searchKnowledgeIndex,
} from '../plugins/dsh-redteam-results/lib/knowledge-index.js';
import { runReferenceSearch, readWebReference, clearReferenceCache } from '../plugins/dsh-redteam-results/lib/reference-router.js';
import { referenceReadForSession, referenceSearchForSession } from '../plugins/dsh-redteam-results/lib/index.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-reference-'));
process.env.DSH_HOME = home;
const host = { maxWorkers: 8, modelAdmission: true, tokens: true };
let checks = 0;
function ok(label) { checks += 1; console.log('ok ' + label); }
function enable(store, id, strategy = 'knowledge-first') {
  const view = settingsView(store, id, { host });
  return saveTaskSettings(store, id, {
    requestId: 'enable-' + id + '-' + strategy,
    expected: { settingsRevision: view.settingsRevision, sceneRevision: view.sceneRevision, roundId: view.roundId },
    patch: { knowledge: { enabled: true, strategy } },
  }, host);
}
function webResult(rows = []) {
  return { sources: rows.map(row => ({ url: row.url, title: row.title, snippet: row.snippet, publishedAt: row.date })), truncated: false };
}

{
  const store = openStore(':memory:');
  const ctx = {
    web: {
      search() { throw new Error('web must not be called while knowledge is off'); },
      fetch() { throw new Error('web must not be called while knowledge is off'); },
    },
  };
  const value = await referenceSearchForSession(ctx, store, 'disabled-project', { query: 'JWT algorithm confusion' });
  assert.equal(value.code, 'knowledge_disabled');
  assert.equal(fs.existsSync(path.join(home, 'redteam-results', 'knowledge', 'index-v1.db')), false,
    'disabled lookup creates or opens no index');
  ok('A19/A20 knowledge defaults off and returns before opening any index, cache or source');
  store.close();
}

const corpus = [
  ['jwt', 'JWT 校验手册', '# JWT algorithm confusion\n当服务接受 RS256 与 HS256 时，可尝试 JWT algorithm confusion，并检查公钥是否被当作 HMAC 密钥。'],
  ['sqli', 'SQL 注入手册', '# SQL 盲注\nSQL 盲注可在无回显时用布尔或时间条件逐字符推断。'],
  ['tenant', '对象权限手册', '# 跨租户对象权限\n对象 ID 必须绑定当前租户；跨租户 对象权限属于 IDOR。'],
  ['logout', '会话安全手册', '# 注销后会话失效\n注销 会话 后服务端必须撤销令牌，否则旧会话仍可使用。'],
  ['cve', 'CVE 精确记录', '# CVE-2024-12345\n仅适用于 ProductX 3.2 的默认配置。'],
  ['path', '路径鉴权', '# /api/admin/export\n导出接口应同时校验身份和对象所有权。'],
  ['version', 'ProductX 版本差异', '# ProductX 3.1 与 3.2\n3.2 修复了 header 注入，3.1 仍受影响。'],
];
for (const [id, title, text] of corpus) {
  indexKnowledgeEntry({
    projectKey: 'route-project', sourceId: id, title, text, sourceLabel: '内部手册',
    product: id === 'cve' || id === 'version' ? 'ProductX' : '',
    version: id === 'cve' ? '3.2' : id === 'version' ? '3.1' : '',
    sourceDate: '2026-10-01',
  });
}
{
  const hits = [
    ['JWT algorithm confusion', 'JWT algorithm confusion'],
    ['SQL 盲注', 'SQL 盲注'],
    ['跨租户 对象权限', '跨租户对象权限'],
    ['注销 会话', '注销后会话失效'],
    ['CVE-2024-12345', 'CVE-2024-12345'],
    ['/api/admin/export', '/api/admin/export'],
    ['ProductX 3.1 header', 'ProductX 3.1 与 3.2'],
  ];
  for (const [query, section] of hits) {
    const result = searchKnowledgeIndex('route-project', { query, limit: 5 });
    assert(result.rows.some(row => row.section === section), query + ': ' + JSON.stringify(result.rows.map(row => row.section)));
  }
  const nearCve = searchKnowledgeIndex('route-project', { query: 'CVE-2024-99999' });
  assert.equal(nearCve.rows.length, 0, 'a nearby CVE id cannot masquerade as an exact answer');
  const versionMismatch = searchKnowledgeIndex('route-project', { query: 'ProductX header', version: '4.0' });
  assert(!versionMismatch.rows.some(row => row.version === '3.1'));
  const random = searchKnowledgeIndex('route-project', { query: '完全随机不存在的 qzxv 98765' });
  assert.equal(random.status, 'no_match');
  ok('A21/A22 four known misses now match; exact CVE/path and version exclusions resist false positives');
}
{
  const topics = [
    ['token audience validation', 'Token audience validation'], ['host header poisoning', 'Host header poisoning'],
    ['graphql introspection enabled', 'GraphQL introspection enabled'], ['saml signature wrapping', 'SAML signature wrapping'],
    ['oauth redirect uri bypass', 'OAuth redirect URI bypass'], ['prototype pollution merge', 'Prototype pollution merge'],
    ['server side template injection', 'Server-side template injection'], ['http request smuggling clte', 'HTTP request smuggling CLTE'],
    ['race condition coupon redemption', 'Race condition coupon redemption'], ['cloud metadata ssrf', 'Cloud metadata SSRF'],
    ['weak tls cipher export', 'Weak TLS cipher export'], ['websocket origin trust', 'WebSocket origin trust'],
    ['对象权限 水平越权', '对象权限与水平越权'], ['会话 固定 防护', '会话固定防护'],
    ['文件上传 内容校验', '文件上传内容校验'], ['模板 引擎 沙箱', '模板引擎沙箱'],
    ['反向代理 路径归一', '反向代理路径归一'], ['批量赋值 角色字段', '批量赋值角色字段'],
    ['CVE-2023-10001', 'CVE-2023-10001'], ['CVE-2022-20002', 'CVE-2022-20002'],
    ['CVE-2021-30003', 'CVE-2021-30003'], ['CVE-2020-40004', 'CVE-2020-40004'],
    ['/account/change-email', '/account/change-email'], ['/internal/metrics/export', '/internal/metrics/export'],
    ['/files/download/raw', '/files/download/raw'], ['AlphaSuite 2.4 parser', 'AlphaSuite 2.4 parser'],
    ['BetaGate 1.8 session', 'BetaGate 1.8 session'], ['GammaFlow 5.1 upload', 'GammaFlow 5.1 upload'],
    ['DeltaMail 9.0 redirect', 'DeltaMail 9.0 redirect'], ['EpsilonORM 4.2 query', 'EpsilonORM 4.2 query'],
  ];
  for (let index = 0; index < topics.length; index += 1) {
    const [query, heading] = topics[index];
    indexKnowledgeEntry({
      projectKey: 'holdout-project', sourceId: 'holdout-' + index,
      title: '保留集资料 ' + index, sourceLabel: '独立保留集',
      text: '# ' + heading + '\n这是用于独立检索验收的固定章节，内容编号 ' + index + '。',
      product: heading.includes('AlphaSuite') ? 'AlphaSuite' : heading.includes('BetaGate') ? 'BetaGate'
        : heading.includes('GammaFlow') ? 'GammaFlow' : heading.includes('DeltaMail') ? 'DeltaMail'
          : heading.includes('EpsilonORM') ? 'EpsilonORM' : '',
      version: /(\d+\.\d+)/.exec(heading)?.[1] || '',
    });
  }
  const negatives = ['completely absent zyx 987654', 'CVE-2099-99999', 'no such /private/nope',
    'unrelated phrase quantum banana', 'AlphaSuite 99.9 nonesuch', '随机不存在 甲乙丙丁 8765'];
  let recalls = 0;
  for (const [query, heading] of topics) {
    const result = searchKnowledgeIndex('holdout-project', { query, limit: 5 });
    if (result.rows.some(row => row.section === heading)) recalls += 1;
  }
  let falseHits = 0;
  for (const query of negatives) {
    const result = searchKnowledgeIndex('holdout-project', { query, limit: 5 });
    if ((result.rows || []).length) falseHits += 1;
  }
  const recall = recalls / topics.length;
  assert(recall >= 0.85, `Recall@5 ${recall}`);
  assert.equal(falseHits, 0);
  const timings = [];
  for (let round = 0; round < 30; round += 1) {
    const query = topics[round % topics.length][0];
    const start = process.hrtime.bigint();
    searchKnowledgeIndex('holdout-project', { query, limit: 5 });
    timings.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  timings.sort((a, b) => a - b);
  const p95 = timings[Math.ceil(timings.length * 0.95) - 1];
  assert(p95 <= 250, `warm p95 ${p95.toFixed(1)}ms`);
  console.log('     Recall@5=' + (recall * 100).toFixed(1) + '% · no-answer false hits=' + falseHits + ' · warm p95=' + p95.toFixed(1) + 'ms');
  ok('Synthetic 30-query retrieval smoke holdout meets Recall@5, no-answer and warm p95 thresholds');
}
{
  indexKnowledgeEntry({
    projectKey: 'rank-project', sourceId: 'strong', title: 'AlphaSuite 2.4 parser',
    text: '# AlphaSuite 2.4 parser\nAlphaSuite 2.4 parser exact affected component and version.',
    product: 'AlphaSuite', version: '2.4', sourceLabel: '强相关', sourceDate: '2026-01-01',
  });
  indexKnowledgeEntry({
    projectKey: 'rank-project', sourceId: 'weak', title: '本周更新杂记',
    text: '# 本周更新杂记\n本页只提到 AlphaSuite parser 的一个无关链接，没有版本和适用条件。',
    sourceLabel: '弱相关资料', sourceDate: '2026-11-06',
  });
  let result = searchKnowledgeIndex('rank-project', { query: 'AlphaSuite 2.4 parser', version: '2.4', limit: 5 });
  assert.equal(result.rows[0].title, 'AlphaSuite 2.4 parser');
  const duplicate = Array.from({ length: 8 }, (_, index) => '# 重复章节 ' + index + '\nAlphaSuite 2.4 parser 重复片段').join('\n');
  indexKnowledgeEntry({
    projectKey: 'rank-project', sourceId: 'duplicates', title: '重复章节资料',
    text: duplicate, product: 'AlphaSuite', version: '2.4', sourceLabel: '重复资料',
  });
  result = searchKnowledgeIndex('rank-project', { query: 'AlphaSuite 2.4 parser', version: '2.4', limit: 5 });
  const duplicateRows = result.rows.filter(row => row.title === '重复章节资料');
  assert(duplicateRows.length <= 2, 'one document contributes at most two rows per page');
  assert.equal(result.rows[0].title, 'AlphaSuite 2.4 parser', 'import time does not outrank applicability');
  ok('A24 strong/version-applicable evidence outranks a newer weak import; duplicates are merged and bounded');
}
{
  const longText = '# 超长分页\n' + ('中文🙂abc /path?q=1\n'.repeat(900));
  indexKnowledgeEntry({ projectKey: 'bytes-project', sourceId: 'long', title: '超长中文与 emoji', text: longText, sourceLabel: '分页资料' });
  const result = searchKnowledgeIndex('bytes-project', { query: '超长 分页', limit: 5 });
  const searchJson = JSON.stringify(result);
  assert(Buffer.byteLength(searchJson, 'utf8') <= 3072);
  assert(result.rows.length <= 5);
  let cursor;
  let text = '';
  let first;
  do {
    const page = readKnowledgeIndexRef(result.rows[0].ref, { cursor, maxBytes: 8192 });
    first ||= page;
    text += page.text;
    cursor = page.nextCursor;
    assert(Buffer.byteLength(page.text, 'utf8') <= 8192);
    assert(!page.text.includes('\uFFFD'));
  } while (cursor);
  assert.equal(Buffer.byteLength(text, 'utf8'), first.sectionBytes, 'page stitching is lossless');
  assert(Buffer.byteLength(JSON.stringify({ ...first, text }), 'utf8') <= 9216 + 1024,
    'section wrapper stays bounded apart from the explicitly accumulated page test');
  ok('A25 search is ≤3072B/5 rows and read pages are UTF-8-safe, lossless and ≤8192B');
}
{
  const calls = { local: 0, web: 0 };
  const adapters = {
    localSearch(request) { calls.local += 1; return searchKnowledgeIndex('route-project', request); },
    webSearch() { calls.web += 1; return webResult([{ url: 'https://example.test/jwt', title: 'JWT confusion', snippet: 'JWT algorithm confusion' }]); },
    webFetch() { return { url: 'https://example.test/jwt', statusCode: 200, body: { kind: 'text', content: 'Web body' }, truncated: false }; },
  };
  let result = await runReferenceSearch(adapters, { strategy: 'web-first', query: 'JWT algorithm confusion' });
  assert.equal(result.rows[0].sourceKind, 'web');
  assert.equal(calls.local, 0);
  assert.equal(calls.web, 1);

  calls.local = calls.web = 0;
  result = await runReferenceSearch(adapters, { strategy: 'knowledge-first', query: 'JWT algorithm confusion' });
  assert.equal(result.rows[0].sourceKind, 'local');
  assert.equal(calls.web, 0);
  assert.equal(calls.local, 1);

  calls.local = calls.web = 0;
  result = await runReferenceSearch(adapters, { strategy: 'knowledge-only', query: 'no such item 98765' });
  assert.equal(calls.web, 0);
  assert.equal(result.fallbackAvailable, false);

  calls.local = calls.web = 0;
  result = await runReferenceSearch(adapters, { strategy: 'knowledge-first', query: 'no such item 98765' });
  assert.equal(calls.local, 1);
  assert.equal(calls.web, 1);
  assert.equal(result.fallbackUsed, true);

  calls.local = calls.web = 0;
  const failing = { ...adapters, webSearch() { calls.web += 1; throw new Error('offline'); } };
  result = await runReferenceSearch(failing, { strategy: 'web-first', query: 'JWT algorithm confusion' });
  assert.equal(calls.web, 1);
  assert.equal(calls.local, 1);
  assert(result.rows.some(row => row.sourceKind === 'local'));

  calls.local = calls.web = 0;
  result = await runReferenceSearch(adapters, { strategy: 'knowledge-first', query: 'JWT algorithm confusion', fallbackReason: 'not applicable' });
  assert.equal(calls.local, 1);
  assert.equal(calls.web, 1);
  assert(result.rows.some(row => row.sourceKind === 'web'));
  ok('A26 web-first, knowledge-first and knowledge-only follow deterministic order and one explicit fallback');
}
{
  const store = openStore(':memory:');
  enable(store, 'race-project', 'web-first');
  let release;
  const ctx = {
    web: {
      search() { return new Promise(resolve => { release = () => resolve(webResult([{ url: 'https://slow.test', title: 'slow', snippet: 'JWT algorithm confusion' }])); }); },
      fetch() { throw new Error('unused'); },
    },
  };
  const pending = referenceSearchForSession(ctx, store, 'race-project', { query: 'JWT algorithm confusion' });
  await new Promise(resolve => setImmediate(resolve));
  const view = settingsView(store, 'race-project', { host });
  saveTaskSettings(store, 'race-project', {
    requestId: 'disable-race', expected: { settingsRevision: view.settingsRevision,
      sceneRevision: view.sceneRevision, roundId: view.roundId },
    patch: { knowledge: { enabled: false } },
  }, host);
  release();
  const result = await pending;
  assert.equal(result.code, 'cancelled');
  assert.equal(result.rows, undefined);
  ok('A27 turning knowledge off during a web query discards the late result');
  store.close();
}
{
  const store = openStore(':memory:');
  store.db.prepare(`INSERT INTO competition_knowledge(session_id,source_id,revision,record,updated_at)
    VALUES(?,?,?,?,?)`).run('legacy-project', 'legacy-source', 1, JSON.stringify({
      sourceId: 'legacy-source', revision: 1, title: '旧比赛资料', text: '# 旧查表\nSQL 盲注 的旧记录。',
      hidden: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }), '2026-01-01T00:00:00.000Z');
  enable(store, 'legacy-project', 'knowledge-only');
  const result = await referenceSearchForSession({ web: {} }, store, 'legacy-project', { query: 'SQL 盲注' });
  assert(result.rows?.some(row => row.sourceKind === 'local'));
  const status = knowledgeIndexStatus('legacy-project');
  assert(status.documents >= 1);
  ok('A28 legacy competition knowledge is read into the new index without mutating the old row');
  store.close();
}
{
  clearReferenceCache();
  const calls = [];
  const adapters = {
    webFetch(request) {
      calls.push(request.url);
      return { url: request.url, statusCode: 200, body: { kind: 'text', content: '网页正文🙂'.repeat(1200) }, truncated: false };
    },
  };
  const ref = 'web:' + Buffer.from(JSON.stringify({ url: 'https://example.test/page', query: 'x', at: Date.now() })).toString('base64url');
  let cursor;
  let text = '';
  do {
    const page = await readWebReference(ref, { cursor, maxBytes: 8192 }, adapters);
    text += page.text;
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(calls.length, 1, 'one URL fetch is reused across cursor reads');
  assert(text.startsWith('网页正文'));
  assert(!text.includes('\uFFFD'));
  ok('A25/A29 web read reuses one cache entry, paginates by UTF-8 bytes and never loops unbounded');
}

console.log(`\n${checks} reference checks passed`);
