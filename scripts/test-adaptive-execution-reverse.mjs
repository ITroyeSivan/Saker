// Production mutations are evaluated only in a self-contained workspace temp copy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url));
const boundary = path.resolve(root, '../_ref/tmp');
assert.equal(path.resolve(os.tmpdir()), boundary, 'set TEMP/TMP/TMPDIR to workspace _ref/tmp');
const copy = fs.mkdtempSync(path.join(boundary, 'adaptive-reverse-'));
const files = ['package.json', 'lib', 'plugins/dsh-redteam-results/lib',
  'scripts/test-research-ledger.mjs', 'scripts/test-home-isolation.mjs', 'scripts/test-stub-loader.mjs', 'scripts/test-stub-register.mjs'];
try {
  for (const file of files) { fs.mkdirSync(path.dirname(path.join(copy, file)), { recursive: true }); fs.cpSync(path.join(root, file), path.join(copy, file), { recursive: true }); }
  const cases = [
    ['research.js', "record.state = restriction ? 'restricted' : 'stopped';", "record.state = 'stopped';", 'policy interruption persists separately without fabricated executions or negative coverage'],
    ['research.js', 'if ((row.operationCalls || 0) >= 2)', 'if (false)', 'regular and nday preserve two-operation observation gates across restart and continue another actual input'],
    ['task-policy.js', "if (/^(?:subagent(?:_|$)|workflow$|send_message$)/.test(name))", 'if (false)', 'subagent dispatch and relabelled baseline cannot reset deterministic task limits'],
    ['research.js', 'hash([row.endpoint, row.authContext, row.request, row.response, controlledInputs,', 'hash([row.id, row.revision, row.endpoint, row.authContext, row.request, row.response, controlledInputs,', 'subagent dispatch and relabelled baseline cannot reset deterministic task limits'],
    ['checked.js', 'if (old && rows[i].supplementAttempts', 'if (false && old && rows[i].supplementAttempts', 'supplement count cannot regress and routine model render omits archived packets'],
  ];
  for (const [file, anchor, mutation, assertion] of cases) {
    const target = path.join(copy, 'plugins/dsh-redteam-results/lib', file), original = fs.readFileSync(target, 'utf8');
    assert.equal(original.split(anchor).length - 1, 1, 'mutation anchor must occur once');
    fs.writeFileSync(target, original.replace(anchor, mutation));
    try {
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(copy, 'scripts/test-stub-register.mjs')).href, 'scripts/test-research-ledger.mjs'],
        { cwd: copy, env: { ...process.env, SAKER_ROOT: copy }, encoding: 'utf8', timeout: 60000 });
      assert.notEqual(result.status, 0, 'old behavior must fail');
      assert(result.stdout?.includes('FAIL ' + assertion + ':'), 'must fail named assertion, not loader: ' + (result.stderr || result.stdout));
      console.log('ok   reverse caught ' + file + ': ' + assertion);
    } finally { fs.writeFileSync(target, original); }
  }
} finally { assert(copy.startsWith(boundary + path.sep)); fs.rmSync(copy, { recursive: true, force: true }); }
