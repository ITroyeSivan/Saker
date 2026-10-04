import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('..', import.meta.url)), boundary = path.resolve(root, '../_ref/tmp');
assert.equal(path.resolve(os.tmpdir()), boundary);
const copy = fs.mkdtempSync(path.join(boundary, 'receipt-reverse-'));
try {
  for (const file of ['package.json', 'lib', 'plugins/dsh-redteam-results/lib', 'plugins/dsh-nday-hunter/lib', 'scripts/test-execution-receipts.mjs',
    'scripts/test-home-isolation.mjs', 'scripts/test-stub-loader.mjs', 'scripts/test-stub-register.mjs']) {
    fs.mkdirSync(path.dirname(path.join(copy, file)), { recursive: true }); fs.cpSync(path.join(root, file), path.join(copy, file), { recursive: true });
  }
  const cases = [
    ['delivery-evidence.js', 'impactVerified = false,', 'impactVerified = true,', 'finding delivery derives current execution binding but cannot count HTTP responses or supplied impact verdicts as confirmed effects'],
    ['research.js', "&& receiptPair[0].status === receiptPair[1].status", "&& false && receiptPair[0].status === receiptPair[1].status", 'changing response headers alone cannot promote identical host response bodies to support'],
    ['execution-receipts.js', "responseBodyBase64: body.toString('base64')", "responseBodyBase64: Buffer.from('invented response').toString('base64')", 'registered host execution captures actual wire response without accepting a supplied receipt or impact verdict'],
    ['execution-receipts.js', 'if (denied) throw new Error(denied);', 'if (false) throw new Error(denied);', 'direction and task budgets stop real HTTP execution; restricted directions cannot dispatch'],
    ['execution-receipts.js', 'target.pathname !== endpoint.pathname', 'false', 'parser rejects endpoint Host framing and identity errors before requests or budget are consumed'],
    ['research.js', 'if (receiptPair && previous.some(row => receiptPair.some', 'if (false && receiptPair && previous.some(row => receiptPair.some', 'research observations derive packets and times from two distinct session-bound host receipts without reusing executions'],
  ];
  for (const [file, anchor, mutation, label] of cases) {
    const target = path.join(copy, 'plugins/dsh-redteam-results/lib', file), source = fs.readFileSync(target, 'utf8');
    assert.equal(source.split(anchor).length - 1, 1);
    fs.writeFileSync(target, source.replace(anchor, mutation));
    try {
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(copy, 'scripts/test-stub-register.mjs')).href, 'scripts/test-execution-receipts.mjs'],
        { cwd: copy, env: { ...process.env, SAKER_ROOT: copy }, encoding: 'utf8', timeout: 60000 });
      assert.notEqual(result.status, 0); assert(result.stdout?.includes('FAIL ' + label + ':'), 'named behavioral failure required: ' + (result.stderr || result.stdout));
      console.log('ok   reverse caught ' + file + ': ' + label);
    } finally { fs.writeFileSync(target, source); }
  }
} finally { assert(copy.startsWith(boundary + path.sep)); fs.rmSync(copy, { recursive: true, force: true }); }
