// 注册共享测试桩解析钩子（见 test-stub-loader.mjs）。
// 用法（从插件目录）：node --import ../../scripts/test-stub-register.mjs test/<file>.mjs
import { register } from "node:module";

register("./test-stub-loader.mjs", import.meta.url);
