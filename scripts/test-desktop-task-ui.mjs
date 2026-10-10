import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { openStore, registerFinding } from '../plugins/dsh-redteam-results/lib/store.js';
import { readTaskPolicy, updateTaskProgress, checkpointTask, chosenTaskOptions } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { saveTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js';
import { siteWorkerView } from '../plugins/dsh-redteam-results/lib/site-workers.js';
import { createResearch } from '../plugins/dsh-redteam-results/lib/research.js';
import { captureTaskCost, taskCostOverview } from '../plugins/dsh-redteam-results/lib/task-cost.js';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-task-ui-'));
process.env.DSH_HOME = home;
const results = await import('../plugins/dsh-redteam-results/lib/index.js');
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
const sections = [], disposers = [], registeredTools = new Map();
const sessionMap = new Map(['ui', 'hero', 'nday', 'regular', '0day', 'records', 'interaction-ui', 'poll-readonly'].map(id => [id, { id, header: { agentPreset: 'pentest' } }]));
sessionMap.set('audit', { id: 'audit', header: { agentPreset: 'code-audit' } });
const queued = [], cancellations = [];
const agents = { get: id => sessionMap.has(id) ? { session: sessionMap.get(id), status: 'idle', followup: message => queued.push({ id, message }), cancel: cause => cancellations.push({ id, cause }) } : undefined };
const ctx = { sessions: { get: id => sessionMap.get(id) }, systemPrompt: { section: section => sections.push(section) },
  agents,
  tools: { register: tool => registeredTools.set(tool.name,tool), guard: () => {} }, effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
  webServer: { register: () => () => {} } };
results.apply(ctx);
const source = fs.readFileSync(new URL('../plugins/dsh-redteam-results/lib/client.js', import.meta.url), 'utf8');
const componentSource = source.slice(source.indexOf('function exampleTemplates('), source.indexOf('function CheckedList('));
function harness(name, sessionId, props = {}, extras = {}) {
  const state = [], calls = [], effects = [], timers = []; let cursor = 0;
  const sandbox = { useState: value => { const index = cursor++; if (!(index in state)) state[index] = value; return [state[index], next => { state[index] = typeof next === 'function' ? next(state[index]) : next; }]; },
    useEffect: effect => effects.push(effect), setInterval: fn => { timers.push(fn); return timers.length; }, clearInterval: () => {}, useRef: initial => { const index=cursor++; if (!(index in state))state[index]={current:initial};return state[index]; }, Btn: 'button', Detail: 'finding-detail', MODE_META: {pentest:{}}, React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) },
    api: async (endpoint, payload) => { calls.push([endpoint, payload]); try { return await results.dispatch(ctx, store, endpoint, payload); } catch (error) { return { ok: false, error: error.message }; } } };
  Object.assign(sandbox, extras);
  sandbox.STATUS_LABEL = { pending: '待验证', verified: '已验证' };
  runInNewContext(source.slice(source.indexOf('function statusTextFor('), source.indexOf('function download(', source.indexOf('function statusTextFor('))), sandbox);
  runInNewContext(componentSource + '; this.component = ' + name, sandbox);
  function render() { cursor = 0; return sandbox.component({ sessionId, ...props }); }
  function nodes(node) { if (!node || typeof node !== 'object') return []; return [node, ...node.children.flat(Infinity).flatMap(nodes)]; }
  return { state, calls, render, mount: async () => { render(); for(const effect of effects.slice())effect(); await new Promise(setImmediate); }, poll: async () => { for(const timer of timers)await timer(); }, find: predicate => nodes(render()).find(predicate), button: label => nodes(render()).find(node => node.type === 'button' && node.children.includes(label)) };
}
let failed = 0;
async function test(name, fn) { try { await fn(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + error.message); } }
try {
  await test('reading and polling Desktop chat settings never persist a mode or task', async () => {
    const ui=harness('ChatSetup','poll-readonly');await ui.mount();await ui.poll();await ui.poll();
    assert(ui.calls.length>=3);assert(ui.calls.every(([endpoint])=>endpoint==='chat.settings'),'read invoked a mutation RPC');
    const state=await results.dispatch(ctx,store,'chat.settings',{sessionId:'poll-readonly'});
    assert.equal(state.choice,null);assert.equal(state.configured,false);assert.equal(readTaskPolicy(store,'poll-readonly'),null);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM task_flow_choice WHERE session_id=?').get('poll-readonly').n,0);
    assert.equal(ui.find(n=>n.props['aria-label']==='任务方向').props.value,'regular');
  });
  await test('Desktop interaction control saves preferences, confirms a real checkpoint and preserves policy on failed delivery',async()=>{
    const id='interaction-ui';
    const control=harness('InteractionControl',id);
    const select=control.find(n=>n.type==='select'&&n.props['aria-label']==='协作方式');
    assert.equal(select.children.flat().length,3);
    await results.dispatch(ctx,store,'task.choose',{sessionId:id,mode:'regular',workflow:'regular-to-nday',workers:0,interaction:'confirm'});
    await results.dispatch(ctx,store,'task.start',{sessionId:id,policy:{mode:'regular',budget:{toolCalls:5,minutes:10}}});
    const before=readTaskPolicy(store,id);
    updateTaskProgress(store,id,{regularComplete:true,note:'Offline stage finished'});
    const ui=harness('TaskPanel',id);await ui.button('刷新状态').props.onClick();assert(ui.button('确认并继续'));
    const broken={...ctx,agents:{get:()=>({status:'idle',followup(){throw Error('fixture enqueue failed')}})}};
    await results.dispatch(ctx,store,'task.interaction',{sessionId:id,interaction:'continuous'});
    await assert.rejects(results.dispatch(broken,store,'task.continue',{sessionId:id}),/仍等待确认/);
    assert(readTaskPolicy(store,id).awaitingConfirmation);
    await ui.button('确认并继续').props.onClick();assert.equal(readTaskPolicy(store,id).awaitingConfirmation,undefined);
    assert.match(queued.at(-1).message.content[0].text,/用户确认继续/);
    for(const key of ['budget','used','startedAt'])assert.deepEqual(readTaskPolicy(store,id)[key],before[key]);
    await results.dispatch(ctx,store,'task.interaction',{sessionId:id,interaction:'milestone'});
    assert.equal(readTaskPolicy(store,id).interaction,'milestone');
    assert.deepEqual(readTaskPolicy(store,id).budget,before.budget);
  });
  await test('Desktop effect comparison stays collapsed and displays host summary rather than inventing proof for missing data', () => {
    const start = source.indexOf('function EffectEvidenceView('), end = source.indexOf('function chatError(', start);
    const sandbox = { useState: value => [value, () => {}], React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) } };
    runInNewContext(source.slice(start, end) + ';this.component=EffectEvidenceView;', sandbox);
    assert.equal(sandbox.component({ finding: {} }), null);
    const view = sandbox.component({ finding: { executionEvidence: { effectEvidence: { kind: 'private-json-read/v1', comparisons: [{ ownerMarkerSha256: 'owner-hash' }] } } } });
    assert.equal(view.type, 'details'); assert.equal(view.props.open, undefined);
    assert.equal(view.props['aria-label'], '独立影响对照'); assert(JSON.stringify(view).includes('owner-hash'));
    assert(source.includes('React.createElement(EffectEvidenceView, { finding: f, onReviewed: props.onEffectReview })'));
  });
  await test('a successful Desktop impact review refreshes its parent while a rejected review keeps the form', async () => {
    const start=source.indexOf('function EffectEvidenceView('),end=source.indexOf('function chatError(',start);
    const values=[null,'Independent controlled fixture role and actual object review', 'normal,probe',true,true,false,'high','',false];let cursor=0,refreshes=0,accepted=true;
    const sandbox={useState:initial=>{const i=cursor++;return [i in values?values[i]:initial,v=>{values[i]=v}]},React:{createElement:(type,props,...children)=>({type,props:props||{},children})},Btn:'button',api:async()=>accepted?{ok:true,review:{source:'desktop-impact-review'}}:{ok:false,error:'not enough effect evidence'}};
    runInNewContext(source.slice(start,end)+';this.component=EffectEvidenceView;',sandbox);
    const finding={sessionId:'fixture',id:'pentest-1',proofKind:'access',executionEvidence:{verified:true,receiptIds:['normal','probe']}};
    const nodes=node=>!node||typeof node!=='object'?[]:[node,...node.children.flat(Infinity).flatMap(nodes)];
    const render=()=>{cursor=0;return sandbox.component({finding,onReviewed:()=>{refreshes++}})};
    await nodes(render()).find(n=>n.type==='button').props.onClick();assert.equal(refreshes,1);
    values[0]=null;accepted=false;await nodes(render()).find(n=>n.type==='button').props.onClick();assert.equal(refreshes,1);assert.equal(values[7],'not enough effect evidence');
  });
  await test('Desktop task endpoint validates live pentest session and guard before storing selected workflow', async () => {
    for (const sessionId of ['missing', 'audit']) await assert.rejects(results.dispatch(ctx, store, 'task.start', { sessionId, policy: { mode: 'nday', budget: { toolCalls: 10 } } }), /渗透会话/);
    await assert.rejects(results.dispatch({ ...ctx, tools: {} }, store, 'task.start', { sessionId: 'ui', policy: { mode: 'nday', budget: { toolCalls: 10 } } }), /守卫/);
    assert.equal(readTaskPolicy(store, 'ui'), null);
  });
  await test('task overview reads actual session findings and displays missing evidence without a model call', async () => {
    const id='overview-records';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    await results.dispatch(ctx,store,'task.start',{sessionId:id,policy:{mode:'regular',question:'Local permission check',budget:{toolCalls:5}}});
    registerFinding(store,id,'pentest',{title:'Local object access candidate',type:'access',severity:'high',target:'https://fixture.test/local'});
    const queuedBefore=queued.length,ui=harness('TaskPanel',id);await ui.mount();
    const rendered=JSON.stringify(ui.render());assert(rendered.includes('Local object access candidate'));assert(rendered.includes('https://fixture.test/local'));assert(rendered.includes('待验证'));
    const reads=ui.calls.filter(([endpoint])=>endpoint==='findings.list');assert.equal(reads.length,1);assert.equal(reads[0][1].scope,'session');assert.equal(reads[0][1].pageSize,5);assert.equal(queued.length,queuedBefore);
    assert(!ui.calls.some(([endpoint])=>endpoint==='checks.list'),'overview should not repeatedly read the full check ledger');
  });
  await test('overview distinguishes missing task details, excluded records and unavailable result counts', async () => {
    const id='overview-empty-details';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    await results.dispatch(ctx,store,'task.start',{sessionId:id,policy:{mode:'regular',budget:{toolCalls:5}}});
    assert.equal(readTaskPolicy(store,id).question,'','an omitted task must not be replaced with invented intent');
    registerFinding(store,id,'pentest',{title:'Excluded fixture',type:'access',severity:'low',status:'false-positive'});
    const ui=harness('TaskPanel',id);await ui.mount();
    const resultsNode=ui.find(n=>n.props['aria-label']==='本会话测试结果');
    const digits=resultsNode.children.flat(Infinity).flatMap(n=>n?.children||[]).filter(n=>n?.type==='span').flatMap(n=>n.children).filter(n=>n?.type==='strong').map(n=>n.children[0]);
    assert.deepEqual(digits,[0,0],'excluded findings must not count as awaiting verification');
    assert(JSON.stringify(ui.render()).includes('目标：未填写'));assert(!JSON.stringify(ui.render()).includes('聊天中约定'));
    const actual=await results.dispatch(ctx,store,'task.status',{sessionId:id});
    const legacy=harness('TaskPanel',id,{}, {api:async endpoint=>endpoint==='task.status'?{...actual,policy:{...actual.policy,question:'有限观察已有目标，向用户建议具体研究问题'}}:{ok:false,error:'fixture read failed'}});
    await legacy.mount();const failedView=JSON.stringify(legacy.render());
    assert(failedView.includes('结果读取失败'));assert(!failedView.includes('有限观察已有目标'));assert(!failedView.includes('个已确认'),'read errors must not turn into zero results');
  });
  await test('finding summaries explain expired verification and preserve excluded outcomes', () => {
    const sandbox={};runInNewContext(source.slice(source.indexOf('function findingSummary('),source.indexOf('function download(')),sandbox);
    assert.equal(sandbox.findingSummary({executionEvidence:{reason:'执行证据已过期，请在当前身份下重新采集完整对照。'}}),'上次验证已超过 15 分钟，需要重新验证。');
    assert.match(sandbox.findingSummary({executionEvidence:{reason:'HTTP requests recorded',impactReason:'执行证据已过期'}}),/超过 15 分钟/);
    assert.match(sandbox.findingSummary({status:'false-positive',executionEvidence:{reason:'执行证据已过期'}}),/已排除/);
    assert.match(sandbox.findingSummary({delivery:{gaps:['request-response-evidence-missing']}}),/请求或响应/);
  });
  await test('three actual workflow buttons apply explicit research budget and cancellation persists without reset', async () => {
    const ui = harness('TaskPanel', 'ui');
    await ui.mount();
    for (const label of ['Nday发现', '常规测试', '0Day挖掘']) assert(ui.button(label));
    await ui.button('0Day挖掘').props.onClick();
    ui.find(node => node.type === 'input' && node.props['aria-label'] === '操作预算').props.onChange({ target: { value: '40' } });
    ui.find(node => node.type === 'input' && node.props['aria-label'] === '初步观察预算').props.onChange({ target: { value: '7' } });
    ui.find(node => node.type === 'input' && node.props['aria-label'] === '这一轮要查什么').props.onChange({ target: { value: 'Inspect the controlled fixture permission only' } });
    await ui.button('开始测试').props.onClick();
    assert.equal(readTaskPolicy(store, 'ui').mode, '0day');
    assert.equal(readTaskPolicy(store, 'ui').budget.toolCalls, 40);
    assert.equal(readTaskPolicy(store, 'ui').budget.discoveryCalls, 7);
    const uiQueued=queued.filter(row=>row.id==='ui');assert.equal(uiQueued.length, 1);
    assert.match(uiQueued[0].message.content[0].text, /Inspect the controlled fixture permission only/);
    assert.equal(ui.calls.at(-1)[1].sessionId, 'ui');
    assert(!ui.button('开始测试'));
    await ui.button('停止本轮与子代理').props.onClick();
    assert.equal(readTaskPolicy(store, 'ui').cancelled, true);
    assert.deepEqual(cancellations, [{ id: 'ui', cause: { kind: 'user' } }]);
    assert(!ui.button('停止本轮与子代理'));
    await ui.button('刷新状态').props.onClick();
    assert(ui.find(node => node.type === 'span' && node.children.some(value => String(value).includes('你已停止测试'))));
  });
  await test('Desktop refuses unavailable or running agents before storing a task and failed enqueue is stopped', async () => {
    for (const agent of [undefined, { status: 'running', followup() {} }]) {
      await assert.rejects(results.dispatch({ ...ctx, agents: { get: () => agent } }, store, 'task.start', { sessionId: 'records', policy: { mode: 'regular', budget: { toolCalls: 3 } } }), /不可用|仍在运行/);
      assert.equal(readTaskPolicy(store, 'records'), null);
    }
    await assert.rejects(results.dispatch({ ...ctx, agents: { get: () => ({ status: 'idle', followup() { throw new Error('fixture queue unavailable'); } }) } }, store, 'task.start', { sessionId: 'records', policy: { mode: 'regular', budget: { toolCalls: 3 } } }), /未能开始/);
    assert.equal(readTaskPolicy(store, 'records').cancelled, true);
    await assert.rejects(results.dispatch({ ...ctx, agents: { get: () => undefined } }, store, 'task.cancel', { sessionId: 'records' }), /尚未确认模型停止/);
  });
  await test('selected Desktop workflow enters registered prompt provider per current session with actual persisted limits', async () => {
    const provider = sections.find(section => section.name === 'saker-pentest-task'); assert(provider);
    for (const mode of ['nday', 'regular', '0day']) {
      await results.dispatch(ctx, store, 'task.start', { sessionId: mode, policy: { mode, budget: { toolCalls: 30, discoveryCalls: 5 } } });
      const text = provider.text({ agent: { session: sessionMap.get(mode) } });
      assert.match(text, new RegExp('重点=' + mode)); assert.match(text, /操作=0\/30/);
      for (const other of ['nday', 'regular', '0day'].filter(other => other !== mode)) assert(!text.includes('重点=' + other));
    }
    assert.equal(provider.text({ agent: { session: sessionMap.get('audit') } }), '');
    assert.match(provider.text({ agent: { session: { id: 'new', header: { agentPreset: 'pentest' } } } }), /先明确本轮站点/);
  });
  await test('Desktop starts a human-selected next round without losing facts, history or cost and cannot reset running/blocked tasks', async () => {
    saveTaskContext(store,'ui',{assets:[{id:'retained',url:'https://fixture.test',inScope:true,reachable:true}]});
    const old=readTaskPolicy(store,'ui'),ui=harness('TaskPanel','ui');
    await ui.button('刷新状态').props.onClick();
    await ui.button('新建测试').props.onClick();
    assert.equal(readTaskPolicy(store,'ui'),null);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM task_rounds WHERE session_id=?').get('ui').n,1);
    assert((await results.dispatch(ctx,store,'context.index',{sessionId:'ui'})).text.includes('retained'));
    await ui.button('Nday发现').props.onClick();
    ui.find(node=>node.props['aria-label']==='这一轮要查什么').props.onChange({target:{value:'Check only the provided product prerequisite'}});
    await ui.button('开始测试').props.onClick();
    assert.equal(readTaskPolicy(store,'ui').mode,'nday');assert(readTaskPolicy(store,'ui').startedAt>=old.startedAt);
    await assert.rejects(results.dispatch(ctx,store,'task.new-round',{sessionId:'ui'}),/先结束/);
    await results.dispatch(ctx,store,'task.cancel',{sessionId:'ui'});
    await assert.rejects(results.dispatch({...ctx,agents:{get:()=>({status:'running'})}},store,'task.new-round',{sessionId:'ui'}),/仍在运行/);
  });
  await test('cost accounting deduplicates official events, includes released children, excludes other sessions and preserves unknown usage', async()=>{
    const sid='regular',child='cost-child';
    store.db.prepare('INSERT INTO site_workers(parent_session,child_id,site,record) VALUES(?,?,?,?)').run(sid,child,'https://fixture.test',JSON.stringify({parentId:sid,childId:child,site:'https://fixture.test',state:'released',question:'Controlled helper'}));
    const event={type:'assistant/message',seq:1,time:Date.now(),data:{usage:{inputTokens:3,outputTokens:2,cacheReadTokens:5,cacheWriteTokens:0,totalTokens:10}}};
    for(const id of [sid,child,'outside']){captureTaskCost(store,{id},event);captureTaskCost(store,{id},event);}
    captureTaskCost(store,{id:child},{type:'assistant/attempt',seq:2,time:Date.now(),data:{}});
    captureTaskCost(store,{id:sid},{type:'tool/call',seq:2,time:Date.now(),data:{arguments:'not recorded'}});
    const cost=taskCostOverview(ctx,store,sid);assert.equal(cost.totalTokens,20);assert.equal(cost.cacheReadTokens,10);assert.equal(cost.modelCalls,3);assert.equal(cost.unknownUsageCalls,1);assert.equal(cost.toolCalls,1);assert.equal(cost.sessions.length,2);
    assert(!store.db.prepare('SELECT record FROM task_cost_events WHERE session_id=? AND seq=2').get(sid).record.includes('not recorded'));
    const state=await results.dispatch({...ctx,agents:{get:()=>undefined}},store,'task.status',{sessionId:sid});assert.equal(state.cost.totalTokens,20);
    assert.equal(taskCostOverview(ctx,store,sid,Date.now()+1000).totalTokens,null);
    const at=Date.now()-10000;
    for(const [id,start,end] of [[sid,at,at+4000],[child,at+2000,at+6000]]){
      captureTaskCost(store,{id},{type:'turn/start',seq:3,time:start,data:{turn:1}});
      captureTaskCost(store,{id},{type:'turn/end',seq:4,time:end,data:{turn:1}});
    }
    assert.equal(taskCostOverview(ctx,store,sid).elapsedModelMs,6000,'parallel parent and child time must not be counted twice');
    assert.equal(taskCostOverview(ctx,store,sid,at+3000).elapsedModelMs,3000);
    const inherited={...event,seq:0},own={...event,seq:1};
    const live={id:'records',seq:2,eventAt:index=>[inherited,own][index],isOwnSeq:index=>index===1};
    const realShape={sessions:{get:id=>id==='records'?live:undefined}};
    assert.equal(taskCostOverview(realShape,store,'records').totalTokens,10,'native session eventAt API must backfill only owned events');
    assert.equal(taskCostOverview(realShape,store,'records').totalTokens,10,'repeated reads cannot charge replayed events again');
    assert.equal(taskCostOverview(realShape,store,'missing').unavailableSessions,1);
  });
  await test('chat workflow selector persists choice without starting budgets or exposing task details', async () => {
    const ui = harness('ChatSetup', 'hero');ui.render();ui.state[0]=await results.dispatch(ctx,store,'chat.settings',{sessionId:'hero'});
    assert(ui.find(n=>n.props['aria-label']==='任务方向'));
    assert(!ui.button('开始测试')); assert(!ui.button('刷新状态'));
    await ui.find(n=>n.props['aria-label']==='任务方向').props.onChange({target:{value:'regular'}});
    assert.equal(readTaskPolicy(store, 'hero'), null);
    assert.equal((await results.dispatch(ctx, store, 'task.status', { sessionId: 'hero' })).choice, 'regular');
    assert.equal(ui.find(n=>n.props['aria-label']==='任务方向').props.value, 'regular');
    assert.match(sections[0].text({ agent: { session: sessionMap.get('hero') } }), /用户选择了\/pentest-regular/);
    await assert.rejects(results.dispatch(ctx, store, 'task.start', { sessionId: 'hero', policy: { mode: 'nday', budget: { toolCalls: 20 } } }), /differs/);
    await results.dispatch(ctx, store, 'task.start', { sessionId: 'hero', policy: { mode: 'regular', budget: { toolCalls: 20 } } });
    await assert.rejects(results.dispatch(ctx, store, 'task.choose', { sessionId: 'hero', mode: '0day' }), /不能切换/);
  });
  await test('Desktop shared detail reads exact packet revision without packet duplication in index or cross-session borrowing', async () => {
    saveTaskContext(store, 'records', { assets: [{ id: 'a', url: 'https://fixture.test', inScope: true, reachable: true }], requests: [{
      id: 'baseline', endpoint: 'https://fixture.test/api', authContext: 'fixture-user', revision: 'v1', valid: true,
      request: 'GET /api HTTP/1.1', response: 'HTTP/1.1 200 OK\nfixture-body' }] });
    const ui = harness('ContextPanel', 'records');
    await ui.button('读取索引').props.onClick();
    assert(ui.state[0].includes('baseline')); assert(!ui.state[0].includes('fixture-body'));
    ui.find(node => node.props['aria-label'] === '记录ID').props.onChange({ target: { value: 'baseline' } });
    ui.find(node => node.props['aria-label'] === '请求或方法版本').props.onChange({ target: { value: 'v1' } });
    await ui.button('读取详情').props.onClick();
    assert(ui.state[0].includes('GET /api HTTP/1.1')); assert(ui.state[0].includes('fixture-body'));
    assert.equal(ui.calls.at(-1)[1].version, 'v1');
    await assert.rejects(results.dispatch(ctx, store, 'context.detail', { sessionId: 'regular', kind: 'request', id: 'baseline', version: 'v1' }), /record not found/);
    saveTaskContext(store, 'records', { requests: [{ id: 'baseline', endpoint: 'https://fixture.test/api', authContext: 'fixture-user', revision: 'v2', valid: true,
      request: 'GET /api HTTP/1.1', response: 'HTTP/1.1 200 OK\nnew-fixture-body' }] });
    const historical = await results.dispatch(ctx, store, 'context.detail', { sessionId: 'records', kind: 'request', id: 'baseline', version: 'v1' });
    assert.equal(historical.historical, true); assert(historical.text.includes('fixture-body')); assert(!historical.text.includes('new-fixture-body'));
    ui.find(node => node.props['aria-label'] === '请求或方法版本').props.onChange({ target: { value: 'missing' } });
    await ui.button('读取详情').props.onClick(); assert.match(ui.state[1], /record not found/);
  });
  await test('research panel reads a compact current-session index and keeps observations folded outside chat', async () => {
    saveTaskContext(store, '0day', { assets: [{ id: 'a', url: 'https://fixture.test', inScope: true, reachable: true }], requests: [{
      id: 'baseline', endpoint: 'https://fixture.test/api', authContext: 'fixture-user', revision: 'v1', kind: 'api', valid: true,
      request: 'GET /api HTTP/1.1', response: 'HTTP/1.1 200 OK\nprivate fixture baseline', inputs: [{ name: 'object', location: 'query', evidenceIds: ['baseline'] }] }] });
    createResearch(store, '0day', { id: 'fixture', requestId: 'baseline', requestRevision: 'v1', controlledInputs: [{ name: 'object', location: 'query' }],
      title: 'Fixture boundary', serverPath: 'Object handler', boundary: 'Owner identity', normalBehavior: 'Own objects only', supportCriterion: 'Another owner object appears',
      falsifier: 'Another owner object is consistently denied', nextInformation: 'Compare object ownership', knownCheck: { outcome: 'not-assessed', rationale: 'Synthetic fixture; no public product claim.', sources: [] } });
    const ui = harness('ResearchPanel', '0day');
    assert.equal(ui.render().type, 'details'); assert.equal(ui.render().props.open, undefined);
    await ui.button('读取研究记录').props.onClick();
    assert.equal(ui.state[0].total, 1); assert(!JSON.stringify(ui.state[0]).includes('private fixture baseline'));
    await ui.button('查看假设').props.onClick(); assert.equal(ui.state[1].binding.authContext, 'fixture-user');
    assert(ui.find(node => node.type === 'details' && node.children.some(child => child?.type === 'summary' && child.children.includes('正常对照、观察与公开解释'))));
    const hero = harness('ChatSetup', 'hero'); assert(!hero.button('读取研究记录'));
  });
  await test('actual materials tool accepts an unambiguous material kind and distinguishes indexing from reading',async()=>{
    fs.writeFileSync(path.join(home,'selected.js'),'fetch("/api");');
    const execute=registeredTools.get('redteam_context').execute,exec={agent:{session:{id:'records',header:{agentPreset:'pentest',cwd:home}}}};
    assert.equal((await execute({context:JSON.stringify({assets:[{id:'material-site',url:'https://fixture.test',inScope:true,reachable:true}],requests:[],methods:[],checks:[]})},exec)).ok,true);
    const materials=JSON.stringify({site:'https://fixture.test',files:[{path:'selected.js',url:'https://fixture.test/app.js'}]});
    const indexed=await execute({materials,kind:'material',offset:0},exec);assert.equal(indexed.ok,true,indexed.error);assert.equal(indexed.operation,'index-selected-files');assert.equal(indexed.files,1);
    const read=await execute({kind:'material'},exec);assert.equal(read.operation,'read-existing-index');assert.equal(read.files,1);
    const conflict=await execute({materials,context:'{}'},exec);assert.equal(conflict.ok,false);assert.match(conflict.error,/只传materials/);
    const empty=await execute({materials:JSON.stringify({site:'https://fixture.test',files:[]})},exec);assert.equal(empty.ok,false);assert.match(empty.error,/1\.\.30/);
  });
  await test('new-session hero does not duplicate task controls owned by the resident composer', () => {
    const modeSource = fs.readFileSync(new URL('../plugins/dsh-mode-group/lib/client.js', import.meta.url), 'utf8');
    const helper = modeSource.slice(modeSource.indexOf('function TaskChoices('), modeSource.indexOf('// —— 视口'));
    const sandbox = { require: () => ({ WorkflowSelector: 'WorkflowSelector' }), React: { createElement: (type, props) => ({ type, props }) } };
    runInNewContext(helper + '; this.component = TaskChoices;', sandbox);
    const ctl = { currentSession: () => ({ id: 'ui', agentPreset: 'pentest' }) };
    assert.equal(sandbox.component({ ctl, current: 'pentest' }), null);
    assert.equal(sandbox.component({ ctl, current: 'code-audit' }), null);
    assert.equal(sandbox.component({ ctl: { currentSession: () => ({ id: 'audit', agentPreset: 'code-audit' }) }, current: 'pentest' }), null);
  });
  await test('resident composer registers chat settings for both blank and existing pentest sessions only', () => {
    const start=source.indexOf('function ChatSetupEntry('),end=source.indexOf('function installChatSetupStyles(',start);
    const sandbox={React:{createElement:(type,props)=>({type,props})},ChatSetup:'ChatSetup'};
    runInNewContext(source.slice(start,end)+';this.component=ChatSetupEntry;',sandbox);
    for(const blank of [true,false]) assert.equal(sandbox.component({sessionId:'ui',blank,useProjection:()=> 'pentest'}).props.sessionId,'ui');
    assert.equal(sandbox.component({sessionId:'audit',useProjection:()=> 'code-audit'}),null);
    const injects=[], slots=[];
    const scope={effect(){},inject(_keys,fn){return fn({sessions:{}});},slots:{inject:(name,fn)=>{injects.push(name);if(name==='conversation.input.dock')fn();},register:(options,component)=>{slots.push({options,component});}}};
    const applySource=source.slice(source.lastIndexOf('function apply(ctx)'),source.indexOf('module.exports =',source.lastIndexOf('function apply(ctx)')));
    const apply=runInNewContext(applySource+';this.apply=apply;', {...sandbox,installStyles(){},installChatSetupStyles(){},injectVisibleConversationView(){}});apply(scope);
    assert(injects.includes('conversation.input.dock'));assert.equal(slots[0].options.id,'saker-chat-setup');
  });
  await test('chat quick settings change real in-flight preferences without resetting consumed budget or deadline',async()=>{
    const id='chat-live';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    await results.dispatch(ctx,store,'task.choose',{sessionId:id,mode:'regular',workers:1,interaction:'continuous'});
    await results.dispatch(ctx,store,'task.start',{sessionId:id,policy:{mode:'regular',question:'Offline chat fixture',budget:{toolCalls:8,minutes:10}}});
    const before=readTaskPolicy(store,id),ui=harness('ChatSetup',id);ui.render();ui.state[0]=await results.dispatch(ctx,store,'chat.settings',{sessionId:id});
    assert(ui.find(n=>n.props['aria-label']==='任务方向').props.disabled);
    await ui.find(n=>n.props['aria-label']==='聊天协作方式').props.onChange({target:{value:'confirm'}});
    assert.equal(readTaskPolicy(store,id).interaction,'confirm');
    await ui.find(n=>n.props['aria-label']==='聊天子代理上限').props.onChange({target:{value:'2'}});
    assert.equal(readTaskPolicy(store,id).workerLimit,2);
    for(const key of ['used','startedAt'])assert.deepEqual(readTaskPolicy(store,id)[key],before[key]);
    for(const key of ['toolCalls','deadline'])assert.equal(readTaskPolicy(store,id).budget[key],before.budget[key]);
    const child={childId:'chat-child',parentId:id,site:'https://fixture.test',state:'cleanup-failed'};
    store.db.prepare('INSERT INTO site_workers(parent_session,child_id,site,record) VALUES(?,?,?,?)').run(id,child.childId,child.site,JSON.stringify(child));
    await assert.rejects(results.dispatch(ctx,store,'task.workers',{sessionId:id,workers:0}),/先关闭/);
    await ui.find(n=>n.props['aria-label']==='聊天子代理上限').props.onChange({target:{value:'0'}});
    assert(ui.find(n=>n.props.role==='alert'&&n.children.some(value=>String(value).includes('先关闭'))));
    assert.equal(readTaskPolicy(store,id).workerLimit,2);store.db.prepare('DELETE FROM site_workers WHERE child_id=?').run(child.childId);
    checkpointTask(store,id,'Offline checkpoint');ui.state[0]=await results.dispatch(ctx,store,'chat.settings',{sessionId:id});
    assert(!ui.button('新建测试'));
    await ui.button('确认并继续').props.onClick();
    updateTaskProgress(store,id,{planComplete:true});ui.state[0]=await results.dispatch(ctx,store,'chat.settings',{sessionId:id});
    await ui.button('新建测试').props.onClick();
    assert.equal(readTaskPolicy(store,id),null);assert.equal(chosenTaskOptions(store,id).workers,2);assert.equal(chosenTaskOptions(store,id).interaction,'confirm');
  });
  await test('cooperation and progress reporting are independent, and guided decisions remain guarded',async()=>{
    for(const interaction of ['guided','confirm','continuous'])for(const reporting of ['summary','milestone']){
      const id='cooperate-'+interaction+'-'+reporting;sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
      await results.dispatch(ctx,store,'task.choose',{sessionId:id,mode:'regular',workers:4,interaction,reporting});
      await assert.rejects(results.dispatch(ctx,store,'task.start',{sessionId:id,policy:{mode:'regular',reporting:reporting==='summary'?'milestone':'summary',budget:{toolCalls:6}}}),/reporting differs/);
      await results.dispatch(ctx,store,'task.start',{sessionId:id,policy:{mode:'regular',budget:{toolCalls:6,minutes:10}}});
      const before=readTaskPolicy(store,id);assert.equal(before.reporting,reporting);assert.equal(before.workerLimit,4);
      assert.match(sections[0].text({agent:{session:sessionMap.get(id)}}),reporting==='summary'?/结束时集中汇总/:/每个有实际结果的阶段/);
      assert.match(sections[0].text({agent:{session:sessionMap.get(id)}}),/记录已审与未审、支持与反证/);
      checkpointTask(store,id,'当前线索已梳理，请判断下一步');
      assert.equal(!!readTaskPolicy(store,id).awaitingConfirmation,interaction!=='continuous');
      await results.dispatch(ctx,store,'task.interaction',{sessionId:id,interaction,reporting:reporting==='summary'?'milestone':'summary'});
      assert.equal(!!readTaskPolicy(store,id).awaitingConfirmation,interaction!=='continuous');
      for(const key of ['budget','used','startedAt'])assert.deepEqual(readTaskPolicy(store,id)[key],before[key]);
      if(interaction==='guided'){
        const ui=harness('ChatSetup',id);ui.render();ui.state[0]=await results.dispatch(ctx,store,'chat.settings',{sessionId:id});
        ui.find(n=>n.props['aria-label']==='补充你的思路').props.onChange({target:{value:'离线新怀疑：界面角色和数据归属可能不一致'}});
        await ui.button('按当前思路继续').props.onClick();
        assert.match(queued.at(-1).message.content[0].text,/用户补充思路：离线新怀疑/);
        assert.equal(readTaskPolicy(store,id).awaitingConfirmation,undefined);
      }
    }
  });
  await test('custom worker ceilings admit 3 through 16, reject invalid input, and preserve budget',async()=>{
    const id='custom-workers';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    await results.dispatch(ctx,store,'task.choose',{sessionId:id,mode:'regular',workers:1,interaction:'continuous'});
    const ui=harness('ChatSetup',id);ui.render();ui.state[0]=await results.dispatch(ctx,store,'chat.settings',{sessionId:id});
    await ui.find(n=>n.props['aria-label']==='聊天子代理上限').props.onChange({target:{value:'custom'}});
    for(const value of ['3','16']){
      ui.find(n=>n.props['aria-label']==='自定义子代理上限').props.onChange({target:{value}});
      await ui.button('应用人数').props.onClick();assert.equal(chosenTaskOptions(store,id).workers,Number(value));
    }
    for(const value of ['','-1','2.5','17']){
      ui.find(n=>n.props['aria-label']==='自定义子代理上限').props.onChange({target:{value}});
      await ui.button('应用人数').props.onClick();assert.equal(chosenTaskOptions(store,id).workers,16);assert(ui.find(n=>n.props.role==='alert'));
    }
    await assert.rejects(results.dispatch(ctx,store,'task.choose',{sessionId:id,mode:'regular',workers:17}),/0 and 16/);
    await results.dispatch(ctx,store,'task.start',{sessionId:id,policy:{mode:'regular',budget:{toolCalls:7,minutes:10}}});
    const before=readTaskPolicy(store,id);await results.dispatch(ctx,store,'task.workers',{sessionId:id,workers:12});
    for(const key of ['used','startedAt'])assert.deepEqual(readTaskPolicy(store,id)[key],before[key]);
    for(const key of ['toolCalls','deadline'])assert.equal(readTaskPolicy(store,id).budget[key],before.budget[key]);
    await assert.rejects(results.dispatch(ctx,store,'chat.defaults',{sessionId:id,interaction:'guided',workers:17}),/0–16/);
  });
  await test('all occupied workers remain visible beyond eight, including idle and cleanup failures',()=>{
    const id='visible-workers';
    for(let n=0;n<16;n++)store.db.prepare('INSERT INTO site_workers(parent_session,child_id,site,record) VALUES(?,?,?,?)').run(id,'visible-'+n,'https://fixture-'+n+'.test',JSON.stringify({childId:'visible-'+n,parentId:id,site:'https://fixture-'+n+'.test',state:n===0?'idle':n===15?'cleanup-failed':'running'}));
    for(let n=0;n<10;n++)store.db.prepare('INSERT INTO site_workers(parent_session,child_id,site,record) VALUES(?,?,?,?)').run(id,'released-'+n,'https://released-'+n+'.test',JSON.stringify({childId:'released-'+n,parentId:id,site:'https://released-'+n+'.test',state:'released'}));
    const view=siteWorkerView(store,id);assert.equal(view.active,16);assert.equal(view.workers.filter(w=>w.state!=='released').length,16);assert.equal(view.more,2);
    assert(view.workers.some(w=>w.childId==='visible-0'));assert(view.workers.some(w=>w.childId==='visible-15'));
  });
  await test('visible defaults remain read-only until an explicit edit, without starting a task or model',async()=>{
    const id='chat-initial';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});let boot;
    const before=queued.length,ui=harness('ChatSetup',id,{}, {useEffect:fn=>{boot=fn;},setInterval:()=>0,clearInterval(){}});
    ui.render();const unmount=boot();
    for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
    const value=await results.dispatch(ctx,store,'chat.settings',{sessionId:id});
    assert.equal(value.choice,null);assert.equal(value.configured,false);
    assert.equal(ui.find(n=>n.props['aria-label']==='聊天子代理上限').props.value,'1');
    assert.equal(ui.find(n=>n.props['aria-label']==='聊天协作方式').props.value,'continuous');
    await ui.find(n=>n.props['aria-label']==='聊天子代理上限').props.onChange({target:{value:'4'}});
    const edited=await results.dispatch(ctx,store,'chat.settings',{sessionId:id});
    assert.equal(edited.choice,'regular');assert.equal(edited.options.workers,4);assert.equal(edited.options.interaction,'continuous');
    assert.equal(edited.configured,false);assert.equal(queued.length,before);unmount();
  });
  await test('editable prompt inserts through native revision-guarded composer API and copies exact edits without sending',async()=>{
    let clipboard='',inserted='',admit=true,captured=0;
    const ui=harness('ChatPromptEditor','hero',{mode:'regular',open:true,inputActions:{captureInsertion:()=>{captured++;return {revision:1};},insertText:(text,span)=>{assert.equal(span.revision,1);if(admit)inserted+=text;return admit;}}},{navigator:{clipboard:{writeText:async text=>{clipboard=text;}}}});
    ui.render();ui.state[6]=true;
    ui.find(n=>n.props['aria-label']==='提示词全文').props.onChange({target:{value:'My edited offline task only'}});
    await ui.button('复制提示词').props.onClick();assert.equal(clipboard,'My edited offline task only');
    await ui.button('插入到输入框').props.onClick();assert.equal(inserted,clipboard);assert.equal(captured,1);
    admit=false;await ui.button('插入到输入框').props.onClick();assert.equal(inserted,clipboard);assert.match(ui.state[8],/正在变化/);
    assert.equal(ui.state[0],clipboard);assert.equal(ui.calls.length,0);
    ui.find(n=>n.props['aria-label']==='模板名称').props.onChange({target:{value:'My fixture prompt'}});
    await ui.button('保存个人模板').props.onClick();assert.equal(ui.state[2].at(-1).text,clipboard);
  });
  await test('prompt drafts are isolated by session and direction, personal templates persist, and nothing injects drafts',async()=>{
    const draft={text:'Unsent controlled fixture draft',template:'',mode:'regular'};
    await results.dispatch(ctx,store,'chat.draft',{sessionId:'hero',mode:'regular',draft});
    assert.equal((await results.dispatch(ctx,store,'chat.draft',{sessionId:'hero',mode:'regular'})).draft.text,draft.text);
    for(const [sessionId,mode] of [['ui','regular'],['hero','nday']])assert.equal((await results.dispatch(ctx,store,'chat.draft',{sessionId,mode})).draft,null);
    assert((await results.dispatch(ctx,store,'chat.templates',{sessionId:'ui'})).templates.some(row=>row.title==='My fixture prompt'));
    assert(!sections[0].text({agent:{session:sessionMap.get('hero')}}).includes(draft.text));
    await assert.rejects(results.dispatch(ctx,store,'chat.draft',{sessionId:'audit',mode:'regular',draft}),/渗透会话/);
    const editedAt=Date.now()+100;
    await results.dispatch(ctx,store,'chat.draft',{sessionId:'hero',mode:'regular',draft:{...draft,text:'Newest edit',editedAt}});
    await results.dispatch(ctx,store,'chat.draft',{sessionId:'hero',mode:'regular',draft:{...draft,text:'Delayed obsolete save',editedAt:editedAt-1}});
    assert.equal((await results.dispatch(ctx,store,'chat.draft',{sessionId:'hero',mode:'regular'})).draft.text,'Newest edit');
  });
  await test('new-session defaults preserve already chosen sessions and running tasks',async()=>{
    const running='chat-default-running';sessionMap.set(running,{id:running,header:{agentPreset:'pentest'}});
    await results.dispatch(ctx,store,'task.choose',{sessionId:running,mode:'regular',workers:1,interaction:'continuous'});
    await results.dispatch(ctx,store,'task.start',{sessionId:running,policy:{mode:'regular',question:'Preserve active preferences',budget:{toolCalls:4,minutes:10}}});
    const original=readTaskPolicy(store,running);assert(original&&!original.planComplete);
    await results.dispatch(ctx,store,'chat.defaults',{sessionId:'chat-live',interaction:'milestone',workers:0});
    const id='new-default';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    const newState=await results.dispatch(ctx,store,'chat.settings',{sessionId:id});
    assert.equal(newState.options.interaction,'milestone');assert.equal(newState.options.workers,0);
    assert.match(sections[0].text({agent:{session:sessionMap.get(id)}}),/子代理上限=0/);
    assert.equal(chosenTaskOptions(store,'hero').workers,1);
    assert.deepEqual(readTaskPolicy(store,running),original);
    await results.dispatch(ctx,store,'task.start',{sessionId:id,policy:{mode:'regular',budget:{toolCalls:3}}});
    assert.equal(readTaskPolicy(store,id).interaction,'milestone');assert.equal(readTaskPolicy(store,id).workerLimit,0);
  });
  await test('Desktop row and export labels do not call incomplete verified records usable findings', () => {
    const sandbox = { STATUS_LABEL: { verified: '已验证' } };
    const start = source.indexOf('function statusTextForExport('), end = source.indexOf('function Btn(', start);
    // Only the two label functions are evaluated; no mocked finding verdict is injected.
    const firstEnd = source.indexOf('\n}', source.indexOf('function statusTextFor(')) + 2;
    runInNewContext(source.slice(source.indexOf('function statusTextFor('), firstEnd) + '\n' + source.slice(start, end), sandbox);
    for (const row of [{ status: 'verified' }, { status: 'verified', delivery: { ready: false } }]) {
      assert.equal(sandbox.statusTextFor(row, 'pentest', sandbox.STATUS_LABEL), '需重新验证');
      assert.equal(sandbox.statusTextForExport(row, 'pentest'), '需重新验证');
    }
    const complete = { status: 'verified', delivery: { ready: true } };
    assert.equal(sandbox.statusTextFor(complete, 'pentest', sandbox.STATUS_LABEL), '已验证');
    assert.equal(sandbox.statusTextForExport(complete, 'pentest'), '已验证');
  });
} finally {
  for (const dispose of disposers.reverse()) await dispose();
  store.close(); fs.rmSync(home, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
