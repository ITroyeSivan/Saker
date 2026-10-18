// 矩阵契约与运行记录映射：让"运行前冻结的契约"和"逐轮 result.json"用同一套摘要口径。
//
// 为什么单独一层：协议（protocol.assessMatrixRunFacts）要求每条运行记录带
// repeat / sourceDigest / installedDigest / contractDigest / initialMaterialsDigest / snapshotRestored，
// 而基准适配器落盘的 result.json 保存的是**原料**（facts.source / facts.install / facts.trial /
// facts.environment.freshLab …）。这里把原料按固定规则映射成协议口径，契约与记录共用同一函数，
// 避免两边各算一套。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CASESET_VERSION, CASE_MATERIAL_REVISIONS } from './cases.mjs';
import { matrixContractDigest } from './protocol.mjs';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

/** 变体来源摘要：冻结发布目录路径 / 工作树标记的字符串摘要。 */
export function sourceDigestOf(facts) {
  if (/^[a-f0-9]{64}$/.test(facts?.sourceFiles?.digest || '') && facts.sourceFiles.files > 0) return facts.sourceFiles.digest;
  throw new Error('actual source file contents are required; version labels are historical evidence only');
}

/** 变体安装摘要：已安装包名与版本（facts.install，来自隔离 profile 的只读清点）。 */
export function installedDigestOf(facts) {
  if (/^[a-f0-9]{64}$/.test(facts?.installFiles?.digest || '') && facts.installFiles.files > 0) return facts.installFiles.digest;
  throw new Error('actual installed file contents are required; package versions are historical evidence only');
}

/**
 * 材料规格摘要：**每轮实例材料是随机生成的**（新身份/对象/标记），所以契约冻结的是
 * "材料规格"（用例 + 接口版本 + 用例集版本）；每轮实例摘要仍留在 result.json 的
 * facts.materials.briefDigest 里可查。这个口径在契约里显式标注。
 */
export function materialsSpecDigest({ caseId, interfaceVersion, caseSetVersion = CASESET_VERSION, revision = null }) {
  const spec = { caseId, interfaceVersion, caseSetVersion };
  // 只有确实修订过材料的用例才加字段，保持旧契约（u1 v6 等）的摘要不变。
  if (revision) spec.materialRevision = revision;
  return sha256(JSON.stringify(canonical(spec)));
}

/** 评分器摘要：契约冻结时的 grade.mjs 逐字节摘要；评估时现算，文件改过就会对不上。 */
export function graderDigestOf(gradeUrl = new URL('./grade.mjs', import.meta.url)) {
  return sha256(readFileSync(gradeUrl));
}

/**
 * 阻塞错误计数：只从 result.json 里**已记录的事实**推，不补造——
 * 隔离失败条数 + 未收口 + 清理未完成 + 未提交 + 超预算。基准评分器不产出该字段时用它派生。
 */
export function blockingErrorsOf(raw) {
  let count = 0;
  if (Array.isArray(raw?.isolationFailures)) count += raw.isolationFailures.length;
  if (raw?.durationFinal !== true) count += 1;
  if (raw?.cleanupComplete !== true) count += 1;
  if (!raw?.submission) count += 1;
  if (raw?.qualification?.budgetStatus === 'exceeded') count += 1;
  return count;
}

/**
 * 冻结契约。freezeFacts 每个变体给一份**运行前事实来源**（可来自一次预跑 run 的 result.json，
 * 或宿主侧清点产物）；这里只读事实，不读任何分数。
 */
