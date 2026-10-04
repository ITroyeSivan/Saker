// Mutation evidence never changes the installed or production source tree.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url)), boundary = path.resolve(root, '../_ref/tmp');
assert.equal(path.resolve(os.tmpdir()), boundary, 'set TEMP/TMP/TMPDIR to workspace _ref/tmp');
const copy = fs.mkdtempSync(path.join(boundary, 'delivery-semantics-reverse-'));
try {
  for (const file of ['package.json', 'lib', 'plugins/dsh-nday-hunter/lib', 'plugins/dsh-redteam-results/lib',
    'scripts/test-nday-outcomes.mjs', 'scripts/test-home-isolation.mjs', 'scripts/test-stub-loader.mjs', 'scripts/test-stub-register.mjs']) {
    fs.mkdirSync(path.dirname(path.join(copy, file)), { recursive: true }); fs.cpSync(path.join(root, file), path.join(copy, file), { recursive: true });
  }
  const cases = [
    ['delivery.js', "if (method && method.verification.status !== 'verified')", 'if (false)', 'not-run reproduction cannot count as confirmed RCE or complete delivery'],
    ['delivery.js', "if (!request || !response || !bound)", 'if (false)', 'incomplete malformed or cross-entry HTTP evidence never counts as a confirmed effect'],
    ['delivery.js', "if (!executionVerified) gaps.push('host-execution-evidence-missing')", 'if (false)', 'method identity and evidence metadata persist through SQLite register update and read'],
    ['delivery.js', "if (!executionVerified || hostEvidence.impactVerified !== true)", 'if (false)', 'method identity and evidence metadata persist through SQLite register update and read'],
  ];
  for (const [file, anchor, mutation, assertion] of cases) {
    const target = path.join(copy, 'plugins/dsh-redteam-results/lib', file), original = fs.readFileSync(target, 'utf8');
    assert.equal(original.split(anchor).length - 1, 1, 'mutation anchor must occur once');
    fs.writeFileSync(target, original.replace(anchor, mutation));
    try {
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(copy, 'scripts/test-stub-register.mjs')).href, 'scripts/test-nday-outcomes.mjs'],
        { cwd: copy, env: { ...process.env, SAKER_ROOT: copy }, encoding: 'utf8', timeout: 60000 });
      assert.notEqual(result.status, 0, 'old behavior must fail');
      assert(result.stdout?.includes('FAIL ' + assertion + ':'), 'must fail the named assertion, not a loader: ' + (result.stderr || result.stdout));
      console.log('ok   reverse caught ' + file + ': ' + assertion);
    } finally { fs.writeFileSync(target, original); }
  }
} finally { assert(copy.startsWith(boundary + path.sep)); fs.rmSync(copy, { recursive: true, force: true }); }
