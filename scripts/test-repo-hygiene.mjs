#!/usr/bin/env node
// Process-output hygiene: validation artifacts belong in the workspace _ref,
// never in the source repository where they become accidental release files.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { productPluginDirectories } from './lib/product-plugins.mjs';

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

// 插件入口语法门：lib 下的宿主半 / 客户端半必须能被解析。
// 背景（2026-09-24）：sec-config 的内存马表单多写了一个 ')'，整份 client.js 解析失败。
// 症状极具欺骗性——宿主启动日志干净、单元测试全绿，只有浏览器里冒
// 「HARNESS / Failed to load plugins / web boot: 1 entry did not activate」，
// 而且报的是「import failed」而不是语法错误。把「能解析」变成断言，这类半成品就出不了门。
{
  const pluginsDir = join(ROOT, "plugins");
  const offenders = [];
  for (const name of readdirSync(pluginsDir)) {
    for (const rel of ["lib/index.js", "lib/client.js"]) {
      const file = join(pluginsDir, name, rel);
      if (!existsSync(file)) continue;
      const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
      if (r.status !== 0) {
        const detail = String(r.stderr || "")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => /SyntaxError/.test(line)) || "parse failed";
        offenders.push(`${name}/${rel}: ${detail}`);
      }
    }
  }
  ok("每个插件 lib 入口都能被解析（语法坏掉会让浏览器整块挂起）", offenders.length === 0, offenders.join("; "));
}

// 「写在模型看不到的字段里」：模型的工具结果走 `render`，而本仓库所有工具的 render
// 都只输出 `v.text`——所以**照着做的字段**（nextCall / nextStep / nucleiCommand /
// commandLine 这类「下一步敲什么」的串）如果只写在返回对象里，模型根本看不到。
// 2026-09-25 实锤两处：`nday_match` 的 `nextStep`（README 还明说「命中行直接给出公开工具」）
// 与 `expand`——单测断言的是 `rows[].xxx`，测试全绿而能力没落地（假绿）。
// 判据：块内凡是**作为返回字段**出现的这些键，必须至少被一个 `${…}` 模板表达式引用到。
{
  const ACTIONABLE = ["nextCall", "nextStep", "nucleiCommand", "commandLine"];
  const offenders = [];
  for (const name of readdirSync(join(ROOT, "plugins"))) {
    const file = join(ROOT, "plugins", name, "lib/index.js");
    if (!existsSync(file)) continue;
    const src = readFileSync(file, "utf8");
    // 按 `defineTool(` 切块——早先按 `name: 'x'` 切，块内任何 `name: '…'`
    // （比如返回对象里的字段）都会把块截断，于是检查根本没跑到返回字段那一行。
    const starts = [...src.matchAll(/defineTool\(\{[\s\S]{0,200}?name:\s*'([a-z0-9_]+)'/g)];
    for (let i = 0; i < starts.length; i += 1) {
      const block = src.slice(starts[i].index, i + 1 < starts.length ? starts[i + 1].index : src.length);
      if (!/render:/.test(block) || !/v\.text/.test(block)) continue; // 只盯 text-only render
      const templateExprs = [...block.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]).join(" ");
      for (const key of ACTIONABLE) {
        if (!new RegExp(`\\b${key}\\s*:`).test(block)) continue; // 没把它当返回字段
        if (!templateExprs.includes(key)) {
          offenders.push(`${name}/${starts[i][1]}: ${key} 只写在返回对象里，没进 text`);
        }
      }
    }
  }
  ok("「照着做」的字段都进了模型可见的 text（render 只输出 text）", offenders.length === 0, offenders.join("; "));
}

// persona 预算：persona 是**每轮都在**的常驻提示词，方法论细则属于**按需读**的 skill。
// 常驻 persona 保留声明与检索顺序；详细方法按需读取。
//   · persona 文本超过预算 → 红（防止提示词慢慢长回去）；
//   · persona 里出现 playbook 的**方法论细则标志词** → 红（说明又把细则搬回常驻层了）。
// 默认 persona 现在保存在 preset/<mode>/opening.md，由方法编排设置页整段编辑。
{
  const CAP_BYTES = 16 * 1024;
  const DETAIL_MARKERS = ["五个切入点", "四步编排"];
  const offenders = [];
  for (const preset of ["pentest", "code-audit", "ctf-solver"]) {
    const file = join(ROOT, "preset", preset, "opening.md");
    const text = existsSync(file) ? readFileSync(file, "utf8").trimEnd() : "";
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > CAP_BYTES) offenders.push(`${preset}/opening.md persona ${(bytes / 1024).toFixed(1)} KB > ${CAP_BYTES / 1024} KB`);
    for (const m of DETAIL_MARKERS) {
      if (text.includes(m)) offenders.push(`${preset}/opening.md persona 里出现 playbook 的方法论细则「${m}」`);
    }
  }
  ok("persona 在预算内、且没把 playbook 的方法论细则搬回常驻层", offenders.length === 0, offenders.join("; "));
}

