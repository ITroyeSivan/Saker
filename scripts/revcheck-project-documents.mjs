// W03 反向验证：分别回退合并单元格、隐藏内容和公式无结果警告，确认测试会失败。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const tmp = path.resolve(root, '../_ref/tmp');
const runner = 'test-project-documents.mjs';
const file = 'plugins/dsh-redteam-results/lib/project-documents.js';
const variants = [
  ['grid-span', "const gridSpan = Number(/<w:gridSpan\\b[^>]*w:val=\"(\\d+)\"/.exec(cell[0])?.[1] || 1);", 'const gridSpan = 1;',
    'DOCX 段落、表格、合并单元格与内嵌对象位置可对应原文'],
  ['hidden-content', "const hidden = /hidden=\"1\"/.test(row[1]);", 'const hidden = false;',
    'XLSX 工作表、隐藏表、隐藏行、隐藏列、合并区域与公式无结果都显式列出'],
  ['formula-result', 'formulaNoResult: formula !== undefined && rawValue === undefined', 'formulaNoResult: false',
    'XLSX 工作表、隐藏表、隐藏行、隐藏列、合并区域与公式无结果都显式列出'],
  ['read-limit', 'Math.min(DOCUMENT_LIMITS.maxReadChars', 'Math.max(DOCUMENT_LIMITS.maxReadChars',
    '文本按行范围分段，长内容可继续读取且不一次返回全文'],
  ['zip-entry-limit', 'if (count > DOCUMENT_LIMITS.maxEntries) throw new Error(\'ZIP 条目数超过 5000 上限\');', '',
    'ZIP 条目数、解压大小和无压缩超限都在解析前受控失败'],
  ['zip-attribute-order',
    "  const rels = new Map([...relsXml.matchAll(/<Relationship\\b([^>]*)\\/?>/g)]\n    .map(match => attrsOf(match[1])).filter(attrs => attrs.Id && attrs.Target)\n    .map(attrs => [attrs.Id, attrs.Target]));",
    "  const rels = new Map([...relsXml.matchAll(/<Relationship\\b[^>]*Id=\"([^\"]+)\"[^>]*Target=\"([^\"]+)\"/g)].map(match => [match[1], match[2]]));",
    'XLSX 工作表、隐藏表、隐藏行、隐藏列、合并区域与公式无结果都显式列出'],
];

const before = createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
for (const [name, from, to, expected] of variants) {
  const fixture = fs.mkdtempSync(path.join(tmp, 'saker-project-documents-reverse-'));
  assert(path.resolve(fixture).startsWith(tmp + path.sep));
  try {
    for (const directory of ['lib', 'shared']) fs.cpSync(path.join(root, directory), path.join(fixture, directory), { recursive: true });
    for (const plugin of fs.readdirSync(path.join(root, 'plugins'))) {
      const source = path.join(root, 'plugins', plugin, 'lib');
      if (fs.existsSync(source)) fs.cpSync(source, path.join(fixture, 'plugins', plugin, 'lib'), { recursive: true });
    }
    fs.copyFileSync(path.join(root, 'package.json'), path.join(fixture, 'package.json'));
    fs.mkdirSync(path.join(fixture, 'scripts', 'lib'), { recursive: true });
    for (const script of [runner, 'test-stub-register.mjs', 'test-stub-loader.mjs', 'test-home-isolation.mjs'])
      fs.copyFileSync(path.join(root, 'scripts', script), path.join(fixture, 'scripts', script));
    const target = path.join(fixture, file);
    const content = fs.readFileSync(target, 'utf8').replaceAll('\r\n', '\n');
    assert.equal(content.split(from).length - 1, 1, name + ' mutation anchor');
    fs.writeFileSync(target, content.replace(from, to));
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(fixture, 'scripts/test-stub-register.mjs')).href, path.join(fixture, 'scripts', runner)],
      { cwd: root, encoding: 'utf8', timeout: 120000, env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp } });
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, name + ' unexpectedly passed');
    assert(output.includes('FAIL ' + expected), name + ' failed outside target assertion: ' + output);
    console.log('ok reverse ' + name + ': original behavior makes the targeted assertion fail');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}
assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex'), before, 'production source changed');
console.log('ok reverse verification preserves the production source file');
