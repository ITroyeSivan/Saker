import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), temp = resolve(root, '../_ref/tmp');
mkdirSync(temp, { recursive: true });
const files = ['index.js', 'task-inputs.js', 'store.js'];
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const originals = files.map(name => join(root, 'plugins/dsh-redteam-results/lib', name));
const before = originals.map(sha);
const mutations = [
  { name: 'finding-recovery', file: 'index.js', replace: text => text.replace('recovery: \'reproduction须为JSON方法对象', 'ignoredRecovery: \'reproduction须为JSON方法对象'), failure: /FAIL finding format failure exposes/ },
  { name: 'typed-start', file: 'index.js', replace: text => text.replace('taskStartInput(args)', 'JSON.parse(args.policy)'), failure: /FAIL registered task starts once/ },
  { name: 'progress-discard', file: 'task-inputs.js', replace: text => text.replace('export function taskProgressInput(args) {',
    'export function taskProgressInput(args) { if (args.progress !== undefined) return document(args.progress, "progress");'), failure: /FAIL actual task completion preserves/ },
  { name: 'cold-import', file: 'store.js', replace: text => text.replace('function schema() { return `', 'const SCHEMA = `').replace('`; }', '`;').replace('db.exec(schema());', 'db.exec(SCHEMA);'), failure: /Cannot access 'EXECUTION_RECEIPT_SCHEMA' before initialization/ },
];
for (const mutation of mutations) {
  const fixture = mkdtempSync(join(temp, 'revcheck-task-inputs-'));
  try {
    const lib = join(fixture, 'plugins/dsh-redteam-results/lib');
    cpSync(join(root, 'plugins/dsh-redteam-results/lib'), lib, { recursive: true });
    mkdirSync(join(fixture, 'scripts'), { recursive: true });
    for (const name of ['test-task-inputs.mjs', 'test-home-isolation.mjs']) cpSync(join(root, 'scripts', name), join(fixture, 'scripts', name));
    const file = join(lib, mutation.file), previous = readFileSync(file, 'utf8'), changed = mutation.replace(previous);
    assert.notEqual(changed, previous, mutation.name + ' did not apply');writeFileSync(file, changed);
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(join(root, 'scripts/test-stub-register.mjs')).href,
      join(fixture, 'scripts/test-task-inputs.mjs')], { cwd: root, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp } });
    assert.notEqual(result.status, 0, mutation.name + ' falsely passed');
    assert.match(result.stdout + result.stderr, mutation.failure, mutation.name + ' failed for an unrelated cause');
    console.log('ok reverse ' + mutation.name + ' fails at the corresponding real behavior');
  } finally { rmSync(fixture, { recursive: true, force: true }); }
}
assert.deepEqual(originals.map(sha), before, 'production source changed during reverse validation');
console.log('ok reverse task input validation preserved production source');
