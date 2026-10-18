import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const boundary = resolve(root, '../_ref/tmp');
const module = join(root, 'plugins/dsh-redteam-results/lib/row-record.js');
const suite = join(root, 'scripts/test-row-record.mjs');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const before = { module: hash(module), suite: hash(suite) };

const variants = [
  { id: 'raw-error-rethrown', from: "catch (cause) { throw new CorruptRecordError(table ?? 'unknown', key, id ?? row[key] ?? '?', cause); }",
    to: 'catch (cause) { throw cause; }',
    failure: /FAIL a corrupt row raises a typed error naming the table and the row/ },
  { id: 'table-name-dropped', from: 'super(`${table} 的行记录已损坏（${key}=${id}）：', to: 'super(`行记录已损坏（${key}=${id}）：',
    failure: /FAIL a corrupt row raises a typed error naming the table and the row/ },
  { id: 'corruption-hidden', from: "catch (cause) { throw new CorruptRecordError(table ?? 'unknown', key, id ?? row[key] ?? '?', cause); }",
    to: 'catch { return null; }',
    failure: /FAIL a corrupt row raises a typed error naming the table and the row/ },
];

try {
  for (const variant of variants) {
    const directory = mkdtempSync(join(boundary, `revcheck-row-record-${variant.id}-`));
    try {
      const inside = relative(boundary, directory);
      assert(inside && !inside.startsWith('..') && !isAbsolute(inside), 'temporary directory escaped _ref/tmp');
      const target = join(directory, 'row-record.js');
      const source = readFileSync(module, 'utf8');
      assert.equal(source.split(variant.from).length - 1, 1, `${variant.id}: exact mutation anchor`);
      writeFileSync(target, source.replace(variant.from, variant.to));
      const runner = join(directory, 'test-row-record.mjs');
      writeFileSync(runner, readFileSync(suite, 'utf8').replace(
        "'../plugins/dsh-redteam-results/lib/row-record.js'", JSON.stringify(pathToFileURL(target).href)));
      const result = spawnSync(process.execPath, [runner], {
        cwd: root, encoding: 'utf8',
        env: { ...process.env, TEMP: boundary, TMP: boundary, TMPDIR: boundary },
      });
      assert.notEqual(result.status, 0, `${variant.id}: reverse suite must fail`);
      assert.match(`${result.stdout || ''}${result.stderr || ''}`, variant.failure, `${variant.id}: targeted assertion must fail`);
      console.log(`ok reverse ${variant.id}: targeted row-record assertion failed`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
} finally {
  for (const [name, file] of Object.entries({ module, suite })) {
    assert.equal(hash(file), before[name], `${name} changed during reverse checks`);
  }
}
