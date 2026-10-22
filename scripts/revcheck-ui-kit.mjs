// 反向检查：共享组件层门禁必须能失败（令牌被改坏 / 组件缺失 / 门禁不再从共享层取值）。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const boundary = path.resolve(root, '../_ref/tmp');
const suite = path.join(root, 'scripts', 'test-ui-kit.mjs');
const guardFiles = ['shared/ui-kit/ui-kit.json', 'scripts/lib/ui-tokens.mjs'];
const digest = () => createHash('sha256').update(guardFiles.map((rel) => fs.readFileSync(path.join(root, rel))).join('\n')).digest('hex');
const before = digest();

const GATES = ['test-theme-fallbacks.mjs', 'test-ui-spacing.mjs', 'test-ui-radius.mjs', 'test-ui-control-metrics.mjs', 'test-ui-line-height.mjs'];
const variants = [
  { id: 'spacing-25', mutate: (kit) => ({ ...kit, spacing: [...kit.spacing.filter((n) => n !== 24), 25] }), failure: /间距令牌/ },
  { id: 'missing-empty-state', mutate: (kit) => ({ ...kit, components: kit.components.filter((c) => c !== 'EmptyState') }), failure: /组件清单/ },
  { id: 'line-height-1.6', mutate: (kit) => ({ ...kit, lineHeight: 1.6 }), failure: /行高令牌/ },
  { id: 'height-control-30', mutate: (kit) => ({ ...kit, height: { ...kit.height, control: 30 } }), failure: /控件尺寸令牌/ },
];

function buildFixture(tag, mutate) {
  const fixture = fs.mkdtempSync(path.join(boundary, `revcheck-ui-kit-${tag}-`));
  const inside = path.relative(boundary, fixture);
  assert(inside && !inside.startsWith('..') && !path.isAbsolute(inside), '临时目录逃出 _ref/tmp');
  fs.mkdirSync(path.join(fixture, 'scripts', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'shared', 'ui-kit'), { recursive: true });
  fs.copyFileSync(suite, path.join(fixture, 'scripts', 'test-ui-kit.mjs'));
  fs.copyFileSync(path.join(root, 'scripts', 'lib', 'ui-tokens.mjs'), path.join(fixture, 'scripts', 'lib', 'ui-tokens.mjs'));
  fs.copyFileSync(path.join(root, 'scripts', 'lib', 'product-plugins.mjs'), path.join(fixture, 'scripts', 'lib', 'product-plugins.mjs'));
  for (const gate of GATES) fs.copyFileSync(path.join(root, 'scripts', gate), path.join(fixture, 'scripts', gate));
  fs.copyFileSync(path.join(root, 'shared', 'ui-kit', 'ui-kit.css'), path.join(fixture, 'shared', 'ui-kit', 'ui-kit.css'));
  for (const name of ['dsh-redteam-results', 'dsh-hunter', 'dsh-session-pulse', 'dsh-mode-group', 'dsh-sec-config', 'dsh-skill-browse']) {
    fs.mkdirSync(path.join(fixture, 'plugins', name, 'lib'), { recursive: true });
    fs.copyFileSync(path.join(root, 'plugins', name, 'lib', 'client.js'), path.join(fixture, 'plugins', name, 'lib', 'client.js'));
    fs.writeFileSync(path.join(fixture, 'plugins', name, 'package.json'), JSON.stringify({ name: `@dsh-external/${name}`, version: '1.0.0' }));
  }
  fs.mkdirSync(path.join(fixture, 'plugins', 'dsh-mcp-studio', 'src', 'client'), { recursive: true });
  fs.mkdirSync(path.join(fixture, 'plugins', 'dsh-mcp-studio', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'plugins', 'dsh-mcp-studio', 'package.json'), JSON.stringify({ name: '@dsh-external/dsh-mcp-studio', version: '1.0.0' }));
  fs.copyFileSync(path.join(root, 'plugins', 'dsh-mcp-studio', 'src', 'client', 'ui-kit-css.ts'), path.join(fixture, 'plugins', 'dsh-mcp-studio', 'src', 'client', 'ui-kit-css.ts'));
  fs.copyFileSync(path.join(root, 'plugins', 'dsh-mcp-studio', 'lib', 'client.js'), path.join(fixture, 'plugins', 'dsh-mcp-studio', 'lib', 'client.js'));
  const kit = JSON.parse(fs.readFileSync(path.join(root, 'shared', 'ui-kit', 'ui-kit.json'), 'utf8'));
  fs.writeFileSync(path.join(fixture, 'shared', 'ui-kit', 'ui-kit.json'), JSON.stringify(mutate(kit), null, 2));
  return fixture;
}

