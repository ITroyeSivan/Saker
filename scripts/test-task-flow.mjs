import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { saveTaskContext, readTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js';
import { chooseTaskMode, startTaskPolicy, readTaskPolicy, updateTaskProgress, taskPolicyStatus, taskExecutionGuard, pauseTaskPolicy, takeTaskContinuation, taskPrompt, checkpointTask, setTaskInteraction, confirmTaskCheckpoint, archiveTaskRound } from '../plugins/dsh-redteam-results/lib/task-policy.js';
const results = await import('../plugins/dsh-redteam-results/lib/index.js');
const store = openStore(path.join(process.env.DSH_HOME, 'redteam-results', 'results.db'));
const hooks = new Map(), disposers = [], tools = new Map();
const ctx = { tools: { guard() {}, register: tool => tools.set(tool.name, tool) }, webServer: { register: () => () => {} },
  on(name, fn) { const list=hooks.get(name)||[]; list.push(fn); hooks.set(name,list); },
  effect(fn) { const dispose=fn(); if(typeof dispose==='function')disposers.push(dispose); } };
results.apply(ctx);
const start = (id,workflow,workers=0) => startTaskPolicy(store,id,{mode:'regular',workflow,question:'Read only supplied synthetic fixture metadata',target:'https://fixture.test',budget:{toolCalls:5,minutes:10,workers}});
let failed=0;
async function test(name,fn){try{await fn();console.log('ok   '+name);}catch(error){failed++;console.log('FAIL '+name+': '+error.stack);}}
try {
  await test('interaction preferences persist before start, enter actual prompts and cannot be replaced by a model',()=>{
    for(const interaction of ['continuous','milestone','confirm']){
      const id='frequency-'+interaction;
      chooseTaskMode(store,id,'regular',{interaction,workflow:'regular-to-nday',workers:0});
      const selected=taskPolicyStatus(store,id);assert.equal(selected.options.interaction,interaction);
      assert.match(taskPrompt(selected),/交互频率/);
      assert.throws(()=>startTaskPolicy(store,id,{mode:'regular',interaction:interaction==='confirm'?'continuous':'confirm',budget:{toolCalls:5}}),/interaction differs/);
      const policy=startTaskPolicy(store,id,{mode:'regular',budget:{toolCalls:5,minutes:10}});
      assert.equal(policy.interaction,interaction);
      assert.equal(taskExecutionGuard(store,id,'fixture_http'),undefined);
      updateTaskProgress(store,id,{regularComplete:true});
      assert.equal(taskPolicyStatus(store,id).stopped,interaction==='confirm');
      assert.equal(!!takeTaskContinuation(store,id),interaction!=='confirm');
      assert.match(taskPrompt(taskPolicyStatus(store,id)),interaction==='continuous'?/不要求用户反复说继续/:interaction==='milestone'?/汇报后继续/:/等待桌面确认/);
    }
    assert.throws(()=>chooseTaskMode(store,'invalid-frequency','nday',{interaction:'never-stop'}),/invalid interaction/);
  });
  await test('stage confirmation blocks target operations and completion until a Desktop action without resetting budget or clock',()=>{
    const id='frequency-confirm',before=readTaskPolicy(store,id);
    assert.match(taskExecutionGuard(store,id,'fixture_http'),/interaction_confirmation_required/);
    assert.throws(()=>updateTaskProgress(store,id,{ndayComplete:true}),/等待桌面确认/);
    assert.throws(()=>archiveTaskRound(store,id,'desktop-user'),/先确认继续或停止/);
    assert.throws(()=>confirmTaskCheckpoint(store,id,'model'),/Desktop user confirmation/);
    setTaskInteraction(store,id,'continuous','desktop-user');
    assert.equal(taskPolicyStatus(store,id).reason,'interaction_confirmation_required','changing frequency must not silently resume a pending checkpoint');
    confirmTaskCheckpoint(store,id,'desktop-user');
    const after=readTaskPolicy(store,id);
    for(const key of ['budget','used','startedAt','question','target','flow'])assert.deepEqual(after[key],before[key]);
    assert.equal(taskExecutionGuard(store,id,'fixture_http'),undefined);
    updateTaskProgress(store,id,{ndayComplete:true});assert.equal(taskPolicyStatus(store,id).reason,'plan_complete');
  });
  await test('single-mode checkpoints preserve hard stops and cannot be cleared by model or preference changes',()=>{
    for(const mode of ['regular','nday','0day']){
      const id='checkpoint-'+mode;
      chooseTaskMode(store,id,mode,{interaction:'confirm',workers:0});
      startTaskPolicy(store,id,{mode,budget:{toolCalls:5,minutes:10}});
      checkpointTask(store,id,'Synthetic first stage completed; next stage needs confirmation');
      assert.equal(taskPolicyStatus(store,id).reason,'interaction_confirmation_required');
      assert.throws(()=>updateTaskProgress(store,id,{planComplete:true}),/等待桌面确认/);
      assert.throws(()=>setTaskInteraction(store,id,'continuous','model'),/Desktop user action/);
      if(mode==='regular')updateTaskProgress(store,id,{cancelled:true});
      else if(mode==='nday')pauseTaskPolicy(store,id,{code:'ip-blocked',reason:'Synthetic deny',evidence:'offline fixture'});
      else {const p=readTaskPolicy(store,id);p.used.toolCalls=5;store.db.prepare('UPDATE task_policy SET record=? WHERE session_id=?').run(JSON.stringify(p),id);}
      assert.throws(()=>confirmTaskCheckpoint(store,id,'desktop-user'),/another reason|no main task checkpoint/);
      assert.equal(takeTaskContinuation(store,id),null);
    }
  });
  await test('Desktop plan and zero-worker choice persist and model cannot substitute a plan or raise the ceiling',()=>{
    chooseTaskMode(store,'selected','regular',{workflow:'regular-to-nday',workers:0});
    assert.throws(()=>startTaskPolicy(store,'selected',{mode:'regular',workflow:'single',budget:{toolCalls:5}}),/workflow differs/);
    assert.throws(()=>startTaskPolicy(store,'selected',{mode:'regular',budget:{toolCalls:5,workers:1}}),/不能提高/);
    const policy=startTaskPolicy(store,'selected',{mode:'regular',budget:{toolCalls:5}});
    assert.equal(policy.flow.kind,'regular-to-nday');assert.equal(policy.workerLimit,0);
    assert.throws(()=>chooseTaskMode(store,'selected','nday'),/不能切换/);
    assert.throws(()=>chooseTaskMode(store,'invalid','nday',{workflow:'regular-with-nday'}),/只能从常规/);
    assert.throws(()=>start('over-limit','regular-with-nday',3),/0 and 2/);
  });
  await test('regular completion advances the actual mode without resetting time, operations, question, scope or materials',()=>{
    const first=start('sequential','regular-to-nday');
    saveTaskContext(store,'sequential',{assets:[{id:'fixture',url:'https://fixture.test',inScope:true,reachable:true,product:'Synthetic Fixture'}]});
    assert.equal(taskExecutionGuard(store,'sequential','fixture_http'),undefined);
    updateTaskProgress(store,'sequential',{planComplete:true,note:'Synthetic product metadata collected'});
    const next=readTaskPolicy(store,'sequential');
    assert.equal(next.mode,'nday');assert.equal(next.flow.phase,'nday');assert.equal(next.planComplete,false);
    assert.equal(next.finishedAt,undefined);assert.equal(next.used.toolCalls,1);
    for(const field of ['budget','startedAt','target','question','workerLimit'])assert.deepEqual(next[field],first[field]);
    assert.equal(readTaskContext(store,'sequential').assets[0].product,'Synthetic Fixture');
    assert.equal(taskPolicyStatus(store,'sequential').stopped,false);
    assert.match(taskPrompt(taskPolicyStatus(store,'sequential')),/现在检查Nday/);
    for(let n=0;n<4;n++)assert.equal(taskExecutionGuard(store,'sequential','fixture_http'),undefined);
    assert.match(taskExecutionGuard(store,'sequential','fixture_http'),/已停止/);
  });
  await test('native turn stopping steers the unfinished approved Nday phase once without waking cancelled or aborted work',async()=>{
    const messages=[], agent={session:{id:'native-flow',header:{agentPreset:'pentest'}},steer:m=>messages.push(m)};
    start('native-flow','regular-to-nday');updateTaskProgress(store,'native-flow',{regularComplete:true});
    for(const fn of hooks.get('agent/turn-stopping'))await fn({agent,turn:1,signal:AbortSignal.abort()});
    assert.equal(messages.length,0);
    for(const fn of hooks.get('agent/turn-stopping'))await fn({agent,turn:1,signal:new AbortController().signal});
    assert.equal(messages.length,1);assert.match(messages[0].content[0].text,/Saker 自动衔接/);
    for(const fn of hooks.get('agent/turn-stopping'))await fn({agent,turn:1,signal:new AbortController().signal});
    assert.equal(messages.length,1);
    updateTaskProgress(store,'native-flow',{ndayComplete:true});assert.equal(taskPolicyStatus(store,'native-flow').stopped,true);
    assert.equal(takeTaskContinuation(store,'native-flow'),null);
  });
  await test('blocking, cancellation and elapsed deadlines cannot become a new Nday budget',()=>{
    for(const [id,block] of [['blocked',true],['cancelled',false]]){
      start(id,'regular-to-nday');
      if(block)pauseTaskPolicy(store,id,{code:'ip-blocked',reason:'Synthetic 403 baseline',evidence:'offline fixture'});
      else updateTaskProgress(store,id,{cancelled:true});
      assert.throws(()=>updateTaskProgress(store,id,{regularComplete:true}),/已停止/);
      assert.equal(takeTaskContinuation(store,id),null);assert.equal(readTaskPolicy(store,id).mode,'regular');
    }
    startTaskPolicy(store,'expired',{mode:'regular',workflow:'regular-to-nday',budget:{toolCalls:5,minutes:1}},Date.now()-120000);
    assert.throws(()=>updateTaskProgress(store,'expired',{regularComplete:true}),/已停止/);
    assert.equal(takeTaskContinuation(store,'expired'),null);
  });
  await test('parallel directions finish independently and cannot end the task or bypass the shared operation budget',()=>{
    start('parallel','regular-with-nday');
    assert.throws(()=>updateTaskProgress(store,'parallel',{planComplete:true}),/分别报告/);
    updateTaskProgress(store,'parallel',{regularComplete:true});assert.equal(taskPolicyStatus(store,'parallel').stopped,false);
    assert.equal(readTaskPolicy(store,'parallel').flow.completed.nday,false);
    const state=readTaskPolicy(store,'parallel');
    store.db.prepare('INSERT INTO site_workers(parent_session,child_id,site,record) VALUES(?,?,?,?)').run('parallel','child','https://fixture.test',JSON.stringify({state:'running',parentId:'parallel',childId:'child',site:'https://fixture.test'}));
    startTaskPolicy(store,'child',{mode:'nday',parentSession:'parallel',budget:{toolCalls:5,workers:0}});
    assert.equal(takeTaskContinuation(store,'parallel'),null,'live site worker already owns ongoing work');
    for(let n=0;n<5;n++)assert.equal(taskExecutionGuard(store,n%2?'parallel':'child','fixture_http'),undefined);
    assert.equal(readTaskPolicy(store,'parallel').used.toolCalls,5);
    assert.equal(readTaskPolicy(store,'parallel').budget.deadline,state.budget.deadline);
    assert.match(taskExecutionGuard(store,'child','fixture_http'),/parent_task_stopped/);
    assert.throws(()=>updateTaskProgress(store,'parallel',{ndayComplete:true}),/已停止/);
    start('parallel-done','regular-with-nday');updateTaskProgress(store,'parallel-done',{ndayComplete:true});
    assert.equal(taskPolicyStatus(store,'parallel-done').stopped,false);
    updateTaskProgress(store,'parallel-done',{regularComplete:true});assert.equal(taskPolicyStatus(store,'parallel-done').reason,'plan_complete');
  });
  await test('sequential handoff waits for idle or failed-release workers and preserves the original policy on refusal',()=>{
    start('release-first','regular-to-nday',1);
    for(const state of ['running','cleanup-failed']){
      store.db.prepare('INSERT OR REPLACE INTO site_workers(parent_session,child_id,site,record) VALUES(?,?,?,?)').run('release-first','release-child','https://fixture.test',JSON.stringify({state}));
      assert.throws(()=>updateTaskProgress(store,'release-first',{regularComplete:true}),/先释放/);
      assert.equal(readTaskPolicy(store,'release-first').flow.phase,'regular');
    }
    store.db.prepare('UPDATE site_workers SET record=? WHERE child_id=?').run(JSON.stringify({state:'released'}),'release-child');
    updateTaskProgress(store,'release-first',{regularComplete:true});assert.equal(readTaskPolicy(store,'release-first').mode,'nday');
  });
  await test('all modes expose multiple usable copy examples; clipboard errors are visible and copying never starts a task',async()=>{
    const source=fs.readFileSync(new URL('../plugins/dsh-redteam-results/lib/client.js',import.meta.url),'utf8');
    const snippet=source.slice(source.indexOf('function exampleTemplates('),source.indexOf('function ChatSetup('));
    const clipboard=[],values=[];let cursor=0,fail=false;
    const sandbox={useState:initial=>{const i=cursor++;if(!(i in values))values[i]=initial;return[values[i],v=>values[i]=v]},useRef:initial=>{const i=cursor++;if(!(i in values))values[i]={current:initial};return values[i]},useEffect(){},React:{createElement:(type,props,...children)=>({type,props:props||{},children})},navigator:{clipboard:{writeText:text=>{if(fail)throw Error('offline clipboard denial');clipboard.push(text)}}}};
    runInNewContext(snippet+';this.examples=exampleTemplates;this.component=ChatPromptEditor;',sandbox);
    const nodes=node=>!node||typeof node!=='object'?[]:[node,...node.children.flat(Infinity).flatMap(nodes)];
    for(const mode of ['regular','nday','0day']){
      const rows=sandbox.examples(mode);assert.equal(rows.length,3);assert.equal(new Set(rows.map(x=>x.text)).size,3);
      cursor=0;sandbox.component({mode,open:true});values[6]=true;
      for(const row of rows){values[0]=row.text;cursor=0;await nodes(sandbox.component({mode,open:true})).find(n=>n.children.includes('复制提示词')).props.onClick();}
      assert.equal(clipboard.at(-1),rows.at(-1).text);
    }
    fail=true;cursor=0;await nodes(sandbox.component({mode:'regular',open:true})).find(n=>n.children.includes('复制提示词')).props.onClick();
    assert.match(values[8],/复制失败/);assert.equal(clipboard.length,9);
    assert.equal(readTaskPolicy(store,'copy-only'),null);
  });
} finally { for(const dispose of disposers.reverse())await dispose();store.close(); }
process.exitCode=failed?1:0;
