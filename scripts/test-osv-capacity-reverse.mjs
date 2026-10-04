// Serial only: proves that the old 16 MiB HTTP cap loses a valid large record.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const file = fileURLToPath(new URL('../plugins/dsh-nday-hunter/lib/free-sources.js', import.meta.url));
const run = () => spawnSync(process.execPath, ['--import', './scripts/test-stub-register.mjs', 'scripts/test-osv-export.mjs'], { cwd: root, encoding: 'utf8', windowsHide: true });
const hash = value => createHash('sha256').update(value).digest('hex');
const original = fs.readFileSync(file), source = original.toString('utf8');
const anchor = "{ label: 'OSV', maxBytes: 32 * 1024 * 1024 }";
assert.equal(source.split(anchor).length, 2);
const baseline = run(); assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
try {
  fs.writeFileSync(file, source.replace(anchor, "{ label: 'OSV', maxBytes: 16 * 1024 * 1024 }"));
  const result = run(); assert.notEqual(result.status, 0, 'old OSV HTTP capacity survived');
  assert(result.stdout.includes('FAIL Large OSV originals retain every byte while OSV and NVD capacity limits remain distinct'), result.stdout + result.stderr);
} finally { fs.writeFileSync(file, original); }
assert.equal(hash(fs.readFileSync(file)), hash(original));
const restored = run(); assert.equal(restored.status, 0, restored.stdout + restored.stderr);
console.log('ok   old OSV HTTP cap rejected and original source bytes restored');
