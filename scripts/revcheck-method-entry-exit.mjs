// 反向检查：把 client bundle 做回「入口还注册着」或「废弃文案还在」的样子，
// 要求 test-method-entry-exit.mjs 必须失败。
//
// 为什么需要：那条套件断言的是「apply() 零注册 + 已退出文案不在 bundle 里」。
// 如果它只是跑完总是绿，那它对"废弃页面被重新挂上"这件事毫无作用。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const boundary = resolve(root, '..', '_ref', 'tmp');
const suite = join(root, 'scripts', 'test-method-entry-exit.mjs');
const source = join(root, 'plugins', 'dsh-method-stack', 'lib', 'client.js');
const digest = () => createHash('sha256').update(readFileSync(source)).digest('hex');
const before = digest();

const variants = [
  { id: 'slot-re-registered', from: '  void ctx;', to: "  ctx.slots.register({ id: 'method-page' });", failure: /must not register any host slot/ },
  { id: 'retired-text-restored', from: '  void ctx;', to: '  // 设置页「方法编排」\n  void ctx;', failure: /retired UI text must be gone/ },
];

let failures = 0;
for (const variant of variants) {
  const directory = mkdtempSync(join(boundary, `revcheck-method-entry-exit-${variant.id}-`));
  try {
    const inside = relative(boundary, directory);
    assert(inside && !inside.startsWith('..') && !isAbsolute(inside), 'temporary directory escaped _ref/tmp');
    const client = join(directory, 'plugins', 'dsh-method-stack', 'lib', 'client.js');
    mkdirSync(dirname(client), { recursive: true });
    const content = readFileSync(source, 'utf8');
    assert(content.includes(variant.from), `${variant.id}: anchor missing in the production client`);
    writeFileSync(client, content.replace(variant.from, variant.to));
    mkdirSync(join(directory, 'scripts'), { recursive: true });
    copyFileSync(suite, join(directory, 'scripts', 'test-method-entry-exit.mjs'));
    const result = spawnSync(process.execPath, [join(directory, 'scripts', 'test-method-entry-exit.mjs')], {
      cwd: root, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, TEMP: boundary, TMP: boundary, TMPDIR: boundary },
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    try {
      assert.notEqual(result.status, 0, `${variant.id}: the re-added entry must make the suite fail`);
      assert.match(output, variant.failure, `${variant.id}: the targeted assertion must fail`);
      console.log(`ok reverse ${variant.id}: the exit gate caught it`);
    } catch (error) {
      failures++;
      console.log(`FAIL reverse ${variant.id}: ${error.message}`);
      console.log(output.split('\n').slice(-8).join('\n'));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

assert.equal(digest(), before, 'reverse verification must not touch the production client bundle');
console.log('ok exit reverse verification preserves production source');
process.exitCode = failures ? 1 : 0;
