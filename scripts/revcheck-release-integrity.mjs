// 反向检查：把发布目录做坏，要求 test-release-integrity.mjs 必须失败。
//
// 为什么需要：那条套件断言的是"清单里的 sha256 与盘上字节一致 + 冻结基线在场"。
// 如果它只是"跑完总是绿"，那它对"冻结基线被悄悄改过"这件事毫无作用。
// 这里用**合成**的发布目录（不复制 85 MB 真实发布物）逐个注入坏形态。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const boundary = resolve(root, '..', '_ref', 'tmp');
const suite = join(root, 'scripts', 'test-release-integrity.mjs');
const sha = value => createHash('sha256').update(value).digest('hex');

/** 造一个发布目录：root 包 + 一个插件包，清单可指定故意写错的 sha256 或缺失产物。 */
function buildRelease(directory, name, { rootBody = 'root-tarball', pluginBody = 'plugin-tarball', breakSha = false, omitArtifact = false, missingMedia = false } = {}) {
  const dir = join(directory, name);
  mkdirSync(dir, { recursive: true });
  const manifest = [];
  for (const [pkg, version, artifact, body] of [
    ['dsh-saker', '0.0.1', 'dsh-saker-0.0.1.tgz', rootBody],
    ['@dsh-external/dsh-fixture', '1.0.0', 'dsh-external-dsh-fixture-1.0.0.tgz', pluginBody],
  ]) {
    if (!omitArtifact || pkg === 'dsh-saker') writeFileSync(join(dir, artifact), body);
    manifest.push({ name: pkg, version, artifact, sha256: breakSha && pkg === 'dsh-saker' ? sha('something-else') : sha(body) });
  }
  writeFileSync(join(dir, 'packages.json'), JSON.stringify(manifest, null, 2));
  if (missingMedia) writeFileSync(join(dir, 'README.md'), '![x](docs/media/not-shipped.png)\n');
  return dir;
}

const variants = [
  { id: 'mismatched-sha', setup: dir => buildRelease(dir, 'Saker-0.0.1-desktop', { breakSha: true }),
    failure: /release manifests disagree with the bytes on disk/ },
  { id: 'missing-artifact', setup: dir => buildRelease(dir, 'Saker-0.0.1-desktop', { omitArtifact: true }),
    failure: /artifact listed but missing on disk/ },
  { id: 'frozen-baseline-absent', setup: dir => buildRelease(dir, 'Saker-0.0.1-desktop'),
    failure: /frozen matrix baseline/ },
  { id: 'missing-readme-media', setup: dir => buildRelease(dir, 'Saker-0.0.1-desktop', { missingMedia: true }),
    failure: /references media that is not shipped/ },
];

let failures = 0;
for (const variant of variants) {
  const directory = mkdtempSync(join(boundary, `revcheck-release-integrity-${variant.id}-`));
  try {
    const inside = relative(boundary, directory);
    assert(inside && !inside.startsWith('..') && !isAbsolute(inside), 'temporary directory escaped _ref/tmp');
    variant.setup(directory);
    const result = spawnSync(process.execPath, [suite], {
      cwd: root, encoding: 'utf8', timeout: 60000,
      env: { ...process.env, TEMP: boundary, TMP: boundary, TMPDIR: boundary, SAKER_RELEASES_DIR: directory },
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    try {
      assert.notEqual(result.status, 0, `${variant.id}: the broken release must make the suite fail`);
      assert.match(output, variant.failure, `${variant.id}: the targeted assertion must fail`);
      console.log(`ok reverse ${variant.id}: the release-integrity suite caught it`);
    } catch (error) {
      failures++;
      console.log(`FAIL reverse ${variant.id}: ${error.message}`);
      console.log(output.split('\n').slice(-10).join('\n'));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

process.exitCode = failures ? 1 : 0;
