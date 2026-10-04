import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url)), boundary = path.resolve(root, '../_ref/tmp');
assert.equal(path.resolve(os.tmpdir()), boundary, 'set TEMP/TMP/TMPDIR to workspace _ref/tmp');
const copy = fs.mkdtempSync(path.join(boundary, 'verification-basis-reverse-'));
try {
  for (const file of ['package.json', 'lib', 'plugins/dsh-nday-hunter/lib', 'plugins/dsh-redteam-results/lib',
    'preset/pentest/refs/nday/catalog.json', 'scripts/test-shared-verification.mjs',
    'scripts/test-home-isolation.mjs', 'scripts/test-stub-loader.mjs', 'scripts/test-stub-register.mjs']) {
    fs.mkdirSync(path.dirname(path.join(copy, file)), { recursive: true }); fs.cpSync(path.join(root, file), path.join(copy, file), { recursive: true });
  }
  const cases = [
    ['plugins/dsh-nday-hunter/lib/verification-queue.js', 'previous && sameEvidence && TERMINAL', 'previous && TERMINAL', 'production planner invalidates cached negatives on changed product conditions and packets while unchanged saved evidence reuses'],
    ['plugins/dsh-nday-hunter/lib/verification-queue.js', "new Set(['not-hit', 'not-applicable',", "new Set(['blocked', 'not-hit', 'not-applicable',", 'blocked and legacy unstamped history never suppress a now-valid production check'],
    ['plugins/dsh-redteam-results/lib/checked.js', 'const basis = verificationBasis(matching[0], context);', 'const basis = input[i].verificationBasis || verificationBasis(matching[0], context);', 'production planner invalidates cached negatives on changed product conditions and packets while unchanged saved evidence reuses'],
  ];
  for (const [file, anchor, mutation, assertion] of cases) {
    const target = path.join(copy, file), original = fs.readFileSync(target, 'utf8');
    assert.equal(original.split(anchor).length - 1, 1, 'mutation anchor must occur once');
    fs.writeFileSync(target, original.replace(anchor, mutation));
    try {
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(copy, 'scripts/test-stub-register.mjs')).href, 'scripts/test-shared-verification.mjs'],
        { cwd: copy, env: { ...process.env, SAKER_ROOT: copy }, encoding: 'utf8', timeout: 60000 });
      assert.notEqual(result.status, 0, 'old behavior must fail');
      assert(result.stdout?.includes('FAIL ' + assertion + ':'), 'must fail the named assertion, not a loader: ' + (result.stderr || result.stdout));
      console.log('ok   reverse caught ' + file + ': ' + assertion);
    } finally { fs.writeFileSync(target, original); }
  }
} finally { assert(copy.startsWith(boundary + path.sep)); fs.rmSync(copy, { recursive: true, force: true }); }
