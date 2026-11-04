import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const boundary = path.resolve(root, '../_ref/tmp');
assert.equal(path.resolve(os.tmpdir()), boundary, 'set TEMP/TMP/TMPDIR to workspace _ref/tmp');
const copy = fs.mkdtempSync(path.join(boundary, 'architecture-contracts-reverse-'));
try {
  for (const file of ['package.json', 'lib', 'plugins/dsh-redteam-results/lib', 'scripts/test-home-isolation.mjs',
    'scripts/test-stub-loader.mjs', 'scripts/test-stub-register.mjs', 'scripts/test-architecture-contracts.mjs']) {
    fs.mkdirSync(path.dirname(path.join(copy, file)), { recursive: true });
    fs.cpSync(path.join(root, file), path.join(copy, file), { recursive: true });
  }
  const variants = [
    {
      file: 'plugins/dsh-redteam-results/lib/task-context.js',
      from: 'entries.slice(offset, offset + 6)',
      to: 'entries.slice(offset, offset + 12)',
      failure: /request-6/,
    },
    {
      file: 'plugins/dsh-redteam-results/lib/store.js',
      from: 'if (!rating && !note) return null;',
      to: 'if (false) return null;',
      failure: /secondRating/,
    },
  ];
  for (const variant of variants) {
    const target = path.join(copy, variant.file);
    const original = fs.readFileSync(target, 'utf8');
    assert.equal(original.split(variant.from).length - 1, 1, 'mutation anchor must occur once');
    fs.writeFileSync(target, original.replace(variant.from, variant.to));
    try {
      const result = spawnSync(process.execPath, ['--import',
        pathToFileURL(path.join(copy, 'scripts/test-stub-register.mjs')).href,
        'scripts/test-architecture-contracts.mjs'], {
        cwd: copy, env: { ...process.env, SAKER_ROOT: copy }, encoding: 'utf8', timeout: 30000,
      });
      assert.notEqual(result.status, 0, 'old behavior must fail the architecture contract');
      assert.match(result.stdout + result.stderr, variant.failure);
      console.log('ok reverse ' + path.basename(variant.file) + ': targeted architecture assertion failed');
    } finally {
      fs.writeFileSync(target, original);
    }
  }
} finally {
  assert(copy.startsWith(boundary + path.sep));
  fs.rmSync(copy, { recursive: true, force: true });
}
