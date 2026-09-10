// 测试用模块解析钩子：把宿主提供的 @deepseek-ai/dsh-tools 映射到一个内联桩。
//
// 为什么需要：插件 lib/ 以裸标识符 import 宿主提供的 @deepseek-ai/dsh-tools（运行时由 harness 注入，
// 不在插件 node_modules 里），因此 `node test/run.mjs` 直接跑会 ERR_MODULE_NOT_FOUND——
// 测试写了却无法在仓库内独立执行（也就无法进 CI）。
// 用法：node --import ./test/register-stub.mjs test/<file>.mjs

const STUB_URL =
  "data:text/javascript," +
  encodeURIComponent(
    "// dsh-tools 测试桩：插件测试只用到 defineTool（声明式工具定义，运行时为恒等/校验）。\n" +
      "export const defineTool = (def) => def;\n" +
      "export default { defineTool };\n",
  );

export function resolve(specifier, context, nextResolve) {
  if (specifier === "@deepseek-ai/dsh-tools") {
    return { url: STUB_URL, format: "module", shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
