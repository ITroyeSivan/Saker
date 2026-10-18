import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { openStore, registerFinding, getFinding } from '../plugins/dsh-redteam-results/lib/store.js';
import { saveTaskContext, readTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js';
import { startTaskPolicy, readTaskPolicy, taskPolicyStatus, taskExecutionGuard, pauseTaskPolicy, resumeTaskPolicy, updateTaskProgress, archiveTaskRound, chooseTaskMode, setTaskActionLimits, targetTrafficDenial, excludedPathDenial, normalizeExcludedPaths } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { createSiteWorkers, siteWorkerRows, siteWorkerView } from '../plugins/dsh-redteam-results/lib/site-workers.js';
import { saveChatDefaults } from '../plugins/dsh-redteam-results/lib/chat-setup.js';
import { setTaskInteraction } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { indexBusinessMaterials, businessMaterialView } from '../plugins/dsh-redteam-results/lib/business-materials.js';
import { createResearch, researchDetail, assessResearch } from '../plugins/dsh-redteam-results/lib/research.js';
import { runComparisonJob, comparisonFindingInput } from '../plugins/dsh-redteam-results/lib/comparison-jobs.js';
import { stageMethodClassification } from '../plugins/dsh-redteam-results/lib/method-classification.js';
import { readExecutionReceipt, executeRecordedRequest } from '../plugins/dsh-redteam-results/lib/execution-receipts.js';
import { requestPacingOf, normalizeRequestRate, normalizeRequestConcurrency, acquireTargetSlot, resetRequestPacing } from '../plugins/dsh-redteam-results/lib/request-pacing.js';
import { recordImpactReview } from '../plugins/dsh-redteam-results/lib/impact-reviews.js';
import { saveChecks, readChecks, checkedKey } from '../plugins/dsh-redteam-results/lib/checked.js';
const home=process.env.DSH_HOME, store=openStore(path.join(home,'results.db')), live=new Map(), hooks=new Map(), messages=[], starts=[];
let failed=0, failCleanup=false, delegateManager;
const ctx={agents:{get:id=>live.get(id)},on:(name,fn)=>hooks.set(name,fn),logger:{warn(){}},subagents:{
  async listDescendants(id){return [...live.values()].filter(agent=>agent.session.header.parentSession===id).map(agent=>({kind:'child',id:agent.session.id}));},
  async startActivation(spec){starts.push(spec);const agent={session:{id:spec.childId,header:{parentSession:spec.request.parent.session.id,agentPreset:'pentest',cwd:home},events:[]},inbox:{hasPending:false}};live.set(spec.childId,agent);return{childId:spec.childId,messageId:'accepted',result:new Promise(()=>{}),dispose:()=>ctx.subagents.drainChildren(spec.request.parent,[spec.childId])};},
  async sendMessage(sender,id,content){messages.push({sender:sender.session.id,id,content});if(!live.has(id))live.set(id,{session:{id,header:{parentSession:sender.session.id,agentPreset:'pentest',cwd:home},events:[]},inbox:{hasPending:false}});return 'message-'+messages.length;},
  async drainChildren(parent,ids){if(failCleanup)throw Error('fixture native release failure');for(const id of ids){const agent=live.get(id);live.delete(id);if(agent)await hooks.get('agent/disposed')?.({agent});}}
}};
const root=id=>({session:{id,header:{agentPreset:'pentest',cwd:home}},ctx:{tools:{schemas:scope=>{assert.equal(scope.session.id,id,'inventory must use the actual parent scope');return ['subagent_spawn','send_message','read','redteam_execution','nday_catalog','nday_match','nday_policy_get'].map(name=>({name}));}}}});
const site='https://fixture.test', assets=[{id:'a',url:site,inScope:true,reachable:true},{id:'b',url:'https://second.test',inScope:true,reachable:true}];
function parent(id,workers=1,target,workflow='single'){const agent=root(id);live.set(id,agent);startTaskPolicy(store,id,{mode:'regular',workflow,question:'Only the controlled document permission',...(target?{target}:{}),budget:{toolCalls:20,workers,minutes:10}});saveTaskContext(store,id,{assets});return agent;}
const delegate={site,question:'Inspect related controlled document calls',need:'large-site-materials',reason:'Separate a substantial selected bundle and its request paths'};
const settle=()=>new Promise(resolve=>setTimeout(resolve,30));
/** 轮询等待某个条件成立；返回是否在期限内成立，并给出实际耗时。 */
async function waitFor(predicate, timeoutMs = 6000, stepMs = 100) {
  const started = Date.now();
  for (;;) {
    if (predicate()) return { ok: true, ms: Date.now() - started };
    if (Date.now() - started >= timeoutMs) return { ok: false, ms: Date.now() - started };
    await new Promise(resolve => setTimeout(resolve, stepMs));
  }
}
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
// 结构化对照必须绑定一个已分类方法：它的分类决定可用模块（B02）。
stageMethodClassification(store, { schema: 'saker.method-classification/1', id: method.id, version: method.version,
  digest: 'e'.repeat(64), revision: 1, modules: ['exploit/access-control'], status: 'verified',
  source: { kind: 'manual', version: method.version, position: 'test-framework-runtime fixture' } });
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
  await test('action limits close site access and data changes without blocking local reads',async()=>{
    const id='action-limits'; parent(id,1,site);
    let policy=readTaskPolicy(store,id);
    assert.equal(policy.allowTargetNetwork,true,'默认允许访问网站');assert.equal(policy.readOnly,false,'默认不改动网站数据');
    // 默认：未计量扫描器仍按原额度规则拒绝（不是被网络开关拦下）
    assert.match(taskExecutionGuard(store,id,'httpx_probe'),/unmetered_target_traffic/);
    // 关闭“允许访问网站”：目标流量工具一律拒绝，本地读取与规划类不受影响
    setTaskActionLimits(store,id,{allowTargetNetwork:false},'desktop-user');
    assert.equal(readTaskPolicy(store,id).allowTargetNetwork,false);
    assert.match(taskExecutionGuard(store,id,'httpx_probe'),/target_network_disabled/);
    assert.match(taskExecutionGuard(store,id,'send_http1_request'),/target_network_disabled/);
    assert.match(taskExecutionGuard(store,id,'nday_match',Date.now(),{args:{targets:endpoint,scope:host,entryIds:'fixture'}}),/target_network_disabled/,'Nday 目标探针不能绕过网站访问开关');
    assert.match(taskExecutionGuard(store,id,'pwsh',Date.now(),{args:{command:'curl https://fixture.test/document'}}),/target_network_disabled/);
    assert.equal(taskExecutionGuard(store,id,'zday_pattern'),undefined,'规划类工具不访问站点');
    assert.equal(taskExecutionGuard(store,id,'knowledge_search'),undefined,'知识库检索仍可用');
    assert.equal(taskExecutionGuard(store,id,'nday_source_fetch'),undefined,'外部公告查阅不访问被测站点');
    assert.equal(taskExecutionGuard(store,id,'read'),undefined,'本地读取不受网络限制');
    // redteam_execution 是本地入口（真正目标请求走执行适配器）：关闭网站访问后由适配器拒绝
    const get=row('readonly-get','own');
    saveTaskContext(store,id,{assets:[{id:'asset',url:endpoint,inScope:true,reachable:true}],requests:[get],methods:[]});
    await assert.rejects(executeRecordedRequest(store,id,{requestId:'readonly-get',requestRevision:'v1',hypothesisId:'x'}),/target_network_disabled/);
    // 重新打开网站访问，只读限制生效：写方法被适配器在发请求前拒绝
    setTaskActionLimits(store,id,{allowTargetNetwork:true,readOnly:true},'desktop-user');
    policy=readTaskPolicy(store,id);
    assert.equal(policy.allowTargetNetwork,true);assert.equal(policy.readOnly,true);
    assert.equal(targetTrafficDenial(policy,{method:'GET'}),undefined);
    assert.match(targetTrafficDenial(policy,{method:'POST'}),/read_only_target/);
    const write={id:'write',revision:'v1',endpoint,authContext:'fixture-subject',kind:'web',valid:false,
      request:'POST /document HTTP/1.1\r\nHost: '+host+'\r\nAuthorization: Fixture subject\r\nContent-Length: 0\r\n\r\n',
      response:'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nok',inputs:[]};
    saveTaskContext(store,id,{assets:[{id:'asset',url:endpoint,inScope:true,reachable:true}],requests:[write],methods:[]});
    await assert.rejects(executeRecordedRequest(store,id,{requestId:'write',requestRevision:'v1',hypothesisId:'x'}),/read_only_target/);
    // 只读限制不影响 GET：仍然走到“缺研究方向”这类后续校验，而不是被动作限制拦下
    saveTaskContext(store,id,{assets:[{id:'asset',url:endpoint,inScope:true,reachable:true}],requests:[get],methods:[]});
    await assert.rejects(executeRecordedRequest(store,id,{requestId:'readonly-get',requestRevision:'v1',hypothesisId:'x'}),
      error=>!/read_only_target/.test(error.message));
    // 尚未开始的任务：限制先记在选择里，开始时带进策略（test.content 全不选联动走这条）
    setTaskActionLimits(store,'limits-later',{allowTargetNetwork:false,readOnly:true},'test-content-empty');
    chooseTaskMode(store,'limits-later','regular',{workers:1});
    startTaskPolicy(store,'limits-later',{mode:'regular',question:'还没开始就先关网站访问',target:site,budget:{toolCalls:5}});
    const later=readTaskPolicy(store,'limits-later');
    assert.equal(later.allowTargetNetwork,false,'未开始时的限制要带进策略');
    assert.equal(later.readOnly,true,'未开始时的只读限制要带进策略');
    // 排除路径：规范化、按路径前缀带边界匹配、命中即在适配器拒绝
    assert.deepEqual(normalizeExcludedPaths('payment\n/api/delete\nhttps://other.test/keep'),['/payment','/api/delete','https://other.test/keep']);
    assert.deepEqual(normalizeExcludedPaths(['/a','/a','  ','/b']),['/a','/b']);
    setTaskActionLimits(store,id,{excludedPaths:'/document'},'desktop-user');
    const excluded=readTaskPolicy(store,id);
    assert.deepEqual(excluded.excludedPaths,['/document']);
    assert.match(excludedPathDenial(excluded,{url:endpoint+'?id=own'}),/excluded_path/);
    assert.match(excludedPathDenial(excluded,{url:endpoint+'/child'}),/excluded_path/,'子路径也要命中');
    assert.equal(excludedPathDenial(excluded,{url:endpoint.replace('/document','/documents')}),undefined,'按路径边界，不误伤 /documents');
    assert.equal(excludedPathDenial(excluded,{url:endpoint.replace('/document','/other')}),undefined);
    saveTaskContext(store,id,{assets:[{id:'asset',url:endpoint,inScope:true,reachable:true}],requests:[get],methods:[]});
    await assert.rejects(executeRecordedRequest(store,id,{requestId:'readonly-get',requestRevision:'v1',hypothesisId:'x'}),/excluded_path/,'适配器必须拒绝被排除的路径');
  });
  // 2026-10-18 完整任务实测暴露：模型用 Yakit MCP 的 batch_do_http_request（args 带 base-url + 一批 paths）
  // 向目标发了 68 次请求，只留下 3 条执行回执。MCP/shell 必须和扫描器走同一未计量额度与网络开关。
  await test('MCP calls carrying an authorized-scope URL obey the same traffic admission as scanners and shell',async()=>{
    const mcpArgs={server:'yakit',tool:'batch_do_http_request',args:{'base-url':site,method:'GET',paths:'/a\n/b',concurrent:8}};
    // 不带目标 URL 的 MCP 调用（编解码之类）照常放行
    const id='mcp-blocked';
    startTaskPolicy(store,id,{mode:'regular',question:'MCP traffic admission',target:site,budget:{toolCalls:20,unmeteredToolCalls:0}});
    saveTaskContext(store,id,{assets:[{id:'asset',url:site,inScope:true,reachable:true}],requests:[],methods:[]});
    assert.equal(taskExecutionGuard(store,id,'mcp_call',Date.now(),{args:{server:'burp',tool:'base64_encode',args:{content:'saker'}}}),undefined,
      '不含目标 URL 的 MCP 调用不该被目标流量闸拦下');
    assert.match(taskExecutionGuard(store,id,'mcp_call',Date.now(),{args:mcpArgs}),/unmetered_target_traffic/,
      '带授权范围 URL 的 MCP 批量请求必须先有显式未计量额度');
    // 显式允许一次：第一次放行并计入未计量用量，第二次额度用完拒绝
    const allowed='mcp-allowed';
    startTaskPolicy(store,allowed,{mode:'regular',question:'MCP traffic admission with allowance',target:site,budget:{toolCalls:20,unmeteredToolCalls:1}});
    saveTaskContext(store,allowed,{assets:[{id:'asset',url:site,inScope:true,reachable:true}],requests:[],methods:[]});
    assert.equal(taskExecutionGuard(store,allowed,'mcp_call',Date.now(),{args:mcpArgs}),undefined);
    assert.equal(readTaskPolicy(store,allowed).used.unmeteredToolCalls,1);
    assert.match(taskExecutionGuard(store,allowed,'mcp_call',Date.now(),{args:mcpArgs}),/unmetered_traffic_budget_exhausted/);
    // 关闭“允许访问网站”后，同一调用被网络开关拦下（而不是只靠模型自觉）
    setTaskActionLimits(store,allowed,{allowTargetNetwork:false},'desktop-user');
    assert.match(taskExecutionGuard(store,allowed,'mcp_call',Date.now(),{args:mcpArgs}),/target_network_disabled/);
    // 授权范围之外的 URL 不属于本任务目标流量
    assert.match(taskExecutionGuard(store,id,'mcp_call',Date.now(),{args:{server:'yakit',tool:'batch_do_http_request',args:{'base-url':'https://outside.example.invalid',paths:'/a'}}}),/unmetered_target_traffic/);
  });
  await test('request pacing throttles target requests only when the user sets a limit',async()=>{
    const id='pacing'; parent(id,1,site);
    assert.deepEqual(requestPacingOf({}),{minIntervalMs:0,concurrency:Infinity},'留空不额外收紧');
    assert.deepEqual(requestPacingOf({requestRatePerMinute:60,requestConcurrency:2}),{minIntervalMs:1000,concurrency:2});
    assert.throws(()=>normalizeRequestRate(0),/1–600/);
    assert.throws(()=>normalizeRequestConcurrency(17),/1–16/);
    resetRequestPacing();
    setTaskActionLimits(store,id,{requestRatePerMinute:120,requestConcurrency:1},'desktop-user');
    const policy=readTaskPolicy(store,id);
    assert.equal(policy.requestRatePerMinute,120);assert.equal(policy.requestConcurrency,1);
    const t0=Date.now();
    const first=await acquireTargetSlot(id,policy);first();
    const second=await acquireTargetSlot(id,policy);second();
    assert(Date.now()-t0>=450,'120/分钟 → 最小间隔 500ms，两次请求之间要排队');
    // 并发上限 1：占着名额时第二个请求必须等，释放后通过
    resetRequestPacing();
    const hold=await acquireTargetSlot(id,policy);
    let got=false;
    const pending=acquireTargetSlot(id,policy).then(release=>{got=true;release();});
    await new Promise(resolve=>setTimeout(resolve,120));
    assert.equal(got,false,'并发上限 1 时第二个请求必须排队');
    hold();
    await pending;
    assert.equal(got,true,'释放名额后排队请求要通过');
  });
  await test('dependency bookkeeping remains usable without a target policy and after cancellation',async()=>{
    const names=['operation_goal','operation_scope','operation_intent','operation_task','operation_progress','operation_constraints','operation_conclude','stage_gate','gates_list'];
    // 批次 A：这些工具已退出运行，任何会话都直接拒绝，且不写入任务台账。
    for(const name of names)assert.match(taskExecutionGuard(store,'ledger-only',name),/retired_tool/);
    assert.equal(readTaskPolicy(store,'ledger-only'),null);
    assert.match(taskExecutionGuard(store,'ledger-only','httpx_probe'),/task_policy_missing/);
    parent('ledger-stopped');updateTaskProgress(store,'ledger-stopped',{cancelled:true});
    const before=readTaskPolicy(store,'ledger-stopped');
    for(const name of names)assert.match(taskExecutionGuard(store,'ledger-stopped',name),/retired_tool/);
    assert.deepEqual(readTaskPolicy(store,'ledger-stopped'),before);
    assert.match(taskExecutionGuard(store,'ledger-stopped','httpx_probe'),/任务已停止/);
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
    assert.equal(starts[0].request.maxDepth,1);assert.equal(starts[0].delivery,'parent');
    const workerRow=siteWorkerRows(store,'workers').find(row=>row.childId===child);
    assert(workerRow.allowedTools.includes('read'));assert(!workerRow.allowedTools.includes('subagent_spawn'));
    await assert.rejects(delegateManager.delegate(live.get(child),delegate),/only the main/);
    await assert.rejects(delegateManager.delegate(a,{...delegate,site:'https://second.test'}),/worker limit/);
    failCleanup=true;assert.equal((await delegateManager.cleanup(a,child)).active,1);assert.equal(siteWorkerRows(store,'workers')[0].state,'cleanup-failed');
    assert.deepEqual(siteWorkerView(store,'workers'),JSON.parse(JSON.stringify(siteWorkerView(store,'workers'))));
    await assert.rejects(delegateManager.delegate(a,{...delegate,site:'https://second.test'}),/worker limit/);
    failCleanup=false;assert.equal((await delegateManager.cleanup(a,child)).active,0);assert(!live.has(child));
  });
  await test('站点子代理按用户选择的模型覆盖 agentOptions，未选时不覆盖',async()=>{
    // 后续用例对 starts/messages 的绝对计数有断言，用完还原这两条共享记录并释放子代理。
    const startsBefore=starts.length,messagesBefore=messages.length;
    try{
      const withModel='worker-model';
      chooseTaskMode(store,withModel,'regular',{workers:1,interaction:'auto',workerModel:{provider:'allowed-provider',model:'allowed-model'}});
      assert.equal(readTaskPolicy(store,withModel),null,'选择模型不应自己开任务');
      const agent=parent(withModel,1,site);
      await delegateManager.delegate(agent,delegate);
      assert.deepEqual(starts.at(-1).request.agentOptions,{provider:'allowed-provider',model:'allowed-model'},'选了模型就要带上 agentOptions');
      await delegateManager.cleanup(agent);
      const without='worker-model-none';const plain=parent(without,1,site);
      await delegateManager.delegate(plain,delegate);
      assert.equal(starts.at(-1).request.agentOptions,undefined,'没选模型就不覆盖，沿用当前会话模型');
      await delegateManager.cleanup(plain);
    }finally{starts.length=startsBefore;messages.length=messagesBefore;}
  });
  await test('two concurrent admissions for one site create exactly one native child',async()=>{
    // G3「并发双领」：同一站点同时被领取两次时，只能有一个原生子代理被创建。
    // 内存锁（locks）与 DB 的 UNIQUE(parent_session, site) 是两道防线，这里验行为。
    // 本用例前面对 starts/messages 的绝对计数有断言，所以用完把这两条共享记录还原。
    const startsBefore=starts.length,messagesBefore=messages.length;
    try{
      const race=parent('race',2);
      const settled=await Promise.allSettled([delegateManager.delegate(race,delegate),delegateManager.delegate(race,delegate)]);
      assert.equal(settled.length,2);
      const fulfilled=settled.filter(row=>row.status==='fulfilled');
      const rejected=settled.filter(row=>row.status==='rejected');
      assert(fulfilled.length>=1,'at least one admission must succeed');
      const children=new Set(fulfilled.map(row=>row.value.childId));
      assert.equal(children.size,1,'one site must never end up with two children from a race');
      assert.equal(siteWorkerRows(store,'race').filter(row=>row.state!=='released').length,1);
      for(const row of rejected) assert.match(String(row.reason&&row.reason.message),/delegation already in progress|worker limit/);
      assert.equal(starts.filter(spec=>spec.request&&spec.request.parent&&spec.request.parent.session.id==='race').length,1,
        'the native starter must run once for a racing pair');
      await delegateManager.cleanup(race);
    }finally{starts.length=startsBefore;messages.length=messagesBefore;}
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
    assert.equal(taskExecutionGuard(store,id,'recorded-http-execution'),undefined);assert.equal(readTaskPolicy(store,'shared').used.toolCalls,1);
    pauseTaskPolicy(store,'shared',{code:'ip-blocked',reason:'Synthetic exit IP denial',evidence:'fixture response'});
    assert.match(taskExecutionGuard(store,id,'recorded-http-execution'),/parent_task_stopped/);
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
    assert.match(taskExecutionGuard(store,id,'recorded-http-execution'),/observation_budget_exhausted/);assert.equal(readTaskPolicy(store,p.session.id).used.toolCalls,0);
    await delegateManager.cleanup(p);assert(!live.has(id));
  });
  await test('same-round regular to Nday reuses the released child and preserves consumed operations, deadline, materials and reports',async()=>{
    const p=parent('sequential-worker',1,site,'regular-to-nday');
    const file=path.join(home,'sequential.js');fs.writeFileSync(file,'fetch("./fixture");');
    indexBusinessMaterials(store,p.session.id,home,{site,files:[{path:file,url:site+'/fixture.js'}]});
    const id=(await delegateManager.delegate(p,delegate)).childId;
    for(const name of ['nday_catalog','nday_match','nday_policy_get'])assert(siteWorkerRows(store,p.session.id).at(-1).allowedTools.includes(name),'persisted filter must support the approved next phase: '+name);
    assert.equal(taskExecutionGuard(store,id,'recorded-http-execution'),undefined);
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
    assert.equal(taskExecutionGuard(store,id,'recorded-http-execution'),undefined);
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
    for(const name of ['tool_pack','nday_catalog','nday_match','nday_policy_get'])assert(siteWorkerRows(store,p.session.id).at(-1).allowedTools.includes(name));
    assert.match(starts.at(-1).request.prompt[0].text,/load the local nday pack/);
    await delegateManager.cleanup(p);assert(!live.has(id));
  });
  await test('a newly delegated child inherits only the parent remaining observation allowance',async()=>{
    const p=root('remaining-observation');live.set(p.session.id,p);saveTaskContext(store,p.session.id,{assets});
    startTaskPolicy(store,p.session.id,{mode:'0day',question:'Inspect only this site prerequisite',target:site,budget:{toolCalls:8,workers:1,discoveryCalls:2}});
    assert.equal(taskExecutionGuard(store,p.session.id,'recorded-http-execution'),undefined);
    const id=(await delegateManager.delegate(p,delegate)).childId;
    assert.equal(readTaskPolicy(store,id).budget.discoveryCalls,1);
    assert.equal(taskExecutionGuard(store,id,'recorded-http-execution'),undefined);
    assert.match(taskExecutionGuard(store,id,'recorded-http-execution'),/observation_budget_exhausted/);
    assert.equal(readTaskPolicy(store,p.session.id).used.discoveryCalls,2);
    await delegateManager.cleanup(p);assert(!live.has(id));
  });
  await test('children admitted before observation consumption cannot exceed the shared allowance',async()=>{
    const p=root('two-observers');live.set(p.session.id,p);saveTaskContext(store,p.session.id,{assets});
    startTaskPolicy(store,p.session.id,{mode:'0day',question:'Read supplied site prerequisites only',budget:{toolCalls:8,workers:2,discoveryCalls:2}});
    const first=(await delegateManager.delegate(p,delegate)).childId;
    const second=(await delegateManager.delegate(p,{...delegate,site:'https://second.test'})).childId;
    assert.equal(readTaskPolicy(store,second).budget.discoveryCalls,2);
    assert.equal(taskExecutionGuard(store,p.session.id,'recorded-http-execution'),undefined);
    assert.equal(taskExecutionGuard(store,first,'recorded-http-execution'),undefined);
    assert.match(taskExecutionGuard(store,second,'recorded-http-execution'),/parent_observation_budget_exhausted/);
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

  await test('worker scope initialization failure refuses the child instead of warning and continuing', async () => {
    const p = parent('scope-failure', 1, site);
    const originalSchemas = p.ctx.tools.schemas;
    const originalRestrict = p.ctx.tools.restrict;
    const originalStart = ctx.subagents.startActivation;
    p.ctx.tools.schemas = () => ['read', 'pwsh', 'subagent_spawn'].map(name => ({ name }));
    p.ctx.tools.restrict = () => { throw new Error('unknown global tool "pwsh"'); };
    ctx.subagents.startActivation = async spec => {
      const agent = { session: { id: spec.childId, header: { parentSession: p.session.id, agentPreset: 'pentest', cwd: home }, events: [] },
        inbox: { hasPending: false }, ctx: { tools: p.ctx.tools } };
      live.set(spec.childId, agent);
      await hooks.get('agent/created')?.({ agent });
      return { childId: spec.childId, messageId: 'accepted' };
    };
    try {
      await assert.rejects(delegateManager.delegate(p, delegate), /tool scope initialization failed/);
      assert.equal(siteWorkerRows(store, p.session.id).every(row => row.state !== 'running'), true, 'failed scope must not leave a running worker');
    } finally {
      p.ctx.tools.schemas = originalSchemas;
      p.ctx.tools.restrict = originalRestrict;
      ctx.subagents.startActivation = originalStart;
      await delegateManager.cleanup(p);
    }
  });
  await test('report settles before native release and immediately blocks further target operations',async()=>{
    const p=parent('report-settlement'),id=(await delegateManager.delegate(p,delegate)).childId,agent=live.get(id);
    await delegateManager.report(agent,{state:'completed',summary:'Actual child result saved; finish the final message before release.'});
    await settle();assert(live.has(id));assert.equal(siteWorkerView(store,p.session.id).active,1);
    assert.match(taskExecutionGuard(store,id,'recorded-http-execution'),/worker_reported_finished/);
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
    assert.equal(taskExecutionGuard(store,id,'recorded-http-execution'),undefined);assert.equal(readTaskPolicy(store,'parallel-worker').used.toolCalls,1);
    pauseTaskPolicy(store,'parallel-worker',{code:'ip-blocked',reason:'Synthetic fixture pause',evidence:'offline control'});
    assert.match(taskExecutionGuard(store,id,'recorded-http-execution'),/parent_task_stopped/);
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
    assert.match(taskExecutionGuard(store,'pair','recorded-http-execution'),/comparison_interpretation_required/);
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
  await test('plain comparison needs no method package, but a partial method binding is refused with the field contract',async()=>{
    // J11 实测：把已审阅方法设成 run-pair 硬门槛后，全新 profile（没有方法包）永远跑不了对照，
    // 模型只能去文件系统考古。普通对照只重放两条已存 GET/HEAD，不应要求方法包。
    research('pair-nomethod');const before=requests;
    const plain=await runComparisonJob(store,'pair-nomethod',{hypothesisId:'direction',normal:pair.normal,probe:pair.probe});
    assert.equal(plain.state,'completed',plain.reason);assert.equal(requests-before,2);
    assert.equal(readTaskPolicy(store,'pair-nomethod').used.toolCalls,2);
    assert.equal(researchDetail(store,'pair-nomethod','direction').observations.length,1);
    await assert.rejects(()=>runComparisonJob(store,'pair-nomethod',{hypothesisId:'direction',normal:pair.normal,probe:pair.probe,methodId:method.id}),/必须同时提供/,'只给 methodId 不给 methodVersion 要说清契约');
    await assert.rejects(()=>runComparisonJob(store,'pair-nomethod',{hypothesisId:'direction',normal:pair.normal,probe:pair.probe,methodId:'not-reviewed',methodVersion:'v1'}),/reviewed method identity/,'带未审阅方法时要给可读拒绝理由');
    assert.equal(requests-before,2,'被拒的绑定尝试不发请求');
  });
  await test('query-varied probe endpoints stay comparable while path changes are refused with actual values',async()=>{
    // J11b 实测：模型把 endpoint 存成完整 URL（含 ?q=），run-pair 用整串相等比较后
    // 任何"正常 vs 受控输入"对照都被挡死。同 origin+同 pathname 才该放行，查询参数可变。
    const varied={...row('probe-q','other'),endpoint:endpoint+'?id=other'};
    const other={...row('probe-other','other'),endpoint:endpoint.replace('/document','/other')+'?id=other',
      request:'GET /other?id=other HTTP/1.1\r\nHost: '+host+'\r\nAuthorization: Fixture subject\r\n\r\n'};
    const normalQ={...row('normal-q','own'),valid:true};
    startTaskPolicy(store,'pair-query',{mode:'0day',question:'Query-varied controlled fixture',target:endpoint,budget:{toolCalls:20,discoveryCalls:0}});
    saveTaskContext(store,'pair-query',{assets:[{id:'asset',url:endpoint,inScope:true,reachable:true}],requests:[normalQ,varied,other],methods:[]});
    createResearch(store,'pair-query',{id:'direction',requestId:'normal-q',requestRevision:'v1',question:'Query variation changes the controlled document',expectedEffect:'Controlled other document appears',negativeResult:'Identical own document',nextStep:'Compare once'});
    const before=requests;
    const done=await runComparisonJob(store,'pair-query',{hypothesisId:'direction',normal:{requestId:'normal-q',requestRevision:'v1'},probe:{requestId:'probe-q',requestRevision:'v1'}});
    assert.equal(done.state,'completed',done.reason);assert.equal(requests-before,2);
    await assert.rejects(()=>runComparisonJob(store,'pair-query',{hypothesisId:'direction',normal:{requestId:'normal-q',requestRevision:'v1'},probe:{requestId:'probe-other',requestRevision:'v1'}}),/same endpoint path and identity/, '不同路径必须拒绝');
    assert.equal(requests-before,2,'被拒的路径变化不发请求');
    // J11d 实测：探针请求常常不写 inputs，jobKey 的 row.inputs.map 曾抛原始 TypeError。
    const bare={...row('probe-bare','other'),endpoint:endpoint+'?id=other'};delete bare.inputs;
    startTaskPolicy(store,'pair-bare',{mode:'0day',question:'Probe without inputs',target:endpoint,budget:{toolCalls:20,discoveryCalls:0}});
    saveTaskContext(store,'pair-bare',{assets:[{id:'asset',url:endpoint,inScope:true,reachable:true}],requests:[normalQ,bare],methods:[]});
    createResearch(store,'pair-bare',{id:'direction',requestId:'normal-q',requestRevision:'v1',question:'Probe without inputs',expectedEffect:'Controlled other document appears',negativeResult:'Identical own document',nextStep:'Compare once'});
    const bareBefore=requests;
    const bareDone=await runComparisonJob(store,'pair-bare',{hypothesisId:'direction',normal:{requestId:'normal-q',requestRevision:'v1'},probe:{requestId:'probe-bare',requestRevision:'v1'}});
    assert.equal(bareDone.state,'completed',bareDone.reason);assert.equal(requests-bareBefore,2,'无 inputs 的探针照样能跑对照');
    // J11f 实测：normal 与 probe 报文逐字相同（参数值只写在 inputs 里）时必须拒绝并说明做法，
    // 不能让它"成功"成一条 no-information 对照、再引出改行改 revision 的连锁浪费。
    const sameWire={...row('probe-same','own')};
    startTaskPolicy(store,'pair-same',{mode:'0day',question:'Identical wire must be refused',target:endpoint,budget:{toolCalls:20,discoveryCalls:0}});
    saveTaskContext(store,'pair-same',{assets:[{id:'asset',url:endpoint,inScope:true,reachable:true}],requests:[normalQ,sameWire],methods:[]});
    createResearch(store,'pair-same',{id:'direction',requestId:'normal-q',requestRevision:'v1',question:'Identical wire',expectedEffect:'refused',negativeResult:'silently no-information',nextStep:'put value into probe URL'});
    await assert.rejects(()=>runComparisonJob(store,'pair-same',{hypothesisId:'direction',normal:{requestId:'normal-q',requestRevision:'v1'},probe:{requestId:'probe-same',requestRevision:'v1'}}),/报文完全相同/, '同一条请求的对照必须被拒');
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
    assert.match(taskExecutionGuard(store,'blocked','recorded-http-execution'),/paused/);assert.throws(()=>resumeTaskPolicy(store,'blocked','fixed','model'),/user/);
    resumeTaskPolicy(store,'blocked','Restored the fabricated fixture access','desktop-user');assert.match(taskExecutionGuard(store,'blocked','recorded-http-execution'),/baseline_recheck_required/);
    serverMode='login';const login=await executeRecordedRequest(store,'blocked',{purpose:'baseline',requestId:'normal',requestRevision:'v1'});assert(login.taskPaused);assert.equal(login.blocker,'normal-access-failed');
    resumeTaskPolicy(store,'blocked','Restored plain text fixture response','desktop-user');serverMode='different';const good=await executeRecordedRequest(store,'blocked',{purpose:'baseline',requestId:'normal',requestRevision:'v1'});assert.equal(good.status,200);assert.equal(readTaskPolicy(store,'blocked').needsBaselineRecheck,false);assert.equal(readTaskPolicy(store,'blocked').used.toolCalls,3);
  });
  await test('cancelling a captured comparison interrupts the socket, preserves partial evidence and refuses an automatic resend',async()=>{
    serverMode='hang';research('abort');const controller=new AbortController();const pending=runComparisonJob(store,'abort',pair,controller.signal);
    const timer=setTimeout(()=>controller.abort(),80);const result=await pending;clearTimeout(timer);
    assert.equal(result.state,'interrupted');assert.equal(result.attemptedRequests,2);assert.equal(readExecutionReceipt(store,'abort',result.steps[1].receiptId).outcome,'interrupted');
    const before=requests;assert.equal((await runComparisonJob(store,'abort',pair)).cached,true);assert.equal(requests,before);
  });
  await test('three native worker admissions inherit parent decisions, share operations and refuse a fourth',async()=>{
    const p=parent('three-workers',3);setTaskInteraction(store,'three-workers','guided','desktop-user','milestone');
    const sites=['https://first.test','https://second.test','https://third.test','https://fourth.test'];
    saveTaskContext(store,'three-workers',{assets:sites.map((url,n)=>({id:'fixture-'+n,url,inScope:true,reachable:true}))});
    saveChatDefaults(store,{interaction:'continuous',reporting:'summary',workers:16});
    try{
      const children=[];
      for(const site of sites.slice(0,3))children.push((await delegateManager.delegate(p,{...delegate,site})).childId);
      assert.equal(siteWorkerView(store,'three-workers').active,3);
      for(const child of children){const policy=readTaskPolicy(store,child);assert.equal(policy.interaction,'confirm-step');assert.equal(policy.reporting,'step');assert.equal(policy.workerLimit,0);assert.equal(policy.parentSession,'three-workers');}
      await assert.rejects(delegateManager.delegate(p,{...delegate,site:sites[3]}),/worker limit/);
      for(const child of children)assert.equal(taskExecutionGuard(store,child,'recorded-http-execution'),undefined);
      assert.equal(readTaskPolicy(store,'three-workers').used.toolCalls,3);
      await delegateManager.cleanup(p);assert.equal(siteWorkerView(store,'three-workers').active,0);
    }finally{store.db.prepare('DELETE FROM chat_defaults').run();}
  });
  await test('enabled method catalog stays compact while selected current user methods are fetched exactly on demand',async()=>{
    const stack=await import('../plugins/dsh-method-stack/lib/index.js'),catalog=stack.fullCatalog(),all=catalog.flatMap(group=>group.methods.map(method=>group.group+'/'+method.id));
    const profile=path.join(home,'method-stack/profiles/pentest.json');fs.mkdirSync(path.dirname(profile),{recursive:true});fs.writeFileSync(profile,JSON.stringify({active:all,rev:3,combos:{}}));
    const tools=new Map(),contexts=[];stack.apply({tools:{register:tool=>tools.set(tool.name,tool)},agentPresets:{composedPreset:()=> 'pentest'},systemPrompt:{context:item=>contexts.push(item),section(){}},logger:{warn(){}},connection:null});
    const full=stack.renderActive('pentest'),compact=contexts[0].text({agent:{ctx:{}}});assert(Buffer.byteLength(compact)<Buffer.byteLength(full.text));assert(!compact.includes(catalog[0].methods[0].prompt));
    // 执行内容已迁移为稳定 ID；方法正文不再作为执行前置，读取返回该项用途说明。
    const read=await tools.get('saker_method').execute({action:'read',key:'sqli'},{agent:{ctx:{}}});assert(read.ok,read.error);assert.equal(read.key,'sqli');assert(read.prompt.length>0);
    assert.equal((await tools.get('saker_method').execute({action:'read',key:'absent/method'},{agent:{ctx:{}}})).ok,false);
  });
  await test('父任务取消后子任务状态立刻停（不靠轮询），槽位在有界时间内释放、不留孤儿',async()=>{
    const id='cancel-latency';
    const a=parent(id,2,undefined,'single');
    const child=(await delegateManager.delegate(a,delegate)).childId;
    assert.equal(taskPolicyStatus(store,child).stopped,false,'取消前子任务是活的');
    // 取消父任务：子任务必须在**状态层立刻**跟着停，而不是等 2s 轮询。
    const started=Date.now();
    updateTaskProgress(store,id,{cancelled:true});
    const childState=taskPolicyStatus(store,child);
    const propagationMs=Date.now()-started;
    assert.equal(childState.stopped,true,'父任务取消后子任务立刻停');
    assert.match(String(childState.reason),/^parent_task_stopped:/,'原因要指明是父任务停了');
    assert(propagationMs<100,'传播是状态层即时生效，实测 '+propagationMs+'ms');
    // 槽位释放靠轮询（2s 周期 + 清理余量），必须有界且不留孤儿。
    const released=await waitFor(()=>siteWorkerRows(store,id).every(row=>row.state==='released'),6000);
    assert(released.ok,'子代理槽位必须在有界时间内释放（实测 '+(released.ms)+'ms）');
    assert.equal(siteWorkerView(store,id).active,0,'不留活跃子代理');
    console.log('     取消传播 '+propagationMs+'ms；槽位释放 '+released.ms+'ms');
  });
}finally{await delegateManager?.dispose();store.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
process.exitCode=failed?1:0;
