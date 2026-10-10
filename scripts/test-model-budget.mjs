import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { startTaskPolicy, readTaskPolicy, taskPolicyStatus, updateTaskProgress } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { modelBudgetOverview, modelRequestDigest, reserveModelCall, dispatchModelCall, settleModelCall,
  cancelModelReservation, recoverModelRuntime, normalizedModelUsage, registerModelAdmission } from '../plugins/dsh-redteam-results/lib/model-budget.js';
let failures=0;
async function test(label,body){try{await body();console.log('ok '+label);}catch(error){failures++;console.error('FAIL '+label+': '+error.stack);}}
const options={sessionId:'main',provider:'fixture',model:'exact-fixture',maxTokens:10,messages:[{role:'user',content:[{type:'text',text:'test'}]}]};
const certificate=(o=options,n=30)=>({provider:o.provider,model:o.model,requestDigest:modelRequestDigest(o),quality:'exact',maximumChargeTokens:n,version:'fixture-full-dispatch/1',coversDispatch:true});
function start(store,budget={},id='main'){startTaskPolicy(store,id,{mode:'regular',target:'http://127.0.0.1',budget:{toolCalls:10,workers:0,...budget}});}
function child(store){const parent=readTaskPolicy(store,'main');store.db.prepare('INSERT INTO site_workers(parent_session,child_id,site,record) VALUES(?,?,?,?)').run('main','child','http://127.0.0.1','{}');
  startTaskPolicy(store,'child',{mode:'regular',budget:{toolCalls:10,workers:0}});assert.equal(readTaskPolicy(store,'child').parentRound,parent.startedAt);}
