import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomicSync } from '../plugins/dsh-nday-hunter/lib/atomic-write.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
// 反向检查会把本套件复制到 _ref/tmp 下再跑，那时 root 不再是仓库；工作区路径由环境变量显式给出。
const workspace = resolve(process.env.SAKER_TEST_WORKSPACE ?? join(root, '..'));
const boundary = join(workspace, '_ref', 'tmp');
const directory = mkdtempSync(join(boundary, 'atomic-write-'));
let failed = 0;
function test(label, fn) { try { fn(); console.log('ok ' + label); } catch (error) { failed++; console.log('FAIL ' + label + ': ' + error.stack); } }

function ioRecorder(overrides = {}) {
  const calls = [];
  return {
    calls,
    writeFileSync: (file, data, encoding) => { calls.push(['write', file, data, encoding]); },
    renameSync: (from, to) => { calls.push(['rename', from, to]); },
    unlinkSync: file => { calls.push(['unlink', file]); },
    ...overrides,
  };
}

try {
  const inside = relative(boundary, directory);
  assert(inside && !inside.startsWith('..') && !isAbsolute(inside), 'fixture directory escaped _ref/tmp');

  test('writes then replaces the whole file without leaving temporary files', () => {
    const target = join(directory, 'policy.json');
    writeFileAtomicSync(target, 'first\n');
    assert.equal(readFileSync(target, 'utf8'), 'first\n');
    writeFileAtomicSync(target, 'second\n');
    assert.equal(readFileSync(target, 'utf8'), 'second\n');
    assert.deepEqual(readdirSync(directory), ['policy.json'], 'temporary files must not survive');
  });

  test('writes a temporary file in the target directory and then renames it', () => {
    const io = ioRecorder();
    const target = join(directory, 'gate.json');
    writeFileAtomicSync(target, '{"a":1}\n', { fs: io, encoding: 'utf8' });
    assert.deepEqual(io.calls.map(call => call[0]), ['write', 'rename'], 'must write a temporary file before replacing the target');
    const [, temporary, data, encoding] = io.calls[0];
    assert.equal(data, '{"a":1}\n');
    assert.equal(encoding, 'utf8');
    assert.notEqual(temporary, target, 'the target must never be the file that is being written');
    assert.equal(dirname(temporary), dirname(target), 'the temporary file must sit next to the target so the rename stays on one volume');
    assert(basename(temporary).startsWith('.' + basename(target)), 'the temporary name must derive from the target name');
    assert.equal(io.calls[1][1], temporary, 'the rename must move the temporary file');
    assert.equal(io.calls[1][2], target, 'the rename destination must be the target');
  });

  test('a failed rename keeps the previous file and cleans the temporary', () => {
    const target = join(directory, 'keep.json');
    writeFileAtomicSync(target, 'old\n');
    const io = ioRecorder({ renameSync: () => { throw new Error('rename failed'); } });
    assert.throws(() => writeFileAtomicSync(target, 'new\n', { fs: io }), /rename failed/);
    assert.equal(readFileSync(target, 'utf8'), 'old\n', 'the previous content must survive a failed replace');
    assert.equal(io.calls.at(-1)[0], 'unlink', 'the temporary file must be cleaned up after a failure');
    assert.equal(io.calls.at(-1)[1], io.calls[0][1], 'cleanup must target the temporary file that was written');
  });

  test('a failed write propagates and never opens the target for writing', () => {
    const target = join(directory, 'untouched.json');
    writeFileAtomicSync(target, 'old\n');
    const written = [];
    const io = ioRecorder({
      writeFileSync: file => { written.push(file); throw new Error('disk full'); },
    });
    assert.throws(() => writeFileAtomicSync(target, 'new\n', { fs: io }), /disk full/);
    assert.equal(readFileSync(target, 'utf8'), 'old\n');
    assert.equal(written.includes(target), false, 'the target must not be opened directly');
  });

  test('temporary names do not collide between successive writes', () => {
    const seen = [];
    const io = ioRecorder({ writeFileSync: file => { seen.push(file); } });
    writeFileAtomicSync(join(directory, 'x.json'), 'a', { fs: io });
    writeFileAtomicSync(join(directory, 'x.json'), 'b', { fs: io });
    assert.notEqual(seen[0], seen[1]);
    assert.equal(new Set(seen).size, 2);
  });
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log('Fixture verification only: no plugin tool, host or model is started.');
process.exitCode = failed ? 1 : 0;
