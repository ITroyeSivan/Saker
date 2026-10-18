// 5.7 作用域门禁：Saker 插件不得用 body / html / :root / * 全局覆盖宿主。
//
// 唯一例外是**导出报告文档**：报告 HTML 的 <style> 里用 body 是文档上下文，不是宿主 UI。
// 用规则前 200 字符里是否出现 <style> / </title> / <!doctype 判定。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { productPluginDirectories } from './lib/product-plugins.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RULE = /([^{}\n]{1,200})\{([^{}]*)\}/g;
const GLOBAL = new Set(['body', 'html', ':root', '*']);

function firstSelector(raw) {
  const tail = raw.slice(raw.lastIndexOf('{') + 1).trim();
  const cleaned = tail.replace(/^[\s\S]*?['"`(]/, '').replace(/^['"`\s]+/, '').trim();
  return cleaned.split(',')[0].trim();
}

const files = [];
for (const name of productPluginDirectories(root)) {
  const client = path.join(root, 'plugins', name, 'lib', 'client.js');
  if (fs.existsSync(client)) files.push(client);
  const source = path.join(root, 'plugins', name, 'src', 'client', 'styles.ts');
  if (fs.existsSync(source)) files.push(source);
}
assert(files.length >= 8, '产品插件客户端文件太少，门禁覆盖范围可疑：' + files.length);

const violations = [];
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const rel = path.relative(root, file).replace(/\\/g, '/');
  for (const rule of source.matchAll(RULE)) {
    const selector = firstSelector(rule[1]);
    if (!GLOBAL.has(selector)) continue;
    const context = source.slice(Math.max(0, rule.index - 200), rule.index);
    if (/<style>|<\/title>|<!doctype/i.test(context)) continue;
    violations.push({ file: rel, selector, body: rule[2].trim().slice(0, 60) });
  }
}

if (violations.length) {
  console.log('FAIL 5.7 作用域（不得用 body/html/:root/* 全局覆盖宿主；导出报告文档除外）：');
  for (const v of violations.slice(0, 40)) console.log(`   ${v.file} ${v.selector} :: ${v.body}`);
  process.exitCode = 1;
} else {
  console.log(`ok   5.7 作用域：${files.length} 个产品客户端文件没有全局覆盖宿主（导出报告文档除外）`);
}
