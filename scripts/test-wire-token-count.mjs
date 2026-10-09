// Synthetic receipts exercise independent reconciliation and corrupted inputs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { auditWireRecords, validateWireCount } from './audit-wire-token-count.mjs';
const rootSession='fixture-root';
const bodies=[1,2,3].map(index=>Buffer.from(JSON.stringify({model:'fixture-model',max_tokens:16,thinking:{type:'disabled'},system:'Synthetic instructions',tools:[],messages:[{role:'user',content:'Synthetic request '+index}]})));
const body=index=>bodies[index-1];
const records=bodies.map((bytes,i)=>({index:i+1,sessionId:rootSession,model:'fixture-model',maxTokens:16,thinking:'disabled',bodySha256:createHash('sha256').update(bytes).digest('hex'),bodyBytes:bytes.length,countStatus:200,generationStatus:200,countedInput:12+i,matches:true,actual:{input:9+i,cacheRead:3,cacheWrite:0,output:1,terminal:true}}));
const captured={records};
const status={task:{modelBudget:{rootSession,knownTokens:42,chargedCalls:3,unknownCalls:0,unresolvedCalls:0,unboundedUnknownCalls:0,counterViolation:false,calls:records.map((r,i)=>({id:'fixture-'+i,sessionId:rootSession,model:r.model,state:'settled',usage:{inputTokens:r.actual.input,outputTokens:1,cacheReadTokens:3,cacheWriteTokens:0,totalTokens:r.countedInput+1}}))}}};
const passed=[];
function check(name,run){run();passed.push(name);console.log('ok '+name);}
check('synthetic three-request capture reconciles',()=>{
  const result=auditWireRecords(captured,status,body);
  assert.equal(result.actualTotalTokens,42);
  assert.equal(result.calls.length,3);
  assert.equal(result.strictBudgetReady,false);
  for(const row of result.calls)assert.equal(Object.values(row.categories).reduce((a,b)=>a+b,0)+row.syntaxBytes,row.bodyBytes);
});
for(const [name,mutate,reason] of [
  ['count changed despite matches=true',row=>row.countedInput++,'preflight differs'],
  ['request digest replaced',row=>row.bodySha256='0'.repeat(64),'body identity'],
  ['wrong session',row=>row.sessionId='another-session','session mismatch'],
  ['unfinished stream',row=>row.actual.terminal=false,'incomplete count'],
  ['unknown input',row=>delete row.actual.input,'unknown or invalid usage'],
  ['output beyond declared cap',row=>row.actual.output=row.maxTokens+1,'output exceeds'],
])check(name,()=>{
  const row=structuredClone(captured.records[0]);row.matches=true;mutate(row);
  assert.throws(()=>validateWireCount(row,body(1),status.task.modelBudget.rootSession),new RegExp(reason));
});
for(const [name,mutate,reason] of [
  ['duplicate captured attempt',c=>c.records[1].index=1,'sequence'],
  ['empty capture',c=>c.records=[],'sequence'],
])check(name,()=>{
  const copy=structuredClone(captured);mutate(copy);
  assert.throws(()=>auditWireRecords(copy,status,body),new RegExp(reason));
});
for(const [name,mutate,reason] of [
  ['independent ledger total altered',l=>l.knownTokens++,'usage differs'],
  ['independent individual settlement altered',l=>l.calls[0].usage.totalTokens++,'settlements differ'],
  ['input and output altered with unchanged total',l=>{l.calls[0].usage.inputTokens--;l.calls[0].usage.outputTokens++;},'settlements differ'],
  ['unknown cost hidden by aggregate total',l=>l.unknownCalls=1,'ledger incomplete'],
  ['duplicate ledger call identity',l=>l.calls[1].id=l.calls[0].id,'identity'],
])check(name,()=>{
  const copy=structuredClone(status);mutate(copy.task.modelBudget);
  assert.throws(()=>auditWireRecords(captured,copy,body),new RegExp(reason));
});
console.log(JSON.stringify({passed:passed.length,reverseCases:passed.length-1,productionBudgetCertified:false}));
