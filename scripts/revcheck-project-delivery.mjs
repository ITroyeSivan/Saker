// 项目结果反向验证：隔离副本中逐项退回错误行为，确认对应断言失败。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const tmp = path.resolve(root, '../_ref/tmp');
const runner = 'test-project-delivery.mjs';
const file = 'plugins/dsh-redteam-results/lib/project-delivery.js';
const variants = [
  ['partial-count', "    if (isPartial(check)) counts.partial++;", '',
    '统计把已结束、发现问题、缺条件、部分完成和未开始分开'],
  ['formula-prefix', "  return /^[=+\\-@]/.test(text) ? \"'\" + text : text;", '  return text;',
    '导出表格按文本，公式前缀不会在 Excel 中执行'],
  ['pending-result', "  if (check.executionState !== 'ended') displayResult = { running: '正在检查', paused: '已暂停' }[check.executionState] || '未开始';",
    "  if (check.executionState !== 'ended') displayResult = '未发现问题';",
    '导出包含要求、结果、说明与来源，未执行不写成通过'],
  ['partial-label', "  else displayResult = isPartial(check) ? '部分完成' : (RESULT_LABELS[check.verdict] || '未得出结论');",
    "  else displayResult = RESULT_LABELS[check.verdict] || '未得出结论';",
    '导出包含要求、结果、说明与来源，未执行不写成通过'],
  ['hidden-gap', "  const displayNotes = [checked, gaps && (checked ? '还缺：' + gaps : gaps)].filter(Boolean).join('；');",
    "  const displayNotes = checked || gaps;",
    '导出包含要求、结果、说明与来源，未执行不写成通过'],
  ['completed-count', "    if (check.verdict === 'issue' || (check.verdict === 'not_found' && !isPartial(check))) counts.checked++;",
    '    counts.checked++;',
    '统计把已结束、发现问题、缺条件、部分完成和未开始分开'],
  ['stopped-results', ': activeProjectRun(st, sessionId) || listProjectRuns(st, sessionId, { limit: 1 })[0] || null;',
    ': activeProjectRun(st, sessionId);',
    'project.start 幂等，pause / resume / stop 状态一致', 'plugins/dsh-redteam-results/lib/index.js'],
  ['historical-selection', 'const run = requestedRunId ? readProjectRun(st, sessionId, requestedRunId)\n        : activeProjectRun(st, sessionId) || listProjectRuns(st, sessionId, { limit: 1 })[0] || null;',
    'const run = activeProjectRun(st, sessionId) || (requestedRunId ? readProjectRun(st, sessionId, requestedRunId) : listProjectRuns(st, sessionId, { limit: 1 })[0]) || null;',
    'project.start 幂等，pause / resume / stop 状态一致', 'plugins/dsh-redteam-results/lib/index.js'],
];

const hashes = new Map([...new Set(variants.map(variant => variant[4] || file))].map(source => [source, createHash('sha256').update(fs.readFileSync(path.join(root, source))).digest('hex')]));
for (const [name, from, to, expected, sourceFile = file] of variants) {
  const fixture = fs.mkdtempSync(path.join(tmp, 'saker-project-delivery-reverse-'));
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
    const target = path.join(fixture, sourceFile);
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
for (const [source, before] of hashes) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, source))).digest('hex'), before, 'production source changed: ' + source);
console.log('ok reverse verification preserves the production source file');
