import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url)), tmp = path.resolve(root, '../_ref/tmp');
const source = path.join(root, 'plugins/dsh-redteam-results/lib/client.js');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const before = hash(source);
const variants = [
  ['placeholder-target', "'目标：'+(current.policy.target||'尚未指定目标')", "'目标：'+(current.policy.target||'未填写')",
    'overview distinguishes missing task details, excluded records and unavailable result counts'],
  ['zero-count-without-target', "hasTarget&&stats?.delivery?", "stats?.delivery?",
    'overview distinguishes missing task details, excluded records and unavailable result counts'],
  ['brief-without-gaps', "(current.gaps||[]).length?React.createElement('details',{className:'dsh-task-gaps'}", "false?React.createElement('details',{className:'dsh-task-gaps'}",
    'the progress brief names the entry, identity, next action, evidence basis and gaps'],
  ['entries-hidden', "(next&&next.requests||[]).length?React.createElement('details',{className:'dsh-task-entries'", "false?React.createElement('details',{className:'dsh-task-entries'",
    'observed entries without a direction yet are listed with address, identity and evidence id'],
];
for (const [name, from, to, expected] of variants) {
  const fixture = fs.mkdtempSync(path.join(tmp, 'revcheck-task-ui-'));
  try {
    for (const dir of ['plugins/dsh-redteam-results/lib']) {
      fs.cpSync(path.join(root, dir), path.join(fixture, dir), { recursive: true });
    }
    fs.mkdirSync(path.join(fixture, 'scripts'));
    for (const file of ['test-desktop-task-ui.mjs', 'test-home-isolation.mjs', 'test-stub-loader.mjs', 'test-stub-register.mjs']) {
      fs.copyFileSync(path.join(root, 'scripts', file), path.join(fixture, 'scripts', file));
    }
    const mutant = path.join(fixture, 'plugins/dsh-redteam-results/lib/client.js'), content = fs.readFileSync(mutant, 'utf8');
    assert.equal(content.split(from).length - 1, 1, name + ': mutation anchor must occur exactly once');
    fs.writeFileSync(mutant, content.replace(from, to));
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(root, 'scripts/test-stub-register.mjs')).href, path.join(fixture, 'scripts/test-desktop-task-ui.mjs')],
      { cwd: root, encoding: 'utf8', timeout: 60000, env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp } });
    assert.notEqual(result.status, 0, name + ' falsely passed');
    assert((result.stdout + result.stderr).includes('FAIL ' + expected), name + ' failed for an unrelated reason: ' + result.stdout + result.stderr);
    console.log('ok reverse ' + name + ' fails on the corresponding task overview behavior');
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
}
assert.equal(hash(source), before); console.log('ok task overview reverse verification preserves production source');
