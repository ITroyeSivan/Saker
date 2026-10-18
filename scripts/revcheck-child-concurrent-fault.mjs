// 反向检查：去掉"子任务故障沿任务树传播到父任务"，要求 test-child-concurrent-fault.mjs 必须失败。
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const boundary = resolve(root, '..', '_ref', 'tmp');
const lib = join(root, 'plugins', 'dsh-redteam-results', 'lib');
const module = join(lib, 'execution-receipts.js');
const suite = join(root, 'scripts', 'test-child-concurrent-fault.mjs');
const stub = join(root, 'scripts', 'test-stub-register.mjs');
const suiteBefore = readFileSync(suite, 'utf8');

const variants = [
  { id: 'child-to-parent-propagation-removed',
    from: "if (task?.parentSession && ['ip-blocked', 'normal-access-failed', 'login-expired'].includes(code))",
    to: "if (false && task?.parentSession && ['ip-blocked', 'normal-access-failed', 'login-expired'].includes(code))",
    fail: '两个子任务并发限流：各自停下，父任务只被暂停一次且计数一致' },
];

let failures = 0;
for (const variant of variants) {
  const directory = mkdtempSync(join(boundary, `revcheck-child-fault-${variant.id}-`));
  try {
    const inside = relative(boundary, directory);
    assert(inside && !inside.startsWith('..') && !isAbsolute(inside), 'temporary directory escaped _ref/tmp');
    cpSync(lib, join(directory, 'plugins/dsh-redteam-results/lib'), { recursive: true });
    const target = join(directory, 'plugins/dsh-redteam-results/lib/execution-receipts.js');
    const source = readFileSync(module, 'utf8');
    assert.equal(source.split(variant.from).length - 1, 1, `${variant.id}: exact mutation anchor`);
    writeFileSync(target, source.replace(variant.from, variant.to));
    const runner = join(directory, 'test-child-concurrent-fault.mjs');
    const rewritten = readFileSync(suite, 'utf8').replace(/((?:from|import)\s+)'([^']+)'/g, (match, prefix, spec) => {
      if (spec === './test-home-isolation.mjs') return prefix + JSON.stringify(pathToFileURL(join(root, 'scripts', 'test-home-isolation.mjs')).href);
      const plugin = /^\.\.\/plugins\/dsh-redteam-results\/lib\/(.+)$/.exec(spec);
      if (plugin) return prefix + JSON.stringify(pathToFileURL(join(directory, 'plugins/dsh-redteam-results/lib', plugin[1])).href);
      return match;
    });
    writeFileSync(runner, rewritten);
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(stub).href, runner], {
      cwd: root, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, TEMP: boundary, TMP: boundary, TMPDIR: boundary },
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    try {
      assert.notEqual(result.status, 0, `${variant.id}: the mutated library must make the suite fail`);
      assert(output.includes('FAIL ' + variant.fail), `${variant.id}: the targeted assertion must fail`);
      console.log(`ok reverse ${variant.id}: the child-fault suite caught it`);
    } catch (error) {
      failures++;
      console.log(`FAIL reverse ${variant.id}: ${error.message}`);
      console.log(output.split('\n').slice(-12).join('\n'));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
assert.equal(readFileSync(suite, 'utf8'), suiteBefore, 'the child-fault suite changed during reverse checks');
process.exitCode = failures ? 1 : 0;
