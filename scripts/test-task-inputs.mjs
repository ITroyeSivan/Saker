import './test-home-isolation.mjs';
import assert from 'node:assert/strict';
import { apply } from '../plugins/dsh-redteam-results/lib/index.js';
import { taskStartInput, taskProgressInput } from '../plugins/dsh-redteam-results/lib/task-inputs.js';
const tools = new Map(), disposers = [];
apply({ tools: { register: tool => tools.set(tool.name, tool), guard: () => {} },
  effect: fn => { const cleanup = fn(); if (typeof cleanup === 'function') disposers.push(cleanup); },
  webServer: { register: () => () => {} } });
const task = tools.get('redteam_task');
const exec = id => ({ agent: { session: { id, header: { agentPreset: 'pentest', cwd: process.env.DSH_HOME } } } });
const fields = { action: 'start', mode: 'regular', question: 'Synthetic private document comparison', target: 'http://127.0.0.1:8081', toolCalls: 8, minutes: 5, workers: 0 };
let failed = 0;
async function test(label, fn) { try { await fn(); console.log('ok ' + label); } catch (error) { failed++; console.log('FAIL ' + label + ': ' + error.stack); } }
try {
  await test('registered task starts once from explicit fields without a policy JSON or mode/workflow guessing', async () => {
    const result = await task.execute(fields, exec('typed-task'));
    assert.equal(result.ok, true, result.error); assert.equal(result.configured, true);
    assert.equal(result.policy.mode, 'regular');assert.equal(result.policy.target,fields.target);
    assert.equal(result.policy.budget.toolCalls, 8);assert.equal(result.policy.workerLimit,0);assert.equal(result.policy.flow.kind,'single');
    const reset=await task.execute({...fields,toolCalls:1000},exec('typed-task'));
    assert.equal(reset.ok,false); assert.match(reset.error,/already started/);
    assert.equal((await task.execute({action:'status'},exec('typed-task'))).policy.budget.toolCalls,8);
  });
  await test('actual task completion preserves the note and explicit completion flag in the same call', async () => {
    const result=await task.execute({action:'progress',planComplete:true,progress:JSON.stringify({note:'Actual local comparisons captured'})},exec('typed-task'));
    assert.equal(result.ok,true,result.error);assert.equal(result.policy.planComplete,true);assert.equal(result.stopped,true);
    assert.equal(result.policy.note,'Actual local comparisons captured');
  });
  await test('conflicting progress representations fail without silently reopening or completing a task', async () => {
    const started=await task.execute(fields,exec('conflict-task'));assert(started.ok);
    const conflict=await task.execute({action:'progress',planComplete:true,progress:'{"planComplete":false,"note":"wrong"}'},exec('conflict-task'));
    assert.equal(conflict.ok,false);assert.match(conflict.error,/冲突/);
    assert.equal((await task.execute({action:'status'},exec('conflict-task'))).policy.planComplete,false);
    assert.throws(()=>taskProgressInput({planComplete:'true'}),/布尔/);
  });
  await test('legacy JSON starts and progress remain valid; mixed start representations are rejected', async () => {
    const policy={mode:'regular',target:fields.target,budget:{toolCalls:8,workers:0}};
    const legacy=await task.execute({action:'start',policy:JSON.stringify(policy)},exec('legacy-task'));assert.equal(legacy.ok,true,legacy.error);
    const done=await task.execute({action:'progress',progress:'{"planComplete":true,"note":"legacy"}'},exec('legacy-task'));assert(done.stopped);
    assert.throws(()=>taskStartInput({...fields,policy:JSON.stringify(policy)}),/不能混用/);
    assert.throws(()=>taskStartInput({policy:'[]'}),/JSON对象/);
  });
  await test('bad start exposes precise allowed fields and leaves no running task or widened scope', async () => {
    const invalid=await task.execute({...fields,mode:'pentest-regular'},exec('invalid-task'));
    assert.equal(invalid.ok,false);assert.match(invalid.recovery,/regular\/nday\/0day/);
    assert.match(task.output.render({},invalid)[0].text,/错误/);
    assert.equal((await task.execute({action:'status'},exec('invalid-task'))).configured,false);
    const badFlow=await task.execute({...fields,workflow:'pentest-regular'},exec('invalid-task'));assert.equal(badFlow.ok,false);
    assert.deepEqual(task.parameters.workflow.enum,['single','regular-to-nday','regular-with-nday']);
    assert.deepEqual(task.parameters.mode.enum,['regular','nday','0day']);
  });
  await test('finding format failure exposes the complete method contract in one tool response without accepting malformed evidence', async () => {
    const finding=tools.get('redteam_finding_register');
    const base={title:'Synthetic private read',target:fields.target,type:'broken-access-control',severity:'high',summary:'Synthetic own and excluded identities compared',fix:'Enforce object ACL'};
    for(const reproduction of ['1) owner read; 2) excluded read', JSON.stringify({mechanism:'object access'}), JSON.stringify({verification:{status:'unknown'}})]){
      const result=await finding.execute({...base,reproduction},exec('format-failure'));
      assert.equal(result.ok,false); assert.equal(result.id,'');
      for(const field of ['kind','mechanism','methodVersion','endpoint','successCriterion','reviewSteps','recovery','prerequisites','dependencies','parameters','steps','verification','status','evidenceIds'])assert(result.recovery?.includes(field),field+' recovery missing');
      assert.match(result.recovery,/不得补造/); assert.match(result.recovery,/停止登记重试/);
      assert.match(finding.output.render({},result)[0].text,/verification/);
    }
  });
} finally { for(const cleanup of disposers.reverse())await cleanup(); }
process.exitCode=failed?1:0;