if(!isMainThread){
  const store=openStore(workerData.database);
  parentPort.postMessage('ready');
  await new Promise(resolve=>parentPort.once('message',resolve));
  try{parentPort.postMessage({result:reserveModelCall(store,'main',options)});}finally{store.close();}
  process.exit(0);
}
if(process.argv.includes('--crashfixture')){
  const store=openStore(process.argv.at(-1));
  const registration=registerModelAdmission({on(){return ()=>{};}},()=>store);
  reserveModelCall(store,'main',options,{runtimeId:registration.runtimeId});
  const sent=reserveModelCall(store,'main',options,{runtimeId:registration.runtimeId});dispatchModelCall(store,sent.id);
  // Simulate a terminated owner, with neither middleware settlement nor dispose.
  process.exit(0);
}
await test('shared root admission reserves before dispatch; children, retries and auxiliary purposes consume the same call ceiling',()=>{
  const store=openStore(':memory:');try{start(store,{modelCalls:2});child(store);
    const first=reserveModelCall(store,'main',options);assert(first.ok);assert(dispatchModelCall(store,first.id));
    settleModelCall(store,first.id,{usage:{inputTokens:4,outputTokens:1},complete:true});
    const second=reserveModelCall(store,'child',{...options,sessionId:'child',purpose:'compaction'});assert(second.ok);assert(dispatchModelCall(store,second.id));
    settleModelCall(store,second.id,{complete:false});
    const rejected=reserveModelCall(store,'main',{...options,purpose:'session-title'});
    assert.equal(rejected.code,'model_calls_exhausted');const status=modelBudgetOverview(store,'child');
    assert.equal(status.chargedCalls,2);assert.equal(status.knownTokens,5);assert.equal(status.unknownCalls,1);assert.equal(status.totalTokens,null);
    assert(taskPolicyStatus(store,'main').stopped);assert(taskPolicyStatus(store,'child').stopped);
  }finally{store.close();}
});
await test('strict token reservations include in-flight and unknown cost, release only never-dispatched work, and retain actual settlement',()=>{
  const store=openStore(':memory:');try{start(store,{tokens:50});
    const first=reserveModelCall(store,'main',options,{counter:certificate()});assert(first.ok);
    assert.equal(modelBudgetOverview(store,'main').heldTokens,30);cancelModelReservation(store,first.id);
    const second=reserveModelCall(store,'main',options,{counter:certificate()});assert(second.ok);dispatchModelCall(store,second.id);
    settleModelCall(store,second.id,{usage:{inputTokens:7,outputTokens:2},complete:false});
    assert.throws(()=>cancelModelReservation(store,second.id),/cannot_be_released/);
    assert.equal(modelBudgetOverview(store,'main').heldTokens,30);assert.equal(modelBudgetOverview(store,'main').totalTokens,null);
    assert.equal(reserveModelCall(store,'main',options,{counter:certificate()}).code,'tokens_exhausted');
    settleModelCall(store,second.id,{usage:{inputTokens:7,outputTokens:2},complete:true});
    settleModelCall(store,second.id,{usage:{inputTokens:7,outputTokens:2},complete:true});
    assert.throws(()=>settleModelCall(store,second.id,{usage:{inputTokens:1,outputTokens:0},complete:true}),/conflicting/);
    assert.equal(modelBudgetOverview(store,'main').knownTokens,9);assert.equal(modelBudgetOverview(store,'main').heldTokens,0);
  }finally{store.close();}
});
await test('estimated, stale or incomplete counting certificates cannot admit a strict request; counter violations block later work',()=>{
  for(const mutation of [c=>{c.quality='estimate';},c=>{c.requestDigest='other';},c=>{c.coversDispatch=false;},c=>{c.model='other';},c=>{c.maximumChargeTokens=NaN;}]){
    const store=openStore(':memory:');try{start(store,{tokens:50});const counter=certificate();mutation(counter);
      assert.equal(reserveModelCall(store,'main',options,{counter}).code,'token_count_unavailable');assert.equal(modelBudgetOverview(store,'main').chargedCalls,0);
    }finally{store.close();}
  }
  const store=openStore(':memory:');try{start(store,{tokens:50});const admitted=reserveModelCall(store,'main',options,{counter:certificate(options,5)});dispatchModelCall(store,admitted.id);
    settleModelCall(store,admitted.id,{usage:{inputTokens:7,outputTokens:2},complete:true});
    assert(modelBudgetOverview(store,'main').counterViolation);assert.equal(reserveModelCall(store,'main',options,{counter:certificate()}).code,'counter_violation');
  }finally{store.close();}
});
await test('recovery cancels only undispatched reservations; interrupted dispatch retains its hold and cannot be blindly replayed',()=>{
  const store=openStore(':memory:');try{start(store,{tokens:100});
    const a=reserveModelCall(store,'main',options,{counter:certificate(),runtimeId:'stopped-runtime'});
    const b=reserveModelCall(store,'main',options,{counter:certificate(),runtimeId:'stopped-runtime'});dispatchModelCall(store,b.id);
    assert.equal(recoverModelRuntime(store,'stopped-runtime'),2);assert.equal(recoverModelRuntime(store,'stopped-runtime'),0);
    const status=modelBudgetOverview(store,'main');assert.equal(status.chargedCalls,1);assert.equal(status.heldTokens,30);assert.equal(status.unknownCalls,1);
    assert.throws(()=>dispatchModelCall(store,a.id),/not_reserved/);assert.throws(()=>dispatchModelCall(store,b.id),/not_reserved/);
  }finally{store.close();}
});
await test('native stream middleware blocks before next(), settles complete usage, and keeps partial/error streams unknown',async()=>{
  const store=openStore(':memory:');try{start(store,{modelCalls:2});let hook,dispatches=0;
    const registration=registerModelAdmission({on(_name,handler){hook=handler;return ()=>{};}},()=>store);
    const success=()=>{dispatches++;return (async function*(){yield {type:'usage',usage:{inputTokens:2,outputTokens:1,cacheReadTokens:4,totalTokens:7}};yield {type:'finish',reason:{kind:'stop'}};})();};
    const failure=()=>{dispatches++;return (async function*(){yield {type:'usage',usage:{inputTokens:2,outputTokens:1}};yield {type:'finish',reason:{kind:'error',failure:{code:'RATE_LIMIT',message:'fixture'}}};})();};
    for await(const _chunk of hook(options,success)){}for await(const _chunk of hook({...options,purpose:'session-title'},failure)){}
    const blocked=[];for await(const chunk of hook(options,success))blocked.push(chunk);
    assert.equal(dispatches,2);assert.equal(blocked[0].reason.failure.code,'TASK_MODEL_BUDGET');
    const status=modelBudgetOverview(store,'main');assert.equal(status.knownTokens,7);assert.equal(status.unknownCalls,1);assert.equal(status.totalTokens,null);
    await registration.dispose();
  }finally{store.close();}
});
await test('usage normalization rejects contradictory, missing and overflowing counts while including cache exactly once',()=>{
  assert.equal(normalizedModelUsage({inputTokens:2,outputTokens:1,cacheReadTokens:4,totalTokens:7}).totalTokens,7);
  for(const usage of [undefined,{}, {inputTokens:1,outputTokens:2,totalTokens:2},{inputTokens:Number.MAX_SAFE_INTEGER,outputTokens:1},{inputTokens:1,outputTokens:2,cacheReadTokens:null}])assert.equal(normalizedModelUsage(usage),null);
});
await test('already admitted work survives another request exhausting the ceiling; cancellation before dispatch releases its reservation',()=>{
  const store=openStore(':memory:');try{start(store,{modelCalls:2});
    const a=reserveModelCall(store,'main',options), b=reserveModelCall(store,'main',options);
    assert.equal(reserveModelCall(store,'main',options).code,'model_calls_exhausted');
    assert(dispatchModelCall(store,a.id));assert(dispatchModelCall(store,b.id));
  }finally{store.close();}
  const other=openStore(':memory:');try{start(other,{modelCalls:1});const a=reserveModelCall(other,'main',options);
    const p=readTaskPolicy(other,'main');p.cancelled=true;other.db.prepare('UPDATE task_policy SET record=? WHERE session_id=?').run(JSON.stringify(p),'main');
    assert.equal(dispatchModelCall(other,a.id),false);assert.equal(modelBudgetOverview(other,'main').chargedCalls,0);
  }finally{other.close();}
});
await test('cancellation and deadlines veto reservations and dispatch without optional model ceilings',()=>{
  for(const cause of ['root-cancel','child-cancel','root-deadline','child-deadline']){
    const store=openStore(':memory:');try{
      start(store);child(store);
      const pending=reserveModelCall(store,'child',{...options,sessionId:'child'});assert(pending.ok);
      const id=cause.startsWith('root')?'main':'child';
      if(cause.endsWith('cancel'))updateTaskProgress(store,id,{cancelled:true});
      else {const p=readTaskPolicy(store,id);p.budget.deadline=Date.now()-1;
        store.db.prepare('UPDATE task_policy SET record=? WHERE session_id=?').run(JSON.stringify(p),id);}
      assert.equal(reserveModelCall(store,'child',{...options,sessionId:'child'}).code,'task_stopped',cause);
      assert.equal(dispatchModelCall(store,pending.id),false,cause);
      assert.equal(modelBudgetOverview(store,'main').chargedCalls,0,cause);
      if(id==='child'){
        assert.equal(readTaskPolicy(store,'main').modelBudgetBlock,undefined,cause);
        assert.equal(reserveModelCall(store,'main',options).ok,true,cause);
      }
    }finally{store.close();}
  }
});
await test('a stopped child cannot poison the parent budget even when a shared model ceiling exists',()=>{
  const store=openStore(':memory:');try{
    start(store,{modelCalls:3});child(store);updateTaskProgress(store,'child',{cancelled:true});
    assert.equal(reserveModelCall(store,'child',{...options,sessionId:'child'}).code,'task_stopped');
    assert.equal(readTaskPolicy(store,'main').modelBudgetBlock,undefined);
    assert.equal(reserveModelCall(store,'main',options).ok,true);
  }finally{store.close();}
});
await test('stopped streams invoke neither counting nor provider, and cancellation during counting is rechecked',async()=>{
  for(const timing of ['before-count','during-count']){
    const store=openStore(':memory:');let registration;
    try{
      start(store,{tokens:100});let hook,counts=0,dispatches=0;
      registration=registerModelAdmission({on(_name,handler){hook=handler;return ()=>{};}},()=>store,{countInput:async(o)=>{
        counts++;updateTaskProgress(store,'main',{cancelled:true});return certificate(o);
      }});
      if(timing==='before-count')updateTaskProgress(store,'main',{cancelled:true});
      const chunks=[];for await(const chunk of hook(options,()=>{dispatches++;throw Error('stopped provider reached');}))chunks.push(chunk);
      assert.equal(counts,timing==='before-count'?0:1,timing);assert.equal(dispatches,0,timing);
      assert.equal(chunks[0].reason.failure.code,'TASK_MODEL_BUDGET',timing);
      assert.equal(modelBudgetOverview(store,'main').chargedCalls,0,timing);
    }finally{await registration?.dispose();store.close();}
  }
});
await test('missing certified counter stops strict native dispatch without invoking the provider or charging a call',async()=>{
  const store=openStore(':memory:');try{start(store,{tokens:100});let hook,calls=0;
    registerModelAdmission({on(_name,handler){hook=handler;return ()=>{};}},()=>store);
    const chunks=[];for await(const chunk of hook(options,()=>{calls++;throw Error('must never reach provider');}))chunks.push(chunk);
    assert.equal(calls,0);assert.equal(modelBudgetOverview(store,'main').chargedCalls,0);
    assert.equal(chunks[0].reason.failure.code,'TASK_MODEL_BUDGET');assert.equal(readTaskPolicy(store,'main').modelBudgetBlock.code,'token_count_unavailable');
  }finally{store.close();}
});
await test('simultaneous SQLite connections share one admission ceiling without double allocation',async()=>{
  const directory=mkdtempSync(join(resolve(process.env.TEMP),'model-admission-race-'));
  const database=join(directory,'calls.db'), store=openStore(database), workers=[];
  try{
    start(store,{modelCalls:3});
    const ready=[], results=[];
    for(let i=0;i<8;i++){
      const worker=new Worker(new URL(import.meta.url),{workerData:{database}});workers.push(worker);
      ready.push(new Promise((resolve,reject)=>{worker.once('error',reject);worker.on('message',msg=>{if(msg==='ready')resolve();});}));
      results.push(new Promise((resolve,reject)=>{worker.once('error',reject);worker.on('message',msg=>{if(msg?.result)resolve(msg.result);});worker.on('exit',code=>{if(code)reject(Error('worker failed '+code));});}));
    }
    await Promise.all(ready);workers.forEach(worker=>worker.postMessage('start together'));
    const admitted=await Promise.all(results);
    assert.equal(admitted.filter(row=>row.ok).length,3);
    assert.equal(admitted.filter(row=>row.code==='model_calls_exhausted').length,5);
    assert.equal(modelBudgetOverview(store,'main').chargedCalls,3);
  }finally{await Promise.all(workers.map(worker=>worker.terminate()));store.close();rmSync(directory,{recursive:true,force:true});}
});
await test('a genuinely exited owner is recovered on reopening; unknown dispatched cost survives restart',async()=>{
  const directory=mkdtempSync(join(resolve(process.env.TEMP),'model-admission-restart-')), database=join(directory,'calls.db');
  let store=openStore(database);
  try{
    start(store,{modelCalls:2});store.close();store=null;
    const result=spawnSync(process.execPath,[...process.execArgv,fileURLToPath(import.meta.url),'--crashfixture',database],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    store=openStore(database);const registration=registerModelAdmission({on(){return ()=>{};}},()=>store);
    const status=modelBudgetOverview(store,'main');assert.equal(status.chargedCalls,1);assert.equal(status.unknownCalls,1);
    assert.equal(status.unresolvedCalls,0);assert.equal(status.totalTokens,null);
    assert.equal(reserveModelCall(store,'main',options).ok,true);
    assert.equal(reserveModelCall(store,'main',options).code,'model_calls_exhausted');
    await registration.dispose();
  }finally{store?.close();rmSync(directory,{recursive:true,force:true});}
});
await test('unloading drains an active cancelled stream before closing its persistent ledger',async()=>{
  const store=openStore(':memory:'), controller=new AbortController();let hook,entered;
  try{
    start(store,{modelCalls:1});
    const registration=registerModelAdmission({on(_name,handler){hook=handler;return ()=>{};},agents:{get(){return {cancel(){controller.abort();}};}}},()=>store);
    const started=new Promise(resolve=>{entered=resolve;});
    const running=(async()=>{for await(const _chunk of hook({...options,signal:controller.signal},()=> (async function*(){
      entered();await new Promise(resolve=>controller.signal.addEventListener('abort',resolve,{once:true}));
      yield {type:'finish',reason:{kind:'aborted'}};
    })())){}})();
    await started;await registration.dispose();await running;
    assert.equal(modelBudgetOverview(store,'main').unknownCalls,1);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM task_model_runtimes').get().n,0);
  }finally{store.close();}
});
await test('the actual Desktop RPC rejects a new model ceiling when host admission is unavailable',async()=>{
  const {dispatch}=await import('../plugins/dsh-redteam-results/lib/index.js');
  const store=openStore(':memory:');let dispatched=0;
  try{
    const ctx={tools:{guard(){}},sessions:{get(){return {header:{agentPreset:'pentest'}};}},agents:{get(){return {status:'idle',followup(){dispatched++;}};}}};
    await assert.rejects(dispatch(ctx,store,'task.start',{sessionId:'main',policy:{mode:'regular',budget:{toolCalls:1,modelCalls:1}}}),/准入钩子/);
    assert.equal(dispatched,0);assert.equal(readTaskPolicy(store,'main'),null);
  }finally{store.close();}
});
process.exitCode=failures?1:0;
