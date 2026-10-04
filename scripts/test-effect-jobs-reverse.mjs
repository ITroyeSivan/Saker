import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url)), boundary = path.resolve(root, '../_ref/tmp');
assert.equal(path.resolve(os.tmpdir()), boundary);
const copy = fs.mkdtempSync(path.join(boundary, 'effect-jobs-reverse-'));
try {
  for (const file of ['package.json', 'lib', 'plugins/dsh-redteam-results/lib', 'plugins/dsh-nday-hunter/lib',
    'scripts/test-effect-verifications.mjs', 'scripts/fixture-effect-job-worker.mjs', 'scripts/test-home-isolation.mjs',
    'scripts/test-stub-loader.mjs', 'scripts/test-stub-register.mjs']) {
    fs.mkdirSync(path.dirname(path.join(copy, file)), { recursive: true }); fs.cpSync(path.join(root, file), path.join(copy, file), { recursive: true });
  }
  const cases = [
    ['effect-jobs.js', "SELECT record FROM effect_jobs WHERE session_id=? AND job_key=?", "SELECT record FROM effect_jobs WHERE session_id=? AND job_key=? AND 0",
      'one registered effect-job call executes eight actual requests while identical work and label-only changes do not resend'],
    ['effect-jobs.js', 'if (!assessment.supported) return finish', 'if (false && !assessment.supported) return finish',
      'automatic effect jobs stop failed controls early and cache inconclusive results without declaring the asset safe'],
    ['effect-jobs.js', 'running.has(job.id) ||', 'false ||',
      'simultaneous automatic calls share one job and a lost completion marker reuses durable captures after database reopen'],
    ['task-policy.js', 'if (onReserve) onReserve();', '/* missing durable dispatch marker */',
      'one registered effect-job call executes eight actual requests while identical work and label-only changes do not resend'],
  ];
  for (const [file, anchor, mutation, label] of cases) {
    const target = path.join(copy, 'plugins/dsh-redteam-results/lib', file), original = fs.readFileSync(target, 'utf8');
    assert.equal(original.split(anchor).length - 1, 1, 'one isolated mutation anchor');
    fs.writeFileSync(target, original.replace(anchor, mutation));
    try {
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(copy, 'scripts/test-stub-register.mjs')).href, 'scripts/test-effect-verifications.mjs'],
        { cwd: copy, env: { ...process.env, SAKER_ROOT: copy }, encoding: 'utf8', timeout: 60000, windowsHide: true });
      assert.notEqual(result.status, 0);
      assert(result.stdout?.includes('FAIL ' + label + ':'), 'named behavioral failure required: ' + (result.stderr || result.stdout));
      console.log('ok   reverse caught ' + file + ': ' + label);
    } finally { fs.writeFileSync(target, original); }
  }
} finally { assert(copy.startsWith(boundary + path.sep)); fs.rmSync(copy, { recursive: true, force: true }); }
