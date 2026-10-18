import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const boundary = resolve(root, '../_ref/tmp');
const module = join(root, 'scripts/summarize-effect-matrix.mjs');
const suite = join(root, 'scripts/test-effect-matrix-summary.mjs');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const before = { module: hash(module), suite: hash(suite) };

const variants = [
  { id: 'experiment-verdict-ignored', from: 'comparability: { ...(run.comparability ?? {}), comparable: comparability.comparable },',
    to: 'comparability: { ...(run.comparability ?? {}), comparable: false },',
    failure: /FAIL a full three-by-three matrix is comparable and the totals add up/ },
  { id: 'one-repeat-accepted', from: 'calibration, budget: calibration.budget, requiredRepeats: repeats,',
    to: 'calibration, budget: calibration.budget, requiredRepeats: 1,',
    failure: /FAIL one run per group is a pilot and cannot be comparable/ },
  { id: 'median-hides-unknown', from: "    if (!known.length || known.length !== values.length) return null",
    to: '    if (!known.length) return null',
    failure: /FAIL unknown usage stays unknown instead of becoming zero/ },
  { id: 'runtime-model-hidden', from: '    runs, contract,',
    to: '    runs: runs.map(run => ({ ...run, model: contract.shared.model })), contract,',
    failure: /FAIL matrix rejects changed runtime facts even when all groups are complete/ },
  { id: 'local-mismatch-hidden', from: '    runs, contract,',
    to: '    runs: runs.map(run => ({ ...run, comparability: { comparable: true, mismatches: [] } })), contract,',
    failure: /FAIL matrix merge preserves a real local mismatch/ },
];

try {
  for (const variant of variants) {
    const directory = mkdtempSync(join(boundary, `revcheck-matrix-summary-${variant.id}-`));
    try {
      const inside = relative(boundary, directory);
      assert(inside && !inside.startsWith('..') && !isAbsolute(inside), 'temporary directory escaped _ref/tmp');
      const target = join(directory, 'summarize-effect-matrix.mjs');
      const source = readFileSync(module, 'utf8');
      assert.equal(source.split(variant.from).length - 1, 1, `${variant.id}: exact mutation anchor`);
      // 副本换了目录，protocol.mjs 的相对路径也要跟着指向仓库里的真身。
      const rewriteImports = text => text.replace(/(['"])\.\.\/benchmarks\/task-effects\/([^'"]+)\1/g,
        (_, quote, file) => JSON.stringify(pathToFileURL(join(root, 'benchmarks', 'task-effects', file)).href));
      writeFileSync(target, rewriteImports(source.replace(variant.from, variant.to)));
      const runner = join(directory, 'test-effect-matrix-summary.mjs');
      writeFileSync(runner, rewriteImports(readFileSync(suite, 'utf8')
        .replace("'./summarize-effect-matrix.mjs'", JSON.stringify(pathToFileURL(target).href))));
      const result = spawnSync(process.execPath, [runner], {
        cwd: root, encoding: 'utf8',
        env: { ...process.env, TEMP: boundary, TMP: boundary, TMPDIR: boundary },
      });
      assert.notEqual(result.status, 0, `${variant.id}: reverse suite must fail`);
      assert.match(`${result.stdout || ''}${result.stderr || ''}`, variant.failure, `${variant.id}: targeted assertion must fail`);
      console.log(`ok reverse ${variant.id}: targeted summary assertion failed`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
} finally {
  for (const [name, file] of Object.entries({ module, suite })) {
    assert.equal(hash(file), before[name], `${name} changed during reverse checks`);
  }
}
