#!/usr/bin/env node
// 阶段 C 校准：从三组 pilot 的实际用量推导三组共用的固定预算，产出可复查的校准记录。
// 任一维度未知即拒绝 —— 未校准的名义额度不能被当成公平上限。
//
// 用法:
//   node scripts/calibrate-effect-budget.mjs --out <校准记录.json> <pilot/result.json> <pilot/result.json> <pilot/result.json>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveCalibratedBudget } from '../benchmarks/task-effects/protocol.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const workspace = resolve(root, '..');
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
if (outIndex === -1 || !args[outIndex + 1]) {
  console.error('usage: node scripts/calibrate-effect-budget.mjs --out <file.json> <pilot/result.json>...');
  process.exit(2);
}
const out = resolve(args[outIndex + 1]);
const inside = relative(workspace, out);
if (!inside || inside.startsWith('..') || isAbsolute(inside)) {
  console.error(`refusing to write outside the workspace: ${out}`);
  process.exit(2);
}
const files = args.filter((_, index) => index !== outIndex && index !== outIndex + 1);
if (files.length < 3) {
  console.error('at least three pilot results are required');
  process.exit(2);
}
const pilots = files.map(file => {
  const path = resolve(file);
  const run = JSON.parse(readFileSync(path, 'utf8'));
  return {
    // id 带用例：同一版本在多用例 pilot 里各占一条，避免两条不同用例的记录同名（J11 系列后补）。
    id: `${run.caseId ?? 'case'}@${run.variant ?? 'unknown'}@${run.sakerVersion ?? 'unknown'}`,
    caseId: run.caseId ?? null,
    source: path,
    sakerVersion: run.sakerVersion ?? null,
    nominalBudget: run.budget ?? null,
    tokens: run.usage?.tokens ?? null,
    targetRequests: run.score?.targetRequests ?? null,
    elapsedMs: run.usage?.elapsedMs ?? null,
  };
});
const calibration = deriveCalibratedBudget({ pilots });
// basis.pilots 只保留用量四元组（digest 口径不变）；顶层 pilots 附 caseId 供人工复查。
const caseIds = [...new Set(pilots.map(pilot => pilot.caseId).filter(Boolean))];
const record = {
  version: 1,
  caseId: JSON.parse(readFileSync(resolve(files[0]), 'utf8')).caseId ?? null,
  caseIds,
  budget: calibration.budget,
  digest: calibration.digest,
  basis: calibration.basis,
  pilots,
};
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify({ out, budget: record.budget, digest: record.digest, pilots: pilots.map(p => p.id) }, null, 2));
