// W06 反向验证：分别回退部分完成统计、公式文本前缀和未执行结果，确认测试会失败。
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
  ['partial-count', "    if (check.verdict === 'not_found' && check.gaps) counts.partial++;", '',
    '统计把已结束、发现问题、缺条件、部分完成和未开始分开'],
  ['formula-prefix', "  return /^[=+\\-@]/.test(text) ? \"'\" + text : text;", '  return text;',
    '导出表格按文本，公式前缀不会在 Excel 中执行'],
  ['pending-result', "    result: check.executionState !== 'ended' ? (check.executionState === 'running' ? '正在检查' : '未开始') : (RESULT_LABELS[check.verdict] || '未得出结论'),",
    "    result: check.executionState !== 'ended' ? '未发现问题' : (RESULT_LABELS[check.verdict] || '未得出结论'),",
    '导出包含要求、结果、说明与来源，未执行不写成通过'],
];

const before = createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
for (const [name, from, to, expected] of variants) {
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
    const target = path.join(fixture, file);
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
assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex'), before, 'production source changed');
console.log('ok reverse verification preserves the production source file');
