#!/usr/bin/env node
// Process-output hygiene: validation artifacts belong in the workspace _ref,
// never in the source repository where they become accidental release files.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
let fail = 0;
const ok = (label, condition, detail = "") => {
  if (condition) {
    pass += 1;
    console.log(`ok   ${label}`);
  } else {
    fail += 1;
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

ok("源码树根不含过程产物目录 _ref", !existsSync(join(ROOT, "_ref")));
const transient = readdirSync(ROOT).filter((name) => /\.(?:log|tmp|bak)$/i.test(name));
ok("源码树根不含 log/tmp/bak 残片", transient.length === 0, transient.join(", "));

// 客户端「转圈转不停」：设了 busy 标志的 RPC 链必须有拒绝处理。
// 背景（2026-09-19）：knowledge-hub 的 read/save/remove/search 只写了 `.then`，
// RPC 一旦 reject（当时是连接层错误形状不合规），busy 永远为 true ——
// 界面卡在「保存中…」+ 白板，且不显示任何错误。这类"看起来在忙、其实已经死了"
// 的状态只有静态扫得出来：面板非空、data-slot-error 也是 0。
{
  const pluginsDir = join(ROOT, "plugins");
  const offenders = [];
  for (const name of readdirSync(pluginsDir)) {
    const file = join(pluginsDir, name, "lib", "client.js");
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (!/set[A-Za-z]*Busy\(true\)/.test(lines[i])) continue;
      const window = lines.slice(i, i + 30).join("\n");
      // 认两种拒绝处理：`.catch(...)`，或 `.then(onFulfilled, onRejected)` 的双参形式。
      const guarded = /\.catch\(/.test(window) || /\}\s*,\s*(?:\(\)\s*=>|function\s*\()/.test(window);
      if (!guarded) offenders.push(`${name}/lib/client.js:${i + 1}`);
    }
  }
  ok("设 busy 的 RPC 链都有拒绝处理（否则会卡在转圈）", offenders.length === 0, offenders.join(", "));
}

console.log(fail === 0 ? `\nall ${pass} tests passed` : `\n${fail} FAILED, ${pass} passed`);
process.exit(fail ? 1 : 0);
