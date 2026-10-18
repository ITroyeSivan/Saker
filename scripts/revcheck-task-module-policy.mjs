import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url)), tmp = path.resolve(root, '../_ref/tmp');
const source = path.join(root, 'plugins/dsh-redteam-results/lib/task-modules.js');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const before = hash(source);
const variants = [
  ['ignore-task-revision', "if (input.policyRev !== current.policyRev) conflict('任务状态已变化，请刷新后重试');", '', 'mode transition preserves selection and invalidates stale task revision'],
  ['ignore-module-revision', "if (input.rev !== current.rev) conflict('其他窗口已修改模块，请刷新后重试');", '', 'atomic changes record policy revision, audit event and update timestamp'],
  ['child-edits-parent', "if (current.inherited) throw Error('子任务沿用主任务的测试模块，请在主任务修改');", '', 'child follows current root mode and module revision and cannot edit'],
  ['child-stale-mode', "const mode = policy?.mode || store.db.prepare('SELECT mode FROM task_choice WHERE session_id=?').get(owner)?.mode || 'regular';", "const mode = policyRecord(store, sessionId)?.mode || policy?.mode || store.db.prepare('SELECT mode FROM task_choice WHERE session_id=?').get(owner)?.mode || 'regular';", 'child follows current root mode and module revision and cannot edit'],
  ['empty-defaults-reset', 'const active = checkedActive(record.modules), known = new Set(config.keys);', 'const active = checkedActive(record.modules.length ? record.modules : config.keys), known = new Set(config.keys);', 'one task keeps explicit empty selection across regular, 0day and nday']
];
for (const [name, from, to, expected] of variants) {
  const fixture = fs.mkdtempSync(path.join(tmp, 'revcheck-task-modules-'));
  try {
    for (const plugin of ['dsh-method-stack', 'dsh-redteam-results']) fs.cpSync(path.join(root, 'plugins', plugin, 'lib'), path.join(fixture, 'plugins', plugin, 'lib'), { recursive: true });
    fs.mkdirSync(path.join(fixture, 'scripts'));
    fs.copyFileSync(path.join(root, 'scripts/test-task-module-policy.mjs'), path.join(fixture, 'scripts/test-task-module-policy.mjs'));
    const mutant = path.join(fixture, 'plugins/dsh-redteam-results/lib/task-modules.js'), content = fs.readFileSync(mutant, 'utf8');
    assert.equal(content.split(from).length - 1, 1, 'mutation anchor must occur exactly once');
    fs.writeFileSync(mutant, content.replace(from, to));
    const webFile = path.join(fixture, 'plugins/dsh-method-stack/lib/web-selection.js');
    fs.writeFileSync(webFile, fs.readFileSync(webFile, 'utf8').replaceAll('@dsh-external/dsh-redteam-results/', '../../dsh-redteam-results/lib/')
      .replaceAll("lib/store'", "lib/store.js'").replaceAll("lib/task-modules'", "lib/task-modules.js'").replaceAll("lib/test-catalog'", "lib/test-catalog.js'"));
    const selectionFile = path.join(fixture, 'plugins/dsh-method-stack/lib/selection-config.js');
    fs.writeFileSync(selectionFile, fs.readFileSync(selectionFile, 'utf8').replaceAll('@dsh-external/dsh-redteam-results/', '../../dsh-redteam-results/lib/').replaceAll("lib/test-catalog'", "lib/test-catalog.js'"));
    const policyFile = path.join(fixture, 'plugins/dsh-redteam-results/lib/task-policy.js');
    fs.writeFileSync(policyFile, fs.readFileSync(policyFile, 'utf8').replace('@dsh-external/dsh-method-stack/selection-config', '../../dsh-method-stack/lib/selection-config.js'));
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(root, 'scripts/test-stub-register.mjs')).href, path.join(fixture, 'scripts/test-task-module-policy.mjs')],
      { cwd: root, encoding: 'utf8', timeout: 30000, env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp } });
    assert.notEqual(result.status, 0, name + ' falsely passed');
    assert((result.stdout + result.stderr).includes('FAIL ' + expected), name + ' failed for an unrelated reason: ' + result.stdout + result.stderr);
    console.log('ok reverse ' + name + ' fails on the corresponding task behavior');
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
}
assert.equal(hash(source), before); console.log('ok task module reverse verification preserves production source');
