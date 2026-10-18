import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import { apply } from '../plugins/dsh-redteam-results/lib/index.js';
import { registerTaskPrompt, compactRuntimeContexts, TASK_RULE_TEXT, TASK_RULE_BUDGET } from '../plugins/dsh-redteam-results/lib/task-prompt.js';
const sections=[],contexts=[],tools=new Map(),guards=[],disposers=[];
apply({systemPrompt:{section:p=>sections.push(p),context:p=>contexts.push(p)},
  tools:{register:t=>tools.set(t.name,t),guard:g=>guards.push(g)},
  effect:fn=>{const cleanup=fn();if(typeof cleanup==='function')disposers.push(cleanup)},webServer:{register:()=>()=>{}}});
const exec=id=>({agent:{session:{id,header:{agentPreset:'pentest',cwd:process.env.DSH_HOME}}}});
const task=tools.get('redteam_task'),section=sections.find(p=>p.name==='saker-pentest-task'),context=contexts.find(p=>p.name==='saker-pentest-task-state');
let failed=0;async function test(name,fn){try{await fn();console.log('ok '+name)}catch(error){failed++;console.log('FAIL '+name+': '+error.stack)}}
try{
  // v6 第 4.1 节：固定说明「初始控制在 600 token 内；无可靠计量器时使用 1800 UTF-8 字节并标为近似」。
  // 没有 token 计量器，所以口径必须是字节近似；上限也要有人盯住。
  await test('fixed capability note stays inside the plan budget and is marked approximate',async()=>{
    assert.equal(TASK_RULE_BUDGET.unit,'bytes-approx','没有 token 计量器时必须标成字节近似');
    assert.equal(TASK_RULE_BUDGET.bytes,1800);
    assert.equal(TASK_RULE_BUDGET.tokens,600);
    const bytes=Buffer.byteLength(TASK_RULE_TEXT,'utf8');
    assert(bytes<=TASK_RULE_BUDGET.bytes,`固定说明 ${bytes} 字节超过上限 ${TASK_RULE_BUDGET.bytes}`);
    // v6 第 4.1 节还要求这条固定说明的内容限定为四件事；同时明确不重新引入角色模板/方法清单/固定流程。
    for (const phrase of ['查询当前任务设置','读取相关资料','使用可用工具','引用实际结果']) {
      assert(TASK_RULE_TEXT.includes(phrase),`固定说明必须写明能力范围：${phrase}`);
    }
    assert(TASK_RULE_TEXT.includes('它不是角色模板、方法清单或固定流程'),'固定说明必须明确排除角色模板/方法清单/固定流程');
  });
  await test('pre-step surface replacement keeps append-only raw events and the latest snapshot after restart',async()=>{
    const snapshot=text=>({role:'user',source:{kind:'runtime-context',form:'snapshot',sections:[{name:'policy',text}]},content:[{type:'text',text:'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n'+text}]});
    const events=new Map([[1,{type:'user/message',data:snapshot('old')}],[2,{type:'tool/result',data:{raw:'original response'}}],[3,{type:'user/message',data:snapshot('current')}]]);
    const nodes=[1,2,3],replacements=[];
    const session={surface:{nodes},eventAt:seq=>events.get(seq),append:(type,data,intent)=>{const seq=events.size+1;events.set(seq,{type,data});nodes[nodes.indexOf(intent.surfaceOp.startSeq)]=seq;replacements.push(intent);}};
    assert.equal(compactRuntimeContexts(session),1);assert.deepEqual(replacements[0].sourceEventSeqs,[1]);assert.equal(events.get(1).data.content[0].text.includes('old'),true);
    assert.deepEqual(nodes,[4,2,3]);assert.equal(events.get(2).data.raw,'original response');assert.equal(compactRuntimeContexts(session),0);
    assert.equal(compactRuntimeContexts(session,[snapshot('new')]),1);assert.deepEqual(replacements[1].sourceEventSeqs,[3]);assert.equal(events.get(3).data.content[0].text.includes('current'),true);
    let handler;registerTaskPrompt({systemPrompt:{section:()=>{},context:()=>{}},on:(_event,fn)=>{handler=fn;}},()=>true,()=> 'live');
    const decision=Object.freeze({kind:'enter',messages:Object.freeze([snapshot('pending')])});
    assert.equal(await handler({agent:{session},signal:new AbortController().signal},async()=>decision),decision);
    const blocked=Object.freeze({kind:'reject'});assert.equal(await handler({agent:{session}},async()=>blocked),blocked);
  });
  await test('latest snapshot projection respects clearing and keeps notices and raw input',()=>{
    const snapshot=(text)=>({role:'user',source:{kind:'runtime-context',form:'snapshot',sections:[{name:'policy',text}]},content:[{type:'text',text:'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n'+text}]});
    const old=snapshot('old'),current=snapshot('current');
    const cleared={role:'user',source:{kind:'runtime-context'},content:[{type:'text',text:'Current runtime context: none. Earlier runtime-context snapshots no longer apply.'}]};
    const notice={...old,source:{kind:'runtime-context',form:'notice',summary:'one-off event'}};
    const plain={...old,source:{kind:'user'}};
    const inconsistent={...old,content:[{type:'text',text:'Raw material outside the declared section metadata'}]};
    for(const [messages,expected] of [[[plain,notice],[]],[[old,notice,plain,inconsistent,cleared],[0]],[[old,cleared,current],[0,1]],[[old,current],[0]]]){
      const replaced=[];const session={surface:{nodes:messages.map((_,i)=>i)},eventAt:i=>({type:'user/message',data:messages[i]}),append:(_t,_d,intent)=>replaced.push(intent.surfaceOp.startSeq)};
      assert.equal(compactRuntimeContexts(session),expected.length);assert.deepEqual(replaced,expected);
    }
  });
  await test('task transitions keep the registered system section stable while native context exposes live budgets and completion',async()=>{
    assert(section&&context,'native task context was not registered');
    const scope=exec('live-state'),stable=section.text(scope);assert.match(stable,/最新快照/);
    const started=await task.execute({action:'start',mode:'regular',target:'http://127.0.0.1:8081',question:'Controlled fixture scope',toolCalls:3,unmeteredToolCalls:3,workers:0},scope);assert(started.ok,started.error);
    assert.match(context.text(scope),/Saker task state/);assert.match(context.text(scope),/Controlled fixture scope/);
    // 常驻快照不能携带每次工具调用都会变的用量计数：否则宿主每个工具调用都会追加
    // 新的 runtime-context 消息，缓存整段失效。精确用量改由 redteam_task status 查询。
    const first=context.text(scope);assert(!first.includes('操作=')&&!first.includes('未计量目标流量='),'常驻快照不携带易变用量计数');
    assert(first.includes('需要精确用量时调用 redteam_task action=status'),'常驻快照提示按需查询用量');
    const allowed=guards[0]({...scope,name:'pwsh'});assert.equal(allowed,undefined);
    assert.equal(context.text(scope),first,'工具调用计数变化不改常驻快照');assert.equal(section.text(scope),stable);
    const done=await task.execute({action:'progress',planComplete:true},scope);assert(done.stopped);assert.match(context.text(scope),/plan_complete/);assert.notEqual(context.text(scope),first,'任务状态变化会更新快照');assert.equal(section.text(scope),stable);
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
