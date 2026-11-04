import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const tmp = path.resolve(root, '../_ref/tmp');
const runner = 'test-ordinary-reports.mjs';
const variants = [
  ['include-incomplete-turns', 'if (!text || record.callState !== \'returned\') continue;', 'if (!text) continue;',
    'only the final returned assistant message per completed turn becomes a report', 'task-cost.js'],
  ['include-hidden-reasoning',
    ".filter(item => item?.type === 'text' || (item?.type === undefined && (item?.text !== undefined || item?.content !== undefined)))",
    '.filter(() => true)', 'only the final returned assistant message per completed turn becomes a report', 'task-cost.js'],
  ['silent-report-truncation', "const marker = item.truncated", "const marker = false", 'large reports expose the omitted range',
    'bundle.js'],
];

for (const [name, from, to, expected, file] of variants) {
  const fixture = fs.mkdtempSync(path.join(tmp, 'ordinary-reports-reverse-'));
  assert(path.resolve(fixture).startsWith(tmp + path.sep));
  try {
    for (const directory of ['lib', 'shared', 'plugins/dsh-redteam-results/lib', 'scripts/lib']) {
      fs.mkdirSync(path.dirname(path.join(fixture, directory)), { recursive: true });
      fs.cpSync(path.join(root, directory), path.join(fixture, directory), { recursive: true });
    }
    fs.copyFileSync(path.join(root, 'package.json'), path.join(fixture, 'package.json'));
    fs.mkdirSync(path.join(fixture, 'scripts'), { recursive: true });
    for (const script of [runner, 'test-stub-register.mjs', 'test-stub-loader.mjs', 'test-home-isolation.mjs']) {
      fs.copyFileSync(path.join(root, 'scripts', script), path.join(fixture, 'scripts', script));
    }
    const target = path.join(fixture, 'plugins/dsh-redteam-results/lib', file);
    const source = fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n');
    assert.equal(source.split(from).length - 1, 1, name + ' mutation anchor');
    fs.writeFileSync(target, source.replace(from, to));
    const result = spawnSync(process.execPath, ['--import',
      pathToFileURL(path.join(fixture, 'scripts/test-stub-register.mjs')).href,
      path.join(fixture, 'scripts', runner)], {
      cwd: root, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp },
    });
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, name + ' unexpectedly passed');
    assert(output.includes('FAIL ' + expected), name + ' failed outside target assertion: ' + output);
    console.log('ok reverse ' + name + ': original behavior makes the targeted assertion fail');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}
console.log('ok reverse ordinary reports preserve final turn and truncation truth');
