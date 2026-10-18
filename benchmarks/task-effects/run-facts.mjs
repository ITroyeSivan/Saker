// 运行前事实：来源 / 安装 / 宿主 / preset / 工具 / 访问 / 预算 / 材料 / 身份 / 环境复位，
// 加上唯一 runId、试次与预注册选择。**只读**，不发请求、不改冻结请求；身份只记摘要，不写 token。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { openStore } from '@dsh-external/dsh-redteam-results';
import { verifyLabResetReceipt } from './lab.mjs';
import { materialsSpecDigest } from './matrix-contract.mjs';
import { CASE_MATERIAL_REVISIONS } from './cases.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');

const sourceExcluded = rel => /(^|\/)(?:node_modules|dist|\.git|_ref|logs|sessions|backups)(\/|$)/.test(rel);
const installedExcluded = rel => /(^|\/)(?:\.pnpm|\.bin|\.modules\.yaml)(\/|$)/.test(rel);

/** Content digest of a tree, not a label: same-version source edits change it. */
function treeDigest(root, exclude) {
  if (typeof root !== 'string' || !root.trim() || !existsSync(root)) return null;
  const entries = [];
  const walk = directory => {
    for (const name of readdirSync(directory)) {
      const full = join(directory, name);
      const rel = relative(root, full).replaceAll('\\', '/');
      if (exclude(rel)) continue;
      const stat = statSync(full);
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile()) entries.push([rel, sha(readFileSync(full))]);
    }
  };
  try { walk(root); } catch { return null; }
  entries.sort(([a], [b]) => a.localeCompare(b));
  return { root, files: entries.length, digest: sha(JSON.stringify(entries)) };
}

/** 隔离 profile 里装了哪些包（只读一次；一次运行内不会变）。 */
export function installedPluginVersions(home) {
  const value = {};
  const modules = join(home, 'profiles', 'desktop', 'node_modules');
  try {
    for (const entry of readdirSync(modules)) {
      const scoped = entry.startsWith('@');
      const names = scoped ? readdirSync(join(modules, entry)).map(name => [entry, name]) : [[null, entry]];
      for (const [prefix, name] of names) {
        const file = prefix ? join(modules, prefix, name, 'package.json') : join(modules, name, 'package.json');
        if (!existsSync(file)) continue;
        const pkg = JSON.parse(readFileSync(file, 'utf8'));
        if (typeof pkg?.name === 'string' && typeof pkg?.version === 'string') value[pkg.name] = pkg.version;
      }
    }
  } catch { /* 读不到就留空，不猜版本 */ }
  return value;
}

/**
 * 同口径事实：直接读产品自己的模型账本（每个调用带 purpose/state/wire）。
 * 没有账本行时返回 available:false —— 那是"未知"，不是零。
 */
export function ledgerFacts(home, sessionId) {
  let store;
  try {
    store = openStore(join(home, 'redteam-results', 'results.db'));
    const rows = store.db.prepare('SELECT state,record FROM task_model_calls WHERE root_session=? OR session_id=? ORDER BY rowid').all(sessionId, sessionId);
    if (!rows.length) return { available: false, reason: '本次会话没有产品模型账本行（该组不归 Saker 任务所有）' };
    const records = rows.map(row => JSON.parse(row.record));
    const byPurpose = {};
    for (const record of records) { const purpose = record.purpose || 'unknown'; byPurpose[purpose] = (byPurpose[purpose] ?? 0) + 1; }
    const settled = records.filter(record => record.state === 'settled');
    const usageOf = usage => usage && typeof usage === 'object' ? {
      inputTokens: Number.isSafeInteger(usage.inputTokens) ? usage.inputTokens : null,
      outputTokens: Number.isSafeInteger(usage.outputTokens) ? usage.outputTokens : null,
      cacheReadTokens: Number.isSafeInteger(usage.cacheReadTokens) ? usage.cacheReadTokens : null,
      cacheWriteTokens: Number.isSafeInteger(usage.cacheWriteTokens) ? usage.cacheWriteTokens : null,
      totalTokens: Number.isSafeInteger(usage.totalTokens) ? usage.totalTokens : null,
    } : null;
    return { available: true, calls: rows.length, byPurpose,
      wireAttempts: records.filter(record => record.wire).length,
      unobservedCalls: records.filter(record => !record.wire && record.state !== 'cancelled').length,
      unknownCalls: records.filter(record => record.state === 'unknown').length,
      settledTokens: settled.every(record => Number.isSafeInteger(record.usage?.totalTokens))
        ? settled.reduce((total, record) => total + record.usage.totalTokens, 0) : null,
      // 逐调用明细只保留用途、状态、是否实际发线和用量；不复制请求摘要/原文，避免把凭据带进报告。
      callsDetail: records.map(record => ({ purpose: record.purpose || 'unknown', state: record.state || 'unknown',
        wire: Boolean(record.wire), usage: usageOf(record.usage) })) };
  } catch (error) {
    return { available: false, reason: String(error?.message ?? error) };
  } finally { store?.close(); }
}

