// 测试用模块解析钩子（共享）：把宿主注入的 @deepseek-ai/* 裸包映射到内联桩。
//
// 为什么需要：插件 lib/ 以裸标识符 import 宿主提供的包（dsh-tools / schemastery /
// dsh-mcp-client），运行时由 harness 注入，不在插件 node_modules 里。因此
// `node test/run.mjs` 会直接 ERR_MODULE_NOT_FOUND——测试写了却无法在仓库内独立执行，
// 也就无法进 CI。
//
// 用法（从插件目录）：node --import ../../scripts/test-stub-register.mjs test/<file>.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 可链式调用的 schema 桩：z.object({...}) / z.boolean().default(true) 等一律返回自身。
// 插件用它只为声明配置形状，测试路径不需要真实校验语义。
// 可链式调用的 schema 桩：z.object({...}) / z.boolean().default(true) 等一律返回自身。
// 插件用它只为声明配置形状，测试路径不需要真实校验语义。
const STUBS = {
  // declareTool 的声明式定义：运行时为恒等/校验，测试只取返回的 def
  "@deepseek-ai/dsh-tools": "export const defineTool = (def) => def;\nexport default { defineTool };\n",

  // 配置 schema（zod 风格链式 API）。桩需**真实求值默认值**，否则 Config({}) 会返回代理，
  // 让 `c.maxChars === 1200` 这类断言变成假阳性失败——那比测试跑不起来更误导。
  // 支持：object/boolean/natural/number/string/array/dict/union/const + default/optional/required/description。
  // object 需**递归**填默认值：形如 Config({ claudeCode: { bin } }) 时，嵌套字段的 default 也要生效。
  "@deepseek-ai/schemastery":
    "function node(kind, shape) {\n" +
    "  const f = function (input) {\n" +
    "    if (kind === 'object') {\n" +
    "      const out = {};\n" +
    "      for (const k of Object.keys(shape || {})) {\n" +
    "        const field = shape[k];\n" +
    "        const has = input && Object.prototype.hasOwnProperty.call(input, k);\n" +
    "        const given = has ? input[k] : undefined;\n" +
    "        out[k] = field && field.__kind === 'object'\n" +
    "          ? field(given === undefined ? {} : given)\n" +
    "          : (given !== undefined ? given : (field ? field.__def : undefined));\n" +
    "      }\n" +
    "      // 调用方多给的键保留（真实 zod 会剥离，但测试用例依赖原样透传）\n" +
    "      if (input) for (const k of Object.keys(input)) if (!(k in out)) out[k] = input[k];\n" +
    "      return out;\n" +
    "    }\n" +
    "    return input;\n" +
    "  };\n" +
    "  f.__kind = kind;\n" +
    "  f.__def = undefined;\n" +
    "  f.default = function (v) { const n = node(kind, shape); n.__def = v; return n; };\n" +
    "  for (const m of ['optional', 'required', 'description', 'transform', 'pipe']) f[m] = function () { return f; };\n" +
    "  return f;\n" +
    "}\n" +
    "const z = {};\n" +
    "for (const k of ['boolean', 'natural', 'number', 'string', 'array', 'dict', 'union', 'const', 'literal', 'enum', 'any', 'unknown']) z[k] = function () { return node(k); };\n" +
    "z.object = function (shape) { return node('object', shape); };\n" +
    "export default z;\n",

  // MCP 客户端：测试不发起真实连接，给出可构造的占位
  "@deepseek-ai/dsh-mcp-client":
    "export class Client { constructor() {} async connect() { throw new Error('test stub: no real MCP connection'); } async close() {} }\nexport default { Client };\n",
};

const URLS = new Map(
  Object.entries(STUBS).map(([k, v]) => [k, "data:text/javascript," + encodeURIComponent(v)]),
);

// 跨插件引用：插件之间以包名互相 import（如 dsh-hunter → @dsh-external/dsh-redteam-results）。
// 运行时由 profile 的 node_modules 解析；独立跑测试时映射到仓库内的兄弟插件目录。
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

export function resolve(specifier, context, nextResolve) {
  const url = URLS.get(specifier);
  if (url) return { url, format: "module", shortCircuit: true };

  // 含子路径导出（如 @dsh-external/dsh-redteam-results/store），不能只匹配裸包名。
  const m = /^@dsh-external\/(dsh-[a-z0-9-]+)(?:\/(.+))?$/.exec(specifier);
  if (m) {
    const pkg = m[1];
    const sub = m[2];
    const rels = sub
      ? [`lib/${sub}.js`, `${sub}.js`, `lib/${sub}/index.js`]
      : [];
    rels.push("lib/index.js", "index.js");
    for (const rel of rels) {
      const p = path.join(REPO_ROOT, "plugins", pkg, rel);
      if (fs.existsSync(p)) return { url: pathToFileURL(p).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
