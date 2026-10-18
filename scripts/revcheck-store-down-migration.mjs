// 反向检查：把回退保护去掉，要求 test-store-down-migration.mjs 必须失败。
//
// 为什么需要：那条保护的要点是"库比本构建新时先拒绝、并且**不写回版本号**"。
// 如果保护被删掉（退回原来的无条件 `PRAGMA user_version = SCHEMA_VERSION`），
// 套件必须能抓到 —— 否则它只是一份会永远通过的装饰。
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const boundary = resolve(root, '..', '_ref', 'tmp');
const lib = join(root, 'plugins', 'dsh-redteam-results', 'lib');
const module = join(lib, 'store.js');
const suite = join(root, 'scripts', 'test-store-down-migration.mjs');
const stub = join(root, 'scripts', 'test-stub-register.mjs');
const suiteBefore = readFileSync(suite, 'utf8');

const variants = [
  {
    id: 'guard-removed',
    // 保护整段不生效 → 旧构建会把新库的版本号写回去。
    from: 'if (storedVersion > SCHEMA_VERSION) {',
    to: 'if (false) {',
    fail: 'a database written by a newer build is refused instead of silently stamped down',
  },
];

let failures = 0;
for (const variant of variants) {
  const directory = mkdtempSync(join(boundary, `revcheck-store-down-migration-${variant.id}-`));
  try {
    const inside = relative(boundary, directory);
    assert(inside && !inside.startsWith('..') && !isAbsolute(inside), 'temporary directory escaped _ref/tmp');
    // store.js 有一整条相对导入链（delivery/checked/task-policy…），必须整棵 lib 一起复制。
    cpSync(lib, join(directory, 'plugins/dsh-redteam-results/lib'), { recursive: true });
    const target = join(directory, 'plugins/dsh-redteam-results/lib/store.js');
    const source = readFileSync(module, 'utf8');
    assert.equal(source.split(variant.from).length - 1, 1, `${variant.id}: exact mutation anchor`);
    writeFileSync(target, source.replace(variant.from, variant.to));
    const runner = join(directory, 'test-store-down-migration.mjs');
    writeFileSync(runner, readFileSync(suite, 'utf8')
      .replace("'../plugins/dsh-redteam-results/lib/store.js'", JSON.stringify(pathToFileURL(target).href))
      // 复制到临时目录后 `./lib/...` 相对导入也会断，必须一起改成绝对 URL。
      .replace("'./lib/test-temp-root.mjs'", JSON.stringify(pathToFileURL(join(root, 'scripts', 'lib', 'test-temp-root.mjs')).href)));
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(stub).href, runner], {
      cwd: root, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, TEMP: boundary, TMP: boundary, TMPDIR: boundary },
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    try {
      assert.notEqual(result.status, 0, `${variant.id}: the mutated store must make the suite fail`);
      assert(output.includes('FAIL ' + variant.fail), `${variant.id}: the targeted assertion must fail`);
      console.log(`ok reverse ${variant.id}: the down-migration suite caught it`);
    } catch (error) {
      failures++;
      console.log(`FAIL reverse ${variant.id}: ${error.message}`);
      console.log(output.split('\n').slice(-12).join('\n'));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
assert.equal(readFileSync(suite, 'utf8'), suiteBefore, 'the down-migration suite changed during reverse checks');
process.exitCode = failures ? 1 : 0;
