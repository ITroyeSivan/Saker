// Read pinned Git objects without checking out or executing repository code.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
const commitPattern = /^[a-f0-9]{40}$/;
export function publicRepository(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(value)
    || value.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid public GitHub repository');
  return value;
}
export async function runSourceGit(args, { cwd, maxBytes = 1024 * 1024, timeoutMs = 60000, input } = {}) {
  if (input !== undefined && Buffer.byteLength(input) > 1024 * 1024) throw new Error('Git source input exceeds byte limit');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' });
  const operation = args.find(value => ['init', 'fetch', 'ls-tree', 'ls-remote', 'cat-file', 'rev-parse', 'update-ref', 'show'].includes(value)) || 'command';
  return await new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', 'credential.helper=', '-c', 'core.hooksPath=' + (process.platform === 'win32' ? 'NUL' : '/dev/null'),
      '-c', 'init.templateDir=', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'gc.auto=0', ...args],
    { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = [], errors = []; let size = 0, errorSize = 0, failure;
    let stopping = false;
    const stop = () => {
      if (stopping || !child.pid || child.exitCode !== null) return;
      stopping = true;
      if (process.platform === 'win32') {
        // The PID comes directly from this live spawn; terminate only its tree.
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', env });
        killer.on('error', () => child.kill());
      } else child.kill();
    };
    const timer = setTimeout(() => { failure = new Error(`Git source ${operation} timed out`); stop(); }, timeoutMs);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { failure = new Error('Git source output exceeds byte limit'); stop(); }
      else chunks.push(chunk);
    });
    child.stderr.on('data', chunk => { if (errorSize < 65536) errors.push(chunk.subarray(0, 65536 - errorSize)); errorSize += chunk.length; });
    child.on('error', error => { failure = error.code === 'ENOENT' ? new Error('Git is required for pinned repository sources') : error; });
    child.stdin.on('error', () => {}); // Spawn/exit failure is reported by close.
    child.stdin.end(input);
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error('Git source operation failed: ' + Buffer.concat(errors).toString('utf8').slice(0, 600)));
      else resolve(Buffer.concat(chunks));
    });
  });
}
export function immutableSourceFile(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    if (!fs.readFileSync(file).equals(Buffer.from(bytes))) throw new Error('Immutable source cache differs');
    return;
  }
  const pending = file + '.pending-' + randomUUID();
  try { fs.writeFileSync(pending, bytes, { flag: 'wx' }); fs.renameSync(pending, file); }
  finally { if (fs.existsSync(pending)) fs.unlinkSync(pending); }
}
function treeRows(bytes) {
  const rows = bytes.toString('utf8').split('\0').filter(Boolean).map(line => {
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40})\s+(\d+|-)\t([\s\S]+)$/.exec(line);
    if (!match) throw new Error('Git file tree is malformed');
    const [, mode, type, blob, size, filename] = match;
    if (filename.split('/').some(part => !part || part === '.' || part === '..') || filename.includes('\\')) throw new Error('Git tree contains an unsafe path');
    return { path: filename, mode, type, blob, size: size === '-' ? null : Number(size) };
  });
  if (new Set(rows.map(row => row.path)).size !== rows.length) throw new Error('Git file tree contains duplicate paths');
  return rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export function repositoryFileChanges(before, after) {
  const old = new Map(before.map(row => [row.path, row])), current = new Map(after.map(row => [row.path, row]));
  const removed = before.filter(row => !current.has(row.path));
  const added = after.filter(row => !old.has(row.path));
  const additionsByBlob = new Map(), removalsByBlob = new Map();
  for (const [rows, map] of [[added, additionsByBlob], [removed, removalsByBlob]]) for (const row of rows) {
    const key = row.mode + ':' + row.blob; map.set(key, [...(map.get(key) ?? []), row]);
  }
  const moved = new Set(), changes = [];
  for (const row of added) {
    const key = row.mode + ':' + row.blob, matches = removalsByBlob.get(key) ?? [];
    if (matches.length === 1 && additionsByBlob.get(key).length === 1) {
      moved.add(matches[0].path);
      changes.push({ ...row, event: 'moved', previousPath: matches[0].path, previousBlob: matches[0].blob, contentChanged: false });
    } else changes.push({ ...row, event: 'added', contentChanged: true });
  }
  for (const row of after) {
    const previous = old.get(row.path);
    if (previous && (previous.blob !== row.blob || previous.mode !== row.mode)) changes.push({ ...row, event: 'modified', previousBlob: previous.blob, contentChanged: previous.blob !== row.blob });
  }
  for (const row of removed) if (!moved.has(row.path)) changes.push({ ...row, event: 'removed', contentChanged: false });
  return changes.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export async function resolveRepositoryHead(repository, deps = {}) {
  publicRepository(repository);
  const remote = (await (deps.runGit ?? runSourceGit)(['ls-remote', '--symref', `https://github.com/${repository}.git`, 'HEAD'], { maxBytes: 65536 })).toString('utf8');
  const pinned = remote.split(/\r?\n/).map(line => /^([a-f0-9]{40})\tHEAD$/.exec(line)?.[1]).filter(Boolean);
  if (pinned.length !== 1) throw new Error('Git source HEAD is not one pinned commit');
  return pinned[0];
}
export async function pinnedRepositorySnapshot({ repository, home, previousCommit = null }, deps = {}) {
  publicRepository(repository);
  if (previousCommit !== null && !commitPattern.test(previousCommit)) throw new Error('Invalid previous repository commit');
  const run = deps.runGit ?? runSourceGit;
  const key = hash(repository), directory = path.join(home, 'nday-hunter', 'source-git', key + '.git');
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  if (!fs.existsSync(directory)) await run(['init', '--bare', directory], { cwd: path.dirname(directory) });
  const git = (args, options = {}) => run(['--git-dir', directory, ...args], { cwd: path.dirname(directory), ...options });
  const url = `https://github.com/${repository}.git`;
  const commit = await resolveRepositoryHead(repository, { runGit: (args, options) => run(args, { cwd: path.dirname(directory), ...options }) });
  let present = false;
  try { await git(['cat-file', '-e', commit + '^{commit}']); present = true; } catch { /* fetch missing immutable objects */ }
  if (!present) await git(['fetch', '--no-tags', '--depth=1', url, commit], { maxBytes: 1024 * 1024, timeoutMs: 300000 });
  const actual = (await git(['rev-parse', '--verify', commit + '^{commit}'])).toString('utf8').trim();
  if (actual !== commit) throw new Error('Fetched source commit differs from selected revision');
  await git(['update-ref', 'refs/saker/snapshots/' + commit, commit]);
  const tree = treeRows(await git(['ls-tree', '--full-tree', '-r', '-l', '-z', commit], { maxBytes: 128 * 1024 * 1024, timeoutMs: 180000 }));
  let before = [];
  if (previousCommit !== null) before = treeRows(await git(['ls-tree', '--full-tree', '-r', '-l', '-z', previousCommit], { maxBytes: 128 * 1024 * 1024, timeoutMs: 180000 }));
  const committedAt = (await git(['show', '--no-patch', '--format=%cI', commit])).toString('utf8').trim();
  if (!Number.isFinite(Date.parse(committedAt))) throw new Error('Git source commit date is invalid');
  return { repository, commit, previousCommit, committedAt, tree, changes: repositoryFileChanges(before, tree) };
}
export async function readRepositoryBlob({ repository, home, row, maxBytes = 2 * 1024 * 1024 }, deps = {}) {
  publicRepository(repository);
  if (!row || row.type !== 'blob' || !['100644', '100755'].includes(row.mode) || !commitPattern.test(row.blob)
    || !Number.isSafeInteger(row.size) || row.size < 0 || row.size > maxBytes) throw new Error('Repository content is not a bounded regular file');
  const directory = path.join(home, 'nday-hunter', 'source-git', hash(repository) + '.git');
  const bytes = await (deps.runGit ?? runSourceGit)(['--git-dir', directory, 'cat-file', 'blob', row.blob], { cwd: path.dirname(directory), maxBytes });
  const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (bytes.length !== row.size || blob !== row.blob) throw new Error('Repository file content differs from pinned Git object');
  const digest = hash(bytes), file = path.join(home, 'nday-hunter', 'source-content', 'git', 'blob-' + digest);
  immutableSourceFile(file, bytes);
  return { bytes, contentFile: file, sha256: digest };
}
export async function readRepositoryBlobs({ repository, home, rows, maxBytes = 2 * 1024 * 1024 }, deps = {}) {
  publicRepository(repository);
  if (!Array.isArray(rows) || rows.length > 100) throw new Error('Invalid repository batch size');
  for (const row of rows) if (row.type !== 'blob' || !['100644', '100755'].includes(row.mode) || !commitPattern.test(row.blob)
    || !Number.isSafeInteger(row.size) || row.size < 0 || row.size > maxBytes) throw new Error('Repository content is not a bounded regular file');
  if (!rows.length) return new Map();
  const directory = path.join(home, 'nday-hunter', 'source-git', hash(repository) + '.git');
  const output = await (deps.runGit ?? runSourceGit)(['--git-dir', directory, 'cat-file', '--batch'], { cwd: path.dirname(directory),
    input: rows.map(row => row.blob + '\n').join(''), maxBytes: rows.reduce((sum, row) => sum + row.size + 100, 0) });
  const result = new Map(); let offset = 0;
  for (const row of rows) {
    const end = output.indexOf(10, offset);
    if (end < offset || end - offset > 90 || output.subarray(offset, end).toString('ascii') !== `${row.blob} blob ${row.size}`) throw new Error('Repository batch header differs from pinned Git object');
    offset = end + 1;
    const bytes = output.subarray(offset, offset + row.size); offset += row.size;
    if (bytes.length !== row.size || output[offset++] !== 10 || createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== row.blob) throw new Error('Repository batch content differs from pinned Git object');
    const digest = hash(bytes), contentFile = path.join(home, 'nday-hunter', 'source-content', 'git', 'blob-' + digest);
    immutableSourceFile(contentFile, bytes);
    result.set(row.blob, { bytes, contentFile, sha256: digest });
  }
  if (offset !== output.length) throw new Error('Repository batch contains unexpected trailing bytes');
  return result;
}
