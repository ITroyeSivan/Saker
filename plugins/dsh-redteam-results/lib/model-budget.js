// Persistent admission for one root task round, including owned children and
// auxiliary LLM streams. No prompts, credentials or model output are stored.
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeTaskPolicy, childAllowedTools } from './task-policy-record.js';
import { registerModelTransport, MODEL_TRANSPORT_SUPPORT, filterProviderTools } from './model-transport.js';
export const MODEL_BUDGET_SCHEMA = `CREATE TABLE IF NOT EXISTS task_model_calls (
 id TEXT PRIMARY KEY, root_session TEXT NOT NULL, round_at INTEGER NOT NULL,
 session_id TEXT NOT NULL, state TEXT NOT NULL, record TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS task_model_calls_round ON task_model_calls(root_session,round_at);
 CREATE TABLE IF NOT EXISTS task_model_runtimes (id TEXT PRIMARY KEY, pid INTEGER NOT NULL);`;
export const MODEL_SERVICE_SCHEMA = `CREATE TABLE IF NOT EXISTS task_model_services (
 service_key TEXT PRIMARY KEY, concurrency INTEGER NOT NULL, updated_at TEXT NOT NULL);`;
const integer = value => Number.isSafeInteger(value) && value >= 0;
export function normalizedModelUsage(usage) {
  if (!usage || !['inputTokens','outputTokens'].every(key=>integer(usage[key]))) return null;
  if (['cacheReadTokens','cacheWriteTokens'].some(key=>usage[key] !== undefined && !integer(usage[key]))) return null;
  const total = usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  if (!integer(total) || (usage.totalTokens !== undefined && usage.totalTokens !== total)) return null;
  return { inputTokens:usage.inputTokens, outputTokens:usage.outputTokens, cacheReadTokens:usage.cacheReadTokens ?? 0,
    cacheWriteTokens:usage.cacheWriteTokens ?? 0, totalTokens:total };
}
export function modelRequestDigest(options) {
  const request = Object.fromEntries(['provider','model','reasoningEffort','maxTokens','messages','system','tools','toolHistory','temperature','stop','purpose']
    .filter(key=>options[key] !== undefined).map(key=>[key,options[key]]));
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}
function policy(store, id) {
  const row=store.db.prepare('SELECT record FROM task_policy WHERE session_id=?').get(id);
  return row ? JSON.parse(row.record) : null;
}
function competitionOwner(store, sessionId) {
  let root = String(sessionId || '')
  if (!root) return null
  for (let depth = 0; depth < 4; depth += 1) {
    let parent = ''
    try { parent = store.db.prepare('SELECT parent_session FROM site_workers WHERE child_id=?').get(root)?.parent_session || '' }
    catch { /* purpose-task ownership is checked below */ }
    if (!parent) {
      try {
        const child = store.db.prepare('SELECT parent_session,record FROM task_policy WHERE session_id=?').get(root)
        if (child?.parent_session) {
          const childRecord = JSON.parse(child.record || '{}')
          const parentRow = store.db.prepare('SELECT record FROM task_policy WHERE session_id=?').get(child.parent_session)
          const parentRecord = parentRow ? JSON.parse(parentRow.record || '{}') : null
          if (!childRecord.parentRound || !parentRecord?.startedAt || childRecord.parentRound === parentRecord.startedAt)
            parent = child.parent_session
        }
      } catch { /* malformed ownership cannot inherit a competition */ }
    }
    if (!parent || parent === root) break
    root = String(parent)
  }
  let row
  try { row = store.db.prepare('SELECT record FROM scene_contexts WHERE session_id=?').get(root) } catch { return null }
  if (!row) return null
  let scene
  try { scene = JSON.parse(row.record) } catch { return null }
  const preferences = scene?.preferences
  if (scene?.sceneId !== 'competition') return null
  const limits = preferences?.budget || {}
  const at = Date.parse(limits.roundStartedAt || scene.createdAt || preferences?.updatedAt || scene.updatedAt || '')
  if (!Number.isSafeInteger(at)) throw new Error('model_budget_owner_invalid')
  const minutes = Number(limits.minutes)
  const started = Date.parse(limits.startedAt || '')
  const deadline = Number.isFinite(minutes) && minutes > 0 && Number.isFinite(started)
    ? started + minutes * 60000 : null
  const ownerPolicy = {
    budget: { modelCalls: limits.modelCalls ?? null, tokens: limits.tokens ?? null, deadline },
    cancelled: scene.continuationReason === '用户切换场景前取消',
    continuationPaused: scene.continuationPaused === true,
    modelBudgetBlock: preferences?.modelBudgetBlock || null,
  }
  return { root, round: at, policy: ownerPolicy, sessionPolicy: ownerPolicy,
    competition: { scene, sceneId: root } }
}
export function modelBudgetOwner(store, sessionId) {
  const competition = competitionOwner(store, sessionId)
  if (competition) return competition
  const own=policy(store,sessionId); if(!own) return null;
  const root=own.parentSession || sessionId, current=own.parentSession ? policy(store,root) : own;
  if (!current || current.parentSession || !integer(current.startedAt)) throw new Error('model_budget_owner_invalid');
  if(own.parentSession){
    // 站点子代理必须在 site_workers 登记；按需复核/报告子任务不占站点工作位，
    // 用持久化的 purposeTask 标记证明归属，但仍核对轮次，避免跨轮沿用旧子会话。
    if(own.purposeTask !== true){
      const registered=store.db.prepare('SELECT parent_session FROM site_workers WHERE child_id=?').get(sessionId)?.parent_session;
      if(registered!==root) throw new Error('model_budget_stale_or_unowned_child');
    }
    if(own.parentRound!==current.startedAt) throw new Error('model_budget_stale_or_unowned_child');
  }
  return { root, round:current.startedAt, policy:current, sessionPolicy:own };
}
function transaction(store, body) {
  store.db.exec('BEGIN IMMEDIATE');
  try {const value=body();store.db.exec('COMMIT');return value;}
  catch(error){store.db.exec('ROLLBACK');throw error;}
}
function save(store, row) {
  store.db.prepare('INSERT INTO task_model_calls(id,root_session,round_at,session_id,state,record) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,record=excluded.record')
    .run(row.id,row.root,row.round,row.sessionId,row.state,JSON.stringify(row));
}