function runSuite(fixture) {
  const result = spawnSync(process.execPath, [path.join(fixture, 'scripts', 'test-ui-kit.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, TEMP: boundary, TMP: boundary, TMPDIR: boundary },
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

let failures = 0;
for (const variant of variants) {
  const fixture = buildFixture(variant.id, variant.mutate);
  try {
    const { status, output } = runSuite(fixture);
    try {
      assert.notEqual(status, 0, `${variant.id}: 坏令牌必须让门禁失败`);
      assert.match(output, variant.failure, `${variant.id}: 失败原因要指向对应令牌`);
      console.log(`ok reverse ${variant.id}: the ui-kit gate caught it`);
    } catch (error) {
      failures++;
      console.log(`FAIL reverse ${variant.id}: ${error.message}`);
      console.log(output.split('\n').slice(-6).join('\n'));
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

// 反向的另一半：某个门禁不再从共享层取值时，也必须失败。
{
  const fixture = buildFixture('gate-detached', (kit) => kit);
  try {
    const gate = path.join(fixture, 'scripts', 'test-ui-spacing.mjs');
    fs.writeFileSync(gate, fs.readFileSync(gate, 'utf8').replace("./lib/ui-tokens.mjs", "./lib/other.mjs"));
    const { status, output } = runSuite(fixture);
    assert.notEqual(status, 0, '门禁脱离共享层必须让 ui-kit 门禁失败');
    assert.match(output, /从共享组件层取值/, '失败原因要指向门禁脱离共享层');
    console.log('ok reverse gate-detached: the ui-kit gate caught it');
  } catch (error) {
    failures++;
    console.log('FAIL reverse gate-detached: ' + error.message);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

// 反向的另一半：注入的 CSS 与共享来源不一致、或 DOM 不再使用 canonical 类时，也必须失败。
const clientVariants = [
  { id: 'injected-drift', mutate: (s) => s.replace('.saker-ui-btn{height:32px', '.saker-ui-btn{height:30px'), failure: /逐字节一致/ },
  { id: 'dom-class-removed', mutate: (s) => s.split('saker-ui-btn').join('saker-ui-removed'), failure: /canonical 类 saker-ui-btn/ },
];
for (const variant of clientVariants) {
  const fixture = buildFixture(variant.id, (kit) => kit);
  try {
    const clientPath = path.join(fixture, 'plugins', 'dsh-redteam-results', 'lib', 'client.js');
    const original = fs.readFileSync(clientPath, 'utf8');
    const next = variant.mutate(original);
    assert.notEqual(next, original, `${variant.id}: 变体必须真的改到客户端`);
    fs.writeFileSync(clientPath, next);
    const { status, output } = runSuite(fixture);
    assert.notEqual(status, 0, `${variant.id}: 必须让门禁失败`);
    assert.match(output, variant.failure, `${variant.id}: 失败原因要指向对应检查`);
    console.log(`ok reverse ${variant.id}: the ui-kit gate caught it`);
  } catch (error) {
    failures++;
    console.log(`FAIL reverse ${variant.id}: ${error.message}`);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

assert.equal(digest(), before, '反向检查不得改动共享组件层');
console.log('ok ui-kit reverse verification preserves the shared source');
process.exitCode = failures ? 1 : 0;
