// Observe generation fetches only inside an owned LLM iterator. Tool requests,
// discovery, counting and uploads retain their ordinary transport behavior.
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const key=Symbol.for('saker.model-transport.v1');
const generationPath=/\/(?:messages|chat\/completions|responses)\/?$/;
export const MODEL_TRANSPORT_SUPPORT=Object.freeze({
  mode:'native-fetch',
  protocols:['messages','chat-completions','responses'],
  redirects:'blocked',
  privateSdkAttempts:'not-observed',
});

function captureRequest(bytes, url, protocol) {
  const directory = process.env.SAKER_CAPTURE_REQUEST_DIR;
  if (!directory) return;
  try {
    mkdirSync(directory, { recursive: true });
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    writeFileSync(join(directory, `captured-${Date.now()}-${digest}.json`), bytes);
  } catch { /* capture is diagnostic-only and must never block the model request */ }
}

async function requestFacts(input,init){
  const request=input instanceof Request?input:undefined;
  const url=new URL(request?.url ?? String(input));
  if(!generationPath.test(url.pathname) || String(init?.method ?? request?.method ?? 'GET').toUpperCase()!=='POST')return null;
  let body=init?.body;
  if(body===undefined && request)body=await request.clone().arrayBuffer();
  let bytes;
  if(typeof body==='string')bytes=Buffer.from(body);
  else if(body instanceof ArrayBuffer)bytes=Buffer.from(body.slice(0));
  else if(ArrayBuffer.isView(body))bytes=Buffer.from(new Uint8Array(body.buffer,body.byteOffset,body.byteLength));
  else throw Error('Managed model generation requires an immutable JSON request body.');
  let json;try{json=JSON.parse(bytes.toString('utf8'));}catch{throw Error('Managed model generation requires a valid JSON request body.');}
  if(!json || typeof json.model!=='string' || !json.model || (!Array.isArray(json.messages)&&!('input' in json)))
    throw Error('Managed model generation request is missing its model or input.');
  const protocol=url.pathname.endsWith('/responses')?'responses':url.pathname.includes('/chat/completions')?'chat-completions':'messages';
  captureRequest(bytes, url, protocol);
  const maximumOutput=json.max_output_tokens ?? json.max_completion_tokens ?? json.max_tokens ?? null;
  // Dispatch exactly the bytes inspected above, including when an SDK supplied
  // a mutable buffer or Request. Reject redirects: fetch must not hide attempts.
  const send=(fetchImpl)=>request
    ? fetchImpl(new Request(request,{...init,body:bytes,redirect:'error'}))
    : fetchImpl(input,{...init,body:bytes,redirect:'error'});
  return {bytes,model:json.model,maximumOutput,protocol,signal:init?.signal ?? request?.signal,send};
}

export function registerModelTransport(){
  let shared=globalThis[key];
  if(!shared){
    shared={storage:new AsyncLocalStorage(),owners:0};globalThis[key]=shared;
  }
  if(shared.owners===0){
    const {storage}=shared,original=globalThis.fetch;
    if(typeof original!=='function')throw Error('Model transport requires native fetch.');
    shared.original=original;
    shared.wrapper=async(input,init)=>{
      const scope=storage.getStore();
      if(!scope)return original(input,init);
      const facts=await requestFacts(input,init);
      if(!facts)return original(input,init);
      // An SDK may retain an older fetch wrapper across plugin reloads. All
      // installations share this storage; forwarding does not enter it twice.
      return scope.dispatch(facts,()=>storage.run(undefined,()=>facts.send(original)));
    };
    globalThis.fetch=shared.wrapper;
  }
  shared.owners++;
  let disposed=false;
  return {
    async *iterate(scope,next){
      if(disposed)throw Error('Model transport registration disposed.');
      const iterator=shared.storage.run(scope,()=>next()[Symbol.asyncIterator]());
      let exhausted=false;
      try{while(true){const result=await shared.storage.run(scope,()=>iterator.next());
        if(result.done){exhausted=true;return;}yield result.value;}}
      finally{if(!exhausted && iterator.return)await shared.storage.run(scope,()=>iterator.return());}
    },
    dispose(){
      if(disposed)return;disposed=true;
      if(--shared.owners===0 && globalThis.fetch===shared.wrapper)globalThis.fetch=shared.original;
    },
  };
}
