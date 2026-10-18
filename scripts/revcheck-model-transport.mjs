import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const boundary = resolve(root, '../_ref/tmp');
const plugin = 'plugins/dsh-redteam-results/lib';
const files = {
  'model-budget.js': join(root, plugin, 'model-budget.js'),
  'model-transport.js': join(root, plugin, 'model-transport.js'),
};
const original = Object.fromEntries(Object.entries(files).map(([name, file]) => [name, readFileSync(file, 'utf8')]));
const hash = name => createHash('sha256').update(readFileSync(files[name])).digest('hex');
const before = Object.fromEntries(Object.keys(files).map(name => [name, hash(name)]));
const variants = [
  {
    id: 'retry-not-separated',
    file: 'model-budget.js',
    from: 'if(wireAttempts>0){',
    to: 'if(false){',
    failure: /FAIL successful retry gets a separate settlement/,
  },
  {
    id: 'redirect-hidden',
    file: 'model-transport.js',
    from: "redirect:'error'",
    to: "redirect:'follow'",
    all: true,
    failure: /FAIL an actual HTTP redirect cannot hide a second request/,
  },
  {
    id: 'unobserved-zero',
    file: 'model-budget.js',
    from: "unobservedCalls:rows.filter(row=>row.state!=='cancelled'&&!row.wire).length,",
    to: 'unobservedCalls:0,',
    failure: /FAIL a successful stream without an observed native fetch/,
  },
  {
    id: 'model-mismatch-open',
    file: 'model-budget.js',
    from: 'if(facts.model!==row.model)',
    to: 'if(false)',
    failure: /FAIL wire model mismatch fails closed/,
  },
  {
    id: 'prior-wire-zero',
    file: 'model-budget.js',
    from: '{runtimeId,priorWireAttempts:wireAttempts}',
    to: '{runtimeId,priorWireAttempts:0}',
    failure: /FAIL provider-internal second attempt cannot bypass one-call budget/,
  },
];

try {
  for (const variant of variants) {
    const directory = mkdtempSync(join(boundary, `revcheck-model-transport-${variant.id}-`));
    try {
      const inside = relative(boundary, directory);
      assert(inside && !inside.startsWith('..') && !isAbsolute(inside), 'temporary directory escaped _ref/tmp');
      cpSync(join(root, plugin), join(directory, plugin), { recursive: true });
      cpSync(join(root, 'scripts/test-model-transport.mjs'), join(directory, 'scripts/test-model-transport.mjs'));
      const target = join(directory, plugin, variant.file);
      const source = readFileSync(target, 'utf8');
      const hits = source.split(variant.from).length - 1;
      if (variant.all) assert(hits >= 1, `${variant.id}: mutation anchor missing`);
      else assert.equal(hits, 1, `${variant.id}: exact mutation anchor`);
      writeFileSync(target, variant.all ? source.replaceAll(variant.from, variant.to) : source.replace(variant.from, variant.to));
      const result = spawnSync(process.execPath, [
        '--import',
        pathToFileURL(join(root, 'scripts/test-stub-register.mjs')).href,
        join(directory, 'scripts/test-model-transport.mjs'),
      ], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, TEMP: boundary, TMP: boundary, TMPDIR: boundary },
      });
      assert.notEqual(result.status, 0, `${variant.id}: reverse suite must fail`);
      assert.match(`${result.stdout || ''}${result.stderr || ''}`, variant.failure, `${variant.id}: targeted assertion must fail`);
      console.log(`ok reverse ${variant.id}: targeted transport assertion failed`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
} finally {
  for (const name of Object.keys(files)) assert.equal(hash(name), before[name], `${name} changed during reverse checks`);
}
