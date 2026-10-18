// 知识索引/检索性能测量器的夹具检查：测量本身要可信，先证明它测得准。
//
// 断言的是"测量器有没有真的测到东西"，不是绝对性能门槛（绝对数字随机器变化，
// 写死门槛只会变成噪声）。真正的性能数字由 measure-knowledge-performance.mjs 产出报告。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QUERIES, runMeasurement, writeSyntheticCorpus } from './measure-knowledge-performance.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const boundary = resolve(root, '..', '_ref', 'tmp');
const scratch = mkdtempSync(join(boundary, 'knowledge-perf-'));

let failed = 0;
async function test(label, fn) {
  try { await fn(); console.log('ok ' + label); }
  catch (error) { failed++; console.log('FAIL ' + label + ': ' + error.stack); }
}

try {
  await test('the synthetic corpus is byte-deterministic for the same file count', () => {
    const first = writeSyntheticCorpus(join(scratch, 'corpus-a'), 40);
    const second = writeSyntheticCorpus(join(scratch, 'corpus-b'), 40);
    assert.equal(first.files, 40);
    assert(first.bytes > 0);
    assert.equal(first.digest, second.digest, 'same parameters must produce the same corpus digest');
  });

  await test('the measurement really indexes the corpus and answers every fixed query', () => {
    const report = runMeasurement({ corpus: join(scratch, 'corpus-a'), dbPath: join(scratch, 'index-a.sqlite'), repeats: 3 });
    assert.equal(report.corpus.files, 40);
    assert.equal(report.index.docs, 40, 'every synthetic markdown file must be indexed');
    assert(report.index.chunks >= report.index.docs, 'each document must produce at least one chunk');
    assert(report.index.bytes > 0, 'the index must occupy bytes on disk');
    assert(Number.isFinite(report.build.ms) && report.build.ms >= 0);
    assert(report.build.filesPerSecond > 0);
    assert.equal(report.search.samples, QUERIES.length * 3);
    for (const key of ['p50Ms', 'p95Ms', 'maxMs']) assert(Number.isFinite(report.search[key]), `latency ${key} must be a number`);
    assert(report.search.p50Ms <= report.search.p95Ms && report.search.p95Ms <= report.search.maxMs);
    assert.equal(report.firstPass.length, QUERIES.length);
    for (const entry of report.firstPass) {
      assert(entry.results > 0, `query must return hits: ${entry.query}`);
      assert(typeof entry.topPath === 'string' && entry.topPath.endsWith('.md'));
    }
    const latin = report.firstPass.find(entry => entry.query === 'sql injection payload');
    assert(latin.topPath.includes('sql-injection'), 'a Latin term query must rank its own topic first');
    const han = report.firstPass.find(entry => entry.query === '命令注入 绕过');
    assert(han.topPath.includes('command-injection'), 'a CJK term query must rank its own topic first');
  });

  await test('the measurement refuses an index path outside the workspace temporary area', () => {
    assert.throws(() => runMeasurement({ corpus: join(scratch, 'corpus-a'), dbPath: join(root, 'knowledge.sqlite') }),
      /must stay under/, 'writing the index outside _ref/tmp must be refused');
  });
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

process.exitCode = failed ? 1 : 0;
