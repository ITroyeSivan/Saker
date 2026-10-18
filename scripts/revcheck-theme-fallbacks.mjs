// 反向检查：主题回退与设计令牌两条门禁都必须能失败。
//
// 为什么需要：`test-theme-fallbacks.mjs` 是静态扫描，最容易变成"跑完总是绿"。
// 这里在**合成副本**里各注入一处坏写法（不动生产文件），要求套件必须报出对应失败。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const boundary = path.resolve(root, '../_ref/tmp');
const suite = path.join(root, 'scripts', 'test-theme-fallbacks.mjs');
const client = path.join(root, 'plugins', 'dsh-redteam-results', 'lib', 'client.js');
const digest = () => createHash('sha256').update(fs.readFileSync(client)).digest('hex');
const before = digest();

const variants = [
  { id: 'off-token-font-size', append: 'const __tokenProbe = { fontSize: 11 };\n', failure: /字号不在 5\.7 令牌/ },
  { id: 'off-token-css-font-size', append: 'const __cssProbe = ".dsh-probe{font-size:11px}";\n', failure: /字号不在 5\.7 令牌/ },
  { id: 'off-token-font-shorthand', append: 'const __shorthandProbe = ".dsh-probe{font:11px/16px monospace}";\n', failure: /字号不在 5\.7 令牌/ },
  { id: 'undefined-host-var-near-white', append: "const __bgProbe = { background: 'var(--dsw-not-a-real-variable, #ffffff)' };\n", failure: /浅底浅字/ },
];

/** 造一份只含被测套件所需文件的合成仓库，并在客户端末尾追加一段探针。 */
function buildFixture(tag, append) {
  const fixture = fs.mkdtempSync(path.join(boundary, `revcheck-theme-${tag}-`));
  const inside = path.relative(boundary, fixture);
  assert(inside && !inside.startsWith('..') && !path.isAbsolute(inside), '临时目录逃出 _ref/tmp');
  fs.mkdirSync(path.join(fixture, 'scripts', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'shared', 'ui-kit'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'plugins', 'dsh-redteam-results', 'lib'), { recursive: true });
  fs.copyFileSync(suite, path.join(fixture, 'scripts', 'test-theme-fallbacks.mjs'));
  for (const rel of ['scripts/lib/product-plugins.mjs', 'scripts/lib/host-theme-vars.json', 'scripts/lib/ui-tokens.mjs', 'shared/ui-kit/ui-kit.json', 'plugins/dsh-redteam-results/package.json']) {
    fs.copyFileSync(path.join(root, rel), path.join(fixture, rel));
  }
  fs.writeFileSync(path.join(fixture, 'plugins', 'dsh-redteam-results', 'lib', 'client.js'), fs.readFileSync(client, 'utf8') + append);
  return fixture;
}

function runSuite(fixture) {
  const result = spawnSync(process.execPath, [path.join(fixture, 'scripts', 'test-theme-fallbacks.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, TEMP: boundary, TMP: boundary, TMPDIR: boundary },
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

let failures = 0;
for (const variant of variants) {
  const fixture = buildFixture(variant.id, variant.append);
  try {
    const { status, output } = runSuite(fixture);
    try {
      assert.notEqual(status, 0, `${variant.id}: 坏写法必须让门禁失败`);
      assert.match(output, variant.failure, `${variant.id}: 失败原因要指向对应门禁`);
      console.log(`ok reverse ${variant.id}: the design gate caught it`);
    } catch (error) {
      failures++;
      console.log(`FAIL reverse ${variant.id}: ${error.message}`);
      console.log(output.split('\n').slice(-6).join('\n'));
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

// 反向的另一半：排除语境不能被误伤。看板与导出报告本来就该用另一套字号，写进去必须放行。
{
  const fixture = buildFixture('allowed-contexts', 'const __allowed = ".dsh-scr-probe{font-size:22px}.page{font-size:24px}";\n');
  try {
    const { status, output } = runSuite(fixture);
    assert.equal(status, 0, '看板/报告语境被字号门禁误伤了：' + output.split('\n').filter(l => l.startsWith('FAIL')).join(' | '));
    console.log('ok dashboard and exported-report contexts stay allowed');
  } catch (error) {
    failures++;
    console.log('FAIL allowed-contexts: ' + error.message);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

assert.equal(digest(), before, '反向检查不得改动生产客户端');
console.log('ok theme reverse verification preserves production source');
process.exitCode = failures ? 1 : 0;
