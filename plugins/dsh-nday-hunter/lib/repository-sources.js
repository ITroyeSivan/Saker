import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pinnedRepositorySnapshot, readRepositoryBlobs, immutableSourceFile } from './source-git.js';
import { sourceCandidate, matchesQuery } from './free-sources.js';
import { officialRecord, OFFICIAL_CVE_MAX_BYTES } from './cve-official.js';
import { resolveDshHome } from './home.js';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fileIdentity = filename => 'file:' + sha256(filename);
export const REPOSITORY_SOURCES = Object.freeze({
  'github-research-files': { repository: 'Threekiii/Awesome-POC', kind: 'research-project', author: 'Threekiii',
    matches: filename => /\.(md|txt|py|go|js|java|yaml|yml|json)$/i.test(filename),
    detail: '公开汇编项目，仅作为原始材料；产品条件、原始作者与方法仍须逐项审阅。' },
  'nuclei-files': { repository: 'projectdiscovery/nuclei-templates', kind: 'template', author: 'projectdiscovery',
    matches: filename => /\.ya?ml$/i.test(filename), detail: '公开模板正文及固定提交；不是已确认漏洞或可直接执行方法。' },
  'afrog-files': { repository: 'zan8in/afrog', kind: 'template', author: 'zan8in',
    matches: filename => /^pocs\/afrog-pocs\/.*\.ya?ml$/i.test(filename), detail: '仅公开内置PoC目录；不覆盖加密精选库。' },
  'cve-official-git': { repository: 'CVEProject/cvelistV5', kind: 'official-record', author: 'CVEProject',
    matches: filename => /^cves\/\d{4}\/\d+xxx\/CVE-\d{4}-\d{4,}\.json$/.test(filename), detail: '官方当前完整文件树基线与文件差异；不依赖滚动日志保留期。' },
});
function storage(home) { return path.join(home, 'nday-hunter', 'source-content', 'repository-pages'); }
function readHashed(file, digest) {
  const bytes = fs.readFileSync(file);
  if (sha256(bytes) !== digest) throw new Error('Repository page cache digest mismatch');
  return JSON.parse(bytes);
}
export async function fetchRepositoryPage(source, options, deps = {}) {
  const descriptor = REPOSITORY_SOURCES[source] ?? options.repositoryDescriptor;
  if (!descriptor) throw new Error('Repository source is not registered');
  const maxBytes = source === 'cve-official-git' ? OFFICIAL_CVE_MAX_BYTES : 2 * 1024 * 1024;
  const { since, until, query = '', limit = 50, cursor = null, revision = null, home = resolveDshHome() } = options;
  if (!Number.isFinite(Date.parse(since)) || !Number.isFinite(Date.parse(until)) || Date.parse(since) > Date.parse(until)
    || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid repository source window or page size');
  let state;
  if (cursor === null) {
    const snapshot = await pinnedRepositorySnapshot({ repository: descriptor.repository, home, previousCommit: revision }, deps);
    const selected = snapshot.changes.filter(row => descriptor.matches(row.path)
      || (row.previousPath && descriptor.matches(row.previousPath)));
    const chunks = [];
    for (let index = 0; index < selected.length; index += limit) {
      const bytes = Buffer.from(JSON.stringify(selected.slice(index, index + limit))), digest = sha256(bytes);
      immutableSourceFile(path.join(storage(home), 'chunk-' + digest + '.json'), bytes);
      chunks.push(digest);
    }
    const bytes = Buffer.from(JSON.stringify({ schema: 'saker.repository-pages/1', source, repository: descriptor.repository,
      commit: snapshot.commit, previousCommit: revision, committedAt: snapshot.committedAt, since, until, query, limit,
      total: selected.length, treeFiles: snapshot.tree.length, chunks }));
    const digest = sha256(bytes);
    immutableSourceFile(path.join(storage(home), 'snapshot-' + digest + '.json'), bytes);
    state = { digest, page: 0 };
  } else { try { state = JSON.parse(cursor); } catch { throw new Error('Invalid repository source cursor'); } }
  if (!state || !/^[a-f0-9]{64}$/.test(state.digest || '') || !Number.isSafeInteger(state.page) || state.page < 0) throw new Error('Invalid repository source cursor');
  const snapshot = readHashed(path.join(storage(home), 'snapshot-' + state.digest + '.json'), state.digest);
  if (snapshot.schema !== 'saker.repository-pages/1' || snapshot.source !== source || snapshot.repository !== descriptor.repository
    || snapshot.since !== since || snapshot.until !== until || snapshot.query !== query || snapshot.limit !== limit
    || snapshot.previousCommit !== revision || state.page >= Math.max(1, snapshot.chunks.length)) throw new Error('Repository cursor changed its source window or selection');
  const chunk = snapshot.chunks[state.page];
  const changes = chunk ? readHashed(path.join(storage(home), 'chunk-' + chunk + '.json'), chunk) : [];
  const contentRows = changes.filter(row => row.type === 'blob' && ['100644', '100755'].includes(row.mode) && row.size <= maxBytes);
  const contents = await readRepositoryBlobs({ repository: descriptor.repository, home, rows: contentRows, maxBytes }, deps);
  const rows = [];
  let unreadable = 0;
  for (const change of changes) {
    const cveId = source === 'cve-official-git' ? /\/(CVE-(\d{4})-(\d{4,}))\.json$/.exec(change.path) : null;
    if (source === 'cve-official-git' && (!cveId || change.path !== `cves/${cveId[2]}/${cveId[3].slice(0, -3)}xxx/${cveId[1]}.json`)) throw new Error('Official CVE Git file path is inconsistent with its identity');
    const url = `https://github.com/${descriptor.repository}/blob/${snapshot.commit}/${change.path.split('/').map(encodeURIComponent).join('/')}`;
    const metadata = { repository: descriptor.repository, author: descriptor.author, kind: descriptor.kind, commit: snapshot.commit,
      previousCommit: snapshot.previousCommit, path: change.path, previousPath: change.previousPath || '', blob: change.blob,
      previousBlob: change.previousBlob || '', event: revision === null ? 'baseline' : change.event,
      contentChanged: change.contentChanged, sourceCommittedAt: snapshot.committedAt, methodReady: false };
    let row, searchText = change.path;
    if (change.type !== 'blob' || !['100644', '100755'].includes(change.mode) || change.size > maxBytes) {
      unreadable++;
      row = { ...sourceCandidate(source, { id: cveId?.[1] ?? fileIdentity(change.path), title: change.path, url, status: change.event === 'removed' ? 'removed-from-current-repository' : 'content-not-indexed' }),
        repositoryFile: { ...metadata, contentAvailable: false, reason: 'non-regular-or-oversized' } };
    } else {
      const content = contents.get(change.blob);
      if (source === 'cve-official-git') {
        const id = cveId[1];
        let data; try { data = JSON.parse(content.bytes.toString('utf8')); } catch { throw new Error('Official CVE Git file is not JSON'); }
        searchText += ' ' + content.bytes.toString('utf8');
        row = { ...officialRecord(data, id, snapshot.commit, content.contentFile, content.sha256,
          { sourcePath: change.path, event: metadata.event, sourceChangedAt: snapshot.committedAt }), source };
      } else {
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(content.bytes); }
        catch { unreadable++; text = ''; metadata.encodingGap = 'not-valid-utf8'; }
        searchText += ' ' + text;
        // A commit date and a CVE/year in a filename never establish disclosure time.
        row = sourceCandidate(source, { id: fileIdentity(change.path), title: change.path, summary: text, url,
          sourceKind: descriptor.kind, published: '', modified: '', status: metadata.encodingGap ? 'content-not-indexed' : 'pending-source-review' });
      }
      row.repositoryFile = { ...metadata, contentAvailable: true, contentFile: content.contentFile, sha256: content.sha256 };
      if (change.event === 'removed') row.status = 'removed-from-current-repository';
    }
    // Consume source pages regardless of local filter membership. Removal/move
    // events remain visible so a changed title cannot strand an old candidate.
    if (change.event === 'removed' || change.event === 'moved' || change.event === 'modified' || matchesQuery(searchText, query)) rows.push(row);
    if (source !== 'cve-official-git' && change.event === 'moved' && descriptor.matches(change.previousPath)) rows.push({ ...row, id: fileIdentity(change.previousPath),
      title: change.previousPath, status: 'removed-from-current-repository', repositoryFile: { ...row.repositoryFile, path: change.previousPath, movedTo: change.path } });
  }
  const complete = state.page + 1 >= snapshot.chunks.length;
  return { rows, complete, nextCursor: complete ? null : JSON.stringify({ digest: state.digest, page: state.page + 1 }),
    completedRevision: complete ? snapshot.commit : undefined, total: snapshot.total,
    coverage: revision === null ? 'pinned-repository-current-baseline' : 'pinned-repository-file-difference',
    unreadable, limitation: descriptor.detail + ' 提交时间只表示来源更新；未索引的链接或超大文件另列缺口，未自动执行来源代码。' };
}
