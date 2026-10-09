import './test-home-isolation.mjs';
import assert from 'node:assert/strict';import {mkdtempSync,writeFileSync,rmSync,existsSync,readdirSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {probeToolStartup,createToolStartupChecks} from '../plugins/dsh-sec-config/lib/tool-startup.js';
import {readFileSync} from 'node:fs';import {runInNewContext} from 'node:vm';
const root=mkdtempSync(join(tmpdir(),'tool-startup-test-'));let failed=0;
async function test(name,fn){try{await fn();console.log('ok '+name)}catch(error){failed++;console.log('FAIL '+name+': '+error.stack)}}
function fixture(name,body){const file=join(root,name+'.mjs');writeFileSync(file,body);return file}
const good=fixture('good',"console.log('Usage: ffuf [options]');"), section=file=>({entries:[{key:'ffuf',path:file}]}), payload=file=>({key:'ffuf',expectedPath:file});
try{
 await test('a real help invocation succeeds with a matching tool identity and retains the actual entry',async()=>{const r=await probeToolStartup(section(good),payload(good));assert.equal(r.state,'available');assert.equal(r.actualFile,good);assert.equal(r.exitCode,0);assert.match(r.preview,/ffuf/);assert(r.outputSha256);});
 await test('a present file whose dependencies fail never becomes available',async()=>{const file=fixture('failed',"console.error('ModuleNotFoundError: required_dependency');process.exitCode=2");const r=await probeToolStartup(section(file),payload(file));assert.equal(r.state,'failed');assert.equal(r.exitCode,2);assert.match(r.preview,/ModuleNotFoundError/);});
 await test('zero exit with another tool or empty output is a mismatch',async()=>{for(const body of ["console.log('some other tool')",'']){const file=fixture('wrong',body);const r=await probeToolStartup(section(file),payload(file));assert.equal(r.state,'mismatch');}});
 await test('a matching banner with nonzero exit is still failed',async()=>{const file=fixture('banner-failed',"console.log('ffuf');process.exitCode=1");assert.equal((await probeToolStartup(section(file),payload(file))).state,'failed');});
 await test('missing, hidden and unsupported entries are explicit and do not execute custom code',async()=>{assert.equal((await probeToolStartup({},payload(good))).state,'unconfigured');assert.equal((await probeToolStartup({...section(good),hiddenTools:['ffuf']},payload(good))).state,'unconfigured');assert.equal((await probeToolStartup(section(join(root,'absent.exe')),payload(join(root,'absent.exe')))).state,'missing');const unknown=fixture('custom',"throw Error('must never execute')");assert.equal((await probeToolStartup({tools:{unknown}},{key:'unknown',expectedPath:unknown})).state,'unsupported');});
 await test('unsaved or changed paths cannot invoke the saved program',async()=>{const file=fixture('must-not-run',"console.log('ffuf');require('node:fs').writeFileSync('side-effect','bad')");assert.equal((await probeToolStartup(section(file),payload(good))).state,'stale');});
 await test('installer entry is rejected before execution',async()=>{const file=fixture('tool-setup',"throw Error('must never execute installer')");assert.equal((await probeToolStartup(section(file),payload(file))).state,'unsupported');});
 await test('timeout stops the exact spawned process and reports failure',async()=>{const pidFile=join(root,'child.pid'),file=fixture('hanging',`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)`);const r=await probeToolStartup(section(file),payload(file),{timeoutMs:600});assert.equal(r.state,'timeout');assert(existsSync(pidFile));const fs=await import('node:fs'),pid=Number(fs.readFileSync(pidFile));assert.throws(()=>process.kill(pid,0));});
 await test('excess output cannot become a valid help result',async()=>{const file=fixture('large',"console.log('ffuf'+'x'.repeat(100000))");const r=await probeToolStartup(section(file),payload(file));assert.equal(r.state,'inconclusive');assert(r.outputTruncated);assert(r.preview.length<=4000);});
 await test('overlapping identical checks share one real invocation and cleanup permits a fresh retry',async()=>{const countFile=join(root,'count'),file=fixture('counted',`import fs from 'node:fs';fs.appendFileSync(${JSON.stringify(countFile)},'x');setTimeout(()=>console.log('ffuf'),150)`),run=createToolStartupChecks(()=>section(file));const [a,b]=await Promise.all([run(payload(file)),run(payload(file))]);assert.strictEqual(a,b);const fs=await import('node:fs');assert.equal(fs.readFileSync(countFile,'utf8'),'x');await run(payload(file));assert.equal(fs.readFileSync(countFile,'utf8'),'xx');});
 await test('startup checks leave no temporary child homes',()=>{assert.equal(readdirSync(tmpdir()).filter(x=>x.startsWith('saker-tool-startup-')).length,0);});
 await test('Desktop startup control handles RPC failures and hides a late result for an edited path',async()=>{
  const source=readFileSync(new URL('../plugins/dsh-sec-config/lib/client.js',import.meta.url),'utf8');
  const modified=source.replace("module.exports = { name: 'dsh-sec-config-client', inject: ['slots', 'connection'], apply: apply };",'module.exports = { ToolLibrary };');
  assert.notEqual(modified,source);let cursor=0,values=[],exports,result,settle;
  const calls=[],React={useState:initial=>{const i=cursor++;if(!(i in values))values[i]=initial;return [values[i],next=>{values[i]=typeof next==='function'?next(values[i]):next}]},useEffect:()=>{},createElement:(type,props,...children)=>({type,props:props??{},children})};
  runInNewContext(modified,{window:{__ModuleLoader__:{load:entry=>{exports=entry.factory(()=>React)}}},console,setTimeout,clearTimeout});
  const connection={rpc:{call:async(channel,endpoint,payload)=>{calls.push({channel,endpoint,payload});return new Promise(resolve=>{settle=resolve})}}};
  let cfg=section(good);const render=()=>{cursor=0;return exports.ToolLibrary({connection,value:cfg,onChange:()=>{throw Error('startup must not mutate configuration')}})};
  const nodes=x=>!x||typeof x!=='object'?[]:[x,...(x.children??[]).flat(Infinity).flatMap(nodes)];
  let view=render(),button=nodes(view).find(x=>x.type==='button'&&x.children.includes('检查启动'));assert(button);button.props.onClick();
  await Promise.resolve();assert.equal(calls.length,1);assert.equal(calls[0].endpoint,'tools/startup');assert.equal(calls[0].payload.expectedPath,good);
  settle({ok:true,value:{check:{state:'available',configuredPath:good,reason:'help returned'}}});for(let i=0;i<6;i++)await Promise.resolve();
  view=render();assert(JSON.stringify(view).includes('可启动'),'real RPC wrapper success was not displayed');
  nodes(view).find(x=>x.type==='button'&&x.children.includes('检查启动')).props.onClick();await Promise.resolve();
  cfg=section('edited-path');settle({ok:true,value:{check:{state:'available',configuredPath:good,reason:'old result'}}});for(let i=0;i<6;i++)await Promise.resolve();
  view=render();assert(!nodes(view).some(x=>x.props['aria-label']==='工具启动检查 ffuf'),'late old-path success remained visible');
  button=nodes(view).find(x=>x.type==='button'&&x.children.includes('检查启动'));button.props.onClick();await Promise.resolve();settle({ok:false,error:{message:'offline'}});await Promise.resolve();await Promise.resolve();await Promise.resolve();
  view=render();assert(JSON.stringify(view).includes('offline'));assert(!nodes(view).find(x=>x.type==='button'&&x.children.includes('检查启动')).props.disabled);
 });
}finally{rmSync(root,{recursive:true,force:true})}
process.exitCode=failed?1:0;
