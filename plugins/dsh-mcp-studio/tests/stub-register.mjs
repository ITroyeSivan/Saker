// 注册 tests/stub-loader.mjs。用法（从插件目录）：
//   node --import tsx --import ./tests/stub-register.mjs --test tests/*.test.ts
import { register } from 'node:module'

register('./stub-loader.mjs', import.meta.url)
