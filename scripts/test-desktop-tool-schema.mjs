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
  resolve(root, '../_ref/dsh-src-0.2.1-rc.2/desktop-runtime'),
  resolve(root, '../_ref/dsh-src-0.2.0-rc.2/desktop-runtime'),
].filter(Boolean);
const desktop = desktopCandidates.find(candidate => existsSync(join(candidate, 'DeepSeek Harness.exe')))
  || resolve(root, '../_ref/dsh-src-0.2.1-rc.2/desktop-runtime');
const executable = join(desktop, 'DeepSeek Harness.exe');
if (process.platform !== 'win32' || !existsSync(executable)) {
  console.log('skip official Windows Desktop unavailable; schema compilation was not tested');
  process.exit(0);
}
const tools = [];
// 2026-10-11：从"只编译两个插件"扩到**全部产品插件**。这是 tool-smoke 编译阶段的实质
// （真编译器会拒绝宿主不支持的参数/输出规格，桩不会），所以把它放进回归当持久检查。
const disposers = [];
const makeContext = () => ({
  tools: { register: tool => tools.push({ name: tool.name, parameters: tool.parameters, output: tool.output?.schema }), guard: () => {}, unregister: () => {} },
  // 收集 disposer：trace-vault 这类插件在 apply 里就开 SQLite，不释放的话
  // 测试进程退出时删 DSH_HOME 会 EPERM（与知识库索引泄漏同一类问题）。
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
// 应用全部插件时 knowledge-hub 会安排后台自动同步（把随包语料索引进 DSH_HOME，单次可达 GB 级）。
// 本测试只关心 schema 能否被真编译器接受，不需要索引；用插件自带的开关关掉它，
// 否则每跑一轮回归就会先写再删约 1.2 GB（2026-10-11 实测）。
process.env.DSH_KNOWLEDGE_AUTOSYNC = '0';
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
// 这里是**默认配置**下的工具面（75 个）。tool-smoke 用 ctf-solver 预设时看到 103 个，
// 因为部分工具按模式/工具包分发；本测试只关心"注册出来的 schema 能不能被真编译器接受"。
assert(tools.length >= 70, `expected the default product tool surface, collected ${tools.length}`);
console.log(`ok ${loaded.length} product plugins registered ${tools.length} tool schemas for the real compiler`);
const native = `
const {createRequire}=require('node:module');
const fs=require('node:fs');
const path=require('node:path');
const req=createRequire(path.join(process.argv[1],'resources/app.asar/dsh/package.json'));
const host=req('@deepseek-ai/dsh-tools');
const definitions=JSON.parse(fs.readFileSync(0,'utf8'));
for(const tool of definitions){host.parameterSchemaSpecToJsonSchema(tool.parameters);if(tool.output)host.valueSchemaSpecToJsonSchema(tool.output);}
const item=definitions.find(t=>t.name==='operation_intent');
const mutant=structuredClone(item.parameters);
delete mutant.required_artifacts.items.additionalProperties;
let caught=false;
try {host.parameterSchemaSpecToJsonSchema(mutant);} catch(error){caught=/additionalProperties must be explicitly/.test(error.message);}
if(!caught)throw new Error('native compiler failed to detect the Desktop activation regression');
console.log(JSON.stringify({compiled:definitions.map(t=>t.name),caughtMissingOpenness:true}));
`;
const run = spawnSync(executable, ['--expose-internals', '-e', native, desktop], {
  cwd: root, windowsHide: true, encoding: 'utf8', input: JSON.stringify(tools),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' }, timeout: 30000,
});
assert.equal(run.status, 0, run.stderr || String(run.error));
const result = JSON.parse(run.stdout.trim());
assert.equal(result.compiled.length, tools.length);
assert(result.compiled.includes('operation_task') && result.caughtMissingOpenness);
assert(result.compiled.includes('redteam_task'));
console.log(`ok official Desktop compiler accepts ${tools.length} task/gate/results tool schemas`);
console.log('ok official Desktop compiler rejects the previous activation-breaking schema');
