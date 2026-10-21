import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const tmp = path.resolve(root, '../_ref/tmp');
const runner = 'test-browser-session.mjs';
const sourceFiles = [
  'plugins/dsh-redteam-results/lib/browser-session.js',
  'plugins/dsh-redteam-results/lib/redaction.js',
];
const variants = [
  ['browser-request-guard', 'if (typeof this.requestGuard === \'function\')', 'if (false)',
    '真实 CfT 在请求发出前阻断跨站跳转、iframe 与 XHR'],
  ['browser-response-header-redaction', 'responseHeaders: redactHeaders(responseHeaders)', 'responseHeaders',
    '确定性浏览器记录遮蔽 Set-Cookie 并保留正文不可得原因'],
  ['browser-missing-element-state',
    "      const denied = this.policyDenials.slice(denialStart);\n      if (denied.length) throw new Error('浏览器动作触发的请求被策略阻断：' + denied[0].reason);\n      const value = result.result?.value || { found: false };\n      return value.found === false ? { ...value, state: 'failed', error: 'element-not-found' } : { ...value, state: 'completed' };",
    "      const denied = this.policyDenials.slice(denialStart);\n      if (denied.length) throw new Error('浏览器动作触发的请求被策略阻断：' + denied[0].reason);\n      const value = result.result?.value || { found: false };\n      return value;",
    '真实 CfT 失败元素、弹窗、上传、下载和请求分页可核对'],
];
const sourceHash = () => createHash('sha256').update(sourceFiles.map(relative => fs.readFileSync(path.join(root, relative))).join('\n')).digest('hex');
const before = sourceHash();
for (const [name, from, to, expected] of variants) {
  const fixture = fs.mkdtempSync(path.join(tmp, 'saker-browser-session-reverse-'));
  assert(path.resolve(fixture).startsWith(tmp + path.sep));
  try {
    for (const plugin of fs.readdirSync(path.join(root, 'plugins'))) {
      const source = path.join(root, 'plugins', plugin, 'lib');
      if (fs.existsSync(source)) fs.cpSync(source, path.join(fixture, 'plugins', plugin, 'lib'), { recursive: true });
    }
    for (const directory of ['lib', 'shared']) {
      if (fs.existsSync(path.join(root, directory))) fs.cpSync(path.join(root, directory), path.join(fixture, directory), { recursive: true });
    }
    fs.copyFileSync(path.join(root, 'package.json'), path.join(fixture, 'package.json'));
    fs.mkdirSync(path.join(fixture, 'scripts', 'lib'), { recursive: true });
    for (const script of [runner, 'test-stub-register.mjs', 'test-stub-loader.mjs', 'test-home-isolation.mjs'])
      fs.copyFileSync(path.join(root, 'scripts', script), path.join(fixture, 'scripts', script));
    const target = path.join(fixture, sourceFiles[0]);
    const content = fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n');
    assert.equal(content.split(from).length - 1, 1, name + ' mutation anchor');
    fs.writeFileSync(target, content.replace(from, to));
    const result = spawnSync(process.execPath, [
      '--import', pathToFileURL(path.join(fixture, 'scripts/test-stub-register.mjs')).href,
      path.join(fixture, 'scripts', runner),
    ], {
      cwd: root, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp,
        SAKER_CFT_PATH: process.env.SAKER_CFT_PATH || 'E:/software/ChromeForTesting/chrome-win64/chrome.exe' },
    });
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, name + ' unexpectedly passed');
    assert(output.includes('FAIL ' + expected), name + ' failed outside target assertion: ' + output);
    console.log('ok reverse ' + name + ': original behavior makes the targeted assertion fail');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}
assert.equal(sourceHash(), before, 'production source changed');
console.log('ok reverse verification preserves browser production sources');
