import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url)), tmp = path.resolve(root, '../_ref/tmp');
const source = path.join(root, 'plugins/dsh-redteam-results/lib/method-classification.js');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const before = hash(source);
const variants = [
  ['silent-classification-overwrite',
    "if (existing && existing.record !== encoded) throw new Error('同一分类修订的内容不可更改；请递增 revision 或使用新的方法摘要');",
    "if (false) throw new Error('同一分类修订的内容不可更改；请递增 revision 或使用新的方法摘要');",
    'staging persists across restart and the same revision cannot be silently rewritten'],
  ['verified-without-source',
    "if (doc.status === 'verified' && (!sourceVersion || !position)) throw new Error('verified 分类必须带来源版本与原文位置');",
    "if (false) throw new Error('verified 分类必须带来源版本与原文位置');",
    'verified needs a traceable source; unknown and conflict need a reason; illegal shapes are refused'],
  ['unclassified-grants-every-module',
    "if (!record) return { status: 'unclassified', modules: [], reason: '方法尚未分类，主动执行需先完成分类', revision: null };",
    "if (!record) return { status: 'verified', modules: [...(knownModules ?? [])], reason: '', revision: null };",
    'a method without any classification stays readable: the catalog is untouched and nothing is auto-selected'],
];
for (const [name, from, to, expected] of variants) {
  const fixture = fs.mkdtempSync(path.join(tmp, 'revcheck-method-classification-'));
  try {
    fs.cpSync(path.join(root, 'plugins/dsh-redteam-results/lib'), path.join(fixture, 'plugins/dsh-redteam-results/lib'), { recursive: true });
    fs.mkdirSync(path.join(fixture, 'scripts'));
    fs.copyFileSync(path.join(root, 'scripts/test-method-classification.mjs'), path.join(fixture, 'scripts/test-method-classification.mjs'));
    const mutant = path.join(fixture, 'plugins/dsh-redteam-results/lib/method-classification.js'), content = fs.readFileSync(mutant, 'utf8');
    assert.equal(content.split(from).length - 1, 1, name + ': mutation anchor must occur exactly once');
    fs.writeFileSync(mutant, content.replace(from, to));
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(path.join(root, 'scripts/test-stub-register.mjs')).href, path.join(fixture, 'scripts/test-method-classification.mjs')],
      { cwd: root, encoding: 'utf8', timeout: 30000, env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp } });
    assert.notEqual(result.status, 0, name + ' falsely passed');
    assert((result.stdout + result.stderr).includes('FAIL ' + expected), name + ' failed for an unrelated reason: ' + result.stdout + result.stderr);
    console.log('ok reverse ' + name + ' fails on the corresponding classification behavior');
  } finally { fs.rmSync(fixture, { recursive: true, force: true }); }
}
assert.equal(hash(source), before); console.log('ok method classification reverse verification preserves production source');
