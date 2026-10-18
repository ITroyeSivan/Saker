// 反向检查：5.7 阴影门禁必须能失败，且覆盖层/焦点环/状态光晕/看板/报告必须放行。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const boundary = path.resolve(root, '../_ref/tmp');
const suite = path.join(root, 'scripts', 'test-ui-shadow.mjs');
const guardFiles = ['plugins/dsh-mcp-studio/lib/client.js', 'plugins/dsh-hunter/lib/client.js'];
const digest = () => createHash('sha256').update(guardFiles.map((rel) => fs.readFileSync(path.join(root, rel))).join('\n')).digest('hex');
const before = digest();

const COMPLIANT = 'const css = ".dsh-root{color:red}";\n';
const variants = [
  { id: 'card-shadow', css: 'const css = ".dsh-card{box-shadow:0 4px 14px rgba(0,0,0,.1)}";\n', failure: /阴影/ },
  { id: 'button-shadow', css: 'const css = ".dsh-btn{box-shadow:var(--dsw-shadow-lv1)}";\n', failure: /阴影/ },
];

function buildFixture(tag, css) {
  const fixture = fs.mkdtempSync(path.join(boundary, `revcheck-ui-shadow-${tag}-`));
  const inside = path.relative(boundary, fixture);
  assert(inside && !inside.startsWith('..') && !path.isAbsolute(inside), '临时目录逃出 _ref/tmp');
  fs.mkdirSync(path.join(fixture, 'scripts', 'lib'), { recursive: true });
  fs.copyFileSync(suite, path.join(fixture, 'scripts', 'test-ui-shadow.mjs'));
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
  const result = spawnSync(process.execPath, [path.join(fixture, 'scripts', 'test-ui-shadow.mjs')], {
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
      assert.notEqual(status, 0, `${variant.id}: 非覆盖层阴影必须让门禁失败`);
      assert.match(output, variant.failure, `${variant.id}: 失败原因要指向阴影门禁`);
      console.log(`ok reverse ${variant.id}: the shadow gate caught it`);
    } catch (error) {
      failures++;
      console.log(`FAIL reverse ${variant.id}: ${error.message}`);
      console.log(output.split('\n').slice(-6).join('\n'));
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

// 反向的另一半：覆盖层/焦点环/状态光晕/inset/看板/报告必须放行。
{
  const fixture = buildFixture('allowed-contexts',
    'const css = ".dsh-drawer{box-shadow:0 10px 32px rgba(0,0,0,.2)}.dsh-input:focus{box-shadow:0 0 0 3px rgba(0,0,0,.1)}.dsh-dot{box-shadow:0 0 6px rgba(0,0,0,.5)}.dsh-row.is-active{box-shadow:inset 3px 0 0 var(--x)}.dsh-scr-x{box-shadow:0 4px 14px #000}.page{box-shadow:0 4px 14px #000}";\n');
  try {
    const { status, output } = runSuite(fixture);
    assert.equal(status, 0, '覆盖层/焦点环/状态光晕/看板/报告被阴影门禁误伤了：' + output.split('\n').filter((l) => l.startsWith('FAIL')).join(' | '));
    console.log('ok overlays, focus rings, status glows, dashboard and report stay allowed');
  } catch (error) {
    failures++;
    console.log('FAIL allowed-contexts: ' + error.message);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

assert.equal(digest(), before, '反向检查不得改动生产客户端');
console.log('ok shadow reverse verification preserves production source');
process.exitCode = failures ? 1 : 0;
