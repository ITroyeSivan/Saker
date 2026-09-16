// 测试用模块解析钩子：把宿主注入的 @deepseek-ai/dsh-tools 映射到内联桩。
//
// 为什么需要：src/proxy.ts 从宿主提供的包里 import defineTool，该包运行时注入、
// 不在插件 node_modules 里，`tsc` 靠 src/host-modules.d.ts 的环境声明过关，
// 但 tsx 跑到 import 那一步会 ERR_MODULE_NOT_FOUND。
//
// 覆盖面按实际用到的最小集合给：真实 mcp-client 还从同一个包 import
// assertSupportedJsonSchema（lib/index.js:13），漏了它 host.test.ts 会在实例化期直接炸。
// 除这两个符号外不桩：@deepseek-ai/dsh-mcp-client 等是真实 devDependency，
// 桩掉会掩盖真问题。
const STUB = [
  'export const defineTool = (definition) => definition',
  'export const assertSupportedJsonSchema = () => {}',
  'export default { defineTool, assertSupportedJsonSchema }',
  '',
].join('\n')
const STUB_URL = 'data:text/javascript,' + encodeURIComponent(STUB)

export function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/dsh-tools') {
    return { url: STUB_URL, format: 'module', shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
