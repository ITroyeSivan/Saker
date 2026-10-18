// 契约体检四件套进回归：用官方 Desktop 自带的 Node 运行时驱动 audit-bundle /
// rpc-contract / tool-smoke / badpath-smoke。
//
// 为什么要进回归：这四件套此前只能手工跑（见 2026-10-11/real-contract-restored/）。
// 手工跑出来的结论会随插件改动过期，而且恢复真校验器时抓到的两个真实缺陷
// （nday_source_radar / nday_source_collect 空参数返回非 lossless JSON）说明
// 「桩环境绿」不等于「真宿主绿」。放进回归后，这两类问题下次会被自动拦住。
//
// 为什么用 Desktop 的 Node：真 `defineTool` / 真 `validateJsonSchemaValue` /
// 真 `snapshotJsonValue` 都在 `resources/app.asar/dsh` 里，仓库只有未构建的源码。
// Electron-as-node 能 import asar 内的 ESM（probe-asar-esm-import.mjs 实测）。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const boundary = resolve(root, '..', '_ref', 'tmp');
// 反向检查要能把工具目录指到一份被改坏的副本上，所以留一个显式覆盖口。
const toolsDirectory = process.env.SAKER_CONTRACT_TOOLS_DIR
  ? resolve(process.env.SAKER_CONTRACT_TOOLS_DIR)
  : resolve(root, '..', '_ref', 'tools');
const desktopCandidates = [
  process.env.DSH_DESKTOP_DIR,
  resolve(root, '../_ref/dsh-src-0.2.1-rc.2/desktop-runtime'),
  resolve(root, '../_ref/dsh-src-0.2.0-rc.2/desktop-runtime'),
].filter(Boolean);
const desktop = desktopCandidates.find(candidate => existsSync(join(candidate, 'DeepSeek Harness.exe')))
  || resolve(root, '../_ref/dsh-src-0.2.1-rc.2/desktop-runtime');
const executable = join(desktop, 'DeepSeek Harness.exe');
const runtimeRoot = join(desktop, 'resources', 'app.asar', 'dsh');
const loader = join(toolsDirectory, 'smoke-register-real.mjs');

/**
 * 每个用例的**下限**断言：只断言"没报错"会放过"根本没体检到东西"的退化运行，
 * 所以同时钉住数量级（插件数、工具数、真调用次数、坏路径用例数）。
 */
const cases = [
  {
    id: 'audit-bundle',
    file: 'audit-bundle.mjs',
    markers: [
      { pattern: /体检 (\d+) 个插件/, atLeast: 20, what: '体检到的插件数' },
      { pattern: /装载契约完整 ✓/, what: '打包/装载契约完整' },
    ],
  },
  {
    id: 'rpc-contract',
    file: 'rpc-contract.mjs',
    markers: [
      { pattern: /加载 (\d+) 个 RPC 通道/, atLeast: 5, what: '加载到的 RPC 通道数' },
      { pattern: /## ① 客户端端点契约（0 处问题）/, what: '客户端端点都有服务端实现' },
      { pattern: /## ③ 跨插件 import（0 处问题）/, what: '跨插件 import 都指向真实兄弟插件' },
    ],
  },
  {
    id: 'tool-smoke',
    file: 'tool-smoke.mjs',
    timeoutMs: 10 * 60 * 1000,
    markers: [
      {
        pattern: /加载 (\d+) 个插件 · 收集到 (\d+) 个模型工具 · 真调用 (\d+) 次/,
        atLeast: [20, 70, 100],
        what: '插件/工具/真调用规模',
      },
      { pattern: /所有工具调用未见异常 ✓/, what: '没有可疑工具调用' },
    ],
  },
  {
    id: 'badpath-smoke',
    file: 'badpath-smoke.mjs',
    markers: [
      {
        // 该脚本无论好坏都 exit 0，所以结论只能从这个计数行读：抛异常/未降级必须为 0。
        pattern: /坏路径用例 (\d+) 个 · 抛异常\/未降级 0 · 无法判定 \d+/,
        atLeast: 20,
        what: '坏路径用例数（且没有抛异常或静默丢数据）',
      },
    ],
  },
];

if (process.platform !== 'win32' || !existsSync(executable)) {
  console.log('ok skipped: official Windows Desktop unavailable; contract tools were not driven');
  process.exit(0);
}
const missingTools = [...cases.map(item => item.file), 'smoke-register-real.mjs', 'smoke-real-loader.mjs']
  .filter(file => !existsSync(join(toolsDirectory, file)));
if (missingTools.length > 0) {
  // 仓库单独 checkout 时没有工作区级 _ref/tools；这不是产品回归，明确跳过而不是假装通过。
  console.log(`ok skipped: workspace contract tools unavailable (${missingTools.join(', ')})`);
  process.exit(0);
}

const home = mkdtempSync(join(boundary, 'desktop-contract-home-'));
const env = { ...process.env };
// 让四个工具从自身位置推导插件树（本轮刚改成可推导），不吃继承来的覆盖值。
for (const name of ['SAKER_WORKSPACE', 'SAKER_REPO', 'SAKER_PLUGINS_DIR', 'SMOKE_PLUGINS_DIR']) delete env[name];
Object.assign(env, {
  ELECTRON_RUN_AS_NODE: '1',
  DSH_RUNTIME_ROOT: runtimeRoot,
  DSH_HOME: home,
  TEMP: boundary,
  TMP: boundary,
  TMPDIR: boundary,
  NODE_OPTIONS: '',
  // knowledge-hub 会在 apply 阶段安排后台语料同步（单次可达 GB 级）；这里只要契约结论。
  DSH_KNOWLEDGE_AUTOSYNC: '0',
});

let failed = 0;
try {
  for (const item of cases) {
    const run = spawnSync(executable, [
      '--expose-internals',
      '--import', pathToFileURL(loader).href,
      join(toolsDirectory, item.file),
    ], {
      cwd: root,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env,
      timeout: item.timeoutMs ?? 3 * 60 * 1000,
    });
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    try {
      assert.equal(run.status, 0, `退出码 ${run.status}: ${(run.stderr || String(run.error) || '').slice(-400)}`);
      for (const marker of item.markers) {
        const match = marker.pattern.exec(output);
        assert(match, `缺少结论行「${marker.what}」(${marker.pattern})`);
        const floors = marker.atLeast === undefined
          ? []
          : (Array.isArray(marker.atLeast) ? marker.atLeast : [marker.atLeast]);
        floors.forEach((floor, index) => {
          const value = Number(match[index + 1]);
          assert(Number.isFinite(value), `「${marker.what}」的计数不可读`);
          assert(value >= floor, `「${marker.what}」= ${value}，低于下限 ${floor}`);
        });
      }
      console.log(`ok ${item.id}: ${item.markers.map(marker => marker.what).join(' / ')}`);
    } catch (error) {
      failed++;
      console.log(`FAIL ${item.id}: ${error.message}`);
      console.log(output.split('\n').slice(-15).join('\n'));
    }
  }
} finally {
  try { rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  catch (error) { console.log(`（隔离 home 未清掉，留给回归收尾清扫：${error.message}）`); }
}

process.exitCode = failed ? 1 : 0;
