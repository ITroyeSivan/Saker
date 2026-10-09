import assert from 'node:assert/strict';
import { cpSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname,join,resolve } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),temp=resolve(root,'../_ref/tmp');mkdirSync(temp,{recursive:true});
const sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
const originals=['task-prompt.js','client.js'].map(name=>join(root,'plugins/dsh-redteam-results/lib',name)),before=originals.map(sha);
const variants=[
  {name:'full-system-state',file:'task-prompt.js',old:"text: assembly => eligible(assembly) ? rule : ''",next:'text: snapshot',runner:'test-task-prompt-cost.mjs',failure:/FAIL task transitions keep/},
  {name:'missing-context',file:'task-prompt.js',old:"typeof ctx.systemPrompt.context !== 'function'",next:'true',runner:'test-task-prompt-cost.mjs',failure:/native task context was not registered/},
  {name:'read-mutation',file:'client.js',old:'// Reading or polling must not turn displayed defaults into a user choice.',next:"if(!result.configured&&!result.choice)return api('task.choose',{sessionId:props.sessionId,mode:'regular',workflow:'single',workers:1,interaction:'continuous'}).then(function(){return api('chat.settings',{sessionId:props.sessionId});});",runner:'test-desktop-task-ui.mjs',failure:/FAIL reading and polling Desktop chat settings never persist/}
];
for(const variant of variants){const fixture=mkdtempSync(join(temp,'revcheck-task-prompt-'));try{
  const lib=join(fixture,'plugins/dsh-redteam-results/lib');cpSync(join(root,'plugins/dsh-redteam-results/lib'),lib,{recursive:true});mkdirSync(join(fixture,'scripts'),{recursive:true});
  for(const name of ['test-task-prompt-cost.mjs','test-desktop-task-ui.mjs','test-home-isolation.mjs'])cpSync(join(root,'scripts',name),join(fixture,'scripts',name));
  const file=join(lib,variant.file),source=readFileSync(file,'utf8');assert.equal(source.split(variant.old).length-1,1,'mutation anchor must occur exactly once');writeFileSync(file,source.replace(variant.old,variant.next));
  const result=spawnSync(process.execPath,['--import',pathToFileURL(join(root,'scripts/test-stub-register.mjs')).href,join(fixture,'scripts',variant.runner)],{cwd:root,encoding:'utf8',timeout:30000,env:{...process.env,TEMP:temp,TMP:temp,TMPDIR:temp}});
  assert.notEqual(result.status,0,variant.name+' falsely passed');assert.match(result.stdout+result.stderr,variant.failure,variant.name+' failed for unrelated reasons');console.log('ok reverse '+variant.name+' fails at the corresponding actual behavior');
}finally{rmSync(fixture,{recursive:true,force:true})}}
assert.deepEqual(originals.map(sha),before);console.log('ok reverse prompt cost verification preserved production source');
