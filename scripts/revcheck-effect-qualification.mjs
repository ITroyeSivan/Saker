import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const boundary = resolve(root, '../_ref/tmp');
const directory = mkdtempSync(join(boundary, 'effect-qualification-reverse-'));
const variants = [
  { id: 'raw-success-counted', module: 'protocol', suite: 'test-task-effect-benchmark',
    from: 'group.independentSuccess += Number(qualification.qualifiedSuccess)', to: 'group.independentSuccess += Number(run.score?.independentSuccess === true)',
    fail: 'qualified success excludes overruns' },
  { id: 'no-budget-check', module: 'protocol', suite: 'test-task-effect-benchmark',
    from: 'validBudget && value > limit', to: 'false', fail: 'qualified success excludes overruns' },
  { id: 'trust-stale-qualification', module: 'protocol', suite: 'test-task-effect-benchmark',
    from: 'const reasons = [];', to: 'if (run?.qualification?.eligible) return run.qualification; const reasons = [];', fail: 'qualified success excludes overruns' },
  { id: 'usage-overflow-and-conflict', module: 'agent-interface', suite: 'test-effect-agent-interface',
    from: 'if (!Number.isSafeInteger(total) || (usage.totalTokens !== undefined && usage.totalTokens !== total)) return null;', to: '',
    fail: 'usage includes cached input' },
];
try {
  for (const variant of variants) {
    const original = readFileSync(join(root, 'benchmarks/task-effects', variant.module + '.mjs'), 'utf8');
    assert.equal(original.split(variant.from).length - 1, 1, variant.id + ': mutation must match exactly once');
    const module = join(directory, variant.id + '.mjs');
    writeFileSync(module, original.replace(variant.from, variant.to).replaceAll("'./cases.mjs'", JSON.stringify(pathToFileURL(join(root, 'benchmarks/task-effects/cases.mjs')).href)));
    const test = readFileSync(join(root, 'scripts', variant.suite + '.mjs'), 'utf8');
    const runner = join(directory, variant.id + '-test.mjs');
    writeFileSync(runner, test.replace(/'\.\.\/benchmarks\/task-effects\/([^']+)'/g, (_all, name) =>
      JSON.stringify(pathToFileURL(name === variant.module + '.mjs' ? module : join(root, 'benchmarks/task-effects', name)).href)));
    const result = spawnSync(process.execPath, [runner], { cwd: root, encoding: 'utf8',
      env: { ...process.env, TEMP: boundary, TMP: boundary, TMPDIR: boundary } });
    assert.notEqual(result.status, 0, variant.id + ': defective behavior must fail');
    assert((result.stdout + result.stderr).includes('FAIL ' + variant.fail), variant.id + ': targeted assertion must fail');
    console.log('ok reverse ' + variant.id + ': targeted behavior assertion failed');
  }
} finally {
  const inside = relative(boundary, directory);
  assert(inside && !inside.startsWith('..') && !isAbsolute(inside));
  rmSync(directory, { recursive: true, force: true });
}
