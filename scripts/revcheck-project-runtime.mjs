// W05 反向验证：分别回退无进展阈值、取消检查和依赖受阻，确认测试会失败。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const tmp = path.resolve(root, '../_ref/tmp');
const runner = 'test-project-runtime.mjs';
const file = 'plugins/dsh-redteam-results/lib/project-runtime.js';
const progressFile = 'plugins/dsh-redteam-results/lib/project-progress.js';
const variants = [
  ['no-progress-threshold',
    '  if (!executable.length) return null;\n  const fingerprint = projectProgressFingerprint(store, sessionId, run.runId);\n  const attempts = run.lastContinuationFingerprint === fingerprint ? (run.continuationNoProgress || 0) + 1 : 0;\n  if (attempts >= 2) {',
    '  if (!executable.length) return null;\n  const fingerprint = projectProgressFingerprint(store, sessionId, run.runId);\n  const attempts = run.lastContinuationFingerprint === fingerprint ? (run.continuationNoProgress || 0) + 1 : 0;\n  if (false) {',
    '同一进度重复接续达到阈值后暂停'],
  ['paused-run', "  if (!run || run.state !== 'running') return null;", '  if (!run) return null;',
    '取消、暂停和在途动作都不会被旧消息唤醒'],
  ['dependency-block', "  if (!Array.isArray(check.dependencies) || !check.dependencies.length) return false;", '  return false;',
    '依赖受阻的检查不阻塞独立项'],
  ['failed-actions-count-as-progress', '    for (const action of listProjectActions(store, sessionId, runId)) {',
    "    for (const action of listProjectActions(store, sessionId, runId)) { seen.add(hash(['failed-action', action.actionId]));",
    '相同失败动作换新 ID 仍会无进展暂停', progressFile],
  ['response-id-counts-as-progress', "seen.add(hash(['response', action.checkId, receipt.method", "seen.add(hash(['response', action.actionId, action.checkId, receipt.method",
    '相同成功观测换回执 ID 和响应时间不重复算进展', progressFile],
  ['forget-seen-progress', 'const seen = new Set(run.progressFacts || []);', 'const seen = new Set();',
    '增加未读取来源不算进展，检查状态往返不反复清零', progressFile],
  ['late-continuation-mark', "if (!run || !['preparing', 'running'].includes(run.state) || (expectedControlRev !== undefined && run.controlRev !== expectedControlRev)) return null;", 'if (!run) return null;',
    '迟到的接续标记不能修改已停止运行'],
  ['duplicate-document-range', 'if (length(merged) <= length(previous)) return false;', 'if (false) return false;',
    '真实文档工具读取新范围计进展，重读和搜索同片段不清零', progressFile, 'test-project-knowledge.mjs'],
  ['legacy-empty-negative-complete', '    if (evidenceProblems.length) {\n      return {\n        action: \'waiting\', run,', '    if (false) {\n      return {\n        action: \'waiting\', run,',
    '完成判断独立拒绝历史遗留的无动作完整阴性'],
];

const sourceHash = () => createHash('sha256').update([file, progressFile].map(relative => fs.readFileSync(path.join(root, relative))).join('\n')).digest('hex');
const before = sourceHash();
for (const [name, from, to, expected, variantFile = file, variantRunner = runner] of variants) {
  const fixture = fs.mkdtempSync(path.join(tmp, 'saker-project-runtime-reverse-'));
  assert(path.resolve(fixture).startsWith(tmp + path.sep));
  try {
    for (const directory of ['lib', 'shared']) fs.cpSync(path.join(root, directory), path.join(fixture, directory), { recursive: true });
    for (const plugin of fs.readdirSync(path.join(root, 'plugins'))) {
      const source = path.join(root, 'plugins', plugin, 'lib');
      if (fs.existsSync(source)) fs.cpSync(source, path.join(fixture, 'plugins', plugin, 'lib'), { recursive: true });
    }
    fs.copyFileSync(path.join(root, 'package.json'), path.join(fixture, 'package.json'));
    fs.mkdirSync(path.join(fixture, 'scripts'), { recursive: true });
    for (const script of [runner, 'test-project-knowledge.mjs', 'test-stub-register.mjs', 'test-stub-loader.mjs', 'test-home-isolation.mjs'])
      fs.copyFileSync(path.join(root, 'scripts', script), path.join(fixture, 'scripts', script));
    const target = path.join(fixture, variantFile);
    const content = fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n');
    assert.equal(content.split(from).length - 1, 1, name + ' mutation anchor');
    fs.writeFileSync(target, content.replace(from, to));
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(fixture, 'scripts/test-stub-register.mjs')).href, path.join(fixture, 'scripts', variantRunner)],
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