function captureModelStream(options) {
  const directory = process.env.SAKER_CAPTURE_REQUEST_DIR;
  if (!directory) return;
  try {
    const body = JSON.stringify(options);
    const digest = createHash('sha256').update(body).digest('hex').slice(0, 16);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `llm-stream-${Date.now()}-${digest}.json`), body);
  } catch { /* diagnostic capture must never block the request */ }
}
function read(store,id) {
  const row=store.db.prepare('SELECT record FROM task_model_calls WHERE id=?').get(id);
  if(!row)throw new Error('model_budget_call_missing');return JSON.parse(row.record);
}
function overview(store,owner) {
  for(const key of ['modelCalls','tokens']){
    const value=owner.policy.budget[key];
    if(value!==undefined && value!==null && (!integer(value)||value<1))throw new Error('model_budget_invalid_limits');
  }
  const rows=store.db.prepare('SELECT record FROM task_model_calls WHERE root_session=? AND round_at=? ORDER BY rowid').all(owner.root,owner.round).map(r=>JSON.parse(r.record));
  let knownTokens=0,heldTokens=0,unknownCalls=0,unresolvedCalls=0,chargedCalls=0,unboundedUnknownCalls=0;
  for(const row of rows){
    if(row.state==='cancelled')continue;
    if(!['reserved','dispatched','unknown','settled'].includes(row.state) || (row.reservedTokens!==null&&!integer(row.reservedTokens)))throw new Error('model_budget_corrupt_call');
    chargedCalls++;
    if(row.state==='settled'){
      const usage=normalizedModelUsage(row.usage);if(!usage)throw new Error('model_budget_corrupt_usage');knownTokens+=usage.totalTokens;
    }else { heldTokens+=row.reservedTokens ?? 0; if(row.reservedTokens===null)unboundedUnknownCalls++; if(row.state==='unknown')unknownCalls++; else unresolvedCalls++; }
  }
  if(!integer(knownTokens)||!integer(heldTokens)||!integer(knownTokens+heldTokens))throw new Error('model_budget_accounting_overflow');
  return {rootSession:owner.root,round:owner.round,limits:{modelCalls:owner.policy.budget.modelCalls ?? null,tokens:owner.policy.budget.tokens ?? null},
    chargedCalls,knownTokens,heldTokens,unknownCalls,unresolvedCalls,unboundedUnknownCalls,
    totalTokens:unknownCalls||unresolvedCalls ? null : knownTokens,
    // 被拒的生成没有发出：与“已发出但用量未知”分开显示，不能都算 unknown。
    blocked: owner.policy.modelBudgetBlock ? { code: owner.policy.modelBudgetBlock.code, message: owner.policy.modelBudgetBlock.message, at: owner.policy.modelBudgetBlock.at ?? null } : null,
    counterViolation:rows.some(r=>r.counterViolation===true),
    wireAttempts:rows.filter(row=>row.wire).length,
    unobservedCalls:rows.filter(row=>row.state!=='cancelled'&&!row.wire).length,
    transport:MODEL_TRANSPORT_SUPPORT,
    calls:rows.slice(-12).map(({id,sessionId,provider,model,purpose,state,usage,reservedTokens,at,settledAt,wire})=>({id,sessionId,provider,model,purpose,state,usage,reservedTokens,at,settledAt,wire}))};
}
export function modelBudgetOverview(store,sessionId) {
  const owner=modelBudgetOwner(store,sessionId);return owner ? overview(store,owner) : null;
}
function block(store, owner, code, message, details={}) {
  const next={...owner.policy,modelBudgetBlock:{code,message,at:Date.now(),...details}};
  if (owner.competition) {
    const scene = owner.competition.scene
    const record = { ...scene, preferences: { ...(scene.preferences || {}), modelBudgetBlock: next.modelBudgetBlock },
      updatedAt: new Date().toISOString() }
    store.db.prepare('UPDATE scene_contexts SET record=?,updated_at=? WHERE session_id=?')
      .run(JSON.stringify(record), record.updatedAt, owner.competition.sceneId)
    owner.policy.modelBudgetBlock = next.modelBudgetBlock
    return {ok:false,code,message};
  }
  writeTaskPolicy(store,owner.root,next,'model-budget-blocked',{code});
  return {ok:false,code,message};
}
function stopped(owner, now=Date.now()) {
  return [owner.policy,owner.sessionPolicy].some(p=>p.cancelled ||
    p.continuationPaused === true ||
    (p.budget.deadline !== null && p.budget.deadline !== undefined && now>=p.budget.deadline));
}
function stoppedResult() {
  // Child cancellation is local. It must not become a persistent root-wide
  // budget failure and disable siblings that are still allowed to run.
  return {ok:false,code:'task_stopped',message:'任务已取消或超过时间额度，未发出新的模型请求。'};
}
function privateHost(hostname) {
  const host=String(hostname||'').toLowerCase();
  if(host==='localhost'||host==='::1'||host==='[::1]'||/^127\./.test(host))return true;
  if(/^10\./.test(host)||/^192\.168\./.test(host)||/^169\.254\./.test(host))return true;
  const match=/^172\.(\d+)\./.exec(host);
  return !!match&&Number(match[1])>=16&&Number(match[1])<=31;
}
/** Use the host-resolved provider URL as the service identity. Names are user
 * aliases and cannot prove that two routes share one concurrency limit. */
