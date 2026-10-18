// 反向检查：把 `taskTransaction` 的自动开事务去掉，要求 test-write-failure-rollback.mjs 必须失败。
//
// 为什么需要：那条保护的要点是"一笔任务写入要么全成、要么全不落"。如果事务被删掉，
// 事件触发器 ABORT 时 `task_module_choices` 会留下半写行 —— 套件必须能抓到。
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const boundary = resolve(root, '..', '_ref', 'tmp');
const lib = join(root, 'plugins', 'dsh-redteam-results', 'lib');
const module = join(lib, 'task-policy-record.js');
const suite = join(root, 'scripts', 'test-write-failure-rollback.mjs');
const stub = join(root, 'scripts', 'test-stub-register.mjs');
const suiteBefore = readFileSync(suite, 'utf8');

const variants = [
  { id: 'transaction-removed', from: 'const own = !store.db.isTransaction;', to: 'const own = false && !store.db.isTransaction;',
    fail: '写到中途失败（事件表触发器 ABORT）也不能留下已写的 policy 行' },
];

let failures = 0;
for (const variant of variants) {
  const directory = mkdtempSync(join(boundary, `revcheck-write-failure-${variant.id}-`));
  try {
    const inside = relative(boundary, directory);
    assert(inside && !inside.startsWith('..') && !isAbsolute(inside), 'temporary directory escaped _ref/tmp');
    cpSync(lib, join(directory, 'plugins/dsh-redteam-results/lib'), { recursive: true });
    const target = join(directory, 'plugins/dsh-redteam-results/lib/task-policy-record.js');
    const source = readFileSync(module, 'utf8');
    assert.equal(source.split(variant.from).length - 1, 1, `${variant.id}: exact mutation anchor`);
    writeFileSync(target, source.replace(variant.from, variant.to));
    const runner = join(directory, 'test-write-failure-rollback.mjs');
    writeFileSync(runner, readFileSync(suite, 'utf8')
      .replace("'../plugins/dsh-redteam-results/lib/store.js'", JSON.stringify(pathToFileURL(join(directory, 'plugins/dsh-redteam-results/lib/store.js')).href))
      .replace("'../plugins/dsh-redteam-results/lib/task-policy.js'", JSON.stringify(pathToFileURL(join(directory, 'plugins/dsh-redteam-results/lib/task-policy.js')).href))
      .replace("'../plugins/dsh-redteam-results/lib/task-context.js'", JSON.stringify(pathToFileURL(join(directory, 'plugins/dsh-redteam-results/lib/task-context.js')).href))
      .replace("'../plugins/dsh-redteam-results/lib/retest.js'", JSON.stringify(pathToFileURL(join(directory, 'plugins/dsh-redteam-results/lib/retest.js')).href))
      .replace("'./test-home-isolation.mjs'", JSON.stringify(pathToFileURL(join(root, 'scripts', 'test-home-isolation.mjs')).href)));
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(stub).href, runner], {
      cwd: root, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, TEMP: boundary, TMP: boundary, TMPDIR: boundary },
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    try {
      assert.notEqual(result.status, 0, `${variant.id}: the mutated library must make the suite fail`);
      assert(output.includes('FAIL ' + variant.fail), `${variant.id}: the targeted assertion must fail`);
      console.log(`ok reverse ${variant.id}: the write-failure suite caught it`);
    } catch (error) {
      failures++;
      console.log(`FAIL reverse ${variant.id}: ${error.message}`);
      console.log(output.split('\n').slice(-12).join('\n'));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
assert.equal(readFileSync(suite, 'utf8'), suiteBefore, 'the write-failure suite changed during reverse checks');
process.exitCode = failures ? 1 : 0;
