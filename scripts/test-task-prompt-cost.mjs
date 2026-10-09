import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import { apply } from '../plugins/dsh-redteam-results/lib/index.js';
import { registerTaskPrompt } from '../plugins/dsh-redteam-results/lib/task-prompt.js';
const sections=[],contexts=[],tools=new Map(),guards=[],disposers=[];
apply({systemPrompt:{section:p=>sections.push(p),context:p=>contexts.push(p)},
  tools:{register:t=>tools.set(t.name,t),guard:g=>guards.push(g)},
  effect:fn=>{const cleanup=fn();if(typeof cleanup==='function')disposers.push(cleanup)},webServer:{register:()=>()=>{}}});
const exec=id=>({agent:{session:{id,header:{agentPreset:'pentest',cwd:process.env.DSH_HOME}}}});
const task=tools.get('redteam_task'),section=sections.find(p=>p.name==='saker-pentest-task'),context=contexts.find(p=>p.name==='saker-pentest-task-state');
let failed=0;async function test(name,fn){try{await fn();console.log('ok '+name)}catch(error){failed++;console.log('FAIL '+name+': '+error.stack)}}
try{
  await test('task transitions keep the registered system section stable while native context exposes live budgets and completion',async()=>{
    assert(section&&context,'native task context was not registered');
    const scope=exec('live-state'),stable=section.text(scope);assert.match(stable,/最新快照/);
    const started=await task.execute({action:'start',mode:'regular',target:'http://127.0.0.1:8081',question:'Controlled fixture scope',toolCalls:3,workers:0},scope);assert(started.ok,started.error);
    assert.match(context.text(scope),/Saker task state/);assert.match(context.text(scope),/操作=0\/3/);
    const first=context.text(scope);const allowed=guards[0]({...scope,name:'pwsh'});assert.equal(allowed,undefined);
    assert.match(context.text(scope),/操作=1\/3/);assert.notEqual(context.text(scope),first);assert.equal(section.text(scope),stable);
    const done=await task.execute({action:'progress',planComplete:true},scope);assert(done.stopped);assert.match(context.text(scope),/plan_complete/);assert.equal(section.text(scope),stable);
    assert(guards[0]({...scope,name:'pwsh'}),'completed policy no longer blocked target tools');
  });
  await test('task snapshots are isolated by session and absent from other security presets',async()=>{
    const other=exec('other-state');const started=await task.execute({action:'start',mode:'nday',target:'http://127.0.0.1:8082',question:'Other controlled scope',toolCalls:7,workers:0},other);assert(started.ok,started.error);
    assert.match(context.text(other),/重点=nday/);assert(!context.text(other).includes('Controlled fixture scope'));
    const audit={agent:{session:{id:'audit-state',header:{agentPreset:'code-audit'}}}};
    assert.equal(section.text(audit),'');assert.equal(context.text(audit),'');
  });
  await test('legacy hosts preserve task state and stop semantics without a context service',()=>{
    const registered=[];let state='budget remaining';
    assert.equal(registerTaskPrompt({systemPrompt:{section:p=>registered.push(p)}},()=>true,()=>state),'legacy-section');
    assert.equal(registered[0].text({}),state);state='stopped';assert.equal(registered[0].text({}),'stopped');
  });
}finally{for(const dispose of disposers.reverse())await dispose()}
process.exitCode=failed?1:0;
