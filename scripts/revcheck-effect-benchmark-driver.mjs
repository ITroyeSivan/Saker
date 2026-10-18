import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const boundary = resolve(root, '../_ref/tmp');
const driver = join(root, 'scripts/effect-benchmark-driver.mjs');
const suite = join(root, 'scripts/test-effect-benchmark-driver.mjs');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const before = { driver: hash(driver), suite: hash(suite) };

const variants = [
  { id: 'payload-wrapped-as-args', from: 'body: JSON.stringify({ type: \'client-request\', rpcId, method: endpoint, payload }),',
    to: 'body: JSON.stringify({ type: \'client-request\', rpcId, method: endpoint, payload: { args: payload } }),',
    failure: /FAIL the channel endpoint gets the plugin payload unwrapped/ },
  { id: 'method-sends-channel', from: 'method: endpoint, payload }),', to: 'method: channel, payload }),',
    failure: /FAIL the channel endpoint gets the plugin payload unwrapped/ },
  { id: 'rpcid-drift-accepted', from: "if (body.rpcId !== rpcId) throw new Error(`rpcId mismatch (protocol drift): sent ${rpcId}, got ${body.rpcId}`)",
    to: '',
    failure: /FAIL a mismatched rpcId is treated as protocol drift/ },
  { id: 'cookie-dropped', from: "headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },",
    to: "headers: { 'content-type': 'application/json' },",
    failure: /FAIL the channel endpoint gets the plugin payload unwrapped/ },
  { id: 'string-error-flattened', from: "    if (typeof result.error === 'string') throw new Error(`channel error: ${result.error}`)\n", to: '',
    failure: /FAIL a plain string error from the endpoint is shown verbatim/ },
];

try {
  for (const variant of variants) {
    const directory = mkdtempSync(join(boundary, `revcheck-effect-driver-${variant.id}-`));
    try {
      const inside = relative(boundary, directory);
      assert(inside && !inside.startsWith('..') && !isAbsolute(inside), 'temporary directory escaped _ref/tmp');
      const target = join(directory, 'effect-benchmark-driver.mjs');
      const source = readFileSync(driver, 'utf8');
      const hits = source.split(variant.from).length - 1;
      assert.equal(hits, 1, `${variant.id}: exact mutation anchor`);
      writeFileSync(target, source.replace(variant.from, variant.to));
      const runner = join(directory, 'test-effect-benchmark-driver.mjs');
      writeFileSync(runner, readFileSync(suite, 'utf8').replace(
        "'./effect-benchmark-driver.mjs'", JSON.stringify(pathToFileURL(target).href)));
      const result = spawnSync(process.execPath, [runner], {
        cwd: root, encoding: 'utf8',
        env: { ...process.env, TEMP: boundary, TMP: boundary, TMPDIR: boundary },
      });
      assert.notEqual(result.status, 0, `${variant.id}: reverse suite must fail`);
      assert.match(`${result.stdout || ''}${result.stderr || ''}`, variant.failure, `${variant.id}: targeted assertion must fail`);
      console.log(`ok reverse ${variant.id}: targeted driver assertion failed`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
} finally {
  for (const [name, file] of Object.entries({ driver, suite })) {
    assert.equal(hash(file), before[name], `${name} changed during reverse checks`);
  }
}