export function localModelServiceKey(options={}) {
  for(const value of [options.baseURL,options.baseUrl,options.endpoint,options.providerEndpoint]){
    if(typeof value!=='string'||!value.trim())continue;
    try{const url=new URL(value);if(privateHost(url.hostname))return 'model-service:'+url.origin;}catch{/* not a URL */}
  }
  if(options.local===true)return 'model-service:provider:'+String(options.provider||'local');
  return null;
}
export function modelConcurrency(store,sessionId,serviceKey) {
  const environment=Number(process.env.SAKER_MODEL_CONCURRENCY);
  if(Number.isSafeInteger(environment)&&environment>0)return Math.min(16,environment);
  if(!serviceKey)return Number.POSITIVE_INFINITY;
  let configured=null;
  try{
    const root=competitionOwner(store,sessionId)?.root||String(sessionId||'');
    const row=store.db.prepare('SELECT record FROM scene_contexts WHERE session_id=?').get(root);
    const scene=row?JSON.parse(row.record):null;
    const value=Number(scene?.preferences?.modelConcurrency);
    if(Number.isSafeInteger(value)&&value>0)configured=Math.min(16,value);
  }catch{/* malformed local state falls back to the safe default */}
  const value=configured||1;
  const now=new Date().toISOString();
  try {
    store.db.prepare('INSERT INTO task_model_services(service_key,concurrency,updated_at) VALUES(?,?,?) '
      + 'ON CONFLICT(service_key) DO UPDATE SET concurrency=excluded.concurrency,updated_at=excluded.updated_at')
      .run(serviceKey,value,now);
  } catch { /* schema availability is checked by the store */ }
  return value;
}
export function createModelServiceGate() {
  const services=new Map();
  function stateFor(key){let state=services.get(key);if(!state){state={active:0,queue:[]};services.set(key,state);}return state;}
  function grant(key,item,state){
    item.granted=true;state.active++;
    if(item.signal&&item.abort)item.signal.removeEventListener?.('abort',item.abort);
    item.resolve({release:()=>release(key,state,item)});
  }
  function release(key,state,item){
    if(item.released)return;item.released=true;
    state.active=Math.max(0,state.active-1);
    while(state.queue.length){
      const next=state.queue.shift();
      if(next.cancelled)continue;
      grant(key,next,state);
      return;
    }
    if(!state.active&&!state.queue.length)services.delete(key);
  }
  function acquire(key,limit,signal){
    const state=stateFor(key);
    return new Promise((resolve,reject)=>{
      const item={resolve,reject,signal,cancelled:false,granted:false,released:false};
      if(signal?.aborted){item.cancelled=true;reject(signal.reason||Object.assign(new Error('model admission queued request cancelled'),{name:'AbortError'}));return;}
      if(state.active<limit){grant(key,item,state);return;}
      item.abort=()=>{
        if(item.granted||item.cancelled)return;item.cancelled=true;
        const index=state.queue.indexOf(item);if(index>=0)state.queue.splice(index,1);
        reject(signal.reason||Object.assign(new Error('model admission queued request cancelled'),{name:'AbortError'}));
        if(!state.active&&!state.queue.length)services.delete(key);
      };
      signal?.addEventListener?.('abort',item.abort,{once:true});
      state.queue.push(item);
    });
  }
  return {acquire,stats:()=>[...services].map(([key,value])=>({key,active:value.active,queued:value.queue.filter(item=>!item.cancelled).length}))};
}
export function reserveModelCall(store,sessionId,options,{counter,runtimeId='unknown-runtime',priorWireAttempts=0}={}) {
  return transaction(store,()=>{
    const owner=modelBudgetOwner(store,sessionId);if(!owner)return {ok:true,unmanaged:true};
    if(stopped(owner))return stoppedResult();
    const status=overview(store,owner), p=owner.policy;
    if(p.modelBudgetBlock)return {ok:false,...p.modelBudgetBlock};
    if(status.counterViolation)return block(store,owner,'counter_violation','实际用量超过预计数上界，停止该任务模型请求并核实计数路线。',{priorWireAttempts});
    if(status.limits.modelCalls !== null && status.chargedCalls>=status.limits.modelCalls)
      return block(store,owner,'model_calls_exhausted','主代理、子代理及辅助调用的共享模型调用额度已用完。',{priorWireAttempts});
    let reservedTokens=null;
    if(status.limits.tokens !== null){
      if(status.unboundedUnknownCalls)return block(store,owner,'usage_unknown','先前调用存在没有可靠上界的未结算用量，不能按零继续使用严格 token 额度。',{priorWireAttempts});
      // Certificate must cover this exact full adapter dispatch, including
      // protocol projection and any hidden attempts. An estimate is rejected.
      if(!counter || !['exact','upper-bound'].includes(counter.quality) || !integer(counter.maximumChargeTokens)
        || counter.maximumChargeTokens<1 || counter.requestDigest!==modelRequestDigest(options)
        || counter.provider!==options.provider || counter.model!==options.model
        || typeof counter.version!=='string' || !counter.version.trim() || counter.coversDispatch!==true)
        return block(store,owner,'token_count_unavailable','该模型路线没有匹配完整请求的可靠计数，严格 token 额度不能执行；本次生成未发出。',{priorWireAttempts});
      reservedTokens=counter.maximumChargeTokens;
      if(reservedTokens>status.limits.tokens-status.knownTokens-status.heldTokens)
        return block(store,owner,'tokens_exhausted','剩余共享 token 额度不足以容纳本次完整请求与输出上界；本次生成未发出。',{priorWireAttempts});
    }
    const row={id:randomUUID(),root:owner.root,round:owner.round,sessionId,state:'reserved',runtimeId,
      provider:options.provider,model:options.model,purpose:options.purpose || 'conversation',
      requestDigest:modelRequestDigest(options),reservedTokens,counter:reservedTokens===null?null:{quality:counter.quality,version:counter.version},at:Date.now()};
    save(store,row);
    return {ok:true,id:row.id};
  });
}
export function dispatchModelCall(store,id) {
  return transaction(store,()=>{const row=read(store,id);if(row.state!=='reserved')throw new Error('model_budget_call_not_reserved');
    const owner=modelBudgetOwner(store,row.sessionId);
    const veto=owner?.policy.modelBudgetBlock && !['model_calls_exhausted','tokens_exhausted'].includes(owner.policy.modelBudgetBlock.code);
    if(!owner || owner.root!==row.root || owner.round!==row.round || veto || stopped(owner)){
      save(store,{...row,state:'cancelled',settledAt:Date.now(),reason:'task stopped before dispatch'});
      return false;
    }
    save(store,{...row,state:'dispatched',dispatchedAt:Date.now()});
    return true;});
}
export function cancelModelReservation(store,id) {
  return transaction(store,()=>{const row=read(store,id);if(row.state==='cancelled')return row;
    if(row.state!=='reserved')throw new Error('model_budget_dispatched_cost_cannot_be_released');
    const next={...row,state:'cancelled',settledAt:Date.now()};save(store,next);
    return next;});
}

