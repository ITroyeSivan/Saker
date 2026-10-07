import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { readTaskPolicy, updateTaskProgress, checkpointTask } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { saveTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js';
import { createResearch } from '../plugins/dsh-redteam-results/lib/research.js';
import { captureTaskCost, taskCostOverview } from '../plugins/dsh-redteam-results/lib/task-cost.js';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-task-ui-'));
process.env.DSH_HOME = home;
const results = await import('../plugins/dsh-redteam-results/lib/index.js');
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
const sections = [], disposers = [], registeredTools = new Map();
const sessionMap = new Map(['ui', 'hero', 'nday', 'regular', '0day', 'records', 'interaction-ui'].map(id => [id, { id, header: { agentPreset: 'pentest' } }]));
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
function harness(name, sessionId) {
  const state = [], calls = []; let cursor = 0;
  const sandbox = { useState: value => { const index = cursor++; if (!(index in state)) state[index] = value; return [state[index], next => { state[index] = typeof next === 'function' ? next(state[index]) : next; }]; },
    useEffect: () => {}, Btn: 'button', React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) },
    api: async (endpoint, payload) => { calls.push([endpoint, payload]); try { return await results.dispatch(ctx, store, endpoint, payload); } catch (error) { return { ok: false, error: error.message }; } } };
  runInNewContext(componentSource + '; this.component = ' + name, sandbox);
  function render() { cursor = 0; return sandbox.component({ sessionId }); }
  function nodes(node) { if (!node || typeof node !== 'object') return []; return [node, ...node.children.flat(Infinity).flatMap(nodes)]; }
  return { state, calls, render, find: predicate => nodes(render()).find(predicate), button: label => nodes(render()).find(node => node.type === 'button' && node.children.includes(label)) };
}
let failed = 0;
async function test(name, fn) { try { await fn(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + error.message); } }
try {
  await test('Desktop interaction control saves preferences, confirms a real checkpoint and preserves policy on failed delivery',async()=>{
    const id='interaction-ui';
    const control=harness('InteractionControl',id);
    const select=control.find(n=>n.type==='select'&&n.props['aria-label']==='交互频率');
    assert.equal(select.children.length,3);
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
    const start = source.indexOf('function EffectEvidenceView('), end = source.indexOf('function WorkflowSelector(', start);
    const sandbox = { useState: value => [value, () => {}], React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) } };
    runInNewContext(source.slice(start, end) + ';this.component=EffectEvidenceView;', sandbox);
    assert.equal(sandbox.component({ finding: {} }), null);
    const view = sandbox.component({ finding: { executionEvidence: { effectEvidence: { kind: 'private-json-read/v1', comparisons: [{ ownerMarkerSha256: 'owner-hash' }] } } } });
    assert.equal(view.type, 'details'); assert.equal(view.props.open, undefined);
    assert.equal(view.props['aria-label'], '独立影响对照'); assert(JSON.stringify(view).includes('owner-hash'));
    assert(source.includes('React.createElement(EffectEvidenceView, { finding: f, onReviewed: props.onEffectReview })'));
  });
  await test('a successful Desktop impact review refreshes its parent while a rejected review keeps the form', async () => {
    const start=source.indexOf('function EffectEvidenceView('),end=source.indexOf('function WorkflowSelector(',start);
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
  await test('three actual workflow buttons apply explicit research budget and cancellation persists without reset', async () => {
    const ui = harness('TaskPanel', 'ui');
    for (const label of ['Nday发现', '常规测试', '0Day挖掘']) assert(ui.button(label));
    await ui.button('0Day挖掘').props.onClick();
    ui.find(node => node.type === 'input' && node.props['aria-label'] === '操作预算').props.onChange({ target: { value: '40' } });
    ui.find(node => node.type === 'input' && node.props['aria-label'] === '初步观察预算').props.onChange({ target: { value: '7' } });
    ui.find(node => node.type === 'input' && node.props['aria-label'] === '这一轮要查什么').props.onChange({ target: { value: 'Inspect the controlled fixture permission only' } });
    await ui.button('开始这个小任务').props.onClick();
    assert.equal(readTaskPolicy(store, 'ui').mode, '0day');
    assert.equal(readTaskPolicy(store, 'ui').budget.toolCalls, 40);
    assert.equal(readTaskPolicy(store, 'ui').budget.discoveryCalls, 7);
    const uiQueued=queued.filter(row=>row.id==='ui');assert.equal(uiQueued.length, 1);
    assert.match(uiQueued[0].message.content[0].text, /Inspect the controlled fixture permission only/);
    assert.equal(ui.calls.at(-1)[1].sessionId, 'ui');
    assert(!ui.button('开始这个小任务'));
    await ui.button('停止本轮与子代理').props.onClick();
    assert.equal(readTaskPolicy(store, 'ui').cancelled, true);
    assert.deepEqual(cancellations, [{ id: 'ui', cause: { kind: 'user' } }]);
    assert(!ui.button('停止本轮与子代理'));
    await ui.button('刷新状态').props.onClick();
    assert(ui.find(node => node.type === 'p' && node.children.some(value => String(value).includes('用户已停止'))));
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
    await ui.button('保留资料，选择下一轮问题').props.onClick();
    assert.equal(readTaskPolicy(store,'ui'),null);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM task_rounds WHERE session_id=?').get('ui').n,1);
    assert((await results.dispatch(ctx,store,'context.index',{sessionId:'ui'})).text.includes('retained'));
    await ui.button('Nday发现').props.onClick();
    ui.find(node=>node.props['aria-label']==='这一轮要查什么').props.onChange({target:{value:'Check only the provided product prerequisite'}});
    await ui.button('开始这个小任务').props.onClick();
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
    const ui = harness('WorkflowSelector', 'hero');
    for (const label of ['Nday发现', '常规测试', '0Day挖掘']) assert(ui.button(label));
    assert(!ui.button('开始这个小任务')); assert(!ui.button('刷新状态'));
    await ui.button('常规测试').props.onClick();
    assert.equal(readTaskPolicy(store, 'hero'), null);
    assert.equal((await results.dispatch(ctx, store, 'task.status', { sessionId: 'hero' })).choice, 'regular');
    assert.equal(ui.button('常规测试').props['aria-pressed'], true);
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
    const hero = harness('WorkflowSelector', 'hero'); assert(!hero.button('读取研究记录'));
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
  await test('new-session hero renders the same task selector only for selected pentest session', () => {
    const modeSource = fs.readFileSync(new URL('../plugins/dsh-mode-group/lib/client.js', import.meta.url), 'utf8');
    const helper = modeSource.slice(modeSource.indexOf('function TaskChoices('), modeSource.indexOf('// —— 视口'));
    const sandbox = { require: () => ({ WorkflowSelector: 'WorkflowSelector' }), React: { createElement: (type, props) => ({ type, props }) } };
    runInNewContext(helper + '; this.component = TaskChoices;', sandbox);
    const ctl = { currentSession: () => ({ id: 'ui', agentPreset: 'pentest' }) };
    assert.equal(sandbox.component({ ctl, current: 'pentest' }).props.sessionId, 'ui');
    assert.equal(sandbox.component({ ctl, current: 'code-audit' }), null);
    assert.equal(sandbox.component({ ctl: { currentSession: () => ({ id: 'audit', agentPreset: 'code-audit' }) }, current: 'pentest' }), null);
  });
  await test('Desktop row and export labels do not call incomplete verified records usable findings', () => {
    const sandbox = { STATUS_LABEL: { verified: '已验证' } };
    const start = source.indexOf('function statusTextForExport('), end = source.indexOf('function Btn(', start);
    // Only the two label functions are evaluated; no mocked finding verdict is injected.
    const firstEnd = source.indexOf('\n}', source.indexOf('function statusTextFor(')) + 2;
    runInNewContext(source.slice(source.indexOf('function statusTextFor('), firstEnd) + '\n' + source.slice(start, end), sandbox);
    for (const row of [{ status: 'verified' }, { status: 'verified', delivery: { ready: false } }]) {
      assert.equal(sandbox.statusTextFor(row, 'pentest', sandbox.STATUS_LABEL), '待补证·不可交付');
      assert.equal(sandbox.statusTextForExport(row, 'pentest'), '待补证·不可交付');
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
