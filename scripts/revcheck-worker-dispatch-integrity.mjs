import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url)), tmp = path.resolve(root, '../_ref/tmp');
const lib = 'plugins/dsh-redteam-results/lib/';
const worker = 'test-worker-dispatch-integrity.mjs', reset = 'test-effect-reset-provenance.mjs';
const variants = [
  ['context-typed', lib + 'index.js', 'if (args.assets !== undefined || args.requests !== undefined) {', 'if (false) {', 'test-context-parameters.mjs', 'structured assets and requests preserve identity'],
  ['context-preserve', lib + 'index.js', 'const patch = { ...(readTaskContext(theStore(), session.id) || {}) };', 'const patch = {};', 'test-context-parameters.mjs', 'structured updates retain existing data'],
  ['retest-current', lib + 'retest.js', "  if (execution?.current !== true || execution.integrityValid !== true) throw new Error(role + '回执已失效或与当前请求不匹配，请重新执行本次复测');\n  if (execution.outcome !== 'response') throw new Error(role + '没有取得目标响应：只能记无法确认');\n  requireFreshExecutions([execution]);",
    "  if (execution.outcome !== 'response') throw new Error(role + '没有取得目标响应：只能记无法确认');", 'test-retest.mjs', '复测拒绝旧轮次、不完整及已改变请求的回执'],
  ['retest-freshness', lib + 'retest.js', 'requireFreshExecutions([execution]);', '', 'test-retest.mjs', '复测拒绝旧轮次、不完整及已改变请求的回执'],
  ['retest-round', lib + 'retest.js', "|| Date.parse(execution.startedAt) < Math.max(Number.isFinite(roundStarted) ? roundStarted : 0, verifyStarted)", '', 'test-retest.mjs', '复测拒绝旧轮次、不完整及已改变请求的回执'],
  ['retest-latest', lib + 'retest.js', "if (latest?.verdict !== 'not-reproduced' || !latest.executionId)", "if (!listRetests(store, sessionId, findingId).some(row => row.verdict === 'not-reproduced'))", 'test-retest.mjs', '标记已修复必须有'],
  ['retest-auth', lib + 'retest.js', "if ([401, 407, 429].includes(Number(execution.status))) throw new Error('登录失效或请求受限不能证明已修复：只能记无法确认');", '', 'test-retest.mjs', '登录失效和限流不能登记为本次未复现'],
  ['retest-fixed-time', lib + 'retest.js', "  const roundStarted = Number(policyRecord(store, sessionId)?.startedAt);\n  const verifyStarted = listVerifyStarted(store, sessionId).get(findingId) || 0;\n  if (!Number.isFinite(Date.parse(execution.startedAt))\n    || Date.parse(execution.startedAt) < Math.max(Number.isFinite(roundStarted) ? roundStarted : 0, verifyStarted))\n    throw new Error(role + '回执早于本轮任务或本次复测，请重新执行');", '', 'test-retest.mjs', '标记已修复时时间经过不单独作废'],
  ['yakit-codec', lib + 'task-policy.js', "return server === 'yakit' && ['encode', 'decode'].includes(doc?.tool)", 'return false', worker, 'MCP catalog lookup works without a target task'],
  ['benchmark-submit', lib + 'task-policy.js', ", 'exercise_submit'", '', worker, 'local benchmark submission stays available when target access is disabled'],
  ['mcp-catalog', lib + 'task-policy.js', "'mcp_search', 'exercise_submit'", "'exercise_submit'", worker, 'MCP catalog lookup works without a target task while execution remains guarded'],
  ['historical-cost', lib + 'task-cost.js', 'const fallback = dispatch ? saved.filter(row => row.at < dispatch.firstDispatchAt) : saved;', 'const fallback = dispatch ? [] : saved;', worker, 'starting managed accounting preserves earlier historical session usage'],
  ['offline-purpose', lib + 'purpose-tasks.js', '...(state.policy.target ? { target: state.policy.target } : {})', 'target: state.policy.target', worker, 'offline review and report accept a parent task with no website address'],
  ['report-network', lib + 'purpose-tasks.js', "allowTargetNetwork: purpose === 'report' ? false : state.policy.allowTargetNetwork !== false,", 'allowTargetNetwork: true,', worker, 'report policy blocks the real HTTP executor'],
  ['uncertain-release', lib + 'purpose-tasks.js', "markChild(getStore(), entry.childId, 'cleanup-failed', String(error?.message || error));\n        return false;", "markChild(getStore(), entry.childId, 'released'); active.delete(entry.childId); return true;", worker, 'uncertain release reserves capacity'],
  ['purpose-cost', lib + 'task-cost.js', '...ownedPurposeTasks(store, sessionId).filter(row => !since || row.parentRound === round).map(row => row.childId)', '...[]', worker, 'all purpose costs belong to the parent'],
  ['dispatch-permission', lib + 'task-policy.js', 'if (allowed !== undefined && (!Array.isArray(allowed) || !allowed.includes(permissionName)))', 'if (false)', worker, 'agent scoped tools excluded by visibility API'],
  ['scoped-permission', lib + 'site-workers.js', 'return Array.isArray(current) && current.includes(exec.name) ? undefined', 'return true ? undefined', worker, 'agent scoped tools excluded by visibility API'],
  ['receipt-association', lib + 'execution-view.js', 'if (receiptCalls.has(callId) && result?.ok) continue;', 'if (all.some(row => row.kind === "http") && result?.ok) continue;', worker, 'a historical HTTP receipt never hides'],
  ['auxiliary-cost', lib + 'task-cost.js', 'const dispatch = dispatchUsage(store, id, since);', 'const dispatch = null;', worker, 'dispatch totals include auxiliary calls'],
  ['tls-origin', lib + 'task-policy.js', "if (!urlIsInTaskScope(effective, url)) { reason = 'target_outside_scope：请求地址不在当前任务授权范围：' + url.origin; break; }", 'if (false) break;', worker, 'explicit optional unmetered cap still enforces TLS origins, every batch address and enforceable request limits'],
  ['reset-provenance', 'benchmarks/task-effects/run-facts.mjs', 'const resetVerified = verifyLabResetReceipt(resetReceipt, { runId: lab.runId, caseId: lab.caseId, briefDigest });', 'const resetVerified = input.snapshotRestored === true || !!resetReceipt;', reset, 'caller booleans, forged receipts, copied objects'],
  ['source-hash', 'benchmarks/task-effects/matrix-contract.mjs', "throw new Error('actual source file contents are required; version labels are historical evidence only');", 'return sha256(String(facts.source));', reset, 'source labels and package versions'],
];
const hashes = new Map(variants.map(([, file]) => [file, createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
for (const [name, file, from, to, runner, expected] of variants) {
  const fixture = fs.mkdtempSync(path.join(tmp, 'saker-integrity-reverse-'));
  assert(path.resolve(fixture).startsWith(tmp + path.sep));
  try {
    for (const directory of ['lib', 'shared', 'benchmarks/task-effects']) fs.cpSync(path.join(root, directory), path.join(fixture, directory), { recursive: true });
    for (const plugin of fs.readdirSync(path.join(root, 'plugins'))) {
      const source = path.join(root, 'plugins', plugin, 'lib');
      if (fs.existsSync(source)) fs.cpSync(source, path.join(fixture, 'plugins', plugin, 'lib'), { recursive: true });
    }
    fs.copyFileSync(path.join(root, 'package.json'), path.join(fixture, 'package.json'));
    fs.mkdirSync(path.join(fixture, 'scripts'), { recursive: true });
    for (const script of [runner, 'test-stub-register.mjs', 'test-stub-loader.mjs', 'test-home-isolation.mjs'])
      fs.copyFileSync(path.join(root, 'scripts', script), path.join(fixture, 'scripts', script));
    const target = path.join(fixture, file), content = fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n');
    assert.equal(content.split(from).length - 1, 1, name + ' mutation anchor');
    fs.writeFileSync(target, content.replace(from, to));
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(fixture, 'scripts/test-stub-register.mjs')).href, path.join(fixture, 'scripts', runner)],
      { cwd: root, encoding: 'utf8', timeout: 60000, env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp } });
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, name + ' unexpectedly passed');
    assert(output.includes('FAIL ' + expected), name + ' failed outside target assertion: ' + output);
    console.log('ok reverse ' + name + ': original behavior makes the targeted assertion fail');
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
}
for (const [file, before] of hashes) assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex'), before, file);
console.log('ok reverse verification preserves every production source file');