export function buildMatrixContract({ calibration, cases, variants, requiredRepeats, freezeFacts,
  model, provider, reasoningEffort, caseSplit = 'calibration' }) {
  if (!calibration?.budget || typeof calibration.digest !== 'string') throw new Error('calibration record required');
  if (!Array.isArray(cases) || !cases.length || cases.some(id => typeof id !== 'string' || !id.trim())) throw new Error('cases required');
  if (!Number.isSafeInteger(requiredRepeats) || requiredRepeats < 3) throw new Error('requiredRepeats must be at least 3');
  if (!Array.isArray(variants) || variants.length < 3) throw new Error('three comparison variants required');
  if (!freezeFacts || typeof freezeFacts !== 'object') throw new Error('freeze facts per variant required');
  const first = freezeFacts[variants[0]];
  if (!first) throw new Error('freeze facts missing for ' + variants[0]);
  const requested = { model, provider, reasoningEffort };
  for (const [key, value] of Object.entries(requested)) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`explicit ${key} required`);
    if (first[key] !== value) throw new Error(`freeze facts disagree with requested ${key}`);
  }
  for (const variant of variants) {
    const facts = freezeFacts[variant];
    if (!facts) throw new Error('freeze facts missing for ' + variant);
    for (const key of ['model', 'provider', 'reasoningEffort']) {
      if (facts[key] !== first[key]) throw new Error(`freeze facts disagree on ${key} (${variant})`);
    }
  }
  const shared = {
    model, provider, reasoningEffort,
    toolDigest: first.toolDigest, accessDigest: first.accessDigest, interfaceVersion: first.interfaceVersion,
    caseSetVersion: CASESET_VERSION, graderDigest: graderDigestOf(), hostVersion: first.hostVersion, caseSplit,
  };
  for (const [key, value] of Object.entries(shared)) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`shared ${key} missing from freeze facts`);
  }
  const variantsEntry = Object.fromEntries(variants.map(variant => [variant, {
    sourceDigest: sourceDigestOf(freezeFacts[variant]),
    installedDigest: installedDigestOf(freezeFacts[variant]),
    presetCompositionDigest: freezeFacts[variant].presetCompositionDigest,
    // 启动路径（tool / route / none）不是摘要而是枚举：不同路径会改变模型看到的第一条消息。
    // 冻结了就逐轮核对；旧契约/夹具没有这一项时保持向后兼容（记 null，不做逐轮比对）。
    setupPath: typeof freezeFacts[variant].setupPath === 'string' && freezeFacts[variant].setupPath.trim()
      ? freezeFacts[variant].setupPath.trim() : null,
  }]));
  for (const [variant, entry] of Object.entries(variantsEntry)) {
    for (const [key, value] of Object.entries(entry)) {
      if (key === 'setupPath') { if (value !== null && (typeof value !== 'string' || !value.trim())) throw new Error(`${variant}.setupPath must be null or nonempty`); continue }
      if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error(`${variant}.${key} must be a sha256 digest`);
    }
  }
  const materials = Object.fromEntries(cases.map(caseId => [caseId,
    materialsSpecDigest({ caseId, interfaceVersion: shared.interfaceVersion, revision: CASE_MATERIAL_REVISIONS[caseId] ?? null })]));
  const contract = {
    version: 'task-effects-matrix/3',
    calibrationDigest: calibration.digest,
    budget: { ...calibration.budget },
    requiredRepeats,
    cases: [...cases],
    shared,
    variants: variantsEntry,
    materials,
    materialsSemantics: 'spec-digest', // 规格摘要口径：实例材料每轮随机，实例摘要见 facts.materials.briefDigest
  };
  contract.digest = matrixContractDigest(contract);
  return contract;
}

/** 运行前事实（契约构建用）：从一条 result.json 提取，不含任何分数。 */
export function freezeFactsFromResult(raw) {
  if (!raw?.facts) throw new Error('result record has no facts');
  return {
    source: raw.facts.source,
    sourceFiles: raw.facts.sourceFiles ?? null,
    install: raw.facts.install,
    installFiles: raw.facts.installFiles ?? null,
    trial: raw.facts.trial ?? null,
    model: raw.model, provider: raw.provider, reasoningEffort: raw.reasoningEffort ?? null,
    toolDigest: raw.toolDigest, accessDigest: raw.accessDigest,
    interfaceVersion: raw.interfaceVersion, presetCompositionDigest: raw.presetCompositionDigest,
    setupPath: raw.facts.setupPath ?? null,
    hostVersion: raw.facts.host?.desktop ?? null, caseSplit: raw.caseSplit,
  };
}

