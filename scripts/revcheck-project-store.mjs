// W02 反向验证：分别回退幂等开始、controlRev 冲突和单动作占用，确认测试会失败。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const tmp = path.resolve(root, '../_ref/tmp');
const runner = 'test-project-store.mjs';
const file = 'plugins/dsh-redteam-results/lib/project-store.js';
const variants = [
  ['idempotent-start', 'const existing = activeProjectRun(store, sessionId);', 'const existing = null;',
    '项目开始幂等'],
  ['control-rev', "    if (expectedControlRev !== undefined && run.controlRev !== expectedControlRev)\n      throw conflict('项目运行状态已变化，请刷新后重试');", '',
    '项目运行状态转移受词表和 controlRev 约束'],
  ['single-action', "    const inflight = store.db.prepare(\"SELECT action_id FROM project_actions WHERE session_id=? AND run_id=? AND state IN ('queued','dispatched') LIMIT 1\")\n      .get(sessionId, runId);\n    if (inflight) throw conflict('同一项目运行同时只能有一个派发中的动作');", '',
    '同一运行同时最多一个派发中的动作'],
  ['define-batch-idempotency', '    if (previousBatch) {', '    if (false) {',
    'define batch 重试幂等，内容冲突、循环依赖和缺失事实被拒绝'],
  ['dependency-fact', '      if (!providers.some(provider => (provider.provides || []).includes(fact)))', '      if (false)',
    'define batch 重试幂等，内容冲突、循环依赖和缺失事实被拒绝'],
];

const before = createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
for (const [name, from, to, expected] of variants) {
  const fixture = fs.mkdtempSync(path.join(tmp, 'saker-project-store-reverse-'));
  assert(path.resolve(fixture).startsWith(tmp + path.sep));
  try {
    for (const directory of ['lib', 'shared']) fs.cpSync(path.join(root, directory), path.join(fixture, directory), { recursive: true });
    for (const plugin of fs.readdirSync(path.join(root, 'plugins'))) {
      const source = path.join(root, 'plugins', plugin, 'lib');
      if (fs.existsSync(source)) fs.cpSync(source, path.join(fixture, 'plugins', plugin, 'lib'), { recursive: true });
    }
    fs.copyFileSync(path.join(root, 'package.json'), path.join(fixture, 'package.json'));
    fs.mkdirSync(path.join(fixture, 'scripts', 'lib'), { recursive: true });
    for (const script of [runner, 'test-stub-register.mjs', 'test-stub-loader.mjs', 'test-home-isolation.mjs'])
      fs.copyFileSync(path.join(root, 'scripts', script), path.join(fixture, 'scripts', script));
    fs.copyFileSync(path.join(root, 'scripts/lib/project-test-fixtures.mjs'),
      path.join(fixture, 'scripts/lib/project-test-fixtures.mjs'));
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
assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex'), before, 'production source changed');
console.log('ok reverse verification preserves the production source file');
