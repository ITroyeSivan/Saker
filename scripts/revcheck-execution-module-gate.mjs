import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url)), tmp = path.resolve(root, '../_ref/tmp');
const sources = ['plugins/dsh-redteam-results/lib/execution-modules.js', 'plugins/dsh-redteam-results/lib/execution-receipts.js',
  'plugins/dsh-redteam-results/lib/task-policy.js'];
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const before = Object.fromEntries(sources.map(file => [file, hash(path.join(root, file))]));
const variants = [
  ['skip-disabled-modules', 'execution-modules.js',
    'const disabled = wanted.filter(key => !active.has(key));', 'const disabled = [];',
    'closing the test content blocks the probe and nothing reaches the fixture or the budget'],
  ['no-final-check', 'execution-receipts.js',
    'const late = moduleCheck();', 'const late = undefined;',
    'a content closed between admission and dispatch is caught before the network and the reservation is released'],
  ['guard-skips-module-check', 'task-policy.js',
    'if (!reason && !isProject && state.configured && !state.stopped && moduleCheck) reason = moduleCheck() || undefined;',
    'if (!reason && !isProject && state.configured && !state.stopped && false) reason = moduleCheck() || undefined;',
    'closing the test content blocks the probe and nothing reaches the fixture or the budget'],
];
for (const [name, file, from, to, expected] of variants) {
  const fixture = fs.mkdtempSync(path.join(tmp, 'revcheck-module-gate-'));
  try {
    fs.cpSync(path.join(root, 'plugins/dsh-redteam-results/lib'), path.join(fixture, 'plugins/dsh-redteam-results/lib'), { recursive: true });
    fs.cpSync(path.join(root, 'plugins/dsh-method-stack/lib'), path.join(fixture, 'plugins/dsh-method-stack/lib'), { recursive: true });
    fs.mkdirSync(path.join(fixture, 'scripts'));
    fs.copyFileSync(path.join(root, 'scripts/test-execution-module-gate.mjs'), path.join(fixture, 'scripts/test-execution-module-gate.mjs'));
    fs.copyFileSync(path.join(root, 'scripts/test-home-isolation.mjs'), path.join(fixture, 'scripts/test-home-isolation.mjs'));
    // 跨插件裸包名在夹具里改写成相对路径，否则解析钩子会指回仓库真源码。
    for (const target of ['plugins/dsh-redteam-results/lib/execution-modules.js', 'plugins/dsh-redteam-results/lib/task-policy.js']) {
      const filePath = path.join(fixture, target);
      fs.writeFileSync(filePath, fs.readFileSync(filePath, 'utf8')
        .replaceAll('@dsh-external/dsh-method-stack/selection-config', '../../dsh-method-stack/lib/selection-config.js'));
    }
    const mutant = path.join(fixture, 'plugins/dsh-redteam-results/lib', file), content = fs.readFileSync(mutant, 'utf8');
    assert.equal(content.split(from).length - 1, 1, name + ': mutation anchor must occur exactly once');
    fs.writeFileSync(mutant, content.replace(from, to));
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(root, 'scripts/test-stub-register.mjs')).href, path.join(fixture, 'scripts/test-execution-module-gate.mjs')],
      { cwd: root, encoding: 'utf8', timeout: 30000, env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp } });
    assert.notEqual(result.status, 0, name + ' falsely passed');
    assert((result.stdout + result.stderr).includes('FAIL ' + expected), name + ' failed for an unrelated reason: ' + result.stdout + result.stderr);
    console.log('ok reverse ' + name + ' fails on the corresponding module gate behavior');
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
}
for (const file of sources) assert.equal(hash(path.join(root, file)), before[file], file + ' changed');
console.log('ok execution module gate reverse verification preserves production source');
