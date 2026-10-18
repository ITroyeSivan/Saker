// 反向检查：5.7 作用域门禁必须能失败，且导出报告文档的 body 必须放行。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const boundary = path.resolve(root, '../_ref/tmp');
const suite = path.join(root, 'scripts', 'test-ui-scope.mjs');
const guardFiles = ['plugins/dsh-redteam-results/lib/client.js', 'plugins/dsh-hunter/lib/client.js'];
const digest = () => createHash('sha256').update(guardFiles.map((rel) => fs.readFileSync(path.join(root, rel))).join('\n')).digest('hex');
const before = digest();

const COMPLIANT = 'const css = ".dsh-root{color:red}";\n';
const variants = [
  { id: 'body-global', css: 'const css = "body{color:red}";\n', failure: /作用域/ },
  { id: 'root-global', css: 'const css = ":root{--x:1}";\n', failure: /作用域/ },
  { id: 'star-global', css: 'const css = "*{box-sizing:border-box}";\n', failure: /作用域/ },
];

function buildFixture(tag, css) {
  const fixture = fs.mkdtempSync(path.join(boundary, `revcheck-ui-scope-${tag}-`));
  const inside = path.relative(boundary, fixture);
  assert(inside && !inside.startsWith('..') && !path.isAbsolute(inside), '临时目录逃出 _ref/tmp');
  fs.mkdirSync(path.join(fixture, 'scripts', 'lib'), { recursive: true });
  fs.copyFileSync(suite, path.join(fixture, 'scripts', 'test-ui-scope.mjs'));
  fs.copyFileSync(path.join(root, 'scripts', 'lib', 'product-plugins.mjs'), path.join(fixture, 'scripts', 'lib', 'product-plugins.mjs'));
  for (let i = 1; i <= 8; i++) {
    const dir = path.join(fixture, 'plugins', `dsh-fixture-${i}`);
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `@dsh-external/dsh-fixture-${i}`, version: '1.0.0' }));
    fs.writeFileSync(path.join(dir, 'lib', 'client.js'), i === 1 ? css : COMPLIANT);
  }
  return fixture;
}

function runSuite(fixture) {
  const result = spawnSync(process.execPath, [path.join(fixture, 'scripts', 'test-ui-scope.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, TEMP: boundary, TMP: boundary, TMPDIR: boundary },
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

let failures = 0;
for (const variant of variants) {
  const fixture = buildFixture(variant.id, variant.css);
  try {
    const { status, output } = runSuite(fixture);
    try {
      assert.notEqual(status, 0, `${variant.id}: 全局选择器必须让门禁失败`);
      assert.match(output, variant.failure, `${variant.id}: 失败原因要指向作用域门禁`);
      console.log(`ok reverse ${variant.id}: the scope gate caught it`);
    } catch (error) {
      failures++;
      console.log(`FAIL reverse ${variant.id}: ${error.message}`);
      console.log(output.split('\n').slice(-6).join('\n'));
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

// 反向的另一半：导出报告文档的 <style>body 属于文档上下文，必须放行。
{
  const fixture = buildFixture('allowed-report', 'const head = ["报告</title><style>"]; const css = "body{font-family:sans-serif}";\n');
  try {
    const { status, output } = runSuite(fixture);
    assert.equal(status, 0, '导出报告文档的 body 被作用域门禁误伤了：' + output.split('\n').filter((l) => l.startsWith('FAIL')).join(' | '));
    console.log('ok exported report document body stays allowed');
  } catch (error) {
    failures++;
    console.log('FAIL allowed-report: ' + error.message);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

assert.equal(digest(), before, '反向检查不得改动生产客户端');
console.log('ok scope reverse verification preserves production source');
process.exitCode = failures ? 1 : 0;
