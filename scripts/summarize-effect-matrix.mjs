#!/usr/bin/env node
// 把一次矩阵的逐轮 result.json 汇总成「可复算的成绩 + 成本」，并给出实验级可比性判定。
//
// 为什么要单独一个脚本：G1 要的不是"某次看起来更好"，而是**同条件、可重跑、失败保留**的成绩单。
// 汇总只读已经落盘的 result.json（适配器自己写的记录），所以任何人拿同一批文件都能算出同样的表。
//
// 用法:
//   node scripts/summarize-effect-matrix.mjs --calibration <budget-calibration.json> [--repeats 3] \
//        [--out <工作区内 json>] <result.json> <result.json> ...
// 退出码: 0 汇总成功（可比性结果写在输出里）/ 1 缺少必需输入 / 2 用法错误
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assessMatrixComparability, assessRunQualification, summarizeRuns, assessPromotion } from '../benchmarks/task-effects/protocol.mjs'
import { mapResultToRunRow } from '../benchmarks/task-effects/matrix-contract.mjs'

// fileURLToPath 是必须的：URL.pathname 会把中文路径留成 %E5%B7%A5…，直接喂给 fs 就找不到目录。
const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export function summarizeMatrix({ calibration, repeats = 3, runs, contract = null }) {
  if (!Array.isArray(runs) || runs.length === 0) throw new Error('at least one run record is required')
  if (!calibration?.budget) throw new Error('a calibration record with a budget is required')
  const comparability = assessMatrixComparability({
    calibration, budget: calibration.budget, requiredRepeats: repeats,
    runs, contract,
  })
  const assessedRuns = runs.map(run => ({
    ...run,
    // The batch verifier retains every substantive local mismatch. Missing peer
    // groups are the only diagnostic that a complete merge can discharge.
    comparability: { ...(run.comparability ?? {}), comparable: comparability.comparable },
  }))
  const groups = summarizeRuns(assessedRuns)
  const median = values => {
    const known = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b)
    if (!known.length || known.length !== values.length) return null
    const middle = Math.floor(known.length / 2)
    return known.length % 2 ? known[middle] : (known[middle - 1] + known[middle]) / 2
  }
  const table = Object.entries(groups).map(([variant, group]) => {
    const own = assessedRuns.filter(run => run.variant === variant)
    const byExpected = Object.fromEntries(['confirmed', 'no-finding', 'inconclusive', 'unknown'].map(expected => {
      const subset = own.filter(run => (run.score?.expected ?? 'unknown') === expected)
      return [expected, { runs: subset.length, rawCorrect: subset.filter(run => run.score?.independentSuccess === true).length,
        qualifiedCorrect: subset.filter(run => assessRunQualification(run).qualifiedSuccess).length,
        unsupportedConfirmations: subset.reduce((sum, run) => sum + (Number.isSafeInteger(run.score?.falseConfirmed) ? run.score.falseConfirmed : 0), 0),
        unknownConfirmationCounts: subset.filter(run => !Number.isSafeInteger(run.score?.falseConfirmed)).length }]
    }))
    const failureCodes = {}, evidenceErrors = {}
    for (const run of own.filter(run => run.score?.independentSuccess !== true)) {
      const code = run.score?.reasonCode ?? 'legacy-unspecified'
      failureCodes[code] = (failureCodes[code] ?? 0) + 1
      for (const error of new Set(run.score?.evidenceErrors ?? [])) evidenceErrors[error] = (evidenceErrors[error] ?? 0) + 1
    }
    return {
      variant, runs: group.runs,
      qualifiedSuccess: group.independentSuccess, rawSuccess: group.rawIndependentSuccess,
      falseConfirmed: group.falseConfirmed, overBudgetRuns: group.overBudgetRuns,
      blockingErrors: group.blockingErrors, blockingErrorsUnknownRuns: group.blockingErrorsUnknownRuns,
      unknownBudgetRuns: group.unknownBudgetRuns,
      tokensTotal: group.tokensTotal, tokensMedian: median(own.map(run => run.usage?.tokens)),
      requestsTotal: group.requests, requestsMedian: median(own.map(run => run.score?.targetRequests)),
      elapsedMsTotal: group.elapsedMsTotal, elapsedMsMedian: median(own.map(run => run.usage?.elapsedMs)),
      disqualificationReasons: group.disqualificationReasons,
      byExpected, failureCodes, evidenceErrors,
    }
  })
  // 推广门槛按方案第 10.4 节判定；未知一律视为未达成，不用"看起来更好"替代。
  const promotion = assessPromotion(groups, { requiredRepeats: repeats })
  return { calibrationDigest: calibration.digest ?? null, requiredRepeats: repeats, comparability, promotion, groups: table }
}

/**
 * 原始 result.json（带 facts）→ 协议口径运行记录。只在给了契约时做映射：
 * 映射出的 contractDigest/initialMaterialsDigest 必须来自**运行前冻结的契约**，
 * 没有契约就不给"可比"判定，也不拿运行结果反推契约。
 */
export function mapMatrixResults({ runs, contract, calibration, graderDigest }) {
  if (!contract) throw new Error('contract required to map raw result records');
  return runs.map(raw => raw?.facts ? mapResultToRunRow(raw, { contract, calibration, graderDigest }) : raw)
}

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let index = 0; index < argv.length; index++) {
    if (argv[index].startsWith('--')) { flags[argv[index].slice(2)] = argv[index + 1] ?? true; index++ }
    else positional.push(argv[index])
  }
  return { flags, positional }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { flags, positional } = parseArgs(process.argv.slice(2))
  const calibrationPath = flags.calibration
  if (!calibrationPath || !positional.length) {
    console.error('usage: node scripts/summarize-effect-matrix.mjs --calibration <record.json> [--repeats 3] [--out <file.json>] <result.json>...')
    process.exit(2)
  }
  try {
    const calibration = JSON.parse(readFileSync(resolve(String(calibrationPath)), 'utf8'))
    const contract = flags.contract ? JSON.parse(readFileSync(resolve(String(flags.contract)), 'utf8')) : null
    const raw = positional.map(file => JSON.parse(readFileSync(resolve(file), 'utf8')))
    const runs = contract ? mapMatrixResults({ runs: raw, contract, calibration }) : raw
    const summary = summarizeMatrix({ calibration, repeats: Number(flags.repeats ?? 3), runs, contract })
    if (contract) summary.mappedRuns = runs.length
    const out = flags.out
    if (out) {
      const target = resolve(String(out))
      const rel = relative(WORKSPACE, target)
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) { console.error(`--out must stay inside the workspace: ${target}`); process.exit(2) }
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, JSON.stringify(summary, null, 2) + '\n', 'utf8')
    }
    console.log(JSON.stringify(summary, null, 2))
  } catch (error) {
    console.error('FAILED: ' + (error?.message ?? error))
    process.exit(1)
  }
}
