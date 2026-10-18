// 知识索引的**增量**一致性：宿主每次启动走的都是这条路径，但此前没有行为级覆盖。
//
// 为什么单独立一套：`measure-knowledge-performance.mjs` 只回答"多快"，
// 这一套回答"增量重建之后索引内容对不对"——加文件、改内容（含**同长度**改动）、删文件、
// 改名、只改 mtime、以及某个来源整体消失，六种情况下 `search()` 的结果都必须跟着变。
//
// **已知的夹具局限（2026-10-11 实测）**：跳过条件里的 sha1 那一支——"同长度 **且** 同 mtime
// 的原地改写"——在本平台构造不出来：`utimesSync` 恢复的 `mtimeMs` 有亚毫秒残差
// （`Date` 会丢掉小数、浮点秒回写也落不回原值，迭代修正 8 次仍差约 800ns）。
// 所以这一支只有代码审查覆盖，没有夹具证明；能证明的是"同长度但 mtime 变"必须重新索引。
//
// 引擎零依赖（只用 node: 内置），所以不需要官方 Desktop。
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KnowledgeIndex } from '../plugins/dsh-knowledge-hub/lib/index-engine.js';
import { testTempRoot } from './lib/test-temp-root.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const boundary = testTempRoot(import.meta.url);
const scratch = mkdtempSync(join(boundary, 'knowledge-incremental-'));
const corpus = join(scratch, 'corpus');
const extra = join(scratch, 'extra');

const writeDoc = (base, rel, text) => {
  const full = join(base, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text, 'utf8');
  return full;
};
const doc = (body, marker) => `# ${marker}\n\n${marker} 的正文。\n\n${body}\n`;
const pathsFor = (index, query) => index.search(query, { limit: 8 }).map(hit => hit.path);

let failed = 0;
async function test(label, fn) {
  try { await fn(); console.log('ok ' + label); }
  catch (error) { failed++; console.log('FAIL ' + label + ': ' + error.stack); }
}

const index = new KnowledgeIndex({
  dbPath: join(scratch, 'index.sqlite'),
  roots: [
    { root: corpus, kind: 'preset', mode: 'general', packId: 'incremental-fixture' },
    { root: extra, kind: 'import', mode: 'general', packId: 'extra-fixture' },
  ],
  logger: { info() {}, warn() {}, error() {} },
});

