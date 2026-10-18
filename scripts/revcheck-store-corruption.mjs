// 反向检查：把 -wal/-shm 从“改名保留”退回成“直接删除”，
// 要求 test-store-corruption.mjs 必须失败。
//
// 为什么需要：这条保护的要点是**保留原件**。如果实现退回 rmSync，套件必须能抓到，
// 否则它只是一份会永远通过的装饰。
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const boundary = resolve(root, '..', '_ref', 'tmp');
const lib = join(root, 'plugins', 'dsh-redteam-results', 'lib');
const module = join(lib, 'store.js');
const suite = join(root, 'scripts', 'test-store-corruption.mjs');
const stub = join(root, 'scripts', 'test-stub-register.mjs');
const suiteBefore = readFileSync(suite, 'utf8');

const variants = [
  {
    id: 'wal-shm-deleted',
    // 退回旧实现：把未落盘增量直接删掉，不再保留原件。
    from: 'if (fs.existsSync(dbPath + ext)) fs.renameSync(dbPath + ext, bak + ext);',
    to: 'fs.rmSync(dbPath + ext, { force: true });',
    fail: 'WAL and SHM are renamed next to the backup, never deleted',
  },
];

let failures = 0;
for (const variant of variants) {
  const directory = mkdtempSync(join(boundary, `revcheck-store-corruption-${variant.id}-`));
  try {
    const inside = relative(boundary, directory);
    assert(inside && !inside.startsWith('..') && !isAbsolute(inside), 'temporary directory escaped _ref/tmp');
    cpSync(lib, join(directory, 'plugins/dsh-redteam-results/lib'), { recursive: true });
    const target = join(directory, 'plugins/dsh-redteam-results/lib/store.js');
    const source = readFileSync(module, 'utf8');
    assert.equal(source.split(variant.from).length - 1, 1, `${variant.id}: exact mutation anchor`);
    writeFileSync(target, source.replace(variant.from, variant.to));
    const runner = join(directory, 'test-store-corruption.mjs');
    writeFileSync(runner, readFileSync(suite, 'utf8')
      .replace("'../plugins/dsh-redteam-results/lib/store.js'", JSON.stringify(pathToFileURL(target).href))
      .replace("'./lib/test-temp-root.mjs'", JSON.stringify(pathToFileURL(join(root, 'scripts', 'lib', 'test-temp-root.mjs')).href)));
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(stub).href, runner], {
      cwd: root, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, TEMP: boundary, TMP: boundary, TMPDIR: boundary },
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    try {
      assert.notEqual(result.status, 0, `${variant.id}: the mutated store must make the suite fail`);
      assert(output.includes('FAIL ' + variant.fail), `${variant.id}: the targeted assertion must fail`);
      console.log(`ok reverse ${variant.id}: the corruption suite caught it`);
    } catch (error) {
      failures++;
      console.log(`FAIL reverse ${variant.id}: ${error.message}`);
      console.log(output.split('\n').slice(-12).join('\n'));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
assert.equal(readFileSync(suite, 'utf8'), suiteBefore, 'the corruption suite changed during reverse checks');
process.exitCode = failures ? 1 : 0;