// 打包一致性：tgz 是 git 忽略的构建产物，「改了源码忘了重打」**没有任何测试会红**。
// 2026-09-25 实锤：语料从 9 条扩到 15 条，只重打了插件 tgz、没重打根包
// （语料住在 dsh-saker 根包的 preset/ 下），两个 home 一路停在 9 条，
// 而当时的检查器只看 lib/ —— 全绿。
//
// 判据是**内容**不是 mtime：构建会重写 mtime 但产出同样字节（mcp-studio 就是这样），
// 用时间戳会天天误报，最后没人看。这里直接把 tgz 解开逐文件比 sha256。
{
  const sha256Of = (value) => createHash("sha256").update(value).digest("hex");
  // 最小 tar 读取器。必须处理长名扩展，否则超过 100 字符的路径（semgrep 规则树里
  // 一大半都是）会被读成截断名，gate 立刻变成 809 条假「tgz 缺文件」。
  //   · GNU：typeflag 'L' 的条目正文是**下一个**条目的真实名字
  //   · PAX：typeflag 'x' 的正文里有 `path=<真实名字>` 行
  const readTar = (buffer) => {
    const files = new Map();
    let pendingName;
    for (let offset = 0; offset + 512 <= buffer.length;) {
      const header = buffer.subarray(offset, offset + 512);
      if (header.every((byte) => byte === 0)) break;
      const shortName = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
      // ustar 把超过 100 字符的名字拆成 prefix(345..500) + name —— 漏掉 prefix
      // 会把长路径读成截断名（semgrep 规则树一半以上都超长，实测 807 条假「缺文件」）。
      const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
      const name = prefix.length > 0 ? `${prefix}/${shortName}` : shortName;
      const size = parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/, "").trim() || "0", 8);
      const type = String.fromCharCode(header[156] || 48);
      const body = buffer.subarray(offset + 512, offset + 512 + size);
      if (type === "L") {
        pendingName = body.toString("utf8").replace(/\0.*$/, "");
      } else if (type === "x") {
        const line = body.toString("utf8").split("\n").find((l) => l.startsWith("path="));
        if (line !== undefined) pendingName = line.slice("path=".length);
      } else if (type === "0" || type === "\0" || type === "") {
        files.set(pendingName ?? name, body);
        pendingName = undefined;
      } else {
        pendingName = undefined;
      }
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    return files;
  };

  const walkFiles = (dir, base = dir, out = []) => {
    if (!existsSync(dir)) return out;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walkFiles(full, base, out);
      else out.push(full);
    }
    return out;
  };

  const targets = [];
  const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  targets.push({
    label: rootPkg.name,
    dir: ROOT,
    tgz: join(ROOT, `${rootPkg.name}-${rootPkg.version}.tgz`),
    // 根包随包发的是 preset/（语料、playbook、persona）与 shared/，不是只有 lib/
    trees: ["lib", "preset", "shared"],
    files: ["README.md", "cordis.patch.yml"],
  });
  for (const name of productPluginDirectories(ROOT)) {
    if (!name.startsWith("dsh-")) continue;
    const dir = join(ROOT, "plugins", name);
    if (!existsSync(join(dir, "package.json"))) continue;
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    targets.push({
      label: pkg.name,
      dir,
      tgz: join(dir, `${pkg.name.replace(/^@[^/]+\//, "dsh-external-")}-${pkg.version}.tgz`),
      trees: ["lib"],
      files: ["README.md", "cordis.patch.yml"],
    });
  }

  const stale = [];
  let checked = 0;
  for (const target of targets) {
    if (!existsSync(target.tgz)) continue;
    checked += 1;
    const entries = readTar(gunzipSync(readFileSync(target.tgz)));
    const expected = new Map();
    for (const tree of target.trees) {
      for (const file of walkFiles(join(target.dir, tree))) {
        expected.set(join(tree, file.slice(join(target.dir, tree).length + 1)), file);
      }
    }
    for (const name of target.files) {
      const file = join(target.dir, name);
      if (existsSync(file)) expected.set(name, file);
    }
    const diffs = [];
    for (const [rel, file] of expected) {
      const packed = entries.get(`package/${rel.split("\\").join("/")}`);
      if (packed === undefined) { diffs.push(`tgz 缺 ${rel}`); continue; }
      if (sha256Of(readFileSync(file)) !== sha256Of(packed)) diffs.push(`${rel} 内容不一致`);
    }
    for (const name of entries.keys()) {
      if (!name.startsWith("package/")) continue;
      const rel = name.slice("package/".length);
      // 只比我们声明要比的那几棵树：LICENSE / tools/ / packs/ 是包自己的事，
      // 把它们算成「多出」会淹掉真正的问题。
      const inTree = target.trees.some((tree) => rel === tree || rel.startsWith(`${tree}/`));
      if (!inTree) continue;
      if (!expected.has(rel.split("/").join("\\")) && !expected.has(rel)) diffs.push(`tgz 多出 ${rel}`);
    }
    if (diffs.length > 0) stale.push(`${target.label}：${diffs.slice(0, 3).join("；")}${diffs.length > 3 ? ` 等 ${diffs.length} 处` : ""}`);
  }
  ok(`tgz 与源码一致（改了要重打，否则改动送不出去）`, stale.length === 0,
    checked === 0 ? "（没有 tgz，跳过）" : stale.join("; "));
}

console.log(fail === 0 ? `\nall ${pass} tests passed` : `\n${fail} FAILED, ${pass} passed`);
process.exit(fail ? 1 : 0);
