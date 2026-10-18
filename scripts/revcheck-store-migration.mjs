import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const boundary = resolve(root, '../_ref/tmp');
const lib = join(root, 'plugins/dsh-redteam-results/lib');
const module = join(lib, 'store.js');
const suite = join(root, 'scripts/test-store-migration.mjs');
const stub = join(root, 'scripts', 'test-stub-register.mjs');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const before = { module: hash(module), suite: hash(suite) };

const variants = [
  { id: 'all-errors-swallowed', from: "if (/duplicate column name/i.test(message)) return 'existing';",
    to: "return 'existing';",
    failure: /FAIL only a duplicate column may be ignored/ },
  { id: 'migration-skipped', from: "for (const col of MIGRATION_COLUMNS) migration[applyColumnMigration(db, 'findings', col)] += 1;",
    to: 'for (const col of MIGRATION_COLUMNS) migration.existing += 1;',
    failure: /FAIL a legacy database missing a column is upgraded and the column becomes usable/ },
];

try {
  for (const variant of variants) {
    const directory = mkdtempSync(join(boundary, `revcheck-store-migration-${variant.id}-`));
    try {
      const inside = relative(boundary, directory);
      assert(inside && !inside.startsWith('..') && !isAbsolute(inside), 'temporary directory escaped _ref/tmp');
      // store.js 有一整条相对导入链（delivery/checked/task-policy…），必须整棵 lib 一起复制。
      cpSync(lib, join(directory, 'plugins/dsh-redteam-results/lib'), { recursive: true });
      const target = join(directory, 'plugins/dsh-redteam-results/lib/store.js');
      const source = readFileSync(module, 'utf8');
      assert.equal(source.split(variant.from).length - 1, 1, `${variant.id}: exact mutation anchor`);
      writeFileSync(target, source.replace(variant.from, variant.to));
      const runner = join(directory, 'test-store-migration.mjs');
      writeFileSync(runner, readFileSync(suite, 'utf8')
        .replace("'../plugins/dsh-redteam-results/lib/store.js'", JSON.stringify(pathToFileURL(target).href))
        .replace("'./test-home-isolation.mjs'", JSON.stringify(pathToFileURL(join(root, 'scripts', 'test-home-isolation.mjs')).href)));
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(stub).href, runner], {
        cwd: root, encoding: 'utf8',
        env: { ...process.env, TEMP: boundary, TMP: boundary, TMPDIR: boundary },
      });
      assert.notEqual(result.status, 0, `${variant.id}: reverse suite must fail`);
      assert.match(`${result.stdout || ''}${result.stderr || ''}`, variant.failure, `${variant.id}: targeted assertion must fail`);
      console.log(`ok reverse ${variant.id}: targeted migration assertion failed`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
} finally {
  for (const [name, file] of Object.entries({ module, suite })) {
    assert.equal(hash(file), before[name], `${name} changed during reverse checks`);
  }
}
