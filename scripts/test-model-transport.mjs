import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { startTaskPolicy, updateTaskProgress } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { registerModelAdmission, modelBudgetOverview } from '../plugins/dsh-redteam-results/lib/model-budget.js';
import { registerModelTransport } from '../plugins/dsh-redteam-results/lib/model-transport.js';
let failures=0;
async function test(label,body){try{await body();console.log('ok '+label);}catch(error){failures++;console.error('FAIL '+label+': '+error.stack);}}
const options={sessionId:'main',provider:'fixture',model:'local-model',messages:[],maxTokens:8};
const usage={inputTokens:3,outputTokens:2};
async function fixture(budget,body){
  const received=[],store=openStore(':memory:');let hook;
  const server=http.createServer(async(req,res)=>{const parts=[];for await(const p of req)parts.push(p);
    received.push({url:req.url,bytes:Buffer.concat(parts)});
    if(req.url.includes('redirect=1')){res.writeHead(307,{location:'/v1/messages'});res.end();return;}
    res.writeHead(received.length===1?400:200,{'content-type':'application/json'});res.end('{}');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  startTaskPolicy(store,'main',{mode:'regular',budget:{toolCalls:5,workers:0,...budget}});
  const previousFetch=globalThis.fetch;
  const admission=registerModelAdmission({on(_name,handler){hook=handler;return()=>{};}},()=>store);
  const url=`http://127.0.0.1:${server.address().port}/v1/messages`;
  const request=()=>fetch(url,{method:'POST',body:JSON.stringify({model:options.model,messages:[{role:'user',content:'local fixture'}],max_tokens:8,extension:{reference:'final-field'}})});
  async function collect(next,o=options){const chunks=[];for await(const chunk of hook(o,next))chunks.push(chunk);return chunks;}
  try{await body({store,received,url,request,collect});}
  finally{await admission.dispose();assert.equal(globalThis.fetch,previousFetch,'fetch ownership restored');store.close();await new Promise(resolve=>server.close(resolve));}
}
await test('provider-internal second attempt cannot bypass one-call budget',()=>fixture({modelCalls:1},async({received,request,collect,store})=>{
  const chunks=await collect(async function*(){await request();await request();yield {type:'usage',usage};yield {type:'finish',reason:{kind:'stop'}};});
  assert.equal(received.length,1);assert.equal(chunks.at(-1).reason.failure.code,'TASK_MODEL_BUDGET');
  const status=modelBudgetOverview(store,'main');assert.equal(status.chargedCalls,1);assert.equal(status.unknownCalls,1);assert.equal(status.wireAttempts,1);
  const policy=store.db.prepare('SELECT record FROM task_policy WHERE session_id=?').get('main');assert.equal(JSON.parse(policy.record).modelBudgetBlock.priorWireAttempts,1);
}));
await test('successful retry gets a separate settlement and does not erase earlier unknown cost',()=>fixture({modelCalls:2},async({received,request,collect,store})=>{
  await collect(async function*(){await request();await request();yield {type:'usage',usage};yield {type:'finish',reason:{kind:'stop'}};});
  assert.equal(received.length,2);const s=modelBudgetOverview(store,'main');
  assert.equal(s.chargedCalls,2);assert.equal(s.wireAttempts,2);assert.equal(s.unknownCalls,1);assert.equal(s.knownTokens,5);assert.equal(s.totalTokens,null);
  assert.equal(s.unobservedCalls,0);assert.equal(s.transport.mode,'native-fetch');assert(s.transport.protocols.includes('messages'));
  assert.deepEqual(s.calls.map(x=>x.state),['unknown','settled']);
  for(let i=0;i<2;i++){assert.equal(s.calls[i].wire.sha256,createHash('sha256').update(received[i].bytes).digest('hex'));assert.equal(s.calls[i].wire.bytes,received[i].bytes.length);}
  assert(!JSON.stringify(s).includes('final-field'),'raw extension content stays out of ledger');
}));
await test('cancellation after serialization but before first fetch prevents generation',()=>fixture({},async({received,request,collect,store})=>{
  const chunks=await collect(async function*(){updateTaskProgress(store,'main',{cancelled:true});await request();yield {type:'finish',reason:{kind:'stop'}};});
  assert.equal(received.length,0);assert.equal(chunks.at(-1).reason.failure.code,'TASK_MODEL_BUDGET');
}));
await test('cancellation between provider attempts prevents the next fetch without an optional ceiling',()=>fixture({},async({received,request,collect,store})=>{
  const chunks=await collect(async function*(){await request();updateTaskProgress(store,'main',{cancelled:true});await request();yield {type:'finish',reason:{kind:'stop'}};});
  assert.equal(received.length,1);assert.equal(chunks.at(-1).reason.failure.code,'TASK_MODEL_BUDGET');assert.equal(modelBudgetOverview(store,'main').chargedCalls,1);
}));
await test('wire model mismatch fails closed before network',()=>fixture({},async({received,url,collect,store})=>{
  const chunks=await collect(async function*(){await fetch(url,{method:'POST',body:JSON.stringify({model:'different',messages:[]})});yield {type:'finish',reason:{kind:'stop'}};});
  assert.equal(received.length,0);assert.equal(chunks.at(-1).reason.failure.code,'TASK_MODEL_BUDGET');assert.equal(modelBudgetOverview(store,'main').wireAttempts,0);
}));
await test('uploads and unrelated fetches do not consume generation-attempt slots',()=>fixture({modelCalls:1},async({received,url,request,collect,store})=>{
  await fetch(url,{method:'POST',body:JSON.stringify({model:'unmanaged',messages:[]})});
  await collect(async function*(){await fetch(url.replace('/messages','/files'),{method:'POST',body:'upload fixture'});await request();yield {type:'usage',usage};yield {type:'finish',reason:{kind:'stop'}};});
  assert.equal(received.length,3);assert.equal(modelBudgetOverview(store,'main').chargedCalls,1);assert.equal(modelBudgetOverview(store,'main').wireAttempts,1);
}));
await test('mutable request bytes are snapshotted and body digest matches bytes actually sent',()=>fixture({},async({received,url,collect,store})=>{
  await collect(async function*(){const bytes=Buffer.from(JSON.stringify({model:options.model,messages:[],max_tokens:8}));
    const response=fetch(url,{method:'POST',body:bytes});bytes.fill(32);await response;yield {type:'usage',usage};yield {type:'finish',reason:{kind:'stop'}};});
  assert.equal(JSON.parse(received[0].bytes).model,options.model);assert.equal(modelBudgetOverview(store,'main').calls[0].wire.sha256,createHash('sha256').update(received[0].bytes).digest('hex'));
}));
await test('Request objects are supported',()=>fixture({modelCalls:1},async({received,url,collect,store})=>{
  await collect(async function*(){await fetch(new Request(url,{method:'POST',body:JSON.stringify({model:options.model,messages:[],max_tokens:8})}));yield {type:'usage',usage};yield {type:'finish',reason:{kind:'stop'}};});
  assert.equal(received.length,1);assert.equal(modelBudgetOverview(store,'main').wireAttempts,1);
}));
await test('an actual HTTP redirect cannot hide a second request',()=>fixture({modelCalls:1},async({received,url,collect,store})=>{
  await assert.rejects(collect(async function*(){await fetch(url+'?redirect=1',{method:'POST',body:JSON.stringify({model:options.model,messages:[]})});yield {type:'finish',reason:{kind:'stop'}};}));
  assert.equal(received.length,1);assert.equal(modelBudgetOverview(store,'main').wireAttempts,1);assert.equal(modelBudgetOverview(store,'main').unknownCalls,1);
}));
await test('concurrent parent and child generation attempts retain separate identities in a shared ceiling',()=>fixture({modelCalls:2},async({received,request,collect,store})=>{
  const parent=store.db.prepare('SELECT record FROM task_policy WHERE session_id=?').get('main');
  store.db.prepare('INSERT INTO site_workers(parent_session,child_id,site,record) VALUES(?,?,?,?)').run('main','child','http://127.0.0.1','{}');
  startTaskPolicy(store,'child',{mode:'regular',budget:{toolCalls:5,workers:0}});
  const generate=async function*(){await request();yield {type:'usage',usage};yield {type:'finish',reason:{kind:'stop'}};};
  await Promise.all([collect(generate),collect(generate,{...options,sessionId:'child'})]);
  const s=modelBudgetOverview(store,'main');assert.equal(received.length,2);assert.equal(s.chargedCalls,2);assert.equal(s.wireAttempts,2);
  assert.deepEqual(s.calls.map(x=>x.sessionId).sort(),['child','main']);assert.equal(new Set(s.calls.map(x=>x.id)).size,2);
  const chunks=await collect(generate);assert.equal(chunks.at(-1).reason.failure.code,'TASK_MODEL_BUDGET');assert.equal(received.length,2);
  assert.equal(JSON.parse(parent.record).startedAt,s.round);
}));
await test('fetch retained by an SDK still uses current scope after unload and reload',async()=>{
  const first=registerModelTransport(),captured=globalThis.fetch;first.dispose();
  await fixture({modelCalls:1},async({received,url,collect})=>{
    const chunks=await collect(async function*(){const init={method:'POST',body:JSON.stringify({model:options.model,messages:[]})};await captured(url,init);await captured(url,init);yield {type:'finish',reason:{kind:'stop'}};});
    assert.equal(received.length,1);assert.equal(chunks.at(-1).reason.failure.code,'TASK_MODEL_BUDGET');
  });
});
await test('a successful stream without an observed native fetch is counted as unobserved, not as a wire attempt',()=>fixture({},async({collect,store})=>{
  await collect(async function*(){yield {type:'usage',usage};yield {type:'finish',reason:{kind:'stop'}};});
  const s=modelBudgetOverview(store,'main');
  assert.equal(s.chargedCalls,1);assert.equal(s.wireAttempts,0);assert.equal(s.unobservedCalls,1);assert.equal(s.knownTokens,5);
}));
if(failures)process.exitCode=1;
