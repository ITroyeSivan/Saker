import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const boundary = resolve(root, '../_ref/tmp');
const directory = mkdtempSync(join(boundary, 'effect-runtime-reverse-'));
const source = readFileSync(join(root, 'benchmarks/task-effects/runtime.mjs'), 'utf8');
const test = readFileSync(join(root, 'scripts/test-effect-runtime.mjs'), 'utf8');
const variants = [
  { id: 'implicit-default', from: "registry.resolve(id)", to: "registry.resolve(variant === 'plain-agent' ? undefined : id)", fail: 'plain control uses standard' },
  { id: 'polling-duration', from: '(ended ?? now()) - started', to: 'now() - started', fail: 'native idle seals elapsed time' },
  { id: 'stop-race', from: 'return reason => completion ??= Promise.resolve().then(() => cleanup(reason));',
    to: 'return reason => { if (completion) return; completion = Promise.resolve().then(() => cleanup(reason)); return completion; };', fail: 'concurrent stops wait' },
  { id: 'late-delegation', from: 'modelSelectionSettings: false', to: 'modelSelectionSettings: true', fail: 'zero-worker standard copy' },
];
try {
  for (const variant of variants) {
    assert.equal(source.split(variant.from).length - 1, 1, variant.id + ': mutation must match exactly once');
    const module = join(directory, variant.id + '.mjs');
    const runner = join(directory, variant.id + '-test.mjs');
    writeFileSync(module, source.replace(variant.from, variant.to));
    const importFrom = "'../benchmarks/task-effects/runtime.mjs'";
    assert.equal(test.split(importFrom).length - 1, 1);
    writeFileSync(runner, test.replace(importFrom, JSON.stringify(pathToFileURL(module).href)));
    const result = spawnSync(process.execPath, [runner], { cwd: root, encoding: 'utf8', env: { ...process.env, TEMP: boundary, TMP: boundary, TMPDIR: boundary } });
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, variant.id + ': old behavior must fail');
    assert(output.includes('FAIL ' + variant.fail), variant.id + ': required behavior assertion did not fail');
    console.log('ok reverse ' + variant.id + ': targeted assertion failed');
  }
} finally {
  const inside = relative(boundary, directory);
  assert(!inside.startsWith('..') && !isAbsolute(inside) && inside);
  rmSync(directory, { recursive: true, force: true });
}
