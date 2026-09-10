// 注册测试用解析钩子（见 dsh-tools-loader.mjs 的说明）。
// 用法：node --import ./test/register-stub.mjs test/<file>.mjs
import { register } from "node:module";

register("./dsh-tools-loader.mjs", import.meta.url);
