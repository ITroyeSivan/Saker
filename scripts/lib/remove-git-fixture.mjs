// Older bundled Windows Node cannot always remove Git's readonly objects.
// Only fixtures created beneath the caller's redirected temp root are eligible.
import fs from 'node:fs';
import path from 'node:path';
export function removeGitFixture(directory) {
  const root = path.resolve(process.env.TEMP || process.env.TMPDIR || process.env.TMP || '');
  const target = path.resolve(directory), relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !/^(source-git-|repository-source-)/.test(path.basename(target))) throw new Error('Git fixture cleanup escaped owned temp boundary');
  function writable(file) {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) for (const name of fs.readdirSync(file)) writable(path.join(file, name));
    else if (stat.isFile()) fs.chmodSync(file, 0o666);
  }
  writable(target);
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
