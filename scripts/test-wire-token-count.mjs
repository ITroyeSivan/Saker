// Mutate actual Desktop receipts: a captured `matches: true` must never be
// sufficient to qualify a corrupted count, request or independent settlement.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { auditWireRecords, validateWireCount } from './audit-wire-token-count.mjs';
const evidence=fileURLToPath(new URL('../docs/verification/wire-token-count-2026-10-09/',import.meta.url));
const captured=JSON.parse(readFileSync(join(evidence,'native-wire.json'),'utf8'));
const status=JSON.parse(readFileSync(join(evidence,'second-status.json'),'utf8'));
const body=index=>readFileSync(join(evidence,`wire-${index}.json`));
const passed=[];
function check(name,run){run();passed.push(name);console.log('PASS '+name);}
check('actual three-request Desktop capture reconciles',()=>{
  const result=auditWireRecords(captured,status,body);
  assert.equal(result.actualTotalTokens,56608);
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
