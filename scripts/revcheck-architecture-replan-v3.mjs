import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const tmp = path.resolve(root, '../_ref/tmp');
const runner = 'test-three-scenes-remediation.mjs';
const variants = [
  ['single-null-limit-invalid',
    "if(value!==undefined && value!==null && (!integer(value)||value<1))",
    "if(value!==undefined && (!integer(value)||value<1))",
    'competition limits accept one field', 'model-budget.js'],
  ['limit-change-resets-time',
    'const budgetStartedAt = requestedMinutes === null || requestedMinutes === undefined\n'
      + '      ? undefined\n'
      + '      : (priorBudget.startedAt || nowIso())',
    'const budgetStartedAt = requestedMinutes === null || requestedMinutes === undefined\n'
      + '      ? undefined\n'
      + '      : nowIso()',
    'competition limits accept one field', 'scene-context.js'],
  ['pause-does-not-block-dispatch',
    'if (settings?.continuationPaused)', 'if (false)',
    'competition pause blocks new commands', 'competition-execution.js'],
  ['provider-name-is-service-key',
    '  if(options.local===true)return \'model-service:provider:\'+String(options.provider||\'local\');\n  return null;\n}',
    '  return \'model-service:provider:\'+String(options.provider||\'local\');\n}',
    'model service identity uses the configured URL', 'model-budget.js'],
];

for (const [name, from, to, expected, file] of variants) {
  const fixture = fs.mkdtempSync(path.join(tmp, 'architecture-replan-v3-reverse-'));
  assert(path.resolve(fixture).startsWith(tmp + path.sep));
  try {
    for (const directory of ['lib', 'shared']) fs.cpSync(path.join(root, directory), path.join(fixture, directory), { recursive: true });
    for (const plugin of fs.readdirSync(path.join(root, 'plugins'))) {
      const source = path.join(root, 'plugins', plugin, 'lib');
      if (fs.existsSync(source)) fs.cpSync(source, path.join(fixture, 'plugins', plugin, 'lib'), { recursive: true });
    }
    fs.copyFileSync(path.join(root, 'package.json'), path.join(fixture, 'package.json'));
    fs.mkdirSync(path.join(fixture, 'scripts', 'lib'), { recursive: true });
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
console.log('ok reverse V03/V05 control and service identity contracts are falsifiable');
