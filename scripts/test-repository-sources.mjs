import './test-home-isolation.mjs';
import { removeGitFixture } from './lib/remove-git-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runSourceGit } from '../plugins/dsh-nday-hunter/lib/source-git.js';
import { fetchRepositoryPage } from '../plugins/dsh-nday-hunter/lib/repository-sources.js';
import { runCollector, writeCollectorConfig } from '../plugins/dsh-nday-hunter/lib/source-pipeline.js';
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-source-'));
const remote = path.join(temp, 'remote'); fs.mkdirSync(remote);
const git = args => runSourceGit(args, { cwd: remote });
await git(['init', '--initial-branch=main']);
function write(filename, body) { const file = path.join(remote, filename); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); }
async function commit(message) { await git(['add', '--all']); await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--no-verify', '-m', message]); return (await git(['rev-parse', 'HEAD'])).toString().trim(); }
write('01.md', 'Original ProductA CVE-2013-1001 source.');
write('02.md', 'x'.repeat(2500) + '\nneedle ProductB original request.');
write('03.md', 'Move this original disclosure without new vulnerability.');
write('template.yaml', 'id: template-a\ninfo:\n  name: fixture\n');
write('pocs/afrog-pocs/check.yaml', 'id: afrog-fixture\n');
write('ignore.exe', Buffer.from([0, 1, 2]));
const cveRecord = (id, state) => ({ dataType: 'CVE_RECORD', dataVersion: '5.2',
  cveMetadata: { cveId: id, state, datePublished: '2013-01-01T00:00:00Z', dateUpdated: '2026-09-30T00:00:00Z' },
  containers: { cna: { descriptions: [{ lang: 'en', value: 'original fixture' }], affected: [{ vendor: 'Fixture', product: 'Original' }], references: [] } } });
write('cves/2013/1xxx/CVE-2013-1001.json', JSON.stringify(cveRecord('CVE-2013-1001', 'PUBLISHED')));
write('cves/2026/1xxx/CVE-2026-1002.json', JSON.stringify(cveRecord('CVE-2026-1002', 'REJECTED')));
const firstCommit = await commit('initial sources');
let failureBlob = null;
const calls = [];
const runGit = async (args, options) => {
  calls.push(args);
  if (failureBlob && args.includes('cat-file') && (args.at(-1) === failureBlob || String(options.input).includes(failureBlob))) throw new Error('fixture blob unavailable');
  const mapped = args.map(arg => /^https:\/\/github\.com\/(Threekiii\/Awesome-POC|projectdiscovery\/nuclei-templates|zan8in\/afrog|CVEProject\/cvelistV5)\.git$/.test(arg) ? remote : arg);
  return runSourceGit(['-c', 'protocol.file.allow=always', ...mapped], options);
};
const deps = { runGit };
const window = { since: '2026-09-30T00:00:00.000Z', until: '2026-10-01T00:00:00.000Z', limit: 1 };
let failures = 0, first, finalCommit;
async function check(name, fn) { try { await fn(); console.log('ok   ' + name); } catch (error) { failures++; console.log('FAIL ' + name + ': ' + error.stack); } }
try {
  await check('research pagination reads original file bodies, searches beyond summary and binds a frozen commit across restart', async () => {
    const options = { ...window, query: 'needle', home: path.join(temp, 'research') };
    first = await fetchRepositoryPage('github-research-files', options, deps);
    assert.equal(first.rows.length, 0); assert.equal(first.complete, false);
    const count = calls.length;
    const second = await fetchRepositoryPage('github-research-files', { ...options, cursor: first.nextCursor }, deps);
    assert.equal(second.rows.length, 1); assert.equal(second.rows[0].repositoryFile.path, '02.md');
    assert.equal(second.rows[0].repositoryFile.commit, firstCommit);
    assert.equal(second.rows[0].published, ''); assert.equal(second.rows[0].repositoryFile.methodReady, false);
    assert(fs.readFileSync(second.rows[0].repositoryFile.contentFile, 'utf8').includes('needle'));
    assert(!calls.slice(count).some(args => args.includes('fetch') || args.includes('ls-remote')));
    await assert.rejects(fetchRepositoryPage('github-research-files', { ...options, query: 'changed', cursor: first.nextCursor }, deps), /changed/);
  });
  await check('collector persists failed page and only publishes source revision after every baseline page finishes', async () => {
    const home = path.join(temp, 'collector');
    writeCollectorConfig({ sources: ['github-research-files'], limit: 1, maxPagesPerRun: 1 }, home);
    const now = Date.parse(window.until);
    let result = await runCollector({}, { home, now, gitDeps: deps });
    assert.equal(result.ok, true); assert.equal(result.records.length, 1);
    assert.equal(result.checkpoints['github-research-files'].watermark, null);
    assert.equal(result.checkpoints['github-research-files'].revision, undefined);
    const frozenCursor = result.checkpoints['github-research-files'].window.cursor;
    failureBlob = (await git(['rev-parse', 'HEAD:02.md'])).toString().trim();
    result = await runCollector({}, { home, now: now + 1000, gitDeps: deps });
    assert.equal(result.ok, false); assert.equal(result.records.length, 1);
    assert.equal(result.checkpoints['github-research-files'].window.cursor, frozenCursor);
    assert.equal(result.checkpoints['github-research-files'].revision, undefined);
    failureBlob = null;
    // Remote advances while the unfinished baseline continues to use old objects.
    write('02.md', 'Updated source no longer contains search keyword.');
    fs.renameSync(path.join(remote, '03.md'), path.join(remote, 'moved.md'));
    fs.unlinkSync(path.join(remote, '01.md'));
    write('new.md', 'Actually added source.');
    finalCommit = await commit('move plus update and deletion');
    for (let step = 0; step < 20 && result.checkpoints['github-research-files'].window; step++)
      result = await runCollector({ noCache: true }, { home, now: now + 61000 + step, gitDeps: deps });
    assert.equal(result.ok, true);
    assert.equal(result.checkpoints['github-research-files'].revision, firstCommit);
    assert.equal(result.checkpoints['github-research-files'].window, null);
    assert(result.records.every(row => row.repositoryFile.commit === firstCommit));
    writeCollectorConfig({ sources: ['github-research-files'], limit: 1, maxPagesPerRun: 100 }, home);
    result = await runCollector({}, { home, now: now + 120000, gitDeps: deps });
    assert.equal(result.checkpoints['github-research-files'].revision, finalCommit);
    const moved = result.records.find(row => row.repositoryFile.path === 'moved.md');
    assert.equal(moved.repositoryFile.event, 'moved'); assert.equal(moved.repositoryFile.contentChanged, false);
    const old = result.records.find(row => row.repositoryFile.path === '03.md');
    assert.equal(old.status, 'removed-from-current-repository');
    assert.equal(old.repositoryFile.movedTo, 'moved.md');
    const removed = result.records.find(row => row.repositoryFile.path === '01.md');
    assert.equal(removed.status, 'removed-from-current-repository');
    assert(result.candidates.find(row => row.id === removed.id).requiresSourceReview);
  });
  await check('Nuclei and Afrog read separate actual YAML scopes with commit dates excluded from disclosure freshness', async () => {
    for (const source of ['nuclei-files', 'afrog-files']) {
      const result = await fetchRepositoryPage(source, { ...window, limit: 100, home: path.join(temp, source) }, deps);
      assert.equal(result.complete, true); assert.equal(result.completedRevision, finalCommit);
      assert.equal(result.rows.length, source === 'nuclei-files' ? 2 : 1);
      assert(result.rows.every(row => row.repositoryFile.contentAvailable && !row.repositoryFile.methodReady && row.published === ''));
      if (source === 'afrog-files') assert.equal(result.rows[0].repositoryFile.path, 'pocs/afrog-pocs/check.yaml');
    }
  });
  await check('official Git baseline recovers beyond rolling history and preserves rejection and original publication', async () => {
    const result = await fetchRepositoryPage('cve-official-git', { ...window, since: '2000-01-01T00:00:00.000Z', limit: 100, home: path.join(temp, 'cve') }, deps);
    assert.equal(result.complete, true); assert.equal(result.coverage, 'pinned-repository-current-baseline');
    assert.equal(result.rows.length, 2);
    assert.equal(result.rows[0].id, 'CVE-2013-1001');
    assert.equal(result.rows[0].published, '2013-01-01T00:00:00Z');
    assert.equal(result.rows[0].repositoryFile.event, 'baseline');
    assert.equal(result.rows[1].status, 'rejected'); assert.equal(result.rows[1].official.methodReady, false);
  });
  await check('snapshot and page cache tampering cannot silently consume or publish source revision', async () => {
    const home = path.join(temp, 'tamper');
    const result = await fetchRepositoryPage('github-research-files', { ...window, home }, deps);
    const state = JSON.parse(result.nextCursor), directory = path.join(home, 'nday-hunter/source-content/repository-pages');
    const file = path.join(directory, 'snapshot-' + state.digest + '.json'), bytes = fs.readFileSync(file);
    fs.writeFileSync(file, '{}');
    try { await assert.rejects(fetchRepositoryPage('github-research-files', { ...window, home, cursor: result.nextCursor }, deps), /digest mismatch/); }
    finally { fs.writeFileSync(file, bytes); }
    const snapshot = JSON.parse(bytes), chunk = path.join(directory, 'chunk-' + snapshot.chunks[1] + '.json');
    fs.writeFileSync(chunk, '[]');
    await assert.rejects(fetchRepositoryPage('github-research-files', { ...window, home, cursor: result.nextCursor }, deps), /digest mismatch/);
  });
  await check('unindexed encoding and oversized content remain explicit coverage gaps and require source review', async () => {
    write('bad.md', Buffer.from([255, 0])); write('large.md', 'x'.repeat(2 * 1024 * 1024 + 1));
    await commit('add explicit content gaps');
    const home = path.join(temp, 'gaps');
    writeCollectorConfig({ sources: ['github-research-files'], limit: 100, maxPagesPerRun: 5 }, home);
    const result = await runCollector({}, { home, now: Date.parse(window.until), gitDeps: deps });
    assert.equal(result.ok, true); assert.equal(result.sources[0].complete, true);
    assert.equal(result.sources[0].contentGaps, 2);
    const rows = result.records.filter(row => row.status === 'content-not-indexed');
    assert.equal(rows.length, 2);
    assert.equal(rows.find(row => row.repositoryFile.path === 'bad.md').repositoryFile.encodingGap, 'not-valid-utf8');
    assert.equal(rows.find(row => row.repositoryFile.path === 'large.md').repositoryFile.contentAvailable, false);
    assert(result.candidates.filter(row => rows.some(gap => gap.id === row.id)).every(row => row.requiresSourceReview));
  });
  await check('official records above 2 MiB are read intact while the 8 MiB bound remains enforced', async () => {
    const large = cveRecord('CVE-2026-1003', 'PUBLISHED');
    large.containers.cna.descriptions[0].value = 'x'.repeat(2 * 1024 * 1024 + 1);
    write('cves/2026/1xxx/CVE-2026-1003.json', JSON.stringify(large));
    const oversized = cveRecord('CVE-2026-1004', 'PUBLISHED');
    oversized.containers.cna.descriptions[0].value = 'x'.repeat(8 * 1024 * 1024 + 1);
    write('cves/2026/1xxx/CVE-2026-1004.json', JSON.stringify(oversized));
    await commit('bounded large official records');
    const result = await fetchRepositoryPage('cve-official-git', { ...window, limit: 100, home: path.join(temp, 'large-cve') }, deps);
    const record = result.rows.find(row => row.id === large.cveMetadata.cveId);
    assert.equal(record.repositoryFile.contentAvailable, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(record.repositoryFile.contentFile, 'utf8')), large);
    assert.equal(result.rows.find(row => row.id === oversized.cveMetadata.cveId).repositoryFile.contentAvailable, false);
    assert.equal(result.unreadable, 1);
  });
} finally { removeGitFixture(temp); }
process.exitCode = failures ? 1 : 0;
