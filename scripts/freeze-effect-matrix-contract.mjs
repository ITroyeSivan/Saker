#!/usr/bin/env node
// 运行前冻结矩阵契约：把三组"运行前事实"（预跑 result.json 或宿主清点产物）压成可复查的契约，
// 之后每条运行记录都要与它对得上（protocol.assessMatrixRunFacts）。契约只读事实，不读分数。
//
// 用法:
//   node scripts/freeze-effect-matrix-contract.mjs --calibration <record.json> --cases p1 \
//        --repeats 3 --out <contract.json> <variant>=<result.json> [<variant>=<result.json> ...]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMatrixContract, freezeFactsFromResult } from '../benchmarks/task-effects/matrix-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = resolve(root, '..');
const argv = process.argv.slice(2);
const flag = name => { const index = argv.indexOf(name); return index < 0 ? null : argv[index + 1] ?? null; };
const calibrationPath = flag('--calibration');
const cases = (flag('--cases') ?? '').split(',').map(value => value.trim()).filter(Boolean);
const repeats = Number(flag('--repeats') ?? 3);
const out = flag('--out');
const pairs = argv.filter(value => value.includes('=') && !value.startsWith('--'));
if (!calibrationPath || !cases.length || !out || pairs.length < 3) {
  console.error('usage: node scripts/freeze-effect-matrix-contract.mjs --calibration <record.json> --cases p1 ' +
    '--repeats 3 --out <contract.json> <variant>=<result.json> [<variant>=<result.json> ...]');
  process.exit(2);
}
const calibration = JSON.parse(readFileSync(resolve(calibrationPath), 'utf8'));
const freezeFacts = {};
const variants = [];
for (const pair of pairs) {
  const at = pair.indexOf('=');
  const variant = pair.slice(0, at);
  const file = resolve(pair.slice(at + 1));
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  if (raw.variant !== variant) throw new Error(`result variant mismatch: ${variant} != ${raw.variant}`);
  freezeFacts[variant] = freezeFactsFromResult(raw);
  variants.push(variant);
}
const first = freezeFacts[variants[0]];
const contract = buildMatrixContract({
  calibration, cases, variants, requiredRepeats: repeats, freezeFacts,
  model: first.model, provider: first.provider, reasoningEffort: first.reasoningEffort,
  caseSplit: first.caseSplit ?? 'calibration',
});
const target = resolve(out);
const inside = relative(workspace, target);
if (!inside || inside.startsWith('..') || isAbsolute(inside)) {
  console.error(`refusing to write outside the workspace: ${target}`);
  process.exit(2);
}
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(contract, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ out: target, digest: contract.digest, cases: contract.cases,
  variants: Object.keys(contract.variants), shared: contract.shared, materials: contract.materials }, null, 2));
