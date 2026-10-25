// W04 反向验证：分别回退只读/范围检查和未知写入标记，确认测试会失败。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const tmp = path.resolve(root, '../_ref/tmp');
const runner = 'test-project-execution.mjs';
const file = 'plugins/dsh-redteam-results/lib/project-execution.js';
const storeFile = 'plugins/dsh-redteam-results/lib/project-store.js';
const variants = [
  ['limit-denial', "  const denial = targetTrafficDenial(limits, { method }) || excludedPathDenial(limits, { url: url.href })\n    || targetScopeDenial(store, sessionId, limits, url);\n  if (denial) throw new Error(denial);", '',
    '只读任务拒绝写方法'],
  ['scope-check', "  return !taskScopeIncludesUrl(limits, url)\n    ? 'request is outside the current task site or user-allowed associated sites' : undefined;", '  return undefined;',
    '范围外 URL 被拒绝'],
  ['unknown-write', "    const sideEffectUnknown = dispatched && !['GET', 'HEAD', 'OPTIONS'].includes(method);", '    const sideEffectUnknown = false;',
    '写方法超时保留 sideEffectUnknown'],
  ['stale-control-version', 'if (action.controlRev !== run.controlRev || (input.controlRev !== undefined && input.controlRev !== action.controlRev))', 'if (false)',
    '旧控制版本的排队动作在暂停恢复后不派发，新版本动作仍可执行', 'plugins/dsh-redteam-results/lib/project-store.js'],
  ['stale-queued-identity', 'if (input.identityRef !== undefined', 'if (false',
    '排队动作的身份引用变化后不能派发', 'plugins/dsh-redteam-results/lib/project-store.js'],
  ['response-aborted-settlement',
    "      incoming.once('aborted', () => finishReject('response-aborted', '响应在完整结束前被中止', { requestsWritten: true, responseStarted: true }));\n"
      + "      incoming.once('error', error => finishReject('response-error', error.code || error.message || '响应流错误', { requestsWritten: true, responseStarted: true }));\n"
      + "      incoming.once('close', () => {\n"
      + "        if (!incoming.complete) finishReject('response-closed', '响应流在完整结束前关闭', { requestsWritten: true, responseStarted: true });\n"
      + "      });",
    '',
    '响应中途断开在期限内收尾并保留未知副作用'],
  ['summary-secret-redaction', 'const bodyText = redactText(decoded.text);', 'const bodyText = decoded.text;',
    '项目工具摘要与响应头遮蔽合成凭据并保留业务正文'],
  ['associated-api-scope', '  if (!authContext) return undefined;', '  return undefined;',
    '明确关联 API 可通过，身份只在显式绑定后套用'],
];

const sourceHash = () => createHash('sha256').update([file, storeFile].map(relative => fs.readFileSync(path.join(root, relative))).join('\n')).digest('hex');
const before = sourceHash();
for (const [name, from, to, expected, variantFile = file] of variants) {
  const fixture = fs.mkdtempSync(path.join(tmp, 'saker-project-execution-reverse-'));
  assert(path.resolve(fixture).startsWith(tmp + path.sep));
  try {
    for (const directory of ['lib', 'shared']) fs.cpSync(path.join(root, directory), path.join(fixture, directory), { recursive: true });
    for (const plugin of fs.readdirSync(path.join(root, 'plugins'))) {
      const source = path.join(root, 'plugins', plugin, 'lib');
      if (fs.existsSync(source)) fs.cpSync(source, path.join(fixture, 'plugins', plugin, 'lib'), { recursive: true });
    }
    fs.copyFileSync(path.join(root, 'package.json'), path.join(fixture, 'package.json'));
    fs.mkdirSync(path.join(fixture, 'scripts'), { recursive: true });
    for (const script of [runner, 'test-stub-register.mjs', 'test-stub-loader.mjs', 'test-home-isolation.mjs'])
      fs.copyFileSync(path.join(root, 'scripts', script), path.join(fixture, 'scripts', script));
    const target = path.join(fixture, variantFile);
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
assert.equal(sourceHash(), before, 'production source changed');
console.log('ok reverse verification preserves the production source file');
