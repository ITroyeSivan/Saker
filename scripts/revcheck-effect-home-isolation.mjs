import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const boundary = resolve(root, '../_ref/tmp');
const protocol = join(root, 'benchmarks/task-effects/protocol.mjs');
const plugin = join(root, 'benchmarks/task-effects/desktop-plugin.mjs');
const suite = join(root, 'scripts/test-effect-home-isolation.mjs');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const before = { protocol: hash(protocol), plugin: hash(plugin), suite: hash(suite) };

// Wiring lock: the guard must be consulted before a run directory or session exists,
// and the refusal must be reachable from the RPC start branch.
const pluginSource = readFileSync(plugin, 'utf8');
assert.match(pluginSource, /assessHomeIsolation\(\{ home, declaredRoot: process\.env\.SAKER_EFFECT_HOME_ROOT \}\)/);
assert.match(pluginSource, /benchmark host home is not isolated/);
assert.match(pluginSource, /homeIsolation \} \};/, 'inventory must expose the isolation verdict');
const guardIndex = pluginSource.indexOf('benchmark host home is not isolated');
const firstRunIndex = pluginSource.indexOf("mkdtempSync(join(tmpdir(), 'saker-effect-desktop-'))");
assert(guardIndex > 0 && firstRunIndex > 0 && guardIndex < firstRunIndex, 'the guard must run before any run directory is created');
assert.doesNotMatch(pluginSource, /process\.env\.DSH_HOME \|\| join\(homedir\(\), '\.dsh'\)\)\s*,\s*'redteam-results'/, 'the results store must use the checked home value');
console.log('ok wiring effect benchmark home isolation');

const variants = [
  { id: 'always-isolated', from: 'isolated: faults.length === 0,', to: 'isolated: true,',
    failure: /FAIL the daily launcher home is refused and the refusal names both faults/ },
  { id: 'real-home-allowed', from: "if (actual && real && samePath(actual, real)) faults.push('home-is-real-user-home');",
    to: "if (false) faults.push('home-is-real-user-home');",
    failure: /FAIL the daily launcher home is refused and the refusal names both faults/ },
  { id: 'root-may-cover-real-home', from: "if (root && real && (samePath(root, real) || isStrictlyInside(root, real))) faults.push('isolated-root-covers-real-home');",
    to: "if (false) faults.push('isolated-root-covers-real-home');",
    failure: /FAIL declaring the real home as the isolated root does not make it isolated/ },
  { id: 'outside-root-allowed', from: "if (actual && root && !isStrictlyInside(root, actual)) faults.push('home-outside-isolated-root');",
    to: "if (false) faults.push('home-outside-isolated-root');",
    failure: /FAIL a home outside the declared root is refused even when it is not the real home/ },
];

try {
  for (const variant of variants) {
    const directory = mkdtempSync(join(boundary, `revcheck-effect-home-${variant.id}-`));
    try {
      const inside = relative(boundary, directory);
      assert(inside && !inside.startsWith('..') && !isAbsolute(inside), 'temporary directory escaped _ref/tmp');
      cpSync(join(root, 'benchmarks'), join(directory, 'benchmarks'), { recursive: true });
      cpSync(suite, join(directory, 'scripts/test-effect-home-isolation.mjs'));
      const target = join(directory, 'benchmarks/task-effects/protocol.mjs');
      const source = readFileSync(target, 'utf8');
      assert.equal(source.split(variant.from).length - 1, 1, `${variant.id}: exact mutation anchor`);
      writeFileSync(target, source.replace(variant.from, variant.to));
      const result = spawnSync(process.execPath, [join(directory, 'scripts/test-effect-home-isolation.mjs')], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, TEMP: boundary, TMP: boundary, TMPDIR: boundary },
      });
      assert.notEqual(result.status, 0, `${variant.id}: reverse suite must fail`);
      assert.match(`${result.stdout || ''}${result.stderr || ''}`, variant.failure, `${variant.id}: targeted assertion must fail`);
      console.log(`ok reverse ${variant.id}: targeted isolation assertion failed`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
} finally {
  for (const [name, file] of Object.entries({ protocol, plugin, suite })) {
    assert.equal(hash(file), before[name], `${name} changed during reverse checks`);
  }
}
