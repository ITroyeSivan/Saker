import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { openStore, registerFinding, getFinding } from '../plugins/dsh-redteam-results/lib/store.js';
import { saveTaskContext, readTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js';
import { startTaskPolicy, readTaskPolicy, taskPolicyStatus, taskExecutionGuard, pauseTaskPolicy, resumeTaskPolicy, updateTaskProgress, archiveTaskRound } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { createSiteWorkers, siteWorkerRows, siteWorkerView } from '../plugins/dsh-redteam-results/lib/site-workers.js';
import { indexBusinessMaterials, businessMaterialView } from '../plugins/dsh-redteam-results/lib/business-materials.js';
import { createResearch, researchDetail, assessResearch } from '../plugins/dsh-redteam-results/lib/research.js';
import { runComparisonJob, comparisonFindingInput } from '../plugins/dsh-redteam-results/lib/comparison-jobs.js';
import { readExecutionReceipt, executeRecordedRequest } from '../plugins/dsh-redteam-results/lib/execution-receipts.js';
import { recordImpactReview } from '../plugins/dsh-redteam-results/lib/impact-reviews.js';
import { saveChecks, readChecks, checkedKey } from '../plugins/dsh-redteam-results/lib/checked.js';
const home=process.env.DSH_HOME, store=openStore(path.join(home,'results.db')), live=new Map(), hooks=new Map(), messages=[], starts=[];
let failed=0, failCleanup=false, delegateManager;
const ctx={agents:{get:id=>live.get(id)},on:(name,fn)=>hooks.set(name,fn),logger:{warn(){}},subagents:{
  async listDescendants(id){return [...live.values()].filter(agent=>agent.session.header.parentSession===id).map(agent=>({kind:'child',id:agent.session.id}));},
  async startContinuable(spec){starts.push(spec);const agent={session:{id:spec.childId,header:{parentSession:spec.request.parent.session.id,agentPreset:'pentest',cwd:home},events:[]},inbox:{hasPending:false}};live.set(spec.childId,agent);return{childId:spec.childId,messageId:'accepted'};},
  async sendMessage(sender,id,content){messages.push({sender:sender.session.id,id,content});if(!live.has(id))live.set(id,{session:{id,header:{parentSession:sender.session.id,agentPreset:'pentest',cwd:home},events:[]},inbox:{hasPending:false}});return 'message-'+messages.length;},
  async drainContinuableChildren(parent,ids){if(failCleanup)throw Error('fixture native release failure');for(const id of ids){const agent=live.get(id);live.delete(id);if(agent)await hooks.get('agent/disposed')?.({agent});}}
}};
const root=id=>({session:{id,header:{agentPreset:'pentest',cwd:home}},ctx:{tools:{schemas:scope=>{assert.equal(scope.session.id,id,'inventory must use the actual parent scope');return ['subagent_spawn','send_message','read','nday_catalog','nday_match','nday_policy_get'].map(name=>({name}));}}}});
const site='https://fixture.test', assets=[{id:'a',url:site,inScope:true,reachable:true},{id:'b',url:'https://second.test',inScope:true,reachable:true}];
function parent(id,workers=1,target,workflow='single'){const agent=root(id);live.set(id,agent);startTaskPolicy(store,id,{mode:'regular',workflow,question:'Only the controlled document permission',...(target?{target}:{}),budget:{toolCalls:20,workers,minutes:10}});saveTaskContext(store,id,{assets});return agent;}
const delegate={site,question:'Inspect related controlled document calls',need:'large-site-materials',reason:'Separate a substantial selected bundle and its request paths'};
const settle=()=>new Promise(resolve=>setTimeout(resolve,30));
async function test(label,fn){try{await fn();console.log('ok   '+label);}catch(error){failed++;console.log('FAIL '+label+': '+error.stack);}}
let requests=0, serverMode='different';
const server=http.createServer((req,res)=>{requests++;const query=new URL(req.url,'http://fixture.test').searchParams;
  if(serverMode==='hang'&&query.get('id')==='other')return;
  if(serverMode==='blocked'){res.writeHead(403,{'content-type':'text/plain'});res.end('Your IP address has been blocked');return;}
  if(serverMode==='login'){res.writeHead(200,{'content-type':'text/html'});res.end('<form>login</form>');return;}
  res.writeHead(200,{'content-type':'text/plain'});res.end(query.get('id')==='other'&&serverMode!=='same'?'controlled other fixture document':'controlled own fixture document');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const endpoint='http://127.0.0.1:'+server.address().port+'/document', host=new URL(endpoint).host;
const row=(id,object,patch={})=>({id,revision:'v1',endpoint,authContext:'fixture-subject',kind:'web',valid:id==='normal',request:'GET /document?id='+object+' HTTP/1.1\r\nHost: '+host+'\r\nAuthorization: Fixture subject\r\n\r\n',response:'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nold normal',inputs:[{name:'id',location:'query',evidenceIds:[id]}],...patch});
const method={id:'comparison',version:'v1',endpoint,reviewed:true,definition:'Read only synthetic fixture permission, expected to forbid other objects'};
const context=()=>({assets:[{id:'asset',url:endpoint,inScope:true,reachable:true}],requests:[row('normal','own'),row('probe','other')],methods:[method]});
function research(sid){startTaskPolicy(store,sid,{mode:'0day',question:'Can fixture subject read another fixture owner document?',target:endpoint,budget:{toolCalls:20,discoveryCalls:0}});saveTaskContext(store,sid,context());createResearch(store,sid,{id:'direction',requestId:'normal',requestRevision:'v1',question:'Other owner document permission',expectedEffect:'The excluded fixture subject sees the controlled other document',negativeResult:'The other document is denied while own normal document works',nextStep:'Compare normal and other object once'});}
const pair={hypothesisId:'direction',normal:{requestId:'normal',requestRevision:'v1'},probe:{requestId:'probe',requestRevision:'v1'},methodId:method.id,methodVersion:method.version};
try{
  delegateManager=createSiteWorkers(ctx,()=>store);
  await test('local Nday reads need no invented task and do not relax target execution guards',async()=>{
    for (const name of ['nday_catalog','nday_policy_get','nday_metrics']) assert.equal(taskExecutionGuard(store,'local-only',name),undefined);
    assert.equal(readTaskPolicy(store,'local-only'),null);
    assert.match(taskExecutionGuard(store,'local-only','nday_source_fetch'),/task_policy_missing/);
    assert.match(taskExecutionGuard(store,'local-only','httpx_probe'),/task_policy_missing/);
  });
  await test('default main work creates no children; necessity, scope and zero worker budget are enforced',async()=>{
    const a=parent('no-workers',0,site);assert.equal(starts.length,0);
    await assert.rejects(delegateManager.delegate(a,{...delegate,need:'fanout'}),/specific delegation need/);
    await assert.rejects(delegateManager.delegate(a,{...delegate,site:'https://second.test'}),/cannot expand/);
    await assert.rejects(delegateManager.delegate(a,delegate),/worker limit/);assert.equal(starts.length,0);
  });
  let a,child;
  await test('same-site task reuses one native child and idle/failed-cleanup workers retain their slots',async()=>{
    a=parent('workers');child=(await delegateManager.delegate(a,delegate)).childId;
    assert.deepEqual(siteWorkerView(store,'workers'),JSON.parse(JSON.stringify(siteWorkerView(store,'workers'))),'native tool output must preserve every value through JSON');
    assert.equal((await delegateManager.delegate(a,delegate)).childId,child);assert.equal(starts.length,1);
    assert.equal(starts[0].request.maxDepth,1);assert(starts[0].request.toolFilter.deny.includes('subagent_spawn'));
    assert.deepEqual(starts[0].request.toolFilter.allow,['read']);
    await assert.rejects(delegateManager.delegate(live.get(child),delegate),/only the main/);
    await assert.rejects(delegateManager.delegate(a,{...delegate,site:'https://second.test'}),/worker limit/);
    failCleanup=true;assert.equal((await delegateManager.cleanup(a,child)).active,1);assert.equal(siteWorkerRows(store,'workers')[0].state,'cleanup-failed');
    assert.deepEqual(siteWorkerView(store,'workers'),JSON.parse(JSON.stringify(siteWorkerView(store,'workers'))));
    await assert.rejects(delegateManager.delegate(a,{...delegate,site:'https://second.test'}),/worker limit/);
    failCleanup=false;assert.equal((await delegateManager.cleanup(a,child)).active,0);assert(!live.has(child));
  });
  await test('continuation cold-resumes the same child, archives the old report, and auto-saves/releases its new final answer',async()=>{
    const old=siteWorkerRows(store,'workers')[0];old.report={state:'completed',summary:'old result'};store.db.prepare('UPDATE site_workers SET record=? WHERE child_id=?').run(JSON.stringify(old),child);
    await delegateManager.send(a,{childId:child,message:'Trace only the additional related call'});
    assert.equal(starts.length,1);assert.equal(siteWorkerRows(store,'workers')[0].report,undefined);assert.equal(siteWorkerRows(store,'workers')[0].reports[0].summary,'old result');
    const agent=live.get(child);const finalEvent={type:'assistant/message',data:{turn:2,message:{content:[{type:'text',text:'New related call checked; actual effect still unknown.'}]}}};agent.session.seq=1;agent.session.eventAt=()=>finalEvent;
    await hooks.get('agent/turn-stopping')({agent,turn:2});await settle();
    assert.equal(siteWorkerView(store,'workers').active,0);assert(!live.has(child));assert.match(siteWorkerRows(store,'workers')[0].report.summary,/New related/);
    assert(messages.some(message=>message.id==='workers'));
  });
  await test('child operations charge the parent and a parent pause immediately prevents extra child target work',async()=>{
    const p=parent('shared');const id=(await delegateManager.delegate(p,delegate)).childId;
    assert.equal(taskExecutionGuard(store,id,'fetch'),undefined);assert.equal(readTaskPolicy(store,'shared').used.toolCalls,1);
    pauseTaskPolicy(store,'shared',{code:'ip-blocked',reason:'Synthetic exit IP denial',evidence:'fixture response'});
    assert.match(taskExecutionGuard(store,id,'fetch'),/parent_task_stopped/);
    await delegateManager.cleanup(p);assert(!live.has(id));
  });
  await test('a Desktop-authorized next round rebinds the released same-site child and keeps its prior report',async()=>{
    const p=parent('rounds',1,site),id=(await delegateManager.delegate(p,delegate)).childId;
    await delegateManager.report(live.get(id),{state:'completed',summary:'Previous selected material facts saved.'});
    await hooks.get('agent/turn-stopping')({agent:live.get(id),turn:1});await settle();
    updateTaskProgress(store,p.session.id,{planComplete:true});
    const old=readTaskPolicy(store,p.session.id).startedAt;
    archiveTaskRound(store,p.session.id,'desktop-user');
    startTaskPolicy(store,p.session.id,{mode:'0day',question:'Check only the additional product prerequisite',target:site,budget:{toolCalls:8,workers:1,minutes:10,discoveryCalls:0}},old+100);
    const before=starts.length;await delegateManager.send(p,{childId:id,message:'Inspect only the newly supplied product prerequisite'});
    assert.equal(starts.length,before);assert.equal(readTaskPolicy(store,id).mode,'0day');assert.equal(readTaskPolicy(store,id).parentRound,old+100);assert.equal(readTaskPolicy(store,id).used.toolCalls,0);assert.equal(readTaskPolicy(store,id).budget.discoveryCalls,0);
    assert.equal(siteWorkerRows(store,p.session.id)[0].reports.length,1);
    assert.match(taskExecutionGuard(store,id,'fetch'),/observation_budget_exhausted/);assert.equal(readTaskPolicy(store,p.session.id).used.toolCalls,0);
    await delegateManager.cleanup(p);assert(!live.has(id));
  });
  await test('same-round regular to Nday reuses the released child and preserves consumed operations, deadline, materials and reports',async()=>{
    const p=parent('sequential-worker',1,site,'regular-to-nday');
    const file=path.join(home,'sequential.js');fs.writeFileSync(file,'fetch("./fixture");');
    indexBusinessMaterials(store,p.session.id,home,{site,files:[{path:file,url:site+'/fixture.js'}]});
    const id=(await delegateManager.delegate(p,delegate)).childId;
    for(const name of ['nday_catalog','nday_match','nday_policy_get'])assert(starts.at(-1).request.toolFilter.allow.includes(name),'persisted filter must support the approved next phase: '+name);
    assert.equal(taskExecutionGuard(store,id,'fixture_http'),undefined);
    await delegateManager.report(live.get(id),{state:'completed',summary:'Synthetic product and selected material recorded for the next phase.'});
    await hooks.get('agent/turn-stopping')({agent:live.get(id),turn:1});await settle();
    const childBefore=readTaskPolicy(store,id),parentBefore=readTaskPolicy(store,p.session.id);
    const contextBefore=readTaskContext(store,id),materialsBefore=businessMaterialView(store,id);
    const startsBefore=starts.length;
    updateTaskProgress(store,p.session.id,{regularComplete:true,note:'Continue related public product metadata only'});
    const reused=await delegateManager.delegate(p,delegate);assert.equal(reused.childId,id);assert(reused.reused);
    await delegateManager.send(p,{childId:id,message:'Reuse saved synthetic product metadata for Nday prerequisites.'});
    const childAfter=readTaskPolicy(store,id),parentAfter=readTaskPolicy(store,p.session.id);
    assert.equal(starts.length,startsBefore,'continuation must use the retained native session');
    assert.equal(childAfter.mode,'nday');assert.equal(childAfter.flow.kind,'single');
    for(const field of ['budget','used','startedAt','parentRound','parentSession','workerLimit'])assert.deepEqual(childAfter[field],childBefore[field],field);
    for(const field of ['budget','used','startedAt','target','question','workerLimit'])assert.deepEqual(parentAfter[field],parentBefore[field],field);
    assert.deepEqual(readTaskContext(store,id),contextBefore);assert.deepEqual(businessMaterialView(store,id),materialsBefore);
    assert.equal(siteWorkerRows(store,p.session.id)[0].reports.length,1);
    assert.equal(siteWorkerRows(store,p.session.id)[0].focus,'nday');
    assert.equal(taskPolicyStatus(store,id).stopped,false);
    assert.equal(taskExecutionGuard(store,id,'fixture_http'),undefined);
    assert.equal(readTaskPolicy(store,id).used.toolCalls,2);assert.equal(readTaskPolicy(store,p.session.id).used.toolCalls,2);
    await delegateManager.report(live.get(id),{state:'completed',summary:'Synthetic Nday prerequisites reviewed; no real target was contacted.'});
    await hooks.get('agent/turn-stopping')({agent:live.get(id),turn:2});await settle();
    assert.equal(siteWorkerView(store,p.session.id).active,0);
    updateTaskProgress(store,p.session.id,{ndayComplete:true});assert.equal(taskPolicyStatus(store,p.session.id).reason,'plan_complete');
  });
  await test('same-round Nday cannot revive a blocked or cancelled child or reset its exhausted budget',async()=>{
    for(const kind of ['blocked','cancelled','exhausted']){
      const p=parent('sequential-refusal-'+kind,1,site,'regular-to-nday'),id=(await delegateManager.delegate(p,delegate)).childId;
      if(kind==='blocked')pauseTaskPolicy(store,id,{code:'needs-user',reason:'Missing synthetic metadata',evidence:'offline fixture'});
      else if(kind==='cancelled')updateTaskProgress(store,id,{cancelled:true});
      else {const policy=readTaskPolicy(store,id);policy.used.toolCalls=policy.budget.toolCalls;store.db.prepare('UPDATE task_policy SET record=? WHERE session_id=?').run(JSON.stringify(policy),id);}
      await delegateManager.cleanup(p);updateTaskProgress(store,p.session.id,{regularComplete:true});
      const before=readTaskPolicy(store,id),messagesBefore=messages.length;
      await assert.rejects(delegateManager.send(p,{childId:id,message:'Continue saved metadata'}),/阻碍|blocked or exhausted/);
      assert.equal(messages.length,messagesBefore);assert.deepEqual(readTaskPolicy(store,id).budget,before.budget);assert.deepEqual(readTaskPolicy(store,id).used,before.used);
      assert.equal(siteWorkerView(store,p.session.id).active,0);
    }
  });
  await test('a deferred Nday pack refuses initial delegation before saving an incomplete native filter',async()=>{
    const p=parent('deferred-nday',1,site,'regular-to-nday');
    let loaded=false;
    p.ctx.tools.schemas=scope=>{assert.equal(scope,p);return ['read','tool_pack',...(loaded?['nday_catalog','nday_match','nday_policy_get']:[])].map(name=>({name}));};
    const before=starts.length;
    await assert.rejects(delegateManager.delegate(p,delegate),/tool_pack load nday/);
    assert.equal(starts.length,before);assert.equal(siteWorkerRows(store,p.session.id).length,0);
    loaded=true;
    const id=(await delegateManager.delegate(p,delegate)).childId;
    for(const name of ['tool_pack','nday_catalog','nday_match','nday_policy_get'])assert(starts.at(-1).request.toolFilter.allow.includes(name));
    assert.match(starts.at(-1).request.prompt[0].text,/load the local nday pack/);
    await delegateManager.cleanup(p);assert(!live.has(id));
  });
  await test('a newly delegated child inherits only the parent remaining observation allowance',async()=>{
    const p=root('remaining-observation');live.set(p.session.id,p);saveTaskContext(store,p.session.id,{assets});
    startTaskPolicy(store,p.session.id,{mode:'0day',question:'Inspect only this site prerequisite',target:site,budget:{toolCalls:8,workers:1,discoveryCalls:2}});
    assert.equal(taskExecutionGuard(store,p.session.id,'fetch'),undefined);
    const id=(await delegateManager.delegate(p,delegate)).childId;
    assert.equal(readTaskPolicy(store,id).budget.discoveryCalls,1);
    assert.equal(taskExecutionGuard(store,id,'fetch'),undefined);
    assert.match(taskExecutionGuard(store,id,'fetch'),/observation_budget_exhausted/);
    assert.equal(readTaskPolicy(store,p.session.id).used.discoveryCalls,2);
    await delegateManager.cleanup(p);assert(!live.has(id));
  });
  await test('children admitted before observation consumption cannot exceed the shared allowance',async()=>{
    const p=root('two-observers');live.set(p.session.id,p);saveTaskContext(store,p.session.id,{assets});
    startTaskPolicy(store,p.session.id,{mode:'0day',question:'Read supplied site prerequisites only',budget:{toolCalls:8,workers:2,discoveryCalls:2}});
    const first=(await delegateManager.delegate(p,delegate)).childId;
    const second=(await delegateManager.delegate(p,{...delegate,site:'https://second.test'})).childId;
    assert.equal(readTaskPolicy(store,second).budget.discoveryCalls,2);
    assert.equal(taskExecutionGuard(store,p.session.id,'fetch'),undefined);
    assert.equal(taskExecutionGuard(store,first,'fetch'),undefined);
    assert.match(taskExecutionGuard(store,second,'fetch'),/parent_observation_budget_exhausted/);
    assert.equal(readTaskPolicy(store,second).used.toolCalls,0);
    assert.equal(readTaskPolicy(store,p.session.id).used.discoveryCalls,2);
    await delegateManager.cleanup(p);assert(!live.has(first));assert(!live.has(second));
  });
  await test('two-worker admission includes preexisting native children and never deletes another parent tree',async()=>{
    const p=parent('cap',2);live.set('legacy',{session:{id:'legacy',header:{parentSession:'cap'}}});
    const id=(await delegateManager.delegate(p,delegate)).childId;
    await assert.rejects(delegateManager.delegate(p,{...delegate,site:'https://second.test'}),/worker limit/);
    await delegateManager.cleanup(p);assert(!live.has(id));assert(live.has('legacy'));live.delete('legacy');
  });
  await test('report settles before native release and immediately blocks further target operations',async()=>{
    const p=parent('report-settlement'),id=(await delegateManager.delegate(p,delegate)).childId,agent=live.get(id);
    await delegateManager.report(agent,{state:'completed',summary:'Actual child result saved; finish the final message before release.'});
    await settle();assert(live.has(id));assert.equal(siteWorkerView(store,p.session.id).active,1);
    assert.match(taskExecutionGuard(store,id,'fetch'),/worker_reported_finished/);
    await hooks.get('agent/turn-stopping')({agent,turn:1});await settle();
    assert(!live.has(id));assert.equal(siteWorkerView(store,p.session.id).active,0);
  });
  await test('parallel Nday helper inherits the shared ceiling, cannot nest, reuses one site and charges the same parent',async()=>{
    const p=parent('parallel-worker',1,site,'regular-with-nday');
    const id=(await delegateManager.delegate(p,{...delegate,focus:'nday'})).childId;
    assert.equal(readTaskPolicy(store,id).mode,'nday');assert.equal(readTaskPolicy(store,id).workerLimit,0);
    assert.equal(readTaskPolicy(store,id).flow.kind,'single');
    assert.equal((await delegateManager.delegate(p,{...delegate,focus:'regular'})).childId,id);
    assert.equal(siteWorkerView(store,'parallel-worker').active,1);
    await assert.rejects(delegateManager.delegate(live.get(id),delegate),/only the main/);
    assert.equal(taskExecutionGuard(store,id,'fetch'),undefined);assert.equal(readTaskPolicy(store,'parallel-worker').used.toolCalls,1);
    pauseTaskPolicy(store,'parallel-worker',{code:'ip-blocked',reason:'Synthetic fixture pause',evidence:'offline control'});
    assert.match(taskExecutionGuard(store,id,'fetch'),/parent_task_stopped/);
    await delegateManager.cleanup(p);assert.equal(siteWorkerView(store,'parallel-worker').active,0);
  });
  await test('offline materials reuse unchanged contents, rebase a second source, redact secrets and preserve uncovered dynamic calls',()=>{
    parent('materials',1,site);const one=path.join(home,'one.js'),two=path.join(home,'two.js');
    fs.writeFileSync(one,'fetch("./teacher?token=fixture-secret"); axios.get("./profile"); fetch(variable); const accessToken="another-secret";');fs.copyFileSync(one,two);
    const first=indexBusinessMaterials(store,'materials',home,{site,files:[{path:one,url:site+'/a/one.js'}]});assert.equal(first.indexed,1);assert(!first.text.includes('fixture-secret'));assert(!first.text.includes('another-secret'));assert.equal(first.unresolved.length,1);
    const second=indexBusinessMaterials(store,'materials',home,{site,files:[{path:two,url:site+'/a/one.js'},{path:two,url:site+'/b/two.js'}]});assert.equal(second.reused,2);
    const records=store.db.prepare('SELECT record FROM business_materials WHERE session_id=?').all('materials').map(row=>JSON.parse(row.record));
    assert.equal(records[0].file,two);assert(records[1].reusedContent);assert(records[1].hints.some(hint=>hint.candidateUrl===site+'/b/profile'));
    fs.writeFileSync(two,'changed');assert.equal(businessMaterialView(store,'materials',{id:records[0].id}).item.current,false);
    assert.throws(()=>indexBusinessMaterials(store,'materials',home,{site,files:[{path:one,url:'https://outside.test/a.js'}]}),/another site/);
  });
  let completed;
  await test('one comparison call dispatches two actual requests, records factual differences, and requires interpretation before more target work',async()=>{
    research('pair');const before=requests;completed=await runComparisonJob(store,'pair',pair);
    assert.equal(completed.state,'completed',completed.reason);assert.equal(requests-before,2);assert.equal(readTaskPolicy(store,'pair').used.toolCalls,2);
    assert.equal(completed.impactVerified,false);assert.equal(researchDetail(store,'pair','direction').observations.length,1);
    assert.throws(()=>comparisonFindingInput(store,'pair',{comparisonId:completed.id}),/interpret.*support/);
    assert.throws(()=>assessResearch(store,'pair','direction',{observationId:completed.observationId,outcome:'difference'}),/outcome must be support, counterevidence or no-information/);
    const negative = { assetId:'asset',entryId:'direction',endpoint,methodVersion:'v1',authContext:'fixture-subject',requestRevision:'v1',status:'not-hit',executed:true,requestValid:true,observationValid:true,evidenceIds:[completed.observationId],reason:'Incorrect negative for an unexplained comparison' };
    assert.throws(()=>saveChecks(store,'pair',[negative]),/不能登记为已测未命中/);
    assert.match(taskExecutionGuard(store,'pair','fetch'),/comparison_interpretation_required/);
    assert.equal((await runComparisonJob(store,'pair',pair)).cached,true);assert.equal(requests-before,2);
    assessResearch(store,'pair','direction',{observationId:completed.observationId,outcome:'support',interpretation:'The fabricated excluded object is visible; independent impact review is still required.',nextInformation:'Inspect precise business ownership evidence'});
    assert.equal(researchDetail(store,'pair','direction').state,'active');
    const input=comparisonFindingInput(store,'pair',{comparisonId:completed.id,title:'Controlled pending read',severity:'high',summary:'Recorded excluded object',impact:'Actual fabricated excluded object is visible',proofKind:'access',status:'verified'});
    assert.equal(input.status,'pending');assert.equal(input.proofKind,'access');assert(input.responsePkt.includes('controlled other fixture document'));assert.equal(JSON.parse(input.reproduction).verification.controlReceiptId,completed.steps[0].receiptId);
    const finding=registerFinding(store,'pair','pentest',input);assert.equal(finding.status,'pending');assert.equal(getFinding(store,'pair',finding.id).executionEvidence.impactVerified,false);
    assert.throws(()=>comparisonFindingInput(store,'pair',{comparisonId:completed.id,proofKind:'execution'}),/never write or execution/);
    assert.throws(()=>comparisonFindingInput(store,'another-session',{comparisonId:completed.id}),/plain pair-UUID/);
    assert.equal(comparisonFindingInput(store,'pair',{comparisonId:completed.observationId}).reproduction,input.reproduction,'a current observation ID resolves only to its own saved comparison');
    assert.throws(()=>saveChecks(store,'pair',[negative]),/不能登记为已测未命中/);
    store.db.prepare('INSERT INTO checked_items(session_id,context_key,record,updated_at) VALUES(?,?,?,?)').run('pair',checkedKey(negative),JSON.stringify(negative),new Date().toISOString());
    assert.equal(readChecks(store,'pair')[0].status,'blocked','historical false negatives must not be exported as current');
    assert.equal(readChecks(store,'pair')[0].classificationCurrent,false);
    assert.throws(()=>assessResearch(store,'pair','direction',{observationId:completed.observationId,outcome:'support'}),/once/);
    assert.equal(taskPolicyStatus(store,'pair').stopped,false);
  });
  await test('non-JSON effects remain pending until explicit Desktop review, and changed evidence revokes that review',()=>{
    const ids=completed.steps.map(step=>step.receiptId),normal=readExecutionReceipt(store,'pair',ids[0]),probe=readExecutionReceipt(store,'pair',ids[1]);
    const reproduction={kind:'method',mechanism:'controlled document permission',methodId:method.id,methodVersion:method.version,endpoint,
      prerequisites:[],dependencies:[],parameters:[],steps:['Read the controlled own and excluded fixture documents.'],successCriterion:'Excluded private fixture document is visible',reviewSteps:'Independently compare fixture role and object ownership',recovery:'Read only, no state changes',verification:{status:'verified',evidenceIds:ids,controlReceiptId:normal.id,probeReceiptId:probe.id}};
    const registered=registerFinding(store,'pair','pentest',{title:'Synthetic document permission',type:'fixture-permission',target:endpoint,identity:'fixture-subject',severity:'high',proofKind:'access',impact:'Fabricated excluded document is visible',evidence:ids.join(','),evidenceLevel:'impact',requestPkt:probe.request.trim(),responsePkt:(probe.responseHead+Buffer.from(probe.responseBodyBase64,'base64').toString()).trim(),reproduction:JSON.stringify(reproduction)});
    let finding=getFinding(store,'pair',registered.id);assert(finding.executionEvidence.verified);assert.equal(finding.executionEvidence.impactVerified,false);
    const review={receiptIds:ids,permissionsConfirmed:true,impactConfirmed:true,note:'In this isolated fixture I independently checked the excluded role, controlled document ownership and actual plain-text disclosure; this is no RCE and no real user data.'};
    assert.throws(()=>recordImpactReview(store,'pair',finding,review,'model'),/Desktop/);
    recordImpactReview(store,'pair',finding,review,'desktop-action');finding=getFinding(store,'pair',registered.id);assert.equal(finding.executionEvidence.impactVerified,true);assert.equal(finding.executionEvidence.effectEvidence.source,'desktop-impact-review');
    saveTaskContext(store,'pair',{...context(),requests:[row('normal','own'),row('probe','other',{revision:'v2'})]});
    assert.equal(getFinding(store,'pair',registered.id).executionEvidence.impactVerified,false);
  });
  await test('explicit IP blocking stops the batch at its normal request and restoration requires a real baseline recheck',async()=>{
    serverMode='blocked';research('blocked');const before=requests;const result=await runComparisonJob(store,'blocked',pair);
    assert.equal(result.state,'interrupted');assert.equal(requests-before,1);assert.equal(taskPolicyStatus(store,'blocked').reason,'paused:ip-blocked');
    assert.deepEqual(result,JSON.parse(JSON.stringify(result)),'interrupted comparison must be lossless JSON at the native tool boundary');
    assert.match(taskExecutionGuard(store,'blocked','fetch'),/paused/);assert.throws(()=>resumeTaskPolicy(store,'blocked','fixed','model'),/user/);
    resumeTaskPolicy(store,'blocked','Restored the fabricated fixture access','desktop-user');assert.match(taskExecutionGuard(store,'blocked','fetch'),/baseline_recheck_required/);
    serverMode='login';const login=await executeRecordedRequest(store,'blocked',{purpose:'baseline',requestId:'normal',requestRevision:'v1'});assert(login.taskPaused);assert.equal(login.blocker,'normal-access-failed');
    resumeTaskPolicy(store,'blocked','Restored plain text fixture response','desktop-user');serverMode='different';const good=await executeRecordedRequest(store,'blocked',{purpose:'baseline',requestId:'normal',requestRevision:'v1'});assert.equal(good.status,200);assert.equal(readTaskPolicy(store,'blocked').needsBaselineRecheck,false);assert.equal(readTaskPolicy(store,'blocked').used.toolCalls,3);
  });
  await test('cancelling a captured comparison interrupts the socket, preserves partial evidence and refuses an automatic resend',async()=>{
    serverMode='hang';research('abort');const controller=new AbortController();const pending=runComparisonJob(store,'abort',pair,controller.signal);
    const timer=setTimeout(()=>controller.abort(),80);const result=await pending;clearTimeout(timer);
    assert.equal(result.state,'interrupted');assert.equal(result.attemptedRequests,2);assert.equal(readExecutionReceipt(store,'abort',result.steps[1].receiptId).outcome,'interrupted');
    const before=requests;assert.equal((await runComparisonJob(store,'abort',pair)).cached,true);assert.equal(requests,before);
  });
  await test('enabled method catalog stays compact while selected current user methods are fetched exactly on demand',async()=>{
    const stack=await import('../plugins/dsh-method-stack/lib/index.js'),catalog=stack.fullCatalog(),all=catalog.flatMap(group=>group.methods.map(method=>group.group+'/'+method.id));
    const profile=path.join(home,'method-stack/profiles/pentest.json');fs.mkdirSync(path.dirname(profile),{recursive:true});fs.writeFileSync(profile,JSON.stringify({active:all,rev:3,combos:{}}));
    const tools=new Map(),contexts=[];stack.apply({tools:{register:tool=>tools.set(tool.name,tool)},agentPresets:{composedPreset:()=> 'pentest'},systemPrompt:{context:item=>contexts.push(item),section(){}},logger:{warn(){}},connection:null});
    const full=stack.renderActive('pentest'),compact=contexts[0].text({agent:{ctx:{}}});assert(Buffer.byteLength(compact)<Buffer.byteLength(full.text));assert(!compact.includes(catalog[0].methods[0].prompt));
    const read=await tools.get('saker_method').execute({action:'read',key:all[0]},{agent:{ctx:{}}});assert(read.ok,read.error);assert.equal(read.prompt,catalog[0].methods[0].prompt.slice(0,6000));
    assert.equal((await tools.get('saker_method').execute({action:'read',key:'absent/method'},{agent:{ctx:{}}})).ok,false);
  });
}finally{await delegateManager?.dispose();store.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
process.exitCode=failed?1:0;
