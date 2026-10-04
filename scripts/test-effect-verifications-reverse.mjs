import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url)), boundary = path.resolve(root, '../_ref/tmp');
assert.equal(path.resolve(os.tmpdir()), boundary);
const copy = fs.mkdtempSync(path.join(boundary, 'effect-reverse-'));
try {
  for (const file of ['package.json', 'lib', 'plugins/dsh-redteam-results/lib', 'plugins/dsh-nday-hunter/lib', 'scripts/test-effect-verifications.mjs', 'scripts/fixture-effect-job-worker.mjs',
    'scripts/test-home-isolation.mjs', 'scripts/test-stub-loader.mjs', 'scripts/test-stub-register.mjs']) {
    fs.mkdirSync(path.dirname(path.join(copy, file)), { recursive: true }); fs.cpSync(path.join(root, file), path.join(copy, file), { recursive: true });
  }
  const negative = 'fixed ACL public/shared objects HTML pages invalid identities and request-reflected markers never produce private-read effects';
  const independent = 'duplicate or borrowed receipts cannot replace independent execution and method changes revoke persisted effects and ready views';
  const cases = [
    ['effect-verifications.js', 'controlReceiptId: input.rounds.at(-1).normal, probeReceiptId: input.rounds.at(-1).probe', 'controlReceiptId: input.rounds[1].normal, probeReceiptId: input.rounds[1].probe', 'one real comparison can support continuing but cannot create a confirmed effect or persist a verdict'],
    ['effect-verifications.js', 'owner.readers.includes(normal.ownerId)', 'false', negative],
    ['effect-verifications.js', 'if (Object.values(round).some(receipt => receipt.request.includes(owner.marker)', 'if (false && Object.values(round).some(receipt => receipt.request.includes(owner.marker)', negative],
    ['effect-verifications.js', 'new Set(ids).size !== (singleRound ? 4 : 8)', 'false', independent],
    ['effect-verifications.js', "proofKind: 'access'", "proofKind: 'execution'", 'actual private-object positive requires eight independent host executions and records an access effect without claiming RCE'],
    ['delivery-evidence.js', 'effect.proofKind !== row.proofKind', 'false', 'real positive promotes through production stats dedup filters export and high-impact stopping while access cannot masquerade as RCE'],
    ['effect-verifications.js', 'current: record.verified === true && currentVerdict.verified === true', 'current: true', independent],
  ];
  for (const [file, anchor, mutation, label] of cases) {
    const target = path.join(copy, 'plugins/dsh-redteam-results/lib', file), original = fs.readFileSync(target, 'utf8');
    assert.equal(original.split(anchor).length - 1, 1);
    fs.writeFileSync(target, original.replace(anchor, mutation));
    try {
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(copy, 'scripts/test-stub-register.mjs')).href, 'scripts/test-effect-verifications.mjs'],
        { cwd: copy, env: { ...process.env, SAKER_ROOT: copy }, encoding: 'utf8', timeout: 60000 });
      assert.notEqual(result.status, 0); assert(result.stdout?.includes('FAIL ' + label + ':'), 'named behavioral failure required: ' + (result.stderr || result.stdout));
      console.log('ok   reverse caught ' + file + ': ' + label);
    } finally { fs.writeFileSync(target, original); }
  }
} finally { assert(copy.startsWith(boundary + path.sep)); fs.rmSync(copy, { recursive: true, force: true }); }
