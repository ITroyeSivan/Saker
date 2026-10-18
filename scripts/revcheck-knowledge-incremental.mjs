// 反向检查：把知识索引引擎的增量判定改坏，要求 test-knowledge-incremental.mjs 必须失败。
//
// 为什么需要：那一套断言的是"增量重建之后索引内容对不对"。如果引擎改成"只比 size+mtime"、
// 或者干脆不再清理消失的文档，套件必须能抓到 —— 否则它只是一份会永远通过的装饰。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const boundary = resolve(root, '..', '_ref', 'tmp');
const enginePath = join(root, 'plugins', 'dsh-knowledge-hub', 'lib', 'index-engine.js');
const suitePath = join(root, 'scripts', 'test-knowledge-incremental.mjs');
const suiteBefore = readFileSync(suitePath, 'utf8');

const variants = [
  {
    id: 'skip-by-size-only',
    // 只比 size 的实现会把"同长度改写"当成没变，旧内容留在索引里。
    // （sha1 那一支本身没有夹具覆盖 —— 见套件头部的已知局限说明。）
    from: 'Number(previous.size) === size && Number(previous.mtime_ms) === mtimeMs && previous.sha1 === sha1',
    to: 'Number(previous.size) === size',
    fail: 'a same-size content edit re-indexes and drops the old text',
  },
  {
    id: 'never-remove-disappeared-documents',
    from: 'if ((!activeSources.has(row.source_id) || !seen || !seen.has(row.path))) {',
    to: 'if (false) {',
    fail: 'a deleted file disappears from the index',
  },
  {
    id: 'wal-left-untruncated',
    // 写完不截短 WAL：宿主一直开着时，home 里就多占一份与索引等大的磁盘。
    from: 'if (stats.filesIndexed > 0 || stats.filesRemoved > 0) {',
    to: 'if (false) {',
    fail: 'a writing rebuild truncates the write-ahead log instead of leaving a second copy of the index',
  },
];

const directory = mkdtempSync(join(boundary, 'revcheck-knowledge-incremental-'));
let failures = 0;
try {
  const inside = relative(boundary, directory);
  assert(inside && !inside.startsWith('..') && !isAbsolute(inside), 'temporary directory escaped _ref/tmp');
  // 引擎的依赖要一起搬过去：只拷 index-engine.js 的话，变异副本一加载就因找不到
  // ./product-aliases.js 崩掉，反向检查会变成"没抓到目标断言"的假失败。
  writeFileSync(join(directory, 'product-aliases.js'),
    readFileSync(join(root, 'plugins', 'dsh-knowledge-hub', 'lib', 'product-aliases.js'), 'utf8'), 'utf8');
  for (const variant of variants) {
    const engine = readFileSync(enginePath, 'utf8');
    assert.equal(engine.split(variant.from).length - 1, 1, `${variant.id}: mutation must match exactly once`);
    const mutated = join(directory, `${variant.id}.mjs`);
    writeFileSync(mutated, engine.replace(variant.from, variant.to), 'utf8');
    const runner = join(directory, `${variant.id}-test.mjs`);
    writeFileSync(runner, readFileSync(suitePath, 'utf8').replace("'../plugins/dsh-knowledge-hub/lib/index-engine.js'",
      JSON.stringify(pathToFileURL(mutated).href))
      // 复制到临时目录后 `./lib/...` 相对导入也会断，必须一起改成绝对 URL。
      .replace("'./lib/test-temp-root.mjs'", JSON.stringify(pathToFileURL(join(root, 'scripts', 'lib', 'test-temp-root.mjs')).href)), 'utf8');
    const result = spawnSync(process.execPath, [runner], {
      cwd: root, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, TEMP: boundary, TMP: boundary, TMPDIR: boundary },
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    try {
      assert.notEqual(result.status, 0, `${variant.id}: the mutated engine must make the suite fail`);
      assert(output.includes('FAIL ' + variant.fail), `${variant.id}: the targeted assertion must fail`);
      console.log(`ok reverse ${variant.id}: the incremental suite caught it`);
    } catch (error) {
      failures++;
      console.log(`FAIL reverse ${variant.id}: ${error.message}`);
      console.log(output.split('\n').slice(-12).join('\n'));
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  assert.equal(readFileSync(suitePath, 'utf8'), suiteBefore, 'the incremental suite changed during reverse checks');
}

process.exitCode = failures ? 1 : 0;
