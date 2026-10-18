import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const boundary = resolve(root, '../_ref/tmp');
const policy = join(root, 'scripts/lib/desktop-shortcut-policy.mjs');
const installer = join(root, 'scripts/install-desktop.mjs');
const suite = join(root, 'scripts/test-desktop-shortcut-policy.mjs');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const before = { policy: hash(policy), installer: hash(installer), suite: hash(suite) };

// Wiring lock: the installer must consult the policy instead of refreshing unconditionally.
const installerSource = readFileSync(installer, 'utf8');
assert.match(installerSource, /shouldRefreshDailyShortcut\(\{ home, override: refreshRequested \}\)/);
assert.match(installerSource, /Daily shortcut left unchanged/);
assert.doesNotMatch(installerSource, /^const shortcut = refreshDesktopShortcut/m, 'the refresh must not stay unconditional');
console.log('ok wiring desktop shortcut policy');

const variants = [
  { id: 'always-refresh', from: 'refresh: sameHome || override === true,', to: 'refresh: true,',
    failure: /FAIL installing into an isolated home must not repoint the daily shortcut/ },
  { id: 'never-refresh', from: 'refresh: sameHome || override === true,', to: 'refresh: false,',
    failure: /FAIL installing into the daily home refreshes the daily shortcut/ },
  { id: 'string-override', from: 'refresh: sameHome || override === true,', to: 'refresh: sameHome || Boolean(override),',
    failure: /FAIL only an explicit override may repoint the daily shortcut/ },
];

try {
  for (const variant of variants) {
    const directory = mkdtempSync(join(boundary, `revcheck-shortcut-policy-${variant.id}-`));
    try {
      const inside = relative(boundary, directory);
      assert(inside && !inside.startsWith('..') && !isAbsolute(inside), 'temporary directory escaped _ref/tmp');
      const target = join(directory, 'desktop-shortcut-policy.mjs');
      const source = readFileSync(policy, 'utf8');
      assert.equal(source.split(variant.from).length - 1, 1, `${variant.id}: exact mutation anchor`);
      writeFileSync(target, source.replace(variant.from, variant.to));
      const runner = join(directory, 'test-desktop-shortcut-policy.mjs');
      writeFileSync(runner, readFileSync(suite, 'utf8').replace(
        "'./lib/desktop-shortcut-policy.mjs'", JSON.stringify(pathToFileURL(target).href)));
      const result = spawnSync(process.execPath, [runner], {
        cwd: root, encoding: 'utf8',
        env: { ...process.env, TEMP: boundary, TMP: boundary, TMPDIR: boundary },
      });
      assert.notEqual(result.status, 0, `${variant.id}: reverse suite must fail`);
      assert.match(`${result.stdout || ''}${result.stderr || ''}`, variant.failure, `${variant.id}: targeted assertion must fail`);
      console.log(`ok reverse ${variant.id}: targeted shortcut-policy assertion failed`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
} finally {
  for (const [name, file] of Object.entries({ policy, installer, suite })) {
    assert.equal(hash(file), before[name], `${name} changed during reverse checks`);
  }
}
