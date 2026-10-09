import {mkdtempSync,readFileSync,writeFileSync,cpSync,mkdirSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';import {spawnSync} from 'node:child_process';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const root=fileURLToPath(new URL('..',import.meta.url)),temp=resolve(root,'../_ref/tmp');
const files=['plugins/dsh-sec-config/lib/tool-startup.js','plugins/dsh-sec-config/lib/client.js'],sha=file=>createHash('sha256').update(readFileSync(join(root,file))).digest('hex'),before=files.map(sha);
const variants=[
 {name:'rpc-wrapper',file:files[1],old:'var check = res.value?.check;',next:'var check = res.check;',failure:/real RPC wrapper success was not displayed/},
 {name:'exit-code',file:files[0],old:'if (outcome.exitCode !== 0)',next:'if (false)',failure:/FAIL a matching banner with nonzero exit/},
 {name:'identity',file:files[0],old:'if (!spec.identity.test(outcome.output))',next:'if (false)',failure:/FAIL zero exit with another tool/},
 {name:'late-path',file:files[1],old:"startup[e.key]?.configuredPath === e.path ? startup[e.key] : null",next:'startup[e.key] || null',failure:/late old-path success remained visible/}
];
for(const variant of variants){const dir=mkdtempSync(join(temp,'revcheck-tool-startup-'));try{
 mkdirSync(join(dir,'scripts'),{recursive:true});cpSync(join(root,'plugins/dsh-sec-config/lib'),join(dir,'plugins/dsh-sec-config/lib'),{recursive:true});
 for(const file of ['test-tool-startup.mjs','test-home-isolation.mjs'])cpSync(join(root,'scripts',file),join(dir,'scripts',file));
 const target=join(dir,variant.file),source=readFileSync(target,'utf8');assert.equal(source.split(variant.old).length-1,1);writeFileSync(target,source.replace(variant.old,variant.next));
 const r=spawnSync(process.execPath,['--import',pathToFileURL(join(root,'scripts/test-stub-register.mjs')).href,join(dir,'scripts/test-tool-startup.mjs')],{cwd:root,encoding:'utf8',timeout:15000,windowsHide:true,env:{...process.env,TEMP:temp,TMP:temp,TMPDIR:temp}});assert.notEqual(r.status,0);assert.match(r.stdout+r.stderr,variant.failure);console.log('ok reverse '+variant.name+' fails at corresponding behavior');
 }finally{rmSync(dir,{recursive:true,force:true})}}
assert.deepEqual(files.map(sha),before);console.log('ok reverse startup checks preserve production source');
