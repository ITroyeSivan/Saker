// v6 第 4.1 / 13 节：设置页「方法编排」与聊天工具栏的「测试模块」选择器必须真的退出运行。
//
// 为什么不能只做源码字符串断言：2026-10-17 审计发现，client.js 里整段旧设置页与模块浮层
// 的组件都还在，只是 apply() 恰好什么都不注册。字符串锁既会让人以为废弃页面还在用，
// 也拦不住有人把注册行加回来。这里真实加载 client bundle，用记录调用的假 ctx 调 apply()，
// 要求零注册；并检查已退出入口的文案不再留在 bundle 里。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../plugins/dsh-method-stack/lib/client.js', import.meta.url), 'utf8');

let loaded = null;
runInNewContext(source, {
  window: { __ModuleLoader__: { load: (definition) => { loaded = definition; } } },
  console, setTimeout, clearTimeout, setInterval, clearInterval,
});
assert(loaded, 'method-stack client must register itself through the host module loader');
assert.equal(loaded.id, '@dsh-external/dsh-method-stack');
const client = loaded.factory(() => ({}));
assert.equal(client.name, 'dsh-method-stack-client');

// 任何一次注册都会被记下来：宿主插槽、设置页、RPC、命令……全都算。
const registrations = [];
function recorder(label) {
  return new Proxy(function () {}, {
    get: (_target, prop) => (prop === 'then' ? undefined : recorder(`${label}.${String(prop)}`)),
    apply: () => { registrations.push(label); return { dispose() {} }; },
  });
}
const ctx = new Proxy({}, { get: (_target, prop) => recorder(String(prop)) });
client.apply(ctx);
assert.deepEqual(registrations, [], 'method-stack client must not register any host slot');
console.log('ok method-stack client loads through the host loader and registers no host slot');

// 已退出的入口连文案都不该留在 bundle 里：留着就会被下一个人当成现成功能重新挂上。
for (const retired of ['方法编排', '测试模块', 'saker-module-trigger', 'opening-reset', 'delete-combo']) {
  assert(!source.includes(retired), `retired UI text must be gone from the client bundle: ${retired}`);
}
console.log('ok removed entry cannot come back without failing this suite');
