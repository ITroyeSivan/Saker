import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),boundary=path.resolve(root,'../_ref/tmp');
const source=path.join(root,'lib/preset-roster-patch.mjs'),before=fs.readFileSync(source,'utf8'),digest=createHash('sha256').update(before).digest('hex');
const directory=fs.mkdtempSync(path.join(boundary,'saker-preset-reverse-'));
try {
  assert(directory.startsWith(boundary+path.sep));
  const target=path.join(directory,'preset-roster-patch.mjs');
  const anchor='return await originalResolve(id, ...rest)';
  assert.equal(before.split(anchor).length-1,1);
  fs.writeFileSync(target,before.replace(anchor,'if (!filterPreset({ id })) return undefined; '+anchor));
  const runner=path.join(directory,'test-preset-root-restore.mjs');
  fs.writeFileSync(runner,fs.readFileSync(path.join(root,'scripts/test-preset-root-restore.mjs'),'utf8')
    .replace("'../lib/preset-roster-patch.mjs'",JSON.stringify(pathToFileURL(target).href)));
  const result=spawnSync(process.execPath,[runner],{encoding:'utf8',env:{...process.env,TEMP:boundary,TMP:boundary,TMPDIR:boundary}});
  assert.notEqual(result.status,0);assert.match(result.stdout+result.stderr,/new sessions must resolve the host default/);
  console.log('ok reverse default-preset filter: the real default-resolution assertion fails');
} finally {fs.rmSync(directory,{recursive:true,force:true});}
assert.equal(createHash('sha256').update(fs.readFileSync(source)).digest('hex'),digest);
console.log('ok preset reverse verification preserves production source');
