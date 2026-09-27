import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FILE = path.join(ROOT, "preset", "pentest", "refs", "zeroday-patterns", "catalog.json");
const catalog = JSON.parse(fs.readFileSync(FILE, "utf8"));

let pass = 0;
let fail = 0;
const ok = (label, condition, detail = "") => {
  if (condition) {
    pass += 1;
    console.log(`ok   ${label}`);
  } else {
    fail += 1;
    console.log(`FAIL ${label}${detail ? ` -- ${detail}` : ""}`);
  }
};

const patterns = Array.isArray(catalog.patterns) ? catalog.patterns : [];
const categories = new Set((catalog.categories || []).map((item) => item.id));
const ids = new Set(patterns.map((item) => item.id));

ok("schema 正确", catalog.schema === "saker.zeroday.patterns/1", catalog.schema);
ok("版本与来源表存在", typeof catalog.version === "string" && catalog.sources && typeof catalog.sources === "object");
ok("来源 URL 均为 http(s)", Object.values(catalog.sources || {}).every((url) => /^https?:\/\//i.test(String(url))));
ok("至少 20 个功能缺陷模式", patterns.length >= 20, String(patterns.length));
ok("模式 ID 唯一", ids.size === patterns.length, `${ids.size}/${patterns.length}`);
ok("分类至少覆盖 5 类", categories.size >= 5, String(categories.size));

for (const pattern of patterns) {
  const scope = `[${pattern.id}]`;
  ok(`${scope} 分类合法`, categories.has(pattern.category), pattern.category);
  ok(`${scope} 有 surface`, Array.isArray(pattern.surfaces) && pattern.surfaces.length >= 1);
  ok(`${scope} 有可观察信号`, Array.isArray(pattern.signals) && pattern.signals.length >= 1);
  ok(`${scope} 有明确假设`, typeof pattern.hypothesis === "string" && pattern.hypothesis.length >= 12);
  ok(`${scope} 有最小验证`, Array.isArray(pattern.safeTests) && pattern.safeTests.length >= 1);
  ok(`${scope} 有先行证伪条件`, Array.isArray(pattern.falsifyFirst) && pattern.falsifyFirst.length >= 1);
  ok(`${scope} 有影响描述`, typeof pattern.impact === "string" && pattern.impact.length >= 2);
  ok(`${scope} sourceIds 合法`,
    Array.isArray(pattern.sourceIds) && pattern.sourceIds.length >= 1
    && pattern.sourceIds.every((id) => Object.hasOwn(catalog.sources, id)));
  ok(`${scope} chainWith 指向真实模式`,
    Array.isArray(pattern.chainWith)
    && pattern.chainWith.every((id) => id !== pattern.id && ids.has(id)),
    JSON.stringify(pattern.chainWith));
}

const byCategory = new Map();
for (const pattern of patterns) byCategory.set(pattern.category, (byCategory.get(pattern.category) || 0) + 1);
ok("每类至少一个模式", [...categories].every((id) => byCategory.has(id)), JSON.stringify([...byCategory]));
ok("模式库不含 payload/exp 字段", !/"(?:payload|exploitBody|command)"\s*:/.test(JSON.stringify(catalog)));

console.log(fail === 0 ? `\nall ${pass} tests passed` : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
