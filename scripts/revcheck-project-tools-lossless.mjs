import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tempRoot = path.resolve(root, '../_ref/tmp');
const file = 'plugins/dsh-redteam-results/lib/index.js';
const sourceFile = path.join(root, file);
const before = createHash('sha256').update(fs.readFileSync(sourceFile)).digest('hex');
const fixture = fs.mkdtempSync(path.join(tempRoot, 'saker-project-tools-lossless-'));
assert(path.resolve(fixture).startsWith(tempRoot + path.sep));

try {
  for (const directory of ['lib', 'shared']) {
    if (fs.existsSync(path.join(root, directory))) fs.cpSync(path.join(root, directory), path.join(fixture, directory), { recursive: true });
  }
  for (const plugin of fs.readdirSync(path.join(root, 'plugins'))) {
    const source = path.join(root, 'plugins', plugin, 'lib');
    if (fs.existsSync(source)) fs.cpSync(source, path.join(fixture, 'plugins', plugin, 'lib'), { recursive: true });
  }
  fs.copyFileSync(path.join(root, 'package.json'), path.join(fixture, 'package.json'));
  fs.mkdirSync(path.join(fixture, 'scripts', 'lib'), { recursive: true });
  for (const script of ['test-project-tools.mjs', 'test-stub-register.mjs', 'test-stub-loader.mjs', 'test-home-isolation.mjs']) {
    fs.copyFileSync(path.join(root, 'scripts', script), path.join(fixture, 'scripts', script));
  }
  fs.copyFileSync(path.join(root, 'scripts/lib/project-test-fixtures.mjs'), path.join(fixture, 'scripts/lib/project-test-fixtures.mjs'));

  const target = path.join(fixture, file);
  const content = fs.readFileSync(target, 'utf8');
  const replacement = '.map(a => ({ actionId: a.actionId, state: a.executionState, method: a.method, targetUrl: redactText(a.targetUrl), requestRef: a.requestRef, pageRef: a.pageRef, reconciliation: a.reconciliation }))';
  assert.equal(content.split('.map(projectActionSummary)').length - 1, 2, '旧摘要切换锚点必须命中 next/detail 两处');
  fs.writeFileSync(target, content.replaceAll('.map(projectActionSummary)', replacement));

  const result = spawnSync(process.execPath, [
    '--import', pathToFileURL(path.join(fixture, 'scripts/test-stub-register.mjs')).href,
    path.join(fixture, 'scripts/test-project-tools.mjs'),
  ], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    env: {
      ...process.env,
      TEMP: tempRoot,
      TMP: tempRoot,
      TMPDIR: tempRoot,
      SAKER_SKIP_CFT_TESTS: '1',
    },
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  assert.notEqual(result.status, 0, '旧实现必须让无损 JSON 断言失败');
  assert(output.includes('FAIL project_check next / detail 对可选动作字段保持无损 JSON'), '失败必须命中目标用例，不能由其他错误冒充：' + output);
  assert(output.includes('must return lossless JSON for the real host'), '失败必须是无损 JSON 断言：' + output);
  console.log('ok reverse lossless action summary: old implementation fails the targeted real-host JSON assertion');
} finally {
  fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}

assert.equal(createHash('sha256').update(fs.readFileSync(sourceFile)).digest('hex'), before, '反向验证不得改动生产源码');
console.log('ok reverse verification preserves project tool source');
