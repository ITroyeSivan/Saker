import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url)), tmp = path.resolve(root, '../_ref/tmp');
const source = path.join(root, 'benchmarks/task-effects/run-facts.mjs');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const before = hash(source);
const variants = [
  ['raw-identity-token',
    "return { roles, digest: sha(JSON.stringify(Object.fromEntries(roles.map(role => [role, sha(String(accounts[role]?.token ?? ''))])))) };",
    "return { roles, digest: JSON.stringify(Object.fromEntries(roles.map(role => [role, String(accounts[role]?.token ?? '')]))) };",
    'facts never carry an account token, and identity/material digests change with the material'],
  ['ledger-zero-when-absent', "if (!rows.length) return { available: false, reason: '本次会话没有产品模型账本行（该组不归 Saker 任务所有）' };",
    "if (!rows.length) return { available: true, calls: 0, byPurpose: {}, wireAttempts: 0, unobservedCalls: 0, unknownCalls: 0, settledTokens: 0 };",
    'an absent product ledger is unknown, never zero'],
  ['invent-source', 'source: text(payload?.source),', "source: text(payload?.source) ?? 'worktree',",
    'missing driver facts stay null instead of being invented'],
];
for (const [name, from, to, expected] of variants) {
  const fixture = fs.mkdtempSync(path.join(tmp, 'revcheck-effect-facts-'));
  try {
    fs.cpSync(path.join(root, 'benchmarks/task-effects'), path.join(fixture, 'benchmarks/task-effects'),
      { recursive: true, filter: source => !source.endsWith('.tgz') });
    fs.cpSync(path.join(root, 'plugins/dsh-redteam-results/lib'), path.join(fixture, 'plugins/dsh-redteam-results/lib'), { recursive: true });
    fs.mkdirSync(path.join(fixture, 'scripts'));
    for (const file of ['test-effect-facts.mjs', 'test-home-isolation.mjs', 'test-stub-loader.mjs', 'test-stub-register.mjs']) {
      fs.copyFileSync(path.join(root, 'scripts', file), path.join(fixture, 'scripts', file));
    }
    const mutant = path.join(fixture, 'benchmarks/task-effects/run-facts.mjs'), content = fs.readFileSync(mutant, 'utf8');
    assert.equal(content.split(from).length - 1, 1, name + ': mutation anchor must occur exactly once');
    fs.writeFileSync(mutant, content.replace(from, to));
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(root, 'scripts/test-stub-register.mjs')).href, path.join(fixture, 'scripts/test-effect-facts.mjs')],
      { cwd: root, encoding: 'utf8', timeout: 60000, env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp } });
    assert.notEqual(result.status, 0, name + ' falsely passed');
    assert((result.stdout + result.stderr).includes('FAIL ' + expected), name + ' failed for an unrelated reason: ' + result.stdout + result.stderr);
    console.log('ok reverse ' + name + ' fails on the corresponding run-fact behavior');
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
}
assert.equal(hash(source), before); console.log('ok run-fact reverse verification preserves production source');
