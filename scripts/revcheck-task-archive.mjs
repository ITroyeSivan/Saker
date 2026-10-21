import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const tmp = path.resolve(root, '../_ref/tmp');
const runner = 'test-task-archive.mjs';
const file = 'plugins/dsh-redteam-results/lib/task-archive.js';
const variants = [
  ['restore-running-regression', "record.state = 'paused';", 'record.state = record.state;',
    '恢复中运行/检查为暂停，queued 取消、dispatched 标未知'],
  ['unknown-column-regression', 'if (rowKeys.some(key => !allowed.has(key))) throw new Error(table + \' 包含当前 schema 不存在的列\');', '',
    '缺少摘要、未知表/列和残留目标数据全部拒绝且不写入半份数据'],
  ['attachment-hydration-regression',
    "record.originalBase64 = bytes.toString('base64');\n        record.digest = createHash('sha256').update(bytes).digest('hex');",
    "record.originalBase64 = '';\n        record.digest = createHash('sha256').update(bytes).digest('hex');",
    '归档把外部附件内容内联，原文件删除后仍可恢复'],
];
const before = createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
for (const [name, from, to, expected] of variants) {
  const fixture = fs.mkdtempSync(path.join(tmp, 'saker-task-archive-reverse-'));
  assert(path.resolve(fixture).startsWith(tmp + path.sep));
  try {
    for (const directory of ['lib', 'shared']) {
      if (fs.existsSync(path.join(root, directory))) fs.cpSync(path.join(root, directory), path.join(fixture, directory), { recursive: true });
    }
    for (const plugin of fs.readdirSync(path.join(root, 'plugins'))) {
      const source = path.join(root, 'plugins', plugin, 'lib');
      if (fs.existsSync(source)) fs.cpSync(source, path.join(fixture, 'plugins', plugin, 'lib'), { recursive: true });
    }
    fs.copyFileSync(path.join(root, 'package.json'), path.join(fixture, 'package.json'));
    fs.mkdirSync(path.join(fixture, 'scripts', 'lib'), { recursive: true });
    for (const script of [runner, 'test-stub-register.mjs', 'test-stub-loader.mjs', 'test-home-isolation.mjs'])
      fs.copyFileSync(path.join(root, 'scripts', script), path.join(fixture, 'scripts', script));
    fs.copyFileSync(path.join(root, 'scripts/lib/project-test-fixtures.mjs'), path.join(fixture, 'scripts/lib/project-test-fixtures.mjs'));
    const target = path.join(fixture, file);
    const content = fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n');
    assert.equal(content.split(from).length - 1, 1, name + ' mutation anchor');
    fs.writeFileSync(target, content.replace(from, to));
    const result = spawnSync(process.execPath, [
      '--import', pathToFileURL(path.join(fixture, 'scripts/test-stub-register.mjs')).href,
      path.join(fixture, 'scripts', runner),
    ], { cwd: root, encoding: 'utf8', timeout: 120000, env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp } });
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, name + ' unexpectedly passed');
    assert(output.includes('FAIL ' + expected), name + ' failed outside target assertion: ' + output);
    console.log('ok reverse ' + name + ': original behavior makes the targeted assertion fail');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}
assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex'), before, 'production source changed');
console.log('ok reverse verification preserves task archive source');
