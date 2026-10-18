// 反向检查：5.7 强调色门禁必须能失败，且 var fallback / token 定义 / 看板 / 报告必须放行。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const boundary = path.resolve(root, '../_ref/tmp');
const suite = path.join(root, 'scripts', 'test-ui-accent.mjs');
const guardFiles = ['plugins/dsh-redteam-results/lib/client.js', 'plugins/dsh-sec-config/lib/client.js'];
const digest = () => createHash('sha256').update(guardFiles.map((rel) => fs.readFileSync(path.join(root, rel))).join('\n')).digest('hex');
const before = digest();

const COMPLIANT = 'const css = ".dsh-btn{background:var(--dsw-alias-state-business-primary,#4c6ef5)}";\n';
const variants = [
  { id: 'hardcoded-2f81f7', css: 'const css = ".dsh-btn{background:#2f81f7}";\n', failure: /强调色/ },
  { id: 'hardcoded-4c6ef5', css: 'const css = ".dsh-btn{background:#4c6ef5}";\n', failure: /强调色/ },
];

function buildFixture(tag, css) {
  const fixture = fs.mkdtempSync(path.join(boundary, `revcheck-ui-accent-${tag}-`));
  const inside = path.relative(boundary, fixture);
  assert(inside && !inside.startsWith('..') && !path.isAbsolute(inside), '临时目录逃出 _ref/tmp');
  fs.mkdirSync(path.join(fixture, 'scripts', 'lib'), { recursive: true });
  fs.copyFileSync(suite, path.join(fixture, 'scripts', 'test-ui-accent.mjs'));
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
  const result = spawnSync(process.execPath, [path.join(fixture, 'scripts', 'test-ui-accent.mjs')], {
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
      assert.notEqual(status, 0, `${variant.id}: 硬编码强调色必须让门禁失败`);
      assert.match(output, variant.failure, `${variant.id}: 失败原因要指向强调色门禁`);
      console.log(`ok reverse ${variant.id}: the accent gate caught it`);
    } catch (error) {
      failures++;
      console.log(`FAIL reverse ${variant.id}: ${error.message}`);
      console.log(output.split('\n').slice(-6).join('\n'));
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

// 反向的另一半：var fallback / token 定义 / 看板 / 报告必须放行。
{
  const fixture = buildFixture('allowed-contexts',
    'const css = ".dsh-btn{background:var(--dsw-alias-state-business-primary,#4c6ef5)}.dsh-root{--rt-navy-accent:#38d4ff}.dsh-scr-x{background:#4c6ef5}.page{background:#4c6ef5}";\n');
  try {
    const { status, output } = runSuite(fixture);
    assert.equal(status, 0, 'var fallback/token 定义/看板/报告被强调色门禁误伤了：' + output.split('\n').filter((l) => l.startsWith('FAIL')).join(' | '));
    console.log('ok var fallback, token definitions, dashboard and report stay allowed');
  } catch (error) {
    failures++;
    console.log('FAIL allowed-contexts: ' + error.message);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

assert.equal(digest(), before, '反向检查不得改动生产客户端');
console.log('ok accent reverse verification preserves production source');
process.exitCode = failures ? 1 : 0;