try {
  writeDoc(corpus, 'alpha.md', doc('只有这篇文档提到 alphamarker。', 'alphamarker'));
  writeDoc(corpus, 'beta.md', doc('只有这篇文档提到 betamarker。', 'betamarker'));
  writeDoc(extra, 'extra.md', doc('这是额外来源里的 gammamarker。', 'gammamarker'));

  await test('the first build indexes every document in every source', () => {
    const build = index.rebuild({ force: true });
    assert.equal(build.filesIndexed, 3);
    assert.equal(build.filesSkipped, 0);
    assert.equal(index.status({ counts: true }).docs, 3);
    assert.deepEqual(pathsFor(index, 'alphamarker'), ['alpha.md']);
    assert.deepEqual(pathsFor(index, 'gammamarker'), ['extra.md']);
  });

  await test('an unchanged rebuild skips every file but still rewrites the index metadata', () => {
    const before = index.status({ counts: true });
    const build = index.rebuild({ force: false });
    assert.equal(build.filesIndexed, 0, 'nothing changed, so nothing may be re-indexed');
    assert.equal(build.filesSkipped, 3);
    assert.equal(build.filesRemoved, 0);
    const after = index.status({ counts: true });
    for (const key of ['version', 'docs', 'chunks', 'dirty', 'lastError']) assert.deepEqual(after[key], before[key], key);
    // 实测行为：一个文件都没重索引，`indexed_at` 仍会被这次 rebuild 覆盖。
    assert(after.indexedAt >= before.indexedAt, 'a no-op rebuild still rewrites the metadata timestamp');
    assert.deepEqual(pathsFor(index, 'alphamarker'), ['alpha.md']);
  });

  await test('a new file becomes searchable without touching the others', () => {
    writeDoc(corpus, 'delta.md', doc('新增文档提到 deltamarker。', 'deltamarker'));
    const build = index.rebuild({ force: false });
    assert.equal(build.filesIndexed, 1);
    assert.equal(build.filesSkipped, 3);
    assert.equal(index.status({ counts: true }).docs, 4);
    assert.deepEqual(pathsFor(index, 'deltamarker'), ['delta.md']);
  });

  await test('a same-size content edit re-indexes and drops the old text', () => {
    // 同长度替换：size 与之前完全一样，只有 sha1 变 —— 只比 size 的实现在这里会漏。
    writeDoc(corpus, 'beta.md', doc('只有这篇文档提到 zetamarker。', 'zetamarker'));
    const build = index.rebuild({ force: false });
    assert.equal(build.filesIndexed, 1, 'a same-size edit must still be re-indexed');
    assert.equal(build.filesSkipped, 3);
    assert.deepEqual(pathsFor(index, 'zetamarker'), ['beta.md']);
    assert.deepEqual(pathsFor(index, 'betamarker'), [], 'the replaced text must not stay searchable');
  });

  await test('a deleted file disappears from the index', () => {
    unlinkSync(join(corpus, 'delta.md'));
    const build = index.rebuild({ force: false });
    assert.equal(build.filesRemoved, 1);
    assert.equal(index.status({ counts: true }).docs, 3);
    assert.deepEqual(pathsFor(index, 'deltamarker'), []);
  });

  await test('a rename moves the indexed path instead of duplicating it', () => {
    writeDoc(corpus, 'renamed.md', doc('只有这篇文档提到 etamarker。', 'etamarker'));
    unlinkSync(join(corpus, 'alpha.md'));
    const build = index.rebuild({ force: false });
    assert.equal(build.filesRemoved, 1);
    assert.equal(build.filesIndexed, 1);
    assert.deepEqual(pathsFor(index, 'alphamarker'), [], 'the old path must be gone');
    assert.deepEqual(pathsFor(index, 'etamarker'), ['renamed.md']);
  });

  await test('touching a file without changing bytes still costs a re-index', () => {
    // 这是实测行为，不是理想行为：跳过条件是 size + mtime + sha1 三者全等，
    // 所以纯 mtime 变动会触发重新分块。把它钉住，改动时会被看见。
    const file = join(corpus, 'renamed.md');
    const future = new Date(Date.now() + 10_000);
    utimesSync(file, future, future);
    const build = index.rebuild({ force: false });
    assert.equal(build.filesIndexed, 1, 'a pure mtime bump is a re-index under the current skip rule');
    assert.equal(build.filesSkipped, 2);
  });

  await test('a source that disappears takes its documents with it', () => {
    index.roots = [{ root: corpus, kind: 'preset', mode: 'general', packId: 'incremental-fixture' }];
    const build = index.rebuild({ force: false });
    assert.equal(build.filesRemoved, 1, 'the extra source no longer exists, so its document must go');
    assert.deepEqual(pathsFor(index, 'gammamarker'), []);
    assert.equal(index.status({ counts: true }).docs, 2);
  });

  await test('a writing rebuild truncates the write-ahead log instead of leaving a second copy of the index', () => {
    // 语料必须大到让索引超过 `wal_autocheckpoint`（1000 页 ≈ 4 MB），否则这条断言不可证伪：
    // 小库在提交时就被 passive checkpoint 收拾了，看不出"WAL 留着整份索引"这件事。
    // 真 home 实测：604.6 MB 索引 + 979.6 MB WAL（宿主进程一直开着，没人 close 它）。
    const big = join(scratch, 'wal-corpus');
    const fileCount = 1600;
    const filler = '针对 waltruncatemarker 的检查项，记录请求与响应原文与判定依据。'.repeat(10);
    for (let i = 0; i < fileCount; i++) writeDoc(big, `note-${String(i).padStart(4, '0')}.md`, doc(filler, `waltruncatemarker-${i}`));
    const dbPath = join(scratch, 'wal-index.sqlite');
    const walPath = `${dbPath}-wal`;
    const walIndex = new KnowledgeIndex({ dbPath,
      roots: [{ root: big, kind: 'preset', mode: 'general', packId: 'wal-fixture' }],
      logger: { info() {}, warn() {}, error() {} } });
    try {
      const build = walIndex.rebuild({ force: true });
      assert.equal(build.filesIndexed, fileCount);
      assert(build.walTruncated === true, 'a writing rebuild must report a successful WAL truncation');
      const dbBytes = statSync(dbPath).size;
      assert(dbBytes > 4 * 1024 * 1024, `fixture must exceed the autocheckpoint threshold, got ${dbBytes} bytes`);
      const walBytes = existsSync(walPath) ? statSync(walPath).size : 0;
      assert(walBytes < 1024 * 1024, `WAL must be truncated after a writing rebuild, got ${walBytes} bytes for a ${dbBytes} byte index`);
    } finally { walIndex.close(); }
  });

  await test('status reports reclaimable dead space only when counts are explicitly requested', () => {
    // 死空间比例是给"要不要 VACUUM"提供依据的；检索路径上每次都会问 status()，
    // 所以它必须跟计数一样被缓存：普通调用只回缓存值，显式要计数时才刷新。
    const dbPath = join(scratch, 'dead-space.sqlite');
    const probe = new KnowledgeIndex({ dbPath, roots: [{ root: corpus, kind: 'preset', mode: 'general', packId: 'dead-space' }],
      logger: { info() {}, warn() {}, error() {} } });
    try {
      probe.open();
      const counted = probe.status({ counts: true });
      assert(counted.deadSpace, 'an explicit counts request must report dead space');
      assert(Number.isInteger(counted.deadSpace.freePages) && Number.isInteger(counted.deadSpace.pages));
      assert(counted.deadSpace.pages > 0, 'page_count must be readable from the header');
      assert(counted.deadSpace.ratio >= 0 && counted.deadSpace.ratio <= 1, `ratio out of range: ${counted.deadSpace.ratio}`);
      // 造一批空闲页：普通 status() 必须仍报缓存值，显式要计数时才刷新。
      probe.db.exec('CREATE TABLE free_pages_fixture(x BLOB)');
      const insert = probe.db.prepare('INSERT INTO free_pages_fixture(x) VALUES(zeroblob(4096))');
      for (let i = 0; i < 400; i++) insert.run();
      probe.db.exec('DROP TABLE free_pages_fixture');
      assert.deepEqual(probe.status().deadSpace, counted.deadSpace, 'a plain status() must reuse the cached ratio');
      const refreshed = probe.status({ counts: true });
      assert(refreshed.deadSpace.freePages > counted.deadSpace.freePages,
        `an explicit counts request must refresh the ratio (${counted.deadSpace.freePages} → ${refreshed.deadSpace.freePages})`);
    } finally { probe.close(); }
  });
} finally {
  index.close();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

process.exitCode = failed ? 1 : 0;
