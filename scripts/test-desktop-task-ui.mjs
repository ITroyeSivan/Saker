import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { openStore, registerFinding } from '../plugins/dsh-redteam-results/lib/store.js';
import { claimWork } from '../plugins/dsh-redteam-results/lib/work-lease.js';
import { readTaskPolicy, updateTaskProgress, checkpointTask, chosenTaskOptions, startTaskPolicy, setTaskActionLimits, taskExecutionGuard, effectivePolicy, excludedPathDenial, finishTaskOnTurnEnd } from '../plugins/dsh-redteam-results/lib/task-policy.js';
import { saveAccount } from '../plugins/dsh-redteam-results/lib/accounts.js';
import { resolveTaskIdentity, identityDenial } from '../plugins/dsh-redteam-results/lib/identity-binding.js';
import { saveTaskContext } from '../plugins/dsh-redteam-results/lib/task-context.js';
import { siteWorkerView } from '../plugins/dsh-redteam-results/lib/site-workers.js';
import { createResearch } from '../plugins/dsh-redteam-results/lib/research.js';
import { readDraft, listDrafts } from '../plugins/dsh-redteam-results/lib/prompt-store.js';
import { captureTaskCost, taskCostOverview } from '../plugins/dsh-redteam-results/lib/task-cost.js';
import { competitionPromptState } from '../plugins/dsh-redteam-results/lib/competition-store.js';
import { importPastedMaterial } from '../plugins/dsh-redteam-results/lib/materials-import.js';
import { indexKnowledgeEntry } from '../plugins/dsh-redteam-results/lib/knowledge-index.js';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'saker-task-ui-'));
process.env.DSH_HOME = home;
const results = await import('../plugins/dsh-redteam-results/lib/index.js');
const store = openStore(path.join(home, 'redteam-results', 'results.db'));
const modeSource = fs.readFileSync(new URL('../plugins/dsh-mode-group/lib/client.js', import.meta.url), 'utf8');
const sections = [], disposers = [], registeredTools = new Map();
const sessionMap = new Map(['ui', 'hero', 'hero-selection', 'hero-append', 'nday', 'regular', '0day', 'records', 'interaction-ui', 'poll-readonly'].map(id => [id, { id, header: { agentPreset: 'pentest' } }]));
sessionMap.set('audit', { id: 'audit', header: { agentPreset: 'code-audit' } });
const queued = [], cancellations = [];
const eventHandlers = new Map();
const agents = { get: id => sessionMap.has(id) ? { session: sessionMap.get(id), status: 'idle', followup: message => queued.push({ id, message }), cancel: cause => cancellations.push({ id, cause }) } : undefined };
const ctx = { sessions: { get: id => sessionMap.get(id) }, systemPrompt: { section: section => sections.push(section) },
  agents,
  on: (name, handler) => eventHandlers.set(name, [...(eventHandlers.get(name) || []), handler]),
  tools: { register: tool => registeredTools.set(tool.name,tool), guard: () => {} }, effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
  webServer: { register: () => () => {} } };