export function authorizeModelWire(store,id,facts){
  return transaction(store,()=>{
    const row=read(store,id),owner=modelBudgetOwner(store,row.sessionId);
    if(row.state!=='dispatched' || row.wire)throw Error('model_budget_wire_attempt_not_unique');
    if(!owner || owner.root!==row.root || owner.round!==row.round || stopped(owner))return stoppedResult();
    if(owner.policy.modelBudgetBlock && !['model_calls_exhausted','tokens_exhausted'].includes(owner.policy.modelBudgetBlock.code))
      return {ok:false,...owner.policy.modelBudgetBlock};
    if(facts.model!==row.model)return block(store,owner,'wire_model_mismatch','实际模型请求与已登记路线不一致，已停止发送。');
    const wire={sha256:createHash('sha256').update(facts.bytes).digest('hex'),bytes:facts.bytes.length,transport:'native-fetch',
      protocol:facts.protocol,maximumOutput:integer(facts.maximumOutput)&&facts.maximumOutput>0?facts.maximumOutput:null,at:Date.now()};
    save(store,{...row,wire});
    return {ok:true};
  });
}
export function settleModelCall(store,id,{usage,complete=false,reason='stream interrupted'}={}) {
  return transaction(store,()=>{const row=read(store,id);
    if(!['dispatched','unknown','settled'].includes(row.state))throw new Error('model_budget_call_not_dispatched');
    const normalized=complete ? normalizedModelUsage(usage) : null;
    if(row.state==='settled'){
      if(!normalized || JSON.stringify(normalized)!==JSON.stringify(row.usage))throw new Error('model_budget_conflicting_settlement');
      return row;
    }
    const next={...row,state:normalized?'settled':'unknown',usage:normalized,settledAt:Date.now(),
      ...(normalized?{}:{reason,observedUsage:normalizedModelUsage(usage)})};
    if(normalized && row.reservedTokens!==null && normalized.totalTokens>row.reservedTokens)next.counterViolation=true;
    save(store,next);return next;
  });
}
// Explicit recovery for a runtime confirmed stopped by its owner. A dispatch
// marker is never undone, and unresolved cost is never reset to zero.
export function recoverModelRuntime(store,runtimeId) {
  return transaction(store,()=>{
    const rows=store.db.prepare("SELECT record FROM task_model_calls WHERE state IN ('reserved','dispatched')").all().map(r=>JSON.parse(r.record)).filter(r=>r.runtimeId===runtimeId);
    for(const row of rows)save(store,{...row,state:row.state==='reserved'?'cancelled':'unknown',usage:null,settledAt:Date.now(),reason:'owner runtime stopped; dispatch outcome requires verification'});
    return rows.length;
  });
}

