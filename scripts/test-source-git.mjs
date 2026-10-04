import './test-home-isolation.mjs';
import { removeGitFixture } from './lib/remove-git-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runSourceGit, pinnedRepositorySnapshot, readRepositoryBlob, readRepositoryBlobs, publicRepository } from '../plugins/dsh-nday-hunter/lib/source-git.js';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-git-'));
const remote = path.join(temp, 'remote'), home = path.join(temp, 'home');
fs.mkdirSync(remote);
const git = args => runSourceGit(args, { cwd: remote });
await git(['init', '--initial-branch=main']);
function write(filename, body) { const file = path.join(remote, filename); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); }
async function commit(message) { await git(['add', '--all']); await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--no-verify', '-m', message]); }
write('old/method.md', '# CVE-2020-1234\nOriginal request and dependency conditions.\n');
write('modify.yaml', 'id: original\nrequest: normal\n');
write('remove.md', 'remove this prior source');
write('代码/示例.js', 'throw new Error("source-only; never execute")');
await commit('initial fixture');
const repository = 'Fixture/Knowledge';
const requests = [];
const runGit = async (args, options) => {
  requests.push(args);
  return runSourceGit(['-c', 'protocol.file.allow=always', ...args.map(arg => arg === 'https://github.com/Fixture/Knowledge.git' ? remote : arg)], options);
};
const deps = { runGit };
let failures = 0, first, next;
async function check(name, fn) { try { await fn(); console.log('ok   ' + name); } catch (error) { failures++; console.log('FAIL ' + name + ': ' + error.stack); } }
try {
  await check('actual Git baseline pins HEAD, reads every file and stores original bytes without checkout or execution', async () => {
    first = await pinnedRepositorySnapshot({ repository, home }, deps);
    assert.equal(first.tree.length, 4);
    assert.equal(first.changes.length, 4);
    assert(first.changes.every(row => row.event === 'added'));
    assert.equal(first.tree.find(row => row.path === '代码/示例.js').type, 'blob');
    const row = first.tree.find(row => row.path === 'old/method.md');
    const content = await readRepositoryBlob({ repository, home, row }, deps);
    assert.equal(content.bytes.toString(), fs.readFileSync(path.join(remote, row.path), 'utf8'));
    assert(fs.readFileSync(content.contentFile).equals(content.bytes));
    assert.match(first.commit, /^[a-f0-9]{40}$/);
    assert(requests.some(args => args.includes('fetch') && args.at(-1) === first.commit));
    assert(!fs.existsSync(path.join(home, 'old/method.md')));
    await assert.rejects(pinnedRepositorySnapshot({ repository, home }, { runGit: (args, options) =>
      args.includes('rev-parse') && args.includes('--verify') ? Promise.resolve(Buffer.from('b'.repeat(40))) : runGit(args, options) }), /Fetched source commit differs/);
  });
  await check('tree difference separates original content move from modification, new file and deletion', async () => {
    fs.mkdirSync(path.join(remote, 'new'));
    fs.renameSync(path.join(remote, 'old/method.md'), path.join(remote, 'new/method.md'));
    write('modify.yaml', 'id: original\nrequest: changed\n');
    write('added.md', '# New source\n');
    fs.unlinkSync(path.join(remote, 'remove.md'));
    await commit('restructure with actual changes');
    next = await pinnedRepositorySnapshot({ repository, home, previousCommit: first.commit }, deps);
    assert.notEqual(next.commit, first.commit);
    assert.equal(next.changes.length, 4);
    const moved = next.changes.find(row => row.path === 'new/method.md');
    assert.equal(moved.event, 'moved'); assert.equal(moved.contentChanged, false); assert.equal(moved.previousPath, 'old/method.md');
    assert.equal(next.changes.find(row => row.path === 'modify.yaml').event, 'modified');
    assert.equal(next.changes.find(row => row.path === 'added.md').event, 'added');
    assert.equal(next.changes.find(row => row.path === 'remove.md').event, 'removed');
    assert(!next.changes.some(row => row.path === '代码/示例.js'));
    const oldBytes = await readRepositoryBlob({ repository, home, row: first.tree.find(row => row.path === 'modify.yaml') }, deps);
    assert.match(oldBytes.bytes.toString(), /request: normal/);
  });
  await check('restart with same pinned tree yields no false updates and network failure preserves prior blobs', async () => {
    const unchanged = await pinnedRepositorySnapshot({ repository, home, previousCommit: next.commit }, deps);
    assert.equal(unchanged.changes.length, 0);
    write('not-yet-fetched.md', 'new upstream content');
    await commit('advance uncached upstream commit');
    await assert.rejects(pinnedRepositorySnapshot({ repository, home, previousCommit: next.commit }, { runGit: async (args, options) => {
      if (args.includes('fetch')) throw new Error('fixture disconnected'); return runGit(args, options);
    } }), /disconnected/);
    const saved = await readRepositoryBlob({ repository, home, row: first.tree.find(row => row.path === 'old/method.md') }, deps);
    assert.match(saved.bytes.toString(), /Original request/);
  });
  await check('bounded object reader rejects links, submodules, size mismatch and changed cached bytes', async () => {
    const row = first.tree.find(row => row.path === 'old/method.md');
    for (const change of [{ mode: '120000' }, { mode: '160000', type: 'commit' }, { size: -1 }, { size: 3000000 }])
      await assert.rejects(readRepositoryBlob({ repository, home, row: { ...row, ...change } }, deps), /bounded regular file/);
    await assert.rejects(readRepositoryBlob({ repository, home, row: { ...row, size: row.size - 1 } }, deps), /differs from pinned/);
    const content = await readRepositoryBlob({ repository, home, row }, deps);
    fs.writeFileSync(content.contentFile, 'tampered');
    try { await assert.rejects(readRepositoryBlob({ repository, home, row }, deps), /Immutable source cache differs/); }
    finally { fs.writeFileSync(content.contentFile, content.bytes); }
  });
  await check('unregistered URL syntax and option injection cannot reach Git process', async () => {
    const count = requests.length;
    for (const value of ['https://github.com/owner/repo', '../repo', 'owner/--upload-pack=evil', 'owner/repo@token', 'owner/repo?x=y'])
      assert.throws(() => publicRepository(value), /Invalid public/);
    await assert.rejects(pinnedRepositorySnapshot({ repository, home, previousCommit: '--help' }, deps), /previous/);
    assert.equal(requests.length, count);
  });
  await check('one Git batch reads pinned byte counts and refuses corrupted content, headers and extra output', async () => {
    const rows = first.tree.slice(0, 2), count = requests.length;
    const contents = await readRepositoryBlobs({ repository, home, rows }, deps);
    assert.equal(contents.size, 2); assert.equal(requests.length, count + 1);
    for (const corruption of ['bytes', 'header', 'extra']) await assert.rejects(readRepositoryBlobs({ repository, home, rows }, { runGit: async (args, options) => {
      const bytes = await runGit(args, options);
      if (corruption === 'extra') return Buffer.concat([bytes, Buffer.from('extra')]);
      const copy = Buffer.from(bytes); copy[corruption === 'header' ? 0 : copy.indexOf(10) + 1] ^= 1; return copy;
    } }), /differs from pinned|unexpected trailing/);
  });
} finally { removeGitFixture(temp); }
process.exitCode = failures ? 1 : 0;