/** 材料摘要：剥掉账号 token 再摘要，记录里不留凭据。 */
export function materialDigest(brief) {
  const { accounts, ...redacted } = brief ?? {};
  return sha(JSON.stringify(redacted));
}

/** 身份摘要：只保留角色名与每个 token 的哈希。 */
export function identityDigest(brief) {
  const accounts = brief?.accounts ?? {};
  const roles = Object.keys(accounts).sort();
  return { roles, digest: sha(JSON.stringify(Object.fromEntries(roles.map(role => [role, sha(String(accounts[role]?.token ?? ''))])))) };
}

/**
 * 组装一条运行的运行前事实。缺什么就记 null / 'unknown'，**不补造**。
 * @param input {{sakerVersion,benchmarkVersion,home,homeIsolation,preset,compositionDigest,sourcePreset,sourcePresetCompositionDigest,lab,bridge,budget,payload,calibration,requiredRepeats,caseSplit}}
 */
export function buildRunFacts(input) {
  const { sakerVersion, benchmarkVersion, home, homeIsolation, preset, compositionDigest,
    sourcePreset, sourcePresetCompositionDigest, lab, bridge, budget, payload, calibration, requiredRepeats, caseSplit,
    resetReceipt } = input;
  const text = value => (typeof value === 'string' && value.trim() ? value.trim() : null);
  const identity = identityDigest(bridge.brief);
  const briefDigest = materialDigest(bridge.brief);
  const resetVerified = verifyLabResetReceipt(resetReceipt, { runId: lab.runId, caseId: lab.caseId, briefDigest });
  return {
    factsVersion: 'effect-run-facts/3',
    capturedAt: new Date().toISOString(),
    source: text(payload?.source),
    sourceFiles: treeDigest(text(payload?.sourceRoot), sourceExcluded),
    install: { saker: sakerVersion, benchmark: benchmarkVersion, plugins: installedPluginVersions(home) },
    installFiles: treeDigest(join(home, 'profiles', 'desktop', 'node_modules'), installedExcluded),
    host: { node: process.versions.node, electron: process.versions.electron ?? null, platform: process.platform,
      desktop: text(payload?.desktopVersion) },
    preset: { id: preset, compositionDigest, sourcePreset, sourcePresetCompositionDigest },
    tools: { digest: null },
    access: { digest: bridge.accessDigest },
    budget: structuredClone(budget),
    materials: { caseId: lab.caseId, caseSplit, caseSetVersion: lab.version ?? null, interfaceVersion: bridge.version, briefDigest,
      specDigest: materialsSpecDigest({ caseId: lab.caseId, interfaceVersion: bridge.version, revision: CASE_MATERIAL_REVISIONS[lab.caseId] ?? null }) },
    identity,
    environment: { runId: lab.runId, home: homeIsolation.home, isolated: homeIsolation.isolated,
      isolatedRoot: homeIsolation.isolatedRoot ?? null, freshLab: resetVerified, snapshotRestored: resetVerified,
      resetReceipt: resetVerified ? structuredClone(resetReceipt) : null },
    trial: Number.isSafeInteger(payload?.trial) && payload.trial >= 1 ? payload.trial : null,
    preregistered: { variant: text(payload?.variant), provider: text(payload?.provider), model: text(payload?.model),
      reasoningEffort: text(payload?.reasoningEffort), caseId: lab.caseId, caseSplit,
      budget: structuredClone(budget), repeats: requiredRepeats, calibrationDigest: calibration?.digest ?? null },
  };
}
