import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ASSETS_MD,
  INVENTORY_FILE,
  matchesScope,
  mergeAssets,
  normalizeAsset,
  parseScope,
  readInventory,
  scopeSafeAsset,
  upsertAssets,
} from "../lib/asset-inventory.mjs";

let pass = 0;
let fail = 0;
function ok(label, condition, detail = "") {
  if (condition) {
    pass += 1;
    console.log(`ok   ${label}`);
  } else {
    fail += 1;
    console.log(`FAIL ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

const now = "2026-09-24T00:00:00.000Z";
const base = normalizeAsset({ target: "example.com", ip: "203.0.113.10", port: "443", protocol: "https", title: "Portal", source: "fofa" }, { now });
ok("裸域名补 scheme", base.target === "http://example.com", base.target);
ok("端口转为数字", base.port === 443 && typeof base.port === "number", JSON.stringify(base));

const merged = mergeAssets({ schema: "saker.asset-inventory/1", updatedAt: now, assets: [base] }, [
  { target: "http://example.com", ip: "203.0.113.10", port: 443, title: "Portal New", server: "nginx", tech: ["weaver"], source: "hunter" },
  { target: "http://example.com", ip: "203.0.113.10", port: 443, tech: ["ecology"], source: "httpx" },
], { now: "2026-09-24T00:01:00.000Z" });
ok("同一资产多来源合并为一条", merged.inventory.assets.length === 1, JSON.stringify(merged.inventory.assets));
ok("来源列表合并且去重", merged.inventory.assets[0].sources.join(",") === "fofa,hunter,httpx", JSON.stringify(merged.inventory.assets[0].sources));
ok("指纹合并且去重", merged.inventory.assets[0].tech.join(",") === "weaver,ecology", JSON.stringify(merged.inventory.assets[0].tech));
ok("非空字段补全", merged.inventory.assets[0].title === "Portal" && merged.inventory.assets[0].server === "nginx", JSON.stringify(merged.inventory.assets[0]));
ok("返回新增/合并计数", merged.added === 0 && merged.merged === 2, JSON.stringify(merged));

const scope = parseScope("example.com, 203.0.113.0/24, 2001:db8::1");
ok("scope 解析域名/IP/CIDR", scope.includes("example.com") && scope.includes("203.0.113.0/24"), JSON.stringify(scope));
ok("裸域 scope 精确匹配根域", matchesScope({ host: "example.com" }, scope));
ok("裸域 scope 不扩大到子域", !matchesScope({ host: "oa.example.com", ip: "198.51.100.10" }, scope));
ok("显式通配 scope 匹配子域", matchesScope({ host: "oa.example.com" }, "*.example.com"));
ok("显式通配 scope 不包含根域", !matchesScope({ host: "example.com" }, "*.example.com"));
ok("scope parser 保留通配授权", parseScope("*.example.com").includes("*.example.com"));
ok("IP scope 精确匹配", matchesScope({ host: "x.invalid", ip: "2001:db8::1" }, scope));
ok("IPv4 CIDR 匹配", matchesScope({ host: "x.invalid", ip: "203.0.113.44" }, scope));
ok("范围外资产不匹配", !matchesScope({ host: "evil.example.net", ip: "198.51.100.9" }, scope));
ok("空 scope 一律不匹配", !matchesScope({ host: "example.com" }, ""));
const inScopeVhost = scopeSafeAsset({
  target: "https://203.0.113.10:8443/app",
  host: "oa.example.com",
  ip: "203.0.113.10",
  port: 8443,
}, "*.example.com");
ok("授权域名的 IP 虚拟主机保留 Host 并清掉 URL 路径", inScopeVhost?.target === "https://203.0.113.10:8443"
  && inScopeVhost.host === "oa.example.com", JSON.stringify(inScopeVhost));
const inScopeIpOnly = scopeSafeAsset({
  target: "https://shared.example.net:8443/app",
  host: "shared.example.net",
  ip: "203.0.113.10",
  port: 8443,
}, "203.0.113.0/24");
ok("仅 IP/CIDR 授权时把共享 IP 结果重写到范围内 IP", inScopeIpOnly?.target === "https://203.0.113.10:8443"
  && inScopeIpOnly.host === "203.0.113.10", JSON.stringify(inScopeIpOnly));
ok("授权域名字段能识别但不沿用越界 Host", scopeSafeAsset({
  target: "https://shared.example.net",
  host: "shared.example.net",
  domain: "example.com",
}, "example.com")?.target === "https://example.com");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "saker-assets-"));
try {
  fs.writeFileSync(path.join(root, ASSETS_MD), "# My assets\n\nkeep me\n");
  const first = upsertAssets(root, [base], { source: "fofa", now });
  const second = upsertAssets(root, [{ target: "http://example.com", tech: ["weaver"], source: "hunter" }], { source: "hunter", now: "2026-09-24T00:02:00.000Z" });
  const inventory = readInventory(root);
  ok("落盘后可读且只有一条资产", inventory.assets.length === 1, JSON.stringify(inventory));
  ok("第二次写入是合并不是新增", second.added === 0 && second.merged === 1, JSON.stringify(second));
  ok("JSON 与 Markdown 都写出", fs.existsSync(path.join(root, INVENTORY_FILE)) && fs.existsSync(path.join(root, ASSETS_MD)));
  const md = fs.readFileSync(path.join(root, ASSETS_MD), "utf8");
  ok("assets.md 带阶段门需要的 WAF/速率 标记", md.includes("## WAF") && md.includes("## 速率"));
  ok("assets.md 使用托管区块", md.includes("<!-- asset-inventory:start -->") && md.includes("<!-- asset-inventory:end -->"));
  ok("不覆盖用户放在 assets.md 的其它内容", md.includes("keep me"));

  fs.writeFileSync(path.join(root, ASSETS_MD), `# My assets\n\ncustom\n\n${md.slice(md.indexOf("<!-- asset-inventory:start -->"))}`);
  upsertAssets(root, [{ target: "https://second.example.com", source: "nmap" }], { source: "nmap" });
  const replaced = fs.readFileSync(path.join(root, ASSETS_MD), "utf8");
  ok("重复写只替换托管区块", replaced.includes("custom") && (replaced.match(/asset-inventory:start/g) || []).length === 1, replaced.slice(0, 200));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(fail === 0 ? `\nall ${pass} tests passed` : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
