import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const boundary = resolve(root, '../_ref/tmp');
const lib = join(root, 'plugins/dsh-redteam-results/lib');
const module = join(lib, 'site-workers.js');
const suite = join(root, 'scripts/test-list-path-corrupt-row.mjs');
const stub = join(root, 'scripts', 'test-stub-register.mjs');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const before = { module: hash(module), suite: hash(suite) };

const variants = [
  { id: 'worker-list-raw-parse',
    from: "    .map(row => parseRowRecord(row, { table: 'site_workers', key: 'parent_session', id: parentId }));",
    to: '    .map(row => JSON.parse(row.record));',
    failure: /FAIL the worker list reports a corrupt row with its table and parent/ },
];

try {
  for (const variant of variants) {
    const directory = mkdtempSync(join(boundary, `revcheck-list-corrupt-${variant.id}-`));
    try {
      const inside = relative(boundary, directory);
      assert(inside && !inside.startsWith('..') && !isAbsolute(inside), 'temporary directory escaped _ref/tmp');
      cpSync(lib, join(directory, 'plugins/dsh-redteam-results/lib'), { recursive: true });
      const target = join(directory, 'plugins/dsh-redteam-results/lib/site-workers.js');
      const source = readFileSync(module, 'utf8');
      assert.equal(source.split(variant.from).length - 1, 1, `${variant.id}: exact mutation anchor`);
      writeFileSync(target, source.replace(variant.from, variant.to));
      const runner = join(directory, 'test-list-path-corrupt-row.mjs');
      const copiedLib = join(directory, 'plugins/dsh-redteam-results/lib');
      writeFileSync(runner, readFileSync(suite, 'utf8')
        // 静态 import 的说明符必须是字符串字面量：逐个替换成副本的绝对 file URL。
        .replace(/'\.\.\/plugins\/dsh-redteam-results\/lib\/([a-z-]+\.js)'/g,
          (_match, name) => JSON.stringify(pathToFileURL(join(copiedLib, name)).href))
        .replace("'./test-home-isolation.mjs'", JSON.stringify(pathToFileURL(join(root, 'scripts', 'test-home-isolation.mjs')).href)));
      const result = spawnSync(process.execPath, ['--import', pathToFileURL(stub).href, runner], {
        cwd: root, encoding: 'utf8',
        env: { ...process.env, TEMP: boundary, TMP: boundary, TMPDIR: boundary },
      });
      assert.notEqual(result.status, 0, `${variant.id}: reverse suite must fail`);
      assert.match(`${result.stdout || ''}${result.stderr || ''}`, variant.failure, `${variant.id}: targeted assertion must fail`);
      console.log(`ok reverse ${variant.id}: targeted list-path assertion failed`);
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    }
  }
} finally {
  for (const [name, file] of Object.entries({ module, suite })) {
    assert.equal(hash(file), before[name], `${name} changed during reverse checks`);
  }
}
