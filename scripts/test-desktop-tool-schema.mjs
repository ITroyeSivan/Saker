// Use the official Desktop's compiler: the unit stub intentionally does not compile schemas.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { productPluginDirectories } from './lib/product-plugins.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktopCandidates = [
  process.env.DSH_DESKTOP_DIR,
  resolve(root, '../_ref/dsh-src-0.2.2-rc.1'),
  resolve(root, '../_ref/dsh-src-0.2.1-rc.5'),
  resolve(root, '../_ref/dsh-src-0.2.1-rc.2/desktop-runtime'),
  resolve(root, '../_ref/dsh-src-0.2.0-rc.2/desktop-runtime'),
].filter(Boolean);
const desktop = desktopCandidates.find(candidate => existsSync(join(candidate, 'DeepSeek Harness.exe')))
  || resolve(root, '../_ref/dsh-src-0.2.2-rc.1');
const executable = join(desktop, 'DeepSeek Harness.exe');
if (process.platform !== 'win32' || !existsSync(executable)) {
  console.log('skip official Windows Desktop unavailable; schema compilation was not tested');
  process.exit(0);
}
const toolsDirectory = resolve(root, '../_ref/tools');
const realLoader = join(toolsDirectory, 'smoke-register-real.mjs');
if (!process.env.SAKER_DESKTOP_SCHEMA_CHILD && existsSync(realLoader)) {
  const rerun = spawnSync(executable, [
    '--expose-internals',
    '--import', pathToFileURL(realLoader).href,
    fileURLToPath(import.meta.url),
  ], {
    cwd: root,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      SAKER_DESKTOP_SCHEMA_CHILD: '1',
      DSH_DESKTOP_DIR: desktop,
      DSH_RUNTIME_ROOT: join(desktop, 'resources', 'app.asar', 'dsh'),
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: '',
    },
  });
  process.stdout.write(rerun.stdout ?? '');
  process.stderr.write(rerun.stderr ?? '');
  if (rerun.error) console.error(String(rerun.error));
  process.exit(rerun.status ?? 1);
}
const tools = [];
// 2026-10-11：从"只编译两个插件"扩到**全部产品插件**。这是 tool-smoke 编译阶段的实质
// （真编译器会拒绝宿主不支持的参数/输出规格，桩不会），所以把它放进回归当持久检查。
const disposers = [];
const makeContext = () => ({
  tools: { register: tool => tools.push({ name: tool.name, parameters: tool.parameters, output: tool.output?.schema }), guard: () => {}, unregister: () => {} },
  // 收集 disposer：trace-vault 这类插件在 apply 里就开 SQLite，不释放的话
  // 测试进程退出时删 DSH_HOME 会 EPERM。
  // 清理回调可能是函数，也可能是 async 函数返回的 Promise（redteam-results 就是后者）——
  // 只收集 function 会漏掉它，导致 SQLite 句柄留到退出、清理 EPERM。
  effect: callback => {
    const dispose = callback();
    if (typeof dispose === 'function' || (dispose && typeof dispose.then === 'function')) disposers.push(dispose);
    return () => {};
  },
  inject: () => {},
  webServer: { register: () => () => {}, route: () => {}, use: () => {}, get: () => undefined },
  connection: { register: () => () => {}, rpc: { call: async () => ({ ok: false, error: { code: 'stub', message: 'no transport' } }) } },
  slots: { inject: () => () => {}, register: () => () => {} },
  // 这三个插件在 apply 里往系统提示词挂一段（宿主服务），缺了会直接抛。
  systemPrompt: { context: () => () => {} },
  subagents: { registerProvider: () => {}, getProvider: () => undefined, list: () => [], register: () => ({ dispose: () => {} }), spawn: async () => ({ ok: false }) },
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  get: () => undefined,
  on: () => () => {},
});
const failures = [];
const loaded = [];
for (const directory of productPluginDirectories(root)) {
  const entry = join(root, 'plugins', directory, 'lib', 'index.js');
  if (!existsSync(entry)) continue;
  try {
    const module = await import(pathToFileURL(entry).href);
    if (typeof module.apply !== 'function') continue;
    // apply(ctx, config)：不传 config 时插件读 config.x 会抛，所以用声明的 schema 取默认值。
    await module.apply(makeContext(), typeof module.Config === 'function' ? module.Config({}) : {});
    loaded.push(directory);
  } catch (error) {
    failures.push(`${directory}: ${error && error.message ? error.message : String(error)}`);
  }
}
// 先释放再断言：否则断言失败时 disposer 不跑，插件持有的 SQLite 句柄会让退出清理 EPERM。
for (const dispose of disposers.reverse()) {
  try { await (typeof dispose === 'function' ? dispose() : dispose) } catch { /* 插件自己的清理失败不改变 schema 契约结论 */ }
}
assert.deepEqual(failures, [], 'every product plugin must apply with the shared context: ' + failures.join(' | '));
assert(!tools.some(tool => /^(?:knowledge_|nday_)/.test(tool.name)), 'retired knowledge/Nday tools must not enter the model surface');
assert(tools.some(tool => tool.name === 'oob_probe'), 'oob_probe must remain available from scanner-tools');
// 这里是**默认配置**下的工具面；不同预设会按场景注册更多工具。
// 因为部分工具按模式/工具包分发；本测试只关心"注册出来的 schema 能不能被真编译器接受"。
assert(tools.length >= 50, `expected the reduced default product tool surface, collected ${tools.length}`);
console.log(`ok ${loaded.length} product plugins registered ${tools.length} tool schemas for the real compiler`);
assert(tools.every(tool => tool.parameters?.type === 'object' && tool.parameters?.properties),
  'defineTool must compile every registered parameter set to a root object schema');
assert(tools.some(tool => tool.name === 'operation_task'));
assert(tools.some(tool => tool.name === 'redteam_task'));
console.log(`ok official Desktop defineTool compiled ${tools.length} task/gate/results parameter schemas`);
