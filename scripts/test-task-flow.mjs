import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { openStore } from '../plugins/dsh-redteam-results/lib/store.js';
import { saveTaskContext, readTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js';
import { chooseTaskMode, chosenTaskOptions, startTaskPolicy, readTaskPolicy, updateTaskProgress, taskPolicyStatus, taskExecutionGuard, pauseTaskPolicy, takeTaskContinuation, finishTaskOnTurnEnd, taskPrompt, checkpointTask, setTaskInteraction, confirmTaskCheckpoint, archiveTaskRound } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { hostWorkerLimit } from '../plugins/dsh-redteam-results/lib/site-workers.js';
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
    // v6 第 5.5 节稳定值：旧值只读迁移为 auto / confirm-step。
    for(const [input,expected] of [['continuous','auto'],['milestone','auto'],['confirm','confirm-step'],['guided','confirm-step'],['auto','auto'],['confirm-data-change','confirm-data-change'],['confirm-step','confirm-step']]){
      const id='frequency-'+input;
      chooseTaskMode(store,id,'regular',{interaction:input,workflow:'regular-to-nday',workers:0});
      const selected=taskPolicyStatus(store,id);assert.equal(selected.options.interaction,expected,'legacy '+input+' migrates to '+expected);
      assert.match(taskPrompt(selected),/询问时机/);
      const other=expected==='auto'?'confirm-step':'auto';
      assert.throws(()=>startTaskPolicy(store,id,{mode:'regular',interaction:other,budget:{toolCalls:5}}),/interaction differs/);
      const policy=startTaskPolicy(store,id,{mode:'regular',budget:{toolCalls:5,minutes:10}});
      assert.equal(policy.interaction,expected);
      assert.equal(taskExecutionGuard(store,id,'recorded-http-execution'),undefined);
      updateTaskProgress(store,id,{regularComplete:true});
      const gated=expected!=='auto';
      assert.equal(taskPolicyStatus(store,id).stopped,gated);
      assert.equal(!!takeTaskContinuation(store,id),!gated);
      assert.match(taskPrompt(taskPolicyStatus(store,id)),expected==='auto'?/自行推进/:expected==='confirm-data-change'?/改动网站数据前问我/:/每个检查步骤前问我/);
    }
    assert.throws(()=>chooseTaskMode(store,'invalid-frequency','nday',{interaction:'never-stop'}),/invalid interaction/);
  });
  await test('start mode is selected once, enters the prompt and cannot be replaced after Desktop choice',()=>{
    chooseTaskMode(store,'start-mode','regular',{startMode:'direct-test',workers:0});
    assert.equal(taskPolicyStatus(store,'start-mode').options.startMode,'direct-test');
    assert.throws(()=>startTaskPolicy(store,'start-mode',{mode:'regular',startMode:'auto-recon',budget:{toolCalls:5}}),/start mode differs/);
    const policy=startTaskPolicy(store,'start-mode',{mode:'regular',budget:{toolCalls:5,minutes:10}});
    assert.equal(policy.startMode,'direct-test');
    assert.match(taskPrompt(taskPolicyStatus(store,'start-mode')),/起步方式=直接测试/);
    assert.throws(()=>chooseTaskMode(store,'invalid-start','regular',{startMode:'invented'}),/invalid task start mode/);
  });
  await test('host worker capacity is read from maxActiveSubagents and never exceeds the product ceiling',()=>{
    assert.equal(hostWorkerLimit({ get: name => name === 'subagents' ? { config: { maxActiveSubagents: { get: () => 8 } } } : undefined }), 8);
    assert.equal(hostWorkerLimit({ get: name => name === 'subagents' ? { config: { maxActiveSubagents: { get: () => 99 } } } : undefined }), 16);
    assert.equal(hostWorkerLimit({}), 16);
  });
  await test('stage confirmation blocks target operations and completion until a Desktop action without resetting budget or clock',()=>{
    const id='frequency-confirm',before=readTaskPolicy(store,id);
    assert.match(taskExecutionGuard(store,id,'recorded-http-execution'),/interaction_confirmation_required/);
    assert.throws(()=>updateTaskProgress(store,id,{ndayComplete:true}),/等待桌面确认/);
    assert.throws(()=>archiveTaskRound(store,id,'desktop-user'),/先确认继续或停止/);
    assert.throws(()=>confirmTaskCheckpoint(store,id,'model'),/Desktop user confirmation/);
    setTaskInteraction(store,id,'continuous','desktop-user');
    assert.equal(taskPolicyStatus(store,id).reason,'interaction_confirmation_required','changing frequency must not silently resume a pending checkpoint');
    confirmTaskCheckpoint(store,id,'desktop-user');
    const after=readTaskPolicy(store,id);
    for(const key of ['budget','used','startedAt','question','target','flow'])assert.deepEqual(after[key],before[key]);
    assert.equal(taskExecutionGuard(store,id,'recorded-http-execution'),undefined);
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
  await test('a stopped model turn closes the round without claiming completion or waiting for the deadline',()=>{
    const id='turn-ended';
    start(id,'single',0);
    assert.equal(taskPolicyStatus(store,id).stopped,false);
    const stopped=finishTaskOnTurnEnd(store,id);
    assert.equal(stopped.reason,'turn_ended');
    assert.equal(taskPolicyStatus(store,id).reason,'turn_ended');
    assert.match(taskExecutionGuard(store,id,'recorded-http-execution'),/turn_ended/);
    assert.equal(readTaskPolicy(store,id).planComplete,false,'turn end is not plan completion');
    assert.equal(finishTaskOnTurnEnd(store,id),null,'already stopped');
    const flow='turn-ended-flow';
    start(flow,'regular-to-nday',0);
    updateTaskProgress(store,flow,{regularComplete:true});
    assert.equal(finishTaskOnTurnEnd(store,flow),null,'continuation flow must not be closed by turn end');
    assert.equal(takeTaskContinuation(store,flow)?.role,'user');
  });
  await test('Desktop plan and zero-worker choice persist and model cannot substitute a plan or raise the ceiling',()=>{
    chooseTaskMode(store,'selected','regular',{workflow:'regular-to-nday',workers:0});
    assert.throws(()=>startTaskPolicy(store,'selected',{mode:'regular',workflow:'single',budget:{toolCalls:5}}),/workflow differs/);
    assert.throws(()=>startTaskPolicy(store,'selected',{mode:'regular',budget:{toolCalls:5,workers:1}}),/不能提高/);
    const policy=startTaskPolicy(store,'selected',{mode:'regular',budget:{toolCalls:5}});
    assert.equal(policy.flow.kind,'regular-to-nday');assert.equal(policy.workerLimit,0);
    assert.throws(()=>chooseTaskMode(store,'selected','nday'),/不能切换/);
    assert.throws(()=>chooseTaskMode(store,'invalid','nday',{workflow:'regular-with-nday'}),/只能从常规/);
    assert.equal(start('higher-limit','regular-with-nday',16).workerLimit,16);
    assert.throws(()=>start('over-limit','regular-with-nday',17),/0 and 16/);
  });
  // v6 第 5.5 节「同时工作的 AI 助手：默认自动，最多 2 个」+ 8.3「初始自动上限 2」。
  // 实测默认落在 1（chooseTaskMode / startTaskPolicy / 客户端三处都是 1），与方案不符。
  await test('default worker ceiling is the plan value 2, not 1',()=>{
    chooseTaskMode(store,'default-workers','regular');
    assert.equal(chosenTaskOptions(store,'default-workers').workers,2,'未指定人数时，已选任务要落在 2');
    const policy=startTaskPolicy(store,'default-workers-direct',{mode:'regular',budget:{toolCalls:5}});
    assert.equal(policy.workerLimit,2,'连任务选项都没有时也要落在 2');
  });
  await test('regular completion advances the actual mode without resetting time, operations, question, scope or materials',()=>{
    const first=start('sequential','regular-to-nday');
    saveTaskContext(store,'sequential',{assets:[{id:'fixture',url:'https://fixture.test',inScope:true,reachable:true,product:'Synthetic Fixture'}]});
    assert.equal(taskExecutionGuard(store,'sequential','recorded-http-execution'),undefined);
    updateTaskProgress(store,'sequential',{planComplete:true,note:'Synthetic product metadata collected'});
    const next=readTaskPolicy(store,'sequential');
    assert.equal(next.mode,'nday');assert.equal(next.flow.phase,'nday');assert.equal(next.planComplete,false);
    assert.equal(next.finishedAt,undefined);assert.equal(next.used.toolCalls,1);
    for(const field of ['budget','startedAt','target','question','workerLimit'])assert.deepEqual(next[field],first[field]);
    assert.equal(readTaskContext(store,'sequential').assets[0].product,'Synthetic Fixture');
    assert.equal(taskPolicyStatus(store,'sequential').stopped,false);
    assert.match(taskPrompt(taskPolicyStatus(store,'sequential')),/现在检查Nday/);
    for(let n=0;n<4;n++)assert.equal(taskExecutionGuard(store,'sequential','recorded-http-execution'),undefined);
    assert.match(taskExecutionGuard(store,'sequential','recorded-http-execution'),/已停止/);
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
    store.db.prepare('INSERT INTO site_workers(parent_session,child_id,site,record) VALUES(?,?,?,?)').run('parallel','child','https://fixture.test',JSON.stringify({state:'running',parentId:'parallel',childId:'child',site:'https://fixture.test',allowedTools:['redteam_execution']}));
    startTaskPolicy(store,'child',{mode:'nday',parentSession:'parallel',budget:{toolCalls:5,workers:0}});
    assert.equal(takeTaskContinuation(store,'parallel'),null,'live site worker already owns ongoing work');
    for(let n=0;n<5;n++)assert.equal(taskExecutionGuard(store,n%2?'parallel':'child','recorded-http-execution'),undefined);
    assert.equal(readTaskPolicy(store,'parallel').used.toolCalls,5);
    assert.equal(readTaskPolicy(store,'parallel').budget.deadline,state.budget.deadline);
    assert.match(taskExecutionGuard(store,'child','recorded-http-execution'),/parent_task_stopped/);
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
  await test('all modes share one 36-template library; copying uses the final text and clipboard errors stay visible without starting a task',async()=>{
    const source=fs.readFileSync(new URL('../plugins/dsh-redteam-results/lib/client.js',import.meta.url),'utf8');
    const { builtinTemplates }=await import('../plugins/dsh-redteam-results/lib/prompt-templates.js');
    const catalog=builtinTemplates();
    assert.equal(catalog.length,36,'the editor ships 36 mode-independent templates');
    // 同一份目录对所有模式可见；每种模式都能复制到最终文字。
    const snippet=source.slice(source.indexOf('function promptSubstitute('),source.indexOf('function ChatSetup('));
    const clipboard=[],values=[];let cursor=0,fail=false,notices=[];
    const library={ok:true,builtin:catalog,fields:(await import('../plugins/dsh-redteam-results/lib/prompt-templates.js')).promptFields(),user:{templates:[],total:0,more:0}};
    const sandbox={useState:initial=>{const i=cursor++;if(!(i in values))values[i]=initial;return[values[i],v=>values[i]=v]},useRef:initial=>{const i=cursor++;if(!(i in values))values[i]={current:initial};return values[i]},
      useEffect(fn){const i=cursor++;if(!(i in values)){values[i]=true;fn();}},
      React:{createElement:(type,props,...children)=>({type,props:props||{},children})},
      navigator:{clipboard:{writeText:text=>{if(fail)throw Error('offline clipboard denial');clipboard.push(text)}}},
      api:async endpoint=>endpoint==='prompt.library'?library:{ok:true,drafts:[],draft:{revision:1}}};
    runInNewContext(snippet+';this.component=ChatPromptEditor;',sandbox);
    const nodes=node=>!node||typeof node!=='object'?[]:[node,...node.children.flat(Infinity).flatMap(nodes)];
    const tree=async m=>{cursor=0;sandbox.component({mode:m,open:true});await new Promise(setImmediate);cursor=0;return nodes(sandbox.component({mode:m,open:true}));};
    for(const mode of ['regular','nday','0day']){
      const pick=(await tree(mode)).find(n=>n.type==='button'&&JSON.stringify(n).includes('从一个网站开始'));
      assert(pick,mode+' must expose the shared template library');
      pick.props.onClick();
      const sel=await tree(mode);
      sel.find(n=>n.props['aria-label']==='目标地址').props.onChange({target:{value:'https://example.test'}});
      const full=(await tree(mode)).find(n=>n.props['aria-label']==='提示词全文').props.value;
      assert(full.includes('https://example.test'));
      await (await tree(mode)).find(n=>n.type==='button'&&n.children.includes('复制')).props.onClick();
      assert.equal(clipboard.at(-1),full,'copy must emit the exact final text');
      assert.equal(readTaskPolicy(store,'copy-only'),null,'copying never starts a task');
    }
    fail=true;
    (await tree('regular')).find(n=>n.type==='button'&&JSON.stringify(n).includes('从一个网站开始')).props.onClick();
    await (await tree('regular')).find(n=>n.type==='button'&&n.children.includes('复制')).props.onClick();
    cursor=0;assert(JSON.stringify(sandbox.component({mode:'regular',open:true})).includes('复制失败'),'a clipboard denial must be visible');
    assert.equal(clipboard.length,3,'a failed copy appends nothing');
  });
} finally { for(const dispose of disposers.reverse())await dispose();store.close(); }
process.exitCode=failed?1:0;