/**
 * result.json → 协议口径的运行记录。所有派生字段都写清来源；
 * 缺原料就抛错（宁可不给判定，也不补造）。
 */
export function mapResultToRunRow(raw, { contract, calibration, graderDigest = graderDigestOf() } = {}) {
  if (!contract?.digest || !contract.shared) throw new Error('contract required for mapping');
  const facts = raw?.facts;
  if (!facts) throw new Error('result record has no facts');
  if (typeof facts.trial !== 'number' || !Number.isSafeInteger(facts.trial) || facts.trial < 1)
    throw new Error('run facts need a positive integer trial (repeat)');
  // 实例级 comparability 是在"没有契约、只有单组"的上下文里算的：`matrix-contract-missing` 与
  // `frozen-three-group-comparison-not-run` 都由**批次层**消解（这里正好提供了契约与三组数据），
  // 其余本地故障（工具面变化、预算、隔离失败……）必须原样保留。
  const localResolved = ['matrix-contract-missing', 'frozen-three-group-comparison-not-run'];
  const localComparability = (() => {
    if (!raw.comparability) return raw.comparability;
    if (!Array.isArray(raw.comparability.mismatches)) return raw.comparability;
    const mismatches = raw.comparability.mismatches.filter(reason => !localResolved.includes(reason));
    // 单组实例必然带 `matrix-contract-missing` / `frozen-three-group-comparison-not-run`，
    // 这两条由批次层消解。消解之后必须**重算 comparable**：只过滤 mismatches 而不回写
    // 会让每条运行都留着 comparable:false，晋级门槛因此永远算成"0 条合格运行"
    // （2026-10-18 实测：候选 5/6 原始成功，却被判 0 条合格）。
    return { ...raw.comparability, mismatches, comparable: mismatches.length === 0 };
  })();
  const row = {
    runId: raw.runId, caseId: raw.caseId, variant: raw.variant,
    repeat: facts.trial,
    model: raw.model, provider: raw.provider, reasoningEffort: raw.reasoningEffort ?? null,
    toolDigest: raw.toolDigest, accessDigest: raw.accessDigest,
    interfaceVersion: raw.interfaceVersion, caseSplit: raw.caseSplit,
    caseSetVersion: facts.materials?.caseSetVersion ?? null,
    graderDigest,
    hostVersion: facts.host?.desktop ?? null,
    sourceDigest: sourceDigestOf(facts), installedDigest: installedDigestOf(facts),
    presetCompositionDigest: facts.preset?.compositionDigest ?? raw.presetCompositionDigest,
    setupPath: facts.setupPath ?? null,
    contractDigest: contract.digest, calibrationDigest: calibration?.digest ?? null,
    initialMaterialsDigest: facts.materials?.specDigest ?? null,
    materialsDigest: facts.materials?.briefDigest ?? null,
    snapshotRestored: facts.environment?.snapshotRestored === true,
    resetReceipt: facts.environment?.resetReceipt ?? null,
    budget: raw.budget, homeIsolation: raw.homeIsolation,
    comparability: localComparability, durationFinal: raw.durationFinal,
    cleanupComplete: raw.cleanupComplete === true,
    isolationFailures: Array.isArray(raw.isolationFailures) ? raw.isolationFailures : [],
    score: raw.score ? { ...raw.score,
      blockingErrors: Number.isSafeInteger(raw.score.blockingErrors) ? raw.score.blockingErrors : blockingErrorsOf(raw) } : raw.score,
    usage: raw.usage, qualification: raw.qualification,
  };
  return row;
}