results.apply(ctx);
const source = fs.readFileSync(new URL('../plugins/dsh-redteam-results/lib/client.js', import.meta.url), 'utf8');
const componentSource = source.slice(source.indexOf('function exampleTemplates('), source.indexOf('function CheckedList('));
function harness(name, sessionId, props = {}, extras = {}) {
  const state = [], calls = [], effects = [], timers = []; let cursor = 0;
  const sandbox = { useState: value => { const index = cursor++; if (!(index in state)) state[index] = value; return [state[index], next => { state[index] = typeof next === 'function' ? next(state[index]) : next; }]; },
    useEffect: effect => effects.push(effect), setInterval: fn => { timers.push(fn); return timers.length; }, clearInterval: () => {}, setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: () => {}, useRef: initial => { const index=cursor++; if (!(index in state))state[index]={current:initial};return state[index]; }, Btn: 'button', Detail: 'finding-detail', MODE_META: {pentest:{}}, React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) },
    scopeContextFor: async () => ({}),
    api: async (endpoint, payload) => { calls.push([endpoint, payload]); try { return await results.dispatch(ctx, store, endpoint, payload); } catch (error) { return { ok: false, error: error.message }; } } };
  Object.assign(sandbox, extras);
  sandbox.STATUS_LABEL = { pending: '待验证', verified: '已验证' };
  runInNewContext(source.slice(source.indexOf('function statusTextFor('), source.indexOf('function download(', source.indexOf('function statusTextFor('))), sandbox);
  runInNewContext(componentSource + '; this.component = ' + name, sandbox);
  // effects 每轮清空：真实 React 只在本次渲染后跑本轮 effect，累积会让旧闭包一起跑，测出假结果。
  function render() { cursor = 0; effects.length = 0; return sandbox.component({ sessionId, ...props }); }
  function nodes(node) { if (!node || typeof node !== 'object') return []; return [node, ...node.children.flat(Infinity).flatMap(nodes)]; }
  return { state, calls, timers, render, mount: async () => { render(); for(const effect of effects.slice())effect(); await new Promise(setImmediate); }, poll: async () => { for(const timer of timers)await timer(); }, find: predicate => nodes(render()).find(predicate), button: label => {
    if (label.startsWith('协作 ')) label = '协作' + label.slice(2);
    const aliases = { '协作': '并行任务', '多助手': '并行任务', '快速操作': '更多', '测试设置': '设置', '任务设置': '设置', '写提示词': '指令模板', '提示词': '指令模板', '说法': '指令模板', '常用说法': '指令模板', '节奏': '运行限制', '范围': '测试范围', '能力': '测试模块', '方法': '测试流程', '测试方法': '测试流程', '添加测试资料': '附件', '添加文件': '附件', '添加资料': '附件', '保存': '保存设置', '保存协作设置': '保存', '另存': '存为我的模板' };
    const canonical = text => {
      const value = String(text || '').trim();
      const keys = Object.keys(aliases).sort((a, b) => b.length - a.length);
      for (const key of keys) {
        if (value === key || value.startsWith(key + ' ') || value.startsWith(key + '·')) {
          return aliases[key] + value.slice(key.length);
        }
      }
      return value;
    };
    const wanted = canonical(label);
    const buttonText = node => (node.children || []).map(child => typeof child === 'string' ? child : (child && typeof child === 'object' ? buttonText(child) : '')).join('');
    return nodes(render()).find(node => node.type === 'button' && canonical(buttonText(node)).includes(wanted));
  } };
}
let failed = 0;
async function test(name, fn) { try { await fn(); console.log('ok   ' + name); } catch (error) { failed++; console.log('FAIL ' + name + ': ' + (error.stack || error.message)); } }
async function openChatSettings(ui) {
  let button = ui.button('设置');
  if (!button) {
    const more = ui.button('更多');
    assert(more, 'the compact bar must expose a More entry');
    await more.props.onClick();
    button = ui.button('设置');
  }
  assert(button, 'the More menu must expose Settings');
  await button.props.onClick();
  return button;
}
async function openChatMenu(ui) {
  const more = ui.button('更多');
  assert(more, 'the compact bar must expose a More entry');
  await more.props.onClick();
}
async function openChatCollaboration(ui) {
  let button = ui.button('协作');
  if (!button) {
    await openChatMenu(ui);
    button = ui.button('协作');
  }
  assert(button, 'the More menu must expose Parallel tasks');
  await button.props.onClick();
  return button;
}
async function openChatDetails(ui) {
  let button = ui.button('任务详情');
  if (!button) {
    await openChatMenu(ui);
    button = ui.button('任务详情');
  }
  assert(button, 'the More menu must expose Task details');
  await button.props.onClick();
}
try {
  await test('composer uses one compact status bar and moves full usage into task details', async () => {
    const id='compact-bar';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    const ui=harness('ChatSetup',id,{blank:true});await ui.mount();
    const blankBar=ui.find(n=>n.props&&String(n.props.className||'').includes('dsh-chat-compact-bar'));
    assert(blankBar,'one compact bar must be present');
    assert(!ui.find(n=>typeof n.type==='function'&&n.type.name==='UsageRow'),'idle bar must not mount UsageRow');
    assert(!ui.find(n=>n.props&&String(n.props.className||'').includes('dsh-chat-task-overview')),'full overview is not resident');
    assert(source.includes('.dsh-chat-compact-bar{display:flex;align-items:center;gap:4px;min-height:40px;max-height:48px'),'reference viewport bar is 40–48px');
    assert(source.includes('@media(max-width:800px){.dsh-chat-compact-bar{flex-wrap:wrap;max-height:72px'),'narrow viewport cap is 72px');
    const long='https://very-long-compact-bar.example.test/a/very/long/path?with=query';
    await results.dispatch(ctx,store,'task.choose',{sessionId:id,mode:'regular',workers:0,interaction:'auto'});
    await results.dispatch(ctx,store,'task.start',{sessionId:id,policy:{mode:'regular',target:long,budget:{toolCalls:5}}});
    ui.state[0]=await results.dispatch(ctx,store,'chat.settings',{sessionId:id});
    ui.state[0]={...ui.state[0],agentRunning:true,phase:'running',active:1};
    const liveUi=harness('ChatSetup',id,{blank:false});liveUi.state[0]=ui.state[0];liveUi.render();
    const barText=node=>(node.children||[]).map(child=>typeof child==='string'?child:(child&&typeof child==='object'?barText(child):'')).join('');
    const liveBar=liveUi.find(n=>n.props&&String(n.props.className||'').includes('dsh-chat-compact-bar'));
    assert(barText(liveBar).includes('停止'),'active execution keeps Stop in the bar; '+barText(liveBar));
    assert(!barText(liveBar).includes('very-long-compact-bar.example.test'),'long URL is not rendered in the bar');
    await openChatDetails(liveUi);
    assert(liveUi.state.includes('details'),'task details state must open');
    assert(liveUi.find(n=>n.props&&String(n.props.className||'').includes('dsh-chat-task-detail')),'task details panel opens');
    assert(source.includes("React.createElement(UsageRow,{key:props.sessionId+'-usage'"),'full usage is mounted in task details');
  });
  await test('blank composers open prompt examples and settings without inheriting execution state', async () => {
    for(const scene of ['free','cases','competition']) {
      const id='blank-composer-'+scene;
      sessionMap.set(id,{id,header:{agentPreset:scene==='competition'?'ctf-solver':'pentest'}});
      const ui=harness('ChatSetup',id,{blank:true,inputActions:{captureInsertion:()=>({start:0,end:0,revision:1})}});
      await ui.mount();
      // Host drafts may reuse an id: old execution must stay hidden, while
      // scene selection and preferences remain usable before the first message.
      ui.state[0]={scene:{sceneId:scene},options:{workers:0,interaction:'auto'},hostWorkerLimit:16,
        policy:{target:'OLD_EXECUTION_TARGET',scenario:'project',budget:{toolCalls:99},workerLimit:9},
        configured:true,overview:{question:'OLD_EXECUTION_TARGET'},attention:[{message:'OLD_EXECUTION_ALERT'}]};
      const text=JSON.stringify(ui.render());
      assert(!text.includes('当前：'), 'scene must be shown only once by the external selector');
      assert(!text.includes('OLD_EXECUTION_TARGET')&&!text.includes('OLD_EXECUTION_ALERT'));
      assert(!ui.find(n=>typeof n.type==='function'&&n.type.name==='ProjectChatStatus'));
      ui.button('写提示词').props.onClick();
      const editor=ui.find(n=>typeof n.type==='function'&&n.type.name==='ChatPromptEditor');
      assert(editor&&editor.props.open===true,'prompt editor must mount for a blank session');
      assert.equal(editor.props.scene,scene);
      await openChatSettings(ui);
      assert(ui.find(n=>n.props['aria-label']==='测试设置'));
      assert.equal(ui.button('保存').props.disabled,false,'settings must be editable before sending');
      assert.equal(ui.find(n=>typeof n.type==='function'&&n.type.name==='ChatPromptEditor').props.open,false);
    }
  });
  await test('blank Saker session has no starter cards or guide banner', async () => {
    const id='starter-cards';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    const ui=harness('ChatSetup',id,{blank:true});
    await ui.mount();
    assert(!ui.button('测一个网站'),'web starter card must be removed');
    assert(!ui.button('审查一段代码'),'code starter card must be removed');
    assert(!ui.button('解一道比赛题'),'ctf starter card must be removed');
    assert(!ui.find(node=>node.props&&node.props['aria-label']==='Saker 新手指引'),'guide banner must be removed');
    assert(ui.button('指令模板'),'the compact action bar remains available');
  });
  await test('test-flow panel opens from the composer and carries the session id', async () => {
    const id = 'workflow-panel';
    sessionMap.set(id, { id, header: { agentPreset: 'pentest' } });
    const ui = harness('ChatSetup', id, { blank: true });
    await ui.mount();
    const button = ui.button('测试流程');
    assert(button, 'test-flow button must be present');
    button.props.onClick();
    const panel = ui.find(node => typeof node.type === 'function' && node.type.name === 'ChatWorkflowStudio');
    assert(panel, 'method selector/editor must mount');
    assert.equal(panel.props.sessionId, id);
    assert.equal(panel.props.open, true);
  });
  await test('scene menu hides unnamed internal presets instead of rendering an empty item', () => {
    assert(modeSource.includes("String(item.name || '').trim()"),'extra scene presets require a visible name');
    assert(modeSource.includes('extras.length ?'),'the extra section only renders when usable presets remain');
  });
  await test('chat prompt and settings panels overlay without reflowing the composer and stay mutually exclusive', async () => {
    assert(source.includes('.dsh-chat-more{position:fixed'), 'settings must escape the composer scroll boundary');
    assert(source.includes('bottom:var(--dsh-chat-overlay-bottom,100px)'), 'overlay must stay outside composer scroll flow');
    assert(source.includes("if(more[0]){layout.width=Math.min(980,viewportWidth-32);layout.bottom=12;layout.right=12;layout.maxHeight=Math.max(0,Math.min(720,viewport-48-12));}"), 'settings must use the available viewport height and stay inside narrow viewports');
    assert(source.includes('bottom:calc(100% + 6px)'));
    assert(source.includes('--dsh-chat-overlay-max-height'));
    const layoutSource=source.slice(source.indexOf('function chatOverlayLayout('),source.indexOf('function ChatSetup('));
    const overlay=runInNewContext(layoutSource+';chatOverlayLayout');
    for(const [top,height,width] of [[421,820,1280],[100,820,1280],[160,320,400],[90,200,240]]) {
      const layout=overlay({top,right:width-20,width:width-40},height,width);
      assert(height-layout.bottom-layout.maxHeight>=48,'the panel header must clear Desktop title-bar hit regions');
      assert(layout.bottom>=12 && layout.maxHeight>=0 && layout.width<=width-24);
    }
    assert.equal(overlay({top:421,right:1132,width:712},820,1280).bottom,405,'keep normal panels attached above the composer');
    assert(source.includes('more[1](false);inlineAssetView[1](false);'), 'opening settings must close inline assets');
    assert(source.includes('open[1](false);inlineAssetView[1](false);'), 'opening the prompt drawer must be exclusive');
  });
  await test('competition form fields stack vertically inside a scrollable panel body', async () => {
    assert(source.includes('.dsh-chat-setup .dsh-chat-field,.dsh-task-workspace .dsh-chat-field{display:flex;flex-direction:column'), 'field labels must sit above controls');
    assert(source.includes('.dsh-chat-field>textarea') && source.includes('resize:vertical'), 'long competition textareas must wrap and resize');
    assert(source.includes("className:'dsh-competition-body'"), 'competition panels must expose an internal scroll body');
    assert(source.includes('.dsh-chat-more>.dsh-competition-body{flex:1 1 auto'), 'the competition drawer must scroll instead of clipping the form');
  });
  await test('接口错误把「可恢复操作」一起显示给用户', async () => {
    const sb={};
    runInNewContext(source.slice(source.indexOf('function chatError('),source.indexOf('function promptSubstitute(')),sb);
    assert.equal(sb.chatError({error:'版本冲突',hint:'刷新后重试'}),'版本冲突（刷新后重试）','message 与 hint 一起给');
    assert.equal(sb.chatError({error:'只有消息'}),'只有消息','没有 hint 时不硬凑');
    assert.equal(sb.chatError('纯字符串'),'纯字符串');
    assert.equal(sb.chatError(null),'操作失败，请重试');
  });
  await test('reading and polling Desktop chat settings never persist a mode or task', async () => {
    const ui=harness('ChatSetup','poll-readonly');await ui.mount();await ui.poll();await ui.poll();
    assert(ui.calls.length>=1);assert(ui.calls.every(([endpoint])=>endpoint==='chat.settings'),'read invoked a mutation RPC');
    assert.equal(ui.timers.length,0,'finished/blank sessions must not keep an idle polling timer');
    const state=await results.dispatch(ctx,store,'chat.settings',{sessionId:'poll-readonly'});
    assert.equal(state.choice,null);assert.equal(state.configured,false);assert.equal(readTaskPolicy(store,'poll-readonly'),null);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM task_flow_choice WHERE session_id=?').get('poll-readonly').n,0);
    assert(!ui.find(n=>n.props['title']==='使用输入框上方唯一的 Saker 场景选择器切换'),'settings row must not duplicate the scene selector');
    await openChatSettings(ui);
    assert.equal(ui.find(n=>n.props['aria-label']==='测试方向').props.value,'regular');
  });
  await test('没有 task policy 的未开始会话不会因为 phase=preparing 而持续轮询', async () => {
    const sandbox = {};
    const pollingSource = source.slice(source.indexOf('function chatNeedsPolling('), source.indexOf('function ChatSetup('));
    assert(pollingSource.includes('chatNeedsPolling'), 'polling helper must be present');
    runInNewContext(pollingSource + '; this.needsPolling = chatNeedsPolling', sandbox);
    const state = await results.dispatch(ctx, store, 'chat.settings', { sessionId: 'poll-readonly' });
    assert.equal(state.phase, 'preparing', 'unstarted session keeps the sentinel phase');
    assert.equal(state.policy ?? null, null, 'unstarted session has no task policy');
    assert.equal(sandbox.needsPolling(state), false, 'no policy means no background refresh');
    // 这些是必须继续轮询的真实状态，防止为了关掉空会话而误伤运行中/收尾。
    assert.equal(sandbox.needsPolling({ phase: 'preparing', policy: {}, agentRunning: false, active: 0 }), true);
    assert.equal(sandbox.needsPolling({ phase: 'idle', policy: {}, agentRunning: false, active: 0 }), false);
    assert.equal(sandbox.needsPolling({ phase: 'idle', policy: null, agentRunning: true }), true);
    assert.equal(sandbox.needsPolling({ phase: 'idle', policy: null, active: 2 }), true);
  });
  await test('Desktop interaction control saves preferences, confirms a real checkpoint and preserves policy on failed delivery',async()=>{
    const id='interaction-ui';
    const control=harness('InteractionControl',id);
    const select=control.find(n=>n.type==='select'&&n.props['aria-label']==='什么时候问我');
    assert.equal(select.children.flat().length,3);
    await results.dispatch(ctx,store,'task.choose',{sessionId:id,mode:'regular',workers:0,interaction:'confirm-step'});
    await results.dispatch(ctx,store,'task.start',{sessionId:id,policy:{mode:'regular',budget:{toolCalls:5,minutes:10}}});
    const before=readTaskPolicy(store,id);
    checkpointTask(store,id,'Offline stage finished');
    const ui=harness('TaskPanel',id);await ui.button('刷新状态').props.onClick();assert(ui.button('确认并继续'));
    const broken={...ctx,agents:{get:()=>({status:'idle',followup(){throw Error('fixture enqueue failed')}})}};
    await results.dispatch(ctx,store,'task.interaction',{sessionId:id,interaction:'auto'});
    await assert.rejects(results.dispatch(broken,store,'task.continue',{sessionId:id}),/任务保持原状态/);
    assert(readTaskPolicy(store,id).awaitingConfirmation);
    await ui.button('确认并继续').props.onClick();assert.equal(readTaskPolicy(store,id).awaitingConfirmation,undefined);
    assert.match(queued.at(-1).message.content[0].text,/用户确认继续/);
    for(const key of ['budget','used','startedAt'])assert.deepEqual(readTaskPolicy(store,id)[key],before[key]);
    await results.dispatch(ctx,store,'task.interaction',{sessionId:id,interaction:'auto'});
    assert.equal(readTaskPolicy(store,id).interaction,'auto');
    assert.deepEqual(readTaskPolicy(store,id).budget,before.budget);
  });
  await test('session user events clear idle for any real human message, not plugin messages', async () => {
    const id = 'continuation-event';
    sessionMap.set(id, { id, header: { agentPreset: 'pentest' } });
    await results.dispatch(ctx, store, 'task.start', {
      sessionId: id,
      policy: { mode: 'regular', target: 'https://app.example.test', budget: { toolCalls: 10 } },
    });
    finishTaskOnTurnEnd(store, id);
    const before = readTaskPolicy(store, id);
    const emit = (text, messageId = 'human-' + text.length) => {
      const event = { type: 'user/message', data: { id: messageId, source: { kind: 'user' }, content: [{ type: 'text', text }] } };
      for (const handler of eventHandlers.get('session/event') || []) handler(sessionMap.get(id), event);
    };
    emit('继续测试登录接口，重点看普通用户能否读取他人订单。');
    const after = readTaskPolicy(store, id);
    assert.equal(after.turnEndedAt, undefined);
    assert.equal(after.startedAt, before.startedAt);
    assert.deepEqual(after.used, before.used);
    finishTaskOnTurnEnd(store, id);
    const idleAt = readTaskPolicy(store, id).turnEndedAt;
    emit('继续', 'saker-auto-continuation');
    assert.equal(readTaskPolicy(store, id).turnEndedAt, idleAt);
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
    for (const sessionId of ['missing', 'audit']) await assert.rejects(results.dispatch(ctx, store, 'task.start', { sessionId, policy: { mode: 'nday', budget: { toolCalls: 10 } } }), /Saker 会话/);
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
    const rendered=JSON.stringify(ui.render());
    assert(rendered.includes('目标：尚未指定'),'an absent target must say so instead of a placeholder');
    assert(rendered.includes('尚未指定目标，先在授权范围内给一个入口、请求或身份'));
    assert(!rendered.includes('个已确认'),'no target must not turn into a zero confirmed count');
    assert(!rendered.includes('聊天中约定'));
    const withTarget='overview-target';sessionMap.set(withTarget,{id:withTarget,header:{agentPreset:'pentest'}});
    await results.dispatch(ctx,store,'task.start',{sessionId:withTarget,policy:{mode:'regular',target:'https://fixture.test/',budget:{toolCalls:5}}});
    registerFinding(store,withTarget,'pentest',{title:'Excluded fixture',type:'access',severity:'low',status:'false-positive'});
    const counted=harness('TaskPanel',withTarget);await counted.mount();
    const resultsNode=counted.find(n=>n.props['aria-label']==='本会话测试结果');
    const digits=resultsNode.children.flat(Infinity).flatMap(n=>n?.children||[]).filter(n=>n?.type==='span').flatMap(n=>n.children).filter(n=>n?.type==='strong').map(n=>n.children[0]);
    assert.deepEqual(digits,[0,0],'excluded findings must not count as awaiting verification');
    const actual=await results.dispatch(ctx,store,'task.status',{sessionId:id});
    const legacy=harness('TaskPanel',id,{}, {api:async endpoint=>endpoint==='task.status'?{...actual,policy:{...actual.policy,question:'有限观察已有目标，向用户建议具体研究问题'}}:{ok:false,error:'fixture read failed'}});
    await legacy.mount();const failedView=JSON.stringify(legacy.render());
    assert(failedView.includes('结果读取失败'));assert(!failedView.includes('有限观察已有目标'));assert(!failedView.includes('个已确认'),'read errors must not turn into zero results');
  });
  await test('the progress brief names the entry, identity, next action, evidence basis and gaps', async () => {
    const id='overview-brief';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    await results.dispatch(ctx,store,'task.start',{sessionId:id,policy:{mode:'regular',target:'http://127.0.0.1:9/',question:'Local fixture check',budget:{toolCalls:5}}});
    const endpoint='http://127.0.0.1:9/api';
    saveTaskContext(store,id,{assets:[{id:'a',url:endpoint,inScope:true,reachable:true}],
      requests:[{id:'normal',revision:'v1',endpoint,authContext:'fixture-user',kind:'api',valid:true,
        request:'GET /api HTTP/1.1\r\nHost: 127.0.0.1:9\r\n\r\n',response:'HTTP/1.1 200 OK\r\n\r\nok',inputs:[{name:'id',location:'query',evidenceIds:['normal']}]},
        {id:'second-route',revision:'v2',endpoint:endpoint.replace('/api','/api/second'),authContext:'fixture-user',kind:'api',valid:true,
        request:'GET /api/second HTTP/1.1\r\nHost: 127.0.0.1:9\r\n\r\n',response:'HTTP/1.1 200 OK\r\n\r\nok',inputs:[{name:'q',location:'query',evidenceIds:['second-route']}]}],
      methods:[{id:'fixture-method',version:'v1',reviewed:true}],
      checks:[{entryId:'entry-1',assetId:'a',endpoint,methodVersion:'v1',authContext:'fixture-user',requestRevision:'v1',conditions:[{name:'产品版本',state:'unknown'}]}]});
    createResearch(store,id,{id:'direction',requestId:'normal',requestRevision:'v1',controlledInputs:[{name:'id',location:'query'}],
      title:'Fixture direction',serverPath:'Local fixture',boundary:'Synthetic',normalBehavior:'Fixture response',supportCriterion:'Controlled effect',falsifier:'No effect',nextInformation:'Read the response',
      knownCheck:{outcome:'not-assessed',rationale:'Synthetic fixture, no product claim',sources:[]}});
    const ui=harness('TaskPanel',id);await ui.mount();
    const brief=JSON.stringify(ui.find(n=>n.props['aria-label']==='进度要点'));
    assert(brief.includes('入口：'+endpoint),'the brief must name the observed entry: '+brief);
    assert(brief.includes('身份：fixture-user'),'the brief must name the identity in use');
    assert(brief.includes('下一步：带正常对照做最小检查'),'the brief must name the concrete next action');
    // 依据来自 taskOverview.counts：资产/请求/方法来自共享上下文，检查记录来自已落盘的检查台账。
    assert(brief.includes('依据：资产 1 · 请求 2 · 测试流程 1 · 检查记录 0'),'the brief must show the evidence basis: '+brief);
    assert(JSON.stringify(ui.render()).includes('缺项（1）'),'known gaps must be listed');
    assert(JSON.stringify(ui.render()).includes('产品版本未知'),'a gap must name the missing item');
  });
  await test('observed entries without a direction yet are listed with address, identity and evidence id', async () => {
    const id='overview-entries';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    await results.dispatch(ctx,store,'task.start',{sessionId:id,policy:{mode:'regular',target:'http://127.0.0.1:9/',budget:{toolCalls:5}}});
    const endpoint='http://127.0.0.1:9/api';
    saveTaskContext(store,id,{assets:[{id:'a',url:endpoint,inScope:true,reachable:true}],
      requests:[{id:'first-route',revision:'v1',endpoint,authContext:'fixture-user',kind:'api',valid:true,
        request:'GET /api HTTP/1.1\r\nHost: 127.0.0.1:9\r\n\r\n',response:'HTTP/1.1 200 OK\r\n\r\nok',inputs:[{name:'id',location:'query',evidenceIds:['first-route']}]},
        {id:'second-route',revision:'v2',endpoint:endpoint.replace('/api','/api/second'),authContext:'fixture-user',kind:'api',valid:true,
        request:'GET /api/second HTTP/1.1\r\nHost: 127.0.0.1:9\r\n\r\n',response:'HTTP/1.1 200 OK\r\n\r\nok',inputs:[{name:'q',location:'query',evidenceIds:['second-route']}]}],
      methods:[{id:'fixture-method',version:'v1',reviewed:true}]});
    const ui=harness('TaskPanel',id);await ui.mount();
    const node=ui.find(n=>n.props['aria-label']==='可测入口');
    assert(node,'observed-but-unresearched entries must be listed');
    const entries=JSON.stringify(node);
    assert(entries.includes('可测入口（2'),'the count must be shown: '+entries);
    assert(entries.includes('http://127.0.0.1:9/api/second'),'the entry address must be shown');
    assert(entries.includes('身份 fixture-user'),'the entry identity must be shown');
    assert(entries.includes('证据 second-route@v2'),'the evidence id must be shown');
    assert(entries.includes('输入 q'),'the controlled input name must be shown');
    assert(JSON.stringify(ui.find(n=>n.props['aria-label']==='进度要点')).includes('下一步：用已观测的输入建立新方向'),'the next action must match the entries');
  });
  await test('Desktop model ledger separates admitted calls from observed wire attempts', async () => {
    const id='model-ledger-ui';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    await results.dispatch(ctx,store,'task.start',{sessionId:id,policy:{mode:'regular',budget:{toolCalls:5}}});
    const policy=readTaskPolicy(store,id);
    const insert=(record,state)=>store.db.prepare('INSERT INTO task_model_calls(id,root_session,round_at,session_id,state,record) VALUES(?,?,?,?,?,?)')
      .run(record.id,id,policy.startedAt,id,state,JSON.stringify(record));
    insert({id:'wire-settled',root:id,round:policy.startedAt,sessionId:id,state:'settled',provider:'fixture',model:'fixture-model',purpose:'conversation',
      usage:{inputTokens:3,outputTokens:2,cacheReadTokens:0,cacheWriteTokens:0,totalTokens:5},reservedTokens:null,at:Date.now(),
      wire:{transport:'native-fetch',protocol:'messages',bytes:128,maximumOutput:64,sha256:'a'.repeat(64),at:Date.now()}},'settled');
    insert({id:'wire-unobserved',root:id,round:policy.startedAt,sessionId:id,state:'unknown',provider:'fixture',model:'fixture-model',purpose:'session-title',
      usage:null,reservedTokens:null,at:Date.now()},'unknown');
    const ui=harness('TaskPanel',id);await ui.mount();
    const rendered=JSON.stringify(ui.render());
    assert(rendered.includes('已登记模型调用 2/48'));
    assert(rendered.includes('已观测原生发送 1 次，未观测 1 次'));
    assert(rendered.includes('会话标题'));
    assert(rendered.includes('未观测到原生 fetch 发送'));
    assert(rendered.includes('原生发送 messages'));
  });
  await test('finding summaries explain mismatched verification and preserve excluded outcomes', () => {
    const sandbox={};runInNewContext(source.slice(source.indexOf('function findingSummary('),source.indexOf('function download(')),sandbox);
    assert.equal(sandbox.findingSummary({executionEvidence:{reason:'执行证据与当前请求、身份或目标实例不匹配，请在当前条件下重新采集完整对照。'}}),'上次验证与当前请求、身份或目标实例不匹配，需要重新验证。');
    assert.match(sandbox.findingSummary({executionEvidence:{reason:'HTTP requests recorded',impactReason:'执行证据与当前请求不匹配'}}),/不匹配/);
    assert.match(sandbox.findingSummary({status:'false-positive',executionEvidence:{reason:'执行证据已过期'}}),/已排除/);
    assert.match(sandbox.findingSummary({delivery:{gaps:['request-response-evidence-missing']}}),/请求或响应/);
  });
  await test('three actual workflow buttons apply explicit research budget and cancellation persists without reset', async () => {
    const ui = harness('TaskPanel', 'ui');
    await ui.mount();
    for (const label of ['Nday发现', '常规测试', '0Day挖掘']) assert(ui.button(label));
    await ui.button('0Day挖掘').props.onClick();
    ui.find(node => node.type === 'input' && node.props['aria-label'] === '操作预算').props.onChange({ target: { value: '40' } });
    ui.find(node => node.type === 'textarea' && node.props['aria-label'] === '用户要求、范围或已有材料').props.onChange({ target: { value: 'Inspect the controlled fixture permission only' } });
    await ui.button('开始测试').props.onClick();
    assert.equal(readTaskPolicy(store, 'ui').mode, '0day');
    assert.equal(readTaskPolicy(store, 'ui').budget.toolCalls, 40);
    assert.equal(readTaskPolicy(store, 'ui').budget.discoveryCalls, 0);
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
  await test('模型 token 上限从桌面预算进入 task.start，缺少宿主准入钩子时明确拒绝', async () => {
    const id = 'token-limit';
    sessionMap.set(id, { id, header: { agentPreset: 'pentest' } });
    const ui = harness('TaskPanel', id);
    await ui.mount();
    const field = ui.find(node => node.type === 'input' && node.props['aria-label'] === '模型 token 上限（可选，含子代理和辅助调用）');
    assert(field, 'the model token limit must be settable next to the other limits');
    field.props.onChange({ target: { value: '90000' } });
    ui.find(node => node.type === 'textarea' && node.props['aria-label'] === '用户要求、范围或已有材料').props.onChange({ target: { value: 'Only check the provided fixture' } });
    await ui.button('开始测试').props.onClick();
    const start = ui.calls.filter(row => row[0] === 'task.start').at(-1);
    assert(start, 'the token limit must be sent through task.start');
    assert.equal(start[1].policy.budget.tokens, 90000);
    assert.equal(readTaskPolicy(store, id), null, 'without the host admission hook the task must not start');
    assert(ui.find(node => node.props.role === 'alert'), 'the missing host hook must be reported instead of silently dropping the limit');
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
      assert.match(text, new RegExp('重点=' + mode));
      // 常驻快照不携带易变用量计数，避免每个工具调用都追加新 runtime-context 消息。
      // 精确用量由 task.status 返回，守卫仍按最新预算强制拦截。
      assert(!text.includes('操作=') && !text.includes('未计量目标流量='), '常驻快照不携带易变用量计数');
      assert.match(text, /精确用量由程序显示，宿主守卫按最新预算拦截/);
      const status = await results.dispatch(ctx, store, 'task.status', { sessionId: mode });
      assert.equal(status.policy.budget.toolCalls, 30, '实际预算仍持久化在任务策略里');
      for (const other of ['nday', 'regular', '0day'].filter(other => other !== mode)) assert(!text.includes('重点=' + other));
    }
    assert.equal(provider.text({ agent: { session: sessionMap.get('audit') } }), '');
    assert.match(provider.text({ agent: { session: { id: 'new', header: { agentPreset: 'pentest' } } } }), /首次真实工具动作.*用户决定目标、范围/);
  });
  await test('custom method selection enters the next prompt provider with its real id', async () => {
    const id = 'custom-method';
    sessionMap.set(id, { id, header: { agentPreset: 'pentest' } });
    const saved = await results.dispatch(ctx, store, 'workflow.save', {
      sessionId: id, scope: 'session', select: true,
      workflow: {
        title: '自定义登录链路',
        description: '先找入口，再保留正常对照。',
        mode: 'pentest',
        nodes: [
          { id: 'entry', title: '找入口', instruction: '定位登录入口。', tools: ['saker_browser'], output: '入口' },
          { id: 'baseline', title: '正常对照', instruction: '发一次正常登录。', tools: ['redteam_execution'], output: '正常回执' },
        ],
      },
    });
    assert.equal(saved.ok, true);
    const provider = sections.find(section => section.name === 'saker-pentest-task');
    const text = provider.text({ agent: { session: sessionMap.get(id) } });
    assert.match(text, /当前测试流程=自定义登录链路/);
    assert.match(text, new RegExp('workflowId=' + saved.workflow.id));
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
    ui.find(node=>node.props['aria-label']==='用户要求、范围或已有材料').props.onChange({target:{value:'Check only the provided product prerequisite'}});
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
    const cost=taskCostOverview(ctx,store,sid);assert.equal(cost.totalTokens,20);assert.equal(cost.cacheReadTokens,10);assert.equal(cost.modelCalls,3);assert.equal(cost.attemptCalls,1);assert.equal(cost.unknownUsageCalls,1);assert.equal(cost.toolCalls,1);assert.equal(cost.sessions.length,2);
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
  await test('chat setup never duplicates the scene selector while settings persist without starting budgets', async () => {
    const ui = harness('ChatSetup', 'hero');ui.render();ui.state[0]=await results.dispatch(ctx,store,'chat.settings',{sessionId:'hero'});
    assert(!ui.find(n=>n.props['aria-label']==='测试场景'),'the sole scene selector lives in the Saker chip');
    assert(!ui.find(n=>n.props['title']==='使用输入框上方唯一的 Saker 场景选择器切换'),'the scene selector stays outside the settings row');
    assert(!ui.find(n=>n.props['aria-label']==='测试方向'),'direction preference belongs in settings');
    assert(!ui.button('开始测试')); assert(!ui.button('刷新状态'));
    await openChatSettings(ui);
    await ui.find(n=>n.props['aria-label']==='测试方向').props.onChange({target:{value:'nday'}});
    await ui.button('保存').props.onClick();
    assert.equal(readTaskPolicy(store, 'hero'), null);
    assert.equal((await results.dispatch(ctx, store, 'task.status', { sessionId: 'hero' })).choice, 'nday');
    await openChatSettings(ui);
    assert.equal(ui.find(n=>n.props['aria-label']==='测试方向').props.value, 'nday');
    await results.dispatch(ctx,store,'task.choose',{sessionId:'hero',mode:'regular',workers:2,interaction:'auto'});
    assert.match(sections[0].text({ agent: { session: sessionMap.get('hero') } }), /桌面研究偏好=regular/);
    await assert.rejects(results.dispatch(ctx, store, 'task.start', { sessionId: 'hero', policy: { mode: 'nday', budget: { toolCalls: 20 } } }), /differs/);
    await results.dispatch(ctx, store, 'task.start', { sessionId: 'hero', policy: { mode: 'regular', budget: { toolCalls: 20 } } });
    const beforeDirection = readTaskPolicy(store, 'hero');
    await results.dispatch(ctx, store, 'task.choose', { sessionId: 'hero', mode: '0day' });
    assert.equal(readTaskPolicy(store, 'hero').mode, '0day', 'legacy choose maps to the same validated focus setting');
    assert.deepEqual(readTaskPolicy(store, 'hero').used, beforeDirection.used);
    assert.equal(readTaskPolicy(store, 'hero').startedAt, beforeDirection.startedAt);
  });
  await test('Desktop shared detail reads exact packet revision without packet duplication in index or cross-session borrowing', async () => {
    saveTaskContext(store, 'records', { assets: [{ id: 'a', url: 'https://fixture.test', inScope: true, reachable: true }], requests: [{
      id: 'baseline', endpoint: 'https://fixture.test/api', authContext: 'fixture-user', revision: 'v1', valid: true,
      request: 'GET /api HTTP/1.1', response: 'HTTP/1.1 200 OK\nfixture-body' }] });
    const ui = harness('ContextPanel', 'records');
    await ui.button('读取索引').props.onClick();
    assert(ui.state[0].includes('baseline')); assert(!ui.state[0].includes('fixture-body'));
    ui.find(node => node.props['aria-label'] === '记录ID').props.onChange({ target: { value: 'baseline' } });
    ui.find(node => node.props['aria-label'] === '请求或测试流程版本').props.onChange({ target: { value: 'v1' } });
    await ui.button('读取详情').props.onClick();
    assert(ui.state[0].includes('GET /api HTTP/1.1')); assert(ui.state[0].includes('fixture-body'));
    assert.equal(ui.calls.at(-1)[1].version, 'v1');
    await assert.rejects(results.dispatch(ctx, store, 'context.detail', { sessionId: 'regular', kind: 'request', id: 'baseline', version: 'v1' }), /record not found/);
    saveTaskContext(store, 'records', { requests: [{ id: 'baseline', endpoint: 'https://fixture.test/api', authContext: 'fixture-user', revision: 'v2', valid: true,
      request: 'GET /api HTTP/1.1', response: 'HTTP/1.1 200 OK\nnew-fixture-body' }] });
    const historical = await results.dispatch(ctx, store, 'context.detail', { sessionId: 'records', kind: 'request', id: 'baseline', version: 'v1' });
    assert.equal(historical.historical, true); assert(historical.text.includes('fixture-body')); assert(!historical.text.includes('new-fixture-body'));
    ui.find(node => node.props['aria-label'] === '请求或测试流程版本').props.onChange({ target: { value: 'missing' } });
    await ui.button('读取详情').props.onClick(); assert.match(ui.state[1], /record not found/);
  });
  await test('research panel reads a compact current-session index and keeps observations folded outside chat', async () => {
    const sid = 'research-panel';
    sessionMap.set(sid, { id: sid, header: { agentPreset: 'pentest' } });
    startTaskPolicy(store, sid, { mode: '0day', question: 'fixture research panel', target: 'https://fixture.test', budget: { toolCalls: 10 } });
    setTaskActionLimits(store, sid, { target: 'https://fixture.test' }, 'desktop-user');
    saveTaskContext(store, sid, { assets: [{ id: 'a', url: 'https://fixture.test', inScope: true, reachable: true }], requests: [{
      id: 'baseline', endpoint: 'https://fixture.test/api', authContext: 'fixture-user', revision: 'v1', kind: 'api', valid: true,
      request: 'GET /api HTTP/1.1', response: 'HTTP/1.1 200 OK\nprivate fixture baseline', inputs: [{ name: 'object', location: 'query', evidenceIds: ['baseline'] }] }] });
    createResearch(store, sid, { id: 'fixture', requestId: 'baseline', requestRevision: 'v1', controlledInputs: [{ name: 'object', location: 'query' }],
      title: 'Fixture boundary', serverPath: 'Object handler', boundary: 'Owner identity', normalBehavior: 'Own objects only', supportCriterion: 'Another owner object appears',
      falsifier: 'Another owner object is consistently denied', nextInformation: 'Compare object ownership', knownCheck: { outcome: 'not-assessed', rationale: 'Synthetic fixture; no public product claim.', sources: [] } });
    const ui = harness('ResearchPanel', sid);
    assert.equal(ui.render().type, 'details'); assert.equal(ui.render().props.open, undefined);
    await ui.button('读取研究记录').props.onClick();
    assert.equal(ui.state[0].total, 1); assert(!JSON.stringify(ui.state[0]).includes('private fixture baseline'));
    await ui.button('查看假设').props.onClick(); assert.equal(ui.state[1].binding.authContext, 'fixture-user');
    assert(ui.find(node => node.type === 'details' && node.children.some(child => child?.type === 'summary' && child.children.includes('正常对照、观察与公开解释'))));
    const hero = harness('ChatSetup', 'hero'); assert(!hero.button('读取研究记录'));
  });
  await test('测试结果主视图先显示正在验证的具体问题与下一步', async () => {
    const view = harness('ResearchView', 'research-panel');
    await view.mount();
    await new Promise(setImmediate);
    assert.equal(view.state[0].total, 1, 'index must load without a manual click');
    assert(view.find(node => node.type === 'button' && JSON.stringify(node.children).includes('Fixture boundary')));
    assert(!JSON.stringify(view.state[0]).includes('private fixture baseline'), 'index must not copy raw response bodies');
    assert(view.find(node => node.type === 'strong' && node.children.includes('已有结果')), 'result summary must sit beside the questions');
    assert(view.button('查看全部发现'));
    await view.button('Fixture boundary').props.onClick();
    assert.equal(view.state[1].binding.authContext, 'fixture-user');
    assert.equal(view.state[1].normalBehavior, 'Own objects only');
    assert(view.find(node => node.type === 'h4' && node.children.includes('Fixture boundary')));
    const empty = harness('ResearchView', 'ui');
    await empty.mount();
    await new Promise(setImmediate);
    assert.equal(empty.state[0].total, 0);
    assert(empty.button('查看执行记录'), 'empty state must offer the execution log');
  });
  await test('actual materials tool accepts an unambiguous material kind and distinguishes indexing from reading',async()=>{
    fs.writeFileSync(path.join(home,'selected.js'),'fetch("/api");');
    setTaskActionLimits(store,'records',{target:'https://fixture.test'},'desktop-user');
    const execute=registeredTools.get('redteam_context').execute,exec={agent:{session:{id:'records',header:{agentPreset:'pentest',cwd:home}}}};
    assert.equal((await execute({context:JSON.stringify({assets:[{id:'material-site',url:'https://fixture.test',inScope:true,reachable:true}],requests:[],methods:[],checks:[]})},exec)).ok,true);
    const materials=JSON.stringify({site:'https://fixture.test',files:[{path:'selected.js',url:'https://fixture.test/app.js'}]});
    const indexed=await execute({materials,kind:'material',offset:0},exec);assert.equal(indexed.ok,true,indexed.error);assert.equal(indexed.operation,'index-selected-files');assert.equal(indexed.files,1);
    const read=await execute({kind:'material'},exec);assert.equal(read.operation,'read-existing-index');assert.equal(read.files,1);
    const conflict=await execute({materials,context:'{}'},exec);assert.equal(conflict.ok,false);assert.match(conflict.error,/只传materials/);
    const empty=await execute({materials:JSON.stringify({site:'https://fixture.test',files:[]})},exec);assert.equal(empty.ok,false);assert.match(empty.error,/1\.\.30/);
  });
  await test('saker_material is the sole reference entry, rejects a closed switch before index access and delivers the hit', async () => {
    const id='knowledge-tool';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    const tool=registeredTools.get('saker_material');assert(tool);
    assert.equal(tool.parameters.source.type,'string');
    const exec={agent:{session:sessionMap.get(id)},signal:AbortSignal.timeout(5000)};
    const disabled=await tool.execute({action:'search',source:'reference',query:'JWT algorithm confusion'},exec);
    assert.equal(disabled.code,'knowledge_disabled');
    indexKnowledgeEntry({projectKey:id,sourceId:'tool-jwt',title:'JWT 手册',
      text:'# JWT algorithm confusion\n检查公钥是否被误当作 HMAC 密钥。',sourceLabel:'内部手册'});
    const enabled=await results.dispatch(ctx,store,'knowledge.toggle',{sessionId:id,enabled:true});
    assert.equal(enabled.ok,true,enabled.error);
    const search=await tool.execute({action:'search',source:'reference',query:'JWT algorithm confusion'},exec);
    assert.equal(search.ok,true,search.error);
    const searchView=JSON.parse(search.text);assert(searchView.rows.length>=1);assert.equal(searchView.rows[0].sourceKind,'local');
    const read=await tool.execute({action:'read',source:'reference',ref:searchView.rows[0].ref},exec);
    assert.equal(read.ok,true,read.error);assert.match(JSON.parse(read.text).text,/公钥/);
    await results.dispatch(ctx,store,'knowledge.toggle',{sessionId:id,enabled:false});
    const late=await tool.execute({action:'read',source:'reference',ref:searchView.rows[0].ref},exec);
    assert.equal(late.code,'knowledge_disabled');
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
    assert(injects.includes('conversation.chat.assistant-actions'),'answer actions register the curation entry');
  });
  await test('curation resolves the exact assistant message id instead of borrowing the whole history', async () => {
    const id='curation-message';sessionMap.set(id,{id,header:{agentPreset:'pentest'},ownEvents:()=>[
      {type:'assistant/message',data:{message:{id:'old-message',content:[{type:'text',text:'OLD'}]}}},
      {type:'assistant/message',data:{message:{id:'target-message',content:[{type:'text',text:'只整理这一条回答'}]}}},
    ]});
    const value=await results.dispatch(ctx,store,'curation.message',{sessionId:id,messageId:'target-message'});
    assert.equal(value.ok,true);assert.equal(value.text,'只整理这一条回答');assert.equal(value.sourceRef,'assistant:target-message');
    const missing=await results.dispatch(ctx,store,'curation.message',{sessionId:id,messageId:'absent'});
    assert.equal(missing.code,'message_not_found');
  });
  await test('chat quick settings change real in-flight preferences without resetting consumed budget or deadline',async()=>{
    const id='chat-live';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    await results.dispatch(ctx,store,'task.choose',{sessionId:id,mode:'regular',workers:1,interaction:'auto'});
    await results.dispatch(ctx,store,'task.start',{sessionId:id,policy:{mode:'regular',question:'Offline chat fixture',budget:{toolCalls:8,minutes:10}}});
    const before=readTaskPolicy(store,id),ui=harness('ChatSetup',id);ui.render();ui.state[0]=await results.dispatch(ctx,store,'chat.settings',{sessionId:id});
    assert(!ui.find(n=>n.props['title']==='使用输入框上方唯一的 Saker 场景选择器切换'),'settings row must not duplicate the scene selector');
    await openChatSettings(ui);
    const dirChip=ui.find(n=>n.props['aria-label']==='测试方向');assert(dirChip,'missing 测试方向 chip');
    assert(!dirChip.props.disabled);
    await ui.button('节奏').props.onClick();
    const coopChip=ui.find(n=>n.props['aria-label']==='聊天协作方式');assert(coopChip,'missing 聊天协作方式 chip');
    await coopChip.props.onChange({target:{value:'confirm-step'}});
    assert.equal(readTaskPolicy(store,id).interaction,'auto','settings stay in draft until save');
    await ui.button('保存').props.onClick();
    assert.equal(readTaskPolicy(store,id).interaction,'confirm-step');
    await openChatCollaboration(ui);
    await ui.find(n=>n.props['aria-label']==='最多同时运行的并行任务').props.onChange({target:{value:'2'}});
    assert.equal(readTaskPolicy(store,id).workerLimit,1,'collaboration changes stay in draft until save');
    await ui.button('保存协作设置').props.onClick();
    assert.equal(readTaskPolicy(store,id).workerLimit,2);
    for(const key of ['used','startedAt'])assert.deepEqual(readTaskPolicy(store,id)[key],before[key]);
    for(const key of ['toolCalls','deadline'])assert.equal(readTaskPolicy(store,id).budget[key],before.budget[key]);
    const child={childId:'chat-child',parentId:id,site:'https://fixture.test',state:'cleanup-failed'};
    store.db.prepare('INSERT INTO site_workers(parent_session,child_id,site,record) VALUES(?,?,?,?)').run(id,child.childId,child.site,JSON.stringify(child));
    await results.dispatch(ctx,store,'task.workers',{sessionId:id,workers:0});
    assert.equal(readTaskPolicy(store,id).workerLimit,0,'lowering a ceiling only blocks future dispatch');
    assert.equal(readTaskPolicy(store,id).cancelled,false);
    assert(store.db.prepare('SELECT 1 FROM site_workers WHERE child_id=?').get(child.childId),'existing helper remains visible and independently stoppable');
    store.db.prepare('DELETE FROM site_workers WHERE child_id=?').run(child.childId);
    checkpointTask(store,id,'Offline checkpoint');ui.state[0]=await results.dispatch(ctx,store,'chat.settings',{sessionId:id});
    assert(!ui.button('新建测试'));
    await ui.button('按当前思路继续').props.onClick();
    updateTaskProgress(store,id,{planComplete:true});ui.state[0]=await results.dispatch(ctx,store,'chat.settings',{sessionId:id});
    await openChatDetails(ui);
    await ui.button('新建测试').props.onClick();
    assert.equal(readTaskPolicy(store,id),null);assert.equal(chosenTaskOptions(store,id).workers,0);assert.equal(chosenTaskOptions(store,id).interaction,'confirm-step');
  });
  await test('chat-driven setting updates only tighten scope and record a readable change summary',async()=>{
    const id='chat-update';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    await results.dispatch(ctx,store,'task.choose',{sessionId:id,mode:'regular',workers:4,interaction:'auto'});
    await results.dispatch(ctx,store,'task.start',{sessionId:id,policy:{mode:'regular',question:'Offline chat update fixture',budget:{toolCalls:10,minutes:30}}});
    const before=readTaskPolicy(store,id);
    const execute=registeredTools.get('redteam_task').execute,exec={agent:{session:{id,header:{agentPreset:'pentest'}}}};

    // 界面与系统提示词给模型看到的是中文标签（真机实测模型照抄标签），必须与稳定值等价。
    const tightened=await execute({action:'update',document:JSON.stringify({interaction:'每个检查步骤前问我',reporting:'每完成一个检查步骤时',workers:0,allowTargetNetwork:false,readOnly:true,toolCalls:6})},exec);
    assert.equal(tightened.ok,true,tightened.error);
    const after=readTaskPolicy(store,id);
    assert.equal(after.interaction,'confirm-step');assert.equal(after.workerLimit,0);
    assert.equal(after.reporting,'step');
    assert.equal(after.allowTargetNetwork,false);assert.equal(after.readOnly,true);
    assert.equal(after.budget.toolCalls,6);
    assert.deepEqual(after.used,before.used);assert.equal(after.startedAt,before.startedAt);
    assert.match(tightened.summary,/什么时候问我/);assert.match(tightened.summary,/工具调用上限/);
    // 变更摘要要出现在工具结果第一行 —— 这就是「消息旁显示的变更摘要」。
    const rendered=registeredTools.get('redteam_task').output.render({action:'update'},tightened)[0].text;
    assert.match(rendered,/^设置已更新：/);

    // 变更摘要进事件流（v6 第 4.2 节）：界面据此在消息旁回看改了什么。
    const events=await results.dispatch(ctx,store,'task.events',{sessionId:id,afterCursor:0,limit:50});
    const change=events.events.map(event=>event.detail).find(detail=>Array.isArray(detail.settings)&&detail.settings.some(row=>row.field==='allowTargetNetwork'));
    assert(change,'no settings change summary recorded');
    assert.equal(change.source,'chat-update');
    assert(change.settings.some(row=>row.field==='budget.toolCalls'&&row.label==='工具调用上限'),JSON.stringify(change.settings));
    assert(change.settings.some(row=>row.field==='readOnly'&&row.to===true),JSON.stringify(change.settings));

    // 放宽生成一条待用户确认的变更；未确认前不能改到任何字段。
    const reopened=await execute({action:'update',document:JSON.stringify({allowTargetNetwork:true})},exec);
    assert.equal(reopened.ok,true);assert.match(reopened.summary,/待你确认/);
    assert.equal(readTaskPolicy(store,id).allowTargetNetwork,false);
    const raised=await execute({action:'update',document:JSON.stringify({workers:8})},exec);
    assert.equal(raised.ok,true);assert.equal(readTaskPolicy(store,id).workerLimit,0);
    const newTarget=await execute({action:'update',document:JSON.stringify({target:'https://other.test'})},exec);
    assert.equal(newTarget.ok,true);assert(readTaskPolicy(store,id).pendingChange);
    assert.doesNotMatch(readTaskPolicy(store,id).target,/other\.test/);
    const switchMode=await execute({action:'update',document:JSON.stringify({mode:'0day'})},exec);
    assert.equal(switchMode.ok,true);assert.equal(readTaskPolicy(store,id).mode,'regular');
    const unknownField=await execute({action:'update',document:JSON.stringify({budget:{toolCalls:3}})},exec);
    assert.equal(unknownField.ok,false);assert.match(unknownField.error,/不接受字段 budget/);
    const final=readTaskPolicy(store,id);
    assert.equal(final.allowTargetNetwork,false);assert.equal(final.workerLimit,0);assert.equal(final.budget.toolCalls,6);
  });
  await test('parent narrowing propagates to running site workers without rewriting their own policy',async()=>{
    const parent='scope-parent',child='scope-child';
    sessionMap.set(parent,{id:parent,header:{agentPreset:'pentest'}});
    sessionMap.set(child,{id:child,header:{agentPreset:'pentest',parentSession:parent}});
    await results.dispatch(ctx,store,'task.choose',{sessionId:parent,mode:'regular',workers:1,interaction:'auto'});
    await results.dispatch(ctx,store,'task.start',{sessionId:parent,policy:{mode:'regular',target:'https://fixture.test',question:'scope fixture',budget:{toolCalls:20,unmeteredToolCalls:5}}});
    store.db.prepare('INSERT INTO site_workers(parent_session,child_id,site,record) VALUES(?,?,?,?)')
      .run(parent,child,'https://fixture.test',JSON.stringify({parentId:parent,childId:child,site:'https://fixture.test',state:'running',allowedTools:['httpx_probe']}));
    startTaskPolicy(store,child,{mode:'regular',question:'child scope fixture',target:'https://fixture.test',stop:'budget',parentSession:parent,
      budget:{toolCalls:10,unmeteredToolCalls:5,workers:0}});
    // 父任务仍允许时，子代理的扫描工具放行（消耗自己的未计量额度）。
    assert.equal(taskExecutionGuard(store,child,'httpx_probe',Date.now(),{}),undefined);
    // 主任务中途关掉网站访问：已经在跑的子代理必须立刻被拦。
    setTaskActionLimits(store,parent,{allowTargetNetwork:false},'desktop-user');
    assert.match(String(taskExecutionGuard(store,child,'httpx_probe',Date.now(),{})),/target_network_disabled/);
    // 传播靠合并读取，不双写子任务自己的策略。
    assert.notEqual(readTaskPolicy(store,child).allowTargetNetwork,false);
    // 主任务恢复后子代理重新放行（只收紧不放宽指的是子代理自己不能放宽）。
    setTaskActionLimits(store,parent,{allowTargetNetwork:true},'desktop-user');
    assert.equal(taskExecutionGuard(store,child,'httpx_probe',Date.now(),{}),undefined);
    // 排除路径同样沿任务树并集生效（再收紧一次，确认合并是每次读策略时算的，不是一次性缓存）。
    setTaskActionLimits(store,parent,{allowTargetNetwork:false,excludedPaths:['/payment']},'desktop-user');
    const childLimits=effectivePolicy(store,readTaskPolicy(store,child));
    assert.equal(childLimits.allowTargetNetwork,false);
    assert.match(String(excludedPathDenial(childLimits,{url:'https://fixture.test/payment/list'})),/excluded_path/);
    assert.notEqual(JSON.stringify(readTaskPolicy(store,child).excludedPaths),JSON.stringify(['/payment']));
  });
  await test('identity invalidation propagates from the main task to site workers',async()=>{
    const parent='identity-parent',child='identity-child';
    sessionMap.set(parent,{id:parent,header:{agentPreset:'pentest'}});
    sessionMap.set(child,{id:child,header:{agentPreset:'pentest',parentSession:parent}});
    store.db.prepare('INSERT INTO site_workers(parent_session,child_id,site,record) VALUES(?,?,?,?)')
      .run(parent,child,'https://identity.test',JSON.stringify({parentId:parent,childId:child,site:'https://identity.test',state:'running'}));
    saveAccount(store,parent,{id:'alice',name:'alice',status:'valid',secret:'Cookie: sid=fixture'});
    const inherited=resolveTaskIdentity(store,child,'alice');
    assert.equal(inherited.matched,true);assert.equal(inherited.status,'valid');
    // 程序侧按任务树继承服务器端凭据，模型侧仍看不到原始 Cookie。
    assert.equal(inherited.secret,'Cookie: sid=fixture');
    assert.equal(inherited.credentialSessionId,parent);
    assert.equal(identityDenial(inherited),undefined);
    saveAccount(store,parent,{id:'alice',name:'alice',status:'expired'});
    assert.match(String(identityDenial(resolveTaskIdentity(store,child,'alice'))),/identity_expired/);
    saveAccount(store,parent,{id:'alice',name:'alice',status:'unconfirmed'});
    assert.match(String(identityDenial(resolveTaskIdentity(store,child,'alice'))),/identity_unconfirmed/);
  });
  await test('site material update wakes only the workers that declared that material',async()=>{
    const parent='material-parent',child='material-child';
    sessionMap.set(parent,{id:parent,header:{agentPreset:'pentest',cwd:home}});
    sessionMap.set(child,{id:child,header:{agentPreset:'pentest',parentSession:parent,cwd:home}});
    await results.dispatch(ctx,store,'task.choose',{sessionId:parent,mode:'regular',workers:1,interaction:'auto'});
    await results.dispatch(ctx,store,'task.start',{sessionId:parent,policy:{mode:'regular',target:'https://wake.test',question:'material wake fixture',budget:{toolCalls:20}}});
    const file=path.join(home,'wake-fixture.js');
    fs.writeFileSync(file,'fetch("/api/one");');
    const execute=registeredTools.get('redteam_context').execute;
    const exec={agent:{session:{id:parent,header:{agentPreset:'pentest',cwd:home}}}};
    const contextCall=await execute({context:JSON.stringify({assets:[{id:'wake-site',url:'https://wake.test',inScope:true,reachable:true}],requests:[],methods:[],checks:[]})},exec);
    assert.equal(contextCall.ok,true,contextCall.error);
    const first=await execute({materials:JSON.stringify({site:'https://wake.test',files:[{path:'wake-fixture.js',url:'https://wake.test/app.js'}]})},exec);
    assert.equal(first.ok,true,first.error);
    const materialId=(first.updatedIds||[])[0];assert(materialId,'material must be indexed');
    // 子代理声明依赖这条材料；同一 URL 换内容 = 同一 id 的新版本，必须唤醒它。
    claimWork(store,parent,{workKey:'wake-fixture',worker:child,materialIds:['file:'+materialId]});
    queued.length=0;
    fs.writeFileSync(file,'fetch("/api/two");');
    const second=await execute({materials:JSON.stringify({site:'https://wake.test',files:[{path:'wake-fixture.js',url:'https://wake.test/app.js'}]})},exec);
    assert.equal(second.ok,true,second.error);
    assert.deepEqual(second.updatedIds,[materialId]);
    assert.equal(second.woken.length,1,JSON.stringify(second.woken));
    assert.equal(second.woken[0].worker,child);
    assert.match(String(queued.at(-1)?.message?.content?.[0]?.text||''),/资料更新/);
    // 内容没变的重复索引不是资料事件：不唤醒。
    queued.length=0;
    const third=await execute({materials:JSON.stringify({site:'https://wake.test',files:[{path:'wake-fixture.js',url:'https://wake.test/app.js'}]})},exec);
    assert.deepEqual(third.updatedIds,[]);
    assert.equal(third.woken.length,0);
    assert.equal(queued.length,0);
  });
  await test('identical pasted re-import merges sources without claiming a new version',async()=>{
    const parent='pasted-parent',child='pasted-child';
    sessionMap.set(parent,{id:parent,header:{agentPreset:'pentest',cwd:home}});
    sessionMap.set(child,{id:child,header:{agentPreset:'pentest',parentSession:parent,cwd:home}});
    await results.dispatch(ctx,store,'task.choose',{sessionId:parent,mode:'regular',workers:1,interaction:'auto'});
    await results.dispatch(ctx,store,'task.start',{sessionId:parent,policy:{mode:'regular',question:'pasted reuse fixture',budget:{toolCalls:20}}});
    const text='GET /api HTTP/1.1\nHost: paste.test\n\n';
    const first=await results.dispatch(ctx,store,'materials.import',{sessionId:parent,name:'note.txt',text});
    assert.equal(first.ok,true);assert.notEqual(first.material.reused,true);
    claimWork(store,parent,{workKey:'pasted-fixture',worker:child,materialIds:['file:'+first.material.id]});
    queued.length=0;
    const again=await results.dispatch(ctx,store,'materials.import',{sessionId:parent,name:'note.txt',text});
    assert.equal(again.material.reused,true);
    assert.equal(again.woken.length,0,'identical content must not claim a new version');
    assert.equal(queued.length,0);
  });
  await test('asking timing and progress reporting are independent, and step decisions remain guarded',async()=>{
    for(const interaction of ['confirm-step','confirm-data-change','auto'])for(const reporting of ['end','notable','step']){
      const id='cooperate-'+interaction+'-'+reporting;sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
      await results.dispatch(ctx,store,'task.choose',{sessionId:id,mode:'regular',workers:4,interaction,reporting});
      await assert.rejects(results.dispatch(ctx,store,'task.start',{sessionId:id,policy:{mode:'regular',reporting:reporting==='end'?'step':'end',budget:{toolCalls:6}}}),/reporting differs/);
      await results.dispatch(ctx,store,'task.start',{sessionId:id,policy:{mode:'regular',budget:{toolCalls:6,minutes:10}}});
      const before=readTaskPolicy(store,id);assert.equal(before.reporting,reporting);assert.equal(before.workerLimit,4);
      assert.match(sections[0].text({agent:{session:sessionMap.get(id)}}),reporting==='end'?/任务结束时集中汇总/:reporting==='step'?/每完成一个检查步骤时/:/发现问题、受阻或需要你补充/);
      assert.match(sections[0].text({agent:{session:sessionMap.get(id)}}),/记录已审与未审、支持与反证/);
      checkpointTask(store,id,'当前线索已梳理，请判断下一步');
      assert.equal(!!readTaskPolicy(store,id).awaitingConfirmation,interaction!=='auto');
      await results.dispatch(ctx,store,'task.interaction',{sessionId:id,interaction,reporting:reporting==='end'?'step':'end'});
      assert.equal(!!readTaskPolicy(store,id).awaitingConfirmation,interaction!=='auto');
      for(const key of ['budget','used','startedAt'])assert.deepEqual(readTaskPolicy(store,id)[key],before[key]);
      if(interaction==='confirm-step'){
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
    await results.dispatch(ctx,store,'task.choose',{sessionId:id,mode:'regular',workers:1,interaction:'auto'});
    const ui=harness('ChatSetup',id);ui.render();ui.state[0]=await results.dispatch(ctx,store,'chat.settings',{sessionId:id});
    for(const value of ['3','16']){
      await openChatCollaboration(ui);
      await ui.find(n=>n.props['aria-label']==='最多同时运行的并行任务').props.onChange({target:{value}});
      await ui.button('保存协作设置').props.onClick();assert.equal(chosenTaskOptions(store,id).workers,Number(value));
    }
    for(const value of ['','-1','2.5','17']){
      await openChatCollaboration(ui);
      await ui.find(n=>n.props['aria-label']==='最多同时运行的并行任务').props.onChange({target:{value}});
      await ui.button('保存协作设置').props.onClick();assert.equal(chosenTaskOptions(store,id).workers,16);assert(ui.find(n=>n.props.role==='alert'));
      await ui.button('取消').props.onClick();
    }
    await assert.rejects(results.dispatch(ctx,store,'task.choose',{sessionId:id,mode:'regular',workers:17}),/0[–-]16/);
    await results.dispatch(ctx,store,'task.start',{sessionId:id,policy:{mode:'regular',budget:{toolCalls:7,minutes:10}}});
    const before=readTaskPolicy(store,id);await results.dispatch(ctx,store,'task.workers',{sessionId:id,workers:12});
    for(const key of ['used','startedAt'])assert.deepEqual(readTaskPolicy(store,id)[key],before[key]);
    for(const key of ['toolCalls','deadline'])assert.equal(readTaskPolicy(store,id).budget[key],before.budget[key]);
    await assert.rejects(results.dispatch(ctx,store,'chat.defaults',{sessionId:id,interaction:'confirm-step',workers:17}),/0–16/);
  });
  await test('the worker ceiling defaults to two managed workers for a fresh user',async()=>{
    const id='default-workers-ui';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    const ui=harness('ChatSetup',id);ui.render();ui.state[0]=await results.dispatch(ctx,store,'chat.settings',{sessionId:id});
    await openChatCollaboration(ui);
    const select=ui.find(n=>n.props['aria-label']==='最多同时运行的并行任务');
    assert(select,'子代理上限下拉必须在位');
    assert.equal(String(select.props.value),'2','新用户默认最多两个活动子实例');
    assert.equal(ui.find(n=>n.props['aria-label']==='启用按需协作').props.checked,true);
  });
  await test('settings changes stay in a draft: cancel discards them, save applies them', async () => {
    const id='settings-draft';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    await results.dispatch(ctx,store,'task.choose',{sessionId:id,mode:'regular',workers:1,interaction:'auto',reporting:'end'});
    const ui=harness('ChatSetup',id);ui.render();ui.state[0]=await results.dispatch(ctx,store,'chat.settings',{sessionId:id});
    await openChatSettings(ui);
    await ui.button('节奏').props.onClick();
    const stepRadio=ui.find(n=>n.props['aria-label']==='每完成一个检查步骤时');
    assert(stepRadio,'the reporting radio must be present');
    await stepRadio.props.onChange();
    assert(ui.find(n=>n.props.role==='status'),'an unsaved draft must be announced');
    const close=ui.find(n=>n.props['aria-label']==='关闭测试设置');assert(close,'the close button must be present');
    await close.props.onClick();
    assert.equal(chosenTaskOptions(store,id).reporting,'end','closing only hides the panel');
    await openChatSettings(ui);
    assert.equal(ui.find(n=>n.props['aria-label']==='每完成一个检查步骤时').props.checked,true,
      'closing and reopening must keep the unsaved draft');
    const cancel=ui.button('取消');assert(cancel,'the cancel button must be present');
    await cancel.props.onClick();
    assert.equal(chosenTaskOptions(store,id).reporting,'end','cancel must not write the draft');
    await openChatSettings(ui);
    const afterCancel=ui.find(n=>n.props['aria-label']==='每完成一个检查步骤时');
    assert(afterCancel,'the reporting radio must be present after reopening');
    assert.equal(afterCancel.props.checked,false,'the discarded draft must not come back');
    assert.equal(ui.find(n=>n.props['aria-label']==='任务结束时').props.checked,true,'the stored value must still be selected');
    const stepRadio2=ui.find(n=>n.props['aria-label']==='每完成一个检查步骤时');
    assert(stepRadio2,'the reporting radio must be present after reopening');
    await stepRadio2.props.onChange();
    const save=ui.button('保存');assert(save,'the save button must be present');
    await save.props.onClick();
    assert.equal(chosenTaskOptions(store,id).reporting,'step','save must write the draft');
  });
  await test('non-secret settings drafts survive panel close, session switch and a component restart', async () => {
    const id='persistent-draft';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    const values=new Map();
    const windowObject={localStorage:{getItem:key=>values.has(key)?values.get(key):null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)}};
    const first=harness('ChatSetup',id,{},{window:windowObject});first.render();
    first.state[0]=await results.dispatch(ctx,store,'chat.settings',{sessionId:id});
    await openChatSettings(first);
    await first.button('节奏').props.onClick();
    await first.find(n=>n.props['aria-label']==='每完成一个检查步骤时').props.onChange();
    await first.button('关闭').props.onClick();
    assert(values.has('saker.chat.draft.settings.'+id));
    const restarted=harness('ChatSetup',id,{},{window:windowObject});
    await restarted.mount();
    restarted.state[0]=await results.dispatch(ctx,store,'chat.settings',{sessionId:id});
    await openChatSettings(restarted);
    assert.equal(restarted.find(n=>n.props['aria-label']==='每完成一个检查步骤时').props.checked,true);
    await restarted.button('取消').props.onClick();
    assert.equal(values.has('saker.chat.draft.settings.'+id),false,'explicit cancel removes the persisted draft');
  });
  await test('动作限制：允许访问网站与仅发送 GET/HEAD 进任务策略，固定测试内容清单已移除', async () => {
    const id='action-limits-ui';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    await results.dispatch(ctx,store,'task.choose',{sessionId:id,mode:'regular',workers:1,interaction:'auto',reporting:'end'});
    await results.dispatch(ctx,store,'task.start',{sessionId:id,policy:{mode:'regular',question:'检查登录后的功能',target:'https://fixture.test',budget:{toolCalls:8}}});
    const ui=harness('ChatSetup',id);ui.render();ui.state[0]=await results.dispatch(ctx,store,'chat.settings',{sessionId:id});
    await openChatSettings(ui);
    const network=ui.find(n=>n.props['aria-label']==='允许访问网站');
    assert(network,'允许访问网站 must be present in the settings drawer');
    assert.equal(network.props.checked,true,'默认允许访问网站');
    const readOnly=ui.find(n=>n.props['aria-label']==='仅发送 GET/HEAD');
    assert(readOnly,'仅发送 GET/HEAD must be present in the settings drawer');
    assert.equal(readOnly.props.checked,false,'默认允许改动数据');
    await network.props.onChange({target:{checked:false}});
    await readOnly.props.onChange({target:{checked:true}});
    const save=ui.button('保存');assert(save,'the save button must be present');
    await save.props.onClick();
    const policy=readTaskPolicy(store,id);
    assert.equal(policy.allowTargetNetwork,false,'保存后关闭网站访问');
    assert.equal(policy.readOnly,true,'保存后只允许读取请求');
    // 排除路径：抽屉里填写后进任务策略（同一折叠）
    await openChatSettings(ui);
    const exclude=ui.find(n=>n.props['aria-label']==='排除的地址或路径');
    assert(exclude,'排除路径输入必须在“限制请求和用量”折叠里');
    await exclude.props.onChange({target:{value:'/payment\n/delete'}});
    await ui.button('保存').props.onClick();
    assert.deepEqual(readTaskPolicy(store,id).excludedPaths,['/payment','/delete'],'排除路径要进任务策略');
    // 扫描速率 / 并发：同一折叠里的可选限制，填了才收紧
    await openChatSettings(ui);
    const rate=ui.find(n=>n.props['aria-label']==='扫描速率（每分钟请求数）');
    assert(rate,'速率输入必须在“限制请求和用量”折叠里');
    const concurrency=ui.find(n=>n.props['aria-label']==='并发上限（同时进行）');
    assert(concurrency,'并发输入必须在“限制请求和用量”折叠里');
    await rate.props.onChange({target:{value:'120'}});
    await concurrency.props.onChange({target:{value:'2'}});
    await ui.button('保存').props.onClick();
    const paced=readTaskPolicy(store,id);
    assert.equal(paced.requestRatePerMinute,120,'速率要进任务策略');
    assert.equal(paced.requestConcurrency,2,'并发要进任务策略');
    const removed=await results.dispatch(ctx,store,'test.content',{sessionId:id});
    assert.equal(removed.ok,false);assert.equal(removed.code,'feature_removed','固定测试内容清单必须明确退出');
    // 未开始的任务：抽屉保存走 task.choose，动作限制必须一起带上
    const chooser='action-limits-choose';sessionMap.set(chooser,{id:chooser,header:{agentPreset:'pentest'}});
    await results.dispatch(ctx,store,'task.choose',{sessionId:chooser,mode:'regular',workers:1,interaction:'auto',reporting:'end',
      target:'https://one.example.test/login?next=/orders\nhttps://two.example.test/api?owner=self',allowTargetNetwork:false,readOnly:true});
    const choice=chosenTaskOptions(store,chooser);
    assert.match(choice.target,/one\.example\.test\/login\?next=\/orders/,'未开始时 task.choose 要保留完整目标路径');
    assert.match(choice.target,/two\.example\.test\/api\?owner=self/);
    assert.equal(choice.allowTargetNetwork,false,'未开始时 task.choose 要带上网站访问限制');
    assert.equal(choice.readOnly,true,'未开始时 task.choose 要带上只读限制');
    await results.dispatch(ctx,store,'task.choose',{sessionId:chooser,mode:'regular',workers:1,interaction:'auto',reporting:'end',excludedPaths:'/payment'});
    assert.deepEqual(chosenTaskOptions(store,chooser).excludedPaths,['/payment'],'未开始时 task.choose 要带上排除路径');
  });
  await test('设置抽屉托管本轮预算：预算输入进“限制请求和用量”，任务面板不再重复同名折叠', async () => {
    const id='budget-drawer';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    await results.dispatch(ctx,store,'task.choose',{sessionId:id,mode:'regular',workers:1,interaction:'auto',reporting:'end'});
    const ui=harness('ChatSetup',id);ui.render();ui.state[0]=await results.dispatch(ctx,store,'chat.settings',{sessionId:id});
    await openChatSettings(ui);
    await ui.button('节奏').props.onClick();
    const minutes=ui.find(n=>n.props['aria-label']==='最多运行多久（分钟）');
    assert(minutes,'预算输入必须在设置抽屉的“用量与节奏”页');
    const calls=ui.find(n=>n.props['aria-label']==='工具调用上限（次）');
    assert(calls,'工具调用上限必须在同一页');
    await minutes.props.onChange({target:{value:'25'}});
    await calls.props.onChange({target:{value:'40'}});
    const rendered=JSON.stringify(ui.render());
    assert(!rendered.includes('限制请求和用量'),'预算只在设置抽屉，不再重复折叠');
    assert(!ui.find(n=>n.props&&n.props.budgetDraft),'设置抽屉不再内嵌任务面板，避免两套预算输入');
  });
  await test('任务面板单独使用时保留预算折叠，受控时交给抽屉且不重复渲染', async () => {
    const id='budget-standalone';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    const bare=harness('TaskPanel',id);await bare.mount();await new Promise(setImmediate);
    assert(JSON.stringify(bare.render()).includes('限制请求和用量'),'单独使用时任务面板保留预算折叠');
    assert(bare.find(n=>n.props['aria-label']==='操作预算'),'单独使用时预算输入在任务面板里');
    const controlled=harness('TaskPanel',id,{budgetDraft:{value:{calls:'7',modelCalls:'',tokens:'',minutes:'9',unmetered:'0',discovery:'5'},set:()=>{}}});
    await controlled.mount();await new Promise(setImmediate);
    assert(!JSON.stringify(controlled.render()).includes('限制请求和用量'),'受控时任务面板不再渲染自己的预算折叠');
    assert(!controlled.find(n=>n.props['aria-label']==='操作预算'),'受控时预算输入只在抽屉里，任务面板不重复');
    assert(controlled.button('开始测试'),'受控时“开始测试”仍在任务面板里');
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
    const before=queued.length,ui=harness('ChatSetup',id,{}, {useEffect:fn=>{const dispose=fn();if(typeof dispose==='function'&&!boot)boot=dispose;},setInterval:()=>0,clearInterval(){}});
    ui.render();const unmount=boot;
    for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
    const value=await results.dispatch(ctx,store,'chat.settings',{sessionId:id});
    assert.equal(value.choice,null);assert.equal(value.configured,false);
    await openChatSettings(ui);
    await ui.button('节奏').props.onClick();
    assert.equal(ui.find(n=>n.props['aria-label']==='聊天协作方式').props.value,'auto');
    ui.find(n=>n.props['aria-label']==='搜索设置项').props.onChange({target:{value:'模型调用'}});
    const settingHit=ui.find(n=>n.type==='button'&&n.children[0]==='模型调用');
    assert(settingHit);
    settingHit.props.onClick();
    assert(ui.find(n=>n.props['aria-label']==='模型调用上限（次）'),'settings search locates the target field without a model request');
    await ui.find(n=>n.props['aria-label']==='聊天协作方式').props.onChange({target:{value:'auto'}});
    assert(!ui.find(n=>n.props['aria-label']==='聊天起步方式'),'retired start mode must not be shown');
    await ui.button('范围').props.onClick();
    await ui.find(n=>n.props['aria-label']==='测试方向').props.onChange({target:{value:'nday'}});
    const draftOnly=await results.dispatch(ctx,store,'chat.settings',{sessionId:id});
    assert.equal(draftOnly.options,null,'panel edits stay in the draft until 保存');
    await ui.button('保存').props.onClick();
    const editedDirection=await results.dispatch(ctx,store,'chat.settings',{sessionId:id});
    assert.equal(editedDirection.choice,'nday');
    await openChatCollaboration(ui);
    assert.equal(ui.find(n=>n.props['aria-label']==='最多同时运行的并行任务').props.value,'2');
    await ui.find(n=>n.props['aria-label']==='最多同时运行的并行任务').props.onChange({target:{value:'4'}});
    await ui.button('保存协作设置').props.onClick();
    const edited=await results.dispatch(ctx,store,'chat.settings',{sessionId:id});
    assert.equal(edited.choice,'nday');assert.equal(edited.options.workers,4);assert.equal(edited.options.interaction,'auto');assert.equal(edited.options.startMode,'direct-test');
    assert.equal(edited.configured,false);assert.equal(queued.length,before);unmount();
  });
  await test('测试范围 lives in the settings drawer and reaches the started task', async () => {
    const drawerId='drawer-target';sessionMap.set(drawerId,{id:drawerId,header:{agentPreset:'pentest'}});
    const drawer=harness('ChatSetup',drawerId);drawer.render();drawer.state[0]=await results.dispatch(ctx,store,'chat.settings',{sessionId:drawerId});
    await openChatSettings(drawer);
    const targetField=drawer.find(n=>n.props['aria-label']==='测试范围（网址、域名、IP/CIDR，选填）');
    assert(targetField,'the target must be settable from the settings drawer');
    const drawerTarget='https://one.example.test/login?next=/orders\nhttps://two.example.test/api?owner=self';
    targetField.props.onChange({target:{value:drawerTarget}});
    await drawer.button('保存').props.onClick();
    assert.equal(chosenTaskOptions(store,drawerId).target,drawerTarget,'saving the drawer must persist multi-line target paths');
    assert(!drawer.find(n=>n.props['aria-label']==='目标站点（选填）'),'the target must not be duplicated inside the task panel');
    const id='drawer-target-start';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    const ui=harness('TaskPanel',id,{targetState:['https://fixture.test',()=>{}]});
    await ui.mount();
    ui.find(n=>n.props['aria-label']==='用户要求、范围或已有材料').props.onChange({target:{value:'Only check the provided fixture'}});
    await ui.button('开始测试').props.onClick();
    assert.equal(new URL(readTaskPolicy(store,id).target).origin,'https://fixture.test','the drawer target must reach the started task');

    assert(source.includes("patchDraft({target:event.target.value})"),
      'the settings drawer must keep its own target draft');
    assert(!source.includes("targetState:[draftTarget,function(value){patchDraft({target:value});}]"),
      'the settings drawer must not embed a second task panel');
  });
  await test('the template drawer starts blank, gates insert on required fields, and inserts through the native composer without sending',async()=>{
    let clipboard='',inserted='',admit=true,captured=0;
    const ui=harness('ChatPromptEditor','hero',{mode:'regular',open:true,inputActions:{captureInsertion:()=>{captured++;return {revision:1};},insertText:(text,span)=>{assert.equal(span.revision,1);if(admit)inserted+=text;return admit;}}},{navigator:{clipboard:{writeText:async text=>{clipboard=text;}}}});
    await ui.mount();
    // 首次打开没有默认选中项：全文框尚未出现。
    assert(!ui.find(n=>n.props['aria-label']==='指令正文'),'first open must not preselect a template');
    // 选中 S01 后出现全文与必填项；必填为空时插入置灰。
    const pick=ui.find(n=>n.type==='button'&&JSON.stringify(n).includes('从一个网站开始'));
    assert(pick,'the S01 template must be listed');
    pick.props.onClick();
    // 真实缺陷回归：字段标签曾用 `label + (help ? <small> : null)` 拼接，渲染出字面量 “null”。
    const fieldLabel=ui.find(n=>n.type==='label'&&String(n.props.className||'').includes('dsh-prompt-field'));
    assert(fieldLabel,'the required field label must exist');
    assert(!/null/.test(String(fieldLabel.children[0])),'字段标签文本不能包含 null：'+fieldLabel.children[0]);
    const full=()=>ui.find(n=>n.props['aria-label']==='指令正文');
    assert(full(),'selecting a template shows the full text');
    assert.match(full().props.value,/我在本次任务中说明的范围/,'optional field uses its default phrase');
    assert(ui.button('插入输入框').props.disabled===true,'insert stays disabled until the required field is filled');
    // 填目标地址后可以复制与插入，插入不触发任何模型/任务调用。
    ui.find(n=>n.props['aria-label']==='目标地址').props.onChange({target:{value:'https://fixture.test'}});
    assert(full().props.value.includes('https://fixture.test'));
    await ui.button('复制').props.onClick();assert.equal(clipboard,full().props.value);
    const before=ui.calls.length;
    await ui.button('插入输入框').props.onClick();assert.equal(inserted,clipboard);assert.equal(captured,1);
    assert.equal(ui.calls.filter(([endpoint])=>endpoint==='prompt.draft').length>=1,true,'insert persists only the draft');
    assert(!ui.calls.some(([endpoint])=>endpoint.startsWith('task.')),'insert must not start a task');
    // 输入框在变化时插入被拒绝，编辑内容仍保留。
    admit=false;await ui.button('插入输入框').props.onClick();assert.equal(inserted,clipboard);
    assert(JSON.stringify(ui.render()).includes('正在变化'),'a rejected insert keeps the edit and shows the reason');
    // 另存为我的模板。
    ui.find(n=>n.props['aria-label']==='另存为名称').props.onChange({target:{value:'My fixture prompt'}});
    await ui.button('另存').props.onClick();
    const list=await results.dispatch(ctx,store,'prompt.library',{sessionId:'hero',action:'list'});
    assert(list.user.templates.some(row=>row.title==='My fixture prompt'));
    assert(before>=0);
  });
  await test('users can write a blank prompt, update the same personal template, and retain text on a save conflict',async()=>{
    const id='personal-editor';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    let copied='';
    const ui=harness('ChatPromptEditor',id,{mode:'regular',open:true},{navigator:{clipboard:{writeText:async text=>{copied=text;}}}});
    await ui.mount();ui.button('新建').props.onClick();
    const full=()=>ui.find(n=>n.props['aria-label']==='指令正文');
    assert(full()&&!full().props.readOnly,'new text is immediately editable');
    full().props.onChange({target:{value:'检查订单导出接口，沿用已有账号。'}});
    ui.find(n=>n.props['aria-label']==='另存为名称').props.onChange({target:{value:'订单导出检查'}});
    await ui.button('另存').props.onClick();
    let list=await results.dispatch(ctx,store,'prompt.library',{sessionId:id,action:'list'});
    const created=list.user.templates.find(t=>t.title==='订单导出检查');assert(created);
    assert.equal(created.text,'检查订单导出接口，沿用已有账号。');
    const beforeTotal=list.user.total;
    full().props.onChange({target:{value:'只复核订单导出权限，附正常账号对照。'}});
    await ui.button('复制').props.onClick();assert.equal(copied,'只复核订单导出权限，附正常账号对照。');
    await ui.button('保存修改').props.onClick();
    list=await results.dispatch(ctx,store,'prompt.library',{sessionId:id,action:'list'});
    const updated=list.user.templates.find(t=>t.id===created.id);
    assert.equal(updated.revision,2);assert.equal(updated.text,copied);assert.equal(list.user.total,beforeTotal);
    // Another window's update must reject this stale revision without losing local text.
    await results.dispatch(ctx,store,'prompt.library',{sessionId:id,action:'upsert',template:{...updated,text:'另一窗口的修改',expectedRevision:2}});
    full().props.onChange({target:{value:'本地尚未保存的修改'}});
    await ui.button('保存修改').props.onClick();
    assert.equal(full().props.value,'本地尚未保存的修改');
    assert(JSON.stringify(ui.render()).includes('其他窗口已修改'));
    assert(!ui.calls.some(([endpoint])=>endpoint.startsWith('task.')));
  });
  await test('editing built-in text directly removes unrelated field gates and copies the actual edited text',async()=>{
    const id='manual-built-in';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    let copied='';const ui=harness('ChatPromptEditor',id,{mode:'regular',open:true},{navigator:{clipboard:{writeText:async t=>{copied=t;}}}});
    await ui.mount();ui.find(n=>n.type==='button'&&JSON.stringify(n).includes('从一个网站开始')).props.onClick();
    const full=()=>ui.find(n=>n.props['aria-label']==='指令正文');
    assert(!full().props.readOnly);assert(ui.button('插入输入框').props.disabled);
    full().props.onChange({target:{value:'分析已添加的报文，这次不用目标网址。'}});
    assert(!ui.button('插入输入框').props.disabled,'manual text must not require fields removed by its author');
    await ui.button('复制').props.onClick();assert.equal(copied,full().props.value);
  });
  // v6 第 3.3 节第 8 条：落点必须在打开抽屉前捕获（宿主 caretSpan 在编辑器失焦后退化成文档末尾），
  // 有选区时按钮文案要变成「替换选中文字」。
  await test('the template drawer captures the insertion span before opening and relabels for a selection',async()=>{
    let captured=0;const inserted=[];
    const insertion={current:null};
    const ui=harness('ChatPromptEditor','hero-selection',{mode:'regular',open:true,onClose:function(){},insertion,inputActions:{
      captureInsertion:()=>{captured++;return {start:2,end:7,draftRev:1};},
      insertText:(text,span)=>{inserted.push({text,span});return true;}}});
    await ui.mount();
    ui.find(n=>n.type==='button'&&JSON.stringify(n).includes('从一个网站开始')).props.onClick();
    ui.find(n=>n.props['aria-label']==='目标地址').props.onChange({target:{value:'https://fixture.test'}});
    assert(ui.button('替换选中文字'),'a live selection must relabel the insert button');
    assert(!ui.button('插入输入框'),'the plain insert label must be replaced while a selection exists');
    await ui.button('替换选中文字').props.onClick();
    assert.equal(captured,1,'落点只在打开时捕获一次，插入时不再重取');
    assert.equal(inserted.length,1);
    assert.deepEqual({start:inserted[0].span.start,end:inserted[0].span.end},{start:2,end:7},'插入用的是打开时那份选区');
  });
  // 同一节第 8 条后半：抽屉打开期间输入框被改过，宿主按版本拒绝；此时应换行追加到末尾并如实说明，
  // 而不是把用户已经打好的内容丢回去让他重来。
  await test('a draft changed while the drawer was open appends at the end instead of rejecting',async()=>{
    let captures=0;const seen=[];
    const insertion={current:null};
    const ui=harness('ChatPromptEditor','hero-append',{mode:'regular',open:true,onClose:function(){},insertion,inputActions:{
      captureInsertion:()=>{captures++;return {start:5,end:5,draftRev:captures===1?1:2};},
      insertText:(text,span)=>{seen.push({text,draftRev:span.draftRev});return span.draftRev===2;}}});
    await ui.mount();
    ui.find(n=>n.type==='button'&&JSON.stringify(n).includes('从一个网站开始')).props.onClick();
    ui.find(n=>n.props['aria-label']==='目标地址').props.onChange({target:{value:'https://fixture.test'}});
    await ui.button('插入输入框').props.onClick();
    assert.equal(seen.length,2,'第一次被版本挡下，第二次重取落点再插');
    assert.equal(seen[0].draftRev,1);
    assert.equal(seen[1].draftRev,2);
    assert(seen[1].text.startsWith('\n'),'追加时换行，不和已有内容粘在一起');
    assert(JSON.stringify(ui.render()).includes('输入框已有新内容，已追加到末尾'));
  });
  await test('prompt drafts are isolated by session and direction, personal templates persist, and nothing injects drafts',async()=>{
    const draft={text:'Unsent controlled fixture draft',template:'',mode:'regular'};
    await results.dispatch(ctx,store,'chat.draft',{sessionId:'hero',mode:'regular',draft});
    assert.equal((await results.dispatch(ctx,store,'chat.draft',{sessionId:'hero',mode:'regular'})).draft.text,draft.text);
    for(const [sessionId,mode] of [['ui','regular'],['hero','nday']])assert.equal((await results.dispatch(ctx,store,'chat.draft',{sessionId,mode})).draft,null);
    // 另存为我的模板现在走 prompt.library；用户模板不再绑定执行方向。
    assert((await results.dispatch(ctx,store,'prompt.library',{sessionId:'ui',action:'list'})).user.templates.some(row=>row.title==='My fixture prompt'));
    assert(!sections[0].text({agent:{session:sessionMap.get('hero')}}).includes(draft.text));
    await assert.rejects(results.dispatch(ctx,store,'chat.draft',{sessionId:'audit',mode:'regular',draft}),/Saker 会话/);
    const editedAt=Date.now()+100;
    await results.dispatch(ctx,store,'chat.draft',{sessionId:'hero',mode:'regular',draft:{...draft,text:'Newest edit',editedAt}});
    await results.dispatch(ctx,store,'chat.draft',{sessionId:'hero',mode:'regular',draft:{...draft,text:'Delayed obsolete save',editedAt:editedAt-1}});
    assert.equal((await results.dispatch(ctx,store,'chat.draft',{sessionId:'hero',mode:'regular'})).draft.text,'Newest edit');
  });
  await test('new-session defaults preserve already chosen sessions and running tasks',async()=>{
    const running='chat-default-running';sessionMap.set(running,{id:running,header:{agentPreset:'pentest'}});
    await results.dispatch(ctx,store,'task.choose',{sessionId:running,mode:'regular',workers:1,interaction:'auto'});
    await results.dispatch(ctx,store,'task.start',{sessionId:running,policy:{mode:'regular',question:'Preserve active preferences',budget:{toolCalls:4,minutes:10}}});
    const original=readTaskPolicy(store,running);assert(original&&!original.planComplete);
    const chosen='chat-default-chosen';sessionMap.set(chosen,{id:chosen,header:{agentPreset:'pentest'}});
    await results.dispatch(ctx,store,'task.choose',{sessionId:chosen,mode:'regular',workers:2,interaction:'auto'});
    assert.equal(chosenTaskOptions(store,chosen).workers,2);
    await results.dispatch(ctx,store,'chat.defaults',{sessionId:'chat-live',interaction:'auto',workers:0});
    const id='new-default';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    const newState=await results.dispatch(ctx,store,'chat.settings',{sessionId:id});
    assert.equal(newState.options.interaction,'auto');assert.equal(newState.options.workers,0);
    assert.match(sections[0].text({agent:{session:sessionMap.get(id)}}),/子代理上限=0/);
    // 已选择但未启动的会话不能被新会话默认（0）改写。
    assert.equal(chosenTaskOptions(store,chosen).workers,2);
    assert.deepEqual(readTaskPolicy(store,running),original);
    await results.dispatch(ctx,store,'task.start',{sessionId:id,policy:{mode:'regular',budget:{toolCalls:3}}});
    assert.equal(readTaskPolicy(store,id).interaction,'auto');assert.equal(readTaskPolicy(store,id).workerLimit,0);
  });
  await test('competition context exposes the current prompt, instance connection and attachment references', async () => {
    const id = 'competition-prompt-context';
    sessionMap.set(id, { id, header: { agentPreset: 'ctf-solver', cwd: home } });
    await results.dispatch(ctx, store, 'scene.bind', { sessionId: id, scene: 'competition' });
    const created = await results.dispatch(ctx, store, 'competition.create', {
      sessionId: id,
      title: 'context fixture',
      prompt: 'PROMPT_CONTEXT_MARKER_7D2A',
      instance: { url: 'http://127.0.0.1:19090', connection: 'nc 127.0.0.1 19090' },
      attachments: [{ id: 'attachment-1', materialId: 'pasted-context', name: 'notes.txt', bytes: 42, role: 'input' }],
    });
    const state = competitionPromptState(store, id);
    assert.equal(state.active.challengeId, created.challenge.challengeId);
    assert.match(state.promptLine, /PROMPT_CONTEXT_MARKER_7D2A/);
    assert.match(state.instanceLine, /http:\/\/127\.0\.0\.1:19090/);
    assert.match(state.instanceLine, /nc 127\.0\.0\.1 19090/);
    assert.match(state.attachmentLine, /pasted-context/);
    assert.match(state.attachmentLine, /notes\.txt/);
    importPastedMaterial(store, id, { name: 'competition-notes.txt', text: 'COMPETITION_LOCAL_MATERIAL' });
    const materialTool = registeredTools.get('saker_material');
    const execute = { agent: { session: sessionMap.get(id) } };
    const taskMaterialsWhileKnowledgeDisabled = await materialTool.execute({ action: 'list' }, execute);
    assert.equal(taskMaterialsWhileKnowledgeDisabled.ok, true);
    const current = await materialTool.execute({ action: 'current' }, execute);
    assert.equal(current.ok, true);
    assert.match(current.text, /PROMPT_CONTEXT_MARKER_7D2A/);
    const scene = (await results.dispatch(ctx, store, 'chat.settings', { sessionId: id })).scene;
    await results.dispatch(ctx, store, 'scene.knowledge', { sessionId: id, enabled: true, expectedRevision: scene.sceneRevision });
    const listed = await materialTool.execute({ action: 'list' }, execute);
    assert.equal(listed.ok, true);
    assert.match(listed.text, /competition-notes\.txt/);
  });
  await test('the usage row shows task requests, model usage and time, and expands cache and per-session detail without inventing money', async () => {
    const id='usage-row';
    // 会话 surface 里有真实装配事件，「本次模型输入」分项才有东西可拆。
    const diagEvents=[
      {type:'system/message',data:{role:'system',content:[{type:'text',text:'宿主原有要求与 Saker 简短能力说明'}]}},
      {type:'user/message',data:{role:'user',source:{kind:'runtime-context',sections:[
        {name:'sandbox:policy',text:'Current DSH file policy: danger-full-access.'},
        {name:'saker-pentest-task-state',text:'Saker task state\n目标 https://app.example.test'}]},
        content:[{type:'text',text:'runtime context'}]}},
      {type:'user/message',data:{role:'user',source:{kind:'user'},content:[{type:'text',text:'请检查订单接口'}]}},
      {type:'assistant/message',data:{role:'assistant',content:[{type:'text',text:'好的，先看现有请求。'}]}},
      {type:'request/header',data:{header:{tools:[{function:{name:'redteam_context'}},{function:{name:'knowledge_search'}}]}}},
    ];
    sessionMap.set(id,{id,header:{agentPreset:'pentest'},surface:{nodes:[0,1,2,3,4]},eventAt:seq=>diagEvents[seq]});
    await results.dispatch(ctx,store,'task.choose',{sessionId:id,mode:'regular',workers:1,interaction:'auto'});
    await results.dispatch(ctx,store,'task.start',{sessionId:id,policy:{mode:'regular',budget:{toolCalls:8,minutes:10}}});
    store.db.prepare('INSERT INTO task_cost_events(session_id,seq,at,kind,record) VALUES(?,?,?,?,?)').run(id,1,1,'assistant/message',JSON.stringify({totalTokens:500,inputTokens:400,outputTokens:100,cacheReadTokens:50,cacheWriteTokens:0}));
    store.db.prepare('INSERT INTO task_cost_events(session_id,seq,at,kind,record) VALUES(?,?,?,?,?)').run(id,2,2,'tool/call','{}');
    const ui=harness('UsageRow',id);await ui.mount();await new Promise(setImmediate);
    assert(ui.calls.some(call=>call[0]==='usage.get'),'the row reads usage.get');
    const text=JSON.stringify(ui.render());
    // 用量行分列计量：工具调用是预算计数，网站回执是宿主真实落库的目标请求数。
    assert(text.includes('工具调用 0/8'),'shows the tool-call budget');
    assert(text.includes('网站回执 0'),'shows the host receipt count separately');
    assert(text.includes('本地工具 0'),'shows the local/planning tool count separately');
    assert(text.includes('模型调用 1'),'shows the model call count');
    assert(text.includes('用时'),'shows elapsed time');
    ui.button('明细').props.onClick();
    await new Promise(setImmediate);
    const detail=JSON.stringify(ui.render());
    assert(detail.includes('缓存读'),'expands cache detail');
    assert(detail.includes('主任务'),'expands per-session detail');
    // 本次模型输入分项：固定说明/工具定义/任务事实/用户消息/历史分别列出。
    assert(ui.calls.some(call=>call[0]==='diagnostics.request'),'明细按需读取 diagnostics.request');
    for (const label of ['本次模型输入','固定说明','工具定义','任务事实','用户消息','历史']) assert(detail.includes(label),'shows '+label);
    // v6 第 6.2 节：分项是 UTF-8 字节，不是 token；没有计量器时这一点必须写在界面上。
    assert(detail.includes('字节控制')||detail.includes('单位是 UTF-8 字节'),'states the byte-control unit');
    assert(!detail.includes('¥')&&!/金额[^未]/.test(detail),'never invents a monetary amount');
    // 被拒的生成没有发出：与“已发出但用量未知”分开显示。
    const policyRecord=JSON.parse(store.db.prepare('SELECT record FROM task_policy WHERE session_id=?').get(id).record);
    policyRecord.modelBudgetBlock={code:'model_calls_exhausted',message:'共享模型调用额度已用完',at:Date.now()};
    store.db.prepare('UPDATE task_policy SET record=? WHERE session_id=?').run(JSON.stringify(policyRecord),id);
    await ui.mount();await new Promise(setImmediate);
    assert(JSON.stringify(ui.render()).includes('上次生成未发出'),'a refused generation is shown separately from unknown usage');
  });
  await test('解释测试原理 is a task preference that only adds a teaching line without changing budget or conclusions', async () => {
    const id='explain-ui';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    await results.dispatch(ctx,store,'task.choose',{sessionId:id,mode:'regular',workers:1,interaction:'auto'});
    await results.dispatch(ctx,store,'task.start',{sessionId:id,policy:{mode:'regular',budget:{toolCalls:8,minutes:10}}});
    assert.equal(readTaskPolicy(store,id).explain,false);
    assert(!sections[0].text({agent:{session:sessionMap.get(id)}}).includes('解释测试原理'));
    const ui=harness('ChatSetup',id);ui.render();ui.state[0]=await results.dispatch(ctx,store,'chat.settings',{sessionId:id});
    await openChatSettings(ui);
    ui.button('节奏').props.onClick();
    const box=ui.find(n=>n.props['aria-label']==='解释测试原理');assert(box,'the explain switch is present');
    await box.props.onChange({target:{checked:true}});
    await ui.button('保存').props.onClick();
    assert.equal(readTaskPolicy(store,id).explain,true);
    assert.match(sections[0].text({agent:{session:sessionMap.get(id)}}),/解释测试原理/);
    assert.equal(readTaskPolicy(store,id).budget.toolCalls,8,'explain must not change the budget');
    await results.dispatch(ctx,store,'task.explain',{sessionId:id,explain:false});
    assert.equal(readTaskPolicy(store,id).explain,false);
  });
  await test('三个入口始终最多一个面板：设置、提示词和资料互斥', async () => {
    // 资料事件按 ID 只唤醒依赖它的工作（v6 第 8.3 节）：同一材料 ID 再出现时，只叫声明过它的子代理。
    const wakeId='material-wake';sessionMap.set(wakeId,{id:wakeId,header:{agentPreset:'pentest'}});
    sessionMap.set('wake-child-a',{id:'wake-child-a',header:{agentPreset:'pentest'}});
    const firstImport=await results.dispatch(ctx,store,'materials.import',{sessionId:wakeId,name:'wake.txt',text:'wake fixture body'});
    const wakeMaterialId=firstImport.material.id;
    claimWork(store,wakeId,{worker:'wake-child-a',workKey:'wake-a',materialIds:['file:'+wakeMaterialId]});
    claimWork(store,wakeId,{worker:'wake-child-b',workKey:'wake-b',materialIds:['file:unrelated']});
    const wakeCalls=[];
    const originalAgents=ctx.agents;
    ctx.agents={get:sid=>['wake-child-a','wake-child-b'].includes(sid)
      ?{session:sessionMap.get(sid),status:'idle',followup:message=>wakeCalls.push({sid,message})}
      :originalAgents.get(sid)};
    try {
      const again=await results.dispatch(ctx,store,'materials.import',{sessionId:wakeId,name:'wake.txt',text:'wake fixture body'});
      assert.equal(again.material.id,wakeMaterialId,'同内容复用同一材料 ID');
      // 完全相同原文只是「合并来源」（v6 第 5.4 节），不是新版本：不能假称「有新版本」去唤醒工作。
      assert.deepEqual(again.woken,[],'同内容重复导入不唤醒');
      assert.equal(wakeCalls.length,0,'没有新版本时不投递唤醒消息');
    } finally { ctx.agents=originalAgents; }
    // 「复测中」状态（v6 第 5.3 节）：复核消息投递后列表标出来，写出复测结论后清掉。
    const verifyId='verify-flag';sessionMap.set(verifyId,{id:verifyId,header:{agentPreset:'pentest'}});
    const verifyFinding=registerFinding(store,verifyId,'pentest',{title:'Verify flag fixture',type:'access',severity:'high',target:'https://app.example.test/x'});
    const beforeVerify=await results.dispatch(ctx,store,'findings.list',{sessionId:verifyId,mode:'pentest',page:1,pageSize:5});
    assert.equal(beforeVerify.list.rows.find(r=>r.id===verifyFinding.id).verifying,false,'未发起时不是复测中');
    await results.dispatch(ctx,store,'finding.verify',{sessionId:verifyId,id:verifyFinding.id});
    const duringVerify=await results.dispatch(ctx,store,'findings.list',{sessionId:verifyId,mode:'pentest',page:1,pageSize:5});
    assert.equal(duringVerify.list.rows.find(r=>r.id===verifyFinding.id).verifying,true,'发起复核后标为复测中');
    await results.dispatch(ctx,store,'finding.retest',{sessionId:verifyId,action:'record',findingId:verifyFinding.id,verdict:'inconclusive',note:'本轮无法确认（fixture）'});
    const afterVerify=await results.dispatch(ctx,store,'findings.list',{sessionId:verifyId,mode:'pentest',page:1,pageSize:5});
    assert.equal(afterVerify.list.rows.find(r=>r.id===verifyFinding.id).verifying,false,'有复测结论后不再是复测中');
    // 标题栏当前动作（v6 第 5.1 节）：来自真实执行回执，只在运行中显示。
    const actionId='action-ui';sessionMap.set(actionId,{id:actionId,header:{agentPreset:'pentest'}});
    store.db.prepare('INSERT OR REPLACE INTO execution_receipts(session_id,id,record) VALUES(?,?,?)').run(actionId,'exec-action',JSON.stringify({
      id:'exec-action',endpoint:'https://app.example.test/static/app.js',outcome:'response',status:200,completedAt:new Date().toISOString()}));
    await results.dispatch(ctx,store,'task.start',{sessionId:actionId,policy:{mode:'regular',budget:{toolCalls:5}}});
    const actionUi=harness('ChatSetup',actionId);await actionUi.mount();await new Promise(setImmediate);
    assert(JSON.stringify(actionUi.render()).includes('最近动作：https://app.example.test/static/app.js'),'运行中显示当前动作');
    assert(JSON.stringify(actionUi.render()).includes('停止'),'运行状态在对话页也显示停止按钮');
    assert.equal(actionUi.state[0].phase,'running','运行中的任务状态是 running（v6 第 8.2 节）');
    const attentionId='attention-ui';sessionMap.set(attentionId,{id:attentionId,header:{agentPreset:'pentest'}});
    await results.dispatch(ctx,store,'account.save',{sessionId:attentionId,name:'账号 B',status:'expired'});
    const attentionUi=harness('ChatSetup',attentionId);await attentionUi.mount();await new Promise(setImmediate);
    const attentionHtml=JSON.stringify(attentionUi.render());
    assert(attentionHtml.includes('账号 B 已失效，相关验证暂停'),'需要用户处理时显示单条具体事项');
    assert(attentionHtml.includes('重新绑定账号')&&attentionHtml.includes('继续其他检查'),'附两条出路');
    attentionUi.find(n=>n.type==='button'&&n.children.includes('继续其他检查')).props.onClick();
    assert(!JSON.stringify(attentionUi.render()).includes('账号 B 已失效'),'继续其他检查只关掉这条提示');
    const id='panel-exclusive';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    const ui=harness('ChatSetup',id);await ui.mount();await new Promise(setImmediate);
    // 打开设置
    await openChatSettings(ui);await ui.mount();await new Promise(setImmediate);
    assert(JSON.stringify(ui.render()).includes('dsh-task-settings'),'任务设置面板已打开');
    // 再开提示词模板：设置必须被替换掉，不能两个面板同时挂着
    const promptBtn=ui.button('写提示词');
    assert(promptBtn,'提示词入口存在');
    promptBtn.props.onClick();await ui.mount();await new Promise(setImmediate);
    assert(!JSON.stringify(ui.render()).includes('dsh-task-settings'),'打开提示词后任务设置面板已关闭');
    // 再点回设置：提示词侧同样让位
    await openChatSettings(ui);await ui.mount();await new Promise(setImmediate);
    assert(JSON.stringify(ui.render()).includes('dsh-task-settings'),'任务设置面板重新打开');
    // 长内容也不能把底部操作顶出视口：三个面板都有高度上限。
    for (const cls of ['dsh-chat-more','dsh-chat-prompt','dsh-materials-import']) {
      const re = new RegExp(cls.replace('-','\\-') + '\\{[^}]*max-height:');
      assert(re.test(source), cls + ' 有 max-height');
    }
    assert(source.includes('.dsh-prompt-overlay{position:fixed;inset:48px 0 0'),'编辑窗口避开 Desktop 标题栏');
    assert(source.includes('width:min(1100px,100%);height:min(760px,100%)'),'编辑窗口使用独立的大窗口，不再受输入框上方空间限制');
    assert(source.includes('.dsh-chat-setup{container-type:normal}'),'模板抽屉不被输入框容器的 contain 困住');
    assert(source.includes("'aria-modal':'true'"),'编辑窗口声明为模态并约束键盘导航');
  assert(source.includes("className:'dsh-prompt-blank'")&&source.includes('先选一条模板'),'未选模板时主区有可见引导，不是空白');
    assert(source.includes("'dsh-prompt-hint'")&&source.includes('发送仍由你点'),'编辑窗口说明正文可改且不会自动发送');
    // 执行入口与观测范围（v6 第 8.1 节）：如实说明哪些已接通、哪些不在 Saker 观测内。
    assert(source.includes("'dsh-execution-scope'")&&source.includes('工具内部发了多少请求，可能无法统计'),'请求记录的范围如实列出');
    // 限制项留空要显示「未设置」，不是含糊的「沿用」（v6 第 5.5 节）。
    assert(source.includes("placeholder:'未设置'")&&source.includes('留空表示未设置，实际沿用宿主当前限制'),'限制项留空显示未设置');
    // 设置变更摘要（v6 第 4.2 节）：改了范围/偏好后，任务事件里要能回看改了什么。
    const diffId='settings-diff';sessionMap.set(diffId,{id:diffId,header:{agentPreset:'pentest'}});
    await results.dispatch(ctx,store,'task.start',{sessionId:diffId,policy:{mode:'regular',interaction:'auto',budget:{toolCalls:5}}});
    await results.dispatch(ctx,store,'task.interaction',{sessionId:diffId,interaction:'confirm-step'});
    const diffRow=store.db.prepare('SELECT record FROM task_policy_events WHERE session_id=? ORDER BY id DESC LIMIT 1').get(diffId);
    const diffRecord=JSON.parse(diffRow.record);
    assert(Array.isArray(diffRecord.settings)&&diffRecord.settings.some(row=>row.field==='interaction'),'任务事件带设置变更摘要');
    assert.equal(diffRecord.settings.find(row=>row.field==='interaction').label,'什么时候问我','摘要用可读标签');
    // 资料详情：关联问题 + 从本任务移除（v6 第 5.4 节「删除入口默认从本任务移除」）。
    assert(source.includes('关联问题 ')&&source.includes('从本任务移除')&&source.includes("api('materials.remove'"),'资料详情有移除入口与关联问题');
  });
  await test('添加测试资料面板支持 Esc 关闭并把焦点还给入口按钮', async () => {
    const listeners={};
    const fakeDoc={addEventListener:(t,fn)=>{(listeners[t]=listeners[t]||[]).push(fn);},removeEventListener:(t,fn)=>{listeners[t]=(listeners[t]||[]).filter(f=>f!==fn);}};
    const focused=[];
    const fire=key=>{for(const fn of listeners.keydown||[])fn({key,stopPropagation(){}});};
    for(const [component,openText,panelClass] of [['MaterialsEntry','附件','dsh-materials-import']]){
      listeners.keydown=[];
      const id='esc-'+panelClass;sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
      const ui=harness(component,id,{},{document:fakeDoc});
      await ui.mount();await new Promise(setImmediate);
      const trigger=ui.find(n=>n.type==='button'&&String(n.children.join('')).includes(openText));
      assert(trigger,component+' 入口存在');
      trigger.props.onClick();await ui.mount();await new Promise(setImmediate);
      assert(JSON.stringify(ui.render()).includes(panelClass),component+' 面板已打开');
      fire('Escape');await ui.mount();await new Promise(setImmediate);
      assert(!JSON.stringify(ui.render()).includes(panelClass),component+' Esc 后面板已关闭');
    }
    assert((listeners.keydown||[]).length>=0);
  });
  await test('能力搜索在输入法组合期间不查询，Esc 可关闭并回到入口', async () => {
    const listeners={};
    const fakeDoc={addEventListener:(type,fn)=>{(listeners[type]=listeners[type]||[]).push(fn);},removeEventListener:(type,fn)=>{listeners[type]=(listeners[type]||[]).filter(item=>item!==fn);}};
    const id='ime-modules';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    const ui=harness('ChatSetup',id,{},{document:fakeDoc});
    await ui.mount();await new Promise(setImmediate);
    await ui.button('能力').props.onClick();await ui.mount();await new Promise(setImmediate);
    assert(ui.state.includes('modules'),'能力面板已打开');
    const search=ui.find(n=>n.props&&n.props['aria-label']==='搜索测试模块');
    assert(search,'能力搜索框存在');
    const before=ui.calls.filter(([endpoint,payload])=>endpoint==='workbench.query'&&payload&&payload.kind==='modules.list').length;
    search.props.onCompositionStart();
    search.props.onChange({target:{value:'sql'}});
    await ui.mount();await new Promise(setImmediate);
    assert.equal(ui.calls.filter(([endpoint,payload])=>endpoint==='workbench.query'&&payload&&payload.kind==='modules.list').length,before,'组合输入中不发模块查询');
    ui.find(n=>n.props&&n.props['aria-label']==='搜索测试模块').props.onCompositionEnd({target:{value:'sql'}});
    await ui.poll();await new Promise(setImmediate);
    assert(ui.calls.some(([endpoint,payload])=>endpoint==='workbench.query'&&payload&&payload.kind==='modules.list'&&payload.filter&&payload.filter.text==='sql'),'组合结束后才按最终文字查询');
    listeners.keydown=[];
    await ui.mount();await new Promise(setImmediate);
    for(const fn of listeners.keydown||[])fn({key:'Escape',isComposing:true,stopPropagation(){}});
    await ui.mount();await new Promise(setImmediate);
    assert(ui.state.includes('modules'),'组合输入的 Esc 只取消候选，不关闭面板');
    for(const fn of listeners.keydown||[])fn({key:'Escape',stopPropagation(){}});
    await ui.mount();await new Promise(setImmediate);
    assert(!ui.state.includes('modules'),'Esc 关闭能力面板');
  });
  await test('模板搜索在输入法组合结束后才过滤列表', async () => {
    const id='ime-prompt-search';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    const ui=harness('ChatPromptEditor',id,{open:true,mode:'pentest',onClose:function(){}});
    await ui.mount();await new Promise(setImmediate);
    const countItems=()=>((JSON.stringify(ui.render()).match(/dsh-prompt-item-title/g)||[]).length);
    const before=countItems();
    assert(before>0,'常用模板列表非空');
    const search=ui.find(n=>n.props&&n.props['aria-label']==='模板搜索');
    assert(search,'模板搜索框存在');
    search.props.onCompositionStart();
    search.props.onChange({target:{value:'zzzz-没有这条模板'}});
    await ui.mount();await new Promise(setImmediate);
    assert.equal(countItems(),before,'组合输入期间不按半成品文字过滤');
    ui.find(n=>n.props&&n.props['aria-label']==='模板搜索').props.onCompositionEnd({target:{value:'zzzz-没有这条模板'}});
    await ui.mount();await new Promise(setImmediate);
    assert.equal(countItems(),0,'组合结束后按最终文字过滤');
    assert(JSON.stringify(ui.render()).includes('没有匹配'),'空结果给出可读提示');
  });
  await test('材料成功条固定在滚动区外并能查看同一份材料', async () => {
    const id='materials-success';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    const ui=harness('MaterialsEntry',id,{});
    await ui.mount();await new Promise(setImmediate);
    await ui.button('附件').props.onClick();await ui.mount();await new Promise(setImmediate);
    const pasted='GET /api/health HTTP/1.1\nHost: fixture.test\n\n';
    ui.find(n=>n.props&&n.props['aria-label']==='粘贴测试资料').props.onChange({target:{value:pasted}});
    await ui.mount();
    await ui.button('添加到当前任务').props.onClick();
    await ui.mount();await new Promise(setImmediate);
    const success=ui.find(n=>String(n.props&&n.props.className||'').includes('dsh-materials-success'));
    const body=ui.find(n=>String(n.props&&n.props.className||'').includes('dsh-materials-import-body'));
    assert(success,'成功条存在');
    assert(body,'材料主体存在');
    assert(!JSON.stringify(body).includes('dsh-materials-success'),'成功条不能放在滚动主体里');
    const view=ui.button('查看');
    assert(view,'成功条提供查看入口');
    await view.props.onClick();
    await ui.mount();await new Promise(setImmediate);
    const detailCall=ui.calls.find(([endpoint,payload])=>endpoint==='materials.detail'&&payload&&payload.kind==='file');
    assert(detailCall,'查看走同一条材料的详情接口');
    assert(ui.find(n=>String(n.props&&n.props.className||'').includes('dsh-materials-viewer-text')),'材料原文进入只读查看区');
    assert(JSON.stringify(ui.render()).includes('GET /api/health'),'查看的是刚保存的同一份原文');
  });
  await test('材料导入失败保留已填内容，用户可以修正后重试', async () => {
    const id='materials-failure';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    const calls=[];
    const ui=harness('MaterialsEntry',id,{},{
      api:async(endpoint,payload)=>{calls.push([endpoint,payload]);if(endpoint==='materials.import')return {ok:false,error:'磁盘只读'};return {ok:true};},
    });
    await ui.mount();await new Promise(setImmediate);
    await ui.button('附件').props.onClick();await ui.mount();await new Promise(setImmediate);
    const pasted='GET /api/orders HTTP/1.1\nHost: fixture.test\n\n';
    ui.find(n=>n.props&&n.props['aria-label']==='粘贴测试资料').props.onChange({target:{value:pasted}});
    await ui.mount();
    await ui.button('添加到当前任务').props.onClick();
    await ui.mount();await new Promise(setImmediate);
    const textarea=ui.find(n=>n.props&&n.props['aria-label']==='粘贴测试资料');
    assert.equal(textarea.props.value,pasted,'失败后保留用户输入');
    assert(JSON.stringify(ui.render()).includes('未导入'),'失败原因可见');
    assert.equal(calls.filter(([endpoint])=>endpoint==='materials.import').length,1,'一次点击只提交一次');
  });
  await test('窄主区证据行隐藏独立目标列，并保留目标与任务的可读次行', async () => {
    assert(source.includes('var compact = props.compact === true;'),'narrow evidence table must switch layout from measured width');
    assert(source.includes('var columns = compact ? ["发现", "验证状态", "严重度"]'),'narrow evidence table keeps title, verification and severity only');
    assert(source.includes('compact ? null : h("td", { className: "saker-wb-clamp-2" }'),'narrow evidence table must not keep a half-visible target column');
    assert(source.includes('var compactRows = containerWidth > 0 && containerWidth < 700'),'the page passes the measured compact state');
    assert(source.includes('@container (max-width:700px){.saker-wb-dash-next'),'the overview stacks its two bands when the Saker pane is narrow');
    assert(source.includes('function showVisibleNotice(message)'),'task-open refusals must scroll the notice into view');
  });
  await test('执行表使用已定义的选中键，页面有可恢复的错误边界', async () => {
    assert(!source.includes('className: selectedKey === key'),'execution table must not reference the undefined selectedKey');
    assert(source.includes('className: selectionKey === key'),'execution rows must use the existing selection key');
    assert(source.includes('summary.runningRoots ?? summary.activeRoots'),'the running KPI must use business running state');
    assert(source.includes('saker-wb-fact clickable'),'the KPI counts must be clickable into the same filter');
    assert(source.includes('class SakerRenderBoundary extends React.Component'),'Saker needs a page-level render error boundary');
    assert(source.includes('当前页加载失败') && source.includes('返回测试任务'),'render errors keep retry and return actions');
  });
  await test('材料、旧原文、图返回和角色详情都有可读入口', async () => {
    assert(source.includes('if (row.kind === "material" || row.kind === "file")'),'material table rows open the material inspector');
    assert(source.includes('openTaskFromEvidence(selectedRef.rootId || rootId, "assets")'),'asset/material inspectors return to the task assets tab');
    assert(source.includes('已保存原文（历史快照，只读）'),'legacy finding packets have a read-only presentation');
    assert(source.includes('wbGraphKindLabel(node.kind)') && source.includes('wbNodeStateLabel(node.state)'),'graph kinds and states are localized');
    assert(source.includes('saker-roles-layout') && source.includes('saker-roles-detailpane'),'role detail is adjacent to the selected card');
    assert(source.includes('onOpenFindings') && source.includes('查看任务发现'),'handoff preview links back to task evidence');
  });
  await test('提示词与测试设置面板在焦点不在面板内时也响应 Esc', async () => {
    const listeners={};
    const fakeDoc={addEventListener:(type,fn)=>{(listeners[type]=listeners[type]||[]).push(fn);},removeEventListener:(type,fn)=>{listeners[type]=(listeners[type]||[]).filter(item=>item!==fn);}};
    const fire=()=>{for(const fn of listeners.keydown||[])fn({key:'Escape',stopPropagation(){}});};
    const id='esc-chat-setup';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    const ui=harness('ChatSetup',id,{},{document:fakeDoc});
    await ui.mount();await new Promise(setImmediate);
    await openChatSettings(ui);await ui.mount();await new Promise(setImmediate);
    assert(JSON.stringify(ui.render()).includes('dsh-chat-more'),'测试设置面板已打开');
    assert(ui.state.includes('settings'),'settings state must be active');
    listeners.keydown=[];
    await ui.mount();await new Promise(setImmediate);
    fire();await ui.mount();await new Promise(setImmediate);
    assert(!ui.state.includes('settings'),'焦点在面板外时 Esc 关闭测试设置');
    const prompt=ui.button('写提示词');
    assert(prompt,'提示词模板入口存在');
    prompt.props.onClick();await ui.mount();await new Promise(setImmediate);
    assert(ui.state.includes('prompt'),'提示词模板已打开');
    listeners.keydown=[];
    await ui.mount();await new Promise(setImmediate);
    fire();await ui.mount();await new Promise(setImmediate);
    assert(!ui.state.includes('prompt'),'焦点在面板外时 Esc 关闭提示词模板');
    assert(source.includes("document.addEventListener('keydown',onKey)"),'Esc 监听挂在 document');
  });
  await test('我的模板每页 30 条，加载更多能取到后面的模板且没有总数上限', async () => {
    const id='prompt-page';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    const { upsertUserTemplate } = await import('../plugins/dsh-redteam-results/lib/prompt-store.js');
    for(let i=0;i<35;i+=1) upsertUserTemplate(store,{id:'page-'+i,title:'分页模板'+String(i).padStart(2,'0'),group:'自定义',text:'请测试 {{target}}。',required:['target'],optional:[],keywords:[]});
    const ui=harness('ChatPromptEditor',id,{open:true,mode:'pentest',onClose:function(){}});
    await ui.mount();await new Promise(setImmediate);
    assert(!ui.find(n=>n.type==='button'&&String(n.children.join('')).indexOf('加载更多')===0),'精选常用不显示与当前列表无关的用户分页');
    ui.find(n=>n.props&&n.props.role==='tab'&&n.children.includes('我的')).props.onClick();
    const countItems=()=>((JSON.stringify(ui.render()).match(/dsh-prompt-item-title/g)||[]).length);
    const first=countItems();
    assert(first>0,'第一页渲染了模板');
    const firstCall=ui.calls.find(c=>c[0]==='prompt.library'&&c[1].action==='list');
    assert(firstCall,'读了模板库');
    // 我的页按用户模板分页，与内置目录大小无关。
    const moreBtn=ui.find(n=>n.type==='button'&&String(n.children.join('')).indexOf('加载更多')===0);
    assert(moreBtn,'还有内容时显示加载更多');
    assert(/还有 \d+ 条/.test(String(moreBtn.children.join(''))),'标出还没加载的条数，实际 '+moreBtn.children.join(''));
    await moreBtn.props.onClick();await new Promise(setImmediate);
    const after=countItems();
    assert(after>first,'加载更多后模板变多：'+first+' → '+after);
    assert(ui.calls.some(c=>c[0]==='prompt.library'&&c[1].action==='list'&&c[1].offset===30),'第二页用 offset=30 取');
    assert(!ui.find(n=>n.type==='button'&&String(n.children.join('')).indexOf('加载更多')===0),'全部加载后不再显示加载更多');
  });
  await test('模板库有导入/导出入口，导入逐条报告，同名模板标出更新时间', async () => {
    const id='prompt-io';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    const { upsertUserTemplate } = await import('../plugins/dsh-redteam-results/lib/prompt-store.js');
    upsertUserTemplate(store,{id:'mine-same-a',title:'同名模板',group:'自定义',text:'请测试 {{target}}。',required:['target'],optional:[],keywords:['标签A']});
    upsertUserTemplate(store,{id:'mine-same-b',title:'同名模板',group:'自定义',text:'请检查 {{target}} 的权限。',required:['target'],optional:[],keywords:[]});
    const ui=harness('ChatPromptEditor',id,{open:true,mode:'pentest',onClose:function(){}});
    await ui.mount();await new Promise(setImmediate);
    ui.find(n=>n.props&&n.props.role==='tab'&&n.children.includes('我的')).props.onClick();
    const html=JSON.stringify(ui.render());
    assert(html.includes('导入')&&html.includes('导出'),'列表有导入/导出入口');
    assert((html.match(/同名模板/g)||[]).length>=2,'同名模板允许并存');
    assert(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(html),'用户模板标出更新时间，同名可区分');
    const exportBtn=ui.find(n=>n.type==='button'&&n.children.includes('导出'));
    await exportBtn.props.onClick();await new Promise(setImmediate);
    assert(ui.calls.some(c=>c[0]==='prompt.library'&&c[1].action==='export'),'导出走 prompt.library export');
    const fileInput=ui.find(n=>n.props&&n.props['aria-label']==='导入模板文件');
    assert(fileInput,'有导入文件输入');
    const doc={schemaVersion:1,templates:[
      {id:'imp-ok',title:'导入模板',group:'自定义',text:'请测试 {{target}}。',required:['target'],optional:[],keywords:['x']},
      {id:'bad id!',title:'',text:''}]};
    fileInput.props.onChange({target:{files:[{text:async()=>JSON.stringify(doc)}],value:''}});
    await new Promise(setImmediate);await new Promise(setImmediate);
    assert(ui.calls.some(c=>c[0]==='prompt.library'&&c[1].action==='import'),'导入走 prompt.library import');
    const after=JSON.stringify(ui.render());
    assert(after.includes('导入完成：接受 1 条'),'逐条报告接受数');
    assert(after.includes('拒绝 1 条'),'逐条报告拒绝数');
  });
  await test('模板编辑 500ms 防抖保存，关闭时提交最后一版', async () => {
    const openEditor=async(id,value)=>{
      sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
      const props={open:true,mode:'pentest',onClose:function(){}};
      const ui=harness('ChatPromptEditor',id,props);
      await ui.mount();await new Promise(setImmediate);
      assert(ui.calls.some(c=>c[0]==='prompt.library'&&c[1].action==='list'),'抽屉打开读模板库');
      const pick=ui.find(n=>n.type==='button'&&(n.children||[]).some(c=>c&&c.props&&c.props.className==='dsh-prompt-item-title'&&(c.children||[]).includes('从一个网站开始')));
      assert(pick,'模板列表里有内置模板');
      pick.props.onClick();await ui.mount();await new Promise(setImmediate);
      const target=ui.find(n=>n.props&&n.props['aria-label']==='目标地址');
      assert(target,'必填字段渲染成输入框');
      target.props.onChange({target:{value}});await ui.mount();
      return {ui,props};
    };
    const saves=ui=>ui.calls.filter(c=>c[0]==='prompt.draft'&&c[1].action==='save');
    // 500ms 防抖：编辑后跑掉计时器就落一次草稿
    const a=await openEditor('prompt-debounce','https://app.example.test/debounced');
    assert.equal(saves(a.ui).length,0,'防抖前不写草稿');
    await a.ui.poll();await new Promise(setImmediate);
    assert(saves(a.ui).length>0,'防抖后保存草稿');
    assert(String(saves(a.ui).at(-1)[1].text||'').includes('https://app.example.test/debounced'),'防抖存的是编辑后的内容');
    // 关闭时提交最后一版：不等防抖，直接关也要保存
    const b=await openEditor('prompt-close','https://app.example.test/on-close');
    assert.equal(saves(b.ui).length,0,'关闭前没触发防抖');
    b.props.open=false;await b.ui.mount();await new Promise(setImmediate);
    assert(saves(b.ui).length>0,'关闭时提交最后一版草稿');
    assert(String(saves(b.ui).at(-1)[1].text||'').includes('https://app.example.test/on-close'),'关闭存的是最后一版内容');
  });
  // 2026-10-18 真机复现的 bug：抽屉里的草稿表只在打开时加载一次，保存成功后不回写，
  // 「编辑 → 切模板 → 切回来」会恢复成保存前的旧值（S01 的 检查重点 明明已落库却是空的）。
  // 真机证据见 _ref/private/.../desktop-draft-check-9337.json（修复前 FAIL、修复后 PASS）；
  // 这里只钉住机制，防止那一行被删掉。
  await test('saving a draft refreshes the in-memory draft map (UI03 switch-back restore)', async () => {
    assert(source.includes('drafts[1](function(previous){var next=Object.assign({},previous);next[id]=result.draft;return next;})'),
      'persist 成功后必须把新草稿写回内存草稿表，否则切模板会恢复保存前的旧值');
  });
  await test('draft conflict keeps both sides instead of overwriting (UI03)', async () => {
    const id='prompt-conflict';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    const ui=harness('ChatPromptEditor',id,{open:true,mode:'regular',
      inputActions:{captureInsertion:()=>({start:0,end:0,revision:1}),insertText:()=>true}});
    await ui.mount();await new Promise(setImmediate);
    const pick=ui.find(n=>n.type==='button'&&(n.children||[]).some(c=>c&&c.props&&c.props.className==='dsh-prompt-item-title'&&(c.children||[]).includes('从一个网站开始')));
    assert(pick,'模板列表里有内置模板');
    pick.props.onClick();await ui.mount();await new Promise(setImmediate);
    const target=ui.find(n=>n.props&&n.props['aria-label']==='目标地址');
    target.props.onChange({target:{value:'https://app.example.test/local-draft'}});await ui.mount();
    await ui.poll();await new Promise(setImmediate);
    const localDraft=readDraft(store,id,'S01');
    assert(localDraft&&localDraft.revision>0,'本地草稿已落库');
    // 再编辑一次并挂载：挂载会把本模板已有的稿读回来，draftRev 仍是本地那一版。
    target.props.onChange({target:{value:'https://app.example.test/local-draft-2'}});await ui.mount();
    // 就在这一刻「另一个窗口」用同一模板存了一版：服务端 revision 前进，本窗口的 draftRev 过期。
    const other=await results.dispatch(ctx,store,'prompt.draft',{sessionId:id,action:'save',templateId:'S01',
      expectedRevision:localDraft.revision,mode:'regular',editMode:'manual',fields:{},text:'其他窗口改过的稿'});
    assert.equal(other.ok,true,JSON.stringify(other));
    // 防抖到期 → 本窗口拿过期 revision 保存 → 服务端返回冲突
    await ui.poll();
    // persist 是「防抖 → 串行队列 → RPC → 写状态」的多段异步，单次 setImmediate 不够；
    // 这里等一个真实 tick，否则读到的还是冲突前的界面（第一版就是这么假失败的）。
    await new Promise(resolve=>setTimeout(resolve,5));
    const html=JSON.stringify(ui.render());
    const saveCalls=ui.calls.filter(c=>c[0]==='prompt.draft'&&c[1].action==='save').map(c=>c[1].expectedRevision);
    assert(html.includes('其他窗口已修改这份草稿，两份都保留'),
      '冲突要保留双方并说明；saves='+JSON.stringify(saveCalls)+' storeRev='+readDraft(store,id,'S01').revision);
    assert(html.includes('载入另一窗口版本')&&html.includes('用本地版本另存'),'冲突给两个明确选择');
    // 不按电脑时间自动覆盖：库里仍是对方那一版，本地稿只放在冲突对象里等用户选。
    assert.equal(readDraft(store,id,'S01').text,'其他窗口改过的稿','冲突时不自动覆盖服务端版本');
    const serverBtn=ui.find(n=>n.type==='button'&&(n.children||[]).includes('载入另一窗口版本'));
    assert(serverBtn,'冲突面板上有「载入另一窗口版本」');
    serverBtn.props.onClick();await ui.mount();await new Promise(setImmediate);
    const html2=JSON.stringify(ui.render());
    assert(html2.includes('其他窗口改过的稿'),'载入另一窗口版本后正文换成对方那一版');
    assert(!html2.includes('其他窗口已修改这份草稿'),'解决后冲突提示消失');
  });
  await test('draft restore picks the most recently edited template, not the highest revision (UI03)', async () => {
    const id='prompt-recent';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    // A01 改三次（revision 3），S01 只改一次但**更晚**：重启后要恢复 S01。
    for(let i=0;i<3;i+=1){
      await results.dispatch(ctx,store,'prompt.draft',{sessionId:id,action:'save',templateId:'A01',expectedRevision:i,
        mode:'regular',editMode:'fields',fields:{materials:'A01-'+i},text:'A01-'+i});
    }
    await new Promise(resolve=>setTimeout(resolve,5));
    await results.dispatch(ctx,store,'prompt.draft',{sessionId:id,action:'save',templateId:'S01',expectedRevision:0,
      mode:'regular',editMode:'fields',fields:{target:'S01-later'},text:'S01-later'});
    const ui=harness('ChatPromptEditor',id,{open:true,mode:'regular',
      inputActions:{captureInsertion:()=>({start:0,end:0,revision:1}),insertText:()=>true}});
    await ui.mount();await new Promise(setImmediate);
    const target=ui.find(n=>n.props&&n.props['aria-label']==='目标地址');
    assert(target&&target.props.value==='S01-later','恢复的应该是最后编辑的那条草稿，不是 revision 最高的那条');
    const list=listDrafts(store,id);
    assert(list.every(row=>typeof row.updatedAt==='string'&&row.updatedAt),'草稿列表要带更新时间');
  });
  await test('停止状态先显示正在停止，收到代理退出依据后才显示已停止', () => {
    const sandbox = {};
    runInNewContext(source.slice(source.indexOf('function taskStatusLabel('), source.indexOf('function ChatSetup(')) + ';this.label=taskStatusLabel;', sandbox);
    assert.equal(sandbox.label({ stopped: false }, {}), '本轮进行中');
    assert.equal(sandbox.label({ stopped: true, reason: 'plan_complete' }, {}), '本轮已完成');
    assert.equal(sandbox.label({ stopped: true, reason: 'cancelled', agentRunning: true }, { cancelled: true }), '正在停止…');
    assert.equal(sandbox.label({ stopped: true, reason: 'cancelled', agentRunning: false }, { cancelled: true }), '已停止');
  });
  await test('旧任务策略缺少 flow 时工具行仍能渲染（不得整行崩溃）', async () => {
    const id='legacy-policy';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    // 模拟历史策略：有 policy 但没有 flow 字段。
    store.db.prepare('INSERT INTO task_policy(session_id,record,updated_at) VALUES(?,?,?)')
      .run(id, JSON.stringify({ mode:'regular', interaction:'auto', reporting:'end', workerLimit:1, cancelled:true,
        budget:{toolCalls:5}, used:{toolCalls:1}, startedAt:Date.now(), planComplete:false }), new Date().toISOString());
    const ui=harness('ChatSetup',id);ui.render();ui.state[0]=await results.dispatch(ctx,store,'chat.settings',{sessionId:id});
    assert(ui.find(n=>n.type==='section'&&n.props&&n.props['aria-label']==='聊天任务设置'),'old policies must not blank the whole tool row');
    assert(!ui.find(n=>n.props&&n.props.title==='使用输入框上方唯一的 Saker 场景选择器切换'),'the settings row no longer duplicates the external scene selector');
    await openChatSettings(ui);
    assert(ui.find(n=>n.props&&n.props['aria-label']==='测试方向'),'the direction control still renders');
  });
  await test('添加测试资料把粘贴内容保存为原文引用，并提示格式与字节数', async () => {
    const id='materials-entry';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    const ui=harness('MaterialsEntry',id);await ui.mount();
    assert(ui.button('附件'),'tool row exposes the material entry');
    ui.button('附件').props.onClick();await new Promise(setImmediate);
    ui.find(n=>n.props['aria-label']==='粘贴测试资料').props.onChange({target:{value:'GET /api/orders HTTP/1.1\r\nHost: app.example.test\r\nCookie: sid=abc\r\n\r\n'}});
    await ui.button('添加到当前任务').props.onClick();await new Promise(setImmediate);
    assert(ui.calls.some(c=>c[0]==='materials.import'&&String(c[1].text).includes('/api/orders')),'saving goes through materials.import');
    assert(JSON.stringify(ui.render()).includes('已保存'),'the result is reported back with format and size');
    // 导入中只显示当前动作；完成后给出请求/文件/失败计数，用户不需要看内部流水线名。
    const html=JSON.stringify(ui.render());
    assert(!html.includes('识别 → 解析 → 去重 → 保存'),'内部流水线名不再出现在界面上');
    assert(html.includes('已导入：请求 '),'完成显示请求/文件/失败计数');
    assert(html.includes('；失败 '),'完成显示失败数');
    assert(html.includes('身份 1（待关联）'),'带身份头的原文在计数里标出身份待关联');
  });
  await test('选择文件先入队，只有明确点击导入才写入资料', async () => {
    const pickStart = source.indexOf('function pickFiles(event) {');
    const pickEnd = source.indexOf('function prepareSource(', pickStart);
    const pick = source.slice(pickStart, pickEnd);
    assert(pick.includes('queued[1]'), 'selected files must enter the queue');
    assert(!pick.includes('materials.import') && !pick.includes('project.import'), 'selection must not write or parse immediately');
    const saveStart = source.indexOf('function save() {');
    const saveEnd = source.indexOf('function pickFiles(event)', saveStart);
    const save = source.slice(saveStart, saveEnd);
    assert(save.includes('importQueued') && save.includes('importPasted'), 'explicit save must import queued files and pasted text');
    assert(source.includes("queued[0].length ? (text[0].trim() ? '添加文件与粘贴内容' : '添加所选文件')"), 'the button must announce the queued-file action');
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
  await test('导出报告自动遮蔽账号秘密（页面本地查看不受影响）', () => {
    const sandbox = {};
    runInNewContext(source.slice(source.indexOf('function maskSecrets('), source.indexOf('function mdReport(')) + ';this.mask=maskSecrets;', sandbox);
    const req = 'GET /api/orders HTTP/1.1\r\nHost: app.example.test\r\nAuthorization: Bearer SECRET-TOKEN\r\nCookie: sid=abc123\r\nX-Api-Key: k-9\r\n\r\n';
    const masked = sandbox.mask(req);
    assert(!masked.includes('SECRET-TOKEN'), 'Authorization 的值不随报告外流');
    assert(!masked.includes('abc123'), 'Cookie 的值不随报告外流');
    assert(!masked.includes('k-9'), 'API key 的值不随报告外流');
    assert(masked.includes('Authorization: [已遮蔽]') && masked.includes('Cookie: [已遮蔽]') && masked.includes('X-Api-Key: [已遮蔽]'));
    assert(masked.includes('Host: app.example.test'), '非秘密请求头保留');
    const json = sandbox.mask('{"token":"abc","password":"p","user":"u"}');
    assert(!json.includes('"abc"') && !json.includes('"p"'), 'JSON 里的秘密字段也遮蔽');
    assert(json.includes('"user":"u"'), '普通字段保留');
    // 报告模板与 JSON 导出确实调用了遮蔽，而不是只写了个函数。
    assert(source.includes('maskSecrets(f.requestPkt)') && source.includes('maskSecrets(f.responsePkt)'));
    assert(source.includes('maskSecrets(row.requestPkt)') && source.includes('maskSecrets(row.responsePkt)'));
  });
  await test('报告先预览再导出：导出入口只生成预览，下载按钮在预览面板里', () => {
    assert(source.includes('function previewReport('), '有统一的预览入口');
    for (const fn of ['exportAll', 'exportSelected', 'exportOne', 'exportOverview', 'exportHtml', 'exportJson']) {
      const start = source.indexOf('function ' + fn + '(');
      assert(start > 0, fn + ' 存在');
      const body = source.slice(start, start + 600);
      assert(body.includes('previewReport('), fn + ' 应生成预览而不是直接下载');
      assert(!body.includes('download('), fn + ' 不应直接下载');
    }
    assert(source.includes('"aria-label": "报告预览"'), '预览面板有可访问名称');
    assert(source.includes('setReportPreview(null)'), '预览可以关闭');
    assert(source.includes('props.onPreview(result.filename, result.text)'), '交付包也走预览');
    assert(source.includes('.dsh-rtr-preview-body{max-height:'), '预览正文独立滚动，不撑爆页面');
    // 深色主题：正文底色不能写死浅色回退（宿主没有 --dsw-alias-bg-l1，回退色会永远生效 → 白底白字）。
    assert(!source.includes('background:var(--dsw-alias-bg-l1,#fafafa)'), '预览正文不能写死浅色回退');
    assert(source.includes('background:var(--dsw-alias-bg-l1,rgba(128,128,128,.08))'), '预览正文底色跟随主题（半透明灰）');
  });
  await test('资料详情的大文件可以按段续读，而不是只看前 8192 字节', () => {
    assert(source.includes('function nextSegment('), '文件详情有续读入口');
    assert(source.includes('offset: current.nextOffset'), '续读要带上 nextOffset');
    assert(source.includes("'继续读取（已读 '"), '续读按钮写明已读进度');
    assert(!source.includes('已截断，按需分段查看'), '旧文案（只提示截断、无法续读）已退出');
  });
  await test('给助手选择模型：可用模型来自宿主授权，选择进入任务策略', async () => {
    const id='worker-model-ui';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    const withHost={...ctx,subagentModelSelection:{current:()=>({enabled:true,allowedModels:[{provider:'p1',model:'m1'}]})}};
    const models=await results.dispatch(withHost,store,'chat.models',{sessionId:id});
    assert.equal(models.enabled,true);assert.deepEqual(models.models,[{provider:'p1',model:'m1'}]);
    const off=await results.dispatch(ctx,store,'chat.models',{sessionId:id});
    assert.equal(off.enabled,false,'宿主没开启时不得凭空给出模型');assert.deepEqual(off.models,[]);
    await results.dispatch(ctx,store,'task.choose',{sessionId:id,mode:'regular',workers:1,interaction:'auto',workerModel:{provider:'p1',model:'m1'},reviewModel:{provider:'p1',model:'m1'},reportModel:{provider:'p1',model:'m1'}});
    assert.deepEqual(chosenTaskOptions(store,id).workerModel,{provider:'p1',model:'m1'});
    assert.deepEqual(chosenTaskOptions(store,id).reviewModel,{provider:'p1',model:'m1'});
    assert.deepEqual(chosenTaskOptions(store,id).reportModel,{provider:'p1',model:'m1'});
    await assert.rejects(results.dispatch(ctx,store,'task.choose',{sessionId:id,mode:'regular',workerModel:{provider:'',model:'m'}}),/provider|model|格式/);
    await results.dispatch(ctx,store,'task.start',{sessionId:id,policy:{mode:'regular',budget:{toolCalls:5}}});
    assert.deepEqual(readTaskPolicy(store,id).workerModel,{provider:'p1',model:'m1'},'任务策略要记住站点子代理模型');
    assert.deepEqual(readTaskPolicy(store,id).reviewModel,{provider:'p1',model:'m1'},'任务策略要记住复核模型');
    assert.deepEqual(readTaskPolicy(store,id).reportModel,{provider:'p1',model:'m1'},'任务策略要记住报告模型');
    // 新版语义：workerModel迁到协作模型，reviewModel保留为可选复核，
    // reportModel只用于用户明确要求成稿；字段名保持兼容。
    const modelUi=harness('WorkerModelSection',id,{values:{workerModel:null,reviewModel:null,reportModel:null},disabled:false,onChange:()=>{}},{api:async()=>({ok:true,enabled:true,models:[{provider:'p1',model:'m1'}]})});
    await modelUi.mount();
    const rendered=JSON.stringify(modelUi.render());
    assert(rendered.includes('并行任务用哪个模型（可选）'),'模型区要有用户能理解的标题');
    for(const label of ['协作模型','独立复核','写报告时使用'])assert(rendered.includes(label),`模型区必须有「${label}」一行`);
    assert(rendered.includes('默认和当前会话一样'),'要有默认继承说明');
    assert(rendered.includes('复核和写报告各有自己的触发条件'),'要说明复核和报告按需使用');
    assert(rendered.includes('用量都算在本任务里'),'要说明模型用量归属');
    assert(!rendered.includes('由主会话处理'),'R07 后不得再写复核/报告由主会话处理');
  });
  // v6 第 4.3 节：默认全选**不把完整清单**塞进提示；用户筛过才给一行已选重点，
  // 默认排除项（CORS、开放重定向）单独一行。
  await test('登录账号：列表只给名称与状态，秘密另存且不外泄', async () => {
    const id='accounts-ui';sessionMap.set(id,{id,header:{agentPreset:'pentest'}});
    assert.deepEqual((await results.dispatch(ctx,store,'account.list',{sessionId:id})).accounts,[]);
    await results.dispatch(ctx,store,'account.save',{sessionId:id,name:'普通账号 A',status:'valid',secret:'session=super-secret'});
    await results.dispatch(ctx,store,'account.save',{sessionId:id,name:'过期账号 B',status:'expired'});
    const list=await results.dispatch(ctx,store,'account.list',{sessionId:id});
    assert.equal(list.accounts.length,2);
    assert(!JSON.stringify(list).includes('super-secret'),'秘密绝不能随列表返回');
    const a=list.accounts.find(row=>row.name==='普通账号 A');
    assert.equal(a.statusLabel,'有效');assert.equal(a.hasSecret,true);assert.equal(a.secret,undefined);
    const b=list.accounts.find(row=>row.name==='过期账号 B');
    assert.equal(b.statusLabel,'已失效','过期不得显示成有效');assert.equal(b.hasSecret,false);
    await assert.rejects(results.dispatch(ctx,store,'account.save',{sessionId:id,name:'',status:'valid'}),/不能为空/);
    await assert.rejects(results.dispatch(ctx,store,'account.save',{sessionId:id,name:'x',status:'unknown'}),/状态/);
    assert.equal((await results.dispatch(ctx,store,'account.remove',{sessionId:id,id:a.id})).accounts.length,1);
    const secrets=store.db.prepare('SELECT count(*) AS n FROM task_account_secrets WHERE session_id=?').get(id).n;
    assert.equal(secrets,0,'移除账号必须同时删掉另存的秘密');
  });
  await test('Desktop scene result view branches free/cases and competition without duplicate tabs', async () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../plugins/dsh-redteam-results/lib/client.js'), 'utf8');
    for (const label of ['正在验证', '执行记录', '发现', '附件']) assert(source.includes("'" + label + "'"), label + ' direct view missing');
    assert(source.includes('id: "saker-results"'), 'single scene result view missing');
    assert(source.includes("preset === 'ctf-solver'"), 'competition branch missing');
    assert(source.includes('return detail(value.challenge.challengeId)'), 'new challenge must load its full detail instead of a prompt-less list row');
    assert(source.includes("answer[1]('');return detail(selected[0])"), 'saved competition answers must refresh the current challenge detail');
    assert(!source.includes('questionDraft:{value:startQuestion[0],set:startQuestion[1]}'), 'settings must not duplicate the task start question');
    assert(source.includes('function TaskPanel('), 'standalone task panel must remain for task pages');
    assert(modeSource.includes('view.canSwitchInPlace === true && hasDraft === false && view.presetId === scene.preset'), 'cross-preset scene changes must use the authoritative scene preset');
    assert(modeSource.includes('sessionId: "session-" +'), 'new scene sessions need an explicit host id to avoid blank-session reuse');
    assert(!source.includes('id: row[0]'), 'duplicate scene tabs must be removed');
    assert(!source.includes('进度与发现'), 'nested overview label must be gone');
    const resultsViewSource = source.slice(source.indexOf('function ResultsView'), source.indexOf('function TaskPanel'));
    assert(!resultsViewSource.includes('概览'), 'duplicate result-tab overview must be gone');
    assert(source.includes('label: "概览"'), 'the top-level workbench overview must keep its navigation label');
    assert(source.includes("'设置'"), 'settings entry must be 设置');
    assert(source.includes('api("task.review"'), 'candidate review must use the bounded purpose-task RPC');
    assert(source.includes("api('component.status'"), 'task details must read component facts through the read-only RPC');
    assert(source.includes('查看组件事实与最近评估'), 'component facts must be available without asking the model');
    assert(source.includes("api('role.status'"), 'task details must read work items and role handoffs without a model call');
    assert(source.includes('查看具体问题、分工与交接'), 'work items and role handoffs must have a visible detail entry');
    assert(source.includes('批量换工具'), 'method editing must expose a batch tool replacement path');
    assert(source.includes('请求独立复核'), 'the candidate detail must expose a reviewer entry');
    assert(source.includes('props.workerReview'), 'review output must remain attached to the candidate that requested it');
    assert(modeSource.includes("var knownScene = SCENE_DEFS.find(function (item) { return item.id === SCENE_BY_PRESET[snap.currentPreset]; });"), 'a known preset must show its Chinese scene label before the scene API returns');
  });
} finally {
  for (const dispose of disposers.reverse()) await dispose();
  store.close(); fs.rmSync(home, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
