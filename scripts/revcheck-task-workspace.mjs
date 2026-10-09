import {mkdtempSync,readFileSync,writeFileSync,cpSync,mkdirSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('..',import.meta.url)),temp=resolve(root,'../_ref/tmp');
const file='plugins/dsh-redteam-results/lib/client.js';
const original=readFileSync(join(root,file),'utf8'),hash=()=>createHash('sha256').update(readFileSync(join(root,file))).digest('hex'),before=hash();
const variants=[
 {name:'global-counts',old:"history ? 'counts.all' : 'counts.session'",next:"'counts.all'",failure:/FAIL current findings use session counts/},
 {name:'global-default-list',old:"var scope = props.scope === 'all' ? 'all' : 'session';",next:"var scope = 'all';",failure:/FAIL list, grouping and full export/},
 {name:'global-export',old:'{ scope: scope, sessionId: sessionId, mode: mode, page: n, pageSize: 100',next:'{ scope: "all", sessionId: sessionId, mode: mode, page: n, pageSize: 100',failure:/FAIL list, grouping and full export/},
 {name:'late-counts',old:'if (revision !== countRequest.current) return;',next:'',failure:/FAIL late global counts cannot overwrite/}
];
for(const variant of variants){
 const dir=mkdtempSync(join(temp,'revcheck-task-workspace-'));
 try {
  mkdirSync(join(dir,'scripts'),{recursive:true});cpSync(join(root,'plugins/dsh-redteam-results/lib'),join(dir,'plugins/dsh-redteam-results/lib'),{recursive:true});
  for(const script of ['test-task-workspace.mjs','test-home-isolation.mjs'])cpSync(join(root,'scripts',script),join(dir,'scripts',script));
  assert.equal(original.split(variant.old).length-1,1);writeFileSync(join(dir,file),original.replace(variant.old,variant.next));
  const run=spawnSync(process.execPath,['--import',pathToFileURL(join(root,'scripts/test-stub-register.mjs')).href,join(dir,'scripts/test-task-workspace.mjs')],{cwd:root,encoding:'utf8',timeout:15000,windowsHide:true,env:{...process.env,TEMP:temp,TMP:temp,TMPDIR:temp}});
  assert.notEqual(run.status,0);assert.match(run.stdout+run.stderr,variant.failure);console.log('ok reverse '+variant.name+' fails at the corresponding behavior');
 }finally{rmSync(dir,{recursive:true,force:true});}
}
assert.equal(hash(),before);console.log('ok reverse workspace checks preserve production source');
