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
  ['allowance-not-consumed',
    'if (unmetered) policy.used.unmeteredToolCalls = (policy.used.unmeteredToolCalls ?? 0) + 1;',
    'if (false) policy.used.unmeteredToolCalls = (policy.used.unmeteredToolCalls ?? 0) + 1;',
    'an explicit allowance admits exactly that many unmetered calls and then stops'],
  ['target-scope-ignored',
    'if (!urlIsInTaskScope(effective, url)) { reason = \'target_outside_scope：请求地址不在当前任务授权范围：\' + url.origin; break; }',
    'if (false) { reason = \'target_outside_scope：请求地址不在当前任务授权范围：\' + url.origin; break; }',
    'opaque shell and MCP traffic follows scope without a default quota'],
  ['explicit-cap-ignored',
    "if (Number.isInteger(allowance) && (state.policy.used.unmeteredToolCalls ?? 0) >= allowance) reason = 'unmetered_traffic_budget_exhausted：未计量目标流量的显式额度（'",
    "if (false) reason = 'unmetered_traffic_budget_exhausted：未计量目标流量的显式额度（'",
    'an explicit allowance admits exactly that many unmetered calls and then stops'],
  ['tool-call-not-counted',
    'policy.used.toolCalls++;',
    'policy.used.toolCalls = policy.used.toolCalls;',
    'an active scan proceeds inside the user scope without a default allowance'],
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
