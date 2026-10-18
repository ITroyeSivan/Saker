import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url)), tmp = path.resolve(root, '../_ref/tmp');
const source = path.join(root, 'plugins/dsh-redteam-results/lib/task-policy.js');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const before = hash(source);
const variants = [
  ['unmetered-always-allowed',
    "if (!Number.isSafeInteger(allowance) || allowance < 1) reason = 'unmetered_target_traffic：' + name",
    "if (false) reason = 'unmetered_target_traffic：' + name",
    'a scan tool with unmeasurable target traffic is refused until the task allows it explicitly'],
  ['collection-module-ignored',
    "if (disabled.length) reason = 'collection_module_disabled：当前任务未启用 ' + disabled.join('、')",
    "if (false) reason = 'collection_module_disabled：当前任务未启用 ' + disabled.join('、')",
    'closing a collection module blocks that collection tool while existing material stays readable'],
  ['allowance-not-consumed',
    'if (unmetered) policy.used.unmeteredToolCalls = (policy.used.unmeteredToolCalls ?? 0) + 1;',
    'if (false) policy.used.unmeteredToolCalls = (policy.used.unmeteredToolCalls ?? 0) + 1;',
    'an explicit allowance admits exactly that many unmetered calls and then stops'],
  ['shell-traffic-ignored',
    'const unmetered = unmeteredTrafficTools.has(name) || argsHitAuthorizedScope(store, sessionId, name, args, effective)\n      || (!localTools.has(name) && !networkFreeTools.has(name) && !meteredRequestTools.has(name));',
    'const unmetered = unmeteredTrafficTools.has(name);',
    'shell and unknown network capabilities require quota while explicit offline MCP tools stay local'],
  ['auto-recon-defaults-to-zero',
    "const suggestedUnmetered = parentId ? readTaskPolicy(store, parentId).budget.unmeteredToolCalls ?? 0 : startMode === 'auto-recon' ? 3 : 0;", 'const suggestedUnmetered = 0;',
    'both starting points are recorded, the prompt names the one in force, and auto-recon carries a bounded scan allowance'],
  ['metered-request-tools-treated-as-unmetered',
    '  if (meteredRequestTools.has(name)) return false;', '  if (false) return false;',
    'shell and unknown network capabilities require quota while explicit offline MCP tools stay local'],
];
for (const [name, from, to, expected] of variants) {
  const fixture = fs.mkdtempSync(path.join(tmp, 'revcheck-auto-recon-'));
  try {
    for (const dir of ['plugins/dsh-redteam-results/lib', 'plugins/dsh-method-stack/lib', 'plugins/dsh-scanner-tools/lib', 'lib']) {
      fs.cpSync(path.join(root, dir), path.join(fixture, dir), { recursive: true });
    }
    fs.mkdirSync(path.join(fixture, 'scripts'));
    for (const file of ['test-auto-recon.mjs', 'test-home-isolation.mjs', 'test-stub-loader.mjs', 'test-stub-register.mjs']) {
      fs.copyFileSync(path.join(root, 'scripts', file), path.join(fixture, 'scripts', file));
    }
    const mutant = path.join(fixture, 'plugins/dsh-redteam-results/lib/task-policy.js'), content = fs.readFileSync(mutant, 'utf8').replaceAll('\r\n', '\n');
    assert.equal(content.split(from).length - 1, 1, name + ': mutation anchor must occur exactly once');
    fs.writeFileSync(mutant, content.replace(from, to));
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(root, 'scripts/test-stub-register.mjs')).href, path.join(fixture, 'scripts/test-auto-recon.mjs')],
      { cwd: root, encoding: 'utf8', timeout: 60000, env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp } });
    assert.notEqual(result.status, 0, name + ' falsely passed');
    assert((result.stdout + result.stderr).includes('FAIL ' + expected), name + ' failed for an unrelated reason: ' + result.stdout + result.stderr);
    console.log('ok reverse ' + name + ' fails on the corresponding auto-recon behavior');
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
}
assert.equal(hash(source), before); console.log('ok auto-recon reverse verification preserves production source');
