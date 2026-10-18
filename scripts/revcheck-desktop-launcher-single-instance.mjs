import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const boundary = resolve(root, '../_ref/tmp');
const template = join(root, 'scripts', 'lib', 'desktop-launch.ps1');
const suite = join(root, 'scripts', 'test-desktop-launcher-single-instance.mjs');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const before = { template: hash(template), suite: hash(suite) };

const variants = [
  { id: 'guard-removed', from: 'if ($daily.Count -gt 0) {', to: 'if ($false) {',
    failure: /FAIL the launcher refuses a second instance and says why/ },
  { id: 'ownership-by-name', from: 'Where-Object { $_.ExecutablePath -eq $executable }', to: 'Where-Object { $_.Name -eq \'DeepSeek Harness.exe\' }',
    failure: /FAIL the launcher refuses a second instance and says why/ },
  { id: 'no-focus', from: "try { $activated = (New-Object -ComObject WScript.Shell).AppActivate([int]$target) } catch { $activated = $false }", to: '$activated = $false',
    failure: /FAIL the launcher focuses the existing window instead of doing nothing/ },
  // 反向变体：把"外来实例"也当成日常窗口聚焦 —— 用户会看到那个空会话列表的验收窗口。
  { id: 'foreign-instance-focused',
    from: "if ($foreign.Count -gt 0) {\n  # The port is held by a test/isolated instance.",
    to: "if ($false) {\n  # The port is held by a test/isolated instance.",
    failure: /FAIL the launcher never focuses a verification instance as the daily window/ },
];

try {
  for (const variant of variants) {
    const directory = mkdtempSync(join(boundary, `revcheck-launcher-${variant.id}-`));
    try {
      const inside = relative(boundary, directory);
      assert(inside && !inside.startsWith('..') && !isAbsolute(inside), 'temporary directory escaped _ref/tmp');
      const source = readFileSync(template, 'utf8');
      assert.equal(source.split(variant.from).length - 1, 1, `${variant.id}: exact mutation anchor`);
      const mutated = join(directory, 'desktop-launch.ps1');
      writeFileSync(mutated, source.replace(variant.from, variant.to));
      const result = spawnSync(process.execPath, [suite], {
        cwd: root, encoding: 'utf8',
        env: { ...process.env, TEMP: boundary, TMP: boundary, TMPDIR: boundary,
          SAKER_LAUNCHER_TEMPLATE: mutated,
          // 让一致性比对指向同一个被改过的文件，隔离掉"部署副本漂移"这条断言。
          SAKER_LAUNCHER_DEPLOYED: mutated },
      });
      assert.notEqual(result.status, 0, `${variant.id}: reverse suite must fail`);
      assert.match(`${result.stdout || ''}${result.stderr || ''}`, variant.failure, `${variant.id}: targeted assertion must fail`);
      console.log(`ok reverse ${variant.id}: targeted launcher assertion failed`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
} finally {
  for (const [name, file] of Object.entries({ template, suite })) {
    assert.equal(hash(file), before[name], `${name} changed during reverse checks`);
  }
}
