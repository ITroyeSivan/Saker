// W01 反向验证：分别回退 RR01 的最终事实绑定和 RR02 的 fixed 一致性校验，
// 确认针对性测试会在旧机制下失败。生产文件只读，mutation 只发生在临时副本。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const tmp = path.resolve(root, '../_ref/tmp');
const runner = 'test-finding-update-consistency.mjs';
const variants = [
  ['rr01-final-target', 'plugins/dsh-redteam-results/lib/store.js',
    'requireCurrentRepairRetest(store, sessionId, id, {\n'
    + '\t\ttarget: nextTarget, identity: nextIdentity, endpoint: nextEndpoint,\n'
    + '\t\tidentityChanged: patch.identity !== undefined && cleanText(patch.identity) !== prev.identity,\n'
    + '\t\tendpointChanged: reproduction !== undefined\n'
    + '\t});',
    'requireCurrentRepairRetest(store, sessionId, id);',
    'RR01 同次改目标并标记 fixed 被拒绝'],
  ['rr02-staying-fixed', 'plugins/dsh-redteam-results/lib/store.js',
    'const declaresFixed = mode !== "redteam" && statusSet.includes("fixed") && patch.status !== undefined\n'
    + '\t\t&& cleanEnum(patch.status, statusSet, prev.status) === "fixed";',
    'const declaresFixed = mode !== "redteam" && statusSet.includes("fixed") && prev.status !== "fixed"\n'
    + '\t\t&& cleanEnum(patch.status, statusSet, prev.status) === "fixed";',
    'RR02 fixed 后追加 inconclusive 被拒绝'],
];

const hashes = new Map(variants.map(([, file]) => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
for (const [name, file, from, to, expected] of variants) {
  const fixture = fs.mkdtempSync(path.join(tmp, 'saker-finding-consistency-reverse-'));
  assert(path.resolve(fixture).startsWith(tmp + path.sep));
  try {
    for (const directory of ['lib', 'shared']) fs.cpSync(path.join(root, directory), path.join(fixture, directory), { recursive: true });
    for (const plugin of fs.readdirSync(path.join(root, 'plugins'))) {
      const source = path.join(root, 'plugins', plugin, 'lib');
      if (fs.existsSync(source)) fs.cpSync(source, path.join(fixture, 'plugins', plugin, 'lib'), { recursive: true });
    }
    fs.copyFileSync(path.join(root, 'package.json'), path.join(fixture, 'package.json'));
    fs.mkdirSync(path.join(fixture, 'scripts'), { recursive: true });
    for (const script of [runner, 'test-stub-register.mjs', 'test-stub-loader.mjs', 'test-home-isolation.mjs'])
      fs.copyFileSync(path.join(root, 'scripts', script), path.join(fixture, 'scripts', script));
    const target = path.join(fixture, file);
    const content = fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n');
    assert.equal(content.split(from).length - 1, 1, name + ' mutation anchor');
    fs.writeFileSync(target, content.replace(from, to));
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(fixture, 'scripts/test-stub-register.mjs')).href, path.join(fixture, 'scripts', runner)],
      { cwd: root, encoding: 'utf8', timeout: 120000, env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp } });
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, name + ' unexpectedly passed');
    assert(output.includes('FAIL ' + expected), name + ' failed outside target assertion: ' + output);
    console.log('ok reverse ' + name + ': original behavior makes the targeted assertion fail');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}
for (const [file, before] of hashes)
  assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex'), before, file);
console.log('ok reverse verification preserves every production source file');
