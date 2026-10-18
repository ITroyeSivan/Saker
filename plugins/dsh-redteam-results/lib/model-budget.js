// Persistent admission for one root task round, including owned children and
// auxiliary LLM streams. No prompts, credentials or model output are stored.
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeTaskPolicy } from './task-policy-record.js';
import { registerModelTransport, MODEL_TRANSPORT_SUPPORT } from './model-transport.js';
import { bindKnowledgeUsageForRequest, markKnowledgeUsageDispatched, markKnowledgeUsageSent, releaseKnowledgeUsageReservation } from './knowledge-usage.js';
export const MODEL_BUDGET_SCHEMA = `CREATE TABLE IF NOT EXISTS task_model_calls (
 id TEXT PRIMARY KEY, root_session TEXT NOT NULL, round_at INTEGER NOT NULL,
 session_id TEXT NOT NULL, state TEXT NOT NULL, record TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS task_model_calls_round ON task_model_calls(root_session,round_at);
 CREATE TABLE IF NOT EXISTS task_model_runtimes (id TEXT PRIMARY KEY, pid INTEGER NOT NULL);`;
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
export function modelBudgetOwner(store, sessionId) {
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
  for(const key of ['modelCalls','tokens'])if(owner.policy.budget[key]!==undefined && (!integer(owner.policy.budget[key])||owner.policy.budget[key]<1))throw new Error('model_budget_invalid_limits');
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
  writeTaskPolicy(store,owner.root,next,'model-budget-blocked',{code});
  return {ok:false,code,message};
}
function stopped(owner, now=Date.now()) {
  return [owner.policy,owner.sessionPolicy].some(p=>p.cancelled ||
    (p.budget.deadline !== null && p.budget.deadline !== undefined && now>=p.budget.deadline));
}
function stoppedResult() {
  // Child cancellation is local. It must not become a persistent root-wide
  // budget failure and disable siblings that are still allowed to run.
  return {ok:false,code:'task_stopped',message:'任务已取消或超过时间额度，未发出新的模型请求。'};
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
    // 预留只绑定“请求正文确实含 ref=<deliveryId>”的知识片段；不把预留当已发送。
    try { bindKnowledgeUsageForRequest(store, sessionId, row.id, options, row.at); } catch { /* 回填失败不影响本次调用 */ }
    return {ok:true,id:row.id};
  });
}
export function dispatchModelCall(store,id) {
  return transaction(store,()=>{const row=read(store,id);if(row.state!=='reserved')throw new Error('model_budget_call_not_reserved');
    const owner=modelBudgetOwner(store,row.sessionId);
    const veto=owner?.policy.modelBudgetBlock && !['model_calls_exhausted','tokens_exhausted'].includes(owner.policy.modelBudgetBlock.code);
    if(!owner || owner.root!==row.root || owner.round!==row.round || veto || stopped(owner)){
      save(store,{...row,state:'cancelled',settledAt:Date.now(),reason:'task stopped before dispatch'});
      try { releaseKnowledgeUsageReservation(store, row.id); } catch { /* 释放失败不掩盖停止原因 */ }
      return false;
    }
    save(store,{...row,state:'dispatched',dispatchedAt:Date.now()});
    try { markKnowledgeUsageDispatched(store, row.id, Date.now()); } catch { /* 状态转换失败不掩盖派发事实 */ }
    return true;});
}
export function cancelModelReservation(store,id) {
  return transaction(store,()=>{const row=read(store,id);if(row.state==='cancelled')return row;
    if(row.state!=='reserved')throw new Error('model_budget_dispatched_cost_cannot_be_released');
    const next={...row,state:'cancelled',settledAt:Date.now()};save(store,next);
    try { releaseKnowledgeUsageReservation(store, row.id); } catch { /* 释放失败不改变取消结果 */ }
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

export function registerModelAdmission(ctx,getStore,{countInput}={}) {
  const runtimeId=randomUUID();
  if(typeof ctx.on!=='function')return {runtimeId,available:false,dispose:async()=>{}};
  const initialStore=getStore();
  recoverDeadModelRuntimes(initialStore);
  initialStore.db.prepare('INSERT INTO task_model_runtimes(id,pid) VALUES(?,?)').run(runtimeId,process.pid);
  const active=new Map();
  const transport=registerModelTransport();
  const detach=ctx.on('llm/stream',(options,next)=>(async function*(){
    captureModelStream(options);
    if(!options.sessionId || !modelBudgetOwner(getStore(),String(options.sessionId))){yield*next();return;}
    const activeId=randomUUID();let done;
    const completion=new Promise(resolve=>{done=resolve;});
    active.set(activeId,{sessionId:String(options.sessionId),completion});
    try {
    const store=getStore();let counter;
    const owner=modelBudgetOwner(store,String(options.sessionId));
    if(stopped(owner)){
      yield {type:'finish',reason:{kind:'error',failure:{code:'TASK_MODEL_BUDGET',message:stoppedResult().message}}};return;
    }
    if(owner.policy.budget.tokens !== undefined && owner.policy.budget.tokens !== null && countInput){
      try {counter=await countInput(options);}catch{ /* admission reports unsupported/unavailable counting, without leaking an endpoint or secret */ }
    }
    if(options.signal?.aborted)return;
    const admitted=reserveModelCall(store,String(options.sessionId),options,{counter,runtimeId});
    if(!admitted.ok){yield {type:'finish',reason:{kind:'error',failure:{code:'TASK_MODEL_BUDGET',message:admitted.message}}};return;}
    if(admitted.unmanaged){yield*next();return;}
    let dispatched=false, usage, finish, currentId=admitted.id, currentDispatched=false, wireAttempts=0, successfulWires=0, currentResponseOk=false, wireDenial;
    try {
      if(options.signal?.aborted){cancelModelReservation(store,admitted.id);return;}
      if(!dispatchModelCall(store,admitted.id)){yield {type:'finish',reason:{kind:'error',failure:{code:'TASK_MODEL_BUDGET',message:'任务已停止，本次生成未发出。'}}};return;}
      dispatched=true;currentDispatched=true;
      const wireScope={dispatch:async(facts,send)=>{
        if(options.signal?.aborted)options.signal.throwIfAborted();
        if(facts.signal?.aborted)facts.signal.throwIfAborted();
        if(wireAttempts>0){
          // A provider-internal retry is a new paid attempt, even though the
          // outer llm/stream middleware was entered only once. Keep the prior
          // attempt unknown; a later success cannot erase its unresolved cost.
          settleModelCall(store,currentId,{reason:'provider started another wire attempt; prior usage unknown'});
          const retry=reserveModelCall(store,String(options.sessionId),options,{runtimeId,priorWireAttempts:wireAttempts});
          if(!retry.ok || retry.unmanaged){wireDenial=retry.unmanaged?stoppedResult():retry;throw Error(wireDenial.message);}
          currentId=retry.id;currentDispatched=false;currentResponseOk=false;
          if(!dispatchModelCall(store,currentId)){wireDenial=stoppedResult();throw Error(wireDenial.message);}
          currentDispatched=true;
        }
        const decision=authorizeModelWire(store,currentId,facts);
        if(!decision.ok){wireDenial=decision;throw Error(decision.message);}
        wireAttempts++;
        const wireId=currentId,response=await send();
        if(response.ok){
          successfulWires++;
          try { markKnowledgeUsageSent(store, wireId, Date.now()); } catch { /* 知识状态失败不改变发送结果 */ }
        }
        if(currentId===wireId)currentResponseOk=response.ok;return response;
      }};
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
    }finally{active.delete(activeId);done();}
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
