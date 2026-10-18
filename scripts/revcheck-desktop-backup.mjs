import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('../',import.meta.url)), temp=path.resolve(root,'../_ref/tmp');
const production=path.join(root,'scripts/lib/desktop-backup.mjs');
const source=fs.readFileSync(production,'utf8');
const digest=value=>createHash('sha256').update(value).digest('hex');
const variants=[
 ['opaque-uploads',"if (label === 'redteam-results' && existsSync(join(target, 'results.db')))\n    checkDataFile(join(target, 'results.db'), 'redteam-results/results.db', problems);", "for (const name of readdirSync(target)) if (statSync(join(target, name)).isFile()) checkDataFile(join(target, name), label + '/' + name, problems);", '上传的 JSON 片段和非 SQLite .db 文件'],
 ['data-integrity','else if (JSON.stringify(actual) !== JSON.stringify(entry.inventory))','else if (false)','合法 JSON 内容被改写也必须拒绝恢复'],
 ['stale-data','renameSync(current, destination);','cpSync(current, destination, { recursive: true });','恢复真实 SQLite 时隔离新文件和残留 WAL'],
];
for(const [name,from,to,failure]of variants){
 const fixture=fs.mkdtempSync(path.join(temp,'saker-backup-reverse-'));
 try{
  fs.mkdirSync(path.join(fixture,'lib'));
  fs.copyFileSync(path.join(root,'scripts/test-desktop-backup.mjs'),path.join(fixture,'test-desktop-backup.mjs'));
  assert.equal(source.split(from).length-1,1,'mutation anchor');
  let changed = source.replace(from,to);
  if (name === 'opaque-uploads') changed = changed.replace("if (label === 'redteam-results/results.db')", "if (file.endsWith('.db'))");
  fs.writeFileSync(path.join(fixture,'lib/desktop-backup.mjs'),changed);
  const result=spawnSync(process.execPath,[path.join(fixture,'test-desktop-backup.mjs')],{encoding:'utf8',timeout:30000,env:{...process.env,TEMP:temp,TMP:temp,TMPDIR:temp}});
  assert.notEqual(result.status,0);assert((result.stdout+result.stderr).includes('FAIL '+failure),result.stdout+result.stderr);
  console.log('ok reverse '+name+': restoring old behavior fails the corresponding assertion');
 }finally{assert(path.resolve(fixture).startsWith(temp+path.sep));fs.rmSync(fixture,{recursive:true,force:true})}
}
assert.equal(digest(fs.readFileSync(production)),digest(source));
console.log('ok backup reverse verification leaves production source unchanged');
