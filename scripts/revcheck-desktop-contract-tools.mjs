// 反向检查：把契约四件套换成"能打印合格结论行但实际退化"的替身，要求回归套件必须失败。
//
// 为什么要这个：`test-desktop-contract-tools.mjs` 有"退出码 0 就算过"的风险 ——
// badpath-smoke 本身永远 exit 0，tool-smoke 的退化运行也可能照样打印"未见异常"。
// 这里逐个注入退化形态，证明下限断言（插件数/工具数/真调用数/坏路径计数）真的在起作用。
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const boundary = resolve(root, '..', '_ref', 'tmp');
const realTools = resolve(root, '..', '_ref', 'tools');
const suite = join(root, 'scripts', 'test-desktop-contract-tools.mjs');
const suiteBefore = readFileSync(suite, 'utf8');

/** 合格替身：每个工具都打印刚好达标的结论行，退出码 0。 */
const stubs = {
  'audit-bundle.mjs': { exit: 0, out: '体检 24 个插件\n\n装载契约完整 ✓\n' },
  'rpc-contract.mjs': {
    exit: 0,
    out: '加载 7 个 RPC 通道 · 审计 13 个带客户端的插件\n\n'
      + '## ① 客户端端点契约（0 处问题）\n## ③ 跨插件 import（0 处问题）\n',
  },
  'tool-smoke.mjs': {
    exit: 0,
    out: '加载 24 个插件 · 收集到 103 个模型工具 · 真调用 187 次\n\n所有工具调用未见异常 ✓\n',
  },
  'badpath-smoke.mjs': { exit: 0, out: '坏路径用例 40 个 · 抛异常/未降级 0 · 无法判定 2\n' },
};

const variants = [
  {
    id: 'degraded-tool-surface',
    // 只体检到 1 个插件、2 个工具、3 次调用 —— 结论行还写着"未见异常"。
    mutate: { file: 'tool-smoke.mjs', out: '加载 1 个插件 · 收集到 2 个模型工具 · 真调用 3 次\n\n所有工具调用未见异常 ✓\n' },
    failure: /FAIL tool-smoke: 「插件\/工具\/真调用规模」= 1，低于下限 20/,
  },
  {
    id: 'badpath-unhandled-throw',
    // 40 个坏路径用例里有 3 个抛异常/未降级 —— 脚本自己仍然 exit 0。
    mutate: { file: 'badpath-smoke.mjs', out: '坏路径用例 40 个 · 抛异常/未降级 3 · 无法判定 0\n' },
    failure: /FAIL badpath-smoke: 缺少结论行/,
  },
  {
    id: 'contract-tool-nonzero-exit',
    // 结论行都合格，但体检工具自己认为失败（退出码非 0）必须照样算失败。
    mutate: { file: 'audit-bundle.mjs', exit: 1, out: '体检 24 个插件\n\n装载契约完整 ✓\n' },
    failure: /FAIL audit-bundle: 退出码 1/,
  },
];

const writeStub = (directory, name, stub) => {
  const body = `process.stdout.write(${JSON.stringify(stub.out)});\nprocess.exit(${stub.exit ?? 0});\n`;
  writeFileSync(join(directory, name), body, 'utf8');
};

let failures = 0;
for (const variant of variants) {
  const directory = mkdtempSync(join(boundary, `revcheck-contract-tools-${variant.id}-`));
  try {
    const inside = relative(boundary, directory);
    assert(inside && !inside.startsWith('..') && !isAbsolute(inside), 'temporary directory escaped _ref/tmp');
    // 加载器必须是真的：Desktop 进程会 --import 它，替身也要能被真实注册流程接受。
    for (const loader of ['smoke-register-real.mjs', 'smoke-real-loader.mjs']) {
      copyFileSync(join(realTools, loader), join(directory, loader));
    }
    for (const [name, stub] of Object.entries(stubs)) writeStub(directory, name, stub);
    writeStub(directory, variant.mutate.file, { exit: variant.mutate.exit, out: variant.mutate.out });

    const run = spawnSync(process.execPath, [suite], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        TEMP: boundary, TMP: boundary, TMPDIR: boundary,
        SAKER_CONTRACT_TOOLS_DIR: directory,
      },
      timeout: 3 * 60 * 1000,
    });
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    try {
      assert.notEqual(run.status, 0, `${variant.id}: 退化形态必须让回归套件失败`);
      assert.match(output, variant.failure, `${variant.id}: 目标断言必须失败`);
      console.log(`ok reverse ${variant.id}: 目标断言按预期失败`);
    } catch (error) {
      failures++;
      console.log(`FAIL reverse ${variant.id}: ${error.message}`);
      console.log(output.split('\n').slice(-20).join('\n'));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

// 反向检查不得改动被检查的套件本身。
assert.equal(readFileSync(suite, 'utf8'), suiteBefore, 'the contract-tools suite changed during reverse checks');
mkdirSync(boundary, { recursive: true });
process.exitCode = failures ? 1 : 0;
