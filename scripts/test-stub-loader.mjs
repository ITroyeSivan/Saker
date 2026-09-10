// 测试用模块解析钩子（共享）：把宿主注入的 @deepseek-ai/* 裸包映射到内联桩。
//
// 为什么需要：插件 lib/ 以裸标识符 import 宿主提供的包（dsh-tools / schemastery /
// dsh-mcp-client），运行时由 harness 注入，不在插件 node_modules 里。因此
// `node test/run.mjs` 会直接 ERR_MODULE_NOT_FOUND——测试写了却无法在仓库内独立执行，
// 也就无法进 CI。
//
// 用法（从插件目录）：node --import ../../scripts/test-stub-register.mjs test/<file>.mjs

// 可链式调用的 schema 桩：z.object({...}) / z.boolean().default(true) 等一律返回自身。
// 插件用它只为声明配置形状，测试路径不需要真实校验语义。
// 可链式调用的 schema 桩：z.object({...}) / z.boolean().default(true) 等一律返回自身。
// 插件用它只为声明配置形状，测试路径不需要真实校验语义。
const STUBS = {
  // declareTool 的声明式定义：运行时为恒等/校验，测试只取返回的 def
  "@deepseek-ai/dsh-tools": "export const defineTool = (def) => def;\nexport default { defineTool };\n",

  // 配置 schema（zod 风格链式 API）：z.object({...}) / z.boolean().default(true) 均返回自身
  "@deepseek-ai/schemastery":
    "const s = (() => { const f = function () {}; const p = new Proxy(f, { get: (_t, k) => (k === 'then' ? undefined : p), apply: () => p }); return p; })();\nexport default s;\n",

  // MCP 客户端：测试不发起真实连接，给出可构造的占位
  "@deepseek-ai/dsh-mcp-client":
    "export class Client { constructor() {} async connect() { throw new Error('test stub: no real MCP connection'); } async close() {} }\nexport default { Client };\n",
};

const URLS = new Map(
  Object.entries(STUBS).map(([k, v]) => [k, "data:text/javascript," + encodeURIComponent(v)]),
);

export function resolve(specifier, context, nextResolve) {
  const url = URLS.get(specifier);
  if (url) return { url, format: "module", shortCircuit: true };
  return nextResolve(specifier, context);
}
