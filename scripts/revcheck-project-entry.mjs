// 项目真实入口反向验证：在隔离副本回退快照、离线分类与实际派发计量。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const tmp = path.resolve(root, '../_ref/tmp');
const base = 'plugins/dsh-redteam-results/lib/';
const expected = '真实项目快照和宿主守卫接受项目场景，文档读取不套旧方向或扫描额度';
const variants = [
  ['legacy-module-snapshot', 'index.js', "const selection = state.policy?.scenario === 'project' ? null : rootModuleSelection(store, session.id).selection;",
    'const selection = rootModuleSelection(store, session.id).selection;'],
  ['offline-docs-as-traffic', 'task-policy.js', "  'project_document', 'project_check']);", ']);'],
  ['legacy-module-admission', 'task-policy.js', 'if (!reason && !isProject && state.configured && !baselineRecheck && !rootModuleKeys(store, sessionId).size',
    'if (!reason && state.configured && !baselineRecheck && !rootModuleKeys(store, sessionId).size'],
  ['double-charge-http', 'task-policy.js', "return taskExecutionGuard(store, sessionId, 'recorded-project-execution', now, { args, reserve: false });",
    "return taskExecutionGuard(store, sessionId, 'recorded-project-execution', now, { args, reserve: true });"],
  ['ignore-dispatch-budget', 'project-execution.js', 'if (admission) throw new Error(admission);',
    'if (admission) begun = beginProjectAction(store, sessionId, runId, checkId, { identityRef: authContext });'],
  ['undefined-document-location', 'index.js', 'location: result.location ?? null, nextCursor:', 'location: result.location, nextCursor:'],
  ['ignore-typed-checks', 'index.js', 'let input = args.checks;', 'let input = undefined;'],
];
const files = [...new Set(variants.map(v => base + v[1]))];
const hash = () => createHash('sha256').update(files.map(file => fs.readFileSync(path.join(root, file))).join('\n')).digest('hex');
const before = hash();
for (const [name, file, from, to] of variants) {
  const fixture = fs.mkdtempSync(path.join(tmp, 'saker-project-entry-reverse-'));
  try {
    for (const directory of ['lib', 'shared']) fs.cpSync(path.join(root, directory), path.join(fixture, directory), { recursive: true });
    for (const plugin of fs.readdirSync(path.join(root, 'plugins'))) {
      const lib = path.join(root, 'plugins', plugin, 'lib');
      if (fs.existsSync(lib)) fs.cpSync(lib, path.join(fixture, 'plugins', plugin, 'lib'), { recursive: true });
    }
    fs.copyFileSync(path.join(root, 'package.json'), path.join(fixture, 'package.json'));
    fs.mkdirSync(path.join(fixture, 'scripts'), { recursive: true });
    for (const script of ['test-project-tools.mjs', 'test-stub-register.mjs', 'test-stub-loader.mjs', 'test-home-isolation.mjs'])
      fs.copyFileSync(path.join(root, 'scripts', script), path.join(fixture, 'scripts', script));
    const target = path.join(fixture, base, file);
    const source = fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n');
    assert.equal(source.split(from).length - 1, 1, name + ' anchor');
    fs.writeFileSync(target, source.replace(from, to));
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(fixture, 'scripts/test-stub-register.mjs')).href, path.join(fixture, 'scripts/test-project-tools.mjs')],
      { cwd: root, encoding: 'utf8', timeout: 60000, env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp, SAKER_SKIP_CFT_TESTS: '1' } });
    assert.notEqual(result.status, 0, name + ' unexpectedly green');
    assert((result.stdout + result.stderr).includes('FAIL ' + expected), name + ' failed outside expected case: ' + result.stdout + result.stderr);
    console.log('ok reverse ' + name);
  } finally { fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
assert.equal(hash(), before, 'production source changed');
console.log('ok ' + variants.length + ' project-entry reverse variants; source preserved');
