import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const tmp = path.resolve(root, '../_ref/tmp');
const runner = 'test-project-ui.mjs';
const file = 'plugins/dsh-redteam-results/lib/client.js';
const variants = [
  ['project-chat-status', "React.createElement(ProjectChatStatus,{sessionId:props.sessionId,status:current})", "null",
    '聊天上方项目状态行直接显示进度、当前检查和查看表入口'],
  ['project-settings-duplicate', "return React.createElement('div',{className:'dsh-task-project-settings'},React.createElement('p',null,'项目目标和来源已固定。检查结果、历史和导出入口在对话上方的项目状态行。'));",
    "return React.createElement(ProjectPanel,{sessionId:props.sessionId,status:current,onFindings:props.onFindings});",
    '聊天上方项目状态行直接显示进度、当前检查和查看表入口'],
  ['usage-accounting-explanation', "React.createElement('p',null,'用量口径：会话事件调用 '", "React.createElement('p',null,'用量：'",
    '聊天上方项目状态行直接显示进度、当前检查和查看表入口'],
];
const before = createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
for (const [name, from, to, expected] of variants) {
  const fixture = fs.mkdtempSync(path.join(tmp, 'saker-project-ui-reverse-'));
  assert(path.resolve(fixture).startsWith(tmp + path.sep));
  try {
    for (const directory of ['lib', 'shared']) if (fs.existsSync(path.join(root, directory))) fs.cpSync(path.join(root, directory), path.join(fixture, directory), { recursive: true });
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
console.log('ok reverse verification preserves project UI source');
