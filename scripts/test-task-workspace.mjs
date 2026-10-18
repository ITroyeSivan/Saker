import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {openStore, registerFinding} from '../plugins/dsh-redteam-results/lib/store.js';
import {saveTaskContext} from '../plugins/dsh-redteam-results/lib/task-context.js';
import {dispatch} from '../plugins/dsh-redteam-results/lib/index.js';

const home=mkdtempSync(join(tmpdir(),'saker-workspace-ui-'));
const store=openStore(join(home,'results.db'));
const source=readFileSync(new URL('../plugins/dsh-redteam-results/lib/client.js',import.meta.url),'utf8');
const fixtureSource=source.replace('module.exports = { name: "dsh-redteam-results-client",','module.exports = { Detail, ResultsView, ModePage, TaskPanel, MaterialsPanel, ExecutionPanel, installChatSetupStyles, name: "dsh-redteam-results-client",');
// materials.list 会校验渗透会话；其余只读计数接口不要求会话存在。
const ctx={sessions:{get:id=>id==='current'?{id,header:{agentPreset:'pentest'}}:null}};
registerFinding(store,'current','pentest',{title:'Current pending observation',target:'http://current.invalid/',summary:'not independently verified'});
registerFinding(store,'foreign','pentest',{title:'Foreign observation must remain historical',target:'http://foreign.invalid/',summary:'not current'});
registerFinding(store,'foreign','code-audit',{title:'Foreign audit',auditMode:'static'});
const flush=async()=>{await new Promise(setImmediate);};
const nodes=node=>!node||typeof node!=='object'?[]:[node,...(node.children||[]).flat(Infinity).flatMap(nodes)];
function harness(component, props={}, override={}) {
  let cursor=0;const state=[],effects=[],calls=[],downloads=[],timers=[];
  const useState=initial=>{const i=cursor++;if(!(i in state))state[i]=initial;return [state[i],next=>{state[i]=typeof next==='function'?next(state[i]):next;}];};
  const React={createElement:(type,props,...children)=>({type,props:props||{},children}),useState,
    useRef:initial=>{const i=cursor++;if(!(i in state))state[i]={current:initial};return state[i];},
    useCallback:fn=>fn,useEffect:fn=>effects.push(fn)};
  const document={createElement:tag=>({style:{},click(){},remove(){},tagName:tag}),head:{appendChild(){}},body:{appendChild(){}},addEventListener(){},removeEventListener(){}};
  // Replace only the transport in the isolated test realm. Production components
  // and endpoint dispatch remain real; exports are extended only in memory.
  const inner=fixtureSource.slice(fixtureSource.indexOf('var dshCsrf'),fixtureSource.lastIndexOf('return module.exports;'));
  const innerSandbox={React,useState:React.useState,useRef:React.useRef,useCallback:React.useCallback,useEffect:React.useEffect,module:{exports:{}},document,Blob,URL,setTimeout:()=>0,clearTimeout(){},setInterval:fn=>{timers.push(fn);return timers.length;},clearInterval(){},console};
  runInNewContext(inner+';this.selected='+component+';',innerSandbox);
  innerSandbox.api=override.api||(async(endpoint,payload)=>{calls.push({endpoint,payload});return dispatch(ctx,store,endpoint,payload);});
  innerSandbox.download=(name,text)=>downloads.push({name,text});
  const render=()=>{cursor=0;effects.length=0;return innerSandbox.selected({sessionId:'current',...props});};
  return {state,calls,downloads,render,find:fn=>nodes(render()).find(fn),button:label=>nodes(render()).find(n=>(n.type==='button'||n.type?.name==='Btn')&&n.children.includes(label)),
    mount:async()=>{render();for(const effect of effects.slice())effect();await flush();},flush,
    tick:async()=>{const last=timers[timers.length-1];if(last)await last();}};
}
let failures=0;
async function test(name,fn){try{await fn();console.log('ok   '+name);}catch(error){failures++;console.log('FAIL '+name+': '+error.stack);}}
try {
  // R06：四个入口由宿主 conversation.view 直接注册，工作区不再自带标签栏与「更多记录」下拉。
  await test('task workspace opens the execution tab directly and keeps other tabs lazy',async()=>{
    const ui=harness('ResultsView');await ui.mount();await ui.flush();
    assert(ui.find(n=>n.type?.name==='ExecutionPanel'),'默认进入执行记录');
    for(const name of ['ModePage','MaterialsPanel','BigScreen','TaskPanel','ContextPanel','ResearchPanel','MethodPackagesPanel'])assert(!ui.find(n=>n.type?.name===name),'eagerly mounted '+name);
    assert(!ui.calls.some(call=>call.endpoint==='counts.session'||call.endpoint==='counts.all'),'未打开发现页时不读计数');
    assert(!nodes(ui.render()).some(n=>n.props?.['aria-label']==='更多记录'),'不再有第二套「更多记录」导航');
  });
  await test('current findings use session counts and never fall back to global counts',async()=>{
    const ui=harness('ResultsView',{fixedArea:'findings'});await ui.mount();await ui.flush();
    assert(ui.calls.some(call=>call.endpoint==='counts.session'&&call.payload.sessionId==='current'),'发现页只读本会话计数');
    assert(!ui.calls.some(call=>call.endpoint==='counts.all'),'发现页不读全库计数');
    assert.equal(ui.state[3].pentest,1);assert.equal(ui.state[3]['code-audit'],0);
    assert.equal(ui.find(n=>n.type?.name==='ModePage').props.scope,'session');
  });
  await test('all-session counts are only requested when history is explicitly selected',async()=>{
    const session=harness('ResultsView',{fixedArea:'findings'});await session.mount();await session.flush();
    assert(!session.calls.some(call=>call.endpoint==='counts.all'),'普通发现页不请求全库计数');
    const history=harness('ResultsView',{fixedArea:'history'});await history.mount();await history.flush();
    assert(history.calls.some(call=>call.endpoint==='counts.all'),'显式进入历史区域才读全库计数');
    assert.equal(history.find(n=>n.type?.name==='ModePage').props.scope,'all');
  });
  await test('a stale counts response cannot overwrite the latest counts',async()=>{
    const pending=[];
    const ui=harness('ResultsView',{fixedArea:'findings'},{api:(endpoint,payload)=>new Promise(resolve=>pending.push({endpoint,payload,resolve}))});
    await ui.mount();await ui.flush();
    assert.equal(pending.length,1);
    await ui.mount();await ui.flush();
    assert.equal(pending.length,2,'重复刷新会产生更新的 revision');
    pending[1].resolve({counts:{pentest:2}});await flush();
    assert.equal(ui.state[3].pentest,2);
    pending[0].resolve({counts:{pentest:1}});await flush();
    assert.equal(ui.state[3].pentest,2,'迟到的旧响应不得覆盖最新计数');
  });
  await test('the 测试资料 tab lists current website inputs from the real store and never starts a model or task call',async()=>{
    saveTaskContext(store,'current',{assets:[{id:'a1',url:'https://current.invalid/',inScope:true,reachable:true,source:'manual'}],
      requests:[{id:'r1',revision:'v1',endpoint:'https://current.invalid/api/orders',authContext:'user-a',kind:'api',valid:true,
        request:'GET /api/orders HTTP/1.1\r\nHost: current.invalid\r\n\r\n',response:'HTTP/1.1 200 OK\r\n\r\n[]'}]});
    const ui=harness('MaterialsPanel');await ui.mount();await flush();
    assert(ui.calls.some(call=>call.endpoint==='materials.list'),'the tab loads through materials.list');
    const table=ui.find(n=>n.type==='table');assert(table,'materials render a table');
    const text=JSON.stringify(table);
    assert(text.includes('网站与端口')&&text.includes('请求'),'both asset and request rows are shown');
    assert(text.includes('current.invalid'),'the asset host is listed');
    // 「模型是否读过」（v6 第 5.4 节）：没读过就显示尚未读取，读过显示已收到对应片段。
    assert(text.includes('AI 是否读过')&&text.includes('尚未读取'),'列表标出模型是否读过');
    assert(!ui.calls.some(call=>call.endpoint==='redteam_task'||String(call.endpoint).includes('model')),'listing materials must not start a task or model call');
    const viewBtn=nodes(table).find(n=>n.type==='button'&&n.children.includes('查看'));assert(viewBtn,'每行有查看入口');
    await viewBtn.props.onClick();await ui.flush();
    assert(ui.calls.some(call=>call.endpoint==='materials.detail'),'查看走 materials.detail');
    const detailHtml=JSON.stringify(ui.render());
    assert(detailHtml.includes('资料详情')&&detailHtml.includes('current.invalid'),'详情展示入口与原文引用');
    // 本地查看与模型收到分开保存（v6 第 5.4 节）：打开详情补记一条本地状态，读取详情本身保持纯读。
    assert(ui.calls.some(call=>call.endpoint==='materials.viewed'),'打开详情补记本地查看');
    assert(!ui.calls.some(call=>call.endpoint==='materials.list'&&call.payload&&call.payload.markRead),'列表读取不写已读状态');
    // 用户明确筛选「AI 读过的内容」时走服务端筛选。
    const readSelect=nodes(ui.render()).find(n=>n.type==='select'&&n.props?.['aria-label']==='读取状态筛选');
    assert(readSelect,'读取状态筛选存在');
    readSelect.props.onChange({target:{value:'model'}});await ui.mount();await flush();
    assert(ui.calls.some(call=>call.endpoint==='materials.list'&&call.payload.read==='model'),'读取状态筛选进入服务端请求');
    assert(JSON.stringify(ui.render()).includes('没有匹配的资料'),'筛选为空时说没有匹配，而不是首次空页文案');
    // 引用到输入框必须先取插入点，再把 span 交给宿主 API（否则宿主会读到 undefined 的 span）。
    let captured=0, inserted=null;
    const ui2=harness('MaterialsPanel',{inputActions:{captureInsertion:()=>{captured++;return {revision:7};},insertText:(text,span)=>{inserted={text,span};return true;}}});
    await ui2.mount();await ui2.flush();
    const refBtn=nodes(ui2.render()).find(n=>n.type==='button'&&n.children.includes('引用到输入框'));
    assert(refBtn,'每行有引用到输入框');
    await refBtn.props.onClick();await ui2.flush();
    assert.equal(captured,1,'captureInsertion is called before inserting');
    assert(inserted&&inserted.span&&inserted.span.revision===7,'the captured span is passed through');
    assert(JSON.stringify(ui2.render()).includes('已引用到输入框'),'the reference is confirmed to the user');
    // 详情主操作也叫“引用到输入框”（v6 第 5.4 节）：只追加引用、不发送、不记为已读取。
    await ui2.button('查看').props.onClick();await ui2.flush();
    const detailNode=nodes(ui2.render()).find(n=>n.props?.className==='dsh-materials-detail');
    assert(detailNode,'详情面板已打开');
    const detailRef=nodes(detailNode).find(n=>n.type==='button'&&n.children.includes('引用到输入框'));
    assert(detailRef,'详情主操作是引用到输入框');
    await detailRef.props.onClick();await ui2.flush();
    assert.equal(captured,2,'详情引用也要先取插入点');
    assert(inserted.text.includes('current.invalid'),'详情引用带可读名称与内部引用');
    // 「有 N 条新记录」（v6 第 5.7 节）：轮询发现新行时只提示数量，不跳页、不打断当前视图。
    const imported=await dispatch(ctx,store,'materials.import',{sessionId:'current',name:'fresh.txt',text:'fresh material body'});
    assert.equal(imported.ok,true,'新资料导入成功: '+JSON.stringify(imported).slice(0,120));
    const beforeTick=ui.calls.filter(call=>call.endpoint==='materials.list').length;
    await ui.tick();await flush();
    const afterTick=ui.calls.filter(call=>call.endpoint==='materials.list').length;
    assert.equal(afterTick,beforeTick+1,'轮询会重新读取列表');
    assert(source.includes("'有 ' + newCount[0] + ' 条新资料'")&&source.includes("setInterval(function () { if (!loading[0]) load(); }, 8000)"),
      '新记录只提示数量且轮询只读列表');
  });
  await test('the 执行记录 tab lists real calls with result and usage, and links to the request原文 page',async()=>{
    store.db.prepare('INSERT OR REPLACE INTO execution_receipts(session_id,id,record) VALUES(?,?,?)').run('current','execution-1',JSON.stringify({
      id:'execution-1',source:'host-http-execution',endpoint:'https://current.invalid/api/orders',hypothesisId:'d1',requestId:'r1',requestRevision:'v1',
      outcome:'response',status:200,completedAt:new Date(1700000000000).toISOString(),elapsedMs:12,requestAttempts:1,impactVerified:false}));
    store.db.prepare('INSERT INTO task_cost_events(session_id,seq,at,kind,record) VALUES(?,?,?,?,?)').run('current',1,1700000000000,'tool/call','{}');
    store.db.prepare('INSERT INTO task_cost_events(session_id,seq,at,kind,record) VALUES(?,?,?,?,?)').run('current',2,1700000000001,'assistant/message',JSON.stringify({totalTokens:120}));
    const ui=harness('ExecutionPanel');await ui.mount();await flush();
    assert(ui.calls.some(call=>call.endpoint==='execution.list'),'loads through execution.list');
    const text=JSON.stringify(ui.render());
    assert(text.includes('已返回'),'the call result is shown');
    assert(text.includes('工具调用 1')&&text.includes('模型调用 1'),'usage is summarised');
    assert(text.includes('r1:v1'),'the row references the request original instead of copying it');
    assert(text.includes('身份')&&text.includes('user-a'),'执行记录带身份引用（v6 第 8.1 节）');
    // 任务引用（v6 第 8.1 节）：按回执完成时间落到所属轮次；渠道就是回执自带的 source。
    store.db.prepare('INSERT OR REPLACE INTO task_rounds(session_id,started_at,record) VALUES(?,?,?)').run('current',1699999999000,JSON.stringify({endedAt:1700000001000}));
    const ledger=await dispatch(ctx,store,'execution.list',{sessionId:'current',result:'all',page:1,pageSize:50});
    const execRow=ledger.rows.find(r=>r.id==='execution-1');
    assert.equal(execRow.taskId,'current:1699999999000','执行记录带任务引用');
    assert.equal(execRow.source,'host-http-execution','渠道就是回执来源');
    // 调用状态（v6 第 8.2 节）：被停止打断的那一次单列「取消」，不并进结果未知。
    store.db.prepare('INSERT OR REPLACE INTO execution_receipts(session_id,id,record) VALUES(?,?,?)').run('current','execution-cancelled',JSON.stringify({
      id:'execution-cancelled',source:'host-http-execution',endpoint:'https://current.invalid/api/orders',outcome:'interrupted',completedAt:new Date(1700000000500).toISOString()}));
    const ledger2=await dispatch(ctx,store,'execution.list',{sessionId:'current',result:'all',page:1,pageSize:50});
    assert.equal(ledger2.rows.find(r=>r.id==='execution-cancelled').callState,'cancelled','取消单列');
    assert(source.includes("cancelled: '取消'"),'执行记录显示取消状态');
    const toggle=ui.find(n=>n.type==='button'&&n.children.includes('失败 0'));assert(toggle,'result filter counts are shown');
  });
  await test('list, grouping and full export remain in the selected scope and include pending evidence',async()=>{
    for(const scope of ['session','all']){
      const ui=harness('ModePage',{mode:'pentest',scope});await ui.mount();
      assert.equal(ui.calls[0].payload.scope,scope);assert.equal(ui.calls[0].payload.delivery,'all');
      assert.equal(ui.state[1].total,scope==='session'?1:2);
      assert.equal(ui.state[1].rows.some(row=>row.title.startsWith('Foreign')),scope==='all');
      assert.equal(!!ui.find(n=>n.type?.name==='CheckedList'),scope==='session');
      assert.equal(!!ui.find(n=>n.type?.name==='MetaBar'),scope==='session');
      ui.button('按目标分组').props.onClick();await ui.mount();assert.equal(ui.calls.at(-1).endpoint,'findings.groups');assert.equal(ui.calls.at(-1).payload.scope,scope);
      assert.equal(ui.state[1].groups.length,scope==='session'?1:2);assert(ui.state[1].stats);
      // 详情顺序固定（v6 第 5.3 节）：一句话结论与影响排最前，且 pentest 下不再重复渲染描述/影响。
      assert(/mode === "pentest" && \(f\.summary \|\| f\.description \|\| f\.impact\)/.test(source),'结论与影响置顶');
      assert(/mode !== "pentest" && f\.description/.test(source),'pentest 详情不重复渲染描述');
      assert(source.indexOf('f.evidence ? Block({ title: "证据引用" }') < source.indexOf("mode === 'pentest' && f.delivery ? Block"),
        '尚缺条件排在原始依据之后');
      // 详情是覆盖面板（v6 第 5.3 节）：宽 min(640px, 内容区宽度)，覆盖不挤压列表，并有关闭按钮。
      assert(/\.dsh-rtr-detail\{position:fixed;right:24px;bottom:24px/.test(source),'详情改成覆盖面板');
      assert(source.includes('width:min(640px,calc(100vw - 48px))'),'详情宽 min(640px, 内容区宽度)');
      assert(source.includes('className: "dsh-rtr-detail-head"') && source.includes('React.createElement(Btn, { onClick: function () { props.onClose(); } }, "关闭")'),
        '详情顶部有固定的关闭按钮');
      assert(source.includes('"复核/复测"') && source.includes('"导出这条发现"'),'详情底部操作按 5.3 的叫法');
      assert(source.includes('dsh-rtr-st-retesting') && source.includes('"查看运行记录"'),'复测中有状态标记与运行记录入口');
      assert(source.includes('dsh-rtr-packets') && source.includes('@media(max-width:720px){.dsh-rtr-packets'),
        '原文请求/响应双栏，窄屏改成上下栏');
      assert(source.includes('maskSecrets(f.requestPkt || "（未保存）")') && source.includes('"展开原始内容"') && source.includes('"重新遮蔽"'),
        '原文默认遮蔽账号密钥，用户可本地展开与重新遮蔽');
      // 状态词表按 v6 第 5.3 节的叫法（只改显示，不动 store 稳定值）。
      assert(source.includes('pending: "待核实"')&&source.includes('verified: "已确认"'),'状态词表按 5.3 的叫法');
      assert(source.includes("f.retest.latest.verdict === 'not-reproduced'")&&source.includes('"本次未复现"'),'复测未复现单独显示');
      ui.button('导出 ▾').props.onClick({currentTarget:{getBoundingClientRect:()=>({left:0,top:0,bottom:10})}});
      const menu=ui.find(n=>n.type?.name==='PopMenu');menu.props.items.find(x=>x.label==='结构化报告（JSON）').onClick();await flush();
      assert.equal(ui.calls.at(-1).payload.scope,scope);assert.equal(ui.calls.at(-1).payload.pageSize,100);
      // 先预览再导出（v6 第 9.2 节）：点导出只生成预览，下载按钮在预览面板里。
      assert.equal(ui.downloads.length,0,'导出入口不应直接下载');
      const preview=ui.find(n=>n.props&&n.props['aria-label']==='报告预览');
      assert(preview,'导出后出现报告预览面板');
      assert.equal(JSON.stringify(preview).includes('Foreign'),scope==='all');
      ui.button('下载').props.onClick();await flush();
      assert.equal(ui.downloads.length,1);assert.equal(ui.downloads[0].text.includes('Foreign'),scope==='all');
    }
  });
  await test('finding detail masks request/response secrets by default and reveals them only on demand',async()=>{
    const finding=registerFinding(store,'secret','pentest',{
      title:'Secret packet finding',target:'https://current.invalid/api/orders',summary:'token leak candidate',
      requestPkt:'GET /api/orders HTTP/1.1\r\nHost: current.invalid\r\nAuthorization: Bearer TOP-SECRET-TOKEN\r\nCookie: sid=secret-cookie\r\n\r\n',
      responsePkt:'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nSet-Cookie: sid=secret-cookie\r\n\r\n{"token":"TOP-SECRET-TOKEN"}'
    });
    const ui=harness('Detail',{f:finding,mode:'pentest',meta:{archetype:'findings',pocTitle:'测试过程 / 复现 EXP'}});await ui.mount();
    let rendered=ui.render();
    let html=JSON.stringify(rendered.children);
    assert(html.includes('Secret packet finding'),'opened the secret finding');
    assert(html.includes('原始依据（请求 / 响应）')&&html.includes('请求原文')&&html.includes('响应原文'),'请求/响应按双栏渲染');
    const pres=nodes(rendered).filter(n=>n.type==='pre');
    let packetText=pres.map(n=>String(n.children.join(''))).join('\n');
    assert(packetText.includes('[已遮蔽]'),'默认遮蔽秘密');
    assert(!packetText.includes('TOP-SECRET-TOKEN')&&!packetText.includes('secret-cookie'),'默认不显示账号密钥');
    const reveal=nodes(rendered).find(n=>(n.type==='button'||n.type?.name==='Btn')&&n.children.includes('展开原始内容'));
    assert(reveal,'有展开原始内容入口');
    reveal.props.onClick();await ui.flush();
    rendered=ui.render();
    packetText=nodes(rendered).filter(n=>n.type==='pre').map(n=>String(n.children.join(''))).join('\n');
    assert(packetText.includes('TOP-SECRET-TOKEN')&&packetText.includes('secret-cookie'),'展开后本地可见原文');
    const remask=nodes(rendered).find(n=>(n.type==='button'||n.type?.name==='Btn')&&n.children.includes('重新遮蔽'));
    assert(remask,'展开后可重新遮蔽');
  });
  await test('missing session is rejected and current grouping carries current metadata and statistics',async()=>{
    const empty=harness('ModePage',{mode:'code-audit',scope:'session',onAddMaterials:()=>{}});await empty.mount();await flush();
    const listCall=empty.calls.find(call=>call.endpoint==='findings.list');
    assert(listCall,'发现页走 findings.list');
    assert.equal(listCall.payload.pageSize,50,'发现页每页 50 条（v6 第 5.3 节）');
    const emptyHtml=JSON.stringify(empty.render());
    assert(emptyHtml.includes('测试中发现的异常会保存在这里'),'首次空页说明异常会保存在这里');
    assert(emptyHtml.includes('添加测试资料'),'首次空页带添加测试资料入口');
    await assert.rejects(dispatch(ctx,store,'counts.session',{}),/sessionId required/);
    const grouped=await dispatch(ctx,store,'findings.groups',{sessionId:'current',mode:'pentest'});
    assert.equal(grouped.groups.length,1);assert.equal(grouped.stats.total,1);assert(grouped.meta);
  });
} finally {store.db.close();rmSync(home,{recursive:true,force:true});}
process.exitCode=failures?1:0;
