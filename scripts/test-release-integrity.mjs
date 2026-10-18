// 发布目录完整性：`packages.json` 里记的 sha256 必须与盘上的字节一致。
//
// 为什么值得进回归：
//   ① 隔离评测的**冻结组**就是从 `dist/releases/Saker-0.4.92-desktop` 装的
//      （`_ref/tools/effect-isolated-home.mjs --from-release`）—— 那份字节一旦被悄悄改过，
//      "冻结基线"就不再是冻结的，三组对照也就失去意义；
//   ② 这些目录是发布物，用户下载后按 `packages.json` 校验；清单与字节不一致等于校验形同虚设。
//
// 只读检查：只算 sha256，不改任何文件。`dist/releases` 不存在时明确跳过。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 反向检查要能把"发布目录"指到一份被改坏的副本上，所以留一个显式覆盖口。
const releases = resolve(process.env.SAKER_RELEASES_DIR ?? join(root, 'dist', 'releases'));
const FROZEN = 'Saker-0.4.92-desktop';

if (!existsSync(releases)) {
  console.log('ok skipped: dist/releases is not present in this checkout; release integrity was not checked');
  process.exit(0);
}

const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const dirs = readdirSync(releases, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && /^Saker-.*-desktop$/.test(entry.name))
  .map(entry => entry.name)
  .sort();
assert(dirs.length > 0, 'expected at least one release directory under dist/releases');

let checked = 0;
const failures = [];
const brokenRefs = [];
let frozen = null;
for (const name of dirs) {
  const directory = join(releases, name);
  const manifestPath = join(directory, 'packages.json');
  assert(existsSync(manifestPath), `${name}: packages.json missing`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert(Array.isArray(manifest) && manifest.length > 0, `${name}: packages.json must list artifacts`);
  const rootEntry = manifest.find(entry => entry.name === 'dsh-saker');
  assert(rootEntry, `${name}: manifest must list the root dsh-saker package`);
  for (const entry of manifest) {
    const artifact = join(directory, entry.artifact);
    assert(existsSync(artifact), `${name}: artifact listed but missing on disk: ${entry.artifact}`);
    if (sha256(artifact) !== entry.sha256) failures.push(`${name}/${entry.artifact}`);
    checked++;
  }
  // 交付说明里引用的图片必须在包内：清单对得上、图却是坏图，用户下载后照样看不懂。
  const readmePath = join(directory, 'README.md');
  if (existsSync(readmePath)) {
    const readme = readFileSync(readmePath, 'utf8');
    for (const ref of new Set([...readme.matchAll(/docs\/media\/[A-Za-z0-9._-]+/g)].map(match => match[0]))) {
      if (!existsSync(join(directory, ref))) brokenRefs.push(`${name}/${ref}`);
    }
  }
  if (name === FROZEN) {
    // 冻结基线的**一个**摘要：把 (artifact, sha256) 排序后哈希，便于在证据里引用一行。
    const digest = createHash('sha256')
      .update(manifest.map(entry => `${entry.artifact}:${entry.sha256}`).sort().join('\n'))
      .digest('hex');
    frozen = { rootTgz: rootEntry.artifact, rootSha256: rootEntry.sha256, packages: manifest.length, digest };
  }
}

assert.deepEqual(failures, [], `release manifests disagree with the bytes on disk: ${failures.join(', ')}`);
assert.deepEqual(brokenRefs, [], `release README references media that is not shipped: ${brokenRefs.join(', ')}`);
assert(frozen, `the frozen matrix baseline ${FROZEN} must be present`);
console.log(`ok ${dirs.length} release directories verified, ${checked} artifacts match their recorded sha256`);
console.log(`ok frozen matrix baseline ${FROZEN}: ${frozen.rootTgz} sha256=${frozen.rootSha256} packages=${frozen.packages} digest=${frozen.digest}`);
