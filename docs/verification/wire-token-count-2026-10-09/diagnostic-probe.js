import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const directory='E:/工作/WorkBuddy/WebSec/dsh/_ref/tmp/token-route-1009';
export const name='saker-token-route-probe';
export const inject=[];
export function apply(ctx){
  const original=globalThis.fetch;let sequence=0;const records=[];
  const wrapped=async function(input,init){
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    const headers=new Headers(init?.headers??(input instanceof Request?input.headers:undefined));
    let armed;try{armed=JSON.parse(readFileSync(directory+'/armed.json','utf8'));}catch{}
    if(url.origin!=='https://api.deepseek.com' || !url.pathname.endsWith('/messages') || headers.get('x-deepseek-harness-session-id')!==armed?.sessionId)
      return original(input,init);
    const body=init?.body;
    if(typeof body!=='string')throw Error('Diagnostic expected serialized body');
    const parsed=JSON.parse(body);const index=++sequence;
    // Only body bytes are captured; auth and other headers are never persisted.
    const credential=headers.get('x-api-key');
    if(credential && body.includes(credential))throw Error('Diagnostic body contains a credential; capture refused');
    writeFileSync(directory+`/wire-${index}.json`,body);
    const record={index,sessionId:armed.sessionId,purpose:headers.has('x-deepseek-harness-compact')?'compaction':'conversation',
      model:parsed.model,maxTokens:parsed.max_tokens,thinking:parsed.thinking?.type,
      bodyBytes:Buffer.byteLength(body),bodySha256:createHash('sha256').update(body).digest('hex'),
      tools:parsed.tools?.length??0,toolBytes:Buffer.byteLength(JSON.stringify(parsed.tools??[])),
      systemBytes:Buffer.byteLength(JSON.stringify(parsed.system??'')),messageBytes:Buffer.byteLength(JSON.stringify(parsed.messages)),
      messageRoles:parsed.messages.map(message=>message.role),fields:Object.keys(parsed).sort()};
    records.push(record);const save=()=>writeFileSync(directory+'/native-wire.json',JSON.stringify({at:new Date().toISOString(),records},null,2)+'\n');save();
    const countUrl=new URL(url);countUrl.pathname+='/count_tokens';
    const count=await original(countUrl,{method:'POST',headers,body,redirect:'error',signal:AbortSignal.timeout(20000)});
    let counted;try{counted=await count.json();}catch{}
    record.countStatus=count.status;record.countedInput=Number.isSafeInteger(counted?.input_tokens)?counted.input_tokens:null;save();
    const response=await original(input,init);record.generationStatus=response.status;save();
    // This temporary diagnostic buffers the tiny learning response. It is not
    // the production stream implementation or a performance measurement.
    const source=await response.clone().text();let usage={},terminal=false;
    for(const line of source.split(/\r?\n/))if(line.startsWith('data: ')){
      let chunk;try{chunk=JSON.parse(line.slice(6));}catch{continue;}
      if(chunk.type==='message_start')usage={...usage,...chunk.message?.usage};
      if(chunk.type==='message_delta')usage={...usage,...chunk.usage};
      if(chunk.type==='message_stop')terminal=true;
    }
    record.actual={input:usage.input_tokens,cacheRead:usage.cache_read_input_tokens??0,cacheWrite:usage.cache_creation_input_tokens??0,output:usage.output_tokens,terminal};
    record.actualInput=(usage.input_tokens??0)+(usage.cache_read_input_tokens??0)+(usage.cache_creation_input_tokens??0);
    record.matches=record.countedInput===record.actualInput;save();return response;
  };
  globalThis.fetch=wrapped;
  ctx.effect(()=>()=>{if(globalThis.fetch===wrapped)globalThis.fetch=original;});
  writeFileSync(directory+'/probe-activated.json',JSON.stringify({pid:process.pid,at:new Date().toISOString()})+'\n');
}