// PID absence is proof that the old owner cannot dispatch again. A live or
// reused PID, permission failure, and legacy records without an owner remain
// unresolved; neither an elapsed timeout nor a restart releases their cost.
export function recoverDeadModelRuntimes(store) {
  let recovered=0;
  for(const {id,pid} of store.db.prepare('SELECT id,pid FROM task_model_runtimes').all()){
    if(!Number.isSafeInteger(pid)||pid<1)continue;
    let absent=false;
    try{process.kill(pid,0);}catch(error){absent=error.code==='ESRCH';}
    if(!absent)continue;
    recovered+=recoverModelRuntime(store,id);
    store.db.prepare('DELETE FROM task_model_runtimes WHERE id=?').run(id);
  }
  return recovered;
}

export function registerModelAdmission(ctx,getStore,{countInput,providerBaseUrl}={}) {
  const runtimeId=randomUUID();
  if(typeof ctx.on!=='function')return {runtimeId,available:false,dispose:async()=>{}};
  const initialStore=getStore();
  recoverDeadModelRuntimes(initialStore);
  initialStore.db.prepare('INSERT INTO task_model_runtimes(id,pid) VALUES(?,?)').run(runtimeId,process.pid);
  const active=new Map();
  const serviceGate=createModelServiceGate();
  const transport=registerModelTransport();
  const detach=ctx.on('llm/stream',(options,next)=>(async function*(){
    captureModelStream(options);
    let lease;
    let resolvedBaseUrl='';
    try { resolvedBaseUrl=String(providerBaseUrl?.(options.provider)||''); } catch { /* route identity remains unavailable */ }
    const serviceKey=localModelServiceKey({...options,baseURL:resolvedBaseUrl||options.baseURL});
    if(serviceKey){
      try{
        lease=await serviceGate.acquire(serviceKey,modelConcurrency(getStore(),String(options.sessionId||''),serviceKey),options.signal);
      }catch(error){
        yield {type:'finish',reason:{kind:'error',failure:{code:'TASK_MODEL_QUEUE',message:error?.name==='AbortError'?'排队中的模型请求已取消，未发送到服务端。':String(error?.message||error)}}};
        return;
      }
    }
    const activeId=randomUUID();let done;
    const completion=new Promise(resolve=>{done=resolve;});
    const ownerSession=options.sessionId?String(options.sessionId):'';
    if(ownerSession)active.set(activeId,{sessionId:ownerSession,completion});
    try {
    const store=getStore();
    const owner=ownerSession?modelBudgetOwner(store,ownerSession):null;
    if(!owner){yield*next();return;}
    let counter;
    if(stopped(owner)){
      yield {type:'finish',reason:{kind:'error',failure:{code:'TASK_MODEL_BUDGET',message:stoppedResult().message}}};return;
    }
    if(owner.policy.budget.tokens !== undefined && owner.policy.budget.tokens !== null && countInput){
      try {counter=await countInput(options);}catch{ /* admission reports unsupported/unavailable counting, without leaking an endpoint or secret */ }
    }
    if(options.signal?.aborted)return;
    const admitted=reserveModelCall(store,ownerSession,options,{counter,runtimeId});
    if(!admitted.ok){yield {type:'finish',reason:{kind:'error',failure:{code:'TASK_MODEL_BUDGET',message:admitted.message}}};return;}
    if(admitted.unmanaged){yield*next();return;}
    let dispatched=false, usage, finish, currentId=admitted.id, currentDispatched=false, wireAttempts=0, successfulWires=0, currentResponseOk=false, wireDenial;
    try {
      if(options.signal?.aborted){cancelModelReservation(store,admitted.id);return;}
      if(!dispatchModelCall(store,admitted.id)){yield {type:'finish',reason:{kind:'error',failure:{code:'TASK_MODEL_BUDGET',message:'任务已停止，本次生成未发出。'}}};return;}
      dispatched=true;currentDispatched=true;
      const allowedTools=childAllowedTools(store,ownerSession);
      const wireScope={dispatch:async(facts,send)=>{
        if(options.signal?.aborted)options.signal.throwIfAborted();
        if(facts.signal?.aborted)facts.signal.throwIfAborted();
        if(wireAttempts>0){
          // A provider-internal retry is a new paid attempt, even though the
          // outer llm/stream middleware was entered only once. Keep the prior
          // attempt unknown; a later success cannot erase its unresolved cost.
          settleModelCall(store,currentId,{reason:'provider started another wire attempt; prior usage unknown'});
          const retry=reserveModelCall(store,ownerSession,options,{runtimeId,priorWireAttempts:wireAttempts});
          if(!retry.ok || retry.unmanaged){wireDenial=retry.unmanaged?stoppedResult():retry;throw Error(wireDenial.message);}
          currentId=retry.id;currentDispatched=false;currentResponseOk=false;
          if(!dispatchModelCall(store,currentId)){wireDenial=stoppedResult();throw Error(wireDenial.message);}
          currentDispatched=true;
        }
        const decision=authorizeModelWire(store,currentId,facts);
        if(!decision.ok){wireDenial=decision;throw Error(decision.message);}
        wireAttempts++;
        const wireId=currentId,response=await send();
        if(response.ok) successfulWires++;
        if(currentId===wireId)currentResponseOk=response.ok;return response;
      },filterTools:Array.isArray(allowedTools)?json=>filterProviderTools(json,allowedTools):undefined};
      for await(const chunk of transport.iterate(wireScope,next)){
        if(chunk.type==='usage')usage=chunk.usage;
        if(chunk.type==='finish')finish=chunk.reason;
        if(chunk.type==='finish' && wireDenial)yield {type:'finish',reason:{kind:'error',failure:{code:'TASK_MODEL_BUDGET',message:wireDenial.message}}};
        else yield chunk;
      }
    }catch(error){
      if(!dispatched)cancelModelReservation(store,admitted.id);
      if(wireDenial)yield {type:'finish',reason:{kind:'error',failure:{code:'TASK_MODEL_BUDGET',message:wireDenial.message}}};
      else throw error;
    }finally{
      if(dispatched && !currentDispatched)cancelModelReservation(store,currentId);
      if(dispatched && currentDispatched)settleModelCall(store,currentId,{usage,
        complete:!!finish&&!wireDenial&&(wireAttempts===0 || (successfulWires===1&&currentResponseOk))&&!['error','aborted'].includes(finish.kind)&&!options.signal?.aborted,
        reason:finish?.failure?.code || 'stream missing a successful terminal finish'});
    }
    }finally{active.delete(activeId);done();lease?.release();}
  })());
  return {runtimeId,available:true,dispose:async()=>{
    if(typeof detach==='function')detach();
    for(const {sessionId} of active.values())ctx.agents?.get?.(sessionId)?.cancel?.({kind:'hook',reason:'Saker model admission unloaded'});
    await Promise.all([...active.values()].map(row=>row.completion));
    transport.dispose();
    recoverModelRuntime(getStore(),runtimeId);
    getStore().db.prepare('DELETE FROM task_model_runtimes WHERE id=?').run(runtimeId);
  }};
}
