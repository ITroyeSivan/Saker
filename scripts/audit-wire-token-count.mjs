// Validate captured provider requests against preflight counts and independent
// Desktop ledger usage. A consistency result is not a hard-budget certificate.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const integer=value=>Number.isSafeInteger(value)&&value>=0;
export function validateWireCount(record,bytes,sessionId){
  const fail=message=>{throw Error('Wire count validation: '+message);};
  if(record.sessionId!==sessionId)fail('session mismatch');
  if(createHash('sha256').update(bytes).digest('hex')!==record.bodySha256||bytes.length!==record.bodyBytes)fail('body identity mismatch');
  let body;try{body=JSON.parse(bytes.toString('utf8'));}catch{fail('invalid body');}
  if(body.model!==record.model||body.max_tokens!==record.maxTokens||body.thinking?.type!==record.thinking)fail('route or generation settings mismatch');
  if(!integer(body.max_tokens)||body.max_tokens<1||!Array.isArray(body.messages))fail('missing bounded output or messages');
  if(record.countStatus!==200||record.generationStatus!==200||record.actual?.terminal!==true)fail('incomplete count or generation');
  const usage=record.actual;
  if(![record.countedInput,usage.input,usage.cacheRead,usage.cacheWrite,usage.output].every(integer))fail('unknown or invalid usage');
  const input=usage.input+usage.cacheRead+usage.cacheWrite;
  if(!integer(input)||!integer(input+usage.output)||input!==record.countedInput)fail('preflight differs from actual input');
  if(usage.output>body.max_tokens)fail('actual output exceeds serialized output cap');
  // Sum byte partitions of the actual JSON members, including key names and
  // punctuation. Remaining syntax/whitespace stays separately attributed.
  const categories={tools:0,system:0,messages:0,other:0};
  for(const [key,value] of Object.entries(body)){
    const category=['tools','system','messages'].includes(key)?key:'other';
    categories[category]+=Buffer.byteLength(JSON.stringify(key)+':'+JSON.stringify(value));
  }
  const syntaxBytes=bytes.length-Object.values(categories).reduce((a,b)=>a+b,0);
  if(syntaxBytes<0)fail('byte partitions exceed captured body');
  return {index:record.index,sessionId,model:body.model,bodySha256:record.bodySha256,bodyBytes:bytes.length,
    tools:body.tools?.length??0,fields:Object.keys(body).sort(),categories,syntaxBytes,
    countedInput:input,actualOutput:usage.output,actualTotal:input+usage.output,
    maximumOutput:body.max_tokens,countPlusOutputCap:input+body.max_tokens};
}
export function auditWireRecords(captured,status,bodyForIndex){
  const ledger=status.task?.modelBudget;
  if(!ledger||ledger.unknownCalls!==0||ledger.unresolvedCalls!==0||ledger.unboundedUnknownCalls!==0
    ||ledger.counterViolation||!integer(ledger.knownTokens)||!integer(ledger.chargedCalls)
    ||typeof ledger.rootSession!=='string'||!ledger.rootSession)throw Error('Independent Desktop ledger incomplete');
  if(!Array.isArray(captured.records)||!captured.records.length
    ||captured.records.some((record,index)=>record.index!==index+1))throw Error('Capture sequence missing or duplicated');
  const calls=captured.records.map(record=>validateWireCount(record,bodyForIndex(record.index),ledger.rootSession));
  if(calls.length!==ledger.chargedCalls||calls.reduce((sum,row)=>sum+row.actualTotal,0)!==ledger.knownTokens)
    throw Error('Wire usage differs from independent Desktop ledger');
  if(!Array.isArray(ledger.calls)||new Set(ledger.calls.map(call=>call.id)).size!==ledger.calls.length)
    throw Error('Independent Desktop call identity missing or duplicated');
  const settled=ledger.calls.filter(call=>call.state==='settled');
  if(settled.length!==calls.length||settled.some((call,index)=>{
    const usage=call.usage, observed=captured.records[index].actual;
    return !usage||call.sessionId!==ledger.rootSession||call.model!==calls[index].model
      ||usage.inputTokens!==observed.input||usage.outputTokens!==observed.output
      ||usage.cacheReadTokens!==observed.cacheRead||usage.cacheWriteTokens!==observed.cacheWrite
      ||usage.totalTokens!==calls[index].actualTotal;
  }))
    throw Error('Individual Desktop settlements differ from transport observations');
  return {at:new Date().toISOString(),consistencyPassed:true,strictBudgetReady:false,sessionId:ledger.rootSession,calls,
    actualTotalTokens:ledger.knownTokens,
    qualifications:['Observed API-key text route only; no images/files, account route or injected retry yet.',
      'Provider count endpoint is available in this observation; a published exact/upper-bound contract has not been established.',
      'The diagnostic buffered small responses and added count calls; timings are not performance evidence.',
      'Default 256000 output cap prevents admitting these requests under a 150000 full-request reservation.']};
}
export function auditWireDirectory(directory){
  const captured=JSON.parse(readFileSync(join(directory,'native-wire.json'),'utf8'));
  const status=JSON.parse(readFileSync(join(directory,'second-status.json'),'utf8'));
  return auditWireRecords(captured,status,index=>readFileSync(join(directory,`wire-${index}.json`)));
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(!process.argv[2]||!process.argv[3])throw Error('Usage: audit-wire-token-count.mjs capture-directory output-report.json');
  const report=auditWireDirectory(resolve(process.argv[2]));writeFileSync(resolve(process.argv[3]),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({consistencyPassed:report.consistencyPassed,calls:report.calls.length,actualTotalTokens:report.actualTotalTokens,strictBudgetReady:false}));
}
