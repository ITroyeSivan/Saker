import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const boundary = resolve(root, '../_ref/tmp');
const module = join(root, 'plugins/dsh-nday-hunter/lib/atomic-write.js');
const plugin = join(root, 'plugins/dsh-nday-hunter/lib/index.js');
const suite = join(root, 'scripts/test-atomic-write.mjs');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const before = { module: hash(module), plugin: hash(plugin), suite: hash(suite) };

// Wiring lock: the two read-modify-write whole-file sites must go through the helper.
const pluginSource = readFileSync(plugin, 'utf8');
assert.match(pluginSource, /import \{ writeFileAtomicSync \} from '\.\/atomic-write\.js'/);
assert.equal(pluginSource.split('writeFileAtomicSync(').length - 1, 2, 'exactly the priority policy and the attack progress writes must use the helper');
assert.match(pluginSource, /writeFileAtomicSync\(file, JSON\.stringify\(next/, 'priority policy write must be atomic');
assert.match(pluginSource, /writeFileAtomicSync\(progressFile, JSON\.stringify\(result\.progress/, 'attack progress write must be atomic');
assert.doesNotMatch(pluginSource, /fs\.writeFileSync\(progressFile/, 'the progress file must not be written in place');
assert.doesNotMatch(pluginSource, /fs\.writeFileSync\(file, JSON\.stringify\(next/, 'the policy file must not be written in place');
console.log('ok wiring atomic whole-file writes');

const variants = [
  { id: 'direct-overwrite', from: 'io.renameSync(temporary, file)', to: 'io.writeFileSync(file, data, encoding)',
    failure: /FAIL writes a temporary file in the target directory and then renames it/ },
  { id: 'cross-volume-temp', from: 'const temporary = path.join(path.dirname(file),', to: 'const temporary = path.join(path.dirname(path.dirname(file)),',
    failure: /FAIL writes a temporary file in the target directory and then renames it/ },
  { id: 'leftover-temporary', from: 'try { io.unlinkSync(temporary) } catch { /* 临时文件可能根本没建起来 */ }', to: 'void 0',
    failure: /FAIL a failed rename keeps the previous file and cleans the temporary/ },
];

try {
  for (const variant of variants) {
    const directory = mkdtempSync(join(boundary, `revcheck-atomic-write-${variant.id}-`));
    try {
      const inside = relative(boundary, directory);
      assert(inside && !inside.startsWith('..') && !isAbsolute(inside), 'temporary directory escaped _ref/tmp');
      const target = join(directory, 'atomic-write.js');
      const source = readFileSync(module, 'utf8');
      assert.equal(source.split(variant.from).length - 1, 1, `${variant.id}: exact mutation anchor`);
      writeFileSync(target, source.replace(variant.from, variant.to));
      const runner = join(directory, 'test-atomic-write.mjs');
      writeFileSync(runner, readFileSync(suite, 'utf8').replace(
        "'../plugins/dsh-nday-hunter/lib/atomic-write.js'", JSON.stringify(pathToFileURL(target).href)));
      const result = spawnSync(process.execPath, [runner], {
        cwd: root, encoding: 'utf8',
        env: { ...process.env, TEMP: boundary, TMP: boundary, TMPDIR: boundary, SAKER_TEST_WORKSPACE: resolve(root, '..') },
      });
      assert.notEqual(result.status, 0, `${variant.id}: reverse suite must fail`);
      assert.match(`${result.stdout || ''}${result.stderr || ''}`, variant.failure, `${variant.id}: targeted assertion must fail`);
      console.log(`ok reverse ${variant.id}: targeted atomicity assertion failed`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
} finally {
  for (const [name, file] of Object.entries({ module, plugin, suite })) {
    assert.equal(hash(file), before[name], `${name} changed during reverse checks`);
  }
}
