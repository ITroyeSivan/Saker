import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import {readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {openStore, registerFinding} from '../plugins/dsh-redteam-results/lib/store.js';
import {dispatch} from '../plugins/dsh-redteam-results/lib/index.js';

const home=mkdtempSync(join(tmpdir(),'saker-workspace-ui-'));
const store=openStore(join(home,'results.db'));
const source=readFileSync(new URL('../plugins/dsh-redteam-results/lib/client.js',import.meta.url),'utf8');
const fixtureSource=source.replace('module.exports = { name: "dsh-redteam-results-client",','module.exports = { ResultsView, ModePage, TaskPanel, installChatSetupStyles, name: "dsh-redteam-results-client",');
const ctx={};
registerFinding(store,'current','pentest',{title:'Current pending observation',target:'http://current.invalid/',summary:'not independently verified'});
registerFinding(store,'foreign','pentest',{title:'Foreign observation must remain historical',target:'http://foreign.invalid/',summary:'not current'});
registerFinding(store,'foreign','code-audit',{title:'Foreign audit',auditMode:'static'});
const flush=async()=>{await new Promise(setImmediate);};
const nodes=node=>!node||typeof node!=='object'?[]:[node,...(node.children||[]).flat(Infinity).flatMap(nodes)];
function harness(component, props={}, override={}) {
  let cursor=0;const state=[],effects=[],calls=[],downloads=[];
  const useState=initial=>{const i=cursor++;if(!(i in state))state[i]=initial;return [state[i],next=>{state[i]=typeof next==='function'?next(state[i]):next;}];};
  const React={createElement:(type,props,...children)=>({type,props:props||{},children}),useState,
    useRef:initial=>{const i=cursor++;if(!(i in state))state[i]={current:initial};return state[i];},
    useCallback:fn=>fn,useEffect:fn=>effects.push(fn)};
  const document={createElement:tag=>({style:{},click(){},remove(){},tagName:tag}),head:{appendChild(){}},body:{appendChild(){}},addEventListener(){},removeEventListener(){}};
  // Replace only the transport in the isolated test realm. Production components
  // and endpoint dispatch remain real; exports are extended only in memory.
  const inner=fixtureSource.slice(fixtureSource.indexOf('var dshCsrf'),fixtureSource.lastIndexOf('return module.exports;'));
  const innerSandbox={React,useState:React.useState,useRef:React.useRef,useCallback:React.useCallback,useEffect:React.useEffect,module:{exports:{}},document,Blob,URL,setTimeout:()=>0,clearTimeout(){},setInterval:()=>0,clearInterval(){},console};
  runInNewContext(inner+';this.selected='+component+';',innerSandbox);
  innerSandbox.api=override.api||(async(endpoint,payload)=>{calls.push({endpoint,payload});return dispatch(ctx,store,endpoint,payload);});
  innerSandbox.download=(name,text)=>downloads.push({name,text});
  const render=()=>{cursor=0;effects.length=0;return innerSandbox.selected({sessionId:'current',...props});};
  return {state,calls,downloads,render,find:fn=>nodes(render()).find(fn),button:label=>nodes(render()).find(n=>(n.type==='button'||n.type?.name==='Btn')&&n.children.includes(label)),
    mount:async()=>{render();for(const effect of effects.slice())effect();await flush();},flush};
}
let failures=0;
async function test(name,fn){try{await fn();console.log('ok   '+name);}catch(error){failures++;console.log('FAIL '+name+': '+error.stack);}}
try {
  await test('task workspace mounts only the chosen area and does not fetch global history on entry',async()=>{
    const ui=harness('ResultsView');await ui.mount();assert.equal(ui.calls.length,0);
    assert(ui.find(n=>n.type?.name==='TaskPanel'));
    for(const name of ['ModePage','ContextPanel','ResearchPanel','MethodPackagesPanel','BigScreen'])assert(!ui.find(n=>n.type?.name===name),'eagerly mounted '+name);
    assert.deepEqual(nodes(ui.render()).filter(n=>n.type==='button').map(n=>n.children[0]),['任务','发现','资料','历史']);
  });
  await test('current findings use session counts and historical records require an explicit navigation choice',async()=>{
    const ui=harness('ResultsView');await ui.mount();ui.button('发现').props.onClick();await ui.mount();
    assert.equal(ui.calls.at(-1).endpoint,'counts.session');assert.equal(ui.calls.at(-1).payload.sessionId,'current');
    assert.equal(ui.state[3].pentest,1);assert.equal(ui.state[3]['code-audit'],0);
    assert.equal(ui.find(n=>n.type?.name==='ModePage').props.scope,'session');
    ui.button('历史').props.onClick();await ui.mount();assert.equal(ui.calls.at(-1).endpoint,'counts.all');
    assert.equal(ui.state[3].pentest,2);assert.equal(ui.find(n=>n.type?.name==='ModePage').props.scope,'all');
  });
  await test('late global counts cannot overwrite current-session counts after switching back',async()=>{
    const pending=[];const ui=harness('ResultsView',{}, {api:(endpoint,payload)=>new Promise(resolve=>pending.push({endpoint,payload,resolve}))});
    await ui.mount();ui.button('历史').props.onClick();await ui.mount();ui.button('发现').props.onClick();await ui.mount();
    pending[1].resolve({counts:{pentest:1}});await flush();pending[0].resolve({counts:{pentest:144}});await flush();assert.equal(ui.state[3].pentest,1);
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
      ui.button('导出 ▾').props.onClick({currentTarget:{getBoundingClientRect:()=>({left:0,top:0,bottom:10})}});
      const menu=ui.find(n=>n.type?.name==='PopMenu');menu.props.items.find(x=>x.label==='结构化报告（JSON）').onClick();await flush();
      assert.equal(ui.calls.at(-1).payload.scope,scope);assert.equal(ui.calls.at(-1).payload.pageSize,100);
      assert.equal(ui.downloads.length,1);assert.equal(ui.downloads[0].text.includes('Foreign'),scope==='all');
    }
  });
  await test('missing session is rejected and current grouping carries current metadata and statistics',async()=>{
    await assert.rejects(dispatch(ctx,store,'counts.session',{}),/sessionId required/);
    const grouped=await dispatch(ctx,store,'findings.groups',{sessionId:'current',mode:'pentest'});
    assert.equal(grouped.groups.length,1);assert.equal(grouped.stats.total,1);assert(grouped.meta);
  });
} finally {store.db.close();rmSync(home,{recursive:true,force:true});}
process.exitCode=failures?1:0;
